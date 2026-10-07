/**
 * Exit Engine for Strategy V2.
 * Implements 4 Exit Models (Section 17), Conservative Intrabar Conflict Handling (Section 18),
 * Time-based exits (Section 26), and MFE/MAE tracking (Section 25).
 */

class ExitEngine {
  constructor(config) {
    this.config = config;
  }

  /**
   * Initializes state tracking for a new position.
   * @param {object} pos 
   */
  initPositionState(pos) {
    pos.holdingBars = 0;
    pos.highestPrice = pos.entryPrice;
    pos.lowestPrice = pos.entryPrice;
    pos.maxFavorableExcursion = 0;
    pos.maxAdverseExcursion = 0;
    pos.isBreakeven = false;
    pos.partialTaken = false;
    pos.partialExitPrice = 0;
    pos.partialExitQty = 0;
    pos.partialRealizedPnl = 0;
    pos.trailingStopPrice = pos.stopLoss;
  }

  /**
   * Evaluates bar-by-bar exit conditions for an open LONG position.
   * @param {object} pos Open position object
   * @param {object} candle Current 15M candle
   * @param {number} currentAtr Current 15M ATR
   * @returns {{ closed: boolean, exitPrice: number, exitReason: string, partialClosed?: boolean, partialPrice?: number }}
   */
  checkExit(pos, candle, currentAtr) {
    pos.holdingBars++;

    // Update MFE & MAE
    if (candle.high > pos.highestPrice) pos.highestPrice = candle.high;
    if (candle.low < pos.lowestPrice) pos.lowestPrice = candle.low;

    const currentFavorable = pos.highestPrice - pos.entryPrice;
    const currentAdverse = pos.entryPrice - pos.lowestPrice;
    if (currentFavorable > pos.maxFavorableExcursion) pos.maxFavorableExcursion = currentFavorable;
    if (currentAdverse > pos.maxAdverseExcursion) pos.maxAdverseExcursion = currentAdverse;

    const exitCfg = this.config.exit;
    const mode = exitCfg.mode || 'FIXED_R';
    const R = pos.stopDistance;
    const roundTripFeeBuffer = pos.entryPrice * (this.config.execution.takerFee * 2.5);

    // -------------------------------------------------------------
    // MODE 1: EXIT_FIXED_R
    // -------------------------------------------------------------
    if (mode === 'FIXED_R') {
      const tpPrice = pos.entryPrice + R * (exitCfg.riskRewardRatio || 2.0);
      const slPrice = pos.stopLoss;

      const hitTp = candle.high >= tpPrice;
      const hitSl = candle.low <= slPrice;

      // Section 18: Conservative Intrabar Handling (SL First if both hit)
      if (hitTp && hitSl) {
        return { closed: true, exitPrice: slPrice, exitReason: 'STOP_LOSS' };
      }
      if (hitSl) {
        return { closed: true, exitPrice: slPrice, exitReason: 'STOP_LOSS' };
      }
      if (hitTp) {
        return { closed: true, exitPrice: tpPrice, exitReason: 'TAKE_PROFIT' };
      }
    }

    // -------------------------------------------------------------
    // MODE 2: EXIT_BE_PLUS_TARGET
    // -------------------------------------------------------------
    else if (mode === 'BE_PLUS_TARGET') {
      const tpPrice = pos.entryPrice + R * (exitCfg.riskRewardRatio || 2.0);
      const beTriggerPrice = pos.entryPrice + R * (exitCfg.beTriggerR || 1.0);

      // Check if price reached BE trigger level
      if (!pos.isBreakeven && candle.high >= beTriggerPrice) {
        pos.isBreakeven = true;
        pos.stopLoss = pos.entryPrice + roundTripFeeBuffer; // Move SL to BE + fees
      }

      const slPrice = pos.stopLoss;
      const hitTp = candle.high >= tpPrice;
      const hitSl = candle.low <= slPrice;

      if (hitTp && hitSl) {
        return { closed: true, exitPrice: slPrice, exitReason: pos.isBreakeven ? 'BREAKEVEN' : 'STOP_LOSS' };
      }
      if (hitSl) {
        return { closed: true, exitPrice: slPrice, exitReason: pos.isBreakeven ? 'BREAKEVEN' : 'STOP_LOSS' };
      }
      if (hitTp) {
        return { closed: true, exitPrice: tpPrice, exitReason: 'TAKE_PROFIT' };
      }
    }

    // -------------------------------------------------------------
    // MODE 3: EXIT_PARTIAL_TRAIL
    // -------------------------------------------------------------
    else if (mode === 'PARTIAL_TRAIL') {
      const partialTpPrice = pos.entryPrice + R * (exitCfg.partialTpR || 1.0);
      const finalTpPrice = pos.entryPrice + R * (exitCfg.riskRewardRatio || 2.5);

      // Take 50% partial profit
      if (!pos.partialTaken && candle.high >= partialTpPrice) {
        pos.partialTaken = true;
        pos.partialExitPrice = partialTpPrice;
        pos.partialExitQty = pos.size * (exitCfg.partialTpRatio || 0.5);
        pos.isBreakeven = true;
        pos.stopLoss = pos.entryPrice + roundTripFeeBuffer;
      }

      const slPrice = pos.stopLoss;
      const hitSl = candle.low <= slPrice;
      const hitFinal = candle.high >= finalTpPrice;

      if (hitSl && hitFinal) {
        return { closed: true, exitPrice: slPrice, exitReason: pos.isBreakeven ? 'BREAKEVEN' : 'STOP_LOSS' };
      }
      if (hitSl) {
        return { closed: true, exitPrice: slPrice, exitReason: pos.isBreakeven ? 'BREAKEVEN' : 'STOP_LOSS' };
      }
      if (hitFinal) {
        return { closed: true, exitPrice: finalTpPrice, exitReason: 'TAKE_PROFIT' };
      }
    }

    // -------------------------------------------------------------
    // MODE 4: EXIT_ATR_TRAIL
    // -------------------------------------------------------------
    else if (mode === 'ATR_TRAIL') {
      const trailMult = exitCfg.atrTrailMultiplier || 2.0;
      const minProfitToTrail = pos.entryPrice + R * 0.8;

      if (candle.high >= minProfitToTrail) {
        const potentialTrail = pos.highestPrice - currentAtr * trailMult;
        if (potentialTrail > pos.trailingStopPrice) {
          pos.trailingStopPrice = potentialTrail;
          pos.stopLoss = Math.max(pos.stopLoss, potentialTrail);
        }
      }

      const slPrice = pos.stopLoss;
      if (candle.low <= slPrice) {
        const isTrailing = pos.stopLoss > pos.entryPrice;
        return {
          closed: true,
          exitPrice: slPrice,
          exitReason: isTrailing ? 'TRAILING_STOP' : 'STOP_LOSS',
        };
      }
    }

    // -------------------------------------------------------------
    // Section 26: Time Exit
    // -------------------------------------------------------------
    const maxBars = exitCfg.maxHoldingBars || 48;
    if (pos.holdingBars >= maxBars) {
      return {
        closed: true,
        exitPrice: candle.close,
        exitReason: 'TIME_EXIT',
      };
    }

    return { closed: false };
  }
}

module.exports = {
  ExitEngine,
};
