# Deployment — vibefolio

Production runs on the **homeserver** (the "VPS"). This document records how the original
deployment works so any session can reproduce it — the mechanics transfer to any host.
Connection details (host, port, user, keys) live in `~/.ssh/config` under the alias
**`homeserver`** — they are **not** in this repo.

## Model

- The deploy directory on the homeserver is **`/home/<user>/projects/vibefolio`** (use your
  own user; the original was an ordinary unprivileged account).
- It is **not a git repository** — no `.git`, no remote, no CI/CD. It is a plain file copy
  of this repo, kept in sync with `rsync`.
- The app runs as a single Docker container (`vibefolio`, image
  `vibefolio-services`) via `docker compose`.

## Deploy flow

From the repo root:

```bash
# 1. Sync code to the homeserver, mirroring the local layout.
#    --delete removes stale files (the remote has had layout changes over time).
#    The .env rules come FIRST and in this order: rsync applies the first matching
#    rule, so .env.example is re-included before .env.* sweeps up every other env
#    file (.env.local, .env.production, .env.backup-*). Without it, a local backup
#    of .env — which holds real secrets — is copied straight onto the server.
rsync -av --delete \
  --include '.env.example' \
  --exclude '.env.*' --exclude '.env' \
  --exclude 'node_modules' --exclude '.git' --exclude 'data' \
  ./ homeserver:~/projects/vibefolio/   # replace with YOUR target user + path

# 2. Rebuild + restart the container on the homeserver.
ssh homeserver 'cd ~/projects/vibefolio && docker compose up -d --build'
```

### What the excludes protect

| Excluded | Why |
|----------|-----|
| `.env` | Holds real secrets (`ADMIN_PASSWORD`, `ALLOWED_ORIGINS`), mode 600. **Never overwrite it.** |
| `.env.*` | Backups and local variants of the same secrets (`.env.backup-*`, `.env.local`). Only `.env.example` is re-included. |
| `node_modules` | Not needed on the host — the Docker build runs `npm ci --omit=dev`. |
| `.git` | Not a git repo on the remote. |
| `data/` | The SQLite DB lives in the Docker named volume `services-data` (mounted at `/app/data`), not on the host. |

## Container details (`docker-compose.yml`)

- `container_name: vibefolio`, image built from the local `Dockerfile`
  (`node:24-alpine`, multi-stage, non-root user).
- `env_file: .env` plus `environment:` overrides: `NODE_ENV=production`, `PORT=3000`,
  `DB_PATH=/app/data/services.db`.
- Attached to the external **`proxy-net`** network; **no host port published** — nginx-proxy-manager
  routes to `vibefolio:3000` by container name.
- Hardened: `init`, `cap_drop: ALL`, `no-new-privileges`, read-only rootfs, tmpfs `/tmp`,
  `mem_limit: 256m`, `cpus: 0.5`, healthcheck on `/api/site`.

## Verification after deploy

```bash
ssh homeserver 'docker ps --filter name=vibefolio --format "{{.Status}}"'
# expect: Up ... (healthy)

# API check from inside the container:
ssh homeserver 'docker exec vibefolio node -e \
  "fetch(\"http://127.0.0.1:3000/api/services\").then(r=>r.json()).then(d=>console.log(d.services.length, \"services\"))"'
```

### Assert the JavaScript actually ran, not just that the page looks right

A broken module import still serves **plausible HTML**: the server-rendered page looks
complete, but `app.js` never executes, so every event listener is missing (no card
expansion, no live polling) and nothing errors visibly on the page. This has shipped
before, so it is checked explicitly:

```bash
# 1. Every module the browser fetches must return 200 (a 404 kills the whole module).
for f in /js/app.js /js/render.js /js/chrome.js; do
  printf '%-16s %s\n' "$f" "$(curl -s -o /dev/null -w '%{http_code}' "https://your-domain.example$f?v=$(curl -s https://your-domain.example/ | grep -oE "$f\?v=[0-9]+" | grep -oE '[0-9]+$')")"
done

# 2. No browser module may reference server-only code (would 404 as a module fetch).
curl -s "https://your-domain.example/js/app.js?v=<N>" | grep -c "asset-version"   # expect 0
```

Then in the browser, with the network panel open:

- `#services` must **not** still have `data-ssr` (app.js consumes it on first paint) —
  `document.querySelector('#services').dataset.ssr === undefined` proves the module ran.
- No request to `/asset-version.js` (or any other unexpected path).
- The header hamburger opens the drawer, and the drawer's numbers match `/api/services` —
  `document.querySelector('#menu-toggle').click()` then
  `document.querySelector('#drawer').classList.contains('open')` must be `true`.
  This is the check that catches a stale `chrome.js`: the server-rendered drawer still looks
  complete without it, and the only other visible symptom is a hamburger that does nothing.
- Set a theme, reload, and confirm the palette is already correct in the first byte:
  `curl -s -H 'Cookie: theme=light' https://your-domain.example/ | grep -o 'data-theme="[a-z]*"'`
  must print `data-theme="light"`.
- Zero console errors.

`npm test` covers both statically (`test/assets.test.js`: browser modules may only import
files that exist under `public/`, and every view must agree with `ASSET_VERSION`), but the
live check is what proves the deployed artefact, not the repo.

## Secrets & governance

- `.env` is gitignored (see `.gitignore`) and must never be committed or copied into the
  repo. All secrets come from the environment.
- The repo's hosting is up to the deployer (the upstream copy is at
  `github.com/niels-emmer/vibefolio`). Do not add
  secrets, tokens, or credentials to any file.
- `ALLOWED_ORIGINS` in the remote `.env` must include the public origin (e.g.
  `https://your-domain.example`) or the admin API's CSRF Origin check will reject browser
  requests.

## Rollback

The previous image is still present on the host after a rebuild. To roll back:

```bash
ssh homeserver 'cd ~/projects/vibefolio && docker compose down && \
  docker compose up -d --build'   # rebuild from the previous file copy
```

(There is no image tag history — the practical rollback is re-syncing the previous code and
rebuilding. The DB in `services-data` is untouched by rebuilds.)

## Backups (`BACKUP_DIR`)

The admin panel's **Backup & restore** feature ([D25](decisions.md)) writes a pre-restore
snapshot before every restore. `BACKUP_DIR` is unset in `.env`, so it defaults to a `backups`
directory beside the database — `/app/data/backups` in the container, i.e. **inside the
`services-data` volume**. That is deliberate: the rootfs is read-only, so anywhere else would
fail mid-restore, and it means the snapshots survive a rebuild.

Two consequences worth knowing:

- They are **not** on the host filesystem, so a host-side backup directory (e.g.
  `~/vibefolio-backups/`) does not contain them. To pull one out:
  `docker cp vibefolio:/app/data/backups/<name>.json.gz ~/vibefolio-backups/`.
- Removing the `services-data` volume removes them with the database. The panel lists the five
  most recent and offers a download; anything older is pruned.

`docker compose exec vibefolio sh -c 'ls -l /app/data/backups'` is the quick check that
the directory exists and the `app` user can write to it.