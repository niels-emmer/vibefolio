import { Router } from 'express';



import { publicSettings, listPublicServices, feedbackEnabled } from '../public-data.js';
import { renderHomePage, renderCreditsPage, renderAdminPage, renderFeedbackPage } from '../render-page.js';
import { normalizeTheme } from '../../public/js/render.js';
import { ASSET_VERSION } from '../asset-version.js';

const router = Router();

// Shared response config for the server-rendered pages: the HTML carries site
// settings, so it must not sit in a browser cache after an admin edit. ETag
// revalidation still makes repeat visits cheap.
function sendPage(res, html) {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
}

// The visitor's theme choice, from a plain (non-httpOnly) cookie written by
// `public/js/chrome.js`. It is rendered into `<html data-theme="…">` so the right
// palette is in the first byte — no flash, and it works on pages that ship no
// script. Anything unrecognised (including an absent cookie) falls back to the
// dark default, so a tampered cookie cannot inject an attribute value.
function themeOf(req) {
  return normalizeTheme(req.cookies?.theme);
}

// Homepage — server-rendered so the first paint already carries the configured
// title, description, icon and service cards (see src/render-page.js).
router.get('/', (req, res) => {
  sendPage(res, renderHomePage(publicSettings(), listPublicServices(), themeOf(req)));
});

// Credits — static prose, but the favicon and brand logo come from the settings.
router.get('/credits', (req, res) => {
  sendPage(res, renderCreditsPage(publicSettings(), listPublicServices(), themeOf(req)));
});

// Feedback — public, but 404s when the feature is switched off so a disabled form is
// indistinguishable from a page that does not exist (no "coming soon" hint, and no
// half-working surface to probe).
router.get('/feedback', (req, res) => {
  if (!feedbackEnabled()) return res.status(404).type('html').send(notFoundPage());
  sendPage(res, renderFeedbackPage(publicSettings(), listPublicServices(), themeOf(req)));
});

// Admin — login-gated, so its content is static, but the favicon and brand logo
// are settings-dependent. The page itself is served publicly (the API behind it
// is not), so it gets the same treatment and no icon flash after login.
router.get('/admin', (req, res) => {
  sendPage(res, renderAdminPage(publicSettings(), listPublicServices(), themeOf(req)));
});

// The old static path still works, without serving the unrendered template.
router.get('/index.html', (req, res) => res.redirect(301, '/'));

// A disabled feature should look absent, not broken. Deliberately tiny and
// self-contained: it has no brand/settings dependency, so it cannot fail for a
// reason of its own.
function notFoundPage() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex" /><title>Not found — vibefolio</title>
<link rel="stylesheet" href="/css/style.css?v=${ASSET_VERSION}" /></head>
<body><main><section class="hero container" style="text-align:center">
<h1>Not found</h1>
<p class="subtitle">That page doesn’t exist. <a href="/">Back to the services</a>.</p>
</section></main></body></html>`;
}

export default router;
