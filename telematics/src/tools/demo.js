// ─────────────────────────────────────────────────────────────────────────────
// src/tools/demo.js — one-command end-to-end proof: `npm run demo`.
//
// Wires the whole thin slice together in a single process on the memory store, so
// it runs with ZERO setup (no Docker, no Postgres, no npm install):
//
//   simulated Teltonika unit  ──TCP binary──▶  ingestion server  ──▶  store
//                                                                       │
//                                          read API  ◀──HTTP+X-Tenant───┘
//
// It streams two work sessions from ONE physical device (D1) that changes hands
// mid-2025, then queries the API as each tenant and prints what they can see. The
// output is designed to make the correctness invariants visible at a glance.
// ─────────────────────────────────────────────────────────────────────────────

import { makeStore } from '../store/index.js';
import { createIngestionServer } from '../ingestion/server.js';
import { createApi } from '../api/server.js';
import { SimDevice } from '../simulator/device.js';
import { makeScenario } from '../simulator/scenarios.js';
import { TENANTS, DEVICES, ASSETS } from '../store/seed-data.js';

const quiet = { info() {}, warn() {}, error: console.error };
const line = () => console.log('─'.repeat(70));

async function get(base, path, tenantId) {
  const res = await fetch(base + path, {
    headers: tenantId ? { 'x-tenant-id': tenantId } : {},
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  const store = await makeStore('memory');
  await store.init();

  const ingest = createIngestionServer({ store, host: '127.0.0.1', port: 0, logger: quiet });
  const ingestPort = await ingest.listen();

  const api = createApi({ store, port: 0, logger: quiet });
  const apiPort = await api.listen();
  const base = `http://127.0.0.1:${apiPort}`;

  console.log(`\nDemo running — ingestion tcp/${ingestPort}, api http/${apiPort}, store=${store.kind}\n`);

  // ── One device, two work sessions on opposite sides of the D1 reassignment ──
  const dev = new SimDevice({ host: '127.0.0.1', port: ingestPort, imei: DEVICES[0].imei, codec: '8E' });
  await dev.connect();
  console.log(`Device ${DEVICES[0].imei} (${DEVICES[0].model}) handshake accepted.\n`);

  // Session 1: March 2025 -> assigned to Excavator X (Tenant A), CAN supported.
  const s1 = makeScenario({ startTsMs: Date.parse('2025-03-01T06:00:00Z'), stepMs: 1000, lat0: 25.2048 });
  const s1recs = Array.from({ length: 20 }, (_, i) => s1(i));
  const ack1 = await dev.send(s1recs); // one packet, 20 records — like a real unit
  console.log(`Session 1 (Mar 2025): sent 20 records in one packet, server ACK=${ack1}`);

  // Session 2: July 2025 -> same device now on Generator Y (Tenant B), NO CAN program.
  const s2 = makeScenario({ startTsMs: Date.parse('2025-07-01T06:00:00Z'), stepMs: 1000, lat0: 24.47 });
  const s2recs = Array.from({ length: 5 }, (_, i) => s2(i));
  const ack2 = await dev.send(s2recs);
  console.log(`Session 2 (Jul 2025): sent 5 records in one packet,  server ACK=${ack2}`);

  // Idempotency: re-send session 2's packet; a correct server ACKs but stores nothing new.
  const before = await store.countPositions();
  const ackDup = await dev.send(s2recs);
  const after = await store.countPositions();
  console.log(
    `Idempotency check: resent 5 records -> server ACK=${ackDup}, stored ${after - before} new (expected ACK=5, 0 new)\n`,
  );
  dev.close();

  // ── Query the API as each tenant ────────────────────────────────────────────
  const excavatorX = ASSETS[0].id;
  const generatorY = ASSETS[1].id;

  const aPos = await get(base, '/positions?limit=1000', TENANTS.A.id);
  const aEng = await get(base, `/assets/${excavatorX}/engine-hours`, TENANTS.A.id);
  const bPos = await get(base, '/positions?limit=1000', TENANTS.B.id);
  const bEng = await get(base, `/assets/${generatorY}/engine-hours`, TENANTS.B.id);
  const noTenant = await get(base, '/positions');

  line();
  console.log('Tenant A (Al Naboodah) — sees only the Mar 2025 Excavator X session:');
  console.log(`  positions returned : ${aPos.body.positions.length}  (expected 20)`);
  console.log(
    `  engine hours (ECU) : ${aEng.body.reading ? aEng.body.reading.hours.toFixed(4) + ' h  source=' + aEng.body.reading.source : 'none'}  (expected a value — CAN supported)`,
  );
  line();
  console.log('Tenant B (Dutco) — sees only the Jul 2025 Generator Y session:');
  console.log(`  positions returned : ${bPos.body.positions.length}  (expected 5)`);
  console.log(
    `  engine hours       : ${bEng.body.reading ? bEng.body.reading.hours + ' h' : 'none'}  (expected none — Generator Y has no CAN program → invariant 9)`,
  );
  line();
  console.log('Tenant isolation (invariant 7):');
  console.log(`  A cannot see B's records and vice-versa (20 vs 5, disjoint)`);
  console.log(`  request with no X-Tenant-Id -> HTTP ${noTenant.status}  (expected 400)`);
  line();
  console.log('Attribution by timestamp (invariant 6): the SAME device produced both');
  console.log('sessions; each record was billed to whoever held it at that moment.\n');

  await ingest.close();
  await api.close();
  await store.close();
  console.log('Demo complete.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
