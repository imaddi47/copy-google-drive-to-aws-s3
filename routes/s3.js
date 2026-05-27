import { Router } from 'express';
import {
  listObjects,
  objectExists,
  isValidBucketName,
  listRegionsForConfig,
  deleteObject,
  deleteObjects,
} from '../services/awsS3.js';
import { config, normalizePrefix, sanitizeObjectName } from '../config/config.js';

const router = Router();

router.get('/config', (req, res) => {
  res.json({
    bucket: config.aws.bucket,
    region: config.aws.region,
    defaultPrefix: config.aws.defaultPrefix,
  });
});

router.get('/regions', (req, res) => {
  res.json(listRegionsForConfig());
});

router.get('/objects', async (req, res) => {
  try {
    const bucket = req.query.bucket || config.aws.bucket;
    if (!bucket) {
      return res.status(400).json({ error: 'bucket required (set S3_BUCKET or pass ?bucket=)' });
    }
    if (!isValidBucketName(bucket)) {
      return res.status(400).json({ error: `Invalid bucket name: ${bucket}` });
    }
    const prefix =
      req.query.prefix !== undefined ? req.query.prefix : config.aws.defaultPrefix;
    const data = await listObjects({
      bucket,
      region: req.query.region || undefined,
      prefix,
      continuationToken: req.query.continuationToken,
    });
    res.json({ bucket, prefix: normalizePrefix(prefix), ...data });
  } catch (err) {
    console.error('S3 list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/check-existing', async (req, res) => {
  try {
    const { bucket, region, prefix, names } = req.body || {};
    const targetBucket = bucket || config.aws.bucket;
    if (!targetBucket || !isValidBucketName(targetBucket)) {
      return res.status(400).json({ error: 'valid bucket required' });
    }
    if (!Array.isArray(names)) {
      return res.status(400).json({ error: 'names array required' });
    }
    const safePrefix = normalizePrefix(prefix || '');
    const results = await Promise.all(
      names.map(async (name) => {
        const safeName = sanitizeObjectName(name);
        if (!safeName) {
          return { name, key: null, exists: false, invalid: true };
        }
        const key = `${safePrefix}${safeName}`;
        const exists = await objectExists({
          bucket: targetBucket,
          region: region || undefined,
          key,
        });
        return { name, key, exists };
      }),
    );
    res.json({ bucket: targetBucket, results });
  } catch (err) {
    console.error('S3 check error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Defensive key validation reused by both single + bulk delete. Returns the
// key when safe, or null when it tries to escape via leading slash / dot-dot.
const safeDeleteKey = (key) =>
  typeof key === 'string' && key && !key.startsWith('/') && !key.includes('..')
    ? key
    : null;

router.delete('/objects', async (req, res) => {
  try {
    const { bucket, region, key, keys } = req.body || {};
    const targetBucket = bucket || config.aws.bucket;
    if (!targetBucket || !isValidBucketName(targetBucket)) {
      return res.status(400).json({ error: 'valid bucket required' });
    }

    // Bulk path — `keys: string[]`
    if (Array.isArray(keys)) {
      if (keys.length === 0) {
        return res.status(400).json({ error: 'keys array is empty' });
      }
      const safe = [];
      const invalid = [];
      for (const k of keys) {
        const cleaned = safeDeleteKey(k);
        if (cleaned) safe.push(cleaned);
        else invalid.push(k);
      }
      if (safe.length === 0) {
        return res.status(400).json({ error: 'no valid keys', invalid });
      }
      const result = await deleteObjects({
        bucket: targetBucket,
        region: region || undefined,
        keys: safe,
      });
      return res.json({ ok: true, bucket: targetBucket, ...result, invalid });
    }

    // Single path — `key: string`
    const safe = safeDeleteKey(key);
    if (!safe) {
      return res.status(400).json({ error: 'valid key required' });
    }
    await deleteObject({ bucket: targetBucket, region: region || undefined, key: safe });
    res.json({ ok: true, bucket: targetBucket, key: safe });
  } catch (err) {
    console.error('S3 delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
