// ─────────────────────────────────────────────────────────────────────────────
// src/messaging/index.js — Module 7 (WhatsApp-native notifications). DEFINED-ONLY.
//
// Stubbed so the nine-module shape is complete. In production this turns telematics
// events (geofence exit, ignition-on outside hours, tamper/unplug, low battery)
// into WhatsApp Cloud API messages to the asset's tenant — the same WhatsApp-native
// spine the Marketplace uses. It is deliberately out of the thin slice because it
// needs live Meta credentials and a template-approval process, neither of which
// belongs in a local, free, offline build.
//
// What it will do (see Dozr_GPS_PRD.html FR-MSG-*):
//   • Subscribe to enriched events from the ingestion/enrichment path.
//   • Map event -> approved WhatsApp template, throttle/deduplicate, deliver, and
//     record delivery receipts for audit.
//   • Respect tenant isolation (invariant 7): a tenant only ever hears about its
//     own assets.
//
// Throws so no half-built notifier can start paging real users.
// ─────────────────────────────────────────────────────────────────────────────

export function notify() {
  throw new Error(
    'messaging module is defined-only in this slice — see Dozr_GPS_PRD.html FR-MSG; ' +
      'needs live WhatsApp Cloud API credentials + approved templates (out of scope for the local build)',
  );
}
