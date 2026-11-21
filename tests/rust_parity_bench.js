'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');

const DATA_PATH = path.join(__dirname, '..', 'data', 'candles_cache_6m.json');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'NEARUSDT'];

function hrMs(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function runSuite(candleData) {
  const { createConfig } = require('../src/strategy_v2/config');
  const { ExecutionEngine } = require('../src/strategy_v2/executionEngine');
  const { compute26IndicatorsFromCandles } = require('../src/extensions/taEngine26');
  const {
    calcReactionLevelMatrix,
    calcSupertrend,
    calcGaltonVolumeProfile,
    calcVolumeFootprint,
  } = require('../src/extensions/indicators');
  const { evaluateLuxAlgoOverlays } = require('../src/extensions/luxalgoOverlays');
  const { evaluateEma30BandBreakout } = require('../src/extensions/ema30BandBreakout');
  const { runStrategySimulation } = require('../src/extensions/backtest');
  const { computeEdgeStats } = require('../src/extensions/statsEngine');

  const timings = {};
  const outputs = {};

  // 1. Strategy V2 ExecutionEngine (all 4 exit modes)
  const exitModes = ['FIXED_R', 'BE_PLUS_TARGET', 'PARTIAL_TRAIL', 'ATR_TRAIL'];
  outputs.strategyV2 = {};
  const tStratTotal0 = process.hrtime.bigint();
  for (const mode of exitModes) {
    const cfg = createConfig({ exit: { mode, riskRewardRatio: 2.2 } });
    const engine = new ExecutionEngine(cfg);
    const t0 = process.hrtime.bigint();
    const sim = engine.run(candleData, SYMBOLS);
    timings[`strategyV2_${mode}`] = hrMs(t0);
    outputs.strategyV2[mode] = {
      report: {
        totalTrades: sim.report.totalTrades,
        netPnl: sim.report.netPnl,
        profitFactor: sim.report.profitFactor,
        winRate: sim.report.winRate,
        maxDrawdownPct: sim.report.maxDrawdownPct,
      },
      trades: sim.trades.map(t => ({
        symbol: t.symbol,
        side: t.side,
        signalTime: t.signalTime,
        entryTime: t.entryTime,
        exitTime: t.exitTime,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        stopLoss: t.stopLoss,
        notional: t.notional,
        size: t.size,
        pnlDollar: t.pnlDollar,
        pnlR: t.pnlR,
        fees: t.fees,
        exitReason: t.exitReason,
        holdingBars: t.holdingBars,
        mfe: t.mfe,
        mae: t.mae,
      })),
      equityCount: sim.equityHistory.length,
    };
  }
  timings.strategyV2_all4 = hrMs(tStratTotal0);

  const btc15m = candleData.BTCUSDT_15m;
  const btc1h = candleData.BTCUSDT_1h;

  // 2. taEngine26 (50 iterations on 500 1h candles)
  const taSlice = btc1h.slice(-500);
  let taOut = null;
  const tTa0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) {
    taOut = compute26IndicatorsFromCandles('BTCUSDT', taSlice);
  }
  timings.taEngine26_50x500 = hrMs(tTa0);
  outputs.taEngine26 = {
    verdict: taOut.verdict,
    tradeGate: taOut.tradeGate,
    price: taOut.price,
    consensus: taOut.consensus,
    oscillators: taOut.oscillators,
    movingAverages: taOut.movingAverages,
  };

  // 3. indicators.js
  // 3a. calcReactionLevelMatrix (2000 candles, 5 runs)
  const rlmSlice = btc15m.slice(0, 2000);
  let rlmOut = null;
  const tRlm0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) {
    rlmOut = calcReactionLevelMatrix(rlmSlice);
  }
  timings.calcReactionLevelMatrix_5x2k = hrMs(tRlm0);
  outputs.rlm = rlmOut;

  // 3b. calcSupertrend (all 20,648 candles, 10 runs)
  let stOut = null;
  const tSt0 = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) {
    stOut = calcSupertrend(btc15m, 10, 3);
  }
  timings.calcSupertrend_10x20k = hrMs(tSt0);
  outputs.supertrend = {
    length: stOut.length,
    first: stOut[0],
    mid: stOut[Math.floor(stOut.length / 2)],
    last: stOut[stOut.length - 1],
  };

  // 3c. calcGaltonVolumeProfile (500 runs on 50-bar slices)
  const galtonSlices = [];
  for (let i = 0; i < 500; i++) {
    const start = (i * 37) % (btc15m.length - 50);
    galtonSlices.push(btc15m.slice(start, start + 50));
  }
  let galtonLast = null;
  const tGal0 = process.hrtime.bigint();
  for (let i = 0; i < galtonSlices.length; i++) {
    galtonLast = calcGaltonVolumeProfile(galtonSlices[i], 50);
  }
  timings.calcGaltonVolumeProfile_500x50 = hrMs(tGal0);
  outputs.galton = galtonLast;

  // 3d. calcVolumeFootprint (500 runs on 10-bar slices)
  const fpSlices = [];
  for (let i = 0; i < 500; i++) {
    const start = (i * 37) % (btc15m.length - 10);
    fpSlices.push(btc15m.slice(start, start + 10));
  }
  let fpLast = null;
  const tFp0 = process.hrtime.bigint();
  for (let i = 0; i < fpSlices.length; i++) {
    fpLast = calcVolumeFootprint(fpSlices[i], 5, 3.0);
  }
  timings.calcVolumeFootprint_500x5 = hrMs(tFp0);
  outputs.footprint = fpLast;

  // 4a. evaluateLuxAlgoOverlays (3000 candles, 10 runs)
  const luxSlice = btc15m.slice(0, 3000);
  let luxOut = null;
  const tLux0 = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) {
    luxOut = evaluateLuxAlgoOverlays(luxSlice);
  }
  timings.evaluateLuxAlgoOverlays_10x3k = hrMs(tLux0);
  outputs.luxalgo = {
    smartTrailLen: luxOut.smartTrail.length,
    smartTrailLast: luxOut.smartTrail[luxOut.smartTrail.length - 1],
    rzLen: luxOut.reversalZones.length,
    rzLast: luxOut.reversalZones[luxOut.reversalZones.length - 1],
    signals: luxOut.signals,
    latestState: luxOut.latestState,
  };

  // 4b. evaluateEma30BandBreakout (5000 candles, 10 runs)
  const ema30Slice = btc15m.slice(0, 5000);
  let ema30Out = null;
  const tEma30_0 = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) {
    ema30Out = evaluateEma30BandBreakout(ema30Slice);
  }
  timings.evaluateEma30BandBreakout_10x5k = hrMs(tEma30_0);
  outputs.ema30 = {
    emaHLast: ema30Out.emaHSeries[ema30Out.emaHSeries.length - 1],
    emaLLast: ema30Out.emaLSeries[ema30Out.emaLSeries.length - 1],
    ema200Len: ema30Out.ema200Series.length,
    signals: ema30Out.signals,
    latestState: ema30Out.latestState,
  };

  // 5a. runStrategySimulation (20,648 candles, 3 strategy types x 5 runs)
  let btSupertrend = null;
  let btEmaCross = null;
  let btRsi = null;
  const tBt0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) {
    btSupertrend = runStrategySimulation(btc15m, { type: 'supertrend' });
    btEmaCross = runStrategySimulation(btc15m, { type: 'emacross' });
    btRsi = runStrategySimulation(btc15m, { type: 'rsi' });
  }
  timings.runStrategySimulation_15x20k = hrMs(tBt0);
  outputs.backtest = {
    supertrend: btSupertrend,
    emacross: btEmaCross,
    rsi: btRsi,
  };

  // 5b. computeEdgeStats (all 1h candles converted to seconds, 20 runs)
  const btc1hSec = btc1h.map(c => ({
    time: Math.floor(c.time / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
  let edgeOut = null;
  const tEdge0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) {
    edgeOut = computeEdgeStats(btc1hSec, btc1hSec[btc1hSec.length - 1].close);
  }
  timings.computeEdgeStats_20x5k = hrMs(tEdge0);
  outputs.edgeStats = edgeOut;

  return { timings, outputs };
}

function compareValues(a, b, pathStr, diffs, tol = 1e-6) {
  if (a === b) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    if (Math.abs(a - b) <= tol * scale) return;
    diffs.push(`${pathStr}: JS=${a} vs Rust=${b} (diff=${Math.abs(a - b)})`);
    return;
  }
  if (a === null || b === null || typeof a !== typeof b) {
    diffs.push(`${pathStr}: JS=${JSON.stringify(a)} vs Rust=${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      diffs.push(`${pathStr}: Array mismatch`);
      return;
    }
    if (a.length !== b.length) {
      diffs.push(`${pathStr}.length: JS=${a.length} vs Rust=${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      compareValues(a[i], b[i], `${pathStr}[${i}]`, diffs, tol);
      if (diffs.length >= 25) return;
    }
    return;
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) {
      diffs.push(`${pathStr} keys mismatch: JS=[${keysA}] vs Rust=[${keysB}]`);
      return;
    }
    for (const k of keysA) {
      compareValues(a[k], b[k], `${pathStr}.${k}`, diffs, tol);
      if (diffs.length >= 25) return;
    }
    return;
  }
  diffs.push(`${pathStr}: JS=${JSON.stringify(a)} vs Rust=${JSON.stringify(b)}`);
}

function main() {
  const args = process.argv.slice(2);
  const saveIdx = args.indexOf('--save');
  const savePath = saveIdx >= 0 ? args[saveIdx + 1] : null;
  const modeJsOnly = args.includes('--js-only');
  const modeRustOnly = args.includes('--rust-only');

  if (modeJsOnly || modeRustOnly) {
    if (modeJsOnly) process.env.DISABLE_RUST_CORE = '1';
    else delete process.env.DISABLE_RUST_CORE;

    const candleData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    const res = runSuite(candleData);
    if (savePath) {
      fs.writeFileSync(savePath, JSON.stringify(res));
    } else {
      console.log(`Mode: ${modeJsOnly ? 'JS-ONLY' : 'RUST-ENABLED'}`);
      for (const [k, v] of Object.entries(res.timings)) {
        console.log(`  ${k.padEnd(36)} ${v.toFixed(2).padStart(10)} ms`);
      }
    }
    return;
  }

  // Full Parity + Benchmark Comparison Mode
  const tmpJs = path.join(os.tmpdir(), `tv_parity_js_${process.pid}.json`);
  const tmpRust = path.join(os.tmpdir(), `tv_parity_rust_${process.pid}.json`);
  try {
    execFileSync(process.execPath, [__filename, '--js-only', '--save', tmpJs], {
      env: { ...process.env, DISABLE_RUST_CORE: '1' },
      stdio: 'inherit',
    });
    execFileSync(process.execPath, [__filename, '--rust-only', '--save', tmpRust], {
      env: { ...process.env, DISABLE_RUST_CORE: '0' },
      stdio: 'inherit',
    });

    const jsRes = JSON.parse(fs.readFileSync(tmpJs, 'utf8'));
    const rustRes = JSON.parse(fs.readFileSync(tmpRust, 'utf8'));

    console.log('\n=============================================================================');
    console.log('                       JS vs RUST BENCHMARK COMPARISON                       ');
    console.log('=============================================================================');
    console.log('Benchmark                            |    JS (ms) |  Rust (ms) |     Speedup');
    console.log('-------------------------------------+------------+------------+------------');

    let totalJs = 0;
    let totalRust = 0;
    for (const k of Object.keys(jsRes.timings)) {
      const jsMs = jsRes.timings[k];
      const rustMs = rustRes.timings[k];
      if (!k.startsWith('strategyV2_') || k === 'strategyV2_all4') {
        totalJs += jsMs;
        totalRust += rustMs;
      }
      const speedup = rustMs > 0 ? (jsMs / rustMs) : 0;
      console.log(
        `${k.padEnd(36)} | ${jsMs.toFixed(2).padStart(10)} | ${rustMs.toFixed(2).padStart(10)} | ${(speedup.toFixed(2) + 'x').padStart(10)}`
      );
    }
    console.log('-------------------------------------+------------+------------+------------');
    console.log(
      `${'TOTAL (excl. duplicate sub-modes)'.padEnd(36)} | ${totalJs.toFixed(2).padStart(10)} | ${totalRust.toFixed(2).padStart(10)} | ${((totalRust > 0 ? totalJs / totalRust : 0).toFixed(2) + 'x').padStart(10)}`
    );

    const diffs = [];
    compareValues(jsRes.outputs, rustRes.outputs, 'outputs', diffs, 1e-6);

    console.log('\n=============================================================================');
    console.log('                             PARITY VERIFICATION                             ');
    console.log('=============================================================================');
    if (diffs.length === 0) {
      console.log('PASS: 100% parity achieved across all ported modules (tol = 1e-6)!');
    } else {
      console.error(`FAIL: Found ${diffs.length} parity difference(s):`);
      for (const d of diffs) console.error('  -', d);
      process.exitCode = 1;
    }
  } finally {
    try { fs.unlinkSync(tmpJs); } catch (_) {}
    try { fs.unlinkSync(tmpRust); } catch (_) {}
  }
}

main();
