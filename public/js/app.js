// Public showcase page — renders services with live status.
//
// The server renders the first paint (`src/render-page.js`); this module keeps
// the page live by re-fetching on the same cadence as the server health checker.
// Markup comes from public/js/render.js so both sides stay identical.
import {
  esc,
  renderParagraphs,
  hostOf,
  statusLabel,
  formatLatency,
  validStatus,
  AUDIENCE_LABELS,
  pageTitle,
  iconHtml,
  cardsHtml,
  statsHtml,
  emptyStateHtml,
  liveSummary,
  statusCounts,
  normalizeAccent,
} from './render.js?v=62';

const $ = (sel) => document.querySelector(sel);

// Latest service list, kept for the detail dialog (re-rendered every poll).
let services = [];

async function load() {
  const grid = $('#services');
  try {
    const [siteRes, svcRes] = await Promise.all([
      fetch('/api/site'),
      fetch('/api/services'),
    ]);
    const site = await siteRes.json();
    const { services: svcList } = await svcRes.json();
    services = svcList;

    applyIcon(site.hasIcon);
    // The accent is a site setting, so a poll picks up an admin's change the same way
    // it picks up the title. The server rendered it into the first byte; this only
    // keeps a page that is already open in step.
    document.documentElement.dataset.accent = normalizeAccent(site.accentColor);

    document.title = pageTitle(site);
    $('#brand-title').textContent = site.siteTitle || 'vibefolio';
    $('#site-title').textContent = site.homepageTitle || site.siteTitle || 'Services';
    $('#site-description').textContent = site.siteDescription || '';

    // The footer element only exists when the admin set footer text.
    const footerText = $('#site-footer');
    if (footerText) footerText.textContent = site.siteFooter || '';
    const footerEl = document.querySelector('.site-footer');
    if (footerEl) footerEl.style.display = site.siteFooter ? '' : 'none';

    renderGrid(grid, services);
    applyLiveStatus(services, site.showStats !== false);
    attachImageFallbacks(grid);
  } catch (err) {
    console.error(err);
    // A transient failure must never destroy good markup. The grid already holds
    // real cards (server-rendered, or from a previous successful poll), so prefer
    // showing slightly stale content for a minute over flashing an error state at
    // a visitor. The message is only appropriate when there is nothing to show.
    const hasCards = grid.querySelector('.service-card');
    if (!hasCards) {
      grid.innerHTML = emptyStateHtml('⚠', 'Failed to load services. Please refresh.');
    }
  }
}

// Render the grid. The server already painted it, so the first pass only patches
// the fields that can have changed since that render — rebuilding the cards would
// re-request every icon and replay the entry animation.
function renderGrid(grid, svcList) {
  if (grid.dataset.ssr === '1') {
    delete grid.dataset.ssr;
    if (patchCards(grid, svcList)) return;
  }
  // app.js never paints a grid from scratch, so a client rebuild must never
  // replay the entry animation: the cards are already on screen, and animating
  // them again would make the whole grid jump on every 60s poll.
  grid.innerHTML = cardsHtml(svcList, { animate: false });
}

function patchCards(grid, svcList) {
  if (grid.querySelectorAll('.service-card').length !== svcList.length) return false;
  for (const svc of svcList) {
    const card = grid.querySelector(`.service-card[data-id="${svc.id}"]`);
    if (!card) return false;
    const status = validStatus(svc.status);
    const el = card.querySelector('.status');
    el.className = `status ${status}`;
    el.querySelector('.txt').textContent = statusLabel(status);
    card.querySelector('.latency span').textContent = formatLatency(svc.latencyMs);
  }
  return true;
}

// The hero stats block and the fold-out menu's status block both report on the
// same list, and both are server-rendered — so a poll patches them in place
// rather than rebuilding either. The menu markup is not touched: only its
// numbers and its summary line change.
function applyLiveStatus(svcList, showStats) {
  const stats = $('#stats');
  if (stats) stats.outerHTML = statsHtml(svcList, showStats);
  applyDrawerStatus(svcList);
}

function applyDrawerStatus(svcList) {
  const { total, up, down } = statusCounts(svcList);
  for (const [sel, value] of [['#drawer-total', total], ['#drawer-up', up], ['#drawer-down', down]]) {
    const el = $(sel);
    if (el) el.textContent = value;
  }

  const summary = $('#drawer-summary');
  if (!summary) return;
  const { text, state } = liveSummary(svcList);
  summary.className = `status ${state}`;
  summary.querySelector('.txt').textContent = text;
}

// Fallback for broken images: CSP blocks inline handlers, so the listeners are
// attached here. `/service-icon/…` 404s are common (deleted icon), and remote
// icon URLs can fail at any time.
function fallbackIcon(img) {
  const box = img.parentElement;
  img.remove();
  if (box) box.textContent = '◆';
}

// Remove the whole thumbnail slot so the card collapses cleanly rather than
// leaving an empty overlay button stretched over nothing.
function fallbackThumb(img) {
  (img.closest('.card-thumb-wrap') ?? img).remove();
}

function attachImageFallbacks(grid) {
  const guard = (img, fallback) => {
    img.addEventListener('error', () => fallback(img));
    // A server-rendered image can fail before this module runs — `error` has
    // already fired by then, so check the settled state too.
    if (img.complete && img.naturalWidth === 0) fallback(img);
  };
  grid.querySelectorAll('.icon-box img').forEach((img) => guard(img, fallbackIcon));
  grid.querySelectorAll('.card-thumb').forEach((img) => guard(img, fallbackThumb));
}

load();
// Keep the status page live: re-fetch on the same cadence as the server checker.
setInterval(load, 60000);

// Swap in the custom favicon + header logo when the admin changes it while the
// page is open. The server renders the initial state, so compare against the DOM
// first — a redundant favicon write would make the browser reload the icon.
function applyIcon(hasIcon) {
  const link = $('#favicon-link');
  const img = $('#brand-icon');
  const def = $('#brand-icon-default');
  if (document.querySelector('.brand')?.classList.contains('has-custom-icon') === hasIcon) return;
  if (hasIcon) {
    if (link) { link.href = `/favicon.png?v=${Date.now()}`; link.type = 'image/png'; }
    if (img && def) {
      img.src = '/site-icon.png';
      img.hidden = false;
      // Note: the default logo is an <svg>, and SVGElement does not reflect
      // the `hidden` property — must set the attribute explicitly.
      def.setAttribute('hidden', '');
    }
    // Drop the default gradient/glow so only the custom image shows.
    document.querySelector('.brand')?.classList.add('has-custom-icon');
  } else {
    if (link) { link.href = '/favicon.svg'; link.type = 'image/svg+xml'; }
    if (img && def) {
      img.hidden = true;
      def.removeAttribute('hidden');
    }
    document.querySelector('.brand')?.classList.remove('has-custom-icon');
  }
}

// --- Service detail dialog --------------------------------------------------

// Open the detail popup for a service. All data comes from the already-fetched
// list — no extra request. Sections with no content stay hidden.
function openDetail(id) {
  const svc = services.find((s) => s.id === id);
  if (!svc) return;
  const dialog = $('#detail-dialog');

  $('#detail-icon').innerHTML = iconHtml(svc);

  $('#detail-title').textContent = svc.name;
  $('#detail-host').textContent = hostOf(svc.url);

  const status = validStatus(svc.status);
  const st = $('#detail-status');
  st.className = `status ${status}`;
  st.innerHTML = `<span class="dot"></span><span class="txt">${statusLabel(status)}</span>`;
  $('#detail-latency').innerHTML = `<svg><use href="#i-activity"/></svg><span>${formatLatency(svc.latencyMs)}</span>`;

  const badge = $('#detail-audience');
  const audience = svc.audience || '';
  if (AUDIENCE_LABELS[audience]) {
    badge.textContent = AUDIENCE_LABELS[audience];
    badge.className = `audience-badge ${audience}`;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }

  const thumb = $('#detail-thumb');
  if (svc.thumbnailImage) {
    thumb.src = `/service-thumb/${svc.id}.png?v=${svc.updatedAt || ''}`;
    thumb.hidden = false;
  } else {
    thumb.hidden = true;
    thumb.removeAttribute('src');
  }

  const tech = $('#detail-tech');
  const chips = $('#detail-tech-chips');
  const tags = (svc.techStack || '').split('|').map((t) => t.trim()).filter(Boolean);
  if (tags.length) {
    chips.innerHTML = tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('');
    tech.hidden = false;
  } else {
    tech.hidden = true;
    chips.innerHTML = '';
  }

  const ai = $('#detail-ai');
  if (svc.aiDetails) {
    $('#detail-ai-text').innerHTML = renderParagraphs(svc.aiDetails);
    ai.hidden = false;
  } else {
    ai.hidden = true;
  }

  const story = $('#detail-story');
  if (svc.story) {
    $('#detail-story-text').innerHTML = renderParagraphs(svc.story);
    story.hidden = false;
  } else {
    story.hidden = true;
  }

  const gh = $('#detail-github');
  if (svc.githubRepo) {
    gh.href = svc.githubRepo;
    gh.hidden = false;
  } else {
    gh.hidden = true;
  }
  $('#detail-open').href = svc.url;

  // Reset scroll to the top of the body (the dialog itself never scrolls).
  dialog.querySelector('.detail-body').scrollTop = 0;
  dialog.showModal();
}

// Event delegation on the grid survives the 60s re-render. Both the description
// and the thumbnail carry data-detail and open the same popup.
$('#services').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-detail]');
  if (btn) openDetail(Number(btn.dataset.detail));
});

$('#detail-close').addEventListener('click', () => $('#detail-dialog').close());

// Clicking the backdrop (the dialog element itself) closes the popup.
$('#detail-dialog').addEventListener('click', (e) => {
  if (e.target === $('#detail-dialog')) $('#detail-dialog').close();
});
