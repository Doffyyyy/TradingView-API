const puppeteer = require('D:/AutocmtX/twitter-comment-pack-v2/node_modules/puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1600,950'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  // 1. Claim admin
  await page.goto('http://localhost:8095/login', { waitUntil: 'networkidle2' });
  await page.evaluate(async () => {
    await fetch('/api/auth/claim-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterKey: '0711' })
    });
  });

  // 2. Navigate to /terminal
  await page.goto('http://localhost:8095/terminal', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1200));

  // 3. Navigate to Daily PnL Journal tab
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('button[data-target="view-journal"]');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  console.log('Clicked Daily PnL Journal tab:', clicked);
  await new Promise(r => setTimeout(r, 1200));

  // Verify presence of buttons
  const status = await page.evaluate(() => {
    return {
      btnTele: !!document.getElementById('btn-ts-send-tele'),
      btnExcel: !!document.getElementById('btn-ts-export-excel'),
      btnCsv: !!document.getElementById('btn-ts-export'),
      btnVerified: !!document.querySelector('button[data-ts-source="verified"]'),
      btnManual: !!document.querySelector('button[data-ts-source="manual"]'),
      btnAllJournals: !!document.querySelector('button[data-ts-source="all"]'),
      subtabs: !!document.querySelector('.ts-subtabs'),
      subtabJournal: !!document.querySelector('button[data-ts-view="journal"]'),
      subtabComparison: !!document.querySelector('button[data-ts-view="comparison"]'),
      subtabAnalysis: !!document.querySelector('button[data-ts-view="analysis"]')
    };
  });

  console.log('Verification Status:', JSON.stringify(status, null, 2));

  await page.screenshot({ path: 'D:/TradingView-API/public/screen_journal_cleaned.png' });
  console.log('Saved public/screen_journal_cleaned.png');

  await browser.close();
})();
