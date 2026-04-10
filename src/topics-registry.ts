/**
 * Topic registry — v2 schema with auto-migration from v1.
 *
 * v1 shape: { topicName: threadId | null }
 * v2 shape: { version: 2, topics: { topicName: TopicEntry } }
 *
 * Reads/writes are atomic (temp + rename) to avoid torn writes
 * under concurrent topic creation.
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopicEntry {
  thread_id: number | null;
  subjects: string[];
  agents: string[];
  description: string;
  created_at: string; // ISO-8601
  source: 'agent' | 'manual' | 'migrated';
}

export interface TopicsV2 {
  version: 2;
  topics: Record<string, TopicEntry>;
}

export interface Proposal {
  name: string;
  subjects: string[];
  agents: string[];
  description: string;
  rationale: string;
  created_at: string; // ISO-8601
}

export interface ProposalsFile {
  proposals: Proposal[];
}

// ---------------------------------------------------------------------------
// Atomic file helpers
// ---------------------------------------------------------------------------

function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

function isV1(data: unknown): data is Record<string, number | null> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  // v2 has a "version" key; v1 does not
  if ('version' in (data as Record<string, unknown>)) return false;
  // Every value should be number | null (topic thread IDs)
  return Object.values(data as Record<string, unknown>).every(
    (v) => v === null || typeof v === 'number',
  );
}

function isV2(data: unknown): data is TopicsV2 {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return obj.version === 2 && typeof obj.topics === 'object' && obj.topics !== null;
}

export function migrateV1toV2(v1: Record<string, number | null>): TopicsV2 {
  const now = new Date().toISOString();
  const topics: Record<string, TopicEntry> = {};
  for (const [name, threadId] of Object.entries(v1)) {
    topics[name] = {
      thread_id: threadId,
      subjects: [],
      agents: [],
      description: '',
      created_at: now,
      source: 'migrated',
    };
  }
  return { version: 2, topics };
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load and (if needed) migrate topics.json from the given group directory.
 * If the file is corrupt, quarantines it and returns a fresh v2 registry.
 * If the file doesn't exist, returns a fresh v2 registry (does NOT write it).
 */
export function loadTopics(groupDir: string): TopicsV2 {
  const topicsPath = path.join(groupDir, 'topics.json');

  if (!fs.existsSync(topicsPath)) {
    return { version: 2, topics: {} };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(topicsPath, 'utf-8');
  } catch (err) {
    logger.error({ err, topicsPath }, 'Failed to read topics.json');
    return { version: 2, topics: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON — quarantine the file
    const quarantinePath = topicsPath + '.corrupt-' + Date.now();
    logger.error({ topicsPath, quarantinePath }, 'Corrupt topics.json, quarantining');
    try {
      fs.renameSync(topicsPath, quarantinePath);
    } catch (renameErr) {
      logger.error({ renameErr }, 'Failed to quarantine corrupt topics.json');
    }
    return { version: 2, topics: {} };
  }

  if (isV2(parsed)) {
    return parsed;
  }

  if (isV1(parsed)) {
    const migrated = migrateV1toV2(parsed);
    // Persist the migration immediately
    saveTopics(groupDir, migrated);
    logger.info({ topicsPath, count: Object.keys(migrated.topics).length }, 'Migrated topics.json v1 → v2');
    return migrated;
  }

  // Unrecognized shape — quarantine
  const quarantinePath = topicsPath + '.corrupt-' + Date.now();
  logger.error({ topicsPath, quarantinePath }, 'Unrecognized topics.json shape, quarantining');
  try {
    fs.renameSync(topicsPath, quarantinePath);
  } catch (renameErr) {
    logger.error({ renameErr }, 'Failed to quarantine unrecognized topics.json');
  }
  return { version: 2, topics: {} };
}

/**
 * Persist the v2 registry to disk atomically.
 */
export function saveTopics(groupDir: string, registry: TopicsV2): void {
  const topicsPath = path.join(groupDir, 'topics.json');
  atomicWriteSync(topicsPath, JSON.stringify(registry, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Topic operations
// ---------------------------------------------------------------------------

/**
 * Insert or update a topic entry. Returns the updated registry.
 */
export function upsertTopic(
  registry: TopicsV2,
  name: string,
  entry: Partial<TopicEntry> & { thread_id: number | null },
): TopicsV2 {
  const existing = registry.topics[name];
  registry.topics[name] = {
    thread_id: entry.thread_id,
    subjects: entry.subjects ?? existing?.subjects ?? [],
    agents: entry.agents ?? existing?.agents ?? [],
    description: entry.description ?? existing?.description ?? '',
    created_at: entry.created_at ?? existing?.created_at ?? new Date().toISOString(),
    source: entry.source ?? existing?.source ?? 'manual',
  };
  return registry;
}

/**
 * Get the thread ID for a named topic, or null if not found / not yet created.
 */
export function getThreadId(registry: TopicsV2, name: string): number | null {
  return registry.topics[name]?.thread_id ?? null;
}

/**
 * Return all topics with their metadata.
 */
export function listTopics(registry: TopicsV2): Record<string, TopicEntry> {
  return registry.topics;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

const PROPOSAL_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PROPOSAL_RATE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24 hours

function proposalsPath(groupDir: string): string {
  return path.join(groupDir, 'pending_proposals.json');
}

function sortedSubjectTuple(subjects: string[]): string {
  return [...subjects].sort().join(',').toLowerCase();
}

export function loadProposals(groupDir: string): ProposalsFile {
  const filePath = proposalsPath(groupDir);
  if (!fs.existsSync(filePath)) {
    return { proposals: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.proposals)) {
      return parsed as ProposalsFile;
    }
  } catch {
    // Corrupt — start fresh
    logger.warn({ filePath }, 'Corrupt pending_proposals.json, starting fresh');
  }
  return { proposals: [] };
}

export function saveProposals(groupDir: string, file: ProposalsFile): void {
  atomicWriteSync(proposalsPath(groupDir), JSON.stringify(file, null, 2) + '\n');
}

/**
 * Remove proposals older than TTL. Returns the pruned file.
 */
export function pruneExpiredProposals(file: ProposalsFile, now?: Date): ProposalsFile {
  const cutoff = (now ?? new Date()).getTime() - PROPOSAL_TTL_MS;
  return {
    proposals: file.proposals.filter(
      (p) => new Date(p.created_at).getTime() > cutoff,
    ),
  };
}

export type AddProposalResult =
  | { ok: true }
  | { ok: false; error: 'rate_limited' | 'already_exists' };

/**
 * Add a proposal. Rate-limited by sorted subject tuple (same subjects
 * cannot be re-proposed within 24h, even across different proposal names).
 * Also rejects if the topic name already exists in the registry.
 */
export function addProposal(
  groupDir: string,
  registry: TopicsV2,
  proposal: Omit<Proposal, 'created_at'>,
  now?: Date,
): AddProposalResult {
  // Check if topic already exists
  if (registry.topics[proposal.name]) {
    return { ok: false, error: 'already_exists' };
  }

  const file = loadProposals(groupDir);

  // Rate-limit by subject tuple — check BEFORE pruning so that expired
  // proposals still block re-proposals within the 24h rate window.
  const tuple = sortedSubjectTuple(proposal.subjects);
  const rateCutoff = (now ?? new Date()).getTime() - PROPOSAL_RATE_LIMIT_MS;
  const recentMatch = file.proposals.find(
    (p) =>
      sortedSubjectTuple(p.subjects) === tuple &&
      new Date(p.created_at).getTime() > rateCutoff,
  );
  if (recentMatch) {
    return { ok: false, error: 'rate_limited' };
  }

  // Prune expired proposals for the file we persist
  const pruned = pruneExpiredProposals(file, now);
  pruned.proposals.push({
    ...proposal,
    created_at: (now ?? new Date()).toISOString(),
  });
  saveProposals(groupDir, pruned);
  return { ok: true };
}

/**
 * Get non-expired proposals.
 */
export function getProposals(groupDir: string, now?: Date): Proposal[] {
  let file = loadProposals(groupDir);
  file = pruneExpiredProposals(file, now);
  return file.proposals;
}
