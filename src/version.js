/**
 * The name and release date of the running build, shown in the fold-out menu.
 *
 * Why a hand-maintained constant rather than `git describe` or `package.json`:
 * production is a **plain file copy**, not a git checkout (see D8 in
 * docs/decisions.md), so there is no git metadata on the host to read. The
 * toggle-menu must also work with no network access, and the repository is
 * private — a live "latest release" lookup from the browser would need a token
 * and would leak the repo's existence, so the version cannot be fetched.
 *
 * >>> BUMP `APP_RELEASE_DATE` AS PART OF CUTTING A RELEASE. <<<
 * It is deliberately not derived from "now": that would report the container
 * start time, which changes on every restart and is not a release date.
 * `test/menu.test.js` asserts the value is a valid ISO date and that it formats
 * the way the menu expects, so a malformed edit fails the suite.
 */

export const APP_NAME = 'Vibefolio';

/** ISO date (YYYY-MM-DD) of the running release. Bump when you release. */
export const APP_RELEASE_DATE = '2026-10-02';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-09-30` → `30 Sep 2026`.
 *
 * Formatting is done by hand rather than with `toLocaleDateString`: the output
 * is written into the HTML on the server, so a locale-dependent formatter would
 * make the rendered page (and the tests) depend on the host's locale.
 */
export function releaseDateLabel(iso = APP_RELEASE_DATE) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`APP_RELEASE_DATE must be YYYY-MM-DD, got: ${iso}`);
  const [, year, month, day] = m;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) throw new Error(`APP_RELEASE_DATE has an out-of-range month: ${iso}`);
  return `${Number(day)} ${monthName} ${year}`;
}
