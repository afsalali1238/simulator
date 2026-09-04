// ─────────────────────────────────────────────────────────────────────────────
// src/ledger/index.js — Module 5 (Utilisation ledger & evidence).
//
// Built 2026-09-02, by explicit sign-off from the human owner this module was
// gated behind (CLAUDE.md §Guardrails: "The ledger is built by a human in phase
// P2... anything touching billing or tenancy is human-reviewed, not just
// generated"). This file implements the exact contract pinned by
// `test/pending/ledger.test.js` (now moved to `test/ledger.test.js` — see that
// file for the ten cases this was built against, including the seed `handover`
// scenario's EXACT figures).
//
// What this proves:
//   • computeUtilisation — utilisation from ECU (AVL 102) readings ONLY
//     (invariant 4: ecu vs estimated never merge). A non-'ecu' reading is
//     excluded and recorded as an anomaly, never silently dropped or blended in.
//   • never bills a negative delta — a hour-meter DECREASE is an adapter/ECU
//     swap (a reset), not negative usage; it contributes 0 and is surfaced as
//     a 'meter-reset' anomaly for human review, never swallowed.
//   • no ECU evidence ⇒ NOT billable — `billable: false`, and the figures are
//     `null`, never a billable-looking `0` (invariant 3 / invariant 9: an asset
//     with no CAN program produces no engine data at all, which must read as
//     "no evidence", not "zero usage").
//   • sealUtilisationRecord — a deterministic, tamper-evident manifest hash over
//     the exact raw_frames a figure derives from (invariant 8): identical inputs
//     reproduce the identical hash (a dispute pack is reproducible byte-for-
//     byte), and mutating a single byte of a single sealed frame changes it.
//
// What this is explicitly NOT: the last word on whether a number here may back
// a real invoice. Per CLAUDE.md, that additionally requires (both still open,
// tracked in TASKS.md Phase P2):
//   • the D1 hardware half — a real installed adapter's AVL 102 reading
//     reconciled against the machine's own physical hour-meter, per program
//     number, per exact make/model/year (see D1_CAN_ENGINE_HOURS.md);
//   • human review of the billing math on real fleet data before it emits a
//     number that reaches an actual invoice.
// This module is correct against its spec and the seed scenario; it is not yet
// wired into any API route or invoice path, and should not be until the two
// items above are met.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// computeUtilisation(readings, { assetId, tenantId, periodStartMs, periodEndMs })
//   -> {
//        assetId, tenantId, periodStartMs, periodEndMs,
//        source: 'ecu',                 // invariant 4 — the only billable source
//        billable: boolean,
//        billableSeconds: number|null,  // null when not billable (inv 3, never 0)
//        billableHours: number|null,
//        readingCount: number,          // ECU readings actually used
//        anomalies: Array<{ type, ... }>,
//      }
//
// `readings` — the store's engine_readings shape, any order:
//   { assetId, tenantId, tsMs, seconds, hours, source }   source ∈ {ecu,estimated}
//
// Utilisation is the sum of POSITIVE deltas between consecutive ECU readings
// (by tsMs) for the given asset/tenant, within [periodStartMs, periodEndMs).
//
// PERIOD-BOUNDARY CONTRACT: the first reading INSIDE the window has no prior
// in-scope reading to delta against, so engine time accumulated between the
// last out-of-window reading and the first in-window one is deliberately NOT
// counted. Figures are therefore deterministic and conservative — a billing
// integration must not assume the result covers the window's leading edge.
// A reading exactly AT periodStartMs is in scope (>=); one AT periodEndMs is
// not (<).
// A delta ≤ 0 contributes 0; a delta < 0 is also recorded as a 'meter-reset'
// anomaly (a hardware/adapter swap resets the counter — it is never negative
// usage). Readings outside the requested asset/tenant/period, or not sourced
// from the ECU, are excluded before the sum and never affect the figure.
// ---------------------------------------------------------------------------
export function computeUtilisation(readings, { assetId, tenantId, periodStartMs, periodEndMs }) {
  if (periodStartMs == null || periodEndMs == null || periodEndMs < periodStartMs) {
    throw new Error(
      'computeUtilisation requires a valid periodStartMs/periodEndMs window (periodEndMs >= periodStartMs)',
    );
  }

  // Scope to exactly this asset, this tenant, this period — attribution at
  // each record's own timestamp (invariant 6), never "as of now".
  const scoped = readings.filter(
    (r) =>
      r.assetId === assetId &&
      r.tenantId === tenantId &&
      r.tsMs >= periodStartMs &&
      r.tsMs < periodEndMs,
  );

  const anomalies = [];
  const ecuRows = [];
  for (const r of scoped) {
    if (r.source === 'ecu') {
      ecuRows.push(r);
    } else {
      // Recorded, not dropped silently — invariant 5: estimated/ignition-derived
      // evidence may inform a display, it must never inflate an invoice, and a
      // reviewer must be able to see exactly what was excluded and why.
      anomalies.push({ type: 'non-ecu-excluded', tsMs: r.tsMs, source: r.source });
    }
  }
  ecuRows.sort((a, b) => a.tsMs - b.tsMs);

  if (ecuRows.length === 0) {
    // Invariant 9 / invariant 3: no ECU evidence is NOT billable, and "not
    // billable" is expressed as null — never a zero that could be mistaken for
    // a real, evidenced zero-usage period.
    return {
      assetId,
      tenantId,
      periodStartMs,
      periodEndMs,
      source: 'ecu',
      billable: false,
      billableSeconds: null,
      billableHours: null,
      readingCount: 0,
      anomalies,
    };
  }

  let billableSeconds = 0;
  for (let i = 1; i < ecuRows.length; i += 1) {
    const delta = ecuRows[i].seconds - ecuRows[i - 1].seconds;
    if (delta > 0) {
      billableSeconds += delta;
    } else if (delta < 0) {
      // A decrease is a meter reset (adapter/ECU swap), never negative usage.
      // Contributes 0 to the sum; surfaced for a human to review the swap.
      anomalies.push({
        type: 'meter-reset',
        tsMs: ecuRows[i].tsMs,
        detail: { previousSeconds: ecuRows[i - 1].seconds, nextSeconds: ecuRows[i].seconds },
      });
    }
    // delta === 0: a flat reading contributes nothing; not itself an anomaly.
  }

  return {
    assetId,
    tenantId,
    periodStartMs,
    periodEndMs,
    source: 'ecu',
    billable: true,
    billableSeconds,
    billableHours: billableSeconds / 3600,
    readingCount: ecuRows.length,
    anomalies,
  };
}

// ---------------------------------------------------------------------------
// sealUtilisationRecord(utilisation, rawFrames) -> { ...utilisation, frameCount, manifestHash }
//
// `rawFrames` — the exact append-only evidence (`raw_frames`, invariant 8) the
// figure derives from, e.g. [{ id, raw: Buffer }, ...], in a stable order the
// caller controls (the store returns raw_frames ordered by tsMs already).
//
// manifestHash is a SHA-256 over a canonical (key-sorted) serialisation of the
// utilisation figure, chained with each frame's id and exact bytes, in the
// order given. Same inputs -> same hash, always (a dispute pack must be
// reproducible byte-for-byte); changing a single byte of a single frame, or
// any field of the figure, changes the hash (tamper-evident).
// ---------------------------------------------------------------------------
export function sealUtilisationRecord(utilisation, rawFrames) {
  const h = createHash('sha256');
  h.update(stableStringify(utilisation));
  for (const frame of rawFrames) {
    h.update(String(frame.id));
    h.update(Buffer.isBuffer(frame.raw) ? frame.raw : Buffer.from(frame.raw));
  }

  return {
    ...utilisation,
    frameCount: rawFrames.length,
    manifestHash: h.digest('hex'),
  };
}

// Deterministic JSON: sorts object keys so field order never changes the hash.
// Arrays keep their given order deliberately — anomaly/frame order is itself
// evidence and must not be silently normalised away.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
