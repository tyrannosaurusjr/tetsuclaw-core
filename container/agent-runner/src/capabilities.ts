import fs from 'fs';

export type CapabilityScope = 'all' | 'main';
export type CapabilityRisk = 'read' | 'write' | 'admin' | 'model' | 'external';

export interface CapabilityDefinition {
  name: string;
  category: string;
  scope: CapabilityScope;
  risk: CapabilityRisk;
  summary: string;
  explicitRequest?: boolean;
  requiresEnv?: 'OLLAMA_ADMIN_TOOLS';
}

export interface CapabilityReportOptions {
  isMain: boolean;
  groupFolder?: string;
  includeToolNames?: boolean;
  ollamaAdminEnabled?: boolean;
  gmailAuthAvailable?: boolean;
}

export const SESSION_COMMANDS = [
  '/compact',
  '/capabilities',
  '/ops-health',
] as const;

export const MCP_CAPABILITIES: CapabilityDefinition[] = [
  {
    name: 'capabilities_status',
    category: 'System',
    scope: 'all',
    risk: 'read',
    summary: 'Report current built-in capabilities, scopes, and guardrails.',
  },
  {
    name: 'send_message',
    category: 'Messaging',
    scope: 'all',
    risk: 'write',
    summary: 'Send progress or follow-up messages to the current chat.',
  },
  {
    name: 'react_to_message',
    category: 'Messaging',
    scope: 'all',
    risk: 'write',
    summary: 'React to a message in the current chat.',
  },
  {
    name: 'schedule_task',
    category: 'Scheduling',
    scope: 'all',
    risk: 'write',
    summary: 'Create recurring or one-time agent tasks.',
    explicitRequest: true,
  },
  {
    name: 'list_tasks',
    category: 'Scheduling',
    scope: 'all',
    risk: 'read',
    summary: 'List scheduled tasks visible to the current chat.',
  },
  {
    name: 'pause_task',
    category: 'Scheduling',
    scope: 'all',
    risk: 'admin',
    summary: 'Pause a scheduled task.',
    explicitRequest: true,
  },
  {
    name: 'resume_task',
    category: 'Scheduling',
    scope: 'all',
    risk: 'admin',
    summary: 'Resume a paused scheduled task.',
    explicitRequest: true,
  },
  {
    name: 'cancel_task',
    category: 'Scheduling',
    scope: 'all',
    risk: 'admin',
    summary: 'Cancel and delete a scheduled task.',
    explicitRequest: true,
  },
  {
    name: 'update_task',
    category: 'Scheduling',
    scope: 'all',
    risk: 'admin',
    summary: 'Update an existing scheduled task.',
    explicitRequest: true,
  },
  {
    name: 'refresh_groups',
    category: 'Groups',
    scope: 'main',
    risk: 'admin',
    summary: 'Refresh the available chat/group list from connected channels.',
    explicitRequest: true,
  },
  {
    name: 'register_group',
    category: 'Groups',
    scope: 'main',
    risk: 'admin',
    summary: 'Register a new chat/group for TetsuClaw responses.',
    explicitRequest: true,
  },
  {
    name: 'github_list_repos',
    category: 'GitHub',
    scope: 'main',
    risk: 'read',
    summary: 'List repositories visible through host-mediated GitHub auth.',
  },
  {
    name: 'github_view_repo',
    category: 'GitHub',
    scope: 'main',
    risk: 'read',
    summary: 'Inspect repository metadata through host-mediated GitHub auth.',
  },
  {
    name: 'github_create_repo',
    category: 'GitHub',
    scope: 'main',
    risk: 'write',
    summary: 'Create a private-by-default repository through host GitHub auth.',
    explicitRequest: true,
  },
  {
    name: 'github_commit_file',
    category: 'GitHub',
    scope: 'main',
    risk: 'write',
    summary: 'Create or update one UTF-8 text file in a non-protected repo.',
    explicitRequest: true,
  },
  {
    name: 'model_status',
    category: 'Models',
    scope: 'main',
    risk: 'read',
    summary: 'Check host-mediated model provider availability without secrets.',
  },
  {
    name: 'model_ask',
    category: 'Models',
    scope: 'main',
    risk: 'external',
    summary: 'Ask Codex, Gemini, Ollama, or Claude for a second opinion.',
    explicitRequest: true,
  },
  {
    name: 'x_post',
    category: 'X',
    scope: 'main',
    risk: 'write',
    summary: 'Post to X.',
    explicitRequest: true,
  },
  {
    name: 'x_like',
    category: 'X',
    scope: 'main',
    risk: 'write',
    summary: 'Like an X post.',
    explicitRequest: true,
  },
  {
    name: 'x_reply',
    category: 'X',
    scope: 'main',
    risk: 'write',
    summary: 'Reply to an X post.',
    explicitRequest: true,
  },
  {
    name: 'x_retweet',
    category: 'X',
    scope: 'main',
    risk: 'write',
    summary: 'Retweet an X post.',
    explicitRequest: true,
  },
  {
    name: 'x_quote',
    category: 'X',
    scope: 'main',
    risk: 'write',
    summary: 'Quote an X post.',
    explicitRequest: true,
  },
  {
    name: 'ollama_list_models',
    category: 'Ollama',
    scope: 'all',
    risk: 'read',
    summary: 'List locally installed Ollama models.',
  },
  {
    name: 'ollama_generate',
    category: 'Ollama',
    scope: 'all',
    risk: 'model',
    summary: 'Generate with a local Ollama model.',
  },
  {
    name: 'ollama_pull_model',
    category: 'Ollama',
    scope: 'all',
    risk: 'admin',
    summary: 'Download an Ollama model to the host.',
    explicitRequest: true,
    requiresEnv: 'OLLAMA_ADMIN_TOOLS',
  },
  {
    name: 'ollama_delete_model',
    category: 'Ollama',
    scope: 'all',
    risk: 'admin',
    summary: 'Delete an installed Ollama model from the host.',
    explicitRequest: true,
    requiresEnv: 'OLLAMA_ADMIN_TOOLS',
  },
  {
    name: 'ollama_show_model',
    category: 'Ollama',
    scope: 'all',
    risk: 'read',
    summary: 'Show details for an installed Ollama model.',
    requiresEnv: 'OLLAMA_ADMIN_TOOLS',
  },
  {
    name: 'ollama_list_running',
    category: 'Ollama',
    scope: 'all',
    risk: 'read',
    summary: 'List Ollama models currently loaded in memory.',
    requiresEnv: 'OLLAMA_ADMIN_TOOLS',
  },
];

export const DECLARED_MCP_TOOL_NAMES = MCP_CAPABILITIES.map((cap) => cap.name);

export function detectGmailAuth(authDir = '/home/node/.gmail-mcp'): boolean {
  try {
    return fs.existsSync(authDir);
  } catch {
    return false;
  }
}

export function getRuntimeCapabilityDefinitions(
  options: Pick<CapabilityReportOptions, 'ollamaAdminEnabled'> = {},
): CapabilityDefinition[] {
  const ollamaAdminEnabled =
    options.ollamaAdminEnabled ?? process.env.OLLAMA_ADMIN_TOOLS === 'true';

  return MCP_CAPABILITIES.filter((cap) => {
    if (cap.requiresEnv === 'OLLAMA_ADMIN_TOOLS') return ollamaAdminEnabled;
    return true;
  });
}

function scopeLabel(scope: CapabilityScope, isMain: boolean): string {
  if (scope === 'all') return 'all chats';
  return isMain ? 'main chat' : 'main chat only - unavailable here';
}

function groupByCategory(
  capabilities: CapabilityDefinition[],
): Map<string, CapabilityDefinition[]> {
  const grouped = new Map<string, CapabilityDefinition[]>();
  for (const cap of capabilities) {
    const existing = grouped.get(cap.category) || [];
    existing.push(cap);
    grouped.set(cap.category, existing);
  }
  return grouped;
}

export function formatCapabilitiesReport(
  options: CapabilityReportOptions,
): string {
  const includeToolNames = options.includeToolNames ?? true;
  const capabilities = getRuntimeCapabilityDefinitions(options);
  const grouped = groupByCategory(capabilities);
  const isMain = options.isMain;
  const scope = isMain
    ? 'main chat: main-only host tools are available'
    : 'non-main chat: main-only host tools will refuse';
  const gmailAuthAvailable = options.gmailAuthAvailable ?? detectGmailAuth();
  const gmailStatus = gmailAuthAvailable
    ? 'configured and host auth is mounted'
    : 'configured, auth not detected in this container';

  const lines: string[] = [
    'TetsuClaw capability report',
    `Scope: ${scope}`,
    `Session commands: ${SESSION_COMMANDS.join(', ')}`,
    '',
  ];

  for (const [category, caps] of grouped) {
    lines.push(`${category}:`);
    for (const cap of caps) {
      const toolName = includeToolNames ? `${cap.name} - ` : '';
      const explicit = cap.explicitRequest
        ? ' Explicit user request required.'
        : '';
      lines.push(
        `- ${toolName}${cap.summary} [${scopeLabel(cap.scope, isMain)}, ${cap.risk}]${explicit}`,
      );
    }
    lines.push('');
  }

  lines.push('External MCP:');
  lines.push(
    `- Gmail MCP is ${gmailStatus}; exact Gmail tool names come from the external server.`,
  );
  lines.push('');
  lines.push('Guardrails:');
  lines.push(
    '- GitHub writes require an explicit user request and are limited to single text-file commits.',
  );
  lines.push(
    '- GitHub auth is host-mediated; never request, read, or store user PATs.',
  );
  lines.push(
    '- GitHub writes refuse tetsuclaw-core, secrets, .git internals, and GitHub Actions workflows.',
  );
  lines.push('- Main-only tools refuse outside the main TetsuClaw chat.');
  lines.push(
    '- Stop cleanup redacts known token patterns from transcripts, user memory, and conversation notes.',
  );
  lines.push('');
  lines.push(
    'Source: built-in capability manifest, tested against MCP tool registration.',
  );

  return lines.join('\n').trim();
}
