import fs from 'fs';
import path from 'path';
import { HookCallback, StopHookInput } from '@anthropic-ai/claude-agent-sdk';

const MAX_STOP_CLEANUP_FILE_BYTES = 5 * 1024 * 1024;
const MAX_STOP_CLEANUP_FILES = 300;

export const SECRET_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  replacement: string;
}> = [
  {
    name: 'github_pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]+\b/g,
    replacement: '[REDACTED_GITHUB_PAT]',
  },
  {
    name: 'github_token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    name: 'telegram_bot_token',
    pattern: /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
    replacement: '[REDACTED_TELEGRAM_BOT_TOKEN]',
  },
  {
    name: 'openai_api_key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED_OPENAI_API_KEY]',
  },
];

type Logger = (message: string) => void;

export function redactSecrets(content: string): {
  content: string;
  redactions: Record<string, number>;
} {
  const redactions: Record<string, number> = {};
  let clean = content;

  for (const { name, pattern, replacement } of SECRET_PATTERNS) {
    clean = clean.replace(pattern, () => {
      redactions[name] = (redactions[name] ?? 0) + 1;
      return replacement;
    });
  }

  return { content: clean, redactions };
}

function isStopCleanupTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.json', '.jsonl', '.md', '.txt', '.yaml', '.yml'].includes(ext);
}

function collectStopCleanupFiles(
  dir: string,
  files: Set<string>,
  log: Logger,
): void {
  if (files.size >= MAX_STOP_CLEANUP_FILES || !fs.existsSync(dir)) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log(
      `Stop cleanup could not read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  for (const entry of entries) {
    if (files.size >= MAX_STOP_CLEANUP_FILES) {
      return;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectStopCleanupFiles(fullPath, files, log);
    } else if (entry.isFile() && isStopCleanupTextFile(fullPath)) {
      files.add(fullPath);
    }
  }
}

function redactSecretsInFile(
  filePath: string,
  log: Logger,
): Record<string, number> | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_STOP_CLEANUP_FILE_BYTES) {
      return null;
    }
    if (!isStopCleanupTextFile(filePath)) {
      return null;
    }

    const original = fs.readFileSync(filePath, 'utf-8');
    const { content, redactions } = redactSecrets(original);
    if (content === original) {
      return null;
    }

    fs.writeFileSync(filePath, content);
    return redactions;
  } catch (err) {
    log(
      `Stop cleanup failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Best-effort end-of-turn cleanup for secrets accidentally pasted into chat.
 * The hook is deliberately non-blocking: cleanup failures are logged, but the
 * user still receives the agent's final response.
 */
export function createStopCleanupHook(log: Logger): HookCallback {
  return async (input, _toolUseId, _context) => {
    const stop = input as StopHookInput;
    const files = new Set<string>();
    if (stop.transcript_path) {
      files.add(stop.transcript_path);
    }

    collectStopCleanupFiles('/workspace/group/user', files, log);
    collectStopCleanupFiles('/workspace/group/conversations', files, log);

    const redactedFiles: string[] = [];
    const totals: Record<string, number> = {};

    for (const filePath of files) {
      const redactions = redactSecretsInFile(filePath, log);
      if (!redactions) {
        continue;
      }

      redactedFiles.push(filePath);
      for (const [name, count] of Object.entries(redactions)) {
        totals[name] = (totals[name] ?? 0) + count;
      }
    }

    if (redactedFiles.length > 0) {
      log(
        `Stop cleanup redacted secrets in ${redactedFiles.length} file(s): ${JSON.stringify(totals)}`,
      );
    }

    return { continue: true, suppressOutput: true };
  };
}
