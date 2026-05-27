import { google } from 'googleapis';
import { config } from '../config/config.js';

export const createOAuthClient = () => {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
};

export const buildAuthUrl = (oauth2Client, state) =>
  oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: config.google.scopes,
    state,
  });

const driveClient = (tokens) => {
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(tokens);
  return google.drive({ version: 'v3', auth: oauth2Client });
};

export const listFiles = async (
  tokens,
  { folderId, pageToken, pageSize = 200, query } = {},
) => {
  const drive = driveClient(tokens);
  const conditions = ['trashed = false'];
  if (folderId) conditions.push(`'${folderId}' in parents`);
  if (query) {
    const safe = query.replace(/'/g, "\\'");
    conditions.push(`name contains '${safe}'`);
  }

  const res = await drive.files.list({
    q: conditions.join(' and '),
    pageSize,
    pageToken,
    fields:
      'nextPageToken, files(id, name, mimeType, size, modifiedTime, iconLink, parents)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    orderBy: 'folder,name',
  });

  return res.data;
};

export const getFileMetadata = async (tokens, fileId) => {
  const drive = driveClient(tokens);
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, parents',
    supportsAllDrives: true,
  });
  return res.data;
};

export const downloadFileStream = async (tokens, fileId) => {
  const drive = driveClient(tokens);
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  return res.data;
};
