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

  await page.goto('http://localhost:8095/login', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 600));

  // Open Terms of Service modal
  console.log('Triggering openLegalModal("terms")...');
  await page.evaluate(() => {
    openLegalModal('terms');
  });
  await new Promise(r => setTimeout(r, 800));

  await page.screenshot({ path: 'public/screen_terms_with_art_bg.png' });
  console.log('Saved public/screen_terms_with_art_bg.png');

  // Close and Open Privacy Policy modal
  console.log('Triggering openLegalModal("privacy")...');
  await page.evaluate(() => {
    closeLegalModal();
  });
  await new Promise(r => setTimeout(r, 400));

  await page.evaluate(() => {
    openLegalModal('privacy');
  });
  await new Promise(r => setTimeout(r, 800));

  await page.screenshot({ path: 'public/screen_privacy_with_art_bg.png' });
  console.log('Saved public/screen_privacy_with_art_bg.png');

  await browser.close();
})();
