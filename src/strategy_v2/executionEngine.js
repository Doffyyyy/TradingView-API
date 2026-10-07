/**
 * Execution Engine for Strategy V2.
 * Pure bar-by-bar walkforward runner with zero lookahead bias.
 * Implements Section 1, 2, 3, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25.
 */

const { HtfAccessor } = require('./htfAccessor');
const { RegimeEngine } = require('./regimeEngine');
const { SetupEngine } = require('./setupEngine');
const { RiskEngine } = require('./riskEngine');
const { ExitEngine } = require('./exitEngine');
const { Reporter } = require('./reporter');

class ExecutionEngine {
  constructor(config) {
    this.config = config;
    this.regimeEngine = new RegimeEngine(config);
    this.setupEngine = new SetupEngine(config);
    this.riskEngine = new RiskEngine(config);
    this.exitEngine = new ExitEngine(config);
  }

  /**
   * Runs the full backtest simulation over candles dataset.
   * @param {object} candleData Object containing '{symbol}_15m' and '{symbol}_1h' arrays
   * @param {Array<string>} symbols List of symbols to trade
   * @returns {{ report: object, trades: Array, equityHistory: Array }}
   */
  run(candleData, symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'NEARUSDT']) {
    const btc1h = candleData['BTCUSDT_1h'];
    if (!btc1h) throw new Error('BTCUSDT_1h candles required for Macro Regime');

    // 1. Precompute BTC Macro Regimes on 1H
    const btcRegimeData = this.regimeEngine.computeBtcMacroRegimes(btc1h);

    // 2. Setup Accessors and precomputed state for each traded symbol
    const assetState = {};
    for (const sym of symbols) {
      const c15 = candleData[`${sym}_15m`];
      const c1 = candleData[`${sym}_1h`];
      if (!c15 || !c1) continue;

      const accessor = new HtfAccessor(c15, c1);
      const btcAccessor = new HtfAccessor(c15, btc1h);
      const regimes = this.regimeEngine.computeAssetRegimes(c1);
      const indicators15m = this.setupEngine.precomputeIndicators(c15);

      assetState[sym] = {
        symbol: sym,
        c15,
        c1,
        accessor,
        btcAccessor,
        regimes,
        ind: indicators15m,
        pendingOrder: null, // Queued signal waiting for next bar open
      };
    }

    // Determine simulation bar range based on common 15M length
    const sampleSym = symbols[0];
    const totalBars = assetState[sampleSym].c15.length;

    // Portfolio State
    let equity = this.config.initialEquity || 10000;
    const initialEquity = equity;
    let openPositions = []; // Array of active positions
    const closedTrades = [];
    const equityHistory = [];

    // Daily Circuit Breaker Tracking
    let currentDayKey = '';
    let dayStartingEquity = equity;
    let dayRealizedPnl = 0;
    let dayBreakerTripped = false;

    // 3. Bar-by-bar walkforward execution across 15M timeline
    for (let barIdx = 200; barIdx < totalBars; barIdx++) {
      const currentTimestamp = assetState[sampleSym].c15[barIdx].time;
      const dateObj = new Date(currentTimestamp);
      const dayKey = dateObj.toISOString().slice(0, 10);

      // Check daily boundary
      if (dayKey !== currentDayKey) {
        currentDayKey = dayKey;
        dayStartingEquity = equity;
        dayRealizedPnl = 0;
        dayBreakerTripped = false;
      }

      // Check Daily Circuit Breaker (Section 20)
      const maxDailyLossDollar = dayStartingEquity * (this.config.risk.maxDailyLossPct || 0.02);
      if (dayRealizedPnl <= -maxDailyLossDollar) {
        dayBreakerTripped = true;
      }

      // -------------------------------------------------------------
      // STEP A: Execute Pending Orders from Previous Bar at Bar OPEN
      // -------------------------------------------------------------
      for (const sym of symbols) {
        const state = assetState[sym];
        if (!state || !state.pendingOrder) continue;

        const pending = state.pendingOrder;
        state.pendingOrder = null; // Clear queue

        if (dayBreakerTripped) continue; // Skip entry if circuit breaker is tripped

        // Check if already in position for this symbol
        const alreadyOpen = openPositions.some(p => p.symbol === sym);
        if (alreadyOpen) continue;

        const currentCandle = state.c15[barIdx];
        const rawOpen = currentCandle.open;
        const slippageBps = this.config.execution.slippageBps || 2;
        const entryPrice = rawOpen * (1 + slippageBps / 10000);

        // Recalculate stop distance against actual entry price
        const stopDistance = entryPrice - pending.stopLoss;
        if (stopDistance <= 0) continue;

        // Position Sizing (Risk-based: Section 15)
        const sizeInfo = this.riskEngine.calculatePositionSize(equity, entryPrice, stopDistance);
        if (sizeInfo.notional <= 0 || sizeInfo.size <= 0) continue;

        // Portfolio Exposure Guard (Section 21)
        const exposureCheck = this.riskEngine.canOpenNewPosition(equity, openPositions, sizeInfo.riskDollar);
        if (!exposureCheck.allowed) continue;

        // Calculate entry fee (taker)
        const entryFee = sizeInfo.notional * (this.config.execution.takerFee || 0.00035);

        // Open Position
        const newPos = {
          id: `T2_${sym}_${barIdx}_${Date.now()}`,
          symbol: sym,
          side: 'LONG',
          signalIndex: pending.signalIndex,
          signalTime: new Date(pending.signalTime).toISOString(),
          entryIndex: barIdx,
          entryTime: new Date(currentCandle.time).toISOString(),
          entryPrice,
          stopLoss: pending.stopLoss,
          stopDistance,
          notional: sizeInfo.notional,
          size: sizeInfo.size,
          riskDollar: sizeInfo.riskDollar,
          riskPercent: sizeInfo.riskPct,
          leverage: sizeInfo.leverage,
          entryFee,
          slippage: sizeInfo.notional * (slippageBps / 10000),
          btcRegime: pending.btcRegime,
          assetRegime: pending.assetRegime,
          setup: pending.setup,
          entryScore: pending.score,
          rsi: pending.features.rsi,
          atrPct: pending.features.atrPct,
          volumeRatio: pending.features.volumeRatio,
        };

        this.exitEngine.initPositionState(newPos);
        openPositions.push(newPos);
      }

      // -------------------------------------------------------------
      // STEP B: Check Exits on Current Bar for Open Positions
      // -------------------------------------------------------------
      const remainingPositions = [];
      for (const pos of openPositions) {
        const state = assetState[pos.symbol];
        const currentCandle = state.c15[barIdx];
        const currentAtr = state.ind.atr[barIdx];

        const exitResult = this.exitEngine.checkExit(pos, currentCandle, currentAtr);

        if (exitResult.closed) {
          // Position closed
          const exitPrice = exitResult.exitPrice;
          const exitNotional = pos.size * exitPrice;
          const exitFee = exitNotional * (this.config.execution.takerFee || 0.00035);
          const totalFees = pos.entryFee + exitFee;

          const grossPnl = (exitPrice - pos.entryPrice) * pos.size;
          const netPnl = grossPnl - totalFees;
          const pnlR = pos.stopDistance > 0 ? (exitPrice - pos.entryPrice) / pos.stopDistance : 0;

          // Update equity
          equity += netPnl;
          dayRealizedPnl += netPnl;

          const tradeRecord = {
            id: pos.id,
            symbol: pos.symbol,
            side: pos.side,
            signalTime: pos.signalTime,
            entryTime: pos.entryTime,
            exitTime: new Date(currentCandle.time + 15 * 60 * 1000).toISOString(),
            entryPrice: pos.entryPrice,
            exitPrice,
            stopLoss: pos.stopLoss,
            notional: pos.notional,
            size: pos.size,
            equityBefore: equity - netPnl,
            equityAfter: equity,
            riskDollar: pos.riskDollar,
            riskPercent: pos.riskPercent,
            pnlDollar: netPnl,
            pnlPercent: (netPnl / pos.notional) * 100,
            pnlR,
            fees: totalFees,
            slippage: pos.slippage,
            btcRegime: pos.btcRegime,
            assetRegime: pos.assetRegime,
            setup: pos.setup,
            entryScore: pos.entryScore,
            rsi: pos.rsi,
            atrPct: pos.atrPct,
            volumeRatio: pos.volumeRatio,
            mfe: pos.maxFavorableExcursion,
            mae: pos.maxAdverseExcursion,
            mfeR: pos.stopDistance > 0 ? pos.maxFavorableExcursion / pos.stopDistance : 0,
            maeR: pos.stopDistance > 0 ? pos.maxAdverseExcursion / pos.stopDistance : 0,
            exitReason: exitResult.exitReason,
            holdingBars: pos.holdingBars,
          };

          closedTrades.push(tradeRecord);
        } else {
          remainingPositions.push(pos);
        }
      }
      openPositions = remainingPositions;

      // Track equity snapshot
      if (barIdx % 4 === 0) { // Every hour
        equityHistory.push({
          timestamp: new Date(currentTimestamp).toISOString(),
          equity,
          openPositionsCount: openPositions.length,
        });
      }

      // -------------------------------------------------------------
      // STEP C: Generate New Signals on Bar CLOSE for Next Bar Entry
      // -------------------------------------------------------------
      if (!dayBreakerTripped && openPositions.length < (this.config.risk.maxOpenPositions || 3)) {
        for (const sym of symbols) {
          const state = assetState[sym];
          if (!state) continue;

          // If already in position or already queued pending order, skip
          if (openPositions.some(p => p.symbol === sym) || state.pendingOrder) continue;

          // Get last CLOSED 1H bar indices for BTC and Asset (Zero Lookahead Accessor)
          const btc1hIdx = state.btcAccessor.getLastClosed1hIndex(barIdx);
          const asset1hIdx = state.accessor.getLastClosed1hIndex(barIdx);
          if (btc1hIdx < 0 || asset1hIdx < 0) continue;

          const btcRegime = btcRegimeData.regimes[btc1hIdx] || 'NEUTRAL';
          const assetRegime = state.regimes.regimes[asset1hIdx] || 'RANGE';

          // Check Regime Permission Matrix (Section 6)
          const permission = this.regimeEngine.checkLongPermission(btcRegime, assetRegime);
          if (!permission.allowed) continue;

          // Evaluate Setup & Scoring (Section 8, 9, 10)
          const setupEval = this.setupEngine.evaluateSetup(
            barIdx,
            state.c15,
            state.ind,
            btcRegime,
            assetRegime,
            permission
          );

          if (setupEval.valid) {
            const currentClose = state.c15[barIdx].close;
            const currentAtr = state.ind.atr[barIdx];

            // Structural SL calculation
            const slResult = this.riskEngine.calculateStopLoss(state.c15, barIdx, currentClose, currentAtr);
            if (slResult.valid) {
              // Signal generated at bar CLOSE! Queue pending entry for next bar OPEN
              state.pendingOrder = {
                signalIndex: barIdx,
                signalTime: state.c15[barIdx].time,
                stopLoss: slResult.stopLoss,
                stopDistance: slResult.stopDistance,
                btcRegime,
                assetRegime,
                setup: setupEval.features.setupName,
                score: setupEval.score,
                features: setupEval.features,
              };
            }
          }
        }
      }
    }

    // Force close any remaining open positions at the end of simulation
    if (openPositions.length > 0) {
      const lastBar = totalBars - 1;
      for (const pos of openPositions) {
        const state = assetState[pos.symbol];
        const lastCandle = state.c15[lastBar];
        const exitPrice = lastCandle.close;
        const exitNotional = pos.size * exitPrice;
        const exitFee = exitNotional * (this.config.execution.takerFee || 0.00035);
        const totalFees = pos.entryFee + exitFee;
        const grossPnl = (exitPrice - pos.entryPrice) * pos.size;
        const netPnl = grossPnl - totalFees;
        const pnlR = pos.stopDistance > 0 ? (exitPrice - pos.entryPrice) / pos.stopDistance : 0;

        equity += netPnl;
        closedTrades.push({
          id: pos.id,
          symbol: pos.symbol,
          side: pos.side,
          signalTime: pos.signalTime,
          entryTime: pos.entryTime,
          exitTime: new Date(lastCandle.time).toISOString(),
          entryPrice: pos.entryPrice,
          exitPrice,
          stopLoss: pos.stopLoss,
          notional: pos.notional,
          size: pos.size,
          equityBefore: equity - netPnl,
          equityAfter: equity,
          riskDollar: pos.riskDollar,
          riskPercent: pos.riskPercent,
          pnlDollar: netPnl,
          pnlPercent: (netPnl / pos.notional) * 100,
          pnlR,
          fees: totalFees,
          slippage: pos.slippage,
          btcRegime: pos.btcRegime,
          assetRegime: pos.assetRegime,
          setup: pos.setup,
          entryScore: pos.entryScore,
          rsi: pos.rsi,
          atrPct: pos.atrPct,
          volumeRatio: pos.volumeRatio,
          mfe: pos.maxFavorableExcursion,
          mae: pos.maxAdverseExcursion,
          mfeR: pos.stopDistance > 0 ? pos.maxFavorableExcursion / pos.stopDistance : 0,
          maeR: pos.stopDistance > 0 ? pos.maxAdverseExcursion / pos.stopDistance : 0,
          exitReason: 'FORCED_END_OF_BACKTEST',
          holdingBars: pos.holdingBars,
        });
      }
    }

    // Generate comprehensive performance report
    const report = Reporter.generateReport(closedTrades, equityHistory, initialEquity, this.config);

    return {
      report,
      trades: closedTrades,
      equityHistory,
    };
  }
}

module.exports = {
  ExecutionEngine,
};
