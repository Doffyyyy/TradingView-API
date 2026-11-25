const axios = require('axios');

const STOCK_EXCHANGES = new Set([
  'NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS', 'CBOE',
  'TSX', 'LSE', 'HKEX', 'TSE', 'XETR', 'ASX',
]);

const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS', 'CBOE']);

const NON_US_SUFFIX = {
  TSX: '.TO',
  LSE: '.L',
  HKEX: '.HK',
  TSE: '.T',
  XETR: '.DE',
  ASX: '.AX',
};

const TF_NORMALIZE = {
  '1m': '1', '1': '1',
  '3m': '3', '3': '3',
  '5m': '5', '5': '5',
  '15m': '15', '15': '15',
  '30m': '30', '30': '30',
  '1h': '60', '60': '60',
  '2h': '120', '120': '120',
  '4h': '240', '240': '240',
  '1d': 'D', 'd': 'D', 'D': 'D',
  '1w': 'W', 'w': 'W', 'W': 'W',
  '1mo': 'M', '1M': 'M', 'm': 'M', 'M': 'M',
};

const TF_PLANS = {
  '1': { interval: '1m', range: '5d' },
  '3': { interval: '1m', range: '5d', aggregateSec: 180 },
  '5': { interval: '5m', range: '1mo' },
  '15': { interval: '15m', range: '1mo' },
  '30': { interval: '30m', range: '1mo' },
  '60': { interval: '60m', range: '6mo' },
  '120': { interval: '60m', range: '6mo', aggregateSec: 7200 },
  '240': { interval: '60m', range: '6mo', aggregateSec: 14400 },
  'D': { interval: '1d', range: '2y' },
  'W': { interval: '1wk', range: '5y' },
  'M': { interval: '1mo', range: '10y' },
};

function parseStockSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string') return { exchange: '', ticker: '' };
  const raw = symbol.trim().toUpperCase();
  if (!raw.includes(':')) return { exchange: '', ticker: raw };
  const idx = raw.indexOf(':');
  return {
    exchange: raw.slice(0, idx).trim(),
    ticker: raw.slice(idx + 1).trim(),
  };
}

function isStockSymbol(symbol) {
  const { exchange, ticker } = parseStockSymbol(symbol);
  return Boolean(ticker) && STOCK_EXCHANGES.has(exchange);
}

function toYahooTicker(symbol) {
  const { exchange, ticker } = parseStockSymbol(symbol);
  if (!ticker) return '';
  if (!exchange || US_EXCHANGES.has(exchange)) {
    return ticker.replace(/\./g, '-');
  }
  const suffix = NON_US_SUFFIX[exchange];
  if (suffix && !ticker.endsWith(suffix)) {
    return `${ticker}${suffix}`;
  }
  return ticker;
}

function normalizeTimeframe(tf) {
  if (!tf) return 'D';
  const raw = String(tf).trim();
  return TF_NORMALIZE[raw] || TF_NORMALIZE[raw.toLowerCase()] || 'D';
}

function aggregateBars(bars, bucketSec) {
  const buckets = new Map();
  for (const bar of bars) {
    const key = Math.floor(bar.time / bucketSec) * bucketSec;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        time: key,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0,
      });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
      existing.volume += bar.volume || 0;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

function extractValidCandles(result) {
  const ts = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !quote) return [];

  const byTime = new Map();
  for (let i = 0; i < ts.length; i++) {
    const t = Math.floor(Number(ts[i]));
    const open = Number(quote.open?.[i]);
    const highRaw = Number(quote.high?.[i]);
    const lowRaw = Number(quote.low?.[i]);
    const close = Number(quote.close?.[i]);
    const volRaw = Number(quote.volume?.[i]);

    if (
      !Number.isFinite(t) || t <= 0 ||
      !Number.isFinite(open) || open <= 0 ||
      !Number.isFinite(highRaw) || highRaw <= 0 ||
      !Number.isFinite(lowRaw) || lowRaw <= 0 ||
      !Number.isFinite(close) || close <= 0
    ) {
      continue;
    }

    const high = Math.max(highRaw, open, close);
    const low = Math.min(lowRaw, open, close);
    byTime.set(t, {
      time: t,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volRaw) && volRaw >= 0 ? volRaw : 0,
    });
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

class StockProvider {
  constructor() {
    this.quoteCache = new Map();
    this.headers = { 'User-Agent': 'Mozilla/5.0' };
  }

  async fetchYahooChart(yahooTicker, params) {
    const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
    const encodedTicker = encodeURIComponent(yahooTicker);
    let lastError = null;

    for (const host of hosts) {
      try {
        const url = `https://${host}/v8/finance/chart/${encodedTicker}`;
        const res = await axios.get(url, {
          params,
          headers: this.headers,
          timeout: 5000,
        });
        const result = res.data?.chart?.result?.[0];
        if (result) return result;
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) throw lastError;
    return null;
  }

  async getBars(symbol, timeframe = 'D', limit = 1000) {
    const { exchange, ticker } = parseStockSymbol(symbol);
    const yahooTicker = toYahooTicker(symbol);
    if (!yahooTicker) return { candles: [], infos: {} };

    const normTf = normalizeTimeframe(timeframe);
    const plan = TF_PLANS[normTf] || TF_PLANS.D;

    let result = null;
    let candles = [];

    for (const includePrePost of [false, true]) {
      try {
        result = await this.fetchYahooChart(yahooTicker, {
          interval: plan.interval,
          range: plan.range,
          includePrePost,
        });
        candles = extractValidCandles(result);
        if (candles.length > 0) break;
      } catch (err) {
        if (includePrePost) {
          throw err;
        }
      }
    }

    if (plan.aggregateSec && candles.length > 0) {
      candles = aggregateBars(candles, plan.aggregateSec);
    }

    const maxBars = Math.max(1, Number(limit) || 1000);
    if (candles.length > maxBars) {
      candles = candles.slice(-maxBars);
    }

    const meta = result?.meta || {};
    const resolvedExchangeName = meta.fullExchangeName || meta.exchangeName || exchange || 'STOCK';

    return {
      candles,
      infos: {
        name: ticker,
        description: meta.longName || meta.shortName || ticker,
        exchange: exchange || resolvedExchangeName,
        exchangeName: resolvedExchangeName,
        currency: meta.currency || 'USD',
        provider: `Yahoo Finance (${resolvedExchangeName})`,
      },
    };
  }

  async getQuote(symbol) {
    const cacheKey = String(symbol || '').trim().toUpperCase();
    if (!cacheKey) return null;

    const cached = this.quoteCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < 5000)) {
      return cached.data;
    }

    const { exchange, ticker } = parseStockSymbol(symbol);
    const yahooTicker = toYahooTicker(symbol);
    if (!yahooTicker) return null;

    const result = await this.fetchYahooChart(yahooTicker, {
      interval: '1d',
      range: '5d',
      includePrePost: true,
    });
    const meta = result?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number' || !Number.isFinite(meta.regularMarketPrice)) {
      return null;
    }

    const close = meta.regularMarketPrice;
    const candles = extractValidCandles(result);
    const barPrevClose = candles.length >= 2 ? candles[candles.length - 2].close : null;
    const hasMetaPct = typeof meta.regularMarketChangePercent === 'number' && !isNaN(meta.regularMarketChangePercent);
    const pctPrevClose = (hasMetaPct && (1 + meta.regularMarketChangePercent / 100) !== 0)
      ? close / (1 + meta.regularMarketChangePercent / 100)
      : null;
    const prevClose = meta.previousClose || pctPrevClose || barPrevClose || meta.chartPreviousClose || close;
    const change = hasMetaPct
      ? meta.regularMarketChangePercent
      : (prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0);
    const change_abs = (typeof meta.regularMarketChange === 'number' && !isNaN(meta.regularMarketChange))
      ? meta.regularMarketChange
      : (close - prevClose);
    const volume = meta.regularMarketVolume || 0;
    const exchangeName = meta.fullExchangeName || meta.exchangeName || exchange || 'STOCK';
    const description = meta.longName || meta.shortName || ticker;
    const currency = meta.currency || 'USD';

    const quote = {
      symbol: ticker,
      exchange: exchange || exchangeName,
      exchangeName,
      description,
      currency,
      close,
      prevClose,
      change,
      change_abs,
      volume,
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      provider: `Yahoo Finance (${exchangeName})`,
    };

    this.quoteCache.set(cacheKey, { ts: Date.now(), data: quote });
    return quote;
  }

  async getBatchQuotes(symbols = []) {
    const out = {};
    if (!Array.isArray(symbols) || symbols.length === 0) return out;

    const results = await Promise.allSettled(
      symbols.map(async (sym) => ({ sym, quote: await this.getQuote(sym) }))
    );

    for (const item of results) {
      if (item.status === 'fulfilled' && item.value && item.value.quote) {
        out[item.value.sym] = item.value.quote;
      }
    }
    return out;
  }
}

const stockProvider = new StockProvider();

module.exports = {
  stockProvider,
  StockProvider,
  isStockSymbol,
  parseStockSymbol,
  toYahooTicker,
  STOCK_EXCHANGES,
};
