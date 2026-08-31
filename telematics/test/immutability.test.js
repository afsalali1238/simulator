// ─────────────────────────────────────────────────────────────────────────────
// test/immutability.test.js — P1 DB-LAYER enforcement of the evidence chain
// (invariant 8): raw_frames is APPEND-ONLY.
//
// raw_frames holds exactly the bytes received from a device — the root a billing
// dispute is ultimately proven against. It must never be edited or deleted once
// written. In memory mode that is a convention (the array is only pushed to);
// in Postgres it is enforced by a trigger:
//
//     CREATE TRIGGER raw_frames_immutable
//       BEFORE UPDATE OR DELETE ON raw_frames
//       FOR EACH ROW EXECUTE FUNCTION forbid_mutation();   -- RAISEs, always
//
// This file proves the trigger does its job: INSERT is allowed, UPDATE and DELETE
// are both rejected, and the row is byte-unchanged afterwards.
//
// WHY IT RUNS AS THE OWNER (this matters):
//   The immutability guarantee must hold even for the most privileged connection.
//   The restricted dozr_app role has NO privileges on raw_frames at all, so an
//   UPDATE/DELETE by it would fail with "permission denied" — which would pass a
//   naive assert.rejects WITHOUT the trigger doing anything, and would still fail
//   if the trigger were removed. That is a false proof. So we connect as the
//   OWNER (config.databaseUrl), which CAN write raw_frames, and show the trigger
//   stops even it. We also assert the error message names the trigger
//   (/append-only/), so the test is proving the trigger — not some other error.
//
//   => If the trigger were dropped, the owner's UPDATE and DELETE would SUCCEED,
//      assert.rejects would get no error, and the "byte-unchanged" check would
//      also fail. The test cannot pass without the trigger.
//
// WIRING: identical to test/rls.test.js — DB=pg only; memory mode registers zero
// tests (no skips, so the memory gate stays green); `pg` is dynamic-imported on
// the pg path so memory mode needs no install; clean skip if Postgres is down.
// The mutable-target frame is inserted once in before() so the four tests are
// independent of each other's order.
//
//   run: DB=pg npm run test:immutability
// ─────────────────────────────────────────────────────────────────────────────

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { DEVICES } from '../src/store/seed-data.js';

const PG = config.db === 'pg';

if (PG) {
  const device = DEVICES[0]; // a seeded device, to satisfy raw_frames.device_id FK
  const SEALED = Buffer.from([0x01, 0x02, 0x03]); // the "received bytes" we seal

  let pg;
  let writer; // OWNER pool — the only role that can even attempt to mutate raw_frames
  let reachable = false;
  let frameId; // id of the sealed frame the mutation tests target

  // Append one evidence frame as the owner. Returns { id, record_count }.
  async function insertFrame(recordCount = 1, raw = SEALED) {
    const { rows } = await writer.query(
      `INSERT INTO raw_frames (id, device_id, imei, codec_id, record_count, raw)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
       RETURNING id, record_count`,
      [device.id, device.imei, 0x8e, recordCount, raw],
    );
    return rows[0];
  }

  before(async () => {
    ({ default: pg } = await import('pg')); // pg path only — memory needs no install
    writer = new pg.Pool({ connectionString: config.databaseUrl });
    try {
      await writer.query('SELECT 1');
      reachable = true;
    } catch (e) {
      reachable = false;
      console.error(
        `[immutability.test] Postgres not reachable/ready (${e.code || e.message}). ` +
          'Bring it up with `npm run db:up && npm run db:reset`, then re-run. ' +
          'Skipping the DB-layer immutability tests.',
      );
      return;
    }
    // Seal the frame the UPDATE/DELETE/unchanged tests will target. A fresh uuid
    // each run: evidence is append-only, so we never reuse or reset a row.
    frameId = (await insertFrame()).id;
  });

  after(async () => {
    await writer?.end().catch(() => {});
  });

  test('immutability: INSERT into raw_frames is allowed (evidence is append-able)', async (t) => {
    if (!reachable) {
      t.skip('Postgres unreachable — see the [immutability.test] note above');
      return;
    }
    // A standalone append, independent of the before() fixture: proves the trigger
    // does NOT block inserts.
    const row = await insertFrame(2, Buffer.from([0xaa, 0xbb]));
    assert.ok(row.id, 'INSERT should return the new frame id');
    assert.equal(row.record_count, 2, 'the appended frame is stored as given');
  });

  test('immutability: UPDATE on a sealed raw_frame is rejected by the trigger (invariant 8)', async (t) => {
    if (!reachable) {
      t.skip('Postgres unreachable — see the [immutability.test] note above');
      return;
    }
    assert.ok(frameId, 'before() must have sealed a frame');
    // The /append-only/ match proves it is the immutability TRIGGER raising, not a
    // permission error or a constraint. Without the trigger this UPDATE succeeds
    // (we are the owner) and assert.rejects fails.
    await assert.rejects(
      () =>
        writer.query('UPDATE raw_frames SET record_count = record_count + 1 WHERE id = $1', [
          frameId,
        ]),
      /append-only/,
      'UPDATE on raw_frames must be rejected by the immutability trigger',
    );
  });

  test('immutability: DELETE of a sealed raw_frame is rejected by the trigger (invariant 8)', async (t) => {
    if (!reachable) {
      t.skip('Postgres unreachable — see the [immutability.test] note above');
      return;
    }
    assert.ok(frameId, 'before() must have sealed a frame');
    await assert.rejects(
      () => writer.query('DELETE FROM raw_frames WHERE id = $1', [frameId]),
      /append-only/,
      'DELETE on raw_frames must be rejected by the immutability trigger',
    );
  });

  test('immutability: the sealed frame is unchanged and still present after the rejected mutations', async (t) => {
    if (!reachable) {
      t.skip('Postgres unreachable — see the [immutability.test] note above');
      return;
    }
    assert.ok(frameId, 'before() must have sealed a frame');
    // Both mutations are rejected regardless of test order, so the evidence is
    // exactly as sealed: still there (DELETE failed) and record_count still 1
    // (UPDATE failed).
    const { rows } = await writer.query(
      'SELECT record_count, raw FROM raw_frames WHERE id = $1',
      [frameId],
    );
    assert.equal(rows.length, 1, 'the frame must still exist (DELETE was rejected)');
    assert.equal(rows[0].record_count, 1, 'record_count must be unchanged (UPDATE was rejected)');
    assert.ok(Buffer.from(rows[0].raw).equals(SEALED), 'raw bytes must be unchanged');
  });
}
