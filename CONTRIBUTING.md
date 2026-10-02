# Contributing

Thanks for your interest. This is a deliberately small, single-admin, self-hosted
project, so please keep changes focused and dependency-free where possible.

## Before you start

- For anything non-trivial, open an issue first so we can agree on the approach.
- Security issues must **not** be reported as public issues — see
  [SECURITY.md](SECURITY.md).

## Development setup

Requires Node.js >= 22.5 (uses the built-in `node:sqlite`). No build step, no native
dependencies.

```bash
npm ci
cp .env.example .env      # first time: set ADMIN_PASSWORD (and ALLOWED_ORIGINS if needed)
set -a; source .env; set +a   # the app reads env vars directly — no dotenv auto-load
npm run dev               # http://localhost:3000 (--watch auto-reloads)
npm test                  # node:test integration suite (in-memory SQLite)
npm start                 # production-style start
```

If port 3000 is taken (a production container often holds it), use `PORT=3100 npm run dev`.

## Checks

Run before opening a pull request:

```bash
npm test
```

Add a test that exercises the full HTTP round-trip for any new feature
(create → list → public exposure → update → delete), and a unit test for any extracted
pure logic (the modules in `public/js/*-config.js` exist so their rules can be tested in
Node).

## Conventions

- **ESM only** (`"type": "module"`); no build step; server-rendered templates in
  `src/views/` + vanilla JS in `public/js/`.
- **Strict CSP** (`script-src 'self'`, `script-src-attr 'none'`): no inline event
  handlers — use `addEventListener`.
- **Validate server-side, escape on render.** All admin input goes through
  `src/validate.js`; all dynamic text through `esc()` in `public/js/render.js`. Never
  render raw input — on the server too.
- **Parameterised SQL only.** New columns need a migration in `src/db.js` `migrate()`:
  `CREATE TABLE IF NOT EXISTS` for fresh DBs + a `PRAGMA table_info` check + `ALTER
  TABLE` for existing DBs.
- **Bump `ASSET_VERSION` in `src/asset-version.js`** (and the hand-written `?v=` module
  imports) when `style.css`, `app.js`, `render.js`, `chrome.js`, or `admin.js` changes —
  `test/assets.test.js` fails if any view or import disagrees, so you do not need to hunt
  for the numbers.
- **The light palette is declared twice** in `style.css` (explicit light + `system` light
  inside `prefers-color-scheme`) — edit both blocks together; `test/theme.test.js` fails
  if they drift.
- **The feedback/credits copy is data, not markup.** Change the seed a *fresh* install
  starts with in `src/content-defaults.js`; an existing database keeps whatever the admin
  saved (the seed only runs once — `docs/decisions.md` D22).
- **Architectural decisions go in `docs/decisions.md`** as a numbered entry — the *why*,
  and what was rejected. See `docs/` for architecture, development, and deployment
  details.
- **No new runtime dependencies without a stated reason** — the standard library or an
  existing dependency wins, and every package must be permissively licensed and pinned.