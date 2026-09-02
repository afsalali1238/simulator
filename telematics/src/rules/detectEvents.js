import { distanceMeters } from '../simulator/phases.js';
import { createHash } from 'node:crypto';
import { SITE_JEBEL_ALI } from '../simulator/scenarios.js';

// ---------------------------------------------------------------------------
// Configurable thresholds (kept tiny and pure; override via the `config` param)
// ---------------------------------------------------------------------------
const DEFAULT_IDLE_TOO_LONG_MS = 3_600_000;   // 60 min of consecutive idle
const DEFAULT_BATTERY_LOW_PCT = 20;        // below this fires low-battery

// ---------------------------------------------------------------------------
// Deterministic dedupe identity
// hash(tenantId, assetId, type, windowKey) — windowKey is a stable fact such as
// the transition tick index, ignition-session start tick, or idle-spell start tick.
// Uses node:crypto (built-in, no npm dep).
// ---------------------------------------------------------------------------
function makeEventId(tenantId, assetId, type, windowKey) {
  const h = createHash('sha256');
  h.update(String(tenantId));
  h.update(String(assetId));
  h.update(type);
  h.update(String(windowKey));
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// detectEvents(records, { assetId, tenantId, config }) -> Event[]
//
// records      — ordered array of canonical records from the real pipeline
//   (resolveAssignment + normalizeRecord), already sorted by timestampMs.
// assetId      — optional; if supplied only events for that asset are kept
// tenantId     — optional; if supplied only events for that tenant are kept
// config       — { idleTooLongMs?, batteryLowPct? } overrides
//
// Returns Event[] each with a deterministic eventId so downstream delivery can
// drop duplicates (invariant 2: idempotent ingest).
export function detectEvents(records, { assetId, tenantId, config } = {}) {
  const idleTooLongMs = config?.idleTooLongMs ?? DEFAULT_IDLE_TOO_LONG_MS;
  const batteryLowPct = config?.batteryLowPct ?? DEFAULT_BATTERY_LOW_PCT;

  // Filter to the requested asset / tenant (cheap early-out)
  const filtered = records.filter((r) => {
    if (assetId && r.assetId !== assetId) return false;
    if (tenantId && r.tenantId !== tenantId) return false;
    return true;
  });

  const events = [];

  // ── Rule 1: Geofence enter / exit ─────────────────────────────────────────
  // Track membership across the sequence. Emit geofence-enter on false→true,
  // geofence-exit on true→false. Guard the first record (no prior membership →
  // no spurious event). Unknown membership (missing lat/lon) is silently ignored.
  const geofenceRecords = filtered.filter(
    (r) => r.lat != null && r.lon != null
  );

  let prevInside = null; // membership status of the prior record
  for (const r of geofenceRecords) {
    const inside = distanceMeters(
      { lat: r.lat, lon: r.lon },
      { lat: SITE_JEBEL_ALI.lat, lon: SITE_JEBEL_ALI.lon, radiusM: SITE_JEBEL_ALI.radiusM }
    ) <= SITE_JEBEL_ALI.radiusM;

    // First record we see: record the status, don't fire yet
    if (prevInside === null) {
      prevInside = inside;
      continue;
    }

    if (prevInside && !inside) {
      // true → false = exit
      events.push({
        type: 'geofence-exit',
        assetId: r.assetId,
        tenantId: r.tenantId,
        tsMs: r.tsMs,
        eventId: makeEventId(r.tenantId, r.assetId, 'geofence-exit', r.tsMs),
        detail: { site: SITE_JEBEL_ALI },
      });
    } else if (!prevInside && inside) {
      // false → true = enter
      events.push({
        type: 'geofence-enter',
        assetId: r.assetId,
        tenantId: r.tenantId,
        tsMs: r.tsMs,
        eventId: makeEventId(r.tenantId, r.assetId, 'geofence-enter', r.tsMs),
        detail: { site: SITE_JEBEL_ALI },
      });
    }

    prevInside = inside;
  }

  // ── Rule 2: Ignition outside working hours ────────────────────────────────
  // Working window: 07:00–18:00 local time (Asia/Dubai, UTC+4, no DST).
  // Fire after-hours-ignition ONLY when ignition === true.
  // ignition === null (unknown) is explicitly NOT a fire — we cannot assert the
  // engine is on.
  const WORKING_START_HOUR = 7; // 07:00 local GST
  const WORKING_END_HOUR = 18;  // 18:00 local GST

  for (const r of filtered) {
    if (r.ignition !== true) continue; // only true

    // Convert UTC ms to Gulf Standard Time (UTC+4, no DST)
    const utcMs = r.tsMs;
    const localMs = utcMs + 4 * 60 * 60 * 1000; // +4h offset
    const localDate = new Date(localMs);
    const localHour = localDate.getUTCHours(); // 0–23 in GST

    const isOutsideWindow =
      localHour < WORKING_START_HOUR || localHour >= WORKING_END_HOUR;

    if (isOutsideWindow) {
      events.push({
        type: 'after-hours-ignition',
        assetId: r.assetId,
        tenantId: r.tenantId,
        tsMs: r.tsMs,
        eventId: makeEventId(r.tenantId, r.assetId, 'after-hours-ignition', `hour-${localHour}`),
        detail: { localHour, workingWindow: [WORKING_START_HOUR, WORKING_END_HOUR] },
      });
    }
  }

  // ── Rule 3: Idle-too-long ────────────────────────────────────────────────
  // Fire `idle-too-long` when `state === 'idle'` has persisted longer than the
  // threshold. Compute dwell from consecutive idle records' tsMs; fire once per
  // idle spell, not once per record. Treat `state === 'unknown'` as NOT idle.
  let idleSpellStart = null; // tsMs when the current idle spell began

  for (const r of filtered) {
    if (r.state === 'idle') {
      if (idleSpellStart === null) {
        idleSpellStart = r.tsMs; // start of a new idle spell
      }
      // keep checking; we fire when the spell ends OR at the very end of the
      // record stream if it's still idle.
    } else {
      // idle spell ended — check duration
      if (idleSpellStart !== null) {
        const durationMs = r.tsMs - idleSpellStart;
        if (durationMs >= idleTooLongMs) {
          events.push({
            type: 'idle-too-long',
            assetId: r.assetId,
            tenantId: r.tenantId,
            tsMs: idleSpellStart + Math.floor(durationMs / 2), // midpoint of the spell
            eventId: makeEventId(r.tenantId, r.assetId, 'idle-too-long', `spell-${idleSpellStart}`),
            detail: { durationMs, thresholdMs: idleTooLongMs },
          });
        }
      }
      idleSpellStart = null; // reset for the next spell
    }
  }

  // If the stream ends while still idle, fire once at the end
  if (idleSpellStart !== null) {
    const last = filtered[filtered.length - 1];
    const durationMs = last.tsMs - idleSpellStart;
    if (durationMs >= idleTooLongMs) {
      events.push({
        type: 'idle-too-long',
        assetId: last.assetId,
        tenantId: last.tenantId,
        tsMs: last.tsMs,
        eventId: makeEventId(last.tenantId, last.assetId, 'idle-too-long', `spell-end`),
        detail: { durationMs, thresholdMs: idleTooLongMs, endsStream: true },
      });
    }
  }

  // ── Rule 4: Tamper / unplug ──────────────────────────────────────────────
  // Fire `tamper-unplug` on the unplug signal (IO 252 = 1) and/or external
  // voltage collapsing to ~0 while on external power.
  // Invariant 3 trap: a missing battery reading is null, not 0 — never raise a
  // "flat battery" alert because the signal was absent.
  //
  // Track unplug state: once the unplug event fires (unplug === 1 on a record),
  // it stays fired for the remainder of the stream. Also track external voltage;
  // if it collapses from >0 to ~0, that's also a tamper event.
  let tamperFired = false;
  let prevExternalVoltageMv = null;

  for (const r of filtered) {
    // If already fired, don't fire again (idempotent ingest, invariant 2)
    if (tamperFired) {
      // Still track voltage for detail, but no new events
      prevExternalVoltageMv = r.externalVoltageMv;
      continue;
    }

    // Unplug event: IO 252 = 1 on the record
    const unplugNow = r.unplug === 1;
    // External voltage collapsing: was present (>0) and now is ~0 (threshold <= 50 mV)
    const voltageCollapsed =
      prevExternalVoltageMv != null && prevExternalVoltageMv > 0 &&
      r.externalVoltageMv != null && r.externalVoltageMv <= 50;

    if (unplugNow || voltageCollapsed) {
      tamperFired = true;
      events.push({
        type: 'tamper-unplug',
        assetId: r.assetId,
        tenantId: r.tenantId,
        tsMs: r.tsMs,
        eventId: makeEventId(r.tenantId, r.assetId, 'tamper-unplug', `tick-${r.tsMs}`),
        detail: {
          unplug: unplugNow,
          externalVoltageMv: r.externalVoltageMv,
          previousExternalVoltageMv: prevExternalVoltageMv,
        },
      });
    }

    // Track state for next iteration
    prevExternalVoltageMv = r.externalVoltageMv;
  }

  // ── Rule 5: Low battery ──────────────────────────────────────────────────
  // Fire `low-battery` when battery level (batteryPct) is present and below
  // batteryLowPct threshold. A missing reading (null) must never trigger this —
  // that would be invariant 3 violated. Fire once per battery-low spell, not once
  // per record.
  let lowBattFired = false;
  let lowBattSpellStart = null; // tsMs when the current low-batt spell began

  for (const r of filtered) {
    // Skip if already fired (idempotent — already emitted the event)
    if (lowBattFired) {
      // Already emitted the event; just continue scanning
      continue;
    }

    if (r.batteryPct != null && r.batteryPct < batteryLowPct) {
      // Battery reading present and below threshold — fire once
      lowBattFired = true;
      lowBattSpellStart = r.tsMs;
      events.push({
        type: 'low-battery',
        assetId: r.assetId,
        tenantId: r.tenantId,
        tsMs: r.tsMs,
        eventId: makeEventId(r.tenantId, r.assetId, 'low-battery', `spell-${r.tsMs}`),
        detail: { batteryPct: r.batteryPct, thresholdPct: batteryLowPct },
      });
    }
    // If batteryPct is null or >= threshold, we do nothing (invariant 3:
    // absent is null, not 0 — never raise low-battery because signal was absent)
  }

  // If the stream ends while battery is still low, the event was already fired
  // on the first low-reading record — no second event needed (idempotent).

  return events;
}

// ---------------------------------------------------------------------------
// Exported constants used by tests and downstream modules
// ---------------------------------------------------------------------------
export { DEFAULT_IDLE_TOO_LONG_MS, DEFAULT_BATTERY_LOW_PCT };

// The site circle shared with the geofence scenario and tests
export { SITE_JEBEL_ALI };

// ---------------------------------------------------------------------------
// End of file
// ─────────────────────────────────────────────────────────────────────────────