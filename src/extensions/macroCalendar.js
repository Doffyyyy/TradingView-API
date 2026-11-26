const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'macro_calendar_cache.json');
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

// Master Upcoming Tier-1 Macro Schedule (Late Nov 2026 -> Q1 2027)
// Merged with live weekly ForexFactory feed and pruned automatically as events pass.
const MASTER_TIER1_EVENTS = [
  // --- LATE NOVEMBER 2026 ---
  {
    id: 'gdp_2026_11_25',
    title: 'US Prelim GDP q/q (Q3 Second Estimate)',
    country: 'USD',
    date: '2026-11-25T08:30:00-05:00',
    impact: 'High',
    forecast: '2.8%',
    previous: '3.0%',
    actual: '',
    category: 'Growth & GDP',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Đo lường tốc độ tăng trưởng GDP Mỹ trước kỳ nghỉ Thanksgiving. Số liệu ổn định hỗ trợ tâm lý Risk-On; chênh lệch lớn so với kỳ vọng có thể kéo biến động DXY & BTC.'
  },
  {
    id: 'pce_2026_11_25',
    title: 'US Core PCE Price Index m/m & Personal Spending',
    country: 'USD',
    date: '2026-11-25T10:00:00-05:00',
    impact: 'High',
    forecast: '0.2%',
    previous: '0.3%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Thước đo lạm phát ưa thích của FED trước cuộc họp FOMC tháng 12. Core PCE hạ nhiệt củng cố kỳ vọng cắt giảm lãi suất và hỗ trợ thanh khoản Crypto.'
  },

  // --- DECEMBER 2026 ---
  {
    id: 'nfp_2026_12_04',
    title: 'US Non-Farm Employment Change & Unemployment Rate',
    country: 'USD',
    date: '2026-12-04T08:30:00-05:00',
    impact: 'High',
    forecast: '145K / 4.2%',
    previous: '150K / 4.1%',
    actual: '',
    category: 'Employment & NFP',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Báo cáo việc làm Mỹ then chốt trước kỳ họp FOMC cuối năm. Việc làm hạ nhiệt có kiểm soát giúp giảm áp lực lợi suất US10Y lên Bitcoin và tài sản rủi ro.'
  },
  {
    id: 'cpi_2026_12_10',
    title: 'US CPI m/m & y/y',
    country: 'USD',
    date: '2026-12-10T08:30:00-05:00',
    impact: 'High',
    forecast: '2.4%',
    previous: '2.5%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Dữ liệu lạm phát tiêu dùng Mỹ định hình kỳ vọng lãi suất FOMC tháng 12. Biến động nến 15M quanh 20:30 UTC+7 thường rất lớn.'
  },
  {
    id: 'core_cpi_2026_12_10',
    title: 'US Core CPI m/m',
    country: 'USD',
    date: '2026-12-10T08:30:00-05:00',
    impact: 'High',
    forecast: '0.2%',
    previous: '0.3%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Chỉ số lạm phát lõi loại trừ năng lượng và thực phẩm — trọng tâm theo dõi của FED để đánh giá độ dai dẳng của giá dịch vụ.'
  },
  {
    id: 'ppi_2026_12_11',
    title: 'US PPI m/m & Core PPI',
    country: 'USD',
    date: '2026-12-11T08:30:00-05:00',
    impact: 'High',
    forecast: '0.2%',
    previous: '0.2%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Chỉ số giá sản xuất bổ sung bức tranh lạm phát đầu vào ngay sau báo cáo CPI trước thềm tuần lễ FOMC.'
  },
  {
    id: 'fomc_2026_12_16',
    title: 'FOMC Interest Rate Decision & Economic Projections (Dot Plot)',
    country: 'USD',
    date: '2026-12-16T14:00:00-05:00',
    impact: 'High',
    forecast: '4.25%',
    previous: '4.50%',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Quyết định lãi suất cuối năm kèm biểu đồ Dot Plot dự phóng lộ trình 2027. Tác động trực tiếp lên DXY, lợi suất thực và xu hướng Crypto cuối năm.'
  },
  {
    id: 'powell_2026_12_16',
    title: 'Fed Chair Powell Press Conference',
    country: 'USD',
    date: '2026-12-16T14:30:00-05:00',
    impact: 'High',
    forecast: '',
    previous: '',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Họp báo của Chủ tịch FED thường tạo biến động hai chiều mạnh trong 45 phút. Cần chờ cấu trúc nến ổn định thay vì vào lệnh giữa lúc phát biểu.'
  },
  {
    id: 'boe_2026_12_17',
    title: 'BOE Official Bank Rate Decision',
    country: 'GBP',
    date: '2026-12-17T07:00:00-05:00',
    impact: 'High',
    forecast: '4.50%',
    previous: '4.75%',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Quyết định lãi suất của Ngân hàng Trung ương Anh ảnh hưởng trực tiếp tới GBP, thanh khoản châu Âu và nhịp đồng thuận nới lỏng G10.'
  },
  {
    id: 'ecb_2026_12_17',
    title: 'ECB Monetary Policy Decision & Press Conference',
    country: 'EUR',
    date: '2026-12-17T08:15:00-05:00',
    impact: 'High',
    forecast: '3.00%',
    previous: '3.25%',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Lãi suất khu vực Eurozone tác động mạnh lên EUR/USD (chiếm gần 58% rổ chỉ số DXY), qua đó gián tiếp điều hướng sức mạnh đồng USD với Crypto.'
  },
  {
    id: 'boj_2026_12_18',
    title: 'BOJ Policy Rate & Outlook Statement',
    country: 'JPY',
    date: '2026-12-18T11:30:00+09:00',
    impact: 'High',
    forecast: '0.25%',
    previous: '0.25%',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Chính sách lãi suất Nhật Bản ảnh hưởng trực tiếp đến vị thế Yen Carry Trade. Động thái tăng lãi suất bất ngờ thường gây thu hẹp đòn bẩy rủi ro toàn cầu.'
  },
  {
    id: 'pce_2026_12_23',
    title: 'US Core PCE Price Index m/m',
    country: 'USD',
    date: '2026-12-23T08:30:00-05:00',
    impact: 'High',
    forecast: '0.2%',
    previous: '0.2%',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Báo cáo lạm phát PCE cuối năm trong tuần thanh khoản thấp trước lễ Giáng sinh, dễ xuất hiện trượt giá nếu biên độ nến giãn rộng.'
  },

  // --- Q1 2027 ANCHORS ---
  {
    id: 'nfp_2027_01_08',
    title: 'US Non-Farm Employment Change & Unemployment Rate',
    country: 'USD',
    date: '2027-01-08T08:30:00-05:00',
    impact: 'High',
    forecast: '',
    previous: '',
    actual: '',
    category: 'Employment & NFP',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Báo cáo việc làm đầu tiên của năm 2027 định hình kỳ vọng tăng trưởng và tốc độ hạ lãi suất quý I của FED.'
  },
  {
    id: 'cpi_2027_01_13',
    title: 'US CPI m/m & y/y',
    country: 'USD',
    date: '2027-01-13T08:30:00-05:00',
    impact: 'High',
    forecast: '',
    previous: '',
    actual: '',
    category: 'Inflation (CPI/PPI)',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Số liệu lạm phát CPI đầu năm 2027 trước thềm cuộc họp FOMC tháng 1.'
  },
  {
    id: 'fomc_2027_01_27',
    title: 'FOMC Interest Rate Decision & Press Conference',
    country: 'USD',
    date: '2027-01-27T14:00:00-05:00',
    impact: 'High',
    forecast: '',
    previous: '',
    actual: '',
    category: 'FED & Central Bank',
    volatilityRisk: 'High',
    source: 'schedule',
    cryptoImpact: 'Cuộc họp chính sách tiền tệ đầu tiên trong năm 2027 của Cục Dự trữ Liên bang Mỹ.'
  }
];

function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 Hyperview/1.0' }, timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve([]);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

function getNewYorkDateKey(dateValue) {
  const ts = new Date(dateValue).getTime();
  if (Number.isNaN(ts)) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  } catch (e) {
    return String(dateValue).slice(0, 10);
  }
}

function getCanonicalMacroToken(title) {
  const t = String(title || '').toLowerCase();
  if (t.includes('core cpi')) return 'core_cpi';
  if (t.includes('cpi')) return 'cpi';
  if (t.includes('core pce')) return 'core_pce';
  if (t.includes('pce')) return 'pce';
  if (t.includes('core ppi')) return 'core_ppi';
  if (t.includes('ppi')) return 'ppi';
  if (t.includes('powell') || t.includes('fomc press conference') || t.includes('fed chair')) return 'powell';
  if (t.includes('fomc') || t.includes('federal funds rate') || t.includes('fed interest rate')) return 'fomc_rate';
  if (t.includes('non-farm') || t.includes('nfp')) return 'nfp';
  if (t.includes('unemployment rate')) return 'unemployment_rate';
  if (t.includes('prelim gdp') || t.includes('gdp q/q') || t.includes('advance gdp') || t.includes('final gdp')) return 'gdp';
  if (t.includes('main refinancing rate') || t.includes('ecb monetary policy') || t.includes('ecb press conference')) return 'ecb';
  if (t.includes('official bank rate') || t.includes('boe ')) return 'boe';
  if (t.includes('boj policy rate') || t.includes('boj outlook')) return 'boj';
  return '';
}

function normalizeCountry(country) {
  return String(country || 'ALL').trim().toUpperCase();
}

function findMatchingEvent(eventMap, candidate) {
  const candCountry = normalizeCountry(candidate.country);
  const candDate = getNewYorkDateKey(candidate.date);
  const candTitle = String(candidate.title || '').toLowerCase().trim();
  const candToken = getCanonicalMacroToken(candTitle);
  const candTs = new Date(candidate.date).getTime();

  for (const existing of eventMap.values()) {
    if (normalizeCountry(existing.country) !== candCountry) continue;
    const exDate = getNewYorkDateKey(existing.date);
    const sameDay = candDate && exDate && candDate === exDate;
    const closeTime = !Number.isNaN(candTs) && Math.abs(new Date(existing.date).getTime() - candTs) <= 18 * 3600 * 1000;
    if (!sameDay && !closeTime) continue;

    const exTitle = String(existing.title || '').toLowerCase().trim();
    if (exTitle === candTitle) return existing;
    if (candTitle && exTitle && (exTitle.includes(candTitle) || candTitle.includes(exTitle))) {
      return existing;
    }
    const exToken = getCanonicalMacroToken(exTitle);
    if (candToken && exToken && candToken === exToken) {
      return existing;
    }
  }
  return null;
}

class MacroCalendarEngine {
  constructor() {
    this.events = [];
    this.lastFetched = 0;
    this.cacheInterval = 30 * 60 * 1000; // 30 minutes
    this.loadCache();
  }

  pruneEvents(list) {
    const cutoff = Date.now() - ONE_WEEK_MS;
    if (!Array.isArray(list)) return [];
    return list.filter(ev => {
      if (!ev || !ev.date || !ev.title) return false;
      if (String(ev.impact || '').toLowerCase() === 'holiday') return false;
      const ts = new Date(ev.date).getTime();
      if (Number.isNaN(ts)) return false;
      return ts >= cutoff;
    });
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
    this.pruneEvents(MASTER_TIER1_EVENTS).forEach(ev => {
      map.set(ev.id || `${ev.date}_${ev.title}`, { ...ev, source: ev.source || 'schedule' });
    });

    this.pruneEvents(cachedList).forEach(ev => {
      const normalized = {
        ...ev,
        country: normalizeCountry(ev.country),
        source: ev.source || (String(ev.id || '').startsWith('ff_') ? 'live' : 'schedule'),
      };
      const existing = findMatchingEvent(map, normalized);
      if (existing) {
        if (normalized.actual) existing.actual = normalized.actual;
        if (normalized.forecast && !existing.forecast) existing.forecast = normalized.forecast;
        if (normalized.previous && !existing.previous) existing.previous = normalized.previous;
        if (normalized.source === 'live') existing.source = 'live';
      } else {
        const key = normalized.id || `${normalized.date}_${normalized.title}`;
        map.set(key, normalized);
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

  async fetchLiveForexFactoryFeed() {
    const urls = [
      'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
      'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
    ];
    const results = await Promise.all(urls.map(fetchJson));
    const combined = [];
    const seen = new Set();

    results.forEach(list => {
      if (!Array.isArray(list)) return;
      list.forEach(item => {
        if (!item || !item.title || !item.date) return;
        const dedupeKey = `${normalizeCountry(item.country)}|${item.date}|${String(item.title).toLowerCase().trim()}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          combined.push(item);
        }
      });
    });

    return combined;
  }

  categorizeEvent(title) {
    const t = String(title || '').toLowerCase();
    // Employment / Jobs MUST be checked before 'rate' so "Unemployment Rate" is not misclassified as Central Bank
    if (
      t.includes('average earnings') ||
      t.includes('unemployment') ||
      t.includes('employment') ||
      t.includes('payrolls') ||
      t.includes('non-farm') ||
      t.includes('nfp') ||
      t.includes('claims') ||
      t.includes('adp') ||
      t.includes('jolts')
    ) {
      return 'Employment & NFP';
    }
    if (t.includes('cpi') || t.includes('ppi') || t.includes('pce') || t.includes('inflation')) {
      return 'Inflation (CPI/PPI)';
    }
    if (
      t.includes('fomc') ||
      t.includes('fed ') ||
      t.includes('powell') ||
      t.includes('rate') ||
      t.includes('central bank') ||
      t.includes('ecb') ||
      t.includes('boe') ||
      t.includes('boj') ||
      t.includes('rba') ||
      t.includes('boc') ||
      t.includes('snb') ||
      t.includes('rbnz') ||
      t.includes('monetary policy')
    ) {
      return 'FED & Central Bank';
    }
    if (t.includes('gdp') || t.includes('sales') || t.includes('pmi') || t.includes('sentiment') || t.includes('consumer confidence') || t.includes('leading index')) {
      return 'Growth & GDP';
    }
    return 'Other';
  }

  getCryptoPlaybook(item) {
    const title = String(item.title || '').toLowerCase();
    const country = normalizeCountry(item.country);

    if (country === 'USD') {
      if (title.includes('fomc') || title.includes('fed interest rate') || title.includes('federal funds rate')) {
        return 'Quyết định lãi suất USD: Tín hiệu Dovish kéo DXY & lợi suất giảm -> hỗ trợ BTC/Crypto; Hawkish dễ kích hoạt nhịp quét thanh khoản giảm.';
      }
      if (title.includes('powell')) {
        return 'Họp báo Chủ tịch FED thường gây biến động giật hai chiều trong 30-45 phút đầu. Chờ đóng nến xác nhận xu hướng trước khi vào lệnh.';
      }
      if (title.includes('cpi') || title.includes('pce')) {
        return 'Thước đo lạm phát Mỹ trực tiếp chi phối kỳ vọng cắt giảm lãi suất của FED. Số liệu thấp hơn dự báo thường có lợi cho BTC & Altcoin.';
      }
      if (title.includes('ppi')) {
        return 'Chỉ số giá sản xuất Mỹ phản ánh áp lực lạm phát đầu vào, thường dẫn dắt kỳ vọng trước các kỳ CPI/PCE tiếp theo.';
      }
      if (title.includes('non-farm') || title.includes('nfp') || title.includes('unemployment') || title.includes('claims') || title.includes('jolts')) {
        return 'Thước đo sức khỏe thị trường lao động Mỹ. Hạ nhiệt vừa phải củng cố kịch bản nới lỏng tiền tệ, hỗ trợ dòng tiền vào tài sản rủi ro.';
      }
      if (title.includes('gdp') || title.includes('pmi') || title.includes('retail sales')) {
        return 'Dữ liệu tăng trưởng kinh tế Mỹ tác động lên kỳ vọng hạ cánh mềm và tâm lý chấp nhận rủi ro trên thị trường Crypto.';
      }
      return 'Sự kiện kinh tế Mỹ có thể tác động lên chỉ số DXY, lợi suất US10Y và biến động ngắn hạn của cặp BTC/USD.';
    }

    if (country === 'EUR') {
      return 'Dữ liệu khu vực Eurozone ảnh hưởng tới EUR/USD (tỷ trọng lớn nhất trong rổ DXY), từ đó gián tiếp điều hướng sức mạnh USD và dòng vốn Crypto.';
    }
    if (country === 'GBP') {
      return 'Thông tin vĩ mô & chính sách lãi suất từ Anh tác động lên cặp GBP/USD, lợi suất châu Âu và khẩu vị rủi ro trong phiên London.';
    }
    if (country === 'JPY') {
      return 'Biến động chính sách tiền tệ Nhật Bản tác động tới USD/JPY và chi phí Yen Carry Trade — yếu tố nhạy cảm với thanh khoản tài sản rủi ro toàn cầu.';
    }
    return 'Sự kiện vĩ mô khu vực ' + country + ': Theo dõi phản ứng lan tỏa sang rổ tiền tệ G10 và phiên giao dịch giao thoa.';
  }

  async syncEvents(force = false) {
    const now = Date.now();
    if (!force && this.events.length > 0 && (now - this.lastFetched) < this.cacheInterval) {
      return this.events;
    }

    const liveList = await this.fetchLiveForexFactoryFeed();
    const eventMap = new Map();

    // 1. Seed with pruned master schedule
    this.pruneEvents(MASTER_TIER1_EVENTS).forEach(ev => {
      eventMap.set(ev.id || `${ev.date}_${ev.title}`, { ...ev, source: ev.source || 'schedule' });
    });

    // 2. Keep any non-expired existing cached live events if live feed fails/partial
    if (!liveList || liveList.length === 0) {
      this.pruneEvents(this.events).forEach(ev => {
        if (!findMatchingEvent(eventMap, ev)) {
          eventMap.set(ev.id || `${ev.date}_${ev.title}`, ev);
        }
      });
    }

    // 3. Overlay live weekly & next-week ForexFactory feeds
    if (Array.isArray(liveList)) {
      liveList.forEach((item, idx) => {
        if (!item || !item.date || !item.title) return;
        const impact = item.impact || 'Low';
        if (String(impact).toLowerCase() === 'holiday') return;

        const ts = new Date(item.date).getTime();
        if (Number.isNaN(ts) || ts < (now - ONE_WEEK_MS)) return;

        const country = normalizeCountry(item.country);
        const id = `ff_${item.date}_${country}_${idx}`;
        const existing = findMatchingEvent(eventMap, { ...item, country });
        const cat = this.categorizeEvent(item.title);

        const eventObj = {
          id: existing ? existing.id : id,
          title: existing && existing.source === 'schedule' ? existing.title : item.title,
          country: country,
          date: item.date,
          impact: impact,
          forecast: item.forecast || (existing ? existing.forecast : ''),
          previous: item.previous || (existing ? existing.previous : ''),
          actual: item.actual || (existing ? existing.actual : ''),
          category: cat !== 'Other' ? cat : (existing ? existing.category : cat),
          volatilityRisk: impact === 'High' ? 'High' : (impact === 'Medium' ? 'Medium' : 'Low'),
          source: 'live',
          cryptoImpact: existing ? existing.cryptoImpact : this.getCryptoPlaybook({ ...item, country }),
        };

        if (existing) {
          Object.assign(existing, eventObj);
        } else {
          eventMap.set(id, eventObj);
        }
      });
    }

    this.events = this.pruneEvents(Array.from(eventMap.values())).sort((a, b) => {
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });

    if (liveList.length > 0 || this.lastFetched === 0) {
      this.lastFetched = now;
    }
    this.saveCache();
    return this.events;
  }

  getEventById(id) {
    if (!id) return null;
    return this.events.find(e => e.id === id) || null;
  }

  getNextHighImpactEvent() {
    const cutoff = Date.now() - FIFTEEN_MIN_MS;
    const upcoming = this.events.filter(e => new Date(e.date).getTime() >= cutoff);
    if (upcoming.length === 0) return this.events[this.events.length - 1] || null;

    const usdHigh = upcoming.find(e => e.country === 'USD' && e.impact === 'High');
    if (usdHigh) return usdHigh;

    const globalHigh = upcoming.find(e => e.impact === 'High');
    if (globalHigh) return globalHigh;

    const usdMed = upcoming.find(e => e.country === 'USD' && e.impact === 'Medium');
    if (usdMed) return usdMed;

    const globalMed = upcoming.find(e => e.impact === 'Medium');
    if (globalMed) return globalMed;

    return upcoming[0];
  }

  getSummaryMeta() {
    const cutoff = Date.now() - FIFTEEN_MIN_MS;
    const end30d = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const upcoming = this.events.filter(e => new Date(e.date).getTime() >= cutoff);

    const nextHighImpact = this.getNextHighImpactEvent();
    const nextFomc = upcoming.find(e => {
      if (e.country !== 'USD') return false;
      const t = (e.title || '').toLowerCase();
      return t.includes('fomc') || t.includes('fed ') || t.includes('federal funds') || t.includes('powell');
    }) || null;

    const nextInflation = upcoming.find(e => {
      if (e.country !== 'USD') return false;
      const t = (e.title || '').toLowerCase();
      return t.includes('cpi') || t.includes('pce') || t.includes('ppi');
    }) || null;

    const upcoming30d = upcoming.filter(e => new Date(e.date).getTime() <= end30d);
    const highCount30d = upcoming30d.filter(e => e.impact === 'High').length;

    return {
      nextHighImpact,
      nextFomc,
      nextInflation,
      highCount30d,
      totalUpcoming30d: upcoming30d.length,
    };
  }

  getFilteredEvents({ currency = 'ALL', impact = 'ALL', category = 'ALL', search = '', timeScope = 'UPCOMING_30D', hidePast = true } = {}) {
    let list = [...this.events];
    const now = new Date();
    const nowTs = now.getTime();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth();
    const cutoff = hidePast ? nowTs : (nowTs - FIFTEEN_MIN_MS);

    // 1. Time scope filter
    if (timeScope === 'UPCOMING_30D') {
      const end30d = nowTs + 30 * 24 * 3600 * 1000;
      const start30d = hidePast ? cutoff : (nowTs - ONE_WEEK_MS);
      list = list.filter(e => {
        const evTs = new Date(e.date).getTime();
        return evTs >= start30d && evTs <= end30d;
      });
    } else if (timeScope === 'THIS_WEEK') {
      const dayOfWeek = now.getDay(); // 0=Sun..6=Sat
      const mondayOffset = dayOfWeek === 0 ? -6 : (1 - dayOfWeek);
      const startOfWeek = new Date(curYear, curMonth, now.getDate() + mondayOffset, 0, 0, 0, 0).getTime();
      const startWeekTs = hidePast ? cutoff : startOfWeek;
      const endWeekTs = nowTs + ONE_WEEK_MS;
      list = list.filter(e => {
        const evTs = new Date(e.date).getTime();
        return evTs >= startWeekTs && evTs <= endWeekTs;
      });
    } else if (timeScope === 'UPCOMING_MONTH' || timeScope === 'CURRENT_MONTH') {
      list = list.filter(e => {
        const evDate = new Date(e.date);
        const isInCurMonth = evDate.getFullYear() === curYear && evDate.getMonth() === curMonth;
        if (!isInCurMonth) return false;
        return hidePast ? evDate.getTime() >= cutoff : true;
      });
    } else if (timeScope === 'NEXT_MONTH') {
      const nextMonthDate = new Date(curYear, curMonth + 1, 1);
      const nextYear = nextMonthDate.getFullYear();
      const nextMonth = nextMonthDate.getMonth();
      list = list.filter(e => {
        const evDate = new Date(e.date);
        return evDate.getFullYear() === nextYear && evDate.getMonth() === nextMonth;
      });
    } else if (hidePast) {
      list = list.filter(e => new Date(e.date).getTime() >= cutoff);
    }

    // 2. Faceted filters
    if (currency !== 'ALL') {
      list = list.filter(e => normalizeCountry(e.country) === currency.toUpperCase());
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
        (e.category && e.category.toLowerCase().includes(q)) ||
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

// Legacy export preserved as empty array — static historical BTC reaction table removed.
const HISTORICAL_MACRO_REACTIONS = [];

function getScenarioMatrix(event) {
  if (!event) return null;
  const title = (event.title || '').toLowerCase();
  const country = normalizeCountry(event.country);
  const forecast = event.forecast || '';
  const previous = event.previous || '';
  const refVal = forecast || previous || 'dự báo';

  const dateStr = event.date ? new Date(event.date).toLocaleString('vi-VN', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  }) : 'Sắp diễn ra';

  const base = {
    eventId: event.id,
    eventTitle: event.title,
    dateFormatted: dateStr + ' (UTC+7)',
    country,
    impact: event.impact || 'Medium',
    category: event.category || 'General',
    forecast: forecast || '—',
    previous: previous || '—',
    riskNote: 'Tránh mở mới trong 15 phút quanh giờ tin ra; chờ nến 15M/1H đóng rõ cấu trúc trước khi theo quy tắc Kell SL theo R.',
  };

  // 1. NFP / Employment
  if (title.includes('non-farm') || title.includes('nfp') || title.includes('unemployment') || title.includes('payrolls') || title.includes('claims')) {
    const bullCond = title.includes('unemployment') || title.includes('claims')
      ? `Thực tế > ${refVal} (Thị trường việc làm dịu lại)`
      : `Thực tế < ${refVal} (Tăng trưởng việc làm hạ nhiệt)`;
    const bearCond = title.includes('unemployment') || title.includes('claims')
      ? `Thực tế < ${refVal} (Lao động còn thắt chặt)`
      : `Thực tế > ${refVal} (Việc làm nóng hơn kỳ vọng)`;

    return {
      ...base,
      summary: 'Đo lường sức khỏe việc làm và áp lực tiền lương, tác động trực tiếp lên kỳ vọng lãi suất USD & thanh khoản.',
      scenarios: [
        {
          tier: 'BULLISH',
          label: 'Bullish Setup',
          title: 'Hạ Nhiệt Có Kiểm Soát',
          condition: bullCond,
          reaction: 'USD và lợi suất US10Y suy yếu; dòng tiền quay lại tài sản rủi ro, ưu tiên BTC & Top Large Caps.',
          execution: 'Chờ nến 15M sau tin đóng vững trên EMA10/EMA20, tránh mua đuổi đỉnh râu nến đầu.'
        },
        {
          tier: 'NEUTRAL',
          label: 'Inline / Chop',
          title: 'Sát Dự Báo — Quét Hai Đầu',
          condition: `Thực tế ~ ${refVal} (Không tạo bất ngờ)`,
          reaction: 'Giá thường giật hai chiều thanh lọc đòn bẩy cao rồi quay về biên độ tích lũy trước tin.',
          execution: 'Đứng ngoài 30 phút đầu; chỉ giao dịch khi cấu trúc H1 hình thành EMA Crossback rõ ràng.'
        },
        {
          tier: 'BEARISH',
          label: 'Bearish Setup',
          title: 'Việc Làm Quá Nóng',
          condition: bearCond,
          reaction: 'DXY bật tăng gây áp lực lên cặp BTC/USD; các vị thế đòn bẩy cao dễ bị quét stop ngắn hạn.',
          execution: 'Không bắt đáy nến tin đầu tiên; thắt chặt SL cho lệnh đang mở và chờ retest kháng cự nếu tìm Short.'
        }
      ]
    };
  }

  // 2. CPI / PCE / PPI Inflation
  if (title.includes('cpi') || title.includes('pce') || title.includes('ppi') || title.includes('inflation')) {
    return {
      ...base,
      summary: 'Thước đo lạm phát định hướng trực tiếp kỳ vọng chính sách tiền tệ và khẩu vị rủi ro Crypto.',
      scenarios: [
        {
          tier: 'BULLISH',
          label: 'Bullish Setup',
          title: 'Lạm Phát Hạ Nhiệt',
          condition: `Thực tế < ${refVal}`,
          reaction: 'Áp lực thắt chặt tiền tệ giảm, DXY suy yếu giúp BTC/ETH thu hút lực mua theo xu hướng.',
          execution: 'Ưu tiên tìm điểm vào Long khi giá retest vùng phá vỡ trên khung 15M/1H và đặt SL đúng 1R.'
        },
        {
          tier: 'NEUTRAL',
          label: 'Inline / Chop',
          title: 'Đúng Kỳ Vọng (Priced-In)',
          condition: `Thực tế = ${refVal}`,
          reaction: 'Thị trường đã phản ánh phần lớn vào giá, dễ xuất hiện râu quét stop cả Long và Short trong 15 phút đầu.',
          execution: 'Giữ kỷ luật vị thế hiện tại theo trailing R, tránh mở thêm lệnh trong vùng nhiễu.'
        },
        {
          tier: 'BEARISH',
          label: 'Bearish Setup',
          title: 'Lạm Phát Nóng Hơn Dự Báo',
          condition: `Thực tế > ${refVal}`,
          reaction: 'Lợi suất trái phiếu Mỹ và USD tăng nhanh, tạo áp lực điều chỉnh tức thì lên thị trường phái sinh Crypto.',
          execution: 'Hạn chế bắt dao rơi; giữ nguyên kỷ luật dừng lỗ R-based và giảm mức phơi nhiễm rủi ro.'
        }
      ]
    };
  }

  // 3. Central Bank / FOMC / ECB / BOE / BOJ / Powell
  if (title.includes('fomc') || title.includes('fed') || title.includes('powell') || title.includes('rate') || title.includes('ecb') || title.includes('boe') || title.includes('boj')) {
    return {
      ...base,
      summary: 'Quyết định lãi suất và định hướng chính sách (Guidance) chi phối thanh khoản vĩ mô toàn cầu.',
      scenarios: [
        {
          tier: 'BULLISH',
          label: 'Bullish Setup',
          title: 'Tín Hiệu Nới Lỏng (Dovish)',
          condition: forecast ? `Lãi suất ≤ ${forecast} / Phát biểu nới lỏng` : 'Định hướng chính sách nới lỏng rõ rệt',
          reaction: 'Lợi suất giảm và thanh khoản mở rộng, củng cố xu hướng tăng trung hạn cho Bitcoin & Risk Assets.',
          execution: 'Chờ kết thúc họp báo để xác nhận xu hướng thật, bám theo EMA20/H1 và tối ưu Stage 1 (+2.5R) & Runner.'
        },
        {
          tier: 'NEUTRAL',
          label: 'Inline / Chop',
          title: 'Họp Báo Hai Chiều (Whipsaw)',
          condition: 'Quyết định đúng dự báo & thông điệp trung tính',
          reaction: 'Thị trường giật mạnh theo từng phát biểu Q&A, biên độ nến giãn rộng bất thường cả hai phía.',
          execution: 'Tạm ngưng vào mới trong khung giờ họp báo; chỉ hành động sau khi đóng nến 1H.'
        },
        {
          tier: 'BEARISH',
          label: 'Bearish Setup',
          title: 'Diều Hâu Bất Ngờ (Hawkish)',
          condition: 'Trì hoãn nới lỏng / Cảnh báo lạm phát dai dẳng',
          reaction: 'Đồng USD tăng mạnh hoặc Carry Trade thu hẹp (nếu BOJ diều hâu), kích hoạt nhịp rút thanh khoản.',
          execution: 'Ưu tiên bảo toàn vốn, tuân thủ dừng lỗ tuyệt đối và tránh bình quân giá ngược xu hướng.'
        }
      ]
    };
  }

  // 4. Growth / PMI / GDP / Retail Sales
  if (title.includes('gdp') || title.includes('pmi') || title.includes('retail') || title.includes('sentiment')) {
    return {
      ...base,
      summary: 'Phản ánh sức khỏe tăng trưởng kinh tế thực, ảnh hưởng tới kỳ vọng hạ cánh mềm và dòng vốn Risk-On.',
      scenarios: [
        {
          tier: 'BULLISH',
          label: 'Bullish Setup',
          title: 'Tăng Trưởng Cân Bằng',
          condition: `Thực tế ≥ ${refVal} (Không kèm lạm phát nóng)`,
          reaction: 'Củng cố kịch bản hạ cánh mềm (Soft Landing), giữ dòng tiền ổn định trong chứng khoán và Crypto.',
          execution: 'Tuân thủ tín hiệu breakout hoặc pullback về EMA10/EMA20 theo hệ thống Kell.'
        },
        {
          tier: 'NEUTRAL',
          label: 'Inline / Chop',
          title: 'Đúng Dự Báo',
          condition: `Thực tế ~ ${refVal}`,
          reaction: 'Biến động vừa phải, thị trường tiếp tục vận động theo cấu trúc kỹ thuật hiện hành.',
          execution: 'Duy trì kế hoạch giao dịch bình thường, không cần điều chỉnh đột ngột.'
        },
        {
          tier: 'BEARISH',
          label: 'Bearish Setup',
          title: 'Tín Hiệu Suy Yếu Mạnh',
          condition: `Thực tế thấp hơn đáng kể so với ${refVal}`,
          reaction: 'Lo ngại suy thoái ngắn hạn có thể khiến tài sản rủi ro đồng loạt điều chỉnh theo S&P 500 / Nasdaq.',
          execution: 'Theo dõi sát phản ứng tại vùng hỗ trợ gần nhất và đảm bảo rủi ro mỗi lệnh không vượt ngưỡng.'
        }
      ]
    };
  }

  // 5. Generic Macro Catalyst
  return {
    ...base,
    summary: event.cryptoImpact || 'Dữ liệu kinh tế vĩ mô có thể tác động tới tỷ giá tiền tệ G10 và thanh khoản ngắn hạn.',
    scenarios: [
      {
        tier: 'BULLISH',
        label: 'Bullish Setup',
        title: 'Kỳ Vọng Tích Cực',
        condition: `Kết quả thuận lợi hơn ${refVal}`,
        reaction: 'Tâm lý Risk-On được hỗ trợ, lực mua ưu tiên các tài sản dẫn dắt thanh khoản.',
        execution: 'Chờ nến 15M xác nhận theo hướng phá vỡ trước khi khớp lệnh.'
      },
      {
        tier: 'NEUTRAL',
        label: 'Inline / Chop',
        title: 'Sát Dự Báo',
        condition: `Kết quả quanh mức ${refVal}`,
        reaction: 'Ảnh hưởng vĩ mô hạn chế; giá bám theo xu hướng kỹ thuật sẵn có.',
        execution: 'Giao dịch bình thường theo bộ lọc cấu trúc khung H1.'
      },
      {
        tier: 'BEARISH',
        label: 'Bearish Setup',
        title: 'Áp Lực Ngắn Hạn',
        condition: `Kết quả bất lợi hơn ${refVal}`,
        reaction: 'Biến động tỷ giá hoặc tâm lý phòng thủ gia tăng làm chậm đà tăng ngắn hạn.',
        execution: 'Không mở vị thế mới ngược xu hướng; giữ nguyên quy tắc stop loss.'
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
    const summary = macroCalendarInstance.getSummaryMeta();
    console.log('Summary Meta:', {
      nextHighImpact: summary.nextHighImpact ? `${summary.nextHighImpact.country} ${summary.nextHighImpact.title} (${summary.nextHighImpact.date})` : null,
      nextFomc: summary.nextFomc ? `${summary.nextFomc.title} (${summary.nextFomc.date})` : null,
      nextInflation: summary.nextInflation ? `${summary.nextInflation.title} (${summary.nextInflation.date})` : null,
      highCount30d: summary.highCount30d,
      totalUpcoming30d: summary.totalUpcoming30d,
    });
    const highOnly = macroCalendarInstance.getFilteredEvents({ impact: 'HIGH', timeScope: 'UPCOMING_30D' });
    console.log('Upcoming 30d High impact events:', highOnly.length);
  })();
}
