/**
 * Input validation for admin mutations. Returns { ok, errors }.
 * All values are coerced to safe types; URLs must be http(s).
 */
import {
  ACCENTS,
  isAccent,
  WALLPAPER_ANCHOR_IDS,
  WALLPAPER_SIZE_IDS,
  isHexColor,
} from '../public/js/render.js';

const MAX_NAME = 120;
const MAX_DESC = 500;
const MAX_ICON = 200;
const MAX_URL = 500;
const MAX_DETAILS = 1000; // aiDetails / story prose
const MAX_TAGS = 10; // tech stack tags
const MAX_TAG_LEN = 40;
const MAX_TECH_STACK = 500;

// Audience badge values ('' = no badge).
const AUDIENCES = new Set(['', 'personal', 'shared', 'open-source']);

// GitHub repo shorthand: "owner/repo" (owner may be a user or org).
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanString(value, max) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length > max) return null;
  return v;
}

export function validateService(input) {
  const errors = [];
  const out = {};

  const name = cleanString(input.name, MAX_NAME);
  if (!name) errors.push('name is required (max 120 chars)');
  else out.name = name;

  const url = cleanString(input.url, MAX_URL);
  if (!url) errors.push('url is required');
  else if (!isValidHttpUrl(url)) errors.push('url must be a valid http(s) URL');
  else out.url = url;

  const icon = cleanString(input.icon, MAX_ICON);
  out.icon = icon === null ? '' : icon;

  const description = cleanString(input.description, MAX_DESC);
  out.description = description === null ? '' : description;

  // Optional tech stack: an array of tags, or a comma/pipe-separated string.
  // Normalized to a canonical pipe-separated string for storage.
  if (input.techStack !== undefined) {
    const raw = Array.isArray(input.techStack)
      ? input.techStack
      : typeof input.techStack === 'string'
        ? input.techStack.split(/[,|]/)
        : null;
    if (raw === null) {
      errors.push('techStack must be an array of tags or a comma/pipe-separated string');
    } else {
      const tags = raw.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
      if (tags.length > MAX_TAGS) {
        errors.push(`techStack can have at most ${MAX_TAGS} tags`);
      } else if (tags.some((t) => t.length > MAX_TAG_LEN)) {
        errors.push(`each techStack tag can be at most ${MAX_TAG_LEN} chars`);
      } else {
        const joined = tags.join('|');
        if (joined.length > MAX_TECH_STACK) {
          errors.push(`techStack is too long (max ${MAX_TECH_STACK} chars)`);
        } else {
          out.techStack = joined;
        }
      }
    }
  } else {
    out.techStack = '';
  }

  const aiDetails = cleanString(input.aiDetails, MAX_DETAILS);
  if (input.aiDetails !== undefined && aiDetails === null) {
    errors.push(`aiDetails is too long (max ${MAX_DETAILS} chars)`);
  } else {
    out.aiDetails = aiDetails ?? '';
  }

  const story = cleanString(input.story, MAX_DETAILS);
  if (input.story !== undefined && story === null) {
    errors.push(`story is too long (max ${MAX_DETAILS} chars)`);
  } else {
    out.story = story ?? '';
  }

  if (input.audience !== undefined) {
    const audience = cleanString(input.audience, 20);
    if (audience === null || !AUDIENCES.has(audience)) {
      errors.push('audience must be one of: personal, shared, open-source');
    } else {
      out.audience = audience;
    }
  } else {
    out.audience = '';
  }

  // Optional GitHub repo: "owner/repo" shorthand (normalized to a github.com
  // URL) or a full github.com URL.
  if (input.githubRepo !== undefined) {
    const githubRepo = cleanString(input.githubRepo, MAX_URL);
    if (githubRepo === null) {
      errors.push('githubRepo is too long (max 500 chars)');
    } else if (githubRepo !== '') {
      if (GITHUB_REPO_RE.test(githubRepo)) {
        out.githubRepo = `https://github.com/${githubRepo}`;
      } else if (isValidHttpUrl(githubRepo) && new URL(githubRepo).hostname === 'github.com') {
        out.githubRepo = githubRepo;
      } else {
        errors.push('githubRepo must be a github.com URL or an "owner/repo" path');
      }
    } else {
      out.githubRepo = '';
    }
  } else {
    out.githubRepo = '';
  }

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') errors.push('enabled must be a boolean');
    else out.enabled = input.enabled;
  } else {
    out.enabled = true;
  }

  // Position in the admin's drag order. Optional: the admin panel no longer sends it (it
  // reorders by dragging — see D23), so an absent value means "append" on create and
  // "leave the position alone" on update, both handled in src/db.js.
  if (input.sortOrder !== undefined) {
    if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0) {
      errors.push('sortOrder must be a non-negative integer');
    } else {
      out.sortOrder = input.sortOrder;
    }
  }

  return { ok: errors.length === 0, errors, value: out };
}

export function validateSettings(input) {
  const errors = [];
  const out = {};
  const allowed = ['siteTitle', 'homepageTitle', 'siteDescription', 'siteUrl', 'siteFooter', 'showStats', 'accentColor', 'wallpaperAnchor', 'wallpaperSize', 'wallpaperTransparency', 'backgroundColor'];

  for (const key of allowed) {
    if (input[key] === undefined) continue;
    if (key === 'showStats') {
      if (typeof input[key] !== 'boolean') {
        errors.push('showStats must be a boolean');
      } else {
        out[key] = input[key];
      }
      continue;
    }
    if (key === 'accentColor') {
      // Strict on write (the picker can only send a known id) even though the read
      // side is forgiving: `settingsFrom` normalises anything unrecognised to the
      // default, so a value that never reached the DB cannot break a page.
      const accent = cleanString(input[key], 40);
      if (accent === null || !isAccent(accent)) {
        errors.push(`accentColor must be one of: ${ACCENTS.map((a) => a.id).join(', ')}`);
      } else {
        out[key] = accent;
      }
      continue;
    }
    if (WALLPAPER_ENUMS[key]) {
      // Same rule as the accent: strict on write, forgiving on read. The value ends up in
      // a `data-` attribute that style.css has one rule per, so a stray value here would
      // render as no placement at all rather than as the default (see D26).
      const v = cleanString(input[key], 20);
      if (v === null || !WALLPAPER_ENUMS[key].includes(v)) {
        errors.push(`${key} must be one of: ${WALLPAPER_ENUMS[key].join(', ')}`);
      } else {
        out[key] = v;
      }
      continue;
    }
    if (key === 'wallpaperTransparency') {
      // Stored as the digit string the slider's own unit is, so what the panel shows and
      // what the database holds are the same number.
      const n = input[key];
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        errors.push('wallpaperTransparency must be an integer between 0 and 100');
      } else {
        out[key] = String(n);
      }
      continue;
    }
    if (key === 'backgroundColor') {
      // An empty string is a real state: it is what "no background colour" means, and it
      // is how a previously set colour is cleared.
      const color = cleanString(input[key], 7);
      if (color === null || (color !== '' && !isHexColor(color))) {
        errors.push('backgroundColor must be a #rrggbb colour or empty');
      } else {
        out[key] = color.toLowerCase();
      }
      continue;
    }
    const v = cleanString(input[key], 500);
    if (v === null) {
      errors.push(`${key} is too long (max 500 chars)`);
    } else {
      out[key] = v;
    }
  }

  if (out.siteUrl !== undefined && out.siteUrl !== '' && !isValidHttpUrl(out.siteUrl)) {
    errors.push('siteUrl must be a valid http(s) URL');
  }

  return { ok: errors.length === 0, errors, value: out };
}

// The wallpaper placement settings, allow-listed from the same constants the admin panel
// renders its selects from (public/js/render.js) so the two cannot drift.
const WALLPAPER_ENUMS = {
  wallpaperAnchor: WALLPAPER_ANCHOR_IDS,
  wallpaperSize: WALLPAPER_SIZE_IDS,
};

// --- Page text (feedback + credits pages) ----------------------------------

// Per-key caps for the editable page copy: generous, but finite. The intro is the
// longest at a page's worth of prose rather than an essay.
const PAGE_TEXT_MAX = {
  feedbackSubtitle: 300,
  feedbackIntro: 4000,
  creditsSubtitle: 300,
  creditsNote: 1000,
};

export const PAGE_TEXT_KEYS = Object.keys(PAGE_TEXT_MAX);

// Control characters that carry no meaning in page copy and are how a stray escape ends up
// stored: NUL and the other C0 controls, minus tab and newline. The mailer strips the same
// set for the same reason (see src/mailer.js). Not a security boundary on its own — every
// value is escaped on render — but a field that is meant to be prose should not be able to
// hold a bell character.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g;

/**
 * Multi-line page copy: `cleanString` with newlines normalised to `\n` and other control
 * characters dropped. A client that sends CRLF (or a stray CR) would otherwise store a
 * carriage return that `renderParagraphs()` never splits on, leaving it inside a paragraph.
 */
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const v = value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
  return v.length > max ? null : v;
}

export function validatePageText(input) {
  const errors = [];
  const out = {};
  for (const key of PAGE_TEXT_KEYS) {
    if (input[key] === undefined) continue; // omitted = leave as stored
    const v = cleanText(input[key], PAGE_TEXT_MAX[key]);
    if (v === null) errors.push(`${key} is too long (max ${PAGE_TEXT_MAX[key]} chars)`);
    else out[key] = v;
  }
  return { ok: errors.length === 0, errors, value: out };
}

// --- Credit lines (credits page) -------------------------------------------

const MAX_CREDIT_ROLE = 120;
const MAX_CREDIT_VALUE = 200;

export function validateCredit(input) {
  const errors = [];
  const out = {};

  // The role is a label ("Built with"); a line may legitimately have none, so only the
  // value is required. Both create and update take the complete line (the admin panel
  // always sends all three fields), so an absent role means "no label".
  //
  // Control characters are stripped rather than rejected: they cannot be typed into the
  // form, so their only source is a malformed client, and dropping them keeps a paste of
  // "Built\u0000with" from becoming a stored oddity.
  const role = input.role === undefined ? '' : cleanCreditField(cleanString(input.role, MAX_CREDIT_ROLE));
  if (role === null) errors.push(`role is too long (max ${MAX_CREDIT_ROLE} chars)`);
  else out.role = role;

  const value = cleanCreditField(cleanString(input.value, MAX_CREDIT_VALUE));
  if (!value) errors.push(`value is required (max ${MAX_CREDIT_VALUE} chars)`);
  else out.value = value;

  // The link is optional: a line with no URL renders as plain text instead of a link.
  if (input.url !== undefined) {
    const url = cleanCreditField(cleanString(input.url, MAX_URL));
    if (url === null) errors.push(`url is too long (max ${MAX_URL} chars)`);
    else if (url !== '' && !isValidHttpUrl(url)) errors.push('url must be a valid http(s) URL');
    else out.url = url;
  } else {
    out.url = '';
  }

  return { ok: errors.length === 0, errors, value: out };
}

// Control characters carry no meaning in a single-line credit field; see CONTROL_CHARS.
function cleanCreditField(cleaned) {
  return cleaned === null ? null : cleaned.replace(CONTROL_CHARS, '');
}

// --- Feedback --------------------------------------------------------------

export const MAX_FEEDBACK_NAME = 120;
export const MAX_FEEDBACK_MESSAGE = 4000;
export const MAX_FEEDBACK_EMAIL = 254; // RFC 5321 maximum for a forward-path

// Deliberately loose: the only thing a stricter regex buys is rejecting addresses
// that are actually valid (plus-addressing, long TLDs, quoted local parts). The
// real proof that an address works is that the message arrives.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length > 0 && v.length <= MAX_FEEDBACK_EMAIL && EMAIL_RE.test(v);
}

/**
 * Validate a public feedback submission.
 *
 * `honeypot` is a field hidden from humans; a filled value means a bot. It is
 * *reported* rather than rejected here so the route can answer 200 with an innocuous
 * message — telling a bot which field gave it away only helps the next bot.
 */
export function validateFeedback(input, { honeypotField = 'website' } = {}) {
  const errors = [];
  const out = {};

  const name = cleanString(input.name, MAX_FEEDBACK_NAME);
  if (!name) errors.push(`name is required (max ${MAX_FEEDBACK_NAME} chars)`);
  else out.name = name;

  const email = cleanString(input.email, MAX_FEEDBACK_EMAIL);
  if (!email) errors.push('email is required');
  else if (!isValidEmail(email)) errors.push('email must be a valid address');
  else out.email = email;

  // Required per the brief. `cleanString` trims; an all-whitespace message is not a
  // message, so it fails the same way an empty one does.
  const rawMessage = typeof input.message === 'string' ? input.message : '';
  const message = rawMessage.trim();
  if (!message) errors.push('message is required');
  else if (message.length > MAX_FEEDBACK_MESSAGE) {
    errors.push(`message is too long (max ${MAX_FEEDBACK_MESSAGE} chars)`);
  } else out.message = message;

  return {
    ok: errors.length === 0,
    errors,
    value: out,
    honeypotTripped: String(input[honeypotField] ?? '').trim() !== '',
  };
}

// `smtpPassword` is handled separately in validateSmtpSettings below: an omitted
// password means "keep the stored one", not "clear it".

// Ports offered as presets, with the transport each implies. Kept in step with
// src/mailer.js SMTP_PORTS. The protocol is tied to the port on purpose, so the two
// cannot be configured independently and end up mismatched.
//
// These are presets, not the only allowed values: all three are privileged ports, so a
// hard allow-list made a local capture server impossible to point at and blocked
// providers on non-standard ports.
const SMTP_PRESET_PORTS = { 465: true, 587: false, 25: false };

export function validateSmtpSettings(input) {
  const errors = [];
  const out = {};

  if (input.smtpHost !== undefined) {
    const host = cleanString(input.smtpHost, 200);
    if (host === null) errors.push('smtpHost is too long (max 200 chars)');
    else if (host !== '' && !/^[A-Za-z0-9.-]+$/.test(host)) {
      // No scheme, no port, no path — just the hostname. A URL here is a common
      // mistake that produces a confusing connection error much later.
      errors.push('smtpHost must be a hostname (no scheme, port or path)');
    } else out.smtpHost = host;
  }

  let port;
  if (input.smtpPort !== undefined && input.smtpPort !== '') {
    port = Number(input.smtpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push('smtpPort must be a port number between 1 and 65535');
    } else out.smtpPort = port;
  } else if (input.smtpPort !== undefined) {
    out.smtpPort = '';
  }

  // `secure` is derived from the port rather than trusted from the client: the two must
  // agree, and the port is the value that has to be right for the connection to work at
  // all. 465 is implicit TLS; every other port is STARTTLS-capable.
  if (port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535) {
    out.smtpSecure = port === 465 ? '1' : '0';
  }

  if (input.smtpUser !== undefined) {
    const user = cleanString(input.smtpUser, 200);
    if (user === null) errors.push('smtpUser is too long (max 200 chars)');
    else out.smtpUser = user;
  }

  for (const key of ['smtpFrom', 'smtpTo']) {
    if (input[key] === undefined) continue;
    const v = cleanString(input[key], MAX_FEEDBACK_EMAIL);
    if (v === null) errors.push(`${key} is too long (max ${MAX_FEEDBACK_EMAIL} chars)`);
    else if (v !== '' && !isValidEmail(v)) errors.push(`${key} must be a valid email address`);
    else out[key] = v;
  }

  // Password: only touched when the client explicitly sends a string. `null` means
  // "clear it"; omitting the key means "leave whatever is stored".
  if (input.smtpPassword !== undefined) {
    if (input.smtpPassword === null) {
      out.smtpPassword = '';
    } else if (typeof input.smtpPassword === 'string') {
      if (input.smtpPassword.length > 200) errors.push('smtpPassword is too long (max 200 chars)');
      // Reject control characters: this value goes into an SMTP AUTH exchange, and a
      // newline in it is how you smuggle a second command.
      else if (/[\r\n\0]/.test(input.smtpPassword)) errors.push('smtpPassword contains invalid characters');
      else out.smtpPassword = input.smtpPassword;
    } else {
      errors.push('smtpPassword must be a string or null');
    }
  }

  return { ok: errors.length === 0, errors, value: out };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Aligned with the 500kb JSON body limit (express.json) — a 64x64 PNG is a few KB.
const MAX_ICON_BASE64 = 90_000;
// 640x360 thumbnail PNGs are larger; cap below the 500kb body limit.
const MAX_THUMB_BASE64 = 450_000;

/**
 * Validates a raw base64 PNG payload — the form the images are stored in (the
 * `data:image/png;base64,` prefix is stripped on write; see `pngDataUrlToBase64`).
 *
 * A restore is the second caller: an archive carries the stored payloads verbatim, and a
 * value that is not a PNG must be refused before it reaches the database and, from there,
 * `/service-icon/:id.png`.
 */
export function isPngBase64(value, max = MAX_ICON_BASE64) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false;
  // Base64 characters only — no data-URL prefix, no stray punctuation. Whitespace is
  // tolerated because the data-URL form this shares its character class with tolerates it,
  // and a stored payload that arrived that way must still be restorable.
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) return false;
  let buf;
  try {
    buf = Buffer.from(value, 'base64');
  } catch {
    return false;
  }
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Accepts a `data:image/png;base64,…` data URL and validates the PNG signature. */
export function isPngDataUrl(value, max = MAX_ICON_BASE64) {
  if (typeof value !== 'string') return false;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!m || m[1].length > max) return false;
  let buf;
  try {
    buf = Buffer.from(m[1], 'base64');
  } catch {
    return false;
  }
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

// Exported for `src/backup.js`, which validates archived artwork against the same caps the
// admin uploads are held to — one definition of "an image this app will store".
export const MAX_ICON_BASE64_CHARS = MAX_ICON_BASE64;
export const MAX_THUMB_BASE64_CHARS = MAX_THUMB_BASE64;

/** Validates a thumbnail PNG data URL (larger size cap than icons). */
export function isThumbDataUrl(value) {
  return isPngDataUrl(value, MAX_THUMB_BASE64);
}

// The wallpaper is the largest image the app stores. Two things set this number, and they
// have to be read together.
//
// It is bounded **below** by the browser's own encoder, because that is what decides the size
// of an upload. A canvas `toDataURL('image/png')` is markedly less efficient than a
// command-line encoder: the bundled photo is 1 497 300 characters as a file produced by
// ffmpeg, but the *same pixels* re-encoded by Chromium's canvas are 1 926 880. Sizing the cap
// against the file on disk rather than against what the panel actually sends is how the
// shipped wallpaper ends up quietly refused — and the refusal is client-side, so the server
// never sees the request and there is nothing in the logs.
//
// It is bounded **above** by the memory the request path holds at once (see the parser note in
// src/server.js). At this cap a full-size upload arrives as ~2 MB of base64 in a JSON body
// under a 2.3 MB parser limit, and the restore path additionally buffers a gzipped archive and
// expands it — roughly 6 MB of peak working set for a deployment holding one such wallpaper,
// about 2.4% of the container's `mem_limit: 256m` (docker-compose.yml). The 12 MB / 24 MB
// archive caps in src/backup.js are not close either.
//
// Why it is this large rather than the 750 000 it started at: the bundled photo had been
// quantized to 256 colours to keep the repository's asset small, while a canvas always emits
// truecolour. That mismatch meant the *shipped wallpaper could not be re-uploaded through the
// panel* — the old cap cleared the seed by 3%, the same image re-encoded by the browser was
// 2.6x over it, and deleting and re-adding the default produced a visibly softer 800px
// backdrop. Raising the cap is what makes the default reproducible at the quality it ships at,
// which client-side cleverness would not have achieved without a quantizer in the panel.
export const MAX_WALLPAPER_BASE64 = 2_100_000;

/** Validates a wallpaper PNG data URL (the upload path). */
export function isWallpaperDataUrl(value) {
  return isPngDataUrl(value, MAX_WALLPAPER_BASE64);
}

/**
 * Validates the wallpaper as it is stored — raw base64, the form `PUT /api/admin/wallpaper`
 * strips the prefix down to, and the form a restore carries in its archive.
 */
export function isWallpaperBase64(value) {
  return isPngBase64(value, MAX_WALLPAPER_BASE64);
}

/** Strips the `data:image/png;base64,` prefix, returning the raw base64 payload. */
export function pngDataUrlToBase64(value) {
  return value.slice(value.indexOf(',') + 1);
}
