const fs = require('fs');
const path = require('path');

const resPath = path.join(__dirname, 'results', 'strategy_v2_oliver_kell.json');
const rawResult = JSON.parse(fs.readFileSync(resPath, 'utf8'));

const trades = rawResult.trades;
// Sort trades chronologically by exitTime
trades.sort((a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime());

let currentBalance = 10000.0;
const daysMap = {};

// Pre-fill all calendar days from 2026-03-01 to 2026-10-04
const curD = new Date('2026-03-01T00:00:00Z');
const endD = new Date('2026-10-04T00:00:00Z');
while (curD <= endD) {
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
    exit: t.exitPrice,
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
  endingBalance: Math.round(rawResult.finalBalance * 100) / 100,
  netProfit: Math.round(rawResult.netPnl * 100) / 100,
  totalTrades: rawResult.totalTrades,
  winCount: rawResult.wins,
  lossCount: rawResult.losses,
  winRate: Math.round(rawResult.winRate * 10) / 10,
  profitFactor: Math.round(rawResult.profitFactor * 100) / 100,
  maxDrawdown: Math.round(rawResult.maxDrawdownPct * 100) / 100,
  strategy: 'Strategy V2 (Oliver Kell Price Cycle Edition)',
};

const output = {
  summary,
  daysMap,
};

const targetPath = path.join(__dirname, 'data', 'simulated_6month_pnl.json');
fs.writeFileSync(targetPath, JSON.stringify(output, null, 2));

console.log('Successfully recorded Strategy V2 Oliver Kell Edition into Daily PnL Journal!');
console.log('Summary:', summary);
console.log('Days mapped:', Object.keys(daysMap).length);
console.log('Sample day 2026-08-20:', daysMap['2026-08-20']);
console.log('Sample day 2026-09-15:', daysMap['2026-09-15']);
