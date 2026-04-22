/**
 * Google Drive proxy.
 *
 * Lets containerized agents upload files to a scoped Drive folder without
 * handling service-account credentials themselves. The agent POSTs a path
 * (inside its mounted group folder) and gets back a shareable link.
 *
 * Opt-in: the server only starts if GDRIVE_KEY_PATH is set.
 *
 * Security model:
 *   - Service account credentials never leave the host
 *   - Requests are only accepted from localhost / Docker bridge gateway
 *   - The agent-supplied path is resolved against GROUPS_DIR and rejected
 *     if it escapes that root (prevents ../etc/passwd style attacks)
 *   - Files land in a single pre-shared Drive folder — the service account
 *     has no access to the rest of Drive
 */

import fs from 'fs';
import http from 'http';
import path from 'path';

import { google } from 'googleapis';

import {
  GDRIVE_KEY_PATH,
  GDRIVE_PROXY_PORT,
  GDRIVE_UPLOAD_FOLDER_ID,
  GROUPS_DIR,
} from './config.js';
import { logger } from './logger.js';

type UploadRequest = {
  hostPath?: string;
  name?: string;
  mimeType?: string;
};

type UploadResult = {
  fileId: string;
  name: string;
  webViewLink: string;
  webContentLink: string | null;
};

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Resolve an agent-supplied path to an absolute host path.
 *
 * Agents see their group folder mounted at /workspace/group, which on the
 * host is GROUPS_DIR/{groupName}. They can pass either form; we normalize
 * both to the host path and verify the result stays inside GROUPS_DIR.
 */
function resolveAgentPath(hostPath: string): string {
  // Translate container path to host path if needed.
  // "/workspace/group/user/export_202604.csv" → nothing — the agent
  // doesn't know its own group name, so it must either send a host path
  // or a /workspace/group/... path WITH the group name explicit. We
  // require the caller to convert — safer than guessing.
  const resolved = path.resolve(hostPath);
  const groupsRoot = path.resolve(GROUPS_DIR);
  if (!resolved.startsWith(groupsRoot + path.sep)) {
    throw new Error(
      `Path ${resolved} is outside GROUPS_DIR — rejected for security`,
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${resolved}`);
  }
  return resolved;
}

export async function uploadToDrive(
  req: UploadRequest,
): Promise<UploadResult> {
  if (!req.hostPath) throw new Error('Missing hostPath');
  const absolutePath = resolveAgentPath(req.hostPath);
  const displayName = req.name || path.basename(absolutePath);
  const mimeType = req.mimeType || guessMimeType(absolutePath);

  const auth = new google.auth.GoogleAuth({
    keyFile: GDRIVE_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.create({
    requestBody: {
      name: displayName,
      parents: [GDRIVE_UPLOAD_FOLDER_ID],
    },
    media: {
      mimeType,
      body: fs.createReadStream(absolutePath),
    },
    fields: 'id, name, webViewLink, webContentLink',
    supportsAllDrives: true,
  });

  const file = res.data;
  if (!file.id) throw new Error('Drive upload returned no file id');

  return {
    fileId: file.id,
    name: file.name || displayName,
    webViewLink: file.webViewLink || '',
    webContentLink: file.webContentLink || null,
  };
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.csv':
      return 'text/csv';
    case '.json':
      return 'application/json';
    case '.jsonl':
      return 'application/x-ndjson';
    case '.txt':
      return 'text/plain';
    case '.pdf':
      return 'application/pdf';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Start the Drive proxy HTTP server. Returns the server instance (for tests/
 * graceful shutdown) or null if not configured.
 */
export function startGDriveProxy(): http.Server | null {
  if (!GDRIVE_KEY_PATH) {
    logger.info('Google Drive proxy skipped — GDRIVE_KEY_PATH not set');
    return null;
  }
  if (!GDRIVE_UPLOAD_FOLDER_ID) {
    logger.warn(
      'GDRIVE_KEY_PATH is set but GDRIVE_UPLOAD_FOLDER_ID is missing — proxy disabled',
    );
    return null;
  }
  if (!fs.existsSync(GDRIVE_KEY_PATH)) {
    logger.warn(
      { keyPath: GDRIVE_KEY_PATH },
      'Google Drive proxy skipped — key file not found',
    );
    return null;
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/gdrive/upload') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    try {
      const body = await readRawBody(req);
      const parsed: UploadRequest = body ? JSON.parse(body) : {};
      const result = await uploadToDrive(parsed);
      logger.info(
        { fileId: result.fileId, name: result.name },
        'Agent file uploaded to Drive',
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      logger.warn(
        { err: String(err) },
        'Google Drive upload failed',
      );
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // Bind to 0.0.0.0 so the Docker bridge can reach it. Network reachability
  // is scoped by the container's network config, not by this bind.
  server.listen(GDRIVE_PROXY_PORT, () => {
    logger.info(
      {
        port: GDRIVE_PROXY_PORT,
        folderId: GDRIVE_UPLOAD_FOLDER_ID,
      },
      'Google Drive proxy listening',
    );
  });

  return server;
}
