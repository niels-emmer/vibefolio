# Architecture — vibefolio

A small, self-hosted showcase of the public services running on the deployment's own site
(generalised from the macjuu.com services page — see `decisions.md` D27). This
document describes how the pieces fit together. See also
[`DEVELOPMENT.md`](DEVELOPMENT.md) (local workflow) and [`DEPLOYMENT.md`](DEPLOYMENT.md)
(production).

## Purpose

The site is a **private** home / services page: a card grid of the public
services (mail, analytics, dashboards, …) with live status, latency, an optional GitHub repo link, and an
"Open" link. A password-protected admin panel manages the services and site metadata. It is
deliberately small — no build step, no framework, no ORM, no native dependencies.

## Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js >= 22.5 (LTS), ESM only |
| Web framework | Express 5 |
| Database | Built-in `node:sqlite` (WAL mode) |
| Auth | DB-backed session tokens + httpOnly `SameSite=Strict` cookie |
| Frontend | Server-rendered HTML templates (`src/views/*.html`) + vanilla JS, custom "Midnight Glass" CSS (no framework) |
| Container | `node:24-alpine`, multi-stage, non-root |

## Request flow

```
Browser ──> nginx-proxy-manager (proxy-net) ──> vibefolio:3000
                                                  │
                                                  ├─ /             → src/routes/pages.js (server-rendered)
                                                  ├─ /credits      → src/routes/pages.js (server-rendered)
                                                  ├─ /admin        → src/routes/pages.js (server-rendered)
                                                  ├─ /api/*        → src/routes/public.js
                                                  ├─ /api/admin/backup*    → src/routes/backup.js (auth-gated)
                                                  ├─ /api/admin/restore/*  → src/routes/backup.js (auth-gated)
                                                  ├─ /api/admin/*  → src/routes/admin.js (auth-gated)
                                                  ├─ /service-icon/:id.png → DB-stored PNG
                                                  ├─ /service-thumb/:id.png → DB-stored PNG
                                                  ├─ /site-icon.png, /favicon.png → DB-stored PNG
                                                  └─ static files  → public/ (fonts, css, js, images)
```

The homepage, credits page and admin page are all rendered from templates in `src/views/`
by `src/render-page.js` — see
[D11](decisions.md#d11--server-rendered-pages-no-flash-of-placeholder-content).
`src/views/` is deliberately outside `public/` so the templates can never be served raw, and
`src/asset-version.js` holds the one `?v=` number they all share (enforced by
`test/assets.test.js`).

Middleware order in `src/server.js`: Helmet (CSP) → JSON body → cookie parser → Origin CSRF
check → public/admin API routes → pages router → static → 404 → error handler.

## Data model (`src/db.js`)

Four tables, all parameterised SQL, WAL mode:

- **`settings`** — `key`/`value` pairs: `siteTitle`, `homepageTitle`, `siteDescription`,
  `siteUrl`, `siteFooter`, `showStats` (`'1'`/`'0'`, default true), `accentColor` (an accent id,
  default `amber` — see [D21](decisions.md#d21--one-accent-hue-chosen-in-the-admin-panel)),
  `siteIconPng`, `faviconPng`, the wallpaper (`wallpaperPng` — a base64 PNG served from
  `GET /wallpaper.jpg`; plus `wallpaperAnchor`, `wallpaperSize`, `wallpaperTransparency`
  (`'0'`–`'100'`) and `backgroundColor` (`#rrggbb` or `''`) — see
  [D26](decisions.md#d26--the-wallpaper-is-an-uploaded-image-plus-placement-settings-seeded-once-from-the-bundled-photo)),
  the editable page copy (`feedbackSubtitle`, `feedbackIntro`,
  `creditsSubtitle`, `creditsNote` — see
  [D22](decisions.md#d22--the-page-copy-is-editable-and-seeded-once)), and the two one-time
  seed markers `creditsSeeded` and `wallpaperSeeded`. The SMTP configuration for the
  feedback form lives here too (`feedbackEnabled`, `smtpHost`, `smtpPort`, `smtpSecure`,
  `smtpUser`, `smtpPassword`, `smtpFrom`, `smtpTo`) but is deliberately outside `SETTING_KEYS`,
  so it can never reach `/api/site`; `smtpPassword` is likewise the one key a backup does not
  contain (D25).
- **`services`** — the core entity:
  `id, name, icon, icon_image, thumbnail_image, description, url, github_repo, tech_stack,
  ai_details, story, audience, enabled, sort_order, status, latency_ms, last_checked,
  created_at, updated_at`.
  `icon_image` stores a base64 PNG (uploaded via admin); `thumbnail_image` stores a captured
  or uploaded screenshot PNG; `github_repo` stores a normalized `https://github.com/...` URL
  or `''`. The detail-popup fields are `tech_stack` (pipe-separated tags, rendered as chips),
  `ai_details` and `story` (prose), and `audience` (enum: `''` / `personal` / `shared` /
  `open-source` → badge).
- **`credits`** — the credits-page lines: `id, role, value, url, sort_order, created_at,
  updated_at`. `role` is the label ("Built with"), `value` the name ("Node.js") and `url` the
  optional link; `sort_order` is the drag order from the admin panel. See
  [D22](decisions.md#d22--the-page-copy-is-editable-and-seeded-once).
- **`sessions`** — `token, created_at, expires_at` for admin auth.

**Migrations:** `migrate()` in `src/db.js` runs `CREATE TABLE IF NOT EXISTS` for fresh DBs,
then checks `PRAGMA table_info` and issues `ALTER TABLE` for columns added later
(`icon_image`, `thumbnail_image`, `github_repo`, `tech_stack`, `ai_details`, `story`,
`audience`). Any new column must follow this pattern.

**Seeding:** `migrate()` also seeds the editable page copy and the credit lines from
`src/content-defaults.js` — the copy the pages shipped with before it became editable. Both
seeds are strictly one-time (a missing settings key, and the `creditsSeeded` marker for the
lines), so an edit, a cleared field or a deleted line is never undone by the next boot.

It also seeds the wallpaper from `public/img/bg.png` (`seedWallpaper()`), guarded by its own
`wallpaperSeeded` marker. The guard is the *marker*, not "the value is empty": clearing
`wallpaperPng` is how the admin deletes the wallpaper, and a boot must not put it back. The
same marker keeps a restore that deliberately omits the wallpaper from being undone at the
next boot. The seed is what makes an upgraded deployment look exactly as it did when the
backdrop was a hard-coded `url('/img/bg.jpg')` in the stylesheet (D26).

## API surface

### Public (no auth)

- `GET /api/site` — site metadata + `hasIcon` + `hasWallpaper`. The metadata includes the
  site-wide accent (`accentColor`, normalised to a known id), which `public/js/app.js` patches
  into `<html data-accent>` on the poll, and the wallpaper's placement and colours
  (`wallpaperAnchor`, `wallpaperSize`, `wallpaperTransparency`, `backgroundColor`), each
  normalised to a value the stylesheet has a rule for.
- `GET /api/services` — **enabled** services with live status. Each service exposes
  `id, name, icon, iconImage (bool), thumbnailImage (bool), description, url, githubRepo,
  techStack, aiDetails, story, audience, status, latencyMs, lastChecked, updatedAt`.
- `GET /wallpaper.jpg` — the uploaded wallpaper, served as `image/png` with `no-cache`.
  Deliberately outside `/api`: it is referenced from a CSS custom property in the markup, not
  fetched by script. 404 when no wallpaper is active, which the page renders as "no image"
  rather than as a broken background. The path is `.jpg` while the bytes are PNG — it is the
  name a cache keys on, and renaming the URL would strand the old image in every cache
  between here and the visitor.

Both endpoints are projections of `src/public-data.js` (`publicSettings()` /
`listPublicServices()`), which the server-rendered homepage also uses — the JSON API and the
first paint are guaranteed to agree.

### Admin (session cookie required)

- `POST /api/admin/login` / `logout` / `GET me`
- `PUT /api/admin/services/order` — `{ ids: [...] }`, the complete new ordering from a drag
  (D23). Registered before `/services/:id` so "order" is not read as an id; partial, duplicate
  or unknown ids are refused with 409 rather than half-applied.
- `GET|POST /api/admin/services`, `PUT|DELETE /api/admin/services/:id`
- `PUT /api/admin/services/:id/icon` — auto-save a service icon (PNG data URL or `null`)
- `GET|PUT /api/admin/settings`
- `PUT|DELETE /api/admin/icon` — site icon + favicon
- `PUT|DELETE /api/admin/wallpaper` — the wallpaper image (D26). The placement, colour and
  transparency are ordinary settings and go through `/settings`; only the image has its own
  endpoint, because it uploads and deletes immediately the way the icon does. `DELETE` writes
  the empty string rather than removing a row — clearing the value *is* the deletion, and it
  is what the seed marker exists to make permanent.
- `GET|PUT /api/admin/content` — the editable page copy (feedback + credits subtitles, intro,
  bottom note). Only the keys sent are written; unknown keys are ignored.
- `POST /api/admin/credits`, `PUT|DELETE /api/admin/credits/:id` — one credits-page line
  (`role`, `value`, optional `url`); `value` is required.
- `PUT /api/admin/credits/order` — `{ ids: [...] }`, the complete new ordering from a drag.
  A partial, duplicate or unknown-id list is refused with 409 rather than half-applied. Two
  admins reordering at the same time is last-write-wins: the id set is identical, so the
  second request is a legitimate (if stale) order and cannot be told apart from a fresh one.

### Admin — backup & restore (`src/routes/backup.js`, see
[D25](decisions.md#d25--backup-and-restore-are-one-gzipped-json-archive-applied-by-category))

Mounted on `/api/admin` ahead of `routes/admin.js`, with both of its middlewares scoped to the
prefixes it owns (`/backup`, `/restore`) — an unscoped `router.use(requireAuth)` there would run
for every `/api/admin/*` request and refuse `/api/admin/login`.

- `GET /api/admin/backup` — the archive, as `application/gzip` with an `attachment`
  filename (`vibefolio-backup-YYYY-MM-DD-HHMM.json.gz`, UTC).
- `POST /api/admin/restore/inspect` — the archive as **raw gzip bytes**. `express.raw` is
  registered *on the route*, after `requireAuth`, so an unauthenticated upload is refused
  before its body is buffered. Validates, stages the result in memory against a session-bound
  id, and answers with the category overview. Writes nothing.
- `POST /api/admin/restore/apply` — `{ uploadId, categories }`. Writes a pre-restore snapshot,
  then applies the selected categories in one transaction. The archive comes from the staging
  area, never from this request.
- `POST /api/admin/restore/discard` — `{ uploadId }`, sent when the dialog is dismissed.
- `GET /api/admin/backup/snapshots` — the pre-restore snapshots, newest first.
- `GET /api/admin/backup/snapshots/:name` — download one. `:name` must match the snapshot
  filename pattern, which is also the path-traversal guard.

The six restore categories are `settings`, `pageText`, `artwork`, `email`, `services` and
`credits`; the list lives in `src/backup.js` and is *returned* by `inspect`, so the panel
renders whatever the server offers rather than carrying a copy that could drift.
- `GET|PUT /api/admin/email` — feedback toggle + SMTP config (password write-only)
- `POST /api/admin/email/test-connection` — SMTP handshake/auth check, sends nothing
- `POST /api/admin/email/test-send` — sends a real test message

### Public write (the app's only one)

- `GET /api/feedback/token` — a signed timing token for the form (see
  [D17](decisions.md#d17--public-feedback-form-email-only-delivery-nothing-stored))
- `POST /api/feedback` — accepts `{ name, email, message, token }` and emails it.
  Nothing is stored. 400 (bad token or invalid field), 429 (rate limited),
  502 (the mail server refused) or 503 (not configured / too busy). A tripped honeypot
  gets a **fake 200** so a bot learns nothing.
  Rate limited by the same per-IP budget as the token endpoint, with a 16 kB body cap
  registered at app level (a parser mounted inside the router would be a no-op — the
  global parser runs first and body-parser then skips the stream as already parsed).

## Validation (`src/validate.js`)

All admin input is validated server-side and coerced to safe types:

- `name` required (≤120), `url` required http(s) (≤500), `description` ≤500, `icon` ≤200.
- `githubRepo` optional: accepts `owner/repo` shorthand (normalized to
  `https://github.com/owner/repo`) or a full `github.com` URL; anything else is rejected
  with a 400.
- Detail fields: `techStack` (array or comma/pipe string, normalized to pipe-separated;
  ≤10 tags, each ≤40 chars, total ≤500), `aiDetails`/`story` ≤1000, `audience` one of
  `personal` / `shared` / `open-source` (or empty).
- `enabled` boolean; `sortOrder` is optional — omitted means "append" on create and "leave the
  position alone" on update, because the admin panel sets the order by dragging (D23).
- `accentColor` one of the ids in `public/js/render.js` `ACCENTS` (`amber` default); anything
  else is a 400. PNG icons validated by signature (`isPngDataUrl`), size-capped.
- Page copy (`validatePageText`): `feedbackSubtitle`/`creditsSubtitle` ≤300,
  `feedbackIntro` ≤4000, `creditsNote` ≤1000. Newlines are normalised to `\n` so a CRLF client
  cannot leave a carriage return inside a paragraph.
- Credit lines (`validateCredit`): `role` ≤120 (optional), `value` required ≤200, `url`
  optional but must be http(s) when present.

## Auth & CSRF (`src/auth.js`)

- Login verifies `ADMIN_PASSWORD` with a constant-time compare.
- A random 32-byte session token is stored in the DB and set as an httpOnly,
  `SameSite=Strict` cookie (`secure` in production).
- `originCheck` middleware rejects state-changing requests with a disallowed `Origin`
  header (allow-list from `ALLOWED_ORIGINS` + same-origin). `SameSite=Strict` is the
  primary CSRF defence; the Origin check is defence-in-depth.

## Health checks (`src/health.js`)

- Runs every `HEALTH_CHECK_INTERVAL` (default 60s) against **enabled** services only.
- HEAD request with GET fallback on method-related statuses; timeout via
  `AbortController`; records `status` + `latency_ms`.
- **SSRF protection:** hostnames are resolved and private/loopback/link-local/reserved
  addresses are refused (marked `unknown`) unless `HEALTH_ALLOW_PRIVATE=1`. Redirects are
  followed manually, re-validated per hop, capped at 5.

## Frontend

- `src/views/home.html` + `src/render-page.js` — the homepage and credits page are
  **server-rendered** (see
  [D11](decisions.md#d11--server-rendered-pages-no-flash-of-placeholder-content)):
  the templates carry `{{TOKEN}}` placeholders which are filled from
  `src/public-data.js` (`publicSettings()` + `listPublicServices()`, the same read model
  behind `/api/*`). Text tokens are escaped by `fill()`; markup tokens (`BRAND`,
  `FAVICON`, `STATS`, `CARDS`, `FOOTER`, `MENU_TOGGLE`, `DRAWER`, `FEEDBACK_SUBTITLE`,
  `FEEDBACK_INTRO`, `CREDITS_SUBTITLE`, `CREDITS_LIST`, `CREDITS_NOTE`) are built by
  `public/js/render.js`, which escapes every field it interpolates. Unknown tokens throw, so
  a typo fails the test suite rather than reaching visitors.
- **Editable page copy**
  ([D22](decisions.md#d22--the-page-copy-is-editable-and-seeded-once)): the feedback and
  credits pages have no hardcoded prose. Their subtitle, intro/note and credit lines are read
  from the database (`pageText()`, `listPublicCredits()`) and rendered server-side like
  everything else, so the copy is in the first byte and the pages still need no fetch.
  `renderParagraphs(text, className)` turns hard returns into `<p>` elements — the one place
  the copy's newlines survive, since HTML would otherwise collapse them.
- **Header + fold-out menu**
  ([D14](decisions.md#d14--fold-out-menu-replaces-the-headers-status-pill-and-admin-button)):
  every page renders the same bar — brand on the left, one right-aligned hamburger
  (`{{MENU_TOGGLE}}`) on the right — plus a slide-out drawer (`{{DRAWER}}`) holding the app
  name and release date, live status counts, the theme selector and the admin entry point.
  Both fragments come from `render.js` (`menuToggleHtml()` / `drawerHtml()`) and are rendered
  on all three pages, so no page needs a fetch to fill them in. `{{DRAWER}}` must sit
  **outside** `<header>`: `.site-header` has `backdrop-filter`, which makes it a containing
  block for `position: fixed` descendants (`test/theme.test.js` guards this). The header also
  carries a `<noscript>` admin link so a broken module cannot make it a dead end — the
  [D13](decisions.md#d13--deploy-verification-must-prove-the-javascript-ran) failure mode.
- **Theme**
  ([D15](decisions.md#d15--theme-selector-cookie-rendered-server-side-three-themes)):
  `dark` / `light` / `system`, stored in a plain `theme` cookie, validated by
  `normalizeTheme()` and rendered into `<html data-theme="…">` plus the matching
  `<meta name="theme-color">` by `src/routes/pages.js`. Applying it needs no script;
  `chrome.js` only switches it. The light palette is declared twice — once for an explicit
  choice and once inside `@media (prefers-color-scheme: light)` for `system` — and
  `test/theme.test.js` fails if the two copies drift.
- **Accent**
  ([D21](decisions.md#d21--one-accent-hue-chosen-in-the-admin-panel)): one highlight colour
  for the whole site, a *site* setting (not a cookie) chosen in the admin panel, rendered
  into `<html data-accent="…">` by `src/render-page.js` and normalised by
  `normalizeAccent()`. Five tokens carry it — `--accent`, `--accent-rgb`, `--accent-solid`,
  `--on-accent`, `--grad-accent` — and every component reads those and nothing else, so
  buttons, headings, links, focus rings, badges, the hero title and the brand tile all
  follow the picker in both themes. Each accent declares those five tokens three times
  (dark, explicit light, `system` light); `test/theme.test.js` checks the copies match and
  computes WCAG contrast for every accent in both themes. The admin picker's chips carry
  their own `data-accent`, so an element can be painted with an accent other than the one in
  force.
- `src/version.js` — `APP_NAME` and `APP_RELEASE_DATE`, shown in the drawer
  ([D16](decisions.md#d16--release-namedate-as-a-constant-and-the-d11-amendment)). Bump
  `APP_RELEASE_DATE` when cutting a release; production is a plain file copy with no git
  metadata to read (D8).
- `public/js/render.js` — the shared view module (escape + card/stats/chrome/drawer markup),
  imported by the server *and* by `public/js/app.js` (a `type="module"` script) so both
  render identically. Keep it free of DOM and Node-only APIs.
- `public/js/chrome.js` — the drawer's *behaviour* only: open/close, Escape, backdrop click,
  focus trap and restore, scroll lock, theme switching, admin label. Deliberately
  dependency-free, because importing `render.js` here would need a second hand-written `?v=`
  cache-buster (a static file cannot use the `{{ASSET_VERSION}}` token) — exactly the drift
  `test/assets.test.js` exists to prevent. Loaded by all three pages.
- `src/views/credits.html` — server-rendered by the same module. Its favicon, brand logo,
  theme and menu are all server-rendered; the page makes **no fetch** and ships only
  `chrome.js` for the drawer's interactivity (an amendment to D11, recorded in
  [D16](decisions.md#d16--release-namedate-as-a-constant-and-the-d11-amendment)).
- `src/views/admin.html` — the login-gated admin panel, rendered with the same `{{FAVICON}}`,
  `{{BRAND}}`, `{{MENU_TOGGLE}}` and `{{DRAWER}}` tokens (its body is static; `admin.js`
  re-applies the chrome live after an icon re-upload). Like the other views it lives in
  `src/views/`, so it must be read and rendered server-side — it cannot be served as a static
  file.
- `src/asset-version.js` — the single `?v=` cache-buster shared by `style.css`, `admin.js`,
  `chrome.js`, the `app.js` → `render.js` import and every rendered page.
  `test/assets.test.js` fails if any page or import disagrees with it, so bumping is one edit.
  Bump `ASSET_VERSION` whenever `style.css`, `app.js`, `render.js`, `chrome.js` or `admin.js`
  changes.
- `public/js/app.js` — keeps the page live: polls `/api/site` + `/api/services` every 60s.
  On the first pass it patches status/latency into the server-rendered cards in place
  (`patchCards`); later passes rebuild the grid. A failed refresh never wipes
  server-rendered cards. It also patches the drawer's status counts (`applyDrawerStatus`).
  Clicking a card's description opens a native `<dialog>` detail popup (tech chips, AI
  details, story, audience badge, Open/GitHub links) — a bottom sheet on mobile.
- `src/views/admin.html` + `public/js/admin.js` — the admin panel: a login form, settings and
  service CRUD, icon/thumbnail uploads, and the **Page text** panel (the feedback/credits copy
  plus the credit-line editor). Re-applies the page chrome (`applyIcon`) live when the
  site icon is re-uploaded, so the preview is accurate without a reload. A credit line saves
  when its fields are left; the list is reordered by dragging the handle (HTML5 drag events
  move the row live, `dragend` saves the order) or with the arrow keys on a focused handle,
  which keeps the reorder keyboard-reachable.
- `src/backup.js` + `src/routes/backup.js` — backup and restore
  ([D25](decisions.md#d25--backup-and-restore-are-one-gzipped-json-archive-applied-by-category)).
  `buildArchive` / `serializeArchive` produce the gzipped JSON; `parseArchive` decompresses
  (with `maxOutputLength`), parses and *fully validates* it, returning the normalised archive
  that is the only thing ever written to the database; `summarize` produces the category
  overview the dialog renders; `applyRestore` writes the selected categories inside one
  transaction. A validated upload is held in memory (`stageArchive`) against a session-bound
  id for 15 minutes, so the apply request names the archive rather than carrying it. The
  pre-restore snapshots are ordinary archives written to `config.backupDir` (see
  `BACKUP_DIR`), pruned to the five most recent, and served back through the same flow.
  The panel's dialog is a native `<dialog>` shown with `showModal()`, so focus trapping and
  Escape come from the platform; its two steps are the same element, toggled by `hidden`.
  After a restore the panel re-reads every resource and re-applies the accent the way the
  picker's live preview does — deliberately *not* `location.reload()`, which would discard the
  toast that says what happened.
- **CSP constraints:** `script-src 'self'` + `script-src-attr 'none'` means no inline event
  handlers — always `addEventListener`. `img-src` allows `data:` and `https:`.
- **Escaping:** all dynamic text goes through `esc()` before insertion — including on the
  server. Never render raw input.
- **Cache-busting:** assets are referenced as `?v={{ASSET_VERSION}}`; the single number lives
  in `src/asset-version.js`. Bump `ASSET_VERSION` when `style.css`, `app.js`, `admin.js`,
  `chrome.js`, or `render.js` change — one edit updates every view and the `app.js` →
  `render.js` import, and `test/assets.test.js` fails if any of them disagrees.
- **The thumbnail and the description are one clickable group** (`.card-hit`): the thumbnail
  button is a transparent overlay stretched over the static image, and both halves reveal the
  single shared `.desc-hint` line below the description.
- **SVG icons:** add new icons as `<symbol>` entries in the inline sprite in each view
  (`home.html`, `credits.html`, `admin.html` — they do not share a sprite file), referenced
  via `<use href="#i-…"/>`.

## Security posture

- Secrets only from the environment; `.env` is gitignored and never committed.
- Helmet + strict CSP; login rate-limited; all SQL parameterised; input validated; output
  escaped.
- Container runs non-root with `init`, `cap_drop: ALL`, `no-new-privileges`, read-only
  rootfs (tmpfs `/tmp`), resource limits, named volume for the DB.
- Production refuses to boot with a placeholder `ADMIN_PASSWORD`.