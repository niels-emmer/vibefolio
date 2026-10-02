# Security

`vibefolio` is a self-hosted services-showcase app. The public page is meant to be
world-readable; everything under `/admin` and `/api/admin` is private. This document
describes the threat model, the controls in place, and the risks that are knowingly
accepted.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately via
[GitHub private vulnerability reporting](https://github.com/niels-emmer/vibefolio/security/advisories/new).
You will get an acknowledgement within a few days and a fix is published as a release once
ready.

## Threat model

| Asset | Exposure | Protection |
|---|---|---|
| Public showcase page + `/api/site`, `/api/services` | Internet | Public by design; read-only |
| Feedback form (`/feedback`, `POST /api/feedback`) | Internet, when enabled | Email-only delivery — nothing is stored. Honeypot, HMAC timing token, per-IP rate limit, 16 kB body cap |
| Admin panel (`/admin`, `/api/admin/*`) | Internet | Password login + DB-backed session cookie, login rate limit, Origin CSRF check |
| SQLite database + uploaded artwork | The container's data volume | Gitignored, never served except via the public image endpoints (`/site-icon.png`, `/favicon.png`, `/wallpaper.jpg`, `/service-icon/:id.png`, `/service-thumb/:id.png`) |
| SMTP credentials | The `settings` table | Never reach `/api/site` (outside `SETTING_KEYS`); `smtpPassword` is excluded from every backup and is write-only in the API |
| Admin password / tokens | Environment / database | `ADMIN_PASSWORD` from the environment only; `.env` gitignored; a placeholder password is a boot error in production |

The app assumes it runs behind a TLS-terminating reverse proxy (the compose file attaches
to an external reverse-proxy network, default `proxy-net` configurable via `PROXY_NETWORK`,
and publishes **no** host port). It does not implement TLS itself.

## Authentication & sessions

- **Password check** — constant-time comparison over fixed-length SHA-256 digests.
- **Sessions** — 32-byte random tokens stored in SQLite, set as an `HttpOnly`,
  `SameSite=Strict` cookie (gated to `Secure` in production). Default TTL 12 h
  (`SESSION_TTL_HOURS`). Stored sessions are invalidated when `ADMIN_PASSWORD` rotates.
- **Login rate limiting** — `LOGIN_RATE_LIMIT` (default 10) attempts per IP per 15
  minutes. The client IP is read from `X-Forwarded-For`; only the peer named by
  `TRUST_PROXY_IP` is trusted to supply it, which closes the spoofing hole on shared
  Docker networks.
- **CSRF** — `SameSite=Strict` is the primary defence; an Origin allow-list check
  (`ALLOWED_ORIGINS` plus same-origin) rejects state-changing requests with a
  disallowed `Origin` header, or with a session cookie and no `Origin` at all.

## Input handling

- **SQL** — every query is parameterised (`?` placeholders). No string-built SQL.
- **HTML** — every interpolated value passes through `esc()` in `public/js/render.js` on
  the server *and* in the browser; page templates are server-rendered from `src/views/`.
- **Validation** — all admin input is validated in `src/validate.js` (services, settings,
  page copy, credit lines, the wallpaper, icons); unknown keys are ignored; over-long
  values are rejected.
- **Images** — uploads are validated by PNG signature and size-capped at upload, on
  restore, and in the wallpaper seed, so a hostile file cannot be seated through a path
  the panel would refuse.
- **HTTP** — strict CSP (`default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`), referrer policy `no-referrer`, HSTS when served over TLS
  (production, or `HSTS_ENABLED=1`), `no-store` on the admin API, tight JSON body limits
  (16 kB for feedback, sized caps elsewhere).

## Health checks & SSRF

The health checker probes each enabled service URL. To make it safe against SSRF it
resolves the hostname **once**, pins the connection to the validated address (closing
DNS-rebinding), refuses private/loopback/link-local/reserved ranges unless
`HEALTH_ALLOW_PRIVATE=1`, and follows redirects manually, re-validated per hop, capped at
5.

## Backup & restore

- The gzipped JSON archive is fully validated before any write; a restore applies selected
  categories inside **one transaction**.
- `smtpPassword`, the seed markers, `sessions`, and the health-checker's runtime columns
  are deliberately **never** in an archive.
- An uploaded archive is validated and staged in memory, bound to the session that
  uploaded it (15-minute TTL); the apply request names a server-side id rather than
  re-sending the file.
- A pre-restore snapshot is written before every restore so a regretted restore is
  undoable with the same UI.

## Deployment hardening

The container runs as a **non-root** user with `init`, `cap_drop: ALL`,
`no-new-privileges`, a read-only root filesystem (tmpfs for `/tmp`), `mem_limit`,
`cpus` and `pids_limit` bounds, no published port, and a healthcheck on `/api/site`. The
database lives on the named `services-data` volume.

## Known accepted risks

- **The SMTP password is stored plaintext** in the `settings` table (inside the Docker
  volume). No secrets manager is available in the reference deployment; mitigations are
  the non-root container, read-only rootfs, and no published host port (see
  `docs/decisions.md` D17 for the full statement).
- **Single admin password** — one shared credential, no per-user accounts and no MFA.
  The login rate limit and the boot-time placeholder check are the mitigations.
- **Rate limiter keying** — per client IP; the trust placed in `TRUST_PROXY_IP` is
  exactly the scope of that IP being a trusted reverse proxy.
- **Feedback, when enabled, emails the recipient configured in the admin panel** — a
  hijacked SMTP config can route submissions anywhere; this is admin-only, and the form is
  off by default.
- **A restored service's status is `unknown`** until the next health tick — transient by
  design (runtime state is never backed up).