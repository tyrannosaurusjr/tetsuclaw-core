/**
 * GitHub IPC Handler
 *
 * Keeps GitHub credentials on the host by executing the authenticated `gh`
 * CLI from the trusted host process. Container agents only send structured
 * IPC requests and receive sanitized JSON results.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

interface GithubResult {
  success: boolean;
  message: string;
  data?: unknown;
}

type Visibility = 'public' | 'private' | 'internal';

const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,250}$/;
const PROTECTED_REPO_NAME = 'tetsuclaw-core';
const MAX_COMMIT_FILE_BYTES = 1024 * 1024;
const REPO_JSON_FIELDS = [
  'name',
  'nameWithOwner',
  'description',
  'visibility',
  'isPrivate',
  'isArchived',
  'url',
  'sshUrl',
  'defaultBranchRef',
  'updatedAt',
  'pushedAt',
  'viewerPermission',
].join(',');

interface CreateRepoInput {
  name: string;
  owner?: string;
  description?: string;
  visibility?: Visibility;
  homepage?: string;
  gitignore?: string;
  license?: string;
  addReadme?: boolean;
}

interface CommitFileInput {
  repository: string;
  filePath: string;
  content: string;
  message: string;
  branch?: string;
}

type ArgsResult =
  | { ok: true; args: string[]; fullName: string; visibility: Visibility }
  | { ok: false; message: string };

type CommitFileTargetResult =
  | {
      ok: true;
      repo: string;
      filePath: string;
      content: string;
      message: string;
      branch?: string;
    }
  | { ok: false; message: string };

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: GithubResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'github_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function sanitizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 50;
  }
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function coerceVisibility(value: unknown): Visibility | undefined {
  if (value === 'public' || value === 'private' || value === 'internal') {
    return value;
  }
  return undefined;
}

function isRepoSegment(value: string): boolean {
  return REPO_SEGMENT_RE.test(value);
}

export function normalizeGithubRepo(value: string): string {
  return value
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

export function isProtectedTetsuclawCoreRepo(repo: string): boolean {
  const normalized = normalizeGithubRepo(repo).toLowerCase();
  const repoName = normalized.split('/').pop();
  return repoName === PROTECTED_REPO_NAME;
}

function normalizeOwnerRepo(value: string): string | null {
  const normalized = normalizeGithubRepo(value);
  const parts = normalized.split('/');
  if (parts.length !== 2) {
    return null;
  }
  const [owner, repo] = parts;
  if (!isRepoSegment(owner) || !isRepoSegment(repo)) {
    return null;
  }
  return `${owner}/${repo}`;
}

function normalizeGithubFilePath(value: string): string | null {
  const filePath = value.trim();
  if (!filePath || filePath.startsWith('/') || filePath.includes('\\')) {
    return null;
  }

  const parts = filePath.split('/');
  if (
    parts.some(
      (part) => !part || part === '.' || part === '..' || part.includes('\0'),
    )
  ) {
    return null;
  }

  return parts.join('/');
}

function isBlockedWritePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    lower.includes('/.env') ||
    lower.startsWith('.github/workflows/') ||
    lower === '.github/workflows' ||
    lower.startsWith('.git/') ||
    lower === '.git' ||
    lower.includes('/.git/') ||
    /(^|\/)(id_rsa|id_ed25519|private_key|credentials|secrets?)([._/-]|$)/i.test(
      filePath,
    )
  );
}

function isSafeBranch(value: string): boolean {
  return (
    BRANCH_RE.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock')
  );
}

function githubContentsEndpoint(repo: string, filePath: string): string {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  return `repos/${repo}/contents/${encodedPath}`;
}

export function buildCreateRepoArgs(input: CreateRepoInput): ArgsResult {
  const name = input.name.trim();
  const owner = input.owner?.trim();

  if (!isRepoSegment(name)) {
    return {
      ok: false,
      message:
        'Invalid repository name. Use letters, numbers, periods, underscores, and hyphens only.',
    };
  }

  if (owner && !isRepoSegment(owner)) {
    return {
      ok: false,
      message:
        'Invalid owner. Use a GitHub user or organization name without slashes.',
    };
  }

  const fullName = owner ? `${owner}/${name}` : name;
  if (isProtectedTetsuclawCoreRepo(fullName)) {
    return {
      ok: false,
      message:
        'Refusing to create or replace tetsuclaw-core. That repository is protected infrastructure.',
    };
  }

  const visibility = input.visibility ?? 'private';
  const args = ['repo', 'create', fullName, `--${visibility}`];

  if (input.description) {
    args.push('--description', input.description);
  }
  if (input.homepage) {
    args.push('--homepage', input.homepage);
  }
  if (input.gitignore) {
    args.push('--gitignore', input.gitignore);
  }
  if (input.license) {
    args.push('--license', input.license);
  }
  if (input.addReadme) {
    args.push('--add-readme');
  }

  return { ok: true, args, fullName, visibility };
}

export function buildCommitFileTarget(
  input: CommitFileInput,
): CommitFileTargetResult {
  const repo = normalizeOwnerRepo(input.repository);
  if (!repo) {
    return {
      ok: false,
      message: 'Repository must be in owner/name format.',
    };
  }

  if (isProtectedTetsuclawCoreRepo(repo)) {
    return {
      ok: false,
      message:
        'Refusing to write to tetsuclaw-core through Telegram GitHub tools. Use the dedicated maintenance workflow for protected infrastructure.',
    };
  }

  const filePath = normalizeGithubFilePath(input.filePath);
  if (!filePath) {
    return {
      ok: false,
      message:
        'File path must be a relative repository path without traversal.',
    };
  }

  if (isBlockedWritePath(filePath)) {
    return {
      ok: false,
      message:
        'Refusing to write secrets, git internals, or GitHub Actions workflow files.',
    };
  }

  const contentBytes = Buffer.byteLength(input.content, 'utf8');
  if (contentBytes > MAX_COMMIT_FILE_BYTES) {
    return {
      ok: false,
      message: 'File content is too large for this tool. Limit is 1 MiB.',
    };
  }

  const message = input.message.trim();
  if (!message) {
    return { ok: false, message: 'Commit message is required.' };
  }

  const branch = input.branch?.trim();
  if (branch && !isSafeBranch(branch)) {
    return { ok: false, message: 'Unsafe branch name.' };
  }

  return {
    ok: true,
    repo,
    filePath,
    content: input.content,
    message,
    branch,
  };
}

async function runGh(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('gh', args, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch (err) {
    const error = err as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
    };
    const details =
      error.stderr?.toString().trim() ||
      error.stdout?.toString().trim() ||
      error.message;
    throw new Error(details);
  }
}

async function runGhApiWithJsonInput(
  args: string[],
  payload: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gh-'));
  const inputFile = path.join(tempDir, 'payload.json');

  try {
    fs.writeFileSync(inputFile, JSON.stringify(payload));
    return await runGh([...args, '--input', inputFile]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function handleListRepos(
  data: Record<string, unknown>,
): Promise<GithubResult> {
  const owner = asString(data.owner);
  const visibility = coerceVisibility(data.visibility);
  const limit = sanitizeLimit(data.limit);
  const args = ['repo', 'list'];

  if (owner) {
    if (!isRepoSegment(owner)) {
      return { success: false, message: 'Invalid owner.' };
    }
    args.push(owner);
  }

  args.push('--limit', String(limit), '--json', REPO_JSON_FIELDS);

  if (visibility) {
    args.push('--visibility', visibility);
  }

  const { stdout } = await runGh(args);
  const repos = JSON.parse(stdout || '[]');
  return {
    success: true,
    message: `Found ${Array.isArray(repos) ? repos.length : 0} repositories.`,
    data: repos,
  };
}

async function getExistingFileSha(
  repo: string,
  filePath: string,
  branch?: string,
): Promise<string | undefined> {
  const args = ['api', githubContentsEndpoint(repo, filePath), '--jq', '.sha'];
  if (branch) {
    args.push('-f', `ref=${branch}`);
  }

  try {
    const { stdout } = await runGh(args);
    return stdout.trim() || undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|http 404/i.test(message)) {
      return undefined;
    }
    throw err;
  }
}

async function handleCommitFile(
  data: Record<string, unknown>,
): Promise<GithubResult> {
  const repository = asString(data.repository) ?? asString(data.repo);
  const filePath = asString(data.path) ?? asString(data.filePath);
  const content = typeof data.content === 'string' ? data.content : undefined;
  const message = asString(data.message);

  if (!repository || !filePath || content === undefined || !message) {
    return {
      success: false,
      message: 'Missing repository, path, content, or commit message.',
    };
  }

  const target = buildCommitFileTarget({
    repository,
    filePath,
    content,
    message,
    branch: asString(data.branch),
  });

  if (!target.ok) {
    return { success: false, message: target.message };
  }

  const sha = await getExistingFileSha(
    target.repo,
    target.filePath,
    target.branch,
  );
  const payload: Record<string, unknown> = {
    message: target.message,
    content: Buffer.from(target.content, 'utf8').toString('base64'),
  };
  if (target.branch) {
    payload.branch = target.branch;
  }
  if (sha) {
    payload.sha = sha;
  }

  const { stdout } = await runGhApiWithJsonInput(
    [
      'api',
      '--method',
      'PUT',
      githubContentsEndpoint(target.repo, target.filePath),
    ],
    payload,
  );
  const parsed = JSON.parse(stdout || '{}');

  return {
    success: true,
    message: `${sha ? 'Updated' : 'Created'} ${target.filePath} in ${target.repo}.`,
    data: {
      repository: target.repo,
      path: target.filePath,
      branch: target.branch,
      commit: parsed.commit
        ? {
            sha: parsed.commit.sha,
            html_url: parsed.commit.html_url,
          }
        : undefined,
      content: parsed.content
        ? {
            sha: parsed.content.sha,
            html_url: parsed.content.html_url,
          }
        : undefined,
    },
  };
}

async function handleViewRepo(
  data: Record<string, unknown>,
): Promise<GithubResult> {
  const rawRepo = asString(data.repository) ?? asString(data.repo);
  if (!rawRepo) {
    return { success: false, message: 'Missing repository.' };
  }

  const repo = normalizeOwnerRepo(rawRepo);
  if (!repo) {
    return {
      success: false,
      message: 'Repository must be in owner/name format.',
    };
  }

  const { stdout } = await runGh([
    'repo',
    'view',
    repo,
    '--json',
    REPO_JSON_FIELDS,
  ]);
  return {
    success: true,
    message: `Loaded ${repo}.`,
    data: JSON.parse(stdout),
  };
}

async function handleCreateRepo(
  data: Record<string, unknown>,
): Promise<GithubResult> {
  const name = asString(data.name);
  if (!name) {
    return { success: false, message: 'Missing repository name.' };
  }

  const built = buildCreateRepoArgs({
    name,
    owner: asString(data.owner),
    description: asString(data.description),
    visibility: coerceVisibility(data.visibility),
    homepage: asString(data.homepage),
    gitignore: asString(data.gitignore),
    license: asString(data.license),
    addReadme: asBoolean(data.addReadme),
  });

  if (!built.ok) {
    return { success: false, message: built.message };
  }

  let createdFullName = built.fullName;
  if (!createdFullName.includes('/')) {
    try {
      const { stdout } = await runGh(['api', 'user', '--jq', '.login']);
      const login = stdout.trim();
      if (login) {
        createdFullName = `${login}/${createdFullName}`;
      }
    } catch (err) {
      logger.warn({ err }, 'Could not resolve GitHub login before repo create');
    }
  }

  await runGh(built.args);

  let dataOut: unknown;
  try {
    const { stdout } = await runGh([
      'repo',
      'view',
      createdFullName,
      '--json',
      REPO_JSON_FIELDS,
    ]);
    dataOut = JSON.parse(stdout);
  } catch (err) {
    dataOut = { repository: createdFullName };
    logger.warn({ err, repo: createdFullName }, 'Created repo but view failed');
  }

  return {
    success: true,
    message: `Created ${built.visibility} repository ${createdFullName}.`,
    data: dataOut,
  };
}

export async function handleGithubIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string | undefined;

  if (!type?.startsWith('github_')) {
    return false;
  }

  const requestId = asString(data.requestId);
  if (!requestId) {
    logger.warn({ type }, 'GitHub integration blocked: missing requestId');
    return true;
  }

  let result: GithubResult;

  if (!isMain) {
    logger.warn(
      { sourceGroup, type },
      'GitHub integration blocked: not main group',
    );
    result = {
      success: false,
      message: 'GitHub tools are available in the main Tetsuclaw chat only.',
    };
    writeResult(dataDir, sourceGroup, requestId, result);
    return true;
  }

  logger.info({ type, requestId }, 'Processing GitHub request');

  try {
    switch (type) {
      case 'github_list_repos':
        result = await handleListRepos(data);
        break;
      case 'github_view_repo':
        result = await handleViewRepo(data);
        break;
      case 'github_create_repo':
        result = await handleCreateRepo(data);
        break;
      case 'github_commit_file':
        result = await handleCommitFile(data);
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
    logger.info({ type, requestId }, 'GitHub request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'GitHub request failed',
    );
  }

  return true;
}
