/**
 * The public read model: the shape of site settings and services exposed to
 * anonymous visitors. Shared by the public API (`src/routes/public.js`) and the
 * server-rendered homepage (`src/render-page.js`) so the API response and the
 * first paint can never disagree.
 */
import * as store from './db.js';
import { normalizeAccent, normalizeWallpaperAnchor, normalizeWallpaperSize, normalizeTransparency, normalizeHexColor } from '../public/js/render.js';
import { PAGE_TEXT_KEYS } from './validate.js';

export const SETTING_KEYS = ['siteTitle', 'homepageTitle', 'siteDescription', 'siteUrl', 'siteFooter', 'showStats', 'accentColor', 'wallpaperAnchor', 'wallpaperSize', 'wallpaperTransparency', 'backgroundColor'];

// Settings that are never public, but that the server-rendered pages need a boolean
// view of. Kept out of SETTING_KEYS on purpose: that array defines the /api/site
// payload, and the feedback flag is read from the DB directly by the pages.
export function feedbackEnabled() {
  return store.getSetting('feedbackEnabled') === '1';
}

// Settings are stored as strings; `showStats` is a boolean (default true when unset)
// and `accentColor` is normalised to a known accent (default `amber`), so neither the
// API nor a rendered page can carry a value the stylesheet has no palette for.
//
// The wallpaper keys are normalised the same way, for the same reason: `wallpaperAnchor`
// and its siblings are interpolated into `data-` attributes that style.css has one rule
// per, and a value with no rule would render as *no* placement rather than a wrong one
// (see D26). `wallpaperTransparency` is a number, so it is parsed rather than passed on.
export function settingsFrom(all) {
  const out = {};
  for (const k of SETTING_KEYS) {
    out[k] =
      k === 'showStats'
        ? all[k] !== '0'
        : k === 'accentColor'
          ? normalizeAccent(all[k])
          : k === 'wallpaperAnchor'
            ? normalizeWallpaperAnchor(all[k])
            : k === 'wallpaperSize'
              ? normalizeWallpaperSize(all[k])
              : k === 'wallpaperTransparency'
                ? normalizeTransparency(all[k])
                : k === 'backgroundColor'
                  ? normalizeHexColor(all[k])
                  : (all[k] ?? '');
  }
  out.hasIcon = Boolean(all.siteIconPng);
  out.hasWallpaper = Boolean(all.wallpaperPng);
  return out;
}

export function publicSettings() {
  return settingsFrom(store.getAllSettings());
}

/**
 * The editable page copy for the feedback and credits pages.
 *
 * Read straight from the settings table. Unlike `SETTING_KEYS` these are not part of the
 * `/api/site` payload: no public page fetches them, the server renders them into the
 * first byte (see docs/decisions.md D22).
 *
 * There is deliberately no fallback to the seed copy here. An empty value means the
 * admin cleared that field, and resurrecting the default would make the field
 * impossible to empty; a fresh database is seeded by `migrate()` instead.
 */
export function pageText(all = store.getAllSettings()) {
  const out = {};
  for (const key of PAGE_TEXT_KEYS) out[key] = all[key] ?? '';
  return out;
}

// The credits page lines, in the admin's drag order. `sortOrder` is an implementation
// detail of the ordering and stays out of the public shape.
export function listPublicCredits() {
  return store.listCredits().map((c) => ({ id: c.id, role: c.role, value: c.value, url: c.url }));
}

export function listPublicServices() {
  return store.listServices({ includeDisabled: false }).map((s) => ({
    id: s.id,
    name: s.name,
    icon: s.icon,
    iconImage: Boolean(s.iconImage),
    thumbnailImage: Boolean(s.thumbnailImage),
    description: s.description,
    url: s.url,
    githubRepo: s.githubRepo,
    techStack: s.techStack,
    aiDetails: s.aiDetails,
    story: s.story,
    audience: s.audience,
    status: s.status,
    latencyMs: s.latencyMs,
    lastChecked: s.lastChecked,
    updatedAt: s.updatedAt,
  }));
}
