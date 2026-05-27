import { Router } from 'express';
import { listFiles } from '../services/googleDrive.js';
import { requireGoogleAuth } from '../middleware/auth.js';
import { config } from '../config/config.js';

const router = Router();

router.get('/default-folder', (req, res) => {
  res.json({ folderId: config.google.defaultFolderId || null });
});

router.get('/files', requireGoogleAuth, async (req, res) => {
  try {
    const folderId = req.query.folderId || config.google.defaultFolderId || undefined;
    const data = await listFiles(req.session.googleTokens, {
      folderId,
      pageToken: req.query.pageToken,
      query: req.query.q,
    });
    res.json({ folderId, ...data });
  } catch (err) {
    console.error('Drive list error:', err.message);
    const status = err.code === 401 || err.code === 403 ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
