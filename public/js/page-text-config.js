// Pure save-guard logic for the admin panel's page-text form, kept out of `admin.js` so
// it can be tested in Node — `admin.js` touches `document` at load and cannot be imported
// outside a browser. Same split as `email-config.js` (see docs/decisions.md D19).
//
// Why the guard exists at all: the panel's four fields are empty until
// `/api/admin/content` resolves, and a submit that sent all four would write four empty
// strings over the stored copy. A cleared field is a legitimate value that nothing
// restores (D22), so a save from a panel that has not loaded is unrecoverable — the exact
// bug class D19 was about in the email panel.
//
// Sending only the fields whose value actually differs fixes both halves at once: a panel
// that never loaded sends nothing, and a real edit sends only what changed.

export const PAGE_TEXT_FIELDS = ['feedbackSubtitle', 'feedbackIntro', 'creditsSubtitle', 'creditsNote'];

/**
 * The subset of `values` that differs from what the server holds.
 *
 * `stored` is the last content read from the API, or `null` before the first load — an
 * unloaded panel's blank fields then match nothing and only a typed-in value is sent.
 * An empty result means "nothing to write".
 */
export function changedPageTextFields(values, stored) {
  const changed = {};
  for (const key of PAGE_TEXT_FIELDS) {
    const next = String(values?.[key] ?? '');
    if (next !== String(stored?.[key] ?? '')) changed[key] = next;
  }
  return changed;
}
