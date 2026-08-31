// ─────────────────────────────────────────────────────────────────────────────
// src/lifecycle/shutdown.js — graceful shutdown plumbing (P0 operability).
//
// The pattern src/simulator/run-simulator.js already used, generalised so the
// ingestion and API servers reach the same bar:
//
//   signal -> stop accepting new work -> let in-flight work finish -> release
//   resources -> exit 0
//
// Why this is load-bearing for invariant 1 (ACK only after a durable write):
// the ingestion server must never be killed between "write committed" and "ACK
// written to the socket", and it must never ACK work it then abandons. Draining
// in-flight packets before closing sockets is what makes a rolling ECS deploy
// or an NLB target drain safe.
//
// A hard deadline (SHUTDOWN_TIMEOUT_MS) bounds the drain so a stuck socket can
// never wedge a restart; exceeding it is logged and then forced.
//
// This module also owns `isEntrypoint()`, the cross-platform "was I run
// directly?" check the servers use — see the note on it below.
// ─────────────────────────────────────────────────────────────────────────────

import { pathToFileURL } from 'node:url';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * True when THIS module is the file node was invoked with (`node src/x.js`),
 * false when it was imported by something else (a test, the demo).
 *
 * Why this exists instead of the usual one-liner: the common idiom
 *
 *     import.meta.url === `file://${process.argv[1]}`
 *
 * is broken on Windows. `process.argv[1]` is a native path
 * (`C:\...\server.js`), so the comparison builds `file://C:\...\server.js`
 * while `import.meta.url` is `file:///C:/.../server.js` — they never match, and
 * `npm run start:ingest` silently exits 0 without starting a server. It also
 * mis-fires on POSIX paths containing spaces. `pathToFileURL` normalises both
 * sides on every platform.
 *
 * @param importMetaUrl pass `import.meta.url` from the module being guarded
 */
export function isEntrypoint(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return importMetaUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

/**
 * Race a drain against a deadline.
 *
 * The timer is always cleared once the race settles. That matters for two
 * reasons: a dangling timer would keep a would-be-exiting process alive, and an
 * `unref()`ed one has the opposite failure — on some Node versions the event
 * loop can empty while the drain is still pending, and the caller is left
 * holding a promise that never resolves.
 *
 * @returns {Promise<boolean>} true if it drained in time, false if it timed out.
 */
export async function drainWithTimeout(promise, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
  let timer;
  let timedOut = false;
  try {
    await Promise.race([
      Promise.resolve(promise).catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return !timedOut;
}

/**
 * Install SIGINT/SIGTERM handlers that run `stop` exactly once.
 *
 * @param opts.name           what is shutting down, for the log line
 * @param opts.stop           async () => void — the drain (idempotent)
 * @param opts.logger         structured logger
 * @param opts.timeoutMs      hard deadline for the drain
 * @param opts.exit           process exit hook (injectable for tests)
 * @param opts.signals        which signals to trap
 * @returns a function that removes the handlers (used by tests)
 */
export function installShutdown({
  name = 'server',
  stop,
  logger = console,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  exit = (code) => process.exit(code),
  signals = ['SIGINT', 'SIGTERM'],
} = {}) {
  let shuttingDown = false;

  const handler = async (signal) => {
    if (shuttingDown) {
      logger.warn?.('shutdown_signal_repeated', { name, signal });
      return;
    }
    shuttingDown = true;
    logger.info?.('shutdown_started', { name, signal, timeoutMs });
    const startedAt = Date.now();
    let clean = false;
    try {
      clean = await drainWithTimeout(stop?.(), timeoutMs);
    } catch (err) {
      logger.error?.('shutdown_failed', { name, signal, error: err });
      remove();
      return exit(1);
    }
    const ms = Date.now() - startedAt;
    if (clean) logger.info?.('shutdown_complete', { name, signal, ms });
    else logger.warn?.('shutdown_timeout_forced', { name, signal, ms, timeoutMs });
    remove();
    return exit(0);
  };

  const bound = signals.map((sig) => {
    const fn = () => handler(sig);
    process.on(sig, fn);
    return [sig, fn];
  });

  function remove() {
    for (const [sig, fn] of bound) process.off(sig, fn);
  }

  return remove;
}
