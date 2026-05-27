import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';

import { config, validateConfig, isUsingDefaultSessionSecret } from './config/config.js';
import authRouter from './routes/auth.js';
import driveRouter from './routes/drive.js';
import s3Router from './routes/s3.js';
import transferRouter from './routes/transfer.js';
import { describeCredentialSource, partitionForRegion } from './services/awsS3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    name: 'mabu.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 8,
    },
  }),
);

app.get('/api/config-status', (req, res) => {
  const missing = validateConfig();
  res.json({
    ok: missing.length === 0,
    missing,
    bucket: config.aws.bucket || null,
    region: config.aws.region,
    defaultPrefix: config.aws.defaultPrefix,
    driveFolderId: config.google.defaultFolderId || null,
  });
});

app.use('/auth', authRouter);
app.use('/api/drive', driveRouter);
app.use('/api/s3', s3Router);
app.use('/api/transfer', transferRouter);

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(config.port, () => {
  const missing = validateConfig();
  console.log(`\nMobile-apps China build drop ready: http://localhost:${config.port}`);
  console.log(
    `AWS:  region=${config.aws.region} ` +
      `partition=${partitionForRegion(config.aws.region)} ` +
      `credentials=${describeCredentialSource()}`,
  );
  if (missing.length > 0) {
    console.warn(`Missing config: ${missing.join(', ')}`);
    console.warn('Copy .env.example to .env and fill in the values.\n');
  } else {
    console.log(`S3 target: s3://${config.aws.bucket}/${config.aws.defaultPrefix}\n`);
  }
  if (isUsingDefaultSessionSecret()) {
    console.warn(
      'WARNING: SESSION_SECRET is unset — using a built-in dev fallback.',
    );
    console.warn(
      '         Anyone who knows the source can forge session cookies. Set a random SESSION_SECRET in .env before exposing this beyond localhost.\n',
    );
  }
});
