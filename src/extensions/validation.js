const axios = require('axios');

/**
 * Validation Bot: 26-Indicator Consensus Layer
 * Query TradingView Technical Analysis engine across all 26 core indicators.
 * Serves as a second opinion veto before capital moves.
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

async function scanTickers(tickers, scannerType = 'crypto') {
  const url = `https://scanner.tradingview.com/${scannerType}/scan`;
  try {
    const res = await axios.post(
      url,
      {
        symbols: { tickers },
        columns: SCANNER_COLUMNS,
      },
      { timeout: 8000 }
    );
    return res.data;
  } catch (err) {
    if (scannerType === 'crypto') {
      return scanTickers(tickers, 'global');
    }
    throw err;
  }
}

function evaluateRecommendation(score) {
  if (score >= 0.5) return 'STRONG_BUY';
  if (score > 0.1) return 'BUY';
  if (score <= -0.5) return 'STRONG_SELL';
  if (score < -0.1) return 'SELL';
  return 'NEUTRAL';
}

function parseIndicatorRow(row, ticker) {
  const d = row.d;
  const colMap = {};
  SCANNER_COLUMNS.forEach((col, idx) => {
    colMap[col] = d[idx];
  });

  const close = colMap['close'];

  // 1. Oscillators evaluation (11 indicators)
  const oscList = [];
  let oscBuy = 0, oscNeutral = 0, oscSell = 0;

  function addOsc(name, val, action) {
    if (action === 'BUY') oscBuy++;
    else if (action === 'SELL') oscSell++;
    else oscNeutral++;
    oscList.push({ name, value: typeof val === 'number' ? Math.round(val * 100) / 100 : val, action });
  }

  // RSI
  const rsi = colMap['RSI'];
  addOsc('RSI (14)', rsi, rsi < 30 ? 'BUY' : rsi > 70 ? 'SELL' : 'NEUTRAL');

  // Stoch %K / %D
  const stochK = colMap['Stoch.K'];
  const stochD = colMap['Stoch.D'];
  addOsc('Stochastic %K', stochK, (stochK < 20 && stochK > stochD) ? 'BUY' : (stochK > 80 && stochK < stochD) ? 'SELL' : 'NEUTRAL');

  // CCI
  const cci = colMap['CCI20'];
  addOsc('CCI (20)', cci, cci < -100 ? 'BUY' : cci > 100 ? 'SELL' : 'NEUTRAL');

  // ADX
  const adx = colMap['ADX'];
  addOsc('ADX (14)', adx, 'NEUTRAL');

  // Awesome Oscillator
  const ao = colMap['AO'];
  addOsc('Awesome Oscillator', ao, ao > 0 ? 'BUY' : ao < 0 ? 'SELL' : 'NEUTRAL');

  // Momentum
  const mom = colMap['Mom'];
  addOsc('Momentum (10)', mom, mom > 0 ? 'BUY' : mom < 0 ? 'SELL' : 'NEUTRAL');

  // MACD
  const macdVal = colMap['MACD.macd'];
  const macdSig = colMap['MACD.signal'];
  addOsc('MACD (12, 26)', macdVal, macdVal > macdSig ? 'BUY' : 'SELL');

  // Stoch RSI
  const stochRsiRec = colMap['Rec.Stoch.RSI'];
  addOsc('Stochastic RSI', colMap['Stoch.RSI.K'], stochRsiRec === 1 ? 'BUY' : stochRsiRec === -1 ? 'SELL' : 'NEUTRAL');

  // Williams %R
  const wrRec = colMap['Rec.WR'];
  addOsc('Williams %R', colMap['W.R'], wrRec === 1 ? 'BUY' : wrRec === -1 ? 'SELL' : 'NEUTRAL');

  // Bull Bear Power
  const bbRec = colMap['Rec.BBPower'];
  addOsc('Bull Bear Power', colMap['BBPower'], bbRec === 1 ? 'BUY' : bbRec === -1 ? 'SELL' : 'NEUTRAL');

  // Ultimate Oscillator
  const uoRec = colMap['Rec.UO'];
  addOsc('Ultimate Oscillator', colMap['UO'], uoRec === 1 ? 'BUY' : uoRec === -1 ? 'SELL' : 'NEUTRAL');

  // 2. Moving Averages evaluation (15 indicators)
  const maList = [];
  let maBuy = 0, maNeutral = 0, maSell = 0;

  function addMA(name, val) {
    if (val === null || val === undefined) return;
    const action = close > val ? 'BUY' : close < val ? 'SELL' : 'NEUTRAL';
    if (action === 'BUY') maBuy++;
    else if (action === 'SELL') maSell++;
    else maNeutral++;
    maList.push({ name, value: Math.round(val * 100) / 100, action });
  }

  addMA('EMA10', colMap['EMA10']);
  addMA('SMA10', colMap['SMA10']);
  addMA('EMA20', colMap['EMA20']);
  addMA('SMA20', colMap['SMA20']);
  addMA('EMA30', colMap['EMA30']);
  addMA('SMA30', colMap['SMA30']);
  addMA('EMA50', colMap['EMA50']);
  addMA('SMA50', colMap['SMA50']);
  addMA('EMA100', colMap['EMA100']);
  addMA('SMA100', colMap['SMA100']);
  addMA('EMA200', colMap['EMA200']);
  addMA('SMA200', colMap['SMA200']);

  // Ichimoku Baseline
  const ichiVal = colMap['Ichimoku.BLine'];
  if (ichiVal) addMA('Ichimoku Base Line', ichiVal);

  // VWMA
  const vwmaVal = colMap['VWMA'];
  if (vwmaVal) addMA('VWMA', vwmaVal);

  // Hull MA 9
  const hullVal = colMap['HullMA9'];
  if (hullVal) addMA('Hull MA (9)', hullVal);

  const totalBuy = oscBuy + maBuy;
  const totalNeutral = oscNeutral + maNeutral;
  const totalSell = oscSell + maSell;
  const totalCount = totalBuy + totalNeutral + totalSell;

  const scoreAll = colMap['Recommend.All'] || 0;
  const verdict = evaluateRecommendation(scoreAll);

  // Capital movement authorization gate
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
    symbol: ticker,
    price: close,
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
      score: Math.round((colMap['Recommend.Other'] || 0) * 1000) / 1000,
      details: oscList,
    },
    movingAverages: {
      buy: maBuy,
      neutral: maNeutral,
      sell: maSell,
      score: Math.round((colMap['Recommend.MA'] || 0) * 1000) / 1000,
      details: maList,
    },
  };
}

/**
 * Validate a symbol for the Validation Bot
 * @param {string} symbol e.g. "BINANCE:BTCUSDT"
 */
async function validateSymbol(symbol) {
  const isCrypto = symbol.startsWith('BINANCE:') || symbol.startsWith('BYBIT:') || symbol.startsWith('COINBASE:');
  const res = await scanTickers([symbol], isCrypto ? 'crypto' : 'global');
  if (!res.data || !res.data[0]) {
    throw new Error(`Symbol ${symbol} not found in TradingView scanner`);
  }
  return parseIndicatorRow(res.data[0], symbol);
}

/**
 * Batch validate multiple symbols for the 300-agent layer
 * @param {string[]} symbols
 */
async function validateBatch(symbols) {
  const res = await scanTickers(symbols, 'crypto');
  const results = {};
  if (res.data) {
    res.data.forEach(row => {
      const parsed = parseIndicatorRow(row, row.s);
      results[row.s] = parsed;
    });
  }
  return results;
}

module.exports = {
  validateSymbol,
  validateBatch,
};
