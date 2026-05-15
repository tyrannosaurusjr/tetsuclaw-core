# Tetsuclaw Setup Guide

A precision AI operating system for English-speaking operators in Japan. 13 specialist agents handle tax, legal, banking, real estate, transit, healthcare, government paperwork, and more — so you don't have to depend on systems that weren't built for you.

---

## Prerequisites

- A VPS (DigitalOcean Droplet recommended), minimum 1GB RAM (2GB recommended)
- Ubuntu 22.04+ or macOS
- Docker installed
- A Telegram account
- An Anthropic API key or Claude Pro/Max subscription
- ~30 minutes

---

## Step 1: Create Telegram Bots

You need a main bot plus pool bots for agent identities.

### Main bot
1. Open Telegram, message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Name it whatever you want (e.g., "TetsuClaw")
4. Save the token — this is your `TELEGRAM_BOT_TOKEN`

### Pool bots (recommended: 3-6)
Each pool bot becomes a separate agent identity in the group. The system renames them dynamically.

1. Repeat `/newbot` for each pool bot (names don't matter — "Pool1", "Pool2", etc.)
2. Save all tokens — these go in `TELEGRAM_BOT_POOL` as a comma-separated list

### Disable group privacy for all bots
For each bot (main + pool):
1. `/mybots` → select the bot → **Bot Settings** → **Group Privacy** → **Turn off**

### Create a Telegram group
1. Create a new group in Telegram (e.g., "Tetsuclaw HQ")
2. Add **all** bots (main + pool) to the group
3. Send `/chatid` in the group — note the chat ID for registration

---

## Step 2: Clone and Configure

```bash
git clone https://github.com/tyrannosaurusjr/tetsuclaw-core.git
cd tetsuclaw-core
cp .env.example .env
```

Edit `.env` with your tokens:
```bash
TELEGRAM_BOT_TOKEN=your_main_bot_token
TELEGRAM_BOT_POOL=pool_token_1,pool_token_2,pool_token_3
ASSISTANT_NAME=Tetsuclaw
TZ=Asia/Tokyo
```

---

## Step 3: Deploy

```bash
claude
```

Then run the interactive setup:
```
/setup
```

This handles:
- Node.js and dependency installation
- Docker container build
- Credential gateway setup
- Group registration
- Service start (systemd on Linux, launchd on macOS)

---

## Step 4: First Message

Send a message in your Telegram group. Tetsuclaw will run an onboarding interview to learn about your situation:

- How long you've been in Japan
- Where you're based
- Your visa type and expiry
- Your business structure
- Your preferences (food, cafes, accommodation, entertainment, travel)

This data is saved to `user/context.json` and `user/preferences.json` in your group folder. It persists across session resets and powers all agent recommendations.

---

## Step 5: Customize

### Agent prompts
Each agent's instructions are at `groups/{your_group}/agents/{name}/CLAUDE.md`. Edit them to change behavior, add domain knowledge, or adjust personality.

### User preferences
Tell Tetsuclaw to update your preferences anytime: "Update my restaurant preferences" or "I moved to Shibuya". It writes changes to the preference files automatically.

### Integrations
Add API keys to `.env` for additional integrations:
- Stripe (payments)
- Google Calendar, Drive, Maps
- Calendly, Airtable
- Social platforms (LinkedIn, X, Instagram)

---

## .env Variable Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Main bot token from @BotFather |
| `ASSISTANT_NAME` | Yes | Bot display name (default: Tetsuclaw) |
| `TZ` | Yes | Timezone (default: Asia/Tokyo) |
| `TELEGRAM_BOT_POOL` | No | Comma-separated pool bot tokens for agent identities |
| `ONECLI_URL` | No | Credential gateway URL (default: http://127.0.0.1:10254) |
| `OPENAI_API_KEY` | No | For voice transcription (Whisper) |
| `OLLAMA_HOST` | No | Local LLM endpoint |
| `MODEL_PROVIDER_ORDER` | No | Fallback order for `model_ask(auto)`, default `codex,gemini,ollama,claude` |
| `CODEX_BIN` / `CODEX_MODEL` | No | Codex CLI path and optional model override for host-mediated model routing |
| `GEMINI_BIN` / `GEMINI_MODEL` | No | Gemini CLI path and optional model override for host-mediated model routing |
| `OLLAMA_MODEL` | No | Ollama model override for host-mediated model routing |
| `CLAUDE_BIN` / `CLAUDE_MODEL` | No | Claude CLI path and optional model override for model-router fallback |
| `SLACK_BOT_TOKEN` | No | Slack channel integration |
| `SLACK_APP_TOKEN` | No | Slack channel integration |

---

## Troubleshooting

### Build fails with OOM on small VPS
The TypeScript build needs ~1.5GB RAM. If your VPS has less:
```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### Bot doesn't respond in group
1. Check group privacy is off for all bots (BotFather → Bot Settings → Group Privacy → Turn off)
2. Verify the group is registered: check the database or send `/chatid` in the group
3. Check service logs: `journalctl -u nanoclaw -f` (Linux) or `tail -f ~/Library/Logs/nanoclaw.out.log` (macOS)

### Stale session errors
If you see "No conversation found with session ID":
```bash
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='your_folder'"
sudo systemctl restart nanoclaw
```
