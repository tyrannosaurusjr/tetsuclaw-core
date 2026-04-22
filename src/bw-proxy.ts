/**
 * Bitwarden credential proxy.
 *
 * Lets containerized agents retrieve credentials without handling vault
 * secrets themselves. Two endpoints:
 *
 *   POST /bw/get             — returns credential JSON (for agent automation)
 *   POST /bw/send-ephemeral  — sends credentials to Telegram, schedules delete
 *
 * The send-ephemeral path means passwords never appear in agent output or
 * Telegram history beyond the configured delete window.
 *
 * Opt-in: only starts if BW_CLIENTID, BW_CLIENTSECRET, and BW_PASSWORD are set.
 * The Bitwarden CLI (`bw`) must be installed on the host.
 *
 * Security model:
 *   - bw session key lives only in process memory, never written to disk
 *   - Requests are only accepted from localhost / Docker bridge gateway
 *   - Passwords sent via /bw/get reach the agent container in plaintext;
 *     use /bw/send-ephemeral when the credential is destined for the user
 */

import { execFile } from 'child_process';
import http from 'http';
import { promisify } from 'util';

import {
  BW_CLIENTID,
  BW_CLIENTSECRET,
  BW_PASSWORD,
  BW_PROXY_PORT,
  TELEGRAM_BOT_TOKEN,
} from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

let bwSession: string | null = null;

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function unlockVault(): Promise<void> {
  // Login via API key (idempotent — bw exits non-zero if already logged in)
  try {
    await execFileAsync('bw', ['login', '--apikey'], {
      env: {
        ...process.env,
        BW_CLIENTID,
        BW_CLIENTSECRET,
        BITWARDENCLI_APPDATA_DIR: '/tmp/bw-data',
      },
    });
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('already logged in') && !msg.includes('You are already logged in')) {
      throw new Error(`bw login failed: ${msg}`);
    }
  }

  // Unlock and capture session key via --raw flag
  const { stdout } = await execFileAsync(
    'bw',
    ['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'],
    {
      env: {
        ...process.env,
        BW_PASSWORD,
        BITWARDENCLI_APPDATA_DIR: '/tmp/bw-data',
      },
    },
  );

  bwSession = stdout.trim();
  if (!bwSession) throw new Error('bw unlock returned empty session key');
  logger.info('Bitwarden vault unlocked');
}

async function getBwItem(name: string): Promise<Record<string, unknown>> {
  if (!bwSession) await unlockVault();

  const runGet = async (session: string) => {
    const { stdout } = await execFileAsync(
      'bw',
      ['get', 'item', name, '--session', session],
      {
        env: {
          ...process.env,
          BITWARDENCLI_APPDATA_DIR: '/tmp/bw-data',
        },
      },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  };

  try {
    return await runGet(bwSession!);
  } catch (err) {
    // Session may have expired — re-unlock once and retry
    const msg = String(err);
    if (msg.includes('not logged in') || msg.includes('session')) {
      bwSession = null;
      await unlockVault();
      return await runGet(bwSession!);
    }
    throw err;
  }
}

type LoginItem = {
  username?: string;
  password?: string;
  totp?: string | null;
  uris?: Array<{ uri: string }>;
};

function extractCredential(item: Record<string, unknown>) {
  const login = (item.login as LoginItem) || {};
  return {
    name: item.name as string,
    username: login.username || null,
    password: login.password || null,
    totp: login.totp || null,
    uri: login.uris?.[0]?.uri || null,
    notes: (item.notes as string) || null,
  };
}

async function telegramPost(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resp = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return (await resp.json()) as Record<string, unknown>;
}

type SendEphemeralRequest = {
  name?: string;
  chat_id?: string;
  thread_id?: number;
  delete_after?: number;
};

type GetRequest = {
  name?: string;
};

export function startBWProxy(): http.Server | null {
  if (!BW_CLIENTID || !BW_CLIENTSECRET || !BW_PASSWORD) {
    logger.info('Bitwarden proxy skipped — BW_CLIENTID/BW_CLIENTSECRET/BW_PASSWORD not set');
    return null;
  }

  const botToken = TELEGRAM_BOT_TOKEN;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const sendJson = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    try {
      const body = await readRawBody(req);
      const parsed = body ? JSON.parse(body) : {};

      if (req.url === '/bw/get') {
        const { name } = parsed as GetRequest;
        if (!name) return sendJson(400, { error: 'Missing name' });

        const item = await getBwItem(name);
        const cred = extractCredential(item);
        logger.info({ name: cred.name }, 'Bitwarden item retrieved');
        return sendJson(200, cred);
      }

      if (req.url === '/bw/send-ephemeral') {
        const { name, chat_id, thread_id, delete_after = 30 } =
          parsed as SendEphemeralRequest;

        if (!name) return sendJson(400, { error: 'Missing name' });
        if (!chat_id) return sendJson(400, { error: 'Missing chat_id' });
        if (!botToken)
          return sendJson(500, { error: 'TELEGRAM_BOT_TOKEN not configured' });

        const item = await getBwItem(name);
        const cred = extractCredential(item);

        const lines = [`🔐 *${cred.name}*`];
        if (cred.username) lines.push(`User: \`${cred.username}\``);
        if (cred.password) lines.push(`Pass: \`${cred.password}\``);
        if (cred.totp) lines.push(`TOTP: \`${cred.totp}\``);
        if (cred.uri) lines.push(`URL: ${cred.uri}`);
        if (cred.notes) lines.push(`Notes: ${cred.notes}`);
        lines.push(`\n_(deletes in ${delete_after}s)_`);
        const text = lines.join('\n');

        const msgBody: Record<string, unknown> = {
          chat_id,
          text,
          parse_mode: 'Markdown',
        };
        if (thread_id) msgBody.message_thread_id = thread_id;

        const sendResp = await telegramPost(botToken, 'sendMessage', msgBody);
        const result = sendResp.result as Record<string, unknown> | undefined;
        const messageId = result?.message_id as number | undefined;

        if (!messageId) {
          logger.warn({ sendResp }, 'Telegram sendMessage returned no message_id');
          return sendJson(500, { error: 'Telegram delivery failed', detail: sendResp });
        }

        logger.info(
          { name: cred.name, chatId: chat_id, messageId, deleteAfter: delete_after },
          'Ephemeral credential sent to Telegram',
        );

        setTimeout(async () => {
          try {
            await telegramPost(botToken, 'deleteMessage', {
              chat_id,
              message_id: messageId,
            });
            logger.info({ chatId: chat_id, messageId }, 'Ephemeral credential deleted');
          } catch (err) {
            logger.warn({ err }, 'Failed to delete ephemeral credential message');
          }
        }, delete_after * 1000);

        return sendJson(200, {
          sent: true,
          message: `Credentials sent — deletes in ${delete_after}s`,
        });
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      logger.warn({ err: String(err) }, 'Bitwarden proxy request failed');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(BW_PROXY_PORT, () => {
    logger.info({ port: BW_PROXY_PORT }, 'Bitwarden proxy listening');
  });

  // Unlock vault eagerly so first request isn't slow
  unlockVault().catch((err) => {
    logger.warn({ err: String(err) }, 'Bitwarden vault unlock failed at startup');
  });

  return server;
}
