import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelsOf, notesOf, matchesQuery, servicesView, errorsOfService, fitColumns, sortServices, nextSort, isDefaultSort, COLUMNS, DEFAULT_SORT } from '../src/lib/services-table.js';

const MIN = 60_000;
const svc = (over) => ({ short: 'x', name: 'flobi-x', health: 'healthy', ready: 1, desired: 1, causes: [], reasons: [], pods: [], errorsPerMin: 0, restarts: 0, recentRestarts: 0, memEta: null, ...over });

test('a degraded row is orange, and inside it only what made it so', () => {
  const lv = levelsOf(svc({ health: 'degraded', causes: ['mem'], memPct: 0.93 }));
  assert.equal(lv.row, 'orange');
  assert.equal(lv.mem, 'orange');
  assert.equal(lv.cpu, null);
  assert.equal(lv.pods, null);
});

test('a down row is red, with the pods that took it down', () => {
  const lv = levelsOf(svc({ health: 'down', ready: 0, causes: ['pods'] }));
  assert.equal(lv.row, 'red');
  assert.equal(lv.pods, 'red');
});

test('memory about to run out warns on a healthy row: red under 5 minutes', () => {
  assert.equal(levelsOf(svc({ memEta: 20 * MIN })).row, 'orange');
  assert.equal(levelsOf(svc({ memEta: 3 * MIN })).row, 'red');
  assert.equal(levelsOf(svc({ memEta: 3 * MIN })).mem, 'red');
  assert.equal(levelsOf(svc({ memEta: 45 * MIN })).row, null);
});

test('errors turn orange from 5 a minute and never red, like the cards', () => {
  assert.equal(levelsOf(svc({ errorsPerMin: 4.9 })).errors, null);
  assert.equal(levelsOf(svc({ errorsPerMin: 5 })).errors, 'orange');
  assert.equal(levelsOf(svc({ errorsPerMin: 400 })).errors, 'orange');
});

test('a restart in the last 15 minutes is orange; older ones are not', () => {
  assert.equal(levelsOf(svc({ restarts: 3, recentRestarts: 1 })).restarts, 'orange');
  assert.equal(levelsOf(svc({ restarts: 3 })).restarts, null);
});

test('a wide table shows every column', () => {
  assert.equal(fitColumns(1400).cols.length, COLUMNS.length);
  assert.equal(fitColumns(1400).compact, false);
});

test('at the usual window (about 836 px of table) every column still fits', () => {
  assert.equal(fitColumns(836).cols.length, COLUMNS.length);
});

test('a narrower table drops Last hour first, then Restarts', () => {
  const keys = fitColumns(750).cols.map((c) => c.key);
  assert.ok(!keys.includes('hour'));
  assert.ok(keys.includes('restarts'));
  assert.ok(!fitColumns(700).cols.map((c) => c.key).includes('restarts'));
});

test('beside an open details panel the four main columns stay whole, Health as a dot', () => {
  const fit = fitColumns(385);
  assert.deepEqual(fit.cols.map((c) => c.key), ['service', 'health', 'cpu', 'mem']);
  assert.equal(fit.compact, true);
  assert.match(fit.template, /^minmax\(140px,1\.5fr\) 34px /);
});

test('the columns a table keeps always fit in it', () => {
  for (let w = 340; w <= 1200; w += 7) {
    const { cols, compact } = fitColumns(w);
    const used = 12 + cols.reduce((a, c) => a + (compact && c.compactW ? c.compactW : c.w), 0);
    assert.ok(used <= w, `${w}px table holds ${used}px of columns`);
  }
});

test('rows come worst first, then by name', () => {
  const rows = sortServices([svc({ short: 'b' }), svc({ short: 'a', health: 'degraded' }), svc({ short: 'c', health: 'down' }), svc({ short: 'a2' })], DEFAULT_SORT);
  assert.deepEqual(rows.map((s) => s.short), ['c', 'a', 'a2', 'b']);
});

test('the first click on CPU puts the busiest on top; the second flips it', () => {
  const list = [svc({ short: 'a', cpuPct: 0.1 }), svc({ short: 'b', cpuPct: 0.7 }), svc({ short: 'c', cpuPct: 0.3 })];
  const cpu = COLUMNS.find((c) => c.key === 'cpu');
  const first = nextSort(DEFAULT_SORT, cpu);
  assert.deepEqual(sortServices(list, first).map((s) => s.short), ['b', 'c', 'a']);
  assert.deepEqual(sortServices(list, nextSort(first, cpu)).map((s) => s.short), ['a', 'c', 'b']);
});

test('the first click on Pods puts the ones missing pods on top', () => {
  const list = [svc({ short: 'full', ready: 2, desired: 2 }), svc({ short: 'half', ready: 1, desired: 2 }), svc({ short: 'none', ready: 0, desired: 1 })];
  const pods = COLUMNS.find((c) => c.key === 'pods');
  assert.deepEqual(sortServices(list, nextSort(DEFAULT_SORT, pods)).map((s) => s.short), ['none', 'half', 'full']);
});

test('red rows, then orange rows, stay on top whatever the table is sorted by', () => {
  const list = [
    svc({ short: 'a-calm', cpuPct: 0.9 }),
    svc({ short: 'b-degraded', health: 'degraded', cpuPct: 0.1 }),
    svc({ short: 'c-rising', memEta: 20 * MIN, cpuPct: 0.2 }),
    svc({ short: 'd-down', health: 'down', ready: 0, cpuPct: 0.05 }),
    svc({ short: 'e-calm', cpuPct: 0.3 }),
  ];
  const byCpu = sortServices(list, { key: 'cpu', dir: 'desc' }).map((s) => s.short);
  assert.deepEqual(byCpu, ['d-down', 'c-rising', 'b-degraded', 'a-calm', 'e-calm']);
  const byName = sortServices(list, { key: 'service', dir: 'desc' }).map((s) => s.short);
  assert.deepEqual(byName, ['d-down', 'c-rising', 'b-degraded', 'e-calm', 'a-calm']);
});

test('many errors make the whole row orange, and say so in Health', () => {
  const lv = levelsOf(svc({ errorsPerMin: 12 }));
  assert.equal(lv.row, 'orange');
  assert.deepEqual(lv.warning, { label: 'Many errors', tone: 'orange' });
  assert.equal(levelsOf(svc({ errorsPerMin: 4 })).row, null);
  assert.equal(levelsOf(svc({ errorsPerMin: 4 })).warning, null);
});

test('a recent restart makes the row orange too', () => {
  const lv = levelsOf(svc({ restarts: 2, recentRestarts: 1 }));
  assert.equal(lv.row, 'orange');
  assert.equal(lv.warning.label, 'Restarted');
});

test('a down row stays red, and keeps its own Health, whatever its errors', () => {
  const lv = levelsOf(svc({ health: 'down', ready: 0, causes: ['pods'], errorsPerMin: 40 }));
  assert.equal(lv.row, 'red');
  assert.equal(lv.warning, null);
});

test('a row orange from its errors sorts with the other warnings', () => {
  const list = [svc({ short: 'a-calm', cpuPct: 0.9 }), svc({ short: 'b-errors', errorsPerMin: 9, cpuPct: 0.1 })];
  assert.deepEqual(sortServices(list, { key: 'cpu', dir: 'desc' }).map((s) => s.short), ['b-errors', 'a-calm']);
});

test('the line under a name says what is wrong in words', () => {
  assert.deepEqual(notesOf(svc({ errorsPerMin: 12.4, recentRestarts: 2 })), ['12 errors a minute', '2 restarts in the last 15 min']);
  assert.deepEqual(notesOf(svc({ recentRestarts: 1 })), ['1 restart in the last 15 min']);
  assert.deepEqual(notesOf(svc({ health: 'degraded', reasons: ['1 of 2 pods ready'], errorsPerMin: 12 })), ['1 of 2 pods ready']);
  assert.deepEqual(notesOf(svc()), []);
});

test('a third click on a header takes the sort off', () => {
  const cpu = COLUMNS.find((c) => c.key === 'cpu');
  const one = nextSort(DEFAULT_SORT, cpu);
  const two = nextSort(one, cpu);
  assert.deepEqual([one, two], [{ key: 'cpu', dir: 'desc' }, { key: 'cpu', dir: 'asc' }]);
  assert.ok(isDefaultSort(nextSort(two, cpu)));
  const health = COLUMNS.find((c) => c.key === 'health');
  const flipped = nextSort(DEFAULT_SORT, health);
  assert.deepEqual(flipped, { key: 'health', dir: 'desc' });
  assert.ok(isDefaultSort(nextSort(flipped, health)));
});

test('search finds a service by its name, workload or address, every word', () => {
  const s = svc({ short: 'notes-back', name: 'flobi-notes-back', hosts: ['notes.flobi.ai'] });
  assert.ok(matchesQuery(s, ''));
  assert.ok(matchesQuery(s, '  '));
  assert.ok(matchesQuery(s, 'Notes'));
  assert.ok(matchesQuery(s, 'flobi.ai notes'));
  assert.ok(!matchesQuery(s, 'notes gateway'));
  assert.ok(!matchesQuery(svc({ short: 'gateway', name: 'flobi-gateway' }), 'notes'));
});

test('a degraded service whose memory runs out in minutes is red, and sorts with the red rows', () => {
  assert.equal(levelsOf(svc({ health: 'degraded', causes: ['mem'], memEta: 3 * MIN })).row, 'red');
  const list = [svc({ short: 'a-deg', health: 'degraded', memEta: 3 * MIN }), svc({ short: 'b-healthy', memEta: 3 * MIN }), svc({ short: 'c-deg', health: 'degraded' })];
  assert.deepEqual(sortServices(list, DEFAULT_SORT).map((s) => s.short), ['a-deg', 'b-healthy', 'c-deg']);
});

test('Services show as a table unless cards were picked', () => {
  assert.equal(servicesView(undefined), 'table');
  assert.equal(servicesView({}), 'table');
  assert.equal(servicesView({ views: { services: 'cards' } }), 'cards');
  assert.equal(servicesView({ views: { services: 'table' } }), 'table');
  assert.equal(servicesView({ views: { services: 'grid' } }), 'table');
});

test('a service’s errors: only its own from the last hour, the ones firing now first', () => {
  const spark = (recent, earlier = 0) => [...Array(55).fill(0).map((_, i) => (i === 0 ? earlier : 0)), ...Array(5).fill(0).map((_, i) => (i === 4 ? recent : 0))];
  const groups = [
    { id: 'old', service: 'flobi-notes', count1h: 40, spark: spark(0, 40), lastSeen: 1 },
    { id: 'now', service: 'flobi-notes', count1h: 12, spark: spark(12), lastSeen: 3 },
    { id: 'quiet', service: 'flobi-notes', count1h: 0, spark: spark(0), lastSeen: 2 },
    { id: 'other', service: 'flobi-drive', count1h: 99, spark: spark(99), lastSeen: 4 },
  ];
  const mine = errorsOfService(groups, 'flobi-notes');
  assert.deepEqual(mine.map((g) => g.id), ['now', 'old']);
  assert.equal(mine[0].count5m, 12);
  assert.deepEqual(errorsOfService(undefined, 'flobi-notes'), []);
});
