// ─────────────────────────────────────────────────────────────────────────────
// src/simulator/phases.js — the scenario engine's vocabulary (Module 9).
//
// A scenario is a sequence of PHASES, each lasting a number of ticks. A phase
// answers one question per tick: "what is the machine doing right now?" — and
// returns signals only (ignition / movement / speed / whether the engine is
// turning / power state). It never touches bytes; turning signals into IO
// elements and records is scenarios.js's job, and putting those records on the
// wire is device.js's (which speaks the genuine Teltonika protocol).
//
// Two hard rules live here:
//   • DETERMINISM. No Math.random, no Date.now. Jitter comes from a seeded
//     PRNG, so `--scenario X` produces byte-identical output every run and a
//     test can pin exact values.
//   • ABSENCE IS NOT ZERO (invariant 3). A phase that has no reading for a
//     signal returns `null` for it, and scenarios.js then OMITS the IO element
//     entirely — exactly as a real unit does when a sensor or the CAN adapter
//     isn't there. A phase must never report `0` to mean "unknown".
// ─────────────────────────────────────────────────────────────────────────────

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────
export function makeRng(seed) {
  let a = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ── Geometry ─────────────────────────────────────────────────────────────────
const EARTH_R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres — used by geofence scenarios and their tests. */
export function distanceMeters(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

/**
 * Move a point by `speedKmh` for `stepMs` along `headingDeg`.
 * Flat-earth approximation — fine at the few-km scale a work site occupies.
 */
export function advance({ lat, lon }, { speedKmh, stepMs, headingDeg }) {
  const km = (speedKmh * stepMs) / 3600000;
  const dLat = (km / 111.32) * Math.cos(rad(headingDeg));
  const dLon = (km / (111.32 * Math.cos(rad(lat)) || 1e-9)) * Math.sin(rad(headingDeg));
  return { lat: lat + dLat, lon: lon + dLon };
}

// ── Phase vocabulary ─────────────────────────────────────────────────────────
// Each phase is (ctx) => signals.
//   ctx.i        tick index WITHIN this phase (0-based)
//   ctx.ticks    total ticks in this phase
//   ctx.rng      seeded PRNG
//   ctx.opts     per-phase options from the scenario definition
//
// signals:
//   ignition        true | false | null   (null = no reading → IO omitted)
//   movement        true | false | null
//   speedKmh        number (integer-ish; rounded when encoded)
//   engineRunning   bool — whether the engine-second meter advances this tick
//   headingDelta    degrees added to the track heading this tick
//   externalVoltageMv / batteryPct   number | null (null → omitted)
//   unplugEvent     true → this record is flagged as the unplug event
//   harshEventType  'brake' | 'accel' | 'corner' | null → the AVL 253/254
//                   green-driving event fires only on the tick this is set
//   harshEventValue number | null — magnitude for harshEventType, already in
//                   the wire's g*100 encoding (e.g. 75 = 0.75g), 0-255
//
// `null` for a signal is a first-class value here. Read the invariant-3 note at
// the top of this file before "tidying" any of these into 0/false.

export const PHASES = {
  // Parked, key out. The engine meter holds — an hour-meter never goes backwards
  // and never advances while off.
  off: () => ({
    ignition: false,
    movement: false,
    speedKmh: 0,
    engineRunning: false,
  }),

  // Key on, engine warming, machine stationary. The meter starts advancing here.
  startup: () => ({
    ignition: true,
    movement: false,
    speedKmh: 0,
    engineRunning: true,
  }),

  // Driving to or between sites: sustained movement, mild speed and heading jitter.
  travel: ({ rng, opts = {} }) => {
    const base = opts.speedKmh ?? 38;
    return {
      ignition: true,
      movement: true,
      speedKmh: base + Math.floor(rng() * 8),
      engineRunning: true,
      headingDelta: (rng() - 0.5) * 6,
    };
  },

  // On site doing work: engine on, short bursts of tracked movement (slewing,
  // repositioning) with pauses between them. This is the phase that generates
  // most billable engine time.
  work: ({ i, rng, opts = {} }) => {
    const dutyCycle = opts.dutyCycle ?? 3; // move for 2 of every 3 ticks
    const moving = i % dutyCycle !== 0;
    return {
      ignition: true,
      movement: moving,
      speedKmh: moving ? 3 + Math.floor(rng() * 5) : 0,
      engineRunning: true,
      headingDelta: moving ? (rng() - 0.5) * 40 : 0,
    };
  },

  // Engine running, machine not moving (operator in the cab, queueing, waiting).
  // Distinct from `off` — this is the pattern an idle-too-long rule fires on.
  idle: () => ({
    ignition: true,
    movement: false,
    speedKmh: 0,
    engineRunning: true,
  }),

  // Key off at the end of a shift. The meter freezes at its final value.
  shutdown: () => ({
    ignition: false,
    movement: false,
    speedKmh: 0,
    engineRunning: false,
  }),

  // A sudden, hard deceleration mid-drive — the pattern a harsh-braking /
  // driver-behaviour rule fires on. `opts.toSpeedKmh` is the GPS speed this
  // tick lands on (the scenario should set it close to what the preceding
  // travel phase was cruising at minus a real drop, so the plan reads as one
  // continuous drive, not a teleport). The deceleration magnitude is a
  // SEPARATE quantity, `opts.gForce` — deliberately NOT derived from that
  // speed drop against the tick interval: a telemetry report every 60s is a
  // REPORTING rate, not how long the actual braking took (~1-2s in the real
  // world, invisible at this resolution). Speed-drop-over-60s would compute a
  // tame fraction of a g and mislabel ordinary deceleration as "harsh".
  //
  // Units: Teltonika's Green Driving feature (AVL 253/254) reports the
  // magnitude in g, not m/s^2 — confirmed against wiki.teltonika-gps.com's
  // "Green Driving Solution" page and the FTC921 parameter table (0.01
  // multiplier, "g*100" for accel/braking). ~0.4g is a commonly-cited
  // harsh-braking onset in fleet telematics; 0.75g (hard, "traffic ahead"
  // braking, well short of a ~1g emergency stop) is the default here.
  brake: ({ i, opts = {} }) => {
    const toSpeedKmh = opts.toSpeedKmh ?? 8;
    const gForce = opts.gForce ?? 0.75; // g — see unit note above
    const first = i === 0;
    return {
      ignition: true,
      movement: true,
      speedKmh: toSpeedKmh,
      engineRunning: true,
      harshEventType: first ? 'brake' : null,
      // g x 100 — the actual wire unit AVL 254 uses (1 byte, 0-255).
      harshEventValue: first ? Math.round(gForce * 100) : null,
    };
  },

  // Power cut / harness pulled: the unit falls back to its internal battery,
  // external voltage collapses, and it stops reporting ignition at all — it
  // no longer has a live vehicle bus to read. Ignition is `null` (unknown),
  // NOT false: "I cannot see the key" is not "the key is off" (invariant 3).
  unplugged: ({ i, opts = {} }) => ({
    ignition: null,
    movement: null,
    speedKmh: 0,
    engineRunning: false,
    externalVoltageMv: 0,
    batteryPct: Math.max(0, (opts.batteryPct ?? 100) - i * (opts.drainPctPerTick ?? 5)),
    unplugEvent: i === 0,
  }),
};

/**
 * Flatten a phase plan into one signals object per tick.
 * @param plan  [{ phase: 'work', ticks: 10, opts? }, ...]
 * @param rng   seeded PRNG shared across the whole track
 * @returns array of signals, length = sum of ticks
 */
export function runPhasePlan(plan, rng) {
  const out = [];
  for (const step of plan) {
    const fn = PHASES[step.phase];
    if (!fn) {
      throw new Error(
        `unknown phase "${step.phase}" — known phases: ${Object.keys(PHASES).join(', ')}`,
      );
    }
    const ticks = step.ticks ?? 1;
    for (let i = 0; i < ticks; i++) {
      out.push({ phase: step.phase, ...fn({ i, ticks, rng, opts: step.opts }) });
    }
  }
  return out;
}
