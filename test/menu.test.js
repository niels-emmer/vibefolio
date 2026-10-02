import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, login } from './helpers.js';
import { APP_NAME, APP_RELEASE_DATE, releaseDateLabel } from '../src/version.js';
import { THEMES, DEFAULT_THEME } from '../public/js/render.js';

let server, base;

before(async () => {
  ({ server, base } = await startTestServer());
});

after(() => server.close());

const PAGES = ['/', '/credits', '/admin'];

// Slice the header and the drawer out of a rendered page so assertions cannot be
// satisfied by markup somewhere else on the page.
function headerOf(html) {
  const m = /<header class="site-header">[\s\S]*?<\/header>/.exec(html);
  assert.ok(m, 'the page should have a site header');
  return m[0];
}

function drawerOf(html) {
  const m = /<aside class="drawer"[\s\S]*?<\/aside>/.exec(html);
  assert.ok(m, 'the page should have a fold-out drawer');
  return m[0];
}

async function html(pathname, headers) {
  const res = await fetch(`${base}${pathname}`, { headers });
  assert.equal(res.status, 200, `${pathname} should be served`);
  return res.text();
}

// --- The header -------------------------------------------------------------

test('every page has the same header: brand, then one right-aligned hamburger', async () => {
  for (const page of PAGES) {
    const header = headerOf(await html(page));
    const right = /<div class="header-right">([\s\S]*?)<\/div>/.exec(header);
    assert.ok(right, `${page} should have .header-right`);

    // The hamburger is the control, and it controls the drawer.
    assert.match(right[1], /id="menu-toggle"/, `${page}: expected a hamburger`);
    assert.match(right[1], /aria-controls="drawer"/, `${page}: hamburger should point at the drawer`);
    assert.match(right[1], /aria-expanded="false"/, `${page}: the drawer starts closed`);

    // The status pill and the Admin button are gone from the header.
    assert.doesNotMatch(right[1], /live-pill/, `${page}: the status pill should be gone`);
    const withoutNoscript = right[1].replace(/<noscript>[\s\S]*?<\/noscript>/, '');
    assert.doesNotMatch(withoutNoscript, /href="\/admin"/, `${page}: the Admin button should be gone`);

    // ...but a no-JS visitor still gets a way in, so the header cannot become a
    // dead end when the module fails to load (see D13).
    assert.match(right[1], /<noscript><a class="btn ghost small" href="\/admin">Admin<\/a><\/noscript>/);
  }
});

// --- The drawer -------------------------------------------------------------

test('the drawer shows the app name and its release date', async () => {
  const drawer = drawerOf(await html('/'));
  assert.match(drawer, new RegExp(`id="drawer-title">${APP_NAME}<`));
  // The date is prefixed with a white "Updated:" label so it stands out.
  assert.match(
    drawer,
    new RegExp(`id="drawer-release"><span class="drawer-sub-label">Updated:</span> ${releaseDateLabel()}<`)
  );
  // The date is the only thing here that could go stale, so pin the format.
  assert.match(releaseDateLabel(), /^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
});

test('the drawer links to Services, Credits and, when enabled, Feedback', async () => {
  const { server, base } = await startTestServer();
  const { cookie } = await login(base);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };
  const drawerAt = async (path = '/') => drawerOf(await (await fetch(`${base}${path}`)).text());
  try {
    // Services leads, because it is the way back to the top-level page and the drawer is
    // the only navigation on /credits and /feedback besides the brand logo.
    // Off by default: the Feedback link must not point at a page that 404s.
    assert.match(await drawerAt(), /class="drawer-links"><a href="\/">Services<\/a> · <a href="\/credits">Credits<\/a><\/p>/);

    await fetch(`${base}/api/admin/email`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ feedbackEnabled: true }),
    });
    const on = await drawerAt();
    assert.match(on, /<a href="\/">Services<\/a> · <a href="\/credits">Credits<\/a> · <a href="\/feedback">Feedback<\/a>/);

    // ...and it is server-rendered on every page, not just the homepage.
    for (const page of PAGES) {
      assert.match(await drawerAt(page), /href="\/feedback"/, `${page} should link to feedback`);
    }
  } finally {
    await fetch(`${base}/api/admin/email`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ feedbackEnabled: false }),
    });
    server.close();
  }
});

test('the drawer is inert until it is opened, on every page', async () => {
  for (const page of PAGES) {
    const drawer = drawerOf(await html(page));
    assert.match(drawer, /role="dialog"/, page);
    assert.match(drawer, /aria-modal="true"/, page);
    assert.match(drawer, /aria-labelledby="drawer-title"/, page);
    // Off-screen markup must not be tabbable before `chrome.js` removes this.
    assert.match(drawer, / inert>/, page);
  }
});

test('the drawer links to the admin panel, on every page', async () => {
  for (const page of PAGES) {
    const drawer = drawerOf(await html(page));
    assert.match(drawer, /<a class="btn ghost drawer-admin" id="drawer-admin" href="\/admin">/, page);
    // `chrome.js` relabels this to "Dashboard" when a session exists; the rendered
    // default is the anonymous case.
    assert.match(drawer, /id="drawer-admin-label">Admin logon</, page);
  }
});

test('the drawer status counts match the public services API', async () => {
  const { cookie } = await login(base);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };
  const ids = [];

  for (const name of ['Menu One', 'Menu Two']) {
    const res = await fetch(`${base}/api/admin/services`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name, url: `https://${name.split(' ')[1].toLowerCase()}.example.com` }),
    });
    assert.equal(res.status, 201);
    ids.push((await res.json()).service.id);
  }

  try {
    // The invariant that matters: the drawer is rendered from the same read model
    // the API serves, so the counts cannot disagree with the cards.
    const { services } = await (await fetch(`${base}/api/services`)).json();
    const drawer = drawerOf(await html('/'));

    const up = services.filter((s) => s.status === 'up').length;
    const down = services.filter((s) => s.status === 'down').length;
    assert.match(drawer, new RegExp(`id="drawer-total">${services.length}<`));
    assert.match(drawer, new RegExp(`id="drawer-up">${up}<`));
    assert.match(drawer, new RegExp(`id="drawer-down">${down}<`));

    // With no health check having run, every service is `unknown` — the summary
    // must not claim everything is operational.
    assert.match(drawer, /class="status unknown" id="drawer-summary"/);
    assert.match(drawer, /<span class="txt">monitoring<\/span>/);
  } finally {
    for (const id of ids) {
      await fetch(`${base}/api/admin/services/${id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: base },
      });
    }
  }
});

test('the drawer renders the theme selector with the current choice selected', async () => {
  const drawer = drawerOf(await html('/'));
  const options = [...drawer.matchAll(/<input type="radio" name="theme" value="([a-z]+)"( checked)? \/>/g)];
  assert.deepEqual(options.map((m) => m[1]), THEMES, 'one radio per theme, in order');
  assert.equal(options.filter((m) => m[2]).length, 1, 'exactly one theme is selected');
  assert.equal(options.find((m) => m[2])[1], DEFAULT_THEME, 'the default theme is selected by default');
});

// --- Theme cookie -----------------------------------------------------------

test('the theme is rendered server-side from the cookie, with no flash', async () => {
  const cases = [
    [undefined, 'dark', '#08090d'], // no cookie → the dark-first default
    ['theme=dark', 'dark', '#08090d'],
    ['theme=light', 'light', '#f4f5f9'],
    ['theme=system', 'system', '#08090d'],
    ['theme=bogus', 'dark', '#08090d'], // unrecognised value → default
    ['theme=', 'dark', '#08090d'],
    ['theme=%3Cscript%3E', 'dark', '#08090d'], // a tampered cookie cannot inject an attribute
    ['theme=constructor', 'dark', '#08090d'],
  ];

  for (const [cookie, theme, color] of cases) {
    const page = await html('/', cookie ? { Cookie: cookie } : undefined);
    assert.match(
      page,
      new RegExp(`<html lang="en" data-theme="${theme}" data-accent="amber">`),
      `cookie ${cookie}: expected data-theme="${theme}"`
    );
    assert.match(
      page,
      new RegExp(`<meta name="theme-color" content="${color}" />`),
      `cookie ${cookie}: expected theme-color ${color}`
    );
    // The selected radio must agree with the rendered palette.
    const selected = /<input type="radio" name="theme" value="([a-z]+)" checked \/>/.exec(drawerOf(page));
    assert.equal(selected[1], theme, `cookie ${cookie}: the selected radio should match`);
  }
});

test('every page carries the theme attribute', async () => {
  for (const page of PAGES) {
    assert.match(
      await html(page, { Cookie: 'theme=light' }),
      /<html lang="en" data-theme="light" data-accent="amber">/,
      page
    );
  }
});

// --- Version constant -------------------------------------------------------

test('the release date is a valid ISO date', () => {
  assert.match(APP_RELEASE_DATE, /^\d{4}-\d{2}-\d{2}$/);
  // Malformed values must fail loudly at render time rather than printing "NaN".
  assert.throws(() => releaseDateLabel('30/09/2026'), /YYYY-MM-DD/);
  assert.throws(() => releaseDateLabel('2026-13-01'), /out-of-range month/);
});
