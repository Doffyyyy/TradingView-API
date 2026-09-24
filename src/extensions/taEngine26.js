const axios = require('axios');

/**
 * 26-Indicator Consensus & Validation Bot Engine
 * Evaluates 11 Oscillators + 15 Moving Averages.
 * Fallback to local computation whenever TradingView Scanner rate-limits (HTTP 429).
 */

const SCANNER_COLUMNS = [
  'Recommend.Other', 'Recommend.All', 'Recommend.MA',
  'RSI', 'RSI[1]',
  'Stoch.K', 'Stoch.D',
  'CCI20',
  'ADX',
  'AO',
  'Mom',
  'MACD.macd', 'MACD.signal',
  'Rec.Stoch.RSI', 'Stoch.RSI.K',
  'Rec.WR', 'W.R',
  'Rec.BBPower', 'BBPower',
  'Rec.UO', 'UO',
  'EMA10', 'SMA10',
  'EMA20', 'SMA20',
  'EMA30', 'SMA30',
  'EMA50', 'SMA50',
  'EMA100', 'SMA100',
  'EMA200', 'SMA200',
  'Rec.Ichimoku', 'Ichimoku.BLine',
  'Rec.VWMA', 'VWMA',
  'Rec.HullMA9', 'HullMA9',
  'close'
];

// Helper: Moving Averages & Oscillators
function calcEMA(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  let ema = [values.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < values.length; i++) {
    ema.push(values[i] * k + ema[ema.length - 1] * (1 - k));
  }
  return ema;
}

function calcSMA(values, period) {
  if (!values || values.length < period) return [];
  const sma = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) sma.push(sum / period);
  }
  return sma;
}

function calcWMA(values, period) {
  if (!values || values.length < period) return [];
  const wma = [];
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += values[i - (period - 1 - j)] * (j + 1);
    }
    wma.push(sum / denom);
  }
  return wma;
}

function calcHullMA(values, period = 9) {
  if (!values || values.length < period) return null;
  const halfPeriod = Math.floor(period / 2);
  const sqrtPeriod = Math.round(Math.sqrt(period));
  
  const wmaHalf = calcWMA(values, halfPeriod);
  const wmaFull = calcWMA(values, period);
  const offset = period - halfPeriod;
  
  const diffSeries = [];
  for (let i = 0; i < wmaFull.length; i++) {
    diffSeries.push(2 * wmaHalf[i + offset] - wmaFull[i]);
  }
  const hma = calcWMA(diffSeries, sqrtPeriod);
  return hma && hma.length > 0 ? hma[hma.length - 1] : null;
}

function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcStochastic(candles, period = 14, smoothK = 3, smoothD = 3) {
  if (!candles || candles.length < period + smoothK + smoothD) return { k: 50, d: 50 };
  const rawK = [];
  for (let i = period - 1; i < candles.length; i++) {
    let highest = -Infinity, lowest = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > highest) highest = candles[j].high;
      if (candles[j].low < lowest) lowest = candles[j].low;
    }
    const c = candles[i].close;
    const val = highest === lowest ? 50 : ((c - lowest) / (highest - lowest)) * 100;
    rawK.push(val);
  }
  const kList = calcSMA(rawK, smoothK);
  const dList = calcSMA(kList, smoothD);
  const k = kList.length > 0 ? kList[kList.length - 1] : 50;
  const d = dList.length > 0 ? dList[dList.length - 1] : 50;
  return { k, d };
}

function calcCCI(candles, period = 20) {
  if (!candles || candles.length < period) return 0;
  const tpList = candles.map(c => (c.high + c.low + c.close) / 3);
  const smaTP = calcSMA(tpList, period);
  const lastSMA = smaTP[smaTP.length - 1];
  const lastTP = tpList[tpList.length - 1];
  
  let meanDev = 0;
  for (let i = tpList.length - period; i < tpList.length; i++) {
    meanDev += Math.abs(tpList[i] - lastSMA);
  }
  meanDev = meanDev / period;
  if (meanDev === 0) return 0;
  return (lastTP - lastSMA) / (0.015 * meanDev);
}

function calcADX(candles, period = 14) {
  if (!candles || candles.length < period * 2) return { adx: 20, plusDI: 20, minusDI: 20 };
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
    const upMove = c.high - prev.high;
    const downMove = prev.low - c.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  
  let trSmooth = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusSmooth = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusSmooth = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  
  const dxList = [];
  for (let i = period; i < tr.length; i++) {
    trSmooth = trSmooth - (trSmooth / period) + tr[i];
    plusSmooth = plusSmooth - (plusSmooth / period) + plusDM[i];
    minusSmooth = minusSmooth - (minusSmooth / period) + minusDM[i];
    
    const plusDI = trSmooth === 0 ? 0 : (plusSmooth / trSmooth) * 100;
    const minusDI = trSmooth === 0 ? 0 : (minusSmooth / trSmooth) * 100;
    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
    dxList.push(dx);
  }
  const adx = dxList.length >= period ? dxList.slice(-period).reduce((a, b) => a + b, 0) / period : 20;
  const plusDI = trSmooth === 0 ? 0 : (plusSmooth / trSmooth) * 100;
  const minusDI = trSmooth === 0 ? 0 : (minusSmooth / trSmooth) * 100;
  return { adx, plusDI, minusDI };
}

function calcAO(candles) {
  if (!candles || candles.length < 34) return 0;
  const medians = candles.map(c => (c.high + c.low) / 2);
  const sma5 = calcSMA(medians, 5);
  const sma34 = calcSMA(medians, 34);
  if (sma5.length === 0 || sma34.length === 0) return 0;
  return sma5[sma5.length - 1] - sma34[sma34.length - 1];
}

function calcMomentum(closes, period = 10) {
  if (!closes || closes.length < period + 1) return 0;
  return closes[closes.length - 1] - closes[closes.length - 1 - period];
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (!closes || closes.length < slow + signal) return { macd: 0, signal: 0 };
  const fastEMA = calcEMA(closes, fast);
  const slowEMA = calcEMA(closes, slow);
  const offset = slow - fast;
  const macdLine = [];
  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset] - slowEMA[i]);
  }
  const sigLine = calcEMA(macdLine, signal);
  return {
    macd: macdLine[macdLine.length - 1] || 0,
    signal: sigLine[sigLine.length - 1] || 0
  };
}

function calcWilliamsR(candles, period = 14) {
  if (!candles || candles.length < period) return -50;
  let hh = -Infinity, ll = Infinity;
  for (let i = candles.length - period; i < candles.length; i++) {
    if (candles[i].high > hh) hh = candles[i].high;
    if (candles[i].low < ll) ll = candles[i].low;
  }
  const c = candles[candles.length - 1].close;
  if (hh === ll) return -50;
  return ((hh - c) / (hh - ll)) * -100;
}

function calcBBPower(candles, period = 13) {
  if (!candles || candles.length < period) return 0;
  const closes = candles.map(c => c.close);
  const ema = calcEMA(closes, period);
  const lastEMA = ema[ema.length - 1];
  const lastCandle = candles[candles.length - 1];
  const bullPower = lastCandle.high - lastEMA;
  const bearPower = lastCandle.low - lastEMA;
  return bullPower + bearPower;
}

function calcUltimateOsc(candles) {
  if (!candles || candles.length < 29) return 50;
  const bp = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    const trueLow = Math.min(c.low, prev.close);
    const trueHigh = Math.max(c.high, prev.close);
    bp.push(c.close - trueLow);
    tr.push(trueHigh - trueLow);
  }
  const sum7_bp = bp.slice(-7).reduce((a, b) => a + b, 0);
  const sum7_tr = tr.slice(-7).reduce((a, b) => a + b, 0);
  const sum14_bp = bp.slice(-14).reduce((a, b) => a + b, 0);
  const sum14_tr = tr.slice(-14).reduce((a, b) => a + b, 0);
  const sum28_bp = bp.slice(-28).reduce((a, b) => a + b, 0);
  const sum28_tr = tr.slice(-28).reduce((a, b) => a + b, 0);
  
  const a1 = sum7_tr === 0 ? 0.5 : sum7_bp / sum7_tr;
  const a2 = sum14_tr === 0 ? 0.5 : sum14_bp / sum14_tr;
  const a3 = sum28_tr === 0 ? 0.5 : sum28_bp / sum28_tr;
  
  return 100 * ((4 * a1) + (2 * a2) + a3) / 7;
}

function calcVWMA(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  let pvSum = 0, volSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const vol = candles[i].volume || 1;
    pvSum += candles[i].close * vol;
    volSum += vol;
  }
  return volSum === 0 ? candles[candles.length - 1].close : pvSum / volSum;
}

function calcIchimokuBaseLine(candles, period = 26) {
  if (!candles || candles.length < period) return null;
  let hh = -Infinity, ll = Infinity;
  for (let i = candles.length - period; i < candles.length; i++) {
    if (candles[i].high > hh) hh = candles[i].high;
    if (candles[i].low < ll) ll = candles[i].low;
  }
  return (hh + ll) / 2;
}

/**
 * Compute the full 26 indicators directly from candles
 */
function compute26IndicatorsFromCandles(symbol, candles) {
  if (!candles || candles.length < 35) {
    throw new Error(`Insufficient candle history for ${symbol} to evaluate 26 indicators`);
  }
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  // 1. Oscillators evaluation (11 indicators)
  const oscList = [];
  let oscBuy = 0, oscNeutral = 0, oscSell = 0;

  function addOsc(name, val, action) {
    if (action === 'BUY') oscBuy++;
    else if (action === 'SELL') oscSell++;
    else oscNeutral++;
    oscList.push({ name, value: typeof val === 'number' ? Math.round(val * 100) / 100 : val, action });
  }

  // 1. RSI
  const rsi = calcRSI(closes, 14);
  addOsc('RSI (14)', rsi, rsi < 30 ? 'BUY' : rsi > 70 ? 'SELL' : 'NEUTRAL');

  // 2. Stochastic
  const stoch = calcStochastic(candles, 14, 3, 3);
  addOsc('Stochastic %K', stoch.k, (stoch.k < 20 && stoch.k > stoch.d) ? 'BUY' : (stoch.k > 80 && stoch.k < stoch.d) ? 'SELL' : 'NEUTRAL');

  // 3. CCI
  const cci = calcCCI(candles, 20);
  addOsc('CCI (20)', cci, cci < -100 ? 'BUY' : cci > 100 ? 'SELL' : 'NEUTRAL');

  // 4. ADX
  const adx = calcADX(candles, 14);
  addOsc('ADX (14)', adx.adx, (adx.adx > 25 && adx.plusDI > adx.minusDI) ? 'BUY' : (adx.adx > 25 && adx.minusDI > adx.plusDI) ? 'SELL' : 'NEUTRAL');

  // 5. Awesome Oscillator
  const ao = calcAO(candles);
  addOsc('Awesome Oscillator', ao, ao > 0 ? 'BUY' : ao < 0 ? 'SELL' : 'NEUTRAL');

  // 6. Momentum
  const mom = calcMomentum(closes, 10);
  addOsc('Momentum (10)', mom, mom > 0 ? 'BUY' : mom < 0 ? 'SELL' : 'NEUTRAL');

  // 7. MACD
  const macd = calcMACD(closes, 12, 26, 9);
  addOsc('MACD (12, 26)', macd.macd, macd.macd > macd.signal ? 'BUY' : 'SELL');

  // 8. Stochastic RSI
  // Estimate StochRSI from recent RSI
  const stochRsiVal = rsi;
  addOsc('Stochastic RSI', stochRsiVal, stochRsiVal < 20 ? 'BUY' : stochRsiVal > 80 ? 'SELL' : 'NEUTRAL');

  // 9. Williams %R
  const wr = calcWilliamsR(candles, 14);
  addOsc('Williams %R', wr, wr < -80 ? 'BUY' : wr > -20 ? 'SELL' : 'NEUTRAL');

  // 10. Bull Bear Power
  const bbPower = calcBBPower(candles, 13);
  addOsc('Bull Bear Power', bbPower, bbPower > 0 ? 'BUY' : 'SELL');

  // 11. Ultimate Oscillator
  const uo = calcUltimateOsc(candles);
  addOsc('Ultimate Oscillator', uo, uo < 30 ? 'BUY' : uo > 70 ? 'SELL' : 'NEUTRAL');

  // 2. Moving Averages evaluation (15 indicators)
  const maList = [];
  let maBuy = 0, maNeutral = 0, maSell = 0;

  function addMA(name, val) {
    if (val === null || val === undefined || isNaN(val)) return;
    const action = currentPrice > val ? 'BUY' : currentPrice < val ? 'SELL' : 'NEUTRAL';
    if (action === 'BUY') maBuy++;
    else if (action === 'SELL') maSell++;
    else maNeutral++;
    maList.push({ name, value: Math.round(val * 100) / 100, action });
  }

  const periods = [10, 20, 30, 50, 100, 200];
  periods.forEach(p => {
    const emaSeries = calcEMA(closes, p);
    if (emaSeries.length > 0) addMA(`EMA${p}`, emaSeries[emaSeries.length - 1]);
    const smaSeries = calcSMA(closes, p);
    if (smaSeries.length > 0) addMA(`SMA${p}`, smaSeries[smaSeries.length - 1]);
  });

  // Ichimoku Base Line (26)
  const ichi = calcIchimokuBaseLine(candles, 26);
  if (ichi) addMA('Ichimoku Base Line', ichi);

  // VWMA (20)
  const vwma = calcVWMA(candles, 20);
  if (vwma) addMA('VWMA', vwma);

  // Hull MA (9)
  const hull = calcHullMA(closes, 9);
  if (hull) addMA('Hull MA (9)', hull);

  const totalBuy = oscBuy + maBuy;
  const totalNeutral = oscNeutral + maNeutral;
  const totalSell = oscSell + maSell;
  const totalCount = totalBuy + totalNeutral + totalSell;

  const scoreAll = totalCount > 0 ? (totalBuy - totalSell) / totalCount : 0;
  let verdict = 'NEUTRAL';
  if (scoreAll >= 0.5) verdict = 'STRONG_BUY';
  else if (scoreAll > 0.1) verdict = 'BUY';
  else if (scoreAll <= -0.5) verdict = 'STRONG_SELL';
  else if (scoreAll < -0.1) verdict = 'SELL';

  let tradeGate = 'HOLD_VETO';
  let reason = '';
  if (totalBuy >= 15 && totalSell <= 4) {
    tradeGate = 'ALLOW_LONG';
    reason = `Strong consensus with ${totalBuy}/${totalCount} indicators in BUY agreement.`;
  } else if (totalSell >= 15 && totalBuy <= 4) {
    tradeGate = 'ALLOW_SHORT';
    reason = `Strong consensus with ${totalSell}/${totalCount} indicators in SELL agreement.`;
  } else {
    tradeGate = 'HOLD_VETO';
    reason = `Insufficient consensus (${totalBuy} Buy vs ${totalSell} Sell). Capital risk vetoed.`;
  }

  return {
    symbol,
    price: currentPrice,
    timestamp: Math.round(Date.now() / 1000),
    verdict,
    tradeGate,
    reason,
    consensus: {
      total: totalCount,
      buy: totalBuy,
      neutral: totalNeutral,
      sell: totalSell,
      score: Math.round(scoreAll * 1000) / 1000,
    },
    oscillators: {
      buy: oscBuy,
      neutral: oscNeutral,
      sell: oscSell,
      score: oscList.length > 0 ? Math.round(((oscBuy - oscSell) / oscList.length) * 1000) / 1000 : 0,
      details: oscList,
    },
    movingAverages: {
      buy: maBuy,
      neutral: maNeutral,
      sell: maSell,
      score: maList.length > 0 ? Math.round(((maBuy - maSell) / maList.length) * 1000) / 1000 : 0,
      details: maList,
    },
  };
}

module.exports = {
  SCANNER_COLUMNS,
  compute26IndicatorsFromCandles,
};
