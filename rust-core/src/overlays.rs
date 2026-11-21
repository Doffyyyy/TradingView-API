use serde::{Deserialize, Serialize};
use crate::util::{to_fixed_num, CandleSlice};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartTrailPoint {
    pub time: f64,
    pub trail: f64,
    pub direction: &'static str,
    pub color: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReversalZonePoint {
    pub time: f64,
    pub base: f64,
    pub upper_outer: f64,
    pub upper_inner: f64,
    pub lower_inner: f64,
    pub lower_outer: f64,
    pub current_price: f64,
    pub is_overbought: bool,
    pub is_extreme_overbought: bool,
    pub is_oversold: bool,
    pub is_extreme_oversold: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuxSignal {
    pub time: f64,
    pub price: f64,
    #[serde(rename = "type")]
    pub sig_type: &'static str,
    pub is_strong: bool,
    pub label: &'static str,
    pub color: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuxLatestState {
    pub trail_direction: &'static str,
    pub trail_price: Option<f64>,
    pub in_reversal_zone: &'static str,
    pub last_signal: Option<LuxSignal>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuxAlgoResult {
    pub smart_trail: Vec<SmartTrailPoint>,
    pub reversal_zones: Vec<ReversalZonePoint>,
    pub signals: Vec<LuxSignal>,
    pub latest_state: LuxLatestState,
}

fn calc_super_smoother(src: &[f64], length: usize) -> Vec<f64> {
    let len = length.max(5) as f64;
    let pi = std::f64::consts::PI;
    let a1 = (-std::f64::consts::SQRT_2 * pi / len).exp();
    let b1 = 2.0 * a1 * (std::f64::consts::SQRT_2 * pi / len).cos();
    let c2 = b1;
    let c3 = -a1 * a1;
    let c1 = 1.0 - c2 - c3;

    let mut out = vec![src.first().copied().unwrap_or(0.0); src.len()];
    if src.len() > 1 {
        out[1] = src[1];
    }
    for i in 2..src.len() {
        out[i] = c1 * src[i] + c2 * out[i - 1] + c3 * out[i - 2];
    }
    out
}

fn calc_tr(c: &CandleSlice<'_>) -> Vec<f64> {
    let mut tr = vec![0.0; c.n];
    if c.n == 0 {
        return tr;
    }
    tr[0] = c.highs[0] - c.lows[0];
    for i in 1..c.n {
        let hl = c.highs[i] - c.lows[i];
        let hc = (c.highs[i] - c.closes[i - 1]).abs();
        let lc = (c.lows[i] - c.closes[i - 1]).abs();
        tr[i] = hl.max(hc).max(lc);
    }
    tr
}

fn calc_wilder_ma(values: &[f64], length: usize) -> Vec<f64> {
    let mut out = vec![0.0; values.len()];
    if values.len() < length || length == 0 {
        return out;
    }
    let sum: f64 = values[0..length].iter().sum();
    let l_f = length as f64;
    out[length - 1] = sum / l_f;
    for i in length..values.len() {
        out[i] = (out[i - 1] * (l_f - 1.0) + values[i]) / l_f;
    }
    out
}

fn calc_ema_zero_padded(values: &[f64], length: usize) -> Vec<f64> {
    let mut out = vec![0.0; values.len()];
    if values.len() < length || length == 0 {
        return out;
    }
    let k = 2.0 / (length as f64 + 1.0);
    let sum: f64 = values[0..length].iter().sum();
    out[length - 1] = sum / length as f64;
    for i in length..values.len() {
        out[i] = values[i] * k + out[i - 1] * (1.0 - k);
    }
    out
}

pub fn evaluate_luxalgo_overlays(c: &CandleSlice<'_>) -> LuxAlgoResult {
    let atr_period = 10usize;
    let atr_factor = 4.0f64;
    let smoothing = 8usize;

    let smart_trail = if c.n < atr_period + smoothing {
        Vec::new()
    } else {
        let tr = calc_tr(c);
        let atr = calc_wilder_ma(&tr, atr_period);
        let smoothed_closes = calc_ema_zero_padded(c.closes, smoothing);

        let mut trail = smoothed_closes[0];
        let mut direction = 1i32;
        let mut result = Vec::with_capacity(c.n);

        for i in 0..c.n {
            let atr_val = if atr[i] != 0.0 {
                atr[i]
            } else {
                c.highs[i] - c.lows[i]
            };
            let loss = atr_factor * atr_val;
            let src = if smoothed_closes[i] != 0.0 {
                smoothed_closes[i]
            } else {
                c.closes[i]
            };

            if direction == 1 {
                trail = trail.max(src - loss);
                if c.closes[i] < trail {
                    direction = -1;
                    trail = src + loss;
                }
            } else {
                trail = trail.min(src + loss);
                if c.closes[i] > trail {
                    direction = 1;
                    trail = src - loss;
                }
            }

            result.push(SmartTrailPoint {
                time: c.times[i],
                trail: to_fixed_num(trail, 4),
                direction: if direction == 1 { "BULL" } else { "BEAR" },
                color: if direction == 1 { "#2157f9" } else { "#ef5350" },
            });
        }
        result
    };

    let rz_len = 100usize;
    let inner_mult = 1.0f64;
    let outer_mult = 2.415f64;
    let reversal_zones = if c.n < 20 {
        Vec::new()
    } else {
        let mut hlc3 = Vec::with_capacity(c.n);
        for i in 0..c.n {
            hlc3.push((c.highs[i] + c.lows[i] + c.closes[i]) / 3.0);
        }
        let smooth = calc_super_smoother(&hlc3, rz_len);
        let lookback = rz_len.min(60);
        let mut result = Vec::with_capacity(c.n);

        for i in 0..c.n {
            let base = smooth[i];
            let start = (i + 1).saturating_sub(lookback);
            let count = (i - start + 1) as f64;
            let mut variance = 0.0;
            for j in start..=i {
                let diff = hlc3[j] - smooth[j];
                variance += diff * diff;
            }
            let raw_std = (variance / count).sqrt();
            let std_dev = if raw_std != 0.0 { raw_std } else { base * 0.01 };

            let upper_outer = base + std_dev * outer_mult;
            let upper_inner = base + std_dev * inner_mult;
            let lower_inner = base - std_dev * inner_mult;
            let lower_outer = base - std_dev * outer_mult;

            result.push(ReversalZonePoint {
                time: c.times[i],
                base: to_fixed_num(base, 4),
                upper_outer: to_fixed_num(upper_outer, 4),
                upper_inner: to_fixed_num(upper_inner, 4),
                lower_inner: to_fixed_num(lower_inner, 4),
                lower_outer: to_fixed_num(lower_outer, 4),
                current_price: c.closes[i],
                is_overbought: c.highs[i] >= upper_inner,
                is_extreme_overbought: c.highs[i] >= upper_outer,
                is_oversold: c.lows[i] <= lower_inner,
                is_extreme_oversold: c.lows[i] <= lower_outer,
            });
        }
        result
    };

    let signals = if c.n == 0 || smart_trail.len() < 5 {
        Vec::new()
    } else {
        let mut sigs = Vec::new();
        let mut prev_dir = smart_trail[0].direction;
        for i in 1..c.n {
            let cur_dir = smart_trail[i].direction;
            let rz = reversal_zones.get(i);
            let mut sig_type: Option<&'static str> = None;
            let mut is_strong = false;

            if prev_dir == "BEAR" && cur_dir == "BULL" {
                sig_type = Some("BUY");
                if let Some(z) = rz {
                    if z.is_oversold || c.lows[i] <= z.lower_inner {
                        is_strong = true;
                    }
                }
            } else if prev_dir == "BULL" && cur_dir == "BEAR" {
                sig_type = Some("SELL");
                if let Some(z) = rz {
                    if z.is_overbought || c.highs[i] >= z.upper_inner {
                        is_strong = true;
                    }
                }
            }

            if let Some(st) = sig_type {
                sigs.push(LuxSignal {
                    time: c.times[i],
                    price: c.closes[i],
                    sig_type: st,
                    is_strong,
                    label: if is_strong {
                        if st == "BUY" {
                            "BUY +"
                        } else {
                            "SELL +"
                        }
                    } else {
                        st
                    },
                    color: if st == "BUY" { "#26a69a" } else { "#ef5350" },
                });
            }
            prev_dir = cur_dir;
        }
        sigs
    };

    let latest_trail = smart_trail.last();
    let latest_rz = reversal_zones.last();
    let last_signal = signals.last().map(|s| LuxSignal {
        time: s.time,
        price: s.price,
        sig_type: s.sig_type,
        is_strong: s.is_strong,
        label: s.label,
        color: s.color,
    });

    LuxAlgoResult {
        latest_state: LuxLatestState {
            trail_direction: latest_trail.map(|t| t.direction).unwrap_or("NEUTRAL"),
            trail_price: latest_trail.map(|t| t.trail),
            in_reversal_zone: match latest_rz {
                Some(rz) if rz.is_overbought => "OVERBOUGHT",
                Some(rz) if rz.is_oversold => "OVERSOLD",
                _ => "NEUTRAL",
            },
            last_signal,
        },
        smart_trail,
        reversal_zones,
        signals,
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Ema30Options {
    pub len_band: Option<usize>,
    pub len200: Option<usize>,
    pub use_trend: Option<bool>,
    pub use_close: Option<bool>,
    pub use_short: Option<bool>,
    pub rev_on: Option<bool>,
    pub rev_bars: Option<usize>,
    pub min_vol_ratio: Option<f64>,
    pub use_volume_filter: Option<bool>,
    pub min_slope_threshold: Option<f64>,
}

#[derive(Serialize)]
pub struct TimeValPoint {
    pub time: f64,
    pub value: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ema30Signal {
    pub time: f64,
    pub index: usize,
    #[serde(rename = "type")]
    pub sig_type: &'static str,
    pub is_reversal: bool,
    pub price: f64,
    pub stop_loss: f64,
    pub take_profit: f64,
    pub volume_ratio: f64,
    pub is_volume_confirmed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_peak: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_trough: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ema30LatestState {
    pub current_zone: &'static str,
    pub ema_h: f64,
    pub ema_l: f64,
    pub ema200: f64,
    pub prev_peak: Option<f64>,
    pub prev_trough: Option<f64>,
    pub band_width_pct: f64,
    pub last_direction: &'static str,
    pub last_signal: Option<Ema30Signal>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ema30Result {
    pub ema_h_series: Vec<TimeValPoint>,
    pub ema_l_series: Vec<TimeValPoint>,
    pub ema200_series: Vec<TimeValPoint>,
    pub prev_peak_series: Vec<TimeValPoint>,
    pub prev_trough_series: Vec<TimeValPoint>,
    pub signals: Vec<Ema30Signal>,
    pub latest_state: Ema30LatestState,
}

fn calc_ema_init(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    let mut ema = vec![0.0; n];
    if n == 0 || period == 0 {
        return ema;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let init_count = period.min(n);
    let sum: f64 = values[0..init_count].iter().sum();
    ema[init_count - 1] = sum / init_count as f64;
    for i in init_count..n {
        ema[i] = values[i] * k + ema[i - 1] * (1.0 - k);
    }
    ema
}

fn calc_sma_init(values: &[f64], period: usize) -> Vec<f64> {
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

fn calc_atr_init(c: &CandleSlice<'_>, period: usize) -> Vec<f64> {
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
    let tr_sum: f64 = tr[0..init_count].iter().sum();
    atr[init_count - 1] = tr_sum / init_count as f64;
    let p_f = period as f64;
    for i in init_count..n {
        atr[i] = (atr[i - 1] * (p_f - 1.0) + tr[i]) / p_f;
    }
    atr
}

pub fn evaluate_ema30_band_breakout(c: &CandleSlice<'_>, opt: &Ema30Options) -> Option<Ema30Result> {
    let len_band = opt.len_band.filter(|&x| x != 0).unwrap_or(30);
    let len200 = opt.len200.filter(|&x| x != 0).unwrap_or(200);
    let use_trend = opt.use_trend.unwrap_or(true);
    let use_close = opt.use_close.unwrap_or(true);
    let use_short = opt.use_short.unwrap_or(true);
    let rev_on = opt.rev_on.unwrap_or(true);
    let rev_bars = opt.rev_bars.filter(|&x| x != 0).unwrap_or(2);
    let min_vol_ratio = opt.min_vol_ratio.filter(|&x| x != 0.0).unwrap_or(1.15);
    let use_volume_filter = opt.use_volume_filter.unwrap_or(true);
    let min_slope_threshold = opt.min_slope_threshold.filter(|&x| x != 0.0).unwrap_or(0.00005);

    let n = c.n;
    if n < len_band.max(35) {
        return None;
    }

    let ema_h = calc_ema_init(c.highs, len_band);
    let ema_l = calc_ema_init(c.lows, len_band);
    let ema200 = calc_ema_init(c.closes, len200);
    let vol_sma = calc_sma_init(c.volumes, 20);
    let atr = calc_atr_init(c, 14);

    let mut ema_h_series = Vec::with_capacity(n);
    let mut ema_l_series = Vec::with_capacity(n);
    let mut ema200_series = Vec::with_capacity(n.saturating_sub(len200.saturating_sub(1)));
    let mut prev_peak_series = Vec::new();
    let mut prev_trough_series = Vec::new();
    let mut signals = Vec::new();

    let mut cur_peak: Option<f64> = None;
    let mut prev_peak: Option<f64> = None;
    let mut cur_trough: Option<f64> = None;
    let mut prev_trough: Option<f64> = None;
    let mut last_dir: i32 = 0;

    for i in 0..n {
        let time = c.times[i];
        let close = c.closes[i];
        let high = c.highs[i];
        let low = c.lows[i];
        let e_h = ema_h[i];
        let e_l = ema_l[i];
        let e200 = ema200[i];
        let cur_atr = atr[i];
        let cur_vol = c.volumes[i];
        let avg_vol = vol_sma[i];
        let volume_ratio = if avg_vol > 0.0 { cur_vol / avg_vol } else { 1.0 };

        ema_h_series.push(TimeValPoint {
            time,
            value: to_fixed_num(e_h, 4),
        });
        ema_l_series.push(TimeValPoint {
            time,
            value: to_fixed_num(e_l, 4),
        });
        if i >= len200 - 1 {
            ema200_series.push(TimeValPoint {
                time,
                value: to_fixed_num(e200, 4),
            });
        }

        let above_band = close > e_h;
        let below_band = close < e_l;

        if above_band {
            cur_peak = Some(match cur_peak {
                Some(cp) => cp.max(high),
                None => high,
            });
        } else if cur_peak.is_some() {
            prev_peak = cur_peak;
            cur_peak = None;
        }

        if below_band {
            cur_trough = Some(match cur_trough {
                Some(ct) => ct.min(low),
                None => low,
            });
        } else if cur_trough.is_some() {
            prev_trough = cur_trough;
            cur_trough = None;
        }

        if let Some(pp) = prev_peak {
            prev_peak_series.push(TimeValPoint {
                time,
                value: to_fixed_num(pp, 4),
            });
        }
        if let Some(pt) = prev_trough {
            prev_trough_series.push(TimeValPoint {
                time,
                value: to_fixed_num(pt, 4),
            });
        }

        let brk_up = match prev_peak {
            Some(pp) => {
                if use_close {
                    close > pp
                } else {
                    high > pp
                }
            }
            None => false,
        };
        let brk_down = match prev_trough {
            Some(pt) => {
                if use_close {
                    close < pt
                } else {
                    low < pt
                }
            }
            None => false,
        };

        let mut ema200_slope = 0.0;
        if i >= 5 && ema200[i - 5] > 0.0 {
            ema200_slope = (e200 - ema200[i - 5]) / (ema200[i - 5] * 5.0);
        }
        let is_ema200_flat = ema200_slope.abs() < min_slope_threshold;

        let trend_up =
            (!use_trend || close > e200) && (!use_trend || !is_ema200_flat || close > e_h * 1.002);
        let trend_down =
            (!use_trend || close < e200) && (!use_trend || !is_ema200_flat || close < e_l * 0.998);

        let mut below_cnt = 0usize;
        let mut above_cnt = 0usize;
        for k in 0..rev_bars {
            if i >= k {
                let idx = i - k;
                if c.closes[idx] < ema_l[idx] {
                    below_cnt += 1;
                }
                if c.closes[idx] > ema_h[idx] {
                    above_cnt += 1;
                }
            }
        }

        let rev_short = rev_on && use_short && last_dir == 1 && below_cnt == rev_bars && trend_down;
        let rev_long = rev_on && use_short && last_dir == -1 && above_cnt == rev_bars && trend_up;

        let is_vol_confirmed = !use_volume_filter || volume_ratio >= min_vol_ratio;

        let long_breakout =
            above_band && prev_peak.is_some() && brk_up && trend_up && (last_dir <= 0 || !use_short);
        let short_breakout =
            use_short && below_band && prev_trough.is_some() && brk_down && trend_down && last_dir >= 0;

        let long_sig = (long_breakout && is_vol_confirmed) || rev_long;
        let short_sig = (short_breakout && is_vol_confirmed) || rev_short;

        if long_sig {
            last_dir = 1;
            let sl = to_fixed_num(e_l.min(close - cur_atr * 1.5), 4);
            let stop_dist = (close * 0.008).max(close - sl);
            let tp = to_fixed_num(close + stop_dist * 2.0, 4);
            signals.push(Ema30Signal {
                time,
                index: i,
                sig_type: "LONG",
                is_reversal: rev_long,
                price: close,
                stop_loss: sl,
                take_profit: tp,
                volume_ratio: to_fixed_num(volume_ratio, 2),
                is_volume_confirmed: volume_ratio >= min_vol_ratio,
                prev_peak,
                prev_trough: None,
            });
        } else if short_sig {
            last_dir = -1;
            let sl = to_fixed_num(e_h.max(close + cur_atr * 1.5), 4);
            let stop_dist = (close * 0.008).max(sl - close);
            let tp = to_fixed_num(close - stop_dist * 2.0, 4);
            signals.push(Ema30Signal {
                time,
                index: i,
                sig_type: "SHORT",
                is_reversal: rev_short,
                price: close,
                stop_loss: sl,
                take_profit: tp,
                volume_ratio: to_fixed_num(volume_ratio, 2),
                is_volume_confirmed: volume_ratio >= min_vol_ratio,
                prev_peak: None,
                prev_trough,
            });
        }
    }

    let last_idx = n - 1;
    let last_close = c.closes[last_idx];
    let last_ema_h = ema_h[last_idx];
    let last_ema_l = ema_l[last_idx];
    let last_ema200 = ema200[last_idx];
    let band_width_pct = if last_close > 0.0 {
        (last_ema_h - last_ema_l) / last_close
    } else {
        0.0
    };
    let current_zone = if last_close > last_ema_h {
        "ABOVE_BAND"
    } else if last_close < last_ema_l {
        "BELOW_BAND"
    } else {
        "INSIDE_BAND"
    };
    let last_signal = signals.last().cloned();

    Some(Ema30Result {
        ema_h_series,
        ema_l_series,
        ema200_series,
        prev_peak_series,
        prev_trough_series,
        latest_state: Ema30LatestState {
            current_zone,
            ema_h: to_fixed_num(last_ema_h, 4),
            ema_l: to_fixed_num(last_ema_l, 4),
            ema200: to_fixed_num(last_ema200, 4),
            prev_peak,
            prev_trough,
            band_width_pct: to_fixed_num(band_width_pct * 100.0, 2),
            last_direction: if last_dir == 1 {
                "LONG"
            } else if last_dir == -1 {
                "SHORT"
            } else {
                "NEUTRAL"
            },
            last_signal,
        },
        signals,
    })
}
