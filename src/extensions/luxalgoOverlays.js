/**
 * LuxAlgo Signals & Overlays™ Reproduction Suite (v6.0/v6.1 Reverse-Engineered)
 * Features:
 * 1. Smart Trail: Ehlers Wilder's ATR Smoothed Dynamic S/R Bands
 * 2. Reversal Zones: Ehlers SuperSmoother 2-Pole Filter + Dual Standard Deviation Envelopes
 * 3. Confirmation Signals: Normal & Strong (+) Buy/Sell Trend Confirmation Markers
 */

'use strict';

/**
 * Ehlers SuperSmoother 2-pole Filter
 * Produces low-lag, smooth curve without aliasing
 */
function calcSuperSmoother(src, length) {
  const len = Math.max(5, length || 100);
  const pi = Math.PI;
  const a1 = Math.exp(-Math.SQRT2 * pi / len);
  const b1 = 2 * a1 * Math.cos(Math.SQRT2 * pi / len);
  const c2 = b1;
  const c3 = -a1 * a1;
  const c1 = 1 - c2 - c3;

  const out = new Array(src.length).fill(src[0] || 0);
  if (src.length > 1) out[1] = src[1];

  for (let i = 2; i < src.length; i++) {
    out[i] = c1 * src[i] + c2 * out[i - 1] + c3 * out[i - 2];
  }
  return out;
}

/**
 * True Range array calculation
 */
function calcTR(candles) {
  const tr = new Array(candles.length).fill(0);
  if (candles.length === 0) return tr;
  tr[0] = candles[0].high - candles[0].low;

  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }
  return tr;
}

/**
 * Wilder's Moving Average (RMA)
 */
function calcWilderMA(values, length) {
  const out = new Array(values.length).fill(0);
  if (values.length < length) return out;

  let sum = 0;
  for (let i = 0; i < length; i++) sum += values[i];
  out[length - 1] = sum / length;

  for (let i = length; i < values.length; i++) {
    out[i] = (out[i - 1] * (length - 1) + values[i]) / length;
  }
  return out;
}

/**
 * Exponential Moving Average
 */
function calcEMA(values, length) {
  const out = new Array(values.length).fill(0);
  if (values.length < length) return out;
  const k = 2 / (length + 1);

  let sum = 0;
  for (let i = 0; i < length; i++) sum += values[i];
  out[length - 1] = sum / length;

  for (let i = length; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/**
 * LuxAlgo Smart Trail
 * Algorithm: Modified True Range trail with Wilder's Loss bands and Exponential Smoothing
 * Parameters:
 *   atrPeriod = 10
 *   atrFactor = 4.0
 *   smoothing = 8
 */
function calcSmartTrail(candles, atrPeriod = 10, atrFactor = 4.0, smoothing = 8) {
  if (!candles || candles.length < atrPeriod + smoothing) return [];

  const tr = calcTR(candles);
  const atr = calcWilderMA(tr, atrPeriod);
  const closes = candles.map(c => c.close);
  const smoothedCloses = calcEMA(closes, smoothing);

  let trail = smoothedCloses[0];
  let direction = 1; // 1 = Bullish (Long), -1 = Bearish (Short)
  const result = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const loss = atrFactor * (atr[i] || (c.high - c.low));
    const src = smoothedCloses[i] || c.close;

    if (direction === 1) {
      // In uptrend, trail ratchets upward only
      const candidateTrail = src - loss;
      trail = Math.max(trail, candidateTrail);
      if (c.close < trail) {
        direction = -1; // Flip to Bearish
        trail = src + loss;
      }
    } else {
      // In downtrend, trail ratchets downward only
      const candidateTrail = src + loss;
      trail = Math.min(trail, candidateTrail);
      if (c.close > trail) {
        direction = 1; // Flip to Bullish
        trail = src - loss;
      }
    }

    result.push({
      time: c.time,
      trail: parseFloat(trail.toFixed(4)),
      direction: direction === 1 ? 'BULL' : 'BEAR',
      color: direction === 1 ? '#2157f9' : '#ef5350',
    });
  }

  return result;
}

/**
 * LuxAlgo Reversal Zones
 * Algorithm: Ehlers SuperSmoother baseline + Dynamic StDev Envelope Bands
 * Parameters:
 *   length = 100
 *   innerMult = 1.0
 *   outerMult = 2.415
 */
function calcReversalZones(candles, length = 100, innerMult = 1.0, outerMult = 2.415) {
  if (!candles || candles.length < 20) return [];

  const hlc3 = candles.map(c => (c.high + c.low + c.close) / 3);
  const smooth = calcSuperSmoother(hlc3, length);

  const result = [];
  const lookback = Math.min(length, 60);

  for (let i = 0; i < candles.length; i++) {
    const base = smooth[i];
    let variance = 0;
    const start = Math.max(0, i - lookback + 1);
    const count = i - start + 1;

    for (let j = start; j <= i; j++) {
      const diff = hlc3[j] - smooth[j];
      variance += diff * diff;
    }
    const stdDev = Math.sqrt(variance / count) || (base * 0.01);

    const upperOuter = base + stdDev * outerMult;
    const upperInner = base + stdDev * innerMult;
    const lowerInner = base - stdDev * innerMult;
    const lowerOuter = base - stdDev * outerMult;

    result.push({
      time: candles[i].time,
      base: parseFloat(base.toFixed(4)),
      upperOuter: parseFloat(upperOuter.toFixed(4)),
      upperInner: parseFloat(upperInner.toFixed(4)),
      lowerInner: parseFloat(lowerInner.toFixed(4)),
      lowerOuter: parseFloat(lowerOuter.toFixed(4)),
      currentPrice: candles[i].close,
      isOverbought: candles[i].high >= upperInner,
      isExtremeOverbought: candles[i].high >= upperOuter,
      isOversold: candles[i].low <= lowerInner,
      isExtremeOversold: candles[i].low <= lowerOuter,
    });
  }

  return result;
}

/**
 * LuxAlgo Confirmation Signals & Equalizer Classifier
 * Evaluates trend transitions, Smart Trail crossings, and volume momentum
 */
function generateConfirmationSignals(candles, smartTrail, reversalZones) {
  if (!candles || !smartTrail || smartTrail.length < 5) return [];

  const signals = [];
  let prevDir = smartTrail[0].direction;

  for (let i = 1; i < candles.length; i++) {
    const bar = candles[i];
    const trail = smartTrail[i];
    const curDir = trail.direction;
    const rz = reversalZones ? reversalZones[i] : null;

    let signalType = null;
    let isStrong = false;

    // Flip from BEAR to BULL -> BUY Confirmation Signal
    if (prevDir === 'BEAR' && curDir === 'BULL') {
      signalType = 'BUY';
      // Strong Buy if price bounces out of oversold zone with solid volume
      if (rz && (rz.isOversold || bar.low <= rz.lowerInner)) {
        isStrong = true;
      }
    }
    // Flip from BULL to BEAR -> SELL Confirmation Signal
    else if (prevDir === 'BULL' && curDir === 'BEAR') {
      signalType = 'SELL';
      // Strong Sell if price rejects from overbought zone
      if (rz && (rz.isOverbought || bar.high >= rz.upperInner)) {
        isStrong = true;
      }
    }

    if (signalType) {
      signals.push({
        time: bar.time,
        price: bar.close,
        type: signalType,
        isStrong,
        label: isStrong ? (signalType === 'BUY' ? 'BUY +' : 'SELL +') : signalType,
        color: signalType === 'BUY' ? '#26a69a' : '#ef5350',
      });
    }

    prevDir = curDir;
  }

  return signals;
}

/**
 * Full LuxAlgo Signals & Overlays Suite Pipeline
 */
function evaluateLuxAlgoOverlays(candles) {
  const smartTrail = calcSmartTrail(candles, 10, 4.0, 8);
  const reversalZones = calcReversalZones(candles, 100, 1.0, 2.415);
  const signals = generateConfirmationSignals(candles, smartTrail, reversalZones);

  const latestTrail = smartTrail.length ? smartTrail[smartTrail.length - 1] : null;
  const latestRz = reversalZones.length ? reversalZones[reversalZones.length - 1] : null;
  const latestSignal = signals.length ? signals[signals.length - 1] : null;

  return {
    smartTrail,
    reversalZones,
    signals,
    latestState: {
      trailDirection: latestTrail ? latestTrail.direction : 'NEUTRAL',
      trailPrice: latestTrail ? latestTrail.trail : null,
      inReversalZone: latestRz ? (latestRz.isOverbought ? 'OVERBOUGHT' : latestRz.isOversold ? 'OVERSOLD' : 'NEUTRAL') : 'NEUTRAL',
      lastSignal: latestSignal ? latestSignal : null,
    }
  };
}

module.exports = {
  calcSuperSmoother,
  calcSmartTrail,
  calcReversalZones,
  generateConfirmationSignals,
  evaluateLuxAlgoOverlays,
};
