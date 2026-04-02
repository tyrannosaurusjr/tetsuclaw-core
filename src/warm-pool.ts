/**
 * Warm Pool for NanoClaw
 *
 * Pre-spawns a single Docker container for the main group so it's ready
 * to accept input the moment a message arrives.  The container blocks on
 * `cat > /tmp/input.json` (the entrypoint) until stdin is piped.
 *
 * When claimed, the caller writes ContainerInput JSON to stdin and the
 * container starts processing immediately — no cold-start delay.
 * A replacement warm container is spawned in the background after each claim.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';

import { buildContainerArgs, buildVolumeMounts } from './container-runner.js';
import { CONTAINER_RUNTIME_BIN, stopContainer } from './container-runtime.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/** Delay before respawning after an unexpected warm container exit. */
const RESPAWN_DELAY_MS = 2000;

export interface WarmContainer {
  proc: ChildProcess;
  name: string;
}

export class WarmPool {
  private warm: WarmContainer | null = null;
  private spawning = false;
  private stopped = false;

  constructor(private group: RegisteredGroup) {}

  /** Spawn the first warm container. Call once after startup. */
  async start(): Promise<void> {
    await this.spawnWarm();
  }

  private async spawnWarm(): Promise<void> {
    if (this.stopped || this.spawning || this.warm) return;
    this.spawning = true;

    try {
      const groupDir = resolveGroupFolderPath(this.group.folder);
      fs.mkdirSync(groupDir, { recursive: true });

      const mounts = buildVolumeMounts(this.group, true);
      const safeName = this.group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
      const containerName = `nanoclaw-warm-${safeName}-${Date.now()}`;
      const containerArgs = await buildContainerArgs(mounts, containerName);

      const proc = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Handle unexpected exits while warming.
      // Once claimed, this.warm is null so the check below is a no-op.
      proc.on('close', (code) => {
        if (this.warm?.proc === proc) {
          logger.warn(
            { containerName, code },
            'Warm container exited unexpectedly, respawning',
          );
          this.warm = null;
          if (!this.stopped) {
            setTimeout(() => this.spawnWarm(), RESPAWN_DELAY_MS);
          }
        }
      });

      proc.on('error', (err) => {
        logger.warn({ containerName, err }, 'Warm container spawn error');
        if (this.warm?.proc === proc) {
          this.warm = null;
          if (!this.stopped) {
            setTimeout(() => this.spawnWarm(), RESPAWN_DELAY_MS);
          }
        }
      });

      this.warm = { proc, name: containerName };
      logger.info({ containerName }, 'Warm container ready');
    } catch (err) {
      logger.warn({ err }, 'Failed to spawn warm container');
    } finally {
      this.spawning = false;
    }
  }

  /**
   * Claim the warm container for immediate use.
   * Returns the container process + name, or null if unavailable.
   * Automatically spawns a replacement in the background.
   */
  claim(): WarmContainer | null {
    const container = this.warm;
    if (!container) return null;

    // Verify the process is still alive
    if (container.proc.killed || container.proc.exitCode !== null) {
      this.warm = null;
      this.spawnWarm();
      return null;
    }

    this.warm = null;
    logger.info({ containerName: container.name }, 'Warm container claimed');

    // Spawn replacement in background
    this.spawnWarm();

    return container;
  }

  /** Whether a warm container is ready to be claimed. */
  isAvailable(): boolean {
    return (
      this.warm !== null &&
      !this.warm.proc.killed &&
      this.warm.proc.exitCode === null
    );
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const container = this.warm;
    if (container) {
      this.warm = null;
      try {
        stopContainer(container.name);
      } catch {
        // already stopped
      }
      logger.info({ containerName: container.name }, 'Warm container stopped');
    }
  }
}
