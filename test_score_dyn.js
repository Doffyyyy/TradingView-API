const puppeteer = require('D:/AutocmtX/twitter-comment-pack-v2/node_modules/puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1600,950'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  await page.goto('http://localhost:8095', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1500));

  // Click Daily PnL Journal tab
  const tabJournal = await page.$('button[data-target="view-journal"]');
  if (tabJournal) {
    await tabJournal.click();
    await new Promise(r => setTimeout(r, 1000));

    // Ensure mode is sim6m
    await page.select('#ts-month-mode', 'sim6m');
    await new Promise(r => setTimeout(r, 500));

    // Current is October 2026. Read Tradesyncer Score stats:
    const octScore = await page.evaluate(() => ({
      title: document.getElementById('ts-cal-title')?.textContent,
      badge: document.getElementById('ts-score-badge-val')?.textContent,
      bias: document.getElementById('ts-score-bias-val')?.textContent,
      rr: document.getElementById('ts-score-rr-val')?.textContent,
      pf: document.getElementById('ts-score-pf-val')?.textContent,
      poly: document.getElementById('ts-radar-polygon')?.getAttribute('points'),
    }));
    console.log('October Score:', octScore);

    // Switch to September 2026 (very profitable month)
    await page.click('#btn-ts-prev-month');
    await new Promise(r => setTimeout(r, 600));

    const sepScore = await page.evaluate(() => ({
      title: document.getElementById('ts-cal-title')?.textContent,
      badge: document.getElementById('ts-score-badge-val')?.textContent,
      bias: document.getElementById('ts-score-bias-val')?.textContent,
      rr: document.getElementById('ts-score-rr-val')?.textContent,
      pf: document.getElementById('ts-score-pf-val')?.textContent,
      poly: document.getElementById('ts-radar-polygon')?.getAttribute('points'),
    }));
    console.log('September Score:', sepScore);

    // Switch to August 2026
    await page.click('#btn-ts-prev-month');
    await new Promise(r => setTimeout(r, 600));

    const augScore = await page.evaluate(() => ({
      title: document.getElementById('ts-cal-title')?.textContent,
      badge: document.getElementById('ts-score-badge-val')?.textContent,
      bias: document.getElementById('ts-score-bias-val')?.textContent,
      rr: document.getElementById('ts-score-rr-val')?.textContent,
      pf: document.getElementById('ts-score-pf-val')?.textContent,
      poly: document.getElementById('ts-radar-polygon')?.getAttribute('points'),
    }));
    console.log('August Score:', augScore);

    // Take screenshot of September 2026 view
    await page.click('#btn-ts-next-month');
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: 'D:/TradingView-API/public/screen_tradesyncer_score_fixed.png' });
    console.log('Screenshot saved to public/screen_tradesyncer_score_fixed.png');
  }

  await browser.close();
})();
