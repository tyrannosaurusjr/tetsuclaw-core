/**
 * Model provider IPC handler.
 *
 * Keeps model CLI credentials on the trusted host process. Container agents send
 * structured IPC requests and receive sanitized text/JSON results.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

export const MODEL_PROVIDERS = ['codex', 'gemini', 'ollama', 'claude'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export type ProviderChoice = ModelProvider | 'auto';

interface ModelResult {
  success: boolean;
  message: string;
  data?: unknown;
}

interface ProviderStatus {
  provider: ModelProvider;
  available: boolean;
  detail: string;
  command?: string;
  model?: string;
  host?: string;
  models?: string[];
}

interface AskOptions {
  provider: ProviderChoice;
  prompt: string;
  system?: string;
  model?: string;
  timeoutMs: number;
}

const DEFAULT_PROVIDER_ORDER: ModelProvider[] = [
  'codex',
  'gemini',
  'ollama',
  'claude',
];
const MAX_PROMPT_CHARS = 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: ModelResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'model_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizeTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(5_000, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

export function normalizeProvider(value: unknown): ProviderChoice | undefined {
  if (value === 'auto') return 'auto';
  if (typeof value !== 'string') return undefined;
  return MODEL_PROVIDERS.includes(value as ModelProvider)
    ? (value as ModelProvider)
    : undefined;
}

export function parseProviderOrder(value: string | undefined): ModelProvider[] {
  if (!value?.trim()) return DEFAULT_PROVIDER_ORDER;

  const seen = new Set<ModelProvider>();
  const providers: ModelProvider[] = [];
  for (const raw of value.split(',')) {
    const provider = normalizeProvider(raw.trim());
    if (!provider || provider === 'auto' || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }

  return providers.length > 0 ? providers : DEFAULT_PROVIDER_ORDER;
}

function commandFor(provider: ModelProvider): string {
  switch (provider) {
    case 'codex':
      return process.env.CODEX_BIN || 'codex';
    case 'gemini':
      return process.env.GEMINI_BIN || 'gemini';
    case 'claude':
      return process.env.CLAUDE_BIN || 'claude';
    case 'ollama':
      return process.env.OLLAMA_BIN || 'ollama';
  }
}

function defaultModelFor(provider: ModelProvider): string | undefined {
  switch (provider) {
    case 'codex':
      return process.env.CODEX_MODEL || undefined;
    case 'gemini':
      return process.env.GEMINI_MODEL || undefined;
    case 'ollama':
      return process.env.OLLAMA_MODEL || undefined;
    case 'claude':
      return process.env.CLAUDE_MODEL || undefined;
  }
}

function providerEnv(provider: ModelProvider): NodeJS.ProcessEnv {
  const allowed = new Set([
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'TZ',
    'USER',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ]);

  const providerKeys: Record<ModelProvider, string[]> = {
    codex: [
      'CODEX_HOME',
      'CODEX_MODEL',
      'OPENAI_API_KEY',
      'OPENAI_ORG_ID',
      'OPENAI_ORGANIZATION',
      'OPENAI_PROJECT',
      'OPENAI_PROJECT_ID',
    ],
    gemini: [
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GOOGLE_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_LOCATION',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_GENAI_USE_VERTEXAI',
    ],
    ollama: ['OLLAMA_HOST', 'OLLAMA_MODEL'],
    claude: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_MODEL',
    ],
  };

  for (const key of providerKeys[provider]) {
    allowed.add(key);
  }
  for (const key of Object.keys(process.env)) {
    if (
      (provider === 'codex' && key.startsWith('CODEX_')) ||
      (provider === 'gemini' && key.startsWith('GEMINI_')) ||
      (provider === 'claude' && key.startsWith('CLAUDE_CODE_'))
    ) {
      allowed.add(key);
    }
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function checkCommand(
  provider: ModelProvider,
  args: string[],
): Promise<ProviderStatus> {
  const command = commandFor(provider);
  try {
    const result = await execFileAsync(command, args, {
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      env: providerEnv(provider),
    });
    const output = `${result.stdout}${result.stderr}`.trim();
    return {
      provider,
      available: true,
      command,
      model: defaultModelFor(provider),
      detail: `${output || 'installed'}; authentication is verified on first model_ask`,
    };
  } catch (err) {
    const error = err as Error & {
      code?: string | number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const detail =
      error.code === 'ENOENT'
        ? 'command not found'
        : error.stderr?.toString().trim() ||
          error.stdout?.toString().trim() ||
          error.message;
    return {
      provider,
      available: false,
      command,
      model: defaultModelFor(provider),
      detail,
    };
  }
}

function ollamaHost(): string {
  return process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
}

async function ollamaFetch(
  endpoint: string,
  init?: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${ollamaHost()}${endpoint}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getOllamaModels(): Promise<string[]> {
  const res = await ollamaFetch('/api/tags');
  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    models?: Array<{ name?: string }>;
  };
  return (data.models || [])
    .map((model) => model.name)
    .filter((name): name is string => Boolean(name));
}

async function checkOllama(): Promise<ProviderStatus> {
  try {
    const models = await getOllamaModels();
    return {
      provider: 'ollama',
      available: models.length > 0,
      command: commandFor('ollama'),
      host: ollamaHost(),
      model: defaultModelFor('ollama') || models[0],
      models,
      detail:
        models.length > 0
          ? `${models.length} model${models.length === 1 ? '' : 's'} available`
          : 'Ollama is reachable but no models are installed',
    };
  } catch (err) {
    return {
      provider: 'ollama',
      available: false,
      command: commandFor('ollama'),
      host: ollamaHost(),
      model: defaultModelFor('ollama'),
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function providerStatus(
  provider: ModelProvider,
): Promise<ProviderStatus> {
  switch (provider) {
    case 'codex':
      return checkCommand(provider, ['--version']);
    case 'gemini':
      return checkCommand(provider, ['--version']);
    case 'claude':
      return checkCommand(provider, ['--version']);
    case 'ollama':
      return checkOllama();
  }
}

async function runCliProvider(
  provider: Exclude<ModelProvider, 'ollama'>,
  options: AskOptions,
): Promise<string> {
  const command = commandFor(provider);
  const model = options.model || defaultModelFor(provider);
  const args: string[] = [];

  if (provider === 'codex') {
    args.push(
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
    );
    if (model) args.push('-m', model);
    args.push(options.prompt);
  } else if (provider === 'gemini') {
    if (model) args.push('-m', model);
    args.push(
      '-p',
      options.system
        ? `${options.system}\n\n${options.prompt}`
        : options.prompt,
    );
  } else {
    args.push('-p', options.prompt, '--output-format', 'text');
    if (model) args.push('--model', model);
  }

  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `tetsuclaw-${provider}-`),
  );
  try {
    const result = await execFileAsync(command, args, {
      cwd: workDir,
      timeout: options.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: providerEnv(provider),
    });
    const output = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();
    return output || stderr || '(no output)';
  } catch (err) {
    const error = err as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const detail =
      error.stderr?.toString().trim() ||
      error.stdout?.toString().trim() ||
      error.message;
    throw new Error(detail);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function runOllama(options: AskOptions): Promise<string> {
  const explicitModel = options.model || defaultModelFor('ollama');
  const model = explicitModel || (await getOllamaModels())[0];
  if (!model) {
    throw new Error(
      'No Ollama model configured or installed. Set OLLAMA_MODEL or pull a model.',
    );
  }

  const res = await ollamaFetch(
    '/api/generate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: options.prompt,
        system: options.system || undefined,
        stream: false,
      }),
    },
    options.timeoutMs,
  );
  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { response?: string };
  return data.response?.trim() || '(no output)';
}

async function askSingleProvider(
  provider: ModelProvider,
  options: AskOptions,
): Promise<ModelResult> {
  try {
    const text =
      provider === 'ollama'
        ? await runOllama(options)
        : await runCliProvider(provider, options);
    return {
      success: true,
      message: `Response from ${provider}.`,
      data: {
        provider,
        model: options.model || defaultModelFor(provider) || null,
        text,
      },
    };
  } catch (err) {
    return {
      success: false,
      message: `${provider} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function askProvider(options: AskOptions): Promise<ModelResult> {
  if (options.provider !== 'auto') {
    return askSingleProvider(options.provider, options);
  }

  const failures: string[] = [];
  for (const provider of parseProviderOrder(process.env.MODEL_PROVIDER_ORDER)) {
    const result = await askSingleProvider(provider, {
      ...options,
      provider,
    });
    if (result.success) {
      return {
        ...result,
        message: `Auto provider selected ${provider}.`,
      };
    }
    failures.push(result.message);
  }

  return {
    success: false,
    message: `No model provider succeeded. ${failures.join(' | ')}`,
  };
}

async function handleStatus(
  data: Record<string, unknown>,
): Promise<ModelResult> {
  const requested = normalizeProvider(data.provider);
  const providers =
    requested && requested !== 'auto' ? [requested] : MODEL_PROVIDERS;
  const statuses = await Promise.all(providers.map(providerStatus));
  return {
    success: true,
    message: `Checked ${statuses.length} model provider${statuses.length === 1 ? '' : 's'}.`,
    data: {
      providerOrder: parseProviderOrder(process.env.MODEL_PROVIDER_ORDER),
      providers: statuses,
    },
  };
}

async function handleAsk(data: Record<string, unknown>): Promise<ModelResult> {
  const prompt = asString(data.prompt);
  if (!prompt) {
    return { success: false, message: 'Missing prompt.' };
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      success: false,
      message: `Prompt is too large. Limit is ${MAX_PROMPT_CHARS} characters.`,
    };
  }

  const provider = normalizeProvider(data.provider) || 'auto';
  return askProvider({
    provider,
    prompt,
    system: asString(data.system),
    model: asString(data.model),
    timeoutMs: sanitizeTimeoutMs(data.timeoutMs),
  });
}

export async function handleModelProviderIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string | undefined;
  if (!type?.startsWith('model_')) {
    return false;
  }

  const requestId = asString(data.requestId);
  if (!requestId) {
    logger.warn({ type }, 'Model provider request blocked: missing requestId');
    return true;
  }

  let result: ModelResult;

  if (!isMain) {
    result = {
      success: false,
      message:
        'Model provider tools are available in the main Tetsuclaw chat only.',
    };
    writeResult(dataDir, sourceGroup, requestId, result);
    return true;
  }

  logger.info({ type, requestId }, 'Processing model provider request');

  try {
    switch (type) {
      case 'model_status':
        result = await handleStatus(data);
        break;
      case 'model_ask':
        result = await handleAsk(data);
        break;
      default:
        return false;
    }
  } catch (err) {
    result = {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  writeResult(dataDir, sourceGroup, requestId, result);

  if (result.success) {
    logger.info({ type, requestId }, 'Model provider request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'Model provider request failed',
    );
  }

  return true;
}
