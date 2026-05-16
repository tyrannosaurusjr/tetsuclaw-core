import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DECLARED_MCP_TOOL_NAMES,
  formatCapabilitiesReport,
  getRuntimeCapabilityDefinitions,
} from '../dist/capabilities.js';

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function registeredToolNames(relativePath) {
  const source = fs.readFileSync(path.join(repoDir, relativePath), 'utf-8');
  return [...source.matchAll(/server\.tool\(\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
}

test('capability manifest matches registered MCP tool names', () => {
  const registeredNames = [
    ...registeredToolNames('src/ipc-mcp-stdio.ts'),
    ...registeredToolNames('src/ollama-mcp-stdio.ts'),
  ].sort();

  assert.deepEqual([...DECLARED_MCP_TOOL_NAMES].sort(), registeredNames);
});

test('runtime report describes GitHub file-write guardrails', () => {
  const report = formatCapabilitiesReport({
    isMain: true,
    groupFolder: 'telegram_main',
    ollamaAdminEnabled: false,
    gmailAuthAvailable: false,
  });

  assert.match(report, /github_commit_file/);
  assert.match(report, /single text-file commits/);
  assert.match(report, /tetsuclaw-core/);
  assert.match(report, /Stop cleanup redacts/);
  assert.doesNotMatch(report, /ollama_pull_model/);
});

test('non-main report marks main-only tools unavailable', () => {
  const report = formatCapabilitiesReport({
    isMain: false,
    groupFolder: 'telegram_side_chat',
    ollamaAdminEnabled: false,
  });

  assert.match(report, /non-main chat/);
  assert.match(report, /main chat only - unavailable here/);
});

test('ollama admin tools are runtime gated', () => {
  const withoutAdmin = getRuntimeCapabilityDefinitions({
    ollamaAdminEnabled: false,
  }).map((cap) => cap.name);
  const withAdmin = getRuntimeCapabilityDefinitions({
    ollamaAdminEnabled: true,
  }).map((cap) => cap.name);

  assert.equal(withoutAdmin.includes('ollama_pull_model'), false);
  assert.equal(withAdmin.includes('ollama_pull_model'), true);
});
