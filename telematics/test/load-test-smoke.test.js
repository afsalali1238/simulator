// ─────────────────────────────────────────────────────────────────────────────
// test/load-test-smoke.test.js — proves the load-test HARNESS itself keeps
// working, not a performance number. src/tools/load-test.js is deliberately
// NOT part of the merge gate (see its file header): a latency/throughput
// figure is an environment fact, and pinning one to a shared CI runner is
// exactly the flaky-test problem the gate exists to avoid.
//
// What this DOES assert, at a tiny fixed scale so it's fast and deterministic:
// the harness connects real synthetic devices over real TCP, sends and ACKs
// records, and produces a report with the shape callers rely on — so a future
// refactor that quietly breaks the tool (not the server) goes red here instead
// of only being discovered the next time someone runs `npm run loadtest` by
// hand and wonders why the numbers look wrong.
//   run: npm run test:load-test-smoke
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoadTest, syntheticDevices } from '../src/tools/load-test.js';

test('load-test smoke: embedded run at tiny scale connects, sends, ACKs, and reports cleanly', async () => {
  const report = await runLoadTest({
    connections: 5,
    recordsPerDevice: 2,
    intervalMs: 0,
    rampMs: 0,
  });

  assert.equal(report.connections.attempted, 5);
  assert.equal(report.connections.connected, 5, 'all 5 synthetic devices should connect');
  assert.equal(report.connections.failed, 0);

  assert.equal(report.records.sent, 10);
  assert.equal(report.records.acked, 10, 'every sent record should be ACKed');
  assert.equal(report.records.sendErrors, 0);

  assert.equal(report.latency.ackMs.count, 10);
  assert.ok(report.latency.ackMs.p50 >= 0);

  assert.ok(report.server, 'embedded mode should report server-side stats');
  assert.ok(Number.isFinite(report.server.peakRssMb));

  assert.equal(report.pass.ok, true, `expected a clean pass: ${JSON.stringify(report.pass.checks)}`);
});

test('load-test smoke: a source that never lands a valid handshake counts as a connect failure, not a hang', async () => {
  // A garbage host:port (nothing listening) should fail fast, not hang the
  // test — connect() rejecting is exactly what the harness's own connect-
  // failure counting is for.
  const report = await runLoadTest({
    connections: 2,
    recordsPerDevice: 1,
    rampMs: 0,
    host: '127.0.0.1',
    port: 1, // reserved, nothing listens here
    thresholds: { maxConnectFailRate: 1 }, // don't fail the run on this expected failure
  });

  assert.equal(report.connections.connected, 0);
  assert.equal(report.connections.failed, 2);
  assert.equal(report.records.acked, 0);
});

test('syntheticDevices: produces distinct, well-formed 15-digit IMEIs that never collide with the seed fixtures', () => {
  const devices = syntheticDevices(50);
  assert.equal(devices.length, 50);
  const imeis = new Set(devices.map((d) => d.imei));
  assert.equal(imeis.size, 50, 'every synthetic IMEI should be distinct');
  for (const d of devices) {
    assert.equal(d.imei.length, 15);
    assert.match(d.imei, /^\d{15}$/);
    assert.ok(d.imei.startsWith('900'), 'should live in the reserved 900... range, away from 356... (seed) and 999... (bad-IMEI fixtures)');
  }
});
