/**
 * TradingView-API — Strategy V2: Oliver Kell Price Cycle Engine (Enhanced R:R Edition)
 *
 * Improvements over baseline:
 *   1. Strict BTC Macro Regime Gate (EMA50 > EMA200 for Bull Longs; EMA50 < EMA200 for Bear Shorts).
 *   2. Symmetric Bull (LONG) & Bear (SHORT) Price Cycle setups with RS Leader/Laggard selection.
 *   3. True R-Based Exit Progression using immutable `initialStopDist`:
 *      - +1.4R: Lock Stop Loss at Breakeven (+0.15% fee buffer).
 *      - +2.2R: Stage 1 Take Profit (close 50%) and lock Runner SL at +0.8R (breathing room).
 *      - Runner exits on 1H EMA20 close cross (after 5 bars) or Climax Extension (EMA20 ± 3.5*ATR).
 *   4. Early Invalidation Guard: Cut underwater trades early when 1H closes back through EMA50.
 *   5. Correlation Guard: Max 1 unprotected (non-breakeven) position at a time.
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
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
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
      minRRPivot: config.minRRPivot || 2.5,
      breakevenR: config.breakevenR !== undefined ? config.breakevenR : 1.6,
      runnerLockR: config.runnerLockR !== undefined ? config.runnerLockR : 1.2,
      atrBuffer: config.atrBuffer || 0.6,
      initialBalance: config.initialBalance || 10000,
      riskPerTradePct: config.riskPerTradePct || 0.005, // 0.5%
      maxLeverage: config.maxLeverage || 2.0,
      maxMargin: config.maxMargin || 2500,
      maxOpenPositions: config.maxOpenPositions || 3,
      maxUnprotectedPositions: config.maxUnprotectedPositions !== undefined ? config.maxUnprotectedPositions : 1,
      maxBarsHold: config.maxBarsHold || 120,
      takerFee: config.takerFee || 0.00035,
      makerFee: config.makerFee || 0.00010,
      slippageRate: config.slippageRate || 0.0002,
      minDate: config.minDate !== undefined ? config.minDate : '2026-01-01T00:00:00Z',
      maxDate: config.maxDate || null,
      pureLossGuard: config.pureLossGuard !== undefined ? config.pureLossGuard : true,
      enableShort: config.enableShort !== undefined ? config.enableShort : true,
      earlyInvalidation: config.earlyInvalidation !== undefined ? config.earlyInvalidation : false,
    };
  }

  run(candleData, symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'NEARUSDT']) {
    const btc1h = candleData.BTCUSDT_1h;
    if (!btc1h) throw new Error('BTCUSDT_1h candles required');
    const nBars = btc1h.length;
    const btcCloses = btc1h.map(c => c.close);
    const btcEma50 = calcEMA(btcCloses, 50);
    const btcEma200 = calcEMA(btcCloses, 200);

    const symData = {};
    for (const sym of symbols) {
      const candles = candleData[`${sym}_1h`];
      if (!candles) continue;
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

    const recordTradeClose = (pos, exitPrice, exitReason, dateStr, monthStr, isLimitExit = false) => {
      const remQty = pos.remainingSize !== undefined ? pos.remainingSize : pos.size;
      const remNotional = pos.remainingNotional !== undefined ? pos.remainingNotional : pos.notional;
      const grossDiff = pos.side === 'SHORT'
        ? (pos.entryPrice - exitPrice) * remQty
        : (exitPrice - pos.entryPrice) * remQty;
      const exitFeeRate = isLimitExit ? this.config.makerFee : this.config.takerFee;
      const fee = (pos.entryPrice * remQty * this.config.takerFee) + (exitPrice * remQty * exitFeeRate);
      const slip = isLimitExit ? 0 : remNotional * this.config.slippageRate;
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
      monthStats[monthStr].trades += 1;
      if (totalNet > 0) {
        monthStats[monthStr].wins += 1;
        monthStats[monthStr].gp += totalNet;
      } else {
        monthStats[monthStr].gl += Math.abs(totalNet);
      }
      monthStats[monthStr].pnl += totalNet;

      symbolStats[pos.symbol].trades += 1;
      if (totalNet > 0) {
        symbolStats[pos.symbol].wins += 1;
        symbolStats[pos.symbol].gp += totalNet;
      } else {
        symbolStats[pos.symbol].gl += Math.abs(totalNet);
      }
      symbolStats[pos.symbol].pnl += totalNet;

      closedTrades.push({
        id: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        entryTime: pos.entryTime,
        exitTime: dateStr,
        entryPrice: pos.entryPrice,
        exitPrice,
        pnl: totalNet,
        isWin: totalNet > 0,
        reason: exitReason,
        stage1Taken: pos.stage1Taken,
        isBreakeven: pos.isBreakeven,
        barsHeld: pos.barsHeld,
      });
    };

    for (let i = 200; i < nBars; i++) {
      const currentBarTime = btc1h[i].time;
      const dateStr = new Date(currentBarTime).toISOString();
      const dayStr = dateStr.slice(0, 10);
      const monthStr = dateStr.slice(0, 7);

      if (this.config.minDate && dateStr < this.config.minDate) {
        continue;
      }
      if (this.config.maxDate && dateStr > this.config.maxDate) {
        break;
      }

      if (dayStr !== currentDay) {
        currentDay = dayStr;
        dailyRealizedPnl = 0.0;
        dailyLossLimit = Math.round(balance * 0.018);
      }

      // -------------------------------------------------------------
      // 1. Process Exits & Trailing Stops
      // -------------------------------------------------------------
      if (this.config.pureLossGuard) {
        let totalFloatingPnl = 0;
        for (const pos of openPositions) {
          const c = symData[pos.symbol].closes[i];
          const remQty = pos.remainingSize !== undefined ? pos.remainingSize : pos.size;
          const diff = pos.side === 'SHORT' ? (pos.entryPrice - c) : (c - pos.entryPrice);
          totalFloatingPnl += diff * remQty;
        }
        if ((dailyRealizedPnl + totalFloatingPnl) <= -(dailyLossLimit * 1.05)) {
          for (let pIdx = openPositions.length - 1; pIdx >= 0; pIdx--) {
            const pos = openPositions[pIdx];
            const exitPrice = symData[pos.symbol].closes[i];
            recordTradeClose(pos, exitPrice, 'EMERGENCY_DAILY_CIRCUIT_BREAKER', dateStr, monthStr);
            openPositions.splice(pIdx, 1);
          }
        }
      }

      for (let pIdx = openPositions.length - 1; pIdx >= 0; pIdx--) {
        const pos = openPositions[pIdx];
        const state = symData[pos.symbol];
        const bar = state.candles[i];
        const curAtr = state.atr[i];
        const curEma20 = state.ema20[i];
        const curEma50 = state.ema50[i];
        pos.barsHeld += 1;

        let exitPrice = null;
        let exitReason = null;
        let isLimitExit = false;

        if (pos.side === 'LONG') {
          if (!pos.stage1Taken) {
            if (bar.low <= pos.sl) {
              exitPrice = pos.sl;
              exitReason = pos.isBreakeven ? 'BREAKEVEN_EXIT' : 'STOP_LOSS';
            } else if (bar.high >= pos.tpStage1) {
              pos.stage1Taken = true;
              pos.isBreakeven = true;
              const pnl50 = (pos.tpStage1 - pos.entryPrice) * (pos.size * 0.5);
              const fee50 = (pos.entryPrice * (pos.size * 0.5) * this.config.takerFee)
                + (pos.tpStage1 * (pos.size * 0.5) * this.config.makerFee);
              const netStage1 = pnl50 - fee50;
              balance += netStage1;
              dailyRealizedPnl += netStage1;
              pos.realizedPnl += netStage1;
              pos.remainingSize = pos.size * 0.5;
              pos.remainingNotional = pos.notional * 0.5;
              const lockSl = pos.entryPrice + pos.initialStopDist * this.config.runnerLockR;
              pos.sl = Math.max(pos.sl, lockSl);

              if (bar.high >= curEma20 + curAtr * 3.5) {
                exitPrice = curEma20 + curAtr * 3.5;
                exitReason = 'EXHAUSTION_CLIMAX';
                isLimitExit = true;
              }
            } else {
              const beTrigger = pos.entryPrice + pos.initialStopDist * this.config.breakevenR;
              if (!pos.isBreakeven && this.config.breakevenR > 0 && bar.high >= beTrigger) {
                pos.isBreakeven = true;
                pos.sl = Math.max(pos.sl, pos.entryPrice * 1.0015);
              } else if (
                this.config.earlyInvalidation
                && !pos.isBreakeven
                && pos.barsHeld >= 2
                && bar.close < curEma50
                && bar.close < pos.entryPrice
              ) {
                exitPrice = bar.close;
                exitReason = 'EARLY_INVALIDATION';
              }
            }
          } else if (bar.low <= pos.sl) {
            exitPrice = pos.sl;
            exitReason = 'RUNNER_LOCK_EXIT';
          } else if (bar.high >= curEma20 + curAtr * 3.5) {
            exitPrice = curEma20 + curAtr * 3.5;
            exitReason = 'EXHAUSTION_CLIMAX';
            isLimitExit = true;
          } else if (pos.barsHeld >= 5 && bar.close < curEma20) {
            exitPrice = bar.close;
            exitReason = 'RUNNER_EMA20_EXIT';
          }
        } else {
          // SHORT SIDE
          if (!pos.stage1Taken) {
            if (bar.high >= pos.sl) {
              exitPrice = pos.sl;
              exitReason = pos.isBreakeven ? 'BREAKEVEN_EXIT' : 'STOP_LOSS';
            } else if (bar.low <= pos.tpStage1) {
              pos.stage1Taken = true;
              pos.isBreakeven = true;
              const pnl50 = (pos.entryPrice - pos.tpStage1) * (pos.size * 0.5);
              const fee50 = (pos.entryPrice * (pos.size * 0.5) * this.config.takerFee)
                + (pos.tpStage1 * (pos.size * 0.5) * this.config.makerFee);
              const netStage1 = pnl50 - fee50;
              balance += netStage1;
              dailyRealizedPnl += netStage1;
              pos.realizedPnl += netStage1;
              pos.remainingSize = pos.size * 0.5;
              pos.remainingNotional = pos.notional * 0.5;
              const lockSl = pos.entryPrice - pos.initialStopDist * this.config.runnerLockR;
              pos.sl = Math.min(pos.sl, lockSl);

              if (bar.low <= curEma20 - curAtr * 3.5) {
                exitPrice = curEma20 - curAtr * 3.5;
                exitReason = 'EXHAUSTION_CLIMAX';
                isLimitExit = true;
              }
            } else {
              const beTrigger = pos.entryPrice - pos.initialStopDist * this.config.breakevenR;
              if (!pos.isBreakeven && this.config.breakevenR > 0 && bar.low <= beTrigger) {
                pos.isBreakeven = true;
                pos.sl = Math.min(pos.sl, pos.entryPrice * 0.9985);
              } else if (
                this.config.earlyInvalidation
                && !pos.isBreakeven
                && pos.barsHeld >= 2
                && bar.close > curEma50
                && bar.close > pos.entryPrice
              ) {
                exitPrice = bar.close;
                exitReason = 'EARLY_INVALIDATION';
              }
            }
          } else if (bar.high >= pos.sl) {
            exitPrice = pos.sl;
            exitReason = 'RUNNER_LOCK_EXIT';
          } else if (bar.low <= curEma20 - curAtr * 3.5) {
            exitPrice = curEma20 - curAtr * 3.5;
            exitReason = 'EXHAUSTION_CLIMAX';
            isLimitExit = true;
          } else if (pos.barsHeld >= 5 && bar.close > curEma20) {
            exitPrice = bar.close;
            exitReason = 'RUNNER_EMA20_EXIT';
          }
        }

        if (exitPrice === null && pos.barsHeld >= this.config.maxBarsHold) {
          exitPrice = bar.close;
          exitReason = 'TIME_EXIT';
        }

        if (exitPrice !== null) {
          recordTradeClose(pos, exitPrice, exitReason, dateStr, monthStr, isLimitExit);
          openPositions.splice(pIdx, 1);
        }
      }

      // -------------------------------------------------------------
      // 2. Process Pending Pivot Orders (Stop Confirmation)
      // -------------------------------------------------------------
      let canEnterNewTrade = true;
      let allowedMaxPositions = this.config.maxOpenPositions;
      let riskFraction = this.config.riskPerTradePct;

      if (this.config.pureLossGuard) {
        if (dailyRealizedPnl <= -dailyLossLimit) {
          canEnterNewTrade = false;
        }
        const isDefensive = (dailyRealizedPnl <= -(dailyLossLimit * 0.5));
        if (isDefensive) {
          allowedMaxPositions = 1;
          riskFraction *= 0.5;
        }
        let openPositionsMaxRisk = 0;
        for (const p of openPositions) {
          if (p.isBreakeven || p.stage1Taken) continue;
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
        if (!state || !state.pendingPivotOrder) continue;
        const order = state.pendingPivotOrder;
        const bar = state.candles[i];

        const unprotectedCount = openPositions.filter(p => !p.isBreakeven && !p.stage1Taken).length;
        const hasOppositeSide = openPositions.some(p => p.side !== order.side);
        const canFill = canEnterNewTrade
          && openPositions.length < allowedMaxPositions
          && unprotectedCount < this.config.maxUnprotectedPositions
          && !hasOppositeSide
          && !openPositions.some(p => p.symbol === sym);

        if (canFill) {
          const triggered = order.side === 'LONG'
            ? bar.high >= order.triggerPrice
            : bar.low <= order.triggerPrice;
          if (triggered) {
            const entryPrice = order.side === 'LONG'
              ? Math.max(bar.open, order.triggerPrice) * 1.0002
              : Math.min(bar.open, order.triggerPrice) * 0.9998;
            const stopDistance = order.side === 'LONG'
              ? entryPrice - order.sl
              : order.sl - entryPrice;

            if (stopDistance > 0) {
              const stopDistPct = stopDistance / entryPrice;
              if (stopDistPct >= 0.008 && stopDistPct <= 0.045) {
                const riskDollar = balance * riskFraction;
                let notional = riskDollar / stopDistPct;
                const maxNotional = Math.min(
                  balance * this.config.maxLeverage,
                  this.config.maxMargin * this.config.maxLeverage,
                );
                if (notional > maxNotional) notional = maxNotional;
                const size = notional / entryPrice;
                const tpStage1 = order.side === 'LONG'
                  ? entryPrice + stopDistance * this.config.minRRPivot
                  : entryPrice - stopDistance * this.config.minRRPivot;

                openPositions.push({
                  id: `OK_${sym}_${i}`,
                  symbol: sym,
                  side: order.side,
                  entryTime: dateStr,
                  entryPrice,
                  sl: order.sl,
                  initialStopLoss: order.sl,
                  initialStopDist: stopDistance,
                  tpStage1,
                  size,
                  notional,
                  riskDollar,
                  barsHeld: 0,
                  isBreakeven: false,
                  stage1Taken: false,
                  realizedPnl: 0,
                });
              }
            }
            state.pendingPivotOrder = null;
          } else {
            order.barsPending += 1;
            const invalidated = order.side === 'LONG' ? bar.close < order.sl : bar.close > order.sl;
            if (order.barsPending >= 3 || invalidated) state.pendingPivotOrder = null;
          }
        } else {
          state.pendingPivotOrder = null;
        }
      }

      // -------------------------------------------------------------
      // 3. Setup Detection on Bar Close (Strict Macro Regime + RS)
      // -------------------------------------------------------------
      const unprotectedCount = openPositions.filter(p => !p.isBreakeven && !p.stage1Taken).length;
      if (!canEnterNewTrade || openPositions.length >= allowedMaxPositions || unprotectedCount >= this.config.maxUnprotectedPositions) {
        continue;
      }

      const btcClose = btcCloses[i];
      const btcBull = btcClose > btcEma50[i] && btcEma50[i] > btcEma200[i];
      const btcBear = this.config.enableShort && btcClose < btcEma50[i] && btcEma50[i] < btcEma200[i];

      if (!btcBull && !btcBear) continue;

      const btcPerf = (btcClose - btcCloses[i - 24]) / btcCloses[i - 24];
      const rsScores = [];
      for (const sym of symbols) {
        const state = symData[sym];
        if (!state) continue;
        const sClose = state.closes[i];
        const sPerf = (sClose - state.closes[i - 24]) / state.closes[i - 24];
        rsScores.push({ sym, rs: sPerf - btcPerf });
      }

      if (btcBull && !openPositions.some(p => p.side === 'SHORT')) {
        rsScores.sort((a, b) => b.rs - a.rs);
        for (const item of rsScores) {
          const state = symData[item.sym];
          if (!state || openPositions.some(p => p.symbol === item.sym) || state.pendingPivotOrder) continue;

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
            const sl = bar.low - curAtr * this.config.atrBuffer;
            state.pendingPivotOrder = {
              side: 'LONG',
              triggerPrice: bar.high * 1.001,
              sl,
              barsPending: 0,
            };
          }
        }
      } else if (btcBear && !openPositions.some(p => p.side === 'LONG')) {
        rsScores.sort((a, b) => a.rs - b.rs);
        for (const item of rsScores) {
          const state = symData[item.sym];
          if (!state || openPositions.some(p => p.symbol === item.sym) || state.pendingPivotOrder) continue;

          const bar = state.candles[i];
          const close = state.closes[i];
          const e10 = state.ema10[i];
          const e20 = state.ema20[i];
          const e50 = state.ema50[i];
          const e200 = state.ema200[i];
          const curAtr = state.atr[i];

          const trendAligned = e10 < e20 && e20 < e50 && close < e200;
          const touched = (bar.high >= e10 * 0.998 || bar.high >= e20 * 0.996) && close <= e20 * 1.005;
          const isLaggard = item.rs <= 0.01;

          if (trendAligned && touched && isLaggard) {
            const sl = bar.high + curAtr * this.config.atrBuffer;
            state.pendingPivotOrder = {
              side: 'SHORT',
              triggerPrice: bar.low * 0.999,
              sl,
              barsPending: 0,
            };
          }
        }
      }
    }

    const totalTrades = closedTrades.length;
    const wins = closedTrades.filter(t => t.isWin).length;
    const losses = totalTrades - wins;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    let gp = 0;
    let gl = 0;
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
      avgWin,
      avgLoss,
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
