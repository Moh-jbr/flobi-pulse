// Log helpers shared by the live pipeline and demo mode. Pure JS (no Node APIs)
// so the same code also runs in the browser preview.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s) {
  return String(s ?? '').replace(ANSI, '');
}

const NEST = /^\[Nest\]\s+\d+\s+-\s+.*?\s+(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)\s+(?:\[([^\]]+)\]\s*)?/;
const LEVEL_WORD = /\b(FATAL|CRITICAL|ERROR|ERR|WARN|WARNING|INFO|LOG|DEBUG|VERBOSE|TRACE)\b/;

const LEVEL_MAP = {
  FATAL: 'ERROR',
  CRITICAL: 'ERROR',
  EMERGENCY: 'ERROR',
  ALERT: 'ERROR',
  ERROR: 'ERROR',
  ERR: 'ERROR',
  WARN: 'WARN',
  WARNING: 'WARN',
  NOTICE: 'INFO',
  INFO: 'INFO',
  LOG: 'INFO',
  DEFAULT: 'INFO',
  DEBUG: 'DEBUG',
  VERBOSE: 'DEBUG',
  TRACE: 'DEBUG',
};

const PINO = { 10: 'DEBUG', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'ERROR' };

/**
 * Best guess at a line's level. Text markers win over Cloud Logging's severity
 * because GKE marks every stderr line as ERROR.
 */
export function detectLevel(text, severity, json) {
  if (json) {
    const l = json.level ?? json.severity ?? json.lvl;
    if (typeof l === 'number' && PINO[l]) return PINO[l];
    if (typeof l === 'string' && LEVEL_MAP[l.toUpperCase()]) return LEVEL_MAP[l.toUpperCase()];
  }
  const t = stripAnsi(text).slice(0, 400);
  const nest = t.match(NEST);
  if (nest) return LEVEL_MAP[nest[1]] || 'INFO';
  if (/^\s+at\s+\S+.*\(.*:\d+:\d+\)\s*$/.test(t) || /^\s+at\s+.*:\d+:\d+\s*$/.test(t)) return 'ERROR'; // stack frame
  const head = t.slice(0, 120);
  const w = head.match(LEVEL_WORD);
  if (w) return LEVEL_MAP[w[1]] || 'INFO';
  if (/\b(Unhandled|Exception|TypeError|ReferenceError|ECONNREFUSED|ETIMEDOUT|ECONNRESET)\b/.test(t)) return 'ERROR';
  const sev = String(severity || 'DEFAULT').toUpperCase();
  if (sev === 'ERROR' || sev === 'CRITICAL' || sev === 'ALERT' || sev === 'EMERGENCY') {
    // stderr without any marker: keep it as a warning rather than a hard error
    return 'WARN';
  }
  return LEVEL_MAP[sev] || 'INFO';
}

/** "[Nest] 1  - 09/25/2026, 10:00:00 AM   ERROR [BrandService] boom" → { context:'BrandService', message:'boom' } */
export function parseNest(text) {
  const t = stripAnsi(text);
  const m = t.match(NEST);
  if (!m) return { context: null, message: t };
  return { context: m[2] || null, message: t.slice(m[0].length) };
}

export function isStackFrame(text) {
  return /^\s*at\s+(\S+\s+)?\(?[^()]*:\d+:\d+\)?\s*$/.test(stripAnsi(text));
}

/** Short service name: "flobi-brand" → "brand" */
export function shortName(name) {
  return String(name || '').replace(/^flobi-/, '');
}

/** App-side signs that a service can't talk to Postgres (pg, TypeORM, Prisma). */
export const DB_CONN_ERROR =
  /(ECONNREFUSED|ETIMEDOUT|ECONNRESET)[^\n]{0,80}:5432|:5432[^\n]{0,80}(ECONNREFUSED|ETIMEDOUT)|Connection terminated unexpectedly|Can't reach database server|Unable to connect to the database|too many clients already|remaining connection slots are reserved|the database system is (starting up|shutting down|in recovery mode)|terminating connection due to administrator command|Timed out fetching a new connection from the connection pool|timeout exceeded when trying to connect|Connection terminated due to connection timeout/i;
