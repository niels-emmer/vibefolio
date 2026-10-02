/**
 * Backup & restore endpoints (see docs/decisions.md D25).
 *
 * Mounted at `/api/admin`, ahead of `routes/admin.js`, so the download route is matched
 * before the admin router's `requireAuth` middleware runs — it would otherwise run twice
 * for these paths. Auth is applied here in the same shape.
 *
 * The three-step flow, and why it is three steps:
 *
 *   1. `GET /backup`                     — build the archive and stream it as a download.
 *   2. `POST /restore/inspect`           — upload the file, validate it, stage it, and
 *                                          answer with the category overview the modal
 *                                          shows. Nothing is written yet.
 *   3. `POST /restore/apply`             — name the staged upload and the categories to
 *                                          restore. The archive is taken from the staging
 *                                          area, never from this request.
 */
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import * as backup from '../backup.js';
import * as store from '../db.js';

const router = Router();

// This router owns `/api/admin/backup*` and `/api/admin/restore*` — and only those. Both
// middlewares are scoped to the prefixes rather than applied with a bare `router.use(mw)`,
// which would run for *every* `/api/admin/*` request: this router does not answer
// `/api/admin/login`, so `requireAuth` would refuse it with a 401 before the admin router
// ever saw it. (The admin router gets away with the bare form because its own unauthenticated
// routes are registered above it.)
const OWNED = ['/backup', '/restore'];

// Same rule as the admin API: nothing on these paths may be stored by an intermediary or
// the browser's disk cache — they carry a full copy of the site's content.
router.use(OWNED, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.use(OWNED, requireAuth);

// A restore is expensive — gunzip, a full parse and a validation pass, all synchronous. The
// login limiter's pattern applies here for the same reason: a session that hammers this is
// either a bug or an attacker who already has the cookie, and neither should be able to pin
// the event loop.
const inspectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many restore uploads. Try again later.' },
});

// --- Backup ----------------------------------------------------------------

router.get('/backup', (req, res) => {
  const buf = backup.serializeArchive(backup.buildArchive());
  res.set('Content-Type', 'application/gzip');
  res.set('Content-Disposition', `attachment; filename="${backup.archiveFilename()}"`);
  res.set('Content-Length', String(buf.length));
  res.send(buf);
});

// --- Restore ---------------------------------------------------------------

// The file arrives as raw bytes, not as JSON or multipart — the browser can post a File
// object directly, so no upload dependency is needed to move one.
//
// The raw parser is registered *on the route*, after `requireAuth`, and not app-wide on this
// path: a parser mounted before the auth middleware buffers the whole body before anything
// can refuse the request, so an unauthenticated client could pin a full-size body per
// connection against a container capped at 256 MB. Registered here, an anonymous request is
// refused before a single byte is buffered. It still works because `express.json` skips a
// non-JSON content-type without consuming the stream (see the parser ordering note in
// src/server.js).
router.post(
  '/restore/inspect',
  inspectLimiter,
  express.raw({
    type: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    limit: backup.MAX_UPLOAD_BYTES,
  }),
  (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      return res.status(400).json({
        error: 'Send the archive as raw bytes with Content-Type: application/gzip.',
      });
    }

    let archive;
    try {
      archive = backup.parseArchive(body);
    } catch (err) {
      if (err instanceof backup.ArchiveError) return res.status(400).json({ error: err.message });
      throw err;
    }

    const { uploadId, expiresAt } = backup.stageArchive(archive, req.sessionToken);
    res.json({
      uploadId,
      expiresAt,
      // The live settings are passed so the overview can flag a category whose archive is
      // empty while the deployment holds something — the only way a restore silently changes
      // the site's appearance (an archive from before the wallpaper existed, say).
      archive: { ...backup.summarize(archive, store.getAllSettings()), size: body.length },
    });
  }
);

router.post('/restore/apply', (req, res) => {
  const { uploadId, categories } = req.body ?? {};

  if (typeof uploadId !== 'string' || uploadId === '') {
    return res.status(400).json({ error: 'uploadId is required' });
  }

  const archive = backup.getStaged(uploadId, req.sessionToken);
  if (!archive) {
    return res.status(409).json({ error: 'That upload has expired — choose the file again.' });
  }

  // Captured before anything is written: this is the "what does the deployment have right now"
  // side of the comparison below, and after `applyRestore` it would be the archive's own state.
  const liveBefore = store.getAllSettings();

  // Categories are checked before the snapshot is written, so a request that names a
  // category this build does not have does not leave a snapshot behind for a restore that
  // never happened.
  let wanted;
  try {
    wanted = backup.normalizeCategories(categories);
  } catch (err) {
    if (err instanceof backup.ArchiveError) return res.status(400).json({ error: err.message });
    throw err;
  }

  // The safety net, and the reason the modal can say "you might want to make a backup
  // first" and then not rely on it: the state being overwritten is written to the data
  // directory first, as an archive that can be fed straight back through this same flow.
  //
  // Failing here fails the whole request, before the transaction: a restore with no undo
  // point is not one the admin agreed to. An unwritable directory is an operator error, so
  // it gets a message that says so rather than a bare 500.
  let snapshot;
  try {
    snapshot = backup.writeSnapshot(backup.serializeArchive(backup.buildArchive()));
  } catch (err) {
    console.error('[backup] could not write the pre-restore snapshot:', err.message);
    return res.status(500).json({
      error: 'Could not write the pre-restore snapshot, so nothing was restored. Check that BACKUP_DIR is writable.',
    });
  }

  // What this restore is about to remove. Computed here, against the settings as they are
  // *now*, rather than trusting the flag the inspect step sent — the modal may have been open
  // for a while, and the whole point of the warning is the case where the live state changed
  // since the overview was drawn (another tab uploaded a wallpaper, say). The apply step is
  // the last moment the server can see both sides at once, so it recomputes and reports.
  //
  // Reported, not enforced: the admin confirmed the restore, and refusing it now would be a
  // worse outcome than doing what they asked and telling them what it cost.
  const cleared = [];
  for (const category of backup.summarize(archive, liveBefore).categories) {
    if (category.clears && wanted.has(category.id)) cleared.push(category.clears);
  }

  let applied;
  try {
    applied = backup.applyRestore(archive, categories);
  } catch (err) {
    // The transaction rolled back, so the database is untouched and the snapshot is intact.
    // The staged upload is deliberately left in place: an unexpected failure here is most
    // likely transient, and re-uploading the file to retry would be a worse experience than
    // holding one archive (MAX_STAGED bounds that to one) until its TTL.
    if (err instanceof backup.ArchiveError) return res.status(400).json({ error: err.message });
    throw err;
  }

  backup.discardStaged(uploadId, req.sessionToken);
  res.json({ ok: true, applied, cleared, snapshot });
});

// Called when the modal is dismissed, so a validated archive does not sit in memory for the
// rest of its TTL.
router.post('/restore/discard', (req, res) => {
  backup.discardStaged(req.body?.uploadId, req.sessionToken);
  res.json({ ok: true });
});

// --- Pre-restore snapshots -------------------------------------------------

router.get('/backup/snapshots', (req, res) => {
  res.json({ snapshots: backup.listSnapshots() });
});

router.get('/backup/snapshots/:name', (req, res) => {
  const buf = backup.readSnapshot(req.params.name);
  if (!buf) return res.status(404).json({ error: 'Snapshot not found' });
  res.set('Content-Type', 'application/gzip');
  res.set('Content-Disposition', `attachment; filename="${req.params.name}"`);
  res.set('Content-Length', String(buf.length));
  res.send(buf);
});

export default router;
