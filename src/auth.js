import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';

const COOKIE_NAME = 'sid';
const SESSION_TTL_MS = config.sessionTtlHours * 60 * 60 * 1000;

/**
 * Session-based authentication.
 * - Login verifies the admin password (constant-time compare).
 * - A random session token is stored in the DB and set as an httpOnly,
 *   SameSite=Strict cookie. SameSite=Strict blocks cross-site cookie sending,
 *   which is the primary CSRF defence; we add an Origin check as belt-and-braces.
 */

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Fixed-length digest of the admin password. Used for constant-time compare
// (independent of password length) and to invalidate sessions on rotation.
function passwordHash() {
  return crypto.createHash('sha256').update(config.adminPassword).digest('hex');
}

export function verifyPassword(password) {
  // Compare digests, not raw strings: timingSafeEqual on fixed-length inputs
  // leaks nothing about the password length.
  return timingSafeEqual(
    crypto.createHash('sha256').update(String(password)).digest('hex'),
    passwordHash()
  );
}

export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  store.createSession(token, SESSION_TTL_MS, passwordHash());
  return token;
}

export function destroySession(token) {
  if (token) store.deleteSession(token);
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProd,
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function getSessionToken(req) {
  return req.cookies?.[COOKIE_NAME] || null;
}

/** Express middleware: require a valid session for admin routes. */
export function requireAuth(req, res, next) {
  const token = getSessionToken(req);
  const session = token ? store.getSession(token) : null;
  // Reject sessions created under a different admin password (rotation).
  if (!session || session.pw_hash !== passwordHash()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.sessionToken = token;
  next();
}

/**
 * CSRF defence-in-depth: reject state-changing requests whose Origin header
 * is present and not allowed. SameSite=Strict already prevents cross-site
 * cookie sending; this blocks requests that somehow carry a cookie.
 * Allowed origins = the configured allow-list, plus same-origin requests.
 */
export function originCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const origin = req.headers.origin;
  if (!origin) {
    // Browsers always send Origin on state-changing requests. A request that
    // carries a session cookie but no Origin is not a browser — reject it.
    // (Non-browser clients without a session, e.g. curl login, still pass
    // through to requireAuth which returns 401.)
    if (getSessionToken(req)) {
      return res.status(403).json({ error: 'Origin required' });
    }
    return next();
  }
  const allowed = new Set(config.allowedOrigins);
  if (allowed.has(origin)) return next();
  // Same-origin requests are always allowed (Origin matches the request host).
  try {
    const o = new URL(origin);
    const host = req.headers.host;
    if (host && o.host === host) return next();
  } catch {
    /* fall through to reject */
  }
  console.error('[auth] origin rejected', {
    method: req.method,
    path: req.originalUrl,
    origin: req.headers.origin,
    host: req.headers.host,
  });
  return res.status(403).json({ error: 'Origin not allowed' });
}
