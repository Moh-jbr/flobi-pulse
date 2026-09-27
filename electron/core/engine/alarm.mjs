// Decides when alert sounds play. The sounds themselves are made in the window
// (Web Audio); this only says "play warning" / "play critical".
//
//  • warning  → one chime (at most one every few seconds, so a burst of
//               warnings doesn't turn into a jingle)
//  • critical → the siren right away, then again every `repeatMs` for as long as
//               the alert is open, not acknowledged and not muted — up to `maxMs`.
//               Acknowledging (the Silence button, or clicking the notification)
//               stops it.
// Pure JS: timers and clock are injectable for tests.

const MIN = 60_000;

export class Alarm {
  /**
   * @param {{ play:(kind:'warning'|'critical')=>void, stillRinging:(id:string)=>boolean,
   *           onChange?:(state:{ringing:boolean, ids:string[], since:number|null})=>void,
   *           repeat?:()=>boolean, repeatMs?:number, maxMs?:number, chimeGapMs?:number,
   *           now?:()=>number, setTimer?:Function, clearTimer?:Function }} o
   */
  constructor({ play, stillRinging, onChange, repeat = () => true, repeatMs = 20_000, maxMs = 10 * MIN, chimeGapMs = 4_000, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) }) {
    Object.assign(this, { play, stillRinging, onChange, repeat, repeatMs, maxMs, chimeGapMs, now, setTimer, clearTimer });
    this.ids = new Set();
    this.since = null;
    this.timer = null;
    this.lastChime = -Infinity;
    this.lastSiren = -Infinity;
    this.sirenMs = 3_500; // how long one siren lasts
  }

  get ringing() {
    return this.ids.size > 0;
  }

  state() {
    return { ringing: this.ringing, ids: [...this.ids], since: this.since };
  }

  chime() {
    const t = this.now();
    // A critical siren already covers it.
    if (this.ringing || t - this.lastChime < this.chimeGapMs) return;
    this.lastChime = t;
    this.play('warning');
  }

  /** Starts (or restarts) the siren for these critical alert ids. */
  ring(ids) {
    const fresh = ids.filter(Boolean);
    if (!fresh.length) return;
    // Don't start a second siren on top of one that is still sounding.
    const t = this.now();
    if (t - this.lastSiren >= this.sirenMs) {
      this.lastSiren = t;
      this.play('critical');
    }
    if (!this.repeat()) return;
    const was = this.ringing;
    for (const id of fresh) this.ids.add(id);
    this.since = this.now();
    this._schedule();
    if (!was) this._changed();
  }

  /** Drops alerts that resolved / were acknowledged / muted; stops when none are left. */
  check() {
    if (!this.ringing) return;
    for (const id of [...this.ids]) if (!this.stillRinging(id)) this.ids.delete(id);
    if (!this.ringing) this._stop();
  }

  /** Stops the siren. Returns the ids it was ringing for (to acknowledge them). */
  silence() {
    const ids = [...this.ids];
    if (ids.length || this.timer) this._stop();
    return ids;
  }

  destroy() {
    this.clearTimer(this.timer);
    this.timer = null;
    this.ids.clear();
  }

  _schedule() {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this._tick(), this.repeatMs);
  }

  _tick() {
    this.timer = null;
    this.check();
    if (!this.ringing) return;
    if (!this.repeat() || this.now() - this.since >= this.maxMs) {
      this._stop();
      return;
    }
    this.lastSiren = this.now();
    this.play('critical');
    this._schedule();
  }

  _stop() {
    this.clearTimer(this.timer);
    this.timer = null;
    this.ids.clear();
    this.since = null;
    this._changed();
  }

  _changed() {
    this.onChange?.(this.state());
  }
}
