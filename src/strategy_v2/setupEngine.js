/**
 * Setup Engine for Strategy V2.
 * Detects SETUP_TREND_PULLBACK and calculates Entry Quality Score (0 - 10).
 * Implements Section 7, 8, 9, 10, 11, 12, 13.
 */

const {
  calculateEMA,
  calculateSMA,
  calculateATR,
  calculateRSI,
  getSlope,
  analyzeCandleStructure,
} = require('./indicators');

class SetupEngine {
  constructor(config) {
    this.config = config;
  }

  /**
   * Precomputes 15M indicators for a given asset.
   * @param {Array} candles15m 
   */
  precomputeIndicators(candles15m) {
    const n = candles15m.length;
    const closes = new Float64Array(n);
    const volumes = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      closes[i] = candles15m[i].close;
      volumes[i] = candles15m[i].volume;
    }

    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const ema200 = calculateEMA(closes, 200);
    const rsi = calculateRSI(closes, this.config.setup.rsiPeriod || 14);
    const atr = calculateATR(candles15m, 14);
    const volumeSma = calculateSMA(volumes, this.config.setup.volumeSmaPeriod || 20);

    return {
      closes,
      volumes,
      ema20,
      ema50,
      ema200,
      rsi,
      atr,
      volumeSma,
    };
  }

  /**
   * Evaluates if bar `i` on 15M forms a valid TREND_PULLBACK setup.
   * @param {number} i Index on 15M
   * @param {Array} candles15m 
   * @param {object} ind Precomputed indicators
   * @param {string} btcRegime 
   * @param {string} assetRegime 
   * @param {object} regimePermission 
   * @returns {{ valid: boolean, score: number, features: object }}
   */
  evaluateSetup(i, candles15m, ind, btcRegime, assetRegime, regimePermission) {
    if (i < 50) return { valid: false, score: 0, features: {} };
    if (!regimePermission.allowed) return { valid: false, score: 0, features: {} };

    const candle = candles15m[i];
    const prevCandle = candles15m[i - 1];
    const close = candle.close;
    const low = candle.low;
    const e20 = ind.ema20[i];
    const e50 = ind.ema50[i];
    const e200 = ind.ema200[i];
    const r = ind.rsi[i];
    const prevR = ind.rsi[i - 1];
    const a = ind.atr[i];
    const atrPct = close > 0 ? a / close : 0;
    const vol = candle.volume;
    const volSma = ind.volumeSma[i];
    const volumeRatio = volSma > 0 ? vol / volSma : 1.0;

    // Feature 1: Volatility Guard
    const minAtrPct = this.config.setup.minAtrPct || 0.003;
    const maxAtrPct = this.config.setup.maxAtrPct || 0.045;
    const volatilityHealthy = atrPct >= minAtrPct && atrPct <= maxAtrPct;

    // Feature 2: Pullback proximity to EMA20 / EMA50
    const prox = this.config.setup.emaPullbackProximity || 0.008;
    // Price low touched within prox of EMA20 or EMA50, but close remained above or near EMA50
    const touchedEma20 = low <= e20 * (1 + prox);
    const touchedEma50 = low <= e50 * (1 + prox);
    const heldAboveEma50 = close >= e50 * 0.996;
    const isPullback = (touchedEma20 || touchedEma50) && heldAboveEma50;

    // Feature 3: RSI in pullback zone
    const rsiMin = this.config.setup.rsiPullbackMin || 34;
    const rsiMax = this.config.setup.rsiPullbackMax || 49;
    const rsiInZone = r >= rsiMin && r <= rsiMax;
    const rsiCurlingUp = r >= prevR - 0.5;

    // Feature 4: Candle structure
    const candleStruct = analyzeCandleStructure(candle);
    const isBounceCandle = candleStruct.isBullish || candleStruct.lowerWickRatio >= 0.25 || candleStruct.isHammer;

    // Scoring Breakdown (0 to 10 points)
    let score = 0;

    // 1. Trend Alignment (+2 max)
    if (assetRegime === 'STRONG_UPTREND' && e20 > e50) {
      score += 2;
    } else if (assetRegime === 'UPTREND' || e20 > e50) {
      score += 1;
    }

    // 2. BTC Macro Regime (+2 max)
    score += regimePermission.btcScore;

    // 3. Pullback Quality (+1 max)
    if (isPullback && close > e20) {
      score += 1;
    } else if (isPullback) {
      score += 1;
    }

    // 4. RSI Confirmation (+1 max)
    if (rsiInZone && rsiCurlingUp) {
      score += 1;
    }

    // 5. Volume Confirmation (+1 max)
    if (volumeRatio >= (this.config.setup.minVolumeRatio || 1.15)) {
      score += 1;
    }

    // 6. Candle Structure (+1 max)
    if (isBounceCandle) {
      score += 1;
    }

    // 7. Volatility Healthy (+1 max)
    if (volatilityHealthy) {
      score += 1;
    }

    const minScore = this.config.scoring.minScoreToTrade || 7;
    const valid = score >= minScore && isPullback && isBounceCandle && volatilityHealthy;

    const features = {
      close,
      atr: a,
      atrPct,
      rsi: r,
      rsiCurlingUp,
      volumeRatio,
      distanceToEma20Pct: (close - e20) / close,
      distanceToEma50Pct: (close - e50) / close,
      candleStructure: candleStruct,
      btcRegime,
      assetRegime,
      setupName: this.config.setup.name,
      score,
    };

    return {
      valid,
      score,
      features,
    };
  }
}

module.exports = {
  SetupEngine,
};
