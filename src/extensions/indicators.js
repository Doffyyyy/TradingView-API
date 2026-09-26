const axios = require('axios');
const TradingView = require('../../main');

/**
 * Technical Indicator Calculation Engine
 */

function calcEMA(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let ema = [values.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < values.length; i++) {
    ema.push(values[i] * k + ema[ema.length - 1] * (1 - k));
  }
  return ema;
}

function calcSMA(values, period) {
  if (values.length < period) return [];
  const sma = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) sma.push(sum / period);
  }
  return sma;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsi = [100 - (100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)))];
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push(100 - (100 / (1 + rs)));
  }
  return rsi;
}

function calcMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) return null;
  const fastEMA = calcEMA(closes, fastPeriod);
  const slowEMA = calcEMA(closes, slowPeriod);
  const offset = slowPeriod - fastPeriod;
  const macdLine = [];
  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset] - slowEMA[i]);
  }
  const signalLine = calcEMA(macdLine, signalPeriod);
  const hist = [];
  const sigOffset = macdLine.length - signalLine.length;
  for (let i = 0; i < signalLine.length; i++) {
    hist.push(macdLine[i + sigOffset] - signalLine[i]);
  }
  return {
    macd: macdLine[macdLine.length - 1],
    signal: signalLine[signalLine.length - 1],
    histogram: hist[hist.length - 1],
    series: { macdLine, signalLine, hist },
  };
}

function calcSupertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period) return [];
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) tr.push(candles[i].high - candles[i].low);
    else {
      const hl = candles[i].high - candles[i].low;
      const hc = Math.abs(candles[i].high - candles[i - 1].close);
      const lc = Math.abs(candles[i].low - candles[i - 1].close);
      tr.push(Math.max(hl, hc, lc));
    }
  }
  const atr = [];
  let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  atr.push(sum / period);
  for (let i = period; i < candles.length; i++) {
    atr.push((atr[atr.length - 1] * (period - 1) + tr[i]) / period);
  }
  const results = [];
  let upperBand = 0, lowerBand = 0, trend = 1;
  for (let i = period - 1; i < candles.length; i++) {
    const curAtr = atr[i - (period - 1)];
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let basicUpper = hl2 + multiplier * curAtr;
    let basicLower = hl2 - multiplier * curAtr;

    if (i === period - 1) {
      upperBand = basicUpper;
      lowerBand = basicLower;
      trend = candles[i].close > upperBand ? 1 : -1;
    } else {
      const prevUpper = upperBand;
      const prevLower = lowerBand;
      const prevClose = candles[i - 1].close;

      lowerBand = basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower;
      upperBand = basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper;

      if (trend === 1 && candles[i].close < lowerBand) trend = -1;
      else if (trend === -1 && candles[i].close > upperBand) trend = 1;
    }
    results.push({
      time: candles[i].time,
      supertrend: trend === 1 ? lowerBand : upperBand,
      direction: trend, // 1 = Bull, -1 = Bear
      trend: trend === 1 ? 'BUY' : 'SELL',
    });
  }
  return results;
}

function calcIchimoku(candles, conversionPeriod = 9, basePeriod = 26, spanBPeriod = 52) {
  if (candles.length < spanBPeriod) return null;
  const getHL2 = (subset) => {
    let high = -Infinity, low = Infinity;
    for (const c of subset) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
    }
    return (high + low) / 2;
  };

  const len = candles.length;
  const tenkan = getHL2(candles.slice(len - conversionPeriod));
  const kijun = getHL2(candles.slice(len - basePeriod));
  const senkouA = (tenkan + kijun) / 2;
  const senkouB = getHL2(candles.slice(len - spanBPeriod));
  const chikou = candles[len - 1].close;

  const currentClose = candles[len - 1].close;
  let signal = 'NEUTRAL';
  if (currentClose > senkouA && currentClose > senkouB && tenkan > kijun) signal = 'STRONG_BULLISH';
  else if (currentClose < senkouA && currentClose < senkouB && tenkan < kijun) signal = 'STRONG_BEARISH';
  else if (tenkan > kijun) signal = 'BULLISH';
  else if (tenkan < kijun) signal = 'BEARISH';

  return {
    tenkanSen: tenkan,
    kijunSen: kijun,
    senkouSpanA: senkouA,
    senkouSpanB: senkouB,
    chikouSpan: chikou,
    cloudColor: senkouA >= senkouB ? 'GREEN' : 'RED',
    signal,
  };
}

async function fetchCandles(symbol, timeframe = '60', limit = 150) {
  return new Promise((resolve, reject) => {
    const client = new TradingView.Client();
    const chart = new client.Session.Chart();
    let timer = setTimeout(() => {
      try { chart.delete(); client.end(); } catch (e) {}
      reject(new Error('Timeout fetching candles for indicator calculation'));
    }, 6000);

    chart.setMarket(symbol, { timeframe });
    chart.onError((...err) => {
      clearTimeout(timer);
      try { chart.delete(); client.end(); } catch (e) {}
      reject(new Error(err.join(' ')));
    });
    chart.onUpdate(() => {
      if (chart.periods && chart.periods.length >= Math.min(50, limit)) {
        clearTimeout(timer);
        const candles = chart.periods.slice().reverse().map(p => ({
          time: p.time,
          open: p.open,
          high: p.max,
          low: p.min,
          close: p.close,
          volume: p.volume || 0,
        }));
        try { chart.delete(); client.end(); } catch (e) {}
        resolve(candles);
      }
    });
  });
}

/**
 * Universal Indicator Calculation
 * @param {string} symbol
 * @param {string} timeframe
 * @param {string[]} requestedIndicators
 */
async function computeAllIndicators(symbol, timeframe = '60', requestedIndicators = ['RSI', 'MACD', 'Supertrend', 'Ichimoku']) {
  const candles = await fetchCandles(symbol, timeframe, 200);
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  const results = {
    symbol,
    timeframe,
    currentPrice,
    timestamp: candles[candles.length - 1].time,
    indicators: {},
  };

  const reqSet = new Set(requestedIndicators.map(i => i.toUpperCase()));

  if (reqSet.has('RSI')) {
    const rsiSeries = calcRSI(closes, 14);
    const lastRsi = rsiSeries[rsiSeries.length - 1];
    results.indicators.RSI = {
      value: Math.round(lastRsi * 100) / 100,
      period: 14,
      state: lastRsi < 30 ? 'OVERSOLD' : lastRsi > 70 ? 'OVERBOUGHT' : 'NEUTRAL',
    };
  }

  if (reqSet.has('MACD')) {
    const macdData = calcMACD(closes, 12, 26, 9);
    if (macdData) {
      results.indicators.MACD = {
        macd: Math.round(macdData.macd * 100) / 100,
        signal: Math.round(macdData.signal * 100) / 100,
        histogram: Math.round(macdData.histogram * 100) / 100,
        trend: macdData.histogram > 0 ? 'BULLISH' : 'BEARISH',
      };
    }
  }

  if (reqSet.has('SUPERTREND')) {
    const stSeries = calcSupertrend(candles, 10, 3);
    const lastST = stSeries[stSeries.length - 1];
    if (lastST) {
      results.indicators.Supertrend = {
        value: Math.round(lastST.supertrend * 100) / 100,
        direction: lastST.direction,
        trend: lastST.trend,
        distancePercent: Math.round(Math.abs((currentPrice - lastST.supertrend) / currentPrice) * 10000) / 100,
      };
    }
  }

  if (reqSet.has('ICHIMOKU')) {
    const ichi = calcIchimoku(candles, 9, 26, 52);
    if (ichi) {
      results.indicators.Ichimoku = ichi;
    }
  }

  if (reqSet.has('GALTON')) {
    const galton = calcGaltonVolumeProfile(candles, 50);
    if (galton) {
      results.indicators.Galton = galton;
    }
  }

  if (reqSet.has('FOOTPRINT')) {
    const footprint = calcVolumeFootprint(candles, 5, 3.0);
    if (footprint) {
      results.indicators.Footprint = footprint;
    }
  }

  if (reqSet.has('RLM') || reqSet.has('REACTION_LEVEL_MATRIX')) {
    const rlm = calcReactionLevelMatrix(candles);
    if (rlm) {
      results.indicators.ReactionLevelMatrix = rlm;
    }
  }

  return results;
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const prob = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - prob : prob;
}

/**
 * Galton Volume Profile (BVC Engine + Galton Binomial/Gaussian Distribution)
 */
function calcGaltonVolumeProfile(candles, period = 50) {
  if (!candles || candles.length < 5) return null;
  const slice = candles.slice(-Math.min(candles.length, period));
  const n = slice.length;

  let deltaPs = [];
  for (let i = 1; i < n; i++) {
    deltaPs.push(slice[i].close - slice[i - 1].close);
  }
  const meanDP = deltaPs.reduce((a, b) => a + b, 0) / Math.max(1, deltaPs.length);
  const varianceDP = deltaPs.reduce((a, b) => a + Math.pow(b - meanDP, 2), 0) / Math.max(1, deltaPs.length);
  const stdDP = Math.sqrt(varianceDP) || 0.0001;

  let minLow = Infinity, maxHigh = -Infinity;
  slice.forEach(c => {
    if (c.low < minLow) minLow = c.low;
    if (c.high > maxHigh) maxHigh = c.high;
  });
  if (maxHigh <= minLow) return null;

  const binCount = 30;
  const binStep = (maxHigh - minLow) / binCount;
  let buyBins = new Array(binCount).fill(0);
  let sellBins = new Array(binCount).fill(0);

  let totalBuyVol = 0, totalSellVol = 0;

  for (let i = 0; i < n; i++) {
    const c = slice[i];
    const prevC = i > 0 ? slice[i - 1].close : c.open;
    const vol = c.volume || 1;
    const dp = c.close - prevC;

    const z = dp / stdDP;
    const buyRatio = Math.max(0.01, Math.min(0.99, normalCDF(z)));
    const buyVol = vol * buyRatio;
    const sellVol = vol * (1 - buyRatio);
    totalBuyVol += buyVol;
    totalSellVol += sellVol;

    const candleSpread = Math.max(c.high - c.low, binStep) / 3.0;
    const twoSigSq = 2 * Math.pow(candleSpread, 2);

    let weights = [];
    let sumW = 0;
    for (let k = 0; k < binCount; k++) {
      const binCenter = minLow + (k + 0.5) * binStep;
      if (binCenter >= c.low - binStep && binCenter <= c.high + binStep) {
        const dist = binCenter - c.close;
        const w = Math.exp(- (dist * dist) / twoSigSq);
        weights.push({ k, w });
        sumW += w;
      }
    }

    if (sumW > 0) {
      weights.forEach(item => {
        const normW = item.w / sumW;
        buyBins[item.k] += buyVol * normW;
        sellBins[item.k] += sellVol * normW;
      });
    }
  }

  let maxBinVol = -1, pocIdx = 0;
  let totBins = new Array(binCount);
  let sumPeriodVol = 0;
  for (let k = 0; k < binCount; k++) {
    totBins[k] = buyBins[k] + sellBins[k];
    sumPeriodVol += totBins[k];
    if (totBins[k] > maxBinVol) {
      maxBinVol = totBins[k];
      pocIdx = k;
    }
  }
  const pocPrice = minLow + (pocIdx + 0.5) * binStep;

  // Value Area (70%)
  const targetVA = sumPeriodVol * 0.70;
  let vaVol = totBins[pocIdx];
  let upIdx = pocIdx, downIdx = pocIdx;
  while (vaVol < targetVA && (upIdx < binCount - 1 || downIdx > 0)) {
    const nextUp = upIdx < binCount - 1 ? totBins[upIdx + 1] : 0;
    const nextDown = downIdx > 0 ? totBins[downIdx - 1] : 0;
    if (nextUp >= nextDown && upIdx < binCount - 1) {
      upIdx++;
      vaVol += totBins[upIdx];
    } else if (downIdx > 0) {
      downIdx--;
      vaVol += totBins[downIdx];
    } else if (upIdx < binCount - 1) {
      upIdx++;
      vaVol += totBins[upIdx];
    } else {
      break;
    }
  }
  const valPrice = minLow + (downIdx + 0.5) * binStep;
  const vahPrice = minLow + (upIdx + 0.5) * binStep;
  const currentPrice = slice[slice.length - 1].close;

  const totalVol = Math.max(1, totalBuyVol + totalSellVol);
  const buyRatio = totalBuyVol / totalVol;
  const sellRatio = totalSellVol / totalVol;

  return {
    buyRatio: Math.round(buyRatio * 1000) / 1000,
    sellRatio: Math.round(sellRatio * 1000) / 1000,
    flowDelta: Math.round(totalBuyVol - totalSellVol),
    pocPrice: Math.round(pocPrice * 100) / 100,
    vahPrice: Math.round(vahPrice * 100) / 100,
    valPrice: Math.round(valPrice * 100) / 100,
    currentPrice,
    isAbovePoc: currentPrice >= pocPrice,
    isWithinValueArea: currentPrice >= valPrice && currentPrice <= vahPrice,
    priceVsPocPercent: Math.round(((currentPrice - pocPrice) / pocPrice) * 10000) / 100,
  };
}

/**
 * Volume Footprint (Gaussian Row Distribution & Diagonal Imbalance)
 */
function calcVolumeFootprint(candles, windowBars = 5, imbalanceRatio = 3.0) {
  if (!candles || candles.length < 3) return null;
  const slice = candles.slice(-Math.min(candles.length, windowBars));

  let minLow = Infinity, maxHigh = -Infinity;
  slice.forEach(c => {
    if (c.low < minLow) minLow = c.low;
    if (c.high > maxHigh) maxHigh = c.high;
  });
  if (maxHigh <= minLow) return null;

  const rowCount = 20;
  const rowStep = (maxHigh - minLow) / rowCount;
  let rowBuys = new Array(rowCount).fill(0);
  let rowSells = new Array(rowCount).fill(0);

  slice.forEach(c => {
    const vol = c.volume || 1;
    const r = c.high - c.low;
    const bR = r > 0 ? (c.close - c.low) / r : 0.5;
    const bV = vol * bR;
    const sV = vol * (1 - bR);
    const sigma = Math.max(r, rowStep) / 3.0;
    const twoSigSq = 2 * sigma * sigma;

    let weights = [];
    let sumW = 0;
    for (let rIdx = 0; rIdx < rowCount; rIdx++) {
      const price = minLow + (rIdx + 0.5) * rowStep;
      if (price >= c.low - rowStep && price <= c.high + rowStep) {
        const dist = price - c.close;
        const w = Math.exp(- (dist * dist) / twoSigSq);
        weights.push({ rIdx, w });
        sumW += w;
      }
    }
    if (sumW > 0) {
      weights.forEach(item => {
        const normW = item.w / sumW;
        rowBuys[item.rIdx] += bV * normW;
        rowSells[item.rIdx] += sV * normW;
      });
    }
  });

  let buyImbCount = 0, sellImbCount = 0;
  let hasBearishAbsorptionTop = false;
  let hasBullishAbsorptionBottom = false;

  for (let rIdx = 1; rIdx < rowCount; rIdx++) {
    if (rowBuys[rIdx] > (rowSells[rIdx - 1] * imbalanceRatio) && rowBuys[rIdx] > 10) {
      buyImbCount++;
      if (rIdx <= 4) hasBullishAbsorptionBottom = true;
    }
    if (rowSells[rIdx - 1] > (rowBuys[rIdx] * imbalanceRatio) && rowSells[rIdx - 1] > 10) {
      sellImbCount++;
      if (rIdx >= rowCount - 4) hasBearishAbsorptionTop = true;
    }
  }

  let overlapMin = 0, overlapMax = 0;
  for (let rIdx = 0; rIdx < rowCount; rIdx++) {
    overlapMin += Math.min(rowBuys[rIdx], rowSells[rIdx]);
    overlapMax += Math.max(rowBuys[rIdx], rowSells[rIdx]);
  }
  const ovlScore = overlapMax > 0 ? (overlapMin / overlapMax) : 1.0;

  return {
    buyImbCount,
    sellImbCount,
    hasBearishAbsorptionTop,
    hasBullishAbsorptionBottom,
    ovlScore: Math.round(ovlScore * 100) / 100,
    marketStructure: ovlScore < 0.48 ? 'DIRECTIONAL' : (ovlScore > 0.72 ? 'CHOPPY_ROTATION' : 'BALANCED'),
  };
}

/**
 * Reaction Level Matrix [WillyAlgoTrader]
 * Online level clustering + reaction measurement + aging + polarity bonus + trade engine
 */
function calcReactionLevelMatrix(candles, options = {}) {
  const swingLen = options.swingLength || 6;
  const tolRatio = options.levelTolerance || 0.6;
  const halfLife = options.halfLife || 500;
  const minScore = options.minScore || 50;
  const levelsPerSide = options.levelsPerSide || 3;

  const n = candles ? candles.length : 0;
  if (n < 35) return null;

  // 1. True Range and ATR
  const tr = [candles[0].high - candles[0].low];
  for (let i = 1; i < n; i++) {
    const c = candles[i], prev = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }

  function calcRMA(src, len) {
    const rma = [src.slice(0, len).reduce((a, b) => a + b, 0) / len];
    const alpha = 1 / len;
    for (let i = len; i < src.length; i++) {
      rma.push(alpha * src[i] + (1 - alpha) * rma[rma.length - 1]);
    }
    const pad = new Array(len - 1).fill(rma[0]);
    return pad.concat(rma);
  }

  const atr34 = calcRMA(tr, 34);
  const atr14 = calcRMA(tr, 14);

  // 2. Online Level Engine
  let storedLevels = [];

  for (let t = 0; t < n; t++) {
    const curAtr = atr34[t] || 1;
    const curClose = candles[t].close;
    const prevClose = t > 0 ? candles[t - 1].close : curClose;

    // Decay each level
    const decayFactor = Math.pow(0.5, 1 / halfLife);
    for (let l of storedLevels) {
      l.strength *= decayFactor;
      const top = l.center + l.halfWidth;
      const btm = l.center - l.halfWidth;

      // Role and cross penalty
      if (l.role === 'SUPPORT' && prevClose >= btm && curClose < btm) {
        l.role = 'RESISTANCE';
        l.breaks++;
        l.strength *= 0.7;
      } else if (l.role === 'RESISTANCE' && prevClose <= top && curClose > top) {
        l.role = 'SUPPORT';
        l.breaks++;
        l.strength *= 0.7;
      }
    }
    storedLevels = storedLevels.filter(l => l.strength >= 0.25);

    // Check confirmed swing at t - swingLen
    const swingIdx = t - swingLen;
    if (swingIdx >= swingLen) {
      const shCandle = candles[swingIdx];
      let isHigh = true, isLow = true;

      for (let k = 1; k <= swingLen; k++) {
        if (candles[swingIdx - k].high >= shCandle.high || candles[swingIdx + k].high > shCandle.high) isHigh = false;
        if (candles[swingIdx - k].low <= shCandle.low || candles[swingIdx + k].low < shCandle.low) isLow = false;
      }

      if (isHigh) {
        let lowestLow = Infinity;
        for (let k = 1; k <= swingLen; k++) lowestLow = Math.min(lowestLow, candles[swingIdx + k].low);
        const reaction = (shCandle.high - lowestLow) / (atr34[swingIdx] || 1);
        const w = 1 + Math.min(Math.max(0, reaction), 2.5);
        addSwing(shCandle.high, w, true, curAtr, t);
      }

      if (isLow) {
        let highestHigh = -Infinity;
        for (let k = 1; k <= swingLen; k++) highestHigh = Math.max(highestHigh, candles[swingIdx + k].high);
        const reaction = (highestHigh - shCandle.low) / (atr34[swingIdx] || 1);
        const w = 1 + Math.min(Math.max(0, reaction), 2.5);
        addSwing(shCandle.low, w, false, curAtr, t);
      }
    }
  }

  function addSwing(price, w, isHigh, curAtr, currentBar) {
    const tol = tolRatio * curAtr;
    let nearest = null, minDist = Infinity;
    for (let l of storedLevels) {
      const dist = Math.abs(l.center - price);
      if (dist <= tol && dist < minDist) {
        minDist = dist;
        nearest = l;
      }
    }

    if (nearest) {
      nearest.sumW += w;
      nearest.sumWP += w * price;
      nearest.sumWP2 += w * price * price;
      nearest.strength += w;
      if (isHigh) nearest.highTouches++; else nearest.lowTouches++;
      nearest.totalTouches++;
      nearest.lastTouchBar = currentBar;

      const m = nearest.sumWP / nearest.sumW;
      const vr = (nearest.sumWP2 / nearest.sumW) - (m * m);
      const hw = Math.min(tol, Math.max(0.15 * curAtr, Math.sqrt(Math.max(0, vr))));
      nearest.center = m;
      nearest.halfWidth = hw;

      // 5-pass merge for overlapping levels
      let again = true;
      let passes = 0;
      while (again && passes < 5) {
        again = false;
        passes++;
        const tHi = nearest.center + nearest.halfWidth;
        const tLo = nearest.center - nearest.halfWidth;
        for (let k = storedLevels.length - 1; k >= 0; k--) {
          const o = storedLevels[k];
          if (o !== nearest) {
            const oHi = o.center + o.halfWidth;
            const oLo = o.center - o.halfWidth;
            if (oLo <= tHi && tLo <= oHi) {
              nearest.sumW += o.sumW;
              nearest.sumWP += o.sumWP;
              nearest.sumWP2 += o.sumWP2;
              nearest.strength += o.strength;
              nearest.totalTouches += o.totalTouches;
              nearest.highTouches += o.highTouches;
              nearest.lowTouches += o.lowTouches;
              nearest.breaks = Math.max(nearest.breaks, o.breaks);
              const mMerged = nearest.sumWP / nearest.sumW;
              const vrMerged = (nearest.sumWP2 / nearest.sumW) - (mMerged * mMerged);
              nearest.center = mMerged;
              nearest.halfWidth = Math.min(tol, Math.max(0.15 * curAtr, Math.sqrt(Math.max(0, vrMerged))));
              storedLevels.splice(k, 1);
              again = true;
            }
          }
        }
      }
    } else {
      storedLevels.push({
        sumW: w,
        sumWP: w * price,
        sumWP2: w * price * price,
        center: price,
        halfWidth: Math.min(tol, Math.max(0.15 * curAtr, 0.25 * curAtr)),
        strength: w,
        highTouches: isHigh ? 1 : 0,
        lowTouches: isHigh ? 0 : 1,
        totalTouches: 1,
        breaks: 0,
        role: candles[currentBar].close >= price ? 'SUPPORT' : 'RESISTANCE',
        lastTouchBar: currentBar,
        lastSignalBar: -999,
      });
      if (storedLevels.length > 60) {
        storedLevels.sort((a, b) => b.strength - a.strength);
        storedLevels.pop();
      }
    }
  }

  // Calculate scores
  const lastClose = candles[n - 1].close;
  const currentAtr14 = atr14[n - 1] || 1;

  storedLevels.forEach(l => {
    const polarityBonus = (l.highTouches > 0 && l.lowTouches > 0) ? 1.25 : 1.0;
    l.polarity = (l.highTouches > 0 && l.lowTouches > 0);
    l.score = Math.round(Math.min(100, Math.max(0, 100 * (1 - Math.exp(-l.strength * polarityBonus / 6)))));
  });

  const activeLevels = storedLevels.filter(l => l.totalTouches >= 2);
  const resistances = activeLevels
    .filter(l => l.center > lastClose)
    .sort((a, b) => (a.center - lastClose) - (b.center - lastClose))
    .slice(0, levelsPerSide);

  const supports = activeLevels
    .filter(l => l.center < lastClose)
    .sort((a, b) => (lastClose - a.center) - (lastClose - b.center))
    .slice(0, levelsPerSide);

  const lastCandle = candles[n - 1];
  const barRange = lastCandle.high - lastCandle.low;
  let signal = null;

  // Check Long Rejection at nearest Support
  for (let sup of supports) {
    if (sup.score >= minScore) {
      const top = sup.center + sup.halfWidth;
      if (lastCandle.low <= top && lastCandle.close > top && barRange > 0 && ((lastCandle.close - lastCandle.low) / barRange >= 0.6)) {
        const sl = Math.min(lastCandle.low - 0.25 * currentAtr14, lastCandle.close - 0.5 * currentAtr14);
        const risk = Math.max(0.0001, lastCandle.close - sl);
        signal = {
          type: 'LONG',
          levelPrice: sup.center,
          levelScore: sup.score,
          polarity: sup.polarity,
          touches: sup.totalTouches,
          entry: lastCandle.close,
          sl,
          tp1: lastCandle.close + 1.0 * risk,
          tp2: lastCandle.close + 2.0 * risk,
          tp3: lastCandle.close + 3.0 * risk,
          risk,
        };
        break;
      }
    }
  }

  // Check Short Rejection at nearest Resistance
  if (!signal) {
    for (let res of resistances) {
      if (res.score >= minScore) {
        const btm = res.center - res.halfWidth;
        if (lastCandle.high >= btm && lastCandle.close < btm && barRange > 0 && ((lastCandle.high - lastCandle.close) / barRange >= 0.6)) {
          const sl = Math.max(lastCandle.high + 0.25 * currentAtr14, lastCandle.close + 0.5 * currentAtr14);
          const risk = Math.max(0.0001, sl - lastCandle.close);
          signal = {
            type: 'SHORT',
            levelPrice: res.center,
            levelScore: res.score,
            polarity: res.polarity,
            touches: res.totalTouches,
            entry: lastCandle.close,
            sl,
            tp1: lastCandle.close - 1.0 * risk,
            tp2: lastCandle.close - 2.0 * risk,
            tp3: lastCandle.close - 3.0 * risk,
            risk,
          };
          break;
        }
      }
    }
  }

  const sortedSup = [...supports].sort((a, b) => b.center - a.center);
  const sortedRes = [...resistances].sort((a, b) => a.center - b.center);
  const nearestSupport = sortedSup.length > 0 ? {
    center: sortedSup[0].center,
    halfWidth: sortedSup[0].halfWidth,
    score: sortedSup[0].score,
    distancePct: ((lastClose - sortedSup[0].center) / lastClose) * 100,
  } : null;
  const nearestResistance = sortedRes.length > 0 ? {
    center: sortedRes[0].center,
    halfWidth: sortedRes[0].halfWidth,
    score: sortedRes[0].score,
    distancePct: ((sortedRes[0].center - lastClose) / lastClose) * 100,
  } : null;

  const closesForEma = candles.map(c => c.close);
  const ema50Arr = calcEMA(closesForEma, 50);
  const htfEma50 = ema50Arr.length ? ema50Arr[ema50Arr.length - 1] : lastClose;
  const htfBias = lastClose >= htfEma50 ? 'BULLISH' : 'BEARISH';

  return {
    lastClose,
    atr14: currentAtr14,
    htfEma50,
    htfBias,
    nearestSupport,
    nearestResistance,
    supports: supports.map(s => ({ center: s.center, halfWidth: s.halfWidth, score: s.score, touches: s.totalTouches, polarity: s.polarity, breaks: s.breaks })),
    resistances: resistances.map(r => ({ center: r.center, halfWidth: r.halfWidth, score: r.score, touches: r.totalTouches, polarity: r.polarity, breaks: r.breaks })),
    signal,
    trend: supports.length > resistances.length ? 'BULLISH' : (resistances.length > supports.length ? 'BEARISH' : 'NEUTRAL'),
  };
}

/**
 * Custom Pine Script indicator runner using TradingView
 */
async function getPineIndicatorMetadata(queryOrId) {
  if (queryOrId.startsWith('STD;') || queryOrId.startsWith('PUB;') || queryOrId.startsWith('USER;')) {
    return await TradingView.getIndicator(queryOrId);
  }
  const searchResults = await TradingView.searchIndicator(queryOrId);
  return searchResults;
}

module.exports = {
  computeAllIndicators,
  fetchCandles,
  calcEMA,
  calcSMA,
  calcRSI,
  calcMACD,
  calcSupertrend,
  calcIchimoku,
  calcGaltonVolumeProfile,
  calcVolumeFootprint,
  calcReactionLevelMatrix,
  getPineIndicatorMetadata,
};
