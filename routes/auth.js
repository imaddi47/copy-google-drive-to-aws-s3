import { Router } from 'express';
import { google } from 'googleapis';
import { createOAuthClient, buildAuthUrl } from '../services/googleDrive.js';
import { randomToken } from '../config/config.js';

const router = Router();

router.get('/google', (req, res) => {
  const state = randomToken();
  req.session.oauthState = state;
  const oauth2Client = createOAuthClient();
  res.redirect(buildAuthUrl(oauth2Client, state));
});

router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) {
    return res.redirect(`/?auth_error=${encodeURIComponent(String(error))}`);
  }
  if (!code) {
    return res.redirect('/?auth_error=missing_code');
  }

  const expectedState = req.session?.oauthState;
  delete req.session.oauthState;
  if (!expectedState || expectedState !== state) {
    return res.redirect('/?auth_error=invalid_state');
  }

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));
    req.session.googleTokens = tokens;

    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();
    req.session.googleUser = {
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    };
    res.redirect('/?auth=ok');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  res.json({
    authenticated: !!req.session?.googleTokens,
    google: req.session?.googleUser || null,
  });
});

export default router;
