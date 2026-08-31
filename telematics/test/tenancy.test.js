// ─────────────────────────────────────────────────────────────────────────────
// test/tenancy.test.js — the attribution + isolation story, integrated across the
// store's resolveAssignment and the decoder. Uses the real seed timeline where
// device D1 changes hands mid-2025.
//   invariant 6 (attribution at each record's own timestamp)
//   invariant 7 (tenant isolation) · invariant 9 (unlisted machine -> no engine)
//   run: npm run test:tenancy
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory-store.js';
import { normalizeRecord } from '../src/decode/normalize.js';
import { DEVICES, TENANTS, ASSETS } from '../src/store/seed-data.js';

const device = DEVICES[0]; // D1: Tenant A (Jan–Jun 2025), then Tenant B (Jun 2025→)

function decodedAt(tsMs) {
  return {
    timestampMs: tsMs,
    priority: 0,
    gps: { lat: 25, lon: 55, speed: 5, angle: 0, altitude: 0, satellites: 9 },
    io: [
      { id: 239, size: 1, value: 1 }, // ignition on
      { id: 200, size: 4, value: 7200 }, // engine-on seconds (only counts if asset has CAN)
    ],
  };
}

test('tenancy: the same device attributes to different tenants by record timestamp (invariant 6)', async () => {
  const store = createMemoryStore();
  await store.init();

  const tMarch = Date.parse('2025-03-01T06:00:00Z'); // -> Tenant A / Excavator X (CAN)
  const tJuly = Date.parse('2025-07-01T06:00:00Z'); // -> Tenant B / Generator Y (no CAN)

  const aAssign = await store.resolveAssignment(device.id, tMarch);
  const bAssign = await store.resolveAssignment(device.id, tJuly);
  assert.equal(aAssign.tenantId, TENANTS.A.id);
  assert.equal(aAssign.assetId, ASSETS[0].id);
  assert.equal(bAssign.tenantId, TENANTS.B.id);
  assert.equal(bAssign.assetId, ASSETS[1].id);

  const aRec = normalizeRecord(decodedAt(tMarch), { device, assignment: aAssign });
  const bRec = normalizeRecord(decodedAt(tJuly), { device, assignment: bAssign });
  await store.persistPacket({
    device,
    imei: device.imei,
    codecId: 0x8e,
    rawFrame: Buffer.from([0]),
    canonical: [aRec, bRec],
  });

  // invariant 7: each tenant sees ONLY its own record
  const aPos = await store.getPositions(TENANTS.A.id, { limit: 100 });
  const bPos = await store.getPositions(TENANTS.B.id, { limit: 100 });
  assert.equal(aPos.length, 1);
  assert.equal(bPos.length, 1);
  assert.equal(aPos[0].tsMs, tMarch);
  assert.equal(bPos[0].tsMs, tJuly);

  // invariant 9: identical ignition+engine bytes, but only the CAN-supported
  // Excavator X yields engine hours; the Generator Y does not.
  assert.ok(await store.getLatestEngineHours(TENANTS.A.id, ASSETS[0].id));
  assert.equal(await store.getLatestEngineHours(TENANTS.B.id, ASSETS[1].id), null);
});

test('tenancy: an unassigned device is scoped to its owner tenant, position+ignition only (invariants 7, 9)', async () => {
  const store = createMemoryStore();
  await store.init();
  const d2 = DEVICES[1]; // no assignment row anywhere in the seed

  const ts = Date.parse('2025-03-01T06:00:00Z');
  const assignment = await store.resolveAssignment(d2.id, ts);
  assert.equal(assignment, null);

  const rec = normalizeRecord(decodedAt(ts), { device: d2, assignment });
  assert.equal(rec.tenantId, d2.ownerTenantId); // Dozr's yard
  assert.equal(rec.assetId, null);
  assert.equal(rec.engine, null); // no asset -> no CAN -> no engine hours

  await store.persistPacket({
    device: d2,
    imei: d2.imei,
    codecId: 0x8e,
    rawFrame: Buffer.from([0]),
    canonical: [rec],
  });
  const owner = await store.getPositions(d2.ownerTenantId, { limit: 100 });
  assert.equal(owner.length, 1);
  // a contractor tenant sees nothing for this yard device
  assert.equal((await store.getPositions(TENANTS.A.id, { limit: 100 })).length, 0);
});
