const puppeteer = require('D:/AutocmtX/twitter-comment-pack-v2/node_modules/puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

  await page.goto('http://localhost:8095/login', { waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    if (typeof window.openLegalModal === 'function') {
      window.openLegalModal('security-audit');
    } else if (typeof openLegalModal === 'function') {
      openLegalModal('security-audit');
    } else {
      console.log('openLegalModal is not found on window!');
    }
  });
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: 'public/screen_login_landing_audit.png' });
  await browser.close();
  console.log('Saved public/screen_login_landing_audit.png');
})();
