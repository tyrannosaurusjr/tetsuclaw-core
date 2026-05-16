---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.
The literal `/capabilities` session command is normally intercepted by the
agent runner and answered from the built-in runtime manifest. If a user asks in
normal language, use `mcp__nanoclaw__capabilities_status` as the source of
truth before answering. Do not maintain a handwritten MCP tool list in the
response.

For operational health, `/ops-health` is answered by the NanoClaw host process
before model work starts. It reports service, deploy, queue, IPC, channel, disk,
GitHub auth, and secret-pattern health.

## How to gather the information

Prefer the runtime manifest:

```text
mcp__nanoclaw__capabilities_status
```

Then optionally add local context from the checks below if the user needs more
detail about installed skills or filesystem mounts.

For GitHub capability questions, rely on the runtime manifest and NanoClaw
GitHub MCP tools. GitHub auth is host-mediated: never ask the user for a PAT,
never read or write `github_pat` in `user/context.json`, and report MCP errors
as host integration errors instead of credential requests.

### 1. Installed skills

List skill directories available to you:

```bash
ls -1 /home/node/.claude/skills/ 2>/dev/null || echo "No skills found"
```

Each directory is an installed skill. The directory name is the skill name (e.g., `agent-browser` → `/agent-browser`).

### 2. Container skills (Bash tools)

Check for executable tools in the container:

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
```

### 3. Group info

```bash
ls /workspace/group/CLAUDE.md 2>/dev/null && echo "Group memory: yes" || echo "Group memory: no"
ls /workspace/extra/ 2>/dev/null && echo "Extra mounts: $(ls /workspace/extra/ 2>/dev/null | wc -l | tr -d ' ')" || echo "Extra mounts: none"
```

## Report format

Present the runtime manifest first, then add any optional local checks the user
asked for. Adapt the output based on what you actually find; don't list things
that aren't installed.

**See also:** `/status` for a quick health check of session, workspace, and tasks.
