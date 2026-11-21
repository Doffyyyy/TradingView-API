use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::indicators::calc_supertrend;
use crate::util::{format_date_from_sec, js_round, round_dec, to_fixed_num, CandleSlice};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BacktestConfig {
    #[serde(rename = "type")]
    pub strat_type: Option<String>,
    pub initial_capital: Option<f64>,
    pub fee_percent: Option<f64>,
    pub slippage_percent: Option<f64>,
    pub params: Option<BacktestParams>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BacktestParams {
    pub period: Option<usize>,
    pub multiplier: Option<f64>,
    pub fast: Option<usize>,
    pub slow: Option<usize>,
    pub oversold: Option<f64>,
    pub overbought: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BacktestTrade {
    #[serde(rename = "type")]
    pub trade_type: &'static str,
    pub entry_time: f64,
    pub exit_time: f64,
    pub entry_price: f64,
    pub exit_price: f64,
    pub pnl_percent: f64,
    pub pnl_dollar: f64,
    pub capital_after: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestMetrics {
    pub total_trades: usize,
    pub winning_trades: usize,
    pub losing_trades: usize,
    pub win_rate: f64,
    pub profit_factor: f64,
    pub max_drawdown_percent: f64,
    pub sharpe_ratio: f64,
    pub win_loss_ratio: f64,
    pub recommended_kelly_fraction: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestResult {
    pub strategy: String,
    pub initial_capital: f64,
    pub final_capital: f64,
    pub net_profit_percent: f64,
    pub metrics: BacktestMetrics,
    pub trades: Vec<BacktestTrade>,
}

fn calc_ema_trimmed(values: &[f64], period: usize) -> Vec<f64> {
    if values.len() < period || period == 0 {
        return Vec::new();
    }
    let k = 2.0 / (period as f64 + 1.0);
    let init: f64 = values[0..period].iter().sum::<f64>() / period as f64;
    let mut ema = Vec::with_capacity(values.len() - period + 1);
    ema.push(init);
    for i in period..values.len() {
        let prev = *ema.last().unwrap();
        ema.push(values[i] * k + prev * (1.0 - k));
    }
    ema
}

fn calc_rsi_trimmed(closes: &[f64], period: usize) -> Vec<f64> {
    if closes.len() < period + 1 || period == 0 {
        return Vec::new();
    }
    let mut gains = 0.0;
    let mut losses = 0.0;
    for i in 1..=period {
        let diff = closes[i] - closes[i - 1];
        if diff >= 0.0 {
            gains += diff;
        } else {
            losses -= diff;
        }
    }
    let p_f = period as f64;
    let mut avg_gain = gains / p_f;
    let mut avg_loss = losses / p_f;
    let mut rsi = Vec::with_capacity(closes.len() - period);
    rsi.push(100.0 - (100.0 / (1.0 + if avg_loss == 0.0 { 100.0 } else { avg_gain / avg_loss })));
    for i in (period + 1)..closes.len() {
        let diff = closes[i] - closes[i - 1];
        avg_gain = (avg_gain * (p_f - 1.0) + if diff > 0.0 { diff } else { 0.0 }) / p_f;
        avg_loss = (avg_loss * (p_f - 1.0) + if diff < 0.0 { -diff } else { 0.0 }) / p_f;
        let rs = if avg_loss == 0.0 { 100.0 } else { avg_gain / avg_loss };
        rsi.push(100.0 - (100.0 / (1.0 + rs)));
    }
    rsi
}

#[derive(Clone, Copy)]
enum SigKind {
    Buy,
    Sell,
}

struct SignalStep {
    time: f64,
    signal: Option<SigKind>,
    candle_idx: usize,
}

pub fn run_strategy_simulation(c: &CandleSlice<'_>, cfg: &BacktestConfig) -> BacktestResult {
    let strat_type = cfg
        .strat_type
        .clone()
        .unwrap_or_else(|| "supertrend".to_string());
    let initial_capital = cfg.initial_capital.unwrap_or(10000.0);
    let fee_percent = cfg.fee_percent.unwrap_or(0.05);
    let slippage_percent = cfg.slippage_percent.unwrap_or(0.02);
    let params = cfg.params.as_ref();

    let mut capital = initial_capital;
    let mut max_capital = initial_capital;
    let mut max_drawdown = 0.0;
    let mut trades: Vec<BacktestTrade> = Vec::new();

    let mut in_position = false;
    let mut pos_is_long = false;
    let mut entry_price = 0.0;
    let mut entry_time = 0.0;

    let lower_type = strat_type.to_lowercase();
    let mut signals: Vec<SignalStep> = Vec::new();

    if lower_type == "supertrend" {
        let period = params.and_then(|p| p.period).filter(|&x| x != 0).unwrap_or(10);
        let mult = params
            .and_then(|p| p.multiplier)
            .filter(|&x| x != 0.0)
            .unwrap_or(3.0);
        let st_series = calc_supertrend(c, period, mult);
        let offset = c.n - st_series.len();
        let mut prev_dir: Option<i32> = None;
        for (i, cur) in st_series.iter().enumerate() {
            let sig = match prev_dir {
                Some(pd) if cur.direction != pd => {
                    Some(if cur.direction == 1 { SigKind::Buy } else { SigKind::Sell })
                }
                _ => None,
            };
            prev_dir = Some(cur.direction);
            signals.push(SignalStep {
                time: cur.time,
                signal: sig,
                candle_idx: i + offset,
            });
        }
    } else if lower_type == "emacross" {
        let fast = params.and_then(|p| p.fast).filter(|&x| x != 0).unwrap_or(9);
        let slow = params.and_then(|p| p.slow).filter(|&x| x != 0).unwrap_or(21);
        let fast_ema = calc_ema_trimmed(c.closes, fast);
        let slow_ema = calc_ema_trimmed(c.closes, slow);
        let offset = slow - fast;
        for i in 1..slow_ema.len() {
            let prev_fast = fast_ema[i - 1 + offset];
            let cur_fast = fast_ema[i + offset];
            let prev_slow = slow_ema[i - 1];
            let cur_slow = slow_ema[i];
            let sig = if prev_fast <= prev_slow && cur_fast > cur_slow {
                Some(SigKind::Buy)
            } else if prev_fast >= prev_slow && cur_fast < cur_slow {
                Some(SigKind::Sell)
            } else {
                None
            };
            let idx = i + slow - 1;
            signals.push(SignalStep {
                time: c.times[idx],
                signal: sig,
                candle_idx: idx,
            });
        }
    } else if lower_type == "rsi" {
        let period = params.and_then(|p| p.period).filter(|&x| x != 0).unwrap_or(14);
        let oversold = params
            .and_then(|p| p.oversold)
            .filter(|&x| x != 0.0)
            .unwrap_or(30.0);
        let overbought = params
            .and_then(|p| p.overbought)
            .filter(|&x| x != 0.0)
            .unwrap_or(70.0);
        let rsi = calc_rsi_trimmed(c.closes, period);
        let offset = c.n - rsi.len();
        for i in 1..rsi.len() {
            let sig = if rsi[i - 1] <= oversold && rsi[i] > oversold {
                Some(SigKind::Buy)
            } else if rsi[i - 1] >= overbought && rsi[i] < overbought {
                Some(SigKind::Sell)
            } else {
                None
            };
            signals.push(SignalStep {
                time: c.times[i + offset],
                signal: sig,
                candle_idx: i + offset,
            });
        }
    } else {
        let st_series = calc_supertrend(c, 10, 3.0);
        let offset = c.n - st_series.len();
        let mut prev_dir: Option<i32> = None;
        for (i, cur) in st_series.iter().enumerate() {
            let sig = match prev_dir {
                Some(pd) if cur.direction != pd => {
                    Some(if cur.direction == 1 { SigKind::Buy } else { SigKind::Sell })
                }
                _ => None,
            };
            prev_dir = Some(cur.direction);
            signals.push(SignalStep {
                time: cur.time,
                signal: sig,
                candle_idx: i + offset,
            });
        }
    }

    for s in signals {
        if s.candle_idx >= c.n {
            continue;
        }
        let price = c.closes[s.candle_idx];
        match s.signal {
            Some(SigKind::Buy) => {
                if in_position && !pos_is_long {
                    let exit_price = price * (1.0 + slippage_percent / 100.0);
                    let pnl_percent =
                        (entry_price - exit_price) / entry_price - (fee_percent * 2.0 / 100.0);
                    let pnl_dollar = capital * pnl_percent;
                    capital += pnl_dollar;
                    trades.push(BacktestTrade {
                        trade_type: "SHORT",
                        entry_time,
                        exit_time: s.time,
                        entry_price,
                        exit_price,
                        pnl_percent: js_round(pnl_percent * 10000.0) / 100.0,
                        pnl_dollar: js_round(pnl_dollar * 100.0) / 100.0,
                        capital_after: js_round(capital * 100.0) / 100.0,
                    });
                    in_position = false;
                }
                if !in_position {
                    in_position = true;
                    pos_is_long = true;
                    entry_price = price * (1.0 + slippage_percent / 100.0);
                    entry_time = s.time;
                }
            }
            Some(SigKind::Sell) => {
                if in_position && pos_is_long {
                    let exit_price = price * (1.0 - slippage_percent / 100.0);
                    let pnl_percent =
                        (exit_price - entry_price) / entry_price - (fee_percent * 2.0 / 100.0);
                    let pnl_dollar = capital * pnl_percent;
                    capital += pnl_dollar;
                    trades.push(BacktestTrade {
                        trade_type: "LONG",
                        entry_time,
                        exit_time: s.time,
                        entry_price,
                        exit_price,
                        pnl_percent: js_round(pnl_percent * 10000.0) / 100.0,
                        pnl_dollar: js_round(pnl_dollar * 100.0) / 100.0,
                        capital_after: js_round(capital * 100.0) / 100.0,
                    });
                    in_position = false;
                }
                if !in_position {
                    in_position = true;
                    pos_is_long = false;
                    entry_price = price * (1.0 - slippage_percent / 100.0);
                    entry_time = s.time;
                }
            }
            None => {}
        }

        if capital > max_capital {
            max_capital = capital;
        }
        let current_dd = (max_capital - capital) / max_capital;
        if current_dd > max_drawdown {
            max_drawdown = current_dd;
        }
    }

    let total_trades = trades.len();
    let mut win_count = 0usize;
    let mut loss_count = 0usize;
    let mut gross_profit = 0.0;
    let mut loss_sum_signed = 0.0;

    for t in &trades {
        if t.pnl_percent > 0.0 {
            win_count += 1;
            gross_profit += t.pnl_dollar;
        } else if t.pnl_percent < 0.0 {
            loss_count += 1;
            loss_sum_signed += t.pnl_dollar;
        }
    }
    let gross_loss = loss_sum_signed.abs();

    let win_rate = if total_trades > 0 {
        (win_count as f64 / total_trades as f64) * 100.0
    } else {
        0.0
    };
    let profit_factor = if gross_loss > 0.0 {
        gross_profit / gross_loss
    } else if gross_profit > 0.0 {
        99.0
    } else {
        0.0
    };
    let avg_win = if win_count > 0 {
        gross_profit / win_count as f64
    } else {
        0.0
    };
    let avg_loss = if loss_count > 0 {
        gross_loss / loss_count as f64
    } else {
        1.0
    };
    let win_loss_ratio = if avg_loss > 0.0 {
        avg_win / avg_loss
    } else {
        1.0
    };

    let w_frac = win_rate / 100.0;
    let kelly = if win_loss_ratio > 0.0 {
        w_frac - ((1.0 - w_frac) / win_loss_ratio)
    } else {
        0.0
    };
    let safe_kelly = (kelly / 2.0).min(0.35).max(0.0);

    let mut sharpe = 0.0;
    if trades.len() > 1 {
        let n_r = trades.len() as f64;
        let mean_return: f64 = trades.iter().map(|t| t.pnl_percent / 100.0).sum::<f64>() / n_r;
        let variance: f64 = trades
            .iter()
            .map(|t| (t.pnl_percent / 100.0 - mean_return).powi(2))
            .sum::<f64>()
            / (n_r - 1.0);
        let std_dev = variance.sqrt();
        if std_dev > 0.0 {
            sharpe = (mean_return / std_dev) * 365.0f64.sqrt();
        }
    }

    let net_profit_percent = ((capital - initial_capital) / initial_capital) * 100.0;
    let tail_start = trades.len().saturating_sub(10);

    BacktestResult {
        strategy: strat_type,
        initial_capital,
        final_capital: round_dec(capital, 2),
        net_profit_percent: round_dec(net_profit_percent, 2),
        metrics: BacktestMetrics {
            total_trades,
            winning_trades: win_count,
            losing_trades: loss_count,
            win_rate: round_dec(win_rate, 1),
            profit_factor: round_dec(profit_factor, 2),
            max_drawdown_percent: round_dec(max_drawdown * 100.0, 2),
            sharpe_ratio: round_dec(sharpe, 2),
            win_loss_ratio: round_dec(win_loss_ratio, 2),
            recommended_kelly_fraction: round_dec(safe_kelly, 2),
        },
        trades: trades[tail_start..].to_vec(),
    }
}

struct WilsonOut {
    lo: f64,
    hi: f64,
    p_pct: String,
    ci_string: String,
}

fn wilson(k: usize, n: usize) -> Option<WilsonOut> {
    if n == 0 {
        return None;
    }
    const Z: f64 = 1.959963984540054;
    let n_f = n as f64;
    let p = k as f64 / n_f;
    let z2 = Z * Z;
    let denom = 1.0 + z2 / n_f;
    let center = (p + z2 / (2.0 * n_f)) / denom;
    let half = (Z * ((p * (1.0 - p)) / n_f + z2 / (4.0 * n_f * n_f)).sqrt()) / denom;
    let lo = (center - half).max(0.0);
    let hi = (center + half).min(1.0);
    Some(WilsonOut {
        lo,
        hi,
        p_pct: format!("{:.1}%", p * 100.0),
        ci_string: format!("[{:.1}%, {:.1}%]", lo * 100.0, hi * 100.0),
    })
}

fn summarize_dist(values: &[f64]) -> Option<(f64, f64, f64)> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let count = sorted.len();
    let quantile = |q: f64| -> f64 {
        let pos = (count - 1) as f64 * q;
        let base = pos.floor() as usize;
        let rest = pos - base as f64;
        if base + 1 < count {
            sorted[base] + rest * (sorted[base + 1] - sorted[base])
        } else {
            sorted[base]
        }
    };
    Some((
        round_dec(quantile(0.50), 1),
        round_dec(quantile(0.75), 1),
        round_dec(quantile(0.90), 1),
    ))
}

struct Session {
    date: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    bar_indices: Vec<usize>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum EdgeStatsResult {
    Error { error: &'static str },
    Ok(EdgeStatsOk),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMeta {
    pub total_bars: usize,
    pub total_sessions: usize,
    pub evaluated_date_range: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub current_price: f64,
    pub prev_close: f64,
    pub prev_high: f64,
    pub prev_low: f64,
    pub is_pdh_already_touched: bool,
    pub is_pdl_already_touched: bool,
    pub dist_to_pdh_pct: f64,
    pub dist_to_pdl_pct: f64,
    pub gap_pct: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TouchEdge {
    pub id: &'static str,
    pub title: &'static str,
    pub k: usize,
    pub n: usize,
    pub estimate: String,
    pub ci95: String,
    pub stability: &'static str,
    pub already_hit_today: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapEdge {
    pub id: &'static str,
    pub title: &'static str,
    pub k: usize,
    pub n: usize,
    pub estimate: String,
    pub ci95: String,
    pub time_distribution: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrbEdge {
    pub id: &'static str,
    pub title: &'static str,
    pub k: usize,
    pub n: usize,
    pub estimate: String,
    pub ci95: String,
    pub false_break_rate: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgesGroup {
    pub pdh_touch: TouchEdge,
    pub pdl_touch: TouchEdge,
    pub gap_fill: GapEdge,
    pub orb_continuation: OrbEdge,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeStatsOk {
    pub symbol_meta: SymbolMeta,
    pub live_session: LiveSession,
    pub edges: EdgesGroup,
    pub disclaimer: &'static str,
}

pub fn compute_edge_stats(c: &CandleSlice<'_>, current_price: Option<f64>) -> EdgeStatsResult {
    if c.n < 5 {
        return EdgeStatsResult::Error {
            error: "Insufficient sessions history for quantitative edge stats (needs >= 15 days)",
        };
    }

    let mut sessions: Vec<Session> = Vec::new();
    let mut date_map: HashMap<i64, usize> = HashMap::new();

    for i in 0..c.n {
        let secs = c.times[i] as i64;
        let day_id = secs.div_euclid(86400);
        if let Some(&idx) = date_map.get(&day_id) {
            let s = &mut sessions[idx];
            s.bar_indices.push(i);
            if c.highs[i] > s.high {
                s.high = c.highs[i];
            }
            if c.lows[i] < s.low {
                s.low = c.lows[i];
            }
            s.close = c.closes[i];
        } else {
            let idx = sessions.len();
            date_map.insert(day_id, idx);
            sessions.push(Session {
                date: format_date_from_sec(secs),
                open: c.opens[i],
                high: c.highs[i],
                low: c.lows[i],
                close: c.closes[i],
                bar_indices: vec![i],
            });
        }
    }

    if sessions.len() < 15 {
        return EdgeStatsResult::Error {
            error: "Insufficient sessions history for quantitative edge stats (needs >= 15 days)",
        };
    }

    struct Feature {
        has_gap: bool,
        gap_filled: bool,
        gap_fill_bars: Option<usize>,
        touched_pdh: bool,
        touched_pdl: bool,
        or_broke_up: bool,
        or_broke_down: bool,
    }

    let mut features = Vec::with_capacity(sessions.len() - 1);
    for i in 1..sessions.len() {
        let prev = &sessions[i - 1];
        let cur = &sessions[i];

        let gap_abs = cur.open - prev.close;
        let gap_pct = (gap_abs / prev.close) * 100.0;
        let abs_gap_pct = gap_pct.abs();

        let mut gap_filled = false;
        let mut gap_fill_bars: Option<usize> = None;
        if abs_gap_pct >= 0.15 {
            for (b_idx, &candle_idx) in cur.bar_indices.iter().enumerate() {
                if gap_pct > 0.0 && c.lows[candle_idx] <= prev.close {
                    gap_filled = true;
                    gap_fill_bars = Some(b_idx + 1);
                    break;
                } else if gap_pct < 0.0 && c.highs[candle_idx] >= prev.close {
                    gap_filled = true;
                    gap_fill_bars = Some(b_idx + 1);
                    break;
                }
            }
        }

        let touched_pdh = cur.high >= prev.high;
        let touched_pdl = cur.low <= prev.low;

        let (or_high, or_low) = if let Some(&first_idx) = cur.bar_indices.first() {
            (c.highs[first_idx], c.lows[first_idx])
        } else {
            (cur.high, cur.low)
        };
        let mut or_broke_up = false;
        let mut or_broke_down = false;
        for &candle_idx in cur.bar_indices.iter().skip(1) {
            if c.highs[candle_idx] > or_high {
                or_broke_up = true;
            }
            if c.lows[candle_idx] < or_low {
                or_broke_down = true;
            }
        }

        features.push(Feature {
            has_gap: abs_gap_pct >= 0.15,
            gap_filled,
            gap_fill_bars,
            touched_pdh,
            touched_pdl,
            or_broke_up,
            or_broke_down,
        });
    }

    let total_n = features.len();
    let half_n = total_n / 2;
    let first_half = &features[0..half_n];
    let second_half = &features[half_n..];

    let stability_text = |n1: usize, k1: usize, n2: usize, k2: usize| -> &'static str {
        match (wilson(k1, n1), wilson(k2, n2)) {
            (Some(w1), Some(w2)) => {
                if w1.lo <= w2.hi && w2.lo <= w1.hi {
                    "Stable (Halves agree ✓)"
                } else {
                    "Shifted (Halves diverge ✗)"
                }
            }
            _ => "Insufficient sample",
        }
    };

    let pdh_hits = features.iter().filter(|f| f.touched_pdh).count();
    let pdh_w = wilson(pdh_hits, total_n).unwrap();
    let pdh_h1 = first_half.iter().filter(|f| f.touched_pdh).count();
    let pdh_h2 = second_half.iter().filter(|f| f.touched_pdh).count();
    let pdh_stab = stability_text(first_half.len(), pdh_h1, second_half.len(), pdh_h2);

    let pdl_hits = features.iter().filter(|f| f.touched_pdl).count();
    let pdl_w = wilson(pdl_hits, total_n).unwrap();
    let pdl_h1 = first_half.iter().filter(|f| f.touched_pdl).count();
    let pdl_h2 = second_half.iter().filter(|f| f.touched_pdl).count();
    let pdl_stab = stability_text(first_half.len(), pdl_h1, second_half.len(), pdl_h2);

    let gap_n = features.iter().filter(|f| f.has_gap).count();
    let gap_fill_hits = features
        .iter()
        .filter(|f| f.has_gap && f.gap_filled)
        .count();
    let gap_w = wilson(gap_fill_hits, gap_n);
    let gap_fill_bars_list: Vec<f64> = features
        .iter()
        .filter(|f| f.has_gap && f.gap_filled)
        .filter_map(|f| f.gap_fill_bars.map(|b| b as f64))
        .collect();
    let gap_dist = summarize_dist(&gap_fill_bars_list);

    let orb_up_hits = features
        .iter()
        .filter(|f| f.or_broke_up && !f.or_broke_down)
        .count();
    let orb_both_hits = features
        .iter()
        .filter(|f| f.or_broke_up && f.or_broke_down)
        .count();
    let orb_up_w = wilson(orb_up_hits, total_n).unwrap();
    let orb_false_w = wilson(orb_both_hits, total_n).unwrap();

    let latest_prev = &sessions[sessions.len() - 2];
    let latest_cur = &sessions[sessions.len() - 1];
    let live_price = current_price
        .filter(|&p| p != 0.0 && p.is_finite())
        .unwrap_or(latest_cur.close);

    let dist_to_pdh_pct = ((latest_prev.high - live_price) / live_price) * 100.0;
    let dist_to_pdl_pct = ((live_price - latest_prev.low) / live_price) * 100.0;
    let current_gap_pct = ((latest_cur.open - latest_prev.close) / latest_prev.close) * 100.0;
    let is_pdh_touched = latest_cur.high >= latest_prev.high;
    let is_pdl_touched = latest_cur.low <= latest_prev.low;

    EdgeStatsResult::Ok(EdgeStatsOk {
        symbol_meta: SymbolMeta {
            total_bars: c.n,
            total_sessions: sessions.len(),
            evaluated_date_range: format!("{} → {}", sessions[0].date, latest_cur.date),
        },
        live_session: LiveSession {
            date: latest_cur.date.clone(),
            open: latest_cur.open,
            high: latest_cur.high,
            low: latest_cur.low,
            current_price: live_price,
            prev_close: latest_prev.close,
            prev_high: latest_prev.high,
            prev_low: latest_prev.low,
            is_pdh_already_touched: is_pdh_touched,
            is_pdl_already_touched: is_pdl_touched,
            dist_to_pdh_pct: to_fixed_num(dist_to_pdh_pct, 2),
            dist_to_pdl_pct: to_fixed_num(dist_to_pdl_pct, 2),
            gap_pct: to_fixed_num(current_gap_pct, 2),
        },
        edges: EdgesGroup {
            pdh_touch: TouchEdge {
                id: "prev-high-touch",
                title: "Touch Prior Day High (PDH)",
                k: pdh_hits,
                n: total_n,
                estimate: pdh_w.p_pct,
                ci95: pdh_w.ci_string,
                stability: pdh_stab,
                already_hit_today: is_pdh_touched,
            },
            pdl_touch: TouchEdge {
                id: "prev-low-touch",
                title: "Touch Prior Day Low (PDL)",
                k: pdl_hits,
                n: total_n,
                estimate: pdl_w.p_pct,
                ci95: pdl_w.ci_string,
                stability: pdl_stab,
                already_hit_today: is_pdl_touched,
            },
            gap_fill: GapEdge {
                id: "gap-fill",
                title: "Session Gap Fill Rate",
                k: gap_fill_hits,
                n: gap_n,
                estimate: gap_w
                    .as_ref()
                    .map(|w| w.p_pct.clone())
                    .unwrap_or_else(|| "N/A".to_string()),
                ci95: gap_w
                    .as_ref()
                    .map(|w| w.ci_string.clone())
                    .unwrap_or_else(|| "N/A".to_string()),
                time_distribution: match gap_dist {
                    Some((med, p75, p90)) => {
                        format!("Median: {} bars (P75: {}b, P90: {}b)", med, p75, p90)
                    }
                    None => "Insufficient gap samples".to_string(),
                },
            },
            orb_continuation: OrbEdge {
                id: "orb-continuation",
                title: "Opening Range Clean Expansion",
                k: orb_up_hits,
                n: total_n,
                estimate: orb_up_w.p_pct,
                ci95: orb_up_w.ci_string,
                false_break_rate: orb_false_w.p_pct,
            },
        },
        disclaimer: "Statistical conditional frequencies with 95% Wilson confidence intervals. Historical estimates, not predictions.",
    })
}
