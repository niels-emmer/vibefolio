/**
 * Server-renders the pages from `src/views/*.html`, which are templates with
 * `{{TOKEN}}` placeholders.
 *
 * Why: the page used to be a static shell with placeholder copy ("example.com
 * Services", "Public services running on example.com.") that `public/js/app.js`
 * overwrote after two API round trips — visitors saw the wrong title, subtitle,
 * favicon and logo for as long as that took. Rendering the real values into the
 * first byte removes that flash; app.js still polls every 60s for live status.
 *
 * The templates live outside `public/` so they can never be served as a static
 * file with their placeholders showing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as view from '../public/js/render.js';
import { ASSET_VERSION } from './asset-version.js';
import { APP_NAME, releaseDateLabel } from './version.js';
import { feedbackEnabled, pageText, listPublicCredits } from './public-data.js';
import { issueToken } from './feedback-token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewsDir = path.join(__dirname, 'views');

// Tokens whose value is markup, already escaped field-by-field by the shared
// view module. Every other token is escaped here.
const HTML_TOKENS = new Set(['BRAND', 'FAVICON', 'STATS', 'CARDS', 'FOOTER', 'MENU_TOGGLE', 'DRAWER', 'AUTH_LOGO', 'ACCENT_OPTIONS', 'WALLPAPER_PREVIEW', 'FEEDBACK_SUBTITLE', 'FEEDBACK_INTRO', 'CREDITS_SUBTITLE', 'CREDITS_LIST', 'CREDITS_NOTE', 'BACKGROUND', 'WALLPAPER_ANCHOR_OPTIONS', 'WALLPAPER_SIZE_OPTIONS']);

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    // Fail loudly rather than shipping a literal "{{TOKEN}}" to the browser.
    if (!(key in values)) throw new Error(`Unknown template token: {{${key}}}`);
    return HTML_TOKENS.has(key) ? values[key] : view.esc(values[key]);
  });
}

// Read per request: a view is a few KB and this keeps edits to it live without a
// restart.
function readView(name) {
  return fs.readFileSync(path.join(viewsDir, name), 'utf8');
}

// Common tokens every page needs: the favicon/brand, and the fold-out menu.
//
// `services` is passed on every page (not just the homepage) so the drawer's
// status counts are server-rendered everywhere and the credits page can stay
// free of any fetch. `theme` comes from the visitor's cookie so the palette is
// correct in the first byte (see D15).
function chromeTokens(settings, services, theme, brandLabel, feedbackOn) {
  return {
    FAVICON: view.faviconTag(settings.hasIcon),
    BRAND: view.brandHtml(settings.siteTitle || 'vibefolio', settings.hasIcon, brandLabel),
    AUTH_LOGO: view.authLogoHtml(settings.hasIcon),
    MENU_TOGGLE: view.menuToggleHtml(),
    // The backdrop layers (background colour, wallpaper, readability wash) are rendered
    // from the settings on every page, like the accent — they are a site setting, not a
    // per-visitor cookie, so they belong in the first byte (see D26).
    BACKGROUND: view.backgroundHtml(settings),
    DRAWER: view.drawerHtml({
      services,
      theme,
      appName: APP_NAME,
      releaseDate: releaseDateLabel(),
      feedbackEnabled: feedbackOn,
    }),
    THEME: theme,
    THEME_COLOR: view.THEME_COLORS[theme],
    // The site-wide accent, from the settings (not a cookie): it is the same for
    // every visitor, so it is rendered into `<html data-accent="…">` alongside the
    // theme and is correct in the first byte (see D21).
    ACCENT: view.normalizeAccent(settings.accentColor),
    ASSET_VERSION: ASSET_VERSION,
  };
}

export function renderHomePage(settings, services, theme) {
  return fill(readView('home.html'), {
    ...chromeTokens(settings, services, theme, undefined, feedbackEnabled()),
    TITLE: view.pageTitle(settings),
    META_DESCRIPTION: view.metaDescription(settings),
    OG_TITLE: settings.siteTitle || 'vibefolio',
    SITE_TITLE: settings.homepageTitle || settings.siteTitle || 'Services',
    SITE_DESCRIPTION: settings.siteDescription || '',
    STATS: view.statsHtml(services, settings.showStats !== false),
    CARDS: view.cardsHtml(services, { animate: true }),
    FOOTER: view.footerHtml(settings.siteFooter),
  });
}

// The credits page: the same chrome as every other page, plus the editable page copy
// (subtitle, credit lines, bottom note) read from the database — see D22. Rendering it
// here rather than in a static template is what makes it editable from the admin panel
// without a rebuild.
//
// The favicon and brand logo depend on the uploaded site icon, so they are rendered
// here too, keeping the page in step with the homepage instead of swapping them in
// after a fetch (which used to be visible as a flash on both pages). It also carries the
// menu, so the status counts are rendered server-side like everywhere else.
export function renderCreditsPage(settings, services, theme) {
  const content = pageText();
  return fill(readView('credits.html'), {
    ...chromeTokens(settings, services, theme, undefined, feedbackEnabled()),
    CREDITS_SUBTITLE: view.pageSubtitleHtml(content.creditsSubtitle),
    CREDITS_LIST: view.creditsHtml(listPublicCredits()),
    CREDITS_NOTE: view.renderParagraphs(content.creditsNote, 'credits-note'),
    // The configured footer text, same as every other page. This page previously rendered
    // an empty footer containing only the Credits/Feedback links, so it showed no footer
    // text at all even when one was configured.
    FOOTER: view.footerHtml(settings.siteFooter),
  });
}

// The admin page is login-gated so its content is static, but its favicon and
// brand logo are settings-dependent in exactly the same way. Rendered with the
// same tokens; `admin.js` re-applies them live when the icon is re-uploaded.
export function renderAdminPage(settings, services, theme) {
  return fill(readView('admin.html'), {
    ...chromeTokens(settings, services, theme, 'Admin', feedbackEnabled()),
    // The accent picker's options (with the current one pre-checked) are rendered
    // server-side like the theme selector, so the panel is never briefly blank and
    // the checked state cannot disagree with `<html data-accent>`.
    ACCENT_OPTIONS: view.accentOptionsHtml(view.normalizeAccent(settings.accentColor)),
    // The wallpaper preview's initial state, so the panel does not re-request `/admin`
    // through an empty `src` before `admin.js` fills it in.
    WALLPAPER_PREVIEW: view.wallpaperPreviewAttr(settings.hasWallpaper, ASSET_VERSION),
    // The wallpaper selects get the same treatment for the same reason: the panel is
    // correct before any script runs, and the selected option cannot disagree with what
    // the backdrop on this very page is already doing.
    WALLPAPER_ANCHOR_OPTIONS: view.wallpaperOptionsHtml('anchor', view.normalizeWallpaperAnchor(settings.wallpaperAnchor)),
    WALLPAPER_SIZE_OPTIONS: view.wallpaperOptionsHtml('size', view.normalizeWallpaperSize(settings.wallpaperSize)),
  });
}

// The feedback page. Same chrome as the rest of the site, the editable page copy
// (subtitle + intro paragraphs, see D22), plus a one-time form token rendered into the
// markup so the form does not need a round trip before it can be used (and still submits
// safely if that request would have failed).
export function renderFeedbackPage(settings, services, theme) {
  const content = pageText();
  return fill(readView('feedback.html'), {
    ...chromeTokens(settings, services, theme, undefined, true),
    TITLE: `Feedback — ${settings.siteTitle || 'vibefolio'}`,
    META_DESCRIPTION: 'Send a note, a bug report or an idea to the person who runs this site.',
    SITE_TITLE: settings.homepageTitle || settings.siteTitle || 'vibefolio',
    FEEDBACK_SUBTITLE: view.pageSubtitleHtml(content.feedbackSubtitle),
    FEEDBACK_INTRO: view.renderParagraphs(content.feedbackIntro, 'form-intro'),
    FORM_TOKEN: issueToken(),
      FOOTER: view.footerHtml(settings.siteFooter),
  });
}
