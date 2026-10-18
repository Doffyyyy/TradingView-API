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

  // Click Paper Trade ($10k) tab
  const tabPaper = await page.$('button[data-target="view-paper"]');
  if (tabPaper) {
    await tabPaper.click();
    await new Promise(r => setTimeout(r, 1000));

    const equityText = await page.$eval('#paper-equity', el => el.textContent);
    const cashText = await page.$eval('#paper-cash', el => el.textContent);
    console.log('UI Paper Equity:', equityText);
    console.log('UI Paper Cash:', cashText);

    await page.screenshot({ path: 'D:/TradingView-API/public/screen_paper_equity_synced.png' });
    console.log('Took screenshot of synchronized Paper Trade tab!');
  }

  await browser.close();
})();
