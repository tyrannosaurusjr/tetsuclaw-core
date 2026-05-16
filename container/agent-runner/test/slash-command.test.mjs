import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('slash command SDK path uses the resolved Claude executable', () => {
  const source = fs.readFileSync(path.join(repoDir, 'src/index.ts'), 'utf-8');
  const slashCommandSection = source.slice(
    source.indexOf('// --- Slash command handling ---'),
    source.indexOf('// --- End slash command handling ---'),
  );

  assert.match(
    slashCommandSection,
    /pathToClaudeCodeExecutable:\s*claudeCodeExecutable/,
  );
});
