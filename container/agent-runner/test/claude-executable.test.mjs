import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateClaudeCodeExecutables,
  resolveClaudeCodeExecutable,
} from '../dist/claude-executable.js';

test('prefers the glibc linux binary before the musl binary on glibc images', () => {
  const candidates = candidateClaudeCodeExecutables({
    baseDir: '/app/node_modules/@anthropic-ai',
    platform: 'linux',
    arch: 'x64',
    isGlibc: true,
  });

  assert.deepEqual(candidates.slice(0, 2), [
    '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
  ]);
});

test('resolves the glibc executable when both linux binaries exist', () => {
  const executable = resolveClaudeCodeExecutable({
    baseDir: '/app/node_modules/@anthropic-ai',
    platform: 'linux',
    arch: 'x64',
    isGlibc: true,
    existsSync: () => true,
    accessSync: () => undefined,
  });

  assert.equal(
    executable,
    '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
  );
});

test('falls back to the global Claude executable if packaged binaries are absent', () => {
  const executable = resolveClaudeCodeExecutable({
    baseDir: '/app/node_modules/@anthropic-ai',
    platform: 'linux',
    arch: 'x64',
    isGlibc: true,
    existsSync: (filePath) => filePath === '/usr/local/bin/claude',
    accessSync: () => undefined,
  });

  assert.equal(executable, '/usr/local/bin/claude');
});
