// ╔══════════════════════════════════════════════════════════════════╗
// ║          TradeBot AutoLab — Professional Trading Engine          ║
// ║                        Version 3.0                               ║
// ╚══════════════════════════════════════════════════════════════════╝

const express = require('express');
const db = require('./db');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ENCRYPT_KEY = process.env.ENCRYPT_KEY || 'tradebot_autolab_secure_2026';
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || 'https://tradebot-server-production.up.railway.app';

function simpleEncrypt(text) {
  let result = '';
  for (let i = 0; i < text.length; i++)
    result += String.fromCharCode(text.charCodeAt(i) ^ ENCRYPT_KEY.charCodeAt(i % ENCRYPT_KEY.length));
  return Buffer.from(result, 'binary').toString('base64');
}
function simpleDecrypt(encoded) {
  const text = Buffer.from(encoded, 'base64').toString('binary');
  let result = '';
  for (let i = 0; i < text.length; i++)
    result += String.fromCharCode(text.charCodeAt(i) ^ ENCRYPT_KEY.charCodeAt(i % ENCRYPT_KEY.length));
  return result;
}

async function sendTelegram(chat_id, text, reply_markup) {
  const body = { chat_id: String(chat_id), text, parse_mode: 'HTML' };
  if (reply_markup) body.reply_markup = reply_markup;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) console.error('TG error:', await r.text());
  } catch (e) { console.error('TG net error:', e.message); }
}

async function answerCallback(id, text = '') {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text }),
  }).catch(() => {});
}

const priceCache = {};
async function fetchPrice(pair) {
  const symbol = pair.replace('/', '').toUpperCase();
  const now = Date.now();
  if (priceCache[symbol] && now - priceCache[symbol].time < 10000) return priceCache[symbol].price;
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) { const d = await r.json(); const price = parseFloat(d.price); priceCache[symbol] = { price, time: now }; return price; }
  } catch (_) {}
  const mocks = { BTCUSDT:65000,ETHUSDT:3200,BNBUSDT:580,SOLUSDT:145,EURUSD:1.085,GBPUSD:1.26,USDJPY:154.5,XRPUSDT:0.62,ADAUSDT:0.46,DOTUSDT:7.2,LINKUSDT:14.5,US30:39500,SPX500:5200,NAS100:18000,GER40:17800,XAUUSDT:2330,XAGUSDT:27.5 };
  return mocks[symbol] || 100;
}

function fmt(n) { return Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtPnl(n) { return `${n>=0?'🟢 +$':'🔴 -$'}${fmt(Math.abs(n))}`; }
function fmtPct(n) { return `${n>=0?'+':''}${n.toFixed(2)}%`; }
function sparkline(trades) {
  if (!trades.length) return '━━━━━━━━━━';
  const pnls = trades.slice(-10).map(t=>t.pnl||0);
  const min = Math.min(...pnls), max = Math.max(...pnls), range = max-min||1;
  const chars = ['▁','▂','▃','▄','▅','▆','▇','█'];
  return pnls.map(p=>chars[Math.floor(((p-min)/range)*7)]).join('');
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const mainMenuKeyboard = () => ({
  inline_keyboard: [
    [{text:'🤖 Create Strategy',callback_data:'menu_create'},{text:'📋 My Strategies',callback_data:'list_strategies'}],
    [{text:'🧪 Paper Trading',callback_data:'menu_paper'},{text:'🚀 Live Trading',callback_data:'menu_autotrade'}],
    [{text:'📊 Performance',callback_data:'menu_performance'},{text:'📈 Live Prices',callback_data:'menu_prices'}],
    [{text:'🔔 Price Alerts',callback_data:'menu_alerts'},{text:'🔗 Signal Webhook',callback_data:'menu_signal'}],
    [{text:'📓 Trade Journal',callback_data:'menu_journal'},{text:'⚙️ Settings',callback_data:'menu_settings'}],
    [{text:'🆘 Help & Guide',callback_data:'menu_support'},{text:'🛑 STOP ALL BOTS',callback_data:'menu_stopall'}],
  ],
});

const marketKeyboard = () => ({
  inline_keyboard: [
    [{text:'₿ Crypto',callback_data:'market_crypto'},{text:'💱 Forex',callback_data:'market_forex'}],
    [{text:'📈 Indices',callback_data:'market_indices'},{text:'🥇 Commodities',callback_data:'market_commodities'}],
    [{text:'↩️ Back',callback_data:'menu_main'}],
  ],
});

const pairKeyboard = (market) => {
  const pairs = {
    crypto:[['BTC/USDT','ETH/USDT'],['BNB/USDT','SOL/USDT'],['XRP/USDT','ADA/USDT'],['DOGE/USDT','LINK/USDT']],
    forex:[['EUR/USD','GBP/USD'],['USD/JPY','AUD/USD'],['USD/CAD','EUR/GBP'],['NZD/USD','EUR/JPY']],
    indices:[['US30','SPX500'],['NAS100','GER40'],['UK100','JPN225']],
    commodities:[['XAU/USD','XAG/USD'],['WTI/USD','BRT/USD']],
  };
  const list = pairs[market]||pairs['crypto'];
  return { inline_keyboard: [...list.map(row=>row.map(p=>({text:p,callback_data:`pair_${p.replace('/','')}`}))), [{text:'↩️ Back',callback_data:'menu_create'}]] };
};

const entryRuleKeyboard = () => ({
  inline_keyboard: [
    [{text:'📉 RSI Oversold/Overbought',callback_data:'entry_rsi'}],
    [{text:'📊 Moving Average Crossover',callback_data:'entry_ma'}],
    [{text:'🔓 Price Breakout',callback_data:'entry_breakout'}],
    [{text:'🕯️ Candlestick Pattern',callback_data:'entry_candle'}],
    [{text:'🔗 External Webhook (TradingView)',callback_data:'entry_webhook'}],
    [{text:'↩️ Back',callback_data:'step_pair'}],
  ],
});

const modeKeyboard = () => ({
  inline_keyboard: [
    [{text:'🧪 Paper Trading — Practice with virtual $10,000',callback_data:'mode_paper'}],
    [{text:'🚀 Live Trading — Real money, real profits',callback_data:'mode_live'}],
    [{text:'↩️ Back',callback_data:'menu_create'}],
  ],
});

// ─── Auto TP/SL monitor ───────────────────────────────────────────────────────
async function monitorOpenTrades() {
  try {
    const allUsers = db.getAllUsers();
    for (const user of allUsers) {
      if (user.bot_stopped) continue;
      const openTrades = db.listTrades(user.telegram_id, { status: 'open' });
      for (const trade of openTrades) {
        const currentPrice = await fetchPrice(trade.pair);
        let shouldClose = false, closeReason = '', closePrice = currentPrice;
        if (trade.action === 'BUY') {
          if (currentPrice >= trade.take_profit) { shouldClose=true; closeReason='Take Profit Hit 🎯'; closePrice=trade.take_profit; }
          else if (currentPrice <= trade.stop_loss) { shouldClose=true; closeReason='Stop Loss Hit 🛡️'; closePrice=trade.stop_loss; }
        } else {
          if (currentPrice <= trade.take_profit) { shouldClose=true; closeReason='Take Profit Hit 🎯'; closePrice=trade.take_profit; }
          else if (currentPrice >= trade.stop_loss) { shouldClose=true; closeReason='Stop Loss Hit 🛡️'; closePrice=trade.stop_loss; }
        }
        if (shouldClose) {
          if (trade.mode === 'live') {
            const userFull = db.getUser(user.telegram_id);
            if (userFull?.auto_trade_enabled && userFull?.exchange) {
              const apiKey = simpleDecrypt(userFull[`${userFull.exchange}_api_key_enc`]||'');
              const apiSecret = simpleDecrypt(userFull[`${userFull.exchange}_secret_enc`]||'');
              if (apiKey && apiSecret) {
                const exitSide = trade.action==='BUY'?'SELL':'BUY';
                const symbol = trade.pair.replace('/','').toUpperCase();
                let res;
                if (userFull.exchange==='binance') res = await placeBinanceOrder(apiKey,apiSecret,symbol,exitSide,trade.quantity);
                else res = await placeBybitOrder(apiKey,apiSecret,symbol,exitSide,trade.quantity);
                if (res.success && res.price) closePrice = res.price;
              }
            }
          }
          const closed = db.closeTrade(trade.id, closePrice, closeReason);
          const pnl = closed.pnl;
          const modeTag = trade.mode==='live'?'🚀 LIVE':'🧪 PAPER';
          await sendTelegram(user.telegram_id,
            `${pnl>=0?'💰':'💸'} <b>Trade Closed — ${closeReason}</b>\n\n`+
            `💱 ${trade.pair} | ${trade.action}\n`+
            `📥 Entry: $${fmt(trade.entry_price)}\n`+
            `📤 Exit: $${fmt(closePrice)}\n`+
            `💵 P&L: ${fmtPnl(pnl)} (${fmtPct(closed.pnl_pct)})\n`+
            `📦 Qty: ${trade.quantity} | ${modeTag}\n`+
            `📋 ${trade.strategy_name} | 🆔 <code>${trade.id.slice(-8)}</code>`,
            {inline_keyboard:[[{text:'📊 Performance',callback_data:'menu_performance'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
          );
        }
      }
    }
  } catch(e) { console.error('Monitor error:',e.message); }
}

async function monitorPriceAlerts() {
  try {
    const alerts = db.getActiveAlerts();
    for (const alert of alerts) {
      const currentPrice = await fetchPrice(alert.pair);
      let triggered = false;
      if (alert.direction==='above' && currentPrice>=alert.target_price) triggered=true;
      if (alert.direction==='below' && currentPrice<=alert.target_price) triggered=true;
      if (triggered) {
        db.markAlertTriggered(alert.id);
        await sendTelegram(alert.telegram_id,
          `🔔 <b>Price Alert Triggered!</b>\n\n`+
          `💱 ${alert.pair} is now <b>$${fmt(currentPrice)}</b>\n`+
          `📌 Your target: ${alert.direction==='above'?'📈 above':'📉 below'} $${fmt(alert.target_price)}\n\n`+
          `⚡ React now before the move is over!`,
          {inline_keyboard:[[{text:'🤖 Create Trade',callback_data:'menu_create'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
        );
      }
    }
  } catch(e) { console.error('Alert monitor error:',e.message); }
}

// ─── Exchange orders ──────────────────────────────────────────────────────────
async function placeBinanceOrder(apiKey, apiSecret, symbol, side, quantity) {
  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
    const crypto = require('crypto');
    const signature = crypto.createHmac('sha256',apiSecret).update(queryString).digest('hex');
    const r = await fetch(`https://api.binance.com/api/v3/order?${queryString}&signature=${signature}`,{
      method:'POST', headers:{'X-MBX-APIKEY':apiKey,'Content-Type':'application/x-www-form-urlencoded'},
    });
    const data = await r.json();
    if (!r.ok) return {success:false,error:data.msg||'Order failed'};
    return {success:true,orderId:String(data.orderId),price:parseFloat(data.fills?.[0]?.price||0)};
  } catch(e) { return {success:false,error:e.message}; }
}

async function placeBybitOrder(apiKey, apiSecret, symbol, side, qty) {
  try {
    const timestamp = Date.now().toString();
    const params = {category:'spot',symbol,side:side==='BUY'?'Buy':'Sell',orderType:'Market',qty:String(qty)};
    const body = JSON.stringify(params);
    const crypto = require('crypto');
    const sign = crypto.createHmac('sha256',apiSecret).update(timestamp+apiKey+'5000'+body).digest('hex');
    const r = await fetch('https://api.bybit.com/v5/order/create',{
      method:'POST',
      headers:{'X-BAPI-API-KEY':apiKey,'X-BAPI-SIGN':sign,'X-BAPI-TIMESTAMP':timestamp,'X-BAPI-RECV-WINDOW':'5000','Content-Type':'application/json'},
      body,
    });
    const data = await r.json();
    if (data.retCode!==0) return {success:false,error:data.retMsg};
    return {success:true,orderId:data.result?.orderId||'',price:0};
  } catch(e) { return {success:false,error:e.message}; }
}

// ─── Signal processor ─────────────────────────────────────────────────────────
async function processSignal(telegram_id, pair, action, raw_payload, price_override) {
  const strategies = db.listStrategies(telegram_id, {is_active:true});
  const pairNorm = pair.replace('/','').toUpperCase();
  const matched = strategies.filter(s=>s.pair.replace('/','').toUpperCase()===pairNorm||s.entry_type==='webhook');
  if (matched.length===0) {
    db.createSignalLog({telegram_id,pair,action,raw_payload,processed:false,result:'No matching strategy'});
    await sendTelegram(telegram_id,
      `📡 <b>Signal Received — No Match</b>\n\n${action.toUpperCase()} ${pair}\n\n⚠️ No active strategy matched this pair.\nCreate one via 🤖 Create Strategy.`,
      {inline_keyboard:[[{text:'🤖 Create Strategy',callback_data:'menu_create'}]]}
    );
    return {matched:0};
  }
  const user = db.getUser(telegram_id);
  if (user?.bot_stopped) {
    await sendTelegram(telegram_id,'⛔ Bot is stopped. Signal ignored.',{inline_keyboard:[[{text:'▶️ Resume',callback_data:'resume_bot'}]]});
    return {matched:0};
  }
  let count=0;
  for (const strategy of matched) {
    const todayCount = db.getTodayTradeCount(telegram_id, strategy.id);
    if (strategy.max_trades_per_day && todayCount>=strategy.max_trades_per_day) {
      await sendTelegram(telegram_id,`⚠️ <b>${strategy.name}</b>: Max ${strategy.max_trades_per_day} trades/day reached.`); continue;
    }
    const todayPnl = db.getTodayPnl(telegram_id);
    const balance = user.balance_usd||10000;
    if (strategy.max_loss_limit_pct && todayPnl<0 && Math.abs(todayPnl)/balance*100>=strategy.max_loss_limit_pct) {
      await sendTelegram(telegram_id,`⛔ <b>${strategy.name}</b>: Daily loss limit (${strategy.max_loss_limit_pct}%) reached. Paused for today.`); continue;
    }
    const price = price_override||await fetchPrice(pair);
    const tp = action.toUpperCase()==='BUY'?price*(1+strategy.take_profit_pct/100):price*(1-strategy.take_profit_pct/100);
    const sl = action.toUpperCase()==='BUY'?price*(1-strategy.stop_loss_pct/100):price*(1+strategy.stop_loss_pct/100);
    const riskAmount = balance*(strategy.risk_per_trade_pct/100);
    const qty = Math.round((riskAmount/(strategy.stop_loss_pct/100*price))*10000)/10000;
    const rr = strategy.take_profit_pct/strategy.stop_loss_pct;
    let liveOrderId='', actualPrice=price;
    if (strategy.mode==='live' && user.auto_trade_enabled && user.exchange) {
      const apiKey = simpleDecrypt(user[`${user.exchange}_api_key_enc`]||'');
      const apiSecret = simpleDecrypt(user[`${user.exchange}_secret_enc`]||'');
      if (apiKey && apiSecret) {
        const symbol = pair.replace('/','').toUpperCase();
        let res;
        if (user.exchange==='binance') res = await placeBinanceOrder(apiKey,apiSecret,symbol,action.toUpperCase(),qty);
        else res = await placeBybitOrder(apiKey,apiSecret,symbol,action.toUpperCase(),qty);
        if (res.success) { liveOrderId=res.orderId; if (res.price) actualPrice=res.price; }
        else { await sendTelegram(telegram_id,`⚠️ Live order failed for ${strategy.name}:\n${res.error}`); continue; }
      }
    }
    const trade = db.createTrade({
      telegram_id,strategy_id:strategy.id,strategy_name:strategy.name,
      pair,action:action.toUpperCase(),entry_price:actualPrice,
      take_profit:tp,stop_loss:sl,quantity:qty,
      status:'open',mode:strategy.mode||'paper',
      exchange_order_id:liveOrderId,signal_payload:raw_payload,
    });
    db.createSignalLog({telegram_id,pair,action,raw_payload,processed:true,matched_strategy_id:strategy.id,result:'Trade opened'});
    const emoji = action.toUpperCase()==='BUY'?'🟢':'🔴';
    const modeTag = strategy.mode==='live'?'🚀 <b>LIVE</b>':'🧪 PAPER';
    const rrTag = rr>=2?'✅ Great R:R':rr>=1.5?'⚠️ Avg R:R':'❌ Low R:R';
    await sendTelegram(telegram_id,
      `${emoji} <b>Trade Executed!</b>\n\n`+
      `📋 ${strategy.name} | ${modeTag}\n`+
      `💱 ${pair} | <b>${action.toUpperCase()}</b>\n`+
      `💰 Entry: $${fmt(actualPrice)}\n`+
      `🎯 TP: $${fmt(tp)} (+${strategy.take_profit_pct}%)\n`+
      `🛡️ SL: $${fmt(sl)} (-${strategy.stop_loss_pct}%)\n`+
      `⚖️ R:R 1:${rr.toFixed(1)} ${rrTag}\n`+
      `📦 Qty: ${qty} | 💸 Risk: $${fmt(riskAmount)}\n`+
      `🆔 <code>${trade.id.slice(-8)}</code>`,
      {inline_keyboard:[[{text:'❌ Close Trade',callback_data:`close_trade_${trade.id.slice(-8)}`},{text:'📊 Dashboard',callback_data:'menu_performance'}],[{text:'🏠 Menu',callback_data:'menu_main'}]]}
    );
    count++;
  }
  return {matched:count};
}

// ─── Onboarding FSM ───────────────────────────────────────────────────────────
async function handleOnboarding(chat_id, user, step, text) {
  const od = user.onboarding_data||{};
  if (step==='await_tp') {
    const tp=parseFloat(text);
    if (isNaN(tp)||tp<=0||tp>100){await sendTelegram(chat_id,'❌ Enter a valid Take Profit % (e.g. <b>3</b>):');return;}
    db.updateUser(user.id,{onboarding_step:'await_sl',onboarding_data:{...od,take_profit_pct:tp}});
    await sendTelegram(chat_id,`✅ TP: <b>${tp}%</b>\n\n🛡️ Enter your <b>Stop Loss %</b>\n💡 Tip: Keep SL less than TP (e.g. 1.5 for 3% TP gives 1:2 R:R):`);
  } else if (step==='await_sl') {
    const sl=parseFloat(text);
    if (isNaN(sl)||sl<=0||sl>50){await sendTelegram(chat_id,'❌ Enter a valid Stop Loss % (e.g. <b>1.5</b>):');return;}
    const rr=(od.take_profit_pct/sl).toFixed(1);
    const rrEmoji=rr>=2?'✅':rr>=1.5?'⚠️':'❌';
    db.updateUser(user.id,{onboarding_step:'await_risk',onboarding_data:{...od,stop_loss_pct:sl}});
    await sendTelegram(chat_id,`✅ SL: <b>${sl}%</b> | ${rrEmoji} R:R 1:${rr}\n\n💸 <b>Risk per trade %</b> of your account (e.g. <b>1</b>):\n💡 Never risk more than 2% per trade.`);
  } else if (step==='await_risk') {
    const risk=parseFloat(text);
    if (isNaN(risk)||risk<=0||risk>10){await sendTelegram(chat_id,'❌ Enter risk % between 0.1 and 10 (e.g. <b>1</b>):');return;}
    db.updateUser(user.id,{onboarding_step:'await_max_trades',onboarding_data:{...od,risk_per_trade_pct:risk}});
    await sendTelegram(chat_id,`✅ Risk: <b>${risk}%/trade</b>\n\n🔢 Max trades per day? (e.g. <b>5</b>):`);
  } else if (step==='await_max_trades') {
    const mt=parseInt(text);
    if (isNaN(mt)||mt<=0||mt>50){await sendTelegram(chat_id,'❌ Enter between 1-50 (e.g. <b>5</b>):');return;}
    db.updateUser(user.id,{onboarding_step:'await_max_loss',onboarding_data:{...od,max_trades_per_day:mt}});
    await sendTelegram(chat_id,`✅ Max trades/day: <b>${mt}</b>\n\n🚨 Max daily loss %? Bot stops if this is hit (e.g. <b>5</b>):`);
  } else if (step==='await_max_loss') {
    const ml=parseFloat(text);
    if (isNaN(ml)||ml<=0||ml>50){await sendTelegram(chat_id,'❌ Enter between 0.1-50 (e.g. <b>5</b>):');return;}
    db.updateUser(user.id,{onboarding_step:'await_strategy_name',onboarding_data:{...od,max_loss_limit_pct:ml}});
    await sendTelegram(chat_id,`✅ Max daily loss: <b>${ml}%</b>\n\n🏷️ Give your strategy a name (e.g. <i>BTC Scalper</i>, <i>Gold Swing</i>):`);
  } else if (step==='await_strategy_name') {
    const name=text.trim().substring(0,40);
    if (!name||name.length<2){await sendTelegram(chat_id,'❌ Name must be at least 2 characters:');return;}
    db.updateUser(user.id,{onboarding_step:'await_mode',onboarding_data:{...od,name}});
    const rr=(od.take_profit_pct/od.stop_loss_pct).toFixed(1);
    await sendTelegram(chat_id,
      `✅ Name: <b>${name}</b>\n\n📋 <b>Strategy Summary:</b>\n`+
      `• ${od.market} | ${od.pair} | ${od.entry_type}\n`+
      `• TP: ${od.take_profit_pct}% | SL: ${od.stop_loss_pct}% | R:R 1:${rr}\n`+
      `• Risk: ${od.risk_per_trade_pct}%/trade | Max: ${od.max_trades_per_day}/day\n`+
      `• Daily loss limit: ${od.max_loss_limit_pct}%\n\n🎯 Choose mode:`,
      modeKeyboard()
    );
  } else if (step==='await_api_key') {
    const exchange=od.exchange;
    const key=text.trim();
    if (key.length<10){await sendTelegram(chat_id,'❌ Invalid API key. Paste the full key:');return;}
    db.updateUser(user.id,{onboarding_step:'await_api_secret',onboarding_data:{...od,api_key_temp:simpleEncrypt(key)}});
    await sendTelegram(chat_id,`✅ API Key saved!\n\n🔐 Now paste your <b>${exchange.toUpperCase()} Secret Key</b>:`);
  } else if (step==='await_api_secret') {
    const exchange=od.exchange;
    const secret=text.trim();
    if (secret.length<10){await sendTelegram(chat_id,'❌ Invalid secret. Paste the full secret:');return;}
    const updateObj={onboarding_step:'',onboarding_data:{},auto_trade_enabled:true,exchange,[`${exchange}_api_key_enc`]:od.api_key_temp,[`${exchange}_secret_enc`]:simpleEncrypt(secret)};
    db.updateUser(user.id,updateObj);
    await sendTelegram(chat_id,
      `🔐 <b>API Keys Encrypted & Saved!</b>\n\n✅ Exchange: <b>${exchange.toUpperCase()}</b>\n✅ Auto Trading: <b>ENABLED</b>\n\n⚠️ Keys are encrypted. Ensure your key has <b>Spot Trading only</b> — never allow withdrawals.`,
      mainMenuKeyboard()
    );
  } else if (step==='await_alert_pair') {
    const raw=text.trim().toUpperCase().replace('/','');
    const formatted = raw.endsWith('USDT')?raw.slice(0,-4)+'/USDT':raw.endsWith('USD')?raw.slice(0,-3)+'/USD':text.trim().toUpperCase();
    db.updateUser(user.id,{onboarding_step:'await_alert_price',onboarding_data:{...od,alert_pair:formatted}});
    await sendTelegram(chat_id,`✅ Pair: <b>${formatted}</b>\n\nEnter <b>target price</b> (e.g. 70000):`);
  } else if (step==='await_alert_price') {
    const price=parseFloat(text);
    if (isNaN(price)||price<=0){await sendTelegram(chat_id,'❌ Enter a valid price:');return;}
    db.updateUser(user.id,{onboarding_step:'await_alert_direction',onboarding_data:{...od,alert_price:price}});
    await sendTelegram(chat_id,`✅ Target: <b>$${fmt(price)}</b>\n\nAlert when price goes:`,
      {inline_keyboard:[[{text:'📈 Above this price',callback_data:'alert_dir_above'},{text:'📉 Below this price',callback_data:'alert_dir_below'}]]}
    );
  } else if (step==='await_journal_note') {
    const note=text.trim();
    if (note.length<3){await sendTelegram(chat_id,'❌ Write at least a few words:');return;}
    db.addJournalNote(chat_id,note);
    db.updateUser(user.id,{onboarding_step:'',onboarding_data:{}});
    await sendTelegram(chat_id,
      `📓 <b>Journal Entry Saved!</b>\n\n"${note.substring(0,100)}${note.length>100?'..':''}"\n\n🗓️ ${new Date().toUTCString()}`,
      {inline_keyboard:[[{text:'📓 View Journal',callback_data:'menu_journal'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
    );
  }
}

// ─── Callback handler ─────────────────────────────────────────────────────────
async function handleCallback(callback) {
  const chat_id = String(callback.message.chat.id);
  const data = callback.data;
  await answerCallback(callback.id);
  let user = db.getUser(chat_id);
  if (!user) user = db.createUser({telegram_id:chat_id,telegram_username:callback.from?.username||'',first_name:callback.from?.first_name||''});
  const od = user.onboarding_data||{};

  if (data==='menu_main') {
    await sendTelegram(chat_id,`🏠 <b>TradeBot AutoLab</b>\n\nWelcome back, <b>${user.first_name||'Trader'}</b>! 👋\n\nWhat would you like to do?`,mainMenuKeyboard());

  } else if (data==='menu_stopall') {
    db.updateUser(user.id,{bot_stopped:true});
    await sendTelegram(chat_id,`🛑 <b>ALL BOTS STOPPED</b>\n\nAll signal processing paused. Open trades remain open.\n\nTap Resume to restart.`,
      {inline_keyboard:[[{text:'▶️ Resume All Bots',callback_data:'resume_bot'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
    );
  } else if (data==='resume_bot') {
    db.updateUser(user.id,{bot_stopped:false});
    await sendTelegram(chat_id,`▶️ <b>Bot RESUMED</b>\n\nAll strategies active and listening for signals.`,mainMenuKeyboard());

  } else if (data==='menu_support') {
    await sendTelegram(chat_id,
      `🆘 <b>Help & Guide</b>\n\n`+
      `<b>Start trading in 4 steps:</b>\n\n`+
      `1️⃣ <b>Create a Strategy</b> — Pick pair, set TP/SL and risk\n`+
      `2️⃣ <b>Connect a Signal</b> — TradingView webhook or manual\n`+
      `3️⃣ <b>Paper Trade First</b> — Practice risk-free with $10,000\n`+
      `4️⃣ <b>Go Live</b> — Connect Binance/Bybit and auto-trade\n\n`+
      `<b>Built-in features:</b>\n`+
      `• Auto TP/SL monitoring every 30 seconds\n`+
      `• Real-time price alerts\n`+
      `• Win rate & P&L analytics\n`+
      `• Trade journal\n`+
      `• Max daily loss protection\n`+
      `• Works 24/7 even when you're offline\n\n`+
      `⚠️ <i>Trading involves risk. Never invest more than you can afford to lose.</i>`,
      {inline_keyboard:[[{text:'🔗 Webhook Guide',callback_data:'menu_signal'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
    );

  } else if (data==='menu_create') {
    const strategies=db.listStrategies(chat_id);
    db.updateUser(user.id,{onboarding_step:'select_market',onboarding_data:{}});
    await sendTelegram(chat_id,`🤖 <b>Create New Strategy</b>\n\nYou have <b>${strategies.length}</b> existing strateg${strategies.length===1?'y':'ies'}.\n\nStep 1: Select your market:`,marketKeyboard());

  } else if (data.startsWith('market_')) {
    const market=data.replace('market_','');
    const labels={crypto:'₿ Crypto',forex:'💱 Forex',indices:'📈 Indices',commodities:'🥇 Commodities'};
    db.updateUser(user.id,{onboarding_step:'select_pair',onboarding_data:{market}});
    await sendTelegram(chat_id,`✅ Market: <b>${labels[market]}</b>\n\nStep 2: Choose trading pair:`,pairKeyboard(market));

  } else if (data.startsWith('pair_')) {
    const pairRaw=data.replace('pair_','');
    const formatted=pairRaw.length>6?pairRaw.replace(/([A-Z]{2,})([A-Z]{3,4}$)/,'$1/$2'):pairRaw;
    db.updateUser(user.id,{onboarding_step:'select_entry',onboarding_data:{...od,pair:formatted}});
    await sendTelegram(chat_id,`✅ Pair: <b>${formatted}</b>\n\nStep 3: Choose entry signal type:`,entryRuleKeyboard());

  } else if (data.startsWith('entry_')) {
    const entryType=data.replace('entry_','');
    const labels={rsi:'RSI Signal',ma:'MA Crossover',breakout:'Price Breakout',candle:'Candlestick Pattern',webhook:'TradingView Webhook'};
    const descs={rsi:'Buy when RSI<30, Sell when RSI>70',ma:'Buy when fast MA crosses above slow MA',breakout:'Buy when price breaks key resistance',candle:'Trigger on specific candle patterns',webhook:'Triggered by TradingView or any HTTP alert'};
    db.updateUser(user.id,{onboarding_step:'await_tp',onboarding_data:{...od,entry_type:entryType}});
    await sendTelegram(chat_id,`✅ Entry: <b>${labels[entryType]}</b>\n📌 <i>${descs[entryType]}</i>\n\nStep 4: Risk Management\n\nEnter your <b>Take Profit %</b>\n💡 Example: <b>3</b> = close trade at +3% gain:`);

  } else if (data==='step_pair') {
    db.updateUser(user.id,{onboarding_step:'select_pair'});
    await sendTelegram(chat_id,'Select trading pair:',pairKeyboard(od.market||'crypto'));

  } else if (data==='mode_paper'||data==='mode_live') {
    const mode=data.replace('mode_','');
    db.createStrategy({
      telegram_id:chat_id,name:od.name,market:od.market,pair:od.pair,
      entry_type:od.entry_type,entry_rules:{},take_profit_pct:od.take_profit_pct,
      stop_loss_pct:od.stop_loss_pct,trailing_stop:false,
      risk_per_trade_pct:od.risk_per_trade_pct,max_trades_per_day:od.max_trades_per_day,
      max_loss_limit_pct:od.max_loss_limit_pct,is_active:true,mode,
    });
    db.updateUser(user.id,{onboarding_step:'',onboarding_data:{}});
    const rr=(od.take_profit_pct/od.stop_loss_pct).toFixed(1);
    await sendTelegram(chat_id,
      `🎉 <b>Strategy "${od.name}" Created!</b>\n\n`+
      `💱 ${od.pair} | ${od.market} | ${od.entry_type}\n`+
      `🎯 TP: ${od.take_profit_pct}% | 🛡️ SL: ${od.stop_loss_pct}% | R:R 1:${rr}\n`+
      `💸 Risk: ${od.risk_per_trade_pct}%/trade | Max: ${od.max_trades_per_day}/day\n`+
      `${mode==='paper'?'🧪':'🚀'} Mode: <b>${mode.toUpperCase()}</b>\n\n`+
      `✅ <b>ACTIVE</b> and listening for signals!`,
      {inline_keyboard:[[{text:'🔗 Connect Signal',callback_data:'menu_signal'}],[{text:'📋 My Strategies',callback_data:'list_strategies'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
    );

  } else if (data==='list_strategies') {
    const strategies=db.listStrategies(chat_id);
    if (!strategies.length) {
      await sendTelegram(chat_id,`📋 <b>My Strategies</b>\n\nNo strategies yet. Create your first one!`,
        {inline_keyboard:[[{text:'🤖 Create Strategy',callback_data:'menu_create'},{text:'↩️ Back',callback_data:'menu_main'}]]}
      ); return;
    }
    let text=`📋 <b>My Strategies (${strategies.length})</b>\n\n`;
    for (const s of strategies) {
      const wr=s.total_trades>0?((s.total_wins/s.total_trades)*100).toFixed(0)+'%':'—';
      text+=`${s.is_active?'🟢':'🔴'} ${s.mode==='live'?'🚀':'🧪'} <b>${s.name}</b>\n`;
      text+=`   💱 ${s.pair} | TP:${s.take_profit_pct}% SL:${s.stop_loss_pct}%\n`;
      text+=`   📊 ${s.total_trades} trades | WR:${wr} | ${fmtPnl(s.total_pnl||0)}\n\n`;
    }
    const keyboard={inline_keyboard:[
      ...strategies.slice(0,5).map(s=>[{text:`${s.is_active?'⏸ Pause':'▶️ Enable'} ${s.name}`,callback_data:`toggle_strategy_${s.id.slice(-8)}`},{text:'🗑️',callback_data:`delete_strat_${s.id.slice(-8)}`}]),
      [{text:'🤖 Add New',callback_data:'menu_create'},{text:'↩️ Back',callback_data:'menu_main'}],
    ]};
    await sendTelegram(chat_id,text,keyboard);

  } else if (data.startsWith('toggle_strategy_')) {
    const suffix=data.replace('toggle_strategy_','');
    const s=db.listStrategies(chat_id).find(x=>x.id.slice(-8)===suffix);
    if (s) { db.updateStrategy(s.id,{is_active:!s.is_active}); await sendTelegram(chat_id,`${!s.is_active?'▶️ Enabled':'⏸ Paused'}: <b>${s.name}</b>`,{inline_keyboard:[[{text:'📋 Back',callback_data:'list_strategies'}]]}); }

  } else if (data.startsWith('delete_strat_')) {
    const suffix=data.replace('delete_strat_','');
    const s=db.listStrategies(chat_id).find(x=>x.id.slice(-8)===suffix);
    if (s) await sendTelegram(chat_id,`🗑️ <b>Delete "${s.name}"?</b>\n\nThis cannot be undone.`,{inline_keyboard:[[{text:'✅ Delete',callback_data:`confirm_delete_${s.id.slice(-8)}`},{text:'❌ Cancel',callback_data:'list_strategies'}]]});

  } else if (data.startsWith('confirm_delete_')) {
    const suffix=data.replace('confirm_delete_','');
    const s=db.listStrategies(chat_id).find(x=>x.id.slice(-8)===suffix);
    if (s) { db.deleteStrategy(s.id); await sendTelegram(chat_id,`🗑️ "${s.name}" deleted.`,{inline_keyboard:[[{text:'📋 Strategies',callback_data:'list_strategies'},{text:'🏠 Menu',callback_data:'menu_main'}]]}); }

  } else if (data.startsWith('close_trade_')) {
    const suffix=data.replace('close_trade_','');
    const trade=db.listTrades(chat_id,{status:'open'}).find(t=>t.id.slice(-8)===suffix);
    if (trade) {
      const price=await fetchPrice(trade.pair);
      const closed=db.closeTrade(trade.id,price,'Manual Close 👤');
      await sendTelegram(chat_id,`👤 <b>Closed Manually</b>\n\n💱 ${trade.pair} | ${trade.action}\n📥 Entry: $${fmt(trade.entry_price)}\n📤 Exit: $${fmt(price)}\n💵 P&L: ${fmtPnl(closed.pnl)} (${fmtPct(closed.pnl_pct)})`,
        {inline_keyboard:[[{text:'📊 Performance',callback_data:'menu_performance'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
      );
    } else await sendTelegram(chat_id,'⚠️ Trade not found or already closed.',{inline_keyboard:[[{text:'🏠 Menu',callback_data:'menu_main'}]]});

  } else if (data==='menu_performance') {
    const stats=db.getStats(chat_id);
    const strategies=db.listStrategies(chat_id);
    const recentClosed=db.listTrades(chat_id,{status:'closed',limit:10});
    const todayPnl=db.getTodayPnl(chat_id);
    const spark=sparkline(recentClosed);
    let streak=0; for (const t of recentClosed){if(t.pnl>0)streak++;else break;}
    let stratText='';
    for (const s of strategies.slice(0,3)) {
      const wr=s.total_trades>0?((s.total_wins/s.total_trades)*100).toFixed(0)+'%':'—';
      stratText+=`\n  ${s.mode==='live'?'🚀':'🧪'} <b>${s.name}</b>: ${s.total_trades} trades | ${wr} WR | ${fmtPnl(s.total_pnl||0)}`;
    }
    await sendTelegram(chat_id,
      `📊 <b>Performance Dashboard</b>\n\n`+
      `📈 Total: <b>${stats.total}</b> | Open: <b>${stats.open}</b> | Closed: <b>${stats.closed}</b>\n`+
      `✅ Wins: <b>${stats.wins}</b> | ❌ Losses: <b>${stats.losses}</b>\n`+
      `🏆 Win Rate: <b>${stats.winRate.toFixed(1)}%</b>\n`+
      `💰 Total P&L: <b>${fmtPnl(stats.totalPnl)}</b>\n`+
      `📅 Today: <b>${fmtPnl(todayPnl)}</b>\n`+
      `📊 Avg/trade: <b>${fmtPnl(stats.avgPnl)}</b>\n`+
      `🔥 Win streak: <b>${streak}</b>\n\n`+
      `📉 Last 10: ${spark}\n`+
      (stats.bestTrade?`\n🥇 Best: ${fmtPnl(stats.bestTrade.pnl)} (${stats.bestTrade.pair})`:'')+
      (stats.worstTrade&&stats.worstTrade.pnl<0?`\n💸 Worst: ${fmtPnl(stats.worstTrade.pnl)} (${stats.worstTrade.pair})`:'`')+
      `\n\n<b>Strategies:</b>${stratText||'\nNone yet.'}`,
      {inline_keyboard:[[{text:'📂 Open Trades',callback_data:'view_open_trades'},{text:'📜 History',callback_data:'view_history'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
    );

  } else if (data==='view_open_trades') {
    const openTrades=db.listTrades(chat_id,{status:'open'});
    if (!openTrades.length){await sendTelegram(chat_id,'📂 <b>Open Trades</b>\n\nNo open trades right now.',{inline_keyboard:[[{text:'↩️ Back',callback_data:'menu_performance'}]]});return;}
    let text=`📂 <b>Open Trades (${openTrades.length})</b>\n\n`;
    for (const t of openTrades.slice(0,8)) {
      const cur=await fetchPrice(t.pair);
      const upnl=t.action==='BUY'?(cur-t.entry_price)*t.quantity:(t.entry_price-cur)*t.quantity;
      text+=`${upnl>=0?'🟢':'🔴'} <b>${t.pair}</b> ${t.action}\n`;
      text+=`   Entry:$${fmt(t.entry_price)} Now:$${fmt(cur)} | ${fmtPnl(upnl)}\n`;
      text+=`   ${t.mode==='live'?'🚀':'🧪'} ${t.strategy_name}\n\n`;
    }
    await sendTelegram(chat_id,text,{inline_keyboard:[[{text:'↩️ Back',callback_data:'menu_performance'}]]});

  } else if (data==='view_history') {
    const trades=db.listTrades(chat_id,{status:'closed',limit:10});
    if (!trades.length){await sendTelegram(chat_id,'📜 No closed trades yet.',{inline_keyboard:[[{text:'↩️ Back',callback_data:'menu_performance'}]]});return;}
    let text=`📜 <b>Trade History (last ${trades.length})</b>\n\n`;
    for (const t of trades) {
      text+=`${t.pnl>=0?'✅':'❌'} <b>${t.pair}</b> ${t.action} ${fmtPnl(t.pnl)}\n`;
      text+=`   $${fmt(t.entry_price)} → $${fmt(t.exit_price)} | ${t.close_reason}\n\n`;
    }
    await sendTelegram(chat_id,text,{inline_keyboard:[[{text:'↩️ Back',callback_data:'menu_performance'}]]});

  } else if (data==='menu_prices') {
    const pairs=['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT','XAU/USD'];
    const prices={};
    for (const p of pairs) prices[p]=await fetchPrice(p);
    await sendTelegram(chat_id,
      `📈 <b>Live Market Prices</b>\n\n`+
      `₿  BTC/USDT  <b>$${fmt(prices['BTC/USDT'])}</b>\n`+
      `🔷 ETH/USDT  <b>$${fmt(prices['ETH/USDT'])}</b>\n`+
      `🟣 SOL/USDT  <b>$${fmt(prices['SOL/USDT'])}</b>\n`+
      `🟡 BNB/USDT  <b>$${fmt(prices['BNB/USDT'])}</b>\n`+
      `🔵 XRP/USDT  <b>$${fmt(prices['XRP/USDT'])}</b>\n`+
      `🥇 XAU/USD   <b>$${fmt(prices['XAU/USD'])}</b>\n\n`+
      `⏱️ ${new Date().toUTCString()}`,
      {inline_keyboard:[[{text:'🔔 Set Alert',callback_data:'add_alert'},{text:'🔄 Refresh',callback_data:'menu_prices'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
    );

  } else if (data==='menu_alerts') {
    const alerts=db.getUserAlerts(chat_id);
    let text=`🔔 <b>Price Alerts</b>\n\nGet notified the moment a price hits your target.\n\n`;
    if (alerts.length) { text+=`<b>Active (${alerts.length}):</b>\n`; for (const a of alerts) text+=`• ${a.pair} ${a.direction==='above'?'📈 >':'📉 <'} $${fmt(a.target_price)}\n`; text+='\n'; }
    else text+='No active alerts.\n\n';
    await sendTelegram(chat_id,text,{inline_keyboard:[[{text:'➕ Add Price Alert',callback_data:'add_alert'}],[{text:'↩️ Back',callback_data:'menu_main'}]]});

  } else if (data==='add_alert') {
    db.updateUser(user.id,{onboarding_step:'await_alert_pair',onboarding_data:{}});
    await sendTelegram(chat_id,`🔔 <b>New Price Alert</b>\n\nType the pair (e.g. <code>BTCUSDT</code>, <code>ETHUSDT</code>):`);

  } else if (data==='alert_dir_above'||data==='alert_dir_below') {
    const direction=data==='alert_dir_above'?'above':'below';
    db.createPriceAlert({telegram_id:chat_id,pair:od.alert_pair,direction,target_price:od.alert_price});
    db.updateUser(user.id,{onboarding_step:'',onboarding_data:{}});
    await sendTelegram(chat_id,`✅ <b>Alert Set!</b>\n\n${od.alert_pair} ${direction==='above'?'📈 above':'📉 below'} <b>$${fmt(od.alert_price)}</b>\n\nI'll notify you the moment it's hit!`,
      {inline_keyboard:[[{text:'🔔 My Alerts',callback_data:'menu_alerts'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
    );

  } else if (data==='menu_signal') {
    await sendTelegram(chat_id,
      `🔗 <b>Connect TradingView Signal</b>\n\n`+
      `<b>Your personal webhook URL:</b>\n`+
      `<code>${SERVER_URL}/signal?user_id=${chat_id}</code>\n\n`+
      `<b>Steps:</b>\n`+
      `1. TradingView → Create Alert\n`+
      `2. Notifications → Enable Webhook URL\n`+
      `3. Paste your URL above\n`+
      `4. In Message field paste:\n\n`+
      `<code>{\n  "pair": "BTCUSDT",\n  "action": "BUY",\n  "price": {{close}}\n}</code>\n\n`+
      `✅ Supported: BUY, SELL, LONG, SHORT\n`+
      `✅ Pair must match your strategy`,
      {inline_keyboard:[[{text:'🧪 Test Signal (BTC BUY)',callback_data:'test_signal'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
    );

  } else if (data==='test_signal') {
    const result=await processSignal(chat_id,'BTC/USDT','BUY',{test:true},null);
    if (result.matched===0) await sendTelegram(chat_id,`🧪 Test sent! No BTC/USDT strategy found.\n\nCreate one first then test again.`,{inline_keyboard:[[{text:'🤖 Create Strategy',callback_data:'menu_create'}]]});

  } else if (data==='menu_paper') {
    const stats=db.getStats(chat_id);
    const paperStrats=db.listStrategies(chat_id).filter(s=>s.mode==='paper');
    const openPaper=db.listTrades(chat_id,{mode:'paper',status:'open'});
    await sendTelegram(chat_id,
      `🧪 <b>Paper Trading</b>\n\nPractice with <b>$10,000 virtual money</b> — zero real risk.\n\n`+
      `📊 Total: <b>${stats.total}</b> | Open: <b>${openPaper.length}</b>\n`+
      `🏆 Win Rate: <b>${stats.winRate.toFixed(1)}%</b>\n`+
      `💰 P&L: <b>${fmtPnl(stats.totalPnl)}</b>\n`+
      `📋 Paper strategies: <b>${paperStrats.length}</b>\n\n`+
      `💡 Validate your strategy here before risking real money.`,
      {inline_keyboard:[[{text:'🤖 Create Paper Strategy',callback_data:'menu_create'},{text:'📊 Full Report',callback_data:'menu_performance'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
    );

  } else if (data==='menu_autotrade') {
    if (user.auto_trade_enabled && user.exchange) {
      const liveStrats=db.listStrategies(chat_id).filter(s=>s.mode==='live'&&s.is_active);
      await sendTelegram(chat_id,
        `🚀 <b>Live Trading</b>\n\n✅ Exchange: <b>${user.exchange.toUpperCase()}</b>\n✅ Status: <b>ACTIVE</b>\n📋 Live strategies: <b>${liveStrats.length}</b>\n\n⚠️ API keys are encrypted and stored securely.`,
        {inline_keyboard:[[{text:'⛔ Disable Auto Trade',callback_data:'disable_autotrade'}],[{text:'🔑 Update API Keys',callback_data:'connect_binance'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
      );
    } else {
      await sendTelegram(chat_id,
        `🚀 <b>Live Trading Setup</b>\n\n⚠️ <b>Safety rules:</b>\n• Only grant <b>Spot Trading</b> permission\n• <b>NEVER</b> allow withdrawal\n• Test with paper trading first\n\nSelect exchange:`,
        {inline_keyboard:[[{text:'🟡 Binance',callback_data:'connect_binance'},{text:'🔵 Bybit',callback_data:'connect_bybit'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
      );
    }

  } else if (data==='disable_autotrade') {
    db.updateUser(user.id,{auto_trade_enabled:false});
    await sendTelegram(chat_id,`⛔ Auto Trading <b>DISABLED</b>.\n\nKeys still saved. Re-enable anytime.`,mainMenuKeyboard());

  } else if (data==='connect_binance'||data==='connect_bybit') {
    const exchange=data==='connect_bybit'?'bybit':'binance';
    db.updateUser(user.id,{onboarding_step:'await_api_key',onboarding_data:{exchange}});
    await sendTelegram(chat_id,
      `🔐 <b>${exchange.toUpperCase()} API Setup</b>\n\n1. Login to ${exchange.toUpperCase()}\n2. Account → API Management\n3. Create key with <b>Spot Trading only</b>\n4. Disable withdrawals\n\n🔒 Keys encrypted before storage.\n\nPaste your <b>API Key</b>:`
    );

  } else if (data==='menu_journal') {
    const notes=db.getJournal(chat_id);
    let text=`📓 <b>Trade Journal</b>\n\nRecord lessons, analysis, and trade rationale.\n\n`;
    if (notes.length) { text+=`<b>Recent entries:</b>\n\n`; for (const n of notes.slice(0,5)) { text+=`📝 <i>${n.created_date.split('T')[0]}</i>\n${n.note.substring(0,120)}${n.note.length>120?'...':''}\n\n`; } }
    else text+='No entries yet. Start journaling!\n\n';
    await sendTelegram(chat_id,text,{inline_keyboard:[[{text:'✍️ Add Entry',callback_data:'add_journal'}],[{text:'↩️ Back',callback_data:'menu_main'}]]});

  } else if (data==='add_journal') {
    db.updateUser(user.id,{onboarding_step:'await_journal_note',onboarding_data:{}});
    await sendTelegram(chat_id,`✍️ <b>New Journal Entry</b>\n\nType your thoughts, analysis, or lesson:\n\n💡 <i>e.g. "Entered BTC at 65k, RSI was oversold. Took profit at 67k +3%. Should have held longer."</i>`);

  } else if (data==='menu_settings') {
    const strategies=db.listStrategies(chat_id);
    await sendTelegram(chat_id,
      `⚙️ <b>Settings</b>\n\n👤 ${user.first_name||'Unknown'} | 🆔 <code>${chat_id}</code>\n📋 Strategies: ${strategies.length} (${strategies.filter(s=>s.is_active).length} active)\n🚀 Auto Trade: ${user.auto_trade_enabled?'✅ On':'❌ Off'}\n💱 Exchange: ${user.exchange?user.exchange.toUpperCase():'None'}\n🛑 Status: ${user.bot_stopped?'⛔ Stopped':'✅ Running'}\n\n🔗 <code>${SERVER_URL}/signal?user_id=${chat_id}</code>`,
      {inline_keyboard:[
        [{text:'📋 Manage Strategies',callback_data:'list_strategies'}],
        [{text:user.auto_trade_enabled?'⛔ Disable Auto Trade':'🚀 Enable Auto Trade',callback_data:user.auto_trade_enabled?'disable_autotrade':'menu_autotrade'}],
        [{text:user.bot_stopped?'▶️ Resume Bot':'🛑 Pause Bot',callback_data:user.bot_stopped?'resume_bot':'menu_stopall'}],
        [{text:'🔔 Price Alerts',callback_data:'menu_alerts'},{text:'📓 Journal',callback_data:'menu_journal'}],
        [{text:'🗑️ Reset All Data',callback_data:'confirm_clear_data'}],
        [{text:'↩️ Back',callback_data:'menu_main'}],
      ]}
    );

  } else if (data==='confirm_clear_data') {
    await sendTelegram(chat_id,`⚠️ <b>Reset All Data?</b>\n\nDeletes all strategies, trades, and settings permanently.`,
      {inline_keyboard:[[{text:'✅ Yes, Reset',callback_data:'do_clear_data'},{text:'❌ Cancel',callback_data:'menu_settings'}]]}
    );
  } else if (data==='do_clear_data') {
    db.updateUser(user.id,{onboarding_step:'',onboarding_data:{},bot_stopped:false,auto_trade_enabled:false,exchange:'',binance_api_key_enc:'',binance_secret_enc:'',bybit_api_key_enc:'',bybit_secret_enc:''});
    await sendTelegram(chat_id,`🗑️ <b>Data Reset.</b> Send /start to begin fresh.`,mainMenuKeyboard());
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chat_id=String(msg.chat.id);
  const text=msg.text||'';
  let user=db.getUser(chat_id);
  if (!user) user=db.createUser({telegram_id:chat_id,telegram_username:msg.from?.username||'',first_name:msg.from?.first_name||''});

  if (text.startsWith('/start')) {
    db.updateUser(user.id,{bot_stopped:false,onboarding_step:'',onboarding_data:{},first_name:msg.from?.first_name||user.first_name});
    await sendTelegram(chat_id,
      `🤖 <b>TradeBot AutoLab</b>\n\n`+
      `${user.first_name?`Welcome back, <b>${msg.from?.first_name||user.first_name}</b>! 👋`:'🎉 <b>Welcome to TradeBot AutoLab!</b>'}\n\n`+
      `<b>Your 24/7 automated trading assistant.</b>\n\n`+
      `✅ Build smart strategies in minutes\n`+
      `✅ Auto-execute trades on Binance & Bybit\n`+
      `✅ Connect TradingView signals via webhook\n`+
      `✅ Paper trade risk-free with $10,000 virtual\n`+
      `✅ Auto TP/SL monitoring every 30 seconds\n`+
      `✅ Real-time price alerts & analytics\n\n`+
      `💡 New? Tap <b>🆘 Help & Guide</b> to get started.`,
      mainMenuKeyboard()
    );
    return;
  }
  if (text==='/menu') { await sendTelegram(chat_id,`🏠 <b>Main Menu</b>`,mainMenuKeyboard()); return; }
  if (text==='/performance'||text==='/stats') { await handleCallback({message:{chat:{id:chat_id}},from:msg.from,id:'0',data:'menu_performance'}); return; }
  if (text==='/prices') { await handleCallback({message:{chat:{id:chat_id}},from:msg.from,id:'0',data:'menu_prices'}); return; }
  if (text==='/help') { await handleCallback({message:{chat:{id:chat_id}},from:msg.from,id:'0',data:'menu_support'}); return; }
  if (text==='/stop') { db.updateUser(user.id,{bot_stopped:true}); await sendTelegram(chat_id,'🛑 <b>Bot stopped.</b> Send /start to resume.'); return; }

  if (user.onboarding_step && user.onboarding_step!=='done') {
    await handleOnboarding(chat_id,user,user.onboarding_step,text); return;
  }
  await sendTelegram(chat_id,`💬 Use the menu to navigate.\n\nCommands: /menu /prices /stats /help /stop`,mainMenuKeyboard());
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    if (req.body.callback_query) await handleCallback(req.body.callback_query);
    else if (req.body.message) await handleMessage(req.body.message);
  } catch(e) { console.error('Webhook error:',e.message,e.stack); }
});

app.post('/signal', async (req, res) => {
  const user_id=req.query.user_id||req.body.user_id;
  if (!user_id) return res.status(400).json({error:'user_id required'});
  const {pair,action,price}=req.body;
  if (!pair||!action) return res.status(400).json({error:'pair and action required'});
  const normalizedAction=['BUY','LONG','buy','long'].includes(action)?'BUY':'SELL';
  const result=await processSignal(user_id,pair,normalizedAction,req.body,price?parseFloat(price):null);
  res.json({success:true,matched:result.matched,pair,action:normalizedAction});
});

app.get('/signal', async (req, res) => {
  const {user_id,pair,action}=req.query;
  if (!user_id||!pair||!action) return res.status(400).json({error:'user_id, pair, action required'});
  const normalizedAction=['BUY','LONG','buy','long'].includes(action)?'BUY':'SELL';
  const result=await processSignal(user_id,pair,normalizedAction,req.query,null);
  res.json({success:true,matched:result.matched});
});

app.get('/', (req, res) => res.json({
  status:'TradeBot AutoLab running 🤖',
  version:'3.0',
  users:db.getAllUsers().length,
  activeBots:db.getAllUsers().filter(u=>!u.bot_stopped).length,
  uptime:Math.floor(process.uptime())+'s',
  time:new Date().toISOString(),
}));

app.get('/health', (req, res) => res.json({ok:true,uptime:process.uptime()}));

setInterval(monitorOpenTrades, 30*1000);
setInterval(monitorPriceAlerts, 60*1000);

app.listen(PORT, () => {
  console.log(`🚀 TradeBot AutoLab v3.0 on port ${PORT}`);
});
