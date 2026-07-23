const express = require('express');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { VM } = require('vm2');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DERIV_APP_ID = '33ST7U3BsaF4rLqIPzd9w';
const DERIV_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;

// ✅ Your Render origin (replace with your exact URL if different)
const MY_ORIGIN = process.env.RENDER_EXTERNAL_URL || 'https://globalfx.onrender.com';

let userTokens = {};
let bots = {};
let priceCache = {};

const DATA_DIR = path.join(__dirname, 'data');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
try { bots = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8')); } catch(e) {}

function saveBots() {
  fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2));
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// ── Market WebSocket (with origin option) ──
let marketWs = null;
function connectMarketWS() {
  marketWs = new WebSocket(DERIV_WS_URL, { origin: MY_ORIGIN });
  marketWs.on('open', () => {
    console.log('Market WS connected');
    marketWs.send(JSON.stringify({ ticks: 'frxEURUSD,frxGBPUSD,frxUSDJPY,frxAUDUSD,frxXAUUSD' }));
  });
  marketWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.tick) {
        const { symbol, quote } = msg.tick;
        priceCache[symbol] = quote;
      }
    } catch(e) {}
  });
  marketWs.on('error', (err) => {
    console.error('Market WS error:', err.message);
  });
  marketWs.on('close', () => {
    console.log('Market WS disconnected – reconnecting in 5s');
    setTimeout(connectMarketWS, 5000);
  });
}
connectMarketWS();

// ── Trade execution WebSocket (with origin option) ──
async function executeTrade(userId, symbol, direction, amount, duration, durationUnit = 't') {
  const token = userTokens[userId];
  if (!token) throw new Error('User token not found');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL, { origin: MY_ORIGIN });
    ws.on('error', (err) => reject(new Error('Trade WS error: ' + err.message)));
    ws.on('open', () => ws.send(JSON.stringify({ authorize: token })));
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.error) { reject(msg.error); ws.close(); return; }
      if (msg.authorize) {
        ws.send(JSON.stringify({
          buy: 1,
          price: amount,
          parameters: {
            contract_type: direction === 'BUY' ? 'CALL' : 'PUT',
            currency: 'USD',
            duration,
            duration_unit: durationUnit,
            symbol,
            amount,
            basis: 'stake',
          },
        }));
      } else if (msg.buy) {
        ws.close();
        resolve(msg.buy);
      }
    });
    setTimeout(() => reject(new Error('Trade timeout')), 15000);
  });
}

// ── Sandbox for custom bots ──
function runCustomBot(code, currentPrice, previousPrice) {
  const vm = new VM({
    timeout: 1000,
    sandbox: { console: null, Math: Math, Date: Date },
  });
  const script = `
    function shouldTrade(currentPrice, previousPrice) {
      ${code}
    }
    shouldTrade(${currentPrice}, ${previousPrice || 0});
  `;
  return vm.run(script);
}

// ── Bot engine ──
setInterval(() => {
  Object.keys(bots).forEach(botId => {
    const bot = bots[botId];
    if (bot.status !== 'active') return;
    const price = priceCache[bot.symbol];
    if (!price) return;

    let trigger = false;
    if (bot.type === 'simple') {
      if (bot.condition.type === 'price_above' && price > bot.condition.value) trigger = true;
      if (bot.condition.type === 'price_below' && price < bot.condition.value) trigger = true;
    } else if (bot.type === 'custom') {
      try {
        trigger = runCustomBot(bot.code, price, bot.lastPrice || 0);
        bot.lastPrice = price;
        saveBots();
      } catch (e) {
        bot.status = 'error';
        bot.error = e.message;
        saveBots();
        return;
      }
    }

    if (trigger) {
      console.log(`Bot ${botId} triggered`);
      executeTrade(bot.userId, bot.symbol, bot.direction, bot.amount, bot.duration, bot.durationUnit)
        .then(() => {
          bot.status = 'completed';
          bot.lastTriggered = Date.now();
          saveBots();
        })
        .catch(err => {
          bot.status = 'error';
          bot.error = err.message;
          saveBots();
        });
    }
  });
}, 1000);

// ── API Routes ──
app.post('/api/auth', (req, res) => {
  const { userId, token } = req.body;
  userTokens[userId] = token;
  res.json({ success: true });
});

app.post('/api/bots', (req, res) => {
  const { userId, symbol, direction, amount, duration, durationUnit, condition } = req.body;
  if (!userId || !symbol || !direction || !amount || !condition)
    return res.status(400).json({ error: 'Missing fields' });
  const botId = Date.now().toString(36) + Math.random().toString(36).substr(2,5);
  bots[botId] = {
    type: 'simple',
    userId, symbol, direction, amount, duration: duration || 1, durationUnit: durationUnit || 't',
    condition, status: 'active', created: Date.now()
  };
  saveBots();
  res.json({ botId, bot: bots[botId] });
});

app.post('/api/bots/code', (req, res) => {
  const { userId, symbol, direction, amount, duration, durationUnit, code } = req.body;
  if (!userId || !symbol || !direction || !amount || !code)
    return res.status(400).json({ error: 'Missing fields' });
  try {
    const vm = new VM({ timeout: 500, sandbox: {} });
    vm.run(`function shouldTrade(currentPrice, previousPrice) { ${code} }`);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid code: ' + e.message });
  }
  const botId = Date.now().toString(36) + Math.random().toString(36).substr(2,5);
  bots[botId] = {
    type: 'custom',
    userId, symbol, direction, amount, duration: duration || 1, durationUnit: durationUnit || 't',
    code, status: 'active', lastPrice: 0, created: Date.now()
  };
  saveBots();
  res.json({ botId, bot: bots[botId] });
});

app.get('/api/bots/:userId', (req, res) => {
  const userBots = Object.entries(bots)
    .filter(([_, bot]) => bot.userId === req.params.userId)
    .map(([id, bot]) => ({ id, ...bot }));
  res.json(userBots);
});

app.delete('/api/bots/:botId', (req, res) => {
  delete bots[req.params.botId];
  saveBots();
  res.json({ success: true });
});

app.post('/api/trade', async (req, res) => {
  const { userId, symbol, direction, amount, duration, durationUnit } = req.body;
  try {
    const result = await executeTrade(userId, symbol, direction, amount, duration, durationUnit);
    res.json({ success: true, trade: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  const priceContext = Object.entries(priceCache)
    .map(([sym, price]) => `${sym.replace('frx','')}: ${price}`)
    .join(', ');

  const systemPrompt = `You are a helpful trading assistant for GlobalFX. Current market prices: ${priceContext}. Provide short, actionable advice. Never give financial advice, only technical analysis suggestions.`;

  if (OPENAI_API_KEY) {
    try {
      const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            ...history.slice(-6),
            { role: 'user', content: message }
          ],
          temperature: 0.7,
          max_tokens: 300
        })
      });
      const data = await openaiResp.json();
      const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not process that.';
      res.json({ reply });
    } catch (e) {
      res.json({ reply: 'AI service temporarily unavailable.' });
    }
  } else {
    let reply = '';
    if (message.toLowerCase().includes('eur/usd')) {
      const price = priceCache['frxEURUSD'];
      reply = price ? `EUR/USD is trading at ${price}. Strong support at 1.0800, resistance at 1.0950.` : 'Price data not available.';
    } else if (message.toLowerCase().includes('buy') || message.toLowerCase().includes('sell')) {
      reply = 'Based on current volatility, consider waiting for a pullback. I recommend using a 15-minute chart.';
    } else {
      reply = 'I can help with price analysis, support/resistance levels, and market sentiment. Ask about any symbol.';
    }
    res.json({ reply });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🌐 GlobalFX running on port ${PORT}`));
