// Single source of truth for the `?v=` cache-buster on the shared assets
// (`style.css`, `admin.js`, and the `app.js` → `render.js` import).
//
// Why one constant: browsers cache these for 5 minutes (`express.static`), so an
// asset must be re-requested under a *new* URL when it changes. Per-page version
// numbers drift — `admin.html` sat on `v=13` while `credits.html` was on `v=18`
// for the same stylesheet — and a drifted number can pair a cached old module
// with a new one. `test/assets.test.js` fails if any page disagrees with this
// value, so bumping is one edit and the check is automated rather than a
// convention someone has to remember.
//
// Bump this whenever style.css, app.js, render.js, or admin.js changes.
export const ASSET_VERSION = 62;
