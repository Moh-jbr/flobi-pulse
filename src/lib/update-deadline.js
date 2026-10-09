// How the app says when an offered update installs itself (electron/core/update/deadline.mjs).
import { whenText } from '../../electron/core/update/deadline.mjs';

export { whenText };

const pad = (n) => String(n).padStart(2, '0');

/** What is left before it installs, as a clock: "9:05", never below "0:00". */
export function countdown(at, now = Date.now()) {
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** The sentence under an offered update: when it installs by itself. */
export function deadlineSentence(at, now = Date.now()) {
  return at ? `It installs itself the next time Flobi Pulse starts, or ${whenText(at, now)} at the latest.` : '';
}

/** Said after a try at installing by itself failed: when it tries again. */
export const retrySentence = (nextTry, now = Date.now()) => (nextTry ? `Flobi Pulse tries again by itself ${whenText(Math.max(nextTry, now), now)}.` : '');
