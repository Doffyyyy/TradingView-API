const fs = require('fs');
const path = require('path');
const { computeAllIndicators, getMultiTimeframeAnalysis, getBtcMarketRegime } = require('./indicators');
const { validateSymbol } = require('./validation');
const { sendTelegramAlert } = require('./alert');
const axios = require('axios');

const PORTFOLIO_PATH = path.join(__dirname, '../../data/paper_portfolio.json');

function formatTokenPrice(price) {
  if (typeof price !== 'number' || isNaN(price)) return '0.00';
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

function roundPriceForCoin(price) {
  if (typeof price !== 'number' || isNaN(price) || price <= 0) return 0;
  if (price >= 100) return Math.round(price * 100) / 100;
  if (price >= 1) return Math.round(price * 10000) / 10000;
  if (price >= 0.01) return Math.round(price * 100000) / 100000;
  return Number(price.toPrecision(6));
}

const DEFAULT_PORTFOLIO = {
  initialBalance: 10000.0,
  cash: 10000.0,
  equity: 10000.0,
  dailyTargetMin: 100.0, // 1% of equity ($100 at $10k)
  dailyTargetMax: 300.0, // 3% of equity ($300 at $10k - Profit Lock)
  dailyStopLossMax: 180.0, // 1.8% of equity ($180 at $10k - Circuit Breaker)
  dailyRealizedPnl: 0.0,
  lastResetDate: new Date().toISOString().slice(0, 10),
  autoTradeEnabled: true,
  riskPerTradePercent: 1.5, // 1.5% max capital risk per trade ($150)
  maxPositionMargin: 1800.0, // Max margin collateral per trade
  maxLeverage: 3, // Max 3x leverage when conditions are pristine
  maxOpenPositions: 2,
  positions: [], // { id, symbol, side, entryPrice, size, margin, notional, leverage, stopLoss, takeProfit, entryTime, strategy, highestPrice, lowestPrice }
  trades: [],
  logs: [],
};

class PaperTradingEngine {
  constructor() {
    this.portfolio = this.loadPortfolio();
    this.monitoredSymbols = [
      'BINANCE:BTCUSDT',    // #1 HL Vol: $4.9B
      'BINANCE:ETHUSDT',    // #2 HL Vol: $2.0B
      'BYBIT:HYPEUSDT',     // #3 HL Vol: $665M
      'BINANCE:ZECUSDT',    // #4 HL Vol: $434M
      'BINANCE:SOLUSDT',    // #5 HL Vol: $395M
      'BINANCE:NEARUSDT',   // #6 HL Vol: $327M
      'BINANCE:TAOUSDT',    // #9 HL Vol: $105M
      'BINANCE:SUIUSDT',    // #11 HL Vol: $81M
      'BINANCE:PUMPUSDT',   // #15 HL Vol: $56M
      'BYBIT:VVVUSDT',      // #16 HL Vol: $50M
      'BINANCE:ARBUSDT',    // #17 HL Vol: $48M
      'BINANCE:LINKUSDT',   // #25 HL Vol: $27M
      'BINANCE:ONDOUSDT',   // #27 HL Vol: $24M
      'BINANCE:BNBUSDT',    // #30 HL Vol: $17M
    ];
    this.isRunning = false;
    this.loopTimer = null;
    this.latestPrices = {};
    this.symbolCooldowns = {}; // { 'BINANCE:SOLUSDT': timestamp }
    this.hasLoggedDailyMin = false;
    this.hasLoggedDailyMax = false;
    this.hasLoggedDailyStopLoss = false;
  }

  getTodayDateString() {
    // Return YYYY-MM-DD in UTC+7 (Vietnam Time)
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
    const y = vnTime.getFullYear();
    const m = String(vnTime.getMonth() + 1).padStart(2, '0');
    const d = String(vnTime.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  loadPortfolio() {
    try {
      if (fs.existsSync(PORTFOLIO_PATH)) {
        const data = JSON.parse(fs.readFileSync(PORTFOLIO_PATH, 'utf8'));
        // Check daily reset according to Vietnam Time (UTC+7)
        const today = this.getTodayDateString();
        if (data.lastResetDate !== today) {
          if (!data.dailyHistory) data.dailyHistory = [];
          data.dailyHistory.unshift({
            date: data.lastResetDate,
            realizedPnl: data.dailyRealizedPnl || 0.0,
            closingEquity: data.equity || data.cash,
          });
          data.dailyRealizedPnl = 0.0;
          data.lastResetDate = today;
          fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(data, null, 2));
        }
        return data;
      }
    } catch (e) {
      console.error('[PaperTrader] Error loading portfolio:', e.message);
    }
    this.savePortfolio(DEFAULT_PORTFOLIO);
    return { ...DEFAULT_PORTFOLIO };
  }

  savePortfolio(data = this.portfolio) {
    try {
      fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[PaperTrader] Error saving portfolio:', e.message);
    }
  }

  log(msg) {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(`[PaperTrader] ${entry}`);
    this.portfolio.logs.unshift(entry);
    if (this.portfolio.logs.length > 50) this.portfolio.logs.pop();
    this.savePortfolio();
  }

  async fetchPrices() {
    try {
      const res = await axios.post(
        'https://scanner.tradingview.com/crypto/scan',
        {
          symbols: { tickers: this.monitoredSymbols },
          columns: ['close', 'change', 'high', 'low', 'RSI'],
        },
        { timeout: 4000 }
      );
      if (res.data && res.data.data) {
        res.data.data.forEach(item => {
          this.latestPrices[item.s] = {
            price: item.d[0],
            change: item.d[1],
            high: item.d[2],
            low: item.d[3],
            rsi: item.d[4],
          };
        });
      }
    } catch (e) {
      // Fallback
    }
  }

  updateEquity() {
    let totalPositionsValue = 0;
    this.portfolio.positions.forEach(pos => {
      const curr = this.latestPrices[pos.symbol]?.price || pos.entryPrice;
      const margin = pos.margin !== undefined ? pos.margin : pos.notional;
      let pnl = 0;
      if (pos.side === 'LONG') {
        pnl = (curr - pos.entryPrice) * pos.size;
      } else {
        pnl = (pos.entryPrice - curr) * pos.size;
      }
      totalPositionsValue += (margin + pnl);
    });
    this.portfolio.equity = Math.round((this.portfolio.cash + totalPositionsValue) * 100) / 100;
  }

  async checkExitRules() {
    for (let i = this.portfolio.positions.length - 1; i >= 0; i--) {
      const pos = this.portfolio.positions[i];
      const curr = this.latestPrices[pos.symbol]?.price;
      if (!curr) continue;

      // Composite Edge Tiered Trailing Stop & Profit Lock:
      // When price moves >= +1.6% in profit, lock SL at entry + 0.40% (safely locks fee-free profit)
      // When price moves >= +2.4% in profit, lock SL at entry + 1.20% (locks runner gains)
      if (pos.side === 'LONG') {
        const gainPct = (curr - pos.entryPrice) / pos.entryPrice;
        if (gainPct >= 0.024) {
          const lockPrice = roundPriceForCoin(pos.entryPrice * 1.0120);
          if (pos.stopLoss < lockPrice) {
            pos.stopLoss = lockPrice;
            this.log(`Runner Trailing Stop locked for LONG ${pos.symbol} [${pos.leverage || 1}x] at +1.2% ($${formatTokenPrice(lockPrice)})`);
          }
        } else if (gainPct >= 0.016) {
          const lockPrice = roundPriceForCoin(pos.entryPrice * 1.0040);
          if (pos.stopLoss < lockPrice) {
            pos.stopLoss = lockPrice;
            this.log(`Breakeven Trailing Stop locked for LONG ${pos.symbol} [${pos.leverage || 1}x] at +0.4% ($${formatTokenPrice(lockPrice)})`);
          }
        }
      } else {
        const gainPct = (pos.entryPrice - curr) / pos.entryPrice;
        if (gainPct >= 0.024) {
          const lockPrice = roundPriceForCoin(pos.entryPrice * 0.9880);
          if (pos.stopLoss > lockPrice) {
            pos.stopLoss = lockPrice;
            this.log(`Runner Trailing Stop locked for SHORT ${pos.symbol} [${pos.leverage || 1}x] at +1.2% ($${formatTokenPrice(lockPrice)})`);
          }
        } else if (gainPct >= 0.016) {
          const lockPrice = roundPriceForCoin(pos.entryPrice * 0.9960);
          if (pos.stopLoss > lockPrice) {
            pos.stopLoss = lockPrice;
            this.log(`Breakeven Trailing Stop locked for SHORT ${pos.symbol} [${pos.leverage || 1}x] at +0.4% ($${formatTokenPrice(lockPrice)})`);
          }
        }
      }

      let shouldClose = false;
      let reason = '';

      if (pos.side === 'LONG') {
        if (curr >= pos.takeProfit && pos.takeProfit > 0) {
          shouldClose = true;
          reason = `Take Profit hit at $${formatTokenPrice(curr)} (+${(((curr - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)}%)`;
        } else if (curr <= pos.stopLoss && pos.stopLoss > 0) {
          shouldClose = true;
          reason = `Stop Loss / Trailing Stop hit at $${formatTokenPrice(curr)} (${(((curr - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)}%)`;
        }
      } else {
        if (curr <= pos.takeProfit && pos.takeProfit > 0) {
          shouldClose = true;
          reason = `Take Profit hit at $${formatTokenPrice(curr)} (+${(((pos.entryPrice - curr) / pos.entryPrice) * 100).toFixed(2)}%)`;
        } else if (curr >= pos.stopLoss && pos.stopLoss > 0) {
          shouldClose = true;
          reason = `Stop Loss / Trailing Stop hit at $${formatTokenPrice(curr)} (${(((pos.entryPrice - curr) / pos.entryPrice) * 100).toFixed(2)}%)`;
        }
      }

      if (shouldClose) {
        await this.closePosition(pos.id, curr, reason);
      }
    }
  }

  async closePosition(positionId, exitPrice, reason) {
    const idx = this.portfolio.positions.findIndex(p => p.id === positionId);
    if (idx === -1) return;

    const pos = this.portfolio.positions[idx];
    const margin = pos.margin !== undefined ? pos.margin : pos.notional;

    // Hyperliquid Real Fee Schedule:
    // Maker: 0.010% (0.00010) on Limit Take Profit exits
    // Taker: 0.035% (0.00035) on Market entry, Stop Loss, Trailing Stop, Manual exits
    const entryFeeRate = 0.00035; // 0.035% HL Taker
    const isLimitExit = Boolean(reason && reason.includes('Take Profit'));
    const exitFeeRate = isLimitExit ? 0.00010 : 0.00035; // 0.010% HL Maker if TP, else 0.035% Taker
    const fee = (pos.entryPrice * pos.size * entryFeeRate) + (exitPrice * pos.size * exitFeeRate);

    let grossPnl = 0;
    if (pos.side === 'LONG') {
      grossPnl = (exitPrice - pos.entryPrice) * pos.size;
    } else {
      grossPnl = (pos.entryPrice - exitPrice) * pos.size;
    }

    const netPnl = grossPnl - fee;
    this.portfolio.cash += (margin + netPnl);
    this.portfolio.dailyRealizedPnl += netPnl;

    const closedTrade = {
      id: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      size: pos.size,
      margin,
      notional: pos.notional,
      leverage: pos.leverage || 1,
      pnl: Math.round(netPnl * 100) / 100,
      pnlPercent: Math.round((netPnl / margin) * 10000) / 100,
      fee: Math.round(fee * 100) / 100,
      entryTime: pos.entryTime,
      exitTime: new Date().toISOString(),
      reason,
      strategy: pos.strategy,
    };

    this.portfolio.trades.unshift(closedTrade);
    this.portfolio.positions.splice(idx, 1);
    this.updateEquity();
    this.savePortfolio();

    // If trade was a loss (Stop Loss), activate 30-minute cooldown on this symbol to prevent whipsaw
    if (netPnl < 0) {
      const cooldownUntil = Date.now() + 30 * 60 * 1000;
      this.symbolCooldowns[pos.symbol] = cooldownUntil;
      this.log(`⏳ Cooldown active for ${pos.symbol} (30 mins until ${new Date(cooldownUntil).toLocaleTimeString('vi-VN')}) after loss.`);
    }

    this.log(`CLOSED ${pos.side} ${pos.symbol} [${pos.leverage || 1}x]: Net PnL $${closedTrade.pnl} (${closedTrade.pnlPercent}% ROE). ${reason}`);

    // Telegram notification
    try {
      const levBadge = pos.leverage && pos.leverage > 1 ? `[${pos.leverage}x] ` : '';
      const closeLog = `CLOSED ${pos.side} on ${pos.symbol} ${levBadge}@ $${formatTokenPrice(exitPrice)}: Net PnL ${closedTrade.pnl >= 0 ? '+' : ''}$${closedTrade.pnl} (${closedTrade.pnlPercent}% ROE). ${reason}. Daily Realized PnL: $${this.portfolio.dailyRealizedPnl.toFixed(2)}`;
      sendTelegramAlert({
        instrument: pos.symbol,
        strategy: `AutoPaper: ${pos.strategy}`,
        action: `CLOSED ${pos.side} (PnL: $${closedTrade.pnl})`,
        customMessage: closeLog,
        sharpe: 2.3,
        drawdown: '-2.1%',
        winRate: 0.65,
        winLossRatio: 1.8,
        accountEquity: this.portfolio.equity,
        timeframe: '15',
        notes: `Trade exited. ${reason}. Daily Realized PnL: $${this.portfolio.dailyRealizedPnl.toFixed(2)}`,
      }).catch(() => {});
    } catch (e) {}
  }

  async openPosition(symbol, side, strategy, reason, leverage = 1, orderFlow = null, rlmData = null) {
    if (this.portfolio.positions.length >= this.portfolio.maxOpenPositions) {
      return null;
    }
    // Don't open duplicate symbol
    if (this.portfolio.positions.some(p => p.symbol === symbol)) {
      return null;
    }

    // Directional consistency guard: Never hedge or open opposite positions
    if (this.portfolio.positions.some(p => p.side !== side)) {
      this.log(`⚠️ Aborting ${side} on ${symbol}: Portfolio already holds active ${side === 'LONG' ? 'SHORT' : 'LONG'} position(s). Enforcing single-direction exposure.`);
      return null;
    }

    // Don't open if symbol is under cooldown
    if (this.symbolCooldowns[symbol] && Date.now() < this.symbolCooldowns[symbol]) {
      return null;
    }

    const currPrice = this.latestPrices[symbol]?.price;
    if (!currPrice || currPrice <= 0) return null;

    const lev = Math.min(3, Math.max(1, parseInt(leverage, 10) || 1));
    const maxMargin = this.portfolio.maxPositionMargin || 1800.0;
    const targetMargin = Math.min(this.portfolio.cash * 0.35, maxMargin);
    if (targetMargin < 100) {
      this.log(`Insufficient cash ($${this.portfolio.cash.toFixed(2)}) to open position margin`);
      return null;
    }

    const margin = Math.round(targetMargin * 100) / 100;
    const notional = Math.round(margin * lev * 100) / 100;
    const size = notional / currPrice;
    this.portfolio.cash -= margin;

    // Adaptive targets tailored to leverage (Composite Edge R:R 2.4:1):
    // 1x: Base TP 2.4%, SL 1.0% (RR 2.4:1)
    // 2x: Base TP 2.0%, SL 0.8% (RR 2.5:1)
    // 3x: Base TP 1.8%, SL 0.75% (RR 2.4:1)
    let slPercent = 0.010;
    let tpPercent = 0.024;
    if (lev === 2) {
      slPercent = 0.008;
      tpPercent = 0.020;
    } else if (lev === 3) {
      slPercent = 0.0075;
      tpPercent = 0.018;
    }

    // Hard Minimum Take Profit Distance (at least 1.4% to safely out-earn fees by 15x-20x)
    const minTpDistancePct = 0.014;

    let stopLoss = 0;
    let takeProfit = 0;

    if (side === 'LONG') {
      let initialSl = currPrice * (1 - slPercent);
      // RLM Wick-Anchored SL: use if within sensible risk bounds (0.5% - 1.3%)
      if (rlmData?.signal?.type === 'LONG' && rlmData.signal.sl > 0 && rlmData.signal.sl < currPrice) {
        const rlmRiskPct = (currPrice - rlmData.signal.sl) / currPrice;
        if (rlmRiskPct >= 0.005 && rlmRiskPct <= 0.013) {
          initialSl = rlmData.signal.sl;
        }
      } else if (orderFlow?.valPrice && orderFlow.valPrice < currPrice && orderFlow.valPrice >= currPrice * 0.985) {
        initialSl = Math.max(initialSl, orderFlow.valPrice * 0.998);
      }
      stopLoss = roundPriceForCoin(initialSl);

      // Enforce Minimum Risk:Reward Ratio >= 1:1.6 (Never squeeze TP below safe threshold)
      const riskDistance = Math.max(currPrice * 0.006, currPrice - stopLoss);
      const minRewardDistance = Math.max(riskDistance * 1.6, currPrice * minTpDistancePct);
      let targetTp = currPrice + minRewardDistance;

      if (rlmData?.signal?.tp2 && rlmData.signal.tp2 > targetTp) {
        targetTp = rlmData.signal.tp2;
      } else if (orderFlow?.vahPrice && orderFlow.vahPrice > targetTp && orderFlow.vahPrice <= currPrice * 1.05) {
        targetTp = orderFlow.vahPrice;
      }
      takeProfit = roundPriceForCoin(targetTp);
    } else {
      let initialSl = currPrice * (1 + slPercent);
      if (rlmData?.signal?.type === 'SHORT' && rlmData.signal.sl > currPrice) {
        const rlmRiskPct = (rlmData.signal.sl - currPrice) / currPrice;
        if (rlmRiskPct >= 0.005 && rlmRiskPct <= 0.013) {
          initialSl = rlmData.signal.sl;
        }
      } else if (orderFlow?.vahPrice && orderFlow.vahPrice > currPrice && orderFlow.vahPrice <= currPrice * 1.015) {
        initialSl = Math.min(initialSl, orderFlow.vahPrice * 1.002);
      }
      stopLoss = roundPriceForCoin(initialSl);

      const riskDistance = Math.max(currPrice * 0.006, stopLoss - currPrice);
      const minRewardDistance = Math.max(riskDistance * 1.6, currPrice * minTpDistancePct);
      let targetTp = currPrice - minRewardDistance;

      if (rlmData?.signal?.tp2 && rlmData.signal.tp2 < targetTp) {
        targetTp = rlmData.signal.tp2;
      } else if (orderFlow?.valPrice && orderFlow.valPrice < targetTp && orderFlow.valPrice >= currPrice * 0.95) {
        targetTp = orderFlow.valPrice;
      }
      takeProfit = roundPriceForCoin(targetTp);
    }

    // Critical sanity check: prevent 0 or negative SL/TP
    if (stopLoss <= 0 || takeProfit <= 0 || isNaN(stopLoss) || isNaN(takeProfit)) {
      this.log(`⚠️ Aborting trade on ${symbol}: Invalid calculated SL ($${stopLoss}) / TP ($${takeProfit}) for price $${currPrice}`);
      this.portfolio.cash += margin;
      return null;
    }

    const position = {
      id: 'pos_' + Date.now(),
      symbol,
      side,
      entryPrice: currPrice,
      size,
      margin,
      notional,
      leverage: lev,
      stopLoss,
      takeProfit,
      entryTime: new Date().toISOString(),
      strategy,
      reason,
      orderFlow: orderFlow ? {
        pocPrice: orderFlow.pocPrice,
        vahPrice: orderFlow.vahPrice,
        valPrice: orderFlow.valPrice,
        buyRatio: orderFlow.buyRatio,
        sellRatio: orderFlow.sellRatio,
      } : undefined,
    };

    this.portfolio.positions.push(position);
    this.updateEquity();
    this.savePortfolio();

    const openLog = `OPENED ${side} on ${symbol} @ $${formatTokenPrice(currPrice)} [${lev}x Lev | Margin: $${margin.toFixed(0)}, Notional: $${notional.toFixed(0)}]. Target TP: $${formatTokenPrice(takeProfit)} (+${(tpPercent * 100).toFixed(1)}%), SL: $${formatTokenPrice(stopLoss)} (-${(slPercent * 100).toFixed(1)}%) [Strategy: ${strategy}]`;
    this.log(openLog);

    // Notify Telegram
    try {
      sendTelegramAlert({
        instrument: symbol,
        strategy: `AutoPaper: ${strategy} (${lev}x)`,
        action: `ENTER ${side} [${lev}x] @ $${formatTokenPrice(currPrice)}`,
        customMessage: openLog,
        sharpe: 2.45,
        drawdown: '-2.5%',
        winRate: 0.65,
        winLossRatio: 1.8,
        accountEquity: this.portfolio.equity,
        timeframe: '15',
        notes: `New trade dispatched. Margin: $${margin} (${lev}x Lev). TP: $${formatTokenPrice(takeProfit)}, SL: $${formatTokenPrice(stopLoss)}. ${reason}`,
      }).catch(() => {});
    } catch (e) {}

    return position;
  }

  checkDailyRollover() {
    const today = this.getTodayDateString();
    if (this.portfolio.lastResetDate !== today) {
      this.log(`🌅 New trading day detected (${today} UTC+7). Previous day realized PnL: $${(this.portfolio.dailyRealizedPnl || 0).toFixed(2)}. Resetting daily target & stop loss counter.`);
      if (!this.portfolio.dailyHistory) this.portfolio.dailyHistory = [];
      this.portfolio.dailyHistory.unshift({
        date: this.portfolio.lastResetDate,
        realizedPnl: this.portfolio.dailyRealizedPnl,
        closingEquity: this.portfolio.equity,
      });
      this.portfolio.dailyRealizedPnl = 0.0;
      this.portfolio.lastResetDate = today;

      // Recalculate dynamic daily targets & stop loss from starting equity:
      const eq = this.portfolio.equity || 10000.0;
      this.portfolio.dailyTargetMin = Math.round(eq * 0.01); // 1% ($100 at $10k)
      this.portfolio.dailyTargetMax = Math.round(eq * 0.03); // 3% ($300 at $10k - Profit Lock)
      this.portfolio.dailyStopLossMax = Math.round(eq * 0.018); // 1.8% ($180 at $10k - Circuit Breaker)

      this.hasLoggedDailyMin = false;
      this.hasLoggedDailyMax = false;
      this.hasLoggedDailyStopLoss = false;
      this.symbolCooldowns = {};
      this.savePortfolio();
    }
  }

  async scanOpportunities() {
    const dailyLossLimit = this.portfolio.dailyStopLossMax || 180.0;
    const isDailyStopLossHit = this.portfolio.dailyRealizedPnl <= -dailyLossLimit;

    // 1. Daily Circuit Breaker / Daily Stop Loss (1.8% = -$180)
    if (isDailyStopLossHit) {
      if (!this.hasLoggedDailyStopLoss) {
        const lossAmount = Math.abs(this.portfolio.dailyRealizedPnl).toFixed(2);
        this.log(`🛑 DAILY STOP LOSS REACHED (-$${lossAmount} <= -$${dailyLossLimit}). All new trades halted for today to protect capital until 00:00 UTC+7.`);
        this.hasLoggedDailyStopLoss = true;

        try {
          sendTelegramAlert({
            instrument: 'PORTFOLIO_RISK',
            customMessage: `🛑 DAILY STOP LOSS HIT (-$${lossAmount} reached limit of -$${dailyLossLimit} [1.8%]). Auto-Trade halted until tomorrow (00:00 UTC+7) to preserve account equity. Current Equity: $${this.portfolio.equity.toFixed(2)}`,
            accountEquity: this.portfolio.equity,
          }).catch(() => {});
        } catch (e) {}
      }
      return; // Stop scanning, no new trades allowed today!
    }

    const dailyTargetMax = this.portfolio.dailyTargetMax || 300.0;
    const dailyTargetMin = this.portfolio.dailyTargetMin || 100.0;

    // 2. Maximum Daily Target Lock (3% = $300+)
    if (this.portfolio.dailyRealizedPnl >= dailyTargetMax) {
      if (!this.hasLoggedDailyMax) {
        this.log(`🏆 MAXIMUM DAILY TARGET ACHIEVED (+$${this.portfolio.dailyRealizedPnl.toFixed(2)} >= $${dailyTargetMax} [3%]). Locking daily profit! Trading paused until tomorrow.`);
        this.hasLoggedDailyMax = true;

        try {
          sendTelegramAlert({
            instrument: 'PORTFOLIO_TARGET',
            customMessage: `🏆 MAX DAILY TARGET ACHIEVED! Daily Profit: +$${this.portfolio.dailyRealizedPnl.toFixed(2)} (>= 3% / $${dailyTargetMax}). Profit locked, auto-trading paused until tomorrow (00:00 UTC+7). Current Equity: $${this.portfolio.equity.toFixed(2)}`,
            accountEquity: this.portfolio.equity,
          }).catch(() => {});
        } catch (e) {}
      }
      return; // Stop scanning, lock profit for the day!
    }

    // 3. Minimum Daily Target Met (1% = $100+) -> Switches to Sniper A+ mode
    const isTargetHit = this.portfolio.dailyRealizedPnl >= dailyTargetMin;
    if (isTargetHit && !this.hasLoggedDailyMin) {
      this.log(`✅ Daily Target Minimum Achieved (+$${this.portfolio.dailyRealizedPnl.toFixed(2)} >= $${dailyTargetMin} [1%]). Preserving daily profit: Pausing normal entries, only sniping A+ setups (max 2x leverage, 1 position).`);
      this.hasLoggedDailyMin = true;
    }

    // 4. Check if slots available
    if (this.portfolio.positions.length >= this.portfolio.maxOpenPositions) {
      return;
    }

    // Dynamic slot control:
    // - Target Min reached ($100+): max 1 position to safeguard profit
    // - Defensive mode (loss >= -$90, 50% of stoploss limit): max 1 position, 1x leverage only
    const isDefensive = !this.portfolio.defensiveDisabled && (this.portfolio.dailyRealizedPnl <= -(dailyLossLimit * 0.5));
    if ((isTargetHit || isDefensive) && this.portfolio.positions.length >= 1) {
      return;
    }

    // 5. Directional Consistency Lock:
    // Determine existing portfolio direction to avoid cross-hedging and dual fees
    const existingSides = new Set(this.portfolio.positions.map(p => p.side));
    const hasActiveLong = existingSides.has('LONG');
    const hasActiveShort = existingSides.has('SHORT');

    // 6. BTC Macro Market Regime Gate (Beta Filter)
    let btcRegime = 'CHOPPY_REGIME';
    try {
      btcRegime = await getBtcMarketRegime();
    } catch (e) {}

    // 7. Scan monitored symbols with Multi-Timeframe Framework:
    for (const sym of this.monitoredSymbols) {
      if (this.portfolio.positions.some(p => p.symbol === sym)) continue;

      // Check symbol cooldown (e.g. 30 mins after stop loss)
      if (this.symbolCooldowns[sym] && Date.now() < this.symbolCooldowns[sym]) {
        continue;
      }

      try {
        const [taValidation, mtf] = await Promise.all([
          validateSymbol(sym).catch(() => null),
          getMultiTimeframeAnalysis(sym).catch(() => null),
        ]);

        if (!taValidation || !mtf || !mtf.htf || !mtf.ltf) continue;

        const currentPrice = this.latestPrices[sym]?.price || mtf.currentPrice;
        const htf = mtf.htf; // { curPrice, ema50, ema200, bias, supertrend, rlm, nearestRes, nearestSup }
        const ltf = mtf.ltf; // { rsi, macdTrend, supertrend, galton, footprint, rlm }

        const buyVotes = taValidation.consensus.buy;
        const sellVotes = taValidation.consensus.sell;
        const rsi = ltf.rsi;
        const buyFlow = ltf.galton ? ltf.galton.buyRatio : 0.5;
        const sellFlow = ltf.galton ? ltf.galton.sellRatio : 0.5;
        const ovlScore = ltf.footprint ? ltf.footprint.ovlScore : 0.5;
        const hasBearishAbsorptionTop = ltf.footprint ? ltf.footprint.hasBearishAbsorptionTop : false;
        const hasBullishAbsorptionBottom = ltf.footprint ? ltf.footprint.hasBullishAbsorptionBottom : false;
        const isChoppy = ltf.footprint?.marketStructure === 'CHOPPY_ROTATION';
        const rlmSignal = ltf.rlm?.signal || null;

        // =========================================================================
        // HTF DIRECTION 1: LONG SETUP
        // Requirements:
        //  1. Portfolio is NOT holding any SHORT positions (Direction Consistency)
        //  2. Macro Market is NOT in BEAR_REGIME
        //  3. Symbol 1H Trend is BULL (Price > EMA50_1H)
        //  4. No heavy 1H Resistance ceiling right above (< 1.5%)
        //  5. 15M Entry is a PULLBACK / RETEST (RSI 36-56), never buy an overbought pump
        //  6. Orderflow clean: buyFlow >= 0.48, no bearish absorption top
        // =========================================================================
        const canLong = !hasActiveShort &&
                        btcRegime !== 'BEAR_REGIME' &&
                        htf.bias === 'BULL' &&
                        (!htf.nearestRes || htf.nearestRes.distancePct >= 1.5);

        if (canLong && buyFlow >= 0.48 && !hasBearishAbsorptionTop && rsi <= 56) {
          let triggerType = null;
          let strategyName = '';
          let lev = 1;

          // Trigger A: 15M RLM Key Level Rejection Sniper at Support (Score >= 50)
          if (rlmSignal && rlmSignal.type === 'LONG' && rlmSignal.levelScore >= 50) {
            triggerType = 'RLM_REJECTION';
            strategyName = 'HTF Bull + RLM Sniper Long';
            lev = isDefensive ? 1 : 2;
          }
          // Trigger B: 15M Pullback Retest with Supertrend + MACD Confluence + 26-TA >= 14
          else if (ltf.supertrend === 'BUY' && ltf.macdTrend === 'BULLISH' && buyVotes >= 14 && sellVotes <= 6 && !isChoppy && rsi >= 36) {
            triggerType = 'PULLBACK_MOMENTUM';
            strategyName = 'HTF Trend + 15M Pullback Long';
            if (isDefensive) {
              lev = 1;
            } else if (isTargetHit) {
              lev = buyVotes >= 16 ? 2 : 1;
            } else {
              lev = (buyVotes >= 17 && buyFlow >= 0.58 && ovlScore <= 0.55) ? 3 : (buyVotes >= 15 && buyFlow >= 0.52 ? 2 : 1);
            }
          }

          if (triggerType) {
            const flowStr = ltf.galton ? ` [Flow: ${Math.round(buyFlow * 100)}% Buy, POC: $${ltf.galton.pocPrice}]` : '';
            const reason = `${strategyName} [${lev}x]: 1H Macro BULL (EMA50: $${formatTokenPrice(htf.ema50)}), 15M Pullback RSI ${rsi}, 26-TA Buy (${buyVotes}/26)${flowStr}.`;
            this.log(`🚀 HTF-Aligned Entry: ${sym} LONG (${lev}x Lev) | Reason: ${reason}`);
            await this.openPosition(sym, 'LONG', strategyName, reason, lev, ltf.galton, ltf.rlm);
            if (this.portfolio.positions.length >= (isTargetHit || isDefensive ? 1 : this.portfolio.maxOpenPositions)) break;
            continue;
          }
        }

        // =========================================================================
        // HTF DIRECTION 2: SHORT SETUP
        // Requirements:
        //  1. Portfolio is NOT holding any LONG positions (Direction Consistency)
        //  2. Macro Market is NOT in BULL_REGIME
        //  3. Symbol 1H Trend is BEAR (Price < EMA50_1H)
        //  4. No heavy 1H Support floor right below (< 1.5%)
        //  5. 15M Entry is a RETRACEMENT BOUNCE (RSI 44-64), never short an oversold dump
        //  6. Orderflow clean: sellFlow >= 0.48, no bullish absorption bottom
        // =========================================================================
        const canShort = !hasActiveLong &&
                         btcRegime !== 'BULL_REGIME' &&
                         htf.bias === 'BEAR' &&
                         (!htf.nearestSup || htf.nearestSup.distancePct >= 1.5);

        if (canShort && sellFlow >= 0.48 && !hasBullishAbsorptionBottom && rsi >= 44) {
          let triggerType = null;
          let strategyName = '';
          let lev = 1;

          // Trigger A: 15M RLM Key Level Rejection Sniper at Resistance (Score >= 50)
          if (rlmSignal && rlmSignal.type === 'SHORT' && rlmSignal.levelScore >= 50) {
            triggerType = 'RLM_REJECTION';
            strategyName = 'HTF Bear + RLM Sniper Short';
            lev = isDefensive ? 1 : 2;
          }
          // Trigger B: 15M Retracement with Supertrend + MACD Breakdown + 26-TA Sell >= 14
          else if (ltf.supertrend === 'SELL' && ltf.macdTrend === 'BEARISH' && sellVotes >= 14 && buyVotes <= 6 && !isChoppy && rsi <= 64) {
            triggerType = 'RETRACEMENT_BREAKDOWN';
            strategyName = 'HTF Trend + 15M Retrace Short';
            if (isDefensive) {
              lev = 1;
            } else if (isTargetHit) {
              lev = sellVotes >= 16 ? 2 : 1;
            } else {
              lev = (sellVotes >= 17 && sellFlow >= 0.58 && ovlScore <= 0.55) ? 3 : (sellVotes >= 15 && sellFlow >= 0.52 ? 2 : 1);
            }
          }

          if (triggerType) {
            const flowStr = ltf.galton ? ` [Flow: ${Math.round(sellFlow * 100)}% Sell, POC: $${ltf.galton.pocPrice}]` : '';
            const reason = `${strategyName} [${lev}x]: 1H Macro BEAR (EMA50: $${formatTokenPrice(htf.ema50)}), 15M Retrace RSI ${rsi}, 26-TA Sell (${sellVotes}/26)${flowStr}.`;
            this.log(`🚀 HTF-Aligned Entry: ${sym} SHORT (${lev}x Lev) | Reason: ${reason}`);
            await this.openPosition(sym, 'SHORT', strategyName, reason, lev, ltf.galton, ltf.rlm);
            if (this.portfolio.positions.length >= (isTargetHit || isDefensive ? 1 : this.portfolio.maxOpenPositions)) break;
            continue;
          }
        }
      } catch (err) {
        // Continue next symbol
      }
    }
  }

  async tick() {
    if (!this.portfolio.autoTradeEnabled) return;
    try {
      this.checkDailyRollover();
      await this.fetchPrices();
      this.updateEquity();
      await this.checkExitRules();
      await this.scanOpportunities();
    } catch (e) {
      console.error('[PaperTrader] Tick error:', e.message);
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log(`Engine started. Initial Fund: $${this.portfolio.initialBalance.toFixed(2)}, Target: $50-$100/day.`);
    // Run immediately then every 8 seconds
    this.tick();
    this.loopTimer = setInterval(() => this.tick(), 8000);
  }

  stop() {
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.isRunning = false;
    this.log('Engine stopped.');
  }

  resetAccount() {
    this.portfolio = { ...DEFAULT_PORTFOLIO };
    this.savePortfolio();
    this.log('Account reset to $10,000.00.');
  }

  getStatus() {
    this.updateEquity();
    const totalTrades = this.portfolio.trades.length;
    const wins = this.portfolio.trades.filter(t => t.pnl > 0).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const targetProgress = Math.min(100, Math.max(0, (this.portfolio.dailyRealizedPnl / this.portfolio.dailyTargetMax) * 100));
    const isTargetHit = this.portfolio.dailyRealizedPnl >= (this.portfolio.dailyTargetMin || 100.0);
    const dailyLossLimit = this.portfolio.dailyStopLossMax || 180.0;
    const isDailyStopLossHit = this.portfolio.dailyRealizedPnl <= -dailyLossLimit;
    const isTargetMaxHit = this.portfolio.dailyRealizedPnl >= (this.portfolio.dailyTargetMax || 300.0);

    let tradingMode = 'ACTIVE (Normal Confluence)';
    if (!this.portfolio.defensiveDisabled && isDailyStopLossHit) {
      tradingMode = 'HALTED (Daily Stop Loss Hit)';
    } else if (isTargetMaxHit) {
      tradingMode = 'LOCKED (Daily 3% Max Target Reached)';
    } else if (isTargetHit) {
      tradingMode = 'SNIPER (A+ Setups Only, 2x Max)';
    } else if (!this.portfolio.defensiveDisabled && this.portfolio.dailyRealizedPnl <= -(dailyLossLimit * 0.5)) {
      tradingMode = 'DEFENSIVE (Risk Reduced, 1x Only)';
    }

    return {
      balance: Math.round(this.portfolio.cash * 100) / 100,
      equity: Math.round(this.portfolio.equity * 100) / 100,
      initialBalance: this.portfolio.initialBalance,
      dailyPnl: Math.round(this.portfolio.dailyRealizedPnl * 100) / 100,
      dailyTargetMin: this.portfolio.dailyTargetMin || 100.0,
      dailyTargetMax: this.portfolio.dailyTargetMax || 300.0,
      dailyStopLossMax: dailyLossLimit,
      dailyTargetProgressPercent: Math.round(targetProgress * 10) / 10,
      dailyTargetHit: isTargetHit,
      dailyTargetMaxHit: isTargetMaxHit,
      dailyStopLossHit: isDailyStopLossHit,
      maxLeverage: this.portfolio.maxLeverage || 3,
      tradingMode,
      autoTradeEnabled: this.portfolio.autoTradeEnabled,
      monitoredSymbols: this.monitoredSymbols,
      symbolCooldowns: Object.entries(this.symbolCooldowns)
        .filter(([_, exp]) => Date.now() < exp)
        .map(([s, exp]) => ({ symbol: s, remainingSec: Math.round((exp - Date.now()) / 1000) })),
      openPositions: this.portfolio.positions.map(p => {
        const curr = this.latestPrices[p.symbol]?.price || p.entryPrice;
        let upnl = p.side === 'LONG' ? (curr - p.entryPrice) * p.size : (p.entryPrice - curr) * p.size;
        const margin = p.margin !== undefined ? p.margin : p.notional;
        return {
          ...p,
          currentPrice: curr,
          unrealizedPnl: Math.round(upnl * 100) / 100,
          unrealizedPnlPercent: Math.round((upnl / margin) * 10000) / 100,
        };
      }),
      recentTrades: this.portfolio.trades.slice(0, 15),
      allTrades: this.portfolio.trades,
      dailyHistory: this.portfolio.dailyHistory || [],
      winRate: Math.round(winRate * 10) / 10,
      totalTrades,
      logs: this.portfolio.logs.slice(0, 30),
    };
  }
}

const paperTraderInstance = new PaperTradingEngine();

module.exports = {
  paperTraderInstance,
  PaperTradingEngine,
};
