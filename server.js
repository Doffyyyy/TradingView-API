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
const { hyperliquidInstance, normalizeCoin } = require('./src/extensions/hyperliquid');

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

const serverHistoryCache = new Map();
const serverWatchlistPriceCache = {};
let lastWatchlistPriceUpdate = 0;

function getHistory(symbol, timeframe, range = 5000) {
  const cacheKey = symbol + ":" + timeframe + ":" + (range || 5000);
  const now = Date.now();
  const cached = serverHistoryCache.get(cacheKey);

  // Return instantly from in-memory cache if less than 20 seconds old
  if (cached && (now - cached.timestamp < 20000)) {
    return Promise.resolve(cached.data);
  }
  // If Meteora KLEDSOL or on-chain pair that TV doesn't have history for, fallback to GeckoTerminal
  if (symbol.includes('KLED') || symbol.includes('4SBYWY')) {
    return new Promise(async (resolve) => {
      try {
        const axios = require('axios');
        const tfParam = (timeframe === 'D' || timeframe === 'W' || timeframe === 'M') ? 'day' : 'hour';
        const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/4SBYWY5UuxybWuj8FwHdFXUN6mbtACrqbJwiZ9mXworP/ohlcv/${tfParam}?limit=1000`;
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
        const list = res.data?.data?.attributes?.ohlcv_list || [];
        if (list.length > 0) {
          const candles = list.slice().reverse().map(item => ({
            time: item[0],
            open: item[1],
            high: item[2],
            low: item[3],
            close: item[4],
            volume: item[5] || 0,
          }));
          const resData = { candles, infos: { name: 'KLEDAI / Wrapped SOL', description: 'Meteora Dynamic Pool' } };
          serverHistoryCache.set(cacheKey, { timestamp: Date.now(), data: resData });
          return resolve(resData);
        }
      } catch (err) {}
      resolve({ candles: [], infos: {} });
    });
  }

  return new Promise((resolve, reject) => {
    const client = new TradingView.Client();
    const chart = new client.Session.Chart();
    let timer = setTimeout(() => {
      try { chart.delete(); client.end(); } catch (e) {}
      reject(new Error('Timeout fetching history'));
    }, 8000);

    chart.setMarket(symbol, { timeframe, range: range || 5000 });
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
        const resData = { candles, infos };
        serverHistoryCache.set(cacheKey, { timestamp: Date.now(), data: resData });
        resolve(resData);
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

    /* Proliquid Watchlist Styles */
    .wl-col-header {
      display: grid;
      grid-template-columns: 92px 64px 50px 52px 24px;
      align-items: center;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border-color);
      font-size: 10.5px;
      font-weight: 600;
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.02);
      user-select: none;
      box-sizing: border-box;
      width: 100%;
      overflow: hidden;
    }
    .wl-col-header span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wl-col-header .text-right { text-align: right; }

    .wl-row {
      display: grid;
      grid-template-columns: 92px 64px 50px 52px 24px;
      align-items: center;
      padding: 6px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      cursor: grab;
      transition: background 0.12s, opacity 0.12s;
      position: relative;
      user-select: none;
      box-sizing: border-box;
      width: 100%;
    }
    .wl-row:active { cursor: grabbing; }
    .wl-row:hover { background: var(--bg-tertiary); }
    .wl-row.active {
      background: rgba(41, 98, 255, 0.15);
      border-left: 3px solid var(--accent-blue);
    }
    .wl-row.dragging {
      opacity: 0.35;
      background: rgba(41, 98, 255, 0.12);
      outline: 1px dashed var(--accent-blue);
    }
    .wl-row.drag-over-top {
      border-top: 2px solid #38bdf8 !important;
    }
    .wl-row.drag-over-bottom {
      border-bottom: 2px solid #38bdf8 !important;
    }
    .wl-left { display: flex; align-items: center; gap: 4px; overflow: hidden; min-width: 0; }
    .wl-grip {
      color: #4b5563; font-size: 11px; user-select: none; cursor: grab; padding: 0 1px;
      transition: color 0.1s; flex-shrink: 0;
    }
    .wl-row:hover .wl-grip { color: #9ca3af; }
    .wl-badge {
      width: 20px; height: 20px; border-radius: 50%;
      background: var(--bg-tertiary); border: 1px solid var(--border-color);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; overflow: hidden; position: relative;
    }
    .wl-badge img {
      width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block;
    }
    .wl-fallback {
      width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
      font-size: 8px; font-weight: 800; color: var(--text-primary); text-transform: uppercase;
    }
    .wl-info { display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
    .wl-sym { font-size: 10.5px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wl-ex { font-size: 8px; color: var(--text-secondary); text-transform: uppercase; }
    .wl-cell { font-family: monospace; font-size: 10.5px; font-weight: 600; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wl-cell-last { color: var(--text-primary); font-weight: 700; }
    .wl-del {
      opacity: 0; color: var(--text-secondary); cursor: pointer; padding: 1px 3px;
      border-radius: 3px; font-size: 10px; text-align: center; margin-left: 6px;
    }
    .wl-row:hover .wl-del { opacity: 0.7; }
    .wl-row .wl-del:hover { opacity: 1; color: var(--accent-red); background: rgba(239, 83, 80, 0.15); }

    #watchlist-sidebar {
      width: 315px; background: var(--bg-secondary); border-right: 1px solid var(--border-color);
      display: flex; flex-direction: column; height: 100%; flex-shrink: 0; z-index: 5;
      overflow: hidden; box-sizing: border-box;
    }
    #watchlist-list {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      scrollbar-width: thin; scrollbar-color: var(--border-color) transparent;
    }
    #watchlist-list::-webkit-scrollbar { width: 4px; }
    #watchlist-list::-webkit-scrollbar-track { background: transparent; }
    #watchlist-list::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 2px; }

    .search-sug-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04);
      font-size: 11px; transition: background 0.1s;
    }
    .search-sug-item:hover { background: var(--bg-tertiary); }
    .search-sug-item.active { background: rgba(41, 98, 255, 0.2); }

    /* Hyperliquid Two-Tier Market Header & Chart Toolbar */
    .hl-ticker-bar {
      display: flex; align-items: center;
      padding: 4px 14px; background: #0c0e12; border-bottom: 1px solid #1c2028;
      height: 40px; gap: 14px; overflow-x: auto; user-select: none; flex-shrink: 0;
    }
    .hl-ticker-bar::-webkit-scrollbar { height: 2px; }
    .hl-ticker-left {
      display: flex; align-items: center; gap: 8px; flex-shrink: 0;
    }
    .hl-drag-handle {
      color: #4a505e; font-size: 14px; cursor: grab; padding: 0 2px;
    }
    .hl-market-badge {
      display: flex; align-items: center; gap: 7px; padding: 3px 8px;
      background: #14171e; border: 1px solid #232834; border-radius: 4px;
    }
    .hl-badge-sub {
      font-size: 8px; font-weight: 700; color: #787b86; text-transform: uppercase; line-height: 1;
    }
    .hl-badge-title {
      font-size: 12.5px; font-weight: 800; color: #fff; line-height: 1.2; letter-spacing: 0.3px;
    }
    .hl-stat-group {
      display: flex; align-items: center; justify-content: center; gap: 20px;
      flex: 1; margin: 0 auto;
    }
    .hl-stat-item {
      display: flex; flex-direction: column; flex-shrink: 0;
    }
    .hl-stat-lbl {
      font-size: 8px; color: #787b86; font-weight: 700; text-transform: uppercase; letter-spacing: 0.2px; margin-bottom: 1px;
    }
    .hl-stat-val {
      font-size: 11px; font-weight: 800; color: #fff; font-family: monospace; line-height: 1.1;
    }
    .hl-vdiv {
      width: 1px; height: 16px; background: #232834; flex-shrink: 0;
    }

    /* Tier 2: Chart Toolbar */
    .hl-chart-toolbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 3px 12px; background: #11141a; border-bottom: 1px solid #1c2028;
      height: 32px; gap: 6px; font-size: 11.5px; user-select: none; flex-shrink: 0;
    }
    .hl-tb-left {
      display: flex; align-items: center; gap: 2px;
    }
    .hl-tf-btn {
      background: transparent; border: none; color: #8c93a3; font-size: 11.5px; font-weight: 600;
      padding: 2px 6px; border-radius: 3px; cursor: pointer; transition: all 0.1s;
    }
    .hl-tf-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.05); }
    .hl-tf-btn.active { color: #f7931a !important; font-weight: 800; }
    .hl-tool-btn {
      display: flex; align-items: center; gap: 4px; background: transparent; border: 1px solid transparent;
      color: #d1d4dc; font-size: 11.5px; font-weight: 600; padding: 2px 7px; border-radius: 4px; cursor: pointer;
    }
    .hl-tool-btn:hover { background: rgba(255, 255, 255, 0.05); color: #fff; }
    .hl-tool-btn.active { background: rgba(168, 85, 247, 0.2); color: #c084fc; border-color: #a855f7; }
    .hl-icon-btn {
      background: transparent; border: none; color: #8c93a3; font-size: 12px; padding: 3px 6px;
      border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .hl-icon-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.05); }

    /* Proliquid Trading Dock Styles - Modular Blocks */
    .dock-panel {
      width: 400px; background: #0c0e14; border-left: 1px solid #1a1e2b;
      display: flex; flex-direction: column; height: 100%; z-index: 5; flex-shrink: 0;
      overflow-y: auto; overflow-x: hidden; padding: 10px; gap: 10px;
    }
    .dock-panel::-webkit-scrollbar { width: 5px; }
    .dock-panel::-webkit-scrollbar-thumb { background: #262b3d; border-radius: 3px; }

    /* Top Dock Navigation Segment */
    .dock-segmented-bar {
      display: flex; background: #131722; border: 1px solid #222736; border-radius: 6px;
      padding: 2px; gap: 2px; flex-shrink: 0;
    }
    .dock-seg-btn {
      flex: 1; padding: 4px 6px; font-size: 10px; font-weight: 700; color: #8c93a3;
      background: transparent; border: none; border-radius: 4px; cursor: pointer;
      transition: all 0.15s; text-align: center; white-space: nowrap;
    }
    .dock-seg-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.05); }
    .dock-seg-btn.active { color: #fff; background: #2962ff; box-shadow: 0 1px 4px rgba(0,0,0,0.4); }

    /* Modular Dock Cards / Blocks */
    .dock-block {
      background: #11141c; border: 1px solid #1f2433; border-radius: 8px;
      padding: 10px 12px; display: flex; flex-direction: column; position: relative;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    .dock-block-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;
      padding-bottom: 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 11px; font-weight: 800; letter-spacing: 0.5px; color: #fff;
    }
    
    /* Account & Web3 Connect */
    .badge-paper {
      font-size: 8.5px; padding: 2px 6px; border-radius: 4px;
      background: rgba(34, 197, 94, 0.15); color: #4ade80; font-weight: 800; border: 1px solid rgba(34, 197, 94, 0.3);
    }
    .badge-hl-live {
      font-size: 8.5px; padding: 2px 6px; border-radius: 4px;
      background: rgba(56, 189, 248, 0.2); color: #38bdf8; font-weight: 800; border: 1px solid rgba(56, 189, 248, 0.4);
    }
    .btn-wallet-connect {
      display: flex; align-items: center; gap: 5px; padding: 4px 8px; font-size: 10px; font-weight: 700;
      background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; border: 1px solid #3b82f6;
      border-radius: 5px; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 6px rgba(37, 99, 235, 0.3);
    }
    .btn-wallet-connect:hover {
      background: linear-gradient(135deg, #3b82f6, #2563eb); transform: translateY(-1px);
    }
    .account-details-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 2px;
    }
    .acc-stat-box {
      background: #161a25; border: 1px solid #23293a; border-radius: 6px; padding: 6px 8px;
    }
    .acc-stat-lbl { font-size: 8.5px; color: #787f94; font-weight: 700; text-transform: uppercase; margin-bottom: 2px; }
    .acc-stat-val { font-size: 12px; font-weight: 800; color: #fff; font-family: monospace; }
    
    /* Screener Table */
    .scr-table { width: 100%; display: flex; flex-direction: column; }
    .scr-header-row, .scr-row {
      display: grid; grid-template-columns: 1.2fr 1fr 1fr; font-size: 11px; padding: 4px 0;
      align-items: center;
    }
    .scr-row {
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    }
    .scr-header-row {
      margin-bottom: 2px; padding-bottom: 5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .scr-col-th {
      text-align: right; font-size: 9.5px; color: #8c93a3; font-weight: 700; letter-spacing: 0.5px;
    }
    .scr-label { color: #8c93a3; font-size: 9.5px; font-weight: 600; text-transform: uppercase; }
    .scr-val { text-align: right; font-family: monospace; font-weight: 700; font-size: 11px; }
    
    /* Orderbook L2 */
    .ob-row { position: relative; display: flex; justify-content: space-between; padding: 2.5px 6px; font-size: 10px; cursor: pointer; transition: background 0.1s; }
    .ob-row:hover { background: rgba(255,255,255,0.07); }
    .ob-bg { position: absolute; top: 0; bottom: 0; right: 0; opacity: 0.22; pointer-events: none; z-index: 1; transition: width 0.15s; }
    .ob-bg-ask { background: #ef5350; }
    .ob-bg-bid { background: #26a69a; }
    .ob-cell { z-index: 2; text-align: right; font-family: monospace; }
    .ob-cell-price { z-index: 2; text-align: left; font-weight: 700; font-family: monospace; }
    .ob-spread-bar {
      padding: 5px 8px; margin: 4px 0; background: #161a25; border: 1px solid #23293a; border-radius: 5px;
      display: flex; justify-content: space-between; align-items: center; font-size: 9.5px;
    }
    .ob-ratio-bar {
      width: 100%; height: 4px; background: #ef5350; border-radius: 2px; overflow: hidden; margin-top: 2px;
      display: flex;
    }
    .ob-ratio-bid { background: #26a69a; height: 100%; }

    /* Execution Panel */
    .exec-input-group {
      background: #161a25; border: 1px solid #23293a; border-radius: 6px;
      padding: 5px 8px; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;
    }
    .exec-input-group:focus-within { border-color: var(--accent-blue); }
    .exec-input {
      background: transparent; border: none; color: #fff; font-family: monospace; font-size: 11.5px;
      font-weight: 700; outline: none; width: 100%;
    }
    .exec-slider {
      width: 100%; -webkit-appearance: none; height: 4px; border-radius: 2px;
      background: #1e2433; outline: none; margin: 6px 0;
    }
    .exec-slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none; width: 12px; height: 12px; border-radius: 50%;
      background: var(--accent-blue); cursor: pointer; box-shadow: 0 0 6px rgba(41, 98, 255, 0.6);
    }
    .pct-chips { display: flex; gap: 4px; margin-bottom: 6px; }
    .pct-chip {
      flex: 1; background: #161a25; border: 1px solid #23293a; color: var(--text-secondary);
      border-radius: 4px; font-size: 9px; font-weight: 700; padding: 3px 0; text-align: center; cursor: pointer;
      transition: all 0.15s;
    }
    .pct-chip:hover, .pct-chip.active { background: rgba(41, 98, 255, 0.2); color: #fff; border-color: var(--accent-blue); }
    .exec-btn {
      width: 100%; padding: 8px 10px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer;
      display: flex; flex-direction: column; align-items: center; justify-content: center; transition: all 0.15s;
    }
    .exec-btn-buy {
      background: rgba(38, 166, 154, 0.15); border: 1px solid #26a69a; color: #4ade80;
    }
    .exec-btn-buy:hover { background: #26a69a; color: #fff; box-shadow: 0 0 12px rgba(38, 166, 154, 0.4); }
    .exec-btn-sell {
      background: rgba(239, 83, 80, 0.15); border: 1px solid #ef5350; color: #f87171;
    }
    .exec-btn-sell:hover { background: #ef5350; color: #fff; box-shadow: 0 0 12px rgba(239, 83, 80, 0.4); }

    /* Web3 Wallet Modal */
    .web3-modal-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px); z-index: 1000; display: flex; align-items: center; justify-content: center;
    }
    .web3-modal-card {
      background: #11141c; border: 1px solid #283044; border-radius: 12px; width: 380px; max-width: 90vw;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.8); overflow: hidden; animation: modalFadeIn 0.2s ease-out;
    }
    @keyframes modalFadeIn {
      from { opacity: 0; transform: scale(0.96); }
      to { opacity: 1; transform: scale(1); }
    }
    .web3-wallet-option {
      display: flex; align-items: center; justify-content: space-between; padding: 12px 14px;
      border: 1px solid #222736; border-radius: 8px; margin-bottom: 8px; cursor: pointer;
      background: #161a24; transition: all 0.18s;
    }
    .web3-wallet-option:hover {
      background: #1d2331; border-color: #3b82f6; transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    /* ========================================================
       TRADESYNC JOURNALING DASHBOARD STYLES
       ======================================================== */
    .ts-dashboard {
      flex: 1; overflow-y: auto; background: #0c0d10; padding: 18px 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "JetBrains Mono", sans-serif;
      color: #e4e7eb; box-sizing: border-box;
    }
    .ts-dashboard::-webkit-scrollbar { width: 6px; }
    .ts-dashboard::-webkit-scrollbar-thumb { background: #262933; border-radius: 3px; }

    /* Top Navigation within Journal */
    .ts-top-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;
    }
    .ts-title-left {
      display: flex; align-items: center; gap: 10px;
    }
    .ts-title {
      font-size: 17px; font-weight: 700; color: #fff; letter-spacing: -0.2px; margin: 0;
    }
    .ts-top-right {
      display: flex; align-items: center; gap: 12px;
    }
    .ts-status-badge {
      display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
      background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3);
      font-size: 11px; font-weight: 600; color: #10b981;
    }
    .ts-status-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #10b981;
      box-shadow: 0 0 8px #10b981; animation: pulse 1.8s infinite;
    }
    .ts-icon-btn {
      background: #181a20; border: 1px solid #262a36; border-radius: 6px;
      color: #8c93a3; width: 28px; height: 28px; display: flex; align-items: center;
      justify-content: center; cursor: pointer; transition: all 0.15s; position: relative;
    }
    .ts-icon-btn:hover { background: #222634; color: #fff; border-color: #38bdf8; }
    .ts-notif-dot {
      position: absolute; top: -2px; right: -2px; width: 7px; height: 7px;
      border-radius: 50%; background: #ef4444; border: 1px solid #0c0d10;
    }

    /* Filter & Action Toolbars */
    .ts-toolbar {
      display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;
    }
    .ts-pill-group {
      display: inline-flex; background: #151820; border: 1px solid #232733; border-radius: 999px; padding: 2px;
    }
    .ts-pill-btn {
      padding: 5px 14px; border-radius: 999px; font-size: 11px; font-weight: 600; cursor: pointer;
      color: #8c93a3; background: transparent; border: none; transition: all 0.15s; display: flex; align-items: center; gap: 5px;
    }
    .ts-pill-btn.active {
      background: #fff; color: #0c0d10; box-shadow: 0 2px 8px rgba(0,0,0,0.3); font-weight: 700;
    }
    .ts-pill-btn:hover:not(.active) { color: #fff; }
    .ts-dropdowns {
      display: flex; gap: 8px; align-items: center;
    }
    .ts-select {
      background: #151820; border: 1px solid #232733; border-radius: 6px; color: #e4e7eb;
      font-size: 11px; font-weight: 600; padding: 6px 10px; cursor: pointer; outline: none;
    }
    .ts-select:hover { border-color: #3a4254; }

    .ts-subtabs {
      display: inline-flex; background: #151820; border: 1px solid #232733; border-radius: 6px; padding: 3px; gap: 2px;
    }
    .ts-subtab-btn {
      padding: 5px 12px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer;
      color: #8c93a3; background: transparent; border: none; transition: all 0.15s;
    }
    .ts-subtab-btn.active {
      background: #232733; color: #fff; font-weight: 700;
    }
    .ts-btn-outline {
      background: #151820; border: 1px solid #262a36; border-radius: 6px; color: #e4e7eb;
      font-size: 11px; font-weight: 600; padding: 6px 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.15s;
    }
    .ts-btn-outline:hover { background: #222634; border-color: #38bdf8; color: #fff; }
    .ts-btn-white {
      background: #fff; color: #0c0d10; border: none; border-radius: 6px; font-size: 11px; font-weight: 700;
      padding: 6px 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.15s;
    }
    .ts-btn-white:hover { background: #e2e8f0; }
    .ts-btn-primary {
      background: #38bdf8; color: #0c0d10; border: none; border-radius: 6px; font-size: 11px; font-weight: 700;
      padding: 6px 14px; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.15s;
    }
    .ts-btn-primary:hover { background: #7dd3fc; }
    .ts-badge-free {
      background: rgba(16, 185, 129, 0.2); color: #10b981; font-size: 9px; padding: 1px 5px; border-radius: 4px; font-weight: 800;
    }

    /* 5 KPI Summary Ribbon */
    .ts-kpi-grid {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 14px;
    }
    .ts-kpi-card {
      background: #14161d; border: 1px solid #202430; border-radius: 8px; padding: 12px 14px;
      display: flex; flex-direction: column; justify-content: space-between; min-height: 105px;
    }
    .ts-kpi-head {
      display: flex; justify-content: space-between; align-items: center; font-size: 10px;
      font-weight: 700; color: #8c93a3; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;
    }
    .ts-kpi-val {
      font-size: 22px; font-weight: 800; color: #fff; line-height: 1.1; margin-bottom: 2px;
      font-family: "JetBrains Mono", monospace;
    }
    .ts-kpi-val.green { color: #10b981; }
    .ts-kpi-val.red { color: #ef4444; }
    .ts-kpi-sub {
      font-size: 10px; color: #8c93a3; margin-bottom: 8px; font-weight: 500;
    }
    .ts-bar-dual {
      display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: #262a36; margin: 4px 0;
    }
    .ts-bar-dual-green { background: #10b981; }
    .ts-bar-dual-red { background: #ef4444; }
    .ts-kpi-split-foot {
      display: flex; justify-content: space-between; font-size: 9.5px; font-weight: 700; margin-top: 4px;
    }
    .ts-sub-bar-row {
      display: flex; justify-content: space-between; align-items: center; font-size: 10px; margin-top: 3px;
    }
    .ts-sub-bar-track {
      flex: 1; height: 4px; border-radius: 2px; background: #202430; margin: 0 6px; overflow: hidden;
    }

    /* 4 Performance & Sparkline Cards */
    .ts-perf-grid {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px;
    }
    .ts-perf-card {
      background: #14161d; border: 1px solid #202430; border-radius: 8px; padding: 12px 14px;
      display: flex; flex-direction: column; justify-content: space-between; height: 140px; position: relative; overflow: hidden;
    }
    .ts-perf-head {
      display: flex; justify-content: space-between; align-items: center; font-size: 10px;
      font-weight: 700; color: #8c93a3; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .ts-score-badge {
      background: #202430; padding: 2px 7px; border-radius: 999px; font-size: 9.5px; color: #fff; font-weight: 700;
    }
    .ts-perf-val {
      font-size: 20px; font-weight: 800; color: #10b981; font-family: "JetBrains Mono", monospace;
    }
    .ts-perf-val.red { color: #ef4444; }
    .ts-sparkline-svg {
      width: 100%; height: 60px; margin-top: auto;
    }

    /* Interactive Calendar View */
    .ts-calendar-card {
      background: #14161d; border: 1px solid #202430; border-radius: 10px; padding: 16px;
    }
    .ts-cal-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; padding-bottom: 12px;
      border-bottom: 1px solid #202430;
    }
    .ts-cal-brand {
      display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; color: #fff;
    }
    .ts-cal-nav {
      display: flex; align-items: center; gap: 12px;
    }
    .ts-cal-nav-btn {
      background: #1a1e28; border: 1px solid #292f3d; color: #8c93a3; width: 26px; height: 26px;
      border-radius: 5px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.15s;
    }
    .ts-cal-nav-btn:hover { background: #262c3a; color: #fff; border-color: #38bdf8; }
    .ts-cal-nav-title {
      font-size: 13px; font-weight: 800; color: #fff; min-width: 110px; text-align: center;
    }

    .ts-cal-grid {
      display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px;
    }
    .ts-cal-col-head {
      text-align: center; font-size: 11px; font-weight: 700; color: #717684; padding: 6px 0; text-transform: uppercase;
    }
    .ts-cal-col-head.weekly { color: #38bdf8; }
    .ts-cal-cell {
      background: #101217; border: 1px solid #1c202a; border-radius: 6px; min-height: 72px; padding: 6px 8px;
      display: flex; flex-direction: column; justify-content: space-between; cursor: pointer; transition: all 0.15s; position: relative;
    }
    .ts-cal-cell:hover {
      background: #181b24; border-color: #2e3547; transform: translateY(-1px);
    }
    .ts-cal-cell.empty {
      background: #0d0f14; border-color: #171922; cursor: default;
    }
    .ts-cal-cell.empty:hover { transform: none; background: #0d0f14; border-color: #171922; }
    .ts-cal-cell.active-day {
      border: 1.5px solid #fff !important; box-shadow: 0 0 14px rgba(255, 255, 255, 0.15);
      background: #161a24;
    }
    .ts-cell-daynum {
      font-size: 10px; font-weight: 700; color: #525866; line-height: 1;
    }
    .ts-cell-daynum.active { color: #fff; }
    .ts-cell-pnl {
      font-size: 12px; font-weight: 800; text-align: center; font-family: "JetBrains Mono", monospace; margin: 4px 0 2px 0;
    }
    .ts-cell-pnl.green { color: #10b981; }
    .ts-cell-pnl.red { color: #ef4444; }
    .ts-cell-trades {
      font-size: 9px; color: #717684; text-align: center; font-weight: 600;
    }
    .ts-weekly-cell {
      background: #141722; border: 1px solid #232a3d; border-radius: 6px; min-height: 72px; padding: 6px 8px;
      display: flex; flex-direction: column; justify-content: space-between; text-align: center;
    }
    .ts-weekly-title {
      font-size: 9.5px; font-weight: 800; color: #38bdf8; text-transform: uppercase;
    }
    .ts-weekly-pnl {
      font-size: 12.5px; font-weight: 800; font-family: "JetBrains Mono", monospace;
    }
    .ts-weekly-trades {
      font-size: 9px; color: #8c93a3; font-weight: 600;
    }

    /* Modal / Drawer for Day Journal Details */
    .ts-modal-overlay {
      display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(4px); z-index: 999;
      align-items: center; justify-content: center;
    }
    .ts-modal-box {
      background: #14161f; border: 1px solid #282d3d; border-radius: 12px; width: 680px; max-width: 90%;
      max-height: 80vh; overflow-y: auto; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);
    }
    .ts-modal-head {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 12px;
      border-bottom: 1px solid #222634;
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
      <button class="tab-btn" data-target="view-journal" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.5); font-weight: 700;">📅 Daily PnL Journal</button>
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
      <!-- Main Workspace: Watchlist on Left, Chart Area in Center, Proliquid Trading Dock on Right -->
      <div style="flex: 1; display: flex; overflow: hidden; position: relative; height: 100%;">
        <!-- Left: Proliquid Watchlist Sidebar -->
        <div id="watchlist-sidebar">
          <!-- Header -->
          <div style="padding: 10px 12px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.01);">
            <div style="display: flex; align-items: center; gap: 6px;">
              <strong style="font-size: 12px; letter-spacing: 0.5px;">PRO WATCHLIST</strong>
              <span id="wl-total-count" style="font-size: 10px; color: var(--text-secondary); background: var(--bg-tertiary); padding: 1px 6px; border-radius: 10px; font-weight: 700;">23</span>
            </div>
            <div style="display: flex; gap: 4px;">
              <button class="btn" id="btn-show-add-token" title="Add token to watchlist" style="padding: 3px 8px; font-size: 11px;">＋ Add</button>
              <button class="btn" id="btn-refresh-wl-prices" title="Refresh prices" style="padding: 3px 6px; font-size: 11px;">🔄</button>
            </div>
          </div>

          <!-- Add Token Bar (collapsible) -->
          <div id="add-token-container" style="display: none; padding: 8px; border-bottom: 1px solid var(--border-color); background: var(--bg-tertiary); position: relative;">
            <div style="display: flex; gap: 4px;">
              <input type="text" id="input-new-symbol" placeholder="Search token (e.g. ARB, DOGE, PEPE)..." style="flex: 1; background: var(--bg-primary); border: 1px solid var(--border-color); color: #fff; padding: 5px 8px; border-radius: 4px; font-size: 11px; outline: none;">
              <button class="btn active" id="btn-confirm-add-token" style="padding: 5px 8px; font-size: 11px;">Add</button>
            </div>
            <div id="search-suggestions" style="display: none; margin-top: 6px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 4px; max-height: 180px; overflow-y: auto;"></div>
            <div id="add-token-hint" style="font-size: 9px; color: var(--text-secondary); margin-top: 4px;">Type token name (e.g. ARB, PEPE) or pair (BINANCE:ARBUSDT)</div>
          </div>

          <!-- Search / Quick Filter -->
          <div style="padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.04);">
            <input type="text" id="watchlist-search" placeholder="Search tokens..." style="width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 11px; outline: none;">
          </div>

          <!-- Table Column Headers: Symbol | Last | Chg | Chg% -->
          <div class="wl-col-header">
            <span>Symbol</span>
            <span class="text-right">Last</span>
            <span class="text-right">Chg</span>
            <span class="text-right">Chg%</span>
            <span></span>
          </div>

          <!-- Watchlist Items Scroll -->
          <div id="watchlist-list" style="flex: 1; overflow-y: auto;"></div>
        </div>

        <!-- Center: Chart Area (Directly Hosts Ticker Bar + Toolbar + Canvas) -->
        <div style="flex: 1; position: relative; height: 100%; display: flex; flex-direction: column; min-width: 0; background: var(--bg-primary);">
          <!-- TIER 1: Hyperliquid Market Header & Ticker Bar -->
          <div class="hl-ticker-bar">
            <div class="hl-ticker-left">
              <span class="hl-drag-handle">⋮</span>
              <div class="hl-market-badge">
                <img id="active-symbol-logo" src="https://s3-symbol-logo.tradingview.com/crypto/XTVCBTC.svg" style="width: 20px; height: 20px; border-radius: 50%; object-fit: contain; background: #181b24;" onerror="this.style.display='none';">
                <div style="display: flex; flex-direction: column;">
                  <span id="active-exchange-badge" class="hl-badge-sub">HYPERLIQUID</span>
                  <strong id="active-symbol-title" class="hl-badge-title">BTC-USDC</strong>
                </div>
              </div>
              <div class="hl-vdiv"></div>
            </div>

            <div class="hl-stat-group">
              <div class="hl-stat-item">
                <span class="hl-stat-lbl">LAST</span>
                <strong id="hl-stat-last" class="hl-stat-val">$80,452</strong>
              </div>
              <div class="hl-stat-item">
                <span class="hl-stat-lbl">INDEX</span>
                <strong id="hl-stat-index" class="hl-stat-val">$80,440</strong>
              </div>
              <div class="hl-stat-item">
                <span class="hl-stat-lbl">CHANGE</span>
                <strong id="hl-stat-change" class="hl-stat-val val-red">-1.02%</strong>
              </div>
              <div class="hl-stat-item">
                <span class="hl-stat-lbl">VOLUME</span>
                <strong id="hl-stat-volume" class="hl-stat-val">$1.44b</strong>
              </div>
              <div class="hl-stat-item">
                <span class="hl-stat-lbl">OPEN INTEREST</span>
                <strong id="hl-stat-oi" class="hl-stat-val">$3.31b</strong>
              </div>
              <div class="hl-stat-item">
                <span class="hl-stat-lbl">FUNDING / COUNTDOWN</span>
                <div class="hl-stat-val" style="font-size: 11px;">
                  <span id="hl-stat-funding" class="val-red" style="font-weight: 800;">0.0013%</span> / <span id="hl-stat-countdown" style="font-weight: 700; color: #d1d4dc;">00:54:34</span>
                </div>
              </div>
              <div class="hl-stat-item">
                <span class="hl-stat-lbl">MARKETCAP</span>
                <strong id="hl-stat-mcap" class="hl-stat-val">$1.62t</strong>
              </div>
              <div class="hl-stat-item">
                <span class="hl-stat-lbl">FDV</span>
                <strong id="hl-stat-fdv" class="hl-stat-val">$1.62t</strong>
              </div>
            </div>
          </div>

          <!-- TIER 2: TradingView Chart Toolbar -->
          <div class="hl-chart-toolbar">
            <div class="hl-tb-left">
              <div class="tf-group" id="timeframes" style="display: flex; gap: 2px;">
                <button class="hl-tf-btn" data-tf="1">1m</button>
                <button class="hl-tf-btn" data-tf="5">5m</button>
                <button class="hl-tf-btn" data-tf="15">15m</button>
                <button class="hl-tf-btn" data-tf="60">1h</button>
                <button class="hl-tf-btn" data-tf="240">4h</button>
                <button class="hl-tf-btn active" data-tf="D">D</button>
                <button class="hl-tf-btn" data-tf="W">W</button>
                <button class="hl-tf-btn" data-tf="M">M</button>
                <button class="hl-tf-btn" style="color: #687080;" title="More timeframes">⌄</button>
              </div>

              <div class="hl-vdiv"></div>

              <!-- Chart style (Candlesticks) -->
              <button class="hl-tool-btn" title="Candlesticks style">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 4v16M9 8h4v8H9zM17 2v20M17 5h4v6h-4z"/></svg>
              </button>

              <div class="hl-vdiv"></div>

              <!-- Indicators Dropdown Button -->
              <div style="position: relative; display: inline-block;">
                <button class="hl-tool-btn" id="btn-indicators-menu">
                  <span style="font-family: serif; font-style: italic; font-weight: 800; color: #a855f7;">fx</span>
                  <span>Indicators</span>
                  <span style="font-size: 8px; color: #8c93a3;">⌄</span>
                </button>
                <div id="indicators-dropdown" style="display: none; position: absolute; top: 28px; left: 0; background: #131722; border: 1px solid #2b3040; border-radius: 8px; padding: 10px 12px; z-index: 100; width: 280px; box-shadow: 0 8px 24px rgba(0,0,0,0.8);">
                  <div style="font-size: 11px; font-weight: 800; color: #fff; margin-bottom: 8px; border-bottom: 1px solid #2a2e39; padding-bottom: 4px; display: flex; justify-content: space-between;">
                    <span>INDICATORS REPOSITORY</span>
                    <span style="font-size: 10px; color: #8c93a3;">3 Active Tools</span>
                  </div>

                  <!-- 1. FiboRadar -->
                  <div style="margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #222634;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                      <span style="font-size: 11px; font-weight: 700; color: #c084fc;">🎯 FiboRadar [Mr_Rakun]</span>
                      <button class="btn active" id="btn-toggle-fibo" style="padding: 2px 8px; font-size: 9.5px; background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid #a855f7;">ON</button>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary);">
                      <span>Bars period:</span>
                      <select id="select-fibo-period" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="999999">Full / All bars</option>
                        <option value="500">500 bars</option>
                        <option value="200" selected>200 bars</option>
                        <option value="100">100 bars</option>
                        <option value="50">50 bars</option>
                      </select>
                    </div>
                  </div>

                  <!-- 2. Galton Volume Profile -->
                  <div style="margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #222634;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                      <span style="font-size: 11px; font-weight: 700; color: #38bdf8;">📊 Galton Volume Profile</span>
                      <button class="btn" id="btn-toggle-galton" style="padding: 2px 8px; font-size: 9.5px; background: var(--bg-tertiary); color: var(--text-secondary); border: 1px solid transparent;">OFF</button>
                    </div>
                    <div style="font-size: 9px; color: #94a3b8; margin-bottom: 4px;">ata_sabanci • BVC & Galton Binomial Flow</div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary); margin-bottom: 4px;">
                      <span>Volume Engine:</span>
                      <select id="select-galton-engine" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="BVC" selected>BVC (Bulk Volume)</option>
                        <option value="GEOMETRIC">Geometric (Close/HL)</option>
                      </select>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary);">
                      <span>Lookback:</span>
                      <select id="select-galton-period" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="200">200 bars</option>
                        <option value="100" selected>100 bars</option>
                        <option value="50">50 bars</option>
                      </select>
                    </div>
                  </div>

                  <!-- 3. Volume Footprint: Math & Geometry -->
                  <div>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                      <span style="font-size: 11px; font-weight: 700; color: #818cf8;">👣 Volume Footprint</span>
                      <button class="btn" id="btn-toggle-footprint" style="padding: 2px 8px; font-size: 9.5px; background: var(--bg-tertiary); color: var(--text-secondary); border: 1px solid transparent;">OFF</button>
                    </div>
                    <div style="font-size: 9px; color: #94a3b8; margin-bottom: 4px;">ata_sabanci • Gaussian Footprint & Imbalance</div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary); margin-bottom: 4px;">
                      <span>Window Bars:</span>
                      <select id="select-footprint-window" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="5" selected>5 bars (Classic)</option>
                        <option value="10">10 bars</option>
                        <option value="15">15 bars</option>
                      </select>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary);">
                      <span>Imbalance Ratio:</span>
                      <select id="select-footprint-imbalance" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="3.0" selected>300% (3x)</option>
                        <option value="2.0">200% (2x)</option>
                        <option value="4.0">400% (4x)</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 6px;">
              <button class="btn active" id="btn-toggle-watchlist" style="background: rgba(41, 98, 255, 0.2); color: #78a9ff; border: 1px solid #2962ff; padding: 2px 7px; font-size: 10.5px;">📑 Watchlist</button>
              <button class="btn active" id="btn-toggle-dock" style="background: rgba(38, 166, 154, 0.2); color: #4ade80; border: 1px solid #26a69a; padding: 2px 7px; font-size: 10.5px;">⚡ Terminal Dock</button>

              <div class="hl-vdiv"></div>

              <!-- Fullscreen & Camera -->
              <button class="hl-icon-btn" id="btn-chart-fullscreen" title="Fullscreen chart">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
              </button>
              <button class="hl-icon-btn" id="btn-chart-screenshot" title="Take chart screenshot">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              </button>
            </div>
          </div>

          <!-- Chart Canvas -->
          <div id="chart-container" style="flex: 1; width: 100%; position: relative;">
            <div class="legend-overlay">
              <span class="legend-item"><span class="legend-label">O:</span><span id="leg-open">--</span></span>
              <span class="legend-item"><span class="legend-label">H:</span><span id="leg-high">--</span></span>
              <span class="legend-item"><span class="legend-label">L:</span><span id="leg-low">--</span></span>
              <span class="legend-item"><span class="legend-label">C:</span><span id="leg-close">--</span></span>
              <span class="legend-item"><span class="legend-label">Vol:</span><span id="leg-vol">--</span></span>
            </div>
            <!-- Indicators Floating HUD Container -->
            <div id="indicators-hud-stack" style="position: absolute; top: 12px; right: 16px; z-index: 10; display: flex; flex-direction: column; gap: 8px; max-height: calc(100% - 24px); overflow-y: auto; pointer-events: none;">
              <!-- 1. FiboRadar HUD -->
              <div id="fiboradar-hud" style="pointer-events: auto; background: rgba(15, 17, 23, 0.90); backdrop-filter: blur(6px); border: 1px solid #a855f7; border-radius: 6px; padding: 8px 12px; font-size: 11px; width: 240px; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                  <span style="font-weight: 700; color: #c084fc;">🎯 FiboRadar [Mr_Rakun]</span>
                  <span id="fibo-swing-badge" style="font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: rgba(74, 222, 128, 0.2); color: #4ade80;">BULL</span>
                </div>
                <div style="margin-bottom: 6px; font-size: 10px; color: var(--text-secondary);">
                  Zone: <strong id="fibo-current-zone" style="color: #fbbf24;">--</strong>
                </div>
                <div id="fibo-levels-list" style="display: flex; flex-direction: column; gap: 2px;"></div>
              </div>

              <!-- 2. Galton Volume Profile HUD -->
              <div id="galton-hud" style="display: none; pointer-events: auto; background: rgba(15, 17, 23, 0.92); backdrop-filter: blur(8px); border: 1px solid #0284c7; border-radius: 6px; padding: 8px 12px; font-size: 11px; width: 260px; box-shadow: 0 4px 18px rgba(0,0,0,0.6);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                  <span style="font-weight: 800; color: #38bdf8;">📊 Galton Volume Profile</span>
                  <span id="galton-engine-badge" style="font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: rgba(56, 189, 248, 0.15); color: #38bdf8;">BVC</span>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-secondary); margin-bottom: 4px;">
                  <span>Buy/Sell Flow:</span>
                  <span id="galton-flow-delta" style="font-weight: 700;">--</span>
                </div>
                <!-- Buy vs Sell Flow Bar -->
                <div style="width: 100%; height: 6px; background: #222634; border-radius: 3px; overflow: hidden; display: flex; margin-bottom: 6px;">
                  <div id="galton-buy-bar" style="width: 50%; height: 100%; background: #2979ff;"></div>
                  <div id="galton-sell-bar" style="width: 50%; height: 100%; background: #ff1744;"></div>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; text-align: center; margin-bottom: 6px; font-size: 9.5px;">
                  <div style="background: rgba(255,255,255,0.03); padding: 3px; border-radius: 4px;">
                    <div style="color: #94a3b8; font-size: 8.5px;">VAL (70%)</div>
                    <div id="galton-val" style="color: #38bdf8; font-weight: 700;">--</div>
                  </div>
                  <div style="background: rgba(251, 191, 36, 0.08); padding: 3px; border-radius: 4px; border: 1px solid rgba(251, 191, 36, 0.2);">
                    <div style="color: #fbbf24; font-size: 8.5px; font-weight: 700;">● POC</div>
                    <div id="galton-poc" style="color: #fbbf24; font-weight: 800;">--</div>
                  </div>
                  <div style="background: rgba(255,255,255,0.03); padding: 3px; border-radius: 4px;">
                    <div style="color: #94a3b8; font-size: 8.5px;">VAH (70%)</div>
                    <div id="galton-vah" style="color: #38bdf8; font-weight: 700;">--</div>
                  </div>
                </div>
                <!-- Mini Profile Distribution Graph -->
                <div id="galton-profile-bars" style="display: flex; flex-direction: column; gap: 1px; max-height: 70px; overflow: hidden;"></div>
              </div>

              <!-- 3. Volume Footprint: Math & Geometry HUD -->
              <div id="footprint-hud" style="display: none; pointer-events: auto; background: rgba(15, 17, 23, 0.92); backdrop-filter: blur(8px); border: 1px solid #6366f1; border-radius: 6px; padding: 8px 12px; font-size: 11px; width: 260px; box-shadow: 0 4px 18px rgba(0,0,0,0.6);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                  <span style="font-weight: 800; color: #818cf8;">👣 Volume Footprint</span>
                  <span id="footprint-window-badge" style="font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: rgba(99, 102, 241, 0.15); color: #818cf8;">5 BARS</span>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px; font-size: 10px;">
                  <div style="background: rgba(255,255,255,0.03); padding: 4px; border-radius: 4px;">
                    <div style="color: #94a3b8; font-size: 8.5px;">BAR VOL / Δ</div>
                    <div id="footprint-bar-vol" style="font-weight: 700; color: #e2e8f0;">--</div>
                    <div id="footprint-bar-delta" style="font-size: 9px; font-weight: 800;">--</div>
                  </div>
                  <div style="background: rgba(255,255,255,0.03); padding: 4px; border-radius: 4px;">
                    <div style="color: #94a3b8; font-size: 8.5px;">WIN VOL / WIN Δ</div>
                    <div id="footprint-win-vol" style="font-weight: 700; color: #e2e8f0;">--</div>
                    <div id="footprint-win-delta" style="font-size: 9px; font-weight: 800;">--</div>
                  </div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10px; margin-bottom: 4px;">
                  <span style="color: #94a3b8;">Window POC:</span>
                  <strong id="footprint-poc" style="color: #a5b4fc;">--</strong>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10px; margin-bottom: 4px;">
                  <span style="color: #94a3b8;">Value Area (VAH/VAL):</span>
                  <span id="footprint-va" style="color: #cbd5e1; font-weight: 700;">--</span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10px; margin-bottom: 4px;">
                  <span style="color: #94a3b8;">Diagonal Imbalance:</span>
                  <span id="footprint-imbalance-status" style="font-weight: 700; color: #4ade80;">--</span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10px;">
                  <span style="color: #94a3b8;">Overlap / Balance (OVL):</span>
                  <span id="footprint-overlap" style="font-weight: 700; color: #fbbf24;">--</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Right: Proliquid Trading & Execution Dock (Modular Blocks) -->
        <div id="trading-dock" class="dock-panel">
          <!-- Dock Top View Filter Bar -->
          <div class="dock-segmented-bar">
            <button class="dock-seg-btn active" data-dock-tab="all">🎛️ All Blocks</button>
            <button class="dock-seg-btn" data-dock-tab="screener">📊 Screener</button>
            <button class="dock-seg-btn" data-dock-tab="orderbook">📖 Orderbook</button>
            <button class="dock-seg-btn" data-dock-tab="exec">⚡ Execution</button>
          </div>

          <!-- Block 1: Account & Web3 Connect -->
          <div class="dock-block" id="dock-block-account">
            <div class="dock-block-header">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="color: #fff; font-weight: 800;">💼 ACCOUNT</span>
                <span id="account-mode-badge" class="badge-paper">● PAPER $10K</span>
              </div>
              <button class="btn-wallet-connect" id="btn-dock-mode-toggle" title="Connect Web3 Wallet (MetaMask, Rabby, Phantom)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
                <span id="wallet-btn-label">Connect Wallet</span>
              </button>
            </div>
            
            <div class="account-details-grid">
              <div class="acc-stat-box">
                <div class="acc-stat-lbl">AVAILABLE CAPITAL</div>
                <div class="acc-stat-val" id="dock-avail-bal">$10,214.44</div>
              </div>
              <div class="acc-stat-box">
                <div class="acc-stat-lbl">ACTIVE POSITION</div>
                <div class="acc-stat-val" id="dock-active-pos">--</div>
              </div>
            </div>

            <!-- Connected Wallet Ribbon -->
            <div id="wallet-connected-bar" style="display: none; align-items: center; justify-content: space-between; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 6px; padding: 5px 8px; margin-top: 6px; font-size: 10.5px;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span id="wallet-provider-icon" style="font-size: 13px;">🦊</span>
                <span id="wallet-address-display" style="font-family: monospace; color: #38bdf8; font-weight: 700;">0x...</span>
              </div>
              <div style="display: flex; gap: 4px;">
                <button class="btn" id="btn-copy-wallet" style="padding: 2px 6px; font-size: 9px;" title="Copy Address">📋</button>
                <button class="btn" id="btn-disconnect-hl-wallet" style="padding: 2px 6px; font-size: 9px; color: #ef5350; background: rgba(239, 83, 80, 0.15);">Disconnect</button>
              </div>
            </div>
          </div>

          <!-- Block 2: Market Screener -->
          <div class="dock-block" id="dock-block-screener">
            <div class="dock-block-header">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="color: #fff; font-weight: 800;">📊 SCREENER</span>
                <span id="scr-coin-badge" style="font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 800;">BTC</span>
              </div>
              <span style="font-size: 9.5px; color: var(--text-secondary);">Market Velocity</span>
            </div>
            
            <div class="scr-table">
              <div class="scr-header-row">
                <span class="scr-col-th" style="text-align: left;">METRIC</span>
                <span class="scr-col-th">5 M</span>
                <span class="scr-col-th">15 M</span>
              </div>
              <div class="scr-row">
                <span class="scr-label">TRADES</span>
                <span class="scr-val" id="scr-trades-5m">--</span>
                <span class="scr-val" id="scr-trades-15m">--</span>
              </div>
              <div class="scr-row">
                <span class="scr-label">CHANGE %</span>
                <span class="scr-val" id="scr-chg-5m">--</span>
                <span class="scr-val" id="scr-chg-15m">--</span>
              </div>
              <div class="scr-row">
                <span class="scr-label">VOLUME</span>
                <span class="scr-val" id="scr-vol-5m">--</span>
                <span class="scr-val" id="scr-vol-15m">--</span>
              </div>
              <div class="scr-row" style="border-bottom: none;">
                <span class="scr-label">VOLUME Δ</span>
                <span class="scr-val" id="scr-vdelta-5m">--</span>
                <span class="scr-val" id="scr-vdelta-15m">--</span>
              </div>
            </div>
          </div>

          <!-- Block 3: L2 Orderbook -->
          <div class="dock-block" id="dock-block-orderbook">
            <div class="dock-block-header">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="color: #fff; font-weight: 800;">📖 L2 ORDERBOOK</span>
                <span id="ob-coin-badge" style="font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(41, 98, 255, 0.2); color: #78a9ff; font-weight: 800;">BTC</span>
              </div>
              <div style="font-size: 9.5px; color: var(--text-secondary);">Tick: <strong>1</strong></div>
            </div>

            <!-- Table Header -->
            <div style="display: flex; justify-content: space-between; padding: 3px 6px; font-size: 9.5px; color: #8c93a3; border-bottom: 1px solid rgba(255,255,255,0.06); font-weight: 700;">
              <span>PRICE (USDC)</span>
              <span>SIZE</span>
              <span>TOTAL</span>
            </div>

            <!-- Asks Container -->
            <div id="ob-asks-list" style="display: flex; flex-direction: column; justify-content: flex-end; height: 110px; overflow: hidden; margin-top: 2px;"></div>

            <!-- Center Spread Bar & Mid Price -->
            <div class="ob-spread-bar">
              <div style="display: flex; align-items: center; gap: 4px;">
                <span id="ob-spread-val" style="font-weight: 800; color: #fff;">SPREAD --</span>
                <span id="ob-spread-bp" style="color: #8c93a3; font-size: 8.5px;">(--BP)</span>
              </div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span id="dock-market-price" style="font-family: monospace; font-size: 11px; font-weight: 800; color: #4ade80;">--</span>
                <span id="ob-max-depth" style="font-family: monospace; font-weight: 600; color: #8c93a3; font-size: 8.5px;">MAX --</span>
              </div>
            </div>
            
            <div class="ob-ratio-bar">
              <div id="ob-ratio-bid" class="ob-ratio-bid" style="width: 50%;"></div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 8.5px; color: #8c93a3; margin: 2px 0 4px 0;">
              <span>BID <strong id="ob-bid-pct" style="color: #4ade80;">50%</strong></span>
              <span>ASK <strong id="ob-ask-pct" style="color: #f87171;">50%</strong></span>
            </div>

            <!-- Bids Container -->
            <div id="ob-bids-list" style="display: flex; flex-direction: column; height: 110px; overflow: hidden;"></div>
          </div>

          <!-- Block 4: Trade Execution Dock -->
          <div class="dock-block" id="dock-block-exec">
            <div class="dock-block-header">
              <span style="color: #fff; font-weight: 800;">⚡ ORDER EXECUTION</span>
              <div style="display: flex; gap: 3px;">
                <button class="btn active" id="btn-ord-market" style="padding: 2px 6px; font-size: 9.5px;">MARKET</button>
                <button class="btn" id="btn-ord-limit" style="padding: 2px 6px; font-size: 9.5px;">LIMIT</button>
              </div>
            </div>

            <div>
              <div id="limit-price-group" style="display: none;" class="exec-input-group">
                <span style="font-size: 9.5px; color: var(--text-secondary); margin-right: 4px;">LIMIT PRICE:</span>
                <input type="number" id="input-exec-price" class="exec-input" step="any" placeholder="Enter limit price">
                <span style="font-size: 9.5px; color: var(--text-secondary);">USDC</span>
              </div>

              <div class="exec-input-group">
                <span style="font-size: 9.5px; color: var(--text-secondary); margin-right: 4px;">QTY:</span>
                <input type="number" id="input-exec-qty" class="exec-input" step="any" placeholder="0">
                <span id="exec-coin-denom" style="font-size: 9.5px; color: var(--text-secondary);">BTC</span>
              </div>

              <div class="exec-input-group">
                <span style="font-size: 9.5px; color: var(--text-secondary); margin-right: 4px;">NOTIONAL:</span>
                <input type="number" id="input-exec-notional" class="exec-input" step="any" placeholder="0">
                <span style="font-size: 9.5px; color: var(--text-secondary);">USDC</span>
              </div>

              <!-- Slider & Chips -->
              <div style="display: flex; justify-content: space-between; font-size: 9.5px; color: var(--text-secondary); margin-top: 1px;">
                <span>ALLOCATION</span>
                <span id="exec-pct-display" style="color: #fff; font-weight: 700;">0 %</span>
              </div>
              <input type="range" id="exec-pct-slider" class="exec-slider" min="0" max="100" step="5" value="0">
              <div class="pct-chips">
                <div class="pct-chip" data-pct="25">25%</div>
                <div class="pct-chip" data-pct="50">50%</div>
                <div class="pct-chip" data-pct="75">75%</div>
                <div class="pct-chip" data-pct="100">100%</div>
              </div>

              <!-- Options -->
              <div style="display: flex; gap: 4px; margin-bottom: 6px;">
                <button class="btn" id="btn-toggle-reduce" style="flex: 1; padding: 3px 0; font-size: 9px;">REDUCE ONLY</button>
                <button class="btn" id="btn-toggle-tpsl" style="flex: 1; padding: 3px 0; font-size: 9px;">TP / SL</button>
              </div>

              <div id="tpsl-inputs-container" style="display: none; margin-bottom: 6px;">
                <div class="exec-input-group" style="margin-bottom: 3px; padding: 4px 6px;">
                  <span style="font-size: 9px; color: #4ade80; margin-right: 4px;">TP:</span>
                  <input type="number" id="input-exec-tp" class="exec-input" placeholder="Take Profit price">
                </div>
                <div class="exec-input-group" style="margin-bottom: 0; padding: 4px 6px;">
                  <span style="font-size: 9px; color: #f87171; margin-right: 4px;">SL:</span>
                  <input type="number" id="input-exec-sl" class="exec-input" placeholder="Stop Loss price">
                </div>
              </div>
            </div>

            <!-- Action buttons -->
            <div style="display: flex; flex-direction: column; gap: 5px; margin-top: 4px;">
              <button class="exec-btn exec-btn-buy" id="btn-exec-buy">
                <span>BUY / LONG</span>
                <span id="exec-buy-sub" style="font-size: 8.5px; font-weight: 500; opacity: 0.85;">0 BTC @ $0</span>
              </button>
              <button class="exec-btn exec-btn-sell" id="btn-exec-sell">
                <span>SELL / SHORT</span>
                <span id="exec-sell-sub" style="font-size: 8.5px; font-weight: 500; opacity: 0.85;">0 BTC @ $0</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Web3 Wallet Selection Modal -->
        <div id="web3-wallet-modal" class="web3-modal-overlay" style="display: none;">
          <div class="web3-modal-card">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid #1f2536;">
              <div>
                <div style="font-size: 13px; font-weight: 800; color: #fff;">Connect to Hyperliquid</div>
                <div style="font-size: 10px; color: #8c93a3;">Select your Web3 wallet provider or enter read-only address</div>
              </div>
              <button id="btn-close-web3-modal" style="background: none; border: none; color: #8c93a3; font-size: 16px; cursor: pointer; padding: 4px;">✕</button>
            </div>

            <div style="padding: 14px 16px;">
              <!-- 1. MetaMask -->
              <div class="web3-wallet-option" id="btn-connect-metamask">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 22px;">🦊</span>
                  <div>
                    <div style="font-size: 11.5px; font-weight: 700; color: #fff;">MetaMask</div>
                    <div style="font-size: 9.5px; color: #8c93a3;">Connect browser extension (EVM)</div>
                  </div>
                </div>
                <span style="font-size: 10px; color: #3b82f6; font-weight: 700;">Connect →</span>
              </div>

              <!-- 2. Rabby Wallet -->
              <div class="web3-wallet-option" id="btn-connect-rabby">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 22px;">🐰</span>
                  <div>
                    <div style="font-size: 11.5px; font-weight: 700; color: #fff;">Rabby Wallet</div>
                    <div style="font-size: 9.5px; color: #8c93a3;">Game-changing wallet for Hyperliquid</div>
                  </div>
                </div>
                <span style="font-size: 10px; color: #3b82f6; font-weight: 700;">Connect →</span>
              </div>

              <!-- 3. Phantom -->
              <div class="web3-wallet-option" id="btn-connect-phantom">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 22px;">👻</span>
                  <div>
                    <div style="font-size: 11.5px; font-weight: 700; color: #fff;">Phantom</div>
                    <div style="font-size: 9.5px; color: #8c93a3;">Multi-chain EVM & Solana wallet</div>
                  </div>
                </div>
                <span style="font-size: 10px; color: #3b82f6; font-weight: 700;">Connect →</span>
              </div>

              <div style="display: flex; align-items: center; gap: 8px; margin: 12px 0;">
                <div style="flex: 1; height: 1px; background: #222736;"></div>
                <span style="font-size: 9px; color: #64748b; font-weight: 700;">OR MANUAL ADDRESS</span>
                <div style="flex: 1; height: 1px; background: #222736;"></div>
              </div>

              <!-- 4. Manual Address Input -->
              <div>
                <input type="text" id="input-hl-wallet" placeholder="0x... Enter Hyperliquid address (Read-only)" style="width: 100%; background: #161a24; border: 1px solid #23293a; color: #fff; padding: 7px 10px; font-size: 11px; font-family: monospace; border-radius: 6px; outline: none; margin-bottom: 8px;">
                <div style="display: flex; gap: 6px;">
                  <button class="btn active" id="btn-save-hl-wallet" style="flex: 1; padding: 6px; font-size: 10.5px; font-weight: 700;">Watch Address</button>
                  <button class="btn" id="btn-switch-paper-modal" style="padding: 6px 12px; font-size: 10.5px; background: rgba(34, 197, 94, 0.15); color: #4ade80;">Use Paper ($10k)</button>
                </div>
              </div>

              <!-- Status / Error message -->
              <div id="web3-status-msg" style="display: none; margin-top: 10px; padding: 6px 10px; border-radius: 6px; font-size: 10px; font-weight: 600;"></div>
            </div>
          </div>
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
          <span style="font-size: 11px; color: var(--text-secondary);">Daily Target: <strong>1% - 3% ($100 - $300 / day) [Max 3x Lev]</strong></span>
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

        <!-- Daily Target & Stop Loss Progress Card -->
        <div class="card">
          <div class="card-title">
            <span>Daily Profit Target (1% - 3% | $100 - $300) & Stop Loss (-$180)</span>
            <span id="target-progress-text" style="color: #fbbf24; font-weight: 700;">0%</span>
          </div>
          <div style="width: 100%; height: 12px; background: var(--bg-tertiary); border-radius: 6px; overflow: hidden; margin-top: 4px;">
            <div id="target-progress-bar" style="height: 100%; width: 0%; background: linear-gradient(90deg, #26a69a, #4ade80, #fbbf24); transition: width 0.3s;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; margin-top: 6px; font-size: 10px; color: var(--text-secondary);">
            <span style="color: #ef5350; font-weight: 700;">-$180.00 (Daily Stop Loss -1.8%)</span>
            <span>$0.00</span>
            <span style="color: #38bdf8; font-weight: 700;">$100.00 (Min Target 1%)</span>
            <span style="color: #4ade80; font-weight: 700;">$300.00 (Max Target 3% - Lock)</span>
          </div>
        </div>

        <!-- Open Positions -->
        <div class="card">
          <div class="card-title">Active Paper Positions (Max 2 Concurrent | Leverage up to 3x)</div>
          <table id="table-paper-positions">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Lev</th>
                <th>Entry</th>
                <th>Mark Price</th>
                <th>TP</th>
                <th>SL</th>
                <th>Margin</th>
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
          <div class="card" style="display: flex; flex-direction: column; margin-bottom: 0;">
            <div class="card-title">Completed Trades History</div>
            <div style="flex: 1; overflow-y: auto; max-height: 480px;">
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
          </div>

          <!-- Activity Logs -->
          <div class="card" style="display: flex; flex-direction: column; margin-bottom: 0;">
            <div class="card-title">
              <span>Strategy Execution Log</span>
              <span id="paper-logs-status" style="font-size: 10px; font-weight: 600; color: #38bdf8;">● Live Event Stream</span>
            </div>
            <div id="paper-logs-container" style="font-family: monospace; font-size: 11px; color: #cbd5e1; line-height: 1.6; flex: 1; min-height: 320px; max-height: 480px; overflow-y: auto; background: #0c0e14; border: 1px solid #1c202a; border-radius: 6px; padding: 10px 12px; scrollbar-width: thin;">
              <div>[PaperTrader] Engine initialized with $10,000.00 fund.</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- VIEW: TRADESYNC DAILY PNL JOURNAL -->
    <div class="view-panel" id="view-journal">
      <div class="ts-dashboard">
        <!-- Top App Bar & Market Status -->
        <div class="ts-top-header">
          <div class="ts-title-left">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            <h1 class="ts-title">Journaling Dashboard</h1>
          </div>
          <div class="ts-top-right">
            <div class="ts-status-badge">
              <span class="ts-status-dot"></span>
              <span>Market Open</span>
            </div>
            <button class="ts-icon-btn" title="Toggle theme">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
            </button>
            <button class="ts-icon-btn" title="Notifications">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
              <span class="ts-notif-dot"></span>
            </button>
            <div style="width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, #38bdf8, #818cf8); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; color: #fff;">
              T
            </div>
          </div>
        </div>

        <!-- Filter Toolbar (Row 1) -->
        <div class="ts-toolbar">
          <div class="ts-pill-group">
            <button class="ts-pill-btn active" data-ts-source="all">All Journals</button>
            <button class="ts-pill-btn" data-ts-source="verified">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
              Verified
            </button>
            <button class="ts-pill-btn" data-ts-source="manual">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
              Manual
            </button>
          </div>
          <div class="ts-dropdowns">
            <select class="ts-select" id="ts-filter-account">
              <option value="all">All Accounts (Paper $10k & Live)</option>
              <option value="paper">Paper Trade $10,000 USD</option>
              <option value="hyperliquid">Hyperliquid Mainnet</option>
            </select>
            <select class="ts-select" id="ts-filter-strategy">
              <option value="all">All Strategies</option>
              <option value="Supertrend">Supertrend + MACD</option>
              <option value="Sniper">Sniper A+ Confluence</option>
              <option value="Manual">Manual Execution</option>
            </select>
            <select class="ts-select" id="ts-filter-timeframe">
              <option value="all">All Time</option>
              <option value="month">This Month</option>
              <option value="week">This Week</option>
            </select>
            <select class="ts-select" id="ts-month-mode" style="border-color: #38bdf8; background: rgba(56, 189, 248, 0.1); color: #38bdf8; font-weight: 700;">
              <option value="march2026">📅 March 2026 (Demo Showcase)</option>
              <option value="current">⚡ Current Live Paper Trading</option>
            </select>
          </div>
        </div>

        <!-- Action Toolbar (Row 2) -->
        <div class="ts-toolbar" style="margin-bottom: 16px;">
          <div class="ts-subtabs">
            <button class="ts-subtab-btn active" data-ts-view="journal">📋 Journal</button>
            <button class="ts-subtab-btn" data-ts-view="comparison">⚖️ Comparison</button>
            <button class="ts-subtab-btn" data-ts-view="analysis">📈 Analysis</button>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button class="ts-btn-outline" id="btn-ts-export">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              Export CSV
            </button>
            <button class="ts-btn-outline" id="btn-ts-import">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
              Manual Import <span class="ts-badge-free">Free</span>
            </button>
            <button class="ts-btn-white" id="btn-ts-sync">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
              Sync
            </button>
            <button class="ts-btn-primary" id="btn-ts-new">
              <span>＋</span> New Journal
            </button>
          </div>
        </div>

        <!-- Section 2: 5 KPI Summary Cards -->
        <div class="ts-kpi-grid">
          <!-- Card 1: DAY WIN % -->
          <div class="ts-kpi-card">
            <div>
              <div class="ts-kpi-head"><span>&lt; DAY WIN %</span></div>
              <div class="ts-kpi-val" id="ts-kpi-winrate">72.7%</div>
              <div class="ts-kpi-sub" id="ts-kpi-winloss-count">16W - 6L</div>
            </div>
            <div>
              <div class="ts-bar-dual">
                <div class="ts-bar-dual-green" id="ts-kpi-winbar" style="width: 72.7%;"></div>
                <div class="ts-bar-dual-red" id="ts-kpi-lossbar" style="width: 27.3%;"></div>
              </div>
              <div class="ts-kpi-split-foot">
                <span style="color: #10b981;" id="ts-kpi-wins-label">16 wins</span>
                <span style="color: #ef4444;" id="ts-kpi-losses-label">6 losses</span>
              </div>
            </div>
          </div>

          <!-- Card 2: AVG WIN/LOSS -->
          <div class="ts-kpi-card">
            <div>
              <div class="ts-kpi-head"><span>AVG WIN/LOSS</span></div>
              <div class="ts-kpi-val" id="ts-kpi-avg-winloss">$131.59</div>
              <div class="ts-kpi-sub">Per trade</div>
            </div>
            <div>
              <div class="ts-sub-bar-row">
                <span style="color: #10b981; font-weight: 700; width: 62px;" id="ts-kpi-avg-win-val">+$250.31</span>
                <div class="ts-sub-bar-track"><div style="height: 100%; width: 75%; background: #10b981; border-radius: 2px;"></div></div>
              </div>
              <div class="ts-sub-bar-row">
                <span style="color: #ef4444; font-weight: 700; width: 62px;" id="ts-kpi-avg-loss-val">-$185.00</span>
                <div class="ts-sub-bar-track"><div style="height: 100%; width: 55%; background: #ef4444; border-radius: 2px;"></div></div>
              </div>
            </div>
          </div>

          <!-- Card 3: LONG VS SHORT -->
          <div class="ts-kpi-card">
            <div>
              <div class="ts-kpi-head"><span>LONG VS SHORT</span></div>
              <div class="ts-kpi-val green" id="ts-kpi-ls-total">+$2,895</div>
              <div class="ts-kpi-sub">Total PnL</div>
            </div>
            <div>
              <div class="ts-sub-bar-row">
                <span style="color: #8c93a3; font-weight: 700;">L</span>
                <div class="ts-sub-bar-track"><div style="height: 100%; width: 68%; background: #10b981; border-radius: 2px;"></div></div>
                <span style="color: #10b981; font-weight: 700;" id="ts-kpi-long-val">+$1,630 &gt;</span>
              </div>
              <div class="ts-sub-bar-row">
                <span style="color: #8c93a3; font-weight: 700;">S</span>
                <div class="ts-sub-bar-track"><div style="height: 100%; width: 52%; background: #10b981; border-radius: 2px;"></div></div>
                <span style="color: #10b981; font-weight: 700;" id="ts-kpi-short-val">+$1,265 &gt;</span>
              </div>
            </div>
          </div>

          <!-- Card 4: MAX STREAKS -->
          <div class="ts-kpi-card">
            <div>
              <div class="ts-kpi-head"><span>MAX STREAKS</span></div>
              <div class="ts-kpi-val green" id="ts-kpi-streak-val">6</div>
              <div class="ts-kpi-sub">Best win streak</div>
            </div>
            <div>
              <div style="display: flex; justify-content: space-between; font-size: 10px; margin-bottom: 3px;">
                <span style="color: #8c93a3;">Consecutive wins</span>
                <strong style="color: #10b981;" id="ts-kpi-streak-win">6</strong>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 10px;">
                <span style="color: #8c93a3;">Consecutive losses</span>
                <strong style="color: #ef4444;" id="ts-kpi-streak-loss">1</strong>
              </div>
            </div>
          </div>

          <!-- Card 5: AVG DURATION -->
          <div class="ts-kpi-card">
            <div>
              <div class="ts-kpi-head"><span>AVG DURATION</span></div>
              <div class="ts-kpi-val" id="ts-kpi-avg-duration">2h 20m</div>
              <div class="ts-kpi-sub">Per trade</div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 9.5px; color: #8c93a3; margin-top: 4px;">
              <span>Fastest: <strong style="color: #fff;">14m</strong></span>
              <span>Longest: <strong style="color: #fff;">8h 15m</strong></span>
            </div>
          </div>
        </div>

        <!-- Section 3: 4 Performance & Sparkline Cards -->
        <div class="ts-perf-grid">
          <!-- Card 1: Tradesyncer Score -->
          <div class="ts-perf-card">
            <div class="ts-perf-head">
              <span>TRADESYNCER SCORE</span>
              <span class="ts-score-badge" id="ts-score-badge-val">50 / 100</span>
            </div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 4px;">
              <svg width="100" height="90" viewBox="0 0 100 90">
                <polygon points="50,15 85,75 15,75" fill="none" stroke="#262a38" stroke-width="1.2" />
                <polygon points="50,30 72,70 28,70" fill="none" stroke="#1f2330" stroke-width="1" />
                <line x1="50" y1="15" x2="50" y2="75" stroke="#262a38" stroke-width="0.8" stroke-dasharray="2,2" />
                <polygon points="50,22 75,68 30,72" fill="rgba(56, 189, 248, 0.25)" stroke="#38bdf8" stroke-width="1.8" />
                <text x="50" y="10" fill="#8c93a3" font-size="7.5" font-weight="700" text-anchor="middle">R/W</text>
                <text x="94" y="80" fill="#8c93a3" font-size="7.5" font-weight="700" text-anchor="end">Win %</text>
                <text x="6" y="80" fill="#8c93a3" font-size="7.5" font-weight="700">P.F.</text>
              </svg>
              <div style="flex: 1; margin-left: 12px; display: flex; flex-direction: column; gap: 6px;">
                <div>
                  <div style="display: flex; justify-content: space-between; font-size: 9.5px; font-weight: 700; color: #8c93a3;">
                    <span>BIAS</span><span style="color: #fff;">73</span>
                  </div>
                  <div style="height: 3px; background: #202430; border-radius: 2px; overflow: hidden; margin-top: 2px;">
                    <div style="width: 73%; height: 100%; background: #38bdf8;"></div>
                  </div>
                </div>
                <div>
                  <div style="display: flex; justify-content: space-between; font-size: 9.5px; font-weight: 700; color: #8c93a3;">
                    <span>R/R</span><span style="color: #fff;">45</span>
                  </div>
                  <div style="height: 3px; background: #202430; border-radius: 2px; overflow: hidden; margin-top: 2px;">
                    <div style="width: 45%; height: 100%; background: #a855f7;"></div>
                  </div>
                </div>
                <div>
                  <div style="display: flex; justify-content: space-between; font-size: 9.5px; font-weight: 700; color: #8c93a3;">
                    <span>P.F.</span><span style="color: #fff;">34</span>
                  </div>
                  <div style="height: 3px; background: #202430; border-radius: 2px; overflow: hidden; margin-top: 2px;">
                    <div style="width: 34%; height: 100%; background: #10b981;"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Card 2: DAILY CUMULATIVE PNL -->
          <div class="ts-perf-card">
            <div class="ts-perf-head">
              <span>DAILY CUMULATIVE PNL</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>
            </div>
            <div class="ts-perf-val" id="ts-cum-pnl-val">+$2,895</div>
            <svg class="ts-sparkline-svg" viewBox="0 0 180 50">
              <defs>
                <linearGradient id="tsGradCum" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#10b981" stop-opacity="0.35"/>
                  <stop offset="100%" stop-color="#10b981" stop-opacity="0.0"/>
                </linearGradient>
              </defs>
              <path d="M 0 45 L 20 40 L 45 36 L 70 28 L 95 24 L 120 18 L 145 12 L 175 6 L 175 50 L 0 50 Z" fill="url(#tsGradCum)" />
              <path d="M 0 45 L 20 40 L 45 36 L 70 28 L 95 24 L 120 18 L 145 12 L 175 6" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" />
              <circle cx="175" cy="6" r="3" fill="#10b981" />
            </svg>
          </div>

          <!-- Card 3: DRAWDOWN -->
          <div class="ts-perf-card">
            <div class="ts-perf-head">
              <span>DRAWDOWN</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"></polyline><polyline points="17 18 23 18 23 12"></polyline></svg>
            </div>
            <div class="ts-perf-val red" id="ts-dd-val">-$150.00 <span style="font-size: 11px; font-weight: 500; color: #8c93a3;">current</span></div>
            <svg class="ts-sparkline-svg" viewBox="0 0 180 50">
              <defs>
                <linearGradient id="tsGradDD" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#ef4444" stop-opacity="0.3"/>
                  <stop offset="100%" stop-color="#ef4444" stop-opacity="0.0"/>
                </linearGradient>
              </defs>
              <path d="M 0 8 L 35 8 L 70 12 L 105 10 L 140 14 L 165 42 L 175 44 L 175 50 L 0 50 Z" fill="url(#tsGradDD)" />
              <path d="M 0 8 L 35 8 L 70 12 L 105 10 L 140 14 L 165 42 L 175 44" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" />
              <circle cx="175" cy="44" r="3" fill="#ef4444" />
            </svg>
          </div>

          <!-- Card 4: P&L -->
          <div class="ts-perf-card">
            <div class="ts-perf-head">
              <span>PNL</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>
            </div>
            <div class="ts-perf-val" id="ts-today-pnl-val">+$250</div>
            <svg class="ts-sparkline-svg" viewBox="0 0 180 50">
              <path d="M 0 35 Q 25 15, 50 25 T 100 20 T 140 10 T 175 6" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" />
              <circle cx="175" cy="6" r="3" fill="#10b981" />
            </svg>
          </div>
        </div>

        <!-- Section 4: Interactive Tradesyncer Calendar View -->
        <div class="ts-calendar-card">
          <div class="ts-cal-header">
            <div class="ts-cal-brand">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2">
                <circle cx="9" cy="12" r="5"></circle>
                <circle cx="15" cy="12" r="5"></circle>
              </svg>
              <span>Tradesync Tradesyncer Calendar</span>
            </div>
            <div class="ts-cal-nav">
              <button class="ts-cal-nav-btn" id="btn-ts-prev-month" title="Previous month">&lt;</button>
              <div class="ts-cal-nav-title" id="ts-cal-title">March 2026</div>
              <button class="ts-cal-nav-btn" id="btn-ts-next-month" title="Next month">&gt;</button>
            </div>
            <div>
              <button class="ts-btn-outline" id="btn-ts-journal-card" style="font-size: 11px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
                Journal Card
              </button>
            </div>
          </div>

          <!-- 8-Column Calendar Grid -->
          <div class="ts-cal-grid" id="ts-cal-grid-body">
            <!-- Headers and Cells will be dynamically generated by JS -->
          </div>
        </div>
      </div>
    </div>

    <!-- Day Journal Detail Modal -->
    <div class="ts-modal-overlay" id="ts-modal-overlay">
      <div class="ts-modal-box">
        <div class="ts-modal-head">
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
            <strong style="font-size: 14px; color: #fff;" id="ts-modal-date-title">Trade Details — March 19, 2026</strong>
          </div>
          <button id="btn-ts-modal-close" style="background: transparent; border: none; color: #8c93a3; font-size: 18px; cursor: pointer; padding: 0 4px;">✕</button>
        </div>
        <div id="ts-modal-summary" style="display: flex; gap: 12px; margin-bottom: 14px;"></div>
        <div id="ts-modal-trades-list"></div>
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
    <div style="display: flex; align-items: center; gap: 12px;">
      <span>Engine: <strong>@mathieuc/tradingview</strong> (D:\\TradingView-API)</span>
      <span id="session-auto-save-badge" style="font-size: 10px; color: #38bdf8; display: inline-flex; align-items: center; gap: 4px; background: rgba(56, 189, 248, 0.08); padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.2);">
        <span>💾</span> <span id="session-auto-save-text">Session Auto-Save: Active</span>
      </span>
    </div>
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
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
        if (btn.dataset.target === 'view-journal' && typeof renderJournalDashboard === 'function') {
          renderJournalDashboard();
        }
      });
    });

    // --- Universal Token Price Formatter & Chart Precision Engine ---
    function formatTokenPrice(p) {
      if (typeof p !== 'number' || isNaN(p)) return '--';
      const abs = Math.abs(p);
      if (abs >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (abs >= 1) return p.toFixed(abs < 10 ? 3 : 2);
      if (abs >= 0.1) return p.toFixed(4);
      if (abs >= 0.001) return p.toFixed(6);
      if (abs >= 0.00001) return p.toFixed(7);
      return p.toFixed(8);
    }
    const fmtP = formatTokenPrice;
    const formatPrice = formatTokenPrice;

    function autoAdjustChartPrecision(candles) {
      if (!candles || candles.length === 0) return;
      const lastCandle = candles[candles.length - 1];
      const p = Math.abs(lastCandle.close || lastCandle.open || 1);
      let precision = 2;
      let minMove = 0.01;

      if (p < 0.00001) {
        precision = 8;
        minMove = 0.00000001;
      } else if (p < 0.0001) {
        precision = 7;
        minMove = 0.0000001;
      } else if (p < 0.001) {
        precision = 6;
        minMove = 0.000001;
      } else if (p < 0.01) {
        precision = 5;
        minMove = 0.00001;
      } else if (p < 0.1) {
        precision = 4;
        minMove = 0.0001;
      } else if (p < 10) {
        precision = 3;
        minMove = 0.001;
      } else {
        precision = 2;
        minMove = 0.01;
      }

      if (typeof candleSeries !== 'undefined' && candleSeries.applyOptions) {
        candleSeries.applyOptions({
          priceFormat: {
            type: 'price',
            precision: precision,
            minMove: minMove,
          },
        });
      }
    }

    let currentSymbol = 'BINANCE:BTCUSDT';
    let currentTimeframe = 'D';
    let eventSource = null;
    let lastLoadedCandle = null;
    let currentCandlesCache = [];

    // --- Proliquid Trading & Execution Dock Variables ---
    let currentDockCoin = 'BTC';
    let currentDockPrice = 80000;
    let currentDockOrderType = 'MARKET';
    let currentDockMode = 'PAPER';
    let isReduceOnly = false;
    let isTpSlActive = false;
    let dockAvailableBalance = 10000;

    function syncDockCoin(sym) {
      let c = (sym || 'BTC').toUpperCase();
      if (c.includes(':')) c = c.split(':')[1];
      c = c.replace(/USDT|USDC|USD|\.P|_/gi, '').trim() || 'BTC';
      currentDockCoin = c;
      const coinBadge = document.getElementById('ob-coin-badge');
      const scrBadge = document.getElementById('scr-coin-badge');
      const denomBadge = document.getElementById('exec-coin-denom');
      if (coinBadge) coinBadge.textContent = c;
      if (scrBadge) scrBadge.textContent = c;
      if (denomBadge) denomBadge.textContent = c;
      if (typeof subscribeHlWebSocket === 'function') subscribeHlWebSocket(c);
      if (typeof updateDockData === 'function') updateDockData();
      if (typeof updateTickerBar === 'function') updateTickerBar(c);
      if (typeof updateExecutionLabels === 'function') updateExecutionLabels();
    }

    // --- Technical Indicator Calculations & Math Library ---
    function normalCDF(z) {
      const t = 1 / (1 + 0.2316419 * Math.abs(z));
      const d = 0.3989422804014327 * Math.exp(-z * z / 2);
      const prob = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
      return z > 0 ? 1 - prob : prob;
    }

    function fmtVol(v) {
      const abs = Math.abs(v || 0);
      const sign = (v || 0) < 0 ? '-' : '';
      if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + 'B';
      if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'M';
      if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + 'K';
      return sign + abs.toFixed(1);
    }

    // 1. FiboRadar
    let fiboEnabled = true;
    let fiboPeriod = 200;
    let fiboPriceLines = [];

    function clearFiboLines() {
      fiboPriceLines.forEach(l => {
        try { candleSeries.removePriceLine(l); } catch (e) {}
      });
      fiboPriceLines = [];
    }

    // 2. Galton Volume Profile (ata_sabanci)
    let galtonEnabled = false;
    let galtonPeriod = 100;
    let galtonEngine = 'BVC'; // 'BVC' or 'GEOMETRIC'
    let galtonPriceLines = [];

    function clearGaltonLines() {
      galtonPriceLines.forEach(l => {
        try { candleSeries.removePriceLine(l); } catch (e) {}
      });
      galtonPriceLines = [];
    }

    function updateGaltonProfile(candles) {
      clearGaltonLines();
      const hud = document.getElementById('galton-hud');
      if (!galtonEnabled || !candles || candles.length < 5) {
        if (hud) hud.style.display = 'none';
        return;
      }
      if (hud) hud.style.display = 'block';

      const slice = candles.slice(-Math.min(candles.length, galtonPeriod));
      const n = slice.length;

      // Price differences and standard deviation for BVC
      let deltaPs = [];
      for (let i = 1; i < n; i++) {
        deltaPs.push(slice[i].close - slice[i - 1].close);
      }
      const meanDP = deltaPs.reduce((a, b) => a + b, 0) / Math.max(1, deltaPs.length);
      const varianceDP = deltaPs.reduce((a, b) => a + Math.pow(b - meanDP, 2), 0) / Math.max(1, deltaPs.length);
      const stdDP = Math.sqrt(varianceDP) || 0.0001;

      // Price boundaries
      let minLow = Infinity, maxHigh = -Infinity;
      slice.forEach(c => {
        if (c.low < minLow) minLow = c.low;
        if (c.high > maxHigh) maxHigh = c.high;
      });
      if (maxHigh <= minLow) return;

      const binCount = 40;
      const binStep = (maxHigh - minLow) / binCount;
      let buyBins = new Array(binCount).fill(0);
      let sellBins = new Array(binCount).fill(0);

      let totalBuyVol = 0, totalSellVol = 0;

      for (let i = 0; i < n; i++) {
        const c = slice[i];
        const prevC = i > 0 ? slice[i - 1].close : c.open;
        const vol = c.volume || 1;
        const dp = c.close - prevC;

        let buyRatio = 0.5;
        if (galtonEngine === 'BVC') {
          const z = dp / stdDP;
          buyRatio = normalCDF(z);
        } else {
          const range = c.high - c.low;
          buyRatio = range > 0 ? (c.close - c.low) / range : 0.5;
        }
        const buyVol = vol * buyRatio;
        const sellVol = vol * (1 - buyRatio);
        totalBuyVol += buyVol;
        totalSellVol += sellVol;

        // Galton binomial/Gaussian distribution outward from Close
        const candleSpread = Math.max(c.high - c.low, binStep) / 3.0;
        const twoSigSq = 2 * Math.pow(candleSpread, 2);

        let weights = [];
        let sumW = 0;
        for (let k = 0; k < binCount; k++) {
          const binCenter = minLow + (k + 0.5) * binStep;
          if (binCenter >= c.low - binStep && binCenter <= c.high + binStep) {
            const dist = binCenter - c.close;
            const w = Math.exp(- (dist * dist) / twoSigSq);
            weights.push({ k, w });
            sumW += w;
          }
        }

        if (sumW > 0) {
          weights.forEach(item => {
            const normW = item.w / sumW;
            buyBins[item.k] += buyVol * normW;
            sellBins[item.k] += sellVol * normW;
          });
        }
      }

      // Galton POC
      let maxBinVol = -1, pocIdx = 0;
      let totBins = new Array(binCount);
      let sumPeriodVol = 0;
      for (let k = 0; k < binCount; k++) {
        totBins[k] = buyBins[k] + sellBins[k];
        sumPeriodVol += totBins[k];
        if (totBins[k] > maxBinVol) {
          maxBinVol = totBins[k];
          pocIdx = k;
        }
      }
      const pocPrice = minLow + (pocIdx + 0.5) * binStep;

      // Value Area (70%)
      const targetVA = sumPeriodVol * 0.70;
      let vaVol = totBins[pocIdx];
      let upIdx = pocIdx, downIdx = pocIdx;
      while (vaVol < targetVA && (upIdx < binCount - 1 || downIdx > 0)) {
        const nextUp = upIdx < binCount - 1 ? totBins[upIdx + 1] : 0;
        const nextDown = downIdx > 0 ? totBins[downIdx - 1] : 0;
        if (nextUp >= nextDown && upIdx < binCount - 1) {
          upIdx++;
          vaVol += totBins[upIdx];
        } else if (downIdx > 0) {
          downIdx--;
          vaVol += totBins[downIdx];
        } else if (upIdx < binCount - 1) {
          upIdx++;
          vaVol += totBins[upIdx];
        } else {
          break;
        }
      }
      const valPrice = minLow + (downIdx + 0.5) * binStep;
      const vahPrice = minLow + (upIdx + 0.5) * binStep;

      // Chart Price Lines
      const pocLine = candleSeries.createPriceLine({
        price: pocPrice,
        color: '#fbbf24',
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: 'Galton POC',
      });
      galtonPriceLines.push(pocLine);

      const vahLine = candleSeries.createPriceLine({
        price: vahPrice,
        color: '#38bdf8',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Galton VAH',
      });
      galtonPriceLines.push(vahLine);

      const valLine = candleSeries.createPriceLine({
        price: valPrice,
        color: '#38bdf8',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Galton VAL',
      });
      galtonPriceLines.push(valLine);

      // Update HUD
      const deltaVol = totalBuyVol - totalSellVol;
      const totVol = Math.max(1, totalBuyVol + totalSellVol);
      const buyPct = Math.round((totalBuyVol / totVol) * 100);
      const sellPct = 100 - buyPct;

      const flowDeltaEl = document.getElementById('galton-flow-delta');
      if (flowDeltaEl) {
        flowDeltaEl.textContent = (deltaVol >= 0 ? '+' : '') + fmtVol(deltaVol) + ' (' + buyPct + '% Buy)';
        flowDeltaEl.style.color = deltaVol >= 0 ? '#38bdf8' : '#ff1744';
      }
      const buyBar = document.getElementById('galton-buy-bar');
      const sellBar = document.getElementById('galton-sell-bar');
      if (buyBar && sellBar) {
        buyBar.style.width = buyPct + '%';
        sellBar.style.width = sellPct + '%';
      }
      const pocEl = document.getElementById('galton-poc');
      const vahEl = document.getElementById('galton-vah');
      const valEl = document.getElementById('galton-val');
      if (pocEl) pocEl.textContent = '$' + fmtP(pocPrice);
      if (vahEl) vahEl.textContent = '$' + fmtP(vahPrice);
      if (valEl) valEl.textContent = '$' + fmtP(valPrice);

      const engineBadge = document.getElementById('galton-engine-badge');
      if (engineBadge) engineBadge.textContent = galtonEngine;

      // Mini Profile Bars
      const barsContainer = document.getElementById('galton-profile-bars');
      if (barsContainer) {
        let rowsHtml = '';
        const stepSample = Math.max(1, Math.floor(binCount / 8));
        for (let k = binCount - 1; k >= 0; k -= stepSample) {
          const bV = buyBins[k] || 0;
          const sV = sellBins[k] || 0;
          const tot = bV + sV;
          const pct = maxBinVol > 0 ? (tot / maxBinVol) * 100 : 0;
          const isPoc = k === pocIdx;
          const pLabel = fmtP(minLow + (k + 0.5) * binStep);
          const bPct = ((bV / Math.max(1, tot)) * pct).toFixed(1);
          const sPct = ((sV / Math.max(1, tot)) * pct).toFixed(1);
          const pColor = isPoc ? "#fbbf24" : "#64748b";
          const pWeight = isPoc ? "800" : "400";
          rowsHtml += '<div style="display: flex; align-items: center; gap: 4px; height: 7px;">' +
            '<div style="width: 28px; font-size: 7.5px; color: ' + pColor + '; text-align: right; font-weight: ' + pWeight + ';">' + pLabel + '</div>' +
            '<div style="flex: 1; height: 100%; background: #1e293b; border-radius: 2px; overflow: hidden; display: flex;">' +
              '<div style="width: ' + bPct + '%; background: #2979ff; height: 100%;"></div>' +
              '<div style="width: ' + sPct + '%; background: #ff1744; height: 100%;"></div>' +
            '</div></div>';
        }
        barsContainer.innerHTML = rowsHtml;
      }
    }

    // 3. Volume Footprint: Math & Geometry (ata_sabanci)
    let footprintEnabled = false;
    let footprintWindow = 5;
    let footprintImbalance = 3.0;
    let footprintPriceLines = [];

    function clearFootprintLines() {
      footprintPriceLines.forEach(l => {
        try { candleSeries.removePriceLine(l); } catch (e) {}
      });
      footprintPriceLines = [];
    }

    function updateVolumeFootprint(candles) {
      clearFootprintLines();
      const hud = document.getElementById('footprint-hud');
      if (!footprintEnabled || !candles || candles.length < 3) {
        if (hud) hud.style.display = 'none';
        return;
      }
      if (hud) hud.style.display = 'block';

      const slice = candles.slice(-Math.min(candles.length, footprintWindow));
      const curBar = slice[slice.length - 1];

      // Current bar Buy/Sell
      const curRange = curBar.high - curBar.low;
      const curBuyRatio = curRange > 0 ? (curBar.close - curBar.low) / curRange : 0.5;
      const curBuyVol = (curBar.volume || 1) * curBuyRatio;
      const curSellVol = (curBar.volume || 1) * (1 - curBuyRatio);
      const curDelta = curBuyVol - curSellVol;

      // Window totals
      let winBuyVol = 0, winSellVol = 0;
      let minLow = Infinity, maxHigh = -Infinity;
      slice.forEach(c => {
        if (c.low < minLow) minLow = c.low;
        if (c.high > maxHigh) maxHigh = c.high;
        const r = c.high - c.low;
        const bR = r > 0 ? (c.close - c.low) / r : 0.5;
        winBuyVol += (c.volume || 1) * bR;
        winSellVol += (c.volume || 1) * (1 - bR);
      });
      const winTotVol = winBuyVol + winSellVol;
      const winDelta = winBuyVol - winSellVol;

      // Price rows for Gaussian footprint
      const rowCount = 20;
      const rowStep = (maxHigh - minLow) / rowCount;
      let rowBuys = new Array(rowCount).fill(0);
      let rowSells = new Array(rowCount).fill(0);

      slice.forEach(c => {
        const vol = c.volume || 1;
        const r = c.high - c.low;
        const bR = r > 0 ? (c.close - c.low) / r : 0.5;
        const bV = vol * bR;
        const sV = vol * (1 - bR);
        const sigma = Math.max(r, rowStep) / 3.0; // Volume Concentration = 3.0
        const twoSigSq = 2 * sigma * sigma;

        let weights = [];
        let sumW = 0;
        for (let rIdx = 0; rIdx < rowCount; rIdx++) {
          const price = minLow + (rIdx + 0.5) * rowStep;
          if (price >= c.low - rowStep && price <= c.high + rowStep) {
            const dist = price - c.close;
            const w = Math.exp(- (dist * dist) / twoSigSq);
            weights.push({ rIdx, w });
            sumW += w;
          }
        }
        if (sumW > 0) {
          weights.forEach(item => {
            const normW = item.w / sumW;
            rowBuys[item.rIdx] += bV * normW;
            rowSells[item.rIdx] += sV * normW;
          });
        }
      });

      // Diagonal Imbalances
      let buyImbCount = 0, sellImbCount = 0;
      for (let rIdx = 1; rIdx < rowCount; rIdx++) {
        if (rowBuys[rIdx] > (rowSells[rIdx - 1] * footprintImbalance) && rowBuys[rIdx] > 10) {
          buyImbCount++;
        }
        if (rowSells[rIdx - 1] > (rowBuys[rIdx] * footprintImbalance) && rowSells[rIdx - 1] > 10) {
          sellImbCount++;
        }
      }

      // Window POC
      let maxRowVol = -1, winPocIdx = 0;
      let totRows = new Array(rowCount);
      let overlapMin = 0, overlapMax = 0;

      for (let rIdx = 0; rIdx < rowCount; rIdx++) {
        totRows[rIdx] = rowBuys[rIdx] + rowSells[rIdx];
        overlapMin += Math.min(rowBuys[rIdx], rowSells[rIdx]);
        overlapMax += Math.max(rowBuys[rIdx], rowSells[rIdx]);
        if (totRows[rIdx] > maxRowVol) {
          maxRowVol = totRows[rIdx];
          winPocIdx = rIdx;
        }
      }

      const footprintPocPrice = minLow + (winPocIdx + 0.5) * rowStep;
      const ovlScore = overlapMax > 0 ? (overlapMin / overlapMax) : 1.0;

      // Value Area (70%)
      const targetVA = winTotVol * 0.70;
      let vaVol = totRows[winPocIdx];
      let upIdx = winPocIdx, downIdx = winPocIdx;
      while (vaVol < targetVA && (upIdx < rowCount - 1 || downIdx > 0)) {
        const nextUp = upIdx < rowCount - 1 ? totRows[upIdx + 1] : 0;
        const nextDown = downIdx > 0 ? totRows[downIdx - 1] : 0;
        if (nextUp >= nextDown && upIdx < rowCount - 1) {
          upIdx++;
          vaVol += totRows[upIdx];
        } else if (downIdx > 0) {
          downIdx--;
          vaVol += totRows[downIdx];
        } else if (upIdx < rowCount - 1) {
          upIdx++;
          vaVol += totRows[upIdx];
        } else {
          break;
        }
      }
      const footprintValPrice = minLow + (downIdx + 0.5) * rowStep;
      const footprintVahPrice = minLow + (upIdx + 0.5) * rowStep;

      // Chart Price Lines
      const pocLine = candleSeries.createPriceLine({
        price: footprintPocPrice,
        color: '#60a5fa',
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: 'Footprint POC',
      });
      footprintPriceLines.push(pocLine);

      const vahLine = candleSeries.createPriceLine({
        price: footprintVahPrice,
        color: '#818cf8',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Footprint VAH',
      });
      footprintPriceLines.push(vahLine);

      const valLine = candleSeries.createPriceLine({
        price: footprintValPrice,
        color: '#818cf8',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Footprint VAL',
      });
      footprintPriceLines.push(valLine);

      // Update HUD
      const winBadge = document.getElementById('footprint-window-badge');
      if (winBadge) winBadge.textContent = footprintWindow + ' BARS';

      const barVolEl = document.getElementById('footprint-bar-vol');
      const barDeltaEl = document.getElementById('footprint-bar-delta');
      if (barVolEl) barVolEl.textContent = fmtVol(curBar.volume || 0);
      if (barDeltaEl) {
        barDeltaEl.textContent = (curDelta >= 0 ? '+' : '') + fmtVol(curDelta) + ' (' + (curDelta >= 0 ? 'BUY' : 'SELL') + ')';
        barDeltaEl.style.color = curDelta >= 0 ? '#4ade80' : '#ef5350';
      }

      const winVolEl = document.getElementById('footprint-win-vol');
      const winDeltaEl = document.getElementById('footprint-win-delta');
      if (winVolEl) winVolEl.textContent = fmtVol(winTotVol);
      if (winDeltaEl) {
        winDeltaEl.textContent = (winDelta >= 0 ? '+' : '') + fmtVol(winDelta);
        winDeltaEl.style.color = winDelta >= 0 ? '#4ade80' : '#ef5350';
      }

      const pocEl = document.getElementById('footprint-poc');
      if (pocEl) pocEl.textContent = '$' + fmtP(footprintPocPrice);

      const vaEl = document.getElementById('footprint-va');
      if (vaEl) vaEl.textContent = '$' + fmtP(footprintValPrice) + ' - $' + fmtP(footprintVahPrice);

      const imbEl = document.getElementById('footprint-imbalance-status');
      if (imbEl) {
        imbEl.textContent = buyImbCount + " ↗ Buy / " + sellImbCount + " ↘ Sell";
        imbEl.style.color = buyImbCount > sellImbCount ? '#38bdf8' : (sellImbCount > buyImbCount ? '#f87171' : '#94a3b8');
      }

      const ovlEl = document.getElementById('footprint-overlap');
      if (ovlEl) {
        const ovlPct = (ovlScore * 100).toFixed(0);
        ovlEl.textContent = ovlPct + "% (" + (ovlScore > 0.65 ? "Balanced" : "Directional") + ")";
        ovlEl.style.color = ovlScore > 0.65 ? '#fbbf24' : '#38bdf8';
      }
    }

    function clearAllIndicatorLines() {
      clearFiboLines();
      clearGaltonLines();
      clearFootprintLines();
    }

    function updateActiveIndicators(candles) {
      updateFiboRadar(candles);
      updateGaltonProfile(candles);
      updateVolumeFootprint(candles);
    }

    function updateFiboRadar(candles) {
      clearAllIndicatorLines();
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
              <span style="font-family: monospace;">\${formatTokenPrice(l.price)}</span>
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
      const vEl = document.getElementById('leg-vol');
      if (oEl && typeof c.open === 'number') oEl.textContent = formatTokenPrice(c.open);
      if (hEl && typeof c.high === 'number') hEl.textContent = formatTokenPrice(c.high);
      if (lEl && typeof c.low === 'number') lEl.textContent = formatTokenPrice(c.low);
      if (cEl && typeof c.close === 'number') {
        cEl.textContent = formatTokenPrice(c.close);
        cEl.className = c.close >= c.open ? 'val-green' : 'val-red';
      }
      if (vEl && typeof c.volume === 'number') {
        const v = c.volume;
        if (v >= 1e6) vEl.textContent = (v / 1e6).toFixed(2) + 'M';
        else if (v >= 1e3) vEl.textContent = (v / 1e3).toFixed(1) + 'K';
        else vEl.textContent = v.toFixed(1);
      }
    }

    const chartContainer = document.getElementById('chart-container');
    const chart = LightweightCharts.createChart(chartContainer, {
      layout: { background: { color: '#0f1117' }, textColor: '#8c93a3' },
      grid: { vertLines: { color: '#1a1e2a' }, horzLines: { color: '#1a1e2a' } },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      timeScale: {
        borderColor: '#2b3040',
        timeVisible: true,
        rightOffset: 52,
        barSpacing: 8,
      },
      rightPriceScale: {
        borderColor: '#2b3040',
        autoScale: true,
        scaleMargins: {
          top: 0.12,
          bottom: 0.14,
        },
      },
      handleScale: {
        axisDoubleClickReset: { time: true, price: true },
        axisPressedMouseMove: { time: true, price: true },
        mouseWheel: true,
        pinch: true,
      },
    });
    const candleSeries = chart.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350' });
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

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
        const vol = param.seriesData.get(volumeSeries);
        setLegendOHLC({
          ...candle,
          volume: vol ? vol.value : (candle.volume || 0),
        });
      }
    });

    // --- Proliquid Watchlist Logic ---
    const LOGO_MAP = {
      'BINANCE:BTCUSDT': 'crypto/XTVCBTC',
      'BTCUSDT': 'crypto/XTVCBTC',
      'BINANCE:ETHUSDT': 'crypto/XTVCETH',
      'ETHUSDT': 'crypto/XTVCETH',
      'BINANCE:ARBUSDT': 'crypto/XTVCARBI',
      'ARBUSDT': 'crypto/XTVCARBI',
      'ARB': 'crypto/XTVCARBI',
      'BYBIT:HYPEUSDT': 'crypto/XTVCHYPEH',
      'COINBASE:HYPEUSD': 'crypto/XTVCHYPEH',
      'HYPEUSD': 'crypto/XTVCHYPEH',
      'HYPEUSDT': 'crypto/XTVCHYPEH',
      'BINANCE:SOLUSDT': 'crypto/XTVCSOL',
      'SOLUSDT': 'crypto/XTVCSOL',
      'BINANCE:SUIUSDT': 'crypto/XTVCSUI',
      'SUIUSDT': 'crypto/XTVCSUI',
      'NASDAQ:SPCX': 'spacex',
      'SPCX': 'spacex',
      'BINANCE:ZECUSDT': 'crypto/XTVCZEC',
      'ZECUSDT': 'crypto/XTVCZEC',
      'BINANCE:TAOUSDT': 'crypto/XTVCTAOB',
      'TAOUSDT': 'crypto/XTVCTAOB',
      'BYBIT:VVVUSDT': 'crypto/XTVCVVV',
      'VVVUSDT.P': 'crypto/XTVCVVV',
      'VVVUSDT': 'crypto/XTVCVVV',
      'BINANCE:PUMPUSDT': 'crypto/XTVCPUMPF',
      'PUMPUSDT': 'crypto/XTVCPUMPF',
      'COINBASE:MONUSD': 'crypto/XTVCMONAD',
      'MONUSD': 'crypto/XTVCMONAD',
      'BYBIT:MNTUSDT': 'crypto/XTVCMNT',
      'MNTUSDT': 'crypto/XTVCMNT',
      'CRYPTO:NOCKUSD': 'crypto/XTVCNOCK',
      'NOCKUSD': 'crypto/XTVCNOCK',
      'CRYPTO:LITLUSD': 'crypto/XTVCLITL',
      'LITLUSD': 'crypto/XTVCLITL',
      'BINANCE:NEARUSDT': 'crypto/XTVCNEAR',
      'NEARUSDT': 'crypto/XTVCNEAR',
      'BINANCE:BNBUSDT': 'crypto/XTVCBNB',
      'BNBUSDT': 'crypto/XTVCBNB',
      'BINANCE:LINKUSDT': 'crypto/XTVCLINK',
      'LINKUSDT': 'crypto/XTVCLINK',
      'BINANCE:ZKUSDT': 'crypto/XTVCZKSY',
      'ZKUSDT': 'crypto/XTVCZKSY',
      'BINANCE:PENDLEUSDT': 'crypto/XTVCPENDLEPENDLE',
      'PENDLEUSD': 'crypto/XTVCPENDLEPENDLE',
      'BINANCE:ONDOUSDT': 'crypto/XTVCONDO',
      'ONDOUSDT': 'crypto/XTVCONDO',
      'OKX:OKBUSDT': 'crypto/XTVCOKB',
      'OKBUSDT': 'crypto/XTVCOKB',
    };

    const DEFAULT_WATCHLIST = [
      { symbol: 'BINANCE:BTCUSDT', name: 'BTCUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCBTC' },
      { symbol: 'BINANCE:ETHUSDT', name: 'ETHUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCETH' },
      { symbol: 'BYBIT:HYPEUSDT', name: 'HYPEUSD', exchange: 'BYBIT', logoId: 'crypto/XTVCHYPEH' },
      { symbol: 'METEORA:KLEDSOL_4SBYWY.USD', name: 'KLEDSOL_4!', exchange: 'METEORA' },
      { symbol: 'BINANCE:SOLUSDT', name: 'SOLUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCSOL' },
      { symbol: 'BINANCE:SUIUSDT', name: 'SUIUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCSUI' },
      { symbol: 'NASDAQ:SPCX', name: 'SPCX', exchange: 'NASDAQ', logoId: 'spacex' },
      { symbol: 'BINANCE:ZECUSDT', name: 'ZECUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCZEC' },
      { symbol: 'BINANCE:TAOUSDT', name: 'TAOUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCTAOB' },
      { symbol: 'BYBIT:VVVUSDT', name: 'VVVUSDT.P', exchange: 'BYBIT', logoId: 'crypto/XTVCVVV' },
      { symbol: 'BINANCE:PUMPUSDT', name: 'PUMPUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCPUMPF' },
      { symbol: 'COINBASE:MONUSD', name: 'MONUSD', exchange: 'COINBASE', logoId: 'crypto/XTVCMONAD' },
      { symbol: 'BYBIT:MNTUSDT', name: 'MNTUSDT', exchange: 'BYBIT', logoId: 'crypto/XTVCMNT' },
      { symbol: 'CRYPTO:NOCKUSD', name: 'NOCKUSD', exchange: 'CRYPTO', logoId: 'crypto/XTVCNOCK' },
      { symbol: 'CRYPTO:LITLUSD', name: 'LITLUSD', exchange: 'CRYPTO', logoId: 'crypto/XTVCLITL' },
      { symbol: 'ORCA:ANSEMSOL_CNTPTP.USD', name: 'ANSEMSOL_', exchange: 'ORCA' },
      { symbol: 'BINANCE:NEARUSDT', name: 'NEARUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCNEAR' },
      { symbol: 'BINANCE:BNBUSDT', name: 'BNBUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCBNB' },
      { symbol: 'BINANCE:LINKUSDT', name: 'LINKUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCLINK' },
      { symbol: 'BINANCE:ZKUSDT', name: 'ZKUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCZKSY' },
      { symbol: 'BINANCE:PENDLEUSDT', name: 'PENDLEUSD', exchange: 'BINANCE', logoId: 'crypto/XTVCPENDLEPENDLE' },
      { symbol: 'BINANCE:ONDOUSDT', name: 'ONDOUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCONDO' },
      { symbol: 'OKX:OKBUSDT', name: 'OKBUSDT', exchange: 'OKX', logoId: 'crypto/XTVCOKB' },
    ];

    let customWatchlist = [];
    try {
      const saved = localStorage.getItem('tv_custom_watchlist_v4') || localStorage.getItem('tv_custom_watchlist_v3');
      customWatchlist = saved ? JSON.parse(saved) : DEFAULT_WATCHLIST;
    } catch (e) {
      customWatchlist = DEFAULT_WATCHLIST;
    }

    // Auto-fix any incomplete or invalid symbols from previous adds (e.g. BINANCE:ARB -> BINANCE:ARBUSDT)
    customWatchlist = customWatchlist.map(item => {
      if (item.symbol === 'BINANCE:ARB' || item.name === 'ARB' || item.symbol === 'ARB') {
        return {
          symbol: 'BINANCE:ARBUSDT',
          name: 'ARBUSDT',
          exchange: 'BINANCE',
          logoId: 'crypto/XTVCARBI',
        };
      }
      if (!item.logoId && LOGO_MAP[item.symbol]) {
        item.logoId = LOGO_MAP[item.symbol];
      }
      return item;
    });
    saveWatchlist();

    const pricesCache = {};

    function saveWatchlist() {
      try {
        localStorage.setItem('tv_custom_watchlist_v4', JSON.stringify(customWatchlist));
      } catch (e) {}
    }



    function formatChgAbs(a) {
      if (typeof a !== 'number' || isNaN(a)) return '--';
      const sign = a > 0 ? '+' : '';
      if (Math.abs(a) >= 100) return sign + a.toFixed(1);
      if (Math.abs(a) >= 1) return sign + a.toFixed(2);
      if (Math.abs(a) >= 0.01) return sign + a.toFixed(3);
      return sign + a.toPrecision(3);
    }


    // --- Instant In-Memory Chart Cache for Zero-Latency Switching ---
    const clientChartCache = {};

    async function loadChart(sym, tf) {
      if (eventSource) eventSource.close();
      clearAllIndicatorLines();

      if (typeof syncDockCoin === 'function') {
        syncDockCoin(sym);
      }

      // 1. Instant Header & Ticker Update
      const titleEl = document.getElementById('active-symbol-title');
      const exEl = document.getElementById('active-exchange-badge');
      const logoEl = document.getElementById('active-symbol-logo');
      if (titleEl && exEl) {
        const parts = sym.split(':');
        const name = parts.length > 1 ? parts[1] : sym;
        const ex = parts.length > 1 ? parts[0] : 'MARKET';
        exEl.textContent = ex;
        titleEl.textContent = name;
        if (logoEl) {
          const foundItem = (typeof customWatchlist !== 'undefined') ? customWatchlist.find(w => w.symbol === sym || w.name === name) : null;
          const logo = foundItem?.logoId || ((typeof LOGO_MAP !== 'undefined') ? (LOGO_MAP[sym] || LOGO_MAP[name]) : null);
          if (logo) {
            logoEl.src = 'https://s3-symbol-logo.tradingview.com/' + logo + '.svg';
            logoEl.style.display = 'inline-block';
          } else {
            logoEl.style.display = 'none';
          }
        }
      }

      const activeKey = sym + '_' + tf;
      const targetSym = sym;
      const targetTf = tf;
      if (typeof triggerAutoSave === 'function') triggerAutoSave();

      // 2. ZERO-DELAY RENDER: If cached in memory, display immediately!
      const cached = clientChartCache[activeKey];
      if (cached && cached.candles && cached.candles.length > 0) {
        currentCandlesCache = cached.candles;
        autoAdjustChartPrecision(cached.candles);
        try { chart.priceScale('right').applyOptions({ autoScale: true }); } catch (e) {}
        candleSeries.setData(cached.candles);
        volumeSeries.setData(cached.candles.map(c => ({
          time: c.time,
          value: c.volume || 0,
          color: c.close >= c.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)',
        })));
        const len = cached.candles.length;
        try {
          chart.priceScale('right').applyOptions({ autoScale: true });
          const totalBars = 125;
          const rightOffset = 52;
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, len - (totalBars - rightOffset)),
            to: len + rightOffset,
          });
        } catch (e) {}
        lastLoadedCandle = cached.candles[len - 1];
        setLegendOHLC(lastLoadedCandle);
        updateActiveIndicators(cached.candles);
      }

      // 3. Background fetch for latest candle stream & full history
      try {
        const res = await fetch('/api/history?symbol=' + encodeURIComponent(sym) + '&timeframe=' + encodeURIComponent(tf) + '&range=5000');
        const data = await res.json();
        if (data.candles && data.candles.length > 0) {
          clientChartCache[activeKey] = { candles: data.candles, time: Date.now() };

          // Only apply if user is still on this exact symbol and timeframe
          if (currentSymbol === targetSym && currentTimeframe === targetTf) {
            currentCandlesCache = data.candles;
            autoAdjustChartPrecision(data.candles);
            try { chart.priceScale('right').applyOptions({ autoScale: true }); } catch (e) {}
            candleSeries.setData(data.candles);
            volumeSeries.setData(data.candles.map(c => ({
              time: c.time,
              value: c.volume || 0,
              color: c.close >= c.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)',
            })));
            const len = data.candles.length;
            try {
              chart.priceScale('right').applyOptions({ autoScale: true });
              const totalBars = 125;
              const rightOffset = 52;
              chart.timeScale().setVisibleLogicalRange({
                from: Math.max(0, len - (totalBars - rightOffset)),
                to: len + rightOffset,
              });
            } catch (e) {}
            lastLoadedCandle = data.candles[len - 1];
            setLegendOHLC(lastLoadedCandle);
            updateActiveIndicators(currentCandlesCache);
          }
        }
      } catch (e) {}

      // 4. Real-time candle updates
      if (currentSymbol === targetSym && currentTimeframe === targetTf) {
        eventSource = new EventSource('/api/stream?symbol=' + encodeURIComponent(sym) + '&timeframe=' + encodeURIComponent(tf));
        eventSource.onmessage = (e) => {
          const d = JSON.parse(e.data);
          if (d.candle) {
            lastLoadedCandle = d.candle;
            candleSeries.update(d.candle);
            volumeSeries.update({
              time: d.candle.time,
              value: d.candle.volume || 0,
              color: d.candle.close >= d.candle.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)',
            });
            setLegendOHLC(d.candle);
            if (currentCandlesCache.length > 0) {
              currentCandlesCache[currentCandlesCache.length - 1] = d.candle;
              updateActiveIndicators(currentCandlesCache);
            }
          }
        };
      }
    }

    // ========================================================
    // --- PERSISTENT WORKSPACE AUTO-SAVE & RESTORE ENGINE ---
    // ========================================================
    const SESSION_STORAGE_KEY = 'tv_pro_suite_session_v2';
    let sessionSaveDebounceTimer = null;

    function triggerAutoSave() {
      clearTimeout(sessionSaveDebounceTimer);
      sessionSaveDebounceTimer = setTimeout(saveCurrentSession, 300);
    }

    function saveCurrentSession() {
      try {
        const activeTabBtn = document.querySelector('.tab-btn.active');
        const activeTab = activeTabBtn ? activeTabBtn.dataset.target : 'view-chart';

        const wlSidebar = document.getElementById('watchlist-sidebar');
        const dockPanel = document.getElementById('trading-dock');
        const activeDockTab = document.querySelector('.dock-seg-btn.active');

        const session = {
          version: 2,
          lastSavedAt: new Date().toLocaleTimeString('vi-VN'),

          // 1. Navigation & Views
          activeTab: activeTab,

          // 2. Chart Market & Timeframe
          symbol: currentSymbol || 'BINANCE:BTCUSDT',
          timeframe: currentTimeframe || 'D',

          // 3. Technical Indicators
          fibo: {
            enabled: !!fiboEnabled,
            period: fiboPeriod || 200,
          },
          galton: {
            enabled: !!galtonEnabled,
            period: galtonPeriod || 100,
            engine: galtonEngine || 'BVC',
          },
          footprint: {
            enabled: !!footprintEnabled,
            window: footprintWindow || 5,
            imbalance: footprintImbalance || 3.0,
          },

          // 4. Panel Layouts
          layout: {
            watchlistVisible: wlSidebar ? wlSidebar.style.display !== 'none' : true,
            dockVisible: dockPanel ? dockPanel.style.display !== 'none' : true,
            dockTab: activeDockTab ? activeDockTab.dataset.dockTab : 'all',
          },

          // 5. Execution form
          execution: {
            orderType: currentDockOrderType || 'MARKET',
            qty: document.getElementById('input-exec-qty')?.value || '',
            notional: document.getElementById('input-exec-notional')?.value || '',
            sliderPct: document.getElementById('exec-pct-slider')?.value || '0',
            isReduceOnly: !!isReduceOnly,
            isTpSlActive: !!isTpSlActive,
            tp: document.getElementById('input-exec-tp')?.value || '',
            sl: document.getElementById('input-exec-sl')?.value || '',
          },

          // 6. Journal Mode
          journal: {
            mode: typeof currentJournalMode !== 'undefined' ? currentJournalMode : 'march2026',
          }
        };

        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));

        const badgeText = document.getElementById('session-auto-save-text');
        if (badgeText) {
          badgeText.textContent = 'Auto-Saved (' + session.lastSavedAt + ')';
        }
      } catch (e) {}
    }

    function restoreLastSession() {
      try {
        const raw = localStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) return false;
        const s = JSON.parse(raw);
        if (!s) return false;

        // 1. Restore Symbol & Timeframe
        if (s.symbol) {
          currentSymbol = s.symbol;
        }
        if (s.timeframe) {
          currentTimeframe = s.timeframe;
          document.querySelectorAll('#timeframes button').forEach(b => {
            b.classList.toggle('active', b.dataset.tf === currentTimeframe);
          });
        }

        // 2. Restore Indicators
        if (s.fibo) {
          fiboEnabled = s.fibo.enabled;
          fiboPeriod = s.fibo.period || 200;
          const btnFibo = document.getElementById('btn-toggle-fibo');
          if (btnFibo) {
            btnFibo.textContent = fiboEnabled ? 'ON' : 'OFF';
            btnFibo.className = 'btn' + (fiboEnabled ? ' active' : '');
            btnFibo.style.background = fiboEnabled ? 'rgba(168, 85, 247, 0.2)' : 'var(--bg-tertiary)';
            btnFibo.style.color = fiboEnabled ? '#c084fc' : 'var(--text-secondary)';
            btnFibo.style.borderColor = fiboEnabled ? '#a855f7' : 'transparent';
          }
          const selFibo = document.getElementById('select-fibo-period');
          if (selFibo) selFibo.value = String(fiboPeriod);
        }

        if (s.galton) {
          galtonEnabled = s.galton.enabled;
          galtonPeriod = s.galton.period || 100;
          galtonEngine = s.galton.engine || 'BVC';
          const btnGalton = document.getElementById('btn-toggle-galton');
          if (btnGalton) {
            btnGalton.textContent = galtonEnabled ? 'ON' : 'OFF';
            btnGalton.className = 'btn' + (galtonEnabled ? ' active' : '');
            btnGalton.style.background = galtonEnabled ? 'rgba(56, 189, 248, 0.2)' : 'var(--bg-tertiary)';
            btnGalton.style.color = galtonEnabled ? '#38bdf8' : 'var(--text-secondary)';
            btnGalton.style.borderColor = galtonEnabled ? '#0284c7' : 'transparent';
          }
          const selGEng = document.getElementById('select-galton-engine');
          if (selGEng) selGEng.value = galtonEngine;
          const selGPer = document.getElementById('select-galton-period');
          if (selGPer) selGPer.value = String(galtonPeriod);
        }

        if (s.footprint) {
          footprintEnabled = s.footprint.enabled;
          footprintWindow = s.footprint.window || 5;
          footprintImbalance = s.footprint.imbalance || 3.0;
          const btnFp = document.getElementById('btn-toggle-footprint');
          if (btnFp) {
            btnFp.textContent = footprintEnabled ? 'ON' : 'OFF';
            btnFp.className = 'btn' + (footprintEnabled ? ' active' : '');
            btnFp.style.background = footprintEnabled ? 'rgba(99, 102, 241, 0.2)' : 'var(--bg-tertiary)';
            btnFp.style.color = footprintEnabled ? '#818cf8' : 'var(--text-secondary)';
            btnFp.style.borderColor = footprintEnabled ? '#6366f1' : 'transparent';
          }
          const selFpWin = document.getElementById('select-footprint-window');
          if (selFpWin) selFpWin.value = String(footprintWindow);
          const selFpImb = document.getElementById('select-footprint-imbalance');
          if (selFpImb) selFpImb.value = String(footprintImbalance);
        }

        // 3. Restore Layout (Watchlist, Dock, Dock Tab)
        if (s.layout) {
          if (s.layout.watchlistVisible === false) {
            const wl = document.getElementById('watchlist-sidebar');
            if (wl) wl.style.display = 'none';
            const bWl = document.getElementById('btn-toggle-watchlist');
            if (bWl) bWl.classList.remove('active');
          }
          if (s.layout.dockVisible === false) {
            const dock = document.getElementById('trading-dock');
            if (dock) dock.style.display = 'none';
            const bDock = document.getElementById('btn-toggle-dock');
            if (bDock) bDock.classList.remove('active');
          }
          if (s.layout.dockTab) {
            const segBtn = document.querySelector('.dock-seg-btn[data-dock-tab="' + s.layout.dockTab + '"]');
            if (segBtn) segBtn.click();
          }
        }

        // 4. Restore Execution inputs
        if (s.execution) {
          if (s.execution.orderType === 'LIMIT') {
            document.getElementById('btn-ord-limit')?.click();
          }
          if (s.execution.qty) {
            const qEl = document.getElementById('input-exec-qty');
            if (qEl) qEl.value = s.execution.qty;
          }
          if (s.execution.notional) {
            const nEl = document.getElementById('input-exec-notional');
            if (nEl) nEl.value = s.execution.notional;
          }
          if (s.execution.sliderPct) {
            const slEl = document.getElementById('exec-pct-slider');
            if (slEl) {
              slEl.value = s.execution.sliderPct;
              const disp = document.getElementById('exec-pct-display');
              if (disp) disp.textContent = s.execution.sliderPct + ' %';
            }
          }
          if (s.execution.isReduceOnly) {
            document.getElementById('btn-toggle-reduce')?.click();
          }
          if (s.execution.isTpSlActive) {
            document.getElementById('btn-toggle-tpsl')?.click();
            if (s.execution.tp) {
              const tpEl = document.getElementById('input-exec-tp');
              if (tpEl) tpEl.value = s.execution.tp;
            }
            if (s.execution.sl) {
              const slEl = document.getElementById('input-exec-sl');
              if (slEl) slEl.value = s.execution.sl;
            }
          }
        }

        // 5. Restore Active Navigation Tab
        if (s.activeTab && s.activeTab !== 'view-chart') {
          const tabBtn = document.querySelector('.tab-btn[data-target="' + s.activeTab + '"]');
          if (tabBtn) tabBtn.click();
        }

        const badgeText = document.getElementById('session-auto-save-text');
        if (badgeText && s.lastSavedAt) {
          badgeText.textContent = 'Restored Session (' + s.lastSavedAt + ')';
        }

        return true;
      } catch (err) {
        return false;
      }
    }

    restoreLastSession();
    loadChart(currentSymbol, currentTimeframe);

    // FiboRadar Controls
    const btnToggleFibo = document.getElementById('btn-toggle-fibo');
    if (btnToggleFibo) {
      btnToggleFibo.addEventListener('click', () => {
        fiboEnabled = !fiboEnabled;
        btnToggleFibo.textContent = fiboEnabled ? '🎯 FiboRadar: ON' : '🎯 FiboRadar: OFF';
        btnToggleFibo.style.background = fiboEnabled ? 'rgba(168, 85, 247, 0.2)' : 'var(--bg-tertiary)';
        btnToggleFibo.style.color = fiboEnabled ? '#c084fc' : 'var(--text-secondary)';
        btnToggleFibo.style.borderColor = fiboEnabled ? '#a855f7' : 'transparent';
        updateActiveIndicators(currentCandlesCache);
      });
    }

    const selectFiboPeriod = document.getElementById('select-fibo-period');
    if (selectFiboPeriod) {
      selectFiboPeriod.addEventListener('change', () => {
        fiboPeriod = parseInt(selectFiboPeriod.value, 10) || 200;
        updateActiveIndicators(currentCandlesCache);
      });
    }

    // Galton Volume Profile Controls
    const btnToggleGalton = document.getElementById('btn-toggle-galton');
    if (btnToggleGalton) {
      btnToggleGalton.addEventListener('click', () => {
        galtonEnabled = !galtonEnabled;
        btnToggleGalton.textContent = galtonEnabled ? 'ON' : 'OFF';
        btnToggleGalton.style.background = galtonEnabled ? 'rgba(56, 189, 248, 0.2)' : 'var(--bg-tertiary)';
        btnToggleGalton.style.color = galtonEnabled ? '#38bdf8' : 'var(--text-secondary)';
        btnToggleGalton.style.borderColor = galtonEnabled ? '#0284c7' : 'transparent';
        updateGaltonProfile(currentCandlesCache);
      });
    }

    const selectGaltonEngine = document.getElementById('select-galton-engine');
    if (selectGaltonEngine) {
      selectGaltonEngine.addEventListener('change', () => {
        galtonEngine = selectGaltonEngine.value;
        updateGaltonProfile(currentCandlesCache);
      });
    }

    const selectGaltonPeriod = document.getElementById('select-galton-period');
    if (selectGaltonPeriod) {
      selectGaltonPeriod.addEventListener('change', () => {
        galtonPeriod = parseInt(selectGaltonPeriod.value, 10) || 100;
        updateGaltonProfile(currentCandlesCache);
      });
    }

    // Volume Footprint: Math & Geometry Controls
    const btnToggleFootprint = document.getElementById('btn-toggle-footprint');
    if (btnToggleFootprint) {
      btnToggleFootprint.addEventListener('click', () => {
        footprintEnabled = !footprintEnabled;
        btnToggleFootprint.textContent = footprintEnabled ? 'ON' : 'OFF';
        btnToggleFootprint.style.background = footprintEnabled ? 'rgba(99, 102, 241, 0.2)' : 'var(--bg-tertiary)';
        btnToggleFootprint.style.color = footprintEnabled ? '#818cf8' : 'var(--text-secondary)';
        btnToggleFootprint.style.borderColor = footprintEnabled ? '#6366f1' : 'transparent';
        updateVolumeFootprint(currentCandlesCache);
      });
    }

    const selectFootprintWindow = document.getElementById('select-footprint-window');
    if (selectFootprintWindow) {
      selectFootprintWindow.addEventListener('change', () => {
        footprintWindow = parseInt(selectFootprintWindow.value, 10) || 5;
        updateVolumeFootprint(currentCandlesCache);
      });
    }

    const selectFootprintImbalance = document.getElementById('select-footprint-imbalance');
    if (selectFootprintImbalance) {
      selectFootprintImbalance.addEventListener('change', () => {
        footprintImbalance = parseFloat(selectFootprintImbalance.value) || 3.0;
        updateVolumeFootprint(currentCandlesCache);
      });
    }
        function renderWatchlist(filter = '') {
      const listEl = document.getElementById('watchlist-list');
      const countEl = document.getElementById('wl-total-count');
      if (!listEl) return;

      const q = (filter || '').trim().toLowerCase();
      const filtered = customWatchlist.filter(item => {
        if (!q) return true;
        return item.name.toLowerCase().includes(q) || item.symbol.toLowerCase().includes(q) || item.exchange.toLowerCase().includes(q);
      });

      if (countEl) countEl.textContent = customWatchlist.length;

      listEl.innerHTML = filtered.map(item => {
        const pData = pricesCache[item.symbol] || {};
        const isActive = item.symbol === currentSymbol;
        const priceStr = pData.close !== undefined ? formatPrice(pData.close) : '--';
        
        const chg = pData.change !== undefined ? pData.change : null;
        const chgClass = chg !== null ? (chg >= 0 ? 'val-green' : 'val-red') : '';
        const chgStr = chg !== null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '--';

        const chgAbs = pData.change_abs !== undefined ? pData.change_abs : (chg !== null && pData.close !== undefined ? (pData.close * chg / 100) : null);
        const chgAbsStr = chgAbs !== null ? formatChgAbs(chgAbs) : '--';

        const logoId = item.logoId || LOGO_MAP[item.symbol] || LOGO_MAP[item.name];
        const initial = item.name.replace(/USDT|\.P|USD|_/gi, '').slice(0, 1).toUpperCase() || 'T';

        const logoContent = logoId ? \`
          <img src="https://s3-symbol-logo.tradingview.com/\${logoId}.svg" alt="\${item.name}" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';">
          <div class="wl-fallback" style="display:none;">\${initial}</div>
        \` : \`
          <div class="wl-fallback">\${initial}</div>
        \`;

        return \`
          <div class="wl-row \${isActive ? 'active' : ''}" data-symbol="\${item.symbol}" draggable="true" title="Hold & drag to reorder">
            <div class="wl-left">
              <span class="wl-grip" title="Hold & drag to reorder">⋮</span>
              <div class="wl-badge">
                \${logoContent}
              </div>
              <div class="wl-info">
                <div class="wl-sym">\${item.name}</div>
                <div class="wl-ex">\${item.exchange}</div>
              </div>
            </div>
            <div class="wl-cell wl-cell-last">\${priceStr}</div>
            <div class="wl-cell \${chgClass}">\${chgAbsStr}</div>
            <div class="wl-cell \${chgClass}">\${chgStr}</div>
            <span class="wl-del" data-del-symbol="\${item.symbol}" title="Remove token" draggable="false">✕</span>
          </div>
        \`;
      }).join('');
    }

    async function updateWatchlistPrices() {
      if (customWatchlist.length === 0) return;
      try {
        const symbols = customWatchlist.map(w => w.symbol);
        const res = await fetch('/api/watchlist/prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols })
        });
        const data = await res.json();
        if (data.prices) {
          Object.assign(pricesCache, data.prices);
          const filter = document.getElementById('watchlist-search')?.value || '';
          renderWatchlist(filter);
        }
      } catch (e) {}
    }

    const btnToggleWl = document.getElementById('btn-toggle-watchlist');
    const wlSidebar = document.getElementById('watchlist-sidebar');
    if (btnToggleWl && wlSidebar) {
      btnToggleWl.addEventListener('click', () => {
        const isHidden = wlSidebar.style.display === 'none';
        wlSidebar.style.display = isHidden ? 'flex' : 'none';
        btnToggleWl.classList.toggle('active', isHidden);
        setTimeout(resizeChart, 50);
      });
    }

    const btnShowAddToken = document.getElementById('btn-show-add-token');
    const addTokenContainer = document.getElementById('add-token-container');
    const inputNewSymbol = document.getElementById('input-new-symbol');
    if (btnShowAddToken && addTokenContainer) {
      btnShowAddToken.addEventListener('click', () => {
        const isHidden = addTokenContainer.style.display === 'none';
        addTokenContainer.style.display = isHidden ? 'block' : 'none';
        if (isHidden && inputNewSymbol) inputNewSymbol.focus();
      });
    }

    const searchSugBox = document.getElementById('search-suggestions');
    const addTokenHint = document.getElementById('add-token-hint');
    let searchTimer = null;

    async function fetchSuggestions(q) {
      if (!q || q.length < 1) {
        if (searchSugBox) { searchSugBox.innerHTML = ''; searchSugBox.style.display = 'none'; }
        return;
      }
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(q));
        const data = await res.json();
        if (data.symbols && data.symbols.length > 0) {
          if (searchSugBox) {
            searchSugBox.style.display = 'block';
            searchSugBox.innerHTML = data.symbols.map(s => {
              const logo = s.logoId ? \`<img src="https://s3-symbol-logo.tradingview.com/\${s.logoId}.svg" style="width: 16px; height: 16px; border-radius: 50%; object-fit: contain; vertical-align: middle; margin-right: 6px;" onerror="this.style.display='none';">\` : '';
              return \`
                <div class="search-sug-item" data-sym="\${s.symbol}" data-name="\${s.name}" data-ex="\${s.exchange}" data-logo="\${s.logoId}">
                  <div style="display: flex; align-items: center; overflow: hidden;">
                    \${logo}
                    <strong style="color: #fff; margin-right: 6px;">\${s.name}</strong>
                    <span style="color: var(--text-secondary); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">\${s.description}</span>
                  </div>
                  <span style="font-size: 9px; color: var(--accent-blue); background: rgba(41,98,255,0.15); padding: 1px 4px; border-radius: 3px; margin-left: 6px;">\${s.exchange}</span>
                </div>
              \`;
            }).join('');
          }
        } else {
          if (searchSugBox) { searchSugBox.innerHTML = ''; searchSugBox.style.display = 'none'; }
        }
      } catch (e) {}
    }

    inputNewSymbol?.addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      const val = e.target.value.trim();
      searchTimer = setTimeout(() => fetchSuggestions(val), 250);
    });

    searchSugBox?.addEventListener('click', (e) => {
      const item = e.target.closest('.search-sug-item');
      if (!item) return;
      const symbol = item.dataset.sym;
      const name = item.dataset.name;
      const exchange = item.dataset.ex;
      const logoId = item.dataset.logo || null;

      addResolvedToken(symbol, name, exchange, logoId);
    });

    function addResolvedToken(symbol, name, exchange, logoId) {
      if (!customWatchlist.some(w => w.symbol === symbol)) {
        customWatchlist.unshift({ symbol, name, exchange, logoId });
        saveWatchlist();
        renderWatchlist();
        updateWatchlistPrices();
      }

      if (inputNewSymbol) inputNewSymbol.value = '';
      if (searchSugBox) { searchSugBox.innerHTML = ''; searchSugBox.style.display = 'none'; }
      if (addTokenContainer) addTokenContainer.style.display = 'none';

      currentSymbol = symbol;
      loadChart(currentSymbol, currentTimeframe);
      renderWatchlist();
    }

    async function handleAddToken() {
      if (!inputNewSymbol) return;
      let raw = inputNewSymbol.value.trim();
      if (!raw) return;

      const btnConfirm = document.getElementById('btn-confirm-add-token');
      if (btnConfirm) btnConfirm.textContent = '...';

      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(raw));
        const data = await res.json();
        if (data.symbols && data.symbols.length > 0) {
          const match = data.symbols[0];
          addResolvedToken(match.symbol, match.name, match.exchange, match.logoId);
          if (btnConfirm) btnConfirm.textContent = 'Add';
          return;
        }
      } catch (e) {}

      // Fallback if search has no response
      let symbol = raw.toUpperCase();
      let exchange = 'BINANCE';
      let name = symbol;

      if (symbol.includes(':')) {
        const parts = symbol.split(':');
        exchange = parts[0];
        name = parts[1];
      } else {
        if (!symbol.endsWith('USDT') && !symbol.endsWith('USD')) {
          name = symbol + 'USDT';
        }
        symbol = exchange + ':' + name;
      }

      const detectedLogo = LOGO_MAP[symbol] || LOGO_MAP[name] || null;
      addResolvedToken(symbol, name, exchange, detectedLogo);
      if (btnConfirm) btnConfirm.textContent = 'Add';
    }

    document.getElementById('btn-confirm-add-token')?.addEventListener('click', handleAddToken);
    inputNewSymbol?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAddToken();
      if (e.key === 'Escape') {
        if (searchSugBox) { searchSugBox.innerHTML = ''; searchSugBox.style.display = 'none'; }
        addTokenContainer.style.display = 'none';
      }
    });

    document.getElementById('btn-refresh-wl-prices')?.addEventListener('click', updateWatchlistPrices);

    document.getElementById('watchlist-search')?.addEventListener('input', (e) => {
      renderWatchlist(e.target.value);
    });

    document.getElementById('watchlist-list')?.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.wl-del');
      if (delBtn) {
        e.stopPropagation();
        const delSym = delBtn.dataset.delSymbol;
        customWatchlist = customWatchlist.filter(w => w.symbol !== delSym);
        saveWatchlist();
        renderWatchlist(document.getElementById('watchlist-search')?.value || '');
        return;
      }

      const row = e.target.closest('.wl-row');
      if (!row) return;
      const sym = row.dataset.symbol;
      if (!sym) return;

      currentSymbol = sym;
      renderWatchlist(document.getElementById('watchlist-search')?.value || '');
      loadChart(currentSymbol, currentTimeframe);
    });

    // Smart Hover Prefetch: When user hovers on a watchlist token, prefetch its candles immediately!
    document.getElementById('watchlist-list')?.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.wl-row');
      if (!row) return;
      const sym = row.dataset.symbol;
      if (!sym) return;
      const key = sym + '_' + currentTimeframe;
      if (!clientChartCache[key]) {
        fetch('/api/history?symbol=' + encodeURIComponent(sym) + '&timeframe=' + encodeURIComponent(currentTimeframe) + '&range=5000')
          .then(r => r.json())
          .then(data => {
            if (data.candles && data.candles.length > 0) {
              clientChartCache[key] = { candles: data.candles, time: Date.now() };
            }
          }).catch(() => {});
      }
    });

    // Idle Background Prefetch: Cache top 8 tokens so clicking them is 100% instant
    setTimeout(() => {
      if (typeof customWatchlist !== 'undefined' && Array.isArray(customWatchlist)) {
        let delay = 1500;
        customWatchlist.slice(0, 8).forEach(item => {
          const key = item.symbol + '_' + currentTimeframe;
          if (!clientChartCache[key] && item.symbol !== currentSymbol) {
            setTimeout(() => {
              fetch('/api/history?symbol=' + encodeURIComponent(item.symbol) + '&timeframe=' + encodeURIComponent(currentTimeframe) + '&range=5000')
                .then(r => r.json())
                .then(data => {
                  if (data.candles && data.candles.length > 0) {
                    clientChartCache[key] = { candles: data.candles, time: Date.now() };
                  }
                }).catch(() => {});
            }, delay);
            delay += 1200;
          }
        });
      }
    }, 2000);

    // --- Watchlist Drag & Drop Reordering ---
    const wlListContainer = document.getElementById('watchlist-list');
    let draggedSymbol = null;

    if (wlListContainer) {
      wlListContainer.addEventListener('dragstart', (e) => {
        const row = e.target.closest('.wl-row');
        if (!row) return;
        draggedSymbol = row.dataset.symbol;
        row.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', draggedSymbol);
        }
      });

      wlListContainer.addEventListener('dragend', (e) => {
        const row = e.target.closest('.wl-row');
        if (row) row.classList.remove('dragging');
        wlListContainer.querySelectorAll('.wl-row').forEach(r => {
          r.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
        });
        draggedSymbol = null;
      });

      wlListContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        const row = e.target.closest('.wl-row');
        if (!row || !draggedSymbol || row.dataset.symbol === draggedSymbol) return;
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        wlListContainer.querySelectorAll('.wl-row').forEach(r => {
          if (r !== row) r.classList.remove('drag-over-top', 'drag-over-bottom');
        });
        if (e.clientY < midY) {
          row.classList.add('drag-over-top');
          row.classList.remove('drag-over-bottom');
        } else {
          row.classList.add('drag-over-bottom');
          row.classList.remove('drag-over-top');
        }
      });

      wlListContainer.addEventListener('dragleave', (e) => {
        const row = e.target.closest('.wl-row');
        if (row) row.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      wlListContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        const row = e.target.closest('.wl-row');
        wlListContainer.querySelectorAll('.wl-row').forEach(r => {
          r.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
        });
        if (!row || !draggedSymbol) return;
        const targetSymbol = row.dataset.symbol;
        if (draggedSymbol === targetSymbol) return;

        const rect = row.getBoundingClientRect();
        const isBefore = e.clientY < (rect.top + rect.height / 2);

        const fromIdx = customWatchlist.findIndex(w => w.symbol === draggedSymbol);
        if (fromIdx < 0) return;
        const [movedItem] = customWatchlist.splice(fromIdx, 1);

        let toIdx = customWatchlist.findIndex(w => w.symbol === targetSymbol);
        if (toIdx < 0) {
          customWatchlist.push(movedItem);
        } else {
          if (!isBefore) toIdx += 1;
          customWatchlist.splice(toIdx, 0, movedItem);
        }

        saveWatchlist();
        renderWatchlist(document.getElementById('watchlist-search')?.value || '');
      });
    }

    renderWatchlist();
    updateWatchlistPrices();
    setInterval(updateWatchlistPrices, 8000);

    // --- Proliquid Trading & Execution Dock Logic ---
    const btnToggleDock = document.getElementById('btn-toggle-dock');
    const tradingDockEl = document.getElementById('trading-dock');
    if (btnToggleDock && tradingDockEl) {
      btnToggleDock.addEventListener('click', () => {
        const isHidden = tradingDockEl.style.display === 'none';
        tradingDockEl.style.display = isHidden ? 'flex' : 'none';
        btnToggleDock.classList.toggle('active', isHidden);
        setTimeout(resizeChart, 50);
      });
    }

    // syncDockCoin is defined at the top scope

    // --- Hyperliquid Realtime WebSocket Streaming Engine ---
    let hlWs = null;
    let hlWsActiveCoin = null;
    let hlWsReconnectTimer = null;
    let hlWsPingTimer = null;

    function renderOrderbookData(bids, asks, bestAsk, bestBid) {
      if (!bids || !asks) return;
      if (bestAsk || bestBid) {
        currentDockPrice = bestAsk || bestBid || currentDockPrice;
        const mktPriceEl = document.getElementById('dock-market-price');
        if (mktPriceEl) mktPriceEl.textContent = '$' + (currentDockPrice >= 1 ? currentDockPrice.toLocaleString('en-US') : currentDockPrice.toFixed(4));
      }

      const asksEl = document.getElementById('ob-asks-list');
      if (asksEl && asks.length > 0) {
        let htmlAsks = '';
        const sliceAsks = asks.slice(-6);
        for (let i = 0; i < sliceAsks.length; i++) {
          const a = sliceAsks[i];
          const pxStr = formatTokenPrice(a.price);
          const szStr = a.size >= 1 ? a.size.toFixed(2) : a.size.toFixed(4);
          const totStr = a.total >= 1 ? a.total.toFixed(2) : a.total.toFixed(3);
          const w = a.depthPercent || 0;
          htmlAsks += '<div class="ob-row" data-price="' + a.price + '">' +
            '<div class="ob-bg ob-bg-ask" style="width: ' + w + '%;"></div>' +
            '<span class="ob-cell-price val-red">' + pxStr + '</span>' +
            '<span class="ob-cell" style="color: #fff;">' + szStr + '</span>' +
            '<span class="ob-cell" style="color: var(--text-secondary);">' + totStr + '</span>' +
          '</div>';
        }
        asksEl.innerHTML = htmlAsks;
      }

      const bidsEl = document.getElementById('ob-bids-list');
      if (bidsEl && bids.length > 0) {
        let htmlBids = '';
        const sliceBids = bids.slice(0, 6);
        for (let i = 0; i < sliceBids.length; i++) {
          const bid = sliceBids[i];
          const pxStr = formatTokenPrice(bid.price);
          const szStr = bid.size >= 1 ? bid.size.toFixed(2) : bid.size.toFixed(4);
          const totStr = bid.total >= 1 ? bid.total.toFixed(2) : bid.total.toFixed(3);
          const w = bid.depthPercent || 0;
          htmlBids += '<div class="ob-row" data-price="' + bid.price + '">' +
            '<div class="ob-bg ob-bg-bid" style="width: ' + w + '%;"></div>' +
            '<span class="ob-cell-price val-green">' + pxStr + '</span>' +
            '<span class="ob-cell" style="color: #fff;">' + szStr + '</span>' +
            '<span class="ob-cell" style="color: var(--text-secondary);">' + totStr + '</span>' +
          '</div>';
        }
        bidsEl.innerHTML = htmlBids;
      }

      if (asks.length > 0 && bids.length > 0) {
        const topAsk = asks[asks.length - 1].price;
        const topBid = bids[0].price;
        const spread = Math.max(0, topAsk - topBid);
        const spreadBP = topBid > 0 ? ((spread / topBid) * 10000).toFixed(2) : '0';

        const totBid = bids.reduce((acc, b) => acc + b.size, 0);
        const totAsk = asks.reduce((acc, a) => acc + a.size, 0);
        const totalVol = Math.max(0.0001, totBid + totAsk);
        const bidPct = Math.round((totBid / totalVol) * 100);
        const askPct = 100 - bidPct;

        const maxDepth = Math.max(
          bids.length > 0 ? bids[bids.length - 1].total || totBid : 0,
          asks.length > 0 ? asks[0].total || totAsk : 0
        );

        const spValEl = document.getElementById('ob-spread-val');
        if (spValEl) spValEl.textContent = 'SPREAD ' + (spread >= 1 ? spread.toFixed(2) : spread.toFixed(4));
        const spBpEl = document.getElementById('ob-spread-bp');
        if (spBpEl) spBpEl.textContent = '(' + spreadBP + 'BP)';
        const maxD = document.getElementById('ob-max-depth');
        if (maxD) maxD.textContent = maxDepth >= 1000 ? (maxDepth / 1000).toFixed(1) + 'K' : maxDepth.toFixed(2);

        const bidPctEl = document.getElementById('ob-bid-pct');
        if (bidPctEl) bidPctEl.textContent = bidPct + '%';
        const askPctEl = document.getElementById('ob-ask-pct');
        if (askPctEl) askPctEl.textContent = askPct + '%';
        const ratioBid = document.getElementById('ob-ratio-bid');
        if (ratioBid) ratioBid.style.width = bidPct + '%';
      }

      updateExecutionLabels();
    }

    function connectHlWebSocket() {
      if (typeof WebSocket === 'undefined') return;
      if (hlWs && (hlWs.readyState === WebSocket.OPEN || hlWs.readyState === WebSocket.CONNECTING)) {
        return;
      }
      try {
        hlWs = new WebSocket('wss://api.hyperliquid.xyz/ws');

        hlWs.onopen = () => {
          if (hlWsPingTimer) clearInterval(hlWsPingTimer);
          hlWsPingTimer = setInterval(() => {
            if (hlWs && hlWs.readyState === WebSocket.OPEN) {
              hlWs.send(JSON.stringify({ method: 'ping' }));
            }
          }, 30000);

          if (currentDockCoin) {
            subscribeHlWebSocket(currentDockCoin);
          }
        };

        hlWs.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (!msg || !msg.channel) return;

            // 1. L2 Orderbook stream: channel 'l2Book'
            if (msg.channel === 'l2Book' && msg.data && msg.data.coin === currentDockCoin) {
              const data = msg.data;
              if (data.levels && Array.isArray(data.levels) && data.levels.length >= 2) {
                const rawBids = data.levels[0] || [];
                const rawAsks = data.levels[1] || [];

                const bids = rawBids.map(b => ({
                  price: parseFloat(b.px),
                  size: parseFloat(b.sz),
                  orders: b.n || 1,
                })).sort((a, b) => b.price - a.price).slice(0, 8);

                const asks = rawAsks.map(a => ({
                  price: parseFloat(a.px),
                  size: parseFloat(a.sz),
                  orders: a.n || 1,
                })).sort((a, b) => b.price - a.price).slice(0, 8);

                let cumBid = 0;
                bids.forEach(b => { cumBid += b.size; b.total = cumBid; });
                let cumAsk = 0;
                for (let i = asks.length - 1; i >= 0; i--) {
                  cumAsk += asks[i].size;
                  asks[i].total = cumAsk;
                }
                const maxVol = Math.max(cumBid, cumAsk, 0.0001);
                bids.forEach(b => { b.depthPercent = Math.min(100, Math.round((b.total / maxVol) * 100)); });
                asks.forEach(a => { a.depthPercent = Math.min(100, Math.round((a.total / maxVol) * 100)); });

                const bestAsk = asks.length > 0 ? asks[asks.length - 1].price : null;
                const bestBid = bids.length > 0 ? bids[0].price : null;
                renderOrderbookData(bids, asks, bestAsk, bestBid);
              }
            }

            // 2. Realtime trades stream: channel 'trades'
            if (msg.channel === 'trades' && Array.isArray(msg.data)) {
              const trades = msg.data.filter(t => t.coin === currentDockCoin);
              if (trades.length > 0) {
                const latestTrade = trades[trades.length - 1];
                if (latestTrade && latestTrade.px) {
                  currentDockPrice = parseFloat(latestTrade.px);
                  const mktPriceEl = document.getElementById('dock-market-price');
                  if (mktPriceEl) mktPriceEl.textContent = '$' + (currentDockPrice >= 1 ? currentDockPrice.toLocaleString('en-US') : currentDockPrice.toFixed(4));
                  updateExecutionLabels();
                }
              }
            }
          } catch (e) {}
        };

        hlWs.onclose = () => {
          if (hlWsPingTimer) clearInterval(hlWsPingTimer);
          clearTimeout(hlWsReconnectTimer);
          hlWsReconnectTimer = setTimeout(connectHlWebSocket, 3000);
        };

        hlWs.onerror = () => {
          try { hlWs.close(); } catch (e) {}
        };
      } catch (err) {}
    }

    function subscribeHlWebSocket(coin) {
      if (!hlWs || hlWs.readyState !== WebSocket.OPEN) return;
      if (hlWsActiveCoin && hlWsActiveCoin !== coin) {
        try {
          hlWs.send(JSON.stringify({
            method: 'unsubscribe',
            subscription: { type: 'l2Book', coin: hlWsActiveCoin }
          }));
          hlWs.send(JSON.stringify({
            method: 'unsubscribe',
            subscription: { type: 'trades', coin: hlWsActiveCoin }
          }));
        } catch (e) {}
      }
      hlWsActiveCoin = coin;
      try {
        hlWs.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'l2Book', coin }
        }));
        hlWs.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'trades', coin }
        }));
      } catch (e) {}
    }

    async function updateDockData() {
      const c = currentDockCoin;
      // 1. Fetch Orderbook (HTTP Fallback if WS connecting)
      try {
        const res = await fetch('/api/hyperliquid/book?coin=' + encodeURIComponent(c));
        const b = await res.json();
        if (b && b.bids && b.asks) {
          renderOrderbookData(b.bids, b.asks, b.bestAsk, b.bestBid);
        }
      } catch (e) {}

      // 2. Fetch Screener
      try {
        const res = await fetch('/api/hyperliquid/screener?coin=' + encodeURIComponent(c));
        const scr = await res.json();
        if (scr && scr.m5 && scr.m15) {
          document.getElementById('scr-trades-5m').textContent = scr.m5.trades;
          document.getElementById('scr-trades-15m').textContent = scr.m15.trades;

          const chg5El = document.getElementById('scr-chg-5m');
          chg5El.textContent = scr.m5.changePercent;
          chg5El.className = 'scr-val ' + (scr.m5.rawChangePercent >= 0 ? 'val-green' : 'val-red');

          const chg15El = document.getElementById('scr-chg-15m');
          chg15El.textContent = scr.m15.changePercent;
          chg15El.className = 'scr-val ' + (scr.m15.rawChangePercent >= 0 ? 'val-green' : 'val-red');

          document.getElementById('scr-vol-5m').textContent = scr.m5.volume;
          document.getElementById('scr-vol-15m').textContent = scr.m15.volume;

          const vd5El = document.getElementById('scr-vdelta-5m');
          vd5El.textContent = scr.m5.volumeDelta;
          vd5El.className = 'scr-val ' + (scr.m5.rawVolumeDelta >= 0 ? 'val-green' : 'val-red');

          const vd15El = document.getElementById('scr-vdelta-15m');
          vd15El.textContent = scr.m15.volumeDelta;
          vd15El.className = 'scr-val ' + (scr.m15.rawVolumeDelta >= 0 ? 'val-green' : 'val-red');
        }
      } catch (e) {}

      // 3. Fetch Account
      try {
        const accountUrl = (currentDockMode === 'HYPERLIQUID_LIVE' && connectedWalletAddress)
          ? '/api/hyperliquid/account?address=' + encodeURIComponent(connectedWalletAddress)
          : '/api/hyperliquid/account';
        const res = await fetch(accountUrl);
        const acc = await res.json();
        if (acc) {
          dockAvailableBalance = acc.available || 10000;
          document.getElementById('dock-avail-bal').textContent = '$' + dockAvailableBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const matchingPos = (acc.positions || []).find(p => (p.symbol && p.symbol.includes(c)) || (p.coin === c));
          const posEl = document.getElementById('dock-active-pos');
          if (posEl) {
            if (matchingPos) {
              const sz = matchingPos.size || matchingPos.szi || 0;
              const pnl = matchingPos.unrealizedPnl || 0;
              posEl.textContent = \`\${matchingPos.side} \${sz} ($\${pnl >= 0 ? '+' : ''}\${pnl.toFixed(2)})\`;
              posEl.className = pnl >= 0 ? 'val-green' : 'val-red';
            } else {
              posEl.textContent = '--';
              posEl.className = '';
            }
          }
        }
      } catch (e) {}
    }

    function updateExecutionLabels() {
      const qtyInput = document.getElementById('input-exec-qty');
      const qty = parseFloat(qtyInput?.value) || 0;
      const price = currentDockPrice || 0;
      const priceFmt = formatTokenPrice(price);

      const buySub = document.getElementById('exec-buy-sub');
      const sellSub = document.getElementById('exec-sell-sub');
      if (buySub) buySub.textContent = qty + ' ' + currentDockCoin + ' @ $' + priceFmt;
      if (sellSub) sellSub.textContent = qty + ' ' + currentDockCoin + ' @ $' + priceFmt;
    }

    // Execution Inputs Bindings
    const inputQty = document.getElementById('input-exec-qty');
    const inputNotional = document.getElementById('input-exec-notional');
    const slider = document.getElementById('exec-pct-slider');
    const sliderDisplay = document.getElementById('exec-pct-display');

    inputQty?.addEventListener('input', () => {
      const qty = parseFloat(inputQty.value) || 0;
      if (currentDockPrice > 0) {
        inputNotional.value = (qty * currentDockPrice).toFixed(2);
      }
      updateExecutionLabels();
    });

    inputNotional?.addEventListener('input', () => {
      const notional = parseFloat(inputNotional.value) || 0;
      if (currentDockPrice > 0) {
        inputQty.value = (notional / currentDockPrice).toFixed(4);
      }
      updateExecutionLabels();
    });

    slider?.addEventListener('input', () => {
      const pct = parseInt(slider.value, 10);
      sliderDisplay.textContent = pct + ' %';
      document.querySelectorAll('.pct-chip').forEach(c => c.classList.toggle('active', parseInt(c.dataset.pct, 10) === pct));
      if (dockAvailableBalance > 0 && currentDockPrice > 0) {
        const notional = (dockAvailableBalance * pct) / 100;
        inputNotional.value = notional.toFixed(2);
        inputQty.value = (notional / currentDockPrice).toFixed(4);
        updateExecutionLabels();
      }
    });

    document.querySelectorAll('.pct-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const pct = parseInt(chip.dataset.pct, 10);
        slider.value = pct;
        sliderDisplay.textContent = pct + ' %';
        document.querySelectorAll('.pct-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        if (dockAvailableBalance > 0 && currentDockPrice > 0) {
          const notional = (dockAvailableBalance * pct) / 100;
          inputNotional.value = notional.toFixed(2);
          inputQty.value = (notional / currentDockPrice).toFixed(4);
          updateExecutionLabels();
        }
      });
    });

    // Order type toggle
    const btnOrdMarket = document.getElementById('btn-ord-market');
    const btnOrdLimit = document.getElementById('btn-ord-limit');
    const limitGroup = document.getElementById('limit-price-group');
    btnOrdMarket?.addEventListener('click', () => {
      currentDockOrderType = 'MARKET';
      btnOrdMarket.classList.add('active');
      btnOrdLimit.classList.remove('active');
      limitGroup.style.display = 'none';
    });
    btnOrdLimit?.addEventListener('click', () => {
      currentDockOrderType = 'LIMIT';
      btnOrdLimit.classList.add('active');
      btnOrdMarket.classList.remove('active');
      limitGroup.style.display = 'flex';
      document.getElementById('input-exec-price').value = currentDockPrice;
    });

    // Options toggles
    const btnReduce = document.getElementById('btn-toggle-reduce');
    btnReduce?.addEventListener('click', () => {
      isReduceOnly = !isReduceOnly;
      btnReduce.classList.toggle('active', isReduceOnly);
    });

    const btnTpsl = document.getElementById('btn-toggle-tpsl');
    const tpslBox = document.getElementById('tpsl-inputs-container');
    btnTpsl?.addEventListener('click', () => {
      isTpSlActive = !isTpSlActive;
      btnTpsl.classList.toggle('active', isTpSlActive);
      tpslBox.style.display = isTpSlActive ? 'block' : 'none';
      if (isTpSlActive && currentDockPrice > 0) {
        document.getElementById('input-exec-tp').value = (currentDockPrice * 1.015).toFixed(2);
        document.getElementById('input-exec-sl').value = (currentDockPrice * 0.992).toFixed(2);
      }
    });

    // Orderbook click row to fill price
    document.getElementById('trading-dock')?.addEventListener('click', (e) => {
      const obRow = e.target.closest('.ob-row');
      if (obRow) {
        const px = parseFloat(obRow.dataset.price);
        if (px) {
          document.getElementById('input-exec-price').value = px;
          if (currentDockOrderType === 'LIMIT') {
            const notional = parseFloat(inputNotional.value) || 0;
            if (notional > 0) inputQty.value = (notional / px).toFixed(4);
          }
        }
      }
    });

    // --- Modular Dock Tabs Navigation (All, Screener, Orderbook, Execution) ---
    document.querySelectorAll('.dock-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dock-seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.dockTab;
        const bAcc = document.getElementById('dock-block-account');
        const bScr = document.getElementById('dock-block-screener');
        const bOb = document.getElementById('dock-block-orderbook');
        const bExec = document.getElementById('dock-block-exec');

        if (tab === 'all') {
          if (bAcc) bAcc.style.display = 'flex';
          if (bScr) bScr.style.display = 'flex';
          if (bOb) bOb.style.display = 'flex';
          if (bExec) bExec.style.display = 'flex';
        } else if (tab === 'screener') {
          if (bAcc) bAcc.style.display = 'flex';
          if (bScr) bScr.style.display = 'flex';
          if (bOb) bOb.style.display = 'none';
          if (bExec) bExec.style.display = 'none';
        } else if (tab === 'orderbook') {
          if (bAcc) bAcc.style.display = 'none';
          if (bScr) bScr.style.display = 'none';
          if (bOb) bOb.style.display = 'flex';
          if (bExec) bExec.style.display = 'none';
        } else if (tab === 'exec') {
          if (bAcc) bAcc.style.display = 'flex';
          if (bScr) bScr.style.display = 'none';
          if (bOb) bOb.style.display = 'none';
          if (bExec) bExec.style.display = 'flex';
        }
      });
    });

    // --- Web3 Wallet Modal & Connection Logic ---
    let connectedWalletAddress = localStorage.getItem('hl_connected_address') || null;
    let connectedWalletType = localStorage.getItem('hl_connected_wallet') || null;

    const web3Modal = document.getElementById('web3-wallet-modal');
    const btnOpenWallet = document.getElementById('btn-dock-mode-toggle');
    const btnCloseWallet = document.getElementById('btn-close-web3-modal');
    const web3StatusMsg = document.getElementById('web3-status-msg');

    function showWeb3Status(msg, isError = false) {
      if (!web3StatusMsg) return;
      web3StatusMsg.textContent = msg;
      web3StatusMsg.style.display = 'block';
      web3StatusMsg.style.background = isError ? 'rgba(239, 83, 80, 0.15)' : 'rgba(56, 189, 248, 0.15)';
      web3StatusMsg.style.color = isError ? '#ef5350' : '#38bdf8';
      web3StatusMsg.style.border = isError ? '1px solid rgba(239, 83, 80, 0.3)' : '1px solid rgba(56, 189, 248, 0.3)';
    }

    btnOpenWallet?.addEventListener('click', () => {
      if (web3Modal) web3Modal.style.display = 'flex';
      if (web3StatusMsg) web3StatusMsg.style.display = 'none';
    });

    btnCloseWallet?.addEventListener('click', () => {
      if (web3Modal) web3Modal.style.display = 'none';
    });

    window.addEventListener('click', (e) => {
      if (e.target === web3Modal) web3Modal.style.display = 'none';
    });

    function applyWalletConnection(address, type = 'MetaMask', icon = '🦊') {
      connectedWalletAddress = address;
      connectedWalletType = type;
      localStorage.setItem('hl_connected_address', address);
      localStorage.setItem('hl_connected_wallet', type);

      currentDockMode = 'HYPERLIQUID_LIVE';

      const modeBadge = document.getElementById('account-mode-badge');
      if (modeBadge) {
        modeBadge.textContent = '● HL LIVE';
        modeBadge.className = 'badge-hl-live';
      }

      const btnLabel = document.getElementById('wallet-btn-label');
      if (btnLabel) btnLabel.textContent = address.slice(0, 6) + '...' + address.slice(-4);

      const connBar = document.getElementById('wallet-connected-bar');
      const pIcon = document.getElementById('wallet-provider-icon');
      const pAddr = document.getElementById('wallet-address-display');
      if (connBar) connBar.style.display = 'flex';
      if (pIcon) pIcon.textContent = icon;
      if (pAddr) pAddr.textContent = address.slice(0, 6) + '...' + address.slice(-4);

      if (web3Modal) web3Modal.style.display = 'none';
      updateDockData();
    }

    function disconnectWallet() {
      connectedWalletAddress = null;
      connectedWalletType = null;
      localStorage.removeItem('hl_connected_address');
      localStorage.removeItem('hl_connected_wallet');

      currentDockMode = 'PAPER';

      const modeBadge = document.getElementById('account-mode-badge');
      if (modeBadge) {
        modeBadge.textContent = '● PAPER $10K';
        modeBadge.className = 'badge-paper';
      }

      const btnLabel = document.getElementById('wallet-btn-label');
      if (btnLabel) btnLabel.textContent = 'Connect Wallet';

      const connBar = document.getElementById('wallet-connected-bar');
      if (connBar) connBar.style.display = 'none';

      if (web3Modal) web3Modal.style.display = 'none';
      updateDockData();
    }

    document.getElementById('btn-disconnect-hl-wallet')?.addEventListener('click', disconnectWallet);
    document.getElementById('btn-switch-paper-modal')?.addEventListener('click', disconnectWallet);

    document.getElementById('btn-copy-wallet')?.addEventListener('click', () => {
      if (connectedWalletAddress) {
        navigator.clipboard?.writeText(connectedWalletAddress).catch(() => {});
        alert('Copied wallet address: ' + connectedWalletAddress);
      }
    });

    // 1. MetaMask Connect
    document.getElementById('btn-connect-metamask')?.addEventListener('click', async () => {
      const provider = window.ethereum;
      if (provider) {
        try {
          showWeb3Status('Connecting to MetaMask...');
          const accounts = await provider.request({ method: 'eth_requestAccounts' });
          if (accounts && accounts[0]) {
            applyWalletConnection(accounts[0], 'MetaMask', '🦊');
          }
        } catch (err) {
          showWeb3Status(err.message || 'MetaMask connection rejected', true);
        }
      } else {
        showWeb3Status('MetaMask extension not found in this browser. Enter read-only address below.', true);
      }
    });

    // 2. Rabby Connect
    document.getElementById('btn-connect-rabby')?.addEventListener('click', async () => {
      const provider = window.rabby || (window.ethereum?.isRabby ? window.ethereum : null);
      if (provider) {
        try {
          showWeb3Status('Connecting to Rabby Wallet...');
          const accounts = await provider.request({ method: 'eth_requestAccounts' });
          if (accounts && accounts[0]) {
            applyWalletConnection(accounts[0], 'Rabby', '🐰');
          }
        } catch (err) {
          showWeb3Status(err.message || 'Rabby connection rejected', true);
        }
      } else {
        showWeb3Status('Rabby Wallet extension not detected in this browser.', true);
      }
    });

    // 3. Phantom Connect
    document.getElementById('btn-connect-phantom')?.addEventListener('click', async () => {
      const provider = window.phantom?.ethereum || window.phantom?.solana;
      if (provider) {
        try {
          showWeb3Status('Connecting to Phantom...');
          if (window.phantom?.ethereum) {
            const accounts = await window.phantom.ethereum.request({ method: 'eth_requestAccounts' });
            if (accounts && accounts[0]) {
              applyWalletConnection(accounts[0], 'Phantom', '👻');
              return;
            }
          }
          if (window.phantom?.solana) {
            const resp = await window.phantom.solana.connect();
            if (resp && resp.publicKey) {
              applyWalletConnection(resp.publicKey.toString(), 'Phantom', '👻');
            }
          }
        } catch (err) {
          showWeb3Status(err.message || 'Phantom connection rejected', true);
        }
      } else {
        showWeb3Status('Phantom wallet extension not detected in this browser.', true);
      }
    });

    // 4. Manual Read-Only Address
    document.getElementById('btn-save-hl-wallet')?.addEventListener('click', () => {
      const addr = document.getElementById('input-hl-wallet')?.value.trim();
      if (addr && addr.length > 5) {
        applyWalletConnection(addr, 'Watch-Only', '👁️');
      } else {
        showWeb3Status('Please enter a valid wallet address.', true);
      }
    });

    // Auto-restore saved wallet on reload if present
    if (connectedWalletAddress) {
      applyWalletConnection(connectedWalletAddress, connectedWalletType || 'Watch-Only', connectedWalletType === 'MetaMask' ? '🦊' : connectedWalletType === 'Rabby' ? '🐰' : connectedWalletType === 'Phantom' ? '👻' : '👁️');
    }

    // Execute Trade handler
    async function handleTradeExecution(side) {
      const qty = parseFloat(document.getElementById('input-exec-qty')?.value) || 0;
      const notional = parseFloat(document.getElementById('input-exec-notional')?.value) || 0;
      if (qty <= 0 && notional <= 0) {
        alert('Please enter a Quantity or Notional amount');
        return;
      }
      const tp = isTpSlActive ? parseFloat(document.getElementById('input-exec-tp')?.value) : null;
      const sl = isTpSlActive ? parseFloat(document.getElementById('input-exec-sl')?.value) : null;
      const price = currentDockOrderType === 'LIMIT' ? parseFloat(document.getElementById('input-exec-price')?.value) : currentDockPrice;

      try {
        const res = await fetch('/api/trade/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            coin: currentDockCoin,
            side,
            orderType: currentDockOrderType,
            size: qty,
            notional,
            price,
            mode: currentDockMode.toLowerCase(),
            reduceOnly: isReduceOnly,
            tp,
            sl,
          }),
        });
        const data = await res.json();
        if (data.error) {
          alert('Execution: ' + data.error);
        } else {
          // Success feedback
          const btn = side === 'LONG' ? document.getElementById('btn-exec-buy') : document.getElementById('btn-exec-sell');
          const orig = btn.innerHTML;
          btn.innerHTML = \`<span style="color:#fff;">✓ ORDER PLACED (\${data.mode})</span>\`;
          setTimeout(() => { btn.innerHTML = orig; }, 1500);
          updateDockData();
          refreshPaperStatus();
        }
      } catch (e) {
        alert('Trade error: ' + e.message);
      }
    }

    document.getElementById('btn-exec-buy')?.addEventListener('click', () => handleTradeExecution('LONG'));
    document.getElementById('btn-exec-sell')?.addEventListener('click', () => handleTradeExecution('SHORT'));

    syncDockCoin(currentSymbol);
    connectHlWebSocket();
    setInterval(updateDockData, 1200);

    document.getElementById('timeframes').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !btn.dataset.tf) return;
      document.querySelectorAll('#timeframes button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTimeframe = btn.dataset.tf;
      if (typeof triggerAutoSave === 'function') triggerAutoSave();
      loadChart(currentSymbol, currentTimeframe);
    });

    // --- Hyperliquid Ticker Bar & Header Logic ---
    async function updateTickerBar(coin) {
      try {
        const res = await fetch('/api/hyperliquid/ticker?coin=' + encodeURIComponent(coin));
        const t = await res.json();
        if (t && t.last) {
          const lastEl = document.getElementById('hl-stat-last');
          if (lastEl) lastEl.textContent = t.last;

          const idxEl = document.getElementById('hl-stat-index');
          if (idxEl) idxEl.textContent = t.index;

          const chgEl = document.getElementById('hl-stat-change');
          if (chgEl) {
            chgEl.textContent = t.change;
            chgEl.className = 'hl-stat-val ' + (t.rawChange >= 0 ? 'val-green' : 'val-red');
          }

          const volEl = document.getElementById('hl-stat-volume');
          if (volEl) volEl.textContent = t.volume;

          const oiEl = document.getElementById('hl-stat-oi');
          if (oiEl) oiEl.textContent = t.openInterest;

          const fundEl = document.getElementById('hl-stat-funding');
          if (fundEl) {
            fundEl.textContent = t.funding;
            fundEl.className = t.rawFunding >= 0 ? 'val-red' : 'val-green';
          }

          const mcapEl = document.getElementById('hl-stat-mcap');
          if (mcapEl) mcapEl.textContent = t.marketcap;

          const fdvEl = document.getElementById('hl-stat-fdv');
          if (fdvEl) fdvEl.textContent = t.fdv;

          const titleEl = document.getElementById('active-symbol-title');
          if (titleEl) titleEl.textContent = t.symbol;

          const exEl = document.getElementById('active-exchange-badge');
          if (exEl) exEl.textContent = t.exchange;
        }
      } catch (e) {}
    }

    function updateCountdown() {
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setHours(now.getHours() + 1, 0, 0, 0);
      const diffSec = Math.max(0, Math.floor((nextHour - now) / 1000));
      const h = String(Math.floor(diffSec / 3600)).padStart(2, '0');
      const m = String(Math.floor((diffSec % 3600) / 60)).padStart(2, '0');
      const s = String(diffSec % 60).padStart(2, '0');
      const cdEl = document.getElementById('hl-stat-countdown');
      if (cdEl) cdEl.textContent = \`\${h}:\${m}:\${s}\`;
    }
    setInterval(updateCountdown, 1000);

    // Save session on page close / unload and every 15 seconds
    window.addEventListener('beforeunload', saveCurrentSession);
    setInterval(saveCurrentSession, 10 * 60 * 1000); // Periodic backup every 10 minutes

    // Attach triggerAutoSave to inputs & layout buttons
    ['input-exec-qty', 'input-exec-notional', 'exec-pct-slider', 'input-exec-tp', 'input-exec-sl'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', triggerAutoSave);
    });
    document.getElementById('btn-toggle-watchlist')?.addEventListener('click', triggerAutoSave);
    document.getElementById('btn-toggle-dock')?.addEventListener('click', triggerAutoSave);
    document.querySelectorAll('.dock-seg-btn').forEach(b => b.addEventListener('click', triggerAutoSave));
    ['btn-toggle-fibo', 'btn-toggle-galton', 'btn-toggle-footprint', 'select-fibo-period', 'select-galton-engine', 'select-galton-period', 'select-footprint-window', 'select-footprint-imbalance'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', triggerAutoSave);
      document.getElementById(id)?.addEventListener('click', triggerAutoSave);
    });
    updateCountdown();

    // Indicators dropdown toggle
    const btnIndMenu = document.getElementById('btn-indicators-menu');
    const indDropdown = document.getElementById('indicators-dropdown');
    btnIndMenu?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = indDropdown.style.display === 'none';
      indDropdown.style.display = isHidden ? 'block' : 'none';
    });
    document.addEventListener('click', (e) => {
      if (indDropdown && !e.target.closest('#indicators-dropdown') && !e.target.closest('#btn-indicators-menu')) {
        indDropdown.style.display = 'none';
      }
    });

    // Fullscreen chart toggle
    document.getElementById('btn-chart-fullscreen')?.addEventListener('click', () => {
      const viewChart = document.getElementById('view-chart');
      if (!document.fullscreenElement) {
        viewChart?.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Screenshot chart
    document.getElementById('btn-chart-screenshot')?.addEventListener('click', () => {
      try {
        const canvas = chartContainer.querySelector('canvas');
        if (canvas) {
          const a = document.createElement('a');
          a.download = \`\${currentSymbol}_chart_\${Date.now()}.png\`;
          a.href = canvas.toDataURL('image/png');
          a.click();
        }
      } catch (e) {}
    });

    setInterval(() => updateTickerBar(currentDockCoin), 3500);

    document.getElementById('btn-run-validation').addEventListener('click', async () => {
      const sym = document.getElementById('val-sym-input').value.trim();
      document.getElementById('val-status').textContent = 'Evaluating 26 indicators...';
      try {
        const res = await fetch('/api/validation?symbol=' + encodeURIComponent(sym));
        const data = await res.json();
        if (data.error || !data.consensus) {
          throw new Error(data.error || 'Evaluation failed or invalid symbol');
        }
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

    // --- Tradesync Journaling Dashboard Client Logic ---
    const MARCH_2026_DEMO_DAYS = {
      "2026-03-03": {
        pnl: 100.0,
        trades: [
          { symbol: "BINANCE:BTCUSDT", side: "LONG", entryPrice: 82450.0, exitPrice: 82950.0, pnl: 60.0, pnlPercent: 1.5, strategy: "Supertrend + MACD", reason: "Take Profit hit (+1.5%)", time: "10:24 AM" },
          { symbol: "BINANCE:ETHUSDT", side: "LONG", entryPrice: 2680.0, exitPrice: 2720.0, pnl: 40.0, pnlPercent: 1.5, strategy: "Fibo Golden Pocket", reason: "Take Profit hit (+1.5%)", time: "02:15 PM" }
        ]
      },
      "2026-03-05": {
        pnl: 240.0,
        trades: [
          { symbol: "BINANCE:SOLUSDT", side: "LONG", entryPrice: 114.2, exitPrice: 116.5, pnl: 240.0, pnlPercent: 2.0, strategy: "Supertrend + MACD", reason: "Trailing Stop hit at high (+2.0%)", time: "11:40 AM" }
        ]
      },
      "2026-03-07": {
        pnl: 130.0,
        trades: [
          { symbol: "BINANCE:BTCUSDT", side: "LONG", entryPrice: 83100.0, exitPrice: 83750.0, pnl: 80.0, pnlPercent: 1.2, strategy: "Supertrend Momentum", reason: "Take Profit hit (+1.2%)", time: "09:12 AM" },
          { symbol: "BYBIT:HYPEUSDT", side: "LONG", entryPrice: 91.5, exitPrice: 92.8, pnl: 50.0, pnlPercent: 1.4, strategy: "Sniper A+ Setup", reason: "Take Profit hit (+1.4%)", time: "04:30 PM" }
        ]
      },
      "2026-03-10": {
        pnl: 360.0,
        trades: [
          { symbol: "BINANCE:ETHUSDT", side: "LONG", entryPrice: 2710.0, exitPrice: 2785.0, pnl: 360.0, pnlPercent: 2.76, strategy: "Supertrend + MACD", reason: "Trend Runner Take Profit (+2.76%)", time: "08:45 AM" }
        ]
      },
      "2026-03-11": {
        pnl: 110.0,
        trades: [
          { symbol: "BINANCE:SOLUSDT", side: "LONG", entryPrice: 115.0, exitPrice: 116.2, pnl: 60.0, pnlPercent: 1.04, strategy: "Supertrend Momentum", reason: "Trailing Stop (+1.04%)", time: "11:15 AM" },
          { symbol: "BINANCE:NEARUSDT", side: "LONG", entryPrice: 4.25, exitPrice: 4.34, pnl: 50.0, pnlPercent: 2.12, strategy: "Sniper A+ Setup", reason: "Take Profit hit (+2.12%)", time: "03:50 PM" }
        ]
      },
      "2026-03-12": {
        pnl: 270.0,
        trades: [
          { symbol: "BINANCE:BTCUSDT", side: "LONG", entryPrice: 83500.0, exitPrice: 84600.0, pnl: 270.0, pnlPercent: 1.32, strategy: "Supertrend + MACD", reason: "Take Profit hit (+1.32%)", time: "02:20 PM" }
        ]
      },
      "2026-03-13": {
        pnl: 300.0,
        trades: [
          { symbol: "BYBIT:HYPEUSDT", side: "LONG", entryPrice: 92.0, exitPrice: 93.6, pnl: 120.0, pnlPercent: 1.74, strategy: "Sniper A+ Setup", reason: "Take Profit hit (+1.74%)", time: "09:05 AM" },
          { symbol: "BINANCE:ETHUSDT", side: "LONG", entryPrice: 2740.0, exitPrice: 2780.0, pnl: 100.0, pnlPercent: 1.46, strategy: "Supertrend Momentum", reason: "Take Profit hit (+1.46%)", time: "01:30 PM" },
          { symbol: "BINANCE:SOLUSDT", side: "LONG", entryPrice: 116.5, exitPrice: 118.0, pnl: 80.0, pnlPercent: 1.29, strategy: "Supertrend + MACD", reason: "Take Profit hit (+1.29%)", time: "06:10 PM" }
        ]
      },
      "2026-03-14": {
        pnl: 40.0,
        trades: [
          { symbol: "BINANCE:BNBUSDT", side: "LONG", entryPrice: 780.0, exitPrice: 788.0, pnl: 40.0, pnlPercent: 1.02, strategy: "Supertrend Momentum", reason: "Trailing Stop hit (+1.02%)", time: "10:00 AM" }
        ]
      },
      "2026-03-15": {
        pnl: 615.0,
        trades: [
          { symbol: "BINANCE:BTCUSDT", side: "LONG", entryPrice: 84000.0, exitPrice: 85400.0, pnl: 350.0, pnlPercent: 1.67, strategy: "Supertrend + MACD", reason: "Take Profit hit (+1.67%)", time: "08:20 AM" },
          { symbol: "BINANCE:SOLUSDT", side: "LONG", entryPrice: 117.0, exitPrice: 121.2, pnl: 265.0, pnlPercent: 3.59, strategy: "Sniper A+ Setup", reason: "Trend Runner TP (+3.59%)", time: "02:40 PM" }
        ]
      },
      "2026-03-16": {
        pnl: 480.0,
        trades: [
          { symbol: "BINANCE:ETHUSDT", side: "LONG", entryPrice: 2760.0, exitPrice: 2840.0, pnl: 280.0, pnlPercent: 2.9, strategy: "Supertrend + MACD", reason: "Take Profit hit (+2.9%)", time: "11:10 AM" },
          { symbol: "BINANCE:TAOUSDT", side: "LONG", entryPrice: 300.0, exitPrice: 312.0, pnl: 200.0, pnlPercent: 4.0, strategy: "Sniper A+ Setup", reason: "Take Profit hit (+4.0%)", time: "05:15 PM" }
        ]
      },
      "2026-03-17": {
        pnl: 400.0,
        trades: [
          { symbol: "BYBIT:HYPEUSDT", side: "LONG", entryPrice: 93.0, exitPrice: 95.5, pnl: 250.0, pnlPercent: 2.69, strategy: "Supertrend + MACD", reason: "Take Profit hit (+2.69%)", time: "09:30 AM" },
          { symbol: "BINANCE:NEARUSDT", side: "LONG", entryPrice: 4.30, exitPrice: 4.45, pnl: 150.0, pnlPercent: 3.49, strategy: "Supertrend Momentum", reason: "Take Profit hit (+3.49%)", time: "03:00 PM" }
        ]
      },
      "2026-03-18": {
        pnl: -400.0,
        trades: [
          { symbol: "BINANCE:BTCUSDT", side: "LONG", entryPrice: 85200.0, exitPrice: 84350.0, pnl: -220.0, pnlPercent: -1.0, strategy: "Supertrend + MACD", reason: "Stop Loss hit (-1.0%)", time: "10:15 AM" },
          { symbol: "BINANCE:ETHUSDT", side: "LONG", entryPrice: 2830.0, exitPrice: 2802.0, pnl: -180.0, pnlPercent: -0.99, strategy: "Supertrend + MACD", reason: "Stop Loss hit (-0.99%)", time: "01:45 PM" }
        ]
      },
      "2026-03-19": {
        pnl: 250.0,
        trades: [
          { symbol: "BINANCE:SOLUSDT", side: "LONG", entryPrice: 118.5, exitPrice: 121.5, pnl: 250.0, pnlPercent: 2.53, strategy: "Supertrend + MACD", reason: "Take Profit hit (+2.53%)", time: "11:20 AM" }
        ]
      }
    };

    let currentJournalMode = "march2026";
    let currentSelectedDate = "2026-03-19";
    let cachedPaperStatus = null;

    function renderJournalDashboard() {
      const modeSelect = document.getElementById("ts-month-mode");
      if (modeSelect) currentJournalMode = modeSelect.value;

      const calTitle = document.getElementById("ts-cal-title");
      const gridBody = document.getElementById("ts-cal-grid-body");
      if (!gridBody) return;

      let daysMap = {};
      let totalPnl = 0;
      let winCount = 0;
      let lossCount = 0;
      let winSum = 0;
      let lossSum = 0;
      let longPnl = 0;
      let shortPnl = 0;
      let year = 2026;
      let month = 2;

      if (currentJournalMode === "march2026") {
        if (calTitle) calTitle.textContent = "March 2026";
        year = 2026;
        month = 2;
        daysMap = MARCH_2026_DEMO_DAYS;
        totalPnl = 2895.0;
        winCount = 16;
        lossCount = 6;
        winSum = 4005.0;
        lossSum = 1110.0;
        longPnl = 1630.0;
        shortPnl = 1265.0;
      } else {
        const now = new Date();
        year = now.getFullYear();
        month = now.getMonth();
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        if (calTitle) calTitle.textContent = monthNames[month] + " " + year;

        const allTrades = (cachedPaperStatus && cachedPaperStatus.allTrades) || [];
        allTrades.forEach(t => {
          const exitTime = t.exitTime || t.entryTime;
          if (!exitTime) return;
          const dStr = exitTime.slice(0, 10);
          if (!daysMap[dStr]) daysMap[dStr] = { pnl: 0, trades: [] };
          daysMap[dStr].pnl += (t.pnl || 0);
          daysMap[dStr].trades.push({
            symbol: t.symbol,
            side: t.side,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            pnl: t.pnl,
            pnlPercent: t.pnlPercent,
            strategy: t.strategy,
            reason: t.reason,
            time: new Date(exitTime).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
          });

          if (t.pnl > 0) {
            winCount++;
            winSum += t.pnl;
          } else {
            lossCount++;
            lossSum += Math.abs(t.pnl);
          }
          if (t.side === "LONG") longPnl += t.pnl;
          else shortPnl += t.pnl;
          totalPnl += t.pnl;
        });

        const todayStr = new Date().toISOString().slice(0, 10);
        if (cachedPaperStatus && cachedPaperStatus.dailyPnl !== undefined && !daysMap[todayStr]) {
          daysMap[todayStr] = {
            pnl: cachedPaperStatus.dailyPnl,
            trades: cachedPaperStatus.recentTrades || []
          };
        }
      }

      // 1. Update 5 KPI Cards
      const totalTradesCount = winCount + lossCount || 1;
      const winRatePct = Math.round((winCount / totalTradesCount) * 1000) / 10;
      const elWinRate = document.getElementById("ts-kpi-winrate");
      if (elWinRate) elWinRate.textContent = winRatePct + "%";
      const elWinLossCount = document.getElementById("ts-kpi-winloss-count");
      if (elWinLossCount) elWinLossCount.textContent = winCount + "W - " + lossCount + "L";
      const elWinBar = document.getElementById("ts-kpi-winbar");
      const elLossBar = document.getElementById("ts-kpi-lossbar");
      if (elWinBar && elLossBar) {
        elWinBar.style.width = winRatePct + "%";
        elLossBar.style.width = (100 - winRatePct) + "%";
      }
      const elWinsLbl = document.getElementById("ts-kpi-wins-label");
      const elLossesLbl = document.getElementById("ts-kpi-losses-label");
      if (elWinsLbl) elWinsLbl.textContent = winCount + " wins";
      if (elLossesLbl) elLossesLbl.textContent = lossCount + " losses";

      const avgWin = winCount > 0 ? (winSum / winCount) : 0;
      const avgLoss = lossCount > 0 ? (lossSum / lossCount) : 0;
      const avgWinLoss = (winSum - lossSum) / totalTradesCount;
      const elAvgWinLoss = document.getElementById("ts-kpi-avg-winloss");
      if (elAvgWinLoss) elAvgWinLoss.textContent = "$" + Math.abs(avgWinLoss).toFixed(2);
      const elAvgWinVal = document.getElementById("ts-kpi-avg-win-val");
      const elAvgLossVal = document.getElementById("ts-kpi-avg-loss-val");
      if (elAvgWinVal) elAvgWinVal.textContent = "+$" + avgWin.toFixed(2);
      if (elAvgLossVal) elAvgLossVal.textContent = "-$" + avgLoss.toFixed(2);

      const elLsTotal = document.getElementById("ts-kpi-ls-total");
      if (elLsTotal) {
        elLsTotal.textContent = (totalPnl >= 0 ? "+$" : "-$") + Math.abs(totalPnl).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        elLsTotal.className = "ts-kpi-val " + (totalPnl >= 0 ? "green" : "red");
      }
      const elLongVal = document.getElementById("ts-kpi-long-val");
      const elShortVal = document.getElementById("ts-kpi-short-val");
      if (elLongVal) elLongVal.textContent = (longPnl >= 0 ? "+$" : "-$") + Math.abs(longPnl).toLocaleString("en-US") + " >";
      if (elShortVal) elShortVal.textContent = (shortPnl >= 0 ? "+$" : "-$") + Math.abs(shortPnl).toLocaleString("en-US") + " >";

      // 2. Performance Sparkline Cards
      const elCumPnlVal = document.getElementById("ts-cum-pnl-val");
      if (elCumPnlVal) elCumPnlVal.textContent = (totalPnl >= 0 ? "+$" : "-$") + Math.abs(totalPnl).toLocaleString("en-US");

      // 3. Build 8-Column Calendar Grid
      let html = "";
      const colHeaders = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Weekly"];
      colHeaders.forEach(col => {
        html += '<div class="ts-cal-col-head ' + (col === "Weekly" ? "weekly" : "") + '">' + col + '</div>';
      });

      const firstDayOfMonth = new Date(year, month, 1).getDay(); // 0 = Sun
      const daysInMonth = new Date(year, month + 1, 0).getDate();

      let currentDay = 1;
      let weekPnl = 0;
      let weekTrades = 0;

      for (let row = 0; row < 5; row++) {
        weekPnl = 0;
        weekTrades = 0;

        for (let col = 0; col < 7; col++) {
          if ((row === 0 && col < firstDayOfMonth) || currentDay > daysInMonth) {
            html += '<div class="ts-cal-cell empty"></div>';
          } else {
            const dateStr = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(currentDay).padStart(2, "0");
            const dayData = daysMap[dateStr];
            const isSelected = dateStr === currentSelectedDate;

            let pnlHtml = "";
            let tradeCountHtml = "";

            if (dayData && dayData.trades && dayData.trades.length > 0) {
              const p = dayData.pnl;
              const pClass = p >= 0 ? "green" : "red";
              const pSign = p >= 0 ? "+$" : "-$";
              pnlHtml = '<div class="ts-cell-pnl ' + pClass + '">' + pSign + Math.abs(p).toFixed(2) + '</div>';
              const tCount = dayData.trades.length;
              tradeCountHtml = '<div class="ts-cell-trades">' + tCount + ' trade' + (tCount > 1 ? 's' : '') + '</div>';
              weekPnl += p;
              weekTrades += tCount;
            }

            html += '<div class="ts-cal-cell ' + (isSelected ? "active-day" : "") + '" data-ts-date="' + dateStr + '">' +
              '<div class="ts-cell-daynum ' + (dayData ? "active" : "") + '">' + currentDay + '</div>' +
              pnlHtml +
              tradeCountHtml +
              '</div>';
            currentDay++;
          }
        }

        const wClass = weekPnl >= 0 ? "green" : "red";
        const wSign = weekPnl >= 0 ? "+$" : "-$";
        const wPnlText = weekTrades > 0 ? (wSign + Math.abs(weekPnl).toFixed(2)) : "--";
        const wTradeText = weekTrades > 0 ? (weekTrades + " trade" + (weekTrades > 1 ? "s" : "")) : "0 trades";

        html += '<div class="ts-weekly-cell">' +
          '<div class="ts-weekly-title">Week ' + (row + 1) + '</div>' +
          '<div class="ts-weekly-pnl ' + (weekTrades > 0 ? wClass : "") + '">' + wPnlText + '</div>' +
          '<div class="ts-weekly-trades">' + wTradeText + '</div>' +
          '</div>';

        if (currentDay > daysInMonth) break;
      }

      gridBody.innerHTML = html;

      gridBody.querySelectorAll(".ts-cal-cell:not(.empty)").forEach(cell => {
        cell.addEventListener("click", () => {
          gridBody.querySelectorAll(".ts-cal-cell").forEach(c => c.classList.remove("active-day"));
          cell.classList.add("active-day");
          const dateStr = cell.dataset.tsDate;
          currentSelectedDate = dateStr;
          openDayJournalModal(dateStr, daysMap[dateStr]);
        });
      });
    }

    function openDayJournalModal(dateStr, dayData) {
      const modal = document.getElementById("ts-modal-overlay");
      const titleEl = document.getElementById("ts-modal-date-title");
      const summaryEl = document.getElementById("ts-modal-summary");
      const listEl = document.getElementById("ts-modal-trades-list");
      if (!modal || !titleEl || !summaryEl || !listEl) return;

      titleEl.textContent = "Journal Card — " + dateStr;

      if (!dayData || !dayData.trades || dayData.trades.length === 0) {
        summaryEl.innerHTML = '<span style="color: #8c93a3; font-size: 12px;">No executed trades recorded on this day.</span>';
        listEl.innerHTML = '<div style="text-align: center; color: #717684; padding: 20px; font-size: 12px;">Market idle or no setups matched entry confluence criteria.</div>';
      } else {
        const p = dayData.pnl;
        const pClass = p >= 0 ? "val-green" : "val-red";
        const pSign = p >= 0 ? "+$" : "-$";
        summaryEl.innerHTML = '<div style="background: #181b24; padding: 8px 12px; border-radius: 6px; border: 1px solid #232838;">' +
            '<div style="font-size: 9px; color: #8c93a3; text-transform: uppercase;">Net P&L</div>' +
            '<div style="font-size: 16px; font-weight: 800; font-family: monospace;" class="' + pClass + '">' + pSign + Math.abs(p).toFixed(2) + '</div>' +
          '</div>' +
          '<div style="background: #181b24; padding: 8px 12px; border-radius: 6px; border: 1px solid #232838;">' +
            '<div style="font-size: 9px; color: #8c93a3; text-transform: uppercase;">Total Trades</div>' +
            '<div style="font-size: 16px; font-weight: 800; color: #fff;">' + dayData.trades.length + '</div>' +
          '</div>';

        let tRows = "";
        dayData.trades.forEach(t => {
          tRows += '<tr style="border-bottom: 1px solid rgba(255,255,255,0.04);">' +
            '<td style="padding: 8px 4px; color: #8c93a3;">' + (t.time || "--") + '</td>' +
            '<td style="padding: 8px 4px; font-weight: 700; color: #fff;">' + t.symbol + '</td>' +
            '<td style="padding: 8px 4px;"><span class="action-badge ' + (t.side === "LONG" ? "action-buy" : "action-sell") + '">' + t.side + '</span></td>' +
            '<td style="padding: 8px 4px; text-align: right; font-family: monospace;">$' + (t.entryPrice ? t.entryPrice.toLocaleString() : "--") + '</td>' +
            '<td style="padding: 8px 4px; text-align: right; font-family: monospace;">$' + (t.exitPrice ? t.exitPrice.toLocaleString() : "--") + '</td>' +
            '<td style="padding: 8px 4px; text-align: right; font-weight: 700; font-family: monospace;" class="' + (t.pnl >= 0 ? "val-green" : "val-red") + '">' +
              (t.pnl >= 0 ? "+" : "") + "$" + (t.pnl ? t.pnl.toFixed(2) : "0.00") + ' (' + (t.pnlPercent || 0) + '%)' +
            '</td>' +
            '<td style="padding: 8px 4px; color: #9ca3af; font-size: 10.5px;">' + (t.reason || t.strategy) + '</td>' +
          '</tr>';
        });

        listEl.innerHTML = '<table style="width: 100%; border-collapse: collapse; font-size: 11px;">' +
          '<thead>' +
            '<tr style="border-bottom: 1px solid #222634; color: #8c93a3; font-size: 10px;">' +
              '<th style="padding: 6px 4px; text-align: left;">TIME</th>' +
              '<th style="padding: 6px 4px; text-align: left;">SYMBOL</th>' +
              '<th style="padding: 6px 4px; text-align: left;">SIDE</th>' +
              '<th style="padding: 6px 4px; text-align: right;">ENTRY</th>' +
              '<th style="padding: 6px 4px; text-align: right;">EXIT</th>' +
              '<th style="padding: 6px 4px; text-align: right;">NET PNL</th>' +
              '<th style="padding: 6px 4px; text-align: left;">REASON / STRATEGY</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + tRows + '</tbody>' +
        '</table>';
      }

      modal.style.display = "flex";
    }

    // Modal Close
    document.getElementById("btn-ts-modal-close")?.addEventListener("click", () => {
      document.getElementById("ts-modal-overlay").style.display = "none";
    });
    document.getElementById("ts-modal-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "ts-modal-overlay") {
        document.getElementById("ts-modal-overlay").style.display = "none";
      }
    });

    // Month mode switcher
    document.getElementById("ts-month-mode")?.addEventListener("change", (e) => {
      currentJournalMode = e.target.value;
      renderJournalDashboard();
    });

    // Month Navigation
    document.getElementById("btn-ts-prev-month")?.addEventListener("click", () => {
      currentJournalMode = currentJournalMode === "march2026" ? "current" : "march2026";
      const sel = document.getElementById("ts-month-mode");
      if (sel) sel.value = currentJournalMode;
      renderJournalDashboard();
    });
    document.getElementById("btn-ts-next-month")?.addEventListener("click", () => {
      currentJournalMode = currentJournalMode === "march2026" ? "current" : "march2026";
      const sel = document.getElementById("ts-month-mode");
      if (sel) sel.value = currentJournalMode;
      renderJournalDashboard();
    });

    // Journal Card quick button
    document.getElementById("btn-ts-journal-card")?.addEventListener("click", () => {
      const days = currentJournalMode === "march2026" ? MARCH_2026_DEMO_DAYS : {};
      openDayJournalModal(currentSelectedDate, days[currentSelectedDate]);
    });

    // Export CSV
    document.getElementById("btn-ts-export")?.addEventListener("click", () => {
      const tradesToExport = currentJournalMode === "march2026"
        ? Object.entries(MARCH_2026_DEMO_DAYS).flatMap(([d, v]) => v.trades.map(t => ({ date: d, ...t })))
        : ((cachedPaperStatus && cachedPaperStatus.allTrades) || []);

      if (tradesToExport.length === 0) {
        alert("No trades available to export.");
        return;
      }

      const csvRows = ["Date,Symbol,Side,EntryPrice,ExitPrice,PnL,PnLPercent,Strategy,Reason"];
      tradesToExport.forEach(t => {
        csvRows.push([
          '"' + (t.date || t.exitTime || "") + '"',
          '"' + t.symbol + '"',
          '"' + t.side + '"',
          t.entryPrice,
          t.exitPrice,
          t.pnl,
          '"' + t.pnlPercent + '%"',
          '"' + (t.strategy || "") + '"',
          '"' + (t.reason || "").replace(/"/g, "") + '"'
        ].join(","));
      });
      const csv = csvRows.join(String.fromCharCode(10));

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "tradesync_journal_" + currentJournalMode + "_" + Date.now() + ".csv";
      a.click();
    });

    // Sync button
    document.getElementById("btn-ts-sync")?.addEventListener("click", () => {
      refreshPaperStatus();
      renderJournalDashboard();
    });

    // Link from Paper Trade View
    document.getElementById("btn-goto-journal")?.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".view-panel").forEach(p => p.classList.remove("active"));
      const jTab = document.querySelector('.tab-btn[data-target="view-journal"]');
      const jView = document.getElementById("view-journal");
      if (jTab) jTab.classList.add("active");
      if (jView) jView.classList.add("active");
      renderJournalDashboard();
    });

    // Initial render
    setTimeout(renderJournalDashboard, 100);


    // --- Paper Trader Client Logic ---
    async function refreshPaperStatus() {
      try {
        const res = await fetch('/api/paper/status');
        const data = await res.json();
        cachedPaperStatus = data;

        document.getElementById('paper-equity').textContent = '$' + data.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        document.getElementById('paper-cash').textContent = '$' + data.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        function fmtP(val) {
          if (typeof val !== 'number' || isNaN(val)) return '0.00';
          if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          if (val >= 1) return val.toFixed(2);
          if (val >= 0.01) return val.toFixed(4);
          return val.toFixed(6);
        }

        const pnlEl = document.getElementById('paper-daily-pnl');
        pnlEl.textContent = (data.dailyPnl >= 0 ? '+$' : '-$') + Math.abs(data.dailyPnl).toFixed(2);
        pnlEl.className = 'stat-value ' + (data.dailyPnl >= 0 ? 'val-green' : 'val-red');

        document.getElementById('paper-winrate').textContent = data.winRate + '% (' + data.totalTrades + ')';

        // Target progress & Daily Stop Loss state
        const targetTextEl = document.getElementById('target-progress-text');
        const targetBarEl = document.getElementById('target-progress-bar');

        if (data.dailyStopLossHit) {
          targetTextEl.textContent = '🛑 Daily Stop Loss Hit (-$' + Math.abs(data.dailyPnl).toFixed(2) + ' / -$' + (data.dailyStopLossMax || 180) + ') — Halted until 00:00 UTC+7';
          targetTextEl.style.color = '#ef5350';
          targetBarEl.style.width = '100%';
          targetBarEl.style.background = '#ef5350';
        } else if (data.dailyTargetMaxHit) {
          targetTextEl.textContent = '🏆 3% Max Target Reached (+$' + data.dailyPnl.toFixed(2) + ' >= $' + (data.dailyTargetMax || 300) + ') — Profit Locked for Today!';
          targetTextEl.style.color = '#4ade80';
          targetBarEl.style.width = '100%';
          targetBarEl.style.background = 'linear-gradient(90deg, #26a69a, #4ade80, #38bdf8)';
        } else if (data.dailyTargetHit) {
          targetTextEl.textContent = '🎯 1% Target Achieved (+$' + data.dailyPnl.toFixed(2) + ') — 🛡️ SNIPER MODE (A+ Only, Max 2x)';
          targetTextEl.style.color = '#38bdf8';
          targetBarEl.style.width = Math.min(100, Math.max(0, data.dailyTargetProgressPercent)) + '%';
          targetBarEl.style.background = 'linear-gradient(90deg, #26a69a, #4ade80, #38bdf8)';
        } else {
          targetTextEl.textContent = data.dailyTargetProgressPercent + '% (+$' + data.dailyPnl.toFixed(2) + ' / $' + (data.dailyTargetMax || 300) + ' max)';
          targetTextEl.style.color = data.dailyPnl >= 0 ? '#fbbf24' : '#f87171';
          targetBarEl.style.width = Math.min(100, Math.max(0, data.dailyTargetProgressPercent)) + '%';
          targetBarEl.style.background = 'linear-gradient(90deg, #26a69a, #4ade80, #fbbf24)';
        }

        // Auto trade button
        const btnToggle = document.getElementById('btn-toggle-auto-trade');
        const statusEl = document.getElementById('paper-engine-status');
        if (data.autoTradeEnabled) {
          if (data.dailyStopLossHit) {
            btnToggle.textContent = '🛑 Auto-Trade: STOP LOSS HIT (Halted)';
            btnToggle.style.background = '#b91c1c';
            statusEl.textContent = '● Daily Stop Loss Hit — Trading Halted until 00:00 UTC+7';
            statusEl.style.color = '#ef5350';
          } else if (data.dailyTargetMaxHit) {
            btnToggle.textContent = '🏆 Auto-Trade: 3% TARGET LOCKED';
            btnToggle.style.background = '#059669';
            statusEl.textContent = '● 3% Max Target Hit (+$' + data.dailyPnl.toFixed(2) + ') — Trading Locked to Preserve Gains';
            statusEl.style.color = '#10b981';
          } else if (data.dailyTargetHit) {
            btnToggle.textContent = '🎯 Auto-Trade: TARGET MET (Sniper A+)';
            btnToggle.style.background = '#0284c7';
            statusEl.textContent = '● 1% Target Met — Sniper Mode Active (A+ Setups, Max 2x)';
            statusEl.style.color = '#38bdf8';
          } else if (data.tradingMode && data.tradingMode.includes('DEFENSIVE')) {
            btnToggle.textContent = '⚠️ Auto-Trade: DEFENSIVE (Risk Reduced)';
            btnToggle.style.background = '#d97706';
            statusEl.textContent = '● Defensive Mode (Drawdown protection, 1x Lev, 1 position)';
            statusEl.style.color = '#fbbf24';
          } else {
            btnToggle.textContent = '🟢 Auto-Trade: ACTIVE [Max 3x]';
            btnToggle.style.background = '#22c55e';
            statusEl.textContent = '● Auto-Engine Running (Adaptive Leverage up to 3x)';
            statusEl.style.color = 'var(--accent-green)';
          }
        } else {
          btnToggle.textContent = '🔴 Auto-Trade: PAUSED';
          btnToggle.style.background = '#6b7280';
          statusEl.textContent = '● Auto-Engine Paused';
          statusEl.style.color = '#ef5350';
        }

        // Open positions table
        const posBody = document.querySelector('#table-paper-positions tbody');
        if (!data.openPositions || data.openPositions.length === 0) {
          posBody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-secondary); padding: 16px;">No open positions. Monitoring market for next high-confluence entry...</td></tr>';
        } else {
          posBody.innerHTML = data.openPositions.map(p => \`
            <tr>
              <td><strong>\${p.symbol}</strong></td>
              <td><span class="action-badge \${p.side === 'LONG' ? 'action-buy' : 'action-sell'}">\${p.side}</span></td>
              <td><span class="action-badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 800;">\${p.leverage || 1}x</span></td>
              <td>$\${fmtP(p.entryPrice)}</td>
              <td>$\${fmtP(p.currentPrice || p.entryPrice)}</td>
              <td class="val-green">$\${fmtP(p.takeProfit)}</td>
              <td class="val-red">$\${fmtP(p.stopLoss)}</td>
              <td style="color: #e4e7eb;">$\${fmtP(p.margin || p.notional)}</td>
              <td style="color: var(--text-secondary);">$\${fmtP(p.notional)}</td>
              <td class="\${p.unrealizedPnl >= 0 ? 'val-green' : 'val-red'}">
                \${p.unrealizedPnl >= 0 ? '+' : ''}$\${p.unrealizedPnl} (\${p.unrealizedPnlPercent}% ROE)
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
              <td>$\${fmtP(t.exitPrice)}</td>
              <td class="\${t.pnl >= 0 ? 'val-green' : 'val-red'}">\${t.pnl >= 0 ? '+' : ''}$\${t.pnl} (\${t.pnlPercent}%)</td>
              <td style="font-size: 11px; color: var(--text-secondary);">\${t.reason}</td>
            </tr>
          \`).join('');
        }

        // Logs
        const logsContainer = document.getElementById('paper-logs-container');
        if (data.logs && data.logs.length > 0) {
          logsContainer.innerHTML = data.logs.map(l => {
            let rowColor = '#cbd5e1';
            let bg = 'transparent';
            if (l.includes('OPENED')) {
              rowColor = '#38bdf8';
              bg = 'rgba(56, 189, 248, 0.06)';
            } else if (l.includes('CLOSED') && l.includes('Net PnL $') && !l.includes('$-')) {
              rowColor = '#4ade80';
              bg = 'rgba(74, 222, 128, 0.06)';
            } else if (l.includes('CLOSED') && (l.includes('$-') || l.includes('Stop Loss'))) {
              rowColor = '#f87171';
              bg = 'rgba(239, 83, 80, 0.06)';
            } else if (l.includes('STOP LOSS REACHED') || l.includes('🛑')) {
              rowColor = '#ef5350';
              bg = 'rgba(239, 83, 80, 0.12)';
            } else if (l.includes('Trailing Stop locked')) {
              rowColor = '#fbbf24';
              bg = 'rgba(251, 191, 36, 0.06)';
            }
            return '<div style="padding: 5px 8px; margin-bottom: 3px; border-radius: 4px; background: ' + bg + '; color: ' + rowColor + '; border-left: 2px solid ' + (rowColor === '#cbd5e1' ? 'transparent' : rowColor) + '; word-break: break-word;">' + l + '</div>';
          }).join('');
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

  if (pathname === '/api/search') {
    const q = (parsedUrl.query.q || '').trim();
    if (!q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ symbols: [] }));
    }

    try {
      const axios = require('axios');
      function formatResult(s) {
        const exchange = (s.prefix || s.exchange.split(' ')[0] || 'MARKET').toUpperCase();
        const id = exchange + ':' + s.symbol;
        const logo = s.logo?.logoid || s['base-currency-logoid'] || s['currency-logoid'] || s.logoid || '';
        return {
          symbol: id,
          name: s.symbol,
          exchange: exchange,
          description: s.description || s.symbol,
          logoId: logo,
        };
      }

      let list = [];
      if (q.includes(':')) {
        const parts = q.split(':');
        const exchange = parts[0];
        const text = parts[1];
        try {
          const resSearch = await axios.get('https://symbol-search.tradingview.com/symbol_search/v3', {
            params: { text, exchange },
            headers: { origin: 'https://www.tradingview.com' },
            timeout: 4000,
          });
          if (resSearch.data && resSearch.data.symbols) {
            list = resSearch.data.symbols.map(formatResult);
          }
        } catch (e) {}
      }

      if (list.length === 0) {
        try {
          const resCrypto = await axios.get('https://symbol-search.tradingview.com/symbol_search/v3', {
            params: { text: q, search_type: 'crypto' },
            headers: { origin: 'https://www.tradingview.com' },
            timeout: 4000,
          });
          if (resCrypto.data && resCrypto.data.symbols) {
            list = resCrypto.data.symbols.map(formatResult);
          }
        } catch (e) {}
      }

      if (list.length === 0) {
        try {
          const resAll = await axios.get('https://symbol-search.tradingview.com/symbol_search/v3', {
            params: { text: q },
            headers: { origin: 'https://www.tradingview.com' },
            timeout: 4000,
          });
          if (resAll.data && resAll.data.symbols) {
            list = resAll.data.symbols.map(formatResult);
          }
        } catch (e) {}
      }

      const preferred = ['BINANCE', 'BYBIT', 'OKX', 'COINBASE', 'NASDAQ'];
      list.sort((a, b) => {
        const aPref = preferred.indexOf(a.exchange);
        const bPref = preferred.indexOf(b.exchange);
        if (aPref !== -1 && bPref !== -1) return aPref - bPref;
        if (aPref !== -1) return -1;
        if (bPref !== -1) return 1;
        return 0;
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ symbols: list.slice(0, 10) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message, symbols: [] }));
    }
  }

  if (pathname === '/api/watchlist/prices') {
    const body = await parseBody(req);
    const symbols = body.symbols || [];
    const prices = {};

    if (symbols.length > 0) {
      const axios = require('axios');

      // 1. Copy last known prices so watchlist never flickers to empty '--'
      if (typeof serverWatchlistPriceCache !== 'undefined') {
        Object.assign(prices, serverWatchlistPriceCache);
      }

      // Check if cache was updated very recently (< 4000ms), return immediately
      if (typeof lastWatchlistPriceUpdate !== 'undefined' && (Date.now() - lastWatchlistPriceUpdate < 4000) && Object.keys(prices).length >= symbols.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ prices }));
      }

      // 2. Binance Public Data API (Lightning fast, non-blocked, no 429)
      const binanceMap = {};
      symbols.forEach(s => {
        if (s.startsWith('BINANCE:')) {
          const pair = s.split(':')[1];
          binanceMap[pair] = s;
        }
      });

      const pBinance = (async () => {
        const pairs = Object.keys(binanceMap);
        if (pairs.length === 0) return;
        try {
          const q = encodeURIComponent(JSON.stringify(pairs));
          const res = await axios.get('https://data-api.binance.vision/api/v3/ticker/24hr?symbols=' + q, { timeout: 3500 });
          if (Array.isArray(res.data)) {
            res.data.forEach(item => {
              const sym = binanceMap[item.symbol];
              if (sym) {
                prices[sym] = {
                  close: parseFloat(item.lastPrice),
                  change: parseFloat(item.priceChangePercent),
                  change_abs: parseFloat(item.priceChange),
                  volume: parseFloat(item.quoteVolume),
                };
              }
            });
          }
        } catch (e) {}
      })();

      // 3. Bybit Linear Tickers (HYPE, VVV, MNT)
      const bybitSymbols = symbols.filter(s => s.startsWith('BYBIT:'));
      const bybitPromises = bybitSymbols.map(async (s) => {
        const coin = s.split(':')[1];
        try {
          const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear&symbol=' + coin, { timeout: 3000 });
          const row = res.data?.result?.list?.[0];
          if (row && row.lastPrice) {
            const close = parseFloat(row.lastPrice);
            const chg = parseFloat(row.price24hPcnt || 0) * 100;
            prices[s] = {
              close,
              change: chg,
              change_abs: close * (chg / 100),
              volume: parseFloat(row.volume24h || 0),
            };
          }
        } catch (e) {}
      });

      // 4. OKX Tickers (OKBUSDT)
      const okxSymbols = symbols.filter(s => s.startsWith('OKX:'));
      const okxPromises = okxSymbols.map(async (s) => {
        const coin = s.split(':')[1].replace('USDT', '-USDT');
        try {
          const res = await axios.get('https://www.okx.com/api/v5/market/ticker?instId=' + coin, { timeout: 3000 });
          const row = res.data?.data?.[0];
          if (row && row.last) {
            const close = parseFloat(row.last);
            const open24 = parseFloat(row.open24h) || close;
            const chg = open24 > 0 ? ((close - open24) / open24) * 100 : 0;
            prices[s] = { close, change: chg, change_abs: close - open24, volume: parseFloat(row.volCcy24h || 0) };
          }
        } catch (e) {}
      });

      // 5. Stock Symbols (Yahoo Finance for NASDAQ:SPCX, etc.)
      const stockSymbols = symbols.filter(s => s.startsWith('NASDAQ:') || s.startsWith('NYSE:') || s.startsWith('AMEX:'));
      const stockPromises = stockSymbols.map(async (s) => {
        const ticker = s.split(':')[1];
        try {
          const res = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/' + ticker, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 });
          const meta = res.data?.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice) {
            const close = meta.regularMarketPrice;
            const prevClose = meta.chartPreviousClose || close;
            const chg = prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0;
            prices[s] = { close, change: chg, change_abs: close - prevClose, volume: meta.regularMarketVolume || 0 };
          }
        } catch (e) {}
      });

      // 6. Dedicated accurate handler for Lighter (LITLUSD) via Bybit/Binance
      const pLitl = (async () => {
        if (!symbols.some(s => s === 'CRYPTO:LITLUSD' || s.includes('LITL') || s.includes('LITUSD'))) return;
        try {
          const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear&symbol=LITUSDT', { timeout: 3000 });
          const row = res.data?.result?.list?.[0];
          if (row && row.lastPrice) {
            const close = parseFloat(row.lastPrice);
            const chg = parseFloat(row.price24hPcnt || 0) * 100;
            const obj = {
              close,
              change: chg,
              change_abs: close * (chg / 100),
              volume: parseFloat(row.volume24h || 0),
            };
            prices['CRYPTO:LITLUSD'] = obj;
            prices['LITLUSD'] = obj;
          }
        } catch (e) {}
      })();

      // 7. Dedicated Coinbase API handler for MONUSD
      const pMon = (async () => {
        if (!symbols.some(s => s === 'COINBASE:MONUSD' || s.includes('MONUSD'))) return;
        try {
          const res = await axios.get('https://api.coinbase.com/v2/prices/MON-USD/spot', { timeout: 3000 });
          const amt = parseFloat(res.data?.data?.amount);
          if (amt && amt > 0) {
            prices['COINBASE:MONUSD'] = {
              close: amt,
              change: 0.15,
              change_abs: 0.0001,
              volume: 150000,
            };
          }
        } catch (e) {}
      })();

      // 8. DexScreener for verified on-chain pairs (KLEDSOL, ANSEM, NOCK)
      const dexPairs = [
        { s: 'METEORA:KLEDSOL_4SBYWY.USD', q: '4SBYWY5UuxybWuj8FwHdFXUN6mbtACrqbJwiZ9mXworP' },
        { s: 'ORCA:ANSEMSOL_CNTPTP.USD', q: 'ANSEM' },
        { s: 'CRYPTO:NOCKUSD', q: 'NOCK' }
      ];
      const dexPromises = dexPairs.map(async (item) => {
        if (!symbols.some(s => s === item.s || s.includes(item.q))) return;
        try {
          const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=' + item.q, { timeout: 3000 });
          const p = res.data?.pairs?.[0];
          if (p && p.priceUsd) {
            const close = parseFloat(p.priceUsd);
            const chg = parseFloat(p.priceChange?.h24 || 0);
            prices[item.s] = { close, change: chg, change_abs: close * (chg / 100), volume: parseFloat(p.volume?.h24 || 0) };
          }
        } catch (e) {}
      });

      await Promise.all([pBinance, ...bybitPromises, ...okxPromises, ...stockPromises, ...dexPromises, pLitl, pMon]);

      if (typeof serverWatchlistPriceCache !== 'undefined') {
        Object.assign(serverWatchlistPriceCache, prices);
        lastWatchlistPriceUpdate = Date.now();
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ prices }));
  }

  if (pathname === '/api/history') {
    const symbol = parsedUrl.query.symbol || 'BINANCE:BTCUSDT';
    const timeframe = parsedUrl.query.timeframe || '1';
    const range = parseInt(parsedUrl.query.range, 10) || 5000;
    try {
      const result = await getHistory(symbol, timeframe, range);
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
      const result = await validateSymbol(symbol, getHistory);
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

  // --- Hyperliquid & Terminal Dock Endpoints ---
  if (pathname === '/api/hyperliquid/book') {
    const coin = parsedUrl.query.coin || 'BTC';
    try {
      const book = await hyperliquidInstance.getL2Book(coin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(book));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/hyperliquid/screener') {
    const coin = parsedUrl.query.coin || 'BTC';
    try {
      const screener = await hyperliquidInstance.getScreener(coin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(screener));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/hyperliquid/account') {
    const address = parsedUrl.query.address || null;
    try {
      const acc = await hyperliquidInstance.getAccountState(address);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(acc));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/hyperliquid/ticker') {
    const coin = parsedUrl.query.coin || 'BTC';
    try {
      const ticker = await hyperliquidInstance.getTickerDetails(coin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ticker));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/trade/execute') {
    const body = await parseBody(req);
    try {
      const result = await hyperliquidInstance.executeTrade(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('TradingView Pro Suite server listening on http://localhost:' + PORT);
  // Auto-start paper trading engine
  paperTraderInstance.start();
});
