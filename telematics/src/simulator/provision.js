// ─────────────────────────────────────────────────────────────────────────────
// src/simulator/provision.js — platform onboarding for the simulated fleet.
//
// In the real provisioning lifecycle, once a unit is manufactured with its IMEI
// it is REGISTERED in the platform's device registry before it can stream — the
// registry is the allow-list the ingestion handshake enforces
// (server.js → store.deviceByImei). This module is that onboarding step for the
// generated fleet: it turns IMEIs into device-registry rows.
//
// Two output shapes, one per run mode:
//   • provisionFleet(imeis)  → in-memory device rows, passed to
//     createMemoryStore({ devices }) (memory-store.js reads opts.devices ?? DEVICES,
//     so the fleet is injected at construction — the committed seed fixtures are
//     NEVER mutated, per CLAUDE.md).
//   • provisioningSql(devices) → idempotent INSERTs for the Postgres path, applied
//     with src/tools/load-sql.js. The registry the pg ingest worker reads IS the
//     devices table, so "provisioning" in pg mode means these rows exist.
//
// Every device is provisioned to the OWNER tenant (Dozr) with NO assignment row.
// That is deliberate and is what makes the fleet a clean demonstration of the
// invariants: with no assignment covering any timestamp, normalize.js attributes
// each record to the owner tenant (invariant 7) and produces NO engine data —
// position + ignition only (invariant 9) — exactly like the seed's unassigned D2.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { TENANTS } from '../store/seed-data.js';
import { luhnValid, FMC130_TAC } from './imei.js';

// FMC130 is Dozr's device (user decision: "fmc130 is our product"). Firmware
// mirrors the seed devices so the generated fleet is indistinguishable from a
// real batch of the same model.
export const FMC130_MODEL = 'FMC130';
export const FMC130_FIRMWARE = '03.27.06';

// A fixed namespace UUID so device IDs are a deterministic function of the IMEI:
// the same IMEI always maps to the same id, in memory and in Postgres, run after
// run. Any constant, valid UUID works as a v5 namespace — this one is dedicated
// to the simulated fleet so its ids can never collide with the seed's.
const SIM_DEVICE_NAMESPACE = 'd0e1f2a3-b4c5-4d6e-8f90-112233445566';

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

/**
 * RFC 4122 version-5 (SHA-1, name-based) UUID. Deterministic: same name +
 * namespace → same UUID, every time. Used so a device's primary-key id is a
 * stable function of its IMEI and is valid for the pg `uuid` column.
 */
function uuidv5(name, namespace = SIM_DEVICE_NAMESPACE) {
  const hash = createHash('sha1')
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The deterministic device-registry id for an IMEI. */
export function deviceIdForImei(imei) {
  return uuidv5(imei);
}

/**
 * Turn a list of IMEIs into device-registry rows in the store's device shape
 * (see src/store/seed-data.js DEVICES: { id, imei, model, firmware,
 * ownerTenantId, status }). Owner-tenant-only, no assignment — see the file
 * header for why that is the point.
 *
 * A bad-Luhn IMEI is refused here: it is not fatal to the wire handshake (which
 * is format-only), but real onboarding would reject a checksum-invalid IMEI, and
 * refusing it keeps a typo from ever entering the registry.
 *
 * @param {string[]} imeis
 * @param {object} [opts]
 * @param {string} [opts.ownerTenantId] default Dozr (the owner tenant)
 * @param {string} [opts.model] default FMC130
 * @param {string} [opts.firmware] default the seed firmware
 * @returns {Array<{id,imei,model,firmware,ownerTenantId,status}>}
 */
export function provisionFleet(
  imeis,
  { ownerTenantId = TENANTS.DOZR.id, model = FMC130_MODEL, firmware = FMC130_FIRMWARE } = {},
) {
  if (!Array.isArray(imeis)) throw new Error('provisionFleet expects an array of IMEIs');
  return imeis.map((imei) => {
    if (!luhnValid(imei)) {
      throw new Error(`refusing to provision IMEI with an invalid Luhn checksum: ${imei}`);
    }
    return {
      id: deviceIdForImei(imei),
      imei,
      model,
      firmware,
      ownerTenantId,
      status: 'active',
    };
  });
}

// Single-quote a value for inline SQL. Every value here is machine-generated
// (UUIDs, digit strings, a fixed model/firmware/status), so this is belt-and-
// braces rather than a defence against untrusted input — but it keeps the emitted
// SQL correct if a caller ever passes an unusual model string.
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The idempotent provisioning SQL for the Postgres path: the same registry rows,
 * as INSERTs. `ON CONFLICT (imei) DO NOTHING` mirrors invariant 2's spirit at the
 * provisioning layer — re-running onboarding never duplicates a device — so the
 * SQL is safe to apply repeatedly (e.g. after each `db:reset`). Applied to the
 * OWNER connection, because it writes the registry the ingest worker reads.
 *
 * @param {Array<{id,imei,model,firmware,ownerTenantId,status}>} devices
 * @returns {string} a single INSERT statement (or a no-op comment if empty)
 */
export function provisioningSql(devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    return '-- no devices to provision\n';
  }
  const values = devices
    .map(
      (d) =>
        `  (${q(d.id)}, ${q(d.imei)}, ${q(d.model)}, ${q(d.firmware)}, ${q(d.ownerTenantId)}, ${q(d.status)})`,
    )
    .join(',\n');
  return (
    '-- Generated fleet provisioning (idempotent). See src/simulator/provision.js.\n' +
    `-- TAC ${FMC130_TAC} · model ${FMC130_MODEL} · owner tenant ${TENANTS.DOZR.id} · no assignments.\n` +
    'INSERT INTO devices (id, imei, model, firmware, owner_tenant_id, status)\n' +
    'VALUES\n' +
    `${values}\n` +
    'ON CONFLICT (imei) DO NOTHING;\n'
  );
}
