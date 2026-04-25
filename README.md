# 🤖 TradeBot AutoLab Server

Fully self-contained Telegram trading bot server.  
**No external database needed** — uses SQLite built-in.  
**Any Telegram user worldwide can use it independently.**

---

## 🚀 Deploy to Render.com (Free — 5 minutes)

### Step 1: Push to GitHub

1. Create a new repo at https://github.com/new (name it `tradebot-autolab`)
2. In this folder, run:
   ```bash
   git init
   git add .
   git commit -m "TradeBot AutoLab v2"
   git remote add origin https://github.com/YOUR_USERNAME/tradebot-autolab.git
   git push -u origin main
   ```

### Step 2: Create Render Web Service

1. Go to https://render.com → **New +** → **Web Service**
2. Connect your GitHub repo (`tradebot-autolab`)
3. Configure:
   - **Name:** `tradebot-autolab`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
4. Click **Create Web Service**
5. Wait ~2 minutes for deploy. You'll get a URL like:  
   `https://tradebot-autolab.onrender.com`

### Step 3: Add Environment Variables

In Render dashboard → your service → **Environment** tab → Add:

| Key | Value |
|-----|-------|
| `TELEGRAM_BOT_TOKEN` | Your bot token from @BotFather |
| `SERVER_URL` | `https://tradebot-autolab.onrender.com` (your Render URL) |
| `ENCRYPT_KEY` | Any secret string (e.g. `MySecret2026!`) — keep it safe |

### Step 4: Set Telegram Webhook

After deploy, run this command (replace `YOUR_TOKEN` and `YOUR_RENDER_URL`):

```bash
curl -X POST "https://api.telegram.org/botYOUR_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://YOUR_RENDER_URL.onrender.com/webhook", "allowed_updates": ["message", "callback_query"]}'
```

You should see: `{"ok":true,"result":true}`

**Done! Your bot is live for everyone worldwide.** 🎉

---

## 📡 TradingView Signal URL

Each user gets their own signal URL:
```
https://YOUR_RENDER_URL.onrender.com/signal?user_id=TELEGRAM_CHAT_ID
```

**Alert message body (JSON):**
```json
{
  "pair": "BTCUSDT",
  "action": "BUY"
}
```

---

## 🗄️ Database

- Uses **SQLite** (file: `tradebot.db`) — zero setup required
- On Render free tier, the DB persists as long as the service is running
- For production persistence, set `DB_PATH` to a mounted disk path

## 📁 File Structure

```
tradebot-server/
├── server.js      # Main Express server + all bot logic
├── db.js          # SQLite database layer
├── package.json   # Dependencies
└── tradebot.db    # Auto-created on first run (gitignored)
```

## 🔌 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/webhook` | Telegram webhook receiver |
| POST | `/signal?user_id=<id>` | TradingView signal endpoint |
