// Alert sounds, made with Web Audio (no sound files).
//   warning  → a clear two-note chime, once
//   critical → a loud, harsh siren (~3 s); the main process repeats it until
//              someone acknowledges the alert
let ctx = null;
const playing = new Set(); // output nodes of sounds still playing

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** A master chain for one sound: compressor (keeps it loud but unclipped) → volume. */
function output(c, volume) {
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 6;
  comp.ratio.value = 8;
  comp.attack.value = 0.002;
  comp.release.value = 0.12;
  const vol = c.createGain();
  vol.gain.value = Math.max(0, Math.min(1, volume));
  comp.connect(vol).connect(c.destination);
  playing.add(vol);
  return { input: comp, vol };
}

function tone(c, dest, { type = 'sine', freq, to, start, dur, gain = 0.3, attack = 0.004, hold = 0, detune = 0 }) {
  const o = c.createOscillator();
  o.type = type;
  o.detune.value = detune;
  o.frequency.setValueAtTime(freq, start);
  if (to) o.frequency.exponentialRampToValueAtTime(to, start + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + attack);
  if (hold) g.gain.setValueAtTime(gain, start + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(dest);
  o.start(start);
  o.stop(start + dur + 0.05);
  return o;
}

/** Bell-like note: a fundamental plus a few quieter partials that fade faster. */
function bell(c, dest, freq, start, gain) {
  tone(c, dest, { freq, start, dur: 1.3, gain });
  tone(c, dest, { freq: freq * 2, start, dur: 0.7, gain: gain * 0.35 });
  tone(c, dest, { freq: freq * 3, start, dur: 0.35, gain: gain * 0.15 });
  tone(c, dest, { type: 'triangle', freq, start, dur: 0.25, gain: gain * 0.25 });
}

function warning(c, dest, t) {
  bell(c, dest, 784, t, 0.55); // G5
  bell(c, dest, 1047, t + 0.2, 0.55); // C6
  return 1.6;
}

function critical(c, dest, t) {
  // Take the edge off the very top so it's piercing but not painful.
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  lp.connect(dest);
  const cycle = 1.05;
  for (let i = 0; i < 3; i++) {
    const s = t + i * cycle;
    // Rising siren: two slightly detuned harsh waves beat against each other.
    tone(c, lp, { type: 'sawtooth', freq: 620, to: 1500, start: s, dur: 0.46, gain: 0.5, attack: 0.01, hold: 0.36 });
    tone(c, lp, { type: 'square', freq: 620, to: 1500, start: s, dur: 0.46, gain: 0.22, attack: 0.01, hold: 0.36, detune: 18 });
    // Four fast alternating beeps.
    for (let b = 0; b < 4; b++) {
      const bs = s + 0.5 + b * 0.13;
      tone(c, lp, { type: 'square', freq: b % 2 ? 1320 : 1760, start: bs, dur: 0.09, gain: 0.42, attack: 0.003, hold: 0.07 });
    }
  }
  return cycle * 3;
}

const SOUNDS = { warning, critical };

/** Plays a sound now. volume 0–1. Returns false if audio isn't available. */
export function playSound(kind, volume = 0.8) {
  const make = SOUNDS[kind];
  const c = audio();
  if (!make || !c) return false;
  const { input, vol } = output(c, volume);
  const len = make(c, input, c.currentTime + 0.03);
  setTimeout(() => {
    playing.delete(vol);
    try {
      vol.disconnect();
    } catch {}
  }, (len + 0.4) * 1000);
  return true;
}

/** Fades out anything still playing (e.g. the siren when the alarm is silenced). */
export function stopSounds() {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const vol of playing) {
    try {
      vol.gain.cancelScheduledValues(now);
      vol.gain.setValueAtTime(vol.gain.value, now);
      vol.gain.linearRampToValueAtTime(0, now + 0.08);
    } catch {}
  }
  playing.clear();
}
