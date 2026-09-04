// ─────────────────────────────────────────────────────────────────────────────
// test/ledger.test.js — Module 5 (utilisation ledger + evidence seal).
//
// MOVED UP from test/pending/ledger.test.js on 2026-09-02, by the same-commit
// rule this file itself specified: `src/ledger/index.js` was built against
// these exact assertions (by explicit human sign-off — CLAUDE.md gates this
// module behind a person, not speculative generation) and DEFAULT_MIN_TESTS in
// src/tools/test-gate.js was raised in the same change. All 8 cases pass,
// including the seed `handover` scenario's EXACT figures (not hand-waved — see
// below). `npm run test:ledger` now runs this file directly from test/.
//
// This proves the LEDGER MATH is correct against its spec and real simulator
// data. It does NOT by itself clear a number to reach a real invoice — that
// still needs the D1 hardware half (a real adapter's AVL 102 reading reconciled
// against the machine's physical hour-meter) and human review on real fleet
// data, both still open in TASKS.md Phase P2.
//
// ── WHAT THIS PINS (the P2 gate, verbatim from BUILD_PLAN.md / TASKS.md) ──────
//   1. `test:ledger` green — utilisation from ECU-only readings, with EXACT
//      figures on the seed `handover` scenario.
//   2. an evidence-tamper test — mutating a sealed frame is detected.
//   3. ignition-/estimated-derived values REFUSED as billing evidence (inv. 5).
// Plus the two rules the ledger cannot get wrong:
//   • never bill a NEGATIVE delta — a meter decrease is a reset (adapter/ECU
//     swap), not negative usage (see the D1 write-up, never-bill-a-negative note);
//   • invariant 9 / invariant 3 — an asset with no ECU evidence is NOT billable,
//     and "not billable" is null, never a billable-looking 0.
//
// ── THE CONTRACT THIS SPEC ASSUMES (final shape is the ledger owner's to
//    confirm; these BEHAVIOURS are non-negotiable) ─────────────────────────────
//   computeUtilisation(readings, { assetId, tenantId, periodStartMs, periodEndMs })
//     -> {
//          assetId, tenantId, periodStartMs, periodEndMs,
//          source: 'ecu',                // invariant 4 — the only billable source
//          billable: boolean,            // false when there is no ECU evidence
//          billableSeconds: number|null, // Σ max(0, Δseconds) over consecutive
//                                        //   ECU readings; null when not billable
//          billableHours:   number|null, // billableSeconds / 3600; null ≠ 0 (inv 3)
//          readingCount: number,         // ECU readings actually used
//          anomalies: Array<{ type }>,   // 'meter-reset' | 'non-ecu-excluded' | …
//        }
//
//   sealUtilisationRecord(utilisation, rawFrames)
//     -> { ...utilisation, frameCount, manifestHash }
//        manifestHash is DETERMINISTIC over the exact frame bytes (+ the figure),
//        so a dispute pack is reproducible and any mutation is detectable (inv 8).
//
//   `readings` rows are exactly the store's engine_readings shape (memory-store
//   naming), in timestamp order:
//     { assetId, tenantId, tsMs, seconds, hours, source }   source ∈ {ecu,estimated}
//
// The seed cases below are NOT hand-waved: they replay the real, deterministic
// `handover` scenario through the actual decode pipeline (the same idiom as
// test/scenarios.test.js), so the figures are what the system genuinely produces.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeUtilisation, sealUtilisationRecord } from '../src/ledger/index.js';
import { buildScenario, scenarioRecords, HANDOVER_TS_MS } from '../src/simulator/scenarios.js';
import { normalizeRecord } from '../src/decode/normalize.js';
import { resolveAssignment, DEVICES, ASSETS, TENANTS } from '../src/store/seed-data.js';

// ── Fixtures anchored to the real seed entities ──────────────────────────────
const EXCAVATOR_X = ASSETS[0].id; // CAT 320, 2021 — hasEngineData: true
const GENERATOR_Y = ASSETS[1].id; // Genericorp G-500 — no CAN program, hasEngineData: false
const TENANT_A = TENANTS.A.id; // Al Naboodah
const TENANT_B = TENANTS.B.id; // Dutco

const HOUR_MS = 3_600_000;
const T0 = Date.parse('2025-05-01T00:00:00Z'); // an arbitrary period start for the fixtures
const A_PERIOD = { periodStartMs: T0, periodEndMs: T0 + 24 * HOUR_MS };

// One canonical engine reading, exactly as the store holds it: the machine's own
// ECU hour-meter (AVL 102) already converted to seconds by decode. `hours` is
// derived from `seconds` so a fixture's two fields can never silently disagree.
function reading(tsMs, seconds, { source = 'ecu', assetId = EXCAVATOR_X, tenantId = TENANT_A } = {}) {
  return { assetId, tenantId, tsMs, seconds, hours: seconds / 3600, source };
}

// Replay the deterministic seed `handover` scenario through the real decode
// pipeline and return the ECU engine readings the store would hold for one
// tenant, in timestamp order. This is the ledger's actual input.
function seedEcuReadings(tenantId) {
  const device = DEVICES[0]; // D1 — the FMC130 that changes hands mid-2025
  const all = scenarioRecords(buildScenario('handover'));
  const rows = [];
  for (const r of all) {
    const assignment = resolveAssignment(device.id, r.timestampMs);
    const asset = assignment ? ASSETS.find((a) => a.id === assignment.assetId) : null;
    const canonical = normalizeRecord(r, {
      device,
      assignment: assignment ? { ...assignment, hasEngineData: asset?.hasEngineData } : null,
    });
    if (canonical.tenantId === tenantId && canonical.engine) {
      rows.push({
        assetId: canonical.assetId,
        tenantId: canonical.tenantId,
        tsMs: canonical.tsMs,
        seconds: canonical.engine.seconds,
        hours: canonical.engine.hours,
        source: canonical.engine.source, // 'ecu'
      });
    }
  }
  return rows.sort((a, b) => a.tsMs - b.tsMs);
}

// ── 1. Utilisation = the sum of POSITIVE ECU hour-meter deltas ────────────────

test('ledger: utilisation is the sum of positive ECU hour-meter deltas over the period (exact)', () => {
  // A clean, monotonic AVL-102 meter (already seconds): 250.0h → 251.0h → 252.5h.
  const readings = [
    reading(T0 + 0 * HOUR_MS, 900_000), // 250.0000 h
    reading(T0 + 1 * HOUR_MS, 903_600), // 251.0000 h  (+3600 s = +1.0 h)
    reading(T0 + 2 * HOUR_MS, 909_000), // 252.5000 h  (+5400 s = +1.5 h)
  ];

  const u = computeUtilisation(readings, { assetId: EXCAVATOR_X, tenantId: TENANT_A, ...A_PERIOD });

  assert.equal(u.billable, true);
  assert.equal(u.source, 'ecu'); // invariant 4 — never anything but the machine's ECU meter
  assert.equal(u.billableSeconds, 9000); // 3600 + 5400, exact integer arithmetic
  assert.equal(u.billableHours, 9000 / 3600); // 2.5 h
  assert.equal(u.readingCount, 3);
  assert.equal(u.anomalies.length, 0); // nothing surprising in a clean series
});

// ── 2. EXACT figures on the seed `handover` scenario ──────────────────────────

test('ledger: exact utilisation on the seed `handover` scenario — Tenant A / Excavator X', () => {
  const readingsA = seedEcuReadings(TENANT_A);

  // The before-handover shift is SHORT_SHIFT: startup×2 + work×6 + idle×2 = 10
  // engine-running ticks (the trailing shutdown tick drops ignition, so AVL 102
  // is omitted). engineSeconds0 = 250_000, +60 s per running tick ⇒ wire minutes
  // 4167..4176, i.e. seconds 250_020..250_560. Ten readings, nine +60 s deltas.
  assert.equal(readingsA.length, 10, 'the seed A-side shift should yield 10 ECU readings');
  assert.ok(
    readingsA.every((r) => r.tsMs < HANDOVER_TS_MS),
    'every Tenant A reading must fall before the handover instant (invariant 6)',
  );

  // Ground truth, derived from the real readings: a monotonic meter, so the
  // billable span is simply last − first.
  const first = readingsA[0].seconds;
  const last = readingsA[readingsA.length - 1].seconds;
  const expectedSeconds = last - first; // 250_560 − 250_020

  const u = computeUtilisation(readingsA, {
    assetId: EXCAVATOR_X,
    tenantId: TENANT_A,
    periodStartMs: Date.parse('2025-05-01T00:00:00Z'),
    periodEndMs: HANDOVER_TS_MS, // [period start, handover)
  });

  assert.equal(u.billable, true);
  assert.equal(u.source, 'ecu');
  assert.equal(u.readingCount, 10);
  assert.equal(u.billableSeconds, expectedSeconds); // pins the delta SEMANTIC to real data
  assert.equal(u.billableSeconds, 540); // …and the EXACT figure — loud if the sim ever drifts
  assert.equal(u.billableHours, 540 / 3600); // 0.15 h
});

// ── 3. Never bill a NEGATIVE delta — a decrease is a reset, not negative usage ─

test('ledger: a meter decrease is a reset (adapter/ECU swap), never billed as negative usage', () => {
  // Adapter or ECU swapped mid-period: the hour-meter drops from 252.5h to 0.5h.
  const readings = [
    reading(T0 + 0 * HOUR_MS, 900_000), // 250.0 h
    reading(T0 + 1 * HOUR_MS, 903_600), // 251.0 h   (+3600)
    reading(T0 + 2 * HOUR_MS, 909_000), // 252.5 h   (+5400)
    reading(T0 + 3 * HOUR_MS, 1_800), //     0.5 h   (RESET: Δ −907200 → contributes 0)
    reading(T0 + 4 * HOUR_MS, 5_400), //     1.5 h   (+3600 on the new meter)
  ];

  const u = computeUtilisation(readings, { assetId: EXCAVATOR_X, tenantId: TENANT_A, ...A_PERIOD });

  // Sum of POSITIVE deltas only: 3600 + 5400 + 0 + 3600 = 12600 s = 3.5 h.
  assert.equal(u.billableSeconds, 12_600);
  assert.equal(u.billableHours, 12_600 / 3600); // 3.5 h
  assert.ok(u.billableSeconds >= 0, 'utilisation can never be negative');
  assert.notEqual(u.billableSeconds, 5_400 - 900_000); // never the absurd naive last − first
  assert.ok(
    u.anomalies.some((a) => a.type === 'meter-reset'),
    'a meter decrease must be surfaced as a reset for human review, not silently swallowed',
  );
});

// ── 4. Only source 'ecu' bills — estimated / ignition-derived is refused ──────

test('ledger: estimated (non-ECU) readings are excluded — only the ECU meter bills (invariants 4, 5)', () => {
  // An 'estimated' value between two ECU readings must not inflate the bill, no
  // matter how large. This is the ledger-side of invariant 5: a modelled or
  // ignition-derived figure can inform a display, never an invoice.
  const readings = [
    reading(T0 + 0 * HOUR_MS, 900_000, { source: 'ecu' }), //       250.0 h
    reading(T0 + 1 * HOUR_MS, 99_999_999, { source: 'estimated' }), // must be ignored
    reading(T0 + 2 * HOUR_MS, 903_600, { source: 'ecu' }), //       251.0 h
  ];

  const u = computeUtilisation(readings, { assetId: EXCAVATOR_X, tenantId: TENANT_A, ...A_PERIOD });

  assert.equal(u.source, 'ecu');
  assert.equal(u.readingCount, 2); // only the two ECU rows counted
  assert.equal(u.billableSeconds, 3600); // 251.0 − 250.0; the estimated row ignored entirely
  assert.equal(u.billableHours, 1);
  assert.ok(
    u.anomalies.some((a) => a.type === 'non-ecu-excluded'),
    'excluded non-ECU evidence must be recorded, not silently dropped',
  );
});

test('ledger: a period with only non-ECU evidence is NOT billable (invariant 5)', () => {
  // If the only evidence is estimated/ignition-derived, there is nothing to bill
  // from — refuse, do not fabricate a figure.
  const readings = [
    reading(T0 + 0 * HOUR_MS, 900_000, { source: 'estimated' }),
    reading(T0 + 1 * HOUR_MS, 903_600, { source: 'estimated' }),
  ];

  const u = computeUtilisation(readings, { assetId: EXCAVATOR_X, tenantId: TENANT_A, ...A_PERIOD });

  assert.equal(u.billable, false);
  assert.equal(u.billableSeconds, null);
  assert.equal(u.billableHours, null); // null, not 0 (invariant 3)
});

// ── 4b. Tenancy/asset scoping and boundary discipline (locking down behaviour
//        that was already correct but not pinned by its own test — a 2026-09-03
//        review pass; see test/ignition-duration.test.js for the equivalent
//        coverage this basis already had) ─────────────────────────────────────

test('ledger: readings for a different asset or a different tenant never leak into the figure (invariants 6, 7)', () => {
  const readings = [
    reading(T0 + 0 * HOUR_MS, 900_000, { assetId: EXCAVATOR_X, tenantId: TENANT_A }),
    reading(T0 + 1 * HOUR_MS, 903_600, { assetId: EXCAVATOR_X, tenantId: TENANT_A }), // +3600, the only in-scope delta
    // Same timestamp, wildly different (huge) readings — must not be summed in
    // just because they land in the same array and period.
    reading(T0 + 1 * HOUR_MS, 999_999_999, { assetId: GENERATOR_Y, tenantId: TENANT_A }), // other asset, same tenant
    reading(T0 + 1 * HOUR_MS, 999_999_999, { assetId: EXCAVATOR_X, tenantId: TENANT_B }), // same asset, other tenant
  ];

  const u = computeUtilisation(readings, { assetId: EXCAVATOR_X, tenantId: TENANT_A, ...A_PERIOD });

  assert.equal(u.readingCount, 2, 'only the two matching asset+tenant rows are in scope');
  assert.equal(u.billableSeconds, 3600, 'the other asset/tenant rows must not inflate the figure');
});

test('ledger: readings outside [periodStartMs, periodEndMs) are excluded — boundary is [start, end)', () => {
  const readings = [
    reading(T0 - HOUR_MS, 800_000), // before the window — excluded
    reading(T0, 900_000), // AT periodStartMs — included (>=)
    reading(T0 + 1 * HOUR_MS, 903_600), // in window
    reading(T0 + 24 * HOUR_MS, 999_999), // AT periodEndMs — excluded (<)
  ];

  const u = computeUtilisation(readings, { assetId: EXCAVATOR_X, tenantId: TENANT_A, ...A_PERIOD });

  assert.equal(u.readingCount, 2, 'only the start-of-window and in-window readings count');
  assert.equal(u.billableSeconds, 3600, 'the delta must not include the excluded boundary readings');
});

test('ledger: a single ECU reading IS billable at 0 seconds — real evidence, just no interval yet', () => {
  // Mirrors the equivalent, already-tested case on the ignition-duration basis:
  // one ping is genuine evidence (billable: true), distinct from zero evidence
  // (billable: false, null) — these must never be confused.
  const u = computeUtilisation([reading(T0, 900_000)], {
    assetId: EXCAVATOR_X,
    tenantId: TENANT_A,
    ...A_PERIOD,
  });

  assert.equal(u.billable, true, 'one ECU reading is genuine evidence, unlike zero readings');
  assert.equal(u.billableSeconds, 0);
  assert.equal(u.billableHours, 0);
  assert.equal(u.readingCount, 1);
});

// ── 5. Invariant 9 / invariant 3 — no ECU evidence ⇒ not billable, null ≠ 0 ────

test('ledger: no ECU readings means NOT billable — null, never zero (invariants 3, 9)', () => {
  const u = computeUtilisation([], { assetId: GENERATOR_Y, tenantId: TENANT_B, ...A_PERIOD });

  assert.equal(u.billable, false);
  assert.equal(u.billableSeconds, null);
  assert.equal(u.billableHours, null);
});

test('ledger: seed `handover` — Generator Y / Tenant B has no billable utilisation (invariant 9)', () => {
  // The device keeps reporting AVL 102 after the handover, but Generator Y has no
  // CAN program, so decode produces no ECU readings for it — and the ledger must
  // bill nothing rather than a zero that looks like a real reading.
  const readingsB = seedEcuReadings(TENANT_B);
  assert.equal(readingsB.length, 0, 'Generator Y (no CAN program) must yield no ECU readings');

  const u = computeUtilisation(readingsB, {
    assetId: GENERATOR_Y,
    tenantId: TENANT_B,
    periodStartMs: HANDOVER_TS_MS,
    periodEndMs: Date.parse('2025-07-01T00:00:00Z'),
  });

  assert.equal(u.billable, false);
  assert.equal(u.billableHours, null);
});

// ── 6. The evidence seal is deterministic and tamper-evident (invariant 8) ────

test('ledger: the evidence seal is deterministic and tamper-evident (invariant 8)', () => {
  // A computed utilisation figure (shape per the contract above). Built as a
  // literal so THIS test isolates the seal — sealUtilisationRecord is what must
  // throw today, not computeUtilisation.
  const utilisation = {
    assetId: EXCAVATOR_X,
    tenantId: TENANT_A,
    ...A_PERIOD,
    source: 'ecu',
    billable: true,
    billableSeconds: 3600,
    billableHours: 1,
    readingCount: 2,
    anomalies: [],
  };

  // The exact bytes the readings derive from — the append-only evidence root
  // (raw_frames). A dispute is ultimately proven against these.
  const frames = [
    { id: 'f1', raw: Buffer.from([0x00, 0x11, 0x22, 0x33]) },
    { id: 'f2', raw: Buffer.from([0x44, 0x55, 0x66, 0x77]) },
  ];

  const sealed = sealUtilisationRecord(utilisation, frames);
  assert.equal(sealed.frameCount, 2);
  assert.equal(typeof sealed.manifestHash, 'string');
  assert.ok(sealed.manifestHash.length > 0);

  // Deterministic: identical inputs → identical hash (a dispute pack must be
  // reproducible byte-for-byte).
  const again = sealUtilisationRecord(utilisation, frames);
  assert.equal(again.manifestHash, sealed.manifestHash);

  // Tamper: flip ONE byte of ONE sealed frame → the manifest hash MUST change.
  const tampered = [
    frames[0],
    { id: 'f2', raw: Buffer.from([0x44, 0x55, 0x66, 0x78]) }, // 0x77 → 0x78
  ];
  const resealed = sealUtilisationRecord(utilisation, tampered);
  assert.notEqual(
    resealed.manifestHash,
    sealed.manifestHash,
    'mutating a sealed frame must be detectable — the manifest hash must change',
  );
});
