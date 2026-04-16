/**
 * Vault IPC Handler — Host-side processing of vault operations
 *
 * Runs on the host (not in the container). Handles unlock/lock/store/retrieve/list/verify
 * operations using the session manager's in-memory keys.
 *
 * The passphrase flow for unlock is handled separately by the Telegram channel —
 * this handler receives a 'vault_unlock' request and coordinates with the pending
 * passphrase callback system.
 */

import fs from 'fs';
import path from 'path';
import {
  unlockVault,
  lockVault,
  isUnlocked,
  getMasterKey,
  getSessionInfo,
} from './session.js';
import {
  storeDocument,
  retrieveDocument,
  deleteDocument,
  listDocuments,
  verifyVault,
  vaultExists,
  readVaultMeta,
  getVaultDir,
} from './storage.js';
import { logger } from '../logger.js';
import type { VaultDocumentType } from './types.js';
import type { IpcDeps } from '../ipc.js';

// Pending passphrase callbacks: when a vault_unlock IPC arrives, we register
// a callback here. The Telegram channel intercepts the next message from the
// user and calls the callback with the passphrase.
type PassphraseCallback = (passphrase: string) => void;
const pendingPassphraseCallbacks = new Map<string, PassphraseCallback>();

/**
 * Register a pending passphrase request. Called by the vault IPC handler.
 * The Telegram channel checks this map when it receives a message from the user.
 */
export function getPendingPassphraseCallback(
  chatJid: string,
): PassphraseCallback | undefined {
  return pendingPassphraseCallbacks.get(chatJid);
}

/** Remove a pending passphrase callback after it's been used. */
export function clearPendingPassphraseCallback(chatJid: string): void {
  pendingPassphraseCallbacks.delete(chatJid);
}

/** Check if there's a pending passphrase request for a chat. */
export function hasPendingPassphrase(chatJid: string): boolean {
  return pendingPassphraseCallbacks.has(chatJid);
}

function writeResult(
  resultsDir: string,
  requestId: string,
  result: { success: boolean; message: string; data?: unknown },
): void {
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultFile = path.join(resultsDir, `${requestId}.json`);
  const tmpFile = `${resultFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(result));
  fs.renameSync(tmpFile, resultFile);
}

/**
 * Write vault status file so the container agent can read it (vault dir is mounted RO).
 */
function writeVaultStatus(groupDir: string, groupFolder: string): void {
  const vaultDir = getVaultDir(groupDir);
  fs.mkdirSync(vaultDir, { recursive: true });

  const unlocked = isUnlocked(groupFolder);
  const meta = vaultExists(groupDir) ? readVaultMeta(groupDir) : null;

  const status = {
    unlocked,
    documentCount: meta?.documentCount ?? 0,
    createdAt: meta?.createdAt,
    ...(unlocked ? { sessionInfo: getSessionInfo(groupFolder) } : {}),
  };

  const statusFile = path.join(vaultDir, 'status.json');
  const tmpFile = `${statusFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(status, null, 2));
  fs.renameSync(tmpFile, statusFile);
}

export async function processVaultIpc(
  data: Record<string, unknown>,
  groupDir: string,
  groupFolder: string,
  resultsDir: string,
  deps: IpcDeps,
): Promise<void> {
  const requestId = data.requestId as string;
  const chatJid = data.chatJid as string;

  if (!requestId) {
    logger.warn({ data }, 'Vault IPC missing requestId');
    return;
  }

  switch (data.type) {
    case 'vault_unlock': {
      // Request the user's passphrase via Telegram
      // We send a prompt message and register a callback for the next message
      const passphrasePromise = new Promise<string>((resolve) => {
        // Set a timeout — if user doesn't respond in 2 minutes, cancel
        const timeout = setTimeout(() => {
          clearPendingPassphraseCallback(chatJid);
          resolve('');
        }, 120000);

        pendingPassphraseCallbacks.set(chatJid, (passphrase: string) => {
          clearTimeout(timeout);
          clearPendingPassphraseCallback(chatJid);
          resolve(passphrase);
        });
      });

      // Prompt the user
      try {
        await deps.sendMessage(
          chatJid,
          '🔐 Send your vault passphrase now.\n\nThis message will be treated as your passphrase and will not be stored or shown to anyone.\n\nIf this is your first time, choose a strong passphrase you will remember — it cannot be recovered.',
        );
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to send passphrase prompt');
        writeResult(resultsDir, requestId, {
          success: false,
          message: 'Failed to send passphrase prompt',
        });
        clearPendingPassphraseCallback(chatJid);
        return;
      }

      const passphrase = await passphrasePromise;

      if (!passphrase) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: 'Vault unlock timed out — no passphrase received.',
        });
        return;
      }

      const result = await unlockVault(groupDir, groupFolder, passphrase);

      writeVaultStatus(groupDir, groupFolder);

      if (result.ok) {
        writeResult(resultsDir, requestId, {
          success: true,
          message: '🔓 Vault unlocked. Your documents are accessible. The vault will auto-lock after 30 minutes of inactivity.',
        });
        logger.info({ groupFolder }, 'Vault unlocked');
      } else {
        writeResult(resultsDir, requestId, {
          success: false,
          message: `Vault unlock failed: ${result.error}`,
        });
        logger.warn({ groupFolder, error: result.error }, 'Vault unlock failed');
      }
      break;
    }

    case 'vault_lock': {
      const locked = lockVault(groupFolder);
      writeVaultStatus(groupDir, groupFolder);

      writeResult(resultsDir, requestId, {
        success: true,
        message: locked
          ? '🔒 Vault locked. Encryption key cleared from memory.'
          : 'Vault was already locked.',
      });
      logger.info({ groupFolder }, 'Vault locked');
      break;
    }

    case 'vault_store': {
      const masterKey = getMasterKey(groupFolder);
      if (!masterKey) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: 'Vault is locked. Unlock it first.',
        });
        return;
      }

      const attachmentRef = data.attachmentRef as string;
      const attachmentPath = path.join(groupDir, attachmentRef);

      if (!fs.existsSync(attachmentPath)) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: `File not found: ${attachmentRef}. Make sure the document was uploaded first.`,
        });
        return;
      }

      try {
        const plaintext = fs.readFileSync(attachmentPath);
        const doc = storeDocument(groupDir, masterKey, plaintext, {
          name: data.name as string,
          type: data.docType as VaultDocumentType,
          tags: (data.tags as string[]) || [],
          notes: (data.notes as string) || '',
          originalFilename: path.basename(attachmentRef),
          mimeType: guessMimeType(attachmentRef),
        });

        // Delete the plaintext attachment after encryption
        fs.unlinkSync(attachmentPath);

        writeVaultStatus(groupDir, groupFolder);

        writeResult(resultsDir, requestId, {
          success: true,
          message: `✅ "${doc.name}" stored securely in vault (${doc.type}). ID: ${doc.id}\nThe plaintext file has been deleted — only the encrypted version remains.`,
          data: { docId: doc.id, name: doc.name, type: doc.type },
        });
        logger.info(
          { groupFolder, docId: doc.id, name: doc.name },
          'Document stored in vault',
        );
      } catch (err) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: `Failed to store document: ${err instanceof Error ? err.message : String(err)}`,
        });
        logger.error({ err, groupFolder }, 'Vault store failed');
      }
      break;
    }

    case 'vault_retrieve': {
      const masterKey = getMasterKey(groupFolder);
      if (!masterKey) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: 'Vault is locked. Unlock it first.',
        });
        return;
      }

      const docId = data.docId as string;

      try {
        const { document: doc, plaintext } = retrieveDocument(
          groupDir,
          masterKey,
          docId,
        );

        // Send the decrypted file to the user via Telegram
        // We write a temporary IPC message that the Telegram channel picks up
        // as a file send request
        const tmpDir = path.join(groupDir, 'vault', '.tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpFile = path.join(tmpDir, doc.originalFilename);
        fs.writeFileSync(tmpFile, plaintext);

        // Write a special IPC message for the Telegram channel to send the file
        const ipcDir = path.join(
          path.dirname(path.dirname(resultsDir)),
          groupFolder,
          'messages',
        );
        fs.mkdirSync(ipcDir, { recursive: true });
        const ipcFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
        const ipcData = {
          type: 'send_document',
          chatJid,
          filePath: tmpFile,
          filename: doc.originalFilename,
          caption: `📄 ${doc.name} (${doc.type})`,
          groupFolder,
          timestamp: new Date().toISOString(),
        };
        const ipcFilePath = path.join(ipcDir, ipcFilename);
        const tmpIpcFile = `${ipcFilePath}.tmp`;
        fs.writeFileSync(tmpIpcFile, JSON.stringify(ipcData, null, 2));
        fs.renameSync(tmpIpcFile, ipcFilePath);

        writeResult(resultsDir, requestId, {
          success: true,
          message: `📄 Sending "${doc.name}" to you now. The file will be decrypted and delivered via Telegram.`,
        });
        logger.info(
          { groupFolder, docId, name: doc.name },
          'Document retrieved from vault',
        );
      } catch (err) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: `Failed to retrieve document: ${err instanceof Error ? err.message : String(err)}`,
        });
        logger.error({ err, groupFolder, docId }, 'Vault retrieve failed');
      }
      break;
    }

    case 'vault_delete': {
      const masterKey = getMasterKey(groupFolder);
      if (!masterKey) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: 'Vault is locked. Unlock it first.',
        });
        return;
      }

      const docId = data.docId as string;

      try {
        deleteDocument(groupDir, masterKey, docId);
        writeVaultStatus(groupDir, groupFolder);

        writeResult(resultsDir, requestId, {
          success: true,
          message: `🗑️ Document ${docId} permanently deleted from vault. This action is recorded in the audit chain.`,
        });
        logger.info({ groupFolder, docId }, 'Document deleted from vault');
      } catch (err) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: `Failed to delete document: ${err instanceof Error ? err.message : String(err)}`,
        });
        logger.error({ err, groupFolder, docId }, 'Vault delete failed');
      }
      break;
    }

    case 'vault_list': {
      const masterKey = getMasterKey(groupFolder);
      if (!masterKey) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: 'Vault is locked. Unlock it first.',
        });
        return;
      }

      try {
        const docs = listDocuments(groupDir, masterKey, {
          type: data.typeFilter as string | undefined,
          tag: data.tagFilter as string | undefined,
        });

        if (docs.length === 0) {
          writeResult(resultsDir, requestId, {
            success: true,
            message: 'Vault is empty. Upload a document and say "store in vault" to get started.',
          });
          return;
        }

        const lines = docs.map(
          (d) =>
            `• ${d.name} [${d.type}] — ${d.id}\n  Added: ${d.addedAt.split('T')[0]} | ${formatBytes(d.sizeBytes)} | Tags: ${d.tags.length > 0 ? d.tags.join(', ') : 'none'}${d.notes ? `\n  Note: ${d.notes}` : ''}`,
        );

        writeResult(resultsDir, requestId, {
          success: true,
          message: `📁 Vault contents (${docs.length} documents):\n\n${lines.join('\n\n')}`,
          data: docs.map((d) => ({
            id: d.id,
            name: d.name,
            type: d.type,
            tags: d.tags,
          })),
        });
      } catch (err) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: `Failed to list documents: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      break;
    }

    case 'vault_verify': {
      try {
        const result = verifyVault(groupDir);

        if (result.valid) {
          const meta = readVaultMeta(groupDir);
          writeResult(resultsDir, requestId, {
            success: true,
            message: `✅ Vault integrity verified.\n• Documents: ${meta.documentCount}\n• Chain head: ${meta.chainHead.slice(0, 16)}...\n• No tampering detected.`,
          });
        } else {
          writeResult(resultsDir, requestId, {
            success: false,
            message: `⚠️ Vault integrity check FAILED:\n${result.error}\nEntry index: ${result.entryIndex}\n\nThis may indicate data tampering. Do not trust vault contents until this is resolved.`,
          });
          logger.error(
            { groupFolder, error: result.error, entryIndex: result.entryIndex },
            'Vault integrity check failed',
          );
        }
      } catch (err) {
        writeResult(resultsDir, requestId, {
          success: false,
          message: `Failed to verify vault: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown vault IPC type');
      writeResult(resultsDir, requestId, {
        success: false,
        message: `Unknown vault operation: ${data.type}`,
      });
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const types: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.doc': 'application/msword',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
  };
  return types[ext] || 'application/octet-stream';
}
