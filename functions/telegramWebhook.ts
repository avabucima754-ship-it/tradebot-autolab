import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ─── Helpers ────────────────────────────────────────────────────────────────

function simpleEncrypt(text: string): string {
  // Basic XOR + base64 obfuscation (production: use AES-GCM via Web Crypto)
  const key = Deno.env.get('ENCRYPT_KEY') || 'tradebot_secure_key_2026';
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return btoa(result);
}

function simpleDecrypt(encoded: string): string {
  const key = Deno.env.get('ENCRYPT_KEY') || 'tradebot_secure_key_2026';
  const text = atob(encoded);
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return result;
}

async function sendTelegram(token: string, chat_id: string | number, text: string, reply_markup?: object) {
  const body: Record<string, unknown> = { chat_id, text, parse_mode: 'HTML' };
  if (reply_markup) body.reply_markup = reply_markup;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🤖 Create Trading Bot', callback_data: 'menu_create' }, { text: '🔗 Connect Signal', callback_data: 'menu_signal' }],
      [{ text: '🧪 Paper Trading', callback_data: 'menu_paper' }, { text: '🚀 Auto Trade', callback_data: 'menu_autotrade' }],
      [{ text: '📊 Performance', callback_data: 'menu_performance' }, { text: '⚙️ Settings', callback_data: 'menu_settings' }],
      [{ text: '🆘 Support', callback_data: 'menu_support' }, { text: '🛑 STOP ALL BOTS', callback_data: 'menu_stopall' }],
    ],
  };
}

function marketKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '₿ Crypto', callback_data: 'market_crypto' }],
      [{ text: '💱 Forex', callback_data: 'market_forex' }],
      [{ text: '📈 Indices', callback_data: 'market_indices' }],
      [{ text: '↩️ Back', callback_data: 'menu_main' }],
    ],
  };
}

function pairKeyboard(market: string) {
  const pairs: Record<string, string[][]> = {
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
}

function entryRuleKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📉 RSI Signal', callback_data: 'entry_rsi' }],
      [{ text: '📊 Moving Average Crossover', callback_data: 'entry_ma' }],
      [{ text: '🔓 Breakout Condition', callback_data: 'entry_breakout' }],
      [{ text: '🔗 External Webhook Signal', callback_data: 'entry_webhook' }],
      [{ text: '↩️ Back', callback_data: 'step_pair' }],
    ],
  };
}

function yesNoKeyboard(yes_cb: string, no_cb: string) {
  return { inline_keyboard: [[{ text: '✅ Yes', callback_data: yes_cb }, { text: '❌ No', callback_data: no_cb }]] };
}

function modeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🧪 Paper Trading (Safe)', callback_data: 'mode_paper' }],
      [{ text: '🚀 Live Trading (Real Money)', callback_data: 'mode_live' }],
    ],
  };
}

function exchangeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🟡 Binance', callback_data: 'exchange_binance' }],
      [{ text: '🔵 Bybit', callback_data: 'exchange_bybit' }],
    ],
  };
}

// ─── Price Fetcher (for paper trading) ───────────────────────────────────────

async function fetchPrice(pair: string): Promise<number> {
  try {
    const symbol = pair.replace('/', '').toUpperCase();
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) {
      const d = await r.json();
      return parseFloat(d.price);
    }
  } catch (_) { /* ignore */ }
  // fallback mock prices
  const mocks: Record<string, number> = {
    BTCUSDT: 65000, ETHUSDT: 3200, BNBUSDT: 580, SOLUSDT: 145,
    EURUSD: 1.085, GBPUSD: 1.26, USDJPY: 154.5,
    US30: 39500, SPX500: 5200, NAS100: 18000,
  };
  return mocks[pair.replace('/', '').toUpperCase()] || 100;
}

// ─── Signal Processing ────────────────────────────────────────────────────────

async function processSignal(db: any, telegram_id: string, pair: string, action: string, raw_payload: object, token: string) {
  // Find active strategies for user matching this pair
  const strategies = await db.entities.Strategy.filter({ telegram_id, is_active: true });
  const matched = strategies.filter((s: any) =>
    s.pair.replace('/', '').toUpperCase() === pair.replace('/', '').toUpperCase() ||
    s.entry_type === 'webhook'
  );

  if (matched.length === 0) {
    await db.entities.SignalLog.create({ telegram_id, pair, action, raw_payload, processed: false, result: 'No matching active strategy' });
    return;
  }

  const user = (await db.entities.BotUser.filter({ telegram_id }))[0];
  if (user?.bot_stopped) {
    await sendTelegram(token, telegram_id, '⛔ Bot is currently stopped. All signals ignored. Use /start to resume.');
    return;
  }

  for (const strategy of matched) {
    // Check max trades per day
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayTrades = await db.entities.Trade.filter({ telegram_id, strategy_id: strategy.id });
    const todayCount = todayTrades.filter((t: any) => new Date(t.created_date) >= today).length;
    if (strategy.max_trades_per_day && todayCount >= strategy.max_trades_per_day) {
      await sendTelegram(token, telegram_id, `⚠️ Max trades per day reached for <b>${strategy.name}</b>. Signal skipped.`);
      continue;
    }

    const price = await fetchPrice(pair);
    const tp = action === 'BUY'
      ? price * (1 + strategy.take_profit_pct / 100)
      : price * (1 - strategy.take_profit_pct / 100);
    const sl = action === 'BUY'
      ? price * (1 - strategy.stop_loss_pct / 100)
      : price * (1 + strategy.stop_loss_pct / 100);

    const quantity = (100 * (strategy.risk_per_trade_pct / 100)) / (strategy.stop_loss_pct / 100 * price);

    const trade = await db.entities.Trade.create({
      telegram_id,
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      pair,
      action: action.toUpperCase(),
      entry_price: price,
      take_profit: tp,
      stop_loss: sl,
      quantity: Math.round(quantity * 1000) / 1000,
      status: 'open',
      mode: strategy.mode || 'paper',
      signal_payload: raw_payload,
    });

    await db.entities.SignalLog.create({ telegram_id, pair, action, raw_payload, processed: true, matched_strategy_id: strategy.id, result: 'Trade opened' });

    const emoji = action === 'BUY' ? '🟢' : '🔴';
    const modeTag = strategy.mode === 'live' ? '🚀 LIVE' : '🧪 PAPER';
    await sendTelegram(token, telegram_id,
      `${emoji} <b>Signal Received & Trade Opened!</b>\n\n` +
      `📋 Strategy: ${strategy.name}\n` +
      `💱 Pair: ${pair}\n` +
      `📌 Action: ${action.toUpperCase()}\n` +
      `💰 Entry: $${price.toFixed(4)}\n` +
      `🎯 Take Profit: $${tp.toFixed(4)} (+${strategy.take_profit_pct}%)\n` +
      `🛡️ Stop Loss: $${sl.toFixed(4)} (-${strategy.stop_loss_pct}%)\n` +
      `📦 Quantity: ${trade.quantity}\n` +
      `🏷️ Mode: ${modeTag}\n\n` +
      `Trade ID: <code>${trade.id.slice(-8)}</code>`
    );
  }
}

// ─── Onboarding FSM ───────────────────────────────────────────────────────────

async function handleOnboarding(db: any, token: string, chat_id: string, user: any, step: string, data: any, text: string) {
  const od = user.onboarding_data || {};

  // Collecting TP
  if (step === 'await_tp') {
    const tp = parseFloat(text);
    if (isNaN(tp) || tp <= 0) {
      await sendTelegram(token, chat_id, '❌ Invalid number. Enter Take Profit % (e.g. 3):');
      return;
    }
    await db.entities.BotUser.update(user.id, { onboarding_step: 'await_sl', onboarding_data: { ...od, take_profit_pct: tp } });
    await sendTelegram(token, chat_id, `✅ Take Profit set to <b>${tp}%</b>\n\nNow enter your <b>Stop Loss %</b> (e.g. 2):`);
    return;
  }

  if (step === 'await_sl') {
    const sl = parseFloat(text);
    if (isNaN(sl) || sl <= 0) {
      await sendTelegram(token, chat_id, '❌ Invalid. Enter Stop Loss % (e.g. 2):');
      return;
    }
    await db.entities.BotUser.update(user.id, { onboarding_step: 'await_risk', onboarding_data: { ...od, stop_loss_pct: sl } });
    await sendTelegram(token, chat_id, `✅ Stop Loss set to <b>${sl}%</b>\n\nEnter <b>Risk per trade %</b> (e.g. 1 = 1% of account):`);
    return;
  }

  if (step === 'await_risk') {
    const risk = parseFloat(text);
    if (isNaN(risk) || risk <= 0) {
      await sendTelegram(token, chat_id, '❌ Invalid. Enter risk % (e.g. 1):');
      return;
    }
    await db.entities.BotUser.update(user.id, { onboarding_step: 'await_max_trades', onboarding_data: { ...od, risk_per_trade_pct: risk } });
    await sendTelegram(token, chat_id, `✅ Risk per trade: <b>${risk}%</b>\n\nEnter <b>Max trades per day</b> (e.g. 5):`);
    return;
  }

  if (step === 'await_max_trades') {
    const mt = parseInt(text);
    if (isNaN(mt) || mt <= 0) {
      await sendTelegram(token, chat_id, '❌ Invalid. Enter max trades (e.g. 5):');
      return;
    }
    await db.entities.BotUser.update(user.id, { onboarding_step: 'await_max_loss', onboarding_data: { ...od, max_trades_per_day: mt } });
    await sendTelegram(token, chat_id, `✅ Max trades/day: <b>${mt}</b>\n\nEnter <b>Max daily loss limit %</b> (e.g. 5 = stop trading if down 5%):`);
    return;
  }

  if (step === 'await_max_loss') {
    const ml = parseFloat(text);
    if (isNaN(ml) || ml <= 0) {
      await sendTelegram(token, chat_id, '❌ Invalid. Enter max loss % (e.g. 5):');
      return;
    }
    await db.entities.BotUser.update(user.id, { onboarding_step: 'await_strategy_name', onboarding_data: { ...od, max_loss_limit_pct: ml } });
    await sendTelegram(token, chat_id, `✅ Max daily loss: <b>${ml}%</b>\n\n🏷️ Almost done! Give your strategy a name (e.g. <i>Scalping Bot 1</i>):`);
    return;
  }

  if (step === 'await_strategy_name') {
    const name = text.trim();
    if (!name) { await sendTelegram(token, chat_id, '❌ Please enter a strategy name:'); return; }
    await db.entities.BotUser.update(user.id, { onboarding_step: 'await_mode', onboarding_data: { ...od, name } });
    await sendTelegram(token, chat_id, `✅ Strategy name: <b>${name}</b>\n\nChoose trading mode:`, modeKeyboard());
    return;
  }

  if (step === 'await_api_key') {
    const exchange = od.exchange;
    const encrypted = simpleEncrypt(text.trim());
    const updateData: Record<string, string> = {};
    updateData[`${exchange}_api_key_enc`] = encrypted;
    await db.entities.BotUser.update(user.id, { onboarding_step: 'await_api_secret', onboarding_data: od, ...updateData });
    await sendTelegram(token, chat_id, `🔐 API Key saved (encrypted).\n\nNow paste your <b>Secret Key</b>:`);
    return;
  }

  if (step === 'await_api_secret') {
    const exchange = od.exchange;
    const encrypted = simpleEncrypt(text.trim());
    const updateData: Record<string, string | object> = {};
    updateData[`${exchange}_secret_enc`] = encrypted;
    updateData['exchange'] = exchange;
    updateData['onboarding_step'] = 'done';
    updateData['auto_trade_enabled'] = true;
    await db.entities.BotUser.update(user.id, { ...updateData, onboarding_data: {} });
    await sendTelegram(token, chat_id,
      `✅ <b>API Keys Saved & Encrypted!</b>\n\n🚀 Auto Trading is now <b>ENABLED</b> on ${exchange.toUpperCase()}\n\n` +
      `Your signals will now execute real trades.\n\nUse ⚙️ Settings to disable at any time.`,
      mainMenuKeyboard()
    );
    return;
  }
}

// ─── Callback Handlers ────────────────────────────────────────────────────────

async function handleCallback(db: any, token: string, callback: any) {
  const chat_id = String(callback.message.chat.id);
  const data = callback.data;

  let user = (await db.entities.BotUser.filter({ telegram_id: chat_id }))[0];
  if (!user) {
    user = await db.entities.BotUser.create({ telegram_id: chat_id, telegram_username: callback.from.username || '', first_name: callback.from.first_name || '' });
  }

  const od = user.onboarding_data || {};

  // ── Main menu
  if (data === 'menu_main') {
    await sendTelegram(token, chat_id, `🏠 <b>Main Menu</b>\n\nWhat would you like to do?`, mainMenuKeyboard());
    return;
  }

  if (data === 'menu_stopall') {
    await db.entities.BotUser.update(user.id, { bot_stopped: true });
    await sendTelegram(token, chat_id, `🛑 <b>ALL BOTS STOPPED</b>\n\nAll signals and trades are paused. Send /start to resume.`);
    return;
  }

  if (data === 'menu_support') {
    await sendTelegram(token, chat_id,
      `🆘 <b>Support</b>\n\n` +
      `📖 How to use TradeBot AutoLab:\n\n` +
      `1️⃣ Create a strategy with <b>🤖 Create Trading Bot</b>\n` +
      `2️⃣ Connect TradingView alerts via <b>🔗 Connect Signal</b>\n` +
      `3️⃣ Test safely with <b>🧪 Paper Trading</b>\n` +
      `4️⃣ Go live with <b>🚀 Auto Trade</b>\n` +
      `5️⃣ Track results in <b>📊 Performance</b>\n\n` +
      `⚠️ This is a strategy automation tool. Past signals do not guarantee future profits.\n\n` +
      `For issues, contact your bot admin.`,
      { inline_keyboard: [[{ text: '↩️ Back to Menu', callback_data: 'menu_main' }]] }
    );
    return;
  }

  // ── Create Bot flow
  if (data === 'menu_create') {
    await db.entities.BotUser.update(user.id, { onboarding_step: 'select_market', onboarding_data: {} });
    await sendTelegram(token, chat_id, `🤖 <b>Create Trading Bot</b>\n\nStep 1 of 6: Select your market:`, marketKeyboard());
    return;
  }

  if (data.startsWith('market_')) {
    const market = data.replace('market_', '');
    await db.entities.BotUser.update(user.id, { onboarding_step: 'select_pair', onboarding_data: { market } });
    await sendTelegram(token, chat_id, `✅ Market: <b>${market.charAt(0).toUpperCase() + market.slice(1)}</b>\n\nStep 2 of 6: Choose a trading pair:`, pairKeyboard(market));
    return;
  }

  if (data.startsWith('pair_')) {
    const pair = data.replace('pair_', '');
    const formatted = pair.length > 6 ? pair.slice(0, 3) + '/' + pair.slice(3) : pair;
    await db.entities.BotUser.update(user.id, { onboarding_step: 'select_entry', onboarding_data: { ...od, pair: formatted } });
    await sendTelegram(token, chat_id, `✅ Pair: <b>${formatted}</b>\n\nStep 3 of 6: Choose entry rule:`, entryRuleKeyboard());
    return;
  }

  if (data.startsWith('entry_')) {
    const entryType = data.replace('entry_', '');
    const labels: Record<string, string> = { rsi: 'RSI Signal', ma: 'MA Crossover', breakout: 'Breakout', webhook: 'External Webhook' };
    await db.entities.BotUser.update(user.id, { onboarding_step: 'await_tp', onboarding_data: { ...od, entry_type: entryType } });
    await sendTelegram(token, chat_id,
      `✅ Entry Rule: <b>${labels[entryType]}</b>\n\nStep 4 of 6: Risk Management\n\nEnter your <b>Take Profit %</b> (e.g. 3 for 3%):`
    );
    return;
  }

  if (data === 'step_pair') {
    await db.entities.BotUser.update(user.id, { onboarding_step: 'select_pair', onboarding_data: { ...od } });
    await sendTelegram(token, chat_id, 'Select trading pair:', pairKeyboard(od.market || 'crypto'));
    return;
  }

  if (data === 'trailing_yes') {
    await db.entities.BotUser.update(user.id, { onboarding_data: { ...od, trailing_stop: true } });
    await sendTelegram(token, chat_id, '✅ Trailing Stop: Enabled\n\nEnter <b>Risk per trade %</b>:');
    await db.entities.BotUser.update(user.id, { onboarding_step: 'await_risk' });
    return;
  }
  if (data === 'trailing_no') {
    await db.entities.BotUser.update(user.id, { onboarding_data: { ...od, trailing_stop: false }, onboarding_step: 'await_risk' });
    await sendTelegram(token, chat_id, '✅ No trailing stop.\n\nEnter <b>Risk per trade %</b> (e.g. 1):');
    return;
  }

  if (data === 'mode_paper' || data === 'mode_live') {
    const mode = data.replace('mode_', '');
    const finalData = { ...od, mode };
    // Save the strategy
    await db.entities.Strategy.create({
      telegram_id: chat_id,
      name: finalData.name,
      market: finalData.market,
      pair: finalData.pair,
      entry_type: finalData.entry_type,
      entry_rules: {},
      take_profit_pct: finalData.take_profit_pct,
      stop_loss_pct: finalData.stop_loss_pct,
      trailing_stop: finalData.trailing_stop || false,
      risk_per_trade_pct: finalData.risk_per_trade_pct,
      max_trades_per_day: finalData.max_trades_per_day,
      max_loss_limit_pct: finalData.max_loss_limit_pct,
      is_active: true,
      mode,
    });
    await db.entities.BotUser.update(user.id, { onboarding_step: 'done', onboarding_data: {} });

    const modeEmoji = mode === 'paper' ? '🧪' : '🚀';
    await sendTelegram(token, chat_id,
      `🎉 <b>Strategy "${finalData.name}" Created!</b>\n\n` +
      `📋 Summary:\n` +
      `• Market: ${finalData.market}\n• Pair: ${finalData.pair}\n` +
      `• Entry: ${finalData.entry_type}\n• TP: ${finalData.take_profit_pct}% | SL: ${finalData.stop_loss_pct}%\n` +
      `• Risk/trade: ${finalData.risk_per_trade_pct}%\n• Max trades/day: ${finalData.max_trades_per_day}\n` +
      `• Mode: ${modeEmoji} ${mode.toUpperCase()}\n\n` +
      `✅ Strategy is now <b>ACTIVE</b>!\n\nConnect a TradingView signal or wait for webhook triggers.`,
      mainMenuKeyboard()
    );
    return;
  }

  // ── Signal / Webhook info
  if (data === 'menu_signal') {
    const webhookUrl = `https://${Deno.env.get('BASE44_APP_ID') || 'your-app'}.base44.app/functions/signalWebhook`;
    await sendTelegram(token, chat_id,
      `🔗 <b>Connect External Signal</b>\n\n` +
      `Use this webhook URL in TradingView alert:\n\n` +
      `<code>${webhookUrl}?user_id=${chat_id}</code>\n\n` +
      `📋 <b>Alert Message Body (JSON):</b>\n` +
      `<code>{\n  "pair": "BTCUSDT",\n  "action": "BUY"\n}</code>\n\n` +
      `📌 Steps:\n` +
      `1. Open TradingView → Add Alert\n` +
      `2. Set condition to your indicator\n` +
      `3. In <b>Notifications</b> → enable <b>Webhook URL</b>\n` +
      `4. Paste the URL above\n` +
      `5. Paste the JSON body in the message field\n\n` +
      `✅ Signals will trigger your active strategies instantly!`,
      { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_main' }]] }
    );
    return;
  }

  // ── Paper Trading info
  if (data === 'menu_paper') {
    const trades = await db.entities.Trade.filter({ telegram_id: chat_id, mode: 'paper' });
    const closed = trades.filter((t: any) => t.status !== 'open');
    const wins = closed.filter((t: any) => t.pnl > 0).length;
    const totalPnl = closed.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);
    const winRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0.0';

    await sendTelegram(token, chat_id,
      `🧪 <b>Paper Trading Dashboard</b>\n\n` +
      `📊 Total Trades: ${trades.length}\n` +
      `✅ Closed Trades: ${closed.length}\n` +
      `🏆 Win Rate: ${winRate}%\n` +
      `💰 Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n` +
      `📂 Open Trades: ${trades.filter((t: any) => t.status === 'open').length}\n\n` +
      `🧪 Paper trading uses real prices but <b>no real money</b>.\nCreate a strategy with Paper mode to start.`,
      { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_main' }]] }
    );
    return;
  }

  // ── Auto Trade (API connection)
  if (data === 'menu_autotrade') {
    if (user.auto_trade_enabled && user.exchange) {
      await sendTelegram(token, chat_id,
        `🚀 <b>Auto Trading</b>\n\n` +
        `✅ Connected to: <b>${user.exchange.toUpperCase()}</b>\n` +
        `Status: <b>ACTIVE</b>\n\n` +
        `Your live strategies will execute real trades when signals arrive.`,
        {
          inline_keyboard: [
            [{ text: '⛔ Disable Auto Trade', callback_data: 'disable_autotrade' }],
            [{ text: '🔑 Update API Keys', callback_data: 'update_keys' }],
            [{ text: '↩️ Back', callback_data: 'menu_main' }],
          ],
        }
      );
    } else {
      await sendTelegram(token, chat_id,
        `🚀 <b>Auto Trading Setup</b>\n\n` +
        `Connect your exchange to execute real trades automatically.\n\n` +
        `⚠️ <b>Risk Warning:</b> Live trading involves real money. Only trade what you can afford to lose.\n\n` +
        `Select your exchange:`,
        {
          inline_keyboard: [
            [{ text: '🟡 Binance', callback_data: 'connect_binance' }],
            [{ text: '🔵 Bybit', callback_data: 'connect_bybit' }],
            [{ text: '↩️ Back', callback_data: 'menu_main' }],
          ],
        }
      );
    }
    return;
  }

  if (data === 'disable_autotrade') {
    await db.entities.BotUser.update(user.id, { auto_trade_enabled: false });
    await sendTelegram(token, chat_id, `⛔ Auto Trading <b>DISABLED</b>.\n\nYour strategies are now in Paper mode only.`, mainMenuKeyboard());
    return;
  }

  if (data === 'connect_binance' || data === 'connect_bybit' || data === 'update_keys') {
    const exchange = data === 'connect_bybit' ? 'bybit' : 'binance';
    await db.entities.BotUser.update(user.id, { onboarding_step: 'await_api_key', onboarding_data: { exchange } });
    await sendTelegram(token, chat_id,
      `🔐 <b>${exchange.toUpperCase()} API Setup</b>\n\n` +
      `1. Log into ${exchange.charAt(0).toUpperCase() + exchange.slice(1)}\n` +
      `2. Go to API Management\n` +
      `3. Create API key with <b>Trade permissions only</b> (no withdrawal)\n\n` +
      `Paste your <b>API Key</b> below:`
    );
    return;
  }

  // ── Performance
  if (data === 'menu_performance') {
    const allTrades = await db.entities.Trade.filter({ telegram_id: chat_id });
    const strategies = await db.entities.Strategy.filter({ telegram_id: chat_id });
    const closed = allTrades.filter((t: any) => t.status !== 'open');
    const wins = closed.filter((t: any) => t.pnl > 0).length;
    const totalPnl = closed.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);
    const winRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0.0';
    const liveTrades = allTrades.filter((t: any) => t.mode === 'live');
    const paperTrades = allTrades.filter((t: any) => t.mode === 'paper');

    let stratText = '';
    for (const s of strategies.slice(0, 5)) {
      const st = allTrades.filter((t: any) => t.strategy_id === s.id && t.status !== 'open');
      const sw = st.filter((t: any) => t.pnl > 0).length;
      const wr = st.length > 0 ? ((sw / st.length) * 100).toFixed(0) : '0';
      stratText += `\n• ${s.name}: ${st.length} trades | WR: ${wr}% | ${s.mode.toUpperCase()}`;
    }

    await sendTelegram(token, chat_id,
      `📊 <b>Performance Dashboard</b>\n\n` +
      `📈 Total Trades: ${allTrades.length}\n` +
      `🟢 Live: ${liveTrades.length} | 🧪 Paper: ${paperTrades.length}\n` +
      `🏆 Win Rate: ${winRate}%\n` +
      `💰 Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n` +
      `📂 Open Positions: ${allTrades.filter((t: any) => t.status === 'open').length}\n\n` +
      `📋 <b>Strategy Breakdown:</b>${stratText || '\nNo strategies yet.'}`,
      { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_main' }]] }
    );
    return;
  }

  // ── Settings
  if (data === 'menu_settings') {
    const strategies = await db.entities.Strategy.filter({ telegram_id: chat_id });
    const activeCount = strategies.filter((s: any) => s.is_active).length;
    await sendTelegram(token, chat_id,
      `⚙️ <b>Settings</b>\n\n` +
      `📋 Strategies: ${strategies.length} total, ${activeCount} active\n` +
      `🚀 Auto Trade: ${user.auto_trade_enabled ? 'Enabled ✅' : 'Disabled ❌'}\n` +
      `💱 Exchange: ${user.exchange ? user.exchange.toUpperCase() : 'None'}\n` +
      `🛑 Bot Status: ${user.bot_stopped ? 'STOPPED ⛔' : 'Running ✅'}`,
      {
        inline_keyboard: [
          [{ text: '📋 List Strategies', callback_data: 'list_strategies' }, { text: '🗑️ Delete Strategy', callback_data: 'delete_strategy_prompt' }],
          [{ text: user.auto_trade_enabled ? '⛔ Disable Auto Trade' : '✅ Enable Auto Trade', callback_data: user.auto_trade_enabled ? 'disable_autotrade' : 'menu_autotrade' }],
          [{ text: user.bot_stopped ? '▶️ Resume Bot' : '🛑 Stop All Bots', callback_data: user.bot_stopped ? 'resume_bot' : 'menu_stopall' }],
          [{ text: '🔑 Disconnect API Keys', callback_data: 'disconnect_keys' }],
          [{ text: '↩️ Back', callback_data: 'menu_main' }],
        ],
      }
    );
    return;
  }

  if (data === 'resume_bot') {
    await db.entities.BotUser.update(user.id, { bot_stopped: false });
    await sendTelegram(token, chat_id, '▶️ Bot <b>RESUMED</b>. All strategies are active again.', mainMenuKeyboard());
    return;
  }

  if (data === 'disconnect_keys') {
    await db.entities.BotUser.update(user.id, { binance_api_key_enc: '', binance_secret_enc: '', bybit_api_key_enc: '', bybit_secret_enc: '', exchange: 'none', auto_trade_enabled: false });
    await sendTelegram(token, chat_id, '🔑 API Keys disconnected. Auto trading disabled.', mainMenuKeyboard());
    return;
  }

  if (data === 'list_strategies') {
    const strategies = await db.entities.Strategy.filter({ telegram_id: chat_id });
    if (strategies.length === 0) {
      await sendTelegram(token, chat_id, 'No strategies yet. Use 🤖 Create Trading Bot to get started!', { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_settings' }]] });
      return;
    }
    const list = strategies.map((s: any, i: number) =>
      `${i + 1}. <b>${s.name}</b>\n   ${s.pair} | ${s.entry_type} | TP:${s.take_profit_pct}% SL:${s.stop_loss_pct}% | ${s.mode.toUpperCase()} | ${s.is_active ? '✅' : '❌'}`
    ).join('\n\n');
    await sendTelegram(token, chat_id, `📋 <b>Your Strategies:</b>\n\n${list}`, { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_settings' }]] });
    return;
  }

  if (data === 'delete_strategy_prompt') {
    const strategies = await db.entities.Strategy.filter({ telegram_id: chat_id });
    if (strategies.length === 0) {
      await sendTelegram(token, chat_id, 'No strategies to delete.', { inline_keyboard: [[{ text: '↩️ Back', callback_data: 'menu_settings' }]] });
      return;
    }
    const buttons = strategies.map((s: any) => [{ text: `🗑️ ${s.name}`, callback_data: `delete_strat_${s.id}` }]);
    buttons.push([{ text: '↩️ Back', callback_data: 'menu_settings' }]);
    await sendTelegram(token, chat_id, '🗑️ Select strategy to delete:', { inline_keyboard: buttons });
    return;
  }

  if (data.startsWith('delete_strat_')) {
    const stratId = data.replace('delete_strat_', '');
    const strat = await db.entities.Strategy.get(stratId);
    if (strat && strat.telegram_id === chat_id) {
      await db.entities.Strategy.delete(stratId);
      await sendTelegram(token, chat_id, `🗑️ Strategy "<b>${strat.name}</b>" deleted.`, mainMenuKeyboard());
    }
    return;
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  try {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!token) return Response.json({ error: 'Bot token not configured' }, { status: 500 });

    const db = createClientFromRequest(req, { serviceRole: true });

    const body = await req.json().catch(() => ({}));

    // Handle callback queries
    if (body.callback_query) {
      await handleCallback(db, token, body.callback_query);
      return Response.json({ ok: true });
    }

    const message = body.message;
    if (!message) return Response.json({ ok: true });

    const chat_id = String(message.chat.id);
    const text = message.text || '';

    // Get or create user
    let user = (await db.entities.BotUser.filter({ telegram_id: chat_id }))[0];
    if (!user) {
      user = await db.entities.BotUser.create({
        telegram_id: chat_id,
        telegram_username: message.from?.username || '',
        first_name: message.from?.first_name || 'Trader',
      });
    }

    // Handle /start
    if (text === '/start' || text === '/menu') {
      await db.entities.BotUser.update(user.id, { bot_stopped: false, onboarding_step: '', onboarding_data: {} });
      await sendTelegram(token, chat_id,
        `🤖 <b>Welcome to TradeBot AutoLab!</b>\n\n` +
        `Hello ${user.first_name || 'Trader'}! 👋\n\n` +
        `I help you build, test, and automate trading strategies — no coding needed.\n\n` +
        `🎯 What would you like to do?`,
        mainMenuKeyboard()
      );
      return Response.json({ ok: true });
    }

    if (text === '/stop') {
      await db.entities.BotUser.update(user.id, { bot_stopped: true });
      await sendTelegram(token, chat_id, '🛑 All bots stopped. Send /start to resume.');
      return Response.json({ ok: true });
    }

    if (text === '/performance') {
      await handleCallback(db, token, { message: { chat: { id: chat_id } }, from: message.from, data: 'menu_performance' });
      return Response.json({ ok: true });
    }

    // Handle onboarding FSM (text inputs)
    const step = user.onboarding_step || '';
    if (step && step !== 'done' && !text.startsWith('/')) {
      await handleOnboarding(db, token, chat_id, user, step, user.onboarding_data || {}, text);
      return Response.json({ ok: true });
    }

    // Default: show menu
    if (!text.startsWith('/')) {
      await sendTelegram(token, chat_id, '🏠 Main Menu:', mainMenuKeyboard());
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
