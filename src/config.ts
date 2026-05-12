import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { PROJECT_ROOT } from './project-root.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'OLLAMA_ADMIN_TOOLS',
  'ONECLI_URL',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_PORT',
  'STRIPE_EXPORT_GROUP',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_POOL',
  'TZ',
  'GDRIVE_KEY_PATH',
  'GDRIVE_UPLOAD_FOLDER_ID',
  'GDRIVE_PROXY_PORT',
  'BW_CLIENTID',
  'BW_CLIENTSECRET',
  'BW_PASSWORD',
  'BW_PROXY_PORT',
  'BW_PROXY_SECRET',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const OLLAMA_ADMIN_TOOLS =
  (process.env.OLLAMA_ADMIN_TOOLS || envConfig.OLLAMA_ADMIN_TOOLS) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const HOME_DIR = process.env.HOME || os.homedir();
export { PROJECT_ROOT };

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// Stripe webhook receiver — opt-in. Server only starts if STRIPE_WEBHOOK_SECRET is set.
export const STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET || envConfig.STRIPE_WEBHOOK_SECRET || '';
export const STRIPE_WEBHOOK_PORT = parseInt(
  process.env.STRIPE_WEBHOOK_PORT || envConfig.STRIPE_WEBHOOK_PORT || '3101',
  10,
);
// Which group folder receives the transactions.json mirror file. Defaults to main.
export const STRIPE_EXPORT_GROUP =
  process.env.STRIPE_EXPORT_GROUP || envConfig.STRIPE_EXPORT_GROUP || 'main';

// Google Drive proxy — opt-in. Server only starts if GDRIVE_KEY_PATH is set.
export const GDRIVE_KEY_PATH =
  process.env.GDRIVE_KEY_PATH || envConfig.GDRIVE_KEY_PATH || '';
export const GDRIVE_UPLOAD_FOLDER_ID =
  process.env.GDRIVE_UPLOAD_FOLDER_ID ||
  envConfig.GDRIVE_UPLOAD_FOLDER_ID ||
  '';
export const GDRIVE_PROXY_PORT = parseInt(
  process.env.GDRIVE_PROXY_PORT || envConfig.GDRIVE_PROXY_PORT || '3102',
  10,
);

export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';

export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

// Shared HMAC secret for signing vault tokens. Generated randomly at first run
// and stored in .env — never changes, never leaves the host.
export const BW_PROXY_SECRET =
  process.env.BW_PROXY_SECRET || envConfig.BW_PROXY_SECRET || '';

// Bitwarden credential proxy — opt-in. Only starts when all three BW_ vars are set.
export const BW_CLIENTID =
  process.env.BW_CLIENTID || envConfig.BW_CLIENTID || '';
export const BW_CLIENTSECRET =
  process.env.BW_CLIENTSECRET || envConfig.BW_CLIENTSECRET || '';
export const BW_PASSWORD =
  process.env.BW_PASSWORD || envConfig.BW_PASSWORD || '';
export const BW_PROXY_PORT = parseInt(
  process.env.BW_PROXY_PORT || envConfig.BW_PROXY_PORT || '3103',
  10,
);
