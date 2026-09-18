#!/usr/bin/env node

const { computeAllIndicators } = require('./src/extensions/indicators');
const { validateSymbol } = require('./src/extensions/validation');
const { runBacktest } = require('./src/extensions/backtest');
const { runHistoricalReplay } = require('./src/extensions/replay');
const { sendTelegramAlert } = require('./src/extensions/alert');
const { hubInstance } = require('./src/extensions/agentHub');
const { paperTraderInstance } = require('./src/extensions/paperTrader');

const args = process.argv.slice(2);
const command = args[0];
const target = args[1] || 'BINANCE:BTCUSDT';

async function main() {
  if (!command) {
    console.log(`
Usage:
  node cli.js paper [status|close-all|reset]
  node cli.js indicator <symbol> [timeframe]
  node cli.js validate <symbol>
  node cli.js backtest <symbol> [strategy: supertrend|emacross|rsi]
  node cli.js replay <symbol> [bars]
  node cli.js alert <symbol> [strategyName]
  node cli.js hub-demo
    `);
    process.exit(0);
  }

  try {
    switch (command) {
      case 'paper': {
        const sub = args[1] || 'status';
        if (sub === 'reset') {
          paperTraderInstance.resetAccount();
          console.log('Paper account reset to $10,000.00');
        } else if (sub === 'close-all') {
          for (const pos of [...paperTraderInstance.portfolio.positions]) {
            const curr = paperTraderInstance.latestPrices[pos.symbol]?.price || pos.entryPrice;
            await paperTraderInstance.closePosition(pos.id, curr, 'Manual Close via CLI');
          }
          console.log('All positions closed');
        } else {
          await paperTraderInstance.fetchPrices();
          console.log(JSON.stringify(paperTraderInstance.getStatus(), null, 2));
        }
        break;
      }
      case 'indicator': {
        const tf = args[2] || '60';
        console.log(`Computing indicators for ${target} (${tf}m)...`);
        const res = await computeAllIndicators(target, tf);
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'validate': {
        console.log(`Running 26-indicator consensus for ${target}...`);
        const res = await validateSymbol(target);
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'backtest': {
        const strat = args[2] || 'supertrend';
        console.log(`Running Astra backtest for ${target} [${strat}]...`);
        const res = await runBacktest(target, '60', { type: strat });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'replay': {
        const bars = parseInt(args[2] || '100', 10);
        console.log(`Running replay stress test for ${target} (${bars} bars)...`);
        const res = await runHistoricalReplay(target, '60', bars);
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'alert': {
        const strat = args[2] || 'Astra-Supertrend Alpha';
        console.log(`Generating chart snapshot and sending Telegram alert for ${target}...`);
        const res = await sendTelegramAlert({
          instrument: target,
          strategy: strat,
          action: 'BUY / LONG',
          sharpe: 2.35,
          drawdown: '-3.6%',
          winRate: 0.62,
          winLossRatio: 1.8,
          accountEquity: 10000,
          timeframe: '60',
        });
        console.log('Success:', res);
        break;
      }

      case 'hub-demo': {
        console.log('Demonstrating 300-agent monitoring hub...');
        for (let i = 1; i <= 5; i++) {
          hubInstance.registerAgent(`agent-${i}`, ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT']);
        }
        await new Promise(r => setTimeout(r, 2500));
        console.log('Status:', hubInstance.getStatus());
        console.log('Agent-1 data:', hubInstance.getAgentData('agent-1'));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (err) {
    console.error('Execution failed:', err.message);
    process.exit(1);
  }
}

main();
