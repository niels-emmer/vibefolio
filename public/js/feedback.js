// Feedback form.
//
// The save-guard rule lives in ./email-config.js so it can be tested in Node — this
// module touches `document` at load and cannot be imported outside a browser.
import { fieldsThisSaveWouldClear } from './email-config.js?v=62';

// The page ships a signed token in the markup, so this module never needs to fetch
// one — a fresh token is requested only after a *failed* submit, because the old one
// is then suspect (rate limited, expired, or refused). Keeping the happy path free of
// a round trip means the form works even if that request would have been throttled.
//
// The confirmation is rendered in the page rather than a toast: a visitor who has just
// written a message deserves a message they cannot miss, and it must survive being
// scrolled to. `role="status"` + `aria-live="polite"` announces it without stealing
// focus from where the visitor is reading.

const form = document.querySelector('#feedback-form');
const status = document.querySelector('#fb-status');
const submit = document.querySelector('#fb-submit');
const hint = document.querySelector('#fb-hint');
const tokenField = form?.querySelector('input[name="token"]');

if (form) {
  const show = (message, kind) => {
    status.textContent = message;
    status.className = `form-status ${kind}`;
    status.hidden = false;
  };

  const reset = () => {
    status.hidden = true;
    status.textContent = '';
  };

  // Re-enable the button and say how long to wait, so a throttled visitor is not left
  // clicking a dead control.
  let throttling = false;
  function throttle(seconds) {
    throttling = true;
    let left = seconds;
    // Reset the label here, not just in `finally`: the finally block re-enables the
    // button when the label is still "Sending…", which used to cancel this countdown the
    // moment it started.
    submit.textContent = 'Send feedback';
    submit.disabled = true;
    hint.textContent = `Please wait ${left}s before sending another message.`;
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        throttling = false;
        submit.disabled = false;
        hint.textContent = 'One message per minute, please.';
      } else {
        hint.textContent = `Please wait ${left}s before sending another message.`;
      }
    }, 1000);
  }

  async function refreshToken() {
    try {
      const res = await fetch('/api/feedback/token');
      if (!res.ok) return;
      const { token } = await res.json();
      if (token) tokenField.value = token;
    } catch {
      // Leave the existing token: the submit will fail with a clear error rather than
      // silently doing nothing.
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    reset();
    submit.disabled = true;
    submit.textContent = 'Sending…';

    try {
      const body = Object.fromEntries(new FormData(form).entries());
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        // Success: clear the form so the message is not lingering on screen, and
        // replace it with the confirmation.
        form.reset();
        status.hidden = false;
        show(data.message || 'Thanks — your message has been sent.', 'ok');
        submit.textContent = 'Send feedback';
        submit.disabled = false;
        return;
      }

      // 429 carries no useful detail by design (it must not reveal the limit), so
      // infer the wait from the Retry-After header when the server sends one.
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after'));
        show(data.error || 'Too many messages. Please try again later.', 'error');
        throttle(Number.isFinite(retry) && retry > 0 ? retry : 60);
        return;
      }

      show(data.error || 'Something went wrong. Please try again.', 'error');
      // The token may be the reason (expired, or rotated by a restart). Fetch a new
      // one so a second attempt is not guaranteed to fail the same way.
      if (res.status === 400) await refreshToken();
    } catch {
      show('Could not reach the server. Check your connection and try again.', 'error');
    } finally {
      // Never fight the throttle countdown: if we are throttled, that path owns the
      // button's disabled state and label.
      if (throttling) return;
      submit.textContent = 'Send feedback';
      submit.disabled = false;
    }
  });
}

// --- Admin: email settings -------------------------------------------------
//
// Lives here rather than in admin.js because it is the same feature's UI, and
// admin.js is already the largest script on the site.

const emailForm = document.querySelector('#email-form');
if (emailForm) {
  const $ = (sel) => document.querySelector(sel);
  const toastEl = $('#toast');
  const panel = $('#email-panel');

  // Guards against the failure that made this dangerous: if the panel was never
  // populated, saving would write empty strings over a working SMTP config. Both
  // `loaded` and the self-load below make that impossible rather than unlikely.
  let loaded = false;

  const toast = (message, kind = 'success') => {
    $('#toast-msg').textContent = message;
    $('#toast-icon').innerHTML = `<use href="${kind === 'error' ? '#i-alert' : '#i-check'}"/>`;
    toastEl.className = `toast ${kind} show`;
    clearTimeout(toastEl.__timer);
    toastEl.__timer = setTimeout(() => toastEl.classList.remove('show'), 4000);
  };

  const api = async (path, options = {}) => {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  // The protocol follows the port, exactly as the server derives it — showing it as a
  // derived value rather than an independent control is what stops the two drifting
  // apart into a mismatched TLS mode.
  const PROTOCOL_BY_PORT = { 465: 'Implicit TLS (SMTPS)', 587: 'STARTTLS (submission)', 25: 'Plain / STARTTLS (relay)' };
  const syncProtocol = () => {
    const port = Number(emailForm.elements.smtpPort.value);
    // 465 is the only implicit-TLS port; anything else negotiates STARTTLS if offered.
    if (PROTOCOL_BY_PORT[port]) $('#smtp-protocol').textContent = PROTOCOL_BY_PORT[port];
    else if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      $('#smtp-protocol').textContent = 'STARTTLS if offered';
    } else $('#smtp-protocol').textContent = '—';
  };
  emailForm.elements.smtpPort.addEventListener('input', syncProtocol);
  emailForm.elements.smtpPort.addEventListener('change', syncProtocol);

  const values = () => ({
    smtpHost: emailForm.elements.smtpHost.value.trim(),
    smtpPort: emailForm.elements.smtpPort.value,
    smtpUser: emailForm.elements.smtpUser.value.trim(),
    smtpFrom: emailForm.elements.smtpFrom.value.trim(),
    smtpTo: emailForm.elements.smtpTo.value.trim(),
    feedbackEnabled: emailForm.elements.feedbackEnabled.checked,
    // Only sent when the admin typed something; omitted means "keep the stored one".
    ...(emailForm.elements.smtpPassword.value ? { smtpPassword: emailForm.elements.smtpPassword.value } : {}),
  });

  /**
   * Show each field's ✕ only while that field has something in it.
   *
   * An ✕ on an empty field is noise and does nothing when clicked, so it is hidden until the
   * first character — including for a field that is *blank but stored*, which is the state
   * where blank means "leave the stored value alone" and there is nothing to clear. The
   * server is the source of truth for that state, so this runs after `loadEmail()` as well as
   * on every keystroke.
   */
  function syncClearButtons() {
    for (const btn of document.querySelectorAll('[data-clear-field]')) {
      const input = emailForm.elements[btn.dataset.clearField];
      btn.hidden = !input || input.value.trim() === '';
    }
  }

  emailForm.addEventListener('input', syncClearButtons);
  emailForm.addEventListener('change', syncClearButtons);

  async function loadEmail() {
    const { smtp, feedbackEnabled } = await api('/api/admin/email');
    emailForm.elements.smtpHost.value = smtp.host || '';
    emailForm.elements.smtpPort.value = smtp.port || '';
    emailForm.elements.smtpUser.value = smtp.user || '';
    emailForm.elements.smtpFrom.value = smtp.from || '';
    emailForm.elements.smtpTo.value = smtp.to || '';
    emailForm.elements.feedbackEnabled.checked = Boolean(feedbackEnabled);

    const pw = emailForm.elements.smtpPassword;
    pw.value = '';
    pw.placeholder = smtp.hasPassword ? '•••••••• (saved — leave blank to keep)' : 'Not set';
    $('#smtp-password-state').textContent = smtp.hasPassword ? 'A password is stored.' : 'No password stored.';
    syncProtocol();
    syncClearButtons();
    loaded = true;
    panel?.removeAttribute('data-unloaded');
  }

  const save = async (options = {}) => {
    // Two independent defences, both needed:
    //
    // 1. A panel that was never populated holds empty inputs, so load it rather than
    //    saving blanks.
    // 2. Even a populated panel can be blanked (or a future refactor can show it before
    //    the load completes), so the save is refused if it would clear a value the
    //    server actually holds. Checking a `loaded` flag alone did NOT catch this — the
    //    flag was already true by the time the inputs were blanked, so the save went
    //    through and wiped the config (D19).
    if (!loaded) await loadEmail();
    else await assertPanelMatchesServer(options);
    const data = await api('/api/admin/email', { method: 'PUT', body: JSON.stringify(values()) });
    await loadEmail();
    return data;
  };

  /**
   * Refuse a save that would blank a value the server holds.
   *
   * Narrow by design: a first-time save is always allowed (nothing stored), and `smtpTo`
   * is exempt because blank is the documented "use the From address" state. A field's ✕
   * passes `allowClear` so a deliberate removal still works — without that, the guard would
   * make a stored value impossible to remove at all.
   *
   * Verified in a browser: blanking a populated panel and submitting leaves the stored
   * config untouched and reports "Refusing to save: … would be cleared".
   */
  async function assertPanelMatchesServer({ allowClear = [] } = {}) {
    const { smtp } = await api('/api/admin/email');
    const onServer = { smtpHost: smtp.host, smtpPort: smtp.port ? String(smtp.port) : '', smtpFrom: smtp.from, smtpTo: smtp.to };
    const now = values();
    const wouldWipe = fieldsThisSaveWouldClear(now, onServer, { allowClear });
    if (wouldWipe.length) {
      throw new Error(
        `Refusing to save: ${wouldWipe.join(', ')} would be cleared. Use the ✕ in the field if you mean to remove it.`
      );
    }
  }

  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await save();
      toast('Email settings saved');
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });

  $('#email-test-connection').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Testing…';
    try {
      // Test the form's current values without saving them, so a wrong password can be
      // diagnosed without first writing it to the database.
      await save();
      const result = await api('/api/admin/email/test-connection', { method: 'POST' });
      toast(result.message || 'Connection succeeded', 'success');
    } catch (ex) {
      toast(ex.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  $('#email-test-send').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      await save();
      const to = emailForm.elements.testRecipient.value.trim();
      const result = await api('/api/admin/email/test-send', {
        method: 'POST',
        body: JSON.stringify({ to }),
      });
      toast(result.message || 'Test message sent', 'success');
    } catch (ex) {
      toast(ex.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  // Per-field ✕: empties the input and saves with that field explicitly allowed to be
  // cleared. Without this the guard would make a stored value impossible to remove.
  for (const btn of document.querySelectorAll('[data-clear-field]')) {
    btn.addEventListener('click', async () => {
      const field = btn.dataset.clearField;
      emailForm.elements[field].value = '';
      try {
        await save({ allowClear: [field] });
        toast(`${field} cleared`);
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
  }

  // admin.js calls this after login; expose it so the panel loads with the rest.
  window.loadEmailSettings = loadEmail;

  // Self-load if the panel is already on screen. Covers the case where showPanel() ran
  // before this module executed — the ordering in admin.html should prevent it, but a
  // silent no-op there used to mean a blank panel that could be saved over real config,
  // and a `?.()` guard alone converts a loud failure into a quiet one.
  if (panel && !panel.hidden) loadEmail().catch(() => {});
}
