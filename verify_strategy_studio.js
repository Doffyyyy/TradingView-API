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

  // 1. Open Strategy Studio Modal in List View
  await page.evaluate(() => {
    if (typeof openStrategyModal === 'function') {
      openStrategyModal('list');
    } else {
      const b = document.getElementById('btn-open-strategy-studio');
      if (b) b.click();
    }
  });
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: 'public/screen_strategy_studio_modal.png' });
  console.log('Saved public/screen_strategy_studio_modal.png');

  // 2. Switch to Editor View
  await page.evaluate(() => {
    if (typeof openStrategyEditor === 'function') {
      openStrategyEditor();
    } else {
      const b = document.getElementById('tab-strat-editor');
      if (b) b.click();
    }
  });
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: 'public/screen_strategy_studio_editor.png' });
  console.log('Saved public/screen_strategy_studio_editor.png');

  await browser.close();
  console.log('Finished verify_strategy_studio.js');
})();
