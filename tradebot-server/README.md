# TradeBot AutoLab Server

Standalone Express.js server for the TradeBot AutoLab Telegram bot.

## Deploy to Render.com (Free)

### Step 1: Push to GitHub
1. Create a new GitHub repo
2. Push this folder to it

### Step 2: Create Render Web Service
1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

### Step 3: Add Environment Variables
In Render dashboard → Environment → Add:
- `TELEGRAM_BOT_TOKEN` = your bot token
- `BASE44_API_KEY` = your Base44 API key
- `BASE44_APP_ID` = `69e564a4bc835d35ecafe8e4`
- `SERVER_URL` = your Render URL (e.g. https://tradebot-autolab.onrender.com)
- `ENCRYPT_KEY` = any random secret string (keep it safe!)

### Step 4: Set Telegram Webhook
After deploy, run this in terminal (replace TOKEN and RENDER_URL):
```
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://YOUR-RENDER-URL.onrender.com/webhook", "allowed_updates": ["message", "callback_query"]}'
```

## Endpoints
- `GET /` — Health check
- `POST /webhook` — Telegram webhook receiver
- `POST /signal?user_id=<telegram_id>` — TradingView signal endpoint
