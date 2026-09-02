// ─────────────────────────────────────────────────────────────────────────────
// src/simulator/run-simulator.js — CLI for the scenario engine (Module 9).
//
// Two modes:
//
//   1. REPLAY a named scenario (the default). Every track in the scenario gets
//      its own connection, and its pre-built records are streamed on the
//      interval. The stream is finite: when a track's records run out that
//      device disconnects, and the process exits once all tracks are done.
//
//        npm run sim                                  # SIM_SCENARIO or 'day-cycle'
//        npm run sim -- --scenario handover
//        npm run sim -- --scenario yard-idle --interval 200
//        npm run sim -- --list
//        SIM_SCENARIO=tamper npm run sim
//
//   2. STREAM indefinitely — the original behaviour, for a soak test. Pass
//      `--stream` (or --scenario none) and N devices from the seed roster send
//      the legacy single-session generator forever on the interval.
//
//        npm run sim -- --stream --devices 2
//
// Start the ingestion server first (`npm run start:ingest`), or run
// `npm run demo`, which wires server + simulator + API together in one process.
//
// SIGINT/SIGTERM shut every device down cleanly (stop the timers, close the
// sockets, exit 0) — the same contract the ingestion and API servers honour via
// src/lifecycle/shutdown.js.
// ─────────────────────────────────────────────────────────────────────────────

import { config } from '../config.js';
import { SimDevice } from './device.js';
import {
  buildScenario,
  makeScenario,
  SCENARIOS,
  SCENARIO_NAMES,
  DEFAULT_SCENARIO,
} from './scenarios.js';
import { DEVICES } from '../store/seed-data.js';
import { createLogger } from '../logging/logger.js';
import { installShutdown, isEntrypoint } from '../lifecycle/shutdown.js';

// ── Argument parsing (no dependency; flags mirror the SIM_* env vars) ─────────
export function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--stream') out.stream = true;
    else if (a === '--scenario') out.scenario = argv[++i];
    else if (a.startsWith('--scenario=')) out.scenario = a.slice('--scenario='.length);
    else if (a === '--interval') out.intervalMs = Number(argv[++i]);
    else if (a.startsWith('--interval=')) out.intervalMs = Number(a.slice('--interval='.length));
    else if (a === '--devices') out.devices = Number(argv[++i]);
    else if (a.startsWith('--devices=')) out.devices = Number(a.slice('--devices='.length));
    else if (a === '--records') out.records = Number(argv[++i]);
    else if (a.startsWith('--records=')) out.records = Number(a.slice('--records='.length));
    else if (a === '--codec') out.codec = argv[++i];
    else if (a.startsWith('--codec=')) out.codec = a.slice('--codec='.length);
    else if (a === '--seed') out.seed = argv[++i];
    else if (a.startsWith('--seed=')) out.seed = a.slice('--seed='.length);
  }
  return out;
}

function printScenarioList() {
  console.log('\nAvailable scenarios (--scenario <name>):\n');
  for (const name of SCENARIO_NAMES) {
    const def = SCENARIOS[name];
    console.log(`  ${name}${name === DEFAULT_SCENARIO ? '  (default)' : ''}`);
    console.log(`      ${def.description}`);
    for (const p of def.proves ?? []) console.log(`      · proves: ${p}`);
    console.log('');
  }
  console.log('  --stream    ignore scenarios; stream the legacy session forever (soak test)\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Replay one track: connect, send its records one per tick, disconnect ──────
// Exported so other tools (the browser control-panel server) can drive a
// scenario's real send loop without duplicating it — same TCP client, same
// bytes, just with an optional look at what went out (`onPacket`).
export async function replayTrack({ track, host, port, codec, intervalMs, logger, state, onPacket }) {
  const dev = new SimDevice({ host, port, imei: track.imei, codec, onPacket });
  try {
    await dev.connect();
  } catch (e) {
    logger.error('device_connect_failed', {
      imei: track.imei,
      error: e.message,
      hint: 'is the ingestion server running?',
    });
    return { imei: track.imei, sent: 0, acked: 0, failed: true };
  }
  state.open.add(dev);
  logger.info('device_connected', { imei: track.imei, track: track.label });

  let sent = 0;
  let acked = 0;
  try {
    for (const record of track.records) {
      if (state.stopping) break;
      const ack = await dev.send([record]);
      sent++;
      acked += ack;
      logger.debug('record_sent', {
        imei: track.imei,
        seq: sent,
        phase: record._phase,
        ack,
      });
      if (intervalMs > 0 && sent < track.records.length) await sleep(intervalMs);
    }
  } catch (e) {
    logger.error('device_send_failed', { imei: track.imei, seq: sent + 1, error: e.message });
    return { imei: track.imei, sent, acked, failed: true };
  } finally {
    dev.close();
    state.open.delete(dev);
  }
  logger.info('track_complete', { imei: track.imei, track: track.label, sent, acked });
  return { imei: track.imei, label: track.label, sent, acked, failed: false };
}

// ── Legacy indefinite stream (soak mode) ─────────────────────────────────────
async function streamDevice({ imei, idx, host, port, codec, intervalMs, logger, state }) {
  const dev = new SimDevice({ host, port, imei, codec });
  try {
    await dev.connect();
  } catch (e) {
    logger.error('device_connect_failed', { imei, error: e.message });
    return;
  }
  state.open.add(dev);
  logger.info('device_connected', { imei, mode: 'stream' });

  const scenario = makeScenario({ stepMs: intervalMs, lat0: 25.2048 + idx * 0.02 });
  let i = 0;
  while (!state.stopping) {
    try {
      const ack = await dev.send([scenario(i++)]);
      logger.debug('record_sent', { imei, seq: i, ack });
    } catch (e) {
      logger.error('device_send_failed', { imei, seq: i, error: e.message });
      break;
    }
    await sleep(intervalMs);
  }
  dev.close();
  state.open.delete(dev);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    printScenarioList();
    return;
  }

  const logger = createLogger({
    module: 'simulator',
    level: config.log.level,
    format: config.log.format,
  });

  const host = config.sim.host;
  const port = config.sim.port;
  const codec = args.codec ?? config.sim.codec;
  const intervalMs = args.intervalMs ?? config.sim.intervalMs;
  const scenarioName = args.scenario ?? config.sim.scenario;
  const streamMode = args.stream === true || scenarioName === 'none';

  const state = { stopping: false, open: new Set() };

  // Graceful stop: flip the flag so the send loops exit at the next boundary
  // (never mid-packet), then close whatever sockets are still open.
  installShutdown({
    name: 'simulator',
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    async stop() {
      state.stopping = true;
      for (const dev of state.open) dev.close();
    },
  });

  if (streamMode) {
    const imeis = DEVICES.map((d) => d.imei);
    const n = Math.max(1, Math.min(args.devices ?? config.sim.devices, imeis.length));
    logger.info('simulator_start', {
      mode: 'stream',
      devices: n,
      codec,
      intervalMs,
      target: `${host}:${port}`,
    });
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        streamDevice({ imei: imeis[i], idx: i, host, port, codec, intervalMs, logger, state }),
      ),
    );
    return;
  }

  const built = buildScenario(scenarioName, {
    seed: args.seed,
    records: args.records ?? config.sim.records,
  });

  logger.info('simulator_start', {
    mode: 'scenario',
    scenario: built.name,
    tracks: built.tracks.length,
    records: built.tracks.reduce((n, t) => n + t.records.length, 0),
    codec,
    intervalMs,
    target: `${host}:${port}`,
  });
  console.log(`\nscenario: ${built.name} — ${built.description}\n`);

  // Tracks run concurrently: the handover scenario is two connections from the
  // same IMEI, which is exactly what a real reconnect looks like to the server.
  const results = await Promise.all(
    built.tracks.map((track) =>
      replayTrack({ track, host, port, codec, intervalMs, logger, state }),
    ),
  );

  for (const r of results) {
    console.log(
      `  ${r.label ?? r.imei}: sent ${r.sent}, ACKed ${r.acked}${r.failed ? '  (FAILED)' : ''}`,
    );
  }
  console.log('');
  if (results.some((r) => r.failed)) process.exitCode = 1;
}

// Only run when invoked directly, so tests can import parseArgs. isEntrypoint()
// rather than the `import.meta.url === file://argv[1]` idiom, which is false on
// Windows — see src/lifecycle/shutdown.js.
if (isEntrypoint(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
