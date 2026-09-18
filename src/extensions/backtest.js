const { fetchCandles, calcSupertrend, calcEMA, calcRSI, calcMACD } = require('./indicators');

/**
 * Astra Backtest & Strategy Hypothesis Testing Engine
 */

function runStrategySimulation(candles, strategyConfig) {
  const {
    type = 'supertrend',
    initialCapital = 10000,
    feePercent = 0.05, // 0.05% taker fee
    slippagePercent = 0.02,
    params = {},
  } = strategyConfig;

  let capital = initialCapital;
  let maxCapital = initialCapital;
  let maxDrawdown = 0;
  const equityCurve = [capital];
  const trades = [];

  let inPosition = false;
  let positionType = null; // 'long' or 'short'
  let entryPrice = 0;
  let entryTime = 0;

  const closes = candles.map(c => c.close);

  let signals = []; // array of { time, signal: 'BUY' | 'SELL' | null }

  if (type.toLowerCase() === 'supertrend') {
    const period = params.period || 10;
    const mult = params.multiplier || 3;
    const stSeries = calcSupertrend(candles, period, mult);
    const offset = candles.length - stSeries.length;

    let prevDir = null;
    for (let i = 0; i < stSeries.length; i++) {
      const cur = stSeries[i];
      let sig = null;
      if (prevDir !== null && cur.direction !== prevDir) {
        sig = cur.direction === 1 ? 'BUY' : 'SELL';
      }
      prevDir = cur.direction;
      signals.push({ time: cur.time, signal: sig, candleIdx: i + offset });
    }
  } else if (type.toLowerCase() === 'emacross') {
    const fast = params.fast || 9;
    const slow = params.slow || 21;
    const fastEMA = calcEMA(closes, fast);
    const slowEMA = calcEMA(closes, slow);
    const offset = slow - fast;

    for (let i = 1; i < slowEMA.length; i++) {
      const prevFast = fastEMA[i - 1 + offset];
      const curFast = fastEMA[i + offset];
      const prevSlow = slowEMA[i - 1];
      const curSlow = slowEMA[i];

      let sig = null;
      if (prevFast <= prevSlow && curFast > curSlow) sig = 'BUY';
      else if (prevFast >= prevSlow && curFast < curSlow) sig = 'SELL';

      signals.push({ time: candles[i + slow - 1].time, signal: sig, candleIdx: i + slow - 1 });
    }
  } else if (type.toLowerCase() === 'rsi') {
    const period = params.period || 14;
    const oversold = params.oversold || 30;
    const overbought = params.overbought || 70;
    const rsi = calcRSI(closes, period);
    const offset = closes.length - rsi.length;

    for (let i = 1; i < rsi.length; i++) {
      let sig = null;
      if (rsi[i - 1] <= oversold && rsi[i] > oversold) sig = 'BUY';
      else if (rsi[i - 1] >= overbought && rsi[i] < overbought) sig = 'SELL';

      signals.push({ time: candles[i + offset].time, signal: sig, candleIdx: i + offset });
    }
  } else {
    // Default fallback: Supertrend
    const stSeries = calcSupertrend(candles, 10, 3);
    const offset = candles.length - stSeries.length;
    let prevDir = null;
    for (let i = 0; i < stSeries.length; i++) {
      const cur = stSeries[i];
      let sig = null;
      if (prevDir !== null && cur.direction !== prevDir) {
        sig = cur.direction === 1 ? 'BUY' : 'SELL';
      }
      prevDir = cur.direction;
      signals.push({ time: cur.time, signal: sig, candleIdx: i + offset });
    }
  }

  // Execute trades along the timeline
  for (const s of signals) {
    const candle = candles[s.candleIdx];
    if (!candle) continue;
    const price = candle.close;

    if (s.signal === 'BUY') {
      if (inPosition && positionType === 'short') {
        // Close short
        const exitPrice = price * (1 + slippagePercent / 100);
        const pnlPercent = (entryPrice - exitPrice) / entryPrice - (feePercent * 2 / 100);
        const pnlDollar = capital * pnlPercent;
        capital += pnlDollar;

        trades.push({
          type: 'SHORT',
          entryTime,
          exitTime: s.time,
          entryPrice,
          exitPrice,
          pnlPercent: Math.round(pnlPercent * 10000) / 100,
          pnlDollar: Math.round(pnlDollar * 100) / 100,
          capitalAfter: Math.round(capital * 100) / 100,
        });

        inPosition = false;
      }

      if (!inPosition) {
        // Open long
        inPosition = true;
        positionType = 'long';
        entryPrice = price * (1 + slippagePercent / 100);
        entryTime = s.time;
      }
    } else if (s.signal === 'SELL') {
      if (inPosition && positionType === 'long') {
        // Close long
        const exitPrice = price * (1 - slippagePercent / 100);
        const pnlPercent = (exitPrice - entryPrice) / entryPrice - (feePercent * 2 / 100);
        const pnlDollar = capital * pnlPercent;
        capital += pnlDollar;

        trades.push({
          type: 'LONG',
          entryTime,
          exitTime: s.time,
          entryPrice,
          exitPrice,
          pnlPercent: Math.round(pnlPercent * 10000) / 100,
          pnlDollar: Math.round(pnlDollar * 100) / 100,
          capitalAfter: Math.round(capital * 100) / 100,
        });

        inPosition = false;
      }

      if (!inPosition) {
        // Open short
        inPosition = true;
        positionType = 'short';
        entryPrice = price * (1 - slippagePercent / 100);
        entryTime = s.time;
      }
    }

    if (capital > maxCapital) maxCapital = capital;
    const currentDrawdown = (maxCapital - capital) / maxCapital;
    if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
    equityCurve.push(capital);
  }

  // Calculate Metrics
  const totalTrades = trades.length;
  const winningTrades = trades.filter(t => t.pnlPercent > 0);
  const losingTrades = trades.filter(t => t.pnlPercent < 0);

  const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
  const grossProfit = winningTrades.reduce((acc, t) => acc + t.pnlDollar, 0);
  const grossLoss = Math.abs(losingTrades.reduce((acc, t) => acc + t.pnlDollar, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  const avgWin = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
  const avgLoss = losingTrades.length > 0 ? grossLoss / losingTrades.length : 1;
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 1;

  // Kelly Criterion: K = W - (1 - W) / R
  const wFrac = winRate / 100;
  const kelly = winLossRatio > 0 ? wFrac - ((1 - wFrac) / winLossRatio) : 0;
  const safeKelly = Math.max(0, Math.min(0.35, kelly / 2)); // Half-Kelly capped at 35%

  // Sharpe calculation on trade returns
  const returns = trades.map(t => t.pnlPercent / 100);
  let sharpe = 0;
  if (returns.length > 1) {
    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      sharpe = (meanReturn / stdDev) * Math.sqrt(365); // Annualized approximation
    }
  }

  const netProfitPercent = ((capital - initialCapital) / initialCapital) * 100;

  return {
    strategy: type,
    initialCapital,
    finalCapital: Math.round(capital * 100) / 100,
    netProfitPercent: Math.round(netProfitPercent * 100) / 100,
    metrics: {
      totalTrades,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: Math.round(winRate * 10) / 10,
      profitFactor: Math.round(profitFactor * 100) / 100,
      maxDrawdownPercent: Math.round(maxDrawdown * 10000) / 100,
      sharpeRatio: Math.round(sharpe * 100) / 100,
      winLossRatio: Math.round(winLossRatio * 100) / 100,
      recommendedKellyFraction: Math.round(safeKelly * 100) / 100, // Half-Kelly %
    },
    trades: trades.slice(-10), // last 10 trades
  };
}

async function runBacktest(symbol, timeframe = '60', strategyConfig = {}) {
  const candles = await fetchCandles(symbol, timeframe, 300);
  return runStrategySimulation(candles, strategyConfig);
}

module.exports = {
  runBacktest,
  runStrategySimulation,
};
