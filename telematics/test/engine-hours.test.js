// ─────────────────────────────────────────────────────────────────────────────
// test/engine-hours.test.js — D1: the CAN engine-hours mapping.
//
// This suite exists because the D1 failure modes are all SILENT. A wrong AVL ID,
// a minutes value read as seconds, or a tracker-side accumulator relabelled as an
// ECU meter each produce a plausible number that every other test in this repo
// would happily pass through to an invoice.
//
// So it pins, in order of how expensive the mistake is:
//   • the retired stand-in (AVL 200 = Sleep Mode) can NEVER yield engine hours
//   • AVL 102 is MINUTES — the 60× unit trap, asserted with exact arithmetic
//   • AVL 103 (tracker-counted) is refused, not relabelled 'ecu' (invariants 4, 5)
//   • AVL 449 (ignition-on seconds) is refused as billing evidence (invariant 5)
//   • hour-meter reconciliation catches a unit error and names it
//   • invariant 9 still gates everything: no CAN program ⇒ no engine data
//
//   run: npm run test:engine-hours
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_HOURS_SOURCES,
  FORBIDDEN_AS_BILLING_EVIDENCE,
  BILLABLE_ENGINE_HOURS_IDS,
  PROGRAM_NUMBER_ID,
  toCanonicalSeconds,
  selectEngineHours,
  explainNoEngineHours,
  reconcile,
  RECONCILE_TOLERANCE_HOURS,
} from '../src/decode/engine-hours.js';
import { normalizeRecord, engineHoursDiagnostic } from '../src/decode/normalize.js';
import { IO, RETIRED_ENGINE_HOURS_STANDIN_ID } from '../src/config.js';
import { DEVICES, TENANTS, ASSETS } from '../src/store/seed-data.js';

const device = DEVICES[0];

const canAssign = {
  assignmentId: 'x',
  assetId: ASSETS[0].id, // Excavator X — CAT 320, CAN supported
  tenantId: TENANTS.A.id,
  hasEngineData: true,
  programNumber: 'CAT-320-2021',
};
const noCanAssign = {
  assignmentId: 'y',
  assetId: ASSETS[1].id, // Generator Y — no CAN program
  tenantId: TENANTS.B.id,
  hasEngineData: false,
  programNumber: null,
};

function decoded(io) {
  return {
    timestampMs: Date.parse('2025-03-01T06:00:00Z'),
    priority: 0,
    gps: { lat: 25.2, lon: 55.2, speed: 0, angle: 0, altitude: 5, satellites: 9 },
    io,
  };
}
const el = (id, value, size = 4) => ({ id, size, value });

// ── The mapping itself ───────────────────────────────────────────────────────

test('d1: the documented FMC130 IDs are what the code uses', () => {
  // These are the values read off Teltonika's own parameter table. If someone
  // "tidies" them, this fails before a wrong number can reach an invoice.
  assert.equal(IO.ENGINE_WORKTIME_MIN, 102);
  assert.equal(IO.ENGINE_WORKTIME_COUNTED_MIN, 103);
  assert.equal(IO.CAN_PROGRAM_NUMBER, 100);
  assert.equal(PROGRAM_NUMBER_ID, 100);
  assert.equal(IO.IGNITION, 239);
  assert.equal(IO.MOVEMENT, 240);
  assert.equal(IO.GNSS_STATUS, 69);

  // Both engine counters are 4-byte and in MINUTES, per the wiki table.
  for (const id of [102, 103]) {
    assert.equal(ENGINE_HOURS_SOURCES[id].bytes, 4, `AVL ${id} width`);
    assert.equal(ENGINE_HOURS_SOURCES[id].unit, 'min', `AVL ${id} native unit`);
  }
});

test('d1: only AVL 102 — the machine’s own hour-meter — is billable', () => {
  assert.deepEqual(BILLABLE_ENGINE_HOURS_IDS, [102]);
  assert.equal(ENGINE_HOURS_SOURCES[102].billable, true);
  assert.equal(ENGINE_HOURS_SOURCES[103].billable, false);
});

test('d1: the retired AVL 200 stand-in cannot produce engine hours (200 is Sleep Mode)', () => {
  assert.equal(RETIRED_ENGINE_HOURS_STANDIN_ID, 200);
  assert.equal(ENGINE_HOURS_SOURCES[200], undefined);
  assert.equal(toCanonicalSeconds(200, 7200), null);
  assert.equal(selectEngineHours({ 200: 7200 }), null);

  // End to end: a record carrying the old stand-in, on a CAN-supported asset,
  // yields NO engine data. Previously this produced 2 billable hours.
  const rec = normalizeRecord(decoded([el(200, 7200)]), { device, assignment: canAssign });
  assert.equal(rec.engine, null);
  assert.match(engineHoursDiagnostic(decoded([el(200, 7200)]), { assignment: canAssign }), /forbidden/i);
});

// ── The unit trap ────────────────────────────────────────────────────────────

test('d1: AVL 102 is MINUTES — the 60× trap, with exact arithmetic', () => {
  // 90 minutes = 1.5 hours = 5400 seconds. If the code treated the raw value as
  // seconds it would report 0.025 h; if it treated it as hours, 90 h.
  const c = toCanonicalSeconds(102, 90);
  assert.equal(c.seconds, 5400);
  assert.equal(c.hours, 1.5);
  assert.equal(c.nativeUnit, 'min');
  assert.equal(c.sourceId, 102);

  // A full day of engine time: 1440 min = 24 h.
  assert.equal(toCanonicalSeconds(102, 1440).hours, 24);

  // Zero is a real reading (a brand-new machine), not an absence.
  assert.equal(toCanonicalSeconds(102, 0).seconds, 0);
  assert.equal(toCanonicalSeconds(102, 0).hours, 0);
});

test('d1: the decoder carries the source ID and unit onto the row for a dispute pack', () => {
  const rec = normalizeRecord(decoded([el(IO.ENGINE_WORKTIME_MIN, 6000)]), {
    device,
    assignment: canAssign,
  });
  assert.equal(rec.engine.source, 'ecu'); // invariant 4
  assert.equal(rec.engine.sourceAvlId, 102);
  assert.equal(rec.engine.nativeUnit, 'min');
  assert.equal(rec.engine.seconds, 360000); // 6000 min
  assert.equal(rec.engine.hours, 100);
});

// ── Refusals: the values that must never become evidence ─────────────────────

test('d1: AVL 103 (tracker-counted) is refused, never relabelled ecu (invariants 4, 5)', () => {
  const io = [el(IO.ENGINE_WORKTIME_COUNTED_MIN, 600)];

  // Not billable on its own — no reading at all rather than a plausible number.
  assert.equal(selectEngineHours({ 103: 600 }), null);
  const rec = normalizeRecord(decoded(io), { device, assignment: canAssign });
  assert.equal(rec.engine, null);

  // And the diagnostic says exactly why, naming what is missing.
  const why = engineHoursDiagnostic(decoded(io), { assignment: canAssign });
  assert.match(why, /non-billable/i);
  assert.match(why, /102/);
});

test('d1: when both 102 and 103 are present, 102 wins', () => {
  const picked = selectEngineHours({ 102: 100, 103: 999999 });
  assert.equal(picked.sourceId, 102);
  assert.equal(picked.hours, 100 / 60);

  const rec = normalizeRecord(
    decoded([el(IO.ENGINE_WORKTIME_COUNTED_MIN, 999999), el(IO.ENGINE_WORKTIME_MIN, 100)]),
    { device, assignment: canAssign },
  );
  assert.equal(rec.engine.sourceAvlId, 102);
});

test('d1: the ignition-on counter (AVL 449) is forbidden as billing evidence (invariant 5)', () => {
  assert.ok(FORBIDDEN_AS_BILLING_EVIDENCE[449]);
  assert.equal(IO.IGNITION_ON_COUNTER_S, 449);
  assert.match(FORBIDDEN_AS_BILLING_EVIDENCE[449].reason, /invariant 5/i);

  // It is not an engine-hours source at all, so it cannot leak in.
  assert.equal(toCanonicalSeconds(449, 36000), null);
  assert.equal(selectEngineHours({ 449: 36000 }), null);

  const io = [el(IO.IGNITION_ON_COUNTER_S, 36000), el(IO.IGNITION, 1, 1)];
  const rec = normalizeRecord(decoded(io), { device, assignment: canAssign });
  assert.equal(rec.engine, null, 'an ignition counter must never become engine hours');
  assert.match(engineHoursDiagnostic(decoded(io), { assignment: canAssign }), /forbidden/i);
});

// ── Invariant 9 still gates everything ───────────────────────────────────────

test('d1: a machine with no CAN program yields no engine hours even from AVL 102 (invariant 9)', () => {
  const io = [el(IO.ENGINE_WORKTIME_MIN, 6000)];

  const withCan = normalizeRecord(decoded(io), { device, assignment: canAssign });
  assert.equal(withCan.engine.hours, 100);

  // Identical bytes, non-CAN asset -> nothing.
  const noCan = normalizeRecord(decoded(io), { device, assignment: noCanAssign });
  assert.equal(noCan.engine, null);
  assert.match(engineHoursDiagnostic(decoded(io), { assignment: noCanAssign }), /invariant 9/);

  // Unassigned device -> owner tenant, nothing.
  const unassigned = normalizeRecord(decoded(io), { device, assignment: null });
  assert.equal(unassigned.engine, null);
  assert.equal(unassigned.tenantId, device.ownerTenantId);
  assert.match(engineHoursDiagnostic(decoded(io), { assignment: null }), /no assignment/i);
});

test('d1: an absent engine reading is null, never zero (invariant 3)', () => {
  const rec = normalizeRecord(decoded([el(IO.IGNITION, 1, 1)]), {
    device,
    assignment: canAssign,
  });
  assert.equal(rec.engine, null); // not { seconds: 0 }
  assert.match(engineHoursDiagnostic(decoded([el(IO.IGNITION, 1, 1)]), { assignment: canAssign }), /no engine-hours parameter/i);

  // A present zero, by contrast, IS a reading.
  const zero = normalizeRecord(decoded([el(IO.ENGINE_WORKTIME_MIN, 0)]), {
    device,
    assignment: canAssign,
  });
  assert.equal(zero.engine.seconds, 0);
  assert.equal(zero.engine.source, 'ecu');
});

// ── Reconciliation: what turns a reading into evidence ───────────────────────

test('d1: reconciliation accepts a reading within tolerance of the dashboard meter', () => {
  const r = reconcile(1234.4, 1234.0);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'reconciled');
  assert.ok(Math.abs(r.deltaHours) <= RECONCILE_TOLERANCE_HOURS);
});

test('d1: reconciliation names a 60× unit error instead of just failing', () => {
  // The exact mistake this whole module exists to prevent: 1200 minutes of
  // engine time reported as 1200 hours.
  const r = reconcile(1200, 20);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'unit-error');
  assert.match(r.hint, /minutes value is being read as seconds|60×/i);

  // The inverse direction too.
  const inv = reconcile(20, 1200);
  assert.equal(inv.verdict, 'unit-error');

  // And the seconds/hours confusion (3600×).
  const s = reconcile(72000, 20);
  assert.equal(s.verdict, 'unit-error');
  assert.match(s.hint, /3600/);
});

test('d1: a mismatch that is NOT a unit factor is reported as a mismatch, not guessed at', () => {
  const r = reconcile(500, 320);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'mismatch');
  assert.match(r.hint, /Do not bill/i);
});

test('d1: explainNoEngineHours distinguishes the three ways there is no reading', () => {
  assert.match(explainNoEngineHours({}), /no engine-hours parameter/i);
  assert.match(explainNoEngineHours({ 103: 10 }), /non-billable/i);
  assert.match(explainNoEngineHours({ 449: 10 }), /forbidden/i);
});
