# AGENTS.md — vibefolio

Instructions for AI agents and humans working in this repository.

## What this project is

**vibefolio** is a generalised, re-brandable services-showcase template: a single-page
"home / services" site that lists the public services running on the deployer's own site
(Grafana, MyACE, whatever — the services table starts empty; see `docs/decisions.md` D27),
each as a card with a live status indicator (Up / Down / Unknown), latency, an optional
GitHub repo link, and an "Open" link. A hamburger in the header opens a slide-out menu with
the live status counts, a dark/light/system theme selector and the admin entry point. A
password-protected admin panel (`/admin`) manages the services, the site metadata and the
copy on the feedback and credits pages. Its lineage is the private macjuu.com services
page; every macjuu-specific identity and default was stripped out during the
generalisation.

It is intentionally small: no build step, no framework, no ORM, no native dependencies.

## Quick commands

```bash
npm run dev    # dev server with --watch (http://localhost:3000, or $PORT)
npm test       # node:test integration suite (in-memory SQLite)
npm start      # production-style start
```

**Gotcha:** the app reads env vars directly — there is **no dotenv auto-load**. To run
locally you must source `.env` first:

```bash
set -a; source .env; set +a; npm run dev
```

## Architecture map

| Path | Role |
|------|------|
| `src/server.js` | Express app assembly: Helmet/CSP, JSON body, cookie parser, Origin CSRF check, routes, static files, error handler |
| `src/config.js` | Env-var config (validated at boot; `ADMIN_PASSWORD` required) |
| `src/version.js` | `APP_NAME` + `APP_RELEASE_DATE` shown in the fold-out menu (bump on release) |
| `src/db.js` | `node:sqlite` persistence: `settings`, `services`, `credits`, `sessions` tables + migrations + one-time seeding of the page copy and the wallpaper |
| `src/content-defaults.js` | The seed copy for the editable page text (feedback/credits prose + credit lines) — inserted once per database, for keys that are missing |
| `src/validate.js` | Input validation for admin mutations (services, settings, page copy, credit lines, PNG icons, the wallpaper image + its placement/colour settings) |
| `src/auth.js` | Session auth (httpOnly `SameSite=Strict` cookie) + Origin CSRF defence |
| `src/health.js` | Periodic health checker with SSRF protection (private-IP block, redirect cap) |
| `src/mailer.js` | SMTP transport for the feedback form: config from settings, connection/send helpers, `smtpPublicConfig()` (never returns the password) |
| `src/routes/feedback.js` | `GET /api/feedback/token` + `POST /api/feedback` — rate limit, honeypot, timing token |
| `src/feedback-token.js` | Signs/verifies the feedback form's timing token (HMAC, `FEEDBACK_TOKEN_SECRET`) |
| `src/routes/public.js` | `GET /api/site`, `GET /api/services` (enabled services + live status) |
| `src/routes/admin.js` | Auth + service/settings/icon/page-text/credit-line CRUD under `/api/admin` |
| `src/backup.js` | Backup/restore: build + validate the gzipped JSON archive, stage an inspected upload, apply it by category, write/list pre-restore snapshots (D25) |
| `src/routes/backup.js` | `/api/admin/backup` + `/api/admin/restore/*` — mounted **ahead** of `routes/admin.js` with its middlewares scoped to `/backup` and `/restore` (an unscoped `requireAuth` there 401s `/api/admin/login`) |
| `src/public-data.js` | Shared public read model (`publicSettings()`, `listPublicServices()`, `pageText()`, `listPublicCredits()`) behind both the API and the rendered pages |
| `src/routes/pages.js` | `GET /` + `/credits` + `/feedback` + `/admin` (server-rendered), `301 /index.html` → `/` |
| `src/render-page.js` | Fills `src/views/*.html` (`{{TOKEN}}` templates) from the DB |
| `src/asset-version.js` | The single `?v=` cache-buster for style.css / app.js / chrome.js / render.js / admin.js |
| `src/views/home.html` | Homepage template — lives outside `public/` so it can never be served raw |
| `src/views/credits.html` | Credits template (same treatment; the page makes no fetch) — its subtitle, credit lines and bottom note come from the DB |
| `src/views/feedback.html` | Feedback template — subtitle + intro paragraphs come from the DB |
| `src/views/admin.html` | Admin panel template (`public/` is static-only, so views live here) |
| `public/js/render.js` | Shared view module (escape + card/stats/chrome/menu/backdrop markup) imported by the server *and* the browser |
| `public/js/chrome.js` | Fold-out menu behaviour: open/close, focus, scroll lock, theme switch, admin label |
| `public/js/app.js` | Homepage live status: patches the server-rendered cards and menu counts, polls every 60s, detail popups |
| `public/js/admin.js` | Admin panel logic (login, CRUD, icon + wallpaper uploads, page-text panel, drag-to-reorder for services and credit lines, backup/restore dialog) |
| `public/js/feedback.js` | The feedback form's browser half: submit, throttle handling, confirmation, and the Clear-button sync |
| `public/js/email-config.js` | Pure helpers shared by `feedback.js`: the save-guard rule that stops a blank panel overwriting a working SMTP config. Extracted so it can be unit-tested in Node |
| `public/js/page-text-config.js` | Same pattern for the page-text panel: which fields a save may send |
| `scripts/capture-smtp.mjs` | Local SMTP capture server, for exercising a real send without a provider (see `docs/DEVELOPMENT.md`) |
| `public/css/style.css` | Custom "Midnight Glass" design system (dark + light palettes, no framework) |
| `test/` | `node:test` integration tests: `app`, `content`, `menu`, `theme`, `assets`, `health`, `backup`, `wallpaper`, `feedback`, `feedback-route`, `feedback-audit` (+ `helpers.js`) |

## Admin panel conventions

- **Drag to reorder** (services, credit lines) is one shared helper in `public/js/admin.js`
  (`enableDragReorder`): only the ⠿ handle is `draggable`, `dragover` moves the row live,
  `dragend`/arrow keys write the whole order in one request, and `busy()` lets a timer-driven
  re-render stay out of the way mid-drag. Reuse it rather than writing a third list.
- **A `.field`'s label is a direct child** — `style.css` scopes that rule as `.field > label`
  because the descendant form also matches `<label>` components nested in a field (the accent
  chips) and, being more specific, silently overrides their own colour and font.
- **`.panel-group` has a `:first-of-type` margin reset** that drops the top margin of a heading
  opening a block — and it matches a heading that is the first `<h3>` *inside a wrapper* too, not
  just the first in the panel. So a block that follows other content and needs space above it
  must carry that space itself (see `.snapshots-section`), not rely on the heading's own margin;
  otherwise the block sits flush against whatever precedes it. The "Credit lines" heading still
  works around this with an inline `style="margin-top:2rem"` — prefer a section class.
- **A clear control goes inside the input, never under it.** `.input-clear` wraps an input plus
  an `.input-clear-btn` (the `#i-clear` ✕ — a filled disc, the knockout done with an SVG
  `evenodd` fill rule, because the input's background is a translucent stack over a photo and no
  painted stroke could match it). A control below an input adds height to *one* column of a
  `.field-row`, which breaks that row's alignment. Two things there are load-bearing: the ✕
  clears **and saves in one action** (passing `allowClear`, which is what keeps D19's save guard
  from blocking a deliberate removal), and it is hidden until the field has a value. A field
  whose input is deliberately empty by design — the SMTP password — gets no ✕ at all; see
  `docs/DEVELOPMENT.md` for how to un-store one.
- **A `$('#id')` that resolves to null throws at parse time, and every listener after it is
  silently never attached** in `admin.js` / `feedback.js` — the page still looks almost right.
  `test/assets.test.js` checks every queried id against the *rendered* `/admin` page, so removing
  an element and its listener has to happen in the same change.

## Backup & restore conventions

- **A backup is the database minus what the repo owns, minus secrets.** Settings, services
  (with their base64 artwork) and credit lines, as gzipped JSON. `smtpPassword`, `creditsSeeded`,
  `wallpaperSeeded` and the `sessions` table are never in it; `status`/`latencyMs`/`lastChecked`
  are the health checker's output and are re-derived. See D25. There are **seven** categories:
  the wallpaper image is its own (`wallpaper`), while its placement and colours travel with
  *Site settings* (D26) — so restoring one without the other is possible and worth knowing
  before you select only one.
- **The archive never travels back through the browser.** `inspect` validates and stages it in
  memory against a session-bound id (15 min TTL); `apply` names that id. What is written comes
  from the server's normalised copy, so a tampered request can only choose *which* categories,
  never *what*.
- **The raw body parser is registered on the inspect route, after `requireAuth`** — an
  app-wide parser on that path buffers the whole body before anything can refuse it. Only one
  validated upload is staged at a time, and the caps (12 MB upload / 24 MB expanded) are sized
  against the container's `mem_limit: 256m`.
- **Validation reuses the panel's validators** (`validateSettings`, `validatePageText`,
  `validateSmtpSettings`, `validateService`, `validateCredit`) so a restored value cannot be one
  the panel would refuse. `smtpSecure` is re-derived from the port rather than trusted.
- **Restore replaces per category, in one transaction.** Rows and keys the archive does not
  mention are deleted for the selected categories; the others are untouched.
- **A pre-restore snapshot is written first**, into `BACKUP_DIR` (default `./data/backups`, which
  in the container is inside the only writable volume). It is an ordinary archive, so the same
  dialog can restore it, and the newest five are kept.

## Conventions & constraints

- **ESM only** (`"type": "module"`), Node >= 22.5 (uses built-in `node:sqlite`).
- **No build step** — server-rendered templates + vanilla JS. Keep it that way.
- **Strict CSP** (`script-src 'self'`, `script-src-attr 'none'`): no inline event handlers;
  use `addEventListener`. `img-src` allows `data:` and `https:`.
- **All user input is validated server-side** (`src/validate.js`) and **HTML-escaped on
  render** (`esc()` in `public/js/render.js`, which the server uses too). Never render raw
  input.
- **The feedback and credits copy is data, not markup** — the subtitles, the feedback intro,
  the credits bottom note and the credit lines live in the DB and are edited in the admin
  panel's **Page text** panel (`src/content-defaults.js` only seeds a fresh database once).
  Hard returns become paragraphs via `renderParagraphs()`; a cleared field renders nothing.
- **The homepage is server-rendered** from the `src/views/home.html` template by
  `src/render-page.js`. Adding a `{{TOKEN}}` means adding it to that file's `values` map —
  unknown tokens throw rather than rendering literally. Card/stats/chrome/menu markup lives
  once, in `public/js/render.js`, shared by the server and `public/js/app.js` (a
  `type="module"` script).
- **The header is the same on every page**: brand + one right-aligned hamburger, plus the
  slide-out drawer (`{{MENU_TOGGLE}}` / `{{DRAWER}}`). Two rules that are easy to break:
  `{{DRAWER}}` must stay **outside** `<header>` (`.site-header` has `backdrop-filter`, which
  makes it a containing block for `position: fixed` descendants), and the closed drawer must
  be hidden with `transform` + `inert` — never `visibility: hidden` or `display: none`, since
  `visibility` is a focusability gate the browser only clears at the frame lifecycle, which
  makes `focus()` silently no-op. `test/theme.test.js` guards both.
- **Theming:** a `theme` cookie (`dark` / `light` / `system`, default `dark`) is validated by
  `normalizeTheme()` and rendered server-side into `<html data-theme="…">`. The light palette
  is declared **twice** in `style.css` (once for `[data-theme="light"]`, once inside
  `@media (prefers-color-scheme: light)` for `[data-theme="system"]`) because CSS cannot share
  a declaration block between a plain selector and a media query — edit both together;
  `test/theme.test.js` fails if they drift. Use the `--*-rgb` tokens rather than new colour
  literals.
- **The accent:** the site has **one** highlight hue, chosen in the admin panel (Site settings
  → Accent colour) and rendered server-side into `<html data-accent="…">` — a site setting, not
  a per-visitor cookie like the theme. Components read exactly five tokens (`--accent`,
  `--accent-rgb`, `--accent-solid`, `--on-accent`, `--grad-accent`); the old purple/cyan/yellow
  tokens were collapsed into them, and a rule reading a removed token fails *silently*, so
  never reintroduce `--accent-2` / `--accent-yellow` / `--warm-*`. Adding an accent means
  `ACCENTS` in `public/js/render.js` plus **three** `style.css` blocks (dark, light, and the
  light values again inside the `prefers-color-scheme` query) — `test/theme.test.js` enforces
  the copies match and that every accent clears 4.5:1 in both themes. The picker's chips are
  painted in the accent they offer (D24), so their label takes `--accent-solid` in light mode
  and `--accent` in dark: the tint costs contrast, and the palette clears AA by a thin margin.
- **The wallpaper** is an uploaded image plus four placement settings, all chosen in Site
  settings → Wallpaper (D26). The image is base64 PNG in the `settings` table
  (`wallpaperPng`), served from `GET /wallpaper.jpg`, uploaded and deleted **immediately**;
  the placement (`wallpaperAnchor`, `wallpaperSize`), the `backgroundColor` and the
  `wallpaperTransparency` save with the **Save settings** button, like the accent. Four rules:
  the backdrop is **three layers** — `.bg-color` (z −3), `.bg-photo` (z −2, carrying
  `--wp-image` + `--wp-opacity`) and `.bg-overlay` (z −1, the readability wash at full
  strength) — and the wash must stay a *separate* layer, because fading it with the wallpaper
  would drop the text under AA exactly when a bright image is chosen. Every placement id is
  interpolated into a `data-` attribute that `style.css` has **one rule per**, so an id with
  no rule renders as *no* placement rather than a wrong one — `test/wallpaper.test.js` fails if
  the two lists drift. The image is **PNG only** (one definition of "an image this app will
  store", enforced at upload, on restore, and by the seed), so the panel encodes PNG and steps
  down a width ladder until the payload fits `MAX_WALLPAPER_BASE64` — PNG has no quality knob,
  and a detailed photo is ~10× the size of a smooth one at the same width. `MAX_WALLPAPER_BASE64`
  is sized against **what the browser's canvas produces**, not against the file on disk: a canvas
  PNG is substantially larger than the same pixels encoded by a command-line tool (1 926 880 vs
  1 497 300 characters for the bundled photo), and sizing against the file is how the site's own
  default ends up refused by its own panel. The seed must be **truecolour and full resolution**
  for the same reason — a quantized seed cannot round-trip through an upload path that emits
  truecolour. The wallpaper was
  seeded once from `public/img/bg.png` under a `wallpaperSeeded` marker, and **the guard is the
  marker, not "the value is empty"** — clearing the value is how the admin deletes it, and a
  boot must not resurrect it. There is deliberately no fixed-vs-scrolling option: the layer is
  `position: fixed`, so the two values render identically.
- **Order is set by dragging, never by a number.** Both the services table and the credit lines
  reorder with the ⠿ handle (arrow keys on the focused handle do the same), saving the whole
  order in one request (`PUT /api/admin/{services,credits}/order`, see D23). A create that omits
  `sortOrder` is appended; an update that omits it keeps its place.
- **All SQL is parameterised.** New columns need a migration in `src/db.js` `migrate()`:
  `CREATE TABLE IF NOT EXISTS` for fresh DBs + a `PRAGMA table_info` check + `ALTER TABLE`
  for existing DBs (see `icon_image` / `github_repo`).
- **Cache-busting:** assets are referenced with `?v={{ASSET_VERSION}}` in the templates and
  the one number lives in `src/asset-version.js`. Bump `ASSET_VERSION` when `style.css`,
  `app.js`, `chrome.js`, `render.js`, or `admin.js` changes — `test/assets.test.js` fails if
  any view or the `app.js` → `render.js` import disagrees.
- **Service model** (see `src/db.js` `mapService`): `id, name, icon, iconImage, thumbnailImage,
  description, url, githubRepo, techStack, aiDetails, story, audience, enabled, sortOrder,
  status, latencyMs, lastChecked, createdAt, updatedAt`.
  `githubRepo` accepts `owner/repo` shorthand (normalized to `https://github.com/...`) or a
  full `github.com` URL; anything else is rejected.
- **Health checks** run every 60s (configurable) and only probe **enabled** services.
  SSRF protection is on by default — private/loopback hosts are marked `unknown` unless
  `HEALTH_ALLOW_PRIVATE=1`.

## Secrets & governance

- **Never commit `.env`** — it is gitignored and holds `ADMIN_PASSWORD`, `ALLOWED_ORIGINS`
  and `BROWSERLESS_TOKEN`. All secrets come from the environment, never from source. The same
  applies to `.env.*` backups; the deploy rsync re-includes `.env.example` *before* sweeping
  `.env.*`, so a local backup of the real file is never copied to the server.
- The repo's hosting is up to the deployer; the upstream copy lives at
  **`github.com/niels-emmer/vibefolio`** (default branch `main`). Do not add
  secrets, tokens, or credentials to any file.
- Production refuses to boot with a placeholder `ADMIN_PASSWORD`.

### The rules that apply to this repo

This is a **private, internet-facing** site. It serves no customer data, has no multi-tenancy
and no accounts beyond the single admin password — so the enterprise governance stack
(data-classification tiers, model routing by sensitivity, environment isolation) mostly
resolves to the same answer here. What does apply:

- **Data classification: INTERNAL by default.** The database holds the owner's own service
  list and admin configuration; it is not customer data and holds no PII. Treat its contents
  as private anyway: the repo itself is private and so is the site. Nothing in a prompt, an
  issue, or a commit message should contain the live `ADMIN_PASSWORD`, an SMTP credential, or
  a session token — if you see one, stop and redact before continuing.
- **Secrets never in source, logs or archives.** SMTP credentials live in the `settings`
  table and are deliberately outside `SETTING_KEYS`, so they cannot reach `/api/site`; the
  password is additionally excluded from every backup. Keep it that way — a new setting that
  holds a credential must be added to `NEVER_BACKED_UP_SETTING_KEYS` and kept out of
  `SETTING_KEYS`.
- **Dependency gate.** Five runtime dependencies (`express`, `helmet`, `cookie-parser`,
  `express-rate-limit`, `nodemailer`), all permissively licensed (MIT, and `nodemailer` under
  MIT-0), all pinned. Adding one needs a stated reason; the standard library or an existing
  dependency wins. There is no `npm audit` in CI — run it by hand when touching
  `package.json`.
- **Human review for risk.** Changes to auth, the CSRF/origin check, the backup/restore
  transaction, the SSRF guard in `health.js`, or the container's hardening belong to a human
  before they are deployed, whatever the test suite says. The suite is not a substitute.
- **Audit trail.** Architectural decisions go in `docs/decisions.md` as a numbered entry —
  the *why*, and what was rejected — because the diff already records the *what*. Sessions
  that change behaviour should leave one.

### What the tests do not prove

Stated plainly because it has bitten this repo repeatedly: **a green suite is not evidence
that a feature works.** The failures in this project's own history — a JPEG/PNG mismatch that
refused every upload, a `?v=` bumped before the edit so a browser served a stale module, an
HSTS header that broke one browser of three — were all invisible to `npm test` and obvious the
moment the thing was run. Before claiming something works, exercise it: start the dev server,
open the page, do the action. `docs/DEPLOYMENT.md` has a checklist for the deployed artefact
specifically because a broken module still serves plausible HTML.

- See `docs/` for architecture, development, and deployment details.

## Deployment (summary)

The original production deployment runs on a **homeserver** (SSH alias in `~/.ssh/config` —
not in this repo) from a plain file copy (no git checkout) deployed via rsync +
`docker compose up -d --build`. A generalised deployment follows the same shape: pick a
host, rsync the repo (excluding `.env`, `data/`, `node_modules`, `.git`), and compose up.
Full flow in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).