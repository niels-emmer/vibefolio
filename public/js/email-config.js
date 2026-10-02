/**
 * Pure helpers shared by the admin email panel and the test suite.
 *
 * These live outside `feedback.js` for a concrete reason: that module touches `document`
 * at load time, so it cannot be imported in Node and its logic was therefore untestable.
 * The destructive D19 bug survived a 147-test suite precisely because the rule that
 * should have prevented it sat inside a browser-only code path with no coverage.
 *
 * Keep this file free of DOM and Node-specific APIs so both sides can import it — the
 * same constraint `public/js/render.js` follows, and `test/assets.test.js` enforces the
 * import path exists under `public/`.
 */

/**
 * Which stored settings a save would blank.
 *
 * Used by the admin panel to refuse a save that would wipe a working SMTP config — the
 * failure mode where a panel rendered without loading, leaving empty inputs that then
 * overwrote real values.
 *
 * Deliberately narrow, in two ways that matter:
 *
 *  1. Only fields the server actually holds are considered, so a first-time save (nothing
 *     stored) is always allowed.
 *  2. `smtpTo` is exempt when a sender is configured, because blank means "use the From
 *     address" (see the field's own hint in admin.html). A guard without that exemption
 *     makes a documented configuration unreachable: the admin blanks the field, the save
 *     is refused, and there is no way through.
 *
 * `allowClear` lets a caller intentionally bypass the rule for named fields — the
 * "Clear" affordance next to a field uses it, so deliberately removing a stored value is
 * possible while an accidental blank is not.
 *
 * @param {Record<string, string>} formValues  what the form is about to send
 * @param {Record<string, string>} serverValues what the server currently holds
 * @param {{ allowClear?: string[] }} [options] field names the caller means to empty
 * @returns {string[]} names of fields that would be cleared, sorted
 */
export function fieldsThisSaveWouldClear(formValues, serverValues, { allowClear = [] } = {}) {
  return Object.keys(serverValues)
    .filter((key) => {
      if ((formValues[key] ?? '') !== '') return false; // not being cleared
      if ((serverValues[key] ?? '') === '') return false; // nothing stored to lose
      if (allowClear.includes(key)) return false; // cleared on purpose
      // `smtpTo` intentionally has no meaningful stored value of its own when blank —
      // the server falls back to the sender. Blanking it is a supported state.
      if (key === 'smtpTo') return false;
      return true;
    })
    .sort();
}
