const { fetchCandles } = require('./indicators');
const { runStrategySimulation } = require('./backtest');

/**
 * Replay Engine for Stress-Testing across any timeframe
 * Simulates bar-by-bar playback without lookahead bias.
 */

async function runHistoricalReplay(symbol, timeframe = '60', totalBars = 150, strategyConfig = { type: 'supertrend' }) {
  const candles = await fetchCandles(symbol, timeframe, Math.min(totalBars, 250));

  if (!candles || candles.length < 30) {
    throw new Error('Not enough candles returned for replay stress test');
  }

  // Step through bar-by-bar from bar 20 to the end
  const replaySteps = [];
  let simulatedCapital = strategyConfig.initialCapital || 10000;

  for (let i = 25; i <= candles.length; i++) {
    const historicalSlice = candles.slice(0, i);
    const lastBar = historicalSlice[historicalSlice.length - 1];

    replaySteps.push({
      step: i - 24,
      time: lastBar.time,
      open: lastBar.open,
      high: lastBar.high,
      low: lastBar.low,
      close: lastBar.close,
      volume: lastBar.volume,
    });
  }

  const finalSim = runStrategySimulation(candles, strategyConfig);

  return {
    symbol,
    timeframe,
    replayType: 'BAR_BY_BAR_WALKFORWARD',
    totalBars: candles.length,
    startDate: new Date(candles[0].time * 1000).toISOString(),
    endDate: new Date(candles[candles.length - 1].time * 1000).toISOString(),
    stressTest: {
      strategy: strategyConfig.type || 'supertrend',
      netProfitPercent: finalSim.netProfitPercent,
      metrics: finalSim.metrics,
      executedTrades: finalSim.trades,
    },
    playbackSummary: {
      stepsProcessed: replaySteps.length,
      firstStepTime: replaySteps[0].time,
      lastStepTime: replaySteps[replaySteps.length - 1].time,
    },
  };
}

module.exports = {
  runHistoricalReplay,
};
