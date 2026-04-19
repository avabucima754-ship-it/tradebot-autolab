#!/bin/bash
# Usage: send_telegram.sh <chat_id> <text> [inline_keyboard_json]
# Sends a Telegram message to a user via the bot token

source .agents/.env 2>/dev/null || true

CHAT_ID="$1"
TEXT="$2"
KEYBOARD="$3"

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN not set"
  exit 1
fi

if [ -z "$CHAT_ID" ] || [ -z "$TEXT" ]; then
  echo "ERROR: Usage: send_telegram.sh <chat_id> <text>"
  exit 1
fi

if [ -n "$KEYBOARD" ]; then
  PAYLOAD=$(python3 -c "
import json, sys
chat_id = sys.argv[1]
text = sys.argv[2]
keyboard = json.loads(sys.argv[3])
payload = {'chat_id': chat_id, 'text': text, 'parse_mode': 'HTML', 'reply_markup': keyboard}
print(json.dumps(payload))
" "$CHAT_ID" "$TEXT" "$KEYBOARD")
else
  PAYLOAD=$(python3 -c "
import json, sys
chat_id = sys.argv[1]
text = sys.argv[2]
payload = {'chat_id': chat_id, 'text': text, 'parse_mode': 'HTML'}
print(json.dumps(payload))
" "$CHAT_ID" "$TEXT")
fi

curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
