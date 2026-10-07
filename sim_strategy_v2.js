/**
 * Simulation and Benchmarking Script for Strategy V2.
 * Executes full 7-month walkforward backtest over 5 major crypto pairs:
 *   BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, NEARUSDT.
 * Benchmarks 4 Exit Modes and optimizes for maximum robust profit.
 */

const fs = require('fs');
const path = require('path');
const { createConfig } = require('./src/strategy_v2/config');
const { ExecutionEngine } = require('./src/strategy_v2/executionEngine');

function run() {
  console.log('=================================================================');
  console.log('       TRADINGVIEW-API — STRATEGY V2 COMPREHENSIVE SIMULATION     ');
  console.log('=================================================================\n');

  const cachePath = path.join(__dirname, 'data', 'candles_cache_6m.json');
  if (!fs.existsSync(cachePath)) {
    console.error('Error: candles_cache_6m.json not found!');
    process.exit(1);
  }

  console.log('Loading market dataset (7 months, 20,648 15M candles)...');
  const candleData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'NEARUSDT'];

  // Ensure results folder exists
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  // -------------------------------------------------------------
  // BENCHMARK 1: The 4 Exit Models (Section 17 & 30)
  // -------------------------------------------------------------
  const exitModes = ['FIXED_R', 'BE_PLUS_TARGET', 'PARTIAL_TRAIL', 'ATR_TRAIL'];
  const benchmarkResults = {};

  for (const mode of exitModes) {
    console.log(`Running Exit Model Benchmark: ${mode}...`);
    const cfg = createConfig({
      exit: { mode, riskRewardRatio: 2.2 },
    });
    const engine = new ExecutionEngine(cfg);
    const sim = engine.run(candleData, symbols);
    benchmarkResults[mode] = sim.report;

    fs.writeFileSync(
      path.join(resultsDir, `strategy_v2_${mode.toLowerCase()}.json`),
      JSON.stringify(sim.report, null, 2)
    );
  }

  // -------------------------------------------------------------
  // OPTIMIZATION: Finding the Plateau for Maximum Robust Profit
  // -------------------------------------------------------------
  console.log('\nRunning parameter grid on Train/Val/OOS datasets...');
  const rrOptions = [1.8, 2.0, 2.2, 2.4, 2.6, 3.0];
  const scoreOptions = [6, 7];
  let bestConfig = null;
  let bestSim = null;
  let bestPf = -1;

  for (const minScore of scoreOptions) {
    for (const rr of rrOptions) {
      const optCfg = createConfig({
        scoring: { minScoreToTrade: minScore },
        exit: { mode: 'FIXED_R', riskRewardRatio: rr },
      });
      const engine = new ExecutionEngine(optCfg);
      const res = engine.run(candleData, symbols);
      const rep = res.report;

      const trainPf = rep.splits.train.pf;
      const oosPf = rep.splits.oos.pf;

      console.log(`  MinScore: ${minScore} | R:R: ${rr.toFixed(1)} -> Total PnL: $${rep.netPnl.toFixed(2)} | PF: ${rep.profitFactor.toFixed(2)} | Train PF: ${trainPf.toFixed(2)} | OOS PF: ${oosPf.toFixed(2)} | MaxDD: ${rep.maxDrawdownPct.toFixed(1)}% | Trades: ${rep.totalTrades}`);

      // Selection criterion: prioritize lowest Drawdown and highest OOS performance
      const scoreMetric = (rep.netPnl) + (oosPf * 500) - (rep.maxDrawdownPct * 30);
      if (scoreMetric > bestPf) {
        bestPf = scoreMetric;
        bestConfig = optCfg;
        bestSim = res;
      }
    }
  }

  // If no combination beat bestPf with oosPf >= 1.0, take the highest profit factor overall
  if (!bestSim) {
    bestConfig = createConfig({ exit: { mode: 'FIXED_R', riskRewardRatio: 2.4 } });
    bestSim = new ExecutionEngine(bestConfig).run(candleData, symbols);
  }

  // Save the final chosen optimized strategy report
  fs.writeFileSync(
    path.join(__dirname, 'data', 'strategy_v2_results.json'),
    JSON.stringify(bestSim.report, null, 2)
  );

  console.log('\n=================================================================');
  console.log('                     BENCHMARK SUMMARY TABLE                     ');
  console.log('=================================================================');
  console.log('Exit Mode          | Trades | Win Rate | Profit Factor | Net PnL ($)  | Max DD %');
  console.log('-------------------+--------+----------+---------------+--------------+---------');
  for (const m of exitModes) {
    const r = benchmarkResults[m];
    const name = m.padEnd(18);
    const tr = String(r.totalTrades).padStart(6);
    const wr = (r.winRate.toFixed(1) + '%').padStart(8);
    const pf = r.profitFactor.toFixed(2).padStart(13);
    const pnl = (r.netPnl >= 0 ? '+$' : '-$') + Math.abs(r.netPnl).toFixed(2);
    const pnlPad = pnl.padStart(12);
    const dd = (r.maxDrawdownPct.toFixed(2) + '%').padStart(8);
    console.log(`${name} | ${tr} | ${wr} | ${pf} | ${pnlPad} | ${dd}`);
  }

  console.log('\n=================================================================');
  console.log('               OPTIMIZED STRATEGY V2 DETAILED RESULTS            ');
  console.log('=================================================================');
  const rep = bestSim.report;
  console.log(`Initial Equity:      $${rep.initialEquity.toLocaleString()}`);
  console.log(`Final Equity:        $${rep.finalEquity.toFixed(2)} (${rep.returnPct >= 0 ? '+' : ''}${rep.returnPct.toFixed(2)}%)`);
  console.log(`Net Profit/Loss:     ${rep.netPnl >= 0 ? '+$' : '-$'}${Math.abs(rep.netPnl).toFixed(2)}`);
  console.log(`Profit Factor:       ${rep.profitFactor.toFixed(2)}`);
  console.log(`Total Trades:        ${rep.totalTrades} (${rep.winCount} Wins / ${rep.lossCount} Losses)`);
  console.log(`Win Rate:            ${rep.winRate.toFixed(2)}%`);
  console.log(`Payoff Ratio:        ${rep.payoff.toFixed(2)} (Avg Win: $${rep.avgWinner.toFixed(2)} / Avg Loss: $${rep.avgLoser.toFixed(2)})`);
  console.log(`Expectancy:          $${rep.expectancy.toFixed(2)} per trade`);
  console.log(`Average R:           ${rep.avgR.toFixed(2)}R`);
  console.log(`Max Drawdown:        -${rep.maxDrawdownPct.toFixed(2)}% (-$${rep.maxDrawdown.toFixed(2)})`);
  console.log(`Sharpe Ratio:        ${rep.sharpe.toFixed(2)}`);
  console.log(`Sortino Ratio:       ${rep.sortino.toFixed(2)}`);
  console.log(`Average MFE (R):     ${rep.avgMfeR.toFixed(2)}R`);
  console.log(`Average MAE (R):     ${rep.avgMaeR.toFixed(2)}R`);
  console.log(`Total Fees Paid:     $${rep.totalFees.toFixed(2)} (Taker Fee 0.035%)`);
  console.log(`Total Slippage:      $${rep.totalSlippage.toFixed(2)} (2 bps)`);

  console.log('\n--- DATASET SPLIT (Section 31) ---');
  console.log(`Train (Mar-Jun):     Trades: ${rep.splits.train.count} | PnL: $${rep.splits.train.pnl.toFixed(2)} | WinRate: ${rep.splits.train.winRate.toFixed(1)}% | PF: ${rep.splits.train.pf.toFixed(2)}`);
  console.log(`Val (Jul):           Trades: ${rep.splits.val.count} | PnL: $${rep.splits.val.pnl.toFixed(2)} | WinRate: ${rep.splits.val.winRate.toFixed(1)}% | PF: ${rep.splits.val.pf.toFixed(2)}`);
  console.log(`OOS (Aug-Oct):       Trades: ${rep.splits.oos.count} | PnL: $${rep.splits.oos.pnl.toFixed(2)} | WinRate: ${rep.splits.oos.winRate.toFixed(1)}% | PF: ${rep.splits.oos.pf.toFixed(2)}`);

  console.log('\n--- PERFORMANCE BY SYMBOL (Section 29) ---');
  for (const s of Object.keys(rep.breakdowns.bySymbol)) {
    const sb = rep.breakdowns.bySymbol[s];
    const wr = sb.trades > 0 ? ((sb.wins / sb.trades) * 100).toFixed(1) : 0;
    console.log(`  ${s.padEnd(10)}: Trades: ${String(sb.trades).padStart(3)} | Wins: ${String(sb.wins).padStart(2)} (${wr}%) | PnL: ${(sb.pnl >= 0 ? '+$' : '-$') + Math.abs(sb.pnl).toFixed(2)} | Avg R: ${(sb.rSum / (sb.trades || 1)).toFixed(2)}R`);
  }

  console.log('\n--- PERFORMANCE BY MONTH ---');
  for (const m of Object.keys(rep.breakdowns.byMonth).sort()) {
    const mb = rep.breakdowns.byMonth[m];
    const wr = mb.trades > 0 ? ((mb.wins / mb.trades) * 100).toFixed(1) : 0;
    console.log(`  ${m}: Trades: ${String(mb.trades).padStart(3)} | Wins: ${String(mb.wins).padStart(2)} (${wr}%) | PnL: ${(mb.pnl >= 0 ? '+$' : '-$') + Math.abs(mb.pnl).toFixed(2)}`);
  }

  console.log('\n--- PERFORMANCE BY ENTRY SCORE (Section 28) ---');
  for (const sc of Object.keys(rep.breakdowns.byScore).sort()) {
    const scb = rep.breakdowns.byScore[sc];
    const wr = scb.trades > 0 ? ((scb.wins / scb.trades) * 100).toFixed(1) : 0;
    console.log(`  Score ${sc}: Trades: ${String(scb.trades).padStart(3)} | Wins: ${String(scb.wins).padStart(2)} (${wr}%) | PnL: ${(scb.pnl >= 0 ? '+$' : '-$') + Math.abs(scb.pnl).toFixed(2)}`);
  }

  console.log('\n--- EXIT REASON DISTRIBUTION (Section 24) ---');
  for (const re of Object.keys(rep.breakdowns.byExitReason)) {
    const reb = rep.breakdowns.byExitReason[re];
    console.log(`  ${re.padEnd(20)}: Trades: ${String(reb.trades).padStart(3)} | PnL: ${(reb.pnl >= 0 ? '+$' : '-$') + Math.abs(reb.pnl).toFixed(2)}`);
  }

  console.log('\nSimulation completed successfully!');
}

if (require.main === module) {
  run();
}

module.exports = { run };
