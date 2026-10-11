/**
 * EMA30 Band Breakout Engine (Enhanced Clone of EL COBER's Pine Script v6)
 *
 * Core Concept:
 *   - Upper Band: EMA(high, 30)
 *   - Lower Band: EMA(low, 30)
 *   - Trend Filter: EMA(close, 200)
 *   - Dynamic Swing Excursion Tracking: records previous peaks/troughs outside the band
 *
 * Enhanced Safeguards to address original drawbacks:
 *   1. Volume Confirmation Filter (relVol >= 1.2x) to reject low-volume fakeouts.
 *   2. EMA200 Slope / Chop Guard to prevent whipsaw losses when market is flat.
 *   3. Dynamic Structural SL (at opposite band) and Target TP (2.0 R:R).
 *   4. Band Width Volatility Expansion metric.
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

  for (let i = initCount; i < n; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcSMA(values, period) {
  const n = values.length;
  const sma = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) {
      sum -= values[i - period];
      sma[i] = sum / period;
    } else if (i === period - 1) {
      sma[i] = sum / period;
    } else {
      sma[i] = sum / (i + 1);
    }
  }
  return sma;
}

function calcATR(candles, period = 14) {
  const n = candles.length;
  const atr = new Float64Array(n);
  if (n === 0) return atr;

  const tr = new Float64Array(n);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }

  let trSum = 0;
  const initCount = Math.min(period, n);
  for (let i = 0; i < initCount; i++) trSum += tr[i];
  atr[initCount - 1] = trSum / initCount;

  for (let i = initCount; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

/**
 * Evaluates EMA30 Band Breakout on an array of candles.
 * @param {Array} candles [{ time, open, high, low, close, volume }]
 * @param {object} options
 * @returns {object}
 */
function evaluateEma30BandBreakout(candles, options = {}) {
  const lenBand = options.lenBand || 30;
  const len200 = options.len200 || 200;
  const useTrend = options.useTrend !== undefined ? options.useTrend : true;
  const useClose = options.useClose !== undefined ? options.useClose : true;
  const useShort = options.useShort !== undefined ? options.useShort : true;
  const revOn = options.revOn !== undefined ? options.revOn : true;
  const revBars = options.revBars || 2;
  const minVolRatio = options.minVolRatio || 1.15; // Enhanced filter
  const useVolumeFilter = options.useVolumeFilter !== undefined ? options.useVolumeFilter : true;
  const minSlopeThreshold = options.minSlopeThreshold || 0.00005; // 0.005% per bar

  const n = candles.length;
  if (n < Math.max(lenBand, 35)) {
    return null;
  }

  const highs = new Float64Array(n);
  const lows = new Float64Array(n);
  const closes = new Float64Array(n);
  const volumes = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    highs[i] = candles[i].high;
    lows[i] = candles[i].low;
    closes[i] = candles[i].close;
    volumes[i] = candles[i].volume || 0;
  }

  const emaH = calcEMA(highs, lenBand);
  const emaL = calcEMA(lows, lenBand);
  const ema200 = calcEMA(closes, len200);
  const volSma = calcSMA(volumes, 20);
  const atr = calcATR(candles, 14);

  // Time series storage for chart display
  const emaHSeries = [];
  const emaLSeries = [];
  const ema200Series = [];
  const prevPeakSeries = [];
  const prevTroughSeries = [];
  const signals = [];

  let curPeak = null;
  let prevPeak = null;
  let curTrough = null;
  let prevTrough = null;
  let lastDir = 0; // 1 = LONG, -1 = SHORT

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const close = closes[i];
    const high = highs[i];
    const low = lows[i];
    const eH = emaH[i];
    const eL = emaL[i];
    const e200 = ema200[i];
    const curAtr = atr[i];
    const curVol = volumes[i];
    const avgVol = volSma[i];
    const volumeRatio = avgVol > 0 ? curVol / avgVol : 1.0;

    emaHSeries.push({ time: c.time, value: parseFloat(eH.toFixed(4)) });
    emaLSeries.push({ time: c.time, value: parseFloat(eL.toFixed(4)) });
    if (i >= len200 - 1) {
      ema200Series.push({ time: c.time, value: parseFloat(e200.toFixed(4)) });
    }

    const aboveBand = close > eH;
    const belowBand = close < eL;

    // Track excursion peaks outside upper band
    if (aboveBand) {
      curPeak = curPeak === null ? high : Math.max(curPeak, high);
    } else if (curPeak !== null) {
      prevPeak = curPeak;
      curPeak = null;
    }

    // Track excursion troughs outside lower band
    if (belowBand) {
      curTrough = curTrough === null ? low : Math.min(curTrough, low);
    } else if (curTrough !== null) {
      prevTrough = curTrough;
      curTrough = null;
    }

    if (prevPeak !== null) {
      prevPeakSeries.push({ time: c.time, value: parseFloat(prevPeak.toFixed(4)) });
    }
    if (prevTrough !== null) {
      prevTroughSeries.push({ time: c.time, value: parseFloat(prevTrough.toFixed(4)) });
    }

    // Breakout conditions
    const brkUp = prevPeak !== null && (useClose ? close > prevPeak : high > prevPeak);
    const brkDown = prevTrough !== null && (useClose ? close < prevTrough : low < prevTrough);

    // Trend filter (EMA200) + Trend Slope Guard
    let ema200Slope = 0;
    if (i >= 5 && ema200[i - 5] > 0) {
      ema200Slope = (e200 - ema200[i - 5]) / (ema200[i - 5] * 5);
    }
    const isEma200Flat = Math.abs(ema200Slope) < minSlopeThreshold;

    const trendUp = (!useTrend || close > e200) && (!useTrend || !isEma200Flat || close > eH * 1.002);
    const trendDown = (!useTrend || close < e200) && (!useTrend || !isEma200Flat || close < eL * 0.998);

    // Consecutive closes for reversal signal
    let belowCnt = 0;
    let aboveCnt = 0;
    for (let k = 0; k < revBars; k++) {
      const idx = i - k;
      if (idx >= 0) {
        if (closes[idx] < emaL[idx]) belowCnt++;
        if (closes[idx] > emaH[idx]) aboveCnt++;
      }
    }

    const revShort = revOn && useShort && lastDir === 1 && belowCnt === revBars && trendDown;
    const revLong = revOn && useShort && lastDir === -1 && aboveCnt === revBars && trendUp;

    // Enhanced Volume Confirmation
    const isVolConfirmed = !useVolumeFilter || volumeRatio >= minVolRatio;

    // Signal logic with strict alternating rule
    const longBreakout = aboveBand && prevPeak !== null && brkUp && trendUp && (lastDir <= 0 || !useShort);
    const shortBreakout = useShort && belowBand && prevTrough !== null && brkDown && trendDown && lastDir >= 0;

    let longSig = (longBreakout && isVolConfirmed) || revLong;
    let shortSig = (shortBreakout && isVolConfirmed) || revShort;

    if (longSig) {
      lastDir = 1;
      const sl = parseFloat(Math.min(eL, close - curAtr * 1.5).toFixed(4));
      const stopDist = Math.max(close * 0.008, close - sl);
      const tp = parseFloat((close + stopDist * 2.0).toFixed(4));
      signals.push({
        time: c.time,
        index: i,
        type: 'LONG',
        isReversal: revLong,
        price: close,
        stopLoss: sl,
        takeProfit: tp,
        volumeRatio: parseFloat(volumeRatio.toFixed(2)),
        isVolumeConfirmed: volumeRatio >= minVolRatio,
        prevPeak,
      });
    } else if (shortSig) {
      lastDir = -1;
      const sl = parseFloat(Math.max(eH, close + curAtr * 1.5).toFixed(4));
      const stopDist = Math.max(close * 0.008, sl - close);
      const tp = parseFloat((close - stopDist * 2.0).toFixed(4));
      signals.push({
        time: c.time,
        index: i,
        type: 'SHORT',
        isReversal: revShort,
        price: close,
        stopLoss: sl,
        takeProfit: tp,
        volumeRatio: parseFloat(volumeRatio.toFixed(2)),
        isVolumeConfirmed: volumeRatio >= minVolRatio,
        prevTrough,
      });
    }
  }

  const lastIdx = n - 1;
  const lastClose = closes[lastIdx];
  const lastEmaH = emaH[lastIdx];
  const lastEmaL = emaL[lastIdx];
  const lastEma200 = ema200[lastIdx];
  const bandWidthPct = lastClose > 0 ? (lastEmaH - lastEmaL) / lastClose : 0;

  let currentZone = 'INSIDE_BAND'; // 'ABOVE_BAND' | 'INSIDE_BAND' | 'BELOW_BAND'
  if (lastClose > lastEmaH) currentZone = 'ABOVE_BAND';
  else if (lastClose < lastEmaL) currentZone = 'BELOW_BAND';

  const lastSignal = signals.length > 0 ? signals[signals.length - 1] : null;

  return {
    emaHSeries,
    emaLSeries,
    ema200Series,
    prevPeakSeries,
    prevTroughSeries,
    signals,
    latestState: {
      currentZone,
      emaH: parseFloat(lastEmaH.toFixed(4)),
      emaL: parseFloat(lastEmaL.toFixed(4)),
      ema200: parseFloat(lastEma200.toFixed(4)),
      prevPeak,
      prevTrough,
      bandWidthPct: parseFloat((bandWidthPct * 100).toFixed(2)),
      lastDirection: lastDir === 1 ? 'LONG' : lastDir === -1 ? 'SHORT' : 'NEUTRAL',
      lastSignal,
    },
  };
}

module.exports = {
  evaluateEma30BandBreakout,
};
