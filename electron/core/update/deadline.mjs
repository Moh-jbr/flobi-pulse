// Nobody stays on an old version: an update that was offered installs itself the next time the
// app starts, or after a day at the latest, while it runs. Plain functions, covered by tests.
import { isNewer } from './release.mjs';

const MIN = 60_000;
/** How long an offered update may wait. */
export const GRACE_MS = 24 * 60 * MIN;
/** How long before it installs by itself the app says so (a countdown in the toolbar, a notification). */
export const WARN_MS = 10 * MIN;

/**
 * When an update was first offered on this computer ({ version, at }, saved in state.json). A newer
 * release while one is still waiting keeps the first date: publishing again never buys more time.
 */
export function noteSeen(prev, version, current, now) {
  const waiting = prev && Number.isFinite(prev.at) && prev.at <= now && isNewer(prev.version, current);
  return { version, at: waiting ? prev.at : now };
}

/** Whether an update offered earlier is still not installed (the app installs it as it starts). */
export const isPending = (seen, current) => !!seen && Number.isFinite(seen.at) && isNewer(seen.version, current);

/** When an offered update installs itself, at the latest. */
export const deadlineOf = (seen) => seen.at + GRACE_MS;

/**
 * Whether the last start handed an update to its installer and still runs the old version: the
 * install didn't finish (macOS put the old app back, the Windows installer stopped). Starting it
 * again at every start would download it and close the app every time.
 */
export const unfinishedHandOff = (seen, current) => !!seen?.handedOff && isNewer(seen.handedOff.version, current);

const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayStart = (t) => new Date(new Date(t).toDateString()).getTime();

/** "today at 14:05", "tomorrow at 9:30", else "on Friday at 9:30" (the toolbar, Settings, the notification). */
export function whenText(at, now = Date.now()) {
  const d = new Date(at);
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  if (days <= 0) return `today at ${clock(d)}`;
  if (days === 1) return `tomorrow at ${clock(d)}`;
  return `on ${d.toLocaleDateString([], { weekday: 'long' })} at ${clock(d)}`;
}
