// The editable page text and the credits-page list (see docs/decisions.md D22).
//
// Two things are being pinned here:
//
//  1. Nothing changes visually for an existing install. The copy the pages used to
//     hardcode is seeded into the database by `migrate()`, and these tests assert the
//     rendered pages carry exactly that copy — so a future edit to the seed values, or a
//     broken read path, fails loudly instead of silently rewriting the site's words.
//  2. The text is genuinely editable: it round-trips through the admin API, hard returns
//     become paragraphs, everything is escaped, and a cleared field stays cleared.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, login } from './helpers.js';
import { setSetting, listCredits, migrate } from '../src/db.js';
import { DEFAULT_PAGE_TEXT, DEFAULT_CREDITS } from '../src/content-defaults.js';
import { changedPageTextFields } from '../public/js/page-text-config.js';

let server, base, cookie;

before(async () => {
  ({ server, base } = await startTestServer());
  ({ cookie } = await login(base));
  // /feedback 404s unless the feature is on, and the copy lives on that page.
  setSetting('feedbackEnabled', '1');
});

after(() => {
  setSetting('feedbackEnabled', '0');
  server.close();
});

const auth = () => ({ 'Content-Type': 'application/json', Cookie: cookie, Origin: base });

const putContent = (body) =>
  fetch(`${base}/api/admin/content`, { method: 'PUT', headers: auth(), body: JSON.stringify(body) });

const putCredit = (id, body) =>
  fetch(`${base}/api/admin/credits/${id}`, { method: 'PUT', headers: auth(), body: JSON.stringify(body) });

const addCredit = (body) =>
  fetch(`${base}/api/admin/credits`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });

const postOrder = (ids) =>
  fetch(`${base}/api/admin/credits/order`, { method: 'PUT', headers: auth(), body: JSON.stringify({ ids }) });

const deleteCredit = (id) => fetch(`${base}/api/admin/credits/${id}`, { method: 'DELETE', headers: auth() });

// Paragraph texts of a given class, trimmed — the markup's own indentation is not part
// of the copy.
function paragraphs(html, className) {
  return [...html.matchAll(new RegExp(`<p class="${className}">([\\s\\S]*?)</p>`, 'g'))].map((m) =>
    m[1].trim()
  );
}

function creditRoles(html) {
  return [...html.matchAll(/<span class="credit-role">([^<]*)<\/span>/g)].map((m) => m[1]);
}

// --- Seeded copy (the "no visible difference" guarantee) --------------------

test('a fresh install renders the copy the pages used to hardcode', async () => {
  const credits = await (await fetch(`${base}/credits`)).text();
  assert.match(credits, /<p class="subtitle">Credit where credit is due\.<\/p>/);
  assert.match(credits, new RegExp(`<p class="credits-note">${DEFAULT_PAGE_TEXT.creditsNote}</p>`));

  // Every seeded line, in the seeded order, with its link intact.
  assert.deepEqual(creditRoles(credits), DEFAULT_CREDITS.map((c) => c.role));
  for (const c of DEFAULT_CREDITS) {
    assert.ok(
      credits.includes(`<a class="credit-link" href="${c.url}" target="_blank" rel="noopener noreferrer">${c.value}<svg>`),
      `the credits page should link ${c.value} to ${c.url}`
    );
  }

  const feedback = await (await fetch(`${base}/feedback`)).text();
  assert.match(feedback, new RegExp(`<p class="subtitle">${DEFAULT_PAGE_TEXT.feedbackSubtitle}</p>`));
  // One paragraph per blank line in the seed value.
  assert.deepEqual(paragraphs(feedback, 'form-intro'), DEFAULT_PAGE_TEXT.feedbackIntro.split('\n\n'));
});

test('the seeded copy is served to anonymous visitors from the first byte', async () => {
  // No fetch, no script: the copy is in the HTML itself, like the rest of the site.
  for (const page of ['/credits', '/feedback']) {
    const html = await (await fetch(`${base}${page}`)).text();
    assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, `${page} should not ship an unfilled token`);
  }
});

// --- Hard returns ----------------------------------------------------------

test('hard returns in the page text become separate paragraphs', async () => {
  const original = DEFAULT_PAGE_TEXT.feedbackIntro;
  try {
    const res = await putContent({ feedbackIntro: 'First line.\n\nSecond line.\nThird line.' });
    assert.equal(res.status, 200);

    const html = await (await fetch(`${base}/feedback`)).text();
    // A blank line and a single hard return both start a new paragraph, and an empty
    // block is dropped rather than rendered as an empty paragraph.
    assert.deepEqual(paragraphs(html, 'form-intro'), ['First line.', 'Second line.', 'Third line.']);

    // CRLF from a client that normalises the other way must not leave a stray \r behind.
    await putContent({ feedbackIntro: 'One.\r\n\r\nTwo.' });
    const crlf = await (await fetch(`${base}/feedback`)).text();
    assert.deepEqual(paragraphs(crlf, 'form-intro'), ['One.', 'Two.']);
  } finally {
    await putContent({ feedbackIntro: original });
  }
});

test('the credits bottom line can be several paragraphs too', async () => {
  const original = DEFAULT_PAGE_TEXT.creditsNote;
  try {
    await putContent({ creditsNote: 'Thanks everyone.\n\nExcept that one guy.' });
    const html = await (await fetch(`${base}/credits`)).text();
    assert.deepEqual(paragraphs(html, 'credits-note'), ['Thanks everyone.', 'Except that one guy.']);
  } finally {
    await putContent({ creditsNote: original });
  }
});

// --- Editing ---------------------------------------------------------------

test('page text round-trips from the admin panel to the public pages', async () => {
  try {
    const res = await putContent({
      feedbackSubtitle: 'Say something.',
      creditsSubtitle: 'Made possible by.',
      creditsNote: 'A very short note.',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).content.creditsSubtitle, 'Made possible by.');

    const credits = await (await fetch(`${base}/credits`)).text();
    assert.match(credits, /<p class="subtitle">Made possible by\.<\/p>/);
    assert.match(credits, /<p class="credits-note">A very short note\.<\/p>/);
    assert.match(await (await fetch(`${base}/feedback`)).text(), /<p class="subtitle">Say something\.<\/p>/);

    // The admin panel reads the same values back.
    const stored = await (await fetch(`${base}/api/admin/content`, { headers: { Cookie: cookie } })).json();
    assert.equal(stored.content.feedbackSubtitle, 'Say something.');
    assert.equal(stored.content.creditsNote, 'A very short note.');
  } finally {
    await putContent({
      feedbackSubtitle: DEFAULT_PAGE_TEXT.feedbackSubtitle,
      creditsSubtitle: DEFAULT_PAGE_TEXT.creditsSubtitle,
      creditsNote: DEFAULT_PAGE_TEXT.creditsNote,
    });
  }
});

test('a cleared field stays cleared rather than falling back to the seed copy', async () => {
  try {
    await putContent({ creditsSubtitle: '', creditsNote: '' });
    const html = await (await fetch(`${base}/credits`)).text();
    // An empty value renders nothing at all — not the default, and not an empty <p>.
    assert.doesNotMatch(html, /class="subtitle"/);
    assert.doesNotMatch(html, /class="credits-note"/);
  } finally {
    await putContent({
      creditsSubtitle: DEFAULT_PAGE_TEXT.creditsSubtitle,
      creditsNote: DEFAULT_PAGE_TEXT.creditsNote,
    });
  }
});

test('page text and credit lines are escaped, never rendered as markup', async () => {
  try {
    await putContent({ creditsSubtitle: '<script>alert(1)</script>' });
    const html = await (await fetch(`${base}/credits`)).text();
    assert.ok(!html.includes('<script>alert(1)</script>'), 'the subtitle must not become markup');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  } finally {
    await putContent({ creditsSubtitle: DEFAULT_PAGE_TEXT.creditsSubtitle });
  }
});

test('an over-long value is rejected, and unknown keys are ignored', async () => {
  const tooLong = await putContent({ feedbackSubtitle: 'x'.repeat(301) });
  assert.equal(tooLong.status, 400);
  assert.match((await tooLong.json()).error, /feedbackSubtitle is too long/);

  // A page-text save cannot reach the site metadata: only the known keys are written.
  const res = await putContent({ siteTitle: 'hijacked' });
  assert.equal(res.status, 200);
  assert.equal((await (await fetch(`${base}/api/site`)).json()).siteTitle, '');
});

test('a save writes only the keys it sends', async () => {
  const before = await (await fetch(`${base}/api/admin/content`, { headers: { Cookie: cookie } })).json();
  try {
    const res = await putContent({ feedbackSubtitle: 'Only this one.' });
    assert.equal(res.status, 200);
    const after = (await res.json()).content;
    assert.equal(after.feedbackSubtitle, 'Only this one.');
    // Everything else is untouched — the panel sends only what changed, so an omitted key
    // must mean "leave it", not "clear it" (see page-text-config.js).
    assert.equal(after.feedbackIntro, before.content.feedbackIntro);
    assert.equal(after.creditsSubtitle, before.content.creditsSubtitle);
    assert.equal(after.creditsNote, before.content.creditsNote);
  } finally {
    await putContent({ feedbackSubtitle: before.content.feedbackSubtitle });
  }
});

test('control characters are stripped rather than stored', async () => {
  try {
    await putContent({ creditsSubtitle: 'Bell\u0007 and NUL\u0000 and vertical\u000b tab.' });
    const stored = (await (await fetch(`${base}/api/admin/content`, { headers: { Cookie: cookie } })).json())
      .content.creditsSubtitle;
    assert.equal(stored, 'Bell and NUL and vertical tab.');

    const created = await addCredit({ role: 'Built\u0000with', value: 'Node\u0007js', url: '' });
    const { credit } = await created.json();
    try {
      assert.equal(credit.role, 'Builtwith');
      assert.equal(credit.value, 'Nodejs');
    } finally {
      await deleteCredit(credit.id);
    }
  } finally {
    await putContent({ creditsSubtitle: DEFAULT_PAGE_TEXT.creditsSubtitle });
  }
});

// The admin panel submits only the fields that changed, so that a save from a panel whose
// load has not resolved cannot write empty strings over the stored copy. The rule itself is
// pure logic and lives in its own module (like email-config.js for D19) so it can be tested
// here rather than only in a browser.
test('changedPageTextFields sends only real edits, never a blank panel', () => {
  const stored = { feedbackSubtitle: 'A', feedbackIntro: 'B', creditsSubtitle: 'C', creditsNote: 'D' };

  // Nothing touched.
  assert.deepEqual(changedPageTextFields(stored, stored), {});
  // A panel that has not loaded holds empty fields; that must send nothing.
  const blank = { feedbackSubtitle: '', feedbackIntro: '', creditsSubtitle: '', creditsNote: '' };
  assert.deepEqual(changedPageTextFields(blank, null), {});
  // One edit sends one key.
  assert.deepEqual(changedPageTextFields({ ...stored, creditsNote: 'new' }, stored), { creditsNote: 'new' });
  // Clearing a field deliberately IS a change, and is sent as an empty string.
  assert.deepEqual(changedPageTextFields({ ...stored, creditsNote: '' }, stored), { creditsNote: '' });
  // A field typed into before the load completed is still saved, and the untouched ones are not.
  assert.deepEqual(changedPageTextFields({ ...blank, feedbackIntro: 'typed' }, null), { feedbackIntro: 'typed' });
});

test('the content endpoints require a session', async () => {
  for (const [method, url] of [
    ['GET', '/api/admin/content'],
    ['PUT', '/api/admin/content'],
    ['POST', '/api/admin/credits'],
    ['PUT', '/api/admin/credits/order'],
  ]) {
    const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 401, `${method} ${url} should require auth`);
  }
});

// --- Credit lines ----------------------------------------------------------

test('a credit line can be added, edited, reordered and deleted', async () => {
  const created = await addCredit({ role: 'Testing', value: 'The test suite', url: 'https://example.com/suite' });
  assert.equal(created.status, 201);
  const { credit } = await created.json();
  try {
    let html = await (await fetch(`${base}/credits`)).text();
    // New lines go to the end of the list.
    assert.equal(creditRoles(html).at(-1), 'Testing');
    assert.match(html, /<a class="credit-link" href="https:\/\/example\.com\/suite"/);

    const updated = await putCredit(credit.id, { role: 'Verified by', value: 'The test suite', url: '' });
    assert.equal(updated.status, 200);
    html = await (await fetch(`${base}/credits`)).text();
    assert.equal(creditRoles(html).at(-1), 'Verified by');
    // With no URL the value is plain text, not a dead link.
    assert.match(html, /<span class="credit-link">The test suite<\/span>/);
  } finally {
    assert.equal((await deleteCredit(credit.id)).status, 200);
  }

  const gone = await (await fetch(`${base}/credits`)).text();
  assert.doesNotMatch(gone, /Verified by/);
  assert.equal((await deleteCredit(credit.id)).status, 404);
});

test('a credit line needs a value, and its link must be an http(s) URL', async () => {
  for (const [body, message] of [
    [{ role: 'Built with' }, /value is required/],
    [{ value: '   ' }, /value is required/],
    [{ value: 'X', url: 'javascript:alert(1)' }, /url must be a valid http\(s\) URL/],
    [{ value: 'X', url: 'example.com' }, /url must be a valid http\(s\) URL/],
    [{ value: 'x'.repeat(201) }, /value is required \(max 200 chars\)/],
  ]) {
    const res = await addCredit(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, message);
  }
});

test('a credit line with no role renders as a value on its own', async () => {
  const created = await addCredit({ role: '', value: 'Nobody in particular', url: '' });
  const { credit } = await created.json();
  try {
    const html = await (await fetch(`${base}/credits`)).text();
    assert.match(html, /<div class="credit-item">\s*<span class="credit-link">Nobody in particular<\/span>/);
  } finally {
    await deleteCredit(credit.id);
  }
});

test('credit lines are escaped on the page', async () => {
  const created = await addCredit({ role: '<b>bold</b>', value: '"quoted" & <em>marked</em>', url: '' });
  const { credit } = await created.json();
  try {
    const html = await (await fetch(`${base}/credits`)).text();
    assert.doesNotMatch(html, /<b>bold<\/b>/);
    assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
    assert.match(html, /&quot;quoted&quot; &amp; &lt;em&gt;marked&lt;\/em&gt;/);
  } finally {
    await deleteCredit(credit.id);
  }
});

test('the order endpoint rewrites the whole list, and refuses a stale one', async () => {
  const before = listCredits().map((c) => c.id);
  try {
    const reversed = [...before].reverse();
    const res = await postOrder(reversed);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).credits.map((c) => c.id), reversed);

    const html = await (await fetch(`${base}/credits`)).text();
    const roles = creditRoles(html);
    assert.equal(roles[0], DEFAULT_CREDITS.at(-1).role);
    assert.equal(roles.at(-1), DEFAULT_CREDITS[0].role);

    // A partial list would leave rows with duplicate or missing positions.
    const partial = await postOrder(reversed.slice(1));
    assert.equal(partial.status, 409);
    // Duplicates are refused too, as is anything that is not an id.
    assert.equal((await postOrder([...reversed.slice(0, -1), reversed[0]])).status, 409);
    assert.equal((await postOrder(['1', 2])).status, 400);
  } finally {
    assert.equal((await postOrder(before)).status, 200);
  }

  assert.deepEqual(creditRoles(await (await fetch(`${base}/credits`)).text()), DEFAULT_CREDITS.map((c) => c.role));
});

test('the credits page renders with no lines at all', async () => {
  const ids = listCredits().map((c) => c.id);
  for (const id of ids) assert.equal((await deleteCredit(id)).status, 200);

  const res = await fetch(`${base}/credits`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /class="credit-item"/);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
});

// --- Seeding is a one-time event -------------------------------------------

// The seeding in migrate() has to be idempotent in the specific way the admin panel
// depends on: an edited value stays edited, a cleared value stays cleared, and deleted
// credit lines are not resurrected by the next boot. A fresh database in a temp
// directory is used so the checks run against a real `migrate()` rather than the
// already-initialised test connection.
test('a second migrate() neither resurrects deleted lines nor overwrites edits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibefolio-content-'));
  const d = new DatabaseSync(path.join(dir, 'seed.db'));
  try {
    migrate(d);
    assert.equal(d.prepare('SELECT count(*) AS c FROM credits').get().c, DEFAULT_CREDITS.length);
    assert.equal(
      d.prepare("SELECT value FROM settings WHERE key = 'creditsSubtitle'").get().value,
      DEFAULT_PAGE_TEXT.creditsSubtitle
    );

    // The admin edits one value, clears another, and deletes every credit line.
    d.exec('DELETE FROM credits');
    d.prepare("UPDATE settings SET value = 'My own words' WHERE key = 'creditsSubtitle'").run();
    d.prepare("UPDATE settings SET value = '' WHERE key = 'creditsNote'").run();

    migrate(d); // the next boot

    assert.equal(d.prepare('SELECT count(*) AS c FROM credits').get().c, 0);
    assert.equal(
      d.prepare("SELECT value FROM settings WHERE key = 'creditsSubtitle'").get().value,
      'My own words'
    );
    assert.equal(d.prepare("SELECT value FROM settings WHERE key = 'creditsNote'").get().value, '');
  } finally {
    d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
