// Admin panel logic.
import { PAGE_TEXT_FIELDS, changedPageTextFields } from './page-text-config.js?v=62';

const $ = (sel) => document.querySelector(sel);

const ICON = {
  check: '#i-check',
  alert: '#i-alert',
  refresh: '#i-refresh',
  edit: '#i-edit',
  trash: '#i-trash',
};

let toastTimer;

function esc(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toast(message, type = 'success') {
  const t = $('#toast');
  $('#toast-msg').textContent = message;
  $('#toast-icon').innerHTML = `<use href="${ICON[type === 'error' ? 'alert' : 'check']}"/>`;
  t.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// --- Auth -----------------------------------------------------------------

async function checkAuth() {
  try {
    await api('/api/admin/me');
    showPanel();
  } catch {
    showLogin();
  }
}
function showLogin() { $('#login').hidden = false; $('#panel').hidden = true; }
function showPanel() {
  $('#login').hidden = true;
  $('#panel').hidden = false;
  loadSettings();
  loadPageText();
  renderServices();
  loadSnapshots();
  // Email/feedback settings live in feedback.js, which registers this hook. The script
  // order in admin.html guarantees the hook exists by now, but the `?.()` stays as a
  // guard — and loadEmail() self-loads if this ever runs first, so a blank panel can no
  // longer be saved over a working config (see docs/decisions.md D19).
  window.loadEmailSettings?.();
  clearInterval(window.__adminPoll);
  window.__adminPoll = setInterval(pollServices, 60000);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = '';
    showPanel();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  showLogin();
});

// --- Settings -------------------------------------------------------------

async function loadSettings() {
  const { settings } = await api('/api/admin/settings');
  const f = $('#settings-form');
  f.elements.siteTitle.value = settings.siteTitle || '';
  f.elements.homepageTitle.value = settings.homepageTitle || '';
  f.elements.siteUrl.value = settings.siteUrl || '';
  f.elements.siteDescription.value = settings.siteDescription || '';
  f.elements.siteFooter.value = settings.siteFooter || '';
  f.elements.showStats.checked = settings.showStats !== false;
  // The server already rendered the checked accent (it knows the setting before
  // anyone signs in); re-syncing keeps the panel honest if it changed in another tab.
  for (const input of f.querySelectorAll('input[name="accentColor"]')) {
    input.checked = input.value === settings.accentColor;
  }
  applyIcon(settings.hasIcon);
  $('#icon-preview').src = settings.hasIcon ? `/site-icon.png?v=${Date.now()}` : '/favicon.svg';

  // Wallpaper. The selects were server-rendered with the stored values, so this is
  // re-syncing them against a fresh read (and against another tab) rather than
  // populating them from scratch.
  applyWallpaper(settings.hasWallpaper);
  $('#wallpaper-anchor').value = settings.wallpaperAnchor;
  $('#wallpaper-size').value = settings.wallpaperSize;
  $('#wallpaper-transparency').value = String(settings.wallpaperTransparency);
  $('#wallpaper-transparency-value').textContent = `${settings.wallpaperTransparency}%`;
  setBackgroundColor(settings.backgroundColor);
}

// Live preview. The accent is rendered into `<html data-accent="…">` by the server
// and the stylesheet keys every palette off that attribute, so flipping it here shows
// the real thing before saving. This is the accent only — `chrome.js` owns the
// *theme*, which is a per-visitor choice, while the accent is a site setting.
for (const input of document.querySelectorAll('input[name="accentColor"]')) {
  input.addEventListener('change', () => {
    if (input.checked) document.documentElement.dataset.accent = input.value;
  });
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const accent = f.querySelector('input[name="accentColor"]:checked');
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        siteTitle: f.elements.siteTitle.value,
        homepageTitle: f.elements.homepageTitle.value,
        siteUrl: f.elements.siteUrl.value,
        siteDescription: f.elements.siteDescription.value,
        siteFooter: f.elements.siteFooter.value,
        showStats: f.elements.showStats.checked,
        // Only sent when one is selected: an omitted key leaves the stored accent
        // alone (validateSettings skips undefined), so a panel whose radios failed to
        // render cannot quietly reset the site to the default.
        ...(accent ? { accentColor: accent.value } : {}),
        // The wallpaper's placement is a site setting like the accent, so it saves with
        // the same button. The image itself is not here: it is uploaded and deleted on
        // its own, immediately, the way the site icon is.
        wallpaperAnchor: f.elements.wallpaperAnchor.value,
        wallpaperSize: f.elements.wallpaperSize.value,
        wallpaperTransparency: Number(f.elements.wallpaperTransparency.value),
        // An empty string is the "no background colour" state, and sending it is how a
        // colour is cleared — so unlike the accent this key is always present.
        backgroundColor: currentBackgroundColor(),
      }),
    });
    toast('Settings saved');
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

// --- Site icon & favicon upload ------------------------------------------

function applyIcon(hasIcon) {
  const link = $('#favicon-link');
  if (link) {
    link.href = hasIcon ? `/favicon.png?v=${Date.now()}` : '/favicon.svg';
    link.type = hasIcon ? 'image/png' : 'image/svg+xml';
  }

  // Two marks show the uploaded icon: the header brand and the login card. The card
  // is revealed by showLogin() without a page reload, so it has to be updated here
  // too — otherwise it would show whatever icon existed when the page was loaded.
  for (const [img, def, tile] of [
    [$('#brand-icon'), $('#brand-icon-default'), document.querySelector('.brand')],
    [$('#auth-logo'), $('#auth-logo-default'), document.querySelector('.auth-card .logo')],
  ]) {
    if (!img || !def) continue;
    img.hidden = !hasIcon;
    if (hasIcon) img.src = '/site-icon.png';
    // SVGElement does not reflect the `hidden` property — set the attribute.
    if (hasIcon) def.setAttribute('hidden', '');
    else def.removeAttribute('hidden');
    // Drop the default gradient/glow so only the custom image shows.
    tile?.classList.toggle('has-custom-icon', hasIcon);
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read that file'));
    fr.readAsDataURL(file);
  });
}

function loadImage(src, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error('Could not decode that image — try JPEG or PNG'));
    }, timeoutMs);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Unsupported image format — try JPEG or PNG'));
    };
    img.src = src;
  });
}

// Cover-fit the source image into a square canvas, return a PNG data URL.
function drawToSquare(img, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const s = Math.max(size / img.width, size / img.height);
  const w = img.width * s;
  const h = img.height * s;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL('image/png');
}

$('#icon-file').addEventListener('change', async () => {
  const file = $('#icon-file').files[0];
  if (!file) return;
  // Use FileReader -> data: URL (CSP img-src allows data:, not blob:).
  try {
    const dataUrl = await readFileAsDataURL(file);
    const img = await loadImage(dataUrl);
    const payload = { siteIcon: drawToSquare(img, 64), favicon: drawToSquare(img, 32) };
    $('#icon-preview').src = payload.siteIcon;
    await api('/api/admin/icon', { method: 'PUT', body: JSON.stringify(payload) });
    toast('Icon updated');
    loadSettings();
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

$('#icon-reset').addEventListener('click', async () => {
  try {
    await api('/api/admin/icon', { method: 'DELETE' });
    toast('Icon reset to default');
    $('#icon-file').value = '';
    loadSettings();
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

// --- Wallpaper -------------------------------------------------------------

// The wallpaper is the largest image the app stores, so the panel does the resizing
// rather than sending the picked file as it is: the browser has the decoder, and a
// canvas re-encode is what turns a 12-megapixel camera photo into something the JSON
// body limit and the database both want (see MAX_WALLPAPER_BASE64 in src/validate.js).
//
// 1920 wide is the width the bundled photo always had, so an upload looks the same as
// the backdrop the site shipped with. The height follows the image's own ratio: unlike
// the icon and the thumbnail, a wallpaper is *not* cover-cropped to a fixed box, because
// the `Size` select below is what decides how it is fitted — cropping here would make
// `contain` and `natural` meaningless.
const WALLPAPER_MAX_WIDTH = 1920;

// The server's cap (MAX_WALLPAPER_BASE64 in src/validate.js), repeated here because a
// browser module cannot import from `src/` — it would 404 at runtime and kill every
// listener on the page (that is the trap `test/assets.test.js` guards). `test/wallpaper.
// test.js` asserts the two numbers agree, so this copy cannot drift unnoticed.
const MAX_WALLPAPER_BASE64 = 2100000;

// The widths tried in turn until the encoded payload fits the cap. Why a ladder rather
// than one fixed size: PNG has no quality knob — its size is driven by pixel detail, not by
// a setting — so the only lever the panel has is the number of pixels, and the spread is
// enormous. Measured with this panel's own encoder at 1920 wide:
//
//   the bundled photo                 1 926 880 base64 chars   (fits, at full resolution)
//   a synthetic test pattern+noise    7 297 832 base64 chars   (3.5x over)
//
// and the noisy frame only reaches the cap at ~640px. One fixed width would therefore work
// for some photos and silently refuse others, and a refusal happens client-side — the server
// never sees the request, so there is no log entry and nothing to debug from the server side.
//
// The ladder stops at 480 rather than going lower: past that the result is too coarse to read
// as a wallpaper, and "uploaded, but it looks terrible" is a worse outcome than being told
// the image is unsuitable. The caller reports the width it settled on so the admin can see
// what they got instead of discovering it later on the live site.
const WALLPAPER_WIDTH_LADDER = [1920, 1600, 1280, 1024, 800, 640, 480];

// The base64 payload length of a data URL, i.e. the number the server measures. A data
// URL is `data:<type>;base64,<payload>`, so the payload is everything after the comma —
// using `.length` on the whole string instead would count the prefix and refuse a file
// that is actually just under the cap.
function base64Length(dataUrl) {
  return dataUrl.slice(dataUrl.indexOf(',') + 1).length;
}

/**
 * Re-encodes the image as a PNG data URL that fits the server's cap, by stepping down
 * `WALLPAPER_WIDTH_LADDER` until the payload fits `MAX_WALLPAPER_BASE64`.
 *
 * The test is against the cap itself, not a fraction of it: the only reason a client-side
 * limit exists is to give the admin a sentence about the image while it is still selected,
 * instead of a bare 413 from the body parser. The body limit already carries its own headroom
 * for the JSON envelope (see src/server.js), so shrinking this one further would only refuse
 * uploads the server would have accepted — and silently, because a client-side refusal never
 * reaches the server's logs.
 *
 * Returns `{ dataUrl, width }` — the caller reports the width, because for a detailed photo
 * the result can be a good deal narrower than the 1920 an ordinary one gets, and the admin
 * should know that rather than find out from the live site. Returns null if even the
 * narrowest rung is too large; the caller turns that into a message about the image.
 *
 * The image is never upscaled: a source narrower than a rung keeps its own width, so the
 * ladder widens the range of *accepted* files without inflating the bytes of a small one.
 */
function drawWallpaper(img, widths = WALLPAPER_WIDTH_LADDER) {
  for (const maxWidth of widths) {
    const scale = Math.min(1, maxWidth / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // High-quality downscaling: the default is `low`, which aliases visible detail away on
    // a big reduction and makes the result look worse than the bytes it saves.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    // PNG, because that is what the server validates (`isWallpaperDataUrl`), what the seed
    // writes, and what a restore re-validates. The transparency slider fades the wallpaper
    // with CSS opacity rather than alpha in the file, so PNG costs size here and buys the
    // one thing that matters: a single definition of "an image this app will store".
    const dataUrl = canvas.toDataURL('image/png');
    if (base64Length(dataUrl) <= MAX_WALLPAPER_BASE64) return { dataUrl, width: w };
  }
  return null;
}

// The preview and the delete button both depend on whether a wallpaper is active, and
// the live backdrop on this very page has to agree — the admin should see the wallpaper
// land without a reload, exactly as the accent chips do.
function applyWallpaper(hasWallpaper) {
  const img = $('#wallpaper-preview');
  // `src` is removed rather than set to '', deliberately. An empty `src` attribute is not
  // "no image": the browser resolves the empty URL against the document, so the `<img>`
  // re-requests the admin page itself — a wasted request and a broken-image icon flashing
  // before the `empty` class hides it. Removing the attribute means no request at all.
  if (hasWallpaper) img.src = `/wallpaper.jpg?v=${Date.now()}`;
  else img.removeAttribute('src');
  img.classList.toggle('empty', !hasWallpaper);
  $('#wallpaper-delete').hidden = !hasWallpaper;
  $('#wallpaper-hint').textContent = hasWallpaper
    ? 'Resized and re-encoded before upload. Saves as soon as you pick a file.'
    : 'No wallpaper — the background colour below is the whole backdrop. Saves as soon as you pick a file.';
  // `.bg-photo` reads `--wp-image`, which the server writes only while a wallpaper is
  // active; setting or removing it here is what makes the change visible immediately.
  const layer = document.querySelector('.bg-photo');
  if (!layer) return;
  if (hasWallpaper) layer.style.setProperty('--wp-image', `url('/wallpaper.jpg?v=${Date.now()}')`);
  else layer.style.removeProperty('--wp-image');
}

// Live backdrop preview for the placement controls. These are saved by the Save settings
// button below, not on change — but the point of an anchor or a size is what it looks
// like, and the admin is looking at the page it applies to while choosing.
function syncWallpaperPreview() {
  const layer = document.querySelector('.bg-photo');
  if (!layer) return;
  layer.dataset.anchor = $('#wallpaper-anchor').value;
  layer.dataset.size = $('#wallpaper-size').value;
  layer.style.setProperty('--wp-opacity', String((100 - Number($('#wallpaper-transparency').value)) / 100));
  const color = currentBackgroundColor();
  const bgLayer = document.querySelector('.bg-color');
  if (bgLayer) {
    if (color) bgLayer.style.setProperty('--wp-color', color);
    else bgLayer.style.removeProperty('--wp-color');
  }
}

// The colour field's value, or '' when the admin has cleared it. `input[type=color]`
// cannot itself be empty — it always holds a colour — so "no background colour" is a
// separate piece of state, carried on the wrapper and rendered by the output label.
function currentBackgroundColor() {
  const wrap = document.querySelector('.color-input');
  return wrap?.dataset.cleared === '1' ? '' : $('#wallpaper-color').value;
}

function setBackgroundColor(color) {
  const wrap = document.querySelector('.color-input');
  const out = $('#wallpaper-color-value');
  const clear = $('#wallpaper-color-clear');
  if (color) {
    wrap.dataset.cleared = '0';
    $('#wallpaper-color').value = color;
    out.textContent = color;
    clear.hidden = false;
  } else {
    // Default the swatch to the dark theme's own background so reopening the picker
    // offers the colour that is actually on screen, not an arbitrary one.
    wrap.dataset.cleared = '1';
    out.textContent = 'None';
    clear.hidden = true;
  }
  syncWallpaperPreview();
}

$('#wallpaper-file').addEventListener('change', async () => {
  const file = $('#wallpaper-file').files[0];
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataURL(file);
    const img = await loadImage(dataUrl);
    const resized = drawWallpaper(img);
    // `drawWallpaper` steps down a width ladder until the payload fits, so null means even
    // the narrowest rung was over the budget — a real answer about the image rather than a
    // guard that fires on ordinary photos. The check is here as well as on the server so the
    // admin gets a sentence while the file is still selected, instead of a bare 413.
    if (!resized) {
      throw new Error(
        'That image is too detailed to resize into the wallpaper budget — try a smaller file.'
      );
    }
    await api('/api/admin/wallpaper', {
      method: 'PUT',
      body: JSON.stringify({ wallpaper: resized.dataUrl }),
    });
    applyWallpaper(true);
    $('#wallpaper-file').value = '';
    // Say what was stored, not just that something was: a detailed photo can land well
    // below 1920, and this toast is the only place the admin finds that out.
    toast(
      resized.width < img.naturalWidth
        ? `Wallpaper updated (resized to ${resized.width}px wide)`
        : 'Wallpaper updated'
    );
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

// Deleting is one-way and the uploaded image is the only copy, so this confirms like the
// service and credit-line deletes do. Unlike those, the *default* is not recoverable from the
// panel either — the bundled photo is a repository asset, not something the UI can restore —
// so a misclick would leave the site's own background gone until someone re-uploads a file
// they have to find first.
$('#wallpaper-delete').addEventListener('click', async () => {
  if (!confirm('Delete the wallpaper? The uploaded image is not kept anywhere else.')) return;
  try {
    await api('/api/admin/wallpaper', { method: 'DELETE' });
    applyWallpaper(false);
    $('#wallpaper-file').value = '';
    toast('Wallpaper removed');
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

for (const id of ['#wallpaper-anchor', '#wallpaper-size']) {
  $(id).addEventListener('change', syncWallpaperPreview);
}

$('#wallpaper-transparency').addEventListener('input', () => {
  $('#wallpaper-transparency-value').textContent = `${$('#wallpaper-transparency').value}%`;
  syncWallpaperPreview();
});

$('#wallpaper-color').addEventListener('input', () => setBackgroundColor($('#wallpaper-color').value));

$('#wallpaper-color-clear').addEventListener('click', () => setBackgroundColor(''));

// --- Page text & credit lines --------------------------------------------

// The feedback/credits copy and the credits-page list (see docs/decisions.md D22).
//
// The text saves with the form — but only the fields that actually changed (see
// `page-text-config.js` for why a save from a panel that has not loaded would be
// unrecoverable). Each credit line saves when its fields are left, so a row can be edited
// without touching the others, and a drag (or the arrow keys on a focused handle) rewrites
// the whole order in one request.

// The last content the API gave us, or null before the first load.
let storedPageText = null;

async function loadPageText() {
  const { content, credits } = await api('/api/admin/content');
  storedPageText = content;
  const f = $('#page-text-form');
  for (const key of PAGE_TEXT_FIELDS) f.elements[key].value = content[key] || '';
  renderCredits(credits);
}

// The credit list alone. Used by the paths that only touch credit lines, so a failed
// credit save cannot also discard text the admin has typed into the form above.
async function loadCredits() {
  const { content, credits } = await api('/api/admin/content');
  storedPageText = content;
  renderCredits(credits);
}

function renderCredits(credits) {
  $('#credits-empty').hidden = credits.length > 0;
  $('#credits-table-wrap').hidden = credits.length === 0;
  $('#credits-body').innerHTML = credits.map(creditRowHtml).join('');
}

function creditRowHtml(c) {
  return `
      <tr class="credit-row" data-id="${c.id}">
        <td>
          <button type="button" class="drag-handle" draggable="true" data-drag="${c.id}"
                  title="Drag to reorder" aria-label="Reorder ${esc(c.value || 'this credit line')}">
            <svg aria-hidden="true"><use href="#i-grip"/></svg>
          </button>
        </td>
        <td><input class="credit-input credit-role-input" data-field="role" size="10" value="${esc(c.role)}" maxlength="120" placeholder="Built with" aria-label="Description" /></td>
        <td><input class="credit-input" data-field="value" size="10" value="${esc(c.value)}" maxlength="200" placeholder="Node.js" aria-label="Value" /></td>
        <td><input class="credit-input credit-url-input" data-field="url" type="url" size="10" value="${esc(c.url)}" maxlength="500" placeholder="https://…" aria-label="Link" /></td>
        <td class="td-actions">
          <button class="btn small danger" data-delete-credit="${c.id}" title="Delete"><svg><use href="#i-trash"/></svg></button>
        </td>
      </tr>`;
}

function creditValues(row) {
  const out = {};
  for (const input of row.querySelectorAll('[data-field]')) out[input.dataset.field] = input.value;
  return out;
}

$('#page-text-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const values = {};
  for (const key of PAGE_TEXT_FIELDS) values[key] = f.elements[key].value;
  const changed = changedPageTextFields(values, storedPageText);
  if (!Object.keys(changed).length) {
    toast('No changes to save');
    return;
  }
  try {
    const { content } = await api('/api/admin/content', { method: 'PUT', body: JSON.stringify(changed) });
    storedPageText = content;
    for (const key of PAGE_TEXT_FIELDS) f.elements[key].value = content[key] || '';
    toast('Page text saved');
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

// Per-line save. `defaultValue` is the value the row was rendered with, so it doubles as
// "what the server holds" — `change` also fires when a field is left untouched, and
// saving (and toasting) then would be noise.
$('#credits-body').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-field]');
  if (!input) return;
  const row = input.closest('.credit-row');
  const changed = [...row.querySelectorAll('[data-field]')].filter((i) => i.value !== i.defaultValue);
  if (!changed.length) return;
  try {
    await api(`/api/admin/credits/${row.dataset.id}`, {
      method: 'PUT',
      body: JSON.stringify(creditValues(row)),
    });
    for (const i of changed) i.defaultValue = i.value;
    toast('Credit line saved');
  } catch (ex) {
    // Put the stored line back rather than leaving a rejected value on screen.
    toast(ex.message, 'error');
    loadCredits();
  }
});

$('#credits-body').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-delete-credit]');
  if (!del) return;
  if (!confirm('Delete this credit line?')) return;
  try {
    await api(`/api/admin/credits/${del.dataset.deleteCredit}`, { method: 'DELETE' });
    toast('Credit line deleted');
    loadCredits();
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

// A new line is created immediately with placeholder text (the API requires a value),
// then focused so it can be typed over.
$('#add-credit-btn').addEventListener('click', async () => {
  try {
    const { credit } = await api('/api/admin/credits', {
      method: 'POST',
      body: JSON.stringify({ role: '', value: 'New credit', url: '' }),
    });
    await loadCredits();
    const input = document.querySelector(`.credit-row[data-id="${credit.id}"] [data-field="value"]`);
    input?.focus();
    input?.select();
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

// --- Drag to reorder -------------------------------------------------------

/**
 * Turns a table body into a drag-reorderable list. Shared by the credit lines and the
 * services table, which is why it takes the row class rather than assuming one.
 *
 * Only the handle is draggable: a draggable row would fight text selection inside its own
 * inputs and links. `dragover` moves the row live so the admin sees the result before
 * letting go, and `dragend` writes the finished order in one request. Arrow keys on a
 * focused handle do the same move, which keeps reordering reachable without a pointer.
 *
 * Returns `busy()` — true while a drag is in flight or the order is being saved — so a
 * caller that re-renders on a timer can stay out of the way.
 */
function enableDragReorder({ container, rowClass, save }) {
  let dragging = null;
  let saving = false;
  const rowOf = (el) => el.closest(`.${rowClass}`);

  container.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('[data-drag]');
    if (!handle) return;
    dragging = rowOf(handle);
    dragging.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag unless the transfer carries data.
    e.dataTransfer.setData('text/plain', dragging.dataset.id);
  });

  container.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault(); // without this the drop is not allowed and nothing moves
    const row = rowOf(e.target);
    if (!row || row === dragging) return;
    // Above or below the row's midpoint decides which side of it the dragged row lands.
    const box = row.getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    row.parentNode.insertBefore(dragging, after ? row.nextSibling : row);
  });

  container.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('is-dragging');
    dragging = null;
    runSave();
  });

  container.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const handle = e.target.closest('[data-drag]');
    if (!handle) return;
    e.preventDefault(); // the list is short; the arrow keys move the row, not the page
    const row = rowOf(handle);
    const sibling = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;
    if (e.key === 'ArrowUp') row.parentNode.insertBefore(row, sibling);
    else row.parentNode.insertBefore(sibling, row);
    // Moving the focused handle detaches it; keep the keyboard user on the row they moved.
    handle.focus({ preventScroll: true });
    runSave();
  });

  async function runSave() {
    saving = true;
    try {
      await save();
    } finally {
      saving = false;
    }
  }

  return { busy: () => Boolean(dragging) || saving };
}

async function saveCreditOrder() {
  const ids = [...document.querySelectorAll('#credits-body .credit-row')].map((r) => Number(r.dataset.id));
  try {
    await api('/api/admin/credits/order', { method: 'PUT', body: JSON.stringify({ ids }) });
    toast('Credit order saved');
  } catch (ex) {
    // A rejected order (another tab changed the list) is reloaded so the panel shows
    // what the server actually holds instead of a lie.
    toast(ex.message, 'error');
    loadCredits();
  }
}

enableDragReorder({ container: $('#credits-body'), rowClass: 'credit-row', save: saveCreditOrder });

// --- Services -------------------------------------------------------------

// `status` is interpolated into a class attribute — constrain it to the values the
// health checker can produce rather than trusting the column. Mirrors validStatus()
// in render.js; kept local because admin.js is a classic script, not an ES module.
const STATUSES = new Set(['up', 'down', 'unknown']);
const safeStatus = (s) => (STATUSES.has(s) ? s : 'unknown');

function badge(s) {
  const st = safeStatus(s);
  return `<span class="badge ${st}"><span class="dot"></span>${esc(st)}</span>`;
}

// Icon shown in the services table: uploaded image, URL, emoji, or fallback.
function svcIconHtml(s) {
  if (s.iconImage) return `<img class="td-icon" src="/service-icon/${s.id}.png?v=${s.updatedAt || ''}" alt="" />`;
  if (s.icon && s.icon.startsWith('http')) return `<img class="td-icon" src="${esc(s.icon)}" alt="" />`;
  if (s.icon) return `<span class="td-icon-emoji">${esc(s.icon)}</span>`;
  return '<span class="td-icon-emoji">◆</span>';
}

// Service-form icon state: null (none) | '__keep__' (existing, unchanged) | PNG data URL.
const SVC_ICON_KEEP = '__keep__';
let pendingSvcIcon = null;

function setSvcIconPreview(state, serviceId) {
  const preview = $('#svc-icon-preview');
  const remove = $('#svc-icon-remove');
  if (state === SVC_ICON_KEEP) {
    preview.src = `/service-icon/${serviceId}.png?v=${Date.now()}`;
    remove.hidden = false;
  } else if (state) {
    preview.src = state;
    remove.hidden = false;
  } else {
    preview.src = '/favicon.svg';
    remove.hidden = true;
  }
}

// Service-form thumbnail state: null (none) | '__keep__' (existing) | PNG data URL.
const SVC_THUMB_KEEP = '__keep__';
let pendingSvcThumb = null;

function setSvcThumbPreview(state, serviceId) {
  const preview = $('#svc-thumb-preview');
  const remove = $('#svc-thumb-remove');
  if (state === SVC_THUMB_KEEP) {
    preview.src = `/service-thumb/${serviceId}.png?v=${Date.now()}`;
    remove.hidden = false;
  } else if (state) {
    preview.src = state;
    remove.hidden = false;
  } else {
    preview.src = '/favicon.svg';
    remove.hidden = true;
  }
}

const servicesDrag = enableDragReorder({
  container: $('#services-body'),
  rowClass: 'service-row',
  save: saveServiceOrder,
});

/**
 * The 60s poll's reload, and only the poll's: it must not rebuild the table while the admin
 * is dragging a row or while an order save is in flight — the DOM holds the order that save is
 * writing, so a rebuild would show the old one.
 *
 * Every *user action* uses `renderServices()` instead. A user cannot be mid-drag while they
 * click Delete, and holding those reloads back would leave a deleted row on screen until the
 * next poll (or make a fresh add look like it failed).
 */
async function pollServices() {
  if (servicesDrag.busy()) return;
  await renderServices();
}

// The raw reload: fetch and repaint. Also the way a rejected order is replaced by what the
// server actually holds.
async function renderServices() {
  const { services } = await api('/api/admin/services');
  const body = $('#services-body');
  $('#services-empty').hidden = services.length > 0;
  body.innerHTML = services
    .map((s) => `
      <tr class="service-row" data-id="${s.id}">
        <td>
          <button type="button" class="drag-handle" draggable="true" data-drag="${s.id}"
                  title="Drag to reorder" aria-label="Reorder ${esc(s.name)}">
            <svg aria-hidden="true"><use href="#i-grip"/></svg>
          </button>
        </td>
        <td class="td-name">${svcIconHtml(s)}${esc(s.name)}</td>
        <td><a class="td-url" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.url)}">${esc(s.url)}</a></td>
        <td>${badge(s.status)}</td>
        <td>${s.enabled ? 'Yes' : 'No'}</td>
        <td class="td-actions">
          <button class="btn small ghost" data-edit="${s.id}" title="Edit"><svg><use href="#i-edit"/></svg></button>
          <button class="btn small danger" data-delete="${s.id}" title="Delete"><svg><use href="#i-trash"/></svg></button>
        </td>
      </tr>`)
    .join('');
}

// The order the homepage lists services in (see D23). The DOM already holds the new order,
// so a success needs no reload — and a poll that lands mid-save is held off by busy().
async function saveServiceOrder() {
  const ids = [...document.querySelectorAll('#services-body .service-row')].map((r) => Number(r.dataset.id));
  try {
    await api('/api/admin/services/order', { method: 'PUT', body: JSON.stringify({ ids }) });
    toast('Service order saved');
  } catch (ex) {
    toast(ex.message, 'error');
    await renderServices();
  }
}

$('#add-service-btn').addEventListener('click', () => resetServiceForm(true));

$('#services-body').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-delete]');
  if (edit) {
    const { services } = await api('/api/admin/services');
    const s = services.find((x) => x.id === Number(edit.dataset.edit));
    if (s) fillServiceForm(s);
  } else if (del) {
    const id = del.dataset.delete;
    if (!confirm('Delete this service?')) return;
    try {
      await api(`/api/admin/services/${id}`, { method: 'DELETE' });
      toast('Service deleted');
      renderServices();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  }
});

function fillServiceForm(s) {
  const f = $('#service-form');
  f.elements.id.value = s.id;
  f.elements.name.value = s.name;
  f.elements.url.value = s.url;
  f.elements.githubRepo.value = s.githubRepo || '';
  f.elements.description.value = s.description || '';
  f.elements.techStack.value = (s.techStack || '').split('|').filter(Boolean).join(', ');
  f.elements.aiDetails.value = s.aiDetails || '';
  f.elements.story.value = s.story || '';
  f.elements.audience.value = s.audience || '';
  f.elements.enabled.checked = s.enabled;
  pendingSvcIcon = s.iconImage ? SVC_ICON_KEEP : null;
  setSvcIconPreview(pendingSvcIcon, s.id);
  pendingSvcThumb = s.thumbnailImage ? SVC_THUMB_KEEP : null;
  setSvcThumbPreview(pendingSvcThumb, s.id);
  $('#service-form-title').innerHTML = `<svg><use href="#i-edit"/></svg>Edit service`;
  $('#service-submit').innerHTML = `<svg><use href="#i-check"/></svg>Save changes`;
  $('#service-cancel').hidden = false;
  $('#service-panel').hidden = false;
  $('#service-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetServiceForm(open) {
  const f = $('#service-form');
  f.reset();
  f.elements.id.value = '';
  f.elements.enabled.checked = true;
  pendingSvcIcon = null;
  $('#svc-icon-file').value = '';
  setSvcIconPreview(null);
  pendingSvcThumb = null;
  $('#svc-thumb-file').value = '';
  setSvcThumbPreview(null);
  $('#service-form-title').innerHTML = `<svg><use href="#i-plus"/></svg>Add service`;
  $('#service-submit').innerHTML = `<svg><use href="#i-check"/></svg>Add service`;
  $('#service-cancel').hidden = true;
  $('#service-panel').hidden = !open;
  if (open) $('#service-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#service-cancel').addEventListener('click', () => resetServiceForm(false));

// Service icon upload: auto-resizes and auto-saves for existing services
// (like the site icon); for a new service it's staged and saved on create.
$('#svc-icon-file').addEventListener('change', async () => {
  const file = $('#svc-icon-file').files[0];
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataURL(file);
    const img = await loadImage(dataUrl);
    const resized = drawToSquare(img, 64);
    setSvcIconPreview(resized);
    const id = $('#service-form').elements.id.value;
    if (id) {
      await api(`/api/admin/services/${id}/icon`, {
        method: 'PUT',
        body: JSON.stringify({ iconImage: resized }),
      });
      pendingSvcIcon = SVC_ICON_KEEP;
      toast('Service icon updated');
      renderServices();
    } else {
      pendingSvcIcon = resized;
      toast('Icon set — saved with the service when you create it');
    }
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

$('#svc-icon-remove').addEventListener('click', async () => {
  const id = $('#service-form').elements.id.value;
  setSvcIconPreview(null);
  $('#svc-icon-file').value = '';
  if (id) {
    try {
      await api(`/api/admin/services/${id}/icon`, {
        method: 'PUT',
        body: JSON.stringify({ iconImage: null }),
      });
      pendingSvcIcon = SVC_ICON_KEEP;
      toast('Service icon removed');
      renderServices();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  } else {
    pendingSvcIcon = null;
  }
});

// --- Thumbnail -------------------------------------------------------------

// Cover-fit the source image into a 16:9 canvas, return a PNG data URL.
function drawToRatio(img, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return canvas.toDataURL('image/png');
}

// Capture a screenshot of the service URL via the screenshot service.
$('#svc-thumb-capture').addEventListener('click', async () => {
  const id = $('#service-form').elements.id.value;
  if (!id) {
    toast('Save the service first, then capture its thumbnail', 'error');
    return;
  }
  const btn = $('#svc-thumb-capture');
  btn.disabled = true;
  btn.textContent = 'Capturing…';
  try {
    await api(`/api/admin/services/${id}/thumbnail/capture`, { method: 'POST' });
    pendingSvcThumb = SVC_THUMB_KEEP;
    setSvcThumbPreview(SVC_THUMB_KEEP, id);
    toast('Thumbnail captured');
    renderServices();
  } catch (ex) {
    toast(ex.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Capture from URL';
  }
});

// Manual thumbnail upload: auto-resizes to 640x360 (16:9) and auto-saves.
$('#svc-thumb-file').addEventListener('change', async () => {
  const file = $('#svc-thumb-file').files[0];
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataURL(file);
    const img = await loadImage(dataUrl);
    const resized = drawToRatio(img, 640, 360);
    setSvcThumbPreview(resized);
    const id = $('#service-form').elements.id.value;
    if (id) {
      await api(`/api/admin/services/${id}/thumbnail`, {
        method: 'PUT',
        body: JSON.stringify({ thumbnailImage: resized }),
      });
      pendingSvcThumb = SVC_THUMB_KEEP;
      toast('Thumbnail updated');
      renderServices();
    } else {
      pendingSvcThumb = resized;
      toast('Thumbnail set — saved with the service when you create it');
    }
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

$('#svc-thumb-remove').addEventListener('click', async () => {
  const id = $('#service-form').elements.id.value;
  setSvcThumbPreview(null);
  $('#svc-thumb-file').value = '';
  if (id) {
    try {
      await api(`/api/admin/services/${id}/thumbnail`, {
        method: 'PUT',
        body: JSON.stringify({ thumbnailImage: null }),
      });
      pendingSvcThumb = SVC_THUMB_KEEP;
      toast('Thumbnail removed');
      renderServices();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  } else {
    pendingSvcThumb = null;
  }
});

$('#service-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const id = f.elements.id.value;
  const payload = {
    name: f.elements.name.value,
    url: f.elements.url.value,
    githubRepo: f.elements.githubRepo.value,
    description: f.elements.description.value,
    techStack: f.elements.techStack.value,
    aiDetails: f.elements.aiDetails.value,
    story: f.elements.story.value,
    audience: f.elements.audience.value,
    // No sortOrder: the order is set by dragging in the table (D23). Omitting it appends a
    // new service and leaves an existing one where it is.
    enabled: f.elements.enabled.checked,
  };
  const iconImage = pendingSvcIcon === SVC_ICON_KEEP ? undefined : pendingSvcIcon;
  if (iconImage !== undefined) payload.iconImage = iconImage;
  try {
    if (id) {
      await api(`/api/admin/services/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Service updated');
    } else {
      await api('/api/admin/services', { method: 'POST', body: JSON.stringify(payload) });
      toast('Service added');
    }
    resetServiceForm(false);
    renderServices();
  } catch (ex) {
    toast(ex.message, 'error');
  }
});

$('#refresh-status').addEventListener('click', () => {
  toast('Refreshed. Server checks statuses every 60s.');
  renderServices();
});

// --- Backup & restore ------------------------------------------------------

// See docs/decisions.md D25.
//
// The flow is two steps inside one dialog, and the order is the point: the file is uploaded
// and validated *before* the admin is shown what it contains. What they approve is therefore
// the archive the server holds, not a client-side reading of it — and the apply request
// names that staged upload by id instead of sending the archive back, so a tampered request
// can only choose which categories to write, never what goes into them.

const APPLIED_LABELS = {
  settings: 'site settings',
  pageText: 'page text',
  artwork: 'the site icon',
  wallpaper: 'the wallpaper',
  email: 'email settings',
  services: 'services',
  credits: 'credit lines',
};

const restoreModal = $('#restore-modal');
// `{ uploadId }` for the archive the server has validated and is holding for us.
let stagedUpload = null;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatWhen(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toLocaleString();
}

// The filename is decided by the server (it is the one that knows the timestamp) and the
// header is the only place it appears, so the client reads it back rather than inventing a
// second naming rule that could drift.
function filenameFromDisposition(header) {
  const m = /filename="([^"]+)"/.exec(header || '');
  return m ? m[1] : '';
}

/**
 * Downloads through fetch rather than by navigating to the URL, so a failure is a toast
 * instead of a page full of JSON error. The blob is revoked on the next tick — long enough
 * for the click to be handled, short enough not to hold the archive in memory.
 */
async function downloadArchive(url, fallbackName) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Download failed (${res.status})`);
    }
    const objectUrl = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filenameFromDisposition(res.headers.get('Content-Disposition')) || fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    toast('Backup downloaded');
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

$('#backup-download').addEventListener('click', () => downloadArchive('/api/admin/backup', 'vibefolio-backup.json.gz'));
$('#restore-download-first').addEventListener('click', () =>
  downloadArchive('/api/admin/backup', 'vibefolio-backup.json.gz')
);

async function loadSnapshots() {
  try {
    const { snapshots } = await api('/api/admin/backup/snapshots');
    $('#snapshots-wrap').hidden = snapshots.length === 0;
    $('#snapshot-list').innerHTML = snapshots
      .map(
        (s) => `
        <li>
          <span class="snapshot-name">${esc(s.name)}</span>
          <span class="snapshot-meta">${esc(formatWhen(s.createdAt))} · ${esc(formatBytes(s.size))}</span>
          <a class="btn small ghost" href="/api/admin/backup/snapshots/${encodeURIComponent(s.name)}" download>Download</a>
        </li>`
      )
      .join('');
  } catch {
    // Informational only: an empty list is the same as a failed one for the admin's purpose
    // here, and a dashboard that refuses to render because a listing failed is worse.
    $('#snapshots-wrap').hidden = true;
  }
}

// --- The restore wizard ----------------------------------------------------

$('#restore-open').addEventListener('click', () => {
  resetRestoreModal();
  restoreModal.showModal();
});

// Escape and the backdrop close a native <dialog> too, so the cleanup hangs off `close`
// rather than off each button.
restoreModal.addEventListener('close', discardStagedUpload);
$('#restore-close').addEventListener('click', () => restoreModal.close());
$('#restore-cancel').addEventListener('click', () => restoreModal.close());
$('#restore-back').addEventListener('click', () => showRestoreStep(1));

function resetRestoreModal() {
  stagedUpload = null;
  $('#restore-confirm').checked = false;
  $('#restore-file').value = '';
  $('#restore-error').hidden = true;
  $('#restore-error-2').hidden = true;
  showRestoreStep(1);
  syncRestoreControls();
}

function showRestoreStep(step) {
  $('#restore-step-1').hidden = step !== 1;
  $('#restore-step-2').hidden = step !== 2;
}

// The confirmation and the file are both required before the upload is worth sending —
// which is the modal's whole purpose: the destructive part cannot be reached by muscle
// memory alone.
function syncRestoreControls() {
  const ready = $('#restore-confirm').checked && $('#restore-file').files.length > 0;
  $('#restore-verify').disabled = !ready;
  $('#restore-file-hint').hidden = ready;
}

$('#restore-confirm').addEventListener('change', syncRestoreControls);
$('#restore-file').addEventListener('change', syncRestoreControls);

function discardStagedUpload() {
  if (!stagedUpload) return;
  const { uploadId } = stagedUpload;
  stagedUpload = null;
  api('/api/admin/restore/discard', { method: 'POST', body: JSON.stringify({ uploadId }) }).catch(() => {});
}

$('#restore-verify').addEventListener('click', async () => {
  const file = $('#restore-file').files[0];
  if (!file) return;

  const err = $('#restore-error');
  err.hidden = true;
  const btn = $('#restore-verify');
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    // The File is the body, so no multipart encoder is needed to move it. The explicit
    // content type is what `express.raw` on the server is registered for.
    const res = await fetch('/api/admin/restore/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    stagedUpload = { uploadId: data.uploadId };
    renderArchiveOverview(data.archive);
    showRestoreStep(2);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.textContent = 'Verify archive';
    syncRestoreControls();
  }
});

function renderArchiveOverview(archive) {
  const app = archive.app || {};
  $('#archive-meta').innerHTML = `
    <div><dt>Created</dt><dd>${esc(formatWhen(archive.createdAt))}</dd></div>
    <div><dt>Written by</dt><dd>${esc([app.name, app.release].filter(Boolean).join(' ') || 'an unknown build')}</dd></div>
    <div><dt>Size</dt><dd>${esc(formatBytes(archive.size))}</dd></div>`;

  // The categories come from the server, which owns the list; the panel does not carry a
  // second copy that could fall out of step with it.
  //
  // `c.clears` is the one field that is about the *current* site rather than the archive: the
  // server sets it when restoring this category would remove something that is live now (an
  // archive from before the wallpaper existed restores an empty wallpaper category, which
  // deletes the deployed one). It is rendered as a warning rather than used to untick the box
  // — the admin is entitled to restore everything, and the choice should be theirs.
  $('#category-list').innerHTML = archive.categories
    .map(
      (c) => `
      <label class="category-opt">
        <input type="checkbox" value="${esc(c.id)}" checked />
        <span class="category-text">
          <span class="category-label">${esc(c.label)}<span class="category-count">${c.count} ${esc(c.unit)}</span></span>
          <span class="category-hint">${esc(c.hint)}${c.detail ? ` — ${esc(c.detail)}` : ''}</span>
          ${c.clears ? `<span class="category-warn">${esc(c.clears)} will be removed — this archive has none.</span>` : ''}
        </span>
      </label>`
    )
    .join('');
}

$('#restore-apply').addEventListener('click', async () => {
  const err = $('#restore-error-2');
  err.hidden = true;
  const categories = [...document.querySelectorAll('#category-list input[type="checkbox"]:checked')].map(
    (input) => input.value
  );
  if (!categories.length) {
    err.textContent = 'Select at least one category to restore.';
    err.hidden = false;
    return;
  }
  if (!stagedUpload) {
    err.textContent = 'That upload has expired — close this and choose the file again.';
    err.hidden = false;
    return;
  }

  const btn = $('#restore-apply');
  btn.disabled = true;
  btn.textContent = 'Restoring…';
  try {
    const { applied, cleared, snapshot } = await api('/api/admin/restore/apply', {
      method: 'POST',
      body: JSON.stringify({ uploadId: stagedUpload.uploadId, categories }),
    });
    // Cleared before closing: the upload is spent, and the close handler would otherwise
    // send a discard for an id the server has already dropped.
    stagedUpload = null;
    restoreModal.close();
    const what = Object.keys(applied).map((key) => APPLIED_LABELS[key] || key).join(', ');
    const snapshotNote = snapshot ? ' The previous state was saved as a snapshot.' : '';
    // `cleared` is the server's answer to "what did this remove", re-evaluated at apply time —
    // so if the modal's overview was drawn before the state changed (a wallpaper uploaded in
    // another tab while it sat open), the admin still finds out. Error-styled on purpose: a
    // restore that quietly removed the background image is worth interrupting for.
    //
    // When something was cleared, that is the whole message — the removal subsumes the restore
    // that caused it, and naming both produces "Restored the wallpaper — removing the
    // wallpaper", which reads like a bug. The admin needs to know what is *gone*; that the
    // category was also written is implied.
    toast(
      cleared?.length
        ? `Restore removed ${cleared.join(' and ')}.${snapshotNote}`
        : `Restored ${what}.${snapshotNote}`,
      cleared?.length ? 'error' : 'success'
    );
    await refreshAfterRestore();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Restore selected';
  }
});

/**
 * Re-reads every panel a restore could have changed.
 *
 * Deliberately not `location.reload()`: that would throw away the toast saying what
 * happened, which is the only confirmation the admin gets. The accent is applied exactly
 * the way the picker's live preview applies it, since it is rendered into
 * `<html data-accent>` by the server and the stylesheet keys every palette off it.
 */
async function refreshAfterRestore() {
  await loadSettings();
  await loadPageText();
  await renderServices();
  window.loadEmailSettings?.();
  await loadSnapshots();
  const accent = document.querySelector('input[name="accentColor"]:checked');
  if (accent) document.documentElement.dataset.accent = accent.value;
}

// --- Init -----------------------------------------------------------------

checkAuth();
