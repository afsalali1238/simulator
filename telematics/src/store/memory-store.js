// ─────────────────────────────────────────────────────────────────────────────
// src/store/memory-store.js — in-process store adapter (zero dependencies).
//
// Faithfully models the invariants the Postgres adapter enforces in the DB:
//   • persistPacket is atomic: it stages everything, and only mutates state at
//     the "commit" point — an injected failure (cfg.failBeforeCommit) leaves the
//     store completely unchanged and throws, so the server never ACKs it.  (inv 1)
//   • idempotent on (deviceId, tsMs) for positions and (assetId, tsMs, source)
//     for engine readings — re-sent buffers never double-count.               (inv 2)
//   • raw frames are the immutable evidence root — never updated/deleted.      (inv 8)
//   • read methods are tenant-scoped — one tenant can't see another's rows.    (inv 7)
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import {
  DEVICES,
  ASSIGNMENTS,
  ASSETS,
  resolveAssignment as resolveFromSeed,
  deviceByImei as deviceFromSeed,
  assetById,
} from './seed-data.js';

export function createMemoryStore(opts = {}) {
  const devices = opts.devices ?? DEVICES;
  const assignments = opts.assignments ?? ASSIGNMENTS;

  const rawFrames = []; // append-only evidence
  const positions = new Map(); // `${deviceId}|${tsMs}` -> row
  const engine = new Map(); // `${assetId}|${tsMs}|${source}` -> row

  const posKey = (r) => `${r.deviceId}|${r.tsMs}`;
  const engKey = (assetId, tsMs, source) => `${assetId}|${tsMs}|${source}`;

  return {
    kind: 'memory',

    async init() {
      /* seed is already in memory */
    },
    async close() {
      /* nothing to release */
    },

    async deviceByImei(imei) {
      return deviceFromSeed(imei, devices);
    },

    async resolveAssignment(deviceId, tsMs) {
      const a = resolveFromSeed(deviceId, tsMs, assignments);
      if (!a) return null;
      const asset = assetById(a.assetId, ASSETS);
      return {
        assignmentId: a.id,
        assetId: a.assetId,
        tenantId: a.tenantId,
        hasEngineData: asset ? asset.hasEngineData : false,
        programNumber: asset ? asset.programNumber : null,
      };
    },

    // ATOMIC + DURABLE + IDEMPOTENT write. Stages, then commits in one shot.
    async persistPacket({ device, imei, codecId, rawFrame, canonical }) {
      // ── inside the "transaction": stage everything first ──
      const stagedPositions = [];
      const stagedEngine = [];
      let inserted = 0;
      let deduped = 0;

      const frameId = randomUUID();
      for (const c of canonical) {
        const pk = posKey(c);
        if (positions.has(pk)) {
          deduped++; // invariant 2: already have this record
          continue;
        }
        stagedPositions.push([pk, { ...c, id: randomUUID(), rawFrameId: frameId }]);
        if (c.engine) {
          const ek = engKey(c.assetId, c.tsMs, c.engine.source);
          if (!engine.has(ek)) {
            stagedEngine.push([
              ek,
              {
                id: randomUUID(),
                assetId: c.assetId,
                tenantId: c.tenantId,
                tsMs: c.tsMs,
                seconds: c.engine.seconds,
                hours: c.engine.hours,
                source: c.engine.source, // always 'ecu' here (invariant 4)
                rawFrameId: frameId,
              },
            ]);
          }
        }
        inserted++;
      }

      // ── the durability boundary (invariant 1) ──
      // Fail BEFORE commit: nothing above is applied, and we throw so the caller
      // (ingestion server) does NOT ACK. The device keeps its copy and resends.
      if (config.failBeforeCommit) {
        throw new Error('injected failure before commit (FAIL_BEFORE_COMMIT=1)');
      }

      // ── commit: apply atomically ──
      rawFrames.push({
        id: frameId,
        imei,
        deviceId: device.id,
        codecId,
        recordCount: canonical.length,
        receivedAt: Date.now(),
        raw: Buffer.isBuffer(rawFrame) ? Buffer.from(rawFrame) : rawFrame,
      });
      for (const [k, v] of stagedPositions) positions.set(k, v);
      for (const [k, v] of stagedEngine) engine.set(k, v);

      // ACK the FULL record count so the device clears its buffer, even when a
      // resend was entirely de-duplicated.
      return { records: canonical.length, inserted, deduped };
    },

    // ── read side (tenant-scoped: invariant 7) ──
    async getDevices(tenantId) {
      const ids = new Set();
      for (const p of positions.values()) if (p.tenantId === tenantId) ids.add(p.deviceId);
      return devices
        .filter((d) => ids.has(d.id) || d.ownerTenantId === tenantId)
        .map((d) => ({ id: d.id, imei: d.imei, model: d.model, status: d.status }));
    },

    async getPositions(tenantId, { deviceId, sinceMs = 0, limit = 100 } = {}) {
      return [...positions.values()]
        .filter(
          (p) =>
            p.tenantId === tenantId &&
            (!deviceId || p.deviceId === deviceId) &&
            p.tsMs >= sinceMs,
        )
        .sort((a, b) => a.tsMs - b.tsMs)
        .slice(0, limit)
        .map((p) => ({
          deviceId: p.deviceId,
          assetId: p.assetId,
          tsMs: p.tsMs,
          lat: p.lat,
          lon: p.lon,
          speed: p.speed,
          ignition: p.ignition,
          movement: p.movement,
          state: p.state,
        }));
    },

    async getLatestEngineHours(tenantId, assetId) {
      let latest = null;
      for (const e of engine.values()) {
        if (e.tenantId !== tenantId || e.assetId !== assetId) continue;
        if (!latest || e.tsMs > latest.tsMs) latest = e;
      }
      if (!latest) return null;
      return {
        assetId: latest.assetId,
        tsMs: latest.tsMs,
        hours: latest.hours,
        source: latest.source,
      };
    },

    // debug/test helpers (unscoped)
    async countPositions() {
      return positions.size;
    },
    async countRawFrames() {
      return rawFrames.length;
    },
    async countEngineReadings() {
      return engine.size;
    },
  };
}
