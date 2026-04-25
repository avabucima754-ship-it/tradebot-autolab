// SQLite database layer for TradeBot AutoLab v4.0
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

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
`);

// Safe migrations
try { db.exec(`ALTER TABLE strategies ADD COLUMN total_trades INTEGER DEFAULT 0`); } catch(_) {}
try { db.exec(`ALTER TABLE strategies ADD COLUMN total_wins INTEGER DEFAULT 0`); } catch(_) {}
try { db.exec(`ALTER TABLE strategies ADD COLUMN total_pnl REAL DEFAULT 0`); } catch(_) {}
try { db.exec(`ALTER TABLE bot_users ADD COLUMN balance_usd REAL DEFAULT 10000`); } catch(_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS price_alerts (id TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, pair TEXT NOT NULL, direction TEXT NOT NULL, target_price REAL NOT NULL, triggered INTEGER DEFAULT 0, created_date TEXT DEFAULT (datetime('now')))`); } catch(_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS journal_notes (id TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, note TEXT NOT NULL, created_date TEXT DEFAULT (datetime('now')))`); } catch(_) {}

function genId() { return crypto.randomBytes(16).toString('hex'); }

function getUser(telegram_id) {
  const row = db.prepare('SELECT * FROM bot_users WHERE telegram_id = ?').get(telegram_id);
  if (!row) return null;
  row.onboarding_data = JSON.parse(row.onboarding_data || '{}');
  row.auto_trade_enabled = !!row.auto_trade_enabled;
  row.bot_stopped = !!row.bot_stopped;
  return row;
}
function getAllUsers() { return db.prepare('SELECT * FROM bot_users').all().map(r=>({...r,bot_stopped:!!r.bot_stopped,auto_trade_enabled:!!r.auto_trade_enabled})); }
function createUser(data) {
  const id = genId();
  db.prepare(`INSERT INTO bot_users (id,telegram_id,telegram_username,first_name,onboarding_data) VALUES (?,?,?,?,?)`).run(id, data.telegram_id, data.telegram_username||'', data.first_name||'', '{}');
  return getUser(data.telegram_id);
}
function updateUser(id, data) {
  const allowed = ['telegram_username','first_name','auto_trade_enabled','bot_stopped','binance_api_key_enc','binance_secret_enc','bybit_api_key_enc','bybit_secret_enc','exchange','onboarding_step','onboarding_data','balance_usd'];
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

function listStrategies(telegram_id, filters={}) {
  let q='SELECT * FROM strategies WHERE telegram_id=?'; const vals=[telegram_id];
  if (filters.is_active!==undefined){q+=' AND is_active=?';vals.push(filters.is_active?1:0);}
  return db.prepare(q+' ORDER BY created_date DESC').all(...vals).map(r=>({...r,is_active:!!r.is_active,trailing_stop:!!r.trailing_stop,entry_rules:JSON.parse(r.entry_rules||'{}')}));
}
function createStrategy(data) {
  const id=genId();
  db.prepare(`INSERT INTO strategies (id,telegram_id,name,market,pair,entry_type,entry_rules,take_profit_pct,stop_loss_pct,trailing_stop,risk_per_trade_pct,max_trades_per_day,max_loss_limit_pct,is_active,mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,data.telegram_id,data.name,data.market||'',data.pair||'',data.entry_type||'',JSON.stringify(data.entry_rules||{}),data.take_profit_pct||2,data.stop_loss_pct||1,data.trailing_stop?1:0,data.risk_per_trade_pct||1,data.max_trades_per_day||5,data.max_loss_limit_pct||5,data.is_active!==false?1:0,data.mode||'paper');
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
  db.prepare(`INSERT INTO trades (id,telegram_id,strategy_id,strategy_name,pair,action,entry_price,take_profit,stop_loss,quantity,status,mode,exchange_order_id,signal_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,data.telegram_id,data.strategy_id||'',data.strategy_name||'',data.pair||'',data.action||'',data.entry_price||0,data.take_profit||0,data.stop_loss||0,data.quantity||0,data.status||'open',data.mode||'paper',data.exchange_order_id||'',JSON.stringify(data.signal_payload||{}));
  return db.prepare('SELECT * FROM trades WHERE id=?').get(id);
}
function closeTrade(id, exit_price, close_reason) {
  const t = db.prepare('SELECT * FROM trades WHERE id=?').get(id);
  if (!t) return null;
  const pnl = t.action==='BUY'?(exit_price-t.entry_price)*t.quantity:(t.entry_price-exit_price)*t.quantity;
  const pnl_pct = t.action==='BUY'?((exit_price-t.entry_price)/t.entry_price)*100:((t.entry_price-exit_price)/t.entry_price)*100;
  db.prepare(`UPDATE trades SET status='closed',exit_price=?,pnl=?,pnl_pct=?,close_reason=?,updated_date=datetime('now') WHERE id=?`).run(exit_price,pnl,pnl_pct,close_reason,id);
  const strategy = db.prepare('SELECT * FROM strategies WHERE id=?').get(t.strategy_id);
  if (strategy) {
    db.prepare(`UPDATE strategies SET total_trades=total_trades+1,total_wins=total_wins+?,total_pnl=total_pnl+?,updated_date=datetime('now') WHERE id=?`).run(pnl>0?1:0,pnl,t.strategy_id);
  }
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
  const best=closed.sort((a,b)=>b.pnl-a.pnl)[0];
  const worst=closed.sort((a,b)=>a.pnl-b.pnl)[0];
  return {total:all.length,open:all.filter(t=>t.status==='open').length,closed:closed.length,wins:wins.length,losses:closed.length-wins.length,winRate:closed.length?wins.length/closed.length*100:0,totalPnl,avgPnl:closed.length?totalPnl/closed.length:0,bestTrade:best,worstTrade:worst};
}
function createSignalLog(data) {
  const id=genId();
  db.prepare(`INSERT INTO signal_logs (id,telegram_id,pair,action,raw_payload,processed,matched_strategy_id,result) VALUES (?,?,?,?,?,?,?,?)`).run(id,data.telegram_id,data.pair||'',data.action||'',JSON.stringify(data.raw_payload||{}),data.processed?1:0,data.matched_strategy_id||'',data.result||'');
}
function createPriceAlert(data) {
  const id=genId();
  db.prepare(`INSERT INTO price_alerts (id,telegram_id,pair,direction,target_price) VALUES (?,?,?,?,?)`).run(id,data.telegram_id,data.pair,data.direction,data.target_price);
}
function getActiveAlerts() { return db.prepare(`SELECT * FROM price_alerts WHERE triggered=0`).all(); }
function getUserAlerts(telegram_id) { return db.prepare(`SELECT * FROM price_alerts WHERE telegram_id=? AND triggered=0`).all(telegram_id); }
function markAlertTriggered(id) { db.prepare(`UPDATE price_alerts SET triggered=1 WHERE id=?`).run(id); }
function addJournalNote(telegram_id,note) { db.prepare(`INSERT INTO journal_notes (id,telegram_id,note) VALUES (?,?,?)`).run(genId(),telegram_id,note); }
function getJournal(telegram_id) { return db.prepare(`SELECT * FROM journal_notes WHERE telegram_id=? ORDER BY created_date DESC LIMIT 20`).all(telegram_id); }

module.exports = {
  getUser,getAllUsers,createUser,updateUser,
  listStrategies,createStrategy,updateStrategy,deleteStrategy,
  listTrades,createTrade,closeTrade,getTodayTradeCount,getTodayPnl,getStats,
  createSignalLog,
  createPriceAlert,getActiveAlerts,getUserAlerts,markAlertTriggered,
  addJournalNote,getJournal,
};
