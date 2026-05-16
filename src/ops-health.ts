import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  DATA_DIR,
  GROUPS_DIR,
  PROJECT_ROOT,
  TIMEZONE,
} from './config.js';
import type { GroupQueueSnapshot } from './group-queue.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status?: number;
  error?: string;
}

export interface OpsHealthOptions {
  now?: Date;
  projectRoot?: string;
  dataDir?: string;
  groupsDir?: string;
  timezone?: string;
  containerImage?: string;
  pid?: number;
  nodeVersion?: string;
  uptimeSeconds?: number;
  registeredGroups?: Record<string, RegisteredGroup>;
  sessions?: Record<string, string>;
  tasks?: ScheduledTask[];
  channels?: Array<{ name: string; connected: boolean }>;
  queue?: GroupQueueSnapshot;
  runCommand?: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ) => CommandResult;
}

function defaultRunCommand(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): CommandResult {
  try {
    const stdout = execFileSync(file, args, {
      cwd: opts.cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 3000,
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    const e = err as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number;
    };
    return {
      ok: false,
      stdout: String(e.stdout ?? '').trim(),
      stderr: String(e.stderr ?? '').trim(),
      status: e.status,
      error: e.message,
    };
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${total % 60}s`;
}

function diskSummary(projectRoot: string): {
  text: string;
  warn: boolean;
} {
  try {
    const stat = fs.statfsSync(projectRoot);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    const used = Math.max(0, total - free);
    const usedPct = total > 0 ? Math.round((used / total) * 100) : 0;
    return {
      text: `${usedPct}% used, ${formatBytes(free)} free`,
      warn: usedPct >= 85,
    };
  } catch (err) {
    return {
      text: `unavailable (${err instanceof Error ? err.message : String(err)})`,
      warn: true,
    };
  }
}

function countStaleIpcResults(dataDir: string, olderThanMs: number): number {
  const ipcDir = path.join(dataDir, 'ipc');
  const now = Date.now();
  let count = 0;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (
        !entry.isFile() ||
        !/(^|_)(github|model|x)_results$/.test(path.basename(dir)) ||
        !/\.json$|\.tmp-/.test(entry.name)
      ) {
        continue;
      }
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs >= olderThanMs) count++;
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }

  walk(ipcDir);
  return count;
}

function countSecretPatternFiles(
  projectRoot: string,
  runCommand: OpsHealthOptions['runCommand'],
): { text: string; warn: boolean } {
  const runner = runCommand || defaultRunCommand;
  const pattern =
    '(github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{20,}|[0-9]{6,}:[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9_-]{20,})';
  const targets = ['groups', 'data/sessions', 'data/ipc'].filter((target) =>
    fs.existsSync(path.join(projectRoot, target)),
  );
  if (targets.length === 0) {
    return { text: '0 file(s)', warn: false };
  }

  const result = runner('grep', ['-RIlE', pattern, ...targets], {
    cwd: projectRoot,
    timeoutMs: 5000,
  });

  if (result.ok) {
    const files = result.stdout.split('\n').filter(Boolean);
    return { text: `${files.length} file(s)`, warn: files.length > 0 };
  }
  if (result.status === 1) {
    return { text: '0 file(s)', warn: false };
  }
  return {
    text: `unavailable (${result.stderr || result.error || 'grep failed'})`,
    warn: true,
  };
}

function gitSummary(
  projectRoot: string,
  runCommand: OpsHealthOptions['runCommand'],
): { text: string; warn: boolean } {
  const runner = runCommand || defaultRunCommand;
  const branch = runner('git', ['branch', '--show-current'], {
    cwd: projectRoot,
  });
  const commit = runner('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: projectRoot,
  });
  const status = runner('git', ['status', '--porcelain'], {
    cwd: projectRoot,
  });
  const upstream = runner(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd: projectRoot },
  );

  if (!branch.ok || !commit.ok || !status.ok) {
    return {
      text: `unavailable (${branch.error || commit.error || status.error || 'git failed'})`,
      warn: true,
    };
  }

  const dirtyCount = status.stdout ? status.stdout.split('\n').length : 0;
  let syncText = 'no upstream';
  let syncWarn = false;
  if (upstream.ok && upstream.stdout) {
    const aheadBehind = runner(
      'git',
      ['rev-list', '--left-right', '--count', `HEAD...${upstream.stdout}`],
      { cwd: projectRoot },
    );
    if (aheadBehind.ok) {
      const [ahead = '0', behind = '0'] = aheadBehind.stdout.split(/\s+/);
      syncText = `${upstream.stdout}, ahead ${ahead}, behind ${behind}`;
      syncWarn = ahead !== '0' || behind !== '0';
    } else {
      syncText = upstream.stdout;
    }
  }

  return {
    text: `${branch.stdout} ${commit.stdout}, ${dirtyCount === 0 ? 'clean' : `${dirtyCount} changed`}, ${syncText}`,
    warn: dirtyCount > 0 || syncWarn,
  };
}

function commandLine(
  label: string,
  result: CommandResult,
  okText?: (stdout: string) => string,
): { text: string; warn: boolean } {
  if (result.ok) {
    return {
      text: `${label}: ${okText ? okText(result.stdout) : result.stdout}`,
      warn: false,
    };
  }
  return {
    text: `${label}: unavailable (${result.stderr || result.error || 'command failed'})`,
    warn: true,
  };
}

export function formatOpsHealthReport(options: OpsHealthOptions = {}): string {
  const now = options.now || new Date();
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const dataDir = options.dataDir || DATA_DIR;
  const groupsDir = options.groupsDir || GROUPS_DIR;
  const runner = options.runCommand || defaultRunCommand;
  const warnings: string[] = [];

  const disk = diskSummary(projectRoot);
  if (disk.warn) warnings.push('disk');

  const git = gitSummary(projectRoot, runner);
  if (git.warn) warnings.push('git');

  const service = commandLine(
    'Service',
    runner('systemctl', ['is-active', 'nanoclaw'], { timeoutMs: 3000 }),
    (stdout) => stdout || 'unknown',
  );
  if (service.warn || !service.text.endsWith('active'))
    warnings.push('service');

  const github = commandLine(
    'GitHub auth',
    runner('gh', ['auth', 'status', '-h', 'github.com'], {
      cwd: projectRoot,
      timeoutMs: 5000,
    }),
    () => 'ok',
  );
  if (github.warn) warnings.push('github');

  const image = commandLine(
    'Agent image',
    runner(
      'docker',
      [
        'image',
        'inspect',
        options.containerImage || CONTAINER_IMAGE,
        '--format',
        '{{.Id}} {{.Created}}',
      ],
      {
        timeoutMs: 5000,
      },
    ),
    (stdout) => stdout.split(/\s+/).slice(0, 2).join(' '),
  );
  if (image.warn) warnings.push('image');

  const staleIpc = countStaleIpcResults(dataDir, 10 * 60 * 1000);
  if (staleIpc > 0) warnings.push('stale IPC');

  const secrets = countSecretPatternFiles(projectRoot, runner);
  if (secrets.warn) warnings.push('secrets');

  const registeredGroups = options.registeredGroups || {};
  const mainGroup = Object.entries(registeredGroups).find(
    ([, group]) => group.isMain,
  );
  const sessions = options.sessions || {};
  const tasks = options.tasks || [];
  const activeTasks = tasks.filter((task) => task.status === 'active').length;
  const pausedTasks = tasks.filter((task) => task.status === 'paused').length;
  const completedTasks = tasks.filter(
    (task) => task.status === 'completed',
  ).length;

  const channelText =
    options.channels && options.channels.length > 0
      ? options.channels
          .map(
            (channel) => `${channel.name}:${channel.connected ? 'up' : 'down'}`,
          )
          .join(', ')
      : 'none registered';
  if (options.channels?.some((channel) => !channel.connected)) {
    warnings.push('channels');
  }

  const queue = options.queue;
  const pendingQueueItems =
    queue?.groups.reduce(
      (sum, group) =>
        sum +
        (group.pendingMessages ? 1 : 0) +
        group.pendingTaskCount +
        (group.retryCount > 0 ? 1 : 0),
      0,
    ) ?? 0;
  if (pendingQueueItems > 0 || (queue?.waitingGroups.length ?? 0) > 0) {
    warnings.push('queue');
  }

  const queueText = queue
    ? `${queue.activeCount}/${queue.maxConcurrent} active, ${queue.waitingGroups.length} waiting, ${pendingQueueItems} pending/retrying`
    : 'unavailable';

  const overall =
    warnings.length === 0 ? 'OK' : `WARN (${warnings.join(', ')})`;

  return [
    'TetsuClaw ops health',
    `Generated: ${now.toISOString()} (${options.timezone || TIMEZONE})`,
    `Overall: ${overall}`,
    '',
    'Runtime:',
    `- Process: pid ${options.pid ?? process.pid}, uptime ${formatDuration(options.uptimeSeconds ?? process.uptime())}, node ${options.nodeVersion ?? process.version}, host ${os.hostname()}`,
    `- ${service.text}`,
    `- Channels: ${channelText}`,
    `- Queue: ${queueText}`,
    '',
    'Deploy:',
    `- Git: ${git.text}`,
    `- ${image.text}`,
    `- Disk: ${disk.text}`,
    '',
    'Data:',
    `- Groups: ${Object.keys(registeredGroups).length} registered${mainGroup ? `, main ${mainGroup[1].folder}` : ''}`,
    `- Sessions: ${Object.keys(sessions).length} tracked`,
    `- Tasks: ${activeTasks} active, ${pausedTasks} paused, ${completedTasks} completed`,
    `- Stale IPC results >10m: ${staleIpc}`,
    `- Secret token patterns: ${secrets.text}`,
    `- Groups dir: ${path.relative(projectRoot, groupsDir) || '.'}`,
    '',
    github.text,
  ]
    .join('\n')
    .trim();
}
