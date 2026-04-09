/**
 * Real-filesystem tests for ensureContainerOwned.
 *
 * The main container-runner.test.ts mocks fs aggressively, which means we
 * can't exercise chown behavior there. This file uses real temp dirs so we
 * can verify the function actually walks directory trees and calls
 * fs.chownSync on the right paths.
 *
 * The chown itself is observed via a spy on fs.chownSync — we can't verify
 * the actual ownership change in a unit test because non-root test runners
 * will get EPERM from chown. The spy confirms the call happened with the
 * right arguments, which is what matters for correctness.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ensureContainerOwned } from './container-runner.js';

let tmpRoot: string;
let chownSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tetsuclaw-chown-test-'));
  // chownSync on a non-root host will throw EPERM. We spy and stub it to
  // a no-op so we can observe what paths the function walked, without
  // needing actual root privileges.
  chownSpy = vi
    .spyOn(fs, 'chownSync')
    .mockImplementation(() => undefined as unknown as void);
});

afterEach(() => {
  chownSpy.mockRestore();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ensureContainerOwned', () => {
  it('chowns a single empty directory', () => {
    const dir = path.join(tmpRoot, 'empty');
    fs.mkdirSync(dir);

    ensureContainerOwned(dir);

    expect(chownSpy).toHaveBeenCalledWith(dir, 1000, 1000);
    expect(chownSpy).toHaveBeenCalledTimes(1);
  });

  it('recursively chowns a directory tree with files and subdirs', () => {
    const root = path.join(tmpRoot, 'tree');
    const sub = path.join(root, 'projects');
    const subsub = path.join(sub, '-workspace-group');
    fs.mkdirSync(subsub, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.json'), '{}');
    fs.writeFileSync(path.join(subsub, 'session.jsonl'), 'line1\n');

    ensureContainerOwned(root);

    // Every path (root, subdirs, and files) should have been chowned.
    const calledPaths = chownSpy.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(calledPaths).toContain(root);
    expect(calledPaths).toContain(sub);
    expect(calledPaths).toContain(subsub);
    expect(calledPaths).toContain(path.join(root, 'settings.json'));
    expect(calledPaths).toContain(path.join(subsub, 'session.jsonl'));
    // Every call should use uid 1000, gid 1000
    for (const call of chownSpy.mock.calls) {
      expect(call[1]).toBe(1000);
      expect(call[2]).toBe(1000);
    }
  });

  it('is idempotent — calling twice does not error', () => {
    const dir = path.join(tmpRoot, 'idempotent');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');

    ensureContainerOwned(dir);
    const firstCallCount = chownSpy.mock.calls.length;
    ensureContainerOwned(dir);

    // Second call should make the same number of chown calls (idempotent).
    expect(chownSpy.mock.calls.length).toBe(firstCallCount * 2);
  });

  it('silently skips when top-level chown throws EPERM', () => {
    const dir = path.join(tmpRoot, 'no-perm');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');

    chownSpy.mockImplementationOnce(() => {
      const err = new Error('EPERM: operation not permitted') as Error & {
        code?: string;
      };
      err.code = 'EPERM';
      throw err;
    });

    // Should not throw — non-root hosts hit this path constantly.
    expect(() => ensureContainerOwned(dir)).not.toThrow();
    // And should stop recursing after the top-level failure — no sense
    // trying to chown children if we can't chown the parent.
    expect(chownSpy.mock.calls.length).toBe(1);
  });

  it('handles a non-existent path without crashing', () => {
    const ghost = path.join(tmpRoot, 'does-not-exist');
    chownSpy.mockImplementationOnce(() => {
      const err = new Error('ENOENT: no such file or directory') as Error & {
        code?: string;
      };
      err.code = 'ENOENT';
      throw err;
    });
    expect(() => ensureContainerOwned(ghost)).not.toThrow();
  });

  it('handles a file passed in as the target (not a directory)', () => {
    const file = path.join(tmpRoot, 'just-a-file.txt');
    fs.writeFileSync(file, 'hello');

    ensureContainerOwned(file);

    // Chowns the file itself, then readdirSync fails (ENOTDIR), function returns.
    expect(chownSpy).toHaveBeenCalledWith(file, 1000, 1000);
    expect(chownSpy).toHaveBeenCalledTimes(1);
  });
});
