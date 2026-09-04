// ─────────────────────────────────────────────────────────────────────────────
// src/simulator/run-actros.js — one fixed, named demo unit: the Mercedes-Benz
// Actros flatbed haulage tractor (see TASKS.md Phase P2 / D1_CAN_ENGINE_HOURS.md
// §1 and src/ledger/ignition-duration.js) — FMC130, NO CAN adapter, so it can
// never produce AVL 102 and is billed on ignition-on duration instead of engine
// hours. This script exists so interns have ONE memorable, reproducible IMEI to
// point at things — including a THIRD-PARTY parser (e.g. Traccar) — rather than
// hand-rolling one.
//
// The IMEI is fixed and deterministic (imei.js: FMC130 TAC + a reserved serial),
// never regenerated, so it can be written down, shared, and typed into another
// system's device list and it will still be this same unit next time:
//   356307045000006  (Luhn-valid, TAC 35630704 / FMC130 — same product line and
//   IMEI scheme as the seed's D1, just a different, reserved serial: 500000,
//   well above any range generateFleet()/run-fleet.js allocate by default, so it
//   can never collide with a batch someone else spins up.)
//
// This is a DEMO fixture, not committed seed data: it does not touch
// src/store/seed-data.js, and the tenant/customer name for the real Actros
// haulage account is still an open decision (TASKS.md) — this device is
// provisioned to the OWNER tenant (Dozr), unassigned, exactly like the generic
// generated fleet in run-fleet.js. That is also the honest shape for a demo: an
// unassigned unit reports position + ignition only (invariant 9), which is
// already what this fleet's hardware can ever produce.
//
// Two ways to run it:
//
//   1. SELF-CONTAINED (default) — spins its own throwaway in-memory ingestion
//      server, provisions just this one device, streams a believable haulage
//      shift (startup → highway travel → a stop → shutdown), and prints a proof
//      summary. Zero setup, nothing else needs to be running.
//        npm run sim:actros
//
//   2. POINT AT AN EXTERNAL SERVER (e.g. a real Traccar instance, or our own
//      `npm run start:ingest`) — set SIM_SERVER_HOST / SIM_SERVER_PORT and this
//      script skips spinning its own server and streams straight at that target
//      instead. This is the real Teltonika wire protocol (IMEI handshake,
//      length-framed Codec 8/8E, waits for the ACK), so any correct Teltonika-
//      protocol receiver — Traccar included — should decode it with zero
//      changes on either side:
//        SIM_SERVER_HOST=127.0.0.1 SIM_SERVER_PORT=5027 npm run sim:actros
//      (Traccar's default Teltonika port is also 5027 — if it's running on the
//      same machine as our own ingestion server, change one of the two ports.)
//      Register the IMEI below in Traccar (Settings → Devices → Add, Identifier
//      = the IMEI, no protocol picker needed — Traccar auto-detects Teltonika
//      from the handshake) BEFORE running this, or Traccar will simply ignore
//      the unknown unit, same as our own registry gate would.
// ────────────────────────────────────────────────────────────────────────────

import { config } from '../config.js';
import { makeStore } from '../store/index.js';
import { createIngestionServer } from '../ingestion/server.js';
import { SimDevice } from './device.js';
import { buildFleetTrack } from './run-fleet.js';
import { makeImei } from './imei.js';
import { provisionFleet } from './provision.js';
import { silentLogger } from '../logging/logger.js';
import { isEntrypoint } from '../lifecycle/shutdown.js';

// Reserved serial (see file header): far above generateFleet()'s/run-fleet.js's
// default ranges, so this IMEI is never accidentally re-minted by anything else
// in the repo. Fixed forever — do not change this without telling everyone who
// has it written down.
export const ACTROS_SERIAL = 500000;
export const ACTROS_IMEI = makeImei(ACTROS_SERIAL);
export const ACTROS_LABEL = 'Actros flatbed trailer (demo unit)';

function printConnectionDetails({ host, port, codec }) {
  const line = '─'.repeat(70);
  console.log(`\n${line}`);
  console.log('Actros demo unit — connection details');
  console.log(line);
  console.log(`  Label     : ${ACTROS_LABEL}`);
  console.log(`  Model     : FMC130 (no CAN adapter — position + ignition only)`);
  console.log(`  IMEI      : ${ACTROS_IMEI}`);
  console.log(`  Target    : ${host}:${port}`);
  console.log(`  Codec     : ${codec}`);
  console.log(`  Protocol  : Teltonika (Codec 8/8E over TCP) — what Traccar's`);
  console.log(`              built-in "Teltonika" protocol driver expects.`);
  console.log(line);
  console.log('To point this at Traccar instead: register the IMEI above as a');
  console.log('device in Traccar first, then re-run with:');
  console.log(`  SIM_SERVER_HOST=<traccar-host> SIM_SERVER_PORT=<traccar-teltonika-port> npm run sim:actros\n`);
}

async function streamActros({ host, port, codec, records }) {
  const device = { id: 'actros-demo', imei: ACTROS_IMEI };
  const track = buildFleetTrack(device, { records, index: 0 });

  const dev = new SimDevice({ host, port, imei: ACTROS_IMEI, codec });
  console.log(`Connecting to ${host}:${port} as ${ACTROS_IMEI} ...`);
  await dev.connect();
  console.log('Handshake accepted (0x01).');

  let sent = 0;
  let acked = 0;
  const total = track.records.length;
  for (let i = 0; i < total; i++) {
    const record = track.records[i];
    // Mirrors buildFleetTrack's own logic (run-fleet.js): key off on the
    // first and last tick, on in between — printed here for visibility only,
    // not re-derived from the encoded IO (that would just duplicate the wire
    // decode this whole harness already proves elsewhere).
    const ignition = !(i === 0 || i === total - 1);
    const ack = await dev.send([record]);
    sent += 1;
    acked += ack;
    console.log(`  sent ${sent}/${total}  ignition=${ignition}  ack=${ack}`);
  }
  dev.close();
  console.log(`\nDone — ${sent} record(s) sent, ${acked} ACKed.`);
  return { sent, acked };
}

async function main() {
  const codec = config.sim.codec;
  const records = 8;

  const external = Boolean(process.env.SIM_SERVER_HOST || process.env.SIM_SERVER_PORT);

  if (external) {
    const host = config.sim.host;
    const port = config.sim.port;
    printConnectionDetails({ host, port, codec });
    await streamActros({ host, port, codec, records });
    return;
  }

  // Self-contained mode: our own throwaway in-memory server, this one device
  // provisioned to it. Nothing else needs to be running.
  const devices = provisionFleet([ACTROS_IMEI]);
  const store = await makeStore('memory', { devices, assignments: [] });
  await store.init();
  const ingest = createIngestionServer({ store, host: '127.0.0.1', port: 0, logger: silentLogger });
  const port = await ingest.listen();

  printConnectionDetails({ host: '127.0.0.1', port, codec });
  await streamActros({ host: '127.0.0.1', port, codec, records });
  await ingest.close();
}

if (isEntrypoint(import.meta.url)) {
  main().catch((e) => {
    console.error('run-actros failed:', e.message);
    process.exit(1);
  });
}
