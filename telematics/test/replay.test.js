// ─────────────────────────────────────────────────────────────────────────────
// test/replay.test.js — the scenario engine driven through the REAL pipeline.
//
// test/scenarios.test.js checks the generated records in isolation (pure, fast).
// This suite puts them on the wire: simulated device → genuine Codec 8E bytes →
// ingestion server → store → read API, exactly as a physical FMC130 would. It is
// the end-to-end proof the handoff asks for, and the one that makes invariant 6
// demonstrable rather than asserted:
//
//   • replaying `handover` from ONE device lands records either side of
//     2025-06-01T00:00:00Z, and each tenant's API sees only its own side
//   • Tenant A (Excavator X, CAN) gets ECU engine hours; Tenant B (Generator Y,
//     no CAN program) gets none — from identical wire data (invariant 9)
//   • replaying `yard-idle` scopes an unassigned device to its owner tenant with
//     position + ignition only
//   • a replay is idempotent: send a track twice, nothing double-counts
//
//   run: npm run test:replay
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory-store.js';
import { createIngestionServer } from '../src/ingestion/server.js';
import { createApi } from '../src/api/server.js';
import { SimDevice } from '../src/simulator/device.js';
import { buildScenario, HANDOVER_TS_MS } from '../src/simulator/scenarios.js';
import { DEVICES, ASSETS, TENANTS } from '../src/store/seed-data.js';

const quiet = { info() {}, warn() {}, error() {} };

// Bring up the whole slice on ephemeral ports, memory store, no logging.
async function harness() {
  const store = createMemoryStore();
  await store.init();
  const ingest = createIngestionServer({ store, host: '127.0.0.1', port: 0, logger: quiet });
  const ingestPort = await ingest.listen();
  const api = createApi({ store, port: 0, logger: quiet });
  const apiPort = await api.listen();
  return {
    store,
    ingest,
    api,
    base: `http://127.0.0.1:${apiPort}`,
    ingestPort,
    async stop() {
      await ingest.close();
      await api.close();
      await store.close();
    },
  };
}

// Replay one track as a real device would: connect, send its records in a single
// packet (a unit batches its buffer), wait for the ACK, disconnect.
async function replay(track, ingestPort, codec = '8E') {
  const dev = new SimDevice({ host: '127.0.0.1', port: ingestPort, imei: track.imei, codec });
  await dev.connect();
  const ack = await dev.send(track.records);
  dev.close();
  return ack;
}

const getJson = async (base, path, tenantId) => {
  const res = await fetch(base + path, { headers: tenantId ? { 'x-tenant-id': tenantId } : {} });
  return { status: res.status, body: await res.json() };
};

test('replay: the handover scenario splits one device between two tenants at the boundary (invariant 6)', async () => {
  const h = await harness();
  const built = buildScenario('handover');
  assert.equal(built.tracks.length, 2);

  // Both tracks are the same IMEI reconnecting — what a real handover looks like.
  let sent = 0;
  for (const track of built.tracks) {
    const ack = await replay(track, h.ingestPort);
    assert.equal(ack, track.records.length, `${track.label}: ACK should equal the record count`);
    sent += track.records.length;
  }
  assert.equal(await h.store.countPositions(), sent);

  const a = await getJson(h.base, '/positions?limit=1000', TENANTS.A.id);
  const b = await getJson(h.base, '/positions?limit=1000', TENANTS.B.id);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  // Neither tenant sees an empty set, and together they account for everything.
  assert.ok(a.body.positions.length > 0, 'Tenant A saw nothing');
  assert.ok(b.body.positions.length > 0, 'Tenant B saw nothing');
  assert.equal(a.body.positions.length + b.body.positions.length, sent);

  // The split is by TIMESTAMP, not by connection: everything Tenant A can see
  // predates the handover instant, everything Tenant B can see follows it.
  for (const p of a.body.positions) {
    assert.ok(p.tsMs < HANDOVER_TS_MS, `Tenant A saw a post-handover record at ${p.tsMs}`);
  }
  for (const p of b.body.positions) {
    assert.ok(p.tsMs >= HANDOVER_TS_MS, `Tenant B saw a pre-handover record at ${p.tsMs}`);
  }

  // Isolation: the two sets are disjoint, and no tenant header is rejected.
  const aKeys = new Set(a.body.positions.map((p) => p.tsMs));
  assert.ok(!b.body.positions.some((p) => aKeys.has(p.tsMs)));
  assert.equal((await getJson(h.base, '/positions')).status, 400);

  await h.stop();
});

test('replay: identical wire data yields ECU hours for the CAN asset and none for the non-CAN asset (invariant 9)', async () => {
  const h = await harness();
  const built = buildScenario('handover');
  for (const track of built.tracks) await replay(track, h.ingestPort);

  const x = await getJson(h.base, `/assets/${ASSETS[0].id}/engine-hours`, TENANTS.A.id);
  assert.ok(x.body.reading, 'Excavator X (CAN) should have an ECU reading');
  assert.equal(x.body.reading.source, 'ecu');
  assert.ok(x.body.reading.hours > 0);

  const y = await getJson(h.base, `/assets/${ASSETS[1].id}/engine-hours`, TENANTS.B.id);
  assert.equal(y.body.reading, null, 'Generator Y has no CAN program — no engine data may exist');

  // Belt and braces: nothing in the store attributes an engine reading to
  // Tenant B or to the generator asset, even though the device sent IO 200.
  const readings = await h.store.countEngineReadings();
  assert.ok(readings > 0);
  const asB = await getJson(h.base, `/assets/${ASSETS[0].id}/engine-hours`, TENANTS.B.id);
  assert.equal(asB.body.reading, null, 'Tenant B must not read Tenant A’s engine hours');

  await h.stop();
});

test('replay: yard-idle scopes an unassigned device to its owner with position + ignition only', async () => {
  const h = await harness();
  const track = buildScenario('yard-idle').tracks[0];
  const ack = await replay(track, h.ingestPort);
  assert.equal(ack, track.records.length);

  // Owner tenant sees it; the contractor tenants do not.
  const owner = await getJson(h.base, '/positions?limit=1000', TENANTS.DOZR.id);
  assert.equal(owner.body.positions.length, track.records.length);
  for (const t of [TENANTS.A.id, TENANTS.B.id]) {
    const other = await getJson(h.base, '/positions?limit=1000', t);
    assert.equal(other.body.positions.length, 0);
  }

  // No asset, and ignition is a real reading (true/false), never invented.
  for (const p of owner.body.positions) {
    assert.equal(p.assetId, null);
    assert.equal(typeof p.ignition, 'boolean');
  }
  // No engine reading was created for anyone.
  assert.equal(await h.store.countEngineReadings(), 0);

  await h.stop();
});

test('replay: re-sending a replayed track is idempotent end-to-end (invariant 2)', async () => {
  const h = await harness();
  const track = buildScenario('day-cycle', { records: 12 }).tracks[0];

  const ack1 = await replay(track, h.ingestPort);
  const afterFirst = await h.store.countPositions();
  const framesFirst = await h.store.countRawFrames();

  const ack2 = await replay(track, h.ingestPort); // e.g. the ACK was lost
  const afterSecond = await h.store.countPositions();

  assert.equal(ack1, track.records.length);
  assert.equal(ack2, track.records.length, 'the device must still be told to clear its buffer');
  assert.equal(afterSecond, afterFirst, 'a resend must not double-count');

  // Both frames are still sealed as evidence — the raw bytes are append-only
  // (invariant 8), even when their records de-duplicated.
  assert.equal(await h.store.countRawFrames(), framesFirst + 1);

  await h.stop();
});

test('replay: a scenario also survives the older Codec 8 framing', async () => {
  const h = await harness();
  const track = buildScenario('yard-idle', { records: 5 }).tracks[0];
  const ack = await replay(track, h.ingestPort, '8');
  assert.equal(ack, 5);
  assert.equal(await h.store.countPositions(), 5);
  await h.stop();
});
