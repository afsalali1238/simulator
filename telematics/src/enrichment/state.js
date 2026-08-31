// ─────────────────────────────────────────────────────────────────────────────
// src/enrichment/state.js — derive an operational state from the signals we have.
// Pure function; part of Module 4 (Enrichment & rules).
//
// Slice scope: off / idle / moving / unknown. "working" (engine on AND doing
// useful work) needs more signals than ignition alone — e.g. hydraulic pressure
// or PTO over CAN — so it is intentionally NOT inferred here. Documented in
// docs/MODULES.md; the dev team adds it when those CAN signals are mapped (D1).
// ─────────────────────────────────────────────────────────────────────────────

const SPEED_MOVING_KMH = 3; // below this we treat GPS speed as noise/stationary

export function deriveState({ ignition, movement, speed }) {
  if (ignition == null) return 'unknown'; // invariant 3: no signal != "off"
  if (ignition === false) return 'off';
  const moving =
    movement === true || (typeof speed === 'number' && speed > SPEED_MOVING_KMH);
  return moving ? 'moving' : 'idle';
}
