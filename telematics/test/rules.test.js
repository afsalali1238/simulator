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

test('rules: tamper scenario fires both tamper-unplug and low-battery', () => {
  const events = detectEvents(canonicalRecords('tamper'), { config: { batteryLowPct: 80 } });

  const unplugs = events.filter(e => e.type === 'tamper-unplug');
  assert.ok(unplugs.length >= 1, 'should emit tamper-unplug');

  const lowBatts = events.filter(e => e.type === 'low-battery');
  assert.ok(lowBatts.length >= 1, 'should emit low-battery when battery drops below threshold');
});

test('rules: invariant 3 — tamper-unplug never fires on null unplug + stable/absent voltage', () => {
  // unplug and externalVoltageMv are both absent (no power IO modeled for this
  // device/scenario). Absence must never be read as "collapsed" or "unplugged".
  const base = Date.UTC(2025, 4, 10, 8, 0, 0);
  const records = Array.from({ length: 5 }, (_, i) => ({
    assetId: 1,
    tenantId: 1,
    tsMs: base + i * 60_000,
    unplug: null,
    externalVoltageMv: null,
  }));
  const events = detectEvents(records, {});
  assert.equal(events.filter((e) => e.type === 'tamper-unplug').length, 0, 'null signals must never fire tamper-unplug');
});

test('rules: invariant 3 — tamper-unplug never fires when voltage is present but healthy', () => {
  const base = Date.UTC(2025, 4, 10, 8, 0, 0);
  const records = Array.from({ length: 5 }, (_, i) => ({
    assetId: 1,
    tenantId: 1,
    tsMs: base + i * 60_000,
    unplug: 0,
    externalVoltageMv: 12000,
  }));
  const events = detectEvents(records, {});
  assert.equal(events.filter((e) => e.type === 'tamper-unplug').length, 0, 'healthy voltage + unplug=0 must never fire');
});

test('rules: invariant 3 — low-battery never fires on null batteryPct', () => {
  const base = Date.UTC(2025, 4, 10, 8, 0, 0);
  const records = Array.from({ length: 5 }, (_, i) => ({
    assetId: 1,
    tenantId: 1,
    tsMs: base + i * 60_000,
    batteryPct: null,
  }));
  const events = detectEvents(records, { config: { batteryLowPct: 80 } });
  assert.equal(events.filter((e) => e.type === 'low-battery').length, 0, 'null batteryPct must never fire low-battery');
});

test('rules: tamper-unplug re-arms after recovery — two separate unplug episodes each fire their own event', () => {
  const base = Date.UTC(2025, 4, 10, 8, 0, 0);
  const step = 60_000;
  const records = [
    { assetId: 1, tenantId: 1, tsMs: base + 0 * step, unplug: 0, externalVoltageMv: 12000 }, // healthy
    { assetId: 1, tenantId: 1, tsMs: base + 1 * step, unplug: 1, externalVoltageMv: 12000 }, // episode 1 starts (unplug flag alone)
    { assetId: 1, tenantId: 1, tsMs: base + 2 * step, unplug: 1, externalVoltageMv: 12000 }, // still episode 1
    { assetId: 1, tenantId: 1, tsMs: base + 3 * step, unplug: 0, externalVoltageMv: 12000 }, // recovered — re-armed
    { assetId: 1, tenantId: 1, tsMs: base + 4 * step, unplug: 0, externalVoltageMv: 12000 }, // still healthy
    { assetId: 1, tenantId: 1, tsMs: base + 5 * step, unplug: 1, externalVoltageMv: 12000 }, // episode 2 starts
  ];
  const events = detectEvents(records, {});
  const unplugs = events.filter((e) => e.type === 'tamper-unplug');
  assert.equal(unplugs.length, 2, 'expected exactly 2 tamper-unplug events (one per episode)');
  assert.notEqual(unplugs[0].eventId, unplugs[1].eventId, 'each episode must have a distinct eventId');
  assert.equal(unplugs[0].tsMs, base + 1 * step);
  assert.equal(unplugs[1].tsMs, base + 5 * step);
});

test('rules: tamper-unplug re-arms after a voltage-collapse episode recovers, without an unplug flag', () => {
  const base = Date.UTC(2025, 4, 10, 8, 0, 0);
  const step = 60_000;
  const records = [
    { assetId: 1, tenantId: 1, tsMs: base + 0 * step, unplug: 0, externalVoltageMv: 12000 }, // healthy
    { assetId: 1, tenantId: 1, tsMs: base + 1 * step, unplug: 0, externalVoltageMv: 10 },    // collapsed — episode 1
    { assetId: 1, tenantId: 1, tsMs: base + 2 * step, unplug: 0, externalVoltageMv: 12000 }, // recovered
    { assetId: 1, tenantId: 1, tsMs: base + 3 * step, unplug: 0, externalVoltageMv: 5 },     // collapsed again — episode 2
  ];
  const events = detectEvents(records, {});
  const unplugs = events.filter((e) => e.type === 'tamper-unplug');
  assert.equal(unplugs.length, 2, 'expected exactly 2 tamper-unplug events across two voltage-collapse episodes');
});

test('rules: low-battery re-arms after recovering past the hysteresis band', () => {
  const base = Date.UTC(2025, 4, 10, 8, 0, 0);
  const step = 60_000;
  const records = [
    { assetId: 1, tenantId: 1, tsMs: base + 0 * step, batteryPct: 90 }, // healthy
    { assetId: 1, tenantId: 1, tsMs: base + 1 * step, batteryPct: 15 }, // episode 1 (below 20)
    { assetId: 1, tenantId: 1, tsMs: base + 2 * step, batteryPct: 25 }, // still below recover threshold (30) — stays active
    { assetId: 1, tenantId: 1, tsMs: base + 3 * step, batteryPct: 35 }, // clears recover threshold — re-armed
    { assetId: 1, tenantId: 1, tsMs: base + 4 * step, batteryPct: 10 }, // episode 2
  ];
  const events = detectEvents(records, { config: { batteryLowPct: 20 } });
  const lowBatts = events.filter((e) => e.type === 'low-battery');
  assert.equal(lowBatts.length, 2, 'expected exactly 2 low-battery events (one per episode)');
  assert.notEqual(lowBatts[0].eventId, lowBatts[1].eventId, 'each episode must have a distinct eventId');
  assert.equal(lowBatts[0].tsMs, base + 1 * step);
  assert.equal(lowBatts[1].tsMs, base + 4 * step);
});