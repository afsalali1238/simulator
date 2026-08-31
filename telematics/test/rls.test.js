// ─────────────────────────────────────────────────────────────────────────────
// test/rls.test.js — P1 DB-LAYER enforcement of tenant isolation (invariant 7).
//
// The memory adapter models tenancy in application code; test/tenancy.test.js and
// test/store.test.js prove THAT. This file proves the stronger thing: that when
// the store runs on real Postgres, the ISOLATION IS DONE BY THE DATABASE — by
// row-level security — and not by a WHERE clause in the app. Two facts make that
// airtight here:
//
//   • pg-store's read queries carry NO tenant filter of their own. `getPositions`
//     is literally `SELECT ... FROM position_records WHERE (device filter) AND
//     ts_ms >= $2` — there is no `tenant_id = ...`. The only thing scoping a read
//     to one tenant is the RLS policy plus `set_config('app.tenant', <uuid>)`.
//   • The reader connects as `dozr_app`, which is NOT the table owner and is NOT
//     a superuser, so RLS actually applies to it. (A superuser or the owner would
//     bypass RLS — test 2 guards against a misconfigured APP_DATABASE_URL.)
//
// => If the RLS policy were dropped, every assertion below would FAIL: a tenant
//    read would return the other tenant's rows, and the "no context" read would
//    return everything instead of nothing. That is the point of the test.
//
// WIRING (read before touching the guards):
//   • These tests need a live Postgres, so they run ONLY under DB=pg. In memory
//     mode `config.db !== 'pg'`, the `if` block below registers NOTHING — the file
//     contributes 0 tests and 0 skips, so the memory-mode merge gate (test:gate,
//     which fails on any skip and enforces a fixed floor) stays green and services
//     -free. `pg` is dynamic-imported inside the pg path only, so memory mode needs
//     no `npm install` — same rule as src/store/index.js.
//   • Under `DB=pg npm test` the file is picked up automatically (run-tests.js /
//     test-gate.js enumerate every test/*.test.js), and `npm run test:rls` runs it
//     alone. If DB=pg but Postgres is unreachable, each test skips cleanly with a
//     diagnostic rather than hanging or dumping an ECONNREFUSED stack.
//
//   run: DB=pg APP_DATABASE_URL=postgres://dozr_app:dozr_app@localhost:5432/dozr_telematics npm run test:rls
// ─────────────────────────────────────────────────────────────────────────────

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { TENANTS, DEVICES, ASSETS } from '../src/store/seed-data.js';

// Synchronous switch — no await needed to decide whether to register. In memory
// mode this is false and the whole suite is a no-op (0 tests, 0 skips).
const PG = config.db === 'pg';

if (PG) {
  const device = DEVICES[0]; // D1 (FMC130): Tenant A before Jun 2025, Tenant B after
  const tenantA = TENANTS.A.id;
  const tenantB = TENANTS.B.id;
  const assetX = ASSETS[0].id; // Excavator X (CAN)   -> Tenant A window
  const assetY = ASSETS[1].id; // Generator Y (no CAN) -> Tenant B window

  // Fixed timestamps inside each tenant's assignment window. Fixed (not `now`) so
  // a re-run without db:reset simply de-duplicates on (device_id, ts_ms) instead
  // of accumulating or colliding.
  const tsA = Date.parse('2025-03-15T06:00:00Z'); // -> Tenant A / Excavator X
  const tsB = Date.parse('2025-07-15T06:00:00Z'); // -> Tenant B / Generator Y

  let pg;
  let store; // real pg store: writer(owner) for seeding, reader(dozr_app) for reads
  let reader; // an independent dozr_app pool for the raw, DB-level assertions
  let reachable = false;

  // A record shaped exactly like the decoder emits (see test/store.test.js).
  const rec = (over) => ({
    deviceId: device.id,
    imei: device.imei,
    lat: 25.2,
    lon: 55.2,
    speed: 0,
    angle: 0,
    altitude: 5,
    satellites: 9,
    priority: 0,
    ignition: true,
    movement: false,
    state: 'idle',
    engine: null,
    ...over,
  });

  // Read as `dozr_app` inside a tenant-scoped transaction, mirroring pg-store's
  // withTenant(): BEGIN, set the RLS GUC transaction-locally, query, ROLLBACK
  // (read-only, so rollback is fine and leaves no session state behind).
  async function asTenant(tenantId, sql, params = []) {
    const c = await reader.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.tenant', tenantId]);
      const r = await c.query(sql, params);
      await c.query('ROLLBACK');
      return r;
    } finally {
      c.release();
    }
  }

  // Read as `dozr_app` with NO tenant context set at all. current_setting(
  // 'app.tenant', true) is then NULL, the policy predicate is NULL, and every row
  // is filtered out — RLS defaults to deny-all.
  async function asNoTenant(sql, params = []) {
    const c = await reader.connect();
    try {
      await c.query('BEGIN'); // fresh tx, app.tenant deliberately never set
      const r = await c.query(sql, params);
      await c.query('ROLLBACK');
      return r;
    } finally {
      c.release();
    }
  }

  before(async () => {
    ({ default: pg } = await import('pg')); // pg path only — memory needs no install
    const { createPgStore } = await import('../src/store/pg-store.js');
    store = createPgStore(); // uses config.databaseUrl (owner) + config.appDatabaseUrl (dozr_app)
    reader = new pg.Pool({ connectionString: config.appDatabaseUrl });
    try {
      await store.countPositions(); // owner reachable + schema applied?
      await reader.query('SELECT 1'); // app role reachable?
      reachable = true;
    } catch (e) {
      reachable = false;
      console.error(
        `[rls.test] Postgres not reachable/ready (${e.code || e.message}). ` +
          'Bring it up with `npm run db:up && npm run db:reset` and set APP_DATABASE_URL ' +
          'to the dozr_app role, then re-run. Skipping the DB-layer RLS tests.',
      );
      return;
    }

    // Seed one row for each tenant through the REAL write path (owner bypasses
    // RLS to write, exactly like the ingest worker). One physical device, two
    // records, on opposite sides of the mid-2025 handover.
    await store.persistPacket({
      device,
      imei: device.imei,
      codecId: 0x8e,
      rawFrame: Buffer.from([1, 2, 3]),
      canonical: [
        rec({
          tenantId: tenantA,
          assetId: assetX,
          tsMs: tsA,
          engine: { seconds: 7200, hours: 2, source: 'ecu' },
        }),
        rec({ tenantId: tenantB, assetId: assetY, tsMs: tsB }),
      ],
    });
  });

  after(async () => {
    await store?.close().catch(() => {});
    await reader?.end().catch(() => {});
  });

  test('rls: row-level security is ENABLED on every tenant-scoped table', async (t) => {
    if (!reachable) {
      t.skip('Postgres unreachable — see the [rls.test] note above');
      return;
    }
    // relrowsecurity must be true, or the policies below never fire. This fails
    // if someone drops the `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` lines.
    const { rows } = await reader.query(
      `SELECT relname, relrowsecurity
         FROM pg_class
        WHERE relname IN ('position_records','engine_readings','devices')
        ORDER BY relname`,
    );
    assert.equal(rows.length, 3, 'the three tenant-scoped tables must exist');
    for (const r of rows) {
      assert.equal(r.relrowsecurity, true, `RLS must be ENABLED on ${r.relname}`);
    }
  });

  test('rls: the app role has neither SUPERUSER nor BYPASSRLS (so RLS truly applies)', async (t) => {
    if (!reachable) {
      t.skip('Postgres unreachable — see the [rls.test] note above');
      return;
    }
    // If APP_DATABASE_URL is (mis)pointed at the owner/superuser, RLS is bypassed
    // and every isolation assertion below would vacuously pass. Catch that here
    // with a clear message instead of a confusing isolation failure.
    const { rows } = await reader.query(
      `SELECT current_user AS role, rolsuper, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`,
    );
    const me = rows[0];
    assert.equal(
      me.rolsuper,
      false,
      `the reader connects as "${me.role}", which is a SUPERUSER and bypasses RLS. ` +
        'Point APP_DATABASE_URL at the restricted dozr_app role.',
    );
    assert.equal(
      me.rolbypassrls,
      false,
      `the reader role "${me.role}" has BYPASSRLS — it must not, or RLS is meaningless.`,
    );
  });

  test('rls: with no tenant context the app role sees nothing (default-deny)', async (t) => {
    if (!reachable) {
      t.skip('Postgres unreachable — see the [rls.test] note above');
      return;
    }
    // At least our two seeded rows exist; the owner can see them...
    const total = await store.countPositions();
    assert.ok(total >= 2, 'seed should have inserted at least the two rows');
    // ...but dozr_app with no app.tenant set sees zero. If RLS were removed this
    // would return `total`, not 0.
    const { rows } = await asNoTenant('SELECT count(*)::int AS n FROM position_records');
    assert.equal(rows[0].n, 0, 'no tenant context must yield zero rows, not all rows');
  });

  test('rls: a tenant cannot read another tenant\'s rows — DB-enforced, not app-filtered (invariant 7)', async (t) => {
    if (!reachable) {
      t.skip('Postgres unreachable — see the [rls.test] note above');
      return;
    }

    // ── Through the store's read path (no tenant WHERE clause in its SQL) ──
    // ts_ms is a bigint; node-pg returns bigint as a STRING, so coerce before
    // comparing to the JS number timestamps (safe: these are < 2^53).
    const hasTs = (rows, ts) => rows.some((p) => Number(p.tsMs) === ts);
    const aPos = await store.getPositions(tenantA, { limit: 1000 });
    const bPos = await store.getPositions(tenantB, { limit: 1000 });
    assert.ok(hasTs(aPos, tsA), 'Tenant A must see its own March row');
    assert.ok(!hasTs(aPos, tsB), 'Tenant A must NOT see Tenant B\'s July row');
    assert.ok(hasTs(bPos, tsB), 'Tenant B must see its own July row');
    assert.ok(!hasTs(bPos, tsA), 'Tenant B must NOT see Tenant A\'s March row');

    // ── Directly at the DB layer: a bare COUNT with no tenant clause, scoped by
    //    RLS alone. The other tenant's row is invisible; your own is visible. ──
    const aSeesB = await asTenant(tenantA, 'SELECT count(*)::int AS n FROM position_records WHERE ts_ms = $1', [tsB]);
    const aSeesA = await asTenant(tenantA, 'SELECT count(*)::int AS n FROM position_records WHERE ts_ms = $1', [tsA]);
    assert.equal(aSeesB.rows[0].n, 0, 'Tenant A must not see Tenant B\'s row at the DB layer');
    assert.equal(aSeesA.rows[0].n, 1, 'Tenant A must see its own row at the DB layer');

    const bSeesA = await asTenant(tenantB, 'SELECT count(*)::int AS n FROM position_records WHERE ts_ms = $1', [tsA]);
    const bSeesB = await asTenant(tenantB, 'SELECT count(*)::int AS n FROM position_records WHERE ts_ms = $1', [tsB]);
    assert.equal(bSeesA.rows[0].n, 0, 'Tenant B must not see Tenant A\'s row at the DB layer');
    assert.equal(bSeesB.rows[0].n, 1, 'Tenant B must see its own row at the DB layer');

    // ── Engine readings are tenant-scoped by the same mechanism. Tenant A's ECU
    //    reading is visible to A, invisible to B. ──
    const aEng = await store.getLatestEngineHours(tenantA, assetX);
    assert.ok(aEng && aEng.source === 'ecu', 'Tenant A sees its ECU engine reading');
    const bEngRaw = await asTenant(tenantB, 'SELECT count(*)::int AS n FROM engine_readings WHERE asset_id = $1', [assetX]);
    assert.equal(bEngRaw.rows[0].n, 0, 'Tenant B must not see Tenant A\'s engine readings');
  });
}
