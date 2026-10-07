/**
 * Risk Engine for Strategy V2.
 * Implements:
 *   - Structural SL with ATR buffer (Section 14)
 *   - Risk-based Position Sizing (Section 15, 16)
 *   - Portfolio Risk Guard & Max Open Positions (Section 21)
 *   - Daily Circuit Breaker (Section 20)
 */

const { getSwingLow } = require('./indicators');

class RiskEngine {
  constructor(config) {
    this.config = config;
  }

  /**
   * Calculates Structural Stop Loss and Stop Distance.
   * @param {Array} candles15m 
   * @param {number} barIndex 
   * @param {number} entryPrice 
   * @param {number} atr 
   * @returns {{ valid: boolean, stopLoss: number, stopDistance: number, stopPct: number, reason: string }}
   */
  calculateStopLoss(candles15m, barIndex, entryPrice, atr) {
    const slCfg = this.config.stopLoss;
    const lookback = slCfg.swingLookback || 12;
    const atrBuffer = (slCfg.atrBufferMultiplier || 0.5) * atr;

    const swingLow = getSwingLow(candles15m, barIndex, lookback);
    let stopLoss = swingLow - atrBuffer;

    let stopDistance = entryPrice - stopLoss;
    let stopPct = stopDistance / entryPrice;

    // Check bounds
    if (stopPct > (slCfg.maxStopPct || 0.035)) {
      return {
        valid: false,
        stopLoss: 0,
        stopDistance: 0,
        stopPct,
        reason: `Stop distance too wide (${(stopPct * 100).toFixed(2)}% > ${(slCfg.maxStopPct * 100).toFixed(1)}%)`,
      };
    }

    if (stopPct < (slCfg.minStopPct || 0.006)) {
      // Adjust to minimum safe stop distance
      stopDistance = entryPrice * (slCfg.minStopPct || 0.006);
      stopLoss = entryPrice - stopDistance;
      stopPct = stopDistance / entryPrice;
    }

    return {
      valid: true,
      stopLoss,
      stopDistance,
      stopPct,
      reason: 'STRUCTURAL_SWING_LOW',
    };
  }

  /**
   * Calculates Position Size based on fixed dollar risk.
   * @param {number} equity Current account equity
   * @param {number} entryPrice 
   * @param {number} stopDistance 
   * @returns {{ notional: number, size: number, riskDollar: number, riskPct: number, leverage: number }}
   */
  calculatePositionSize(equity, entryPrice, stopDistance) {
    const riskCfg = this.config.risk;
    const riskPct = riskCfg.riskPerTradePct || 0.005; // 0.5%
    const riskDollar = equity * riskPct;

    const stopDistancePct = stopDistance / entryPrice;
    let notional = riskDollar / stopDistancePct;

    // Apply max leverage cap
    const maxLeverage = riskCfg.maxLeverage || 2.0;
    const maxNotional = equity * maxLeverage;

    if (notional > maxNotional) {
      notional = maxNotional;
    }

    const size = notional / entryPrice;
    const effectiveRiskDollar = notional * stopDistancePct;
    const effectiveRiskPct = effectiveRiskDollar / equity;
    const leverage = notional / equity;

    return {
      notional,
      size,
      riskDollar: effectiveRiskDollar,
      riskPct: effectiveRiskPct,
      leverage,
    };
  }

  /**
   * Verifies portfolio exposure constraints.
   * @param {number} currentEquity 
   * @param {Array} openPositions 
   * @param {number} newTradeRiskDollar 
   * @returns {{ allowed: boolean, reason: string }}
   */
  canOpenNewPosition(currentEquity, openPositions, newTradeRiskDollar) {
    const riskCfg = this.config.risk;

    // 1. Max open positions
    if (openPositions.length >= (riskCfg.maxOpenPositions || 3)) {
      return {
        allowed: false,
        reason: `Max open positions limit reached (${openPositions.length}/${riskCfg.maxOpenPositions})`,
      };
    }

    // 2. Max portfolio risk
    let totalOpenRisk = 0;
    for (const p of openPositions) {
      totalOpenRisk += p.riskDollar || 0;
    }

    const maxPortfolioRiskDollar = currentEquity * (riskCfg.maxPortfolioRiskPct || 0.015);
    if (totalOpenRisk + newTradeRiskDollar > maxPortfolioRiskDollar) {
      return {
        allowed: false,
        reason: `Max portfolio risk exceeded ($${(totalOpenRisk + newTradeRiskDollar).toFixed(2)} > $${maxPortfolioRiskDollar.toFixed(2)})`,
      };
    }

    return { allowed: true, reason: 'OK' };
  }
}

module.exports = {
  RiskEngine,
};
