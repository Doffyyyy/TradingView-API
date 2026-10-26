const puppeteer = require('D:/AutocmtX/twitter-comment-pack-v2/node_modules/puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto('http://localhost:8095/login', { waitUntil: 'networkidle2' });
  await page.evaluate(async () => {
    await fetch('/api/auth/claim-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterKey: '0711' })
    });
  });

  await page.goto('http://localhost:8095/terminal', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1200));

  const footer = await page.$('footer');
  if (footer) {
    await footer.screenshot({ path: 'public/screen_footer_clean.png' });
    console.log('Saved public/screen_footer_clean.png');
  } else {
    console.log('Footer not found');
  }

  await browser.close();
})();
