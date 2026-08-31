-- ─────────────────────────────────────────────────────────────────────────────
-- db/seed.sql — demo fixtures. MUST stay in sync with src/store/seed-data.js
-- (same UUIDs, same IMEIs, same assignment windows). Apply with: npm run db:seed
-- ─────────────────────────────────────────────────────────────────────────────

TRUNCATE engine_readings, position_records, raw_frames,
  device_assignment, assets, devices, tenants RESTART IDENTITY CASCADE;

INSERT INTO tenants (id, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Dozr Rentals (owner)'),
  ('11111111-1111-4111-8111-111111111111', 'Al Naboodah (Contractor A)'),
  ('22222222-2222-4222-8222-222222222222', 'Dutco (Contractor B)');

INSERT INTO devices (id, imei, model, firmware, owner_tenant_id, status) VALUES
  ('0d000000-0000-4000-8000-000000000001', '356307042441013', 'FMC130', '03.27.06',
   '00000000-0000-4000-8000-000000000001', 'active'),
  ('0d000000-0000-4000-8000-000000000002', '356307042441099', 'FMC920', '03.27.06',
   '00000000-0000-4000-8000-000000000001', 'active');

INSERT INTO assets (id, type, make, model, year, program_number, has_engine_data) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'excavator', 'CAT', '320', 2021, 'CAT-320-2021', true),
  ('a0000000-0000-4000-8000-000000000002', 'generator', 'Genericorp', 'G-500', 2019, NULL, false);

-- Device D1 changes hands mid-2025 (drives invariants 6 and 9).
INSERT INTO device_assignment (id, device_id, asset_id, tenant_id, valid_from, valid_to) VALUES
  ('ba000000-0000-4000-8000-000000000001',
   '0d000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   '11111111-1111-4111-8111-111111111111', '2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z'),
  ('ba000000-0000-4000-8000-000000000002',
   '0d000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
   '22222222-2222-4222-8222-222222222222', '2025-06-01T00:00:00Z', NULL);
-- Device D2 has no assignment (owner-held).
