/**
 * User Profile & Per-Account Data Isolation Manager
 *
 * Implements Zero-Trust RBAC Partitioning:
 * 1. Watchlist: Scoped per user account (stored in data/user_watchlists/<safeId>.json).
 * 2. Live Journal: Scoped personal paper portfolio per user account (stored in data/user_portfolios/<safeId>.json).
 * 3. Simulated Journal: Restrictive access to ADMIN only (data/simulated_6month_pnl.json).
 * 4. Telegram Alert Config: Self-service for ALL authenticated users (add, edit, test, delete).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const WATCHLISTS_DIR = path.join(DATA_DIR, 'user_watchlists');
const PORTFOLIOS_DIR = path.join(DATA_DIR, 'user_portfolios');
const TELEGRAMS_DIR = path.join(DATA_DIR, 'user_telegrams');
const STRATEGIES_DIR = path.join(DATA_DIR, 'user_strategies');

// Ensure storage directories exist
[WATCHLISTS_DIR, PORTFOLIOS_DIR, TELEGRAMS_DIR, STRATEGIES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }
});

const BUILTIN_STRATEGIES = [
  {
    id: 'builtin_oliver_kell',
    name: 'Oliver Kell Price Cycle & Trend Pullback',
    type: 'builtin',
    badge: 'Hệ Thống Lõi (Core Engine)',
    timeframe: '15m / 1H',
    description: 'Theo dõi chu kỳ giá EMA10 > EMA20 > EMA50, kích hoạt điểm vào lệnh khi Retest EMA và chốt lời tại R:R 2.2R.',
    author: 'Hyperview Quantitative Labs',
    tags: ['Trend', 'EMA Cycle', '2.2R'],
    riskProfile: 'Balanced (Max 2x Leverage)',
  },
  {
    id: 'builtin_astra_supertrend',
    name: 'Astra-Supertrend Confluence + MACD',
    type: 'builtin',
    badge: 'Theo Xu Hướng (Trend Following)',
    timeframe: '5m / 15m',
    description: 'Kết hợp tín hiệu chuyển màu dải Astra-Supertrend với động lượng MACD Histogram, tối ưu điểm đảo chiều.',
    author: 'Hyperview Quantitative Labs',
    tags: ['Supertrend', 'Momentum', 'Confluence'],
    riskProfile: 'Conservative (1x~2x Leverage)',
  },
  {
    id: 'builtin_luxalgo_smc',
    name: 'LuxAlgo SMC / Order Flow & FVG',
    type: 'builtin',
    badge: 'Dòng Tiền Thông Minh (Smart Money)',
    timeframe: '15m / 1H',
    description: 'Phát hiện Fair Value Gap (FVG), phá vỡ cấu trúc thị trường (BOS) và quét thanh khoản từ Big Boys.',
    author: 'Hyperview Quantitative Labs',
    tags: ['SMC', 'Order Flow', 'FVG'],
    riskProfile: 'Sniper (Tight Stop Loss)',
  },
  {
    id: 'builtin_sniper_momentum',
    name: 'Sniper Momentum Scalping 2x',
    type: 'builtin',
    badge: 'Lướt Sóng Nhanh (High Win-Rate)',
    timeframe: '1m / 5m',
    description: 'Bắt nhịp nén Bollinger Bands và RSI quá bán (<30) / quá mua (>70) để chốt lời nhanh trong ngày.',
    author: 'Hyperview Quantitative Labs',
    tags: ['Scalping', 'RSI', 'Bollinger'],
    riskProfile: 'Aggressive Scalp',
  },
];

const STARTER_CODE_TEMPLATES = {
  rsi_scalp: `/**
 * Strategy: RSI Mean-Reversion Scalp
 * @param {Object} market - { symbol, price, high, low, volume, rsi, ema10, ema20, ema50, supertrend, macd }
 * @param {Object} portfolio - { balance, cash, equity, openPositions }
 * @returns {Object|null} - { action: 'BUY'|'SELL'|'CLOSE', symbol, sizePct, tp, sl, reason } or null
 */
function onTick(market, portfolio) {
  const { symbol, price, rsi, ema10, ema20 } = market;
  const hasPosition = (portfolio.openPositions || []).some(p => p.symbol === symbol);

  // 1. Quá bán (Oversold < 32) + EMA10 cắt lên EMA20 -> Mua Long
  if (!hasPosition && rsi < 32 && ema10 >= ema20) {
    return {
      action: 'BUY',
      symbol: symbol,
      sizePct: 25, // 25% vốn khả dụng
      tp: Math.round(price * 1.03 * 100) / 100, // Chốt lời +3%
      sl: Math.round(price * 0.985 * 100) / 100, // Cắt lỗ -1.5%
      reason: 'RSI Quá bán (' + rsi.toFixed(1) + ') kết hợp EMA10 cắt lên'
    };
  }

  // 2. Quá mua (Overbought > 70) -> Đóng vị thế chốt lời
  if (hasPosition && rsi > 70) {
    return {
      action: 'CLOSE',
      symbol: symbol,
      reason: 'RSI Quá mua (' + rsi.toFixed(1) + ') chốt lời vị thế'
    };
  }

  return null; // Không có tín hiệu, giữ nguyên
}`,
  ema_cross: `/**
 * Strategy: EMA Dual Trend Runner (EMA10 x EMA50)
 * @param {Object} market - { symbol, price, high, low, volume, rsi, ema10, ema20, ema50, supertrend, macd }
 * @param {Object} portfolio - { balance, cash, equity, openPositions }
 */
function onTick(market, portfolio) {
  const { symbol, price, ema10, ema50, supertrend } = market;
  const hasPosition = (portfolio.openPositions || []).some(p => p.symbol === symbol);

  // Golden Cross: EMA10 > EMA50 và Supertrend Bullish -> Mua
  if (!hasPosition && ema10 > ema50 && supertrend === 'BULLISH') {
    return {
      action: 'BUY',
      symbol: symbol,
      sizePct: 30,
      tp: Math.round(price * 1.05 * 100) / 100, // Chốt lời +5%
      sl: Math.round(ema50 * 0.995 * 100) / 100, // Dừng lỗ dưới EMA50
      reason: 'Golden Cross EMA10/50 kết hợp Supertrend Bullish'
    };
  }

  // Death Cross: EMA10 < EMA50 -> Đóng lệnh
  if (hasPosition && ema10 < ema50) {
    return {
      action: 'CLOSE',
      symbol: symbol,
      reason: 'Death Cross EMA10/50 đảo chiều'
    };
  }

  return null;
}`,
  breakout: `/**
 * Strategy: Breakout Volume Surge
 * @param {Object} market - { symbol, price, high, low, volume, rsi, ema10, ema20, ema50, supertrend, macd }
 * @param {Object} portfolio - { balance, cash, equity, openPositions }
 */
function onTick(market, portfolio) {
  const { symbol, price, high, volume, rsi } = market;
  const hasPosition = (portfolio.openPositions || []).some(p => p.symbol === symbol);

  // Giá tiệm cận đỉnh 24h kèm RSI mạnh (> 58) -> Đánh Breakout
  if (!hasPosition && price >= (high * 0.998) && rsi > 58 && rsi < 78) {
    return {
      action: 'BUY',
      symbol: symbol,
      sizePct: 20,
      tp: Math.round(price * 1.04 * 100) / 100,
      sl: Math.round(price * 0.98 * 100) / 100,
      reason: 'Breakout đỉnh 24h kèm dòng tiền bứt phá'
    };
  }

  return null;
}`
};

// Default shared watchlist for initial user orientation
const DEFAULT_WATCHLIST = [
  { symbol: 'BINANCE:BTCUSDT', name: 'BTCUSDT', exchange: 'BINANCE' },
  { symbol: 'BINANCE:ETHUSDT', name: 'ETHUSDT', exchange: 'BINANCE' },
  { symbol: 'BINANCE:SOLUSDT', name: 'SOLUSDT', exchange: 'BINANCE' },
  { symbol: 'BINANCE:BNBUSDT', name: 'BNBUSDT', exchange: 'BINANCE' },
  { symbol: 'BINANCE:DOGEUSDT', name: 'DOGEUSDT', exchange: 'BINANCE' },
  { symbol: 'BINANCE:XRPUSDT', name: 'XRPUSDT', exchange: 'BINANCE' },
  { symbol: 'BINANCE:PEPEUSDT', name: 'PEPEUSDT', exchange: 'BINANCE' },
  { symbol: 'BINANCE:SUIUSDT', name: 'SUIUSDT', exchange: 'BINANCE' },
  { symbol: 'BINANCE:ARBUSDT', name: 'ARBUSDT', exchange: 'BINANCE' },
  { symbol: 'BINANCE:OPUSDT', name: 'OPUSDT', exchange: 'BINANCE' },
];

function sanitizeUserId(userId) {
  if (!userId) return 'anonymous';
  return String(userId).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

class UserProfileManager {
  // --------------------------------------------------------------------------
  // 1. WATCHLIST (Per-Account Isolated)
  // --------------------------------------------------------------------------
  getUserWatchlist(userId) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(WATCHLISTS_DIR, `${safeId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
      } catch (e) {
        console.warn(`[UserProfileManager] Failed to read watchlist for ${userId}:`, e.message);
      }
    }
    return DEFAULT_WATCHLIST;
  }

  saveUserWatchlist(userId, watchlist) {
    if (!Array.isArray(watchlist)) throw new Error('Watchlist must be an array');
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(WATCHLISTS_DIR, `${safeId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(watchlist, null, 2), 'utf8');
    return true;
  }

  // --------------------------------------------------------------------------
  // 2. LIVE JOURNAL / PAPER PORTFOLIO ($10,000 Initial Capital Per User)
  // --------------------------------------------------------------------------
  getUserPortfolio(userId) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(PORTFOLIOS_DIR, `${safeId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const port = JSON.parse(raw);
        if (!Array.isArray(port.openPositions)) port.openPositions = [];
        if (!Array.isArray(port.closedTrades)) port.closedTrades = [];
        if (!Array.isArray(port.recentLogs)) port.recentLogs = [];
        if (typeof port.cash === 'undefined') port.cash = port.balance || 10000.0;
        return port;
      } catch (e) {
        console.warn(`[UserProfileManager] Failed to read portfolio for ${userId}:`, e.message);
      }
    }

    // Default clean account for new members ($10,000 USD initial capital)
    const initialPortfolio = {
      userId,
      initialBalance: 10000.0,
      balance: 10000.0,
      cash: 10000.0,
      equity: 10000.0,
      realizedPnl: 0.0,
      unrealizedPnl: 0.0,
      dailyRealizedPnl: 0.0,
      dailyTargetMax: 300.0,
      dailyStopLossMax: 180.0,
      autoTradeEnabled: false,
      strategyMode: 'Oliver Kell Cycle + Astra-Supertrend',
      maxOpenPositions: 3,
      openPositions: [],
      closedTrades: [],
      recentLogs: [
        `[${new Date().toISOString().slice(11, 19)}] Personal paper trading account initialized with $10,000.00 USD capital.`,
      ],
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(initialPortfolio, null, 2), 'utf8');
    return initialPortfolio;
  }

  saveUserPortfolio(userId, portfolio) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(PORTFOLIOS_DIR, `${safeId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(portfolio, null, 2), 'utf8');
    return true;
  }

  /**
   * Execute Paper Order for User (Manual Trade via Proliquid Dock or Bot Strategy)
   */
  executePaperTrade(userId, { coin = 'BTC', side = 'LONG', orderType = 'MARKET', size = 0, notional = 0, price = 0, reduceOnly = false, tp = null, sl = null, strategy = 'Manual Execution' }) {
    const port = this.getUserPortfolio(userId);
    const coinName = normalizeCoin(coin);
    const sym = `BINANCE:${coinName}USDT`;
    const execPrice = parseFloat(price) || (port.latestPrices && port.latestPrices[sym]?.price) || 80000;
    const notionalVal = parseFloat(notional) > 0 ? parseFloat(notional) : (parseFloat(size) * execPrice);

    if (notionalVal <= 0 && !reduceOnly) {
      throw new Error('Vui lòng nhập khối lượng hoặc số tiền hợp lệ');
    }

    // 1. Reduce-Only / Close matching existing position
    if (reduceOnly) {
      const existingIdx = port.openPositions.findIndex(p => p.symbol.includes(coinName) || p.coin === coinName);
      if (existingIdx >= 0) {
        const closed = this.closeUserPosition(userId, port.openPositions[existingIdx].id, execPrice, 'Manual Reduce-Only Close from Dock');
        return {
          status: 'SUCCESS',
          mode: 'PAPER',
          action: 'CLOSE',
          positionId: closed.trade.id,
          symbol: sym,
          pnl: closed.trade.pnl,
          price: execPrice,
        };
      } else {
        throw new Error(`Không tìm thấy vị thế mở của ${coinName} để đóng`);
      }
    }

    // 2. Open new position
    if (port.openPositions.length >= (port.maxOpenPositions || 4)) {
      throw new Error(`Đã đạt giới hạn tối đa vị thế mở (${port.maxOpenPositions || 4})`);
    }

    // Prevent duplicate same coin
    if (port.openPositions.some(p => p.coin === coinName || p.symbol === sym)) {
      throw new Error(`Bạn đã có một vị thế đang mở với ${coinName}`);
    }

    const marginRequired = Math.round((notionalVal / 1.0) * 100) / 100;
    if (marginRequired > port.cash) {
      throw new Error(`Số dư khả dụng không đủ (Cần $${marginRequired.toFixed(2)}, còn $${port.cash.toFixed(2)})`);
    }

    const calculatedSize = parseFloat(size) > 0 ? parseFloat(size) : (notionalVal / execPrice);
    const stopLoss = sl ? parseFloat(sl) : (side === 'LONG' ? execPrice * 0.985 : execPrice * 1.015);
    const takeProfit = tp ? parseFloat(tp) : (side === 'LONG' ? execPrice * 1.033 : execPrice * 0.967);

    const position = {
      id: 'pos_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      symbol: sym,
      coin: coinName,
      side: side.toUpperCase(),
      entryPrice: Math.round(execPrice * 100) / 100,
      size: Math.round(calculatedSize * 10000) / 10000,
      notional: Math.round(notionalVal * 100) / 100,
      margin: marginRequired,
      stopLoss: Math.round(stopLoss * 100) / 100,
      takeProfit: Math.round(takeProfit * 100) / 100,
      unrealizedPnl: 0,
      entryTime: new Date().toISOString(),
      strategy: strategy || 'Manual Dock Trade',
    };

    port.openPositions.push(position);
    port.cash = Math.max(0, Math.round((port.cash - marginRequired) * 100) / 100);
    port.recentLogs.unshift(`[${new Date().toISOString().slice(11, 19)}] OPEN ${position.side} ${coinName} @ $${position.entryPrice} ($${position.notional} notional)`);

    this.saveUserPortfolio(userId, port);

    return {
      status: 'SUCCESS',
      mode: 'PAPER',
      order: position,
      portfolio: {
        balance: port.balance,
        cash: port.cash,
        openCount: port.openPositions.length,
      },
    };
  }

  /**
   * Close a specific user position
   */
  closeUserPosition(userId, positionId, exitPrice = 0, reason = 'Manual Close') {
    const port = this.getUserPortfolio(userId);
    const idx = port.openPositions.findIndex(p => p.id === positionId);
    if (idx < 0) throw new Error('Vị thế không tồn tại hoặc đã được đóng');

    const pos = port.openPositions[idx];
    const finalExitPrice = parseFloat(exitPrice) || pos.entryPrice;
    const priceDiff = pos.side === 'LONG' ? (finalExitPrice - pos.entryPrice) : (pos.entryPrice - finalExitPrice);
    const rawPnl = priceDiff * pos.size;
    const fee = (pos.notional + (pos.size * finalExitPrice)) * 0.0005; // 0.05% taker fee
    const netPnl = Math.round((rawPnl - fee) * 100) / 100;
    const pnlPercent = Math.round((netPnl / (pos.margin || pos.notional || 1)) * 10000) / 100;

    const closedTrade = {
      id: 'trade_' + Date.now(),
      positionId: pos.id,
      symbol: pos.symbol,
      coin: pos.coin,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: Math.round(finalExitPrice * 100) / 100,
      size: pos.size,
      pnl: netPnl,
      pnlPercent: pnlPercent,
      fee: Math.round(fee * 100) / 100,
      entryTime: pos.entryTime,
      exitTime: new Date().toISOString(),
      reason: reason || 'Manual Close',
      strategy: pos.strategy,
    };

    port.openPositions.splice(idx, 1);
    port.closedTrades.unshift(closedTrade);
    port.cash = Math.round((port.cash + pos.margin + netPnl) * 100) / 100;
    port.balance = Math.round((port.balance + netPnl) * 100) / 100;
    port.equity = port.balance;
    port.realizedPnl = Math.round((port.realizedPnl + netPnl) * 100) / 100;
    port.dailyRealizedPnl = Math.round((port.dailyRealizedPnl + netPnl) * 100) / 100;

    port.recentLogs.unshift(`[${new Date().toISOString().slice(11, 19)}] CLOSED ${pos.side} ${pos.coin}: PnL ${netPnl >= 0 ? '+' : ''}$${netPnl} (${pnlPercent}%). ${reason}`);

    this.saveUserPortfolio(userId, port);
    return { success: true, trade: closedTrade, portfolio: port };
  }

  /**
   * Toggle Bot Strategy on User Portfolio
   */
  toggleUserAutoTrade(userId) {
    const port = this.getUserPortfolio(userId);
    port.autoTradeEnabled = !port.autoTradeEnabled;
    port.recentLogs.unshift(`[${new Date().toISOString().slice(11, 19)}] Bot Strategy Auto-Trading switched to: ${port.autoTradeEnabled ? 'ACTIVE ⚡' : 'PAUSED ⏸️'}`);
    this.saveUserPortfolio(userId, port);
    return port.autoTradeEnabled;
  }

  /**
   * Get User Paper Status formatted for Dashboard & Journal UI
   */
  getUserPaperStatus(userId, latestPrices = {}) {
    const port = this.getUserPortfolio(userId);
    let totalUnrealizedPnl = 0;

    const positionsWithPnl = port.openPositions.map(pos => {
      const curr = (latestPrices[pos.symbol]?.price) || pos.entryPrice;
      const priceDiff = pos.side === 'LONG' ? (curr - pos.entryPrice) : (pos.entryPrice - curr);
      const uPnl = Math.round(priceDiff * pos.size * 100) / 100;
      totalUnrealizedPnl += uPnl;
      return Object.assign({}, pos, {
        currentPrice: curr,
        unrealizedPnl: uPnl,
        pnlPercent: Math.round((uPnl / (pos.margin || 1)) * 10000) / 100,
      });
    });

    totalUnrealizedPnl = Math.round(totalUnrealizedPnl * 100) / 100;
    const currentEquity = Math.round((port.balance + totalUnrealizedPnl) * 100) / 100;

    return {
      userId,
      isUserPortfolio: true,
      initialBalance: port.initialBalance || 10000.0,
      balance: port.balance,
      cash: port.cash,
      equity: currentEquity,
      realizedPnl: port.realizedPnl,
      unrealizedPnl: totalUnrealizedPnl,
      dailyRealizedPnl: port.dailyRealizedPnl,
      dailyPnl: Math.round((port.dailyRealizedPnl + totalUnrealizedPnl) * 100) / 100,
      autoTradeEnabled: port.autoTradeEnabled,
      openPositions: positionsWithPnl,
      positions: positionsWithPnl,
      closedTrades: port.closedTrades,
      trades: port.closedTrades,
      allTrades: port.closedTrades,
      recentLogs: port.recentLogs,
    };
  }

  // --------------------------------------------------------------------------
  // 3. TELEGRAM CONFIGURATION (Self-Service For All Users)
  // --------------------------------------------------------------------------
  getUserTelegram(userId) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(TELEGRAMS_DIR, `${safeId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
      } catch (e) {}
    }
    return {
      configured: false,
      token: '',
      chatId: '',
      channels: [],
      alertsEnabled: {
        astraSupertrend: true,
        luxalgo: true,
        confluenceSignals: true,
      },
      updatedAt: null,
    };
  }

  saveUserTelegram(userId, config) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(TELEGRAMS_DIR, `${safeId}.json`);
    const current = this.getUserTelegram(userId);

    const merged = {
      configured: !!(config.token && config.chatId),
      token: config.token || current.token || '',
      chatId: config.chatId || current.chatId || '',
      channels: Array.isArray(config.channels) ? config.channels : (current.channels || []),
      alertsEnabled: Object.assign({}, current.alertsEnabled, config.alertsEnabled || {}),
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  deleteUserTelegram(userId) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(TELEGRAMS_DIR, `${safeId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        return true;
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // 4. STRATEGY STUDIO & CUSTOM CODE ENGINE (Built-in + User Custom Code)
  // --------------------------------------------------------------------------
  getBuiltinStrategies() {
    return BUILTIN_STRATEGIES;
  }

  getStarterTemplates() {
    return STARTER_CODE_TEMPLATES;
  }

  getUserStrategies(userId) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(STRATEGIES_DIR, `${safeId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return list;
      } catch (e) {
        console.warn(`[UserProfileManager] Failed to read strategies for ${userId}:`, e.message);
      }
    }
    return [];
  }

  /**
   * Validate JavaScript code syntax safely using Node.js vm
   */
  validateStrategyCode(code) {
    if (!code || typeof code !== 'string' || !code.trim()) {
      return { valid: false, error: 'Mã nguồn không được để trống' };
    }
    try {
      // Check syntax compilation
      new vm.Script(code + '\n; typeof onTick === "function";');
      if (!code.includes('onTick')) {
        return { valid: false, error: 'Mã nguồn phải định nghĩa hàm: function onTick(market, portfolio) { ... }' };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, error: `Lỗi cú pháp JavaScript: ${err.message}` };
    }
  }

  saveUserStrategy(userId, { id, name, description, code, timeframe }) {
    if (!name || !name.trim()) throw new Error('Vui lòng đặt tên cho chiến lược');
    const val = this.validateStrategyCode(code);
    if (!val.valid) throw new Error(val.error);

    const safeId = sanitizeUserId(userId);
    const filePath = path.join(STRATEGIES_DIR, `${safeId}.json`);
    const currentList = this.getUserStrategies(userId);

    const stratId = id || ('strat_custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
    const now = new Date().toISOString();

    const existingIdx = currentList.findIndex(s => s.id === stratId);
    const stratObj = {
      id: stratId,
      name: name.trim(),
      description: (description || '').trim(),
      code: code.trim(),
      timeframe: timeframe || '15m',
      type: 'custom',
      badge: 'Tự Thêm (Custom Code)',
      author: userId || 'User',
      updatedAt: now,
      createdAt: existingIdx >= 0 ? currentList[existingIdx].createdAt : now,
    };

    if (existingIdx >= 0) {
      currentList[existingIdx] = stratObj;
    } else {
      currentList.push(stratObj);
    }

    fs.writeFileSync(filePath, JSON.stringify(currentList, null, 2), 'utf8');
    return stratObj;
  }

  deleteUserStrategy(userId, strategyId) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(STRATEGIES_DIR, `${safeId}.json`);
    let currentList = this.getUserStrategies(userId);
    const beforeCount = currentList.length;
    currentList = currentList.filter(s => s.id !== strategyId);
    if (currentList.length !== beforeCount) {
      fs.writeFileSync(filePath, JSON.stringify(currentList, null, 2), 'utf8');
    }

    // If active strategy was this one, reset to default built-in
    const port = this.getUserPortfolio(userId);
    if (port.activeStrategyId === strategyId) {
      port.activeStrategyId = 'builtin_oliver_kell';
      port.strategyMode = BUILTIN_STRATEGIES[0].name;
      this.saveUserPortfolio(userId, port);
    }
    return true;
  }

  getActiveStrategy(userId) {
    const port = this.getUserPortfolio(userId);
    const activeId = port.activeStrategyId || 'builtin_oliver_kell';

    // Search in builtins
    const b = BUILTIN_STRATEGIES.find(s => s.id === activeId);
    if (b) return b;

    // Search in user's custom strategies
    const customs = this.getUserStrategies(userId);
    const c = customs.find(s => s.id === activeId);
    if (c) return c;

    // Fallback
    return BUILTIN_STRATEGIES[0];
  }

  setActiveStrategy(userId, strategyId) {
    const port = this.getUserPortfolio(userId);
    let target = BUILTIN_STRATEGIES.find(s => s.id === strategyId);
    if (!target) {
      const customs = this.getUserStrategies(userId);
      target = customs.find(s => s.id === strategyId);
    }
    if (!target) throw new Error('Chiến lược không tồn tại');

    port.activeStrategyId = target.id;
    port.strategyMode = target.name;
    port.recentLogs.unshift(`[${new Date().toISOString().slice(11, 19)}] Đã chuyển sang chiến lược: ${target.name} (${target.badge})`);
    this.saveUserPortfolio(userId, port);
    return target;
  }

  /**
   * Safely execute custom strategy code within an isolated VM context
   */
  evaluateCustomStrategy(code, marketData, portfolioData) {
    try {
      const sandbox = {
        market: Object.assign({}, marketData),
        portfolio: Object.assign({}, portfolioData),
        Math: Math,
        Date: Date,
        parseInt: parseInt,
        parseFloat: parseFloat,
        isNaN: isNaN,
        console: { log: () => {} }
      };
      const script = new vm.Script(code + '\n; onTick(market, portfolio);');
      const ctx = vm.createContext(sandbox);
      const res = script.runInContext(ctx, { timeout: 250 });
      return res || null;
    } catch (err) {
      return { error: err.message };
    }
  }
}

const userProfileManager = new UserProfileManager();

module.exports = {
  userProfileManager,
  UserProfileManager,
};
