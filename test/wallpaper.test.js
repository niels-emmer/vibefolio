// Wallpaper & background (see docs/decisions.md D26).
//
// The shape of this suite follows the feature's two failure modes, both of which are
// silent rather than loud:
//
//   1. An id with no CSS rule. The placement ids are interpolated into `data-` attributes
//      that `style.css` has one rule per, so a typo or a half-applied list renders as *no*
//      placement rather than a wrong one — the page still looks plausible.
//   2. The seeded bundled photo drifting out of the upload cap. The seed writes the same
//      column an upload does, and a restore validates it against the same limit, so a cap
//      below the seed's own size produces a deployment whose first backup cannot be
//      restored. Nothing at runtime would tell you.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, login } from './helpers.js';
import * as store from '../src/db.js';

import {
  backgroundHtml,
  wallpaperFrom,
  wallpaperOptionsHtml,
  normalizeWallpaperAnchor,
  normalizeWallpaperSize,
  normalizeTransparency,
  normalizeHexColor,
  WALLPAPER_ANCHOR_IDS,
  WALLPAPER_SIZE_IDS,
  DEFAULT_WALLPAPER,
} from '../public/js/render.js';
import { validateSettings, MAX_WALLPAPER_BASE64 } from '../src/validate.js';
import { ASSET_VERSION } from '../src/asset-version.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const styleCss = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');

// A real 1x1 PNG — the server checks the signature, so a plausible string would not do.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

let server, base, auth;

before(async () => {
  ({ server, base } = await startTestServer());
  const { cookie } = await login(base);
  auth = { Cookie: cookie, Origin: base };
});

after(() => server.close());

// --- The bundled photo is the seed, and must clear the cap -------------------

// The one invariant that spans two files and two features (the seed in src/db.js and the
// cap in src/validate.js). Asserted here rather than in either module because neither can
// see the other, and the failure only shows up on the first restore of an upgraded
// deployment — long after the change that caused it.
test('the bundled background fits the wallpaper upload cap', () => {
  const file = path.join(root, 'public', 'img', 'bg.png');
  assert.ok(fs.existsSync(file), 'the seed source public/img/bg.png is missing');

  const buf = fs.readFileSync(file);
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(
    buf.subarray(0, 8).equals(PNG_SIG),
    'the seed must be a PNG: everything the app stores as artwork is validated by its PNG ' +
      'signature, so a JPEG here would seed a value the next restore would refuse'
  );

  const b64 = buf.toString('base64');
  assert.ok(
    b64.length <= MAX_WALLPAPER_BASE64,
    `the bundled background is ${b64.length} base64 chars but the wallpaper cap is ` +
      `${MAX_WALLPAPER_BASE64} — a seed above the cap produces a database that cannot be restored`
  );
});

// The seed is a one-time migration guarded by its own marker, not by "the setting is
// empty" — that distinction is the whole reason a deleted wallpaper stays deleted.
test('the wallpaper is seeded once, and deleting it survives a restart', () => {
  // A fresh in-memory database is what `migrate()` has already built for this suite; its
  // wallpaper came from the bundled photo.
  const seeded = store.getSetting('wallpaperPng');
  assert.ok(seeded.length > 0, 'migrate() should have seeded the wallpaper');
  assert.equal(store.getSetting('wallpaperSeeded'), '1');

  // Deleting it writes the same empty string the admin's Delete button does...
  store.setSetting('wallpaperPng', '');
  // ...and a later boot (migrate() on the same database) must not put it back.
  store.migrate(store.initDb());
  assert.equal(store.getSetting('wallpaperPng'), '', 'a deleted wallpaper must stay deleted');
});

// --- Rendering ---------------------------------------------------------------

// With no wallpaper and no colour, the backdrop must still be the three layers — the
// colour and image layers are what the admin's controls turn on, and the wash layer is
// what keeps text readable. A page that rendered nothing here would be unreadable over
// the stale image a browser might still have.
test('the backdrop renders three layers even with nothing configured', () => {
  const html = backgroundHtml({});
  assert.match(html, /class="bg-color"/);
  assert.match(html, /class="bg-photo"/);
  assert.match(html, /class="bg-overlay"/);
  // No image, no inline style: the layers are inert rather than carrying an empty url().
  assert.doesNotMatch(html, /--wp-image/);
  assert.doesNotMatch(html, /style="/);
});

test('an active wallpaper contributes the image and its opacity', () => {
  const html = backgroundHtml({ hasWallpaper: true, wallpaperTransparency: 40 });
  assert.match(html, /--wp-image:url\('\/wallpaper\.jpg'\)/);
  // 40% transparent is 60% opaque.
  assert.match(html, /--wp-opacity:0\.6/);
});

// The transparency slider is stored as its own unit and turned into opacity at render
// time, so the number the panel shows and the number the stylesheet uses cannot disagree.
test('transparency maps to opacity across the whole range', () => {
  assert.match(backgroundHtml({ hasWallpaper: true, wallpaperTransparency: 0 }), /--wp-opacity:1/);
  assert.match(backgroundHtml({ hasWallpaper: true, wallpaperTransparency: 100 }), /--wp-opacity:0/);
  assert.match(backgroundHtml({ hasWallpaper: true, wallpaperTransparency: 25 }), /--wp-opacity:0\.75/);
});

test('the background colour is rendered only when one is set', () => {
  assert.match(backgroundHtml({ backgroundColor: '#123456' }), /--wp-color:#123456/);
  // Cleared: the layer stays, with no colour of its own, so `body`'s background shows.
  assert.doesNotMatch(backgroundHtml({ backgroundColor: '' }), /--wp-color/);
});

// Every value that reaches a `data-` attribute is allow-listed or validated, so a stored
// oddity cannot inject markup. This is the property the enterprise checklist cares about,
// and it is cheap to assert directly rather than only through the endpoint.
test('nothing from the settings can break out of the backdrop markup', () => {
  const hostile = {
    hasWallpaper: true,
    wallpaperAnchor: '"><script>alert(1)</script>',
    wallpaperSize: "x' onload='alert(1)",
    wallpaperTransparency: '"><img src=x>',
    backgroundColor: 'red; background: url(evil)',
  };
  const html = backgroundHtml(hostile);

  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onload/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /evil/);
  // Each hostile value fell back to its default rather than being interpolated.
  assert.match(html, /data-anchor="center"/);
  assert.match(html, /data-size="cover"/);
});

// --- Normalisation -----------------------------------------------------------

test('an unknown placement value normalises to the default', () => {
  for (const bad of ['', null, undefined, 'CENTER', 'nope', '"><script>']) {
    assert.equal(normalizeWallpaperAnchor(bad), DEFAULT_WALLPAPER.anchor);
    assert.equal(normalizeWallpaperSize(bad), DEFAULT_WALLPAPER.size);
  }
  // Every real id survives.
  for (const id of WALLPAPER_ANCHOR_IDS) assert.equal(normalizeWallpaperAnchor(id), id);
  for (const id of WALLPAPER_SIZE_IDS) assert.equal(normalizeWallpaperSize(id), id);
});

// Stored as a string, read back as a number, and the two have to agree: the setting round
// trips through SQLite as text.
test('transparency is a number from 0 to 100, or the default', () => {
  assert.equal(normalizeTransparency('0'), 0);
  assert.equal(normalizeTransparency(70), 70);
  assert.equal(normalizeTransparency('100'), 100);
  for (const bad of ['', null, undefined, '101', '-1', 'half', '12.5', NaN, {}]) {
    assert.equal(normalizeTransparency(bad), DEFAULT_WALLPAPER.transparency, `bad input: ${bad}`);
  }
});

test('a colour is a #rrggbb hex or nothing at all', () => {
  assert.equal(normalizeHexColor('#AABBCC'), '#aabbcc');
  assert.equal(normalizeHexColor('#123456'), '#123456');
  for (const bad of ['', null, undefined, '#fff', 'red', '#12345g', 'rgb(1,2,3)', 'url(x)']) {
    assert.equal(normalizeHexColor(bad), DEFAULT_WALLPAPER.color, `bad input: ${bad}`);
  }
});

// --- Validation (the admin write path) ---------------------------------------

test('validateSettings accepts the wallpaper keys and rejects nonsense', () => {
  const ok = validateSettings({
    wallpaperAnchor: 'top',
    wallpaperSize: 'tile',
    wallpaperTransparency: 55,
    backgroundColor: '#AbC123',
  });
  assert.equal(ok.ok, true, ok.errors.join('; '));
  // Stored as strings: the database holds text, and the panel reads the same unit back.
  assert.deepEqual(ok.value, {
    wallpaperAnchor: 'top',
    wallpaperSize: 'tile',
    wallpaperTransparency: '55',
    backgroundColor: '#abc123',
  });

  for (const [key, bad] of [
    ['wallpaperAnchor', 'middle'],
    ['wallpaperSize', 'zoom'],
    ['wallpaperTransparency', 101],
    ['wallpaperTransparency', -1],
    ['wallpaperTransparency', 12.5],
    ['wallpaperTransparency', '50'], // a string is what the archive carries, not the panel
    ['backgroundColor', 'red'],
    ['backgroundColor', '#fff'],
    ['backgroundColor', '#1234567'],
  ]) {
    const res = validateSettings({ [key]: bad });
    assert.equal(res.ok, false, `${key}=${JSON.stringify(bad)} should be refused`);
    assert.match(res.errors.join(' '), new RegExp(key));
    assert.ok(!(key in res.value), `${key} must not be written when it is refused`);
  }
});

// An empty colour and a zero transparency are real states, not "absent" — the first clears
// a colour, the second is the slider's left-hand end.
test('an empty colour and a zero transparency are accepted as values', () => {
  const res = validateSettings({ backgroundColor: '', wallpaperTransparency: 0 });
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.value.backgroundColor, '');
  assert.equal(res.value.wallpaperTransparency, '0');
});

// --- The CSS hook ids ---------------------------------------------------------

// The failure this guards: an id in `WALLPAPER_*` with no matching rule renders as *no*
// placement, silently, and the page still looks plausible enough to ship.
test('every placement id has a style.css rule', () => {
  for (const [attr, ids] of [
    ['anchor', WALLPAPER_ANCHOR_IDS],
    ['size', WALLPAPER_SIZE_IDS],
  ]) {
    for (const id of ids) {
      assert.match(
        styleCss,
        new RegExp(`\\.bg-photo\\[data-${attr}="${id}"\\]`),
        `style.css has no rule for data-${attr}="${id}" — it would render as no placement`
      );
    }
  }
});

// The three layers have to be stacked in paint order, and all of them behind the page.
test('the backdrop layers are stacked in paint order, behind the page', () => {
  const z = (sel) => {
    const at = styleCss.indexOf(sel);
    assert.notEqual(at, -1, `style.css should declare ${sel}`);
    const body = styleCss.slice(at, styleCss.indexOf('}', at));
    const m = /z-index:\s*(-?\d+)/.exec(body);
    assert.ok(m, `${sel} should set a z-index`);
    return Number(m[1]);
  };
  const color = z('.bg-color {');
  const photo = z('.bg-photo {');
  const overlay = z('.bg-overlay {');
  assert.ok(color < photo && photo < overlay, `expected colour < wallpaper < wash, got ${color}, ${photo}, ${overlay}`);
  assert.ok(overlay < 0, 'every backdrop layer must sit behind the page content');
});

// The wash must be its own layer, and the wallpaper's fade must be on an element that
// something else is not also fading — otherwise a transparent wallpaper fades the wash
// with it and the text drops under AA exactly when a bright photo is chosen.
test('the readability wash is not faded by the wallpaper transparency', () => {
  const at = styleCss.indexOf('.bg-overlay {');
  const body = styleCss.slice(at, styleCss.indexOf('}', at));
  assert.match(body, /background:\s*var\(--photo-overlay\)/);
  assert.doesNotMatch(body, /opacity/, 'the wash must stay at full strength');

  const photoAt = styleCss.indexOf('.bg-photo {');
  const photoBody = styleCss.slice(photoAt, styleCss.indexOf('}', photoAt));
  assert.match(photoBody, /opacity:\s*var\(--wp-opacity/, 'the wallpaper carries the transparency');
});

// --- The option lists the panel renders --------------------------------------

test('the option markup pre-selects the current value', () => {
  const html = wallpaperOptionsHtml('anchor', 'top');
  assert.match(html, /<option value="top" selected>/);
  assert.doesNotMatch(html, /<option value="center" selected>/);
  // Every id in the list is offered, so the select cannot be missing a valid choice.
  for (const id of WALLPAPER_ANCHOR_IDS) assert.match(html, new RegExp(`<option value="${id}"`));
});

test('an unknown option list is a programming error, not a blank select', () => {
  assert.throws(() => wallpaperOptionsHtml('nope', 'top'), /Unknown wallpaper option list/);
});

// --- HTTP: the endpoints ------------------------------------------------------

test('the wallpaper uploads, serves and deletes through the API', async () => {
  // Start from a known state: the seed means a wallpaper is already active.
  await fetch(`${base}/api/admin/wallpaper`, { method: 'DELETE', headers: auth });

  let res = await fetch(`${base}/wallpaper.jpg`);
  assert.equal(res.status, 404, 'a deleted wallpaper must not be served');

  const put = await fetch(`${base}/api/admin/wallpaper`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ wallpaper: PNG_DATA_URL }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).hasWallpaper, true);

  res = await fetch(`${base}/wallpaper.jpg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.subarray(0, 8).equals(Buffer.from(PNG_B64, 'base64').subarray(0, 8)));

  // Reported to the admin read model, which is what the panel's preview keys off.
  const settings = await (await fetch(`${base}/api/admin/settings`, { headers: auth })).json();
  assert.equal(settings.settings.hasWallpaper, true);

  const del = await fetch(`${base}/api/admin/wallpaper`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).hasWallpaper, false);
  assert.equal((await fetch(`${base}/wallpaper.jpg`)).status, 404);
});

test('the wallpaper endpoints require a session', async () => {
  for (const [method, body] of [
    ['PUT', JSON.stringify({ wallpaper: PNG_DATA_URL })],
    ['DELETE', undefined],
  ]) {
    const res = await fetch(`${base}/api/admin/wallpaper`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(res.status, 401, `${method} must not be reachable without a session`);
  }
});

test('a wallpaper that is not a PNG is refused', async () => {
  for (const bad of [
    'not-a-data-url',
    'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    `data:image/png;base64,${Buffer.from('definitely not a png').toString('base64')}`,
    null,
    undefined,
  ]) {
    const res = await fetch(`${base}/api/admin/wallpaper`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ wallpaper: bad }),
    });
    assert.equal(res.status, 400, `should refuse ${String(bad).slice(0, 40)}`);
  }
});

// A data URL longer than the cap is refused by the validator rather than stored. The body
// limit is larger than the cap on purpose, so this is the check that actually holds.
test('a wallpaper larger than the cap is refused', async () => {
  const oversized = `data:image/png;base64,${PNG_B64}${'A'.repeat(MAX_WALLPAPER_BASE64)}`;
  const res = await fetch(`${base}/api/admin/wallpaper`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ wallpaper: oversized }),
  });
  assert.equal(res.status, 400);
});

// The settings the panel sends have to survive the round trip through the database and
// back out of `settingsFrom`, because that is what the rendered backdrop is built from.
test('the wallpaper settings round trip from the panel to the rendered page', async () => {
  // Uploaded explicitly rather than relying on the seed: an earlier test in this file
  // deletes the wallpaper, and a test that silently depends on another's leftovers breaks
  // the day that one changes (the same rule the backup suite states for its counts).
  const putWallpaper = await fetch(`${base}/api/admin/wallpaper`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ wallpaper: PNG_DATA_URL }),
  });
  assert.equal(putWallpaper.status, 200);

  const put = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      wallpaperAnchor: 'bottom',
      wallpaperSize: 'contain',
        wallpaperTransparency: 30,
      backgroundColor: '#102030',
    }),
  });
  assert.equal(put.status, 200, await put.text());

  const site = await (await fetch(`${base}/api/site`)).json();
  assert.equal(site.wallpaperAnchor, 'bottom');
  assert.equal(site.wallpaperSize, 'contain');
  assert.equal(site.wallpaperTransparency, 30, 'transparency comes back as a number');
  assert.equal(site.backgroundColor, '#102030');
  assert.equal(site.hasWallpaper, true, 'the wallpaper uploaded above must be active');

  // And into the first byte of every page, with no script involved.
  for (const path of ['/', '/credits', '/admin']) {
    const html = await (await fetch(`${base}${path}`)).text();
    assert.match(html, /data-anchor="bottom"/, `${path} should carry the anchor`);
    assert.match(html, /data-size="contain"/, `${path} should carry the size`);
    assert.match(html, /--wp-color:#102030/, `${path} should carry the background colour`);
    assert.match(html, /--wp-opacity:0\.7/, `${path} should carry the transparency`);
    assert.match(html, /--wp-image:url\('\/wallpaper\.jpg'\)/, `${path} should carry the image`);
    assert.match(html, /class="bg-overlay"/, `${path} needs the readability wash`);
  }
});

// The other half of the same property: with the wallpaper deleted the pages must carry no
// image at all and keep the wash, so a deleted wallpaper cannot leave a stale layer behind.
test('a deleted wallpaper leaves no image behind on any page', async () => {
  const del = await fetch(`${base}/api/admin/wallpaper`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 200);

  for (const path of ['/', '/credits', '/admin']) {
    const html = await (await fetch(`${base}${path}`)).text();
    assert.doesNotMatch(html, /--wp-image/, `${path} must not carry a wallpaper url`);
    assert.match(html, /class="bg-color"/, `${path} keeps the colour layer`);
    assert.match(html, /class="bg-overlay"/, `${path} keeps the readability wash`);
  }

  const site = await (await fetch(`${base}/api/site`)).json();
  assert.equal(site.hasWallpaper, false);
});

// The admin panel's preview `<img>` is rendered in one of two shapes, and both were got
// wrong once: an empty `src` (which re-requests `/admin` itself, because an empty URL
// resolves against the document) and a helper that returned a second `class` attribute to be
// appended to the template's — which the browser ignores, keeping the first, so the `empty`
// class silently never landed. Asserted on the rendered page because that is where both
// mistakes are visible.
test('the admin wallpaper preview is rendered in the state the setting implies', async () => {
  const preview = (html) => /<img id="wallpaper-preview"[^>]*>/.exec(html)?.[0] ?? '';
  const count = (s, needle) => s.split(needle).length - 1;

  // No wallpaper: no `src` attribute at all, and exactly one `class`.
  await fetch(`${base}/api/admin/wallpaper`, { method: 'DELETE', headers: auth });
  const without = preview(await (await fetch(`${base}/admin`)).text());
  assert.ok(without, 'the preview element should be rendered');
  assert.doesNotMatch(without, /src=/, 'no wallpaper must mean no src attribute (not src="")');
  assert.equal(count(without, 'class='), 1, 'a duplicate class attribute would be silently dropped');

  // With a wallpaper: a real src, and still exactly one `class`.
  await fetch(`${base}/api/admin/wallpaper`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ wallpaper: PNG_DATA_URL }),
  });
  const with_ = preview(await (await fetch(`${base}/admin`)).text());
  assert.match(with_, /src="\/wallpaper\.jpg\?v=\d+"/, 'the preview should point at the wallpaper');
  assert.equal(count(with_, 'class='), 1, 'a duplicate class attribute would be silently dropped');

  // The page must not name the settings' wallpaper path unversioned: the static cache would
  // hold the previous image for up to its max-age after an upload.
  assert.doesNotMatch(with_, /src="\/wallpaper\.jpg"/, 'the preview src should be cache-busted');
});

// The old stylesheet hard-coded the bundled photo; the markup must be the only thing that
// decides the backdrop now, or a second source of truth would fight the admin's settings.
test('the backdrop is not hard-coded in the stylesheet or the templates', () => {
  assert.doesNotMatch(styleCss, /url\('\/img\/bg\.jpg'\)/, 'style.css must not name the bundled photo');
  assert.doesNotMatch(styleCss, /url\('\/img\/bg\.png'\)/, 'style.css must not name the bundled photo');
  for (const file of fs.readdirSync(path.join(root, 'src', 'views'))) {
    const html = fs.readFileSync(path.join(root, 'src', 'views', file), 'utf8');
    assert.doesNotMatch(html, /class="bg-photo"/, `${file} should use {{BACKGROUND}}, not a hard-coded layer`);
    assert.match(html, /\{\{BACKGROUND\}\}/, `${file} should render the backdrop from the settings`);
  }
});

// --- The seeded default matches what the site looked like before -------------

// Requirement 8: an upgraded deployment must look unchanged until the admin changes
// something. That is these defaults against the old rules — `cover`, `center`, fully
// opaque — and it is the reason they are what they are.
test('the defaults reproduce the stylesheet the site shipped with', () => {
  assert.deepEqual(DEFAULT_WALLPAPER, {
    anchor: 'center',
    size: 'cover',
    transparency: 0,
    color: '',
  });
  const html = backgroundHtml({ hasWallpaper: true });
  assert.match(html, /data-size="cover"/);
  assert.match(html, /data-anchor="center"/);
  assert.match(html, /--wp-opacity:1/);
});

// --- Misc --------------------------------------------------------------------

test('wallpaperFrom reads the stored settings the way the pages do', () => {
  const wp = wallpaperFrom({
    hasWallpaper: true,
    wallpaperAnchor: 'left',
    wallpaperSize: 'tile',
    wallpaperTransparency: '20',
    backgroundColor: '#FFFFFF',
  });
  assert.deepEqual(wp, {
    hasImage: true,
    anchor: 'left',
    size: 'tile',
    transparency: 20,
    color: '#ffffff',
  });
});

test('the backup carries the wallpaper and the placement settings', async () => {
  await fetch(`${base}/api/admin/wallpaper`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ wallpaper: PNG_DATA_URL }),
  });
  const res = await fetch(`${base}/api/admin/backup`, { headers: auth });
  assert.equal(res.status, 200);

  const zlib = await import('node:zlib');
  const archive = JSON.parse(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
  assert.equal(archive.data.settings.wallpaperPng, PNG_B64, 'the wallpaper image must be in a backup');
  assert.equal(archive.data.settings.wallpaperAnchor, 'bottom');
  assert.equal(archive.data.settings.backgroundColor, '#102030');
});

// `maxAge: '5m'` on the static handler does not apply to this route, but the wallpaper is
// what the page's first paint depends on, so a stale one after an upload would be visible.
test('the wallpaper is served with revalidation, not a long cache', async () => {
  const res = await fetch(`${base}/wallpaper.jpg`);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('the panel and the server agree on the wallpaper size cap', () => {
  // `admin.js` cannot import from `src/` (a browser module that does 404s at runtime and
  // silently kills every listener after it — guarded by test/assets.test.js), so the cap is
  // declared twice. A panel cap *below* the server's is the worse direction: uploads the
  // server would accept are refused by the client, and the server never sees them, so there
  // is no log entry and nothing to debug from the server side.
  const admin = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');
  const m = /const MAX_WALLPAPER_BASE64 = (\d+);/.exec(admin);
  assert.ok(m, 'admin.js should declare its copy of MAX_WALLPAPER_BASE64');
  assert.equal(
    Number(m[1]),
    MAX_WALLPAPER_BASE64,
    'the panel and src/validate.js must agree, or one refuses what the other accepts'
  );
});

// The panel's encoder and the server's validator have to produce and accept the same format.
// They disagreed once — the panel sent JPEG, the server only accepted PNG — and every upload
// was refused, while these tests passed because they posted a hand-made PNG data URL rather
// than the panel's own output. Asserting on the encoder's source is weak, but it is the only
// thing available without a browser, and it fails loudly on the exact regression.
test('the panel encodes the wallpaper in the format the server validates', () => {
  const admin = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');
  const body = /function drawWallpaper\([\s\S]*?\n\}/.exec(admin);
  assert.ok(body, 'admin.js should define drawWallpaper');
  assert.match(body[0], /toDataURL\('image\/png'\)/, 'the encoder must produce a PNG data URL');
  assert.doesNotMatch(body[0], /image\/jpeg/, 'a JPEG payload is refused by the server for every file');
});

// `no-cache` on the wallpaper (server.js) is only half of it: the *module* has to reach the
// browser too. A changed `admin.js` under an unchanged `?v=` is served from the HTTP cache,
// which is exactly how a fixed encoder was still observed sending JPEG after the fix.
test('ASSET_VERSION covers the modules this feature changed', () => {
  const admin = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');
  const imports = [...admin.matchAll(/from\s+'\.\/([^?']+)\?v=(\d+)'/g)];
  for (const [, file, version] of imports) {
    assert.equal(
      Number(version),
      ASSET_VERSION,
      `admin.js imports ${file} at ?v=${version}; the panels load at ${ASSET_VERSION}`
    );
  }
});
// The body limit has to be above the wallpaper cap or a large upload is refused as
// malformed rather than reported as too large — the failure mode would be a confusing 413
// instead of a message about the image.
//
// The number that matters here is not the bundled *file* but what the browser's canvas
// produces from it: a canvas PNG is markedly larger than the same pixels encoded by a
// command-line tool (1 926 880 chars vs 1 497 300 for this asset). Sizing the limit against
// the file would pass here and still refuse every real upload, so the assertion uses the
// larger of the two.
test('the request body limit leaves room for a full-size wallpaper', () => {
  const asset = fs.readFileSync(path.join(root, 'public', 'img', 'bg.png')).toString('base64');
  // The canvas figure, measured in Chromium for this exact asset at 1920 wide. It is a
  // literal because a Node test cannot run a canvas; `test/wallpaper.test.js`'s sibling
  // assertions cover the parts that can be checked mechanically.
  const canvasEncoded = 1_926_880;
  // The upload is what must fit, so the assertion is on the payload the panel would send.
  const body = JSON.stringify({ wallpaper: `data:image/png;base64,${'A'.repeat(canvasEncoded)}` }).length;
  const declared = 2400 * 1024; // keep in step with express.json({ limit }) in src/server.js
  assert.ok(
    body < declared,
    `a full-size upload composes ${body} bytes against the declared ${declared} byte limit`
  );
  // The seed is a real file the server must accept, and it has to clear the same cap the
  // upload path is measured against — see the cap's comment in src/validate.js.
  assert.ok(
    asset.length <= MAX_WALLPAPER_BASE64,
    `the bundled asset is ${asset.length} chars, above the ${MAX_WALLPAPER_BASE64} cap`
  );
  // And the canvas figure the panel actually produces must clear it too, or the shipped
  // wallpaper is refused by its own cap — which is the bug this test exists for.
  assert.ok(
    canvasEncoded <= MAX_WALLPAPER_BASE64,
    `the panel's own encoder produces ${canvasEncoded} chars, above the ${MAX_WALLPAPER_BASE64} ` +
      `cap — the shipped wallpaper could not be re-uploaded`
  );
});

// --- The seed when its asset is missing --------------------------------------

// `seedWallpaper` reads a file that ships in the image. If it is ever absent, the *marker must
// not be written*: recording "the wallpaper was seeded" for a database with no wallpaper would
// make the absence permanent, recoverable only by an admin upload, on a restart caused by a
// file the operator can put back. The guard is checked here rather than by deleting the real
// asset (which would break every other test in this file and the repository's own image).
//
// The behaviour is asserted through the source, because the alternative is mutating a shipped
// file or monkey-patching `node:fs` — both worse than reading the code that must not run.
test('the seed does not record a failure as if it had succeeded', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'db.js'), 'utf8');
  const body = /function seedWallpaper\(d\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(body, 'src/db.js should define seedWallpaper');

  // The catch block must return before the marker is written.
  const catchBlock = /catch\s*\(err\)\s*\{[\s\S]*?\}/.exec(body[0]);
  assert.ok(catchBlock, 'a missing asset should be caught rather than thrown');
  assert.match(
    catchBlock[0],
    /\breturn\b/,
    'the catch must return, or the marker below records a seed that never happened'
  );

  // And the marker write must sit *after* that return, i.e. the read must have succeeded.
  const catchEnd = body[0].indexOf(catchBlock[0]) + catchBlock[0].length;
  const markerWrite = body[0].indexOf("run(marker, '1')");
  assert.ok(markerWrite > catchEnd, 'the marker should only be written on a successful read');
});
