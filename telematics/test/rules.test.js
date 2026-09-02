import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, scenarioRecords } from '../src/simulator/scenarios.js';
import { resolveAssignment, DEVICES } from '../src/store/seed-data.js';
import { normalizeRecord } from '../src/decode/normalize.js';
import { detectEvents } from '../src/rules/detectEvents.js';

// Helper: scenario name -> canonical records, in timestamp order (the rules' real input)
function canonicalRecords(name) {
  return scenarioRecords(buildScenario(name)).map((r) => {
    const device = DEVICES.find((d) => d.imei === r.imei);
    const assignment = resolveAssignment(device.id, r.timestampMs); // by id, like ledger.test.js
    return normalizeRecord(r, { device, assignment });
  });
}

test('rules: geofence enter+exit on geofence-cross scenario (invariant 7)', () => {
  const events = detectEvents(canonicalRecords('geofence-cross'), {});
  assert.equal(events.filter((e) => e.type === 'geofence-exit').length, 1, 'expected 1 geofence-exit');
  assert.equal(events.filter((e) => e.type === 'geofence-enter').length, 1, 'expected 1 geofence-enter');
});

test('rules: after-hours ignition on after-hours scenario (invariant 3 trap)', () => {
  const events = detectEvents(canonicalRecords('after-hours'), {});
  const afterHoursEvents = events.filter((e) => e.type === 'after-hours-ignition');
  assert.ok(afterHoursEvents.length >= 1, 'should emit after-hours-ignition');
});

test('rules: after-hours ignition does not fire during daytime working hours (14:00 GST)', () => {
  // Create a synthetic record at 14:00 GST (UTC 10:00) with ignition true
  const tsMs = Date.UTC(2025, 4, 10, 10, 0, 0); // 10:00 UTC = 14:00 GST
  const records = [{
    assetId: 1,
    tenantId: 1,
    tsMs,
    ignition: true,
  }];
  const events = detectEvents(records, {});
  assert.equal(events.filter((e) => e.type === 'after-hours-ignition').length, 0, 'should not fire during day');
});

test('rules: idle-too-long on day-cycle at a scenario-sized threshold (invariant 9)', () => {
  // The day-cycle scenario has idle periods. Let's use a 60-second threshold.
  const events = detectEvents(canonicalRecords('day-cycle'), { config: { idleTooLongMs: 60_000 } });
  assert.ok(events.filter((e) => e.type === 'idle-too-long').length >= 1, 'expected at least one idle-too-long event');
});

test('rules: event dedupe identity is deterministic across re-runs', () => {
  const recs = canonicalRecords('geofence-cross');
  const a = detectEvents(recs, {}).map((e) => e.eventId);
  const b = detectEvents(recs, {}).map((e) => e.eventId);
  assert.deepEqual(a, b, 're-runs should produce identical eventIds');
  assert.equal(new Set(a).size, a.length, 'no eventId collisions within one run');
});

test('rules: pending spec — invariant 3 null-not-zero guard (tamper-unplug and low-battery)', () => {
  const events = detectEvents(canonicalRecords('tamper'), { config: { batteryLowPct: 80 } });
  
  const unplugs = events.filter(e => e.type === 'tamper-unplug');
  assert.ok(unplugs.length >= 1, 'should emit tamper-unplug');
  
  const lowBatts = events.filter(e => e.type === 'low-battery');
  assert.ok(lowBatts.length >= 1, 'should emit low-battery when battery drops below threshold');
});