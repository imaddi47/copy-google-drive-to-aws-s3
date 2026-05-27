import { Router } from 'express';
import {
  downloadFileStream,
  getFileMetadata,
} from '../services/googleDrive.js';
import { uploadStream, isValidBucketName } from '../services/awsS3.js';
import { requireGoogleAuth } from '../middleware/auth.js';
import { config, normalizePrefix, sanitizeObjectName } from '../config/config.js';

const router = Router();

router.post('/upload', requireGoogleAuth, async (req, res) => {
  const { items, prefix, bucket, region } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array required' });
  }

  const targetBucket = bucket || config.aws.bucket;
  if (!targetBucket || !isValidBucketName(targetBucket)) {
    return res.status(400).json({ error: 'valid bucket required' });
  }
  const targetRegion = region || undefined;

  const safePrefix = normalizePrefix(prefix || '');

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (event) => {
    res.write(`${JSON.stringify(event)}\n`);
  };

  for (const item of items) {
    const { fileId } = item || {};
    const safeName = sanitizeObjectName(item?.targetName);
    if (!fileId || !safeName) {
      emit({
        type: 'error',
        fileId: fileId || null,
        message: 'fileId and a valid targetName (no path separators) are required',
      });
      continue;
    }
    const key = `${safePrefix}${safeName}`;
    emit({ type: 'start', fileId, key });

    let driveStream = null;
    try {
      const meta = await getFileMetadata(req.session.googleTokens, fileId);
      driveStream = await downloadFileStream(req.session.googleTokens, fileId);

      const totalSize = meta.size ? Number(meta.size) : null;
      let lastEmitAt = 0;
      const onProgress = (p) => {
        const now = Date.now();
        const loaded = p?.loaded || 0;
        const total = (p?.total ?? totalSize) || null;
        const isFinal = total != null && loaded >= total;
        // Throttle to ~4 emissions/sec; always emit the final one.
        if (now - lastEmitAt < 250 && !isFinal) return;
        lastEmitAt = now;
        emit({ type: 'progress', fileId, key, loaded, total });
      };

      await uploadStream({
        bucket: targetBucket,
        region: targetRegion,
        key,
        body: driveStream,
        contentType: meta.mimeType || 'application/octet-stream',
        onProgress,
      });
      emit({
        type: 'success',
        fileId,
        key,
        size: meta.size ? Number(meta.size) : null,
      });
    } catch (err) {
      console.error('Transfer error for', fileId, '→', key, err.message);
      if (driveStream && typeof driveStream.destroy === 'function') {
        driveStream.destroy();
      }
      emit({ type: 'error', fileId, key, message: err.message });
    }
  }

  res.end();
});

export default router;
