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

    // 2. Run Oliver Kell Strategy V2 Engine on complete merged data
    const engine = new OliverKellEngine({
      maxCrossbacks: 3,
      minRRPivot: 2.2,
      atrBuffer: 0.6,
      initialBalance: 10000,
      riskPerTradePct: 0.005,
      maxMargin: 2500,
      maxLeverage: 2.0,
    });

    const res = engine.run(mergedData, SYMBOLS);
    console.log(`[DailySimScheduler] ✅ Simulation complete: ${res.totalTrades} trades, Net PnL: +$${res.netPnl.toFixed(2)}, WR: ${res.winRate.toFixed(1)}%, PF: ${res.profitFactor.toFixed(2)}`);

    // 3. Build Daily PnL Journal daysMap
    const trades = res.trades;
    trades.sort((a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime());

    let currentBalance = 10000.0;
    const daysMap = {};

    // Generate date sequence from 2026-03-01 to today
    const startDate = new Date('2026-03-01T00:00:00Z');
    const today = new Date();
    // Default today fallback to 2026-10-13 if system clock is behind
    const effectiveEnd = today.getFullYear() >= 2026 ? today : new Date('2026-10-13T23:59:59Z');
    const curD = new Date(startDate);

    while (curD <= effectiveEnd) {
      const dStr = curD.toISOString().slice(0, 10);
      daysMap[dStr] = { pnl: 0, trades: [] };
      curD.setUTCDate(curD.getUTCDate() + 1);
    }

    for (const t of trades) {
      const dStr = t.exitTime ? t.exitTime.slice(0, 10) : t.entryTime.slice(0, 10);
      const mStr = dStr.slice(0, 7);
      const pnlRound = Math.round(t.pnl * 100) / 100;
      currentBalance = Math.round((currentBalance + pnlRound) * 100) / 100;

      if (!daysMap[dStr]) {
        daysMap[dStr] = { pnl: 0, trades: [] };
      }

      daysMap[dStr].pnl = Math.round((daysMap[dStr].pnl + pnlRound) * 100) / 100;

      let stratLabel = 'Oliver Kell Price Cycle';
      if (t.reason === 'EXHAUSTION_CLIMAX') {
        stratLabel = 'Oliver Kell: Climax Extension (+5R~8R)';
      } else if (t.stage1Taken) {
        stratLabel = 'Oliver Kell: Stage 1 TP (+2.2R) + Runner';
      } else {
        stratLabel = 'Oliver Kell: EMA Crossback Setup';
      }

      const pnlPct = Math.round(((t.exitPrice - t.entryPrice) / t.entryPrice) * 10000) / 100;

      daysMap[dStr].trades.push({
        symbol: t.symbol,
        side: 'LONG',
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

    const summary = {
      initialBalance: 10000.0,
      endingBalance: Math.round(res.finalBalance * 100) / 100,
      netProfit: Math.round(res.netPnl * 100) / 100,
      totalTrades: res.totalTrades,
      winCount: res.wins,
      lossCount: res.losses,
      winRate: Math.round(res.winRate * 10) / 10,
      profitFactor: Math.round(res.profitFactor * 100) / 100,
      maxDrawdown: Math.round(res.maxDrawdownPct * 100) / 100,
      strategy: 'Strategy V2 (Oliver Kell Price Cycle Edition - Live Auto-Synced)',
      lastSyncedAt: new Date().toISOString(),
    };

    fs.writeFileSync(JOURNAL_PATH, JSON.stringify({ summary, daysMap }, null, 2));
    console.log(`[DailySimScheduler] 💾 Successfully updated ${JOURNAL_PATH}! (${Object.keys(daysMap).length} days, latest: ${Object.keys(daysMap).pop()})`);
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
