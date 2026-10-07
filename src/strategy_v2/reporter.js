/**
 * Performance Metrics & Attribution Reporter for Strategy V2.
 * Implements Section 27, 28, 29, 31, 37, 38, 39.
 */

class Reporter {
  /**
   * Computes comprehensive performance report from list of executed trades.
   * @param {Array} trades 
   * @param {Array} equityHistory 
   * @param {number} initialEquity 
   * @param {object} config 
   * @returns {object}
   */
  static generateReport(trades, equityHistory, initialEquity, config) {
    const totalTrades = trades.length;
    if (totalTrades === 0) {
      return {
        strategyVersion: config.version,
        initialEquity,
        finalEquity: initialEquity,
        netPnl: 0,
        returnPct: 0,
        totalTrades: 0,
      };
    }

    let grossProfit = 0;
    let grossLoss = 0;
    let winCount = 0;
    let lossCount = 0;
    let winPnlSum = 0;
    let lossPnlSum = 0;
    let rSum = 0;
    const rValues = [];
    const pnlValues = [];
    let totalFees = 0;
    let totalSlippage = 0;

    let curWinStreak = 0;
    let maxWinStreak = 0;
    let curLossStreak = 0;
    let maxLossStreak = 0;

    let mfeSum = 0;
    let maeSum = 0;
    let mfeRSum = 0;
    let maeRSum = 0;

    // Breakdown maps
    const symbolMap = {};
    const monthMap = {};
    const scoreMap = {};
    const exitReasonMap = {};
    const btcRegimeMap = {};
    const assetRegimeMap = {};
    const daysMap = {};

    for (const t of trades) {
      const pnl = t.pnlDollar;
      const r = t.pnlR;
      pnlValues.push(pnl);
      rValues.push(r);
      rSum += r;
      totalFees += t.fees;
      totalSlippage += t.slippage;

      mfeSum += t.mfe || 0;
      maeSum += t.mae || 0;
      mfeRSum += t.mfeR || 0;
      maeRSum += t.maeR || 0;

      if (pnl > 0) {
        grossProfit += pnl;
        winCount++;
        winPnlSum += pnl;
        curWinStreak++;
        curLossStreak = 0;
        if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
      } else {
        grossLoss += Math.abs(pnl);
        lossCount++;
        lossPnlSum += Math.abs(pnl);
        curLossStreak++;
        curWinStreak = 0;
        if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
      }

      // Breakdown by Symbol
      if (!symbolMap[t.symbol]) symbolMap[t.symbol] = { trades: 0, wins: 0, pnl: 0, rSum: 0 };
      symbolMap[t.symbol].trades++;
      if (pnl > 0) symbolMap[t.symbol].wins++;
      symbolMap[t.symbol].pnl += pnl;
      symbolMap[t.symbol].rSum += r;

      // Breakdown by Month
      const monthKey = t.entryTime ? t.entryTime.slice(0, 7) : 'UNKNOWN';
      if (!monthMap[monthKey]) monthMap[monthKey] = { trades: 0, wins: 0, pnl: 0, grossProfit: 0, grossLoss: 0 };
      monthMap[monthKey].trades++;
      if (pnl > 0) {
        monthMap[monthKey].wins++;
        monthMap[monthKey].grossProfit += pnl;
      } else {
        monthMap[monthKey].grossLoss += Math.abs(pnl);
      }
      monthMap[monthKey].pnl += pnl;

      // Breakdown by Score
      const sc = t.entryScore || 0;
      if (!scoreMap[sc]) scoreMap[sc] = { trades: 0, wins: 0, pnl: 0, rSum: 0 };
      scoreMap[sc].trades++;
      if (pnl > 0) scoreMap[sc].wins++;
      scoreMap[sc].pnl += pnl;
      scoreMap[sc].rSum += r;

      // Breakdown by Exit Reason
      const re = t.exitReason || 'UNKNOWN';
      if (!exitReasonMap[re]) exitReasonMap[re] = { trades: 0, pnl: 0 };
      exitReasonMap[re].trades++;
      exitReasonMap[re].pnl += pnl;

      // Breakdown by BTC Regime
      const btcR = t.btcRegime || 'UNKNOWN';
      if (!btcRegimeMap[btcR]) btcRegimeMap[btcR] = { trades: 0, wins: 0, pnl: 0 };
      btcRegimeMap[btcR].trades++;
      if (pnl > 0) btcRegimeMap[btcR].wins++;
      btcRegimeMap[btcR].pnl += pnl;

      // Breakdown by Asset Regime
      const astR = t.assetRegime || 'UNKNOWN';
      if (!assetRegimeMap[astR]) assetRegimeMap[astR] = { trades: 0, wins: 0, pnl: 0 };
      assetRegimeMap[astR].trades++;
      if (pnl > 0) assetRegimeMap[astR].wins++;
      assetRegimeMap[astR].pnl += pnl;

      // Daily aggregation
      const dayKey = t.entryTime ? t.entryTime.slice(0, 10) : 'UNKNOWN';
      if (!daysMap[dayKey]) daysMap[dayKey] = { pnl: 0, trades: 0 };
      daysMap[dayKey].pnl += pnl;
      daysMap[dayKey].trades++;
    }

    const netPnl = grossProfit - grossLoss;
    const finalEquity = initialEquity + netPnl;
    const returnPct = (netPnl / initialEquity) * 100;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
    const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;
    const avgWinner = winCount > 0 ? winPnlSum / winCount : 0;
    const avgLoser = lossCount > 0 ? lossPnlSum / lossCount : 0;
    const payoff = avgLoser > 0 ? avgWinner / avgLoser : 0;
    const avgTrade = totalTrades > 0 ? netPnl / totalTrades : 0;
    const avgR = totalTrades > 0 ? rSum / totalTrades : 0;
    const expectancy = (winRate / 100) * avgWinner - (1 - winRate / 100) * avgLoser;

    // Median trade & median R
    pnlValues.sort((a, b) => a - b);
    rValues.sort((a, b) => a - b);
    const medianTrade = pnlValues[Math.floor(pnlValues.length / 2)] || 0;
    const medianR = rValues[Math.floor(rValues.length / 2)] || 0;

    // Max Drawdown calculation from equity history
    let peakEquity = initialEquity;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;

    for (const pt of equityHistory) {
      if (pt.equity > peakEquity) {
        peakEquity = pt.equity;
      }
      const dd = peakEquity - pt.equity;
      const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }

    // Sharpe and Sortino (daily returns based)
    const dailyPnlList = Object.keys(daysMap).sort().map(d => daysMap[d].pnl / initialEquity);
    let meanDaily = 0;
    let stdDaily = 0;
    let downsideStd = 0;
    if (dailyPnlList.length > 1) {
      meanDaily = dailyPnlList.reduce((acc, v) => acc + v, 0) / dailyPnlList.length;
      const varDaily = dailyPnlList.reduce((acc, v) => acc + Math.pow(v - meanDaily, 2), 0) / (dailyPnlList.length - 1);
      stdDaily = Math.sqrt(varDaily);

      const negList = dailyPnlList.filter(v => v < 0);
      if (negList.length > 0) {
        const downVar = negList.reduce((acc, v) => acc + Math.pow(v, 2), 0) / negList.length;
        downsideStd = Math.sqrt(downVar);
      }
    }
    const sharpe = stdDaily > 0 ? (meanDaily / stdDaily) * Math.sqrt(365) : 0;
    const sortino = downsideStd > 0 ? (meanDaily / downsideStd) * Math.sqrt(365) : 0;

    // Train / Validation / OOS Split (Section 31)
    // Train: 2026-03 to 2026-06 (Months 1-4)
    // Val: 2026-07 (Month 5)
    // OOS: 2026-08 to 2026-10 (Months 6-7)
    const trainTrades = trades.filter(t => t.entryTime && t.entryTime < '2026-07-01');
    const valTrades = trades.filter(t => t.entryTime && t.entryTime >= '2026-07-01' && t.entryTime < '2026-08-01');
    const oosTrades = trades.filter(t => t.entryTime && t.entryTime >= '2026-08-01');

    function calcSubset(subTrades) {
      const cnt = subTrades.length;
      if (cnt === 0) return { count: 0, pnl: 0, winRate: 0, pf: 0 };
      let gp = 0, gl = 0, w = 0;
      for (const t of subTrades) {
        if (t.pnlDollar > 0) { gp += t.pnlDollar; w++; }
        else { gl += Math.abs(t.pnlDollar); }
      }
      return {
        count: cnt,
        pnl: gp - gl,
        winRate: (w / cnt) * 100,
        pf: gl > 0 ? gp / gl : gp > 0 ? 999 : 0,
      };
    }

    const trainMetrics = calcSubset(trainTrades);
    const valMetrics = calcSubset(valTrades);
    const oosMetrics = calcSubset(oosTrades);

    // Final formatted summary
    return {
      strategyVersion: config.version,
      dataset: config.dataset,
      exitMode: config.exit.mode,
      initialEquity,
      finalEquity,
      netPnl,
      returnPct,
      profitFactor,
      winRate,
      payoff,
      expectancy,
      totalTrades,
      winCount,
      lossCount,
      avgWinner,
      avgLoser,
      avgTrade,
      medianTrade,
      avgR,
      medianR,
      maxDrawdown,
      maxDrawdownPct,
      sharpe,
      sortino,
      maxWinStreak,
      maxLossStreak,
      avgMfeR: totalTrades > 0 ? mfeRSum / totalTrades : 0,
      avgMaeR: totalTrades > 0 ? maeRSum / totalTrades : 0,
      totalFees,
      totalSlippage,
      splits: {
        train: trainMetrics,
        val: valMetrics,
        oos: oosMetrics,
      },
      breakdowns: {
        bySymbol: symbolMap,
        byMonth: monthMap,
        byScore: scoreMap,
        byExitReason: exitReasonMap,
        byBtcRegime: btcRegimeMap,
        byAssetRegime: assetRegimeMap,
      },
      dailyPnL: daysMap,
      tradesCount: totalTrades,
    };
  }
}

module.exports = {
  Reporter,
};
