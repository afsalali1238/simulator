// ─────────────────────────────────────────────────────────────────────────────
// src/ledger/index.js — Module 5 (Utilisation ledger & evidence). DEFINED-ONLY.
//
// This module is intentionally NOT implemented in the thin slice. In the build
// docs it is flagged as the one module that needs a human expert to own, because
// its failure mode is a silently wrong BILLING number. It is stubbed here so the
// nine-module shape is complete and the contract is visible to the dev team.
//
// What it will do (see Dozr_GPS_PRD.html FR-LED-* / FR-EVID-*):
//   • Compute utilisation per asset per billing period from `engine_readings`
//     where source = 'ecu' ONLY. Estimated values may inform a display but may
//     never back an invoice (invariant 5).
//   • Seal each period into an immutable utilisation_record carrying a
//     tamper-evident manifest hash over the exact raw_frames it derives from,
//     retained 7 years, able to produce a full dispute pack on demand (invariant 8).
//
// Deliberately throws so nobody wires it into billing before it is built for real.
// ─────────────────────────────────────────────────────────────────────────────

export function computeUtilisation() {
  throw new Error(
    'ledger module is defined-only in this slice — see Dozr_GPS_PRD.html FR-LED / FR-EVID; ' +
      'must be built and reviewed by a human before it backs any invoice (invariants 5, 8)',
  );
}

export function sealUtilisationRecord() {
  throw new Error('ledger module is defined-only in this slice');
}
