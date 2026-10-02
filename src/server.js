import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { initDb, purgeExpiredSessions, getSetting, getService } from './db.js';
import { originCheck } from './auth.js';
import { startHealthChecker } from './health.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import backupRoutes from './routes/backup.js';
import feedbackRoutes from './routes/feedback.js';
import pagesRoutes from './routes/pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

export function createApp() {
  initDb();
  const app = express();

  // Trust only the configured reverse proxy for X-Forwarded-For. If a request
// arrives from any other peer (e.g. another container on the shared network,
// or the proxy IP changed after a container recreation), warn once per peer so
// a stale TRUST_PROXY_IP is noticed instead of silently degrading rate limiting.
const warnedPeers = new Set();
// Docker peers often appear as IPv4-mapped IPv6 (::ffff:a.b.c.d) — normalise
// before comparing so the configured plain-IPv4 value matches.
const normalizeIp = (ip) => {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  return m ? m[1] : ip;
};
app.set('trust proxy', (ip) => {
  const peer = normalizeIp(ip);
  if (peer === config.trustProxyIp) return true;
  if (!warnedPeers.has(peer) && peer !== '127.0.0.1' && peer !== '::1') {
    warnedPeers.add(peer);
    console.warn(`[trust-proxy] untrusted peer ${peer} — TRUST_PROXY_IP (${config.trustProxyIp}) may be stale`);
  }
  return false;
});

  // HSTS is only meaningful over HTTPS, and sending it from a plain-HTTP origin is actively
  // harmful: a browser that honours it (Safari is the strict one) upgrades every later
  // subresource request on that origin to https, and a dev server has no TLS listener — so
  // the stylesheet, the fonts and every script fail to load and the page renders unstyled,
  // with the raw icon sprites scattered down it. Chromium and Firefox are more forgiving
  // about HSTS from an insecure origin on localhost, which is why this only showed up on
  // Safari. Production sits behind nginx-proxy-manager and does serve HTTPS, so there it is
  // still the right header.
  //
  // Gated on `isProd` rather than on a hostname check: the header's correctness depends on
  // whether *this* process is served over TLS, and the deployment is the only configuration
  // where that is true. A local HTTPS run can opt in with HSTS_ENABLED=1.
  app.use(
    helmet({
      hsts: config.isProd || process.env.HSTS_ENABLED === '1',
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  // Body limits. The feedback route gets a much tighter cap than the rest of the API:
  // its largest legitimate payload is a few kB, while the global limit exists for the
  // wallpaper upload, which is the largest image the app stores.
  //
  // Order matters and is not cosmetic: body-parser short-circuits once the request
  // stream has been consumed ("body already parsed"), so a parser registered inside
  // the feedback router would never run — the global parser would have already
  // taken it. Registering the strict parser here, on the path, is what actually
  // enforces it.
  //
  // 500kb → 2.3mb for the wallpaper. MAX_WALLPAPER_BASE64 is 2 100 000 characters and this
  // parser has to carry the base64 *plus* the JSON envelope around it; the rest of the
  // settings form shares this limit, so the number is the cap with ~400 kB of room rather
  // than the cap itself. This is only the outer bound on how much is buffered before a
  // request is refused — the size a request is actually measured against is in
  // src/validate.js, and `test/wallpaper.test.js` asserts the two stay in step.
  app.use('/api/feedback', express.json({ limit: '16kb' }));
  app.use(express.json({ limit: '2400kb' }));
  app.use(cookieParser());
  app.use(originCheck);

  // API routes
  app.use('/api', publicRoutes);
  // Backup & restore first: its paths sit under /api/admin, and mounting it ahead of the
  // admin router means that router's `requireAuth` does not also run for them.
  app.use('/api/admin', backupRoutes);
  app.use('/api/admin', adminRoutes);
  // Public feedback intake. Mounted after the admin router so /api/admin/* can never
  // be shadowed by it, and it registers only /api/feedback* paths.
  app.use('/api', feedbackRoutes);

  // Custom site icon + favicon, stored in the DB (settings) and served as PNGs.
  const serveIcon = (key) => (req, res) => {
    const b64 = getSetting(key);
    if (!b64) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(Buffer.from(b64, 'base64'));
  };
  app.get('/site-icon.png', serveIcon('siteIconPng'));
  app.get('/favicon.png', serveIcon('faviconPng'));

  // The uploaded wallpaper. The bytes are a PNG and are served as one, but the path is
  // `.jpg`: it is the name the browser and the reverse proxy cache the image by, and the
  // extension is what a stale cache entry is keyed on — renaming the underlying format
  // later would be invisible, while renaming the URL would strand the old image in every
  // cache between here and the visitor.
  app.get('/wallpaper.jpg', (req, res) => {
    const b64 = getSetting('wallpaperPng');
    if (!b64) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(Buffer.from(b64, 'base64'));
  });

  // Per-service uploaded icon. Disabled services are not public, so their images
  // are not either — the public list and the rendered cards only expose enabled
  // services, and these endpoints must not become a way around that.
  app.get('/service-icon/:id.png', (req, res) => {
    const svc = getService(Number(req.params.id));
    if (!svc || !svc.enabled || !svc.iconImage) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(Buffer.from(svc.iconImage, 'base64'));
  });

  // Per-service thumbnail (captured or uploaded).
  app.get('/service-thumb/:id.png', (req, res) => {
    const svc = getService(Number(req.params.id));
    if (!svc || !svc.enabled || !svc.thumbnailImage) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(Buffer.from(svc.thumbnailImage, 'base64'));
  });

  // Server-rendered pages (homepage, credits, admin). Their view templates live
  // in src/views/ (not public/) so they can never be served raw with placeholders
  // showing. Must precede the static handler.
  app.use('/', pagesRoutes);

  // Static frontend (short cache so asset updates land quickly for this
  // self-hosted, frequently-iterated app). `index: false` — there is no
  // index.html in public/; `/` is handled by the route above.
  app.use(express.static(publicDir, { index: false, maxAge: '5m' }));

  // 404 for unknown API paths
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Central error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Client errors from body parsing (e.g. malformed JSON, too large) get
    // their own status rather than being masked as 500s.
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large' });
    }
    if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.message || 'Bad request' });
    }
    console.error('[error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// Only start the server when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`vibefolio listening on http://localhost:${config.port}`);
    purgeExpiredSessions();
    startHealthChecker();
  });
}
