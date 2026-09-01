// ─────────────────────────────────────────────────────────────────────────────
// src/tools/live-dashboard.js — run ingestion + API against ONE SHARED store,
// so a separately-running simulator and a browser dashboard can watch the
// same data live.
//
// `npm run start:ingest` + `npm run start:api` are two separate processes,
// each with its own in-memory store when DB=memory — fine for testing each
// in isolation, but the API can never see what ingestion just received
// unless they're pointed at a real shared Postgres. This script gives you
// that shared view without needing Docker/Postgres.
//
// Usage:
//   npm run dashboard
//   # in a second terminal:
//   npm run sim -- --scenario day-cycle      (or --stream, or any named scenario)
//   # then open telematics/dashboard/index.html in a browser
// ─────────────────────────────────────────────────────────────────────────────
import { makeStore } from '../store/index.js';
import { createIngestionServer } from '../ingestion/server.js';
import { createApi } from '../api/server.js';
import { TENANTS, ASSETS } from '../store/seed-data.js';
import { config } from '../config.js';

const log = (event, meta) => console.log(new Date().toISOString(), event, meta ? JSON.stringify(meta) : '');
const logger = { info: log, warn: log, error: log };

async function main() {
  const store = await makeStore(config.db);
  await store.init();

  const ingest = createIngestionServer({ store, host: '0.0.0.0', port: 5027, logger });
  const ingestPort = await ingest.listen();

  const api = createApi({ store, port: 8080, logger });
  const apiPort = await api.listen();

  console.log(`
Live dashboard backend running (shared in-memory store).
  Ingestion (device traffic): tcp/${ingestPort}
  Read API:                   http://localhost:${apiPort}

Known tenant IDs (dashboard.html already knows these):
  Tenant A — ${TENANTS.A.name}: ${TENANTS.A.id}
  Tenant B — ${TENANTS.B.name}: ${TENANTS.B.id}
  Dozr (owner) — ${TENANTS.DOZR.name}: ${TENANTS.DOZR.id}

Known assets:
${ASSETS.map((a) => `  ${a.year} ${a.make} ${a.model} (${a.type}): ${a.id}`).join('\n')}

Next steps:
  1. In another terminal:  npm run sim -- --scenario day-cycle
     (or --scenario handover / tamper / yard-idle / geofence-cross / after-hours, or --stream to loop forever)
  2. Open dashboard/index.html in your browser (double-click it, or drag it into Chrome).

Press Ctrl+C to stop.
`);

  async function shutdown(signal) {
    console.log(`\n${signal} received, draining...`);
    // drain(), not close(): waits for in-flight requests/writes to finish under
    // the SHUTDOWN_TIMEOUT_MS deadline, same contract the rest of P0 established
    // for both servers (src/lifecycle/shutdown.js) — close() would cut work off
    // immediately instead.
    await Promise.all([ingest.drain(), api.drain()]);
    console.log('stopped.');
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
