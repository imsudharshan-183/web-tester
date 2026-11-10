const dns = require('dns').promises;
const net = require('net');

// Only these staging hosts may be targeted. Any other host is a hard refusal.
const ALLOWED_STAGING_HOSTS = new Set([
  'inventcarepm-landing-staging.azurewebsites.net',
  'invent-ui.vercel.app',
  'inventcarepm-staging.azurewebsites.net',
]);

// Validate a URL and block local, private, and non-http(s) addresses.
// Shared by the runs and sites routes so both apply the same rules.
async function validateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: 'Please paste a website link.' };
  }

  let candidate = rawUrl.trim();
  // Automatically add https:// if protocol was omitted
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: 'Please provide a valid http or https URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https links are allowed.' };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // Hard environment guardrail: refuse anything not explicitly allowlisted.
  if (!ALLOWED_STAGING_HOSTS.has(hostname.toLowerCase())) {
    return {
      ok: false,
      error:
        'Target host is not on the approved staging allowlist. If this is intentional, add it explicitly.',
    };
  }

  if (isPrivateHostname(hostname)) {
    return {
      ok: false,
      error: 'That address is local or private. Only public websites are allowed.',
    };
  }

  // If a domain name resolves to a private address, block it too.
  if (!net.isIP(hostname)) {
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      if (addresses.some((entry) => isPrivateIp(entry.address))) {
        return {
          ok: false,
          error: 'That address is local or private. Only public websites are allowed.',
        };
      }
    } catch {
      // A domain that does not resolve will fail during the run instead.
    }
  }

  return { ok: true, url: parsed.href };
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;

  return isPrivateIp(host);
}

// Covers IPv4 private ranges plus common IPv6 local ranges.
function isPrivateIp(address) {
  const ip = address.replace(/^\[|\]$/g, '');

  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (net.isIP(ip) === 6) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return false;

    // :: (unspecified) and ::1 (loopback)
    if (bytes.every((byte) => byte === 0)) return true;
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;

    // fc00::/7 (unique local) and fe80::/10 (link-local)
    if ((bytes[0] & 0xfe) === 0xfc) return true;
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;

    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses.
    const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0);
    const firstTwelveZero = bytes.slice(0, 12).every((byte) => byte === 0);

    if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
      return isPrivateIp(bytes.slice(12).join('.'));
    }
    if (firstTwelveZero) {
      return isPrivateIp(bytes.slice(12).join('.'));
    }
  }

  return false;
}

// Turn an IPv6 address into 16 bytes so ranges are easy to check.
function ipv6ToBytes(address) {
  let value = address.toLowerCase().split('%')[0];

  // Convert an ending like 127.0.0.1 into two hex groups.
  const ipv4Ending = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Ending) {
    const parts = ipv4Ending[1].split('.').map(Number);
    const hex = `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
    value = value.slice(0, -ipv4Ending[1].length) + hex;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;

  const groups = [...left, ...Array(missing).fill('0'), ...right];
  const bytes = [];

  for (const group of groups) {
    const number = parseInt(group, 16);
    if (Number.isNaN(number) || number < 0 || number > 0xffff) return null;
    bytes.push(number >> 8, number & 0xff);
  }

  return bytes.length === 16 ? bytes : null;
}

module.exports = { validateUrl, isPrivateIp, ALLOWED_STAGING_HOSTS };
