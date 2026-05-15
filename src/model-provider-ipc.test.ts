import { describe, expect, it } from 'vitest';

import { normalizeProvider, parseProviderOrder } from './model-provider-ipc.js';

describe('model provider IPC helpers', () => {
  it('normalizes supported provider names', () => {
    expect(normalizeProvider('auto')).toBe('auto');
    expect(normalizeProvider('codex')).toBe('codex');
    expect(normalizeProvider('gemini')).toBe('gemini');
    expect(normalizeProvider('ollama')).toBe('ollama');
    expect(normalizeProvider('claude')).toBe('claude');
    expect(normalizeProvider('bad-provider')).toBeUndefined();
  });

  it('uses the default provider order when unset or invalid', () => {
    expect(parseProviderOrder(undefined)).toEqual([
      'codex',
      'claude',
      'ollama',
      'gemini',
    ]);
    expect(parseProviderOrder('bad,auto')).toEqual([
      'codex',
      'claude',
      'ollama',
      'gemini',
    ]);
  });

  it('parses a custom provider order and removes duplicates', () => {
    expect(parseProviderOrder('ollama, codex, ollama, claude')).toEqual([
      'ollama',
      'codex',
      'claude',
    ]);
  });
});
