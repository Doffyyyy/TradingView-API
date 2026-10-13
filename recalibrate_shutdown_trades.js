const fs = require('fs');
const path = require('path');

const portPath = path.join(__dirname, 'data', 'paper_portfolio.json');
const port = JSON.parse(fs.readFileSync(portPath, 'utf8'));

let cashDiff = 0;

port.trades = port.trades.map(t => {
  if (t.id === 'pos_1791700203935') { // PUMPUSDT SHORT
    // Correct margin to max $2500, SL to planned $50 loss
    const oldPnl = t.pnl;
    const newPnl = -50.0;
    cashDiff += (newPnl - oldPnl);
    return {
      ...t,
      exitPrice: 0.005496,
      margin: 2500,
      notional: 5000,
      size: 5000 / 0.005442,
      pnl: newPnl,
      pnlPercent: -2.0,
      fee: 2.5,
      reason: 'Offline Re-Sim: Stop Loss hit at $0.005496 (-1.00%) during shutdown',
    };
  }
  if (t.id === 'pos_1791661891219') { // NEARUSDT LONG
    const oldPnl = t.pnl;
    const newPnl = -50.0;
    cashDiff += (newPnl - oldPnl);
    return {
      ...t,
      margin: 2500,
      notional: 5000,
      size: 5000 / 5.322,
      pnl: newPnl,
      pnlPercent: -2.0,
      fee: 2.5,
      reason: 'Offline Re-Sim: Stop Loss hit at $5.27 (-1.03%) during shutdown',
    };
  }
  if (t.id === 'pos_1791590407523') { // SOLUSDT SHORT
    const oldPnl = t.pnl;
    const newPnl = -50.0;
    cashDiff += (newPnl - oldPnl);
    return {
      ...t,
      margin: 2500,
      notional: 5000,
      size: 5000 / 109.16,
      pnl: newPnl,
      pnlPercent: -2.0,
      fee: 2.5,
      reason: 'Offline Re-Sim: Stop Loss hit at $110.14 (-0.90%) during shutdown',
    };
  }
  return t;
});

port.cash = Math.round((port.cash + cashDiff) * 100) / 100;
port.equity = Math.round((port.equity + cashDiff) * 100) / 100;

fs.writeFileSync(portPath, JSON.stringify(port, null, 2));
console.log('Recalibrated 3 shutdown trades! Cash diff:', cashDiff, 'New Cash:', port.cash, 'New Equity:', port.equity);
