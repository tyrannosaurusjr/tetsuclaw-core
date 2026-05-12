import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { TMP_ROOT } = vi.hoisted(() => ({
  TMP_ROOT: `${process.env.TMPDIR || '/tmp'}/tetsuclaw-gdrive-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
}));

vi.mock('./config.js', () => ({
  DATA_DIR: `${TMP_ROOT}/tetsuclaw-core/data`,
  GDRIVE_KEY_PATH: '',
  GDRIVE_PROXY_PORT: 3102,
  GDRIVE_UPLOAD_FOLDER_ID: '',
  GROUPS_DIR: `${TMP_ROOT}/tetsuclaw-core/groups`,
}));

import { resolveAgentPath } from './gdrive-proxy.js';

const coreRoot = path.join(TMP_ROOT, 'tetsuclaw-core');
const groupsDir = path.join(coreRoot, 'groups');
const groupDir = path.join(groupsDir, 'telegram_main');
const exportFile = path.join(groupDir, 'user', 'export_202604.csv');

function writeExportFile(): void {
  fs.mkdirSync(path.dirname(exportFile), { recursive: true });
  fs.writeFileSync(exportFile, 'date,amount\n2026-04-01,1000\n');
}

describe('resolveAgentPath', () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    writeExportFile();
  });

  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it('accepts a real host path under GROUPS_DIR', () => {
    expect(resolveAgentPath(exportFile)).toBe(fs.realpathSync(exportFile));
  });

  it('translates /workspace/group paths when groupFolder is supplied', () => {
    expect(
      resolveAgentPath(
        '/workspace/group/user/export_202604.csv',
        'telegram_main',
      ),
    ).toBe(fs.realpathSync(exportFile));
  });

  it('requires groupFolder for /workspace/group paths', () => {
    expect(() =>
      resolveAgentPath('/workspace/group/user/export_202604.csv'),
    ).toThrow(/groupFolder is required/);
  });

  it('rejects files outside GROUPS_DIR', () => {
    const outsideFile = path.join(os.tmpdir(), `gdrive-outside-${Date.now()}`);
    fs.writeFileSync(outsideFile, 'outside');
    try {
      expect(() => resolveAgentPath(outsideFile)).toThrow(/outside GROUPS_DIR/);
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it('resolves legacy symlink paths against the canonical groups root', () => {
    const legacyRoot = path.join(TMP_ROOT, 'tetsuclaw');
    fs.symlinkSync(coreRoot, legacyRoot, 'dir');

    const legacyExport = path.join(
      legacyRoot,
      'groups',
      'telegram_main',
      'user',
      'export_202604.csv',
    );

    expect(resolveAgentPath(legacyExport)).toBe(fs.realpathSync(exportFile));
  });

  it('rejects symlinks inside GROUPS_DIR that point outside', () => {
    const outsideFile = path.join(TMP_ROOT, 'outside.csv');
    fs.writeFileSync(outsideFile, 'outside');
    const symlinkPath = path.join(groupDir, 'user', 'outside.csv');
    fs.symlinkSync(outsideFile, symlinkPath);

    expect(() => resolveAgentPath(symlinkPath)).toThrow(/outside GROUPS_DIR/);
  });
});
