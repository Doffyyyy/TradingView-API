const puppeteer = require('D:/AutocmtX/twitter-comment-pack-v2/node_modules/puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 420 });

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Syncopate:wght@700&family=Syne:wght@700;800&family=Plus+Jakarta+Sans:wght@600;700&display=swap" rel="stylesheet">
    <style>
      body {
        background: #07090e;
        color: #fff;
        font-family: 'Plus Jakarta Sans', sans-serif;
        padding: 40px;
        margin: 0;
      }
      .nav-island {
        width: 100%;
        max-width: 1100px;
        height: 60px;
        background: rgba(14, 18, 26, 0.45);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 999px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 28px;
        margin-bottom: 24px;
        box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6);
        box-sizing: border-box;
      }
      .brand-group {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .logo-icon {
        width: 26px;
        height: 26px;
        border-radius: 6px;
        background: linear-gradient(135deg, #b8432e 0%, #ea580c 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 0 12px rgba(234, 88, 12, 0.4);
      }
      .logo-icon svg { width: 15px; height: 15px; color: #fff; }
      .nav-links {
        display: flex;
        gap: 24px;
        font-size: 13px;
        color: #cbd5e1;
        font-weight: 500;
      }
      .cta-btn {
        background: linear-gradient(135deg, #7c1d1d 0%, #450a0a 100%);
        border: 1px solid rgba(248, 113, 113, 0.4);
        padding: 7px 18px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        color: #fff;
      }
      .tag-label {
        font-size: 11.5px;
        font-weight: 700;
        color: #fb923c;
        margin-bottom: 8px;
        display: block;
        letter-spacing: 0.5px;
      }
    </style>
  </head>
  <body>
    <!-- OPTION A: Cormorant Garamond -->
    <div>
      <span class="tag-label">LỰA CHỌN A: CORMORANT GARAMOND (CỔ ĐIỂN - QUÝ PHÁI - HỢP TRANH SƠN DẦU NHẤT)</span>
      <div class="nav-island">
        <div class="brand-group">
          <div class="logo-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></div>
          <span style="font-family:'Cormorant Garamond', serif; font-size: 21px; font-weight: 700; letter-spacing: 4px; text-transform: uppercase; color: #fff;">HYPERVIEW</span>
          <span style="width:7px; height:7px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981;"></span>
        </div>
        <div class="nav-links">
          <span>Intelligence</span><span>Web3 Security</span><span>Risk Engine</span><span>Terms</span><span>Contact</span>
        </div>
        <div class="cta-btn">Access Terminal</div>
      </div>
    </div>

    <!-- OPTION B: Syncopate -->
    <div>
      <span class="tag-label" style="color: #38bdf8;">LỰA CHỌN B: SYNCOPATE (HIỆN ĐẠI - TRẢI RỘNG ĐIỆN ẢNH - CINEMATIC)</span>
      <div class="nav-island">
        <div class="brand-group">
          <div class="logo-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></div>
          <span style="font-family:'Syncopate', sans-serif; font-size: 15px; font-weight: 700; letter-spacing: 4px; text-transform: uppercase; color: #fff;">HYPERVIEW</span>
          <span style="width:7px; height:7px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981;"></span>
        </div>
        <div class="nav-links">
          <span>Intelligence</span><span>Web3 Security</span><span>Risk Engine</span><span>Terms</span><span>Contact</span>
        </div>
        <div class="cta-btn">Access Terminal</div>
      </div>
    </div>
  </body>
  </html>
  `;

  await page.setContent(html, { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'public/navbar_font_preview.png', fullPage: false });
  await browser.close();
  console.log('Navbar preview saved to public/navbar_font_preview.png');
})();
