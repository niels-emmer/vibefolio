# Decision log — vibefolio

## Architecture decisions

### D1 — Runtime & framework
**Chosen:** Node.js 24 (LTS) + Express 5.
**Why:** Already available in the toolchain, fast startup, no build step, mature ecosystem. Express 5
is MIT and well-maintained. Rejected: Python (extra runtime), Go (not installed), Bun (less battle-tested
for Express-style middleware).
**Source:** `src/server.js`, `package.json`.

### D2 — Database
**Chosen:** Built-in `node:sqlite` (WAL mode).
**Why:** Zero native dependencies, no ORM, no CVE surface, atomic single-file persistence ideal for a
container. Rejected: `better-sqlite3` (native build in Alpine), Postgres/MySQL (overkill for a
single-instance showcase).
**Source:** `src/db.js`.

### D3 — Auth
**Chosen:** DB-backed session tokens in an `httpOnly` + `SameSite=Strict` cookie, with a constant-time
password compare and an Origin allow-list CSRF check.
**Why:** Revocable, no JWT complexity, no third-party auth service. `SameSite=Strict` blocks cross-site
cookie sending; the Origin check adds defence-in-depth for same-site cross-origin subdomains.
**Source:** `src/auth.js`, `src/routes/admin.js`.

### D4 — Health checks
**Chosen:** Built-in `fetch` with `AbortController` timeout, periodic (default 60s), HEAD-with-GET-fallback.
**Why:** No extra dependency. Records status + latency into SQLite for display.
**Source:** `src/health.js`.

### D5 — Frontend
**Chosen:** Static HTML + vanilla JS with a fully custom **"Midnight Glass"** design system
(self-hosted variable fonts: Space Grotesk, Inter, JetBrains Mono). No CSS framework, no build step.
**Why:** Full control over look & feel; tiny payload, fast load; self-hosted fonts (no CDN at runtime,
CSP-friendly). Rejected: Pico.css (too generic), a React/Vite SPA (build step + heavier bundle for a
small showcase).
**Source:** `public/` (css, js, html, fonts).

### D6 — Container
**Chosen:** Multi-stage `node:24-alpine`, non-root user, healthcheck, SQLite on a volume.
**Why:** Small image, least privilege, production health gating. Attached to the external `proxy-net`
network for nginx-proxy-manager.
**Source:** `Dockerfile`, `docker-compose.yml`.

### D7 — Per-service GitHub repo link
**Chosen:** Optional `githubRepo` field on each service, stored as a normalized
`https://github.com/...` URL (or `''`). The admin form accepts `owner/repo` shorthand or a full
`github.com` URL; anything else is rejected. The homepage renders a GitHub icon link to the left
of the "Open" link when set.
**Why:** Links the showcase cards to their source repos with minimal surface area. Normalizing
shorthand at the API keeps the DB canonical and the frontend trivial. Rejecting non-github.com
URLs keeps the field honest to its name.
**Source:** `src/db.js`, `src/validate.js`, `src/routes/public.js`, `public/js/app.js`,
`src/views/admin.html`, `public/js/admin.js`.

### D8 — Deployment model & repo privacy
**Chosen:** The repo is (for the original deployment) **private**, hosted at
`github.com/<your-org>/vibefolio`.
Production runs from a **plain file copy** on the homeserver
(`/home/<user>/projects/vibefolio`, replacing the first keeper's personal account) synced via
rsync + `docker compose up -d --build` —
deliberately **not** a git checkout on the server. Secrets live only in the gitignored `.env`
(never committed); the SQLite DB lives in the Docker named volume `services-data` (never synced).
**Why:** Keeps credentials out of source control entirely while keeping deployment simple and
reproducible for a single-instance self-hosted app. No CI/CD needed at this scale.
**Source:** `docs/DEPLOYMENT.md`, `docker-compose.yml`, `.gitignore`.

### D9 — Security hardening (pre-external-review)
**Chosen:** Applied the security review's MEDIUM findings + quick wins before showing the app to
external reviewers:
- **Rate limiting:** `TRUST_PROXY_IP` env restricts `trust proxy` to the reverse-proxy container
  IP, so other containers on the shared `proxy-net` network cannot spoof `X-Forwarded-For` and
  bypass the login brute-force limiter. IPv4-mapped IPv6 peers (`::ffff:a.b.c.d`) are normalised;
  untrusted peers log a one-time warning so a stale IP is noticed.
- **SSRF:** `isPrivateAddress` now canonicalises IPv4-mapped/compatible IPv6 forms (including
  hex-encoded `::ffff:7f00:1`) and rejects 6to4/Teredo. The health checker resolves DNS **once**
  and pins the connection to the validated address (custom `lookup` handling Node's
  `autoSelectFamily` `all: true` form), closing the DNS-rebinding TOCTOU.
- **CSRF:** state-changing requests carrying a session cookie but no `Origin` header are rejected
  (non-browser clients). `ALLOWED_ORIGINS=https://your-domain.example` set in production.
- **Auth:** password compare uses fixed-length SHA-256 digests (length-independent timing);
  sessions store a `pw_hash` and are invalidated when `ADMIN_PASSWORD` rotates.
- **Misc:** removed icon-upload debug logging, aligned the icon size cap with the 100kb body
  limit, added `pids_limit`, fixed stale `SESSION_SECRET` README references.
**Why:** The three MEDIUM findings were defence-in-depth gaps in the two most attack-relevant
controls (login rate limiter, SSRF guard) — exactly what an adversarial reviewer hunts for.
**Source:** `src/health.js`, `src/server.js`, `src/auth.js`, `src/config.js`, `src/db.js`,
`src/validate.js`, `src/routes/admin.js`, `docker-compose.yml`, `.env.example`.

### D10 — Service detail popups
**Chosen:** Clicking a card's description opens a native `<dialog>` detail popup with
structured per-service info: `tech_stack` (pipe-separated tags → chips), `ai_details` and
`story` (prose sections), and `audience` (enum `''`/`personal`/`shared`/`open-source` →
color-coded badge), plus Open/GitHub links in the footer. Desktop renders a centered glass
dialog; mobile a bottom sheet (full-width, rounded top, scrollable body). All data comes
from the existing `GET /api/services` payload — no extra request.
**Why:** Structured columns (rather than one long-form blob) keep the admin form explicit
and let the frontend render chips/badges instead of a wall of text; they follow the
existing per-field column pattern (`icon_image`, `github_repo`). A native `<dialog>` gives
focus trapping, Escape-to-close, and `::backdrop` for free under the strict CSP (no inline
handlers). Content is authored in the admin panel and lives in the production DB.
**Source:** `src/db.js`, `src/validate.js`, `src/routes/public.js`, `src/views/home.html`,
`public/css/style.css`, `public/js/app.js`, `src/views/admin.html`, `public/js/admin.js`,
`test/app.test.js`.

### D11 — Server-rendered pages (no flash of placeholder content)
**Chosen:** `GET /`, `GET /credits` and `GET /admin` are rendered on the server from
`src/views/*.html` templates (`{{TOKEN}}` placeholders) instead of serving static shells for
the client to overwrite. `src/render-page.js` fills the title, meta description, favicon,
brand logo, stats block, footer and (on the homepage) the first service-card grid from the DB.
`src/public-data.js` is the shared read model behind both the HTML and `/api/*`, so the two
cannot disagree. Markup lives in `public/js/render.js`, an ESM module imported by *both* the
server and `public/js/app.js` (now `type="module"`), so every chrome/card/stats fragment has
one definition. Pages are `Cache-Control: no-cache` (the HTML carries the settings, so it must
be revalidated) with an ETag for cheap 304s. `app.js` keeps its 60s poll, but on the first pass
it patches live status/latency into the server-rendered cards in place instead of rebuilding
the grid. `src/asset-version.js` holds one `?v=` for all shared assets, enforced by
`test/assets.test.js`.
**Why:** The homepage shipped hardcoded placeholder copy ("example.com Services", "Public
services running on example.com.", the default logo, `/favicon.svg`, three shimmering
skeletons) that was only replaced after two API round trips — visitors saw the wrong title,
subtitle, favicon and logo for as long as that took. The credits page had the same defect (its
favicon and brand logo were swapped in by `public/js/site-icon.js` after fetching `/api/site`
— that file is now deleted, and the page ships no JavaScript at all), and `/admin` had it via
`applyIcon()` in `admin.js` after an authenticated settings fetch. Rendering the real values
into the first byte removes the flash everywhere without giving up live status. Rejected:
hiding the page until JS runs (blank screen, and the tab title still flashes), preloading the
fetches (narrows the gap but never removes it). The templates live in `src/views/` rather than
`public/` so they can never be served raw with their placeholders showing.
**Source:** `src/views/home.html`, `src/views/credits.html`, `src/views/admin.html`,
`src/render-page.js`, `src/routes/pages.js`, `src/public-data.js`, `src/asset-version.js`,
`public/js/render.js`, `public/js/app.js`, `src/server.js`, `public/css/style.css`,
`test/app.test.js`, `test/assets.test.js`.

### D14 — Fold-out menu replaces the header's status pill and Admin button
**Chosen:** The header is now brand + a single right-aligned hamburger on every page and at
every breakpoint. It opens a right-hand slide-out drawer (`<aside role="dialog" aria-modal>`,
a sibling of `<header>`) containing the app name and release date, live status counts
(Total / Online / Errors), the theme selector, and the admin entry point. Markup is
server-rendered once in `public/js/render.js` (`menuToggleHtml()` / `drawerHtml()`); the
behaviour lives in a dependency-free `public/js/chrome.js`.
**Why:** The header had accumulated one-off controls (a status pill, an `Admin` button) that
differed per page, and the pill was the only place the aggregate status appeared — which on
mobile was `display: none`, so the information was simply unavailable on a phone. A drawer
gives every control one home, works identically at all widths, and leaves room for the
theme selector without crowding the bar.
**Constraints that shaped it, each learned the hard way in this change:**
- The drawer must be a **sibling** of `.site-header`, not a child: `.site-header` has
  `backdrop-filter`, which makes it a containing block for `position: fixed` descendants, so
  a nested drawer would be positioned against the 68px bar and clipped.
- The closed drawer is hidden by **`transform` + `inert`**, never by `visibility: hidden`.
  `visibility` is a focusability gate the browser only clears at the frame lifecycle, so
  `closeBtn.focus()` in the same task was *silently* refused and the drawer opened with focus
  still on the trigger. Measured in Chromium: same task, a forced reflow and `setTimeout(0)`
  all fail; only the second frame succeeds. `pointer-events: none` while closed stops clicks
  landing on the off-screen panel during the slide-out.
- `html { scrollbar-gutter: stable }` + `body.menu-open { overflow: hidden }` locks the page
  behind the drawer without the horizontal jump that hiding the scrollbar otherwise causes.
- The header keeps a `<noscript>` admin link so a failed module can never leave the header
  with no route to `/admin` — the same failure mode as [D13](#d13--deploy-verification-must-prove-the-javascript-ran).
**Source:** `src/views/*.html`, `src/render-page.js`, `public/js/render.js`,
`public/js/chrome.js`, `public/css/style.css`, `src/asset-version.js`, `test/menu.test.js`.

### D15 — Theme selector: cookie-rendered server-side, three themes
**Chosen:** A `dark` / `light` / `system` selector in the drawer. The choice is stored in a
plain (non-httpOnly) `theme` cookie; the server validates it against the allowed set and
renders `<html data-theme="…">` plus the matching `<meta name="theme-color">`. CSS defines
the light palette under `:root[data-theme="light"]` and, for `system`, again inside
`@media (prefers-color-scheme: light)`. `chrome.js` only flips the attribute, writes the
cookie, and re-reads `--bg` from the stylesheet to update the browser chrome colour.
**Why:** Rendering the palette server-side means the correct theme is in the first byte —
there is no flash of the wrong theme and no script is needed to *apply* it, which matters
because the credits page had shipped no JavaScript at all. An inline bootstrap script was not
an option under `script-src 'self'`. Reading the theme colour from `getComputedStyle` keeps
the palette in one place instead of duplicating hex values in JS.
`dark` remains the default so a visitor who never opens the menu sees exactly what they saw
before.
**Cost, and how it is contained:** CSS cannot share one declaration block between a plain
selector and a media query, so the light palette is declared **twice**. `test/theme.test.js`
parses both blocks and fails if they drift, and also asserts every token the light palette
overrides exists in the dark default. (That check caught a genuine bug during development:
the duplicated `--input-bg` was white-on-white in light mode.)
**Source:** `src/routes/pages.js`, `src/render-page.js`, `public/js/render.js`,
`public/js/chrome.js`, `public/css/style.css`, `test/menu.test.js`, `test/theme.test.js`.

### D16 — Release name/date as a constant, and the D11 amendment
**Chosen:** `src/version.js` exports `APP_NAME` (`Vibefolio`) and `APP_RELEASE_DATE`
(`2026-09-30`), formatted to `30 Sep 2026` by a hand-written formatter. The drawer shows
them; there is **no link to the repository**. Also: `/credits` and `/admin` now load
`public/js/chrome.js`, amending [D11](#d11--server-rendered-pages-no-flash-of-placeholder-content)'s
"the credits page ships no JavaScript at all".
**Why the constant:** the repository is **private**, so a browser-side "latest release" lookup
would need a token and would leak the repo's existence; and production is a plain file copy
with no git metadata to read (D8). Deriving the date from "now" would report the container
start time, which changes on every restart. So it is one constant, bumped as part of a
release, with `test/menu.test.js` asserting the format and rejecting malformed values.
**Why the D11 amendment is acceptable:** D11's intent was that the *chrome* is correct in the
first byte, not that no script may ever exist. `chrome.js` renders nothing — every value in
the drawer (name, date, counts, selected theme, admin link) is server-rendered; the module
only adds open/close, theme switching and the admin label. The credits page still does no
fetch and applies its theme without script.
**Source:** `src/version.js`, `src/render-page.js`, `src/views/credits.html`,
`src/views/admin.html`, `test/menu.test.js`.

## Security posture
- Secrets (`ADMIN_PASSWORD`) from environment only; never committed. `.env` is gitignored.
- Helmet + strict CSP (`script-src 'self'`, `script-src-attr 'none'` blocks inline handlers).
- Login rate-limited; all SQL parameterised; input validated; output HTML-escaped.
- Container runs as non-root with `init`, `cap_drop: ALL`, `no-new-privileges`, read-only rootfs
  (tmpfs for `/tmp`), resource limits, and a named volume for the DB.
- **SSRF protection**: the health checker resolves hostnames and refuses private/loopback/link-local
  addresses (`HEALTH_ALLOW_PRIVATE=0` by default); redirects are followed manually and re-validated
  (max 5 hops).
- In production the app refuses to boot if `ADMIN_PASSWORD` is a placeholder/dev value.

### D12 — Post-SSR hardening (deferred audit findings)
**Chosen:** Closed the low-severity items the security audit raised while reviewing the
server-rendered pages, plus one real interaction bug the explorer audit found:
- **Disabled services no longer leak their images.** `/service-icon/:id.png` and
  `/service-thumb/:id.png` now 404 when `enabled = 0`. The public list and the rendered
  cards already hid disabled services, so the image endpoints were the one way left to
  fetch a hidden service's uploaded artwork by guessing an id.
- **Admin API responses are `Cache-Control: no-store`**, applied as router middleware so
  it also covers the unauthenticated 401s and failed logins. The public API is untouched.
- **A failed poll no longer destroys good markup.** `app.js` keeps the last-good grid and
  only shows the error state when there is genuinely nothing to display (first load, or an
  empty grid). Previously any transient failure after the first successful load replaced
  real cards with an error message for up to a minute.
- **Thumbnail error fallback removed the wrong element** (`.card-thumb-btn` stopped being
  an ancestor of the image when the overlay was introduced), leaving an empty button
  stretched over nothing; it now removes `.card-thumb-wrap`.
**Why:** Each was flagged as low severity, but the SSRF-adjacent image exposure and the
visitor-visible grid wipe are cheap to close and were found by an audit — leaving them open
means the next audit reports them again. The `Cache-Control` and `enabled` checks also make
the security posture match what the docs already claimed.
**Source:** `src/server.js`, `src/routes/admin.js`, `public/js/app.js`,
`test/app.test.js`, `docs/DEPLOYMENT.md`.

### D13 — Deploy verification must prove the JavaScript ran
**Chosen:** `docs/DEPLOYMENT.md` now has an explicit post-deploy check that the browser
modules resolve and execute, not merely that the page renders.
**Why:** A broken module import (a stray `import` in `public/js/app.js` resolving to a 404)
shipped to production and stayed there: the server-rendered page still looked complete, so
every visible signal said the deploy had worked, while in fact no event listener existed and
no card could be expanded. The regression was only caught when a user reported it. The check
is `data-ssr` absent from `#services` (only `app.js` removes it) plus no unexpected module
requests, and `test/assets.test.js` guards the cause statically.
**Source:** `docs/DEPLOYMENT.md`, `test/assets.test.js`.

### D17 — Public feedback form: email-only delivery, nothing stored
**Chosen:** `/feedback` accepts name + email + message and emails it over SMTP
(`nodemailer`, configured in the admin panel). Submissions are **not persisted**.
Bot defences are an off-screen honeypot, an HMAC-signed timing token
(`src/feedback-token.js`), a per-IP rate limit, a 16 kB body cap, and a global cap on
concurrent outbound sends. A failed send is reported honestly (502/503) and never as a
success.
**Why email-only:** there is no chat transport in this deployment, so a "chat" contact
field would have been a control that silently did nothing — worse than not offering it.
Email is required because it is the only way to reply.
**Why nothing stored:** a public write endpoint that persists is a table an attacker can
fill. Emailing and forgetting means a bot run cannot grow the database, and no visitor
data sits at rest.
**Why honest failure matters most:** the one thing this endpoint must never do is answer
"thanks" when nothing was delivered — that silently loses someone's message. Two tests
exist specifically to pin it (`an unconfigured mailer returns an honest error, never a
fake success`, and the real-SMTP-conversation test that asserts a 200 only follows an
accepted message).
**Decisions inside the decision:**
- **The protocol is derived from the port** (465 implicit TLS, 587 STARTTLS, 25 plain)
  rather than set independently. Letting the two disagree produces a connection that
  hangs until it times out instead of failing clearly. `validateSmtpSettings` derives
  `smtpSecure` from `smtpPort` and ignores any client-supplied value.
- **`smtpPassword` is write-only.** `smtpPublicConfig()` returns `hasPassword` and never
  the value, so it cannot reach an API response, a log line or a rendered page. A test
  asserts the raw response body does not contain it.
- **An omitted password keeps the stored one; `null` clears it.** Without that
  distinction, saving any other field would wipe the credential.
- **Any SMTP port is accepted (1..65535).** The three presets (25/465/587) are offered as
  labelled options, not as the only allowed values. A strict allow-list was wrong: all three
  are privileged ports, so it made a local capture server unreachable and blocked providers
  on non-standard ports. The protocol stays derived from the port — **465 is the only
  implicit-TLS port**, everything else negotiates STARTTLS if offered — so the port and the
  TLS mode cannot be configured into disagreement.
  *Residual exposure, stated plainly:* the mailer will now connect to the configured
  host on any port, so an authenticated admin can point the SMTP dialogue at an unrelated
  service. That was already true of the **host** (a private hostname was never blocked), and
  the write path is admin-only, so this is not a new class of exposure — but the earlier
  claim that a stored port "cannot aim the transport at an unrelated service" is no longer
  true and has been removed.
- **Concurrency is capped globally** (`MAX_CONCURRENT_SENDS`), not just per IP: each send
  holds a socket for up to ~20s, so a distributed source could otherwise exhaust the
  container's file descriptors and take down the whole site, not just the form.
**Known exposure — not solved:** `smtpPassword` is stored **plaintext** in the SQLite
`settings` table, which lives in the `services-data` Docker named volume. No secrets
manager is available in this deployment. Mitigations in place are the non-root container,
read-only rootfs, and no published host port; the correct fix if this ever needs one is a
secrets manager.
**Source:** `src/routes/feedback.js`, `src/feedback-token.js`, `src/mailer.js`,
`src/validate.js`, `src/routes/admin.js`, `src/routes/pages.js`, `src/render-page.js`,
`src/views/feedback.html`, `public/js/feedback.js`, `public/css/style.css`,
`test/feedback.test.js`, `test/feedback-route.test.js`, `test/feedback-audit.test.js`.

### D18 — The first new runtime dependency since the initial four
**Chosen:** `nodemailer@10.0.13`, pinned **exactly** (no caret).
**Why:** targeted directly at the deployed object regardless of which registry is used —
zero dependencies of its own, `MIT-0`, Node ≥20, `npm audit` clean. Hand-rolling SMTP
(AUTH LOGIN/PLAIN, STARTTLS upgrade, MIME encoding, dot-stuffing) was the alternative,
but mail bugs fail *silently* — a mangled body or a missing MIME boundary delivers a
message that looks sent and is wrong — so the trade was a small, well-scoped dependency
over code whose failure mode is invisible.
Pinned exact rather than `^` because a minor release could change send behaviour and this
path's whole value is that it either works or says it didn't.
**Source:** `package.json`, `src/mailer.js`.

### D19 — A destructive admin-panel bug, and the three fixes it needed
**Chosen:** The admin email panel could render **without ever loading**, and a Save then
wrote its empty inputs over a working SMTP configuration. Fixed at three independent
levels, because the first two are about *this* ordering and only the third survives a
future refactor:

1. **Script order.** `admin.js` was a classic script while `feedback.js` was a deferred
   module, so `admin.js` could run `showPanel()` before the email hook existed.
   `window.loadEmailSettings?.()` turned the missing hook into a *silent* no-op — the
   `?.()` made a loud failure quiet, which is how it survived review. `feedback.js` now
   loads first and both are modules, so both defer in document order.
2. **Self-load.** `feedback.js` loads the panel if it is already visible on execution.
3. **A save guard.** `save()` refuses to blank a value the server holds. This is the layer
   that matters: it does not depend on ordering staying correct.
**Why the first guard attempt failed:** it only checked a `loaded` flag, which was already
`true` by the time the inputs were blanked, so the save went through. Reproduced in a
browser (config wiped), then fixed and re-verified (config untouched, "Refusing to save:
… would be cleared").
**Why the rule lives in its own module:** it was originally inside `feedback.js`, which
touches `document` at load and therefore cannot be imported in Node. A destructive rule
was sitting in a browser-only path with **zero test coverage**, which is precisely why a
156-test suite did not catch it. It now lives in `public/js/email-config.js` with tests.
**The guard's false positive, and why it matters more than the bug:** a guard that blocks a
*legitimate* save is worse than the bug it prevents, because it stops the admin configuring
SMTP at all. Two exemptions keep it narrow: a first-time save is always allowed, and
`smtpTo` is exempt because blank is the documented "use the From address" state. A
per-field **Clear** button passes `allowClear` so a deliberate removal still works.
**Source:** `src/views/admin.html`, `public/js/feedback.js`, `public/js/email-config.js`,
`src/templates`… see `test/feedback-audit.test.js` (`fieldsThisSaveWouldClear` cases and the
script-order assertion).

### D20 — Any SMTP port (superseding part of D17)
**Chosen:** The admin form accepts any port in 1..65535, with 25/465/587 offered as
labelled presets. Implicit TLS is still derived from the port, and **465 is the only
implicit-TLS port** — everything else negotiates STARTTLS if the server offers it.
**Why the allow-list was wrong:** all three presets are below 1024 and therefore need root
to bind. A local capture server could not use any of them, so the feature was impossible to
exercise end to end locally without `sudo`, and a real provider on a non-standard port
could not be configured at all. This was found by trying to run the documented local test
flow and having it fail three times.
**Residual exposure, stated plainly:** the mailer will connect to the configured host on
any port, so an authenticated admin can aim the SMTP dialogue at an unrelated service. That
was already true of the **host** (a private hostname was never blocked) and the write path
is admin-only, so it is not a new class of exposure — but D17's earlier claim that a stored
port "cannot aim the transport at an unrelated service" is **no longer true**, and was
removed rather than left standing.
**Source:** `src/validate.js`, `src/mailer.js`, `src/views/admin.html`,
`public/js/feedback.js`, `scripts/capture-smtp.mjs`, `test/feedback.test.js`.

### D21 — One accent hue, chosen in the admin panel
**Chosen:** The site has exactly **one** highlight colour, picked in the admin panel
(Site settings → Accent colour) and stored in the `settings` table as `accentColor`.
Five options: **Amber** (the default — the site's original `#ffb800` yellow), Violet,
Cyan, Emerald and Rose. The value is validated on write (`validateSettings` → 400 for
anything not in the list), normalised on read (`settingsFrom` → `normalizeAccent`), rendered
into `<html data-accent="…">` on every page, and exposed on `/api/site`. In CSS it is five
tokens — `--accent`, `--accent-rgb`, `--accent-solid`, `--on-accent`, `--grad-accent` — which
each accent block re-points. The purple (`--accent`/`--accent-2`), cyan (`--accent-2`), pink
(`--accent-3`) and yellow (`--accent-yellow`, `--warm-*`, `--gradient`, `--hero-title`) tokens
are **gone**: every component that used them now reads the accent. `btn.warm` and
`btn.primary` — the same button under two names once one hue replaced the yellow/blue pair —
became one rule (`.btn.primary`).
**Why:** The site was visibly two design systems at once. The buttons and the brand tile were
purple→cyan, the hero, headings and hovers were yellow, and the detail popup's primary action
("Open" on an expanded card) was never themed at all — it was the purple gradient, next to a
yellow accent, on the same screen. One hue removes the clash, and putting it in the admin
panel means the site's identity can be re-tuned without a deploy. Amber stays the default, so
an install that never opens the picker renders exactly what it rendered before.
**Why server-rendered rather than a script:** the same reasoning as the theme
([D15](#d15--theme-selector-cookie-rendered-server-side-three-themes)) — the palette is in the
first byte, so there is no flash of the previous accent, and the credits page applies it with
no script at all. Unlike the theme it is **not** a per-visitor preference: it is a site
setting, so it comes from the DB rather than a cookie, and `app.js` patches it from `/api/site`
on the 60s poll so an open page follows an admin's change.
**Why the palettes are hand-tuned rather than derived:** a hue bright enough to read as text
on near-black (`#08090d`) is unreadable on the light background (`#f4f5f9`), so each accent
needs a dark and a light set. They are written out as hex and *checked by computation*
(`test/theme.test.js` calculates WCAG ratios) rather than derived with `color-mix()`, because a
derived value cannot be asserted without a browser in the test suite — and a palette that fails
contrast is invisible in review.
**The cost, and how it is contained:** CSS cannot share a declaration block between a plain
selector and a media query, so each accent's light values are declared **twice** (explicit
light, and `system` + a light OS) — 5 accents × 3 blocks = 15 blocks, which is a lot of colour
data in one file. `test/theme.test.js` holds it together: every accent must define exactly the
five tokens in all three blocks, the two light copies must be identical, and the amber block
must repeat the `:root` values (otherwise the picker's amber chip would be painted with
whatever accent is in force). The same file computes fill/on-fill ≥ 4.5:1 and
accent-on-background ≥ 4.5:1 for every accent in both themes, and asserts that every
`var(--…)` the stylesheet reads is declared somewhere — a reference to a removed token fails
*silently* at computed-value time, which is exactly the failure mode this collapse could leave
behind.
**Decisions inside the decision:**
- **`--accent-solid` / `--on-accent` are separate from `--accent`.** A fill is a different
  problem from display text: dark takes the hue as it is with near-black text (11:1 for amber),
  light darkens it until white clears AA. Hover *lifts* the primary button rather than
  brightening it, for the same reason ([D15](#d15--theme-selector-cookie-rendered-server-side-three-themes)).
- **Light-mode amber moved `#b26a00` → `#a15f00`.** The old value measured 3.89:1 against the
  light background — under AA for the small uppercase section headings that use it. The new one
  is 4.64:1. It is the tightest pair in the set (as is violet's `#100520`-on-`#8b5cf6` at
  4.66:1), which is why the contrast test computes ratios rather than checking hex values: a
  later tweak to `--bg` would trip it instead of quietly shipping.
- **The picker's chips carry their own `data-accent`**, so the accent blocks match any element
  carrying the attribute, not just `:root`: each chip is painted with the accent it offers, and
  in a light theme it shows the light value it would actually apply.
- **The brand tile's glyph follows `--on-accent`** (the `#i-logo` sprite is `stroke="currentColor"`
  now). It was hard-coded white, which is unreadable on an amber tile — and the tile itself now
  takes the accent gradient, since the purple→cyan gradient was one of the two hues being
  collapsed.
- **Links:** `a { color: var(--accent) }`, and the hover affordance is an underline for
  classless anchors (`a:not([class]):hover`). With one hue there is no second colour to shift to,
  and the previous `a:hover { color: var(--accent) }` would have been a no-op. Every link the
  site actually renders has its own class and its own hover rule (muted/text → accent).
- **`.btn` gained a `:focus-visible` ring** on the accent, like every other control: the UA
  default was visible but off-palette, which left the buttons the odd ones out.
- **The picker's swatch paints `--accent-solid`, not `--accent`** — in light mode those differ
  (the fill is the darker one white text sits on), and a picker should show what it will paint.
- **`::selection` no longer forces white text**, which was unreadable on a light-theme selection
  (and on a bright accent in dark mode); the text keeps its own colour.
- **A request that omits `accentColor` leaves it alone.** `validateSettings` skips undefined
  keys, and `admin.js` only sends the key when a radio is checked — so a settings save from a
  panel whose picker failed to render (or an older client) cannot silently reset the site's
  accent to the default. Pinned by a test.
- **Rejected: a per-visitor accent selector in the drawer.** It would be a second control beside
  the theme selector for a value only the site owner has an opinion about, and the accent is what
  the *cards, buttons and brand* look like — an identity, not a reading preference.
**Source:** `public/js/render.js` (`ACCENTS`/`normalizeAccent`/`accentOptionsHtml`),
`public/css/style.css`, `src/validate.js`, `src/public-data.js`, `src/render-page.js`,
`src/views/*.html`, `public/js/admin.js`, `public/js/app.js`, `test/theme.test.js`,
`test/app.test.js`, `test/menu.test.js`.

### D22 — The page copy is editable, and seeded once

**Decision:** the prose on the feedback and credits pages lives in the database and is edited
in a new **Page text** panel, instead of in the view templates. The copy the pages shipped with
is inserted by `migrate()` as a seed, so the upgrade is invisible.

**Context:** the feedback intro, both subtitles, the credits note and the credit lines
were hardcoded in `src/views/feedback.html` and `src/views/credits.html`. Changing a word meant
a code change and a deploy — and the owner edits this copy often. The constraint was that
nothing may look different afterwards: the seeded values are byte-for-byte the previous
template text, with the templates' source line-wrapping collapsed to single spaces so a
paragraph is one line of text. Verified before deploying by diffing the rendered `<main>` of
both pages against the live VPS output: identical apart from inter-tag whitespace.

**Why seed rather than fall back:** an empty database still has to render the site as it looked,
so the values cannot simply be absent. But a *read-time* fallback would make a field impossible
to empty — clearing the subtitle in the panel would silently restore the default. Seeding
inserts a real value once; from then on an empty setting means empty, and the pages render
nothing rather than an empty `<p>`. Both halves of that are pinned by `test/content.test.js`.

**Why the credit lines are seeded behind a marker:** "seed when the table is empty" looks
equivalent and is not — deleting every line is a legitimate edit, and a boot would resurrect
them. The `creditsSeeded` settings key makes the seed a one-time event, which the tests
exercise by deleting the rows, editing the copy, and running `migrate()` a second time.

**Where the data lives:** four `settings` keys (`feedbackSubtitle`, `feedbackIntro`,
`creditsSubtitle`, `creditsNote`) and a new `credits` table (`role`, `value`, optional `url`,
`sort_order`). They are deliberately **not** in `SETTING_KEYS`: that array defines the
`/api/site` payload, and no public page fetches this copy — the server renders it into the
first byte like the rest of the site (D11). The admin API gets its own resource
(`/api/admin/content`, `/api/admin/credits`) instead of widening the site-metadata contract.

**Reordering:** the credit lines are reordered by dragging a handle in the admin panel, and the
finished order is written in one request (`PUT /api/admin/credits/order`). The endpoint takes
the *complete* list and refuses anything else with 409, so a stale panel (another tab added or
deleted a line) cannot leave rows with duplicate or missing positions. Two admins reordering
concurrently is last-write-wins — the id set is identical, so a stale order is indistinguishable
from a fresh one, and with a single admin that is not worth a version column. Only the handle is
`draggable` — a draggable row fights text selection inside its own inputs — and the arrow keys
on a focused handle perform the same move, which keeps reordering reachable without a pointer.
The admin panel's own `change`-on-blur save per line is deliberate: a line is a small unit, and
the alternative (one big form) would make a typo in one line block the others.

**The page-text save guard:** the panel's fields are empty until `/api/admin/content` resolves,
so the form submits only the fields whose value differs from the last content read
(`public/js/page-text-config.js`). Sending all four would let a save from a not-yet-loaded panel
write empty strings over the stored copy — and because a cleared field is a legitimate value
that nothing restores, that would be unrecoverable. This is D19's bug class in a second panel;
the logic lives in its own module so it can be unit-tested in Node, as `email-config.js` is.

**Rejected:**
- *A rich-text editor.* The copy is plain prose; `renderParagraphs` plus escaping is the whole
  feature, and a WYSIWYG would be a dependency and an XSS surface for no gain.
- *Making the credit lines' fields part of the settings JSON.* They are an ordered list that
  needs its own identity for editing and reordering; a JSON blob in `settings` would have to be
  parsed, validated and re-serialised on every write.

**Source:** `src/content-defaults.js`, `src/db.js` (`credits` table + seeding + CRUD),
`src/validate.js` (`validatePageText`/`validateCredit`), `src/public-data.js` (`pageText`/
`listPublicCredits`), `src/render-page.js`, `src/routes/admin.js`, `src/views/feedback.html`,
`src/views/credits.html`, `src/views/admin.html`, `public/js/render.js`,
`public/js/admin.js`, `public/css/style.css`, `test/content.test.js`.

### D23 — Services are ordered by dragging, not by a number

**Decision:** the services table is reordered by dragging a handle, exactly like the credit
lines (D22). The numeric **Sort order** field is gone from the service form and the read-only
**Order** column is gone from the table: one way to set the order, not two that can disagree.

**Context:** `sort_order` was editable only as a number in the service form, so putting a
service between two others meant reading two numbers off the table and typing a third —
and two services left at `0` were silently ordered by name, which looked like the order had
been ignored. The credit-line editor added in D22 already had the interaction the owner wanted.

**What changed beyond the UI:** `sortOrder` became *optional* in `validateService`. An absent
value now means "append" on create (`nextPosition('services')`, so a new service goes to the end
instead of tying at 0) and "leave the position alone" on update. The API still accepts an
explicit `sortOrder`, so a client that wants a specific position is unaffected. `PUT
/api/admin/services/order` is registered *before* `/services/:id` — Express matches in
registration order, and a `PUT` to `/services/order` would otherwise be read as a service id and
rejected.

**Ordering and the poll:** the admin table re-renders every 60s. A re-render landing mid-drag
would destroy the row being dragged, so the drag helper exposes `busy()` (dragging or saving)
and the *poll's* reload (`pollServices()`) returns early while it is true. Every user action
(add, edit, delete, Refresh) renders directly instead: a user cannot be mid-drag while clicking
Delete, and holding those back would leave a deleted row on screen until the next poll. Verified
in a browser by starting a drag and clicking Refresh: the rows survive the refresh, and a refresh
after the drop rebuilds them. `reorderServices` shares `applyOrder()` with `reorderCredits`, so
both endpoints have the same contract: the complete id list, or 409.

**Accepted:** a drag that the admin cancels with Escape still writes the order it previewed —
`dragend` fires on cancel too, and the only signal that distinguishes the two (`dropEffect ===
'none'`) is not reliable enough across browsers to gate a write on. Re-dragging is cheap and the
preview makes the pending order visible.

**Rejected:** keeping the number as an extra field. Two sources of truth for the same order is
how the panel and the homepage end up disagreeing; the API keeps the escape hatch for anyone who
needs it, and the panel does not offer it.

**Source:** `src/db.js` (`nextPosition`/`applyOrder`/`reorderServices`), `src/validate.js`,
`src/routes/admin.js`, `src/views/admin.html`, `public/js/admin.js`,
`public/css/style.css`, `test/app.test.js`.

### D24 — The accent chips are painted in the accent they offer

**Decision:** every chip in the accent picker is drawn in its own accent — label, border, tint
and swatch — instead of five grey chips where only the selected one is coloured. The chip in
force is marked with a solid border *and* a check mark, because colour alone can no longer say
which one is selected.

**Why the check mark:** making every chip coloured removes the only signal the old design had.
A second, non-colour signal was needed, and a check mark reads without relying on hue.

**The contrast trap this design walked into:** the palette clears AA by a thin margin — amber in
light mode is 4.64:1 on the plain background, violet in dark mode 4.70:1 — and a chip tint eats
exactly that margin: 8% put amber/light at 4.19:1 and violet/dark at 4.32:1, both below the bar
the accent tests enforce. The label therefore takes the theme's *darker* hue: `--accent-solid` in
light mode (5.29:1 worst case) and `--accent` in dark (6.72:1), with hover deepening the tint
(worst case 4.76:1). `test/theme.test.js` composites the tint read out of the stylesheet and
asserts every accent in both themes and both states, and it reads *which token* the label uses
from the CSS — so switching it back fails the test rather than passing against a hard-coded
expectation.

**A bug this surfaced:** the chips are `<label>` elements inside the "Accent colour" `.field`, so
the panel's `.field label` rule (specificity 0,1,1) was beating the chip's own class rule
(0,1,0) for colour, font-family, font-size and font-weight — the chips had been rendering in the
field label's grey display font all along. Fixed at the source by scoping that rule to
`.field > label` (a field's own label is its direct child; nested labels are components), pinned
by a test that fails if the descendant form returns.

**Rejected:** the mini-primary-button variant (a solid accent fill per chip). It previews the
button accurately but five filled buttons compete with the actual Save button, and it has less
contrast headroom than the tinted chip in light mode.

**Source:** `public/js/render.js` (`accentOptionsHtml`), `public/css/style.css`,
`test/theme.test.js`.

### D25 — Backup and restore are one gzipped JSON archive, applied by category

**Decision:** the admin panel gains a **Backup & restore** panel. *Download backup* writes every
piece of state the repository does not own — the settings table, the services (with their
uploaded icons and thumbnails, which live in the database as base64), and the credit lines —
into a single gzipped JSON file. *Restore from a backup* opens a two-step dialog: a warning with
a confirmation checkbox and a file picker, then, once the file has been uploaded and validated,
an overview of six resource categories with a checkbox each. Restoring replaces the selected
categories; it never merges.

**Context:** production is a plain file copy on the homeserver and the database lives in a
Docker named volume (D8). Everything the owner has configured — the copy, the accent, the site
icon, every service and its artwork — exists in exactly one place, and the only way to move or
recover it was to stop the container and copy a SQLite file by hand. The same gap made the
deployment flow's pre-deploy snapshot (`VACUUM INTO`) the only safety net, which is a database
file the owner cannot open.

**Why gzip rather than zip:** `node:zlib` is built in, and the repository's rule is no new
runtime dependencies. The archive is base64 artwork, which compresses, and a `.json.gz` is still
`gunzip | jq` away from being readable — a zip would have bought a directory listing and cost a
dependency.

**Why JSON and not a copy of the SQLite file:** a database file can only be restored whole, by
replacing the volume — it cannot be partially applied, it cannot be validated before it is
trusted, and its contents (including the `sessions` table) are invisible to both the admin and
the tests. A described archive can be inspected, refused, counted per category, and applied
selectively. It also survives schema changes that a raw file copy would not.

**Why three endpoints and a staging step:** `GET /backup`, `POST /restore/inspect`,
`POST /restore/apply`. The file is uploaded and *fully validated* at inspect time, held in
memory against an opaque id bound to the session, and then applied by id. The archive never
travels back through the browser, so a tampered apply request can only choose which categories
to write, never what goes into them — and a file that could not be restored is refused while
nothing has been staged, rather than after the admin has committed to it.

**Why the raw body parser sits on the route, after `requireAuth`:** it was first mounted
app-wide on the inspect path, next to the feedback route's tighter JSON limit. That is the
wrong side of the auth check — body-parser buffers the whole request before any middleware can
refuse it, so an anonymous client could pin 16 MB per connection against a container capped at
256 MB. Registered on the route instead, an unauthenticated upload is refused before a byte is
buffered, and it still works because `express.json` skips a non-JSON content-type without
consuming the stream. The caps themselves (12 MB upload, 24 MB expanded via
`maxOutputLength`, so a 33 kB file cannot expand into gigabytes) are sized so one worst-case
inspect peaks well inside `mem_limit: 256m` rather than relying on the allocator being lucky,
and only one validated upload is staged at a time for the same reason.

**Why the SMTP password is excluded:** the archive is a file the admin downloads and may park in
a cloud folder. The rest of the SMTP configuration is included, and a restore leaves the stored
password untouched, so the only cost is retyping one field after restoring onto a fresh machine.
`creditsSeeded` (D22's one-time seed marker) and the `sessions` table are excluded for the same
reason in different directions: neither is content, and restoring either would respectively
resurrect deleted credit lines or carry a login to another machine.

**Why replace rather than merge:** "restore" that silently keeps rows the archive does not
mention leaves a system that is neither the old one nor the new one, and there is no way to tell
from the panel which rows were kept. Replace-per-category is what the confirmation checkbox
says, and it is the only semantics under which the archive is a *backup* — something that
reproduces a state rather than blending into one.

**Why a pre-restore snapshot:** the modal can say "make a backup first" and then not rely on it.
Before applying, the server writes the current state to `<BACKUP_DIR>` as an ordinary archive —
the same format, so it can be fed straight back through the same dialog — keeps the five most
recent, and lists them in the panel with a download link. A restore the admin regrets is
therefore undoable with the UI they already have, not with a database console.

**Why the snapshot name has millisecond resolution:** the name has to do two jobs at once — be
unique per restore, and sort chronologically as a plain string, because `listSnapshots` derives
"newest first" from the name so nothing has to parse it. Second resolution fails the first job:
two restores inside one second collide, and the file being overwritten is the *earlier* restore's
undo point, which is the one thing the mechanism exists to protect. A `-2` suffix fixes
uniqueness and breaks the second job — `-` sorts below `.`, so `…-150323-2.json.gz` sorts
*before* `…-150323.json.gz` and the newer snapshot is listed as the older one. The write
therefore uses `wx` (refuse to overwrite) and resolves a collision by nudging the timestamp one
millisecond forward, which keeps "a greater name is a newer file" true. Both jobs are pinned by
`test/backup.test.js`, which passes the same instant twice and asserts the two names differ and
still sort correctly.

**Why the settings are stored as raw strings:** the archive is a copy of the database, and a
conversion layer on the way out would need a matching one on the way in, with a drift between
them the day a key is added. Validation is per group and reuses the admin panel's own validators
(`validateSettings`, `validatePageText`, `validateSmtpSettings`, `validateService`,
`validateCredit`), so a restored value cannot be one the panel would refuse to save. The two
boolean-ish keys are converted on the way in and back on the way out; `smtpSecure` is *not*
trusted from the archive but re-derived from the port, exactly as the panel derives it, so a
hand-edited pair cannot leave the mailer inconsistent.

**A bug this surfaced:** the new router is mounted on `/api/admin` ahead of the admin router, and
its `router.use(requireAuth)` was unscoped — so it ran for *every* `/api/admin/*` request,
including `/api/admin/login`, and refused the login with a 401 before the admin router ever saw
it. `test/backup.test.js` pins it with an explicit "the login endpoint is not shadowed" test;
the fix is to scope both middlewares to the prefixes this router owns (`/backup`, `/restore`).

**Rejected:**
- *A zip archive.* Familiar, but there is no built-in zip writer; it would add the repository's
  sixth runtime dependency to gain nothing the gzip file does not already do.
- *Copying the SQLite file.* See above — whole-only, unvalidatable, and it would carry the
  sessions table.
- *Merging on restore.* Two sources of truth for the same content, with no way to see which one
  won.
- *Storing the staged upload in the database.* The staging area is deliberately in memory with a
  15-minute TTL: an upload that is never confirmed must leave no trace, and a table would have to
  be migrated, pruned and cleaned up on every boot.

**Source:** `src/backup.js`, `src/routes/backup.js`, `src/db.js` (`transaction`,
`deleteSettings`, `replaceServices`, `replaceCredits`), `src/validate.js` (`isPngBase64`),
`src/config.js` (`backupDir`), `src/server.js`, `src/views/admin.html`, `public/js/admin.js`,
`public/css/style.css`, `test/backup.test.js`.

### D26 — The wallpaper is an uploaded image plus placement settings, seeded once from the bundled photo

**Decision:** the ambient background becomes an admin setting. *Site settings* gains a
**Wallpaper** block (below *Site icon & favicon*, above *Save settings*): a preview thumbnail
with **Upload** and **Delete**, an **Anchor** select (centre / top / bottom / left / right), a
**Size** select (cover / contain / stretch / tile / natural), a **Background colour** picker and
a **Wallpaper transparency** slider (0–100%).

The image is stored as base64 PNG in the `settings` table under `wallpaperPng`, exactly like the
site icon, and served from `GET /wallpaper.jpg`. The placement keys — `wallpaperAnchor`,
`wallpaperSize`, `wallpaperTransparency`, `backgroundColor` — are ordinary site settings: they
save with the existing **Save settings** button, while the image itself uploads and deletes
immediately, the way the icon does. The backdrop renders as **three layers**: the colour, the
wallpaper over it, and the theme's readability wash over both.

**Context:** the backdrop had always been a hard-coded `url('/img/bg.jpg')` in `style.css`, so the
owner could not change the one piece of the site's appearance that dominates every page. Making it
editable had to satisfy one hard constraint: **an upgraded deployment must look identical until
the admin changes something.** The site is dark-first and the wash is what keeps text readable
over an arbitrary photo, so a wrong default would have been immediately visible to every visitor.

**Why the seed is a marker-guarded migration, not a default value:** the first boot on a database
with no `wallpaperSeeded` key copies `public/img/bg.png` into `wallpaperPng` and writes the
marker, in one transaction. Guarding on the *marker* rather than on "the value is empty" is what
makes Delete work: clearing the value is how the wallpaper is deleted, and a boot must not put it
back. A default value in the stylesheet could not express that.

**Why three layers instead of one element with a `background-image`:** the transparency slider has
to fade the *wallpaper* without fading the wash. Fading both together would drop the text below AA
exactly when the admin picked a bright wallpaper — the opposite of what the slider is for. So
`.bg-color` (z −3), `.bg-photo` (z −2, carrying `--wp-image` and `--wp-opacity`) and `.bg-overlay`
(z −1, `--photo-overlay` at full strength) are separate elements, all behind the page; `html` has
no background of its own, so `body`'s is propagated to the canvas and still shows if everything is
turned off.

**Why PNG, given a photograph compresses far smaller as JPEG:** every image this app stores is
validated by its PNG signature — the icon upload, the thumbnail upload, the restore path, and now
the seed. One definition of "an image this app will store", enforced at every door, is worth the
bytes. The transparency slider fades the wallpaper with CSS opacity rather than alpha in the file,
so nothing needs JPEG's advantage.

**Why the cap is 2 100 000, and why the seed is truecolour:** the first version of this feature
seeded a **256-colour quantized** copy of the bundled photo (525 kB) and set the cap at 750 000 —
sized so that the seed cleared it by 3%. That was internally consistent and still wrong, because
the *seed* and the *upload path* have to produce the same kind of image and they did not: a canvas
`toDataURL('image/png')` always emits truecolour, so the site's own default re-encoded by the panel
came to **1 926 880 characters**, 2.6× the cap. Deleting the wallpaper and re-uploading the image
it shipped with silently produced a **softer 800px** backdrop. The cap was raised to clear what the
browser actually produces, and the bundled asset was replaced with a truecolour PNG of the same
pixels. Measured: the seed is 1 497 300 characters on disk and 1 926 880 through Chromium's canvas;
1 700 000 was tried first and still downscaled, because the panel's ladder aimed at a 90% "budget"
that no upload can spend. That budget was removed — the body parser's own headroom is what carries
the JSON envelope, and a client-side limit stricter than the server's only refuses uploads the
server would have accepted, without leaving a log entry.

**Why the ladder still exists at 2 100 000:** the cap is not the size of a *typical* upload, it is
the ceiling. PNG size is driven by pixel detail, and the spread is extreme: a synthetic test pattern
at 1920 wide is 726 600 base64 characters, while the same frame with sensor-style noise is
**7 297 832** — and it only reaches the cap at ~640px. Without the ladder those photos would be
refused outright, client-side, with nothing in the server's logs. The panel therefore tries
1920 → 1600 → 1280 → 1024 → 800 → 640 → 480 and **reports the width it settled on**, so a downscale
is visible to the admin rather than discovered later on the live site.

**What the larger cap costs**, measured rather than estimated: the SQLite row is ~2.0 MB of text
(TEXT stores at 1 byte/char, so the file grows by the payload and no more), a backup archive grows
to ~2.4 MB gzipped, and the restore path's peak working set is ~6 MB — about 2.4% of the
container's `mem_limit: 256m`. For reference, the archive caps in `src/backup.js` are 12 MB upload
and 24 MB expanded, so a single wallpaper is nowhere near them.

**Two consequences of the seed being a one-time migration, both closed:**

*An archive from before the wallpaper existed restores an empty wallpaper category, and an empty
category deletes what is deployed* (replace, not merge — D25). The restore modal defaults every
box to checked, so a default restore would have removed a live wallpaper with nothing in the UI to
say so. `summarize()` now takes the live settings and sets a `clears` flag on any image category
whose archive holds none while the deployment holds one; the modal renders it as an amber line on
that row. The box stays checked — the admin is entitled to restore everything, and this is a
consequence to weigh rather than an error to prevent.

*If `public/img/bg.png` is missing at first boot, the marker must not be written.* Recording "the
wallpaper was seeded" for a database with no wallpaper would make the absence permanent — the
delete-guard would have nothing to protect, and recovery would mean an admin upload — on a restart
caused by a file the operator can simply put back. The read failure now returns before the marker,
so the seed is retried at the next boot and the database is left untouched. An upgraded deployment
in that state shows its background colour instead of the photo, which is the honest rendering of
"the asset was not there".

**Rejected alternatives:**
- *A file on the data volume.* The production container's root filesystem is read-only and only
  the data volume survives a recreate, so a file would need its own persistence story — and its own
  path through backup/restore — that the database already provides for every other uploaded image.
- *JPEG for a smaller payload.* It was the first implementation, and it was broken: the validator
  accepts only PNG, so *every* upload was refused with "wallpaper must be a PNG data URL" while the
  test suite passed, because the tests posted a hand-made PNG rather than the panel's own output.
  Fixed by making the encoder match the validator, and guarded by a test that reads the encoder.
- *Quantizing client-side to keep the smaller cap.* Would have mirrored how the bundled asset was
  made and kept the file small. Rejected because it means hand-rolling a quantizer in the panel for
  a saving of roughly one megabyte in three places, and because banding on a photo that is not as
  forgiving as this one's smooth aurora is a quality regression that arrives silently.
- *Raising the cap far enough for incompressible noise.* 7.3M characters is ~5.5 MB of image for a
  background. The ladder handles that case by downscaling instead, which is bounded and visible.
- *A fixed-vs-scrolling option.* Built, then **removed**. The backdrop is a `position: fixed`
  layer the size of the viewport, so `background-attachment: fixed` and `scroll` render
  identically, and a narrow viewport forced `scroll` for every choice anyway. A control with no
  observable effect is worse than no control.
- *Seeding by copying the file into the database at every boot.* Would resurrect a deleted
  wallpaper, which is the exact behaviour Delete exists to prevent.

**Source:** `public/js/render.js` (`WALLPAPER_ANCHORS`, `WALLPAPER_SIZES`, `DEFAULT_WALLPAPER`,
`backgroundHtml`, `wallpaperOptionsHtml`), `src/db.js` (`seedWallpaper`), `src/public-data.js`,
`src/validate.js` (`MAX_WALLPAPER_BASE64`, `isWallpaperDataUrl`, `isWallpaperBase64`),
`src/routes/admin.js`, `src/server.js`, `src/backup.js` (the `wallpaper` category),
`src/render-page.js`, `src/views/*.html`, `public/js/admin.js`, `public/css/style.css`,
`public/img/bg.png`, `test/wallpaper.test.js`.


## Review findings addressed

### Backup & restore (D25)

Security audit (gate: PASSED, no Critical/High) and code review found no Critical/High. The
Medium + Low findings were all fixed:
- The raw body parser was mounted app-wide on `/api/admin/restore/inspect`, i.e. *before*
  `requireAuth` — an anonymous client could pin a full-size body per connection against the
  256 MB container. Moved onto the route, behind the auth middleware. [`src/routes/backup.js`]
- Memory headroom: the caps are now 12 MB upload / 24 MB expanded (sized so one worst-case
  inspect peaks well inside `mem_limit: 256m`), and only one validated upload is staged at a
  time instead of three. [`src/backup.js`]
- A snapshot name with second resolution could be overwritten by a same-second restore,
  destroying the earlier undo point; now millisecond resolution with `wx` and a nudge.
  [`src/backup.js`]
- A crafted archive with a multi-megabyte key name produced a multi-megabyte error response;
  key names are capped in validation messages. [`src/backup.js`]
- The inspect route is rate-limited, like login. [`src/routes/backup.js`]
- An unwritable `BACKUP_DIR` returned a bare 500 before the transaction; it now says so.
  [`src/routes/backup.js`]
- `apply` with a missing or non-string `uploadId` answered 409 "expired" instead of 400.
  [`src/routes/backup.js`]
- Tests added for the paths the review found uncovered: a full six-category restore asserting
  ids, order and the `'0'` half of both boolean-ish keys (and that the restored credits are not
  re-seeded by the next `migrate()`), the parser's 413, the 400 for a malformed `apply`, and the
  snapshot collision. Two existing tests were made self-contained. [`test/backup.test.js`]

Security audit (gate: PASSED, no Critical/High) and code review found no Critical/High. The
following Medium + quick wins were fixed:
- Blind SSRF in the health checker (private-IP block + redirect cap). [`src/health.js`]
- Health-check fallback widened to 400/401/403/404/405/406/501, timeout reset per attempt, and
  network/TLS errors now return `down` instead of throwing. [`src/health.js`]
- Error handler returns 400/413 for client errors instead of masking as 500. [`src/server.js`]
- Status page + admin now poll every 60s (real "live"); admin toast text corrected. [`public/js/`]
- `unknown` status no longer counted as "all operational". [`public/js/app.js`]
- Removed dead `SESSION_SECRET` requirement (sessions are DB-backed random tokens). [`src/config.js`]
- Reject weak placeholder admin password in production. [`src/config.js`]
- Container hardening (init, cap_drop, no-new-privileges, read-only, tmpfs, limits, named volume). [`docker-compose.yml`]
- Added tests: health checker (private-IP, up/down/redirect/HEAD→GET/network error), error handler,
  404, invalid ids. [`test/`]

## Remaining LOW / Info (deferred)

### Backup & restore (D25)
- The restore dialog's browser half (the checkbox gating Verify, the file picker, the category
  list, the post-restore panel refresh) has no automated coverage; `docs/DEVELOPMENT.md` says so
  and the flow was walked by hand against a throwaway database. The server half is covered.
- A restored service shows `unknown` until the next health tick (up to `HEALTH_CHECK_INTERVAL`),
  and an in-flight probe can write a stale status to a restored row with the same id for at most
  one interval. Both are transient and self-healing.
- A failure inside `applyRestore` that is not an `ArchiveError` leaves the staged upload in place
  until its 15-minute TTL, so the admin can retry without re-uploading. `MAX_STAGED` bounds that
  to one archive.

- Invalidate existing sessions when the admin password rotates.
- Login rate-limiter keyed on IP only (safe while the app stays unexposed on `proxy-net`).
- Optional: move inline `style=` attributes to the stylesheet to drop `style-src 'unsafe-inline'`.
- Add `npm audit` to CI.
- **Pre-existing accessibility findings** (present before the fold-out menu; not introduced by
  it, and left alone rather than fixed as a drive-by): Lighthouse flags `heading-order` on the
  card `<h3>` elements (the page goes `h1` → `h3`) and `label-content-name-mismatch` on
  `.card-desc-btn` (its `aria-label="More about …"` does not contain its visible description
  text). Fixing them means changing the card markup or the button's accessible name, which is
  a card-level decision rather than a menu one.

### D27 — The generalised fork: vibefolio

**Decision:** this repository is **vibefolio**, a generalised, re-brandable template forked
from the private **macjuu.com** services page. Everything that identified the macjuu instance
was stripped or made deployment-configurable, so a fresh checkout boots as a neutral,
generic showcase that any site can adopt.

**What changed (the macjuu-specific → the generalised):**

- **Identity.** Package name, container names, the backup archive format and filenames
  (`macjuu-backup` → `vibefolio-backup`), User-Agent strings, log lines, the drawer's app
  name (`APP_NAME`), and the boot-time brand fallback all became `vibefolio`.
- **Brand fallbacks.** Every code path that defaulted to the `macjuu.com` domain (page
  titles, OG `<title>`, brand label, meta descriptions, the 404 page) now falls back to a
  neutral `vibefolio` or a generic sentence ("…the person who runs this site."). The real
  site title is, and always was, an admin setting.
- **Seed copy** (`src/content-defaults.js`). The witty, instance-specific feedback intro
  (the "swarm of artificial agents" paragraphs), the hard-coded credits (OpenCode, NanoClaw,
  OC-ZEN, Marvin) and the credits note were replaced with neutral placeholder copy and four
  factual credit lines (Node.js, Express, Lucide, Google Fonts). Because the copy was already
  editable (D22), every deployment replaces these in the admin panel.
- **Instance data.** The live SQLite database (`data/`), with the macjuu service list and
  backups, does not ship here. A fresh boot seeds an empty services table; the wallpaper is
  still seeded once from `public/img/bg.png` (D26).
- **Docs.** README, AGENTS.md, ARCHITECTURE, DEPLOYMENT and DEVELOPMENT now describe a
  general-purpose deployment (example domains, `<your-org>` placeholders) while keeping the
  original deployment mechanics, which transfer unchanged.

**What was deliberately left alone:** the architecture, the data model, the API surface, the
"service" terminology, and every decision D1–D26. This fork is a re-branding and a
generalisation, not a redesign — the decisions above were the product of the original
instance's history, and they remain the rationale for how the app works here too.

**Why keep provenance in AGENTS.md and the README:** a fork without lineage is confusing for
the next maintainer ("why is the backup format called vibefolio-backup?"). The docs say
plainly where this came from, and D22's "seeded once" guarantee survives: an existing
database keeps whatever copy its admin saved; only a fresh database gets the neutral seed.

**Rejected:** keeping the macjuu branding as defaults "because it is editable anyway" — the
whole point of a template is that a new deployment does not have to undo someone else's
identity; and renaming the `service` entity to `item`/`resource`, which would have churned
the schema, API and tests for no functional gain (the entity was already a generalised,
admin-editable resource).

**Source:** this entire commit. See the diff for the per-file list.
