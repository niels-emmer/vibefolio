// The fold-out menu — behaviour only.
//
// The drawer's markup (and every value in it) is server-rendered by
// `src/render-page.js` → `menuToggleHtml()` / `drawerHtml()` in
// `public/js/render.js`, so this module never builds HTML and never fetches
// service data: it opens and closes the drawer, applies the theme, and labels
// the admin entry point.
//
// Deliberately dependency-free. Importing `render.js` here would mean a second
// hand-written `?v=` cache-buster (a static file cannot use the `{{ASSET_VERSION}}`
// template token), which is exactly the drift `test/assets.test.js` exists to
// prevent. The one shared value it needs — the theme colour for
// `<meta name="theme-color">` — is read from the stylesheet instead.
//
// Loaded by all three pages (home, credits, admin).

const $ = (sel) => document.querySelector(sel);

const drawer = $('#drawer');
const toggle = $('#menu-toggle');
const backdrop = $('#drawer-backdrop');
const closeBtn = $('#drawer-close');

// The drawer is server-rendered on every page, but a missing element must not
// throw: a module that dies on its first line silently kills every listener in
// the file (see D13 — that is how a broken import shipped once already).
if (drawer && toggle) {
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const isOpen = () => drawer.classList.contains('open');
  let lastFocused = null;

  function open() {
    lastFocused = document.activeElement;
    drawer.removeAttribute('inert');
    drawer.classList.add('open');
    backdrop.classList.add('open');
    // Locks the page behind the drawer. `html { scrollbar-gutter: stable }` keeps
    // the scrollbar's space reserved so hiding it cannot shift the layout.
    document.body.classList.add('menu-open');
    toggle.setAttribute('aria-expanded', 'true');

    // Focus lands in the panel straight away — no frame deferral needed, because
    // the closed drawer is hidden with `transform` rather than `visibility`
    // (see the note on `.drawer` in style.css; a visibility gate would make this
    // call silently no-op on the first open).
    closeBtn.focus();

    refreshAdminLabel();
  }

  function close() {
    // Inert first: the drawer is off-screen from here on and must leave the tab
    // order and the accessibility tree immediately, not after the transition.
    drawer.setAttribute('inert', '');
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
    document.body.classList.remove('menu-open');
    toggle.setAttribute('aria-expanded', 'false');
    // Hand focus back to the trigger, per the dialog pattern. Falls back to the
    // toggle when the recorded element is <body> (a synthetic click never focuses
    // the button) or has since been removed from the document.
    const target = lastFocused?.isConnected && lastFocused !== document.body ? lastFocused : toggle;
    target.focus();
  }

  toggle.addEventListener('click', () => (isOpen() ? close() : open()));
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);

  // Escape closes from anywhere (including the theme radios inside the drawer).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  });

  // Keep Tab inside the drawer while it is open. A native <dialog> would give
  // this for free, but a dialog's ::backdrop and modal handling fight the
  // slide-in panel, and the drawer has to work without the top-layer promotion.
  drawer.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...drawer.querySelectorAll(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

// --- Theme -----------------------------------------------------------------
//
// The palette itself is rendered server-side into `<html data-theme="…">` from a
// cookie, so there is no flash on load and no script is needed to apply it. All
// this does is flip the attribute, persist the choice, and keep the browser
// chrome colour in step.

const themeInputs = [...document.querySelectorAll('input[name="theme"]')];

// Read the colour from the stylesheet rather than duplicating the palette here:
// the computed value already resolves `system` through prefers-color-scheme.
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) meta.content = bg;
}

function setTheme(name) {
  document.documentElement.dataset.theme = name;

  // Non-httpOnly by design: it is a display preference, not a credential. Lax
  // stops it being sent on cross-site requests; Secure is added on https so the
  // cookie cannot be rewritten in transit (a downgrade to plain http would).
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `theme=${name}; path=/; max-age=31536000; SameSite=Lax${secure}`;

  syncThemeColor();
}

for (const input of themeInputs) {
  input.addEventListener('change', () => {
    if (input.checked) setTheme(input.value);
  });
}

// `system` is resolved by CSS, not by the server, which can only render the dark
// fallback — so a visitor whose OS prefers light would otherwise keep a dark
// browser-chrome bar until they happened to touch the selector. Sync once on load,
// and again if the OS preference changes while the page is open (the palette
// itself already follows, via the media query in style.css).
syncThemeColor();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', syncThemeColor);

// --- Admin entry point -----------------------------------------------------

// The drawer item reads "Admin logon" until we know better. Checked when the
// drawer opens (not on load) so an anonymous visitor never pays for the request,
// and re-checked each time so signing in or out is reflected without a reload.
async function refreshAdminLabel() {
  const label = $('#drawer-admin-label');
  if (!label) return;
  try {
    const res = await fetch('/api/admin/me');
    const me = res.ok ? await res.json() : null;
    label.textContent = me?.authenticated ? 'Dashboard' : 'Admin logon';
  } catch {
    // Offline or blocked: leave the label as rendered rather than guessing.
  }
}
