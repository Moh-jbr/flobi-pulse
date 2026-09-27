// A tiny global store (no library): sections from the main process, ring
// buffers for the live streams, navigation, inspector and toasts.
import { useSyncExternalStore } from 'react';
import { playSound, stopSounds } from './sounds.js';

const listeners = new Set();
let state = {
  ready: false,
  info: null,
  sections: {},
  nav: { view: 'overview', params: {} },
  inspector: null, // { type, id, data }
  toasts: [],
  alarm: null, // { ringing, ids, titles, since } while the critical siren repeats
  trafficVersion: 0,
  logsVersion: 0,
  palette: false,
  recapOpen: false,
  versions: null, // the Versions page (the team's GitHub releases)
  update: null, // app update: { status: idle|checking|available|downloading|installing|error|unsupported, version, progress, error }
  bridgeError: null,
};

export const traffic = []; // newest last
export const logs = [];
/** How many requests / log lines have arrived in total (for "N new" counters). */
export const received = { traffic: 0, logs: 0 };
const TRAFFIC_CAP = 6000;
const LOGS_CAP = 20000;

export let bridge = null;
const followHandlers = new Map();
// Lines/status that arrive before the view has registered its handler (the
// stream starts sending right away) wait here instead of being dropped.
const followPending = new Map();

function emit() {
  for (const l of listeners) l();
}

export function getState() {
  return state;
}

export function setState(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  emit();
}

function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore(selector) {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const useSection = (name) => useStore((s) => s.sections[name]);

// Batch stream updates into one render per animation frame.
let streamScheduled = false;
let pendingTraffic = 0;
let pendingLogs = 0;
function scheduleStream() {
  if (streamScheduled) return;
  streamScheduled = true;
  requestAnimationFrame(() => {
    streamScheduled = false;
    setState((s) => ({ trafficVersion: s.trafficVersion + (pendingTraffic ? 1 : 0), logsVersion: s.logsVersion + (pendingLogs ? 1 : 0) }));
    pendingTraffic = pendingLogs = 0;
  });
}

function pushRing(arr, items, cap) {
  for (const it of items) arr.push(it);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

export async function connect(getBridge) {
  try {
    bridge = await getBridge();
  } catch (e) {
    setState({ bridgeError: e.message });
    return;
  }
  document.documentElement.dataset.platform = bridge.platform;
  bridge.on((m) => {
    switch (m.t) {
      case 'state':
        setState((s) => ({ sections: { ...s.sections, ...m.sections } }));
        break;
      case 'stream':
        if (m.traffic?.length) {
          pushRing(traffic, m.traffic, TRAFFIC_CAP);
          pendingTraffic += m.traffic.length;
          received.traffic += m.traffic.length;
        }
        if (m.logs?.length) {
          pushRing(logs, m.logs, LOGS_CAP);
          pendingLogs += m.logs.length;
          received.logs += m.logs.length;
        }
        scheduleStream();
        break;
      case 'session':
        if (m.info.mode === 'signed-out') {
          traffic.length = 0;
          logs.length = 0;
          setState({ info: m.info, sections: {}, inspector: null });
        } else setState({ info: m.info });
        break;
      case 'nav':
        navigate(m.to);
        break;
      case 'toast':
        toast(m.alert);
        break;
      case 'sound':
        playSound(m.kind, m.volume);
        break;
      case 'sound-stop':
        stopSounds();
        break;
      case 'update':
        setState({ update: m.update });
        break;
      case 'versions':
        setState({ versions: m.versions });
        break;
      case 'alarm':
        setState({ alarm: m.alarm?.ringing ? m.alarm : null });
        if (!m.alarm?.ringing) stopSounds();
        break;
      case 'follow': {
        const h = followHandlers.get(m.id);
        if (h) h(m);
        else {
          const list = followPending.get(m.id) || [];
          list.push(m);
          followPending.set(m.id, list.slice(-50));
          setTimeout(() => followPending.delete(m.id), 15_000);
        }
        break;
      }
      default:
    }
  });
  const info = await bridge.invoke('app:hello');
  setState({ info, ready: true, update: info.update || null, versions: info.versions || null });
  bridge
    .invoke('alarm:state')
    .then((a) => setState({ alarm: a?.ringing ? a : null }))
    .catch(() => {});
}

export function invoke(cmd, args) {
  return bridge.invoke(cmd, args);
}

/** fn receives { lines } batches and { status, message } updates for one log stream. */
export function onFollow(id, fn) {
  followHandlers.set(id, fn);
  for (const m of followPending.get(id) || []) fn(m);
  followPending.delete(id);
  return () => followHandlers.delete(id);
}

// ── Navigation ───────────────────────────────────────────────────────────────
export const VIEWS = ['overview', 'recent', 'traffic', 'errors', 'crashes', 'logs', 'events', 'infrastructure', 'database', 'frontends', 'timeline', 'versions', 'settings'];

/** to: { to: view | 'service' | 'pod' | ..., id?, filter?, ... } */
export function navigate(to) {
  if (!to) return;
  if (typeof to === 'string') to = { to };
  const t = to.to;
  if (t === 'service') {
    setState({ nav: { view: 'overview', params: {} }, inspector: { type: 'service', id: to.id } });
  } else if (t === 'pod') {
    setState((s) => ({ nav: s.nav.view === 'crashes' ? s.nav : { view: 'overview', params: {} }, inspector: { type: 'pod', id: to.id } }));
  } else if (t === 'alerts') {
    setState({ nav: { view: 'crashes', params: {} } });
  } else if (VIEWS.includes(t)) {
    const { to: _v, id, ...params } = to;
    setState({ nav: { view: t, params: { ...params, id, at: Date.now() } }, inspector: t === 'crashes' && id ? { type: 'crash', id } : t === 'errors' && id ? { type: 'error', id } : null });
  }
}

export function inspect(type, id, data) {
  setState({ inspector: type ? { type, id, data } : null });
}

// ── Toasts ───────────────────────────────────────────────────────────────────
let toastSeq = 0;
export function toast(alert) {
  const id = `t${++toastSeq}`;
  // The alert's own id must not replace the toast id (it would never auto-dismiss).
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { ...alert, alertId: alert.id, id }] }));
  setTimeout(() => dismissToast(id), alert.severity === 'critical' ? 9000 : 6000);
}
/** Stops the critical siren and acknowledges what it was ringing for. */
export function silenceAlarm() {
  stopSounds();
  setState({ alarm: null });
  return bridge.invoke('alarm:silence').catch(() => {});
}

export function dismissToast(id) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
