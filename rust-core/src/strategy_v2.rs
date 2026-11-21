use serde::{Deserialize, Serialize};
use crate::util::{format_iso_from_ms, CandleSlice};

#[derive(Deserialize)]
pub struct StrategyRunMeta {
    pub config: StrategyConfig,
    pub symbols: Vec<String>,
    pub slices: Vec<SliceMeta>,
}

#[derive(Deserialize)]
pub struct SliceMeta {
    pub key: String,
    pub offset: usize,
    pub len: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyConfig {
    pub initial_equity: Option<f64>,
    pub execution: ExecutionCfg,
    pub risk: RiskCfg,
    pub stop_loss: StopLossCfg,
    pub regime: RegimeCfg,
    pub setup: SetupCfg,
    pub scoring: ScoringCfg,
    pub exit: ExitCfg,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionCfg {
    pub slippage_bps: Option<f64>,
    pub taker_fee: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskCfg {
    pub risk_per_trade_pct: Option<f64>,
    pub max_portfolio_risk_pct: Option<f64>,
    pub max_open_positions: Option<usize>,
    pub max_leverage: Option<f64>,
    pub max_daily_loss_pct: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopLossCfg {
    pub swing_lookback: Option<usize>,
    pub atr_buffer_multiplier: Option<f64>,
    pub min_stop_pct: Option<f64>,
    pub max_stop_pct: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegimeCfg {
    pub enabled: Option<bool>,
    pub btc_ema_fast: Option<usize>,
    pub btc_ema_slow: Option<usize>,
    pub btc_slope_lookback: Option<usize>,
    pub asset_ema_fast: Option<usize>,
    pub asset_ema_mid: Option<usize>,
    pub asset_ema_slow: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupCfg {
    pub name: Option<String>,
    pub rsi_period: Option<usize>,
    pub rsi_pullback_min: Option<f64>,
    pub rsi_pullback_max: Option<f64>,
    pub ema_pullback_proximity: Option<f64>,
    pub volume_sma_period: Option<usize>,
    pub min_volume_ratio: Option<f64>,
    pub min_atr_pct: Option<f64>,
    pub max_atr_pct: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoringCfg {
    pub min_score_to_trade: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitCfg {
    pub mode: Option<String>,
    pub risk_reward_ratio: Option<f64>,
    pub be_trigger_r: Option<f64>,
    #[allow(dead_code)]
    pub partial_tp_ratio: Option<f64>,
    pub partial_tp_r: Option<f64>,
    pub atr_trail_multiplier: Option<f64>,
    pub max_holding_bars: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeRecord {
    pub id: String,
    pub symbol: String,
    pub side: &'static str,
    pub signal_time: String,
    pub entry_time: String,
    pub exit_time: String,
    pub entry_price: f64,
    pub exit_price: f64,
    pub stop_loss: f64,
    pub notional: f64,
    pub size: f64,
    pub equity_before: f64,
    pub equity_after: f64,
    pub risk_dollar: f64,
    pub risk_percent: f64,
    pub pnl_dollar: f64,
    pub pnl_percent: f64,
    pub pnl_r: f64,
    pub fees: f64,
    pub slippage: f64,
    pub btc_regime: &'static str,
    pub asset_regime: &'static str,
    pub setup: String,
    pub entry_score: i32,
    pub rsi: f64,
    pub atr_pct: f64,
    pub volume_ratio: f64,
    pub mfe: f64,
    pub mae: f64,
    pub mfe_r: f64,
    pub mae_r: f64,
    pub exit_reason: &'static str,
    pub holding_bars: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquityPoint {
    pub timestamp: String,
    pub equity: f64,
    pub open_positions_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyRunResult {
    pub trades: Vec<TradeRecord>,
    pub equity_history: Vec<EquityPoint>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BtcRegime {
    StrongBull,
    Bull,
    Bear,
    Neutral,
}

impl BtcRegime {
    fn as_str(self) -> &'static str {
        match self {
            BtcRegime::StrongBull => "STRONG_BULL",
            BtcRegime::Bull => "BULL",
            BtcRegime::Bear => "BEAR",
            BtcRegime::Neutral => "NEUTRAL",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AssetRegime {
    StrongUptrend,
    Uptrend,
    StrongDowntrend,
    Downtrend,
    Range,
}

impl AssetRegime {
    fn as_str(self) -> &'static str {
        match self {
            AssetRegime::StrongUptrend => "STRONG_UPTREND",
            AssetRegime::Uptrend => "UPTREND",
            AssetRegime::StrongDowntrend => "STRONG_DOWNTREND",
            AssetRegime::Downtrend => "DOWNTREND",
            AssetRegime::Range => "RANGE",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExitMode {
    FixedR,
    BePlusTarget,
    PartialTrail,
    AtrTrail,
}

#[inline]
fn or_f64(v: Option<f64>, def: f64) -> f64 {
    match v {
        Some(x) if x != 0.0 => x,
        _ => def,
    }
}

#[inline]
fn or_usize(v: Option<usize>, def: usize) -> usize {
    match v {
        Some(x) if x != 0 => x,
        _ => def,
    }
}

fn calc_ema_full(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    let mut ema = vec![0.0; n];
    if n == 0 || period == 0 {
        return ema;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let init_count = period.min(n);
    let mut sum = 0.0;
    for i in 0..init_count {
        sum += values[i];
    }
    ema[init_count - 1] = sum / init_count as f64;
    for i in init_count..n {
        ema[i] = values[i] * k + ema[i - 1] * (1.0 - k);
    }
    ema
}

fn calc_sma_full(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    let mut sma = vec![0.0; n];
    if n == 0 || period == 0 {
        return sma;
    }
    let mut sum = 0.0;
    for i in 0..n {
        sum += values[i];
        if i >= period {
            sum -= values[i - period];
            sma[i] = sum / period as f64;
        } else if i == period - 1 {
            sma[i] = sum / period as f64;
        } else {
            sma[i] = sum / (i + 1) as f64;
        }
    }
    sma
}

fn calc_atr_full(c: &CandleSlice<'_>, period: usize) -> Vec<f64> {
    let n = c.n;
    let mut atr = vec![0.0; n];
    if n == 0 {
        return atr;
    }
    let mut tr = vec![0.0; n];
    tr[0] = c.highs[0] - c.lows[0];
    for i in 1..n {
        let hl = c.highs[i] - c.lows[i];
        let hc = (c.highs[i] - c.closes[i - 1]).abs();
        let lc = (c.lows[i] - c.closes[i - 1]).abs();
        tr[i] = hl.max(hc).max(lc);
    }
    let init_count = period.min(n);
    let mut tr_sum = 0.0;
    for i in 0..init_count {
        tr_sum += tr[i];
    }
    atr[init_count - 1] = tr_sum / init_count as f64;
    let p_f = period as f64;
    for i in init_count..n {
        atr[i] = (atr[i - 1] * (p_f - 1.0) + tr[i]) / p_f;
    }
    atr
}

fn calc_rsi_full(closes: &[f64], period: usize) -> Vec<f64> {
    let n = closes.len();
    let mut rsi = vec![0.0; n];
    if n < period + 1 {
        return rsi;
    }
    let mut avg_gain = 0.0;
    let mut avg_loss = 0.0;
    for i in 1..=period {
        let diff = closes[i] - closes[i - 1];
        if diff > 0.0 {
            avg_gain += diff;
        } else {
            avg_loss += -diff;
        }
    }
    let p_f = period as f64;
    avg_gain /= p_f;
    avg_loss /= p_f;
    rsi[period] = if avg_loss == 0.0 {
        100.0
    } else {
        100.0 - (100.0 / (1.0 + (avg_gain / avg_loss)))
    };
    for i in (period + 1)..n {
        let diff = closes[i] - closes[i - 1];
        let gain = if diff > 0.0 { diff } else { 0.0 };
        let loss = if diff < 0.0 { -diff } else { 0.0 };
        avg_gain = (avg_gain * (p_f - 1.0) + gain) / p_f;
        avg_loss = (avg_loss * (p_f - 1.0) + loss) / p_f;
        rsi[i] = if avg_loss == 0.0 {
            100.0
        } else {
            100.0 - (100.0 / (1.0 + (avg_gain / avg_loss)))
        };
    }
    rsi
}

#[inline]
fn get_slope(series: &[f64], index: usize, lookback: usize) -> f64 {
    if index < lookback {
        return 0.0;
    }
    let prev = series[index - lookback];
    if prev == 0.0 {
        return 0.0;
    }
    (series[index] - prev) / (prev * lookback as f64)
}

#[inline]
fn get_swing_low(lows: &[f64], end_index: usize, lookback: usize) -> f64 {
    let start = if end_index + 1 >= lookback {
        end_index + 1 - lookback
    } else {
        0
    };
    let mut min_low = f64::INFINITY;
    for i in start..=end_index {
        if lows[i] < min_low {
            min_low = lows[i];
        }
    }
    if min_low == f64::INFINITY {
        lows[end_index]
    } else {
        min_low
    }
}

fn precompute_htf_mapping(times_15m: &[f64], times_1h: &[f64]) -> Vec<i32> {
    let n15 = times_15m.len();
    let n1 = times_1h.len();
    let mut map = vec![-1i32; n15];
    const ONE_HOUR_MS: f64 = 3_600_000.0;
    const FIFTEEN_MIN_MS: f64 = 900_000.0;
    let mut h1_idx = 0usize;
    for i in 0..n15 {
        let close_time_15m = times_15m[i] + FIFTEEN_MIN_MS;
        while h1_idx + 1 < n1 && (times_1h[h1_idx + 1] + ONE_HOUR_MS) <= close_time_15m {
            h1_idx += 1;
        }
        if h1_idx < n1 && (times_1h[h1_idx] + ONE_HOUR_MS) <= close_time_15m {
            map[i] = h1_idx as i32;
        }
    }
    map
}

fn compute_btc_macro_regimes(btc_1h: &CandleSlice<'_>, cfg: &RegimeCfg) -> Vec<BtcRegime> {
    let n = btc_1h.n;
    let ema50 = calc_ema_full(btc_1h.closes, or_usize(cfg.btc_ema_fast, 50));
    let ema200 = calc_ema_full(btc_1h.closes, or_usize(cfg.btc_ema_slow, 200));
    let ema4h200 = calc_ema_full(btc_1h.closes, 800);
    let slope_lookback = or_usize(cfg.btc_slope_lookback, 3);
    let mut regimes = vec![BtcRegime::Neutral; n];
    for i in 800..n {
        let close = btc_1h.closes[i];
        let e50 = ema50[i];
        let e200 = ema200[i];
        let e4h200 = ema4h200[i];
        let slope50 = get_slope(&ema50, i, slope_lookback);
        let slope200 = get_slope(&ema200, i, slope_lookback);
        if close > e50 && e50 > e200 && close > e4h200 && slope50 > 0.0 && slope200 >= 0.0 {
            regimes[i] = BtcRegime::StrongBull;
        } else if close > e50 && e50 > e200 && close > e4h200 {
            regimes[i] = BtcRegime::Bull;
        } else if close < e50 && e50 < e200 {
            regimes[i] = BtcRegime::Bear;
        } else {
            regimes[i] = BtcRegime::Neutral;
        }
    }
    regimes
}

fn compute_asset_regimes(asset_1h: &CandleSlice<'_>, cfg: &RegimeCfg) -> Vec<AssetRegime> {
    let n = asset_1h.n;
    let ema20 = calc_ema_full(asset_1h.closes, or_usize(cfg.asset_ema_fast, 20));
    let ema50 = calc_ema_full(asset_1h.closes, or_usize(cfg.asset_ema_mid, 50));
    let ema200 = calc_ema_full(asset_1h.closes, or_usize(cfg.asset_ema_slow, 200));
    let rsi = calc_rsi_full(asset_1h.closes, 14);
    let mut regimes = vec![AssetRegime::Range; n];
    for i in 200..n {
        let close = asset_1h.closes[i];
        let e20 = ema20[i];
        let e50 = ema50[i];
        let e200 = ema200[i];
        let slope20 = get_slope(&ema20, i, 3);
        let r = rsi[i];
        if close > e20 && e20 > e50 && e50 > e200 && slope20 > 0.0 && r > 50.0 {
            regimes[i] = AssetRegime::StrongUptrend;
        } else if close > e50 && e50 > e200 {
            regimes[i] = AssetRegime::Uptrend;
        } else if close < e20 && e20 < e50 && e50 < e200 {
            regimes[i] = AssetRegime::StrongDowntrend;
        } else if close < e50 && e50 < e200 {
            regimes[i] = AssetRegime::Downtrend;
        } else {
            regimes[i] = AssetRegime::Range;
        }
    }
    regimes
}

#[inline]
fn check_long_permission(
    regime_enabled: bool,
    btc_regime: BtcRegime,
    asset_regime: AssetRegime,
) -> (bool, i32) {
    if !regime_enabled {
        return (true, 1);
    }
    match (btc_regime, asset_regime) {
        (BtcRegime::StrongBull, AssetRegime::StrongUptrend)
        | (BtcRegime::StrongBull, AssetRegime::Uptrend) => (true, 2),
        (BtcRegime::Bull, AssetRegime::StrongUptrend)
        | (BtcRegime::Bull, AssetRegime::Uptrend) => (true, 1),
        (BtcRegime::Neutral, AssetRegime::StrongUptrend) => (true, 0),
        _ => (false, 0),
    }
}

struct PendingOrder {
    signal_time: f64,
    stop_loss: f64,
    btc_regime: BtcRegime,
    asset_regime: AssetRegime,
    score: i32,
    rsi: f64,
    atr_pct: f64,
    volume_ratio: f64,
}

struct OpenPosition {
    sym_idx: usize,
    id: String,
    signal_time: String,
    entry_time: String,
    entry_price: f64,
    stop_loss: f64,
    stop_distance: f64,
    notional: f64,
    size: f64,
    risk_dollar: f64,
    risk_percent: f64,
    entry_fee: f64,
    slippage: f64,
    btc_regime: &'static str,
    asset_regime: &'static str,
    entry_score: i32,
    rsi: f64,
    atr_pct: f64,
    volume_ratio: f64,
    // Exit state
    holding_bars: u32,
    highest_price: f64,
    lowest_price: f64,
    max_favorable_excursion: f64,
    max_adverse_excursion: f64,
    is_breakeven: bool,
    partial_taken: bool,
    trailing_stop_price: f64,
}

struct AssetState<'a> {
    symbol: String,
    c15: CandleSlice<'a>,
    map_asset_1h: Vec<i32>,
    map_btc_1h: Vec<i32>,
    regimes: Vec<AssetRegime>,
    ema20: Vec<f64>,
    ema50: Vec<f64>,
    rsi: Vec<f64>,
    atr: Vec<f64>,
    volume_sma: Vec<f64>,
    pending_order: Option<PendingOrder>,
}

pub fn run_strategy_v2(meta: &StrategyRunMeta, data: &[f64]) -> StrategyRunResult {
    let find_slice = |key: &str| -> Option<CandleSlice<'_>> {
        let s = meta.slices.iter().find(|sl| sl.key == key)?;
        let start = s.offset;
        let count = s.len;
        if count == 0 {
            return None;
        }
        let end = start + count * 6;
        if end > data.len() {
            return None;
        }
        let slice_data = &data[start..end];
        Some(unsafe { CandleSlice::from_raw(slice_data.as_ptr(), count) })
    };

    let btc1h = find_slice("BTCUSDT_1h").expect("BTCUSDT_1h required");
    let cfg = &meta.config;
    let btc_regimes = compute_btc_macro_regimes(&btc1h, &cfg.regime);

    let rsi_period = or_usize(cfg.setup.rsi_period, 14);
    let vol_sma_period = or_usize(cfg.setup.volume_sma_period, 20);

    let mut assets: Vec<AssetState<'_>> = Vec::with_capacity(meta.symbols.len());
    for sym in &meta.symbols {
        let k15 = format!("{}_15m", sym);
        let k1 = format!("{}_1h", sym);
        let (Some(c15), Some(c1)) = (find_slice(&k15), find_slice(&k1)) else {
            continue;
        };
        let map_asset_1h = precompute_htf_mapping(c15.times, c1.times);
        let map_btc_1h = precompute_htf_mapping(c15.times, btc1h.times);
        let regimes = compute_asset_regimes(&c1, &cfg.regime);
        let ema20 = calc_ema_full(c15.closes, 20);
        let ema50 = calc_ema_full(c15.closes, 50);
        let rsi = calc_rsi_full(c15.closes, rsi_period);
        let atr = calc_atr_full(&c15, 14);
        let volume_sma = calc_sma_full(c15.volumes, vol_sma_period);

        assets.push(AssetState {
            symbol: sym.clone(),
            c15,
            map_asset_1h,
            map_btc_1h,
            regimes,
            ema20,
            ema50,
            rsi,
            atr,
            volume_sma,
            pending_order: None,
        });
    }

    if assets.is_empty() {
        return StrategyRunResult {
            trades: Vec::new(),
            equity_history: Vec::new(),
        };
    }

    let total_bars = assets[0].c15.n;
    let initial_equity = or_f64(cfg.initial_equity, 10000.0);
    let mut equity = initial_equity;

    let slippage_bps = or_f64(cfg.execution.slippage_bps, 2.0);
    let taker_fee = or_f64(cfg.execution.taker_fee, 0.00035);

    let risk_per_trade_pct = or_f64(cfg.risk.risk_per_trade_pct, 0.005);
    let max_portfolio_risk_pct = or_f64(cfg.risk.max_portfolio_risk_pct, 0.015);
    let max_open_positions = or_usize(cfg.risk.max_open_positions, 3);
    let max_leverage = or_f64(cfg.risk.max_leverage, 2.0);
    let max_daily_loss_pct = or_f64(cfg.risk.max_daily_loss_pct, 0.02);

    let swing_lookback = or_usize(cfg.stop_loss.swing_lookback, 28);
    let atr_buffer_mult = or_f64(cfg.stop_loss.atr_buffer_multiplier, 1.1);
    let min_stop_pct = or_f64(cfg.stop_loss.min_stop_pct, 0.008);
    let max_stop_pct = or_f64(cfg.stop_loss.max_stop_pct, 0.035);

    let regime_enabled = cfg.regime.enabled.unwrap_or(true);
    let setup_name = cfg
        .setup
        .name
        .clone()
        .unwrap_or_else(|| "SETUP_TREND_PULLBACK".to_string());
    let rsi_pb_min = or_f64(cfg.setup.rsi_pullback_min, 34.0);
    let rsi_pb_max = or_f64(cfg.setup.rsi_pullback_max, 49.0);
    let ema_pb_prox = or_f64(cfg.setup.ema_pullback_proximity, 0.008);
    let min_vol_ratio = or_f64(cfg.setup.min_volume_ratio, 1.15);
    let min_atr_pct = or_f64(cfg.setup.min_atr_pct, 0.003);
    let max_atr_pct = or_f64(cfg.setup.max_atr_pct, 0.045);

    let min_score_to_trade = match cfg.scoring.min_score_to_trade {
        Some(x) if x != 0 => x,
        _ => 7,
    };

    let exit_mode = match cfg.exit.mode.as_deref().unwrap_or("FIXED_R") {
        "BE_PLUS_TARGET" => ExitMode::BePlusTarget,
        "PARTIAL_TRAIL" => ExitMode::PartialTrail,
        "ATR_TRAIL" => ExitMode::AtrTrail,
        _ => ExitMode::FixedR,
    };
    let rr_fixed = or_f64(cfg.exit.risk_reward_ratio, 2.0);
    let rr_partial = or_f64(cfg.exit.risk_reward_ratio, 2.5);
    let be_trigger_r = or_f64(cfg.exit.be_trigger_r, 1.0);
    let partial_tp_r = or_f64(cfg.exit.partial_tp_r, 1.0);
    let atr_trail_mult = or_f64(cfg.exit.atr_trail_multiplier, 2.0);
    let max_holding_bars = match cfg.exit.max_holding_bars {
        Some(x) if x != 0 => x,
        _ => 48,
    };

    let mut open_positions: Vec<OpenPosition> = Vec::with_capacity(max_open_positions);
    let mut closed_trades: Vec<TradeRecord> = Vec::new();
    let mut equity_history: Vec<EquityPoint> = Vec::with_capacity(total_bars / 4 + 1);

    let mut current_day_id: i64 = i64::MIN;
    let mut day_starting_equity = equity;
    let mut day_realized_pnl = 0.0;
    let mut day_breaker_tripped = false;

    for bar_idx in 200..total_bars {
        let current_ts = assets[0].c15.times[bar_idx];
        let day_id = (current_ts as i64).div_euclid(86_400_000);
        if day_id != current_day_id {
            current_day_id = day_id;
            day_starting_equity = equity;
            day_realized_pnl = 0.0;
            day_breaker_tripped = false;
        }

        let max_daily_loss_dollar = day_starting_equity * max_daily_loss_pct;
        if day_realized_pnl <= -max_daily_loss_dollar {
            day_breaker_tripped = true;
        }

        // STEP A: Execute Pending Orders at Bar OPEN
        for sym_idx in 0..assets.len() {
            let pending = match assets[sym_idx].pending_order.take() {
                Some(p) => p,
                None => continue,
            };
            if day_breaker_tripped {
                continue;
            }
            if open_positions.iter().any(|p| p.sym_idx == sym_idx) {
                continue;
            }

            let raw_open = assets[sym_idx].c15.opens[bar_idx];
            let open_time = assets[sym_idx].c15.times[bar_idx];
            let entry_price = raw_open * (1.0 + slippage_bps / 10000.0);
            let stop_distance = entry_price - pending.stop_loss;
            if stop_distance <= 0.0 {
                continue;
            }

            // Position sizing
            let risk_dollar = equity * risk_per_trade_pct;
            let stop_distance_pct = stop_distance / entry_price;
            let mut notional = risk_dollar / stop_distance_pct;
            let max_notional = equity * max_leverage;
            if notional > max_notional {
                notional = max_notional;
            }
            let size = notional / entry_price;
            let effective_risk_dollar = notional * stop_distance_pct;
            let effective_risk_pct = effective_risk_dollar / equity;

            if notional <= 0.0 || size <= 0.0 {
                continue;
            }

            // Portfolio exposure guard
            if open_positions.len() >= max_open_positions {
                continue;
            }
            let total_open_risk: f64 = open_positions.iter().map(|p| p.risk_dollar).sum();
            let max_portfolio_risk_dollar = equity * max_portfolio_risk_pct;
            if total_open_risk + effective_risk_dollar > max_portfolio_risk_dollar {
                continue;
            }

            let entry_fee = notional * taker_fee;
            let pos = OpenPosition {
                sym_idx,
                id: format!("T2_{}_{}_rust", assets[sym_idx].symbol, bar_idx),
                signal_time: format_iso_from_ms(pending.signal_time as i64),
                entry_time: format_iso_from_ms(open_time as i64),
                entry_price,
                stop_loss: pending.stop_loss,
                stop_distance,
                notional,
                size,
                risk_dollar: effective_risk_dollar,
                risk_percent: effective_risk_pct,
                entry_fee,
                slippage: notional * (slippage_bps / 10000.0),
                btc_regime: pending.btc_regime.as_str(),
                asset_regime: pending.asset_regime.as_str(),
                entry_score: pending.score,
                rsi: pending.rsi,
                atr_pct: pending.atr_pct,
                volume_ratio: pending.volume_ratio,
                holding_bars: 0,
                highest_price: entry_price,
                lowest_price: entry_price,
                max_favorable_excursion: 0.0,
                max_adverse_excursion: 0.0,
                is_breakeven: false,
                partial_taken: false,
                trailing_stop_price: pending.stop_loss,
            };
            open_positions.push(pos);
        }

        // STEP B: Check Exits on Current Bar
        let mut idx = 0;
        while idx < open_positions.len() {
            let pos = &mut open_positions[idx];
            let asset = &assets[pos.sym_idx];
            let c_high = asset.c15.highs[bar_idx];
            let c_low = asset.c15.lows[bar_idx];
            let c_close = asset.c15.closes[bar_idx];
            let c_time = asset.c15.times[bar_idx];
            let cur_atr = asset.atr[bar_idx];

            pos.holding_bars += 1;
            if c_high > pos.highest_price {
                pos.highest_price = c_high;
            }
            if c_low < pos.lowest_price {
                pos.lowest_price = c_low;
            }
            let cur_fav = pos.highest_price - pos.entry_price;
            let cur_adv = pos.entry_price - pos.lowest_price;
            if cur_fav > pos.max_favorable_excursion {
                pos.max_favorable_excursion = cur_fav;
            }
            if cur_adv > pos.max_adverse_excursion {
                pos.max_adverse_excursion = cur_adv;
            }

            let r_dist = pos.stop_distance;
            let round_trip_fee_buffer = pos.entry_price * (taker_fee * 2.5);

            let mut exit_res: Option<(f64, &'static str)> = None;

            match exit_mode {
                ExitMode::FixedR => {
                    let tp_price = pos.entry_price + r_dist * rr_fixed;
                    let sl_price = pos.stop_loss;
                    let hit_tp = c_high >= tp_price;
                    let hit_sl = c_low <= sl_price;
                    if hit_sl {
                        exit_res = Some((sl_price, "STOP_LOSS"));
                    } else if hit_tp {
                        exit_res = Some((tp_price, "TAKE_PROFIT"));
                    }
                }
                ExitMode::BePlusTarget => {
                    let tp_price = pos.entry_price + r_dist * rr_fixed;
                    let be_trigger = pos.entry_price + r_dist * be_trigger_r;
                    if !pos.is_breakeven && c_high >= be_trigger {
                        pos.is_breakeven = true;
                        pos.stop_loss = pos.entry_price + round_trip_fee_buffer;
                    }
                    let sl_price = pos.stop_loss;
                    let hit_tp = c_high >= tp_price;
                    let hit_sl = c_low <= sl_price;
                    if hit_sl {
                        exit_res = Some((
                            sl_price,
                            if pos.is_breakeven {
                                "BREAKEVEN"
                            } else {
                                "STOP_LOSS"
                            },
                        ));
                    } else if hit_tp {
                        exit_res = Some((tp_price, "TAKE_PROFIT"));
                    }
                }
                ExitMode::PartialTrail => {
                    let partial_tp = pos.entry_price + r_dist * partial_tp_r;
                    let final_tp = pos.entry_price + r_dist * rr_partial;
                    if !pos.partial_taken && c_high >= partial_tp {
                        pos.partial_taken = true;
                        pos.is_breakeven = true;
                        pos.stop_loss = pos.entry_price + round_trip_fee_buffer;
                    }
                    let sl_price = pos.stop_loss;
                    let hit_sl = c_low <= sl_price;
                    let hit_final = c_high >= final_tp;
                    if hit_sl {
                        exit_res = Some((
                            sl_price,
                            if pos.is_breakeven {
                                "BREAKEVEN"
                            } else {
                                "STOP_LOSS"
                            },
                        ));
                    } else if hit_final {
                        exit_res = Some((final_tp, "TAKE_PROFIT"));
                    }
                }
                ExitMode::AtrTrail => {
                    let min_profit_to_trail = pos.entry_price + r_dist * 0.8;
                    if c_high >= min_profit_to_trail {
                        let potential_trail = pos.highest_price - cur_atr * atr_trail_mult;
                        if potential_trail > pos.trailing_stop_price {
                            pos.trailing_stop_price = potential_trail;
                            if potential_trail > pos.stop_loss {
                                pos.stop_loss = potential_trail;
                            }
                        }
                    }
                    let sl_price = pos.stop_loss;
                    if c_low <= sl_price {
                        let is_trailing = pos.stop_loss > pos.entry_price;
                        exit_res = Some((
                            sl_price,
                            if is_trailing {
                                "TRAILING_STOP"
                            } else {
                                "STOP_LOSS"
                            },
                        ));
                    }
                }
            }

            if exit_res.is_none() && pos.holding_bars >= max_holding_bars {
                exit_res = Some((c_close, "TIME_EXIT"));
            }

            if let Some((exit_price, exit_reason)) = exit_res {
                let pos = open_positions.remove(idx);
                let exit_notional = pos.size * exit_price;
                let exit_fee = exit_notional * taker_fee;
                let total_fees = pos.entry_fee + exit_fee;
                let gross_pnl = (exit_price - pos.entry_price) * pos.size;
                let net_pnl = gross_pnl - total_fees;
                let pnl_r = if pos.stop_distance > 0.0 {
                    (exit_price - pos.entry_price) / pos.stop_distance
                } else {
                    0.0
                };
                equity += net_pnl;
                day_realized_pnl += net_pnl;

                closed_trades.push(TradeRecord {
                    id: pos.id,
                    symbol: assets[pos.sym_idx].symbol.clone(),
                    side: "LONG",
                    signal_time: pos.signal_time,
                    entry_time: pos.entry_time,
                    exit_time: format_iso_from_ms(c_time as i64 + 900_000),
                    entry_price: pos.entry_price,
                    exit_price,
                    stop_loss: pos.stop_loss,
                    notional: pos.notional,
                    size: pos.size,
                    equity_before: equity - net_pnl,
                    equity_after: equity,
                    risk_dollar: pos.risk_dollar,
                    risk_percent: pos.risk_percent,
                    pnl_dollar: net_pnl,
                    pnl_percent: (net_pnl / pos.notional) * 100.0,
                    pnl_r,
                    fees: total_fees,
                    slippage: pos.slippage,
                    btc_regime: pos.btc_regime,
                    asset_regime: pos.asset_regime,
                    setup: setup_name.clone(),
                    entry_score: pos.entry_score,
                    rsi: pos.rsi,
                    atr_pct: pos.atr_pct,
                    volume_ratio: pos.volume_ratio,
                    mfe: pos.max_favorable_excursion,
                    mae: pos.max_adverse_excursion,
                    mfe_r: if pos.stop_distance > 0.0 {
                        pos.max_favorable_excursion / pos.stop_distance
                    } else {
                        0.0
                    },
                    mae_r: if pos.stop_distance > 0.0 {
                        pos.max_adverse_excursion / pos.stop_distance
                    } else {
                        0.0
                    },
                    exit_reason,
                    holding_bars: pos.holding_bars,
                });
            } else {
                idx += 1;
            }
        }

        // Track equity snapshot every 4 bars (1 hour)
        if bar_idx % 4 == 0 {
            equity_history.push(EquityPoint {
                timestamp: format_iso_from_ms(current_ts as i64),
                equity,
                open_positions_count: open_positions.len(),
            });
        }

        // STEP C: Generate New Signals on Bar CLOSE
        if !day_breaker_tripped && open_positions.len() < max_open_positions {
            for sym_idx in 0..assets.len() {
                if assets[sym_idx].pending_order.is_some()
                    || open_positions.iter().any(|p| p.sym_idx == sym_idx)
                {
                    continue;
                }

                let asset = &assets[sym_idx];
                let btc_1h_idx = asset.map_btc_1h[bar_idx];
                let asset_1h_idx = asset.map_asset_1h[bar_idx];
                if btc_1h_idx < 0 || asset_1h_idx < 0 {
                    continue;
                }

                let btc_regime = btc_regimes[btc_1h_idx as usize];
                let asset_regime = asset.regimes[asset_1h_idx as usize];
                let (allowed, btc_score) =
                    check_long_permission(regime_enabled, btc_regime, asset_regime);
                if !allowed {
                    continue;
                }

                // Evaluate setup
                let open_p = asset.c15.opens[bar_idx];
                let high_p = asset.c15.highs[bar_idx];
                let low_p = asset.c15.lows[bar_idx];
                let close_p = asset.c15.closes[bar_idx];
                let e20 = asset.ema20[bar_idx];
                let e50 = asset.ema50[bar_idx];
                let r = asset.rsi[bar_idx];
                let prev_r = asset.rsi[bar_idx - 1];
                let a = asset.atr[bar_idx];
                let atr_pct = if close_p > 0.0 { a / close_p } else { 0.0 };
                let vol = asset.c15.volumes[bar_idx];
                let vol_sma = asset.volume_sma[bar_idx];
                let volume_ratio = if vol_sma > 0.0 { vol / vol_sma } else { 1.0 };

                let volatility_healthy = atr_pct >= min_atr_pct && atr_pct <= max_atr_pct;
                if !volatility_healthy {
                    continue;
                }

                let touched_ema20 = low_p <= e20 * (1.0 + ema_pb_prox);
                let touched_ema50 = low_p <= e50 * (1.0 + ema_pb_prox);
                let held_above_ema50 = close_p >= e50 * 0.996;
                let is_pullback = (touched_ema20 || touched_ema50) && held_above_ema50;
                if !is_pullback {
                    continue;
                }

                let range = high_p - low_p;
                let (is_bullish, lower_wick_ratio, is_hammer) = if range <= 0.0 {
                    (false, 0.0, false)
                } else {
                    let body = (close_p - open_p).abs();
                    let is_bull = close_p >= open_p;
                    let lw = open_p.min(close_p) - low_p;
                    let uw = high_p - open_p.max(close_p);
                    let lwr = lw / range;
                    let ih = lw >= body * 1.5 && uw <= body * 0.8;
                    (is_bull, lwr, ih)
                };
                let is_bounce = is_bullish || lower_wick_ratio >= 0.25 || is_hammer;
                if !is_bounce {
                    continue;
                }

                let mut score = 0;
                if asset_regime == AssetRegime::StrongUptrend && e20 > e50 {
                    score += 2;
                } else if asset_regime == AssetRegime::Uptrend || e20 > e50 {
                    score += 1;
                }
                score += btc_score;
                score += 1; // is_pullback is true
                if r >= rsi_pb_min && r <= rsi_pb_max && r >= prev_r - 0.5 {
                    score += 1;
                }
                if volume_ratio >= min_vol_ratio {
                    score += 1;
                }
                score += 1; // is_bounce is true
                score += 1; // volatility_healthy is true

                if score < min_score_to_trade {
                    continue;
                }

                // Calculate Structural Stop Loss
                let swing_low = get_swing_low(asset.c15.lows, bar_idx, swing_lookback);
                let mut stop_loss = swing_low - atr_buffer_mult * a;
                let mut stop_distance = close_p - stop_loss;
                let stop_pct = stop_distance / close_p;
                if stop_pct > max_stop_pct {
                    continue;
                }
                if stop_pct < min_stop_pct {
                    stop_distance = close_p * min_stop_pct;
                    stop_loss = close_p - stop_distance;
                }

                assets[sym_idx].pending_order = Some(PendingOrder {
                    signal_time: asset.c15.times[bar_idx],
                    stop_loss,
                    btc_regime,
                    asset_regime,
                    score,
                    rsi: r,
                    atr_pct,
                    volume_ratio,
                });
            }
        }
    }

    // Force close any remaining open positions
    if !open_positions.is_empty() {
        let last_bar = total_bars - 1;
        for pos in open_positions {
            let asset = &assets[pos.sym_idx];
            let exit_price = asset.c15.closes[last_bar];
            let last_time = asset.c15.times[last_bar];
            let exit_notional = pos.size * exit_price;
            let exit_fee = exit_notional * taker_fee;
            let total_fees = pos.entry_fee + exit_fee;
            let gross_pnl = (exit_price - pos.entry_price) * pos.size;
            let net_pnl = gross_pnl - total_fees;
            let pnl_r = if pos.stop_distance > 0.0 {
                (exit_price - pos.entry_price) / pos.stop_distance
            } else {
                0.0
            };
            equity += net_pnl;

            closed_trades.push(TradeRecord {
                id: pos.id,
                symbol: asset.symbol.clone(),
                side: "LONG",
                signal_time: pos.signal_time,
                entry_time: pos.entry_time,
                exit_time: format_iso_from_ms(last_time as i64),
                entry_price: pos.entry_price,
                exit_price,
                stop_loss: pos.stop_loss,
                notional: pos.notional,
                size: pos.size,
                equity_before: equity - net_pnl,
                equity_after: equity,
                risk_dollar: pos.risk_dollar,
                risk_percent: pos.risk_percent,
                pnl_dollar: net_pnl,
                pnl_percent: (net_pnl / pos.notional) * 100.0,
                pnl_r,
                fees: total_fees,
                slippage: pos.slippage,
                btc_regime: pos.btc_regime,
                asset_regime: pos.asset_regime,
                setup: setup_name.clone(),
                entry_score: pos.entry_score,
                rsi: pos.rsi,
                atr_pct: pos.atr_pct,
                volume_ratio: pos.volume_ratio,
                mfe: pos.max_favorable_excursion,
                mae: pos.max_adverse_excursion,
                mfe_r: if pos.stop_distance > 0.0 {
                    pos.max_favorable_excursion / pos.stop_distance
                } else {
                    0.0
                },
                mae_r: if pos.stop_distance > 0.0 {
                    pos.max_adverse_excursion / pos.stop_distance
                } else {
                    0.0
                },
                exit_reason: "FORCED_END_OF_BACKTEST",
                holding_bars: pos.holding_bars,
            });
        }
    }

    StrategyRunResult {
        trades: closed_trades,
        equity_history,
    }
}
