/**
 * Public feedback intake.
 *
 * This is the only unauthenticated write endpoint in the app, so it is built
 * defensively and on purpose:
 *
 *  - **Bounded input.** Every field has a hard length cap in validate.js; the route
 *    body limit is tightened to 16kb (the global 500kb is for thumbnail uploads).
 *  - **No persistence.** Nothing is written to the database. Feedback is emailed and
 *    forgotten, so a successful bot run cannot fill a table or grow the DB.
 *  - **Layered bot checks.** Honeypot, signed timing token, per-IP rate limit. Each
 *    is independent; a bot has to pass all three.
 *  - **Uniform answers.** A tripped honeypot, a bad token and a rate limit all return
 *    the same generic message, so probing cannot tell an attacker which check fired.
 *  - **No enumeration.** The reply never echoes the submitted address or any internal
 *    error, and a failure to send is reported honestly rather than as a success.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import * as mailer from '../mailer.js';
import { validateFeedback } from '../validate.js';
import { checkToken, issueToken } from '../feedback-token.js';
import { feedbackEnabled, publicSettings } from '../public-data.js';

const router = Router();

// Per-IP throttle on submissions. Behind nginx-proxy-manager the real client IP depends
// on `trust proxy` being set to the proxy container, which src/server.js does.
const feedbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.feedbackRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // A generic body: the status code already tells the visitor to slow down, and the
  // message must not reveal whether the limit is global or per-IP.
  message: { ok: false, error: 'Too many messages. Please try again later.' },
});

// The token endpoint gets its own, much larger budget.
//
// It must not share the submission limit: every real submission costs one token fetch
// plus one post, so a shared budget would halve the effective allowance, and a visitor
// whose token expired could not obtain a new one — refreshToken() would hit the same
// exhausted limiter and fail silently. Sharing buys nothing either, because a token is
// valid for its whole TTL rather than single-use, so the POST limit is what actually
// bounds submissions.
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.feedbackRateLimit * 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please try again later.' },
});

// The one response used whenever we refuse without wanting to say why.
const GENERIC_REFUSAL = {
  ok: false,
  error: 'Sorry — that submission could not be accepted. Please try again.',
};

function clientIp(req) {
  // `req.ip` honours the trust-proxy configuration; fall back to the socket.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// --- Form token ------------------------------------------------------------

/**
 * Hands the page a signed timestamp to echo back on submit. Cheap, public, and
 * rate-limited with its own generous budget so a submission's two requests cannot
 * exhaust it.
 *
 * Gated on the feature being enabled, for consistency with /feedback 404ing: if the
 * feature is off, not even a token should be obtainable. Leaving it open leaked a small
 * but unnecessary surface — the endpoint existed and answered while the page it belongs
 * to claimed not to exist.
 */
router.get('/feedback/token', tokenLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!feedbackEnabled()) {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  res.json({ token: issueToken() });
});

// --- Submission ------------------------------------------------------------

router.post('/feedback', feedbackLimiter, async (req, res) => {
  // Reserved for the test suite: see the `options` note where it is used below.
  const options = req.app.locals.feedbackTestOptions;
  // The feature is opt-in. Checked first so a disabled form cannot be used to send
  // mail even by someone who still has an old copy of the page open.
  if (!feedbackEnabled()) {
    return res.status(503).json({ ok: false, error: 'Feedback is not available right now.' });
  }

  // 1. Signature and timing, before anything else — cheapest check, and it rejects
  //    the bulk of automated traffic without touching validation or SMTP.
  const token = checkToken(req.body?.token);
  if (!token.ok) {
    console.warn(`[feedback] rejected (${token.reason}) from ${clientIp(req)}`);
    return res.status(400).json(GENERIC_REFUSAL);
  }

  // 2. Shape of the submission. Field-level errors ARE returned here: this is a real
  //    visitor being helped, and the form surfaces them inline.
  const { ok, errors, value, honeypotTripped } = validateFeedback(req.body ?? {});
  if (honeypotTripped) {
    // A bot filled the hidden field. Answer 200 with a success-shaped body so it has
    // nothing to learn, and log the IP so the pattern is visible to the admin.
    console.warn(`[feedback] honeypot tripped from ${clientIp(req)}`);
    return res.json({ ok: true, message: 'Thanks — your message has been sent.' });
  }
  if (!ok) {
    return res.status(400).json({ ok: false, error: errors.join('; ') });
  }

  // 3. Delivery. `sendFeedback` never throws; it reports why it failed.
  //
  // `mailerConfig` is an in-process seam for the test suite (see mailer.smtpConfigFor).
  // It is not read from the request body — doing that would let a visitor point the
  // transport at an arbitrary host and turn this endpoint into an SSRF probe.
  const result = await mailer.sendFeedback({
    name: value.name,
    email: value.email,
    message: value.message,
    // The email's "Sent from …" line names the site the visitor was on. The
    // configured site title when there is one; the app name otherwise.
    siteTitle: publicSettings().siteTitle || 'vibefolio',
    config: options?.mailerConfig,
  });

  if (!result.ok) {
    // Deliberately an honest failure. The alternative — answering "thanks" when nothing
    // was delivered — loses the visitor's message silently, which is worse than telling
    // them it is not working.
    console.error(`[feedback] delivery failed (${result.reason}) from ${clientIp(req)}`);
    // 503 covers "not configured" and "too busy" (both transient, both the server's
    // problem); 502 means we tried to send and the mail server refused.
    const status = result.reason === 'send-failed' ? 502 : 503;
    const message =
      result.reason === 'send-failed'
        ? 'Your message could not be sent. Please try again later.'
        : 'Feedback is not available right now. Please try again later.';
    return res.status(status).json({ ok: false, error: message });
  }

  // Log the outcome without the message body: enough to confirm delivery happened,
  // nothing that stores what the visitor wrote.
  console.log(`[feedback] delivered from ${clientIp(req)} (id ${result.messageId})`);
  res.json({ ok: true, message: 'Thanks — your message has been sent.' });
});

export default router;
