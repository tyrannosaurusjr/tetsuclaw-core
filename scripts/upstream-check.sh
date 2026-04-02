#!/bin/bash
# Check for upstream NanoClaw updates and notify via Telegram
# Runs daily via cron. Only notifies if there are bug fixes or features worth porting.

set -euo pipefail

REPO_DIR="$HOME/tetsuclaw"
TELEGRAM_TOKEN=$(grep TELEGRAM_BOT_TOKEN "$REPO_DIR/.env" | cut -d= -f2)
CHAT_ID="tg:-5094076457"
# Extract numeric chat ID for Telegram API
TG_CHAT_ID=$(echo "$CHAT_ID" | sed 's/tg://')

cd "$REPO_DIR"

# Fetch upstream
git fetch upstream 2>/dev/null || {
  echo "Failed to fetch upstream"
  exit 1
}

# Check for new commits
NEW_COMMITS=$(git log --oneline HEAD..upstream/main 2>/dev/null)

if [ -z "$NEW_COMMITS" ]; then
  echo "No new upstream commits"
  exit 0
fi

COMMIT_COUNT=$(echo "$NEW_COMMITS" | wc -l | tr -d ' ')

# Categorize commits
FIXES=""
FEATURES=""
SKIP=""

while IFS= read -r line; do
  hash=$(echo "$line" | awk '{print $1}')
  msg=$(echo "$line" | cut -d' ' -f2-)

  # Categorize by commit message
  if echo "$msg" | grep -qiE '^fix[:(]|^fix:'; then
    FIXES="$FIXES\n• $msg"
  elif echo "$msg" | grep -qiE '^feat[:(]|^feat:'; then
    FEATURES="$FEATURES\n• $msg"
  else
    SKIP="$SKIP\n• $msg"
  fi
done <<< "$NEW_COMMITS"

# Only notify if there are fixes or features
if [ -z "$FIXES" ] && [ -z "$FEATURES" ]; then
  echo "Only docs/formatting/version bumps — skipping notification"
  exit 0
fi

# Build message
MSG="*Upstream NanoClaw Update*\n${COMMIT_COUNT} new commits detected.\n"

if [ -n "$FIXES" ]; then
  MSG="$MSG\n*Bug Fixes:*$FIXES\n"
fi

if [ -n "$FEATURES" ]; then
  MSG="$MSG\n*New Features:*$FEATURES\n"
fi

if [ -n "$SKIP" ]; then
  SKIP_COUNT=$(echo -e "$SKIP" | grep -c '•' || true)
  MSG="$MSG\n_${SKIP_COUNT} other commits (docs/formatting/version bumps) skipped._\n"
fi

MSG="$MSG\nRun \`git log --oneline HEAD..upstream/main\` to review.\nUse manual cherry-pick for safe porting — do NOT merge directly."

# Send via Telegram
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
  -d "chat_id=${TG_CHAT_ID}" \
  -d "parse_mode=Markdown" \
  --data-urlencode "text=$(echo -e "$MSG")" \
  > /dev/null

echo "Notification sent: ${COMMIT_COUNT} upstream commits (fixes/features found)"
