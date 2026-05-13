import fs from 'fs';
import path from 'path';

type Platform = NodeJS.Platform;
type Arch = NodeJS.Architecture;

interface ResolveOptions {
  baseDir?: string;
  platform?: Platform;
  arch?: Arch;
  isGlibc?: boolean;
  existsSync?: (filePath: string) => boolean;
  accessSync?: (filePath: string, mode?: number) => void;
}

const DEFAULT_ANTHROPIC_DIR = '/app/node_modules/@anthropic-ai';
const GLOBAL_CLAUDE_PATH = '/usr/local/bin/claude';

function isRunningOnGlibc(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return Boolean(report?.header?.glibcVersionRuntime);
}

function executablePath(baseDir: string, packageName: string): string {
  return path.join(baseDir, packageName, 'claude');
}

export function candidateClaudeCodeExecutables(
  options: ResolveOptions = {},
): string[] {
  const baseDir = options.baseDir ?? DEFAULT_ANTHROPIC_DIR;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const isGlibc = options.isGlibc ?? isRunningOnGlibc();

  if (platform === 'linux') {
    const linuxArch =
      arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined;
    if (linuxArch) {
      const glibcPackage = `claude-agent-sdk-linux-${linuxArch}`;
      const muslPackage = `claude-agent-sdk-linux-${linuxArch}-musl`;
      const preferred = isGlibc
        ? [glibcPackage, muslPackage]
        : [muslPackage, glibcPackage];

      return [
        ...preferred.map((packageName) => executablePath(baseDir, packageName)),
        GLOBAL_CLAUDE_PATH,
      ];
    }
  }

  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    return [
      executablePath(baseDir, `claude-agent-sdk-darwin-${arch}`),
      GLOBAL_CLAUDE_PATH,
    ];
  }

  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    return [
      path.join(baseDir, `claude-agent-sdk-win32-${arch}`, 'claude.exe'),
    ];
  }

  return [GLOBAL_CLAUDE_PATH];
}

export function resolveClaudeCodeExecutable(
  options: ResolveOptions = {},
): string | undefined {
  const existsSync = options.existsSync ?? fs.existsSync;
  const accessSync = options.accessSync ?? fs.accessSync;

  for (const candidate of candidateClaudeCodeExecutables(options)) {
    if (!existsSync(candidate)) continue;

    try {
      accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}
