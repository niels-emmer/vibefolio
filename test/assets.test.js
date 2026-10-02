import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_VERSION } from '../src/asset-version.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewsDir = path.join(root, 'src', 'views');

// Static assets are served with a 5-minute cache, so a changed file only reaches
// browsers under a new `?v=` URL. Per-page numbers drift (`admin.html` sat on
// `v=13` while `credits.html` was on `v=18` for the same stylesheet, and a
// drifted number can pair a cached old module with a new one), so the rule is
// automated: every version in the templates must equal ASSET_VERSION, and the
// only number written by hand lives in src/asset-version.js.
test('every template asset version equals ASSET_VERSION', () => {
  for (const file of fs.readdirSync(viewsDir)) {
    const html = fs.readFileSync(path.join(viewsDir, file), 'utf8');
    const versions = [...html.matchAll(/\?v=([^"'&]+)/g)].map((m) => m[1]);
    assert.ok(versions.length > 0, `${file} should reference at least one versioned asset`);
    for (const v of versions) {
      // Either the {{ASSET_VERSION}} token (resolved at render time) or the value.
      assert.ok(
        v === '{{ASSET_VERSION}}' || v === String(ASSET_VERSION),
        `${file}: ?v=${v} does not match ASSET_VERSION (${ASSET_VERSION})`
      );
    }
  }
});

// app.js imports render.js from the browser, so the two must be requested under
// the same version — otherwise a cached old module is paired with a new one.
test('the app.js -> render.js import uses ASSET_VERSION', () => {
  const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const match = appJs.match(/from\s+'\.\/render\.js\?v=([^']+)'/);
  assert.ok(match, 'app.js should import render.js with an explicit ?v=');
  assert.equal(match[1], String(ASSET_VERSION));
});

// Any browser module importing another one must use the current version. Only the
// app.js -> render.js pair used to be checked, so a hand-baked number anywhere else could
// drift silently and pair a cached old module with a new one for five minutes (the static
// cache lifetime). This generalises the rule to every import in public/js/.
test('every browser-module import uses ASSET_VERSION', () => {
  for (const file of fs.readdirSync(path.join(root, 'public', 'js')).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(root, 'public', 'js', file), 'utf8');
    for (const [, spec] of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      if (!spec.includes('?')) {
        assert.fail(`${file}: import '${spec}' has no ?v= cache-buster`);
      }
      const version = spec.split('?v=')[1];
      assert.ok(version, `${file}: import '${spec}' should use ?v=`);
      assert.equal(
        version,
        String(ASSET_VERSION),
        `${file}: import '${spec}' does not match ASSET_VERSION (${ASSET_VERSION})`
      );
    }
  }
});

// The version is rendered into the page, so a stale hand-written number can never
// reach a browser.
test('rendered pages carry ASSET_VERSION in their asset URLs', async () => {  const { startTestServer } = await import('./helpers.js');
  const { server, base } = await startTestServer();
  try {
    for (const [page, asset] of [
      ['/', '/css/style.css'],
      ['/', '/js/app.js'],
      ['/', '/js/chrome.js'],
      ['/credits', '/css/style.css'],
      ['/credits', '/js/chrome.js'],
      ['/admin', '/css/style.css'],
      ['/admin', '/js/admin.js'],
      ['/admin', '/js/chrome.js'],
    ]) {
      const html = await (await fetch(`${base}${page}`)).text();
      assert.match(
        html,
        new RegExp(`${asset.replace(/[/.]/g, '\\$&')}\\?v=${ASSET_VERSION}(?=["'])`),
        `${page} should reference ${asset}?v=${ASSET_VERSION}`
      );
    }
  } finally {
    server.close();
  }
});

// --- Guard: browser modules must be self-contained ---------------------------
// `public/js/*.js` is fetched by the browser, so every import must resolve inside
// `public/`. A single bad specifier (e.g. `../asset-version.js`) 404s at runtime
// and kills the whole module — which silently breaks every event listener on the
// page (no card expansion at all) while the server-rendered HTML still looks fine.
// That is exactly how a stray import shipped, so it is checked here.

const publicJsDir = path.join(root, 'public', 'js');

function moduleFiles() {
  return fs.readdirSync(publicJsDir).filter((f) => f.endsWith('.js'));
}

test('browser modules only import files that exist under public/', () => {
  for (const file of moduleFiles()) {
    const src = fs.readFileSync(path.join(publicJsDir, file), 'utf8');
    for (const [, spec] of src.matchAll(/(?:import|from)\s*\(?\s*'([^']+)'/g)) {
      // Bare specifiers, node: builtins and absolute URLs are all wrong here.
      assert.ok(spec.startsWith('.'), `${file}: '${spec}' is not a relative import`);
      assert.ok(!spec.startsWith('node:'), `${file}: '${spec}' is a Node builtin`);
      const clean = spec.split('?')[0]; // strip the ?v= cache-buster
      const resolved = path.resolve(publicJsDir, clean);
      assert.ok(
        fs.existsSync(resolved),
        `${file}: '${spec}' does not resolve under public/ (would 404 in the browser)`
      );
      assert.ok(
        resolved.startsWith(path.join(root, 'public')),
        `${file}: '${spec}' escapes public/ (would 404 in the browser)`
      );
    }
  }
});

// --- Guard: the admin page's scripts must not query elements that are not there -------
//
// `admin.js` and `feedback.js` run their top-level code at parse time. A `$('#id')` that
// resolves to null and is then dereferenced — `$('#x').addEventListener(...)`,
// `$('#x').textContent = ...` — throws, and because the module aborts at that line, every
// listener *after* it is never attached. The page still looks almost right, which is how it
// ships: today the only visible symptom was the Feedback and Backup panels silently never
// populating, and no browser console error on a cached build.
//
// It is easy to introduce by *removing* markup: deleting `#email-clear-password` from the
// view while its listener was still in `feedback.js` would have done exactly this. So the
// rendered page is checked rather than the template — several ids come from `{{BRAND}}` and
// the menu tokens, which do not appear in `admin.html` at all.
test("the admin scripts do not query elements that are missing from the rendered page", async () => {
  const { startTestServer } = await import('./helpers.js');
  const { server, base } = await startTestServer();
  try {
    const html = await (await fetch(`${base}/admin`)).text();
    const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

    for (const file of ['admin.js', 'feedback.js']) {
      const src = fs.readFileSync(path.join(publicJsDir, file), 'utf8');
      const queried = new Set([...src.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
      assert.ok(queried.size > 0, `${file} should query at least one id`);
      const missing = [...queried].filter((id) => !present.has(id));
      assert.deepEqual(
        missing,
        [],
        `${file} queries ids that the rendered admin page does not contain — a null ` +
          `dereference there aborts the module and silently kills every listener after it`
      );
    }
  } finally {
    server.close();
  }
});

// A stray brace silently swallows the rules that follow it: during the thumbnail
// work a dangling `}` ate the entire `.card-thumb` rule, which collapsed the
// thumbnail and its hover overlay to the image's intrinsic size while the page
// still looked plausible. Brace balance is cheap to assert.
test('style.css has balanced braces', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  assert.equal(open, close, `style.css has ${open} '{' and ${close} '}'`);
});
