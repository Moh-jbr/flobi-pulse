// Which OS the app runs on, in one place. The preload passes it (window.pulse.platform);
// store.connect() copies it onto <html data-platform> before anything renders; the
// browser preview guesses from the user agent.

export function platform() {
  return document.documentElement.dataset.platform || window.pulse?.platform || (/Mac/.test(navigator.userAgent) ? 'darwin' : /Windows/.test(navigator.userAgent) ? 'win32' : 'linux');
}

export const isMac = () => platform() === 'darwin';
export const isWindows = () => platform() === 'win32';

/** A keyboard shortcut as the OS writes it: "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function shortcut(key) {
  return isMac() ? `⌘${key}` : `Ctrl+${key}`;
}
