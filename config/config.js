import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Standard dotenv load — fills in keys that aren't already in the process env.
dotenv.config();

// AWS-related keys are a special case: users frequently have stale exports in
// `~/.zshrc` (or similar) that silently win against `.env`. For these specific
// keys, `.env` always overrides the parent shell. Other keys (PORT,
// SESSION_SECRET, GOOGLE_*) follow standard dotenv precedence so wrappers
// like Claude Preview's launch.json can still inject them.
const FORCE_OVERRIDE_KEYS = [
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    for (const key of FORCE_OVERRIDE_KEYS) {
      if (parsed[key] !== undefined && parsed[key] !== '') {
        process.env[key] = parsed[key];
      }
    }
  }
} catch {
  // Non-fatal — if .env can't be re-parsed for any reason, the standard
  // dotenv.config() above has already done its job.
}

const DEFAULT_DEV_SECRET = 'dev-only-secret-change-me';

export const config = {
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || DEFAULT_DEV_SECRET,

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ||
      `http://localhost:${process.env.PORT || 3000}/auth/google/callback`,
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    defaultFolderId: process.env.DEFAULT_DRIVE_FOLDER_ID || '',
  },

  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    profile: process.env.AWS_PROFILE || 'default',
    bucket: process.env.S3_BUCKET || '',
    defaultPrefix: normalizePrefix(process.env.S3_DEFAULT_PREFIX || ''),
  },
};

export function normalizePrefix(prefix) {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

export function validateConfig() {
  const missing = [];
  if (!config.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!config.aws.bucket) missing.push('S3_BUCKET');
  if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
  return missing;
}

export const isUsingDefaultSessionSecret = () =>
  config.sessionSecret === DEFAULT_DEV_SECRET;

export const randomToken = (bytes = 24) =>
  crypto.randomBytes(bytes).toString('base64url');

// Sanitize an S3 object name supplied by the client. Strips path separators,
// leading dots, and any directory-traversal sequences so the resulting key
// can only ever land under the intended prefix.
export const sanitizeObjectName = (name) => {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  // Reject anything that tries to escape the prefix.
  if (trimmed.split(/[\\/]/).some((seg) => seg === '..')) return '';
  // Collapse to basename and strip leading dots/whitespace.
  const basename = trimmed.split(/[\\/]/).pop();
  return basename.replace(/^\.+/, '').trim();
};
