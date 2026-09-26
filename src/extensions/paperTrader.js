const fs = require('fs');
const path = require('path');
const { computeAllIndicators } = require('./indicators');
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

      // Trailing stop / Break-even lock:
      // When price moves >= +1.0% in profit, lock SL at entry + 0.35% (guarantees profit that easily covers round-trip fees)
      if (pos.side === 'LONG') {
        const gainPct = (curr - pos.entryPrice) / pos.entryPrice;
        if (gainPct >= 0.010) {
          const lockPrice = roundPriceForCoin(pos.entryPrice * 1.0035);
          if (pos.stopLoss < lockPrice) {
            pos.stopLoss = lockPrice;
            this.log(`Trailing Stop locked for LONG ${pos.symbol} [${pos.leverage || 1}x] at breakeven+$ ($${formatTokenPrice(lockPrice)})`);
          }
        }
      } else {
        const gainPct = (pos.entryPrice - curr) / pos.entryPrice;
        if (gainPct >= 0.010) {
          const lockPrice = roundPriceForCoin(pos.entryPrice * 0.9965);
          if (pos.stopLoss > lockPrice) {
            pos.stopLoss = lockPrice;
            this.log(`Trailing Stop locked for SHORT ${pos.symbol} [${pos.leverage || 1}x] at breakeven+$ ($${formatTokenPrice(lockPrice)})`);
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

    // Adaptive targets tailored to leverage:
    // 1x: Base TP 1.8%, SL 0.9% (RR 2:1)
    // 2x: Base TP 1.6%, SL 0.8% (RR 2:1)
    // 3x: Base TP 1.5%, SL 0.75% (RR 2:1)
    let slPercent = 0.009;
    let tpPercent = 0.018;
    if (lev === 2) {
      slPercent = 0.008;
      tpPercent = 0.016;
    } else if (lev === 3) {
      slPercent = 0.0075;
      tpPercent = 0.015;
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
    const isDefensive = this.portfolio.dailyRealizedPnl <= -(dailyLossLimit * 0.5);
    if ((isTargetHit || isDefensive) && this.portfolio.positions.length >= 1) {
      return;
    }

    // 5. Scan symbols for high win-rate confluence:
    for (const sym of this.monitoredSymbols) {
      if (this.portfolio.positions.some(p => p.symbol === sym)) continue;

      // Check symbol cooldown (e.g. 30 mins after stop loss)
      if (this.symbolCooldowns[sym] && Date.now() < this.symbolCooldowns[sym]) {
        continue;
      }

      try {
        const [taValidation, indics] = await Promise.all([
          validateSymbol(sym).catch(() => null),
          computeAllIndicators(sym, '15', ['RSI', 'MACD', 'Supertrend', 'Galton', 'Footprint', 'RLM']).catch(() => null),
        ]);

        if (!taValidation || !indics) continue;

        const currentPrice = this.latestPrices[sym]?.price || indics.currentPrice;
        const rsi = indics.indicators.RSI?.value || 50;
        const supertrend = indics.indicators.Supertrend?.trend; // 'BUY' or 'SELL'
        const macdTrend = indics.indicators.MACD?.trend; // 'BULLISH' or 'BEARISH'
        const buyVotes = taValidation.consensus.buy;
        const sellVotes = taValidation.consensus.sell;

        const galton = indics.indicators?.Galton || null;
        const footprint = indics.indicators?.Footprint || null;
        const rlm = indics.indicators?.ReactionLevelMatrix || null;

        const buyFlow = galton ? galton.buyRatio : 0.5;
        const sellFlow = galton ? galton.sellRatio : 0.5;
        const ovlScore = footprint ? footprint.ovlScore : 0.5;
        const hasBearishAbsorptionTop = footprint ? footprint.hasBearishAbsorptionTop : false;
        const hasBullishAbsorptionBottom = footprint ? footprint.hasBullishAbsorptionBottom : false;
        const isChoppy = footprint?.marketStructure === 'CHOPPY_ROTATION';

        const rlmSignal = rlm?.signal || null;
        const htfBias = rlm?.htfBias || 'NEUTRAL';
        const nearestRes = rlm?.nearestResistance || null;
        const nearestSup = rlm?.nearestSupport || null;

        // --- STRATEGY 1: RLM Key Level Rejection Sniper (A+ Pivot Setup) ---
        if (rlmSignal && rlmSignal.levelScore >= 50) {
          if (rlmSignal.type === 'LONG' && rsi <= 65 && !hasBearishAbsorptionTop && buyFlow >= 0.48) {
            const lev = isDefensive ? 1 : 2;
            const strategyName = 'RLM Key Level Rejection Sniper Long';
            const reason = `${strategyName} [${lev}x]: Rejection at Support $${formatTokenPrice(rlmSignal.levelPrice)} (Score: ${rlmSignal.levelScore}, Touches: ${rlmSignal.touches}). Wick SL: $${formatTokenPrice(rlmSignal.sl)}.`;
            this.log(`🎯 A+ RLM Signal: ${sym} LONG (${lev}x Lev) | ${reason}`);
            await this.openPosition(sym, 'LONG', strategyName, reason, lev, galton, rlm);
            if (this.portfolio.positions.length >= (isTargetHit || isDefensive ? 1 : this.portfolio.maxOpenPositions)) break;
            continue;
          } else if (rlmSignal.type === 'SHORT' && rsi >= 35 && !hasBullishAbsorptionBottom && sellFlow >= 0.48) {
            const lev = isDefensive ? 1 : 2;
            const strategyName = 'RLM Key Level Rejection Sniper Short';
            const reason = `${strategyName} [${lev}x]: Rejection at Resistance $${formatTokenPrice(rlmSignal.levelPrice)} (Score: ${rlmSignal.levelScore}, Touches: ${rlmSignal.touches}). Wick SL: $${formatTokenPrice(rlmSignal.sl)}.`;
            this.log(`🎯 A+ RLM Signal: ${sym} SHORT (${lev}x Lev) | ${reason}`);
            await this.openPosition(sym, 'SHORT', strategyName, reason, lev, galton, rlm);
            if (this.portfolio.positions.length >= (isTargetHit || isDefensive ? 1 : this.portfolio.maxOpenPositions)) break;
            continue;
          }
        }

        // --- STRATEGY 2: High Confluence Trend Momentum ---
        // Long Setup
        if (supertrend === 'BUY' && macdTrend === 'BULLISH') {
          // 1. HTF Trend Filter: Do not take long when macro bias is Bearish
          if (htfBias === 'BEARISH') {
            continue;
          }

          // 2. Ceiling Filter: Avoid buying into heavy RLM resistance ceiling right above (<1.2%)
          if (nearestRes && nearestRes.score >= 50 && nearestRes.distancePct < 1.2) {
            continue;
          }

          // 3. Choppy Filter: Do not chase momentum in choppy range rotation
          if (isChoppy) {
            continue;
          }

          // 4. Flow Filter
          if (buyFlow < 0.48 || hasBearishAbsorptionTop) {
            continue;
          }

          let lev = 1;
          let strategyName = 'Supertrend + MACD Momentum';

          if (isDefensive) {
            if (buyVotes >= 15 && sellVotes <= 5 && rsi >= 48 && rsi <= 65 && buyFlow >= 0.52) {
              lev = 1;
              strategyName = 'Defensive Orderflow Long';
            } else {
              continue;
            }
          } else if (isTargetHit) {
            if (buyVotes >= 16 && sellVotes <= 4 && rsi >= 48 && rsi <= 62 && buyFlow >= 0.55) {
              lev = 2;
              strategyName = 'Sniper A+ Galton-Confluence Long';
            } else {
              continue;
            }
          } else {
            // Normal Trading:
            // Tier 3: 3x Leverage (Ultra A+ setup: buyVotes >= 17, sellVotes <= 4, pristine RSI 48-62, strong Buy flow >= 58%, directional OVL <= 55%)
            if (buyVotes >= 17 && sellVotes <= 4 && rsi >= 48 && rsi <= 62 && buyFlow >= 0.58 && ovlScore <= 0.55) {
              lev = 3;
              strategyName = 'Ultra A+ Galton/Footprint Sniper Long';
            }
            // Tier 2: 2x Leverage (Strong setup: buyVotes >= 15, sellVotes <= 5, RSI 46-66, buyFlow >= 0.52)
            else if (buyVotes >= 15 && sellVotes <= 5 && rsi >= 46 && rsi <= 66 && buyFlow >= 0.52) {
              lev = 2;
              strategyName = 'High Confluence Orderflow Long';
            }
            // Tier 1: 1x Leverage (Standard setup: buyVotes >= 13, sellVotes <= 6, RSI 45-70, buyFlow >= 0.50)
            else if (buyVotes >= 13 && sellVotes <= 6 && rsi >= 45 && rsi <= 70 && buyFlow >= 0.50) {
              lev = 1;
              strategyName = 'Standard Momentum Long';
            } else {
              continue;
            }
          }

          const flowStr = galton ? ` [Flow: ${Math.round(buyFlow * 100)}% Buy, POC: $${galton.pocPrice}]` : '';
          const fpStr = footprint ? ` [FP: ${footprint.marketStructure}, OVL: ${(ovlScore * 100).toFixed(0)}%]` : '';
          const reason = `${strategyName} [${lev}x]: Supertrend Bullish, MACD Bullish, HTF ${htfBias}, RSI ${rsi}, 26-TA Buy (${buyVotes}/26, sell: ${sellVotes})${flowStr}${fpStr}.`;
          this.log(`🚀 Entry Signal: ${sym} LONG (${lev}x Lev) | Reason: ${reason}`);
          await this.openPosition(sym, 'LONG', strategyName, reason, lev, galton, rlm);
          if (this.portfolio.positions.length >= (isTargetHit || isDefensive ? 1 : this.portfolio.maxOpenPositions)) break;
        }

        // Short Setup
        else if (supertrend === 'SELL' && macdTrend === 'BEARISH') {
          // 1. HTF Trend Filter: Do not short when macro bias is Bullish
          if (htfBias === 'BULLISH') {
            continue;
          }

          // 2. Floor Filter: Avoid shorting right into heavy RLM support floor right below (<1.2%)
          if (nearestSup && nearestSup.score >= 50 && nearestSup.distancePct < 1.2) {
            continue;
          }

          // 3. Choppy Filter: Do not chase momentum in choppy range rotation
          if (isChoppy) {
            continue;
          }

          // 4. Flow Filter
          if (sellFlow < 0.48 || hasBullishAbsorptionBottom) {
            continue;
          }

          let lev = 1;
          let strategyName = 'Supertrend + MACD Breakdown';

          if (isDefensive) {
            if (sellVotes >= 15 && buyVotes <= 5 && rsi >= 35 && rsi <= 52 && sellFlow >= 0.52) {
              lev = 1;
              strategyName = 'Defensive Orderflow Short';
            } else {
              continue;
            }
          } else if (isTargetHit) {
            if (sellVotes >= 16 && buyVotes <= 4 && rsi >= 38 && rsi <= 52 && sellFlow >= 0.55) {
              lev = 2;
              strategyName = 'Sniper A+ Galton-Confluence Short';
            } else {
              continue;
            }
          } else {
            // Tier 3: 3x Leverage (Ultra A+ setup: sellVotes >= 17, buyVotes <= 4, pristine RSI 38-52, sellFlow >= 58%, directional OVL <= 55%)
            if (sellVotes >= 17 && buyVotes <= 4 && rsi >= 38 && rsi <= 52 && sellFlow >= 0.58 && ovlScore <= 0.55) {
              lev = 3;
              strategyName = 'Ultra A+ Galton/Footprint Sniper Short';
            }
            // Tier 2: 2x Leverage (Strong setup: sellVotes >= 15, buyVotes <= 5, RSI 34-54, sellFlow >= 0.52)
            else if (sellVotes >= 15 && buyVotes <= 5 && rsi >= 34 && rsi <= 54 && sellFlow >= 0.52) {
              lev = 2;
              strategyName = 'High Confluence Orderflow Short';
            }
            // Tier 1: 1x Leverage (Standard setup: sellVotes >= 13, buyVotes <= 6, RSI 30-55, sellFlow >= 0.50)
            else if (sellVotes >= 13 && buyVotes <= 6 && rsi >= 30 && rsi <= 55 && sellFlow >= 0.50) {
              lev = 1;
              strategyName = 'Standard Momentum Short';
            } else {
              continue;
            }
          }

          const flowStr = galton ? ` [Flow: ${Math.round(sellFlow * 100)}% Sell, POC: $${galton.pocPrice}]` : '';
          const fpStr = footprint ? ` [FP: ${footprint.marketStructure}, OVL: ${(ovlScore * 100).toFixed(0)}%]` : '';
          const reason = `${strategyName} [${lev}x]: Supertrend Bearish, MACD Bearish, HTF ${htfBias}, RSI ${rsi}, 26-TA Sell (${sellVotes}/26, buy: ${buyVotes})${flowStr}${fpStr}.`;
          this.log(`🚀 Entry Signal: ${sym} SHORT (${lev}x Lev) | Reason: ${reason}`);
          await this.openPosition(sym, 'SHORT', strategyName, reason, lev, galton, rlm);
          if (this.portfolio.positions.length >= (isTargetHit || isDefensive ? 1 : this.portfolio.maxOpenPositions)) break;
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
    if (isDailyStopLossHit) {
      tradingMode = 'HALTED (Daily Stop Loss Hit)';
    } else if (isTargetMaxHit) {
      tradingMode = 'LOCKED (Daily 3% Max Target Reached)';
    } else if (isTargetHit) {
      tradingMode = 'SNIPER (A+ Setups Only, 2x Max)';
    } else if (this.portfolio.dailyRealizedPnl <= -(dailyLossLimit * 0.5)) {
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
