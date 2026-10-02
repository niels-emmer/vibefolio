import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, login } from './helpers.js';
import { ACCENTS } from '../public/js/render.js';
import { setSetting } from '../src/db.js';

let server, base;

before(async () => {
  ({ server, base } = await startTestServer());
});

after(() => server.close());

test('public site returns empty settings and services', async () => {
  const site = await (await fetch(`${base}/api/site`)).json();
  assert.equal(site.siteTitle, '');
  const svc = await (await fetch(`${base}/api/services`)).json();
  assert.deepEqual(svc.services, []);

  // With nothing configured, the server-rendered homepage shows the empty state
  // straight away — no skeleton placeholders left to flash.
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /class="empty-state"/);
  assert.doesNotMatch(html, /class="service-card/);
});

test('admin endpoints reject unauthenticated requests', async () => {
  const res = await fetch(`${base}/api/admin/services`);
  assert.equal(res.status, 401);
});

test('login with wrong password is rejected', async () => {
  const { res } = await login(base, 'wrong');
  assert.equal(res.status, 401);
});

test('login with correct password sets a session cookie', async () => {
  const { res, cookie } = await login(base);
  assert.equal(res.status, 200);
  assert.match(cookie, /^sid=/);
});

test('authenticated CRUD lifecycle for services', async () => {
  const { cookie } = await login(base);
  const auth = { Cookie: cookie, Origin: base };

  // Create
  const create = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'My App', url: 'https://example.com', description: 'A test', icon: '🚀' }),
  });
  assert.equal(create.status, 201);
  const { service } = await create.json();
  assert.equal(service.name, 'My App');
  assert.equal(service.status, 'unknown');

  // List
  const list = await (await fetch(`${base}/api/admin/services`, { headers: auth })).json();
  assert.equal(list.services.length, 1);

  // Update
  const update = await fetch(`${base}/api/admin/services/${service.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'Renamed', url: 'https://example.org', enabled: false }),
  });
  assert.equal(update.status, 200);
  const updated = (await update.json()).service;
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.enabled, false);

  // Public list excludes disabled
  const pub = await (await fetch(`${base}/api/services`)).json();
  assert.equal(pub.services.length, 0);

  // Delete
  const del = await fetch(`${base}/api/admin/services/${service.id}`, {
    method: 'DELETE',
    headers: auth,
  });
  assert.equal(del.status, 200);
  const after = await (await fetch(`${base}/api/admin/services`, { headers: auth })).json();
  assert.equal(after.services.length, 0);
});

// --- Service order (D23) ----------------------------------------------------

// The admin panel orders services by dragging them, so the API takes the complete new
// order — and a new service is appended rather than tying at 0, which is what the old
// numeric "Sort order" field used to do.
test('services can be reordered, and the order reaches the public list', async () => {
  const { cookie } = await login(base);
  const auth = { Cookie: cookie, Origin: base };
  const json = { 'Content-Type': 'application/json', ...auth };

  const created = [];
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    const res = await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name, url: `https://${name.toLowerCase()}.example.com` }),
    });
    assert.equal(res.status, 201);
    created.push((await res.json()).service);
  }

  try {
    // Created without a position, each one lands at the end.
    assert.deepEqual(created.map((s) => s.sortOrder), [0, 1, 2]);

    // Drag the last one to the front.
    const ids = created.map((s) => s.id);
    const res = await fetch(`${base}/api/admin/services/order`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ ids: [ids[2], ids[0], ids[1]] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).services.map((s) => s.name), ['Charlie', 'Alpha', 'Bravo']);

    // The public list and the rendered homepage follow the same order — one source of
    // truth, so a drag cannot leave the panel and the site disagreeing.
    const pub = await (await fetch(`${base}/api/services`)).json();
    assert.deepEqual(pub.services.map((s) => s.name), ['Charlie', 'Alpha', 'Bravo']);
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.indexOf('Charlie') < html.indexOf('Alpha'), 'the homepage should follow the new order');

    // A partial, duplicated or unknown list would leave rows with duplicate or missing
    // positions, so it is refused rather than half-applied.
    for (const [body, status] of [
      [{ ids: ids.slice(1) }, 409],
      [{ ids: [ids[0], ids[0], ids[1]] }, 409],
      [{ ids: [ids[0], ids[1], 999999] }, 409],
      [{ ids: ['1', ids[0], ids[1]] }, 400],
      [{ ids: 'nope' }, 400],
    ]) {
      const bad = await fetch(`${base}/api/admin/services/order`, { method: 'PUT', headers: json, body: JSON.stringify(body) });
      assert.equal(bad.status, status, JSON.stringify(body));
    }
    // Nothing moved.
    assert.deepEqual((await (await fetch(`${base}/api/admin/services`, { headers: auth })).json()).services.map((s) => s.name), ['Charlie', 'Alpha', 'Bravo']);
  } finally {
    for (const s of created) await fetch(`${base}/api/admin/services/${s.id}`, { method: 'DELETE', headers: auth });
  }
});

test('updating a service leaves its position alone, and an explicit sortOrder still works', async () => {
  const { cookie } = await login(base);
  const auth = { Cookie: cookie, Origin: base };
  const json = { 'Content-Type': 'application/json', ...auth };

  const make = async (name) =>
    (await (await fetch(`${base}/api/admin/services`, { method: 'POST', headers: json, body: JSON.stringify({ name, url: `https://${name}.example.com` }) })).json()).service;

  const first = await make('first');
  const second = await make('second');
  try {
    // A form save no longer sends sortOrder, so an edit must not move the service.
    const update = await fetch(`${base}/api/admin/services/${first.id}`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ name: 'first', url: 'https://first.example.com', description: 'edited' }),
    });
    assert.equal(update.status, 200);
    const updated = (await update.json()).service;
    assert.equal(updated.sortOrder, first.sortOrder);
    assert.equal(updated.description, 'edited');

    // The field is still accepted for API clients that place a service explicitly.
    const placed = await fetch(`${base}/api/admin/services/${second.id}`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ name: 'second', url: 'https://second.example.com', sortOrder: 0 }),
    });
    assert.equal(placed.status, 200);
    const placedService = (await placed.json()).service;
    assert.equal(placedService.sortOrder, 0);

    // ...and a negative or fractional one is still rejected.
    for (const sortOrder of [-1, 1.5, '0']) {
      const bad = await fetch(`${base}/api/admin/services/${second.id}`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ name: 'second', url: 'https://second.example.com', sortOrder }),
      });
      assert.equal(bad.status, 400, `sortOrder ${JSON.stringify(sortOrder)} should be rejected`);
    }
  } finally {
    for (const s of [first, second]) await fetch(`${base}/api/admin/services/${s.id}`, { method: 'DELETE', headers: auth });
  }
});

test('the service order endpoint requires a session', async () => {
  const res = await fetch(`${base}/api/admin/services/order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(res.status, 401);
});

test('invalid service URL is rejected', async () => {
  const { cookie } = await login(base);
  const res = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ name: 'Bad', url: 'ftp://nope' }),
  });
  assert.equal(res.status, 400);
});

// --- GitHub repo field ------------------------------------------------------

test('githubRepo accepts owner/repo shorthand and normalizes it', async () => {
  const { cookie } = await login(base);
  const create = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ name: 'Repo', url: 'https://example.com', githubRepo: 'owner/my-repo' }),
  });
  assert.equal(create.status, 201);
  const { service } = await create.json();
  assert.equal(service.githubRepo, 'https://github.com/owner/my-repo');

  // Exposed on the public API.
  const pub = await (await fetch(`${base}/api/services`)).json();
  const listed = pub.services.find((s) => s.id === service.id);
  assert.equal(listed.githubRepo, 'https://github.com/owner/my-repo');
});

test('githubRepo accepts a full github.com URL', async () => {
  const { cookie } = await login(base);
  const create = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ name: 'Repo2', url: 'https://example.com', githubRepo: 'https://github.com/owner/repo' }),
  });
  assert.equal(create.status, 201);
  assert.equal((await create.json()).service.githubRepo, 'https://github.com/owner/repo');
});

test('githubRepo rejects non-github URLs and malformed values', async () => {
  const { cookie } = await login(base);
  for (const bad of ['https://gitlab.com/owner/repo', 'not a repo', 'owner', 'ftp://github.com/x/y']) {
    const res = await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Bad', url: 'https://example.com', githubRepo: bad }),
    });
    assert.equal(res.status, 400, `expected 400 for "${bad}"`);
  }
});

test('githubRepo can be cleared on update', async () => {
  const { cookie } = await login(base);
  const create = await (
    await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Repo3', url: 'https://example.com', githubRepo: 'owner/repo' }),
    })
  ).json();
  const id = create.service.id;

  const update = await fetch(`${base}/api/admin/services/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ name: 'Repo3', url: 'https://example.com', githubRepo: '' }),
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).service.githubRepo, '');
});

test('settings can be saved and read back', async () => {
  const { cookie } = await login(base);
  const put = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ siteTitle: 'My Services', homepageTitle: 'Welcome', siteDescription: 'Hello' }),
  });
  assert.equal(put.status, 200);
  const pub = await (await fetch(`${base}/api/site`)).json();
  assert.equal(pub.siteTitle, 'My Services');
  assert.equal(pub.homepageTitle, 'Welcome');
  assert.equal(pub.siteDescription, 'Hello');
});

test('showStats setting defaults to true and can be toggled off', async () => {
  const { cookie } = await login(base);

  // Default: true (not set yet).
  let pub = await (await fetch(`${base}/api/site`)).json();
  assert.equal(pub.showStats, true);

  // Toggle off.
  const put = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ showStats: false }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).settings.showStats, false);

  // Reflected on the public API.
  pub = await (await fetch(`${base}/api/site`)).json();
  assert.equal(pub.showStats, false);

  // Toggle back on.
  const put2 = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ showStats: true }),
  });
  assert.equal(put2.status, 200);
  pub = await (await fetch(`${base}/api/site`)).json();
  assert.equal(pub.showStats, true);
});

test('showStats rejects non-boolean values', async () => {
  const { cookie } = await login(base);
  const res = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ showStats: 'yes' }),
  });
  assert.equal(res.status, 400);
});

// --- Accent (D21) -----------------------------------------------------------

// The accent is a *site* setting (unlike the theme, which is per visitor), so it has
// to reach the first byte of every page and the public API, and it has to survive the
// round trip through the admin panel that sets it.
test('the accent round-trips from the admin panel to every page', async () => {
  const { cookie } = await login(base);

  // Default: amber, and it is in the first byte of the page (no flash, no script).
  assert.equal((await (await fetch(`${base}/api/site`)).json()).accentColor, 'amber');
  assert.match(await (await fetch(`${base}/`)).text(), /<html lang="en" data-theme="dark" data-accent="amber">/);

  const put = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ accentColor: 'violet' }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).settings.accentColor, 'violet');
  assert.equal((await (await fetch(`${base}/api/site`)).json()).accentColor, 'violet');

  // All four views carry it. `/feedback` 404s unless the feature is on, so it is
  // switched on for the loop and off again after (the rest of this file expects the
  // default).
  setSetting('feedbackEnabled', '1');
  try {
    for (const page of ['/', '/credits', '/admin', '/feedback']) {
      assert.match(await (await fetch(`${base}${page}`)).text(), /data-accent="violet"/, page);
    }
  } finally {
    setSetting('feedbackEnabled', '0');
  }

  // The picker offers every accent, each chip carrying the accent it offers, with the
  // current one pre-checked so the panel agrees with the page before any script runs.
  const admin = await (await fetch(`${base}/admin`)).text();
  for (const id of ACCENTS.map((a) => a.id)) {
    assert.match(admin, new RegExp(`data-accent="${id}"`), `the picker should offer ${id}`);
  }
  assert.match(admin, /<input type="radio" name="accentColor" value="violet" checked \/>/);

  // Back to the default, so the other tests in this file see an untouched site.
  await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ accentColor: 'amber' }),
  });
});

test('an unknown accent is rejected, and a stored one is normalised on read', async () => {
  const { cookie } = await login(base);

  const res = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ accentColor: 'chartreuse' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /accentColor must be one of/);

  // Omitting the key entirely must preserve the stored accent rather than reset it —
  // the path `admin.js` relies on when its radios did not render (a settings save from
  // an older panel, or a form whose markup changed). Every other field in the same
  // request is still written.
  await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ accentColor: 'rose' }),
  });
  const other = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ siteFooter: 'No accent in this request' }),
  });
  assert.equal(other.status, 200);
  const after = (await other.json()).settings;
  assert.equal(after.accentColor, 'rose', 'a request without accentColor must not change it');
  assert.equal(after.siteFooter, 'No accent in this request');

  // A value that reached the settings table some other way — a hand-edited row, an
  // older build — must not reach a page: the read model normalises it to the default
  // rather than rendering an attribute the stylesheet has no palette for.
  setSetting('accentColor', 'chartreuse');
  assert.equal((await (await fetch(`${base}/api/site`)).json()).accentColor, 'amber');
  assert.match(await (await fetch(`${base}/`)).text(), /data-accent="amber"/);
  setSetting('accentColor', '');
});

test('logout invalidates the session', async () => {
  const { cookie } = await login(base);
  await fetch(`${base}/api/admin/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
  const res = await fetch(`${base}/api/admin/services`, { headers: { Cookie: cookie, Origin: base } });
  assert.equal(res.status, 401);
});

test('cross-origin state-changing request is rejected (CSRF)', async () => {
  const { cookie } = await login(base);
  const res = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ name: 'X', url: 'https://example.com' }),
  });
  assert.equal(res.status, 403);
});

test('same-origin state-changing request is allowed (CSRF)', async () => {
  const { cookie } = await login(base);
  const res = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: base,
    },
    body: JSON.stringify({ name: 'Y', url: 'https://example.com' }),
  });
  assert.equal(res.status, 201);
});

test('state-changing request with session cookie but no Origin is rejected', async () => {
  const { cookie } = await login(base);
  const res = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, // no Origin — not a browser
    body: JSON.stringify({ name: 'Z', url: 'https://example.com' }),
  });
  assert.equal(res.status, 403);
});

test('sessions are invalidated when the admin password changes', async () => {
  const { cookie } = await login(base);
  const { config } = await import('../src/config.js');
  const original = config.adminPassword;
  try {
    config.adminPassword = 'rotated-password';
    const res = await fetch(`${base}/api/admin/services`, { headers: { Cookie: cookie, Origin: base } });
    assert.equal(res.status, 401);
  } finally {
    config.adminPassword = original;
  }
});

test('malformed JSON body returns 400, not 500', async () => {
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /json/i);
});

test('unknown API path returns 404', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
});

test('credits page is served publicly', async () => {
  const res = await fetch(`${base}/credits`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Credits/);
  assert.match(html, /nodejs\.org/);
  assert.match(html, /expressjs\.com/);
  assert.match(html, /lucide\.dev/);
  assert.match(html, /fonts\.google\.com/);
});

test('credits page renders its brand + favicon server-side from the settings', async () => {
  const { cookie } = await login(base);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;

  // With a site icon set, the credits page must ship the custom icon in the
  // first byte rather than swapping it in after a fetch (which was visible as a
  // flash of the default logo + favicon).
  await fetch(`${base}/api/admin/icon`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ siteIcon: dataUrl, favicon: dataUrl }),
  });
  const cached = await fetch(`${base}/credits`);
  assert.equal(cached.headers.get('cache-control'), 'no-cache');
  const html = await cached.text();
  assert.match(html, /class="brand has-custom-icon"/);
  assert.match(html, /<link rel="icon" href="\/favicon\.png" type="image\/png" id="favicon-link" \/>/);
  // No client-side icon swap is needed any more.
  assert.doesNotMatch(html, /site-icon\.js/);

  await fetch(`${base}/api/admin/icon`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } });
  const after = await (await fetch(`${base}/credits`)).text();
  assert.match(after, /class="brand"/);
  assert.match(after, /href="\/favicon\.svg"/);
});

test('invalid and missing service ids return proper errors', async () => {
  const { cookie } = await login(base);
  const putBad = await fetch(`${base}/api/admin/services/notanid`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ name: 'x', url: 'https://example.com' }),
  });
  assert.equal(putBad.status, 400);
  const delMissing = await fetch(`${base}/api/admin/services/99999`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: base },
  });
  assert.equal(delMissing.status, 404);
});

// --- Site icon / favicon ---------------------------------------------------

const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('icon upload stores and serves site icon + favicon', async () => {
  const { cookie } = await login(base);
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;

  const put = await fetch(`${base}/api/admin/icon`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ siteIcon: dataUrl, favicon: dataUrl }),
  });
  assert.equal(put.status, 200);

  // Servers return the exact stored bytes as image/png.
  for (const path of ['/site-icon.png', '/favicon.png']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.subarray(0, 8).equals(Buffer.from(PNG_1x1, 'base64').subarray(0, 8)));
  }

  // hasIcon is reported to public and admin.
  const site = await (await fetch(`${base}/api/site`)).json();
  assert.equal(site.hasIcon, true);
  const settings = await (await fetch(`${base}/api/admin/settings`, { headers: { Cookie: cookie, Origin: base } })).json();
  assert.equal(settings.settings.hasIcon, true);
});

test('icon upload rejects non-PNG payloads', async () => {
  const { cookie } = await login(base);
  const res = await fetch(`${base}/api/admin/icon`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ siteIcon: 'data:image/png;base64,AA==', favicon: 'not-a-data-url' }),
  });
  assert.equal(res.status, 400);
});

test('icon reset removes stored icons', async () => {
  const { cookie } = await login(base);
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;
  await fetch(`${base}/api/admin/icon`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ siteIcon: dataUrl, favicon: dataUrl }),
  });
  const del = await fetch(`${base}/api/admin/icon`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } });
  assert.equal(del.status, 200);
  const res = await fetch(`${base}/site-icon.png`);
  assert.equal(res.status, 404);
  const site = await (await fetch(`${base}/api/site`)).json();
  assert.equal(site.hasIcon, false);
});

// --- Per-service icon upload ------------------------------------------------

test('service icon upload is stored and served', async () => {
  const { cookie } = await login(base);
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;

  const create = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ name: 'Iconed', url: 'https://example.com', iconImage: dataUrl }),
  });
  assert.equal(create.status, 201);
  const { service } = await create.json();
  assert.equal(service.iconImage, PNG_1x1);

  // Served as PNG for the homepage.
  const img = await fetch(`${base}/service-icon/${service.id}.png`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await img.arrayBuffer());
  assert.ok(buf.subarray(0, 8).equals(Buffer.from(PNG_1x1, 'base64').subarray(0, 8)));

  // Exposed as a boolean on the public API.
  const pub = await (await fetch(`${base}/api/services`)).json();
  const listed = pub.services.find((s) => s.id === service.id);
  assert.equal(listed.iconImage, true);
});

test('service icon can be removed via update', async () => {
  const { cookie } = await login(base);
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;
  const create = await (
    await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Iconed2', url: 'https://example.com', iconImage: dataUrl }),
    })
  ).json();
  const id = create.service.id;

  const clear = await fetch(`${base}/api/admin/services/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ name: 'Iconed2', url: 'https://example.com', iconImage: null }),
  });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).service.iconImage, null);
  const img = await fetch(`${base}/service-icon/${id}.png`);
  assert.equal(img.status, 404);
});

test('invalid service iconImage is rejected', async () => {
  const { cookie } = await login(base);
  const res = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ name: 'Bad', url: 'https://example.com', iconImage: 'not-a-png' }),
  });
  assert.equal(res.status, 400);
});

test('service icon can be auto-saved via the dedicated endpoint', async () => {
  const { cookie } = await login(base);
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;
  const create = await (
    await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Auto', url: 'https://example.com' }),
    })
  ).json();
  const id = create.service.id;

  const put = await fetch(`${base}/api/admin/services/${id}/icon`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ iconImage: dataUrl }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).service.iconImage, PNG_1x1);

  // Clear via the same endpoint.
  const clear = await fetch(`${base}/api/admin/services/${id}/icon`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ iconImage: null }),
  });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).service.iconImage, null);
});

// --- Thumbnails -------------------------------------------------------------

test('thumbnail upload is stored and served', async () => {
  const { cookie } = await login(base);
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;
  const create = await (
    await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Thumbed', url: 'https://example.com' }),
    })
  ).json();
  const id = create.service.id;

  const put = await fetch(`${base}/api/admin/services/${id}/thumbnail`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ thumbnailImage: dataUrl }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).service.thumbnailImage, PNG_1x1);

  // Served as PNG for the homepage.
  const img = await fetch(`${base}/service-thumb/${id}.png`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  // Exposed as a boolean on the public API.
  const pub = await (await fetch(`${base}/api/services`)).json();
  const listed = pub.services.find((s) => s.id === id);
  assert.equal(listed.thumbnailImage, true);
});

test('thumbnail can be removed via update', async () => {
  const { cookie } = await login(base);
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;
  const create = await (
    await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Thumbed2', url: 'https://example.com' }),
    })
  ).json();
  const id = create.service.id;
  await fetch(`${base}/api/admin/services/${id}/thumbnail`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ thumbnailImage: dataUrl }),
  });

  const clear = await fetch(`${base}/api/admin/services/${id}/thumbnail`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ thumbnailImage: null }),
  });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).service.thumbnailImage, null);
  const img = await fetch(`${base}/service-thumb/${id}.png`);
  assert.equal(img.status, 404);
});

test('invalid thumbnail is rejected', async () => {
  const { cookie } = await login(base);
  const create = await (
    await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'BadThumb', url: 'https://example.com' }),
    })
  ).json();
  const id = create.service.id;
  const res = await fetch(`${base}/api/admin/services/${id}/thumbnail`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ thumbnailImage: 'not-a-png' }),
  });
  assert.equal(res.status, 400);
});

test('thumbnail capture fails gracefully when the screenshot service is unreachable', async () => {
  const { cookie } = await login(base);
  const create = await (
    await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Capture', url: 'https://example.com' }),
    })
  ).json();
  const id = create.service.id;
  // BROWSERLESS_URL defaults to http://screenshot-service:3000, which does not
  // resolve in the test environment → the capture should fail with 502.
  const res = await fetch(`${base}/api/admin/services/${id}/thumbnail/capture`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
  });
  assert.equal(res.status, 502);
});

// --- Service detail fields (tech stack, AI details, story, audience) --------

test('detail fields round-trip through create, admin list, and public API', async () => {
  const { cookie } = await login(base);
  const create = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({
      name: 'Detailed',
      url: 'https://example.com',
      techStack: ['Next.js', 'TypeScript', 'SQLite'],
      aiDetails: 'Compiles rules to 12 agent frameworks.',
      story: 'Built entirely by AI agents.',
      audience: 'open-source',
    }),
  });
  assert.equal(create.status, 201);
  const { service } = await create.json();
  assert.equal(service.techStack, 'Next.js|TypeScript|SQLite');
  assert.equal(service.aiDetails, 'Compiles rules to 12 agent frameworks.');
  assert.equal(service.story, 'Built entirely by AI agents.');
  assert.equal(service.audience, 'open-source');

  // Admin list returns the same values.
  const list = await (await fetch(`${base}/api/admin/services`, { headers: { Cookie: cookie, Origin: base } })).json();
  const listed = list.services.find((s) => s.id === service.id);
  assert.equal(listed.techStack, 'Next.js|TypeScript|SQLite');
  assert.equal(listed.audience, 'open-source');

  // Public API exposes them for the detail popup.
  const pub = await (await fetch(`${base}/api/services`)).json();
  const pubSvc = pub.services.find((s) => s.id === service.id);
  assert.equal(pubSvc.techStack, 'Next.js|TypeScript|SQLite');
  assert.equal(pubSvc.aiDetails, 'Compiles rules to 12 agent frameworks.');
  assert.equal(pubSvc.story, 'Built entirely by AI agents.');
  assert.equal(pubSvc.audience, 'open-source');
});

test('techStack accepts a comma/pipe-separated string and trims tags', async () => {
  const { cookie } = await login(base);
  const create = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({
      name: 'Tags',
      url: 'https://example.com',
      techStack: ' FastAPI , React | Vite ',
    }),
  });
  assert.equal(create.status, 201);
  assert.equal((await create.json()).service.techStack, 'FastAPI|React|Vite');
});

test('detail fields default to empty when not provided', async () => {
  const { cookie } = await login(base);
  const create = await (
    await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Plain', url: 'https://example.com' }),
    })
  ).json();
  const s = create.service;
  assert.equal(s.techStack, '');
  assert.equal(s.aiDetails, '');
  assert.equal(s.story, '');
  assert.equal(s.audience, '');
});

test('invalid audience values are rejected', async () => {
  const { cookie } = await login(base);
  for (const bad of ['public', 'everyone', 'OPEN-SOURCE', 'open source']) {
    const res = await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Bad', url: 'https://example.com', audience: bad }),
    });
    assert.equal(res.status, 400, `expected 400 for audience "${bad}"`);
  }
});

test('techStack tag count and length caps are enforced', async () => {
  const { cookie } = await login(base);
  const tooMany = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({
      name: 'Many',
      url: 'https://example.com',
      techStack: Array.from({ length: 11 }, (_, i) => `tag${i}`),
    }),
  });
  assert.equal(tooMany.status, 400);

  const tooLong = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({
      name: 'Long',
      url: 'https://example.com',
      techStack: ['x'.repeat(41)],
    }),
  });
  assert.equal(tooLong.status, 400);
});

test('aiDetails and story length caps are enforced', async () => {
  const { cookie } = await login(base);
  const long = 'x'.repeat(1001);
  for (const field of ['aiDetails', 'story']) {
    const res = await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Long', url: 'https://example.com', [field]: long }),
    });
    assert.equal(res.status, 400, `expected 400 for ${field} over the cap`);
  }
});

test('detail fields can be updated and cleared', async () => {
  const { cookie } = await login(base);
  const create = await (
    await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ name: 'Editable', url: 'https://example.com', audience: 'personal' }),
    })
  ).json();
  const id = create.service.id;

  const update = await fetch(`${base}/api/admin/services/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({
      name: 'Editable',
      url: 'https://example.com',
      techStack: ['Go'],
      aiDetails: 'New AI blurb.',
      story: 'New story.',
      audience: '',
    }),
  });
  assert.equal(update.status, 200);
  const updated = (await update.json()).service;
  assert.equal(updated.techStack, 'Go');
  assert.equal(updated.aiDetails, 'New AI blurb.');
  assert.equal(updated.story, 'New story.');
  assert.equal(updated.audience, '');
});

// --- Server-rendered homepage -----------------------------------------------

test('homepage is server-rendered with the configured site metadata', async () => {
  const { cookie } = await login(base);
  await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({
      siteTitle: 'example.com',
      homepageTitle: 'Vibefolio',
      siteDescription: 'A chaotic suite of projects.',
      siteFooter: 'Running on a 12-year-old laptop.',
      showStats: true,
    }),
  });

  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  // The HTML carries the settings, so it must not sit in a browser cache.
  assert.equal(res.headers.get('cache-control'), 'no-cache');

  const html = await res.text();
  assert.match(html, /<title>Vibefolio — example\.com<\/title>/);
  assert.match(html, /<meta name="description" content="A chaotic suite of projects\." \/>/);
  assert.match(html, /<h1 id="site-title">Vibefolio<\/h1>/);
  assert.match(html, /id="site-description">A chaotic suite of projects\.</);
  assert.match(html, /id="site-footer">Running on a 12-year-old laptop\.</);

  // The placeholder fallbacks must never be served once the copy is configured.
  assert.doesNotMatch(html, /Services — vibefolio/);
  assert.doesNotMatch(html, /Live status and overview of the public services on this site\./);
});

test('index.html redirects to the rendered homepage', async () => {
  const res = await fetch(`${base}/index.html`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/');
});

test('homepage server-renders enabled services as escaped cards', async () => {
  const { cookie } = await login(base);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };

  const create = await fetch(`${base}/api/admin/services`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: '<script>alert(1)</script>',
      url: 'https://xss.example.com',
      description: 'A & B "quoted"',
      icon: '🚀',
    }),
  });
  assert.equal(create.status, 201);
  const { service } = await create.json();

  const html = await (await fetch(`${base}/`)).text();
  // Card is rendered server-side and keyed by id, so app.js can patch it in place.
  assert.match(html, new RegExp(`<article class="service-card[^>]*data-id="${service.id}"`));
  assert.match(html, new RegExp(`data-detail="${service.id}"`));
  assert.match(html, /🚀/);
  // Every dynamic field is escaped — no executable markup, no raw quotes.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /A &amp; B &quot;quoted&quot;/);

  // Disabling a service removes it from the first paint too.
  await fetch(`${base}/api/admin/services/${service.id}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ name: service.name, url: service.url, enabled: false }),
  });
  const after = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(after, new RegExp(`data-id="${service.id}"`));

  await fetch(`${base}/api/admin/services/${service.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: base },
  });
});

test('the server-rendered grid matches the public services API', async () => {
  // The invariant that removes the flash: what the first paint shows is exactly
  // what the API (and therefore app.js) reports.
  const { services } = await (await fetch(`${base}/api/services`)).json();
  const html = await (await fetch(`${base}/`)).text();
  assert.equal((html.match(/class="service-card/g) || []).length, services.length);
  for (const s of services) {
    assert.match(html, new RegExp(`data-id="${s.id}"`), `expected a card for service ${s.id}`);
  }
});

test('homepage stats block follows the showStats setting', async () => {
  const { cookie } = await login(base);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };
  const put = (body) =>
    fetch(`${base}/api/admin/settings`, { method: 'PUT', headers: auth, body: JSON.stringify(body) });

  await put({ showStats: false });
  assert.match(await (await fetch(`${base}/`)).text(), /id="stats" hidden/);

  await put({ showStats: true });
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /id="stats">/);
  assert.doesNotMatch(html, /id="stats" hidden/);
});

// The Credits/Feedback links were removed from the footer at the owner's request;
// navigation lives in the drawer. These pin the replacement behaviour.
test('the footer shows the configured text and nothing else', async () => {
  const { cookie } = await login(base);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };
  const put = (body) =>
    fetch(`${base}/api/admin/settings`, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
  const footerOf = async (path = '/') => {
    const html = await (await fetch(`${base}${path}`)).text();
    return (/<footer class="site-footer">[\s\S]*?<\/footer>/.exec(html) ?? [''])[0];
  };

  await put({ siteFooter: 'Restored footer.' });
  const footer = await footerOf();
  assert.match(footer, /id="site-footer">Restored footer\.</);
  // No navigation links belong in the footer any more.
  assert.doesNotMatch(footer, /href="\/credits"/, 'Credits should not be in the footer');
  assert.doesNotMatch(footer, /href="\/feedback"/, 'Feedback should not be in the footer');
  assert.doesNotMatch(footer, /href="\/"/, 'Services should not be in the footer');
});

test('the footer is omitted entirely when no text is configured', async () => {
  const { cookie } = await login(base);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };
  const put = (body) =>
    fetch(`${base}/api/admin/settings`, { method: 'PUT', headers: auth, body: JSON.stringify(body) });

  // With the links gone the footer has no other content, so rendering an empty bar would
  // be pointless.
  await put({ siteFooter: '' });
  for (const path of ['/', '/credits', '/feedback']) {
    const html = await (await fetch(`${base}${path}`)).text();
    assert.doesNotMatch(html, /class="site-footer"/, `${path} should have no footer when no text is set`);
  }

  await put({ siteFooter: 'Restored footer.' });
  assert.match(await (await fetch(`${base}/`)).text(), /id="site-footer">Restored footer\.</);
});

// /credits used to render an empty-text footer containing only the links, so it showed no
// footer text at all even when one was configured. It now matches every other page.
test('every page shows the configured footer text', async () => {
  const { server, base: b } = await startTestServer();
  const { cookie } = await login(b);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: b };
  try {
    await fetch(`${b}/api/admin/settings`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ siteFooter: 'Shared footer text.' }),
    });
    // /feedback needs the feature enabled to render at all.
    await fetch(`${b}/api/admin/email`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ feedbackEnabled: true }),
    });
    for (const path of ['/', '/credits', '/feedback']) {
      const html = await (await fetch(`${b}${path}`)).text();
      assert.match(html, /id="site-footer">Shared footer text\.</, `${path} should show the footer text`);
    }
  } finally {
    server.close();
  }
});

test('homepage renders the uploaded site icon instead of swapping it after load', async () => {
  const { cookie } = await login(base);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;

  await fetch(`${base}/api/admin/icon`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ siteIcon: dataUrl, favicon: dataUrl }),
  });
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /class="brand has-custom-icon"/);
  assert.match(html, /<link rel="icon" href="\/favicon\.png" type="image\/png" id="favicon-link" \/>/);
  assert.match(html, /<img id="brand-icon" src="\/site-icon\.png" alt="" \/>/);

  // Reset: the default logo + SVG favicon come back in the markup itself.
  await fetch(`${base}/api/admin/icon`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } });
  const after = await (await fetch(`${base}/`)).text();
  assert.match(after, /class="brand"/);
  assert.match(after, /href="\/favicon\.svg"/);
});

// The login card used to hard-code the default logo, so the unauthenticated /admin
// screen showed a generic mark while the rest of the site showed the uploaded icon.
// Like the header brand it renders both marks and lets applyIcon() toggle them —
// logging out reveals this card without a reload, so a server-only version would
// show whatever icon existed when the page loaded.
test('the admin login card shows the uploaded site icon, not the default logo', async () => {
  const { cookie } = await login(base);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;
  const loginCard = (html) => {
    const m = /<section id="login"[\s\S]*?<\/section>/.exec(html);
    assert.ok(m, 'the admin page should have a login section');
    return m[0];
  };
  const cardNow = async () => loginCard(await (await fetch(`${base}/admin`)).text());

  // Normalise first, so this test does not depend on what ran before it.
  await fetch(`${base}/api/admin/icon`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } });

  const plain = await cardNow();
  assert.match(plain, /<div class="logo">/, 'with no icon the default tile is used');
  assert.match(plain, /<svg id="auth-logo-default">/);
  assert.doesNotMatch(plain, /has-custom-icon/);

  await fetch(`${base}/api/admin/icon`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ siteIcon: dataUrl, favicon: dataUrl }),
  });

  const custom = await cardNow();
  assert.match(custom, /<div class="logo has-custom-icon">/, 'the gradient tile should be dropped');
  assert.match(custom, /<img id="auth-logo" src="\/site-icon\.png" alt="" \/>/);
  // Still in the DOM, hidden, so applyIcon() can swap back without a re-render.
  assert.match(custom, /<svg id="auth-logo-default" hidden>/);

  await fetch(`${base}/api/admin/icon`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } });
  assert.doesNotMatch(await cardNow(), /has-custom-icon/);
});

// --- Migration: upgrading an existing DB ------------------------------------

test('migrate upgrades a pre-feature services table with the detail columns', async () => {
  const { migrate } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibefolio-migrate-'));
  const dbPath = path.join(dir, 'old.db');
  const d = new DatabaseSync(dbPath);

  // The services schema as it existed before the detail fields.
  d.exec(`
    CREATE TABLE services (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      icon        TEXT NOT NULL DEFAULT '',
      icon_image  TEXT,
      thumbnail_image TEXT,
      description TEXT NOT NULL DEFAULT '',
      url         TEXT NOT NULL,
      github_repo TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'unknown',
      latency_ms  INTEGER,
      last_checked INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
  d.prepare('INSERT INTO services (name, url, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    'Legacy', 'https://example.com', 1, 1
  );

  migrate(d);

  const cols = d.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
  for (const col of ['tech_stack', 'ai_details', 'story', 'audience']) {
    assert.ok(cols.includes(col), `expected ${col} column after migration`);
  }
  // Existing rows get the defaults, and the row survives the upgrade.
  const row = d.prepare('SELECT name, tech_stack, ai_details, story, audience FROM services WHERE id = 1').get();
  assert.equal(row.name, 'Legacy');
  assert.deepEqual(
    { tech_stack: row.tech_stack, ai_details: row.ai_details, story: row.story, audience: row.audience },
    { tech_stack: '', ai_details: '', story: '', audience: '' }
  );

  d.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Disabled services are not public ---------------------------------------

test('service image endpoints 404 for a disabled service', async () => {
  const { cookie } = await login(base);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };
  const dataUrl = `data:image/png;base64,${PNG_1x1}`;

  const create = await (
    await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Toggled', url: 'https://example.com', iconImage: dataUrl }),
    })
  ).json();
  const id = create.service.id;
  await fetch(`${base}/api/admin/services/${id}/thumbnail`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ thumbnailImage: dataUrl }),
  });

  // Enabled: served, and present on the public list.
  assert.equal((await fetch(`${base}/service-icon/${id}.png`)).status, 200);
  assert.equal((await fetch(`${base}/service-thumb/${id}.png`)).status, 200);
  assert.ok((await (await fetch(`${base}/api/services`)).json()).services.some((s) => s.id === id));

  // Disabled: the images must not be a way around "disabled = not public".
  const off = await fetch(`${base}/api/admin/services/${id}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ name: 'Toggled', url: 'https://example.com', enabled: false }),
  });
  assert.equal(off.status, 200);
  assert.equal((await fetch(`${base}/service-icon/${id}.png`)).status, 404);
  assert.equal((await fetch(`${base}/service-thumb/${id}.png`)).status, 404);
  assert.ok(!(await (await fetch(`${base}/api/services`)).json()).services.some((s) => s.id === id));

  await fetch(`${base}/api/admin/services/${id}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } });
});

// --- Admin API responses are never cached -----------------------------------

test('admin API responses are no-store, including unauthenticated ones', async () => {
  // Unauthenticated (401) responses carry the header too — the middleware runs
  // before the routes, so nothing session-scoped can be stored by a cache.
  for (const path of ['/api/admin/me', '/api/admin/services', '/api/admin/settings']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 401, `${path} should require auth`);
    assert.equal(res.headers.get('cache-control'), 'no-store', `${path} must be no-store`);
  }

  // A failed login is not cacheable either.
  const bad = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(bad.headers.get('cache-control'), 'no-store');

  // Authenticated responses too.
  const { cookie } = await login(base);
  const ok = await fetch(`${base}/api/admin/services`, { headers: { Cookie: cookie, Origin: base } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');

  // The public API is deliberately untouched.
  assert.equal((await fetch(`${base}/api/site`)).headers.get('cache-control'), null);
});

// HSTS is only correct over TLS, and helmet sends it by default in every environment. On a
// plain-HTTP dev origin that is actively harmful rather than merely useless: a browser that
// honours it upgrades every later subresource request on that origin to https, the dev server
// has no TLS listener, and the stylesheet, fonts and scripts all fail — the page renders
// unstyled. Chromium and Firefox are lenient about HSTS from an insecure origin on localhost;
// **Safari is not**, which is how this shipped: the site looked fine in two of three browsers.
//
// Asserted here rather than in a browser test because the property is "what the server sends",
// and the whole failure was a header sent when it should not have been.
test('HSTS is not sent from a plain-HTTP origin', async () => {
  for (const path of ['/', '/css/style.css', '/admin', '/api/site']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(
      res.headers.get('strict-transport-security'),
      null,
      `${path} must not carry HSTS over http — Safari would upgrade its subresources to https`
    );
  }
});

// The rest of helmet's defaults have to stay on. The change above touches one option of one
// header, and the risk of gating it is that a future edit quietly turns more off.
test('the other security headers are still sent', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
});
