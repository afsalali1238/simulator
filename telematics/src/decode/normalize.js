// ─────────────────────────────────────────────────────────────────────────────
// src/decode/normalize.js — turn a decoded Teltonika AVL record into a canonical
// fact row. This is Module 2 (Decode/normalise). It is a PURE function, so every
// correctness invariant it enforces is unit-testable with no I/O (test/decode.test.js).
//
// Invariants enforced here (see Dozr_GPS_CLAUDE.md):
//   3  NULL ≠ zero        — an absent IO becomes null, never 0.
//   4  ecu vs estimated   — CAN-derived engine hours are always source 'ecu';
//                            'estimated' is produced by a different module and is
//                            never created here, so the two can never merge.
//   5  billing evidence   — only the MACHINE's own ECU hour-meter (AVL 102) can
//                            become an engine reading. A tracker-side accumulator
//                            (103) or an ignition counter (449) is refused, not
//                            relabelled. See src/decode/engine-hours.js.
//   6  attribution at ts  — the caller passes the assignment that was IN FORCE at
//                            THIS record's timestamp (resolved upstream); we just
//                            apply it. Owner tenant is the fallback when unassigned.
//   9  unlisted machine   — engine hours are produced ONLY when the attributed
//                            asset has a supported CAN program (hasEngineData).
//
// Units: AVL 102 is in MINUTES on the wire. The conversion to canonical seconds
// happens in engine-hours.js, once, so no caller has to remember it. Getting this
// wrong is a 60× billing error that no invariant test would catch — which is why
// the conversion lives in one audited place instead of inline here.
// ─────────────────────────────────────────────────────────────────────────────

import { IO, RETIRED_ENGINE_HOURS_STANDIN_ID } from '../config.js';
import { deriveState } from '../enrichment/state.js';
import { selectEngineHours, explainNoEngineHours } from './engine-hours.js';

// Returns the raw IO value or undefined if the element is absent.
// undefined is meaningful: it is how we keep NULL distinct from 0 (invariant 3).
export function ioValue(record, id) {
  const el = record.io?.find((e) => e.id === id);
  return el ? el.value : undefined;
}

/**
 * @param decoded    one record from readAvlFrame().packet.records
 * @param ctx.device the device row (needs id, imei, ownerTenantId)
 * @param ctx.assignment the assignment in force at decoded.timestampMs, or null
 * @returns a canonical record ready for the store
 */
export function normalizeRecord(decoded, { device, assignment }) {
  const ignRaw = ioValue(decoded, IO.IGNITION);
  const movRaw = ioValue(decoded, IO.MOVEMENT);

  // invariant 3: absent -> null; present-but-zero -> false/0 (a real reading).
  const ignition = ignRaw === undefined ? null : Number(ignRaw) !== 0;
  const movement = movRaw === undefined ? null : Number(movRaw) !== 0;

  // invariant 6/7: attributed tenant is the assignment's, else the owner tenant.
  const tenantId = assignment?.tenantId ?? device.ownerTenantId;
  const assetId = assignment?.assetId ?? null;
  const hasEngineData = assignment?.hasEngineData === true;

  // The engine-hours candidates present on this record, by AVL ID. Note that
  // AVL 200 is NOT among them: on real firmware 200 is Sleep Mode, and the old
  // stand-in that used it is retired. If a caller still sends 200 it is simply
  // not an engine-hours source, so no reading is produced (test asserts this).
  const engineIo = {
    [IO.ENGINE_WORKTIME_MIN]: ioValue(decoded, IO.ENGINE_WORKTIME_MIN),
    [IO.ENGINE_WORKTIME_COUNTED_MIN]: ioValue(decoded, IO.ENGINE_WORKTIME_COUNTED_MIN),
  };

  // invariants 9, 3, 4, 5: only listed machines get engine hours; an absent
  // reading stays null; the value must come from the machine's own hour-meter;
  // and CAN-derived readings are always 'ecu', never merged with 'estimated'.
  let engine = null;
  if (hasEngineData) {
    const picked = selectEngineHours(engineIo);
    if (picked) {
      engine = {
        seconds: picked.seconds,
        hours: picked.hours,
        source: 'ecu',
        // Kept on the row so a dispute pack can say WHICH parameter and unit a
        // billed figure came from, rather than asking someone to trust it.
        sourceAvlId: picked.sourceId,
        nativeUnit: picked.nativeUnit,
      };
    }
  }

  const state = deriveState({ ignition, movement, speed: decoded.gps.speed });

    // Power/tamper signals the simulator can emit so the P3 rules engine has
    // realistic data to fire on. Documented FMB-series standard AVL IDs; they are
    // NOT decoded into canonical rows yet, so nothing downstream depends on them
    // — but now that they are on the record, rules 4–5 (tamper/unplug, low-battery)
    // can fire. Invariant 3 governs: absent = null, never 0/false.
    const rawExternalVoltageMv = ioValue(decoded, IO.EXTERNAL_VOLTAGE_MV); // null | number
    const rawBatteryPct = ioValue(decoded, IO.BATTERY_LEVEL_PCT); // null | number
    const rawUnplug = ioValue(decoded, IO.UNPLUG_DETECTED); // null | number (0/1)
    const externalVoltageMv = rawExternalVoltageMv !== undefined ? rawExternalVoltageMv : null;
    const batteryPct = rawBatteryPct !== undefined ? rawBatteryPct : null;
    const unplug = rawUnplug !== undefined ? rawUnplug : null;

    return {
      deviceId: device.id,
      imei: device.imei,
      tenantId,
      assetId,
      tsMs: decoded.timestampMs,
      lat: decoded.gps.lat,
      lon: decoded.gps.lon,
      speed: decoded.gps.speed,
      angle: decoded.gps.angle,
      altitude: decoded.gps.altitude,
      satellites: decoded.gps.satellites,
      priority: decoded.priority,
      ignition, // bool | null
      movement, // bool | null
      state, // off | idle | moving | unknown
      engine, // { seconds, hours, source:'ecu', sourceAvlId, nativeUnit } | null
      externalVoltageMv, // null | number (mV)
      batteryPct, // null | number (%)
      unplug, // null | number (0/1)
    };
  }

/**
 * Why this record produced no billable engine reading. Diagnostic only — for
 * logs, run-books, and dispute packs. Never a reason to bill anyway.
 */
export function engineHoursDiagnostic(decoded, { assignment } = {}) {
  if (assignment?.hasEngineData !== true) {
    return assignment
      ? `asset has no supported CAN program (hasEngineData=false) — invariant 9`
      : `no assignment covers this timestamp — owner-tenant fallback, no engine data`;
  }
  const io = {
    [IO.ENGINE_WORKTIME_MIN]: ioValue(decoded, IO.ENGINE_WORKTIME_MIN),
    [IO.ENGINE_WORKTIME_COUNTED_MIN]: ioValue(decoded, IO.ENGINE_WORKTIME_COUNTED_MIN),
    [IO.IGNITION_ON_COUNTER_S]: ioValue(decoded, IO.IGNITION_ON_COUNTER_S),
    [RETIRED_ENGINE_HOURS_STANDIN_ID]: ioValue(decoded, RETIRED_ENGINE_HOURS_STANDIN_ID),
  };
  return explainNoEngineHours(io);
}

