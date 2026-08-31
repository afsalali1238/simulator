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
//   6  attribution at ts  — the caller passes the assignment that was IN FORCE at
//                            THIS record's timestamp (resolved upstream); we just
//                            apply it. Owner tenant is the fallback when unassigned.
//   9  unlisted machine   — engine hours are produced ONLY when the attributed
//                            asset has a supported CAN program (hasEngineData).
// ─────────────────────────────────────────────────────────────────────────────

import { IO } from '../config.js';
import { deriveState } from '../enrichment/state.js';

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
  const engRaw = ioValue(decoded, IO.ENGINE_HOURS_S);

  // invariant 3: absent -> null; present-but-zero -> false/0 (a real reading).
  const ignition = ignRaw === undefined ? null : Number(ignRaw) !== 0;
  const movement = movRaw === undefined ? null : Number(movRaw) !== 0;

  // invariant 6/7: attributed tenant is the assignment's, else the owner tenant.
  const tenantId = assignment?.tenantId ?? device.ownerTenantId;
  const assetId = assignment?.assetId ?? null;
  const hasEngineData = assignment?.hasEngineData === true;

  // invariants 9, 3, 4: only listed machines get engine hours; absent IO stays
  // null; CAN-derived is always 'ecu' and never merged with 'estimated'.
  let engine = null;
  if (hasEngineData && engRaw !== undefined) {
    const seconds = Number(engRaw);
    engine = { seconds, hours: seconds / 3600, source: 'ecu' };
  }

  const state = deriveState({ ignition, movement, speed: decoded.gps.speed });

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
    engine, // { seconds, hours, source:'ecu' } | null
  };
}
