import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import * as store from '../db.js';
import {
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
} from '../auth.js';
import { validateService, validateSettings, validatePageText, validateCredit, validateSmtpSettings, isPngDataUrl, isThumbDataUrl, isWallpaperDataUrl, pngDataUrlToBase64 } from '../validate.js';
import * as publicData from '../public-data.js';
import * as mailer from '../mailer.js';
import { settingsFrom } from '../public-data.js';

const router = Router();

// Session-scoped responses: never let an intermediary (or the browser's disk
// cache) store anything from the admin API. Applied before the routes so it also
// covers the unauthenticated login/logout/401 responses.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Brute-force protection on the login endpoint.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.loginRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

// Settings are stored as strings; booleans are '1'/'0' (default true when
// missing). The key list + mapping live in ../public-data.js so the admin
// endpoint, /api/site and the server-rendered homepage cannot drift apart.

/**
 * Resolves the optional `iconImage` from a service create/update body.
 * Returns the base64 payload to store, `store.ICON_KEEP` (update, unchanged),
 * or `null` (clear). On a validation error it sends a 400 and returns `false`.
 */
function resolveIconImage(body, res, { keep = false } = {}) {
  if (body.iconImage === undefined) {
    return keep ? store.ICON_KEEP : null;
  }
  if (body.iconImage === null) return null; // explicitly clear
  if (typeof body.iconImage === 'string' && isPngDataUrl(body.iconImage)) {
    return pngDataUrlToBase64(body.iconImage);
  }
  res.status(400).json({ error: 'iconImage must be a PNG data URL' });
  return false;
}

// --- Auth -----------------------------------------------------------------

router.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body ?? {};
  if (typeof password !== 'string' || !verifyPassword(password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = createSession();
  setSessionCookie(res, token);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  destroySession(req.cookies?.sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ authenticated: true });
});

// Everything below requires a valid session.
router.use(requireAuth);

// --- Services -------------------------------------------------------------

router.get('/services', (req, res) => {
  res.json({ services: store.listServices() });
});

router.post('/services', (req, res) => {
  const body = req.body ?? {};
  const { ok, errors, value } = validateService(body);
  if (!ok) return res.status(400).json({ error: errors.join('; ') });
  const iconImage = resolveIconImage(body, res);
  if (iconImage === false) return;
  const svc = store.createService({ ...value, iconImage });
  res.status(201).json({ service: svc });
});

// The complete new ordering from a drag in the admin panel (see D23). Registered before
// `/services/:id` so "order" is not read as an id — Express matches in registration order.
// Partial, duplicate or unknown ids are refused with 409 rather than half-applied.
router.put('/services/order', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id))) {
    return res.status(400).json({ error: 'ids must be an array of service ids' });
  }
  const services = store.reorderServices(ids);
  if (!services) {
    return res.status(409).json({ error: 'The order must list every service exactly once' });
  }
  res.json({ services });
});

router.put('/services/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const body = req.body ?? {};
  const { ok, errors, value } = validateService(body);
  if (!ok) return res.status(400).json({ error: errors.join('; ') });
  const iconImage = resolveIconImage(body, res, { keep: true });
  if (iconImage === false) return;
  const svc = store.updateService(id, { ...value, iconImage });
  if (!svc) return res.status(404).json({ error: 'Service not found' });
  res.json({ service: svc });
});

router.delete('/services/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const deleted = store.deleteService(id);
  if (!deleted) return res.status(404).json({ error: 'Service not found' });
  res.json({ ok: true });
});

// Update only a service's uploaded icon (auto-save from the form).
router.put('/services/:id/icon', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const { iconImage } = req.body ?? {};
  let resolved;
  if (iconImage === null) {
    resolved = null;
  } else if (typeof iconImage === 'string' && isPngDataUrl(iconImage)) {
    resolved = pngDataUrlToBase64(iconImage);
  } else {
    return res.status(400).json({ error: 'iconImage must be a PNG data URL or null' });
  }
  const svc = store.updateService(id, { iconImage: resolved });
  if (!svc) return res.status(404).json({ error: 'Service not found' });
  res.json({ service: svc });
});

// --- Thumbnails ------------------------------------------------------------

// Manual thumbnail upload (auto-save from the form).
router.put('/services/:id/thumbnail', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const { thumbnailImage } = req.body ?? {};
  let resolved;
  if (thumbnailImage === null) {
    resolved = null;
  } else if (typeof thumbnailImage === 'string' && isThumbDataUrl(thumbnailImage)) {
    resolved = pngDataUrlToBase64(thumbnailImage);
  } else {
    return res.status(400).json({ error: 'thumbnailImage must be a PNG data URL or null' });
  }
  const svc = store.updateService(id, { thumbnailImage: resolved });
  if (!svc) return res.status(404).json({ error: 'Service not found' });
  res.json({ service: svc });
});

// Capture a thumbnail of the service's URL via the browserless screenshot
// service (screenshot-service container on the dedicated screenshot-net).
router.post('/services/:id/thumbnail/capture', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const svc = store.getService(id);
  if (!svc) return res.status(404).json({ error: 'Service not found' });

  const shotUrl = new URL('/screenshot', config.browserlessUrl);
  if (config.browserlessToken) shotUrl.searchParams.set('token', config.browserlessToken);

  try {
    const shot = await fetch(shotUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'vibefolio-thumbnail/1.0' },
      body: JSON.stringify({
        url: svc.url,
        options: { type: 'png', clip: { x: 0, y: 0, width: 640, height: 360 } },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!shot.ok) {
      return res.status(502).json({ error: `Screenshot service failed (${shot.status})` });
    }
    const buf = Buffer.from(await shot.arrayBuffer());
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
      return res.status(502).json({ error: 'Screenshot service returned a non-PNG response' });
    }
    const updated = store.updateService(id, { thumbnailImage: buf.toString('base64') });
    res.json({ service: updated });
  } catch (err) {
    console.error('[thumbnail] capture failed:', err.message);
    res.status(502).json({ error: 'Could not capture thumbnail — is the screenshot service running?' });
  }
});

// --- Icon (site logo + favicon) -------------------------------------------

router.put('/icon', (req, res) => {
  const { siteIcon, favicon } = req.body ?? {};
  if (!isPngDataUrl(siteIcon) || !isPngDataUrl(favicon)) {
    return res.status(400).json({ error: 'siteIcon and favicon must be PNG data URLs' });
  }
  store.setSetting('siteIconPng', pngDataUrlToBase64(siteIcon));
  store.setSetting('faviconPng', pngDataUrlToBase64(favicon));
  res.json({ ok: true });
});

router.delete('/icon', (req, res) => {
  store.setSetting('siteIconPng', '');
  store.setSetting('faviconPng', '');
  res.json({ ok: true });
});

// --- Wallpaper --------------------------------------------------------------

// The uploaded wallpaper, stored as base64 in the settings table and served from
// `/wallpaper.jpg` — exactly like the site icon above, and for the same reason: the
// production container's root filesystem is read-only and only its data volume survives a
// recreate, so a file on disk would need a second persistence story (and a second one for
// backup/restore) that the database already provides.
//
// The panel resizes and re-encodes the picked file before it gets here, so what arrives is
// a JPEG-sized PNG rather than a 12-megapixel camera file; the cap in src/validate.js is
// what actually bounds the request.
//
// Clearing the value *is* deleting the wallpaper: the backdrop falls back to the background
// colour and, through it, the theme's own background. Nothing else has to be undone, which
// is why there is no separate "reset" state.
router.put('/wallpaper', (req, res) => {
  const { wallpaper } = req.body ?? {};
  if (!isWallpaperDataUrl(wallpaper)) {
    return res.status(400).json({ error: 'wallpaper must be a PNG data URL' });
  }
  store.setSetting('wallpaperPng', pngDataUrlToBase64(wallpaper));
  res.json({ ok: true, hasWallpaper: true });
});

router.delete('/wallpaper', (req, res) => {
  store.setSetting('wallpaperPng', '');
  res.json({ ok: true, hasWallpaper: false });
});

// --- Settings -------------------------------------------------------------

router.get('/settings', (req, res) => {
  res.json({ settings: settingsFrom(store.getAllSettings()) });
});

router.put('/settings', (req, res) => {
  const { ok, errors, value } = validateSettings(req.body ?? {});
  if (!ok) return res.status(400).json({ error: errors.join('; ') });
  for (const [k, v] of Object.entries(value)) {
    // `showStats` is the only boolean here; everything else — including the wallpaper's
    // transparency, which `validateSettings` has already reduced to a digit string — is
    // stored as the string the database holds. `String(v)` rather than `v` so a number can
    // never reach `node:sqlite`, which accepts only strings, numbers and buffers but would
    // store the type as well as the value.
    store.setSetting(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  res.json({ settings: settingsFrom(store.getAllSettings()) });
});

// --- Page text (feedback + credits pages) ---------------------------------

// The editable page copy and the credits page lines (see docs/decisions.md D22).
// These are public *content* — the pages render them — but they are deliberately not
// part of `SETTING_KEYS`: no public page fetches them, so `/api/site` stays the small
// metadata contract it always was, and the copy is only ever read here and by the
// server-rendered pages.

router.get('/content', (req, res) => {
  res.json({ content: publicData.pageText(), credits: store.listCredits() });
});

router.put('/content', (req, res) => {
  const { ok, errors, value } = validatePageText(req.body ?? {});
  if (!ok) return res.status(400).json({ error: errors.join('; ') });
  // Only the keys the client sent are written, so a panel that fails to render one
  // field cannot blank it.
  for (const [k, v] of Object.entries(value)) store.setSetting(k, v);
  res.json({ content: publicData.pageText() });
});

// --- Credit lines ---------------------------------------------------------

router.post('/credits', (req, res) => {
  const { ok, errors, value } = validateCredit(req.body ?? {});
  if (!ok) return res.status(400).json({ error: errors.join('; ') });
  res.status(201).json({ credit: store.createCredit(value) });
});

// Registered before `/credits/:id` so "order" is not read as an id. The body is the
// complete new ordering (the result of a drag), which `reorderCredits` applies
// atomically — a partial or stale list is refused rather than half-applied.
router.put('/credits/order', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id))) {
    return res.status(400).json({ error: 'ids must be an array of credit ids' });
  }
  const credits = store.reorderCredits(ids);
  if (!credits) {
    return res.status(409).json({ error: 'The order must list every credit line exactly once' });
  }
  res.json({ credits });
});

router.put('/credits/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const { ok, errors, value } = validateCredit(req.body ?? {});
  if (!ok) return res.status(400).json({ error: errors.join('; ') });
  const credit = store.updateCredit(id, value);
  if (!credit) return res.status(404).json({ error: 'Credit line not found' });
  res.json({ credit });
});

router.delete('/credits/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  if (!store.deleteCredit(id)) return res.status(404).json({ error: 'Credit line not found' });
  res.json({ ok: true });
});

// --- Feedback / email ------------------------------------------------------

// SMTP config is read and written through the same settings table as everything
// else, but it is NOT part of SETTING_KEYS (the public read model) — so it can never
// reach /api/site or a rendered page. The password is write-only: `smtpPublicConfig`
// returns `hasPassword` instead of the value.
router.get('/email', (req, res) => {
  res.json({
    smtp: mailer.smtpPublicConfig(store.getAllSettings()),
    feedbackEnabled: publicData.feedbackEnabled(),
  });
});

router.put('/email', (req, res) => {
  const body = req.body ?? {};
  const { ok, errors, value } = validateSmtpSettings(body);
  if (!ok) return res.status(400).json({ error: errors.join('; ') });

  for (const [k, v] of Object.entries(value)) {
    if (k === 'smtpPassword' && v === '') {
      // Explicit null clears the stored password; an omitted key leaves it alone
      // (handled by validateSmtpSettings not emitting the key at all).
      store.setSetting(k, '');
      continue;
    }
    store.setSetting(k, String(v));
  }

  if (body.feedbackEnabled !== undefined) {
    if (typeof body.feedbackEnabled !== 'boolean') {
      return res.status(400).json({ error: 'feedbackEnabled must be a boolean' });
    }
    store.setSetting('feedbackEnabled', body.feedbackEnabled ? '1' : '0');
  }

  res.json({
    smtp: mailer.smtpPublicConfig(store.getAllSettings()),
    feedbackEnabled: publicData.feedbackEnabled(),
  });
});

// Both test actions are admin-only (they sit below `router.use(requireAuth)`), so an
// anonymous visitor cannot use this deployment as an SMTP prober or a mail relay.
router.post('/email/test-connection', async (req, res) => {
  // Test the values currently in the form when they are supplied, so the admin does
  // not have to save a wrong password to find out it is wrong.
  const override = req.body?.smtp ? smtpFromBody(req.body.smtp) : undefined;
  const result = await mailer.verifyConnection(override);
  if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
  res.json({ ok: true, message: 'Connection and authentication succeeded.' });
});

router.post('/email/test-send', async (req, res) => {
  const to = typeof req.body?.to === 'string' ? req.body.to : '';
  const result = await mailer.sendTest(to);
  if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
  res.json({ ok: true, message: `Test message sent to ${result.to}.` });
});

/**
 * Builds a mailer config from form values, letting an empty password fall back to the
 * stored one. Without this, "test" would fail every time the admin had not retyped
 * their password, which is the normal case after a page reload.
 */
function smtpFromBody(body) {
  const stored = mailer.smtpFromSettings(store.getAllSettings());
  const port = Number(body.port);
  return {
    host: String(body.host ?? '').trim(),
    port: Number.isInteger(port) ? port : stored.port,
    secure: Boolean(body.secure),
    user: String(body.user ?? '').trim(),
    password: body.password ? String(body.password) : stored.password,
    from: String(body.from ?? '').trim(),
    to: String(body.to ?? '').trim(),
  };
}

export default router;
