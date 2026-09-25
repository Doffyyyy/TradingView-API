const axios = require('axios');
const { paperTraderInstance } = require('./paperTrader');

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const HL_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';

/**
 * Normalizes symbols into Hyperliquid coin name
 * e.g. BINANCE:BTCUSDT -> BTC
 *      BYBIT:HYPEUSDT -> HYPE
 *      ETHUSDT -> ETH
 */
function normalizeCoin(symbolOrCoin) {
  if (!symbolOrCoin) return 'BTC';
  let s = symbolOrCoin.toUpperCase();
  if (s.includes(':')) {
    s = s.split(':')[1];
  }
  if (s.endsWith('.P')) s = s.slice(0, -2);
  if (s.endsWith('USDT')) s = s.slice(0, -4);
  else if (s.endsWith('USDC')) s = s.slice(0, -4);
  else if (s.endsWith('USD')) s = s.slice(0, -3);
  s = s.replace(/^_|_$/g, '').trim();
  // Special cases if any
  if (s === 'XTVCBTC' || s === 'BITCOIN') return 'BTC';
  if (s === 'XTVCETH' || s === 'ETHEREUM') return 'ETH';
  if (s === 'XTVCSOL') return 'SOL';
  return s || 'BTC';
}

class HyperliquidConnector {
  constructor() {
    this.activeWalletAddress = null;
    this.liveTradingEnabled = false;
    this.bookCache = {};
    this.screenerCache = {};
  }

  /**
   * Fetch L2 Orderbook from Hyperliquid
   */
  async getL2Book(coin = 'BTC') {
    const coinName = normalizeCoin(coin);
    try {
      const res = await axios.post(
        HL_INFO_URL,
        { type: 'l2Book', coin: coinName },
        { headers: { 'Content-Type': 'application/json' }, timeout: 4000 }
      );

      const data = res.data;
      if (!data || !data.levels || !Array.isArray(data.levels) || data.levels.length < 2) {
        throw new Error('Invalid orderbook format returned');
      }

      const rawBids = data.levels[0] || [];
      const rawAsks = data.levels[1] || [];

      // Sort bids desc, asks asc
      const bids = rawBids.map(b => ({
        price: parseFloat(b.px),
        size: parseFloat(b.sz),
        orders: b.n || 1,
      })).sort((a, b) => b.price - a.price).slice(0, 10);

      const asks = rawAsks.map(a => ({
        price: parseFloat(a.px),
        size: parseFloat(a.sz),
        orders: a.n || 1,
      })).sort((a, b) => a.price - b.price).slice(0, 10);

      // Compute cumulative totals
      let cumBid = 0;
      bids.forEach(b => {
        cumBid += b.size;
        b.total = cumBid;
      });

      let cumAsk = 0;
      asks.forEach(a => {
        cumAsk += a.size;
        a.total = cumAsk;
      });

      const maxTotal = Math.max(cumBid, cumAsk, 0.001);
      bids.forEach(b => { b.depthPercent = Math.min(100, (b.total / maxTotal) * 100); });
      asks.forEach(a => { a.depthPercent = Math.min(100, (a.total / maxTotal) * 100); });

      const bestBid = bids[0]?.price || 0;
      const bestAsk = asks[0]?.price || 0;
      const spread = bestAsk > bestBid && bestBid > 0 ? (bestAsk - bestBid) : 0;
      const spreadBP = bestBid > 0 ? ((spread / bestBid) * 10000).toFixed(2) : '0.00';

      const totalBidVol = bids.reduce((acc, b) => acc + b.size, 0);
      const totalAskVol = asks.reduce((acc, a) => acc + a.size, 0);
      const totalDepthVol = totalBidVol + totalAskVol || 1;
      const bidRatio = Math.round((totalBidVol / totalDepthVol) * 100);
      const askRatio = 100 - bidRatio;

      const formatted = {
        coin: coinName,
        bestBid,
        bestAsk,
        spread: spread > 0 ? (spread >= 1 ? spread.toFixed(1) : spread.toFixed(4)) : '0.00',
        spreadBP,
        imbalance: {
          bidPercent: bidRatio,
          askPercent: askRatio,
        },
        maxDepthTotal: Math.max(cumBid, cumAsk).toFixed(5),
        bids,
        asks: asks.reverse(), // reverse asks so highest price is at top in UI
        timestamp: Date.now(),
      };

      this.bookCache[coinName] = formatted;
      return formatted;
    } catch (err) {
      // Fallback cache if available
      if (this.bookCache[coinName]) return this.bookCache[coinName];
      throw err;
    }
  }

  /**
   * Fetch 5M & 15M Screener Statistics from Hyperliquid
   */
  async getScreener(coin = 'BTC') {
    const coinName = normalizeCoin(coin);
    try {
      const nowMs = Date.now();
      const [res5m, res15m] = await Promise.all([
        axios.post(
          HL_INFO_URL,
          {
            type: 'candleSnapshot',
            req: { coin: coinName, interval: '5m', startTime: nowMs - 4 * 3600 * 1000 },
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 4000 }
        ),
        axios.post(
          HL_INFO_URL,
          {
            type: 'candleSnapshot',
            req: { coin: coinName, interval: '15m', startTime: nowMs - 12 * 3600 * 1000 },
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 4000 }
        ),
      ]);

      const candles5m = res5m.data || [];
      const candles15m = res15m.data || [];

      function parseCandleStats(candles) {
        if (!candles || candles.length === 0) {
          return { trades: '--', changePercent: '+0.00%', volume: '$0', volumeDelta: '$0' };
        }
        const last = candles[candles.length - 1];
        const prev = candles.length > 1 ? candles[candles.length - 2] : last;

        const open = parseFloat(last.o);
        const close = parseFloat(last.c);
        const chgPct = open > 0 ? ((close - open) / open) * 100 : 0;

        const trades = parseInt(last.n, 10) || 0;
        const volumeUsd = (parseFloat(last.v) || 0) * close;

        const prevVolUsd = (parseFloat(prev.v) || 0) * parseFloat(prev.c);
        const volDelta = volumeUsd - prevVolUsd;

        function fmtNum(n) {
          if (n >= 1e6) return (n / 1e6).toFixed(2) + 'm';
          if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
          return n.toFixed(0);
        }

        return {
          trades: fmtNum(trades),
          rawTrades: trades,
          changePercent: (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%',
          rawChangePercent: chgPct,
          volume: '$' + fmtNum(volumeUsd),
          rawVolume: volumeUsd,
          volumeDelta: (volDelta >= 0 ? '+$' : '-$') + fmtNum(Math.abs(volDelta)),
          rawVolumeDelta: volDelta,
        };
      }

      const screenerData = {
        coin: coinName,
        m5: parseCandleStats(candles5m),
        m15: parseCandleStats(candles15m),
        timestamp: Date.now(),
      };

      this.screenerCache[coinName] = screenerData;
      return screenerData;
    } catch (err) {
      if (this.screenerCache[coinName]) return this.screenerCache[coinName];
      return {
        coin: coinName,
        m5: { trades: '--', changePercent: '0.00%', rawChangePercent: 0, volume: '--', volumeDelta: '--', rawVolumeDelta: 0 },
        m15: { trades: '--', changePercent: '0.00%', rawChangePercent: 0, volume: '--', volumeDelta: '--', rawVolumeDelta: 0 },
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Fetch complete Ticker Bar details matching Hyperliquid header
   */
  async getTickerDetails(coin = 'BTC') {
    const coinName = normalizeCoin(coin);
    try {
      const res = await axios.post(
        HL_INFO_URL,
        { type: 'metaAndAssetCtxs' },
        { headers: { 'Content-Type': 'application/json' }, timeout: 4000 }
      );
      const universe = res.data[0]?.universe || [];
      const ctxs = res.data[1] || [];
      const idx = universe.findIndex(u => u.name === coinName);
      
      let markPx = 0, oraclePx = 0, chgPct = 0, oiUsd = 0, vlmUsd = 0, fundingPct = 0;
      if (idx !== -1 && ctxs[idx]) {
        const ctx = ctxs[idx];
        markPx = parseFloat(ctx.markPx) || 0;
        oraclePx = parseFloat(ctx.oraclePx || ctx.markPx) || markPx;
        const prevDayPx = parseFloat(ctx.prevDayPx) || markPx;
        chgPct = prevDayPx > 0 ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0;
        oiUsd = (parseFloat(ctx.openInterest) || 0) * markPx;
        vlmUsd = parseFloat(ctx.dayNtlVlm) || 0;
        fundingPct = (parseFloat(ctx.funding) || 0) * 100;
      }

      function fmtUsd(v) {
        if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 't';
        if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'b';
        if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'm';
        if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
        return '$' + v.toFixed(2);
      }

      const SUPPLIES = {
        BTC: { circ: 19800000, total: 21000000 },
        ETH: { circ: 120500000, total: 120500000 },
        SOL: { circ: 470000000, total: 590000000 },
        HYPE: { circ: 333000000, total: 1000000000 },
        SUI: { circ: 2850000000, total: 10000000000 },
        ARB: { circ: 4100000000, total: 10000000000 },
      };
      const sup = SUPPLIES[coinName] || { circ: 100000000, total: 100000000 };
      const mcap = sup.circ * markPx;
      const fdv = sup.total * markPx;

      return {
        coin: coinName,
        symbol: `${coinName}-USDC`,
        exchange: 'HYPERLIQUID',
        last: markPx >= 1 ? '$' + Math.round(markPx).toLocaleString('en-US') : '$' + markPx.toFixed(4),
        rawLast: markPx,
        index: oraclePx >= 1 ? '$' + Math.round(oraclePx).toLocaleString('en-US') : '$' + oraclePx.toFixed(4),
        change: (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%',
        rawChange: chgPct,
        volume: fmtUsd(vlmUsd),
        openInterest: fmtUsd(oiUsd),
        funding: fundingPct.toFixed(4) + '%',
        rawFunding: fundingPct,
        marketcap: fmtUsd(mcap),
        fdv: fmtUsd(fdv),
        timestamp: Date.now(),
      };
    } catch (e) {
      return {
        coin: coinName,
        symbol: `${coinName}-USDC`,
        exchange: 'HYPERLIQUID',
        last: '--',
        rawLast: 0,
        index: '--',
        change: '0.00%',
        rawChange: 0,
        volume: '--',
        openInterest: '--',
        funding: '0.0000%',
        marketcap: '--',
        fdv: '--',
      };
    }
  }

  /**
   * Get Account State: Either Connected Hyperliquid Wallet or Paper Account
   */
  async getAccountState(walletAddress = null) {
    const targetAddress = walletAddress || this.activeWalletAddress;
    if (!targetAddress) {
      // Return Paper Trader state as default available capital
      const status = paperTraderInstance.getStatus();
      return {
        connected: false,
        mode: 'PAPER',
        walletAddress: null,
        available: status.balance || 10000.0,
        equity: status.equity || 10000.0,
        positionsCount: status.openPositions?.length || 0,
        positions: status.openPositions || [],
        dailyPnl: status.dailyPnl || 0.0,
      };
    }

    try {
      const res = await axios.post(
        HL_INFO_URL,
        { type: 'clearinghouseState', user: targetAddress },
        { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
      );

      const d = res.data;
      const margin = d.marginSummary || {};
      const positions = (d.assetPositions || []).map(p => {
        const pos = p.position || {};
        return {
          coin: pos.coin,
          szi: parseFloat(pos.szi),
          side: parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT',
          entryPx: parseFloat(pos.entryPx),
          unrealizedPnl: parseFloat(pos.unrealizedPnl),
          leverage: pos.leverage?.value || 1,
          liquidationPx: pos.liquidationPx ? parseFloat(pos.liquidationPx) : null,
        };
      });

      return {
        connected: true,
        mode: 'HYPERLIQUID_LIVE',
        walletAddress: targetAddress,
        available: parseFloat(d.withdrawable || margin.accountValue || 0),
        equity: parseFloat(margin.accountValue || 0),
        marginUsed: parseFloat(margin.totalMarginUsed || 0),
        positionsCount: positions.length,
        positions,
      };
    } catch (e) {
      return {
        connected: false,
        error: e.message,
        mode: 'PAPER_FALLBACK',
        available: paperTraderInstance.portfolio.cash,
        equity: paperTraderInstance.portfolio.equity,
        positions: paperTraderInstance.portfolio.positions,
      };
    }
  }

  /**
   * Execute Order: Route to Paper Trader or Hyperliquid Live DEX
   */
  async executeTrade({ coin = 'BTC', side = 'LONG', orderType = 'MARKET', size = 0, notional = 0, price = 0, mode = 'paper', reduceOnly = false, tp = null, sl = null }) {
    const coinName = normalizeCoin(coin);
    const sym = `BINANCE:${coinName}USDT`; // default symbol representation for paper trader

    if (mode === 'paper' || !this.activeWalletAddress) {
      // Execute in Paper Trader
      const notionalVal = notional > 0 ? notional : (size * (price || 1));
      if (notionalVal <= 0) {
        throw new Error('Please specify a positive size or notional amount');
      }

      // If reduce-only and has position, close it
      if (reduceOnly) {
        const existing = paperTraderInstance.portfolio.positions.find(p => p.symbol.includes(coinName));
        if (existing) {
          const currentPrice = price || existing.entryPrice;
          paperTraderInstance.closePosition(existing.id, currentPrice, 'Manual Reduce-Only Close from Terminal Dock');
          return {
            status: 'SUCCESS',
            mode: 'PAPER',
            action: 'CLOSE',
            positionId: existing.id,
            symbol: existing.symbol,
            price: currentPrice,
          };
        }
      }

      const strategyName = 'Manual Terminal Execution';
      const reason = `Manual ${side} order on ${coinName} via Proliquid Trading Deck. TP: ${tp || 'auto'}, SL: ${sl || 'auto'}`;
      
      const pos = await paperTraderInstance.openPosition(sym, side.toUpperCase(), strategyName, reason);
      if (pos && tp) pos.takeProfit = parseFloat(tp);
      if (pos && sl) pos.stopLoss = parseFloat(sl);
      paperTraderInstance.savePortfolio();

      return {
        status: 'SUCCESS',
        mode: 'PAPER',
        order: {
          id: pos?.id || ('ord_' + Date.now()),
          symbol: sym,
          coin: coinName,
          side: side.toUpperCase(),
          notional: notionalVal,
          price: price || pos?.entryPrice,
          tp: pos?.takeProfit,
          sl: pos?.stopLoss,
        },
      };
    }

    // LIVE HYPERLIQUID EXECUTION
    // Requires user's agent wallet key or EIP-712 signer
    throw new Error('Hyperliquid Live Order Execution requires configured agent API key. Connect wallet in settings.');
  }
}

const hyperliquidInstance = new HyperliquidConnector();

module.exports = {
  HyperliquidConnector,
  hyperliquidInstance,
  normalizeCoin,
};
