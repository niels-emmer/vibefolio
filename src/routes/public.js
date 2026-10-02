import { Router } from 'express';
import { publicSettings, listPublicServices } from '../public-data.js';

const router = Router();

// Public site metadata.
router.get('/site', (req, res) => {
  res.json(publicSettings());
});

// Public list of enabled services with live status.
router.get('/services', (req, res) => {
  res.json({ services: listPublicServices() });
});

export default router;
