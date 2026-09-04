// ─────────────────────────────────────────────────────────────────────────────
// src/messaging/dispatch.js — Module 7 wiring: rules events → delivery.
//
// This is the delivery/dedupe plumbing that sits between Module 8 (rules) and
// an actual WhatsApp send. It is real and tested. What it deliberately does NOT
// do is send anything itself: `deliverEvents()` requires the caller to supply a
// `sender` — there is no default, and it throws if one is missing. Building a
// live Meta Cloud API sender is out of scope until credentials + approved
// templates exist (see `src/messaging/index.js`, `CLAUDE.md` §Guardrails,
// `HERMES_HANDOFF.md` "don't fake-send"). Nothing in this file calls a real API,
// and nothing in it can be mistaken for one.
//
// What this proves now, so wiring the real sender later is mechanical rather
// than a redesign:
//   • event type → approved WhatsApp template name mapping (PRD FR-MSG-1)
//   • idempotent delivery: re-running the same batch never double-sends
//     (invariant 2) — dedupe keys on the rule engine's own deterministic
//     `eventId`, never on message content or a freshly-minted id
//   • tenant isolation (invariant 7): each send is scoped to that event's own
//     tenantId; there is no fan-out across tenants and no shared batch call
//   • one bad send does not sink the batch — failures are captured per-event,
//     not thrown, and a failed event is NOT marked delivered, so it is safe to
//     retry on the next pass without re-sending everything that already went out
//   • an event type with no approved template is reported, never silently
//     dropped — so a new rule type doesn't go quietly unnoticed at delivery time
// ─────────────────────────────────────────────────────────────────────────────

// PLACEHOLDER NAMES. None of these are approved Meta message templates yet —
// nobody has submitted them for review. Whoever does the real FR-MSG-1 work
// replaces these strings with the real approved template names in the same
// commit; nothing else in this file needs to change, because the sender is
// injected and the mapping is the only thing that names a template.
const EVENT_TEMPLATE_MAP = {
  'geofence-enter': 'kasper_geofence_enter_v1',
  'geofence-exit': 'kasper_geofence_exit_v1',
  'after-hours-ignition': 'kasper_after_hours_ignition_v1',
  'idle-too-long': 'kasper_idle_too_long_v1',
  'tamper-unplug': 'kasper_tamper_unplug_v1',
  'low-battery': 'kasper_low_battery_v1',
};

/** The approved-template name for a rule event type, or null if unmapped. */
export function templateForEvent(eventType) {
  return EVENT_TEMPLATE_MAP[eventType] ?? null;
}

// ---------------------------------------------------------------------------
// deliverEvents(events, { sender, deliveredLog }) -> Promise<Result>
//
// events        — ordered array of Event objects from detectEvents() (Module 8):
//   { type, assetId, tenantId, tsMs, eventId, detail }
// sender        — REQUIRED. async ({ tenantId, assetId, template, event }) =>
//   receipt. The real implementation (Module 7, credential-gated) is provided
//   by the caller; tests inject a mock. There is no default.
// deliveredLog  — optional dedupe store, defaults to a fresh in-memory Set for
//   the call. Needs `has(eventId)` and `add(eventId)`. In production this must
//   be backed by durable storage (e.g. a delivery-receipts table keyed on
//   eventId) so a process restart doesn't re-deliver — same pattern as the
//   store adapters (src/store/index.js): the interface here is the contract,
//   the memory Set is the zero-setup stand-in.
//
// Result — { delivered, skippedDuplicate, skippedUnmapped, failed }, each an
// array so a caller can log/audit every outcome, not just the happy path.
// ---------------------------------------------------------------------------
export async function deliverEvents(events, { sender, deliveredLog = new Set() } = {}) {
  if (typeof sender !== 'function') {
    throw new Error(
      'deliverEvents requires a sender — there is no default. A real sender ' +
        'needs live Meta credentials + approved templates (Module 7, see ' +
        'src/messaging/index.js); pass a test sender explicitly in tests.',
    );
  }

  const result = { delivered: [], skippedDuplicate: [], skippedUnmapped: [], failed: [] };

  for (const event of events) {
    if (deliveredLog.has(event.eventId)) {
      result.skippedDuplicate.push(event.eventId);
      continue;
    }

    const template = templateForEvent(event.type);
    if (!template) {
      result.skippedUnmapped.push({ eventId: event.eventId, type: event.type });
      continue;
    }

    try {
      const receipt = await sender({
        tenantId: event.tenantId,
        assetId: event.assetId,
        template,
        event,
      });
      deliveredLog.add(event.eventId);
      result.delivered.push({ eventId: event.eventId, tenantId: event.tenantId, template, receipt });
    } catch (err) {
      // Deliberately NOT added to deliveredLog: a failed send must stay
      // retryable on the next pass, not be silently treated as sent.
      result.failed.push({ eventId: event.eventId, tenantId: event.tenantId, error: err.message });
    }
  }

  return result;
}

export { EVENT_TEMPLATE_MAP };
