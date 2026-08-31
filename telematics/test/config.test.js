// ─────────────────────────────────────────────────────────────────────────────
// test/config.test.js — config hygiene (P0).
//
// `.env.example` is the config CONTRACT: it is the only place a new engineer
// looks to find out what this thing can be told to do. A variable that the code
// reads but the example file never mentions is invisible configuration — the
// kind of thing that gets discovered at 2am on a pilot box.
//
// So this suite proves, mechanically:
//   • every env var read anywhere under src/ appears in .env.example
//   • every var documented in .env.example is actually read by the code
//     (no fossils left behind after a rename)
//   • the demo really does run with NO .env — config.js supplies a default for
//     everything that isn't Postgres-only
//   • .env is git-ignored, and .env.example carries no real-looking credentials
//
//   run: npm run test:config
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.js')) out.push(p);
  }
  return out;
}

// Vars the code reads that are intentionally NOT part of the .env contract:
// standard CI/runtime variables we only observe, never define.
const NOT_OURS = new Set(['NODE_ENV', 'CI', 'GITHUB_ACTIONS']);

function varsReadByCode() {
  const found = new Map(); // name -> file that reads it
  for (const file of walk(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!NOT_OURS.has(m[1]) && !found.has(m[1])) found.set(m[1], file);
    }
    for (const m of src.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) {
      if (!NOT_OURS.has(m[1]) && !found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

function varsDocumented() {
  const text = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m) names.add(m[1]);
  }
  return names;
}

test('config: every env var the code reads is documented in .env.example', () => {
  const read = varsReadByCode();
  const documented = varsDocumented();

  const missing = [...read.keys()]
    .filter((v) => !documented.has(v))
    .map((v) => `${v} (read in ${read.get(v).replace(ROOT, '.')})`);

  assert.deepEqual(
    missing,
    [],
    `undocumented env vars — add them to .env.example:\n  ${missing.join('\n  ')}`,
  );
});

test('config: .env.example documents nothing the code has stopped reading', () => {
  const read = new Set(varsReadByCode().keys());
  const documented = varsDocumented();
  const fossils = [...documented].filter((v) => !read.has(v));
  assert.deepEqual(fossils, [], `stale vars in .env.example: ${fossils.join(', ')}`);
});

test('config: the whole slice has working defaults with no .env and no env vars', () => {
  // This must assert the DEFAULTS, not whatever the ambient environment happens
  // to be set to — otherwise `DB=pg npm test` fails the test that is supposed to
  // prove zero-setup works. So load config.js in a CHILD process with every var
  // the slice reads stripped out. That is the actual claim: a bare checkout with
  // no .env and no exported vars runs.
  const stripped = { ...process.env };
  for (const v of varsDocumented()) delete stripped[v];
  delete stripped.DATABASE_URL; // read via the appDatabaseUrl fallback chain

  const out = execFileSync(
    process.execPath,
    [
      '-e',
      "import('./src/config.js').then(({config}) => " +
        'process.stdout.write(JSON.stringify(config)))',
    ],
    { cwd: ROOT, env: stripped, encoding: 'utf8' },
  );
  const fresh = JSON.parse(out);

  assert.equal(fresh.db, 'memory'); // zero-setup default
  assert.equal(typeof fresh.ingest.port, 'number');
  assert.ok(fresh.ingest.port > 0);
  assert.equal(typeof fresh.api.port, 'number');
  assert.ok(fresh.api.port > 0);
  assert.equal(typeof fresh.sim.intervalMs, 'number');
  assert.ok(fresh.sim.scenario, 'a default scenario must be set');
  assert.ok(['json', 'kv'].includes(fresh.log.format));
  assert.ok(['debug', 'info', 'warn', 'error', 'silent'].includes(fresh.log.level));
  assert.ok(fresh.shutdownTimeoutMs > 0);
  assert.equal(fresh.failBeforeCommit, false); // never on by default

  // And the ambient config object imported at the top of this file is still
  // internally consistent, whatever DB mode the suite is being run in.
  assert.ok(['memory', 'pg'].includes(config.db));
});

test('config: no secret material is committed', () => {
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m, '.env must be git-ignored');

  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
  // Every connection string in the example must have a redacted password.
  for (const m of example.matchAll(/postgres:\/\/[^:\s]+:([^@\s]+)@/g)) {
    assert.equal(m[1], '***', `.env.example contains a real-looking password: ${m[0]}`);
  }
});

test('config: the shutdown deadline stays under a typical orchestrator grace period', () => {
  // ECS/Kubernetes default to a 30s grace period before SIGKILL. If our drain
  // deadline exceeded that, the platform would kill us mid-drain — which is the
  // exact scenario invariant 1 cares about.
  assert.ok(
    config.shutdownTimeoutMs < 30_000,
    `SHUTDOWN_TIMEOUT_MS=${config.shutdownTimeoutMs} is not below a 30s kill grace period`,
  );
});
