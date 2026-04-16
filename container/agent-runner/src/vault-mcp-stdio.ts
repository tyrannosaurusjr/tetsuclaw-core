/**
 * Vault MCP Server for NanoClaw
 * Standalone stdio MCP process for encrypted document vault operations.
 *
 * The agent NEVER handles encryption keys or passphrases directly.
 * All sensitive operations flow through IPC to the host, where the key lives.
 * The vault directory is mounted read-only — agents can check status but not
 * modify vault contents directly.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const VAULT_IPC_DIR = path.join(IPC_DIR, 'vault');
const VAULT_DIR = '/workspace/vault';
const VAULT_META_FILE = path.join(VAULT_DIR, 'vault.json');
const VAULT_STATUS_FILE = path.join(VAULT_DIR, 'status.json');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;

const DOCUMENT_TYPES = [
  'land_registration',
  'marriage_license',
  'business_doc',
  'tax_filing',
  'contract',
  'lease',
  'visa_document',
  'insurance',
  'certificate',
  'other',
] as const;

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

/**
 * Read the vault status file written by the host.
 * Returns null if vault doesn't exist or status file is missing.
 */
function readVaultStatus(): {
  unlocked: boolean;
  documentCount: number;
  createdAt?: string;
} | null {
  // Check host-managed status file first (updated on unlock/lock)
  if (fs.existsSync(VAULT_STATUS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(VAULT_STATUS_FILE, 'utf-8'));
    } catch {
      // Fall through to vault.json check
    }
  }

  // Fall back to vault.json for basic info
  if (fs.existsSync(VAULT_META_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(VAULT_META_FILE, 'utf-8'));
      return {
        unlocked: false, // Can't know from meta alone; assume locked
        documentCount: meta.documentCount || 0,
        createdAt: meta.createdAt,
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Wait for a vault operation result from the host.
 * The host writes result files to the IPC vault results directory.
 */
async function waitForVaultResult(
  requestId: string,
  maxWait = 30000,
): Promise<{ success: boolean; message: string; data?: unknown }> {
  const resultDir = path.join(IPC_DIR, 'vault_results');
  const resultFile = path.join(resultDir, `${requestId}.json`);
  const pollInterval = 500;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch {
        return { success: false, message: 'Failed to read vault result' };
      }
    }
    await new Promise((r) => setTimeout(r, pollInterval));
    elapsed += pollInterval;
  }
  return { success: false, message: 'Vault operation timed out' };
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'vault',
  version: '1.0.0',
});

server.tool(
  'vault_status',
  'Check whether the vault exists, is locked or unlocked, and how many documents it contains.',
  {},
  async () => {
    const status = readVaultStatus();

    if (!status) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No vault exists yet. The user can create one by saying "set up my vault" or "unlock vault".',
          },
        ],
      };
    }

    const lines = [
      `Vault status: ${status.unlocked ? 'UNLOCKED' : 'LOCKED'}`,
      `Documents stored: ${status.documentCount}`,
    ];
    if (status.createdAt) lines.push(`Created: ${status.createdAt}`);

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

server.tool(
  'vault_unlock',
  'Request vault unlock. The host will prompt the user for their passphrase via a secure Telegram DM (the agent never sees the passphrase). If this is the first time, a new vault is created.',
  {},
  async () => {
    const requestId = `vunlock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(VAULT_IPC_DIR, {
      type: 'vault_unlock',
      requestId,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForVaultResult(requestId, 120000); // 2 min — user needs time to type passphrase
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
  },
);

server.tool(
  'vault_lock',
  'Lock the vault immediately. Clears the encryption key from server memory.',
  {},
  async () => {
    const requestId = `vlock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(VAULT_IPC_DIR, {
      type: 'vault_lock',
      requestId,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForVaultResult(requestId);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
  },
);

server.tool(
  'vault_store',
  'Store a document that the user uploaded via Telegram into the encrypted vault. The host encrypts the file — the agent never touches the raw document. Call this after the user sends a file with a vault-related caption.',
  {
    name: z
      .string()
      .describe(
        'Human-readable document name (e.g., "Marriage Certificate", "Yugawara Land Registration")',
      ),
    doc_type: z
      .enum(DOCUMENT_TYPES)
      .describe('Document classification type'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Tags for organization (e.g., ["personal", "legal"])'),
    notes: z
      .string()
      .optional()
      .describe('Additional notes about this document'),
    attachment_ref: z
      .string()
      .describe(
        'The attachment reference from the message (e.g., "attachments/my-doc.pdf")',
      ),
  },
  async (args) => {
    const requestId = `vstore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(VAULT_IPC_DIR, {
      type: 'vault_store',
      requestId,
      chatJid,
      groupFolder,
      name: args.name,
      docType: args.doc_type,
      tags: args.tags || [],
      notes: args.notes || '',
      attachmentRef: args.attachment_ref,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForVaultResult(requestId, 60000); // Large files may take time
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
  },
);

server.tool(
  'vault_list',
  'List documents stored in the vault. Requires the vault to be unlocked.',
  {
    type_filter: z
      .enum(DOCUMENT_TYPES)
      .optional()
      .describe('Filter by document type'),
    tag_filter: z.string().optional().describe('Filter by tag'),
  },
  async (args) => {
    const requestId = `vlist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(VAULT_IPC_DIR, {
      type: 'vault_list',
      requestId,
      chatJid,
      groupFolder,
      typeFilter: args.type_filter,
      tagFilter: args.tag_filter,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForVaultResult(requestId);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
  },
);

server.tool(
  'vault_retrieve',
  'Retrieve and decrypt a document from the vault. The decrypted file is sent directly to the user via Telegram — the agent never sees the file contents.',
  {
    doc_id: z
      .string()
      .describe('Document ID (from vault_list results)'),
  },
  async (args) => {
    const requestId = `vget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(VAULT_IPC_DIR, {
      type: 'vault_retrieve',
      requestId,
      chatJid,
      groupFolder,
      docId: args.doc_id,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForVaultResult(requestId, 60000);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
  },
);

server.tool(
  'vault_delete',
  'Permanently delete a document from the vault. This cannot be undone. The deletion is recorded in the audit chain.',
  {
    doc_id: z
      .string()
      .describe('Document ID to delete (from vault_list results)'),
  },
  async (args) => {
    const requestId = `vdel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(VAULT_IPC_DIR, {
      type: 'vault_delete',
      requestId,
      chatJid,
      groupFolder,
      docId: args.doc_id,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForVaultResult(requestId);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
  },
);

server.tool(
  'vault_verify',
  'Verify the integrity of the vault. Checks the hash chain for tampering and reports results.',
  {},
  async () => {
    const requestId = `vverify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(VAULT_IPC_DIR, {
      type: 'vault_verify',
      requestId,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForVaultResult(requestId);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
