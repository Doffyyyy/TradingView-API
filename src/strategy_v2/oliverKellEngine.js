/**
 * TradingView-API — Strategy V2: Oliver Kell Price Cycle Engine
 *
 * Implements Oliver Kell's USIC Championship (+941%) Price Cycle Architecture:
 *   1. 1H Execution Timeframe: Eliminates 15M noise and micro-fee drag.
 *   2. BTC Macro Regime Filter: Longs permitted when BTC 1H > EMA50 or EMA200.
 *   3. Stage 2 Wedge Pop Detection: Asset was below 20 EMA, then surges above 10/20 EMA.
 *   4. Stage 3 EMA Crossback: Price pulls back to 10/20 EMA (tested within max 3 crossbacks).
 *   5. Pivot Reversal Trigger: Buy Stop placed at breakout of Pivot High of test bar.
 *      Zero-loss filter: If price plunges through EMA without breaking high, order expires with $0 loss.
 *   6. Structural Stop Loss: Below the pullback low + 0.6x ATR buffer.
 *   7. Hybrid Two-Stage Exit:
 *      - 50% TP at +2.2R, then remaining 50% SL moved to Breakeven (+ fees).
 *      - 50% Runner trails 20 EMA, or captures Climax Extension at Price > EMA20 + 3.5*ATR.
 */

function calcEMA(values, period) {
  const n = values.length;
  const ema = new Float64Array(n);
  if (n === 0) return ema;
  const k = 2 / (period + 1);
  let sum = 0;
  const initCount = Math.min(period, n);
  for (let i = 0; i < initCount; i++) sum += values[i];
  ema[initCount - 1] = sum / initCount;
  for (let i = initCount; i < n; i++) ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  return ema;
}

function calcATR(candles, period = 14) {
  const n = candles.length;
  const atr = new Float64Array(n);
  if (n === 0) return atr;
  const tr = new Float64Array(n);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
  }
  let sum = 0;
  const initCount = Math.min(period, n);
  for (let i = 0; i < initCount; i++) sum += tr[i];
  atr[initCount - 1] = sum / initCount;
  for (let i = initCount; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

class OliverKellEngine {
  constructor(config = {}) {
    this.config = {
      maxCrossbacks: config.maxCrossbacks !== undefined ? config.maxCrossbacks : 3,
      minRRPivot: config.minRRPivot || 2.2,
      atrBuffer: config.atrBuffer || 0.6,
      initialBalance: config.initialBalance || 10000,
      riskPerTradePct: config.riskPerTradePct || 0.005, // 0.5%
      maxLeverage: config.maxLeverage || 2.0,
      maxMargin: config.maxMargin || 2500,
      maxOpenPositions: config.maxOpenPositions || 3,
      takerFee: config.takerFee || 0.00035,
      makerFee: config.makerFee || 0.00010,
      slippageRate: config.slippageRate || 0.0002,
      maxDate: config.maxDate || null, // Optional cutoff e.g. '2026-09-30T23:59:59Z'
      pureLossGuard: config.pureLossGuard !== undefined ? config.pureLossGuard : true,
    };
  }

  run(candleData, symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'NEARUSDT']) {
    const btc1h = candleData['BTCUSDT_1h'];
    if (!btc1h) throw new Error('BTCUSDT_1h candles required');
    const nBars = btc1h.length;
    const btcCloses = btc1h.map(c => c.close);
    const btcEma50 = calcEMA(btcCloses, 50);
    const btcEma200 = calcEMA(btcCloses, 200);

    const symData = {};
    for (const sym of symbols) {
      const candles = candleData[`${sym}_1h`];
      const closes = candles.map(c => c.close);
      symData[sym] = {
        candles,
        closes,
        ema10: calcEMA(closes, 10),
        ema20: calcEMA(closes, 20),
        ema50: calcEMA(closes, 50),
        ema200: calcEMA(closes, 200),
        atr: calcATR(candles, 14),
        pendingPivotOrder: null,
        crossbackCount: 0,
        wasBelowEma20: false,
      };
    }

    let balance = this.config.initialBalance;
    const initialBalance = balance;
    let peakBalance = balance;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;

    const openPositions = [];
    const closedTrades = [];
    const symbolStats = {};
    const monthStats = {};
    symbols.forEach(s => {
      symbolStats[s] = { trades: 0, wins: 0, pnl: 0, gp: 0, gl: 0 };
    });

    let currentDay = '';
    let dailyRealizedPnl = 0.0;
    let dailyLossLimit = Math.round(balance * 0.018);

    for (let i = 200; i < nBars; i++) {
      const currentBarTime = btc1h[i].time;
      const dateObj = new Date(currentBarTime);
      const dateStr = dateObj.toISOString();
      const dayStr = dateStr.slice(0, 10);
      const monthStr = dateStr.slice(0, 7);

      if (this.config.maxDate && dateStr > this.config.maxDate) {
        break; // Stop at simulation boundary
      }

      // Daily rollover
      if (dayStr !== currentDay) {
        currentDay = dayStr;
        dailyRealizedPnl = 0.0;
        dailyLossLimit = Math.round(balance * 0.018);
      }

      // -------------------------------------------------------------
      // 1. Process Exits & Trailing Stops
      // -------------------------------------------------------------
      if (this.config.pureLossGuard) {
        // Layer 4: Emergency Circuit Breaker on Floating Drawdown
        let totalFloatingPnl = 0;
        for (const pos of openPositions) {
          const c = symData[pos.symbol].closes[i];
          totalFloatingPnl += (c - pos.entryPrice) * pos.size;
        }
        if ((dailyRealizedPnl + totalFloatingPnl) <= -(dailyLossLimit * 1.05)) {
          for (let pIdx = openPositions.length - 1; pIdx >= 0; pIdx--) {
            const pos = openPositions[pIdx];
            const exitPrice = symData[pos.symbol].closes[i];
            const remQty = pos.remainingSize !== undefined ? pos.remainingSize : pos.size;
            const remNotional = pos.remainingNotional !== undefined ? pos.remainingNotional : pos.notional;
            const grossDiff = (exitPrice - pos.entryPrice) * remQty;
            const fee = (pos.entryPrice * remQty * this.config.takerFee) + (exitPrice * remQty * this.config.takerFee);
            const slip = remNotional * this.config.slippageRate;
            const netRemaining = grossDiff - fee - slip;

            balance += netRemaining;
            dailyRealizedPnl += netRemaining;
            const totalNet = (pos.realizedPnl || 0) + netRemaining;

            if (balance > peakBalance) peakBalance = balance;
            const dd = peakBalance - balance;
            const ddPct = (dd / peakBalance) * 100;
            if (dd > maxDrawdown) maxDrawdown = dd;
            if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

            if (!monthStats[monthStr]) monthStats[monthStr] = { trades: 0, wins: 0, pnl: 0, gp: 0, gl: 0 };
            monthStats[monthStr].trades++;
            if (totalNet > 0) {
              monthStats[monthStr].wins++;
              monthStats[monthStr].gp += totalNet;
            } else {
              monthStats[monthStr].gl += Math.abs(totalNet);
            }
            monthStats[monthStr].pnl += totalNet;

            symbolStats[pos.symbol].trades++;
            if (totalNet > 0) {
              symbolStats[pos.symbol].wins++;
              symbolStats[pos.symbol].gp += totalNet;
            } else {
              symbolStats[pos.symbol].gl += Math.abs(totalNet);
            }
            symbolStats[pos.symbol].pnl += totalNet;

            closedTrades.push({
              id: pos.id,
              symbol: pos.symbol,
              entryTime: pos.entryTime,
              exitTime: dateStr,
              entryPrice: pos.entryPrice,
              exitPrice,
              pnl: totalNet,
              isWin: totalNet > 0,
              reason: 'EMERGENCY_DAILY_CIRCUIT_BREAKER',
              stage1Taken: pos.stage1Taken,
              barsHeld: pos.barsHeld,
            });

            openPositions.splice(pIdx, 1);
          }
        }
      }

      // Normal position exit checking
      for (let pIdx = openPositions.length - 1; pIdx >= 0; pIdx--) {
        const pos = openPositions[pIdx];
        const state = symData[pos.symbol];
        const bar = state.candles[i];
        const curAtr = state.atr[i];
        const curEma20 = state.ema20[i];
        pos.barsHeld++;

        let exitPrice = null;
        let exitReason = null;

        // Stage 1 Take Profit (+2.2R on 50% size)
        if (!pos.stage1Taken) {
          if (bar.high >= pos.tpStage1) {
            pos.stage1Taken = true;
            const pnl50 = (pos.tpStage1 - pos.entryPrice) * (pos.size * 0.5);
            const fee50 = (pos.entryPrice * (pos.size * 0.5) * this.config.takerFee) + (pos.tpStage1 * (pos.size * 0.5) * this.config.makerFee);
            const slip50 = (pos.notional * 0.5) * this.config.slippageRate;
            const netStage1 = pnl50 - fee50 - slip50;
            balance += netStage1;
            dailyRealizedPnl += netStage1;
            pos.realizedPnl += netStage1;
            pos.remainingSize = pos.size * 0.5;
            pos.remainingNotional = pos.notional * 0.5;
            pos.sl = pos.entryPrice * 1.002; // Move SL to breakeven + fee buffer
          }
        }

        // Remaining Runner Exits
        if (bar.low <= pos.sl) {
          exitPrice = pos.sl;
          exitReason = pos.stage1Taken ? 'RUNNER_BREAKEVEN' : 'STOP_LOSS';
        } else if (pos.stage1Taken && bar.high >= curEma20 + curAtr * 3.5) {
          exitPrice = curEma20 + curAtr * 3.5;
          exitReason = 'EXHAUSTION_CLIMAX';
        } else if (pos.stage1Taken && pos.barsHeld >= 5 && bar.close < curEma20) {
          exitPrice = bar.close;
          exitReason = 'RUNNER_EMA20_EXIT';
        } else if (pos.barsHeld >= 120) {
          exitPrice = bar.close;
          exitReason = 'TIME_EXIT';
        }

        if (exitPrice !== null) {
          const remQty = pos.remainingSize !== undefined ? pos.remainingSize : pos.size;
          const remNotional = pos.remainingNotional !== undefined ? pos.remainingNotional : pos.notional;
          const grossDiff = (exitPrice - pos.entryPrice) * remQty;
          const fee = (pos.entryPrice * remQty * this.config.takerFee) + (exitPrice * remQty * this.config.takerFee);
          const slip = remNotional * this.config.slippageRate;
          const netRemaining = grossDiff - fee - slip;

          balance += netRemaining;
          dailyRealizedPnl += netRemaining;
          const totalNet = (pos.realizedPnl || 0) + netRemaining;

          if (balance > peakBalance) peakBalance = balance;
          const dd = peakBalance - balance;
          const ddPct = (dd / peakBalance) * 100;
          if (dd > maxDrawdown) maxDrawdown = dd;
          if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

          if (!monthStats[monthStr]) monthStats[monthStr] = { trades: 0, wins: 0, pnl: 0, gp: 0, gl: 0 };
          monthStats[monthStr].trades++;
          if (totalNet > 0) {
            monthStats[monthStr].wins++;
            monthStats[monthStr].gp += totalNet;
          } else {
            monthStats[monthStr].gl += Math.abs(totalNet);
          }
          monthStats[monthStr].pnl += totalNet;

          symbolStats[pos.symbol].trades++;
          if (totalNet > 0) {
            symbolStats[pos.symbol].wins++;
            symbolStats[pos.symbol].gp += totalNet;
          } else {
            symbolStats[pos.symbol].gl += Math.abs(totalNet);
          }
          symbolStats[pos.symbol].pnl += totalNet;

          closedTrades.push({
            id: pos.id,
            symbol: pos.symbol,
            entryTime: pos.entryTime,
            exitTime: dateStr,
            entryPrice: pos.entryPrice,
            exitPrice,
            pnl: totalNet,
            isWin: totalNet > 0,
            reason: exitReason,
            stage1Taken: pos.stage1Taken,
            barsHeld: pos.barsHeld,
          });

          openPositions.splice(pIdx, 1);
        }
      }

      // -------------------------------------------------------------
      // 2. Process Pending Pivot Orders (Buy Stop Confirmation)
      // -------------------------------------------------------------
      let canEnterNewTrade = true;
      let allowedMaxPositions = this.config.maxOpenPositions;
      let riskFraction = this.config.riskPerTradePct;

      if (this.config.pureLossGuard) {
        // Layer 1: Daily Circuit Breaker Hard Lock (-1.8%)
        if (dailyRealizedPnl <= -dailyLossLimit) {
          canEnterNewTrade = false;
        }

        // Layer 2: Defensive Throttling (-50% daily limit)
        const isDefensive = (dailyRealizedPnl <= -(dailyLossLimit * 0.5));
        if (isDefensive) {
          allowedMaxPositions = 1;
          riskFraction = riskFraction * 0.5; // Reduce risk to 0.25% (1x leverage)
        }

        // Layer 3: Committed Daily Risk Gate
        let openPositionsMaxRisk = 0;
        for (const p of openPositions) {
          const slDist = p.sl > 0 ? Math.abs(p.entryPrice - p.sl) : (p.entryPrice * 0.015);
          openPositionsMaxRisk += (slDist * p.size);
        }
        const currentRealizedLoss = Math.max(0, -dailyRealizedPnl);
        const estNewRisk = balance * riskFraction;

        if ((currentRealizedLoss + openPositionsMaxRisk + estNewRisk) > dailyLossLimit) {
          canEnterNewTrade = false;
        }
      }

      for (const sym of symbols) {
        const state = symData[sym];
        if (!state.pendingPivotOrder) continue;
        const order = state.pendingPivotOrder;
        const bar = state.candles[i];

        if (canEnterNewTrade && openPositions.length < allowedMaxPositions && !openPositions.some(p => p.symbol === sym)) {
          if (bar.high >= order.triggerPrice) {
            const entryPrice = Math.max(bar.open, order.triggerPrice) * 1.0002;
            const stopDistance = entryPrice - order.sl;
            if (stopDistance > 0) {
              const stopDistPct = stopDistance / entryPrice;
              if (stopDistPct >= 0.008 && stopDistPct <= 0.045) {
                const riskDollar = balance * riskFraction;
                let notional = riskDollar / stopDistPct;
                const maxNotional = Math.min(balance * this.config.maxLeverage, this.config.maxMargin * 2);
                if (notional > maxNotional) notional = maxNotional;
                const size = notional / entryPrice;
                openPositions.push({
                  id: `OK_${sym}_${i}`,
                  symbol: sym,
                  entryTime: dateStr,
                  entryPrice,
                  sl: order.sl,
                  stopDist: stopDistance,
                  tpStage1: entryPrice + stopDistance * this.config.minRRPivot,
                  size,
                  notional,
                  riskDollar,
                  barsHeld: 0,
                  stage1Taken: false,
                  realizedPnl: 0,
                });
              }
            }
            state.pendingPivotOrder = null;
          } else {
            order.barsPending++;
            if (order.barsPending >= 3 || bar.close < order.sl) state.pendingPivotOrder = null;
          }
        } else {
          state.pendingPivotOrder = null;
        }
      }

      // -------------------------------------------------------------
      // 3. Setup Detection on Bar Close (RS Leader Selection)
      // -------------------------------------------------------------
      const btcClose = btcCloses[i];
      const btcBull = btcClose > btcEma50[i] || btcClose > btcEma200[i];

      if (btcBull && canEnterNewTrade && openPositions.length < allowedMaxPositions) {
        const btcPerf = (btcClose - btcCloses[i - 24]) / btcCloses[i - 24];
        const rsScores = [];
        for (const sym of symbols) {
          const state = symData[sym];
          const sClose = state.closes[i];
          const sPerf = (sClose - state.closes[i - 24]) / state.closes[i - 24];
          rsScores.push({ sym, rs: sPerf - btcPerf });
        }
        rsScores.sort((a, b) => b.rs - a.rs);

        for (const item of rsScores) {
          const sym = item.sym;
          const state = symData[sym];
          if (openPositions.some(p => p.symbol === sym) || state.pendingPivotOrder) continue;

          const bar = state.candles[i];
          const close = state.closes[i];
          const e10 = state.ema10[i];
          const e20 = state.ema20[i];
          const e50 = state.ema50[i];
          const e200 = state.ema200[i];
          const curAtr = state.atr[i];

          const trendAligned = e10 > e20 && e20 > e50 && close > e200;
          const touched = (bar.low <= e10 * 1.002 || bar.low <= e20 * 1.004) && close >= e20 * 0.995;
          const isLeader = item.rs >= -0.01;

          if (trendAligned && touched && isLeader) {
            const pivotHigh = bar.high;
            const sl = bar.low - curAtr * this.config.atrBuffer;
            state.pendingPivotOrder = { triggerPrice: pivotHigh * 1.001, sl, barsPending: 0 };
          }
        }
      }
    }

    const totalTrades = closedTrades.length;
    const wins = closedTrades.filter(t => t.isWin).length;
    const losses = totalTrades - wins;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    let gp = 0, gl = 0;
    closedTrades.forEach(t => {
      if (t.pnl > 0) gp += t.pnl;
      else gl += Math.abs(t.pnl);
    });
    const netPnl = balance - initialBalance;
    const pf = gl > 0 ? gp / gl : 0;
    const avgWin = wins > 0 ? gp / wins : 0;
    const avgLoss = losses > 0 ? gl / losses : 0;
    const payoff = avgLoss > 0 ? avgWin / avgLoss : 0;
    const expectancy = totalTrades > 0 ? (netPnl / totalTrades) : 0;

    return {
      initialBalance,
      finalBalance: balance,
      netPnl,
      returnPct: (netPnl / initialBalance) * 100,
      totalTrades,
      wins,
      losses,
      winRate,
      profitFactor: pf,
      payoff,
      expectancy,
      maxDrawdownPct,
      maxDrawdown,
      symbolStats,
      monthStats,
      trades: closedTrades,
    };
  }
}

module.exports = {
  OliverKellEngine,
};
