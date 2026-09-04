-- ─────────────────────────────────────────────────────────────────────────────
-- db/schema.sql — PostgreSQL schema for the pg store adapter.
--
-- Runs on plain `postgres:16` (the docker-compose image) with ZERO extensions.
-- Production upgrades are additive and called out inline:
--   • position_records -> TimescaleDB hypertable
--   • lat/lon          -> PostGIS geography(Point,4326)
--   • raw/evidence     -> S3-compatible cold storage tier
--
-- Apply with:  npm run db:schema   (then npm run db:seed)
-- ─────────────────────────────────────────────────────────────────────────────

-- App role for tenant-facing reads. RLS applies to it because it does NOT own
-- the tables. The ingest worker connects as the owner and bypasses RLS to write.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dozr_app') THEN
    CREATE ROLE dozr_app LOGIN PASSWORD 'dozr_app';
  END IF;
END$$;

DROP TABLE IF EXISTS engine_readings, position_records, raw_frames,
  device_assignment, assets, devices, tenants CASCADE;

CREATE TABLE tenants (
  id   uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE devices (
  id              uuid PRIMARY KEY,
  imei            text UNIQUE NOT NULL,
  model           text NOT NULL,
  firmware        text,
  owner_tenant_id uuid NOT NULL REFERENCES tenants(id),
  status          text NOT NULL DEFAULT 'active'
);

CREATE TABLE assets (
  id              uuid PRIMARY KEY,
  type            text NOT NULL,
  make            text,
  model           text,
  year            int,
  program_number  text,                         -- NULL => no supported CAN program (D1)
  has_engine_data boolean NOT NULL DEFAULT false
);

-- Dated ownership. A machine changes hands; each record is billed to whoever
-- held it AT THAT MOMENT (invariant 6). NULL valid_to => still in force.
CREATE TABLE device_assignment (
  id         uuid PRIMARY KEY,
  device_id  uuid NOT NULL REFERENCES devices(id),
  asset_id   uuid NOT NULL REFERENCES assets(id),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  valid_from timestamptz NOT NULL,
  valid_to   timestamptz,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX device_assignment_lookup ON device_assignment (device_id, valid_from, valid_to);

-- Evidence root: exactly the bytes we received. Immutable (trigger below). This
-- is what a utilisation dispute is ultimately proven against (invariant 8).
CREATE TABLE raw_frames (
  id           uuid PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES devices(id),
  imei         text NOT NULL,
  codec_id     int  NOT NULL,
  record_count int  NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  raw          bytea NOT NULL
);

-- Position history. PROD: SELECT create_hypertable('position_records','received')
-- and make (lat,lon) a PostGIS point. Here: plain columns + btree, zero extensions.
CREATE TABLE position_records (
  id           uuid PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES devices(id),
  asset_id     uuid REFERENCES assets(id),        -- NULL when unassigned
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  ts_ms        bigint NOT NULL,                    -- device event time (epoch ms)
  lat          double precision,
  lon          double precision,
  speed        int,
  angle        int,
  altitude     int,
  satellites   int,
  priority     int,
  ignition     boolean,                            -- NULL != false (invariant 3)
  movement     boolean,
  state        text NOT NULL,
  -- Decoded by src/decode/normalize.js. All nullable on purpose: absent is not
  -- zero (invariant 3). position_valid is what stops a no-fix record (lat/lon
  -- 0,0 = a real place in the Gulf of Guinea) being read as a genuine position
  -- by the geofence rules.
  position_valid      boolean,
  external_voltage_mv int,
  battery_pct         int,
  unplug              int,
  raw_frame_id uuid NOT NULL REFERENCES raw_frames(id),
  UNIQUE (device_id, ts_ms)                        -- idempotency key (invariant 2)
);
CREATE INDEX position_records_scoped ON position_records (tenant_id, device_id, ts_ms);

CREATE TABLE engine_readings (
  id             uuid PRIMARY KEY,
  asset_id       uuid NOT NULL REFERENCES assets(id),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  ts_ms          bigint NOT NULL,
  engine_seconds bigint NOT NULL,
  engine_hours   numeric(12,4) NOT NULL,
  source         text NOT NULL CHECK (source IN ('ecu','estimated')),  -- invariant 4
  raw_frame_id   uuid NOT NULL REFERENCES raw_frames(id),
  UNIQUE (asset_id, ts_ms, source)                 -- idempotency (invariant 2)
);
CREATE INDEX engine_readings_scoped ON engine_readings (tenant_id, asset_id, ts_ms);

-- ── Evidence immutability (invariant 8) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'raw_frames is append-only (evidence root, invariant 8)';
END$$ LANGUAGE plpgsql;

CREATE TRIGGER raw_frames_immutable
  BEFORE UPDATE OR DELETE ON raw_frames
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Row-level security (invariant 7) ─────────────────────────────────────────
-- The tenant-facing API connects as dozr_app and runs `set_config('app.tenant', <uuid>, true)`
-- per request. current_setting(..., true) returns NULL if unset, so the default
-- is deny-all (no tenant context => no rows).
ALTER TABLE position_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_readings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices          ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_pos ON position_records
  FOR SELECT TO dozr_app
  USING (tenant_id = current_setting('app.tenant', true)::uuid);

CREATE POLICY tenant_isolation_eng ON engine_readings
  FOR SELECT TO dozr_app
  USING (tenant_id = current_setting('app.tenant', true)::uuid);

CREATE POLICY tenant_isolation_dev ON devices
  FOR SELECT TO dozr_app
  USING (
    owner_tenant_id = current_setting('app.tenant', true)::uuid
    OR EXISTS (
      SELECT 1 FROM position_records p
      WHERE p.device_id = devices.id
        AND p.tenant_id = current_setting('app.tenant', true)::uuid
    )
  );

GRANT USAGE ON SCHEMA public TO dozr_app;
GRANT SELECT ON position_records, engine_readings, devices, assets TO dozr_app;
