// ─────────────────────────────────────────────────────────────────────────────
// src/ingestion/server.js — Module 1 (Ingestion). The TCP endpoint a Teltonika
// device connects to. Speaks the real protocol: IMEI handshake, length-framed
// Codec 8/8E packets, CRC validation, and — the whole point — it ACKs a packet
// ONLY after its records are durably written (invariant 1). Idempotency is
// handled by the store (invariant 2), so a device re-sending after a missed ACK
// never double-counts.
//
// TCP is a byte stream, so this buffers and reframes: a packet may arrive in
// pieces, or several may arrive at once. A `pending` flag makes the async pump
// re-run if more bytes land mid-processing, preserving order without reentrancy.
//
// Operability (P0): every log line is structured (see src/logging/logger.js) and
// `drain()` implements a graceful stop — stop accepting, let in-flight packets
// finish their write+ACK, then close sockets. That ordering is what keeps
// invariant 1 true across a restart or an NLB target drain: we never ACK a
// packet we then abandon, and we never die between commit and ACK.
// ─────────────────────────────────────────────────────────────────────────────

import net from 'node:net';
import { readImeiFrame, readAvlFrame, encodeAck, isValidImei } from '../protocol/codec.js';
import { createHandshakeLimiter } from './handshake-limiter.js';
import { normalizeRecord } from '../decode/normalize.js';
import { silentLogger } from '../logging/logger.js';
import { isEntrypoint } from '../lifecycle/shutdown.js';

const ACCEPT = Buffer.from([0x01]);
const REJECT = Buffer.from([0x00]);

// F6 defaults. A short deadline to send the IMEI frame; a generous idle window
// once handshaked (well above a lifelike reporting interval). Overridable via
// config.ingest (INGEST_HANDSHAKE_TIMEOUT_MS / INGEST_IDLE_TIMEOUT_MS); 0 for
// either disables that timer.
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export function createIngestionServer({
  store,
  host = '0.0.0.0',
  port = 5027,
  logger = silentLogger,
  // Per-source-IP throttle on failed (unknown-IMEI) handshakes — P0 hardening
  // (see handshake-limiter.js for why this exists). `rateLimit` tunes the
  // defaults (maxFailures/windowMs/blockMs); pass `handshakeLimiter` directly
  // instead when a caller needs to inject its own (tests do, with a fake
  // clock). Declared before handshakeLimiter in this pattern on purpose — its
  // default expression reads `rateLimit`, and destructuring defaults can only
  // see earlier-bound names in the same parameter list.
  rateLimit = {},
  handshakeLimiter = createHandshakeLimiter(rateLimit),
  // F6: bound a silent/slow client. `handshakeTimeoutMs` is the deadline to
  // send the IMEI frame; after a successful handshake the socket relaxes to
  // `idleTimeoutMs` between packets. Either firing destroys the socket (the
  // device reconnects). `maxConnections` (0 = unlimited) optionally caps
  // concurrent sockets at the listener.
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxConnections = 0,
  // F1: upper bound on a declared AVL data-field length. Left undefined here so
  // the parser's own DEFAULT_MAX_PACKET_BYTES applies unless a caller (the
  // entrypoint, from config) passes the configured value.
  maxPacketBytes,
} = {}) {
  // Live sockets, so a graceful stop can close them AFTER in-flight work drains.
  const sockets = new Set();
  // In-flight packet handling (write + ACK). Draining waits on these.
  const inFlight = new Set();
  let draining = false;

  const server = net.createServer((socket) => {
    const conn = {
      buf: Buffer.alloc(0),
      handshaked: false,
      device: null,
      imei: null,
      processing: false,
      pending: false,
    };
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;

    // A connection that arrives mid-drain is refused immediately rather than
    // half-served: the device reconnects to another instance and retries.
    if (draining) {
      logger.warn?.('connection_refused_draining', { peer });
      socket.destroy();
      return;
    }

    // A source IP that has already burned through its failed-handshake
    // allowance is refused before it gets to try another IMEI. This is
    // checked per-connection (not per-packet) because the whole point is to
    // deny the connection itself, not just the handshake inside it.
    if (handshakeLimiter.isBlocked(socket.remoteAddress)) {
      logger.warn?.('connection_refused_rate_limited', { peer });
      socket.destroy();
      return;
    }

    socket.on('data', (chunk) => {
      conn.buf = Buffer.concat([conn.buf, chunk]);
      pump();
    });
    socket.on('error', (e) => logger.warn?.('socket_error', { peer, error: e.message }));

    // F6: bound how long a socket may sit idle. socket.setTimeout fires
    // 'timeout' after N ms with no activity (Node resets the timer on any
    // socket activity), so one mechanism covers both a client that connects and
    // never sends the IMEI and one that handshakes then goes quiet. Node does
    // NOT close the socket itself on 'timeout' — we destroy it, and the device
    // reconnects. The initial (short) window is the handshake deadline; it is
    // widened to the idle window once the handshake succeeds (below).
    if (handshakeTimeoutMs > 0) socket.setTimeout(handshakeTimeoutMs);
    socket.on('timeout', () => {
      logger.warn?.(conn.handshaked ? 'idle_timeout' : 'handshake_timeout', {
        peer,
        imei: conn.imei,
      });
      socket.destroy();
    });

    async function pump() {
      if (conn.processing) {
        conn.pending = true; // more data arrived mid-flight; re-run when done
        return;
      }
      conn.processing = true;
      try {
        do {
          conn.pending = false;
          await processAvailable();
        } while (conn.pending);
      } catch (err) {
        logger.warn?.('connection_dropped', { peer, imei: conn.imei, error: err.message });
        socket.destroy();
      } finally {
        conn.processing = false;
      }
    }

    async function processAvailable() {
      // 1) Handshake: [2-byte len][IMEI ascii] -> 0x01 accept / 0x00 reject.
      if (!conn.handshaked) {
        const hs = readImeiFrame(conn.buf);
        if (!hs) return; // wait for the full IMEI frame
        conn.buf = conn.buf.subarray(hs.bytesConsumed);

        // Reject + rate-limit path shared by a malformed IMEI (fails the
        // 15-digit format check, F4) and a well-formed but unregistered one.
        // Both are "not a device we serve", and both count toward the per-IP
        // failed-handshake budget so a scanner can't probe the port for free.
        const reject = (reason) => {
          const limit = handshakeLimiter.recordFailure(socket.remoteAddress, hs.imei);
          logger.warn?.('handshake_rejected', {
            peer,
            imei: hs.imei,
            reason,
            failures: limit.failures,
          });
          if (limit.justBlocked) {
            logger.warn?.('peer_blocked', { peer, ip: socket.remoteAddress, blockedUntil: limit.blockedUntil });
          }
          socket.end(REJECT);
        };

        // F4: refuse anything that isn't 15 ASCII digits before it ever reaches
        // the registry lookup — keeps junk out of the store lookup and the logs.
        if (!isValidImei(hs.imei)) {
          reject('malformed_imei');
          return;
        }
        const device = await store.deviceByImei(hs.imei);
        if (!device) {
          reject('unknown_imei');
          return;
        }
        conn.device = device;
        conn.imei = hs.imei;
        conn.handshaked = true;
        handshakeLimiter.recordSuccess(socket.remoteAddress);
        socket.write(ACCEPT);
        logger.info?.('handshake_accepted', { peer, imei: hs.imei, model: device.model });
        // F6: relax the timeout to the (longer) idle window now that the device
        // is a known talker. 0 disables it.
        socket.setTimeout(idleTimeoutMs > 0 ? idleTimeoutMs : 0);
      }

      // 2) Drain every complete AVL packet currently buffered.
      for (;;) {
        // throws on bad preamble / CRC / over-large length (F1) / unknown codec (F2)
        const frame = readAvlFrame(conn.buf, { maxPacketBytes });
        if (!frame) return; // need more bytes
        const raw = Buffer.from(conn.buf.subarray(0, frame.bytesConsumed));
        conn.buf = conn.buf.subarray(frame.bytesConsumed);
        // Track this packet so a graceful stop cannot cut between the durable
        // write and the ACK (invariant 1).
        const task = handlePacket(frame.packet, raw);
        inFlight.add(task);
        try {
          await task;
        } finally {
          inFlight.delete(task);
        }
      }
    }

    async function handlePacket(packet, raw) {
      const { codecId, records } = packet;

      // Attribute each record at ITS OWN timestamp (invariant 6), then normalise.
      const canonical = [];
      for (const rec of records) {
        const assignment = await store.resolveAssignment(conn.device.id, rec.timestampMs);
        canonical.push(normalizeRecord(rec, { device: conn.device, assignment }));
      }

      // Durable, atomic, idempotent write. If this throws, we do NOT ACK — the
      // device keeps its buffer and resends (caught by pump()).
      const res = await store.persistPacket({
        device: conn.device,
        imei: conn.imei,
        codecId,
        rawFrame: raw,
        canonical,
      });

      // Only now — after the write committed — acknowledge (invariant 1).
      socket.write(encodeAck(res.records));
      logger.info?.('packet_acked', {
        imei: conn.imei,
        codec: codecId === 0x8e ? '8E' : '8',
        records: res.records,
        inserted: res.inserted,
        deduped: res.deduped,
      });
    }
  });

  // F6: optional hard cap on concurrent sockets at the listener. Node refuses
  // (and destroys) connections past this WITHOUT invoking the handler above.
  // 0 = unlimited — the per-socket timeouts still bound a stuck socket's life.
  // NOTE: `maxConnections` is an UNDOCUMENTED Node API — it works on every
  // release this build targets (18/20/22/24) but is not in the public docs and
  // could change without a deprecation cycle. If it ever disappears, enforce
  // the cap in the connection handler (next to the draining/limiter guards),
  // where the socket count is already tracked in `sockets`.
  if (maxConnections > 0) server.maxConnections = maxConnections;

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const p = server.address().port;
          logger.info?.('listening', { module: 'ingestion', host, port: p, store: store.kind });
          resolve(p);
        });
      });
    },
    // Abrupt close — kept for tests that just want the port back.
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    /**
     * Graceful stop, in the only order that preserves invariant 1:
     *   1. stop accepting new connections,
     *   2. let every in-flight packet finish its write AND its ACK,
     *   3. end the remaining sockets (FIN, not RST — the device reconnects),
     *   4. resolve once the listener is really down. The caller closes the store.
     *
     * Note on step 1: `server.close(cb)` stops accepting IMMEDIATELY, but its
     * callback only fires once every existing connection has closed. Awaiting it
     * here would deadlock — a device connection is open exactly when a drain
     * matters. So we start the close, do the draining, and await the callback
     * last, with a bounded grace period before any straggler is destroyed.
     */
    async drain({ socketGraceMs = 2000 } = {}) {
      draining = true;
      const closed = new Promise((resolve) => server.close(() => resolve()));

      // In-flight tasks can enqueue further packets from the same buffer, so
      // loop until the set is genuinely empty.
      while (inFlight.size) {
        await Promise.allSettled([...inFlight]);
      }

      // FIN every socket: a real unit treats this as a normal disconnect and
      // reconnects (to another instance, behind an NLB).
      for (const s of sockets) s.end();

      // Bound the wait: a peer that never answers the FIN must not wedge the
      // restart. The timer is cleared either way — an unref'd timer here lets
      // the event loop empty with the drain still pending, which strands the
      // caller's promise (seen on Node 18).
      let stragglers = 0;
      let graceTimer;
      await Promise.race([
        closed,
        new Promise((resolve) => {
          graceTimer = setTimeout(() => {
            stragglers = sockets.size;
            for (const s of sockets) s.destroy();
            resolve();
          }, socketGraceMs);
        }),
      ]);
      clearTimeout(graceTimer);
      await closed;

      if (stragglers) logger.warn?.('drain_forced_sockets', { module: 'ingestion', stragglers });
      logger.info?.('drained', { module: 'ingestion' });
    },
    inFlightCount() {
      return inFlight.size;
    },
    address() {
      return server.address();
    },
    // Exposed for tests and any future ops/introspection surface — not part
    // of the wire protocol.
    handshakeLimiter,
  };
}

// Allow running the server directly: `npm run start:ingest`.
// isEntrypoint() rather than the usual `import.meta.url === file://argv[1]`
// idiom — that comparison is false on Windows and the server would exit 0
// without ever listening. See src/lifecycle/shutdown.js.
if (isEntrypoint(import.meta.url)) {
  const { config } = await import('../config.js');
  const { makeStore } = await import('../store/index.js');
  const { createLogger } = await import('../logging/logger.js');
  const { installShutdown } = await import('../lifecycle/shutdown.js');

  const logger = createLogger({
    module: 'ingestion',
    level: config.log.level,
    format: config.log.format,
  });

  const store = await makeStore();
  await store.init();
  const ing = createIngestionServer({
    store,
    host: config.ingest.host,
    port: config.ingest.port,
    logger,
    rateLimit: config.ingest.handshakeRateLimit,
    handshakeTimeoutMs: config.ingest.handshakeTimeoutMs,
    idleTimeoutMs: config.ingest.idleTimeoutMs,
    maxConnections: config.ingest.maxConnections,
    maxPacketBytes: config.ingest.maxPacketBytes,
  });
  await ing.listen();

  installShutdown({
    name: 'ingestion',
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    async stop() {
      await ing.drain();
      await store.close();
    },
  });
}
