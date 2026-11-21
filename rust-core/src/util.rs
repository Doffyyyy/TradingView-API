pub struct CandleSlice<'a> {
    pub times: &'a [f64],
    pub opens: &'a [f64],
    pub highs: &'a [f64],
    pub lows: &'a [f64],
    pub closes: &'a [f64],
    pub volumes: &'a [f64],
    pub n: usize,
}

impl<'a> CandleSlice<'a> {
    /// # Safety
    /// Caller must ensure `ptr` points to `6 * n` valid contiguous `f64` elements.
    pub unsafe fn from_raw(ptr: *const f64, n: usize) -> Self {
        if n == 0 || ptr.is_null() {
            return Self {
                times: &[],
                opens: &[],
                highs: &[],
                lows: &[],
                closes: &[],
                volumes: &[],
                n: 0,
            };
        }
        let buf = std::slice::from_raw_parts(ptr, n * 6);
        Self {
            times: &buf[0..n],
            opens: &buf[n..2 * n],
            highs: &buf[2 * n..3 * n],
            lows: &buf[3 * n..4 * n],
            closes: &buf[4 * n..5 * n],
            volumes: &buf[5 * n..6 * n],
            n,
        }
    }
}

/// Matches JS `Math.round(x)` (rounds half toward +Infinity).
#[inline]
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let r = (x + 0.5).floor();
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

#[inline]
pub fn round_dec(x: f64, decimals: i32) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let factor = 10f64.powi(decimals);
    let r = js_round(x * factor) / factor;
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

/// Matches JS `parseFloat(x.toFixed(decimals))` using fast arithmetic.
#[inline]
pub fn to_fixed_num(x: f64, decimals: usize) -> f64 {
    if !x.is_finite() {
        return 0.0;
    }
    let factor = match decimals {
        2 => 100.0,
        4 => 10000.0,
        _ => 10f64.powi(decimals as i32),
    };
    let v = (x * factor).round() / factor;
    if v == 0.0 {
        0.0
    } else {
        v
    }
}

/// Howard Hinnant's civil-from-days algorithm: converts days since 1970-01-01 to (year, month, day).
#[inline]
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

#[inline]
pub fn format_date_from_sec(secs: i64) -> String {
    let days = secs.div_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

#[inline]
pub fn format_iso_from_ms(ms: i64) -> String {
    let total_secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let days = total_secs.div_euclid(86400);
    let sec_of_day = total_secs.rem_euclid(86400) as u32;
    let hour = sec_of_day / 3600;
    let minute = (sec_of_day % 3600) / 60;
    let second = sec_of_day % 60;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, hour, minute, second, millis
    )
}
