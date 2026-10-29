const puppeteer = require('D:/AutocmtX/twitter-comment-pack-v2/node_modules/puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1600,950']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });

  // 1. Claim admin
  await page.goto('http://localhost:8095/login', { waitUntil: 'networkidle2' });
  await page.evaluate(async () => {
    await fetch('/api/auth/claim-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterKey: '0711' })
    });
  });

  // 2. Go to terminal & paper trade tab
  await page.goto('http://localhost:8095/terminal', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1000));

  await page.evaluate(() => {
    const btn = document.querySelector('button[data-target="view-paper"]');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 800));

  // 3. Inject the 3 test positions matching user screenshot (BTC, SOL, ETH)
  const testPositions = [
    {
      id: 'pos_btc_test',
      symbol: 'BINANCE:BTCUSDT',
      side: 'SHORT',
      leverage: 2,
      entryPrice: 80579.25,
      currentPrice: 79934.00,
      takeProfit: 77654.22,
      stopLoss: 81908.81,
      margin: 2042.16,
      notional: 4084.32,
      unrealizedPnl: 32.71,
      unrealizedPnlPercent: 1.60
    },
    {
      id: 'pos_sol_test',
      symbol: 'BINANCE:SOLUSDT',
      side: 'SHORT',
      leverage: 2,
      entryPrice: 101.64,
      currentPrice: 99.55,
      takeProfit: 97.94,
      stopLoss: 101.23,
      margin: 1017.78,
      notional: 2035.56,
      unrealizedPnl: 41.78,
      unrealizedPnlPercent: 4.11
    },
    {
      id: 'pos_eth_test',
      symbol: 'BINANCE:ETHUSDT',
      side: 'SHORT',
      leverage: 2,
      entryPrice: 2341.86,
      currentPrice: 2301.90,
      takeProfit: 2256.85,
      stopLoss: 2332.49,
      margin: 1021.17,
      notional: 2042.35,
      unrealizedPnl: 34.85,
      unrealizedPnlPercent: 3.41
    }
  ];

  await page.evaluate((positions) => {
    function fmtP(val) {
      if (typeof val !== 'number' || isNaN(val)) return '0.00';
      if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (val >= 1) return val.toFixed(2);
      if (val >= 0.01) return val.toFixed(4);
      return val.toFixed(6);
    }
    function extractCoinName(symbol) {
      if (!symbol) return '';
      let s = symbol.toUpperCase();
      if (s.includes(':')) s = s.split(':')[1];
      return s.replace(/\.P$/i, '').replace(/[-_]?(USDT|USDC|USD|FDUSD)$/i, '').trim();
    }

    const posBody = document.querySelector('#table-paper-positions tbody');
    if (posBody) {
      posBody.innerHTML = positions.map(p => {
        const coin = extractCoinName(p.symbol);
        const upnl = p.unrealizedPnl || 0;
        const upnlPct = p.unrealizedPnlPercent !== undefined ? p.unrealizedPnlPercent : '0.00';
        return `
        <tr id="pos-row-${p.id}" data-pos-id="${p.id}" data-coin="${coin}" data-side="${p.side}" data-entry="${p.entryPrice}" data-size="${p.notional / p.entryPrice}" data-margin="${p.margin}">
          <td class="pos-col-symbol"><strong>${p.symbol}</strong></td>
          <td class="pos-col-side" style="text-align: center;"><span class="action-badge ${p.side === 'LONG' ? 'action-buy' : 'action-sell'}">${p.side}</span></td>
          <td class="pos-col-lev" style="text-align: center;"><span class="action-badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 800;">${p.leverage || 1}x</span></td>
          <td class="pos-col-entry">$${fmtP(p.entryPrice)}</td>
          <td class="pos-col-mark"><span id="pos-mark-${p.id}" style="font-weight: 700; color: #fff; transition: color 0.15s ease;" data-last-px="${p.currentPrice}">$${fmtP(p.currentPrice)}</span></td>
          <td class="pos-col-tp val-green">$${fmtP(p.takeProfit)}</td>
          <td class="pos-col-sl val-red">$${fmtP(p.stopLoss)}</td>
          <td class="pos-col-margin" style="color: #e4e7eb;">$${fmtP(p.margin)}</td>
          <td class="pos-col-notional" style="color: var(--text-secondary);">$${fmtP(p.notional)}</td>
          <td class="pos-col-pnl">
            <span id="pos-pnl-${p.id}" class="${upnl >= 0 ? 'val-green' : 'val-red'}" style="font-weight: 700;">
              ${upnl >= 0 ? '+$' : '-$'}${Math.abs(upnl).toFixed(2)} (${upnlPct >= 0 ? '+' : ''}${upnlPct}% ROE)
            </span>
          </td>
          <td class="pos-col-action" style="text-align: center;">
            <button class="btn" style="padding: 2px 8px; font-size: 11px; background: rgba(239, 83, 80, 0.2); color: #ef5350;">Close</button>
          </td>
        </tr>
      `;
      }).join('');
    }
  }, testPositions);

  // 4. Measure column widths before and after rapid price updates
  const getColXPositions = async () => {
    return await page.evaluate(() => {
      const row = document.querySelector('#pos-row-pos_btc_test');
      if (!row) return null;
      const cells = Array.from(row.querySelectorAll('td'));
      return cells.map((cell, idx) => ({
        col: idx,
        left: Math.round(cell.getBoundingClientRect().left * 100) / 100,
        width: Math.round(cell.getBoundingClientRect().width * 100) / 100
      }));
    });
  };

  const beforeCols = await getColXPositions();
  console.log('Initial Column Layout Profile:', beforeCols);

  // Rapidly mutate BTC and SOL mark prices across 10 iterations with wildly varying numbers
  const testPrices = [
    { coin: 'BTC', px: 80899.99 },
    { coin: 'SOL', px: 95.123 },
    { coin: 'BTC', px: 79123.10 },
    { coin: 'SOL', px: 104.88 },
    { coin: 'BTC', px: 82500.50 },
    { coin: 'BTC', px: 77999.00 },
    { coin: 'SOL', px: 99.55 },
    { coin: 'BTC', px: 80579.25 }
  ];
  let maxColDrift = 0;

  for (const item of testPrices) {
    await page.evaluate(({ coin, px }) => {
      if (typeof updatePositionRowLivePrice === 'function') {
        updatePositionRowLivePrice(coin, px);
      }
    }, item);

    const afterCols = await getColXPositions();
    if (beforeCols && afterCols) {
      for (let i = 0; i < beforeCols.length; i++) {
        const drift = Math.abs(beforeCols[i].left - afterCols[i].left) + Math.abs(beforeCols[i].width - afterCols[i].width);
        if (drift > maxColDrift) maxColDrift = drift;
      }
    }
  }

  console.log('========================================================');
  console.log('Maximum Column Layout Drift across price mutations:', maxColDrift, 'px');
  console.log('Result: ' + (maxColDrift === 0 ? '✅ 100% PERFECT ZERO JITTER (0px movement)' : '❌ Jitter detected'));
  console.log('========================================================');

  // Screenshot the positions table card
  const tableEl = await page.$('#table-paper-positions');
  if (tableEl) {
    await tableEl.screenshot({ path: 'D:/TradingView-API/public/screen_fixed_paper_positions.png' });
    console.log('Saved screenshot: public/screen_fixed_paper_positions.png');
  }

  await browser.close();
})();
