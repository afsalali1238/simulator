// ─────────────────────────────────────────────────────────────────────────────
// src/store/index.js — the STORE PORT (Module 3: Data model & tenancy).
//
// The rest of the system talks to "a store" through this one interface, so the
// backend is swappable. Two adapters implement it:
//
//   • memory-store.js — in-process, zero dependencies. Used for tests and for
//     running the whole pipeline with nothing installed (this is the default).
//   • pg-store.js     — real PostgreSQL (via Docker locally, RDS on AWS later).
//     Enforces tenancy with row-level security and evidence immutability with
//     triggers, in the database itself.
//
// `pg` is only imported on the pg path (dynamic import), so the memory path
// needs no npm install at all.
//
// ── Store interface ──────────────────────────────────────────────────────────
//  init()                                  ensure ready (memory: load seed)
//  close()                                 release resources
//  deviceByImei(imei)                      -> device | null   (handshake auth)
//  resolveAssignment(deviceId, tsMs)       -> assignment | null (invariant 6)
//  persistPacket({ device, imei, codecId, rawFrame, canonical })
//        -> { records, inserted, deduped }
//        ATOMIC + DURABLE write of the raw frame + all canonical rows in ONE
//        transaction. Idempotent on record identity (invariant 2). MUST throw
//        and persist nothing if it cannot commit — the server ACKs only on the
//        resolved return value (invariant 1). Honours cfg.failBeforeCommit.
//  getDevices(tenantId)                    tenant-scoped (invariant 7)
//  getPositions(tenantId, { deviceId, sinceMs, limit })   tenant-scoped
//  getLatestEngineHours(tenantId, assetId) tenant-scoped
//  countPositions()                        unscoped debug/test helper
// ─────────────────────────────────────────────────────────────────────────────

import { config } from '../config.js';

export async function makeStore(kind = config.db, opts = {}) {
  if (kind === 'pg') {
    const { createPgStore } = await import('./pg-store.js');
    return createPgStore(opts);
  }
  const { createMemoryStore } = await import('./memory-store.js');
  return createMemoryStore(opts);
}
