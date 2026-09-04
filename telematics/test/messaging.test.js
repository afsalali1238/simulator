// ─────────────────────────────────────────────────────────────────────────────
// test/messaging.test.js — Module 7 wiring: rules events -> delivery (dispatch.js).
//
// This does NOT test a live WhatsApp send — there is no live sender in this repo
// (see src/messaging/index.js, CLAUDE.md §Guardrails: messaging stays a throwing
// stub until there are Meta credentials + approved templates). It tests the real,
// finished plumbing around that future sender: template mapping, idempotent
// dedupe (invariant 2), tenant-scoped delivery (invariant 7), partial-failure
// isolation, and unmapped-event reporting. Every test here injects its own mock
// sender explicitly — nothing here calls a real API, on purpose.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliverEvents, templateForEvent, EVENT_TEMPLATE_MAP } from '../src/messaging/dispatch.js';
import { buildScenario, scenarioRecords } from '../src/simulator/scenarios.js';
import { resolveAssignment, DEVICES } from '../src/store/seed-data.js';
import { normalizeRecord } from '../src/decode/normalize.js';
import { detectEvents } from '../src/rules/detectEvents.js';

function canonicalRecords(name) {
  return scenarioRecords(buildScenario(name)).map((r) => {
    const device = DEVICES.find((d) => d.imei === r.imei);
    const assignment = resolveAssignment(device.id, r.timestampMs);
    return normalizeRecord(r, { device, assignment });
  });
}

function mockSender(calls) {
  return async (payload) => {
    calls.push(payload);
    return { status: 'mock-sent', to: payload.tenantId, template: payload.template };
  };
}

test('templateForEvent: every rule type detectEvents can emit has an approved-template mapping', () => {
  const ruleTypes = [
    'geofence-enter', 'geofence-exit', 'after-hours-ignition',
    'idle-too-long', 'tamper-unplug', 'low-battery',
  ];
  for (const type of ruleTypes) {
    assert.ok(templateForEvent(type), `expected a template mapping for ${type}`);
  }
  assert.equal(templateForEvent('not-a-real-event-type'), null);
});

test('deliverEvents: throws without a sender — there is no default (no fake-send)', async () => {
  await assert.rejects(
    () => deliverEvents([{ eventId: 'x', type: 'low-battery', tenantId: 1, assetId: 1 }], {}),
    /requires a sender/,
  );
});

test('deliverEvents: delivers each mapped event exactly once, via the injected sender', async () => {
  const events = detectEvents(canonicalRecords('geofence-cross'), {});
  assert.ok(events.length > 0, 'sanity: geofence-cross should produce events');

  const calls = [];
  const result = await deliverEvents(events, { sender: mockSender(calls) });

  assert.equal(result.delivered.length, events.length);
  assert.equal(calls.length, events.length);
  assert.equal(result.failed.length, 0);
  assert.equal(result.skippedDuplicate.length, 0);
  assert.equal(result.skippedUnmapped.length, 0);
});

test('deliverEvents: idempotent across two calls sharing a deliveredLog (invariant 2)', async () => {
  const events = detectEvents(canonicalRecords('tamper'), {});
  assert.ok(events.length > 0, 'sanity: tamper scenario should produce events');

  const deliveredLog = new Set();
  const calls = [];
  const sender = mockSender(calls);

  const first = await deliverEvents(events, { sender, deliveredLog });
  assert.equal(first.delivered.length, events.length);

  const second = await deliverEvents(events, { sender, deliveredLog });
  assert.equal(second.delivered.length, 0, 're-delivery of the same batch must not re-send');
  assert.equal(second.skippedDuplicate.length, events.length);
  assert.equal(calls.length, events.length, 'sender must not be called again on replay');
});

test('deliverEvents: dedupes within a single call too, not only across calls', async () => {
  const events = [
    { eventId: 'dup-1', type: 'low-battery', tenantId: 1, assetId: 1, tsMs: 0, detail: {} },
    { eventId: 'dup-1', type: 'low-battery', tenantId: 1, assetId: 1, tsMs: 0, detail: {} },
  ];
  const calls = [];
  const result = await deliverEvents(events, { sender: mockSender(calls) });
  assert.equal(result.delivered.length, 1);
  assert.equal(result.skippedDuplicate.length, 1);
  assert.equal(calls.length, 1);
});

test('deliverEvents: tenant isolation — each send is scoped to that event\'s own tenantId (invariant 7)', async () => {
  const events = [
    { eventId: 'a', type: 'low-battery', tenantId: 'tenant-A', assetId: 1, tsMs: 0, detail: {} },
    { eventId: 'b', type: 'low-battery', tenantId: 'tenant-B', assetId: 2, tsMs: 0, detail: {} },
  ];
  const calls = [];
  await deliverEvents(events, { sender: mockSender(calls) });

  assert.equal(calls.length, 2);
  const tenantsCalled = calls.map((c) => c.tenantId).sort();
  assert.deepEqual(tenantsCalled, ['tenant-A', 'tenant-B']);
  // no call carries more than one event / more than one tenant — no fan-out batching
  for (const call of calls) {
    assert.equal(typeof call.tenantId, 'string');
    assert.ok(call.event, 'each call carries exactly one event');
  }
});

test('deliverEvents: one failed send does not sink the batch, and is not marked delivered', async () => {
  const events = [
    { eventId: 'ok-1', type: 'low-battery', tenantId: 1, assetId: 1, tsMs: 0, detail: {} },
    { eventId: 'bad-1', type: 'low-battery', tenantId: 1, assetId: 2, tsMs: 0, detail: {} },
    { eventId: 'ok-2', type: 'low-battery', tenantId: 1, assetId: 3, tsMs: 0, detail: {} },
  ];
  const deliveredLog = new Set();
  const failingSender = async (payload) => {
    if (payload.event.eventId === 'bad-1') throw new Error('simulated Meta API failure');
    return { status: 'mock-sent' };
  };

  const result = await deliverEvents(events, { sender: failingSender, deliveredLog });

  assert.equal(result.delivered.length, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].eventId, 'bad-1');
  assert.ok(!deliveredLog.has('bad-1'), 'a failed send must remain retryable, not marked delivered');
  assert.ok(deliveredLog.has('ok-1') && deliveredLog.has('ok-2'));
});

test('deliverEvents: unmapped event types are reported, not silently dropped or sent', async () => {
  const events = [
    { eventId: 'known-1', type: 'low-battery', tenantId: 1, assetId: 1, tsMs: 0, detail: {} },
    { eventId: 'unknown-1', type: 'some-future-rule-type', tenantId: 1, assetId: 1, tsMs: 0, detail: {} },
  ];
  const calls = [];
  const result = await deliverEvents(events, { sender: mockSender(calls) });

  assert.equal(result.delivered.length, 1);
  assert.equal(result.skippedUnmapped.length, 1);
  assert.equal(result.skippedUnmapped[0].eventId, 'unknown-1');
  assert.equal(calls.length, 1, 'sender must never be called for an unmapped event type');
});

test('EVENT_TEMPLATE_MAP: template names are placeholders, not accidentally wired to a real Meta template id', () => {
  // Guards against someone quietly swapping in a real-looking template id here
  // without also building the real sender — the naming convention documents
  // that these are NOT approved yet.
  for (const name of Object.values(EVENT_TEMPLATE_MAP)) {
    assert.match(name, /^kasper_[a-z_]+_v1$/, `${name} should follow the placeholder naming convention`);
  }
});
