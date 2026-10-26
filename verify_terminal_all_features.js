const puppeteer = require('D:/AutocmtX/twitter-comment-pack-v2/node_modules/puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') console.log('BROWSER CONSOLE ERROR:', msg.text());
  });
  page.on('pageerror', err => {
    console.log('BROWSER PAGE ERROR:', err.toString());
    errors.push(err.toString());
  });

  // 1. Claim admin on /login
  await page.goto('http://localhost:8095/login', { waitUntil: 'networkidle2' });
  await page.evaluate(async () => {
    await fetch('/api/auth/claim-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterKey: '0711' })
    });
  });

  // 2. Open /terminal
  await page.goto('http://localhost:8095/terminal', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1500));

  // 3. Test clicking Tabs
  const tabs = ['view-paper', 'view-journal', 'view-macro', 'view-ai-hub', 'view-replay', 'view-alert', 'view-chart'];
  for (const t of tabs) {
    const clicked = await page.evaluate((target) => {
      const btn = document.querySelector(`button[data-target="${target}"]`);
      if (btn) { btn.click(); return true; }
      return false;
    }, t);
    console.log(`Tab ${t} clicked:`, clicked);
    await new Promise(r => setTimeout(r, 400));
  }

  // 4. Test opening Indicators Menu
  await page.click('#btn-indicators-menu');
  await new Promise(r => setTimeout(r, 500));
  const indVisible = await page.evaluate(() => {
    const d = document.getElementById('indicators-dropdown');
    return d && d.style.display === 'block';
  });
  console.log('Indicators dropdown opened:', indVisible);

  // 5. Test opening Strategy Studio Modal
  await page.click('#btn-indicators-add-strategy');
  await new Promise(r => setTimeout(r, 600));
  const stratVisible = await page.evaluate(() => {
    const m = document.getElementById('strategy-studio-modal');
    return m && m.style.display === 'flex';
  });
  console.log('Strategy Studio Modal opened:', stratVisible);

  // 6. Test switching to Agent Key tab
  await page.click('#tab-strat-agent');
  await new Promise(r => setTimeout(r, 500));
  const agentVisible = await page.evaluate(() => {
    const v = document.getElementById('strat-view-agent');
    return v && v.style.display === 'block';
  });
  console.log('Agent tab view displayed:', agentVisible);

  await page.screenshot({ path: 'public/screen_test_agent_tab_working.png' });
  console.log('Saved public/screen_test_agent_tab_working.png');

  // 7. Close modal
  await page.click('#btn-close-strat-modal');
  await new Promise(r => setTimeout(r, 400));

  // 8. Test clicking '🔑 API Bot Key (Hyperliquid)' button directly from Paper view
  await page.evaluate(() => {
    const btn = document.querySelector('button[data-target="view-paper"]');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 500));
  await page.click('#btn-open-hl-agent-modal');
  await new Promise(r => setTimeout(r, 600));
  const reopenedAgent = await page.evaluate(() => {
    const m = document.getElementById('strategy-studio-modal');
    const v = document.getElementById('strat-view-agent');
    return m && m.style.display === 'flex' && v && v.style.display === 'block';
  });
  console.log('Reopened Agent modal from Paper controls bar:', reopenedAgent);

  await browser.close();
  console.log('Total page errors encountered:', errors.length);
})();
