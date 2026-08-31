// ─────────────────────────────────────────────────────────────────────────────
// test/scenarios.test.js — Module 9 (Simulator), the scenario engine.
//
// The simulator is the test bench everything downstream replays against, so its
// output has to be pinned: deterministic, aligned with the seed fixtures, and
// honest about absence (invariant 3). These tests assert the properties the
// later phases depend on:
//
//   • determinism — same scenario + seed => identical records
//   • handover    — records land on BOTH sides of the seeded handover instant
//                   and resolve to different tenants (invariant 6), while the
//                   post-handover asset still yields no engine data (invariant 9)
//   • yard-idle   — the engine IO element is ABSENT, not zero (invariants 3, 9)
//   • tamper      — a lost signal is null, never false
//   • geofence    — the track genuinely leaves and re-enters the site circle
//   • hour-meter  — monotonic, and only advances while the engine runs
//
//   run: npm run test:scenarios
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScenario,
  scenarioRecords,
  distanceMeters,
  SCENARIO_NAMES,
  HANDOVER_TS_MS,
  SITE_JEBEL_ALI,
} from '../src/simulator/scenarios.js';
import { runPhasePlan, makeRng, PHASES } from '../src/simulator/phases.js';
import { parseArgs } from '../src/simulator/run-simulator.js';
import { IO } from '../src/config.js';
import { resolveAssignment, DEVICES, ASSETS, TENANTS, ASSIGNMENTS } from '../src/store/seed-data.js';
import { normalizeRecord } from '../src/decode/normalize.js';

const io = (rec, id) => rec.io.find((e) => e.id === id);
const imeis = new Set(DEVICES.map((d) => d.imei));

test('scenarios: every registered scenario builds, is deterministic, and uses seeded IMEIs', () => {
  assert.ok(SCENARIO_NAMES.length >= 6, `expected at least 6 scenarios, got ${SCENARIO_NAMES.length}`);

  for (const name of SCENARIO_NAMES) {
    const a = buildScenario(name);
    const b = buildScenario(name);
    assert.deepEqual(b, a, `${name} is not deterministic run-to-run`);

    assert.ok(a.tracks.length >= 1, `${name} has no tracks`);
    for (const track of a.tracks) {
      assert.ok(imeis.has(track.imei), `${name}: IMEI ${track.imei} is not in the seed roster`);
      assert.ok(track.records.length > 0, `${name}: track ${track.label} produced no records`);

      // Timestamps strictly ascending — a device never reports out of order.
      for (let i = 1; i < track.records.length; i++) {
        assert.ok(
          track.records[i].timestampMs > track.records[i - 1].timestampMs,
          `${name}: timestamps not ascending at ${i}`,
        );
      }
    }
  }

  // A different seed must actually change the jittered values, or the PRNG is
  // not being threaded through.
  const s1 = buildScenario('day-cycle', { seed: 'alpha' });
  const s2 = buildScenario('day-cycle', { seed: 'beta' });
  assert.notDeepEqual(s2.tracks[0].records, s1.tracks[0].records);

  assert.throws(() => buildScenario('does-not-exist'), /unknown scenario/);
});

test('scenarios: handover emits records on both sides of 2025-06-01T00:00:00Z (invariant 6)', () => {
  const built = buildScenario('handover');
  const all = scenarioRecords(built);

  const before = all.filter((r) => r.timestampMs < HANDOVER_TS_MS);
  const after = all.filter((r) => r.timestampMs >= HANDOVER_TS_MS);
  assert.ok(before.length > 0, 'no records before the handover instant');
  assert.ok(after.length > 0, 'no records after the handover instant');

  // Both sides come from the SAME physical device — that is what makes the
  // attribution test meaningful.
  assert.equal(new Set(all.map((r) => r.imei)).size, 1);
  assert.equal(all[0].imei, DEVICES[0].imei);

  // Resolve each record against the seeded assignments, exactly as the
  // ingestion server does, and confirm the split lands on different tenants.
  const device = DEVICES[0];
  const tenantsBefore = new Set(
    before.map((r) => resolveAssignment(device.id, r.timestampMs)?.tenantId),
  );
  const tenantsAfter = new Set(
    after.map((r) => resolveAssignment(device.id, r.timestampMs)?.tenantId),
  );
  assert.deepEqual([...tenantsBefore], [TENANTS.A.id]);
  assert.deepEqual([...tenantsAfter], [TENANTS.B.id]);
});

test('scenarios: after the handover the device still reports IO 200 but no engine data is produced (invariant 9)', () => {
  const built = buildScenario('handover');
  const all = scenarioRecords(built);
  const device = DEVICES[0];

  // The device does keep reporting its counter across the boundary — that is
  // deliberate, and it is the trap invariant 9 has to catch.
  const afterWithEngineIo = all.filter(
    (r) => r.timestampMs >= HANDOVER_TS_MS && io(r, IO.ENGINE_HOURS_S),
  );
  assert.ok(
    afterWithEngineIo.length > 0,
    'the post-handover track should still emit IO 200 so invariant 9 is actually exercised',
  );

  // Normalise every record the way the ingestion server does, with the asset's
  // hasEngineData attached (that is what the store returns).
  const engineByTenant = new Map();
  for (const r of all) {
    const assignment = resolveAssignment(device.id, r.timestampMs);
    const asset = assignment ? ASSETS.find((a) => a.id === assignment.assetId) : null;
    const canonical = normalizeRecord(r, {
      device,
      assignment: assignment ? { ...assignment, hasEngineData: asset?.hasEngineData } : null,
    });
    const list = engineByTenant.get(canonical.tenantId) ?? [];
    list.push(canonical.engine);
    engineByTenant.set(canonical.tenantId, list);
  }

  // Tenant A (Excavator X, CAN) gets ECU readings; Tenant B (Generator Y, no
  // CAN program) gets none at all, despite the identical wire data.
  const a = engineByTenant.get(TENANTS.A.id);
  const b = engineByTenant.get(TENANTS.B.id);
  assert.ok(a.some((e) => e && e.source === 'ecu'), 'Tenant A should have ECU engine readings');
  assert.ok(
    b.every((e) => e === null),
    'Tenant B (Generator Y, no CAN program) must have NO engine data — invariant 9',
  );
});

test('scenarios: yard-idle omits the engine IO entirely — absence, not zero (invariants 3, 9)', () => {
  const built = buildScenario('yard-idle');
  const track = built.tracks[0];
  assert.equal(track.imei, DEVICES[1].imei); // the unassigned FMC920

  for (const r of track.records) {
    assert.equal(io(r, IO.ENGINE_HOURS_S), undefined, 'engine IO must be omitted, not sent as 0');
    assert.ok(io(r, IO.IGNITION), 'ignition should still be reported');
  }

  // No assignment covers this device, so every record falls back to the owner
  // tenant with no asset and no engine data.
  const device = DEVICES[1];
  for (const r of track.records) {
    const assignment = resolveAssignment(device.id, r.timestampMs);
    assert.equal(assignment, null);
    const canonical = normalizeRecord(r, { device, assignment });
    assert.equal(canonical.tenantId, TENANTS.DOZR.id);
    assert.equal(canonical.assetId, null);
    assert.equal(canonical.engine, null);
  }
});

test('scenarios: tamper reports ignition as null (unknown), never false (invariant 3)', () => {
  const built = buildScenario('tamper');
  const records = built.tracks[0].records;

  const unplugged = records.filter((r) => r._phase === 'unplugged');
  assert.ok(unplugged.length >= 3, 'expected an unplugged tail');

  for (const r of unplugged) {
    // "I cannot read the bus" => the element is absent, so the decoder yields
    // null and deriveState() answers 'unknown' rather than 'off'.
    assert.equal(io(r, IO.IGNITION), undefined, 'ignition IO must be ABSENT while unplugged');
    assert.equal(io(r, IO.ENGINE_HOURS_S), undefined, 'no engine counter without a live bus');
    assert.equal(io(r, IO.EXTERNAL_VOLTAGE_MV).value, 0, 'external supply collapsed');

    const canonical = normalizeRecord(r, { device: DEVICES[0], assignment: null });
    assert.equal(canonical.ignition, null);
    assert.equal(canonical.state, 'unknown');
  }

  // Exactly one record carries the unplug event, and it is raised in priority.
  const events = records.filter((r) => io(r, IO.UNPLUG_DETECTED)?.value === 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].priority, 1);
  assert.equal(events[0].eventIoId, IO.UNPLUG_DETECTED);

  // The backup battery drains monotonically — the pattern a low-battery rule
  // will read in P3.
  const batt = unplugged.map((r) => io(r, IO.BATTERY_LEVEL_PCT).value);
  for (let i = 1; i < batt.length; i++) assert.ok(batt[i] < batt[i - 1], 'battery should drain');
});

test('scenarios: geofence-cross genuinely leaves and re-enters the site circle', () => {
  const built = buildScenario('geofence-cross');
  const site = built.site;
  assert.deepEqual(site, SITE_JEBEL_ALI);

  const inside = built.tracks[0].records.map(
    (r) => distanceMeters(site, { lat: r.gps.lat, lon: r.gps.lon }) <= site.radiusM,
  );

  // Count transitions: we need at least one exit and one re-entry.
  let exits = 0;
  let entries = 0;
  for (let i = 1; i < inside.length; i++) {
    if (inside[i - 1] && !inside[i]) exits++;
    if (!inside[i - 1] && inside[i]) entries++;
  }
  assert.equal(inside[0], true, 'the track should start inside the site');
  assert.ok(exits >= 1, 'the track never leaves the geofence');
  assert.ok(entries >= 1, 'the track never comes back into the geofence');
});

test('scenarios: the engine hour-meter is monotonic and only advances while the engine runs', () => {
  const built = buildScenario('day-cycle');
  const records = built.tracks[0].records;

  let last = null;
  let advancedWhileRunning = 0;
  for (const r of records) {
    const el = io(r, IO.ENGINE_HOURS_S);
    if (!el) continue; // key off / no bus: absent by design
    if (last != null) {
      assert.ok(el.value >= last, 'the hour-meter must never go backwards');
      if (el.value > last) advancedWhileRunning++;
    }
    last = el.value;
  }
  assert.ok(advancedWhileRunning > 0, 'the meter never advanced');

  // Key-off records must not carry a counter at all.
  const offRecords = records.filter((r) => r._phase === 'off' || r._phase === 'shutdown');
  assert.ok(offRecords.length > 0);
  for (const r of offRecords) {
    assert.equal(io(r, IO.ENGINE_HOURS_S), undefined);
    assert.equal(io(r, IO.IGNITION).value, 0); // present-and-zero: a real reading
  }
});

test('scenarios: phase plans are validated and the PRNG is stable', () => {
  assert.throws(() => runPhasePlan([{ phase: 'nope', ticks: 1 }], makeRng(1)), /unknown phase/);

  // Same seed, same sequence.
  const a = Array.from({ length: 5 }, ((rng) => () => rng())(makeRng('seed')));
  const b = Array.from({ length: 5 }, ((rng) => () => rng())(makeRng('seed')));
  assert.deepEqual(b, a);

  // The `off` phase is the one that must never claim the engine is turning.
  assert.equal(PHASES.off().engineRunning, false);
  assert.equal(PHASES.idle().engineRunning, true); // idling still burns hours
});

test('scenarios: the CLI parses scenario/interval/stream flags', () => {
  assert.deepEqual(parseArgs(['--scenario', 'handover']), { scenario: 'handover' });
  assert.deepEqual(parseArgs(['--scenario=tamper', '--interval=50']), {
    scenario: 'tamper',
    intervalMs: 50,
  });
  assert.deepEqual(parseArgs(['--stream', '--devices', '2']), { stream: true, devices: 2 });
  assert.deepEqual(parseArgs(['--list']), { list: true });
});

test('scenarios: the seeded handover constant matches the store fixtures', () => {
  // If someone re-times the assignments, this fails rather than the scenario
  // silently drifting off the boundary it exists to straddle.
  assert.equal(HANDOVER_TS_MS, ASSIGNMENTS[0].validToMs);
  assert.equal(HANDOVER_TS_MS, ASSIGNMENTS[1].validFromMs);
});
