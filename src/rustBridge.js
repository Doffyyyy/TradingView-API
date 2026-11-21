/* global WebAssembly */

const fs = require('fs');
const path = require('path');

const WASM_PATH = path.join(__dirname, '..', 'rust-core', 'tradingview_rust_core.wasm');

let instance = null;
let loadAttempted = false;

function getExports() {
  if (process.env.DISABLE_RUST_CORE === '1') return null;
  if (!loadAttempted) {
    loadAttempted = true;
    try {
      if (fs.existsSync(WASM_PATH)) {
        const bytes = fs.readFileSync(WASM_PATH);
        const mod = new WebAssembly.Module(bytes);
        const inst = new WebAssembly.Instance(mod);
        if (inst && inst.exports && typeof inst.exports.ping === 'function' && inst.exports.ping() === 1) {
          instance = inst;
        }
      }
    } catch (_) {
      instance = null;
    }
  }
  return instance ? instance.exports : null;
}

function readOutputJson(exp) {
  const ptr = exp.last_out_ptr();
  const len = exp.last_out_len();
  if (len === 0) return null;
  const text = Buffer.from(exp.memory.buffer, ptr, len).toString('utf8');
  return JSON.parse(text);
}

function withUtf8(exp, str, fn) {
  const buf = Buffer.from(str, 'utf8');
  const len = buf.length;
  if (len === 0) return fn(0, 0);
  const ptr = exp.alloc_u8(len);
  try {
    new Uint8Array(exp.memory.buffer, ptr, len).set(buf);
    return fn(ptr, len);
  } finally {
    exp.dealloc_u8(ptr, len);
  }
}

function withPackedCandles(exp, candles, fn) {
  const n = candles ? candles.length : 0;
  if (n === 0) return fn(0, 0);
  const totalF64 = n * 6;
  const ptr = exp.alloc_f64(totalF64);
  try {
    const view = new Float64Array(exp.memory.buffer, ptr, totalF64);
    const o1 = n;
    const o2 = n * 2;
    const o3 = n * 3;
    const o4 = n * 4;
    const o5 = n * 5;
    for (let i = 0; i < n; i += 1) {
      const c = candles[i];
      view[i] = c.time || 0;
      view[o1 + i] = c.open;
      view[o2 + i] = c.high;
      view[o3 + i] = c.low;
      view[o4 + i] = c.close;
      view[o5 + i] = c.volume || 0;
    }
    return fn(ptr, n);
  } finally {
    exp.dealloc_f64(ptr, totalF64);
  }
}

const strategyDatasetCache = new WeakMap();

function getPackedDataset(candleData) {
  const cached = strategyDatasetCache.get(candleData);
  if (cached) {
    let valid = true;
    for (const s of cached.slices) {
      const arr = candleData[s.key];
      if (!Array.isArray(arr) || arr.length !== s.len) {
        valid = false;
        break;
      }
    }
    if (valid) return cached;
  }

  const slices = [];
  let totalF64 = 0;
  for (const key of Object.keys(candleData)) {
    const arr = candleData[key];
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
      slices.push({ key, offset: totalF64, len: arr.length });
      totalF64 += arr.length * 6;
    }
  }

  const packed = new Float64Array(totalF64);
  for (const s of slices) {
    const arr = candleData[s.key];
    const n = s.len;
    const base = s.offset;
    const o1 = base + n;
    const o2 = base + n * 2;
    const o3 = base + n * 3;
    const o4 = base + n * 4;
    const o5 = base + n * 5;
    for (let i = 0; i < n; i += 1) {
      const c = arr[i];
      packed[base + i] = c.time || 0;
      packed[o1 + i] = c.open;
      packed[o2 + i] = c.high;
      packed[o3 + i] = c.low;
      packed[o4 + i] = c.close;
      packed[o5 + i] = c.volume || 0;
    }
  }

  const entry = { packed, totalF64, slices };
  strategyDatasetCache.set(candleData, entry);
  return entry;
}

function runStrategyV2(candleData, symbols, config) {
  const exp = getExports();
  if (!exp) return null;

  const { packed, totalF64, slices } = getPackedDataset(candleData);
  const metaJson = JSON.stringify({ config, symbols, slices });

  const dataPtr = totalF64 > 0 ? exp.alloc_f64(totalF64) : 0;
  try {
    if (totalF64 > 0) {
      new Float64Array(exp.memory.buffer, dataPtr, totalF64).set(packed);
    }
    const status = withUtf8(exp, metaJson, (metaPtr, metaLen) => (
      exp.wasm_run_strategy_v2(metaPtr, metaLen, dataPtr, totalF64)
    ));
    if (status !== 0) return null;
    return readOutputJson(exp);
  } finally {
    if (dataPtr) exp.dealloc_f64(dataPtr, totalF64);
  }
}

function compute26IndicatorsFromCandles(symbol, candles) {
  const exp = getExports();
  if (!exp || !candles || candles.length < 35) return null;
  const status = withPackedCandles(exp, candles, (cPtr, n) => (
    withUtf8(exp, String(symbol || ''), (sPtr, sLen) => (
      exp.wasm_compute_26_indicators(sPtr, sLen, cPtr, n)
    ))
  ));
  if (status !== 0) return null;
  const res = readOutputJson(exp);
  if (!res) return null;
  res.timestamp = Math.round(Date.now() / 1000);
  return res;
}

function calcSupertrend(candles, period = 10, multiplier = 3) {
  const exp = getExports();
  if (!exp || !candles || candles.length < period) return null;
  const status = withPackedCandles(exp, candles, (cPtr, n) => (
    exp.wasm_calc_supertrend(cPtr, n, period, multiplier)
  ));
  return status === 0 ? readOutputJson(exp) : null;
}

function calcGaltonVolumeProfile(candles, period = 50) {
  const exp = getExports();
  if (!exp || !candles || candles.length < 5) return null;
  const tail = candles.length > period ? candles.slice(-period) : candles;
  const status = withPackedCandles(exp, tail, (cPtr, n) => (
    exp.wasm_calc_galton_volume_profile(cPtr, n, period)
  ));
  return status === 0 ? readOutputJson(exp) : null;
}

function calcVolumeFootprint(candles, windowBars = 5, imbalanceRatio = 3.0) {
  const exp = getExports();
  if (!exp || !candles || candles.length < 3) return null;
  const tail = candles.length > windowBars ? candles.slice(-windowBars) : candles;
  const status = withPackedCandles(exp, tail, (cPtr, n) => (
    exp.wasm_calc_volume_footprint(cPtr, n, windowBars, imbalanceRatio)
  ));
  return status === 0 ? readOutputJson(exp) : null;
}

function calcReactionLevelMatrix(candles, options = {}) {
  const exp = getExports();
  if (!exp || !candles || candles.length < 35) return null;
  const swingLen = options.swingLength || 6;
  const tolRatio = options.levelTolerance || 0.6;
  const halfLife = options.halfLife || 500;
  const minScore = options.minScore || 50;
  const levelsPerSide = options.levelsPerSide || 3;
  const status = withPackedCandles(exp, candles, (cPtr, n) => (
    exp.wasm_calc_reaction_level_matrix(
      cPtr,
      n,
      swingLen,
      tolRatio,
      halfLife,
      minScore,
      levelsPerSide,
    )
  ));
  return status === 0 ? readOutputJson(exp) : null;
}

function evaluateLuxAlgoOverlays(candles) {
  const exp = getExports();
  if (!exp || !Array.isArray(candles)) return null;
  const status = withPackedCandles(exp, candles, (cPtr, n) => (
    exp.wasm_evaluate_luxalgo_overlays(cPtr, n)
  ));
  return status === 0 ? readOutputJson(exp) : null;
}

function evaluateEma30BandBreakout(candles, options = {}) {
  const exp = getExports();
  if (!exp || !candles) return null;
  const lenBand = options.lenBand || 30;
  if (candles.length < Math.max(lenBand, 35)) return null;
  const optJson = JSON.stringify(options || {});
  const status = withPackedCandles(exp, candles, (cPtr, n) => (
    withUtf8(exp, optJson, (oPtr, oLen) => (
      exp.wasm_evaluate_ema30_band_breakout(cPtr, n, oPtr, oLen)
    ))
  ));
  return status === 0 ? readOutputJson(exp) : null;
}

function runStrategySimulation(candles, strategyConfig = {}) {
  const exp = getExports();
  if (!exp || !candles || candles.length === 0) return null;
  const cfgJson = JSON.stringify(strategyConfig || {});
  const status = withPackedCandles(exp, candles, (cPtr, n) => (
    withUtf8(exp, cfgJson, (cfgPtr, cfgLen) => (
      exp.wasm_run_strategy_simulation(cPtr, n, cfgPtr, cfgLen)
    ))
  ));
  return status === 0 ? readOutputJson(exp) : null;
}

function computeEdgeStats(candles, currentPrice) {
  const exp = getExports();
  if (!exp || !candles || candles.length < 5) return null;
  const isValidCp = (
    typeof currentPrice === 'number'
    && !Number.isNaN(currentPrice)
    && currentPrice !== 0
  );
  const hasCp = isValidCp ? 1 : 0;
  const cpVal = hasCp ? currentPrice : 0;
  const status = withPackedCandles(exp, candles, (cPtr, n) => (
    exp.wasm_compute_edge_stats(cPtr, n, hasCp, cpVal)
  ));
  return status === 0 ? readOutputJson(exp) : null;
}

module.exports = {
  isRustEnabled: () => getExports() !== null,
  runStrategyV2,
  compute26IndicatorsFromCandles,
  calcSupertrend,
  calcGaltonVolumeProfile,
  calcVolumeFootprint,
  calcReactionLevelMatrix,
  evaluateLuxAlgoOverlays,
  evaluateEma30BandBreakout,
  runStrategySimulation,
  computeEdgeStats,
};
