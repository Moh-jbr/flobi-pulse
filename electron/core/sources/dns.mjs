// DNS lookups for the domains on a certificate Google couldn't issue, to tell
// why: the domain points at Cloudflare (which serves its own certificate), or
// it has no address at all (nothing uses it). Read-only; uses the computer's
// normal DNS resolver, no HTTP requests.
import dns from 'node:dns';

// Cloudflare's published ranges: https://www.cloudflare.com/ips/
const CF_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CF_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

function v4ToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

function inV4(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

function v6Groups(ip) {
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? new Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
}

function inV6(ip, cidr) {
  const [base, bitsS] = cidr.split('/');
  let bits = Number(bitsS);
  const a = v6Groups(ip);
  const b = v6Groups(base);
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const take = Math.min(16, bits);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

export function isCloudflareIp(ip) {
  return ip.includes(':') ? CF_V6.some((c) => inV6(ip, c)) : CF_V4.some((c) => inV4(ip, c));
}

/** → { addresses, none, cloudflare } */
export async function lookupDomain(domain, lookup = dns.promises.lookup) {
  try {
    const res = await lookup(domain, { all: true });
    const addresses = res.map((r) => r.address);
    return { addresses, none: addresses.length === 0, cloudflare: addresses.length > 0 && addresses.every(isCloudflareIp) };
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA' || e.code === 'EAI_NONAME' || e.code === 'EAI_NODATA') return { addresses: [], none: true, cloudflare: false };
    return null; // resolver trouble: unknown, try again later
  }
}
