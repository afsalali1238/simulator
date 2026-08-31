// ─────────────────────────────────────────────────────────────────────────────
// config.js — one place for all runtime configuration.
//
// Loads .env if present (Node 20.12+ / 22 has process.loadEnvFile built in, so
// there is no dotenv dependency). Everything else reads from here so the dev
// team has a single file to point at AWS later.
// ─────────────────────────────────────────────────────────────────────────────

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load .env from the folder root if it exists. Never throws if the file is
// missing (tests and CI can inject env directly).
try {
  process.loadEnvFile(resolve(ROOT, '.env'));
} catch {
  /* no .env file — use process.env / defaults below */
}

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

export const config = {
  root: ROOT,

  // Which store adapter to use: 'memory' (zero-setup, in-process) or 'pg'
  // (real PostgreSQL via Docker). Defaults to memory so the harness runs with
  // nothing installed; switch to pg once `docker compose up` is running.
  db: (process.env.DB || 'memory').toLowerCase(),

  // Full-access connection (owns the schema). Used by ingestion, the SQL
  // loader, and tests that need to set up data.
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://dozr:dozr@localhost:5432/dozr_telematics',

  // Restricted app role — RLS applies to it. Used by the API and the tenancy
  // test. Falls back to the owner URL if not set (RLS test will detect that).
  appDatabaseUrl:
    process.env.APP_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgres://dozr_app:dozr_app@localhost:5432/dozr_telematics',

  ingest: {
    host: process.env.INGEST_HOST || '0.0.0.0',
    port: int(process.env.INGEST_PORT, 5027),
  },

  api: {
    port: int(process.env.API_PORT, 8080),
  },

  sim: {
    host: process.env.SIM_SERVER_HOST || '127.0.0.1',
    port: int(process.env.SIM_SERVER_PORT, 5027),
    devices: int(process.env.SIM_DEVICES, 1),
    intervalMs: int(process.env.SIM_INTERVAL_MS, 1000),
    codec: (process.env.SIM_CODEC || '8E').toUpperCase(), // '8' or '8E'
    // Named scenario from src/simulator/scenarios.js (default 'day-cycle').
    // Override on the CLI with `--scenario <name>` or SIM_SCENARIO=<name>.
    scenario: process.env.SIM_SCENARIO || 'day-cycle',
    // Records per device per run when a scenario is replayed as a batch
    // (0/absent = stream indefinitely on the interval, the old behaviour).
    records: int(process.env.SIM_RECORDS, 0),
  },

  // ── Operability (P0) ────────────────────────────────────────────────────────
  log: {
    level: (process.env.LOG_LEVEL || 'info').toLowerCase(), // debug|info|warn|error|silent
    format: (process.env.LOG_FORMAT || 'json').toLowerCase(), // json|kv
  },

  // Hard deadline for a graceful drain on SIGINT/SIGTERM before we force exit.
  // Keep it below the orchestrator's kill grace period (ECS default 30s).
  shutdownTimeoutMs: int(process.env.SHUTDOWN_TIMEOUT_MS, 10000),

  // Test-only hook. See .env.example.
  failBeforeCommit: process.env.FAIL_BEFORE_COMMIT === '1',
};

// ─────────────────────────────────────────────────────────────────────────────
// The IO-parameter map = our stand-in for a Teltonika "CAN program number" (the
// open decision D1). On real hardware, which IO IDs carry which signal depends
// on the FMC + CAN adapter program for that exact make/model/year. Here we fix
// a small, documented set so the simulator and decoder agree.
//
//   239, 240, 69 are the REAL Teltonika standard IO IDs for these signals.
//   ENGINE_HOURS_S is SIMULATED: a real total-engine-hours signal comes over
//   CAN and its ID is program-dependent — the dev team maps it per D1. We use a
//   1-byte-safe ID so it encodes in both Codec 8 and 8E, carried as a 4-byte
//   unsigned "engine-on seconds" counter (monotonic, like an hour-meter).
// ─────────────────────────────────────────────────────────────────────────────
export const IO = {
  IGNITION: 239, // 1 byte, 0/1 — Teltonika standard
  MOVEMENT: 240, // 1 byte, 0/1 — Teltonika standard
  GNSS_STATUS: 69, // 1 byte — Teltonika standard
  ENGINE_HOURS_S: 200, // 4 bytes, engine-on seconds — SIMULATED CAN param (D1)

  // Power/tamper signals the simulator can emit so the P3 rules engine has
  // realistic data to fire on. These are the documented FMB-series standard AVL
  // IDs; they are NOT decoded into canonical rows yet (no rule consumes them),
  // so nothing downstream depends on the exact numbers.
  //   ⚠ protocol-engineer: confirm against context/teltonika/ before any rule
  //   or decode path starts reading them.
  EXTERNAL_VOLTAGE_MV: 66, // 2 bytes, mV — external (vehicle) supply
  BATTERY_LEVEL_PCT: 113, // 1 byte, % — internal backup battery
  UNPLUG_DETECTED: 252, // 1 byte, 0/1 — power-cut / unplug event
};

// Reverse lookup used by the decoder for readable logs.
export const IO_NAME = Object.fromEntries(
  Object.entries(IO).map(([k, v]) => [v, k]),
);
