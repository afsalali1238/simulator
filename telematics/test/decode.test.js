// ─────────────────────────────────────────────────────────────────────────────
// test/decode.test.js — Module 2 (Decode/normalise). Pure-function tests, no I/O.
// Proves the correctness invariants that live in normalizeRecord:
//   3 NULL≠zero · 4 ecu never merged with estimated · 6 attribution · 9 unlisted
//   run: npm run test:decode
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecord, ioValue } from '../src/decode/normalize.js';
import { IO } from '../src/config.js';
import { DEVICES, TENANTS, ASSETS } from '../src/store/seed-data.js';

const device = DEVICES[0];

function decoded(io, over = {}) {
  return {
    timestampMs: Date.parse('2025-03-01T06:00:00Z'),
    priority: 0,
    gps: { lat: 25.2, lon: 55.2, speed: 0, angle: 0, altitude: 5, satellites: 9 },
    io,
    ...over,
  };
}

// assignment shape as returned by store.resolveAssignment()
const canAssign = {
  assignmentId: 'x',
  assetId: ASSETS[0].id, // Excavator X
  tenantId: TENANTS.A.id,
  hasEngineData: true,
  programNumber: 'CAT-320-2021',
};
const noCanAssign = {
  assignmentId: 'y',
  assetId: ASSETS[1].id, // Generator Y
  tenantId: TENANTS.B.id,
  hasEngineData: false,
  programNumber: null,
};

test('decode: an absent IO becomes null, never 0 (invariant 3)', () => {
  const rec = normalizeRecord(decoded([]), { device, assignment: null });
  assert.equal(rec.ignition, null);
  assert.equal(rec.movement, null);
});

test('decode: a present-but-zero ignition is false — a real reading, not missing (invariant 3)', () => {
  const rec = normalizeRecord(decoded([{ id: IO.IGNITION, size: 1, value: 0 }]), {
    device,
    assignment: null,
  });
  assert.equal(rec.ignition, false); // NOT null
});

test('decode: engine hours only for CAN-supported assets, always source "ecu" (invariants 9, 4)', () => {
  const io = [{ id: IO.ENGINE_HOURS_S, size: 4, value: 7200 }];

  const withCan = normalizeRecord(decoded(io), { device, assignment: canAssign });
  assert.deepEqual(withCan.engine, { seconds: 7200, hours: 2, source: 'ecu' });

  // Identical bytes, but the asset has no CAN program -> no engine hours at all.
  const noCan = normalizeRecord(decoded(io), { device, assignment: noCanAssign });
  assert.equal(noCan.engine, null);
});

test('decode: attribution uses the assignment, falling back to the owner tenant (invariants 6, 7)', () => {
  const unassigned = normalizeRecord(decoded([]), { device, assignment: null });
  assert.equal(unassigned.tenantId, device.ownerTenantId);
  assert.equal(unassigned.assetId, null);

  const assigned = normalizeRecord(decoded([]), { device, assignment: canAssign });
  assert.equal(assigned.tenantId, TENANTS.A.id);
  assert.equal(assigned.assetId, ASSETS[0].id);
});

test('decode: state is derived from ignition/movement/speed', () => {
  const off = normalizeRecord(decoded([{ id: IO.IGNITION, size: 1, value: 0 }]), {
    device,
    assignment: null,
  });
  assert.equal(off.state, 'off');

  const moving = normalizeRecord(
    decoded([
      { id: IO.IGNITION, size: 1, value: 1 },
      { id: IO.MOVEMENT, size: 1, value: 1 },
    ]),
    { device, assignment: null },
  );
  assert.equal(moving.state, 'moving');

  const idle = normalizeRecord(
    decoded([
      { id: IO.IGNITION, size: 1, value: 1 },
      { id: IO.MOVEMENT, size: 1, value: 0 },
    ]),
    { device, assignment: null },
  );
  assert.equal(idle.state, 'idle');

  const unknown = normalizeRecord(decoded([]), { device, assignment: null });
  assert.equal(unknown.state, 'unknown');
});

test('decode: ioValue returns undefined for an absent element, the value when present', () => {
  assert.equal(ioValue(decoded([]), IO.IGNITION), undefined);
  assert.equal(
    ioValue(decoded([{ id: IO.IGNITION, size: 1, value: 1 }]), IO.IGNITION),
    1,
  );
});
