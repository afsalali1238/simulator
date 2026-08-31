// ─────────────────────────────────────────────────────────────────────────────
// test/operability.test.js — P0 hardening. Not correctness logic, but the
// properties that make this slice safe to run unattended on a pilot box:
//
//   • structured logging — one line per event, levels honoured, secrets and
//     credential URIs redacted, no tenant payloads
//   • graceful shutdown  — runs once per process, bounded by a hard deadline
//   • /health            — load-balancer shaped: no I/O on the probe path, 503
//                          while draining so an LB pulls the target out first
//   • ingestion drain    — the ordering that keeps invariant 1 true across a
//                          restart: an in-flight packet finishes its write AND
//                          its ACK, and a connection arriving mid-drain is
//                          refused rather than half-served
//
//   run: npm run test:operability
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, scrub } from '../src/logging/logger.js';
import { installShutdown, drainWithTimeout } from '../src/lifecycle/shutdown.js';
import { createMemoryStore } from '../src/store/memory-store.js';
import { createApi } from '../src/api/server.js';
import { createIngestionServer } from '../src/ingestion/server.js';
import { SimDevice } from '../src/simulator/device.js';
import { buildScenario } from '../src/simulator/scenarios.js';
import { DEVICES, TENANTS } from '../src/store/seed-data.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A synthetic event name, NOT a real OS signal. installShutdown() just calls
// process.on(name), so this drives the same code path while keeping the test
// off the process's real signal handlers (emitting SIGUSR2 makes Node dump a
// diagnostic report, and SIGINT/SIGTERM would kill the test runner).
const TEST_SIGNAL = 'test-shutdown-signal';

function collector() {
  const lines = [];
  return { lines, write: (l) => lines.push(l) };
}

// ── Structured logging ───────────────────────────────────────────────────────

test('logging: emits one structured JSON line per event with ts/level/module/event', () => {
  const sink = collector();
  const log = createLogger({ module: 'ingestion', write: sink.write, now: () => 'T0' });

  log.info('packet_acked', { imei: '356307042441013', records: 20 });
  assert.equal(sink.lines.length, 1);

  const entry = JSON.parse(sink.lines[0]);
  assert.deepEqual(entry, {
    ts: 'T0',
    level: 'info',
    module: 'ingestion',
    event: 'packet_acked',
    imei: '356307042441013',
    records: 20,
  });
});

test('logging: level threshold suppresses quieter events, silent suppresses all', () => {
  const sink = collector();
  const log = createLogger({ level: 'warn', write: sink.write });
  log.debug('a');
  log.info('b');
  log.warn('c');
  log.error('d');
  assert.deepEqual(
    sink.lines.map((l) => JSON.parse(l).event),
    ['c', 'd'],
  );

  const quiet = collector();
  const silent = createLogger({ level: 'silent', write: quiet.write });
  silent.error('boom');
  assert.equal(quiet.lines.length, 0);
});

test('logging: redacts secret fields and strips credentials out of URIs', () => {
  const sink = collector();
  const log = createLogger({ write: sink.write, now: () => 'T0' });

  log.error('db_connect_failed', {
    DATABASE_URL: 'postgres://dozr:hunter2@rds.example:5432/db',
    token: 'abc123',
    detail: 'failed for postgres://dozr:hunter2@rds.example:5432/db',
    port: 5432,
  });

  const line = sink.lines[0];
  assert.ok(!line.includes('hunter2'), `credential leaked: ${line}`);
  assert.ok(!line.includes('abc123'), `token leaked: ${line}`);
  const entry = JSON.parse(line);
  assert.equal(entry.DATABASE_URL, '***');
  assert.equal(entry.token, '***');
  assert.equal(entry.detail, 'failed for postgres://dozr:***@rds.example:5432/db');
  assert.equal(entry.port, 5432); // ordinary fields survive

  // Buffers (raw frames) never land in a log as bytes.
  assert.equal(scrub({ raw: Buffer.alloc(120) }).raw, '[buffer 120B]');
});

test('logging: kv format stays parseable and child loggers inherit the sink', () => {
  const sink = collector();
  const log = createLogger({ module: 'api', format: 'kv', write: sink.write, now: () => 'T0' });
  log.info('request', { method: 'GET', path: '/positions', status: 200, ms: 3 });
  assert.equal(
    sink.lines[0],
    'ts=T0 level=info module=api event=request method=GET path=/positions status=200 ms=3',
  );

  const child = log.child('api.probe', { store: 'memory' });
  child.warn('slow');
  const last = sink.lines.at(-1);
  assert.ok(last.includes('module=api.probe'));
  assert.ok(last.includes('store=memory'));
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

test('shutdown: a signal drains once, exits 0, and a repeat signal is ignored', async () => {
  let stops = 0;
  const exits = [];
  const sink = collector();
  const logger = createLogger({ write: sink.write });

  const remove = installShutdown({
    name: 'test-server',
    logger,
    signals: [TEST_SIGNAL],
    exit: (code) => exits.push(code),
    async stop() {
      stops++;
      await delay(5);
    },
  });

  process.emit(TEST_SIGNAL);
  await delay(40);
  process.emit(TEST_SIGNAL); // an impatient second Ctrl-C
  await delay(20);
  remove();

  assert.equal(stops, 1, 'stop must run exactly once');
  assert.deepEqual(exits, [0]);
  const events = sink.lines.map((l) => JSON.parse(l).event);
  assert.ok(events.includes('shutdown_started'));
  assert.ok(events.includes('shutdown_complete'));
});

test('shutdown: a hung drain is bounded by the deadline instead of wedging the restart', async () => {
  const clean = await drainWithTimeout(new Promise(() => {}), 30); // never resolves
  assert.equal(clean, false);

  const ok = await drainWithTimeout(delay(5), 200);
  assert.equal(ok, true);

  // A drain that throws is reported, not swallowed into a false "clean".
  const exits = [];
  const sink = collector();
  const remove = installShutdown({
    name: 'broken',
    logger: createLogger({ write: sink.write }),
    signals: [TEST_SIGNAL],
    exit: (code) => exits.push(code),
    stop: () => {
      throw new Error('drain exploded');
    },
  });
  process.emit(TEST_SIGNAL);
  await delay(30);
  remove();
  assert.deepEqual(exits, [1]);
  assert.ok(sink.lines.some((l) => JSON.parse(l).event === 'shutdown_failed'));
});

// ── /health as a load-balancer probe ─────────────────────────────────────────

test('api: /health is LB-shaped — 200 ready, 503 while draining, no store I/O', async () => {
  const store = createMemoryStore();
  await store.init();

  // Trip-wire: a probe must never touch a backing service, or the health check
  // becomes a load source on the database.
  let reads = 0;
  for (const m of ['getPositions', 'getDevices', 'getLatestEngineHours', 'deviceByImei']) {
    const orig = store[m].bind(store);
    store[m] = async (...args) => {
      reads++;
      return orig(...args);
    };
  }

  const api = createApi({ store, port: 0, logger: createLogger({ level: 'silent' }) });
  const port = await api.listen();
  const base = `http://127.0.0.1:${port}`;

  const ready = await fetch(base + '/health');
  const readyBody = await ready.json();
  assert.equal(ready.status, 200);
  assert.equal(readyBody.ok, true);
  assert.equal(readyBody.state, 'ready');
  assert.equal(readyBody.store, 'memory');
  assert.equal(typeof readyBody.uptimeMs, 'number');
  assert.equal(reads, 0, 'the probe path must not read from the store');

  // Draining: the endpoint reports 503 so the LB removes this target before we
  // stop accepting. Read it from the health() accessor because the socket is
  // closing at the same time.
  const draining = api.drain();
  assert.equal(api.health().status, 503);
  assert.equal(api.health().body.state, 'draining');
  await draining;
  await store.close();
});

test('api: a health probe is not logged, but a data request is (counts only)', async () => {
  const store = createMemoryStore();
  await store.init();
  const sink = collector();
  const api = createApi({ store, port: 0, logger: createLogger({ module: 'api', write: sink.write }) });
  const port = await api.listen();
  const base = `http://127.0.0.1:${port}`;

  await fetch(base + '/health');
  await fetch(base + '/positions?limit=5', { headers: { 'x-tenant-id': TENANTS.A.id } });
  await api.close();
  await store.close();

  const events = sink.lines.map((l) => JSON.parse(l));
  const requests = events.filter((e) => e.event === 'request');
  assert.equal(requests.length, 1, 'the /health probe should not spam the log');
  assert.equal(requests[0].path, '/positions');

  // The tenant id and query values must never appear in a log line.
  const joined = sink.lines.join('\n');
  assert.ok(!joined.includes(TENANTS.A.id), 'tenant id leaked into the logs');
});

test('api: drain lets an in-flight request finish before resolving', async () => {
  const store = createMemoryStore();
  await store.init();
  let release;
  const gate = new Promise((r) => (release = r));
  store.getPositions = async () => {
    await gate;
    return [];
  };

  const api = createApi({ store, port: 0, logger: createLogger({ level: 'silent' }) });
  const port = await api.listen();

  const pending = fetch(`http://127.0.0.1:${port}/positions`, {
    headers: { 'x-tenant-id': TENANTS.A.id },
  });
  await delay(30); // let the request reach the handler and block

  let drained = false;
  const draining = api.drain().then(() => (drained = true));
  await delay(30);
  assert.equal(drained, false, 'drain resolved while a request was still in flight');

  release();
  const res = await pending;
  assert.equal(res.status, 200);
  await draining;
  assert.equal(drained, true);
  await store.close();
});

// ── Ingestion drain: the invariant-1 ordering ────────────────────────────────

test('ingestion: drain finishes the in-flight write AND its ACK (invariant 1)', async () => {
  const store = createMemoryStore();
  await store.init();

  // Hold the durable write open so the drain is guaranteed to overlap it.
  const realPersist = store.persistPacket.bind(store);
  let release;
  const gate = new Promise((r) => (release = r));
  let entered = false;
  store.persistPacket = async (args) => {
    entered = true;
    await gate;
    return realPersist(args);
  };

  const ing = createIngestionServer({
    store,
    host: '127.0.0.1',
    port: 0,
    logger: createLogger({ level: 'silent' }),
  });
  const port = await ing.listen();

  const track = buildScenario('day-cycle', { records: 3 }).tracks[0];
  const dev = new SimDevice({ host: '127.0.0.1', port, imei: DEVICES[0].imei, codec: '8E' });
  await dev.connect();

  const ackPromise = dev.send(track.records); // one packet, 3 records
  while (!entered) await delay(5); // wait until the write is in progress

  let drained = false;
  const draining = ing.drain().then(() => (drained = true));
  await delay(30);
  assert.equal(drained, false, 'drain must wait for the in-flight packet');
  assert.equal(ing.inFlightCount(), 1);

  release(); // let the commit land
  const ack = await ackPromise; // the ACK still arrives — never ACK-then-die
  assert.equal(ack, 3);
  await draining;
  assert.equal(await store.countPositions(), 3, 'the in-flight packet was persisted');

  dev.close();
  await store.close();
});

test('ingestion: a device connecting mid-drain is refused, not half-served', async () => {
  const store = createMemoryStore();
  await store.init();
  const ing = createIngestionServer({
    store,
    host: '127.0.0.1',
    port: 0,
    logger: createLogger({ level: 'silent' }),
  });
  const port = await ing.listen();

  // Keep one idle connection open so drain() has sockets to end.
  const idleDev = new SimDevice({ host: '127.0.0.1', port, imei: DEVICES[0].imei, codec: '8E' });
  await idleDev.connect();

  await ing.drain();
  assert.equal(ing.inFlightCount(), 0);

  // The listener is closed, so a new device cannot get a handshake at all.
  const late = new SimDevice({ host: '127.0.0.1', port, imei: DEVICES[0].imei, codec: '8E' });
  await assert.rejects(() => late.connect());

  idleDev.close();
  await store.close();
});
