/**
 * Regime Engine for Strategy V2.
 * Calculates BTC Macro Regime and Individual Asset 1H Regimes.
 * Implements Regime Permission Matrix (Section 4, 5, 6).
 */

const { calculateEMA, calculateRSI, calculateATR, getSlope } = require('./indicators');

class RegimeEngine {
  constructor(config) {
    this.config = config;
  }

  /**
   * Precomputes BTC 1H Macro Regime states across all 1H bars.
   * @param {Array} btcCandles1h 
   * @returns {Array<string>} Array of regime strings
   */
  computeBtcMacroRegimes(btcCandles1h) {
    const n = btcCandles1h.length;
    const closes = new Float64Array(n);
    for (let i = 0; i < n; i++) closes[i] = btcCandles1h[i].close;

    const ema50 = calculateEMA(closes, this.config.regime.btcEmaFast || 50);
    const ema200 = calculateEMA(closes, this.config.regime.btcEmaSlow || 200);
    const ema4h200 = calculateEMA(closes, 800); // 4H EMA 200 proxy on 1H (200 * 4 = 800)

    const regimes = new Array(n);
    const slopeLookback = this.config.regime.btcSlopeLookback || 3;

    for (let i = 0; i < n; i++) {
      if (i < 800) {
        regimes[i] = 'NEUTRAL';
        continue;
      }
      const close = closes[i];
      const e50 = ema50[i];
      const e200 = ema200[i];
      const e4h200 = ema4h200[i];
      const slope50 = getSlope(ema50, i, slopeLookback);
      const slope200 = getSlope(ema200, i, slopeLookback);

      // Strong Bull: 1H in clear uptrend AND 4H Macro Trend Bullish (close > 4H 200 EMA)
      if (close > e50 && e50 > e200 && close > e4h200 && slope50 > 0 && slope200 >= 0) {
        regimes[i] = 'STRONG_BULL';
      } else if (close > e50 && e50 > e200 && close > e4h200) {
        regimes[i] = 'BULL';
      } else if (close < e50 && e50 < e200) {
        regimes[i] = 'BEAR';
      } else {
        regimes[i] = 'NEUTRAL';
      }
    }

    return {
      regimes,
      ema50,
      ema200,
    };
  }

  /**
   * Precomputes Asset 1H Regimes across all 1H bars.
   * @param {Array} assetCandles1h 
   */
  computeAssetRegimes(assetCandles1h) {
    const n = assetCandles1h.length;
    const closes = new Float64Array(n);
    for (let i = 0; i < n; i++) closes[i] = assetCandles1h[i].close;

    const ema20 = calculateEMA(closes, this.config.regime.assetEmaFast || 20);
    const ema50 = calculateEMA(closes, this.config.regime.assetEmaMid || 50);
    const ema200 = calculateEMA(closes, this.config.regime.assetEmaSlow || 200);
    const rsi = calculateRSI(closes, 14);

    const regimes = new Array(n);
    const slopeLookback = 3;

    for (let i = 0; i < n; i++) {
      if (i < 200) {
        regimes[i] = 'RANGE';
        continue;
      }
      const close = closes[i];
      const e20 = ema20[i];
      const e50 = ema50[i];
      const e200 = ema200[i];
      const slope20 = getSlope(ema20, i, slopeLookback);
      const r = rsi[i];

      if (close > e20 && e20 > e50 && e50 > e200 && slope20 > 0 && r > 50) {
        regimes[i] = 'STRONG_UPTREND';
      } else if (close > e50 && e50 > e200) {
        regimes[i] = 'UPTREND';
      } else if (close < e20 && e20 < e50 && e50 < e200) {
        regimes[i] = 'STRONG_DOWNTREND';
      } else if (close < e50 && e50 < e200) {
        regimes[i] = 'DOWNTREND';
      } else {
        regimes[i] = 'RANGE';
      }
    }

    return {
      regimes,
      ema20,
      ema50,
      ema200,
      rsi,
    };
  }

  /**
   * Checks if the regime permission matrix allows entering a LONG position.
   * @param {string} btcRegime 
   * @param {string} assetRegime 
   * @returns {{ allowed: boolean, btcScore: number, isLimited: boolean }}
   */
  checkLongPermission(btcRegime, assetRegime) {
    if (!this.config.regime.enabled) {
      return { allowed: true, btcScore: 1, isLimited: false };
    }

    if (btcRegime === 'STRONG_BULL') {
      if (assetRegime === 'STRONG_UPTREND') return { allowed: true, btcScore: 2, isLimited: false };
      if (assetRegime === 'UPTREND') return { allowed: true, btcScore: 2, isLimited: false };
      if (assetRegime === 'RANGE') return { allowed: false, btcScore: 0, isLimited: true };
    }

    if (btcRegime === 'BULL') {
      if (assetRegime === 'STRONG_UPTREND') return { allowed: true, btcScore: 1, isLimited: false };
      if (assetRegime === 'UPTREND') return { allowed: true, btcScore: 1, isLimited: false };
    }

    if (btcRegime === 'NEUTRAL') {
      if (assetRegime === 'STRONG_UPTREND') return { allowed: true, btcScore: 0, isLimited: true };
    }

    return { allowed: false, btcScore: 0, isLimited: false };
  }
}

module.exports = {
  RegimeEngine,
};
