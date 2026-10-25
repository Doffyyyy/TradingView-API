const puppeteer = require('D:/AutocmtX/twitter-comment-pack-v2/node_modules/puppeteer-core');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1040, height: 640 });

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Cormorant+Garamond:wght@600;700&family=Syncopate:wght@700&family=Syne:wght@700;800&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet">
    <style>
      body {
        background: #07090e;
        color: #fff;
        font-family: sans-serif;
        padding: 36px 40px;
        margin: 0;
        box-sizing: border-box;
      }
      .card {
        background: rgba(15, 20, 30, 0.65);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 14px;
        padding: 18px 24px;
        margin-bottom: 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      }
      .brand-box {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .logo-icon {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: linear-gradient(135deg, #b8432e 0%, #ea580c 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 0 18px rgba(234, 88, 12, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.2);
      }
      .logo-icon svg { width: 18px; height: 18px; color: #fff; }
      .desc {
        font-size: 12px;
        color: #94a3b8;
        font-family: 'Space Grotesk', sans-serif;
      }
      .tag {
        font-size: 11px;
        font-weight: 700;
        padding: 4px 10px;
        border-radius: 6px;
        background: rgba(251, 146, 60, 0.15);
        color: #fb923c;
        border: 1px solid rgba(251, 146, 60, 0.3);
      }
      .opt-num { font-size: 13px; font-weight: 700; color: #38bdf8; margin-right: 12px; font-family: monospace; }

      /* OPTION 1: Syncopate (Wide Cinematic Architectural) */
      .f-syncopate {
        font-family: 'Syncopate', sans-serif;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 4px;
        background: linear-gradient(180deg, #ffffff 40%, #cbd5e1 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      /* OPTION 2: Syne (Avant-Garde Dark Luxury) */
      .f-syne {
        font-family: 'Syne', sans-serif;
        font-size: 18px;
        font-weight: 800;
        letter-spacing: 2px;
        background: linear-gradient(180deg, #ffffff 50%, #e2e8f0 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      /* OPTION 3: Cormorant Garamond / Refined Roman (Classic Dark Romanticism) */
      .f-cormorant {
        font-family: 'Cormorant Garamond', serif;
        font-size: 22px;
        font-weight: 700;
        letter-spacing: 4px;
        text-transform: uppercase;
        color: #f8fafc;
      }

      /* OPTION 4: Space Grotesk (Modern High-Tech Quantitative) */
      .f-quant {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 17px;
        font-weight: 700;
        letter-spacing: 3px;
        text-transform: uppercase;
        color: #fff;
      }
    </style>
  </head>
  <body>
    <div style='margin-bottom: 22px;'>
      <div style='font-size: 18px; font-weight: 800; color: #fff; margin-bottom: 4px; font-family: "Cinzel", serif;'>
        BẢNG THỬ NGHIỆM FONT CHỮ LOGO "HYPERVIEW"
      </div>
      <div style='font-size: 12.5px; color: #94a3b8;'>
        Phối màu cùng biểu tượng khối lăng kính hổ phách mới thay cho logo tên lửa cũ
      </div>
    </div>

    <!-- Opt 1 -->
    <div class='card'>
      <div class='brand-box'>
        <span class='opt-num'>01</span>
        <div class='logo-icon'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2'><polygon points='12 2 2 7 12 12 22 7 12 2'/><polyline points='2 17 12 22 22 17'/><polyline points='2 12 12 17 22 12'/></svg></div>
        <span class='f-syncopate'>HYPERVIEW</span>
        <span style='width:6px; height:6px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981;'></span>
      </div>
      <div>
        <span class='tag'>Đề xuất #1</span>
        <span class='desc' style='margin-left: 12px;'>Syncopate Wide — Trải rộng điện ảnh (Cinematic), sang và rất ngầu</span>
      </div>
    </div>

    <!-- Opt 2 -->
    <div class='card'>
      <div class='brand-box'>
        <span class='opt-num'>02</span>
        <div class='logo-icon'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2'><polygon points='12 2 2 7 12 12 22 7 12 2'/><polyline points='2 17 12 22 22 17'/><polyline points='2 12 12 17 22 12'/></svg></div>
        <span class='f-syne'>HYPERVIEW</span>
        <span style='width:6px; height:6px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981;'></span>
      </div>
      <div>
        <span class='tag'>Đề xuất #2</span>
        <span class='desc' style='margin-left: 12px;'>Syne — Nghệ thuật đương đại (Dark Luxury), đường nét đậm & dứt khoát</span>
      </div>
    </div>

    <!-- Opt 3 -->
    <div class='card'>
      <div class='brand-box'>
        <span class='opt-num'>03</span>
        <div class='logo-icon'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2'><polygon points='12 2 2 7 12 12 22 7 12 2'/><polyline points='2 17 12 22 22 17'/><polyline points='2 12 12 17 22 12'/></svg></div>
        <span class='f-cormorant'>HYPERVIEW</span>
        <span style='width:6px; height:6px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981;'></span>
      </div>
      <div>
        <span class='tag'>Tân cổ điển</span>
        <span class='desc' style='margin-left: 12px;'>Cormorant Garamond — Phong cách viện bảo tàng châu Âu, thanh thoát</span>
      </div>
    </div>

    <!-- Opt 4 -->
    <div class='card'>
      <div class='brand-box'>
        <span class='opt-num'>04</span>
        <div class='logo-icon'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2'><polygon points='12 2 2 7 12 12 22 7 12 2'/><polyline points='2 17 12 22 22 17'/><polyline points='2 12 12 17 22 12'/></svg></div>
        <span class='f-quant'>HYPERVIEW</span>
        <span style='width:6px; height:6px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981;'></span>
      </div>
      <div>
        <span class='tag'>Định chế tài chính</span>
        <span class='desc' style='margin-left: 12px;'>Space Grotesk — Hiện đại, chuẩn Quỹ đầu tư & Trading Terminal</span>
      </div>
    </div>
  </body>
  </html>
  `;

  await page.setContent(html, { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1200));
  await page.screenshot({ path: 'public/font_options_comparison.png', fullPage: false });
  await browser.close();
  console.log('Comparison image saved to public/font_options_comparison.png');
})();
