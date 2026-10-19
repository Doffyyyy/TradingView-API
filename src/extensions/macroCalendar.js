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
    if (fs.existsSync(CACHE_FILE)) {
      try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.events)) {
          this.events = data.events;
          this.lastFetched = data.lastFetched || 0;
        }
      } catch (e) {
        console.error('[MacroCalendar] Failed to read cache:', e.message);
      }
    }
    if (!this.events || this.events.length === 0) {
      this.events = [...MASTER_TIER1_EVENTS];
    }
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

  getFilteredEvents({ currency = 'ALL', impact = 'ALL', category = 'ALL', search = '' } = {}) {
    let list = [...this.events];

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
}

const macroCalendarInstance = new MacroCalendarEngine();

module.exports = {
  macroCalendarInstance,
  MASTER_TIER1_EVENTS,
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
