# vibefolio

A lightweight, self-hosted showcase of the public services on **your site** — a
generalised, re-brandable version of the [macjuu.com](https://macjuu.com) services page.
Each service is displayed as a card with an icon, description, URL, and a **live status
indicator** (Up / Down / Unknown). A password-protected **admin panel** lets you configure
site metadata and add / edit / remove services.

The default branding and seed copy are deliberately neutral: set your own site title,
icon, wallpaper and copy in the admin panel (see `docs/decisions.md` D27 for the
generalisation).

Runs as a single Docker container, designed to be fronted by **nginx-proxy-manager** on the
`proxy-net` Docker network.

## Features

- **Public showcase page** — responsive card grid with live status indicators.
- **Fold-out menu** — one hamburger in the header (same on mobile and desktop) opens a
  slide-out panel with the live status counts (total / online / errors), a **dark / light /
  system theme selector**, the running release name and date, and the admin entry point.
- **Admin panel** (`/admin`) — password-protected; configure site title, description, URL,
  footer, accent colour, upload a custom **site icon + favicon** (auto-resized to 64×64 / 32×32
  PNGs) and an **uploadable wallpaper** with its anchor, size, background colour and
  transparency, and manage services (add / edit / delete / enable / reorder, plus
  **per-service icon upload** with auto-resize for the homepage cards and an optional
  **GitHub repo link** shown on each card).
- **Editable page copy** — the feedback and credits prose, and the credits-page lines, are
  data edited in the panel's **Page text** block, not markup in a template.
- **Feedback form** (`/feedback`) — emails you and stores nothing. Behind a signed timing
  token, a honeypot and a rate limit; off by default.
- **Backup & restore** — download everything you have configured (services with their artwork,
  the site icon, the wallpaper, site settings, page copy, credit lines, email settings) as one
  gzipped JSON file, and restore from one by choosing which resource categories to overwrite.
  The SMTP password is never in a backup, and a snapshot of the current state is saved before
  every restore so it can be undone.
- **Automatic health checks** — periodically probes each enabled service URL and records
  status + latency.
- **Secure by default** — Helmet security headers, CSP, httpOnly `SameSite=Strict` session
  cookie, Origin-based CSRF defence, login rate-limiting, constant-time password compare,
  parameterised SQL, input validation, non-root container user.
- **Fast & small** — no build step, no native dependencies, vendored CSS, ~small image.

## Tech stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js 26 (LTS) |
| Web framework | Express 5 |
| Database | Built-in `node:sqlite` (WAL mode) |
| Auth | DB-backed sessions + httpOnly cookie |
| Frontend | Server-rendered HTML templates (`src/views/*.html`) + vanilla JS, custom "Midnight Glass" design system with self-hosted variable fonts (Space Grotesk, Inter, JetBrains Mono) |
| Container | `node:26-alpine`, multi-stage, non-root |

## Design

The UI is a custom, hand-crafted **"Midnight Glass"** design system — no CSS framework. Dark-first
with an ambient aurora background, glassmorphic cards, gradient accents, animated live status
indicators, and a responsive service grid. Fonts (Space Grotesk / Inter / JetBrains Mono) are
self-hosted variable woff2 files and preloaded for fast rendering.

A light palette ships alongside it, selected with the theme control in the fold-out menu. The
choice is stored in a cookie and rendered server-side into `<html data-theme="…">`, so the
correct theme is in the first byte — no flash — and it applies even on the pages that ship no
fetching JavaScript.

## Quick start (local dev)

```bash
cp .env.example .env        # then edit ADMIN_PASSWORD (and ALLOWED_ORIGINS if needed)
npm install
set -a; source .env; set +a
npm run dev                 # http://localhost:3000 (or whatever PORT you set)
```

**The app reads env vars directly — there is no dotenv auto-load**, so the `source` line is
required or it exits at boot with `Missing required environment variable: ADMIN_PASSWORD`.

Open `http://localhost:3000` for the public page and `http://localhost:3000/admin` for the
admin panel. If something already holds that port (the production container does, on this
machine), start with `PORT=3100 npm run dev`.

## Run with Docker

```bash
cp .env.example .env        # set ADMIN_PASSWORD (and ALLOWED_ORIGINS if needed)
docker compose up -d --build
```

The compose file attaches the container to the external `proxy-net` network so
nginx-proxy-manager can route to it. The SQLite database lives in the named Docker volume
**`services-data`** (mounted at `/app/data`), which is why it survives a `docker compose down`
and a rebuild. It is *not* in `./data` — that path is the local-development default
(`DB_PATH`), and the deployment doc has the full picture.

### nginx-proxy-manager

1. Create a Proxy Host pointing at **`vibefolio:3000`** — the container's name on
   `proxy-net` (the `services` in the compose file is the *service* name, which is not what
   the proxy resolves).
2. Set `ALLOWED_ORIGINS` in `.env` to your public origin (e.g. `https://your-domain.example`)
   so the admin API's CSRF origin check passes for browser requests.

## Configuration

All configuration is via environment variables (see `.env.example` for the annotated list):

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PASSWORD` | — (required) | Password for the admin panel. Rejected at boot in production if it's a placeholder/dev value |
| `PORT` | `3000` | Listen port |
| `DB_PATH` | `./data/services.db` | SQLite database path |
| `HEALTH_CHECK_INTERVAL` | `60` | Seconds between health checks |
| `HEALTH_CHECK_TIMEOUT` | `5000` | Per-request health-check timeout (ms) |
| `HEALTH_ALLOW_PRIVATE` | `0` | Set `1` to allow health checks to private/loopback hosts (LAN services). Default blocks them (SSRF protection) |
| `SESSION_TTL_HOURS` | `12` | Session lifetime (hours) |
| `LOGIN_RATE_LIMIT` | `10` | Max login attempts per IP per 15 minutes |
| `ALLOWED_ORIGINS` | — | Comma-separated origins allowed for admin API (CSRF) |
| `TRUST_PROXY_IP` | — | The reverse-proxy IP trusted for `X-Forwarded-For`. Set it so only that peer can influence rate limiting |
| `BACKUP_DIR` | beside the DB | Where pre-restore snapshots are written. Inside the data volume in the container |
| `HSTS_ENABLED` | `0` | Opt in to `Strict-Transport-Security` outside production. Only meaningful over TLS — see the note in `docs/DEVELOPMENT.md` |
| `BROWSERLESS_URL` / `BROWSERLESS_TOKEN` | — | The screenshot service used to capture service thumbnails |
| `FEEDBACK_TOKEN_SECRET` | random per boot | Signing key for the feedback form's timing token. Set it to keep tokens valid across restarts |
| `FEEDBACK_TOKEN_TTL_MINUTES` | `60` | How long a visitor may take to fill the form |
| `FEEDBACK_MIN_SECONDS` | `3` | Minimum seconds between page load and submit |
| `FEEDBACK_RATE_LIMIT` | `5` | Feedback submissions allowed per IP per window |
| `NODE_ENV` | — | `production` enables secure cookies, gates HSTS, and rejects placeholder passwords |

## API

### Public (no auth)

- `GET /api/site` — site metadata, the accent, the wallpaper placement, and `hasIcon` /
  `hasWallpaper` booleans.
- `GET /api/services` — enabled services with live status.
- `GET /api/feedback/token` — a signed timing token for the feedback form.

### Public write

- `POST /api/feedback` — the feedback form's only write. Rate-limited, token- and
  honeypot-guarded; sends email and stores nothing.

### Public images (stored in the DB, served as PNG)

- `GET /site-icon.png`, `GET /favicon.png`
- `GET /wallpaper.jpg` — the uploaded background
- `GET /service-icon/:id.png`, `GET /service-thumb/:id.png` — 404 for a disabled service

### Pages

- `GET /`, `/credits`, `/feedback`, `/admin` — server-rendered
- `GET /index.html` → 301 to `/`

### Admin (session cookie required)

Auth: `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/me`

- **Services** — `GET|POST /api/admin/services`, `PUT|DELETE /api/admin/services/:id`,
  `PUT /api/admin/services/order`, `PUT /api/admin/services/:id/icon`,
  `PUT /api/admin/services/:id/thumbnail`, `POST /api/admin/services/:id/thumbnail/capture`
- **Site** — `GET|PUT /api/admin/settings`, `PUT|DELETE /api/admin/icon`,
  `PUT|DELETE /api/admin/wallpaper`
- **Page copy** — `GET|PUT /api/admin/content`, `POST /api/admin/credits`,
  `PUT|DELETE /api/admin/credits/:id`, `PUT /api/admin/credits/order`
- **Feedback / email** — `GET|PUT /api/admin/email`, `POST /api/admin/email/test-connection`,
  `POST /api/admin/email/test-send`
- **Backup & restore** — `GET /api/admin/backup`,
  `GET /api/admin/backup/snapshots[/:name]`, `POST /api/admin/restore/inspect`,
  `POST /api/admin/restore/apply`, `POST /api/admin/restore/discard`

Full request/response shapes are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tests

```bash
npm test
```

Runs integration tests against an in-memory database covering auth, CRUD, validation, and
settings.

## Security notes

- Secrets are never committed; they come from the environment.
- The container runs as a non-root user and the DB lives on a volume.
- The admin API is protected by a session cookie (`httpOnly`, `SameSite=Strict`, `secure` in
  production) plus an Origin allow-list check.
- Login is rate-limited to mitigate brute-force attempts.
- All SQL is parameterised; all user input is validated and HTML-escaped on render.

## License

MIT
