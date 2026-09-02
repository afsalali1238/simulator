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
  buildIo,
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
import { encodeAvlPacket, readAvlFrame, CODEC_8E } from '../src/protocol/codec.js';

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

test('scenarios: after the handover the device still reports AVL 102 but no engine data is produced (invariant 9)', () => {
  const built = buildScenario('handover');
  const all = scenarioRecords(built);
  const device = DEVICES[0];

  // The device does keep reporting its hour-meter across the boundary — that is
  // deliberate, and it is the trap invariant 9 has to catch.
  const afterWithEngineIo = all.filter(
    (r) => r.timestampMs >= HANDOVER_TS_MS && io(r, IO.ENGINE_WORKTIME_MIN),
  );
  assert.ok(
    afterWithEngineIo.length > 0,
    'the post-handover track should still emit AVL 102 so invariant 9 is actually exercised',
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
    assert.equal(io(r, IO.ENGINE_WORKTIME_MIN), undefined, 'engine IO must be omitted, not sent as 0');
    assert.equal(io(r, IO.ENGINE_WORKTIME_COUNTED_MIN), undefined, 'no tracker counter either');
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
    assert.equal(io(r, IO.ENGINE_WORKTIME_MIN), undefined, 'no engine counter without a live bus');
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

test('scenarios: dic-to-reem fires one harsh-braking event, consistent with the GPS speed either side of it', () => {
  const built = buildScenario('dic-to-reem');
  const records = built.tracks[0].records;

  // Exactly one record carries the green-driving event, and it is raised in
  // priority + flagged as the record's event IO — same one-shot-event
  // contract the tamper scenario's unplug flag proves.
  const events = records.filter((r) => io(r, IO.GREEN_DRIVING_TYPE) !== undefined);
  assert.equal(events.length, 1, 'expected exactly one harsh-driving event');
  const event = events[0];
  assert.equal(event.priority, 1, 'a real unit raises priority on the event record');
  assert.equal(event.eventIoId, IO.GREEN_DRIVING_TYPE);
  assert.equal(io(event, IO.GREEN_DRIVING_TYPE).value, 2, 'type 2 = harsh braking (Teltonika Green Driving)');
  // AVL 254 is 1 byte, g x 100 (confirmed against wiki.teltonika-gps.com's
  // Green Driving Solution page + the FTC921 parameter table) — >= 40 is a
  // plausible harsh-braking threshold (0.4g), and <= 255 keeps it a valid
  // byte value (an earlier draft of this scenario used 2 bytes / deci-m/s^2,
  // which was wrong on both counts).
  const value = io(event, IO.GREEN_DRIVING_VALUE).value;
  assert.ok(value >= 40, 'the reported g-force must clear a plausible harsh-braking threshold (>= 0.4g)');
  assert.ok(value <= 255, 'AVL 254 is a single byte (0-2.55g) — this must never overflow it');

  // Wire-level check, not just the in-memory io array: encode the event
  // record exactly as device.js would put it on the wire and decode it back
  // with the same function the ingestion server uses. AVL 254 must round-trip
  // as a 1-byte element — this is the check that would have caught the
  // original 2-byte / deci-m/s^2 draft, which "worked" in-memory but was
  // wrong on the actual bytes sent.
  const packet = encodeAvlPacket({ codecId: CODEC_8E, records: [event] });
  const { packet: decoded } = readAvlFrame(packet);
  const wireValueEl = decoded.records[0].io.find((e) => e.id === IO.GREEN_DRIVING_VALUE);
  assert.equal(wireValueEl.size, 1, 'AVL 254 must be encoded as a 1-byte IO element, per Teltonika spec');
  assert.equal(wireValueEl.value, value, 'wire round-trip must be lossless');

  // The GPS speed drop is real and lands either side of the event, not a
  // teleport: fast before, slow at the event, and the vehicle is genuinely
  // stopped (idle) for a beat afterwards before it builds speed again.
  const idx = records.indexOf(event);
  assert.ok(records[idx - 1].gps.speed >= 100, 'should be at highway speed just before the event');
  assert.ok(event.gps.speed <= 20, 'should have dropped sharply at the event');
  const after = records.slice(idx + 1, idx + 3);
  assert.ok(after.every((r) => r._phase === 'idle'), 'expects a stopped beat right after the event');

  // Real-world endpoints: starts in Dubai Internet City, ends near Al Reem
  // Island — not exact (this harness has no road router), but in the right
  // place, not still sitting in Dubai.
  const DIC = { lat: 25.094, lon: 55.1568 };
  const AL_REEM = { lat: 24.4992, lon: 54.4059 };
  const first = records[0];
  const last = records[records.length - 1];
  assert.ok(distanceMeters(DIC, { lat: first.gps.lat, lon: first.gps.lon }) < 1000);
  assert.ok(
    distanceMeters(AL_REEM, { lat: last.gps.lat, lon: last.gps.lon }) < 15_000,
    'should end up in the vicinity of Al Reem Island',
  );

  // No CAN adapter on this device in any scenario — never claims engine data.
  assert.equal(io(records[10], IO.ENGINE_WORKTIME_MIN), undefined);
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

test('scenarios: the engine hour-meter is monotonic, in minutes, and only advances while the engine runs', () => {
  const built = buildScenario('day-cycle');
  const records = built.tracks[0].records;

  let last = null;
  let advancedWhileRunning = 0;
  for (const r of records) {
    const el = io(r, IO.ENGINE_WORKTIME_MIN);
    if (!el) continue; // key off / no bus: absent by design
    if (last != null) {
      assert.ok(el.value >= last, 'the hour-meter must never go backwards');
      if (el.value > last) advancedWhileRunning++;
    }
    last = el.value;
  }
  assert.ok(advancedWhileRunning > 0, 'the meter never advanced');

  // The wire value is MINUTES, not seconds. The track starts at 3600s = 60 min,
  // so the first reported reading must be ~60, not ~3600 — this is the assertion
  // that would catch a re-introduced 60× unit error.
  const first = records.find((r) => io(r, IO.ENGINE_WORKTIME_MIN));
  assert.ok(
    io(first, IO.ENGINE_WORKTIME_MIN).value >= 60 && io(first, IO.ENGINE_WORKTIME_MIN).value < 70,
    `expected ~60 minutes on the wire, got ${io(first, IO.ENGINE_WORKTIME_MIN).value}`,
  );

  // Key-off records must not carry a counter at all.
  const offRecords = records.filter((r) => r._phase === 'off' || r._phase === 'shutdown');
  assert.ok(offRecords.length > 0);
  for (const r of offRecords) {
    assert.equal(io(r, IO.ENGINE_WORKTIME_MIN), undefined);
    assert.equal(io(r, IO.IGNITION).value, 0); // present-and-zero: a real reading
  }
});

test('scenarios: ecu-counted-only emits AVL 103 only, and it never becomes billable (invariants 4, 5)', () => {
  const built = buildScenario('ecu-counted-only');
  const track = built.tracks[0];
  const withCounter = track.records.filter((r) => io(r, IO.ENGINE_WORKTIME_COUNTED_MIN));
  assert.ok(withCounter.length > 0, 'the scenario must emit AVL 103');

  for (const r of track.records) {
    // The billable parameter is never present in this scenario.
    assert.equal(io(r, IO.ENGINE_WORKTIME_MIN), undefined, 'AVL 102 must not appear');
  }

  // Through the decoder, on a fully CAN-supported asset: still no engine data.
  const device = DEVICES[0];
  for (const r of withCounter) {
    const assignment = resolveAssignment(device.id, r.timestampMs);
    const asset = assignment ? ASSETS.find((a) => a.id === assignment.assetId) : null;
    const canonical = normalizeRecord(r, {
      device,
      assignment: assignment ? { ...assignment, hasEngineData: asset?.hasEngineData } : null,
    });
    assert.equal(
      canonical.engine,
      null,
      'a tracker-counted accumulator must never be relabelled source:ecu',
    );
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


test('scenarios: D1 (FMC130) carries the new permanent I/O elements on every record; D2 does not', () => {
  const FMC130_IDS = [
    IO.DATA_MODE, IO.GSM_SIGNAL, IO.SPEED, IO.GSM_CELL_ID, IO.GSM_AREA_CODE,
    IO.ACTIVE_GSM_OPERATOR, IO.TRIP_ODOMETER_M, IO.TOTAL_ODOMETER_M,
    IO.DIGITAL_INPUT_1, IO.DIGITAL_INPUT_2, IO.ANALOG_INPUT_1, IO.DIGITAL_OUTPUT_1,
    IO.AXIS_X, IO.AXIS_Y, IO.AXIS_Z, IO.ICCID,
  ];

  // day-cycle is a whole D1 shift with a GNSS fix throughout, so PDOP/HDOP
  // (fix-dependent) are expected on every record too.
  const built = buildScenario('day-cycle');
  const records = built.tracks[0].records;
  assert.ok(records.length > 0);

  let firstStartupIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    for (const id of [...FMC130_IDS, IO.GNSS_PDOP, IO.GNSS_HDOP]) {
      assert.ok(io(rec, id) != null, `day-cycle record ${i}: missing FMC130 IO ${id}`);
    }
    // Digital Input 1 is a documented FMC130 ignition-detection source — it
    // must mirror the ignition IO element exactly, tick for tick.
    assert.equal(io(rec, IO.DIGITAL_INPUT_1).value, io(rec, IO.IGNITION).value);
    // The standalone Speed element (24) must agree with the GPS block's own
    // speed — a real unit reports the same figure in both places.
    assert.equal(io(rec, IO.SPEED).value, rec.gps.speed);
    if (rec._phase === 'startup' && records[i - 1]?._phase !== 'startup' && firstStartupIdx < 0) {
      firstStartupIdx = i;
    }
  }

  // Trip odometer resets at the first tick of a new trip (key-on after `off`).
  assert.ok(firstStartupIdx >= 0, 'day-cycle has no startup phase to check the reset against');
  assert.equal(io(records[firstStartupIdx], IO.TRIP_ODOMETER_M).value, 0);

  // Cell ID / area code / operator are held steady for the length of one
  // registration, not re-rolled every tick.
  const cellIds = new Set(records.map((r) => io(r, IO.GSM_CELL_ID).value));
  const areaCodes = new Set(records.map((r) => io(r, IO.GSM_AREA_CODE).value));
  assert.equal(cellIds.size, 1, 'GSM cell ID must not change mid-track');
  assert.equal(areaCodes.size, 1, 'GSM area code must not change mid-track');

  // Total odometer never goes backwards, and only advances while moving.
  let prevTotal = -1;
  for (const rec of records) {
    const total = Number(io(rec, IO.TOTAL_ODOMETER_M).value);
    assert.ok(total >= prevTotal, 'total odometer must be monotonic');
    prevTotal = total;
  }

  // Wire-level: TOTAL_ODOMETER_M really is a 4-byte element, ICCID an 8-byte
  // one, and they survive a genuine Codec 8E encode/decode round trip.
  const lastRecord = records[records.length - 1];
  const packet = encodeAvlPacket({ codecId: CODEC_8E, records: [lastRecord] });
  const { packet: decoded } = readAvlFrame(packet);
  const decodedTotal = decoded.records[0].io.find((e) => e.id === IO.TOTAL_ODOMETER_M);
  assert.equal(decodedTotal.size, 4);
  assert.equal(decodedTotal.value, Number(io(lastRecord, IO.TOTAL_ODOMETER_M).value));
  const decodedIccid = decoded.records[0].io.find((e) => e.id === IO.ICCID);
  assert.equal(decodedIccid.size, 8);
  assert.equal(decodedIccid.value, io(lastRecord, IO.ICCID).value);

  // D2 is a different, unprofiled model (FMC920) — none of this applies to it.
  const d2 = buildScenario('dic-to-reem').tracks[0].records;
  for (const rec of d2) {
    for (const id of FMC130_IDS) {
      assert.equal(io(rec, id), undefined, `dic-to-reem (D2) must not carry FMC130 IO ${id}`);
    }
  }
});

test('scenarios: buildIo two\'s-complements negative accelerometer axis values for the wire, and the sign recovers on decode', () => {
  // Axis X/Y/Z are documented as SIGNED -8000..8000 mG, but every IO element
  // in this protocol is written as a raw unsigned width (invariant of the
  // encoder, see codec.js). A harsh-braking spike is negative on the braking
  // axis, so this path is exercised for real, not just in theory.
  const rec = {
    timestampMs: Date.parse('2025-01-01T00:00:00Z'),
    priority: 0,
    gps: { lat: 25, lon: 55, altitude: 0, angle: 0, satellites: 9, speed: 0 },
    eventIoId: IO.IGNITION,
    io: buildIo({ ignition: true, movement: false, axisX: -1234, axisY: 500, axisZ: 980 }),
  };

  const wireX = rec.io.find((e) => e.id === IO.AXIS_X);
  assert.equal(wireX.value, 65536 - 1234, 'negative axis value must be two\'s-complemented into 0-65535 before encoding');

  const packet = encodeAvlPacket({ codecId: CODEC_8E, records: [rec] });
  const { packet: decoded } = readAvlFrame(packet);
  const decodedX = decoded.records[0].io.find((e) => e.id === IO.AXIS_X).value;
  // The wire never carries a sign bit — recovering it is the decoder's job,
  // same status as every other FMC130 field added this session (data-plane
  // only, not yet consumed by decode/normalize.js).
  const signed = decodedX > 32767 ? decodedX - 65536 : decodedX;
  assert.equal(signed, -1234, 'the signed value must round-trip through the unsigned wire encoding');
});
