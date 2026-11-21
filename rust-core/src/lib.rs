mod backtest_stats;
mod indicators;
mod overlays;
mod strategy_v2;
mod ta_engine26;
mod util;

use std::alloc::{alloc, dealloc, Layout};
use util::CandleSlice;

static mut OUT_BUF: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn ping() -> i32 {
    1
}

#[no_mangle]
pub extern "C" fn alloc_u8(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let layout = Layout::from_size_align(len, 1).unwrap();
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc_u8(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let layout = Layout::from_size_align(len, 1).unwrap();
    unsafe { dealloc(ptr, layout) }
}

#[no_mangle]
pub extern "C" fn alloc_f64(len: usize) -> *mut f64 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let layout = Layout::array::<f64>(len).unwrap();
    unsafe { alloc(layout) as *mut f64 }
}

#[no_mangle]
pub extern "C" fn dealloc_f64(ptr: *mut f64, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let layout = Layout::array::<f64>(len).unwrap();
    unsafe { dealloc(ptr as *mut u8, layout) }
}

#[no_mangle]
pub extern "C" fn last_out_ptr() -> *const u8 {
    unsafe {
        let ptr = &raw const OUT_BUF;
        (*ptr).as_ptr()
    }
}

#[no_mangle]
pub extern "C" fn last_out_len() -> usize {
    unsafe {
        let ptr = &raw const OUT_BUF;
        (*ptr).len()
    }
}

fn set_output_json<T: serde::Serialize>(val: &T) -> i32 {
    match serde_json::to_vec(val) {
        Ok(bytes) => {
            unsafe {
                let ptr = &raw mut OUT_BUF;
                *ptr = bytes;
            }
            0
        }
        Err(_) => -1,
    }
}

unsafe fn read_utf8<'a>(ptr: *const u8, len: usize) -> &'a str {
    if ptr.is_null() || len == 0 {
        return "";
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    std::str::from_utf8(slice).unwrap_or("")
}

#[no_mangle]
pub extern "C" fn wasm_run_strategy_v2(
    meta_ptr: *const u8,
    meta_len: usize,
    data_ptr: *const f64,
    data_len: usize,
) -> i32 {
    let meta_str = unsafe { read_utf8(meta_ptr, meta_len) };
    let Ok(meta) = serde_json::from_str::<strategy_v2::StrategyRunMeta>(meta_str) else {
        return -1;
    };
    let data = if data_ptr.is_null() || data_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(data_ptr, data_len) }
    };
    let res = strategy_v2::run_strategy_v2(&meta, data);
    set_output_json(&res)
}

#[no_mangle]
pub extern "C" fn wasm_compute_26_indicators(
    sym_ptr: *const u8,
    sym_len: usize,
    candles_ptr: *const f64,
    n: usize,
) -> i32 {
    let sym = unsafe { read_utf8(sym_ptr, sym_len) };
    let c = unsafe { CandleSlice::from_raw(candles_ptr, n) };
    match ta_engine26::compute_26_indicators(sym, &c) {
        Ok(res) => set_output_json(&res),
        Err(_) => -2,
    }
}

#[no_mangle]
pub extern "C" fn wasm_calc_supertrend(
    candles_ptr: *const f64,
    n: usize,
    period: usize,
    multiplier: f64,
) -> i32 {
    let c = unsafe { CandleSlice::from_raw(candles_ptr, n) };
    let res = indicators::calc_supertrend(&c, period, multiplier);
    set_output_json(&res)
}

#[no_mangle]
pub extern "C" fn wasm_calc_galton_volume_profile(
    candles_ptr: *const f64,
    n: usize,
    period: usize,
) -> i32 {
    let c = unsafe { CandleSlice::from_raw(candles_ptr, n) };
    let res = indicators::calc_galton_volume_profile(&c, period);
    set_output_json(&res)
}

#[no_mangle]
pub extern "C" fn wasm_calc_volume_footprint(
    candles_ptr: *const f64,
    n: usize,
    window_bars: usize,
    imbalance_ratio: f64,
) -> i32 {
    let c = unsafe { CandleSlice::from_raw(candles_ptr, n) };
    let res = indicators::calc_volume_footprint(&c, window_bars, imbalance_ratio);
    set_output_json(&res)
}

#[no_mangle]
pub extern "C" fn wasm_calc_reaction_level_matrix(
    candles_ptr: *const f64,
    n: usize,
    swing_len: usize,
    tol_ratio: f64,
    half_life: f64,
    min_score: f64,
    levels_per_side: usize,
) -> i32 {
    let c = unsafe { CandleSlice::from_raw(candles_ptr, n) };
    let res = indicators::calc_reaction_level_matrix(
        &c,
        swing_len,
        tol_ratio,
        half_life,
        min_score,
        levels_per_side,
    );
    set_output_json(&res)
}

#[no_mangle]
pub extern "C" fn wasm_evaluate_luxalgo_overlays(candles_ptr: *const f64, n: usize) -> i32 {
    let c = unsafe { CandleSlice::from_raw(candles_ptr, n) };
    let res = overlays::evaluate_luxalgo_overlays(&c);
    set_output_json(&res)
}

#[no_mangle]
pub extern "C" fn wasm_evaluate_ema30_band_breakout(
    candles_ptr: *const f64,
    n: usize,
    opt_ptr: *const u8,
    opt_len: usize,
) -> i32 {
    let c = unsafe { CandleSlice::from_raw(candles_ptr, n) };
    let opt_str = unsafe { read_utf8(opt_ptr, opt_len) };
    let opt: overlays::Ema30Options = if opt_str.is_empty() {
        Default::default()
    } else {
        serde_json::from_str(opt_str).unwrap_or_default()
    };
    let res = overlays::evaluate_ema30_band_breakout(&c, &opt);
    set_output_json(&res)
}

#[no_mangle]
pub extern "C" fn wasm_run_strategy_simulation(
    candles_ptr: *const f64,
    n: usize,
    cfg_ptr: *const u8,
    cfg_len: usize,
) -> i32 {
    let c = unsafe { CandleSlice::from_raw(candles_ptr, n) };
    let cfg_str = unsafe { read_utf8(cfg_ptr, cfg_len) };
    let cfg: backtest_stats::BacktestConfig = if cfg_str.is_empty() {
        Default::default()
    } else {
        serde_json::from_str(cfg_str).unwrap_or_default()
    };
    let res = backtest_stats::run_strategy_simulation(&c, &cfg);
    set_output_json(&res)
}

#[no_mangle]
pub extern "C" fn wasm_compute_edge_stats(
    candles_ptr: *const f64,
    n: usize,
    has_current_price: i32,
    current_price: f64,
) -> i32 {
    let c = unsafe { CandleSlice::from_raw(candles_ptr, n) };
    let cp = if has_current_price != 0 {
        Some(current_price)
    } else {
        None
    };
    let res = backtest_stats::compute_edge_stats(&c, cp);
    set_output_json(&res)
}
