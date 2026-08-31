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
const DEFAULT_MIN_TESTS = 68;

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
