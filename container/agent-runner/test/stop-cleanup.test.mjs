import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSecrets } from '../dist/stop-cleanup.js';

test('redacts common pasted secret formats', () => {
  const input = [
    'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz0123456789',
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCDEF',
    '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123456',
    'sk-abcdefghijklmnopqrstuvwxyz1234567890',
  ].join('\n');

  const { content, redactions } = redactSecrets(input);

  assert.match(content, /\[REDACTED_GITHUB_PAT\]/);
  assert.match(content, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(content, /\[REDACTED_TELEGRAM_BOT_TOKEN\]/);
  assert.match(content, /\[REDACTED_OPENAI_API_KEY\]/);
  assert.equal(redactions.github_pat, 1);
  assert.equal(redactions.github_token, 1);
  assert.equal(redactions.telegram_bot_token, 1);
  assert.equal(redactions.openai_api_key, 1);
});

test('leaves normal project text unchanged', () => {
  const input =
    'TetsuClaw can list/view repos and create/update files via host tools.';

  const { content, redactions } = redactSecrets(input);

  assert.equal(content, input);
  assert.deepEqual(redactions, {});
});
