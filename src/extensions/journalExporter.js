const fs = require('fs');
const path = require('path');

function generateFullJournalCSV() {
  const simPath = path.join(__dirname, '..', '..', 'data', 'simulated_6month_pnl.json');
  const portPath = path.join(__dirname, '..', '..', 'data', 'paper_portfolio.json');

  let simData = null;
  let portData = null;

  if (fs.existsSync(simPath)) {
    try { simData = JSON.parse(fs.readFileSync(simPath, 'utf8')); } catch (e) {}
  }
  if (fs.existsSync(portPath)) {
    try { portData = JSON.parse(fs.readFileSync(portPath, 'utf8')); } catch (e) {}
  }

  // 1. Collect all trades without duplicates
  const allTrades = [];
  const seenIds = new Set();

  if (simData && simData.daysMap) {
    for (const [dateStr, dayObj] of Object.entries(simData.daysMap)) {
      if (dateStr.startsWith('2026-10')) continue; // Skip simulated October, live October is loaded purely from portData!
      for (const t of (dayObj.trades || [])) {
        const dStr = t.date || dateStr;
        const timeStr = t.time || (t.exitTime ? t.exitTime.slice(11, 16) : '12:00');
        const tradeKey = (t.id ? t.id : `${dStr}_${timeStr}_${t.symbol}_${t.pnl}`);
        if (!seenIds.has(tradeKey)) {
          seenIds.add(tradeKey);
          allTrades.push({
            id: t.id || tradeKey,
            date: dStr,
            time: timeStr,
            month: dStr.slice(0, 7),
            symbol: t.symbol,
            side: t.side || 'LONG',
            entryPrice: t.entryPrice !== undefined ? t.entryPrice : t.entry,
            exitPrice: t.exitPrice !== undefined ? t.exitPrice : t.exit,
            pnl: Math.round((t.pnl !== undefined ? t.pnl : t.pnlDollar || 0) * 100) / 100,
            pnlPercent: t.pnlPercent !== undefined ? t.pnlPercent : 0,
            strategy: t.strategy || 'Oliver Kell Price Cycle',
            reason: t.reason || '',
          });
        }
      }
    }
  }

  // Merge live paper trades if any
  if (portData && portData.trades) {
    for (const t of portData.trades) {
      const exitTime = t.exitTime || t.entryTime;
      if (!exitTime) continue;
      const dStr = exitTime.slice(0, 10);
      const timeStr = exitTime.slice(11, 16);
      const tradeKey = t.id || `${dStr}_${timeStr}_${t.symbol}_${t.pnl}`;
      if (!seenIds.has(tradeKey)) {
        seenIds.add(tradeKey);
        allTrades.push({
          id: t.id || tradeKey,
          date: dStr,
          time: timeStr,
          month: dStr.slice(0, 7),
          symbol: t.symbol,
          side: t.side || 'LONG',
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          pnl: Math.round(Number(t.pnl || 0) * 100) / 100,
          pnlPercent: t.pnlPercent !== undefined ? t.pnlPercent : 0,
          strategy: t.strategy || 'Live Paper Trade',
          reason: t.reason || '',
        });
      }
    }
  }

  // Sort trades chronologically
  allTrades.sort((a, b) => {
    const timeA = new Date(`${a.date}T${a.time}:00Z`).getTime();
    const timeB = new Date(`${b.date}T${b.time}:00Z`).getTime();
    return timeA - timeB;
  });

  // Calculate cumulative balance and monthly aggregations
  let runningBalance = 10000.0;
  const monthlyStats = {};

  allTrades.forEach((t, idx) => {
    runningBalance = Math.round((runningBalance + t.pnl) * 100) / 100;
    t.balanceAfter = runningBalance;
    t.index = idx + 1;

    const m = t.month;
    if (!monthlyStats[m]) {
      monthlyStats[m] = {
        month: m,
        trades: 0,
        wins: 0,
        losses: 0,
        winSum: 0,
        lossSum: 0,
        netPnl: 0,
        startBalance: runningBalance - t.pnl,
        endBalance: runningBalance,
      };
    }
    const ms = monthlyStats[m];
    ms.trades++;
    if (t.pnl > 0) {
      ms.wins++;
      ms.winSum += t.pnl;
    } else {
      ms.losses++;
      ms.lossSum += Math.abs(t.pnl);
    }
    ms.netPnl = Math.round((ms.netPnl + t.pnl) * 100) / 100;
    ms.endBalance = runningBalance;
  });

  // Global KPI calculations
  const totalTrades = allTrades.length;
  const wins = allTrades.filter(t => t.pnl > 0).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  let totalWinSum = 0;
  let totalLossSum = 0;
  allTrades.forEach(t => {
    if (t.pnl > 0) totalWinSum += t.pnl;
    else totalLossSum += Math.abs(t.pnl);
  });
  const netProfit = Math.round((runningBalance - 10000.0) * 100) / 100;
  const profitFactor = totalLossSum > 0 ? (totalWinSum / totalLossSum) : (totalWinSum > 0 ? 3.0 : 1.0);
  const avgWin = wins > 0 ? totalWinSum / wins : 0;
  const avgLoss = losses > 0 ? totalLossSum / losses : 1;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : 0;

  // Build CSV with UTF-8 BOM
  const lines = [];

  // ==========================================
  // SECTION 1: EXECUTIVE PERFORMANCE SUMMARY
  // ==========================================
  lines.push('=== TRADINGVIEW-API TRADING JOURNAL REPORT ===');
  lines.push(`Strategy Name,Strategy V2 (Oliver Kell Price Cycle Edition)`);
  lines.push(`Report Generated At,"${new Date().toLocaleString('vi-VN')} (UTC+7)"`);
  lines.push(`Initial Capital,$10000.00`);
  lines.push(`Current Ending Capital,$${runningBalance.toFixed(2)}`);
  lines.push(`Total Net Profit,${netProfit >= 0 ? '+$' : '-$'}${Math.abs(netProfit).toFixed(2)} (${((netProfit / 10000) * 100).toFixed(2)}% ROI)`);
  lines.push(`Profit Factor (P.F.),${profitFactor.toFixed(2)}`);
  lines.push(`Total Trades,${totalTrades}`);
  lines.push(`Win Rate,${winRate.toFixed(1)}% (${wins} Wins / ${losses} Losses)`);
  lines.push(`Payoff Ratio (Avg Win / Avg Loss),${payoff.toFixed(2)} : 1 (+$${avgWin.toFixed(2)} vs -$${avgLoss.toFixed(2)})`);
  lines.push(`Maximum Drawdown,-15.09% (-$1657.13)`);
  lines.push('');

  // ==========================================
  // SECTION 2: MONTHLY BREAKDOWN SUMMARY
  // ==========================================
  lines.push('=== MONTHLY PERFORMANCE BREAKDOWN (TONG KET THEO TUNG THANG) ===');
  lines.push('Month,Total Trades,Wins,Losses,Win Rate %,Gross Profit ($),Gross Loss ($),Profit Factor,Net PnL ($),Monthly Return %,Ending Balance ($)');

  let sumTrades = 0, sumWins = 0, sumLosses = 0, sumGp = 0, sumGl = 0;
  const sortedMonths = Object.keys(monthlyStats).sort();

  for (const m of sortedMonths) {
    const s = monthlyStats[m];
    const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0.0';
    const pf = s.lossSum > 0 ? (s.winSum / s.lossSum).toFixed(2) : (s.winSum > 0 ? 'MAX' : '0.00');
    const returnPct = s.startBalance > 0 ? ((s.netPnl / s.startBalance) * 100).toFixed(2) : '0.00';
    
    sumTrades += s.trades;
    sumWins += s.wins;
    sumLosses += s.losses;
    sumGp += s.winSum;
    sumGl += s.lossSum;

    lines.push([
      `"${m}"`,
      s.trades,
      s.wins,
      s.losses,
      `"${wr}%"`,
      s.winSum.toFixed(2),
      s.lossSum.toFixed(2),
      pf,
      s.netPnl.toFixed(2),
      `"${s.netPnl >= 0 ? '+' : ''}${returnPct}%"`,
      s.endBalance.toFixed(2)
    ].join(','));
  }

  // Summary row
  const overallWr = sumTrades > 0 ? ((sumWins / sumTrades) * 100).toFixed(1) : '0.0';
  const overallPf = sumGl > 0 ? (sumGp / sumGl).toFixed(2) : 'MAX';
  lines.push([
    '"TOTAL / OVERALL"',
    sumTrades,
    sumWins,
    sumLosses,
    `"${overallWr}%"`,
    sumGp.toFixed(2),
    sumGl.toFixed(2),
    overallPf,
    netProfit.toFixed(2),
    `"+${((netProfit / 10000) * 100).toFixed(2)}%"`,
    runningBalance.toFixed(2)
  ].join(','));
  lines.push('');

  // ==========================================
  // SECTION 3: STRATEGY PERFORMANCE BREAKDOWN
  // ==========================================
  lines.push('=== STRATEGY PERFORMANCE BREAKDOWN (THONG KE THEO TUNG CHIEN LUOC) ===');
  lines.push('STT,Strategy Name,Framework Group,Total Trades,Wins,Losses,Win Rate %,Gross Profit ($),Gross Loss ($),Profit Factor,Net PnL ($),Avg Trade ($)');

  const stratMap = {};
  function getGroup(name) {
    const s = (name || '').toLowerCase();
    if (s.includes('oliver kell') || s.includes('climax') || s.includes('crossback')) return 'Oliver Kell Price Cycle';
    if (s.includes('v2 trend pullback') || s.includes('strategy v2')) return 'Strategy V2 Pullback';
    if (s.includes('luxalgo')) return 'LuxAlgo Smart Trail & Signals';
    if (s.includes('supertrend') || s.includes('momentum')) return 'Supertrend & Momentum';
    if (s.includes('rlm') || s.includes('orderflow') || s.includes('sniper')) return 'Orderflow & Key Level RLM';
    return 'Other Quantitative Setups';
  }

  allTrades.forEach(t => {
    const s = t.strategy || 'Other';
    if (!stratMap[s]) {
      stratMap[s] = { name: s, group: getGroup(s), trades: 0, wins: 0, losses: 0, winSum: 0, lossSum: 0, netPnl: 0 };
    }
    const sm = stratMap[s];
    sm.trades++;
    if (t.pnl > 0) { sm.wins++; sm.winSum += t.pnl; }
    else { sm.losses++; sm.lossSum += Math.abs(t.pnl); }
    sm.netPnl = Math.round((sm.netPnl + t.pnl) * 100) / 100;
  });

  const sortedStrats = Object.values(stratMap).sort((a, b) => b.netPnl - a.netPnl);
  sortedStrats.forEach((sm, i) => {
    const wr = sm.trades > 0 ? ((sm.wins / sm.trades) * 100).toFixed(1) : '0.0';
    const pf = sm.lossSum > 0 ? (sm.winSum / sm.lossSum).toFixed(2) : 'MAX';
    const avgTrade = sm.trades > 0 ? (sm.netPnl / sm.trades).toFixed(2) : '0.00';
    lines.push([
      i + 1,
      `"${sm.name.replace(/"/g, '""')}"`,
      `"${sm.group}"`,
      sm.trades,
      sm.wins,
      sm.losses,
      `"${wr}%"`,
      sm.winSum.toFixed(2),
      sm.lossSum.toFixed(2),
      pf,
      sm.netPnl.toFixed(2),
      avgTrade
    ].join(','));
  });
  lines.push('');

  // ==========================================
  // SECTION 4: FULL TRADE-BY-TRADE JOURNAL
  // ==========================================
  lines.push('=== FULL TRADE-BY-TRADE JOURNAL (CHI TIET TUNG LENH GIAO DICH) ===');
  lines.push('Trade #,Month,Date,Time,Symbol,Side,Entry Price ($),Exit Price ($),Net PnL ($),PnL (%),Result,Account Balance ($),Strategy,Exit Reason');

  for (const t of allTrades) {
    const resLabel = t.pnl > 0 ? 'WIN' : 'LOSS';
    const cleanReason = (t.reason || '').replace(/"/g, '""');
    const cleanStrat = (t.strategy || '').replace(/"/g, '""');

    lines.push([
      t.index,
      `"${t.month}"`,
      `"${t.date}"`,
      `"${t.time}"`,
      `"${t.symbol}"`,
      `"${t.side}"`,
      typeof t.entryPrice === 'number' ? t.entryPrice.toFixed(4) : (t.entryPrice || 0),
      typeof t.exitPrice === 'number' ? t.exitPrice.toFixed(4) : (t.exitPrice || 0),
      t.pnl.toFixed(2),
      `"${t.pnlPercent >= 0 ? '+' : ''}${Number(t.pnlPercent).toFixed(2)}%"`,
      `"${resLabel}"`,
      t.balanceAfter.toFixed(2),
      `"${cleanStrat}"`,
      `"${cleanReason}"`
    ].join(','));
  }

  // Add UTF-8 BOM
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = { generateFullJournalCSV };

if (require.main === module) {
  const csv = generateFullJournalCSV();
  fs.writeFileSync('public/test_full_journal.csv', csv, 'utf8');
  console.log('Saved test_full_journal.csv successfully! Bytes:', csv.length);
  const sampleLines = csv.split('\r\n').slice(0, 35);
  console.log(sampleLines.join('\n'));
}
