// ─────────────────────────────────────────────────────────────────────────────
// src/simulator/run-fleet.js — the unique-IMEI full-process fleet simulation.
//
// This is the "simulate all the process" tool: it mints a fleet of DISTINCT,
// Luhn-valid FMC130 IMEIs (imei.js), ONBOARDS them into the device registry
// (provision.js), then each simulated unit does the REAL Teltonika IMEI handshake
// against the ingestion server and streams position + ignition records — the full
// lifecycle a physical unit goes through: manufacture → platform onboarding →
// TCP connect + handshake → stream Codec 8/8E → durable, tenant-scoped writes.
//
// Two run modes (chosen for production-quality coverage — both the zero-setup
// path and the real-topology path):
//
//   memory (default)  one process, in-memory store injected with the fleet. Zero
//                     setup — no Docker, no install. `npm run sim:fleet`.
//   pg (--pg)         the production shape: emit idempotent provisioning SQL and
//                     apply it, run the ingestion server as its OWN OS process
//                     against a shared Postgres (the ECS+RDS topology), and have
//                     this process act as the fleet of devices over real TCP.
//                     Needs `npm install` + Docker (`db:up`, `db:reset`) first.
//
// What every run proves, by construction:
//   • a generated IMEI that WAS provisioned handshakes 0x01 and its records land;
//   • a generated IMEI that was NOT provisioned is rejected 0x00 (registry gate);
//   • the fleet is owner-tenant-only (no assignment) → position + ignition only,
//     NO engine data (invariant 9), all attributed to Dozr (invariant 7);
//   • a resent packet stores nothing new (invariant 2), still ACKs (invariant 1).
//
// Nothing here touches billing, the ledger, messaging, or tenancy code, adds a
// dependency, or introduces an env var — it composes the existing, tested pieces.
// ─────────────────────────────────────────────────────────────────────────────

import net from 'node:net';
import { spawn } from 'node:child_process';
import { config, IO } from '../config.js';
import { makeStore } from '../store/index.js';
import { createIngestionServer } from '../ingestion/server.js';
import { SimDevice } from './device.js';
import { buildIo } from './scenarios.js';
import { TENANTS } from '../store/seed-data.js';
import { generateFleet, makeImei, FMC130_TAC, DEFAULT_SERIAL_BASE } from './imei.js';
import { provisionFleet, provisioningSql } from './provision.js';
import { silentLogger } from '../logging/logger.js';
import { isEntrypoint } from '../lifecycle/shutdown.js';

const DEFAULTS = {
  count: 5,
  records: 6,
  serialStart: DEFAULT_SERIAL_BASE,
  codec: '8E',
  port: 5127, // pg-mode ingestion port (own process); avoids the default 5027
};

const line = () => console.log('─'.repeat(70));

// ── Argument parsing (no dependency; mirrors run-simulator.js conventions) ─────
export function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--pg') out.pg = true;
    else if (a === '--count') out.count = Number(argv[++i]);
    else if (a.startsWith('--count=')) out.count = Number(a.slice('--count='.length));
    else if (a === '--records') out.records = Number(argv[++i]);
    else if (a.startsWith('--records=')) out.records = Number(a.slice('--records='.length));
    else if (a === '--serial-start') out.serialStart = Number(argv[++i]);
    else if (a.startsWith('--serial-start=')) out.serialStart = Number(a.slice('--serial-start='.length));
    else if (a === '--codec') out.codec = argv[++i];
    else if (a.startsWith('--codec=')) out.codec = a.slice('--codec='.length);
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length));
  }
  return out;
}

function printHelp() {
  console.log(`
run-fleet — unique-IMEI full-process fleet simulation

  node src/simulator/run-fleet.js [flags]      (or: npm run sim:fleet -- [flags])

Flags:
  --count N          number of devices to mint + provision   (default ${DEFAULTS.count})
  --records N        position+ignition records per device     (default ${DEFAULTS.records})
  --serial-start N   first 6-digit unit serial on TAC ${FMC130_TAC}   (default ${DEFAULTS.serialStart})
  --codec 8|8E       Codec to stream                           (default ${DEFAULTS.codec})
  --pg               Postgres multi-process mode (server runs as its own process
                     against a shared DB). Needs npm install + Docker: run
                     'npm run db:up && npm run db:reset' first.
  --port N           ingestion port for --pg mode             (default ${DEFAULTS.port})
  -h, --help         this help
`);
}

// ── One device's position + ignition track ────────────────────────────────────
// Deterministic (index-derived, no PRNG needed) and — the whole point for an
// owner-tenant-only device — POSITION + IGNITION ONLY. buildIo omits any signal
// not passed, so with no engineSeconds the engine element is genuinely ABSENT
// (invariant 3: absence, not zero; invariant 9: no CAN program → no engine data).
export function buildFleetTrack(device, { records = DEFAULTS.records, index = 0, startTsMs, stepMs = 60_000 } = {}) {
  const start = startTsMs ?? Date.parse('2025-03-03T05:00:00Z');
  const originLat = 25.10 + index * 0.008;
  const originLon = 55.15 + index * 0.008;
  const recs = [];
  for (let i = 0; i < records; i++) {
    // A believable micro-shift: key off on the first and last tick, on in between.
    const ignition = !(i === 0 || i === records - 1);
    const movement = ignition && i % 3 !== 0;
    const speed = movement ? 18 + ((i * 7 + index) % 12) : 0;
    recs.push({
      timestampMs: start + i * stepMs,
      priority: 0,
      gps: {
        lat: originLat + i * 0.00012,
        lon: originLon + i * 0.00009,
        altitude: 12,
        angle: (i * 20 + index * 15) % 360,
        // No fix while the key is off — realistic, and positionValid follows it.
        satellites: ignition ? 9 : 0,
        speed,
      },
      eventIoId: IO.IGNITION,
      // position + ignition ONLY — no engine/CAN IO is emitted at all.
      io: buildIo({ ignition, movement }),
    });
  }
  return {
    imei: device.imei,
    deviceId: device.id,
    label: `${device.imei}`,
    records: recs,
  };
}

// A serial that is guaranteed NOT in the provisioned range [serialStart, +count),
// used to mint one well-formed but UNREGISTERED IMEI the server must reject.
function unprovisionedSerial(serialStart, count) {
  const next = serialStart + count;
  if (next <= 999_999) return next;
  return Math.max(0, serialStart - 1);
}

// ── A small assertion printer shared by both modes ────────────────────────────
function makeChecker() {
  const failures = [];
  function check(ok, label, detail = '') {
    console.log(`  ${ok ? '[OK]' : '[!!]'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(label);
  }
  return { check, failures };
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY MODE — one process, injected in-memory store. Zero setup.
// ─────────────────────────────────────────────────────────────────────────────
export async function runMemory({
  count = DEFAULTS.count,
  records = DEFAULTS.records,
  serialStart = DEFAULTS.serialStart,
  codec = DEFAULTS.codec,
} = {}) {
  const imeis = generateFleet({ count, serialBase: serialStart });
  const devices = provisionFleet(imeis); // owner-tenant-only, no assignments

  // The store contains ONLY the generated fleet (assignments: []), so this run is
  // purely the fleet — the committed seed fixtures are neither used nor mutated.
  const store = await makeStore('memory', { devices, assignments: [] });
  await store.init();
  const ingest = createIngestionServer({ store, host: '127.0.0.1', port: 0, logger: silentLogger });
  const port = await ingest.listen();

  console.log(`\nFleet simulation — memory mode`);
  console.log(`  model FMC130 · TAC ${FMC130_TAC} · serials ${serialStart}..${serialStart + count - 1}`);
  console.log(`  ingestion tcp/${port} · store=${store.kind} · codec ${codec}\n`);
  console.log(`Manufacture + onboarding: minted ${count} unique IMEIs, provisioned to Dozr (owner tenant), no assignment.\n`);

  const tracks = devices.map((d, i) => buildFleetTrack(d, { records, index: i }));

  // Each unit: TCP connect → real IMEI handshake → stream its records in one packet.
  let sent = 0;
  let acked = 0;
  let handshakes = 0;
  for (const t of tracks) {
    const dev = new SimDevice({ host: '127.0.0.1', port, imei: t.imei, codec });
    await dev.connect(); // throws if the server rejects — it won't, these are registered
    handshakes++;
    const ack = await dev.send(t.records);
    dev.close();
    sent += t.records.length;
    acked += ack;
    console.log(`  ${t.label}: handshake 0x01, sent ${t.records.length}, ACK ${ack}`);
  }

  // One well-formed but UNREGISTERED IMEI must be rejected (the registry gate).
  const unprovImei = makeImei(unprovisionedSerial(serialStart, count));
  let rejected = false;
  let rejectMsg = '';
  try {
    const rogue = new SimDevice({ host: '127.0.0.1', port, imei: unprovImei, codec });
    await rogue.connect();
    rogue.close();
  } catch (e) {
    rejected = true;
    rejectMsg = e.message;
  }
  console.log(`\n  ${unprovImei} (NOT provisioned): ${rejected ? 'rejected 0x00 ✓' : 'ACCEPTED — WRONG'}`);

  // Idempotency: re-send device 0's packet — a correct server ACKs it but stores nothing new.
  const beforeDup = await store.countPositions();
  const devDup = new SimDevice({ host: '127.0.0.1', port, imei: tracks[0].imei, codec });
  await devDup.connect();
  const ackDup = await devDup.send(tracks[0].records);
  devDup.close();
  const afterDup = await store.countPositions();
  const idempotentNew = afterDup - beforeDup;

  // ── Verify against the store ──
  const stored = await store.countPositions();
  const engineReadings = await store.countEngineReadings();
  const ownerDevices = await store.getDevices(TENANTS.DOZR.id);
  const ownerPositions = await store.getPositions(TENANTS.DOZR.id, { limit: stored + 10 });
  const aPositions = await store.getPositions(TENANTS.A.id, { limit: 10 });
  const bPositions = await store.getPositions(TENANTS.B.id, { limit: 10 });

  line();
  console.log('Proof:');
  const { check, failures } = makeChecker();
  check(handshakes === count, `all ${count} provisioned devices handshook 0x01`, `${handshakes}/${count}`);
  check(acked === sent, 'every record was ACKed (invariant 1: ACK after durable write)', `ACK ${acked}/${sent}`);
  check(stored === sent, 'all records durably stored, none lost', `${stored} stored`);
  check(rejected, 'the unprovisioned IMEI was rejected (registry gate)', rejectMsg || 'rejected');
  check(idempotentNew === 0, 'resent packet stored 0 new (invariant 2: idempotent ingest)', `ACK ${ackDup}, ${idempotentNew} new`);
  check(engineReadings === 0, 'NO engine data produced (invariant 9: no CAN program)', `${engineReadings} engine readings`);
  check(ownerDevices.length === count, 'the whole fleet is visible to its owner tenant (Dozr)', `${ownerDevices.length}/${count}`);
  check(ownerPositions.length === sent, 'every position is attributed to the owner tenant (invariant 7)', `${ownerPositions.length}/${sent}`);
  check(aPositions.length === 0 && bPositions.length === 0, 'no records leak to contractor tenants A or B', `A=${aPositions.length}, B=${bPositions.length}`);
  line();

  await ingest.close();
  await store.close();

  const summary = {
    mode: 'memory',
    count,
    records,
    sent,
    acked,
    stored,
    handshakes,
    engineReadings,
    ownerDevices: ownerDevices.length,
    ownerPositions: ownerPositions.length,
    contractorPositions: aPositions.length + bPositions.length,
    rejectedUnprovisioned: rejected,
    idempotentNew,
    ok: failures.length === 0,
  };
  console.log(summary.ok ? 'RESULT: all checks passed.\n' : `RESULT: ${failures.length} check(s) FAILED.\n`);
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// POSTGRES MULTI-PROCESS MODE — server runs as its OWN process against shared pg.
// ─────────────────────────────────────────────────────────────────────────────
function waitForPort(port, host = '127.0.0.1', timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect({ port, host });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} not up within ${timeoutMs}ms`));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

function onceExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function countRows(client) {
  const pos = await client.query('SELECT count(*)::int AS n FROM position_records');
  const eng = await client.query('SELECT count(*)::int AS n FROM engine_readings');
  return { positions: pos.rows[0].n, engine: eng.rows[0].n };
}

export async function runPg({
  count = DEFAULTS.count,
  records = DEFAULTS.records,
  serialStart = DEFAULTS.serialStart,
  codec = DEFAULTS.codec,
  port = DEFAULTS.port,
} = {}) {
  let pgMod;
  try {
    pgMod = (await import('pg')).default;
  } catch {
    console.error('\npg is not installed. Postgres mode needs it: run `npm install` first.\n');
    process.exitCode = 1;
    return { mode: 'pg', ok: false, reason: 'pg-not-installed' };
  }

  const imeis = generateFleet({ count, serialBase: serialStart });
  const devices = provisionFleet(imeis);
  const sql = provisioningSql(devices);
  const redactedUrl = config.databaseUrl.replace(/:\/\/([^:@/]+):[^@/]+@/, '://$1:***@');

  const client = new pgMod.Client({ connectionString: config.databaseUrl });
  try {
    await client.connect();
  } catch (e) {
    console.error(`\ncould not connect to Postgres at ${redactedUrl}`);
    console.error(`  ${e.message}`);
    console.error('  Is Docker up and the schema applied? Try: npm run db:up && npm run db:reset\n');
    process.exitCode = 1;
    return { mode: 'pg', ok: false, reason: 'db-unreachable' };
  }

  console.log(`\nFleet simulation — Postgres multi-process mode`);
  console.log(`  model FMC130 · TAC ${FMC130_TAC} · serials ${serialStart}..${serialStart + count - 1}`);
  console.log(`  db=${redactedUrl} · ingestion tcp/${port} (own process) · codec ${codec}\n`);

  let child;
  try {
    const base = await countRows(client);

    // ── Platform onboarding: apply the idempotent provisioning SQL ──
    console.log('Onboarding — applying idempotent provisioning SQL to the registry:\n');
    console.log(sql);
    await client.query(sql);
    const reg = await client.query('SELECT count(*)::int AS n FROM devices WHERE imei = ANY($1)', [imeis]);

    // ── Start the ingestion server as its OWN OS process (ECS shape) ──
    child = spawn(process.execPath, ['src/ingestion/server.js'], {
      cwd: config.root,
      env: { ...process.env, DB: 'pg', INGEST_HOST: '127.0.0.1', INGEST_PORT: String(port), LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let childErr = '';
    child.stderr.on('data', (d) => (childErr += d.toString()));

    try {
      await waitForPort(port);
    } catch (e) {
      console.error(`\ningestion server did not come up: ${e.message}`);
      if (childErr) console.error(childErr);
      throw e;
    }
    console.log('Ingestion server process is up. Devices connecting over real TCP...\n');

    // ── Each unit dials in over TCP and streams (this process = the fleet) ──
    const tracks = devices.map((d, i) => buildFleetTrack(d, { records, index: i }));
    let sent = 0;
    let acked = 0;
    let handshakes = 0;
    for (const t of tracks) {
      const dev = new SimDevice({ host: '127.0.0.1', port, imei: t.imei, codec });
      await dev.connect();
      handshakes++;
      const ack = await dev.send(t.records);
      dev.close();
      sent += t.records.length;
      acked += ack;
      console.log(`  ${t.label}: handshake 0x01, sent ${t.records.length}, ACK ${ack}`);
    }

    const unprovImei = makeImei(unprovisionedSerial(serialStart, count));
    let rejected = false;
    let rejectMsg = '';
    try {
      const rogue = new SimDevice({ host: '127.0.0.1', port, imei: unprovImei, codec });
      await rogue.connect();
      rogue.close();
    } catch (e) {
      rejected = true;
      rejectMsg = e.message;
    }
    console.log(`\n  ${unprovImei} (NOT provisioned): ${rejected ? 'rejected 0x00 ✓' : 'ACCEPTED — WRONG'}`);

    // ── Verify at the DB (deltas, robust to any pre-existing rows) ──
    const after = await countRows(client);
    const posDelta = after.positions - base.positions;
    const engDelta = after.engine - base.engine;
    const attribution = await client.query(
      'SELECT tenant_id::text AS t, count(*)::int AS n FROM position_records WHERE device_id = ANY($1) GROUP BY tenant_id',
      [devices.map((d) => d.id)],
    );
    const attrRows = attribution.rows;
    const ownerRow = attrRows.find((r) => r.t === TENANTS.DOZR.id);
    const nonOwnerRows = attrRows.filter((r) => r.t !== TENANTS.DOZR.id);

    line();
    console.log('Proof (at the database):');
    const { check, failures } = makeChecker();
    check(reg.rows[0].n === count, `all ${count} devices registered in the pg registry`, `${reg.rows[0].n}/${count}`);
    check(handshakes === count, `all ${count} provisioned devices handshook 0x01`, `${handshakes}/${count}`);
    check(acked === sent, 'every record was ACKed (invariant 1)', `ACK ${acked}/${sent}`);
    check(posDelta === sent, 'the run added exactly the sent records to position_records', `+${posDelta}`);
    check(rejected, 'the unprovisioned IMEI was rejected (registry gate)', rejectMsg || 'rejected');
    check(engDelta === 0, 'the run added NO engine_readings (invariant 9)', `+${engDelta}`);
    check(!!ownerRow && ownerRow.n === sent, 'all fleet records attributed to Dozr (invariant 7)', ownerRow ? `${ownerRow.n} rows` : 'none');
    check(nonOwnerRows.length === 0, 'no fleet records attributed to any other tenant', nonOwnerRows.map((r) => `${r.t}:${r.n}`).join(', ') || 'none');
    line();

    const summary = {
      mode: 'pg',
      count,
      records,
      sent,
      acked,
      registered: reg.rows[0].n,
      handshakes,
      positionsDelta: posDelta,
      engineDelta: engDelta,
      ownerAttributed: ownerRow ? ownerRow.n : 0,
      otherTenantRows: nonOwnerRows.reduce((a, r) => a + r.n, 0),
      rejectedUnprovisioned: rejected,
      ok: failures.length === 0,
    };
    console.log(summary.ok ? 'RESULT: all checks passed.\n' : `RESULT: ${failures.length} check(s) FAILED.\n`);
    return summary;
  } catch (e) {
    console.error(`\nPostgres run failed: ${e.message}`);
    console.error('  If tables are missing, apply the schema+seed: npm run db:reset\n');
    process.exitCode = 1;
    return { mode: 'pg', ok: false, reason: e.message };
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await onceExit(child);
    }
    await client.end();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const opts = {
    count: args.count ?? DEFAULTS.count,
    records: args.records ?? DEFAULTS.records,
    serialStart: args.serialStart ?? DEFAULTS.serialStart,
    codec: (args.codec ?? DEFAULTS.codec).toUpperCase(),
    port: args.port ?? DEFAULTS.port,
  };
  const summary = args.pg ? await runPg(opts) : await runMemory(opts);
  if (!summary || summary.ok === false) process.exitCode = 1;
}

if (isEntrypoint(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
