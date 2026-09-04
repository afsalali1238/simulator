// ─────────────────────────────────────────────────────────────────────────────
// src/ingestion/handshake-limiter.js — per-source-IP throttling for the IMEI
// handshake (P0 hardening, not a new module: ingestion still owns this).
//
// The ingestion server accepts a TCP connection from anyone; the only gate is
// "is this 15-digit IMEI in our device registry" (src/ingestion/server.js).
// That is not a secret — IMEIs are guessable/enumerable — so without this, a
// script can open connections all day and try IMEIs until one lands, or just
// hammer the port. This does not make the handshake itself secure (see the
// note in RUNBOOKS.md about pairing this with TLS/a pre-shared token before a
// public IP), but it turns "unlimited free tries from one address" into
// "N tries, then a cooldown", which is the cheap, contained fix for the worst
// of it.
//
// Pure and dependency-free like the rest of this harness's core modules
// (protocol/codec.js, decode/normalize.js): no timers, no I/O, an injectable
// clock (`now`) so tests don't need real sleeps. The server calls into this on
// every connection and on every handshake outcome; this module holds no
// sockets and knows nothing about TCP.
// ────────────────────────────────────────────────────────────────────────────

export function createHandshakeLimiter({
  maxFailures = 5,
  windowMs = 60_000,
  blockMs = 5 * 60_000,
  now = () => Date.now(),
} = {}) {
  // ip -> { failures, windowStart, blockedUntil }
  const state = new Map();
  let lastSweep = now();

  // Roll a per-IP entry forward: clear an expired block, or reset the failure
  // count once its window has elapsed without escalating to a block.
  function touch(ip, t) {
    let entry = state.get(ip);
    if (!entry) {
      entry = { failures: 0, windowStart: t, blockedUntil: 0, imeis: null };
      state.set(ip, entry);
    }
    if (entry.blockedUntil && entry.blockedUntil <= t) {
      entry.blockedUntil = 0;
      entry.failures = 0;
      entry.windowStart = t;
      entry.imeis = null;
    } else if (!entry.blockedUntil && t - entry.windowStart >= windowMs) {
      entry.failures = 0;
      entry.windowStart = t;
      entry.imeis = null;
    }
    return entry;
  }

  // Bound memory under sustained scanning from many source IPs. Rate-limited
  // to once per window rather than run on every call — a sweep is O(entries),
  // and a connection storm is exactly when we can least afford O(n) per call.
  function maybeSweep(t) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [ip, entry] of state) {
      if (entry.blockedUntil > t) continue; // still blocked, keep it
      if (!entry.blockedUntil && t - entry.windowStart < windowMs) continue; // window still live
      state.delete(ip);
    }
  }

  return {
    /** True if this IP is currently in its cooldown. Call before the handshake starts. */
    isBlocked(ip) {
      const t = now();
      maybeSweep(t);
      const entry = state.get(ip);
      if (!entry) return false;
      return touch(ip, t).blockedUntil > t;
    },

    /**
     * Record one failed handshake (unknown IMEI) from this IP. Returns whether
     * this failure was the one that tipped the IP into a block, so the caller
     * can log it distinctly from an ordinary rejection.
     */
    /**
     * `imei` is optional (kept backward-compatible for any caller/test that
     * still calls recordFailure(ip) alone). When it IS supplied — the real
     * server path, once the IMEI frame has been parsed — strikes are counted
     * by DISTINCT imei, not by attempt. This is the CGNAT fix: many real
     * devices can sit behind one shared carrier IP, and a single
     * misconfigured/flaky device retrying its own wrong IMEI must not, by
     * itself, burn through the shared IP's budget and lock out its neighbours
     * on the same address. A source that tries many DIFFERENT imeis — the
     * actual scanning signature — still escalates exactly as fast as before.
     */
    recordFailure(ip, imei) {
      const t = now();
      const entry = touch(ip, t);
      if (imei) {
        entry.imeis ??= new Set();
        entry.imeis.add(imei);
        entry.failures = entry.imeis.size;
      } else {
        entry.failures += 1;
      }
      const justBlocked = entry.failures >= maxFailures && !entry.blockedUntil;
      if (entry.failures >= maxFailures) entry.blockedUntil = t + blockMs;
      return {
        failures: entry.failures,
        blocked: entry.blockedUntil > t,
        justBlocked,
        blockedUntil: entry.blockedUntil || null,
      };
    },

    /**
     * A successful handshake clears this IP's record. A legitimate device
     * that mistyped/misconfigured its IMEI a few times before getting it
     * right should not stay throttled — the failures were real, but the risk
     * they signaled is resolved once a known device proves itself.
     */
    recordSuccess(ip) {
      state.delete(ip);
    },

    /** Tracked-IP count, for tests and /health-adjacent introspection. */
    size() {
      return state.size;
    },
  };
}
