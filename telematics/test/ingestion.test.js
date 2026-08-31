// ─────────────────────────────────────────────────────────────────────────────
// test/ingestion.test.js — Module 1 (Ingestion) end-to-end over a REAL TCP socket:
// simulated Teltonika unit -> ingestion server -> memory store. This is the test
// that proves the wire protocol and the durability contract together.
//   invariant 1 (ACK only after a durable write) · invariant 2 (idempotent resend)
//   + IMEI handshake accept/reject, Codec 8 and 8E both accepted.
//   run: npm run test:ingestion
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory-store.js';
import { createIngestionServer } from '../src/ingestion/server.js';
import { SimDevice } from '../src/simulator/device.js';
import { makeScenario } from '../src/simulator/scenarios.js';
import { config } from '../src/config.js';
import { DEVICES } from '../src/store/seed-data.js';

const quiet = { info() {}, warn() {}, error() {} };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(store) {
  const server = createIngestionServer({ store, host: '127.0.0.1', port: 0, logger: quiet });
  const port = await server.listen();
  return { server, port };
}

test('ingestion: accepts a known IMEI, ACKs the record count, and persists it', async () => {
  const store = createMemoryStore();
  await store.init();
  const { server, port } = await startServer(store);

  const dev = new SimDevice({ host: '127.0.0.1', port, imei: DEVICES[0].imei, codec: '8E' });
  await dev.connect();
  const scenario = makeScenario({});
  const ack = await dev.send([scenario(0), scenario(1)]);
  assert.equal(ack, 2); // server acknowledged both records
  assert.equal(await store.countPositions(), 2);
  dev.close();
  await server.close();
});

test('ingestion: rejects an unknown IMEI at the handshake', async () => {
  const store = createMemoryStore();
  await store.init();
  const { server, port } = await startServer(store);

  const dev = new SimDevice({ host: '127.0.0.1', port, imei: '999999999999999', codec: '8E' });
  await assert.rejects(() => dev.connect(), /rejected/);
  await server.close();
});

test('ingestion: accepts both Codec 8 and Codec 8E from the wire', async () => {
  for (const codec of ['8', '8E']) {
    const store = createMemoryStore();
    await store.init();
    const { server, port } = await startServer(store);

    const dev = new SimDevice({ host: '127.0.0.1', port, imei: DEVICES[0].imei, codec });
    await dev.connect();
    const ack = await dev.send([makeScenario({})(0)]);
    assert.equal(ack, 1, `codec ${codec}`);
    assert.equal(await store.countPositions(), 1, `codec ${codec}`);
    dev.close();
    await server.close();
  }
});

test('ingestion: resending an identical packet is idempotent end-to-end (invariant 2)', async () => {
  const store = createMemoryStore();
  await store.init();
  const { server, port } = await startServer(store);

  const dev = new SimDevice({ host: '127.0.0.1', port, imei: DEVICES[0].imei, codec: '8E' });
  await dev.connect();
  const scenario = makeScenario({});
  const recs = [scenario(0), scenario(1)];
  const ack1 = await dev.send(recs);
  const ack2 = await dev.send(recs); // exact resend (e.g. after a missed ACK)
  assert.equal(ack1, 2);
  assert.equal(ack2, 2); // still ACK the full count so the device clears its buffer
  assert.equal(await store.countPositions(), 2); // but nothing was double-counted
  dev.close();
  await server.close();
});

test('ingestion: never ACKs or persists when the write fails before commit, then recovers (invariant 1)', async () => {
  const store = createMemoryStore();
  await store.init();
  const { server, port } = await startServer(store);
  const scenario = makeScenario({});

  // 1) Force the store to fail at the durability boundary. The device sends
  //    WITHOUT awaiting an ACK (models "sent, but server died before commit").
  config.failBeforeCommit = true;
  try {
    const dev = new SimDevice({ host: '127.0.0.1', port, imei: DEVICES[0].imei, codec: '8E' });
    await dev.connect();
    dev.sendNoWait([scenario(0)]);
    await delay(150); // give the server time to try, throw, and drop the socket
    assert.equal(await store.countPositions(), 0); // no ACK => nothing persisted
    dev.close();
  } finally {
    config.failBeforeCommit = false;
  }

  // 2) The device reconnects and resends the very same record. Now it commits
  //    and is ACKed exactly once — the missed-ACK resend is safe.
  const dev2 = new SimDevice({ host: '127.0.0.1', port, imei: DEVICES[0].imei, codec: '8E' });
  await dev2.connect();
  const ack = await dev2.send([scenario(0)]);
  assert.equal(ack, 1);
  assert.equal(await store.countPositions(), 1);
  dev2.close();
  await server.close();
});
