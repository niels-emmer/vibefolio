import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { config } from './config.js';
import * as store from './db.js';

/**
 * Periodic health checker.
 * For each enabled service, issues a HEAD request (falling back to GET on
 * method-related failures) with a timeout and records the resulting status
 * ('up' | 'down' | 'unknown') plus latency.
 *
 * SSRF protection: target hostnames are resolved ONCE and the connection is
 * pinned to the validated address (no second DNS resolution — closes the
 * DNS-rebinding TOCTOU window). Private, loopback, link-local or reserved
 * addresses are rejected (unless HEALTH_ALLOW_PRIVATE=1), including
 * IPv4-mapped/compatible IPv6 forms and 6to4/Teredo. Redirects are followed
 * manually, each hop re-validated, capped at 5.
 */

const MAX_REDIRECTS = 5;
// A HEAD request may legitimately be rejected by servers that only accept GET.
const HEAD_RETRY_STATUSES = new Set([400, 401, 403, 404, 405, 406, 501]);

export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
      a >= 224 // multicast + reserved
    );
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // 6to4 (2002::/16) and Teredo (2001:0000::/32) embed IPv4 — treat as unsafe.
    if (lower.startsWith('2002:') || lower.startsWith('2001:0000:')) return true;
    // IPv4-mapped (::ffff:a.b.c.d / ::ffff:xxxx:xxxx) and IPv4-compatible
    // (::a.b.c.d / ::xxxx:xxxx) forms embed an IPv4 in the last 32 bits.
    const embedded = embeddedIpv4(lower);
    if (embedded) return isPrivateAddress(embedded);
    if (lower.startsWith('::ffff:')) return true; // unparseable mapped form — fail closed
    return false;
  }
  return false;
}

/** Extracts an embedded IPv4 from IPv4-mapped / IPv4-compatible IPv6 forms, or null. */
function embeddedIpv4(lower) {
  // ::ffff:a.b.c.d | ::a.b.c.d | 0:…:ffff:a.b.c.d | 0:…:a.b.c.d (dotted)
  let m = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (m) return m[1];
  m = /^(?:0:){0,6}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (m) return m[1];
  // ::ffff:xxxx:xxxx | ::xxxx:xxxx | 0:…:ffff:xxxx:xxxx | 0:…:xxxx:xxxx (hex pairs)
  m = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (m) return hextetsToIpv4(m[1], m[2]);
  m = /^(?:0:){0,6}(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (m) return hextetsToIpv4(m[1], m[2]);
  return null;
}

function hextetsToIpv4(a, b) {
  const x = parseInt(a, 16);
  const y = parseInt(b, 16);
  return `${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`;
}

/**
 * Resolves the URL's hostname and validates every address. Returns the first
 * address to connect to. Throws if the host is private (when not allowed) or
 * unresolvable.
 */
async function resolveValidatedIp(url, allowPrivate) {
  const hostname = url.hostname;
  const results = await dns.lookup(hostname, { all: true });
  if (results.length === 0) throw new Error(`no records for ${hostname}`);
  if (!allowPrivate && results.some((r) => isPrivateAddress(r.address))) {
    throw new Error(`refusing to check private host: ${hostname}`);
  }
  return results[0]; // { address, family }
}

/**
 * Throws if the URL's hostname resolves to a private / loopback / reserved
 * address and private hosts are not explicitly allowed.
 */
export async function assertPublicHost(url, allowPrivate = config.allowPrivateHosts) {
  await resolveValidatedIp(url, allowPrivate);
}

/**
 * Issues a single request pinned to the pre-validated address via a custom
 * `lookup` — the hostname is never resolved a second time.
 */
function requestOnce(url, method, timeoutMs, lookup) {
  return new Promise((resolve) => {
    const started = Date.now();
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method,
        headers: { 'User-Agent': 'vibefolio-healthcheck/1.0' },
        lookup,
      },
      (res) => {
        resolve({ res, latency: Date.now() - started });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ error: err, latency: Date.now() - started }));
    req.end();
  });
}

export async function checkUrl(rawUrl, timeoutMs, opts = {}) {
  const allowPrivate = opts.allowPrivate ?? config.allowPrivateHosts;
  const overallStart = Date.now();
  let current;
  try {
    current = new URL(rawUrl);
  } catch {
    return { status: 'down', latency: 0 };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let resolved;
    try {
      resolved = await resolveValidatedIp(current, allowPrivate);
    } catch {
      // SSRF-protected / unresolvable host: don't probe; mark as unknown.
      return { status: 'unknown', latency: 0 };
    }

    // Pin the connection to the validated address — no second DNS resolution.
    // Node's autoSelectFamily calls the lookup with `all: true` and expects an
    // array of { address, family } objects; handle both call styles.
    const lookup = (hostname, options, callback) => {
      if (options.all) {
        callback(null, [{ address: resolved.address, family: resolved.family }]);
      } else {
        callback(null, resolved.address, resolved.family);
      }
    };

    let method = 'HEAD';
    for (let attempt = 0; attempt < 2; attempt++) {
      const { res, error, latency } = await requestOnce(current, method, timeoutMs, lookup);

      // Network / TLS / timeout failure — treat as down.
      if (error || !res) return { status: 'down', latency };

      if (res.statusCode >= 300 && res.statusCode < 400) {
        const loc = res.headers.location;
        if (!loc) return { status: 'down', latency };
        try {
          current = new URL(loc, current);
        } catch {
          return { status: 'down', latency };
        }
        break; // follow the redirect in the outer loop
      }

      const ok = res.statusCode >= 200 && res.statusCode < 400;
      if (ok) return { status: 'up', latency };

      if (method === 'HEAD' && HEAD_RETRY_STATUSES.has(res.statusCode)) {
        method = 'GET';
        continue;
      }
      return { status: 'down', latency };
    }
  }

  return { status: 'down', latency: Date.now() - overallStart };
}

export async function runHealthCheck() {
  const services = store.listServices({ includeDisabled: false });
  await Promise.all(
    services.map(async (svc) => {
      const { status, latency } = await checkUrl(svc.url, config.healthCheckTimeout);
      store.updateServiceStatus(svc.id, status, latency);
    })
  );
}

export function startHealthChecker() {
  runHealthCheck().catch((err) => console.error('[health] initial check failed:', err));
  const timer = setInterval(() => {
    runHealthCheck().catch((err) => console.error('[health] check failed:', err));
  }, config.healthCheckInterval * 1000);
  timer.unref();
  return timer;
}
