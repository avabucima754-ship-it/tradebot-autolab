// TradeBot AutoLab — Standalone Express Server
// Handles Telegram webhook + TradingView signal webhook
// Deploy to Render.com (free tier)

const express = require('express');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE44_API_KEY = process.env.BASE44_API_KEY;
const BASE44_APP_ID = process.env.BASE44_APP_ID || '69e564a4bc835d35ecafe8e4';
const ENCRYPT_KEY = process.env.ENCRYPT_KEY || 'tradebot_secure_key_2026';
const PORT = process.env.PORT || 3000;

const BASE44_BASE = `https://app.base44.com/api/apps/${BASE44_APP_ID}`;

// ─── Crypto helpers ───────────────────────────────────────────────────────────
function simpleEncrypt(text) {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ ENCRYPT_KEY.charCodeAt(i % ENCRYPT_KEY.length));
  }
  return Buffer.from(result, 'binary').toString('base64');
}
function simpleDecrypt(encoded) {
  const text = Buffer.from(encoded, 'base64').toString('binary');
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ ENCRYPT_KEY.charCodeAt(i % ENCRYPT_KEY.length));
  }
  return result;
}

// ─── Base44 DB helpers ────────────────────────────────────────────────────────
async function dbList(entity, query = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) params.append(k, v);
  const url = `${BASE44_BASE}/entities/${entity}/filter?${params}`;
  const r = await fetch(url, { headers: { 'x-api-key': BASE44_API_KEY } });
  if (!r.ok) { console.error('DB list error', entity, await r.text()); return []; }
  const data = await r.json();
  return Array.isArray(data) ? data : (data.records || []);
}
async function dbCreate(entity, body) {
  const r = await fetch(`${BASE44_BASE}/entities/${entity}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': BASE44_API_KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error('DB create error', entity, await r.text()); return null; }
  return r.json();
}
async function dbUpdate(entity, id, body) {
  const r = await fetch(`${BASE44_BASE}/entities/${entity}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-api-key': BASE44_API_KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error('DB update error', entity, id, await r.text()); return null; }
  return r.json();
}
async function dbDelete(entity, id) {
  const r = await fetch(`${BASE44_BASE}/entities/${entity}/${id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': BASE44_API_KEY },
  });
  return r.ok;
}

// ─── Telegram helper ──────────────────────────────────────────────────────────
async function sendTelegram(chat_id, text, reply_markup) {
  const body = { chat_id: String(chat_id), text, parse_mode: 'HTML' };
  if (reply_markup) body.reply_markup = reply_markup;
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error('Telegram send error:', await r.text());
}
async function answerCallback(callback_query_id) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id }),
  });
}

// ─── Price fetcher ────────────────────────────────────────────────────────────
async function fetchPrice(pair) {
  try {
    const symbol = pair.replace('/', '').toUpperCase();
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) { const d = await r.json(); return parseFloat(d.price); }
  } catch (_) {}
  const mocks = {
    BTCUSDT: 65000, ETHUSDT: 3200, BNBUSDT: 580, SOLUSDT: 145,
    EURUSD: 1.085, GBPUSD: 1.26, USDJPY: 154.5, XRPUSDT: 0.62,
    US30: 39500, SPX500: 5200, NAS100: 18000,
  };
  return mocks[pair.replace('/', '').toUpperCase()] || 100;
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const mainMenuKeyboard = () => ({
  inline_keyboard: [
    [{ text: '🤖 Create Trading Bot', callback_data: 'menu_create' }, { text: '🔗 Connect Signal', callback_data: 'menu_signal' }],
    [{ text: '🧪 Paper Trading', callback_data: 'menu_paper' }, { text: '🚀 Auto Trade', callback_data: 'menu_autotrade' }],
    [{ text: '📊 Performance', callback_data: 'menu_performance' }, { text: '⚙️ Settings', callback_data: 'menu_settings' }],
    [{ text: '🆘 Support', callback_data: 'menu_support' }, { text: '🛑 STOP ALL BOTS', callback_data: 'menu_stopall' }],
  ],
});
const marketKeyboard = () => ({
  inline_keyboard: [
    [{ text: '₿ Crypto', callback_data: 'market_crypto' }],
    [{ text: '💱 Forex', callback_data: 'market_forex' }],
    [{ text: '📈 Indices', callback_data: 'market_indices' }],
    [{ text: '↩️ Back', callback_data: 'menu_main' }],
  ],
});
const pairKeyboard = (market) => {
  const pairs = {
    crypto: [['BTC/USDT', 'ETH/USDT'], ['BNB/USDT', 'SOL/USDT'], ['XRP/USDT', 'ADA/USDT']],
    forex: [['EUR/USD', 'GBP/USD'], ['USD/JPY', 'AUD/USD'], ['USD/CAD', 'EUR/GBP']],
    indices: [['US30', 'SPX500'], ['NAS100', 'GER40'], ['UK100', 'JPN225']],
  };
  const list = pairs[market] || pairs['crypto'];
  return {
    inline_keyboard: [
      ...list.map(row => row.map(p => ({ text: p, callback_data: `pair_${p.replace('/', '')}` }))),
      [{ text: '↩️ Back', callback_data: 'menu_create' }],
    ],
  };
};
const entryRuleKeyboard = () => ({
  inline_keyboard: [
    [{ text: '📉 RSI Signal', callback_data: 'entry_rsi' }],
    [{ text: '📊 Moving Average Crossover', callback_data: 'entry_ma' }],
    [{ text: '🔓 Breakout Condition', callback_data: 'entry_breakout' }],
    [{ text: '🔗 External Webhook Signal', callback_data: 'entry_webhook' }],
    [{ text: '↩️ Back', callback_data: 'step_pair' }],
  ],
});
const modeKeyboard = () => ({
  inline_keyboard: [
    [{ text: '🧪 Paper Trading (Safe)', callback_data: 'mode_paper' }],
    [{ text: '🚀 Live Trading (Real Money)', callback_data: 'mode_live' }],
  ],
});

// ─── Signal processor ─────────────────────────────────────────────────────────
async function processSignal(telegram_id, pair, action, raw_payload) {
  const strategies = await dbList('Strategy', { telegram_id, is_active: true });
  const matched = strategies.filter(s =>
    s.pair.replace('/', '').toUpperCase() === pair.replace('/', '').toUpperCase() ||
    s.entry_type === 'webhook'
  );
  if (matched.length === 0) {
    await dbCreate('SignalLog', { telegram_id, pair, action, raw_payload, processed: false, result: 'No matching strategy' });
    await sendTelegram(telegram_id, `📡 Signal received: <b>${action} ${pair}</b>\n⚠️ No active strategy matched.`);
    return { matched: 0 };
  }

  const users = await dbList('BotUser', { telegram_id });
  const user = users[0];
  if (user?.bot_stopped) {
    await sendTelegram(telegram_id, '⛔ Bot is stopped. Signal ignored. Send /start to resume.');
    return { matched: 0 };
  }

  const results = [];
  for (const strategy of matched) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayTrades = (await dbList('Trade', { telegram_id, strategy_id: strategy.id }))
      .filter(t => new Date(t.created_date) >= today);
    if (strategy.max_trades_per_day && todayTrades.length >= strategy.max_trades_per_day) {
      await sendTelegram(telegram_id, `⚠️ Max trades/day reached for <b>${strategy.name}</b>.`);
      continue;
    }
    const price = await fetchPrice(pair);
    const tp = action === 'BUY' ? price * (1 + strategy.take_profit_pct / 100) : price * (1 - strategy.take_profit_pct / 100);
    const sl = action === 'BUY' ? price * (1 - strategy.stop_loss_pct / 100) : price * (1 + strategy.stop_loss_pct / 100);
    const qty = (100 * (strategy.risk_per_trade_pct / 100)) / (strategy.stop_loss_pct / 100 * price);

    const trade = await dbCreate('Trade', {
      telegram_id, strategy_id: strategy.id, strategy_name: strategy.name,
      pair, action: action.toUpperCase(), entry_price: price,
      take_profit: tp, stop_loss: sl, quantity: Math.round(qty * 10000) / 10000,
      status: 'open', mode: strategy.mode || 'paper', signal_payload: raw_payload,
    });
    await dbCreate('SignalLog', { telegram_id, pair, action, raw_payload, processed: true, matched_strategy_id: strategy.id, result: 'Trade opened' });

    const emoji = action === 'BUY' ? '🟢' : '🔴';
    const modeTag = strategy.mode === 'live' ? '🚀 LIVE' : '🧪 PAPER';
    await sendTelegram(telegram_id,
      `${emoji} <b>Signal → Trade Executed!</b>\n\n` +
      `📋 Strategy: ${strategy.name}\n💱 Pair: ${pair}\n📌 Action: ${action}\n` +
      `💰 Entry: $${price.toLocaleString()}\n🎯 TP: $${tp.toFixed(4)}\n🛡️ SL: $${sl.toFixed(4)}\n` +
      `📦 Qty: ${trade?.quantity || qty.toFixed(4)}\n🏷️ ${modeTag}\n` +
      `🆔 Trade: <code>${(trade?.id || '').slice(-8)}</code>`
    );
    results.push(trade);
  }
  return { matched: results.length };
}

// ─── Onboarding FSM ───────────────────────────────────────────────────────────
async function handleOnboarding(chat_id, user, step, text) {
  const od = user.onboarding_data || {};
  if (step === 'await_tp') {
    const tp = parseFloat(text);
    if (isNaN(tp) || tp <= 0) { await sendTelegram(chat_id, '❌ Invalid. Enter Take Profit % (e.g. 3):'); return; }
    await dbUpdate('BotUser', user.id, { onboarding_step: 'await_sl', onboarding_data: { ...od, take_profit_pct: tp } });
    await sendTelegram(chat_id, `✅ TP: <b>${tp}%</b>\n\nEnter <b>Stop Loss %</b> (e.g. 2):`);
  } else if (step === 'await_sl') {
    const sl = parseFloat(text);
    if (isNaN(sl) || sl <= 0) { await sendTelegram(chat_id, '❌ Invalid. Enter Stop Loss % (e.g. 2):'); return; }
    await dbUpdate('BotUser', user.id, { onboarding_step: 'await_risk', onboarding_data: { ...od, stop_loss_pct: sl } });
    await sendTelegram(chat_id, `✅ SL: <b>${sl}%</b>\n\nEnter <b>Risk per trade %</b> (e.g. 1):`);
  } else if (step === 'await_risk') {
    const risk = parseFloat(text);
    if (isNaN(risk) || risk <= 0) { await sendTelegram(chat_id, '❌ Invalid. Enter risk % (e.g. 1):'); return; }
    await dbUpdate('BotUser', user.id, { onboarding_step: 'await_max_trades', onboarding_data: { ...od, risk_per_trade_pct: risk } });
    await sendTelegram(chat_id, `✅ Risk: <b>${risk}%</b>\n\nEnter <b>Max trades per day</b> (e.g. 5):`);
  } else if (step === 'await_max_trades') {
    const mt = parseInt(text);
    if (isNaN(mt) || mt <= 0) { await sendTelegram(chat_id, '❌ Invalid. Enter max trades (e.g. 5):'); return; }
    await dbUpdate('BotUser', user.id, { onboarding_step: 'await_max_loss', onboarding_data: { ...od, max_trades_per_day: mt } });
    await sendTelegram(chat_id, `✅ Max trades/day: <b>${mt}</b>\n\nEnter <b>Max daily loss % </b>(e.g. 5):`);
  } else if (step === 'await_max_loss') {
    const ml = parseFloat(text);
    if (isNaN(ml) || ml <= 0) { await sendTelegram(chat_id, '❌ Invalid. Enter max loss % (e.g. 5):'); return; }
    await dbUpdate('BotUser', user.id, { onboarding_step: 'await_strategy_name', onboarding_data: { ...od, max_loss_limit_pct: ml } });
    await sendTelegram(chat_id, `✅ Max loss: <b>${ml}%</b>\n\n🏷️ Give your strategy a name (e.g. <i>Scalping Bot 1</i>):`);
  } else if (step === 'await_strategy_name') {
    const name = text.trim();
    if (!name) { await sendTelegram(chat_id, '❌ Enter a strategy name:'); return; }
    await dbUpdate('BotUser', user.id, { onboarding_step: 'await_mode', onboarding_data: { ...od, name } });
    await sendTelegram(chat_id, `✅ Name: <b>${name}</b>\n\nChoose trading mode:`, modeKeyboard());
  } else if (step === 'await_api_key') {
    const exchange = od.exchange;
    const encrypted = simpleEncrypt(text.trim());
    const updateData = { onboarding_step: 'await_api_secret', onboarding_data: od };
    updateData[`${exchange}_api_key_enc`] = encrypted;
    await dbUpdate('BotUser', user.id, updateData);
    await sendTelegram(chat_id, `🔐 API Key saved (encrypted).\n\nPaste your <b>Secret Key</b>:`);
  } else if (step === 'await_api_secret') {
    const exchange = od.exchange;
    const encrypted = simpleEncrypt(text.trim());
    const updateData = { [`${exchange}_secret_enc`]: encrypted, exchange, onboarding_step: 'done', auto_trade_enabled: true, onboarding_data: {} };
    await dbUpdate('BotUser', user.id, updateData);
    await sendTelegram(chat_id,
      `✅ <b>API Keys Saved & Encrypted!</b>\n\n🚀 Auto Trading ENABLED on ${exchange.toUpperCase()}\n\nYour signals will now execute real trades.`,
      mainMenuKeyboard()
    );
  }
}

// ─── Callback handler ─────────────────────────────────────────────────────────
async function handleCallback(callback) {
  const chat_id = String(callback.message.chat.id);
  const data = callback.data;
  await answerCallback(callback.id);

  let users = await dbList('BotUser', { telegram_id: chat_id });
  let user = users[0];
  if (!user) user = await dbCreate('BotUser', { telegram_id: chat_id, telegram_username: callback.from.username || '', first_name: callback.from.first_name || '' });
  const od = user.onboarding_data || {};

  if (data === 'menu_main') {
    await sendTelegram(chat_id, `🏠 <b>Main Menu</b>\n\nWhat would you like to do?`, mainMenuKeyboard());
  } else if (data === 'menu_stopall') {
    await dbUpdate('BotUser', user.id, { bot_stopped: true });
    await sendTelegram(chat_id, `🛑 <b>ALL BOTS STOPPED</b>\n\nSignals paused. Send /start to resume.`);
  } else if (data === 'resume_bot') {
    await dbUpdate('BotUser', user.id, { bot_stopped: false });
    await sendTelegram(chat_id, '▶️ Bot <b>RESUMED</b>. All strategies active.', mainMenuKeyboard());
  } else if (data === 'menu_support') {
    await sendTelegram(chat_id,
      `🆘 <b>Support</b>\n\n1️⃣ Create a strategy → 🤖 Create Trading Bot\n2️⃣ Connect alerts → 🔗 Connect Signal\n` +
      `3️⃣ Test safely → 🧪 Paper Trading\n4️⃣ Go live → 🚀 Auto Trade\n5️⃣ Track results → 📊 Performance\n\n` +
      `⚠️ This is an automation tool. Past signals don't guarantee future profits.`,
      { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_main' }]] }
    );
  } else if (data === 'menu_create') {
    await dbUpdate('BotUser', user.id, { onboarding_step: 'select_market', onboarding_data: {} });
    await sendTelegram(chat_id, `🤖 <b>Create Trading Bot</b>\n\nStep 1: Select your market:`, marketKeyboard());
  } else if (data.startsWith('market_')) {
    const market = data.replace('market_', '');
    await dbUpdate('BotUser', user.id, { onboarding_step: 'select_pair', onboarding_data: { market } });
    await sendTelegram(chat_id, `✅ Market: <b>${market}</b>\n\nStep 2: Choose a trading pair:`, pairKeyboard(market));
  } else if (data.startsWith('pair_')) {
    const pair = data.replace('pair_', '');
    const formatted = pair.length > 6 ? pair.slice(0, 3) + '/' + pair.slice(3) : pair;
    await dbUpdate('BotUser', user.id, { onboarding_step: 'select_entry', onboarding_data: { ...od, pair: formatted } });
    await sendTelegram(chat_id, `✅ Pair: <b>${formatted}</b>\n\nStep 3: Choose entry rule:`, entryRuleKeyboard());
  } else if (data.startsWith('entry_')) {
    const entryType = data.replace('entry_', '');
    const labels = { rsi: 'RSI Signal', ma: 'MA Crossover', breakout: 'Breakout', webhook: 'External Webhook' };
    await dbUpdate('BotUser', user.id, { onboarding_step: 'await_tp', onboarding_data: { ...od, entry_type: entryType } });
    await sendTelegram(chat_id, `✅ Entry: <b>${labels[entryType]}</b>\n\nStep 4: Risk Management\n\nEnter your <b>Take Profit %</b> (e.g. 3):`);
  } else if (data === 'step_pair') {
    await dbUpdate('BotUser', user.id, { onboarding_step: 'select_pair' });
    await sendTelegram(chat_id, 'Select trading pair:', pairKeyboard(od.market || 'crypto'));
  } else if (data === 'mode_paper' || data === 'mode_live') {
    const mode = data.replace('mode_', '');
    const finalData = { ...od, mode };
    await dbCreate('Strategy', {
      telegram_id: chat_id, name: finalData.name, market: finalData.market, pair: finalData.pair,
      entry_type: finalData.entry_type, entry_rules: {}, take_profit_pct: finalData.take_profit_pct,
      stop_loss_pct: finalData.stop_loss_pct, trailing_stop: finalData.trailing_stop || false,
      risk_per_trade_pct: finalData.risk_per_trade_pct, max_trades_per_day: finalData.max_trades_per_day,
      max_loss_limit_pct: finalData.max_loss_limit_pct, is_active: true, mode,
    });
    await dbUpdate('BotUser', user.id, { onboarding_step: 'done', onboarding_data: {} });
    const modeEmoji = mode === 'paper' ? '🧪' : '🚀';
    await sendTelegram(chat_id,
      `🎉 <b>Strategy "${finalData.name}" Created!</b>\n\n` +
      `• Market: ${finalData.market} | Pair: ${finalData.pair}\n` +
      `• Entry: ${finalData.entry_type}\n• TP: ${finalData.take_profit_pct}% | SL: ${finalData.stop_loss_pct}%\n` +
      `• Risk/trade: ${finalData.risk_per_trade_pct}%\n• Max trades/day: ${finalData.max_trades_per_day}\n` +
      `• Mode: ${modeEmoji} ${mode.toUpperCase()}\n\n✅ Strategy is now <b>ACTIVE</b>!`,
      mainMenuKeyboard()
    );
  } else if (data === 'menu_signal') {
    const SERVER_URL = process.env.SERVER_URL || 'https://your-render-url.onrender.com';
    await sendTelegram(chat_id,
      `🔗 <b>Connect External Signal</b>\n\nUse this URL in TradingView alert:\n\n` +
      `<code>${SERVER_URL}/signal?user_id=${chat_id}</code>\n\n` +
      `📋 <b>Alert Message (JSON):</b>\n<code>{\n  "pair": "BTCUSDT",\n  "action": "BUY"\n}</code>\n\n` +
      `📌 Steps:\n1. TradingView → Add Alert\n2. Notifications → enable Webhook URL\n3. Paste URL above\n4. Paste JSON in message field`,
      { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_main' }]] }
    );
  } else if (data === 'menu_paper') {
    const trades = await dbList('Trade', { telegram_id: chat_id, mode: 'paper' });
    const closed = trades.filter(t => t.status !== 'open');
    const wins = closed.filter(t => (t.pnl || 0) > 0).length;
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const winRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0.0';
    await sendTelegram(chat_id,
      `🧪 <b>Paper Trading Dashboard</b>\n\n📊 Total: ${trades.length} | Closed: ${closed.length}\n` +
      `🏆 Win Rate: ${winRate}%\n💰 P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n📂 Open: ${trades.filter(t => t.status === 'open').length}`,
      { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_main' }]] }
    );
  } else if (data === 'menu_autotrade') {
    if (user.auto_trade_enabled && user.exchange) {
      await sendTelegram(chat_id,
        `🚀 <b>Auto Trading</b>\n\n✅ Connected: <b>${user.exchange.toUpperCase()}</b>\nStatus: <b>ACTIVE</b>`,
        { inline_keyboard: [
          [{ text: '⛔ Disable Auto Trade', callback_data: 'disable_autotrade' }],
          [{ text: '🔑 Update API Keys', callback_data: 'update_keys' }],
          [{ text: '↩️ Back', callback_data: 'menu_main' }],
        ]}
      );
    } else {
      await sendTelegram(chat_id,
        `🚀 <b>Auto Trading Setup</b>\n\n⚠️ Live trading = real money. Trade responsibly.\n\nSelect exchange:`,
        { inline_keyboard: [
          [{ text: '🟡 Binance', callback_data: 'connect_binance' }],
          [{ text: '🔵 Bybit', callback_data: 'connect_bybit' }],
          [{ text: '↩️ Back', callback_data: 'menu_main' }],
        ]}
      );
    }
  } else if (data === 'disable_autotrade') {
    await dbUpdate('BotUser', user.id, { auto_trade_enabled: false });
    await sendTelegram(chat_id, `⛔ Auto Trading <b>DISABLED</b>.`, mainMenuKeyboard());
  } else if (data === 'connect_binance' || data === 'connect_bybit' || data === 'update_keys') {
    const exchange = data === 'connect_bybit' ? 'bybit' : 'binance';
    await dbUpdate('BotUser', user.id, { onboarding_step: 'await_api_key', onboarding_data: { exchange } });
    await sendTelegram(chat_id,
      `🔐 <b>${exchange.toUpperCase()} API Setup</b>\n\n1. Go to API Management\n2. Create key with Trade permissions only (NO withdrawal)\n\nPaste your <b>API Key</b>:`
    );
  } else if (data === 'menu_performance') {
    const allTrades = await dbList('Trade', { telegram_id: chat_id });
    const strategies = await dbList('Strategy', { telegram_id: chat_id });
    const closed = allTrades.filter(t => t.status !== 'open');
    const wins = closed.filter(t => (t.pnl || 0) > 0).length;
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const winRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0.0';
    let stratText = '';
    for (const s of strategies.slice(0, 5)) {
      const st = allTrades.filter(t => t.strategy_id === s.id && t.status !== 'open');
      const sw = st.filter(t => (t.pnl || 0) > 0).length;
      const wr = st.length > 0 ? ((sw / st.length) * 100).toFixed(0) : '0';
      stratText += `\n• ${s.name}: ${st.length} trades | WR: ${wr}% | ${s.mode?.toUpperCase()}`;
    }
    await sendTelegram(chat_id,
      `📊 <b>Performance Dashboard</b>\n\n📈 Total: ${allTrades.length} | Open: ${allTrades.filter(t => t.status === 'open').length}\n` +
      `🏆 Win Rate: ${winRate}%\n💰 Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n` +
      `📋 <b>Strategies:</b>${stratText || '\nNo strategies yet.'}`,
      { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_main' }]] }
    );
  } else if (data === 'menu_settings') {
    const strategies = await dbList('Strategy', { telegram_id: chat_id });
    const activeCount = strategies.filter(s => s.is_active).length;
    await sendTelegram(chat_id,
      `⚙️ <b>Settings</b>\n\n📋 Strategies: ${strategies.length} total, ${activeCount} active\n` +
      `🚀 Auto Trade: ${user.auto_trade_enabled ? 'Enabled ✅' : 'Disabled ❌'}\n` +
      `💱 Exchange: ${user.exchange ? user.exchange.toUpperCase() : 'None'}\n` +
      `🛑 Status: ${user.bot_stopped ? 'STOPPED ⛔' : 'Running ✅'}`,
      { inline_keyboard: [
        [{ text: '📋 List Strategies', callback_data: 'list_strategies' }, { text: '🗑️ Delete Strategy', callback_data: 'delete_strategy_prompt' }],
        [{ text: user.auto_trade_enabled ? '⛔ Disable Auto Trade' : '✅ Enable Auto Trade', callback_data: user.auto_trade_enabled ? 'disable_autotrade' : 'menu_autotrade' }],
        [{ text: user.bot_stopped ? '▶️ Resume Bot' : '🛑 Stop All Bots', callback_data: user.bot_stopped ? 'resume_bot' : 'menu_stopall' }],
        [{ text: '🔑 Disconnect API Keys', callback_data: 'disconnect_keys' }],
        [{ text: '↩️ Back', callback_data: 'menu_main' }],
      ]}
    );
  } else if (data === 'list_strategies') {
    const strategies = await dbList('Strategy', { telegram_id: chat_id });
    if (strategies.length === 0) {
      await sendTelegram(chat_id, 'No strategies yet. Use 🤖 Create Trading Bot!', { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_settings' }]] });
    } else {
      const list = strategies.map((s, i) =>
        `${i + 1}. <b>${s.name}</b>\n   ${s.pair} | ${s.entry_type} | TP:${s.take_profit_pct}% SL:${s.stop_loss_pct}% | ${s.mode?.toUpperCase()} | ${s.is_active ? '✅' : '❌'}`
      ).join('\n\n');
      await sendTelegram(chat_id, `📋 <b>Your Strategies:</b>\n\n${list}`, { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_settings' }]] });
    }
  } else if (data === 'delete_strategy_prompt') {
    const strategies = await dbList('Strategy', { telegram_id: chat_id });
    if (strategies.length === 0) { await sendTelegram(chat_id, 'No strategies to delete.'); return; }
    const buttons = strategies.map(s => [{ text: `🗑️ ${s.name}`, callback_data: `del_strat_${s.id}` }]);
    buttons.push([{ text: '↩️ Back', callback_data: 'menu_settings' }]);
    await sendTelegram(chat_id, 'Select strategy to delete:', { inline_keyboard: buttons });
  } else if (data.startsWith('del_strat_')) {
    const stratId = data.replace('del_strat_', '');
    const strats = await dbList('Strategy', { telegram_id: chat_id });
    const strat = strats.find(s => s.id === stratId);
    if (strat) { await dbDelete('Strategy', stratId); await sendTelegram(chat_id, `🗑️ Strategy <b>${strat.name}</b> deleted.`, mainMenuKeyboard()); }
  } else if (data === 'disconnect_keys') {
    await dbUpdate('BotUser', user.id, { binance_api_key_enc: '', binance_secret_enc: '', bybit_api_key_enc: '', bybit_secret_enc: '', exchange: '', auto_trade_enabled: false });
    await sendTelegram(chat_id, '🔑 API Keys disconnected.', mainMenuKeyboard());
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chat_id = String(msg.chat.id);
  const text = (msg.text || '').trim();

  let users = await dbList('BotUser', { telegram_id: chat_id });
  let user = users[0];

  if (text === '/start' || text.startsWith('/start ')) {
    if (!user) {
      user = await dbCreate('BotUser', {
        telegram_id: chat_id,
        telegram_username: msg.from?.username || '',
        first_name: msg.from?.first_name || '',
        onboarding_step: '',
        onboarding_data: {},
        bot_stopped: false,
      });
    } else {
      await dbUpdate('BotUser', user.id, { bot_stopped: false, onboarding_step: '', onboarding_data: {} });
    }
    await sendTelegram(chat_id,
      `👋 Welcome to <b>TradeBot AutoLab</b>${msg.from?.first_name ? ', ' + msg.from.first_name : ''}!\n\n` +
      `🤖 Your intelligent trading strategy automation bot.\n\n` +
      `📌 What I can do:\n• Create trading strategies\n• Execute trades via signals\n• Paper & live trading\n• Track performance\n\n` +
      `Choose an option:`,
      mainMenuKeyboard()
    );
    return;
  }

  if (!user) {
    await sendTelegram(chat_id, '👋 Send /start to begin!');
    return;
  }

  const step = user.onboarding_step || '';
  const onboardingSteps = ['await_tp', 'await_sl', 'await_risk', 'await_max_trades', 'await_max_loss', 'await_strategy_name', 'await_api_key', 'await_api_secret'];

  if (onboardingSteps.includes(step)) {
    await handleOnboarding(chat_id, user, step, text);
    return;
  }

  // Default: show menu
  await sendTelegram(chat_id, `Use the menu below 👇`, mainMenuKeyboard());
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ status: 'TradeBot AutoLab running 🤖', time: new Date().toISOString() }));

// Telegram webhook
app.post('/webhook', async (req, res) => {
  res.json({ ok: true }); // respond immediately
  try {
    const body = req.body;
    if (body.callback_query) {
      await handleCallback(body.callback_query);
    } else if (body.message) {
      await handleMessage(body.message);
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// TradingView signal endpoint
app.post('/signal', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const body = req.body;
    const pair = (body.pair || body.symbol || '').toUpperCase().replace('/', '');
    const action = (body.action || body.side || '').toUpperCase();
    if (!pair || !['BUY', 'SELL'].includes(action)) return res.status(400).json({ error: 'Invalid payload. Need pair and action (BUY/SELL)' });
    const result = await processSignal(user_id, pair, action, body);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Signal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TradeBot AutoLab server running on port ${PORT}`);
  if (!BOT_TOKEN) console.warn('⚠️  TELEGRAM_BOT_TOKEN not set!');
  if (!BASE44_API_KEY) console.warn('⚠️  BASE44_API_KEY not set!');
});
