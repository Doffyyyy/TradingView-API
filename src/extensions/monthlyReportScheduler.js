/**
 * Monthly Trading Report Telegram Auto-Dispatcher
 *
 * Responsibilities:
 * 1. Checks every 15 minutes if it is the end of the month (23:55-23:59 on the last day, or 00:00 on the 1st).
 * 2. Catches up on startup if the PC was turned off during midnight.
 * 3. Generates the updated 2-Sheet Excel report with Strategy Breakdown.
 * 4. Dispatches the Excel file (.xlsx) and a comprehensive summary report to Telegram chat (1561044995).
 * 5. Logs history to data/monthly_report_history.json to prevent duplicate sends.
 */

const fs = require('fs');
const path = require('path');
const { generateFullJournalExcelBuffer, loadAllTrades } = require('./excelExporter');
const { syncDailySimulation } = require('./dailySimulationScheduler');

const HISTORY_PATH = path.join(__dirname, '..', '..', 'data', 'monthly_report_history.json');
const PUBLIC_XLSX_PATH = path.join(__dirname, '..', '..', 'public', 'Hyperview_Full_Trading_Journal_2026.xlsx');

function getTelegramConfig() {
  let token = process.env.TELEGRAM_BOT_TOKEN;
  let chatId = process.env.TELEGRAM_CHAT_ID || '1561044995';

  if (!token) {
    try {
      const envPath = 'C:/Users/ADMIN/AppData/Local/hermes/.env';
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const mToken = content.match(/TELEGRAM_BOT_TOKEN=([^\r\n]+)/);
        if (mToken) token = mToken[1].trim();
        const mChat = content.match(/TELEGRAM_HOME_CHANNEL=([^\r\n]+)/);
        if (mChat) chatId = mChat[1].trim();
      }
    } catch (e) {}
  }

  return { token, chatId };
}

function getVietnamDate(d = new Date()) {
  return new Date(d.getTime() + (7 * 60 + d.getTimezoneOffset()) * 60000);
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    }
  } catch (e) {}
  return { dispatchedMonths: {}, lastDispatchedAt: null };
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {}
}

/**
 * Build rich Telegram summary text
 */
function buildMonthlyReportCaption(data, targetMonth) {
  const mStats = data.monthlyStats[targetMonth] || {
    trades: 0, wins: 0, losses: 0, winSum: 0, lossSum: 0, netPnl: 0, startBalance: 10000, endBalance: data.endingBalance
  };

  const mWr = mStats.trades > 0 ? ((mStats.wins / mStats.trades) * 100).toFixed(1) : '0.0';
  const mReturn = mStats.startBalance > 0 ? ((mStats.netPnl / mStats.startBalance) * 100).toFixed(2) : '0.00';
  const roiPct = ((data.netProfit / 10000.0) * 100).toFixed(2);

  // Top 3 Strategies in this month (or overall)
  const sortedStrats = Object.values(data.strategyStats).sort((a, b) => b.netPnl - a.netPnl);
  const top3 = sortedStrats.slice(0, 3);
  let topStratsText = '';
  top3.forEach((s, idx) => {
    const icon = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
    const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0.0';
    topStratsText += `\n${icon} <b>${s.name}</b>\n   ↳ PnL: <b>+$${s.netPnl.toFixed(2)}</b> | ${s.trades} trades | WR ${wr}%`;
  });

  const monthParts = targetMonth.split('-');
  const displayMonth = `${monthParts[1]}/${monthParts[0]}`;

  return `📊 <b>BÁO CÁO TỔNG KẾT GIAO DỊCH CUỐI THÁNG — HYPERVIEW</b>\n` +
    `🗓️ <b>Kỳ Báo Cáo:</b> Tháng ${displayMonth} (Chốt 23:59:59 UTC+7)\n\n` +
    `💰 <b>TỔNG QUAN TÀI KHOẢN TOÀN KỲ:</b>\n` +
    `• Vốn ban đầu: <b>$10,000.00</b>\n` +
    `• Vốn hiện tại: <b>$${data.endingBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}</b>\n` +
    `• Lợi nhuận lũy kế: <b>+$${data.netProfit.toLocaleString('en-US', { minimumFractionDigits: 2 })} (+${roiPct}% ROI)</b>\n` +
    `• Profit Factor (P.F.): <b>${data.profitFactor.toFixed(2)}</b>\n` +
    `• Win Rate toàn kỳ: <b>${data.winRate.toFixed(1)}%</b> (${data.wins}W / ${data.losses}L)\n` +
    `• Tỷ lệ Payoff: <b>${data.payoff.toFixed(2)} : 1</b> (+$${data.avgWin.toFixed(2)} / -$${data.avgLoss.toFixed(2)})\n\n` +
    `📅 <b>KẾT QUẢ THÁNG ${displayMonth}:</b>\n` +
    `• Lợi nhuận ròng tháng: <b>${mStats.netPnl >= 0 ? '+' : ''}$${mStats.netPnl.toFixed(2)} (${mStats.netPnl >= 0 ? '+' : ''}${mReturn}%)</b>\n` +
    `• Số lệnh thực hiện: <b>${mStats.trades} trades</b> (${mStats.wins} Thắng / ${mStats.losses} Thua — WR ${mWr}%)\n` +
    `• Tổng lãi chốt: <b>+$${mStats.winSum.toFixed(2)}</b> | Tổng lỗ: <b>-$${mStats.lossSum.toFixed(2)}</b>\n\n` +
    `🏆 <b>TOP CHIẾN LƯỢC ĐÓNG GÓP PNL:</b>${topStratsText}\n\n` +
    `📎 <i>Đính kèm file Excel (.xlsx) 2 Sheet hoàn chỉnh (Trang 1: Bảng tổng kết KPI, Hiệu suất theo tháng & Bảng thống kê chi tiết từng Strategy; Trang 2: Toàn bộ nhật ký 435 lệnh).</i>\n` +
    `<i>Báo cáo được tạo và gửi tự động vào 12h đêm cuối tháng bởi Hyperview Trading Engine.</i>`;
}

/**
 * Dispatch Monthly Report to Telegram
 */
async function dispatchMonthlyReport(targetMonth = null, forced = false) {
  const { token, chatId } = getTelegramConfig();
  if (!token || !chatId) {
    throw new Error('Telegram Bot Token or Chat ID missing in environment.');
  }

  const vnNow = getVietnamDate();
  if (!targetMonth) {
    const y = vnNow.getFullYear();
    const m = String(vnNow.getMonth() + 1).padStart(2, '0');
    targetMonth = `${y}-${m}`;
  }

  const history = loadHistory();
  if (!forced && history.dispatchedMonths && history.dispatchedMonths[targetMonth]) {
    console.log(`[MonthlyReportScheduler] ℹ️ Report for month ${targetMonth} already dispatched at ${history.dispatchedMonths[targetMonth].dispatchedAt}. Skipping.`);
    return { success: true, skipped: true, month: targetMonth };
  }

  console.log(`[MonthlyReportScheduler] 🚀 Generating monthly report for month ${targetMonth}...`);

  // 1. Sync latest simulations
  try {
    await syncDailySimulation();
  } catch (e) {}

  // 2. Generate updated Excel buffer
  const excelBuf = await generateFullJournalExcelBuffer();
  fs.writeFileSync(PUBLIC_XLSX_PATH, excelBuf);

  // 3. Load latest trade metrics
  const tradeData = loadAllTrades();

  // If target month has no trades yet, fallback to the latest month that has trades
  const availableMonths = Object.keys(tradeData.monthlyStats).sort();
  const effectiveMonth = tradeData.monthlyStats[targetMonth] ? targetMonth : (availableMonths[availableMonths.length - 1] || targetMonth);

  // 4. Construct Telegram caption
  const caption = buildMonthlyReportCaption(tradeData, effectiveMonth);

  // 5. Send Rich Report Message via sendMessage (supports 4096 chars)
  console.log(`[MonthlyReportScheduler] 📨 Sending executive summary message to Telegram...`);
  const msgResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: caption,
      parse_mode: 'HTML',
    }),
  });
  const msgResJson = await msgResponse.json();
  if (!msgResJson.ok) {
    console.warn(`[MonthlyReportScheduler] Warning sending text message: ${msgResJson.description}`);
  }

  // 6. Send Excel Document via sendDocument with concise caption
  const fileName = `Hyperview_Full_Trading_Journal_${effectiveMonth}.xlsx`;
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', `📊 <b>File Báo Cáo Chi Tiết:</b> <code>${fileName}</code> (Sheet 1: KPI & Strategy Stats, Sheet 2: 435 Lệnh)`);
  form.append('parse_mode', 'HTML');

  const blob = new Blob([excelBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  form.append('document', blob, fileName);

  console.log(`[MonthlyReportScheduler] 📤 Uploading ${fileName} to Telegram chat ${chatId}...`);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });

  const resJson = await response.json();
  if (!resJson.ok) {
    throw new Error(`Telegram API sendDocument error: ${resJson.description}`);
  }

  // 7. Update history
  if (!history.dispatchedMonths) history.dispatchedMonths = {};
  history.dispatchedMonths[targetMonth] = {
    dispatchedAt: new Date().toISOString(),
    messageId: resJson.result.message_id,
    fileName,
    endingBalance: tradeData.endingBalance,
    netProfit: tradeData.netProfit,
  };
  history.lastDispatchedAt = new Date().toISOString();
  saveHistory(history);

  console.log(`[MonthlyReportScheduler] ✅ Successfully dispatched monthly report to Telegram! (Msg ID: ${resJson.result.message_id})`);
  return {
    success: true,
    messageId: resJson.result.message_id,
    month: effectiveMonth,
    fileName,
    chatId,
  };
}

/**
 * Check if current time is around month-end midnight (23:55 on last day to 00:15 on 1st day)
 */
function isMonthEndMidnight() {
  const vnNow = getVietnamDate();
  const hours = vnNow.getHours();
  const mins = vnNow.getMinutes();
  const day = vnNow.getDate();

  // Tomorrow date
  const tomorrow = new Date(vnNow.getTime() + 24 * 60 * 60 * 1000);
  const isLastDay = tomorrow.getDate() === 1;

  // Window 1: Last day of month at 23:50 - 23:59
  if (isLastDay && hours === 23 && mins >= 50) {
    return true;
  }

  // Window 2: Day 1 of month at 00:00 - 00:20
  if (day === 1 && hours === 0 && mins <= 20) {
    return true;
  }

  return false;
}

let schedulerInterval = null;

function startMonthlyReportScheduler() {
  console.log('[MonthlyReportScheduler] ⏰ Initializing Monthly Trading Report Scheduler...');

  // Check immediately on startup
  setTimeout(async () => {
    try {
      const vnNow = getVietnamDate();
      const tomorrow = new Date(vnNow.getTime() + 24 * 60 * 60 * 1000);
      const isLastDay = tomorrow.getDate() === 1;

      // Determine the target month to check
      const y = vnNow.getFullYear();
      const m = String(vnNow.getMonth() + 1).padStart(2, '0');
      const curMonthKey = `${y}-${m}`;

      // If today is day 1, check the month that just ended
      let monthToCheck = curMonthKey;
      if (vnNow.getDate() === 1) {
        const prevMonthDate = new Date(vnNow.getTime() - 24 * 60 * 60 * 1000);
        const py = prevMonthDate.getFullYear();
        const pm = String(prevMonthDate.getMonth() + 1).padStart(2, '0');
        monthToCheck = `${py}-${pm}`;
      }

      if (isMonthEndMidnight()) {
        console.log(`[MonthlyReportScheduler] 🌙 Month-end window detected. Checking dispatch for ${monthToCheck}...`);
        await dispatchMonthlyReport(monthToCheck, false);
      }
    } catch (e) {
      console.error('[MonthlyReportScheduler] Startup check error:', e.message);
    }
  }, 5000);

  // Check every 15 minutes
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(async () => {
    try {
      if (isMonthEndMidnight()) {
        const vnNow = getVietnamDate();
        let targetMonth = `${vnNow.getFullYear()}-${String(vnNow.getMonth() + 1).padStart(2, '0')}`;
        if (vnNow.getDate() === 1) {
          const prevMonthDate = new Date(vnNow.getTime() - 24 * 60 * 60 * 1000);
          targetMonth = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
        }
        await dispatchMonthlyReport(targetMonth, false);
      }
    } catch (err) {
      console.error('[MonthlyReportScheduler] Scheduled check error:', err.message);
    }
  }, 15 * 60 * 1000);

  console.log('[MonthlyReportScheduler] 🚀 Scheduler active: Checks automatically for month-end midnight dispatch.');
}

module.exports = {
  dispatchMonthlyReport,
  startMonthlyReportScheduler,
  isMonthEndMidnight,
};

// CLI runner
if (require.main === module) {
  (async () => {
    const isSendNow = process.argv.includes('--send-now');
    if (isSendNow) {
      console.log('CLI trigger: Sending monthly report now...');
      try {
        const res = await dispatchMonthlyReport(null, true);
        console.log('Result:', res);
      } catch (err) {
        console.error('Failed:', err);
      }
    } else {
      startMonthlyReportScheduler();
    }
  })();
}
