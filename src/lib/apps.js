// Which Flobi app a request came from, read from its Referer: a browser names the page that
// made the call (usually just its origin, https://docs.flobi.ai/). No Referer means no web app
// said so: a server, a script, a link opened directly, or a live connection (a WebSocket sends
// an Origin, which the load balancer doesn't log). The Drive and Handoff phone apps (Capacitor)
// are pages on https://localhost (Android) or capacitor://localhost (iOS).

const APPS = {
  'app.flobi.ai': 'Home',
  'flobi.ai': 'Website',
  'www.flobi.ai': 'Website',
  'auth.flobi.ai': 'Sign-in',
  'flow.flobi.ai': 'Flow',
  'canvas.flobi.ai': 'Flow',
  'drive.flobi.ai': 'Drive',
  'keepr.red': 'Drive',
  'handoff.flobi.ai': 'Handoff',
  'handoff.zip': 'Handoff',
  'docs.flobi.ai': 'Notes',
  'notes.flobi.ai': 'Notes',
  'lumens.flobi.ai': 'Lumens',
  'mood.flobi.ai': 'Moodboard',
  'moodboard.flobi.ai': 'Moodboard',
  'upscale.flobi.ai': 'Upscaler',
  'projects.flobi.ai': 'Projects',
  'brands.flobi.ai': 'Brands',
  'brand.flobi.ai': 'Brands',
  'fonts.flobi.ai': 'Fonts',
  'market.flobi.ai': 'Market',
  'hub.flobi.ai': 'Market',
  'artwork.flobi.ai': 'Artwork',
  'director.flobi.ai': 'Director',
  'fabric.flobi.ai': 'Fabric',
  'admin.flobi.ai': 'Admin',
};

// Flobi's own service hosts: a page there isn't somebody's published site.
const OWN = new Set(['api', 'storage', 'collab', 'yjs', 'agents', 'ws', 'cdn', 'status', 'sites']);

/** Android's WebView marks itself "; wv)" in its user agent. */
const isWebView = (ua) => /; wv\)/.test(ua || '');

/** The host a Referer names, or null when there is none (or it isn't a web address). */
export function refererHost(referer) {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The app a Referer points at ("Notes"), a name for the kinds we know ("Published notes", "Phone
 * app"), else its host. `ua` (the user agent) tells the Android app from a local build.
 */
export function appName(referer, ua) {
  if (/^(capacitor|ionic):\/\/localhost\b/i.test(referer || '')) return 'Phone app';
  const host = refererHost(referer);
  if (!host) return null;
  if (APPS[host]) return APPS[host];
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return isWebView(ua) ? 'Phone app' : 'Local dev';
  if (host.endsWith('.docs.flobi.ai')) return 'Published notes';
  if (host.endsWith('.pages.dev')) return `Preview · ${host.split('.').slice(-3, -2)[0]}`;
  if (host.endsWith('.flobi.ai') && host.split('.').length === 3 && !OWN.has(host.split('.')[0])) return 'Published site';
  return host;
}

const cache = new WeakMap();

/** appName for a request, worked out once per request (the live list asks again as it scrolls). */
export function appOf(r) {
  if (!r) return null;
  if (!cache.has(r)) cache.set(r, appName(r.referer, r.ua));
  return cache.get(r);
}
