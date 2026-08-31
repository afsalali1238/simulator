// ─────────────────────────────────────────────────────────────────────────────
// src/store/pg-store.js — PostgreSQL store adapter (the production path).
//
// This is the adapter you run locally against Docker Postgres and later against
// RDS on AWS. It uses the standard `pg` driver (install with `npm install`).
// It is NOT imported unless DB=pg, so the memory path needs no npm install.
//
// Two connection pools by design, matching a real deployment:
//   • writer  — the ingest worker (owner role). Bypasses RLS to persist.
//   • reader  — the tenant-facing API (dozr_app role). RLS-constrained; every
//               read runs inside a tx that sets app.tenant (invariant 7).
//
// NOTE: this adapter cannot run in the build sandbox (no Docker/Postgres there),
// so the executed test suite uses the memory adapter. This file mirrors that
// adapter's semantics 1:1 and is exercised by the same tests when you run them
// with DB=pg on your machine (see README "Run the tests against Postgres").
// ─────────────────────────────────────────────────────────────────────────────

import pg from 'pg';
import { config } from '../config.js';

export function createPgStore(opts = {}) {
  const writer = new pg.Pool({
    connectionString: opts.databaseUrl ?? config.databaseUrl,
  });
  const reader = new pg.Pool({
    connectionString: opts.appDatabaseUrl ?? config.appDatabaseUrl,
  });

  // Run fn inside a tx with app.tenant set (RLS scope), then commit.
  async function withTenant(tenantId, fn) {
    const c = await reader.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.tenant', tenantId]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  return {
    kind: 'pg',

    async init() {
      /* schema/seed applied via `npm run db:reset` */
    },
    async close() {
      await writer.end();
      await reader.end();
    },

    async deviceByImei(imei) {
      const { rows } = await writer.query(
        `SELECT id, imei, model, firmware,
                owner_tenant_id AS "ownerTenantId", status
           FROM devices WHERE imei = $1`,
        [imei],
      );
      return rows[0] ?? null;
    },

    // invariant 6: the assignment in force at THIS record's timestamp.
    async resolveAssignment(deviceId, tsMs) {
      const { rows } = await writer.query(
        `SELECT da.id          AS "assignmentId",
                da.asset_id     AS "assetId",
                da.tenant_id    AS "tenantId",
                a.has_engine_data AS "hasEngineData",
                a.program_number  AS "programNumber"
           FROM device_assignment da
           JOIN assets a ON a.id = da.asset_id
          WHERE da.device_id = $1
            AND to_timestamp($2 / 1000.0) >= da.valid_from
            AND (da.valid_to IS NULL OR to_timestamp($2 / 1000.0) < da.valid_to)
          ORDER BY da.valid_from DESC
          LIMIT 1`,
        [deviceId, tsMs],
      );
      return rows[0] ?? null;
    },

    // ATOMIC + DURABLE + IDEMPOTENT. Commits raw frame + all rows in one tx.
    async persistPacket({ device, imei, codecId, rawFrame, canonical }) {
      const c = await writer.connect();
      try {
        await c.query('BEGIN');
        const frameId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0]
          .id;

        await c.query(
          `INSERT INTO raw_frames (id, device_id, imei, codec_id, record_count, raw)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [frameId, device.id, imei, codecId, canonical.length, rawFrame],
        );

        let inserted = 0;
        let deduped = 0;
        for (const r of canonical) {
          const res = await c.query(
            `INSERT INTO position_records
               (id, device_id, asset_id, tenant_id, ts_ms, lat, lon, speed, angle,
                altitude, satellites, priority, ignition, movement, state, raw_frame_id)
             VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (device_id, ts_ms) DO NOTHING`,
            [
              r.deviceId, r.assetId, r.tenantId, r.tsMs, r.lat, r.lon, r.speed,
              r.angle, r.altitude, r.satellites, r.priority, r.ignition,
              r.movement, r.state, frameId,
            ],
          );
          if (res.rowCount === 1) {
            inserted++;
            if (r.engine) {
              await c.query(
                `INSERT INTO engine_readings
                   (id, asset_id, tenant_id, ts_ms, engine_seconds, engine_hours, source, raw_frame_id)
                 VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (asset_id, ts_ms, source) DO NOTHING`,
                [
                  r.assetId, r.tenantId, r.tsMs, r.engine.seconds,
                  r.engine.hours, r.engine.source, frameId,
                ],
              );
            }
          } else {
            deduped++;
          }
        }

        // durability boundary (invariant 1): fail here => full rollback, no ACK.
        if (config.failBeforeCommit) {
          throw new Error('injected failure before commit (FAIL_BEFORE_COMMIT=1)');
        }
        await c.query('COMMIT');
        return { records: canonical.length, inserted, deduped };
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },

    async getDevices(tenantId) {
      return withTenant(tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT id, imei, model, status FROM devices ORDER BY imei`,
        );
        return rows;
      });
    },

    async getPositions(tenantId, { deviceId, sinceMs = 0, limit = 100 } = {}) {
      return withTenant(tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT device_id AS "deviceId", asset_id AS "assetId", ts_ms AS "tsMs",
                  lat, lon, speed, ignition, movement, state
             FROM position_records
            WHERE ($1::uuid IS NULL OR device_id = $1) AND ts_ms >= $2
            ORDER BY ts_ms
            LIMIT $3`,
          [deviceId ?? null, sinceMs, limit],
        );
        return rows;
      });
    },

    async getLatestEngineHours(tenantId, assetId) {
      return withTenant(tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT asset_id AS "assetId", ts_ms AS "tsMs",
                  engine_hours AS "hours", source
             FROM engine_readings
            WHERE asset_id = $1
            ORDER BY ts_ms DESC
            LIMIT 1`,
          [assetId],
        );
        return rows[0] ?? null;
      });
    },

    async countPositions() {
      const { rows } = await writer.query('SELECT count(*)::int AS n FROM position_records');
      return rows[0].n;
    },
  };
}
