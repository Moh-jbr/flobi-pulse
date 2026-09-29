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
 * Best guess at a line's level. For plain text lines, text markers win over Cloud
 * Logging's severity because GKE marks every stderr line as ERROR.
 */
export function detectLevel(text, severity, json, { stream = null } = {}) {
  const sev = String(severity || 'DEFAULT').toUpperCase();
  const errorish = sev === 'ERROR' || sev === 'CRITICAL' || sev === 'ALERT' || sev === 'EMERGENCY';
  if (json) {
    const l = json.level ?? json.severity ?? json.lvl;
    if (typeof l === 'number' && PINO[l]) return PINO[l];
    if (typeof l === 'string' && LEVEL_MAP[l.toUpperCase()]) return LEVEL_MAP[l.toUpperCase()];
    // A structured line without a level of its own: GKE moved the app's "severity" onto the
    // entry, so it's the app's own word. Except ERROR on stderr (or an unknown stream): that's
    // also what GKE gives a level-less JSON line on stderr, so it proves nothing.
    if (sev !== 'DEFAULT' && LEVEL_MAP[sev] && !(errorish && stream !== 'stdout')) return LEVEL_MAP[sev];
  }
  const s = stripAnsi(text);
  const t = s.slice(0, 400);
  const nest = t.match(NEST);
  if (nest) return LEVEL_MAP[nest[1]] || 'INFO';
  const stderr = sev === 'ERROR' || sev === 'CRITICAL' || sev === 'ALERT' || sev === 'EMERGENCY';
  // A stack trace's lines are ERROR, so they reach the error they belong to. Its first line
  // ("TypeError: …") only on stderr: on stdout, "Error: …" is often just a message.
  if (isStackFrame(s) || ((stderr || sev === 'DEFAULT') && isExceptionHeader(t))) return 'ERROR';
  const head = t.slice(0, 120);
  const w = head.match(LEVEL_WORD);
  if (w) return LEVEL_MAP[w[1]] || 'INFO';
  if (/\b(Unhandled|Exception|TypeError|ReferenceError|ECONNREFUSED|ETIMEDOUT|ECONNRESET)\b/.test(t)) return 'ERROR';
  // stderr without any marker: keep it as a warning rather than a hard error
  if (stderr) return 'WARN';
  return LEVEL_MAP[sev] || 'INFO';
}

/** "[Nest] 1  - 09/25/2026, 10:00:00 AM   ERROR [BrandService] boom" → { context:'BrandService', message:'boom' } */
export function parseNest(text) {
  const t = stripAnsi(text);
  const m = t.match(NEST);
  if (!m) return { context: null, message: t };
  return { context: m[2] || null, message: t.slice(m[0].length) };
}

// One V8 stack frame, in any of its shapes:
//   at Foo.bar (/app/x.js:1:2)            at async Foo.bar (/app/x.js:1:2)    at new Foo (/app/x.js:1:2)
//   at Foo.bar [as baz] (/app/x.js:1:2)   at new Promise (<anonymous>)        at Array.map (<anonymous>)
//   at /app/x.js:1:2                      at async /app/x.js:1:2              at node:internal/process/task_queues:95:5
//   at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
//   at async Promise.all (index 0)        at eval (eval at f (/app/x.js:1:2), <anonymous>:1:1)
// util.inspect() ends the last frame with " {" when the error has extra fields (code, errno…).
const FRAME =
  /^\s*at\s+(?:(?:async|new)\s+)*(?:(?:[^\s()](?:[^()]|\(anonymous function\))*?\s+)?\((?:.*:\d+(?::\d+)?|<anonymous>|native|index \d+|unknown location)\)|(?=\S*[^\d\s:])\S+:\d+:\d+|<anonymous>)(?:\s+\{)?\s*$/;

export function isStackFrame(text) {
  const t = stripAnsi(text);
  return t.length < 2000 && FRAME.test(t);
}

// The first line of a printed exception: "TypeError: …", "Error: …", "QueryFailedError: …",
// "PrismaClientKnownRequestError: …", "Error [ERR_HTTP_HEADERS_SENT]: …", "[Error: …]".
const EXCEPTION_HEADER = /^\s*(?:Uncaught\s+)?\[?(?:[A-Za-z_$][\w$]*\.)*(?:[A-Z][\w$]*)?(?:Error|Exception|Rejection)(?: \[[^\]]{1,80}\])?(?::|\]?\s*$)/;

export function isExceptionHeader(text) {
  return EXCEPTION_HEADER.test(stripAnsi(text).slice(0, 400));
}

/** Short service name: "flobi-brand" → "brand" */
export function shortName(name) {
  return String(name || '').replace(/^flobi-/, '');
}

/**
 * App-side signs that a service can't talk to Postgres (pg, TypeORM, Prisma, libpq), over TCP
 * or over a unix socket (the Cloud SQL Auth Proxy's /cloudsql/<connection>/.s.PGSQL.5432).
 */
export const DB_CONN_ERROR =
  /(ECONNREFUSED|ETIMEDOUT|ECONNRESET)[^\n]{0,80}:5432|:5432[^\n]{0,80}(ECONNREFUSED|ETIMEDOUT)|(ECONNREFUSED|ENOENT|EACCES|ETIMEDOUT|ECONNRESET)[^\n]{0,200}\.s\.PGSQL\.\d+|\.s\.PGSQL\.\d+[^\n]{0,120}(failed|No such file or directory|Connection refused)|could not connect to server: (Connection refused|No such file or directory)|connection to server at "[^"\n]*"(?: \([^)\n]*\))?, port \d+ failed|Connection terminated unexpectedly|Can't reach database server|Unable to connect to the database|too many clients already|remaining connection slots are reserved|the database system is (starting up|shutting down|in recovery mode)|terminating connection due to administrator command|Timed out fetching a new connection from the connection pool|timeout exceeded when trying to connect|Connection terminated due to connection timeout/i;
