const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const TradingView = require('./main');

const { computeAllIndicators } = require('./src/extensions/indicators');
const { validateSymbol } = require('./src/extensions/validation');
const { runBacktest } = require('./src/extensions/backtest');
const { runHistoricalReplay } = require('./src/extensions/replay');
const { sendTelegramAlert } = require('./src/extensions/alert');
const { hubInstance } = require('./src/extensions/agentHub');
const { paperTraderInstance } = require('./src/extensions/paperTrader');

const PORT = process.env.PORT || 8095;
const PUBLIC_DIR = path.join(__dirname, 'public');

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { resolve({}); }
    });
  });
}

function getHistory(symbol, timeframe) {
  return new Promise((resolve, reject) => {
    const client = new TradingView.Client();
    const chart = new client.Session.Chart();
    let timer = setTimeout(() => {
      try { chart.delete(); client.end(); } catch (e) {}
      reject(new Error('Timeout fetching history'));
    }, 6000);

    chart.setMarket(symbol, { timeframe });
    chart.onError((...err) => {
      clearTimeout(timer);
      try { chart.delete(); client.end(); } catch (e) {}
      reject(new Error(err.join(' ')));
    });
    chart.onUpdate(() => {
      if (chart.periods && chart.periods.length > 0) {
        clearTimeout(timer);
        const candles = chart.periods.slice().reverse().map(p => ({
          time: p.time,
          open: p.open,
          high: p.max,
          low: p.min,
          close: p.close,
          volume: p.volume || 0,
        }));
        const infos = chart.infos || {};
        try { chart.delete(); client.end(); } catch (e) {}
        resolve({ candles, infos });
      }
    });
  });
}

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TradingView Pro Suite</title>
  <script src="/public/lightweight-charts.js"></script>
  <style>
    :root {
      --bg-primary: #0f1117;
      --bg-secondary: #181b24;
      --bg-tertiary: #222634;
      --text-primary: #f0f3f6;
      --text-secondary: #8c93a3;
      --border-color: #2b3040;
      --accent-green: #26a69a;
      --accent-red: #ef5350;
      --accent-blue: #2962ff;
      --accent-yellow: #f59e0b;
      --accent-purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background-color: var(--bg-primary); color: var(--text-primary); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

    header {
      background-color: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      padding: 8px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .brand-section { display: flex; align-items: center; gap: 10px; }
    .badge {
      display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px;
      background: rgba(38, 166, 154, 0.15); color: var(--accent-green);
      border-radius: 999px; font-size: 11px; font-weight: 600;
    }
    .badge-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-green); box-shadow: 0 0 8px var(--accent-green); animation: pulse 1.8s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }

    .nav-tabs { display: flex; gap: 4px; }
    .tab-btn {
      background: transparent; color: var(--text-secondary); border: 1px solid transparent;
      padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s;
    }
    .tab-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }
    .tab-btn.active { background: var(--accent-blue); color: #fff; }

    .content-area { flex: 1; position: relative; overflow: hidden; }
    .view-panel { width: 100%; height: 100%; display: none; flex-direction: column; }
    .view-panel.active { display: flex; }

    .controls-bar {
      background-color: var(--bg-secondary); border-bottom: 1px solid var(--border-color);
      padding: 8px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    }
    .preset-group, .tf-group { display: flex; gap: 4px; }
    .btn {
      background: var(--bg-tertiary); color: var(--text-secondary); border: 1px solid transparent;
      padding: 5px 10px; border-radius: 5px; font-size: 12px; font-weight: 500; cursor: pointer;
    }
    .btn:hover { color: var(--text-primary); border-color: var(--border-color); }
    .btn.active { background: var(--accent-blue); color: #fff; font-weight: 600; }

    .search-input {
      background: var(--bg-tertiary); border: 1px solid var(--border-color);
      color: var(--text-primary); padding: 5px 10px; border-radius: 5px; font-size: 12px; outline: none; width: 180px;
    }

    #chart-container { flex: 1; width: 100%; position: relative; }
    .legend-overlay {
      position: absolute; top: 12px; left: 16px; z-index: 10; pointer-events: none;
      font-size: 12px; line-height: 1.5; background: rgba(15, 17, 23, 0.7); backdrop-filter: blur(4px);
      padding: 4px 8px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05);
    }
    .legend-item { display: inline-block; margin-right: 12px; }
    .legend-label { color: var(--text-secondary); margin-right: 4px; }

    .panel-scroll { flex: 1; overflow-y: auto; padding: 20px; }
    .card {
      background: var(--bg-secondary); border: 1px solid var(--border-color);
      border-radius: 8px; padding: 16px; margin-bottom: 16px;
    }
    .card-title { font-size: 14px; font-weight: 700; color: var(--text-primary); margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }

    .stat-box { background: var(--bg-tertiary); padding: 12px; border-radius: 6px; }
    .stat-label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 4px; }
    .stat-value { font-size: 18px; font-weight: 700; color: var(--text-primary); }

    .val-green { color: var(--accent-green) !important; }
    .val-red { color: var(--accent-red) !important; }
    .val-yellow { color: var(--accent-yellow) !important; }

    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; padding: 8px; background: var(--bg-tertiary); color: var(--text-secondary); }
    td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }

    .action-badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
    .action-buy { background: rgba(38, 166, 154, 0.2); color: var(--accent-green); }
    .action-sell { background: rgba(239, 83, 80, 0.2); color: var(--accent-red); }
    .action-neutral { background: rgba(140, 147, 163, 0.2); color: var(--text-secondary); }

    footer {
      height: 30px; background: var(--bg-secondary); border-top: 1px solid var(--border-color);
      display: flex; align-items: center; justify-content: space-between; padding: 0 16px; font-size: 11px; color: var(--text-secondary);
    }
  </style>
</head>
<body>
  <header>
    <div class="brand-section">
      <div class="badge"><span class="badge-dot"></span><span>LIVE ENGINE</span></div>
      <strong style="font-size: 14px;">TradingView Pro Suite</strong>
    </div>
    <div class="nav-tabs" id="main-nav">
      <button class="tab-btn active" data-target="view-chart">📈 Live Chart</button>
      <button class="tab-btn" data-target="view-paper" style="background: rgba(38, 166, 154, 0.15); color: #4ade80; border: 1px solid #26a69a;">💼 Paper Trade ($10k)</button>
      <button class="tab-btn" data-target="view-validation">🛡️ Validation Bot (26 TA)</button>
      <button class="tab-btn" data-target="view-backtest">🧪 Astra Backtest</button>
      <button class="tab-btn" data-target="view-replay">⏪ Replay Engine</button>
      <button class="tab-btn" data-target="view-hub">🤖 300-Agent Hub</button>
      <button class="tab-btn" data-target="view-alert">🔔 Telegram & Kelly</button>
    </div>
  </header>

  <div class="content-area">
    <!-- VIEW 1: LIVE CHART -->
    <div class="view-panel active" id="view-chart">
      <div class="controls-bar">
        <div class="preset-group" id="presets">
          <button class="btn active" data-symbol="BINANCE:BTCUSDT">BTC/USDT</button>
          <button class="btn" data-symbol="BINANCE:ETHUSDT">ETH/USDT</button>
          <button class="btn" data-symbol="BINANCE:SOLUSDT">SOL/USDT</button>
          <button class="btn" data-symbol="BYBIT:HYPEUSDT">HYPE/USDT</button>
          <button class="btn" data-symbol="NASDAQ:AAPL">AAPL</button>
        </div>
        <div class="tf-group" id="timeframes">
          <button class="btn" data-tf="1">1m</button>
          <button class="btn" data-tf="5">5m</button>
          <button class="btn" data-tf="15">15m</button>
          <button class="btn" data-tf="60">1h</button>
          <button class="btn active" data-tf="D">1D</button>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="btn active" id="btn-toggle-fibo" style="background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid #a855f7;">🎯 FiboRadar: ON</button>
          <select id="select-fibo-period" class="btn" style="outline: none;">
            <option value="200" selected>200 bars</option>
            <option value="100">100 bars</option>
            <option value="50">50 bars</option>
          </select>
          <button class="btn" id="btn-fit-focus" title="Auto-scale and focus price/time">⛶ Fit Focus</button>
        </div>
      </div>
      <div id="chart-container">
        <div class="legend-overlay">
          <span class="legend-item"><span class="legend-label">O:</span><span id="leg-open">--</span></span>
          <span class="legend-item"><span class="legend-label">H:</span><span id="leg-high">--</span></span>
          <span class="legend-item"><span class="legend-label">L:</span><span id="leg-low">--</span></span>
          <span class="legend-item"><span class="legend-label">C:</span><span id="leg-close">--</span></span>
        </div>
        <div id="fiboradar-hud" style="position: absolute; top: 12px; right: 16px; z-index: 10; background: rgba(15, 17, 23, 0.88); backdrop-filter: blur(6px); border: 1px solid #a855f7; border-radius: 6px; padding: 8px 12px; font-size: 11px; width: 230px; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 700; color: #c084fc;">🎯 FiboRadar [Mr_Rakun]</span>
            <span id="fibo-swing-badge" style="font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: rgba(74, 222, 128, 0.2); color: #4ade80;">BULL</span>
          </div>
          <div style="margin-bottom: 6px; font-size: 10px; color: var(--text-secondary);">
            Zone: <strong id="fibo-current-zone" style="color: #fbbf24;">--</strong>
          </div>
          <div id="fibo-levels-list" style="display: flex; flex-direction: column; gap: 2px;"></div>
        </div>
      </div>
    </div>

    <!-- VIEW PAPER TRADE ($10K) -->
    <div class="view-panel" id="view-paper">
      <div class="controls-bar">
        <div style="display: flex; gap: 8px; align-items: center;">
          <button class="btn active" id="btn-toggle-auto-trade" style="background: #22c55e; color: #fff; font-weight: 700;">🟢 Auto-Trade: ACTIVE</button>
          <button class="btn" id="btn-paper-refresh">🔄 Refresh Status</button>
          <button class="btn" id="btn-paper-close-all" style="background: rgba(239, 83, 80, 0.15); color: #ef5350;">Close All Positions</button>
          <button class="btn" id="btn-paper-reset" style="background: rgba(140, 147, 163, 0.15);">Reset $10k Fund</button>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 11px; color: var(--text-secondary);">Daily Target: <strong>$50 - $100 / day</strong></span>
          <span id="paper-engine-status" style="font-size: 12px; color: var(--accent-green);">● Auto-Engine Running</span>
        </div>
      </div>
      <div class="panel-scroll">
        <!-- Summary Cards -->
        <div class="grid-4" style="margin-bottom: 16px;">
          <div class="stat-box">
            <div class="stat-label">Total Account Equity</div>
            <div class="stat-value" id="paper-equity">$10,000.00</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Available Cash</div>
            <div class="stat-value" id="paper-cash">$10,000.00</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Today Realized PnL</div>
            <div class="stat-value" id="paper-daily-pnl">$0.00</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Win Rate / Trades</div>
            <div class="stat-value" id="paper-winrate">0% (0)</div>
          </div>
        </div>

        <!-- Daily Target Progress Card -->
        <div class="card">
          <div class="card-title">
            <span>Daily Profit Target Progress ($50 - $100)</span>
            <span id="target-progress-text" style="color: #fbbf24; font-weight: 700;">0%</span>
          </div>
          <div style="width: 100%; height: 12px; background: var(--bg-tertiary); border-radius: 6px; overflow: hidden; margin-top: 4px;">
            <div id="target-progress-bar" style="height: 100%; width: 0%; background: linear-gradient(90deg, #26a69a, #4ade80, #fbbf24); transition: width 0.3s;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; margin-top: 6px; font-size: 10px; color: var(--text-secondary);">
            <span>$0.00</span>
            <span>$50.00 (Min Target)</span>
            <span>$100.00 (Max Target - Auto Lock)</span>
          </div>
        </div>

        <!-- Open Positions -->
        <div class="card">
          <div class="card-title">Active Paper Positions (Max 2 Concurrent)</div>
          <table id="table-paper-positions">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Entry</th>
                <th>Mark Price</th>
                <th>TP (+1.5%)</th>
                <th>SL (-0.8%)</th>
                <th>Notional</th>
                <th>Unrealized PnL</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="9" style="text-align: center; color: var(--text-secondary);">Scanning for high-confluence entry setups...</td></tr>
            </tbody>
          </table>
        </div>

        <!-- Recent Completed Trades -->
        <div class="grid-2">
          <div class="card">
            <div class="card-title">Completed Trades History</div>
            <table id="table-paper-trades">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Exit Price</th>
                  <th>Net PnL</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                <tr><td colspan="5" style="text-align: center; color: var(--text-secondary);">No completed trades yet today.</td></tr>
              </tbody>
            </table>
          </div>

          <!-- Activity Logs -->
          <div class="card">
            <div class="card-title">Strategy Execution Log</div>
            <div id="paper-logs-container" style="font-family: monospace; font-size: 11px; color: #a1a1aa; line-height: 1.6; max-height: 220px; overflow-y: auto;">
              <div>[PaperTrader] Engine initialized with $10,000.00 fund.</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- VIEW 2: VALIDATION BOT (26 TA) -->
    <div class="view-panel" id="view-validation">
      <div class="controls-bar">
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="text" id="val-sym-input" class="search-input" value="BINANCE:BTCUSDT">
          <button class="btn active" id="btn-run-validation">Run 26-TA Evaluation</button>
        </div>
        <span id="val-status" style="font-size: 12px; color: var(--accent-green);">Ready</span>
      </div>
      <div class="panel-scroll" id="val-panel-body">
        <div class="card">
          <div class="card-title"><span>Consensus Gate Verdict</span><span id="val-verdict-badge" class="action-badge action-neutral">PENDING</span></div>
          <div class="grid-4">
            <div class="stat-box"><div class="stat-label">Trade Gate</div><div class="stat-value" id="val-gate">--</div></div>
            <div class="stat-box"><div class="stat-label">Buy Votes</div><div class="stat-value val-green" id="val-buy">--</div></div>
            <div class="stat-box"><div class="stat-label">Neutral Votes</div><div class="stat-value" id="val-neutral">--</div></div>
            <div class="stat-box"><div class="stat-label">Sell Votes</div><div class="stat-value val-red" id="val-sell">--</div></div>
          </div>
          <p id="val-reason" style="margin-top: 12px; font-size: 13px; color: var(--text-secondary);"></p>
        </div>
        <div class="grid-2">
          <div class="card">
            <div class="card-title">Oscillators (11 Indicators)</div>
            <table id="table-osc"><thead><tr><th>Indicator</th><th>Value</th><th>Signal</th></tr></thead><tbody></tbody></table>
          </div>
          <div class="card">
            <div class="card-title">Moving Averages (15 Indicators)</div>
            <table id="table-ma"><thead><tr><th>Indicator</th><th>Value</th><th>Signal</th></tr></thead><tbody></tbody></table>
          </div>
        </div>
      </div>
    </div>

    <!-- VIEW 3: ASTRA BACKTEST -->
    <div class="view-panel" id="view-backtest">
      <div class="controls-bar">
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="text" id="bt-sym-input" class="search-input" value="BINANCE:BTCUSDT">
          <select id="bt-strat-select" class="btn" style="outline: none;">
            <option value="supertrend">Supertrend (10, 3)</option>
            <option value="emacross">EMA Cross (9 / 21)</option>
            <option value="rsi">RSI Mean-Reversion (14)</option>
          </select>
          <button class="btn active" id="btn-run-backtest">Ship & Test Hypothesis</button>
        </div>
        <span id="bt-status" style="font-size: 12px; color: var(--text-secondary);">Ready</span>
      </div>
      <div class="panel-scroll">
        <div class="card">
          <div class="card-title">Strategy Performance Summary</div>
          <div class="grid-4">
            <div class="stat-box"><div class="stat-label">Net Profit</div><div class="stat-value" id="bt-profit">--</div></div>
            <div class="stat-box"><div class="stat-label">Win Rate</div><div class="stat-value" id="bt-winrate">--</div></div>
            <div class="stat-box"><div class="stat-label">Sharpe Ratio</div><div class="stat-value" id="bt-sharpe">--</div></div>
            <div class="stat-box"><div class="stat-label">Max Drawdown</div><div class="stat-value" id="bt-drawdown">--</div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Recent Simulated Trades</div>
          <table id="table-trades">
            <thead><tr><th>Type</th><th>Entry Price</th><th>Exit Price</th><th>PnL %</th><th>PnL $</th><th>Capital After</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- VIEW 4: REPLAY ENGINE -->
    <div class="view-panel" id="view-replay">
      <div class="controls-bar">
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="text" id="rep-sym-input" class="search-input" value="BINANCE:BTCUSDT">
          <button class="btn active" id="btn-run-replay">Execute Bar-by-Bar Replay</button>
        </div>
        <span id="rep-status" style="font-size: 12px; color: var(--text-secondary);">Unlimited Free Mode</span>
      </div>
      <div class="panel-scroll">
        <div class="card">
          <div class="card-title">Replay Simulation Parameters</div>
          <div class="grid-3">
            <div class="stat-box"><div class="stat-label">Mode</div><div class="stat-value" style="font-size: 14px;">BAR_BY_BAR_WALKFORWARD</div></div>
            <div class="stat-box"><div class="stat-label">Total Bars Processed</div><div class="stat-value" id="rep-bars">--</div></div>
            <div class="stat-box"><div class="stat-label">Stress-Test Profit</div><div class="stat-value" id="rep-profit">--</div></div>
          </div>
          <p id="rep-dates" style="margin-top: 12px; font-size: 12px; color: var(--text-secondary);"></p>
        </div>
      </div>
    </div>

    <!-- VIEW 5: 300-AGENT HUB -->
    <div class="view-panel" id="view-hub">
      <div class="controls-bar">
        <div style="display: flex; gap: 8px;">
          <button class="btn active" id="btn-hub-simulate">Simulate 300 Agents Feed</button>
          <button class="btn" id="btn-hub-refresh">Refresh Hub Status</button>
        </div>
        <span id="hub-status-text" style="font-size: 12px; color: var(--accent-green);">Hub Online</span>
      </div>
      <div class="panel-scroll">
        <div class="card">
          <div class="card-title">Multiplexer Connection Pool (10x Signal Coverage)</div>
          <div class="grid-4">
            <div class="stat-box"><div class="stat-label">Active Monitoring Agents</div><div class="stat-value" id="hub-agents-count">0</div></div>
            <div class="stat-box"><div class="stat-label">Tracked Symbols</div><div class="stat-value" id="hub-symbols-count">0</div></div>
            <div class="stat-box"><div class="stat-label">Cached Feed Points</div><div class="stat-value" id="hub-cached-count">0</div></div>
            <div class="stat-box"><div class="stat-label">Cost to Run</div><div class="stat-value val-green">$0.00 (Pooled)</div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Sub-Agent Live Market Feeds</div>
          <table id="table-hub-feeds">
            <thead><tr><th>Symbol</th><th>Price</th><th>24h Change</th><th>RSI</th><th>MACD</th><th>Recommendation</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- VIEW 6: TELEGRAM ALERT & KELLY -->
    <div class="view-panel" id="view-alert">
      <div class="controls-bar">
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="text" id="alert-sym-input" class="search-input" value="BINANCE:BTCUSDT">
          <button class="btn active" id="btn-send-tg-alert">Dispatch Telegram Alert + Chart Snapshot</button>
        </div>
        <span id="alert-status" style="font-size: 12px; color: var(--text-secondary);">Target: chat_id 1561044995</span>
      </div>
      <div class="panel-scroll">
        <div class="card">
          <div class="card-title">Kelly Criterion Position Sizing Engine</div>
          <div class="grid-4">
            <div class="stat-box"><div class="stat-label">Win Rate Assumed</div><div class="stat-value">62.0%</div></div>
            <div class="stat-box"><div class="stat-label">Win/Loss Ratio</div><div class="stat-value">1.8 : 1</div></div>
            <div class="stat-box"><div class="stat-label">Recommended Kelly Size</div><div class="stat-value val-yellow">20.4% Equity</div></div>
            <div class="stat-box"><div class="stat-label">Max Risk Cap</div><div class="stat-value val-green">35% Capped</div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Latest Generated Chart Snapshot</div>
          <div id="alert-snapshot-preview" style="text-align: center; padding: 10px;">
            <img id="snapshot-img" src="/public/alert_chart.png" style="max-width: 100%; border-radius: 6px; border: 1px solid var(--border-color);">
          </div>
        </div>
      </div>
    </div>
  </div>

  <footer>
    <div>Engine: <strong>@mathieuc/tradingview</strong> (D:\\TradingView-API)</div>
    <div id="engine-status" style="color: var(--accent-green);">● All Services Operational</div>
  </footer>

  <script>
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const target = document.getElementById(btn.dataset.target);
        if (target) target.classList.add('active');
      });
    });

    let currentSymbol = 'BINANCE:BTCUSDT';
    let currentTimeframe = 'D';
    let eventSource = null;
    let lastLoadedCandle = null;
    let currentCandlesCache = [];

    let fiboEnabled = true;
    let fiboPeriod = 200;
    let fiboPriceLines = [];

    function clearFiboLines() {
      fiboPriceLines.forEach(l => {
        try { candleSeries.removePriceLine(l); } catch (e) {}
      });
      fiboPriceLines = [];
    }

    function updateFiboRadar(candles) {
      clearFiboLines();
      const hud = document.getElementById('fiboradar-hud');
      if (!fiboEnabled || !candles || candles.length < 5) {
        if (hud) hud.style.display = 'none';
        return;
      }
      if (hud) hud.style.display = 'block';

      const slice = candles.slice(-Math.min(candles.length, fiboPeriod));
      let highIdx = 0, lowIdx = 0;
      let maxH = -Infinity, minL = Infinity;
      for (let i = 0; i < slice.length; i++) {
        if (slice[i].high > maxH) { maxH = slice[i].high; highIdx = i; }
        if (slice[i].low < minL) { minL = slice[i].low; lowIdx = i; }
      }
      const diff = maxH - minL;
      if (diff <= 0) return;

      const isBull = highIdx >= lowIdx;
      const swingBadge = document.getElementById('fibo-swing-badge');
      if (swingBadge) {
        swingBadge.textContent = isBull ? 'BULL SWING' : 'BEAR SWING';
        swingBadge.style.color = isBull ? '#4ade80' : '#f87171';
        swingBadge.style.background = isBull ? 'rgba(74, 222, 128, 0.15)' : 'rgba(239, 83, 80, 0.15)';
      }

      const ratios = [
        { r: 0.000, label: '0.000', color: '#9ca3af' },
        { r: 0.236, label: '0.236', color: '#f87171' },
        { r: 0.382, label: '0.382', color: '#fb923c' },
        { r: 0.500, label: '0.500', color: '#4ade80' },
        { r: 0.618, label: '0.618', color: '#2dd4bf', isGolden: true },
        { r: 0.786, label: '0.786', color: '#60a5fa' },
        { r: 1.000, label: '1.000', color: '#9ca3af' },
      ];

      const levels = ratios.map(item => {
        const p = isBull ? (maxH - item.r * diff) : (minL + item.r * diff);
        return { ...item, price: p };
      });

      levels.forEach(lvl => {
        const line = candleSeries.createPriceLine({
          price: lvl.price,
          color: lvl.color,
          lineWidth: lvl.isGolden ? 2 : 1,
          lineStyle: lvl.isGolden ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'Fib ' + lvl.label,
        });
        fiboPriceLines.push(line);
      });

      const lastClose = candles[candles.length - 1].close;
      let zone = 'Outside Range';
      const sortedByPrice = [...levels].sort((a, b) => a.price - b.price);
      for (let i = 0; i < sortedByPrice.length - 1; i++) {
        if (lastClose >= sortedByPrice[i].price && lastClose <= sortedByPrice[i + 1].price) {
          const l1 = sortedByPrice[i].label;
          const l2 = sortedByPrice[i + 1].label;
          if ((l1 === '0.500' && l2 === '0.618') || (l1 === '0.618' && l2 === '0.500')) {
            zone = '⭐ Golden Pocket (0.500 - 0.618)';
          } else {
            zone = 'Zone ' + l1 + ' - ' + l2;
          }
          break;
        }
      }
      const zoneEl = document.getElementById('fibo-current-zone');
      if (zoneEl) zoneEl.textContent = zone;

      const listEl = document.getElementById('fibo-levels-list');
      if (listEl) {
        listEl.innerHTML = levels.map(l => {
          const diffPct = ((lastClose - l.price) / l.price * 100).toFixed(1);
          const isNear = Math.abs(lastClose - l.price) / l.price < 0.015;
          return \`
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 4px; border-radius: 3px; \${isNear ? 'background: rgba(168, 85, 247, 0.2); font-weight: 700;' : ''}">
              <span style="color: \${l.color};">\${l.label} \${l.isGolden ? '★' : ''}</span>
              <span style="font-family: monospace;">\${l.price.toFixed(2)}</span>
              <span style="font-size: 9px; color: var(--text-secondary);">\${diffPct > 0 ? '+' : ''}\${diffPct}%</span>
            </div>
          \`;
        }).join('');
      }
    }

    function setLegendOHLC(c) {
      if (!c) return;
      const oEl = document.getElementById('leg-open');
      const hEl = document.getElementById('leg-high');
      const lEl = document.getElementById('leg-low');
      const cEl = document.getElementById('leg-close');
      if (oEl && typeof c.open === 'number') oEl.textContent = c.open.toFixed(2);
      if (hEl && typeof c.high === 'number') hEl.textContent = c.high.toFixed(2);
      if (lEl && typeof c.low === 'number') lEl.textContent = c.low.toFixed(2);
      if (cEl && typeof c.close === 'number') {
        cEl.textContent = c.close.toFixed(2);
        cEl.className = c.close >= c.open ? 'val-green' : 'val-red';
      }
    }

    const chartContainer = document.getElementById('chart-container');
    const chart = LightweightCharts.createChart(chartContainer, {
      layout: { background: { color: '#0f1117' }, textColor: '#8c93a3' },
      grid: { vertLines: { color: '#1a1e2a' }, horzLines: { color: '#1a1e2a' } },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      timeScale: { borderColor: '#2b3040', timeVisible: true },
      rightPriceScale: { borderColor: '#2b3040', autoScale: true },
      handleScale: {
        axisDoubleClickReset: { time: true, price: true },
        axisPressedMouseMove: { time: true, price: true },
        mouseWheel: true,
        pinch: true,
      },
    });
    const candleSeries = chart.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350' });

    function resizeChart() {
      chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
    }
    window.addEventListener('resize', resizeChart);
    resizeChart();

    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time) {
        setLegendOHLC(lastLoadedCandle);
        return;
      }
      const candle = param.seriesData.get(candleSeries);
      if (candle) {
        setLegendOHLC(candle);
      }
    });

    async function loadChart(sym, tf) {
      if (eventSource) eventSource.close();
      clearFiboLines();
      try {
        chart.priceScale('right').applyOptions({ autoScale: true });
      } catch (e) {}
      const res = await fetch('/api/history?symbol=' + encodeURIComponent(sym) + '&timeframe=' + encodeURIComponent(tf));
      const data = await res.json();
      if (data.candles && data.candles.length > 0) {
        currentCandlesCache = data.candles;
        try {
          chart.priceScale('right').applyOptions({ autoScale: true });
        } catch (e) {}
        candleSeries.setData(data.candles);
        try {
          chart.priceScale('right').applyOptions({ autoScale: true });
          chart.timeScale().fitContent();
        } catch (e) {}
        lastLoadedCandle = data.candles[data.candles.length - 1];
        setLegendOHLC(lastLoadedCandle);
        updateFiboRadar(currentCandlesCache);
        setTimeout(() => {
          try {
            chart.priceScale('right').applyOptions({ autoScale: true });
            chart.timeScale().fitContent();
          } catch (e) {}
        }, 50);
      }
      eventSource = new EventSource('/api/stream?symbol=' + encodeURIComponent(sym) + '&timeframe=' + encodeURIComponent(tf));
      eventSource.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.candle) {
          lastLoadedCandle = d.candle;
          candleSeries.update(d.candle);
          setLegendOHLC(d.candle);
          if (currentCandlesCache.length > 0) {
            currentCandlesCache[currentCandlesCache.length - 1] = d.candle;
            updateFiboRadar(currentCandlesCache);
          }
        }
      };
    }
    loadChart(currentSymbol, currentTimeframe);

    const btnFitFocus = document.getElementById('btn-fit-focus');
    if (btnFitFocus) {
      btnFitFocus.addEventListener('click', () => {
        chart.priceScale('right').applyOptions({ autoScale: true });
        chart.timeScale().fitContent();
      });
    }

    // FiboRadar Controls
    const btnToggleFibo = document.getElementById('btn-toggle-fibo');
    if (btnToggleFibo) {
      btnToggleFibo.addEventListener('click', () => {
        fiboEnabled = !fiboEnabled;
        btnToggleFibo.textContent = fiboEnabled ? '🎯 FiboRadar: ON' : '🎯 FiboRadar: OFF';
        btnToggleFibo.style.background = fiboEnabled ? 'rgba(168, 85, 247, 0.2)' : 'var(--bg-tertiary)';
        btnToggleFibo.style.color = fiboEnabled ? '#c084fc' : 'var(--text-secondary)';
        btnToggleFibo.style.borderColor = fiboEnabled ? '#a855f7' : 'transparent';
        updateFiboRadar(currentCandlesCache);
      });
    }

    const selectFiboPeriod = document.getElementById('select-fibo-period');
    if (selectFiboPeriod) {
      selectFiboPeriod.addEventListener('change', () => {
        fiboPeriod = parseInt(selectFiboPeriod.value, 10) || 200;
        updateFiboRadar(currentCandlesCache);
      });
    }

    document.getElementById('presets').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      document.querySelectorAll('#presets button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSymbol = btn.dataset.symbol;
      loadChart(currentSymbol, currentTimeframe);
    });

    document.getElementById('timeframes').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      document.querySelectorAll('#timeframes button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTimeframe = btn.dataset.tf;
      loadChart(currentSymbol, currentTimeframe);
    });

    document.getElementById('btn-run-validation').addEventListener('click', async () => {
      const sym = document.getElementById('val-sym-input').value.trim();
      document.getElementById('val-status').textContent = 'Evaluating 26 indicators...';
      try {
        const res = await fetch('/api/validation?symbol=' + encodeURIComponent(sym));
        const data = await res.json();
        document.getElementById('val-verdict-badge').textContent = data.verdict;
        document.getElementById('val-gate').textContent = data.tradeGate;
        document.getElementById('val-gate').className = 'stat-value ' + (data.tradeGate === 'ALLOW_LONG' ? 'val-green' : data.tradeGate === 'ALLOW_SHORT' ? 'val-red' : 'val-yellow');
        document.getElementById('val-buy').textContent = data.consensus.buy;
        document.getElementById('val-neutral').textContent = data.consensus.neutral;
        document.getElementById('val-sell').textContent = data.consensus.sell;
        document.getElementById('val-reason').textContent = data.reason;

        const oscBody = document.querySelector('#table-osc tbody');
        oscBody.innerHTML = data.oscillators.details.map(d => \`
          <tr><td>\${d.name}</td><td>\${d.value}</td><td><span class="action-badge action-\${d.action.toLowerCase()}">\${d.action}</span></td></tr>
        \`).join('');

        const maBody = document.querySelector('#table-ma tbody');
        maBody.innerHTML = data.movingAverages.details.map(d => \`
          <tr><td>\${d.name}</td><td>\${d.value}</td><td><span class="action-badge action-\${d.action.toLowerCase()}">\${d.action}</span></td></tr>
        \`).join('');

        document.getElementById('val-status').textContent = 'Evaluation Complete';
      } catch (e) {
        document.getElementById('val-status').textContent = 'Error: ' + e.message;
      }
    });

    document.getElementById('btn-run-backtest').addEventListener('click', async () => {
      const sym = document.getElementById('bt-sym-input').value.trim();
      const strat = document.getElementById('bt-strat-select').value;
      document.getElementById('bt-status').textContent = 'Simulating on TradingView candles...';
      try {
        const res = await fetch('/api/backtest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: sym, timeframe: '60', strategy: { type: strat } })
        });
        const data = await res.json();
        document.getElementById('bt-profit').textContent = data.netProfitPercent + '%';
        document.getElementById('bt-profit').className = 'stat-value ' + (data.netProfitPercent >= 0 ? 'val-green' : 'val-red');
        document.getElementById('bt-winrate').textContent = data.metrics.winRate + '%';
        document.getElementById('bt-sharpe').textContent = data.metrics.sharpeRatio;
        document.getElementById('bt-drawdown').textContent = '-' + data.metrics.maxDrawdownPercent + '%';

        const trBody = document.querySelector('#table-trades tbody');
        trBody.innerHTML = data.trades.map(t => \`
          <tr>
            <td><span class="action-badge \${t.type === 'LONG' ? 'action-buy' : 'action-sell'}">\${t.type}</span></td>
            <td>\${t.entryPrice.toFixed(2)}</td><td>\${t.exitPrice.toFixed(2)}</td>
            <td class="\${t.pnlPercent >= 0 ? 'val-green' : 'val-red'}">\${t.pnlPercent}%</td>
            <td class="\${t.pnlDollar >= 0 ? 'val-green' : 'val-red'}">$\${t.pnlDollar}</td>
            <td>$\${t.capitalAfter}</td>
          </tr>
        \`).join('');
        document.getElementById('bt-status').textContent = 'Completed in 0.4s';
      } catch (e) {
        document.getElementById('bt-status').textContent = 'Error: ' + e.message;
      }
    });

    document.getElementById('btn-run-replay').addEventListener('click', async () => {
      const sym = document.getElementById('rep-sym-input').value.trim();
      document.getElementById('rep-status').textContent = 'Executing bar-by-bar walkforward...';
      try {
        const res = await fetch('/api/replay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: sym, timeframe: '60', bars: 100 })
        });
        const data = await res.json();
        document.getElementById('rep-bars').textContent = data.playbackSummary.stepsProcessed;
        document.getElementById('rep-profit').textContent = data.stressTest.netProfitPercent + '%';
        document.getElementById('rep-profit').className = 'stat-value ' + (data.stressTest.netProfitPercent >= 0 ? 'val-green' : 'val-red');
        document.getElementById('rep-dates').textContent = 'Range: ' + data.startDate + ' to ' + data.endDate;
        document.getElementById('rep-status').textContent = 'Replay Stress Test Finished';
      } catch (e) {
        document.getElementById('rep-status').textContent = 'Error: ' + e.message;
      }
    });

    document.getElementById('btn-send-tg-alert').addEventListener('click', async () => {
      const sym = document.getElementById('alert-sym-input').value.trim();
      document.getElementById('alert-status').textContent = 'Rendering snapshot & sending to Telegram...';
      try {
        const res = await fetch('/api/alert/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instrument: sym,
            strategy: 'Astra-Supertrend Alpha',
            action: 'BUY / LONG',
            sharpe: 2.45,
            drawdown: '-3.8%',
            winRate: 0.62,
            winLossRatio: 1.8,
            accountEquity: 10000
          })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('alert-status').textContent = 'Alert sent! Telegram Msg ID: ' + data.messageId;
          document.getElementById('snapshot-img').src = '/public/latest_alert_chart.png?t=' + Date.now();
        } else {
          document.getElementById('alert-status').textContent = 'Failed: ' + data.error;
        }
      } catch (e) {
        document.getElementById('alert-status').textContent = 'Error: ' + e.message;
      }
    });

    document.getElementById('btn-hub-simulate').addEventListener('click', async () => {
      document.getElementById('hub-status-text').textContent = 'Registering 300 agents across crypto universe...';
      const symbols = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT', 'BYBIT:HYPEUSDT', 'BINANCE:DOGEUSDT', 'BINANCE:XRPUSDT', 'BINANCE:BNBUSDT', 'BINANCE:ADAUSDT', 'BINANCE:AVAXUSDT', 'BINANCE:LINKUSDT'];
      for (let i = 1; i <= 300; i++) {
        const sym = symbols[i % symbols.length];
        await fetch('/api/hub/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: 'sub-agent-' + i, symbols: [sym] })
        });
      }
      setTimeout(refreshHub, 1000);
    });

    async function refreshHub() {
      const res = await fetch('/api/hub/status');
      const data = await res.json();
      document.getElementById('hub-agents-count').textContent = data.activeAgents;
      document.getElementById('hub-symbols-count').textContent = data.trackedSymbols;
      document.getElementById('hub-cached-count').textContent = data.cachedSymbols;

      const pullRes = await fetch('/api/hub/pull?agentId=sub-agent-1');
      const pullData = await pullRes.json();
      const hubBody = document.querySelector('#table-hub-feeds tbody');
      hubBody.innerHTML = pullData.map(p => \`
        <tr>
          <td><strong>\${p.symbol}</strong></td>
          <td>$\${p.price || '--'}</td>
          <td class="\${(p.changePercent || 0) >= 0 ? 'val-green' : 'val-red'}">\${p.changePercent || 0}%</td>
          <td>\${p.rsi || '--'}</td>
          <td>\${p.macd || '--'}</td>
          <td><span class="action-badge \${(p.signal || '').includes('BUY') ? 'action-buy' : (p.signal || '').includes('SELL') ? 'action-sell' : 'action-neutral'}">\${p.signal || 'WAIT'}</span></td>
        </tr>
      \`).join('');
      document.getElementById('hub-status-text').textContent = 'Hub Online - 300 Agents Streaming';
    }
    document.getElementById('btn-hub-refresh').addEventListener('click', refreshHub);

    // --- Paper Trader Client Logic ---
    async function refreshPaperStatus() {
      try {
        const res = await fetch('/api/paper/status');
        const data = await res.json();

        document.getElementById('paper-equity').textContent = '$' + data.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        document.getElementById('paper-cash').textContent = '$' + data.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        const pnlEl = document.getElementById('paper-daily-pnl');
        pnlEl.textContent = (data.dailyPnl >= 0 ? '+$' : '-$') + Math.abs(data.dailyPnl).toFixed(2);
        pnlEl.className = 'stat-value ' + (data.dailyPnl >= 0 ? 'val-green' : 'val-red');

        document.getElementById('paper-winrate').textContent = data.winRate + '% (' + data.totalTrades + ')';

        // Target progress
        document.getElementById('target-progress-text').textContent = data.dailyTargetProgressPercent + '% ($' + data.dailyPnl.toFixed(2) + ' / $100)';
        document.getElementById('target-progress-bar').style.width = Math.min(100, Math.max(0, data.dailyTargetProgressPercent)) + '%';

        // Auto trade button
        const btnToggle = document.getElementById('btn-toggle-auto-trade');
        if (data.autoTradeEnabled) {
          btnToggle.textContent = '🟢 Auto-Trade: ACTIVE';
          btnToggle.style.background = '#22c55e';
          document.getElementById('paper-engine-status').textContent = '● Auto-Engine Running';
          document.getElementById('paper-engine-status').style.color = 'var(--accent-green)';
        } else {
          btnToggle.textContent = '🔴 Auto-Trade: PAUSED';
          btnToggle.style.background = '#6b7280';
          document.getElementById('paper-engine-status').textContent = '● Auto-Engine Paused';
          document.getElementById('paper-engine-status').style.color = '#ef5350';
        }

        // Open positions table
        const posBody = document.querySelector('#table-paper-positions tbody');
        if (!data.openPositions || data.openPositions.length === 0) {
          posBody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-secondary); padding: 16px;">No open positions. Monitoring market for next high-confluence entry...</td></tr>';
        } else {
          posBody.innerHTML = data.openPositions.map(p => \`
            <tr>
              <td><strong>\${p.symbol}</strong></td>
              <td><span class="action-badge \${p.side === 'LONG' ? 'action-buy' : 'action-sell'}">\${p.side}</span></td>
              <td>$\${p.entryPrice.toFixed(2)}</td>
              <td>$\${(p.currentPrice || p.entryPrice).toFixed(2)}</td>
              <td class="val-green">$\${p.takeProfit.toFixed(2)}</td>
              <td class="val-red">$\${p.stopLoss.toFixed(2)}</td>
              <td>$\${p.notional}</td>
              <td class="\${p.unrealizedPnl >= 0 ? 'val-green' : 'val-red'}">
                \${p.unrealizedPnl >= 0 ? '+' : ''}$\${p.unrealizedPnl} (\${p.unrealizedPnlPercent}%)
              </td>
              <td>
                <button class="btn" onclick="closePaperPosition('\${p.id}')" style="padding: 2px 8px; font-size: 11px; background: rgba(239, 83, 80, 0.2); color: #ef5350;">Close</button>
              </td>
            </tr>
          \`).join('');
        }

        // Recent trades table
        const tradesBody = document.querySelector('#table-paper-trades tbody');
        if (!data.recentTrades || data.recentTrades.length === 0) {
          tradesBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 12px;">No closed trades yet today.</td></tr>';
        } else {
          tradesBody.innerHTML = data.recentTrades.map(t => \`
            <tr>
              <td><strong>\${t.symbol}</strong></td>
              <td><span class="action-badge \${t.side === 'LONG' ? 'action-buy' : 'action-sell'}">\${t.side}</span></td>
              <td>$\${t.exitPrice.toFixed(2)}</td>
              <td class="\${t.pnl >= 0 ? 'val-green' : 'val-red'}">\${t.pnl >= 0 ? '+' : ''}$\${t.pnl} (\${t.pnlPercent}%)</td>
              <td style="font-size: 11px; color: var(--text-secondary);">\${t.reason}</td>
            </tr>
          \`).join('');
        }

        // Logs
        const logsContainer = document.getElementById('paper-logs-container');
        if (data.logs && data.logs.length > 0) {
          logsContainer.innerHTML = data.logs.map(l => \`<div>\${l}</div>\`).join('');
        }
      } catch (e) {
        console.error('Error refreshing paper status:', e);
      }
    }

    window.closePaperPosition = async function(id) {
      await fetch('/api/paper/close-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId: id })
      });
      refreshPaperStatus();
    };

    document.getElementById('btn-toggle-auto-trade').addEventListener('click', async () => {
      await fetch('/api/paper/toggle', { method: 'POST' });
      refreshPaperStatus();
    });

    document.getElementById('btn-paper-refresh').addEventListener('click', refreshPaperStatus);

    document.getElementById('btn-paper-close-all').addEventListener('click', async () => {
      if (confirm('Close all active paper positions at current market prices?')) {
        await fetch('/api/paper/close-all', { method: 'POST' });
        refreshPaperStatus();
      }
    });

    document.getElementById('btn-paper-reset').addEventListener('click', async () => {
      if (confirm('Reset paper account fund back to $10,000.00?')) {
        await fetch('/api/paper/reset', { method: 'POST' });
        refreshPaperStatus();
      }
    });

    // Auto-poll paper trader status every 3 seconds
    setInterval(refreshPaperStatus, 3000);
    refreshPaperStatus();
  </script>
</body>
</html>
`;

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(htmlContent);
  }

  if (pathname.startsWith('/public/')) {
    const filename = path.basename(pathname);
    const filePath = path.join(PUBLIC_DIR, filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mime = ext === '.js' ? 'application/javascript' : ext === '.png' ? 'image/png' : 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      return fs.createReadStream(filePath).pipe(res);
    }
    res.writeHead(404);
    return res.end('Not found');
  }

  if (pathname === '/api/history') {
    const symbol = parsedUrl.query.symbol || 'BINANCE:BTCUSDT';
    const timeframe = parsedUrl.query.timeframe || '1';
    try {
      const result = await getHistory(symbol, timeframe);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/stream') {
    const symbol = parsedUrl.query.symbol || 'BINANCE:BTCUSDT';
    const timeframe = parsedUrl.query.timeframe || '1';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const client = new TradingView.Client();
    const chart = new client.Session.Chart();
    chart.setMarket(symbol, { timeframe });
    chart.onUpdate(() => {
      if (!chart.periods || chart.periods.length === 0) return;
      const latest = chart.periods[0];
      res.write('data: ' + JSON.stringify({
        type: 'candle',
        candle: { time: latest.time, open: latest.open, high: latest.max, low: latest.min, close: latest.close, volume: latest.volume || 0 },
        infos: chart.infos || {},
      }) + '\\n\\n');
    });
    req.on('close', () => {
      try { chart.delete(); client.end(); } catch (e) {}
    });
    return;
  }

  if (pathname === '/api/indicators') {
    const body = await parseBody(req);
    const symbol = body.symbol || parsedUrl.query.symbol || 'BINANCE:BTCUSDT';
    const timeframe = body.timeframe || parsedUrl.query.timeframe || '60';
    const indicators = body.indicators || ['RSI', 'MACD', 'Supertrend', 'Ichimoku'];
    try {
      const result = await computeAllIndicators(symbol, timeframe, indicators);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/validation') {
    const symbol = parsedUrl.query.symbol || (await parseBody(req)).symbol || 'BINANCE:BTCUSDT';
    try {
      const result = await validateSymbol(symbol);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/backtest') {
    const body = await parseBody(req);
    const symbol = body.symbol || 'BINANCE:BTCUSDT';
    const timeframe = body.timeframe || '60';
    const strategy = body.strategy || { type: 'supertrend' };
    try {
      const result = await runBacktest(symbol, timeframe, strategy);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/replay') {
    const body = await parseBody(req);
    const symbol = body.symbol || 'BINANCE:BTCUSDT';
    const timeframe = body.timeframe || '60';
    const bars = body.bars || 100;
    const strategy = body.strategy || { type: 'supertrend' };
    try {
      const result = await runHistoricalReplay(symbol, timeframe, bars, strategy);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/alert/telegram') {
    const body = await parseBody(req);
    try {
      const result = await sendTelegramAlert(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/hub/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(hubInstance.getStatus()));
  }

  if (pathname === '/api/hub/register') {
    const body = await parseBody(req);
    const result = hubInstance.registerAgent(body.agentId || 'agent-default', body.symbols || ['BINANCE:BTCUSDT']);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  if (pathname === '/api/hub/pull') {
    const agentId = parsedUrl.query.agentId || 'agent-default';
    const data = hubInstance.getAgentData(agentId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }

  // --- Paper Trader Endpoints ---
  if (pathname === '/api/paper/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(paperTraderInstance.getStatus()));
  }

  if (pathname === '/api/paper/toggle') {
    paperTraderInstance.portfolio.autoTradeEnabled = !paperTraderInstance.portfolio.autoTradeEnabled;
    paperTraderInstance.savePortfolio();
    paperTraderInstance.log(`Auto-trading switched to: ${paperTraderInstance.portfolio.autoTradeEnabled ? 'ACTIVE' : 'PAUSED'}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, autoTradeEnabled: paperTraderInstance.portfolio.autoTradeEnabled }));
  }

  if (pathname === '/api/paper/close-position') {
    const body = await parseBody(req);
    const pos = paperTraderInstance.portfolio.positions.find(p => p.id === body.positionId);
    if (pos) {
      const curr = paperTraderInstance.latestPrices[pos.symbol]?.price || pos.entryPrice;
      await paperTraderInstance.closePosition(pos.id, curr, 'Manual Close from Dashboard');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (pathname === '/api/paper/close-all') {
    for (const pos of [...paperTraderInstance.portfolio.positions]) {
      const curr = paperTraderInstance.latestPrices[pos.symbol]?.price || pos.entryPrice;
      await paperTraderInstance.closePosition(pos.id, curr, 'Manual Close All');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (pathname === '/api/paper/reset') {
    paperTraderInstance.resetAccount();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('TradingView Pro Suite server listening on http://localhost:' + PORT);
  // Auto-start paper trading engine
  paperTraderInstance.start();
});
