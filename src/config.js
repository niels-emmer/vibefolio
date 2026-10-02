/**
 * Centralised, validated configuration loaded from environment variables.
 * All secrets come from the environment — never from source.
 */
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

function required(name, fallback) {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: expected integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

const isProd = process.env.NODE_ENV === 'production';

const adminPassword = required('ADMIN_PASSWORD');

// Refuse to boot in production with a known placeholder / dev password.
if (isProd && (adminPassword === 'change-me-to-a-long-random-password' || adminPassword.startsWith('dev-'))) {
  throw new Error(
    'ADMIN_PASSWORD is a placeholder or dev value. Set a strong password before running in production.'
  );
}

// Optional: the reverse-proxy IP to trust for X-Forwarded-For. When set, only
// that peer is trusted (closes the rate-limiter spoofing hole on shared
// networks); when empty, the immediate peer is trusted (default Express 1).
const trustProxyIp = process.env.TRUST_PROXY_IP || '';
if (trustProxyIp && isIP(trustProxyIp) === 0) {
  throw new Error(`Invalid TRUST_PROXY_IP: expected a valid IP address, got "${trustProxyIp}"`);
}

const dbPath = process.env.DB_PATH || './data/services.db';

export const config = {
  isProd,
  port: int('PORT', 3000, { min: 1, max: 65535 }),
  adminPassword,
  sessionTtlHours: int('SESSION_TTL_HOURS', 12, { min: 1, max: 24 * 30 }),
  loginRateLimit: int('LOGIN_RATE_LIMIT', 10, { min: 1, max: 10000 }),
  healthCheckInterval: int('HEALTH_CHECK_INTERVAL', 60, { min: 5, max: 3600 }),
  healthCheckTimeout: int('HEALTH_CHECK_TIMEOUT', 5000, { min: 500, max: 60000 }),
  allowPrivateHosts: process.env.HEALTH_ALLOW_PRIVATE === '1',
  trustProxyIp,
  browserlessUrl: process.env.BROWSERLESS_URL || 'http://screenshot-service:3000',
  browserlessToken: process.env.BROWSERLESS_TOKEN || '',

  // Secret used to sign the feedback form's timing token. Not a credential: it only
  // needs to be unguessable per deployment, so a random value generated once at boot
  // is fine — tokens issued before a restart are rejected after it, which is the
  // conservative direction. Set FEEDBACK_TOKEN_SECRET to keep tokens valid across
  // restarts (and across instances, if there is ever more than one).
  feedbackTokenSecret: process.env.FEEDBACK_TOKEN_SECRET || randomBytes(32).toString('hex'),
  // How long a visitor may take to fill the form before the token expires.
  feedbackTokenTtlMs: int('FEEDBACK_TOKEN_TTL_MINUTES', 60, { min: 1, max: 24 * 60 }) * 60 * 1000,
  // Minimum seconds between page load and submit. Beats bots that post instantly;
  // costs a human nothing because nobody types a real message in under 3 seconds.
  feedbackMinSeconds: int('FEEDBACK_MIN_SECONDS', 3, { min: 0, max: 120 }),
  // Submissions allowed per IP per window.
  feedbackRateLimit: int('FEEDBACK_RATE_LIMIT', 5, { min: 1, max: 1000 }),

  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  dbPath,
  // Where the pre-restore snapshots are written (see src/backup.js). Defaults to a
  // `backups` directory beside the database, which in production is the writable
  // `services-data` volume — the container's root filesystem is read-only, so anywhere
  // else would fail at the worst possible moment (mid-restore).
  backupDir: process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(dbPath)), 'backups'),
};
