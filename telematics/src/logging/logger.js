// ─────────────────────────────────────────────────────────────────────────────
// src/logging/logger.js — structured logging (P0 operability).
//
// No dependency: a thin wrapper over console/stdout that emits ONE line per
// event, either JSON (default — greppable and shippable off a pilot box) or
// key=value (`LOG_FORMAT=kv`, easier on the eye in a terminal).
//
// Shape of every line:
//   { ts, level, module, event, ...fields }
//
// Rules baked in (see CLAUDE.md — never log secrets or tenant payloads):
//   • A small deny-list of field names is redacted outright (passwords, tokens,
//     connection strings, auth headers).
//   • Any string that looks like a URI with credentials has them stripped.
//   • Callers pass FIELDS, not free text: `log.info('device_connected', {imei})`.
//     Positions, tenant ids, and record bodies are deliberately never logged by
//     the servers — counts only.
//
// Compatible with the existing `logger.info?.()` call sites and with passing a
// bare `console` or a silent stub in tests.
// ─────────────────────────────────────────────────────────────────────────────

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const REDACT_KEYS = new Set([
  'password',
  'pass',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'cookie',
  'databaseurl',
  'database_url',
  'appdatabaseurl',
  'app_database_url',
  'connectionstring',
  'connection_string',
  'dsn',
]);

// postgres://user:secret@host/db -> postgres://user:***@host/db
const CREDENTIAL_URI = /([a-z][a-z0-9+.-]*:\/\/[^:/?#\s]+):[^@/?#\s]+@/gi;

export function scrub(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.replace(CREDENTIAL_URI, '$1:***@');
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  if (depth >= 4) return '[deep]';
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}B]`;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: scrub(value.message) };

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '***' : scrub(v, depth + 1);
  }
  return out;
}

function formatKv(entry) {
  return Object.entries(entry)
    .map(([k, v]) => {
      const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      return /[\s"=]/.test(s) ? `${k}=${JSON.stringify(s)}` : `${k}=${s}`;
    })
    .join(' ');
}

/**
 * @param opts.module  logical source, e.g. 'ingestion' | 'api' | 'simulator'
 * @param opts.level   minimum level to emit ('debug'|'info'|'warn'|'error'|'silent')
 * @param opts.format  'json' (default) | 'kv'
 * @param opts.write   sink for one formatted line (tests inject a collector)
 * @param opts.now     clock, injectable for deterministic tests
 * @param opts.base    fields merged into every line (e.g. { store: 'memory' })
 */
export function createLogger({
  module = 'app',
  level = process.env.LOG_LEVEL || 'info',
  format = process.env.LOG_FORMAT || 'json',
  write,
  now = () => new Date().toISOString(),
  base = {},
} = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const sink = write || ((line) => process.stdout.write(line + '\n'));

  const emit = (lvl) => (event, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const entry = {
      ts: now(),
      level: lvl,
      module,
      event: typeof event === 'string' ? event : String(event),
      ...scrub({ ...base, ...(fields && typeof fields === 'object' ? fields : {}) }),
    };
    // A non-object second argument still gets carried, but as a named field so
    // the line stays structured rather than degrading into free text.
    if (fields !== undefined && (typeof fields !== 'object' || fields === null)) {
      entry.detail = scrub(fields);
    }
    sink(format === 'kv' ? formatKv(entry) : JSON.stringify(entry));
  };

  return {
    module,
    level,
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child(childModule, childBase = {}) {
      return createLogger({
        module: childModule,
        level,
        format,
        write: sink,
        now,
        base: { ...base, ...childBase },
      });
    },
  };
}

// A logger that emits nothing — the default in tests and the demo.
export const silentLogger = createLogger({ level: 'silent', write() {} });
