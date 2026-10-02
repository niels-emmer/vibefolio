/**
 * Outbound email for the feedback form, over SMTP.
 *
 * Every setting is stored in the `settings` table (not the environment) so the admin
 * can change it without a redeploy. The password is the one secret in there: it is
 * write-only over the API (see `smtpPublicConfig`) and is never logged.
 *
 * Nothing here sends unless it is configured — `isConfigured()` is the gate, and
 * callers are expected to surface "not configured" to the visitor rather than
 * pretending a message was delivered.
 */
import nodemailer from 'nodemailer';
import * as store from './db.js';

// These settings are NOT part of SETTING_KEYS in public-data.js — that set is the public
// read model, and nothing here may reach the public API or the rendered pages.

// Ports offered as presets in the admin form, with the transport each implies.
//
// The protocol is tied to the port so the two cannot be configured into disagreement —
// an independent `secure` flag is how you get a STARTTLS attempt against an
// implicit-TLS port, which hangs until it times out instead of failing clearly.
//
// These are *presets*, not the only allowed values: all three are below 1024 and
// therefore need root to bind, so a hard allow-list made a local capture server
// impossible to point at and blocked providers on non-standard ports. Any port in
// 1..65535 is accepted; 465 is implicit TLS and everything else is STARTTLS-capable.
export const SMTP_PORTS = {
  465: { secure: true, label: '465 — implicit TLS (SMTPS)' },
  587: { secure: false, label: '587 — STARTTLS (submission)' },
  25: { secure: false, label: '25 — plain / STARTTLS (relay)' },
};

/** Whether a port uses implicit TLS. Only 465 does; 587/25 upgrade via STARTTLS. */
export function isImplicitTls(port) {
  return Number(port) === 465;
}

// Anything longer than this is almost certainly a paste error, and the value goes
// into a mail header — cap it so a malformed config cannot inject one.
const MAX_HEADER_LEN = 200;

export function smtpFromSettings(all) {
  return {
    host: (all.smtpHost || '').trim(),
    port: Number(all.smtpPort || 0),
    secure: all.smtpSecure === '1',
    user: (all.smtpUser || '').trim(),
    password: all.smtpPassword || '',
    from: (all.smtpFrom || '').trim(),
    to: (all.smtpTo || '').trim(),
  };
}

/**
 * A config built explicitly rather than read from the settings table.
 *
 * Exists so a caller can hand the mailer a config directly — used by the test suite to
 * reach a local stub. It is in-process only and never populated from a request.
 *
 * Note that the stored path is no longer port-restricted either (see `usable()`); this
 * seam is about supplying a config, not about bypassing a gate.
 *
 * `secure` is derived from the port via `isImplicitTls()`, the same rule the settings
 * path uses, so the two can never disagree.
 */
export function smtpConfigFor({ host, port, user = '', password = '', from = '', to = '', timeouts }) {
  const n = Number(port);
  return {
    host: String(host || '').trim(),
    port: n,
    secure: isImplicitTls(n),
    user: String(user || '').trim(),
    password: String(password || ''),
    from: String(from || '').trim(),
    to: String(to || '').trim(),
    // Marks the config as explicitly constructed rather than read from the settings
    // table. Kept so a caller can be identified in a log or a future guard; nothing
    // depends on it for permission any more.
    explicit: true,
    // Test-only override so a suite can exercise the concurrency gate without waiting
    // out the production timeouts.
    timeouts: timeouts ?? null,
  };
}

/** The settings shape the admin API may return: never includes the password. */
export function smtpPublicConfig(all) {
  const c = smtpFromSettings(all);
  return {
    host: c.host,
    port: c.port,
    secure: c.secure,
    user: c.user,
    from: c.from,
    to: c.to,
    // Write-only password: the UI needs to know one is stored (to show "unchanged"
    // and to label the Save+test button honestly) but must never receive it.
    hasPassword: c.password !== '',
  };
}

/**
 * Is there enough config to attempt a send?
 *
 * A host and a port are the minimum. Credentials are *not* required: a relay on the
 * local network often accepts mail from a known host without authentication, and
 * requiring a username/password would make that case impossible to configure.
 *
 * The port must be a real port number. It is intentionally NOT restricted to the
 * three presets: all of those are privileged ports, so a strict allow-list made a local
 * capture server unreachable and blocked providers on non-standard ports. The transport
 * still only ever speaks SMTP to the configured host, and a hostname that is not a
 * hostname is rejected below.
 */
export function isConfigured(c = smtpFromSettings(store.getAllSettings())) {
  return usable(c);
}

function usable(c) {
  if (!c.host || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return false;
  // A hostname must look like one. This is not an SSRF guard (the health checker has
  // its own) but it stops obvious nonsense like "http://host" reaching the dialer.
  if (!/^[A-Za-z0-9.-]+$/.test(c.host)) return false;
  if (c.user.length > MAX_HEADER_LEN || c.password.length > MAX_HEADER_LEN) return false;
  if (c.from.length > MAX_HEADER_LEN || c.to.length > MAX_HEADER_LEN) return false;
  return true;
}

function transportFor(c) {
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    // Only send credentials when there are some; an empty auth block makes some
    // relays reject the session outright.
    ...(c.user ? { auth: { user: c.user, pass: c.password } } : {}),
    // Bound the whole exchange: a black-holed SMTP port would otherwise hold the
    // request open until the visitor gives up.
    connectionTimeout: c.timeouts?.connection ?? 10_000,
    greetingTimeout: c.timeouts?.greeting ?? 10_000,
    socketTimeout: c.timeouts?.socket ?? 20_000,
  });
}

/**
 * Fold quoted lines, hard-wrap long ones, and normalise newlines.
 *
 * `message` is visitor input that ends up in a mail body. It is plain text, never
 * HTML, so there is no markup to escape — but:
 *
 *  - a bare "." on its own line would end the SMTP DATA block early, so it is escaped
 *    to ".." per RFC 5321 §4.5.2. nodemailer does this itself; doing it here as well is
 *    defensive, not redundant, because the submission path must not depend on that
 *    behaviour being preserved through a dependency upgrade.
 *  - NUL and the other C0 controls (except tab and newline, which have legitimate
 *    meaning in a text body) are stripped. They cannot inject anything, but they
 *    produce malformed MIME that relays and clients handle inconsistently.
 */
function normaliseBody(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // Keep \t (09) and \n (0a); drop every other C0 control and DEL.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, '')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\n')
    .trim();
}

/**
 * A one-line header value.
 *
 * Collapses CR/LF (the only characters that can terminate a header and start a new
 * one) and strips NUL plus the other C0 controls, which cannot inject anything but do
 * produce malformed MIME that downstream relays and clients handle inconsistently. JS
 * `\s` does not match NUL, so a NUL in a submitted address would otherwise survive
 * straight into the header block.
 *
 * C1 controls and U+2028/U+2029 are left alone deliberately: they are non-ASCII, so
 * nodemailer encodes them as MIME encoded-words in headers and passes them through
 * verbatim in the text body, which is correct.
 */
function headerValue(text, max = MAX_HEADER_LEN) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

export function buildFeedbackEmail({ name, email, message, siteTitle = 'vibefolio' }) {
  const from = headerValue(name, 120);
  const subject = `Feedback from ${from}`;
  const body = [
    `Name:  ${normaliseBody(from)}`,
    `Email: ${headerValue(email, 254)}`,
    '',
    normaliseBody(message),
    '',
    '—',
    `Sent from the ${headerValue(siteTitle, 80)} feedback form.`,
    'Reply directly to this message to answer.',
  ].join('\n');
  return { subject, body };
}

/**
 * Bounds how many outbound SMTP sends can be in flight at once.
 *
 * The per-IP rate limit cannot help against a distributed source, and each send holds
 * a TCP socket for up to ~30s (the connection/greeting/socket timeouts). Without a
 * global cap, a botnet spread across many IPs can open sockets until the container runs
 * out of file descriptors — which would take the whole site down, not just the form.
 *
 * A simple counting semaphore is enough here: this is a single-process app, so there is
 * no cross-process coordination to do, and the limit only needs to be small (a relay
 * would not appreciate a thundering herd either).
 *
 * A caller that cannot get a slot waits rather than being rejected — a real visitor
 * should be told "try again later" only after the queue is genuinely unreasonable, and
 * the socket timeouts already bound how long any single slot is held.
 */
const MAX_CONCURRENT_SENDS = 8;
const MAX_QUEUE_WAIT_MS = 15_000;

let inFlight = 0;
const waiting = [];

function acquire() {
  if (inFlight < MAX_CONCURRENT_SENDS) {
    inFlight += 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const entry = { resolve, timer: null };
    entry.timer = setTimeout(() => {
      const i = waiting.indexOf(entry);
      if (i !== -1) waiting.splice(i, 1);
      // Timed out waiting for a slot. The caller reports "try again later" rather than
      // pretending the message was sent.
      resolve(false);
    }, MAX_QUEUE_WAIT_MS);
    waiting.push(entry);
  });
}

function release() {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    // Hand the slot straight over rather than decrementing and re-incrementing, so a
    // waiting caller cannot be starved by a new arrival.
    next.resolve(true);
    return;
  }
  inFlight = Math.max(0, inFlight - 1);
}

/** Runs `fn` while holding one of the concurrency slots. */
async function withSendSlot(fn) {
  const got = await acquire();
  if (!got) return { ok: false, reason: 'busy', error: 'The mail queue is busy' };
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Test hook: the current concurrency state, so the bound is observable. */
export function sendConcurrency() {
  return { inFlight, waiting: waiting.length, max: MAX_CONCURRENT_SENDS };
}

/**
 * Send feedback. Returns { ok } or { ok: false, error } — never throws, so a mail
 * failure cannot take down the request or leak a stack trace to the visitor.
 */
export async function sendFeedback({ name, email, message, siteTitle, config: configOverride }) {
  const all = store.getAllSettings();
  const c = configOverride ?? smtpFromSettings(all);
  if (!usable(c)) {
    return { ok: false, reason: 'not-configured', error: 'Email delivery is not configured' };
  }

  const { subject, body } = buildFeedbackEmail({ name, email, message, siteTitle });
  // Reply-To carries the visitor's address; From stays the configured sender so the
  // message passes SPF/DKIM for the domain that actually sent it.
  const envelopeFrom = c.from || c.user;
  if (!envelopeFrom) {
    return { ok: false, reason: 'not-configured', error: 'No sender address configured' };
  }

  return withSendSlot(async () => {
    try {
      const info = await transportFor(c).sendMail({
        from: envelopeFrom,
        to: c.to || envelopeFrom,
        replyTo: headerValue(email, 254),
        subject,
        text: body,
      });
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      // Log the reason for the admin (SMTP errors are not secret), never the config.
      console.error('[feedback] send failed:', err.code || err.name || 'error', '-', err.message);
      return { ok: false, reason: 'send-failed', error: 'Could not send the message' };
    }
  });
}

/**
 * Verify the connection and credentials without sending anything. This is what the
 * admin panel's "test" action calls: it proves the host/port/TLS/auth combination is
 * right, which is the part that is actually hard to get correct.
 */
export async function verifyConnection(override) {
  const c = override ?? smtpFromSettings(store.getAllSettings());  if (!usable(c)) {
    return { ok: false, error: 'SMTP is not fully configured (host and port are required)' };
  }
  try {
    await transportFor(c).verify();
    return { ok: true };
  } catch (err) {
    console.error('[feedback] smtp verify failed:', err.code || err.name || 'error', '-', err.message);
    // Surface the server's own reason: it is the difference between "wrong password"
    // and "wrong port" for the person fixing it, and it is not a secret.
    return { ok: false, error: err.message || 'Connection failed' };
  }
}

/**
 * Send a real test message to a given address. Separate from `verifyConnection`
 * because a successful handshake does not prove the message is deliverable — relays
 * and spam filters can still swallow it.
 */
export async function sendTest(toOverride, configOverride) {
  const c = configOverride ?? smtpFromSettings(store.getAllSettings());
  if (!usable(c)) {
    return { ok: false, error: 'SMTP is not fully configured (host and port are required)' };
  }
  const envelopeFrom = c.from || c.user;
  if (!envelopeFrom) return { ok: false, error: 'No sender address configured' };

  const to = (toOverride || c.to || envelopeFrom).trim();
  if (!to) return { ok: false, error: 'No recipient address configured' };

  return withSendSlot(async () => {
    try {
      const info = await transportFor(c).sendMail({
        from: envelopeFrom,
        to,
        subject: 'Feedback form test message',
        text: [
          'This is a test message from the vibefolio feedback form.',
          '',
          `Sent: ${new Date().toISOString()}`,
          `Via:  ${c.host}:${c.port} (${c.secure ? 'implicit TLS' : 'STARTTLS'})`,
          '',
          'If you received this, feedback delivery is working.',
        ].join('\n'),
      });
      return { ok: true, messageId: info.messageId, to };
    } catch (err) {
      console.error('[feedback] test send failed:', err.code || err.name || 'error', '-', err.message);
      return { ok: false, error: err.message || 'Could not send the test message' };
    }
  });
}
