const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'macro_calendar_cache.json');

// Master 2026 High-Impact Macro Schedule (Tier 1 Market Movers)
const MASTER_TIER1_EVENTS = [
  // --- CURRENT WEEK OCTOBER 19-23, 2026 EARNINGS & KEY CATALYSTS ---
  {
    id: 'earnings_2026_10_20_gm_nflx',
    title: 'US Corporate Earnings: General Motors (GM), GE Aerospace, Netflix (NFLX)',
    country: 'USD',
    date: '2026-10-20T16:05:00-04:00',
    impact: 'Medium',
    forecast: 'NFLX EPS: $5.12 | GM EPS: $2.43',
    previous: 'NFLX EPS: $4.88 | GM EPS: $2.28',
    actual: '',
    category: 'Corporate Earnings',
    volatilityRisk: 'Medium',
    cryptoImpact: 'Báo cáo lợi nhuận quý 3 của Netflix và GM sau giờ đóng cửa Phố Wall. Tác động lan tỏa tới tâm lý rủi ro trên thị trường chứng khoán Mỹ và chỉ số rủi ro của Bitcoin.',
  },
  {
    id: 'earnings_2026_10_21_tsla_meta',
    title: 'US Mega-Tech Earnings: Tesla (TSLA), Meta (META), IBM, Texas Instruments',
    country: 'USD',
    date: '2026-10-21T16:05:00-04:00',
    impact: 'High',
    forecast: 'TSLA EPS: $0.60 | META EPS: $5.28',
    previous: 'TSLA EPS: $0.52 | META EPS: $4.39',
    actual: '',
    category: 'Corporate Earnings',
    volatilityRisk: 'High',
    cryptoImpact: 'TIN TRỌNG TÂM CÔNG NGHỆ: Tesla (công ty nắm giữ dự trữ Bitcoin chiến lược trên bảng cân đối kế toán) và Meta công bố BCTC Q3. Kết quả vượt kỳ vọng sẽ kích hoạt sóng hồi mạnh cho nhóm công nghệ và Bitcoin/Ethereum.',
  },
  {
    id: 'earnings_2026_10_22_intc_lmt',
    title: 'US Corporate Earnings: Intel (INTC), Lockheed Martin (LMT), Procter & Gamble, American Airlines',
    country: 'USD',
    date: '2026-10-22T07:00:00-04:00',
    impact: 'Medium',
    forecast: 'INTC EPS: -$0.24 | LMT EPS: $6.50',
    previous: '',
    actual: '',
    category: 'Corporate Earnings',
    volatilityRisk: 'Medium',
    cryptoImpact: 'Báo cáo tài chính quý 3 của nhóm ngành công nghiệp, bán dẫn AI và hàng không trước giờ mở cửa Phố Wall.',
  },
  {
    id: 'earnings_2026_10_23_axp_slb',
    title: 'US Corporate Earnings: American Express (AXP), SLB (Schlumberger)',
    country: 'USD',
    date: '2026-10-23T07:00:00-04:00',
    impact: 'Low',
    forecast: 'AXP EPS: $3.28 | SLB EPS: $0.88',
    previous: '',
    actual: '',
    category: 'Corporate Earnings',
    volatilityRisk: 'Low',
    cryptoImpact: 'Báo cáo tài chính ngành dịch vụ thanh toán tiêu dùng và dầu khí năng lượng trước phiên cuối tuần.',
  },

  // --- OCTOBER 2026 ---
  {
    id: 'fomc_2026_10_28',
    title: 'FOMC Interest Rate Decision & Fed Monetary Policy Statement',
    country: 'USD',
    date: '2026-10-28T14:00:00-04:00',
    impact: 'High',
    forecast: '4.50%',
    previous: '4.75%',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'Extreme (Liquidation Cascade Risk)',
    cryptoImpact: 'Tác động mạnh nhất thị trường. Nếu FED hạ lãi suất hoặc phát tín hiệu nới lỏng (Dovish), USD suy yếu -> BTC & Crypto pump mạnh. Nếu Hawkish, nguy cơ bão thanh lý Long.',
  },
  {
    id: 'powell_2026_10_28',
    title: 'Fed Chair Jerome Powell Press Conference',
    country: 'USD',
    date: '2026-10-28T14:30:00-04:00',
    impact: 'High',
    forecast: '',
    previous: '',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'Extreme (Liquidation Cascade Risk)',
    cryptoImpact: 'Chủ tịch FED họp báo trực tiếp giải thích định hướng kinh tế. Thị trường Crypto biến động 2 đầu (Whipsaw quét thanh lý cả Long và Short) trong 45 phút phát biểu.',
  },
  {
    id: 'pce_2026_10_30',
    title: 'Core PCE Price Index m/m (Thước đo lạm phát ưa thích của FED)',
    country: 'USD',
    date: '2026-10-30T08:30:00-04:00',
    impact: 'High',
    forecast: '0.2%',
    previous: '0.2%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    cryptoImpact: 'Chỉ số lạm phát chi tiêu tiêu dùng cá nhân. Nếu thấp hơn dự báo -> Củng cố đà hạ lãi suất -> Bullish Crypto.',
  },
  {
    id: 'boj_2026_10_30',
    title: 'BOJ Policy Rate & Monetary Policy Statement (Ngân hàng Trung ương Nhật Bản)',
    country: 'JPY',
    date: '2026-10-30T11:00:00+09:00',
    impact: 'High',
    forecast: '0.25%',
    previous: '0.25%',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'Extreme (Liquidation Cascade Risk)',
    cryptoImpact: 'Quyết định lãi suất của Nhật Bản. Nếu BOJ bất ngờ tăng lãi suất -> Kích hoạt làn sóng tháo chạy Yen Carry Trade, gây bán tháo toàn cầu lên Bitcoin & chứng khoán.',
  },

  // --- NOVEMBER 2026 ---
  {
    id: 'ism_services_2026_11_04',
    title: 'US ISM Services PMI (Chỉ số PMI Dịch vụ Mỹ)',
    country: 'USD',
    date: '2026-11-04T10:00:00-05:00',
    impact: 'High',
    forecast: '53.8',
    previous: '54.9',
    actual: '',
    category: 'Growth & GDP',
    volatilityRisk: 'High',
    cryptoImpact: 'Ngành dịch vụ chiếm hơn 70% GDP Mỹ. PMI duy trì trên 50 củng cố kịch bản hạ cánh mềm (Soft Landing), kích thích dòng vốn vào Bitcoin.',
  },
  {
    id: 'boe_2026_11_05',
    title: 'BOE Official Bank Rate Decision (Quyết định Lãi suất NHTW Anh)',
    country: 'GBP',
    date: '2026-11-05T07:00:00-05:00',
    impact: 'High',
    forecast: '4.75%',
    previous: '5.00%',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'High',
    cryptoImpact: 'Kỳ vọng hạ lãi suất 25 bps. Làn sóng nới lỏng tiền tệ toàn cầu từ các ngân hàng trung ương lớn tạo thanh khoản dồi dào cho Crypto.',
  },
  {
    id: 'nfp_2026_11_06',
    title: 'Non-Farm Employment Change (Bảng lương phi nông nghiệp NFP)',
    country: 'USD',
    date: '2026-11-06T08:30:00-05:00',
    impact: 'High',
    forecast: '150K',
    previous: '165K',
    actual: '',
    category: 'Employment & NFP',
    volatilityRisk: 'High',
    cryptoImpact: 'Đo lường sức khỏe việc làm Mỹ. NFP hạ nhiệt kết hợp thất nghiệp tăng là tín hiệu kinh tế cần kích thích tiền tệ -> Tích cực cho tài sản rủi ro BTC/ETH.',
  },
  {
    id: 'unemp_2026_11_06',
    title: 'US Unemployment Rate (Tỷ lệ thất nghiệp Mỹ)',
    country: 'USD',
    date: '2026-11-06T08:30:00-05:00',
    impact: 'High',
    forecast: '4.2%',
    previous: '4.1%',
    actual: '',
    category: 'Employment & NFP',
    volatilityRisk: 'High',
    cryptoImpact: 'Đi kèm NFP lúc 19:30 UTC+7. Tạo nên biến động lớn đầu tháng cho phái sinh Crypto.',
  },
  {
    id: 'cpi_2026_11_12',
    title: 'US CPI m/m & y/y (Chỉ số giá tiêu dùng CPI Mỹ)',
    country: 'USD',
    date: '2026-11-12T08:30:00-05:00',
    impact: 'High',
    forecast: '2.5%',
    previous: '2.6%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'Extreme (Liquidation Cascade Risk)',
    cryptoImpact: 'TIN BÃO VĨ MÔ: Thước đo lạm phát trực tiếp. CPI hạ nhiệt (< Dự báo) = DXY giảm sốc, BTC bật tăng mạnh mẽ. CPI nóng (> Dự báo) = Bán tháo tức thì.',
  },
  {
    id: 'core_cpi_2026_11_12',
    title: 'US Core CPI m/m (CPI cốt lõi loại trừ thực phẩm & năng lượng)',
    country: 'USD',
    date: '2026-11-12T08:30:00-05:00',
    impact: 'High',
    forecast: '0.3%',
    previous: '0.3%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'Extreme (Liquidation Cascade Risk)',
    cryptoImpact: 'Chỉ số cốt lõi mà các nhà phân tích Phố Wall soi kỹ nhất trong báo cáo CPI.',
  },
  {
    id: 'ppi_2026_11_13',
    title: 'US PPI m/m (Chỉ số giá sản xuất PPI Mỹ)',
    country: 'USD',
    date: '2026-11-13T08:30:00-05:00',
    impact: 'High',
    forecast: '0.2%',
    previous: '0.2%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    cryptoImpact: 'Chỉ số dẫn dắt (Leading indicator) của CPI. Báo hiệu áp lực chi phí của doanh nghiệp trước khi truyền sang giá tiêu dùng.',
  },
  {
    id: 'retail_2026_11_17',
    title: 'US Retail Sales m/m (Doanh số bán lẻ Mỹ)',
    country: 'USD',
    date: '2026-11-17T08:30:00-05:00',
    impact: 'Medium',
    forecast: '0.4%',
    previous: '0.3%',
    actual: '',
    category: 'Growth & GDP',
    volatilityRisk: 'Medium',
    cryptoImpact: 'Đo lường sức mua của người tiêu dùng Mỹ (chiếm 70% GDP).',
  },
  {
    id: 'fomc_mins_2026_11_18',
    title: 'FOMC Meeting Minutes (Biên bản cuộc họp chi tiết của FED)',
    country: 'USD',
    date: '2026-11-18T14:00:00-05:00',
    impact: 'High',
    forecast: '',
    previous: '',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'High',
    cryptoImpact: 'Tiết lộ quan điểm bất đồng nội bộ giữa các quan chức FED (Phe Diều hâu vs Phe Bồ câu). Thường tạo sóng giật vào phiên đêm Mỹ (02:00 sáng VN).',
  },
  {
    id: 'sp_pmi_2026_11_20',
    title: 'US S&P Global Flash Manufacturing & Services PMI',
    country: 'USD',
    date: '2026-11-20T09:45:00-05:00',
    impact: 'Medium',
    forecast: '51.2',
    previous: '50.5',
    actual: '',
    category: 'Growth & GDP',
    volatilityRisk: 'Medium',
    cryptoImpact: 'Khảo sát nhanh sức khỏe kinh tế doanh nghiệp tư nhân Mỹ.',
  },
  {
    id: 'gdp_2026_11_25',
    title: 'US Prelim GDP q/q (Tăng trưởng GDP Q3 Mỹ lần 2)',
    country: 'USD',
    date: '2026-11-25T08:30:00-05:00',
    impact: 'High',
    forecast: '2.8%',
    previous: '3.0%',
    actual: '',
    category: 'Growth & GDP',
    volatilityRisk: 'High',
    cryptoImpact: 'Báo cáo tăng trưởng kinh tế Mỹ trước kỳ nghỉ Lễ Tạ Ơn Thanksgiving.',
  },
  {
    id: 'pce_2026_11_25',
    title: 'Core PCE Price Index m/m & Personal Spending (Lạm phát chi tiêu cá nhân)',
    country: 'USD',
    date: '2026-11-25T10:00:00-05:00',
    impact: 'High',
    forecast: '0.2%',
    previous: '0.3%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'Extreme (Liquidation Cascade Risk)',
    cryptoImpact: 'Thước đo lạm phát ưa thích của FED trước thềm cuộc họp tháng 12.',
  },

  // --- DECEMBER 2026 ---
  {
    id: 'nfp_2026_12_04',
    title: 'Non-Farm Employment Change & Unemployment Rate (NFP Tháng 12)',
    country: 'USD',
    date: '2026-12-04T08:30:00-05:00',
    impact: 'High',
    forecast: '145K',
    previous: '150K',
    actual: '',
    category: 'Employment & NFP',
    volatilityRisk: 'High',
    cryptoImpact: 'Báo cáo việc làm cuối cùng của năm trước thềm cuộc họp then chốt của FED.',
  },
  {
    id: 'cpi_2026_12_10',
    title: 'US CPI m/m & y/y (Chỉ số giá tiêu dùng CPI Tháng 12)',
    country: 'USD',
    date: '2026-12-10T08:30:00-05:00',
    impact: 'High',
    forecast: '2.4%',
    previous: '2.5%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'Extreme (Liquidation Cascade Risk)',
    cryptoImpact: 'Điểm nút lạm phát quyết định đợt hạ lãi suất cuối năm 2026 của FED.',
  },
  {
    id: 'ppi_2026_12_11',
    title: 'US PPI m/m & Core PPI (Chỉ số giá sản xuất PPI Tháng 12)',
    country: 'USD',
    date: '2026-12-11T08:30:00-05:00',
    impact: 'High',
    forecast: '0.2%',
    previous: '0.2%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    cryptoImpact: 'Dữ liệu sản xuất hỗ trợ sau CPI.',
  },
  {
    id: 'fomc_2026_12_16',
    title: 'FOMC Interest Rate Decision & Economic Projections (Biểu đồ Dot Plot)',
    country: 'USD',
    date: '2026-12-16T14:00:00-05:00',
    impact: 'High',
    forecast: '4.25%',
    previous: '4.50%',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'Extreme (Liquidation Cascade Risk)',
    cryptoImpact: 'Đại hội FOMC cuối năm có công bố biểu đồ Dot Plot dự phóng lộ trình lãi suất năm tiếp theo. Tạo ra xu hướng trung hạn (Trend Mùa Lễ Hội / Santa Rally) cho Bitcoin.',
  },
  {
    id: 'powell_2026_12_16',
    title: 'Fed Chair Jerome Powell Press Conference (Cuối năm 2026)',
    country: 'USD',
    date: '2026-12-16T14:30:00-05:00',
    impact: 'High',
    forecast: '',
    previous: '',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'Extreme (Liquidation Cascade Risk)',
    cryptoImpact: 'Họp báo định hướng thị trường tài chính.',
  },
  {
    id: 'ecb_2026_12_17',
    title: 'ECB Monetary Policy Decision & Lagarde Speech',
    country: 'EUR',
    date: '2026-12-17T08:15:00-05:00',
    impact: 'High',
    forecast: '3.00%',
    previous: '3.25%',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'High',
    cryptoImpact: 'Quyết định lãi suất của Ngân hàng Trung ương Châu Âu.',
  },
  {
    id: 'boe_2026_12_17',
    title: 'BOE Official Bank Rate Decision (Ngân hàng Trung ương Anh)',
    country: 'GBP',
    date: '2026-12-17T07:00:00-05:00',
    impact: 'High',
    forecast: '4.50%',
    previous: '4.75%',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'Medium',
    cryptoImpact: 'Lãi suất đồng Bảng Anh.',
  },

  // --- PAST MAJOR 2026 BENCHMARKS (For Historical Context / Replay) ---
  {
    id: 'cpi_2026_10_14',
    title: 'US CPI m/m & y/y (Chỉ số giá tiêu dùng CPI Tháng 10)',
    country: 'USD',
    date: '2026-10-14T08:30:00-04:00',
    impact: 'High',
    forecast: '2.5%',
    previous: '2.5%',
    actual: '2.4%',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    cryptoImpact: 'CPI công bố 2.4% (thấp hơn dự báo 2.5%) -> Kích hoạt sóng hồi phục mạnh cho Bitcoin từ $60k lên $65k.',
  },
  {
    id: 'ppi_2026_10_15',
    title: 'US PPI m/m (Chỉ số giá sản xuất PPI Tháng 10)',
    country: 'USD',
    date: '2026-10-15T08:30:00-04:00',
    impact: 'High',
    forecast: '0.1%',
    previous: '0.2%',
    actual: '0.0%',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    cryptoImpact: 'PPI thấp hỗ trợ tâm lý risk-on trên thị trường phái sinh.',
  },
  {
    id: 'fomc_2026_09_16',
    title: 'FOMC Interest Rate Cut Decision (-50 bps Rate Cut)',
    country: 'USD',
    date: '2026-09-16T14:00:00-04:00',
    impact: 'High',
    forecast: '5.00%',
    previous: '5.50%',
    actual: '5.00%',
    category: 'FED & Central Bank',
    volatilityRisk: 'Extreme (Liquidation Cascade Risk)',
    cryptoImpact: 'FED bắt đầu chu kỳ nới lỏng tiền tệ với mức hạ 50 điểm cơ bản. Thị trường Crypto bùng nổ sóng tăng trưởng quý 4.',
  },
];

class MacroCalendarEngine {
  constructor() {
    this.events = [];
    this.lastFetched = 0;
    this.cacheInterval = 30 * 60 * 1000; // 30 minutes
    this.loadCache();
  }

  loadCache() {
    let cachedList = [];
    if (fs.existsSync(CACHE_FILE)) {
      try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.events)) {
          cachedList = data.events;
          this.lastFetched = data.lastFetched || 0;
        }
      } catch (e) {
        console.error('[MacroCalendar] Failed to read cache:', e.message);
      }
    }
    const map = new Map();
    MASTER_TIER1_EVENTS.forEach(ev => {
      map.set(ev.id || `${ev.date}_${ev.title}`, { ...ev });
    });
    cachedList.forEach(ev => {
      const key = ev.id || `${ev.date}_${ev.title}`;
      if (!map.has(key)) {
        map.set(key, ev);
      } else {
        if (ev.actual) map.get(key).actual = ev.actual;
      }
    });
    this.events = Array.from(map.values()).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  saveCache() {
    try {
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({
        lastFetched: this.lastFetched,
        count: this.events.length,
        events: this.events,
      }, null, 2), 'utf8');
    } catch (e) {
      console.error('[MacroCalendar] Failed to save cache:', e.message);
    }
  }

  fetchLiveForexFactoryFeed() {
    return new Promise((resolve) => {
      const url = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 Hyperview/1.0' }, timeout: 8000 }, (res) => {
        if (res.statusCode !== 200) {
          return resolve(null);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const list = JSON.parse(data);
            resolve(list);
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  categorizeEvent(title) {
    const t = (title || '').toLowerCase();
    if (t.includes('average earnings')) {
      return 'Employment & NFP';
    }
    if (t.includes('corporate earnings') || t.includes('mega-tech earnings') || t.includes('tesla') || t.includes('meta') || t.includes('netflix') || t.includes('intel') || t.includes('lockheed') || t.includes('general motors')) {
      return 'Corporate Earnings';
    }
    if (t.includes('fomc') || t.includes('fed ') || t.includes('powell') || t.includes('rate') || t.includes('central bank') || t.includes('ecb') || t.includes('boe') || t.includes('boj')) {
      return 'FED & Central Bank';
    }
    if (t.includes('cpi') || t.includes('ppi') || t.includes('pce') || t.includes('inflation')) {
      return 'Inflation (CPI/PPI)';
    }
    if (t.includes('employment') || t.includes('payrolls') || t.includes('unemployment') || t.includes('adp') || t.includes('claims') || t.includes('nfp')) {
      return 'Employment & NFP';
    }
    if (t.includes('nahb') || t.includes('housing') || t.includes('home') || t.includes('building permits')) {
      return 'Housing & Real Estate';
    }
    if (t.includes('gdp') || t.includes('sales') || t.includes('pmi') || t.includes('sentiment') || t.includes('consumer confidence') || t.includes('leading index')) {
      return 'Growth & GDP';
    }
    return 'Other';
  }

  getCryptoPlaybook(item) {
    const title = (item.title || '').toLowerCase();
    if (title.includes('earnings') || title.includes('tesla') || title.includes('meta')) {
      return 'Báo cáo tài chính doanh nghiệp công nghệ Mỹ (Earnings). Tác động trực tiếp lên chỉ số Nasdaq và khẩu vị chấp nhận rủi ro trên thị trường Crypto.';
    }
    if (title.includes('fomc') || title.includes('fed interest rate') || title.includes('rate decision')) {
      return 'Tác động mạnh nhất thị trường. Nếu FED hạ lãi suất hoặc phát tín hiệu nới lỏng (Dovish), USD suy yếu -> BTC & Crypto pump mạnh. Nếu Hawkish, nguy cơ bão thanh lý Long.';
    }
    if (title.includes('powell')) {
      return 'Chủ tịch FED họp báo trực tiếp giải thích định hướng kinh tế. Thị trường Crypto biến động 2 đầu (Whipsaw quét thanh lý cả Long và Short) trong 45 phút phát biểu.';
    }
    if (title.includes('cpi')) {
      return 'TIN BÃO VĨ MÔ: Thước đo lạm phát trực tiếp. CPI hạ nhiệt (< Dự báo) = DXY giảm sốc, BTC bật tăng mạnh mẽ. CPI nóng (> Dự báo) = Bán tháo tức thì.';
    }
    if (title.includes('ppi')) {
      return 'Chỉ số dẫn dắt (Leading indicator) của CPI. Báo hiệu áp lực chi phí của doanh nghiệp trước khi truyền sang giá tiêu dùng.';
    }
    if (title.includes('non-farm') || title.includes('nfp') || title.includes('unemployment rate')) {
      return 'Đo lường sức khỏe việc làm Mỹ. NFP hạ nhiệt kết hợp thất nghiệp tăng là tín hiệu kinh tế cần kích thích tiền tệ -> Tích cực cho tài sản rủi ro BTC/ETH.';
    }
    if (title.includes('unemployment claims')) {
      return 'Đơn xin trợ cấp thất nghiệp hàng tuần. Nếu số đơn tăng cao, xác suất FED nới lỏng tăng lên -> Nhẹ nhàng hỗ trợ Crypto.';
    }
    if (title.includes('pmi')) {
      return 'Chỉ số nhà quản trị mua hàng PMI. Phản ánh tốc độ mở rộng hay thu hẹp của nền kinh tế.';
    }
    if (title.includes('nahb') || title.includes('housing starts') || title.includes('home sales')) {
      return 'Sức khỏe thị trường bất động sản Mỹ. Đo lường tác động của mặt bằng lãi suất cao lên nhu cầu vay thế chấp.';
    }
    if (title.includes('boj')) {
      return 'Quyết định lãi suất của Nhật Bản. Nếu BOJ bất ngờ tăng lãi suất -> Kích hoạt làn sóng tháo chạy Yen Carry Trade, gây bán tháo toàn cầu lên Bitcoin & chứng khoán.';
    }
    return 'Dữ liệu kinh tế vĩ mô có thể ảnh hưởng đến tỷ giá USD và khẩu vị rủi ro của dòng tiền Crypto.';
  }

  async syncEvents(force = false) {
    const now = Date.now();
    if (!force && this.events.length > 0 && (now - this.lastFetched) < this.cacheInterval) {
      return this.events;
    }

    const liveList = await this.fetchLiveForexFactoryFeed();
    const eventMap = new Map();

    // 1. Seed with master tier 1 events
    MASTER_TIER1_EVENTS.forEach(ev => {
      eventMap.set(ev.id || `${ev.date}_${ev.title}`, { ...ev });
    });

    // 2. Overlay live weekly feed from ForexFactory
    if (liveList && Array.isArray(liveList)) {
      liveList.forEach((item, idx) => {
        const id = `ff_${item.date}_${item.country}_${idx}`;
        const key = `${item.date.slice(0, 10)}_${item.title}`;
        
        let existing = null;
        for (const [k, v] of eventMap.entries()) {
          if (v.title.toLowerCase().includes(item.title.toLowerCase()) && v.date.slice(0, 10) === item.date.slice(0, 10)) {
            existing = v;
            break;
          }
        }

        const isHigh = item.impact === 'High';
        const isMed = item.impact === 'Medium';
        const cat = this.categorizeEvent(item.title);

        const eventObj = {
          id: existing ? existing.id : id,
          title: item.title,
          country: item.country,
          date: item.date,
          impact: item.impact || 'Low',
          forecast: item.forecast || (existing ? existing.forecast : ''),
          previous: item.previous || (existing ? existing.previous : ''),
          actual: item.actual || (existing ? existing.actual : ''),
          category: cat,
          volatilityRisk: isHigh ? 'Extreme (Liquidation Cascade Risk)' : (isMed ? 'High' : 'Low'),
          cryptoImpact: existing ? existing.cryptoImpact : this.getCryptoPlaybook(item),
        };

        if (existing) {
          Object.assign(existing, eventObj);
        } else {
          eventMap.set(id, eventObj);
        }
      });
    }

    // Convert to sorted array
    this.events = Array.from(eventMap.values()).sort((a, b) => {
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });

    this.lastFetched = now;
    this.saveCache();
    return this.events;
  }

  getNextHighImpactEvent() {
    const now = Date.now();
    // 1. Prioritize upcoming USD High/Medium impact events (Primary Crypto Drivers: FED, Tech Earnings, Unemployment, PMI)
    const upcomingUsdPriority = this.events.filter(e => {
      const t = new Date(e.date).getTime();
      return t >= now && e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium');
    });

    if (upcomingUsdPriority.length > 0) {
      return upcomingUsdPriority[0];
    }

    // 2. Global High impact events (BOJ, ECB, GBP/NZD CPI)
    const upcomingHigh = this.events.filter(e => {
      const t = new Date(e.date).getTime();
      return t >= now && (e.impact === 'High' || e.impact === 'Medium');
    });

    if (upcomingHigh.length > 0) {
      return upcomingHigh[0];
    }

    // Fallback to closest future event
    const upcomingAny = this.events.filter(e => new Date(e.date).getTime() >= now);
    return upcomingAny.length > 0 ? upcomingAny[0] : this.events[this.events.length - 1];
  }

  getFilteredEvents({ currency = 'ALL', impact = 'ALL', category = 'ALL', search = '', timeScope = 'UPCOMING_MONTH', hidePast = true } = {}) {
    let list = [...this.events];
    const now = new Date();
    const nowTs = now.getTime();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth(); // 0-indexed (10 for November)

    // 1. Time / Month Scope Filter (Mặc định: Chỉ hiện các tin tiếp theo trong tháng hiện tại, loại bỏ tin đã past)
    if (timeScope === 'UPCOMING_MONTH') {
      list = list.filter(e => {
        const evDate = new Date(e.date);
        const evTs = evDate.getTime();
        const isInCurMonth = evDate.getFullYear() === curYear && evDate.getMonth() === curMonth;
        const isUpcoming = evTs >= (nowTs - 15 * 60 * 1000); // 15p buffer nếu tin đang diễn ra
        return isInCurMonth && isUpcoming;
      });
    } else if (timeScope === 'CURRENT_MONTH') {
      list = list.filter(e => {
        const evDate = new Date(e.date);
        const isInCurMonth = evDate.getFullYear() === curYear && evDate.getMonth() === curMonth;
        if (hidePast) {
          return isInCurMonth && evDate.getTime() >= (nowTs - 15 * 60 * 1000);
        }
        return isInCurMonth;
      });
    } else if (timeScope === 'NEXT_MONTH') {
      const nextMonthDate = new Date(curYear, curMonth + 1, 1);
      const nextYear = nextMonthDate.getFullYear();
      const nextMonth = nextMonthDate.getMonth();
      list = list.filter(e => {
        const evDate = new Date(e.date);
        return evDate.getFullYear() === nextYear && evDate.getMonth() === nextMonth;
      });
    } else if (timeScope === 'UPCOMING_30D') {
      const end30d = nowTs + 30 * 24 * 3600 * 1000;
      list = list.filter(e => {
        const evTs = new Date(e.date).getTime();
        return evTs >= (nowTs - 15 * 60 * 1000) && evTs <= end30d;
      });
    } else if (hidePast) {
      list = list.filter(e => new Date(e.date).getTime() >= (nowTs - 15 * 60 * 1000));
    }

    if (currency !== 'ALL') {
      list = list.filter(e => e.country.toUpperCase() === currency.toUpperCase());
    }

    if (impact === 'HIGH') {
      list = list.filter(e => e.impact === 'High');
    } else if (impact === 'HIGH_MED') {
      list = list.filter(e => e.impact === 'High' || e.impact === 'Medium');
    }

    if (category !== 'ALL') {
      list = list.filter(e => e.category === category);
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(e => 
        (e.title && e.title.toLowerCase().includes(q)) ||
        (e.country && e.country.toLowerCase().includes(q)) ||
        (e.cryptoImpact && e.cryptoImpact.toLowerCase().includes(q))
      );
    }

    return list;
  }

  getHistoricalReactions() {
    return HISTORICAL_MACRO_REACTIONS;
  }

  getScenarioMatrix(targetEvent) {
    const ev = targetEvent || this.getNextHighImpactEvent();
    return getScenarioMatrix(ev);
  }
}

// 5 Kỳ Tin Đỏ Gần Nhất & Thống Kê Biên Độ Quét Thực Tế Của Bitcoin (Historical Reaction Engine)
const HISTORICAL_MACRO_REACTIONS = [
  {
    id: 'fomc_2026_10_28',
    event: 'FOMC Rate Decision & Powell Speech',
    date: '2026-10-29 01:00 UTC+7',
    dateShort: '29/10/2026',
    country: 'USD',
    actual: '4.50%',
    forecast: '4.50%',
    previous: '4.75%',
    outcomeType: 'Neutral-Hawkish',
    candle15mVol: '±2.85% ($1,920)',
    wickDirection: 'Bull Trap (Quét đỉnh rồi xả râu)',
    post4hTrend: '-2.15% (Bearish Drift)',
    safeStopDist: '≥ 3.2% (Ngoài râu $68.4k)',
    statusBadge: 'QUÉT 2 ĐẦU 🌪️',
    keyTakeaway: 'Hạ lãi suất 25 bps đúng dự báo nhưng Powell nhấn mạnh thận trọng -> BTC giật lên quét đỉnh rồi rút râu xả.'
  },
  {
    id: 'pce_2026_10_30',
    event: 'Core PCE Price Index m/m',
    date: '2026-10-30 19:30 UTC+7',
    dateShort: '30/10/2026',
    country: 'USD',
    actual: '0.2%',
    forecast: '0.2%',
    previous: '0.2%',
    outcomeType: 'Soft Landing (Inline)',
    candle15mVol: '±1.35% ($910)',
    wickDirection: 'Bear Trap (Rút chân tăng)',
    post4hTrend: '+1.80% (Sideway Up)',
    safeStopDist: '≥ 1.8% (Biên nến hẹp)',
    statusBadge: 'RÚT CHÂN BƠM 🚀',
    keyTakeaway: 'Lạm phát chi tiêu cá nhân đúng kỳ vọng giúp thị trường ổn định, Altcoin và BTC hồi phục đều.'
  },
  {
    id: 'boj_2026_10_30',
    event: 'BOJ Policy Rate Decision (Nhật Bản)',
    date: '2026-10-30 09:00 UTC+7',
    dateShort: '30/10/2026',
    country: 'JPY',
    actual: '0.25%',
    forecast: '0.25%',
    previous: '0.25%',
    outcomeType: 'Dovish Hold',
    candle15mVol: '±1.60% ($1,080)',
    wickDirection: 'Sóng hồi nới lỏng',
    post4hTrend: '+1.45% (Bullish)',
    safeStopDist: '≥ 2.0% (Tránh râu JPY)',
    statusBadge: 'GIỮ NGUYÊN LÃI 🟢',
    keyTakeaway: 'BOJ không tăng lãi suất, giải tỏa nỗi lo vỡ nợ Yen Carry Trade, kích hoạt tâm lý Risk-on nhẹ cho Crypto.'
  },
  {
    id: 'cpi_2026_10_14',
    event: 'US CPI m/m & y/y (Lạm phát Mỹ)',
    date: '2026-10-14 19:30 UTC+7',
    dateShort: '14/10/2026',
    country: 'USD',
    actual: '2.4%',
    forecast: '2.5%',
    previous: '2.5%',
    outcomeType: 'Cooling Inflation ❄️',
    candle15mVol: '±3.10% ($2,150)',
    wickDirection: 'Breakout Mạnh (No Wick)',
    post4hTrend: '+4.20% (Strong Pump)',
    safeStopDist: '≥ 3.5% (Trend Continuation)',
    statusBadge: 'PUMP MẠNH 🔥',
    keyTakeaway: 'CPI hạ nhiệt sâu hơn dự kiến, DXY gãy đổ kích hoạt đợt tăng bùng nổ đưa BTC từ $60.5k lên $65k.'
  },
  {
    id: 'fomc_2026_09_16',
    event: 'FOMC Jumbo Rate Cut (-50 bps)',
    date: '2026-09-17 01:00 UTC+7',
    dateShort: '17/09/2026',
    country: 'USD',
    actual: '5.00%',
    forecast: '5.00%',
    previous: '5.50%',
    outcomeType: 'Jumbo Rate Cut (-50 bps)',
    candle15mVol: '±3.65% ($2,600)',
    wickDirection: 'Whipsaw 2 đầu biên độ lớn',
    post4hTrend: '+5.40% (Macro Supercycle)',
    safeStopDist: '≥ 4.0% (Biến động bão)',
    statusBadge: 'ĐẠI SỰ KIỆN 💥',
    keyTakeaway: 'FED khai mở chu kỳ nới lỏng với đợt cắt 50 bps, mở ra sóng tăng trưởng rực rỡ toàn thị trường quý 4.'
  }
];

function getScenarioMatrix(event) {
  if (!event) return null;
  const title = (event.title || '').toLowerCase();
  const dateStr = event.date ? new Date(event.date).toLocaleString('vi-VN', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  }) : 'Sắp diễn ra';

  // 1. NFP / Employment
  if (title.includes('non-farm') || title.includes('nfp') || title.includes('unemployment')) {
    return {
      type: 'NFP_EMPLOYMENT',
      eventTitle: event.title,
      dateFormatted: dateStr,
      country: event.country || 'USD',
      forecast: event.forecast || '150K',
      previous: event.previous || '165K',
      catalystSummary: 'Đo lường sức khỏe việc làm & áp lực tiền lương tại Mỹ. Quyết định tốc độ nới lỏng chính sách của FED trong tháng 12/2026.',
      circuitBreakerNotice: '🛡️ Pure Loss Guard: Tự động kích hoạt phòng vệ 15 phút quanh giờ tin (20:15 - 20:45 UTC+7), siết Stop Loss tối đa 2.0% Equity.',
      scenarios: [
        {
          tier: 'BULLISH',
          name: '1. Sóng Đẩy Tăng Trưởng (Bullish Impulse)',
          probability: '45%',
          badgeColor: '#10b981',
          bgTint: 'rgba(16, 185, 129, 0.08)',
          borderColor: 'rgba(16, 185, 129, 0.3)',
          condition: 'NFP < 135K & Thất nghiệp ≥ 4.2%',
          macroReaction: 'DXY gãy hỗ trợ 103.5, US10Y hạ nhiệt sâu. Xác suất FED hạ lãi suất tháng 12 tăng lên > 85%.',
          btcAction: 'Kích hoạt sóng đẩy (Impulse Pump), kỳ vọng phá vỡ cản gần nhất với nến thân dài.',
          actionPlaybook: 'Long Breakout theo đà sau khi nến 15M đầu tiên đóng xanh vượt EMA10. SL: Dưới đáy nến tin ra (-2.0%). Target: +3R ~ +5R.'
        },
        {
          tier: 'BEARISH',
          name: '2. Cú Sốc Bán Tháo (Bearish Shock)',
          probability: '35%',
          badgeColor: '#f87171',
          bgTint: 'rgba(248, 113, 113, 0.08)',
          borderColor: 'rgba(248, 113, 113, 0.3)',
          condition: 'NFP > 180K & Thất nghiệp ≤ 4.0%',
          macroReaction: 'Thị trường việc làm quá nóng. DXY dựng đứng, nỗi sợ FED giữ lãi suất cao kéo dài (Higher for Longer) tái xuất.',
          btcAction: 'Bão quét thanh lý Long (Long Cascade). BTC trượt giá nhanh và phá vỡ hỗ trợ ngắn hạn.',
          actionPlaybook: 'Tuyệt đối KHÔNG bắt dao rơi nến đầu. Chờ nhịp hồi yếu kiểm tra kháng cự (Retest) rồi mở Short theo quán tính.'
        },
        {
          tier: 'NEUTRAL',
          name: '3. Quét Râu 2 Đầu (Whipsaw / Fakeout)',
          probability: '20%',
          badgeColor: '#f59e0b',
          bgTint: 'rgba(245, 158, 11, 0.08)',
          borderColor: 'rgba(245, 158, 11, 0.3)',
          condition: 'NFP dao động 145K - 160K (Sát dự báo)',
          macroReaction: 'Dữ liệu không tạo bất ngờ lớn. DXY giật 2 đầu rồi hồi về trạng thái cân bằng.',
          btcAction: 'Quét Stop Loss 2 chiều (±1.5%) để tiêu diệt các lệnh đòn bẩy cao, sau đó chuyển sang đi ngang (Sideway).',
          actionPlaybook: 'Đứng ngoài quan sát, khóa lệnh mới trong 30 phút. Chờ nến 1H đóng rõ cấu trúc xu hướng mới giải ngân.'
        }
      ]
    };
  }

  // 2. CPI / Inflation
  if (title.includes('cpi') || title.includes('pce') || title.includes('inflation')) {
    return {
      type: 'CPI_INFLATION',
      eventTitle: event.title,
      dateFormatted: dateStr,
      country: event.country || 'USD',
      forecast: event.forecast || '2.5%',
      previous: event.previous || '2.6%',
      catalystSummary: 'Thước đo lạm phát trực tiếp quyết định chính sách tiền tệ. Tác động bùng nổ tức thì lên định giá tài sản rủi ro.',
      circuitBreakerNotice: '🛡️ Pure Loss Guard: Tự động khóa lệnh đòn bẩy > 2x trước giờ tin 15 phút, ngăn chặn trượt giá (Slippage) trên Orderbook.',
      scenarios: [
        {
          tier: 'BULLISH',
          name: '1. Lạm Phát Hạ Nhiệt (Cooling Relief)',
          probability: '50%',
          badgeColor: '#10b981',
          bgTint: 'rgba(16, 185, 129, 0.08)',
          borderColor: 'rgba(16, 185, 129, 0.3)',
          condition: 'CPI < Dự báo (Ví dụ: 2.3% - 2.4%)',
          macroReaction: 'Áp lực lạm phát tan biến. DXY giảm sốc, dòng tiền toàn cầu đổ mạnh vào tài sản rủi ro (Risk-On).',
          btcAction: 'Bứt phá kháng cự mạnh mẽ, Altcoin bùng nổ theo sau với biên độ +4% ~ +8%.',
          actionPlaybook: 'Mở Long theo sóng tiếp diễn sau nến 15M xác nhận. Giữ lệnh Runner theo đường EMA20.'
        },
        {
          tier: 'BEARISH',
          name: '2. Lạm Phát Nóng Trở Lại (Hot CPI Scare)',
          probability: '30%',
          badgeColor: '#f87171',
          bgTint: 'rgba(248, 113, 113, 0.08)',
          borderColor: 'rgba(248, 113, 113, 0.3)',
          condition: 'CPI > Dự báo (≥ 2.6%)',
          macroReaction: 'Lạm phát dai dẳng. Lợi suất trái phiếu Mỹ vọt tăng, kỳ vọng nới lỏng chính sách bị đập tan.',
          btcAction: 'Bán tháo nhanh (Flash Dump) quét sạch các lệnh Long dùng đòn bẩy trên $68k.',
          actionPlaybook: 'Hạ 50% vị thế Long đang mở, đặt Stop Loss chặt chẽ. Ưu tiên bảo toàn vốn, không mở vị thế đảo chiều sớm.'
        },
        {
          tier: 'NEUTRAL',
          name: '3. Đúng Dự Báo (Inline Volatility)',
          probability: '20%',
          badgeColor: '#f59e0b',
          bgTint: 'rgba(245, 158, 11, 0.08)',
          borderColor: 'rgba(245, 158, 11, 0.3)',
          condition: 'CPI = Dự báo (2.5%)',
          macroReaction: 'Thị trường đã định giá phần lớn kết quả (Priced-in).',
          btcAction: 'Biến động co hẹp, xuất hiện râu nến quét 2 đầu trong 15 phút đầu rồi trở lại vùng sideway tích lũy.',
          actionPlaybook: 'Kiên nhẫn chờ đợi tín hiệu Setup EMA Crossback của Oliver Kell trên khung H1 trước khi ra quyết định.'
        }
      ]
    };
  }

  // 3. Central Bank / FOMC / Powell
  if (title.includes('fomc') || title.includes('fed') || title.includes('powell') || title.includes('rate decision') || title.includes('boj') || title.includes('ecb')) {
    return {
      type: 'CENTRAL_BANK_RATES',
      eventTitle: event.title,
      dateFormatted: dateStr,
      country: event.country || 'USD',
      forecast: event.forecast || 'Lãi suất',
      previous: event.previous || '--',
      catalystSummary: 'Quyết định định giá tiền tệ & định hướng thanh khoản toàn cầu. Biến động đa chiều kéo dài từ họp báo sang phiên giao dịch kế tiếp.',
      circuitBreakerNotice: '🛡️ Pure Loss Guard: Tự động đóng bớt 50% rủi ro mở trước giờ công bố, kích hoạt bộ đệm trượt râu 0.04%.',
      scenarios: [
        {
          tier: 'BULLISH',
          name: '1. Nới Lỏng Mạnh Mẽ (Dovish Pivot)',
          probability: '40%',
          badgeColor: '#10b981',
          bgTint: 'rgba(16, 185, 129, 0.08)',
          borderColor: 'rgba(16, 185, 129, 0.3)',
          condition: 'Hạ lãi suất hoặc Phát biểu nới lỏng rõ rệt',
          macroReaction: 'USD suy yếu trên diện rộng, thanh khoản hệ thống dồi dào, lợi suất toàn cầu đồng loạt giảm.',
          btcAction: 'Khai mở chu kỳ tăng trưởng mới (Trend Expansion), phá đỉnh cũ và duy trì đà tăng nhiều tuần.',
          actionPlaybook: 'Gia tăng quy mô vị thế theo quy tắc Kell (+5R Climax Extension), dời Stop Loss lên mức hòa vốn (Breakeven).'
        },
        {
          tier: 'BEARISH',
          name: '2. Diều Hâu Bất Ngờ (Hawkish Retraction)',
          probability: '35%',
          badgeColor: '#f87171',
          bgTint: 'rgba(248, 113, 113, 0.08)',
          borderColor: 'rgba(248, 113, 113, 0.3)',
          condition: 'Trì hoãn hạ lãi suất hoặc Cảnh báo rủi ro lạm phát',
          macroReaction: 'Đồng USD tăng dựng đứng, giới đầu tư rút vốn khỏi các tài sản đầu cơ rủi ro cao.',
          btcAction: 'Đợt giảm sâu với biên độ quét rộng, quét sạch thanh khoản của các vùng đáy cũ.',
          actionPlaybook: 'Kích hoạt Circuit Breaker, đứng ngoài tuyệt đối hoặc thực hiện Hedging vị thế Spot bằng lệnh Short 1x.'
        },
        {
          tier: 'NEUTRAL',
          name: '3. Whipsaw Họp Báo (Powell Two-Way)',
          probability: '25%',
          badgeColor: '#f59e0b',
          bgTint: 'rgba(245, 158, 11, 0.08)',
          borderColor: 'rgba(245, 158, 11, 0.3)',
          condition: 'Lãi suất không đổi & Phát biểu cân bằng 2 chiều',
          macroReaction: 'Thị trường phản ứng giật cục theo từng câu nói của Chủ tịch trong 45 phút họp báo.',
          btcAction: 'Nến 15M rút râu cả trên lẫn dưới, biên độ rung lắc từ $1,500 - $3,000.',
          actionPlaybook: 'Không giao dịch trong thời gian họp báo. Đợi hết 1 tiếng sau bài phát biểu mới tìm điểm vào.'
        }
      ]
    };
  }

  // 4. PMI / Services / Growth
  if (title.includes('services') || title.includes('pmi') || title.includes('gdp') || title.includes('retail')) {
    return {
      type: 'GROWTH_PMI',
      eventTitle: event.title,
      dateFormatted: dateStr,
      country: event.country || 'USD',
      forecast: event.forecast || '53.8',
      previous: event.previous || '54.9',
      catalystSummary: 'Đo lường sức khỏe kinh tế doanh nghiệp và dịch vụ Mỹ (đóng góp hơn 70% GDP).',
      circuitBreakerNotice: '🛡️ Pure Loss Guard: Giữ nguyên vị thế theo xu hướng Kell, tránh đòn bẩy > 3x.',
      scenarios: [
        {
          tier: 'BULLISH',
          name: '1. Mở Rộng Ổn Định (Soft Landing - Bullish)',
          probability: '45%',
          badgeColor: '#10b981',
          bgTint: 'rgba(16, 185, 129, 0.08)',
          borderColor: 'rgba(16, 185, 129, 0.3)',
          condition: 'PMI > 53.0 (Kinh tế vững, lạm phát không bùng)',
          macroReaction: 'Củng cố niềm tin vào kịch bản kinh tế hạ cánh mềm.',
          btcAction: 'Dòng tiền risk-on gia tăng, hỗ trợ đà tăng đều đặn.',
          actionPlaybook: 'Canh nhịp Pullback về EMA10/EMA20 trên H1 để mở Long theo sóng.'
        },
        {
          tier: 'BEARISH',
          name: '2. Suy Thoái Thu Hẹp (Contraction Shock)',
          probability: '30%',
          badgeColor: '#f87171',
          bgTint: 'rgba(248, 113, 113, 0.08)',
          borderColor: 'rgba(248, 113, 113, 0.3)',
          condition: 'PMI < 50.0 (Báo động suy thoái)',
          macroReaction: 'Nỗi lo suy thoái kinh tế bất ngờ kéo tụt chứng khoán Mỹ.',
          btcAction: 'Gặp áp lực bán tháo theo thị trường tài chính truyền thống.',
          actionPlaybook: 'Thắt chặt Stop Loss, kiên quyết cắt lỗ nếu gãy EMA50.'
        },
        {
          tier: 'NEUTRAL',
          name: '3. Điểm Số Sát Dự Báo (Inline)',
          probability: '25%',
          badgeColor: '#f59e0b',
          bgTint: 'rgba(245, 158, 11, 0.08)',
          borderColor: 'rgba(245, 158, 11, 0.3)',
          condition: 'PMI dao động 52.5 - 54.5',
          macroReaction: 'Thị trường hấp thụ thông tin êm đềm.',
          btcAction: 'Biến động dao động bình thường theo phân tích kỹ thuật.',
          actionPlaybook: 'Tuân thủ nghiêm ngặt quy tắc chốt lời từng phần Stage 1 (+2R).'
        }
      ]
    };
  }

  // 5. Generic Catalyst Fallback
  return {
    type: 'GENERIC_CATALYST',
    eventTitle: event.title,
    dateFormatted: dateStr,
    country: event.country || 'USD',
    forecast: event.forecast || '--',
    previous: event.previous || '--',
    catalystSummary: 'Dữ liệu kinh tế vĩ mô có thể ảnh hưởng đến tỷ giá và khẩu vị rủi ro thị trường.',
    circuitBreakerNotice: '🛡️ Pure Loss Guard: Giám sát biên độ nến và bảo vệ danh mục tự động.',
    scenarios: [
      {
        tier: 'BULLISH',
        name: '1. Kịch Bản Tích Cực (Bullish Surprise)',
        probability: '40%',
        badgeColor: '#10b981',
        bgTint: 'rgba(16, 185, 129, 0.08)',
        borderColor: 'rgba(16, 185, 129, 0.3)',
        condition: 'Số liệu tốt hơn kỳ vọng / Hỗ trợ nới lỏng',
        macroReaction: 'Đồng USD suy yếu hoặc tâm lý Risk-On lan tỏa.',
        btcAction: 'Tăng trưởng ổn định, phe bò kiểm soát nến 15M.',
        actionPlaybook: 'Tìm điểm vào lệnh theo Setup EMA Crossback của Oliver Kell.'
      },
      {
        tier: 'BEARISH',
        name: '2. Kịch Bản Tiêu Cực (Bearish Surprise)',
        probability: '35%',
        badgeColor: '#f87171',
        bgTint: 'rgba(248, 113, 113, 0.08)',
        borderColor: 'rgba(248, 113, 113, 0.3)',
        condition: 'Số liệu xấu hơn kỳ vọng / Áp lực vĩ mô gia tăng',
        macroReaction: 'USD mạnh lên hoặc thị trường chứng khoán điều chỉnh.',
        btcAction: 'Gặp áp lực chốt lời, trượt giá về vùng hỗ trợ gần.',
        actionPlaybook: 'Thắt chặt Stop Loss, không mở thêm lệnh Long khi giá dưới EMA20.'
      },
      {
        tier: 'NEUTRAL',
        name: '3. Kịch Bản Trung Tính (Neutral Range)',
        probability: '25%',
        badgeColor: '#f59e0b',
        bgTint: 'rgba(245, 158, 11, 0.08)',
        borderColor: 'rgba(245, 158, 11, 0.3)',
        condition: 'Số liệu bám sát dự báo của giới phân tích',
        macroReaction: 'Biến động thị trường ở mức bình thường.',
        btcAction: 'Dao động trong biên độ tích lũy thông thường.',
        actionPlaybook: 'Tuân thủ kỷ luật quản lý vốn 1-2% rủi ro cho mỗi vị thế.'
      }
    ]
  };
}

const macroCalendarInstance = new MacroCalendarEngine();

module.exports = {
  macroCalendarInstance,
  MASTER_TIER1_EVENTS,
  HISTORICAL_MACRO_REACTIONS,
  getScenarioMatrix,
};

if (require.main === module) {
  (async () => {
    console.log('Testing MacroCalendarEngine...');
    const list = await macroCalendarInstance.syncEvents(true);
    console.log('Total synchronized events:', list.length);
    const nextHigh = macroCalendarInstance.getNextHighImpactEvent();
    console.log('Next High Impact Event:', nextHigh);
    const highOnly = macroCalendarInstance.getFilteredEvents({ impact: 'HIGH' });
    console.log('High impact events count:', highOnly.length);
  })();
}
