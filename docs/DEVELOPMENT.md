# Development — vibefolio

Local workflow, conventions, and gotchas for working on this repo.

## Prerequisites

- Node.js >= 22.5 (uses built-in `node:sqlite`). No other runtime dependencies.
- `npm install` once (deps: `express`, `helmet`, `cookie-parser`, `express-rate-limit`).

## Running locally

**The app reads env vars directly — there is no dotenv auto-load.** You must source `.env`
first, or the app will fail at boot with `Missing required environment variable:
ADMIN_PASSWORD`:

```bash
cp .env.example .env        # first time: set ADMIN_PASSWORD (and ALLOWED_ORIGINS if needed)
set -a; source .env; set +a
npm run dev                 # http://localhost:3000 (--watch auto-reloads)
```

- `npm test` — `node:test` integration suite against an in-memory SQLite DB.
- `npm start` — production-style start (no watch).

**Port clash:** if a Docker container (e.g. the production `vibefolio`) already binds
host port 3000, run the dev server on another port:

```bash
set -a; source .env; set +a; PORT=3100 npm run dev
```

**`localhost` vs `127.0.0.1`, and the HSTS trap.** Helmet sends `Strict-Transport-Security`
by default in every environment, and this app gates it on `NODE_ENV=production` because HSTS
is only meaningful over TLS. On a plain-HTTP dev origin it is worse than useless: a browser
that honours it upgrades every later subresource request on that origin to `https`, the dev
server has no TLS listener, and the stylesheet, fonts and scripts all fail — the page renders
unstyled, with the raw icon sprites scattered down it.

The practical consequence for development: **Chromium and Firefox are lenient about HSTS from
an insecure origin on `localhost`, Safari is not**, so a dev server on `http://127.0.0.1:PORT`
looked fine in two of three browsers and broken in the third. If you see that symptom on a
build from before this gate existed, the origin has an HSTS entry cached: clear it for that
host (Safari: *Develop → Empty Caches*, or delete the site's data), or just use a different
port. A local HTTPS run can opt back in with `HSTS_ENABLED=1`.

## Testing

- `test/helpers.js` sets env (`NODE_ENV=test`, in-memory DB, no auto health checks) before
  importing the app, and starts the server on an ephemeral port.
- `test/app.test.js` — auth, CRUD lifecycle, validation, CSRF, icons, settings, `githubRepo`,
  the accent round trip (admin panel → `/api/site` → every page's `data-accent`, with an
  unknown value rejected and a stored one normalised), and the server-rendered pages
  (metadata, escaping, empty state, stats, footer, icon, `index.html` redirect).
- `test/menu.test.js` — the header (one hamburger, no status pill, no Admin button, the
  `<noscript>` fallback), the drawer (name + release date with its `Updated:` label, inert
  until opened, status counts matching `/api/services`, theme radios, admin link, the
  Credits/Feedback links), and the theme cookie → `<html data-theme>` /
  `<meta name="theme-color">` mapping including tampered values.
- `test/feedback.test.js` — the feedback primitives: timing-token forgery, expiry and
  too-fast rejection; name/email/message validation and length caps; the port → protocol
  derivation; control characters rejected in passwords; the SMTP password never appearing
  in the public config; CRLF header-injection attempts; RFC 5321 dot-stuffing.
- `test/feedback-route.test.js` — the endpoint: feature gating (404/503 when off),
  uniform refusals, honeypot fake-success, **honest failure** for unconfigured and
  unreachable SMTP, admin auth on the email routes, no SMTP secret on a public surface,
  and a **real SMTP conversation** against an in-process stub proving a 200 only follows
  an accepted message.
- `test/feedback-audit.test.js` — regression guards for the security audit: C0 control
  stripping in header values and message bodies, and the global concurrency cap (the
  overshoot must queue rather than open more sockets, and every slot must be released).
- `test/theme.test.js` — `style.css` structure: the two light-palette blocks must be
  identical, the light palette may only override tokens the dark default defines, the drawer
  must be hidden by `transform` (not a focusability gate) and must sit outside `<header>`.
- `test/wallpaper.test.js` — the backdrop ([D26](decisions.md)): the seed is one-time and a
  deleted wallpaper survives a boot, the bundled photo is a PNG that fits the upload cap, every
  placement id has a `style.css` rule (a missing one renders as *no* placement, silently), the
  wash is a separate layer that the transparency slider cannot fade, hostile settings cannot
  break out of the markup, the panel and the server agree on the size cap, the panel encodes
  the format the server validates, and the admin preview renders in the state the setting
  implies.
  Plus the accent ([D21](decisions.md)): every accent in `ACCENTS` defines exactly the five
  accent tokens in all three blocks, its two light copies match, the amber block repeats the
  `:root` values, `--accent-rgb` keeps its triplet in step with the hex `--accent`, fill/on-fill
  and accent-on-background clear 4.5:1 in both themes, and every `var(--…)` the stylesheet reads
  is declared somewhere (a stale reference to a removed token fails silently, so this is what
  catches a half-finished rename).
- `test/assets.test.js` — the `?v=` cache-buster: every view and the `app.js` → `render.js`
  import must agree with `src/asset-version.js`, and the rendered pages must carry it.
- `test/health.test.js` — SSRF/private-IP logic and `checkUrl` behaviour (up/down/redirect/
  HEAD→GET/network error).
- `test/backup.test.js` — backup and restore ([D25](decisions.md)): the archive carries the
  content and none of `smtpPassword` / `creditsSeeded` / `sessions` / the runtime status
  columns; a round trip through gzip is lossless; the validator refuses a non-gzip file, a
  foreign format, a newer version, an unknown key, a bad URL, a duplicate id, non-PNG artwork,
  a decompression bomb and an oversized upload; a restore replaces rather than merges, touches
  only the selected categories, leaves the stored SMTP password alone and re-derives the SMTP
  protocol from the port; a staged upload is session-bound and expires; and a restore's own
  snapshot restores the state it replaced. One test there exists purely as a regression guard:
  the backup router is mounted ahead of the admin router, so an unscoped `requireAuth` in it
  would 401 `/api/admin/login` — the bug the first draft of this feature shipped.
- When adding a feature, add a test that exercises the full HTTP round-trip (create → list →
  public exposure → update → delete).
- When changing the homepage template, the SSR test asserting the rendered grid matches
  `/api/services` is the guard against re-introducing a flash of wrong content.

## Testing the feedback flow locally

The feedback form needs an SMTP server to deliver to. There is one in the repo:

```bash
node scripts/capture-smtp.mjs 2525     # prints each message and saves it to /tmp/feedback-capture/
```

Then set the admin panel's SMTP host to `127.0.0.1` and port to **2525**.

**Why 2525 and not 25/465/587:** all three conventional ports are below 1024 and therefore
need root to bind, so a capture server cannot use any of them without `sudo`. The admin form
accepts any port (see [D20](decisions.md#d20--any-smtp-port-superseding-part-of-d17)), which
is what makes this workable.

With no SMTP server listening, a submission correctly returns **502** and tells the visitor
it could not be sent — that is the honest-failure path, not a bug. To see it, submit with
nothing on the configured port.

### Removing a stored SMTP password

There is no control for this in the panel, deliberately. The password input is empty by
design — blank means "keep the stored one" — so an in-field ✕ (the control the other SMTP
fields use) would be permanently visible and would mean something different from every other
✕ in the panel. And the *common* no-auth case needs nothing: leave the password unset and a
stored one is never transmitted, because the transport only sends credentials when a username
is set (`src/mailer.js`). A relay that accepts mail without authentication is configured by
leaving both fields blank.

To actually un-store a password, call the endpoint it was always the API for:

```bash
curl -X PUT https://your-domain.example/api/admin/email \
  -H 'Content-Type: application/json' -H "Origin: https://your-domain.example" \
  -b "sid=<session cookie from the browser>" \
  -d '{"smtpPassword": null}'
```

`null` clears it; omitting the key leaves it alone. (`validateSmtpSettings` implements that
distinction, and `test/feedback.test.js` covers it.) The panel's hint line reports the state
either way — "A password is stored." / "No password stored." — so the field is never silently
ambiguous about what is held.

### What `npm test` does and does not cover

`test/feedback-route.test.js` drives a real SMTP conversation against an in-process stub, so
delivery and the "never a fake success" property are covered. Two things are **not** covered
and need a browser:

- the admin panel's script ordering, and its save guard (the guard's *rule* is unit-tested
  in `test/feedback-audit.test.js`; its wiring into the page is not)
- the form's client-side behaviour after a rate limit

What *is* covered statically, in `test/assets.test.js`: the admin scripts are parsed for
`$('#id')` lookups and every id must exist in the **rendered** `/admin` page. A lookup that
comes back null and is then dereferenced throws at parse time, aborting the module — so every
listener declared after it is silently never attached while the page still looks almost
normal. That check is there because removing `#email-clear-password` from the view while its
listener was still in `feedback.js` would have done exactly that.

The restore dialog is in the same position: `test/backup.test.js` covers the whole server side
of the flow — validation, staging, the category selection, the snapshot — through real HTTP
requests, but the browser half (the checkbox gating the Verify button, the file picker, the
category list, the post-restore panel refresh) has no automated coverage. Walk it once by hand
after touching `public/js/admin.js`, and remember that a browser caches ES modules: iterate on a
**fresh port**, and assert that the script actually ran rather than trusting the rendered HTML.

### Trying backup & restore locally

Nothing special is needed — the panel is on `/admin`, and the snapshots land in `BACKUP_DIR`
(default `./data/backups` beside the database). Two things worth knowing:

- The archive is plain gzipped JSON, so `gunzip -c backup.json.gz | jq .data.services[0]` is
  the quickest way to see what a backup actually holds.
- `BACKUP_DIR` must be writable. In the container that means somewhere under `/app/data` (the
  only writable path — the rootfs is read-only), which is what the default resolves to.

## Conventions

- **ESM only** (`"type": "module"`); no build step; server-rendered templates + vanilla JS.
- **Strict CSP** (`script-src 'self'`, `script-src-attr 'none'`): no inline event handlers —
  use `addEventListener`. `img-src` allows `data:` and `https:`.
- **Validate server-side, escape on render.** All admin input goes through
  `src/validate.js`; all dynamic text through `esc()` in `public/js/render.js`. Never render
  raw input — on the server too.
- **The homepage, credits page, feedback page, and admin page are server-rendered.**
  `src/views/*.html` are templates of `{{TOKEN}}` placeholders filled by
  `src/render-page.js`; the card/stats/chrome markup lives in `public/js/render.js`, shared
  with the browser. Adding a token means adding it to the `values` map in `render-page.js` —
  an unknown token throws (and fails `npm test`) instead of rendering literally. The
  templates sit outside `public/` so they can't be served raw.
- **Parameterised SQL only.** New columns need a migration in `src/db.js` `migrate()`:
  `CREATE TABLE IF NOT EXISTS` for fresh DBs + `PRAGMA table_info` check + `ALTER TABLE`
  for existing DBs (see `icon_image`, `github_repo`).
- **The feedback and credits copy is editable, not hardcoded** ([D22](decisions.md)). It lives
  in the `settings` table (`feedbackSubtitle`, `feedbackIntro`, `creditsSubtitle`,
  `creditsNote`) and the `credits` table, is edited in the admin panel's **Page text** panel and
  is rendered server-side by `src/render-page.js`. To change the copy a *fresh* install starts
  with, edit `src/content-defaults.js` — but note the seed only runs once per database, so an
  existing install keeps whatever the admin has saved. Hard returns become paragraphs through
  `renderParagraphs(text, className)`.
- **The wallpaper is an admin setting, seeded once** ([D26](decisions.md)). The image is
  base64 PNG in `settings.wallpaperPng`, served from `GET /wallpaper.jpg`; its placement
  (`wallpaperAnchor`, `wallpaperSize`), colour and transparency are ordinary settings that save
  with the button. The seed copies `public/img/bg.png` into a database that has no
  `wallpaperSeeded` marker, which is what keeps an upgraded deployment looking unchanged — and
  what stops a boot resurrecting a wallpaper the admin deleted. To change the photo a *fresh*
  install starts with, replace `public/img/bg.png`; it must be a PNG, **truecolour** (a canvas
  emits truecolour, so a quantized seed cannot be re-uploaded through the panel), and must fit
  `MAX_WALLPAPER_BASE64` measured **through the browser's encoder** — a much larger number than
  the file's own size. `test/wallpaper.test.js` asserts the seed clears the cap; the cutoff the
  *upload* path is held to is the one to check when swapping the asset.
- **Cache-busting:** assets are referenced as `?v={{ASSET_VERSION}}` in the templates, and
  the single number lives in `src/asset-version.js`. Bump `ASSET_VERSION` when `style.css`,
  `app.js`, `admin.js`, `chrome.js`, or `render.js` changes — `test/assets.test.js` fails if
  any view, or the `app.js` → `render.js` import, disagrees, so you do not need to hunt for
  the numbers. **The test compares the number, not the file contents**, so bumping *before*
  making your edits leaves a changed module behind an unchanged URL — the browser then serves
  the old one from cache for up to `express.static`'s `max-age` (`5m`), which looks exactly
  like a fix that did not work.
- **SVG icons:** add new icons as `<symbol>` entries in the inline sprite of **each** view
  that uses them (`src/views/home.html`, `credits.html`, `admin.html` — there is no shared
  sprite file), referenced via `<use href="#i-…"/>`.
- **The fold-out menu** ([D14](decisions.md)) is rendered on every page by
  `public/js/render.js` and driven by `public/js/chrome.js`. Two rules that are easy to break:
  `{{DRAWER}}` must stay **outside** `<header>` (`.site-header` has `backdrop-filter`, which
  makes it a containing block for `position: fixed` descendants), and the closed drawer must
  be hidden with `transform` + `inert`, never `visibility: hidden` or `display: none` —
  `visibility` is a focusability gate the browser only clears at the frame lifecycle, so
  focusing the panel in the same task silently no-ops. `test/theme.test.js` guards both.
- **Theming** ([D15](decisions.md)): a `theme` cookie (`dark`/`light`/`system`, default
  `dark`) is validated by `normalizeTheme()` and rendered into `<html data-theme>` server-side.
  The light palette is declared twice in `style.css` — once for `[data-theme="light"]` and once
  inside `@media (prefers-color-scheme: light)` for `[data-theme="system"]`, because CSS cannot
  share a declaration block between a plain selector and a media query.
  `test/theme.test.js` fails if the copies drift, so **edit both blocks together**. Prefer
  `rgba(var(--accent-rgb), …)` style tokens over new colour literals — a hard-coded colour is
  how the light theme broke during development.
- **The accent** ([D21](decisions.md)): one highlight hue for the whole site, chosen in the
  admin panel and rendered into `<html data-accent>` server-side (it is a site setting, not a
  per-visitor cookie like the theme). Components read exactly five tokens — `--accent`,
  `--accent-rgb`, `--accent-solid`, `--on-accent`, `--grad-accent` — so **never** introduce a
  new `--warm-*`/`--accent-yellow`/`--accent-2` style token: the old purple/cyan/yellow set was
  collapsed into these, and a rule that reads a removed token fails silently at computed-value
  time (the declaration is dropped and the component falls back to an inherited value).
  **To add an accent:** add it to `ACCENTS` in `public/js/render.js` (which validates it,
  normalises it and renders the picker), then add **three** blocks to `style.css` — dark, an
  explicit light one, and the same light values again inside the `prefers-color-scheme: light`
  query, each with the two-selector form (`:root[…][data-accent="x"], :root[…] [data-accent="x"]`
  so the picker's chips get it too). `test/theme.test.js` fails if the copies differ or if the
  palette misses the 4.5:1 contrast bar in either theme.
- **The release date** lives in `src/version.js` (`APP_RELEASE_DATE`, `YYYY-MM-DD`) and is
  shown in the menu. Bump it when you cut a release
  ([D16](decisions.md)); production has no git metadata to derive it from.

## Service model

`id, name, icon, iconImage, thumbnailImage, description, url, githubRepo, techStack, aiDetails, story,
audience, enabled, sortOrder, status, latencyMs, lastChecked, createdAt, updatedAt` (see
`mapService` in `src/db.js`).

- `sortOrder` is the homepage order, set by dragging rows in the admin panel
  ([D23](decisions.md)). The service form no longer has a number field: a create that omits
  `sortOrder` is appended, and an update that omits it leaves the position alone. The API still
  accepts an explicit `sortOrder` for a client that wants to place a service exactly.
- `githubRepo` accepts `owner/repo` shorthand (normalized to `https://github.com/owner/repo`)
  or a full `github.com` URL; anything else is rejected with a 400.
- `techStack` is stored pipe-separated (`Next.js|TypeScript|SQLite`); the admin form
  accepts comma or pipe separated input. `aiDetails` and `story` are prose (≤1000 chars).
  `audience` is one of `''` / `personal` / `shared` / `open-source` and renders as a badge
  in the detail popup.
- `iconImage` is a base64 PNG stored in the DB, served at `/service-icon/:id.png`.
- Health checks only probe **enabled** services; private/loopback hosts are marked
  `unknown` unless `HEALTH_ALLOW_PRIVATE=1`.

## Credit-line model

`id, role, value, url, sortOrder, createdAt, updatedAt` (see `mapCredit` in `src/db.js`).

- `role` is the label ("Built with") and may be empty, in which case the line renders as a
  value on its own. `value` is required.
- `url` is optional; a line without one renders as plain text instead of a dead link. When
  present it must be an http(s) URL.
- `sortOrder` is the drag order from the admin panel. New lines are appended, and the whole
  order is rewritten in one request (`PUT /api/admin/credits/order`).

## Environment variables

See `.env.example` for the full list with defaults. Key ones:

| Variable | Default | Notes |
|----------|---------|-------|
| `ADMIN_PASSWORD` | — (required) | Rejected at boot in production if a placeholder |
| `PORT` | `3000` | |
| `HEALTH_CHECK_INTERVAL` | `60` | Seconds |
| `HEALTH_ALLOW_PRIVATE` | `0` | `1` allows probing private/loopback hosts (SSRF risk) |
| `ALLOWED_ORIGINS` | — | Comma-separated origins allowed for admin API (CSRF) |
| `DB_PATH` | `./data/services.db` | |

## Deployment

See [`DEPLOYMENT.md`](DEPLOYMENT.md) — the homeserver is a plain file copy deployed via
rsync + `docker compose up -d --build`; `.env` and the DB volume are never overwritten.