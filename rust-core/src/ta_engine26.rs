use serde::Serialize;
use crate::util::{js_round, round_dec, CandleSlice};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorItem {
    pub name: String,
    pub value: f64,
    pub action: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsensusSummary {
    pub total: usize,
    pub buy: usize,
    pub neutral: usize,
    pub sell: usize,
    pub score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSummary {
    pub buy: usize,
    pub neutral: usize,
    pub sell: usize,
    pub score: f64,
    pub details: Vec<IndicatorItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ta26Result {
    pub symbol: String,
    pub price: f64,
    pub verdict: &'static str,
    pub trade_gate: &'static str,
    pub reason: String,
    pub consensus: ConsensusSummary,
    pub oscillators: GroupSummary,
    pub moving_averages: GroupSummary,
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

fn calc_sma_trimmed(values: &[f64], period: usize) -> Vec<f64> {
    if values.len() < period || period == 0 {
        return Vec::new();
    }
    let mut sma = Vec::with_capacity(values.len() - period + 1);
    let mut sum = 0.0;
    for i in 0..values.len() {
        sum += values[i];
        if i >= period {
            sum -= values[i - period];
        }
        if i >= period - 1 {
            sma.push(sum / period as f64);
        }
    }
    sma
}

fn calc_wma_trimmed(values: &[f64], period: usize) -> Vec<f64> {
    if values.len() < period || period == 0 {
        return Vec::new();
    }
    let mut wma = Vec::with_capacity(values.len() - period + 1);
    let denom = (period * (period + 1)) as f64 / 2.0;
    for i in (period - 1)..values.len() {
        let mut sum = 0.0;
        for j in 0..period {
            sum += values[i - (period - 1 - j)] * (j + 1) as f64;
        }
        wma.push(sum / denom);
    }
    wma
}

fn calc_hull_ma(values: &[f64], period: usize) -> Option<f64> {
    if values.len() < period {
        return None;
    }
    let half_period = period / 2;
    let sqrt_period = js_round((period as f64).sqrt()) as usize;
    let wma_half = calc_wma_trimmed(values, half_period);
    let wma_full = calc_wma_trimmed(values, period);
    let offset = period - half_period;
    let mut diff_series = Vec::with_capacity(wma_full.len());
    for i in 0..wma_full.len() {
        diff_series.push(2.0 * wma_half[i + offset] - wma_full[i]);
    }
    let hma = calc_wma_trimmed(&diff_series, sqrt_period);
    hma.last().copied()
}

fn calc_rsi_last(closes: &[f64], period: usize) -> f64 {
    if closes.len() < period + 1 {
        return 50.0;
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
    for i in (period + 1)..closes.len() {
        let diff = closes[i] - closes[i - 1];
        avg_gain = (avg_gain * (p_f - 1.0) + if diff > 0.0 { diff } else { 0.0 }) / p_f;
        avg_loss = (avg_loss * (p_f - 1.0) + if diff < 0.0 { -diff } else { 0.0 }) / p_f;
    }
    if avg_loss == 0.0 {
        return 100.0;
    }
    let rs = avg_gain / avg_loss;
    100.0 - (100.0 / (1.0 + rs))
}

fn calc_stochastic(c: &CandleSlice<'_>, period: usize, smooth_k: usize, smooth_d: usize) -> (f64, f64) {
    if c.n < period + smooth_k + smooth_d {
        return (50.0, 50.0);
    }
    let mut raw_k = Vec::with_capacity(c.n - period + 1);
    for i in (period - 1)..c.n {
        let mut highest = f64::NEG_INFINITY;
        let mut lowest = f64::INFINITY;
        for j in (i + 1 - period)..=i {
            if c.highs[j] > highest {
                highest = c.highs[j];
            }
            if c.lows[j] < lowest {
                lowest = c.lows[j];
            }
        }
        let close = c.closes[i];
        let val = if highest == lowest {
            50.0
        } else {
            ((close - lowest) / (highest - lowest)) * 100.0
        };
        raw_k.push(val);
    }
    let k_list = calc_sma_trimmed(&raw_k, smooth_k);
    let d_list = calc_sma_trimmed(&k_list, smooth_d);
    let k = k_list.last().copied().unwrap_or(50.0);
    let d = d_list.last().copied().unwrap_or(50.0);
    (k, d)
}

fn calc_cci(c: &CandleSlice<'_>, period: usize) -> f64 {
    if c.n < period {
        return 0.0;
    }
    let mut tp = Vec::with_capacity(c.n);
    for i in 0..c.n {
        tp.push((c.highs[i] + c.lows[i] + c.closes[i]) / 3.0);
    }
    let sma_tp = calc_sma_trimmed(&tp, period);
    let last_sma = *sma_tp.last().unwrap();
    let last_tp = *tp.last().unwrap();
    let mut mean_dev = 0.0;
    for i in (tp.len() - period)..tp.len() {
        mean_dev += (tp[i] - last_sma).abs();
    }
    mean_dev /= period as f64;
    if mean_dev == 0.0 {
        return 0.0;
    }
    (last_tp - last_sma) / (0.015 * mean_dev)
}

fn calc_adx(c: &CandleSlice<'_>, period: usize) -> (f64, f64, f64) {
    if c.n < period * 2 {
        return (20.0, 20.0, 20.0);
    }
    let len = c.n - 1;
    let mut tr = Vec::with_capacity(len);
    let mut plus_dm = Vec::with_capacity(len);
    let mut minus_dm = Vec::with_capacity(len);
    for i in 1..c.n {
        let hl = c.highs[i] - c.lows[i];
        let hc = (c.highs[i] - c.closes[i - 1]).abs();
        let lc = (c.lows[i] - c.closes[i - 1]).abs();
        tr.push(hl.max(hc).max(lc));
        let up_move = c.highs[i] - c.highs[i - 1];
        let down_move = c.lows[i - 1] - c.lows[i];
        plus_dm.push(if up_move > down_move && up_move > 0.0 {
            up_move
        } else {
            0.0
        });
        minus_dm.push(if down_move > up_move && down_move > 0.0 {
            down_move
        } else {
            0.0
        });
    }
    let p_f = period as f64;
    let mut tr_smooth: f64 = tr[0..period].iter().sum();
    let mut plus_smooth: f64 = plus_dm[0..period].iter().sum();
    let mut minus_smooth: f64 = minus_dm[0..period].iter().sum();
    let mut dx_list = Vec::with_capacity(len.saturating_sub(period));
    for i in period..len {
        tr_smooth = tr_smooth - (tr_smooth / p_f) + tr[i];
        plus_smooth = plus_smooth - (plus_smooth / p_f) + plus_dm[i];
        minus_smooth = minus_smooth - (minus_smooth / p_f) + minus_dm[i];
        let plus_di = if tr_smooth == 0.0 {
            0.0
        } else {
            (plus_smooth / tr_smooth) * 100.0
        };
        let minus_di = if tr_smooth == 0.0 {
            0.0
        } else {
            (minus_smooth / tr_smooth) * 100.0
        };
        let di_sum = plus_di + minus_di;
        let dx = if di_sum == 0.0 {
            0.0
        } else {
            ((plus_di - minus_di).abs() / di_sum) * 100.0
        };
        dx_list.push(dx);
    }
    let adx = if dx_list.len() >= period {
        dx_list[dx_list.len() - period..].iter().sum::<f64>() / p_f
    } else {
        20.0
    };
    let plus_di = if tr_smooth == 0.0 {
        0.0
    } else {
        (plus_smooth / tr_smooth) * 100.0
    };
    let minus_di = if tr_smooth == 0.0 {
        0.0
    } else {
        (minus_smooth / tr_smooth) * 100.0
    };
    (adx, plus_di, minus_di)
}

fn calc_ao(c: &CandleSlice<'_>) -> f64 {
    if c.n < 34 {
        return 0.0;
    }
    let mut medians = Vec::with_capacity(c.n);
    for i in 0..c.n {
        medians.push((c.highs[i] + c.lows[i]) / 2.0);
    }
    let sma5 = calc_sma_trimmed(&medians, 5);
    let sma34 = calc_sma_trimmed(&medians, 34);
    if sma5.is_empty() || sma34.is_empty() {
        return 0.0;
    }
    sma5.last().unwrap() - sma34.last().unwrap()
}

fn calc_momentum(closes: &[f64], period: usize) -> f64 {
    if closes.len() < period + 1 {
        return 0.0;
    }
    closes[closes.len() - 1] - closes[closes.len() - 1 - period]
}

fn calc_macd(closes: &[f64], fast: usize, slow: usize, signal: usize) -> (f64, f64) {
    if closes.len() < slow + signal {
        return (0.0, 0.0);
    }
    let fast_ema = calc_ema_trimmed(closes, fast);
    let slow_ema = calc_ema_trimmed(closes, slow);
    let offset = slow - fast;
    let mut macd_line = Vec::with_capacity(slow_ema.len());
    for i in 0..slow_ema.len() {
        macd_line.push(fast_ema[i + offset] - slow_ema[i]);
    }
    let sig_line = calc_ema_trimmed(&macd_line, signal);
    (
        macd_line.last().copied().unwrap_or(0.0),
        sig_line.last().copied().unwrap_or(0.0),
    )
}

fn calc_williams_r(c: &CandleSlice<'_>, period: usize) -> f64 {
    if c.n < period {
        return -50.0;
    }
    let mut hh = f64::NEG_INFINITY;
    let mut ll = f64::INFINITY;
    for i in (c.n - period)..c.n {
        if c.highs[i] > hh {
            hh = c.highs[i];
        }
        if c.lows[i] < ll {
            ll = c.lows[i];
        }
    }
    let close = c.closes[c.n - 1];
    if hh == ll {
        return -50.0;
    }
    ((hh - close) / (hh - ll)) * -100.0
}

fn calc_bb_power(c: &CandleSlice<'_>, period: usize) -> f64 {
    if c.n < period {
        return 0.0;
    }
    let ema = calc_ema_trimmed(c.closes, period);
    let last_ema = *ema.last().unwrap();
    let last_high = c.highs[c.n - 1];
    let last_low = c.lows[c.n - 1];
    (last_high - last_ema) + (last_low - last_ema)
}

fn calc_ultimate_osc(c: &CandleSlice<'_>) -> f64 {
    if c.n < 29 {
        return 50.0;
    }
    let mut bp = Vec::with_capacity(c.n - 1);
    let mut tr = Vec::with_capacity(c.n - 1);
    for i in 1..c.n {
        let true_low = c.lows[i].min(c.closes[i - 1]);
        let true_high = c.highs[i].max(c.closes[i - 1]);
        bp.push(c.closes[i] - true_low);
        tr.push(true_high - true_low);
    }
    let m = bp.len();
    let sum7_bp: f64 = bp[m - 7..].iter().sum();
    let sum7_tr: f64 = tr[m - 7..].iter().sum();
    let sum14_bp: f64 = bp[m - 14..].iter().sum();
    let sum14_tr: f64 = tr[m - 14..].iter().sum();
    let sum28_bp: f64 = bp[m - 28..].iter().sum();
    let sum28_tr: f64 = tr[m - 28..].iter().sum();

    let a1 = if sum7_tr == 0.0 { 0.5 } else { sum7_bp / sum7_tr };
    let a2 = if sum14_tr == 0.0 { 0.5 } else { sum14_bp / sum14_tr };
    let a3 = if sum28_tr == 0.0 { 0.5 } else { sum28_bp / sum28_tr };
    100.0 * ((4.0 * a1) + (2.0 * a2) + a3) / 7.0
}

fn calc_vwma(c: &CandleSlice<'_>, period: usize) -> Option<f64> {
    if c.n < period {
        return None;
    }
    let mut pv_sum = 0.0;
    let mut vol_sum = 0.0;
    for i in (c.n - period)..c.n {
        let vol = if c.volumes[i] != 0.0 { c.volumes[i] } else { 1.0 };
        pv_sum += c.closes[i] * vol;
        vol_sum += vol;
    }
    Some(if vol_sum == 0.0 {
        c.closes[c.n - 1]
    } else {
        pv_sum / vol_sum
    })
}

fn calc_ichimoku_base_line(c: &CandleSlice<'_>, period: usize) -> Option<f64> {
    if c.n < period {
        return None;
    }
    let mut hh = f64::NEG_INFINITY;
    let mut ll = f64::INFINITY;
    for i in (c.n - period)..c.n {
        if c.highs[i] > hh {
            hh = c.highs[i];
        }
        if c.lows[i] < ll {
            ll = c.lows[i];
        }
    }
    Some((hh + ll) / 2.0)
}

pub fn compute_26_indicators(symbol: &str, c: &CandleSlice<'_>) -> Result<Ta26Result, &'static str> {
    if c.n < 35 {
        return Err("Insufficient candle history");
    }
    let current_price = c.closes[c.n - 1];

    let mut osc_list = Vec::with_capacity(11);
    let mut osc_buy = 0usize;
    let mut osc_neutral = 0usize;
    let mut osc_sell = 0usize;

    let mut add_osc = |name: &str, val: f64, action: &'static str| {
        match action {
            "BUY" => osc_buy += 1,
            "SELL" => osc_sell += 1,
            _ => osc_neutral += 1,
        }
        osc_list.push(IndicatorItem {
            name: name.to_string(),
            value: round_dec(val, 2),
            action,
        });
    };

    let rsi = calc_rsi_last(c.closes, 14);
    add_osc(
        "RSI (14)",
        rsi,
        if rsi < 30.0 {
            "BUY"
        } else if rsi > 70.0 {
            "SELL"
        } else {
            "NEUTRAL"
        },
    );

    let (stoch_k, stoch_d) = calc_stochastic(c, 14, 3, 3);
    add_osc(
        "Stochastic %K",
        stoch_k,
        if stoch_k < 20.0 && stoch_k > stoch_d {
            "BUY"
        } else if stoch_k > 80.0 && stoch_k < stoch_d {
            "SELL"
        } else {
            "NEUTRAL"
        },
    );

    let cci = calc_cci(c, 20);
    add_osc(
        "CCI (20)",
        cci,
        if cci < -100.0 {
            "BUY"
        } else if cci > 100.0 {
            "SELL"
        } else {
            "NEUTRAL"
        },
    );

    let (adx, plus_di, minus_di) = calc_adx(c, 14);
    add_osc(
        "ADX (14)",
        adx,
        if adx > 25.0 && plus_di > minus_di {
            "BUY"
        } else if adx > 25.0 && minus_di > plus_di {
            "SELL"
        } else {
            "NEUTRAL"
        },
    );

    let ao = calc_ao(c);
    add_osc(
        "Awesome Oscillator",
        ao,
        if ao > 0.0 {
            "BUY"
        } else if ao < 0.0 {
            "SELL"
        } else {
            "NEUTRAL"
        },
    );

    let mom = calc_momentum(c.closes, 10);
    add_osc(
        "Momentum (10)",
        mom,
        if mom > 0.0 {
            "BUY"
        } else if mom < 0.0 {
            "SELL"
        } else {
            "NEUTRAL"
        },
    );

    let (macd_val, macd_sig) = calc_macd(c.closes, 12, 26, 9);
    add_osc(
        "MACD (12, 26)",
        macd_val,
        if macd_val > macd_sig { "BUY" } else { "SELL" },
    );

    add_osc(
        "Stochastic RSI",
        rsi,
        if rsi < 20.0 {
            "BUY"
        } else if rsi > 80.0 {
            "SELL"
        } else {
            "NEUTRAL"
        },
    );

    let wr = calc_williams_r(c, 14);
    add_osc(
        "Williams %R",
        wr,
        if wr < -80.0 {
            "BUY"
        } else if wr > -20.0 {
            "SELL"
        } else {
            "NEUTRAL"
        },
    );

    let bb_power = calc_bb_power(c, 13);
    add_osc(
        "Bull Bear Power",
        bb_power,
        if bb_power > 0.0 { "BUY" } else { "SELL" },
    );

    let uo = calc_ultimate_osc(c);
    add_osc(
        "Ultimate Oscillator",
        uo,
        if uo < 30.0 {
            "BUY"
        } else if uo > 70.0 {
            "SELL"
        } else {
            "NEUTRAL"
        },
    );

    let mut ma_list = Vec::with_capacity(15);
    let mut ma_buy = 0usize;
    let mut ma_neutral = 0usize;
    let mut ma_sell = 0usize;

    let mut add_ma = |name: String, val: f64| {
        if val.is_nan() {
            return;
        }
        let action = if current_price > val {
            "BUY"
        } else if current_price < val {
            "SELL"
        } else {
            "NEUTRAL"
        };
        match action {
            "BUY" => ma_buy += 1,
            "SELL" => ma_sell += 1,
            _ => ma_neutral += 1,
        }
        ma_list.push(IndicatorItem {
            name,
            value: round_dec(val, 2),
            action,
        });
    };

    for &p in &[10usize, 20, 30, 50, 100, 200] {
        let ema_series = calc_ema_trimmed(c.closes, p);
        if let Some(&v) = ema_series.last() {
            add_ma(format!("EMA{}", p), v);
        }
        let sma_series = calc_sma_trimmed(c.closes, p);
        if let Some(&v) = sma_series.last() {
            add_ma(format!("SMA{}", p), v);
        }
    }

    if let Some(ichi) = calc_ichimoku_base_line(c, 26) {
        if ichi != 0.0 && !ichi.is_nan() {
            add_ma("Ichimoku Base Line".to_string(), ichi);
        }
    }
    if let Some(vwma) = calc_vwma(c, 20) {
        if vwma != 0.0 && !vwma.is_nan() {
            add_ma("VWMA".to_string(), vwma);
        }
    }
    if let Some(hull) = calc_hull_ma(c.closes, 9) {
        if hull != 0.0 && !hull.is_nan() {
            add_ma("Hull MA (9)".to_string(), hull);
        }
    }

    let total_buy = osc_buy + ma_buy;
    let total_neutral = osc_neutral + ma_neutral;
    let total_sell = osc_sell + ma_sell;
    let total_count = total_buy + total_neutral + total_sell;

    let score_all = if total_count > 0 {
        (total_buy as f64 - total_sell as f64) / total_count as f64
    } else {
        0.0
    };
    let verdict = if score_all >= 0.5 {
        "STRONG_BUY"
    } else if score_all > 0.1 {
        "BUY"
    } else if score_all <= -0.5 {
        "STRONG_SELL"
    } else if score_all < -0.1 {
        "SELL"
    } else {
        "NEUTRAL"
    };

    let (trade_gate, reason) = if total_buy >= 15 && total_sell <= 4 {
        (
            "ALLOW_LONG",
            format!(
                "Strong consensus with {}/{} indicators in BUY agreement.",
                total_buy, total_count
            ),
        )
    } else if total_sell >= 15 && total_buy <= 4 {
        (
            "ALLOW_SHORT",
            format!(
                "Strong consensus with {}/{} indicators in SELL agreement.",
                total_sell, total_count
            ),
        )
    } else {
        (
            "HOLD_VETO",
            format!(
                "Insufficient consensus ({} Buy vs {} Sell). Capital risk vetoed.",
                total_buy, total_sell
            ),
        )
    };

    let osc_score = if !osc_list.is_empty() {
        round_dec((osc_buy as f64 - osc_sell as f64) / osc_list.len() as f64, 3)
    } else {
        0.0
    };
    let ma_score = if !ma_list.is_empty() {
        round_dec((ma_buy as f64 - ma_sell as f64) / ma_list.len() as f64, 3)
    } else {
        0.0
    };

    Ok(Ta26Result {
        symbol: symbol.to_string(),
        price: current_price,
        verdict,
        trade_gate,
        reason,
        consensus: ConsensusSummary {
            total: total_count,
            buy: total_buy,
            neutral: total_neutral,
            sell: total_sell,
            score: round_dec(score_all, 3),
        },
        oscillators: GroupSummary {
            buy: osc_buy,
            neutral: osc_neutral,
            sell: osc_sell,
            score: osc_score,
            details: osc_list,
        },
        moving_averages: GroupSummary {
            buy: ma_buy,
            neutral: ma_neutral,
            sell: ma_sell,
            score: ma_score,
            details: ma_list,
        },
    })
}
