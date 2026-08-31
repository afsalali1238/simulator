// ─────────────────────────────────────────────────────────────────────────────
// src/tools/test-files.js — enumerate the test suite, portably.
//
// Why this exists: how you hand a set of test files to `node --test` is one of
// the least portable things in the runtime.
//
//   node --test "test/*.test.js"   ← glob expansion by Node: v21+ only. On
//                                    Node 18/20 this fails outright with
//                                    "Could not find 'test/*.test.js'".
//   node --test test/              ← directory discovery: works on 18/20, but
//                                    Node 24 tries to load it as a module and
//                                    dies with MODULE_NOT_FOUND.
//   node --test test/*.test.js     ← shell expansion: fine in bash, but npm
//                                    scripts run through cmd.exe on Windows,
//                                    which does not glob at all.
//
// So we read the directory ourselves and pass explicit paths. That behaves
// identically on every supported Node and on every OS, which is the whole point
// of a merge gate: the number it reports must not depend on the runner.
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
export const TEST_DIR = join(ROOT, 'test');

/** Every `*.test.js` under test/, sorted for a stable run order. */
export function listTestFiles() {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => join('test', f));
}
