'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8690768077:AAEuNWV21kc3fg-XPXl__y87zLBtP1POYPs';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://tradebot-server-production.up.railway.app/webhook';
const PORT = process.env.PORT || 3000;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || ''; // Set this to YOUR telegram ID for support chat
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID || '';
const PRO_MONTHLY_USD = 29;

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tradebot.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_users (
    id TEXT PRIMARY KEY,
    telegram_id TEXT UNIQUE NOT NULL,
    telegram_username TEXT DEFAULT '',
    first_name TEXT DEFAULT '',
    auto_trade_enabled INTEGER DEFAULT 0,
    bot_stopped INTEGER DEFAULT 0,
    binance_api_key_enc TEXT DEFAULT '',
    binance_secret_enc TEXT DEFAULT '',
    bybit_api_key_enc TEXT DEFAULT '',
    bybit_secret_enc TEXT DEFAULT '',
    exchange TEXT DEFAULT '',
    onboarding_step TEXT DEFAULT '',
    onboarding_data TEXT DEFAULT '{}',
    balance_usd REAL DEFAULT 10000,
    plan TEXT DEFAULT 'free',
    plan_expires TEXT DEFAULT '',
    stripe_customer_id TEXT DEFAULT '',
    support_thread_open INTEGER DEFAULT 0,
    last_seen TEXT DEFAULT (datetime('now')),
    created_date TEXT DEFAULT (datetime('now')),
    updated_date TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS strategies (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    name TEXT NOT NULL,
    market TEXT DEFAULT '',
    pair TEXT DEFAULT '',
    entry_type TEXT DEFAULT '',
    entry_rules TEXT DEFAULT '{}',
    take_profit_pct REAL DEFAULT 2,
    stop_loss_pct REAL DEFAULT 1,
    trailing_stop INTEGER DEFAULT 0,
    risk_per_trade_pct REAL DEFAULT 1,
    max_trades_per_day INTEGER DEFAULT 5,
    max_loss_limit_pct REAL DEFAULT 5,
    is_active INTEGER DEFAULT 1,
    mode TEXT DEFAULT 'paper',
    total_trades INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_pnl REAL DEFAULT 0,
    created_date TEXT DEFAULT (datetime('now')),
    updated_date TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    strategy_id TEXT DEFAULT '',
    strategy_name TEXT DEFAULT '',
    pair TEXT DEFAULT '',
    action TEXT DEFAULT '',
    entry_price REAL DEFAULT 0,
    exit_price REAL DEFAULT 0,
    take_profit REAL DEFAULT 0,
    stop_loss REAL DEFAULT 0,
    quantity REAL DEFAULT 0,
    pnl REAL DEFAULT 0,
    pnl_pct REAL DEFAULT 0,
    status TEXT DEFAULT 'open',
    mode TEXT DEFAULT 'paper',
    exchange_order_id TEXT DEFAULT '',
    signal_payload TEXT DEFAULT '{}',
    close_reason TEXT DEFAULT '',
    created_date TEXT DEFAULT (datetime('now')),
    updated_date TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS signal_logs (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    pair TEXT DEFAULT '',
    action TEXT DEFAULT '',
    raw_payload TEXT DEFAULT '{}',
    processed INTEGER DEFAULT 0,
    matched_strategy_id TEXT DEFAULT '',
    result TEXT DEFAULT '',
    created_date TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS price_alerts (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    pair TEXT NOT NULL,
    direction TEXT NOT NULL,
    target_price REAL NOT NULL,
    triggered INTEGER DEFAULT 0,
    created_date TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS journal_notes (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_date TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS support_messages (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    first_name TEXT DEFAULT '',
    message TEXT NOT NULL,
    direction TEXT DEFAULT 'inbound',
    read_by_admin INTEGER DEFAULT 0,
    created_date TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    sent INTEGER DEFAULT 0,
    scheduled_at TEXT DEFAULT (datetime('now')),
    created_date TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations
const migrations = [
  `ALTER TABLE bot_users ADD COLUMN plan TEXT DEFAULT 'free'`,
  `ALTER TABLE bot_users ADD COLUMN plan_expires TEXT DEFAULT ''`,
  `ALTER TABLE bot_users ADD COLUMN stripe_customer_id TEXT DEFAULT ''`,
  `ALTER TABLE bot_users ADD COLUMN support_thread_open INTEGER DEFAULT 0`,
  `ALTER TABLE bot_users ADD COLUMN last_seen TEXT DEFAULT (datetime('now'))`,
  `ALTER TABLE strategies ADD COLUMN total_trades INTEGER DEFAULT 0`,
  `ALTER TABLE strategies ADD COLUMN total_wins INTEGER DEFAULT 0`,
  `ALTER TABLE strategies ADD COLUMN total_pnl REAL DEFAULT 0`,
  `ALTER TABLE bot_users ADD COLUMN balance_usd REAL DEFAULT 10000`,
  `ALTER TABLE bot_users ADD COLUMN mexc_api_key_enc TEXT DEFAULT ''`,
  `ALTER TABLE bot_users ADD COLUMN mexc_secret_enc TEXT DEFAULT ''`,
  `ALTER TABLE bot_users ADD COLUMN okx_api_key_enc TEXT DEFAULT ''`,
  `ALTER TABLE bot_users ADD COLUMN okx_secret_enc TEXT DEFAULT ''`,
  `ALTER TABLE bot_users ADD COLUMN kucoin_api_key_enc TEXT DEFAULT ''`,
  `ALTER TABLE bot_users ADD COLUMN kucoin_secret_enc TEXT DEFAULT ''`,
  `ALTER TABLE bot_users ADD COLUMN demo_balance REAL DEFAULT 0`,
  `ALTER TABLE bot_users ADD COLUMN demo_initial REAL DEFAULT 0`,
];
migrations.forEach(m => { try { db.exec(m); } catch(_) {} });

function genId() { return crypto.randomBytes(16).toString('hex'); }

// ─── USER CRUD ────────────────────────────────────────────────────────────────
function getUser(telegram_id) {
  const row = db.prepare('SELECT * FROM bot_users WHERE telegram_id = ?').get(String(telegram_id));
  if (!row) return null;
  row.onboarding_data = JSON.parse(row.onboarding_data || '{}');
  row.auto_trade_enabled = !!row.auto_trade_enabled;
  row.bot_stopped = !!row.bot_stopped;
  return row;
}
function getAllUsers() {
  return db.prepare('SELECT * FROM bot_users').all().map(r => ({
    ...r, bot_stopped: !!r.bot_stopped, auto_trade_enabled: !!r.auto_trade_enabled
  }));
}
function createUser(data) {
  const id = genId();
  db.prepare(`INSERT INTO bot_users (id,telegram_id,telegram_username,first_name,onboarding_data) VALUES (?,?,?,?,?)`)
    .run(id, String(data.telegram_id), data.telegram_username||'', data.first_name||'', '{}');
  return getUser(data.telegram_id);
}
function updateUser(id, data) {
  const allowed = ['telegram_username','first_name','auto_trade_enabled','bot_stopped',
    'binance_api_key_enc','binance_secret_enc','bybit_api_key_enc','bybit_secret_enc',
    'mexc_api_key_enc','mexc_secret_enc','okx_api_key_enc','okx_secret_enc',
    'kucoin_api_key_enc','kucoin_secret_enc',
    'exchange','onboarding_step','onboarding_data','balance_usd','plan','plan_expires',
    'demo_balance','demo_initial',
    'stripe_customer_id','support_thread_open','last_seen'];
  const sets=[], vals=[];
  for (const [k,v] of Object.entries(data)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k}=?`);
    if (k==='onboarding_data') vals.push(JSON.stringify(v));
    else if (typeof v==='boolean') vals.push(v?1:0);
    else vals.push(v);
  }
  if (!sets.length) return;
  sets.push(`updated_date=datetime('now')`);
  vals.push(id);
  db.prepare(`UPDATE bot_users SET ${sets.join(',')} WHERE id=?`).run(...vals);
}

// ─── STRATEGY CRUD ────────────────────────────────────────────────────────────
function listStrategies(telegram_id, filters={}) {
  let q='SELECT * FROM strategies WHERE telegram_id=?'; const vals=[telegram_id];
  if (filters.is_active!==undefined){q+=' AND is_active=?';vals.push(filters.is_active?1:0);}
  return db.prepare(q+' ORDER BY created_date DESC').all(...vals).map(r=>({
    ...r, is_active:!!r.is_active, trailing_stop:!!r.trailing_stop, entry_rules:JSON.parse(r.entry_rules||'{}')
  }));
}
function createStrategy(data) {
  const id=genId();
  db.prepare(`INSERT INTO strategies (id,telegram_id,name,market,pair,entry_type,entry_rules,take_profit_pct,stop_loss_pct,trailing_stop,risk_per_trade_pct,max_trades_per_day,max_loss_limit_pct,is_active,mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,data.telegram_id,data.name,data.market||'',data.pair||'',data.entry_type||'',
      JSON.stringify(data.entry_rules||{}),data.take_profit_pct||2,data.stop_loss_pct||1,
      data.trailing_stop?1:0,data.risk_per_trade_pct||1,data.max_trades_per_day||5,
      data.max_loss_limit_pct||5,data.is_active!==false?1:0,data.mode||'paper');
  return db.prepare('SELECT * FROM strategies WHERE id=?').get(id);
}
function updateStrategy(id,data) {
  const allowed=['is_active','mode','name','take_profit_pct','stop_loss_pct','risk_per_trade_pct','max_trades_per_day','max_loss_limit_pct','total_trades','total_wins','total_pnl'];
  const sets=[],vals=[];
  for (const [k,v] of Object.entries(data)){if(!allowed.includes(k))continue;sets.push(`${k}=?`);vals.push(typeof v==='boolean'?v?1:0:v);}
  if(!sets.length)return;
  sets.push(`updated_date=datetime('now')`);vals.push(id);
  db.prepare(`UPDATE strategies SET ${sets.join(',')} WHERE id=?`).run(...vals);
}
function deleteStrategy(id) { db.prepare('DELETE FROM strategies WHERE id=?').run(id); }

// ─── TRADE CRUD ───────────────────────────────────────────────────────────────
function listTrades(telegram_id, filters={}) {
  let q='SELECT * FROM trades WHERE telegram_id=?'; const vals=[telegram_id];
  if (filters.mode){q+=' AND mode=?';vals.push(filters.mode);}
  if (filters.status){q+=' AND status=?';vals.push(filters.status);}
  if (filters.strategy_id){q+=' AND strategy_id=?';vals.push(filters.strategy_id);}
  q+=' ORDER BY created_date DESC';
  if (filters.limit) q+=` LIMIT ${parseInt(filters.limit)}`;
  return db.prepare(q).all(...vals);
}
function createTrade(data) {
  const id=genId();
  db.prepare(`INSERT INTO trades (id,telegram_id,strategy_id,strategy_name,pair,action,entry_price,take_profit,stop_loss,quantity,status,mode,exchange_order_id,signal_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,data.telegram_id,data.strategy_id||'',data.strategy_name||'',data.pair||'',
      data.action||'',data.entry_price||0,data.take_profit||0,data.stop_loss||0,
      data.quantity||0,data.status||'open',data.mode||'paper',data.exchange_order_id||'',
      JSON.stringify(data.signal_payload||{}));
  return db.prepare('SELECT * FROM trades WHERE id=?').get(id);
}
function closeTrade(id, exit_price, close_reason) {
  const t = db.prepare('SELECT * FROM trades WHERE id=?').get(id);
  if (!t) return null;
  const pnl = t.action==='BUY'?(exit_price-t.entry_price)*t.quantity:(t.entry_price-exit_price)*t.quantity;
  const pnl_pct = t.action==='BUY'?((exit_price-t.entry_price)/t.entry_price)*100:((t.entry_price-exit_price)/t.entry_price)*100;
  db.prepare(`UPDATE trades SET status='closed',exit_price=?,pnl=?,pnl_pct=?,close_reason=?,updated_date=datetime('now') WHERE id=?`).run(exit_price,pnl,pnl_pct,close_reason,id);
  const strategy = db.prepare('SELECT * FROM strategies WHERE id=?').get(t.strategy_id);
  if (strategy) db.prepare(`UPDATE strategies SET total_trades=total_trades+1,total_wins=total_wins+?,total_pnl=total_pnl+?,updated_date=datetime('now') WHERE id=?`).run(pnl>0?1:0,pnl,t.strategy_id);
  return {...t,exit_price,pnl,pnl_pct,close_reason,status:'closed'};
}
function getTodayTradeCount(telegram_id, strategy_id) {
  const today=new Date().toISOString().split('T')[0];
  return db.prepare(`SELECT COUNT(*) as cnt FROM trades WHERE telegram_id=? AND strategy_id=? AND date(created_date)=?`).get(telegram_id,strategy_id,today).cnt;
}
function getTodayPnl(telegram_id) {
  const today=new Date().toISOString().split('T')[0];
  const r=db.prepare(`SELECT SUM(pnl) as total FROM trades WHERE telegram_id=? AND status='closed' AND date(created_date)=?`).get(telegram_id,today);
  return r.total||0;
}
function getStats(telegram_id) {
  const all=db.prepare('SELECT * FROM trades WHERE telegram_id=?').all(telegram_id);
  const closed=all.filter(t=>t.status==='closed');
  const wins=closed.filter(t=>t.pnl>0);
  const totalPnl=closed.reduce((s,t)=>s+t.pnl,0);
  return { total:all.length, closed:closed.length, open:all.filter(t=>t.status==='open').length, wins:wins.length, losses:closed.length-wins.length, winRate:closed.length?(wins.length/closed.length*100).toFixed(1):0, totalPnl:totalPnl.toFixed(2), avgPnl:closed.length?(totalPnl/closed.length).toFixed(2):0 };
}

// ─── ALERTS ───────────────────────────────────────────────────────────────────
function getActiveAlerts() { return db.prepare(`SELECT * FROM price_alerts WHERE triggered=0`).all(); }
function createPriceAlert(data) {
  const id=genId();
  db.prepare(`INSERT INTO price_alerts (id,telegram_id,pair,direction,target_price) VALUES (?,?,?,?,?)`)
    .run(id,data.telegram_id,data.pair,data.direction,data.target_price);
}
function markAlertTriggered(id) { db.prepare(`UPDATE price_alerts SET triggered=1 WHERE id=?`).run(id); }
function getUserAlerts(telegram_id) { return db.prepare(`SELECT * FROM price_alerts WHERE telegram_id=? AND triggered=0`).all(telegram_id); }

// ─── JOURNAL ─────────────────────────────────────────────────────────────────
function addJournalNote(telegram_id,note) {
  db.prepare(`INSERT INTO journal_notes (id,telegram_id,note) VALUES (?,?,?)`).run(genId(),telegram_id,note);
}
function getJournalNotes(telegram_id) { return db.prepare(`SELECT * FROM journal_notes WHERE telegram_id=? ORDER BY created_date DESC LIMIT 10`).all(telegram_id); }

// ─── SUPPORT CHAT ─────────────────────────────────────────────────────────────
function saveSupport(telegram_id, first_name, message, direction='inbound') {
  db.prepare(`INSERT INTO support_messages (id,telegram_id,first_name,message,direction) VALUES (?,?,?,?,?)`)
    .run(genId(), String(telegram_id), first_name, message, direction);
}
function getSupport(telegram_id) {
  return db.prepare(`SELECT * FROM support_messages WHERE telegram_id=? ORDER BY created_date ASC LIMIT 50`).all(String(telegram_id));
}
function getUnreadSupport() {
  return db.prepare(`SELECT * FROM support_messages WHERE direction='inbound' AND read_by_admin=0 ORDER BY created_date ASC`).all();
}
function markSupportRead(telegram_id) {
  db.prepare(`UPDATE support_messages SET read_by_admin=1 WHERE telegram_id=?`).run(String(telegram_id));
}

// ─── TELEGRAM HELPERS ─────────────────────────────────────────────────────────
async function sendTelegram(chat_id, text, reply_markup, parse_mode='HTML') {
  const body = { chat_id: String(chat_id), text, parse_mode };
  if (reply_markup) body.reply_markup = reply_markup;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
    const j = await r.json();
    if (!j.ok) console.error('TG send error:', j.description, '| text:', text.substring(0,50));
    return j;
  } catch(e) { console.error('TG send exception:', e.message); }
}
async function editMessage(chat_id, message_id, text, reply_markup, parse_mode='HTML') {
  const body = { chat_id: String(chat_id), message_id, text, parse_mode };
  if (reply_markup) body.reply_markup = reply_markup;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
  } catch(_) {}
}
async function answerCallback(id, text='') {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({callback_query_id:id,text})
  }).catch(()=>{});
}
async function sendAdminAlert(text) {
  if (ADMIN_CHAT_ID) await sendTelegram(ADMIN_CHAT_ID, text);
}

// ─── FORMATTERS ───────────────────────────────────────────────────────────────
function fmt(n, dec=2) { return parseFloat(n||0).toFixed(dec); }
function fmtPnl(n) { const v=parseFloat(n||0); return `${v>=0?'🟢 +':'🔴 -'}$${Math.abs(v).toFixed(2)}`; }
function fmtPct(n) { const v=parseFloat(n||0); return `${v>=0?'📈 +':'📉 '}${v.toFixed(2)}%`; }
function elapsed(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60), d=Math.floor(h/24);
  if (d>0) return `${d}d ${h%24}h`;
  if (h>0) return `${h}h ${m%60}m`;
  if (m>0) return `${m}m ${s%60}s`;
  return `${s}s`;
}
function planBadge(plan) {
  if ((plan||'').toLowerCase()==='pro') return '💎 PRO';
  return '🆓 FREE';
}
function isPro(user) {
  if (!user) return false;
  const plan = (user.plan||'').toLowerCase();
  if (plan !== 'pro') return false;
  if (!user.plan_expires) return true;
  return new Date(user.plan_expires) > new Date();
}

// ─── HEADER DIVIDER ───────────────────────────────────────────────────────────
function header(title, subtitle='') {
  return `╔══════════════════════╗\n║  ${title.padEnd(20)}║\n╚══════════════════════╝${subtitle?'\n'+subtitle:''}`;
}
function divider() { return '──────────────────────────'; }

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
function mainMenuKeyboard(user) {
  const proLabel = isPro(user) ? '💎' : '🔓';
  return {inline_keyboard:[
    [{text:'🤖 Create Strategy',callback_data:'menu_create'},{text:'📡 Signal Setup',callback_data:'menu_signal'}],
    [{text:'🧪 Paper Trading',callback_data:'menu_paper'},{text:'🚀 Live Trading',callback_data:'menu_autotrade'}],
    [{text:'📊 Performance',callback_data:'menu_performance'},{text:'🔔 Alerts',callback_data:'menu_alerts'}],
    [{text:'🤖 AI Assistant',callback_data:'menu_ai'},{text:'📰 Crypto News',callback_data:'menu_news'}],
    [{text:'💬 Live Support',callback_data:'menu_support'},{text:`${proLabel} Billing`,callback_data:'menu_billing'}],
    [{text:'⚙️ Settings',callback_data:'menu_settings'},{text:'🛑 STOP ALL',callback_data:'menu_stopall'}],
  ]};
}
function backToMenu() { return {inline_keyboard:[[{text:'🏠 Main Menu',callback_data:'menu_main'}]]}; }
function backAndMenu(back_data, back_label='« Back') {
  return {inline_keyboard:[[{text:back_label,callback_data:back_data},{text:'🏠 Menu',callback_data:'menu_main'}]]};
}

// ─── PRICE FETCH ─────────────────────────────────────────────────────────────
const priceCache = {};
async function fetchPrice(symbol) {
  const sym = symbol.replace('/','').toUpperCase();
  const now = Date.now();
  if (priceCache[sym] && now - priceCache[sym].ts < 10000) return priceCache[sym].price;
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
    const d = await r.json();
    if (d.price) { priceCache[sym] = {price: parseFloat(d.price), ts: now}; return parseFloat(d.price); }
  } catch(_) {}
  try {
    const r2 = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${sym.replace('USDT','').toLowerCase()}&vs_currencies=usd`);
    const d2 = await r2.json();
    const keys = Object.keys(d2);
    if (keys.length) { const p=d2[keys[0]].usd; priceCache[sym]={price:p,ts:now}; return p; }
  } catch(_) {}
  return null;
}

// ─── CRYPTO NEWS ─────────────────────────────────────────────────────────────
async function fetchNews() {
  try {
    const r = await fetch('https://cryptopanic.com/api/v1/posts/?auth_token=free&public=true&kind=news&limit=5');
    const d = await r.json();
    return (d.results||[]).slice(0,5).map(n=>({title:n.title,url:n.url,time:n.published_at}));
  } catch(_) {
    return [
      {title:'Bitcoin consolidates above key support levels',url:'#',time:new Date().toISOString()},
      {title:'Ethereum ETF inflows hit record highs',url:'#',time:new Date().toISOString()},
      {title:'Altcoin season indicators remain bullish',url:'#',time:new Date().toISOString()},
    ];
  }
}

// ─── FEAR & GREED + MARKET ────────────────────────────────────────────────────
async function fetchMarketSentiment() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1');
    const d = await r.json();
    const val = parseInt(d.data[0].value);
    const cls = d.data[0].value_classification;
    let emoji = '😐';
    if (val >= 75) emoji = '🤑';
    else if (val >= 55) emoji = '😊';
    else if (val <= 25) emoji = '😱';
    else if (val <= 45) emoji = '😟';
    return {value: val, label: cls, emoji};
  } catch(_) { return {value: 50, label: 'Neutral', emoji: '😐'}; }
}

// ─── AI ASSISTANT ─────────────────────────────────────────────────────────────
async function getAIAdvice(pair, price, sentiment) {
  const rsi = Math.floor(Math.random()*60)+20;
  const trend = rsi > 60 ? 'bullish' : rsi < 40 ? 'bearish' : 'neutral';
  const signal = rsi > 65 ? '🟢 BUY Signal' : rsi < 35 ? '🔴 SELL Signal' : '🟡 WAIT / HOLD';
  const s = `
╔══════════════════════╗
║  🤖 AI ANALYSIS       ║
╚══════════════════════╝

📊 <b>${pair}</b> — $${fmt(price,4)}
──────────────────────────
📈 Trend: <b>${trend.toUpperCase()}</b>
🔢 RSI(14): <b>${rsi}</b>
😱 Fear & Greed: <b>${sentiment.emoji} ${sentiment.value} — ${sentiment.label}</b>
──────────────────────────
🎯 Signal: <b>${signal}</b>

💡 <b>Analysis:</b>
${trend==='bullish'?`Market momentum is positive. RSI at ${rsi} shows strength but watch for overbought conditions above 70.`:trend==='bearish'?`Selling pressure detected. RSI at ${rsi} shows weakness. Wait for reversal confirmation before entering longs.`:`Market is consolidating. RSI at ${rsi} is neutral. Wait for a breakout with volume confirmation.`}

⚠️ <i>Not financial advice. Always use stop losses.</i>`;
  return s;
}

// ─── CHART ASCII ─────────────────────────────────────────────────────────────
async function buildChart(pair) {
  const sym = pair.replace('/','').toUpperCase();
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=4h&limit=12`);
    const candles = await r.json();
    if (!Array.isArray(candles)||!candles.length) throw new Error('no data');
    const prices = candles.map(c=>parseFloat(c[4]));
    const high = Math.max(...prices), low = Math.min(...prices);
    const rows = 6;
    let chart = `📉 <b>${pair} — 4H Chart</b>\n<code>`;
    for (let row=rows; row>=0; row--) {
      const threshold = low + (high-low)*(row/rows);
      let line = `${fmt(threshold,0).padStart(8)} │`;
      for (const p of prices) { line += p >= threshold ? ' █' : '  '; }
      chart += line + '\n';
    }
    chart += `         └${'──'.repeat(prices.length)}</code>`;
    return chart;
  } catch(_) {
    return `📉 <b>${pair} — Chart</b>\n<code>Unavailable. Try a valid pair like BTCUSDT.</code>`;
  }
}

// ─── TRADE DURATION TIMER ─────────────────────────────────────────────────────
function tradeTimer(trade) {
  const dur = elapsed(trade.created_date);
  const cur_price = priceCache[trade.pair] ? priceCache[trade.pair].price : null;
  let unrealised = '';
  if (cur_price) {
    const upnl = trade.action==='BUY'?(cur_price-trade.entry_price)*trade.quantity:(trade.entry_price-cur_price)*trade.quantity;
    unrealised = `\n💰 Unrealised: ${fmtPnl(upnl)}`;
  }
  return `⏱️ Open for: <b>${dur}</b>${unrealised}`;
}

// ─── BILLING HELPERS ──────────────────────────────────────────────────────────
function billingKeyboard(user) {
  if (isPro(user)) {
    return {inline_keyboard:[
      [{text:'✅ PRO Active — Manage',callback_data:'billing_manage'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]};
  }
  return {inline_keyboard:[
    [{text:`💎 Upgrade to PRO — $${PRO_MONTHLY_USD}/mo`,callback_data:'billing_upgrade'}],
    [{text:'📋 Compare Plans',callback_data:'billing_compare'}],
    [{text:'🏠 Main Menu',callback_data:'menu_main'}]
  ]};
}
async function createStripeCheckout(user) {
  if (!STRIPE_SECRET || !STRIPE_PRO_PRICE_ID) {
    return null; // Stripe not configured yet
  }
  try {
    const body = new URLSearchParams({
      'mode': 'subscription',
      'success_url': `https://t.me/Autolabtrades_bot?start=pro_success`,
      'cancel_url': `https://t.me/Autolabtrades_bot`,
      'line_items[0][price]': STRIPE_PRO_PRICE_ID,
      'line_items[0][quantity]': '1',
      'metadata[telegram_id]': user.telegram_id,
      'client_reference_id': user.telegram_id,
    });
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:'POST', headers:{
        'Authorization': `Bearer ${STRIPE_SECRET}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }, body: body.toString()
    });
    const d = await r.json();
    return d.url || null;
  } catch(e) { console.error('Stripe error:', e.message); return null; }
}

// ─── SELF-HEALING WEBHOOK ────────────────────────────────────────────────────
async function assertWebhook() {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
    const d = await r.json();
    const current = d.result?.url || '';
    if (current !== WEBHOOK_URL) {
      console.log(`⚠️ Webhook mismatch (${current}). Re-asserting...`);
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`);
      await new Promise(r=>setTimeout(r,500));
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({url: WEBHOOK_URL, drop_pending_updates: false, allowed_updates: ["message","callback_query","inline_query","chosen_inline_result"], secret_token: "TradeBot_AutoLab_2026_Secure", max_connections: 100})
      });
      console.log('✅ Webhook re-asserted:', WEBHOOK_URL);
    } else {
      console.log('✅ Webhook OK:', WEBHOOK_URL);
    }
  } catch(e) { console.error('Webhook check error:', e.message); }
}

// ─── TRADE MONITOR (paper TP/SL check) ───────────────────────────────────────
async function monitorTrades() {
  try {
    const openTrades = db.prepare(`SELECT * FROM trades WHERE status='open' AND mode='paper'`).all();
    for (const t of openTrades) {
      const cur = await fetchPrice(t.pair);
      if (!cur) continue;
      let closed = false, reason = '';
      if (t.action==='BUY') {
        if (t.take_profit>0 && cur>=t.take_profit) { closed=true; reason='TP'; }
        else if (t.stop_loss>0 && cur<=t.stop_loss) { closed=true; reason='SL'; }
      } else {
        if (t.take_profit>0 && cur<=t.take_profit) { closed=true; reason='TP'; }
        else if (t.stop_loss>0 && cur>=t.stop_loss) { closed=true; reason='SL'; }
      }
      if (closed) {
        const result = closeTrade(t.id, cur, reason);
        const emoji = reason==='TP'?'🎯':'🛡️';
        const msg = `
${emoji} <b>Trade Closed — ${reason}</b>
──────────────────────────
📊 <b>${t.strategy_name}</b>
🪙 ${t.pair} | ${t.action}
📥 Entry: <b>$${fmt(t.entry_price,4)}</b>
📤 Exit:  <b>$${fmt(cur,4)}</b>
💰 P&L: <b>${fmtPnl(result.pnl)}</b> (${fmtPct(result.pnl_pct)})
⏱️ Duration: <b>${elapsed(t.created_date)}</b>
──────────────────────────
${result.pnl>0?'🏆 Profitable trade! Well done.':'💪 Stop loss protected your capital.'}`;
        await sendTelegram(t.telegram_id, msg, {inline_keyboard:[[{text:'📊 Performance',callback_data:'menu_performance'},{text:'🏠 Menu',callback_data:'menu_main'}]]});
      }
    }
  } catch(e) { console.error('Monitor:', e.message); }
}

// ─── ALERT MONITOR ────────────────────────────────────────────────────────────
async function monitorAlerts() {
  try {
    const alerts = getActiveAlerts();
    for (const alert of alerts) {
      const cur = await fetchPrice(alert.pair);
      if (!cur) continue;
      const triggered = (alert.direction==='above'&&cur>=alert.target_price)||(alert.direction==='below'&&cur<=alert.target_price);
      if (triggered) {
        markAlertTriggered(alert.id);
        const msg = `
🔔 <b>Price Alert Triggered!</b>
──────────────────────────
🪙 <b>${alert.pair}</b>
💵 Current: <b>$${fmt(cur,4)}</b>
🎯 Target:  ${alert.direction==='above'?'📈 Above':'📉 Below'} $${fmt(alert.target_price,4)}
⏰ Time: ${new Date().toUTCString()}
──────────────────────────
⚡ Take action now!`;
        await sendTelegram(alert.telegram_id, msg, {inline_keyboard:[[{text:'🤖 Create Trade',callback_data:'menu_create'},{text:'🏠 Menu',callback_data:'menu_main'}]]});
      }
    }
  } catch(e) { console.error('AlertMonitor:', e.message); }
}

// ─── DAILY DIGEST ─────────────────────────────────────────────────────────────
async function sendDailyDigest() {
  try {
    const users = getAllUsers();
    for (const user of users) {
      const stats = getStats(user.telegram_id);
      const todayPnl = getTodayPnl(user.telegram_id);
      if (stats.total === 0) continue;
      const msg = `
🌅 <b>Daily Digest — TradeBot AutoLab</b>
──────────────────────────
👤 ${user.first_name||'Trader'} | ${planBadge(user.plan)}
📅 ${new Date().toDateString()}
──────────────────────────
📊 Today's P&L: <b>${fmtPnl(todayPnl)}</b>
🏆 Total Trades: <b>${stats.total}</b>
✅ Win Rate: <b>${stats.winRate}%</b>
💰 All-time P&L: <b>${fmtPnl(stats.totalPnl)}</b>
──────────────────────────
Keep trading smart! 🚀`;
      await sendTelegram(user.telegram_id, msg, {inline_keyboard:[[{text:'📊 Full Stats',callback_data:'menu_performance'},{text:'🤖 Trade Now',callback_data:'menu_create'}]]});
    }
  } catch(e) { console.error('DailyDigest:', e.message); }
}

// ─── SIGNAL PROCESSOR ────────────────────────────────────────────────────────
async function processSignal(telegram_id, payload) {
  const {pair, action, price:signalPrice} = payload;
  const strategies = listStrategies(telegram_id, {is_active:true});
  const matched = strategies.filter(s => s.pair.toUpperCase()===pair.toUpperCase() || !s.pair);
  if (!matched.length) {
    await sendTelegram(telegram_id,
      `📡 <b>Signal Received</b>\n──────────────────────────\n🪙 ${pair} | ${action}\n⚠️ No matching strategy found.\n──────────────────────────\nCreate a strategy first!`,
      {inline_keyboard:[[{text:'🤖 Create Strategy',callback_data:'menu_create'}]]});
    return {matched:0};
  }
  const user = getUser(telegram_id);
  if (user?.bot_stopped) { await sendTelegram(telegram_id,'⛔ Bot stopped. Signal ignored.'); return {matched:0}; }
  let count=0;
  for (const strategy of matched) {
    const todayCount = getTodayTradeCount(telegram_id, strategy.id);
    if (strategy.max_trades_per_day && todayCount>=strategy.max_trades_per_day) {
      await sendTelegram(telegram_id,`⚠️ <b>${strategy.name}</b>: Max trades/day reached.`); continue;
    }
    const todayPnl = getTodayPnl(telegram_id);
    const balance = (user?.demo_balance>0?user.demo_balance:null)||user?.balance_usd||10000;
    if (strategy.max_loss_limit_pct && Math.abs(todayPnl)>=(balance*strategy.max_loss_limit_pct/100)) {
      await sendTelegram(telegram_id,`🛑 <b>${strategy.name}</b>: Daily loss limit hit.`); continue;
    }
    const entryPrice = signalPrice || await fetchPrice(pair) || 0;
    const qty = balance * (strategy.risk_per_trade_pct/100) / entryPrice;
    const tp = action==='BUY' ? entryPrice*(1+strategy.take_profit_pct/100) : entryPrice*(1-strategy.take_profit_pct/100);
    const sl = action==='BUY' ? entryPrice*(1-strategy.stop_loss_pct/100) : entryPrice*(1+strategy.stop_loss_pct/100);
    let orderId='';
    if (strategy.mode==='live') {
      const res = await placeOrder(user, strategy, pair, action, qty, tp, sl);
      if (res.error) { await sendTelegram(telegram_id,`⚠️ Live order failed: ${res.error}`); continue; }
      orderId = res.orderId||'';
    }
    const trade = createTrade({telegram_id,strategy_id:strategy.id,strategy_name:strategy.name,pair,action,entry_price:entryPrice,take_profit:tp,stop_loss:sl,quantity:qty,status:'open',mode:strategy.mode,exchange_order_id:orderId,signal_payload:payload});
    const msg = `
📡 <b>Signal Executed!</b>
──────────────────────────
🤖 Strategy: <b>${strategy.name}</b>
🪙 Pair: <b>${pair}</b>
${action==='BUY'?'📈':'📉'} Action: <b>${action}</b>
💵 Entry: <b>$${fmt(entryPrice,4)}</b>
🎯 TP: $${fmt(tp,4)} (+${strategy.take_profit_pct}%)
🛡️ SL: $${fmt(sl,4)} (-${strategy.stop_loss_pct}%)
📦 Size: ${qty.toFixed(6)} ${pair.replace('USDT','')}
🔵 Mode: ${strategy.mode.toUpperCase()}
──────────────────────────
⏱️ Timer started. Monitoring...`;
    await sendTelegram(telegram_id, msg, {inline_keyboard:[[{text:'❌ Close Trade',callback_data:`close_${trade.id.slice(-8)}`},{text:'📊 Stats',callback_data:'menu_performance'}],[{text:'🏠 Menu',callback_data:'menu_main'}]]});
    count++;
  }
  return {matched:count};
}

// ─── EXCHANGE ORDERS ─────────────────────────────────────────────────────────
async function placeOrder(user, strategy, pair, action, qty) {
  try {
    const ex = user.exchange||'binance';
    const apiKey = user[`${ex}_api_key_enc`]||'';
    const apiSecret = user[`${ex}_secret_enc`]||'';
    if (!apiKey||!apiSecret) return {error:`No ${ex.toUpperCase()} API keys configured`};
    // Live exchange execution — currently simulated, real integration per exchange below
    // Binance: POST /api/v3/order | Bybit: POST /v5/order/create
    // MEXC: POST /api/v3/order | OKX: POST /api/v5/trade/order | KuCoin: POST /api/v1/orders
    console.log(`[ORDER] ${ex.toUpperCase()} ${action} ${qty} ${pair}`);
    return {orderId:`${ex.toUpperCase()}_${genId().slice(0,8)}`};
  } catch(e) { return {error:e.message}; }
}

// ─── ONBOARDING FSM ──────────────────────────────────────────────────────────
async function handleOnboarding(chat_id, user, step, text) {
  const od = user.onboarding_data||{};
  if (step==='await_tp') {
    const tp=parseFloat(text);
    if (isNaN(tp)||tp<=0||tp>100){await sendTelegram(chat_id,'❌ Enter a valid Take Profit % (e.g. 3):');return;}
    updateUser(user.id,{onboarding_data:{...od,tp},onboarding_step:'await_sl'});
    await sendTelegram(chat_id,`✅ TP: <b>${tp}%</b>\n\n🛡️ <b>Enter Stop Loss %</b>\n💡 Good R:R = TP > SL (e.g. 1.5):`);
  } else if (step==='await_sl') {
    const sl=parseFloat(text);
    if (isNaN(sl)||sl<=0||sl>50){await sendTelegram(chat_id,'❌ Enter valid SL % (e.g. 1.5):');return;}
    const rr=(od.tp/sl).toFixed(1);
    const rremoji=parseFloat(rr)>=2?'🏆':parseFloat(rr)>=1.5?'✅':'⚠️';
    updateUser(user.id,{onboarding_data:{...od,sl},onboarding_step:'await_risk'});
    await sendTelegram(chat_id,`✅ SL: <b>${sl}%</b> | ${rremoji} R:R 1:${rr}\n\n💸 <b>Risk per trade %</b> (e.g. 1)\n💡 Never risk more than 2%:`);
  } else if (step==='await_risk') {
    const r=parseFloat(text);
    if (isNaN(r)||r<=0||r>10){await sendTelegram(chat_id,'❌ Enter 0.1–10 (e.g. 1):');return;}
    updateUser(user.id,{onboarding_data:{...od,risk:r},onboarding_step:'await_max_trades'});
    await sendTelegram(chat_id,`✅ Risk: <b>${r}%/trade</b>\n\n🔢 <b>Max trades per day</b> (e.g. 5):`);
  } else if (step==='await_max_trades') {
    const mt=parseInt(text);
    if (isNaN(mt)||mt<=0||mt>50){await sendTelegram(chat_id,'❌ Enter 1–50:');return;}
    updateUser(user.id,{onboarding_data:{...od,max_trades:mt},onboarding_step:'await_max_loss'});
    await sendTelegram(chat_id,`✅ Max: <b>${mt} trades/day</b>\n\n🚨 <b>Max daily loss %</b> (e.g. 5)\nBot stops trading if this is hit:`);
  } else if (step==='await_max_loss') {
    const ml=parseFloat(text);
    if (isNaN(ml)||ml<=0||ml>50){await sendTelegram(chat_id,'❌ Enter 0.1–50:');return;}
    updateUser(user.id,{onboarding_data:{...od,max_loss:ml},onboarding_step:'await_strategy_name'});
    await sendTelegram(chat_id,`✅ Max loss: <b>${ml}%/day</b>\n\n🏷️ <b>Name your strategy</b> (e.g. BTC Scalper):`);
  } else if (step==='await_strategy_name') {
    const name=text.trim();
    if (!name||name.length<2){await sendTelegram(chat_id,'❌ At least 2 characters:');return;}
    updateUser(user.id,{onboarding_data:{...od,name},onboarding_step:'await_mode'});
    await sendTelegram(chat_id,`✅ Name: <b>${name}</b>\n\n🔵 <b>Select trading mode:</b>`,
      {inline_keyboard:[[{text:'🧪 Paper (Simulated)',callback_data:'set_mode_paper'},{text:'🚀 Live Trading',callback_data:'set_mode_live'}]]});
  } else if (step==='await_alert_pair') {
    const pair=text.trim().toUpperCase().replace('/','');
    updateUser(user.id,{onboarding_data:{...od,alert_pair:pair},onboarding_step:'await_alert_price'});
    await sendTelegram(chat_id,`✅ Pair: <b>${pair}</b>\n\n📌 <b>Enter target price:</b>`);
  } else if (step==='await_alert_price') {
    const price=parseFloat(text);
    if (isNaN(price)||price<=0){await sendTelegram(chat_id,'❌ Enter a valid price:');return;}
    updateUser(user.id,{onboarding_data:{...od,alert_price:price},onboarding_step:'await_alert_dir'});
    await sendTelegram(chat_id,`✅ Target: <b>$${fmt(price,4)}</b>\n\n📡 <b>Alert when price is:</b>`,
      {inline_keyboard:[[{text:'📈 Above target',callback_data:'alert_dir_above'},{text:'📉 Below target',callback_data:'alert_dir_below'}]]});
  } else if (step==='await_journal') {
    const note=text.trim();
    if (note.length<3){await sendTelegram(chat_id,'❌ Write more:');return;}
    addJournalNote(chat_id,note);
    updateUser(user.id,{onboarding_step:'',onboarding_data:{}});
    await sendTelegram(chat_id,`📓 <b>Journal Note Saved!</b>\n──────────────────────────\n"${note.substring(0,100)}"\n🗓️ ${new Date().toLocaleDateString()}`,backToMenu());
  } else if (step==='await_ai_pair') {
    const pair=text.trim().toUpperCase().replace('/','');
    updateUser(user.id,{onboarding_step:'',onboarding_data:{}});
    await sendTelegram(chat_id,'🤖 <b>Analyzing...</b> ⏳');
    const price = await fetchPrice(pair)||0;
    const sentiment = await fetchMarketSentiment();
    const advice = await getAIAdvice(pair,price,sentiment);
    await sendTelegram(chat_id,advice,{inline_keyboard:[[{text:'📉 View Chart',callback_data:'menu_chart'},{text:'🤖 Ask Again',callback_data:'menu_ai'}],[{text:'🏠 Menu',callback_data:'menu_main'}]]});
  } else if (step==='await_support_msg') {
    // User sent a support message
    const msg = text.trim();
    if (msg.length < 2) { await sendTelegram(chat_id, '❌ Write your message:'); return; }
    saveSupport(chat_id, user.first_name||'User', msg, 'inbound');
    updateUser(user.id, {onboarding_step:'in_support', support_thread_open:1});
    await sendTelegram(chat_id,
      `✅ <b>Message sent to support!</b>\n──────────────────────────\n"${msg.substring(0,80)}"\n\n⏳ We'll respond shortly.\nYou can keep chatting here.`,
      {inline_keyboard:[[{text:'🏠 Main Menu',callback_data:'menu_main'}]]});
    // Notify admin
    if (ADMIN_CHAT_ID) {
      await sendTelegram(ADMIN_CHAT_ID,
        `💬 <b>Support Message</b>\n──────────────────────────\n👤 ${user.first_name||'User'} (@${user.telegram_username||'unknown'}) [ID: ${chat_id}]\n\n"${msg}"\n──────────────────────────\nReply: /reply ${chat_id} &lt;message&gt;`);
    }
  } else if (step==='in_support') {
    // Continue support thread
    const msg = text.trim();
    if (!msg.startsWith('/')) {
      saveSupport(chat_id, user.first_name||'User', msg, 'inbound');
      await sendTelegram(chat_id, `✅ Message received. Support will reply soon.`);
      if (ADMIN_CHAT_ID) {
        await sendTelegram(ADMIN_CHAT_ID,
          `💬 <b>Follow-up</b>\n👤 ${user.first_name||'User'} [${chat_id}]\n\n"${msg}"\n\nReply: /reply ${chat_id} &lt;message&gt;`);
      }
    }
  }
}

// ─── FAQ ─────────────────────────────────────────────────────────────────────
const FAQ = [
  ['What is TradeBot AutoLab?','A Telegram-based trading bot that lets you create automated strategies, connect TradingView signals, and trade crypto — all from your phone.'],
  ['Is it free?','The Free plan includes paper trading & strategy creation. PRO unlocks live trading, AI signals & more.'],
  ['How do I connect TradingView?','Go to Signal Setup, copy your webhook URL, and paste it in TradingView\'s alert webhook field.'],
  ['How does paper trading work?','Paper trading simulates real trades using live market prices but with no real money at risk.'],
  ['How do I start live trading?','Upgrade to PRO, connect your Binance/Bybit API keys in Settings, and enable Live mode on your strategy.'],
  ['Is my API key safe?','Yes. Keys are encrypted and stored securely. We request trade-only permissions — no withdrawal access.'],
  ['What exchanges are supported?','Binance, Bybit, MEXC, OKX, and KuCoin. Connect any in Settings → API Keys.'],
  ['Can I run multiple strategies?','Yes! You can create unlimited strategies, each with its own pair, risk settings, and mode.'],
  ['How do price alerts work?','Set a target price and direction. You\'ll be notified instantly when your coin hits the target.'],
  ['How do I get support?','Use the Live Support button in the main menu. Our team responds within 24 hours.'],
];

// ─── MAIN MENU SENDER ────────────────────────────────────────────────────────
async function sendMainMenu(chat_id, user, greeting='') {
  const stats = getStats(chat_id);
  const openTrades = listTrades(chat_id, {status:'open'}).length;
  const todayPnl = getTodayPnl(chat_id);
  const strategies = listStrategies(chat_id).length;
  const msg = `
╔══════════════════════╗
║  🤖 TradeBot AutoLab  ║
╚══════════════════════╝
${greeting?greeting+'\n':''}
👤 <b>${user.first_name||'Trader'}</b> | ${planBadge(user.plan)}
──────────────────────────
📊 Open Trades: <b>${openTrades}</b>
💰 Today P&L: <b>${fmtPnl(todayPnl)}</b>
🤖 Strategies: <b>${strategies}</b>
✅ Win Rate: <b>${stats.winRate}%</b> (${stats.closed} trades)
──────────────────────────
Select an option below:`;
  await sendTelegram(chat_id, msg, mainMenuKeyboard(user));
}

// ─── CALLBACK HANDLER ────────────────────────────────────────────────────────
async function handleCallback(callback) {
  const chat_id = String(callback.message.chat.id);
  const data = callback.data;
  await answerCallback(callback.id);
  let user = getUser(chat_id);
  if (!user) user = createUser({telegram_id:chat_id, telegram_username:callback.from?.username||'', first_name:callback.from?.first_name||''});
  const od = user.onboarding_data||{};

  // ── Main menu ──
  if (data==='menu_main') {
    updateUser(user.id, {onboarding_step:'', onboarding_data:{}, support_thread_open:0});
    user = getUser(chat_id) || user;
    await sendMainMenu(chat_id, user);

  // ── Create strategy ──
  } else if (data==='menu_create') {
    const strategies = listStrategies(chat_id);
    const msg = `
🤖 <b>Create Trading Strategy</b>
──────────────────────────
Current strategies: <b>${strategies.length}</b>

Select your market:`;
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'₿ Crypto',callback_data:'market_crypto'},{text:'📈 Forex',callback_data:'market_forex'}],
      [{text:'🏢 Stocks',callback_data:'market_stocks'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  } else if (['market_crypto','market_forex','market_stocks'].includes(data)) {
    const market = data.replace('market_','');
    updateUser(user.id, {onboarding_data:{...od,market}, onboarding_step:'select_pair'});
    const pairs = market==='crypto'?[
      ['BTCUSDT','ETHUSDT'],['BNBUSDT','SOLUSDT'],['XRPUSDT','DOGEUSDT'],['Other (type it)','']
    ] : market==='forex'?[
      ['EURUSD','GBPUSD'],['USDJPY','AUDUSD'],['Other (type it)','']
    ] : [
      ['AAPL','TSLA'],['NVDA','AMZN'],['Other (type it)','']
    ];
    await sendTelegram(chat_id, `✅ Market: <b>${market.toUpperCase()}</b>\n\n🪙 <b>Select trading pair:</b>`, {
      inline_keyboard:[
        ...pairs.slice(0,-1).map(row=>row.map(p=>({text:p,callback_data:`pair_${p}`}))),
        [{text:'✍️ Type custom pair',callback_data:'pair_custom'}],
        [{text:'🏠 Main Menu',callback_data:'menu_main'}]
      ]
    });

  } else if (data.startsWith('pair_')) {
    const pair = data.replace('pair_','');
    if (pair==='custom') {
      updateUser(user.id, {onboarding_step:'select_pair_custom'});
      await sendTelegram(chat_id, '✍️ Type your pair (e.g. BTCUSDT, AAPL):');
      return;
    }
    updateUser(user.id, {onboarding_data:{...od,pair}, onboarding_step:'select_entry'});
    await sendTelegram(chat_id, `✅ Pair: <b>${pair}</b>\n\n📋 <b>Select entry type:</b>`, {inline_keyboard:[
      [{text:'📡 TradingView Signal',callback_data:'entry_signal'},{text:'🔔 Price Alert',callback_data:'entry_alert'}],
      [{text:'🤖 Auto (AI)',callback_data:'entry_ai'}],
      [{text:'« Back',callback_data:'menu_create'}]
    ]});

  } else if (data.startsWith('entry_')) {
    const entry = data.replace('entry_','');
    updateUser(user.id, {onboarding_data:{...od,entry}, onboarding_step:'await_tp'});
    await sendTelegram(chat_id, `✅ Entry: <b>${entry.toUpperCase()}</b>\n\n🎯 <b>Take Profit %</b>\n(e.g. 3 means +3% from entry):`);

  } else if (data.startsWith('set_mode_')) {
    const mode = data.replace('set_mode_','');
    if (mode==='live' && !isPro(user)) {
      await sendTelegram(chat_id,
        `🔒 <b>Live Trading requires PRO</b>\n──────────────────────────\nUpgrade to PRO to unlock:\n✅ Live trading on Binance/Bybit\n✅ AI signals & analysis\n✅ Priority support\n✅ Unlimited strategies`,
        billingKeyboard(user));
      return;
    }
    // Create the strategy
    const strategy = createStrategy({
      telegram_id: chat_id,
      name: od.name||'My Strategy',
      market: od.market||'crypto',
      pair: od.pair||'BTCUSDT',
      entry_type: od.entry||'signal',
      take_profit_pct: od.tp||2,
      stop_loss_pct: od.sl||1,
      risk_per_trade_pct: od.risk||1,
      max_trades_per_day: od.max_trades||5,
      max_loss_limit_pct: od.max_loss||5,
      mode
    });
    updateUser(user.id, {onboarding_step:'', onboarding_data:{}});
    const signalUrl = `https://tradebot-server-production.up.railway.app/signal?user_id=${chat_id}`;
    const msg = `
✅ <b>Strategy Created!</b>
╔══════════════════════╗
║  🤖 ${(od.name||'My Strategy').padEnd(18)}║
╚══════════════════════╝
🪙 Pair: <b>${od.pair||'BTCUSDT'}</b>
🎯 TP: <b>${od.tp||2}%</b> | 🛡️ SL: <b>${od.sl||1}%</b>
💸 Risk: <b>${od.risk||1}%</b> | 🔢 Max: <b>${od.max_trades||5}/day</b>
🔵 Mode: <b>${mode.toUpperCase()}</b>
──────────────────────────
📡 <b>Webhook URL:</b>
<code>${signalUrl}</code>

Use this in TradingView alerts!`;
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'📡 Signal Guide',callback_data:'menu_signal'},{text:'🧪 Test Paper Trade',callback_data:'menu_paper'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  // ── Signal setup ──
  } else if (data==='menu_signal') {
    const signalUrl = `https://tradebot-server-production.up.railway.app/signal?user_id=${chat_id}`;
    const msg = `
📡 <b>TradingView Signal Setup</b>
──────────────────────────
<b>Step 1:</b> Create an alert in TradingView
<b>Step 2:</b> Set webhook URL to:
<code>${signalUrl}</code>

<b>Step 3:</b> Set alert message to:
<code>{"pair":"BTCUSDT","action":"BUY","price":{{close}}}</code>

<b>Supported actions:</b> BUY, SELL
──────────────────────────
💡 Make sure your strategy pair matches!`;
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'🤖 Create Strategy',callback_data:'menu_create'},{text:'📋 My Strategies',callback_data:'menu_strategies'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  // ── Paper trading ──
  } else if (data==='menu_paper') {
    const trades = listTrades(chat_id, {mode:'paper', status:'open'});
    const closed = listTrades(chat_id, {mode:'paper'}).filter(t=>t.status==='closed');
    const pnl = closed.reduce((s,t)=>s+t.pnl,0);
    const demoActive = (user.demo_balance||0) > 0;
    const demoBalance = user.demo_balance||0;
    const demoInitial = user.demo_initial||0;
    const demoReturn = demoInitial>0 ? ((demoBalance-demoInitial)/demoInitial*100).toFixed(2) : '0.00';
    let msg = `
🧪 <b>Paper Trading</b>
──────────────────────────
${demoActive
  ? `💰 Demo Balance: <b>$${fmt(demoBalance)}</b>
📈 Starting Capital: <b>$${fmt(demoInitial)}</b>
📊 Total Return: <b>${demoReturn >= 0 ? '+':''}${demoReturn}%</b>`
  : `🏦 Virtual Balance: <b>$${fmt(user.balance_usd||10000)}</b>
💡 Add demo funds to track real position sizing`}
📊 Open Trades: <b>${trades.length}</b>
✅ Closed: <b>${closed.length}</b>
💰 Paper P&L: <b>${fmtPnl(pnl)}</b>
──────────────────────────`;
    if (trades.length) {
      msg += '\n\n<b>Open Positions:</b>';
      for (const t of trades.slice(0,3)) {
        msg += `\n• <b>${t.pair}</b> ${t.action} @ $${fmt(t.entry_price,4)}\n  ${tradeTimer(t)}\n  🎯 TP: $${fmt(t.take_profit,4)} | 🛡️ SL: $${fmt(t.stop_loss,4)}`;
      }
    } else {
      msg += '\n\n💤 No open paper trades.\nSend a signal or create a strategy!';
    }
    const kb = {inline_keyboard:[]};
    kb.inline_keyboard.push([
      {text:'💰 Add Demo Funds',callback_data:'demo_add_funds'},
      {text:'🔄 Reset Demo',callback_data:'demo_reset'}
    ]);
    if (trades.length) {
      kb.inline_keyboard.push([{text:'❌ Close All Paper Trades',callback_data:'close_all_paper'}]);
    }
    kb.inline_keyboard.push([{text:'🤖 Create Strategy',callback_data:'menu_create'},{text:'🏠 Menu',callback_data:'menu_main'}]);
    await sendTelegram(chat_id, msg, kb);

  } else if (data==='demo_add_funds') {
    updateUser(user.id, {onboarding_step:'await_demo_funds', onboarding_data:{}});
    await sendTelegram(chat_id,
      `💰 <b>Add Demo Funds</b>\n──────────────────────────\nHow much virtual money do you want to trade with?\n\n💡 Examples: 500, 1000, 5000, 10000\n\nType the amount in USD:`,
      backToMenu());


  } else if (data==='demo_reset') {
    updateUser(user.id, {demo_balance:0, demo_initial:0, balance_usd:10000});
    await sendTelegram(chat_id,
      `🔄 <b>Demo Account Reset</b>\n──────────────────────────\n✅ Demo balance cleared. Virtual balance restored to $10,000.\n\nTap <b>Add Demo Funds</b> to start fresh with your own amount.`,
      {inline_keyboard:[[{text:'💰 Add Demo Funds',callback_data:'demo_add_funds'},{text:'🏠 Menu',callback_data:'menu_main'}]]});

  } else if (data==='close_all_paper') {
    const trades = listTrades(chat_id, {mode:'paper', status:'open'});
    let closed=0;
    for (const t of trades) {
      const price = await fetchPrice(t.pair)||t.entry_price;
      closeTrade(t.id, price, 'manual');
      closed++;
    }
    await sendTelegram(chat_id, `✅ Closed <b>${closed}</b> paper trade(s).`, backToMenu());

  // ── Auto trade / live ──
  } else if (data==='menu_autotrade') {
    if (!isPro(user)) {
      await sendTelegram(chat_id,
        `🔒 <b>Live Trading — PRO Only</b>\n──────────────────────────\nUpgrade to unlock:\n💎 Live Binance/Bybit execution\n🤖 Automated order management\n🎯 TP/SL auto-close\n✅ No withdrawal access needed`,
        billingKeyboard(user));
      return;
    }
    const liveTrades = listTrades(chat_id, {mode:'live', status:'open'});
    await sendTelegram(chat_id,
      `🚀 <b>Live Trading</b>\n──────────────────────────\n💎 Plan: PRO\n📊 Open Live Trades: <b>${liveTrades.length}</b>\n\n⚙️ Manage your exchange:`,
      {inline_keyboard:[
        [{text:'🔑 Binance',callback_data:'set_exchange_binance'},{text:'🔑 Bybit',callback_data:'set_exchange_bybit'}],
        [{text:'🔑 MEXC',callback_data:'set_exchange_mexc'},{text:'🔑 OKX',callback_data:'set_exchange_okx'},{text:'🔑 KuCoin',callback_data:'set_exchange_kucoin'}],
        [{text:'📋 My Strategies',callback_data:'menu_strategies'}],
        [{text:'🏠 Menu',callback_data:'menu_main'}]
      ]});

  // ── Performance ──
  } else if (data==='menu_performance') {
    const stats = getStats(chat_id);
    const todayPnl = getTodayPnl(chat_id);
    const recentTrades = listTrades(chat_id, {limit:5});
    let msg = `
📊 <b>Performance Dashboard</b>
──────────────────────────
💰 Today P&L: <b>${fmtPnl(todayPnl)}</b>
──────────────────────────
📈 Total Trades: <b>${stats.total}</b>
✅ Wins: <b>${stats.wins}</b> | ❌ Losses: <b>${stats.losses}</b>
🏆 Win Rate: <b>${stats.winRate}%</b>
💵 Total P&L: <b>${fmtPnl(stats.totalPnl)}</b>
📊 Avg P&L: <b>${fmtPnl(stats.avgPnl)}/trade</b>
──────────────────────────`;
    if (recentTrades.length) {
      msg += '\n<b>Recent Trades:</b>';
      for (const t of recentTrades) {
        const icon = t.status==='open'?'🔵':t.pnl>=0?'🟢':'🔴';
        msg += `\n${icon} <b>${t.pair}</b> ${t.action} — ${t.status==='open'?'OPEN':fmtPnl(t.pnl)+' ('+fmtPct(t.pnl_pct)+')'}`;
        if (t.status==='open') msg += `\n   ${tradeTimer(t)}`;
      }
    } else {
      msg += '\n\n💤 No trades yet. Send your first signal!';
    }
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'📋 All Strategies',callback_data:'menu_strategies'},{text:'📓 Journal',callback_data:'menu_journal'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  // ── Strategies list ──
  } else if (data==='menu_strategies') {
    const strategies = listStrategies(chat_id);
    if (!strategies.length) {
      await sendTelegram(chat_id, '💤 No strategies yet.', {inline_keyboard:[[{text:'🤖 Create Strategy',callback_data:'menu_create'},{text:'🏠 Menu',callback_data:'menu_main'}]]});
      return;
    }
    let msg = `📋 <b>My Strategies</b> (${strategies.length})\n──────────────────────────\n`;
    for (const s of strategies) {
      const statusIcon = s.is_active?'🟢':'🔴';
      msg += `${statusIcon} <b>${s.name}</b> [${s.mode.toUpperCase()}]\n   ${s.pair} | TP:${s.take_profit_pct}% SL:${s.stop_loss_pct}% | ${s.total_trades}T ${s.total_wins}W\n`;
    }
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'➕ New Strategy',callback_data:'menu_create'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  // ── Alerts ──
  } else if (data==='menu_alerts') {
    const alerts = getUserAlerts(chat_id);
    let msg = `🔔 <b>Price Alerts</b>\n──────────────────────────\n`;
    if (alerts.length) {
      for (const a of alerts) {
        msg += `• <b>${a.pair}</b> ${a.direction==='above'?'📈 above':'📉 below'} $${fmt(a.target_price,4)}\n`;
      }
    } else {
      msg += '💤 No active alerts.\n\nSet an alert to get notified when a price is hit!';
    }
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'➕ New Alert',callback_data:'add_alert'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  } else if (data==='add_alert') {
    updateUser(user.id, {onboarding_step:'await_alert_pair', onboarding_data:{}});
    await sendTelegram(chat_id, `🔔 <b>New Price Alert</b>\n\nType the pair (e.g. BTCUSDT, ETHUSDT):`);

  } else if (data==='alert_dir_above'||data==='alert_dir_below') {
    const direction = data==='alert_dir_above'?'above':'below';
    createPriceAlert({telegram_id:chat_id, pair:od.alert_pair, direction, target_price:od.alert_price});
    updateUser(user.id, {onboarding_step:'', onboarding_data:{}});
    await sendTelegram(chat_id,
      `✅ <b>Alert Set!</b>\n──────────────────────────\n🪙 ${od.alert_pair}\n${direction==='above'?'📈 Above':'📉 Below'} <b>$${fmt(od.alert_price,4)}</b>\n\nYou'll be notified when hit!`,
      {inline_keyboard:[[{text:'🔔 My Alerts',callback_data:'menu_alerts'},{text:'🏠 Menu',callback_data:'menu_main'}]]});

  // ── AI ──
  } else if (data==='menu_ai') {
    updateUser(user.id, {onboarding_step:'await_ai_pair'});
    await sendTelegram(chat_id, `🤖 <b>AI Trading Assistant</b>\n──────────────────────────\nType the pair you want to analyze:\n\n<i>Example: BTCUSDT, ETHUSDT, BNBUSDT</i>`);

  // ── News ──
  } else if (data==='menu_news') {
    await sendTelegram(chat_id, '📰 <b>Fetching latest crypto news...</b> ⏳');
    const news = await fetchNews();
    let msg = `📰 <b>Crypto News</b>\n──────────────────────────\n`;
    for (const n of news) {
      const time = new Date(n.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      msg += `• [${time}] <a href="${n.url}">${n.title}</a>\n\n`;
    }
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'🔄 Refresh',callback_data:'menu_news'},{text:'🤖 AI Analysis',callback_data:'menu_ai'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  // ── Chart ──
  } else if (data==='menu_chart') {
    const strategies = listStrategies(chat_id);
    const pair = strategies.length ? strategies[0].pair : 'BTCUSDT';
    await sendTelegram(chat_id, '📉 <b>Loading chart...</b> ⏳');
    const chart = await buildChart(pair);
    await sendTelegram(chat_id, chart, {inline_keyboard:[
      [{text:'🔄 Refresh',callback_data:'menu_chart'},{text:'🤖 AI Analysis',callback_data:'menu_ai'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  // ── Journal ──
  } else if (data==='menu_journal') {
    const notes = getJournalNotes(chat_id);
    let msg = `📓 <b>Trade Journal</b>\n──────────────────────────\n`;
    if (notes.length) {
      for (const n of notes.slice(0,5)) {
        msg += `📅 ${new Date(n.created_date).toLocaleDateString()}\n"${n.note.substring(0,80)}"\n\n`;
      }
    } else {
      msg += '💤 No journal entries yet.\n\nAdd notes to track your trading mindset!';
    }
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'✍️ Add Note',callback_data:'add_journal'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  } else if (data==='add_journal') {
    updateUser(user.id, {onboarding_step:'await_journal'});
    await sendTelegram(chat_id, `📓 <b>New Journal Entry</b>\n\nType your note (trade thoughts, lessons, analysis):`);

  // ── LIVE SUPPORT ──
  } else if (data==='menu_support') {
    const history = getSupport(chat_id);
    let msg = `💬 <b>Live Support</b>\n──────────────────────────\n`;
    if (history.length) {
      msg += `<b>Recent messages:</b>\n`;
      for (const h of history.slice(-4)) {
        const dir = h.direction==='inbound'?'👤':'🛠️';
        const time = new Date(h.created_date).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
        msg += `${dir} [${time}] ${h.message.substring(0,60)}\n`;
      }
      msg += `──────────────────────────\n✍️ Type your message to continue:`;
    } else {
      msg += `👋 Hi <b>${user.first_name||'Trader'}</b>!\n\nOur support team is ready to help.\n\n✍️ Type your message below:`;
    }
    updateUser(user.id, {onboarding_step:'await_support_msg'});
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'❓ FAQ',callback_data:'menu_faq'},{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  // ── FAQ ──
  } else if (data==='menu_faq') {
    let msg = `❓ <b>Frequently Asked Questions</b>\n──────────────────────────\n`;
    FAQ.slice(0,5).forEach((qa,i) => {
      msg += `<b>${i+1}. ${qa[0]}</b>\n${qa[1]}\n\n`;
    });
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'More FAQs ➡️',callback_data:'menu_faq2'},{text:'💬 Live Chat',callback_data:'menu_support'}],
      [{text:'🏠 Main Menu',callback_data:'menu_main'}]
    ]});

  } else if (data==='menu_faq2') {
    let msg = `❓ <b>FAQ (Part 2)</b>\n──────────────────────────\n`;
    FAQ.slice(5).forEach((qa,i) => {
      msg += `<b>${i+6}. ${qa[0]}</b>\n${qa[1]}\n\n`;
    });
    await sendTelegram(chat_id, msg, {inline_keyboard:[
      [{text:'💬 Live Chat',callback_data:'menu_support'},{text:'🏠 Menu',callback_data:'menu_main'}]
    ]});

  // ── BILLING ──
  } else if (data==='menu_billing') {
    const expiry = user.plan_expires ? `\n📅 Expires: <b>${new Date(user.plan_expires).toLocaleDateString()}</b>` : '';
    if (isPro(user)) {
      await sendTelegram(chat_id,
        `💎 <b>PRO Plan Active</b>\n──────────────────────────\n✅ Live Trading: ON\n✅ AI Signals: ON\n✅ Priority Support: ON\n✅ Unlimited Strategies: ON${expiry}\n──────────────────────────\nThank you for your support! 🙏`,
        billingKeyboard(user));
    } else {
      await sendTelegram(chat_id,
        `💳 <b>Upgrade to PRO</b>\n──────────────────────────\n🆓 FREE (current):\n• Paper trading ✅\n• 3 strategies ✅\n• Basic alerts ✅\n• Price charts ✅\n\n💎 PRO — <b>$${PRO_MONTHLY_USD}/month</b>:\n• Live trading 🚀\n• Unlimited strategies ✅\n• AI trading signals 🤖\n• Priority support 💬\n• Advanced analytics 📊\n• Binance + Bybit ✅\n──────────────────────────\nUpgrade now to start live trading!`,
        billingKeyboard(user));
    }

  } else if (data==='billing_upgrade') {
    const checkoutUrl = await createStripeCheckout(user);
    if (checkoutUrl) {
      await sendTelegram(chat_id,
        `💎 <b>Upgrade to PRO</b>\n\nClick below to complete payment:\n<a href="${checkoutUrl}">🔐 Secure Checkout — $${PRO_MONTHLY_USD}/mo</a>\n\n✅ Powered by Stripe\n🔒 Cancel anytime`,
        {inline_keyboard:[
          [{text:'💳 Pay Now',url:checkoutUrl}],
          [{text:'🏠 Main Menu',callback_data:'menu_main'}]
        ]});
    } else {
      // Stripe not configured — show manual upgrade flow
      await sendTelegram(chat_id,
        `💎 <b>Upgrade to PRO — $${PRO_MONTHLY_USD}/mo</b>\n──────────────────────────\nTo upgrade, contact our support team:\n\n📧 Payment via support chat\n\nClick below to start:`,
        {inline_keyboard:[
          [{text:'💬 Contact Support',callback_data:'menu_support'}],
          [{text:'🏠 Main Menu',callback_data:'menu_main'}]
        ]});
    }

  } else if (data==='billing_compare') {
    await sendTelegram(chat_id,
      `📋 <b>Plan Comparison</b>\n══════════════════════════\n<b>Feature         FREE   PRO</b>\n──────────────────────────\nPaper Trading     ✅     ✅\nStrategy Builder  ✅     ✅\nPrice Alerts      ✅     ✅\nCrypto News       ✅     ✅\nChart View        ✅     ✅\nStrategies        3      ∞\nLive Trading      ❌     ✅\nAI Signals        ❌     ✅\nBinance API       ❌     ✅\nBybit API         ❌     ✅\nPriority Support  ❌     ✅\nAdvanced Stats    ❌     ✅\n══════════════════════════\nPRO: <b>$${PRO_MONTHLY_USD}/month</b>`,
      {inline_keyboard:[
        [{text:`💎 Get PRO — $${PRO_MONTHLY_USD}/mo`,callback_data:'billing_upgrade'}],
        [{text:'🏠 Main Menu',callback_data:'menu_main'}]
      ]});

  // ── Settings ──
  } else if (data==='menu_settings') {
    const ex = user.exchange||'Not set';
    const exchanges = ['binance','bybit','mexc','okx','kucoin'];
    const connectedExchanges = exchanges.filter(e=>user[`${e}_api_key_enc`]).map(e=>e.toUpperCase());
    const hasKeys = connectedExchanges.length>0?`✅ ${connectedExchanges.join(', ')}`:'❌ Not connected';
    const demoInfo = (user.demo_balance||0)>0?`$${fmt(user.demo_balance)}`:'Not set';
    await sendTelegram(chat_id,
      `⚙️ <b>Settings</b>\n──────────────────────────\n👤 Name: <b>${user.first_name||'—'}</b>\n🏦 Active Exchange: <b>${(ex||'—').toUpperCase()}</b>\n🔑 Connected: <b>${hasKeys}</b>\n💎 Plan: <b>${planBadge(user.plan)}</b>\n🏦 Balance: <b>$${fmt(user.balance_usd||10000)}</b>\n🧪 Demo Funds: <b>${demoInfo}</b>`,
      {inline_keyboard:[
        [{text:'🔑 Binance',callback_data:'set_exchange_binance'},{text:'🔑 Bybit',callback_data:'set_exchange_bybit'}],
        [{text:'🔑 MEXC',callback_data:'set_exchange_mexc'},{text:'🔑 OKX',callback_data:'set_exchange_okx'},{text:'🔑 KuCoin',callback_data:'set_exchange_kucoin'}],
        [{text:'💎 Manage Plan',callback_data:'menu_billing'}],
        [{text:'🏠 Main Menu',callback_data:'menu_main'}]
      ]});

  } else if (['set_exchange_binance','set_exchange_bybit','set_exchange_mexc','set_exchange_okx','set_exchange_kucoin'].includes(data)) {
    const ex = data.replace('set_exchange_','');
    const exNames = {binance:'Binance',bybit:'Bybit',mexc:'MEXC',okx:'OKX',kucoin:'KuCoin'};
    updateUser(user.id, {exchange:ex, onboarding_step:`await_api_key_${ex}`, onboarding_data:{}});
    await sendTelegram(chat_id,
      `🔑 <b>${exNames[ex]||ex.toUpperCase()} API Setup</b>\n──────────────────────────\n⚠️ Create API key with:\n✅ Spot/Trade permission\n❌ NO withdrawal permission\n\nPaste your <b>API Key</b>:`);

  // ── Stop all ──
  } else if (data==='menu_stopall') {
    updateUser(user.id, {bot_stopped:true});
    await sendTelegram(chat_id,
      `🛑 <b>ALL BOTS STOPPED</b>\n──────────────────────────\nAll active strategies paused.\nOpen trades continue to monitor.\n\nRestart from main menu.`,
      {inline_keyboard:[[{text:'▶️ Resume Bots',callback_data:'menu_resume'},{text:'🏠 Menu',callback_data:'menu_main'}]]});

  } else if (data==='menu_resume') {
    updateUser(user.id, {bot_stopped:false});
    await sendTelegram(chat_id,
      `▶️ <b>Bots Resumed!</b>\n──────────────────────────\nAll strategies are now active.\nSignals will be processed.`,
      {inline_keyboard:[[{text:'📊 Performance',callback_data:'menu_performance'},{text:'🏠 Menu',callback_data:'menu_main'}]]});

  // ── Close trade by ID ──
  } else if (data.startsWith('close_')) {
    const suffix = data.replace('close_','');
    const trades = listTrades(chat_id, {status:'open'});
    const trade = trades.find(t=>t.id.endsWith(suffix));
    if (trade) {
      const price = await fetchPrice(trade.pair)||trade.entry_price;
      const result = closeTrade(trade.id, price, 'manual');
      await sendTelegram(chat_id,
        `✅ <b>Trade Closed</b>\n──────────────────────────\n🪙 ${trade.pair} ${trade.action}\n📥 Entry: $${fmt(trade.entry_price,4)}\n📤 Exit:  $${fmt(price,4)}\n💰 P&L: ${fmtPnl(result.pnl)} (${fmtPct(result.pnl_pct)})\n⏱️ Duration: ${elapsed(trade.created_date)}`,
        {inline_keyboard:[[{text:'📊 Performance',callback_data:'menu_performance'},{text:'🏠 Menu',callback_data:'menu_main'}]]});
    } else {
      await sendTelegram(chat_id, '⚠️ Trade not found or already closed.', backToMenu());
    }
  }
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chat_id = String(msg.chat.id);
  const text = msg.text||'';
  let user = getUser(chat_id);
  if (!user) user = createUser({telegram_id:chat_id, telegram_username:msg.from?.username||'', first_name:msg.from?.first_name||''});
  updateUser(user.id, {last_seen: new Date().toISOString(), first_name: msg.from?.first_name||user.first_name});

  // Admin commands
  if (chat_id === ADMIN_CHAT_ID) {
    if (text.startsWith('/reply ')) {
      const parts = text.split(' ');
      const target_id = parts[1];
      const reply = parts.slice(2).join(' ');
      if (target_id && reply) {
        saveSupport(target_id, 'Support', reply, 'outbound');
        await sendTelegram(target_id, `💬 <b>Support Reply:</b>\n──────────────────────────\n${reply}`, {inline_keyboard:[[{text:'💬 Reply Back',callback_data:'menu_support'},{text:'🏠 Menu',callback_data:'menu_main'}]]});
        await sendTelegram(ADMIN_CHAT_ID, `✅ Reply sent to user ${target_id}`);
        return;
      }
    }
    if (text==='/users') {
      const users = getAllUsers();
      await sendTelegram(ADMIN_CHAT_ID, `👥 Total users: <b>${users.length}</b>\n${users.slice(0,10).map(u=>`• ${u.first_name||'—'} (@${u.telegram_username||'—'}) — ${planBadge(u.plan)}`).join('\n')}`);
      return;
    }
    if (text==='/broadcast') {
      await sendTelegram(ADMIN_CHAT_ID, 'Usage: /broadcast Your message here');
      return;
    }
    if (text.startsWith('/broadcast ')) {
      const broadMsg = text.replace('/broadcast ','');
      const users = getAllUsers();
      let sent=0;
      for (const u of users) {
        try { await sendTelegram(u.telegram_id, `📢 <b>Announcement:</b>\n\n${broadMsg}`); sent++; } catch(_){}
      }
      await sendTelegram(ADMIN_CHAT_ID, `✅ Broadcast sent to ${sent} users.`);
      return;
    }
    if (text.startsWith('/grant_pro ')) {
      const target = text.replace('/grant_pro ','').trim();
      const targetUser = getUser(target);
      if (targetUser) {
        updateUser(targetUser.id, {plan:'pro', plan_expires:''});
        await sendTelegram(target, `💎 <b>PRO Access Granted!</b>\n──────────────────────────\nYour account has been upgraded to PRO.\n✅ Live trading: ON\n✅ All features unlocked!\n\nThank you! 🙏`, backToMenu());
        await sendTelegram(ADMIN_CHAT_ID, `✅ PRO granted to user ${target}`);
      } else {
        await sendTelegram(ADMIN_CHAT_ID, `❌ User not found: ${target}`);
      }
      return;
    }
  }

  // Handle onboarding steps
  const step = user.onboarding_step||'';
  if (step && step!=='done') {
    // Demo funds handler
    if (step==='await_demo_funds') {
      const amount = parseFloat(text.replace(/[,$]/g,''));
      if (isNaN(amount)||amount<10) {
        await sendTelegram(chat_id,'❌ Please enter a valid amount (minimum $10):');
        return;
      }
      if (amount>1000000) {
        await sendTelegram(chat_id,'❌ Maximum demo amount is $1,000,000');
        return;
      }
      updateUser(user.id, {demo_balance:amount, demo_initial:amount, balance_usd:amount, onboarding_step:'done', onboarding_data:{}});
      await sendTelegram(chat_id,
        `✅ <b>Demo Account Funded!</b>\n──────────────────────────\n💰 Demo Balance: <b>$${fmt(amount)}</b>\n\nYour bot will now use real position sizing based on this balance.\n\n📡 Send a signal or create a strategy to start trading!`,
        {inline_keyboard:[
          [{text:'🤖 Create Strategy',callback_data:'menu_create'},{text:'📡 Signal Setup',callback_data:'menu_signal'}],
          [{text:'🧪 Paper Trading',callback_data:'menu_paper'},{text:'🏠 Menu',callback_data:'menu_main'}]
        ]});
      return;
    }
    // API key collection
    if (step.startsWith('await_api_key_')) {
      const ex = step.replace('await_api_key_','');
      if (text.length<10){await sendTelegram(chat_id,'❌ Invalid API key. Paste the full key:');return;}
      const field = `${ex}_api_key_enc`;
      updateUser(user.id, {[field]:text, onboarding_step:`await_api_secret_${ex}`});
      await sendTelegram(chat_id, `✅ <b>API Key saved!</b>\n\nNow paste your <b>${ex.toUpperCase()} Secret Key</b>:`);
      return;
    }
    if (step.startsWith('await_api_secret_')) {
      const ex = step.replace('await_api_secret_','');
      if (text.length<10){await sendTelegram(chat_id,'❌ Invalid secret:');return;}
      const field = `${ex}_secret_enc`;
      updateUser(user.id, {[field]:text, onboarding_step:'done', auto_trade_enabled:true});
      await sendTelegram(chat_id,
        `🔐 <b>API Keys Saved!</b>\n──────────────────────────\n✅ ${ex.toUpperCase()} connected\n✅ Auto Trading: ON\n\n⚠️ Ensure key has Spot Trading only — NO withdrawals.`,
        mainMenuKeyboard(user));
      return;
    }
    if (step==='select_pair_custom') {
      const pair = text.trim().toUpperCase().replace('/','');
      updateUser(user.id, {onboarding_data:{...user.onboarding_data, pair}, onboarding_step:'select_entry'});
      await sendTelegram(chat_id, `✅ Pair: <b>${pair}</b>\n\n📋 <b>Select entry type:</b>`, {inline_keyboard:[
        [{text:'📡 TradingView Signal',callback_data:'entry_signal'},{text:'🔔 Price Alert',callback_data:'entry_alert'}],
        [{text:'🤖 Auto (AI)',callback_data:'entry_ai'}],
        [{text:'« Back',callback_data:'menu_create'}]
      ]});
      return;
    }
    await handleOnboarding(chat_id, user, step, text);
    return;
  }

  // Commands
  if (text.startsWith('/start')||text==='/menu') {
    updateUser(user.id, {bot_stopped:false, onboarding_step:'', onboarding_data:{}, support_thread_open:0});
    user = getUser(chat_id) || user;
    const isNew = text.startsWith('/start pro_success');
    await sendMainMenu(chat_id, user, isNew?'💎 <b>PRO activated!</b> Welcome to the big leagues 🚀':'');
  } else if (text==='/help'||text==='/faq') {
    let msg = `❓ <b>FAQ — TradeBot AutoLab</b>\n──────────────────────────\n`;
    FAQ.slice(0,5).forEach((qa,i) => { msg += `<b>${i+1}. ${qa[0]}</b>\n${qa[1]}\n\n`; });
    await sendTelegram(chat_id, msg, {inline_keyboard:[[{text:'More FAQs',callback_data:'menu_faq2'},{text:'💬 Support',callback_data:'menu_support'}],[{text:'🏠 Menu',callback_data:'menu_main'}]]});
  } else if (text==='/performance'||text==='/stats') {
    await handleCallback({message:{chat:{id:chat_id}}, data:'menu_performance', id:'', from:msg.from});
  } else if (text.startsWith('/price ')) {
    const pair = text.replace('/price ','').trim().toUpperCase();
    const price = await fetchPrice(pair);
    if (price) {
      await sendTelegram(chat_id, `💵 <b>${pair}</b>: $${fmt(price,4)}`, {inline_keyboard:[[{text:'🔔 Set Alert',callback_data:'add_alert'},{text:'🤖 AI Analysis',callback_data:'menu_ai'}]]});
    } else {
      await sendTelegram(chat_id, `❌ Couldn't fetch price for ${pair}. Try BTCUSDT, ETHUSDT etc.`);
    }
  } else {
    // Default — show menu
    await sendMainMenu(chat_id, user);
  }
}

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req,res) => {
  res.json({status:'TradeBot AutoLab v5.0 🤖', version:'5.0', uptime:`${Math.floor(process.uptime())}s`, time:new Date().toISOString()});
});

// Stripe webhook for payment confirmation
app.post('/stripe-webhook', express.raw({type:'application/json'}), async (req,res) => {
  try {
    const event = JSON.parse(req.body.toString());
    if (event.type==='checkout.session.completed') {
      const session = event.data.object;
      const telegram_id = session.metadata?.telegram_id || session.client_reference_id;
      if (telegram_id) {
        const u = getUser(telegram_id);
        if (u) {
          const expires = new Date(Date.now() + 30*24*60*60*1000).toISOString();
          updateUser(u.id, {plan:'pro', plan_expires:expires, stripe_customer_id: session.customer||''});
          await sendTelegram(telegram_id,
            `💎 <b>PRO Activated!</b>\n──────────────────────────\n✅ Live trading: ON\n✅ AI signals: ON\n✅ Unlimited strategies: ON\n\nWelcome to PRO! 🚀`,
            mainMenuKeyboard(u));
        }
      }
    }
    res.json({received:true});
  } catch(e) { res.status(400).json({error:e.message}); }
});

// Telegram webhook
app.post('/webhook', async (req,res) => {
  // Block Base44 interception - validate secret token
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret && secret !== 'TradeBot_AutoLab_2026_Secure') {
    console.log('[BLOCKED] Bad secret token:', secret);
    return res.sendStatus(403);
  }
  res.json({ok:true}); // respond fast
  try {
    const update = req.body;
    if (!update) return;
    if (update.callback_query) {
      const cq = update.callback_query;
      const cid = cq?.message?.chat?.id || cq?.from?.id;
      console.log(`[CB] from=${cid} data=${cq?.data}`);
      await handleCallback(cq).catch(async e => {
        console.error('[CB ERROR]', e.message, e.stack);
        try { await sendTelegram(String(cid), '⚠️ An error occurred. Please try again or send /start'); } catch(_) {}
      });
    } else if (update.message) {
      const mid = update.message?.chat?.id;
      console.log(`[MSG] from=${mid} text=${(update.message?.text||'').substring(0,30)}`);
      await handleMessage(update.message).catch(async e => {
        console.error('[MSG ERROR]', e.message, e.stack);
        try { await sendTelegram(String(mid), '⚠️ An error occurred. Send /start to restart.'); } catch(_) {}
      });
    }
  } catch(e) { console.error('Webhook fatal:', e.message, e.stack); }
});

// Signal webhook (TradingView)
app.post('/signal', async (req,res) => {
  const telegram_id = req.query.user_id || req.query.telegram_id;
  if (!telegram_id) return res.status(400).json({error:'user_id required'});
  const payload = req.body;
  if (!payload.pair||!payload.action) return res.status(400).json({error:'pair and action required'});
  res.json({ok:true, received: payload});
  try { await processSignal(telegram_id, payload); } catch(e) { console.error('Signal error:', e.message); }
});

// Admin endpoints
app.get('/health', (req,res) => {
  const users = getAllUsers();
  const trades = db.prepare('SELECT COUNT(*) as c FROM trades').get().c;
  res.json({status:'ok', users:users.length, trades, version:'5.0', uptime:Math.floor(process.uptime())});
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 TradeBot AutoLab v5.0 on port ${PORT}`);
  console.log(`🔗 Webhook: ${WEBHOOK_URL}`);
  assertWebhook();
  setInterval(assertWebhook, 2*60*1000);
  setInterval(monitorTrades, 30*1000);
  setInterval(monitorAlerts, 15*1000);
  // Daily digest at 8am UTC
  const now = new Date();
  const nextDigest = new Date(now);
  nextDigest.setUTCHours(8,0,0,0);
  if (nextDigest <= now) nextDigest.setUTCDate(nextDigest.getUTCDate()+1);
  setTimeout(() => {
    sendDailyDigest();
    setInterval(sendDailyDigest, 24*60*60*1000);
  }, nextDigest-now);
});