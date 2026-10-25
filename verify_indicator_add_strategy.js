const puppeteer = require('D:/AutocmtX/twitter-comment-pack-v2/node_modules/puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

  // 1. Claim admin session on /login first
  await page.goto('http://localhost:8095/login', { waitUntil: 'networkidle2' });
  await page.evaluate(async () => {
    await fetch('/api/auth/claim-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterKey: '0711' })
    });
  });
  await new Promise(r => setTimeout(r, 400));

  // 2. Go to terminal
  await page.goto('http://localhost:8095/terminal', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1500));

  // 3. Screenshot Proliquid Dock top segmented bar
  await page.screenshot({ path: 'public/screen_dock_4tabs.png' });
  console.log('Saved public/screen_dock_4tabs.png');

  // 4. Click Indicators dropdown button
  await page.click('#btn-indicators-menu');
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: 'public/screen_indicators_dropdown_with_btn.png' });
  console.log('Saved public/screen_indicators_dropdown_with_btn.png');

  // 5. Click "➕ Add Strategy (Code Engine)" button inside Indicators dropdown
  await page.click('#btn-indicators-add-strategy');
  await new Promise(r => setTimeout(r, 700));
  await page.screenshot({ path: 'public/screen_strategy_modal_opened.png' });
  console.log('Saved public/screen_strategy_modal_opened.png');

  await browser.close();
  console.log('Finished verify_indicator_add_strategy.js');
})();
