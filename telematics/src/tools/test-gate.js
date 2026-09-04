// ─────────────────────────────────────────────────────────────────────────────
// src/tools/test-gate.js — the merge gate (`npm run test:gate`).
//
// `npm test` already fails on a failing test. What it does NOT catch is the two
// ways a suite quietly rots:
//
//   1. a test gets deleted or a file stops being picked up — the count drops and
//      nothing complains,
//   2. a test gets skipped/todo'd to make a build green.
//
// Either of those silently retires an invariant's proof, which in a billing and
// tenancy system is the failure mode that matters. So CI runs THIS instead of a
// bare `npm test`: it runs the suite under the TAP reporter, parses the summary,
// and fails unless
//
//   pass >= MIN_TESTS  ·  fail == 0  ·  skipped == 0  ·  todo == 0
//
// MIN_TESTS lives in the file below, next to the suite it describes. Adding
// tests is expected — raise the floor when you do. Lowering it is a deliberate,
// reviewable act, which is the point.
//
// Usage:
//   node src/tools/test-gate.js            # memory mode (the P0 gate)
//   DB=pg node src/tools/test-gate.js      # same gate under Postgres (P1)
//   MIN_TESTS=70 node src/tools/test-gate.js
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { listTestFiles, ROOT } from './test-files.js';

// The floor. Raise this when you add tests; see TESTING.md for the breakdown.
//
// This is the MEMORY-mode count, because memory mode is what CI's merge gate
// runs. Under DB=pg the count is higher: test/rls.test.js and
// test/immutability.test.js register their 4 tests each only when config.db ===
// 'pg'. In memory mode each of those files registers no subtests, so node --test
// reports the FILE itself as one passing test — hence the +6 gap between the two
// modes rather than +8.
//
// 88 = P0/D1/P1 baseline + dic-to-reem + FMC130 fidelity test
// 94 = 88 + 6 rules tests
// 100 = rules engine (Module 8) finished — 12 rules tests total
// 109 = 100 + 9 messaging dispatch tests (Module 7 wiring: template mapping,
//        idempotent delivery, tenant isolation, partial-failure isolation —
//        NOT a live send; the real Meta sender is still credential-gated)
// 117 = 109 + 8 ledger tests (Module 5: ECU-only utilisation with exact seed
//        `handover` figures, never-negative deltas, tamper-evident seal —
//        built by explicit human sign-off per CLAUDE.md; NOT yet wired to any
//        real invoice path, which additionally needs the D1 hardware half)
// 126 = 117 + 9 ignition-on-duration tests (src/ledger/ignition-duration.js):
//        a SECOND, explicitly different billing basis for the Actros/flatbed
//        fleet, which has no CAN adapter and can never produce AVL 102 —
//        source: 'ignition', never 'ecu', so it can never be mistaken for the
//        ECU ledger above
// 135 = 126 + 7 handshake-limiter tests (src/ingestion/handshake-limiter.js,
//        pure/isolated: counting, blocking, block expiry, window reset,
//        success-reset, memory-bounding sweep) + 2 ingestion-rate-limit tests
//        (same behaviour proved over a REAL TCP socket: a blocked source gets
//        zero bytes back — not even the ordinary reject byte — for ANY IMEI
//        it tries next, and one earlier failure never blocks a legitimate
//        handshake). P0 hardening: the IMEI handshake was previously the only
//        gate on the ingestion port, and an IMEI is not a secret.
// 149 = 135 + 14 parser/handshake hardening tests from the 2026-09-02 review:
//        10 pure (test/codec-hardening.js) — F1 over-large declared length is
//        refused not buffered (+ custom-cap boundary), F2 unknown codec id is
//        refused not parsed as Codec 8 (+ both documented codecs still parse),
//        F4 IMEI frame length is bounded and isValidImei enforces 15 ASCII
//        digits, F5 a truncated record throws a LABELLED error (not a bare
//        RangeError), plus the three coverage gaps the review flagged as
//        correct-but-unproven (bad preamble, Number-of-Data mismatch,
//        truncation); and 4 wire-level (test/ingestion-hardening.js) — F6 a
//        silent pre-handshake socket is closed by the handshake timeout, a
//        handshaked-then-quiet socket by the idle timeout, maxConnections
//        refuses a connection past the cap, and F4 a malformed IMEI is
//        rejected over the wire AND counts toward the per-source limiter.
// 169 = 149 + 20 unique-IMEI fleet-simulation tests: 12 identity/onboarding
//        (test/imei.js — Luhn pinned to the seed: D1 356307042441013 is valid,
//        D2 356307042441099 is hand-typed and invalid; makeImei/generateFleet
//        are 15-digit, TAC-35630704, Luhn-valid, unique, deterministic, disjoint
//        from the seed, and clear codec.js's format-only isValidImei gate) and
//        8 wire-level (test/fleet.js — a PROVISIONED generated IMEI handshakes
//        0x01 and persists; an UNPROVISIONED well-formed one is rejected at the
//        registry gate; the owner-tenant-only fleet is position + ignition only
//        with NO engine data (invariant 9), every record attributed to the owner
//        and none leaking to A/B (invariant 7), idempotent on resend (invariant
//        2), bad-Luhn refused before the registry, and runMemory end-to-end).
// 172 = 169 + 3 load-test harness smoke tests (test/load-test-smoke.test.js):
//        the harness (src/tools/load-test.js) connects real synthetic devices
//        over real TCP at a tiny fixed scale, sends and ACKs records, and
//        reports a clean pass with the shape callers rely on; a connect
//        failure (nothing listening) is counted, not a hang; syntheticDevices
//        produces distinct well-formed 15-digit IMEIs in the reserved 900...
//        range. The load test itself (throughput/latency numbers) stays OUT
//        of this gate deliberately — see the file header in load-test.js.
// 176 = 172 + 4 maxGapSeconds tests for the ignition-duration basis
//        (src/ledger/ignition-duration.js): an over-long ON gap is capped and
//        recorded as `oversized-gap-capped`, gaps within the cap are untouched,
//        bad cap values are rejected, and an UNKNOWN gap is never capped —
//        it stays `ignition-unknown-excluded` (invariant 3). The cap is opt-in;
//        the default (uncapped) behaviour is pinned by the new uncapped assert.
//        The production threshold itself is an unsigned business decision —
//        tracked in TASKS.md Phase P2.
// 179 = 176 + 3 ledger-correctness review tests (test/ledger.test.js,
//        2026-09-03 human-reviewed pass): computeUtilisation cross-
//        asset/cross-tenant leak guard (invariants 6, 7), the [start, end)
//        period-boundary contract pinned with a synthetic fixture (was
//        previously only implied by the seed-scenario test), and a single
//        ECU reading is billable at 0 seconds (real evidence, not the same
//        as zero evidence) — parity with the equivalent, already-tested
//        case on the ignition-duration basis. No production behaviour
//        changed; this locks down what was already correct but unproven.
const DEFAULT_MIN_TESTS = 185;

const MIN_TESTS = Number(process.env.MIN_TESTS || DEFAULT_MIN_TESTS);

const files = listTestFiles();

// Serial execution is deliberate: several suites bind real TCP/HTTP sockets and
// would race for ports in parallel. Do not "optimise" this away.
// Explicit file paths rather than a glob or a directory — see test-files.js for
// why neither is portable across Node 20/22/24.
const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files];

console.log(`gate: running ${files.length} suite(s) serially on node ${process.version}`);

const child = spawn(process.execPath, args, {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'inherit'],
  shell: false,
});

let out = '';
child.stdout.on('data', (d) => {
  const s = d.toString();
  out += s;
  process.stdout.write(s);
});

// Pull `# tests 63` style lines out of the TAP summary. The final occurrence is
// the run total (nested subtests can emit their own).
function tapCount(text, key) {
  const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

child.on('close', (code) => {
  const summary = {
    tests: tapCount(out, 'tests'),
    pass: tapCount(out, 'pass'),
    fail: tapCount(out, 'fail'),
    skipped: tapCount(out, 'skipped'),
    todo: tapCount(out, 'todo'),
  };

  const problems = [];
  if (!files.length) problems.push('no test files were found under test/ at all');
  if (summary.pass == null) problems.push('could not parse the TAP summary — did the runner crash?');
  if (code !== 0) problems.push(`the test runner exited ${code}`);
  if (summary.fail) problems.push(`${summary.fail} test(s) failed`);
  if (summary.skipped) problems.push(`${summary.skipped} test(s) skipped — a skip is not a pass`);
  if (summary.todo) problems.push(`${summary.todo} test(s) marked todo`);
  if (summary.pass != null && summary.pass < MIN_TESTS) {
    problems.push(
      `only ${summary.pass} tests passed, expected at least ${MIN_TESTS} — ` +
        'a test was deleted or a suite stopped being collected. If this is intentional, ' +
        'change DEFAULT_MIN_TESTS in src/tools/test-gate.js in the same commit.',
    );
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(
    `gate: store=${process.env.DB || 'memory'} pass=${summary.pass} fail=${summary.fail} ` +
      `skipped=${summary.skipped} todo=${summary.todo} floor=${MIN_TESTS}`,
  );

  if (problems.length) {
    console.log('GATE FAILED:');
    for (const p of problems) console.log(`  · ${p}`);
    console.log('─'.repeat(70));
    process.exit(1);
  }

  console.log('GATE PASSED');
  console.log('─'.repeat(70));
});
