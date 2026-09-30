const axios = require('axios');
const fs = require('fs');
const path = require('path');

function calcEMA(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = new Array(values.length);
  let sum = 0;
  const initCount = Math.min(period, values.length);
  for (let i = 0; i < initCount; i++) sum += values[i];
  ema[initCount - 1] = sum / initCount;
  for (let i = initCount; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return new Array(closes.length).fill(50);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsi = new Array(closes.length).fill(50);
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return rsi;
}

async function fetchAll(symbol, interval, start, end) {
  let all = [];
  let cur = start;
  while (cur < end) {
    const res = await axios.get('https://data-api.binance.vision/api/v3/klines', {
      params: { symbol, interval, startTime: cur, endTime: end, limit: 1000 }
    });
    if (!res.data || res.data.length === 0) break;
    all.push(...res.data);
    const last = res.data[res.data.length - 1][0];
    if (last <= cur) break;
    cur = last + (interval === '1h' ? 3600000 : 900000);
    if (res.data.length < 1000) break;
  }
  return all.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    quoteVolume: parseFloat(k[7])
  }));
}

async function simulate() {
  const start = new Date('2026-03-01T00:00:00Z').getTime();
  const end = Date.now();
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'NEARUSDT', 'TAOUSDT', 'BNBUSDT'];

  console.log('Downloading data for 6 symbols from March to September 2026...');
  const data = {};
  for (const s of symbols) {
    process.stdout.write('Fetching ' + s + '... ');
    const k1h = await fetchAll(s, '1h', start, end);
    const k15m = await fetchAll(s, '15m', start, end);
    data[s] = { k1h, k15m };
    console.log(`Done! 1h: ${k1h.length}, 15m: ${k15m.length}`);
  }

  // Precalculate indicators
  for (const s of symbols) {
    const closes1h = data[s].k1h.map(c => c.close);
    data[s].ema50_1h = calcEMA(closes1h, 50);
    data[s].ema200_1h = calcEMA(closes1h, Math.min(200, closes1h.length));

    const closes15m = data[s].k15m.map(c => c.close);
    data[s].rsi15m = calcRSI(closes15m, 14);
    data[s].ema20_15m = calcEMA(closes15m, 20);
    data[s].ema50_15m = calcEMA(closes15m, 50);
  }

  // BTC Regime map by 1h timestamp
  const btcRegimeByTime = new Map();
  for (let i = 0; i < data['BTCUSDT'].k1h.length; i++) {
    const c = data['BTCUSDT'].k1h[i];
    const e50 = data['BTCUSDT'].ema50_1h[i] || c.close;
    const e200 = data['BTCUSDT'].ema200_1h[i] || e50;
    let reg = 'CHOPPY';
    if (c.close > e50 && e50 > e200) reg = 'BULL';
    else if (c.close < e50 && e50 < e200) reg = 'BEAR';
    btcRegimeByTime.set(c.time, reg);
  }

  // Synchronous Step-by-Step Backtest Engine across all 15m bars
  let balance = 10000.0;
  let positions = []; // max 2
  let closedTrades = [];
  let daysMap = {};
  let currentDay = '';
  let dailyPnl = 0.0;

  const btc15m = data['BTCUSDT'].k15m;
  const symbolIndex15m = {};
  symbols.forEach(s => { symbolIndex15m[s] = 0; });

  const TAKER_FEE = 0.00035; // 0.035% HL Taker
  const MAKER_FEE = 0.00010; // 0.010% HL Maker

  for (let btcIdx = 50; btcIdx < btc15m.length; btcIdx++) {
    const curTime = btc15m[btcIdx].time;
    const dateStr = new Date(curTime).toISOString().slice(0, 10);

    // Day rollover
    if (dateStr !== currentDay) {
      if (currentDay && !daysMap[currentDay]) {
        daysMap[currentDay] = { pnl: Math.round(dailyPnl * 100) / 100, trades: [] };
      }
      currentDay = dateStr;
      dailyPnl = 0.0;
    }

    // Update 15m index for each symbol
    for (const s of symbols) {
      const arr = data[s].k15m;
      while (symbolIndex15m[s] < arr.length - 1 && arr[symbolIndex15m[s]].time < curTime) {
        symbolIndex15m[s]++;
      }
    }

    // 1. Manage Open Positions
    for (let pIdx = positions.length - 1; pIdx >= 0; pIdx--) {
      const pos = positions[pIdx];
      const s = pos.symbol;
      const sIdx = symbolIndex15m[s];
      const bar = data[s].k15m[sIdx];
      if (!bar) continue;

      let closed = false;
      let exitPrice = 0;
      let reason = '';
      let isMaker = false;

      if (pos.side === 'LONG') {
        if (bar.high > pos.highest) pos.highest = bar.high;
        const currentGain = (pos.highest - pos.entryPrice) / pos.entryPrice;

        // Trailing Stop to breakeven (+0.35%) when gain >= +1.0%
        if (currentGain >= 0.010 && pos.stopLoss < pos.entryPrice * 1.0035) {
          pos.stopLoss = pos.entryPrice * 1.0035;
        }

        // Take profit check
        if (bar.high >= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          reason = 'Take Profit Hit (Maker Limit)';
          isMaker = true;
          closed = true;
        } else if (bar.low <= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          reason = 'Stop Loss Hit (Taker Market)';
          isMaker = false;
          closed = true;
        }
      } else { // SHORT
        if (bar.low < pos.lowest) pos.lowest = bar.low;
        const currentGain = (pos.entryPrice - pos.lowest) / pos.entryPrice;

        if (currentGain >= 0.010 && pos.stopLoss > pos.entryPrice * 0.9965) {
          pos.stopLoss = pos.entryPrice * 0.9965;
        }

        if (bar.low <= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          reason = 'Take Profit Hit (Maker Limit)';
          isMaker = true;
          closed = true;
        } else if (bar.high >= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          reason = 'Stop Loss Hit (Taker Market)';
          isMaker = false;
          closed = true;
        }
      }

      if (closed) {
        const rawPnl = pos.side === 'LONG' 
          ? (exitPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - exitPrice) * pos.size;
        const exitFee = pos.notional * (isMaker ? MAKER_FEE : TAKER_FEE);
        const netPnl = rawPnl - pos.entryFee - exitFee;

        balance += (pos.margin + netPnl);
        dailyPnl += netPnl;

        const tradeRec = {
          symbol: 'BINANCE:' + s,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: exitPrice,
          pnl: Math.round(netPnl * 100) / 100,
          pnlPercent: Math.round((netPnl / pos.margin) * 10000) / 100,
          strategy: pos.strategy,
          reason: reason,
          time: new Date(curTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
          date: dateStr,
          exitTime: new Date(curTime).toISOString()
        };

        closedTrades.push(tradeRec);
        if (!daysMap[dateStr]) daysMap[dateStr] = { pnl: 0, trades: [] };
        daysMap[dateStr].pnl = Math.round((daysMap[dateStr].pnl + netPnl) * 100) / 100;
        daysMap[dateStr].trades.push(tradeRec);

        positions.splice(pIdx, 1);
      }
    }

    // 2. Scan New Opportunities
    const dailyStopLimit = Math.max(180, balance * 0.018);
    const dailyTargetMax = Math.max(300, balance * 0.030);

    if (dailyPnl <= -dailyStopLimit) continue; // Circuit breaker
    if (dailyPnl >= dailyTargetMax) continue;  // Daily profit lock
    if (positions.length >= 2) continue;       // Max 2 positions

    const nearestHour = Math.floor(curTime / 3600000) * 3600000;
    const btcRegime = btcRegimeByTime.get(nearestHour) || 'CHOPPY';

    for (const s of symbols) {
      if (positions.length >= 2) break;
      if (positions.some(p => p.symbol === s)) continue;

      const sIdx = symbolIndex15m[s];
      const bar15m = data[s].k15m[sIdx];
      if (!bar15m || sIdx < 30) continue;

      const htfIdx = data[s].k1h.findIndex(c => c.time <= curTime && curTime < c.time + 3600000);
      if (htfIdx < 30) continue;

      const bar1h = data[s].k1h[htfIdx];
      const e50_1h = data[s].ema50_1h[htfIdx] || bar1h.close;
      const e200_1h = data[s].ema200_1h[htfIdx] || e50_1h;
      const rsi15m = data[s].rsi15m[sIdx];
      const curPx = bar15m.close;

      const hasLong = positions.some(p => p.side === 'LONG');
      const hasShort = positions.some(p => p.side === 'SHORT');

      // === LONG SETUP ===
      if (!hasShort && btcRegime !== 'BEAR' && bar1h.close > e50_1h && e50_1h >= e200_1h * 0.99) {
        if (rsi15m >= 36 && rsi15m <= 56) {
          const prevBar = data[s].k15m[sIdx - 1];
          if (bar15m.close >= bar15m.open && bar15m.close >= prevBar.close) {
            const lev = (btcRegime === 'BULL' && rsi15m >= 40 && rsi15m <= 50) ? 2 : 1;
            const margin = Math.min(1800.0, balance * 0.35);
            if (margin >= 100) {
              const notional = margin * lev;
              const size = notional / curPx;
              const entryFee = notional * TAKER_FEE;

              const slPct = lev === 2 ? 0.008 : 0.009;
              const tpPct = lev === 2 ? 0.016 : 0.018;
              const stopLoss = curPx * (1 - slPct);
              const takeProfit = curPx * (1 + tpPct);

              balance -= margin;
              positions.push({
                symbol: s,
                side: 'LONG',
                entryPrice: curPx,
                size,
                margin,
                notional,
                leverage: lev,
                stopLoss,
                takeProfit,
                highest: curPx,
                entryFee,
                strategy: 'Multi-TF 1H Trend + 15M Pullback'
              });
            }
          }
        }
      }

      // === SHORT SETUP ===
      if (!hasLong && btcRegime !== 'BULL' && bar1h.close < e50_1h && e50_1h <= e200_1h * 1.01) {
        if (rsi15m >= 44 && rsi15m <= 64) {
          const prevBar = data[s].k15m[sIdx - 1];
          if (bar15m.close <= bar15m.open && bar15m.close <= prevBar.close) {
            const lev = (btcRegime === 'BEAR' && rsi15m >= 50 && rsi15m <= 60) ? 2 : 1;
            const margin = Math.min(1800.0, balance * 0.35);
            if (margin >= 100) {
              const notional = margin * lev;
              const size = notional / curPx;
              const entryFee = notional * TAKER_FEE;

              const slPct = lev === 2 ? 0.008 : 0.009;
              const tpPct = lev === 2 ? 0.016 : 0.018;
              const stopLoss = curPx * (1 + slPct);
              const takeProfit = curPx * (1 - tpPct);

              balance -= margin;
              positions.push({
                symbol: s,
                side: 'SHORT',
                entryPrice: curPx,
                size,
                margin,
                notional,
                leverage: lev,
                stopLoss,
                takeProfit,
                lowest: curPx,
                entryFee,
                strategy: 'Multi-TF 1H Trend + 15M Rejection'
              });
            }
          }
        }
      }
    }
  }

  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter(t => t.pnl > 0);
  const losses = closedTrades.filter(t => t.pnl <= 0);
  const winRate = (wins.length / (totalTrades || 1)) * 100;
  const totalProfit = closedTrades.reduce((acc, t) => acc + t.pnl, 0);

  console.log('\n==========================================');
  console.log('       SIMULATION RESULTS (MARCH - SEPT 2026)');
  console.log('==========================================');
  console.log(`Starting Balance: $10,000.00`);
  console.log(`Ending Balance:   $${(10000 + totalProfit).toFixed(2)}`);
  console.log(`Net Profit:       +$${totalProfit.toFixed(2)} (+${(totalProfit / 100).toFixed(1)}%)`);
  console.log(`Total Trades:     ${totalTrades}`);
  console.log(`Wins:             ${wins.length} (${winRate.toFixed(1)}%)`);
  console.log(`Losses:           ${losses.length} (${(100 - winRate).toFixed(1)}%)`);
  console.log(`Days Active:      ${Object.keys(daysMap).length}`);
  console.log('==========================================\n');

  fs.writeFileSync('D:/TradingView-API/data/simulated_6month_pnl.json', JSON.stringify({
    summary: {
      initialBalance: 10000.0,
      endingBalance: Math.round((10000.0 + totalProfit) * 100) / 100,
      netProfit: Math.round(totalProfit * 100) / 100,
      totalTrades,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: Math.round(winRate * 10) / 10
    },
    daysMap,
    closedTrades
  }, null, 2));

  console.log('Saved full simulation data to D:/TradingView-API/data/simulated_6month_pnl.json!');
}

simulate().catch(e => console.error(e));
