// ─────────────────────────────────────────────────────────────────────────────
// test/ingestion-rate-limit.test.js — proves the handshake rate limit
// (src/ingestion/handshake-limiter.js, wired into src/ingestion/server.js) over
// a REAL TCP socket, the same way test/ingestion.test.js proves the protocol.
//
// Unlike handshake-limiter.test.js (the limiter in isolation), this asserts
// what actually crosses the wire: a source past its threshold gets nothing
// back at all — not even the ordinary 0x00 reject byte — because the
// connection itself is refused before the handshake is read.
//   run: npm run test:ingestion-rate-limit
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
const BAD_IMEI = '999999999999999';

// Raw handshake attempt: connect, send the IMEI frame, collect whatever bytes
// (if any) come back before the socket closes. Deliberately not SimDevice —
// a blocked attempt closes with zero bytes, which SimDevice's connect() isn't
// built to distinguish from a normal reject.
function attemptHandshake(port, imei) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let resolved = false;
    // Resolve on whichever comes first: the handshake reply byte (accept or
    // reject — the server keeps the socket OPEN after an accept, waiting for
    // AVL data, so waiting for 'close' would hang forever on a good IMEI), or
    // the socket closing with nothing at all (the blocked case).
    const finish = (buf) => {
      if (resolved) return;
      resolved = true;
      resolve(buf);
      socket.destroy();
    };
    socket.on('connect', () => socket.write(encodeImei(imei)));
    socket.on('data', (d) => finish(d));
    socket.on('close', () => finish(Buffer.alloc(0)));
    socket.on('error', () => {}); // a refused/reset socket may also emit error; close still follows
  });
}

async function startServer(store, handshakeLimiter) {
  const server = createIngestionServer({
    store,
    host: '127.0.0.1',
    port: 0,
    logger: quiet,
    handshakeLimiter,
  });
  const port = await server.listen();
  return { server, port };
}

test('ingestion: a source is blocked after too many DIFFERENT unknown IMEIs — the real scanning signature', async () => {
  const store = createMemoryStore();
  await store.init();
  const handshakeLimiter = createHandshakeLimiter({ maxFailures: 2, windowMs: 60_000, blockMs: 60_000 });
  const { server, port } = await startServer(store, handshakeLimiter);

  // Two failed handshakes with DISTINCT bad IMEIs — a source enumerating
  // IMEIs, the pattern this limiter exists to catch. Each still gets the
  // ordinary 0x00 reject byte; the limiter counts them, it doesn't change
  // their own outcome.
  assert.deepEqual(await attemptHandshake(port, '111111111111111'), Buffer.from([0x00]), 'attempt 1: ordinary reject');
  assert.deepEqual(await attemptHandshake(port, '222222222222222'), Buffer.from([0x00]), 'attempt 2 (different imei): ordinary reject, now at threshold');
  assert.equal(handshakeLimiter.isBlocked('127.0.0.1'), true, 'limiter should consider this source blocked now');

  // Third attempt, yet another IMEI: refused before the handshake is even read.
  assert.deepEqual(
    await attemptHandshake(port, '333333333333333'),
    Buffer.alloc(0),
    'a blocked attempt gets zero bytes back, not even a reject byte',
  );

  // A KNOWN-GOOD IMEI from the same now-blocked source gets nothing either —
  // this is the point of blocking the connection, not the IMEI: varying which
  // IMEI you try does not buy more guesses once the source itself is blocked.
  assert.deepEqual(
    await attemptHandshake(port, DEVICES[0].imei),
    Buffer.alloc(0),
    'a genuinely valid IMEI from a blocked source still gets nothing back',
  );

  await server.close();
});

test('ingestion: CGNAT fix — retrying the SAME unknown IMEI over and over does not block the source', async () => {
  const store = createMemoryStore();
  await store.init();
  const handshakeLimiter = createHandshakeLimiter({ maxFailures: 2, windowMs: 60_000, blockMs: 60_000 });
  const { server, port } = await startServer(store, handshakeLimiter);

  // One flaky/misconfigured device retrying its OWN wrong IMEI five times —
  // well past maxFailures as a raw attempt count. Under CGNAT this source IP
  // may be shared by many other, unrelated real devices, so this must not
  // block the connection for any of them.
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(
      await attemptHandshake(port, BAD_IMEI),
      Buffer.from([0x00]),
      `attempt ${i + 1}: still an ordinary reject, never a silent block`,
    );
  }
  assert.equal(handshakeLimiter.isBlocked('127.0.0.1'), false, 'one repeatedly-wrong device must not exhaust a shared IP\'s budget');

  // And a real device sharing that IP still gets through cleanly.
  assert.deepEqual(await attemptHandshake(port, DEVICES[0].imei), Buffer.from([0x01]), 'a real device on the same source IP is unaffected');

  await server.close();
});

test('ingestion: one earlier failure does not block a source that then hands over a valid IMEI', async () => {
  const store = createMemoryStore();
  await store.init();
  const handshakeLimiter = createHandshakeLimiter({ maxFailures: 2, windowMs: 60_000, blockMs: 60_000 });
  const { server, port } = await startServer(store, handshakeLimiter);

  assert.deepEqual(await attemptHandshake(port, BAD_IMEI), Buffer.from([0x00]));
  assert.deepEqual(
    await attemptHandshake(port, DEVICES[0].imei),
    Buffer.from([0x01]),
    'one prior failure should not itself block a legitimate handshake',
  );

  // And the success clears the record — it isn't sitting at "1 of 2" waiting
  // for one more mistake to tip it into a block.
  assert.equal(handshakeLimiter.isBlocked('127.0.0.1'), false);

  await server.close();
});
