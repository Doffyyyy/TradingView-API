/**
 * TradingView-API — Strategy V2 Configuration
 * Centralized, non-hardcoded configuration for Regime, Setup, Risk, Execution and Exit.
 */

const defaultConfig = {
  version: '2.0.0',
  dataset: '7m_crypto_5symbols',
  initialEquity: 10000,

  // Timeframes
  executionTimeframe: '15m',
  regimeTimeframe: '1h',
  macroTimeframe: '4h',

  // Execution & Cost Model (Section 3)
  execution: {
    slippageBps: 2,         // 2 basis points = 0.02%
    takerFee: 0.00035,      // 0.035% Hyperliquid Taker Fee
    makerFee: 0.00010,      // 0.010% Hyperliquid Maker Fee
    intrabarMode: 'CONSERVATIVE', // If high >= TP and low <= SL in same candle -> SL hit first
  },

  // Risk & Position Sizing (Section 15, 16, 20, 21)
  risk: {
    riskPerTradePct: 0.005,    // 0.5% equity risk per trade ($50 on $10k)
    maxPortfolioRiskPct: 0.015, // Max 1.5% total open risk across portfolio
    maxOpenPositions: 3,       // Max concurrent open positions
    maxLeverage: 2.0,          // Execution constraint: max notional 2x equity
    maxDailyLossPct: 0.02,     // 2% daily loss circuit breaker (disables new entries)
    maxConsecutiveLosses: 4,   // Consecutive losses pause filter
  },

  // Stop Loss Model (Section 14)
  stopLoss: {
    swingLookback: 28,       // Lookback bars for recent swing low (7 hours on 15M)
    atrBufferMultiplier: 1.1,// Distance below swing low in ATR multiples (avoids noise sweeps)
    minStopPct: 0.008,       // Minimum stop distance (0.8%) to prevent noise stopouts
    maxStopPct: 0.035,       // Maximum stop distance (3.5%) - reject trade if exceeded
    fallbackAtrMultiple: 2.0,// Fallback SL distance if swing low undefined
  },

  // Macro & Asset Regime (Section 4, 5, 6)
  regime: {
    enabled: true,
    btcEmaFast: 50,
    btcEmaSlow: 200,
    btcSlopeLookback: 3,
    assetEmaFast: 20,
    assetEmaMid: 50,
    assetEmaSlow: 200,
    // Allowed combinations for LONG in Phase 1
    allowedLongRegimes: [
      { btc: 'STRONG_BULL', asset: 'STRONG_UPTREND' },
      { btc: 'STRONG_BULL', asset: 'UPTREND' },
      { btc: 'BULL', asset: 'STRONG_UPTREND' },
      { btc: 'BULL', asset: 'UPTREND' },
      { btc: 'NEUTRAL', asset: 'STRONG_UPTREND' }, // Limited/Selective
    ],
  },

  // Setup: TREND_PULLBACK (Section 8, 9, 11, 12, 13)
  setup: {
    name: 'SETUP_TREND_PULLBACK',
    rsiPeriod: 14,
    rsiPullbackMin: 34,
    rsiPullbackMax: 49,
    emaPullbackProximity: 0.008, // Price within 0.8% of 15M EMA20 or EMA50
    volumeSmaPeriod: 20,
    minVolumeRatio: 1.15,
    minAtrPct: 0.003, // Filter out dead consolidation (< 0.3% ATR)
    maxAtrPct: 0.045, // Filter out extreme flash-crash volatility (> 4.5% ATR)
  },

  // Entry Scoring (Section 10)
  scoring: {
    minScoreToTrade: 7, // Score >= 7 -> TRADE, 6 -> WATCH, <= 5 -> IGNORE
    weights: {
      trendAlignment: 2,   // Asset 1H Strong Uptrend + 15M EMA20 > EMA50
      btcRegime: 2,        // BTC Strong Bull (+2) or Bull (+1)
      pullbackQuality: 1,  // Touched EMA20/50 without closing below EMA50
      rsiConfirmation: 1,  // RSI in 34-49 & curling up
      volumeConfirmation: 1, // volumeRatio >= 1.2 on bounce
      candleStructure: 1,  // Bullish reversal candle (green, lower wick, hammer)
      volatilityCondition: 1, // ATR% healthy within normal range
    },
  },

  // Exit Model (Section 17, 26)
  exit: {
    mode: 'FIXED_R',       // 'FIXED_R' | 'BE_PLUS_TARGET' | 'PARTIAL_TRAIL' | 'ATR_TRAIL'
    riskRewardRatio: 2.0,  // Target R for Fixed R / Target modes
    beTriggerR: 1.0,       // R level to move SL to Breakeven
    partialTpRatio: 0.5,   // Close 50% at partial TP
    partialTpR: 1.0,       // Take partial profit at 1.0R
    atrTrailMultiplier: 2.0,// Trailing stop distance in ATR multiples
    maxHoldingBars: 48,    // 48 bars = 12 hours time exit if trade stagnates
  },
};

function createConfig(customOverrides = {}) {
  return JSON.parse(JSON.stringify({
    ...defaultConfig,
    ...customOverrides,
    execution: { ...defaultConfig.execution, ...(customOverrides.execution || {}) },
    risk: { ...defaultConfig.risk, ...(customOverrides.risk || {}) },
    stopLoss: { ...defaultConfig.stopLoss, ...(customOverrides.stopLoss || {}) },
    regime: { ...defaultConfig.regime, ...(customOverrides.regime || {}) },
    setup: { ...defaultConfig.setup, ...(customOverrides.setup || {}) },
    scoring: { ...defaultConfig.scoring, ...(customOverrides.scoring || {}) },
    exit: { ...defaultConfig.exit, ...(customOverrides.exit || {}) },
  }));
}

module.exports = {
  defaultConfig,
  createConfig,
};
