// The recap's timeline strip, worked out without React so it can be tested:
// which row each incident sits on, and where the hour marks go.

const KIND_ROW = { database: 'Database', frontend: 'Frontends', node: 'Nodes', edge: 'Edge', errors: 'Errors', http: 'Load balancer', costs: 'Costs', event: 'Cluster', crash: 'Crashes' };

/** The row an incident belongs on: its service ("flobi-brand" → "brand"), else what kind of thing it is. */
export function rowOf(inc) {
  if (inc.service) return String(inc.service).replace(/^flobi-/, '');
  return KIND_ROW[inc.kind] || 'Other';
}

/**
 * Incidents grouped into labelled rows, the row that went wrong first on top.
 * Past `max` rows, the rest share one "Other" row, so the strip never grows
 * taller than the recap can show.
 * @returns {{label: string, incidents: object[], worst: 'critical'|'warning'}[]}
 */
export function timelineRows(incidents = [], max = 7) {
  const rows = new Map();
  for (const inc of [...incidents].sort((a, b) => a.start - b.start)) {
    const label = rowOf(inc);
    if (!rows.has(label)) rows.set(label, { label, incidents: [], worst: 'warning' });
    const row = rows.get(label);
    row.incidents.push(inc);
    if (inc.severity === 'critical') row.worst = 'critical';
  }
  const list = [...rows.values()];
  if (list.length <= max) return list;
  const kept = list.slice(0, max - 1);
  const rest = list.slice(max - 1);
  const other = { label: `${rest.length} more`, incidents: rest.flatMap((r) => r.incidents).sort((a, b) => a.start - b.start), worst: rest.some((r) => r.worst === 'critical') ? 'critical' : 'warning', others: rest.map((r) => r.label) };
  return [...kept, other];
}

const STEPS_MIN = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];

/**
 * Hour marks on round local times (14:00, 16:00…, never 14:37), at most about
 * `most` of them. A midnight is always a mark when the marks are hours apart,
 * and is flagged so the strip can name the day there.
 * @returns {{t: number, midnight: boolean}[]}
 */
export function timelineTicks(since, until, most = 8) {
  const span = Math.max(1, until - since);
  const step = STEPS_MIN.find((m) => span / (m * 60_000) <= most) || STEPS_MIN[STEPS_MIN.length - 1];
  const d = new Date(since);
  d.setHours(0, 0, 0, 0);
  const out = [];
  const everyDays = Math.max(1, Math.round(step / 1440));
  let days = 0;
  // Walking in local minutes keeps the marks on round clock times across a daylight-saving change.
  for (let guard = 0; d.getTime() <= until && guard < 5000; guard++) {
    const t = d.getTime();
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    // Every step below a day divides 1440, so midnight is always one of the marks.
    const onStep = step >= 1440 ? midnight && days++ % everyDays === 0 : (d.getHours() * 60 + d.getMinutes()) % step === 0;
    if (t >= since && onStep) out.push({ t, midnight });
    d.setMinutes(d.getMinutes() + Math.min(step, 60));
  }
  return out;
}
