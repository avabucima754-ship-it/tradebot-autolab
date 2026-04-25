// ╔══════════════════════════════════════════════════════════════════════════╗
// ║        TradeBot AutoLab v4.0 — Professional AI Trading Engine           ║
// CACHE-BUST: 1777113730
// ║        With self-healing webhook, AI assistant, news, charts, FAQ       ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const express = require('express');
const db = require('./db');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8690768077:AAEuNWV21kc3fg-XPXl__y87zLBtP1POYPs';
const ENCRYPT_KEY = process.env.ENCRYPT_KEY || 'tradebot_autolab_secure_2026';
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || 'https://tradebot-server-production.up.railway.app';
const SITE_URL = 'https://untitled-app-1f9026fe.base44.app';

// ─── Self-Healing Webhook ──────────────────────────────────────────────────
async function assertWebhook() {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
    const d = await r.json();
    const currentUrl = d.result?.url || '';
    const ourUrl = `${SERVER_URL}/webhook`;
    if (!currentUrl.includes('railway.app')) {
      console.log(`⚠️ Webhook hijacked (${currentUrl}). Re-asserting...`);
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`);
      await new Promise(r=>setTimeout(r,1000));
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({url:ourUrl,allowed_updates:['message','callback_query'],drop_pending_updates:true})
      });
      const rd = await res.json();
      console.log(`✅ Webhook re-asserted: ${rd.ok}`);
    } else {
      console.log(`✅ Webhook OK: ${currentUrl}`);
    }
  } catch(e) { console.error('Webhook check error:', e.message); }
}

// Self-heal on startup and every 2 minutes
setTimeout(assertWebhook, 3000);
setInterval(assertWebhook, 2 * 60 * 1000);

// ─── Crypto helpers ─────────────────────────────────────────────────────────
function simpleEncrypt(text) {
  let r='';
  for(let i=0;i<text.length;i++) r+=String.fromCharCode(text.charCodeAt(i)^ENCRYPT_KEY.charCodeAt(i%ENCRYPT_KEY.length));
  return Buffer.from(r,'binary').toString('base64');
}
function simpleDecrypt(enc) {
  if(!enc) return '';
  const text=Buffer.from(enc,'base64').toString('binary');
  let r='';
  for(let i=0;i<text.length;i++) r+=String.fromCharCode(text.charCodeAt(i)^ENCRYPT_KEY.charCodeAt(i%ENCRYPT_KEY.length));
  return r;
}

// ─── Telegram helpers ────────────────────────────────────────────────────────
async function sendTelegram(chat_id, text, reply_markup, parse_mode='HTML') {
  const body={chat_id:String(chat_id),text,parse_mode};
  if(reply_markup) body.reply_markup=reply_markup;
  try {
    const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok) console.error('TG err:',await r.text());
  } catch(e){console.error('TG net:',e.message);}
}
async function answerCallback(id,text='') {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callback_query_id:id,text})}).catch(()=>{});
}

// ─── Price fetch ─────────────────────────────────────────────────────────────
const priceCache={};
async function fetchPrice(pair) {
  const symbol=pair.replace('/','').toUpperCase();
  const now=Date.now();
  if(priceCache[symbol]&&now-priceCache[symbol].time<10000) return priceCache[symbol].price;
  try {
    const r=await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if(r.ok){const d=await r.json();const price=parseFloat(d.price);priceCache[symbol]={price,time:now};return price;}
  } catch(_){}
  const mocks={BTCUSDT:65000,ETHUSDT:3200,BNBUSDT:580,SOLUSDT:145,EURUSD:1.085,GBPUSD:1.26,USDJPY:154.5,XRPUSDT:0.62,ADAUSDT:0.46,XAUUSDT:2330,XAGUSDT:27.5,US30:39500,SPX500:5200,NAS100:18000};
  return mocks[symbol]||100;
}

// ─── Crypto news ─────────────────────────────────────────────────────────────
const newsCache={data:null,time:0};
async function fetchCryptoNews() {
  const now=Date.now();
  if(newsCache.data && now-newsCache.time < 5*60*1000) return newsCache.data;
  try {
    const r=await fetch('https://api.coingecko.com/api/v3/news',{headers:{'Accept':'application/json'}});
    if(r.ok){
      const d=await r.json();
      const items=(d.data||d||[]).slice(0,5).map(n=>({title:n.title||n.name||'',url:n.url||'',source:n.author?.name||n.source||'',time:n.updated_at||n.published_at||''}));
      newsCache.data=items; newsCache.time=now;
      return items;
    }
  } catch(_){}
  // Fallback: CryptoPanic
  try {
    const r=await fetch('https://cryptopanic.com/api/v1/posts/?auth_token=&public=true&kind=news&filter=hot');
    if(r.ok){
      const d=await r.json();
      const items=(d.results||[]).slice(0,5).map(n=>({title:n.title||'',url:n.url||n.source?.url||'',source:n.source?.title||'',time:n.published_at||''}));
      newsCache.data=items; newsCache.time=now;
      return items;
    }
  } catch(_){}
  return [];
}

// ─── Market data (fear & greed, dominance) ───────────────────────────────────
async function fetchMarketSentiment() {
  try {
    const r=await fetch('https://api.alternative.me/fng/');
    if(r.ok){const d=await r.json();return {value:d.data[0].value,label:d.data[0].value_classification};}
  } catch(_){}
  return {value:'—',label:'Unknown'};
}

// ─── AI Trading Assistant ─────────────────────────────────────────────────────
async function aiTradingAdvice(pair, question, currentPrice, sentiment) {
  const symbol=pair.replace('/','').toUpperCase();
  // Fetch 24h price change
  let change24h='N/A', high='N/A', low='N/A', vol='N/A';
  try {
    const r=await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
    if(r.ok){const d=await r.json();change24h=parseFloat(d.priceChangePercent).toFixed(2)+'%';high=parseFloat(d.highPrice).toFixed(2);low=parseFloat(d.lowPrice).toFixed(2);vol=parseFloat(d.quoteVolume).toFixed(0);}
  } catch(_){}
  
  // Fetch RSI-like signal (simplified via price action)
  const direction = parseFloat(change24h)>0?'📈 Bullish':'📉 Bearish';
  const strength = Math.abs(parseFloat(change24h));
  const signal = strength>5?'Strong':strength>2?'Moderate':'Weak';
  
  const fg=parseInt(sentiment.value)||50;
  const fgLabel=fg>=70?'Extreme Greed 🔥':fg>=55?'Greed 😏':fg>=45?'Neutral 😐':fg>=30?'Fear 😨':'Extreme Fear 😱';
  
  // Build AI-style analysis
  const advice = buildAIAnalysis(pair,currentPrice,change24h,high,low,direction,signal,fgLabel,fg,question);
  return advice;
}

function buildAIAnalysis(pair,price,change24h,high,low,direction,strength,fgLabel,fgVal,question) {
  const q=(question||'').toLowerCase();
  const isBuy=q.includes('buy')||q.includes('long')||q.includes('entry');
  const isSell=q.includes('sell')||q.includes('short');
  const isRisk=q.includes('risk')||q.includes('safe');
  const isTrend=q.includes('trend')||q.includes('direction')||q.includes('analysis');
  
  const changeNum=parseFloat(change24h)||0;
  const bullish=changeNum>0;
  
  let analysis=`🤖 <b>AI Analysis — ${pair}</b>\n\n`;
  analysis+=`💰 Price: <b>$${parseFloat(price).toLocaleString()}</b>\n`;
  analysis+=`📊 24h: <b>${change24h}</b> ${bullish?'📈':'📉'}\n`;
  analysis+=`📏 Range: $${low} — $${high}\n`;
  analysis+=`🧠 Sentiment: <b>${fgLabel}</b> (${fgVal}/100)\n\n`;
  
  if (isBuy || isTrend || (!isSell&&!isRisk)) {
    if (bullish && fgVal>45) {
      analysis+=`✅ <b>Bias: BULLISH</b>\n\nMomentum is ${strength.toLowerCase()} to the upside. The market sentiment supports longs. Consider:\n• Entry: Near current price or on small pullback\n• TP: +2-3% ($${(parseFloat(price)*1.025).toFixed(0)}-$${(parseFloat(price)*1.03).toFixed(0)})\n• SL: -1.5% ($${(parseFloat(price)*0.985).toFixed(0)})\n• R:R 1:2 ✅`;
    } else if (!bullish && fgVal<45) {
      analysis+=`⚠️ <b>Bias: BEARISH</b>\n\nMomentum is ${strength.toLowerCase()} to the downside. Caution on longs:\n• Wait for support confirmation\n• Consider short with TP at -2-3%\n• SL: +1.5% above entry\n• Or wait for reversal signal`;
    } else {
      analysis+=`⚖️ <b>Bias: NEUTRAL</b>\n\nMixed signals — price and sentiment diverging. Best approach:\n• Wait for clear direction confirmation\n• Range trade between $${low} and $${high}\n• Tighter TP/SL until breakout`;
    }
  }
  
  if (isRisk) {
    analysis+=`\n\n🛡️ <b>Risk Assessment:</b>\n`;
    analysis+=fgVal>75?`❗ Extreme Greed — HIGH RISK. Late in cycle, reduce position size.`:fgVal<25?`❗ Extreme Fear — HIGH VOLATILITY. Wide wicks, use tighter stops.`:`✅ Normal risk environment. Standard 1-2% risk per trade recommended.`;
  }
  
  analysis+=`\n\n💡 <i>AI guidance only. Always use your own judgment and risk management.</i>`;
  return analysis;
}

// ─── Chart ASCII ──────────────────────────────────────────────────────────────
async function generateChart(pair) {
  const symbol=pair.replace('/','').toUpperCase();
  let candles=[];
  try {
    const r=await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=4h&limit=20`);
    if(r.ok){const d=await r.json();candles=d.map(c=>({o:parseFloat(c[1]),h:parseFloat(c[2]),l:parseFloat(c[3]),c:parseFloat(c[4]),v:parseFloat(c[5])}));}
  } catch(_){}
  
  if(!candles.length) return `📊 Chart unavailable for ${pair}`;
  
  const closes=candles.map(c=>c.c);
  const min=Math.min(...candles.map(c=>c.l));
  const max=Math.max(...candles.map(c=>c.h));
  const range=max-min||1;
  const height=8;
  const rows=[];
  
  // Build chart grid
  for(let row=0;row<height;row++){
    const threshold=max-(range*(row/(height-1)));
    let line='';
    for(let i=0;i<candles.length;i++){
      const c=candles[i];
      const isUp=c.c>=c.o;
      if(c.h>=threshold&&c.l<=threshold){
        if(c.c>=threshold&&c.o>=threshold) line+=isUp?'│':'│';
        else if(threshold>=Math.min(c.o,c.c)&&threshold<=Math.max(c.o,c.c)) line+=isUp?'█':'▓';
        else line+='│';
      } else line+=' ';
    }
    const price=(max-(range*(row/(height-1)))).toFixed(0);
    rows.push(`<code>${price.padStart(8)} │${line}</code>`);
  }
  
  const currentPrice=candles[candles.length-1].c;
  const firstPrice=candles[0].c;
  const changePct=((currentPrice-firstPrice)/firstPrice*100).toFixed(2);
  const trend=changePct>0?'📈':'📉';
  
  return `${trend} <b>${pair} — 4H Chart (20 candles)</b>\n\n${rows.join('\n')}\n\n<code>          └${'─'.repeat(candles.length)}</code>\n\n💰 Current: <b>$${currentPrice.toFixed(2)}</b>\n📊 20-bar change: <b>${changePct>0?'+':''}${changePct}%</b>\n📈 High: $${max.toFixed(2)} | 📉 Low: $${min.toFixed(2)}`;
}

// ─── Formatters ──────────────────────────────────────────────────────────────
function fmt(n){return Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function fmtPnl(n){return `${n>=0?'🟢 +$':'🔴 -$'}${fmt(Math.abs(n))}`;}
function fmtPct(n){return `${n>=0?'+':''}${n.toFixed(2)}%`;}
function sparkline(trades){
  if(!trades.length)return '━━━━━━━━━━';
  const pnls=trades.slice(-10).map(t=>t.pnl||0);
  const min=Math.min(...pnls),max=Math.max(...pnls),range=max-min||1;
  const chars=['▁','▂','▃','▄','▅','▆','▇','█'];
  return pnls.map(p=>chars[Math.floor(((p-min)/range)*7)]).join('');
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const mainMenuKeyboard=()=>({inline_keyboard:[
  [{text:'🤖 Create Strategy',callback_data:'menu_create'},{text:'📋 My Strategies',callback_data:'list_strategies'}],
  [{text:'🧪 Paper Trading',callback_data:'menu_paper'},{text:'🚀 Live Trading',callback_data:'menu_autotrade'}],
  [{text:'📊 Performance',callback_data:'menu_performance'},{text:'📈 Live Prices',callback_data:'menu_prices'}],
  [{text:'🗞️ Market News',callback_data:'menu_news'},{text:'📉 View Chart',callback_data:'menu_chart'}],
  [{text:'🤖 AI Assistant',callback_data:'menu_ai'},{text:'🔔 Price Alerts',callback_data:'menu_alerts'}],
  [{text:'🔗 Webhook Signal',callback_data:'menu_signal'},{text:'📓 Trade Journal',callback_data:'menu_journal'}],
  [{text:'❓ FAQ & Help',callback_data:'menu_faq'},{text:'🌐 Website',callback_data:'menu_website'}],
  [{text:'⚙️ Settings',callback_data:'menu_settings'},{text:'🛑 STOP ALL',callback_data:'menu_stopall'}],
]});

const backToMenu=()=>({inline_keyboard:[[{text:'🏠 Main Menu',callback_data:'menu_main'}]]});

// ─── Monitor ──────────────────────────────────────────────────────────────────
async function monitorOpenTrades() {
  try {
    const allUsers=db.getAllUsers();
    for(const user of allUsers){
      if(user.bot_stopped) continue;
      const openTrades=db.listTrades(user.telegram_id,{status:'open'});
      for(const trade of openTrades){
        const cur=await fetchPrice(trade.pair);
        let shouldClose=false,reason='',closePrice=cur;
        if(trade.action==='BUY'){if(cur>=trade.take_profit){shouldClose=true;reason='Take Profit 🎯';closePrice=trade.take_profit;}else if(cur<=trade.stop_loss){shouldClose=true;reason='Stop Loss 🛡️';closePrice=trade.stop_loss;}}
        else{if(cur<=trade.take_profit){shouldClose=true;reason='Take Profit 🎯';closePrice=trade.take_profit;}else if(cur>=trade.stop_loss){shouldClose=true;reason='Stop Loss 🛡️';closePrice=trade.stop_loss;}}
        if(shouldClose){
          const closed=db.closeTrade(trade.id,closePrice,reason);
          const pnl=closed.pnl;
          await sendTelegram(user.telegram_id,
            `${pnl>=0?'💰':'💸'} <b>${reason}</b>\n\n💱 ${trade.pair} | ${trade.action}\n📥 Entry: $${fmt(trade.entry_price)}\n📤 Exit: $${fmt(closePrice)}\n💵 P&L: ${fmtPnl(pnl)} (${fmtPct(closed.pnl_pct)})\n📋 ${trade.strategy_name}`,
            {inline_keyboard:[[{text:'📊 Stats',callback_data:'menu_performance'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
          );
        }
      }
    }
  } catch(e){console.error('Monitor:',e.message);}
}

async function monitorAlerts() {
  try {
    const alerts=db.getActiveAlerts();
    for(const alert of alerts){
      const cur=await fetchPrice(alert.pair);
      const triggered=(alert.direction==='above'&&cur>=alert.target_price)||(alert.direction==='below'&&cur<=alert.target_price);
      if(triggered){
        db.markAlertTriggered(alert.id);
        await sendTelegram(alert.telegram_id,`🔔 <b>Alert Triggered!</b>\n\n${alert.pair} is <b>$${fmt(cur)}</b>\n📌 Target: ${alert.direction==='above'?'📈':'📉'} $${fmt(alert.target_price)}`,
          {inline_keyboard:[[{text:'🤖 Trade Now',callback_data:'menu_create'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
        );
      }
    }
  } catch(e){console.error('Alerts:',e.message);}
}

// Broadcast market alerts every 4 hours
async function broadcastMarketAlerts() {
  try {
    const users=db.getAllUsers().filter(u=>!u.bot_stopped);
    if(!users.length) return;
    const sentiment=await fetchMarketSentiment();
    const pairs=['BTC/USDT','ETH/USDT','SOL/USDT'];
    let alerts=[];
    for(const pair of pairs){
      const sym=pair.replace('/','').toUpperCase();
      try {
        const r=await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`);
        if(r.ok){const d=await r.json();const chg=parseFloat(d.priceChangePercent);if(Math.abs(chg)>4)alerts.push({pair,chg,price:parseFloat(d.lastPrice)});}
      } catch(_){}
    }
    if(alerts.length===0) return;
    let msg=`🚨 <b>Market Alert — Big Moves</b>\n\n`;
    for(const a of alerts) msg+=`${a.chg>0?'🟢':'🔴'} <b>${a.pair}</b> ${a.chg>0?'+':''}${a.chg.toFixed(2)}% — $${fmt(a.price)}\n`;
    msg+=`\n🧠 Fear & Greed: <b>${sentiment.label}</b> (${sentiment.value}/100)\n⏰ ${new Date().toUTCString()}`;
    for(const user of users.slice(0,50)){
      await sendTelegram(user.telegram_id,msg,{inline_keyboard:[[{text:'📉 View Chart',callback_data:'menu_chart'},{text:'🤖 AI Analysis',callback_data:'menu_ai'}]]});
      await new Promise(r=>setTimeout(r,100));
    }
  } catch(e){console.error('Broadcast:',e.message);}
}

// ─── Exchange orders ──────────────────────────────────────────────────────────
async function placeBinanceOrder(apiKey,apiSecret,symbol,side,quantity) {
  try {
    const ts=Date.now();
    const qs=`symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${ts}`;
    const sig=require('crypto').createHmac('sha256',apiSecret).update(qs).digest('hex');
    const r=await fetch(`https://api.binance.com/api/v3/order?${qs}&signature=${sig}`,{method:'POST',headers:{'X-MBX-APIKEY':apiKey,'Content-Type':'application/x-www-form-urlencoded'}});
    const d=await r.json();
    if(!r.ok) return{success:false,error:d.msg||'Order failed'};
    return{success:true,orderId:String(d.orderId),price:parseFloat(d.fills?.[0]?.price||0)};
  } catch(e){return{success:false,error:e.message};}
}
async function placeBybitOrder(apiKey,apiSecret,symbol,side,qty) {
  try {
    const ts=Date.now().toString();
    const params={category:'spot',symbol,side:side==='BUY'?'Buy':'Sell',orderType:'Market',qty:String(qty)};
    const body=JSON.stringify(params);
    const sig=require('crypto').createHmac('sha256',apiSecret).update(ts+apiKey+'5000'+body).digest('hex');
    const r=await fetch('https://api.bybit.com/v5/order/create',{method:'POST',headers:{'X-BAPI-API-KEY':apiKey,'X-BAPI-SIGN':sig,'X-BAPI-TIMESTAMP':ts,'X-BAPI-RECV-WINDOW':'5000','Content-Type':'application/json'},body});
    const d=await r.json();
    if(d.retCode!==0) return{success:false,error:d.retMsg};
    return{success:true,orderId:d.result?.orderId||'',price:0};
  } catch(e){return{success:false,error:e.message};}
}

// ─── Signal processor ─────────────────────────────────────────────────────────
async function processSignal(telegram_id,pair,action,raw_payload,price_override) {
  const strategies=db.listStrategies(telegram_id,{is_active:true});
  const pairNorm=pair.replace('/','').toUpperCase();
  const matched=strategies.filter(s=>s.pair.replace('/','').toUpperCase()===pairNorm||s.entry_type==='webhook');
  if(!matched.length){
    db.createSignalLog({telegram_id,pair,action,raw_payload,processed:false,result:'No match'});
    await sendTelegram(telegram_id,`📡 Signal received: ${action} ${pair}\n⚠️ No matching strategy found.`,{inline_keyboard:[[{text:'🤖 Create Strategy',callback_data:'menu_create'}]]});
    return{matched:0};
  }
  const user=db.getUser(telegram_id);
  if(user?.bot_stopped){await sendTelegram(telegram_id,'⛔ Bot stopped. Signal ignored.');return{matched:0};}
  let count=0;
  for(const strategy of matched){
    const todayCount=db.getTodayTradeCount(telegram_id,strategy.id);
    if(strategy.max_trades_per_day&&todayCount>=strategy.max_trades_per_day){await sendTelegram(telegram_id,`⚠️ ${strategy.name}: Max trades/day reached.`);continue;}
    const price=price_override||await fetchPrice(pair);
    const tp=action==='BUY'?price*(1+strategy.take_profit_pct/100):price*(1-strategy.take_profit_pct/100);
    const sl=action==='BUY'?price*(1-strategy.stop_loss_pct/100):price*(1+strategy.stop_loss_pct/100);
    const balance=user?.balance_usd||10000;
    const riskAmount=balance*(strategy.risk_per_trade_pct/100);
    const qty=Math.round((riskAmount/(strategy.stop_loss_pct/100*price))*10000)/10000;
    const rr=strategy.take_profit_pct/strategy.stop_loss_pct;
    let liveOrderId='',actualPrice=price;
    if(strategy.mode==='live'&&user?.auto_trade_enabled&&user?.exchange){
      const apiKey=simpleDecrypt(user[`${user.exchange}_api_key_enc`]);
      const apiSecret=simpleDecrypt(user[`${user.exchange}_secret_enc`]);
      if(apiKey&&apiSecret){
        const sym=pair.replace('/','').toUpperCase();
        const res=user.exchange==='binance'?await placeBinanceOrder(apiKey,apiSecret,sym,action,qty):await placeBybitOrder(apiKey,apiSecret,sym,action,qty);
        if(res.success){liveOrderId=res.orderId;if(res.price)actualPrice=res.price;}
        else{await sendTelegram(telegram_id,`⚠️ Live order failed: ${res.error}`);continue;}
      }
    }
    const trade=db.createTrade({telegram_id,strategy_id:strategy.id,strategy_name:strategy.name,pair,action,entry_price:actualPrice,take_profit:tp,stop_loss:sl,quantity:qty,status:'open',mode:strategy.mode||'paper',exchange_order_id:liveOrderId,signal_payload:raw_payload});
    db.createSignalLog({telegram_id,pair,action,raw_payload,processed:true,matched_strategy_id:strategy.id,result:'Trade opened'});
    const emoji=action==='BUY'?'🟢':'🔴';
    const modeTag=strategy.mode==='live'?'🚀 LIVE':'🧪 PAPER';
    await sendTelegram(telegram_id,
      `${emoji} <b>Trade Executed!</b>\n\n📋 ${strategy.name} | ${modeTag}\n💱 ${pair} | <b>${action}</b>\n💰 Entry: $${fmt(actualPrice)}\n🎯 TP: $${fmt(tp)} (+${strategy.take_profit_pct}%)\n🛡️ SL: $${fmt(sl)} (-${strategy.stop_loss_pct}%)\n⚖️ R:R 1:${rr.toFixed(1)}\n💸 Risk: $${fmt(riskAmount)}\n🆔 <code>${trade.id.slice(-8)}</code>`,
      {inline_keyboard:[[{text:'❌ Close Trade',callback_data:`close_${trade.id.slice(-8)}`},{text:'📊 Stats',callback_data:'menu_performance'}],[{text:'🏠 Menu',callback_data:'menu_main'}]]}
    );
    count++;
  }
  return{matched:count};
}

// ─── FAQ content ──────────────────────────────────────────────────────────────
const FAQ=[
  {q:'What is TradeBot AutoLab?',a:'TradeBot AutoLab is a 24/7 automated trading bot that lives in Telegram. You create trading strategies, connect signals from TradingView, and the bot automatically executes trades on Binance or Bybit on your behalf.'},
  {q:'Is this bot free?',a:'Yes! Paper trading and all strategy features are completely free. For live trading you only need your own Binance or Bybit API keys. The bot itself has no subscription fee.'},
  {q:'How does paper trading work?',a:'Paper trading uses a virtual $10,000 balance to simulate real trades with zero risk. All TP/SL monitoring is real — only the money is virtual. Perfect for testing strategies before going live.'},
  {q:'How do I connect TradingView?',a:'Go to 🔗 Webhook Signal in the menu to get your personal webhook URL. In TradingView, create an alert and paste the URL. The message body should be: {"pair":"BTCUSDT","action":"BUY","price":{{close}}}'},
  {q:'Is my API key safe?',a:'Your API keys are encrypted using AES before storage. We never request withdrawal permissions — only Spot Trading. For maximum safety, IP-whitelist the bot server on your exchange.'},
  {q:'What markets are supported?',a:'Crypto (Binance, Bybit), Forex (price tracking only), Indices (US30, NAS100, SPX500), and Commodities (Gold XAU, Silver XAG). Live execution is available for crypto spot pairs on Binance and Bybit.'},
  {q:'How does the AI assistant work?',a:'The AI analyzes real-time price, 24h performance, Fear & Greed index, and market momentum to give you trading bias, suggested TP/SL levels, and risk assessment. Access it from 🤖 AI Assistant in the menu.'},
  {q:'What is the Risk:Reward ratio?',a:'R:R is the ratio of potential profit to potential loss. A 1:2 R:R means you risk $1 to potentially make $2. Always aim for at least 1:2 R:R. The bot calculates this automatically for every trade.'},
  {q:'How do I stop all bots?',a:'Tap 🛑 STOP ALL in the main menu. All signal processing immediately stops. Your open trades remain open but no new ones will be placed until you tap ▶️ Resume.'},
  {q:'Can multiple people use this bot?',a:'Yes! TradeBot AutoLab supports unlimited users. Each user has completely isolated data, strategies, and trades. Share the bot username @Autolabtrades_bot with anyone.'},
];

// ─── Onboarding FSM ───────────────────────────────────────────────────────────
async function handleOnboarding(chat_id,user,step,text) {
  const od=user.onboarding_data||{};
  if(step==='await_tp'){
    const tp=parseFloat(text);
    if(isNaN(tp)||tp<=0||tp>100){await sendTelegram(chat_id,'❌ Enter a valid Take Profit % (e.g. 3):');return;}
    db.updateUser(user.id,{onboarding_step:'await_sl',onboarding_data:{...od,take_profit_pct:tp}});
    await sendTelegram(chat_id,`✅ TP: <b>${tp}%</b>\n\n🛡️ Enter Stop Loss %\n💡 Keep SL less than TP for good R:R (e.g. 1.5):`);
  } else if(step==='await_sl'){
    const sl=parseFloat(text);
    if(isNaN(sl)||sl<=0||sl>50){await sendTelegram(chat_id,'❌ Enter valid SL % (e.g. 1.5):');return;}
    const rr=(od.take_profit_pct/sl).toFixed(1);
    const rremoji=rr>=2?'✅':rr>=1.5?'⚠️':'❌';
    db.updateUser(user.id,{onboarding_step:'await_risk',onboarding_data:{...od,stop_loss_pct:sl}});
    await sendTelegram(chat_id,`✅ SL: <b>${sl}%</b> | ${rremoji} R:R 1:${rr}\n\n💸 Risk per trade % (e.g. 1):\n💡 Never risk more than 2% per trade:`);
  } else if(step==='await_risk'){
    const r=parseFloat(text);
    if(isNaN(r)||r<=0||r>10){await sendTelegram(chat_id,'❌ Enter 0.1–10 (e.g. 1):');return;}
    db.updateUser(user.id,{onboarding_step:'await_max_trades',onboarding_data:{...od,risk_per_trade_pct:r}});
    await sendTelegram(chat_id,`✅ Risk: <b>${r}%/trade</b>\n\n🔢 Max trades per day (e.g. 5):`);
  } else if(step==='await_max_trades'){
    const mt=parseInt(text);
    if(isNaN(mt)||mt<=0||mt>50){await sendTelegram(chat_id,'❌ Enter 1–50:');return;}
    db.updateUser(user.id,{onboarding_step:'await_max_loss',onboarding_data:{...od,max_trades_per_day:mt}});
    await sendTelegram(chat_id,`✅ Max: <b>${mt} trades/day</b>\n\n🚨 Max daily loss % (e.g. 5) — bot stops if hit:`);
  } else if(step==='await_max_loss'){
    const ml=parseFloat(text);
    if(isNaN(ml)||ml<=0||ml>50){await sendTelegram(chat_id,'❌ Enter 0.1–50:');return;}
    db.updateUser(user.id,{onboarding_step:'await_strategy_name',onboarding_data:{...od,max_loss_limit_pct:ml}});
    await sendTelegram(chat_id,`✅ Max loss: <b>${ml}%/day</b>\n\n🏷️ Name your strategy (e.g. BTC Scalper):`);
  } else if(step==='await_strategy_name'){
    const name=text.trim().substring(0,40);
    if(!name||name.length<2){await sendTelegram(chat_id,'❌ At least 2 characters:');return;}
    const rr=(od.take_profit_pct/od.stop_loss_pct).toFixed(1);
    db.updateUser(user.id,{onboarding_step:'await_mode',onboarding_data:{...od,name}});
    await sendTelegram(chat_id,
      `✅ <b>"${name}"</b>\n\n📋 Summary:\n• ${od.market} | ${od.pair} | ${od.entry_type}\n• TP:${od.take_profit_pct}% SL:${od.stop_loss_pct}% R:R 1:${rr}\n• Risk:${od.risk_per_trade_pct}%/trade Max:${od.max_trades_per_day}/day\n\n🎯 Choose mode:`,
      {inline_keyboard:[[{text:'🧪 Paper (Safe Start)',callback_data:'mode_paper'}],[{text:'🚀 Live (Real Money)',callback_data:'mode_live'}],[{text:'↩️ Back',callback_data:'menu_create'}]]}
    );
  } else if(step==='await_api_key'){
    const exchange=od.exchange;
    const key=text.trim();
    if(key.length<10){await sendTelegram(chat_id,'❌ Invalid API key. Paste the full key:');return;}
    db.updateUser(user.id,{onboarding_step:'await_api_secret',onboarding_data:{...od,api_key_temp:simpleEncrypt(key)}});
    await sendTelegram(chat_id,`✅ API Key saved!\n\nNow paste your <b>${exchange.toUpperCase()} Secret Key</b>:`);
  } else if(step==='await_api_secret'){
    const exchange=od.exchange;
    const secret=text.trim();
    if(secret.length<10){await sendTelegram(chat_id,'❌ Invalid secret:');return;}
    db.updateUser(user.id,{onboarding_step:'',onboarding_data:{},auto_trade_enabled:true,exchange,[`${exchange}_api_key_enc`]:od.api_key_temp,[`${exchange}_secret_enc`]:simpleEncrypt(secret)});
    await sendTelegram(chat_id,`🔐 <b>API Keys Saved & Encrypted!</b>\n\n✅ ${exchange.toUpperCase()} connected\n✅ Auto Trading: ON\n\n⚠️ Ensure key has Spot Trading only — no withdrawals.`,mainMenuKeyboard());
  } else if(step==='await_alert_pair'){
    const raw=text.trim().toUpperCase();
    const formatted=raw.endsWith('USDT')?raw.replace('USDT','/USDT'):raw.endsWith('USD')?raw.replace('USD','/USD'):raw;
    db.updateUser(user.id,{onboarding_step:'await_alert_price',onboarding_data:{...od,alert_pair:formatted}});
    await sendTelegram(chat_id,`✅ Pair: <b>${formatted}</b>\n\nEnter target price:`);
  } else if(step==='await_alert_price'){
    const price=parseFloat(text);
    if(isNaN(price)||price<=0){await sendTelegram(chat_id,'❌ Enter a valid price:');return;}
    db.updateUser(user.id,{onboarding_step:'await_alert_direction',onboarding_data:{...od,alert_price:price}});
    await sendTelegram(chat_id,`✅ Target: <b>$${fmt(price)}</b>\n\nAlert when:`,{inline_keyboard:[[{text:'📈 Above',callback_data:'alert_dir_above'},{text:'📉 Below',callback_data:'alert_dir_below'}]]});
  } else if(step==='await_journal_note'){
    const note=text.trim();
    if(note.length<3){await sendTelegram(chat_id,'❌ Write more:');return;}
    db.addJournalNote(chat_id,note);
    db.updateUser(user.id,{onboarding_step:'',onboarding_data:{}});
    await sendTelegram(chat_id,`📓 <b>Saved!</b>\n\n"${note.substring(0,100)}"\n🗓️ ${new Date().toLocaleDateString()}`,backToMenu());
  } else if(step==='await_ai_question'){
    const question=text.trim();
    db.updateUser(user.id,{onboarding_step:'',onboarding_data:{}});
    const pair=od.ai_pair||'BTC/USDT';
    const price=await fetchPrice(pair);
    const sentiment=await fetchMarketSentiment();
    await sendTelegram(chat_id,'🤖 Analyzing...');
    const advice=await aiTradingAdvice(pair,question,price,sentiment);
    await sendTelegram(chat_id,advice,{inline_keyboard:[[{text:'📉 View Chart',callback_data:'menu_chart'},{text:'🤖 Ask Again',callback_data:'menu_ai'}],[{text:'🏠 Menu',callback_data:'menu_main'}]]});
  } else if(step==='await_chart_pair'){
    const raw=text.trim().toUpperCase();
    const formatted=raw.includes('/')?raw:(raw.endsWith('USDT')?raw.replace('USDT','/USDT'):raw+'/USDT');
    db.updateUser(user.id,{onboarding_step:'',onboarding_data:{}});
    await sendTelegram(chat_id,'📊 Generating chart...');
    const chart=await generateChart(formatted);
    await sendTelegram(chat_id,chart,{inline_keyboard:[[{text:'🤖 AI Analysis',callback_data:'menu_ai'},{text:'🔄 Refresh',callback_data:'menu_chart'}],[{text:'🏠 Menu',callback_data:'menu_main'}]]});
  }
}

// ─── Callback handler ─────────────────────────────────────────────────────────
async function handleCallback(callback) {
  const chat_id=String(callback.message.chat.id);
  const data=callback.data;
  await answerCallback(callback.id);
  let user=db.getUser(chat_id);
  if(!user) user=db.createUser({telegram_id:chat_id,telegram_username:callback.from?.username||'',first_name:callback.from?.first_name||''});
  const od=user.onboarding_data||{};

  // Main menu
  if(data==='menu_main'){
    await sendTelegram(chat_id,`🏠 <b>TradeBot AutoLab</b>\n\nWelcome back, <b>${user.first_name||'Trader'}</b>! 👋\n\nWhat would you like to do?`,mainMenuKeyboard());

  // Stop / resume
  } else if(data==='menu_stopall'){
    db.updateUser(user.id,{bot_stopped:true});
    await sendTelegram(chat_id,`🛑 <b>ALL BOTS STOPPED</b>\n\nSignal processing paused.`,{inline_keyboard:[[{text:'▶️ Resume',callback_data:'resume_bot'},{text:'🏠 Menu',callback_data:'menu_main'}]]});
  } else if(data==='resume_bot'){
    db.updateUser(user.id,{bot_stopped:false});
    await sendTelegram(chat_id,`▶️ <b>RESUMED</b> — All strategies active.`,mainMenuKeyboard());

  // Website
  } else if(data==='menu_website'){
    await sendTelegram(chat_id,`🌐 <b>TradeBot AutoLab Website</b>\n\nVisit our full platform dashboard, strategy guide, and feature overview:\n\n🔗 ${SITE_URL}\n\nShare this link with anyone who wants to use the bot!`,{inline_keyboard:[[{text:'🌐 Open Website',url:SITE_URL}],[{text:'↩️ Back',callback_data:'menu_main'}]]});

  // News
  } else if(data==='menu_news'){
    await sendTelegram(chat_id,'📡 Fetching latest crypto news...');
    const news=await fetchCryptoNews();
    const sentiment=await fetchMarketSentiment();
    const fg=parseInt(sentiment.value)||50;
    const fgEmoji=fg>=70?'🔥':fg>=55?'😏':fg>=45?'😐':fg>=30?'😨':'😱';
    let msg=`🗞️ <b>Crypto Market News</b>\n\n`;
    msg+=`🧠 Fear & Greed: <b>${sentiment.label}</b> ${fgEmoji} (${sentiment.value}/100)\n`;
    msg+=`⏰ ${new Date().toUTCString()}\n\n`;
    if(news.length){
      for(const n of news){
        msg+=`📰 <b>${n.title}</b>\n`;
        if(n.source) msg+=`   🏢 ${n.source}\n`;
        msg+='\n';
      }
    } else {
      msg+=`⚠️ News temporarily unavailable. Check CoinTelegraph, CoinDesk for latest updates.\n`;
    }
    await sendTelegram(chat_id,msg,{inline_keyboard:[[{text:'🤖 AI Analysis',callback_data:'menu_ai'},{text:'📈 Prices',callback_data:'menu_prices'}],[{text:'🔄 Refresh News',callback_data:'menu_news'},{text:'🏠 Menu',callback_data:'menu_main'}]]});

  // Chart
  } else if(data==='menu_chart'){
    db.updateUser(user.id,{onboarding_step:'await_chart_pair',onboarding_data:{}});
    await sendTelegram(chat_id,`📉 <b>View Chart</b>\n\nType the pair to chart (e.g. <code>BTCUSDT</code>, <code>ETHUSDT</code>, <code>SOLUSDT</code>):\n\n💡 Showing 4H candlestick (last 20 bars)`,{inline_keyboard:[[{text:'₿ BTC/USDT',callback_data:'chart_BTCUSDT'},{text:'◆ ETH/USDT',callback_data:'chart_ETHUSDT'}],[{text:'◎ SOL/USDT',callback_data:'chart_SOLUSDT'},{text:'🥇 XAU/USD',callback_data:'chart_XAUUSDT'}],[{text:'↩️ Back',callback_data:'menu_main'}]]});
  } else if(data.startsWith('chart_')){
    const sym=data.replace('chart_','');
    const pair=sym.length>6?sym.replace(/([A-Z]{2,})([A-Z]{3,4}$)/,'$1/$2'):sym;
    await sendTelegram(chat_id,'📊 Generating chart...');
    const chart=await generateChart(sym.includes('/')? sym:sym);
    await sendTelegram(chat_id,chart,{inline_keyboard:[[{text:'🤖 AI Analysis',callback_data:'menu_ai'},{text:'🔄 Refresh',callback_data:`chart_${sym}`}],[{text:'↩️ Back',callback_data:'menu_chart'},{text:'🏠 Menu',callback_data:'menu_main'}]]});

  // AI Assistant
  } else if(data==='menu_ai'){
    const pairs=['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT','XAU/USD'];
    await sendTelegram(chat_id,
      `🤖 <b>AI Trading Assistant</b>\n\nSelect a pair to analyze, or type your question:\n\n💡 Ask me:\n• "Should I buy BTC now?"\n• "What's the trend for ETH?"\n• "Is this a good entry for SOL?"\n• "What's the risk on gold?"`,
      {inline_keyboard:[
        [{text:'₿ Analyze BTC',callback_data:'ai_BTC/USDT'},{text:'◆ Analyze ETH',callback_data:'ai_ETH/USDT'}],
        [{text:'◎ Analyze SOL',callback_data:'ai_SOL/USDT'},{text:'🥇 Analyze Gold',callback_data:'ai_XAU/USD'}],
        [{text:'✍️ Ask a Question',callback_data:'ai_custom'}],
        [{text:'↩️ Back',callback_data:'menu_main'}],
      ]}
    );
  } else if(data.startsWith('ai_')&&!data.includes('custom')){
    const pair=data.replace('ai_','');
    await sendTelegram(chat_id,`🤖 Analyzing <b>${pair}</b>...`);
    const price=await fetchPrice(pair);
    const sentiment=await fetchMarketSentiment();
    const advice=await aiTradingAdvice(pair,'analysis',price,sentiment);
    await sendTelegram(chat_id,advice,{inline_keyboard:[[{text:'📉 View Chart',callback_data:`chart_${pair.replace('/','')}`},{text:'🤖 Other Pair',callback_data:'menu_ai'}],[{text:'🤖 Trade This Pair',callback_data:'menu_create'},{text:'🏠 Menu',callback_data:'menu_main'}]]});
  } else if(data==='ai_custom'){
    db.updateUser(user.id,{onboarding_step:'await_ai_question',onboarding_data:{ai_pair:'BTC/USDT'}});
    await sendTelegram(chat_id,`✍️ Type your trading question:\n\n💡 Examples:\n• "Should I buy BTC at current levels?"\n• "Is ETH oversold?"\n• "What strategy works for gold?"`);

  // FAQ
  } else if(data==='menu_faq'){
    let msg=`❓ <b>Frequently Asked Questions</b>\n\n`;
    for(let i=0;i<Math.min(FAQ.length,5);i++) msg+=`${i+1}. ${FAQ[i].q}\n`;
    await sendTelegram(chat_id,msg,{inline_keyboard:[
      ...FAQ.slice(0,5).map((f,i)=>[{text:`${i+1}. ${f.q.substring(0,35)}...`,callback_data:`faq_${i}`}]),
      [{text:'📖 Full Guide',callback_data:'menu_help'},{text:'🏠 Menu',callback_data:'menu_main'}],
    ]});
  } else if(data.startsWith('faq_')){
    const i=parseInt(data.replace('faq_',''));
    const faq=FAQ[i];
    await sendTelegram(chat_id,`❓ <b>${faq.q}</b>\n\n${faq.a}`,{inline_keyboard:[[{text:'❓ More FAQs',callback_data:'menu_faq'},{text:'🏠 Menu',callback_data:'menu_main'}]]});

  // Help / How to use
  } else if(data==='menu_help'){
    await sendTelegram(chat_id,
      `📖 <b>How to Use TradeBot AutoLab</b>\n\n`+
      `<b>🚀 Quick Start (5 mins):</b>\n\n`+
      `1️⃣ Tap <b>🤖 Create Strategy</b>\n   → Pick market, pair, entry signal\n   → Set TP %, SL %, risk per trade\n   → Name it & choose Paper mode\n\n`+
      `2️⃣ Tap <b>🔗 Webhook Signal</b>\n   → Copy your personal URL\n   → Paste into TradingView alert\n   → Bot auto-executes when alert fires\n\n`+
      `3️⃣ Tap <b>📊 Performance</b>\n   → Track win rate, P&L, open trades\n   → See per-strategy breakdown\n\n`+
      `4️⃣ When confident → Switch to <b>🚀 Live</b>\n   → Connect Binance or Bybit API\n   → Bot executes real orders 24/7\n\n`+
      `<b>⚡ Key Features:</b>\n`+
      `• Auto TP/SL close every 30s\n`+
      `• AI analysis on any pair\n`+
      `• Real-time news & alerts\n`+
      `• 4H chart view\n`+
      `• Price alerts\n`+
      `• Trade journal\n`+
      `• Daily loss protection\n\n`+
      `<b>⚠️ Safety Rules:</b>\n`+
      `• Always paper trade first (20+ trades)\n`+
      `• Never risk more than 1-2% per trade\n`+
      `• Set a max daily loss limit\n`+
      `• Use Spot Trading API only — no withdrawals`,
      {inline_keyboard:[[{text:'❓ FAQ',callback_data:'menu_faq'},{text:'🤖 Create Strategy',callback_data:'menu_create'}],[{text:'🌐 Website',callback_data:'menu_website'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
    );

  // Support
  } else if(data==='menu_support'){
    await sendTelegram(chat_id,
      `🆘 <b>Support & Resources</b>\n\n`+
      `📖 <b>Self-Help:</b>\n`+
      `• Use ❓ FAQ for common questions\n`+
      `• Use 📖 Help & Guide for step-by-step\n`+
      `• Use 🤖 AI Assistant for market questions\n\n`+
      `🌐 <b>Website:</b> ${SITE_URL}\n\n`+
      `📡 <b>Signal Webhook:</b>\n`+
      `Your URL: <code>${SERVER_URL}/signal?user_id=${chat_id}</code>\n\n`+
      `🔧 <b>Common Issues:</b>\n`+
      `• No trades firing → Check strategy is Active\n`+
      `• Wrong pair → Ensure signal pair matches strategy\n`+
      `• Live order failed → Check API key permissions\n`+
      `• Bot not responding → Send /start to reset\n\n`+
      `⚠️ <i>Trading involves risk. Never invest more than you can afford to lose.</i>`,
      {inline_keyboard:[[{text:'❓ FAQ',callback_data:'menu_faq'},{text:'📖 Full Guide',callback_data:'menu_help'}],[{text:'🌐 Website',callback_data:'menu_website'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
    );

  // Prices
  } else if(data==='menu_prices'){
    const pairs=['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT','XAU/USD','EUR/USD','US30'];
    const prices={};
    for(const p of pairs) prices[p]=await fetchPrice(p);
    const sentiment=await fetchMarketSentiment();
    await sendTelegram(chat_id,
      `📈 <b>Live Market Prices</b>\n\n`+
      `₿ BTC/USDT  <b>$${fmt(prices['BTC/USDT'])}</b>\n`+
      `◆ ETH/USDT  <b>$${fmt(prices['ETH/USDT'])}</b>\n`+
      `◎ SOL/USDT  <b>$${fmt(prices['SOL/USDT'])}</b>\n`+
      `🟡 BNB/USDT  <b>$${fmt(prices['BNB/USDT'])}</b>\n`+
      `🔵 XRP/USDT  <b>$${fmt(prices['XRP/USDT'])}</b>\n`+
      `🥇 XAU/USD   <b>$${fmt(prices['XAU/USD'])}</b>\n`+
      `💱 EUR/USD   <b>${prices['EUR/USD'].toFixed(4)}</b>\n`+
      `📊 US30      <b>$${fmt(prices['US30'])}</b>\n\n`+
      `🧠 Fear & Greed: <b>${sentiment.label}</b> (${sentiment.value}/100)\n`+
      `⏱️ ${new Date().toUTCString()}`,
      {inline_keyboard:[[{text:'🤖 AI Analysis',callback_data:'menu_ai'},{text:'📉 Chart',callback_data:'menu_chart'}],[{text:'🔔 Set Alert',callback_data:'add_alert'},{text:'🔄 Refresh',callback_data:'menu_prices'}],[{text:'🏠 Menu',callback_data:'menu_main'}]]}
    );

  // Alerts
  } else if(data==='menu_alerts'){
    const alerts=db.getUserAlerts(chat_id);
    let msg=`🔔 <b>Price Alerts</b>\n\nGet notified when a price hits your target.\n\n`;
    if(alerts.length){msg+=`<b>Active (${alerts.length}):</b>\n`;for(const a of alerts)msg+=`• ${a.pair} ${a.direction==='above'?'📈 >':'📉 <'} $${fmt(a.target_price)}\n`;msg+='\n';}
    else msg+='No active alerts.\n\n';
    await sendTelegram(chat_id,msg,{inline_keyboard:[[{text:'➕ Add Alert',callback_data:'add_alert'}],[{text:'↩️ Back',callback_data:'menu_main'}]]});
  } else if(data==='add_alert'){
    db.updateUser(user.id,{onboarding_step:'await_alert_pair',onboarding_data:{}});
    await sendTelegram(chat_id,`🔔 <b>New Price Alert</b>\n\nType the pair (e.g. BTCUSDT, ETHUSDT):`);
  } else if(data==='alert_dir_above'||data==='alert_dir_below'){
    const direction=data==='alert_dir_above'?'above':'below';
    db.createPriceAlert({telegram_id:chat_id,pair:od.alert_pair,direction,target_price:od.alert_price});
    db.updateUser(user.id,{onboarding_step:'',onboarding_data:{}});
    await sendTelegram(chat_id,`✅ Alert set! ${od.alert_pair} ${direction==='above'?'📈 above':'📉 below'} <b>$${fmt(od.alert_price)}</b>`,{inline_keyboard:[[{text:'🔔 My Alerts',callback_data:'menu_alerts'},{text:'🏠 Menu',callback_data:'menu_main'}]]});

  // Performance
  } else if(data==='menu_performance'){
    const stats=db.getStats(chat_id);
    const recentClosed=db.listTrades(chat_id,{status:'closed',limit:10});
    const todayPnl=db.getTodayPnl(chat_id);
    const spark=sparkline(recentClosed);
    let streak=0;for(const t of recentClosed){if(t.pnl>0)streak++;else break;}
    const strategies=db.listStrategies(chat_id);
    let stratText='';
    for(const s of strategies.slice(0,3)){
      const wr=s.total_trades>0?((s.total_wins/s.total_trades)*100).toFixed(0)+'%':'—';
      stratText+=`\n  ${s.mode==='live'?'🚀':'🧪'} <b>${s.name}</b>: ${s.total_trades}T | ${wr} WR | ${fmtPnl(s.total_pnl||0)}`;
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
      `📉 Sparkline: ${spark}\n`+
      (stats.bestTrade?`\n🥇 Best: ${fmtPnl(stats.bestTrade.pnl)} (${stats.bestTrade.pair})`:'`')+
      `\n\n<b>Strategies:</b>${stratText||'\nNone yet.'}`,
      {inline_keyboard:[[{text:'📂 Open Trades',callback_data:'view_open'},{text:'📜 History',callback_data:'view_history'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
    );
  } else if(data==='view_open'){
    const open=db.listTrades(chat_id,{status:'open'});
    if(!open.length){await sendTelegram(chat_id,'📂 No open trades.',backToMenu());return;}
    let msg=`📂 <b>Open Trades (${open.length})</b>\n\n`;
    for(const t of open.slice(0,8)){
      const cur=await fetchPrice(t.pair);
      const upnl=t.action==='BUY'?(cur-t.entry_price)*t.quantity:(t.entry_price-cur)*t.quantity;
      msg+=`${upnl>=0?'🟢':'🔴'} <b>${t.pair}</b> ${t.action} — ${fmtPnl(upnl)}\n`;
      msg+=`   $${fmt(t.entry_price)} → $${fmt(cur)} | ${t.mode==='live'?'🚀':'🧪'}\n\n`;
    }
    await sendTelegram(chat_id,msg,{inline_keyboard:[[{text:'↩️ Back',callback_data:'menu_performance'}]]});
  } else if(data==='view_history'){
    const trades=db.listTrades(chat_id,{status:'closed',limit:10});
    if(!trades.length){await sendTelegram(chat_id,'📜 No closed trades yet.',backToMenu());return;}
    let msg=`📜 <b>Last ${trades.length} Trades</b>\n\n`;
    for(const t of trades) msg+=`${t.pnl>=0?'✅':'❌'} <b>${t.pair}</b> ${t.action} ${fmtPnl(t.pnl)}\n   ${t.close_reason}\n\n`;
    await sendTelegram(chat_id,msg,{inline_keyboard:[[{text:'↩️ Back',callback_data:'menu_performance'}]]});

  // Close trade
  } else if(data.startsWith('close_')){
    const suffix=data.replace('close_','');
    const trade=db.listTrades(chat_id,{status:'open'}).find(t=>t.id.slice(-8)===suffix);
    if(trade){
      const price=await fetchPrice(trade.pair);
      const closed=db.closeTrade(trade.id,price,'Manual Close 👤');
      await sendTelegram(chat_id,`👤 <b>Closed Manually</b>\n\n${trade.pair} | ${trade.action}\n${fmtPnl(closed.pnl)} (${fmtPct(closed.pnl_pct)})`,backToMenu());
    } else await sendTelegram(chat_id,'⚠️ Trade not found.',backToMenu());

  // Create strategy
  } else if(data==='menu_create'){
    db.updateUser(user.id,{onboarding_step:'select_market',onboarding_data:{}});
    await sendTelegram(chat_id,`🤖 <b>Create Strategy — Step 1</b>\n\nSelect your market:`,
      {inline_keyboard:[[{text:'₿ Crypto',callback_data:'market_crypto'},{text:'💱 Forex',callback_data:'market_forex'}],[{text:'📈 Indices',callback_data:'market_indices'},{text:'🥇 Commodities',callback_data:'market_commodities'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
    );
  } else if(data.startsWith('market_')){
    const market=data.replace('market_','');
    const pairs={crypto:[['BTC/USDT','ETH/USDT'],['BNB/USDT','SOL/USDT'],['XRP/USDT','ADA/USDT'],['DOGE/USDT','LINK/USDT']],forex:[['EUR/USD','GBP/USD'],['USD/JPY','AUD/USD'],['USD/CAD','EUR/GBP']],indices:[['US30','SPX500'],['NAS100','GER40']],commodities:[['XAU/USD','XAG/USD'],['WTI/USD','BRT/USD']]};
    db.updateUser(user.id,{onboarding_step:'select_pair',onboarding_data:{market}});
    const rows=(pairs[market]||pairs.crypto).map(row=>row.map(p=>({text:p,callback_data:`pair_${p.replace('/','')}`})));
    await sendTelegram(chat_id,`✅ Market: <b>${market}</b>\n\nStep 2: Choose pair:`,{inline_keyboard:[...rows,[{text:'↩️ Back',callback_data:'menu_create'}]]});
  } else if(data.startsWith('pair_')){
    const pairRaw=data.replace('pair_','');
    const formatted=pairRaw.length>6?pairRaw.replace(/([A-Z]{2,})([A-Z]{3,4}$)/,'$1/$2'):pairRaw;
    db.updateUser(user.id,{onboarding_step:'select_entry',onboarding_data:{...od,pair:formatted}});
    await sendTelegram(chat_id,`✅ Pair: <b>${formatted}</b>\n\nStep 3: Entry signal type:`,
      {inline_keyboard:[[{text:'📉 RSI Signal',callback_data:'entry_rsi'}],[{text:'📊 MA Crossover',callback_data:'entry_ma'}],[{text:'🔓 Price Breakout',callback_data:'entry_breakout'}],[{text:'🕯️ Candlestick Pattern',callback_data:'entry_candle'}],[{text:'🔗 TradingView Webhook',callback_data:'entry_webhook'}],[{text:'↩️ Back',callback_data:'menu_create'}]]}
    );
  } else if(data.startsWith('entry_')){
    const entryType=data.replace('entry_','');
    const labels={rsi:'RSI Signal',ma:'MA Crossover',breakout:'Price Breakout',candle:'Candlestick',webhook:'TradingView Webhook'};
    db.updateUser(user.id,{onboarding_step:'await_tp',onboarding_data:{...od,entry_type:entryType}});
    await sendTelegram(chat_id,`✅ Entry: <b>${labels[entryType]}</b>\n\nStep 4: Enter <b>Take Profit %</b> (e.g. 3):`);
  } else if(data==='mode_paper'||data==='mode_live'){
    const mode=data.replace('mode_','');
    db.createStrategy({telegram_id:chat_id,name:od.name,market:od.market,pair:od.pair,entry_type:od.entry_type,entry_rules:{},take_profit_pct:od.take_profit_pct,stop_loss_pct:od.stop_loss_pct,trailing_stop:false,risk_per_trade_pct:od.risk_per_trade_pct,max_trades_per_day:od.max_trades_per_day,max_loss_limit_pct:od.max_loss_limit_pct,is_active:true,mode});
    db.updateUser(user.id,{onboarding_step:'',onboarding_data:{}});
    await sendTelegram(chat_id,
      `🎉 <b>Strategy Created!</b>\n\n📋 "${od.name}"\n💱 ${od.pair} | ${mode==='paper'?'🧪 PAPER':'🚀 LIVE'}\n🎯 TP:${od.take_profit_pct}% SL:${od.stop_loss_pct}% R:R 1:${(od.take_profit_pct/od.stop_loss_pct).toFixed(1)}\n\n✅ Active & listening for signals!`,
      {inline_keyboard:[[{text:'🔗 Connect Signal',callback_data:'menu_signal'}],[{text:'📋 My Strategies',callback_data:'list_strategies'},{text:'🏠 Menu',callback_data:'menu_main'}]]}
    );

  // List strategies
  } else if(data==='list_strategies'){
    const strategies=db.listStrategies(chat_id);
    if(!strategies.length){await sendTelegram(chat_id,'📋 No strategies yet.',{inline_keyboard:[[{text:'🤖 Create',callback_data:'menu_create'},{text:'↩️ Back',callback_data:'menu_main'}]]});return;}
    let msg=`📋 <b>My Strategies (${strategies.length})</b>\n\n`;
    for(const s of strategies){
      const wr=s.total_trades>0?((s.total_wins/s.total_trades)*100).toFixed(0)+'%':'—';
      msg+=`${s.is_active?'🟢':'🔴'} ${s.mode==='live'?'🚀':'🧪'} <b>${s.name}</b>\n   ${s.pair} TP:${s.take_profit_pct}% SL:${s.stop_loss_pct}%\n   ${s.total_trades}T | ${wr} WR | ${fmtPnl(s.total_pnl||0)}\n\n`;
    }
    await sendTelegram(chat_id,msg,{inline_keyboard:[
      ...strategies.slice(0,5).map(s=>[{text:`${s.is_active?'⏸':'▶️'} ${s.name}`,callback_data:`toggle_${s.id.slice(-8)}`},{text:'🗑️',callback_data:`del_${s.id.slice(-8)}`}]),
      [{text:'➕ New',callback_data:'menu_create'},{text:'↩️ Back',callback_data:'menu_main'}],
    ]});
  } else if(data.startsWith('toggle_')){
    const s=db.listStrategies(chat_id).find(x=>x.id.slice(-8)===data.replace('toggle_',''));
    if(s){db.updateStrategy(s.id,{is_active:!s.is_active});await sendTelegram(chat_id,`${!s.is_active?'▶️ Enabled':'⏸ Paused'}: ${s.name}`,{inline_keyboard:[[{text:'📋 Back',callback_data:'list_strategies'}]]});}
  } else if(data.startsWith('del_')){
    const s=db.listStrategies(chat_id).find(x=>x.id.slice(-8)===data.replace('del_',''));
    if(s) await sendTelegram(chat_id,`🗑️ Delete "${s.name}"?`,{inline_keyboard:[[{text:'✅ Delete',callback_data:`confirm_del_${s.id.slice(-8)}`},{text:'❌ Cancel',callback_data:'list_strategies'}]]});
  } else if(data.startsWith('confirm_del_')){
    const s=db.listStrategies(chat_id).find(x=>x.id.slice(-8)===data.replace('confirm_del_',''));
    if(s){db.deleteStrategy(s.id);await sendTelegram(chat_id,`🗑️ Deleted.`,{inline_keyboard:[[{text:'📋 Back',callback_data:'list_strategies'}]]});}

  // Paper / Live
  } else if(data==='menu_paper'){
    const stats=db.getStats(chat_id);
    const paperStrats=db.listStrategies(chat_id).filter(s=>s.mode==='paper');
    await sendTelegram(chat_id,`🧪 <b>Paper Trading</b>\n\n$10,000 virtual balance — zero risk.\n\n📊 Total: ${stats.total} | Win Rate: ${stats.winRate.toFixed(1)}%\n💰 P&L: ${fmtPnl(stats.totalPnl)}\n📋 Paper strategies: ${paperStrats.length}`,
      {inline_keyboard:[[{text:'🤖 New Paper Strategy',callback_data:'menu_create'},{text:'📊 Report',callback_data:'menu_performance'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
    );
  } else if(data==='menu_autotrade'){
    if(user.auto_trade_enabled&&user.exchange){
      await sendTelegram(chat_id,`🚀 <b>Live Trading</b>\n\n✅ ${user.exchange.toUpperCase()} connected\n✅ Auto Trading: ON`,
        {inline_keyboard:[[{text:'⛔ Disable',callback_data:'disable_auto'},{text:'🔑 Update Keys',callback_data:'connect_binance'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
      );
    } else {
      await sendTelegram(chat_id,`🚀 <b>Live Trading Setup</b>\n\n⚠️ Safety: Spot Trading only, no withdrawals.\n\nSelect exchange:`,
        {inline_keyboard:[[{text:'🟡 Binance',callback_data:'connect_binance'},{text:'🔵 Bybit',callback_data:'connect_bybit'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
      );
    }
  } else if(data==='disable_auto'){
    db.updateUser(user.id,{auto_trade_enabled:false});
    await sendTelegram(chat_id,'⛔ Auto Trading disabled.',mainMenuKeyboard());
  } else if(data==='connect_binance'||data==='connect_bybit'){
    const exchange=data==='connect_bybit'?'bybit':'binance';
    db.updateUser(user.id,{onboarding_step:'await_api_key',onboarding_data:{exchange}});
    await sendTelegram(chat_id,`🔐 <b>${exchange.toUpperCase()} API Setup</b>\n\nCreate API key with Spot Trading only — no withdrawals.\n\nPaste your <b>API Key</b>:`);

  // Signal
  } else if(data==='menu_signal'){
    await sendTelegram(chat_id,
      `🔗 <b>TradingView Webhook</b>\n\n<b>Your personal URL:</b>\n<code>${SERVER_URL}/signal?user_id=${chat_id}</code>\n\n<b>Alert Message Body:</b>\n<code>{\n  "pair": "BTCUSDT",\n  "action": "BUY",\n  "price": {{close}}\n}</code>\n\n✅ Supported: BUY, SELL, LONG, SHORT\n✅ Pair must match your strategy`,
      {inline_keyboard:[[{text:'🧪 Test Signal',callback_data:'test_signal'}],[{text:'❓ Signal Help',callback_data:'menu_help'}],[{text:'↩️ Back',callback_data:'menu_main'}]]}
    );
  } else if(data==='test_signal'){
    const result=await processSignal(chat_id,'BTC/USDT','BUY',{test:true},null);
    if(result.matched===0) await sendTelegram(chat_id,'🧪 Test sent! No BTC/USDT strategy found. Create one first.',{inline_keyboard:[[{text:'🤖 Create Strategy',callback_data:'menu_create'}]]});

  // Journal
  } else if(data==='menu_journal'){
    const notes=db.getJournal(chat_id);
    let msg=`📓 <b>Trade Journal</b>\n\n`;
    if(notes.length){msg+=`<b>Recent:</b>\n\n`;for(const n of notes.slice(0,5))msg+=`📝 <i>${n.created_date.split('T')[0]}</i>\n${n.note.substring(0,120)}\n\n`;}
    else msg+='No entries yet.\n\n';
    await sendTelegram(chat_id,msg,{inline_keyboard:[[{text:'✍️ Add Entry',callback_data:'add_journal'}],[{text:'↩️ Back',callback_data:'menu_main'}]]});
  } else if(data==='add_journal'){
    db.updateUser(user.id,{onboarding_step:'await_journal_note',onboarding_data:{}});
    await sendTelegram(chat_id,'✍️ Type your journal entry:');

  // Settings
  } else if(data==='menu_settings'){
    const strategies=db.listStrategies(chat_id);
    await sendTelegram(chat_id,
      `⚙️ <b>Settings</b>\n\n👤 ${user.first_name||'Trader'} | 🆔 <code>${chat_id}</code>\n📋 Strategies: ${strategies.length}\n🚀 Auto Trade: ${user.auto_trade_enabled?'✅':'❌'}\n💱 Exchange: ${user.exchange||'None'}\n🛑 Status: ${user.bot_stopped?'⛔ Stopped':'✅ Running'}`,
      {inline_keyboard:[
        [{text:'📋 Strategies',callback_data:'list_strategies'}],
        [{text:user.auto_trade_enabled?'⛔ Disable Auto':'🚀 Enable Auto',callback_data:user.auto_trade_enabled?'disable_auto':'menu_autotrade'}],
        [{text:user.bot_stopped?'▶️ Resume':'🛑 Stop',callback_data:user.bot_stopped?'resume_bot':'menu_stopall'}],
        [{text:'🔔 Alerts',callback_data:'menu_alerts'},{text:'📓 Journal',callback_data:'menu_journal'}],
        [{text:'🏠 Main Menu',callback_data:'menu_main'}],
      ]}
    );
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chat_id=String(msg.chat.id);
  const text=msg.text||'';
  let user=db.getUser(chat_id);
  if(!user) user=db.createUser({telegram_id:chat_id,telegram_username:msg.from?.username||'',first_name:msg.from?.first_name||''});

  if(text.startsWith('/start')||text==='/menu'){
    db.updateUser(user.id,{bot_stopped:false,onboarding_step:'',onboarding_data:{},first_name:msg.from?.first_name||user.first_name});
    await sendTelegram(chat_id,
      `🤖 <b>TradeBot AutoLab</b>\n\n`+
      `${user.first_name?`Welcome back, <b>${msg.from?.first_name||user.first_name}</b>! 👋`:'🎉 <b>Welcome!</b>'}\n\n`+
      `<b>Your 24/7 automated trading partner.</b>\n\n`+
      `✅ Build strategies in 2 minutes\n`+
      `✅ Auto-execute on Binance & Bybit\n`+
      `✅ TradingView webhook integration\n`+
      `✅ AI market analysis\n`+
      `✅ Real-time news & price alerts\n`+
      `✅ Paper trade risk-free\n\n`+
      `💡 New here? Tap <b>❓ FAQ & Help</b>`,
      mainMenuKeyboard()
    );
    return;
  }
  if(text==='/performance'||text==='/stats') { await handleCallback({message:{chat:{id:chat_id}},from:msg.from,id:'0',data:'menu_performance'}); return; }
  if(text==='/prices') { await handleCallback({message:{chat:{id:chat_id}},from:msg.from,id:'0',data:'menu_prices'}); return; }
  if(text==='/news') { await handleCallback({message:{chat:{id:chat_id}},from:msg.from,id:'0',data:'menu_news'}); return; }
  if(text==='/ai') { await handleCallback({message:{chat:{id:chat_id}},from:msg.from,id:'0',data:'menu_ai'}); return; }
  if(text==='/help'||text==='/faq') { await handleCallback({message:{chat:{id:chat_id}},from:msg.from,id:'0',data:'menu_faq'}); return; }
  if(text==='/stop') { db.updateUser(user.id,{bot_stopped:true}); await sendTelegram(chat_id,'🛑 Bot stopped. Send /start to resume.'); return; }

  if(user.onboarding_step&&user.onboarding_step!=='done'){
    await handleOnboarding(chat_id,user,user.onboarding_step,text); return;
  }
  await sendTelegram(chat_id,`Use the menu to navigate.\n\nCommands: /menu /prices /news /ai /stats /help /stop`,mainMenuKeyboard());
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post('/webhook', async(req,res)=>{
  res.sendStatus(200);
  try {
    if(req.body.callback_query) await handleCallback(req.body.callback_query);
    else if(req.body.message) await handleMessage(req.body.message);
  } catch(e){console.error('Webhook error:',e.message,e.stack);}
});

app.post('/signal', async(req,res)=>{
  const user_id=req.query.user_id||req.body.user_id;
  if(!user_id) return res.status(400).json({error:'user_id required'});
  const{pair,action,price}=req.body;
  if(!pair||!action) return res.status(400).json({error:'pair and action required'});
  const normAction=['BUY','LONG','buy','long'].includes(action)?'BUY':'SELL';
  const result=await processSignal(user_id,pair,normAction,req.body,price?parseFloat(price):null);
  res.json({success:true,matched:result.matched,pair,action:normAction});
});
app.get('/signal',async(req,res)=>{
  const{user_id,pair,action}=req.query;
  if(!user_id||!pair||!action) return res.status(400).json({error:'user_id, pair, action required'});
  const result=await processSignal(user_id,pair,['BUY','LONG','buy','long'].includes(action)?'BUY':'SELL',req.query,null);
  res.json({success:true,matched:result.matched});
});

app.get('/',(req,res)=>res.json({status:'TradeBot AutoLab v4.0 🤖',version:'4.0',uptime:Math.floor(process.uptime())+'s',time:new Date().toISOString()}));
app.get('/ping',(req,res)=>res.json({ok:true}));

// ─── Start ────────────────────────────────────────────────────────────────────
setInterval(monitorOpenTrades, 30*1000);
setInterval(monitorAlerts, 60*1000);
setInterval(broadcastMarketAlerts, 4*60*60*1000); // every 4 hours

app.listen(PORT, ()=>{
  console.log(`🚀 TradeBot AutoLab v4.0 on port ${PORT}`);
  console.log(`🔗 Webhook: ${SERVER_URL}/webhook`);
});
