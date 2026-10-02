// Shared view helpers for the public site.
//
// Imported by both the server (src/render-page.js, for the server-rendered first
// paint) and the browser (public/js/app.js, for the 60s poll). Keep this module
// free of DOM access and of Node/browser-specific APIs so both can use it.
//
// SECURITY: every dynamic value that reaches the returned markup goes through
// esc(). When you add a field, escape it — never interpolate raw input.

export function esc(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Split prose on hard returns into separate <p> elements (escaped). HTML
// collapses newlines by default, so without this the paragraphs would run
// together as one block of text.
//
// `className` is applied to every paragraph. The editable page copy (the feedback
// intro, the credits note) needs that styling hook; the service popups use the bare
// `<p>`. Blank and whitespace-only blocks are dropped rather than rendered as an
// empty paragraph.
export function renderParagraphs(text, className = '') {
  const attr = className ? ` class="${className}"` : '';
  return String(text ?? '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p${attr}>${esc(p)}</p>`)
    .join('');
}

// A page's subtitle, omitted entirely when the text is empty — an empty `<p>` would
// leave a gap where the copy used to be.
export function pageSubtitleHtml(text) {
  return text ? `<p class="subtitle">${esc(text)}</p>` : '';
}

/**
 * The credits page lines, in the order the admin arranged them.
 *
 * A line's value is a link when a URL is configured and plain text otherwise, so a
 * credit without one does not become a dead end. The role label ("Built with") is
 * dropped when empty, leaving the value on its own rather than pushed to the right
 * edge by `.credit-item`'s `space-between`.
 */
export function creditsHtml(credits) {
  return credits
    .map((c) => {
      const role = c.role ? `\n          <span class="credit-role">${esc(c.role)}</span>` : '';
      const value = c.url
        ? `<a class="credit-link" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.value)}<svg><use href="#i-arrow"/></svg></a>`
        : `<span class="credit-link">${esc(c.value)}</span>`;
      return `
        <div class="credit-item">${role}
          ${value}
        </div>`;
    })
    .join('');
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

export function statusLabel(s) { return { up: 'Operational', down: 'Down', unknown: 'Unknown' }[s] || 'Unknown'; }

// `status` is interpolated straight into a `class` attribute, so constrain it to
// the values the health checker can actually produce rather than trusting the
// column. (Only src/health.js writes it today — this is defence in depth.)
const STATUSES = new Set(['up', 'down', 'unknown']);

export function validStatus(s) { return STATUSES.has(s) ? s : 'unknown'; }

export function formatLatency(ms) {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export const AUDIENCE_LABELS = {
  personal: 'Personal',
  shared: 'Worth sharing',
  'open-source': 'Open source',
};

// --- Homepage chrome -------------------------------------------------------

export function pageTitle(settings) {
  const title = settings.homepageTitle || settings.siteTitle || 'Services';
  return `${title} — ${settings.siteTitle || 'vibefolio'}`;
}

const META_FALLBACK = 'Live status and overview of the public services on this site.';

export function metaDescription(settings) {
  return settings.siteDescription || META_FALLBACK;
}

// The favicon + brand logo depend on whether an admin uploaded a site icon.
// The server renders the correct state so no icon swap happens after load.
export function faviconTag(hasIcon) {
  return hasIcon
    ? '<link rel="icon" href="/favicon.png" type="image/png" id="favicon-link" />'
    : '<link rel="icon" href="/favicon.svg" type="image/svg+xml" id="favicon-link" />';
}

export function brandHtml(siteTitle, hasIcon, label = siteTitle || 'vibefolio') {
  // Note: SVGElement does not reflect the `hidden` property — the attribute is set
  // explicitly on the default logo, exactly as applyIcon() does at runtime.
  const defaultLogo = `<svg id="brand-icon-default"${hasIcon ? ' hidden' : ''}><use href="#i-logo"/></svg>`;
  const customLogo = hasIcon
    ? '<img id="brand-icon" src="/site-icon.png" alt="" />'
    : '<img id="brand-icon" alt="" hidden />';
  return `<a class="${hasIcon ? 'brand has-custom-icon' : 'brand'}" href="/">
        <span class="logo">
          ${defaultLogo}
          ${customLogo}
        </span>
        <span id="brand-title">${esc(label)}</span>
      </a>`;
}

/**
 * The login card's mark. Same rule as the header brand: the uploaded site icon when
 * there is one, otherwise the default logo on its gradient tile. Both are rendered
 * and toggled by `admin.js` `applyIcon()`, because logging out reveals this card
 * without a page reload — a server-rendered-only version would show the icon from
 * before the upload.
 *
 * The `has-custom-icon` modifier sits on `.logo` here (it sits on `.brand` in the
 * header, where `.logo` is an inner element) because the gradient tile *is* the
 * logo box in this card.
 */
export function authLogoHtml(hasIcon) {
  return `<div class="logo${hasIcon ? ' has-custom-icon' : ''}">
          <svg id="auth-logo-default"${hasIcon ? ' hidden' : ''}><use href="#i-logo"/></svg>
          ${hasIcon
            ? '<img id="auth-logo" src="/site-icon.png" alt="" />'
            : '<img id="auth-logo" alt="" hidden />'}
        </div>`;
}

/**
 * The footer's content: the configured footer text, nothing else.
 *
 * The Credits/Feedback links were removed from here at the owner's request. Navigation
 * now lives in the slide-out menu, which carries Services / Credits / Feedback.
 *
 * With no links, the footer has nothing to say when no text is configured, so it is
 * omitted entirely rather than rendered as an empty bar.
 */
export function footerHtml(text) {
  if (!text) return '';
  return `  <footer class="site-footer">
    <div class="container inner">
      <p><span id="site-footer">${esc(text)}</span></p>
    </div>
  </footer>`;
}

// --- Theme -----------------------------------------------------------------

// The theme lives in a cookie and is rendered into `<html data-theme="…">` by the
// server, so the correct palette is in the first byte and there is no flash of
// the wrong theme (see D15). The browser only has to write the cookie and flip
// the attribute when the user picks a different one.
export const THEMES = ['dark', 'light', 'system'];

// `dark` is the default: the site is dark-first (D5), so visitors who never open
// the menu see exactly what they saw before the theme selector existed.
export const DEFAULT_THEME = 'dark';

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

// The `<meta name="theme-color">` the browser paints its chrome with.
export const THEME_COLORS = { dark: '#08090d', light: '#f4f5f9', system: '#08090d' };

// Labels are static, so the drawer markup carries no user input — but the values
// are interpolated into `value`/`id` attributes, so they stay here rather than in
// the template where a typo would be invisible.
const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark', icon: 'i-moon' },
  { value: 'light', label: 'Light', icon: 'i-sun' },
  { value: 'system', label: 'System', icon: 'i-monitor' },
];

function themeOptionsHtml(theme) {
  return THEME_OPTIONS.map(({ value, label, icon }) => `
          <label class="theme-opt">
            <input type="radio" name="theme" value="${value}"${value === theme ? ' checked' : ''} />
            <svg aria-hidden="true"><use href="#${icon}"/></svg>
            <span>${label}</span>
          </label>`).join('');
}

// --- Accent ----------------------------------------------------------------

/**
 * The site's single highlight colour (see D21).
 *
 * Unlike the theme this is a *site* setting, not a per-visitor preference, so the
 * server renders it from the DB into `<html data-accent="…">` exactly as it does
 * the theme: the right palette is in the first byte and no script is needed to
 * apply it. The list lives here because all three consumers need the same one —
 * `src/validate.js` (reject anything else), `src/public-data.js` (normalise on
 * read) and the admin picker's markup.
 *
 * The ids are also the CSS hook: `style.css` declares each one's tokens, and an
 * element carrying the attribute (the admin picker's swatches do) gets that
 * accent's palette.
 */
export const ACCENTS = [
  { id: 'amber', label: 'Amber' }, // the site's original yellow — the default
  { id: 'violet', label: 'Violet' },
  { id: 'cyan', label: 'Cyan' },
  { id: 'emerald', label: 'Emerald' },
  { id: 'rose', label: 'Rose' },
];

// `amber` is the default: the `:root` tokens in style.css ARE amber, so an unset
// or unrecognised value renders exactly what the site looked like before the
// picker existed.
export const DEFAULT_ACCENT = 'amber';

export function isAccent(value) {
  return ACCENTS.some((a) => a.id === value);
}

export function normalizeAccent(value) {
  return isAccent(value) ? value : DEFAULT_ACCENT;
}

/**
 * The admin panel's accent picker. Each option carries its own id in `data-accent`, so the
 * chip is painted with the accent it offers rather than the one currently in force: the
 * label, border and swatch are all in that accent, which is the point of the control — you
 * pick by looking (see the accent blocks in style.css and D24).
 *
 * The one in force is marked twice, because "every chip is coloured" makes colour alone
 * ambiguous: a solid border and a check mark. The check is `aria-hidden` — the radio input
 * already carries the state for assistive tech.
 *
 * Labels are static constants, so nothing here needs escaping.
 */
export function accentOptionsHtml(current = DEFAULT_ACCENT) {
  return ACCENTS.map(({ id, label }) => `
            <label class="accent-opt" data-accent="${id}">
              <input type="radio" name="accentColor" value="${id}"${id === current ? ' checked' : ''} />
              <span class="swatch" aria-hidden="true"></span>
              <span>${label}</span>
              <svg class="accent-check" aria-hidden="true"><use href="#i-check"/></svg>
            </label>`).join('');
}

// --- Wallpaper & background (see D26) --------------------------------------

/**
 * The ambient backdrop: a background colour, an uploaded wallpaper on top of it, and
 * the theme's readability wash over both.
 *
 * Unlike the accent these are *placement* choices rather than palettes, so they are
 * carried by `data-` attributes on `.bg-photo` (`style.css` has one rule per id) and the
 * image/opacity by two custom properties. The lists live here because all three
 * consumers need the same one: `src/validate.js` (reject anything else),
 * `src/public-data.js` (normalise on read) and the admin panel's selects.
 *
 * Every id is also a CSS hook, and an id with no rule would render as *no* placement
 * rather than as a wrong one — `test/wallpaper.test.js` fails if the two drift.
 */
export const WALLPAPER_ANCHORS = [
  { id: 'center', label: 'Centre' }, // the bundled photo's own anchor — the default
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
];

export const WALLPAPER_SIZES = [
  { id: 'cover', label: 'Fill the screen (cover)' }, // what the site has always done
  { id: 'contain', label: 'Fit inside (contain)' },
  { id: 'stretch', label: 'Stretch to fill' },
  { id: 'tile', label: 'Tile' },
  { id: 'natural', label: 'Actual size' },
];

// There is deliberately no fixed-vs-scrolling option. The backdrop is a `position: fixed`
// layer the size of the viewport, so the two `background-attachment` values render
// identically: the element never moves relative to the image, and on a narrow viewport the
// media query forced `scroll` for every choice anyway. It was a control with no observable
// effect, which is worse than no control — the label promised behaviour the layout could
// not deliver (see D26).

/**
 * The defaults reproduce the site as it looked with the bundled photo
 * (`public/img/bg.png`): filling the screen, centred, fully opaque, over the theme's own
 * background. That is what makes the one-time seed (see `migrate()` in src/db.js) a no-op
 * visually.
 */
export const DEFAULT_WALLPAPER = {
  anchor: 'center',
  size: 'cover',
  transparency: 0,
  color: '',
};

const enumIds = (list) => list.map((o) => o.id);

export const WALLPAPER_ANCHOR_IDS = enumIds(WALLPAPER_ANCHORS);
export const WALLPAPER_SIZE_IDS = enumIds(WALLPAPER_SIZES);

export const isWallpaperAnchor = (v) => WALLPAPER_ANCHOR_IDS.includes(v);
export const isWallpaperSize = (v) => WALLPAPER_SIZE_IDS.includes(v);

export const normalizeWallpaperAnchor = (v) => (isWallpaperAnchor(v) ? v : DEFAULT_WALLPAPER.anchor);
export const normalizeWallpaperSize = (v) => (isWallpaperSize(v) ? v : DEFAULT_WALLPAPER.size);

/**
 * How much of the background colour shows through the wallpaper, 0–100. It is stored as
 * the transparency (the slider's own unit) and turned into the CSS opacity at render
 * time, so the stored number is the one the panel shows.
 *
 * The string form is matched against `/^\d+$/` rather than handed to `parseInt`, which
 * truncates: `parseInt('12.5')` is `12`, `parseInt('50abc')` is `50` and `parseInt('1e2')`
 * is `1`. Each of those would quietly become a value the admin never chose, and this
 * number ends up in a `data-`-equivalent position (a CSS custom property), so a
 * plausible-but-wrong value is worse than the default — it looks deliberate.
 */
export function normalizeTransparency(value) {
  const raw = typeof value === 'number' ? value : String(value ?? '');
  if (!/^\d{1,3}$/.test(String(raw))) return DEFAULT_WALLPAPER.transparency;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100) return DEFAULT_WALLPAPER.transparency;
  return n;
}

/** `#rrggbb` (case-insensitive), or `''` for "use the theme's own background". */
export const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function isHexColor(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

export function normalizeHexColor(value) {
  return isHexColor(value) ? value.toLowerCase() : DEFAULT_WALLPAPER.color;
}

/** The stored settings, as the backdrop layers need them. */
export function wallpaperFrom(settings = {}) {
  return {
    hasImage: Boolean(settings.hasWallpaper),
    anchor: normalizeWallpaperAnchor(settings.wallpaperAnchor),
    size: normalizeWallpaperSize(settings.wallpaperSize),
    transparency: normalizeTransparency(settings.wallpaperTransparency),
    color: normalizeHexColor(settings.backgroundColor),
  };
}

/**
 * The three backdrop layers, in paint order: the colour, the wallpaper over it, and the
 * theme's wash over both.
 *
 * Why three and not one element with a `background-image`: the transparency slider has to
 * fade the *wallpaper* without fading the wash. The wash is what guarantees the text stays
 * readable over an arbitrary photo (it is `--photo-overlay`, the same token the bundled
 * photo always had), so it must stay at full strength — fading it together with the image
 * would drop the text under AA exactly when the admin picked a bright wallpaper.
 *
 * The layers sit at negative z-index: `html` has no background of its own, so `body`'s is
 * propagated to the canvas and painted *behind* them, which is what still shows if the
 * admin turns everything off.
 *
 * Every value is either an allow-listed id or a validated hex, so nothing here needs
 * escaping — and nothing else may be interpolated into these attributes.
 */
export function backgroundHtml(settings = {}) {
  const wp = wallpaperFrom(settings);
  const style = [
    wp.hasImage ? `--wp-image:url('/wallpaper.jpg')` : '',
    wp.hasImage ? `--wp-opacity:${(100 - wp.transparency) / 100}` : '',
  ]
    .filter(Boolean)
    .join(';');
  return [
    `<div class="bg-color" aria-hidden="true"${wp.color ? ` style="--wp-color:${wp.color}"` : ''}></div>`,
    `<div class="bg-photo" aria-hidden="true" data-size="${wp.size}" data-anchor="${wp.anchor}"${style ? ` style="${style}"` : ''}></div>`,
    '<div class="bg-overlay" aria-hidden="true"></div>',
  ].join('\n  ');
}

/**
 * One of the admin panel's three placement selects, server-rendered with the stored value
 * pre-selected — the same reason the accent radios and the theme selector are: the panel
 * is never briefly wrong, and the checked state cannot disagree with the page.
 */
export function wallpaperOptionsHtml(kind, current) {
  const lists = {
    anchor: WALLPAPER_ANCHORS,
    size: WALLPAPER_SIZES,
  };
  const list = lists[kind];
  if (!list) throw new Error(`Unknown wallpaper option list: ${kind}`);
  return list
    .map(({ id, label }) => `\n              <option value="${id}"${id === current ? ' selected' : ''}>${label}</option>`)
    .join('');
}

/**
 * The wallpaper preview's initial `src`, rendered server-side — just the attribute, and
 * only when there is a wallpaper to show.
 *
 * Why not a fixed `<img src="">` with the value filled in by script: an empty `src` is not
 * "no image". The browser resolves it against the document, so the element re-requests
 * `/admin` itself on every panel load — a wasted request and a broken-image flash before
 * the `empty` class hides it. The server already knows whether a wallpaper is active, so it
 * renders the correct state and `admin.js` only changes it when the admin uploads or deletes
 * one.
 *
 * The element's `class` is the template's business, not this function's: returning a second
 * `class` attribute to be appended would produce a duplicate on the element and silently
 * drop the `empty` class (a duplicate attribute keeps the *first*, and the template's comes
 * first). It returns the empty string for the no-wallpaper case, so the template's own
 * `class="preview wallpaper"` stands and `admin.js` adds `empty` when it syncs.
 *
 * `version` is passed in rather than imported: this module is loaded by the browser as well
 * as the server and deliberately has no imports at all (a Node-only specifier here would
 * 404 in the browser and kill every listener on the page). The caller supplies it.
 */
export function wallpaperPreviewAttr(hasWallpaper, version = '') {
  if (!hasWallpaper) return '';
  return ` src="/wallpaper.jpg${version ? `?v=${version}` : ''}"`;
}

// --- Fold-out menu ---------------------------------------------------------

/**
 * The header's hamburger. Rendered into `.header-right`; the drawer it controls is
 * a **sibling of `<header>`** (`drawerHtml` below), not a child — `.site-header`
 * carries `backdrop-filter`, which makes it a containing block for
 * `position: fixed` descendants, so a drawer nested inside it would be positioned
 * against the header and clipped instead of the viewport.
 */
export function menuToggleHtml() {
  return `<button type="button" class="menu-toggle" id="menu-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="drawer">
          <svg aria-hidden="true"><use href="#i-menu"/></svg>
        </button>`;
}

/**
 * The slide-out menu: name + release date, live status counts, theme selector and
 * the admin entry point.
 *
 * Everything is server-rendered so the drawer is complete before any script runs
 * and so the credits/admin pages need no fetch to fill it in. `public/js/chrome.js`
 * adds only the behaviour (open/close, theme switching, admin label) and
 * `public/js/app.js` keeps the counts live on the homepage.
 *
 * The closed drawer is `inert`: it is off-screen and must stay out of the tab
 * order and the accessibility tree until it is opened.
 */
export function drawerHtml({
  services = [],
  theme = DEFAULT_THEME,
  appName = 'Vibefolio',
  releaseDate = '',
  adminLabel = 'Admin logon',
  feedbackEnabled = false,
} = {}) {
  const summary = liveSummary(services);
  return `  <div class="drawer-backdrop" id="drawer-backdrop"></div>
  <aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" inert>
    <div class="drawer-head">
      <div>
        <h2 class="drawer-title" id="drawer-title">${esc(appName)}</h2>
        <p class="drawer-sub" id="drawer-release"><span class="drawer-sub-label">Updated:</span> ${esc(releaseDate)}</p>
        <p class="drawer-links">${drawerLinksHtml({ feedbackEnabled })}</p>
      </div>
      <button type="button" class="drawer-close" id="drawer-close" aria-label="Close menu">
        <svg aria-hidden="true"><use href="#i-close"/></svg>
      </button>
    </div>

    <div class="drawer-section">
      <h3>Status</h3>
      <p class="drawer-summary">
        <span class="status ${summary.state}" id="drawer-summary"><span class="dot"></span><span class="txt">${esc(summary.text)}</span></span>
      </p>
      ${statusRowsHtml(services)}
    </div>

    <div class="drawer-section">
      <h3>Theme</h3>
      <div class="theme-options" role="radiogroup" aria-label="Theme">${themeOptionsHtml(theme)}
      </div>
    </div>

    <div class="drawer-foot">
      <a class="btn ghost drawer-admin" id="drawer-admin" href="/admin">
        <svg aria-hidden="true"><use href="#i-shield"/></svg><span id="drawer-admin-label">${esc(adminLabel)}</span>
      </a>
    </div>
  </aside>`;
}

/**
 * The links under the release date.
 *
 * `Services` comes first because it is the way back to the top-level page, and on
 * /credits and /feedback it is otherwise only reachable via the brand logo. `Feedback` is
 * conditional (see D17): with the feature off, /feedback 404s and a link to it would be a
 * dead end.
 */
export function drawerLinksHtml({ feedbackEnabled = false } = {}) {
  const feedback = feedbackEnabled ? ' · <a href="/feedback">Feedback</a>' : '';
  return `<a href="/">Services</a> · <a href="/credits">Credits</a>${feedback}`;
}
export function statusRowsHtml(services) {
  const { total, up, down } = statusCounts(services);
  return `<div class="status-rows">
        <div class="status-row"><span class="k">Total</span><span class="v" id="drawer-total">${total}</span></div>
        <div class="status-row"><span class="k">Online</span><span class="v ok" id="drawer-up">${up}</span></div>
        <div class="status-row"><span class="k">Errors</span><span class="v down" id="drawer-down">${down}</span></div>
      </div>`;
}

// --- Services --------------------------------------------------------------

// Exported so `app.js` can patch the drawer's status counts from the same
// definition the server renders them with.
export function statusCounts(services) {
  return {
    total: services.length,
    up: services.filter((s) => s.status === 'up').length,
    down: services.filter((s) => s.status === 'down').length,
  };
}

// Icon: uploaded image, URL image, emoji, or the ◆ fallback.
export function iconHtml(svc) {
  if (svc.iconImage) {
    return `<img src="/service-icon/${svc.id}.png?v=${esc(svc.updatedAt || '')}" alt="" loading="lazy"/>`;
  }
  if (svc.icon) {
    return svc.icon.startsWith('http')
      ? `<img src="${esc(svc.icon)}" alt="" loading="lazy"/>`
      : esc(svc.icon);
  }
  return '◆';
}

// `data-id` lets app.js patch live fields of a server-rendered card in place
// instead of rebuilding the whole grid on the first poll.
//
// The thumbnail and the description are ONE clickable group (`.card-hit`), and both
// of its buttons open the same detail dialog. The thumbnail button is a transparent
// layer stretched over the static thumbnail image via `position: absolute; inset: 0`
// — NOT a container for the hint. Keeping the hint outside it two goals at once:
// hovering the image reveals the hint in the same place as hovering the text (below
// the description), and the group reserves no vertical space for the hint itself.
const HINT = '<span class="desc-hint"><svg><use href="#i-info"/></svg>About this project</span>';

export function renderCard(svc, i, { animate = true } = {}) {
  const status = validStatus(svc.status);

  const github = svc.githubRepo
    ? `<a class="github-link" href="${esc(svc.githubRepo)}" target="_blank" rel="noopener noreferrer" title="GitHub repository" aria-label="GitHub repository">
        <svg><use href="#i-github"/></svg>
      </a>`
    : '';

  const thumb = svc.thumbnailImage
    ? `<div class="card-thumb-wrap">
        <img class="card-thumb" src="/service-thumb/${svc.id}.png?v=${esc(svc.updatedAt || '')}" alt="" loading="lazy"/>
        <button type="button" class="card-thumb-btn" data-detail="${svc.id}" aria-label="More about ${esc(svc.name)}"></button>
      </div>`
    : '';

  const desc = `
    <button type="button" class="card-desc-btn" data-detail="${svc.id}" aria-label="More about ${esc(svc.name)}">
      <span class="card-desc">${esc(svc.description) || 'No description.'}</span>
    </button>`;

  return `
    <article class="service-card${animate ? '' : ' no-anim'}"${animate ? ` style="animation-delay:${Math.min(i * 70, 500)}ms"` : ''} data-id="${svc.id}">
      <div class="card-head">
        <div class="icon-box">${iconHtml(svc)}</div>
        <div class="title-wrap">
          <h3><a href="${esc(svc.url)}" target="_blank" rel="noopener noreferrer">${esc(svc.name)}</a></h3>
          <div class="host">${esc(hostOf(svc.url))}</div>
        </div>
      </div>
      <div class="card-hit">
        ${thumb}
        ${desc}
        ${HINT}
      </div>
      <div class="card-foot">
        <div style="display:flex;flex-direction:column;gap:0.25rem">
          <span class="status ${status}"><span class="dot"></span><span class="txt">${statusLabel(status)}</span></span>
          <span class="latency">
            <svg><use href="#i-activity"/></svg>
            <span>${formatLatency(svc.latencyMs)}</span>
          </span>
        </div>
        <div class="card-links">
          ${github}
          <a class="open-link" href="${esc(svc.url)}" target="_blank" rel="noopener noreferrer">
            Open<svg><use href="#i-arrow"/></svg>
          </a>
        </div>
      </div>
    </article>`;
}

export function emptyStateHtml(glyph, message) {
  return `<div class="empty-state"><div class="big">${esc(glyph)}</div>${esc(message)}</div>`;
}

// Grid contents: the cards, or an empty state. Used as the inner HTML of
// `#services` by both the server and the browser.
export function cardsHtml(services, { animate = true } = {}) {
  if (!services.length) return emptyStateHtml('◇', 'No services configured yet.');
  return services.map((s, i) => renderCard(s, i, { animate })).join('');
}

// The stats block. Its values are re-rendered on every poll (the block itself is
// static markup), so it must not carry an entry animation.
export function statsHtml(services, showStats = true) {
  const { total, up, down } = statusCounts(services);
  return `<div class="stats" id="stats"${showStats ? '' : ' hidden'}>
        <div class="stat"><div class="value" id="stat-total">${total}</div><div class="label">Services</div></div>
        <div class="stat"><div class="value ok" id="stat-up">${up}</div><div class="label">Operational</div></div>
        <div class="stat"><div class="value down" id="stat-down">${down}</div><div class="label">Down</div></div>
      </div>`;
}

// Drawer status summary. Only claims "all operational" when every service is
// confirmed up; `state` is a `.status` modifier class (`up`/`down`/`unknown`) so
// the caller never has to write a colour, and the same markup is reused for the
// server-rendered first paint and every poll.
export function liveSummary(services) {
  const { total, up, down } = statusCounts(services);
  const allUp = total > 0 && up === total;
  const degraded = down > 0;
  return {
    text: total === 0 ? 'no services' : allUp ? 'all operational' : degraded ? `${down} down` : 'monitoring',
    state: allUp ? 'up' : degraded ? 'down' : 'unknown',
  };
}
