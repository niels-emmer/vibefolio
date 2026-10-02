// Backup & restore (see docs/decisions.md D25).
//
// The unit half drives `src/backup.js` directly; the HTTP half drives the three endpoints
// through the real app, because the parts that are easy to get wrong are the ones in
// between — the raw body parser, the auth scope, and the staging that makes the apply step
// take its archive from the server rather than from the request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startTestServer, login } from './helpers.js';
import * as backup from '../src/backup.js';
import * as store from '../src/db.js';
import { migrate } from '../src/db.js';
import { isPngBase64, isPngDataUrl } from '../src/validate.js';
import { config } from '../src/config.js';

// A real 1x1 PNG. The archive validator decodes and checks the signature, so a plausible
// string would not do.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server, base, auth;

before(async () => {
  ({ server, base } = await startTestServer());
  const { cookie } = await login(base);
  auth = { Cookie: cookie, Origin: base };
});

after(() => server.close());

// --- Building --------------------------------------------------------------

test('the archive carries the content and leaves out the secrets and the seed marker', () => {
  store.setSetting('siteTitle', 'Archive Site');
  store.setSetting('smtpHost', 'smtp.example.com');
  store.setSetting('smtpPassword', 'hunter2-must-not-ship');
  store.setSetting('siteIconPng', PNG_B64);
  store.createService({
    name: 'Alpha',
    url: 'https://alpha.example.com',
    description: 'First',
    icon: '🚀',
    enabled: true,
    iconImage: PNG_B64,
  });
  store.createCredit({ role: 'Built with', value: 'Alpha' });

  const archive = backup.buildArchive();
  assert.equal(archive.format, 'vibefolio-backup');
  assert.equal(archive.version, 1);
  assert.match(archive.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(archive.data.settings.siteTitle, 'Archive Site');
  assert.equal(archive.data.settings.smtpHost, 'smtp.example.com');

  // The three things that must never be in a backup.
  assert.ok(!('smtpPassword' in archive.data.settings), 'the SMTP password must not be exported');
  assert.ok(!('creditsSeeded' in archive.data.settings), 'the seed marker is history, not content');
  assert.ok(!('sessions' in archive.data), 'a backup is not a way to carry a login');

  const [svc] = archive.data.services;
  assert.equal(svc.name, 'Alpha');
  assert.equal(svc.iconImage, PNG_B64);
  // Runtime state is the health checker's output, stale the moment the file is written.
  for (const key of ['status', 'latencyMs', 'lastChecked']) {
    assert.ok(!(key in svc), `${key} should not be exported`);
  }
  assert.equal(archive.data.credits.length, store.listCredits().length);
  assert.ok(archive.data.credits.some((c) => c.value === 'Alpha'));

  // Not merely unlabelled: the password must not be anywhere in the bytes.
  const text = zlib.gunzipSync(backup.serializeArchive(archive)).toString('utf8');
  assert.ok(!text.includes('hunter2-must-not-ship'), 'the password leaked into the archive');
});

test('an archive round-trips through gzip unchanged', () => {
  // Captured once: comparing `parse(serialize(build()))` against a *second* `build()` would
  // pass even if `buildArchive` were nondeterministic (a `Date.now()`-derived field, say).
  const before = backup.buildArchive();
  const after = backup.parseArchive(backup.serializeArchive(before));
  assert.deepEqual(after.data.services, before.data.services);
  assert.deepEqual(after.data.credits, before.data.credits);
  assert.deepEqual(after.data.settings, before.data.settings);
  assert.equal(after.version, 1);
});

test('isPngBase64 accepts a stored payload and rejects a data URL', () => {
  assert.equal(isPngBase64(PNG_B64), true);
  assert.equal(isPngBase64(`data:image/png;base64,${PNG_B64}`), false, 'the prefix must be stripped');
  assert.equal(isPngBase64(Buffer.from('not a png at all').toString('base64')), false);
  assert.equal(isPngBase64(''), false);
  assert.equal(isPngBase64(null), false);
  // The data-URL form keeps its own behaviour: it is the admin upload path, and it still
  // accepts what it always did.
  assert.equal(isPngDataUrl(`data:image/png;base64,${PNG_B64}`), true);
  assert.equal(isPngDataUrl(PNG_B64), false);
});

test('the download filename is UTC and sorts chronologically', () => {
  const name = backup.archiveFilename(new Date('2026-10-01T14:30:00Z'));
  assert.equal(name, 'vibefolio-backup-2026-10-01-1430.json.gz');
});

// --- Validation ------------------------------------------------------------

// Every case here is a file the admin could plausibly pick by mistake, plus the ones a
// hostile client would send. All of them must fail closed, with a message that says what is
// wrong rather than a stack trace.
test('parseArchive refuses anything that is not a valid archive', () => {
  const good = backup.buildArchive();
  const cases = [
    ['an empty upload', Buffer.alloc(0)],
    ['a file that is not gzip', Buffer.from('{"format":"vibefolio-backup"}')],
    ['gzip of something that is not JSON', zlib.gzipSync(Buffer.from('not json at all'))],
    ['gzip of JSON that is not an object', zlib.gzipSync(Buffer.from('[1,2,3]'))],
    ['a foreign format', gzipJson({ ...good, format: 'something-else' })],
    ['a missing format', gzipJson({ ...good, format: undefined })],
    ['a version that is not a number', gzipJson({ ...good, version: 'one' })],
    ['an archive from the future', gzipJson({ ...good, version: backup.ARCHIVE_VERSION + 1 })],
    ['an unknown top-level key', gzipJson({ ...good, extra: true })],
    ['an unknown key in data', gzipJson({ ...good, data: { ...good.data, secret: {} } })],
    ['a settings block that is not an object', gzipJson({ ...good, data: { ...good.data, settings: [] } })],
    ['an unknown setting', gzipJson(withSetting(good, 'backdoor', '1'))],
    [
      'a service with no URL',
      gzipJson(withServices(good, [{ ...good.data.services[0], url: '' }])),
    ],
    [
      'a service with a javascript: URL',
      gzipJson(withServices(good, [{ ...good.data.services[0], url: 'javascript:alert(1)' }])),
    ],
    ['a service with no id', gzipJson(withServices(good, [{ ...good.data.services[0], id: 0 }]))],
    [
      'two services sharing an id',
      gzipJson(withServices(good, [good.data.services[0], { ...good.data.services[0], name: 'Copy' }])),
    ],
    ['a service whose id is a string', gzipJson(withServices(good, [{ ...good.data.services[0], id: '1' }]))],
    [
      'a credit line with no value',
      gzipJson({ ...good, data: { ...good.data, credits: [{ id: 1, role: '', value: '', url: '' }] } }),
    ],
    ['an archive that is too large', Buffer.alloc(backup.MAX_UPLOAD_BYTES + 1)],
  ];

  for (const [what, buffer] of cases) {
    assert.throws(
      () => backup.parseArchive(buffer),
      (err) => err instanceof backup.ArchiveError && err.message.length > 0,
      `${what} should be refused`
    );
  }
});

test('a decompression bomb is refused rather than expanded', () => {
  // 33 MB of zeros compresses to ~33 kB: without `maxOutputLength` this is a 1000:1
  // amplification, and the process is capped at 256 MB.
  const bomb = zlib.gzipSync(Buffer.alloc(backup.MAX_EXPANDED_BYTES + 1024 * 1024));
  assert.ok(bomb.length < 100_000, 'the bomb should be small on the wire');
  assert.throws(
    () => backup.parseArchive(bomb),
    (err) => err instanceof backup.ArchiveError && /size limit/.test(err.message)
  );
});

test('artwork must be a real PNG', () => {
  const good = backup.buildArchive();
  const bad = { ...good.data.services[0], iconImage: Buffer.from('definitely not a png').toString('base64') };
  assert.throws(
    () => backup.parseArchive(gzipJson(withServices(good, [bad]))),
    (err) => err instanceof backup.ArchiveError && /iconImage is not a PNG/.test(err.message)
  );

  // An empty string is a real state — it is what "reset to the default icon" stores.
  const cleared = { ...good.data.services[0], iconImage: null, thumbnailImage: null };
  const parsed = backup.parseArchive(gzipJson(withServices(good, [cleared])));
  assert.equal(parsed.data.services[0].iconImage, null);
});

test('the archive reports every problem it found, not just the first', () => {
  const good = backup.buildArchive();
  const broken = withServices(good, [
    { ...good.data.services[0], url: 'nope' },
    { ...good.data.services[0], id: 99, name: '' },
  ]);
  assert.throws(
    () => backup.parseArchive(gzipJson(broken)),
    (err) => /data\.services\[0\]/.test(err.message) && /data\.services\[1\]/.test(err.message)
  );
});

// --- Summarising -----------------------------------------------------------

test('summarize counts what the archive holds, per category', () => {
  // The full known state is written here rather than borrowed from an earlier test: the
  // counts below are the point, and an assertion that silently depends on another test's
  // leftovers breaks the day that test changes.
  for (const [key, value] of [
    ['siteTitle', 'S'],
    ['homepageTitle', 'H'],
    ['siteDescription', 'D'],
    ['siteUrl', 'https://example.com'],
    ['siteFooter', 'F'],
    ['showStats', '1'],
    ['accentColor', 'cyan'],
    ['wallpaperAnchor', 'top'],
    ['wallpaperSize', 'cover'],

    ['wallpaperTransparency', '25'],
    ['backgroundColor', '#123456'],
    ['siteIconPng', PNG_B64],
    ['faviconPng', ''],
    ['smtpHost', 'smtp.example.com'],
    ['smtpPort', '587'],
    ['smtpSecure', '0'],
    ['feedbackEnabled', '1'],
  ]) {
    store.setSetting(key, value);
  }

  const archive = backup.buildArchive();
  const summary = backup.summarize(archive);
  const byId = Object.fromEntries(summary.categories.map((c) => [c.id, c]));

  assert.equal(summary.categories.length, 7);
  assert.equal(byId.services.count, archive.data.services.length);
  assert.equal(byId.services.unit, 'services');
  assert.match(byId.services.detail, /icon/);
  assert.equal(byId.credits.count, archive.data.credits.length);
  assert.equal(byId.settings.count, 11); // SETTING_KEYS
  assert.equal(byId.pageText.count, 4); // PAGE_TEXT_KEYS, seeded by migrate()
  assert.equal(byId.artwork.count, 1, 'the favicon is present but empty, so it is not an image');
  assert.equal(byId.email.count, 4); // smtpHost, smtpPort, smtpSecure, feedbackEnabled
  // Every category carries the label and hint the modal renders.
  for (const category of summary.categories) {
    assert.ok(category.label && category.hint, `${category.id} needs a label and a hint`);
  }
});

// The one thing a restore can do that the archive cannot describe: the modal defaults every
// category to checked, and restoring a category whose archive is *empty* deletes whatever is
// deployed (replace, not merge — D25). An archive written before the wallpaper existed
// reports "0 images" for it, so confirming a default restore would remove a live wallpaper
// with nothing in the UI to say so. The server flags it; this is the flag.
test('summarize flags a category that would clear something that is live', () => {
  store.setSetting('wallpaperPng', PNG_B64);
  store.setSetting('siteIconPng', PNG_B64);

  // An archive from before either image existed: no wallpaper, no icon.
  const withNothing = backup.buildArchive();
  withNothing.data.settings.wallpaperPng = '';
  withNothing.data.settings.siteIconPng = '';

  const current = store.getAllSettings();
  const byId = Object.fromEntries(backup.summarize(withNothing, current).categories.map((c) => [c.id, c]));

  assert.equal(byId.wallpaper.count, 0);
  assert.equal(byId.wallpaper.clears, 'the wallpaper', 'a live wallpaper about to be deleted must be flagged');
  assert.equal(byId.artwork.clears, 'the site icon');

  // With no `current` (the pre-change call shape) nothing is flagged, so an older caller
  // cannot render a warning it did not ask for.
  const unguarded = Object.fromEntries(backup.summarize(withNothing).categories.map((c) => [c.id, c]));
  assert.equal(unguarded.wallpaper.clears, undefined);

  // And when the archive *does* carry an image there is nothing to warn about — the restore
  // replaces it with another one rather than removing it.
  store.setSetting('wallpaperPng', PNG_B64);
  const withImage = backup.buildArchive();
  const filled = Object.fromEntries(backup.summarize(withImage, store.getAllSettings()).categories.map((c) => [c.id, c]));
  assert.equal(filled.wallpaper.count, 1);
  assert.equal(filled.wallpaper.clears, undefined);

  // Non-image categories never carry the flag: clearing absent text or settings is not a
  // surprise the admin needs to be warned about.
  for (const id of ['settings', 'pageText', 'email', 'services', 'credits']) {
    assert.equal(byId[id].clears, undefined, `${id} should not carry a clears flag`);
  }
});

// The `artwork` category spans two keys and they are not always written in lockstep, so the
// flag has to consider both. Keying it off `siteIconPng` alone let a restore delete a live
// *favicon* without saying so — the same silent appearance change the flag exists to catch,
// just through the other key.
test('the artwork warning covers a favicon that is live without a site icon', () => {
  store.setSetting('siteIconPng', '');
  store.setSetting('faviconPng', PNG_B64);

  const emptyArtwork = backup.buildArchive();
  emptyArtwork.data.settings.siteIconPng = '';
  emptyArtwork.data.settings.faviconPng = '';

  const byId = Object.fromEntries(
    backup.summarize(emptyArtwork, store.getAllSettings()).categories.map((c) => [c.id, c])
  );
  assert.equal(byId.artwork.count, 0);
  assert.equal(
    byId.artwork.clears,
    'the site icon',
    'a live favicon must be warned about even when the site icon is empty'
  );

  // And with neither set there is nothing to warn about.
  store.setSetting('faviconPng', '');
  const neither = Object.fromEntries(
    backup.summarize(emptyArtwork, store.getAllSettings()).categories.map((c) => [c.id, c])
  );
  assert.equal(neither.artwork.clears, undefined);
});

// --- Applying --------------------------------------------------------------

test('applyRestore replaces the selected category and leaves the others alone', () => {
  const before = {
    title: store.getSetting('siteTitle'),
    services: store.listServices().map((s) => s.name),
    credits: store.listCredits().map((c) => c.value),
  };
  const archive = backup.parseArchive(backup.serializeArchive(backup.buildArchive()));

  // Move everything, then restore only the services.
  store.setSetting('siteTitle', 'Moved On');
  store.replaceServices([]);
  store.createCredit({ role: '', value: 'A line that was not in the archive' });

  const applied = backup.applyRestore(archive, ['services']);
  assert.deepEqual(applied, { services: before.services.length });
  assert.deepEqual(store.listServices().map((s) => s.name), before.services);
  assert.equal(store.getSetting('siteTitle'), 'Moved On', 'an unselected category must not move');
  assert.equal(
    store.listCredits().length,
    before.credits.length + 1,
    'an unselected category must not move'
  );
});

test('a restore replaces rather than merges: rows the archive does not mention are gone', () => {
  const archive = backup.parseArchive(backup.serializeArchive(backup.buildArchive()));
  store.createCredit({ role: '', value: 'Only in the database' });
  store.createService({ name: 'Only in the database', url: 'https://extra.example.com', description: '', icon: '', enabled: true });

  backup.applyRestore(archive, ['services', 'credits']);
  assert.ok(!store.listServices().some((s) => s.name === 'Only in the database'));
  assert.ok(!store.listCredits().some((c) => c.value === 'Only in the database'));
});

test('a restore leaves the stored SMTP password alone', () => {
  store.setSetting('smtpPassword', 'the-live-password');
  const archive = backup.parseArchive(backup.serializeArchive(backup.buildArchive()));
  store.setSetting('smtpHost', 'somewhere-else.example.com');

  backup.applyRestore(archive, ['email']);
  assert.equal(store.getSetting('smtpHost'), 'smtp.example.com');
  assert.equal(store.getSetting('smtpPassword'), 'the-live-password');
});

test('the SMTP protocol is derived from the port, not taken from the archive', () => {
  const good = backup.buildArchive();
  // A hand-edited pair that disagrees with itself: port 465 is implicit TLS.
  const forged = withSetting(withSetting(good, 'smtpPort', '465'), 'smtpSecure', '0');
  const parsed = backup.parseArchive(gzipJson(forged));
  backup.applyRestore(parsed, ['email']);
  assert.equal(store.getSetting('smtpSecure'), '1', '465 must win over the archived flag');
});

test('an unknown category is refused before anything is written', () => {
  const archive = backup.parseArchive(backup.serializeArchive(backup.buildArchive()));
  const title = store.getSetting('siteTitle');
  store.setSetting('siteTitle', 'Untouched');
  assert.throws(() => backup.applyRestore(archive, ['services', 'not-a-category']), backup.ArchiveError);
  assert.throws(() => backup.applyRestore(archive, []), backup.ArchiveError);
  assert.equal(store.getSetting('siteTitle'), 'Untouched', 'a refused restore must write nothing');
  store.setSetting('siteTitle', title);
});

// The end-to-end shape a real restore has, and the properties a per-category unit test cannot
// see: ids that survive the round trip, the `'0'` half of the two boolean-ish keys, and the
// `creditsSeeded` marker that keeps `migrate()` from re-seeding the credit lines afterwards.
test('restoring every category reproduces ids, order and the "0" booleans', () => {
  store.replaceServices([
    svcRow(7, 'Seven', 0),
    svcRow(42, 'Forty Two', 1),
  ]);
  store.replaceCredits([{ id: 3, role: 'Built with', value: 'Three', url: '', sortOrder: 0, createdAt: 1, updatedAt: 1 }]);
  store.setSetting('showStats', '0');
  store.setSetting('feedbackEnabled', '0');
  store.setSetting('siteIconPng', '');
  const archive = backup.parseArchive(backup.serializeArchive(backup.buildArchive()));

  // Wipe it all and flip both booleans the other way.
  store.replaceServices([]);
  store.replaceCredits([]);
  store.setSetting('showStats', '1');
  store.setSetting('feedbackEnabled', '1');
  store.setSetting('siteIconPng', PNG_B64);

  const applied = backup.applyRestore(archive, ['settings', 'pageText', 'artwork', 'wallpaper', 'email', 'services', 'credits']);
  assert.deepEqual(applied, { settings: 11, pageText: 4, artwork: 2, wallpaper: 1, email: 4, services: 2, credits: 1 });

  // Explicit ids, so `/service-icon/:id.png` URLs and the drag order survive a restore.
  assert.deepEqual(store.listServices().map((s) => [s.id, s.name]), [[7, 'Seven'], [42, 'Forty Two']]);
  assert.deepEqual(store.listCredits().map((c) => [c.id, c.value]), [[3, 'Three']]);
  assert.equal(store.getSetting('showStats'), '0');
  assert.equal(store.getSetting('feedbackEnabled'), '0');
  assert.equal(store.getSetting('siteIconPng'), '');

  // The seed marker is not content and no category owns it, so a restore must leave it —
  // otherwise the next boot would resurrect the default credit lines on top of the restored
  // ones (D22).
  assert.equal(store.getSetting('creditsSeeded'), '1');
  const creditsAfterRestore = store.listCredits().length;
  migrate(store.initDb());
  assert.equal(store.listCredits().length, creditsAfterRestore, 'a restore must not re-seed the credits');
});

test('a restore reports a row count per category, including zeroes for empty ones', () => {
  store.replaceServices([]);
  store.replaceCredits([]);
  const archive = backup.parseArchive(backup.serializeArchive(backup.buildArchive()));
  const applied = backup.applyRestore(archive, ['services', 'credits']);
  assert.deepEqual(applied, { services: 0, credits: 0 });
  assert.deepEqual(store.listServices(), []);
});

test('an oversized upload is refused by the parser, before it is validated', async () => {
  const res = await postArchive('/api/admin/restore/inspect', Buffer.alloc(backup.MAX_UPLOAD_BYTES + 1024));
  assert.equal(res.status, 413);
});

test('an unauthenticated upload is refused without its body being read', async () => {
  // The raw parser is registered on the route, *after* requireAuth: with it mounted app-wide
  // on this path, body-parser would buffer the whole 12 MB before anything could refuse the
  // request, letting an anonymous client pin that much per connection against a 256 MB
  // container. The 401 proves the refusal happens first; that the body was never buffered is
  // the reason the parser sits where it does.
  const res = await fetch(`${base}/api/admin/restore/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip', Origin: base },
    body: Buffer.alloc(1024 * 1024),
  });
  assert.equal(res.status, 401);
});

// --- HTTP ------------------------------------------------------------------

test('the download endpoint requires a session and serves a gzip archive', async () => {
  const anon = await fetch(`${base}/api/admin/backup`);
  assert.equal(anon.status, 401);

  const res = await fetch(`${base}/api/admin/backup`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.match(
    res.headers.get('content-disposition'),
    /^attachment; filename="vibefolio-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json\.gz"$/
  );
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const parsed = backup.parseArchive(Buffer.from(await res.arrayBuffer()));
  assert.equal(parsed.format, 'vibefolio-backup');
});

test('the login endpoint is not shadowed by the backup router', async () => {
  // The backup router is mounted on /api/admin ahead of the admin router. An unscoped
  // `requireAuth` there would refuse /api/admin/login with a 401 before the admin router
  // ever saw it — which is exactly the bug this pins.
  const { res } = await login(base);
  assert.equal(res.status, 200);
});

test('inspect validates and stages an upload without writing anything', async () => {
  const res = await fetch(`${base}/api/admin/backup`, { headers: auth });
  const archive = Buffer.from(await res.arrayBuffer());
  const services = store.listServices().map((s) => s.name);

  const inspect = await postArchive('/api/admin/restore/inspect', archive);
  assert.equal(inspect.status, 200);
  const body = await inspect.json();
  assert.match(body.uploadId, /^[a-f0-9]{32}$/);
  assert.ok(body.expiresAt > Date.now());
  assert.equal(body.archive.size, archive.length);
  assert.equal(body.archive.categories.length, 7);
  assert.deepEqual(store.listServices().map((s) => s.name), services, 'inspect must not write');

  await discard(body.uploadId);
});

test('a damaged upload is refused at inspect time, with a readable message', async () => {
  const res = await postArchive('/api/admin/restore/inspect', Buffer.from('not a gzip file'));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /gzip/i);
});

test('an upload with the wrong content type is refused rather than silently empty', async () => {
  const res = await fetch(`${base}/api/admin/restore/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /raw bytes/);
});

test('inspect and apply both require a session', async () => {
  const inspect = await fetch(`${base}/api/admin/restore/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip', Origin: base },
    body: Buffer.from('x'),
  });
  assert.equal(inspect.status, 401);
  const apply = await fetch(`${base}/api/admin/restore/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ uploadId: 'whatever', categories: ['services'] }),
  });
  assert.equal(apply.status, 401);
});

test('a staged upload cannot be applied from another session', async () => {
  const archive = await download();
  const { uploadId } = await inspect(archive);

  const other = await login(base);
  const res = await fetch(`${base}/api/admin/restore/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: other.cookie, Origin: base },
    body: JSON.stringify({ uploadId, categories: ['services'] }),
  });
  assert.equal(res.status, 409, 'another session must not be able to apply this upload');
  await discard(uploadId);
});

test('an unknown or expired upload is refused', async () => {
  const res = await fetch(`${base}/api/admin/restore/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ uploadId: 'f'.repeat(32), categories: ['services'] }),
  });
  assert.equal(res.status, 409);
});

test('apply without an uploadId is a bad request, not an expired one', async () => {
  for (const body of [{ categories: ['services'] }, { uploadId: 42, categories: ['services'] }]) {
    const res = await fetch(`${base}/api/admin/restore/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `${JSON.stringify(body)} should be a 400`);
  }
});

test('a restore applies the chosen categories and can be undone with its snapshot', async () => {
  // 1. A known state to come back to.
  store.setSetting('siteTitle', 'Before the restore');
  store.replaceServices([]);
  store.createService({ name: 'Alpha', url: 'https://alpha.example.com', description: 'A', icon: '', enabled: true });
  const archive = await download();

  // 2. Move on: a different title and a different service.
  store.setSetting('siteTitle', 'After the move');
  store.replaceServices([]);
  store.createService({ name: 'Beta', url: 'https://beta.example.com', description: 'B', icon: '', enabled: true });

  // 3. Restore only the services, and check the title was left where it was.
  const { uploadId } = await inspect(archive);
  const apply = await fetch(`${base}/api/admin/restore/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ uploadId, categories: ['services'] }),
  });
  assert.equal(apply.status, 200);
  const result = await apply.json();
  assert.deepEqual(result.applied, { services: 1 });
  assert.deepEqual(store.listServices().map((s) => s.name), ['Alpha']);
  assert.equal(store.getSetting('siteTitle'), 'After the move');

  // 4. The snapshot holds what was there a moment ago, and restoring it undoes the restore.
  assert.match(result.snapshot.name, /^pre-restore-\d{4}-\d{2}-\d{2}-\d{9}\.json\.gz$/);
  assert.ok(result.snapshot.size > 0);

  const listed = await (await fetch(`${base}/api/admin/backup/snapshots`, { headers: auth })).json();
  assert.ok(listed.snapshots.some((s) => s.name === result.snapshot.name));

  const snapshotRes = await fetch(`${base}/api/admin/backup/snapshots/${result.snapshot.name}`, { headers: auth });
  assert.equal(snapshotRes.status, 200);
  const snapshotArchive = Buffer.from(await snapshotRes.arrayBuffer());
  const { uploadId: undoId } = await inspect(snapshotArchive);
  const undo = await fetch(`${base}/api/admin/restore/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ uploadId: undoId, categories: ['services'] }),
  });
  assert.equal(undo.status, 200);
  assert.deepEqual(store.listServices().map((s) => s.name), ['Beta'], 'the snapshot must undo the restore');
});

test('an apply with no categories is refused and writes no snapshot', async () => {
  const archive = await download();
  const { uploadId } = await inspect(archive);
  const before = (await (await fetch(`${base}/api/admin/backup/snapshots`, { headers: auth })).json()).snapshots.length;

  const res = await fetch(`${base}/api/admin/restore/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ uploadId, categories: [] }),
  });
  assert.equal(res.status, 400);

  const after = (await (await fetch(`${base}/api/admin/backup/snapshots`, { headers: auth })).json()).snapshots.length;
  assert.equal(after, before, 'a refused restore must not leave a snapshot behind');
  await discard(uploadId);
});

test('discard drops a staged upload', async () => {
  const { uploadId } = await inspect(await download());
  await discard(uploadId);
  const res = await fetch(`${base}/api/admin/restore/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ uploadId, categories: ['services'] }),
  });
  assert.equal(res.status, 409);
});

test('a snapshot name cannot escape the backup directory', async () => {
  assert.equal(backup.readSnapshot('../../etc/passwd'), null);
  assert.equal(backup.readSnapshot('pre-restore-2026-10-01-120000.json.gz/../../x'), null);
  assert.equal(backup.readSnapshot(''), null);
  assert.equal(backup.readSnapshot(undefined), null);

  const res = await fetch(`${base}/api/admin/backup/snapshots/${encodeURIComponent('../../etc/passwd')}`, {
    headers: auth,
  });
  assert.equal(res.status, 404);
});

test('only the five most recent snapshots are kept', () => {
  const dir = config.backupDir;
  for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));

  // Six older files, written directly so the names are distinct to the second, then one
  // real snapshot — the write is what prunes.
  for (let i = 1; i <= 6; i += 1) {
    fs.writeFileSync(path.join(dir, backup.snapshotFilename(new Date(Date.now() - i * 60_000))), 'x');
  }
  const written = backup.writeSnapshot(Buffer.from('the newest'));

  const names = backup.listSnapshots().map((s) => s.name);
  assert.equal(names.length, 5);
  assert.equal(names[0], written.name, 'newest first');
  assert.equal(backup.readSnapshot(written.name).toString(), 'the newest');
  assert.deepEqual(names, [...names].sort().reverse(), 'newest first by name, which is UTC');
});

test('two snapshots in the same millisecond do not overwrite each other', () => {
  const dir = config.backupDir;
  for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));

  // The same `when` for both: the case a timestamp-only name gets wrong, and the one that
  // would destroy the earlier restore's undo point rather than merely duplicating it.
  const when = new Date();
  const first = backup.writeSnapshot(Buffer.from('the earlier state'), when);
  const second = backup.writeSnapshot(Buffer.from('the later state'), when);

  assert.notEqual(first.name, second.name);
  assert.equal(backup.readSnapshot(first.name).toString(), 'the earlier state');
  assert.equal(backup.readSnapshot(second.name).toString(), 'the later state');
  // The nudge must keep "a greater name is a newer file" true, which is what `listSnapshots`
  // relies on — a `-2` suffix would have inverted it.
  assert.ok(second.name > first.name, `${second.name} should sort after ${first.name}`);
  assert.deepEqual(backup.listSnapshots().map((s) => s.name), [second.name, first.name]);
  assert.ok(backup.listSnapshots().every((s) => s.createdAt !== ''), 'the date is still parsed');
});

// --- Helpers ---------------------------------------------------------------

function gzipJson(value) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value)));
}

function withSetting(archive, key, value) {
  return { ...archive, data: { ...archive.data, settings: { ...archive.data.settings, [key]: value } } };
}

function withServices(archive, services) {
  return { ...archive, data: { ...archive.data, services } };
}

// A complete service row as `replaceServices` writes it — used to seed ids the AUTOINCREMENT
// sequence would never hand out, so the test can prove a restore reproduces them.
function svcRow(id, name, sortOrder) {
  return {
    id,
    name,
    icon: '',
    iconImage: null,
    thumbnailImage: null,
    description: '',
    url: `https://${name.toLowerCase().replace(/\s+/g, '-')}.example.com`,
    githubRepo: '',
    techStack: '',
    aiDetails: '',
    story: '',
    audience: '',
    enabled: true,
    sortOrder,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function download() {
  const res = await fetch(`${base}/api/admin/backup`, { headers: auth });
  return Buffer.from(await res.arrayBuffer());
}

function postArchive(url, buffer) {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip', ...auth },
    body: buffer,
  });
}

async function inspect(buffer) {
  const res = await postArchive('/api/admin/restore/inspect', buffer);
  assert.equal(res.status, 200, `inspect failed: ${res.status}`);
  return res.json();
}

async function discard(uploadId) {
  await fetch(`${base}/api/admin/restore/discard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ uploadId }),
  });
}

// The `clears` warning is drawn at inspect time, so a modal left open while the live state
// changes shows a stale picture — and the admin may confirm it anyway. The apply step is the
// last moment the server can see both sides at once, so it re-evaluates and reports what the
// restore removed. Reported, not enforced: the admin confirmed the restore, and refusing it
// then would be worse than doing what they asked and saying what it cost.
test('applying a restore reports what it cleared, against the state at that moment', async () => {
  // An archive with no wallpaper, as an older build would have written.
  store.setSetting('wallpaperPng', '');
  const archive = await download();

  // A wallpaper goes live *after* the archive was taken — the stale-modal case.
  store.setSetting('wallpaperPng', PNG_B64);

  const { uploadId } = await inspect(archive);
  const apply = await fetch(`${base}/api/admin/restore/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ uploadId, categories: ['wallpaper'] }),
  });
  assert.equal(apply.status, 200);
  const result = await apply.json();

  assert.deepEqual(result.cleared, ['the wallpaper'], 'the restore must report the removal');
  assert.equal(store.getSetting('wallpaperPng'), '', 'and the wallpaper really is gone');
});

// The mirror case: with nothing live to clear, the report stays empty rather than carrying a
// warning about something that was never there.
test('a restore that clears nothing reports nothing', async () => {
  store.setSetting('wallpaperPng', '');
  const archive = await download();
  const { uploadId } = await inspect(archive);
  const apply = await fetch(`${base}/api/admin/restore/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ uploadId, categories: ['wallpaper'] }),
  });
  assert.equal(apply.status, 200);
  assert.deepEqual((await apply.json()).cleared, []);
});

// And a category the admin did not select is never reported, even when it would have been
// cleared — the report describes what this restore did, not what it could have done.
test('a restore reports only the categories it was asked to restore', async () => {
  store.setSetting('wallpaperPng', PNG_B64);
  store.setSetting('siteIconPng', ''); // archive has none either
  const archive = await download();
  store.setSetting('siteIconPng', PNG_B64); // live now, and not being restored

  const { uploadId } = await inspect(archive);
  const apply = await fetch(`${base}/api/admin/restore/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ uploadId, categories: ['wallpaper'] }),
  });
  assert.equal(apply.status, 200);
  const result = await apply.json();
  assert.ok(!result.cleared.includes('the site icon'), 'an unselected category is not cleared');
});
