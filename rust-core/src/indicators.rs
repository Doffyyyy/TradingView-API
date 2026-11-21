use serde::Serialize;
use crate::util::{js_round, round_dec, CandleSlice};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupertrendPoint {
    pub time: f64,
    pub supertrend: f64,
    pub direction: i32,
    pub trend: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GaltonProfile {
    pub buy_ratio: f64,
    pub sell_ratio: f64,
    pub flow_delta: f64,
    pub poc_price: f64,
    pub vah_price: f64,
    pub val_price: f64,
    pub current_price: f64,
    pub is_above_poc: bool,
    pub is_within_value_area: bool,
    pub price_vs_poc_percent: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeFootprint {
    pub buy_imb_count: usize,
    pub sell_imb_count: usize,
    pub has_bearish_absorption_top: bool,
    pub has_bullish_absorption_bottom: bool,
    pub ovl_score: f64,
    pub market_structure: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RlmSignal {
    #[serde(rename = "type")]
    pub sig_type: &'static str,
    pub level_price: f64,
    pub level_score: f64,
    pub polarity: bool,
    pub touches: usize,
    pub entry: f64,
    pub sl: f64,
    pub tp1: f64,
    pub tp2: f64,
    pub tp3: f64,
    pub risk: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RlmNearest {
    pub center: f64,
    pub half_width: f64,
    pub score: f64,
    pub distance_pct: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RlmLevelOut {
    pub center: f64,
    pub half_width: f64,
    pub score: f64,
    pub touches: usize,
    pub polarity: bool,
    pub breaks: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RlmResult {
    pub last_close: f64,
    pub atr14: f64,
    pub htf_ema50: f64,
    pub htf_bias: &'static str,
    pub nearest_support: Option<RlmNearest>,
    pub nearest_resistance: Option<RlmNearest>,
    pub supports: Vec<RlmLevelOut>,
    pub resistances: Vec<RlmLevelOut>,
    pub signal: Option<RlmSignal>,
    pub trend: &'static str,
}

pub fn calc_supertrend(c: &CandleSlice<'_>, period: usize, multiplier: f64) -> Vec<SupertrendPoint> {
    if c.n < period || period == 0 {
        return Vec::new();
    }
    let mut tr = Vec::with_capacity(c.n);
    tr.push(c.highs[0] - c.lows[0]);
    for i in 1..c.n {
        let hl = c.highs[i] - c.lows[i];
        let hc = (c.highs[i] - c.closes[i - 1]).abs();
        let lc = (c.lows[i] - c.closes[i - 1]).abs();
        tr.push(hl.max(hc).max(lc));
    }

    let p_f = period as f64;
    let mut atr = Vec::with_capacity(c.n - period + 1);
    let init_sum: f64 = tr[0..period].iter().sum();
    atr.push(init_sum / p_f);
    for i in period..c.n {
        let prev = *atr.last().unwrap();
        atr.push((prev * (p_f - 1.0) + tr[i]) / p_f);
    }

    let mut results = Vec::with_capacity(c.n - (period - 1));
    let mut upper_band = 0.0;
    let mut lower_band = 0.0;
    let mut trend = 1i32;

    for i in (period - 1)..c.n {
        let cur_atr = atr[i - (period - 1)];
        let hl2 = (c.highs[i] + c.lows[i]) / 2.0;
        let basic_upper = hl2 + multiplier * cur_atr;
        let basic_lower = hl2 - multiplier * cur_atr;

        if i == period - 1 {
            upper_band = basic_upper;
            lower_band = basic_lower;
            trend = if c.closes[i] > upper_band { 1 } else { -1 };
        } else {
            let prev_upper = upper_band;
            let prev_lower = lower_band;
            let prev_close = c.closes[i - 1];

            lower_band = if basic_lower > prev_lower || prev_close < prev_lower {
                basic_lower
            } else {
                prev_lower
            };
            upper_band = if basic_upper < prev_upper || prev_close > prev_upper {
                basic_upper
            } else {
                prev_upper
            };

            if trend == 1 && c.closes[i] < lower_band {
                trend = -1;
            } else if trend == -1 && c.closes[i] > upper_band {
                trend = 1;
            }
        }
        results.push(SupertrendPoint {
            time: c.times[i],
            supertrend: if trend == 1 { lower_band } else { upper_band },
            direction: trend,
            trend: if trend == 1 { "BUY" } else { "SELL" },
        });
    }
    results
}

#[inline]
fn normal_cdf(z: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.2316419 * z.abs());
    let d = 0.3989422804014327 * (-z * z / 2.0).exp();
    let prob = d
        * t
        * (0.319381530
            + t * (-0.356563782
                + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    if z > 0.0 {
        1.0 - prob
    } else {
        prob
    }
}

pub fn calc_galton_volume_profile(c: &CandleSlice<'_>, period: usize) -> Option<GaltonProfile> {
    if c.n < 5 {
        return None;
    }
    let slice_len = c.n.min(period);
    let offset = c.n - slice_len;
    let highs = &c.highs[offset..];
    let lows = &c.lows[offset..];
    let closes = &c.closes[offset..];
    let opens = &c.opens[offset..];
    let volumes = &c.volumes[offset..];

    let dp_count = slice_len.saturating_sub(1).max(1) as f64;
    let mut dp_sum = 0.0;
    for i in 1..slice_len {
        dp_sum += closes[i] - closes[i - 1];
    }
    let mean_dp = dp_sum / dp_count;
    let mut var_sum = 0.0;
    for i in 1..slice_len {
        let diff = (closes[i] - closes[i - 1]) - mean_dp;
        var_sum += diff * diff;
    }
    let mut std_dp = (var_sum / dp_count).sqrt();
    if std_dp == 0.0 {
        std_dp = 0.0001;
    }

    let mut min_low = f64::INFINITY;
    let mut max_high = f64::NEG_INFINITY;
    for i in 0..slice_len {
        if lows[i] < min_low {
            min_low = lows[i];
        }
        if highs[i] > max_high {
            max_high = highs[i];
        }
    }
    if max_high <= min_low {
        return None;
    }

    const BIN_COUNT: usize = 30;
    let bin_step = (max_high - min_low) / BIN_COUNT as f64;
    let mut buy_bins = [0.0f64; BIN_COUNT];
    let mut sell_bins = [0.0f64; BIN_COUNT];
    let mut total_buy_vol = 0.0;
    let mut total_sell_vol = 0.0;
    let mut weights = [0.0f64; BIN_COUNT];

    for i in 0..slice_len {
        let prev_c = if i > 0 { closes[i - 1] } else { opens[i] };
        let vol = if volumes[i] != 0.0 { volumes[i] } else { 1.0 };
        let dp = closes[i] - prev_c;
        let z = dp / std_dp;
        let buy_ratio = normal_cdf(z).clamp(0.01, 0.99);
        let buy_vol = vol * buy_ratio;
        let sell_vol = vol * (1.0 - buy_ratio);
        total_buy_vol += buy_vol;
        total_sell_vol += sell_vol;

        let candle_spread = (highs[i] - lows[i]).max(bin_step) / 3.0;
        let two_sig_sq = 2.0 * candle_spread * candle_spread;

        let mut sum_w = 0.0;
        for k in 0..BIN_COUNT {
            let bin_center = min_low + (k as f64 + 0.5) * bin_step;
            if bin_center >= lows[i] - bin_step && bin_center <= highs[i] + bin_step {
                let dist = bin_center - closes[i];
                let w = (-(dist * dist) / two_sig_sq).exp();
                weights[k] = w;
                sum_w += w;
            } else {
                weights[k] = 0.0;
            }
        }
        if sum_w > 0.0 {
            for k in 0..BIN_COUNT {
                if weights[k] > 0.0 {
                    let norm_w = weights[k] / sum_w;
                    buy_bins[k] += buy_vol * norm_w;
                    sell_bins[k] += sell_vol * norm_w;
                }
            }
        }
    }

    let mut max_bin_vol = -1.0;
    let mut poc_idx = 0usize;
    let mut tot_bins = [0.0f64; BIN_COUNT];
    let mut sum_period_vol = 0.0;
    for k in 0..BIN_COUNT {
        tot_bins[k] = buy_bins[k] + sell_bins[k];
        sum_period_vol += tot_bins[k];
        if tot_bins[k] > max_bin_vol {
            max_bin_vol = tot_bins[k];
            poc_idx = k;
        }
    }
    let poc_price = min_low + (poc_idx as f64 + 0.5) * bin_step;

    let target_va = sum_period_vol * 0.70;
    let mut va_vol = tot_bins[poc_idx];
    let mut up_idx = poc_idx;
    let mut down_idx = poc_idx;
    while va_vol < target_va && (up_idx < BIN_COUNT - 1 || down_idx > 0) {
        let next_up = if up_idx < BIN_COUNT - 1 {
            tot_bins[up_idx + 1]
        } else {
            0.0
        };
        let next_down = if down_idx > 0 {
            tot_bins[down_idx - 1]
        } else {
            0.0
        };
        if next_up >= next_down && up_idx < BIN_COUNT - 1 {
            up_idx += 1;
            va_vol += tot_bins[up_idx];
        } else if down_idx > 0 {
            down_idx -= 1;
            va_vol += tot_bins[down_idx];
        } else if up_idx < BIN_COUNT - 1 {
            up_idx += 1;
            va_vol += tot_bins[up_idx];
        } else {
            break;
        }
    }

    let val_price = min_low + (down_idx as f64 + 0.5) * bin_step;
    let vah_price = min_low + (up_idx as f64 + 0.5) * bin_step;
    let current_price = closes[slice_len - 1];
    let total_vol = (total_buy_vol + total_sell_vol).max(1.0);
    let buy_ratio = total_buy_vol / total_vol;
    let sell_ratio = total_sell_vol / total_vol;

    Some(GaltonProfile {
        buy_ratio: round_dec(buy_ratio, 3),
        sell_ratio: round_dec(sell_ratio, 3),
        flow_delta: js_round(total_buy_vol - total_sell_vol),
        poc_price: round_dec(poc_price, 2),
        vah_price: round_dec(vah_price, 2),
        val_price: round_dec(val_price, 2),
        current_price,
        is_above_poc: current_price >= poc_price,
        is_within_value_area: current_price >= val_price && current_price <= vah_price,
        price_vs_poc_percent: round_dec(((current_price - poc_price) / poc_price) * 100.0, 2),
    })
}

pub fn calc_volume_footprint(
    c: &CandleSlice<'_>,
    window_bars: usize,
    imbalance_ratio: f64,
) -> Option<VolumeFootprint> {
    if c.n < 3 {
        return None;
    }
    let slice_len = c.n.min(window_bars);
    let offset = c.n - slice_len;
    let highs = &c.highs[offset..];
    let lows = &c.lows[offset..];
    let closes = &c.closes[offset..];
    let volumes = &c.volumes[offset..];

    let mut min_low = f64::INFINITY;
    let mut max_high = f64::NEG_INFINITY;
    for i in 0..slice_len {
        if lows[i] < min_low {
            min_low = lows[i];
        }
        if highs[i] > max_high {
            max_high = highs[i];
        }
    }
    if max_high <= min_low {
        return None;
    }

    const ROW_COUNT: usize = 20;
    let row_step = (max_high - min_low) / ROW_COUNT as f64;
    let mut row_buys = [0.0f64; ROW_COUNT];
    let mut row_sells = [0.0f64; ROW_COUNT];
    let mut weights = [0.0f64; ROW_COUNT];

    for i in 0..slice_len {
        let vol = if volumes[i] != 0.0 { volumes[i] } else { 1.0 };
        let r = highs[i] - lows[i];
        let b_r = if r > 0.0 {
            (closes[i] - lows[i]) / r
        } else {
            0.5
        };
        let b_v = vol * b_r;
        let s_v = vol * (1.0 - b_r);
        let sigma = r.max(row_step) / 3.0;
        let two_sig_sq = 2.0 * sigma * sigma;

        let mut sum_w = 0.0;
        for r_idx in 0..ROW_COUNT {
            let price = min_low + (r_idx as f64 + 0.5) * row_step;
            if price >= lows[i] - row_step && price <= highs[i] + row_step {
                let dist = price - closes[i];
                let w = (-(dist * dist) / two_sig_sq).exp();
                weights[r_idx] = w;
                sum_w += w;
            } else {
                weights[r_idx] = 0.0;
            }
        }
        if sum_w > 0.0 {
            for r_idx in 0..ROW_COUNT {
                if weights[r_idx] > 0.0 {
                    let norm_w = weights[r_idx] / sum_w;
                    row_buys[r_idx] += b_v * norm_w;
                    row_sells[r_idx] += s_v * norm_w;
                }
            }
        }
    }

    let mut buy_imb_count = 0usize;
    let mut sell_imb_count = 0usize;
    let mut has_bearish_absorption_top = false;
    let mut has_bullish_absorption_bottom = false;

    for r_idx in 1..ROW_COUNT {
        if row_buys[r_idx] > (row_sells[r_idx - 1] * imbalance_ratio) && row_buys[r_idx] > 10.0 {
            buy_imb_count += 1;
            if r_idx <= 4 {
                has_bullish_absorption_bottom = true;
            }
        }
        if row_sells[r_idx - 1] > (row_buys[r_idx] * imbalance_ratio) && row_sells[r_idx - 1] > 10.0 {
            sell_imb_count += 1;
            if r_idx >= ROW_COUNT - 4 {
                has_bearish_absorption_top = true;
            }
        }
    }

    let mut overlap_min = 0.0;
    let mut overlap_max = 0.0;
    for r_idx in 0..ROW_COUNT {
        overlap_min += row_buys[r_idx].min(row_sells[r_idx]);
        overlap_max += row_buys[r_idx].max(row_sells[r_idx]);
    }
    let ovl_score = if overlap_max > 0.0 {
        overlap_min / overlap_max
    } else {
        1.0
    };

    Some(VolumeFootprint {
        buy_imb_count,
        sell_imb_count,
        has_bearish_absorption_top,
        has_bullish_absorption_bottom,
        ovl_score: round_dec(ovl_score, 2),
        market_structure: if ovl_score < 0.48 {
            "DIRECTIONAL"
        } else if ovl_score > 0.72 {
            "CHOPPY_ROTATION"
        } else {
            "BALANCED"
        },
    })
}

fn calc_rma_padded(src: &[f64], len: usize) -> Vec<f64> {
    let init: f64 = src[0..len].iter().sum::<f64>() / len as f64;
    let alpha = 1.0 / len as f64;
    let mut out = Vec::with_capacity(src.len());
    out.resize(len - 1, init);
    out.push(init);
    for i in len..src.len() {
        let prev = *out.last().unwrap();
        out.push(alpha * src[i] + (1.0 - alpha) * prev);
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Support,
    Resistance,
}

struct StoredLevel {
    sum_w: f64,
    sum_wp: f64,
    sum_wp2: f64,
    center: f64,
    half_width: f64,
    strength: f64,
    high_touches: usize,
    low_touches: usize,
    total_touches: usize,
    breaks: usize,
    role: Role,
    polarity: bool,
    score: f64,
}

fn add_swing(
    stored: &mut Vec<StoredLevel>,
    price: f64,
    w: f64,
    is_high: bool,
    cur_atr: f64,
    cur_close: f64,
    tol_ratio: f64,
) {
    let tol = tol_ratio * cur_atr;
    let mut nearest_idx: Option<usize> = None;
    let mut min_dist = f64::INFINITY;
    for (idx, l) in stored.iter().enumerate() {
        let dist = (l.center - price).abs();
        if dist <= tol && dist < min_dist {
            min_dist = dist;
            nearest_idx = Some(idx);
        }
    }

    if let Some(mut idx) = nearest_idx {
        {
            let nearest = &mut stored[idx];
            nearest.sum_w += w;
            nearest.sum_wp += w * price;
            nearest.sum_wp2 += w * price * price;
            nearest.strength += w;
            if is_high {
                nearest.high_touches += 1;
            } else {
                nearest.low_touches += 1;
            }
            nearest.total_touches += 1;
            let m = nearest.sum_wp / nearest.sum_w;
            let vr = (nearest.sum_wp2 / nearest.sum_w) - (m * m);
            let hw = tol.min((0.15 * cur_atr).max(vr.max(0.0).sqrt()));
            nearest.center = m;
            nearest.half_width = hw;
        }

        let mut again = true;
        let mut passes = 0;
        while again && passes < 5 {
            again = false;
            passes += 1;
            let t_hi = stored[idx].center + stored[idx].half_width;
            let t_lo = stored[idx].center - stored[idx].half_width;
            let mut k = stored.len();
            while k > 0 {
                k -= 1;
                if k == idx {
                    continue;
                }
                let o_hi = stored[k].center + stored[k].half_width;
                let o_lo = stored[k].center - stored[k].half_width;
                if o_lo <= t_hi && t_lo <= o_hi {
                    let o = stored.remove(k);
                    if k < idx {
                        idx -= 1;
                    }
                    let nearest = &mut stored[idx];
                    nearest.sum_w += o.sum_w;
                    nearest.sum_wp += o.sum_wp;
                    nearest.sum_wp2 += o.sum_wp2;
                    nearest.strength += o.strength;
                    nearest.total_touches += o.total_touches;
                    nearest.high_touches += o.high_touches;
                    nearest.low_touches += o.low_touches;
                    nearest.breaks = nearest.breaks.max(o.breaks);
                    let m_merged = nearest.sum_wp / nearest.sum_w;
                    let vr_merged = (nearest.sum_wp2 / nearest.sum_w) - (m_merged * m_merged);
                    nearest.center = m_merged;
                    nearest.half_width =
                        tol.min((0.15 * cur_atr).max(vr_merged.max(0.0).sqrt()));
                    again = true;
                }
            }
        }
    } else {
        stored.push(StoredLevel {
            sum_w: w,
            sum_wp: w * price,
            sum_wp2: w * price * price,
            center: price,
            half_width: tol.min((0.15 * cur_atr).max(0.25 * cur_atr)),
            strength: w,
            high_touches: if is_high { 1 } else { 0 },
            low_touches: if is_high { 0 } else { 1 },
            total_touches: 1,
            breaks: 0,
            role: if cur_close >= price {
                Role::Support
            } else {
                Role::Resistance
            },
            polarity: false,
            score: 0.0,
        });
        if stored.len() > 60 {
            stored.sort_by(|a, b| b.strength.total_cmp(&a.strength));
            stored.pop();
        }
    }
}

pub fn calc_reaction_level_matrix(
    c: &CandleSlice<'_>,
    swing_len: usize,
    tol_ratio: f64,
    half_life: f64,
    min_score: f64,
    levels_per_side: usize,
) -> Option<RlmResult> {
    let n = c.n;
    if n < 35 {
        return None;
    }

    let mut tr = Vec::with_capacity(n);
    tr.push(c.highs[0] - c.lows[0]);
    for i in 1..n {
        let hl = c.highs[i] - c.lows[i];
        let hc = (c.highs[i] - c.closes[i - 1]).abs();
        let lc = (c.lows[i] - c.closes[i - 1]).abs();
        tr.push(hl.max(hc).max(lc));
    }
    let atr34 = calc_rma_padded(&tr, 34);
    let atr14 = calc_rma_padded(&tr, 14);
    let decay_factor = 0.5f64.powf(1.0 / half_life);

    let mut stored_levels: Vec<StoredLevel> = Vec::new();
    for t in 0..n {
        let cur_atr = if atr34[t] != 0.0 { atr34[t] } else { 1.0 };
        let cur_close = c.closes[t];
        let prev_close = if t > 0 { c.closes[t - 1] } else { cur_close };

        for l in &mut stored_levels {
            l.strength *= decay_factor;
            let top = l.center + l.half_width;
            let btm = l.center - l.half_width;
            if l.role == Role::Support && prev_close >= btm && cur_close < btm {
                l.role = Role::Resistance;
                l.breaks += 1;
                l.strength *= 0.7;
            } else if l.role == Role::Resistance && prev_close <= top && cur_close > top {
                l.role = Role::Support;
                l.breaks += 1;
                l.strength *= 0.7;
            }
        }
        stored_levels.retain(|l| l.strength >= 0.25);

        if t >= 2 * swing_len {
            let swing_idx = t - swing_len;
            let sh_high = c.highs[swing_idx];
            let sh_low = c.lows[swing_idx];
            let mut is_high = true;
            let mut is_low = true;
            for k in 1..=swing_len {
                if c.highs[swing_idx - k] >= sh_high || c.highs[swing_idx + k] > sh_high {
                    is_high = false;
                }
                if c.lows[swing_idx - k] <= sh_low || c.lows[swing_idx + k] < sh_low {
                    is_low = false;
                }
            }
            let sw_atr = if atr34[swing_idx] != 0.0 {
                atr34[swing_idx]
            } else {
                1.0
            };
            if is_high {
                let mut lowest_low = f64::INFINITY;
                for k in 1..=swing_len {
                    lowest_low = lowest_low.min(c.lows[swing_idx + k]);
                }
                let reaction = (sh_high - lowest_low) / sw_atr;
                let w = 1.0 + reaction.max(0.0).min(2.5);
                add_swing(
                    &mut stored_levels,
                    sh_high,
                    w,
                    true,
                    cur_atr,
                    cur_close,
                    tol_ratio,
                );
            }
            if is_low {
                let mut highest_high = f64::NEG_INFINITY;
                for k in 1..=swing_len {
                    highest_high = highest_high.max(c.highs[swing_idx + k]);
                }
                let reaction = (highest_high - sh_low) / sw_atr;
                let w = 1.0 + reaction.max(0.0).min(2.5);
                add_swing(
                    &mut stored_levels,
                    sh_low,
                    w,
                    false,
                    cur_atr,
                    cur_close,
                    tol_ratio,
                );
            }
        }
    }

    let last_close = c.closes[n - 1];
    let current_atr14 = if atr14[n - 1] != 0.0 {
        atr14[n - 1]
    } else {
        1.0
    };

    for l in &mut stored_levels {
        let pol = l.high_touches > 0 && l.low_touches > 0;
        let polarity_bonus = if pol { 1.25 } else { 1.0 };
        l.polarity = pol;
        let raw_score = (100.0 * (1.0 - (-l.strength * polarity_bonus / 6.0).exp()))
            .max(0.0)
            .min(100.0);
        l.score = js_round(raw_score);
    }

    let mut resistances: Vec<&StoredLevel> = stored_levels
        .iter()
        .filter(|l| l.total_touches >= 2 && l.center > last_close)
        .collect();
    resistances.sort_by(|a, b| (a.center - last_close).total_cmp(&(b.center - last_close)));
    resistances.truncate(levels_per_side);

    let mut supports: Vec<&StoredLevel> = stored_levels
        .iter()
        .filter(|l| l.total_touches >= 2 && l.center < last_close)
        .collect();
    supports.sort_by(|a, b| (last_close - a.center).total_cmp(&(last_close - b.center)));
    supports.truncate(levels_per_side);

    let last_high = c.highs[n - 1];
    let last_low = c.lows[n - 1];
    let bar_range = last_high - last_low;
    let mut signal: Option<RlmSignal> = None;

    for &sup in &supports {
        if sup.score >= min_score {
            let top = sup.center + sup.half_width;
            if last_low <= top
                && last_close > top
                && bar_range > 0.0
                && ((last_close - last_low) / bar_range >= 0.6)
            {
                let sl = (last_low - 0.25 * current_atr14).min(last_close - 0.5 * current_atr14);
                let risk = (last_close - sl).max(0.0001);
                signal = Some(RlmSignal {
                    sig_type: "LONG",
                    level_price: sup.center,
                    level_score: sup.score,
                    polarity: sup.polarity,
                    touches: sup.total_touches,
                    entry: last_close,
                    sl,
                    tp1: last_close + 1.0 * risk,
                    tp2: last_close + 2.0 * risk,
                    tp3: last_close + 3.0 * risk,
                    risk,
                });
                break;
            }
        }
    }

    if signal.is_none() {
        for &res in &resistances {
            if res.score >= min_score {
                let btm = res.center - res.half_width;
                if last_high >= btm
                    && last_close < btm
                    && bar_range > 0.0
                    && ((last_high - last_close) / bar_range >= 0.6)
                {
                    let sl =
                        (last_high + 0.25 * current_atr14).max(last_close + 0.5 * current_atr14);
                    let risk = (sl - last_close).max(0.0001);
                    signal = Some(RlmSignal {
                        sig_type: "SHORT",
                        level_price: res.center,
                        level_score: res.score,
                        polarity: res.polarity,
                        touches: res.total_touches,
                        entry: last_close,
                        sl,
                        tp1: last_close - 1.0 * risk,
                        tp2: last_close - 2.0 * risk,
                        tp3: last_close - 3.0 * risk,
                        risk,
                    });
                    break;
                }
            }
        }
    }

    let mut sorted_sup = supports.clone();
    sorted_sup.sort_by(|a, b| b.center.total_cmp(&a.center));
    let mut sorted_res = resistances.clone();
    sorted_res.sort_by(|a, b| a.center.total_cmp(&b.center));

    let nearest_support = sorted_sup.first().map(|s| RlmNearest {
        center: s.center,
        half_width: s.half_width,
        score: s.score,
        distance_pct: ((last_close - s.center) / last_close) * 100.0,
    });
    let nearest_resistance = sorted_res.first().map(|r| RlmNearest {
        center: r.center,
        half_width: r.half_width,
        score: r.score,
        distance_pct: ((r.center - last_close) / last_close) * 100.0,
    });

    // calcEMA(closes, 50)
    let htf_ema50 = if c.n >= 50 {
        let k = 2.0 / 51.0;
        let mut ema = c.closes[0..50].iter().sum::<f64>() / 50.0;
        for i in 50..c.n {
            ema = c.closes[i] * k + ema * (1.0 - k);
        }
        ema
    } else {
        last_close
    };
    let htf_bias = if last_close >= htf_ema50 {
        "BULLISH"
    } else {
        "BEARISH"
    };

    let trend = if supports.len() > resistances.len() {
        "BULLISH"
    } else if resistances.len() > supports.len() {
        "BEARISH"
    } else {
        "NEUTRAL"
    };

    Some(RlmResult {
        last_close,
        atr14: current_atr14,
        htf_ema50,
        htf_bias,
        nearest_support,
        nearest_resistance,
        supports: supports
            .iter()
            .map(|s| RlmLevelOut {
                center: s.center,
                half_width: s.half_width,
                score: s.score,
                touches: s.total_touches,
                polarity: s.polarity,
                breaks: s.breaks,
            })
            .collect(),
        resistances: resistances
            .iter()
            .map(|r| RlmLevelOut {
                center: r.center,
                half_width: r.half_width,
                score: r.score,
                touches: r.total_touches,
                polarity: r.polarity,
                breaks: r.breaks,
            })
            .collect(),
        signal,
        trend,
    })
}
