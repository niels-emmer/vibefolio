/**
 * The copy the feedback and credits pages ship with, kept as the *seed* values
 * for the editable page text (see docs/decisions.md D22).
 *
 * Why a seed rather than hardcoded prose in the templates: the text now lives in the
 * database and is edited in the admin panel, but an empty database must still render
 * the site as it looked before the text was editable. `migrate()` inserts these values
 * once, only for keys that do not exist yet — so clearing a field in the admin panel
 * genuinely empties it (no fallback resurrects it), and an existing install is
 * unchanged by the upgrade.
 *
 * These are deliberately neutral, generic placeholders: this repository is a
 * generalised template, and every deployment edits this copy in the admin panel
 * (see docs/decisions.md D27). The strings are stored one paragraph per block; a
 * blank line between blocks becomes a `<p>` boundary, so keep them that way.
 * `test/content.test.js` asserts the seeded pages render exactly this copy.
 */

// Multi-paragraph values are stored as one string with a blank line between
// paragraphs; `renderParagraphs()` turns each block back into a `<p>`.
export const DEFAULT_PAGE_TEXT = {
  feedbackSubtitle: 'Tell me what’s broken, what’s missing, or what you’d like to see next.',
  feedbackIntro: [
    'This is a small self-hosted site run by one person. Feedback lands directly in the inbox of whoever runs it. There is no support queue in between.',
    'Bug reports, half-baked ideas, and notes reading “this bit confused me” are all welcome. Leave an email if you would like a reply. It will not be stored, monetized, or shared.',
  ].join('\n\n'),
  creditsSubtitle: 'Credit where credit is due.',
  creditsNote:
    'This site is built and maintained by hand, with a little help from the people and tools listed above.',
};

export const DEFAULT_CREDITS = [
  { role: 'Built with', value: 'Node.js', url: 'https://nodejs.org' },
  { role: 'Powered by', value: 'Express', url: 'https://expressjs.com' },
  { role: 'Icons by', value: 'Lucide', url: 'https://lucide.dev' },
  { role: 'Fonts by', value: 'Google Fonts', url: 'https://fonts.google.com' },
];