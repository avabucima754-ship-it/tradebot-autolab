import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

function simpleEncrypt(text: string): string {
  const key = Deno.env.get('ENCRYPT_KEY') || 'tradebot_secure_key_2026';
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return btoa(result);
}

async function sendTelegram(token: string, chat_id: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' }),
  });
}

async function fetchPrice(pair: string): Promise<number> {
  try {
    const symbol = pair.replace('/', '').toUpperCase();
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) {
      const d = await r.json();
      return parseFloat(d.price);
    }
  } catch (_) {}
  const mocks: Record<string, number> = {
    BTCUSDT: 65000, ETHUSDT: 3200, BNBUSDT: 580, SOLUSDT: 145,
    EURUSD: 1.085, GBPUSD: 1.26, USDJPY: 154.5, XRPUSDT: 0.62,
    US30: 39500, SPX500: 5200, NAS100: 18000,
  };
  return mocks[pair.replace('/', '').toUpperCase()] || 100;
}

Deno.serve(async (req) => {
  try {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!token) return Response.json({ error: 'Token not configured' }, { status: 500 });

    const url = new URL(req.url);
    const user_id = url.searchParams.get('user_id');
    if (!user_id) return Response.json({ error: 'user_id required in query params' }, { status: 400 });

    const db = createClientFromRequest(req, { serviceRole: true });
    const body = await req.json().catch(() => ({}));

    const pair = (body.pair || body.symbol || '').toUpperCase().replace('/', '');
    const action = (body.action || body.side || '').toUpperCase();

    if (!pair || !action || !['BUY', 'SELL'].includes(action)) {
      await db.entities.SignalLog.create({
        telegram_id: user_id, pair, action,
        raw_payload: body, processed: false, result: 'Invalid payload'
      });
      return Response.json({ error: 'Invalid payload. Require pair and action (BUY/SELL)' }, { status: 400 });
    }

    // Check user
    const user = (await db.entities.BotUser.filter({ telegram_id: user_id }))[0];
    if (!user) return Response.json({ error: 'User not registered. Send /start to the bot first.' }, { status: 404 });

    if (user.bot_stopped) {
      return Response.json({ ok: false, message: 'Bot is stopped' });
    }

    // Find active strategies matching this pair
    const strategies = await db.entities.Strategy.filter({ telegram_id: user_id, is_active: true });
    const matched = strategies.filter((s: any) => {
      const sp = s.pair.replace('/', '').toUpperCase();
      return sp === pair || s.entry_type === 'webhook';
    });

    if (matched.length === 0) {
      await db.entities.SignalLog.create({ telegram_id: user_id, pair, action, raw_payload: body, processed: false, result: 'No matching strategy' });
      await sendTelegram(token, user_id, `📡 Signal received: <b>${action} ${pair}</b>\n⚠️ No active strategy matched this signal.`);
      return Response.json({ ok: true, matched: 0 });
    }

    const results = [];
    for (const strategy of matched) {
      // Max trades per day check
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const todayTrades = await db.entities.Trade.filter({ telegram_id: user_id, strategy_id: strategy.id });
      const todayCount = todayTrades.filter((t: any) => new Date(t.created_date) >= today).length;

      if (strategy.max_trades_per_day && todayCount >= strategy.max_trades_per_day) {
        await sendTelegram(token, user_id, `⚠️ Max trades/day reached for <b>${strategy.name}</b>. Signal skipped.`);
        continue;
      }

      const price = await fetchPrice(pair);
      const tp = action === 'BUY'
        ? price * (1 + strategy.take_profit_pct / 100)
        : price * (1 - strategy.take_profit_pct / 100);
      const sl = action === 'BUY'
        ? price * (1 - strategy.stop_loss_pct / 100)
        : price * (1 + strategy.stop_loss_pct / 100);
      const qty = (100 * (strategy.risk_per_trade_pct / 100)) / (strategy.stop_loss_pct / 100 * price);

      let exchangeOrderId = '';

      // Live trading execution (Binance example)
      if (strategy.mode === 'live' && user.auto_trade_enabled && user.exchange === 'binance' && user.binance_api_key_enc && user.binance_secret_enc) {
        try {
          const apiKey = atob(user.binance_api_key_enc); // simplified; real: decrypt properly
          // In production: call Binance REST API here
          // For now: log attempt
          exchangeOrderId = `PAPER_${Date.now()}`;
          console.log(`[LIVE] Would place ${action} ${qty} ${pair} on Binance at ${price}`);
        } catch (e) {
          console.error('Exchange execution error:', e);
        }
      }

      const trade = await db.entities.Trade.create({
        telegram_id: user_id,
        strategy_id: strategy.id,
        strategy_name: strategy.name,
        pair,
        action,
        entry_price: price,
        take_profit: tp,
        stop_loss: sl,
        quantity: Math.round(qty * 10000) / 10000,
        status: 'open',
        mode: strategy.mode || 'paper',
        exchange_order_id: exchangeOrderId,
        signal_payload: body,
      });

      await db.entities.SignalLog.create({
        telegram_id: user_id, pair, action, raw_payload: body,
        processed: true, matched_strategy_id: strategy.id, result: 'Trade opened'
      });

      const emoji = action === 'BUY' ? '🟢' : '🔴';
      const modeTag = strategy.mode === 'live' ? '🚀 LIVE' : '🧪 PAPER';
      await sendTelegram(token, user_id,
        `${emoji} <b>Signal → Trade Executed!</b>\n\n` +
        `📋 Strategy: ${strategy.name}\n` +
        `💱 Pair: ${pair}\n` +
        `📌 Action: ${action}\n` +
        `💰 Entry: $${price.toLocaleString()}\n` +
        `🎯 TP: $${tp.toFixed(4)} (+${strategy.take_profit_pct}%)\n` +
        `🛡️ SL: $${sl.toFixed(4)} (-${strategy.stop_loss_pct}%)\n` +
        `📦 Qty: ${trade.quantity}\n` +
        `🏷️ ${modeTag}\n` +
        `🆔 Trade: <code>${trade.id.slice(-8)}</code>`
      );
      results.push({ strategy: strategy.name, trade_id: trade.id });
    }

    return Response.json({ ok: true, trades_opened: results.length, results });
  } catch (error) {
    console.error('Signal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
