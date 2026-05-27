export const requireGoogleAuth = (req, res, next) => {
  if (!req.session?.googleTokens) {
    return res.status(401).json({ error: 'Not authenticated with Google' });
  }
  next();
};
