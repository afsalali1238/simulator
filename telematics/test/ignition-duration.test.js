// ─────────────────────────────────────────────────────────────────────────────
// test/ignition-duration.test.js — the ignition-on-duration billing basis
// (src/ledger/ignition-duration.js), built for a fleet that has NO CAN adapter
// and therefore can never produce AVL 102 (see D1_CAN_ENGINE_HOURS.md and the
// file header of ignition-duration.js). Every figure below is hand-computed,
// not asserted against the implementation's own arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeIgnitionOnDuration, BILLING_BASIS } from '../src/ledger/ignition-duration.js';
import { sealUtilisationRecord } from '../src/ledger/index.js';

const ASSET = 'asset-actros-1';
const TENANT = 'tenant-haulage-co';
const HOUR_MS = 3_600_000;
const T0 = Date.parse('2025-05-01T00:00:00Z');
const PERIOD = { periodStartMs: T0, periodEndMs: T0 + 24 * HOUR_MS };

function rec(hourOffset, ignition, { assetId = ASSET, tenantId = TENANT } = {}) {
  return { assetId, tenantId, tsMs: T0 + hourOffset * HOUR_MS, ignition };
}

test('BILLING_BASIS is explicitly labeled — never confusable with the ECU ledger', () => {
  assert.equal(BILLING_BASIS, 'ignition-on-duration');
});

test('ignition-duration: sums only the intervals where the PRIOR reading had ignition on (exact)', () => {
  // false@0 -> true@1 -> true@2 -> false@3 -> true@4 (last, no next reading)
  const records = [
    rec(0, false),
    rec(1, true), // interval [1,2) counts: this reading is true
    rec(2, true), // interval [2,3) counts: this reading is true
    rec(3, false), // interval [3,4) does NOT count: this reading is false
    rec(4, true), // last reading — no next interval to attribute, not counted
  ];

  const u = computeIgnitionOnDuration(records, { assetId: ASSET, tenantId: TENANT, ...PERIOD });

  assert.equal(u.billable, true);
  assert.equal(u.source, 'ignition');
  assert.notEqual(u.source, 'ecu', 'must never be labeled ecu');
  assert.equal(u.readingCount, 5);
  assert.equal(u.billableSeconds, 2 * 3600); // [1,2) + [2,3) = 7200 s
  assert.equal(u.billableHours, 2);
  assert.equal(u.anomalies.length, 0);
});

test('ignition-duration: ignition=null excludes that interval and is recorded, never treated as on or off', () => {
  const records = [
    rec(0, true), // interval [0,1) counts
    rec(1, null), // unknown — interval [1,2) excluded, flagged
    rec(2, true), // interval [2,3) counts
    rec(3, true), // last reading, no next interval
  ];

  const u = computeIgnitionOnDuration(records, { assetId: ASSET, tenantId: TENANT, ...PERIOD });

  assert.equal(u.billableSeconds, 2 * 3600); // [0,1) + [2,3) = 7200 s; the null gap contributes 0
  assert.equal(u.anomalies.length, 1);
  assert.equal(u.anomalies[0].type, 'ignition-unknown-excluded');
  assert.equal(u.anomalies[0].tsMs, T0 + 1 * HOUR_MS);
});

test('ignition-duration: no records in scope is NOT billable — null, never zero (invariant 3 discipline)', () => {
  const u = computeIgnitionOnDuration([], { assetId: ASSET, tenantId: TENANT, ...PERIOD });
  assert.equal(u.billable, false);
  assert.equal(u.billableSeconds, null);
  assert.equal(u.billableHours, null);
  assert.equal(u.readingCount, 0);
});

test('ignition-duration: a single reading IS billable at 0 seconds — real evidence, just no interval yet', () => {
  const u = computeIgnitionOnDuration([rec(0, true)], { assetId: ASSET, tenantId: TENANT, ...PERIOD });
  assert.equal(u.billable, true, 'one ping is genuine evidence, unlike zero pings');
  assert.equal(u.billableSeconds, 0);
  assert.equal(u.billableHours, 0);
  assert.equal(u.readingCount, 1);
});

test('ignition-duration: scoped to the requested asset/tenant — other rows never leak in', () => {
  const records = [
    rec(0, true, { assetId: ASSET, tenantId: TENANT }),
    rec(1, true, { assetId: ASSET, tenantId: TENANT }),
    rec(0, true, { assetId: 'other-asset', tenantId: TENANT }),
    rec(0, true, { assetId: ASSET, tenantId: 'other-tenant' }),
  ];

  const u = computeIgnitionOnDuration(records, { assetId: ASSET, tenantId: TENANT, ...PERIOD });
  assert.equal(u.readingCount, 2, 'only the two matching rows are in scope');
  assert.equal(u.billableSeconds, 3600);
});

test('ignition-duration: readings outside [periodStartMs, periodEndMs) are excluded', () => {
  const records = [
    { assetId: ASSET, tenantId: TENANT, tsMs: PERIOD.periodStartMs - HOUR_MS, ignition: true }, // before window
    rec(0, true),
    rec(1, true),
    { assetId: ASSET, tenantId: TENANT, tsMs: PERIOD.periodEndMs, ignition: true }, // at/after window end
  ];

  const u = computeIgnitionOnDuration(records, { assetId: ASSET, tenantId: TENANT, ...PERIOD });
  assert.equal(u.readingCount, 2, 'only the two in-window readings count');
  assert.equal(u.billableSeconds, 3600); // [0,1) only — rec(1) is the last in-scope reading
});

test('ignition-duration: rejects an invalid period window', () => {
  assert.throws(
    () => computeIgnitionOnDuration([], { assetId: ASSET, tenantId: TENANT, periodStartMs: 1000, periodEndMs: 500 }),
    /valid periodStartMs\/periodEndMs/,
  );
});

test('ignition-duration: maxGapSeconds caps an over-long ON gap and records an oversized-gap-capped anomaly', () => {
  // ON at hour 0, then nothing until hour 10 — interval attribution would
  // otherwise bill all 10 h from two records.
  const records = [rec(0, true), rec(10, false)];

  const uncapped = computeIgnitionOnDuration(records, { assetId: ASSET, tenantId: TENANT, ...PERIOD });
  assert.equal(uncapped.billableSeconds, 10 * 3600, 'without the cap the whole silence is billed (documented default)');

  const u = computeIgnitionOnDuration(records, {
    assetId: ASSET, tenantId: TENANT, ...PERIOD, maxGapSeconds: 3600,
  });
  assert.equal(u.billable, true);
  assert.equal(u.billableSeconds, 3600, 'only the capped contribution counts');
  assert.equal(u.anomalies.length, 1);
  assert.equal(u.anomalies[0].type, 'oversized-gap-capped');
  assert.equal(u.anomalies[0].tsMs, T0);
  assert.deepEqual(u.anomalies[0].detail, { observedSeconds: 10 * 3600, countedSeconds: 3600 });
});

test('ignition-duration: maxGapSeconds leaves gaps within the cap untouched', () => {
  const records = [rec(0, true), rec(1, true), rec(2, false)];
  const u = computeIgnitionOnDuration(records, {
    assetId: ASSET, tenantId: TENANT, ...PERIOD, maxGapSeconds: 3600,
  });
  assert.equal(u.billableSeconds, 2 * 3600);
  assert.equal(u.anomalies.length, 0);
});

test('ignition-duration: maxGapSeconds rejects non-positive / non-finite values', () => {
  for (const bad of [0, -1, NaN, Infinity, 'x']) {
    assert.throws(
      () => computeIgnitionOnDuration([rec(0, true), rec(1, true)], {
        assetId: ASSET, tenantId: TENANT, ...PERIOD, maxGapSeconds: bad,
      }),
      /maxGapSeconds/,
    );
  }
});

test('ignition-duration: maxGapSeconds never caps an UNKNOWN gap — unknown is excluded, not capped (invariant 3)', () => {
  const records = [rec(0, null), rec(10, true)];
  const u = computeIgnitionOnDuration(records, {
    assetId: ASSET, tenantId: TENANT, ...PERIOD, maxGapSeconds: 3600,
  });
  assert.equal(u.billableSeconds, 0);
  assert.equal(u.anomalies.length, 1);
  assert.equal(u.anomalies[0].type, 'ignition-unknown-excluded', 'stays the unknown anomaly, not a cap anomaly');
});

test('ignition-duration: the figure can be sealed with the same generic evidence seal as the ECU ledger', () => {
  const records = [rec(0, true), rec(1, true)];
  const u = computeIgnitionOnDuration(records, { assetId: ASSET, tenantId: TENANT, ...PERIOD });

  const frames = [{ id: 'f1', raw: Buffer.from([0xaa, 0xbb]) }];
  const sealed = sealUtilisationRecord(u, frames);

  assert.equal(sealed.source, 'ignition');
  assert.equal(sealed.frameCount, 1);
  assert.equal(typeof sealed.manifestHash, 'string');

  const tampered = [{ id: 'f1', raw: Buffer.from([0xaa, 0xbc]) }];
  const resealed = sealUtilisationRecord(u, tampered);
  assert.notEqual(resealed.manifestHash, sealed.manifestHash, 'tamper must still be detectable on this basis too');
});
