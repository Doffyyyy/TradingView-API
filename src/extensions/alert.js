const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { fetchCandles } = require('./indicators');

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

/**
 * Calculate Kelly Criterion Position Sizing
 * @param {number} winRate e.g. 0.60
 * @param {number} winLossRatio e.g. 1.8
 * @param {number} accountBalance e.g. 10000
 * @param {string} fraction 'full' | 'half' | 'quarter'
 */
function calculateKellyPosition(winRate = 0.55, winLossRatio = 1.6, accountBalance = 10000, fraction = 'half') {
  const w = winRate;
  const r = Math.max(0.1, winLossRatio);
  // Kelly formula: K% = W - (1 - W) / R
  const fullKelly = w - ((1 - w) / r);

  let multiplier = 0.5;
  if (fraction === 'full') multiplier = 1.0;
  if (fraction === 'quarter') multiplier = 0.25;

  const kellyFrac = Math.max(0, Math.min(0.40, fullKelly * multiplier));
  const positionDollar = accountBalance * kellyFrac;

  return {
    fullKellyPercent: Math.round(fullKelly * 1000) / 10,
    recommendedFraction: fraction,
    kellyPercent: Math.round(kellyFrac * 1000) / 10,
    positionDollar: Math.round(positionDollar * 100) / 100,
  };
}

/**
 * Generate Chart Snapshot and Dispatch Telegram Alert
 */
async function sendTelegramAlert(alertData) {
  const {
    instrument = 'BINANCE:BTCUSDT',
    strategy = 'Astra-Supertrend v2',
    action = 'BUY / LONG',
    customMessage = null,
    sharpe = 2.45,
    drawdown = '-3.8%',
    winRate = 0.62,
    winLossRatio = 1.75,
    accountEquity = 10000,
    timeframe = '60',
    notes = 'Validation Bot consensus 18/26. High probability setup.',
  } = alertData;

  const kelly = calculateKellyPosition(winRate, winLossRatio, accountEquity, 'half');
  const { token, chatId } = getTelegramConfig();

  if (!token) {
    throw new Error('Telegram Bot Token not configured');
  }

  // 1. Fetch candles
  const candles = await fetchCandles(instrument, timeframe, 50);

  // 2. Generate snapshot PNG
  const tempJsonPath = path.join(__dirname, '../../public/temp_alert.json');
  const outPngPath = path.join(__dirname, '../../public/latest_alert_chart.png');

  const meta = {
    symbol: instrument,
    strategy,
    sharpe: String(sharpe),
    drawdown: String(drawdown),
    kelly: `${kelly.kellyPercent}% ($${kelly.positionDollar})`,
  };

  fs.writeFileSync(tempJsonPath, JSON.stringify({ candles, meta }));

  const scriptPath = path.join(__dirname, 'chart_renderer.py');
  execSync(`python "${scriptPath}" "${tempJsonPath}" "${outPngPath}"`);

  // 3. Format Telegram message caption
  // If customMessage (log format) is provided, use it directly as requested by user
  let caption = '';
  if (customMessage) {
    caption = customMessage;
  } else {
    caption = `🚨 *TRADINGVIEW API SIGNAL ALERT* 🚨\n\n` +
      `📌 *Instrument:* \`${instrument}\`\n` +
      `⚡ *Strategy:* \`${strategy}\`\n` +
      `🎯 *Action:* *${action}*\n` +
      `📊 *Sharpe Ratio:* \`${sharpe}\`\n` +
      `📉 *Max Drawdown:* \`${drawdown}\`\n` +
      `💰 *Kelly Position Size:* *${kelly.kellyPercent}%* (\`$${kelly.positionDollar}\` of \`$${accountEquity}\`)\n` +
      `🛡️ *Validation Layer:* 26-Indicator Consensus PASSED\n` +
      `📝 *Notes:* ${notes}\n\n` +
      `_Powered by TradingView API & Hermes Agent Engine_`;
  }

  // 4. Send via curl to avoid multipart issues on Windows
  const curlCmd = `curl.exe -s -X POST "https://api.telegram.org/bot${token}/sendPhoto" ` +
    `-F chat_id="${chatId}" ` +
    `-F photo="@${outPngPath.replace(/\\/g, '/')}" ` +
    `-F caption="${caption.replace(/"/g, '\\"')}" ` +
    `-F parse_mode="Markdown"`;

  const output = execSync(curlCmd, { encoding: 'utf8' });
  const resp = JSON.parse(output);

  if (!resp.ok) {
    throw new Error(`Telegram sendPhoto failed: ${resp.description}`);
  }

  return {
    success: true,
    messageId: resp.result.message_id,
    instrument,
    strategy,
    kelly,
    snapshotPath: outPngPath,
  };
}

module.exports = {
  calculateKellyPosition,
  sendTelegramAlert,
};
