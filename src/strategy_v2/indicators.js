/**
 * Technical indicators and math routines for Strategy V2.
 * Pure deterministic functions.
 */

function calculateEMA(values, period) {
  const n = values.length;
  const ema = new Float64Array(n);
  if (n === 0) return ema;

  const k = 2 / (period + 1);
  let sum = 0;
  const initCount = Math.min(period, n);
  for (let i = 0; i < initCount; i++) {
    sum += values[i];
  }
  ema[initCount - 1] = sum / initCount;

  for (let i = initCount; i < n; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calculateSMA(values, period) {
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

function calculateATR(candles, period = 14) {
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
  for (let i = 0; i < initCount; i++) {
    trSum += tr[i];
  }
  atr[initCount - 1] = trSum / initCount;

  for (let i = initCount; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function calculateRSI(closes, period = 14) {
  const n = closes.length;
  const rsi = new Float64Array(n);
  if (n < period + 1) return rsi;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

  for (let i = period + 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return rsi;
}

function getSlope(series, index, lookback = 3) {
  if (index < lookback) return 0;
  const curr = series[index];
  const prev = series[index - lookback];
  if (prev === 0) return 0;
  return (curr - prev) / (prev * lookback);
}

function getSwingLow(candles, endIndex, lookback = 12) {
  const start = Math.max(0, endIndex - lookback + 1);
  let minLow = Infinity;
  for (let i = start; i <= endIndex; i++) {
    if (candles[i].low < minLow) {
      minLow = candles[i].low;
    }
  }
  return minLow === Infinity ? candles[endIndex].low : minLow;
}

function getSwingHigh(candles, endIndex, lookback = 12) {
  const start = Math.max(0, endIndex - lookback + 1);
  let maxHigh = -Infinity;
  for (let i = start; i <= endIndex; i++) {
    if (candles[i].high > maxHigh) {
      maxHigh = candles[i].high;
    }
  }
  return maxHigh === -Infinity ? candles[endIndex].high : maxHigh;
}

function analyzeCandleStructure(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) {
    return { isBullish: false, bodyRatio: 0, lowerWickRatio: 0, isHammer: false };
  }
  const body = Math.abs(candle.close - candle.open);
  const isBullish = candle.close >= candle.open;
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const bodyRatio = body / range;
  const lowerWickRatio = lowerWick / range;
  const isHammer = lowerWick >= body * 1.5 && upperWick <= body * 0.8;

  return {
    isBullish,
    bodyRatio,
    lowerWickRatio,
    isHammer,
  };
}

module.exports = {
  calculateEMA,
  calculateSMA,
  calculateATR,
  calculateRSI,
  getSlope,
  getSwingLow,
  getSwingHigh,
  analyzeCandleStructure,
};
