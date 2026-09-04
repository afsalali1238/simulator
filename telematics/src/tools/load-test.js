// ─────────────────────────────────────────────────────────────────────────────
// src/tools/load-test.js — concurrency/soak test for Module 1 (Ingestion).
//
// Every other proof in this repo answers "is the protocol/durability/tenancy
// correct" with ONE device at a time (test/ingestion.test.js, the scenario
// suites, npm run demo). None of them answer the question that actually
// matters for "can this take a real fleet": what happens when a few hundred
// devices hold connections open and send at once? This script does — real
// TCP, real Teltonika handshake + AVL bytes (SimDevice, the same client class
// as the interactive simulator), just many of them at once.
//
// Two modes:
//   embedded (default) — spins up its own in-process ingestion server backed
//     by the memory store, so it can sample ITS OWN memory and event-loop
//     health directly. This answers "how does our server hold up", isolated
//     from whatever else is running on the machine.
//   external (--host/--port) — points at an already-running server (e.g.
//     `npm run start:ingest`, optionally `DB=pg`, in another terminal). No
//     memory/event-loop sampling — that process is out of reach from here —
//     but it proves the same story against something closer to a real
//     deployment, including the Postgres path.
//
// Devices are synthetic (see syntheticDevices below): distinct IMEIs seeded
// into the store just for this run, unassigned (owner-tenant, position +
// ignition only — the same supported path DEVICES[1]/FMC920 already exercises
// in the correctness suite). The scale dimension under test is CONNECTION
// COUNT, not tenancy, so there's no need to fabricate assignments.
//
// Usage:
//   npm run loadtest                                  # 200 connections, embedded
//   npm run loadtest -- --connections 500 --records 10
//   npm run loadtest -- --ramp-ms 0                    # burst: all connect at once
//   npm run loadtest -- --host 127.0.0.1 --port 5027   # external, e.g. DB=pg
//
// NOT part of the merge gate (`npm run test:gate`). A throughput/latency
// number is an environment fact, not a correctness invariant — pinning a
// numeric SLA to a shared CI runner is exactly the flaky-test problem the gate
// exists to avoid. test/load-test-smoke.test.js instead proves the HARNESS
// itself keeps working, at a tiny deterministic scale, so this can't silently
// rot into something that no longer runs.
// ─────────────────────────────────────────────────────────────────────────────

import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createIngestionServer } from '../ingestion/server.js';
import { createMemoryStore } from '../store/memory-store.js';
import { SimDevice } from '../simulator/device.js';
import { makeScenario } from '../simulator/scenarios.js';
import { TENANTS } from '../store/seed-data.js';
import { silentLogger, createLogger } from '../logging/logger.js';
import { isEntrypoint } from '../lifecycle/shutdown.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Synthetic fleet ────────────────────────────────────────────────────────
// 15-digit IMEIs in a range that can never collide with the real seed fixtures
// (356...) or the "unknown IMEI" fixture used by the rate-limit/rejection
// tests (999...). Unassigned on purpose — see the file header.
export function syntheticDevices(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `load-test-${i}`,
      imei: String(900_000_000_000_000 + i).padStart(15, '0'),
      model: 'FMC130-LOADTEST',
      firmware: 'load-test',
      ownerTenantId: TENANTS.DOZR.id,
      status: 'active',
    });
  }
  return out;
}

// ── Stats ───────────────────────────────────────────────────────────────────
function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

function summarize(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

// ── One simulated device's whole session: connect, send N records, done ────
async function runDevice({ device, host, port, codec, recordsPerDevice, intervalMs, logger, metrics }) {
  const t0 = performance.now();
  const dev = new SimDevice({ host, port, imei: device.imei, codec });
  try {
    await dev.connect();
  } catch (e) {
    metrics.connectFailed++;
    logger.warn?.('loadtest_connect_failed', { imei: device.imei, error: e.message });
    return;
  }
  metrics.connected++;
  metrics.connectMs.push(performance.now() - t0);

  const scenario = makeScenario({});
  try {
    for (let i = 0; i < recordsPerDevice; i++) {
      const tAck0 = performance.now();
      await dev.send([scenario(i)]);
      metrics.ackMs.push(performance.now() - tAck0);
      metrics.recordsAcked++;
      if (intervalMs > 0 && i < recordsPerDevice - 1) await sleep(intervalMs);
    }
  } catch (e) {
    metrics.sendErrors++;
    logger.warn?.('loadtest_send_failed', { imei: device.imei, error: e.message });
  } finally {
    dev.close();
  }
}

// ── The run ────────────────────────────────────────────────────────────────
export async function runLoadTest({
  connections = 200,
  recordsPerDevice = 5,
  intervalMs = 200,
  rampMs = 1000,
  codec = '8E',
  host = null, // null => embedded server
  port = null,
  logger = silentLogger,
  thresholds = {},
} = {}) {
  const external = host != null;
  let server = null;
  let store = null;
  let embeddedHost = host;
  let embeddedPort = port;

  if (!external) {
    store = createMemoryStore({ devices: syntheticDevices(connections) });
    await store.init();
    // Deliberately silentLogger here, not the caller's `logger`: at load-test
    // scale the server logs one line per handshake and one per ACK, which at
    // a few hundred connections is thousands of lines that drown the report
    // and measurably slow the run down on console I/O alone. `logger` below
    // is reserved for the load test's OWN rare connect/send-failure warnings.
    server = createIngestionServer({ store, host: '127.0.0.1', port: 0, logger: silentLogger });
    embeddedPort = await server.listen();
    embeddedHost = '127.0.0.1';
  }

  const devices = syntheticDevices(connections);

  const metrics = {
    connected: 0,
    connectFailed: 0,
    recordsAcked: 0,
    sendErrors: 0,
    connectMs: [],
    ackMs: [],
  };

  // Server-side health sampling — only possible when we own the process.
  let peakRssMb = null;
  let eventLoopLagP95Ms = null;
  let memSampler = null;
  let elDelay = null;
  if (!external) {
    peakRssMb = 0;
    elDelay = monitorEventLoopDelay({ resolution: 10 });
    elDelay.enable();
    memSampler = setInterval(() => {
      const rssMb = process.memoryUsage().rss / (1024 * 1024);
      if (rssMb > peakRssMb) peakRssMb = rssMb;
    }, 250);
  }

  const t0 = performance.now();

  // Ramp connections in over rampMs (rampMs=0 => a true burst — every device
  // fires its connect() in the same tick, which is the worst-case "everyone
  // reconnects after an outage" shape).
  const runs = devices.map((device, i) => {
    const delay = rampMs > 0 ? Math.floor((i / devices.length) * rampMs) : 0;
    return (async () => {
      if (delay > 0) await sleep(delay);
      return runDevice({ device, host: embeddedHost, port: embeddedPort, codec, recordsPerDevice, intervalMs, logger, metrics });
    })();
  });

  await Promise.allSettled(runs);
  const durationMs = performance.now() - t0;

  if (elDelay) {
    elDelay.disable();
    eventLoopLagP95Ms = elDelay.percentile(95) / 1e6; // ns -> ms
  }
  if (memSampler) clearInterval(memSampler);

  if (server) await server.close();
  if (store?.close) await store.close();

  const report = {
    config: { connections, recordsPerDevice, intervalMs, rampMs, codec, mode: external ? 'external' : 'embedded' },
    durationMs,
    connections: {
      attempted: connections,
      connected: metrics.connected,
      failed: metrics.connectFailed,
    },
    records: {
      sent: connections * recordsPerDevice,
      acked: metrics.recordsAcked,
      sendErrors: metrics.sendErrors,
    },
    latency: {
      connectMs: summarize(metrics.connectMs),
      ackMs: summarize(metrics.ackMs),
    },
    server: external ? null : { peakRssMb: Math.round(peakRssMb), eventLoopLagP95Ms },
  };

  report.pass = evaluate(report, thresholds);
  return report;
}

// ── Pass/fail against configurable thresholds (conservative defaults; this
// is a smoke bar, not a tuned SLA — override via CLI or the opts object for a
// real capacity exercise). ──────────────────────────────────────────────────
function evaluate(report, thresholds) {
  const t = {
    maxConnectFailRate: 0.01,
    maxSendErrorRate: 0.01,
    maxAckP95Ms: 500,
    maxEventLoopLagP95Ms: 250,
    ...thresholds,
  };
  const connectFailRate = report.connections.attempted
    ? report.connections.failed / report.connections.attempted
    : 0;
  const sendErrorRate = report.records.sent ? report.records.sendErrors / report.records.sent : 0;
  const checks = [
    { name: 'connect failure rate', ok: connectFailRate <= t.maxConnectFailRate, detail: `${(connectFailRate * 100).toFixed(2)}% <= ${t.maxConnectFailRate * 100}%` },
    { name: 'send/ACK error rate', ok: sendErrorRate <= t.maxSendErrorRate, detail: `${(sendErrorRate * 100).toFixed(2)}% <= ${t.maxSendErrorRate * 100}%` },
    {
      name: 'ACK latency p95',
      ok: report.latency.ackMs.p95 == null || report.latency.ackMs.p95 <= t.maxAckP95Ms,
      detail: `${report.latency.ackMs.p95?.toFixed(1) ?? 'n/a'}ms <= ${t.maxAckP95Ms}ms`,
    },
  ];
  if (report.server) {
    checks.push({
      name: 'event-loop lag p95',
      ok: report.server.eventLoopLagP95Ms == null || report.server.eventLoopLagP95Ms <= t.maxEventLoopLagP95Ms,
      detail: `${report.server.eventLoopLagP95Ms?.toFixed(1) ?? 'n/a'}ms <= ${t.maxEventLoopLagP95Ms}ms`,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

function printReport(report) {
  const c = report.config;
  console.log('');
  console.log(
    `load-test: mode=${c.mode} connections=${c.connections} records/device=${c.recordsPerDevice} ` +
      `interval=${c.intervalMs}ms ramp=${c.rampMs}ms codec=${c.codec}`,
  );
  console.log('');
  console.log(
    `  connections   attempted=${report.connections.attempted}  connected=${report.connections.connected}  failed=${report.connections.failed}`,
  );
  console.log(
    `  records       sent=${report.records.sent}  acked=${report.records.acked}  send-errors=${report.records.sendErrors}`,
  );
  const fmt = (s) => (s.count ? `p50=${s.p50.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms p99=${s.p99.toFixed(1)}ms max=${s.max.toFixed(1)}ms` : 'n/a');
  console.log(`  connect time  ${fmt(report.latency.connectMs)}`);
  console.log(`  ACK latency   ${fmt(report.latency.ackMs)}`);
  if (report.server) {
    console.log(
      `  server        peak RSS=${report.server.peakRssMb}MB  event-loop lag p95=${report.server.eventLoopLagP95Ms?.toFixed(1)}ms`,
    );
  } else {
    console.log('  server        n/a (external mode — point a profiler at that process for this)');
  }
  console.log(`  duration      ${(report.durationMs / 1000).toFixed(1)}s`);
  console.log('');
  for (const check of report.pass.checks) {
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'}   ${check.name} — ${check.detail}`);
  }
  console.log('');
  console.log(
    '──────────────────────────────────────────────────────────────────────',
  );
  console.log(report.pass.ok ? 'LOAD TEST PASSED' : 'LOAD TEST FAILED — see checks above');
  console.log(
    '─────────────────────────────────────────────────────────────────────',
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--connections') out.connections = Number(next());
    else if (a === '--records') out.recordsPerDevice = Number(next());
    else if (a === '--interval-ms') out.intervalMs = Number(next());
    else if (a === '--ramp-ms') out.rampMs = Number(next());
    else if (a === '--codec') out.codec = next();
    else if (a === '--host') out.host = next();
    else if (a === '--port') out.port = Number(next());
  }
  return out;
}

if (isEntrypoint(import.meta.url)) {
  const { config } = await import('../config.js');
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger({ module: 'loadtest', level: config.log.level, format: config.log.format });

  if (args.host && !args.port) {
    console.error('--host requires --port');
    process.exit(1);
  }

  // A bounded, one-shot CLI tool (same shape as demo.js/verify-runtime.js) —
  // no graceful-drain lifecycle needed; it runs its fixed workload and exits.
  const report = await runLoadTest({ ...args, logger });
  printReport(report);
  process.exitCode = report.pass.ok ? 0 : 1;
}
