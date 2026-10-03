const axios = require('axios');

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const WS_URL = 'wss://api.hyperliquid.xyz/ws';

/**
 * Canonical timeframe -> Hyperliquid interval string (from LuxAlgo Vela)
 */
const TF_TO_INTERVAL = {
  '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1h', '120': '2h', '240': '4h', '480': '8h', '720': '12h',
  'D': '1d', 'W': '1w', 'M': '1M',
};

const TF_NORMALIZE = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '45m': '45',
  '1h': '60', '2h': '120', '3h': '180', '4h': '240', '6h': '360', '8h': '480', '12h': '720',
  '1d': 'D', '1w': 'W', '1mo': 'M', '1D': 'D', '1W': 'W', '4H': '240',
  'D': 'D', 'W': 'W', 'M': 'M',
};

const NATIVE_MINUTES = [1, 3, 5, 15, 30, 60, 120, 240, 480, 720];
const MIN_TO_INTERVAL = {
  1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 120: '2h', 240: '4h', 480: '8h', 720: '12h',
};

const TF_MS = {
  D: 86400000,
  W: 604800000,
  M: 2592000000,
};

function tfMs(tf) {
  if (TF_MS[tf]) return TF_MS[tf];
  const min = parseInt(tf, 10);
  return Number.isFinite(min) && min > 0 ? min * 60000 : 3600000;
}

function normalizeTf(tf) {
  if (!tf) return '60';
  const clean = String(tf).trim();
  return TF_NORMALIZE[clean] || TF_NORMALIZE[clean.toLowerCase()] || clean;
}

function parseCoin(ticker) {
  if (!ticker) return 'BTC';
  let t = String(ticker).trim();
  if (t.includes(':')) t = t.split(':')[1];
  if (t.endsWith('.P')) t = t.slice(0, -2);
  if (t.endsWith('-USDC')) t = t.slice(0, -5);
  else if (t.endsWith('USDC') && !t.includes('/')) t = t.slice(0, -4);
  else if (t.endsWith('USDT') && !t.includes('/')) t = t.slice(0, -4);
  else if (t.endsWith('USD') && !t.includes('/')) t = t.slice(0, -3);
  return t.includes('/') ? t : t.toUpperCase();
}

function candleToOHLCV(k) {
  const timeInSec = Math.floor(Number(k.t) / 1000);
  return {
    time: timeInSec,
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
  };
}

function dedupeSorted(bars) {
  const byTime = new Map();
  for (const b of bars) byTime.set(b.time, b);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function aggregate(sub, bucketSec) {
  const buckets = new Map();
  for (const b of sub) {
    const key = Math.floor(b.time / bucketSec) * bucketSec;
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume = (cur.volume || 0) + (b.volume || 0);
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function selectSubTf(targetMin) {
  return NATIVE_MINUTES.filter((m) => m < targetMin && targetMin % m === 0).sort((a, b) => b - a)[0] || null;
}

class HyperliquidProvider {
  constructor() {
    this.metaPromise = null;
    this.spotMetaPromise = null;
  }

  async fetchMeta() {
    if (this.metaPromise) return this.metaPromise;
    this.metaPromise = axios.post(INFO_URL, { type: 'meta' }, { timeout: 4000 })
      .then(res => res.data)
      .catch(err => {
        this.metaPromise = null;
        throw err;
      });
    return this.metaPromise;
  }

  async fetchSpotMeta() {
    if (this.spotMetaPromise) return this.spotMetaPromise;
    this.spotMetaPromise = axios.post(INFO_URL, { type: 'spotMeta' }, { timeout: 4000 })
      .then(res => res.data)
      .catch(err => {
        this.spotMetaPromise = null;
        throw err;
      });
    return this.spotMetaPromise;
  }

  async candleSnapshot(coin, interval, startTime, endTime) {
    const res = await axios.post(
      INFO_URL,
      {
        type: 'candleSnapshot',
        req: {
          coin,
          interval,
          startTime: Math.floor(startTime),
          endTime: Math.floor(endTime),
        },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
    );
    return Array.isArray(res.data) ? res.data : [];
  }

  /**
   * Fetch bars for a given symbol and timeframe, matching Vela's contract
   */
  async getBars(ticker, timeframe, limit = 1000) {
    try {
      const coin = parseCoin(ticker);
      const tf = normalizeTf(timeframe);
      const nativeInterval = TF_TO_INTERVAL[tf];

      const endMs = Date.now();
      const intervalMs = tfMs(tf);
      const startMs = endMs - (limit + 5) * intervalMs;

      if (nativeInterval) {
        const raw = await this.candleSnapshot(coin, nativeInterval, startMs, endMs);
        const bars = dedupeSorted(raw.map(candleToOHLCV));
        return bars.length > limit ? bars.slice(-limit) : bars;
      }

      // Aggregation fallback for non-native timeframes (e.g. 45m, 180m)
      const targetMin = /^\d+$/.test(tf) ? parseInt(tf, 10) : null;
      const subMin = targetMin != null ? selectSubTf(targetMin) : null;
      if (targetMin == null || subMin == null) {
        console.warn(`[HyperliquidProvider] Timeframe ${timeframe} is not natively supported.`);
        return [];
      }

      const ratio = targetMin / subMin;
      const subStartMs = endMs - (limit * ratio + 10) * (subMin * 60000);
      const subRaw = await this.candleSnapshot(coin, MIN_TO_INTERVAL[subMin], subStartMs, endMs);
      const subBars = subRaw.map(candleToOHLCV);
      const aggBars = aggregate(subBars, targetMin * 60);
      return aggBars.length > limit ? aggBars.slice(-limit) : aggBars;
    } catch (err) {
      console.warn(`[HyperliquidProvider] Failed to fetch ${ticker} ${timeframe}:`, err.message);
      return [];
    }
  }

  async getSymbolInfo(ticker) {
    const coin = parseCoin(ticker);
    try {
      const meta = await this.fetchMeta().catch(() => null);
      const perp = meta?.universe?.find(u => u.name === coin);
      if (perp) {
        const decimals = Math.max(0, 6 - (perp.szDecimals || 2));
        const mintick = Math.pow(10, -decimals);
        return {
          ticker: coin,
          symbol: `HYPERLIQUID:${coin}`,
          name: `${coin}-USDC`,
          description: `${coin} / USD Perpetual`,
          exchange: 'HYPERLIQUID',
          mintick,
          pricescale: Math.round(1 / mintick),
          maxLeverage: perp.maxLeverage || 50,
        };
      }
    } catch (e) {}

    return {
      ticker: coin,
      symbol: `HYPERLIQUID:${coin}`,
      name: coin,
      description: `${coin} Perpetual`,
      exchange: 'HYPERLIQUID',
      mintick: 0.01,
      pricescale: 100,
    };
  }
}

const hyperliquidProvider = new HyperliquidProvider();

module.exports = {
  HyperliquidProvider,
  hyperliquidProvider,
  TF_TO_INTERVAL,
  TF_NORMALIZE,
  normalizeTf,
  parseCoin,
  candleToOHLCV,
  dedupeSorted,
  aggregate,
};
