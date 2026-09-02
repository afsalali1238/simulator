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
  // Invariant 3 trap: `r.unplug` and `r.externalVoltageMv` are `null` when the
  // signal is genuinely absent (no power IO modeled for this scenario/device)
  // — that must never be treated as "collapsed", only a real bad reading on
  // EITHER signal counts. Covered by a dedicated negative test.
  //
  // EPISODE-based, not fire-once-per-lifetime: a device can genuinely be
  // unplugged more than once over its life, and each occurrence is a real,
  // separate incident worth its own alert — same reasoning as idle-too-long
  // being spell-based rather than "idle at all, ever". `tamperActive` tracks
  // whether we're currently inside a bad episode; it re-arms as soon as
  // BOTH signals stop being bad (unplug clears AND voltage is not collapsed —
  // absence/null on a signal never counts as "still bad"), so the NEXT
  // genuine incident fires its own event with its own eventId (deterministic
  // from that episode's own tsMs, so a re-run of the same records still
  // dedupes correctly — invariant 2).
  //
  // Note: recovery is intentionally NOT a required before/after voltage
  // transition. An episode triggered purely by the unplug flag (no voltage IO
  // modeled at all, always null) must still be able to re-arm — requiring a
  // low→high voltage transition to clear it would leave `tamperActive` stuck
  // true forever on such a device, silently swallowing every later unplug.
  let tamperActive = false;

  for (const r of filtered) {
    const unplugBad = r.unplug === 1;
    const voltageBad = r.externalVoltageMv != null && r.externalVoltageMv <= 50;
    const currentlyBad = unplugBad || voltageBad;

    if (!tamperActive && currentlyBad) {
      tamperActive = true;
      events.push({
        type: 'tamper-unplug',
        assetId: r.assetId,
        tenantId: r.tenantId,
        tsMs: r.tsMs,
        eventId: makeEventId(r.tenantId, r.assetId, 'tamper-unplug', `tick-${r.tsMs}`),
        detail: {
          unplug: unplugBad,
          externalVoltageMv: r.externalVoltageMv,
        },
      });
    } else if (tamperActive && !currentlyBad) {
      tamperActive = false; // re-armed: a future incident fires its own event
    }
  }

  // ── Rule 5: Low battery ──────────────────────────────────────────────────
  // Fire `low-battery` when battery level (batteryPct) is present and below
  // batteryLowPct threshold. A missing reading (null) must NEVER trigger this
  // — invariant 3 — covered by a dedicated negative test, not just this
  // comment's say-so.
  //
  // EPISODE-based with a small hysteresis band, same reasoning as Rule 4: a
  // battery can genuinely go low, get recharged, and go low again — each is
  // its own incident. Recovery requires clearing `batteryLowPct + 10`, not
  // just crossing back over the exact same threshold, so a reading sitting
  // right at the line doesn't fire a new event on every tick's jitter.
  let lowBattActive = false;
  const batteryRecoverPct = batteryLowPct + 10;

  for (const r of filtered) {
    if (r.batteryPct == null) continue; // absent is not evidence either way

    if (!lowBattActive && r.batteryPct < batteryLowPct) {
      lowBattActive = true;
      events.push({
        type: 'low-battery',
        assetId: r.assetId,
        tenantId: r.tenantId,
        tsMs: r.tsMs,
        eventId: makeEventId(r.tenantId, r.assetId, 'low-battery', `spell-${r.tsMs}`),
        detail: { batteryPct: r.batteryPct, thresholdPct: batteryLowPct },
      });
    } else if (lowBattActive && r.batteryPct >= batteryRecoverPct) {
      lowBattActive = false; // re-armed: a future drop fires its own event
    }
  }

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