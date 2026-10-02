# screenshot-service

Headless-Chromium screenshot service used to capture **service thumbnails** for the
homepage cards. It runs the official [`browserless/chrome`](https://docs.browserless.io/)
image as a separate container — the app container stays small and dependency-free.

## How it works

- The admin panel's **"Capture from URL"** button calls
  `POST /api/admin/services/:id/thumbnail/capture` on the app.
- The app calls the screenshot service:
  `POST /screenshot?token=<token>` with a JSON body
  `{ "url": "<service-url>", "options": { "type": "png", "clip": { "x": 0, "y": 0, "width": 640, "height": 360 } } }`.
- The returned PNG is validated and stored in the app's SQLite DB as the service
  thumbnail, served at `/service-thumb/:id.png`.

## Network

The service is attached only to the dedicated **`screenshot-net`** bridge network
(defined in `docker-compose.yml`). It has **no published port** and is **not** on
`proxy-net`, so only the app container can reach it. It does need outbound internet
to screenshot the (public) service URLs.

## Configuration

| Variable | Where | Purpose |
|----------|-------|---------|
| `BROWSERLESS_TOKEN` | `.env` (shared) | Auth token; the app sends it as the `?token=` query param, the service requires it via `TOKEN` |
| `BROWSERLESS_URL` | app env (compose) | Where the app reaches the service (default `http://screenshot-service:3000`) |

Generate the token once and put it in `.env`:

```bash
openssl rand -hex 24
```

## Security notes

- The service is internal-only (dedicated network, no published port) — it is not
  reachable from nginx-proxy-manager or the internet.
- The app only sends it validated `http(s)` service URLs from the DB.
- The container runs with `init`, `no-new-privileges`, and memory/CPU limits.
  `cap_drop: ALL` is intentionally **not** applied — Chromium needs capabilities
  to run; the network isolation is the primary control here.
- The image is a third-party dependency (`browserless/chrome`) — pin the tag once
  you've verified a version works, and track its updates.