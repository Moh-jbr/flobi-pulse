import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Alarm } from '../electron/core/engine/alarm.mjs';

function setup({ repeat = true } = {}) {
  let now = 0;
  const timers = [];
  const played = [];
  const changes = [];
  const open = new Set();
  const alarm = new Alarm({
    play: (k) => played.push(k),
    stillRinging: (id) => open.has(id),
    onChange: (s) => changes.push(s.ringing),
    repeat: () => repeat,
    repeatMs: 20_000,
    maxMs: 60_000,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => t && (t.done = true),
  });
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => !t.done && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.done = true;
      next.fn();
    }
    now = end;
  };
  return { alarm, played, changes, open, advance };
}

test('critical siren repeats until silenced', () => {
  const { alarm, played, open, advance } = setup();
  open.add('a1');
  alarm.ring(['a1']);
  assert.deepEqual(played, ['critical']);
  assert.equal(alarm.ringing, true);
  advance(20_000);
  advance(20_000);
  assert.equal(played.length, 3);
  assert.deepEqual(alarm.silence(), ['a1']);
  advance(60_000);
  assert.equal(played.length, 3);
  assert.equal(alarm.ringing, false);
});

test('siren stops when the alert resolves or is acknowledged', () => {
  const { alarm, played, open, advance, changes } = setup();
  open.add('a1');
  alarm.ring(['a1']);
  open.delete('a1'); // resolved
  advance(20_000);
  assert.deepEqual(played, ['critical']);
  assert.equal(alarm.ringing, false);
  assert.deepEqual(changes, [true, false]);
});

test('siren gives up after maxMs', () => {
  const { alarm, played, open, advance } = setup();
  open.add('a1');
  alarm.ring(['a1']);
  advance(10 * 60_000);
  // rings at 0, 20, 40 s; at 60 s the max is reached
  assert.equal(played.length, 3);
  assert.equal(alarm.ringing, false);
});

test('no repeat setting plays once', () => {
  const { alarm, played, open, advance } = setup({ repeat: false });
  open.add('a1');
  alarm.ring(['a1']);
  advance(60_000);
  assert.deepEqual(played, ['critical']);
  assert.equal(alarm.ringing, false);
});

test('warning chimes are spaced out and skipped while the siren rings', () => {
  const { alarm, played, open, advance } = setup();
  alarm.chime();
  alarm.chime();
  assert.deepEqual(played, ['warning']);
  advance(5_000);
  alarm.chime();
  assert.deepEqual(played, ['warning', 'warning']);
  open.add('c');
  alarm.ring(['c']);
  advance(5_000);
  alarm.chime();
  assert.deepEqual(played, ['warning', 'warning', 'critical']);
});

test('a second critical alert right away joins the siren instead of overlapping it', () => {
  const { alarm, played, open, advance } = setup();
  open.add('a');
  open.add('b');
  alarm.ring(['a']);
  advance(1_000);
  alarm.ring(['b']);
  assert.deepEqual(played, ['critical']);
  assert.deepEqual(alarm.state().ids, ['a', 'b']);
  advance(20_000);
  assert.deepEqual(played, ['critical', 'critical']);
});
