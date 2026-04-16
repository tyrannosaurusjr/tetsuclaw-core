/**
 * Encrypted Document Vault — Session Manager
 *
 * Manages in-memory vault sessions. The master key exists ONLY in this Map
 * and is explicitly zeroed when the session locks (timeout or explicit lock).
 *
 * The key never touches disk. Process restart = all vaults locked.
 */

import { deriveMasterKey, zeroBuffer } from './crypto.js';
import { createVault, readVaultMeta, vaultExists, verifyVault } from './storage.js';
import { VAULT_SESSION_TIMEOUT } from '../config.js';
import type { VaultSession } from './types.js';

// ── State ───────────────────────────────────────────────────────────────────

const activeSessions = new Map<string, VaultSession>();

// Rate limiting: track failed unlock attempts per group
const unlockAttempts = new Map<
  string,
  { count: number; firstAttempt: number }
>();
const MAX_ATTEMPTS = 3;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Unlock a vault with the user's passphrase.
 * Creates the vault if it doesn't exist yet (first-time setup).
 * Verifies chain integrity on every unlock.
 */
export async function unlockVault(
  groupDir: string,
  groupFolder: string,
  passphrase: string,
): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  // Rate limit check
  const attempts = unlockAttempts.get(groupFolder);
  if (attempts) {
    const elapsed = Date.now() - attempts.firstAttempt;
    if (elapsed < ATTEMPT_WINDOW_MS && attempts.count >= MAX_ATTEMPTS) {
      const waitSec = Math.ceil((ATTEMPT_WINDOW_MS - elapsed) / 1000);
      return {
        ok: false,
        error: `Too many unlock attempts. Try again in ${waitSec}s.`,
      };
    }
    if (elapsed >= ATTEMPT_WINDOW_MS) {
      unlockAttempts.delete(groupFolder);
    }
  }

  // Create vault on first use
  if (!vaultExists(groupDir)) {
    createVault(groupDir);
  }

  const meta = readVaultMeta(groupDir);
  const salt = Buffer.from(meta.salt, 'base64');

  // Derive master key
  let masterKey: Buffer;
  try {
    masterKey = await deriveMasterKey(passphrase, salt, meta.argon2);
  } catch (err) {
    trackFailedAttempt(groupFolder);
    return { ok: false, error: 'Key derivation failed' };
  }

  // Verify chain integrity
  const chainResult = verifyVault(groupDir);
  if (!chainResult.valid) {
    zeroBuffer(masterKey);
    return {
      ok: false,
      error: `Chain integrity check failed: ${chainResult.error}`,
    };
  }

  // If there's an existing session, lock it first
  if (activeSessions.has(groupFolder)) {
    lockVault(groupFolder);
  }

  // Start session with auto-lock timeout
  const timeout = setTimeout(() => {
    lockVault(groupFolder);
  }, VAULT_SESSION_TIMEOUT);

  // Prevent timeout from keeping the process alive
  timeout.unref();

  const session: VaultSession = {
    groupFolder,
    masterKey,
    unlockedAt: Date.now(),
    lastActivity: Date.now(),
    timeout,
  };

  activeSessions.set(groupFolder, session);
  unlockAttempts.delete(groupFolder); // Reset on success
  return { ok: true };
}

/** Lock a vault explicitly or on timeout. Zeros the key. */
export function lockVault(groupFolder: string): boolean {
  const session = activeSessions.get(groupFolder);
  if (!session) return false;

  clearTimeout(session.timeout);
  zeroBuffer(session.masterKey);
  activeSessions.delete(groupFolder);
  return true;
}

/** Check if a vault is currently unlocked. */
export function isUnlocked(groupFolder: string): boolean {
  return activeSessions.has(groupFolder);
}

/**
 * Get the master key for an unlocked vault. Returns null if locked.
 * Also resets the inactivity timeout.
 */
export function getMasterKey(groupFolder: string): Buffer | null {
  const session = activeSessions.get(groupFolder);
  if (!session) return null;

  // Reset inactivity timer
  session.lastActivity = Date.now();
  clearTimeout(session.timeout);
  session.timeout = setTimeout(() => {
    lockVault(groupFolder);
  }, VAULT_SESSION_TIMEOUT);
  session.timeout.unref();

  return session.masterKey;
}

/** Get session info (without exposing the key). */
export function getSessionInfo(
  groupFolder: string,
): { unlocked: boolean; unlockedAt?: number; lastActivity?: number } {
  const session = activeSessions.get(groupFolder);
  if (!session) return { unlocked: false };
  return {
    unlocked: true,
    unlockedAt: session.unlockedAt,
    lastActivity: session.lastActivity,
  };
}

/** Lock all vaults and zero all keys. Called on process shutdown. */
export function lockAllVaults(): void {
  for (const groupFolder of activeSessions.keys()) {
    lockVault(groupFolder);
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

function trackFailedAttempt(groupFolder: string): void {
  const existing = unlockAttempts.get(groupFolder);
  if (existing) {
    existing.count++;
  } else {
    unlockAttempts.set(groupFolder, { count: 1, firstAttempt: Date.now() });
  }
}

// ── Process shutdown: zero all keys ─────────────────────────────────────────

function onShutdown() {
  lockAllVaults();
}

process.on('SIGTERM', onShutdown);
process.on('SIGINT', onShutdown);
process.on('exit', onShutdown);
