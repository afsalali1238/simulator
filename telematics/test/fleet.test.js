// ─────────────────────────────────────────────────────────────────────────────
// test/fleet.test.js — the unique-IMEI full-process fleet simulation, proved over
// a REAL TCP socket into the ingestion server, and the runMemory orchestrator
// end-to-end. This is where the generated identities (imei.js) and onboarding
// (provision.js) meet the wire and the invariants:
//   • a PROVISIONED generated IMEI handshakes 0x01 and its records persist;
//   • an UNPROVISIONED but well-formed generated IMEI is rejected (registry gate);
//   • the owner-tenant-only fleet is position + ignition ONLY — no engine data
//     (invariant 9) — and every record is attributed to the owner, none leak
//     (invariant 7);
//   • a resent packet is idempotent (invariant 2);
//   • provisionFleet refuses a bad-Luhn IMEI before it can enter the registry.
//   run: npm run test:fleet
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory-store.js';
import { createIngestionServer } from '../src/ingestion/server.js';
import { SimDevice } from '../src/simulator/device.js';
import { buildIo } from '../src/simulator/scenarios.js';
import { IO } from '../src/config.js';
import { TENANTS } from '../src/store/seed-data.js';
import { generateFleet, makeImei } from '../src/simulator/imei.js';
import { provisionFleet } from '../src/simulator/provision.js';
import { runMemory } from '../src/simulator/run-fleet.js';

const quiet = { info() {}, warn() {}, error() {} };

// A small position + ignition track (no engineSeconds → buildIo omits engine IO,
// so the packet carries NO engine data — the owner-tenant-only shape).
function track(n, startTsMs = Date.parse('2025-03-03T05:00:00Z')) {
  const recs = [];
  for (let i = 0; i < n; i++) {
    const ignition = i % 2 === 0;
    recs.push({
      timestampMs: startTsMs + i * 60_000,
      priority: 0,
      gps: { lat: 25.1 + i * 0.001, lon: 55.2 + i * 0.001, altitude: 10, angle: 0, satellites: ignition ? 8 : 0, speed: 0 },
      eventIoId: IO.IGNITION,
      io: buildIo({ ignition, movement: false }),
    });
  }
  return recs;
}

async function startServer(store) {
  const server = createIngestionServer({ store, host: '127.0.0.1', port: 0, logger: quiet });
  const port = await server.listen();
  return { server, port };
}

// Build + provision a fleet into a fresh memory store (owner-tenant-only, no
// assignments) — exactly what run-fleet does, so the tests exercise the real
// wiring rather than a bespoke fixture.
async function provisionedStore(count, serialBase = 1) {
  const imeis = generateFleet({ count, serialBase });
  const devices = provisionFleet(imeis);
  const store = createMemoryStore({ devices, assignments: [] });
  await store.init();
  return { store, imeis, devices };
}

test('fleet: a provisioned generated IMEI handshakes 0x01 and its records persist', async () => {
  const { store, imeis } = await provisionedStore(1);
  const { server, port } = await startServer(store);

  const dev = new SimDevice({ host: '127.0.0.1', port, imei: imeis[0], codec: '8E' });
  await dev.connect(); // resolves only on 0x01
  const ack = await dev.send(track(4));
  assert.equal(ack, 4);
  assert.equal(await store.countPositions(), 4);
  dev.close();
  await server.close();
});

test('fleet: an unprovisioned but well-formed generated IMEI is rejected (registry gate)', async () => {
  const { store } = await provisionedStore(2, 1); // provisions serials 1,2
  const { server, port } = await startServer(store);

  // A perfectly valid FMC130 IMEI that was simply never onboarded.
  const rogue = makeImei(90_000);
  const dev = new SimDevice({ host: '127.0.0.1', port, imei: rogue, codec: '8E' });
  await assert.rejects(() => dev.connect(), /rejected/);
  assert.equal(await store.countPositions(), 0);
  await server.close();
});

test('fleet: the owner-tenant-only fleet produces NO engine data (invariant 9)', async () => {
  const { store, imeis } = await provisionedStore(3);
  const { server, port } = await startServer(store);

  for (const imei of imeis) {
    const dev = new SimDevice({ host: '127.0.0.1', port, imei, codec: '8E' });
    await dev.connect();
    await dev.send(track(5));
    dev.close();
  }
  assert.equal(await store.countPositions(), 15);
  assert.equal(await store.countEngineReadings(), 0); // no CAN program ⇒ no engine hours
  await server.close();
});

test('fleet: every record is attributed to the owner tenant, none leak to A or B (invariant 7)', async () => {
  const { store, imeis } = await provisionedStore(3);
  const { server, port } = await startServer(store);

  let sent = 0;
  for (const imei of imeis) {
    const dev = new SimDevice({ host: '127.0.0.1', port, imei, codec: '8E' });
    await dev.connect();
    sent += await dev.send(track(4));
    dev.close();
  }
  const owner = await store.getPositions(TENANTS.DOZR.id, { limit: 1000 });
  const a = await store.getPositions(TENANTS.A.id, { limit: 1000 });
  const b = await store.getPositions(TENANTS.B.id, { limit: 1000 });
  assert.equal(sent, 12);
  assert.equal(owner.length, 12); // all to the owner tenant
  assert.equal(a.length, 0);
  assert.equal(b.length, 0);
  await server.close();
});

test('fleet: the whole provisioned fleet is visible to its owner tenant', async () => {
  const { store, imeis } = await provisionedStore(4);
  const { server, port } = await startServer(store);
  for (const imei of imeis) {
    const dev = new SimDevice({ host: '127.0.0.1', port, imei, codec: '8E' });
    await dev.connect();
    await dev.send(track(2));
    dev.close();
  }
  const devices = await store.getDevices(TENANTS.DOZR.id);
  assert.equal(devices.length, 4);
  await server.close();
});

test('fleet: a resent fleet packet is idempotent end-to-end (invariant 2)', async () => {
  const { store, imeis } = await provisionedStore(1);
  const { server, port } = await startServer(store);

  const dev = new SimDevice({ host: '127.0.0.1', port, imei: imeis[0], codec: '8E' });
  await dev.connect();
  const recs = track(3);
  const ack1 = await dev.send(recs);
  const ack2 = await dev.send(recs); // exact resend
  assert.equal(ack1, 3);
  assert.equal(ack2, 3); // still ACK the full count
  assert.equal(await store.countPositions(), 3); // but nothing double-counted
  dev.close();
  await server.close();
});

test('fleet: provisionFleet refuses an IMEI with a bad Luhn checksum before the registry', () => {
  // The seed's hand-typed D2 IMEI is Luhn-invalid — onboarding must refuse it so
  // a typo can never enter the allow-list.
  assert.throws(() => provisionFleet(['356307042441099']), /Luhn/);
});

test('fleet: runMemory orchestrates the full lifecycle and every check passes', async () => {
  // The orchestrator itself, end-to-end. Silence its console proof so the TAP
  // stream stays clean; assert on the returned summary instead.
  const realLog = console.log;
  console.log = () => {};
  let summary;
  try {
    summary = await runMemory({ count: 4, records: 5, serialStart: 1, codec: '8E' });
  } finally {
    console.log = realLog;
  }
  assert.equal(summary.ok, true);
  assert.equal(summary.sent, 20);
  assert.equal(summary.stored, 20);
  assert.equal(summary.acked, 20);
  assert.equal(summary.handshakes, 4);
  assert.equal(summary.engineReadings, 0); // invariant 9
  assert.equal(summary.ownerDevices, 4);
  assert.equal(summary.ownerPositions, 20); // invariant 7
  assert.equal(summary.contractorPositions, 0);
  assert.equal(summary.rejectedUnprovisioned, true); // registry gate
  assert.equal(summary.idempotentNew, 0); // invariant 2
});
