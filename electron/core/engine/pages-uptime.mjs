// Cloudflare Pages projects that the uptime list doesn't check yet. No Node imports:
// demo mode runs this in the browser too.

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** "flobi-market-web" → "Market web": a Pages project's name as an uptime card title. */
export function pagesTitle(name) {
  const words = String(name).replace(/^flobi[-_]?/i, '').replace(/[-_]+/g, ' ').trim() || String(name);
  return words[0].toUpperCase() + words.slice(1);
}

/**
 * Uptime checks for the Cloudflare Pages projects the configured list leaves out,
 * so every project on the Frontends page's deployments list is also checked: one
 * per project, on its first custom domain (its pages.dev address when it has none).
 * A project counts as covered when any of its domains is already checked.
 */
export function pagesUptimeTargets(pages = [], configured = []) {
  const watched = new Set(configured.map((t) => hostOf(t.url)).filter(Boolean));
  const names = new Set(configured.map((t) => String(t.name || '').toLowerCase()));
  const out = [];
  for (const p of pages || []) {
    if (!p?.name) continue;
    const custom = (p.domains || []).map((d) => String(d).toLowerCase()).filter((d) => d && !d.endsWith('.pages.dev'));
    const all = [...custom, p.subdomain && String(p.subdomain).toLowerCase()].filter(Boolean);
    if (all.some((d) => watched.has(d))) continue;
    const host = custom[0] || all[0];
    if (!host || !/^[a-z0-9.-]+$/.test(host)) continue;
    watched.add(host);
    // Two cards both called "Notes" would read as a mistake: a title that's taken becomes the address.
    const title = pagesTitle(p.name);
    const name = names.has(title.toLowerCase()) ? host : title;
    names.add(name.toLowerCase());
    out.push({ id: `pages:${p.name}`, name, url: `https://${host}/`, group: 'frontend', fromPages: p.name });
  }
  return out;
}
