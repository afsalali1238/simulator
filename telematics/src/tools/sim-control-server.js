// ─────────────────────────────────────────────────────────────────────────────
// src/tools/sim-control-server.js — dev-tooling HTTP layer so the browser
// dashboard can click a scenario button and watch, live, the exact Codec
// 8/8E bytes SimDevice puts on the wire and how a server-grade decode of
// those bytes reads.
//
// Zero-framework, same style as api/server.js: plain node:http, CORS headers
// for a page opened straight from the filesystem, Server-Sent Events for the
// one-directional "here's what was just sent" stream — no WebSocket needed,
// nothing ever flows browser -> here except the POST that starts a run.
//
// This reuses the REAL send path unmodified — buildScenario() + the same
// replayTrack()/SimDevice TCP client run-simulator.js uses — so what shows up
// here is genuinely what a physical device's own encoder would produce, not
// an approximation built for display purposes. The one addition is
// SimDevice's optional `onPacket` hook (see device.js), which is purely
// observational and changes nothing about what gets sent.
//
// ⚠ NO AUTH, ALL INTERFACES. server.listen(port) with no host binds 0.0.0.0, and
// CORS is `*`, so anyone who can reach this port can POST /simulate and inject
// traffic into the ingestion server. That is fine for a laptop and deliberate —
// the dashboard is opened straight from the filesystem — but do not run it on a
// shared or public network, and do not deploy it. Pass a host of '127.0.0.1' to
// server.listen below if you want it loopback-only.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { buildScenario, SCENARIO_NAMES, SCENARIOS } from '../simulator/scenarios.js';
import { replayTrack } from '../simulator/run-simulator.js';
import { readAvlFrame } from '../protocol/codec.js';
import { IO_NAME } from '../config.js';
import { silentLogger } from '../logging/logger.js';

function corsHeaders(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    ...extra,
  };
}

// JSON.stringify chokes on BigInt (ICCID, size-8 IO elements) — stringify it.
const jsonSafe = (value, space) =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), space);

export function createSimControlServer({
  ingestHost,
  ingestPort,
  codec = '8E',
  intervalMs = 300,
  port = 8081,
  logger = silentLogger,
} = {}) {
  const clients = new Set(); // open SSE response streams

  function broadcast(event) {
    const line = `data: ${jsonSafe(event)}\n\n`;
    for (const res of clients) res.write(line);
  }

  // Runs a full named scenario (every track, concurrently — exactly what the
  // CLI's `npm run sim -- --scenario X` does) and streams each record as its
  // ACK comes back, decoded via the SAME readAvlFrame() the real ingestion
  // server calls, so this is provably what a server would parse, not a
  // client-side claim about what was sent.
  async function runScenario(name) {
    const built = buildScenario(name);
    broadcast({
      type: 'scenario_start',
      scenario: name,
      description: built.description,
      tracks: built.tracks.length,
    });
    const state = { stopping: false, open: new Set() };

    await Promise.all(
      built.tracks.map(async (track) => {
        let seq = 0;
        const result = await replayTrack({
          track,
          host: ingestHost,
          port: ingestPort,
          codec,
          intervalMs,
          logger: silentLogger,
          state,
          onPacket: ({ packet, records, ack }) => {
            seq++;
            const { packet: decoded } = readAvlFrame(packet);
            const rec = decoded.records[0];
            broadcast({
              type: 'record',
              scenario: name,
              imei: track.imei,
              label: track.label,
              seq,
              phase: records[0]._phase,
              ack,
              hex: packet.toString('hex'),
              byteLength: packet.length,
              timestampMs: Number(rec.timestampMs),
              priority: rec.priority,
              gps: rec.gps,
              io: rec.io.map((el) => ({
                id: el.id,
                name: IO_NAME[el.id] ?? 'unknown',
                size: el.size,
                value: el.value,
              })),
            });
          },
        });
        broadcast({
          type: 'track_complete',
          scenario: name,
          imei: track.imei,
          label: track.label,
          sent: result.sent,
          acked: result.acked,
          failed: result.failed,
        });
      }),
    );

    broadcast({ type: 'scenario_complete', scenario: name });
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400, corsHeaders({ 'content-type': 'application/json' }));
      return res.end(jsonSafe({ error: 'bad request' }));
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }

    if (url.pathname === '/scenarios' && req.method === 'GET') {
      res.writeHead(200, corsHeaders({ 'content-type': 'application/json' }));
      return res.end(
        jsonSafe({
          scenarios: SCENARIO_NAMES.map((name) => ({
            name,
            description: SCENARIOS[name].description,
            proves: SCENARIOS[name].proves ?? [],
          })),
        }),
      );
    }

    if (url.pathname === '/simulate' && req.method === 'POST') {
      const name = url.searchParams.get('scenario');
      if (!name || !SCENARIOS[name]) {
        res.writeHead(400, corsHeaders({ 'content-type': 'application/json' }));
        return res.end(jsonSafe({ error: `unknown scenario "${name}"` }));
      }
      res.writeHead(202, corsHeaders({ 'content-type': 'application/json' }));
      res.end(jsonSafe({ started: name }));
      // Fire-and-stream: the HTTP response is just an ack that the run
      // started; the actual data comes over the SSE stream below.
      runScenario(name).catch((e) => {
        logger.error('sim_control_run_failed', { scenario: name, error: e.message });
        broadcast({ type: 'error', scenario: name, error: e.message });
      });
      return;
    }

    if (url.pathname === '/simulate/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    res.writeHead(404, corsHeaders({ 'content-type': 'application/json' }));
    res.end(jsonSafe({ error: 'not found' }));
  });

  return {
    listen() {
      return new Promise((resolve) => {
        server.listen(port, () => resolve(server.address().port));
      });
    },
    close() {
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
