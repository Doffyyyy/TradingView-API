const puppeteer = require('D:/AutocmtX/twitter-comment-pack-v2/node_modules/puppeteer-core');

(async () => {
  console.log('Starting Brave/Puppeteer verification of Login Gateway Page...');
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // 1. Navigate to /login
  console.log('Navigating to http://localhost:8095/login ...');
  await page.goto('http://localhost:8095/login', { waitUntil: 'networkidle2', timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  // 2. Capture Hero & Login Gateway screenshot
  await page.screenshot({ path: 'public/screen_login_landing_hero.png', fullPage: false });
  console.log('Saved public/screen_login_landing_hero.png');

  // 3. Test clicking Google Tab
  console.log('Testing Google Tab switch...');
  await page.click('button[data-tab-target="pane-google"]');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: 'public/screen_login_landing_google.png', fullPage: false });
  console.log('Saved public/screen_login_landing_google.png');

  // 4. Test clicking Terms of Service link in floating nav
  console.log('Testing Terms of Service Modal...');
  await page.evaluate(() => {
    openLegalModal('terms');
  });
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: 'public/screen_login_landing_terms.png', fullPage: false });
  console.log('Saved public/screen_login_landing_terms.png');

  // 5. Test clicking Contact Support Modal
  console.log('Testing Contact Modal...');
  await page.evaluate(() => {
    openLegalModal('contact');
  });
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: 'public/screen_login_landing_contact.png', fullPage: false });
  console.log('Saved public/screen_login_landing_contact.png');

  // 6. Test Stealth Operator Vault Modal
  console.log('Testing Stealth Operator Vault Console...');
  await page.evaluate(() => {
    closeLegalModal();
    openAdminVaultModal();
  });
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: 'public/screen_login_landing_vault.png', fullPage: false });
  console.log('Saved public/screen_login_landing_vault.png');

  await browser.close();
  console.log('Puppeteer test finished successfully!');
})();
