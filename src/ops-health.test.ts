import { describe, expect, it } from 'vitest';

import { formatOpsHealthReport } from './ops-health.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

function task(status: ScheduledTask['status']): ScheduledTask {
  return {
    id: `task-${status}`,
    group_folder: 'telegram_main',
    chat_jid: 'tg:1',
    prompt: 'test',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: null,
    last_run: null,
    last_result: null,
    status,
    created_at: '2026-05-17T00:00:00.000Z',
  };
}

describe('formatOpsHealthReport', () => {
  it('formats a host ops report without exposing command output secrets', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:1': {
        name: 'TetsuClaw HQ',
        folder: 'telegram_main',
        trigger: '@TetsuClaw',
        added_at: '2026-05-17T00:00:00.000Z',
        isMain: true,
      },
    };

    const report = formatOpsHealthReport({
      now: new Date('2026-05-17T00:00:00.000Z'),
      projectRoot: process.cwd(),
      dataDir: process.cwd(),
      groupsDir: `${process.cwd()}/groups`,
      timezone: 'Asia/Tokyo',
      pid: 123,
      nodeVersion: 'v22.0.0',
      uptimeSeconds: 3661,
      registeredGroups: groups,
      sessions: { telegram_main: 'session-1' },
      tasks: [task('active'), task('paused'), task('completed')],
      channels: [{ name: 'telegram', connected: true }],
      queue: {
        activeCount: 0,
        maxConcurrent: 5,
        waitingGroups: [],
        groups: [],
      },
      runCommand: (file, args) => {
        const joined = [file, ...args].join(' ');
        if (joined.startsWith('git branch')) {
          return { ok: true, stdout: 'main', stderr: '' };
        }
        if (joined.startsWith('git rev-parse --short')) {
          return { ok: true, stdout: 'abc1234', stderr: '' };
        }
        if (joined.startsWith('git status')) {
          return { ok: true, stdout: '', stderr: '' };
        }
        if (joined.startsWith('git rev-parse --abbrev-ref')) {
          return { ok: true, stdout: 'origin/main', stderr: '' };
        }
        if (joined.startsWith('git rev-list')) {
          return { ok: true, stdout: '0\t0', stderr: '' };
        }
        if (joined.startsWith('systemctl')) {
          return { ok: true, stdout: 'active', stderr: '' };
        }
        if (joined.startsWith('gh auth')) {
          return { ok: true, stdout: 'sensitive status line', stderr: '' };
        }
        if (joined.startsWith('docker image inspect')) {
          return {
            ok: true,
            stdout: 'sha256:abc 2026-05-17T00:00:00Z',
            stderr: '',
          };
        }
        if (joined.startsWith('grep')) {
          return { ok: false, stdout: '', stderr: '', status: 1 };
        }
        return { ok: false, stdout: '', stderr: 'unexpected command' };
      },
    });

    expect(report).toContain('TetsuClaw ops health');
    expect(report).toContain(
      'Git: main abc1234, clean, origin/main, ahead 0, behind 0',
    );
    expect(report).toContain('Channels: telegram:up');
    expect(report).toContain('Tasks: 1 active, 1 paused, 1 completed');
    expect(report).toContain('Secret token patterns: 0 file(s)');
    expect(report).not.toContain('sensitive status line');
  });
});
