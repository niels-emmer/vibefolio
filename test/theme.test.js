import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCENTS } from '../public/js/render.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewsDir = path.join(root, 'src', 'views');
// Comments are stripped first: the prose explaining *why* a rule looks the way it
// does contains examples of the very declarations these tests parse for.
const css = fs
  .readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// Return the body of the first rule whose selector contains `marker`, by counting
// braces rather than regex-matching to the next `}` (the palette values span lines).
function ruleBody(marker) {
  const at = css.indexOf(marker);
  assert.notEqual(at, -1, `style.css should declare ${marker}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

// Custom-property declarations, whitespace-normalised so the two blocks can be
// compared as text without caring about formatting.
function declarations(block) {
  return Object.fromEntries(
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].replace(/\s+/g, ' ').trim()])
  );
}

// The light palette is declared twice — once for an explicit `data-theme="light"`
// and once inside the prefers-color-scheme query for `system`. CSS offers no way
// to share one declaration block between a plain selector and a media query, so
// the duplication is deliberate; this is what stops the two copies drifting (a
// drift would show up only for visitors whose OS prefers light).
test('the light palette is identical for an explicit choice and for `system`', () => {
  const explicit = declarations(ruleBody(':root[data-theme="light"]'));
  const system = declarations(ruleBody(':root[data-theme="system"]'));

  assert.ok(Object.keys(explicit).length > 20, 'the light palette should define the full token set');
  assert.deepEqual(
    Object.keys(system).sort(),
    Object.keys(explicit).sort(),
    'the two light blocks should define the same tokens'
  );
  for (const [name, value] of Object.entries(explicit)) {
    assert.equal(system[name], value, `${name} differs between the light and system blocks`);
  }

  // Both must also tell the browser to use light native widgets.
  assert.match(ruleBody(':root[data-theme="light"]'), /color-scheme:\s*light;/);
  assert.match(ruleBody(':root[data-theme="system"]'), /color-scheme:\s*light;/);
});

// `system` is the only theme whose light palette lives behind a media query, so
// the query itself has to be the prefers-color-scheme one.
test('the `system` light palette is behind a prefers-color-scheme: light query', () => {
  const at = css.indexOf(':root[data-theme="system"]');
  const query = css.lastIndexOf('@media', at);
  assert.match(css.slice(query, at), /@media \(prefers-color-scheme: light\)/);
});

// Every token the light palette overrides must exist in the dark default,
// otherwise a component could read a value that is only defined in one theme.
test('the light palette only overrides tokens the dark theme defines', () => {
  const dark = declarations(ruleBody(':root {'));
  for (const name of Object.keys(declarations(ruleBody(':root[data-theme="light"]')))) {
    assert.ok(name in dark, `${name} is set in the light palette but not in the dark default`);
  }
});

// The drawer is positioned against the viewport, which only works because it is a
// sibling of `.site-header` (a backdrop-filter ancestor would become its
// containing block and clip it). Guard the two halves of that arrangement.
test('the drawer is not nested inside the site header', () => {
  const home = fs.readFileSync(path.join(viewsDir, 'home.html'), 'utf8');
  const header = /<header class="site-header">[\s\S]*?<\/header>/.exec(home)[0];
  assert.doesNotMatch(header, /\{\{DRAWER\}\}/, '{{DRAWER}} must sit outside <header>');
  assert.match(home, /\{\{DRAWER\}\}/);
  assert.match(css, /\.site-header\s*\{[^}]*backdrop-filter/);
});

// The drawer is hidden by `transform`, deliberately not by `visibility: hidden` or
// `display: none`. Both are traps here:
//   - `visibility: hidden` is a focusability gate the browser only clears at the
//     frame lifecycle, so `closeBtn.focus()` in chrome.js's open() would be
//     silently refused and the drawer would open with focus still on the trigger.
//     (Measured in Chromium: focusing in the same task, after a forced reflow and
//     in a setTimeout(0) all fail; only the second frame succeeds.)
//   - `display: none` would kill the slide-in transition.
// Off-screen transform + `inert` (rendered in the markup, toggled by chrome.js)
// hides it from both the tab order and the accessibility tree with no such gate.
test('the drawer is hidden by transform, not by a focusability gate', () => {
  const closed = ruleBody('.drawer {');
  assert.match(closed, /transform:\s*translateX\(100%\)/, 'the closed drawer should be parked off-screen');
  assert.match(closed, /pointer-events:\s*none/, 'the closed drawer must not take clicks');
  assert.doesNotMatch(closed, /visibility:\s*hidden/, 'visibility: hidden would make focus() a no-op');
  assert.doesNotMatch(closed, /display:\s*none/, 'display: none would break the slide-in transition');

  const open = ruleBody('.drawer.open');
  assert.match(open, /transform:\s*translateX\(0\)/);
  assert.match(open, /pointer-events:\s*auto/);

  const backdrop = ruleBody('.drawer-backdrop {');
  assert.match(backdrop, /opacity:\s*0/);
  assert.match(backdrop, /pointer-events:\s*none/, 'a transparent backdrop must not swallow clicks');
  assert.doesNotMatch(backdrop, /visibility:\s*hidden/);
});

// --- Accent (D21) -----------------------------------------------------------

// One hue for the whole site, chosen in the admin panel and rendered into
// `<html data-accent="…">` server-side. Every accent needs a dark *and* a light
// palette, because a hue bright enough to read on near-black is unreadable on the
// light background. These tests compute the *requirement* (readable text) rather
// than asserting hex values, so an accent cannot be added with a palette that
// fails contrast — the same rule the old warm-accent button was held to.
//
// `--grad-accent` is deliberately not contrast-checked: it is decorative (the stat
// numbers at 2rem, and the brand tile's fill), so the AA thresholds for text do not
// apply to it.
const ACCENT_TOKENS = ['--accent', '--accent-rgb', '--accent-solid', '--on-accent', '--grad-accent'];
const accentIds = ACCENTS.map((a) => a.id);

// The three blocks each accent must declare. The light values are declared twice for
// the same reason the light palette is (see the note above): CSS cannot share a
// declaration block between a plain selector and a media query.
function accentPalettes(id) {
  return {
    dark: declarations(ruleBody(`[data-accent="${id}"]`)),
    light: declarations(ruleBody(`:root[data-theme="light"][data-accent="${id}"]`)),
    system: declarations(ruleBody(`:root[data-theme="system"][data-accent="${id}"]`)),
  };
}

test('every accent defines the full token set, and its two light copies agree', () => {
  assert.ok(accentIds.length >= 2, 'the picker should offer more than one accent');
  for (const id of accentIds) {
    const { dark, light, system } = accentPalettes(id);
    for (const [name, tokens] of Object.entries({ dark, light, system })) {
      assert.deepEqual(
        Object.keys(tokens).sort(),
        [...ACCENT_TOKENS].sort(),
        `${id}/${name} should define exactly the accent tokens`
      );
    }
    assert.deepEqual(system, light, `${id}: the light palette and its \`system\` copy have drifted`);
  }
});

// `amber` is the default *and* a picker option, so its block has to repeat the values
// `:root` already carries — otherwise the amber chip would be painted with whatever
// accent happens to be in force.
test('the amber accent block matches the root palette it repeats', () => {
  const root = declarations(ruleBody(':root {'));
  const light = declarations(ruleBody(':root[data-theme="light"]'));
  for (const [block, source, label] of [
    [declarations(ruleBody('[data-accent="amber"]')), root, 'dark'],
    [declarations(ruleBody(':root[data-theme="light"][data-accent="amber"]')), light, 'light'],
  ]) {
    for (const token of ACCENT_TOKENS) {
      assert.equal(block[token], source[token], `${label}: --accent="amber" should repeat ${token} from the theme palette`);
    }
  }
});

// `--accent-rgb` is the same hue as `--accent` written as a triplet, and everything that
// needs an alpha channel reads it (glows, washes, the picker's chip border, the card's
// border sheen). Nothing in CSS ties the two together, so a drift would silently tint all
// of those away from the display hue — visible, but only as "the glow looks wrong".
test('every accent keeps its rgb triplet in step with its hex hue', () => {
  const triplet = (value) => value.split(',').map((n) => Number(n.trim()));
  for (const id of accentIds) {
    for (const [theme, tokens] of Object.entries(accentPalettes(id))) {
      const hex = tokens['--accent'];
      assert.match(hex, /^#[0-9a-f]{6}$/i, `${id}/${theme}: --accent should be a hex colour`);
      const expected = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      assert.deepEqual(
        triplet(tokens['--accent-rgb']),
        expected,
        `${id}/${theme}: --accent-rgb (${tokens['--accent-rgb']}) does not match --accent (${hex})`
      );
      assert.ok(
        triplet(tokens['--accent-rgb']).every((n) => Number.isInteger(n) && n >= 0 && n <= 255),
        `${id}/${theme}: --accent-rgb should be three 0–255 integers`
      );
    }
  }
});

test('every accent is readable in both themes', () => {
  const backgrounds = {
    dark: declarations(ruleBody(':root {'))['--bg'],
    light: declarations(ruleBody(':root[data-theme="light"]'))['--bg'],
  };

  for (const id of accentIds) {
    const { dark, light } = accentPalettes(id);
    for (const [theme, tokens] of [['dark', dark], ['light', light]]) {
      for (const token of ['--accent', '--accent-solid', '--on-accent']) {
        assert.match(tokens[token], /^#[0-9a-f]{6}$/i, `${id}/${theme}: ${token} should be a hex colour, got "${tokens[token]}"`);
      }

      // Text on the primary button, and the accent used as text (links, headings,
      // hovers) against the page background.
      const onFill = contrast(tokens['--accent-solid'], tokens['--on-accent']);
      assert.ok(
        onFill >= 4.5,
        `${id}/${theme}: text on the primary button is ${onFill.toFixed(2)}:1 — below the 4.5:1 AA threshold`
      );
      const onBg = contrast(tokens['--accent'], backgrounds[theme]);
      assert.ok(
        onBg >= 4.5,
        `${id}/${theme}: the accent as text on the ${theme} background is ${onBg.toFixed(2)}:1 — below the 4.5:1 AA threshold`
      );
    }
  }
});

// --- Accent picker chips (D24) ---------------------------------------------

// The chip rule's own body. `ruleBody` matches the first occurrence of its marker, and
// `.accent-opt {` is also the tail of the two light-mode label overrides, so this marker
// anchors on the rule's first declaration to land on the right one.
const chipRule = () => ruleBody('.accent-opt {\n  position: relative;');

// Which token a rule paints a property with, so the contrast check below follows the
// stylesheet rather than a copy of its current values (a hard-coded expectation would pass
// even after someone switched the label back to the hue that fails).
function tokenIn(block, property) {
  const m = new RegExp(`${property}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(block);
  assert.ok(m, `expected \`${property}: var(--…)\` in the rule, got: ${block.trim().slice(0, 80)}`);
  return m[1];
}

// The chips are painted in the accent they offer, so their label sits on a *tint* of that
// accent rather than on the page background. The palette clears AA by a thin margin — amber
// in light mode is 4.64:1 on the plain background — and the tint eats it (4.19:1 at 8%),
// which is why the label takes the theme's darker hue: `--accent-solid` in light mode,
// `--accent` in dark. This composites the tint straight out of the stylesheet and checks
// every accent in both themes and both states, which is the check the first version of this
// design needed (it would have failed on amber/light and violet/dark).
test('the accent chips stay readable on their own tint', () => {
  const alphaOf = (block, label) => {
    const m = /background:\s*rgba\(var\(--accent-rgb\),\s*([\d.]+)\)/.exec(block);
    assert.ok(m, `${label} should tint its background with rgba(var(--accent-rgb), …)`);
    return Number(m[1]);
  };
  const rest = alphaOf(chipRule(), 'the accent chip');
  const hover = alphaOf(ruleBody('.accent-opt:hover'), 'the accent chip hover');
  assert.ok(hover > rest, 'hover should deepen the tint rather than replace the colour');

  const backgrounds = {
    dark: declarations(ruleBody(':root {'))['--bg'],
    light: declarations(ruleBody(':root[data-theme="light"]'))['--bg'],
  };
  // Which token the label uses, per theme, read from the stylesheet. In dark mode the tint
  // lightens the background (so the *brighter* hue is the safe one); in light mode it
  // darkens it, which is why the light override exists at all.
  const labelToken = {
    dark: tokenIn(chipRule(), 'color'),
    light: tokenIn(ruleBody(':root[data-theme="light"] .accent-opt'), 'color'),
  };
  assert.notEqual(labelToken.dark, labelToken.light, 'the light mode label hue should differ from the dark one');

  for (const id of accentIds) {
    const { dark, light } = accentPalettes(id);
    for (const [theme, tokens] of [['dark', dark], ['light', light]]) {
      const text = tokens[labelToken[theme]];
      const rgb = tokens['--accent-rgb'].split(',').map((n) => Number(n.trim()));
      for (const [state, alpha] of [['rest', rest], ['hover', hover]]) {
        const bg = composite(rgb, alpha, backgrounds[theme]);
        const ratio = contrast(text, bg);
        assert.ok(
          ratio >= 4.5,
          `${id}/${theme} (${state}): the chip label is ${ratio.toFixed(2)}:1 on its own ${alpha} tint — below the 4.5:1 AA threshold`
        );
      }
    }
  }
});

// The label's light-mode hue is declared for an explicit light choice and again inside the
// prefers-color-scheme query for `system`, like the light palettes — a drift would show only
// for visitors whose OS prefers light, and only on the admin panel.
test('the chip label override is declared for light and for `system` light', () => {
  assert.match(css, /:root\[data-theme="light"\]\s*\.accent-opt\s*\{[^}]*color:\s*var\(--accent-solid\)/);
  const at = css.indexOf(':root[data-theme="system"] .accent-opt');
  assert.notEqual(at, -1, 'the chip label override should be repeated for `system`');
  const query = css.lastIndexOf('@media', at);
  assert.match(css.slice(query, at), /@media \(prefers-color-scheme: light\)/);
  assert.match(css.slice(at, css.indexOf('}', at)), /color:\s*var\(--accent-solid\)/);
});

// The snapshots block in the backup panel. It used to sit flush against the buttons above it:
// `.panel-group:first-of-type` drops the top margin of a heading that opens a block, and the
// heading *is* the first `<h3>` inside the wrapper, so that reset matched and the block read
// as a continuation of the buttons rather than as a section. The wrapper carries its own space
// and a hairline rule now, and this fails if either goes away.
test('the snapshots block is set off as its own section', () => {
  const section = ruleBody('.snapshots-section {');
  assert.match(section, /margin-top:\s*[\d.]+rem/, 'the block needs space above it');
  assert.match(section, /padding-top:\s*[\d.]+rem/);
  assert.match(section, /border-top:\s*1px solid var\(--border\)/);

  // The heading's own top margin is zeroed by the `:first-of-type` reset, so the wrapper's
  // spacing is what actually separates it — the two must not both be removed.
  assert.match(css, /\.snapshots-section\s+\.panel-group\s*\{[^}]*margin-top:\s*0/);

  // The class has to be on the element in the view, or all of the above is dead CSS and the
  // bug is silently back.
  const adminHtml = fs.readFileSync(path.join(root, 'src', 'views', 'admin.html'), 'utf8');
  assert.match(
    adminHtml,
    /id="snapshots-wrap"\s+class="snapshots-section"/,
    'the snapshots wrapper should carry the section class'
  );
});

// The section label takes the accent, so a long panel reads as sections rather than as one
// grey run of labels. The colour follows the accent chips' rule (D24): on the panel's surface
// the accent is the comfortable one in dark mode and only just clears AA in light mode, where
// `--accent-solid` is the safe one. `--snapshots-section` no longer declares a colour of its
// own — this test is what would catch that coming back.
test('the panel grouping labels use the accent, in both themes', () => {
  assert.match(css, /\.panel-group\s*\{[^}]*color:\s*var\(--accent\)/);
  assert.match(
    css,
    /:root\[data-theme="light"\]\s*\.panel-group\s*\{[^}]*color:\s*var\(--accent-solid\)/
  );
  const at = css.indexOf(':root[data-theme="system"] .panel-group');
  assert.notEqual(at, -1, 'the grouping-label override should be repeated for `system`');
  const query = css.lastIndexOf('@media', at);
  assert.match(css.slice(query, at), /@media \(prefers-color-scheme: light\)/);
  assert.match(css.slice(at, css.indexOf('}', at)), /color:\s*var\(--accent-solid\)/);

  // One definition, not a second one nested under the snapshots wrapper: a colour there would
  // be the same value twice and would drift the day someone edits only one.
  assert.doesNotMatch(
    css,
    /\.snapshots-section\s+\.panel-group\s*\{[^}]*color:/,
    'the snapshots label should inherit `.panel-group` rather than redeclare the colour'
  );
});

// The chip's colour comes from the tokens its own `data-accent` declares, so a chip must not
// hard-code a colour (it would look right for exactly one accent).
test('the accent chips take their colours from tokens', () => {
  const chip = chipRule();
  assert.match(chip, /color:\s*var\(--accent\)/, 'the label should use the accent token');
  assert.match(chip, /border:\s*1px solid rgba\(var\(--accent-rgb\)/, 'the border should use the accent');
  assert.match(chip, /background:\s*rgba\(var\(--accent-rgb\)/, 'the tint should use the accent');
  assert.doesNotMatch(chip, /#[0-9a-f]{3,8}/i, 'no hard-coded colour in the chip');
  // "In force" is marked by a solid border plus a check mark, because every chip is
  // coloured now and colour alone can no longer say which one is selected.
  assert.match(ruleBody('.accent-opt:has(input:checked)'), /border-color:\s*var\(--accent-solid\)/);
  assert.match(css, /\.accent-opt:has\(input:checked\) \.accent-check\s*\{[^}]*opacity:\s*1/);
  assert.match(ruleBody('.accent-opt .accent-check'), /opacity:\s*0/, 'the check should be hidden by opacity, not display');
});

// A field's own label is its direct child. The descendant form (`.field label`) also matches
// `<label>`s nested inside a field's content — the accent picker's chips are labels inside the
// "Accent colour" field — and being more specific than a component's own class (0,1,1 vs
// 0,1,0) it silently won: the chips rendered in the field label's grey display font instead of
// their own accent colour and mono face. `.field label .opt` is fine (it is a descendant of
// the field's label), so only the rule's own selector is guarded.
test("a field's label styling does not leak into components nested in a field", () => {
  assert.match(css, /\.field\s*>\s*label\s*\{/, 'the field label rule should use the direct-child form');
  assert.doesNotMatch(css, /\.field label\s*\{/, 'the descendant form leaks into components nested in a field');
});

// A reference to a token that no longer exists fails *silently*: the declaration is
// dropped at computed-value time and the component falls back to an inherited value,
// so it merely looks wrong. Collapsing the old --accent-2/--warm-* tokens into the
// accent is exactly the kind of change that leaves one behind.
test('every custom property the stylesheet reads is declared', () => {
  const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const read = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(read.length > 40, 'the stylesheet should be reading tokens');
  for (const name of new Set(read)) {
    assert.ok(declared.has(name), `${name} is read by a rule but never declared`);
  }
});

test('the primary button takes its colours from tokens, not literals', () => {
  const primary = ruleBody('.btn.primary {');
  assert.match(primary, /background:\s*var\(--accent-solid\)/, 'the fill must come from a token');
  assert.match(primary, /color:\s*var\(--on-accent\)/, 'the text colour must come from a token');
  // A literal here is what would break one of the two themes; rgba(var(…)) for the
  // glow is fine, hence the negative lookahead.
  assert.doesNotMatch(primary, /#[0-9a-f]{3,8}/i, 'no hard-coded colour in the primary button');
  assert.doesNotMatch(primary, /rgba?\((?!var)/, 'no hard-coded colour in the primary button');

  // Hover must not brighten the fill: in light mode that drops the text back under
  // the AA threshold, so it lifts instead.
  const hover = ruleBody('.btn.primary:hover');
  assert.match(hover, /transform:\s*translateY\(/, 'hover should lift');
  assert.doesNotMatch(hover, /brightness\(/, 'hover must not brighten the fill');
});

// `btn warm` (the yellow) and `btn primary` (the purple gradient) meant the same
// thing once one accent hue replaced both, so the older name is gone rather than kept
// as a second spelling of the same button.
test('there is exactly one primary button style', () => {
  assert.doesNotMatch(css, /\.btn\.warm/, 'the .btn.warm rule should be gone');
  for (const file of fs.readdirSync(viewsDir)) {
    const view = fs.readFileSync(path.join(viewsDir, file), 'utf8');
    assert.doesNotMatch(view, /class="btn warm/, `${file} should use .btn.primary`);
  }
});

test('the login screen uses the accent for its primary action', () => {
  const admin = fs.readFileSync(path.join(viewsDir, 'admin.html'), 'utf8');
  assert.match(admin, /<button type="submit" class="btn primary">Sign in<\/button>/);
  // The full-width behaviour lives in .auth-card .btn now, not an inline style.
  assert.doesNotMatch(admin, /class="btn primary"[^>]*style=/);
  assert.match(css, /\.auth-card \.btn\s*\{[^}]*width:\s*100%/);
});
// --- Contrast helpers -------------------------------------------------------

// WCAG 2.1 relative luminance and contrast ratio, so the *requirement* (readable
// text) is asserted rather than the implementation. A hard-coded colour that looks
// fine in dark mode is exactly how a light theme ends up unreadable.
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = channels.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `rgba(rgb, alpha)` composited over an opaque background — what a translucent tint
 * actually renders as. Returns a hex string so `contrast` can consume it.
 *
 * Needed because the accent chips tint their own background (D24): a contrast check against
 * the plain page background would miss the case where the tint itself drops the label under
 * the AA threshold.
 */
function composite(rgb, alpha, background) {
  const bg = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
  const mixed = rgb.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

test('the login card centres its logo, heading and description', () => {
  assert.match(ruleBody('.auth-card .logo'), /margin:\s*0 auto/, 'the logo should be horizontally centred');
  assert.match(ruleBody('.auth-card h1'), /text-align:\s*center/);
  assert.match(ruleBody('.auth-card .sub'), /text-align:\s*center/);
});

// The login card shows the uploaded site icon, so its tile has to lose the default
// gradient and glow exactly as the header brand does — otherwise the icon sits on a
// blue gradient square, which is the bug this replaced.
test('the login card drops the default gradient tile when a site icon is uploaded', () => {
  const custom = ruleBody('.auth-card .logo.has-custom-icon');
  assert.match(custom, /background:\s*transparent/);
  assert.match(custom, /box-shadow:\s*none/);

  // ...and the image fills the tile rather than sitting at its intrinsic size.
  const img = ruleBody('.auth-card .logo img');
  assert.match(img, /width:\s*100%/);
  assert.match(img, /height:\s*100%/);
  assert.match(img, /object-fit:\s*cover/);
});
