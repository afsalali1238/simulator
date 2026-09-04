// ─────────────────────────────────────────────────────────────────────────────
// test/api.test.js — Module 6 (Surfaces), read side. Exercises the HTTP contract
// the dashboard depends on: health, the mandatory X-Tenant-Id header, tenant-
// scoped positions (invariant 7), latest ECU engine hours, and routing.
//   run: npm run test:api
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory-store.js';
import { createApi } from '../src/api/server.js';
import { TENANTS, DEVICES, ASSETS } from '../src/store/seed-data.js';

const quiet = { info() {}, warn() {}, error() {} };
const device = DEVICES[0];

function canonical(tsMs, tenantId, assetId, engine) {
  return {
    deviceId: device.id,
    imei: device.imei,
    tenantId,
    assetId,
    tsMs,
    lat: 25,
    lon: 55,
    speed: 5,
    angle: 0,
    altitude: 0,
    satellites: 9,
    priority: 0,
    ignition: true,
    movement: true,
    state: 'moving',
    engine,
  };
}

async function setup() {
  const store = createMemoryStore();
  await store.init();
  await store.persistPacket({
    device,
    imei: device.imei,
    codecId: 0x8e,
    rawFrame: Buffer.from([0]),
    canonical: [
      canonical(1000, TENANTS.A.id, ASSETS[0].id, { seconds: 3600, hours: 1, source: 'ecu' }),
      canonical(2000, TENANTS.A.id, ASSETS[0].id, { seconds: 7200, hours: 2, source: 'ecu' }),
      canonical(3000, TENANTS.B.id, ASSETS[1].id, null),
    ],
  });
  const api = createApi({ store, port: 0, logger: quiet });
  const port = await api.listen();
  return { store, api, base: `http://127.0.0.1:${port}` };
}

const getJson = (base, path, tenantId) =>
  fetch(base + path, { headers: tenantId ? { 'x-tenant-id': tenantId } : {} });

test('api: /health reports ok and the active store kind', async () => {
  const { api, base } = await setup();
  const res = await fetch(base + '/health');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.store, 'memory');
  await api.close();
});

test('api: data endpoints require an X-Tenant-Id header (400 otherwise)', async () => {
  const { api, base } = await setup();
  const res = await getJson(base, '/positions');
  assert.equal(res.status, 400);
  await api.close();
});

test('api: positions are tenant-scoped (invariant 7)', async () => {
  const { api, base } = await setup();
  const a = await (await getJson(base, '/positions?limit=100', TENANTS.A.id)).json();
  const b = await (await getJson(base, '/positions?limit=100', TENANTS.B.id)).json();
  assert.equal(a.positions.length, 2);
  assert.equal(b.positions.length, 1);
  await api.close();
});

test('api: engine-hours returns the latest ECU reading, and none for a no-CAN asset', async () => {
  const { api, base } = await setup();
  const x = await (await getJson(base, `/assets/${ASSETS[0].id}/engine-hours`, TENANTS.A.id)).json();
  assert.equal(x.reading.hours, 2);
  assert.equal(x.reading.source, 'ecu');

  const y = await (await getJson(base, `/assets/${ASSETS[1].id}/engine-hours`, TENANTS.B.id)).json();
  assert.equal(y.reading, null); // Generator Y: no CAN program (invariant 9)
  await api.close();
});

test('api: devices endpoint lists the tenant’s devices', async () => {
  const { api, base } = await setup();
  const body = await (await getJson(base, '/devices', TENANTS.A.id)).json();
  assert.ok(body.devices.some((d) => d.imei === device.imei));
  await api.close();
});

test('api: an unknown route returns 404', async () => {
  const { api, base } = await setup();
  const res = await getJson(base, '/nope', TENANTS.A.id);
  assert.equal(res.status, 404);
  await api.close();
});

// Found 2026-09-04: normalize.js decodes these four, both store adapters dropped
// them on the read path, so no API/dashboard consumer could see them.
// positionValid is the load-bearing one — F3 exists so a no-fix record (lat/lon
// 0,0) isn't read as a real position.
test('api: positions expose positionValid and the power/tamper signals (invariant 3: null stays null)', async () => {
  const store = createMemoryStore();
  await store.init();
  await store.persistPacket({
    device,
    imei: device.imei,
    codecId: 0x8e,
    rawFrame: Buffer.from([0]),
    canonical: [
      { ...canonical(1000, TENANTS.A.id, ASSETS[0].id, null), positionValid: true, externalVoltageMv: 27400, batteryPct: 98, unplug: 0 },
      // A record whose device never sent those IO elements at all.
      { ...canonical(2000, TENANTS.A.id, ASSETS[0].id, null), positionValid: false, externalVoltageMv: null, batteryPct: null, unplug: null },
    ],
  });
  const api = createApi({ store, port: 0, logger: quiet });
  const port = await api.listen();

  const { positions } = await (await getJson(`http://127.0.0.1:${port}`, '/positions?limit=10', TENANTS.A.id)).json();
  assert.deepEqual(
    { p: positions[0].positionValid, v: positions[0].externalVoltageMv, b: positions[0].batteryPct, u: positions[0].unplug },
    { p: true, v: 27400, b: 98, u: 0 },
  );
  assert.equal(positions[1].positionValid, false); // a real no-fix reading
  assert.equal(positions[1].externalVoltageMv, null); // absent, not 0
  assert.equal(positions[1].batteryPct, null);
  assert.equal(positions[1].unplug, null);
  await api.close();
});
