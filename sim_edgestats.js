/**
 * 6-Month Backtest Simulation: Quantitative Edge Stats Strategy
 * Based on LuxAlgo edge-stats architecture (PDH/PDL Liquidity Sweeps, Gap Fill, ORB Trend Expansion).
 * Tested on BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, NEARUSDT (March 1, 2026 - October 2, 2026).
 * Includes Hyperliquid Fees (Maker 0.01%, Taker 0.035%), Wilson 95% CI, Max Drawdown, and Sharpe Ratio.
 */

const fs = require('fs');
const path = require('path');
const { wilson } = require('./src/extensions/statsEngine');

const INITIAL_CAPITAL = 10000;
const RISK_PER_TRADE = 0.02; // 2% risk of equity per trade
const LEVERAGE = 3; // Max 3x leverage as per system constraints
const FEE_TAKER = 0.00035; // 0.035% Hyperliquid Taker fee

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

function calcATR(bars, period = 14) {
  const tr = new Array(bars.length);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].high - bars[i].low;
    const hc = Math.abs(bars[i].high - bars[i - 1].close);
    const lc = Math.abs(bars[i].low - bars[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }
  const atr = new Array(bars.length);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  for (let i = period; i < bars.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function runSimulation() {
  const cachePath = path.join(__dirname, 'data', 'candles_cache_6m.json');
  if (!fs.existsSync(cachePath)) {
    console.error('Candles cache not found at:', cachePath);
    return;
  }

  const raw = fs.readFileSync(cachePath, 'utf8');
  const cacheData = JSON.parse(raw);

  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'NEARUSDT'];
  let totalPortfolioCapital = INITIAL_CAPITAL;
  const allClosedTrades = [];
  const symbolStats = {};

  symbols.forEach(sym => {
    symbolStats[sym] = {
      trades: 0,
      wins: 0,
      losses: 0,
      pnlDollar: 0,
      grossProfit: 0,
      grossLoss: 0,
    };
  });

  const dailyEquityCurve = [];
  let peakCapital = INITIAL_CAPITAL;
  let maxDrawdownDollar = 0;
  let maxDrawdownPct = 0;

  // Process symbol by symbol
  symbols.forEach(sym => {
    const bars1h = cacheData[`${sym}_1h`];
    if (!bars1h || bars1h.length < 100) return;

    const ema50 = calcEMA(bars1h.map(b => b.close), 50);
    const ema200 = calcEMA(bars1h.map(b => b.close), 200);
    const atr14 = calcATR(bars1h, 14);

    // Group into UTC daily sessions
    const dailyMap = new Map();
    bars1h.forEach((b, idx) => {
      const d = new Date(b.time);
      const dateKey = d.toISOString().slice(0, 10);
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          date: dateKey,
          bars: [],
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        });
      }
      const s = dailyMap.get(dateKey);
      s.bars.push({ ...b, barIdx: idx });
      s.high = Math.max(s.high, b.high);
      s.low = Math.min(s.low, b.low);
      s.close = b.close;
    });

    const days = Array.from(dailyMap.values());
    let currentPosition = null;

    for (let dayIdx = 2; dayIdx < days.length; dayIdx++) {
      const prevDay = days[dayIdx - 1];
      const today = days[dayIdx];
      const pdh = prevDay.high;
      const pdl = prevDay.low;
      const pdc = prevDay.close;
      const pdRange = pdh - pdl;

      // Iterate intraday 1h bars of today
      for (let i = 0; i < today.bars.length; i++) {
        const bar = today.bars[i];
        const barIdx = bar.barIdx;
        const trendBullish = ema50[barIdx] > ema200[barIdx] && bar.close > ema50[barIdx];
        const trendBearish = ema50[barIdx] < ema200[barIdx] && bar.close < ema50[barIdx];
        const curAtr = atr14[barIdx] || (bar.close * 0.015);

        // 1. Manage Open Position
        if (currentPosition) {
          let exitReason = null;
          let exitPrice = 0;

          if (currentPosition.side === 'LONG') {
            if (bar.high >= currentPosition.tp) {
              exitReason = 'TP_HIT';
              exitPrice = currentPosition.tp;
            } else if (bar.low <= currentPosition.sl) {
              exitReason = 'SL_HIT';
              exitPrice = currentPosition.sl;
            }
          } else if (currentPosition.side === 'SHORT') {
            if (bar.low <= currentPosition.tp) {
              exitReason = 'TP_HIT';
              exitPrice = currentPosition.tp;
            } else if (bar.high >= currentPosition.sl) {
              exitReason = 'SL_HIT';
              exitPrice = currentPosition.sl;
            }
          }

          if (exitReason) {
            const rawPnlPct = currentPosition.side === 'LONG'
              ? (exitPrice - currentPosition.entryPrice) / currentPosition.entryPrice
              : (currentPosition.entryPrice - exitPrice) / currentPosition.entryPrice;

            const feePct = FEE_TAKER * 2; // entry + exit
            const netPnlPct = rawPnlPct - feePct;
            const notional = currentPosition.notional;
            const pnlDollar = notional * netPnlPct;

            totalPortfolioCapital += pnlDollar;
            if (totalPortfolioCapital > peakCapital) peakCapital = totalPortfolioCapital;
            const ddDollar = peakCapital - totalPortfolioCapital;
            const ddPct = (ddDollar / peakCapital) * 100;
            if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

            const tradeRecord = {
              symbol: sym,
              side: currentPosition.side,
              setup: currentPosition.setup,
              entryTime: currentPosition.entryTime,
              exitTime: new Date(bar.time).toISOString(),
              entryPrice: currentPosition.entryPrice,
              exitPrice: exitPrice,
              pnlPct: parseFloat((netPnlPct * 100).toFixed(2)),
              pnlDollar: parseFloat(pnlDollar.toFixed(2)),
              capitalAfter: parseFloat(totalPortfolioCapital.toFixed(2)),
              exitReason: exitReason,
              isWin: netPnlPct > 0,
            };

            allClosedTrades.push(tradeRecord);
            symbolStats[sym].trades++;
            if (tradeRecord.isWin) {
              symbolStats[sym].wins++;
              symbolStats[sym].grossProfit += pnlDollar;
            } else {
              symbolStats[sym].losses++;
              symbolStats[sym].grossLoss += Math.abs(pnlDollar);
            }
            symbolStats[sym].pnlDollar += pnlDollar;

            currentPosition = null;
          }
        }

        // 2. Open New Position (if no active position)
        if (!currentPosition) {
          // Setup 1: PDL Sweep & Bullish Rejection (Statistical Edge Long)
          // Price wicked below PDL, but closed back above PDL
          const pdlSwept = bar.low < pdl && bar.close > pdl;
          if (pdlSwept && trendBullish) {
            const entryPrice = bar.close;
            const sl = Math.min(bar.low, pdl - curAtr * 0.5);
            const riskDist = entryPrice - sl;
            if (riskDist > 0 && (riskDist / entryPrice) < 0.04) {
              const tp = entryPrice + riskDist * 2.0; // 1:2 R:R
              const riskAmount = totalPortfolioCapital * RISK_PER_TRADE;
              const notional = Math.min(riskAmount / (riskDist / entryPrice), totalPortfolioCapital * LEVERAGE);

              currentPosition = {
                side: 'LONG',
                setup: 'PDL_SWEEP_REVERSAL',
                entryTime: new Date(bar.time).toISOString(),
                entryPrice,
                sl,
                tp,
                notional,
              };
              continue;
            }
          }

          // Setup 2: PDH Sweep & Bearish Rejection (Statistical Edge Short)
          // Price wicked above PDH, but closed back below PDH
          const pdhSwept = bar.high > pdh && bar.close < pdh;
          if (pdhSwept && trendBearish) {
            const entryPrice = bar.close;
            const sl = Math.max(bar.high, pdh + curAtr * 0.5);
            const riskDist = sl - entryPrice;
            if (riskDist > 0 && (riskDist / entryPrice) < 0.04) {
              const tp = entryPrice - riskDist * 2.0; // 1:2 R:R
              const riskAmount = totalPortfolioCapital * RISK_PER_TRADE;
              const notional = Math.min(riskAmount / (riskDist / entryPrice), totalPortfolioCapital * LEVERAGE);

              currentPosition = {
                side: 'SHORT',
                setup: 'PDH_SWEEP_REVERSAL',
                entryTime: new Date(bar.time).toISOString(),
                entryPrice,
                sl,
                tp,
                notional,
              };
              continue;
            }
          }

          // Setup 3: Opening Range Breakout (ORB Continuation)
          // First 2 hours of day establish range; bar 3 breaks out in trend direction
          if (i === 2) {
            const orHigh = Math.max(today.bars[0].high, today.bars[1].high);
            const orLow = Math.min(today.bars[0].low, today.bars[1].low);

            if (bar.close > orHigh && trendBullish) {
              const entryPrice = bar.close;
              const sl = orLow;
              const riskDist = entryPrice - sl;
              if (riskDist > 0 && (riskDist / entryPrice) < 0.035) {
                const tp = entryPrice + riskDist * 1.8;
                const riskAmount = totalPortfolioCapital * RISK_PER_TRADE;
                const notional = Math.min(riskAmount / (riskDist / entryPrice), totalPortfolioCapital * LEVERAGE);

                currentPosition = {
                  side: 'LONG',
                  setup: 'ORB_BREAKOUT',
                  entryTime: new Date(bar.time).toISOString(),
                  entryPrice,
                  sl,
                  tp,
                  notional,
                };
              }
            } else if (bar.close < orLow && trendBearish) {
              const entryPrice = bar.close;
              const sl = orHigh;
              const riskDist = sl - entryPrice;
              if (riskDist > 0 && (riskDist / entryPrice) < 0.035) {
                const tp = entryPrice - riskDist * 1.8;
                const riskAmount = totalPortfolioCapital * RISK_PER_TRADE;
                const notional = Math.min(riskAmount / (riskDist / entryPrice), totalPortfolioCapital * LEVERAGE);

                currentPosition = {
                  side: 'SHORT',
                  setup: 'ORB_BREAKOUT',
                  entryTime: new Date(bar.time).toISOString(),
                  entryPrice,
                  sl,
                  tp,
                  notional,
                };
              }
            }
          }
        }
      }
    }
  });

  // Calculate Overall Portfolio Metrics
  const totalTrades = allClosedTrades.length;
  const winTrades = allClosedTrades.filter(t => t.isWin).length;
  const lossTrades = totalTrades - winTrades;
  const winRate = totalTrades > 0 ? (winTrades / totalTrades) : 0;
  const winRatePct = (winRate * 100).toFixed(1) + '%';
  const wCi = wilson(winTrades, totalTrades);

  const totalNetProfitDollar = totalPortfolioCapital - INITIAL_CAPITAL;
  const totalNetProfitPct = ((totalNetProfitDollar / INITIAL_CAPITAL) * 100).toFixed(2);

  const totalGrossProfit = allClosedTrades.filter(t => t.isWin).reduce((sum, t) => sum + t.pnlDollar, 0);
  const totalGrossLoss = allClosedTrades.filter(t => !t.isWin).reduce((sum, t) => sum + Math.abs(t.pnlDollar), 0);
  const profitFactor = totalGrossLoss > 0 ? (totalGrossProfit / totalGrossLoss).toFixed(2) : 'N/A';

  // Monthly breakdown
  const monthlyPnl = {};
  allClosedTrades.forEach(t => {
    const m = t.exitTime.slice(0, 7); // YYYY-MM
    if (!monthlyPnl[m]) monthlyPnl[m] = { trades: 0, wins: 0, pnlDollar: 0 };
    monthlyPnl[m].trades++;
    if (t.isWin) monthlyPnl[m].wins++;
    monthlyPnl[m].pnlDollar += t.pnlDollar;
  });

  // Sharpe Ratio estimation (daily returns)
  const returns = allClosedTrades.map(t => t.pnlPct / 100);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / (returns.length || 1);
  const stdDev = Math.sqrt(variance);
  const annualFactor = Math.sqrt(365 * 2); // approximate trades per year frequency
  const sharpeRatio = stdDev > 0 ? ((meanReturn / stdDev) * annualFactor).toFixed(2) : 'N/A';

  const report = {
    backtestWindow: 'March 1, 2026 → October 2, 2026 (7 Months, 5,162 1H Bars)',
    testedUniverse: symbols,
    initialCapital: `$${INITIAL_CAPITAL.toLocaleString()}`,
    finalEquity: `$${totalPortfolioCapital.toFixed(2)}`,
    netProfitDollar: (totalNetProfitDollar >= 0 ? '+$' : '-$') + Math.abs(totalNetProfitDollar).toFixed(2),
    netProfitPercent: (totalNetProfitDollar >= 0 ? '+' : '') + totalNetProfitPct + '%',
    profitFactor: profitFactor,
    totalTrades: totalTrades,
    winRate: winRatePct,
    wilson95CI: wCi ? wCi.ciString : 'N/A',
    maxDrawdownPct: `-${maxDrawdownPct.toFixed(2)}%`,
    sharpeRatio: sharpeRatio,
    symbolStats: symbolStats,
    monthlyBreakdown: monthlyPnl,
  };

  console.log(JSON.stringify(report, null, 2));

  // Save report to disk
  fs.writeFileSync(path.join(__dirname, 'data', 'simulated_edgestats_6m.json'), JSON.stringify(report, null, 2));
}

runSimulation();
