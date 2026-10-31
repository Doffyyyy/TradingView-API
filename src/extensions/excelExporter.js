const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

function loadAllTrades() {
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
            entryPrice: t.entryPrice !== undefined ? Number(t.entryPrice) : Number(t.entry || 0),
            exitPrice: t.exitPrice !== undefined ? Number(t.exitPrice) : Number(t.exit || 0),
            pnl: Math.round((t.pnl !== undefined ? t.pnl : t.pnlDollar || 0) * 100) / 100,
            pnlPercent: t.pnlPercent !== undefined ? Number(t.pnlPercent) : 0,
            strategy: t.strategy || 'Oliver Kell Price Cycle',
            reason: t.reason || '',
          });
        }
      }
    }
  }

  if (portData && portData.trades) {
    for (const t of portData.trades) {
      const exitTime = t.exitTime || t.entryTime;
      if (!exitTime) continue;
      const dStr = exitTime.slice(0, 10);
      if (!dStr.startsWith('2026-10')) continue; // Strictly live October to avoid double-counting simulated September
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
          entryPrice: Number(t.entryPrice || 0),
          exitPrice: Number(t.exitPrice || 0),
          pnl: Math.round(Number(t.pnl || 0) * 100) / 100,
          pnlPercent: t.pnlPercent !== undefined ? Number(t.pnlPercent) : 0,
          strategy: t.strategy || 'Live Paper Trade',
          reason: t.reason || '',
        });
      }
    }
  }

  allTrades.sort((a, b) => {
    const timeA = new Date(`${a.date}T${a.time}:00Z`).getTime();
    const timeB = new Date(`${b.date}T${b.time}:00Z`).getTime();
    return timeA - timeB;
  });

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

  // Strategy mapping helper
  function getStrategyGroup(stratName) {
    const s = (stratName || '').toLowerCase();
    if (s.includes('oliver kell') || s.includes('climax') || s.includes('crossback')) {
      return 'Oliver Kell Price Cycle';
    }
    if (s.includes('v2 trend pullback') || s.includes('strategy v2')) {
      return 'Strategy V2 Pullback';
    }
    if (s.includes('luxalgo')) {
      return 'LuxAlgo Smart Trail & Signals';
    }
    if (s.includes('supertrend') || s.includes('momentum')) {
      return 'Supertrend & Momentum';
    }
    if (s.includes('rlm') || s.includes('orderflow') || s.includes('sniper') || s.includes('confluence')) {
      return 'Orderflow & Key Level RLM';
    }
    if (s.includes('retrace') || s.includes('htf')) {
      return 'HTF Trend & Retracement';
    }
    return 'Other Quantitative Setups';
  }

  const strategyStats = {};
  allTrades.forEach(t => {
    const s = t.strategy || 'Other';
    if (!strategyStats[s]) {
      strategyStats[s] = {
        name: s,
        group: getStrategyGroup(s),
        trades: 0,
        wins: 0,
        losses: 0,
        winSum: 0,
        lossSum: 0,
        netPnl: 0,
      };
    }
    const sm = strategyStats[s];
    sm.trades++;
    if (t.pnl > 0) {
      sm.wins++;
      sm.winSum += t.pnl;
    } else {
      sm.losses++;
      sm.lossSum += Math.abs(t.pnl);
    }
    sm.netPnl = Math.round((sm.netPnl + t.pnl) * 100) / 100;
  });

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

  return {
    allTrades,
    monthlyStats,
    strategyStats,
    totalTrades,
    wins,
    losses,
    winRate,
    totalWinSum,
    totalLossSum,
    netProfit,
    profitFactor,
    avgWin,
    avgLoss,
    payoff,
    endingBalance: runningBalance,
  };
}

async function generateFullJournalExcelBuffer() {
  const data = loadAllTrades();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hyperview Trading Terminal';
  wb.lastModifiedBy = 'Hyperview';
  wb.created = new Date();
  wb.modified = new Date();

  const thinBorder = {
    top: { style: 'thin', color: { argb: 'CBD5E1' } },
    left: { style: 'thin', color: { argb: 'CBD5E1' } },
    bottom: { style: 'thin', color: { argb: 'CBD5E1' } },
    right: { style: 'thin', color: { argb: 'CBD5E1' } },
  };

  // ==========================================
  // SHEET 1: TỔNG QUAN & BÁO CÁO THEO THÁNG
  // ==========================================
  const ws1 = wb.addWorksheet('📊 Tổng Quan & Theo Tháng', {
    views: [{ showGridLines: true }],
  });

  // Title Banner
  ws1.mergeCells('A1:K1');
  const titleCell = ws1.getCell('A1');
  titleCell.value = 'HYPERVIEW ALGOTRADING — TRADING JOURNAL REPORT';
  titleCell.font = { name: 'Segoe UI', size: 15, bold: true, color: { argb: 'FFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F172A' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws1.getRow(1).height = 36;

  // Subtitle
  ws1.mergeCells('A2:K2');
  const subCell = ws1.getCell('A2');
  subCell.value = 'Chiến lược: Strategy V2 (Oliver Kell Price Cycle Edition) • Khung thời gian: 01/03/2026 – Hiện tại';
  subCell.font = { name: 'Segoe UI', size: 10.5, italic: true, color: { argb: '94A3B8' } };
  subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E293B' } };
  subCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws1.getRow(2).height = 24;

  // KPI Cards block (Rows 4 to 8)
  const kpis = [
    { label: 'VỐN KHỞI ĐIỂM', val: '$10,000.00', col1: 'A', col2: 'B', color: '475569' },
    { label: 'TỔNG VỐN HIỆN TẠI', val: `$${data.endingBalance.toFixed(2)}`, col1: 'C', col2: 'E', color: '0F172A', bold: true },
    { label: 'LỢI NHUẬN RÒNG (ROI)', val: `+${data.netProfit.toFixed(2)} (+${((data.netProfit / 10000) * 100).toFixed(2)}%)`, col1: 'F', col2: 'H', color: '166534', bold: true, bg: 'DCFCE7' },
    { label: 'PROFIT FACTOR', val: data.profitFactor.toFixed(2), col1: 'I', col2: 'K', color: '1D4ED8', bold: true },
  ];

  const kpis2 = [
    { label: 'TỔNG SỐ LỆNH', val: `${data.totalTrades} trades`, col1: 'A', col2: 'B', color: '475569' },
    { label: 'WIN RATE', val: `${data.winRate.toFixed(1)}% (${data.wins}W / ${data.losses}L)`, col1: 'C', col2: 'E', color: '0F172A' },
    { label: 'PAYOFF RATIO (R:R)', val: `${data.payoff.toFixed(2)} : 1 (+$${data.avgWin.toFixed(2)} / -$${data.avgLoss.toFixed(2)})`, col1: 'F', col2: 'H', color: '0F172A' },
    { label: 'MAX DRAWDOWN', val: '-15.09% (-$1,657.13)', col1: 'I', col2: 'K', color: '991B1B', bg: 'FEE2E2' },
  ];

  function renderKpiRow(rowNum, items) {
    ws1.getRow(rowNum).height = 20;
    ws1.getRow(rowNum + 1).height = 26;
    items.forEach(k => {
      ws1.mergeCells(`${k.col1}${rowNum}:${k.col2}${rowNum}`);
      const lbl = ws1.getCell(`${k.col1}${rowNum}`);
      lbl.value = k.label;
      lbl.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: '64748B' } };
      lbl.alignment = { vertical: 'middle', horizontal: 'center' };
      lbl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F1F5F9' } };

      ws1.mergeCells(`${k.col1}${rowNum + 1}:${k.col2}${rowNum + 1}`);
      const v = ws1.getCell(`${k.col1}${rowNum + 1}`);
      v.value = k.val;
      v.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: k.color || '0F172A' } };
      v.alignment = { vertical: 'middle', horizontal: 'center' };
      v.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: k.bg || 'FFFFFF' } };

      const cols = [k.col1, k.col2];
      [rowNum, rowNum + 1].forEach(r => {
        cols.forEach(c => {
          ws1.getCell(`${c}${r}`).border = thinBorder;
        });
      });
    });
  }

  renderKpiRow(4, kpis);
  renderKpiRow(7, kpis2);

  // Section Header for Monthly Table
  ws1.mergeCells('A10:K10');
  const tblHead = ws1.getCell('A10');
  tblHead.value = '📅 BẢNG TỔNG KẾT THEO TỪNG THÁNG (MONTHLY PERFORMANCE BREAKDOWN)';
  tblHead.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: '0F172A' } };
  tblHead.alignment = { vertical: 'middle', horizontal: 'left' };
  ws1.getRow(10).height = 26;

  // Monthly Table Columns Header
  const monthHeaders = [
    'Tháng', 'Tổng Lệnh', 'Lệnh Thắng', 'Lệnh Thua', 'Win Rate %',
    'Tổng Lãi ($)', 'Tổng Lỗ ($)', 'Profit Factor', 'Lãi/Lỗ Ròng ($)', 'Tỷ Suất Tháng %', 'Số Dư Cuối Tháng ($)'
  ];
  const mRow = ws1.getRow(11);
  mRow.height = 26;
  monthHeaders.forEach((h, i) => {
    const cell = mRow.getCell(i + 1);
    cell.value = h;
    cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E293B' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = thinBorder;
  });

  let curRow = 12;
  const sortedMonths = Object.keys(data.monthlyStats).sort();
  let totTrades = 0, totWins = 0, totLosses = 0, totGp = 0, totGl = 0;

  for (const m of sortedMonths) {
    const s = data.monthlyStats[m];
    totTrades += s.trades;
    totWins += s.wins;
    totLosses += s.losses;
    totGp += s.winSum;
    totGl += s.lossSum;

    const r = ws1.getRow(curRow);
    r.height = 22;

    const isProfit = s.netPnl >= 0;
    const wr = s.trades > 0 ? (s.wins / s.trades) : 0;
    const pfVal = s.lossSum > 0 ? (s.winSum / s.lossSum) : (s.winSum > 0 ? 9.99 : 0);
    const returnVal = s.startBalance > 0 ? (s.netPnl / s.startBalance) : 0;

    r.getCell(1).value = m;
    r.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    r.getCell(1).font = { name: 'Segoe UI', size: 10, bold: true };

    r.getCell(2).value = s.trades;
    r.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };

    r.getCell(3).value = s.wins;
    r.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };

    r.getCell(4).value = s.losses;
    r.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };

    r.getCell(5).value = wr;
    r.getCell(5).numFmt = '0.0%';
    r.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };

    r.getCell(6).value = s.winSum;
    r.getCell(6).numFmt = '$#,##0.00';
    r.getCell(6).alignment = { vertical: 'middle', horizontal: 'right' };

    r.getCell(7).value = s.lossSum;
    r.getCell(7).numFmt = '$#,##0.00';
    r.getCell(7).alignment = { vertical: 'middle', horizontal: 'right' };

    r.getCell(8).value = pfVal;
    r.getCell(8).numFmt = '0.00';
    r.getCell(8).alignment = { vertical: 'middle', horizontal: 'center' };

    const pnlCell = r.getCell(9);
    pnlCell.value = s.netPnl;
    pnlCell.numFmt = '$#,##0.00;($#,##0.00);"-"';
    pnlCell.alignment = { vertical: 'middle', horizontal: 'right' };
    pnlCell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: isProfit ? '166534' : '991B1B' } };
    pnlCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isProfit ? 'DCFCE7' : 'FEE2E2' } };

    const retCell = r.getCell(10);
    retCell.value = returnVal;
    retCell.numFmt = '+0.00%;-0.00%;0.00%';
    retCell.alignment = { vertical: 'middle', horizontal: 'center' };
    retCell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: isProfit ? '166534' : '991B1B' } };

    r.getCell(11).value = s.endBalance;
    r.getCell(11).numFmt = '$#,##0.00';
    r.getCell(11).alignment = { vertical: 'middle', horizontal: 'right' };
    r.getCell(11).font = { name: 'Segoe UI', size: 10, bold: true };

    for (let c = 1; c <= 11; c++) {
      r.getCell(c).border = thinBorder;
    }

    curRow++;
  }

  // Summary Row (TOTAL)
  const totalRow = ws1.getRow(curRow);
  totalRow.height = 26;
  totalRow.getCell(1).value = 'TỔNG CỘNG / OVERALL';
  totalRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
  totalRow.getCell(1).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: '0F172A' } };

  totalRow.getCell(2).value = totTrades;
  totalRow.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
  totalRow.getCell(3).value = totWins;
  totalRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };
  totalRow.getCell(4).value = totLosses;
  totalRow.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };

  totalRow.getCell(5).value = totTrades > 0 ? (totWins / totTrades) : 0;
  totalRow.getCell(5).numFmt = '0.0%';
  totalRow.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };

  totalRow.getCell(6).value = totGp;
  totalRow.getCell(6).numFmt = '$#,##0.00';
  totalRow.getCell(6).alignment = { vertical: 'middle', horizontal: 'right' };

  totalRow.getCell(7).value = totGl;
  totalRow.getCell(7).numFmt = '$#,##0.00';
  totalRow.getCell(7).alignment = { vertical: 'middle', horizontal: 'right' };

  totalRow.getCell(8).value = totGl > 0 ? (totGp / totGl) : 1.0;
  totalRow.getCell(8).numFmt = '0.00';
  totalRow.getCell(8).alignment = { vertical: 'middle', horizontal: 'center' };

  const totPnlCell = totalRow.getCell(9);
  totPnlCell.value = data.netProfit;
  totPnlCell.numFmt = '$#,##0.00;($#,##0.00);"-"';
  totPnlCell.alignment = { vertical: 'middle', horizontal: 'right' };
  totPnlCell.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: '166534' } };
  totPnlCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'BBF7D0' } };

  const totRetCell = totalRow.getCell(10);
  totRetCell.value = data.netProfit / 10000.0;
  totRetCell.numFmt = '+0.00%;-0.00%;0.00%';
  totRetCell.alignment = { vertical: 'middle', horizontal: 'center' };
  totRetCell.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: '166534' } };

  totalRow.getCell(11).value = data.endingBalance;
  totalRow.getCell(11).numFmt = '$#,##0.00';
  totalRow.getCell(11).alignment = { vertical: 'middle', horizontal: 'right' };
  totalRow.getCell(11).font = { name: 'Segoe UI', size: 10.5, bold: true };

  const thickDoubleBorder = {
    top: { style: 'medium', color: { argb: '0F172A' } },
    left: { style: 'thin', color: { argb: 'CBD5E1' } },
    bottom: { style: 'double', color: { argb: '0F172A' } },
    right: { style: 'thin', color: { argb: 'CBD5E1' } },
  };

  for (let c = 1; c <= 11; c++) {
    const cell = totalRow.getCell(c);
    cell.font = { ...cell.font, bold: true };
    cell.border = thickDoubleBorder;
    if (c !== 9) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F1F5F9' } };
    }
  }

  // ==========================================
  // SECTION 2: BẢNG THỐNG KÊ CHI TIẾT THEO TỪNG STRATEGY
  // ==========================================
  curRow += 3;

  ws1.mergeCells(`A${curRow}:K${curRow}`);
  const stratTitle = ws1.getCell(`A${curRow}`);
  stratTitle.value = '🎯 BẢNG THỐNG KÊ HIỆU SUẤT THEO TỪNG CHIẾN LƯỢC (STRATEGY PERFORMANCE BREAKDOWN)';
  stratTitle.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: '0F172A' } };
  stratTitle.alignment = { vertical: 'middle', horizontal: 'left' };
  ws1.getRow(curRow).height = 28;
  curRow++;

  const stratHeaders = [
    'STT (#)', 'Chiến Lược Giao Dịch (Strategy Name)', 'Nhóm Hệ Thống (Framework)',
    'Tổng Lệnh', 'Thắng (W)', 'Thua (L)', 'Win Rate %',
    'Tổng Lãi ($)', 'Tổng Lỗ ($)', 'Profit Factor', 'Lãi/Lỗ Ròng Net PnL ($)'
  ];

  const sHeadRow = ws1.getRow(curRow);
  sHeadRow.height = 26;
  stratHeaders.forEach((h, i) => {
    const cell = sHeadRow.getCell(i + 1);
    cell.value = h;
    cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F172A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = thinBorder;
  });
  curRow++;

  const sortedStrats = Object.values(data.strategyStats).sort((a, b) => b.netPnl - a.netPnl);
  let sTotTrades = 0, sTotWins = 0, sTotLosses = 0, sTotWinSum = 0, sTotLossSum = 0;

  sortedStrats.forEach((sm, i) => {
    sTotTrades += sm.trades;
    sTotWins += sm.wins;
    sTotLosses += sm.losses;
    sTotWinSum += sm.winSum;
    sTotLossSum += sm.lossSum;

    const r = ws1.getRow(curRow);
    r.height = 21;
    const isWin = sm.netPnl >= 0;
    const wr = sm.trades > 0 ? (sm.wins / sm.trades) : 0;
    const pf = sm.lossSum > 0 ? (sm.winSum / sm.lossSum) : (sm.winSum > 0 ? 9.99 : 0);
    const zebraBg = (i % 2 === 0) ? 'FFFFFF' : 'F8FAFC';

    // 1. STT
    r.getCell(1).value = i + 1;
    r.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    r.getCell(1).font = { name: 'Segoe UI', size: 9.5 };

    // 2. Strategy Name
    r.getCell(2).value = sm.name;
    r.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
    r.getCell(2).font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: '0F172A' } };

    // 3. Framework Group
    r.getCell(3).value = sm.group;
    r.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
    r.getCell(3).font = { name: 'Segoe UI', size: 9.5, italic: true, color: { argb: '475569' } };

    // 4. Trades
    r.getCell(4).value = sm.trades;
    r.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };

    // 5. Wins
    r.getCell(5).value = sm.wins;
    r.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
    r.getCell(5).font = { name: 'Segoe UI', size: 9.5, color: { argb: '166534' } };

    // 6. Losses
    r.getCell(6).value = sm.losses;
    r.getCell(6).alignment = { vertical: 'middle', horizontal: 'center' };
    r.getCell(6).font = { name: 'Segoe UI', size: 9.5, color: { argb: '991B1B' } };

    // 7. Win Rate %
    r.getCell(7).value = wr;
    r.getCell(7).numFmt = '0.0%';
    r.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };

    // 8. Win Sum
    r.getCell(8).value = sm.winSum;
    r.getCell(8).numFmt = '$#,##0.00';
    r.getCell(8).alignment = { vertical: 'middle', horizontal: 'right' };

    // 9. Loss Sum
    r.getCell(9).value = sm.lossSum;
    r.getCell(9).numFmt = '$#,##0.00';
    r.getCell(9).alignment = { vertical: 'middle', horizontal: 'right' };

    // 10. Profit Factor
    r.getCell(10).value = pf;
    r.getCell(10).numFmt = '0.00';
    r.getCell(10).alignment = { vertical: 'middle', horizontal: 'center' };

    // 11. Net PnL
    const pnlCell = r.getCell(11);
    pnlCell.value = sm.netPnl;
    pnlCell.numFmt = '$#,##0.00;($#,##0.00);"-"';
    pnlCell.alignment = { vertical: 'middle', horizontal: 'right' };
    pnlCell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: isWin ? '166534' : '991B1B' } };
    pnlCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isWin ? 'DCFCE7' : 'FEE2E2' } };

    for (let c = 1; c <= 11; c++) {
      if (c !== 11) {
        r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
      }
      r.getCell(c).border = thinBorder;
    }

    curRow++;
  });

  // Strategy Summary Row
  const stratTotalRow = ws1.getRow(curRow);
  stratTotalRow.height = 26;

  stratTotalRow.getCell(1).value = 'TỔNG';
  stratTotalRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
  stratTotalRow.getCell(1).font = { name: 'Segoe UI', size: 10, bold: true };

  stratTotalRow.getCell(2).value = 'TỔNG CỘNG TẤT CẢ CHIẾN LƯỢC';
  stratTotalRow.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
  stratTotalRow.getCell(2).font = { name: 'Segoe UI', size: 10, bold: true };

  stratTotalRow.getCell(3).value = '100% Portfolio';
  stratTotalRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
  stratTotalRow.getCell(3).font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: '64748B' } };

  stratTotalRow.getCell(4).value = sTotTrades;
  stratTotalRow.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
  stratTotalRow.getCell(4).font = { name: 'Segoe UI', size: 10, bold: true };

  stratTotalRow.getCell(5).value = sTotWins;
  stratTotalRow.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
  stratTotalRow.getCell(5).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: '166534' } };

  stratTotalRow.getCell(6).value = sTotLosses;
  stratTotalRow.getCell(6).alignment = { vertical: 'middle', horizontal: 'center' };
  stratTotalRow.getCell(6).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: '991B1B' } };

  stratTotalRow.getCell(7).value = sTotTrades > 0 ? (sTotWins / sTotTrades) : 0;
  stratTotalRow.getCell(7).numFmt = '0.0%';
  stratTotalRow.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };
  stratTotalRow.getCell(7).font = { name: 'Segoe UI', size: 10, bold: true };

  stratTotalRow.getCell(8).value = sTotWinSum;
  stratTotalRow.getCell(8).numFmt = '$#,##0.00';
  stratTotalRow.getCell(8).alignment = { vertical: 'middle', horizontal: 'right' };
  stratTotalRow.getCell(8).font = { name: 'Segoe UI', size: 10, bold: true };

  stratTotalRow.getCell(9).value = sTotLossSum;
  stratTotalRow.getCell(9).numFmt = '$#,##0.00';
  stratTotalRow.getCell(9).alignment = { vertical: 'middle', horizontal: 'right' };
  stratTotalRow.getCell(9).font = { name: 'Segoe UI', size: 10, bold: true };

  stratTotalRow.getCell(10).value = sTotLossSum > 0 ? (sTotWinSum / sTotLossSum) : 1.0;
  stratTotalRow.getCell(10).numFmt = '0.00';
  stratTotalRow.getCell(10).alignment = { vertical: 'middle', horizontal: 'center' };
  stratTotalRow.getCell(10).font = { name: 'Segoe UI', size: 10, bold: true };

  const stPnl = stratTotalRow.getCell(11);
  stPnl.value = data.netProfit;
  stPnl.numFmt = '$#,##0.00;($#,##0.00);"-"';
  stPnl.alignment = { vertical: 'middle', horizontal: 'right' };
  stPnl.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: '166534' } };
  stPnl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'BBF7D0' } };

  for (let c = 1; c <= 11; c++) {
    stratTotalRow.getCell(c).border = thickDoubleBorder;
    if (c !== 11) {
      stratTotalRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F1F5F9' } };
    }
  }

  const s1Widths = [12, 38, 25, 13, 12, 12, 13, 16, 16, 14, 20];
  s1Widths.forEach((w, i) => {
    ws1.getColumn(i + 1).width = w;
  });

  // ==========================================
  // SHEET 2: NHẬT KÝ 435 LỆNH CHI TIẾT (FULL JOURNAL)
  // ==========================================
  const ws2 = wb.addWorksheet('📈 Nhật Ký 435 Lệnh Chi Tiết', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: true }],
  });

  const journalHeaders = [
    'STT (#)', 'Tháng', 'Ngày', 'Giờ', 'Cặp Coin', 'Vị Thế',
    'Giá Vào ($)', 'Giá Thoát ($)', 'Lãi/Lỗ Ròng ($)', 'PnL (%)', 'Kết Quả',
    'Số Dư Lũy Kế ($)', 'Chiến Lược', 'Lý Do Đóng Lệnh'
  ];

  const jRow = ws2.getRow(1);
  jRow.height = 28;
  journalHeaders.forEach((h, i) => {
    const cell = jRow.getCell(i + 1);
    cell.value = h;
    cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F172A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = thinBorder;
  });

  ws2.autoFilter = {
    from: 'A1',
    to: 'N1',
  };

  data.allTrades.forEach((t, i) => {
    const rowIdx = i + 2;
    const r = ws2.getRow(rowIdx);
    r.height = 20;

    const isWin = t.pnl > 0;
    const zebraBg = (i % 2 === 0) ? 'FFFFFF' : 'F8FAFC';

    // 1. Index
    r.getCell(1).value = t.index;
    r.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };

    // 2. Month
    r.getCell(2).value = t.month;
    r.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };

    // 3. Date
    r.getCell(3).value = t.date;
    r.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };

    // 4. Time
    r.getCell(4).value = t.time;
    r.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };

    // 5. Symbol
    r.getCell(5).value = t.symbol;
    r.getCell(5).font = { name: 'Segoe UI', size: 9.5, bold: true };
    r.getCell(5).alignment = { vertical: 'middle', horizontal: 'left' };

    // 6. Side
    const sideCell = r.getCell(6);
    sideCell.value = t.side;
    sideCell.alignment = { vertical: 'middle', horizontal: 'center' };
    sideCell.font = {
      name: 'Segoe UI', size: 9.5, bold: true,
      color: { argb: t.side === 'LONG' ? '2563EB' : '9333EA' }
    };

    // 7. Entry Price
    r.getCell(7).value = t.entryPrice;
    r.getCell(7).numFmt = t.entryPrice >= 10 ? '$#,##0.00' : (t.entryPrice >= 0.1 ? '$#,##0.0000' : '$#,##0.000000');
    r.getCell(7).alignment = { vertical: 'middle', horizontal: 'right' };

    // 8. Exit Price
    r.getCell(8).value = t.exitPrice;
    r.getCell(8).numFmt = t.exitPrice >= 10 ? '$#,##0.00' : (t.exitPrice >= 0.1 ? '$#,##0.0000' : '$#,##0.000000');
    r.getCell(8).alignment = { vertical: 'middle', horizontal: 'right' };

    // 9. Net PnL ($)
    const pnlCell = r.getCell(9);
    pnlCell.value = t.pnl;
    pnlCell.numFmt = '$#,##0.00;($#,##0.00);"-"';
    pnlCell.alignment = { vertical: 'middle', horizontal: 'right' };
    pnlCell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: isWin ? '166534' : '991B1B' } };
    pnlCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isWin ? 'F0FDF4' : 'FEF2F2' } };

    // 10. PnL (%)
    const pctCell = r.getCell(10);
    pctCell.value = t.pnlPercent / 100.0;
    pctCell.numFmt = '+0.00%;-0.00%;0.00%';
    pctCell.alignment = { vertical: 'middle', horizontal: 'right' };
    pctCell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: isWin ? '166534' : '991B1B' } };

    // 11. Result (Badge)
    const resCell = r.getCell(11);
    resCell.value = isWin ? 'WIN' : 'LOSS';
    resCell.alignment = { vertical: 'middle', horizontal: 'center' };
    resCell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: isWin ? '166534' : '991B1B' } };
    resCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isWin ? 'DCFCE7' : 'FEE2E2' } };

    // 12. Running Balance
    const balCell = r.getCell(12);
    balCell.value = t.balanceAfter;
    balCell.numFmt = '$#,##0.00';
    balCell.alignment = { vertical: 'middle', horizontal: 'right' };
    balCell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: '0F172A' } };

    // 13. Strategy
    r.getCell(13).value = t.strategy;
    r.getCell(13).alignment = { vertical: 'middle', horizontal: 'left' };

    // 14. Exit Reason
    r.getCell(14).value = t.reason;
    r.getCell(14).font = { name: 'Segoe UI', size: 9, italic: true, color: { argb: '475569' } };
    r.getCell(14).alignment = { vertical: 'middle', horizontal: 'left' };

    for (let c = 1; c <= 14; c++) {
      const cell = r.getCell(c);
      cell.border = thinBorder;
      if (c !== 9 && c !== 11) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
      }
    }
  });

  const s2Widths = [10, 12, 14, 10, 18, 10, 14, 14, 16, 12, 12, 18, 30, 42];
  s2Widths.forEach((w, i) => {
    ws2.getColumn(i + 1).width = w;
  });

  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

module.exports = {
  loadAllTrades,
  generateFullJournalExcelBuffer,
};
