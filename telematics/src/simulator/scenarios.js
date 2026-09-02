// ─────────────────────────────────────────────────────────────────────────────
// src/simulator/scenarios.js — the scenario ENGINE (Module 9).
//
// phases.js supplies the vocabulary (what is the machine doing this tick?).
// This file turns a named, declarative scenario into concrete Teltonika AVL
// records: it walks the phase plan, advances the GPS track, ticks the engine
// hour-meter, and assembles the IO elements. device.js then puts those records
// on the wire as genuine Codec 8/8E bytes.
//
// Why a registry and not one flat loop: the simulator is the TEST BENCH for
// everything downstream (the ledger, the rules engine, D1, soak tests). Those
// need to replay a *named, deterministic* story — above all the D1 handover, the
// single moment that makes invariant 6 provable end-to-end.
//
// Three rules this file obeys:
//
//   • ALIGNED WITH THE SEED. Every track dials in with an IMEI from
//     store/seed-data.js and its timestamps sit inside (or deliberately
//     straddle) the seeded assignment windows. Nothing here forks the fixtures.
//
//   • ABSENCE IS NOT ZERO (invariant 3). A signal with no reading is `null` and
//     its IO element is OMITTED, exactly as a real unit behaves when the sensor
//     or CAN adapter isn't there. Never `0` to mean "unknown".
//
//   • DETERMINISTIC. Seeded PRNG only — no Math.random, no Date.now. The same
//     scenario + seed produces byte-identical records every run, so tests pin
//     exact values.
//
// A note on engine hours and what the simulator is allowed to claim: IO ID 200
// is a STAND-IN for real CAN engine hours (open decision D1, owned by
// protocol-engineer). `emitEngine` here means only "this unit has a CAN adapter
// fitted and is reporting a counter" — it is NOT a claim that the value is
// billable ECU truth. Whether a reading becomes billable engine data is decided
// downstream by decode/normalize.js from the *asset's* `hasEngineData`
// (invariant 9), and whether it can back an invoice is the ledger's gate
// (invariant 5, Module 5, human-led). The `handover` scenario leans on exactly
// that split: after the handover the device keeps reporting its counter, and the
// system must still produce no engine data for Generator Y.
// ─────────────────────────────────────────────────────────────────────────────

import { IO } from '../config.js';
import { DEVICES } from '../store/seed-data.js';
import { PHASES, runPhasePlan, makeRng, advance, distanceMeters } from './phases.js';

const D1 = DEVICES[0].imei; // 356307042441013 — FMC130, changes hands mid-2025
const D2 = DEVICES[1].imei; // 356307042441099 — FMC920, unassigned (yard)

/**
 * The seeded handover instant: D1 leaves Excavator X (Tenant A, CAN) and joins
 * Generator Y (Tenant B, no CAN program). Mirrors ASSIGNMENTS in seed-data.js —
 * the most important timestamp in the test bench.
 */
export const HANDOVER_TS_MS = Date.parse('2025-06-01T00:00:00Z');

/**
 * A work site used by the geofence scenario. Exported so a test (and later the
 * P3 rules engine) can assert crossings against the same circle the track was
 * generated from, instead of hard-coding coordinates twice.
 */
export const SITE_JEBEL_ALI = {
  name: 'Jebel Ali yard',
  lat: 25.0157,
  lon: 55.0611,
  radiusM: 400,
};

// Dozr's own yard, where the unassigned D2 sits.
const DOZR_YARD = { lat: 25.1279, lon: 55.2265 };

// ── IO assembly ──────────────────────────────────────────────────────────────
/**
 * Assemble the IO element array for one record. A signal that is `null` or
 * `undefined` is OMITTED — that absence is how the simulator models "no
 * reading", which is what exercises the decoder's NULL-vs-zero handling
 * (invariant 3). Do not "tidy" an omission into a 0.
 *
 * Engine hours: the simulator tracks engine time in SECONDS because per-tick
 * arithmetic is natural that way, but a real Teltonika reports AVL 102 in
 * MINUTES — so that is what goes on the wire, floored, exactly as an hour-meter
 * behaves. See src/decode/engine-hours.js for why the unit matters (a 60×
 * billing error that no invariant test would catch).
 *
 * `engineCountedSeconds` emits AVL 103, the TRACKER-counted accumulator. Only
 * the `ecu-counted-only` scenario sets it, to prove the decoder refuses it as
 * billing evidence rather than relabelling it 'ecu'.
 */
export function buildIo({
  ignition,
  movement,
  engineSeconds,
  engineCountedSeconds,
  programNumber,
  gnssStatus,
  externalVoltageMv,
  batteryPct,
  unplug,
  harshEventTypeId,
  harshEventValue,
  // ── FMC130 permanent I/O elements (see FMC130_FIDELITY_PLAN.md) ──
  // Only D1 tracks pass these; everyone else passes undefined and none of
  // this block emits anything, so no other device's stream changes shape.
  dataMode,
  gsmSignal,
  pdopRaw,
  hdopRaw,
  speedKmh,
  gsmCellId,
  gsmAreaCode,
  gsmOperator,
  batteryVoltageMv,
  batteryCurrentMa,
  tripOdometerM,
  totalOdometerM,
  digitalInput1,
  digitalInput2,
  analogInput1Mv,
  digitalOutput1,
  axisX,
  axisY,
  axisZ,
  iccid,
}) {
  const io = [];
  if (ignition != null) io.push({ id: IO.IGNITION, size: 1, value: ignition ? 1 : 0 });
  if (movement != null) io.push({ id: IO.MOVEMENT, size: 1, value: movement ? 1 : 0 });
  if (gnssStatus != null) io.push({ id: IO.GNSS_STATUS, size: 1, value: gnssStatus });
  if (programNumber != null) {
    io.push({ id: IO.CAN_PROGRAM_NUMBER, size: 4, value: programNumber });
  }
  if (engineSeconds != null) {
    io.push({
      id: IO.ENGINE_WORKTIME_MIN,
      size: 4,
      value: Math.floor(engineSeconds / 60), // AVL 102 is minutes
    });
  }
  if (engineCountedSeconds != null) {
    io.push({
      id: IO.ENGINE_WORKTIME_COUNTED_MIN,
      size: 4,
      value: Math.floor(engineCountedSeconds / 60), // AVL 103 is minutes
    });
  }
  if (externalVoltageMv != null) {
    io.push({ id: IO.EXTERNAL_VOLTAGE_MV, size: 2, value: Math.round(externalVoltageMv) });
  }
  if (batteryPct != null) {
    io.push({ id: IO.BATTERY_LEVEL_PCT, size: 1, value: Math.round(batteryPct) });
  }
  if (unplug != null) io.push({ id: IO.UNPLUG_DETECTED, size: 1, value: unplug ? 1 : 0 });
  if (harshEventTypeId != null) {
    io.push({ id: IO.GREEN_DRIVING_TYPE, size: 1, value: harshEventTypeId });
    // 1 byte, g x 100 (Teltonika's actual encoding — confirmed against two
    // primary sources; an earlier draft of this code used 2 bytes and
    // deci-m/s^2, which was wrong on both counts). Clamp to the byte range
    // (0-255 => 0-2.55g) rather than silently overflowing on an extreme input.
    io.push({
      id: IO.GREEN_DRIVING_VALUE,
      size: 1,
      value: Math.min(255, Math.max(0, Math.round(harshEventValue ?? 0))),
    });
  }

  // ── FMC130 permanent I/O elements ──
  if (dataMode != null) io.push({ id: IO.DATA_MODE, size: 1, value: dataMode });
  if (gsmSignal != null) io.push({ id: IO.GSM_SIGNAL, size: 1, value: gsmSignal });
  // PDOP/HDOP are GNSS-quality figures — genuinely absent without a fix,
  // same invariant-3 reasoning as everything else in this file.
  if (pdopRaw != null) io.push({ id: IO.GNSS_PDOP, size: 2, value: pdopRaw });
  if (hdopRaw != null) io.push({ id: IO.GNSS_HDOP, size: 2, value: hdopRaw });
  if (speedKmh != null) io.push({ id: IO.SPEED, size: 2, value: speedKmh });
  if (gsmCellId != null) io.push({ id: IO.GSM_CELL_ID, size: 2, value: gsmCellId });
  if (gsmAreaCode != null) io.push({ id: IO.GSM_AREA_CODE, size: 2, value: gsmAreaCode });
  if (gsmOperator != null) io.push({ id: IO.ACTIVE_GSM_OPERATOR, size: 4, value: gsmOperator });
  // Battery voltage/current are siblings of AVL 113 (battery %) — computed
  // only where that is, i.e. only for scenarios that model power at all
  // (`power: true` or an unplug event). Not a new gate, the existing one.
  if (batteryVoltageMv != null) {
    io.push({ id: IO.BATTERY_VOLTAGE_MV, size: 2, value: Math.round(batteryVoltageMv) });
  }
  if (batteryCurrentMa != null) {
    io.push({ id: IO.BATTERY_CURRENT_MA, size: 2, value: Math.round(batteryCurrentMa) });
  }
  if (tripOdometerM != null) {
    io.push({ id: IO.TRIP_ODOMETER_M, size: 4, value: Math.round(tripOdometerM) });
  }
  if (totalOdometerM != null) {
    io.push({ id: IO.TOTAL_ODOMETER_M, size: 4, value: Math.round(totalOdometerM) });
  }
  // Digital Input 1 mirrors ignition on this hardware — the FMC130 datasheet
  // lists "Digital Input 1" as a documented ignition-detection source, so an
  // unknown ignition reading (bus unreadable) means this pin's meaning is
  // unknown too, not that it reads 0.
  if (digitalInput1 != null) io.push({ id: IO.DIGITAL_INPUT_1, size: 1, value: digitalInput1 });
  if (digitalInput2 != null) io.push({ id: IO.DIGITAL_INPUT_2, size: 1, value: digitalInput2 });
  if (analogInput1Mv != null) {
    io.push({ id: IO.ANALOG_INPUT_1, size: 2, value: analogInput1Mv });
  }
  if (digitalOutput1 != null) {
    io.push({ id: IO.DIGITAL_OUTPUT_1, size: 1, value: digitalOutput1 });
  }
  // Axis X/Y/Z are SIGNED on the wire (-8000..8000 mG) but every IO element
  // in this protocol is written as a raw unsigned width — the sign is a
  // decoding convention, not a wire-format one. Two's-complement it into the
  // unsigned 16-bit range Buffer.writeUIntBE requires, exactly what a real
  // unit's own encoder does.
  const u16 = (v) => (v < 0 ? v + 0x10000 : v);
  if (axisX != null) io.push({ id: IO.AXIS_X, size: 2, value: u16(axisX) });
  if (axisY != null) io.push({ id: IO.AXIS_Y, size: 2, value: u16(axisY) });
  if (axisZ != null) io.push({ id: IO.AXIS_Z, size: 2, value: u16(axisZ) });
  if (iccid != null) io.push({ id: IO.ICCID, size: 8, value: iccid });

  return io;
}

// Teltonika "Green driving" event type codes (AVL 253).
const GREEN_DRIVING_TYPE_ID = { accel: 1, brake: 2, corner: 3 };

// ── Legacy single-session generator (kept for the demo and existing tests) ────
/**
 * The original one-note generator: ignition wired on, a mechanical idle blip
 * every 10th tick, an engine meter that only climbs. Superseded by the named
 * scenarios below, but kept because `npm run demo` and test/ingestion.test.js
 * pin its shape. New work should use buildScenario().
 *
 * `engineSeconds0` is still expressed in seconds for readability; buildIo puts
 * it on the wire as AVL 102 in minutes, like a real unit. So `npm run demo`
 * reports fewer decoded hours than it used to — that is the D1 fix, not a
 * regression: the old number was a seconds value being billed as if the
 * parameter were seconds, which no real Teltonika reports.
 */
export function makeScenario({
  startTsMs = Date.parse('2025-03-01T06:00:00Z'), // inside D1 -> Excavator X (Tenant A)
  stepMs = 1000,
  lat0 = 25.2048, // Dubai
  lon0 = 55.2708,
  engineSeconds0 = 3600, // machine starts life with 1h on the meter
} = {}) {
  let engineSeconds = engineSeconds0;
  return function step(i) {
    const ignition = true;
    const movement = i % 10 !== 0; // idle on every 10th tick
    if (ignition) engineSeconds += Math.round(stepMs / 1000);
    const speed = movement ? 18 + (i % 6) : 0;
    return {
      timestampMs: startTsMs + i * stepMs,
      priority: 0,
      gps: {
        lat: lat0 + i * 0.00012,
        lon: lon0 + i * 0.00009,
        altitude: 10,
        angle: (i * 15) % 360,
        satellites: 9,
        speed,
      },
      eventIoId: IO.IGNITION,
      io: buildIo({ ignition, movement, engineSeconds }),
    };
  };
}

// ── Reusable phase plans ─────────────────────────────────────────────────────
// A believable working day, in ticks. At the default 60s step that is a ~2h
// compressed shift; the shape (not the wall-clock length) is what matters.
const DAY_PLAN = [
  { phase: 'off', ticks: 2 },
  { phase: 'startup', ticks: 3 },
  { phase: 'travel', ticks: 8, opts: { speedKmh: 42 } },
  { phase: 'work', ticks: 14, opts: { dutyCycle: 3 } },
  { phase: 'idle', ticks: 5 },
  { phase: 'work', ticks: 8, opts: { dutyCycle: 4 } },
  { phase: 'travel', ticks: 6, opts: { speedKmh: 36 } },
  { phase: 'shutdown', ticks: 2 },
];

// A short shift — used either side of the handover so the boundary is the point
// of the scenario rather than the volume of data.
const SHORT_SHIFT = [
  { phase: 'startup', ticks: 2 },
  { phase: 'work', ticks: 6, opts: { dutyCycle: 3 } },
  { phase: 'idle', ticks: 2 },
  { phase: 'shutdown', ticks: 1 },
];

// ── The scenario registry ────────────────────────────────────────────────────
// A track = one device's stream. Per-track flags:
//   emitEngine      a CAN adapter is fitted and the unit reports AVL 102, the
//                   machine's own hour-meter (minutes on the wire).
//   emitCountedOnly report ONLY AVL 103, the tracker-counted accumulator — used
//                   to prove the decoder refuses it as billing evidence.
//   programNumber   the CAN program the adapter runs (AVL 100), so a record can
//                   say which mapping produced it. Real numbers per machine are
//                   in ../../D1_CAN_ENGINE_HOURS.md.
//   power           emit external-voltage/battery IO (the tamper scenario only).
export const SCENARIOS = {
  'day-cycle': {
    description:
      'One believable working day for D1 on Excavator X (Tenant A, CAN): off → ' +
      'startup → travel → work → idle → work → travel → shutdown.',
    proves: ['engine hours accrue only while the engine runs', 'state transitions'],
    tracks: [
      {
        imei: D1,
        label: 'D1 / Excavator X',
        startTsIso: '2025-03-03T05:00:00Z', // 09:00 local, inside the Tenant A window
        stepMs: 60_000,
        origin: { lat: 25.2048, lon: 55.2708 },
        heading0: 70,
        engineSeconds0: 3600,
        emitEngine: true,
        programNumber: 1261, // ALL-CAN300 program for a CAT 320-class excavator
        plan: DAY_PLAN,
      },
    ],
  },

  'after-hours': {
    description:
      'D1 on Excavator X started up and worked late in the evening (local time) — ' +
      'the data an after-hours-ignition rule should fire on. The rule itself is P3; ' +
      'this scenario only produces the evidence.',
    proves: ['ignition outside working hours is visible in the record stream'],
    tracks: [
      {
        imei: D1,
        label: 'D1 / Excavator X (after hours)',
        startTsIso: '2025-03-05T19:30:00Z', // 23:30 Gulf Standard Time
        stepMs: 60_000,
        origin: { lat: 25.2048, lon: 55.2708 },
        heading0: 120,
        engineSeconds0: 18_000,
        emitEngine: true,
        plan: [
          { phase: 'startup', ticks: 2 },
          { phase: 'work', ticks: 10, opts: { dutyCycle: 3 } },
          { phase: 'idle', ticks: 3 },
          { phase: 'shutdown', ticks: 1 },
        ],
      },
    ],
  },

  // ── The one that matters most ──────────────────────────────────────────────
  handover: {
    description:
      'THE D1 story. One physical device, two shifts straddling the seeded ' +
      'handover instant 2025-06-01T00:00:00Z: before it, Excavator X / Tenant A ' +
      '(CAN supported); after it, Generator Y / Tenant B (no CAN program). The ' +
      'device keeps reporting its engine counter across the boundary on purpose — ' +
      'the system must still produce NO engine data for Generator Y.',
    proves: [
      'invariant 6 — records attribute by their own timestamp, not "as of now"',
      'invariant 9 — a non-CAN asset yields position + ignition only, even though the device still reports AVL 102',
    ],
    tracks: [
      {
        imei: D1,
        label: 'D1 / Excavator X (before handover, Tenant A)',
        // 11 ticks × 60s ending at 23:59:00Z on 31 May — the last record lands
        // one minute before the handover.
        startTsIso: '2025-05-31T23:49:00Z',
        stepMs: 60_000,
        origin: { lat: 25.2048, lon: 55.2708 },
        heading0: 45,
        engineSeconds0: 250_000,
        emitEngine: true,
        programNumber: 1261, // Excavator X's ALL-CAN300 program
        plan: SHORT_SHIFT,
      },
      {
        imei: D1,
        label: 'D1 / Generator Y (after handover, Tenant B)',
        // First record at 00:01:00Z on 1 June — one minute after the handover.
        startTsIso: '2025-06-01T00:01:00Z',
        stepMs: 60_000,
        origin: { lat: 24.47, lon: 54.37 }, // moved to an Abu Dhabi site
        heading0: 200,
        // The unit carries its own accumulated counter over to the new machine.
        // Reporting it is realistic AND is the point: nothing downstream may
        // turn it into engine data for an asset with no CAN program. No program
        // number is reported, because the generator has no supported program.
        engineSeconds0: 253_000,
        emitEngine: true,
        plan: SHORT_SHIFT,
      },
    ],
  },

  'yard-idle': {
    description:
      'THE D2 story. The unassigned FMC920 sitting in Dozr\'s yard: it reports ' +
      'position and ignition, no CAN adapter is fitted, so no engine IO is sent ' +
      'at all. Scoped to the owner tenant because no assignment covers it.',
    proves: [
      'invariant 7 — an unassigned device falls back to its owner tenant',
      'invariant 9 — position + ignition only, no engine data',
      'invariant 3 — the engine signal is ABSENT, not zero',
    ],
    tracks: [
      {
        imei: D2,
        label: 'D2 / unassigned (Dozr yard)',
        startTsIso: '2025-03-03T05:00:00Z',
        stepMs: 60_000,
        origin: DOZR_YARD,
        heading0: 0,
        engineSeconds0: 0,
        emitEngine: false, // no CAN adapter → the IO element is omitted entirely
        plan: [
          { phase: 'off', ticks: 6 },
          { phase: 'startup', ticks: 2 }, // someone turns the key to shuffle it
          { phase: 'idle', ticks: 3 },
          { phase: 'shutdown', ticks: 3 },
        ],
      },
    ],
  },

  'geofence-cross': {
    description:
      'D1 drives out of the Jebel Ali site boundary and back in again — the track ' +
      'a geofence exit/enter rule needs. The circle is exported as SITE_JEBEL_ALI ' +
      'so a test asserts crossings against the same geometry the track was built from.',
    proves: ['a position stream that leaves and re-enters a named site'],
    site: SITE_JEBEL_ALI,
    tracks: [
      {
        imei: D1,
        label: 'D1 / Excavator X (leaves and re-enters site)',
        startTsIso: '2025-04-10T05:00:00Z',
        stepMs: 60_000,
        origin: { lat: SITE_JEBEL_ALI.lat, lon: SITE_JEBEL_ALI.lon },
        heading0: 90,
        engineSeconds0: 120_000,
        emitEngine: true,
        plan: [
          { phase: 'work', ticks: 4, opts: { dutyCycle: 4 } }, // inside
          { phase: 'travel', ticks: 6, opts: { speedKmh: 50 } }, // out through the fence
          { phase: 'idle', ticks: 2 }, // parked outside
          { phase: 'travel', ticks: 6, opts: { speedKmh: 50 } }, // back in (heading flips)
          { phase: 'work', ticks: 3, opts: { dutyCycle: 3 } }, // inside again
        ],
        // Turn the vehicle around after the outbound leg so it drives back to
        // the site instead of away from it. Applied by tick index.
        headingFlipAtTick: 12,
      },
    ],
  },

  // ── D1: the parameter that looks right and must not be billed ─────────────
  'ecu-counted-only': {
    description:
      'D1 on Excavator X where the CAN program exposes ONLY AVL 103 — the ' +
      'engine-hours counter the TRACKER accumulates from adapter installation, ' +
      "not the machine's own hour-meter. It looks exactly like usable engine " +
      'data and must NOT become billing evidence: it cannot be reconciled ' +
      'against the dashboard meter and it resets if the adapter is swapped.',
    proves: [
      'invariant 5 — a tracker-side accumulator is refused as billing evidence',
      'invariant 4 — it is dropped, not relabelled source:ecu',
    ],
    tracks: [
      {
        imei: D1,
        label: 'D1 / Excavator X (only AVL 103 available)',
        startTsIso: '2025-04-20T05:00:00Z',
        stepMs: 60_000,
        origin: { lat: 25.2048, lon: 55.2708 },
        heading0: 60,
        engineSeconds0: 140_000,
        emitEngine: false, // no AVL 102 at all
        emitCountedOnly: true, // AVL 103 only
        programNumber: 1261,
        plan: SHORT_SHIFT,
      },
    ],
  },

  tamper: {
    description:
      'D1 is working normally, then the harness is pulled: external voltage ' +
      'collapses, the unit falls back to its internal battery, and it stops being ' +
      'able to see the key at all. Ignition becomes NULL (unknown) — not false — ' +
      'because "I cannot read the bus" is not "the key is off" (invariant 3).',
    proves: [
      'invariant 3 — a lost signal is null, never 0/false',
      'the power-cut pattern a tamper/unplug rule fires on (rule itself is P3)',
    ],
    tracks: [
      {
        imei: D1,
        label: 'D1 / Excavator X (unplugged mid-shift)',
        startTsIso: '2025-04-15T06:00:00Z',
        stepMs: 60_000,
        origin: { lat: 25.2048, lon: 55.2708 },
        heading0: 15,
        engineSeconds0: 130_000,
        emitEngine: true,
        power: true, // emit external-voltage + battery IO
        plan: [
          { phase: 'startup', ticks: 2 },
          { phase: 'work', ticks: 6, opts: { dutyCycle: 3 } },
          { phase: 'unplugged', ticks: 5, opts: { batteryPct: 100, drainPctPerTick: 8 } },
        ],
      },
    ],
  },

  // ── D2 on the road: a real highway drive with a harsh-braking event ───────
  'dic-to-reem': {
    description:
      'D2 (no CAN adapter — a support vehicle, not billable machinery) drives ' +
      'Dubai Internet City to Al Reem Island: city streets onto the E11/Sheikh ' +
      'Zayed Road highway corridor, a sudden hard-braking event mid-highway ' +
      '(traffic ahead), a brief stop, then on into Al Reem Island and park. ' +
      'Coordinates are real; the route between them is the same straight-line, ' +
      'heading-based approximation the handover scenario uses for its Abu ' +
      'Dhabi leg — this harness has no road-network router.',
    proves: [
      'a long multi-leg travel plan with realistic highway speeds',
      'a harsh-braking event (AVL 253/254) fires once, raises priority, and ' +
        'is consistent with the GPS speed drop either side of it',
    ],
    tracks: [
      {
        imei: D2,
        label: 'D2 / support vehicle (Dubai Internet City → Al Reem Island)',
        startTsIso: '2025-05-10T05:30:00Z', // 09:30 Gulf Standard Time
        stepMs: 60_000,
        origin: { lat: 25.0940, lon: 55.1568 }, // Dubai Internet City
        heading0: 233, // bearing DIC → Al Reem Island, ~SW along the E11 corridor
        engineSeconds0: 0,
        emitEngine: false, // no CAN adapter fitted — matches D2 in every scenario
        plan: [
          { phase: 'off', ticks: 2 },
          { phase: 'startup', ticks: 2 },
          { phase: 'travel', ticks: 6, opts: { speedKmh: 60 } }, // out of DIC/JLT streets
          { phase: 'travel', ticks: 20, opts: { speedKmh: 110 } }, // onto Sheikh Zayed Road
          { phase: 'travel', ticks: 20, opts: { speedKmh: 130 } }, // open highway cruise
          // Sudden brakes: traffic ahead on the highway. toSpeedKmh matches
          // what the vehicle is actually doing one tick later; 0.75g is a
          // hard brake, clearly above a plausible harsh-braking threshold,
          // so this genuinely trips a green-driving event, not just a
          // slowdown (see phases.js's `brake` phase for the unit note).
          { phase: 'brake', ticks: 1, opts: { toSpeedKmh: 15, gForce: 0.75 } },
          { phase: 'idle', ticks: 2 }, // pulled onto the shoulder, hazards on
          { phase: 'travel', ticks: 6, opts: { speedKmh: 100 } }, // back up to speed
          { phase: 'travel', ticks: 4, opts: { speedKmh: 40 } }, // into Al Reem Island streets
          { phase: 'idle', ticks: 2 }, // looking for parking
          { phase: 'shutdown', ticks: 1 }, // parked
        ],
      },
    ],
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);
export const DEFAULT_SCENARIO = 'day-cycle';

// ── Materialisation ──────────────────────────────────────────────────────────
const NOMINAL_SUPPLY_MV = 27_400; // a 24V machine, engine running
const GNSS_FIX = 1; // Teltonika GNSS status: 1 = fix

/**
 * Walk one track's phase plan and produce its AVL records.
 * Pure and deterministic: same track + same seed => identical records.
 */
function materializeTrack(track, { seed, stepMs, limit }) {
  const rng = makeRng(`${seed}:${track.imei}:${track.startTsIso}`);
  const signals = runPhasePlan(track.plan, rng);
  const step = stepMs ?? track.stepMs ?? 60_000;
  const startTsMs = Date.parse(track.startTsIso);
  const stepSeconds = Math.round(step / 1000);

  // FMC130 permanent-I/O fidelity (FMC130_FIDELITY_PLAN.md) is scoped to D1,
  // the device this repo labels FMC130 — D2 (FMC920) is a different model and
  // stays exactly as it was.
  const isFmc130 = track.imei === D1;

  // Network-environment fields a real unit holds steady for the length of one
  // registration on a cell — drawn once per track, not re-rolled every tick.
  const gsmCellId = isFmc130 ? 20_000 + Math.floor(rng() * 5_000) : null;
  const gsmAreaCode = isFmc130 ? 100 + Math.floor(rng() * 50) : null;
  // A synthetic, deterministic ICCID (there is no real SIM behind a simulated
  // device) — included because the field itself is a genuine permanent
  // element on real firmware, not because this number means anything.
  const iccid = isFmc130 ? 8_997_100_000_000_000n + BigInt(track.imei.slice(-6)) : null;

  let engineSeconds = track.engineSeconds0 ?? 0;
  let heading = track.heading0 ?? 0;
  let pos = { ...track.origin };
  let totalOdometerM = track.odometerM0 ?? 0;
  let tripOdometerM = 0;
  let prevPhase = null;

  const records = [];
  const take = limit && limit > 0 ? Math.min(limit, signals.length) : signals.length;

  for (let i = 0; i < take; i++) {
    const s = signals[i];

    // The hour-meter advances only while the engine actually turns, and never
    // goes backwards — the defining property of an hour-meter.
    if (s.engineRunning) engineSeconds += stepSeconds;

    if (track.headingFlipAtTick != null && i === track.headingFlipAtTick) heading += 180;
    heading = (heading + (s.headingDelta ?? 0) + 360) % 360;

    const posBefore = pos;
    if (s.movement === true && s.speedKmh > 0) {
      pos = advance(pos, { speedKmh: s.speedKmh, stepMs: step, headingDeg: heading });
    }

    // Odometer: a new trip starts the tick the machine keys on again after
    // being off — the trip counter resets there, the total counter never
    // does. Both only accumulate the distance actually covered this tick.
    if (s.phase === 'startup' && prevPhase !== 'startup') tripOdometerM = 0;
    const deltaM = s.movement === true && s.speedKmh > 0 ? distanceMeters(posBefore, pos) : 0;
    tripOdometerM += deltaM;
    totalOdometerM += deltaM;
    prevPhase = s.phase;

    // Engine counters: reported only when a CAN adapter is fitted AND the unit
    // can read the bus (key on). Otherwise the element is omitted — absence,
    // not zero (invariant 3). buildIo converts seconds → the minutes a real
    // Teltonika puts on the wire.
    const canRead = s.ignition === true;
    const engineIo = canRead && track.emitEngine === true ? engineSeconds : null;
    const engineCountedIo =
      canRead && track.emitCountedOnly === true ? engineSeconds : null;

    // Power/tamper IO only where a scenario asks for it, so the ordinary
    // scenarios stay minimal and easy to pin in tests.
    const wantPower = track.power === true || s.externalVoltageMv != null;
    const externalVoltageMv = !wantPower
      ? null
      : s.externalVoltageMv != null
        ? s.externalVoltageMv
        : s.engineRunning
          ? NOMINAL_SUPPLY_MV
          : 24_600;
    const batteryPct = !wantPower ? null : (s.batteryPct ?? 100);
    // Battery voltage/current (AVL 67/68) are siblings of 66/113: computed
    // only where those already are, over the same 3300-4200mV Li-Ion range
    // the FMC130 datasheet's own backup-battery spec gives (3.7V nominal).
    const batteryVoltageMv = !wantPower ? null : 3300 + (batteryPct / 100) * 900;
    const batteryCurrentMa = !wantPower
      ? null
      : externalVoltageMv > 0
        ? 60 + Math.round(rng() * 40) // trickle-charging off external power
        : 90 + Math.round(rng() * 60); // discharging on the backup battery

    // Harsh-driving event (green driving, AVL 253/254) — fires only on the
    // one tick phases.js flags, same one-shot-event contract as unplugEvent.
    const harshEventTypeId = s.harshEventType ? GREEN_DRIVING_TYPE_ID[s.harshEventType] : null;

    // ── FMC130 permanent I/O elements ──
    const gnssStatus = s.ignition == null ? null : GNSS_FIX;
    const hasFix = gnssStatus === GNSS_FIX;
    // Accelerometer: a resting device reads ~1g on Z (gravity) and near-zero
    // on X/Y, with small sensor noise; a harsh event spikes the axis it acts
    // on. g x 100 (harshEventValue) x 10 = g x 1000 = mG, the same unit this
    // field is in — so no separate magnitude is invented for the spike.
    const jitterMg = () => Math.round((rng() - 0.5) * (s.movement ? 120 : 40));
    let axisX = jitterMg();
    let axisY = jitterMg();
    const axisZ = 980 + jitterMg();
    if (harshEventTypeId === GREEN_DRIVING_TYPE_ID.brake) axisX -= Math.round((s.harshEventValue ?? 0) * 10);
    else if (harshEventTypeId === GREEN_DRIVING_TYPE_ID.accel) axisX += Math.round((s.harshEventValue ?? 0) * 10);
    else if (harshEventTypeId === GREEN_DRIVING_TYPE_ID.corner) axisY += Math.round((s.harshEventValue ?? 0) * 10);

    records.push({
      timestampMs: startTsMs + i * step,
      // A real unit raises priority on ANY event record — power-cut or a
      // harsh-driving trigger — not just on the routine periodic ones.
      priority: s.unplugEvent || harshEventTypeId != null ? 1 : 0,
      gps: {
        lat: pos.lat,
        lon: pos.lon,
        altitude: 10,
        angle: Math.round(heading),
        satellites: s.ignition == null ? 0 : 9,
        speed: Math.max(0, Math.round(s.speedKmh ?? 0)),
      },
      eventIoId: s.unplugEvent
        ? IO.UNPLUG_DETECTED
        : harshEventTypeId != null
          ? IO.GREEN_DRIVING_TYPE
          : IO.IGNITION,
      io: buildIo({
        ignition: s.ignition,
        movement: s.movement,
        engineSeconds: engineIo,
        engineCountedSeconds: engineCountedIo,
        programNumber: canRead ? (track.programNumber ?? null) : null,
        gnssStatus,
        externalVoltageMv,
        batteryPct,
        harshEventTypeId,
        harshEventValue: s.harshEventValue,
        unplug: s.unplugEvent ? true : null,
        // FMC130 permanent I/O — undefined (so omitted) for every other device.
        dataMode: isFmc130 ? 0 : undefined,
        gsmSignal: isFmc130 ? 3 + Math.round(rng() * 2) : undefined,
        pdopRaw: isFmc130 && hasFix ? 10 + Math.round(rng() * 10) : undefined,
        hdopRaw: isFmc130 && hasFix ? 8 + Math.round(rng() * 7) : undefined,
        speedKmh: isFmc130 ? Math.max(0, Math.round(s.speedKmh ?? 0)) : undefined,
        gsmCellId: isFmc130 ? gsmCellId : undefined,
        gsmAreaCode: isFmc130 ? gsmAreaCode : undefined,
        gsmOperator: isFmc130 ? 42_402 : undefined, // UAE / Etisalat MCC+MNC, illustrative
        batteryVoltageMv,
        batteryCurrentMa,
        tripOdometerM: isFmc130 ? tripOdometerM : undefined,
        totalOdometerM: isFmc130 ? totalOdometerM : undefined,
        // Digital Input 1 is a documented FMC130 ignition-detection source —
        // it mirrors ignition exactly, including going unknown with it.
        digitalInput1: isFmc130 ? (s.ignition == null ? null : s.ignition ? 1 : 0) : undefined,
        digitalInput2: isFmc130 ? 0 : undefined,
        analogInput1Mv: isFmc130 ? 0 : undefined,
        digitalOutput1: isFmc130 ? 0 : undefined,
        axisX: isFmc130 ? axisX : undefined,
        axisY: isFmc130 ? axisY : undefined,
        axisZ: isFmc130 ? axisZ : undefined,
        iccid: isFmc130 ? iccid : undefined,
      }),
      // Not encoded on the wire — a debugging/testing annotation only.
      _phase: s.phase,
    });
  }

  return {
    imei: track.imei,
    label: track.label,
    records,
  };
}

/**
 * Build a named scenario into concrete per-device record streams.
 *
 * @param name          a key of SCENARIOS
 * @param opts.seed     PRNG seed (default: the scenario name → reproducible)
 * @param opts.stepMs   override the per-tick interval for every track
 * @param opts.records  cap records per track (0/absent = the whole plan)
 * @returns { name, description, proves, site?, tracks: [{ imei, label, records }] }
 */
export function buildScenario(name = DEFAULT_SCENARIO, opts = {}) {
  const def = SCENARIOS[name];
  if (!def) {
    throw new Error(
      `unknown scenario "${name}" — known scenarios: ${SCENARIO_NAMES.join(', ')}`,
    );
  }
  const seed = opts.seed ?? name;
  return {
    name,
    description: def.description,
    proves: def.proves ?? [],
    site: def.site,
    tracks: def.tracks.map((t) =>
      materializeTrack(t, { seed, stepMs: opts.stepMs, limit: opts.records }),
    ),
  };
}

/** Flatten a built scenario to one chronological list — handy in tests. */
export function scenarioRecords(built) {
  return built.tracks
    .flatMap((t) => t.records.map((r) => ({ imei: t.imei, ...r })))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

/** Distance helper re-exported so geofence tests import from one place. */
export { distanceMeters, PHASES };
