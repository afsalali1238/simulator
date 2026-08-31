// ─────────────────────────────────────────────────────────────────────────────
// src/store/seed-data.js — the canonical demo fixtures, shared by BOTH store
// adapters, the SQL seed file (db/seed.sql mirrors these exactly), and the
// simulator (so the IMEIs it dials in with are known to the DB).
//
// The scenario is deliberately built to exercise the correctness invariants:
//
//   • Device D1 (FMC130) changes hands mid-2025:
//       Jan–Jun 2025  -> Excavator X, billed to Tenant A   (CAN supported)
//       Jun 2025 →     -> Generator  Y, billed to Tenant B   (NO CAN program)
//     => a record's owner depends on WHEN it happened      (invariant 6)
//     => once on Generator Y, engine-hours must NOT be produced (invariant 9)
//
//   • Device D2 (FMC920) is unassigned (sitting in Dozr's yard):
//       => position + ignition only, scoped to the owner    (invariants 7, 9)
// ─────────────────────────────────────────────────────────────────────────────

const ms = (iso) => new Date(iso).getTime();

export const TENANTS = {
  DOZR: { id: '00000000-0000-4000-8000-000000000001', name: 'Dozr Rentals (owner)' },
  A: { id: '11111111-1111-4111-8111-111111111111', name: 'Al Naboodah (Contractor A)' },
  B: { id: '22222222-2222-4222-8222-222222222222', name: 'Dutco (Contractor B)' },
};

export const DEVICES = [
  {
    id: '0d000000-0000-4000-8000-000000000001',
    imei: '356307042441013',
    model: 'FMC130',
    firmware: '03.27.06',
    ownerTenantId: TENANTS.DOZR.id,
    status: 'active',
  },
  {
    id: '0d000000-0000-4000-8000-000000000002',
    imei: '356307042441099',
    model: 'FMC920',
    firmware: '03.27.06',
    ownerTenantId: TENANTS.DOZR.id,
    status: 'active',
  },
];

export const ASSETS = [
  {
    id: 'a0000000-0000-4000-8000-000000000001',
    type: 'excavator',
    make: 'CAT',
    model: '320',
    year: 2021,
    programNumber: 'CAT-320-2021', // a supported CAN program (D1)
    hasEngineData: true,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000002',
    type: 'generator',
    make: 'Genericorp',
    model: 'G-500',
    year: 2019,
    programNumber: null, // NO supported CAN program
    hasEngineData: false,
  },
];

export const ASSIGNMENTS = [
  {
    id: 'ba000000-0000-4000-8000-000000000001',
    deviceId: DEVICES[0].id,
    assetId: ASSETS[0].id, // Excavator X
    tenantId: TENANTS.A.id, // billed to Tenant A
    validFrom: '2025-01-01T00:00:00Z',
    validTo: '2025-06-01T00:00:00Z',
    validFromMs: ms('2025-01-01T00:00:00Z'),
    validToMs: ms('2025-06-01T00:00:00Z'),
  },
  {
    id: 'ba000000-0000-4000-8000-000000000002',
    deviceId: DEVICES[0].id,
    assetId: ASSETS[1].id, // Generator Y (no CAN program)
    tenantId: TENANTS.B.id, // billed to Tenant B
    validFrom: '2025-06-01T00:00:00Z',
    validTo: null, // still in force
    validFromMs: ms('2025-06-01T00:00:00Z'),
    validToMs: null,
  },
  // Device D2 intentionally has NO assignment row.
];

// ── Attribution (invariant 6): resolve the assignment in force AT a given
// record's own timestamp — never "as of now". Returns the assignment or null.
export function resolveAssignment(deviceId, tsMs, assignments = ASSIGNMENTS) {
  return (
    assignments.find(
      (a) =>
        a.deviceId === deviceId &&
        tsMs >= a.validFromMs &&
        (a.validToMs == null || tsMs < a.validToMs),
    ) || null
  );
}

export function deviceByImei(imei, devices = DEVICES) {
  return devices.find((d) => d.imei === imei) || null;
}

export function assetById(assetId, assets = ASSETS) {
  return assets.find((a) => a.id === assetId) || null;
}
