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

  return results;
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
  getPineIndicatorMetadata,
};
