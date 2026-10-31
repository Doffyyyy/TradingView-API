/**
 * Quick Telegram Report Dispatcher
 * Triggered via CLI, Telegram command (/report or //report), or scheduled hook.
 */

const { dispatchMonthlyReport } = require('./src/extensions/monthlyReportScheduler');

async function main() {
  const targetMonth = process.argv[2] || null;
  console.log(`[QuickReport] 🚀 Triggering instant Telegram report dispatch (targetMonth: ${targetMonth || 'Current'})...`);
  try {
    const res = await dispatchMonthlyReport(targetMonth, true);
    console.log('[QuickReport] ✅ Successfully dispatched report to Telegram:');
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('[QuickReport] ❌ Failed to dispatch report:', err.message);
    process.exit(1);
  }
}

main();
