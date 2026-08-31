// ─────────────────────────────────────────────────────────────────────────────
// src/api/server.js — Module 6 (Surfaces), read side. A tiny zero-framework HTTP
// API that the existing fleet-v2 dashboard would call instead of its mock data.
//
// Every data endpoint is tenant-scoped: the caller must send an X-Tenant-Id
// header, and the store enforces isolation (app-level in the memory adapter,
// real row-level security in the pg adapter — invariant 7). No tenant => 400.
//
// Endpoints:
//   GET /health                          -> liveness/readiness probe (no tenant)
//   GET /devices                         -> devices visible to the tenant
//   GET /positions?device=&since=&limit= -> position history for the tenant
//   GET /assets/:id/engine-hours         -> latest ECU engine hours for an asset
//
// Operability (P0):
//   • /health is shaped for a load balancer / ECS target group: it touches NO
//     backing service (a probe must never become a load source), answers in
//     constant time from cached process state, and returns 503 when this
//     instance cannot serve — either the store never initialised or we are
//     draining for shutdown. That 503 is what lets an ALB/NLB pull the target
//     out of rotation before we stop accepting.
//   • Structured logging via src/logging/logger.js; request logs carry method,
//     path, status and duration — never tenant data or query payloads.
//   • drain() stops accepting, lets in-flight requests finish, then resolves.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { silentLogger } from '../logging/logger.js';
import { isEntrypoint } from '../lifecycle/shutdown.js';

function send(res, status, body) {
  const json = JSON.stringify(body, (_k, v) =>
    typeof v === 'bigint' ? Number(v) : v,
  );
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-tenant-id',
  });
  res.end(json);
}

export function createApi({ store, port = 8080, logger = silentLogger } = {}) {
  const startedAt = Date.now();
  let draining = false;
  let inFlight = 0;
  let idle = null; // resolver for "in-flight reached zero"

  // Readiness is derived from cached process state only — no I/O on the probe
  // path. `store.kind` being present is our proof the adapter was constructed;
  // a store that failed to init never gets here because start-up throws.
  function health() {
    const ready = Boolean(store && store.kind) && !draining;
    return {
      status: ready ? 200 : 503,
      body: {
        ok: ready,
        state: draining ? 'draining' : ready ? 'ready' : 'unavailable',
        store: store?.kind ?? null,
        uptimeMs: Date.now() - startedAt,
      },
    };
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    inFlight++;
    let path = req.url;
    let status = 500;
    try {
      const url = new URL(req.url, 'http://localhost');
      path = url.pathname;

      if (path === '/health') {
        const h = health();
        status = h.status;
        return send(res, h.status, h.body);
      }

      // All other endpoints are tenant-scoped.
      const tenantId = req.headers['x-tenant-id'];
      if (!tenantId) {
        status = 400;
        return send(res, 400, { error: 'X-Tenant-Id header required' });
      }

      if (path === '/devices') {
        status = 200;
        return send(res, 200, { devices: await store.getDevices(tenantId) });
      }

      if (path === '/positions') {
        const positions = await store.getPositions(tenantId, {
          deviceId: url.searchParams.get('device') || undefined,
          sinceMs: Number(url.searchParams.get('since') || 0),
          limit: Number(url.searchParams.get('limit') || 100),
        });
        status = 200;
        return send(res, 200, { positions });
      }

      const eng = path.match(/^\/assets\/([^/]+)\/engine-hours$/);
      if (eng) {
        const reading = await store.getLatestEngineHours(tenantId, eng[1]);
        status = 200;
        return send(res, 200, { assetId: eng[1], reading });
      }

      status = 404;
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      status = 500;
      logger.error?.('request_failed', { path, error: e.message });
      return send(res, 500, { error: 'internal error' });
    } finally {
      // Never log the tenant id, query values, or response bodies.
      if (path !== '/health') {
        logger.info?.('request', { method: req.method, path, status, ms: Date.now() - t0 });
      }
      if (--inFlight === 0 && idle) {
        idle();
        idle = null;
      }
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.off('error', reject);
          const p = server.address().port;
          logger.info?.('listening', { module: 'api', port: p, store: store?.kind });
          resolve(p);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    /**
     * Graceful stop for a rolling deploy:
     *   1. flip /health to 503 so the LB drains this target,
     *   2. stop accepting new connections,
     *   3. let in-flight requests finish,
     *   4. drop idle keep-alive sockets so the listener can actually close,
     *   5. resolve. The caller closes the store afterwards.
     *
     * Step 4 matters: `server.close(cb)` stops accepting immediately, but its
     * callback waits for every connection to end — and an HTTP keep-alive
     * socket sits there idle for its whole timeout. Awaiting the callback
     * without closing idle connections would stall a restart for seconds.
     */
    async drain({ probeGraceMs = 0, socketGraceMs = 2000 } = {}) {
      draining = true;
      if (probeGraceMs > 0) {
        // Give the LB one probe interval to notice the 503 before we stop
        // accepting, so in-flight-free targets are removed without a blip.
        await new Promise((r) => setTimeout(r, probeGraceMs));
      }
      const closed = new Promise((resolve) => server.close(() => resolve()));
      if (inFlight > 0) await new Promise((resolve) => (idle = resolve));
      server.closeIdleConnections?.();
      let graceTimer;
      await Promise.race([
        closed,
        new Promise((resolve) => {
          graceTimer = setTimeout(() => {
            server.closeAllConnections?.();
            resolve();
          }, socketGraceMs);
        }),
      ]);
      clearTimeout(graceTimer);
      await closed;
      logger.info?.('drained', { module: 'api' });
    },
    health,
    address() {
      return server.address();
    },
  };
}

// Allow running the API directly: `npm run start:api`. isEntrypoint() rather
// than the `import.meta.url === file://argv[1]` idiom, which is false on
// Windows — see src/lifecycle/shutdown.js.
if (isEntrypoint(import.meta.url)) {
  const { config } = await import('../config.js');
  const { makeStore } = await import('../store/index.js');
  const { createLogger } = await import('../logging/logger.js');
  const { installShutdown } = await import('../lifecycle/shutdown.js');

  const logger = createLogger({
    module: 'api',
    level: config.log.level,
    format: config.log.format,
  });

  const store = await makeStore();
  await store.init();
  const api = createApi({ store, port: config.api.port, logger });
  await api.listen();

  installShutdown({
    name: 'api',
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    async stop() {
      await api.drain();
      await store.close();
    },
  });
}
