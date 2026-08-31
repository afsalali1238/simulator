// ─────────────────────────────────────────────────────────────────────────────
// src/decode/engine-hours.js — D1: the CAN engine-hours mapping.
//
// This module is the resolution of open decision D1. It answers, in one place:
//   • WHICH Teltonika AVL IDs carry engine hours on an FMC130 + CAN adapter,
//   • what NATIVE UNIT each one is in,
//   • which of them may back an invoice, and which must never.
//
// Sources (retrieved 2026-08-31, both official Teltonika):
//   • FMC130 Data Sending Parameters ID —
//     wiki.teltonika-gps.com/view/FMC130_Teltonika_Data_Sending_Parameters_ID
//   • CAN adapter supported-vehicle list (ALL-CAN300) —
//     wiki.teltonika-gps.com/view/CAN_adapter_supported_vehicles
// The exact table rows are quoted in ../../D1_CAN_ENGINE_HOURS.md.
//
// ── THE UNIT TRAP (read before touching anything here) ───────────────────────
// Teltonika reports Engine Worktime in **MINUTES**, not seconds. The harness's
// old stand-in (IO 200, "engine-on seconds") was in seconds. Feeding a minutes
// value into a seconds-shaped contract inflates every billed figure by 60× and
// **every invariant test still passes**, because the pipeline is unit-agnostic —
// only the meaning is wrong. So units are declared per ID here and converted
// once, at the decode boundary, into canonical seconds.
//
// ── 102 vs 103: THE DISTINCTION THAT DECIDES WHETHER A NUMBER CAN BE BILLED ──
// Teltonika exposes two engine-hour counters and they are NOT interchangeable:
//
//   102 "Engine Worktime"            — the MACHINE's own lifetime hour-meter,
//                                      read off the CAN bus. Reconcilable against
//                                      the physical dashboard hour-meter, which
//                                      is what makes it dispute evidence.
//   103 "Engine Worktime (counted)"  — counted BY THE TRACKER from zero, starting
//                                      when the CAN adapter was installed. It is
//                                      a device-side accumulator, not the
//                                      machine's meter. It cannot be reconciled
//                                      against the dashboard, and it resets if
//                                      the adapter is swapped.
//
// Only **102** is billing evidence. 103 is deliberately DROPPED here rather than
// quietly relabelled `source: 'ecu'` — a tracker-side accumulator masquerading as
// an ECU lifetime meter is exactly the ecu/estimated merge invariant 4 forbids,
// and it is the same class of mistake as billing an ignition counter (invariant
// 5). If a machine's program exposes only 103, the honest outcome is NO engine
// data for that machine until it is fixed, not a plausible-looking number.
//
// AVL ID 449 "Ignition On Counter" (4B, seconds) also exists on this device and
// is a genuinely tempting shortcut. It is FORBIDDEN as billing evidence
// (invariant 5) and is listed below only so nobody "discovers" it later.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every AVL ID that could plausibly be read as engine hours on an FMC130,
 * with what it actually is. `billable: true` means: this is the machine's own
 * ECU lifetime meter and may back an invoice, once reconciled (see below).
 */
export const ENGINE_HOURS_SOURCES = {
  102: {
    id: 102,
    name: 'Engine Worktime',
    bytes: 4,
    unit: 'min',
    toSeconds: (v) => v * 60,
    adapters: ['LV-CAN200', 'ALL-CAN300', 'CAN-CONTROL'],
    billable: true,
    note:
      "The machine's own lifetime hour-meter read from CAN. Reconcilable " +
      'against the physical dashboard meter — this is the billing parameter.',
  },
  103: {
    id: 103,
    name: 'Engine Worktime (counted)',
    bytes: 4,
    unit: 'min',
    toSeconds: (v) => v * 60,
    adapters: ['ALL-CAN300', 'CAN-CONTROL'],
    billable: false,
    note:
      'Counted by the TRACKER from zero at CAN-adapter installation. Not the ' +
      "machine's meter, not reconcilable, resets on adapter swap. Never bill it.",
  },
};

/**
 * Signals that must never become billing evidence, kept explicit so a future
 * change has to argue with a named invariant instead of an empty comment.
 */
export const FORBIDDEN_AS_BILLING_EVIDENCE = {
  449: {
    id: 449,
    name: 'Ignition On Counter',
    unit: 's',
    reason:
      'Accumulated ignition-on time, not ECU engine hours. Invariant 5: an ' +
      'ignition counter may inform a display, never an invoice.',
  },
  200: {
    id: 200,
    name: 'Sleep Mode',
    unit: '-',
    reason:
      'The harness previously used 200 as an engine-hours STAND-IN. On real ' +
      'firmware 200 is Sleep Mode — a permanent I/O element with an unrelated ' +
      'meaning. Reading it as engine hours would be silently wrong.',
  },
};

/** AVL ID 100 — the adapter reports which CAN program it is running. */
export const PROGRAM_NUMBER_ID = 100;

/** The billable engine-hours ID, in preference order (highest trust first). */
export const BILLABLE_ENGINE_HOURS_IDS = Object.values(ENGINE_HOURS_SOURCES)
  .filter((s) => s.billable)
  .map((s) => s.id);

/**
 * Convert a raw engine-hours reading to canonical seconds.
 * @returns {{seconds:number, hours:number, sourceId:number, nativeUnit:string}|null}
 *          null when the ID is not a billable engine-hours source.
 */
export function toCanonicalSeconds(avlId, rawValue) {
  const src = ENGINE_HOURS_SOURCES[avlId];
  if (!src || !src.billable) return null;
  if (rawValue == null || !Number.isFinite(Number(rawValue))) return null;
  const seconds = src.toSeconds(Number(rawValue));
  return {
    seconds,
    hours: seconds / 3600,
    sourceId: src.id,
    nativeUnit: src.unit,
  };
}

/**
 * Pick the engine-hours reading to trust from a decoded record's IO elements.
 *
 * Returns `null` — meaning "no engine data", the safe answer — when nothing
 * billable is present. The `reason` on the rejection path is what a dispute
 * or a support call actually needs, so it is returned rather than swallowed.
 *
 * @param ioValues  {Map<number, number>|object} avlId -> raw value
 * @returns {{seconds,hours,sourceId,nativeUnit}|null}
 */
export function selectEngineHours(ioValues) {
  const get = (id) =>
    ioValues instanceof Map ? ioValues.get(id) : ioValues?.[id];
  for (const id of BILLABLE_ENGINE_HOURS_IDS) {
    const raw = get(id);
    if (raw !== undefined && raw !== null) {
      const conv = toCanonicalSeconds(id, raw);
      if (conv) return conv;
    }
  }
  return null;
}

/**
 * Explain why no billable engine hours were produced. For logs and dispute
 * packs — never for deciding to bill anyway.
 */
export function explainNoEngineHours(ioValues) {
  const get = (id) =>
    ioValues instanceof Map ? ioValues.get(id) : ioValues?.[id];
  const present = [];
  for (const [id, src] of Object.entries(ENGINE_HOURS_SOURCES)) {
    if (get(Number(id)) !== undefined) present.push({ id: Number(id), src });
  }
  const nonBillable = present.filter((p) => !p.src.billable);
  if (nonBillable.length) {
    return (
      `only non-billable engine counters present (` +
      nonBillable.map((p) => `${p.id} ${p.src.name}`).join(', ') +
      `) — needs AVL 102 (the machine's own hour-meter)`
    );
  }
  for (const id of Object.keys(FORBIDDEN_AS_BILLING_EVIDENCE).map(Number)) {
    if (get(id) !== undefined) {
      return `only ${id} (${FORBIDDEN_AS_BILLING_EVIDENCE[id].name}) present — forbidden as billing evidence`;
    }
  }
  return 'no engine-hours parameter reported (no CAN adapter, or the program does not expose one)';
}

// ── Reconciliation (the step that turns a number into evidence) ──────────────
// The invariants doc requires an ECU reading to be reconciled against the
// machine's physical hour-meter before it is trusted. A number that has not
// been reconciled is a reading, not evidence. This is the check, executable, so
// P2 cannot skip it by accident.

/** Default tolerance: hour-meters round, and a reading is taken at a moment. */
export const RECONCILE_TOLERANCE_HOURS = 1.0;

/**
 * Compare a decoded ECU value against a hand-read dashboard hour-meter.
 *
 * A 60× delta is called out by name because it is the single most likely
 * failure: a minutes value read as seconds, or vice versa.
 *
 * @param ecuHours        hours as decoded by this module
 * @param dashboardHours  hours a human read off the machine
 */
export function reconcile(ecuHours, dashboardHours, toleranceHours = RECONCILE_TOLERANCE_HOURS) {
  const deltaHours = ecuHours - dashboardHours;
  const ok = Math.abs(deltaHours) <= toleranceHours;
  const out = { ok, ecuHours, dashboardHours, deltaHours, toleranceHours };
  if (ok) return { ...out, verdict: 'reconciled' };

  const ratio = dashboardHours > 0 ? ecuHours / dashboardHours : Infinity;
  if (Math.abs(ratio - 60) < 6) {
    return {
      ...out,
      verdict: 'unit-error',
      hint: 'ECU value is ~60× the meter — a minutes value is being read as seconds.',
    };
  }
  if (Math.abs(ratio - 1 / 60) < 0.1) {
    return {
      ...out,
      verdict: 'unit-error',
      hint: 'ECU value is ~1/60th of the meter — a seconds value is being read as minutes.',
    };
  }
  if (Math.abs(ratio - 3600) < 360 || Math.abs(ratio - 1 / 3600) < 0.01) {
    return {
      ...out,
      verdict: 'unit-error',
      hint: 'ECU value differs from the meter by ~3600× — hours/seconds confusion.',
    };
  }
  return {
    ...out,
    verdict: 'mismatch',
    hint:
      'Not a unit factor. Wrong parameter, wrong program number, or the adapter ' +
      'is reading a different engine. Do not bill from this.',
  };
}
