import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function realpathOrResolve(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function resolveProjectRoot(): string {
  const configuredRoot = process.env.NANOCLAW_ROOT?.trim();
  if (configuredRoot) return realpathOrResolve(configuredRoot);

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return realpathOrResolve(path.resolve(moduleDir, '..'));
}

export const PROJECT_ROOT = resolveProjectRoot();
