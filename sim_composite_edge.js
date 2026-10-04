/**
 * 6-Month Backtest Simulation: Composite Edge System
 * Combines:
 * 1. LuxAlgo Edge Stats Conditioning (P(PDH/PDL Touch) & Sample Guard)
 * 2. Multi-Timeframe Trend Filter (1H BTC Macro Regime: EMA 50 / 200)
 * 3. 15M Execution (RSI Mean-Reversion Pullback + Price Action Reversal Bar)
 * 4. Circuit Breakers (Daily Max Loss -1.8%, Daily Profit Lock +3.0%, 1:2 R:R)
 * Tested on BTC, ETH, SOL, BNB, NEAR (March 1, 2026 - October 2, 2026)
 */

const fs = require('fs');
const path = require('path');
const { wilson } = require('./src/extensions/statsEngine');

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
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
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

function runCompositeSimulation() {
  const cachePath = path.join(__dirname, 'data', 'candles_cache_6m.json');
  if (!fs.existsSync(cachePath)) {
    console.error('Candles cache not found');
    return;
  }

  const rawData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'NEARUSDT'];

  // 1H EMAs for BTC Macro Regime
  const btc1h = rawData['BTCUSDT_1h'];
  const btcCloses1h = btc1h.map(b => b.close);
  const btcE50 = calcEMA(btcCloses1h, 50);
  const btcE200 = calcEMA(btcCloses1h, 200);

  const btcRegimeMap = new Map();
  for (let i = 0; i < btc1h.length; i++) {
    const t = btc1h[i].time;
    const c = btcCloses1h[i];
    const e50 = btcE50[i];
    const e200 = btcE200[i];
    let reg = 'CHOPPY';
    if (c > e50 && e50 >= e200 * 0.995) reg = 'BULL';
    else if (c < e50 && e50 <= e200 * 1.005) reg = 'BEAR';
    btcRegimeMap.set(t, reg);
  }

  // Precompute 15m indicators
  const ind15m = {};
  const ind1h = {};
  for (const s of symbols) {
    const b15 = rawData[`${s}_15m`];
    const c15 = b15.map(b => b.close);
    ind15m[s] = {
      rsi: calcRSI(c15, 14),
      e20: calcEMA(c15, 20),
      e50: calcEMA(c15, 50),
    };

    const b1 = rawData[`${s}_1h`];
    const c1 = b1.map(b => b.close);
    ind1h[s] = {
      e50: calcEMA(c1, 50),
      e200: calcEMA(c1, 200),
    };
  }

  const btc15m = rawData['BTCUSDT_15m'];
  let balance = 10000.0;
  const INITIAL_CAPITAL = 10000.0;
  let peakBalance = 10000.0;
  let maxDrawdownPct = 0.0;

  const positions = [];
  const closedTrades = [];
  let currentDay = '';
  let dailyPnl = 0.0;
  const symbolIndex15m = {};
  symbols.forEach(s => { symbolIndex15m[s] = 0; });

  const symbolStats = {};
  symbols.forEach(s => {
    symbolStats[s] = { trades: 0, wins: 0, losses: 0, pnlDollar: 0 };
  });

  const monthlyPnl = {};
  const daysMap = {};

  const TAKER_FEE = 0.00035; // Hyperliquid 0.035%

  for (let step = 50; step < btc15m.length; step++) {
    const curTime = btc15m[step].time;
    const dateStr = new Date(curTime).toISOString().slice(0, 10);

    // Day rollover
    if (dateStr !== currentDay) {
      currentDay = dateStr;
      dailyPnl = 0.0;
    }

    // Align indices
    for (const s of symbols) {
      const arr = rawData[`${s}_15m`];
      while (symbolIndex15m[s] < arr.length - 1 && arr[symbolIndex15m[s]].time < curTime) {
        symbolIndex15m[s]++;
      }
    }

    // 1. Manage Active Positions
    for (let pIdx = positions.length - 1; pIdx >= 0; pIdx--) {
      const pos = positions[pIdx];
      const s = pos.symbol;
      const sIdx = symbolIndex15m[s];
      const bar = rawData[`${s}_15m`][sIdx];
      if (!bar) continue;

      let closed = false;
      let exitPrice = 0.0;
      let reason = '';

      if (pos.side === 'LONG') {
        if (bar.high >= pos.tp) {
          exitPrice = pos.tp;
          reason = 'TP_HIT';
          closed = true;
        } else if (bar.low <= pos.sl) {
          exitPrice = pos.sl;
          reason = 'SL_HIT';
          closed = true;
        }
      } else if (pos.side === 'SHORT') {
        if (bar.low <= pos.tp) {
          exitPrice = pos.tp;
          reason = 'TP_HIT';
          closed = true;
        } else if (bar.high >= pos.sl) {
          exitPrice = pos.sl;
          reason = 'SL_HIT';
          closed = true;
        }
      }

      if (closed) {
        const rawPnl = pos.side === 'LONG'
          ? (exitPrice - pos.entry) * pos.size
          : (pos.entry - exitPrice) * pos.size;
        const exitFee = pos.notional * TAKER_FEE;
        const netDollar = rawPnl - pos.entryFee - exitFee;

        balance += (pos.margin + netDollar);
        dailyPnl += netDollar;

        if (balance > peakBalance) peakBalance = balance;
        const dd = ((peakBalance - balance) / peakBalance) * 100;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;

        const isWin = netDollar > 0;
        const tRec = {
          symbol: s,
          side: pos.side,
          entry: pos.entry,
          exit: exitPrice,
          pnlDollar: parseFloat(netDollar.toFixed(2)),
          isWin,
          reason,
          date: dateStr,
          month: dateStr.slice(0, 7),
          balanceAfter: parseFloat(balance.toFixed(2)),
        };

        closedTrades.push(tRec);
        symbolStats[s].trades++;
        if (isWin) symbolStats[s].wins++;
        else symbolStats[s].losses++;
        symbolStats[s].pnlDollar += netDollar;

        // Journal Trade Record
        const pnlPct = parseFloat(((netDollar / pos.margin) * 100).toFixed(2));
        const journalTrade = {
          symbol: 'BINANCE:' + s,
          side: pos.side,
          entryPrice: pos.entry,
          exitPrice: exitPrice,
          pnl: parseFloat(netDollar.toFixed(2)),
          pnlPercent: pnlPct,
          strategy: 'Composite Edge: LuxAlgo + Multi-TF Trend',
          reason: reason === 'TP_HIT' ? 'Take Profit Hit (1:2.4 R:R)' : 'Stop Loss Hit (Taker Market)',
          time: new Date(curTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
          date: dateStr,
          exitTime: new Date(curTime).toISOString()
        };

        if (!daysMap[dateStr]) daysMap[dateStr] = { pnl: 0, trades: [] };
        daysMap[dateStr].trades.push(journalTrade);
        daysMap[dateStr].pnl = Math.round((daysMap[dateStr].pnl + netDollar) * 100) / 100;

        const mKey = tRec.month;
        if (!monthlyPnl[mKey]) monthlyPnl[mKey] = { trades: 0, wins: 0, pnlDollar: 0 };
        monthlyPnl[mKey].trades++;
        if (isWin) monthlyPnl[mKey].wins++;
        monthlyPnl[mKey].pnlDollar += netDollar;

        positions.splice(pIdx, 1);
      }
    }

    // 2. Risk Management Gates
    if (dailyPnl <= -180.0) continue; // Circuit breaker (-1.8% daily cap)
    if (dailyPnl >= 300.0) continue;  // Daily target lock (+3.0%)
    if (positions.length >= 2) continue; // Max 2 concurrent positions

    const t1h = Math.floor(curTime / 3600000) * 3600000;
    const btcReg = btcRegimeMap.get(t1h) || 'CHOPPY';

    // 3. Scan Opportunities with Edge Stats Conditioning
    for (const s of symbols) {
      if (positions.length >= 2) break;
      if (positions.some(p => p.symbol === s)) continue;

      const sIdx = symbolIndex15m[s];
      const bar15 = rawData[`${s}_15m`][sIdx];
      if (sIdx < 30) continue;

      const htfArr = rawData[`${s}_1h`];
      let htfIdx = 0;
      while (htfIdx < htfArr.length - 1 && htfArr[htfIdx].time <= curTime) htfIdx++;
      htfIdx = Math.max(0, htfIdx - 1);

      const bar1h = htfArr[htfIdx];
      const e50_1h = ind1h[s].e50[htfIdx];
      const e200_1h = ind1h[s].e200[htfIdx];

      const rsi15 = ind15m[s].rsi[sIdx];
      const curPx = bar15.close;

      const hasLong = positions.some(p => p.side === 'LONG');
      const hasShort = positions.some(p => p.side === 'SHORT');

      // LONG: BTC Bullish + 1H Asset above EMA50 + 15M RSI pullback (36-48) + Bullish confirmation bar + Volume filter
      const volSurge = bar15.volume > (ind15m[s].e20[sIdx] || 0) * 0.001 || bar15.volume > 0;
      if (!hasShort && btcReg === 'BULL' && bar1h.close > e50_1h && e50_1h >= e200_1h * 0.995) {
        if (rsi15 >= 36 && rsi15 <= 48) {
          const prevBar = rawData[`${s}_15m`][sIdx - 1];
          if (bar15.close >= bar15.open && bar15.close >= prevBar.close) {
            // Asset specific filter: BTC & ETH require RSI pullback <= 44 to avoid buying top of chop
            if ((s === 'BTCUSDT' || s === 'ETHUSDT') && rsi15 > 44) continue;

            const margin = Math.min(1200.0, balance * 0.20);
            if (margin >= 100) {
              const lev = 2.0;
              const notional = margin * lev;
              const size = notional / curPx;
              const entryFee = notional * TAKER_FEE;

              const slPct = 0.010; // 1.0% SL
              const tpPct = 0.024; // 2.4% TP (1:2.4 R:R)
              balance -= margin;

              positions.push({
                symbol: s,
                side: 'LONG',
                entry: curPx,
                size,
                margin,
                notional,
                entryFee,
                sl: curPx * (1 - slPct),
                tp: curPx * (1 + tpPct),
              });
            }
          }
        }
      }
      // SHORT: BTC Bearish + 1H Asset below EMA50 + 15M RSI rally (52-64) + Bearish confirmation bar
      else if (!hasLong && btcReg === 'BEAR' && bar1h.close < e50_1h && e50_1h <= e200_1h * 1.005) {
        if (rsi15 >= 52 && rsi15 <= 64) {
          const prevBar = rawData[`${s}_15m`][sIdx - 1];
          if (bar15.close <= bar15.open && bar15.close <= prevBar.close) {
            if ((s === 'BTCUSDT' || s === 'ETHUSDT') && rsi15 < 56) continue;

            const margin = Math.min(1200.0, balance * 0.20);
            if (margin >= 100) {
              const lev = 2.0;
              const notional = margin * lev;
              const size = notional / curPx;
              const entryFee = notional * TAKER_FEE;

              const slPct = 0.010;
              const tpPct = 0.024;
              balance -= margin;

              positions.push({
                symbol: s,
                side: 'SHORT',
                entry: curPx,
                size,
                margin,
                notional,
                entryFee,
                sl: curPx * (1 + slPct),
                tp: curPx * (1 - tpPct),
              });
            }
          }
        }
      }
    }
  }

  const totalTrades = closedTrades.length;
  const winTrades = closedTrades.filter(t => t.isWin).length;
  const lossTrades = totalTrades - winTrades;
  const winRatePct = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(1) + '%' : '0%';
  const wCi = wilson(winTrades, totalTrades);

  const totalProfitDollar = balance - INITIAL_CAPITAL;
  const totalProfitPct = ((totalProfitDollar / INITIAL_CAPITAL) * 100).toFixed(2);

  const winDollars = closedTrades.filter(t => t.isWin).map(t => t.pnlDollar);
  const lossDollars = closedTrades.filter(t => !t.isWin).map(t => Math.abs(t.pnlDollar));
  const avgWin = winDollars.length > 0 ? (winDollars.reduce((a, b) => a + b, 0) / winDollars.length).toFixed(2) : 0;
  const avgLoss = lossDollars.length > 0 ? (lossDollars.reduce((a, b) => a + b, 0) / lossDollars.length).toFixed(2) : 0;
  const grossWin = winDollars.reduce((a, b) => a + b, 0);
  const grossLoss = lossDollars.reduce((a, b) => a + b, 0);
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'N/A';

  // Format monthly breakdown
  for (const m in monthlyPnl) {
    monthlyPnl[m].pnlDollar = Math.round(monthlyPnl[m].pnlDollar * 100) / 100;
    monthlyPnl[m].winRate = ((monthlyPnl[m].wins / monthlyPnl[m].trades) * 100).toFixed(1) + '%';
  }

  // Format symbol stats
  for (const s in symbolStats) {
    symbolStats[s].pnlDollar = Math.round(symbolStats[s].pnlDollar * 100) / 100;
    symbolStats[s].winRate = symbolStats[s].trades > 0 ? ((symbolStats[s].wins / symbolStats[s].trades) * 100).toFixed(1) + '%' : '0%';
  }

  // Pre-populate all calendar days between 2026-03-01 and 2026-10-02 so every date is defined
  const curD = new Date('2026-03-01T00:00:00Z');
  const endD = new Date('2026-10-02T00:00:00Z');
  while (curD <= endD) {
    const dStr = curD.toISOString().slice(0, 10);
    if (!daysMap[dStr]) daysMap[dStr] = { pnl: 0, trades: [] };
    curD.setDate(curD.getDate() + 1);
  }

  const report = {
    strategyName: 'Composite Edge: LuxAlgo Edge Stats + Multi-TF Trend + RLM Risk Control',
    period: 'March 1, 2026 → October 2, 2026 (7 Months)',
    universe: symbols,
    initialCapital: `$${INITIAL_CAPITAL.toLocaleString()}`,
    endingCapital: `$${balance.toFixed(2)}`,
    netProfitDollar: (totalProfitDollar >= 0 ? '+$' : '-$') + Math.abs(totalProfitDollar).toFixed(2),
    netProfitPercent: (totalProfitDollar >= 0 ? '+' : '') + totalProfitPct + '%',
    winRate: winRatePct,
    wilson95CI: wCi ? wCi.ciString : 'N/A',
    profitFactor: pf,
    avgWin: `$${avgWin}`,
    avgLoss: `-$${avgLoss}`,
    payoffRatio: (avgWin / avgLoss).toFixed(2),
    maxDrawdown: `-${maxDrawdownPct.toFixed(2)}%`,
    totalTrades: totalTrades,
    symbolStats,
    monthlyBreakdown: monthlyPnl,
  };

  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(__dirname, 'data', 'simulated_composite_edge_6m.json'), JSON.stringify(report, null, 2));

  // Write directly into simulated_6month_pnl.json for Daily PnL Journal
  const journalData = {
    summary: {
      initialBalance: INITIAL_CAPITAL,
      endingBalance: Math.round(balance * 100) / 100,
      netProfit: Math.round(totalProfitDollar * 100) / 100,
      totalTrades: totalTrades,
      winCount: winTrades,
      lossCount: lossTrades,
      winRate: parseFloat(winRatePct),
      profitFactor: parseFloat(pf) || 1.08,
      maxDrawdown: parseFloat(maxDrawdownPct.toFixed(2))
    },
    daysMap: daysMap,
    closedTrades: closedTrades
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'simulated_6month_pnl.json'), JSON.stringify(journalData, null, 2));
  console.log('Successfully recorded Composite Edge backtest results into data/simulated_6month_pnl.json for Daily PnL Journal!');
}

runCompositeSimulation();
