// ─────────────────────────────────────────────────────────────────────────────
// test/ingestion-hardening.test.js — the ingestion server's DEFENSIVE envelope,
// proved over a REAL TCP socket (the same way ingestion.test.js proves the
// protocol and ingestion-rate-limit.test.js proves the throttle).
//
//   F6  a silent socket that never sends the IMEI is closed by the handshake
//       timeout; a socket that handshakes then goes quiet is closed by the idle
//       timeout; an optional maxConnections cap refuses a connection past it.
//   F4  a malformed (non-15-digit) IMEI is rejected over the wire AND counts
//       toward the per-source failed-handshake budget, exactly like an unknown
//       one — junk shouldn't buy free guesses.
//
// Timeouts are injected short (tens of ms) so the suite stays fast; the real
// defaults (config.ingest) are 10 s / 10 min.
//   run: node --test test/ingestion-hardening.test.js
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMemoryStore } from '../src/store/memory-store.js';
import { createIngestionServer } from '../src/ingestion/server.js';
import { createHandshakeLimiter } from '../src/ingestion/handshake-limiter.js';
import { encodeImei } from '../src/protocol/codec.js';
import { DEVICES } from '../src/store/seed-data.js';

const quiet = { info() {}, warn() {}, error() {} };

// Connect, optionally send `send`, then resolve true if the SERVER closes the
// socket within giveUpMs, false if it is still open when we give up (we tear it
// down ourselves in that case). `onData` observes reply bytes.
function connectAndWatch(port, { send, giveUpMs = 1500, onData } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (closedByServer) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(closedByServer);
    };
    socket.on('connect', () => {
      if (send) socket.write(send);
    });
    socket.on('data', (d) => onData?.(d));
    socket.on('close', () => finish(true));
    socket.on('error', () => {}); // a reset socket also emits error; close follows
    setTimeout(() => finish(false), giveUpMs);
  });
}

// A single raw handshake attempt: returns the bytes that came back (or an empty
// buffer if the socket closed with nothing). Mirrors ingestion-rate-limit's helper.
function attemptHandshake(port, imei) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let resolved = false;
    const finish = (buf) => {
      if (resolved) return;
      resolved = true;
      resolve(buf);
      socket.destroy();
    };
    socket.on('connect', () => socket.write(encodeImei(imei)));
    socket.on('data', (d) => finish(d));
    socket.on('close', () => finish(Buffer.alloc(0)));
    socket.on('error', () => {});
  });
}

test('F6: a silent socket that never sends the IMEI is closed by the handshake timeout', async () => {
  const store = createMemoryStore();
  await store.init();
  const server = createIngestionServer({
    store,
    host: '127.0.0.1',
    port: 0,
    logger: quiet,
    handshakeTimeoutMs: 80, // short deadline for the test
    idleTimeoutMs: 10_000,
  });
  const port = await server.listen();

  // Connect and send nothing. Before F6 the server held this open forever.
  const closedByServer = await connectAndWatch(port, { send: null, giveUpMs: 1500 });
  assert.equal(closedByServer, true, 'server should time out and close the silent pre-handshake socket');

  await server.close();
});

test('F6: a socket that handshakes then goes idle is closed by the idle timeout', async () => {
  const store = createMemoryStore();
  await store.init();
  const server = createIngestionServer({
    store,
    host: '127.0.0.1',
    port: 0,
    logger: quiet,
    handshakeTimeoutMs: 10_000, // won't fire — we DO handshake promptly
    idleTimeoutMs: 80, // but then we go quiet
  });
  const port = await server.listen();

  let firstReply = null;
  const closedByServer = await connectAndWatch(port, {
    send: encodeImei(DEVICES[0].imei),
    giveUpMs: 1500,
    onData: (d) => {
      if (firstReply === null) firstReply = d;
    },
  });

  assert.deepEqual(firstReply, Buffer.from([0x01]), 'the handshake should be accepted first');
  assert.equal(closedByServer, true, 'server should close the socket once it goes idle post-handshake');

  await server.close();
});

test('F6: maxConnections refuses a connection beyond the cap', async () => {
  const store = createMemoryStore();
  await store.init();
  const server = createIngestionServer({
    store,
    host: '127.0.0.1',
    port: 0,
    logger: quiet,
    handshakeTimeoutMs: 10_000,
    idleTimeoutMs: 10_000,
    maxConnections: 1,
  });
  const port = await server.listen();

  // Connection A: handshake and HOLD it open, occupying the single slot.
  const a = net.connect({ host: '127.0.0.1', port });
  const aReply = await new Promise((resolve) => {
    a.on('connect', () => a.write(encodeImei(DEVICES[0].imei)));
    a.on('data', (d) => resolve(d));
    a.on('error', () => {});
  });
  assert.deepEqual(aReply, Buffer.from([0x01]), 'A should be accepted and occupy the slot');

  // Connection B: over the cap. Node refuses it — the client sees a close with
  // no application bytes, never a handshake reply.
  let bGotBytes = false;
  const bClosed = await connectAndWatch(port, {
    send: encodeImei(DEVICES[0].imei),
    giveUpMs: 1500,
    onData: () => {
      bGotBytes = true;
    },
  });
  assert.equal(bGotBytes, false, 'B should never be served an application reply');
  assert.equal(bClosed, true, 'B should be refused/closed because the connection cap is reached');

  a.destroy();
  await server.close();
});

test('F4: a malformed (non-15-digit) IMEI is rejected over the wire and DIFFERENT malformed attempts count toward the limiter', async () => {
  const store = createMemoryStore();
  await store.init();
  const handshakeLimiter = createHandshakeLimiter({ maxFailures: 2, windowMs: 60_000, blockMs: 60_000 });
  const server = createIngestionServer({
    store,
    host: '127.0.0.1',
    port: 0,
    logger: quiet,
    handshakeLimiter,
  });
  const port = await server.listen();

  // 15 letters: a well-formed FRAME carrying an invalid IMEI. It gets the same
  // ordinary 0x00 reject byte an unknown IMEI would — but it must also count.
  // Two DISTINCT malformed strings, matching the CGNAT-safe counting rule
  // (src/ingestion/handshake-limiter.js): strikes are per distinct IMEI value,
  // so this proves the block still triggers on genuinely varying attempts.
  assert.deepEqual(
    await attemptHandshake(port, 'ABCDEFGHIJKLMNO'),
    Buffer.from([0x00]),
    'a malformed IMEI gets the ordinary reject byte',
  );
  assert.deepEqual(
    await attemptHandshake(port, 'ZZZZZZZZZZZZZZZ'),
    Buffer.from([0x00]),
    'second, DIFFERENT malformed attempt — now at the failure threshold',
  );
  assert.equal(
    handshakeLimiter.isBlocked('127.0.0.1'),
    true,
    'malformed handshakes must count toward the per-source block, like unknown ones',
  );

  await server.close();
});

test('F4: CGNAT fix — repeating the SAME malformed IMEI does not block the source', async () => {
  const store = createMemoryStore();
  await store.init();
  const handshakeLimiter = createHandshakeLimiter({ maxFailures: 2, windowMs: 60_000, blockMs: 60_000 });
  const server = createIngestionServer({
    store,
    host: '127.0.0.1',
    port: 0,
    logger: quiet,
    handshakeLimiter,
  });
  const port = await server.listen();

  // A device that is consistently misconfigured sends the SAME malformed
  // value every time — that is one flaky device, not a scan, and must not by
  // itself exhaust a source IP that may be shared with other real devices
  // (CGNAT). See handshake-limiter.js and test/ingestion-rate-limit.test.js
  // for the same fix proven against unknown (well-formed) IMEIs.
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(
      await attemptHandshake(port, 'ABCDEFGHIJKLMNO'),
      Buffer.from([0x00]),
      `attempt ${i + 1}: still an ordinary reject, never a silent block`,
    );
  }
  assert.equal(
    handshakeLimiter.isBlocked('127.0.0.1'),
    false,
    'one consistently-malformed device must not exhaust a shared IP\'s budget',
  );

  await server.close();
});
