/**
 * The feedback form's timing token.
 *
 * A stateless, signed `issuedAt` value that the browser echoes back on submit. It
 * gives two bot defences with no server-side state and no third-party service:
 *
 *   1. **Too fast** — a submission that arrives before `feedbackMinSeconds` had
 *      elapsed since the form was served is not a human filling in a message.
 *   2. **Expired** — a token older than `feedbackTokenTtlMs` is refused, which caps
 *      how long a harvested token stays reusable.
 *
 * It is deliberately NOT a CSRF token and carries no session: the endpoint is public,
 * so there is nothing to protect. It only raises the cost of automated submission.
 *
 * Format: `<issuedAtMs>.<hmac>` — the timestamp is in the clear (it is not a secret),
 * the MAC is what makes it unforgeable.
 */
import crypto from 'node:crypto';
import { config } from './config.js';

function sign(issuedAt) {
  return crypto
    .createHmac('sha256', config.feedbackTokenSecret)
    .update(String(issuedAt))
    .digest('base64url');
}

export function issueToken(now = Date.now()) {
  return `${now}.${sign(now)}`;
}

// Constant-time compare of two base64url MACs. Length is fixed by construction, but
// guard it anyway so a malformed token cannot throw.
function macEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Validate a token. Returns a reason rather than a bare boolean so the caller can log
 * which defence fired without telling the visitor.
 *
 * @returns {{ ok: true, ageMs: number } | { ok: false, reason: 'missing'|'malformed'|'bad-signature'|'too-fast'|'expired' }}
 */
export function checkToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token === '') return { ok: false, reason: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [rawIssued, mac] = parts;

  if (!/^\d{1,15}$/.test(rawIssued)) return { ok: false, reason: 'malformed' };
  const issuedAt = Number(rawIssued);

  // Signature first: nothing about the timestamp is trustworthy until the MAC checks
  // out, or an attacker could probe the timing/expiry rules for free.
  if (!macEquals(mac, sign(issuedAt))) return { ok: false, reason: 'bad-signature' };

  // A future timestamp means a mangled or replayed clock — treat as malformed rather
  // than letting it disable the too-fast check.
  if (issuedAt > now + 60_000) return { ok: false, reason: 'malformed' };

  const ageMs = now - issuedAt;
  if (ageMs < config.feedbackMinSeconds * 1000) return { ok: false, reason: 'too-fast' };
  if (ageMs > config.feedbackTokenTtlMs) return { ok: false, reason: 'expired' };

  return { ok: true, ageMs };
}
