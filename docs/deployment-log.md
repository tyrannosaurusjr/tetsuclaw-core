# Tetsuclaw Deployment Log

*April 1–2, 2026 — tyrannosaurusjr / tetsuclaw-core*

---

## Overview

This document records issues encountered during the initial deployment and configuration of Tetsuclaw — a NanoClaw fork configured as a work operating system for foreign operators in Japan — from a local Mac Studio to a DigitalOcean Droplet running Ubuntu 24.04. Tetsubot (@TetsuNoBot on Telegram) is deployed, always-on, has persistent memory, and can update its own memory file.

---

## Issue 1: Confused Repository Structure

**Problem:** Three local folders existed simultaneously with no clear purpose: `/Users/mkultraman/Projects/nanoclaw` (pointing at tetsunoclaw-private), `~/Desktop/tyrannojr-github/nanoclaw` (bare upstream fork), and `~/.config/nanoclaw` (config/data directory).

**Resolution:** Identified the real repo via `git log` and `git remote -v`. Renamed: `nanoclaw` → `nanoclaw-upstream`, `Projects/nanoclaw` → `tyrannojr-github/tetsuclaw`.

---

## Issue 2: /setup Autocompleting to /terminal-setup

**Problem:** Shell autocomplete inside Claude Code submitted `/terminal-setup` instead of `/setup`.

**Resolution:** Press Escape to dismiss autocomplete before Enter. Or use plain text: "read the README and set up this project".

---

## Issue 3: Forked an Empty Folder

**Problem:** Created `~/Projects/nanoclaw` manually before running `gh repo fork`, resulting in an empty folder with no git history.

**Resolution:**
```bash
gh repo fork qwibitai/nanoclaw --clone
```
Note: `--remote` flag is not supported when a repository argument is provided.

---

## Issue 4: DigitalOcean Droplet Undersized (OOM)

**Problem:** $6/month Droplet (1GB RAM) — TypeScript compilation killed by OOM killer repeatedly.

**Resolution:** Resized to $12/month (2GB RAM). Also pass `NODE_OPTIONS="--max-old-space-size=2048"` during compilation.

---

## Issue 5: Bot Token Exposed in Conversation

**Problem:** Telegram bot token pasted into chat during debugging.

**Resolution:** Rotated via @BotFather → /mybots → TetsuNoBot → API Token → Revoke. Updated `.env` on Droplet, restarted service.

---

## Issue 6: Stale Session ID Causing Retry Loop (Occurred Twice)

**Problem:** After migration and again after token rotation, the database retained a stale Claude Code session ID. Agent looped trying to resume a dead session indefinitely.

**Temporary Resolution (Manual):**
```bash
sudo systemctl stop nanoclaw
rm -rf groups/
rm store/messages.db
sudo systemctl start nanoclaw
```

**Permanent Resolution (Code Fix):** Added `deleteSession()` to `db.ts`. Updated `index.ts` error handler to detect "No conversation found with session ID" and automatically clear the stale session — no manual intervention needed going forward.

---

## Issue 7: Two Bot Instances Running Simultaneously

**Problem:** Mac Studio instance still running after Droplet deployment — intercepted all Telegram messages.

**Resolution:**
```bash
ps aux | grep "dist/index.js"
kill <PID>
```

---

## Issue 8: Missing CLAUDE_CODE_OAUTH_TOKEN

**Problem:** Agent containers spawning but immediately failing — no OAuth token in `.env` on Droplet.

**Resolution:**
```bash
claude setup-token
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" >> .env
```

---

## Issue 9: Chat Not Registered (Recurred After Each DB Wipe)

**Problem:** Bot responded to `/chatid` but ignored regular messages. Required re-registration after every database wipe.

**Resolution:** Run `/add-telegram` in Claude Code after each db wipe. Send `/chatid` first to get the chat ID.

---

## Issue 10: CLAUDE.md Formatting Lost on Paste

**Problem:** Pasting markdown into TextEdit or nano stripped formatting symbols. Large pastes into nano caused truncation.

**Resolution:** Generated file in Claude.ai computer environment as downloadable output, copied into place via terminal.

---

## Issue 11: Fork Cannot Be Made Private on GitHub

**Problem:** `tetsunoclaw-private` was a fork of public `qwibitai/nanoclaw` — GitHub blocks visibility changes on forks.

**Resolution:** Created fresh private repo `tetsuclaw-core` with no fork relationship. Updated remotes on Droplet and Mac.

---

## Issue 12: Wrong SSH Identity (LobsterBurnerBot)

**Problem:** Git authenticated as LobsterBurnerBot instead of tyrannosaurusjr — wrong default SSH key.

**Resolution:**
```bash
git remote set-url origin git@github-tyrannosaurusjr:tyrannosaurusjr/tetsuclaw-core.git
```

---

## Issue 13: Persistent Memory Not Working Initially

**Problem:** Auto-memory enabled in container config but CLAUDE.md was always empty. Tetsubot reported no persistent memory.

**Resolution:** Created starter CLAUDE.md with identity context and explicit instructions to update the file. Tetsubot immediately greeted Tetsu by name and confirmed memory saved.

---

## Issue 14: Old Subagent Config Overwrote Memory File

**Problem:** `groups/telegram_main/CLAUDE.md` contained the old complex subagent config (税理士, agent teams, etc.) from a previous Tetsunoclaw build. Tetsubot introduced itself as a multi-agent coordinator instead of a personal assistant.

**Resolution:** Replaced entire CLAUDE.md with a clean memory-focused file containing Tetsu's identity, food preferences, and instructions to update the file when given new information.

---

## Issue 15: CLAUDE.md Write Permissions Blocked

**Problem:** CLAUDE.md owned by root (`-rw-r--r--`). Container runs as user `node` (UID 1000). Container could read memory but not update it — Tetsubot reported hitting a permissions wall when trying to save new information.

**Resolution:**
```bash
chown -R 1000:1000 ~/tetsuclaw/groups/telegram_main/
chmod -R 775 ~/tetsuclaw/groups/telegram_main/
```
Container can now read and write the full group folder including CLAUDE.md.

---

## Issue 16: Google Maps Scraper — Cross-Platform Auth Failure

**Problem:** Built a Playwright scraper to pull saved places from Google Maps. Multiple approaches failed: cookie injection (Google rejected account-feature access from headless browser), direct URL navigation (404 or redirect to regular map), hamburger menu click (selector mismatches). Chrome profile copied from Mac to Droplet failed because Chrome session tokens are encrypted with platform-specific keys — macOS profiles don't work on Linux Chromium.

**Current Status:** Parked. Workaround: exported Google Maps reviews via Google Takeout (49 places, 5-star rated), parsed into structured JSON, deployed to `groups/telegram_main/data/tetsu-reviewed-places.json`. CLAUDE.md updated to reference this file for restaurant recommendations.

**Remaining:** The hamburger menu opens and Saved is visible, but `div[role='menuitem']` filter and `getByText('Saved')` both fail to click it. Further selector investigation needed.

---

## Issue 17: Group and Trigger Name Cleanup

**Problem:** Group registered as "Tetsuko Main" with trigger "@Tetsunobot" — both incorrect. "Tetsuko" used throughout codebase after decision to rename to Tetsubot.

**Resolution:**
```bash
sqlite3 store/messages.db "UPDATE registered_groups SET name='Tetsubot Main' WHERE name='Tetsuko Main';"
sqlite3 store/messages.db "UPDATE registered_groups SET trigger_pattern='@TetsuNoBot' WHERE jid='tg:5167303436';"
```
Also purged all "Tetsuko" references from CLAUDE.md via sed.

---

## Final Status

Tetsuclaw / Tetsubot is fully operational as of April 2, 2026:

- **Bot:** @TetsuNoBot on Telegram
- **Hosting:** DigitalOcean Droplet, Singapore region (174.138.22.14), $12/month
- **Runtime:** tetsuclaw-core (private) on GitHub
- **Service:** nanoclaw.service on systemd — survives reboots
- **Container isolation:** Docker on Ubuntu 24.04
- **Bot token:** rotated and secured
- **Stale session bug:** permanently fixed in code
- **Memory:** persistent via `groups/telegram_main/CLAUDE.md` — read/write enabled
- **Tetsubot can update its own memory** when told new information
- **49 reviewed places** loaded as restaurant reference data
- **Group:** Tetsubot Main, trigger: @TetsuNoBot

---

## Outstanding Items

- Response time: cold container start takes 60-120 seconds — persistent sessions would improve this
- Google Maps scraper: selector issue with Saved menu item — partially built, parked
- Cron job: scheduled nightly data refresh not yet configured
- Additional agents: Money, People, Time, Intel, Words, Events, Home, Transit, Health, Legal, Docs — all specced, none built yet

---

*Tetsuclaw — One-man army infrastructure. Zero consensus meetings required.*
