// ─────────────────────────────────────────────────────────────────────────────
// src/tools/verify-runtime.js — the run-book, as a script (`npm run verify`).
//
// The unit and integration suites all run inside ONE process. That leaves two
// P0 claims untested by them, because both are about a real OS process:
//
//   1. `npm run start:ingest` / `start:api` actually bind and serve when run as
//      their own process (the direct-run guard fires, config is read, the store
//      initialises).
//   2. SIGTERM drains and exits 0 — the ECS/NLB contract. A rolling deploy sends
//      SIGTERM; if we exited non-zero, or hung past the grace period, the
//      orchestrator would SIGKILL us mid-write.
//
// So this spawns them for real, drives a scenario through the ingestion CLI over
// TCP, probes /health before and during the drain, signals both servers, and
// checks their exit codes. It is the same sequence a human follows in
// docs/RUNBOOKS.md — kept as a script so CI runs it and it cannot rot.
//
//   node src/tools/verify-runtime.js
//   node src/tools/verify-runtime.js --scenario yard-idle
//
// Exits 0 on success, 1 with a report of what failed. Ports are picked high and
// overridable (INGEST_PORT / API_PORT) so it never collides with a dev server.
//
// NOTE ON WINDOWS: POSIX signals are emulated. `process.kill(pid, 'SIGTERM')`
// terminates a Node child but does NOT run its signal handlers, so the graceful
// -shutdown assertions are skipped there with a clear message rather than
// silently "passing". Run it on Linux/macOS (or in CI) for the full check.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const isWindows = process.platform === 'win32';

const args = process.argv.slice(2);
const scenarioIdx = args.indexOf('--scenario');
const SCENARIO = scenarioIdx >= 0 ? args[scenarioIdx + 1] : 'handover';

const INGEST_PORT = Number(process.env.INGEST_PORT || 25027);
const API_PORT = Number(process.env.API_PORT || 28080);

const env = {
  ...process.env,
  INGEST_PORT: String(INGEST_PORT),
  API_PORT: String(API_PORT),
  SIM_SERVER_PORT: String(INGEST_PORT),
  LOG_FORMAT: 'kv',
  DB: process.env.DB || 'memory',
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${detail}` : ''}`);
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function run(script, extra = []) {
  const child = spawn(process.execPath, [script, ...extra], { cwd: ROOT, env });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', (d) => (child.stdoutText += d.toString()));
  child.stderr.on('data', (d) => (child.stderrText += d.toString()));
  child.exitInfo = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return child;
}

/** Poll a TCP port until something is listening (no blind sleeps). */
async function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        r(true);
      });
      s.once('error', () => r(false));
    });
    if (open) return true;
    await delay(150);
  }
  return false;
}

async function main() {
  console.log(`\nverify-runtime: scenario=${SCENARIO} store=${env.DB} ` +
    `ingest=${INGEST_PORT} api=${API_PORT}\n`);

  // ── 1. Both servers start as their own process ──────────────────────────────
  const ingest = run('src/ingestion/server.js');
  const api = run('src/api/server.js');

  check('ingestion server binds its TCP port', await waitForPort(INGEST_PORT));
  check('api server binds its HTTP port', await waitForPort(API_PORT));

  // The direct-run guard is the thing that historically breaks (see
  // isEntrypoint in src/lifecycle/shutdown.js): a server that exits 0 without
  // listening looks like success to a shell.
  check(
    'ingestion logged a structured listening event',
    /event=listening/.test(ingest.stdoutText),
    ingest.stdoutText.trim().split('\n').at(-1) || '(no output)',
  );

  // ── 2. /health is ready and cheap ───────────────────────────────────────────
  const base = `http://127.0.0.1:${API_PORT}`;
  const h = await fetch(base + '/health');
  const hb = await h.json();
  check('/health returns 200 ready', h.status === 200 && hb.state === 'ready', JSON.stringify(hb));
  check('/health names the active store', hb.store === env.DB, `store=${hb.store}`);

  // ── 3. A scenario replays over real TCP into the running server ─────────────
  const sim = run('src/simulator/run-simulator.js', ['--scenario', SCENARIO, '--interval', '0']);
  const simExit = await sim.exitInfo;
  const sentMatch = [...sim.stdoutText.matchAll(/sent (\d+), ACKed (\d+)/g)];
  const sent = sentMatch.reduce((n, m) => n + Number(m[1]), 0);
  const acked = sentMatch.reduce((n, m) => n + Number(m[2]), 0);
  check(
    `simulator replayed "${SCENARIO}" and exited 0`,
    simExit.code === 0,
    `exit=${simExit.code}`,
  );
  check(
    'every record sent was ACKed by the server',
    sent > 0 && sent === acked,
    `sent=${sent} acked=${acked}`,
  );
  check(
    'ingestion logged an ACK per packet',
    /event=packet_acked/.test(ingest.stdoutText),
  );
  check(
    'no credentials appear in either server log',
    !/:[^:@/\s]+@/.test(ingest.stdoutText + api.stdoutText),
  );

  // ── 4. Graceful shutdown on SIGTERM ────────────────────────────────────────
  if (isWindows) {
    check(
      'SIGTERM drains and exits 0 (SKIPPED on Windows — signals are emulated)',
      true,
      'run on Linux/macOS or in CI for this check',
    );
    ingest.kill();
    api.kill();
  } else {
    api.kill('SIGTERM');
    ingest.kill('SIGTERM');
    const [apiExit, ingestExit] = await Promise.all([api.exitInfo, ingest.exitInfo]);

    check('api exited 0 on SIGTERM', apiExit.code === 0, `exit=${apiExit.code}`);
    check('ingestion exited 0 on SIGTERM', ingestExit.code === 0, `exit=${ingestExit.code}`);
    check(
      'ingestion logged shutdown_started then shutdown_complete',
      /event=shutdown_started/.test(ingest.stdoutText) &&
        /event=shutdown_complete/.test(ingest.stdoutText),
    );
    check(
      'the drain was not forced by the deadline',
      !/event=shutdown_timeout_forced/.test(ingest.stdoutText + api.stdoutText),
    );
    check('the ingestion port is released', !(await waitForPort(INGEST_PORT, 1500)));
  }

  await delay(200);
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(70));
  console.log(`verify-runtime: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  · ${f.name} ${f.detail}`);
    console.log('─'.repeat(70));
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
  console.log('─'.repeat(70));
  process.exit(0);
}

main().catch((e) => {
  console.error('verify-runtime crashed:', e);
  process.exit(1);
});
