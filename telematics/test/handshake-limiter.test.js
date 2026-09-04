// test/handshake-limiter.test.js — src/ingestion/handshake-limiter.js in
// isolation: no sockets, no timers, an injectable clock. Proves the counting,
// blocking, expiry, and success-reset behaviour the ingestion server relies on.
//   run: npm run test:handshake-limiter

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandshakeLimiter } from '../src/ingestion/handshake-limiter.js';

// A controllable clock: tests advance it explicitly rather than sleeping.
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('handshake-limiter: not blocked before any failures', () => {
  const limiter = createHandshakeLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000 });
  assert.equal(limiter.isBlocked('1.2.3.4'), false);
});

test('handshake-limiter: blocks once failures reach the threshold', () => {
  const clock = fakeClock();
  const limiter = createHandshakeLimiter({
    maxFailures: 3,
    windowMs: 1000,
    blockMs: 5000,
    now: clock.now,
  });
  const r1 = limiter.recordFailure('1.2.3.4');
  const r2 = limiter.recordFailure('1.2.3.4');
  const r3 = limiter.recordFailure('1.2.3.4');
  assert.equal(r1.blocked, false);
  assert.equal(r2.blocked, false);
  assert.equal(r3.blocked, true);
  assert.equal(r3.justBlocked, true);
  assert.equal(limiter.isBlocked('1.2.3.4'), true);
});

test('handshake-limiter: does not block a different IP', () => {
  const limiter = createHandshakeLimiter({ maxFailures: 2, windowMs: 1000, blockMs: 5000 });
  limiter.recordFailure('1.2.3.4');
  limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4'), true);
  assert.equal(limiter.isBlocked('9.9.9.9'), false);
});

test('handshake-limiter: block expires after blockMs and the IP is usable again', () => {
  const clock = fakeClock();
  const limiter = createHandshakeLimiter({
    maxFailures: 2,
    windowMs: 1000,
    blockMs: 5000,
    now: clock.now,
  });
  limiter.recordFailure('1.2.3.4');
  limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4'), true);

  clock.advance(4999);
  assert.equal(limiter.isBlocked('1.2.3.4'), true, 'still inside the block window');

  clock.advance(2); // now 5001ms since the block started
  assert.equal(limiter.isBlocked('1.2.3.4'), false, 'block should have expired');

  // And the failure count really reset — it takes a fresh full run to re-block.
  const r1 = limiter.recordFailure('1.2.3.4');
  assert.equal(r1.blocked, false);
  assert.equal(r1.failures, 1);
});

test('handshake-limiter: failure count resets after windowMs with no block reached', () => {
  const clock = fakeClock();
  const limiter = createHandshakeLimiter({
    maxFailures: 5,
    windowMs: 1000,
    blockMs: 5000,
    now: clock.now,
  });
  limiter.recordFailure('1.2.3.4');
  limiter.recordFailure('1.2.3.4');
  clock.advance(1500); // window elapsed, never reached maxFailures
  const r = limiter.recordFailure('1.2.3.4');
  assert.equal(r.failures, 1, 'window should have reset the counter, not accumulated');
  assert.equal(r.blocked, false);
});

test('handshake-limiter: a successful handshake clears the IP’s record', () => {
  const limiter = createHandshakeLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000 });
  limiter.recordFailure('1.2.3.4');
  limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.size(), 1);
  limiter.recordSuccess('1.2.3.4');
  assert.equal(limiter.size(), 0);
  assert.equal(limiter.isBlocked('1.2.3.4'), false);

  // And it takes a full fresh run to block again — the earlier failures are gone.
  limiter.recordFailure('1.2.3.4');
  limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4'), false);
});

test('handshake-limiter: CGNAT fix — retrying the SAME imei repeatedly does not block the shared IP', () => {
  const limiter = createHandshakeLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000 });
  // One flaky/misconfigured device retrying its own wrong IMEI five times —
  // well past maxFailures as a raw attempt count — must not tip the IP into
  // a block, because it is still just ONE device, not a scan.
  for (let i = 0; i < 5; i++) {
    const r = limiter.recordFailure('1.2.3.4', 'BAD-IMEI-SAME');
    assert.equal(r.failures, 1, `attempt ${i + 1}: distinct-imei count should stay at 1`);
    assert.equal(r.blocked, false);
  }
  assert.equal(limiter.isBlocked('1.2.3.4'), false);
});

test('handshake-limiter: distinct imeis from one IP still trip the block (the real scanning signature)', () => {
  const limiter = createHandshakeLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000 });
  const r1 = limiter.recordFailure('1.2.3.4', 'IMEI-A');
  const r2 = limiter.recordFailure('1.2.3.4', 'IMEI-B');
  const r3 = limiter.recordFailure('1.2.3.4', 'IMEI-C');
  assert.equal(r1.blocked, false);
  assert.equal(r2.blocked, false);
  assert.equal(r3.blocked, true);
  assert.equal(r3.justBlocked, true);
  assert.equal(limiter.isBlocked('1.2.3.4'), true);
});

test('handshake-limiter: retrying the same imei past a window reset still does not block', () => {
  const clock = fakeClock();
  const limiter = createHandshakeLimiter({
    maxFailures: 2,
    windowMs: 1000,
    blockMs: 5000,
    now: clock.now,
  });
  limiter.recordFailure('1.2.3.4', 'BAD-IMEI');
  clock.advance(1500); // window elapsed, no block reached
  const r = limiter.recordFailure('1.2.3.4', 'BAD-IMEI');
  assert.equal(r.failures, 1, 'window reset should clear the imei set, not accumulate stale entries');
  assert.equal(r.blocked, false);
});

test('handshake-limiter: legacy no-imei callers keep the original per-attempt counting', () => {
  // Same shape as the very first blocking test above, just re-asserted here
  // next to the new imei-aware tests so the two behaviours sit side by side.
  const limiter = createHandshakeLimiter({ maxFailures: 2, windowMs: 1000, blockMs: 5000 });
  const r1 = limiter.recordFailure('5.5.5.5');
  const r2 = limiter.recordFailure('5.5.5.5');
  assert.equal(r1.blocked, false);
  assert.equal(r2.blocked, true);
});

test('handshake-limiter: sweep bounds memory for IPs that go quiet', () => {
  const clock = fakeClock();
  const limiter = createHandshakeLimiter({
    maxFailures: 100, // never actually blocks in this test
    windowMs: 1000,
    blockMs: 5000,
    now: clock.now,
  });
  for (let i = 0; i < 50; i++) limiter.recordFailure(`10.0.0.${i}`);
  assert.equal(limiter.size(), 50);

  // Past the window, with no further activity: the next isBlocked call (any
  // IP) triggers a sweep and the stale entries should be gone.
  clock.advance(1001);
  limiter.isBlocked('somewhere-else');
  assert.ok(limiter.size() <= 1, `expected the 50 stale entries to be swept, got ${limiter.size()}`);
});
