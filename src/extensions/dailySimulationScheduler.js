/**
 * Daily Simulation Scheduler & Catch-Up Engine
 *
 * Responsibilities:
 * 1. Automatically runs on server/bot startup (when PC turns on).
 * 2. Fetches latest candles for all 5 core symbols (BTC, ETH, SOL, BNB, NEAR).
 * 3. Merges cache and runs Oliver Kell Strategy V2 simulation on recent days.
 * 4. Backfills data/simulated_6month_pnl.json so the Daily PnL Journal is always up to date.
 * 5. Runs on a daily schedule (every 24h at 00:05 UTC+7 / Vietnam Time).
 */

const fs = require('fs');
const path = require('path');
const { fetchCandles } = require('./indicators');
const { OliverKellEngine } = require('../strategy_v2/oliverKellEngine');

const CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'candles_cache_6m.json');
const JOURNAL_PATH = path.join(__dirname, '..', '..', 'data', 'simulated_6month_pnl.json');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'NEARUSDT'];

let dailyTimer = null;

async function syncDailySimulation() {
  console.log('[DailySimScheduler] 🔄 Starting daily catch-up simulation for latest days...');
  try {
    if (!fs.existsSync(CACHE_PATH)) {
      console.warn('[DailySimScheduler] Cache file missing at', CACHE_PATH);
      return false;
    }

    const cachedData = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    const mergedData = {};

    // 1. Fetch live recent candles for each symbol
    for (const sym of SYMBOLS) {
      const cached = cachedData[`${sym}_1h`] || [];
      let live = [];
      try {
        live = await fetchCandles(`BINANCE:${sym}`, '60', 300);
      } catch (err) {
        console.warn(`[DailySimScheduler] Warning fetching ${sym}:`, err.message);
      }

      const liveMs = (live || []).map(c => ({
        time: c.time > 1e11 ? c.time : c.time * 1000,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));

      const timeMap = new Map();
      cached.forEach(c => timeMap.set(c.time, c));
      liveMs.forEach(c => timeMap.set(c.time, c));

      mergedData[`${sym}_1h`] = Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
    }

    // 2. Run Enhanced Oliver Kell Strategy V2 Engine from 2026-01-01 through latest date
    const engine = new OliverKellEngine({
      maxCrossbacks: 3,
      minRRPivot: 2.5,
      breakevenR: 1.6,
      runnerLockR: 1.2,
      atrBuffer: 0.6,
      initialBalance: 10000,
      riskPerTradePct: 0.005,
      maxMargin: 2500,
      maxLeverage: 2.0,
      maxUnprotectedPositions: 1,
      pureLossGuard: true,
      enableShort: true,
      earlyInvalidation: false,
      minDate: '2026-01-01T00:00:00Z',
      maxDate: '2026-11-20T23:59:59Z',
    });

    const res = engine.run(mergedData, SYMBOLS);
    console.log(`[DailySimScheduler] ✅ Simulation complete: ${res.totalTrades} trades, Net PnL: ${res.netPnl >= 0 ? '+' : ''}$${res.netPnl.toFixed(2)}, WR: ${res.winRate.toFixed(1)}%, PF: ${res.profitFactor.toFixed(2)}, R:R: ${res.payoff.toFixed(2)}`);

    // 3. Build Daily PnL Journal daysMap from 2026-01-01 to end of current month
    const trades = res.trades;
    trades.sort((a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime());

    let currentBalance = 10000.0;
    const daysMap = {};

    const startDate = new Date('2026-01-01T00:00:00Z');
    const today = new Date();
    const curYear = today.getFullYear() >= 2026 ? today.getFullYear() : 2026;
    const curMonth = today.getFullYear() >= 2026 ? Math.max(10, today.getMonth()) : 10;
    const endOfMonth = new Date(Date.UTC(curYear, curMonth + 1, 0, 23, 59, 59));
    const todayEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59));
    const endCap = endOfMonth.getTime() < todayEnd.getTime() ? endOfMonth : todayEnd;
    const curD = new Date(startDate);

    while (curD <= endCap) {
      const dStr = curD.toISOString().slice(0, 10);
      daysMap[dStr] = { pnl: 0, trades: [] };
      curD.setUTCDate(curD.getUTCDate() + 1);
    }

    for (const t of trades) {
      const dStr = t.exitTime ? t.exitTime.slice(0, 10) : t.entryTime.slice(0, 10);
      if (dStr < '2026-01-01' || dStr >= '2026-11-21') continue;
      const mStr = dStr.slice(0, 7);
      const pnlRound = Math.round(t.pnl * 100) / 100;
      currentBalance = Math.round((currentBalance + pnlRound) * 100) / 100;

      if (!daysMap[dStr]) {
        daysMap[dStr] = { pnl: 0, trades: [] };
      }

      daysMap[dStr].pnl = Math.round((daysMap[dStr].pnl + pnlRound) * 100) / 100;

      let stratLabel = 'Oliver Kell: EMA Crossback Setup';
      if (t.reason === 'EXHAUSTION_CLIMAX' || t.reason === 'RUNNER_EMA20_EXIT' || t.reason === 'RUNNER_LOCK_EXIT') {
        stratLabel = 'Oliver Kell: Climax / Runner Trail';
      } else if (t.stage1Taken) {
        stratLabel = 'Oliver Kell: Stage 1 TP (+2.5R) + Runner';
      } else if (t.reason === 'BREAKEVEN_EXIT') {
        stratLabel = 'Oliver Kell: Breakeven Protected (+1.6R)';
      }

      const rawPct = t.side === 'SHORT'
        ? ((t.entryPrice - t.exitPrice) / t.entryPrice) * 100
        : ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100;
      const pnlPct = Math.round(rawPct * 100) / 100;

      daysMap[dStr].trades.push({
        id: t.id,
        symbol: t.symbol,
        side: t.side || 'LONG',
        strategy: stratLabel,
        entry: t.entryPrice,
        entryPrice: t.entryPrice,
        exit: t.exitPrice,
        exitPrice: t.exitPrice,
        pnl: pnlRound,
        pnlDollar: pnlRound,
        pnlPercent: pnlPct,
        isWin: pnlRound > 0,
        reason: t.reason,
        time: t.exitTime ? t.exitTime.slice(11, 16) : '12:00',
        date: dStr,
        month: mStr,
        balanceAfter: currentBalance,
      });
    }

    // Merge live paper trades from 2026-11-21 onwards (official V2.1 activation date)
    const PORTFOLIO_PATH = path.join(__dirname, '..', '..', 'data', 'paper_portfolio.json');
    if (fs.existsSync(PORTFOLIO_PATH)) {
      try {
        const portData = JSON.parse(fs.readFileSync(PORTFOLIO_PATH, 'utf8'));
        const liveTrades = (portData.trades || []).filter(t => {
          const exitTime = t.exitTime || t.entryTime;
          return exitTime && exitTime.slice(0, 10) >= '2026-11-21';
        });
        liveTrades.sort((a, b) => (a.exitTime || a.entryTime).localeCompare(b.exitTime || b.entryTime));

        for (const t of liveTrades) {
          const exitTime = t.exitTime || t.entryTime;
          const dStr = exitTime.slice(0, 10);
          const mStr = dStr.slice(0, 7);
          const pnlRound = Math.round(t.pnl * 100) / 100;
          currentBalance = Math.round((currentBalance + pnlRound) * 100) / 100;

          if (!daysMap[dStr]) daysMap[dStr] = { pnl: 0, trades: [] };
          daysMap[dStr].pnl = Math.round((daysMap[dStr].pnl + pnlRound) * 100) / 100;
          daysMap[dStr].trades.push({
            id: t.id,
            symbol: t.symbol,
            side: t.side,
            strategy: t.strategy || 'Oliver Kell Enhanced R:R (V2.1)',
            entry: t.entryPrice,
            entryPrice: t.entryPrice,
            exit: t.exitPrice,
            exitPrice: t.exitPrice,
            pnl: pnlRound,
            pnlDollar: pnlRound,
            pnlPercent: t.pnlPercent,
            isWin: pnlRound > 0,
            reason: t.reason,
            time: exitTime.slice(11, 16),
            date: dStr,
            month: mStr,
            balanceAfter: currentBalance,
          });
        }
      } catch (err) {
        console.warn('[DailySimScheduler] Error loading live trades from 2026-11-21:', err.message);
      }
    }

    let totalTradesCount = 0;
    let winCount = 0;
    let lossCount = 0;
    let netProfit = 0;
    for (const dObj of Object.values(daysMap)) {
      netProfit += dObj.pnl;
      for (const tr of dObj.trades) {
        totalTradesCount++;
        if (tr.pnl > 0) winCount++;
        else if (tr.pnl < 0) lossCount++;
      }
    }
    netProfit = Math.round(netProfit * 100) / 100;

    const summary = {
      initialBalance: 10000.0,
      endingBalance: Math.round((10000.0 + netProfit) * 100) / 100,
      netProfit: netProfit,
      totalTrades: totalTradesCount,
      winCount: winCount,
      lossCount: lossCount,
      winRate: Math.round((winCount / (totalTradesCount || 1)) * 1000) / 10,
      profitFactor: Math.round(res.profitFactor * 100) / 100,
      maxDrawdown: Math.round(res.maxDrawdownPct * 100) / 100,
      avgWin: Math.round((res.avgWin || 0) * 100) / 100,
      avgLoss: Math.round((res.avgLoss || 0) * 100) / 100,
      realizedRR: Math.round((res.payoff || 0) * 100) / 100,
      strategy: 'Strategy V2 (Oliver Kell Enhanced R:R Edition - Jan to Nov 2026)',
      lastSyncedAt: new Date().toISOString(),
    };

    fs.writeFileSync(JOURNAL_PATH, JSON.stringify({ summary, daysMap }, null, 2));
    console.log(`[DailySimScheduler] 💾 Successfully updated ${JOURNAL_PATH}! (${Object.keys(daysMap).length} days, latest: ${Object.keys(daysMap).pop()})`);

    // Auto-regenerate public Excel and CSV exports so downloads are always fresh!
    try {
      const { generateFullJournalExcelBuffer } = require('./excelExporter');
      const { generateFullJournalCSV } = require('./journalExporter');
      const excelBuf = await generateFullJournalExcelBuffer();
      fs.writeFileSync(path.join(__dirname, '..', '..', 'public', 'Hyperview_Full_Trading_Journal_2026.xlsx'), excelBuf);
      const csvStr = generateFullJournalCSV();
      fs.writeFileSync(path.join(__dirname, '..', '..', 'public', 'Hyperview_Full_Trading_Journal_2026.csv'), csvStr, 'utf8');
      console.log('[DailySimScheduler] 📊 Automatically refreshed public Excel and CSV export files.');
    } catch (expErr) {
      console.warn('[DailySimScheduler] Warning auto-generating export files:', expErr.message);
    }

    return true;
  } catch (e) {
    console.error('[DailySimScheduler] Error syncing daily simulation:', e);
    return false;
  }
}

function startDailyScheduler() {
  // 1. Run immediately on boot / startup
  syncDailySimulation();

  // 2. Schedule to run every 12 hours
  if (dailyTimer) clearInterval(dailyTimer);
  dailyTimer = setInterval(() => {
    syncDailySimulation();
  }, 12 * 60 * 60 * 1000);

  console.log('[DailySimScheduler] ⏰ Scheduled periodic catch-up simulation every 12 hours.');
}

module.exports = {
  syncDailySimulation,
  startDailyScheduler,
};
