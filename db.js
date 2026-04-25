// SQLite database layer for TradeBot AutoLab
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tradebot.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_users (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
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
    created_date TEXT DEFAULT (datetime('now')),
    updated_date TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS strategies (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
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
    created_date TEXT DEFAULT (datetime('now')),
    updated_date TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
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
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    telegram_id TEXT NOT NULL,
    pair TEXT DEFAULT '',
    action TEXT DEFAULT '',
    raw_payload TEXT DEFAULT '{}',
    processed INTEGER DEFAULT 0,
    matched_strategy_id TEXT DEFAULT '',
    result TEXT DEFAULT '',
    created_date TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Helper: generate ID ──────────────────────────────────────────────────────
function genId() {
  return require('crypto').randomBytes(16).toString('hex');
}

// ─── BotUser CRUD ─────────────────────────────────────────────────────────────
function getUser(telegram_id) {
  const row = db.prepare('SELECT * FROM bot_users WHERE telegram_id = ?').get(telegram_id);
  if (!row) return null;
  row.onboarding_data = JSON.parse(row.onboarding_data || '{}');
  row.auto_trade_enabled = !!row.auto_trade_enabled;
  row.bot_stopped = !!row.bot_stopped;
  row.trailing_stop = !!row.trailing_stop;
  return row;
}

function createUser(data) {
  const id = genId();
  const od = JSON.stringify(data.onboarding_data || {});
  db.prepare(`
    INSERT INTO bot_users (id, telegram_id, telegram_username, first_name, onboarding_data)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, data.telegram_id, data.telegram_username || '', data.first_name || '', od);
  return getUser(data.telegram_id);
}

function updateUser(id, data) {
  const allowed = ['telegram_username','first_name','auto_trade_enabled','bot_stopped',
    'binance_api_key_enc','binance_secret_enc','bybit_api_key_enc','bybit_secret_enc',
    'exchange','onboarding_step','onboarding_data'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    if (k === 'onboarding_data') vals.push(JSON.stringify(v));
    else if (typeof v === 'boolean') vals.push(v ? 1 : 0);
    else vals.push(v);
  }
  if (sets.length === 0) return;
  sets.push('updated_date = datetime(\'now\')');
  vals.push(id);
  db.prepare(`UPDATE bot_users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

// ─── Strategy CRUD ────────────────────────────────────────────────────────────
function listStrategies(telegram_id, filters = {}) {
  let query = 'SELECT * FROM strategies WHERE telegram_id = ?';
  const vals = [telegram_id];
  if (filters.is_active !== undefined) { query += ' AND is_active = ?'; vals.push(filters.is_active ? 1 : 0); }
  const rows = db.prepare(query).all(...vals);
  return rows.map(r => ({ ...r, is_active: !!r.is_active, trailing_stop: !!r.trailing_stop, entry_rules: JSON.parse(r.entry_rules || '{}') }));
}

function createStrategy(data) {
  const id = genId();
  db.prepare(`
    INSERT INTO strategies (id, telegram_id, name, market, pair, entry_type, entry_rules,
      take_profit_pct, stop_loss_pct, trailing_stop, risk_per_trade_pct,
      max_trades_per_day, max_loss_limit_pct, is_active, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.telegram_id, data.name, data.market || '', data.pair || '',
    data.entry_type || '', JSON.stringify(data.entry_rules || {}),
    data.take_profit_pct || 2, data.stop_loss_pct || 1,
    data.trailing_stop ? 1 : 0, data.risk_per_trade_pct || 1,
    data.max_trades_per_day || 5, data.max_loss_limit_pct || 5,
    data.is_active !== false ? 1 : 0, data.mode || 'paper');
  return db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
}

function deleteStrategy(id) {
  db.prepare('DELETE FROM strategies WHERE id = ?').run(id);
}

// ─── Trade CRUD ───────────────────────────────────────────────────────────────
function listTrades(telegram_id, filters = {}) {
  let query = 'SELECT * FROM trades WHERE telegram_id = ?';
  const vals = [telegram_id];
  if (filters.mode) { query += ' AND mode = ?'; vals.push(filters.mode); }
  if (filters.status) { query += ' AND status = ?'; vals.push(filters.status); }
  if (filters.strategy_id) { query += ' AND strategy_id = ?'; vals.push(filters.strategy_id); }
  query += ' ORDER BY created_date DESC';
  return db.prepare(query).all(...vals);
}

function createTrade(data) {
  const id = genId();
  db.prepare(`
    INSERT INTO trades (id, telegram_id, strategy_id, strategy_name, pair, action,
      entry_price, take_profit, stop_loss, quantity, status, mode, exchange_order_id, signal_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.telegram_id, data.strategy_id || '', data.strategy_name || '',
    data.pair || '', data.action || '', data.entry_price || 0,
    data.take_profit || 0, data.stop_loss || 0, data.quantity || 0,
    data.status || 'open', data.mode || 'paper',
    data.exchange_order_id || '', JSON.stringify(data.signal_payload || {}));
  return db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
}

function getTodayTradeCount(telegram_id, strategy_id) {
  const today = new Date().toISOString().split('T')[0];
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM trades
    WHERE telegram_id = ? AND strategy_id = ? AND date(created_date) = ?
  `).get(telegram_id, strategy_id, today);
  return row.cnt;
}

// ─── Signal log ───────────────────────────────────────────────────────────────
function createSignalLog(data) {
  const id = genId();
  db.prepare(`
    INSERT INTO signal_logs (id, telegram_id, pair, action, raw_payload, processed, matched_strategy_id, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.telegram_id, data.pair || '', data.action || '',
    JSON.stringify(data.raw_payload || {}), data.processed ? 1 : 0,
    data.matched_strategy_id || '', data.result || '');
}

module.exports = {
  getUser, createUser, updateUser,
  listStrategies, createStrategy, deleteStrategy,
  listTrades, createTrade, getTodayTradeCount,
  createSignalLog,
};
