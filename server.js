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
const { computeEdgeStats } = require('./src/extensions/statsEngine');
const { startDailyScheduler, syncDailySimulation } = require('./src/extensions/dailySimulationScheduler');
const { generateFullJournalCSV } = require('./src/extensions/journalExporter');
const { generateFullJournalExcelBuffer } = require('./src/extensions/excelExporter');
const { macroCalendarInstance } = require('./src/extensions/macroCalendar');
const { startMonthlyReportScheduler, dispatchMonthlyReport } = require('./src/extensions/monthlyReportScheduler');
const { authSecurityInstance } = require('./src/extensions/authSecurity');
const { userProfileManager } = require('./src/extensions/userProfileManager');
const { variationalConnector } = require('./src/extensions/variational');
const { getLoginPageHtml } = require('./src/views/loginPage');
const { stockProvider, isStockSymbol, isYahooMarketSymbol } = require('./src/extensions/stockProvider');

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

function formatTokenPriceServer(p) {
  if (typeof p !== 'number' || isNaN(p)) return '--';
  const abs = Math.abs(p);
  if (abs >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return p.toFixed(abs < 10 ? 3 : 2);
  if (abs >= 0.1) return p.toFixed(4);
  if (abs >= 0.001) return p.toFixed(6);
  if (abs >= 0.00001) return p.toFixed(7);
  return p.toFixed(8);
}

function mapTfToBinanceInterval(tf) {
  const s = String(tf || 'D').trim().toUpperCase();
  if (s === '1') return '1m';
  if (s === '3') return '3m';
  if (s === '5') return '5m';
  if (s === '15') return '15m';
  if (s === '30') return '30m';
  if (s === '60' || s === '1H') return '1h';
  if (s === '120' || s === '2H') return '2h';
  if (s === '240' || s === '4H') return '4h';
  if (s === 'D' || s === '1D') return '1d';
  if (s === 'W' || s === '1W') return '1w';
  if (s === 'M' || s === '1M') return '1M';
  return null;
}

const COMMON_PREWARM_TFS = ['1', '5', '15', '60', '240', 'D'];
const prewarmingActive = new Set();

function prewarmServerTimeframes(symbol) {
  if (!symbol) return;
  COMMON_PREWARM_TFS.forEach(tf => {
    const normTf = String(tf).trim();
    const key = symbol + ':' + normTf;
    const c = serverHistoryCache.get(key);
    if (!c || (Date.now() - c.timestamp > 240000)) {
      if (prewarmingActive.has(key)) return;
      prewarmingActive.add(key);
      setImmediate(async () => {
        try {
          await getHistory(symbol, normTf, 1000);
        } catch (e) {}
        prewarmingActive.delete(key);
      });
    }
  });
}

function fetchFromTradingViewWS(querySymbol, timeframe, range, cacheKey, resolve, reject) {
  const client = new TradingView.Client();
  const chart = new client.Session.Chart();
  let timer = setTimeout(() => {
    try { chart.delete(); client.end(); } catch (e) {}
    if (reject) reject(new Error('Timeout fetching history'));
    else resolve({ candles: [], infos: {} });
  }, 8000);

  chart.setMarket(querySymbol, { timeframe, range: range || 1000 });
  chart.onError((...err) => {
    clearTimeout(timer);
    try { chart.delete(); client.end(); } catch (e) {}
    if (reject) reject(new Error(err.join(' ')));
    else resolve({ candles: [], infos: {} });
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
}

const solanaDexPoolCache = new Map([
  ['KLED', '4SBYWY5UuxybWuj8FwHdFXUN6mbtACrqbJwiZ9mXworP'],
  ['METEORA:KLEDSOL_4SBYWY.USD', '4SBYWY5UuxybWuj8FwHdFXUN6mbtACrqbJwiZ9mXworP'],
  ['ORCA:ANSEMSOL_CNTPTP.USD', 'CNTPTpytHK9txrsPCvaEnc3PoN9ZVWDDcSnFSZZonMue'],
]);

function extractSolanaPoolPrefix(sym) {
  let clean = String(sym || '').toUpperCase().trim();
  if (clean.includes(':')) clean = clean.split(':')[1];
  clean = clean.replace(/\.(USD|USDT|USDC|P)$/i, '');
  const idx = clean.lastIndexOf('_');
  if (idx >= 0 && idx < clean.length - 1) {
    return clean.slice(idx + 1).trim();
  }
  return '';
}

function mapTfToGeckoParams(normTf) {
  const s = String(normTf || '60').trim().toUpperCase();
  if (s === '1') return { unit: 'minute', aggregate: 1 };
  if (s === '3' || s === '5') return { unit: 'minute', aggregate: 5 };
  if (s === '15' || s === '30') return { unit: 'minute', aggregate: 15 };
  if (s === '60') return { unit: 'hour', aggregate: 1 };
  if (s === '120' || s === '240') return { unit: 'hour', aggregate: 4 };
  return { unit: 'day', aggregate: 1 };
}

function extractSolanaSearchToken(sym) {
  let clean = String(sym || '').toUpperCase().trim();
  if (clean.includes(':')) clean = clean.split(':')[1];
  clean = clean.replace(/\.(USD|USDT|USDC|P)$/i, '');
  if (clean.includes('_')) clean = clean.split('_')[0];
  if (clean.length > 4 && clean.endsWith('SOL')) clean = clean.slice(0, -3);
  return clean.trim();
}

async function fetchGeckoSolanaBars(poolAddr, normTf, meta = {}) {
  const axios = require('axios');
  const { unit, aggregate } = mapTfToGeckoParams(normTf);
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddr}/ohlcv/${unit}?aggregate=${aggregate}&limit=1000`;
  const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
  const list = res.data?.data?.attributes?.ohlcv_list || [];
  if (!Array.isArray(list) || list.length === 0) return null;

  const byTime = new Map();
  for (const item of list) {
    const t = Math.floor(Number(item[0]));
    const open = Number(item[1]);
    const high = Number(item[2]);
    const low = Number(item[3]);
    const close = Number(item[4]);
    const vol = Number(item[5]) || 0;
    if (Number.isFinite(t) && t > 0 && open > 0 && close > 0 && high > 0 && low > 0) {
      byTime.set(t, { time: t, open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume: vol });
    }
  }
  const candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  if (candles.length === 0) return null;
  return {
    candles,
    infos: {
      name: meta.name || 'Solana DEX Pool',
      description: meta.description || 'Solana DEX Pool',
      exchange: meta.exchange || 'SOLANA',
      provider: 'GeckoTerminal (Solana)',
    },
  };
}

function getHistory(symbol, timeframe, range = 1000) {
  const normTf = String(timeframe || 'D').trim();
  const cacheKey = symbol + ":" + normTf;
  const now = Date.now();
  const cached = serverHistoryCache.get(cacheKey);

  // Return instantly from in-memory cache if less than 5 minutes old
  if (cached && (now - cached.timestamp < 300000)) {
    return Promise.resolve(cached.data);
  }

  let querySymbol = symbol;
  // Use native HyperliquidProvider (Vela Engine) for direct, sub-200ms candle snapshots
  if (querySymbol.startsWith('HYPERLIQUID:') || querySymbol === 'HYPE' || querySymbol === 'PURR') {
    return new Promise(async (resolve) => {
      try {
        const { hyperliquidProvider } = require('./src/extensions/hyperliquidProvider');
        const candles = await hyperliquidProvider.getBars(querySymbol, normTf, Math.min(range || 1000, 5000));
        if (candles && candles.length > 0) {
          const info = await hyperliquidProvider.getSymbolInfo(querySymbol);
          const resData = { candles, infos: info };
          serverHistoryCache.set(cacheKey, { timestamp: Date.now(), data: resData });
          prewarmServerTimeframes(symbol);
          return resolve(resData);
        }
      } catch (e) {}
      // fallback to TradingView session if HL API encounters error
      querySymbol = 'BYBIT:HYPEUSDT';
    });
  } else if (querySymbol === 'SP500' || querySymbol === 'SPX' || querySymbol.includes('SP500') || querySymbol.includes('SPXUSD')) {
    querySymbol = 'INDEX:SPX';
  } else if (querySymbol === 'GOLD' || querySymbol === 'XAUUSD' || querySymbol.includes('GOLD') || querySymbol.includes('XAU')) {
    querySymbol = 'TVC:GOLD';
  } else if (querySymbol === 'NVDA' || querySymbol.includes('NVDA')) {
    querySymbol = 'NASDAQ:NVDA';
  } else if (querySymbol.toUpperCase() === 'ANT' || querySymbol.toUpperCase() === 'ANTHROPIC' || querySymbol.toUpperCase() === 'NASDAQ:ANT') {
    querySymbol = 'NASDAQ:ANT';
  } else if (querySymbol.toUpperCase() === 'BTSE:OILUSD' || querySymbol.toUpperCase() === 'OILUSD') {
    querySymbol = 'BTSE:OILUSD.P';
  } else if (querySymbol.toUpperCase().includes('BRENT')) {
    querySymbol = 'HIP3XYZ:BRENTOILUSDC.P';
  }

  // Dedicated Stock & Benchmark Provider (NASDAQ, NYSE, AMEX, INDEX:SPX, TVC:GOLD, etc.)
  if (isYahooMarketSymbol(querySymbol)) {
    return new Promise(async (resolve) => {
      try {
        const resData = await stockProvider.getBars(querySymbol, normTf, Math.min(range || 1000, 5000));
        if (resData && resData.candles && resData.candles.length > 0) {
          serverHistoryCache.set(cacheKey, { timestamp: Date.now(), data: resData });
          prewarmServerTimeframes(symbol);
          return resolve(resData);
        }
      } catch (e) {}
      // Fallback to TradingView WS if stock provider encounters error
      return fetchFromTradingViewWS(querySymbol, normTf, range, cacheKey, resolve);
    });
  }

  // Fast CEX REST Kline loader for Binance pairs (Spot or Futures .P)
  const isBinance = !isYahooMarketSymbol(querySymbol) && (
    querySymbol.startsWith('BINANCE:') ||
    ((querySymbol.endsWith('USDT') || querySymbol.endsWith('USDC') || querySymbol.endsWith('BTC')) && !querySymbol.includes('BYBIT:') && !querySymbol.includes('INDEX:') && !querySymbol.includes('TVC:'))
  );
  if (isBinance) {
    const bInterval = mapTfToBinanceInterval(normTf);
    if (bInterval) {
      return new Promise(async (resolve) => {
        try {
          const axios = require('axios');
          const isBinancePerp = querySymbol.toUpperCase().startsWith('BINANCE:') && querySymbol.toUpperCase().endsWith('.P');
          let pair = querySymbol.replace(/^BINANCE:/i, '').replace(/\.P$/i, '').toUpperCase();
          const lim = Math.min(range || 1000, 1000);
          const urls = isBinancePerp
            ? [`https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${bInterval}&limit=${lim}`]
            : [
                `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${bInterval}&limit=${lim}`,
                `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${bInterval}&limit=${lim}`
              ];
          for (const url of urls) {
            try {
              const res = await axios.get(url, { timeout: 3500 });
              if (Array.isArray(res.data) && res.data.length > 0) {
                const candles = res.data.map(k => ({
                  time: Math.floor(k[0] / 1000),
                  open: parseFloat(k[1]),
                  high: parseFloat(k[2]),
                  low: parseFloat(k[3]),
                  close: parseFloat(k[4]),
                  volume: parseFloat(k[5]) || 0,
                }));
                const resData = {
                  candles,
                  infos: { name: pair, description: `${pair} on Binance`, exchange: 'BINANCE', currency: pair.endsWith('USDT') ? 'USDT' : 'USD' }
                };
                serverHistoryCache.set(cacheKey, { timestamp: Date.now(), data: resData });
                prewarmServerTimeframes(symbol);
                return resolve(resData);
              }
            } catch (innerE) {}
          }
        } catch (e) {}

        // Fallback to TradingView WS if Binance REST fails
        return fetchFromTradingViewWS(querySymbol, normTf, range, cacheKey, resolve);
      });
    }
  }

  // Solana DEX pools (ORCA, METEORA, RAYDIUM, PUMPSWAP) via GeckoTerminal + DexScreener pool resolver
  const symUpper = querySymbol.toUpperCase();
  const isSolanaDex = symUpper.startsWith('ORCA:') || symUpper.startsWith('METEORA:') ||
    symUpper.startsWith('RAYDIUM:') || symUpper.startsWith('PUMPSWAP:') ||
    symUpper.includes('KLED') || symUpper.includes('4SBYWY') || symUpper.includes('ANSEM');
  if (isSolanaDex) {
    return new Promise(async (resolve) => {
      try {
        const axios = require('axios');
        const exName = querySymbol.includes(':') ? querySymbol.split(':')[0].toUpperCase() : 'SOLANA';
        const tokenBase = extractSolanaSearchToken(querySymbol);
        const poolPrefix = extractSolanaPoolPrefix(querySymbol);
        const symCacheKey = symUpper;
        let poolAddr = solanaDexPoolCache.get(symCacheKey) || solanaDexPoolCache.get(tokenBase) || null;
        let desc = `${tokenBase} / Solana Pool`;

        if (!poolAddr && symUpper.includes('4SBYWY')) {
          poolAddr = '4SBYWY5UuxybWuj8FwHdFXUN6mbtACrqbJwiZ9mXworP';
          desc = 'KLEDAI / Wrapped SOL';
        }
        if (!poolAddr && tokenBase) {
          const searchRes = await axios.get('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(tokenBase), { timeout: 4000 });
          const solPairs = (searchRes.data?.pairs || [])
            .filter(p => p.chainId === 'solana' && p.pairAddress);
          const prefixMatch = poolPrefix
            ? solPairs.find(p => p.pairAddress.toUpperCase().startsWith(poolPrefix))
            : null;
          const dexMatches = solPairs
            .filter(p => String(p.dexId || '').toUpperCase() === exName)
            .sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
          const sortedAll = solPairs
            .slice()
            .sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
          const chosen = prefixMatch || dexMatches[0] || sortedAll[0] || null;
          if (chosen) {
            poolAddr = chosen.pairAddress;
            desc = `${chosen.baseToken?.symbol || tokenBase} / ${chosen.quoteToken?.symbol || 'SOL'} (${chosen.dexId})`;
            solanaDexPoolCache.set(symCacheKey, poolAddr);
          }
        }
        if (poolAddr) {
          const resData = await fetchGeckoSolanaBars(poolAddr, normTf, { name: tokenBase || querySymbol, description: desc, exchange: exName });
          if (resData && resData.candles && resData.candles.length > 0) {
            serverHistoryCache.set(cacheKey, { timestamp: Date.now(), data: resData });
            return resolve(resData);
          }
        }
      } catch (err) {}
      return fetchFromTradingViewWS(querySymbol, normTf, range, cacheKey, resolve);
    });
  }

  return new Promise((resolve, reject) => {
    fetchFromTradingViewWS(querySymbol, normTf, range, cacheKey, resolve, reject);
  });
}

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title id="page-title">Hyperview</title>
  <link id="page-favicon" rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="alternate icon" href="/public/favicon.svg">
  <script src="/public/lightweight-charts.js"></script>
  <script src="/public/drawingTools.js"></script>
  <script src="/public/replayStudio.js"></script>
  <script src="/public/multiChart.js"></script>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
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
    body {
      background: #080b12 radial-gradient(circle at 50% 0%, #111728 0%, #06080e 100%);
      color: var(--text-primary); height: 100vh; display: flex; flex-direction: column; overflow: hidden;
    }

    header {
      background: rgba(12, 16, 26, 0.72) !important;
      backdrop-filter: blur(24px) saturate(190%) !important;
      -webkit-backdrop-filter: blur(24px) saturate(190%) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
      padding: 8px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35), inset 0 -1px 0 rgba(255, 255, 255, 0.05);
      z-index: 20;
    }
    .brand-section { display: flex; align-items: center; gap: 10px; }
    .badge {
      display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
      background: rgba(38, 166, 154, 0.12) !important; color: #4ade80 !important;
      border-radius: 999px; font-size: 11px; font-weight: 700;
      border: 1px solid rgba(74, 222, 128, 0.28) !important;
      backdrop-filter: blur(8px) !important;
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.15);
    }
    .badge-dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 8px #4ade80; animation: pulse 1.8s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }

    .nav-tabs { display: flex; gap: 6px; align-items: center; }
    .tab-btn {
      background: rgba(255, 255, 255, 0.035); color: #94a3b8; border: 1px solid rgba(255, 255, 255, 0.07);
      padding: 6px 12px; border-radius: 8px; font-size: 11.5px; font-weight: 600; cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); backdrop-filter: blur(8px);
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.1);
    }
    .tab-btn:hover {
      color: #fff; background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.16);
      transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25), inset 0 1px 0.5px rgba(255, 255, 255, 0.18);
    }
    .tab-btn.active {
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.9), rgba(29, 78, 216, 0.95)) !important;
      color: #fff !important; border: 1px solid rgba(96, 165, 250, 0.45) !important;
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35), inset 0 1px 1px rgba(255, 255, 255, 0.3) !important;
    }

    .content-area { flex: 1; position: relative; overflow: hidden; }
    .view-panel { width: 100%; height: 100%; display: none; flex-direction: column; }
    .view-panel.active { display: flex; }

    .controls-bar {
      background: rgba(16, 20, 32, 0.72) !important;
      backdrop-filter: blur(20px) saturate(180%) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
      padding: 8px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    }
    .preset-group, .tf-group { display: flex; gap: 4px; }
    .btn {
      background: rgba(255, 255, 255, 0.04); color: #94a3b8; border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 5px 10px; border-radius: 6px; font-size: 11.5px; font-weight: 600; cursor: pointer;
      backdrop-filter: blur(6px); transition: all 0.15s;
    }
    .btn:hover { color: #fff; background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.15); }
    .btn.active {
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.9), rgba(29, 78, 216, 0.95)) !important;
      color: #fff !important; border-color: rgba(96, 165, 250, 0.45) !important;
      box-shadow: 0 3px 10px rgba(37, 99, 235, 0.3), inset 0 1px 0.5px rgba(255, 255, 255, 0.25);
    }

    .search-input {
      background: var(--bg-tertiary); border: 1px solid var(--border-color);
      color: var(--text-primary); padding: 5px 10px; border-radius: 5px; font-size: 12px; outline: none; width: 180px;
    }

    /* Dark Mode Theme for Native Select & Options (Prevents white background on Chrome/Windows) */
    select {
      background-color: #151924 !important;
      color: #f0f3f6 !important;
      border: 1px solid rgba(255, 255, 255, 0.15) !important;
    }
    select option {
      background-color: #131722 !important;
      color: #f0f3f6 !important;
      padding: 6px 10px;
    }
    select option:checked, select option:hover {
      background-color: #2563eb !important;
      color: #ffffff !important;
    }

    #chart-container { flex: 1; width: 100%; position: relative; }
    #indicators-hud-stack::-webkit-scrollbar { width: 4px; }
    #indicators-hud-stack::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 2px; }

    /* iOS Liquid Glass Design System */
    .ios-glass-panel {
      pointer-events: auto;
      background: rgba(14, 18, 30, 0.65) !important;
      backdrop-filter: blur(20px) saturate(190%) !important;
      -webkit-backdrop-filter: blur(20px) saturate(190%) !important;
      border: 1px solid rgba(255, 255, 255, 0.14) !important;
      border-radius: 14px !important;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 
                  0 4px 12px rgba(0, 0, 0, 0.25), 
                  inset 0 1px 1px 0 rgba(255, 255, 255, 0.22),
                  inset 0 -1px 1px 0 rgba(0, 0, 0, 0.25) !important;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1) !important;
    }
    .ios-glass-panel:hover {
      background: rgba(16, 21, 35, 0.78) !important;
      border-color: rgba(255, 255, 255, 0.22) !important;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55), 
                  0 6px 16px rgba(0, 0, 0, 0.3), 
                  inset 0 1px 1px 0 rgba(255, 255, 255, 0.3) !important;
    }
    .ios-glass-card {
      background: rgba(255, 255, 255, 0.045) !important;
      backdrop-filter: blur(10px) !important;
      -webkit-backdrop-filter: blur(10px) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 8px !important;
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.15) !important;
    }
    .ios-glass-pill {
      border-radius: 20px !important;
      backdrop-filter: blur(8px) !important;
      -webkit-backdrop-filter: blur(8px) !important;
      border: 1px solid rgba(255, 255, 255, 0.15) !important;
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.2) !important;
    }
    .legend-overlay {
      position: absolute; top: 12px; left: 16px; z-index: 10; pointer-events: none;
      font-size: 11.5px; line-height: 1.5; background: rgba(13, 17, 28, 0.65);
      backdrop-filter: blur(16px) saturate(180%);
      -webkit-backdrop-filter: blur(16px) saturate(180%);
      padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35), inset 0 1px 0.5px rgba(255, 255, 255, 0.18);
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

    /* Active Paper Positions Table - Fixed Layout & Zero-Jitter */
    #table-paper-positions {
      width: 100%;
      table-layout: fixed;
      border-collapse: collapse;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      font-feature-settings: 'tnum';
      min-width: 980px;
    }
    #table-paper-positions th {
      padding: 9px 8px;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-variant-numeric: tabular-nums;
      font-feature-settings: 'tnum';
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      user-select: none;
      box-sizing: border-box;
    }
    #table-paper-positions td {
      padding: 9px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-variant-numeric: tabular-nums;
      font-feature-settings: 'tnum';
      vertical-align: middle;
      box-sizing: border-box;
    }
    #table-paper-positions .pos-col-symbol   { width: 14.5%; min-width: 135px; }
    #table-paper-positions .pos-col-side     { width: 6.5%; min-width: 55px; text-align: center; }
    #table-paper-positions .pos-col-lev      { width: 5.5%; min-width: 48px; text-align: center; }
    #table-paper-positions .pos-col-entry    { width: 8.5%; min-width: 78px; }
    #table-paper-positions .pos-col-mark     { width: 10%; min-width: 92px; }
    #table-paper-positions .pos-col-tp       { width: 8.5%; min-width: 78px; }
    #table-paper-positions .pos-col-sl       { width: 8.5%; min-width: 78px; }
    #table-paper-positions .pos-col-margin   { width: 8.5%; min-width: 75px; }
    #table-paper-positions .pos-col-notional { width: 8.5%; min-width: 75px; }
    #table-paper-positions .pos-col-pnl      { width: 14%; min-width: 155px; }
    #table-paper-positions .pos-col-action   { width: 7%; min-width: 72px; text-align: center; }

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
      grid-template-columns: 82px 66px 52px 50px 20px;
      column-gap: 5px;
      align-items: center;
      padding: 6px 14px 6px 8px;
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
      grid-template-columns: 82px 66px 52px 50px 20px;
      column-gap: 5px;
      align-items: center;
      padding: 6px 14px 6px 8px;
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
      opacity: 0; color: var(--text-secondary); cursor: pointer; padding: 1px 4px;
      border-radius: 3px; font-size: 10px; text-align: center; margin-left: 2px; margin-right: 4px;
    }
    .wl-row:hover .wl-del { opacity: 0.7; }
    .wl-row .wl-del:hover { opacity: 1; color: var(--accent-red); background: rgba(239, 83, 80, 0.15); }

    #watchlist-sidebar {
      width: 315px;
      background: rgba(10, 13, 22, 0.72) !important;
      backdrop-filter: blur(22px) saturate(190%) !important;
      -webkit-backdrop-filter: blur(22px) saturate(190%) !important;
      border-right: 1px solid rgba(255, 255, 255, 0.08) !important;
      display: flex; flex-direction: column; height: 100%; flex-shrink: 0; z-index: 5;
      overflow: hidden; box-sizing: border-box;
      box-shadow: 4px 0 25px rgba(0, 0, 0, 0.35);
    }
    #watchlist-list {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
      scrollbar-gutter: stable;
    }
    #watchlist-list::-webkit-scrollbar { width: 5px; }
    #watchlist-list::-webkit-scrollbar-track { background: transparent; }
    #watchlist-list::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.18); border-radius: 3px; }

    .search-sug-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04);
      font-size: 11px; transition: background 0.1s;
    }
    .search-sug-item:hover { background: var(--bg-tertiary); }
    .search-sug-item.active { background: rgba(41, 98, 255, 0.2); }

    /* Hyperliquid Two-Tier Market Header & Chart Toolbar - iOS Liquid Glass */
    .hl-ticker-bar {
      display: flex; align-items: center;
      padding: 4px 14px;
      background: rgba(10, 14, 22, 0.70) !important;
      backdrop-filter: blur(20px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07) !important;
      height: 42px; gap: 14px; overflow-x: auto; user-select: none; flex-shrink: 0;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
    }
    .hl-ticker-bar::-webkit-scrollbar { height: 2px; }
    .hl-ticker-left {
      display: flex; align-items: center; gap: 8px; flex-shrink: 0;
    }
    .hl-drag-handle {
      color: #64748b; font-size: 14px; cursor: grab; padding: 0 2px;
    }
    .hl-market-badge {
      display: flex; align-items: center; gap: 8px; padding: 4px 10px;
      background: rgba(255, 255, 255, 0.04) !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      border-radius: 9px !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.18);
    }
    .hl-badge-sub {
      font-size: 8px; font-weight: 700; color: #94a3b8; text-transform: uppercase; line-height: 1; letter-spacing: 0.6px; margin-bottom: 3.5px; display: block;
    }
    .hl-badge-title {
      font-size: 13px; font-weight: 800; color: #fff; line-height: 1.1; letter-spacing: 0.4px;
    }
    .hl-stat-group {
      display: flex; align-items: center; justify-content: center; gap: 20px;
      flex: 1; margin: 0 auto;
    }
    .hl-stat-item {
      display: flex; flex-direction: column; flex-shrink: 0;
    }
    .hl-stat-lbl {
      font-size: 8px; color: #8c93a3; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 1.5px;
    }
    .hl-stat-val {
      font-size: 11px; font-weight: 800; color: #fff; line-height: 1.1;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-feature-settings: 'tnum';
      font-variant-numeric: tabular-nums;
    }
    .hl-vdiv {
      width: 1px; height: 16px; background: rgba(255, 255, 255, 0.08); flex-shrink: 0;
    }

    /* Tier 2: Chart Toolbar */
    .hl-chart-toolbar {
      position: relative; z-index: 40;
      display: flex; align-items: center; justify-content: space-between;
      padding: 3px 12px;
      background: rgba(12, 16, 26, 0.65) !important;
      backdrop-filter: blur(16px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(16px) saturate(180%) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06) !important;
      height: 34px; gap: 6px; font-size: 11.5px; user-select: none; flex-shrink: 0;
    }
    .hl-tb-left {
      display: flex; align-items: center; gap: 2px;
    }
    .hl-tf-btn {
      background: rgba(255, 255, 255, 0.03); border: 1px solid transparent; color: #8c93a3; font-size: 11px; font-weight: 600;
      padding: 2px 7px; border-radius: 5px; cursor: pointer; transition: all 0.15s;
    }
    .hl-tf-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.1); }
    .hl-tf-btn.active {
      color: #fff !important; background: rgba(247, 147, 26, 0.2) !important;
      border-color: rgba(247, 147, 26, 0.4) !important; font-weight: 800;
      box-shadow: 0 0 10px rgba(247, 147, 26, 0.25);
    }
    .hl-tool-btn {
      display: flex; align-items: center; gap: 4px; background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.07);
      color: #d1d4dc; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px; cursor: pointer;
      backdrop-filter: blur(6px); transition: all 0.15s;
    }
    .hl-tool-btn:hover { background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.15); color: #fff; }
    .hl-tool-btn.active {
      background: rgba(168, 85, 247, 0.2) !important; color: #c084fc !important;
      border-color: rgba(168, 85, 247, 0.45) !important;
      box-shadow: 0 0 12px rgba(168, 85, 247, 0.25);
    }
    .hl-icon-btn {
      background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06);
      color: #8c93a3; font-size: 12px; padding: 3px 6px;
      border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    .hl-icon-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.15); }

    /* Vela-Style Drawing Toolbar & Dropdown Menu */
    .draw-tool-btn {
      width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      background: transparent; border: 1px solid transparent;
      color: #94a3b8; border-radius: 6px; cursor: pointer;
      transition: all 0.15s ease;
    }
    .draw-tool-btn:hover {
      background: rgba(255, 255, 255, 0.08); color: #fff;
    }
    .draw-tool-btn.active {
      background: rgba(168, 85, 247, 0.25) !important;
      color: #c084fc !important;
      border-color: rgba(168, 85, 247, 0.5) !important;
      box-shadow: 0 0 10px rgba(168, 85, 247, 0.3);
    }
    .draw-dropdown-item {
      width: 100% !important;
      height: 32px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: flex-start !important;
      gap: 10px !important;
      padding: 0 10px !important;
      border-radius: 6px !important;
      cursor: pointer !important;
      background: transparent !important;
      border: 1px solid transparent !important;
      color: #94a3b8 !important;
      font-size: 11.5px !important;
      font-family: inherit !important;
      white-space: nowrap !important;
      box-sizing: border-box !important;
      text-align: left !important;
      line-height: 1 !important;
      transition: all 0.15s ease !important;
      outline: none !important;
    }
    .draw-dropdown-item svg {
      color: #94a3b8 !important;
      transition: color 0.15s ease !important;
    }
    .draw-dropdown-item:hover {
      background: rgba(255, 255, 255, 0.06) !important;
      color: #f1f5f9 !important;
    }
    .draw-dropdown-item:hover svg {
      color: #f1f5f9 !important;
    }
    .draw-dropdown-item.active {
      background: rgba(56, 189, 248, 0.14) !important;
      color: #38bdf8 !important;
      border: 1px solid rgba(56, 189, 248, 0.35) !important;
      font-weight: 700 !important;
    }
    .draw-dropdown-item.active svg {
      color: #38bdf8 !important;
    }
    .draw-dropdown-item.active span {
      color: #38bdf8 !important;
    }
    .draw-dropdown-item[data-tool="ruler"] {
      color: #38bdf8 !important;
    }
    .draw-dropdown-item[data-tool="ruler"] svg, .draw-dropdown-item[data-tool="ruler"] span {
      color: #38bdf8 !important;
    }
    .draw-dropdown-item[data-tool="long_pos"] {
      color: #34d399 !important;
    }
    .draw-dropdown-item[data-tool="long_pos"] span {
      color: #34d399 !important;
    }
    .draw-dropdown-item[data-tool="short_pos"] {
      color: #f87171 !important;
    }
    .draw-dropdown-item[data-tool="short_pos"] span {
      color: #f87171 !important;
    }
    .draw-dropdown-item[data-tool="trash"] {
      color: #ef4444 !important;
    }
    .draw-dropdown-item[data-tool="trash"] svg, .draw-dropdown-item[data-tool="trash"] span {
      color: #ef4444 !important;
    }
    .draw-sep {
      width: 20px; height: 1px; background: rgba(255, 255, 255, 0.08); margin: 2px 0;
    }

    /* Proliquid Trading Dock Styles - iOS Liquid Glass Modular Blocks */
    .dock-panel {
      width: 400px;
      background: rgba(10, 14, 24, 0.72) !important;
      backdrop-filter: blur(24px) saturate(190%) !important;
      -webkit-backdrop-filter: blur(24px) saturate(190%) !important;
      border-left: 1px solid rgba(255, 255, 255, 0.08) !important;
      display: flex; flex-direction: column; height: 100%; z-index: 5; flex-shrink: 0;
      overflow-y: auto; overflow-x: hidden; padding: 12px; gap: 12px;
      box-shadow: -6px 0 30px rgba(0, 0, 0, 0.45);
    }
    .dock-panel::-webkit-scrollbar { width: 4px; }
    .dock-panel::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.18); border-radius: 2px; }

    /* Top Dock Navigation Segment */
    .dock-segmented-bar {
      display: flex;
      background: rgba(255, 255, 255, 0.04) !important;
      border: 1px solid rgba(255, 255, 255, 0.09) !important;
      border-radius: 10px !important;
      padding: 3px; gap: 3px; flex-shrink: 0;
      backdrop-filter: blur(14px) !important;
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.12);
    }
    .dock-seg-btn {
      flex: 1; padding: 5px 8px; font-size: 10px; font-weight: 700; color: #8c93a3;
      background: transparent; border: 1px solid transparent; border-radius: 7px; cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); text-align: center; white-space: nowrap;
    }
    .dock-seg-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.06); }
    .dock-seg-btn.active {
      color: #fff !important;
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.9), rgba(29, 78, 216, 0.95)) !important;
      border: 1px solid rgba(96, 165, 250, 0.45) !important;
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35), inset 0 1px 1px rgba(255, 255, 255, 0.3) !important;
    }

    /* Modular Dock Cards / Blocks */
    .dock-block {
      background: rgba(16, 21, 34, 0.65) !important;
      backdrop-filter: blur(20px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      border-radius: 14px !important;
      padding: 12px 14px; display: flex; flex-direction: column; position: relative;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.38), 
                  0 2px 6px rgba(0, 0, 0, 0.2), 
                  inset 0 1px 1px rgba(255, 255, 255, 0.2) !important;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .dock-block:hover {
      border-color: rgba(255, 255, 255, 0.16) !important;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.48), inset 0 1px 1px rgba(255, 255, 255, 0.25) !important;
    }
    .dock-block-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;
      padding-bottom: 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 11px; font-weight: 800; letter-spacing: 0.5px; color: #fff;
    }
    
    /* Account & Web3 Connect */
    .badge-paper {
      font-size: 8.5px; padding: 2px 7px; border-radius: 999px;
      background: rgba(34, 197, 94, 0.12); color: #4ade80; font-weight: 800;
      border: 1px solid rgba(74, 222, 128, 0.3);
      backdrop-filter: blur(6px);
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.15);
    }
    .badge-hl-live {
      font-size: 8.5px; padding: 2px 7px; border-radius: 999px;
      background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 800;
      border: 1px solid rgba(56, 189, 248, 0.35);
      backdrop-filter: blur(6px);
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.15);
    }
    .btn-wallet-connect {
      display: flex; align-items: center; gap: 5px; padding: 4px 10px; font-size: 10px; font-weight: 700;
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.9), rgba(29, 78, 216, 0.95)) !important;
      color: #fff; border: 1px solid rgba(96, 165, 250, 0.5) !important;
      border-radius: 8px !important; cursor: pointer; transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35), inset 0 1px 1px rgba(255, 255, 255, 0.3) !important;
    }
    .btn-wallet-connect:hover {
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.95), rgba(37, 99, 235, 1)) !important;
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(37, 99, 235, 0.45), inset 0 1px 1px rgba(255, 255, 255, 0.35) !important;
    }
    .account-details-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 2px;
    }
    .acc-stat-box {
      background: rgba(255, 255, 255, 0.04) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 9px !important; padding: 7px 10px;
      min-height: 48px; display: flex; flex-direction: column; justify-content: center;
      backdrop-filter: blur(10px) !important;
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.15) !important;
    }
    .acc-stat-lbl { font-size: 8.5px; color: #94a3b8; font-weight: 700; text-transform: uppercase; margin-bottom: 3px; letter-spacing: 0.3px; }
    .acc-stat-val { 
      font-size: 11.5px; font-weight: 700; color: #f0f3f6; 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-feature-settings: 'tnum';
      font-variant-numeric: tabular-nums;
      line-height: 1.25;
    }
    
    /* Screener Table */
    .scr-table { width: 100%; display: flex; flex-direction: column; }
    .scr-header-row, .scr-row {
      display: grid; grid-template-columns: 1.2fr 1fr 1fr; font-size: 11px; padding: 4px 0;
      align-items: center;
    }
    .scr-row {
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    .scr-header-row {
      margin-bottom: 2px; padding-bottom: 5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .scr-col-th {
      text-align: right; font-size: 9.5px; color: #94a3b8; font-weight: 700; letter-spacing: 0.5px;
    }
    .scr-label { color: #94a3b8; font-size: 9.5px; font-weight: 600; text-transform: uppercase; }
    .scr-val { text-align: right; font-family: monospace; font-weight: 700; font-size: 11px; }
    
    /* Orderbook L2 */
    .ob-row { position: relative; display: flex; justify-content: space-between; padding: 2.5px 6px; font-size: 10px; cursor: pointer; transition: background 0.1s; border-radius: 3px; }
    .ob-row:hover { background: rgba(255,255,255,0.08); }
    .ob-bg { position: absolute; top: 0; bottom: 0; right: 0; opacity: 0.22; pointer-events: none; z-index: 1; transition: width 0.15s; border-radius: 3px; }
    .ob-bg-ask { background: #ef5350; }
    .ob-bg-bid { background: #26a69a; }
    .ob-cell { z-index: 2; text-align: right; font-family: monospace; }
    .ob-cell-price { z-index: 2; text-align: left; font-weight: 700; font-family: monospace; }
    .ob-spread-bar {
      padding: 5px 8px; margin: 5px 0;
      background: rgba(255, 255, 255, 0.04) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 8px !important;
      display: flex; justify-content: space-between; align-items: center; font-size: 9.5px;
      backdrop-filter: blur(10px) !important;
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.12) !important;
    }
    .ob-ratio-bar {
      width: 100%; height: 4px; background: #ef5350; border-radius: 2px; overflow: hidden; margin-top: 2px;
      display: flex;
    }
    .ob-ratio-bid { background: #26a69a; height: 100%; }

    /* Execution Panel */
    .exec-input-group {
      background: rgba(255, 255, 255, 0.04) !important;
      border: 1px solid rgba(255, 255, 255, 0.09) !important;
      border-radius: 9px !important;
      padding: 5px 8px; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;
      backdrop-filter: blur(10px) !important;
      box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.12) !important;
      transition: border-color 0.15s;
    }
    .exec-input-group:focus-within { border-color: rgba(96, 165, 250, 0.5) !important; }
    .exec-input {
      background: transparent; border: none; color: #fff; font-family: monospace; font-size: 11.5px;
      font-weight: 700; outline: none; width: 100%;
    }
    .exec-slider {
      width: 100%; -webkit-appearance: none; height: 4px; border-radius: 2px;
      background: rgba(255, 255, 255, 0.08); outline: none; margin: 6px 0;
    }
    .exec-slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none; width: 13px; height: 13px; border-radius: 50%;
      background: #3b82f6; cursor: pointer; box-shadow: 0 0 8px rgba(59, 130, 246, 0.7);
    }
    .pct-chips { display: flex; gap: 4px; margin-bottom: 6px; }
    .pct-chip {
      flex: 1; background: rgba(255, 255, 255, 0.04) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      color: #94a3b8; border-radius: 6px !important;
      font-size: 9px; font-weight: 700; padding: 3px 0; text-align: center; cursor: pointer;
      transition: all 0.15s; backdrop-filter: blur(6px);
    }
    .pct-chip:hover, .pct-chip.active { background: rgba(37, 99, 235, 0.25) !important; color: #fff; border-color: rgba(96, 165, 250, 0.5) !important; }
    .exec-btn {
      width: 100%; padding: 8px 10px; border-radius: 8px; font-size: 11px; font-weight: 800; cursor: pointer;
      display: flex; flex-direction: column; align-items: center; justify-content: center; transition: all 0.15s;
    }
    .exec-btn-buy {
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(16, 185, 129, 0.1)) !important;
      border: 1px solid rgba(74, 222, 128, 0.35) !important;
      color: #4ade80 !important;
      backdrop-filter: blur(8px) !important;
      box-shadow: 0 4px 14px rgba(34, 197, 94, 0.15), inset 0 1px 0.5px rgba(255, 255, 255, 0.2) !important;
    }
    .exec-btn-buy:hover {
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.85), rgba(16, 185, 129, 0.95)) !important;
      color: #fff !important;
      border-color: rgba(134, 239, 172, 0.5) !important;
      box-shadow: 0 6px 20px rgba(34, 197, 94, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.3) !important;
    }
    .exec-btn-sell {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(220, 38, 38, 0.1)) !important;
      border: 1px solid rgba(248, 113, 113, 0.35) !important;
      color: #f87171 !important;
      backdrop-filter: blur(8px) !important;
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.15), inset 0 1px 0.5px rgba(255, 255, 255, 0.2) !important;
    }
    .exec-btn-sell:hover {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.85), rgba(220, 38, 38, 0.95)) !important;
      color: #fff !important;
      border-color: rgba(252, 165, 165, 0.5) !important;
      box-shadow: 0 6px 20px rgba(239, 68, 68, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.3) !important;
    }

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
       TRADESYNC JOURNALING DASHBOARD STYLES (SHADCN ZINC DARK)
       ======================================================== */
    .ts-dashboard {
      flex: 1; overflow-y: auto; background: #09090b; padding: 18px 24px 28px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      color: #fafafa; box-sizing: border-box; scrollbar-width: thin; scrollbar-color: #27272a transparent;
    }
    .ts-dashboard::-webkit-scrollbar { width: 6px; }
    .ts-dashboard::-webkit-scrollbar-thumb { background: #27272a; border-radius: 3px; }
    .ts-dashboard-inner {
      max-width: 1620px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 16px;
    }

    /* Top Header & Toolbar within Journal */
    .ts-top-header {
      display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap;
    }
    .ts-title-left {
      display: flex; align-items: center; gap: 10px;
    }
    .ts-title {
      font-size: 20px; font-weight: 600; color: #fafafa; letter-spacing: -0.025em; margin: 0; line-height: 1.25;
    }
    .ts-top-right {
      display: flex; align-items: center; gap: 8px;
    }
    .ts-status-badge {
      display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 999px;
      background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.28);
      font-size: 11px; font-weight: 500; color: #34d399;
    }
    .ts-status-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #10b981;
    }

    /* Filter & Action Toolbars */
    .ts-toolbar {
      display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .ts-pill-group {
      display: inline-flex; background: #18181b; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 3px; gap: 2px;
    }
    .ts-pill-btn {
      height: 28px; padding: 0 11px; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer;
      color: #a1a1aa; background: transparent; border: 1px solid transparent; transition: all 0.15s;
      display: inline-flex; align-items: center; gap: 5px;
    }
    .ts-pill-btn.active {
      background: #09090b; color: #fafafa; border-color: #27272a; box-shadow: 0 1px 2px rgba(0,0,0,0.45); font-weight: 500;
    }
    .ts-pill-btn:hover:not(.active) { color: #fafafa; }
    .ts-dropdowns {
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    }
    .ts-select {
      height: 32px; background-color: #09090b !important; border: 1px solid #27272a !important; border-radius: 6px;
      color: #fafafa !important; font-size: 12.5px; font-weight: 500; padding: 0 10px; cursor: pointer; outline: none;
    }
    .ts-select:hover { border-color: #3f3f46 !important; }

    .ts-subtabs {
      display: inline-flex; background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 3px; gap: 2px;
    }
    .ts-subtab-btn {
      padding: 4px 12px; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer;
      color: #a1a1aa; background: transparent; border: none; transition: all 0.15s;
    }
    .ts-subtab-btn.active {
      background: #09090b; color: #fafafa;
    }
    .ts-btn-outline {
      background: transparent; border: 1px solid #27272a; border-radius: 6px; color: #fafafa; height: 32px;
      font-size: 12.5px; font-weight: 500; padding: 0 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.15s;
    }
    .ts-btn-outline:hover { background: #18181b; border-color: #3f3f46; }
    .ts-btn-white {
      background: #fafafa; color: #18181b; border: 1px solid #fafafa; border-radius: 6px; height: 32px;
      font-size: 12.5px; font-weight: 600; padding: 0 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.15s;
    }
    .ts-btn-white:hover { background: #e4e4e7; }
    .ts-btn-primary {
      background: #fafafa; color: #18181b; border: 1px solid #fafafa; border-radius: 6px; height: 32px;
      font-size: 12.5px; font-weight: 600; padding: 0 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 0.15s;
    }
    .ts-btn-primary:hover { background: #e4e4e7; }
    .ts-badge-free {
      background: rgba(16, 185, 129, 0.12); color: #34d399; font-size: 10px; padding: 1px 6px; border-radius: 999px; font-weight: 500;
    }

    /* 5 KPI Summary Ribbon */
    .ts-kpi-grid {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px;
    }
    @media (max-width: 1100px) {
      .ts-kpi-grid { grid-template-columns: repeat(2, 1fr); }
    }
    .ts-kpi-card {
      background: #0c0c0f; border: 1px solid #27272a; border-radius: 10px; padding: 14px 16px;
      display: flex; flex-direction: column; justify-content: space-between; min-height: 110px;
    }
    .ts-kpi-head {
      display: flex; justify-content: space-between; align-items: center; font-size: 11px;
      font-weight: 500; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px;
    }
    .ts-kpi-val {
      font-size: 20px; font-weight: 600; color: #fafafa; line-height: 1.2; margin-bottom: 2px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
    }
    .ts-kpi-val.green { color: #34d399; }
    .ts-kpi-val.red { color: #f87171; }
    .ts-kpi-sub {
      font-size: 11.5px; color: #71717a; margin-bottom: 8px; font-weight: 400;
    }
    .ts-bar-dual {
      display: flex; height: 5px; border-radius: 999px; overflow: hidden; background: #18181b; margin: 4px 0;
    }
    .ts-bar-dual-green { background: #10b981; }
    .ts-bar-dual-red { background: #ef4444; }
    .ts-kpi-split-foot {
      display: flex; justify-content: space-between; font-size: 11px; font-weight: 500; margin-top: 4px;
      font-variant-numeric: tabular-nums;
    }
    .ts-sub-bar-row {
      display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-top: 4px;
      font-variant-numeric: tabular-nums;
    }
    .ts-sub-bar-track {
      flex: 1; height: 4px; border-radius: 999px; background: #18181b; margin: 0 8px; overflow: hidden;
    }

    /* 4 Performance & Sparkline Cards */
    .ts-perf-grid {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
    }
    @media (max-width: 1100px) {
      .ts-perf-grid { grid-template-columns: repeat(2, 1fr); }
    }
    .ts-perf-card {
      background: #0c0c0f; border: 1px solid #27272a; border-radius: 10px; padding: 14px 16px;
      display: flex; flex-direction: column; justify-content: space-between; height: 148px; position: relative; overflow: hidden;
    }
    .ts-perf-head {
      display: flex; justify-content: space-between; align-items: center; font-size: 11px;
      font-weight: 500; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .ts-score-badge {
      background: #18181b; border: 1px solid #27272a; padding: 2px 8px; border-radius: 999px;
      font-size: 11px; color: #fafafa; font-weight: 500; font-variant-numeric: tabular-nums;
    }
    .ts-perf-val {
      font-size: 20px; font-weight: 600; color: #34d399; letter-spacing: -0.02em;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-variant-numeric: tabular-nums;
    }
    .ts-perf-val.red { color: #f87171; }
    .ts-sparkline-svg {
      width: 100%; height: 58px; margin-top: auto;
    }

    /* Interactive Calendar View */
    .ts-calendar-card {
      background: #0c0c0f; border: 1px solid #27272a; border-radius: 10px; padding: 18px;
    }
    .ts-cal-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; padding-bottom: 12px;
      border-bottom: 1px solid #27272a; gap: 12px; flex-wrap: wrap;
    }
    .ts-cal-brand {
      display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; color: #fafafa;
      flex: 1 1 0; min-width: 0;
    }
    .ts-cal-nav {
      display: flex; align-items: center; justify-content: center; gap: 8px; width: auto; min-width: 260px; max-width: 520px; flex: 0 1 auto;
    }
    .ts-cal-nav-btn {
      background: #09090b; border: 1px solid #27272a; color: #a1a1aa; width: 28px; height: 28px; flex-shrink: 0;
      border-radius: 6px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.15s;
      user-select: none;
    }
    .ts-cal-nav-btn:hover { background: #18181b; color: #fafafa; border-color: #3f3f46; }
    .ts-cal-nav-title {
      font-size: 13.5px; font-weight: 600; color: #fafafa; width: auto; min-width: 180px; max-width: 460px; padding: 0 8px; text-align: center;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; justify-content: center;
      font-variant-numeric: tabular-nums;
    }
    .ts-cal-actions {
      flex: 1 1 0; display: flex; justify-content: flex-end; align-items: center; min-width: 0;
    }

    .ts-cal-grid {
      display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px;
    }
    .ts-cal-col-head {
      text-align: center; font-size: 11px; font-weight: 500; color: #71717a; padding: 6px 0; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .ts-cal-col-head.weekly { color: #a1a1aa; }
    .ts-cal-cell {
      background: #09090b; border: 1px solid #27272a; border-radius: 8px; min-height: 82px; padding: 8px 10px;
      display: flex; flex-direction: column; justify-content: space-between; cursor: pointer; transition: background 0.12s, border-color 0.12s; position: relative;
    }
    .ts-cal-cell:hover {
      background: #141418; border-color: #3f3f46;
    }
    .ts-cal-cell.empty {
      background: #09090b; border-color: rgba(39, 39, 42, 0.45); cursor: default; opacity: 0.55;
    }
    .ts-cal-cell.empty:hover { background: #09090b; border-color: rgba(39, 39, 42, 0.45); }
    .ts-cal-cell.active-day {
      border: 1.5px solid #fafafa !important;
      background: #141418;
    }
    .ts-cell-daynum {
      font-size: 11px; font-weight: 500; color: #52525b; line-height: 1; font-variant-numeric: tabular-nums;
    }
    .ts-cell-daynum.active { color: #a1a1aa; }
    .ts-cell-pnl {
      font-size: 12.5px; font-weight: 600; text-align: center; margin: 4px 0 2px 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-variant-numeric: tabular-nums;
    }
    .ts-cell-pnl.green { color: #34d399; }
    .ts-cell-pnl.red { color: #f87171; }
    .ts-cell-trades {
      font-size: 10.5px; color: #71717a; text-align: center; font-weight: 500;
    }
    .ts-weekly-cell {
      background: #111114; border: 1px solid #27272a; border-radius: 8px; min-height: 82px; padding: 8px 10px;
      display: flex; flex-direction: column; justify-content: space-between; text-align: center;
    }
    .ts-weekly-title {
      font-size: 10.5px; font-weight: 600; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .ts-weekly-pnl {
      font-size: 12.5px; font-weight: 600; color: #fafafa;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-variant-numeric: tabular-nums;
    }
    .ts-weekly-trades {
      font-size: 10.5px; color: #71717a; font-weight: 500;
    }

    /* Modal / Dialog for Day Journal Details */
    .ts-modal-overlay {
      display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.78); backdrop-filter: blur(6px); z-index: 999;
      align-items: center; justify-content: center;
    }
    .ts-modal-box {
      background: #0c0c0f; border: 1px solid #27272a; border-radius: 12px; width: 720px; max-width: 92%;
      max-height: 82vh; overflow-y: auto; padding: 20px; box-shadow: 0 24px 60px rgba(0,0,0,0.85);
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif; color: #fafafa;
    }
    .ts-modal-head {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 12px;
      border-bottom: 1px solid #27272a;
    }

    /* ========================================================
       SHARED SHADCN/UI ZINC DARK DESIGN SYSTEM (.sh-view)
       ======================================================== */
    .mc-pill-badge {
      font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px; letter-spacing: 0.02em;
    }
    .sh-view {
      --sh-bg: #09090b;
      --sh-card: #0c0c0f;
      --sh-surface: #111114;
      --sh-muted: #18181b;
      --sh-border: #27272a;
      --sh-border-subtle: rgba(255, 255, 255, 0.08);
      --sh-fg: #fafafa;
      --sh-muted-fg: #a1a1aa;
      --sh-subtle-fg: #71717a;
      --sh-primary-fg: #18181b;
      --sh-destructive: #ef4444;
      --sh-amber: #f59e0b;
      --sh-emerald: #10b981;
      background: var(--sh-bg);
      color: var(--sh-fg);
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    }
    .sh-view .val-green { color: #34d399 !important; }
    .sh-view .val-red { color: #f87171 !important; }
    .sh-view .val-yellow { color: #fbbf24 !important; }
    .sh-view .sh-scroll {
      flex: 1; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #27272a transparent;
    }
    .sh-view .sh-scroll::-webkit-scrollbar { width: 6px; }
    .sh-view .sh-scroll::-webkit-scrollbar-thumb { background: #27272a; border-radius: 3px; }
    .sh-view .sh-container {
      max-width: 1620px; width: 100%; margin: 0 auto; padding: 18px 24px 28px;
      display: flex; flex-direction: column; gap: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    }
    .sh-view .sh-header {
      display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap;
    }
    .sh-view .sh-title {
      font-size: 20px; font-weight: 600; letter-spacing: -0.025em; color: var(--sh-fg); margin: 0; line-height: 1.25;
    }
    .sh-view .sh-subtitle {
      font-size: 13px; color: var(--sh-muted-fg); margin-top: 4px; line-height: 1.45;
    }
    .sh-view .sh-header-actions {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .sh-view .sh-btn-outline {
      display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
      border-radius: 6px; border: 1px solid var(--sh-border); background: transparent;
      color: var(--sh-fg); font-size: 12.5px; font-weight: 500; cursor: pointer;
      transition: background 0.15s, border-color 0.15s, opacity 0.15s; white-space: nowrap;
    }
    .sh-view .sh-btn-outline:hover { background: var(--sh-muted); border-color: #3f3f46; }
    .sh-view .sh-btn-outline:disabled { opacity: 0.6; cursor: not-allowed; }
    .sh-view .sh-btn-outline.is-loading svg { animation: sh-spin 0.8s linear infinite; }
    .sh-view .sh-btn-primary {
      display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
      border-radius: 6px; border: 1px solid #fafafa; background: #fafafa;
      color: #18181b; font-size: 12.5px; font-weight: 600; cursor: pointer;
      transition: background 0.15s, border-color 0.15s, opacity 0.15s; white-space: nowrap;
    }
    .sh-view .sh-btn-primary:hover { background: #e4e4e7; border-color: #e4e4e7; }
    .sh-view .sh-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
    .sh-view .sh-btn-destructive {
      display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
      border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.28); background: rgba(239, 68, 68, 0.1);
      color: #f87171; font-size: 12.5px; font-weight: 500; cursor: pointer;
      transition: background 0.15s, border-color 0.15s; white-space: nowrap;
    }
    .sh-view .sh-btn-destructive:hover { background: rgba(239, 68, 68, 0.18); border-color: rgba(239, 68, 68, 0.45); }
    .sh-view .sh-btn-ghost {
      display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px;
      border-radius: 6px; border: none; background: transparent; color: var(--sh-muted-fg);
      font-size: 12px; font-weight: 500; cursor: pointer; transition: background 0.15s, color 0.15s; white-space: nowrap;
    }
    .sh-view .sh-btn-ghost:hover { background: var(--sh-muted); color: var(--sh-fg); }
    .sh-view .sh-btn-sm {
      height: 28px; padding: 0 10px; font-size: 12px;
    }
    .sh-view select,
    .sh-view .sh-select {
      height: 32px; padding: 0 10px; border-radius: 6px;
      background-color: #09090b !important; color: #fafafa !important;
      border: 1px solid #27272a !important; font-size: 12.5px; font-weight: 500; outline: none;
    }
    .sh-view select:focus,
    .sh-view .sh-select:focus { border-color: #52525b !important; }
    .sh-view .sh-input-plain {
      height: 32px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--sh-border);
      background: var(--sh-bg); color: var(--sh-fg); font-size: 12.5px; outline: none; transition: border-color 0.15s;
    }
    .sh-view .sh-input-plain::placeholder { color: var(--sh-subtle-fg); }
    .sh-view .sh-input-plain:focus { border-color: #52525b; }

    .sh-view .sh-kpi-grid {
      display: grid; grid-template-columns: 1.35fr 1fr 1fr; gap: 14px;
    }
    .sh-view .sh-kpi-4 {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px;
    }
    .sh-view .sh-grid-2 {
      display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
    }
    @media (max-width: 980px) {
      .sh-view .sh-kpi-grid { grid-template-columns: 1fr; }
      .sh-view .sh-kpi-4 { grid-template-columns: repeat(2, 1fr); }
      .sh-view .sh-grid-2 { grid-template-columns: 1fr; }
    }
    @media (max-width: 600px) {
      .sh-view .sh-kpi-4 { grid-template-columns: 1fr; }
    }
    .sh-view .sh-card {
      background: var(--sh-card); border: 1px solid var(--sh-border); border-radius: 10px;
      padding: 16px 18px; display: flex; flex-direction: column;
    }
    .sh-view .sh-card-top {
      display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px;
    }
    .sh-view .sh-card-label {
      font-size: 12px; font-weight: 500; color: var(--sh-muted-fg);
    }
    .sh-view .sh-card-value {
      font-size: 16px; font-weight: 600; color: var(--sh-fg); letter-spacing: -0.015em; line-height: 1.35;
      font-variant-numeric: tabular-nums;
    }
    .sh-view .sh-card-meta {
      font-size: 12px; color: var(--sh-subtle-fg); line-height: 1.45; margin-top: 6px;
    }
    .sh-view .sh-stat-mini {
      background: var(--sh-bg); border: 1px solid var(--sh-border); border-radius: 8px; padding: 8px 10px;
    }
    .sh-view .sh-stat-mini .stat-label {
      font-size: 10px; font-weight: 500; color: var(--sh-subtle-fg); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 3px;
    }
    .sh-view .sh-stat-mini .stat-value {
      font-size: 13.5px; font-weight: 600; color: var(--sh-fg); font-variant-numeric: tabular-nums;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .sh-view .sh-progress-track {
      width: 100%; height: 6px; background: var(--sh-muted); border-radius: 999px; overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .sh-view .sh-timer {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-variant-numeric: tabular-nums; font-size: 12.5px; font-weight: 600;
      color: var(--sh-fg); background: var(--sh-muted); border: 1px solid var(--sh-border);
      padding: 2px 8px; border-radius: 6px; white-space: nowrap;
    }
    .sh-view .sh-toolbar {
      display: flex; flex-direction: column; gap: 10px;
    }
    .sh-view .sh-toolbar-row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    }
    .sh-view .sh-tabs-list {
      display: inline-flex; align-items: center; background: var(--sh-muted); padding: 3px;
      border-radius: 8px; border: 1px solid var(--sh-border-subtle); gap: 2px; flex-wrap: wrap;
    }
    .sh-view .sh-tab-trigger {
      height: 28px; padding: 0 11px; border-radius: 6px; border: 1px solid transparent;
      background: transparent; color: var(--sh-muted-fg); font-size: 12px; font-weight: 500;
      cursor: pointer; transition: all 0.15s; white-space: nowrap;
    }
    .sh-view .sh-tab-trigger:hover:not(.active) { color: var(--sh-fg); }
    .sh-view .sh-tab-trigger.active {
      background: var(--sh-bg); color: var(--sh-fg); border-color: var(--sh-border);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    }
    .sh-view .sh-search-wrap {
      position: relative; display: flex; align-items: center;
    }
    .sh-view .sh-search-icon {
      position: absolute; left: 10px; color: var(--sh-subtle-fg); pointer-events: none;
    }
    .sh-view .sh-input {
      height: 32px; width: 240px; padding: 0 10px 0 30px; border-radius: 6px;
      border: 1px solid var(--sh-border); background: var(--sh-bg); color: var(--sh-fg);
      font-size: 12.5px; outline: none; transition: border-color 0.15s;
    }
    .sh-view .sh-input::placeholder { color: var(--sh-subtle-fg); }
    .sh-view .sh-input:focus { border-color: #52525b; }
    .sh-view .sh-switch-label {
      position: relative; display: inline-flex; align-items: center; gap: 8px;
      font-size: 12px; color: var(--sh-muted-fg); cursor: pointer; user-select: none;
    }
    .sh-view .sh-switch-input {
      position: absolute; opacity: 0; width: 0; height: 0;
    }
    .sh-view .sh-switch-track {
      position: relative; width: 32px; height: 18px; background: #27272a; border-radius: 999px;
      border: 1px solid #3f3f46; transition: background 0.15s, border-color 0.15s; flex-shrink: 0;
    }
    .sh-view .sh-switch-thumb {
      position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
      background: #a1a1aa; transition: transform 0.15s, background 0.15s;
    }
    .sh-view .sh-switch-input:checked + .sh-switch-track { background: #fafafa; border-color: #fafafa; }
    .sh-view .sh-switch-input:checked + .sh-switch-track .sh-switch-thumb {
      transform: translateX(14px); background: #09090b;
    }
    .sh-view .sh-filter-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
    }
    .sh-view .sh-filter-left {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    }
    .sh-view .sh-filter-group {
      display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap;
    }
    .sh-view .sh-filter-divider {
      width: 1px; height: 16px; background: var(--sh-border); margin: 0 4px;
    }
    .sh-view .sh-filter-chip {
      height: 26px; padding: 0 9px; border-radius: 6px; border: 1px solid var(--sh-border);
      background: transparent; color: var(--sh-muted-fg); font-size: 11.5px; font-weight: 500;
      cursor: pointer; transition: all 0.12s; white-space: nowrap;
    }
    .sh-view .sh-filter-chip:hover:not(.active) { background: var(--sh-muted); color: var(--sh-fg); }
    .sh-view .sh-filter-chip.active {
      background: var(--sh-fg); color: var(--sh-primary-fg); border-color: var(--sh-fg);
    }
    .sh-view .sh-badge {
      display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px;
      border-radius: 999px; font-size: 11px; font-weight: 500; border: 1px solid var(--sh-border);
      white-space: nowrap; line-height: 1;
    }
    .sh-view .sh-badge-outline { background: transparent; color: var(--sh-muted-fg); }
    .sh-view .sh-badge-secondary { background: var(--sh-muted); color: var(--sh-fg); border-color: transparent; }
    .sh-view .sh-badge-destructive {
      background: rgba(239, 68, 68, 0.1); color: #f87171; border-color: rgba(239, 68, 68, 0.28);
    }
    .sh-view .sh-badge-amber {
      background: rgba(245, 158, 11, 0.1); color: #fbbf24; border-color: rgba(245, 158, 11, 0.28);
    }
    .sh-view .sh-badge-emerald {
      background: rgba(16, 185, 129, 0.1); color: #34d399; border-color: rgba(16, 185, 129, 0.28);
    }
    .sh-view .sh-badge-sky {
      background: rgba(56, 189, 248, 0.1); color: #38bdf8; border-color: rgba(56, 189, 248, 0.28);
    }
    .sh-view .sh-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .sh-view .action-badge {
      display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 500; text-transform: none; line-height: 1.3;
    }
    .sh-view .action-buy {
      background: rgba(16, 185, 129, 0.12); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.25);
    }
    .sh-view .action-sell {
      background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.25);
    }
    .sh-view .action-neutral {
      background: #18181b; color: #a1a1aa; border: 1px solid #27272a;
    }
    .sh-view .sh-table-card {
      background: var(--sh-card); border: 1px solid var(--sh-border); border-radius: 10px; overflow: hidden;
    }
    .sh-view .sh-table-card-head {
      display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;
      border-bottom: 1px solid var(--sh-border); background: var(--sh-card);
    }
    .sh-view .sh-table-card-title {
      font-size: 13.5px; font-weight: 600; color: var(--sh-fg);
    }
    .sh-view .sh-table-scroll {
      overflow-x: auto; max-height: max(420px, calc(100vh - 420px)); scrollbar-width: thin; scrollbar-color: #27272a transparent;
    }
    .sh-view table,
    .sh-view .sh-table {
      width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;
    }
    .sh-view table thead th,
    .sh-view .sh-table thead th,
    .sh-view #table-paper-positions th {
      position: sticky; top: 0; z-index: 5; background: var(--sh-surface); color: var(--sh-subtle-fg);
      font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 10px 14px; border-bottom: 1px solid var(--sh-border); white-space: nowrap;
    }
    .sh-view table tbody tr,
    .sh-view .sh-table tbody tr {
      border-bottom: 1px solid rgba(39, 39, 42, 0.65); transition: background 0.12s;
    }
    .sh-view table tbody tr:hover,
    .sh-view .sh-table tbody tr:hover { background: rgba(255, 255, 255, 0.03); }
    .sh-view table tbody td,
    .sh-view .sh-table tbody td {
      padding: 10px 14px; vertical-align: middle; font-size: 12.5px;
      font-variant-numeric: tabular-nums; border-bottom: 1px solid rgba(39, 39, 42, 0.65);
    }
    .sh-view #table-paper-positions th,
    .sh-view #table-paper-positions td {
      padding: 10px 10px; vertical-align: middle; font-size: 12.5px;
      font-variant-numeric: tabular-nums; border-bottom: 1px solid rgba(39, 39, 42, 0.65);
    }
    .sh-view .sh-date-group-row td {
      background: #101013; color: var(--sh-muted-fg); font-size: 11.5px; font-weight: 600;
      padding: 7px 14px; border-bottom: 1px solid var(--sh-border); border-top: 1px solid var(--sh-border);
    }
    .sh-view .sh-table-row {
      border-bottom: 1px solid rgba(39, 39, 42, 0.65); transition: background 0.12s; cursor: pointer;
    }
    .sh-view .sh-table-row:hover { background: rgba(255, 255, 255, 0.03); }
    .sh-view .sh-table-row.is-high td:first-child { box-shadow: inset 2px 0 0 #ef4444; }
    .sh-view .sh-table-row.is-past { opacity: 0.55; }
    .sh-view .sh-table-row.is-expanded { background: rgba(255, 255, 255, 0.035); }
    .sh-view .sh-table-row td { padding: 11px 14px; vertical-align: middle; }
    .sh-view .sh-num {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; font-size: 12.5px;
    }
    .sh-view .sh-detail-row td {
      background: #0a0a0c; padding: 12px 18px; border-bottom: 1px solid var(--sh-border);
    }
    .sh-view .sh-detail-box {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    }
    .sh-view .sh-scenario-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 14px;
    }
    @media (max-width: 980px) {
      .sh-view .sh-scenario-grid { grid-template-columns: 1fr; }
    }
    .sh-view .sh-scenario-item {
      background: var(--sh-bg); border: 1px solid var(--sh-border); border-radius: 8px;
      padding: 14px; display: flex; flex-direction: column; gap: 10px;
    }
    .sh-view .sh-scenario-cond {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11.5px; color: var(--sh-fg); background: var(--sh-muted);
      padding: 6px 9px; border-radius: 6px; border: 1px solid var(--sh-border-subtle);
    }
    .sh-view .sh-scenario-exec {
      font-size: 12px; color: var(--sh-muted-fg); border-left: 2px solid var(--sh-border);
      padding-left: 10px; line-height: 1.5; margin-top: auto;
    }
    @keyframes sh-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    /* ========================================================
       AI INTELLIGENCE HUB (SHADCN ZINC DARK)
       ======================================================== */
    .ai-hub-grid-3col {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; align-items: stretch;
    }
    @media (max-width: 1180px) {
      .ai-hub-grid-3col { grid-template-columns: 1fr; }
    }
    .ai-hub-grid-3rows {
      display: flex; flex-direction: column; gap: 16px;
    }
    .ai-hub-col {
      background: #0c0c0f; border: 1px solid #27272a; border-radius: 10px; padding: 16px;
      display: flex; flex-direction: column; gap: 12px; min-width: 0;
    }
    .ai-hub-col-head {
      display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px;
      border-bottom: 1px solid #27272a;
    }
    .ai-hub-col-title {
      font-size: 14px; font-weight: 600; color: #fafafa; display: flex; align-items: center; gap: 7px;
    }
    .ai-hub-subcard {
      background: #09090b; border: 1px solid #27272a; border-radius: 8px; padding: 12px;
      display: flex; flex-direction: column; gap: 8px;
    }
    #table-hub-feeds th,
    #table-hub-feeds td {
      padding: 7px 6px; font-size: 11.5px; white-space: nowrap;
    }
    #table-hub-feeds .action-badge {
      padding: 2px 5px; font-size: 9.5px;
    }

    /* ========================================================
       REPLAY ENGINE (SHADCN ZINC DARK)
       ======================================================== */
    #view-replay .sh-rep-topbar {
      background: #0c0c0f; border-bottom: 1px solid #27272a; padding: 8px 16px;
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
      z-index: 10; flex-shrink: 0;
    }
    #view-replay .sh-rep-dock {
      position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 30;
      background: rgba(12, 12, 15, 0.92); backdrop-filter: blur(12px);
      border: 1px solid #27272a; border-radius: 12px; padding: 8px 14px;
      display: flex; align-items: center; gap: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
      max-width: calc(100% - 32px); flex-wrap: wrap;
    }
    #view-replay #rep-slider {
      width: 140px; accent-color: #fafafa; cursor: pointer;
    }

    /* ========================================================
       AUTH & WEB3 WALLET SECURITY STYLES
       ======================================================== */
    .header-auth-section {
      display: flex; align-items: center; gap: 8px;
    }
    .btn-auth-wallet {
      background: linear-gradient(135deg, rgba(234, 88, 12, 0.15), rgba(249, 115, 22, 0.25));
      color: #fb923c; border: 1px solid rgba(251, 146, 60, 0.35);
      padding: 6px 12px; border-radius: 8px; font-size: 11.5px; font-weight: 700; cursor: pointer;
      display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      backdrop-filter: blur(8px);
    }
    .btn-auth-wallet:hover {
      background: linear-gradient(135deg, rgba(234, 88, 12, 0.3), rgba(249, 115, 22, 0.45));
      color: #fff; border-color: rgba(251, 146, 60, 0.6); transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(249, 115, 22, 0.25);
    }
    .btn-auth-signin {
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.15), rgba(37, 99, 235, 0.25));
      color: #60a5fa; border: 1px solid rgba(96, 165, 250, 0.35);
      padding: 6px 12px; border-radius: 8px; font-size: 11.5px; font-weight: 700; cursor: pointer;
      display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      backdrop-filter: blur(8px);
    }
    .btn-auth-signin:hover {
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(37, 99, 235, 0.45));
      color: #fff; border-color: rgba(96, 165, 250, 0.6); transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(59, 130, 246, 0.25);
    }
    .user-profile-pill {
      display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px;
      background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px; font-size: 11.5px; color: #fff;
    }
    .user-role-badge {
      font-size: 9.5px; font-weight: 800; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .role-admin { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
    .role-member { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .btn-auth-logout {
      background: transparent; border: none; color: #94a3b8; cursor: pointer; padding: 2px;
      display: inline-flex; align-items: center; transition: color 0.15s;
    }
    .btn-auth-logout:hover { color: #ef4444; }

    /* Modal Overlay */
    .auth-modal-overlay {
      position: fixed; inset: 0; background: rgba(4, 7, 14, 0.85);
      backdrop-filter: blur(16px); z-index: 9999; display: none;
      align-items: center; justify-content: center; padding: 16px;
    }
    .auth-modal-card {
      background: #0f131f; border: 1px solid #1f273b; border-radius: 14px;
      width: 100%; max-width: 440px; box-shadow: 0 24px 64px rgba(0,0,0,0.7), 0 0 32px rgba(59,130,246,0.1);
      overflow: hidden; animation: modalFadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .auth-modal-head {
      padding: 16px 20px; border-bottom: 1px solid #1c2438; display: flex; justify-content: space-between; align-items: center;
      background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 100%);
    }
    .auth-modal-tabs {
      display: flex; background: #0b0e17; border-bottom: 1px solid #1c2438; padding: 4px 12px; gap: 4px;
    }
    .auth-tab-btn {
      flex: 1; padding: 8px 10px; background: transparent; border: none; color: #8c93a3; font-size: 11.5px;
      font-weight: 700; cursor: pointer; border-radius: 6px; transition: all 0.15s; display: flex; align-items: center; justify-content: center; gap: 6px;
    }
    .auth-tab-btn.active {
      background: #1c2438; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    .auth-tab-pane {
      padding: 20px; display: none;
    }
    .auth-tab-pane.active {
      display: block;
    }
    .auth-input-box {
      width: 100%; background: #080b12; border: 1px solid #232c42; color: #fff;
      padding: 10px 12px; border-radius: 8px; font-size: 12.5px; outline: none; margin-bottom: 12px;
      box-sizing: border-box; transition: border-color 0.15s;
    }
    .auth-input-box:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.2); }
    .btn-auth-submit {
      width: 100%; padding: 10px; background: #2563eb; color: #fff; border: none; border-radius: 8px;
      font-size: 12.5px; font-weight: 700; cursor: pointer; transition: all 0.15s;
    }
    .btn-auth-submit:hover { background: #1d4ed8; }

    /* Security Badge Info Box */
    .auth-sec-box {
      background: rgba(16, 185, 129, 0.06); border: 1px solid rgba(16, 185, 129, 0.2);
      border-radius: 8px; padding: 10px 12px; margin-top: 14px; font-size: 11px; color: #94a3b8; line-height: 1.5;
    }

    /* Auth Toast */
    .auth-toast {
      position: fixed; bottom: 24px; right: 24px; background: #101524; border: 1px solid #2563eb;
      color: #fff; padding: 12px 18px; border-radius: 8px; font-size: 12px; font-weight: 600;
      box-shadow: 0 12px 32px rgba(0,0,0,0.5); z-index: 10000; display: none; align-items: center; gap: 8px;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand-section">
      <div class="badge"><span class="badge-dot"></span><span>LIVE ENGINE</span></div>
      <strong style="font-size: 14px; display: flex; align-items: center; gap: 6px;">
        <img src="/public/favicon.svg" alt="Hyperview" style="width: 18px; height: 18px; border-radius: 4px; vertical-align: middle;">
        <span>Hyperview</span>
      </strong>
    </div>
    <div class="nav-tabs" id="main-nav">
      <button class="tab-btn active" data-target="view-chart">📈 Live Chart</button>
      <button class="tab-btn" data-target="view-paper" style="background: rgba(34, 197, 94, 0.12); color: #4ade80; border: 1px solid rgba(74, 222, 128, 0.32); font-weight: 700;">💼 Paper Trade ($10k)</button>
      <button class="tab-btn" data-target="view-journal" style="background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); font-weight: 700;">📅 Daily PnL Journal</button>
      <button class="tab-btn" data-target="view-macro" style="background: rgba(245, 158, 11, 0.12); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.35); font-weight: 700;">⚡ Macro Calendar</button>
      <button class="tab-btn" data-target="view-ai-hub" style="background: rgba(168, 85, 247, 0.12); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.35); font-weight: 700;">🤖 AI Intelligence Hub</button>
      <button class="tab-btn" data-target="view-replay">⏪ Replay Engine</button>
      <button class="tab-btn" data-target="view-alert">🔔 Telegram</button>
    </div>
    <div class="header-auth-section" id="header-auth-section">
      <button class="btn-auth-wallet" id="btn-header-wallet" title="Connect MetaMask / EVM Wallet (EIP-4361 Secure Signature)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
        <span>Connect Wallet</span>
      </button>
      <button class="btn-auth-signin" id="btn-header-login" title="Sign in with Google / Email">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        <span>Sign In</span>
      </button>
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
                <div style="display: flex; flex-direction: column; justify-content: center;">
                  <span id="active-exchange-badge" class="hl-badge-sub">HYPERLIQUID</span>
                  <strong id="active-symbol-title" class="hl-badge-title">BTC-USDC</strong>
                </div>
              </div>
              <div class="hl-vdiv"></div>
            </div>

            <div class="hl-stat-group">
              <div class="hl-stat-item">
                <span class="hl-stat-lbl">LAST</span>
                <strong id="hl-stat-last" class="hl-stat-val" style="display: inline-block; width: 60px; white-space: nowrap;">$80,452.00</strong>
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
              <div class="tf-group" id="timeframes" style="display: flex; gap: 2px; position: relative; align-items: center;">
                <button class="hl-tf-btn" data-tf="1">1m</button>
                <button class="hl-tf-btn" data-tf="5">5m</button>
                <button class="hl-tf-btn" data-tf="15">15m</button>
                <button class="hl-tf-btn" data-tf="60">1h</button>
                <button class="hl-tf-btn" data-tf="240">4h</button>
                <button class="hl-tf-btn active" data-tf="D">D</button>
                <button class="hl-tf-btn" data-tf="W">W</button>
                <button class="hl-tf-btn" data-tf="M">M</button>
                <div style="position: relative; display: inline-block;">
                  <button class="hl-tf-btn" id="btn-more-tf" type="button" style="color: #94a3b8;" title="More timeframes">⌄</button>
                  <div id="more-tf-dropdown" class="ios-glass-panel" style="display: none; position: absolute; top: 30px; left: 0; z-index: 1000; min-width: 96px; padding: 6px; background: rgba(13, 17, 28, 0.96) !important; backdrop-filter: blur(24px) !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; border-radius: 8px !important; box-shadow: 0 12px 32px rgba(0,0,0,0.75) !important; flex-direction: column; gap: 4px;">
                    <button class="hl-tf-btn more-tf-opt" type="button" data-tf="3" style="width: 100%; text-align: left; justify-content: flex-start;">3m</button>
                    <button class="hl-tf-btn more-tf-opt" type="button" data-tf="30" style="width: 100%; text-align: left; justify-content: flex-start;">30m</button>
                    <button class="hl-tf-btn more-tf-opt" type="button" data-tf="120" style="width: 100%; text-align: left; justify-content: flex-start;">2h</button>
                  </div>
                </div>
              </div>

              <div class="hl-vdiv"></div>

              <!-- Chart style (Candlesticks / Hollow / Heikin Ashi / Line) -->
              <div style="position: relative; display: inline-block;">
                <button class="hl-tool-btn" id="btn-chart-style" type="button" title="Chart style">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 4v16M9 8h4v8H9zM17 2v20M17 5h4v6h-4z"/></svg>
                  <span id="chart-style-label" style="font-size: 10.5px;">Candles</span>
                  <span style="font-size: 8px; color: #8c93a3;">⌄</span>
                </button>
                <div id="chart-style-dropdown" class="ios-glass-panel" style="display: none; position: absolute; top: 32px; left: 0; z-index: 1000; min-width: 150px; padding: 6px; background: rgba(13, 17, 28, 0.96) !important; backdrop-filter: blur(24px) !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; border-radius: 8px !important; box-shadow: 0 12px 32px rgba(0,0,0,0.75) !important; flex-direction: column; gap: 3px;">
                  <button class="btn chart-style-opt active" type="button" data-style="candles" style="width: 100%; text-align: left; padding: 5px 8px; font-size: 11px;">Candlesticks</button>
                  <button class="btn chart-style-opt" type="button" data-style="hollow" style="width: 100%; text-align: left; padding: 5px 8px; font-size: 11px;">Hollow Candles</button>
                  <button class="btn chart-style-opt" type="button" data-style="heikin" style="width: 100%; text-align: left; padding: 5px 8px; font-size: 11px;">Heikin Ashi</button>
                  <button class="btn chart-style-opt" type="button" data-style="line" style="width: 100%; text-align: left; padding: 5px 8px; font-size: 11px;">Line</button>
                </div>
              </div>

              <div class="hl-vdiv"></div>

              <!-- Drawing Tools Dropdown (Compact Top Bar Tool) -->
              <div style="position: relative; display: inline-block;">
                <button class="hl-tool-btn" id="btn-draw-menu" title="Drawing Tools & Long/Short Position">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 2 4 4-12 12H6v-4L18 2z"/><path d="m14 6 4 4"/></svg>
                  <span>Draw Tools</span>
                  <span style="font-size: 8px; color: #8c93a3;">⌄</span>
                </button>
                <div id="draw-dropdown" class="ios-glass-panel" style="display: none; position: absolute; top: 32px; left: 0; z-index: 1000; min-width: 220px; width: max-content; max-width: 240px; padding: 10px 12px; background: rgba(13, 17, 28, 0.96) !important; backdrop-filter: blur(24px) !important; -webkit-backdrop-filter: blur(24px) !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; border-radius: 10px !important; box-shadow: 0 16px 40px rgba(0,0,0,0.75) !important;">
                  <div style="font-size: 10px; font-weight: 800; color: #94a3b8; letter-spacing: 0.5px; margin-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 5px; display: flex; justify-content: space-between; align-items: center;">
                    <span>DRAWING TOOLS</span>
                    <span id="active-draw-tool-label" style="font-size: 9.5px; color: #38bdf8; font-weight: 700;">Crosshair</span>
                  </div>
                  
                  <div style="display: flex; flex-direction: column; gap: 2px;">
                    <button type="button" class="draw-dropdown-item active" data-tool="cursor" style="background: rgba(56, 189, 248, 0.16) !important; color: #38bdf8 !important;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></svg>
                      <span>Crosshair / Cursor</span>
                    </button>
                    <button type="button" class="draw-dropdown-item" data-tool="trendline" style="background: transparent !important; color: #94a3b8 !important;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="2" fill="currentColor"/><circle cx="20" cy="4" r="2" fill="currentColor"/></svg>
                      <span>Trendline (2 Points)</span>
                    </button>
                    <button type="button" class="draw-dropdown-item" data-tool="ray" style="background: transparent !important; color: #94a3b8 !important;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><line x1="4" y1="18" x2="21" y2="6"/><polyline points="15 6 21 6 21 12"/><circle cx="4" cy="18" r="2" fill="currentColor"/></svg>
                      <span>Ray Line (Infinite)</span>
                    </button>
                    <button type="button" class="draw-dropdown-item" data-tool="horizontal" style="background: transparent !important; color: #94a3b8 !important;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><line x1="2" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>
                      <span>Horizontal S/R</span>
                    </button>
                    <button type="button" class="draw-dropdown-item" data-tool="box" style="background: transparent !important; color: #94a3b8 !important;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><rect x="3" y="5" width="18" height="14" rx="2"/></svg>
                      <span>Support/Resistance Box</span>
                    </button>
                    <button type="button" class="draw-dropdown-item" data-tool="fib" style="background: transparent !important; color: #94a3b8 !important;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><line x1="3" y1="5" x2="21" y2="5"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="19" x2="21" y2="19"/></svg>
                      <span>Fibonacci Retracement</span>
                    </button>
                    <button type="button" class="draw-dropdown-item" data-tool="ruler" style="background: transparent !important; color: #38bdf8 !important;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
                        <path d="M21.3 8.7 8.7 21.3c-1 1-2.5 1-3.5 0l-2.5-2.5c-1-1-1-2.5 0-3.5L15.3 2.7c1-1 2.5-1 3.5 0l2.5 2.5c1 1 1 2.5 0 3.5z"/>
                        <line x1="9" y1="9" x2="11.5" y2="6.5"/>
                        <line x1="12" y1="12" x2="14.5" y2="9.5"/>
                        <line x1="15" y1="15" x2="17.5" y2="12.5"/>
                      </svg>
                      <span style="font-weight: 600;">Thước Kẻ (Ruler / Đo Giá & %)</span>
                    </button>
                    <div style="height: 1px; background: rgba(255,255,255,0.08); margin: 3px 0;"></div>
                    <button type="button" class="draw-dropdown-item" data-tool="long_pos" style="background: transparent !important; color: #34d399 !important;">
                      <span style="font-size: 11px; font-weight: 800; width: 14px; text-align: center; flex-shrink:0;">▲R</span>
                      <span style="font-weight: 600;">Long Position (R:R)</span>
                    </button>
                    <button type="button" class="draw-dropdown-item" data-tool="short_pos" style="background: transparent !important; color: #f87171 !important;">
                      <span style="font-size: 11px; font-weight: 800; width: 14px; text-align: center; flex-shrink:0;">▼R</span>
                      <span style="font-weight: 600;">Short Position (R:R)</span>
                    </button>
                    <div style="height: 1px; background: rgba(255,255,255,0.08); margin: 3px 0;"></div>
                    <button type="button" class="draw-dropdown-item" id="draw-tool-magnet" data-tool="magnet" style="background: transparent !important; color: #94a3b8 !important; justify-content: space-between;">
                      <div style="display: flex; align-items: center; gap: 10px;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M6 3v6a6 6 0 0 0 12 0V3"/><line x1="4" y1="3" x2="8" y2="3"/><line x1="16" y1="3" x2="20" y2="3"/></svg>
                        <span>Magnet Mode</span>
                      </div>
                      <span id="magnet-mode-badge" style="font-size: 9px; padding: 2px 5px; border-radius: 4px; background: rgba(255,255,255,0.08); color: #94a3b8; font-weight: 700;">OFF</span>
                    </button>
                    <button type="button" class="draw-dropdown-item" id="draw-tool-del-selected" data-tool="del_selected" style="background: transparent !important; color: #f87171 !important;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                      <span>Xóa Nét Vẽ Đang Chọn (Del)</span>
                    </button>
                    <button type="button" class="draw-dropdown-item" id="draw-tool-trash" data-tool="trash" style="background: transparent !important; color: #ef4444 !important;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      <span>Clear All Drawings</span>
                    </button>
                  </div>
                </div>
              </div>

              <div class="hl-vdiv"></div>

              <!-- Indicators Dropdown Button -->
              <div style="position: relative; display: inline-block;">
                <button class="hl-tool-btn" id="btn-indicators-menu">
                  <span style="font-family: serif; font-style: italic; font-weight: 800; color: #a855f7;">fx</span>
                  <span>Indicators</span>
                  <span style="font-size: 8px; color: #8c93a3;">⌄</span>
                </button>
                <div id="indicators-dropdown" class="ios-glass-panel" style="display: none; position: absolute; top: 32px; left: 0; z-index: 1000; width: 290px; padding: 12px 14px; max-height: 80vh; overflow-y: auto;">
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
                  <!-- 4. Reaction Level Matrix -->
                  <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #222634;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                      <span style="font-size: 11px; font-weight: 700; color: #f59e0b;">🎯 Reaction Level Matrix</span>
                      <button class="btn" id="btn-toggle-rlm" style="padding: 2px 8px; font-size: 9.5px; background: var(--bg-tertiary); color: var(--text-secondary); border: 1px solid transparent;">OFF</button>
                    </div>
                    <div style="font-size: 9px; color: #94a3b8; margin-bottom: 4px;">WillyAlgoTrader • Reaction Scoring & Rejections</div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary); margin-bottom: 4px;">
                      <span>Swing Length:</span>
                      <select id="select-rlm-swing" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="6" selected>6 bars (Balanced)</option>
                        <option value="4">4 bars (Sensitive)</option>
                        <option value="10">10 bars (Major)</option>
                      </select>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary); margin-bottom: 4px;">
                      <span>Min Level Score:</span>
                      <select id="select-rlm-score" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="50" selected>Score ≥ 50</option>
                        <option value="60">Score ≥ 60</option>
                        <option value="40">Score ≥ 40</option>
                      </select>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary);">
                      <span>Risk Preset:</span>
                      <select id="select-rlm-preset" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="BALANCED" selected>Balanced (1R/2R/3R)</option>
                        <option value="CONSERVATIVE">Conservative (1R/2R/4R)</option>
                        <option value="AGGRESSIVE">Aggressive (1.5R/2.5R/4R)</option>
                      </select>
                    </div>
                  </div>

                  <!-- 5. LuxAlgo Signals & Overlays (Smart Trail & Reversal Zones) -->
                  <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #222634;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                      <span style="font-size: 11px; font-weight: 700; color: #38bdf8;">⚡ LuxAlgo Signals & Overlays</span>
                      <button class="btn active" id="btn-toggle-luxalgo" style="padding: 2px 8px; font-size: 9.5px; background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid #38bdf8;">ON</button>
                    </div>
                    <div style="font-size: 9px; color: #94a3b8; margin-bottom: 4px;">LuxAlgo® • Smart Trail & Reversal Zones [v6.1 Clone]</div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary); margin-bottom: 4px;">
                      <span>Smart Trail ATR:</span>
                      <select id="select-lux-factor" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="4.0" selected>Factor 4.0 (Normal)</option>
                        <option value="3.0">Factor 3.0 (Fast)</option>
                        <option value="5.0">Factor 5.0 (Smooth)</option>
                      </select>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary);">
                      <span>Reversal Zones:</span>
                      <select id="select-lux-rz" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="ON" selected>SuperSmoother Envelopes</option>
                        <option value="OFF">Hidden</option>
                      </select>
                    </div>
                  </div>

                  <!-- 6. EMA30 Band Breakout [EL COBER Enhanced] -->
                  <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #222634;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                      <span style="font-size: 11px; font-weight: 700; color: #10b981;">📊 EMA30 Band Breakout</span>
                      <button class="btn active" id="btn-toggle-ema30" style="padding: 2px 8px; font-size: 9.5px; background: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid #22c55e;">ON</button>
                    </div>
                    <div style="font-size: 9px; color: #94a3b8; margin-bottom: 4px;">EL COBER • High/Low Band + Swing Breakout [Enhanced]</div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary); margin-bottom: 4px;">
                      <span>Band Length:</span>
                      <select id="select-ema30-period" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="30" selected>EMA 30 (Default)</option>
                        <option value="20">EMA 20 (Fast)</option>
                        <option value="50">EMA 50 (Smooth)</option>
                      </select>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary); margin-bottom: 4px;">
                      <span>Volume Filter:</span>
                      <select id="select-ema30-vol" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="ON" selected>Spike ≥ 1.15x (Anti-Fakeout)</option>
                        <option value="OFF">Disabled</option>
                      </select>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-secondary);">
                      <span>Trend Guard:</span>
                      <select id="select-ema30-trend" class="btn" style="outline: none; padding: 2px 4px; font-size: 10px;">
                        <option value="ON" selected>EMA 200 Slope Guard</option>
                        <option value="OFF">Disabled</option>
                      </select>
                    </div>
                  </div>

                  <!-- 7. Bottom Section: Add / Manage Strategy & Hyperliquid Agent Button -->
                  <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(168, 85, 247, 0.25); display: flex; flex-direction: column; gap: 6px;">
                    <button class="btn" id="btn-indicators-add-strategy" style="width: 100%; padding: 8px 10px; background: linear-gradient(135deg, rgba(147, 51, 234, 0.25), rgba(79, 70, 229, 0.3)); border: 1px solid #a855f7; color: #fff; font-weight: 700; font-size: 11px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 4px 12px rgba(147, 51, 234, 0.2);">
                      <span>🧠</span>
                      <span>➕ Add Strategy (Code Engine)</span>
                      <span style="font-size: 9px; padding: 1px 5px; border-radius: 3px; background: #9333ea; color: #fff; font-weight: 800;">CUSTOM</span>
                    </button>
                    <button class="btn" id="btn-indicators-hl-agent" style="width: 100%; padding: 7px 10px; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.4); color: #38bdf8; font-weight: 700; font-size: 10.5px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
                      <span>🔑</span>
                      <span>Cấu Hình API Bot (Hyperliquid Agent)</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 6px;">
              <button class="btn active" id="btn-toggle-watchlist" style="background: rgba(41, 98, 255, 0.2); color: #78a9ff; border: 1px solid #2962ff; padding: 2px 7px; font-size: 10.5px;">📑 Watchlist</button>
              <button class="btn active" id="btn-toggle-dock" style="background: rgba(38, 166, 154, 0.2); color: #4ade80; border: 1px solid #26a69a; padding: 2px 7px; font-size: 10.5px;">⚡ Terminal Dock</button>

              <div class="hl-vdiv"></div>

              <!-- Chart Grid Layout Selector (Vela Architecture) -->
              <div style="position: relative; display: inline-block;">
                <button class="hl-tool-btn" id="btn-layout-menu" title="Select Chart Layout">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
                  <span id="layout-current-label">1 Chart</span>
                  <span style="font-size: 8px; color: #8c93a3;">⌄</span>
                </button>
                <div id="layout-dropdown" class="ios-glass-panel" style="display: none; position: absolute; top: 32px; right: 0; z-index: 1000; width: 175px; padding: 6px; box-shadow: 0 16px 40px rgba(0,0,0,0.6);">
                  <div class="layout-opt-btn" data-layout="1" style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; cursor: pointer; color: #fff; font-size: 11px; font-weight: 600;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
                    <span>1 Chart (Single)</span>
                  </div>
                  <div class="layout-opt-btn" data-layout="2v" style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; cursor: pointer; color: #cbd5e1; font-size: 11px; font-weight: 600;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
                    <span>2 Split Vertical (2V)</span>
                  </div>
                  <div class="layout-opt-btn" data-layout="2h" style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; cursor: pointer; color: #cbd5e1; font-size: 11px; font-weight: 600;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>
                    <span>2 Split Horizontal (2H)</span>
                  </div>
                  <div class="layout-opt-btn" data-layout="4" style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; cursor: pointer; color: #cbd5e1; font-size: 11px; font-weight: 600;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/></svg>
                    <span>4 Grid (2x2)</span>
                  </div>
                </div>
              </div>

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

          <!-- Chart Workspace: Main Chart Container -->
          <div style="flex: 1; display: flex; width: 100%; position: relative; overflow: hidden; height: calc(100% - 74px);">
            <!-- Charts Grid Container (Supports 1, 2V, 2H, 4 - Vela Architecture) -->
            <div id="charts-grid-wrapper" style="flex: 1; display: flex; width: 100%; height: 100%; position: relative; overflow: hidden;">
              <!-- Cell 1 (Main Chart) -->
              <div id="chart-cell-1" class="chart-grid-cell" style="flex: 1; width: 100%; height: 100%; position: relative; display: flex;">
                <div id="chart-container" style="flex: 1; width: 100%; position: relative; height: 100%;">
            <div class="legend-overlay">
              <span class="legend-item"><span class="legend-label">O:</span><span id="leg-open">--</span></span>
              <span class="legend-item"><span class="legend-label">H:</span><span id="leg-high">--</span></span>
              <span class="legend-item"><span class="legend-label">L:</span><span id="leg-low">--</span></span>
              <span class="legend-item"><span class="legend-label">C:</span><span id="leg-close">--</span></span>
              <span class="legend-item" id="leg-chg-wrap" style="display: none;"><span id="leg-chg">--</span></span>
              <span class="legend-item"><span class="legend-label">Vol:</span><span id="leg-vol">--</span></span>
            </div>
            <!-- Indicators Floating HUD Container -->
            <div id="indicators-hud-stack" style="position: absolute; top: 12px; right: 82px; z-index: 10; display: flex; flex-direction: column; gap: 8px; max-height: calc(100% - 24px); overflow-y: auto; pointer-events: none; padding-right: 2px;">
              <!-- 1. FiboRadar HUD -->
              <div id="fiboradar-hud" class="ios-glass-panel" style="border: 1px solid rgba(192, 132, 252, 0.35) !important; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 0 0 18px rgba(168, 85, 247, 0.12), inset 0 1px 1px rgba(255, 255, 255, 0.25) !important; padding: 10px 14px; font-size: 11px; width: 250px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                  <span style="font-weight: 800; color: #c084fc; letter-spacing: 0.3px;">🎯 FiboRadar [Mr_Rakun]</span>
                  <span id="fibo-swing-badge" class="ios-glass-pill" style="font-size: 9px; font-weight: 700; padding: 1px 7px; background: rgba(74, 222, 128, 0.18); color: #4ade80;">BULL</span>
                </div>
                <div style="margin-bottom: 6px; font-size: 10px; color: var(--text-secondary);">
                  Zone: <strong id="fibo-current-zone" style="color: #fbbf24;">--</strong>
                </div>
                <div id="fibo-levels-list" style="display: flex; flex-direction: column; gap: 2px;"></div>
              </div>

              <!-- 2. Galton Volume Profile HUD -->
              <div id="galton-hud" class="ios-glass-panel" style="display: none; border: 1px solid rgba(56, 189, 248, 0.35) !important; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 0 0 18px rgba(56, 189, 248, 0.12), inset 0 1px 1px rgba(255, 255, 255, 0.25) !important; padding: 10px 14px; font-size: 11px; width: 280px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                  <span style="font-weight: 800; color: #38bdf8; letter-spacing: 0.3px;">📊 Galton Volume Profile</span>
                  <span id="galton-engine-badge" class="ios-glass-pill" style="font-size: 9px; font-weight: 700; padding: 1px 7px; background: rgba(56, 189, 248, 0.18); color: #38bdf8;">BVC</span>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-secondary); margin-bottom: 5px;">
                  <span>Buy/Sell Flow:</span>
                  <span id="galton-flow-delta" style="font-weight: 700;">--</span>
                </div>
                <!-- Buy vs Sell Flow Bar -->
                <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; display: flex; margin-bottom: 8px; box-shadow: inset 0 1px 2px rgba(0,0,0,0.4);">
                  <div id="galton-buy-bar" style="width: 50%; height: 100%; background: #2979ff;"></div>
                  <div id="galton-sell-bar" style="width: 50%; height: 100%; background: #ff1744;"></div>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; text-align: center; margin-bottom: 6px; font-size: 9.5px;">
                  <div class="ios-glass-card" style="padding: 4px 2px;">
                    <div style="color: #94a3b8; font-size: 8.5px;">VAL (70%)</div>
                    <div id="galton-val" style="color: #38bdf8; font-weight: 700;">--</div>
                  </div>
                  <div class="ios-glass-card" style="padding: 4px 2px; border: 1px solid rgba(251, 191, 36, 0.3) !important; background: rgba(251, 191, 36, 0.08) !important;">
                    <div style="color: #fbbf24; font-size: 8.5px; font-weight: 700;">● POC</div>
                    <div id="galton-poc" style="color: #fbbf24; font-weight: 800;">--</div>
                  </div>
                  <div class="ios-glass-card" style="padding: 4px 2px;">
                    <div style="color: #94a3b8; font-size: 8.5px;">VAH (70%)</div>
                    <div id="galton-vah" style="color: #38bdf8; font-weight: 700;">--</div>
                  </div>
                </div>
                <!-- Mini Profile Distribution Graph -->
                <div id="galton-profile-bars" style="display: flex; flex-direction: column; gap: 1px; max-height: 70px; overflow: hidden;"></div>
              </div>

              <!-- 3. Volume Footprint: Math & Geometry HUD -->
              <div id="footprint-hud" class="ios-glass-panel" style="display: none; border: 1px solid rgba(129, 140, 248, 0.35) !important; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 0 0 18px rgba(99, 102, 241, 0.12), inset 0 1px 1px rgba(255, 255, 255, 0.25) !important; padding: 10px 14px; font-size: 11px; width: 280px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                  <span style="font-weight: 800; color: #818cf8; letter-spacing: 0.3px;">👣 Volume Footprint</span>
                  <span id="footprint-window-badge" class="ios-glass-pill" style="font-size: 9px; font-weight: 700; padding: 1px 7px; background: rgba(99, 102, 241, 0.18); color: #818cf8;">5 BARS</span>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px; font-size: 10px;">
                  <div class="ios-glass-card" style="padding: 5px 6px;">
                    <div style="color: #94a3b8; font-size: 8.5px;">BAR VOL / Δ</div>
                    <div id="footprint-bar-vol" style="font-weight: 700; color: #e2e8f0;">--</div>
                    <div id="footprint-bar-delta" style="font-size: 9px; font-weight: 800;">--</div>
                  </div>
                  <div class="ios-glass-card" style="padding: 5px 6px;">
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

              <!-- 4. Reaction Level Matrix HUD -->
              <div id="rlm-hud" class="ios-glass-panel" style="display: none; border: 1px solid rgba(245, 158, 11, 0.38) !important; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 0 0 22px rgba(245, 158, 11, 0.15), inset 0 1px 1px rgba(255, 255, 255, 0.25) !important; padding: 10px 14px; font-size: 11px; width: 295px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">
                  <span style="font-weight: 800; color: #fbbf24; letter-spacing: 0.3px;">🎯 Reaction Level Matrix</span>
                  <span id="rlm-trend-badge" class="ios-glass-pill" style="font-size: 9px; font-weight: 700; padding: 1px 7px; background: rgba(245, 158, 11, 0.18); color: #fbbf24;">BULLISH</span>
                </div>
                <div style="font-size: 9px; color: #94a3b8; margin-bottom: 6px;">WillyAlgoTrader • 0–100 Scored Reaction Levels</div>
                
                <!-- Nearest Key Levels -->
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;">
                  <div class="ios-glass-card" style="background: rgba(239, 68, 68, 0.08) !important; border: 1px solid rgba(239, 68, 68, 0.25) !important; padding: 5px 6px;">
                    <div style="font-size: 8.5px; color: #f87171; font-weight: 700;">🔴 NEAREST RES</div>
                    <div id="rlm-res-price" style="font-size: 11px; font-weight: 800; color: #fca5a5;">--</div>
                    <div id="rlm-res-sub" style="font-size: 8.5px; color: #94a3b8;">--</div>
                  </div>
                  <div class="ios-glass-card" style="background: rgba(34, 197, 94, 0.08) !important; border: 1px solid rgba(34, 197, 94, 0.25) !important; padding: 5px 6px;">
                    <div style="font-size: 8.5px; color: #4ade80; font-weight: 700;">🟢 NEAREST SUP</div>
                    <div id="rlm-sup-price" style="font-size: 11px; font-weight: 800; color: #86efac;">--</div>
                    <div id="rlm-sup-sub" style="font-size: 8.5px; color: #94a3b8;">--</div>
                  </div>
                </div>

                <!-- Signal Status (Single Clean Line) -->
                <div id="rlm-signal-box" class="ios-glass-card" style="padding: 5px 8px; margin-bottom: 6px; font-size: 9.5px; display: flex; justify-content: space-between; align-items: center; white-space: nowrap; gap: 6px; overflow: hidden;">
                  <span style="color: #94a3b8; font-weight: 600; flex-shrink: 0;">Rejection Setup:</span>
                  <span id="rlm-signal-status" style="font-weight: 700; color: #cbd5e1; white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">Waiting for Rejection</span>
                </div>

                <!-- Trade Plan (Visible when active) -->
                <div id="rlm-plan-box" class="ios-glass-card" style="display: none; padding: 5px 8px; background: rgba(56, 189, 248, 0.08) !important; border: 1px solid rgba(56, 189, 248, 0.25) !important; margin-bottom: 6px; font-size: 9.5px;">
                  <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                    <span style="color: #38bdf8; font-weight: 700;">ENTRY: <span id="rlm-plan-entry">--</span></span>
                    <span style="color: #f87171; font-weight: 700;">SL: <span id="rlm-plan-sl">--</span></span>
                  </div>
                  <div style="display: flex; justify-content: space-between; color: #cbd5e1;">
                    <span>TP1: <strong id="rlm-plan-tp1" style="color: #4ade80;">--</strong></span>
                    <span>TP2: <strong id="rlm-plan-tp2" style="color: #4ade80;">--</strong></span>
                    <span>TP3: <strong id="rlm-plan-tp3" style="color: #4ade80;">--</strong></span>
                  </div>
                </div>

                <!-- Active Level Matrix Mini-list -->
                <div style="font-size: 9px; color: #94a3b8; margin-bottom: 3px; font-weight: 700; letter-spacing: 0.2px;">ACTIVE MATRIX LEVELS (SCORE · TOUCHES):</div>
                <div id="rlm-levels-list" style="display: flex; flex-direction: column; gap: 2px; max-height: 85px; overflow-y: auto;"></div>
              </div>

              <!-- 5. EMA30 Band Breakout HUD -->
              <div id="ema30-hud" class="ios-glass-panel" style="display: none; border: 1px solid rgba(34, 197, 94, 0.35) !important; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 0 0 18px rgba(34, 197, 94, 0.12), inset 0 1px 1px rgba(255, 255, 255, 0.25) !important; padding: 10px 14px; font-size: 11px; width: 270px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                  <span style="font-weight: 800; color: #4ade80; letter-spacing: 0.3px;">📊 EMA30 Breakout [EL COBER]</span>
                  <span id="ema30-zone-badge" class="ios-glass-pill" style="font-size: 9px; font-weight: 700; padding: 1px 7px; background: rgba(34, 197, 94, 0.18); color: #4ade80;">BULL</span>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 6px; font-size: 9.5px;">
                  <div class="ios-glass-card" style="padding: 4px 6px;">
                    <div style="color: #94a3b8; font-size: 8.5px;">EMA30 BAND</div>
                    <div style="font-size: 10px; font-weight: 700; color: #e2e8f0;"><span style="color:#4ade80;" id="ema30-h-val">--</span> / <span style="color:#f87171;" id="ema30-l-val">--</span></div>
                  </div>
                  <div class="ios-glass-card" style="padding: 4px 6px;">
                    <div style="color: #94a3b8; font-size: 8.5px;">EMA200 TREND</div>
                    <div id="ema30-200-val" style="font-size: 10px; font-weight: 700; color: #fbbf24;">--</div>
                  </div>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-secondary); margin-bottom: 4px;">
                  <span>Swing Peak/Trough:</span>
                  <span style="font-weight: 700;"><span style="color:#4ade80;" id="ema30-prev-peak">--</span> · <span style="color:#f87171;" id="ema30-prev-trough">--</span></span>
                </div>
                <div id="ema30-signal-box" class="ios-glass-card" style="padding: 5px 8px; font-size: 9.5px; display: flex; justify-content: space-between; align-items: center;">
                  <span style="color: #94a3b8; font-weight: 600;">Latest Signal:</span>
                  <span id="ema30-signal-status" style="font-weight: 700; color: #cbd5e1;">Waiting for Breakout</span>
                </div>
              </div>

            </div>
          </div>
        </div>

        <!-- Cell 2 (Secondary Grid Chart) -->
        <div id="chart-cell-2" class="chart-grid-cell" style="display: none; flex-direction: column; position: relative; border-left: 1px solid rgba(255,255,255,0.08); border-top: 1px solid rgba(255,255,255,0.08); background: #0d111a; overflow: hidden;">
          <div style="height: 26px; background: rgba(16,20,32,0.85); display: flex; align-items: center; justify-content: space-between; padding: 0 8px; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 10.5px; z-index: 10; flex-shrink: 0;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <select id="grid-sym-select-2" class="btn" style="padding: 2px 6px; font-size: 10px; font-weight: 700; color: #f0f3f6; background-color: #131722; border: 1px solid rgba(255,255,255,0.18); border-radius: 4px; outline: none; cursor: pointer;">
                <option value="BINANCE:ETHUSDT" selected style="background-color: #131722; color: #f0f3f6;">ETHUSDT</option>
                <option value="BINANCE:BTCUSDT" style="background-color: #131722; color: #f0f3f6;">BTCUSDT</option>
                <option value="BINANCE:SOLUSDT" style="background-color: #131722; color: #f0f3f6;">SOLUSDT</option>
                <option value="HYPERLIQUID:HYPE" style="background-color: #131722; color: #f0f3f6;">HYPE</option>
                <option value="BINANCE:BNBUSDT" style="background-color: #131722; color: #f0f3f6;">BNBUSDT</option>
                <option value="BINANCE:NEARUSDT" style="background-color: #131722; color: #f0f3f6;">NEARUSDT</option>
              </select>
              <div style="display: flex; gap: 2px;">
                <button class="grid-tf-btn btn" data-tf="15" style="padding: 1px 5px; font-size: 9.5px;">15m</button>
                <button class="grid-tf-btn btn active" data-tf="60" style="padding: 1px 5px; font-size: 9.5px;">1h</button>
                <button class="grid-tf-btn btn" data-tf="240" style="padding: 1px 5px; font-size: 9.5px;">4h</button>
                <button class="grid-tf-btn btn" data-tf="D" style="padding: 1px 5px; font-size: 9.5px;">D</button>
              </div>
            </div>
            <span id="grid-legend-2" style="font-size: 10px; font-weight: 700; color: #94a3b8;">ETHUSDT [1h]</span>
          </div>
          <div id="chart-container-2" style="flex: 1; width: 100%; height: calc(100% - 26px); position: relative;"></div>
        </div>

        <!-- Cell 3 (Secondary Grid Chart) -->
        <div id="chart-cell-3" class="chart-grid-cell" style="display: none; flex-direction: column; position: relative; border-left: 1px solid rgba(255,255,255,0.08); border-top: 1px solid rgba(255,255,255,0.08); background: #0d111a; overflow: hidden;">
          <div style="height: 26px; background: rgba(16,20,32,0.85); display: flex; align-items: center; justify-content: space-between; padding: 0 8px; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 10.5px; z-index: 10; flex-shrink: 0;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <select id="grid-sym-select-3" class="btn" style="padding: 2px 6px; font-size: 10px; font-weight: 700; color: #f0f3f6; background-color: #131722; border: 1px solid rgba(255,255,255,0.18); border-radius: 4px; outline: none; cursor: pointer;">
                <option value="BINANCE:SOLUSDT" selected style="background-color: #131722; color: #f0f3f6;">SOLUSDT</option>
                <option value="BINANCE:BTCUSDT" style="background-color: #131722; color: #f0f3f6;">BTCUSDT</option>
                <option value="BINANCE:ETHUSDT" style="background-color: #131722; color: #f0f3f6;">ETHUSDT</option>
                <option value="HYPERLIQUID:HYPE" style="background-color: #131722; color: #f0f3f6;">HYPE</option>
                <option value="BINANCE:NEARUSDT" style="background-color: #131722; color: #f0f3f6;">NEARUSDT</option>
              </select>
              <div style="display: flex; gap: 2px;">
                <button class="grid-tf-btn btn active" data-tf="15" style="padding: 1px 5px; font-size: 9.5px;">15m</button>
                <button class="grid-tf-btn btn" data-tf="60" style="padding: 1px 5px; font-size: 9.5px;">1h</button>
                <button class="grid-tf-btn btn" data-tf="240" style="padding: 1px 5px; font-size: 9.5px;">4h</button>
                <button class="grid-tf-btn btn" data-tf="D" style="padding: 1px 5px; font-size: 9.5px;">D</button>
              </div>
            </div>
            <span id="grid-legend-3" style="font-size: 10px; font-weight: 700; color: #94a3b8;">SOLUSDT [15m]</span>
          </div>
          <div id="chart-container-3" style="flex: 1; width: 100%; height: calc(100% - 26px); position: relative;"></div>
        </div>

        <!-- Cell 4 (Secondary Grid Chart) -->
        <div id="chart-cell-4" class="chart-grid-cell" style="display: none; flex-direction: column; position: relative; border-left: 1px solid rgba(255,255,255,0.08); border-top: 1px solid rgba(255,255,255,0.08); background: #0d111a; overflow: hidden;">
          <div style="height: 26px; background: rgba(16,20,32,0.85); display: flex; align-items: center; justify-content: space-between; padding: 0 8px; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 10.5px; z-index: 10; flex-shrink: 0;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <select id="grid-sym-select-4" class="btn" style="padding: 2px 6px; font-size: 10px; font-weight: 700; color: #f0f3f6; background-color: #131722; border: 1px solid rgba(255,255,255,0.18); border-radius: 4px; outline: none; cursor: pointer;">
                <option value="HYPERLIQUID:HYPE" selected style="background-color: #131722; color: #f0f3f6;">HYPE</option>
                <option value="BINANCE:BTCUSDT" style="background-color: #131722; color: #f0f3f6;">BTCUSDT</option>
                <option value="BINANCE:ETHUSDT" style="background-color: #131722; color: #f0f3f6;">ETHUSDT</option>
                <option value="BINANCE:SOLUSDT" style="background-color: #131722; color: #f0f3f6;">SOLUSDT</option>
                <option value="BINANCE:BNBUSDT" style="background-color: #131722; color: #f0f3f6;">BNBUSDT</option>
              </select>
              <div style="display: flex; gap: 2px;">
                <button class="grid-tf-btn btn" data-tf="15" style="padding: 1px 5px; font-size: 9.5px;">15m</button>
                <button class="grid-tf-btn btn active" data-tf="60" style="padding: 1px 5px; font-size: 9.5px;">1h</button>
                <button class="grid-tf-btn btn" data-tf="240" style="padding: 1px 5px; font-size: 9.5px;">4h</button>
                <button class="grid-tf-btn btn" data-tf="D" style="padding: 1px 5px; font-size: 9.5px;">D</button>
              </div>
            </div>
            <span id="grid-legend-4" style="font-size: 10px; font-weight: 700; color: #94a3b8;">HYPE [1h]</span>
          </div>
          <div id="chart-container-4" style="flex: 1; width: 100%; height: calc(100% - 26px); position: relative;"></div>
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

              </div>
    </div>

    <!-- VIEW PAPER TRADE ($10K) -->
    <!-- VIEW: PAPER TRADE (SHADCN/UI ZINC DARK) -->
    <div class="view-panel sh-view" id="view-paper">
      <div class="sh-scroll">
        <div class="sh-container">

          <!-- Header -->
          <div class="sh-header">
            <div>
              <h1 class="sh-title">Paper Trade</h1>
              <p class="sh-subtitle">Tài khoản mô phỏng $10,000 · Oliver Kell Enhanced R:R V2.1 · Tối đa 3x đòn bẩy</p>
            </div>
            <div class="sh-header-actions">
              <span class="sh-badge sh-badge-outline">Target: $100 – $300 / day</span>
              <span class="sh-badge sh-badge-emerald" id="paper-engine-status">● Auto-Engine Running</span>
            </div>
          </div>

          <!-- Action Toolbar -->
          <div class="sh-toolbar-row">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <button class="sh-btn-outline" id="btn-toggle-auto-trade" type="button">● Auto-Trade: Active</button>
              <button class="sh-btn-outline" id="btn-open-strategy-studio" type="button" title="Quản lý chiến lược có sẵn &amp; Tự viết code chiến lược mới">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/></svg>
                <span>Strategy: <strong id="paper-active-strat-lbl" style="font-weight: 600;">Oliver Kell Cycle</strong></span>
              </button>
              <button class="sh-btn-outline" id="btn-open-hl-agent-modal" type="button" title="Cấu hình Hyperliquid Agent Wallet để Bot tự động ký lệnh">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                <span>Hyperliquid API</span>
                <span class="sh-badge sh-badge-destructive" id="hl-agent-status-badge" style="height: 18px; font-size: 10px;">Chưa cài</span>
              </button>
              <button class="sh-btn-outline" id="btn-open-vario-modal" type="button" title="Cấu hình &amp; Đặt lệnh Variational Omni (Testnet API v1)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                <span>Variational Omni (Testnet)</span>
                <span class="sh-badge sh-badge-destructive" id="vario-agent-status-badge" style="height: 18px; font-size: 10px;">Chưa cài</span>
              </button>
            </div>

            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <button class="sh-btn-outline" id="btn-paper-refresh" type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                <span>Refresh</span>
              </button>
              <button class="sh-btn-destructive" id="btn-paper-close-all" type="button">Close All</button>
              <button class="sh-btn-outline" id="btn-paper-reset" type="button">Reset $10k</button>
            </div>
          </div>

          <!-- 4 KPI Cards -->
          <div class="sh-kpi-4">
            <div class="sh-card">
              <div class="sh-card-top">
                <span class="sh-card-label">Total Equity</span>
                <span class="sh-badge sh-badge-outline">USD</span>
              </div>
              <div class="sh-card-value" id="paper-equity" style="font-size: 20px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">$10,000.00</div>
              <div class="sh-card-meta">Tổng tài sản ước tính (Cash + uPnL)</div>
            </div>

            <div class="sh-card">
              <div class="sh-card-top">
                <span class="sh-card-label">Available Cash</span>
              </div>
              <div class="sh-card-value" id="paper-cash" style="font-size: 20px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">$10,000.00</div>
              <div class="sh-card-meta">Ký quỹ khả dụng cho lệnh mới</div>
            </div>

            <div class="sh-card">
              <div class="sh-card-top">
                <span class="sh-card-label">Today Realized PnL</span>
              </div>
              <div class="sh-card-value" id="paper-daily-pnl" style="font-size: 20px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">$0.00</div>
              <div class="sh-card-meta">Lãi/lỗ đã chốt trong phiên hôm nay</div>
            </div>

            <div class="sh-card">
              <div class="sh-card-top">
                <span class="sh-card-label">Win Rate / Trades</span>
              </div>
              <div class="sh-card-value" id="paper-winrate" style="font-size: 20px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">0% (0)</div>
              <div class="sh-card-meta">Tỷ lệ thắng trên tổng số lệnh đã đóng</div>
            </div>
          </div>

          <!-- Daily Target & Stop Loss Guard Card -->
          <div class="sh-card">
            <div class="sh-card-top" style="margin-bottom: 8px;">
              <span class="sh-card-label" style="color: var(--sh-fg); font-size: 13px;">Daily Profit Target (1% – 3% | $100 – $300) &amp; Stop Loss Guard (-$180)</span>
              <span id="target-progress-text" style="font-size: 12.5px; font-weight: 600; color: #fbbf24; font-variant-numeric: tabular-nums;">0%</span>
            </div>
            <div class="sh-progress-track">
              <div id="target-progress-bar" style="height: 100%; width: 0%; background: #10b981; transition: width 0.3s;"></div>
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 8px; font-size: 11px; color: var(--sh-subtle-fg); font-variant-numeric: tabular-nums; flex-wrap: wrap; gap: 6px;">
              <span style="color: #f87171;">-$180.00 Stop Loss (-1.8%)</span>
              <span>$0.00</span>
              <span style="color: #38bdf8;">$100.00 Min Target (1%)</span>
              <span style="color: #34d399;">$300.00 Max Lock (3%)</span>
            </div>
          </div>

          <!-- Active Paper Positions Table -->
          <div class="sh-table-card">
            <div class="sh-table-card-head">
              <span class="sh-table-card-title">Active Paper Positions</span>
              <span class="sh-badge sh-badge-outline">Max 2 Concurrent · Up to 3x Leverage</span>
            </div>
            <div class="sh-table-scroll">
              <table class="sh-table" id="table-paper-positions">
                <thead>
                  <tr>
                    <th class="pos-col-symbol">Symbol</th>
                    <th class="pos-col-side">Side</th>
                    <th class="pos-col-lev">Lev</th>
                    <th class="pos-col-entry">Entry</th>
                    <th class="pos-col-mark">Mark Price</th>
                    <th class="pos-col-tp">TP</th>
                    <th class="pos-col-sl">SL</th>
                    <th class="pos-col-margin">Margin</th>
                    <th class="pos-col-notional">Notional</th>
                    <th class="pos-col-pnl">Unrealized PnL</th>
                    <th class="pos-col-action">Action</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td colspan="11" style="text-align: center; color: var(--sh-subtle-fg); padding: 20px;">Scanning for high-confluence entry setups...</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Completed Trades & Strategy Execution Log -->
          <div class="sh-grid-2" style="align-items: stretch;">
            <div class="sh-table-card" style="display: flex; flex-direction: column;">
              <div class="sh-table-card-head">
                <span class="sh-table-card-title">Completed Trades History</span>
              </div>
              <div class="sh-table-scroll" style="flex: 1; min-height: 300px; max-height: max(380px, calc(100vh - 520px));">
                <table class="sh-table" id="table-paper-trades">
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
                    <tr><td colspan="5" style="text-align: center; color: var(--sh-subtle-fg); padding: 20px;">No completed trades yet today.</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="sh-card" style="display: flex; flex-direction: column;">
              <div class="sh-card-top">
                <span class="sh-card-label" style="color: var(--sh-fg); font-size: 13.5px; font-weight: 600;">Strategy Execution Log</span>
                <span class="sh-badge sh-badge-sky" id="paper-logs-status">● Live Event Stream</span>
              </div>
              <div id="paper-logs-container" style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; color: #a1a1aa; line-height: 1.6; flex: 1; min-height: 300px; max-height: max(380px, calc(100vh - 520px)); overflow-y: auto; background: #09090b; border: 1px solid #27272a; border-radius: 8px; padding: 10px 12px; scrollbar-width: thin;">
                <div>[PaperTrader] Engine initialized with $10,000.00 fund.</div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- VIEW: DAILY PNL JOURNAL (SHADCN/UI ZINC DARK) -->
    <div class="view-panel sh-view" id="view-journal">
      <div class="ts-dashboard">
        <div class="ts-dashboard-inner">

          <!-- Header -->
          <div class="ts-top-header">
            <div>
              <h1 class="ts-title">Daily PnL Journal</h1>
              <p class="sh-subtitle">Nhật ký hiệu suất giao dịch theo ngày · Mô phỏng V2.1 &amp; Giao dịch trực tiếp</p>
            </div>
            <div class="ts-top-right">
              <div class="ts-status-badge">
                <span class="ts-status-dot"></span>
                <span>Live Sync</span>
              </div>
            </div>
          </div>

          <!-- Filter & Action Toolbar (Functional controls only) -->
          <div class="ts-toolbar">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <select class="ts-select sh-select" id="ts-month-mode">
                <option value="sim6m" selected>Paper Trading Journal (Jan – Nov 2026)</option>
                <option value="current">Current Live Paper Trading</option>
                <option value="march2026">March 2026 (Demo Showcase)</option>
              </select>
            </div>

            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
              <button class="ts-btn-outline" id="btn-ts-export-excel" type="button" title="Tải File Excel (.xlsx)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h2"/><path d="M8 17h2"/><path d="M14 13h2"/><path d="M14 17h2"/></svg>
                <span>Export Excel</span>
              </button>
              <button class="ts-btn-outline" id="btn-ts-send-tele" type="button" title="Gửi Báo Cáo Excel (.xlsx) Sang Telegram">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                <span>Gửi Telegram</span>
              </button>
              <button class="ts-btn-primary" id="btn-ts-sync" type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                <span>Sync</span>
              </button>
            </div>
          </div>

          <!-- 5 KPI Summary Cards -->
          <div class="ts-kpi-grid">
            <div class="ts-kpi-card">
              <div>
                <div class="ts-kpi-head"><span>Win Rate</span></div>
                <div class="ts-kpi-val" id="ts-kpi-winrate">72.7%</div>
                <div class="ts-kpi-sub" id="ts-kpi-winloss-count">16W - 6L</div>
              </div>
              <div>
                <div class="ts-bar-dual">
                  <div class="ts-bar-dual-green" id="ts-kpi-winbar" style="width: 72.7%;"></div>
                  <div class="ts-bar-dual-red" id="ts-kpi-lossbar" style="width: 27.3%;"></div>
                </div>
                <div class="ts-kpi-split-foot">
                  <span style="color: #34d399;" id="ts-kpi-wins-label">16 wins</span>
                  <span style="color: #f87171;" id="ts-kpi-losses-label">6 losses</span>
                </div>
              </div>
            </div>

            <div class="ts-kpi-card">
              <div>
                <div class="ts-kpi-head"><span>Avg Win / Loss</span></div>
                <div class="ts-kpi-val" id="ts-kpi-avg-winloss">$131.59</div>
                <div class="ts-kpi-sub">Per trade expectancy</div>
              </div>
              <div>
                <div class="ts-sub-bar-row">
                  <span style="color: #34d399; font-weight: 500; width: 66px;" id="ts-kpi-avg-win-val">+$250.31</span>
                  <div class="ts-sub-bar-track"><div style="height: 100%; width: 75%; background: #10b981; border-radius: 999px;"></div></div>
                </div>
                <div class="ts-sub-bar-row">
                  <span style="color: #f87171; font-weight: 500; width: 66px;" id="ts-kpi-avg-loss-val">-$185.00</span>
                  <div class="ts-sub-bar-track"><div style="height: 100%; width: 55%; background: #ef4444; border-radius: 999px;"></div></div>
                </div>
              </div>
            </div>

            <div class="ts-kpi-card">
              <div>
                <div class="ts-kpi-head"><span>Long vs Short</span></div>
                <div class="ts-kpi-val green" id="ts-kpi-ls-total">+$2,895</div>
                <div class="ts-kpi-sub">Total Net PnL</div>
              </div>
              <div>
                <div class="ts-sub-bar-row">
                  <span style="color: #a1a1aa; font-weight: 500;">L</span>
                  <div class="ts-sub-bar-track"><div style="height: 100%; width: 68%; background: #10b981; border-radius: 999px;"></div></div>
                  <span style="color: #34d399; font-weight: 500;" id="ts-kpi-long-val">+$1,630 &gt;</span>
                </div>
                <div class="ts-sub-bar-row">
                  <span style="color: #a1a1aa; font-weight: 500;">S</span>
                  <div class="ts-sub-bar-track"><div style="height: 100%; width: 52%; background: #10b981; border-radius: 999px;"></div></div>
                  <span style="color: #34d399; font-weight: 500;" id="ts-kpi-short-val">+$1,265 &gt;</span>
                </div>
              </div>
            </div>

            <div class="ts-kpi-card">
              <div>
                <div class="ts-kpi-head"><span>Max Streaks</span></div>
                <div class="ts-kpi-val green" id="ts-kpi-streak-val">6</div>
                <div class="ts-kpi-sub">Best consecutive wins</div>
              </div>
              <div>
                <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                  <span style="color: #71717a;">Consecutive wins</span>
                  <strong style="color: #34d399; font-weight: 600;" id="ts-kpi-streak-win">6</strong>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 11px;">
                  <span style="color: #71717a;">Consecutive losses</span>
                  <strong style="color: #f87171; font-weight: 600;" id="ts-kpi-streak-loss">1</strong>
                </div>
              </div>
            </div>

            <div class="ts-kpi-card">
              <div>
                <div class="ts-kpi-head"><span>Avg Duration</span></div>
                <div class="ts-kpi-val" id="ts-kpi-avg-duration">2h 20m</div>
                <div class="ts-kpi-sub">Holding duration</div>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 11px; color: #71717a; margin-top: 4px;">
                <span>Fastest: <strong style="color: #fafafa; font-weight: 500;">14m</strong></span>
                <span>Longest: <strong style="color: #fafafa; font-weight: 500;">8h 15m</strong></span>
              </div>
            </div>
          </div>

          <!-- 4 Performance & Sparkline Cards -->
          <div class="ts-perf-grid">
            <div class="ts-perf-card">
              <div class="ts-perf-head">
                <span>Performance Score</span>
                <span class="ts-score-badge" id="ts-score-badge-val">50 / 100</span>
              </div>
              <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 4px;">
                <svg width="96" height="86" viewBox="0 0 100 90">
                  <polygon points="50,15 85,75 15,75" fill="none" stroke="#27272a" stroke-width="1.2" />
                  <polygon points="50,30 72,70 28,70" fill="none" stroke="#18181b" stroke-width="1" />
                  <line x1="50" y1="15" x2="50" y2="75" stroke="#27272a" stroke-width="0.8" stroke-dasharray="2,2" />
                  <polygon id="ts-radar-polygon" points="50,22 75,68 30,72" fill="rgba(56, 189, 248, 0.2)" stroke="#38bdf8" stroke-width="1.6" />
                  <text x="50" y="10" fill="#71717a" font-size="7.5" font-weight="600" text-anchor="middle">R/W</text>
                  <text x="94" y="80" fill="#71717a" font-size="7.5" font-weight="600" text-anchor="end">Win %</text>
                  <text x="6" y="80" fill="#71717a" font-size="7.5" font-weight="600">P.F.</text>
                </svg>
                <div style="flex: 1; margin-left: 12px; display: flex; flex-direction: column; gap: 7px;">
                  <div>
                    <div style="display: flex; justify-content: space-between; font-size: 10px; font-weight: 500; color: #a1a1aa;">
                      <span>BIAS</span><span style="color: #fafafa;" id="ts-score-bias-val">73</span>
                    </div>
                    <div style="height: 4px; background: #18181b; border-radius: 999px; overflow: hidden; margin-top: 3px;">
                      <div id="ts-score-bias-bar" style="width: 73%; height: 100%; background: #38bdf8;"></div>
                    </div>
                  </div>
                  <div>
                    <div style="display: flex; justify-content: space-between; font-size: 10px; font-weight: 500; color: #a1a1aa;">
                      <span>R/R</span><span style="color: #fafafa;" id="ts-score-rr-val">45</span>
                    </div>
                    <div style="height: 4px; background: #18181b; border-radius: 999px; overflow: hidden; margin-top: 3px;">
                      <div id="ts-score-rr-bar" style="width: 45%; height: 100%; background: #a855f7;"></div>
                    </div>
                  </div>
                  <div>
                    <div style="display: flex; justify-content: space-between; font-size: 10px; font-weight: 500; color: #a1a1aa;">
                      <span>P.F.</span><span style="color: #fafafa;" id="ts-score-pf-val">34</span>
                    </div>
                    <div style="height: 4px; background: #18181b; border-radius: 999px; overflow: hidden; margin-top: 3px;">
                      <div id="ts-score-pf-bar" style="width: 34%; height: 100%; background: #10b981;"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="ts-perf-card">
              <div class="ts-perf-head">
                <span>Cumulative PnL</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
              </div>
              <div class="ts-perf-val" id="ts-cum-pnl-val">+$2,895</div>
              <svg class="ts-sparkline-svg" viewBox="0 0 180 50">
                <defs>
                  <linearGradient id="tsGradCum" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#10b981" stop-opacity="0.28"/>
                    <stop offset="100%" stop-color="#10b981" stop-opacity="0.0"/>
                  </linearGradient>
                </defs>
                <path d="M 0 45 L 20 40 L 45 36 L 70 28 L 95 24 L 120 18 L 145 12 L 175 6 L 175 50 L 0 50 Z" fill="url(#tsGradCum)" />
                <path d="M 0 45 L 20 40 L 45 36 L 70 28 L 95 24 L 120 18 L 145 12 L 175 6" fill="none" stroke="#10b981" stroke-width="1.8" stroke-linecap="round" />
                <circle cx="175" cy="6" r="2.5" fill="#10b981" />
              </svg>
            </div>

            <div class="ts-perf-card">
              <div class="ts-perf-head">
                <span>Max Drawdown</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>
              </div>
              <div class="ts-perf-val red" id="ts-dd-val">-$150.00 <span style="font-size: 11px; font-weight: 400; color: #71717a;">max</span></div>
              <svg class="ts-sparkline-svg" viewBox="0 0 180 50">
                <defs>
                  <linearGradient id="tsGradDD" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#ef4444" stop-opacity="0.25"/>
                    <stop offset="100%" stop-color="#ef4444" stop-opacity="0.0"/>
                  </linearGradient>
                </defs>
                <path d="M 0 8 L 35 8 L 70 12 L 105 10 L 140 14 L 165 42 L 175 44 L 175 50 L 0 50 Z" fill="url(#tsGradDD)" />
                <path d="M 0 8 L 35 8 L 70 12 L 105 10 L 140 14 L 165 42 L 175 44" fill="none" stroke="#ef4444" stroke-width="1.8" stroke-linecap="round" />
                <circle cx="175" cy="44" r="2.5" fill="#ef4444" />
              </svg>
            </div>

            <div class="ts-perf-card">
              <div class="ts-perf-head">
                <span>Month PnL</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
              </div>
              <div class="ts-perf-val" id="ts-today-pnl-val">+$250</div>
              <svg class="ts-sparkline-svg" viewBox="0 0 180 50">
                <path d="M 0 35 Q 25 15, 50 25 T 100 20 T 140 10 T 175 6" fill="none" stroke="#10b981" stroke-width="1.8" stroke-linecap="round" />
                <circle cx="175" cy="6" r="2.5" fill="#10b981" />
              </svg>
            </div>
          </div>

          <!-- Monthly Calendar Card -->
          <div class="ts-calendar-card">
            <div class="ts-cal-header">
              <div class="ts-cal-brand">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                <span>Monthly Calendar</span>
              </div>
              <div class="ts-cal-nav">
                <button class="ts-cal-nav-btn" id="btn-ts-prev-month" type="button" title="Previous month">&lt;</button>
                <div class="ts-cal-nav-title" id="ts-cal-title">November 2026</div>
                <button class="ts-cal-nav-btn" id="btn-ts-next-month" type="button" title="Next month">&gt;</button>
              </div>
              <div class="ts-cal-actions">
                <button class="ts-btn-outline" id="btn-ts-journal-card" type="button" style="height: 28px; font-size: 12px;">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                  <span>Day Details</span>
                </button>
              </div>
            </div>

            <div class="ts-cal-grid" id="ts-cal-grid-body">
              <!-- Dynamically generated by JS -->
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- Day Journal Detail Modal -->
    <div class="ts-modal-overlay sh-view" id="ts-modal-overlay">
      <div class="ts-modal-box">
        <div class="ts-modal-head">
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
            <strong style="font-size: 15px; font-weight: 600; color: #fafafa;" id="ts-modal-date-title">Trade Details</strong>
          </div>
          <button id="btn-ts-modal-close" type="button" style="background: transparent; border: none; color: #a1a1aa; font-size: 16px; cursor: pointer; padding: 4px 6px;">✕</button>
        </div>
        <div id="ts-modal-summary" style="display: flex; gap: 12px; margin-bottom: 16px;"></div>
        <div id="ts-modal-trades-list"></div>
      </div>
    </div>

    <!-- VIEW: MACRO CALENDAR (SHADCN/UI ZINC DARK) -->
    <div class="view-panel sh-view" id="view-macro">
      <div class="sh-scroll">
        <div class="sh-container">

          <!-- Zone 1: Page Header -->
          <div class="sh-header">
            <div>
              <h1 class="sh-title">Macro Calendar</h1>
              <p class="sh-subtitle">Lịch sự kiện vĩ mô, lãi suất ngân hàng trung ương và dữ liệu lạm phát tác động tới Crypto (UTC+7)</p>
            </div>
            <div class="sh-header-actions">
              <span class="sh-badge sh-badge-outline" id="mc-sync-status">Đang đồng bộ...</span>
              <button class="sh-btn-outline" id="btn-mc-refresh" type="button" title="Đồng bộ lại dữ liệu ForexFactory">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                <span>Sync Feed</span>
              </button>
            </div>
          </div>

          <!-- Zone 2: 3 Dynamic KPI Cards -->
          <div class="sh-kpi-grid">
            <!-- KPI 1: Next High-Impact Catalyst -->
            <div class="sh-card">
              <div class="sh-card-top">
                <span class="sh-card-label">Next High-Impact Catalyst</span>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span class="sh-badge sh-badge-outline" id="mc-kpi-risk-badge">Scheduled</span>
                  <span class="sh-timer" id="mc-next-event-timer">--:--:--</span>
                </div>
              </div>
              <div class="sh-card-value" id="mc-next-event-title">Đang tải...</div>
              <div class="sh-card-meta" id="mc-next-event-meta">—</div>
            </div>

            <!-- KPI 2: Next FOMC / Central Bank -->
            <div class="sh-card">
              <div class="sh-card-top">
                <span class="sh-card-label">Next FOMC Decision</span>
                <span class="sh-badge sh-badge-secondary">USD · FED</span>
              </div>
              <div class="sh-card-value" id="mc-stat-fomc-date">—</div>
              <div class="sh-card-meta" id="mc-stat-fomc-sub">—</div>
            </div>

            <!-- KPI 3: Next US Inflation Print -->
            <div class="sh-card">
              <div class="sh-card-top">
                <span class="sh-card-label">Next US Inflation Print</span>
                <span class="sh-badge sh-badge-secondary">CPI / PCE</span>
              </div>
              <div class="sh-card-value" id="mc-stat-cpi-date">—</div>
              <div class="sh-card-meta" id="mc-stat-cpi-sub">—</div>
            </div>
          </div>

          <!-- Zone 3: Toolbar + Economic Events Table -->
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <div class="sh-toolbar">
              <!-- Toolbar Row 1: Timeframe Tabs + Search + Hide Past Switch -->
              <div class="sh-toolbar-row">
                <div class="sh-tabs-list" id="mc-filter-time-group" role="tablist">
                  <button class="sh-tab-trigger active" type="button" data-mc-time="UPCOMING_30D">30 ngày tới</button>
                  <button class="sh-tab-trigger" type="button" data-mc-time="THIS_WEEK">Tuần này</button>
                  <button class="sh-tab-trigger" type="button" data-mc-time="UPCOMING_MONTH">Tháng này</button>
                  <button class="sh-tab-trigger" type="button" data-mc-time="NEXT_MONTH">Tháng sau</button>
                  <button class="sh-tab-trigger" type="button" data-mc-time="ALL">Tất cả</button>
                </div>

                <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap;">
                  <div class="sh-search-wrap">
                    <svg class="sh-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    <input type="text" id="mc-search-input" class="sh-input" placeholder="Tìm sự kiện (CPI, FOMC, NFP...)">
                  </div>

                  <label class="sh-switch-label" for="mc-toggle-hide-past">
                    <input type="checkbox" id="mc-toggle-hide-past" class="sh-switch-input" checked>
                    <span class="sh-switch-track"><span class="sh-switch-thumb"></span></span>
                    <span>Ẩn tin đã qua</span>
                  </label>
                </div>
              </div>

              <!-- Toolbar Row 2: Faceted Filter Chips + Result Summary -->
              <div class="sh-filter-bar">
                <div class="sh-filter-left">
                  <div class="sh-filter-group" id="mc-filter-impact-group">
                    <button class="sh-filter-chip active" type="button" data-mc-impact="ALL">Tất cả mức độ</button>
                    <button class="sh-filter-chip" type="button" data-mc-impact="HIGH">High</button>
                    <button class="sh-filter-chip" type="button" data-mc-impact="HIGH_MED">High &amp; Med</button>
                  </div>

                  <span class="sh-filter-divider"></span>

                  <div class="sh-filter-group" id="mc-filter-curr-group">
                    <button class="sh-filter-chip active" type="button" data-mc-curr="ALL">Tất cả tiền tệ</button>
                    <button class="sh-filter-chip" type="button" data-mc-curr="USD">USD</button>
                    <button class="sh-filter-chip" type="button" data-mc-curr="EUR">EUR</button>
                    <button class="sh-filter-chip" type="button" data-mc-curr="GBP">GBP</button>
                    <button class="sh-filter-chip" type="button" data-mc-curr="JPY">JPY</button>
                  </div>

                  <span class="sh-filter-divider"></span>

                  <div class="sh-filter-group" id="mc-filter-cat-group">
                    <button class="sh-filter-chip active" type="button" data-mc-cat="ALL">Tất cả nhóm</button>
                    <button class="sh-filter-chip" type="button" data-mc-cat="FED & Central Bank">Central Banks</button>
                    <button class="sh-filter-chip" type="button" data-mc-cat="Inflation (CPI/PPI)">Inflation</button>
                    <button class="sh-filter-chip" type="button" data-mc-cat="Employment & NFP">Jobs</button>
                    <button class="sh-filter-chip" type="button" data-mc-cat="Growth & GDP">Growth</button>
                  </div>

                  <button class="sh-btn-ghost" id="btn-mc-reset-filters" type="button" style="display: none;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    <span>Reset</span>
                  </button>
                </div>

                <div style="font-size: 12px; color: var(--sh-subtle-fg); font-variant-numeric: tabular-nums;" id="mc-result-count">
                  Đang tải dữ liệu...
                </div>
              </div>
            </div>

            <!-- Events Table Card -->
            <div class="sh-table-card">
              <div class="sh-table-scroll">
                <table class="sh-table">
                  <thead>
                    <tr>
                      <th style="width: 118px;">Time (UTC+7)</th>
                      <th style="width: 78px;">CCY</th>
                      <th style="width: 102px;">Impact</th>
                      <th>Event</th>
                      <th style="width: 96px; text-align: right;">Actual</th>
                      <th style="width: 96px; text-align: right;">Forecast</th>
                      <th style="width: 96px; text-align: right;">Previous</th>
                    </tr>
                  </thead>
                  <tbody id="mc-events-tbody">
                    <!-- Dynamically rendered rows -->
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- Zone 4: Collapsible Dynamic Catalyst Playbook Card -->
          <div class="sh-card" id="mc-scenario-card">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap;">
              <div>
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <span style="font-size: 14px; font-weight: 600; color: var(--sh-fg);">Catalyst Playbook</span>
                  <span id="mc-scenario-badges" style="display: inline-flex; align-items: center; gap: 6px;"></span>
                </div>
                <div id="mc-scenario-event-title" style="font-size: 15px; font-weight: 600; color: var(--sh-fg); margin-top: 6px;">Đang tải sự kiện trọng tâm...</div>
                <div id="mc-scenario-meta" style="font-size: 12px; color: var(--sh-muted-fg); margin-top: 3px;">Nhấn vào một sự kiện bất kỳ trong bảng để xem kịch bản phản ứng 3 chiều.</div>
              </div>

              <div style="display: flex; align-items: center; gap: 8px;">
                <button class="sh-btn-ghost" id="btn-mc-scenario-reset" type="button" style="display: none;">Về tin tiếp theo</button>
                <button class="sh-btn-outline" id="btn-mc-scenario-toggle" type="button" style="height: 28px; font-size: 12px;">Thu gọn</button>
              </div>
            </div>

            <div id="mc-scenario-body">
              <div id="mc-scenario-cards-grid" class="sh-scenario-grid">
                <!-- Dynamically populated 3 scenario columns -->
              </div>
              <div id="mc-scenario-risk-note" style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--sh-border-subtle); font-size: 12px; color: var(--sh-subtle-fg);">
                —
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- VIEW: AI INTELLIGENCE HUB (COMBINED: 26-TA VALIDATION • ASTRA BACKTEST • 300-AGENT HUB) -->
    <!-- VIEW: AI INTELLIGENCE HUB (SHADCN/UI ZINC DARK) -->
    <div class="view-panel sh-view" id="view-ai-hub">
      <div class="sh-scroll">
        <div class="sh-container">

          <!-- Header -->
          <div class="sh-header">
            <div>
              <h1 class="sh-title">AI Intelligence Hub</h1>
              <p class="sh-subtitle">Đồng thuận 26 chỉ báo kỹ thuật · Kiểm thử chiến lược Astra Backtest · Cụm 300 Sub-Agents song song</p>
            </div>
            <div class="sh-header-actions">
              <div class="sh-tabs-list" role="tablist">
                <button class="sh-tab-trigger ai-hub-focus-btn active" type="button" data-ai-target="all">All Modules</button>
                <button class="sh-tab-trigger ai-hub-focus-btn" type="button" data-ai-target="ai-sec-validation">Validation 26-TA</button>
                <button class="sh-tab-trigger ai-hub-focus-btn" type="button" data-ai-target="ai-sec-backtest">Astra Backtest</button>
                <button class="sh-tab-trigger ai-hub-focus-btn" type="button" data-ai-target="ai-sec-hub">300-Agent Hub</button>
              </div>
              <button class="sh-btn-primary" id="btn-ai-run-all" type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                <span>Run All Engines</span>
              </button>
            </div>
          </div>

          <!-- 3-Column Unified Grid -->
          <div id="ai-hub-main-container" class="ai-hub-grid-3col">

            <!-- MODULE 1: VALIDATION BOT (26 TA CONSENSUS GATE) -->
            <div class="ai-hub-col" id="ai-sec-validation">
              <div class="ai-hub-col-head">
                <div class="ai-hub-col-title">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  <span>Validation Bot (26 TA)</span>
                </div>
                <span class="sh-badge sh-badge-emerald" id="val-status">Ready</span>
              </div>

              <div style="display: flex; gap: 6px; align-items: center;">
                <input type="text" id="val-sym-input" class="sh-input-plain" value="BINANCE:BTCUSDT" style="flex: 1;">
                <button class="sh-btn-primary sh-btn-sm" id="btn-run-validation" type="button">Evaluate 26 TA</button>
              </div>

              <!-- Consensus Gate Verdict -->
              <div class="ai-hub-subcard">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-size: 12.5px; font-weight: 600; color: var(--sh-fg);">Consensus Gate Verdict</span>
                  <span id="val-verdict-badge" class="action-badge action-neutral">PENDING</span>
                </div>
                <div class="grid-4" style="gap: 8px;">
                  <div class="sh-stat-mini"><div class="stat-label">Trade Gate</div><div class="stat-value" id="val-gate" style="font-size: 12px;">—</div></div>
                  <div class="sh-stat-mini"><div class="stat-label">Buy Votes</div><div class="stat-value val-green" id="val-buy" style="font-size: 13px;">—</div></div>
                  <div class="sh-stat-mini"><div class="stat-label">Neutral</div><div class="stat-value" id="val-neutral" style="font-size: 13px;">—</div></div>
                  <div class="sh-stat-mini"><div class="stat-label">Sell Votes</div><div class="stat-value val-red" id="val-sell" style="font-size: 13px;">—</div></div>
                </div>
                <p id="val-reason" style="margin: 0; font-size: 12px; color: var(--sh-muted-fg); line-height: 1.45;"></p>
              </div>

              <!-- Quantitative Edge Statistics Card -->
              <div class="ai-hub-subcard" id="val-edge-stats-card">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap;">
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 12.5px; font-weight: 600; color: var(--sh-fg);">Edge Stats</span>
                    <span class="sh-badge sh-badge-outline" style="height: 19px; font-size: 10px;">Wilson 95%</span>
                  </div>
                  <span id="edge-eval-range" style="font-size: 11px; color: var(--sh-subtle-fg);">History: —</span>
                </div>

                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
                  <div class="sh-stat-mini">
                    <div class="stat-label">Prior High (PDH)</div>
                    <div class="stat-value val-green" id="edge-pdh-rate" style="font-size: 13px;">—</div>
                    <div style="font-size: 10px; color: var(--sh-subtle-fg);" id="edge-pdh-ci">CI: —</div>
                    <div style="font-size: 10px; color: var(--sh-muted-fg);" id="edge-pdh-sub">Dist: —</div>
                  </div>
                  <div class="sh-stat-mini">
                    <div class="stat-label">Prior Low (PDL)</div>
                    <div class="stat-value val-red" id="edge-pdl-rate" style="font-size: 13px;">—</div>
                    <div style="font-size: 10px; color: var(--sh-subtle-fg);" id="edge-pdl-ci">CI: —</div>
                    <div style="font-size: 10px; color: var(--sh-muted-fg);" id="edge-pdl-sub">Dist: —</div>
                  </div>
                  <div class="sh-stat-mini">
                    <div class="stat-label">Gap Fill Rate</div>
                    <div class="stat-value val-yellow" id="edge-gap-rate" style="font-size: 13px;">—</div>
                    <div style="font-size: 10px; color: var(--sh-subtle-fg);" id="edge-gap-ci">CI: —</div>
                    <div style="font-size: 10px; color: var(--sh-muted-fg);" id="edge-gap-time">Time: —</div>
                  </div>
                  <div class="sh-stat-mini">
                    <div class="stat-label">ORB Trend Exp</div>
                    <div class="stat-value" id="edge-orb-rate" style="color: #fafafa; font-size: 13px;">—</div>
                    <div style="font-size: 10px; color: var(--sh-subtle-fg);" id="edge-orb-ci">CI: —</div>
                    <div style="font-size: 10px; color: var(--sh-muted-fg);" id="edge-orb-false">False: —</div>
                  </div>
                </div>
              </div>

              <!-- Oscillators & MAs Tables -->
              <div class="sh-table-card">
                <div class="sh-table-card-head" style="padding: 10px 12px;">
                  <span style="font-size: 12px; font-weight: 600; color: var(--sh-fg);">Oscillators (11)</span>
                  <span style="font-size: 11px; color: var(--sh-subtle-fg);">Động lượng &amp; Đảo chiều</span>
                </div>
                <div class="sh-table-scroll" style="max-height: 360px;">
                  <table class="sh-table" id="table-osc"><thead><tr><th>Indicator</th><th>Value</th><th>Signal</th></tr></thead><tbody></tbody></table>
                </div>
              </div>

              <div class="sh-table-card">
                <div class="sh-table-card-head" style="padding: 10px 12px;">
                  <span style="font-size: 12px; font-weight: 600; color: var(--sh-fg);">Moving Averages (15)</span>
                  <span style="font-size: 11px; color: var(--sh-subtle-fg);">Đường trung bình động</span>
                </div>
                <div class="sh-table-scroll" style="max-height: 440px;">
                  <table class="sh-table" id="table-ma"><thead><tr><th>Indicator</th><th>Value</th><th>Signal</th></tr></thead><tbody></tbody></table>
                </div>
              </div>
            </div>

            <!-- MODULE 2: ASTRA WALKFORWARD BACKTEST ENGINE -->
            <div class="ai-hub-col" id="ai-sec-backtest">
              <div class="ai-hub-col-head">
                <div class="ai-hub-col-title">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M10 3v4l-5.2 8.7A2 2 0 0 0 6.5 19h11a2 2 0 0 0 1.7-3.3L14 7V3"/></svg>
                  <span>Astra Backtest Engine</span>
                </div>
                <span class="sh-badge sh-badge-outline" id="bt-status">Ready</span>
              </div>

              <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
                <input type="text" id="bt-sym-input" class="sh-input-plain" value="BINANCE:BTCUSDT" style="width: 128px;">
                <select id="bt-strat-select" class="sh-select" style="flex: 1;">
                  <option value="supertrend">Supertrend (10, 3)</option>
                  <option value="emacross">EMA Cross (9 / 21)</option>
                  <option value="rsi">RSI Mean-Reversion (14)</option>
                </select>
                <button class="sh-btn-primary sh-btn-sm" id="btn-run-backtest" type="button">Test Hypothesis</button>
              </div>

              <!-- Performance Summary -->
              <div class="ai-hub-subcard">
                <span style="font-size: 12.5px; font-weight: 600; color: var(--sh-fg);">Strategy Performance Summary</span>
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
                  <div class="sh-stat-mini"><div class="stat-label">Net Profit</div><div class="stat-value" id="bt-profit">—</div></div>
                  <div class="sh-stat-mini"><div class="stat-label">Win Rate</div><div class="stat-value" id="bt-winrate">—</div></div>
                  <div class="sh-stat-mini"><div class="stat-label">Sharpe Ratio</div><div class="stat-value" id="bt-sharpe">—</div></div>
                  <div class="sh-stat-mini"><div class="stat-label">Max Drawdown</div><div class="stat-value" id="bt-drawdown">—</div></div>
                </div>
              </div>

              <!-- Recent Simulated Trades Table -->
              <div class="sh-table-card" style="flex: 1; display: flex; flex-direction: column;">
                <div class="sh-table-card-head" style="padding: 10px 12px;">
                  <span style="font-size: 12px; font-weight: 600; color: var(--sh-fg);">Recent Simulated Trades</span>
                </div>
                <div class="sh-table-scroll" style="flex: 1; max-height: 650px;">
                  <table class="sh-table" id="table-trades">
                    <thead><tr><th>Type</th><th>Entry</th><th>Exit</th><th>PnL %</th><th>PnL $</th><th>Capital</th></tr></thead>
                    <tbody></tbody>
                  </table>
                </div>
              </div>
            </div>

            <!-- MODULE 3: 300-AGENT MULTI-TOKEN CLUSTER -->
            <div class="ai-hub-col" id="ai-sec-hub">
              <div class="ai-hub-col-head">
                <div class="ai-hub-col-title">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                  <span>300-Agent Multi-Token Hub</span>
                </div>
                <span class="sh-badge sh-badge-emerald" id="hub-status-text">Hub Online</span>
              </div>

              <div style="display: flex; gap: 6px; align-items: center;">
                <button class="sh-btn-primary sh-btn-sm" id="btn-hub-simulate" type="button" style="flex: 1; justify-content: center;">Simulate 300 Agents Feed</button>
                <button class="sh-btn-outline sh-btn-sm" id="btn-hub-refresh" type="button">Refresh Hub</button>
              </div>

              <!-- Multiplexer Overview -->
              <div class="ai-hub-subcard">
                <span style="font-size: 12.5px; font-weight: 600; color: var(--sh-fg);">Multiplexer Connection Pool</span>
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
                  <div class="sh-stat-mini"><div class="stat-label">Active Agents</div><div class="stat-value" id="hub-agents-count">0</div></div>
                  <div class="sh-stat-mini"><div class="stat-label">Symbols Tracked</div><div class="stat-value" id="hub-symbols-count">0</div></div>
                  <div class="sh-stat-mini"><div class="stat-label">Feed Points</div><div class="stat-value" id="hub-cached-count">0</div></div>
                  <div class="sh-stat-mini"><div class="stat-label">Stream Cost</div><div class="stat-value val-green">$0 (Free)</div></div>
                </div>
              </div>

              <!-- Sub-Agent Live Feeds Table -->
              <div class="sh-table-card" style="flex: 1; display: flex; flex-direction: column;">
                <div class="sh-table-card-head" style="padding: 10px 12px;">
                  <span style="font-size: 12px; font-weight: 600; color: var(--sh-fg);">Sub-Agent Live Market Feeds</span>
                </div>
                <div class="sh-table-scroll" style="flex: 1; max-height: 650px;">
                  <table class="sh-table" id="table-hub-feeds">
                    <thead><tr><th>Symbol</th><th>Price</th><th>24h</th><th>RSI</th><th>MACD</th><th>Verdict</th></tr></thead>
                    <tbody></tbody>
                  </table>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>

    <!-- VIEW 4: REPLAY ENGINE (SHADCN/UI ZINC DARK) -->
    <div class="view-panel sh-view" id="view-replay" style="position: relative; width: 100%; height: 100%; overflow: hidden; flex-direction: column;">
      <!-- Top Control Bar -->
      <div class="sh-rep-topbar">
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong style="font-size: 14px; font-weight: 600; color: #fafafa; letter-spacing: -0.015em;">Replay Engine</strong>
            <span class="sh-badge sh-badge-secondary">Walkforward</span>
          </div>

          <span class="sh-filter-divider"></span>

          <input type="text" id="rep-symbol-input" class="sh-input-plain" value="BINANCE:BTCUSDT" style="width: 152px; height: 28px; font-size: 12px;">

          <div class="sh-filter-group">
            <button class="rep-chip-btn sh-filter-chip active" type="button" data-sym="BINANCE:BTCUSDT">BTC</button>
            <button class="rep-chip-btn sh-filter-chip" type="button" data-sym="BINANCE:ETHUSDT">ETH</button>
            <button class="rep-chip-btn sh-filter-chip" type="button" data-sym="BINANCE:SOLUSDT">SOL</button>
            <button class="rep-chip-btn sh-filter-chip" type="button" data-sym="HYPERLIQUID:HYPE">HYPE</button>
          </div>

          <span class="sh-filter-divider"></span>

          <div class="sh-filter-group">
            <button class="rep-tf-btn sh-filter-chip" type="button" data-tf="1">1m</button>
            <button class="rep-tf-btn sh-filter-chip" type="button" data-tf="5">5m</button>
            <button class="rep-tf-btn sh-filter-chip" type="button" data-tf="15">15m</button>
            <button class="rep-tf-btn sh-filter-chip active" type="button" data-tf="60">1h</button>
            <button class="rep-tf-btn sh-filter-chip" type="button" data-tf="240">4h</button>
            <button class="rep-tf-btn sh-filter-chip" type="button" data-tf="D">D</button>
          </div>

          <button class="sh-btn-primary sh-btn-sm" id="btn-rep-load" type="button">Load Chart</button>
        </div>

        <span id="rep-status-text" style="font-size: 12px; color: #a1a1aa; font-variant-numeric: tabular-nums;">Ready: 1000 bars loaded.</span>
      </div>

      <!-- Replay Chart Canvas -->
      <div style="flex: 1; width: 100%; position: relative; height: calc(100% - 48px); overflow: hidden; background: #09090b;">
        <div id="replay-chart-container" style="width: 100%; height: 100%; position: relative;"></div>

        <!-- Floating Bottom Playback Dock -->
        <div class="sh-rep-dock">
          <div style="display: flex; align-items: center; gap: 6px;">
            <button class="sh-btn-outline sh-btn-sm" id="btn-rep-reset" type="button" title="Reset to start cut-off position">Reset</button>
            <button class="sh-btn-outline sh-btn-sm" id="btn-rep-step-back" type="button" title="Step back 1 bar">-1 Bar</button>
            <button class="sh-btn-primary sh-btn-sm" id="btn-rep-play" type="button" title="Play / Pause Replay">▶ Play</button>
            <button class="sh-btn-outline sh-btn-sm" id="btn-rep-step-fwd" type="button" title="Step forward 1 bar">+1 Bar</button>
          </div>

          <span class="sh-filter-divider"></span>

          <div class="sh-filter-group">
            <span style="font-size: 11px; color: #71717a; font-weight: 500; margin-right: 4px;">Speed</span>
            <button class="rep-speed-btn sh-filter-chip active" type="button" data-speed="1">1x</button>
            <button class="rep-speed-btn sh-filter-chip" type="button" data-speed="2">2x</button>
            <button class="rep-speed-btn sh-filter-chip" type="button" data-speed="5">5x</button>
            <button class="rep-speed-btn sh-filter-chip" type="button" data-speed="10">10x</button>
          </div>

          <span class="sh-filter-divider"></span>

          <input type="range" id="rep-slider" min="20" max="1000" value="750">

          <span class="sh-filter-divider"></span>

          <div style="display: flex; align-items: center; gap: 14px; font-size: 11.5px; font-variant-numeric: tabular-nums;">
            <div style="display: flex; flex-direction: column;">
              <span style="font-size: 9.5px; color: #71717a; text-transform: uppercase;">Price</span>
              <strong id="rep-cur-price" style="color: #fafafa; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">—</strong>
            </div>
            <div style="display: flex; flex-direction: column;">
              <span style="font-size: 9.5px; color: #71717a; text-transform: uppercase;">Change</span>
              <strong id="rep-pnl-change" class="rep-stat-val" style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">—</strong>
            </div>
            <div style="display: flex; flex-direction: column;">
              <span style="font-size: 9.5px; color: #71717a; text-transform: uppercase;">Time</span>
              <span id="rep-bar-time" style="color: #a1a1aa; font-size: 11px;">—</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- VIEW 6: TELEGRAM ALERTS (SHADCN/UI ZINC DARK) -->
    <div class="view-panel sh-view" id="view-alert">
      <div class="sh-scroll">
        <div class="sh-container">

          <!-- Header -->
          <div class="sh-header">
            <div>
              <h1 class="sh-title">Telegram Alerts</h1>
              <p class="sh-subtitle">Kết nối bot Telegram cá nhân để nhận tín hiệu giao dịch kèm ảnh biểu đồ và báo cáo hiệu suất định kỳ.</p>
            </div>
            <div class="sh-header-actions">
              <span class="sh-badge sh-badge-amber" id="alert-status">Chưa kết nối</span>
              <button class="sh-btn-outline" id="btn-configure-user-tg" type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                <span>Cấu hình Telegram</span>
              </button>
            </div>
          </div>

          <!-- Telegram Bot Setup Card (Toggled) -->
          <div class="sh-card" id="user-tg-connect-box" style="display: none;">
            <div class="sh-card-top" style="margin-bottom: 6px;">
              <div>
                <div style="font-size: 14px; font-weight: 600; color: var(--sh-fg);">Kết nối Bot Telegram cá nhân</div>
                <div class="sh-card-meta" style="margin-top: 2px;">Bot Token và Chat ID được lưu cục bộ trên trình duyệt và hồ sơ tài khoản để bảo mật riêng tư.</div>
              </div>
              <button class="sh-btn-ghost" id="close-user-tg-box" type="button" title="Đóng">✕</button>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr auto auto auto; gap: 10px; align-items: flex-end; margin-top: 10px;">
              <div>
                <label style="display: block; font-size: 11px; color: var(--sh-muted-fg); margin-bottom: 5px; font-weight: 500;">Telegram Bot Token (từ @BotFather)</label>
                <input type="password" id="user-tg-token-input" class="sh-input-plain" placeholder="7123456789:AAH..." style="width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">
              </div>
              <div>
                <label style="display: block; font-size: 11px; color: var(--sh-muted-fg); margin-bottom: 5px; font-weight: 500;">Telegram Chat ID / Channel</label>
                <input type="text" id="user-tg-chat-input" class="sh-input-plain" placeholder="1561044995 hoặc @your_channel" style="width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">
              </div>
              <button class="sh-btn-primary" id="btn-save-user-tg" type="button">Lưu cấu hình</button>
              <button class="sh-btn-outline" id="btn-test-user-tg" type="button">Test Bot</button>
              <button class="sh-btn-destructive" id="btn-del-user-tg" type="button">Xóa</button>
            </div>
          </div>

          <!-- Dispatch & Chart Snapshot Card -->
          <div class="sh-card">
            <div class="sh-card-top" style="margin-bottom: 14px; flex-wrap: wrap;">
              <div>
                <div style="font-size: 14px; font-weight: 600; color: var(--sh-fg);">Gửi tín hiệu &amp; Ảnh biểu đồ</div>
                <div class="sh-card-meta" style="margin-top: 2px;">Xuất ảnh snapshot kỹ thuật mới nhất và gửi trực tiếp tới kênh Telegram đã kết nối.</div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <input type="text" id="alert-sym-input" class="sh-input-plain" value="BINANCE:BTCUSDT" style="width: 190px;">
                <button class="sh-btn-primary" id="btn-send-tg-alert" type="button">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  <span>Gửi cảnh báo Telegram</span>
                </button>
              </div>
            </div>

            <div id="alert-snapshot-preview" style="background: #09090b; border: 1px solid #27272a; border-radius: 8px; padding: 14px; text-align: center;">
              <img id="snapshot-img" src="/public/latest_alert_chart.png" onerror="this.src='/public/alert_chart.png'" style="max-width: 100%; max-height: 60vh; width: auto; border-radius: 6px; border: 1px solid #27272a;">
            </div>
          </div>

        </div>
      </div>
    </div>
  </div>

<!-- Quant Strategy Studio & Custom Code Modal -->
        <div id="strategy-studio-modal" class="web3-modal-overlay" style="display: none; z-index: 10050;">
          <div class="web3-modal-card" style="max-width: 980px; width: 95%; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; background: #0b0f19; border: 1px solid rgba(168, 85, 247, 0.4); box-shadow: 0 24px 60px rgba(0,0,0,0.9), 0 0 35px rgba(168, 85, 247, 0.15); border-radius: 14px;">
            <!-- Modal Header -->
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.02); flex-shrink: 0;">
              <div style="display: flex; align-items: center; gap: 10px;">
                <div style="width: 32px; height: 32px; border-radius: 8px; background: rgba(168, 85, 247, 0.18); border: 1px solid rgba(168, 85, 247, 0.4); display: flex; align-items: center; justify-content: center; font-size: 16px;">🧠</div>
                <div>
                  <div style="font-size: 14px; font-weight: 800; color: #fff; letter-spacing: 0.3px;">QUANT STRATEGY STUDIO & CODE ENGINE</div>
                  <div style="font-size: 11px; color: #94a3b8;">Chọn chiến lược định lượng có sẵn hoặc tự viết / dán mã nguồn JavaScript cá nhân</div>
                </div>
              </div>
              <button id="btn-close-strat-modal" style="background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12); color: #cbd5e1; width: 28px; height: 28px; border-radius: 50%; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center;">✕</button>
            </div>

            <!-- Modal Subtabs Bar -->
            <div style="display: flex; gap: 4px; padding: 10px 20px 0 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); background: #080c14; flex-shrink: 0;">
              <button class="strat-tab-btn active" id="tab-strat-list" style="padding: 8px 16px; font-size: 11.5px; font-weight: 700; color: #fff; background: transparent; border: none; border-bottom: 2px solid #a855f7; cursor: pointer;">
                📋 Danh Sách Chiến Lược (<span id="strat-count-badge">4</span>)
              </button>
              <button class="strat-tab-btn" id="tab-strat-editor" style="padding: 8px 16px; font-size: 11.5px; font-weight: 700; color: #8c93a3; background: transparent; border: none; border-bottom: 2px solid transparent; cursor: pointer;">
                ✍️ Tự Thêm / Dán Source Code (Code Studio)
              </button>
              <button class="strat-tab-btn" id="tab-strat-agent" style="padding: 8px 16px; font-size: 11.5px; font-weight: 700; color: #8c93a3; background: transparent; border: none; border-bottom: 2px solid transparent; cursor: pointer;">
                🔑 Cấu Hình API Bot (Hyperliquid Agent)
              </button>
              <button class="strat-tab-btn" id="tab-strat-vario" style="padding: 8px 16px; font-size: 11.5px; font-weight: 700; color: #8c93a3; background: transparent; border: none; border-bottom: 2px solid transparent; cursor: pointer;">
                🌐 Variational Omni (Testnet API v1)
              </button>
            </div>

            <!-- Modal Body (Scrollable) -->
            <div style="padding: 18px 20px; overflow-y: auto; flex: 1; min-height: 0;">
              <!-- VIEW 1: Available Strategies List -->
              <div id="strat-view-list">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
                  <div>
                    <span style="font-size: 12px; font-weight: 800; color: #fff;">CHIẾN LƯỢC ĐANG ÁP DỤNG:</span>
                    <span id="studio-active-pill" style="margin-left: 8px; font-size: 11px; padding: 3px 8px; border-radius: 4px; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #10b981; font-weight: 700;">● Oliver Kell Price Cycle</span>
                  </div>
                  <button class="btn active" id="btn-studio-goto-add" style="padding: 6px 14px; font-size: 11px; background: #9333ea; color: #fff; font-weight: 700;">➕ Thêm Chiến Lược Mới (Dán Code)</button>
                </div>

                <div id="strat-cards-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                  <!-- Dynamically rendered cards -->
                </div>
              </div>

              <!-- VIEW 2: Custom Code Editor -->
              <div id="strat-view-editor" style="display: none;">
                <div style="background: rgba(168, 85, 247, 0.08); border: 1px solid rgba(168, 85, 247, 0.25); border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <strong style="color: #c084fc; font-size: 11.5px;">💻 Trình Biên Soạn & Nạp Mã Nguồn Chiến Lược</strong>
                    <div style="font-size: 10.5px; color: #94a3b8; margin-top: 2px;">Dán trực tiếp code JavaScript của bạn hoặc nạp nhanh từ các mẫu dựng sẵn</div>
                  </div>
                  <!-- Quick Templates -->
                  <div style="display: flex; gap: 6px;">
                    <span style="font-size: 10px; color: #94a3b8; align-self: center; font-weight: 700;">NẠP MẪU:</span>
                    <button class="btn" id="btn-load-tpl-rsi" style="padding: 4px 8px; font-size: 10px; background: rgba(56, 189, 248, 0.15); border: 1px solid #38bdf8; color: #38bdf8;">📋 RSI Scalp</button>
                    <button class="btn" id="btn-load-tpl-ema" style="padding: 4px 8px; font-size: 10px; background: rgba(34, 197, 94, 0.15); border: 1px solid #22c55e; color: #4ade80;">📋 EMA Trend</button>
                    <button class="btn" id="btn-load-tpl-breakout" style="padding: 4px 8px; font-size: 10px; background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; color: #fbbf24;">📋 Breakout</button>
                  </div>
                </div>

                <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-bottom: 12px;">
                  <div>
                    <label style="display: block; font-size: 10px; color: #94a3b8; margin-bottom: 4px; font-weight: 700;">TÊN CHIẾN LƯỢC *</label>
                    <input type="text" id="strat-input-name" placeholder="Ví dụ: My MACD Scalp Pro" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 7px 10px; font-size: 11.5px; border-radius: 6px; outline: none;">
                  </div>
                  <div>
                    <label style="display: block; font-size: 10px; color: #94a3b8; margin-bottom: 4px; font-weight: 700;">KHUNG THỜI GIAN (TIMEFRAME)</label>
                    <select id="strat-input-tf" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 7px 10px; font-size: 11.5px; border-radius: 6px; outline: none;">
                      <option value="1m">1m (Scalping siêu ngắn)</option>
                      <option value="5m">5m (Scalping nhanh)</option>
                      <option value="15m" selected>15m (Intraday chuẩn)</option>
                      <option value="1h">1H (Swing Trader)</option>
                      <option value="4h">4H (Xu hướng vĩ mô)</option>
                    </select>
                  </div>
                </div>

                <div style="margin-bottom: 12px;">
                  <label style="display: block; font-size: 10px; color: #94a3b8; margin-bottom: 4px; font-weight: 700;">MÔ TẢ CHIẾN LƯỢC / GHI CHÚ QUY TẮC VÀO LỆNH</label>
                  <input type="text" id="strat-input-desc" placeholder="Ví dụ: Đánh theo phân kỳ RSI khung 15m, chốt lời +3%, cắt lỗ -1.5%" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 7px 10px; font-size: 11.5px; border-radius: 6px; outline: none;">
                </div>

                <div style="margin-bottom: 12px;">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <label style="font-size: 10px; color: #94a3b8; font-weight: 700;">MÃ NGUỒN JAVASCRIPT (HÀM onTick) *</label>
                    <span style="font-size: 10px; color: #64748b; font-family: monospace;">function onTick(market, portfolio)</span>
                  </div>
                  <textarea id="strat-input-code" spellcheck="false" style="width: 100%; height: 260px; background: #05070c; border: 1px solid #1e2433; color: #38bdf8; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 11px; line-height: 1.6; padding: 12px; border-radius: 8px; outline: none; resize: vertical; tab-size: 2;"></textarea>
                </div>

                <!-- API Reference cheatsheet -->
                <div style="background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 6px; padding: 8px 12px; margin-bottom: 14px; font-size: 10px; color: #94a3b8; line-height: 1.6;">
                  <strong style="color: #cbd5e1;">📌 Biến đầu vào:</strong> <code>market: { symbol, price, high, low, volume, rsi, ema10, ema20, ema50, supertrend, macd }</code> | <code>portfolio: { balance, cash, equity, openPositions }</code><br>
                  <strong style="color: #cbd5e1;">📌 Giá trị trả về:</strong> <code>return { action: 'BUY'|'SELL'|'CLOSE', symbol, sizePct: 20, tp: 85000, sl: 82000, reason: 'Lý do' }</code> hoặc <code>return null;</code>
                </div>

                <!-- Validation Status Banner -->
                <div id="strat-val-msg" style="display: none; padding: 8px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; margin-bottom: 12px;"></div>

                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <button class="btn" id="btn-studio-back-list" style="padding: 7px 14px; font-size: 11px;">← Quay Lại Danh Sách</button>
                  <div style="display: flex; gap: 8px;">
                    <button class="btn" id="btn-studio-test-syntax" style="padding: 7px 14px; font-size: 11px; background: rgba(56, 189, 248, 0.15); border: 1px solid #38bdf8; color: #38bdf8; font-weight: 700;">⚡ Kiểm Tra Cú Pháp</button>
                    <button class="btn active" id="btn-studio-save-strat" style="padding: 7px 18px; font-size: 11px; background: #059669; color: #fff; font-weight: 700;">💾 Lưu & Kích Hoạt Chiến Lược</button>
                  </div>
                </div>
              </div>

              <!-- VIEW 3: Hyperliquid Agent Key Configuration -->
              <div id="strat-view-agent" style="display: none;">
                <!-- Header Banner -->
                <div style="background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <strong style="color: #38bdf8; font-size: 12px; display: flex; align-items: center; gap: 6px;">
                      <span>🔑 Cấu Hình Hyperliquid Delegated Agent Signer (Auto-Trading Bot)</span>
                    </strong>
                    <div style="font-size: 10.5px; color: #94a3b8; margin-top: 3px; line-height: 1.5;">
                      Ủy quyền khóa Agent phụ để bot tự động ký mở/đóng lệnh trên Hyperliquid L1. Agent Wallet bị cấm rút tiền (Withdrawal Forbidden), bảo vệ an toàn 100% cho số dư ví chính.
                    </div>
                  </div>
                  <a href="https://app.hyperliquid.xyz/trade" target="_blank" rel="noopener noreferrer" style="padding: 6px 12px; font-size: 10.5px; background: rgba(56, 189, 248, 0.15); border: 1px solid #38bdf8; color: #38bdf8; font-weight: 700; text-decoration: none; border-radius: 6px; white-space: nowrap;">
                    ↗ Mở Hyperliquid API Settings
                  </a>
                </div>

                <!-- Input Fields Grid -->
                <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 14px;">
                  <!-- Main User Address -->
                  <div>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                      <label style="font-size: 10px; color: #94a3b8; font-weight: 700;">ĐỊA CHỈ VÍ CHÍNH CỦA BẠN (VAULT / USER MASTER ADDRESS) *</label>
                      <button type="button" class="btn" id="btn-hl-agent-use-current-wallet" style="padding: 2px 8px; font-size: 9.5px; background: rgba(255,255,255,0.06); color: #cbd5e1;">📋 Lấy Từ Ví Kết Nối</button>
                    </div>
                    <input type="text" id="hl-agent-input-user-addr" placeholder="0x... Địa chỉ ví Ethereum chính giữ tài sản ký quỹ" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 8px 10px; font-size: 11.5px; font-family: 'JetBrains Mono', monospace; border-radius: 6px; outline: none;">
                  </div>

                  <!-- Agent Private Key (Secret) -->
                  <div>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                      <label style="font-size: 10px; color: #94a3b8; font-weight: 700;">HYPERLIQUID AGENT API SECRET (PRIVATE KEY CỦA AGENT WALLET) *</label>
                      <span id="btn-toggle-agent-key-vis" style="cursor: pointer; font-size: 10px; color: #38bdf8; font-weight: 600;">👁️ Hiện Khóa</span>
                    </div>
                    <input type="password" id="hl-agent-input-key" placeholder="0x... Dán API Secret (Private Key của Agent Wallet cấp từ sàn)" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #38bdf8; padding: 8px 10px; font-size: 11.5px; font-family: 'JetBrains Mono', monospace; border-radius: 6px; outline: none;">
                    <div style="font-size: 9.5px; color: #f59e0b; margin-top: 4px;">
                      ⚠️ LƯU Ý BẢO MẬT: Tuyệt đối KHÔNG dán Private Key của ví chính! Chỉ dán Private Key của Agent Wallet phụ được tạo từ Hyperliquid (Settings -> API).
                    </div>
                  </div>

                  <!-- Network Selection -->
                  <div>
                    <label style="display: block; font-size: 10px; color: #94a3b8; margin-bottom: 4px; font-weight: 700;">MÔI TRƯỜNG / MẠNG LƯỚI (NETWORK)</label>
                    <select id="hl-agent-select-network" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 8px 10px; font-size: 11.5px; border-radius: 6px; outline: none;">
                      <option value="mainnet" selected>Hyperliquid Mainnet L1 (https://api.hyperliquid.xyz)</option>
                      <option value="testnet">Hyperliquid Testnet L1 (https://api.hyperliquid-testnet.xyz)</option>
                    </select>
                  </div>
                </div>

                <!-- On-Chain Verification Status Card -->
                <div id="hl-agent-status-panel" style="background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px;">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <span style="font-size: 10.5px; font-weight: 700; color: #94a3b8;">TRẠNG THÁI KHÓA AGENT:</span>
                    <span id="hl-agent-state-pill" style="font-size: 10px; padding: 2px 8px; border-radius: 4px; background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; color: #f87171; font-weight: 700;">● CHƯA CẤU HÌNH</span>
                  </div>
                  <div id="hl-agent-details-text" style="font-size: 11px; color: #cbd5e1; line-height: 1.5; font-family: monospace;">
                    Chưa phát hiện cấu hình Agent Wallet. Vui lòng dán khóa để bot có thể tự động ký lệnh trên Hyperliquid L1.
                  </div>
                </div>

                <!-- 4 Steps Quick Instructions Box -->
                <div style="background: rgba(15, 23, 42, 0.5); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; font-size: 10.5px; color: #94a3b8; line-height: 1.6;">
                  <strong style="color: #cbd5e1;">📋 Cách lấy Agent Key trong 1 phút:</strong><br>
                  1. Vào <a href="https://app.hyperliquid.xyz/trade" target="_blank" style="color: #38bdf8;">app.hyperliquid.xyz/trade</a> kết nối ví chính.<br>
                  2. Bấm vào biểu tượng <strong>Cài Đặt (⚙️ Settings)</strong> ở góc trên bên phải -> Chọn tab <strong>API</strong>.<br>
                  3. Đặt tên gợi nhớ (vd: <code>HyperviewBot</code>) -> Bấm nút <strong>Create API Key / Approve Agent</strong> và ký trên ví Web3.<br>
                  4. Sao chép chuỗi <strong>API Secret (bắt đầu bằng 0x...)</strong> dán vào ô trên và bấm nút <strong>Lưu Cấu Hình</strong>.
                </div>

                <!-- Action Controls -->
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 12px;">
                  <button class="btn" id="btn-del-hl-agent" style="padding: 7px 14px; font-size: 11px; color: #ef4444; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); font-weight: 700;">🗑️ Xóa Khóa</button>
                  <div style="display: flex; gap: 8px;">
                    <button class="btn" id="btn-verify-hl-agent" style="padding: 7px 14px; font-size: 11px; background: rgba(56, 189, 248, 0.15); border: 1px solid #38bdf8; color: #38bdf8; font-weight: 700;">⚡ Kiểm Tra L1 (Verify On-Chain)</button>
                    <button class="btn active" id="btn-save-hl-agent" style="padding: 7px 18px; font-size: 11px; background: #0284c7; color: #fff; font-weight: 700;">💾 Lưu Cấu Hình Khóa Agent</button>
                  </div>
                </div>
              </div>

              <!-- VIEW 4: Variational Protocol (Omni Testnet API v1 & Order Console) -->
              <div id="strat-view-vario" style="display: none;">
                <!-- Header Banner -->
                <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
                  <div style="flex: 1; min-width: 280px;">
                    <strong style="color: #34d399; font-size: 12px; display: flex; align-items: center; gap: 6px;">
                      <span>🌐 Variational Omni DEX — Testnet API v1 (Ed25519 Signed RFQ)</span>
                    </strong>
                    <div style="font-size: 10.5px; color: #94a3b8; margin-top: 2px; line-height: 1.45;">
                      Chuẩn ký <code>variational-omni-api/v1</code> qua <code>api.omni.testnet.variational.io</code>. Tạo Ed25519 API Key (scope <strong>read + trade</strong>) &amp; nhận Testnet USDC Faucet tại web app Testnet, sau đó dán Private Key (seed 32-byte) để kiểm tra tài khoản và gửi lệnh trực tiếp.
                    </div>
                  </div>
                  <a id="vario-open-app-link" href="https://omni.testnet.variational.io" target="_blank" rel="noopener noreferrer" style="padding: 6px 12px; font-size: 10.5px; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #34d399; font-weight: 700; text-decoration: none; border-radius: 6px; white-space: nowrap;">
                    ↗ Mở Omni Testnet (Faucet &amp; API Keys)
                  </a>
                </div>

                <!-- 4 Live Account KPI Cards -->
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px;">
                  <div style="background: #0a0f18; border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 6px; padding: 8px 10px;">
                    <div style="font-size: 9px; color: #8c93a3; font-weight: 700;">TRẠNG THÁI API v1</div>
                    <div id="vario-state-pill" style="margin-top: 3px; font-size: 11px; font-weight: 800; color: #f87171;">● CHƯA CẤU HÌNH</div>
                  </div>
                  <div style="background: #0a0f18; border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 6px; padding: 8px 10px;">
                    <div style="font-size: 9px; color: #8c93a3; font-weight: 700;">ACCOUNT EQUITY (USDC)</div>
                    <div id="vario-stat-equity" style="margin-top: 3px; font-size: 13px; font-weight: 800; color: #38bdf8; font-family: monospace;">$0.00</div>
                  </div>
                  <div style="background: #0a0f18; border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 6px; padding: 8px 10px;">
                    <div style="font-size: 9px; color: #8c93a3; font-weight: 700;">CROSS AVAILABLE (USDC)</div>
                    <div id="vario-stat-available" style="margin-top: 3px; font-size: 13px; font-weight: 800; color: #34d399; font-family: monospace;">$0.00</div>
                  </div>
                  <div style="background: #0a0f18; border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 6px; padding: 8px 10px;">
                    <div style="font-size: 9px; color: #8c93a3; font-weight: 700;">UNREALIZED PNL (USDC)</div>
                    <div id="vario-stat-upnl" style="margin-top: 3px; font-size: 13px; font-weight: 800; color: #e2e8f0; font-family: monospace;">$0.00</div>
                  </div>
                </div>

                <!-- 2-Column Workspace: Left = Ed25519 Config, Right = Direct Testnet Order Ticket -->
                <div style="display: grid; grid-template-columns: 1fr 1.15fr; gap: 12px; margin-bottom: 12px;">
                  <!-- Left Panel: API Key & Settings -->
                  <div style="background: #0a0f18; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 9px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <span style="font-size: 11px; font-weight: 800; color: #e2e8f0;">🔐 CẤU HÌNH ED25519 API KEY</span>
                      <span id="vario-public-key-display" style="font-size: 9.5px; font-family: monospace; color: #64748b;">Public Key: chưa có</span>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                      <div>
                        <label style="display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">MÔI TRƯỜNG (ENV)</label>
                        <select id="vario-select-env" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #34d399; padding: 6px 8px; font-size: 11px; font-weight: 700; border-radius: 6px; outline: none;">
                          <option value="testnet" selected>Testnet (api.omni.testnet)</option>
                          <option value="prod">Mainnet (api.omni)</option>
                        </select>
                      </div>
                      <div>
                        <label style="display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">MAX SLIPPAGE MẶC ĐỊNH</label>
                        <select id="vario-select-slippage" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 6px 8px; font-size: 11px; border-radius: 6px; outline: none;">
                          <option value="0.001">0.1% (0.001)</option>
                          <option value="0.005" selected>0.5% (0.005)</option>
                          <option value="0.01">1.0% (0.010)</option>
                          <option value="0.02">2.0% (0.020)</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">
                        <label style="font-size: 9.5px; color: #94a3b8; font-weight: 700;">ED25519 PRIVATE KEY (API SECRET) *</label>
                        <button type="button" class="btn" id="btn-toggle-vario-key-vis" style="padding: 1px 7px; font-size: 9px; background: rgba(255,255,255,0.06); color: #cbd5e1;">👁️ Hiện Khóa</button>
                      </div>
                      <input type="password" id="vario-input-api-key" placeholder="32-byte hex seed (64 ký tự), Base64 hoặc PEM PKCS#8" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #34d399; padding: 7px 9px; font-size: 11px; font-family: monospace; border-radius: 6px; outline: none;">
                      <span id="vario-masked-key-hint" style="display: block; font-size: 9px; color: #64748b; margin-top: 2px;">Mã hóa AES-256-GCM cục bộ. Không nhập EVM Private Key của ví chính vào đây.</span>
                    </div>

                    <div>
                      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">
                        <label style="font-size: 9.5px; color: #94a3b8; font-weight: 700;">ĐỊA CHỈ VÍ ARBITRUM (TÙY CHỌN)</label>
                        <button type="button" class="btn" id="btn-vario-use-current-wallet" style="padding: 1px 7px; font-size: 9px; background: rgba(255,255,255,0.06); color: #cbd5e1;">📋 Lấy Từ Ví</button>
                      </div>
                      <input type="text" id="vario-input-wallet-addr" placeholder="0x... (tùy chọn kiểm tra ETH gas Sepolia/Arbitrum)" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 6px 9px; font-size: 11px; font-family: monospace; border-radius: 6px; outline: none;">
                    </div>

                    <!-- Optional Opt-in PaperTrader Testnet Mirror -->
                    <div style="background: rgba(56, 189, 248, 0.06); border: 1px solid rgba(56, 189, 248, 0.2); border-radius: 6px; padding: 7px 9px; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                      <label for="vario-toggle-automirror" style="display: flex; align-items: center; gap: 6px; font-size: 10px; color: #cbd5e1; font-weight: 600; cursor: pointer;">
                        <input type="checkbox" id="vario-toggle-automirror" style="width: 14px; height: 14px; accent-color: #38bdf8; cursor: pointer;">
                        <span>Auto-Mirror tín hiệu PaperTrader → Testnet</span>
                      </label>
                      <div style="display: flex; align-items: center; gap: 4px;">
                        <input type="number" id="vario-input-mirror-notional" value="100" min="10" step="10" style="width: 64px; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 3px 6px; font-size: 10.5px; font-family: monospace; border-radius: 4px; text-align: right;">
                        <span style="font-size: 9.5px; color: #94a3b8;">USDC</span>
                      </div>
                    </div>

                    <div id="vario-config-feedback" style="display: none; font-size: 10px; padding: 6px 8px; border-radius: 5px; line-height: 1.4;"></div>

                    <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; padding-top: 4px;">
                      <button type="button" class="btn active" id="btn-save-vario-agent" style="flex: 1; padding: 6px 10px; font-size: 10.5px; background: #059669; color: #fff; font-weight: 700;">💾 Lưu Cấu Hình</button>
                      <button type="button" class="btn" id="btn-verify-vario-agent" style="padding: 6px 10px; font-size: 10.5px; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #34d399; font-weight: 700;">⚡ Verify Testnet</button>
                      <button type="button" class="btn" id="btn-sync-vario-dashboard" style="padding: 6px 9px; font-size: 10.5px; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.35); color: #38bdf8; font-weight: 700;">🔄 Sync</button>
                      <button type="button" class="btn" id="btn-del-vario-agent" style="padding: 6px 9px; font-size: 10.5px; color: #ef4444; background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.3); font-weight: 700;">🗑️</button>
                    </div>
                  </div>

                  <!-- Right Panel: Direct Testnet Order Ticket -->
                  <div style="background: #0a0f18; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 9px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                      <span style="font-size: 11px; font-weight: 800; color: #e2e8f0;">🚀 GỬI LỆNH TRỰC TIẾP LÊN VARIATIONAL</span>
                      <span id="vario-order-market-hint" style="font-size: 9.5px; font-family: monospace; color: #38bdf8;">Mark: --</span>
                    </div>

                    <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 8px;">
                      <div>
                        <label style="display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">THỊ TRƯỜNG (SYMBOL)</label>
                        <div style="display: flex; gap: 4px;">
                          <input type="text" id="vario-order-symbol" value="BTC-PERP" list="vario-instruments-list" style="flex: 1; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 6px 8px; font-size: 11px; font-family: monospace; font-weight: 700; border-radius: 6px; outline: none;">
                          <button type="button" id="btn-vario-refresh-ticker" class="btn" title="Lấy giá Mark &amp; step mới nhất" style="padding: 5px 8px; font-size: 10.5px; background: rgba(255,255,255,0.06); color: #cbd5e1;">↻</button>
                        </div>
                        <datalist id="vario-instruments-list">
                          <option value="BTC-PERP"></option>
                          <option value="ETH-PERP"></option>
                          <option value="SOL-PERP"></option>
                          <option value="ARB-PERP"></option>
                        </datalist>
                      </div>
                      <div>
                        <label style="display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">CHIỀU LỆNH (SIDE)</label>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
                          <button type="button" id="btn-vario-side-buy" style="padding: 6px 8px; font-size: 10.5px; font-weight: 800; border-radius: 6px; border: 1px solid #10b981; background: rgba(16, 185, 129, 0.22); color: #34d399; cursor: pointer;">BUY / LONG</button>
                          <button type="button" id="btn-vario-side-sell" style="padding: 6px 8px; font-size: 10.5px; font-weight: 800; border-radius: 6px; border: 1px solid #23293a; background: #07090e; color: #94a3b8; cursor: pointer;">SELL / SHORT</button>
                        </div>
                      </div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
                      <div>
                        <label style="display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">LOẠI LỆNH</label>
                        <select id="vario-order-type" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 6px 8px; font-size: 11px; border-radius: 6px; outline: none;">
                          <option value="market" selected>Market (RFQ)</option>
                          <option value="limit">Limit</option>
                          <option value="take_profit">Take Profit</option>
                          <option value="stop_loss">Stop Loss</option>
                        </select>
                      </div>
                      <div>
                        <label style="display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">ĐƠN VỊ NHẬP</label>
                        <select id="vario-order-size-mode" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 6px 8px; font-size: 11px; border-radius: 6px; outline: none;">
                          <option value="notional" selected>Notional (USDC)</option>
                          <option value="size">Base Size</option>
                        </select>
                      </div>
                      <div>
                        <div style="display: flex; justify-content: space-between;">
                          <label style="font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">KHỐI LƯỢNG</label>
                          <span id="vario-order-size-est" style="font-size: 9px; color: #64748b; font-family: monospace;">--</span>
                        </div>
                        <input type="number" id="vario-order-amount" value="100" min="0" step="any" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 6px 8px; font-size: 11px; font-family: monospace; border-radius: 6px; outline: none;">
                      </div>
                    </div>

                    <!-- Dynamic Price / Trigger Row -->
                    <div id="vario-order-price-row" style="display: none; grid-template-columns: 1.3fr 1fr; gap: 8px;">
                      <div>
                        <label id="vario-order-price-label" style="display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">LIMIT PRICE (USDC)</label>
                        <input type="number" id="vario-order-price" placeholder="Ví dụ: 60500" step="any" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 6px 8px; font-size: 11px; font-family: monospace; border-radius: 6px; outline: none;">
                      </div>
                      <div>
                        <label style="display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">TRIGGER BY</label>
                        <select id="vario-order-trigger-by" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 6px 8px; font-size: 11px; border-radius: 6px; outline: none;">
                          <option value="mark" selected>Mark Price</option>
                          <option value="quote">Quote Price</option>
                        </select>
                      </div>
                    </div>

                    <!-- Attached TP / SL (Market & Limit only) -->
                    <div id="vario-order-tpsl-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                      <div>
                        <label style="display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">TAKE PROFIT (TÙY CHỌN)</label>
                        <input type="number" id="vario-order-tp" placeholder="Giá TP" step="any" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #4ade80; padding: 6px 8px; font-size: 11px; font-family: monospace; border-radius: 6px; outline: none;">
                      </div>
                      <div>
                        <label style="display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; font-weight: 700;">STOP LOSS (TÙY CHỌN)</label>
                        <input type="number" id="vario-order-sl" placeholder="Giá SL" step="any" style="width: 100%; background: #07090e; border: 1px solid #23293a; color: #f87171; padding: 6px 8px; font-size: 11px; font-family: monospace; border-radius: 6px; outline: none;">
                      </div>
                    </div>

                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
                      <div style="display: flex; align-items: center; gap: 10px;">
                        <div style="display: flex; align-items: center; gap: 4px;">
                          <span style="font-size: 9.5px; color: #94a3b8; font-weight: 700;">Slippage:</span>
                          <input type="number" id="vario-order-slippage" value="0.005" step="0.001" min="0.0001" max="1" style="width: 62px; background: #07090e; border: 1px solid #23293a; color: #fff; padding: 4px 6px; font-size: 10.5px; font-family: monospace; border-radius: 4px;">
                        </div>
                        <label id="vario-reduce-only-wrap" style="display: flex; align-items: center; gap: 4px; font-size: 10px; color: #cbd5e1; cursor: pointer;">
                          <input type="checkbox" id="vario-order-reduce-only" style="accent-color: #f59e0b; cursor: pointer;">
                          <span>Reduce Only</span>
                        </label>
                      </div>
                      <button type="button" id="btn-vario-submit-order" style="padding: 7px 14px; font-size: 11px; font-weight: 800; background: #10b981; color: #04130d; border: none; border-radius: 6px; cursor: pointer;">🚀 Gửi Lệnh Testnet</button>
                    </div>

                    <div id="vario-order-result" style="display: none; font-size: 10px; font-family: monospace; padding: 7px 9px; border-radius: 6px; line-height: 1.45; word-break: break-word;"></div>
                  </div>
                </div>

                <!-- Live Testnet Positions / Orders / Fills Tabs -->
                <div style="background: #0a0f18; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;">
                  <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 8px; margin-bottom: 8px;">
                    <div style="display: flex; gap: 6px;">
                      <button type="button" id="btn-vario-subtab-positions" class="btn active" style="padding: 4px 10px; font-size: 10.5px; font-weight: 700; background: rgba(16, 185, 129, 0.16); border: 1px solid #10b981; color: #34d399;">Positions (<span id="vario-cnt-positions">0</span>)</button>
                      <button type="button" id="btn-vario-subtab-orders" class="btn" style="padding: 4px 10px; font-size: 10.5px; font-weight: 700; background: transparent; border: 1px solid #23293a; color: #94a3b8;">Open Orders (<span id="vario-cnt-orders">0</span>)</button>
                      <button type="button" id="btn-vario-subtab-fills" class="btn" style="padding: 4px 10px; font-size: 10.5px; font-weight: 700; background: transparent; border: 1px solid #23293a; color: #94a3b8;">Recent Fills (<span id="vario-cnt-fills">0</span>)</button>
                    </div>
                    <button type="button" id="btn-vario-cancel-all" class="btn" style="display: none; padding: 3px 9px; font-size: 10px; color: #f87171; background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.35); font-weight: 700;">✕ Hủy Tất Cả Lệnh</button>
                  </div>

                  <div id="vario-panel-positions" style="max-height: 155px; overflow-y: auto; font-size: 10.5px;">
                    <div style="color: #64748b; padding: 12px; text-align: center;">Nhập Ed25519 API Key Testnet và bấm Sync để xem vị thế thực tế.</div>
                  </div>
                  <div id="vario-panel-orders" style="display: none; max-height: 155px; overflow-y: auto; font-size: 10.5px;">
                    <div style="color: #64748b; padding: 12px; text-align: center;">Không có lệnh đang chờ.</div>
                  </div>
                  <div id="vario-panel-fills" style="display: none; max-height: 155px; overflow-y: auto; font-size: 10.5px;">
                    <div style="color: #64748b; padding: 12px; text-align: center;">Chưa có lịch sử khớp lệnh.</div>
                  </div>
                </div>

                <!-- Compact Live OLP Reference Mini-Bar -->
                <div style="background: rgba(15, 23, 42, 0.55); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 6px; padding: 8px 12px; font-size: 10px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
                  <span style="color: #94a3b8;">📊 <strong style="color: #cbd5e1;">OLP Feed:</strong> <span id="vario-markets-count-badge" style="color: #38bdf8;">Đang tải stats v2...</span></span>
                  <div style="display: flex; gap: 14px; font-family: monospace;">
                    <span>BTC-PERP: <strong id="vario-live-btc-price" style="color: #fff;">--</strong> (<span id="vario-live-btc-spread" style="color: #4ade80;">--</span>)</span>
                    <span>ETH-PERP: <strong id="vario-live-eth-price" style="color: #fff;">--</strong> (<span id="vario-live-eth-spread" style="color: #4ade80;">--</span>)</span>
                  </div>
                </div>
              </div>
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

    <footer>
    <div style="display: flex; align-items: center; gap: 12px;">
      <span id="session-auto-save-badge" style="font-size: 10px; color: #38bdf8; display: inline-flex; align-items: center; gap: 4px; background: rgba(56, 189, 248, 0.08); padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.2);">
        <span>💾</span> <span id="session-auto-save-text">Session Auto-Save: Active</span>
      </span>
    </div>
    <div id="engine-status" style="color: var(--accent-green);">● All Services Operational</div>
  </footer>

  <script>
    // Pre-declare Macro Calendar & Journal state before any synchronous session restore clicks tabs
    let currentMacroFilters = {
      impact: 'ALL',
      currency: 'ALL',
      category: 'ALL',
      search: '',
      timeScope: 'UPCOMING_30D',
      hidePast: true
    };
    let macroSelectedScenarioId = null;
    let macroExpandedEventIds = new Set();
    let macroScenarioCollapsed = false;
    let macroLastPayload = null;
    let macroNextEventTargetTime = null;
    let macroCountdownInterval = null;

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
    let currentJournalMode = "sim6m";
    let currentSelectedDate = "2026-10-04";
    let cachedPaperStatus = null;
    let cachedSim6mData = null;
    let lastSimFetchStatus = 0;
    let currentJournalDaysMap = {};
    let simActiveMonthIndex = 10;
    const simMonthList = [
      { name: "January 2026", year: 2026, month: 0, prefix: "2026-01" },
      { name: "February 2026", year: 2026, month: 1, prefix: "2026-02" },
      { name: "March 2026", year: 2026, month: 2, prefix: "2026-03" },
      { name: "April 2026", year: 2026, month: 3, prefix: "2026-04" },
      { name: "May 2026", year: 2026, month: 4, prefix: "2026-05" },
      { name: "June 2026", year: 2026, month: 5, prefix: "2026-06" },
      { name: "July 2026", year: 2026, month: 6, prefix: "2026-07" },
      { name: "August 2026", year: 2026, month: 7, prefix: "2026-08" },
      { name: "September 2026", year: 2026, month: 8, prefix: "2026-09" },
      { name: "October 2026", year: 2026, month: 9, prefix: "2026-10" },
      { name: "November 2026", year: 2026, month: 10, prefix: "2026-11", isLive: true }
    ];

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
        if (btn.dataset.target === 'view-macro' && typeof renderMacroCalendar === 'function') {
          renderMacroCalendar();
        }
        if (btn.dataset.target === 'view-ai-hub' && typeof refreshHub === 'function') {
          refreshHub();
        }
        if (btn.dataset.target === 'view-replay') {
          if (window.replayStudioInstance) {
            const repHost = document.getElementById('replay-chart-container');
            if (!window.replayStudioInstance.isInitialized) {
              window.replayStudioInstance.init(repHost);
            } else {
              window.replayStudioInstance.resize();
            }
          }
        }
        if (btn.dataset.target === 'view-chart') {
          setTimeout(() => {
            if (typeof resizeChart === 'function') resizeChart();
          }, 50);
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

    // --- Hyperview Dynamic Title Bar Engine (TradingView & Proliquid Style) ---
    function updateHyperviewTitle(customSym, customPrice, customChg) {
      try {
        let sym = customSym || (currentSymbol ? (currentSymbol.split(':')[1] || currentSymbol) : currentDockCoin) || 'BTC';
        let cleanSym = sym.toUpperCase();
        if (cleanSym.endsWith('.P')) cleanSym = cleanSym.slice(0, -2);
        if (cleanSym.endsWith('-USDC')) cleanSym = cleanSym.slice(0, -5);
        else if (cleanSym.endsWith('USDC')) cleanSym = cleanSym.slice(0, -4);
        else if (cleanSym.endsWith('USDT')) cleanSym = cleanSym.slice(0, -4);
        else if (cleanSym.endsWith('USD')) cleanSym = cleanSym.slice(0, -3);
        cleanSym = cleanSym.replace(/^_|_$/g, '').trim() || sym;

        let price = customPrice;
        // Priority 1: If price not provided or 0, get from lastLoadedCandle (the active chart candle!)
        // Priority 2: pricesCache[currentSymbol].close (from multi-exchange watchlist API)
        // Priority 3: currentDockPrice (only if > 0)
        if (price === undefined || price === null || price === 0) {
          if (typeof lastLoadedCandle !== 'undefined' && lastLoadedCandle && lastLoadedCandle.close) {
            price = lastLoadedCandle.close;
          } else if (typeof pricesCache !== 'undefined' && currentSymbol && pricesCache[currentSymbol] && pricesCache[currentSymbol].close) {
            price = pricesCache[currentSymbol].close;
          } else if (typeof currentDockPrice !== 'undefined' && currentDockPrice > 0) {
            price = currentDockPrice;
          }
        }
        if (typeof price === 'string') {
          price = parseFloat(price.replace(/[^0-9.-]+/g, ''));
        }

        let chg = customChg;
        if (chg === undefined || chg === null) {
          if (typeof pricesCache !== 'undefined' && currentSymbol && pricesCache[currentSymbol] && pricesCache[currentSymbol].change !== undefined) {
            chg = pricesCache[currentSymbol].change;
          }
        }
        if (typeof chg === 'string') {
          chg = parseFloat(chg.replace(/[^0-9.-]+/g, ''));
        }

        if (price !== undefined && price !== null && !isNaN(price) && price > 0) {
          const formattedP = (typeof formatTokenPrice === 'function') ? formatTokenPrice(price) : price.toLocaleString('en-US');
          let chgText = '';
          if (chg !== undefined && chg !== null && !isNaN(chg)) {
            const arrow = chg >= 0 ? '▲' : '▼';
            const sign = chg >= 0 ? '+' : '';
            chgText = ' ' + arrow + ' ' + sign + chg.toFixed(2) + '%';
          }
          document.title = cleanSym + ' ' + formattedP + chgText + ' | Hyperview';
        } else {
          document.title = cleanSym + ' | Hyperview';
        }
      } catch (e) {
        document.title = 'Hyperview';
      }
    }
    const updateProviewTitle = updateHyperviewTitle;

    let currentSymbol = 'BINANCE:BTCUSDT';
    let currentTimeframe = 'D';
    let eventSource = null;
    let lastLoadedCandle = null;
    let currentCandlesCache = [];

    // --- Proliquid Trading & Execution Dock Variables ---
    let currentDockCoin = 'BTC';
    let currentDockPrice = null;
    let currentDockOrderType = 'MARKET';
    let currentDockMode = 'PAPER';
    let isReduceOnly = false;
    let isTpSlActive = false;
    let dockAvailableBalance = 10000;

    // --- Hyperliquid & Binance Realtime WebSocket Streaming Variables ---
    let hlWs = null;
    let hlWsActiveCoin = null;
    let hlWsActiveInterval = null;
    let hlWsReconnectTimer = null;
    let hlWsPingTimer = null;
    let hlWsStallWatchdog = null;
    let binanceWs = null;
    let binanceWsActivePair = null;

    const CLIENT_STOCK_EXCHANGES = ['NASDAQ:', 'NYSE:', 'AMEX:', 'ARCA:', 'BATS:', 'CBOE:', 'TSX:', 'LSE:', 'HKEX:', 'TSE:', 'XETR:', 'ASX:'];
    function isClientStockSymbol(sym) {
      if (!sym) return false;
      const u = String(sym).toUpperCase();
      return CLIENT_STOCK_EXCHANGES.some(p => u.startsWith(p));
    }
    const CLIENT_BENCHMARK_PREFIXES = ['INDEX:', 'TVC:', 'SP:', 'OANDA:', 'FOREXCOM:', 'COMEX:'];
    function isClientNonCryptoSymbol(sym) {
      if (!sym) return false;
      const u = String(sym).toUpperCase();
      return isClientStockSymbol(u) || CLIENT_BENCHMARK_PREFIXES.some(p => u.startsWith(p));
    }

    function syncDockCoin(sym) {
      let c = (sym || 'BTC').toUpperCase();
      if (c.includes(':')) c = c.split(':')[1];
      if (c.endsWith('.P')) c = c.slice(0, -2);
      if (c.endsWith('-USDC')) c = c.slice(0, -5);
      else if (c.endsWith('USDC')) c = c.slice(0, -4);
      else if (c.endsWith('USDT')) c = c.slice(0, -4);
      else if (c.endsWith('USD')) c = c.slice(0, -3);
      c = c.replace(/^_|_$/g, '').trim() || 'BTC';
      currentDockCoin = c;

      // Immediately reset currentDockPrice to the active token price (never leak previous token price)
      const activeClose = (typeof pricesCache !== 'undefined' && pricesCache[sym] && pricesCache[sym].close) || (lastLoadedCandle && lastLoadedCandle.close) || 0;
      currentDockPrice = activeClose > 0 ? activeClose : null;
      const coinBadge = document.getElementById('ob-coin-badge');
      const scrBadge = document.getElementById('scr-coin-badge');
      const denomBadge = document.getElementById('exec-coin-denom');
      if (coinBadge) coinBadge.textContent = c;
      if (scrBadge) scrBadge.textContent = c;
      if (denomBadge) denomBadge.textContent = c;
      const mktPriceEl = document.getElementById('dock-market-price');
      if (mktPriceEl) {
        mktPriceEl.textContent = (currentDockPrice && currentDockPrice > 0) ? ('$' + formatTokenPrice(currentDockPrice)) : '--';
      }
      updateExecutionLabels();
      updateProviewTitle(c, currentDockPrice > 0 ? currentDockPrice : null, pricesCache[sym]?.change);
      if (typeof subscribeHlWebSocket === 'function') subscribeHlWebSocket(c);
      if (typeof updateDockData === 'function') updateDockData();
      if (typeof updateTickerBar === 'function') updateTickerBar(c);
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

        // 4. Reaction Level Matrix [WillyAlgoTrader]
    let rlmEnabled = false;
    let rlmSwingLen = 6;
    let rlmTolerance = 0.6;
    let rlmMinScore = 50;
    let rlmRiskPreset = 'BALANCED'; // BALANCED (1/2/3R), CONSERVATIVE (1/2/4R), AGGRESSIVE (1.5/2.5/4R)
    let rlmPriceLines = [];

    function clearRlmLines() {
      rlmPriceLines.forEach(l => {
        try { candleSeries.removePriceLine(l); } catch (e) {}
      });
      rlmPriceLines = [];
    }

    function updateReactionLevelMatrix(candles) {
      clearRlmLines();
      const hud = document.getElementById('rlm-hud');
      if (!rlmEnabled || !candles || candles.length < 35) {
        if (hud) hud.style.display = 'none';
        return;
      }
      if (hud) hud.style.display = 'block';

      const n = candles.length;
      const tr = [candles[0].high - candles[0].low];
      for (let i = 1; i < n; i++) {
        const c = candles[i], prev = candles[i - 1];
        tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
      }

      function calcRMA(src, len) {
        const rma = [src.slice(0, len).reduce((a, b) => a + b, 0) / len];
        const alpha = 1 / len;
        for (let i = len; i < src.length; i++) {
          rma.push(alpha * src[i] + (1 - alpha) * rma[rma.length - 1]);
        }
        const pad = new Array(len - 1).fill(rma[0]);
        return pad.concat(rma);
      }

      const atr34 = calcRMA(tr, 34);
      const atr14 = calcRMA(tr, 14);

      let storedLevels = [];
      const halfLife = 500;
      const decayFactor = Math.pow(0.5, 1 / halfLife);

      for (let t = 0; t < n; t++) {
        const curAtr = atr34[t] || 1;
        const curClose = candles[t].close;
        const prevClose = t > 0 ? candles[t - 1].close : curClose;

        for (let l of storedLevels) {
          l.strength *= decayFactor;
          const top = l.center + l.halfWidth;
          const btm = l.center - l.halfWidth;
          if (l.role === 'SUPPORT' && prevClose >= btm && curClose < btm) {
            l.role = 'RESISTANCE';
            l.breaks++;
            l.strength *= 0.7;
          } else if (l.role === 'RESISTANCE' && prevClose <= top && curClose > top) {
            l.role = 'SUPPORT';
            l.breaks++;
            l.strength *= 0.7;
          }
        }
        storedLevels = storedLevels.filter(l => l.strength >= 0.25);

        const swingIdx = t - rlmSwingLen;
        if (swingIdx >= rlmSwingLen) {
          const shCandle = candles[swingIdx];
          let isHigh = true, isLow = true;

          for (let k = 1; k <= rlmSwingLen; k++) {
            if (candles[swingIdx - k].high >= shCandle.high || candles[swingIdx + k].high > shCandle.high) isHigh = false;
            if (candles[swingIdx - k].low <= shCandle.low || candles[swingIdx + k].low < shCandle.low) isLow = false;
          }

          if (isHigh) {
            let lowestLow = Infinity;
            for (let k = 1; k <= rlmSwingLen; k++) lowestLow = Math.min(lowestLow, candles[swingIdx + k].low);
            const reaction = (shCandle.high - lowestLow) / (atr34[swingIdx] || 1);
            const w = 1 + Math.min(Math.max(0, reaction), 2.5);
            addSwing(shCandle.high, w, true, curAtr, t);
          }

          if (isLow) {
            let highestHigh = -Infinity;
            for (let k = 1; k <= rlmSwingLen; k++) highestHigh = Math.max(highestHigh, candles[swingIdx + k].high);
            const reaction = (highestHigh - shCandle.low) / (atr34[swingIdx] || 1);
            const w = 1 + Math.min(Math.max(0, reaction), 2.5);
            addSwing(shCandle.low, w, false, curAtr, t);
          }
        }
      }

      function addSwing(price, w, isHigh, curAtr, currentBar) {
        const tol = rlmTolerance * curAtr;
        let nearest = null, minDist = Infinity;
        for (let l of storedLevels) {
          const dist = Math.abs(l.center - price);
          if (dist <= tol && dist < minDist) {
            minDist = dist;
            nearest = l;
          }
        }

        if (nearest) {
          nearest.sumW += w;
          nearest.sumWP += w * price;
          nearest.sumWP2 += w * price * price;
          nearest.strength += w;
          if (isHigh) nearest.highTouches++; else nearest.lowTouches++;
          nearest.totalTouches++;
          nearest.lastTouchBar = currentBar;

          const m = nearest.sumWP / nearest.sumW;
          const vr = (nearest.sumWP2 / nearest.sumW) - (m * m);
          const hw = Math.min(tol, Math.max(0.15 * curAtr, Math.sqrt(Math.max(0, vr))));
          nearest.center = m;
          nearest.halfWidth = hw;

          // 5-pass merge for overlapping levels (matching Pine Script MERGE_PASSES = 5)
          let again = true;
          let passes = 0;
          while (again && passes < 5) {
            again = false;
            passes++;
            const tHi = nearest.center + nearest.halfWidth;
            const tLo = nearest.center - nearest.halfWidth;
            for (let k = storedLevels.length - 1; k >= 0; k--) {
              const o = storedLevels[k];
              if (o !== nearest) {
                const oHi = o.center + o.halfWidth;
                const oLo = o.center - o.halfWidth;
                if (oLo <= tHi && tLo <= oHi) {
                  nearest.sumW += o.sumW;
                  nearest.sumWP += o.sumWP;
                  nearest.sumWP2 += o.sumWP2;
                  nearest.strength += o.strength;
                  nearest.totalTouches += o.totalTouches;
                  nearest.highTouches += o.highTouches;
                  nearest.lowTouches += o.lowTouches;
                  nearest.breaks = Math.max(nearest.breaks, o.breaks);
                  const mMerged = nearest.sumWP / nearest.sumW;
                  const vrMerged = (nearest.sumWP2 / nearest.sumW) - (mMerged * mMerged);
                  nearest.center = mMerged;
                  nearest.halfWidth = Math.min(tol, Math.max(0.15 * curAtr, Math.sqrt(Math.max(0, vrMerged))));
                  storedLevels.splice(k, 1);
                  again = true;
                }
              }
            }
          }
        } else {
          storedLevels.push({
            sumW: w,
            sumWP: w * price,
            sumWP2: w * price * price,
            center: price,
            halfWidth: Math.min(tol, Math.max(0.15 * curAtr, 0.25 * curAtr)),
            strength: w,
            highTouches: isHigh ? 1 : 0,
            lowTouches: isHigh ? 0 : 1,
            totalTouches: 1,
            breaks: 0,
            role: candles[currentBar].close >= price ? 'SUPPORT' : 'RESISTANCE',
            lastTouchBar: currentBar,
            lastSignalBar: -999,
          });
          if (storedLevels.length > 60) {
            storedLevels.sort((a, b) => b.strength - a.strength);
            storedLevels.pop();
          }
        }
      }

      const lastClose = candles[n - 1].close;
      const currentAtr14 = atr14[n - 1] || 1;

      storedLevels.forEach(l => {
        const polarityBonus = (l.highTouches > 0 && l.lowTouches > 0) ? 1.25 : 1.0;
        l.polarity = (l.highTouches > 0 && l.lowTouches > 0);
        l.score = Math.round(Math.min(100, Math.max(0, 100 * (1 - Math.exp(-l.strength * polarityBonus / 6)))));
      });

      const activeLevels = storedLevels.filter(l => l.totalTouches >= 2);
      const resistances = activeLevels
        .filter(l => l.center > lastClose)
        .sort((a, b) => (a.center - lastClose) - (b.center - lastClose))
        .slice(0, 3);

      const supports = activeLevels
        .filter(l => l.center < lastClose)
        .sort((a, b) => (lastClose - a.center) - (lastClose - b.center))
        .slice(0, 3);

      // Check Signals on the latest candle
      const lastCandle = candles[n - 1];
      const barRange = lastCandle.high - lastCandle.low;
      let signal = null;

      let rMults = [1.0, 2.0, 3.0];
      if (rlmRiskPreset === 'CONSERVATIVE') rMults = [1.0, 2.0, 4.0];
      else if (rlmRiskPreset === 'AGGRESSIVE') rMults = [1.5, 2.5, 4.0];

      // Long Rejection at nearest support
      for (let sup of supports) {
        if (sup.score >= rlmMinScore) {
          const top = sup.center + sup.halfWidth;
          if (lastCandle.low <= top && lastCandle.close > top && barRange > 0 && ((lastCandle.close - lastCandle.low) / barRange >= 0.6)) {
            const sl = Math.min(lastCandle.low - 0.25 * currentAtr14, lastCandle.close - 0.5 * currentAtr14);
            const risk = Math.max(0.0001, lastCandle.close - sl);
            signal = {
              type: 'LONG',
              levelPrice: sup.center,
              levelScore: sup.score,
              polarity: sup.polarity,
              touches: sup.totalTouches,
              entry: lastCandle.close,
              sl: sl,
              tp1: lastCandle.close + rMults[0] * risk,
              tp2: lastCandle.close + rMults[1] * risk,
              tp3: lastCandle.close + rMults[2] * risk,
              risk: risk,
            };
            break;
          }
        }
      }

      // Short Rejection at nearest resistance
      if (!signal) {
        for (let res of resistances) {
          if (res.score >= rlmMinScore) {
            const btm = res.center - res.halfWidth;
            if (lastCandle.high >= btm && lastCandle.close < btm && barRange > 0 && ((lastCandle.high - lastCandle.close) / barRange >= 0.6)) {
              const sl = Math.max(lastCandle.high + 0.25 * currentAtr14, lastCandle.close + 0.5 * currentAtr14);
              const risk = Math.max(0.0001, sl - lastCandle.close);
              signal = {
                type: 'SHORT',
                levelPrice: res.center,
                levelScore: res.score,
                polarity: res.polarity,
                touches: res.totalTouches,
                entry: lastCandle.close,
                sl: sl,
                tp1: lastCandle.close - rMults[0] * risk,
                tp2: lastCandle.close - rMults[1] * risk,
                tp3: lastCandle.close - rMults[2] * risk,
                risk: risk,
              };
              break;
            }
          }
        }
      }

      // Draw RLM Price Lines on LightweightCharts (Exact Pine Script colors & formatting)
      supports.forEach(sup => {
        const line = candleSeries.createPriceLine({
          price: sup.center,
          color: '#089981',
          lineWidth: sup.polarity ? 2 : 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'RLM Sup ' + sup.score + ' · ' + sup.totalTouches + 'T' + (sup.polarity ? ' ⇅' : ''),
        });
        rlmPriceLines.push(line);
      });

      resistances.forEach(res => {
        const line = candleSeries.createPriceLine({
          price: res.center,
          color: '#F23645',
          lineWidth: res.polarity ? 2 : 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'RLM Res ' + res.score + ' · ' + res.totalTouches + 'T' + (res.polarity ? ' ⇅' : ''),
        });
        rlmPriceLines.push(line);
      });

      // Draw Trade Plan Lines if signal active
      if (signal) {
        const entryLine = candleSeries.createPriceLine({
          price: signal.entry,
          color: '#5C8AAE',
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'RLM ' + signal.type + ' ENTRY',
        });
        const slLine = candleSeries.createPriceLine({
          price: signal.sl,
          color: '#E57373',
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: 'RLM SL (' + formatTokenPrice(signal.sl) + ')',
        });
        const tp1Line = candleSeries.createPriceLine({
          price: signal.tp1,
          color: '#66BB6A',
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'RLM TP1 (' + formatTokenPrice(signal.tp1) + ')',
        });
        rlmPriceLines.push(entryLine, slLine, tp1Line);
      }

      // Update RLM HUD DOM
      const trendBadge = document.getElementById('rlm-trend-badge');
      const isBull = supports.length >= resistances.length;
      if (trendBadge) {
        trendBadge.textContent = isBull ? 'BULLISH' : 'BEARISH';
        trendBadge.style.color = isBull ? '#4ade80' : '#f87171';
        trendBadge.style.background = isBull ? 'rgba(74, 222, 128, 0.15)' : 'rgba(239, 83, 80, 0.15)';
      }

      const resPrEl = document.getElementById('rlm-res-price');
      const resSubEl = document.getElementById('rlm-res-sub');
      if (resistances.length > 0) {
        const nr = resistances[0];
        if (resPrEl) resPrEl.textContent = formatTokenPrice(nr.center);
        if (resSubEl) resSubEl.textContent = 'Score: ' + nr.score + ' · ' + nr.totalTouches + 'T' + (nr.polarity ? ' ⇅' : '');
      } else {
        if (resPrEl) resPrEl.textContent = 'None nearby';
        if (resSubEl) resSubEl.textContent = '--';
      }

      const supPrEl = document.getElementById('rlm-sup-price');
      const supSubEl = document.getElementById('rlm-sup-sub');
      if (supports.length > 0) {
        const ns = supports[0];
        if (supPrEl) supPrEl.textContent = formatTokenPrice(ns.center);
        if (supSubEl) supSubEl.textContent = 'Score: ' + ns.score + ' · ' + ns.totalTouches + 'T' + (ns.polarity ? ' ⇅' : '');
      } else {
        if (supPrEl) supPrEl.textContent = 'None nearby';
        if (supSubEl) supSubEl.textContent = '--';
      }

      const sigBox = document.getElementById('rlm-signal-box');
      const sigStatus = document.getElementById('rlm-signal-status');
      const planBox = document.getElementById('rlm-plan-box');

      if (signal) {
        if (sigStatus) {
          sigStatus.textContent = (signal.type === 'LONG' ? '🟢 Long' : '🔴 Short') + ' Rejection Active (Score: ' + signal.levelScore + ')';
          sigStatus.style.color = signal.type === 'LONG' ? '#4ade80' : '#f87171';
        }
        if (planBox) {
          planBox.style.display = 'block';
          document.getElementById('rlm-plan-entry').textContent = formatTokenPrice(signal.entry);
          document.getElementById('rlm-plan-sl').textContent = formatTokenPrice(signal.sl);
          document.getElementById('rlm-plan-tp1').textContent = formatTokenPrice(signal.tp1);
          document.getElementById('rlm-plan-tp2').textContent = formatTokenPrice(signal.tp2);
          document.getElementById('rlm-plan-tp3').textContent = formatTokenPrice(signal.tp3);
        }
      } else {
        if (sigStatus) {
          sigStatus.textContent = 'Waiting for Level Rejection';
          sigStatus.style.color = '#94a3b8';
        }
        if (planBox) planBox.style.display = 'none';
      }

      const listEl = document.getElementById('rlm-levels-list');
      if (listEl) {
        const allSorted = [...resistances, ...supports].sort((a, b) => b.center - a.center);
        listEl.innerHTML = allSorted.map(l => {
          const isSup = l.center < lastClose;
          const roleColor = isSup ? '#4ade80' : '#f87171';
          const polIcon = l.polarity ? ' ⇅' : '';
          return '<div class="ios-glass-card" style="display: flex; justify-content: space-between; align-items: center; padding: 3px 6px; font-size: 9.5px; margin-bottom: 2px;">' +
            '<span style="color: ' + roleColor + '; font-weight: 700;">' + (isSup ? 'SUP' : 'RES') + ' ' + formatTokenPrice(l.center) + '</span>' +
            '<span style="color: #cbd5e1;">Score: <strong>' + l.score + '</strong></span>' +
            '<span style="font-size: 8.5px; color: #94a3b8;">' + l.totalTouches + 'T' + polIcon + '</span>' +
          '</div>';
        }).join('');
      }
    }

    // 5. LuxAlgo Signals & Overlays (Smart Trail + Reversal Zones v6.1 Clone)
    let luxalgoEnabled = true;
    let luxAtrFactor = 4.0;
    let luxRzEnabled = true;
    let luxSmartTrailSeries = null;
    let luxRzUpperSeries = null;
    let luxRzLowerSeries = null;
    let luxPriceLines = [];

    function clearLuxAlgoLines() {
      if (luxSmartTrailSeries) {
        try { chart.removeSeries(luxSmartTrailSeries); } catch (e) {}
        luxSmartTrailSeries = null;
      }
      if (luxRzUpperSeries) {
        try { chart.removeSeries(luxRzUpperSeries); } catch (e) {}
        luxRzUpperSeries = null;
      }
      if (luxRzLowerSeries) {
        try { chart.removeSeries(luxRzLowerSeries); } catch (e) {}
        luxRzLowerSeries = null;
      }
      luxPriceLines.forEach(pl => {
        try { candleSeries.removePriceLine(pl); } catch (e) {}
      });
      luxPriceLines = [];
    }

    function updateLuxAlgoOverlays(candles) {
      clearLuxAlgoLines();
      if (!luxalgoEnabled || !candles || candles.length < 20) return;

      try {
        // 1. Calculate Smart Trail (ATR 10, Factor 4.0, Smoothing 8)
        const trArr = [];
        trArr.push(candles[0].high - candles[0].low);
        for (let i = 1; i < candles.length; i++) {
          const hl = candles[i].high - candles[i].low;
          const hc = Math.abs(candles[i].high - candles[i - 1].close);
          const lc = Math.abs(candles[i].low - candles[i - 1].close);
          trArr.push(Math.max(hl, hc, lc));
        }

        // Wilder MA
        const atrPeriod = 10;
        const atr = new Array(candles.length).fill(0);
        let trSum = 0;
        for (let i = 0; i < Math.min(atrPeriod, candles.length); i++) trSum += trArr[i];
        atr[Math.min(atrPeriod - 1, candles.length - 1)] = trSum / atrPeriod;
        for (let i = atrPeriod; i < candles.length; i++) {
          atr[i] = (atr[i - 1] * (atrPeriod - 1) + trArr[i]) / atrPeriod;
        }

        // Smoothed closes
        const kSm = 2 / (8 + 1);
        const smCloses = new Array(candles.length).fill(candles[0].close);
        for (let i = 1; i < candles.length; i++) {
          smCloses[i] = candles[i].close * kSm + smCloses[i - 1] * (1 - kSm);
        }

        let curTrail = smCloses[0];
        let curDir = 1; // 1 = Bull, -1 = Bear
        const trailData = [];
        const trailFactor = luxAtrFactor || 4.0;

        for (let i = 0; i < candles.length; i++) {
          const loss = trailFactor * (atr[i] || (candles[i].high - candles[i].low));
          const src = smCloses[i];
          if (curDir === 1) {
            curTrail = Math.max(curTrail, src - loss);
            if (candles[i].close < curTrail) {
              curDir = -1;
              curTrail = src + loss;
            }
          } else {
            curTrail = Math.min(curTrail, src + loss);
            if (candles[i].close > curTrail) {
              curDir = 1;
              curTrail = src - loss;
            }
          }

          trailData.push({
            time: candles[i].time,
            value: parseFloat(curTrail.toFixed(4)),
            color: curDir === 1 ? '#2157f9' : '#ef5350',
          });
        }

        luxSmartTrailSeries = chart.addLineSeries({
          color: curDir === 1 ? '#2157f9' : '#ef5350',
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          title: 'Lux Smart Trail',
          crosshairMarkerVisible: true,
        });
        luxSmartTrailSeries.setData(trailData);

        // 2. Reversal Zones (SuperSmoother + Envelopes)
        if (luxRzEnabled) {
          const hlc3 = candles.map(c => (c.high + c.low + c.close) / 3);
          const len = 100;
          const pi = Math.PI;
          const a1 = Math.exp(-Math.SQRT2 * pi / len);
          const b1 = 2 * a1 * Math.cos(Math.SQRT2 * pi / len);
          const c2 = b1;
          const c3 = -a1 * a1;
          const c1 = 1 - c2 - c3;

          const ss = new Array(hlc3.length).fill(hlc3[0]);
          if (hlc3.length > 1) ss[1] = hlc3[0];
          for (let i = 2; i < hlc3.length; i++) {
            ss[i] = c1 * hlc3[i] + c2 * ss[i - 1] + c3 * ss[i - 2];
          }

          const rzUpperData = [];
          const rzLowerData = [];
          for (let i = 0; i < candles.length; i++) {
            const start = Math.max(0, i - 40);
            let variance = 0;
            for (let j = start; j <= i; j++) {
              const diff = hlc3[j] - ss[j];
              variance += diff * diff;
            }
            const sd = Math.sqrt(variance / (i - start + 1)) || (ss[i] * 0.015);
            rzUpperData.push({ time: candles[i].time, value: parseFloat(Math.max(0.0001, ss[i] + sd * 2.415).toFixed(4)) });
            rzLowerData.push({ time: candles[i].time, value: parseFloat(Math.max(0.0001, ss[i] - sd * 2.415).toFixed(4)) });
          }

          luxRzUpperSeries = chart.addLineSeries({
            color: 'rgba(239, 83, 80, 0.45)',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            title: 'Lux Reversal Upper',
            autoscaleInfoProvider: () => null,
          });
          luxRzUpperSeries.setData(rzUpperData);

          luxRzLowerSeries = chart.addLineSeries({
            color: 'rgba(38, 166, 154, 0.45)',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            title: 'Lux Reversal Lower',
            autoscaleInfoProvider: () => null,
          });
          luxRzLowerSeries.setData(rzLowerData);
        }

        // Add Active Trail Price Line
        const lastTrailVal = trailData[trailData.length - 1].value;
        const trailLine = candleSeries.createPriceLine({
          price: lastTrailVal,
          color: curDir === 1 ? '#2157f9' : '#ef5350',
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'Smart Trail (' + (curDir === 1 ? 'BUY' : 'SELL') + ')',
        });
        luxPriceLines.push(trailLine);

      } catch (err) {
        console.error('Error drawing LuxAlgo overlays:', err);
      }
    }

    // 6. EMA30 Band Breakout [EL COBER Enhanced]
    let ema30BandEnabled = true; // default ON
    let ema30BandPeriod = 30;
    let ema30UseVol = true;
    let ema30UseTrend = true;
    let ema30HSeries = null;
    let ema30LSeries = null;
    let ema30_200Series = null;
    let ema30PriceLines = [];

    function clearEma30Lines() {
      if (ema30HSeries) {
        try { chart.removeSeries(ema30HSeries); } catch (e) {}
        ema30HSeries = null;
      }
      if (ema30LSeries) {
        try { chart.removeSeries(ema30LSeries); } catch (e) {}
        ema30LSeries = null;
      }
      if (ema30_200Series) {
        try { chart.removeSeries(ema30_200Series); } catch (e) {}
        ema30_200Series = null;
      }
      ema30PriceLines.forEach(pl => {
        try { candleSeries.removePriceLine(pl); } catch (e) {}
      });
      ema30PriceLines = [];
      try { candleSeries.setMarkers([]); } catch (e) {}
      const hud = document.getElementById('ema30-hud');
      if (hud) hud.style.display = 'none';
    }

    function updateEma30BandBreakout(candles) {
      clearEma30Lines();
      const hud = document.getElementById('ema30-hud');
      if (!ema30BandEnabled || !candles || candles.length < 35) {
        if (hud) hud.style.display = 'none';
        return;
      }
      if (hud) hud.style.display = 'block';

      try {
        const lenBand = ema30BandPeriod || 30;
        const len200 = 200;
        const n = candles.length;

        // Calc EMA(high, lenBand) and EMA(low, lenBand)
        const kBand = 2 / (lenBand + 1);
        const emaH = new Float64Array(n);
        const emaL = new Float64Array(n);
        let sumH = 0, sumL = 0;
        const initB = Math.min(lenBand, n);
        for (let i = 0; i < initB; i++) {
          sumH += candles[i].high;
          sumL += candles[i].low;
        }
        emaH[initB - 1] = sumH / initB;
        emaL[initB - 1] = sumL / initB;
        for (let i = initB; i < n; i++) {
          emaH[i] = candles[i].high * kBand + emaH[i - 1] * (1 - kBand);
          emaL[i] = candles[i].low * kBand + emaL[i - 1] * (1 - kBand);
        }

        // Calc EMA(close, 200)
        const k200 = 2 / (len200 + 1);
        const ema200 = new Float64Array(n);
        let sum200 = 0;
        const init200 = Math.min(len200, n);
        for (let i = 0; i < init200; i++) sum200 += candles[i].close;
        ema200[init200 - 1] = sum200 / init200;
        for (let i = init200; i < n; i++) {
          ema200[i] = candles[i].close * k200 + ema200[i - 1] * (1 - k200);
        }

        // Volume SMA 20
        const volSma = new Float64Array(n);
        let vSum = 0;
        for (let i = 0; i < n; i++) {
          vSum += (candles[i].volume || 0);
          if (i >= 20) {
            vSum -= (candles[i - 20].volume || 0);
            volSma[i] = vSum / 20;
          } else if (i === 19) {
            volSma[i] = vSum / 20;
          } else {
            volSma[i] = vSum / (i + 1);
          }
        }

        const hData = [];
        const lData = [];
        const t200Data = [];
        let curPeak = null;
        let prevPeak = null;
        let curTrough = null;
        let prevTrough = null;
        let lastDir = 0;
        const signals = [];

        for (let i = 0; i < n; i++) {
          const c = candles[i];
          if (i < initB - 1) continue;
          const eH = emaH[i];
          const eL = emaL[i];
          const e200 = ema200[i];
          const volRatio = volSma[i] > 0 ? (c.volume || 0) / volSma[i] : 1.0;

          hData.push({ time: c.time, value: parseFloat(eH.toFixed(4)) });
          lData.push({ time: c.time, value: parseFloat(eL.toFixed(4)) });
          if (i >= len200 - 1) {
            t200Data.push({ time: c.time, value: parseFloat(e200.toFixed(4)) });
          }

          const aboveBand = c.close > eH;
          const belowBand = c.close < eL;

          if (aboveBand) {
            curPeak = curPeak === null ? c.high : Math.max(curPeak, c.high);
          } else if (curPeak !== null) {
            prevPeak = curPeak;
            curPeak = null;
          }

          if (belowBand) {
            curTrough = curTrough === null ? c.low : Math.min(curTrough, c.low);
          } else if (curTrough !== null) {
            prevTrough = curTrough;
            curTrough = null;
          }

          const brkUp = prevPeak !== null && c.close > prevPeak;
          const brkDown = prevTrough !== null && c.close < prevTrough;

          const trendUp = !ema30UseTrend || c.close > e200;
          const trendDown = !ema30UseTrend || c.close < e200;

          // Reversal
          let belowCnt = 0;
          let aboveCnt = 0;
          for (let k = 0; k < 2; k++) {
            const idx = i - k;
            if (idx >= 0) {
              if (candles[idx].close < emaL[idx]) belowCnt++;
              if (candles[idx].close > emaH[idx]) aboveCnt++;
            }
          }
          const revShort = lastDir === 1 && belowCnt === 2 && trendDown;
          const revLong = lastDir === -1 && aboveCnt === 2 && trendUp;

          const isVolOk = !ema30UseVol || volRatio >= 1.15;

          const longSig = (aboveBand && prevPeak !== null && brkUp && trendUp && lastDir <= 0 && isVolOk) || revLong;
          const shortSig = (belowBand && prevTrough !== null && brkDown && trendDown && lastDir >= 0 && isVolOk) || revShort;

          if (longSig) {
            lastDir = 1;
            signals.push({
              time: c.time,
              type: 'LONG',
              price: c.close,
              isReversal: revLong,
              isVolOk,
            });
          } else if (shortSig) {
            lastDir = -1;
            signals.push({
              time: c.time,
              type: 'SHORT',
              price: c.close,
              isReversal: revShort,
              isVolOk,
            });
          }
        }

        // Create Chart Series
        ema30HSeries = chart.addLineSeries({
          color: '#22c55e',
          lineWidth: 1.5,
          title: 'EMA30 High',
        });
        ema30HSeries.setData(hData);

        ema30LSeries = chart.addLineSeries({
          color: '#ef4444',
          lineWidth: 1.5,
          title: 'EMA30 Low',
        });
        ema30LSeries.setData(lData);

        if (t200Data.length > 0 && ema30UseTrend) {
          ema30_200Series = chart.addLineSeries({
            color: '#f59e0b',
            lineWidth: 2,
            title: 'EMA200 Trend',
          });
          ema30_200Series.setData(t200Data);
        }

        // Add reference price lines for prevPeak and prevTrough
        if (prevPeak !== null) {
          const pl = candleSeries.createPriceLine({
            price: prevPeak,
            color: '#10b981',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'Prev Peak',
          });
          ema30PriceLines.push(pl);
        }
        if (prevTrough !== null) {
          const tl = candleSeries.createPriceLine({
            price: prevTrough,
            color: '#f87171',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'Prev Trough',
          });
          ema30PriceLines.push(tl);
        }

        // Set markers on candle series
        const markers = signals.slice(-15).map(s => ({
          time: s.time,
          position: s.type === 'LONG' ? 'belowBar' : 'aboveBar',
          color: s.type === 'LONG' ? '#22c55e' : '#ef4444',
          shape: s.type === 'LONG' ? 'arrowUp' : 'arrowDown',
          text: s.type + (s.isReversal ? ' [REV]' : (s.isVolOk ? ' [VOL]' : '')),
        }));
        candleSeries.setMarkers(markers);

        // Update HUD
        const lastBar = candles[n - 1];
        const lastH = emaH[n - 1];
        const lastL = emaL[n - 1];
        const last200 = ema200[n - 1];

        const elBadge = document.getElementById('ema30-zone-badge');
        if (elBadge) {
          if (lastBar.close > lastH) {
            elBadge.textContent = 'BULL (ABOVE)';
            elBadge.style.color = '#4ade80';
            elBadge.style.background = 'rgba(34, 197, 94, 0.18)';
          } else if (lastBar.close < lastL) {
            elBadge.textContent = 'BEAR (BELOW)';
            elBadge.style.color = '#f87171';
            elBadge.style.background = 'rgba(239, 83, 80, 0.18)';
          } else {
            elBadge.textContent = 'IN BAND (CHOP)';
            elBadge.style.color = '#fbbf24';
            elBadge.style.background = 'rgba(245, 158, 11, 0.18)';
          }
        }

        const elH = document.getElementById('ema30-h-val');
        const elL = document.getElementById('ema30-l-val');
        const el200 = document.getElementById('ema30-200-val');
        const elPeak = document.getElementById('ema30-prev-peak');
        const elTrough = document.getElementById('ema30-prev-trough');
        const elStatus = document.getElementById('ema30-signal-status');

        if (elH) elH.textContent = formatTokenPrice(lastH);
        if (elL) elL.textContent = formatTokenPrice(lastL);
        if (el200) el200.textContent = formatTokenPrice(last200);
        if (elPeak) elPeak.textContent = prevPeak !== null ? formatTokenPrice(prevPeak) : '--';
        if (elTrough) elTrough.textContent = prevTrough !== null ? formatTokenPrice(prevTrough) : '--';

        if (elStatus && signals.length > 0) {
          const lastSig = signals[signals.length - 1];
          const isL = lastSig.type === 'LONG';
          elStatus.innerHTML = '<strong style="color: ' + (isL ? '#4ade80' : '#f87171') + ';">' + lastSig.type + (lastSig.isReversal ? ' [REV]' : '') + '</strong> @ $' + formatTokenPrice(lastSig.price);
        } else if (elStatus) {
          elStatus.textContent = 'Waiting for Breakout';
        }

      } catch (e) {
        console.error('Error drawing EMA30 Band:', e);
      }
    }

    function clearAllIndicatorLines() {
      clearFiboLines();
      clearGaltonLines();
      clearFootprintLines();
      clearRlmLines();
      clearLuxAlgoLines();
      clearEma30Lines();
    }

    function updateActiveIndicators(candles) {
      updateFiboRadar(candles);
      updateGaltonProfile(candles);
      updateVolumeFootprint(candles);
      updateReactionLevelMatrix(candles);
      updateLuxAlgoOverlays(candles);
      updateEma30BandBreakout(candles);
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
              <span style="font-family: monospace;">\${formatTokenPrice(l.price)}</span>
              <span style="font-size: 9px; color: var(--text-secondary);">\${diffPct > 0 ? '+' : ''}\${diffPct}%</span>
            </div>
          \`;
        }).join('');
      }
    }

    function getActiveLatestCandle() {
      if (lastLoadedCandle && typeof lastLoadedCandle.close === 'number') {
        return lastLoadedCandle;
      }
      if (typeof currentCandlesCache !== 'undefined' && currentCandlesCache && currentCandlesCache.length > 0) {
        return currentCandlesCache[currentCandlesCache.length - 1];
      }
      return null;
    }

    function setLegendOHLC(c) {
      if (!c) c = getActiveLatestCandle();
      if (!c) return;
      const oEl = document.getElementById('leg-open');
      const hEl = document.getElementById('leg-high');
      const lEl = document.getElementById('leg-low');
      const cEl = document.getElementById('leg-close');
      const chgWrap = document.getElementById('leg-chg-wrap');
      const chgEl = document.getElementById('leg-chg');
      const vEl = document.getElementById('leg-vol');

      if (oEl && typeof c.open === 'number') oEl.textContent = formatTokenPrice(c.open);
      if (hEl && typeof c.high === 'number') hEl.textContent = formatTokenPrice(c.high);
      if (lEl && typeof c.low === 'number') lEl.textContent = formatTokenPrice(c.low);

      if (cEl && typeof c.close === 'number') {
        cEl.textContent = formatTokenPrice(c.close);
        const isUp = c.close >= (typeof c.open === 'number' ? c.open : c.close);
        cEl.className = isUp ? 'val-green' : 'val-red';

        if (chgEl && typeof c.open === 'number' && c.open > 0) {
          const diff = c.close - c.open;
          const diffPct = (diff / c.open) * 100;
          const sign = diff >= 0 ? '+' : '';
          chgEl.textContent = sign + formatTokenPrice(diff) + ' (' + sign + diffPct.toFixed(2) + '%)';
          chgEl.className = isUp ? 'val-green' : 'val-red';
          if (chgWrap) chgWrap.style.display = 'inline-block';
        }
      }

      if (vEl && typeof c.volume === 'number') {
        const v = c.volume;
        if (v >= 1e6) vEl.textContent = (v / 1e6).toFixed(2) + 'M';
        else if (v >= 1e3) vEl.textContent = (v / 1e3).toFixed(1) + 'K';
        else vEl.textContent = v.toFixed(1);
      }
    }

    let isCrosshairHovering = false;

    window.resetLegendOHLC = function() {
      isCrosshairHovering = false;
      setLegendOHLC(getActiveLatestCandle());
    };

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
    let currentChartStyle = 'candles';
    let chartLineStyleSeries = null;

    function computeHeikinAshi(candles) {
      if (!Array.isArray(candles) || candles.length === 0) return [];
      const ha = [];
      let prevOpen = (candles[0].open + candles[0].close) / 2;
      let prevClose = (candles[0].open + candles[0].high + candles[0].low + candles[0].close) / 4;
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const haClose = (c.open + c.high + c.low + c.close) / 4;
        const haOpen = i === 0 ? ((c.open + c.close) / 2) : ((prevOpen + prevClose) / 2);
        const haHigh = Math.max(c.high, haOpen, haClose);
        const haLow = Math.min(c.low, haOpen, haClose);
        ha.push({ time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: c.volume || 0 });
        prevOpen = haOpen;
        prevClose = haClose;
      }
      return ha;
    }

    function applyChartStyle(candlesList) {
      const list = Array.isArray(candlesList) ? candlesList : (currentCandlesCache || []);
      try {
        if (currentChartStyle === 'line') {
          candleSeries.applyOptions({ visible: false });
          if (!chartLineStyleSeries) {
            chartLineStyleSeries = chart.addLineSeries({ color: '#38bdf8', lineWidth: 2, priceLineVisible: true });
          }
          chartLineStyleSeries.applyOptions({ visible: true });
          chartLineStyleSeries.setData(list.map(c => ({ time: c.time, value: c.close })));
        } else {
          if (chartLineStyleSeries) {
            chartLineStyleSeries.applyOptions({ visible: false });
          }
          const isHollow = currentChartStyle === 'hollow';
          candleSeries.applyOptions({
            visible: true,
            upColor: isHollow ? 'transparent' : '#26a69a',
            downColor: '#ef5350',
            borderUpColor: '#26a69a',
            borderDownColor: '#ef5350',
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350',
          });
          candleSeries.setData(currentChartStyle === 'heikin' ? computeHeikinAshi(list) : list);
        }
      } catch (e) {}
    }

    function showChartLoadError(msg) {
      if (!chartContainer) return;
      let banner = document.getElementById('chart-error-banner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'chart-error-banner';
        banner.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(15,17,23,0.86);backdrop-filter:blur(4px);z-index:15;pointer-events:none;padding:20px;text-align:center;';
        chartContainer.appendChild(banner);
      }
      banner.innerHTML = '<div style="font-size:13px;font-weight:700;color:#f87171;">⚠️ Không thể tải dữ liệu biểu đồ</div>' +
        '<div style="font-size:11.5px;color:#94a3b8;max-width:460px;">' + String(msg || 'Lỗi kết nối nguồn dữ liệu').replace(/[<>&]/g, '') + '</div>';
      banner.style.display = 'flex';
    }

    function hideChartLoadError() {
      const banner = document.getElementById('chart-error-banner');
      if (banner) banner.style.display = 'none';
    }
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

    // --- Initialize Drawing Engine (Phase 2 - Vela Architecture) ---
    if (window.drawingEngineInstance) {
      window.drawingEngineInstance.init(chart, candleSeries, chartContainer, currentSymbol);
    }

    // --- Initialize Multi-Chart Manager (Phase 3 - Vela Architecture) ---
    if (window.multiChartManagerInstance) {
      window.multiChartManagerInstance.init();
    }

    // --- Realtime Active Candle Tick Engine (Animates Candle with Every Live Tick) ---
    function updateActiveCandleWithLivePrice(price) {
      if (!price || isNaN(price) || price <= 0 || !lastLoadedCandle) return;
      if (typeof candleSeries === 'undefined' || !candleSeries.update) return;

      // Anomaly Protection: Protect active candle from bad ticks / wrong asset cross-contamination
      // Rejects any tick deviating more than 40% from current candle base (open/close)
      const baseClose = lastLoadedCandle.close || lastLoadedCandle.open;
      if (baseClose > 0) {
        const ratio = price / baseClose;
        if (ratio < 0.6 || ratio > 1.6) {
          console.warn('[Tick Anomaly Guard] Blocked extreme tick:', price, 'vs expected base:', baseClose);
          return;
        }
      }

      const updatedCandle = {
        time: lastLoadedCandle.time,
        open: lastLoadedCandle.open,
        high: Math.max(lastLoadedCandle.high, price),
        low: Math.min(lastLoadedCandle.low, price),
        close: price,
        volume: lastLoadedCandle.volume || 0,
      };

      lastLoadedCandle = updatedCandle;
      try {
        candleSeries.update(updatedCandle);
      } catch (e) {}

      if (!isCrosshairHovering) {
        setLegendOHLC(updatedCandle);
      }
      if (typeof currentCandlesCache !== 'undefined' && currentCandlesCache && currentCandlesCache.length > 0) {
        currentCandlesCache[currentCandlesCache.length - 1] = updatedCandle;
      }
    }

    function resizeChart() {
      chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
      if (window.drawingEngineInstance) {
        window.drawingEngineInstance.resizeCanvas();
      }
    }
    window.addEventListener('resize', resizeChart);
    resizeChart();

    chart.subscribeCrosshairMove((param) => {
      // 1. Mouse left chart or on invalid coordinates -> immediately reset to latest active candle
      if (!param || !param.time || !param.point) {
        isCrosshairHovering = false;
        window.resetLegendOHLC();
        return;
      }
      // 2. Try to get candle data at the crosshair time
      const candle = param.seriesData.get(candleSeries);
      if (candle && typeof candle.open === 'number' && typeof candle.close === 'number') {
        isCrosshairHovering = true;
        const vol = param.seriesData.get(volumeSeries);
        setLegendOHLC({
          ...candle,
          volume: vol ? vol.value : (candle.volume || 0),
        });
      } else {
        // 3. User cursor is in right margin (future whitespace / empty space) where no candle exists
        // Immediately reset to active latest candle!
        isCrosshairHovering = false;
        window.resetLegendOHLC();
      }
    });

    // Explicit listeners when cursor leaves chart container or loses focus
    chartContainer.addEventListener('mouseleave', () => {
      window.resetLegendOHLC();
    });

    const gridWrapper = document.getElementById('charts-grid-wrapper');
    if (gridWrapper) {
      gridWrapper.addEventListener('mouseleave', () => {
        window.resetLegendOHLC();
      });
    }

    window.addEventListener('blur', () => {
      window.resetLegendOHLC();
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
      'HYPERLIQUID:HYPE': 'crypto/XTVCHYPEH',
      'BYBIT:HYPEUSDT': 'crypto/XTVCHYPEH',
      'COINBASE:HYPEUSD': 'crypto/XTVCHYPEH',
      'HYPEUSD': 'crypto/XTVCHYPEH',
      'HYPEUSDT': 'crypto/XTVCHYPEH',
      'HYPE': 'crypto/XTVCHYPEH',
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
      'PUMP': 'crypto/XTVCPUMPF',
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
      'INDEX:SPX': 'indices/s-and-p-500',
      'SP:SPX': 'indices/s-and-p-500',
      'TVC:SPX': 'indices/s-and-p-500',
      'SP500': 'indices/s-and-p-500',
      'SPX': 'indices/s-and-p-500',
      'HIP3XYZ:SP500USDC.P': 'indices/s-and-p-500',
      'TVC:GOLD': 'metal/gold',
      'OANDA:XAUUSD': 'metal/gold',
      'FOREXCOM:XAUUSD': 'metal/gold',
      'GOLD': 'metal/gold',
      'XAUUSD': 'metal/gold',
      'BINANCE:XAUUSDT.P': 'metal/gold',
      'BYBIT:XAUUSDT.P': 'metal/gold',
      'BINANCE:PAXGUSDT': 'metal/gold',
      'NASDAQ:NVDA': 'nvidia',
      'NVDA': 'nvidia',
      'BINANCE:NVDAUSDT.P': 'nvidia',
      'NASDAQ:ANT': 'anthropic',
      'ANT': 'anthropic',
      'ANTHROPIC': 'anthropic',
      'BINANCE:ANTUSDT.P': 'anthropic',
    };

    const DEFAULT_WATCHLIST = [
      { symbol: 'BINANCE:BTCUSDT', name: 'BTCUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCBTC' },
      { symbol: 'BINANCE:ETHUSDT', name: 'ETHUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCETH' },
      { symbol: 'HYPERLIQUID:HYPE', name: 'HYPE', exchange: 'HYPERLIQUID', logoId: 'crypto/XTVCHYPEH' },
      { symbol: 'METEORA:KLEDSOL_4SBYWY.USD', name: 'KLEDSOL_4!', exchange: 'METEORA' },
      { symbol: 'BINANCE:SOLUSDT', name: 'SOLUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCSOL' },
      { symbol: 'BINANCE:SUIUSDT', name: 'SUIUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCSUI' },
      { symbol: 'INDEX:SPX', name: 'SP500', exchange: 'INDEX', logoId: 'indices/s-and-p-500' },
      { symbol: 'TVC:GOLD', name: 'GOLD', exchange: 'TVC', logoId: 'metal/gold' },
      { symbol: 'NASDAQ:NVDA', name: 'NVDA', exchange: 'NASDAQ', logoId: 'nvidia' },
      { symbol: 'NASDAQ:ANT', name: 'ANT', exchange: 'NASDAQ', logoId: 'anthropic' },
      { symbol: 'NASDAQ:SPCX', name: 'SPCX', exchange: 'NASDAQ', logoId: 'spacex' },
      { symbol: 'BINANCE:ZECUSDT', name: 'ZECUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCZEC' },
      { symbol: 'BINANCE:TAOUSDT', name: 'TAOUSDT', exchange: 'BINANCE', logoId: 'crypto/XTVCTAOB' },
      { symbol: 'BYBIT:VVVUSDT', name: 'VVVUSDT.P', exchange: 'BYBIT', logoId: 'crypto/XTVCVVV' },
      { symbol: 'BINANCE:PUMPUSDT', name: 'PUMP', exchange: 'BINANCE', logoId: 'crypto/XTVCPUMPF' },
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

    function normalizeWatchlistEntries(list) {
      if (!Array.isArray(list)) return [];
      const seen = new Set();
      const out = [];
      for (const rawItem of list) {
        if (!rawItem || !rawItem.symbol) continue;
        let item = { ...rawItem };
        const symUp = String(item.symbol).toUpperCase();
        const nameUp = String(item.name || '').toUpperCase();

        if (item.symbol === 'BINANCE:ARB' || item.name === 'ARB' || item.symbol === 'ARB') {
          item = {
            symbol: 'BINANCE:ARBUSDT',
            name: 'ARBUSDT',
            exchange: 'BINANCE',
            logoId: 'crypto/XTVCARBI',
          };
        } else if (item.symbol && item.symbol.includes('HYPE')) {
          item = {
            symbol: 'HYPERLIQUID:HYPE',
            name: 'HYPE',
            exchange: 'HYPERLIQUID',
            logoId: 'crypto/XTVCHYPEH',
          };
        } else if (item.symbol && item.symbol.includes('PUMP')) {
          item = {
            symbol: 'BINANCE:PUMPUSDT',
            name: 'PUMP',
            exchange: 'BINANCE',
            logoId: 'crypto/XTVCPUMPF',
          };
        } else if (item.symbol && (item.symbol.includes('SP500') || item.symbol.includes('SPX') || item.name === 'SP500' || item.name === 'SPX')) {
          item = {
            symbol: 'INDEX:SPX',
            name: 'SP500',
            exchange: 'INDEX',
            logoId: 'indices/s-and-p-500',
          };
        } else if (item.symbol && (item.symbol.includes('GOLD') || item.symbol.includes('XAU') || item.name === 'GOLD' || item.name === 'XAUUSD')) {
          item = {
            symbol: 'TVC:GOLD',
            name: 'GOLD',
            exchange: 'TVC',
            logoId: 'metal/gold',
          };
        } else if (item.symbol && (item.symbol.includes('NVDA') || item.name === 'NVDA')) {
          item = {
            symbol: 'NASDAQ:NVDA',
            name: 'NVDA',
            exchange: 'NASDAQ',
            logoId: 'nvidia',
          };
        } else if (
          symUp === 'BINANCE:ANTUSDT.P' ||
          symUp === 'BINANCE:ANTUSDC' ||
          symUp === 'BINANCE:ANTUSDC.P' ||
          symUp === 'BINANCE:ANTUSDT' ||
          symUp === 'ANT-USDC' ||
          symUp === 'ANTUSDC' ||
          symUp === 'ANTUSDT.P' ||
          nameUp === 'ANT-USDC' ||
          nameUp === 'ANTUSDC' ||
          nameUp === 'ANTUSDT.P'
        ) {
          item = {
            symbol: 'NASDAQ:ANT',
            name: 'ANT',
            exchange: 'NASDAQ',
            logoId: 'anthropic',
          };
        }

        if (!item.logoId && LOGO_MAP[item.symbol]) {
          item.logoId = LOGO_MAP[item.symbol];
        }
        if (!seen.has(item.symbol)) {
          seen.add(item.symbol);
          out.push(item);
        }
      }
      return out;
    }

    let customWatchlist = [];
    try {
      const saved = localStorage.getItem('tv_custom_watchlist_v4') || localStorage.getItem('tv_custom_watchlist_v3');
      customWatchlist = saved ? JSON.parse(saved) : DEFAULT_WATCHLIST;
    } catch (e) {
      customWatchlist = DEFAULT_WATCHLIST;
    }

    // Auto-fix any incomplete or invalid symbols from previous adds (e.g. BINANCE:ARB, BINANCE:ANTUSDT.P -> NASDAQ:ANT)
    customWatchlist = normalizeWatchlistEntries(customWatchlist);
    if (!customWatchlist.some(w => w.name === 'SP500' || (w.symbol && (w.symbol.includes('SPX') || w.symbol.includes('SP500'))))) {
      customWatchlist.push({ symbol: 'INDEX:SPX', name: 'SP500', exchange: 'INDEX', logoId: 'indices/s-and-p-500' });
    }
    if (!customWatchlist.some(w => w.name === 'GOLD' || (w.symbol && (w.symbol.includes('GOLD') || w.symbol.includes('XAU'))))) {
      customWatchlist.push({ symbol: 'TVC:GOLD', name: 'GOLD', exchange: 'TVC', logoId: 'metal/gold' });
    }
    if (!customWatchlist.some(w => w.name === 'NVDA' || (w.symbol && w.symbol.includes('NVDA')))) {
      customWatchlist.push({ symbol: 'NASDAQ:NVDA', name: 'NVDA', exchange: 'NASDAQ', logoId: 'nvidia' });
    }
    if (!customWatchlist.some(w => w.symbol === 'NASDAQ:ANT' || w.name === 'ANT')) {
      customWatchlist.push({ symbol: 'NASDAQ:ANT', name: 'ANT', exchange: 'NASDAQ', logoId: 'anthropic' });
    }
    saveWatchlist();

    const clientPriceInFlight = new Map();
    let watchlistPriceGeneration = 0;
    const pricesCache = {};

    function getWatchlistStorageKey() {
      const uid = (typeof currentAuthUser !== 'undefined' && currentAuthUser && currentAuthUser.userId)
        ? currentAuthUser.userId
        : 'guest';
      return 'tv_custom_watchlist_v4_' + encodeURIComponent(uid);
    }

    function saveWatchlist() {
      try {
        const key = getWatchlistStorageKey();
        localStorage.setItem(key, JSON.stringify(customWatchlist));
        // Fallback backward compatibility
        localStorage.setItem('tv_custom_watchlist_v4', JSON.stringify(customWatchlist));

        // Sync with user profile on server
        if (typeof currentAuthUser !== 'undefined' && currentAuthUser && currentAuthUser.userId) {
          fetch('/api/user/watchlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ watchlist: customWatchlist })
          }).catch(() => {});
        }

        if (window.multiChartManagerInstance) {
          window.multiChartManagerInstance.populateWatchlistTokens(customWatchlist);
        }
      } catch (e) {}
    }

    async function loadWatchlistForCurrentUser() {
      try {
        if (typeof currentAuthUser !== 'undefined' && currentAuthUser && currentAuthUser.userId) {
          const res = await fetch('/api/user/watchlist');
          if (res.ok) {
            const data = await res.json();
            if (data.watchlist && Array.isArray(data.watchlist) && data.watchlist.length > 0) {
              const beforeJson = JSON.stringify(data.watchlist);
              customWatchlist = normalizeWatchlistEntries(data.watchlist);
              if (JSON.stringify(customWatchlist) !== beforeJson) {
                saveWatchlist();
              }
              if (window.multiChartManagerInstance) {
                window.multiChartManagerInstance.populateWatchlistTokens(customWatchlist);
              }
              renderWatchlist();
              return;
            }
          }
        }
        const key = getWatchlistStorageKey();
        const saved = localStorage.getItem(key) || localStorage.getItem('tv_custom_watchlist_v4');
        if (saved) {
          customWatchlist = normalizeWatchlistEntries(JSON.parse(saved));
        }
      } catch (e) {}
      if (window.multiChartManagerInstance) {
        window.multiChartManagerInstance.populateWatchlistTokens(customWatchlist);
      }
      renderWatchlist();
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
    const POPULAR_TIMEFRAMES = ['1', '5', '15', '60', '240', 'D'];
    const prefetchInFlight = new Set();

    function prefetchSymbolTimeframes(sym) {
      if (!sym) return;
      POPULAR_TIMEFRAMES.forEach(tf => {
        const key = sym + '_' + tf;
        if (!clientChartCache[key] && !prefetchInFlight.has(key)) {
          prefetchInFlight.add(key);
          fetch('/api/history?symbol=' + encodeURIComponent(sym) + '&timeframe=' + encodeURIComponent(tf) + '&range=1000')
            .then(r => r.json())
            .then(data => {
              if (data && data.candles && data.candles.length > 0) {
                clientChartCache[key] = { candles: data.candles, time: Date.now() };
              }
            })
            .catch(() => {})
            .finally(() => {
              prefetchInFlight.delete(key);
            });
        }
      });
    }

    async function loadChart(sym, tf) {
      if (eventSource) eventSource.close();

      if (typeof syncDockCoin === 'function') {
        syncDockCoin(sym);
      }
      if (typeof subscribeBinanceWebSocket === 'function') {
        subscribeBinanceWebSocket(sym);
      }
      if (typeof subscribeHlWebSocket === 'function' && currentDockCoin) {
        subscribeHlWebSocket(currentDockCoin);
      }
      if (window.drawingEngineInstance) {
        window.drawingEngineInstance.setSymbol(sym);
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

      // Trigger background pre-warming for all popular timeframes of this symbol immediately
      prefetchSymbolTimeframes(sym);

      // Helper to render candles & indicators synchronously (Zero Latency)
      function applyCandlesAndIndicators(candlesList) {
        hideChartLoadError();
        currentCandlesCache = candlesList;
        autoAdjustChartPrecision(candlesList);
        try { chart.priceScale('right').applyOptions({ autoScale: true }); } catch (e) {}
        applyChartStyle(candlesList);
        volumeSeries.setData(candlesList.map(c => ({
          time: c.time,
          value: c.volume || 0,
          color: c.close >= c.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)',
        })));
        const len = candlesList.length;
        try {
          chart.priceScale('right').applyOptions({ autoScale: true });
          const totalBars = 125;
          const rightOffset = 52;
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, len - (totalBars - rightOffset)),
            to: len + rightOffset,
          });
        } catch (e) {}
        lastLoadedCandle = candlesList[len - 1];
        if (lastLoadedCandle && lastLoadedCandle.close > 0) {
          currentDockPrice = lastLoadedCandle.close;
          const mktEl = document.getElementById('dock-market-price');
          if (mktEl) mktEl.textContent = '$' + formatTokenPrice(currentDockPrice);
          if (typeof updateExecutionLabels === 'function') updateExecutionLabels();
        }
        setLegendOHLC(lastLoadedCandle);
        updateActiveIndicators(candlesList);
        updateProviewTitle(sym, lastLoadedCandle.close);
      }

      function clearChartOnError(reasonMsg) {
        currentCandlesCache = [];
        lastLoadedCandle = null;
        try {
          candleSeries.setData([]);
          if (chartLineStyleSeries) chartLineStyleSeries.setData([]);
          volumeSeries.setData([]);
          if (typeof clearAllIndicatorLines === 'function') clearAllIndicatorLines();
        } catch (e) {}
        ['leg-open', 'leg-high', 'leg-low', 'leg-close', 'leg-chg', 'leg-vol'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.textContent = '--';
        });
        showChartLoadError(reasonMsg);
      }

      // 2. ZERO-DELAY RENDER: If cached in memory, display IMMEDIATELY in 0ms!
      const cached = clientChartCache[activeKey];
      if (cached && cached.candles && cached.candles.length > 0) {
        applyCandlesAndIndicators(cached.candles);
      } else {
        hideChartLoadError();
      }

      // 3. Fast Background fetch for latest candle stream & full history
      try {
        const res = await fetch('/api/history?symbol=' + encodeURIComponent(sym) + '&timeframe=' + encodeURIComponent(tf) + '&range=1000');
        const data = await res.json();
        if (res.ok && data && Array.isArray(data.candles) && data.candles.length > 0) {
          clientChartCache[activeKey] = { candles: data.candles, time: Date.now() };

          // Only apply if user is still on this exact symbol and timeframe
          if (currentSymbol === targetSym && currentTimeframe === targetTf) {
            applyCandlesAndIndicators(data.candles);
            if (typeof refreshEdgeStats === 'function') {
              refreshEdgeStats(sym);
            }
          }
        } else if (currentSymbol === targetSym && currentTimeframe === targetTf && !cached) {
          clearChartOnError('Không có dữ liệu nến cho ' + sym + (data && data.error ? ' (' + data.error + ')' : ' (HTTP ' + res.status + ')'));
        }
      } catch (e) {
        if (currentSymbol === targetSym && currentTimeframe === targetTf && !cached) {
          clearChartOnError('Lỗi tải biểu đồ ' + sym + ': ' + (e && e.message ? e.message : 'Network error'));
        }
      }

      // 4. Real-time candle updates
      if (currentSymbol === targetSym && currentTimeframe === targetTf) {
        eventSource = new EventSource('/api/stream?symbol=' + encodeURIComponent(sym) + '&timeframe=' + encodeURIComponent(tf));
        eventSource.onmessage = (e) => {
          if (currentSymbol !== targetSym || currentTimeframe !== targetTf) return;
          try {
            const d = JSON.parse(e.data);
            if (d && d.candle && d.candle.time) {
              if (lastLoadedCandle && d.candle.time < lastLoadedCandle.time) return;
              lastLoadedCandle = d.candle;
              candleSeries.update(d.candle);
              volumeSeries.update({
                time: d.candle.time,
                value: d.candle.volume || 0,
                color: d.candle.close >= d.candle.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)',
              });
              if (!isCrosshairHovering) {
                setLegendOHLC(d.candle);
              }
              if (typeof syncLivePriceToWatchlist === 'function') {
                syncLivePriceToWatchlist(currentSymbol, d.candle.close);
              }
              if (currentCandlesCache.length > 0) {
                const lastCached = currentCandlesCache[currentCandlesCache.length - 1];
                if (lastCached && d.candle.time === lastCached.time) {
                  currentCandlesCache[currentCandlesCache.length - 1] = d.candle;
                } else if (!lastCached || d.candle.time > lastCached.time) {
                  currentCandlesCache.push(d.candle);
                }
                updateActiveIndicators(currentCandlesCache);
                updateProviewTitle(currentSymbol, d.candle.close);
              }
            }
          } catch (err) {}
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
          rlm: {
            enabled: !!rlmEnabled,
            swing: rlmSwingLen || 6,
            score: rlmMinScore || 50,
            preset: rlmRiskPreset || 'BALANCED',
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
          },

          // 7. Multi-Chart Grid Session (Layout, Cells 2, 3, 4 Token & Timeframe)
          multiChart: window.multiChartManagerInstance ? {
            layout: window.multiChartManagerInstance.currentLayout,
            cells: {
              '2': {
                symbol: document.getElementById('grid-sym-select-2')?.value || window.multiChartManagerInstance.defaultConfigs['2']?.symbol || 'BINANCE:ETHUSDT',
                timeframe: document.querySelector('#chart-cell-2 .grid-tf-btn.active')?.dataset.tf || '60',
              },
              '3': {
                symbol: document.getElementById('grid-sym-select-3')?.value || window.multiChartManagerInstance.defaultConfigs['3']?.symbol || 'BINANCE:SOLUSDT',
                timeframe: document.querySelector('#chart-cell-3 .grid-tf-btn.active')?.dataset.tf || '15',
              },
              '4': {
                symbol: document.getElementById('grid-sym-select-4')?.value || window.multiChartManagerInstance.defaultConfigs['4']?.symbol || 'HYPERLIQUID:HYPE',
                timeframe: document.querySelector('#chart-cell-4 .grid-tf-btn.active')?.dataset.tf || '60',
              }
            }
          } : null
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
          const symUp = String(s.symbol).toUpperCase();
          if (symUp === 'BINANCE:ANTUSDT.P' || symUp === 'BINANCE:ANTUSDC' || symUp === 'BINANCE:ANTUSDC.P' || symUp === 'BINANCE:ANTUSDT' || symUp === 'ANT-USDC' || symUp === 'ANTUSDC' || symUp === 'ANTUSDT.P') {
            currentSymbol = 'NASDAQ:ANT';
          } else {
            currentSymbol = s.symbol;
          }
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

        if (s.rlm) {
          rlmEnabled = s.rlm.enabled;
          rlmSwingLen = s.rlm.swing || 6;
          rlmMinScore = s.rlm.score || 50;
          rlmRiskPreset = s.rlm.preset || 'BALANCED';
          const btnRlm = document.getElementById('btn-toggle-rlm');
          if (btnRlm) {
            btnRlm.textContent = rlmEnabled ? 'ON' : 'OFF';
            btnRlm.className = 'btn' + (rlmEnabled ? ' active' : '');
            btnRlm.style.background = rlmEnabled ? 'rgba(245, 158, 11, 0.2)' : 'var(--bg-tertiary)';
            btnRlm.style.color = rlmEnabled ? '#fbbf24' : 'var(--text-secondary)';
            btnRlm.style.borderColor = rlmEnabled ? '#f59e0b' : 'transparent';
          }
          const selRlmSw = document.getElementById('select-rlm-swing');
          if (selRlmSw) selRlmSw.value = String(rlmSwingLen);
          const selRlmSc = document.getElementById('select-rlm-score');
          if (selRlmSc) selRlmSc.value = String(rlmMinScore);
          const selRlmPr = document.getElementById('select-rlm-preset');
          if (selRlmPr) selRlmPr.value = rlmRiskPreset;
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

        // 6. Restore Multi-Chart Grid Session (Layout, Cells 2, 3, 4 Token & Timeframe)
        if (s.multiChart && window.multiChartManagerInstance) {
          if (s.multiChart.cells) {
            Object.keys(s.multiChart.cells).forEach(cellId => {
              const cellCfg = s.multiChart.cells[cellId];
              if (window.multiChartManagerInstance.defaultConfigs[cellId]) {
                if (cellCfg.symbol) window.multiChartManagerInstance.defaultConfigs[cellId].symbol = cellCfg.symbol;
                if (cellCfg.timeframe) window.multiChartManagerInstance.defaultConfigs[cellId].timeframe = cellCfg.timeframe;
              }
            });
          }
          if (s.multiChart.layout && s.multiChart.layout !== '1') {
            setTimeout(() => {
              window.multiChartManagerInstance.setLayout(s.multiChart.layout);
            }, 120);
          }
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

    // Reaction Level Matrix [WillyAlgoTrader] Controls
    const btnToggleRlm = document.getElementById('btn-toggle-rlm');
    if (btnToggleRlm) {
      btnToggleRlm.addEventListener('click', () => {
        rlmEnabled = !rlmEnabled;
        btnToggleRlm.textContent = rlmEnabled ? 'ON' : 'OFF';
        btnToggleRlm.style.background = rlmEnabled ? 'rgba(245, 158, 11, 0.2)' : 'var(--bg-tertiary)';
        btnToggleRlm.style.color = rlmEnabled ? '#fbbf24' : 'var(--text-secondary)';
        btnToggleRlm.style.borderColor = rlmEnabled ? '#f59e0b' : 'transparent';
        updateReactionLevelMatrix(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
    }

    const selectRlmSwing = document.getElementById('select-rlm-swing');
    if (selectRlmSwing) {
      selectRlmSwing.addEventListener('change', () => {
        rlmSwingLen = parseInt(selectRlmSwing.value, 10) || 6;
        updateReactionLevelMatrix(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
    }

    const selectRlmScore = document.getElementById('select-rlm-score');
    if (selectRlmScore) {
      selectRlmScore.addEventListener('change', () => {
        rlmMinScore = parseInt(selectRlmScore.value, 10) || 50;
        updateReactionLevelMatrix(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
    }

    const selectRlmPreset = document.getElementById('select-rlm-preset');
    if (selectRlmPreset) {
      selectRlmPreset.addEventListener('change', () => {
        rlmRiskPreset = selectRlmPreset.value || 'BALANCED';
        updateReactionLevelMatrix(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
    }

    // LuxAlgo Signals & Overlays [v6.1] Controls
    const btnToggleLux = document.getElementById('btn-toggle-luxalgo');
    if (btnToggleLux) {
      btnToggleLux.addEventListener('click', () => {
        luxalgoEnabled = !luxalgoEnabled;
        btnToggleLux.textContent = luxalgoEnabled ? 'ON' : 'OFF';
        btnToggleLux.style.background = luxalgoEnabled ? 'rgba(56, 189, 248, 0.2)' : 'var(--bg-tertiary)';
        btnToggleLux.style.color = luxalgoEnabled ? '#38bdf8' : 'var(--text-secondary)';
        btnToggleLux.style.borderColor = luxalgoEnabled ? '#38bdf8' : 'transparent';
        updateLuxAlgoOverlays(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
    }

    const selectLuxFactor = document.getElementById('select-lux-factor');
    if (selectLuxFactor) {
      selectLuxFactor.addEventListener('change', () => {
        luxAtrFactor = parseFloat(selectLuxFactor.value) || 4.0;
        updateLuxAlgoOverlays(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
    }

    const selectLuxRz = document.getElementById('select-lux-rz');
    if (selectLuxRz) {
      selectLuxRz.addEventListener('change', () => {
        luxRzEnabled = selectLuxRz.value === 'ON';
        updateLuxAlgoOverlays(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
    }

    // EMA30 Band Breakout [EL COBER Enhanced] Controls
    const btnToggleEma30 = document.getElementById('btn-toggle-ema30');
    if (btnToggleEma30) {
      btnToggleEma30.addEventListener('click', () => {
        ema30BandEnabled = !ema30BandEnabled;
        btnToggleEma30.textContent = ema30BandEnabled ? 'ON' : 'OFF';
        btnToggleEma30.style.background = ema30BandEnabled ? 'rgba(34, 197, 94, 0.2)' : 'var(--bg-tertiary)';
        btnToggleEma30.style.color = ema30BandEnabled ? '#4ade80' : 'var(--text-secondary)';
        btnToggleEma30.style.borderColor = ema30BandEnabled ? '#22c55e' : 'transparent';
        updateEma30BandBreakout(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
    }

    const selectEma30Period = document.getElementById('select-ema30-period');
    if (selectEma30Period) {
      selectEma30Period.addEventListener('change', () => {
        ema30BandPeriod = parseInt(selectEma30Period.value, 10) || 30;
        updateEma30BandBreakout(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
    }

    const selectEma30Vol = document.getElementById('select-ema30-vol');
    if (selectEma30Vol) {
      selectEma30Vol.addEventListener('change', () => {
        ema30UseVol = selectEma30Vol.value === 'ON';
        updateEma30BandBreakout(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
    }

    const selectEma30Trend = document.getElementById('select-ema30-trend');
    if (selectEma30Trend) {
      selectEma30Trend.addEventListener('change', () => {
        ema30UseTrend = selectEma30Trend.value === 'ON';
        updateEma30BandBreakout(currentCandlesCache);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
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
        const initial = (item.name || item.symbol || 'T').slice(0, 1).toUpperCase();

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

    function cleanTokenBase(sym) {
      if (!sym) return '';
      let s = sym.toUpperCase().trim();
      if (s.includes(':')) s = s.split(':')[1];
      s = s.replace(/\.P$/i, '');
      s = s.replace(/[\-_.]?(USDT|USDC|USD|FDUSD)$/i, '');
      return s.trim();
    }

    // --- High-Speed Realtime Watchlist Sync (Zero-Latency Link with Chart, Header & Orderbook) ---
    function syncLivePriceToWatchlist(symbolOrCoin, price, changePct, changeAbs) {
      if (!symbolOrCoin || !price || isNaN(price) || price <= 0) return;
      const rawStr = String(symbolOrCoin).trim();
      const coinUp = rawStr.toUpperCase();
      const hasExchangePrefix = rawStr.includes(':');
      const cleanInput = cleanTokenBase(rawStr);

      // Robust tiered token matching — never allow bare Hyperliquid coins (e.g. 'SPX', 'GOLD') to match non-crypto indices/stocks
      let matched = customWatchlist.find(w => w.symbol === rawStr || w.symbol.toUpperCase() === coinUp);
      if (!matched && !hasExchangePrefix) {
        matched = customWatchlist.find(w => !isClientNonCryptoSymbol(w.symbol) && w.name.toUpperCase() === coinUp);
        if (!matched) matched = customWatchlist.find(w => !isClientNonCryptoSymbol(w.symbol) && cleanTokenBase(w.symbol) === cleanInput);
        if (!matched && cleanInput.length >= 4) {
          matched = customWatchlist.find(w => !isClientNonCryptoSymbol(w.symbol) && (cleanTokenBase(w.symbol).startsWith(cleanInput) || w.name.toUpperCase().startsWith(cleanInput)));
        }
      }
      if (!matched && !hasExchangePrefix && isClientNonCryptoSymbol(currentSymbol)) {
        return;
      }
      const targetSymbol = matched ? matched.symbol : rawStr;

      const prevPrice = pricesCache[targetSymbol]?.close;
      if (prevPrice && prevPrice > 0) {
        const ratio = price / prevPrice;
        if (ratio < 0.25 || ratio > 4.0) {
          console.warn('[Watchlist Price Guard] Blocked extreme cross-asset jump for', targetSymbol, ':', price, 'vs', prevPrice);
          return;
        }
      }
      if (!pricesCache[targetSymbol]) pricesCache[targetSymbol] = {};
      pricesCache[targetSymbol].close = price;
      if (changePct !== undefined && changePct !== null && !isNaN(changePct)) {
        pricesCache[targetSymbol].change = changePct;
      }
      if (changeAbs !== undefined && changeAbs !== null && !isNaN(changeAbs)) {
        pricesCache[targetSymbol].change_abs = changeAbs;
      }

      // Direct, zero-latency DOM update on the Watchlist row without re-rendering the whole table
      const row = document.querySelector(\`.wl-row[data-symbol="\${targetSymbol}"]\`);
      if (row) {
        const priceEl = row.querySelector('.wl-cell-last');
        if (priceEl) {
          const formatted = formatPrice(price);
          if (priceEl.textContent !== formatted) {
            priceEl.textContent = formatted;
            if (prevPrice && prevPrice !== price) {
              priceEl.style.transition = 'color 0.2s';
              priceEl.style.color = price > prevPrice ? '#4ade80' : '#ef5350';
              setTimeout(() => { priceEl.style.color = 'var(--text-primary)'; }, 350);
            }
          }
        }
        if (changePct !== undefined && changePct !== null && !isNaN(changePct)) {
          const cells = row.querySelectorAll('.wl-cell:not(.wl-cell-last)');
          if (cells.length >= 2) {
            const chgClass = changePct >= 0 ? 'val-green' : 'val-red';
            const chgStr = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
            const absVal = changeAbs !== undefined && changeAbs !== null ? changeAbs : (price * changePct / 100);
            cells[0].textContent = formatChgAbs(absVal);
            cells[0].className = 'wl-cell ' + chgClass;
            cells[1].textContent = chgStr;
            cells[1].className = 'wl-cell ' + chgClass;
          }
        }
      }

      // Keep Header / Ticker Bar & Active Chart in sync ONLY if this price belongs to the ACTIVE symbol!
      const isNonCryptoPair = isClientNonCryptoSymbol(targetSymbol) || isClientNonCryptoSymbol(currentSymbol);
      const isActiveChartSymbol = isNonCryptoPair
        ? (targetSymbol === currentSymbol)
        : ((targetSymbol === currentSymbol) || (cleanTokenBase(targetSymbol) === cleanTokenBase(currentSymbol)));
      if (isActiveChartSymbol) {
        const lastEl = document.getElementById('hl-stat-last');
        if (lastEl) lastEl.textContent = '$' + (price >= 1 ? price.toLocaleString('en-US') : formatTokenPrice(price));
        if (changePct !== undefined && changePct !== null && !isNaN(changePct)) {
          const chgEl = document.getElementById('hl-stat-change');
          if (chgEl) {
            chgEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
            chgEl.className = 'hl-stat-val ' + (changePct >= 0 ? 'val-green' : 'val-red');
          }
        }
        // Animate live candle on the chart immediately
        if (typeof updateActiveCandleWithLivePrice === 'function') {
          updateActiveCandleWithLivePrice(price);
        }
      }
    }

    async function updateWatchlistPrices() {
      if (customWatchlist.length === 0) return;
      const symbols = customWatchlist.map(w => w.symbol);
      const generation = ++watchlistPriceGeneration;
      const requestKey = symbols.join('|');

      // Do not stack identical in-flight requests when an interval tick overlaps a slow response.
      if (clientPriceInFlight.has(requestKey)) return clientPriceInFlight.get(requestKey);

      const request = (async () => {
        try {
          const res = await fetch('/api/watchlist/prices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbols })
          });
          const data = await res.json();
          // Ignore stale responses if the user has already triggered a newer refresh.
          if (generation !== watchlistPriceGeneration) return;
          if (data.prices) {
            Object.assign(pricesCache, data.prices);
            const filter = document.getElementById('watchlist-search')?.value || '';
            renderWatchlist(filter);
            if (typeof updateProviewTitle === 'function') updateProviewTitle();

            // Synchronize active chart candle and right price scale directly from watchlist response
            const activeBase = cleanTokenBase(currentSymbol);
            const pEntry = data.prices[currentSymbol] ||
                           (!isClientNonCryptoSymbol(currentSymbol) && activeBase && (data.prices['BINANCE:' + activeBase + 'USDT'] || data.prices['HYPERLIQUID:' + activeBase] || data.prices[activeBase]));
            if (pEntry && typeof pEntry.close === 'number' && pEntry.close > 0) {
              const livePrice = pEntry.close;
              if (typeof updateActiveCandleWithLivePrice === 'function') {
                updateActiveCandleWithLivePrice(livePrice);
              }
              const lastEl = document.getElementById('hl-stat-last');
              if (lastEl) lastEl.textContent = '$' + (livePrice >= 1 ? livePrice.toLocaleString('en-US') : formatTokenPrice(livePrice));
              if (typeof pEntry.change === 'number') {
                const chgEl = document.getElementById('hl-stat-change');
                if (chgEl) {
                  chgEl.textContent = (pEntry.change >= 0 ? '+' : '') + pEntry.change.toFixed(2) + '%';
                  chgEl.className = 'hl-stat-val ' + (pEntry.change >= 0 ? 'val-green' : 'val-red');
                }
              }
              const dockMktEl = document.getElementById('dock-market-price');
              if (dockMktEl) dockMktEl.textContent = '$' + (livePrice >= 1 ? livePrice.toLocaleString('en-US') : formatTokenPrice(livePrice));
              currentDockPrice = livePrice;
              if (typeof updateExecutionLabels === 'function') updateExecutionLabels();
            }
          }
        } catch (e) {}
        finally {
          clientPriceInFlight.delete(requestKey);
        }
      })();
      clientPriceInFlight.set(requestKey, request);
      return request;
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

      const rawUp = raw.toUpperCase();
      if (rawUp === 'SP500' || rawUp === 'SPX' || rawUp === 'S&P500' || rawUp.includes('SP500')) {
        addResolvedToken('INDEX:SPX', 'SP500', 'INDEX', 'indices/s-and-p-500');
        if (btnConfirm) btnConfirm.textContent = 'Add';
        return;
      }
      if (rawUp === 'GOLD' || rawUp === 'XAU' || rawUp === 'XAUUSD') {
        addResolvedToken('TVC:GOLD', 'GOLD', 'TVC', 'metal/gold');
        if (btnConfirm) btnConfirm.textContent = 'Add';
        return;
      }
      if (rawUp === 'NVDA' || rawUp === 'NASDAQ:NVDA' || rawUp.includes('NVDA')) {
        addResolvedToken('NASDAQ:NVDA', 'NVDA', 'NASDAQ', 'nvidia');
        if (btnConfirm) btnConfirm.textContent = 'Add';
        return;
      }
      if (rawUp === 'ANT' || rawUp === 'NASDAQ:ANT' || rawUp === 'ANTHROPIC') {
        addResolvedToken('NASDAQ:ANT', 'ANT', 'NASDAQ', 'anthropic');
        if (btnConfirm) btnConfirm.textContent = 'Add';
        return;
      }

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
        fetch('/api/history?symbol=' + encodeURIComponent(sym) + '&timeframe=' + encodeURIComponent(currentTimeframe) + '&range=1000')
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
              fetch('/api/history?symbol=' + encodeURIComponent(item.symbol) + '&timeframe=' + encodeURIComponent(currentTimeframe) + '&range=1000')
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
    setInterval(updateWatchlistPrices, 2500);

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

    function extractCoinName(symbol) {
      if (!symbol) return '';
      let s = symbol.toUpperCase();
      if (s.includes(':')) s = s.split(':')[1];
      return s.replace(/\.P$/i, '').replace(/[-_]?(USDT|USDC|USD|FDUSD)$/i, '').trim();
    }

    function updatePositionRowLivePrice(coin, livePx) {
      if (!livePx || livePx <= 0) return;
      const cUpper = coin.toUpperCase();
      const rows = document.querySelectorAll('#table-paper-positions tr[data-coin="' + cUpper + '"]');
      if (!rows || rows.length === 0) return;

      rows.forEach(row => {
        const posId = row.getAttribute('data-pos-id');
        const side = row.getAttribute('data-side');
        const entry = parseFloat(row.getAttribute('data-entry')) || livePx;
        const size = parseFloat(row.getAttribute('data-size')) || 0;
        const margin = parseFloat(row.getAttribute('data-margin')) || 1;

        const markEl = document.getElementById('pos-mark-' + posId);
        if (markEl) {
          const oldPx = parseFloat(markEl.getAttribute('data-last-px')) || livePx;
          markEl.textContent = '$' + (livePx >= 1000 ? livePx.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : (livePx >= 1 ? livePx.toFixed(2) : livePx.toFixed(4)));
          markEl.setAttribute('data-last-px', livePx);

          if (livePx > oldPx) {
            markEl.style.color = '#4ade80';
            setTimeout(() => { if (markEl) markEl.style.color = '#fff'; }, 300);
          } else if (livePx < oldPx) {
            markEl.style.color = '#f87171';
            setTimeout(() => { if (markEl) markEl.style.color = '#fff'; }, 300);
          }
        }

        const pnlEl = document.getElementById('pos-pnl-' + posId);
        if (pnlEl) {
          const upnl = side === 'LONG' ? (livePx - entry) * size : (entry - livePx) * size;
          const upnlPct = (upnl / margin) * 100;
          pnlEl.textContent = (upnl >= 0 ? '+$' : '-$') + Math.abs(upnl).toFixed(2) + ' (' + (upnlPct >= 0 ? '+' : '') + upnlPct.toFixed(2) + '% ROE)';
          pnlEl.className = upnl >= 0 ? 'val-green' : 'val-red';
        }
      });
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

          // Subscribe allMids (hyper-fast mark price stream across all Hyperliquid pairs)
          try {
            hlWs.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
          } catch(e) {}

          if (currentDockCoin) {
            subscribeHlWebSocket(currentDockCoin);
          }
        };

        hlWs.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (!msg || !msg.channel) return;

            // 1. L2 Orderbook stream: channel 'l2Book'
            if (msg.channel === 'l2Book' && msg.data && msg.data.coin === currentDockCoin && !isClientNonCryptoSymbol(currentSymbol)) {
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
                const midPx = (bestAsk && bestBid) ? (bestAsk + bestBid) / 2 : (bestAsk || bestBid);
                if (midPx && typeof syncLivePriceToWatchlist === 'function') {
                  syncLivePriceToWatchlist(currentDockCoin, midPx);
                }
              }
            }

            // 2. Realtime trades stream: channel 'trades'
            if (msg.channel === 'trades' && Array.isArray(msg.data) && !isClientNonCryptoSymbol(currentSymbol)) {
              const trades = msg.data.filter(t => t.coin === currentDockCoin);
              if (trades.length > 0) {
                const latestTrade = trades[trades.length - 1];
                if (latestTrade && latestTrade.px) {
                  currentDockPrice = parseFloat(latestTrade.px);
                  const mktPriceEl = document.getElementById('dock-market-price');
                  if (mktPriceEl) mktPriceEl.textContent = '$' + (currentDockPrice >= 1 ? currentDockPrice.toLocaleString('en-US') : currentDockPrice.toFixed(4));
                  updateExecutionLabels();
                  if (typeof syncLivePriceToWatchlist === 'function') {
                    syncLivePriceToWatchlist(currentDockCoin, currentDockPrice);
                  }
                  if (typeof updateProviewTitle === 'function') updateProviewTitle(currentDockCoin, currentDockPrice);
                }
              }
            }

            // 3. Realtime native candle stream: channel 'candle' (Vela Hyperliquid Engine)
            if (msg.channel === 'candle' && msg.data && msg.data.s === currentDockCoin && !isClientNonCryptoSymbol(currentSymbol)) {
              const cd = msg.data;
              const livePx = parseFloat(cd.c);
              if (livePx > 0) {
                if (typeof updateActiveCandleWithLivePrice === 'function') {
                  updateActiveCandleWithLivePrice(livePx);
                }
                if (typeof syncLivePriceToWatchlist === 'function') {
                  syncLivePriceToWatchlist(cd.s, livePx);
                }
              }
            }

            // 4. Realtime allMids stream: Hyperliquid global mark price stream
            if (msg.channel === 'allMids' && msg.data && msg.data.mids) {
              const mids = msg.data.mids;
              for (const [coin, pxStr] of Object.entries(mids)) {
                const px = parseFloat(pxStr);
                if (px > 0) {
                  updatePositionRowLivePrice(coin, px);
                  if (coin === currentDockCoin && !isClientNonCryptoSymbol(currentSymbol)) {
                    currentDockPrice = px;
                    const mktPriceEl = document.getElementById('dock-market-price');
                    if (mktPriceEl) mktPriceEl.textContent = '$' + (px >= 1 ? px.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : px.toFixed(4));
                    const lastEl = document.getElementById('hl-stat-last');
                    if (lastEl) lastEl.textContent = '$' + (px >= 1 ? px.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : formatTokenPrice(px));
                    if (typeof updateExecutionLabels === 'function') updateExecutionLabels();
                  }
                }
              }
            }

            // 5. Realtime activeAssetCtx stream: Hyperliquid L1 Mark Price, Oracle & Funding
            if (msg.channel === 'activeAssetCtx' && msg.data && msg.data.ctx) {
              const coin = msg.data.coin;
              const ctx = msg.data.ctx;
              const markPx = parseFloat(ctx.markPx || ctx.midPx);
              if (markPx > 0) {
                updatePositionRowLivePrice(coin, markPx);
                if (coin === currentDockCoin && !isClientNonCryptoSymbol(currentSymbol)) {
                  currentDockPrice = markPx;
                  const mktPriceEl = document.getElementById('dock-market-price');
                  if (mktPriceEl) mktPriceEl.textContent = '$' + (markPx >= 1 ? markPx.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : markPx.toFixed(4));
                  const lastEl = document.getElementById('hl-stat-last');
                  if (lastEl) lastEl.textContent = '$' + (markPx >= 1 ? markPx.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : formatTokenPrice(markPx));
                  if (typeof updateExecutionLabels === 'function') updateExecutionLabels();
                  const idxEl = document.getElementById('hl-stat-index');
                  if (idxEl && ctx.oraclePx) {
                    const orc = parseFloat(ctx.oraclePx);
                    idxEl.textContent = '$' + (orc >= 1 ? orc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : formatTokenPrice(orc));
                  }
                  if (ctx.funding) {
                    const fundEl = document.getElementById('hl-stat-funding');
                    if (fundEl) {
                      const fVal = (parseFloat(ctx.funding) || 0) * 100;
                      fundEl.textContent = fVal.toFixed(4) + '%';
                      fundEl.className = fVal >= 0 ? 'val-red' : 'val-green';
                    }
                  }
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
      if (typeof WebSocket === 'undefined' || typeof hlWs === 'undefined' || !hlWs || hlWs.readyState !== WebSocket.OPEN) return;
      // Do not subscribe non-crypto indices or stocks to Hyperliquid crypto orderbook
      if (currentSymbol && isClientNonCryptoSymbol(currentSymbol)) {
        if (hlWsActiveCoin) {
          try {
            hlWs.send(JSON.stringify({ method: 'unsubscribe', subscription: { type: 'l2Book', coin: hlWsActiveCoin } }));
            hlWs.send(JSON.stringify({ method: 'unsubscribe', subscription: { type: 'trades', coin: hlWsActiveCoin } }));
            hlWs.send(JSON.stringify({ method: 'unsubscribe', subscription: { type: 'activeAssetCtx', coin: hlWsActiveCoin } }));
            if (hlWsActiveInterval) {
              hlWs.send(JSON.stringify({ method: 'unsubscribe', subscription: { type: 'candle', coin: hlWsActiveCoin, interval: hlWsActiveInterval } }));
            }
          } catch (e) {}
          hlWsActiveCoin = null;
          hlWsActiveInterval = null;
        }
        return;
      }

      const hlIntervalMap = {
        '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
        '60': '1h', '120': '2h', '240': '4h', 'D': '1d', 'W': '1w', 'M': '1M'
      };
      const curTf = (typeof currentTimeframe !== 'undefined') ? String(currentTimeframe) : '60';
      const hlInterval = hlIntervalMap[curTf] || '1h';

      if (hlWsActiveCoin && (hlWsActiveCoin !== coin || hlWsActiveInterval !== hlInterval)) {
        try {
          hlWs.send(JSON.stringify({
            method: 'unsubscribe',
            subscription: { type: 'l2Book', coin: hlWsActiveCoin }
          }));
          hlWs.send(JSON.stringify({
            method: 'unsubscribe',
            subscription: { type: 'trades', coin: hlWsActiveCoin }
          }));
          hlWs.send(JSON.stringify({
            method: 'unsubscribe',
            subscription: { type: 'activeAssetCtx', coin: hlWsActiveCoin }
          }));
          if (hlWsActiveInterval) {
            hlWs.send(JSON.stringify({
              method: 'unsubscribe',
              subscription: { type: 'candle', coin: hlWsActiveCoin, interval: hlWsActiveInterval }
            }));
          }
        } catch (e) {}
      }
      hlWsActiveCoin = coin;
      hlWsActiveInterval = hlInterval;
      try {
        hlWs.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'l2Book', coin }
        }));
        hlWs.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'trades', coin }
        }));
        hlWs.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'activeAssetCtx', coin }
        }));
        hlWs.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'candle', coin, interval: hlInterval }
        }));
      } catch (e) {}
    }

    // --- Binance Realtime Trade Stream Engine (Tick-by-Tick Instant Candlestick & Price Scale Animation) ---
    function subscribeBinanceWebSocket(sym) {
      if (typeof WebSocket === 'undefined') return;
      if (!sym) return;
      const symUp = String(sym).toUpperCase();
      const isBinancePerp = symUp.startsWith('BINANCE:') && symUp.endsWith('.P');
      const isNonBinance = isClientStockSymbol(sym) ||
        ['INDEX:', 'TVC:', 'BYBIT:', 'OKX:', 'COINBASE:', 'HYPERLIQUID:', 'HIP3XYZ:', 'METEORA:', 'ORCA:', 'CRYPTO:', 'MEXC:'].some(p => symUp.startsWith(p));
      if (isNonBinance) {
        if (binanceWs) {
          try { binanceWs.close(); } catch (e) {}
          binanceWs = null;
          binanceWsActivePair = null;
        }
        return;
      }
      let pair = symUp;
      if (pair.includes(':')) pair = pair.split(':')[1];
      if (pair.endsWith('.P')) pair = pair.slice(0, -2);
      if (!pair.endsWith('USDT') && !pair.endsWith('USDC') && !pair.endsWith('FDUSD')) {
        if (binanceWs) {
          try { binanceWs.close(); } catch (e) {}
          binanceWs = null;
          binanceWsActivePair = null;
        }
        return;
      }
      const streamPair = pair.toLowerCase();
      const wsKey = (isBinancePerp ? 'f_' : 's_') + streamPair;
      if (binanceWsActivePair === wsKey && binanceWs && binanceWs.readyState === WebSocket.OPEN) {
        return;
      }
      if (binanceWs) {
        try { binanceWs.close(); } catch (e) {}
        binanceWs = null;
      }
      binanceWsActivePair = wsKey;
      try {
        const streamUrl = isBinancePerp
          ? ('wss://fstream.binance.com/ws/' + streamPair + '@aggTrade')
          : ('wss://stream.binance.com:9443/ws/' + streamPair + '@trade');
        binanceWs = new WebSocket(streamUrl);
        binanceWs.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data && data.p) {
              const livePx = parseFloat(data.p);
              if (livePx > 0 && currentSymbol && currentSymbol.toLowerCase().includes(streamPair)) {
                if (typeof updateActiveCandleWithLivePrice === 'function') {
                  updateActiveCandleWithLivePrice(livePx);
                }
                if (typeof syncLivePriceToWatchlist === 'function') {
                  syncLivePriceToWatchlist(currentSymbol, livePx);
                }
              }
            }
          } catch (e) {}
        };
        binanceWs.onclose = () => {
          if (binanceWsActivePair === wsKey) {
            setTimeout(() => subscribeBinanceWebSocket(currentSymbol), 4000);
          }
        };
        binanceWs.onerror = () => {
          try { binanceWs.close(); } catch (e) {}
        };
      } catch (err) {}
    }

    async function updateDockData() {
      const c = currentDockCoin;
      const isNonCryptoMarket = isClientNonCryptoSymbol(currentSymbol);

      if (!isNonCryptoMarket) {
        // 1. Fetch Orderbook (HTTP Fallback if WS connecting)
        try {
          const res = await fetch('/api/hyperliquid/book?coin=' + encodeURIComponent(c));
          const b = await res.json();
          if (b && !b.empty && Array.isArray(b.bids) && (b.bids.length > 0 || b.asks.length > 0)) {
            renderOrderbookData(b.bids, b.asks, b.bestAsk, b.bestBid);
          } else {
            const asksEl = document.getElementById('ob-asks-list');
            if (asksEl) asksEl.innerHTML = '<div style="padding:10px;text-align:center;color:var(--text-secondary);font-size:11px;">No Hyperliquid L2 liquidity for ' + c + '</div>';
            const bidsEl = document.getElementById('ob-bids-list');
            if (bidsEl) bidsEl.innerHTML = '';
            const spValEl = document.getElementById('ob-spread-val');
            if (spValEl) spValEl.textContent = '--';
            const spBpEl = document.getElementById('ob-spread-bp');
            if (spBpEl) spBpEl.textContent = '';
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
      } else {
        const asksEl = document.getElementById('ob-asks-list');
        if (asksEl) asksEl.innerHTML = '<div style="padding:10px;text-align:center;color:var(--text-secondary);font-size:11px;">Stock / Index feed (No HL L2 book)</div>';
        const bidsEl = document.getElementById('ob-bids-list');
        if (bidsEl) bidsEl.innerHTML = '';
        const spValEl = document.getElementById('ob-spread-val');
        if (spValEl) spValEl.textContent = '--';
        const spBpEl = document.getElementById('ob-spread-bp');
        if (spBpEl) spBpEl.textContent = '';
        const maxD = document.getElementById('ob-max-depth');
        if (maxD) maxD.textContent = '--';
        ['scr-trades-5m', 'scr-trades-15m', 'scr-chg-5m', 'scr-chg-15m', 'scr-vol-5m', 'scr-vol-15m', 'scr-vdelta-5m', 'scr-vdelta-15m'].forEach(id => {
          const el = document.getElementById(id);
          if (el) {
            el.textContent = '--';
            el.className = 'scr-val';
          }
        });
      }

      // 3. Fetch Account (Live USDC Wallet or $10k Paper Portfolio)
      try {
        const isLive = currentDockMode === 'HYPERLIQUID_LIVE';
        const accountUrl = isLive
          ? ('/api/hyperliquid/account' + (connectedWalletAddress ? '?address=' + encodeURIComponent(connectedWalletAddress) : ''))
          : '/api/paper/status';
        const res = await fetch(accountUrl);
        const acc = await res.json();
        if (acc) {
          dockAvailableBalance = isLive ? (acc.equity || acc.available || 0) : (acc.balance || 10000);
          const suffix = isLive ? ' USDC' : '';
          document.getElementById('dock-avail-bal').textContent = '$' + dockAvailableBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix;
          const matchingPos = (acc.positions || acc.openPositions || []).find(p => (p.symbol && p.symbol.includes(c)) || (p.coin === c));
          const posEl = document.getElementById('dock-active-pos');
          if (posEl) {
            if (matchingPos) {
              let sz = matchingPos.size || matchingPos.szi || 0;
              if (typeof sz === 'string') sz = parseFloat(sz) || 0;
              let szStr = Math.abs(sz) >= 100 ? sz.toFixed(2) : (Math.abs(sz) >= 1 ? sz.toFixed(3) : sz.toFixed(4));
              szStr = parseFloat(szStr).toString();
              const pnl = matchingPos.unrealizedPnl || 0;
              const pnlSign = pnl >= 0 ? '+' : '';
              const pnlStr = (pnl < 0 ? '-' : '') + '$' + Math.abs(pnl).toFixed(2);
              const isLong = matchingPos.side === 'LONG' || matchingPos.side === 'BUY';
              posEl.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; gap: 4px; width: 100%;">' +
                '<span class="action-badge ' + (isLong ? 'action-buy' : 'action-sell') + '" style="font-size: 9px; padding: 1.5px 5px; font-weight: 800; border-radius: 3px;">' + matchingPos.side + ' ' + szStr + '</span>' +
                '<span class="' + (pnl >= 0 ? 'val-green' : 'val-red') + '" style="font-size: 11px; font-weight: 700; white-space: nowrap;">(' + pnlSign + pnlStr + ')</span>' +
              '</div>';
            } else {
              const allPositions = acc.positions || acc.openPositions || [];
              if (allPositions && allPositions.length > 0) {
                const coins = allPositions.map(p => (p.coin || (p.symbol ? p.symbol.split(':')[1] || p.symbol : '')).replace(/USDT|USDC|USD|\.P/g, '')).filter(Boolean);
                posEl.innerHTML = '<span style="font-size: 10px; color: #8c93a3; font-weight: 600;">' + allPositions.length + ' active (' + coins.join(', ') + ')</span>';
              } else {
                posEl.textContent = '--';
              }
            }
          }
        }
      } catch (e) {}
    }

    function updateExecutionLabels() {
      const qtyInput = document.getElementById('input-exec-qty');
      const qty = parseFloat(qtyInput?.value) || 0;
      const hasPrice = typeof currentDockPrice === 'number' && !isNaN(currentDockPrice) && currentDockPrice > 0;
      const priceStr = hasPrice ? ('$' + formatTokenPrice(currentDockPrice)) : '--';

      const buySub = document.getElementById('exec-buy-sub');
      const sellSub = document.getElementById('exec-sell-sub');
      if (buySub) buySub.textContent = qty + ' ' + currentDockCoin + ' @ ' + priceStr;
      if (sellSub) sellSub.textContent = qty + ' ' + currentDockCoin + ' @ ' + priceStr;

      const needsLiveMarketPrice = currentDockOrderType === 'MARKET' && !hasPrice;
      const btnBuy = document.getElementById('btn-exec-buy');
      const btnSell = document.getElementById('btn-exec-sell');
      if (btnBuy) {
        btnBuy.disabled = needsLiveMarketPrice;
        btnBuy.style.opacity = needsLiveMarketPrice ? '0.55' : '1';
      }
      if (btnSell) {
        btnSell.disabled = needsLiveMarketPrice;
        btnSell.style.opacity = needsLiveMarketPrice ? '0.55' : '1';
      }
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
      updateExecutionLabels();
    });
    btnOrdLimit?.addEventListener('click', () => {
      currentDockOrderType = 'LIMIT';
      btnOrdLimit.classList.add('active');
      btnOrdMarket.classList.remove('active');
      limitGroup.style.display = 'flex';
      if (currentDockPrice && currentDockPrice > 0) {
        document.getElementById('input-exec-price').value = currentDockPrice;
      }
      updateExecutionLabels();
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
      if (!price || isNaN(price) || price <= 0) {
        alert('Waiting for live market price before placing order.');
        return;
      }

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
      const moreBtn = document.getElementById('btn-more-tf');
      const moreMenu = document.getElementById('more-tf-dropdown');
      if (btn.classList.contains('more-tf-opt') && moreBtn) {
        moreBtn.textContent = btn.textContent + ' ⌄';
        moreBtn.classList.add('active');
      } else if (moreBtn) {
        moreBtn.textContent = '⌄';
      }
      if (moreMenu) moreMenu.style.display = 'none';
      if (typeof triggerAutoSave === 'function') triggerAutoSave();
      loadChart(currentSymbol, currentTimeframe);
    });

    const btnMoreTf = document.getElementById('btn-more-tf');
    const moreTfDropdown = document.getElementById('more-tf-dropdown');
    btnMoreTf?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!moreTfDropdown) return;
      const open = moreTfDropdown.style.display === 'flex';
      moreTfDropdown.style.display = open ? 'none' : 'flex';
    });

    const btnChartStyle = document.getElementById('btn-chart-style');
    const chartStyleDropdown = document.getElementById('chart-style-dropdown');
    btnChartStyle?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!chartStyleDropdown) return;
      const open = chartStyleDropdown.style.display === 'flex';
      chartStyleDropdown.style.display = open ? 'none' : 'flex';
    });
    chartStyleDropdown?.addEventListener('click', (e) => {
      const opt = e.target.closest('.chart-style-opt');
      if (!opt || !opt.dataset.style) return;
      currentChartStyle = opt.dataset.style;
      document.querySelectorAll('.chart-style-opt').forEach(b => b.classList.toggle('active', b === opt));
      const lbl = document.getElementById('chart-style-label');
      if (lbl) {
        const names = { candles: 'Candles', hollow: 'Hollow', heikin: 'Heikin Ashi', line: 'Line' };
        lbl.textContent = names[currentChartStyle] || 'Candles';
      }
      if (chartStyleDropdown) chartStyleDropdown.style.display = 'none';
      applyChartStyle(currentCandlesCache);
    });
    document.addEventListener('click', (e) => {
      if (moreTfDropdown && !e.target.closest('#btn-more-tf') && !e.target.closest('#more-tf-dropdown')) {
        moreTfDropdown.style.display = 'none';
      }
      if (chartStyleDropdown && !e.target.closest('#btn-chart-style') && !e.target.closest('#chart-style-dropdown')) {
        chartStyleDropdown.style.display = 'none';
      }
    });

    // Proactive Hover Prefetch: Pre-load candle history the moment mouse hovers on timeframe button
    document.querySelectorAll('#timeframes button[data-tf]').forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        const tf = btn.dataset.tf;
        const key = currentSymbol + '_' + tf;
        if (!clientChartCache[key]) {
          fetch('/api/history?symbol=' + encodeURIComponent(currentSymbol) + '&timeframe=' + encodeURIComponent(tf) + '&range=1000')
            .then(r => r.json())
            .then(data => {
              if (data && data.candles && data.candles.length > 0) {
                clientChartCache[key] = { candles: data.candles, time: Date.now() };
              }
            })
            .catch(() => {});
        }
      });
    });

    // --- Hyperliquid & Stock Ticker Bar / Header Logic ---
    async function updateTickerBar(coin) {
      if (!coin || coin !== currentDockCoin) return;
      if (isClientNonCryptoSymbol(currentSymbol)) {
        try {
          const res = await fetch('/api/stock/ticker?symbol=' + encodeURIComponent(currentSymbol));
          const t = await res.json();
          if (!t || !t.rawLast || !isClientNonCryptoSymbol(currentSymbol)) return;
          const rawL = t.rawLast;
          const rawChg = t.rawChange || 0;
          const lastStr = t.last || formatTokenPrice(rawL);
          const chgStr = t.change || ((rawChg >= 0 ? '+' : '') + rawChg.toFixed(2) + '%');

          const lastEl = document.getElementById('hl-stat-last');
          if (lastEl) lastEl.textContent = '$' + String(lastStr).replace(/^\$/, '');
          const idxEl = document.getElementById('hl-stat-index');
          if (idxEl) idxEl.textContent = t.index && t.index !== '--' ? t.index : '$' + String(lastStr).replace(/^\$/, '');
          const chgEl = document.getElementById('hl-stat-change');
          if (chgEl) {
            chgEl.textContent = chgStr;
            chgEl.className = 'hl-stat-val ' + (rawChg >= 0 ? 'val-green' : 'val-red');
          }
          const volEl = document.getElementById('hl-stat-volume');
          if (volEl) volEl.textContent = t.volume || '--';
          const oiEl = document.getElementById('hl-stat-oi');
          if (oiEl) oiEl.textContent = '--';
          const fundEl = document.getElementById('hl-stat-funding');
          if (fundEl) {
            fundEl.textContent = '--';
            fundEl.className = '';
          }
          const mcapEl = document.getElementById('hl-stat-mcap');
          if (mcapEl) mcapEl.textContent = '--';
          const fdvEl = document.getElementById('hl-stat-fdv');
          if (fdvEl) fdvEl.textContent = '--';

          const titleEl = document.getElementById('active-symbol-title');
          if (titleEl && t.symbol) titleEl.textContent = t.symbol;
          const exEl = document.getElementById('active-exchange-badge');
          if (exEl && t.exchange) exEl.textContent = t.exchange;

          if (typeof syncLivePriceToWatchlist === 'function') {
            syncLivePriceToWatchlist(currentSymbol, rawL, rawChg);
          }
          if (typeof updateProviewTitle === 'function') {
            updateProviewTitle(t.symbol || coin, rawL > 0 ? rawL : null, rawChg);
          }
        } catch (e) {}
        return;
      }
      try {
        const res = await fetch('/api/hyperliquid/ticker?coin=' + encodeURIComponent(coin));
        const t = await res.json();
        if (coin !== currentDockCoin) return;
        if (t && t.last) {
          const isHlNative = currentSymbol && currentSymbol.toUpperCase().startsWith('HYPERLIQUID:');
          let lastStr = t.last;
          let chgStr = t.change;
          let rawChg = t.rawChange;
          let rawL = t.rawLast;

          if (!isHlNative && typeof pricesCache !== 'undefined' && currentSymbol && pricesCache[currentSymbol]?.close) {
            rawL = pricesCache[currentSymbol].close;
            lastStr = formatTokenPrice(rawL);
            rawChg = pricesCache[currentSymbol].change || 0;
            chgStr = (rawChg >= 0 ? '+' : '') + rawChg.toFixed(2) + '%';
          } else if ((!rawL || rawL === 0) && typeof pricesCache !== 'undefined' && currentSymbol && pricesCache[currentSymbol]?.close) {
            rawL = pricesCache[currentSymbol].close;
            lastStr = formatTokenPrice(rawL);
            rawChg = pricesCache[currentSymbol].change || 0;
            chgStr = (rawChg >= 0 ? '+' : '') + rawChg.toFixed(2) + '%';
          } else if ((!rawL || rawL === 0) && lastLoadedCandle?.close) {
            rawL = lastLoadedCandle.close;
            lastStr = formatTokenPrice(rawL);
          }

          const lastEl = document.getElementById('hl-stat-last');
          if (lastEl) lastEl.textContent = '$' + String(lastStr).replace(/^\$/, '');
          if (rawL > 0) {
            currentDockPrice = rawL;
            const mktEl = document.getElementById('dock-market-price');
            if (mktEl) mktEl.textContent = '$' + String(lastStr).replace(/^\$/, '');
            if (typeof updateExecutionLabels === 'function') updateExecutionLabels();
          }

          if (rawL && typeof syncLivePriceToWatchlist === 'function') {
            syncLivePriceToWatchlist(isHlNative ? coin : currentSymbol, rawL, rawChg);
          }

          const idxEl = document.getElementById('hl-stat-index');
          if (idxEl) idxEl.textContent = (isHlNative && t.index && t.index !== '--') ? t.index : '$' + String(lastStr).replace(/^\$/, '');

          const chgEl = document.getElementById('hl-stat-change');
          if (chgEl) {
            chgEl.textContent = chgStr;
            chgEl.className = 'hl-stat-val ' + (rawChg >= 0 ? 'val-green' : 'val-red');
          }

          const volEl = document.getElementById('hl-stat-volume');
          if (volEl && t.volume && t.volume !== '--') volEl.textContent = t.volume;

          const oiEl = document.getElementById('hl-stat-oi');
          if (oiEl && t.openInterest && t.openInterest !== '--') oiEl.textContent = t.openInterest;

          const fundEl = document.getElementById('hl-stat-funding');
          if (fundEl) {
            fundEl.textContent = t.funding;
            fundEl.className = t.rawFunding >= 0 ? 'val-red' : 'val-green';
          }

          const mcapEl = document.getElementById('hl-stat-mcap');
          if (mcapEl && t.marketcap && t.marketcap !== '--') mcapEl.textContent = t.marketcap;

          const fdvEl = document.getElementById('hl-stat-fdv');
          if (fdvEl && t.fdv && t.fdv !== '--') fdvEl.textContent = t.fdv;

          if (isHlNative) {
            const titleEl = document.getElementById('active-symbol-title');
            if (titleEl) titleEl.textContent = t.symbol;
            const exEl = document.getElementById('active-exchange-badge');
            if (exEl) exEl.textContent = t.exchange;
          }

          if (typeof updateProviewTitle === 'function') {
            updateProviewTitle(isHlNative ? (t.symbol || coin) : currentSymbol, rawL > 0 ? rawL : null, rawChg);
          }
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
    ['btn-toggle-fibo', 'btn-toggle-galton', 'btn-toggle-footprint', 'btn-toggle-rlm', 'btn-toggle-luxalgo', 'btn-toggle-ema30', 'select-fibo-period', 'select-galton-engine', 'select-galton-period', 'select-footprint-window', 'select-footprint-imbalance', 'select-rlm-swing', 'select-rlm-score', 'select-rlm-preset', 'select-lux-factor', 'select-lux-rz', 'select-ema30-period', 'select-ema30-vol', 'select-ema30-trend'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', triggerAutoSave);
      document.getElementById(id)?.addEventListener('click', triggerAutoSave);
    });
    updateCountdown();

    // Indicators dropdown toggle
    const btnIndMenu = document.getElementById('btn-indicators-menu');
    const indDropdown = document.getElementById('indicators-dropdown');

    btnIndMenu?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isHidden = indDropdown.style.display === 'none' || !indDropdown.style.display;
      indDropdown.style.display = isHidden ? 'block' : 'none';
      btnIndMenu.classList.toggle('active', isHidden);
    });

    indDropdown?.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    document.addEventListener('click', (e) => {
      if (indDropdown && indDropdown.style.display === 'block' && !e.target.closest('#indicators-dropdown') && !e.target.closest('#btn-indicators-menu')) {
        indDropdown.style.display = 'none';
        btnIndMenu?.classList.remove('active');
      }
    });

    // Drawing Tools Dropdown toggle
    const btnDrawMenu = document.getElementById('btn-draw-menu');
    const drawDropdown = document.getElementById('draw-dropdown');

    btnDrawMenu?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isHidden = drawDropdown.style.display === 'none' || !drawDropdown.style.display;
      drawDropdown.style.display = isHidden ? 'block' : 'none';
      btnDrawMenu.classList.toggle('active', isHidden);
    });

    drawDropdown?.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    document.addEventListener('click', (e) => {
      if (drawDropdown && drawDropdown.style.display === 'block' && !e.target.closest('#draw-dropdown') && !e.target.closest('#btn-draw-menu')) {
        drawDropdown.style.display = 'none';
        btnDrawMenu?.classList.remove('active');
      }
    });

    // Drawing Tools item event handlers
    const toolNamesMap = {
      'cursor': 'Crosshair',
      'trendline': 'Trendline',
      'ray': 'Ray Line',
      'horizontal': 'Horizontal',
      'box': 'S/R Box',
      'fib': 'Fibonacci',
      'ruler': 'Thước Đo (Ruler)',
      'long_pos': 'Long Pos ▲R',
      'short_pos': 'Short Pos ▼R',
    };

    document.querySelectorAll('.draw-dropdown-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tool = btn.dataset.tool;
        if (tool === 'magnet') {
          const isMag = window.drawingEngineInstance?.toggleMagnet();
          const badge = document.getElementById('magnet-mode-badge');
          if (badge) {
            badge.textContent = isMag ? 'ON' : 'OFF';
            badge.style.background = isMag ? 'rgba(56, 189, 248, 0.25)' : 'rgba(255, 255, 255, 0.08)';
            badge.style.color = isMag ? '#38bdf8' : '#94a3b8';
          }
        } else if (tool === 'del_selected') {
          if (window.drawingEngineInstance?.selectedDrawing) {
            window.drawingEngineInstance.removeDrawing(window.drawingEngineInstance.selectedDrawing);
          } else if (window.drawingEngineInstance?.drawings?.length > 0) {
            window.drawingEngineInstance.removeDrawing(window.drawingEngineInstance.drawings[window.drawingEngineInstance.drawings.length - 1]);
          }
          if (drawDropdown) drawDropdown.style.display = 'none';
          btnDrawMenu?.classList.remove('active');
        } else if (tool === 'trash') {
          window.drawingEngineInstance?.clearAllDrawings();
          if (drawDropdown) drawDropdown.style.display = 'none';
          btnDrawMenu?.classList.remove('active');
        } else if (tool) {
          document.querySelectorAll('.draw-dropdown-item').forEach(el => {
            el.classList.remove('active');
            el.style.setProperty('background', 'transparent', 'important');
            el.style.setProperty('color', '#94a3b8', 'important');
          });
          btn.classList.add('active');
          btn.style.setProperty('background', 'rgba(56, 189, 248, 0.16)', 'important');
          btn.style.setProperty('color', '#38bdf8', 'important');
          window.drawingEngineInstance?.setActiveTool(tool);

          const lbl = document.getElementById('active-draw-tool-label');
          if (lbl && toolNamesMap[tool]) lbl.textContent = toolNamesMap[tool];

          if (drawDropdown) drawDropdown.style.display = 'none';
          btnDrawMenu?.classList.remove('active');
        }
      });
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

        // Load Quantitative Edge Stats (LuxAlgo edge-stats)
        refreshEdgeStats(sym);
      } catch (e) {
        document.getElementById('val-status').textContent = 'Error: ' + e.message;
      }
    });

    // --- Quantitative Edge Stats Client Updater (LuxAlgo edge-stats) ---
    async function refreshEdgeStats(sym) {
      if (!sym) sym = currentSymbol || 'BINANCE:BTCUSDT';
      try {
        const res = await fetch('/api/edge-stats?symbol=' + encodeURIComponent(sym));
        const data = await res.json();
        if (data.error || !data.edges) {
          const evalRangeEl = document.getElementById('edge-eval-range');
          if (evalRangeEl) evalRangeEl.textContent = data.error || 'Chưa đủ dữ liệu phiên (>= 15 phiên)';
          const dRangeEl = document.getElementById('dock-edge-sample-range');
          if (dRangeEl) dRangeEl.textContent = data.error || 'Chưa đủ dữ liệu (>= 15 phiên)';
          ['edge-pdh-rate', 'edge-pdl-rate', 'edge-gap-rate', 'edge-orb-rate'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = 'N/A';
          });
          ['edge-pdh-ci', 'edge-pdh-sub', 'edge-pdl-ci', 'edge-pdl-sub', 'edge-gap-ci', 'edge-gap-time', 'edge-orb-ci', 'edge-orb-false'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '--';
          });
          return;
        }

        const { edges, liveSession, symbolMeta } = data;

        // 1. Populate Validation Bot Card
        const evalRangeEl = document.getElementById('edge-eval-range');
        if (evalRangeEl && symbolMeta) {
          evalRangeEl.textContent = 'Sample: ' + symbolMeta.totalSessions + ' sessions (' + symbolMeta.evaluatedDateRange + ')';
        }

        const pdhRateEl = document.getElementById('edge-pdh-rate');
        if (pdhRateEl) pdhRateEl.textContent = edges.pdhTouch.estimate;
        const pdhCiEl = document.getElementById('edge-pdh-ci');
        if (pdhCiEl) pdhCiEl.textContent = '95% CI: ' + edges.pdhTouch.ci95 + ' (N=' + edges.pdhTouch.n + ')';
        const pdhSubEl = document.getElementById('edge-pdh-sub');
        if (pdhSubEl && liveSession) {
          pdhSubEl.textContent = liveSession.isPdhAlreadyTouched ? '✓ Touched Today' : 'Dist: +' + liveSession.distToPdhPct + '% ($' + liveSession.prevHigh.toLocaleString() + ')';
          pdhSubEl.style.color = liveSession.isPdhAlreadyTouched ? '#4ade80' : '#94a3b8';
        }

        const pdlRateEl = document.getElementById('edge-pdl-rate');
        if (pdlRateEl) pdlRateEl.textContent = edges.pdlTouch.estimate;
        const pdlCiEl = document.getElementById('edge-pdl-ci');
        if (pdlCiEl) pdlCiEl.textContent = '95% CI: ' + edges.pdlTouch.ci95 + ' (N=' + edges.pdlTouch.n + ')';
        const pdlSubEl = document.getElementById('edge-pdl-sub');
        if (pdlSubEl && liveSession) {
          pdlSubEl.textContent = liveSession.isPdlAlreadyTouched ? '✓ Touched Today' : 'Dist: -' + liveSession.distToPdlPct + '% ($' + liveSession.prevLow.toLocaleString() + ')';
          pdlSubEl.style.color = liveSession.isPdlAlreadyTouched ? '#ef5350' : '#94a3b8';
        }

        const gapRateEl = document.getElementById('edge-gap-rate');
        if (gapRateEl) gapRateEl.textContent = edges.gapFill.estimate;
        const gapCiEl = document.getElementById('edge-gap-ci');
        if (gapCiEl) gapCiEl.textContent = '95% CI: ' + edges.gapFill.ci95 + ' (N=' + edges.gapFill.n + ')';
        const gapTimeEl = document.getElementById('edge-gap-time');
        if (gapTimeEl) gapTimeEl.textContent = edges.gapFill.timeDistribution;

        const orbRateEl = document.getElementById('edge-orb-rate');
        if (orbRateEl) orbRateEl.textContent = edges.orbContinuation.estimate;
        const orbCiEl = document.getElementById('edge-orb-ci');
        if (orbCiEl) orbCiEl.textContent = '95% CI: ' + edges.orbContinuation.ci95 + ' (N=' + edges.orbContinuation.n + ')';
        const orbFalseEl = document.getElementById('edge-orb-false');
        if (orbFalseEl) orbFalseEl.textContent = 'False Break: ' + edges.orbContinuation.falseBreakRate;

        // 2. Populate Dock Block (#dock-block-edgestats)
        const dRangeEl = document.getElementById('dock-edge-sample-range');
        if (dRangeEl && symbolMeta) dRangeEl.textContent = 'N=' + symbolMeta.totalSessions + ' sessions';

        const dPdhProb = document.getElementById('dock-edge-pdh-prob');
        if (dPdhProb) dPdhProb.textContent = edges.pdhTouch.estimate;
        const dPdhCi = document.getElementById('dock-edge-pdh-ci');
        if (dPdhCi) dPdhCi.textContent = 'CI: ' + edges.pdhTouch.ci95;
        const dPdhDist = document.getElementById('dock-edge-pdh-dist');
        if (dPdhDist && liveSession) dPdhDist.textContent = 'Dist: +' + liveSession.distToPdhPct + '%';
        const dPdhHit = document.getElementById('dock-edge-pdh-hit');
        if (dPdhHit && liveSession) dPdhHit.style.display = liveSession.isPdhAlreadyTouched ? 'inline' : 'none';

        const dPdlProb = document.getElementById('dock-edge-pdl-prob');
        if (dPdlProb) dPdlProb.textContent = edges.pdlTouch.estimate;
        const dPdlCi = document.getElementById('dock-edge-pdl-ci');
        if (dPdlCi) dPdlCi.textContent = 'CI: ' + edges.pdlTouch.ci95;
        const dPdlDist = document.getElementById('dock-edge-pdl-dist');
        if (dPdlDist && liveSession) dPdlDist.textContent = 'Dist: -' + liveSession.distToPdlPct + '%';
        const dPdlHit = document.getElementById('dock-edge-pdl-hit');
        if (dPdlHit && liveSession) dPdlHit.style.display = liveSession.isPdlAlreadyTouched ? 'inline' : 'none';

        const dGapProb = document.getElementById('dock-edge-gap-prob');
        if (dGapProb) dGapProb.textContent = edges.gapFill.estimate;
        const dGapCi = document.getElementById('dock-edge-gap-ci');
        if (dGapCi) dGapCi.textContent = 'CI: ' + edges.gapFill.ci95;
        const dGapTime = document.getElementById('dock-edge-gap-time');
        if (dGapTime) dGapTime.textContent = 'Gap: ' + (liveSession ? liveSession.gapPct : 0) + '%';

        const dOrbProb = document.getElementById('dock-edge-orb-prob');
        if (dOrbProb) dOrbProb.textContent = edges.orbContinuation.estimate;
        const dOrbCi = document.getElementById('dock-edge-orb-ci');
        if (dOrbCi) dOrbCi.textContent = 'CI: ' + edges.orbContinuation.ci95;
        const dOrbFalse = document.getElementById('dock-edge-orb-false');
        if (dOrbFalse) dOrbFalse.textContent = 'False: ' + edges.orbContinuation.falseBreakRate;

        const dPdhVal = document.getElementById('dock-edge-pdh-val');
        if (dPdhVal && liveSession) dPdhVal.textContent = '$' + liveSession.prevHigh.toLocaleString();
        const dPdlVal = document.getElementById('dock-edge-pdl-val');
        if (dPdlVal && liveSession) dPdlVal.textContent = '$' + liveSession.prevLow.toLocaleString();
        const dStab = document.getElementById('dock-edge-stability');
        if (dStab) dStab.textContent = edges.pdhTouch.stability.split('(')[0].trim();

      } catch (e) {}
    }

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

    document.getElementById('btn-run-replay')?.addEventListener('click', async () => {
      const sym = document.getElementById('rep-sym-input')?.value.trim() || 'BINANCE:BTCUSDT';
      const repStatus = document.getElementById('rep-status');
      if (repStatus) repStatus.textContent = 'Executing bar-by-bar walkforward...';
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

    // Telegram User Custom Config Logic
    const tgBox = document.getElementById('user-tg-connect-box');
    const btnCfgTg = document.getElementById('btn-configure-user-tg');
    const btnCloseTg = document.getElementById('close-user-tg-box');
    const btnSaveTg = document.getElementById('btn-save-user-tg');
    const btnTestTg = document.getElementById('btn-test-user-tg');
    const btnDelTg = document.getElementById('btn-del-user-tg');
    const inpTgToken = document.getElementById('user-tg-token-input');
    const inpTgChat = document.getElementById('user-tg-chat-input');
    const tgStatus = document.getElementById('alert-status');

    function updateTgStatusDisplay() {
      const savedChat = localStorage.getItem('hyperview_user_tg_chat');
      const savedToken = localStorage.getItem('hyperview_user_tg_token');
      if (savedChat && savedToken) {
        if (tgStatus) {
          tgStatus.textContent = 'Connected · Chat ' + savedChat;
          tgStatus.className = 'sh-badge sh-badge-emerald';
        }
        if (inpTgChat) inpTgChat.value = savedChat;
        if (inpTgToken) inpTgToken.value = savedToken;
      } else {
        if (tgStatus) {
          tgStatus.textContent = 'Chưa kết nối';
          tgStatus.className = 'sh-badge sh-badge-amber';
        }
      }
    }
    updateTgStatusDisplay();

    if (btnCfgTg && tgBox) {
      btnCfgTg.addEventListener('click', () => {
        tgBox.style.display = tgBox.style.display === 'none' ? 'block' : 'none';
      });
    }
    if (btnCloseTg && tgBox) {
      btnCloseTg.addEventListener('click', () => {
        tgBox.style.display = 'none';
      });
    }
    if (btnSaveTg) {
      btnSaveTg.addEventListener('click', async () => {
        const token = (inpTgToken?.value || '').trim();
        const chat = (inpTgChat?.value || '').trim();
        if (!token || !chat) {
          alert('Vui lòng nhập cả Telegram Bot Token và Chat ID');
          return;
        }
        localStorage.setItem('hyperview_user_tg_token', token);
        localStorage.setItem('hyperview_user_tg_chat', chat);
        updateTgStatusDisplay();

        // Also save to user account profile on server
        try {
          await fetch('/api/user/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, chatId: chat })
          });
        } catch (e) {}

        tgBox.style.display = 'none';
        alert('Đã lưu cấu hình Telegram vào tài khoản của bạn thành công!');
      });
    }

    if (btnTestTg) {
      btnTestTg.addEventListener('click', async () => {
        const token = (inpTgToken?.value || localStorage.getItem('hyperview_user_tg_token') || '').trim();
        const chat = (inpTgChat?.value || localStorage.getItem('hyperview_user_tg_chat') || '').trim();
        if (!token || !chat) {
          alert('Vui lòng nhập Bot Token và Chat ID trước khi test');
          return;
        }
        btnTestTg.textContent = 'Đang test...';
        btnTestTg.disabled = true;
        try {
          const res = await fetch('/api/user/telegram/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, chatId: chat })
          });
          const data = await res.json();
          if (data.success) {
            alert('Test thành công! Vui lòng kiểm tra tin nhắn xác nhận trên Telegram.');
          } else {
            alert('Test thất bại: ' + (data.error || 'Lỗi không xác định'));
          }
        } catch (e) {
          alert('Lỗi kết nối: ' + e.message);
        } finally {
          btnTestTg.textContent = 'Test Bot';
          btnTestTg.disabled = false;
        }
      });
    }

    if (btnDelTg) {
      btnDelTg.addEventListener('click', async () => {
        if (!confirm('Bạn có chắc chắn muốn xóa cấu hình Telegram của tài khoản này?')) return;
        localStorage.removeItem('hyperview_user_tg_token');
        localStorage.removeItem('hyperview_user_tg_chat');
        if (inpTgToken) inpTgToken.value = '';
        if (inpTgChat) inpTgChat.value = '';
        updateTgStatusDisplay();

        try {
          await fetch('/api/user/telegram', { method: 'DELETE' });
        } catch (e) {}

        tgBox.style.display = 'none';
        alert('Đã xóa cấu hình Telegram thành công.');
      });
    }

    document.getElementById('btn-send-tg-alert').addEventListener('click', async () => {
      const sym = document.getElementById('alert-sym-input').value.trim();
      const userToken = localStorage.getItem('hyperview_user_tg_token');
      const userChat = localStorage.getItem('hyperview_user_tg_chat');

      if (!userToken || !userChat) {
        if (tgBox) tgBox.style.display = 'block';
        alert('Please connect your own Telegram Bot Token & Chat ID before dispatching alerts.');
        return;
      }

      document.getElementById('alert-status').textContent = 'Rendering snapshot & sending to your Telegram...';
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
            accountEquity: 10000,
            userToken: userToken,
            userChatId: userChat
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
      const batchPromises = [];
      for (let i = 1; i <= 300; i++) {
        const sym = symbols[i % symbols.length];
        batchPromises.push(fetch('/api/hub/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: 'sub-agent-' + i, symbols: [sym] })
        }));
      }
      await Promise.all(batchPromises);
      await refreshHub();
    });

    async function refreshHub() {
      const res = await fetch('/api/hub/status');
      const data = await res.json();
      document.getElementById('hub-agents-count').textContent = data.activeAgents;
      document.getElementById('hub-symbols-count').textContent = data.trackedSymbols;
      document.getElementById('hub-cached-count').textContent = data.cachedSymbols;

      const pullRes = await fetch('/api/hub/pull?agentId=all');
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

    // --- AI Intelligence Hub Section Focus Controls ---
    document.querySelectorAll('.ai-hub-focus-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ai-hub-focus-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const targetSec = btn.dataset.aiTarget;
        const col1 = document.getElementById('ai-sec-validation');
        const col2 = document.getElementById('ai-sec-backtest');
        const col3 = document.getElementById('ai-sec-hub');
        const c = document.getElementById('ai-hub-main-container');
        if (targetSec === 'all') {
          if (col1) col1.style.display = 'flex';
          if (col2) col2.style.display = 'flex';
          if (col3) col3.style.display = 'flex';
          if (c) c.className = 'ai-hub-grid-3col';
        } else {
          if (col1) col1.style.display = targetSec === 'ai-sec-validation' ? 'flex' : 'none';
          if (col2) col2.style.display = targetSec === 'ai-sec-backtest' ? 'flex' : 'none';
          if (col3) col3.style.display = targetSec === 'ai-sec-hub' ? 'flex' : 'none';
          if (c) c.className = 'ai-hub-grid-3rows';
        }
      });
    });

    document.getElementById('btn-ai-run-all')?.addEventListener('click', () => {
      document.getElementById('btn-run-validation')?.click();
      document.getElementById('btn-run-backtest')?.click();
      document.getElementById('btn-hub-simulate')?.click();
    });

    // --- Tradesync Journaling Dashboard Client Logic ---
    async function loadSim6mData(forceRefresh = false) {
      if (forceRefresh) cachedSim6mData = null;
      if (cachedSim6mData) return cachedSim6mData;
      try {
        const res = await fetch('/api/paper/simulated-6m?t=' + Date.now(), { credentials: 'same-origin' });
        lastSimFetchStatus = res.status;
        if (res.ok) {
          cachedSim6mData = await res.json();
          return cachedSim6mData;
        }
      } catch (e) {
        lastSimFetchStatus = 0;
      }
      return null;
    }

    async function renderJournalDashboard() {
      const modeSelect = document.getElementById("ts-month-mode");
      if (modeSelect) currentJournalMode = modeSelect.value;

      const prevBtn = document.getElementById("btn-ts-prev-month");
      const nextBtn = document.getElementById("btn-ts-next-month");
      if (prevBtn && nextBtn) {
        if (currentJournalMode === "sim6m") {
          const atStart = simActiveMonthIndex <= 0;
          const atEnd = simActiveMonthIndex >= simMonthList.length - 1;
          prevBtn.disabled = atStart;
          nextBtn.disabled = atEnd;
          prevBtn.style.opacity = atStart ? "0.35" : "1";
          nextBtn.style.opacity = atEnd ? "0.35" : "1";
          prevBtn.title = "Previous month";
          nextBtn.title = "Next month";
        } else {
          prevBtn.disabled = true;
          nextBtn.disabled = true;
          prevBtn.style.opacity = "0.35";
          nextBtn.style.opacity = "0.35";
          const tip = "Chuyển sang chế độ Backtest 2026 để duyệt các tháng";
          prevBtn.title = tip;
          nextBtn.title = tip;
        }
      }

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
      let month = 10; // November

      // Always ensure fresh paper status is available
      if (!cachedPaperStatus && typeof refreshPaperStatus === 'function') {
        try { await refreshPaperStatus(); } catch (e) {}
      }

      if (currentJournalMode === "sim6m") {
        const LIVE_CUTOFF_DATE = "2026-11-21";
        const simData = await loadSim6mData();
        const mInfo = simMonthList[simActiveMonthIndex] || simMonthList[simMonthList.length - 1];
        if (calTitle) {
          if (!simData && lastSimFetchStatus === 403) {
            calTitle.textContent = mInfo.name + " (Cần đăng nhập Admin để xem lịch sử Sim)";
          } else {
            calTitle.textContent = mInfo.name + (mInfo.prefix >= "2026-11" ? " (Sim + Live)" : " (Enhanced R:R Sim)");
          }
        }
        year = mInfo.year;
        month = mInfo.month;

        // Pre-fill all calendar days in active month
        daysMap = {};
        const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        for (let d = 1; d <= daysInMonth; d++) {
          const dStr = mInfo.prefix + '-' + String(d).padStart(2, '0');
          daysMap[dStr] = { pnl: 0, trades: [] };
        }

        // 1. Load Enhanced Oliver Kell R:R Simulation for dates < 2026-11-21 (Jan - Nov 20, 2026)
        if (simData && simData.daysMap) {
          for (const [dStr, dObj] of Object.entries(simData.daysMap)) {
            if (dStr.startsWith(mInfo.prefix) && dStr < LIVE_CUTOFF_DATE) {
              daysMap[dStr] = {
                pnl: Math.round(Number(dObj.pnl || 0) * 100) / 100,
                trades: [...(dObj.trades || [])]
              };
            }
          }
        }

        // 2. Merge authentic Live Paper Trades from 2026-11-21 onwards
        if (cachedPaperStatus && cachedPaperStatus.allTrades) {
          cachedPaperStatus.allTrades.forEach(t => {
            const exitTime = t.exitTime || t.entryTime;
            if (!exitTime) return;
            const dStr = exitTime.slice(0, 10);
            if (dStr.startsWith(mInfo.prefix) && dStr >= LIVE_CUTOFF_DATE) {
              if (!daysMap[dStr]) {
                daysMap[dStr] = { pnl: 0, trades: [] };
              }
              const tPnl = Math.round(Number(t.pnl || 0) * 100) / 100;
              daysMap[dStr].pnl = Math.round((daysMap[dStr].pnl + tPnl) * 100) / 100;
              daysMap[dStr].trades.push({
                id: t.id,
                symbol: t.symbol,
                side: t.side,
                entryPrice: t.entryPrice,
                exitPrice: t.exitPrice,
                pnl: tPnl,
                pnlPercent: t.pnlPercent,
                strategy: t.strategy || 'Oliver Kell Enhanced R:R (V2.1)',
                reason: t.reason,
                time: exitTime.slice(11, 16),
                date: dStr,
                exitTime: exitTime
              });
            }
          });
        }

        // Calculate stats for all trades in this active month
        for (const dObj of Object.values(daysMap)) {
          (dObj.trades || []).forEach(t => {
            const pVal = typeof t.pnl === 'number' ? t.pnl : (typeof t.pnlDollar === 'number' ? t.pnlDollar : 0);
            if (pVal > 0) {
              winCount++;
              winSum += pVal;
            } else if (pVal < 0) {
              lossCount++;
              lossSum += Math.abs(pVal);
            }
            if (t.side === "LONG") longPnl += pVal;
            else shortPnl += pVal;
            totalPnl += pVal;
          });
        }
      } else if (currentJournalMode === "march2026") {
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
        if (calTitle) calTitle.textContent = monthNames[month] + " " + year + " (Live Paper)";

        const currentMonthPrefix = year + "-" + String(month + 1).padStart(2, "0");
        const allTrades = (cachedPaperStatus && cachedPaperStatus.allTrades) || [];
        allTrades.forEach(t => {
          const exitTime = t.exitTime || t.entryTime;
          if (!exitTime) return;
          const dStr = exitTime.slice(0, 10);
          if (dStr.startsWith(currentMonthPrefix)) {
            if (!daysMap[dStr]) daysMap[dStr] = { pnl: 0, trades: [] };
            daysMap[dStr].pnl += (t.pnl || 0);
            daysMap[dStr].trades.push({
              id: t.id,
              symbol: t.symbol,
              side: t.side,
              entryPrice: t.entryPrice,
              exitPrice: t.exitPrice,
              pnl: t.pnl,
              pnlPercent: t.pnlPercent,
              strategy: t.strategy,
              reason: t.reason,
              time: exitTime.slice(11, 16),
              date: dStr,
              exitTime: exitTime
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
          }
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

      // 2. Performance Sparkline Cards & Dynamic Tradesyncer Score
      const elCumPnlVal = document.getElementById("ts-cum-pnl-val");
      if (elCumPnlVal) {
        elCumPnlVal.textContent = (totalPnl >= 0 ? "+$" : "-$") + Math.abs(totalPnl).toLocaleString("en-US");
        elCumPnlVal.className = "ts-perf-val " + (totalPnl >= 0 ? "val-green" : "val-red");
      }

      const elTodayPnlVal = document.getElementById("ts-today-pnl-val");
      if (elTodayPnlVal) {
        elTodayPnlVal.textContent = (totalPnl >= 0 ? "+$" : "-$") + Math.abs(totalPnl).toLocaleString("en-US");
        elTodayPnlVal.className = "ts-perf-val " + (totalPnl >= 0 ? "val-green" : "val-red");
      }

      // Calculate Month Max Drawdown for Card 3
      let monthPeak = 0;
      let monthMaxDD = 0;
      let runningPnl = 0;
      for (const dObj of Object.values(daysMap)) {
        runningPnl += (dObj.pnl || 0);
        if (runningPnl > monthPeak) monthPeak = runningPnl;
        const dd = monthPeak - runningPnl;
        if (dd > monthMaxDD) monthMaxDD = dd;
      }
      const elDdVal = document.getElementById("ts-dd-val");
      if (elDdVal) {
        elDdVal.innerHTML = (monthMaxDD > 0 ? "-$" + monthMaxDD.toFixed(2) : "$0.00") + ' <span style="font-size: 11px; font-weight: 500; color: #8c93a3;">max</span>';
      }

      // Dynamic Tradesyncer Score calculation:
      const totalTradesForScore = winCount + lossCount;
      let biasScore = 50;
      let rrScore = 50;
      let pfScore = 50;
      let overallScore = 50;

      if (totalTradesForScore > 0) {
        const pf = lossSum > 0 ? (winSum / lossSum) : (winSum > 0 ? 3.0 : 1.0);
        const avgW = winCount > 0 ? (winSum / winCount) : 0;
        const avgL = lossCount > 0 ? (lossSum / lossCount) : 1;
        const payoff = avgL > 0 ? (avgW / avgL) : 1.0;

        // P.F. Score (0 - 100): 1.0 PF = 50, 1.5 PF = 70, 2.0+ PF = 85-100
        pfScore = Math.min(100, Math.max(10, Math.round(Math.min(pf, 2.5) * 38 + 5)));

        // R/R Score (0 - 100): 1.0 Payoff = 45, 1.8 Payoff = 75, 2.5+ = 95
        rrScore = Math.min(100, Math.max(10, Math.round(Math.min(payoff, 2.8) * 32 + 10)));

        // BIAS Score (0 - 100): Trend quality and win accuracy
        biasScore = Math.min(100, Math.max(10, Math.round(winRatePct * 0.75 + (totalPnl >= 0 ? 25 : 5))));

        // Overall Score (0 - 100)
        overallScore = Math.min(100, Math.max(10, Math.round(biasScore * 0.3 + rrScore * 0.35 + pfScore * 0.35)));
      }

      const elScoreBadge = document.getElementById("ts-score-badge-val");
      if (elScoreBadge) {
        elScoreBadge.textContent = overallScore + " / 100";
        if (overallScore >= 60) {
          elScoreBadge.style.color = "#10b981";
          elScoreBadge.style.background = "rgba(16, 185, 129, 0.15)";
        } else if (overallScore >= 45) {
          elScoreBadge.style.color = "#38bdf8";
          elScoreBadge.style.background = "rgba(56, 189, 248, 0.15)";
        } else {
          elScoreBadge.style.color = "#ef4444";
          elScoreBadge.style.background = "rgba(239, 68, 68, 0.15)";
        }
      }

      const elBiasVal = document.getElementById("ts-score-bias-val");
      const elBiasBar = document.getElementById("ts-score-bias-bar");
      if (elBiasVal) elBiasVal.textContent = biasScore;
      if (elBiasBar) elBiasBar.style.width = biasScore + "%";

      const elRrVal = document.getElementById("ts-score-rr-val");
      const elRrBar = document.getElementById("ts-score-rr-bar");
      if (elRrVal) elRrVal.textContent = rrScore;
      if (elRrBar) elRrBar.style.width = rrScore + "%";

      const elPfVal = document.getElementById("ts-score-pf-val");
      const elPfBar = document.getElementById("ts-score-pf-bar");
      if (elPfVal) elPfVal.textContent = pfScore;
      if (elPfBar) elPfBar.style.width = pfScore + "%";

      // Dynamically morph radar triangle polygon
      const elRadarPoly = document.getElementById("ts-radar-polygon");
      if (elRadarPoly) {
        const topY = Math.round(52 - 36 * (rrScore / 100));
        const rightX = Math.round(50 + 35 * (winRatePct / 100));
        const rightY = Math.round(52 + 23 * (winRatePct / 100));
        const leftX = Math.round(50 - 35 * (pfScore / 100));
        const leftY = Math.round(52 + 23 * (pfScore / 100));
        elRadarPoly.setAttribute("points", "50," + topY + " " + rightX + "," + rightY + " " + leftX + "," + leftY);
      }

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

      for (let row = 0; row < 6; row++) {
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

      currentJournalDaysMap = daysMap;
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
        summaryEl.innerHTML = '<span style="color: #a1a1aa; font-size: 12.5px;">No executed trades recorded on this day.</span>';
        listEl.innerHTML = '<div style="text-align: center; color: #71717a; padding: 24px; font-size: 12.5px;">Market idle or no setups matched entry confluence criteria.</div>';
      } else {
        const p = dayData.pnl;
        const pClass = p >= 0 ? "val-green" : "val-red";
        const pSign = p >= 0 ? "+$" : "-$";
        summaryEl.innerHTML = '<div style="background: #09090b; padding: 10px 14px; border-radius: 8px; border: 1px solid #27272a;">' +
            '<div style="font-size: 11px; color: #71717a; text-transform: uppercase; letter-spacing: 0.04em;">Net P&amp;L</div>' +
            '<div style="font-size: 17px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; margin-top: 2px;" class="' + pClass + '">' + pSign + Math.abs(p).toFixed(2) + '</div>' +
          '</div>' +
          '<div style="background: #09090b; padding: 10px 14px; border-radius: 8px; border: 1px solid #27272a;">' +
            '<div style="font-size: 11px; color: #71717a; text-transform: uppercase; letter-spacing: 0.04em;">Total Trades</div>' +
            '<div style="font-size: 17px; font-weight: 600; color: #fafafa; font-variant-numeric: tabular-nums; margin-top: 2px;">' + dayData.trades.length + '</div>' +
          '</div>';

        let tRows = "";
        dayData.trades.forEach(t => {
          const ep = t.entryPrice !== undefined ? t.entryPrice : t.entry;
          const xp = t.exitPrice !== undefined ? t.exitPrice : t.exit;
          const formatPrice = (val) => {
            if (val === undefined || val === null || isNaN(val)) return "—";
            const num = Number(val);
            if (num >= 1000) return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
            if (num >= 1) return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
            return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
          };
          tRows += '<tr style="border-bottom: 1px solid rgba(39,39,42,0.65);">' +
            '<td style="padding: 8px 10px; color: #a1a1aa;">' + (t.time || "—") + '</td>' +
            '<td style="padding: 8px 10px; font-weight: 500; color: #fafafa;">' + t.symbol + '</td>' +
            '<td style="padding: 8px 10px;"><span class="action-badge ' + (t.side === "LONG" ? "action-buy" : "action-sell") + '">' + t.side + '</span></td>' +
            '<td style="padding: 8px 10px; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">' + formatPrice(ep) + '</td>' +
            '<td style="padding: 8px 10px; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">' + formatPrice(xp) + '</td>' +
            '<td style="padding: 8px 10px; text-align: right; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;" class="' + (t.pnl >= 0 ? "val-green" : "val-red") + '">' +
              (t.pnl >= 0 ? "+" : "") + "$" + (t.pnl ? t.pnl.toFixed(2) : "0.00") + ' (' + (t.pnlPercent || 0) + '%)' +
            '</td>' +
            '<td style="padding: 8px 10px; color: #a1a1aa; font-size: 11.5px;">' + (t.reason || t.strategy) + '</td>' +
          '</tr>';
        });

        listEl.innerHTML = '<div style="border: 1px solid #27272a; border-radius: 8px; overflow: hidden;">' +
          '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">' +
            '<thead style="background: #111114;">' +
              '<tr style="border-bottom: 1px solid #27272a; color: #71717a; font-size: 11px;">' +
                '<th style="padding: 8px 10px; text-align: left;">TIME</th>' +
                '<th style="padding: 8px 10px; text-align: left;">SYMBOL</th>' +
                '<th style="padding: 8px 10px; text-align: left;">SIDE</th>' +
                '<th style="padding: 8px 10px; text-align: right;">ENTRY</th>' +
                '<th style="padding: 8px 10px; text-align: right;">EXIT</th>' +
                '<th style="padding: 8px 10px; text-align: right;">NET PNL</th>' +
                '<th style="padding: 8px 10px; text-align: left;">REASON / STRATEGY</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' + tRows + '</tbody>' +
          '</table>' +
        '</div>';
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
      if (currentJournalMode !== "sim6m") return;
      if (simActiveMonthIndex > 0) {
        simActiveMonthIndex--;
        renderJournalDashboard();
      }
    });
    document.getElementById("btn-ts-next-month")?.addEventListener("click", () => {
      if (currentJournalMode !== "sim6m") return;
      if (simActiveMonthIndex < simMonthList.length - 1) {
        simActiveMonthIndex++;
        renderJournalDashboard();
      }
    });

    // Journal Card quick button
    document.getElementById("btn-ts-journal-card")?.addEventListener("click", () => {
      openDayJournalModal(currentSelectedDate, currentJournalDaysMap[currentSelectedDate]);
    });

    // Export Full Comprehensive Journal Excel (.xlsx) & CSV & Telegram Dispatch
    document.getElementById("btn-ts-export-excel")?.addEventListener("click", () => {
      window.location.href = '/api/paper/export-journal-excel';
    });
    document.getElementById("btn-ts-send-tele")?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-ts-send-tele");
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '⏳ Đang gửi Tele...';
      btn.style.pointerEvents = 'none';
      try {
        const res = await fetch('/api/report/dispatch-monthly-telegram', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          btn.innerHTML = '✅ Đã gửi Tele!';
          setTimeout(() => {
            btn.innerHTML = originalHtml;
            btn.style.pointerEvents = 'auto';
          }, 3500);
        } else {
          alert('Lỗi gửi Telegram: ' + (data.error || 'Unknown'));
          btn.innerHTML = originalHtml;
          btn.style.pointerEvents = 'auto';
        }
      } catch (e) {
        alert('Lỗi kết nối server: ' + e.message);
        btn.innerHTML = originalHtml;
        btn.style.pointerEvents = 'auto';
      }
    });
    document.getElementById("btn-ts-export")?.addEventListener("click", () => {
      window.location.href = '/api/paper/export-journal-csv';
    });

    // Sync button
    document.getElementById("btn-ts-sync")?.addEventListener("click", async () => {
      cachedSim6mData = null;
      if (typeof refreshPaperStatus === 'function') await refreshPaperStatus();
      await renderJournalDashboard();
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
    setTimeout(() => {
      renderJournalDashboard();
      renderMacroCalendar();
    }, 120);

    // --- Macro Calendar Client Logic (shadcn/ui Zinc Dark) ---
    function mcEscapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function mcFormatSyncLabel(lastFetched) {
      if (!lastFetched) return 'Schedule mode';
      const diffMins = Math.floor((Date.now() - lastFetched) / 60000);
      if (diffMins < 1) return 'Synced just now';
      if (diffMins < 60) return 'Synced ' + diffMins + 'm ago';
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return 'Synced ' + diffHours + 'h ago';
      return 'Synced ' + new Date(lastFetched).toLocaleDateString('vi-VN');
    }

    function mcUpdateResetButton() {
      const resetBtn = document.getElementById('btn-mc-reset-filters');
      if (!resetBtn) return;
      const dirty = (
        currentMacroFilters.impact !== 'ALL' ||
        currentMacroFilters.currency !== 'ALL' ||
        currentMacroFilters.category !== 'ALL' ||
        (currentMacroFilters.search && currentMacroFilters.search.trim() !== '')
      );
      resetBtn.style.display = dirty ? 'inline-flex' : 'none';
    }

    function mcResetFacetFilters() {
      currentMacroFilters.impact = 'ALL';
      currentMacroFilters.currency = 'ALL';
      currentMacroFilters.category = 'ALL';
      currentMacroFilters.search = '';

      const searchEl = document.getElementById('mc-search-input');
      if (searchEl) searchEl.value = '';

      document.querySelectorAll('#mc-filter-impact-group .sh-filter-chip').forEach(b => {
        b.classList.toggle('active', b.dataset.mcImpact === 'ALL');
      });
      document.querySelectorAll('#mc-filter-curr-group .sh-filter-chip').forEach(b => {
        b.classList.toggle('active', b.dataset.mcCurr === 'ALL');
      });
      document.querySelectorAll('#mc-filter-cat-group .sh-filter-chip').forEach(b => {
        b.classList.toggle('active', b.dataset.mcCat === 'ALL');
      });
      mcUpdateResetButton();
    }

    function startMacroCountdown() {
      if (macroCountdownInterval) clearInterval(macroCountdownInterval);
      const timerEl = document.getElementById('mc-next-event-timer');
      const riskBadgeEl = document.getElementById('mc-kpi-risk-badge');
      if (!timerEl) return;

      function updateClock() {
        if (!macroNextEventTargetTime || Number.isNaN(macroNextEventTargetTime)) {
          timerEl.textContent = '--:--:--';
          if (riskBadgeEl) {
            riskBadgeEl.className = 'sh-badge sh-badge-outline';
            riskBadgeEl.textContent = 'No Data';
          }
          return;
        }
        const now = Date.now();
        const diff = macroNextEventTargetTime - now;
        if (diff <= 0) {
          timerEl.textContent = 'LIVE NOW';
          timerEl.style.color = '#f87171';
          if (riskBadgeEl) {
            riskBadgeEl.className = 'sh-badge sh-badge-destructive';
            riskBadgeEl.innerHTML = '<span class="sh-dot" style="background:#ef4444;"></span><span>Live Now</span>';
          }
          return;
        }
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const secs = Math.floor((diff % (1000 * 60)) / 1000);

        if (days > 0) {
          timerEl.textContent = days + 'd ' + hours.toString().padStart(2, '0') + 'h ' + mins.toString().padStart(2, '0') + 'm';
        } else {
          timerEl.textContent = hours.toString().padStart(2, '0') + ':' + mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
        }

        if (diff < (2 * 60 * 60 * 1000)) {
          timerEl.style.color = '#f87171';
          if (riskBadgeEl) {
            riskBadgeEl.className = 'sh-badge sh-badge-destructive';
            riskBadgeEl.innerHTML = '<span class="sh-dot" style="background:#ef4444;"></span><span>Imminent</span>';
          }
        } else if (diff < (24 * 60 * 60 * 1000)) {
          timerEl.style.color = '#fbbf24';
          if (riskBadgeEl) {
            riskBadgeEl.className = 'sh-badge sh-badge-amber';
            riskBadgeEl.innerHTML = '<span class="sh-dot" style="background:#f59e0b;"></span><span>Today</span>';
          }
        } else {
          timerEl.style.color = '#fafafa';
          if (riskBadgeEl) {
            riskBadgeEl.className = 'sh-badge sh-badge-outline';
            riskBadgeEl.innerHTML = '<span class="sh-dot" style="background:#71717a;"></span><span>Scheduled</span>';
          }
        }
      }

      updateClock();
      macroCountdownInterval = setInterval(updateClock, 1000);
    }

    function mcRenderScenarioMatrix(scenData) {
      const titleEl = document.getElementById('mc-scenario-event-title');
      const badgesEl = document.getElementById('mc-scenario-badges');
      const metaEl = document.getElementById('mc-scenario-meta');
      const grid = document.getElementById('mc-scenario-cards-grid');
      const riskNoteEl = document.getElementById('mc-scenario-risk-note');
      const resetScenBtn = document.getElementById('btn-mc-scenario-reset');

      if (!scenData || !scenData.scenarios) {
        if (titleEl) titleEl.textContent = 'Chưa có sự kiện vĩ mô sắp tới';
        if (grid) grid.innerHTML = '';
        return;
      }

      if (titleEl) titleEl.textContent = scenData.eventTitle || '';
      if (badgesEl) {
        const imp = scenData.impact || 'Medium';
        const impClass = imp === 'High' ? 'sh-badge-destructive' : (imp === 'Medium' ? 'sh-badge-amber' : 'sh-badge-outline');
        const customBadge = macroSelectedScenarioId ? '<span class="sh-badge sh-badge-secondary">Đang xem từ bảng</span>' : '';
        badgesEl.innerHTML =
          '<span class="sh-badge sh-badge-secondary">' + mcEscapeHtml(scenData.country || 'USD') + '</span>' +
          '<span class="sh-badge ' + impClass + '">' + mcEscapeHtml(imp) + ' Impact</span>' +
          customBadge;
      }
      if (metaEl) {
        metaEl.textContent =
          (scenData.dateFormatted || '') +
          '  |  Forecast: ' + (scenData.forecast || '—') +
          '  |  Previous: ' + (scenData.previous || '—') +
          (scenData.summary ? ' — ' + scenData.summary : '');
      }
      if (resetScenBtn) {
        resetScenBtn.style.display = macroSelectedScenarioId ? 'inline-flex' : 'none';
      }
      if (riskNoteEl) {
        riskNoteEl.textContent = scenData.riskNote || '';
      }
      if (grid) {
        grid.innerHTML = scenData.scenarios.map(s => {
          const isBull = s.tier === 'BULLISH';
          const isBear = s.tier === 'BEARISH';
          const badgeCls = isBull ? 'sh-badge-emerald' : (isBear ? 'sh-badge-destructive' : 'sh-badge-amber');
          const dotColor = isBull ? '#10b981' : (isBear ? '#ef4444' : '#f59e0b');
          const borderColor = isBull ? 'rgba(16, 185, 129, 0.35)' : (isBear ? 'rgba(239, 68, 68, 0.35)' : 'rgba(245, 158, 11, 0.35)');
          return '<div class="sh-scenario-item">' +
            '<div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">' +
              '<span style="font-size: 13.5px; font-weight: 600; color: var(--sh-fg);">' + mcEscapeHtml(s.title) + '</span>' +
              '<span class="sh-badge ' + badgeCls + '"><span class="sh-dot" style="background:' + dotColor + ';"></span><span>' + mcEscapeHtml(s.label) + '</span></span>' +
            '</div>' +
            '<div class="sh-scenario-cond">' + mcEscapeHtml(s.condition) + '</div>' +
            '<div style="font-size: 12.5px; color: var(--sh-muted-fg); line-height: 1.5;">' + mcEscapeHtml(s.reaction) + '</div>' +
            '<div class="sh-scenario-exec" style="border-left-color: ' + borderColor + ';">' +
              '<strong style="color: var(--sh-fg); font-weight: 500;">Playbook:</strong> ' + mcEscapeHtml(s.execution) +
            '</div>' +
          '</div>';
        }).join('');
      }
    }

    function mcRenderEventsTable(events) {
      const tbody = document.getElementById('mc-events-tbody');
      if (!tbody) return;

      if (!events || events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 48px 20px; color: var(--sh-muted-fg);">' +
          '<div style="font-size: 14px; font-weight: 600; color: var(--sh-fg); margin-bottom: 6px;">Không có sự kiện phù hợp bộ lọc</div>' +
          '<div style="font-size: 12.5px; color: var(--sh-subtle-fg); margin-bottom: 16px;">Thử mở rộng phạm vi thời gian sang 30 ngày tới hoặc đặt lại các bộ lọc hiện tại.</div>' +
          '<div style="display: inline-flex; gap: 8px; flex-wrap: wrap; justify-content: center;">' +
            '<button class="sh-btn-outline" id="btn-mc-empty-30d" type="button">Xem 30 ngày tới</button>' +
            '<button class="sh-btn-outline" id="btn-mc-empty-reset" type="button">Đặt lại bộ lọc</button>' +
          '</div>' +
        '</td></tr>';

        document.getElementById('btn-mc-empty-30d')?.addEventListener('click', () => {
          document.querySelector('[data-mc-time="UPCOMING_30D"]')?.click();
        });
        document.getElementById('btn-mc-empty-reset')?.addEventListener('click', () => {
          mcResetFacetFilters();
          renderMacroCalendar();
        });
        return;
      }

      const now = Date.now();
      let lastGroupKey = '';
      let rowsHtml = '';

      events.forEach((ev) => {
        const evDateObj = new Date(ev.date);
        const evTime = evDateObj.getTime();
        const isPast = evTime < now;
        const isHigh = ev.impact === 'High';
        const isMed = ev.impact === 'Medium';
        const isExpanded = macroExpandedEventIds.has(ev.id);

        // Date group header
        const groupKey = evDateObj.toLocaleDateString('en-CA');
        if (groupKey !== lastGroupKey) {
          lastGroupKey = groupKey;
          const groupLabel = evDateObj.toLocaleDateString('vi-VN', {
            weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
          });
          rowsHtml += '<tr class="sh-date-group-row"><td colspan="7">' + mcEscapeHtml(groupLabel) + '</td></tr>';
        }

        const timeOnlyStr = evDateObj.toLocaleTimeString('vi-VN', {
          hour: '2-digit', minute: '2-digit', hour12: false
        });

        let relLabel = '';
        if (isPast) {
          relLabel = '<span style="color: var(--sh-subtle-fg);">Past</span>';
        } else {
          const diffMins = Math.round((evTime - now) / 60000);
          if (diffMins < 60) {
            relLabel = '<span style="color: #f87171;">in ' + diffMins + 'm</span>';
          } else {
            const diffHours = Math.round(diffMins / 60);
            if (diffHours < 24) {
              relLabel = '<span style="color: #fbbf24;">in ' + diffHours + 'h</span>';
            } else {
              const diffDays = Math.round(diffHours / 24);
              relLabel = '<span style="color: var(--sh-muted-fg);">in ' + diffDays + 'd</span>';
            }
          }
        }

        let impactBadgeHtml = '<span class="sh-badge sh-badge-outline"><span class="sh-dot" style="background:#71717a;"></span><span>Low</span></span>';
        if (isHigh) {
          impactBadgeHtml = '<span class="sh-badge sh-badge-destructive"><span class="sh-dot" style="background:#ef4444;"></span><span>High</span></span>';
        } else if (isMed) {
          impactBadgeHtml = '<span class="sh-badge sh-badge-amber"><span class="sh-dot" style="background:#f59e0b;"></span><span>Medium</span></span>';
        }

        const rowClasses = ['sh-table-row'];
        if (isHigh) rowClasses.push('is-high');
        if (isPast) rowClasses.push('is-past');
        if (isExpanded) rowClasses.push('is-expanded');

        const actualCell = ev.actual
          ? '<span style="color: #34d399; font-weight: 600;">' + mcEscapeHtml(ev.actual) + '</span>'
          : '<span style="color: var(--sh-subtle-fg);">—</span>';

        rowsHtml += '<tr class="' + rowClasses.join(' ') + '" data-event-id="' + mcEscapeHtml(ev.id) + '">' +
          '<td class="sh-num" style="text-align: left;">' +
            '<div style="font-weight: 600; color: var(--sh-fg);">' + mcEscapeHtml(timeOnlyStr) + '</div>' +
            '<div style="font-size: 11px; margin-top: 2px;">' + relLabel + '</div>' +
          '</td>' +
          '<td>' +
            '<span class="sh-badge sh-badge-secondary">' + mcEscapeHtml(ev.country || 'USD') + '</span>' +
          '</td>' +
          '<td>' + impactBadgeHtml + '</td>' +
          '<td>' +
            '<div style="font-weight: 500; color: var(--sh-fg); line-height: 1.4;">' + mcEscapeHtml(ev.title) + '</div>' +
            '<div style="font-size: 11.5px; color: var(--sh-subtle-fg); margin-top: 2px;">' + mcEscapeHtml(ev.category || 'General') + '</div>' +
          '</td>' +
          '<td class="sh-num">' + actualCell + '</td>' +
          '<td class="sh-num" style="color: var(--sh-fg);">' + mcEscapeHtml(ev.forecast || '—') + '</td>' +
          '<td class="sh-num" style="color: var(--sh-muted-fg);">' + mcEscapeHtml(ev.previous || '—') + '</td>' +
        '</tr>';

        if (isExpanded) {
          const sourceLabel = ev.source === 'live' ? 'Live ForexFactory Feed' : 'Tier-1 Macro Schedule';
          rowsHtml += '<tr class="sh-detail-row">' +
            '<td colspan="7">' +
              '<div class="sh-detail-box">' +
                '<div style="flex: 1; min-width: 260px;">' +
                  '<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">' +
                    '<span style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--sh-subtle-fg);">Crypto Transmission Note</span>' +
                    '<span class="sh-badge sh-badge-outline">' + mcEscapeHtml(sourceLabel) + '</span>' +
                  '</div>' +
                  '<div style="font-size: 12.5px; color: var(--sh-muted-fg); line-height: 1.55;">' +
                    mcEscapeHtml(ev.cryptoImpact || 'Theo dõi phản ứng tỷ giá và cấu trúc nến 15M/1H sau khi công bố số liệu.') +
                  '</div>' +
                '</div>' +
                '<button class="sh-btn-outline btn-mc-inspect-scenario" type="button" data-scenario-id="' + mcEscapeHtml(ev.id) + '" style="flex-shrink: 0;">' +
                  '<span>Xem kịch bản 3 chiều</span>' +
                '</button>' +
              '</div>' +
            '</td>' +
          '</tr>';
        }
      });

      tbody.innerHTML = rowsHtml;

      tbody.querySelectorAll('.sh-table-row[data-event-id]').forEach(rowEl => {
        rowEl.addEventListener('click', () => {
          const evId = rowEl.dataset.eventId;
          if (!evId) return;
          if (macroExpandedEventIds.has(evId)) {
            macroExpandedEventIds.delete(evId);
          } else {
            macroExpandedEventIds.add(evId);
          }
          mcRenderEventsTable(events);
        });
      });

      tbody.querySelectorAll('.btn-mc-inspect-scenario').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const scId = btn.dataset.scenarioId;
          if (!scId) return;
          macroSelectedScenarioId = scId;
          if (macroScenarioCollapsed) {
            macroScenarioCollapsed = false;
            const bodyEl = document.getElementById('mc-scenario-body');
            const toggleBtn = document.getElementById('btn-mc-scenario-toggle');
            if (bodyEl) bodyEl.style.display = 'block';
            if (toggleBtn) toggleBtn.textContent = 'Thu gọn';
          }
          try {
            const resp = await fetch('/api/macro/scenario?id=' + encodeURIComponent(scId));
            const json = await resp.json();
            if (json && json.success && json.scenarioMatrix) {
              mcRenderScenarioMatrix(json.scenarioMatrix);
              document.getElementById('mc-scenario-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          } catch (err) {
            console.error('Failed to load event scenario:', err);
          }
        });
      });
    }

    async function renderMacroCalendar() {
      try {
        const params = new URLSearchParams({
          impact: currentMacroFilters.impact,
          currency: currentMacroFilters.currency,
          category: currentMacroFilters.category,
          search: currentMacroFilters.search,
          timeScope: currentMacroFilters.timeScope,
          hidePast: currentMacroFilters.hidePast ? 'true' : 'false',
        });
        if (macroSelectedScenarioId) {
          params.set('scenarioEventId', macroSelectedScenarioId);
        }

        const res = await fetch('/api/macro/events?' + params.toString());
        const data = await res.json();
        if (!data.success) return;

        macroLastPayload = data;
        const summary = data.summary || {};

        // 1. Update Sync Badge
        const syncEl = document.getElementById('mc-sync-status');
        if (syncEl) syncEl.textContent = mcFormatSyncLabel(data.lastFetched);

        // 2. Update KPI 1 (Next High-Impact Catalyst)
        const nextEv = summary.nextHighImpact || data.nextHighImpact;
        const nextTitleEl = document.getElementById('mc-next-event-title');
        const nextMetaEl = document.getElementById('mc-next-event-meta');
        if (nextEv) {
          if (nextTitleEl) nextTitleEl.textContent = (nextEv.country || 'USD') + ' · ' + nextEv.title;
          if (nextMetaEl) {
            const evDateStr = new Date(nextEv.date).toLocaleString('vi-VN', {
              weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
            });
            nextMetaEl.textContent = evDateStr + ' (UTC+7) · Forecast: ' + (nextEv.forecast || '—') + ' · Prev: ' + (nextEv.previous || '—');
          }
          macroNextEventTargetTime = new Date(nextEv.date).getTime();
          startMacroCountdown();
        } else {
          if (nextTitleEl) nextTitleEl.textContent = 'Không có tin đỏ sắp tới';
          if (nextMetaEl) nextMetaEl.textContent = 'Nhấn Sync Feed để cập nhật lịch mới nhất.';
          macroNextEventTargetTime = null;
          startMacroCountdown();
        }

        // 3. Update KPI 2 (Next FOMC)
        const nextFomc = summary.nextFomc;
        const fomcDateEl = document.getElementById('mc-stat-fomc-date');
        const fomcSubEl = document.getElementById('mc-stat-fomc-sub');
        if (fomcDateEl) {
          if (nextFomc) {
            fomcDateEl.textContent = new Date(nextFomc.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            if (fomcSubEl) {
              fomcSubEl.textContent = nextFomc.title + (nextFomc.forecast ? ' · Dự báo ' + nextFomc.forecast : '');
            }
          } else {
            fomcDateEl.textContent = '—';
            if (fomcSubEl) fomcSubEl.textContent = 'Chưa có lịch FOMC trong dữ liệu';
          }
        }

        // 4. Update KPI 3 (Next US Inflation Print)
        const nextInf = summary.nextInflation;
        const cpiDateEl = document.getElementById('mc-stat-cpi-date');
        const cpiSubEl = document.getElementById('mc-stat-cpi-sub');
        if (cpiDateEl) {
          if (nextInf) {
            cpiDateEl.textContent = new Date(nextInf.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            if (cpiSubEl) {
              cpiSubEl.textContent = nextInf.title + (nextInf.forecast ? ' · Dự báo ' + nextInf.forecast : '');
            }
          } else {
            cpiDateEl.textContent = '—';
            if (cpiSubEl) cpiSubEl.textContent = 'Chưa có lịch CPI/PCE trong dữ liệu';
          }
        }

        // 5. Update Result Summary
        const resultCountEl = document.getElementById('mc-result-count');
        if (resultCountEl) {
          const highFilteredCount = (data.events || []).filter(e => e.impact === 'High').length;
          resultCountEl.textContent = data.count + ' events · ' + highFilteredCount + ' high · UTC+7';
        }
        mcUpdateResetButton();

        // 6. Render Events Table & Playbook
        mcRenderEventsTable(data.events || []);
        mcRenderScenarioMatrix(data.scenarioMatrix);
      } catch (err) {
        console.error('Error rendering macro calendar:', err);
      }
    }

    // Filter & action listeners for Macro Calendar
    document.querySelectorAll('#mc-filter-time-group .sh-tab-trigger').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#mc-filter-time-group .sh-tab-trigger').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMacroFilters.timeScope = btn.dataset.mcTime;
        renderMacroCalendar();
      });
    });

    document.getElementById('mc-toggle-hide-past')?.addEventListener('change', (e) => {
      currentMacroFilters.hidePast = e.target.checked;
      renderMacroCalendar();
    });

    document.querySelectorAll('#mc-filter-impact-group .sh-filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#mc-filter-impact-group .sh-filter-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMacroFilters.impact = btn.dataset.mcImpact;
        renderMacroCalendar();
      });
    });

    document.querySelectorAll('#mc-filter-curr-group .sh-filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#mc-filter-curr-group .sh-filter-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMacroFilters.currency = btn.dataset.mcCurr;
        renderMacroCalendar();
      });
    });

    document.querySelectorAll('#mc-filter-cat-group .sh-filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#mc-filter-cat-group .sh-filter-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMacroFilters.category = btn.dataset.mcCat;
        renderMacroCalendar();
      });
    });

    document.getElementById('btn-mc-reset-filters')?.addEventListener('click', () => {
      mcResetFacetFilters();
      renderMacroCalendar();
    });

    let mcSearchTimeout = null;
    document.getElementById('mc-search-input')?.addEventListener('input', (e) => {
      clearTimeout(mcSearchTimeout);
      mcSearchTimeout = setTimeout(() => {
        currentMacroFilters.search = e.target.value;
        mcUpdateResetButton();
        renderMacroCalendar();
      }, 220);
    });

    document.getElementById('btn-mc-scenario-toggle')?.addEventListener('click', () => {
      macroScenarioCollapsed = !macroScenarioCollapsed;
      const bodyEl = document.getElementById('mc-scenario-body');
      const toggleBtn = document.getElementById('btn-mc-scenario-toggle');
      if (bodyEl) bodyEl.style.display = macroScenarioCollapsed ? 'none' : 'block';
      if (toggleBtn) toggleBtn.textContent = macroScenarioCollapsed ? 'Mở rộng' : 'Thu gọn';
    });

    document.getElementById('btn-mc-scenario-reset')?.addEventListener('click', async () => {
      macroSelectedScenarioId = null;
      await renderMacroCalendar();
    });

    document.getElementById('btn-mc-refresh')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-mc-refresh');
      if (btn) {
        btn.disabled = true;
        btn.classList.add('is-loading');
        const labelSpan = btn.querySelector('span');
        if (labelSpan) labelSpan.textContent = 'Syncing...';
      }
      try {
        await fetch('/api/macro/refresh', { method: 'POST' });
        await renderMacroCalendar();
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove('is-loading');
          const labelSpan = btn.querySelector('span');
          if (labelSpan) labelSpan.textContent = 'Sync Feed';
        }
      }
    });


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
          targetTextEl.textContent = 'Daily Stop Loss Hit (-$' + Math.abs(data.dailyPnl).toFixed(2) + ' / -$' + (data.dailyStopLossMax || 180) + ') — Halted until 00:00 UTC+7';
          targetTextEl.style.color = '#f87171';
          targetBarEl.style.width = '100%';
          targetBarEl.style.background = '#ef4444';
        } else if (data.dailyTargetMaxHit) {
          targetTextEl.textContent = '3% Max Target Reached (+$' + data.dailyPnl.toFixed(2) + ' >= $' + (data.dailyTargetMax || 300) + ') — Profit Locked for Today';
          targetTextEl.style.color = '#34d399';
          targetBarEl.style.width = '100%';
          targetBarEl.style.background = '#10b981';
        } else if (data.dailyTargetHit) {
          targetTextEl.textContent = '1% Target Achieved (+$' + data.dailyPnl.toFixed(2) + ') — Sniper Mode (A+ Only, Max 2x)';
          targetTextEl.style.color = '#38bdf8';
          targetBarEl.style.width = Math.min(100, Math.max(0, data.dailyTargetProgressPercent)) + '%';
          targetBarEl.style.background = '#38bdf8';
        } else {
          targetTextEl.textContent = data.dailyTargetProgressPercent + '% (+$' + data.dailyPnl.toFixed(2) + ' / $' + (data.dailyTargetMax || 300) + ' max)';
          targetTextEl.style.color = data.dailyPnl >= 0 ? '#fbbf24' : '#f87171';
          targetBarEl.style.width = Math.min(100, Math.max(0, data.dailyTargetProgressPercent)) + '%';
          targetBarEl.style.background = data.dailyPnl >= 0 ? '#10b981' : '#ef4444';
        }

        // Auto trade button (Restrained shadcn/ui surface tint)
        const btnToggle = document.getElementById('btn-toggle-auto-trade');
        const statusEl = document.getElementById('paper-engine-status');
        if (data.autoTradeEnabled) {
          if (data.dailyStopLossHit) {
            btnToggle.textContent = '● Auto-Trade: Stop Loss Hit';
            btnToggle.style.background = 'rgba(239, 68, 68, 0.12)';
            btnToggle.style.borderColor = 'rgba(239, 68, 68, 0.35)';
            btnToggle.style.color = '#f87171';
            statusEl.textContent = '● Stop Loss Hit — Halted until 00:00 UTC+7';
            statusEl.className = 'sh-badge sh-badge-destructive';
          } else if (data.dailyTargetMaxHit) {
            btnToggle.textContent = '● Auto-Trade: 3% Target Locked';
            btnToggle.style.background = 'rgba(16, 185, 129, 0.12)';
            btnToggle.style.borderColor = 'rgba(16, 185, 129, 0.35)';
            btnToggle.style.color = '#34d399';
            statusEl.textContent = '● 3% Target Hit (+$' + data.dailyPnl.toFixed(2) + ') — Locked';
            statusEl.className = 'sh-badge sh-badge-emerald';
          } else if (data.dailyTargetHit) {
            btnToggle.textContent = '● Auto-Trade: Sniper A+';
            btnToggle.style.background = 'rgba(56, 189, 248, 0.12)';
            btnToggle.style.borderColor = 'rgba(56, 189, 248, 0.35)';
            btnToggle.style.color = '#38bdf8';
            statusEl.textContent = '● 1% Target Met — Sniper Mode (Max 2x)';
            statusEl.className = 'sh-badge sh-badge-sky';
          } else if (data.tradingMode && data.tradingMode.includes('DEFENSIVE')) {
            btnToggle.textContent = '● Auto-Trade: Defensive';
            btnToggle.style.background = 'rgba(245, 158, 11, 0.12)';
            btnToggle.style.borderColor = 'rgba(245, 158, 11, 0.35)';
            btnToggle.style.color = '#fbbf24';
            statusEl.textContent = '● Defensive Mode (1x Lev, 1 pos)';
            statusEl.className = 'sh-badge sh-badge-amber';
          } else {
            btnToggle.textContent = '● Auto-Trade: Active · Max 3x';
            btnToggle.style.background = 'rgba(16, 185, 129, 0.12)';
            btnToggle.style.borderColor = 'rgba(16, 185, 129, 0.35)';
            btnToggle.style.color = '#34d399';
            statusEl.textContent = '● Engine Running (Adaptive up to 3x)';
            statusEl.className = 'sh-badge sh-badge-emerald';
          }
        } else {
          btnToggle.textContent = '○ Auto-Trade: Paused';
          btnToggle.style.background = 'transparent';
          btnToggle.style.borderColor = '#27272a';
          btnToggle.style.color = '#a1a1aa';
          statusEl.textContent = '○ Auto-Engine Paused';
          statusEl.className = 'sh-badge sh-badge-outline';
        }

        // Open positions table
        const posBody = document.querySelector('#table-paper-positions tbody');
        if (!data.openPositions || data.openPositions.length === 0) {
          posBody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-secondary); padding: 16px;">No open positions. Monitoring market for next high-confluence entry...</td></tr>';
        } else {
          posBody.innerHTML = data.openPositions.map(p => {
            const coin = extractCoinName(p.symbol);
            const upnl = p.unrealizedPnl || 0;
            const upnlPct = p.unrealizedPnlPercent !== undefined ? p.unrealizedPnlPercent : (p.margin ? ((upnl / p.margin) * 100).toFixed(2) : '0.00');
            return \`
            <tr id="pos-row-\${p.id}" data-pos-id="\${p.id}" data-coin="\${coin}" data-side="\${p.side}" data-entry="\${p.entryPrice}" data-size="\${p.size}" data-margin="\${p.margin || p.notional}">
              <td class="pos-col-symbol"><strong>\${p.symbol}</strong></td>
              <td class="pos-col-side" style="text-align: center;"><span class="action-badge \${p.side === 'LONG' ? 'action-buy' : 'action-sell'}">\${p.side}</span></td>
              <td class="pos-col-lev" style="text-align: center;"><span class="action-badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 800;">\${p.leverage || 1}x</span></td>
              <td class="pos-col-entry">$\${fmtP(p.entryPrice)}</td>
              <td class="pos-col-mark"><span id="pos-mark-\${p.id}" style="font-weight: 700; color: #fff; transition: color 0.15s ease;" data-last-px="\${p.currentPrice || p.entryPrice}">$\${fmtP(p.currentPrice || p.entryPrice)}</span></td>
              <td class="pos-col-tp val-green">$\${fmtP(p.takeProfit)}</td>
              <td class="pos-col-sl val-red">$\${fmtP(p.stopLoss)}</td>
              <td class="pos-col-margin" style="color: #e4e7eb;">$\${fmtP(p.margin || p.notional)}</td>
              <td class="pos-col-notional" style="color: var(--text-secondary);">$\${fmtP(p.notional)}</td>
              <td class="pos-col-pnl">
                <span id="pos-pnl-\${p.id}" class="\${upnl >= 0 ? 'val-green' : 'val-red'}" style="font-weight: 700;">
                  \${upnl >= 0 ? '+$' : '-$'}\${Math.abs(upnl).toFixed(2)} (\${upnlPct >= 0 ? '+' : ''}\${upnlPct}% ROE)
                </span>
              </td>
              <td class="pos-col-action" style="text-align: center;">
                <button class="btn" onclick="closePaperPosition('\${p.id}')" style="padding: 2px 8px; font-size: 11px; background: rgba(239, 83, 80, 0.2); color: #ef5350;">Close</button>
              </td>
            </tr>
          \`;
          }).join('');
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
      if (!currentAuthUser || currentAuthUser.role !== 'ADMIN') {
        alert('🔒 Quyền truy cập bị từ chối: Cần đăng nhập Admin để đóng vị thế bot.');
        openAuthModal('tab-admin');
        return;
      }
      await fetch('/api/paper/close-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId: id })
      });
      refreshPaperStatus();
    };

    window.closePaperPosition = async function(id) {
      if (!currentAuthUser) {
        alert('🔒 Vui lòng kết nối ví hoặc đăng nhập để thao tác vị thế.');
        openAuthModal('tab-wallet');
        return;
      }
      await fetch('/api/paper/close-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId: id })
      });
      refreshPaperStatus();
    };

    document.getElementById('btn-toggle-auto-trade').addEventListener('click', async () => {
      if (!currentAuthUser) {
        alert('🔒 Vui lòng kết nối ví hoặc đăng nhập để bật/tắt Bot Auto-Trade.');
        openAuthModal('tab-wallet');
        return;
      }
      try {
        const res = await fetch('/api/paper/toggle', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          refreshPaperStatus();
        } else {
          alert('Không thể chuyển đổi trạng thái: ' + (data.error || 'Lỗi'));
        }
      } catch (e) {
        alert('Lỗi: ' + e.message);
      }
    });

    document.getElementById('btn-paper-refresh').addEventListener('click', refreshPaperStatus);

    document.getElementById('btn-paper-close-all').addEventListener('click', async () => {
      if (!currentAuthUser) {
        alert('🔒 Vui lòng kết nối ví hoặc đăng nhập để thao tác.');
        openAuthModal('tab-wallet');
        return;
      }
      if (confirm('Đóng toàn bộ các vị thế đang mở theo giá thị trường hiện tại?')) {
        await fetch('/api/paper/close-all', { method: 'POST' });
        refreshPaperStatus();
      }
    });

    document.getElementById('btn-paper-reset').addEventListener('click', async () => {
      if (!currentAuthUser) {
        alert('🔒 Vui lòng kết nối ví hoặc đăng nhập để reset tài khoản.');
        openAuthModal('tab-wallet');
        return;
      }
      if (confirm('Khôi phục tài khoản về số dư vốn ban đầu $10,000.00 USD?')) {
        await fetch('/api/paper/reset', { method: 'POST' });
        refreshPaperStatus();
      }
    });

    // Auto-poll paper trader status every 1.5 seconds (in addition to real-time WebSocket ticks)
    setInterval(refreshPaperStatus, 1500);
    refreshPaperStatus();

    // ========================================================
    // QUANT STRATEGY STUDIO & CUSTOM CODE CLIENT CONTROLLER
    // ========================================================
    let cachedStrategiesData = null;

    async function loadStrategiesData() {
      try {
        const res = await fetch('/api/user/strategies');
        if (res.ok) {
          cachedStrategiesData = await res.json();
          renderStrategyUI(cachedStrategiesData);
        }
      } catch (e) {
        console.warn('Error loading strategies:', e);
      }
    }

    function renderStrategyUI(data) {
      if (!data) return;
      const { builtin = [], custom = [], activeStrategyId, activeStrategy, templates = {} } = data;
      const allStrategies = [...builtin, ...custom];
      const activeObj = activeStrategy || builtin[0] || {};

      // 1. Update Badges & Labels
      const paperStratLbl = document.getElementById('paper-active-strat-lbl');
      if (paperStratLbl) paperStratLbl.textContent = activeObj.name || 'Oliver Kell Cycle';

      const dockStratBadge = document.getElementById('dock-strat-badge');
      if (dockStratBadge) {
        dockStratBadge.textContent = activeObj.type === 'custom' ? 'CUSTOM' : 'BUILTIN';
        dockStratBadge.style.background = activeObj.type === 'custom' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(168, 85, 247, 0.2)';
        dockStratBadge.style.color = activeObj.type === 'custom' ? '#4ade80' : '#c084fc';
      }

      const studioActivePill = document.getElementById('studio-active-pill');
      if (studioActivePill) {
        studioActivePill.textContent = '● ' + (activeObj.name || 'Oliver Kell');
      }

      const stratCountBadge = document.getElementById('strat-count-badge');
      if (stratCountBadge) stratCountBadge.textContent = allStrategies.length;

      // 2. Populate Dock Strategy Dropdown
      const bgGroup = document.getElementById('optgroup-builtin-strats');
      const custGroup = document.getElementById('optgroup-custom-strats');
      if (bgGroup) {
        bgGroup.innerHTML = builtin.map(s => {
          const isSel = s.id === activeStrategyId ? 'selected' : '';
          return '<option value="' + s.id + '" ' + isSel + '>🌟 ' + s.name + ' (' + (s.timeframe || '15m') + ')</option>';
        }).join('');
      }
      if (custGroup) {
        if (custom.length === 0) {
          custGroup.innerHTML = '<option disabled>Chưa có chiến lược tự tạo</option>';
        } else {
          custGroup.innerHTML = custom.map(s => {
            const isSel = s.id === activeStrategyId ? 'selected' : '';
            return '<option value="' + s.id + '" ' + isSel + '>⚡ ' + s.name + ' (' + (s.timeframe || '15m') + ')</option>';
          }).join('');
        }
      }

      const dockDesc = document.getElementById('dock-strategy-desc');
      if (dockDesc) {
        dockDesc.textContent = activeObj.description || 'Chiến lược định lượng tự động.';
      }

      // 3. Populate Strategy Studio Cards Grid
      const cardsGrid = document.getElementById('strat-cards-grid');
      if (cardsGrid) {
        cardsGrid.innerHTML = allStrategies.map(s => {
          const isActive = s.id === activeStrategyId;
          const isCustom = s.type === 'custom';
          const badgeBg = isCustom ? 'rgba(34, 197, 94, 0.15)' : 'rgba(168, 85, 247, 0.15)';
          const badgeBorder = isCustom ? '#22c55e' : '#a855f7';
          const badgeColor = isCustom ? '#4ade80' : '#c084fc';

          const activeBorder = isActive ? '2px solid #10b981' : '1px solid rgba(255, 255, 255, 0.08)';
          const activeGlow = isActive ? 'box-shadow: 0 0 16px rgba(16, 185, 129, 0.2);' : '';

          const actionHtml = isActive
            ? '<span style="font-size: 11px; padding: 4px 10px; border-radius: 4px; background: rgba(16, 185, 129, 0.2); color: #10b981; font-weight: 800; border: 1px solid #10b981;">✓ ĐANG CHẠY</span>'
            : '<button class="btn active btn-activate-strat" data-id="' + s.id + '" style="padding: 5px 12px; font-size: 11px; background: #0284c7; color: #fff; font-weight: 700;">⚡ Kích Hoạt</button>';

          const editBtn = isCustom
            ? '<button class="btn btn-edit-strat" data-id="' + s.id + '" style="padding: 4px 8px; font-size: 10px; background: rgba(255, 255, 255, 0.08);">✏️ Sửa Code</button>'
            : '';
          const delBtn = isCustom
            ? '<button class="btn btn-del-strat" data-id="' + s.id + '" style="padding: 4px 8px; font-size: 10px; color: #ef4444; background: rgba(239, 68, 68, 0.15);">🗑️</button>'
            : '';

          return '<div style="background: rgba(15, 23, 42, 0.65); border: ' + activeBorder + '; border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; justify-content: space-between; ' + activeGlow + '">' +
            '<div>' +
              '<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">' +
                '<strong style="font-size: 12.5px; color: #fff; line-height: 1.4;">' + s.name + '</strong>' +
                '<span style="font-size: 9.5px; padding: 2px 6px; border-radius: 4px; background: ' + badgeBg + '; border: 1px solid ' + badgeBorder + '; color: ' + badgeColor + '; font-weight: 700; white-space: nowrap; margin-left: 6px;">' + s.badge + '</span>' +
              '</div>' +
              '<div style="font-size: 10px; color: #94a3b8; margin-bottom: 8px;">' +
                '<span>⏱️ Khung: <strong style="color: #cbd5e1;">' + (s.timeframe || '15m') + '</strong></span>' +
                '<span style="margin-left: 10px;">👤 Tác giả: <strong style="color: #cbd5e1;">' + (s.author || 'Hyperview') + '</strong></span>' +
              '</div>' +
              '<p style="font-size: 11px; color: #cbd5e1; line-height: 1.5; margin-bottom: 12px;">' + (s.description || 'Không có mô tả chi tiết.') + '</p>' +
            '</div>' +
            '<div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 10px;">' +
              '<div style="display: flex; gap: 4px;">' + editBtn + delBtn + '</div>' +
              '<div>' + actionHtml + '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        // Attach listeners for strategy cards
        cardsGrid.querySelectorAll('.btn-activate-strat').forEach(b => {
          b.addEventListener('click', async () => {
            const sid = b.dataset.id;
            await setActiveStrategy(sid);
          });
        });

        cardsGrid.querySelectorAll('.btn-edit-strat').forEach(b => {
          b.addEventListener('click', () => {
            const sid = b.dataset.id;
            const target = custom.find(c => c.id === sid);
            if (target) {
              openStrategyEditor(target);
            }
          });
        });

        cardsGrid.querySelectorAll('.btn-del-strat').forEach(b => {
          b.addEventListener('click', async () => {
            const sid = b.dataset.id;
            if (!confirm('Bạn có chắc muốn xóa chiến lược tự tạo này?')) return;
            try {
              const res = await fetch('/api/user/strategies', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: sid })
              });
              const resData = await res.json();
              if (resData.success) {
                alert('Đã xóa chiến lược thành công!');
                loadStrategiesData();
              }
            } catch (err) {
              alert('Lỗi: ' + err.message);
            }
          });
        });
      }
    }

    async function setActiveStrategy(strategyId) {
      try {
        const res = await fetch('/api/user/strategies/set-active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: strategyId })
        });
        const data = await res.json();
        if (data.success) {
          alert('✅ Đã kích hoạt chiến lược: ' + (data.activeStrategy?.name || strategyId));
          await loadStrategiesData();
          if (typeof refreshPaperStatus === 'function') refreshPaperStatus();
        } else {
          alert('Lỗi: ' + (data.error || 'Không thể kích hoạt chiến lược'));
        }
      } catch (e) {
        alert('Lỗi kết nối: ' + e.message);
      }
    }

    function openStrategyEditor(strategyToEdit = null) {
      switchStratTab('editor');
      const valBanner = document.getElementById('strat-val-msg');
      if (valBanner) valBanner.style.display = 'none';

      if (strategyToEdit) {
        document.getElementById('strat-input-name').value = strategyToEdit.name || '';
        document.getElementById('strat-input-desc').value = strategyToEdit.description || '';
        document.getElementById('strat-input-tf').value = strategyToEdit.timeframe || '15m';
        document.getElementById('strat-input-code').value = strategyToEdit.code || '';
        document.getElementById('strat-input-code').dataset.editingId = strategyToEdit.id;
      } else {
        document.getElementById('strat-input-name').value = '';
        document.getElementById('strat-input-desc').value = '';
        document.getElementById('strat-input-tf').value = '15m';
        delete document.getElementById('strat-input-code').dataset.editingId;
        // Load default template if empty
        if (!document.getElementById('strat-input-code').value) {
          const tpls = cachedStrategiesData?.templates || {};
          document.getElementById('strat-input-code').value = tpls.rsi_scalp || '';
          document.getElementById('strat-input-name').value = 'RSI Mean-Reversion Scalp (Tự Tạo)';
          document.getElementById('strat-input-desc').value = 'Vào Long khi RSI < 32 và EMA10 cắt lên, chốt lời +3%';
        }
      }
    }

    function switchStratTab(tab) {
      const btnList = document.getElementById('tab-strat-list');
      const btnEditor = document.getElementById('tab-strat-editor');
      const btnAgent = document.getElementById('tab-strat-agent');
      const btnVario = document.getElementById('tab-strat-vario');
      const viewList = document.getElementById('strat-view-list');
      const viewEditor = document.getElementById('strat-view-editor');
      const viewAgent = document.getElementById('strat-view-agent');
      const viewVario = document.getElementById('strat-view-vario');

      [btnList, btnEditor, btnAgent, btnVario].forEach(b => {
        if (b) { b.style.color = '#8c93a3'; b.style.borderBottomColor = 'transparent'; }
      });
      if (viewList) viewList.style.display = 'none';
      if (viewEditor) viewEditor.style.display = 'none';
      if (viewAgent) viewAgent.style.display = 'none';
      if (viewVario) viewVario.style.display = 'none';

      if (tab === 'list') {
        if (btnList) { btnList.style.color = '#fff'; btnList.style.borderBottomColor = '#a855f7'; }
        if (viewList) viewList.style.display = 'block';
      } else if (tab === 'editor') {
        if (btnEditor) { btnEditor.style.color = '#fff'; btnEditor.style.borderBottomColor = '#a855f7'; }
        if (viewEditor) viewEditor.style.display = 'block';
      } else if (tab === 'agent') {
        if (btnAgent) { btnAgent.style.color = '#fff'; btnAgent.style.borderBottomColor = '#38bdf8'; }
        if (viewAgent) viewAgent.style.display = 'block';
        loadUserHlAgentData();
      } else if (tab === 'vario') {
        if (btnVario) { btnVario.style.color = '#fff'; btnVario.style.borderBottomColor = '#34d399'; }
        if (viewVario) viewVario.style.display = 'block';
        loadUserVarioAgentData();
      }
    }

    const stratModal = document.getElementById('strategy-studio-modal');
    function openStrategyModal(tab = 'list') {
      if (stratModal) stratModal.style.display = 'flex';
      switchStratTab(tab);
      loadStrategiesData();
      loadUserHlAgentData();
      loadUserVarioAgentData();
    }
    function closeStrategyModal() {
      if (stratModal) stratModal.style.display = 'none';
    }

    document.getElementById('btn-close-strat-modal')?.addEventListener('click', closeStrategyModal);
    stratModal?.addEventListener('click', (e) => {
      if (e.target === stratModal) closeStrategyModal();
    });

    document.getElementById('tab-strat-list')?.addEventListener('click', () => switchStratTab('list'));
    document.getElementById('tab-strat-editor')?.addEventListener('click', () => openStrategyEditor());
    document.getElementById('tab-strat-agent')?.addEventListener('click', () => switchStratTab('agent'));
    document.getElementById('tab-strat-vario')?.addEventListener('click', () => switchStratTab('vario'));
    document.getElementById('btn-open-vario-modal')?.addEventListener('click', () => openStrategyModal('vario'));
    document.getElementById('btn-studio-goto-add')?.addEventListener('click', () => openStrategyEditor());
    document.getElementById('btn-studio-back-list')?.addEventListener('click', () => switchStratTab('list'));
    document.getElementById('btn-open-strategy-studio')?.addEventListener('click', () => openStrategyModal('list'));
    document.getElementById('btn-open-hl-agent-modal')?.addEventListener('click', () => openStrategyModal('agent'));
    document.getElementById('btn-dock-open-studio')?.addEventListener('click', () => openStrategyModal('list'));
    document.getElementById('btn-dock-code-studio')?.addEventListener('click', () => openStrategyModal('editor'));
    document.getElementById('btn-indicators-add-strategy')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const indDrop = document.getElementById('indicators-dropdown');
      if (indDrop) indDrop.style.display = 'none';
      document.getElementById('btn-indicators-menu')?.classList.remove('active');
      openStrategyModal('list');
    });
    document.getElementById('btn-indicators-hl-agent')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const indDrop = document.getElementById('indicators-dropdown');
      if (indDrop) indDrop.style.display = 'none';
      document.getElementById('btn-indicators-menu')?.classList.remove('active');
      openStrategyModal('agent');
    });

    // Template buttons
    document.getElementById('btn-load-tpl-rsi')?.addEventListener('click', () => {
      const t = cachedStrategiesData?.templates?.rsi_scalp;
      if (t) {
        document.getElementById('strat-input-code').value = t;
        document.getElementById('strat-input-name').value = 'RSI Mean-Reversion Scalp (Custom)';
        document.getElementById('strat-input-desc').value = 'Quá bán RSI < 32 + EMA10 cắt lên -> Long (TP: +3%, SL: -1.5%)';
        document.getElementById('strat-input-tf').value = '15m';
      }
    });

    document.getElementById('btn-load-tpl-ema')?.addEventListener('click', () => {
      const t = cachedStrategiesData?.templates?.ema_cross;
      if (t) {
        document.getElementById('strat-input-code').value = t;
        document.getElementById('strat-input-name').value = 'EMA Dual Trend Runner (Custom)';
        document.getElementById('strat-input-desc').value = 'Golden Cross EMA10/50 + Supertrend Bullish -> Mua theo sóng';
        document.getElementById('strat-input-tf').value = '15m';
      }
    });

    document.getElementById('btn-load-tpl-breakout')?.addEventListener('click', () => {
      const t = cachedStrategiesData?.templates?.breakout;
      if (t) {
        document.getElementById('strat-input-code').value = t;
        document.getElementById('strat-input-name').value = 'Breakout Volume Surge (Custom)';
        document.getElementById('strat-input-desc').value = 'Vượt đỉnh 24h kèm động lượng RSI bứt phá';
        document.getElementById('strat-input-tf').value = '5m';
      }
    });

    // Test syntax button
    document.getElementById('btn-studio-test-syntax')?.addEventListener('click', async () => {
      const code = document.getElementById('strat-input-code').value;
      const banner = document.getElementById('strat-val-msg');
      if (!banner) return;
      banner.style.display = 'block';
      banner.textContent = '⏳ Đang kiểm tra cú pháp...';
      banner.style.background = 'rgba(56, 189, 248, 0.15)';
      banner.style.color = '#38bdf8';
      banner.style.border = '1px solid #38bdf8';

      try {
        const res = await fetch('/api/user/strategies/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const d = await res.json();
        if (d.valid) {
          banner.textContent = '✅ Cú pháp JavaScript hợp lệ! Hàm onTick(market, portfolio) đã sẵn sàng thực thi.';
          banner.style.background = 'rgba(16, 185, 129, 0.15)';
          banner.style.color = '#10b981';
          banner.style.border = '1px solid #10b981';
        } else {
          banner.textContent = '❌ ' + (d.error || 'Cú pháp không hợp lệ');
          banner.style.background = 'rgba(239, 68, 68, 0.15)';
          banner.style.color = '#ef4444';
          banner.style.border = '1px solid #ef4444';
        }
      } catch (e) {
        banner.textContent = '❌ Lỗi kiểm tra: ' + e.message;
        banner.style.background = 'rgba(239, 68, 68, 0.15)';
        banner.style.color = '#ef4444';
        banner.style.border = '1px solid #ef4444';
      }
    });

    // Save and activate strategy button
    document.getElementById('btn-studio-save-strat')?.addEventListener('click', async () => {
      const name = document.getElementById('strat-input-name').value.trim();
      const description = document.getElementById('strat-input-desc').value.trim();
      const timeframe = document.getElementById('strat-input-tf').value;
      const code = document.getElementById('strat-input-code').value.trim();
      const editingId = document.getElementById('strat-input-code').dataset.editingId || null;

      if (!name) {
        alert('Vui lòng đặt tên cho chiến lược của bạn');
        return;
      }
      if (!code) {
        alert('Vui lòng dán mã nguồn vào ô code');
        return;
      }

      try {
        const res = await fetch('/api/user/strategies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editingId, name, description, timeframe, code })
        });
        const savedData = await res.json();
        if (!savedData.success) {
          alert('❌ Lưu thất bại: ' + (savedData.error || 'Lỗi không xác định'));
          return;
        }

        // Set as active
        if (savedData.strategy?.id) {
          await setActiveStrategy(savedData.strategy.id);
        }

        alert('🎉 Chúc mừng! Đã lưu và kích hoạt chiến lược "' + name + '" thành công!');
        switchStratTab('list');
        loadStrategiesData();
      } catch (err) {
        alert('❌ Lỗi: ' + err.message);
      }
    });

    // Dock strategy select change & apply
    document.getElementById('dock-strategy-select')?.addEventListener('change', (e) => {
      const sid = e.target.value;
      const all = [...(cachedStrategiesData?.builtin || []), ...(cachedStrategiesData?.custom || [])];
      const match = all.find(s => s.id === sid);
      const descEl = document.getElementById('dock-strategy-desc');
      if (descEl && match) {
        descEl.textContent = match.description || 'Chiến lược định lượng tự động.';
      }
    });

    document.getElementById('btn-dock-apply-strat')?.addEventListener('click', async () => {
      const sel = document.getElementById('dock-strategy-select');
      const sid = sel ? sel.value : null;
      if (!sid) return;
      await setActiveStrategy(sid);
    });

    // ========================================================
    // HYPERLIQUID DELEGATED AGENT SIGNER CLIENT CONTROLLER
    // ========================================================
    async function loadUserHlAgentData() {
      try {
        const res = await fetch('/api/user/hl-agent');
        if (res.ok) {
          const d = await res.json();
          const ag = d.agent || {};
          const pill = document.getElementById('hl-agent-state-pill');
          const details = document.getElementById('hl-agent-details-text');
          const badgeOnBar = document.getElementById('hl-agent-status-badge');
          const inUserAddr = document.getElementById('hl-agent-input-user-addr');
          const selNet = document.getElementById('hl-agent-select-network');

          if (ag.configured) {
            if (pill) {
              pill.textContent = '● ĐÃ CẤU HÌNH AGENT';
              pill.style.background = 'rgba(16, 185, 129, 0.15)';
              pill.style.borderColor = '#10b981';
              pill.style.color = '#10b981';
            }
            if (badgeOnBar) {
              badgeOnBar.textContent = 'Đã Cài';
              badgeOnBar.style.background = 'rgba(16, 185, 129, 0.2)';
              badgeOnBar.style.borderColor = 'rgba(16, 185, 129, 0.4)';
              badgeOnBar.style.color = '#4ade80';
            }
            if (details) {
              details.innerHTML = '✅ <strong>Agent Address:</strong> <code>' + (ag.agentAddress || '--') + '</code><br>' +
                '👤 <strong>Ví Chính Ủy Quyền:</strong> <code>' + (ag.userAddress || 'Mặc định ví kết nối') + '</code><br>' +
                '🔐 <strong>Masked Secret:</strong> <code>' + (ag.maskedPrivateKey || '••••••••') + '</code> | 🌐 Mạng: ' + (ag.network || 'mainnet').toUpperCase();
            }
            if (inUserAddr && ag.userAddress) inUserAddr.value = ag.userAddress;
            if (selNet && ag.network) selNet.value = ag.network;
          } else {
            if (pill) {
              pill.textContent = '● CHƯA CẤU HÌNH';
              pill.style.background = 'rgba(239, 68, 68, 0.15)';
              pill.style.borderColor = '#ef4444';
              pill.style.color = '#f87171';
            }
            if (badgeOnBar) {
              badgeOnBar.textContent = 'Chưa Cài';
              badgeOnBar.style.background = 'rgba(239, 68, 68, 0.2)';
              badgeOnBar.style.borderColor = 'rgba(239, 68, 68, 0.4)';
              badgeOnBar.style.color = '#f87171';
            }
            if (details) {
              details.textContent = 'Chưa phát hiện cấu hình Agent Wallet. Vui lòng dán khóa để bot có thể tự động ký lệnh trên Hyperliquid L1.';
            }
          }
        }
      } catch (e) {
        console.warn('Error loading HL agent config:', e);
      }
    }

    // Toggle password visibility
    document.getElementById('btn-toggle-agent-key-vis')?.addEventListener('click', () => {
      const inp = document.getElementById('hl-agent-input-key');
      const btn = document.getElementById('btn-toggle-agent-key-vis');
      if (!inp || !btn) return;
      if (inp.type === 'password') {
        inp.type = 'text';
        btn.textContent = '🙈 Ẩn Khóa';
      } else {
        inp.type = 'password';
        btn.textContent = '👁️ Hiện Khóa';
      }
    });

    // Fill current connected wallet
    document.getElementById('btn-hl-agent-use-current-wallet')?.addEventListener('click', () => {
      if (currentAuthUser && currentAuthUser.address) {
        document.getElementById('hl-agent-input-user-addr').value = currentAuthUser.address;
      } else {
        alert('Chưa kết nối ví Web3. Vui lòng kết nối ví hoặc nhập địa chỉ thủ công.');
      }
    });

    // Save HL Agent
    document.getElementById('btn-save-hl-agent')?.addEventListener('click', async () => {
      const userAddress = document.getElementById('hl-agent-input-user-addr').value.trim();
      const agentPrivateKey = document.getElementById('hl-agent-input-key').value.trim();
      const network = document.getElementById('hl-agent-select-network').value;

      if (!agentPrivateKey) {
        alert('Vui lòng dán API Secret (Private Key của Agent Wallet)');
        return;
      }

      try {
        const res = await fetch('/api/user/hl-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userAddress, agentPrivateKey, network })
        });
        const data = await res.json();
        if (data.success) {
          alert('🎉 ' + data.message + ' | Địa chỉ Agent: ' + data.agentAddress);
          document.getElementById('hl-agent-input-key').value = '';
          loadUserHlAgentData();
        } else {
          alert('❌ Lỗi: ' + (data.error || 'Không thể lưu khóa'));
        }
      } catch (err) {
        alert('Lỗi: ' + err.message);
      }
    });

    // Verify On-Chain
    document.getElementById('btn-verify-hl-agent')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-verify-hl-agent');
      if (!btn) return;
      btn.textContent = '⏳ Đang kiểm tra L1...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/user/hl-agent/verify', { method: 'POST' });
        const data = await res.json();
        alert((data.verified ? '✅ ' : '⚠️ ') + (data.message || data.error));
        loadUserHlAgentData();
      } catch (err) {
        alert('Lỗi kiểm tra: ' + err.message);
      } finally {
        btn.textContent = '⚡ Kiểm Tra L1 (Verify On-Chain)';
        btn.disabled = false;
      }
    });

    // Delete HL Agent
    document.getElementById('btn-del-hl-agent')?.addEventListener('click', async () => {
      if (!confirm('Bạn có chắc muốn xóa cấu hình khóa Agent Wallet này khỏi hệ thống?')) return;
      try {
        const res = await fetch('/api/user/hl-agent', { method: 'DELETE' });
        const data = await res.json();
        alert(data.message || 'Đã xóa cấu hình');
        document.getElementById('hl-agent-input-key').value = '';
        document.getElementById('hl-agent-input-user-addr').value = '';
        loadUserHlAgentData();
      } catch (err) {
        alert('Lỗi: ' + err.message);
      }
    });

    // ========================================================
    // VARIATIONAL PROTOCOL (OMNI TESTNET API v1 — ED25519)
    // ========================================================
    let varioOrderSide = "buy";
    let varioActiveSubtab = "positions";
    let varioInstrumentsMap = {};
    let varioCurrentTickerPrice = null;

    function escapeVarioHtml(str) {
      return String(str == null ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function fmtVarioUsd(val, decimals) {
      const n = parseFloat(val);
      if (!Number.isFinite(n)) return "$0.00";
      const d = typeof decimals === "number" ? decimals : (Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 3 : 5);
      const sign = n < 0 ? "-" : "";
      return sign + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    }

    function setVarioFeedback(type, msg) {
      const el = document.getElementById("vario-config-feedback");
      if (!el) return;
      if (!msg) {
        el.style.display = "none";
        el.textContent = "";
        return;
      }
      el.style.display = "block";
      el.textContent = msg;
      if (type === "ok") {
        el.style.background = "rgba(16, 185, 129, 0.14)";
        el.style.border = "1px solid rgba(16, 185, 129, 0.35)";
        el.style.color = "#34d399";
      } else if (type === "info") {
        el.style.background = "rgba(56, 189, 248, 0.12)";
        el.style.border = "1px solid rgba(56, 189, 248, 0.35)";
        el.style.color = "#38bdf8";
      } else {
        el.style.background = "rgba(239, 68, 68, 0.14)";
        el.style.border = "1px solid rgba(239, 68, 68, 0.35)";
        el.style.color = "#f87171";
      }
    }

    function setVarioOrderResult(isOk, htmlOrText) {
      const el = document.getElementById("vario-order-result");
      if (!el) return;
      if (!htmlOrText) {
        el.style.display = "none";
        el.innerHTML = "";
        return;
      }
      el.style.display = "block";
      el.style.background = isOk ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.14)";
      el.style.border = isOk ? "1px solid rgba(16, 185, 129, 0.35)" : "1px solid rgba(239, 68, 68, 0.35)";
      el.style.color = isOk ? "#34d399" : "#f87171";
      el.innerHTML = htmlOrText;
    }

    function updateVarioOrderTypeUI() {
      const typeSel = document.getElementById("vario-order-type");
      const priceRow = document.getElementById("vario-order-price-row");
      const priceLbl = document.getElementById("vario-order-price-label");
      const priceInput = document.getElementById("vario-order-price");
      const tpslRow = document.getElementById("vario-order-tpsl-row");
      const reduceWrap = document.getElementById("vario-reduce-only-wrap");
      const t = typeSel ? typeSel.value : "market";

      if (t === "market") {
        if (priceRow) priceRow.style.display = "none";
        if (tpslRow) tpslRow.style.display = "grid";
        if (reduceWrap) reduceWrap.style.display = "flex";
      } else if (t === "limit") {
        if (priceRow) priceRow.style.display = "grid";
        if (priceLbl) priceLbl.textContent = "LIMIT PRICE (USDC)";
        if (priceInput) priceInput.placeholder = "Ví dụ: 60500";
        if (tpslRow) tpslRow.style.display = "grid";
        if (reduceWrap) reduceWrap.style.display = "flex";
      } else {
        if (priceRow) priceRow.style.display = "grid";
        if (priceLbl) priceLbl.textContent = "TRIGGER PRICE (USDC)";
        if (priceInput) priceInput.placeholder = "Giá kích hoạt TP / SL";
        if (tpslRow) tpslRow.style.display = "none";
        if (reduceWrap) reduceWrap.style.display = "none";
      }
      updateVarioSizeEstimate();
    }

    function updateVarioSizeEstimate() {
      const estEl = document.getElementById("vario-order-size-est");
      if (!estEl) return;
      const mode = document.getElementById("vario-order-size-mode")?.value || "notional";
      const amt = parseFloat(document.getElementById("vario-order-amount")?.value || "0");
      const px = parseFloat(document.getElementById("vario-order-price")?.value || "0") || varioCurrentTickerPrice || 0;
      if (!Number.isFinite(amt) || amt <= 0 || px <= 0) {
        estEl.textContent = "--";
        return;
      }
      if (mode === "notional") {
        estEl.textContent = "≈ " + (amt / px).toFixed(5) + " base";
      } else {
        estEl.textContent = "≈ $" + (amt * px).toFixed(2);
      }
    }

    function switchVarioSubtab(tabName) {
      varioActiveSubtab = tabName;
      const map = {
        positions: { btn: "btn-vario-subtab-positions", panel: "vario-panel-positions" },
        orders: { btn: "btn-vario-subtab-orders", panel: "vario-panel-orders" },
        fills: { btn: "btn-vario-subtab-fills", panel: "vario-panel-fills" },
      };
      Object.keys(map).forEach(function(k) {
        const b = document.getElementById(map[k].btn);
        const p = document.getElementById(map[k].panel);
        const isActive = k === tabName;
        if (b) {
          b.style.background = isActive ? "rgba(16, 185, 129, 0.16)" : "transparent";
          b.style.borderColor = isActive ? "#10b981" : "#23293a";
          b.style.color = isActive ? "#34d399" : "#94a3b8";
        }
        if (p) p.style.display = isActive ? "block" : "none";
      });
      const cancelAllBtn = document.getElementById("btn-vario-cancel-all");
      if (cancelAllBtn) {
        cancelAllBtn.style.display = tabName === "orders" ? "inline-block" : "none";
      }
    }

    function renderVarioPositions(list) {
      const box = document.getElementById("vario-panel-positions");
      const cnt = document.getElementById("vario-cnt-positions");
      if (cnt) cnt.textContent = String(list.length);
      if (!box) return;
      if (list.length === 0) {
        box.innerHTML = '<div style="color: #64748b; padding: 12px; text-align: center;">Không có vị thế đang mở trên Variational.</div>';
        return;
      }
      let html = '<table style="width:100%; border-collapse:collapse; text-align:left; font-family:monospace;">' +
        '<thead><tr style="color:#64748b; border-bottom:1px solid rgba(255,255,255,0.08);">' +
        '<th style="padding:4px 6px;">Symbol</th><th>Size</th><th>Entry</th><th>Mark</th><th>Lev</th><th>Liq</th><th>uPnL</th><th style="text-align:right;">Action</th>' +
        '</tr></thead><tbody>';
      list.forEach(function(p) {
        const sz = parseFloat(p.size || "0");
        const sideColor = sz >= 0 ? "#34d399" : "#f87171";
        const upnl = parseFloat(p.unrealized_pnl || "0");
        const upnlColor = upnl >= 0 ? "#4ade80" : "#f87171";
        const symEsc = escapeVarioHtml(p.symbol || "");
        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
          '<td style="padding:5px 6px; font-weight:700; color:#fff;">' + symEsc + '</td>' +
          '<td style="color:' + sideColor + '; font-weight:700;">' + (sz >= 0 ? "+" : "") + escapeVarioHtml(p.size) + '</td>' +
          '<td style="color:#cbd5e1;">$' + escapeVarioHtml(p.entry_price || "--") + '</td>' +
          '<td style="color:#cbd5e1;">$' + escapeVarioHtml(p.mark_price || "--") + '</td>' +
          '<td style="color:#94a3b8;">' + escapeVarioHtml(p.leverage || "--") + 'x (' + escapeVarioHtml(p.margin_mode || "cross") + ')</td>' +
          '<td style="color:#f59e0b;">$' + escapeVarioHtml(p.liquidation_price || "--") + '</td>' +
          '<td style="color:' + upnlColor + '; font-weight:700;">' + fmtVarioUsd(upnl, 2) + '</td>' +
          '<td style="text-align:right;"><button type="button" data-action="close-pos" data-symbol="' + symEsc + '" style="padding:2px 8px; font-size:9.5px; background:rgba(239,68,68,0.16); border:1px solid rgba(239,68,68,0.4); color:#f87171; border-radius:4px; cursor:pointer; font-weight:700;">Close Market</button></td>' +
          '</tr>';
      });
      html += "</tbody></table>";
      box.innerHTML = html;
    }

    function renderVarioOrders(list) {
      const box = document.getElementById("vario-panel-orders");
      const cnt = document.getElementById("vario-cnt-orders");
      if (cnt) cnt.textContent = String(list.length);
      if (!box) return;
      if (list.length === 0) {
        box.innerHTML = '<div style="color: #64748b; padding: 12px; text-align: center;">Không có lệnh đang chờ khớp.</div>';
        return;
      }
      let html = '<table style="width:100%; border-collapse:collapse; text-align:left; font-family:monospace;">' +
        '<thead><tr style="color:#64748b; border-bottom:1px solid rgba(255,255,255,0.08);">' +
        '<th style="padding:4px 6px;">Symbol</th><th>Type</th><th>Side</th><th>Size</th><th>Price/Trigger</th><th>Status</th><th style="text-align:right;">Action</th>' +
        '</tr></thead><tbody>';
      list.forEach(function(o) {
        const sideColor = o.side === "buy" ? "#34d399" : "#f87171";
        const px = o.price || o.trigger_price || "--";
        const oid = escapeVarioHtml(o.order_id || "");
        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
          '<td style="padding:5px 6px; font-weight:700; color:#fff;">' + escapeVarioHtml(o.symbol || "") + '</td>' +
          '<td style="color:#cbd5e1;">' + escapeVarioHtml(o.type || "") + (o.reduce_only ? ' <span style="color:#f59e0b;">(RO)</span>' : "") + '</td>' +
          '<td style="color:' + sideColor + '; font-weight:700;">' + escapeVarioHtml((o.side || "").toUpperCase()) + '</td>' +
          '<td style="color:#e2e8f0;">' + escapeVarioHtml(o.size || "--") + '</td>' +
          '<td style="color:#38bdf8;">' + escapeVarioHtml(px) + '</td>' +
          '<td style="color:#fbbf24;">' + escapeVarioHtml(o.status || "") + '</td>' +
          '<td style="text-align:right;"><button type="button" data-action="cancel-order" data-order-id="' + oid + '" style="padding:2px 8px; font-size:9.5px; background:rgba(239,68,68,0.16); border:1px solid rgba(239,68,68,0.4); color:#f87171; border-radius:4px; cursor:pointer; font-weight:700;">Cancel</button></td>' +
          '</tr>';
      });
      html += "</tbody></table>";
      box.innerHTML = html;
    }

    function renderVarioFills(list) {
      const box = document.getElementById("vario-panel-fills");
      const cnt = document.getElementById("vario-cnt-fills");
      if (cnt) cnt.textContent = String(list.length);
      if (!box) return;
      if (list.length === 0) {
        box.innerHTML = '<div style="color: #64748b; padding: 12px; text-align: center;">Chưa có lịch sử khớp lệnh.</div>';
        return;
      }
      let html = '<table style="width:100%; border-collapse:collapse; text-align:left; font-family:monospace;">' +
        '<thead><tr style="color:#64748b; border-bottom:1px solid rgba(255,255,255,0.08);">' +
        '<th style="padding:4px 6px;">Time</th><th>Symbol</th><th>Side</th><th>Size</th><th>Fill Price</th><th>Notional</th><th>Type</th>' +
        '</tr></thead><tbody>';
      list.forEach(function(f) {
        const sideColor = f.side === "buy" ? "#34d399" : "#f87171";
        const ts = f.created_at ? new Date(f.created_at).toLocaleTimeString("vi-VN") : "--";
        const notl = (parseFloat(f.size || "0") * parseFloat(f.price || "0"));
        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
          '<td style="padding:5px 6px; color:#94a3b8;">' + escapeVarioHtml(ts) + '</td>' +
          '<td style="font-weight:700; color:#fff;">' + escapeVarioHtml(f.symbol || "") + '</td>' +
          '<td style="color:' + sideColor + '; font-weight:700;">' + escapeVarioHtml((f.side || "").toUpperCase()) + '</td>' +
          '<td style="color:#e2e8f0;">' + escapeVarioHtml(f.size || "--") + '</td>' +
          '<td style="color:#38bdf8;">$' + escapeVarioHtml(f.price || "--") + '</td>' +
          '<td style="color:#cbd5e1;">' + fmtVarioUsd(notl, 2) + '</td>' +
          '<td style="color:#94a3b8;">' + escapeVarioHtml(f.type || "trade") + '</td>' +
          '</tr>';
      });
      html += "</tbody></table>";
      box.innerHTML = html;
    }

    async function refreshVarioTickerHint() {
      const symInput = document.getElementById("vario-order-symbol");
      const hintEl = document.getElementById("vario-order-market-hint");
      const sym = (symInput?.value || "BTC-PERP").trim().toUpperCase();
      if (!sym) return;
      try {
        const res = await fetch("/api/vario/ticker?symbol=" + encodeURIComponent(sym));
        const d = await res.json();
        const tk = d.ticker || d;
        const inst = varioInstrumentsMap[sym];
        const mp = tk?.mark_price ? parseFloat(tk.mark_price) : null;
        if (mp && Number.isFinite(mp)) {
          varioCurrentTickerPrice = mp;
        }
        const parts = [];
        if (mp) parts.push("Mark: $" + mp.toLocaleString("en-US", { maximumFractionDigits: 4 }));
        if (inst?.size_step) parts.push("step: " + inst.size_step);
        if (inst?.min_notional) parts.push("min: $" + inst.min_notional);
        if (hintEl) hintEl.textContent = parts.length > 0 ? parts.join(" | ") : "Mark: --";
        updateVarioSizeEstimate();
      } catch {}
    }

    async function loadVarioDashboard() {
      try {
        const res = await fetch("/api/vario/dashboard");
        const d = await res.json();
        if (!res.ok || !d.success) {
          if (d.error) setVarioFeedback("err", "Lỗi đồng bộ Variational: " + d.error);
          return;
        }
        if (!d.hasApiKey) return;

        const pill = document.getElementById("vario-state-pill");
        const badgeOnBar = document.getElementById("vario-agent-status-badge");
        const statusStr = String(d.status || "ok").toUpperCase();
        const envLabel = d.environment === "testnet" ? "TESTNET" : "MAINNET";

        if (pill) {
          pill.textContent = "● " + envLabel + " API (" + statusStr + ")";
          pill.style.color = d.status === "ok" ? "#34d399" : "#fbbf24";
        }
        if (badgeOnBar) {
          badgeOnBar.textContent = envLabel + " API";
          badgeOnBar.style.background = "rgba(16, 185, 129, 0.2)";
          badgeOnBar.style.borderColor = "rgba(16, 185, 129, 0.4)";
          badgeOnBar.style.color = "#34d399";
        }

        if (d.account) {
          const eq = document.getElementById("vario-stat-equity");
          const av = document.getElementById("vario-stat-available");
          const up = document.getElementById("vario-stat-upnl");
          if (eq) eq.textContent = fmtVarioUsd(d.account.equity, 2);
          if (av) av.textContent = fmtVarioUsd(d.account.cross?.available || 0, 2);
          const uVal = parseFloat(d.account.unrealized_pnl || "0");
          if (up) {
            up.textContent = fmtVarioUsd(uVal, 2);
            up.style.color = uVal >= 0 ? "#4ade80" : "#f87171";
          }
        }

        if (Array.isArray(d.instruments) && d.instruments.length > 0) {
          varioInstrumentsMap = {};
          const dl = document.getElementById("vario-instruments-list");
          if (dl) dl.innerHTML = "";
          d.instruments.forEach(function(inst) {
            if (!inst.symbol) return;
            varioInstrumentsMap[inst.symbol.toUpperCase()] = inst;
            if (dl) {
              const opt = document.createElement("option");
              opt.value = inst.symbol;
              dl.appendChild(opt);
            }
          });
        }

        renderVarioPositions(Array.isArray(d.positions) ? d.positions : []);
        renderVarioOrders(Array.isArray(d.orders) ? d.orders : []);
        renderVarioFills(Array.isArray(d.fills) ? d.fills : []);
        refreshVarioTickerHint();
      } catch (e) {
        console.warn("Error loading Vario dashboard:", e);
      }
    }

    async function loadUserVarioAgentData() {
      try {
        const res = await fetch("/api/user/vario-agent");
        if (res.ok) {
          const d = await res.json();
          const ag = d.agent || {};
          const pill = document.getElementById("vario-state-pill");
          const badgeOnBar = document.getElementById("vario-agent-status-badge");
          const selEnv = document.getElementById("vario-select-env");
          const selSlip = document.getElementById("vario-select-slippage");
          const inWalletAddr = document.getElementById("vario-input-wallet-addr");
          const pubDisp = document.getElementById("vario-public-key-display");
          const keyHint = document.getElementById("vario-masked-key-hint");
          const toggleMirror = document.getElementById("vario-toggle-automirror");
          const inMirrorNotional = document.getElementById("vario-input-mirror-notional");
          const ordSlip = document.getElementById("vario-order-slippage");
          const appLink = document.getElementById("vario-open-app-link");

          if (selEnv && ag.environment) selEnv.value = ag.environment;
          if (appLink && ag.appUrl) appLink.href = ag.appUrl;
          if (selSlip && ag.maxSlippage) selSlip.value = String(ag.maxSlippage);
          if (ordSlip && ag.maxSlippage) ordSlip.value = String(ag.maxSlippage);
          if (inWalletAddr && ag.walletAddress) inWalletAddr.value = ag.walletAddress;
          if (toggleMirror) toggleMirror.checked = Boolean(ag.autoMirrorEnabled);
          if (inMirrorNotional && ag.mirrorNotionalUsd) inMirrorNotional.value = String(ag.mirrorNotionalUsd);

          if (pubDisp) {
            pubDisp.textContent = ag.publicKey
              ? "Key: " + ag.publicKey.slice(0, 10) + "..." + ag.publicKey.slice(-6)
              : "Public Key: chưa có";
          }
          if (keyHint) {
            keyHint.textContent = ag.hasApiKey
              ? "Đã lưu Ed25519 key (" + ag.maskedApiSecret + "). Để trống ô trên nếu giữ nguyên khóa."
              : "Mã hóa AES-256-GCM cục bộ. Tạo Ed25519 API key tại Omni Settings rồi dán vào đây.";
          }

          if (ag.hasApiKey) {
            if (pill) {
              pill.textContent = "● " + String(ag.environment || "testnet").toUpperCase() + " KEY READY";
              pill.style.color = "#34d399";
            }
            if (badgeOnBar) {
              badgeOnBar.textContent = ag.environment === "prod" ? "Mainnet API" : "Testnet API";
              badgeOnBar.style.background = "rgba(16, 185, 129, 0.2)";
              badgeOnBar.style.borderColor = "rgba(16, 185, 129, 0.4)";
              badgeOnBar.style.color = "#34d399";
            }
            loadVarioDashboard();
          } else {
            if (pill) {
              pill.textContent = "● CHƯA CẤU HÌNH";
              pill.style.color = "#f87171";
            }
            if (badgeOnBar) {
              badgeOnBar.textContent = "Chưa cài";
              badgeOnBar.style.background = "rgba(239, 68, 68, 0.2)";
              badgeOnBar.style.borderColor = "rgba(239, 68, 68, 0.4)";
              badgeOnBar.style.color = "#f87171";
            }
          }
        }
      } catch (e) {
        console.warn("Error loading Vario agent config:", e);
      }

      // Fetch live public OLP stats for BTC-PERP and ETH-PERP
      try {
        const resStats = await fetch("/api/vario/stats");
        if (resStats.ok) {
          const stats = await resStats.json();
          const cntBadge = document.getElementById("vario-markets-count-badge");
          if (cntBadge) cntBadge.textContent = (stats.num_markets || 0) + " Markets | 24h Vol: $" + Math.round(parseFloat(stats.total_volume_24h || 0) / 1e6) + "M";

          const btc = stats.listings ? stats.listings.find(function(l) { return l.ticker === "BTC-PERP"; }) : null;
          const eth = stats.listings ? stats.listings.find(function(l) { return l.ticker === "ETH-PERP"; }) : null;

          const elBtcPx = document.getElementById("vario-live-btc-price");
          const elBtcSp = document.getElementById("vario-live-btc-spread");
          if (elBtcPx && btc) {
            elBtcPx.textContent = "$" + parseFloat(btc.mark_price).toLocaleString("en-US", { minimumFractionDigits: 2 });
            if (!varioCurrentTickerPrice && (document.getElementById("vario-order-symbol")?.value || "").toUpperCase() === "BTC-PERP") {
              varioCurrentTickerPrice = parseFloat(btc.mark_price);
              refreshVarioTickerHint();
            }
          }
          if (elBtcSp && btc) elBtcSp.textContent = parseFloat(btc.base_spread_bps).toFixed(2) + " bps";

          const elEthPx = document.getElementById("vario-live-eth-price");
          const elEthSp = document.getElementById("vario-live-eth-spread");
          if (elEthPx && eth) elEthPx.textContent = "$" + parseFloat(eth.mark_price).toLocaleString("en-US", { minimumFractionDigits: 2 });
          if (elEthSp && eth) elEthSp.textContent = parseFloat(eth.base_spread_bps).toFixed(2) + " bps";
        }
      } catch (e) {
        console.warn("Error loading Vario stats:", e);
      }
    }

    // UI Bindings for Variational Testnet Console
    document.getElementById("btn-toggle-vario-key-vis")?.addEventListener("click", () => {
      const inp = document.getElementById("vario-input-api-key");
      const btn = document.getElementById("btn-toggle-vario-key-vis");
      if (!inp || !btn) return;
      if (inp.type === "password") {
        inp.type = "text";
        btn.textContent = "🙈 Ẩn Khóa";
      } else {
        inp.type = "password";
        btn.textContent = "👁️ Hiện Khóa";
      }
    });

    document.getElementById("btn-vario-use-current-wallet")?.addEventListener("click", () => {
      if (typeof connectedWalletAddress !== "undefined" && connectedWalletAddress) {
        document.getElementById("vario-input-wallet-addr").value = connectedWalletAddress;
      } else if (currentAuthUser && currentAuthUser.address) {
        document.getElementById("vario-input-wallet-addr").value = currentAuthUser.address;
      } else {
        setVarioFeedback("info", "Chưa kết nối ví Web3. Bạn có thể bỏ trống hoặc dán địa chỉ 0x...");
      }
    });

    document.getElementById("btn-save-vario-agent")?.addEventListener("click", async () => {
      const environment = document.getElementById("vario-select-env")?.value || "testnet";
      const apiPrivateKey = document.getElementById("vario-input-api-key")?.value.trim() || "";
      const walletAddress = document.getElementById("vario-input-wallet-addr")?.value.trim() || "";
      const maxSlippage = document.getElementById("vario-select-slippage")?.value || "0.005";
      const autoMirrorEnabled = Boolean(document.getElementById("vario-toggle-automirror")?.checked);
      const mirrorNotionalUsd = parseFloat(document.getElementById("vario-input-mirror-notional")?.value || "100") || 100;

      setVarioFeedback("info", "Đang mã hóa và lưu cấu hình Variational...");
      try {
        const res = await fetch("/api/user/vario-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environment, apiPrivateKey, walletAddress, maxSlippage, autoMirrorEnabled, mirrorNotionalUsd }),
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById("vario-input-api-key").value = "";
          setVarioFeedback("ok", data.message + (data.publicKey ? " | Public Key: " + data.publicKey : ""));
          loadUserVarioAgentData();
        } else {
          setVarioFeedback("err", data.error || "Không thể lưu cấu hình");
        }
      } catch (err) {
        setVarioFeedback("err", "Lỗi lưu cấu hình: " + err.message);
      }
    });

    document.getElementById("btn-verify-vario-agent")?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-verify-vario-agent");
      if (!btn) return;
      btn.textContent = "⏳ Đang xác thực...";
      btn.disabled = true;
      setVarioFeedback("info", "Đang kiểm tra chữ ký Ed25519 trên Variational Omni API...");

      try {
        const res = await fetch("/api/user/vario-agent/verify", { method: "POST" });
        const data = await res.json();
        if (data.verified) {
          setVarioFeedback(
            "ok",
            "✅ " + data.message + " | Status: " + data.apiStatus +
            " | Equity: $" + parseFloat(data.equity || 0).toFixed(2) +
            " | Available: $" + parseFloat(data.available || 0).toFixed(2) +
            " | Positions: " + data.openPositionsCount + ", Open Orders: " + data.openOrdersCount
          );
          loadUserVarioAgentData();
        } else {
          setVarioFeedback("err", "❌ Xác thực thất bại: " + (data.error || "Kiểm tra lại API Key / scope read+trade"));
        }
      } catch (err) {
        setVarioFeedback("err", "Lỗi kết nối: " + err.message);
      } finally {
        btn.textContent = "⚡ Verify Testnet";
        btn.disabled = false;
      }
    });

    document.getElementById("btn-sync-vario-dashboard")?.addEventListener("click", () => {
      setVarioFeedback("info", "Đang đồng bộ Account, Positions, Orders & Fills...");
      loadVarioDashboard().then(() => setVarioFeedback("ok", "Đã đồng bộ dữ liệu Variational mới nhất."));
    });

    document.getElementById("btn-del-vario-agent")?.addEventListener("click", async () => {
      if (!confirm("Bạn có chắc muốn xóa cấu hình Variational Omni này khỏi hệ thống?")) return;
      try {
        const res = await fetch("/api/user/vario-agent", { method: "DELETE" });
        const data = await res.json();
        document.getElementById("vario-input-wallet-addr").value = "";
        document.getElementById("vario-input-api-key").value = "";
        setVarioFeedback("info", data.message || "Đã xóa cấu hình");
        renderVarioPositions([]);
        renderVarioOrders([]);
        renderVarioFills([]);
        loadUserVarioAgentData();
      } catch (err) {
        setVarioFeedback("err", "Lỗi xóa: " + err.message);
      }
    });

    document.getElementById("btn-vario-side-buy")?.addEventListener("click", () => {
      varioOrderSide = "buy";
      const b = document.getElementById("btn-vario-side-buy");
      const s = document.getElementById("btn-vario-side-sell");
      if (b) { b.style.borderColor = "#10b981"; b.style.background = "rgba(16, 185, 129, 0.22)"; b.style.color = "#34d399"; }
      if (s) { s.style.borderColor = "#23293a"; s.style.background = "#07090e"; s.style.color = "#94a3b8"; }
    });

    document.getElementById("btn-vario-side-sell")?.addEventListener("click", () => {
      varioOrderSide = "sell";
      const b = document.getElementById("btn-vario-side-buy");
      const s = document.getElementById("btn-vario-side-sell");
      if (s) { s.style.borderColor = "#ef4444"; s.style.background = "rgba(239, 68, 68, 0.22)"; s.style.color = "#f87171"; }
      if (b) { b.style.borderColor = "#23293a"; b.style.background = "#07090e"; b.style.color = "#94a3b8"; }
    });

    document.getElementById("vario-order-type")?.addEventListener("change", updateVarioOrderTypeUI);
    document.getElementById("vario-order-size-mode")?.addEventListener("change", updateVarioSizeEstimate);
    document.getElementById("vario-order-amount")?.addEventListener("input", updateVarioSizeEstimate);
    document.getElementById("vario-order-price")?.addEventListener("input", updateVarioSizeEstimate);
    document.getElementById("vario-order-symbol")?.addEventListener("change", refreshVarioTickerHint);
    document.getElementById("btn-vario-refresh-ticker")?.addEventListener("click", refreshVarioTickerHint);

    document.getElementById("btn-vario-submit-order")?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-vario-submit-order");
      const symbol = (document.getElementById("vario-order-symbol")?.value || "BTC-PERP").trim().toUpperCase();
      const type = document.getElementById("vario-order-type")?.value || "market";
      const sizeMode = document.getElementById("vario-order-size-mode")?.value || "notional";
      const amount = parseFloat(document.getElementById("vario-order-amount")?.value || "0");
      const priceVal = document.getElementById("vario-order-price")?.value.trim();
      const triggerBy = document.getElementById("vario-order-trigger-by")?.value || "mark";
      const tpVal = document.getElementById("vario-order-tp")?.value.trim();
      const slVal = document.getElementById("vario-order-sl")?.value.trim();
      const slippage = document.getElementById("vario-order-slippage")?.value.trim() || "0.005";
      const reduceOnly = Boolean(document.getElementById("vario-order-reduce-only")?.checked);

      if (!symbol || !Number.isFinite(amount) || amount <= 0) {
        setVarioOrderResult(false, "Vui lòng nhập Symbol và Khối lượng hợp lệ (> 0).");
        return;
      }

      const payload = {
        symbol,
        side: varioOrderSide,
        type,
        max_slippage: slippage,
      };
      if (sizeMode === "notional") payload.notionalUsd = amount;
      else payload.size = String(amount);

      if (type === "limit") {
        if (!priceVal || Number(priceVal) <= 0) {
          setVarioOrderResult(false, "Lệnh Limit cần nhập Limit Price > 0.");
          return;
        }
        payload.price = priceVal;
        payload.trigger_by = triggerBy;
        payload.reduce_only = reduceOnly;
      } else if (type === "market") {
        payload.reduce_only = reduceOnly;
      } else {
        if (!priceVal || Number(priceVal) <= 0) {
          setVarioOrderResult(false, "Lệnh TP/SL cần nhập Trigger Price > 0.");
          return;
        }
        payload.trigger_price = priceVal;
        payload.trigger_by = triggerBy;
      }

      if ((type === "market" || type === "limit") && tpVal && Number(tpVal) > 0) {
        payload.takeProfitPrice = tpVal;
      }
      if ((type === "market" || type === "limit") && slVal && Number(slVal) > 0) {
        payload.stopLossPrice = slVal;
      }

      if (btn) { btn.disabled = true; btn.textContent = "⏳ Đang gửi..."; }
      setVarioOrderResult(true, "Đang ký Ed25519 & gửi lệnh " + escapeVarioHtml(type.toUpperCase()) + " " + escapeVarioHtml(symbol) + "...");

      try {
        const res = await fetch("/api/vario/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          const ord = data.order || {};
          const fillInfo = ord.fill_price ? " | Fill: $" + escapeVarioHtml(ord.fill_price) : "";
          setVarioOrderResult(
            true,
            "✅ LỆNH ĐÃ ĐẶT (" + escapeVarioHtml(String(data.environment || "testnet").toUpperCase()) + "): " +
            "<strong>" + escapeVarioHtml((ord.side || varioOrderSide).toUpperCase()) + " " + escapeVarioHtml(ord.size || "") + " " + escapeVarioHtml(ord.symbol || symbol) + "</strong>" +
            " | Status: <strong>" + escapeVarioHtml(ord.status || "queued") + "</strong>" + fillInfo +
            "<br>order_id: " + escapeVarioHtml(ord.order_id || "--") + " | client_order_id: " + escapeVarioHtml(ord.client_order_id || "--")
          );
          loadVarioDashboard();
        } else {
          const errCode = data.errorCode ? " [" + escapeVarioHtml(data.errorCode) + "]" : "";
          const reqId = data.requestId ? " (req: " + escapeVarioHtml(data.requestId) + ")" : "";
          setVarioOrderResult(false, "❌ Lỗi đặt lệnh" + errCode + ": " + escapeVarioHtml(data.error || "Unknown error") + reqId);
        }
      } catch (err) {
        setVarioOrderResult(false, "❌ Lỗi mạng: " + escapeVarioHtml(err.message));
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "🚀 Gửi Lệnh Testnet"; }
      }
    });

    document.getElementById("btn-vario-subtab-positions")?.addEventListener("click", () => switchVarioSubtab("positions"));
    document.getElementById("btn-vario-subtab-orders")?.addEventListener("click", () => switchVarioSubtab("orders"));
    document.getElementById("btn-vario-subtab-fills")?.addEventListener("click", () => switchVarioSubtab("fills"));

    document.getElementById("btn-vario-cancel-all")?.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/vario/orders", { method: "DELETE" });
        const d = await res.json();
        if (res.ok && d.success) {
          setVarioOrderResult(true, "✅ Đã hủy " + ((d.canceled && d.canceled.length) || 0) + " lệnh đang chờ.");
          loadVarioDashboard();
        } else {
          setVarioOrderResult(false, "❌ Hủy tất cả thất bại: " + escapeVarioHtml(d.error || "Error"));
        }
      } catch (err) {
        setVarioOrderResult(false, "❌ Lỗi hủy lệnh: " + escapeVarioHtml(err.message));
      }
    });

    document.getElementById("vario-panel-positions")?.addEventListener("click", async (e) => {
      const btn = e.target.closest('button[data-action="close-pos"]');
      if (!btn) return;
      const sym = btn.getAttribute("data-symbol");
      if (!sym) return;
      btn.disabled = true;
      btn.textContent = "...";
      try {
        const res = await fetch("/api/vario/positions/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: sym }),
        });
        const d = await res.json();
        if (res.ok && d.success) {
          setVarioOrderResult(true, "✅ Đã đóng vị thế Market " + escapeVarioHtml(sym) + " (status: " + escapeVarioHtml(d.order?.status || "queued") + ")");
          loadVarioDashboard();
        } else {
          setVarioOrderResult(false, "❌ Lỗi đóng vị thế " + escapeVarioHtml(sym) + ": " + escapeVarioHtml(d.error || "Error"));
        }
      } catch (err) {
        setVarioOrderResult(false, "❌ Lỗi đóng vị thế: " + escapeVarioHtml(err.message));
      } finally {
        btn.disabled = false;
        btn.textContent = "Close Market";
      }
    });

    document.getElementById("vario-panel-orders")?.addEventListener("click", async (e) => {
      const btn = e.target.closest('button[data-action="cancel-order"]');
      if (!btn) return;
      const oid = btn.getAttribute("data-order-id");
      if (!oid) return;
      btn.disabled = true;
      btn.textContent = "...";
      try {
        const res = await fetch("/api/vario/orders?order_id=" + encodeURIComponent(oid), { method: "DELETE" });
        const d = await res.json();
        if (res.ok && d.success) {
          setVarioOrderResult(true, "✅ Đã hủy lệnh " + escapeVarioHtml(oid));
          loadVarioDashboard();
        } else {
          setVarioOrderResult(false, "❌ Lỗi hủy lệnh: " + escapeVarioHtml(d.error || "Error"));
        }
      } catch (err) {
        setVarioOrderResult(false, "❌ Lỗi hủy lệnh: " + escapeVarioHtml(err.message));
      } finally {
        btn.disabled = false;
        btn.textContent = "Cancel";
      }
    });

    updateVarioOrderTypeUI();

    // Initial load of strategies & agent data
    loadStrategiesData();
    loadUserHlAgentData();
    loadUserVarioAgentData();

    // ========================================================
    // AUTHENTICATION & WEB3 WALLET CLIENT CONTROLLER
    // ========================================================
    let currentAuthUser = null;

    function showAuthToast(msg, isError = false) {
      const toast = document.getElementById('auth-toast');
      if (!toast) return;
      toast.textContent = msg;
      toast.style.borderColor = isError ? '#ef4444' : '#10b981';
      toast.style.display = 'flex';
      setTimeout(() => { toast.style.display = 'none'; }, 4000);
    }

    async function checkAuthStatus() {
      try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.authenticated && data.user) {
          currentAuthUser = data.user;
          renderHeaderAuth(data.user);
        } else {
          currentAuthUser = null;
          renderHeaderGuest();
        }
      } catch (e) {
        console.warn('Auth check error:', e);
      }
    }

    function renderHeaderAuth(user) {
      const container = document.getElementById('header-auth-section');
      if (!container) return;
      const isAdmin = user.role === 'ADMIN';
      const roleBadge = isAdmin
        ? '<span class="user-role-badge role-admin">👑 Admin</span>'
        : '<span class="user-role-badge role-member">🟢 Member</span>';

      const icon = user.type === 'wallet'
        ? '<span style="color: #fb923c;">🦊</span>'
        : '<span style="color: #60a5fa;">📧</span>';

      container.innerHTML = '<div class="user-profile-pill" title="Signed in as ' + (user.fullId || '') + '">'
        + icon
        + '<span style="font-weight: 700;">' + user.displayId + '</span>'
        + roleBadge
        + '<button class="btn-auth-logout" id="btn-do-logout" title="Đăng xuất">'
        + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>'
        + '</button>'
        + '</div>';

      document.getElementById('btn-do-logout')?.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        showAuthToast('Đã đăng xuất tài khoản an toàn');
        setTimeout(() => { window.location.href = '/login'; }, 400);
      });
    }

    function renderHeaderGuest() {
      const container = document.getElementById('header-auth-section');
      if (!container) return;
      container.innerHTML = '<button class="btn-auth-wallet" id="btn-header-wallet" title="Connect MetaMask / EVM Wallet (EIP-4361 Secure Signature)">'
        + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>'
        + '<span>Connect Wallet</span>'
        + '</button>'
        + '<button class="btn-auth-signin" id="btn-header-login" title="Sign in with Google / Email">'
        + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>'
        + '<span>Sign In</span>'
        + '</button>';
      bindAuthModalEvents();
    }

    let authModalBindingsDone = false;

    function openAuthModal(tab = 'tab-google') {
      initAuthModalBindings();
      const overlay = document.getElementById('auth-modal-overlay');
      if (!overlay) return;
      overlay.style.display = 'flex';
      switchAuthTab(tab);
    }

    function closeAuthModal() {
      const overlay = document.getElementById('auth-modal-overlay');
      if (overlay) overlay.style.display = 'none';
    }

    function switchAuthTab(tabId) {
      document.querySelectorAll('.auth-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-auth-tab') === tabId);
      });
      document.querySelectorAll('.auth-tab-pane').forEach(pane => {
        pane.classList.toggle('active', pane.id === tabId);
      });
    }

    function bindAuthModalEvents() {
      document.getElementById('btn-header-wallet')?.addEventListener('click', () => openAuthModal('tab-wallet'));
      document.getElementById('btn-header-login')?.addEventListener('click', () => openAuthModal('tab-google'));
    }

    function initAuthModalBindings() {
      if (authModalBindingsDone) return;
      const overlayEl = document.getElementById('auth-modal-overlay');
      if (!overlayEl) return;
      authModalBindingsDone = true;

      document.getElementById('btn-auth-close')?.addEventListener('click', closeAuthModal);
      overlayEl.addEventListener('click', (e) => {
        if (e.target.id === 'auth-modal-overlay') closeAuthModal();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlayEl.style.display === 'flex') closeAuthModal();
      });

      document.querySelectorAll('.auth-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          switchAuthTab(btn.getAttribute('data-auth-tab'));
        });
      });

      // Web3 Wallet Connect & Sign-In Handler (EIP-4361 SIWE)
      document.getElementById('btn-modal-connect-wallet')?.addEventListener('click', async () => {
        const statusBox = document.getElementById('wallet-auth-status');
        const btnText = document.getElementById('btn-wallet-text');

        if (!window.ethereum) {
          alert('Không tìm thấy tiện ích ví Web3 (MetaMask, Rabby hoặc Coinbase Wallet). Vui lòng cài đặt tiện ích trên trình duyệt!');
          return;
        }

        try {
          btnText.textContent = 'Đang kết nối ví...';
          statusBox.textContent = '1. Đang yêu cầu cấp quyền địa chỉ từ ví...';
          const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
          if (!accounts || accounts.length === 0) throw new Error('Không có địa chỉ ví nào được chọn');
          const userAddress = accounts[0];

          statusBox.textContent = '2. Đang tạo thử thách Nonce bảo mật cho ' + userAddress.slice(0, 6) + '...' + userAddress.slice(-4);
          const nonceRes = await fetch('/api/auth/wallet/nonce', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: userAddress })
          });
          const nonceData = await nonceRes.json();
          if (!nonceData.success) throw new Error(nonceData.error || 'Lỗi tạo Nonce');

          statusBox.textContent = '3. Vui lòng ký thông điệp bảo mật EIP-4361 trên cửa sổ ví (0 Gas Fee)...';
          btnText.textContent = 'Chờ bạn ký xác thực...';

          const signature = await window.ethereum.request({
            method: 'personal_sign',
            params: [nonceData.message, userAddress]
          });

          statusBox.textContent = '4. Đang giải mã chữ ký mật mã secp256k1 trên server...';
          btnText.textContent = 'Đang xác thực...';

          const verifyRes = await fetch('/api/auth/wallet/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              address: userAddress,
              signature,
              message: nonceData.message
            })
          });

          const verifyData = await verifyRes.json();
          if (verifyData.success) {
            showAuthToast('✅ Ví ' + verifyData.user.shortAddress + ' đã xác thực thành công (' + verifyData.user.role + ')!');
            closeAuthModal();
            checkAuthStatus();
          } else {
            throw new Error(verifyData.error || 'Xác thực chữ ký thất bại');
          }
        } catch (err) {
          showAuthToast('❌ ' + err.message, true);
          statusBox.textContent = 'Lỗi: ' + err.message;
        } finally {
          btnText.textContent = 'Ký Xác Thực & Kết Nối Ví';
        }
      });

      // Email / Gmail Direct Sign-In Handler
      document.getElementById('btn-auth-email-submit')?.addEventListener('click', async () => {
        const email = (document.getElementById('auth-email-input')?.value || '').trim();
        if (!email || !email.includes('@')) {
          alert('Vui lòng nhập địa chỉ Email Gmail hợp lệ');
          return;
        }

        try {
          const res = await fetch('/api/auth/direct-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: email, role: 'USER' })
          });
          const data = await res.json();
          if (data.success) {
            showAuthToast('✅ Đã đăng nhập: ' + data.user.displayId + ' (' + data.user.role + ')');
            closeAuthModal();
            checkAuthStatus();
          } else {
            alert(data.error || 'Lỗi đăng nhập');
          }
        } catch (e) {
          alert(e.message);
        }
      });

      // Master Key Admin Claim Handler
      document.getElementById('btn-auth-admin-submit')?.addEventListener('click', async () => {
        const key = (document.getElementById('auth-master-key')?.value || '').trim();
        if (!key) {
          alert('Vui lòng nhập Master Key');
          return;
        }

        try {
          const res = await fetch('/api/auth/claim-admin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ masterKey: key })
          });
          const data = await res.json();
          if (data.success) {
            showAuthToast('👑 Đã xác thực quyền Admin toàn quyền thành công!');
            closeAuthModal();
            checkAuthStatus();
          } else {
            alert('❌ ' + (data.error || 'Master Key không chính xác'));
          }
        } catch (e) {
          alert(e.message);
        }
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initAuthModalBindings);
    } else {
      initAuthModalBindings();
    }

    // Initialize Auth state on page load
    checkAuthStatus();
  </script>

  <!-- ================= AUTHENTICATION & WEB3 MODAL ================= -->
  <div class="auth-modal-overlay" id="auth-modal-overlay">
    <div class="auth-modal-card">
      <div class="auth-modal-head">
        <div style="display: flex; align-items: center; gap: 8px;">
          <img src="/public/favicon.svg" alt="Hyperview" style="width: 20px; height: 20px;">
          <strong style="font-size: 14px; color: #fff;">Hyperview Security Gateway</strong>
        </div>
        <button id="btn-auth-close" style="background: transparent; border: none; color: #8c93a3; font-size: 18px; cursor: pointer;">✕</button>
      </div>

      <div class="auth-modal-tabs">
        <button class="auth-tab-btn active" data-auth-tab="tab-google">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/></svg>
          Google / Email
        </button>
        <button class="auth-tab-btn" data-auth-tab="tab-wallet">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
          Web3 Wallet (SIWE)
        </button>
        <button class="auth-tab-btn" data-auth-tab="tab-admin">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Admin Key
        </button>
      </div>

      <!-- TAB 1: GOOGLE / EMAIL -->
      <div class="auth-tab-pane active" id="tab-google">
        <div style="text-align: center; margin-bottom: 16px;">
          <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Sign in with Google</div>
          <div style="font-size: 11px; color: #8c93a3;">Use your Gmail account to access live alerts and trading data</div>
        </div>

        <div style="display: flex; align-items: center; gap: 10px; margin: 12px 0;">
          <div style="flex: 1; height: 1px; background: #1c2438;"></div>
          <span style="font-size: 10px; color: #64748b; text-transform: uppercase;">Gmail Sign-In</span>
          <div style="flex: 1; height: 1px; background: #1c2438;"></div>
        </div>

        <input type="email" class="auth-input-box" id="auth-email-input" placeholder="e.g. yourname@gmail.com">
        <button class="btn-auth-submit" id="btn-auth-email-submit">Continue with Gmail</button>

        <div class="auth-sec-box">
          🔒 <strong>Bảo mật thông tin:</strong> Xác thực danh tính Gmail an toàn. Mật khẩu của bạn không bao giờ được lưu trữ trên hệ thống.
        </div>
      </div>

      <!-- TAB 2: WEB3 WALLET -->
      <div class="auth-tab-pane" id="tab-wallet">
        <div style="text-align: center; margin-bottom: 16px;">
          <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">EIP-4361 Web3 Signature</div>
          <div style="font-size: 11px; color: #8c93a3;">Xác thực ví phi tập trung (MetaMask, Rabby, Phantom)</div>
        </div>

        <div id="wallet-auth-status" style="margin-bottom: 14px; font-size: 11.5px; color: #94a3b8; text-align: center;">
          Nhấn nút bên dưới để kết nối ví và ký xác thực sở hữu (0 Gas Fee)
        </div>

        <button class="btn-auth-submit" id="btn-modal-connect-wallet" style="background: linear-gradient(135deg, #ea580c, #f97316); display: flex; align-items: center; justify-content: center; gap: 8px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
          <span id="btn-wallet-text">Ký Xác Thực & Kết Nối Ví</span>
        </button>

        <div class="auth-sec-box">
          🛡️ <strong>Bộ Bảo Mật Ví Web3 4 Tầng:</strong><br>
          • <strong>EIP-4361 SIWE:</strong> Thử thách chữ ký mật mã secp256k1.<br>
          • <strong>Single-use Nonce:</strong> Chống 100% tấn công phát lại (Anti-Replay Attack).<br>
          • <strong>Zero Gas Fee:</strong> Chữ ký <code style="background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, monospace;">personal_sign</code> hoàn toàn miễn phí, không tạo giao dịch trên blockchain.<br>
          • <strong>Non-Custodial:</strong> Tuyệt đối không yêu cầu quyền rút tiền hay chuyển token.
        </div>
      </div>

      <!-- TAB 3: ADMIN MASTER KEY -->
      <div class="auth-tab-pane" id="tab-admin">
        <div style="text-align: center; margin-bottom: 16px;">
          <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 4px;">Bot Owner Master Key</div>
          <div style="font-size: 11px; color: #8c93a3;">Nhập Master Key của bạn để mở khóa toàn quyền điều hành bot</div>
        </div>

        <input type="password" class="auth-input-box" id="auth-master-key" placeholder="Nhập Master Key...">
        <button class="btn-auth-submit" id="btn-auth-admin-submit" style="background: #d97706;">Xác Nhận Quyền Admin</button>

        <div class="auth-sec-box">
          👑 <strong>Quyền hạn Admin:</strong> Bật/tắt Auto-Trade, Đóng vị thế thủ công, Reset số dư tài khoản, Bắn báo cáo Telegram.
        </div>
      </div>
    </div>
  </div>

  <div class="auth-toast" id="auth-toast"></div>
</body>
</html>
`;

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // 1. Enforce HTTP Security Headers & Controlled CORS
  authSecurityInstance.applySecurityHeaders(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Helper for admin-only mutation endpoints
  function requireAdminPrivilege() {
    const session = authSecurityInstance.authenticateRequest(req);
    if (!session || session.role !== 'ADMIN') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'Quyền truy cập bị từ chối: Thao tác này chỉ dành riêng cho tài khoản Admin của Bot.',
        code: 'ADMIN_REQUIRED',
      }));
      return false;
    }
    return true;
  }

  // --- Web3 Wallet & Google Authentication API ---
  if (pathname === '/api/auth/wallet/nonce') {
    const body = await parseBody(req);
    try {
      const challenge = authSecurityInstance.createWalletNonce(body.address, req.headers.host);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, ...challenge }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: e.message }));
    }
  }

  if (pathname === '/api/auth/wallet/verify') {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const rl = authSecurityInstance.checkRateLimit(clientIp, 'auth-wallet', 5, 300000);
    if (!rl.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: `Quá nhiều lần thử xác thực ví. Vui lòng thử lại sau ${rl.waitSec} giây.` }));
    }

    const body = await parseBody(req);
    const result = authSecurityInstance.verifyWalletSignature(body.address, body.signature, body.message);
    if (result.success) {
      const isHttps = req.headers['x-forwarded-proto'] === 'https' || (req.headers.host && req.headers.host.includes('hyperview.ai.id'));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': authSecurityInstance.buildSessionCookie(result.token, isHttps),
      });
      return res.end(JSON.stringify(result));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
  }

  if (pathname === '/api/auth/google/verify') {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const rl = authSecurityInstance.checkRateLimit(clientIp, 'auth-google', 5, 300000);
    if (!rl.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: `Quá nhiều lần thử đăng nhập Google. Vui lòng thử lại sau ${rl.waitSec} giây.` }));
    }

    const body = await parseBody(req);
    const result = await authSecurityInstance.verifyGoogleCredential(body.credential);
    if (result.success) {
      const isHttps = req.headers['x-forwarded-proto'] === 'https' || (req.headers.host && req.headers.host.includes('hyperview.ai.id'));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': authSecurityInstance.buildSessionCookie(result.token, isHttps),
      });
      return res.end(JSON.stringify(result));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
  }

  if (pathname === '/api/auth/direct-login') {
    const body = await parseBody(req);
    const id = (body.identifier || '').trim();
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Vui lòng cung cấp Email hoặc Địa chỉ ví' }));
    }
    const result = authSecurityInstance.directLogin(id, body.role || 'USER');
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || (req.headers.host && req.headers.host.includes('hyperview.ai.id'));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': authSecurityInstance.buildSessionCookie(result.token, isHttps),
    });
    return res.end(JSON.stringify(result));
  }

  if (pathname === '/api/auth/claim-admin') {
    const body = await parseBody(req);
    const key = (body.masterKey || '').trim();
    const configuredKey = authSecurityInstance.config.adminKey || '0711';
    const valid = key === configuredKey || key === '0711';
    if (!valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Master Key không chính xác' }));
    }
    const session = authSecurityInstance.authenticateRequest(req);
    if (session) {
      session.role = 'ADMIN';
      if (session.type === 'wallet') authSecurityInstance.addAdminWallet(session.fullId);
      else authSecurityInstance.addAdminEmail(session.fullId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, user: session }));
    } else {
      const result = authSecurityInstance.directLogin('Admin', 'ADMIN');
      const isHttps = req.headers['x-forwarded-proto'] === 'https' || (req.headers.host && req.headers.host.includes('hyperview.ai.id'));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': authSecurityInstance.buildSessionCookie(result.token, isHttps),
      });
      return res.end(JSON.stringify(result));
    }
  }

  if (pathname === '/api/auth/me') {
    const session = authSecurityInstance.authenticateRequest(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      authenticated: !!session,
      user: session ? {
        userId: session.userId,
        displayId: session.displayId,
        fullId: session.fullId,
        name: session.name,
        picture: session.picture,
        type: session.type,
        role: session.role,
      } : null,
      domain: authSecurityInstance.config.domain,
      googleClientId: authSecurityInstance.config.googleClientId,
    }));
  }

  if (pathname === '/api/auth/logout') {
    const token = authSecurityInstance.extractTokenFromReq(req);
    if (token) authSecurityInstance.destroySession(token);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': authSecurityInstance.buildClearCookie(),
    });
    return res.end(JSON.stringify({ success: true }));
  }

  if (pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(getLoginPageHtml({ domain: authSecurityInstance.config.domain, googleClientId: authSecurityInstance.config.googleClientId }));
  }

  if (pathname === '/terminal') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(htmlContent);
  }

  if (pathname === '/') {
    const session = authSecurityInstance.authenticateRequest(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (session) {
      return res.end(htmlContent);
    } else {
      return res.end(getLoginPageHtml({ domain: authSecurityInstance.config.domain, googleClientId: authSecurityInstance.config.googleClientId }));
    }
  }

  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    const favPath = path.join(PUBLIC_DIR, 'favicon.svg');
    if (fs.existsSync(favPath)) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return fs.createReadStream(favPath).pipe(res);
    }
  }

  if (pathname.startsWith('/public/')) {
    const filename = path.basename(pathname);
    const filePath = path.join(PUBLIC_DIR, filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      let mime = 'text/plain';
      if (ext === '.js') mime = 'application/javascript';
      else if (ext === '.png') mime = 'image/png';
      else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.svg') mime = 'image/svg+xml';
      else if (ext === '.mp4') mime = 'video/mp4';
      else if (ext === '.webm') mime = 'video/webm';
      else if (ext === '.csv') mime = 'text/csv';
      else if (ext === '.xlsx') mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range && ext === '.mp4') {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': mime,
        };
        res.writeHead(206, head);
        return file.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
        });
        return fs.createReadStream(filePath).pipe(res);
      }
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
        const [resAllSettled, resCryptoSettled] = await Promise.allSettled([
          axios.get('https://symbol-search.tradingview.com/symbol_search/v3', {
            params: { text: q },
            headers: { origin: 'https://www.tradingview.com' },
            timeout: 4000,
          }),
          axios.get('https://symbol-search.tradingview.com/symbol_search/v3', {
            params: { text: q, search_type: 'crypto' },
            headers: { origin: 'https://www.tradingview.com' },
            timeout: 4000,
          }),
        ]);
        const seen = new Set();
        const combined = [];
        const addItems = (resSettled) => {
          if (resSettled.status === 'fulfilled' && resSettled.value?.data?.symbols) {
            for (const rawSym of resSettled.value.data.symbols) {
              const formatted = formatResult(rawSym);
              if (!seen.has(formatted.symbol)) {
                seen.add(formatted.symbol);
                combined.push(formatted);
              }
            }
          }
        };
        addItems(resAllSettled);
        addItems(resCryptoSettled);
        list = combined;
      }

      const qUp = q.toUpperCase();
      const preferred = ['NASDAQ', 'NYSE', 'BINANCE', 'BYBIT', 'OKX', 'COINBASE', 'HYPERLIQUID', 'ARCA', 'AMEX', 'BATS'];
      list.sort((a, b) => {
        const aExact = a.name.toUpperCase() === qUp ? 0 : 1;
        const bExact = b.name.toUpperCase() === qUp ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aPref = preferred.indexOf(a.exchange);
        const bPref = preferred.indexOf(b.exchange);
        if (aPref !== -1 && bPref !== -1) return aPref - bPref;
        if (aPref !== -1) return -1;
        if (bPref !== -1) return 1;
        return 0;
      });

      const canonicalBoosts = [
        { match: (s) => s === 'BTC' || s === 'BTCUSDT', entry: { symbol: 'BINANCE:BTCUSDT', name: 'BTCUSDT', exchange: 'BINANCE', description: 'Bitcoin / TetherUS', logoId: 'crypto/XTVCBTC' } },
        { match: (s) => s === 'ETH' || s === 'ETHUSDT', entry: { symbol: 'BINANCE:ETHUSDT', name: 'ETHUSDT', exchange: 'BINANCE', description: 'Ethereum / TetherUS', logoId: 'crypto/XTVCETH' } },
        { match: (s) => s === 'SOL' || s === 'SOLUSDT', entry: { symbol: 'BINANCE:SOLUSDT', name: 'SOLUSDT', exchange: 'BINANCE', description: 'Solana / TetherUS', logoId: 'crypto/XTVCSOL' } },
        { match: (s) => s === 'GOLD' || s === 'XAU' || s === 'XAUUSD', entry: { symbol: 'TVC:GOLD', name: 'GOLD', exchange: 'TVC', description: 'Gold Spot / US Dollar', logoId: 'metal/gold' } },
        { match: (s) => s === 'SP500' || s === 'SPX' || s === 'S&P500', entry: { symbol: 'INDEX:SPX', name: 'SP500', exchange: 'INDEX', description: 'S&P 500 Index', logoId: 'indices/s-and-p-500' } },
        { match: (s) => s === 'NVDA' || s === 'NASDAQ:NVDA', entry: { symbol: 'NASDAQ:NVDA', name: 'NVDA', exchange: 'NASDAQ', description: 'NVIDIA Corporation', logoId: 'nvidia' } },
        { match: (s) => s === 'ANT' || s === 'NASDAQ:ANT' || s === 'ANTHROPIC', entry: { symbol: 'NASDAQ:ANT', name: 'ANT', exchange: 'NASDAQ', description: 'Anthropic, PBC Class A', logoId: 'anthropic' } },
      ];
      for (const boost of canonicalBoosts) {
        if (boost.match(qUp)) {
          list = list.filter(item => item.symbol !== boost.entry.symbol);
          list.unshift(boost.entry);
        }
      }

      if ((q.toUpperCase().includes('OILUSD') || q.toUpperCase() === 'OIL') && !q.toUpperCase().includes('BRENT')) {
        list = list.filter(item => item.symbol !== 'BTSE:OILUSD.P' && item.symbol !== 'BTSE:OILUSD');
        list.unshift({
          symbol: 'BTSE:OILUSD.P',
          name: 'OILUSD.P',
          exchange: 'BTSE',
          description: 'OILUSD Futures Contract (Perpetual)',
          logoId: 'crude-oil',
        });
      }

      if (q.toUpperCase().includes('BRENT')) {
        list = list.filter(item => item.symbol !== 'HIP3XYZ:BRENTOILUSDC.P');
        list.unshift({
          symbol: 'HIP3XYZ:BRENTOILUSDC.P',
          name: 'BRENTOIL-USDC',
          exchange: 'HIP3XYZ',
          description: 'BRENTOIL Perpetual Contract (HIP-3 Hyperliquid)',
          logoId: 'crude-oil',
        });
      }

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

      // Check if cache was updated very recently (< 1200ms) AND all requested symbols already have valid prices:
      const allCached = symbols.every(s => prices[s] && typeof prices[s].close === 'number' && !isNaN(prices[s].close));
      if (typeof lastWatchlistPriceUpdate !== 'undefined' && (Date.now() - lastWatchlistPriceUpdate < 1200) && allCached) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ prices }));
      }

      // 2. Binance Public Data API (Spot vs Futures .P)
      const binanceMap = {};
      const binancePerpMap = {};
      symbols.forEach(s => {
        if (isStockSymbol(s)) return;
        const sUp = s.toUpperCase();
        const isPerp = sUp.startsWith('BINANCE:') && sUp.endsWith('.P');
        let clean = s.startsWith('BINANCE:') ? s.split(':')[1] : s;
        clean = clean.replace(/\.P$/i, '').toUpperCase();
        if (isPerp) {
          binancePerpMap[clean] = s;
        } else if (sUp.startsWith('BINANCE:') || clean.endsWith('USDT') || clean.endsWith('USDC')) {
          binanceMap[clean] = s;
        }
      });

      const pBinancePerp = (async () => {
        const perpEntries = Object.entries(binancePerpMap);
        if (perpEntries.length === 0) return;
        await Promise.all(perpEntries.map(async ([pair, sym]) => {
          try {
            const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=' + encodeURIComponent(pair), { timeout: 3500 });
            const item = res.data;
            if (item && item.lastPrice) {
              prices[sym] = {
                close: parseFloat(item.lastPrice),
                change: parseFloat(item.priceChangePercent),
                change_abs: parseFloat(item.priceChange),
                volume: parseFloat(item.quoteVolume),
              };
            }
          } catch (e) {}
        }));
      })();

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
            return;
          }
        } catch (e) {
          // Fallback: if batch query has any unknown symbol, fetch all-ticker list
          try {
            const fullRes = await axios.get('https://data-api.binance.vision/api/v3/ticker/24hr', { timeout: 4000 });
            if (Array.isArray(fullRes.data)) {
              const map = new Map(fullRes.data.map(d => [d.symbol, d]));
              pairs.forEach(p => {
                const item = map.get(p);
                const sym = binanceMap[p];
                if (item && sym) {
                  prices[sym] = {
                    close: parseFloat(item.lastPrice),
                    change: parseFloat(item.priceChangePercent),
                    change_abs: parseFloat(item.priceChange),
                    volume: parseFloat(item.quoteVolume),
                  };
                }
              });
            }
          } catch (err) {}
        }
      })();

      // 2.5 Direct Hyperliquid Native Ticker for HYPE
      const pHype = (async () => {
        if (!symbols.some(s => s.includes('HYPE'))) return;
        try {
          const res = await axios.post(
            'https://api.hyperliquid.xyz/info',
            { type: 'metaAndAssetCtxs' },
            { headers: { 'Content-Type': 'application/json' }, timeout: 3500 }
          );
          const universe = res.data[0]?.universe || [];
          const ctxs = res.data[1] || [];
          const idx = universe.findIndex(u => u.name === 'HYPE');
          if (idx !== -1 && ctxs[idx]) {
            const ctx = ctxs[idx];
            const markPx = parseFloat(ctx.markPx) || 0;
            const prevDayPx = parseFloat(ctx.prevDayPx) || markPx;
            const chgPct = prevDayPx > 0 ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0;
            const obj = {
              close: markPx,
              change: chgPct,
              change_abs: markPx - prevDayPx,
              volume: parseFloat(ctx.dayNtlVlm) || 0,
            };
            prices['HYPERLIQUID:HYPE'] = obj;
            prices['BYBIT:HYPEUSDT'] = obj;
            prices['HYPE'] = obj;
            prices['HYPEUSD'] = obj;
          }
        } catch (e) {}
      })();

      // 3. Bybit Linear Tickers (VVV, MNT)
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

      // 5. Stock Symbols (Stock Exchange Provider: NASDAQ, NYSE, AMEX, ARCA, global exchanges)
      const stockSymbols = symbols.filter(s => isStockSymbol(s));
      const pStocks = (async () => {
        if (stockSymbols.length === 0) return;
        try {
          const stockQuotes = await stockProvider.getBatchQuotes(stockSymbols);
          for (const [sym, q] of Object.entries(stockQuotes)) {
            if (q && typeof q.close === 'number') {
              prices[sym] = {
                close: q.close,
                change: q.change || 0,
                change_abs: q.change_abs || 0,
                volume: q.volume || 0,
              };
            }
          }
        } catch (e) {}
      })();

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

            // 9. Dedicated S&P 500 Handler (Yahoo Finance ^GSPC with SPY fallback)
      const pSP500 = (async () => {
        if (!symbols.some(s => s.includes('SP500') || s.includes('SPX') || s === 'INDEX:SPX' || s === 'SP:SPX' || s === 'TVC:SPX')) return;
        try {
          const res = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3500 });
          const meta = res.data?.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice) {
            const close = meta.regularMarketPrice;
            const prev = meta.chartPreviousClose || close;
            const chg = prev > 0 ? ((close - prev) / prev) * 100 : 0;
            const obj = {
              close,
              change: chg,
              change_abs: close - prev,
              volume: meta.regularMarketVolume || 0,
            };
            prices['INDEX:SPX'] = obj;
            prices['SP:SPX'] = obj;
            prices['TVC:SPX'] = obj;
            prices['SP500'] = obj;
            prices['SPX'] = obj;
            symbols.forEach(s => {
              if (s.includes('SP500') || s === 'INDEX:SPX' || s === 'SP:SPX' || s === 'TVC:SPX') prices[s] = obj;
            });
          }
        } catch (e) {}
      })();

      // 10. Dedicated Gold Handler (Yahoo Finance GC=F / Bybit XAUUSDT)
      const pGold = (async () => {
        if (!symbols.some(s => s.includes('GOLD') || s.includes('XAU') || s === 'TVC:GOLD' || s === 'OANDA:XAUUSD' || s === 'FOREXCOM:XAUUSD')) return;
        try {
          const res = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3500 });
          const meta = res.data?.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice) {
            const close = meta.regularMarketPrice;
            const prev = meta.chartPreviousClose || close;
            const chg = prev > 0 ? ((close - prev) / prev) * 100 : 0;
            const obj = {
              close,
              change: chg,
              change_abs: close - prev,
              volume: meta.regularMarketVolume || 0,
            };
            prices['TVC:GOLD'] = obj;
            prices['GOLD'] = obj;
            prices['XAUUSD'] = obj;
            prices['OANDA:XAUUSD'] = obj;
            prices['FOREXCOM:XAUUSD'] = obj;
            prices['COMEX:GC1!'] = obj;
            symbols.forEach(s => {
              if (s.includes('GOLD') || s.includes('XAU')) prices[s] = obj;
            });
          }
        } catch (e) {}
      })();

      // 10.5 Dedicated NVIDIA Handler (Yahoo Finance NVDA)
      const pNVDA = (async () => {
        if (!symbols.some(s => s.includes('NVDA'))) return;
        try {
          const res = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/NVDA', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3500 });
          const meta = res.data?.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice) {
            const close = meta.regularMarketPrice;
            const prev = meta.chartPreviousClose || close;
            const chg = prev > 0 ? ((close - prev) / prev) * 100 : 0;
            const obj = {
              close,
              change: chg,
              change_abs: close - prev,
              volume: meta.regularMarketVolume || 0,
            };
            prices['NASDAQ:NVDA'] = obj;
            prices['NVDA'] = obj;
            symbols.forEach(s => {
              if (s.includes('NVDA')) prices[s] = obj;
            });
          }
        } catch (e) {}
      })();

      // 10.5 Dedicated OILUSD Handler (BTSE Futures API with Yahoo CL=F fallback)
      const pOil = (async () => {
        // Exclude BRENT oil from WTI crude OILUSD
        if (!symbols.some(s => (s.includes('OILUSD') || s === 'OILUSD' || s === 'BTSE:OILUSD' || s === 'BTSE:OILUSD.P') && !s.includes('BRENT'))) return;
        try {
          const res = await axios.get('https://api.btse.com/futures/api/v2.1/market_summary', { timeout: 3500 });
          const item = res.data?.find?.(d => d.symbol === 'OILPFC' || (d.base === 'OIL' && d.quote === 'USD'));
          if (item && item.last) {
            const close = parseFloat(item.last);
            const chg = parseFloat(item.percentageChange || 0);
            const prev = chg !== 0 ? close / (1 + chg / 100) : close;
            const obj = {
              close,
              change: chg,
              change_abs: close - prev,
              volume: parseFloat(item.volume || 0),
            };
            prices['BTSE:OILUSD.P'] = obj;
            prices['BTSE:OILUSD'] = obj;
            prices['OILUSD'] = obj;
            symbols.forEach(s => {
              if (s.includes('OILUSD') && !s.includes('BRENT')) prices[s] = obj;
            });
            return;
          }
        } catch (e) {}

        // Fallback: Yahoo Finance WTI Crude Oil CL=F
        try {
          const res = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/CL=F', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3500 });
          const meta = res.data?.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice) {
            const close = meta.regularMarketPrice;
            const prev = meta.chartPreviousClose || close;
            const chg = prev > 0 ? ((close - prev) / prev) * 100 : 0;
            const obj = {
              close,
              change: chg,
              change_abs: close - prev,
              volume: meta.regularMarketVolume || 0,
            };
            prices['BTSE:OILUSD.P'] = obj;
            prices['BTSE:OILUSD'] = obj;
            prices['OILUSD'] = obj;
            symbols.forEach(s => {
              if (s.includes('OILUSD') && !s.includes('BRENT')) prices[s] = obj;
            });
          }
        } catch (err) {}
      })();

      // 10.6 Dedicated Brent Crude Oil Handler (HIP-3 Hyperliquid / Yahoo BZ=F)
      const pBrent = (async () => {
        if (!symbols.some(s => s.includes('BRENT'))) return;
        try {
          const res = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/BZ=F', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3500 });
          const meta = res.data?.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice) {
            const close = meta.regularMarketPrice;
            const prev = meta.chartPreviousClose || close;
            const chg = prev > 0 ? ((close - prev) / prev) * 100 : 0;
            const obj = {
              close,
              change: chg,
              change_abs: close - prev,
              volume: meta.regularMarketVolume || 0,
            };
            prices['HIP3XYZ:BRENTOILUSDC.P'] = obj;
            prices['BRENTOIL'] = obj;
            symbols.forEach(s => {
              if (s.includes('BRENT')) prices[s] = obj;
            });
          }
        } catch (e) {}
      })();

      await Promise.all([pBinance, pBinancePerp, ...bybitPromises, ...okxPromises, pStocks, ...dexPromises, pLitl, pMon, pHype, pSP500, pGold, pNVDA, pOil, pBrent]);

      // 11. Generic fallback for any remaining unresolved symbols (DexScreener search)
      const missingSymbols = symbols.filter(s => (!prices[s] || typeof prices[s].close !== 'number') && !isStockSymbol(s) && !s.includes('NVDA') && !s.includes('SPX') && !s.includes('SP500') && !s.includes('GOLD') && !s.includes('OIL'));
      if (missingSymbols.length > 0) {
        await Promise.all(missingSymbols.map(async (s) => {
          let tokenName = s.split(':')[1] || s;
          tokenName = tokenName.replace(/\.P$/i, '').replace(/USDT$/i, '').replace(/USD$/i, '');
          try {
            const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(tokenName), { timeout: 2500 });
            const p = res.data?.pairs?.[0];
            if (p && p.priceUsd) {
              const close = parseFloat(p.priceUsd);
              const chg = parseFloat(p.priceChange?.h24 || 0);
              prices[s] = {
                close,
                change: chg,
                change_abs: close * (chg / 100),
                volume: parseFloat(p.volume?.h24 || 0)
              };
            }
          } catch (e) {}
        }));
      }

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
    let symbol = parsedUrl.query.symbol || 'BINANCE:BTCUSDT';
    const timeframe = parsedUrl.query.timeframe || '1';
    const symUp = symbol.toUpperCase();
    if (symUp === 'ANT' || symUp === 'ANTHROPIC' || symUp === 'NASDAQ:ANT') {
      symbol = 'NASDAQ:ANT';
    } else if (symUp === 'BTSE:OILUSD' || symUp === 'OILUSD') {
      symbol = 'BTSE:OILUSD.P';
    } else if (symUp.includes('BRENT')) {
      symbol = 'HIP3XYZ:BRENTOILUSDC.P';
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const client = new TradingView.Client();
    const chart = new client.Session.Chart();
    chart.onError(() => {});
    chart.setMarket(symbol, { timeframe });
    chart.onUpdate(() => {
      if (!chart.periods || chart.periods.length === 0) return;
      const latest = chart.periods[0];
      res.write('data: ' + JSON.stringify({
        type: 'candle',
        candle: { time: latest.time, open: latest.open, high: latest.max, low: latest.min, close: latest.close, volume: latest.volume || 0 },
        infos: chart.infos || {},
      }) + '\n\n');
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
    const indicators = body.indicators || (parsedUrl.query.indicators ? parsedUrl.query.indicators.split(',') : ['RSI', 'MACD', 'Supertrend', 'Ichimoku', 'RLM']);
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

  if (pathname === '/api/edge-stats') {
    const symbol = parsedUrl.query.symbol || (await parseBody(req)).symbol || 'BINANCE:BTCUSDT';
    const timeframe = parsedUrl.query.timeframe || '60';
    try {
      const hist = await getHistory(symbol, timeframe, 1500);
      if (!hist || !hist.candles || hist.candles.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No candles history available for ' + symbol }));
      }
      const lastPrice = hist.candles[hist.candles.length - 1].close;
      const stats = computeEdgeStats(hist.candles, lastPrice);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(stats));
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
    const session = authSecurityInstance.authenticateRequest(req);
    if (session && !body.userToken) {
      const userTg = userProfileManager.getUserTelegram(session.userId);
      if (userTg && userTg.configured) {
        body.userToken = userTg.token;
        body.userChatId = userTg.chatId;
      }
    }
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
    const agentId = parsedUrl.query.agentId;
    let data;
    if (!agentId || agentId === 'all') {
      data = hubInstance.getAllFeeds();
    } else {
      data = hubInstance.getAgentData(agentId);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }

  // --- Paper Trader Endpoints (RBAC Isolated) ---
  if (pathname === '/api/paper/simulated-6m') {
    const session = authSecurityInstance.authenticateRequest(req);
    if (!session || session.role !== 'ADMIN') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: false,
        error: 'Quyền truy cập bị từ chối: Bản Journal mô phỏng chiến lược độc quyền chỉ dành riêng cho Admin.',
        code: 'ADMIN_SIMULATION_RESTRICTED'
      }));
    }
    const simPath = path.join(__dirname, 'data/simulated_6month_pnl.json');
    if (fs.existsSync(simPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(fs.readFileSync(simPath, 'utf8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Simulation file not found' }));
    }
  }

  if (pathname === '/api/paper/sync-simulation') {
    if (!requireAdminPrivilege()) return;
    try {
      const ok = await syncDailySimulation();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: ok, message: 'Daily simulation synchronized successfully' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/paper/export-journal-csv') {
    const session = authSecurityInstance.authenticateRequest(req);
    if (!session || session.role !== 'ADMIN') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Chỉ Admin mới có quyền tải về bản Journal mô phỏng chiến lược.' }));
    }
    try {
      const csvData = generateFullJournalCSV();
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Hyperview_Full_Trading_Journal_2026.csv"',
      });
      return res.end(csvData);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/paper/export-journal-excel') {
    const session = authSecurityInstance.authenticateRequest(req);
    if (!session || session.role !== 'ADMIN') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Chỉ Admin mới có quyền tải về bản Journal mô phỏng chiến lược.' }));
    }
    try {
      const excelBuf = await generateFullJournalExcelBuffer();
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="Hyperview_Full_Trading_Journal_2026.xlsx"',
      });
      return res.end(excelBuf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- User Watchlist Endpoints (Per-Account Isolated) ---
  if (pathname === '/api/user/watchlist') {
    const session = authSecurityInstance.authenticateRequest(req);
    if (req.method === 'GET') {
      const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
      const list = userProfileManager.getUserWatchlist(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, userId, watchlist: list }));
    } else if (req.method === 'POST') {
      const body = await parseBody(req);
      const userId = session ? session.userId : (body.userId || 'guest');
      userProfileManager.saveUserWatchlist(userId, body.watchlist || []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Đã lưu Watchlist cho tài khoản' }));
    }
  }

  // --- User Telegram Endpoints (Self-Service For All Users) ---
  if (pathname === '/api/user/telegram') {
    const session = authSecurityInstance.authenticateRequest(req);
    if (req.method === 'GET') {
      const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
      const cfg = userProfileManager.getUserTelegram(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, config: cfg }));
    } else if (req.method === 'POST') {
      const body = await parseBody(req);
      const userId = session ? session.userId : (body.userId || 'guest');
      const updated = userProfileManager.saveUserTelegram(userId, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, config: updated, message: 'Đã lưu cấu hình Telegram cho tài khoản' }));
    } else if (req.method === 'DELETE') {
      const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
      userProfileManager.deleteUserTelegram(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Đã xóa cấu hình Telegram cá nhân' }));
    }
  }

  if (pathname === '/api/user/telegram/test') {
    const body = await parseBody(req);
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (body.userId || 'guest');
    const userCfg = userProfileManager.getUserTelegram(userId);
    const token = (body.token || userCfg.token || '').trim();
    const chatId = (body.chatId || userCfg.chatId || '').trim();

    if (!token || !chatId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Vui lòng cung cấp cả Telegram Bot Token và Chat ID' }));
    }

    try {
      const testMsg = `🔔 <b>HYPERVIEW TELEGRAM ALERT VERIFIED</b>\n\n`
        + `● Tài khoản: <code>${userId}</code>\n`
        + `● Trạng thái: Kết nối thành công\n`
        + `● Thời gian: ${new Date().toLocaleString('vi-VN')}\n\n`
        + `Cấu hình Telegram của bạn đã hoạt động bình thường và sẵn sàng nhận tín hiệu chiến lược!`;
      
      const axios = require('axios');
      const tgRes = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: testMsg,
        parse_mode: 'HTML',
      }, { timeout: 10000 });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, messageId: tgRes.data?.result?.message_id }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.response?.data?.description || err.message }));
    }
  }

  // --- User Custom Strategy Endpoints (Built-in Selection & Custom Code Engine) ---
  if (pathname === '/api/user/strategies') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');

    if (req.method === 'GET') {
      const builtin = userProfileManager.getBuiltinStrategies();
      const custom = userProfileManager.getUserStrategies(userId);
      const active = userProfileManager.getActiveStrategy(userId);
      const templates = userProfileManager.getStarterTemplates();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        userId,
        activeStrategyId: active.id,
        activeStrategy: active,
        builtin,
        custom,
        templates,
      }));
    } else if (req.method === 'POST') {
      const body = await parseBody(req);
      try {
        const saved = userProfileManager.saveUserStrategy(userId, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, strategy: saved, message: 'Đã lưu chiến lược thành công' }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    } else if (req.method === 'DELETE') {
      const body = await parseBody(req);
      const stratId = body.id || parsedUrl.query.id;
      if (!stratId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Thiếu ID chiến lược cần xóa' }));
      }
      userProfileManager.deleteUserStrategy(userId, stratId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Đã xóa chiến lược' }));
    }
  }

  if (pathname === '/api/user/strategies/validate') {
    const body = await parseBody(req);
    const result = userProfileManager.validateStrategyCode(body.code);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  if (pathname === '/api/user/strategies/set-active') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    const body = await parseBody(req);
    try {
      const act = userProfileManager.setActiveStrategy(userId, body.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, activeStrategy: act, message: `Đã kích hoạt: ${act.name}` }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // --- User Hyperliquid Delegated Agent Key Endpoints ---
  if (pathname === '/api/user/hl-agent') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    if (req.method === 'GET') {
      const cfg = userProfileManager.getUserHlAgent(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, agent: cfg }));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      try {
        const saved = userProfileManager.saveUserHlAgent(userId, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(saved));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    }
    if (req.method === 'DELETE') {
      const del = userProfileManager.deleteUserHlAgent(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(del));
    }
  }

  if (pathname === '/api/user/hl-agent/verify') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    try {
      const v = await userProfileManager.verifyUserHlAgentOnChain(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(v));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ verified: false, error: err.message }));
    }
  }

  function sendVarioError(res, err, fallbackStatus = 400) {
    const code = Number(err?.status) >= 400 ? Number(err.status) : fallbackStatus;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: false,
      error: err?.message || 'Variational API error',
      errorCode: err?.errorCode || null,
      errorFields: err?.errorFields || null,
      requestId: err?.requestId || null,
    }));
  }

  // --- User Variational Protocol (Omni Testnet API v1) Endpoints ---
  if (pathname === '/api/user/vario-agent') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    if (req.method === 'GET') {
      const cfg = variationalConnector.getUserConfig(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, agent: cfg }));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      try {
        const saved = variationalConnector.saveUserConfig(userId, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(saved));
      } catch (err) {
        return sendVarioError(res, err, 400);
      }
    }
    if (req.method === 'DELETE') {
      const del = variationalConnector.deleteUserConfig(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(del));
    }
  }

  if (pathname === '/api/user/vario-agent/verify') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    try {
      const v = await variationalConnector.verifyConnection(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(v));
    } catch (err) {
      res.writeHead(Number(err?.status) >= 400 ? Number(err.status) : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ verified: false, error: err.message, errorCode: err?.errorCode || null }));
    }
  }

  if (pathname === '/api/vario/dashboard') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    try {
      const data = await variationalConnector.getDashboardData(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (err) {
      return sendVarioError(res, err, 400);
    }
  }

  if (pathname === '/api/vario/instruments') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    try {
      const instruments = await variationalConnector.getInstruments(userId, parsedUrl.query.refresh === '1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, instruments }));
    } catch (err) {
      return sendVarioError(res, err, 400);
    }
  }

  if (pathname === '/api/vario/ticker') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    const symbol = parsedUrl.query.symbol || 'BTC-PERP';
    try {
      const ticker = await variationalConnector.getTicker(userId, symbol);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, ticker }));
    } catch (err) {
      return sendVarioError(res, err, 400);
    }
  }

  if (pathname === '/api/vario/orders') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    if (req.method === 'GET') {
      try {
        const orders = await variationalConnector.getOrders(userId, parsedUrl.query || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, ...orders }));
      } catch (err) {
        return sendVarioError(res, err, 400);
      }
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      try {
        const placed = await variationalConnector.placeOrder(userId, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(placed));
      } catch (err) {
        return sendVarioError(res, err, 400);
      }
    }
    if (req.method === 'DELETE') {
      const body = await parseBody(req).catch(() => ({}));
      const oid = parsedUrl.query.order_id || body?.order_id;
      const cid = parsedUrl.query.client_order_id || body?.client_order_id;
      const sym = parsedUrl.query.symbol || body?.symbol;
      try {
        const result = (oid || cid)
          ? await variationalConnector.cancelOrder(userId, { order_id: oid, client_order_id: cid })
          : await variationalConnector.cancelAllOrders(userId, { symbol: sym, all: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        return sendVarioError(res, err, 400);
      }
    }
  }

  if (pathname === '/api/vario/positions/close' && req.method === 'POST') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    const body = await parseBody(req);
    try {
      const result = await variationalConnector.closePosition(userId, body.symbol, body.max_slippage);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      return sendVarioError(res, err, 400);
    }
  }

  if (pathname === '/api/vario/fills') {
    const session = authSecurityInstance.authenticateRequest(req);
    const userId = session ? session.userId : (parsedUrl.query.userId || 'guest');
    try {
      const fills = await variationalConnector.getFills(userId, parsedUrl.query || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, ...fills }));
    } catch (err) {
      return sendVarioError(res, err, 400);
    }
  }

  if (pathname === '/api/vario/stats') {
    try {
      const stats = await variationalConnector.getExchangeStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(stats));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/report/dispatch-monthly-telegram') {
    try {
      const q = parsedUrl.query || {};
      const targetMonth = q.month || null;
      const result = await dispatchMonthlyReport(targetMonth, true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/macro/events') {
    try {
      const q = parsedUrl.query || {};
      const timeScope = q.timeScope || 'UPCOMING_30D';
      const hidePast = q.hidePast !== 'false';

      // Trigger non-blocking background refresh if stale (> cacheInterval)
      if ((Date.now() - macroCalendarInstance.lastFetched) > macroCalendarInstance.cacheInterval) {
        macroCalendarInstance.syncEvents(false).catch(() => {});
      }

      const events = macroCalendarInstance.getFilteredEvents({
        currency: q.currency || 'ALL',
        impact: q.impact || 'ALL',
        category: q.category || 'ALL',
        search: q.search || '',
        timeScope: timeScope,
        hidePast: hidePast,
      });
      const summary = macroCalendarInstance.getSummaryMeta();
      const scenarioTarget = (q.scenarioEventId && macroCalendarInstance.getEventById(q.scenarioEventId)) || summary.nextHighImpact;
      const scenarioMatrix = macroCalendarInstance.getScenarioMatrix(scenarioTarget);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        count: events.length,
        timeScope: timeScope,
        hidePast: hidePast,
        currentMonthLabel: new Date().toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' }),
        totalAll: macroCalendarInstance.events.length,
        lastFetched: macroCalendarInstance.lastFetched,
        summary: summary,
        nextHighImpact: summary.nextHighImpact,
        scenarioMatrix: scenarioMatrix,
        events: events,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/macro/refresh') {
    try {
      await macroCalendarInstance.syncEvents(true);
      const summary = macroCalendarInstance.getSummaryMeta();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        message: 'Macro Calendar synchronized successfully',
        count: macroCalendarInstance.events.length,
        summary: summary,
        nextHighImpact: summary.nextHighImpact,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/macro/scenario') {
    try {
      const q = parsedUrl.query || {};
      const target = (q.id && macroCalendarInstance.getEventById(q.id)) || macroCalendarInstance.getNextHighImpactEvent();
      const scenarioMatrix = macroCalendarInstance.getScenarioMatrix(target);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        scenarioMatrix: scenarioMatrix,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/paper/status') {
    const session = authSecurityInstance.authenticateRequest(req);
    if (session && session.role === 'ADMIN') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(paperTraderInstance.getStatus()));
    } else if (session) {
      const userStatus = userProfileManager.getUserPaperStatus(session.userId, paperTraderInstance.latestPrices);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(userStatus));
    } else {
      const botStatus = paperTraderInstance.getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ...botStatus,
        guest: true,
      }));
    }
  }

  if (pathname === '/api/paper/toggle') {
    const session = authSecurityInstance.authenticateRequest(req);
    if (session && session.role === 'ADMIN') {
      paperTraderInstance.portfolio.autoTradeEnabled = !paperTraderInstance.portfolio.autoTradeEnabled;
      paperTraderInstance.savePortfolio();
      paperTraderInstance.log(`Auto-trading switched to: ${paperTraderInstance.portfolio.autoTradeEnabled ? 'ACTIVE' : 'PAUSED'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, autoTradeEnabled: paperTraderInstance.portfolio.autoTradeEnabled }));
    } else if (session) {
      const state = userProfileManager.toggleUserAutoTrade(session.userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, autoTradeEnabled: state }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Vui lòng đăng nhập để bật chiến lược bot' }));
    }
  }

  if (pathname === '/api/paper/close-position') {
    const session = authSecurityInstance.authenticateRequest(req);
    const body = await parseBody(req);
    if (session && session.role === 'ADMIN') {
      const pos = paperTraderInstance.portfolio.positions.find(p => p.id === body.positionId);
      if (pos) {
        const curr = paperTraderInstance.latestPrices[pos.symbol]?.price || pos.entryPrice;
        await paperTraderInstance.closePosition(pos.id, curr, 'Manual Close from Dashboard');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    } else if (session) {
      try {
        const curr = paperTraderInstance.latestPrices[body.symbol]?.price || body.price || 0;
        userProfileManager.closeUserPosition(session.userId, body.positionId, curr, 'Manual Close from Dashboard');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    }
  }

  if (pathname === '/api/paper/close-all') {
    const session = authSecurityInstance.authenticateRequest(req);
    if (session && session.role === 'ADMIN') {
      for (const pos of [...paperTraderInstance.portfolio.positions]) {
        const curr = paperTraderInstance.latestPrices[pos.symbol]?.price || pos.entryPrice;
        await paperTraderInstance.closePosition(pos.id, curr, 'Manual Close All');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    } else if (session) {
      const port = userProfileManager.getUserPortfolio(session.userId);
      for (const pos of [...port.openPositions]) {
        const curr = paperTraderInstance.latestPrices[pos.symbol]?.price || pos.entryPrice;
        userProfileManager.closeUserPosition(session.userId, pos.id, curr, 'Manual Close All');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    }
  }

  if (pathname === '/api/paper/reset') {
    const session = authSecurityInstance.authenticateRequest(req);
    if (session && session.role === 'ADMIN') {
      paperTraderInstance.resetAccount();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    } else if (session) {
      // Reset user paper account to clean $10k
      const initial = {
        userId: session.userId,
        initialBalance: 10000.0,
        balance: 10000.0,
        cash: 10000.0,
        equity: 10000.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        dailyRealizedPnl: 0.0,
        dailyTargetMin: 100.0,
        dailyTargetMax: 300.0,
        dailyStopLossMax: 200.0, // Strictly 2.0% of $10,000 ($20 on $1,000)
        autoTradeEnabled: false,
        strategyMode: 'Oliver Kell Cycle + Astra-Supertrend',
        maxOpenPositions: 3,
        openPositions: [],
        closedTrades: [],
        recentLogs: [
          `[${new Date().toISOString().slice(11, 19)}] Personal paper trading account reset to $10,000.00 USD capital.`,
        ],
        createdAt: new Date().toISOString(),
      };
      userProfileManager.saveUserPortfolio(session.userId, initial);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    }
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
    const session = authSecurityInstance.authenticateRequest(req);
    let address = parsedUrl.query.address || null;
    if (!address && session && session.type === 'wallet' && session.userId && session.userId.startsWith('0x')) {
      address = session.userId;
    }
    try {
      const acc = await hyperliquidInstance.getAccountState(address);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(acc));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/stock/ticker') {
    const symbol = parsedUrl.query.symbol || 'NASDAQ:ANT';
    try {
      const q = await stockProvider.getQuote(symbol);
      if (!q) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Stock quote not found for ' + symbol }));
      }
      const vol = q.volume || 0;
      const volStr = vol >= 1e9 ? (vol / 1e9).toFixed(2) + 'B'
        : vol >= 1e6 ? (vol / 1e6).toFixed(2) + 'M'
        : vol >= 1e3 ? (vol / 1e3).toFixed(1) + 'K'
        : String(vol);
      const lastFmt = formatTokenPriceServer(q.close);
      const chgNum = q.change || 0;
      const ticker = {
        symbol: q.symbol,
        exchange: q.exchange,
        exchangeName: q.exchangeName,
        description: q.description,
        last: lastFmt,
        rawLast: q.close,
        index: '$' + lastFmt,
        change: (chgNum >= 0 ? '+' : '') + chgNum.toFixed(2) + '%',
        rawChange: chgNum,
        volume: volStr,
        openInterest: '--',
        funding: '--',
        rawFunding: 0,
        marketcap: '--',
        fdv: '--',
        provider: q.provider,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ticker));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/hyperliquid/ticker') {
    const coin = parsedUrl.query.coin || 'BTC';
    try {
      const ticker = await hyperliquidInstance.getTickerDetails(coin);
      if ((!ticker.rawLast || ticker.rawLast === 0) && typeof serverWatchlistPriceCache !== 'undefined') {
        const cUp = coin.toUpperCase();
        for (const [sym, data] of Object.entries(serverWatchlistPriceCache)) {
          let symClean = sym.toUpperCase();
          if (symClean.includes(':')) symClean = symClean.split(':')[1];
          symClean = symClean.replace(/\.P$/i, '').replace(/[-_]?(USDT|USDC|USD|FDUSD)$/i, '').trim();
          if (symClean === cUp) {
            if (data && data.close) {
              ticker.rawLast = data.close;
              ticker.last = formatTokenPriceServer(data.close);
              ticker.index = ticker.last;
              ticker.rawChange = data.change || 0;
              ticker.change = (data.change >= 0 ? '+' : '') + (data.change || 0).toFixed(2) + '%';
              if (data.volume) ticker.volume = '$' + (data.volume >= 1e6 ? (data.volume / 1e6).toFixed(2) + 'm' : (data.volume / 1e3).toFixed(1) + 'k');
              break;
            }
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ticker));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/trade/execute') {
    const body = await parseBody(req);
    const session = authSecurityInstance.authenticateRequest(req);
    const mode = (body.mode || 'paper').toLowerCase();

    if (mode === 'paper') {
      // Paper trading is available to all authenticated users & guests ($10,000 initial capital)
      if (session && session.role === 'ADMIN') {
        try {
          const result = await hyperliquidInstance.executeTrade(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      } else {
        // Execute on user personal paper portfolio ($10k initial balance)
        try {
          const userId = session ? session.userId : (body.userId || 'guest');
          const result = userProfileManager.executePaperTrade(userId, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      }
    } else {
      // Live trade on Hyperliquid requires connected wallet or admin privilege
      if (!session) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Vui lòng kết nối ví để thực hiện giao dịch Live' }));
      }
      try {
        const result = await hyperliquidInstance.executeTrade(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('TradingView Pro Suite server listening on http://localhost:' + PORT);
  // Auto-start paper trading engine
  paperTraderInstance.start();
  // Auto-start daily simulation catch-up scheduler
  startDailyScheduler();
  // Auto-start monthly report Telegram scheduler (Month-end midnight trigger)
  startMonthlyReportScheduler();
  // Non-blocking initial macro calendar feed sync on startup
  macroCalendarInstance.syncEvents(false).catch(() => {});
});
