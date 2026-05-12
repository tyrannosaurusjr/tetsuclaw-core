# Deploying Tetsuclaw

A step-by-step guide to running your own private copy of Tetsuclaw on a server you control. If you've never deployed software before, this guide is for you.

**Time required:** about 45 minutes
**Cost:** $12/month for the server, plus your own API usage (Anthropic)
**Result:** A Telegram bot that's yours alone — your data never touches anyone else's infrastructure

---

## Before you start

You'll need:

- A credit card (for the server and Anthropic API)
- A Telegram account
- A computer that can open a terminal (Mac, Linux, or Windows with WSL)
- About 45 uninterrupted minutes

You do **not** need to be a developer. You do need to be comfortable copy-pasting commands and reading what the terminal says back.

---

## Part 1 — Create your Telegram bots (5 min)

Tetsuclaw uses multiple bots in a single Telegram group so that different "agent" personalities can talk. Set these up first so you have the tokens ready.

### Create the main bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. When asked for a name, use something like **Tetsuclaw**
4. When asked for a username, use something ending in `bot` (e.g. `mytetsuclaw_bot`)
5. **Copy the token BotFather sends you.** It looks like `123456789:ABCdef...`. Paste it somewhere safe — this is your `TELEGRAM_BOT_TOKEN`

### Create 3 pool bots

These give different agents distinct identities in the group.

1. Send `/newbot` again
2. Name it `Pool1` (username like `mytetsuclawpool1_bot`)
3. Save the token
4. Repeat for `Pool2` and `Pool3`

You should now have **4 tokens saved**.

### Turn off group privacy for every bot

Each bot needs to read all messages in the group, not just ones addressed to it.

For each of your 4 bots:
1. Send `/mybots` to BotFather
2. Select the bot
3. Click **Bot Settings** → **Group Privacy** → **Turn off**

### Create your Telegram group

1. In Telegram, create a new group (name it anything — "Tetsuclaw HQ" works)
2. Add **all 4 bots** to the group
3. Leave this group open — you'll come back to it later

---

## Part 2 — Get a server (10 min)

You need a computer in the cloud that's always on. DigitalOcean is the simplest.

1. Sign up at [digitalocean.com](https://www.digitalocean.com/)
2. Click **Create → Droplet**
3. Choose these settings:
   - **Region:** Singapore (closest to Japan, low latency)
   - **Image:** Ubuntu 24.04 LTS x64
   - **Size:** Basic → Regular → **$12/mo (2 GB / 1 CPU / 50 GB SSD)**
   - **Authentication:** Password (easier for non-developers; write down the root password)
   - **Hostname:** `tetsuclaw`
4. Click **Create Droplet**
5. Wait ~60 seconds for the droplet to appear with a **public IPv4 address** — something like `174.138.22.14`. Write this down.

### Connect to your server

Open Terminal (Mac/Linux) or WSL (Windows) and type:

```bash
ssh root@YOUR_IP_ADDRESS
```

Replace `YOUR_IP_ADDRESS` with the one DigitalOcean gave you. Type `yes` if it asks about fingerprints, then paste the root password.

You are now inside your server. Every command from here runs on the droplet, not your laptop.

---

## Part 3 — Get an Anthropic API key (5 min)

The bot uses Claude as its brain. You need your own API key so your usage and billing are yours alone.

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Sign up or log in
3. Click **API Keys → Create Key**. Name it "Tetsuclaw"
4. **Copy the key.** It starts with `sk-ant-...`. Save it somewhere safe — you'll paste it twice during setup
5. Click **Billing** and add $20 of credit to get started

---

## Part 4 — Install prerequisites on the server (10 min)

Back in your SSH session. Copy-paste each block, wait for it to finish, then do the next one.

### System updates and dependencies

```bash
apt update && apt upgrade -y
apt install -y curl git build-essential sqlite3
```

### Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version
```

You should see `v22.x.x`.

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

### Clone Tetsuclaw

```bash
cd /root
git clone https://github.com/tyrannosaurusjr/tetsuclaw-core.git
cd tetsuclaw-core
npm install
```

This takes a few minutes. If `npm install` fails with an out-of-memory error, add swap:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
```

Then re-run `npm install`.

### Configure your environment file

```bash
cp .env.example .env
nano .env
```

`nano` is a simple text editor. Fill in your tokens:

```
TELEGRAM_BOT_TOKEN=<paste your main bot token>
TELEGRAM_BOT_POOL=<pool1_token>,<pool2_token>,<pool3_token>
ASSISTANT_NAME=Tetsuclaw
TZ=Asia/Tokyo
```

Leave the other fields empty for now. Save with `Ctrl+O`, `Enter`, then `Ctrl+X` to exit.

---

## Part 5 — Run the setup wizard (15 min)

This is where Tetsuclaw gets assembled. The wizard installs Docker, installs the secure credential vault (OneCLI), registers your Telegram group, and starts the bot as a service.

### Launch Claude Code

```bash
claude
```

Claude Code will prompt you to authenticate. Choose the **API key** option and paste the Anthropic key you saved in Part 3.

### Run the wizard

Inside Claude Code, type:

```
/setup
```

And follow the prompts. Here's what will happen:

1. **Git remote check** — Choose "continue without fork" if asked
2. **Node.js + dependencies** — Should already be fine from Part 4
3. **Timezone** — Confirms `Asia/Tokyo`
4. **Docker install** — The wizard installs Docker automatically. Say yes when asked
5. **Container build** — Takes ~5 minutes on first run
6. **OneCLI credential vault** — The wizard installs OneCLI, then asks how you want to provide your Anthropic credential:
   - Choose **Anthropic API key**
   - Choose **CLI** (best for remote servers without a browser)
   - When prompted, paste your Anthropic key again
7. **Channel setup** — Select **Telegram** (only)
   - The wizard reads your bot tokens from `.env` automatically
   - When it asks for the main group chat ID: switch to Telegram, send `/chatid` in your group, copy the ID it returns (looks like `tg:-1001234567890`), paste it back into the wizard
8. **Mount allowlist** — Choose "No" (you don't need external directory access)
9. **Start service** — The wizard creates a systemd service and starts Tetsuclaw
10. **Verify** — Final checks. Everything should show green

When it finishes, exit Claude Code by typing `/exit` or pressing `Ctrl+C`.

---

## Part 6 — Say hello (1 min)

Back on the server, confirm the service is running:

```bash
systemctl status nanoclaw
```

Look for `active (running)` in green. Press `q` to exit.

Now open your Telegram group and send:

```
hello
```

Within a few seconds, Tetsuclaw will respond and start an onboarding interview — asking about your visa, business structure, and preferences. Answer honestly. All of this stays on your server.

---

## You're done

Your bot is now running on a server you own. Your messages, documents, contacts, and financial records stay on this one server forever. No one else can see them.

---

## What to do when something breaks

### The bot doesn't respond

Watch the live logs:
```bash
journalctl -u nanoclaw -f
```

Press `Ctrl+C` to stop watching.

Common causes:
- **Group privacy still on** — re-check all 4 bots in BotFather → Bot Settings → Group Privacy → off
- **Wrong chat ID registered** — re-run `/setup` and pick channel setup only
- **OneCLI vault empty** — run `onecli secrets list` to verify an Anthropic secret exists

### "No conversation found with session ID"

The session database got out of sync. Fix it:

```bash
systemctl stop nanoclaw
sqlite3 /root/tetsuclaw-core/store/messages.db "DELETE FROM sessions"
systemctl start nanoclaw
```

### Pulling code updates

When there's a new version of Tetsuclaw:

```bash
cd /root/tetsuclaw-core
git pull
npm install
npm run build
systemctl restart nanoclaw
```

### Completely stuck

Grab the last 50 lines of the log:

```bash
journalctl -u nanoclaw -n 50
```

Post them somewhere and ask for help.

---

## What it costs to run

- **DigitalOcean droplet:** $12/month flat
- **Anthropic API:** pay-per-use, usually $5–30/month for one person's usage
- **Everything else:** free (Telegram, OneCLI, the code)

Total monthly cost for a single user: roughly $20–40 depending on usage.

---

## Privacy note

You are running this on your own server with your own API key stored in your own encrypted vault. No one — not Tetsuou (the author), not any hosting company beyond DigitalOcean itself — can see your messages, documents, or agent interactions. This is the whole point.

If you want extra assurance, you can inspect the code yourself before deploying. It's all public at [github.com/tyrannosaurusjr/tetsuclaw-core](https://github.com/tyrannosaurusjr/tetsuclaw-core).
