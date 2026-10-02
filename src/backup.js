/**
 * Backup and restore (see docs/decisions.md D25).
 *
 * A backup is everything this deployment has that the repository does not: the settings
 * table, the services (with their uploaded icons and thumbnails, which live in the database
 * as base64), and the credit lines. It is one gzipped JSON document.
 *
 * What is deliberately **not** in an archive:
 *
 *  - `sessions` — a backup is not a way to carry a login to another machine, and restoring
 *    one would resurrect tokens that were never rotated.
 *  - `smtpPassword` — the archive is a file the admin downloads and may park in a cloud
 *    folder or email to themselves. A live credential in that file is a bigger cost than
 *    retyping it after a restore onto a fresh machine. The rest of the SMTP config is
 *    included, and the stored password is left untouched by a restore.
 *  - `creditsSeeded` — the one-time seed marker (see D22). It belongs to this database's
 *    history, not to its content; restoring it could resurrect the default credit lines.
 *  - `status`, `latency_ms`, `last_checked` — the health checker's output. It is stale by
 *    definition the moment the archive is written, and the next tick overwrites it.
 *
 * Gzip rather than zip: `node:zlib` is built in and the repository's rule is no new runtime
 * dependencies. The base64 artwork compresses, and the result is still inspectable with
 * `gunzip` and readable as JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';
import { SETTING_KEYS } from './public-data.js';
import { APP_NAME, APP_RELEASE_DATE } from './version.js';
import {
  PAGE_TEXT_KEYS,
  MAX_ICON_BASE64_CHARS,
  MAX_THUMB_BASE64_CHARS,
  isPngBase64,
  isWallpaperBase64,
  validateCredit,
  validatePageText,
  validateService,
  validateSettings,
  validateSmtpSettings,
} from './validate.js';

export const ARCHIVE_FORMAT = 'vibefolio-backup';
export const ARCHIVE_VERSION = 1;

// Size caps. The container runs with `mem_limit: 256m` (docker-compose.yml) and one inspect
// holds the archive in memory several times over: the gzipped upload, the expanded JSON, the
// decoded string and then the parsed object. At these caps that peak is roughly 110 MB above
// a ~70 MB baseline, which leaves real headroom rather than relying on the allocator being
// lucky. They are still far above any realistic archive — the largest thing a real one carries
// is the wallpaper (up to ~2 MB of base64, ~1.5 MB gzipped), with the service thumbnails next,
// so 12 MB of gzip is a deployment with a wallpaper *and* dozens of thumbnails.
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 24 * 1024 * 1024;

// Upper bounds on the collections, so a hand-crafted archive cannot make the restore loop
// run for an unbounded time. Both are far above anything the admin panel could produce.
const MAX_SERVICES = 500;
const MAX_CREDITS = 500;

/** A problem with the archive itself, safe to show the admin verbatim. */
export class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/**
 * Which settings belong to which category.
 *
 * A settings key that is in no group is never exported and never deleted by a restore.
 * `smtpPassword` and `creditsSeeded` are the two that fall outside on purpose — see the
 * module comment.
 */
const GROUP_KEYS = {
  settings: [...SETTING_KEYS],
  pageText: [...PAGE_TEXT_KEYS],
  artwork: ['siteIconPng', 'faviconPng'],
  wallpaper: ['wallpaperPng'],
  email: ['feedbackEnabled', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpFrom', 'smtpTo'],
};

// `smtpSecure` is exported for readability but re-derived from the port on restore, exactly
// as the admin panel derives it: the port is the value that has to be right for the
// connection to work, and the two must agree (see src/mailer.js).
const DERIVED_ON_RESTORE = new Set(['smtpSecure']);

/**
 * The restore categories, in the order the modal lists them.
 *
 * The client renders whatever `summarize()` returns rather than carrying its own copy of
 * this list, so adding a category is a change to this file alone.
 */
export const CATEGORIES = [
  {
    id: 'settings',
    label: 'Site settings',
    hint: 'Title, description, footer, accent colour, the stats block and the wallpaper placement and colours.',
    keys: GROUP_KEYS.settings,
  },
  {
    id: 'pageText',
    label: 'Page text',
    hint: 'The copy on the feedback and credits pages.',
    keys: GROUP_KEYS.pageText,
  },
  {
    id: 'artwork',
    label: 'Site icon & favicon',
    hint: 'The uploaded site icon and favicon images.',
    keys: GROUP_KEYS.artwork,
  },
  {
    id: 'wallpaper',
    label: 'Wallpaper',
    hint: 'The uploaded background image. Its placement and colours are a site setting.',
    keys: GROUP_KEYS.wallpaper,
  },
  {
    id: 'email',
    label: 'Email & feedback',
    hint: 'SMTP settings and the feedback form toggle. A backup never contains the SMTP password.',
    keys: GROUP_KEYS.email,
  },
  {
    id: 'services',
    label: 'Services',
    hint: 'Every service, including its uploaded icon and thumbnail.',
  },
  {
    id: 'credits',
    label: 'Credit lines',
    hint: 'The lines listed on the credits page.',
  },
];

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

// The keys a backup may carry, and the ones it must never carry. A key that is in no
// category is neither exported nor deleted by a restore, which is how the two here stay
// out: `smtpPassword` is a credential the archive deliberately does not hold, and the two
// markers are history rather than content — `creditsSeeded` keeps `migrate()` from
// re-seeding the credit lines, and `wallpaperSeeded` keeps it from resurrecting a
// wallpaper the admin deleted.
export const EXPORTED_SETTING_KEYS = new Set(CATEGORIES.flatMap((c) => c.keys ?? []));
export const NEVER_BACKED_UP_SETTING_KEYS = ['smtpPassword', 'creditsSeeded', 'wallpaperSeeded'];

const ENVELOPE_KEYS = new Set(['format', 'version', 'createdAt', 'app', 'data']);
const DATA_KEYS = new Set(['settings', 'services', 'credits']);

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// A key from the archive is echoed back in a validation message, so it is quoted through
// this: without a cap, a crafted archive with a multi-megabyte key name produces a
// multi-megabyte error response. Not an injection (the value is JSON-encoded, and every
// render path escapes), purely a response-size bound.
const keyLabel = (key) => {
  const text = String(key);
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);
};

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

// --- Building an archive ---------------------------------------------------

/**
 * The current state as an archive object. The inverse of `applyRestore`.
 *
 * Settings are copied as the raw strings the database holds, not as typed values: this is a
 * copy of the database, and a conversion layer on the way out would need a matching one on
 * the way in, with a drift between them the day a key is added.
 */
export function buildArchive() {
  const all = store.getAllSettings();
  const settings = {};
  for (const key of EXPORTED_SETTING_KEYS) {
    if (all[key] !== undefined) settings[key] = all[key];
  }

  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    app: { name: APP_NAME, release: APP_RELEASE_DATE },
    data: {
      settings,
      services: store.listServices().map((s) => ({
        id: s.id,
        name: s.name,
        icon: s.icon,
        iconImage: s.iconImage,
        thumbnailImage: s.thumbnailImage,
        description: s.description,
        url: s.url,
        githubRepo: s.githubRepo,
        techStack: s.techStack,
        aiDetails: s.aiDetails,
        story: s.story,
        audience: s.audience,
        enabled: s.enabled,
        sortOrder: s.sortOrder,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      credits: store.listCredits().map((c) => ({
        id: c.id,
        role: c.role,
        value: c.value,
        url: c.url,
        sortOrder: c.sortOrder,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    },
  };
}

export function serializeArchive(archive) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(archive)), { level: 9 });
}

/** `vibefolio-backup-2026-10-01-1430.json.gz` — UTC, so it does not depend on the host's zone. */
export function archiveFilename(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `vibefolio-backup-${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}.json.gz`
  );
}

// --- Reading an archive ----------------------------------------------------

/**
 * Decompresses, parses and fully validates an uploaded archive.
 *
 * Validation happens here, once, before the admin is shown the overview — so a file that
 * could not be restored is refused while nothing has been staged, and the apply step never
 * has to reject a payload the admin has already committed to. The returned archive is the
 * *normalised* one: everything that reaches the database comes from this function, never
 * from the request body.
 */
export function parseArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ArchiveError('The upload is empty. Send the .json.gz file as raw bytes.');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new ArchiveError(`That file is too large (limit ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`);
  }

  let json;
  try {
    // `maxOutputLength` is what stops a small file from expanding into gigabytes. Node
    // raises ERR_BUFFER_TOO_LARGE rather than growing the buffer, so the guard is a hard
    // cap and not an after-the-fact check.
    json = zlib.gunzipSync(buffer, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ArchiveError('The archive expands beyond the size limit and was refused.');
    }
    throw new ArchiveError('That is not a gzip archive. Upload the .json.gz file a backup produced.');
  }

  let parsed;
  try {
    parsed = JSON.parse(json.toString('utf8'));
  } catch {
    throw new ArchiveError('The archive is not valid JSON.');
  }

  return validateArchive(parsed);
}

function validateArchive(parsed) {
  if (!isPlainObject(parsed)) throw new ArchiveError('The archive must be a JSON object.');

  const errors = [];
  if (parsed.format !== ARCHIVE_FORMAT) {
    errors.push(`This is not a ${ARCHIVE_FORMAT} archive.`);
  }
  if (!Number.isInteger(parsed.version) || parsed.version < 1) {
    errors.push('version must be a positive integer.');
  } else if (parsed.version > ARCHIVE_VERSION) {
    errors.push(
      `The archive was written by a newer version of the app (${parsed.version}; this build reads up to ${ARCHIVE_VERSION}).`
    );
  }
  for (const key of Object.keys(parsed)) {
    if (!ENVELOPE_KEYS.has(key)) errors.push(`Unexpected top-level key ${keyLabel(key)}.`);
  }
  if (parsed.createdAt !== undefined && typeof parsed.createdAt !== 'string') {
    errors.push('createdAt must be a string.');
  }
  if (!isPlainObject(parsed.data)) {
    errors.push('data must be an object.');
  } else {
    for (const key of Object.keys(parsed.data)) {
      if (!DATA_KEYS.has(key)) errors.push(`Unexpected key ${keyLabel(key)} in data.`);
    }
  }
  // Refuse before looking any deeper: a file that is not one of ours should fail on the
  // envelope, not on a field-level complaint about a structure that was never ours.
  if (errors.length) throw new ArchiveError(errors.join(' '));

  const settings = validateArchiveSettings(parsed.data.settings);
  const services = validateArchiveServices(parsed.data.services);
  const credits = validateArchiveCredits(parsed.data.credits);

  const fieldErrors = [...settings.errors, ...services.errors, ...credits.errors];
  if (fieldErrors.length) {
    const shown = fieldErrors.slice(0, 8).join(' ');
    const rest = fieldErrors.length > 8 ? ` (and ${fieldErrors.length - 8} more)` : '';
    throw new ArchiveError(`The archive is damaged: ${shown}${rest}`);
  }

  return {
    format: ARCHIVE_FORMAT,
    version: parsed.version,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    app: isPlainObject(parsed.app) ? { name: String(parsed.app.name ?? ''), release: String(parsed.app.release ?? '') } : null,
    data: { settings: settings.value, services: services.value, credits: credits.value },
  };
}

/**
 * Settings, validated per group.
 *
 * Each group is run through the validator the admin panel uses, so a restored value cannot
 * be one the panel would refuse to save. The two boolean-ish keys are stored as `'1'`/`'0'`
 * strings, which is the form `validateSettings`/`validateSmtpSettings` do not accept, so
 * they are converted on the way in and back on the way out.
 */
function validateArchiveSettings(raw) {
  const errors = [];
  const out = {};
  if (raw === undefined) return { errors, value: out };
  if (!isPlainObject(raw)) return { errors: ['data.settings must be an object.'], value: out };

  for (const key of Object.keys(raw)) {
    if (!EXPORTED_SETTING_KEYS.has(key)) errors.push(`Unknown setting ${keyLabel(key)}.`);
  }

  const site = pick(raw, GROUP_KEYS.settings);
  if (Object.keys(site).length) {
    const input = { ...site };
    if (input.showStats !== undefined) {
      if (input.showStats !== '0' && input.showStats !== '1') {
        errors.push('showStats must be "0" or "1".');
        delete input.showStats;
      } else {
        input.showStats = input.showStats === '1';
      }
    }
    // The archive carries the raw strings the database holds (see buildArchive), while
    // `validateSettings` is written for the admin panel's typed JSON — so the two settings
    // that are not strings on the way in are converted here, and back on the way out. A
    // value that is not a digit string at all is dropped with its own message rather than
    // handed to the panel validator, which would report it as an out-of-range number and
    // hide what was actually wrong with the file.
    if (input.wallpaperTransparency !== undefined) {
      const n = Number(input.wallpaperTransparency);
      if (!/^\d+$/.test(String(input.wallpaperTransparency)) || !Number.isInteger(n)) {
        errors.push('wallpaperTransparency must be a whole number.');
        delete input.wallpaperTransparency;
      } else {
        input.wallpaperTransparency = n;
      }
    }
    const res = validateSettings(input);
    errors.push(...res.errors);
    for (const [k, v] of Object.entries(res.value)) {
      out[k] = k === 'showStats' ? (v ? '1' : '0') : v;
    }
  }

  const page = pick(raw, GROUP_KEYS.pageText);
  if (Object.keys(page).length) {
    const res = validatePageText(page);
    errors.push(...res.errors);
    Object.assign(out, res.value);
  }

  for (const key of GROUP_KEYS.artwork) {
    if (raw[key] === undefined) continue;
    // An empty string is a real state: it is what "reset to the default icon" writes.
    if (raw[key] === '') out[key] = '';
    else if (isPngBase64(raw[key], MAX_ICON_BASE64_CHARS)) out[key] = raw[key];
    else errors.push(`${key} is not a PNG.`);
  }

  // The wallpaper is held to the same rule with its own cap: an archive is validated by the
  // same definition of "an image this app will store" the admin upload is, so a restore can
  // never seat a value the panel would refuse.
  for (const key of GROUP_KEYS.wallpaper) {
    if (raw[key] === undefined) continue;
    // Empty is how the wallpaper is deleted, so it has to be a value an archive can carry.
    if (raw[key] === '') out[key] = '';
    else if (isWallpaperBase64(raw[key])) out[key] = raw[key];
    else errors.push(`${key} is not a PNG.`);
  }

  const email = pick(raw, GROUP_KEYS.email);
  if (Object.keys(email).length) {
    const input = { ...email };
    if (input.feedbackEnabled !== undefined) {
      if (input.feedbackEnabled !== '0' && input.feedbackEnabled !== '1') {
        errors.push('feedbackEnabled must be "0" or "1".');
      } else {
        out.feedbackEnabled = input.feedbackEnabled;
      }
      delete input.feedbackEnabled;
    }
    for (const key of DERIVED_ON_RESTORE) delete input[key];
    const res = validateSmtpSettings(input);
    errors.push(...res.errors);
    // `validateSmtpSettings` emits `smtpSecure` alongside a valid port, derived from it.
    for (const [k, v] of Object.entries(res.value)) out[k] = String(v);
  }

  return { errors, value: out };
}

function validateArchiveServices(raw) {
  const errors = [];
  const value = [];
  if (raw === undefined) return { errors, value };
  if (!Array.isArray(raw)) return { errors: ['data.services must be an array.'], value };
  if (raw.length > MAX_SERVICES) {
    return { errors: [`data.services holds more than ${MAX_SERVICES} entries.`], value };
  }

  const ids = new Set();
  raw.forEach((row, i) => {
    const at = `data.services[${i}]`;
    if (!isPlainObject(row)) {
      errors.push(`${at} must be an object.`);
      return;
    }
    const res = validateService(row);
    if (!res.ok) {
      errors.push(`${at}: ${res.errors.join('; ')}.`);
      return;
    }
    const id = row.id;
    if (!Number.isInteger(id) || id < 1) {
      errors.push(`${at}.id must be a positive integer.`);
      return;
    }
    if (ids.has(id)) {
      errors.push(`${at}.id ${id} appears twice.`);
      return;
    }
    ids.add(id);

    const artwork = {};
    let artworkOk = true;
    for (const [key, max] of [
      ['iconImage', MAX_ICON_BASE64_CHARS],
      ['thumbnailImage', MAX_THUMB_BASE64_CHARS],
    ]) {
      const v = row[key];
      if (v === undefined || v === null || v === '') artwork[key] = null;
      else if (isPngBase64(v, max)) artwork[key] = v;
      else {
        errors.push(`${at}.${key} is not a PNG.`);
        artworkOk = false;
      }
    }
    if (!artworkOk) return;

    value.push({
      id,
      ...res.value,
      iconImage: artwork.iconImage,
      thumbnailImage: artwork.thumbnailImage,
      // An archive that omits the order keeps the order it lists services in.
      sortOrder: res.value.sortOrder ?? i,
      createdAt: timestamp(row.createdAt),
      updatedAt: timestamp(row.updatedAt),
    });
  });

  return { errors, value };
}

function validateArchiveCredits(raw) {
  const errors = [];
  const value = [];
  if (raw === undefined) return { errors, value };
  if (!Array.isArray(raw)) return { errors: ['data.credits must be an array.'], value };
  if (raw.length > MAX_CREDITS) {
    return { errors: [`data.credits holds more than ${MAX_CREDITS} entries.`], value };
  }

  const ids = new Set();
  raw.forEach((row, i) => {
    const at = `data.credits[${i}]`;
    if (!isPlainObject(row)) {
      errors.push(`${at} must be an object.`);
      return;
    }
    const res = validateCredit(row);
    if (!res.ok) {
      errors.push(`${at}: ${res.errors.join('; ')}.`);
      return;
    }
    const id = row.id;
    if (!Number.isInteger(id) || id < 1) {
      errors.push(`${at}.id must be a positive integer.`);
      return;
    }
    if (ids.has(id)) {
      errors.push(`${at}.id ${id} appears twice.`);
      return;
    }
    ids.add(id);
    value.push({
      id,
      ...res.value,
      sortOrder: res.value.sortOrder ?? i,
      createdAt: timestamp(row.createdAt),
      updatedAt: timestamp(row.updatedAt),
    });
  });

  return { errors, value };
}

// A missing or nonsensical timestamp becomes "now": the column is NOT NULL and nothing in
// the app reads it as anything other than "when this row last changed".
function timestamp(value) {
  return Number.isInteger(value) && value >= 0 ? value : Date.now();
}

// --- Summarising an archive ------------------------------------------------

/**
 * What the restore modal shows: the archive's provenance plus one entry per category, with
 * a count. Counts, not contents — the admin is deciding what to overwrite, and listing
 * individual services here would be a second, worse services table.
 *
 * `current` is the live settings, when the caller has them. It exists for one case: a
 * category whose archive holds *nothing* while the database holds something. Restoring it
 * deletes that something (replace, not merge — see D25), and the archive cannot say so
 * because it does not know what is deployed. That is the one way a restore silently changes
 * the site's appearance: an older archive predates the wallpaper entirely, so its `wallpaper`
 * category is empty, the modal defaults every box to checked, and confirming removes the
 * live wallpaper with no hint that it would. The flag is reported rather than acted on —
 * refusing the restore would be worse than saying what it does.
 */
export function summarize(archive, current = null) {
  const { settings, services, credits } = archive.data;
  return {
    createdAt: archive.createdAt,
    app: archive.app,
    categories: CATEGORIES.map((c) => {
      const base = { id: c.id, label: c.label, hint: c.hint };

      if (c.id === 'services') {
        const icons = services.filter((s) => s.iconImage).length;
        const thumbs = services.filter((s) => s.thumbnailImage).length;
        const detail = [
          icons && `${icons} ${icons === 1 ? 'icon' : 'icons'}`,
          thumbs && `${thumbs} ${thumbs === 1 ? 'thumbnail' : 'thumbnails'}`,
        ]
          .filter(Boolean)
          .join(' · ');
        return { ...base, count: services.length, unit: 'services', detail };
      }
      if (c.id === 'credits') return { ...base, count: credits.length, unit: 'lines' };

      const present = c.keys.filter((k) => settings[k] !== undefined);
      if (c.id === 'artwork') {
        const count = present.filter((k) => settings[k] !== '').length;
        return { ...base, count, unit: 'images', ...clearsSomething(c, count, current, 'the site icon') };
      }
      if (c.id === 'wallpaper') {
        // One image or none: "1 image" / "no image" reads better in the modal than the
        // generic settings counter, which would report a presence rather than a picture.
        const has = present.some((k) => settings[k] !== '');
        const count = has ? 1 : 0;
        return { ...base, count, unit: has ? 'image' : 'images', ...clearsSomething(c, count, current, 'the wallpaper') };
      }
      const count = present.length;
      return { ...base, count, unit: c.id === 'pageText' ? 'fields' : 'settings' };
    }),
  };
}

/**
 * Whether restoring this category would remove something the deployment currently has.
 *
 * Only image groups need it (`artwork`, `wallpaper`): their counts are "how many pictures are
 * in the archive", and an archive from before either feature existed reports 0 while the
 * database may hold one. `current` is the raw settings map.
 *
 * `artwork` spans **two** keys (`siteIconPng`, `faviconPng`) and they are not written in
 * lockstep by every path — a hand-crafted archive can carry one without the other — so the
 * check is "is either of them set", not "is the first one set". Keying off `siteIconPng`
 * alone would let a restore delete a live favicon without saying so, which is the exact
 * silent-appearance-change this flag exists to catch.
 */
function clearsSomething(category, archiveCount, current, noun) {
  const currentKeys = { artwork: ['siteIconPng', 'faviconPng'], wallpaper: ['wallpaperPng'] }[category.id];
  if (!currentKeys || !current || archiveCount > 0) return {};
  return currentKeys.some((k) => current[k]) ? { clears: noun } : {};
}

// --- Applying an archive ---------------------------------------------------

/**
 * The categories named in a restore request, as a Set.
 *
 * Rejects anything unknown rather than ignoring it: a client that asks for a category this
 * build does not have is out of step with the server, and silently restoring the rest would
 * leave the admin believing something happened that did not.
 */
export function normalizeCategories(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ArchiveError('Select at least one category to restore.');
  }
  const unknown = ids.filter((id) => !CATEGORY_IDS.has(id));
  if (unknown.length) throw new ArchiveError(`Unknown category: ${[...new Set(unknown)].join(', ')}.`);
  return new Set(ids);
}

/**
 * Restores the selected categories from an already-validated archive.
 *
 * Replace, not merge: for every selected category the archive becomes the truth, so
 * services and credit lines it does not mention are deleted and settings keys it does not
 * mention are removed. That is what the modal's confirmation says will happen.
 *
 * All of it runs in one transaction — a restore that fails half-way would otherwise leave
 * the site in a state that is neither the old one nor the new one.
 */
export function applyRestore(archive, categoryIds) {
  const wanted = normalizeCategories(categoryIds);
  const data = archive.data;

  return store.transaction(() => {
    const applied = {};

    for (const category of CATEGORIES) {
      if (!wanted.has(category.id)) continue;

      if (category.keys) {
        store.deleteSettings(category.keys);
        applied[category.id] = writeSettingGroup(category.keys, data.settings);
      } else if (category.id === 'services') {
        applied.services = store.replaceServices(data.services);
      } else if (category.id === 'credits') {
        applied.credits = store.replaceCredits(data.credits);
      }
    }

    return applied;
  });
}

function writeSettingGroup(keys, settings) {
  let written = 0;
  for (const key of keys) {
    if (settings[key] === undefined) continue;
    store.setSetting(key, settings[key]);
    written += 1;
  }
  return written;
}

// --- Staging an inspected upload -------------------------------------------

// The inspect step uploads the file and validates it; the apply step names it by an opaque
// id. The archive itself never travels back through the browser: what is applied is what
// the server validated, so a tampered request can only choose *which* categories to write,
// not what goes into them.
const STAGED_TTL_MS = 15 * 60 * 1000;
// One staged archive at a time. Staging is already one-per-session, so a higher number only
// ever served several concurrent admin sessions — and each entry retains a parsed archive
// (up to MAX_EXPANDED_BYTES) for its whole TTL, against a container capped at 256 MB. A
// second session's upload therefore evicts the first, which is the same last-one-wins rule
// the dialog's Back button implies.
const MAX_STAGED = 1;
const staged = new Map();

function pruneStaged() {
  const now = Date.now();
  for (const [id, entry] of staged) {
    if (entry.expiresAt <= now) staged.delete(id);
  }
}

/**
 * Holds a validated archive until the admin confirms, bound to the session that uploaded it
 * so a second session cannot apply the first one's file. One per session: inspecting a
 * second file replaces the first, which is what the modal's Back button implies.
 */
export function stageArchive(archive, sessionToken) {
  pruneStaged();
  for (const [id, entry] of staged) {
    if (entry.session === sessionToken) staged.delete(id);
  }
  while (staged.size >= MAX_STAGED) staged.delete(staged.keys().next().value);

  const uploadId = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + STAGED_TTL_MS;
  staged.set(uploadId, { archive, session: sessionToken, expiresAt });
  return { uploadId, expiresAt };
}

export function getStaged(uploadId, sessionToken) {
  pruneStaged();
  const entry = typeof uploadId === 'string' ? staged.get(uploadId) : undefined;
  if (!entry || entry.session !== sessionToken) return null;
  return entry.archive;
}

export function discardStaged(uploadId, sessionToken) {
  const entry = typeof uploadId === 'string' ? staged.get(uploadId) : undefined;
  if (entry && entry.session === sessionToken) staged.delete(uploadId);
}

// Exposed for the tests, which need to observe expiry without waiting fifteen minutes.
export function _resetStaged() {
  staged.clear();
}

// --- Pre-restore snapshots -------------------------------------------------

// `pre-restore-YYYY-MM-DD-HHMMSSmmm.json.gz`. The pattern is also the path-traversal guard
// on the download route: only a name that matches it is ever joined to the directory.
const SNAPSHOT_RE = /^pre-restore-\d{4}-\d{2}-\d{2}-\d{9}\.json\.gz$/;
const MAX_SNAPSHOTS = 5;

/**
 * Millisecond resolution, not seconds.
 *
 * A name has to do two jobs: be unique per restore, and sort chronologically as a plain
 * string (`listSnapshots` derives "newest first" from the name, so nothing has to parse it).
 * Second resolution fails the first job — two restores inside one second collide, and the
 * file being overwritten is the *earlier* restore's undo point, which is the one thing this
 * mechanism exists to protect. A numeric `-2` suffix would fix uniqueness but break the
 * second job: `-` sorts below `.`, so `…-150323-2.json.gz` sorts *before* `…-150323.json.gz`
 * and the newer snapshot would be listed as the older one.
 */
export function snapshotFilename(date = new Date()) {
  const p = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `pre-restore-${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}${p(date.getUTCMilliseconds(), 3)}.json.gz`
  );
}

/**
 * Writes `buffer` as a pre-restore snapshot and prunes the oldest beyond `MAX_SNAPSHOTS`.
 *
 * The snapshot is a normal archive, so it can be fed straight back through the restore flow
 * — which is the point: a restore the admin regrets is undoable with the same UI, not with
 * a database console.
 *
 * Written *before* the transaction, and outside it: if the restore then fails, the snapshot
 * is a harmless extra copy of the state that was already there.
 *
 * `when` is the moment the snapshot represents (default: now). It is a parameter so the
 * collision path below is testable: two snapshots claiming the same millisecond are a real
 * possibility under a double-submit, and `wx` makes the second one refuse to overwrite
 * rather than resolve it silently. The retry nudges the timestamp forward instead of adding
 * a suffix, which keeps "a greater name is a newer file" true.
 */
export function writeSnapshot(buffer, when = new Date()) {
  fs.mkdirSync(config.backupDir, { recursive: true });

  let name;
  let stamp = when;
  for (let attempt = 0; ; attempt += 1) {
    name = snapshotFilename(stamp);
    try {
      fs.writeFileSync(path.join(config.backupDir, name), buffer, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Ten attempts is ten snapshots in the same millisecond. Past that something is wrong
      // that a retry will not fix, so fail loudly instead of spinning.
      if (attempt >= 9) throw err;
      stamp = new Date(stamp.getTime() + 1);
    }
  }

  const existing = listSnapshots().map((s) => s.name);
  for (const stale of existing.slice(MAX_SNAPSHOTS)) {
    try {
      fs.unlinkSync(path.join(config.backupDir, stale));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  return { name, size: buffer.length };
}

/** Newest first. A missing directory is an empty list, not an error. */
export function listSnapshots() {
  let names;
  try {
    names = fs.readdirSync(config.backupDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => SNAPSHOT_RE.test(name))
    .sort()
    .reverse()
    .map((name) => {
      const stat = fs.statSync(path.join(config.backupDir, name));
      return { name, size: stat.size, createdAt: snapshotDate(name) };
    });
}

export function readSnapshot(name) {
  if (typeof name !== 'string' || !SNAPSHOT_RE.test(name)) return null;
  try {
    return fs.readFileSync(path.join(config.backupDir, name));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// `pre-restore-2026-10-01-143005123.json.gz` → `2026-10-01T14:30:05.123Z`. The name is
// already UTC, so the ISO form is a reassembly rather than a parse — no locale or timezone
// can change what it means.
function snapshotDate(name) {
  const m = /^pre-restore-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})\.json\.gz$/.exec(name);
  if (!m) return '';
  const [, y, mo, d, h, mi, s, ms] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
}
