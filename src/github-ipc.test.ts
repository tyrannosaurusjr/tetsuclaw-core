import { describe, expect, it } from 'vitest';

import {
  buildCreateRepoArgs,
  isProtectedTetsuclawCoreRepo,
  normalizeGithubRepo,
} from './github-ipc.js';

describe('GitHub IPC helpers', () => {
  it('normalizes common GitHub repository formats', () => {
    expect(
      normalizeGithubRepo(
        'https://github.com/tyrannosaurusjr/tetsuclaw-core.git',
      ),
    ).toBe('tyrannosaurusjr/tetsuclaw-core');
    expect(
      normalizeGithubRepo('git@github.com:tyrannosaurusjr/example.git'),
    ).toBe('tyrannosaurusjr/example');
  });

  it('detects the protected tetsuclaw-core repository', () => {
    expect(isProtectedTetsuclawCoreRepo('tetsuclaw-core')).toBe(true);
    expect(
      isProtectedTetsuclawCoreRepo(
        'https://github.com/tyrannosaurusjr/tetsuclaw-core.git',
      ),
    ).toBe(true);
    expect(isProtectedTetsuclawCoreRepo('tyrannosaurusjr/other-repo')).toBe(
      false,
    );
  });

  it('builds private repo creation args by default', () => {
    const result = buildCreateRepoArgs({ name: 'new-tool' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    expect(result.fullName).toBe('new-tool');
    expect(result.visibility).toBe('private');
    expect(result.args).toEqual(['repo', 'create', 'new-tool', '--private']);
  });

  it('builds owner-scoped creation args with optional metadata', () => {
    const result = buildCreateRepoArgs({
      owner: 'tyrannosaurusjr',
      name: 'new-tool',
      description: 'A test repo',
      visibility: 'public',
      addReadme: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    expect(result.fullName).toBe('tyrannosaurusjr/new-tool');
    expect(result.args).toEqual([
      'repo',
      'create',
      'tyrannosaurusjr/new-tool',
      '--public',
      '--description',
      'A test repo',
      '--add-readme',
    ]);
  });

  it('rejects unsafe or protected repo creation targets', () => {
    expect(buildCreateRepoArgs({ name: '../../bad' }).ok).toBe(false);
    expect(buildCreateRepoArgs({ name: 'tetsuclaw-core' }).ok).toBe(false);
    expect(
      buildCreateRepoArgs({
        owner: 'tyrannosaurusjr',
        name: 'tetsuclaw-core',
      }).ok,
    ).toBe(false);
  });
});
