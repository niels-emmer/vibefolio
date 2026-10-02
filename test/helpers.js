// Test setup: configure env BEFORE importing the app (config reads env at load).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.DB_PATH = ':memory:';
// Pre-restore snapshots are real files (src/backup.js). With an in-memory DB the default
// backup directory would resolve to `<repo>/backups`, so the suite gets a throwaway one.
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibefolio-backups-'));
process.env.HEALTH_CHECK_INTERVAL = '3600'; // don't auto-run checks in tests
process.env.LOGIN_RATE_LIMIT = '1000'; // don't trip the login limiter across tests
// The feedback suite makes many submissions from one IP, so the production default of 5
// would make the tests order-dependent and flaky. This raises the limit for the suite;
// it does NOT exercise the production value — no test asserts the 429, which is a
// documented gap (docs/DEVELOPMENT.md).
process.env.FEEDBACK_RATE_LIMIT = '1000';

export async function startTestServer() {
  const { createApp } = await import('../src/server.js');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  // Exposed so a test can set `app.locals.feedbackTestOptions` — the in-process seam
  // used to exercise a real SMTP send against a local stub on an ephemeral port.
  // See docs/decisions.md D17 for why this exists instead of loosening validation.
  return { server, app, base };
}

export async function login(base, password = 'test-password') {
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] || '';
  return { res, cookie };
}
