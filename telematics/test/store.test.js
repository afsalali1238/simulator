// ─────────────────────────────────────────────────────────────────────────────
// test/store.test.js — Module 3 (Data model & tenancy), memory adapter.
// Proves the store contract the pg adapter must also honour: atomic+durable
// writes (inv 1), idempotency (inv 2), tenant isolation (inv 7), latest-ECU reads.
//   run: npm run test:store
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory-store.js';
import { config } from '../src/config.js';
import { TENANTS, DEVICES, ASSETS } from '../src/store/seed-data.js';

const device = DEVICES[0];
const tenantA = TENANTS.A.id;
const tenantB = TENANTS.B.id;
const assetX = ASSETS[0].id;

function canonical(tsMs, over = {}) {
  return {
    deviceId: device.id,
    imei: device.imei,
    tenantId: tenantA,
    assetId: assetX,
    tsMs,
    lat: 25.2,
    lon: 55.2,
    speed: 10,
    angle: 90,
    altitude: 5,
    satellites: 9,
    priority: 0,
    ignition: true,
    movement: true,
    state: 'moving',
    engine: { seconds: 3600, hours: 1, source: 'ecu' },
    ...over,
  };
}

function persist(store, records) {
  return store.persistPacket({
    device,
    imei: device.imei,
    codecId: 0x8e,
    rawFrame: Buffer.from([1, 2, 3]),
    canonical: records,
  });
}

test('store: persistPacket inserts positions, engine readings, and one evidence frame', async () => {
  const store = createMemoryStore();
  await store.init();
  const res = await persist(store, [canonical(1000), canonical(2000)]);
  assert.equal(res.records, 2);
  assert.equal(res.inserted, 2);
  assert.equal(res.deduped, 0);
  assert.equal(await store.countPositions(), 2);
  assert.equal(await store.countEngineReadings(), 2);
  assert.equal(await store.countRawFrames(), 1); // the raw frame is the evidence root
});

test('store: idempotent on (deviceId, tsMs) — a resend double-counts nothing (invariant 2)', async () => {
  const store = createMemoryStore();
  await store.init();
  await persist(store, [canonical(1000), canonical(2000)]);
  const res = await persist(store, [canonical(2000), canonical(3000)]); // 2000 already stored
  assert.equal(res.records, 2); // still ACK the full count so the device clears its buffer
  assert.equal(res.inserted, 1); // only 3000 is genuinely new
  assert.equal(res.deduped, 1);
  assert.equal(await store.countPositions(), 3);
});

test('store: reads are tenant-scoped — one tenant cannot see another (invariant 7)', async () => {
  const store = createMemoryStore();
  await store.init();
  await persist(store, [
    canonical(1000, { tenantId: tenantA }),
    canonical(2000, { tenantId: tenantB, assetId: ASSETS[1].id, engine: null }),
  ]);
  const a = await store.getPositions(tenantA, { limit: 100 });
  const b = await store.getPositions(tenantB, { limit: 100 });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].tsMs, 1000);
  assert.equal(b[0].tsMs, 2000);
});

test('store: getLatestEngineHours returns the newest ECU reading for that tenant+asset', async () => {
  const store = createMemoryStore();
  await store.init();
  await persist(store, [
    canonical(1000, { engine: { seconds: 3600, hours: 1, source: 'ecu' } }),
    canonical(5000, { engine: { seconds: 7200, hours: 2, source: 'ecu' } }),
  ]);
  const latest = await store.getLatestEngineHours(tenantA, assetX);
  assert.equal(latest.hours, 2);
  assert.equal(latest.source, 'ecu');
  assert.equal(await store.getLatestEngineHours(tenantB, assetX), null); // wrong tenant sees nothing
});

test('store: failBeforeCommit throws and leaves the store completely unchanged (invariant 1)', async () => {
  const store = createMemoryStore();
  await store.init();
  await persist(store, [canonical(1000)]);
  config.failBeforeCommit = true;
  try {
    await assert.rejects(() => persist(store, [canonical(2000)]), /before commit/);
    assert.equal(await store.countPositions(), 1); // the failed write applied nothing
    assert.equal(await store.countRawFrames(), 1);
  } finally {
    config.failBeforeCommit = false; // never leak the hook into other tests
  }
});
