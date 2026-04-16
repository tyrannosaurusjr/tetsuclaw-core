/**
 * Encrypted Document Vault — Hash Chain
 *
 * Append-only tamper-evident log. Each entry includes a hash of the previous
 * entry, forming a chain. Verification recomputes every hash and checks linkage.
 *
 * The chain file (chain.jsonl) contains NO PII — only hashes, document IDs,
 * operation types, and timestamps.
 */

import fs from 'fs';
import path from 'path';
import { sha256String } from './crypto.js';
import type { ChainEntry, ChainOperation } from './types.js';

const CHAIN_FILENAME = 'chain.jsonl';
const GENESIS_HASH =
  '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Compute the entryHash for a chain entry.
 * Hash input: seq || op || docId || docHash || metaHash || prevHash || timestamp
 */
export function computeEntryHash(
  entry: Omit<ChainEntry, 'entryHash'>,
): string {
  const preimage = [
    entry.seq.toString(),
    entry.op,
    entry.docId,
    entry.docHash,
    entry.metaHash,
    entry.prevHash,
    entry.timestamp,
  ].join('||');
  return sha256String(preimage);
}

/**
 * Read all chain entries from the JSONL file.
 * Returns empty array if the file doesn't exist.
 */
export function readChain(vaultDir: string): ChainEntry[] {
  const chainPath = path.join(vaultDir, CHAIN_FILENAME);
  if (!fs.existsSync(chainPath)) return [];

  const lines = fs
    .readFileSync(chainPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);

  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as ChainEntry;
    } catch {
      throw new Error(`Vault chain: malformed entry at line ${i + 1}`);
    }
  });
}

/**
 * Append a new entry to the chain. Returns the new entry.
 */
export function appendChainEntry(
  vaultDir: string,
  op: ChainOperation,
  docId: string,
  docHash: string,
  metaHash: string,
): ChainEntry {
  const chain = readChain(vaultDir);
  const prevHash =
    chain.length > 0 ? chain[chain.length - 1].entryHash : GENESIS_HASH;
  const seq = chain.length + 1;

  const partial = {
    seq,
    op,
    docId,
    docHash,
    metaHash,
    prevHash,
    timestamp: new Date().toISOString(),
  };

  const entry: ChainEntry = {
    ...partial,
    entryHash: computeEntryHash(partial),
  };

  // Append atomically: write to temp then rename would break append semantics,
  // so we append directly. The JSONL format is crash-safe as long as each line
  // is written atomically (which fs.appendFileSync provides for small writes).
  const chainPath = path.join(vaultDir, CHAIN_FILENAME);
  fs.appendFileSync(chainPath, JSON.stringify(entry) + '\n');

  return entry;
}

/**
 * Verify the entire chain's integrity.
 * Returns { valid: true } or { valid: false, error, entryIndex }.
 */
export function verifyChain(
  vaultDir: string,
  expectedHead?: string,
): { valid: true } | { valid: false; error: string; entryIndex: number } {
  const chain = readChain(vaultDir);

  if (chain.length === 0) {
    if (expectedHead && expectedHead !== GENESIS_HASH) {
      return {
        valid: false,
        error: 'Chain is empty but expected a non-genesis head',
        entryIndex: -1,
      };
    }
    return { valid: true };
  }

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];

    // Check sequence number
    if (entry.seq !== i + 1) {
      return {
        valid: false,
        error: `Expected seq ${i + 1}, got ${entry.seq}`,
        entryIndex: i,
      };
    }

    // Check prevHash linkage
    const expectedPrev =
      i === 0 ? GENESIS_HASH : chain[i - 1].entryHash;
    if (entry.prevHash !== expectedPrev) {
      return {
        valid: false,
        error: `prevHash mismatch at seq ${entry.seq}`,
        entryIndex: i,
      };
    }

    // Recompute and check entryHash
    const { entryHash: _, ...partial } = entry;
    const recomputed = computeEntryHash(partial);
    if (recomputed !== entry.entryHash) {
      return {
        valid: false,
        error: `entryHash tampered at seq ${entry.seq}`,
        entryIndex: i,
      };
    }
  }

  // Check head matches expected
  if (expectedHead) {
    const actualHead = chain[chain.length - 1].entryHash;
    if (actualHead !== expectedHead) {
      return {
        valid: false,
        error: `Chain head mismatch: expected ${expectedHead}, got ${actualHead}`,
        entryIndex: chain.length - 1,
      };
    }
  }

  return { valid: true };
}

/**
 * Get the current chain head hash.
 * Returns the genesis hash if the chain is empty.
 */
export function getChainHead(vaultDir: string): string {
  const chain = readChain(vaultDir);
  return chain.length > 0 ? chain[chain.length - 1].entryHash : GENESIS_HASH;
}

export { GENESIS_HASH };
