// ─────────────────────────────────────────────────────────────────────────────
// src/ledger/ignition-duration.js — a SECOND, explicitly different billing
// basis: ignition-on duration.
//
// Why this file exists and is NOT part of computeUtilisation() in index.js:
// that function is the ECU (AVL 102) utilisation ledger, and invariant 5
// forbids ignition-/estimated-derived data from ever backing that figure —
// on purpose, because ignition-on time is a poor proxy for actual engine wear
// on machinery billed by usage (an excavator can idle for hours with the key
// on, doing no work).
//
// This fleet (Mercedes-Benz Actros tractor + flatbed trailer, FMC130 only, NO
// CAN adapter installed) cannot produce AVL 102 at all — LV-CAN200 / ALL-CAN300
// / CAN-CONTROL is what exposes it, and none is fitted (see
// D1_CAN_ENGINE_HOURS.md §1). So it is never eligible for `computeUtilisation`;
// `source: 'ecu'` billing is not merely unavailable, it is architecturally
// impossible for this hardware configuration. The business decision (human
// sign-off, 2026-09-02) is to bill this fleet on a DIFFERENT, honestly-labeled
// basis instead: how long the ignition was on. This is not a workaround for
// missing ECU data and must never be presented as one — `source` on the
// returned figure is `'ignition'`, never `'ecu'`, precisely so a dispute pack
// or an invoice line can never be confused with the ECU ledger's guarantees.
//
// What this proves:
//   • billable duration = the sum of observed intervals where the PRIOR
//     reading's ignition was true (interval attribution: the state at the
//     start of a gap describes that gap, matching Module 8's idle-too-long
//     spell logic) — never a projection past the last real reading.
//   • `maxGapSeconds` (opt-in) caps what a single ON interval may contribute.
//     Interval attribution bills a device-offline stretch at its last known
//     state, so a `true` reading followed by days of silence would otherwise
//     bill the entire silence from two records. With a cap, the excess is
//     excluded and recorded as an `oversized-gap-capped` anomaly for human
//     review. The CAP THRESHOLD ITSELF is a business decision that has NOT
//     been taken yet (tracked in TASKS.md, P2) — so the parameter is opt-in
//     and the default behaviour (no cap) is unchanged until the ledger owner
//     signs a number.
//   • ignition === null (unknown, e.g. a dropped record) excludes that
//     interval and is recorded as an anomaly, never treated as off (invariant
//     3: absence is not evidence) and never treated as on.
//   • no readings in scope at all ⇒ NOT billable, figures null (never 0) —
//     same invariant-3/9 discipline as the ECU ledger, for the same reason:
//     "we have zero evidence" must never look like "we have evidence of zero".
//   • one reading with nothing to compare it to ⇒ genuinely billable at 0
//     seconds (we DO have evidence — a single ping — there is just no interval
//     to sum yet). This is a real, computed answer, distinct from "no evidence".
// ─────────────────────────────────────────────────────────────────────────────

export const BILLING_BASIS = 'ignition-on-duration';

// ---------------------------------------------------------------------------
// computeIgnitionOnDuration(records, { assetId, tenantId, periodStartMs, periodEndMs })
//   -> {
//        assetId, tenantId, periodStartMs, periodEndMs,
//        source: 'ignition',            // NEVER 'ecu' — see file header
//        billable: boolean,
//        billableSeconds: number|null,
//        billableHours: number|null,
//        readingCount: number,
//        anomalies: Array<{ type, tsMs }>,
//      }
//
// `records` — canonical records (src/decode/normalize.js shape is a superset):
//   { assetId, tenantId, tsMs, ignition }   ignition ∈ {true, false, null}
//
// `maxGapSeconds` — optional cap (positive number) on what one ON interval may
//   contribute to billableSeconds; undefined/null = uncapped (current default).
// ---------------------------------------------------------------------------
export function computeIgnitionOnDuration(records, { assetId, tenantId, periodStartMs, periodEndMs, maxGapSeconds } = {}) {
  if (
    maxGapSeconds != null &&
    (!Number.isFinite(maxGapSeconds) || maxGapSeconds <= 0)
  ) {
    throw new Error('maxGapSeconds must be a positive finite number of seconds, or omitted');
  }
  if (periodStartMs == null || periodEndMs == null || periodEndMs < periodStartMs) {
    throw new Error(
      'computeIgnitionOnDuration requires a valid periodStartMs/periodEndMs window (periodEndMs >= periodStartMs)',
    );
  }

  const scoped = records
    .filter(
      (r) =>
        r.assetId === assetId &&
        r.tenantId === tenantId &&
        r.tsMs >= periodStartMs &&
        r.tsMs < periodEndMs,
    )
    .sort((a, b) => a.tsMs - b.tsMs);

  if (scoped.length === 0) {
    return {
      assetId,
      tenantId,
      periodStartMs,
      periodEndMs,
      source: 'ignition',
      billable: false,
      billableSeconds: null,
      billableHours: null,
      readingCount: 0,
      anomalies: [],
    };
  }

  const anomalies = [];
  let billableSeconds = 0;

  // Interval attribution: the gap [records[i].tsMs, records[i+1].tsMs) is
  // described by records[i]'s ignition state — the reading we actually have
  // at the START of that gap. The tail after the LAST reading (up to
  // periodEndMs) is deliberately never counted: we have no observation of
  // what happened there, and this basis never extrapolates past real data.
  for (let i = 0; i < scoped.length - 1; i += 1) {
    const current = scoped[i];
    const next = scoped[i + 1];
    const gapSeconds = (next.tsMs - current.tsMs) / 1000;

    if (current.ignition === true) {
      if (maxGapSeconds != null && gapSeconds > maxGapSeconds) {
        // The device went silent mid-ON. Bill only what the cap allows; the
        // silence beyond it is not evidence of work — surface it for review.
        billableSeconds += maxGapSeconds;
        anomalies.push({
          type: 'oversized-gap-capped',
          tsMs: current.tsMs,
          detail: { observedSeconds: gapSeconds, countedSeconds: maxGapSeconds },
        });
      } else {
        billableSeconds += gapSeconds;
      }
    } else if (current.ignition == null) {
      // Unknown must never be read as off OR on — exclude, and say so.
      anomalies.push({ type: 'ignition-unknown-excluded', tsMs: current.tsMs });
    }
    // ignition === false: contributes 0, not an anomaly — a genuine "off" reading.
  }

  return {
    assetId,
    tenantId,
    periodStartMs,
    periodEndMs,
    source: 'ignition',
    billable: true,
    billableSeconds,
    billableHours: billableSeconds / 3600,
    readingCount: scoped.length,
    anomalies,
  };
}
