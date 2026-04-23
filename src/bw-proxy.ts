/**
 * Bitwarden credential proxy.
 *
 * Lets containerized agents retrieve credentials without handling vault
 * secrets themselves. Two endpoints:
 *
 *   POST /bw/get             — returns credential JSON (for agent automation)
 *   POST /bw/send-ephemeral  — sends credentials to Telegram, schedules delete
 *
 * Security model (three layers):
 *
 *   1. Signed vault token — every request must include NANOCLAW_VAULT_TOKEN,
 *      an HMAC-SHA256 signed blob containing the authorized chat_id and expiry.
 *      The proxy extracts chat_id from the token; agent-supplied chat_id is
 *      ignored. Prevents prompt injection from forging a delivery target.
 *
 *   2. Confirmation gate — before delivering credentials, the proxy sends a
 *      "did you ask for X?" message to the token-verified chat. Credentials
 *      are held in a pending map until the user replies "yes" (60s window).
 *      The reply is intercepted by the main message handler, not the agent,
 *      so injected instructions cannot fake the confirmation.
 *
 *   3. Item prefix scoping — vault items should be named "[scope] Item Name"
 *      (e.g., "[money] MUFG Bank"). The proxy logs a warning when an agent
 *      requests an item outside its declared scope and blocks cross-scope access.
 *
 * Opt-in: only starts if BW_CLIENTID, BW_CLIENTSECRET, BW_PASSWORD, and
 * BW_PROXY_SECRET are all set. The Bitwarden CLI (`bw`) must be installed.
 */

import { createHmac } from 'crypto';
import { execFile } from 'child_process';
import http from 'http';
import { promisify } from 'util';

import {
  BW_CLIENTID,
  BW_CLIENTSECRET,
  BW_PASSWORD,
  BW_PROXY_PORT,
  BW_PROXY_SECRET,
  TELEGRAM_BOT_TOKEN,
} from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// ---------- Vault token ----------

/**
 * Create a signed vault token for a container spawn.
 * Token format: {chatId}|{expiry}|{hmac}
 * hmac = HMAC-SHA256("{chatId}|{expiry}|{scope}", BW_PROXY_SECRET)
 */
export function createVaultToken(
  chatId: string,
  scope: string,
  ttlMs = 1_800_000, // 30 min — matches CONTAINER_TIMEOUT default
): string {
  const expiry = Date.now() + ttlMs;
  const payload = `${chatId}|${expiry}|${scope}`;
  const hmac = createHmac('sha256', BW_PROXY_SECRET)
    .update(payload)
    .digest('hex');
  return `${payload}|${hmac}`;
}

type TokenClaims = { chatId: string; scope: string; expiry: number };

function verifyVaultToken(token: string): TokenClaims {
  const parts = token.split('|');
  if (parts.length !== 4) throw new Error('Invalid vault token format');
  const [chatId, expiryStr, scope, hmac] = parts;
  const payload = `${chatId}|${expiryStr}|${scope}`;
  const expected = createHmac('sha256', BW_PROXY_SECRET)
    .update(payload)
    .digest('hex');
  if (hmac !== expected) throw new Error('Vault token signature invalid');
  const expiry = parseInt(expiryStr, 10);
  if (Date.now() > expiry) throw new Error('Vault token expired');
  return { chatId, scope, expiry };
}

// ---------- Confirmation gate ----------

type PendingConfirmation = {
  resolve: () => void;
  reject: (err: Error) => void;
  chatId: string;
  itemName: string;
  nonce: string;
};

const pendingConfirmations = new Map<string, PendingConfirmation>();

function generateNonce(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

/** Called by the main message handler when user replies "yes". */
export function confirmVaultRequest(chatJid: string): boolean {
  const chatId = chatJid.replace(/^tg:/, '');
  for (const [nonce, pending] of pendingConfirmations) {
    if (pending.chatId === chatId) {
      pending.resolve();
      pendingConfirmations.delete(nonce);
      return true;
    }
  }
  return false;
}

/** Returns true if a vault confirmation is awaiting a reply for this chat. */
export function hasPendingVaultConfirmation(chatJid: string): boolean {
  const chatId = chatJid.replace(/^tg:/, '');
  for (const pending of pendingConfirmations.values()) {
    if (pending.chatId === chatId) return true;
  }
  return false;
}

function waitForConfirmation(
  chatId: string,
  itemName: string,
  timeoutMs = 60_000,
): { promise: Promise<void>; nonce: string } {
  const nonce = generateNonce();
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingConfirmations.delete(nonce);
      reject(new Error('Vault confirmation timed out (60s)'));
    }, timeoutMs);

    pendingConfirmations.set(nonce, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
      chatId,
      itemName,
      nonce,
    });
  });
  return { promise, nonce };
}

// ---------- Telegram helpers ----------

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

async function sendConfirmationPrompt(
  botToken: string,
  chatId: string,
  threadId: number | undefined,
  itemName: string,
  nonce: string,
): Promise<void> {
  const msgBody: Record<string, unknown> = {
    chat_id: chatId,
    text: `⚠️ *Vault request*\nAn agent is requesting credentials for *${itemName}*.\n\nDid you ask for this? Reply \`yes\` to confirm (60s window).\nRequest ID: \`${nonce}\``,
    parse_mode: 'Markdown',
  };
  if (threadId) msgBody.message_thread_id = threadId;
  await telegramPost(botToken, 'sendMessage', msgBody);
}

// ---------- Bitwarden CLI ----------

let bwSession: string | null = null;

async function unlockVault(): Promise<void> {
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
    if (
      !msg.includes('already logged in') &&
      !msg.includes('You are already logged in')
    ) {
      throw new Error(`bw login failed: ${msg}`);
    }
  }

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
      { env: { ...process.env, BITWARDENCLI_APPDATA_DIR: '/tmp/bw-data' } },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  };

  try {
    return await runGet(bwSession!);
  } catch (err) {
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

// ---------- Item scope enforcement ----------

/**
 * Extract scope prefix from item name, e.g. "[money] MUFG Bank" → "money".
 * Returns null for unscoped items.
 */
function extractItemScope(itemName: string): string | null {
  const match = itemName.match(/^\[([^\]]+)\]/);
  return match ? match[1].toLowerCase() : null;
}

function assertScopeAllowed(itemName: string, tokenScope: string): void {
  const itemScope = extractItemScope(itemName);
  if (!itemScope) return; // unscoped items are accessible to all agents
  if (tokenScope === 'main') return; // main group has full access
  if (itemScope !== tokenScope) {
    throw new Error(
      `Scope violation: agent scope "${tokenScope}" cannot access item scoped to "${itemScope}"`,
    );
  }
}

// ---------- HTTP server ----------

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

type GetRequest = { name?: string; vault_token?: string };

type SendEphemeralRequest = {
  name?: string;
  vault_token?: string;
  thread_id?: number;
  delete_after?: number;
};

export function startBWProxy(): http.Server | null {
  if (!BW_CLIENTID || !BW_CLIENTSECRET || !BW_PASSWORD) {
    logger.info(
      'Bitwarden proxy skipped — BW_CLIENTID/BW_CLIENTSECRET/BW_PASSWORD not set',
    );
    return null;
  }
  if (!BW_PROXY_SECRET) {
    logger.warn(
      'Bitwarden proxy skipped — BW_PROXY_SECRET not set (required for token signing)',
    );
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

      // --- POST /bw/get ---
      if (req.url === '/bw/get') {
        const { name, vault_token } = parsed as GetRequest;
        if (!name) return sendJson(400, { error: 'Missing name' });
        if (!vault_token) return sendJson(401, { error: 'Missing vault_token' });

        const claims = verifyVaultToken(vault_token);
        assertScopeAllowed(name, claims.scope);

        const item = await getBwItem(name);
        const cred = extractCredential(item);
        logger.info(
          { name: cred.name, scope: claims.scope, chatId: claims.chatId },
          'Bitwarden item retrieved',
        );
        return sendJson(200, cred);
      }

      // --- POST /bw/send-ephemeral ---
      if (req.url === '/bw/send-ephemeral') {
        const {
          name,
          vault_token,
          thread_id,
          delete_after = 30,
        } = parsed as SendEphemeralRequest;

        if (!name) return sendJson(400, { error: 'Missing name' });
        if (!vault_token) return sendJson(401, { error: 'Missing vault_token' });
        if (!botToken)
          return sendJson(500, { error: 'TELEGRAM_BOT_TOKEN not configured' });

        const claims = verifyVaultToken(vault_token);
        assertScopeAllowed(name, claims.scope);

        // Confirmation gate — send prompt and wait for user reply
        const { promise, nonce } = waitForConfirmation(claims.chatId, name);
        await sendConfirmationPrompt(
          botToken,
          claims.chatId,
          thread_id,
          name,
          nonce,
        );

        try {
          await promise;
        } catch (err) {
          return sendJson(403, { error: String(err) });
        }

        // Confirmed — fetch and deliver
        const item = await getBwItem(name);
        const cred = extractCredential(item);

        const lines = [`🔐 *${cred.name}*`];
        if (cred.username) lines.push(`User: \`${cred.username}\``);
        if (cred.password) lines.push(`Pass: \`${cred.password}\``);
        if (cred.totp) lines.push(`TOTP: \`${cred.totp}\``);
        if (cred.uri) lines.push(`URL: ${cred.uri}`);
        if (cred.notes) lines.push(`Notes: ${cred.notes}`);
        lines.push(`\n_(deletes in ${delete_after}s)_`);

        const msgBody: Record<string, unknown> = {
          chat_id: claims.chatId,
          text: lines.join('\n'),
          parse_mode: 'Markdown',
        };
        if (thread_id) msgBody.message_thread_id = thread_id;

        const sendResp = await telegramPost(botToken, 'sendMessage', msgBody);
        const result = sendResp.result as Record<string, unknown> | undefined;
        const messageId = result?.message_id as number | undefined;

        if (!messageId) {
          logger.warn({ sendResp }, 'Telegram sendMessage returned no message_id');
          return sendJson(500, {
            error: 'Telegram delivery failed',
            detail: sendResp,
          });
        }

        logger.info(
          { name: cred.name, chatId: claims.chatId, messageId, deleteAfter: delete_after },
          'Ephemeral credential sent to Telegram',
        );

        setTimeout(async () => {
          try {
            await telegramPost(botToken, 'deleteMessage', {
              chat_id: claims.chatId,
              message_id: messageId,
            });
            logger.info(
              { chatId: claims.chatId, messageId },
              'Ephemeral credential deleted',
            );
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

  unlockVault().catch((err) => {
    logger.warn({ err: String(err) }, 'Bitwarden vault unlock failed at startup');
  });

  return server;
}
