import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowOf, timelineRows, timelineTicks } from '../src/lib/timeline.js';

const H = 3600_000;

test('an incident sits on its service row, else on a row named for its kind', () => {
  assert.equal(rowOf({ service: 'flobi-brand', kind: 'crash' }), 'brand');
  assert.equal(rowOf({ service: null, kind: 'database' }), 'Database');
  assert.equal(rowOf({ kind: 'something-new' }), 'Other');
});

test('rows come in the order they first went wrong, worst severity wins', () => {
  const rows = timelineRows([
    { id: 1, service: 'flobi-gateway', severity: 'warning', start: 3 },
    { id: 2, service: 'flobi-brand', severity: 'warning', start: 1 },
    { id: 3, service: 'flobi-gateway', severity: 'critical', start: 5 },
  ]);
  assert.deepEqual(rows.map((r) => r.label), ['brand', 'gateway']);
  assert.equal(rows[1].worst, 'critical');
  assert.equal(rows[1].incidents.length, 2);
});

test('past the row limit the rest share one row', () => {
  const incs = Array.from({ length: 10 }, (_, i) => ({ id: i, service: `svc-${i}`, severity: i === 9 ? 'critical' : 'warning', start: i }));
  const rows = timelineRows(incs, 7);
  assert.equal(rows.length, 7);
  assert.equal(rows[6].label, '4 more');
  assert.equal(rows[6].incidents.length, 4);
  assert.equal(rows[6].worst, 'critical');
  assert.equal(rows.reduce((a, r) => a + r.incidents.length, 0), 10);
});

test('hour marks land on round times and midnight is flagged', () => {
  const since = new Date(2026, 9, 2, 14, 37).getTime();
  const until = new Date(2026, 9, 3, 1, 7).getTime();
  const ticks = timelineTicks(since, until);
  assert.ok(ticks.length >= 4 && ticks.length <= 7, `${ticks.length} marks`);
  for (const k of ticks) {
    const d = new Date(k.t);
    assert.equal(d.getMinutes(), 0);
    assert.ok(k.t >= since && k.t <= until);
  }
  const mid = ticks.filter((k) => k.midnight);
  assert.equal(mid.length, 1);
  assert.equal(new Date(mid[0].t).getDate(), 3);
});

test('a short span gets quarter hours, a long one gets days', () => {
  const since = new Date(2026, 9, 3, 10, 5).getTime();
  const short = timelineTicks(since, since + 1.2 * H);
  assert.ok(short.every((k) => new Date(k.t).getMinutes() % 15 === 0));
  assert.ok(short.length >= 3);
  const long = timelineTicks(since, since + 6 * 24 * H);
  assert.ok(long.every((k) => k.midnight));
  assert.ok(long.length >= 3 && long.length <= 7, `${long.length} marks`);
});
