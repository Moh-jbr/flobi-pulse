// Decides when alert sounds play. The sounds themselves are made in the window
// (Web Audio); this only says "play warning" / "play critical".
//
//  • warning  → one chime (at most one every few seconds, so a burst of
//               warnings doesn't turn into a jingle)
//  • critical → the siren right away, then again every `repeatMs` while one of
//               its alerts is open, not acknowledged and not muted. Each alert
//               rings for at most `maxMs` from its own first ring: ringing it
//               again doesn't restart that, so a flapping alert can't ring forever.
//               Acknowledging (the Silence button, or clicking the notification)
//               stops it. While an alert is recovering (its problem went away, but
//               it's held open in case it comes back) it stays on the list silently:
//               if the problem returns, the siren picks up again at the next repeat.
//  • after Silence → a quiet window (`quietMs`): nothing new rings or chimes. The
//               criticals that come up meanwhile wait; when it ends, the ones still
//               open, unacknowledged, unmuted and not recovering ring (a recovering
//               one rings if its problem comes back). Their 10 minutes start then.
// Pure JS: timers and clock are injectable for tests.

const MIN = 60_000;

export class Alarm {
  /**
   * @param {{ play:(kind:'warning'|'critical')=>void, stillRinging:(id:string)=>boolean, sounding?:(id:string)=>boolean,
   *           onChange?:(state:{ringing:boolean, ids:string[], since:number|null, quietUntil:number|null})=>void,
   *           repeat?:()=>boolean, repeatMs?:number, maxMs?:number, chimeGapMs?:number,
   *           now?:()=>number, setTimer?:Function, clearTimer?:Function }} o
   */
  constructor({ play, stillRinging, sounding = () => true, onChange, repeat = () => true, repeatMs = 20_000, maxMs = 10 * MIN, chimeGapMs = 4_000, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) }) {
    Object.assign(this, { play, stillRinging, sounding, onChange, repeat, repeatMs, maxMs, chimeGapMs, now, setTimer, clearTimer });
    this.ids = new Set();
    this.firstRung = new Map(); // alert id → when it first rang (its maxMs runs from there)
    this.timer = null;
    this.lastChime = -Infinity;
    this.lastSiren = -Infinity;
    this.sirenMs = 3_500; // how long one siren lasts
    this.quietUntil = -Infinity; // after Silence, nothing new rings before this
    this.quietTimer = null;
    this.deferred = new Set(); // critical alert ids that came up while it was quiet
  }

  /** In the quiet window after Silence. */
  get quiet() {
    return this.now() < this.quietUntil;
  }

  get ringing() {
    return this.ids.size > 0;
  }

  /** Ringing and not all of its alerts are recovering right now. */
  get audible() {
    for (const id of this.ids) if (this.sounding(id)) return true;
    return false;
  }

  /** When the longest-ringing current alert first rang. */
  get since() {
    let first = null;
    for (const id of this.ids) {
      const at = this.firstRung.get(id);
      if (at != null && (first == null || at < first)) first = at;
    }
    return first;
  }

  state() {
    return { ringing: this.ringing, audible: this.audible, ids: [...this.ids], since: this.since, quietUntil: this.quiet ? this.quietUntil : null };
  }

  chime() {
    const t = this.now();
    // A critical siren already covers it; right after Silence, nothing new makes a sound.
    if (this.audible || this.quiet || t - this.lastChime < this.chimeGapMs) return;
    this.lastChime = t;
    this.play('warning');
  }

  /** Starts the siren for these critical alert ids (each within its own maxMs). In the quiet window they wait. */
  ring(ids) {
    const t = this.now();
    const fresh = ids.filter(Boolean);
    if (this.quiet) {
      for (const id of fresh) this.deferred.add(id);
      if (fresh.length && !this.quietTimer) this._scheduleQuietEnd();
      return;
    }
    for (const id of fresh) {
      if (this.firstRung.has(id)) continue;
      this.firstRung.set(id, t);
      if (this.firstRung.size > 500) this.firstRung.delete(this.firstRung.keys().next().value);
    }
    const live = fresh.filter((id) => this._inTime(id, t));
    if (!live.length) return;
    // Don't start a second siren on top of one that is still sounding.
    let played = false;
    if (t - this.lastSiren >= this.sirenMs) {
      this.lastSiren = t;
      this.play('critical');
      played = true;
    }
    if (!this.repeat()) return;
    const added = live.filter((id) => !this.ids.has(id));
    for (const id of added) this.ids.add(id);
    // The next repeat comes a full period after the last siren; a ring that didn't
    // sound leaves the pending repeat alone (so frequent rings can't starve it).
    if (played || !this.timer) this._schedule();
    if (added.length) this._changed();
  }

  /**
   * Drops alerts that resolved / were acknowledged / muted / rang long enough; stops when none are left.
   * Once the quiet window is over, rings for the alerts that waited in it and are still a problem.
   */
  check() {
    this._ringDeferred();
    if (!this.ringing) return;
    const t = this.now();
    let dropped = false;
    for (const id of [...this.ids]) {
      if (this._inTime(id, t) && this.stillRinging(id)) continue;
      this.ids.delete(id);
      dropped = true;
    }
    if (!this.ringing) this._stop();
    else if (dropped) this._changed();
  }

  /**
   * Stops the siren. Returns the ids it was ringing for (to acknowledge them). With `quietMs`,
   * nothing new rings or chimes for that long (see ring()).
   */
  silence({ quietMs = 0 } = {}) {
    const ids = [...this.ids];
    if (ids.length || this.timer) this._stop();
    if (quietMs > 0) {
      this.quietUntil = Math.max(this.quietUntil, this.now() + quietMs);
      this._scheduleQuietEnd();
    }
    return ids;
  }

  /** The session stopped (a reconnect, waking up, a settings change): its alerts are gone. A quiet window carries on. */
  reset() {
    const was = this.ringing;
    this.clearTimer(this.timer);
    this.clearTimer(this.quietTimer);
    this.timer = this.quietTimer = null;
    this.ids.clear();
    this.deferred.clear();
    if (was) this._changed();
  }

  destroy() {
    this.clearTimer(this.timer);
    this.clearTimer(this.quietTimer);
    this.timer = this.quietTimer = null;
    this.ids.clear();
    this.deferred.clear();
  }

  _scheduleQuietEnd() {
    this.clearTimer(this.quietTimer);
    this.quietTimer = this.setTimer(() => {
      this.quietTimer = null;
      if (this.quiet) this._scheduleQuietEnd();
      else this._ringDeferred();
    }, Math.max(0, this.quietUntil - this.now()));
  }

  /**
   * After the quiet window: the alerts that waited in it ring now if they're still open,
   * unacknowledged and unmuted, and their problem is there. Recovering ones wait for it to
   * come back; resolved, acknowledged or muted ones never ring.
   */
  _ringDeferred() {
    if (!this.deferred.size || this.quiet) return;
    const due = [];
    for (const id of [...this.deferred]) {
      if (!this.stillRinging(id)) this.deferred.delete(id);
      else if (this.sounding(id)) {
        this.deferred.delete(id);
        due.push(id);
      }
    }
    if (due.length) this.ring(due);
  }

  _inTime(id, t) {
    const first = this.firstRung.get(id);
    return first != null && t - first < this.maxMs;
  }

  _schedule() {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this._tick(), this.repeatMs);
  }

  _tick() {
    this.timer = null;
    this.check();
    if (!this.ringing) return;
    if (!this.repeat()) {
      this._stop();
      return;
    }
    // Only alerts that are recovering: skip this round, keep them in case the problem returns.
    // (One that waited out the quiet window may have just rung, in check().)
    if (this.audible && this.now() - this.lastSiren >= this.sirenMs) {
      this.lastSiren = this.now();
      this.play('critical');
    }
    this._schedule();
  }

  _stop() {
    this.clearTimer(this.timer);
    this.timer = null;
    this.ids.clear();
    this._changed();
  }

  _changed() {
    this.onChange?.(this.state());
  }
}
