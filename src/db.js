import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { DEFAULT_PAGE_TEXT, DEFAULT_CREDITS } from './content-defaults.js';

/**
 * SQLite persistence layer using the built-in node:sqlite module.
 * No native dependencies, no ORM — just parameterised SQL.
 */

let db;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The bundled ambient photo, used once to seed the wallpaper (see migrate()). It lives in
// `public/img/` as the repo's artwork; from the moment the wallpaper is seeded the app
// serves the seeded copy from the database and this file is only the seed source.
//
// It is a **PNG**, not the JPEG this started as, for one reason: everything the app stores
// as artwork is validated by its PNG signature — the admin uploads, the restore path, and
// therefore this seed too. A JPEG here would seed a value that the very next backup would
// refuse to restore.
//
// It is **truecolour, at the photo's full 1920×1072**, deliberately. An earlier version was
// quantized to 256 colours to keep the file small (525 kB instead of 1.07 MB), which looked
// identical on the page and cost 70% fewer bytes in the repository. It was still wrong: the
// seed and the panel's upload path have to produce the *same kind of image*, and a canvas
// always emits truecolour. With a quantized seed, the shipped wallpaper could not be
// re-uploaded through the panel — re-encoding it produced a file 2.6× larger than the cap,
// so the ladder quietly downscaled the site's own default to 800px. A small seed that cannot
// round-trip through the feature that owns it is not a saving.
const BUNDLED_BACKGROUND = path.join(__dirname, '..', 'public', 'img', 'bg.png');

/**
 * Seeds the wallpaper from the bundled photo, and activates it, the first time the app
 * boots on a database that has no wallpaper.
 *
 * Why: the backdrop used to be a bare `url('/img/bg.jpg')` in the stylesheet. Making the
 * wallpaper an admin setting would otherwise blank the site's background for every visitor
 * of an upgraded deployment — the appearance has to stay exactly the same until the admin
 * changes something (see D26).
 *
 * Two properties this has to have, both of which are why it is not a plain
 * `INSERT OR IGNORE` with the image inline:
 *
 *  - It is a *one-time* migration. The guard is the marker key, not "the setting is empty":
 *    clearing the value is exactly how the admin deletes the wallpaper, and a boot must not
 *    put it back. Deleting the photo and restarting leaves it deleted.
 *  - It only runs on a database that has no marker. A restore that deliberately leaves the
 *    wallpaper out must not be undone at the next boot either, which is the same guard.
 *
 * The bundled photo stores as 1 497 300 base64 characters — inside `MAX_WALLPAPER_BASE64`
 * (2 100 000), which is not a coincidence: a seed that exceeded the cap would produce a
 * database the next backup could not restore. It is verified against that cap by
 * `test/wallpaper.test.js`, so shrinking the cap or swapping the asset fails there rather
 * than on the first restore of a deployment that upgraded.
 *
 * Note the browser-encoded figure is larger again — `toDataURL('image/png')` on these same
 * pixels is 1 926 880 characters — and *that* is what the cap is really sized against, since
 * it is what an upload produces. See the cap's comment in src/validate.js.
 */
function seedWallpaper(d) {
  const marker = 'wallpaperSeeded';
  if (d.prepare('SELECT 1 AS present FROM settings WHERE key = ?').get(marker)) return;

  let pngB64 = '';
  try {
    pngB64 = fs.readFileSync(BUNDLED_BACKGROUND).toString('base64');
  } catch (err) {
    // A missing bundled asset is a deployment error, not a reason to refuse to boot. The
    // marker is deliberately **not** written in this case, so the seed is retried at the
    // next boot — the alternative is worse than it looks: writing the marker here would
    // record "the wallpaper was seeded" for a database that has no wallpaper, and since
    // `wallpaperPng` is empty the delete-guard would have nothing to protect. The photo
    // would then be gone permanently, recoverable only by an admin upload, on a restart
    // caused by a file the operator can simply put back.
    //
    // The `return` leaves the database untouched, which is also what a failed seed should
    // look like: an upgraded deployment shows its background colour instead of the photo
    // until the asset is present, and nothing records a decision that was never made.
    console.error(
      `[db] could not seed the wallpaper from ${BUNDLED_BACKGROUND}: ${err.message} — ` +
        'the wallpaper will be seeded on the next boot once the file is present'
    );
    return;
  }

  // One transaction for the image, the appearance settings and the marker: a crash between
  // them would leave a seeded image with no marker, and the next boot would rewrite the
  // settings the admin may have edited in between.
  d.exec('BEGIN');
  try {
    d.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('wallpaperPng', pngB64);
    d.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(marker, '1');
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function initDb(dbPath = config.dbPath) {
  if (db) return db;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

// Settings key marking that the credit lines were seeded once. See migrate().
const CREDITS_SEEDED_KEY = 'creditsSeeded';

// Exported for the migration test (exercises the ALTER TABLE upgrade path).
export function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS services (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      icon        TEXT NOT NULL DEFAULT '',
      icon_image  TEXT,
      thumbnail_image TEXT,
      description TEXT NOT NULL DEFAULT '',
      url         TEXT NOT NULL,
      github_repo TEXT NOT NULL DEFAULT '',
      tech_stack  TEXT NOT NULL DEFAULT '',
      ai_details  TEXT NOT NULL DEFAULT '',
      story       TEXT NOT NULL DEFAULT '',
      audience    TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'unknown',
      latency_ms  INTEGER,
      last_checked INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      pw_hash    TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS credits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      role       TEXT NOT NULL DEFAULT '',
      value      TEXT NOT NULL DEFAULT '',
      url        TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Migration: add icon_image to pre-existing databases.
  const cols = d.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
  if (!cols.includes('icon_image')) {
    d.exec('ALTER TABLE services ADD COLUMN icon_image TEXT');
  }
  if (!cols.includes('github_repo')) {
    d.exec("ALTER TABLE services ADD COLUMN github_repo TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('thumbnail_image')) {
    d.exec('ALTER TABLE services ADD COLUMN thumbnail_image TEXT');
  }
  if (!cols.includes('tech_stack')) {
    d.exec("ALTER TABLE services ADD COLUMN tech_stack TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('ai_details')) {
    d.exec("ALTER TABLE services ADD COLUMN ai_details TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('story')) {
    d.exec("ALTER TABLE services ADD COLUMN story TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('audience')) {
    d.exec("ALTER TABLE services ADD COLUMN audience TEXT NOT NULL DEFAULT ''");
  }

  // Migration: add pw_hash to pre-existing databases (session invalidation on
  // password rotation). Existing sessions get '' which won't match — they are
  // invalidated once on upgrade, which is acceptable.
  const sessionCols = d.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!sessionCols.includes('pw_hash')) {
    d.exec("ALTER TABLE sessions ADD COLUMN pw_hash TEXT NOT NULL DEFAULT ''");
  }

  // Seed the editable page text and credit lines (see src/content-defaults.js and
  // docs/decisions.md D22).
  //
  // Both are seeded once and never again:
  //  - a setting is inserted only when its key is absent, so an admin edit — including
  //    clearing a field — survives every later boot;
  //  - the credit lines are guarded by a marker key rather than "seed when the table
  //    is empty", because the admin can legitimately delete every line and a boot must
  //    not resurrect them.
  const seedSetting = d.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_PAGE_TEXT)) {
    seedSetting.run(key, value);
  }

  const seeded = d.prepare('SELECT 1 AS present FROM settings WHERE key = ?').get(CREDITS_SEEDED_KEY);
  if (!seeded) {
    const now = Date.now();
    const insert = d.prepare(
      'INSERT INTO credits (role, value, url, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    // One transaction for the rows *and* the marker: a crash between the two would
    // re-seed the credit lines on top of themselves at the next boot.
    d.exec('BEGIN');
    try {
      DEFAULT_CREDITS.forEach((c, i) => insert.run(c.role, c.value, c.url, i, now, now));
      seedSetting.run(CREDITS_SEEDED_KEY, '1');
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }

  // The wallpaper's one-time seed from the bundled photo — see the function comment for
  // why it is a marker-guarded migration rather than a default value.
  seedWallpaper(d);
}

// --- Settings -------------------------------------------------------------

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// --- Services -------------------------------------------------------------

const SERVICE_COLS = `id, name, icon, icon_image, thumbnail_image, description, url, github_repo, tech_stack, ai_details, story, audience, enabled, sort_order,
  status, latency_ms, last_checked, created_at, updated_at`;

function mapService(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    iconImage: row.icon_image || null,
    thumbnailImage: row.thumbnail_image || null,
    description: row.description,
    url: row.url,
    githubRepo: row.github_repo || '',
    techStack: row.tech_stack || '',
    aiDetails: row.ai_details || '',
    story: row.story || '',
    audience: row.audience || '',
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
    status: row.status,
    latencyMs: row.latency_ms,
    lastChecked: row.last_checked,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listServices({ includeDisabled = true } = {}) {
  const where = includeDisabled ? '' : 'WHERE enabled = 1';
  const rows = db
    .prepare(`SELECT ${SERVICE_COLS} FROM services ${where} ORDER BY sort_order ASC, name ASC`)
    .all();
  return rows.map(mapService);
}

export function getService(id) {
  return mapService(db.prepare(`SELECT ${SERVICE_COLS} FROM services WHERE id = ?`).get(id));
}

export function createService({ name, icon, description, url, githubRepo = '', techStack = '', aiDetails = '', story = '', audience = '', enabled, sortOrder, iconImage = null, thumbnailImage = null }) {
  const now = Date.now();
  // Appended when no position is given, which is the normal path now that the admin panel
  // orders services by dragging them (see D23): a new service goes to the end of the list
  // instead of tying at 0 and being sorted by name.
  const position = sortOrder ?? nextPosition('services');
  const info = db
    .prepare(
      `INSERT INTO services (name, icon, icon_image, thumbnail_image, description, url, github_repo, tech_stack, ai_details, story, audience, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, icon, iconImage, thumbnailImage, description, url, githubRepo, techStack, aiDetails, story, audience, enabled ? 1 : 0, position, now, now);
  return getService(Number(info.lastInsertRowid));
}

// Sentinel: leave the icon image unchanged on update.
export const ICON_KEEP = '__keep__';

export function updateService(id, fields) {
  const existing = getService(id);
  if (!existing) return null;
  const now = Date.now();
  const iconImage =
    fields.iconImage === undefined || fields.iconImage === ICON_KEEP
      ? existing.iconImage
      : fields.iconImage; // string (set) or null (clear)
  const thumbnailImage =
    fields.thumbnailImage === undefined || fields.thumbnailImage === ICON_KEEP
      ? existing.thumbnailImage
      : fields.thumbnailImage; // string (set) or null (clear)
  db.prepare(
    `UPDATE services SET
       name = ?, icon = ?, icon_image = ?, thumbnail_image = ?, description = ?, url = ?, github_repo = ?, tech_stack = ?, ai_details = ?, story = ?, audience = ?, enabled = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    fields.name ?? existing.name,
    fields.icon ?? existing.icon,
    iconImage,
    thumbnailImage,
    fields.description ?? existing.description,
    fields.url ?? existing.url,
    fields.githubRepo ?? existing.githubRepo,
    fields.techStack ?? existing.techStack,
    fields.aiDetails ?? existing.aiDetails,
    fields.story ?? existing.story,
    fields.audience ?? existing.audience,
    (fields.enabled ?? existing.enabled) ? 1 : 0,
    fields.sortOrder ?? existing.sortOrder,
    now,
    id
  );
  return getService(id);
}

export function deleteService(id) {
  const info = db.prepare('DELETE FROM services WHERE id = ?').run(id);
  return info.changes > 0;
}

export function updateServiceStatus(id, status, latencyMs) {
  db.prepare(
    'UPDATE services SET status = ?, latency_ms = ?, last_checked = ? WHERE id = ?'
  ).run(status, latencyMs, Date.now(), id);
}

// --- Ordering -------------------------------------------------------------

/**
 * The next free position in a table: one past its current highest.
 *
 * `sort_order` is an implementation detail of "the order the admin arranged things in",
 * shared by `services` and `credits`. The table name is interpolated into SQL, so it is
 * checked against a literal allow-list here rather than trusted from the caller — the only
 * callers today pass a literal, and this keeps it that way if a third is ever added.
 */
const ORDERED_TABLES = new Set(['services', 'credits']);

function orderedTable(name) {
  if (!ORDERED_TABLES.has(name)) throw new Error(`Not an ordered table: ${name}`);
  return name;
}

function nextPosition(table) {
  return db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM ${orderedTable(table)}`).get().next;
}

/**
 * Applies a full ordering — the result of a drag in the admin panel.
 *
 * The list must be exactly the ids that exist: a partial or stale list (another tab added
 * or deleted a row meanwhile) is rejected, because writing it would leave rows with
 * duplicate or missing positions. Returns the new list, or null if it was rejected.
 *
 * A list whose ids are all correct but in a stale *order* is accepted: it is
 * indistinguishable from a fresh one, so two admins reordering at once is last-write-wins.
 * With a single admin that is not worth a version column (see D22/D23).
 */
function applyOrder(table, ids, list) {
  const existing = list().map((r) => r.id);
  const wanted = new Set(ids);
  if (ids.length !== existing.length || wanted.size !== ids.length) return null;
  if (!ids.every((id) => existing.includes(id))) return null;

  const stmt = db.prepare(`UPDATE ${orderedTable(table)} SET sort_order = ? WHERE id = ?`);
  db.exec('BEGIN');
  try {
    ids.forEach((id, i) => stmt.run(i, id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return list();
}

export function reorderServices(ids) {
  return applyOrder('services', ids, () => listServices());
}

// --- Credits (the credits page lines) -------------------------------------

const CREDIT_COLS = 'id, role, value, url, sort_order, created_at, updated_at';

function mapCredit(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role || '',
    value: row.value || '',
    url: row.url || '',
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCredits() {
  return db
    .prepare(`SELECT ${CREDIT_COLS} FROM credits ORDER BY sort_order ASC, id ASC`)
    .all()
    .map(mapCredit);
}

export function getCredit(id) {
  return mapCredit(db.prepare(`SELECT ${CREDIT_COLS} FROM credits WHERE id = ?`).get(id));
}

// New lines go to the end of the list: the page order is the admin's drag order, so
// appending is the only position that cannot reorder anything the admin arranged.
export function createCredit({ role = '', value, url = '' }) {
  const now = Date.now();
  const info = db
    .prepare(
      'INSERT INTO credits (role, value, url, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(role, value, url, nextPosition('credits'), now, now);
  return getCredit(Number(info.lastInsertRowid));
}

export function updateCredit(id, fields) {
  const existing = getCredit(id);
  if (!existing) return null;
  db.prepare('UPDATE credits SET role = ?, value = ?, url = ?, updated_at = ? WHERE id = ?').run(
    fields.role ?? existing.role,
    fields.value ?? existing.value,
    fields.url ?? existing.url,
    Date.now(),
    id
  );
  return getCredit(id);
}

export function deleteCredit(id) {
  return db.prepare('DELETE FROM credits WHERE id = ?').run(id).changes > 0;
}

/**
 * Applies a full ordering — the result of a drag in the admin panel.
 *
 * The list must be exactly the ids that exist: a partial or stale list (another tab
 * added or deleted a line meanwhile) is rejected, because writing it would leave rows
 * with duplicate or missing positions. Returns the new list, or null if it was
 * rejected.
 */
export function reorderCredits(ids) {
  return applyOrder('credits', ids, () => listCredits());
}

// --- Restore (backup/restore, see docs/decisions.md D25) ------------------

/**
 * Runs `fn` inside one SQLite transaction, committing on return and rolling back on a
 * throw. The restore path needs this: a half-applied archive (settings written, services
 * refused) is worse than a refused one, because the admin has no way to tell which half
 * landed.
 */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Deletes `keys` from the settings table. Only the keys given are touched, so a restore of
 * one category cannot clear another's — and a key that no category owns (`creditsSeeded`,
 * `smtpPassword`) is never in the list.
 */
export function deleteSettings(keys) {
  if (!keys.length) return 0;
  const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
  let removed = 0;
  for (const key of keys) removed += stmt.run(key).changes;
  return removed;
}

/**
 * Replaces every service row with `rows`, ids and timestamps included.
 *
 * The ids are written explicitly rather than left to AUTOINCREMENT so a restore onto a
 * fresh database reproduces the archived ids — the public card markup, the
 * `/service-icon/:id.png` URLs and the admin table all key off them, and a backup that
 * renumbered everything would silently break any link to an icon.
 *
 * Runtime columns (`status`, `latency_ms`, `last_checked`) are deliberately NOT restored:
 * they are the health checker's output, they are stale by definition the moment the
 * archive is written, and the next tick overwrites them. Restored rows start `unknown`.
 */
export function replaceServices(rows) {
  db.prepare('DELETE FROM services').run();
  const insert = db.prepare(
    `INSERT INTO services (id, name, icon, icon_image, thumbnail_image, description, url, github_repo,
       tech_stack, ai_details, story, audience, enabled, sort_order, status, latency_ms, last_checked,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, ?, ?)`
  );
  for (const r of rows) {
    insert.run(
      r.id,
      r.name,
      r.icon,
      r.iconImage,
      r.thumbnailImage,
      r.description,
      r.url,
      r.githubRepo,
      r.techStack,
      r.aiDetails,
      r.story,
      r.audience,
      r.enabled ? 1 : 0,
      r.sortOrder,
      r.createdAt,
      r.updatedAt
    );
  }
  return rows.length;
}

/** Replaces every credit line with `rows`, ids and order included. See replaceServices. */
export function replaceCredits(rows) {
  db.prepare('DELETE FROM credits').run();
  const insert = db.prepare(
    `INSERT INTO credits (id, role, value, url, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    insert.run(r.id, r.role, r.value, r.url, r.sortOrder, r.createdAt, r.updatedAt);
  }
  return rows.length;
}

// --- Sessions -------------------------------------------------------------

export function createSession(token, ttlMs, pwHash = '') {
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, created_at, expires_at, pw_hash) VALUES (?, ?, ?, ?)').run(
    token,
    now,
    now + ttlMs,
    pwHash
  );
}

export function getSession(token) {
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}
