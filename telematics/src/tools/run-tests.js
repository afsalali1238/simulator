// ─────────────────────────────────────────────────────────────────────────────
// src/tools/run-tests.js — `npm test`.
//
// A thin, portable wrapper around `node --test`: it enumerates the suite in JS
// (see test-files.js — neither a glob nor a directory works on every supported
// Node) and forwards the runner's own output and exit code unchanged.
//
// `npm test` is the human-facing runner. CI uses `npm run test:gate`, which runs
// the same files and additionally fails on a dropped test count or a skip.
//
// Any extra arguments are passed through, so per-suite runs still work:
//   node src/tools/run-tests.js test/api.test.js
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { listTestFiles, ROOT } from './test-files.js';

const explicit = process.argv.slice(2);
const files = explicit.length ? explicit : listTestFiles();

// Serial on purpose: several suites bind real TCP/HTTP sockets, and running them
// concurrently would race for ports. Don't remove --test-concurrency=1.
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
