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
// The Teltonika AVL IO IDs this harness speaks. All of these are now the REAL
// documented IDs for an FMC130 — decision D1 is resolved at the parameter level
// (see src/decode/engine-hours.js and ../D1_CAN_ENGINE_HOURS.md).
//
//   239, 240, 69          Teltonika standard permanent I/O elements.
//   100                   the CAN program number the adapter is running.
//   102                   Engine Worktime — the MACHINE's lifetime hour-meter,
//                         in MINUTES. This is the billing parameter.
//   103                   Engine Worktime (counted) — counted by the TRACKER
//                         from adapter installation, also minutes. NOT billable.
//
// ⚠ 200 is **Sleep Mode** on real firmware. Earlier versions of this harness
// used 200 as an "engine-on seconds" stand-in while D1 was open; that stand-in
// is gone. Anything still reading 200 as engine hours is a bug — the decoder
// refuses it, and a test asserts the refusal.
//
// Which of these a given machine actually reports depends on its CAN program
// (AVL 100). The per-machine program numbers are in ../D1_CAN_ENGINE_HOURS.md;
// the decoder's behaviour does not change with them, only the data does.
// ─────────────────────────────────────────────────────────────────────────────
export const IO = {
  IGNITION: 239, // 1 byte, 0/1 — Teltonika standard
  MOVEMENT: 240, // 1 byte, 0/1 — Teltonika standard
  GNSS_STATUS: 69, // 1 byte — Teltonika standard

  // ── CAN adapter (LV-CAN200 / ALL-CAN300 / CAN-CONTROL) ──
  CAN_PROGRAM_NUMBER: 100, // 4 bytes — which program the adapter is running
  ENGINE_WORKTIME_MIN: 102, // 4 bytes, MINUTES — billable (machine's hour-meter)
  ENGINE_WORKTIME_COUNTED_MIN: 103, // 4 bytes, MINUTES — tracker-counted, NOT billable

  // Power/tamper signals the simulator can emit so the P3 rules engine has
  // realistic data to fire on. Documented FMB-series standard AVL IDs; they are
  // NOT decoded into canonical rows yet, so nothing downstream depends on them.
  EXTERNAL_VOLTAGE_MV: 66, // 2 bytes, mV — external (vehicle) supply
  BATTERY_LEVEL_PCT: 113, // 1 byte, % — internal backup battery
  UNPLUG_DETECTED: 252, // 1 byte, 0/1 — power-cut / unplug event

  // Present so nobody re-discovers it as a shortcut: accumulated ignition-on
  // seconds. Invariant 5 — it may inform a display, never an invoice.
  IGNITION_ON_COUNTER_S: 449,

  // "Green driving" / harsh-event detection — documented Teltonika standard
  // AVL IDs on accelerometer-equipped units (the FMC130 has one). Fired once,
  // on the record that captures the event; NOT decoded into canonical rows
  // yet (same status as the power/tamper IDs above) — this is data-plane only
  // until a rule/decoder consumes it.
  //
  // Confirmed against two independent Teltonika sources (wiki.teltonika-gps.com,
  // "Green Driving Solution" + the FTC921 parameter table) after this repo's own
  // first draft got AVL 254 wrong: it is 1 byte, not 2, and the unit is g×100
  // (multiplier 0.01), not deci-m/s^2. e.g. 75 = 0.75g, NOT 7.5 m/s^2 as first
  // implemented — see the fix commit for the correction.
  GREEN_DRIVING_TYPE: 253, // 1 byte — 1 harsh accel, 2 harsh braking, 3 harsh cornering
  GREEN_DRIVING_VALUE: 254, // 1 byte — magnitude, g x 100 (e.g. 75 = 0.75g), 0-255 (0-2.55g)

  // ── FMC130 permanent I/O elements ──
  // Confirmed against the FMC130-specific "Data Sending Parameters ID" wiki
  // page and the FMC130 Features settings page (see
  // context/simulator/FMC130_FIDELITY_PLAN.md for the full source list).
  // Only wired for D1, the device this repo labels FMC130 — D2 (FMC920) is a
  // different model and is deliberately left alone.
  DATA_MODE: 80, // 1 byte, 0-5 — network/service mode (0 = home network, GPRS)
  GSM_SIGNAL: 21, // 1 byte, 0-5 — signal strength bars
  GNSS_PDOP: 181, // 2 bytes, x0.1 — position dilution of precision
  GNSS_HDOP: 182, // 2 bytes, x0.1 — horizontal dilution of precision
  SPEED: 24, // 2 bytes, km/h — the standalone speed IO element (in addition to
  // the GPS block's own speed field; a real unit sends both, and they agree)
  GSM_CELL_ID: 205, // 2 bytes — serving cell ID
  GSM_AREA_CODE: 206, // 2 bytes — location area code (LAC)
  ACTIVE_GSM_OPERATOR: 241, // 4 bytes — MCC+MNC of the serving network
  BATTERY_VOLTAGE_MV: 67, // 2 bytes, mV — internal backup battery voltage
  BATTERY_CURRENT_MA: 68, // 2 bytes, mA — internal battery charge/discharge current (magnitude)
  TRIP_ODOMETER_M: 199, // 4 bytes, metres — resets each time the engine restarts a trip
  TOTAL_ODOMETER_M: 16, // 4 bytes, metres — lifetime distance, never resets
  DIGITAL_INPUT_1: 1, // 1 byte — FMC130's datasheet lists Digital Input 1 as a
  // documented ignition-detection source, so this mirrors the ignition signal
  DIGITAL_INPUT_2: 2, // 1 byte — present, unwired in every scenario so far (0)
  ANALOG_INPUT_1: 9, // 2 bytes, mV — present, unwired in every scenario so far (0)
  DIGITAL_OUTPUT_1: 179, // 1 byte — present, never commanded in any scenario so far (0)
  AXIS_X: 17, // 2 bytes, mG — accelerometer
  AXIS_Y: 18, // 2 bytes, mG — accelerometer
  AXIS_Z: 19, // 2 bytes, mG — accelerometer (gravity, ~1000mG when flat and still)
  ICCID: 11, // 8 bytes — SIM identifier. Synthetic/deterministic per IMEI in
  // this harness (there is no real SIM behind a simulated device); included
  // because the field itself is a genuine permanent element on real firmware.

  // Deliberately NOT implemented, not gaps:
  //   AVL 12/13 (Fuel Used/Rate GPS) — GPS-speed-based fuel estimation makes
  //   no physical sense for D1, which is heavy machinery (an excavator/
  //   generator), not a road vehicle; its fuel/engine data source is the CAN
  //   adapter, not a GNSS-speed heuristic. Fabricating it would be exactly
  //   the invented-signal mistake invariant 3 exists to prevent.
  //   AVL 10 (SD Status) — the FMC130 datasheet's own Interface table lists
  //   no SD card slot (128MB internal flash only); this ID is on the generic
  //   cross-model wiki table but does not apply to this specific SKU.
};

/**
 * The retired stand-in. Kept as a named constant purely so the decoder can
 * refuse it loudly instead of silently treating Sleep Mode as engine hours.
 */
export const RETIRED_ENGINE_HOURS_STANDIN_ID = 200;


// Reverse lookup used by the decoder for readable logs.
export const IO_NAME = Object.fromEntries(
  Object.entries(IO).map(([k, v]) => [v, k]),
);
