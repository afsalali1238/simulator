// src/tools/load-sql.js — apply a .sql file to DATABASE_URL.
// Used by `npm run db:schema` and `npm run db:seed`.
//
//   node src/tools/load-sql.js db/schema.sql
//
// Sends the whole file via the simple-query protocol, so multi-statement files
// (including dollar-quoted function bodies) apply in one call.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { config } from '../config.js';

const rel = process.argv[2];
if (!rel) {
  console.error('usage: node src/tools/load-sql.js <path-to.sql>');
  process.exit(1);
}

const path = resolve(config.root, rel);
const sql = readFileSync(path, 'utf8');

const client = new pg.Client({ connectionString: config.databaseUrl });
await client.connect();
try {
  await client.query(sql);
  console.log(`✔ applied ${rel}`);
} catch (err) {
  console.error(`ERROR applying ${rel}:`, err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
