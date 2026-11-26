/**
 * Variational Protocol (Omni DEX) Connector — Official Omni API v1 (Ed25519)
 * Supports Testnet & Mainnet authenticated REST endpoints, OpenAPI 3.1.0 precision/order rules,
 * encrypted API secret storage, and public /metadata/v2/stats fallback.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');

const VARIO_AGENTS_DIR = path.join(__dirname, '../../data/user_vario_agents');
if (!fs.existsSync(VARIO_AGENTS_DIR)) {
  fs.mkdirSync(VARIO_AGENTS_DIR, { recursive: true });
}

const SCHEME = 'variational-omni-api/v1';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const STATS_API_URL = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/v2/stats';

const ENVIRONMENTS = {
  testnet: {
    name: 'testnet',
    baseUrl: 'https://api.omni.testnet.variational.io',
    appUrl: 'https://omni.testnet.variational.io',
  },
  prod: {
    name: 'prod',
    baseUrl: 'https://api.omni.variational.io',
    appUrl: 'https://omni.variational.io',
  },
};

const DECIMAL_STR_RE = /^[0-9]{1,16}(\.[0-9]{1,12})?$/;
const CLIENT_ORDER_ID_RE = /^[A-Za-z0-9_:-]{1,36}$/;

let cachedAesKey = null;
function getStorageAesKey() {
  if (!cachedAesKey) {
    const secret = process.env.VARIO_KEY_SECRET || (os.hostname() + ':' + __dirname);
    cachedAesKey = crypto.scryptSync(secret, 'hyperview-vario-v1', 32);
  }
  return cachedAesKey;
}

function encryptSeed(seedBuf) {
  const key = getStorageAesKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(seedBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSeed(packed) {
  const parts = String(packed || '').split(':');
  if (parts.length !== 3) {
    throw new Error('Encrypted Ed25519 seed format is invalid');
  }
  const [ivHex, tagHex, encHex] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getStorageAesKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]);
  if (plain.length !== 32) {
    throw new Error('Decrypted Ed25519 seed must be 32 bytes');
  }
  return plain;
}

function sanitizeUserId(userId) {
  if (!userId) return 'anonymous';
  return String(userId).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function normalizeEnvironment(env) {
  const clean = String(env || 'testnet').toLowerCase().trim();
  if (clean === 'mainnet' || clean === 'production') return 'prod';
  return ENVIRONMENTS[clean] ? clean : 'testnet';
}

function buildPrivateKeyObject(seedBuf) {
  if (!Buffer.isBuffer(seedBuf) || seedBuf.length !== 32) {
    throw new Error('Ed25519 seed must be a 32-byte Buffer');
  }
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seedBuf]),
    format: 'der',
    type: 'pkcs8',
  });
}

function deriveEd25519PublicKey(seedBuf) {
  const privKey = buildPrivateKeyObject(seedBuf);
  const spki = crypto.createPublicKey(privKey).export({ format: 'der', type: 'spki' });
  return '0x' + spki.subarray(spki.length - 32).toString('hex').toLowerCase();
}

function parseEd25519Seed(rawKey) {
  const raw = String(rawKey || '').trim();
  if (!raw) {
    throw new Error('Ed25519 Private Key không được để trống');
  }

  // 1. PEM PKCS#8 private key
  if (raw.includes('-----BEGIN PRIVATE KEY-----')) {
    try {
      const keyObj = crypto.createPrivateKey(raw);
      if (keyObj.asymmetricKeyType !== 'ed25519') {
        throw new Error('PEM key không phải Ed25519');
      }
      const pkcs8Der = keyObj.export({ format: 'der', type: 'pkcs8' });
      const seed = pkcs8Der.subarray(pkcs8Der.length - 32);
      if (seed.length !== 32) throw new Error('Invalid Ed25519 PKCS#8 DER length');
      return Buffer.from(seed);
    } catch (err) {
      throw new Error(`PEM Ed25519 key không hợp lệ: ${err.message}`);
    }
  }

  // 2. Hex seed (32-byte = 64 chars) or NaCl secret keypair (64-byte = 128 chars)
  const noPrefix = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]+$/.test(noPrefix)) {
    if (noPrefix.length === 64) {
      return Buffer.from(noPrefix, 'hex');
    }
    if (noPrefix.length === 128) {
      const seed = Buffer.from(noPrefix.slice(0, 64), 'hex');
      const trailingPub = noPrefix.slice(64).toLowerCase();
      const derivedPub = deriveEd25519PublicKey(seed).slice(2);
      if (trailingPub !== derivedPub) {
        throw new Error('Khóa Ed25519 64-byte không khớp giữa seed và public key');
      }
      return seed;
    }
  }

  // 3. Base64-encoded 32-byte seed, 48-byte PKCS#8 DER, or 64-byte NaCl keypair
  if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 40) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) {
      return decoded;
    }
    if (decoded.length === 48 && decoded.subarray(0, 16).equals(PKCS8_PREFIX)) {
      return Buffer.from(decoded.subarray(16));
    }
    if (decoded.length === 64) {
      const seed = Buffer.from(decoded.subarray(0, 32));
      const trailingPub = decoded.subarray(32).toString('hex').toLowerCase();
      const derivedPub = deriveEd25519PublicKey(seed).slice(2);
      if (trailingPub !== derivedPub) {
        throw new Error('Khóa Ed25519 Base64 64-byte không khớp seed và public key');
      }
      return seed;
    }
  }

  throw new Error(
    'Định dạng Ed25519 Private Key / Seed không hợp lệ (hỗ trợ 32-byte hex 64 ký tự, 64-byte hex, Base64 hoặc PEM PKCS#8).'
  );
}

function buildCanonicalString(environment, publicKey, timestampMs, method, pathAndQuery, bodyBuf = Buffer.alloc(0)) {
  const bodyHash = crypto.createHash('sha256').update(bodyBuf).digest('hex');
  return [
    SCHEME,
    String(environment),
    String(publicKey),
    String(timestampMs),
    String(method).toUpperCase(),
    String(pathAndQuery),
    bodyHash,
  ].join('\n');
}

function signRequest(seedBuf, environment, method, pathAndQuery, bodyBuf = Buffer.alloc(0), timestampMs = Date.now()) {
  const publicKey = deriveEd25519PublicKey(seedBuf);
  const canonical = buildCanonicalString(environment, publicKey, timestampMs, method, pathAndQuery, bodyBuf);
  const privKeyObj = buildPrivateKeyObject(seedBuf);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privKeyObj);
  return {
    'x-variational-key': publicKey,
    'x-request-timestamp-ms': String(timestampMs),
    'x-variational-signature': '0x' + signature.toString('hex'),
  };
}

function stripTrailingDecimalZeros(str) {
  if (!str.includes('.')) return str;
  const trimmed = str.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  return trimmed;
}

function formatDecimalString(num, maxDecimals = 12) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Giá trị số phải lớn hơn 0');
  }
  const capped = Math.min(12, Math.max(0, maxDecimals));
  const out = stripTrailingDecimalZeros(n.toFixed(capped));
  if (!DECIMAL_STR_RE.test(out) || Number(out) <= 0) {
    throw new Error(`Số "${out}" không hợp lệ theo chuẩn OpenAPI decimal`);
  }
  return out;
}

function countDecimals(stepStr) {
  const clean = String(stepStr).trim().toLowerCase();
  if (clean.includes('e-')) {
    const [, expPart] = clean.split('e-');
    const [mantissa] = clean.split('e-');
    const dotPart = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
    return Math.min(12, (parseInt(expPart, 10) || 0) + dotPart);
  }
  if (!clean.includes('.')) return 0;
  return Math.min(12, clean.split('.')[1].replace(/0+$/, '').length);
}

function roundToSizeStep(rawSize, sizeStep) {
  const sizeNum = Number(rawSize);
  if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
    throw new Error('Size đặt lệnh phải lớn hơn 0');
  }
  if (sizeStep === null || sizeStep === undefined || sizeStep === '') {
    return formatDecimalString(sizeNum, 8);
  }

  const stepNum = Number(sizeStep);
  if (!Number.isFinite(stepNum) || stepNum <= 0) {
    return formatDecimalString(sizeNum, 8);
  }

  const decimals = countDecimals(sizeStep);
  const scale = Math.pow(10, decimals);
  const stepInt = Math.max(1, Math.round(stepNum * scale));
  const rawInt = Math.floor(sizeNum * scale + 1e-6);
  const steps = Math.floor(rawInt / stepInt);
  if (steps <= 0) {
    throw new Error(`Khối lượng quá nhỏ (${sizeNum}), tối thiểu phải >= 1 bước size_step (${sizeStep})`);
  }
  const snapped = (steps * stepInt) / scale;
  return stripTrailingDecimalZeros(snapped.toFixed(decimals));
}

function roundToPricePrecision(rawPrice, pricePrecision) {
  const priceNum = Number(rawPrice);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    throw new Error('Giá đặt lệnh phải lớn hơn 0');
  }

  const minDec = Number.isInteger(pricePrecision?.min_decimal_figures) ? pricePrecision.min_decimal_figures : 2;
  const maxDecOnly = Number.isInteger(pricePrecision?.max_decimal_only_figures) ? pricePrecision.max_decimal_only_figures : 4;
  const maxSig = Number.isInteger(pricePrecision?.max_significant_figures) ? pricePrecision.max_significant_figures : 6;

  let formatted;
  if (priceNum >= 1) {
    const intDigits = Math.floor(Math.log10(priceNum)) + 1;
    const allowedDecimals = Math.min(12, Math.max(0, Math.max(minDec, maxSig - intDigits)));
    const factor = Math.pow(10, allowedDecimals);
    const snapped = Math.round(priceNum * factor + 1e-9) / factor;
    formatted = stripTrailingDecimalZeros(snapped.toFixed(allowedDecimals));
  } else {
    const firstNonZeroDec = Math.max(1, -Math.floor(Math.log10(priceNum)));
    const clampedDec = Math.min(12, firstNonZeroDec + maxDecOnly - 1);
    const factor = Math.pow(10, clampedDec);
    const snapped = Math.round(priceNum * factor + 1e-9) / factor;
    formatted = stripTrailingDecimalZeros(snapped.toFixed(clampedDec));
  }

  if (!DECIMAL_STR_RE.test(formatted) || Number(formatted) <= 0) {
    throw new Error(`Không thể làm tròn giá ${rawPrice} theo price_precision`);
  }
  return formatted;
}

class VariationalConnector {
  constructor() {
    this.statsCache = null;
    this.lastStatsFetchTime = 0;
    this.statsCacheTtlMs = 3000;
    this.isFetchingStats = false;

    this.instrumentsCache = {
      testnet: { data: null, fetchedAt: 0 },
      prod: { data: null, fetchedAt: 0 },
    };
    this.clockOffsetMs = {
      testnet: 0,
      prod: 0,
    };
    this.livePositionsCache = {};
    this.livePositionsInFlight = {};
  }

  resolveEffectiveUserId(userId, allowGuestFallback = false) {
    if (this.getUserConfig(userId).hasApiKey) return userId;
    if (allowGuestFallback) {
      if (this.getUserConfig('guest').hasApiKey) return 'guest';
      if (fs.existsSync(VARIO_AGENTS_DIR)) {
        try {
          const files = fs.readdirSync(VARIO_AGENTS_DIR).filter((f) => f.endsWith('.json'));
          for (const file of files) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(VARIO_AGENTS_DIR, file), 'utf8'));
              if (data.encryptedSeed) return data.userId || file.replace(/\.json$/, '');
            } catch {}
          }
        } catch {}
      }
    }
    return userId;
  }

  invalidateLivePositionsCache(userId) {
    if (!userId) {
      this.livePositionsCache = {};
      return;
    }
    delete this.livePositionsCache[sanitizeUserId(userId)];
  }

  async getExchangeStats() {
    const now = Date.now();
    if (this.statsCache && (now - this.lastStatsFetchTime < this.statsCacheTtlMs)) {
      return this.statsCache;
    }

    if (this.isFetchingStats && this.statsCache) {
      return this.statsCache;
    }

    try {
      this.isFetchingStats = true;
      const res = await axios.get(STATS_API_URL, {
        timeout: 4500,
        headers: {
          'User-Agent': 'HyperView-Terminal/2.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json',
        },
      });

      if (res.data && res.data.listings) {
        this.statsCache = res.data;
        this.lastStatsFetchTime = now;
      }
      return this.statsCache;
    } catch (err) {
      if (this.statsCache) return this.statsCache;
      throw new Error(`Failed to fetch Variational stats: ${err.message}`);
    } finally {
      this.isFetchingStats = false;
    }
  }

  normalizeTicker(symbolOrCoin) {
    if (!symbolOrCoin) return 'BTC-PERP';
    let s = String(symbolOrCoin).toUpperCase().trim();
    if (s.includes(':')) s = s.split(':')[1];
    if (s.endsWith('.P')) s = s.slice(0, -2);
    if (s.endsWith('USDT') || s.endsWith('USDC') || s.endsWith('USD')) {
      s = s.replace(/(USDT|USDC|USD)$/, '');
    }
    if (s.endsWith('-PERP') || s.endsWith('-SWAP')) return s;
    return `${s}-PERP`;
  }

  async getMarketInfo(ticker) {
    const stats = await this.getExchangeStats();
    if (!stats || !stats.listings) return null;
    const normalized = this.normalizeTicker(ticker);
    return stats.listings.find((l) => l.ticker === normalized) || null;
  }

  readRawRecord(userId) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(VARIO_AGENTS_DIR, `${safeId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.warn(`[Variational] Error reading config for ${userId}:`, e.message);
      return null;
    }
  }

  writeRawRecord(userId, record) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(VARIO_AGENTS_DIR, `${safeId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
  }

  getEnvFallbackSeed() {
    const envRaw = process.env.VARIATIONAL_TESTNET_PRIVATE_KEY;
    if (!envRaw || !String(envRaw).trim()) return null;
    try {
      return parseEd25519Seed(envRaw);
    } catch {
      return null;
    }
  }

  getUserConfig(userId) {
    const data = this.readRawRecord(userId) || {};
    const env = normalizeEnvironment(data.environment || 'testnet');
    const envMeta = ENVIRONMENTS[env];

    let hasApiKey = false;
    let publicKey = data.publicKey || '';
    if (data.encryptedSeed) {
      try {
        const seed = decryptSeed(data.encryptedSeed);
        hasApiKey = true;
        if (!publicKey) publicKey = deriveEd25519PublicKey(seed);
      } catch {
        hasApiKey = false;
      }
    } else if (env === 'testnet') {
      const envSeed = this.getEnvFallbackSeed();
      if (envSeed) {
        hasApiKey = true;
        publicKey = deriveEd25519PublicKey(envSeed);
      }
    }

    const maskedApiSecret = hasApiKey && publicKey
      ? `${publicKey.slice(0, 8)}••••••••••••${publicKey.slice(-6)}`
      : '';

    return {
      configured: Boolean(hasApiKey || data.walletAddress),
      hasApiKey,
      hasPrivateKey: hasApiKey,
      environment: env,
      baseUrl: envMeta.baseUrl,
      appUrl: envMeta.appUrl,
      publicKey,
      maskedApiSecret,
      walletAddress: data.walletAddress || '',
      maxSlippage: String(data.maxSlippage || '0.005'),
      defaultLeverage: parseInt(data.defaultLeverage, 10) || 2,
      autoMirrorEnabled: Boolean(data.autoMirrorEnabled ?? data.autoFarmEnabled),
      mirrorNotionalUsd: parseFloat(data.mirrorNotionalUsd) || 100,
      totalFarmedVolume: data.totalFarmedVolume || 0,
      estimatedPoints: data.estimatedPoints || 0,
      farmedTradesCount: data.farmedTradesCount || 0,
      recentOrders: Array.isArray(data.recentOrders) ? data.recentOrders.slice(0, 20) : [],
      updatedAt: data.updatedAt || null,
    };
  }

  saveUserConfig(
    userId,
    {
      environment = 'testnet',
      apiPrivateKey = '',
      apiSecret = '',
      seed = '',
      walletAddress = '',
      maxSlippage = '0.005',
      defaultLeverage = 2,
      autoMirrorEnabled,
      autoFarmEnabled,
      mirrorNotionalUsd = 100,
    } = {}
  ) {
    const existing = this.readRawRecord(userId) || {};
    const cleanEnv = normalizeEnvironment(environment || existing.environment || 'testnet');
    const rawKeyInput = String(apiPrivateKey || apiSecret || seed || '').trim();

    let encryptedSeed = existing.encryptedSeed || '';
    let publicKey = existing.publicKey || '';

    if (rawKeyInput) {
      const parsedSeed = parseEd25519Seed(rawKeyInput);
      publicKey = deriveEd25519PublicKey(parsedSeed);
      encryptedSeed = encryptSeed(parsedSeed);
    }

    let cleanAddress = String(walletAddress !== undefined ? walletAddress : existing.walletAddress || '').trim();
    if (cleanAddress) {
      try {
        cleanAddress = ethers.getAddress(cleanAddress.toLowerCase());
      } catch {
        throw new Error('Địa chỉ ví EVM (Arbitrum) không hợp lệ (Phải là địa chỉ hex 0x 40 ký tự)');
      }
    }

    if (!encryptedSeed && !cleanAddress && !this.getEnvFallbackSeed()) {
      throw new Error('Vui lòng nhập Ed25519 Private Key (API Secret) từ Variational Omni hoặc địa chỉ ví Arbitrum');
    }

    const slipNum = parseFloat(maxSlippage !== undefined ? maxSlippage : existing.maxSlippage || '0.005');
    if (!Number.isFinite(slipNum) || slipNum <= 0 || slipNum > 1) {
      throw new Error('Max slippage phải nằm trong khoảng (0, 1] (ví dụ 0.005 cho 0.5%)');
    }
    const cleanSlippage = formatDecimalString(slipNum, 6);

    const mirrorNotional = parseFloat(
      mirrorNotionalUsd !== undefined ? mirrorNotionalUsd : existing.mirrorNotionalUsd || 100
    );
    const cleanMirrorNotional = Number.isFinite(mirrorNotional) && mirrorNotional > 0 ? mirrorNotional : 100;

    const mirrorFlag =
      autoMirrorEnabled !== undefined
        ? Boolean(autoMirrorEnabled)
        : autoFarmEnabled !== undefined
          ? Boolean(autoFarmEnabled)
          : Boolean(existing.autoMirrorEnabled);

    const record = {
      userId,
      environment: cleanEnv,
      publicKey,
      encryptedSeed,
      walletAddress: cleanAddress,
      maxSlippage: cleanSlippage,
      defaultLeverage: parseInt(defaultLeverage, 10) || existing.defaultLeverage || 2,
      autoMirrorEnabled: mirrorFlag,
      mirrorNotionalUsd: cleanMirrorNotional,
      totalFarmedVolume: existing.totalFarmedVolume || 0,
      estimatedPoints: existing.estimatedPoints || 0,
      farmedTradesCount: existing.farmedTradesCount || 0,
      recentOrders: Array.isArray(existing.recentOrders) ? existing.recentOrders.slice(0, 20) : [],
      updatedAt: new Date().toISOString(),
    };

    this.writeRawRecord(userId, record);
    this.invalidateLivePositionsCache(userId);

    const cfg = this.getUserConfig(userId);
    return {
      success: true,
      ...cfg,
      message: `Đã lưu cấu hình Variational Omni (${cleanEnv.toUpperCase()}) an toàn!`,
    };
  }

  deleteUserConfig(userId) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(VARIO_AGENTS_DIR, `${safeId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }
    this.invalidateLivePositionsCache(userId);
    return { success: true, message: 'Đã xóa cấu hình Variational Omni' };
  }

  resolveSigningCredentials(userId) {
    const data = this.readRawRecord(userId) || {};
    const envName = normalizeEnvironment(data.environment || 'testnet');
    const envMeta = ENVIRONMENTS[envName];

    let seedBuf = null;
    if (data.encryptedSeed) {
      seedBuf = decryptSeed(data.encryptedSeed);
    } else if (envName === 'testnet') {
      seedBuf = this.getEnvFallbackSeed();
    }

    if (!seedBuf) {
      throw new Error(
        `Chưa cấu hình Ed25519 API Private Key cho Variational ${envName.toUpperCase()}. Hãy tạo key tại ${envMeta.appUrl} (Settings → API Keys, scope read + trade) rồi dán vào cấu hình.`
      );
    }

    return {
      envName,
      baseUrl: envMeta.baseUrl,
      appUrl: envMeta.appUrl,
      seedBuf,
      publicKey: deriveEd25519PublicKey(seedBuf),
      config: data,
    };
  }

  async signedRequest(userId, method, pathAndQuery, bodyObj = null) {
    const creds = this.resolveSigningCredentials(userId);
    const upperMethod = String(method).toUpperCase();
    const bodyStr = bodyObj !== null && bodyObj !== undefined ? JSON.stringify(bodyObj) : '';
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf8') : Buffer.alloc(0);

    const sendOnce = async () => {
      const ts = Math.round(Date.now() + (this.clockOffsetMs[creds.envName] || 0));
      const authHeaders = signRequest(creds.seedBuf, creds.envName, upperMethod, pathAndQuery, bodyBuf, ts);
      const headers = {
        Accept: 'application/json',
        ...authHeaders,
      };
      if (bodyStr.length > 0) {
        headers['Content-Type'] = 'application/json';
      }

      return axios({
        method: upperMethod,
        url: creds.baseUrl + pathAndQuery,
        headers,
        data: bodyStr.length > 0 ? bodyStr : undefined,
        transformRequest: [(d) => d],
        timeout: 10000,
        validateStatus: () => true,
      });
    };

    let res = await sendOnce();

    if (
      res.status === 401 &&
      res.data?.error_code === 'timestamp_out_of_window' &&
      Number.isFinite(Number(res.data?.server_time_ms))
    ) {
      this.clockOffsetMs[creds.envName] = Number(res.data.server_time_ms) - Date.now();
      res = await sendOnce();
    }

    if (res.status >= 200 && res.status < 300) {
      return res.data;
    }

    const errData = res.data && typeof res.data === 'object' ? res.data : {};
    const code = errData.error_code || `http_${res.status}`;
    const msg = errData.error_message || res.statusText || 'Variational API error';
    const err = new Error(`[${res.status} ${code}] ${msg}`);
    err.status = res.status;
    err.errorCode = code;
    err.errorFields = errData.error_fields || null;
    err.requestId = errData.request_id || res.headers?.['x-request-id'] || null;
    err.retryAfterMs = errData.retry_after_ms || null;
    err.order = errData.order || null;
    err.raw = errData;
    throw err;
  }

  async getStatus(userId) {
    return this.signedRequest(userId, 'GET', '/v1/status');
  }

  async getInstruments(userId, forceRefresh = false) {
    const data = this.readRawRecord(userId) || {};
    const envName = normalizeEnvironment(data.environment || 'testnet');
    const cache = this.instrumentsCache[envName];
    if (!forceRefresh && cache.data && Date.now() - cache.fetchedAt < 60000) {
      return cache.data;
    }

    const items = [];
    let cursor = null;
    let guard = 0;
    do {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const page = await this.signedRequest(userId, 'GET', `/v1/instruments${qs}`);
      if (Array.isArray(page?.results)) {
        items.push(...page.results);
      }
      cursor = page?.next || null;
      guard++;
    } while (cursor && guard < 10);

    cache.data = items;
    cache.fetchedAt = Date.now();
    return items;
  }

  async getInstrument(userId, symbol) {
    const sym = this.normalizeTicker(symbol);
    return this.signedRequest(userId, 'GET', `/v1/instruments/${encodeURIComponent(sym)}`);
  }

  async getTickers(userId) {
    const items = [];
    let cursor = null;
    let guard = 0;
    do {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const page = await this.signedRequest(userId, 'GET', `/v1/tickers${qs}`);
      if (Array.isArray(page?.results)) {
        items.push(...page.results);
      }
      cursor = page?.next || null;
      guard++;
    } while (cursor && guard < 10);
    return items;
  }

  async getTicker(userId, symbol) {
    const sym = this.normalizeTicker(symbol);
    try {
      return await this.signedRequest(userId, 'GET', `/v1/tickers/${encodeURIComponent(sym)}`);
    } catch (err) {
      // Fall back to public stats if user has no signed API key yet
      if (err.message && err.message.includes('Chưa cấu hình Ed25519')) {
        const market = await this.getMarketInfo(sym);
        if (market) {
          return {
            symbol: sym,
            mark_price: String(market.mark_price),
            index_price: null,
            updated_at: Date.now(),
            source: 'public_stats',
          };
        }
      }
      throw err;
    }
  }

  async getAccount(userId) {
    return this.signedRequest(userId, 'GET', '/v1/account');
  }

  async getPositions(userId) {
    return this.signedRequest(userId, 'GET', '/v1/positions');
  }

  async getPosition(userId, symbol) {
    const sym = this.normalizeTicker(symbol);
    return this.signedRequest(userId, 'GET', `/v1/positions/${encodeURIComponent(sym)}`);
  }

  async getOrders(userId, { symbol, client_order_id } = {}) {
    const params = [];
    if (symbol) params.push(`symbol=${encodeURIComponent(this.normalizeTicker(symbol))}`);
    if (client_order_id) params.push(`client_order_id=${encodeURIComponent(String(client_order_id))}`);
    const qs = params.length > 0 ? `?${params.join('&')}` : '';
    return this.signedRequest(userId, 'GET', `/v1/orders${qs}`);
  }

  async getOrder(userId, orderId) {
    return this.signedRequest(userId, 'GET', `/v1/orders/${encodeURIComponent(String(orderId))}`);
  }

  async getOrderHistory(userId, { symbol, limit = 20, cursor } = {}) {
    const params = [];
    if (symbol) params.push(`symbol=${encodeURIComponent(this.normalizeTicker(symbol))}`);
    if (limit) params.push(`limit=${encodeURIComponent(String(limit))}`);
    if (cursor) params.push(`cursor=${encodeURIComponent(String(cursor))}`);
    const qs = params.length > 0 ? `?${params.join('&')}` : '';
    return this.signedRequest(userId, 'GET', `/v1/orders/history${qs}`);
  }

  async getFills(userId, { symbol, limit = 20, cursor } = {}) {
    const params = [];
    if (symbol) params.push(`symbol=${encodeURIComponent(this.normalizeTicker(symbol))}`);
    if (limit) params.push(`limit=${encodeURIComponent(String(limit))}`);
    if (cursor) params.push(`cursor=${encodeURIComponent(String(cursor))}`);
    const qs = params.length > 0 ? `?${params.join('&')}` : '';
    return this.signedRequest(userId, 'GET', `/v1/fills${qs}`);
  }

  buildChildOrderBody(triggerPrice, triggerBy, maxSlippage, pricePrecision) {
    const trig = roundToPricePrecision(triggerPrice, pricePrecision);
    const trigBy = triggerBy === 'quote' ? 'quote' : 'mark';
    let slip = null;
    if (maxSlippage !== null && maxSlippage !== undefined && maxSlippage !== '') {
      const sNum = Number(maxSlippage);
      if (Number.isFinite(sNum) && sNum > 0 && sNum <= 1) {
        slip = formatDecimalString(sNum, 6);
      }
    }
    return {
      trigger_price: trig,
      trigger_by: trigBy,
      max_slippage: slip,
    };
  }

  buildOrderPayload(params = {}, instrument = null, markPrice = null) {
    const symbol = this.normalizeTicker(params.symbol || params.coin || 'BTC-PERP');
    const rawType = String(params.type || params.orderType || 'market').toLowerCase().trim();
    const type = ['market', 'limit', 'take_profit', 'stop_loss'].includes(rawType) ? rawType : null;
    if (!type) {
      throw new Error(`Loại lệnh không hợp lệ: "${rawType}" (hỗ trợ market, limit, take_profit, stop_loss)`);
    }

    const rawSide = String(params.side || 'buy').toLowerCase().trim();
    const side = rawSide === 'long' || rawSide === 'buy'
      ? 'buy'
      : rawSide === 'short' || rawSide === 'sell'
        ? 'sell'
        : null;
    if (!side) {
      throw new Error(`Chiều lệnh không hợp lệ: "${params.side}" (buy hoặc sell)`);
    }

    let rawSize = params.size !== undefined && params.size !== null && params.size !== ''
      ? Number(params.size)
      : NaN;
    const rawNotional = params.notionalUsd !== undefined && params.notionalUsd !== null && params.notionalUsd !== ''
      ? Number(params.notionalUsd)
      : Number(params.notional);

    if ((!Number.isFinite(rawSize) || rawSize <= 0) && Number.isFinite(rawNotional) && rawNotional > 0) {
      const refPrice = Number(params.price || params.trigger_price || markPrice);
      if (!Number.isFinite(refPrice) || refPrice <= 0) {
        throw new Error(`Không có giá tham chiếu (mark price) cho ${symbol} để quy đổi Notional sang Size`);
      }
      rawSize = rawNotional / refPrice;
    }

    const size = roundToSizeStep(rawSize, instrument?.size_step || null);

    // Optional notional validation against instrument.min_notional
    const evalPrice = Number(params.price || params.trigger_price || markPrice);
    if (instrument?.min_notional && Number.isFinite(evalPrice) && evalPrice > 0) {
      const minNotional = Number(instrument.min_notional);
      const actualNotional = Number(size) * evalPrice;
      if (Number.isFinite(minNotional) && actualNotional + 1e-6 < minNotional) {
        throw new Error(
          `Giá trị lệnh (~$${actualNotional.toFixed(2)}) nhỏ hơn mức tối thiểu của ${symbol} ($${instrument.min_notional} USDC)`
        );
      }
    }

    const rawSlip = params.max_slippage !== undefined && params.max_slippage !== null && params.max_slippage !== ''
      ? params.max_slippage
      : params.maxSlippage;

    let maxSlippageStr = null;
    if (rawSlip !== null && rawSlip !== undefined && rawSlip !== '') {
      const slipNum = Number(rawSlip);
      if (!Number.isFinite(slipNum) || slipNum <= 0 || slipNum > 1) {
        throw new Error('max_slippage phải > 0 và <= 1 (ví dụ "0.005" cho 0.5%)');
      }
      maxSlippageStr = formatDecimalString(slipNum, 6);
    } else if (type === 'market') {
      maxSlippageStr = '0.005';
    }

    let clientOrderId = params.client_order_id ? String(params.client_order_id).trim() : '';
    if (!clientOrderId) {
      clientOrderId = `hv-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    } else if (!CLIENT_ORDER_ID_RE.test(clientOrderId)) {
      throw new Error('client_order_id chỉ được dài 1–36 ký tự (chữ ASCII, số, _, :, -)');
    }

    const pricePrecision = instrument?.price_precision || null;
    const triggerBy = params.trigger_by === 'quote' || params.triggerBy === 'quote' ? 'quote' : 'mark';
    const tpRaw = params.take_profit?.trigger_price ?? params.takeProfitPrice ?? params.tp;
    const slRaw = params.stop_loss?.trigger_price ?? params.stopLossPrice ?? params.sl;

    const payload = {
      client_order_id: clientOrderId,
      type,
      symbol,
      side,
      size,
      max_slippage: maxSlippageStr,
    };

    if (type === 'market') {
      if (params.reduce_only !== undefined || params.reduceOnly !== undefined) {
        payload.reduce_only = Boolean(params.reduce_only ?? params.reduceOnly);
      }
      if (tpRaw !== undefined && tpRaw !== null && tpRaw !== '' && Number(tpRaw) > 0) {
        payload.take_profit = this.buildChildOrderBody(
          tpRaw,
          params.take_profit?.trigger_by || triggerBy,
          params.take_profit?.max_slippage ?? maxSlippageStr,
          pricePrecision
        );
      }
      if (slRaw !== undefined && slRaw !== null && slRaw !== '' && Number(slRaw) > 0) {
        payload.stop_loss = this.buildChildOrderBody(
          slRaw,
          params.stop_loss?.trigger_by || triggerBy,
          params.stop_loss?.max_slippage ?? maxSlippageStr,
          pricePrecision
        );
      }
      return payload;
    }

    if (type === 'limit') {
      const limitPriceRaw = params.price ?? params.limitPrice;
      payload.price = roundToPricePrecision(limitPriceRaw, pricePrecision);
      payload.trigger_by = triggerBy;
      if (params.reduce_only !== undefined || params.reduceOnly !== undefined) {
        payload.reduce_only = Boolean(params.reduce_only ?? params.reduceOnly);
      }
      if (tpRaw !== undefined && tpRaw !== null && tpRaw !== '' && Number(tpRaw) > 0) {
        payload.take_profit = this.buildChildOrderBody(
          tpRaw,
          params.take_profit?.trigger_by || triggerBy,
          params.take_profit?.max_slippage ?? maxSlippageStr,
          pricePrecision
        );
      }
      if (slRaw !== undefined && slRaw !== null && slRaw !== '' && Number(slRaw) > 0) {
        payload.stop_loss = this.buildChildOrderBody(
          slRaw,
          params.stop_loss?.trigger_by || triggerBy,
          params.stop_loss?.max_slippage ?? maxSlippageStr,
          pricePrecision
        );
      }
      return payload;
    }

    // Standalone take_profit or stop_loss (always reduce-only; strictly no reduce_only/take_profit/stop_loss fields)
    const trigRaw = params.trigger_price ?? params.triggerPrice ?? params.price;
    payload.trigger_price = roundToPricePrecision(trigRaw, pricePrecision);
    payload.trigger_by = triggerBy;
    return payload;
  }

  recordOrder(userId, orderRecord, notionalUsd = 0) {
    const existing = this.readRawRecord(userId);
    if (!existing) return null;
    try {
      const addNotional = Math.abs(parseFloat(notionalUsd) || 0);
      existing.totalFarmedVolume = Math.round(((existing.totalFarmedVolume || 0) + addNotional) * 100) / 100;
      existing.farmedTradesCount = (existing.farmedTradesCount || 0) + 1;
      existing.estimatedPoints = Math.round(((existing.estimatedPoints || 0) + addNotional / 100) * 10) / 10;
      const history = Array.isArray(existing.recentOrders) ? existing.recentOrders : [];
      history.unshift(orderRecord);
      existing.recentOrders = history.slice(0, 20);
      existing.updatedAt = new Date().toISOString();
      this.writeRawRecord(userId, existing);
      return existing;
    } catch {
      return null;
    }
  }

  recordTrade(userId, { symbol, side, notional, price }) {
    return this.recordOrder(userId, { symbol, side, notional, price, timestamp: Date.now() }, notional);
  }

  async placeOrder(userId, params = {}) {
    const cfg = this.getUserConfig(userId);
    const sym = this.normalizeTicker(params.symbol || params.coin || 'BTC-PERP');

    let instrument = null;
    let markPrice = null;
    try {
      instrument = await this.getInstrument(userId, sym);
    } catch {}

    const needsMarkPrice =
      (!params.size || Number(params.size) <= 0) &&
      (Number(params.notionalUsd) > 0 || Number(params.notional) > 0);

    if (needsMarkPrice || (instrument && !params.price && !params.trigger_price)) {
      try {
        const ticker = await this.getTicker(userId, sym);
        if (ticker?.mark_price) markPrice = parseFloat(ticker.mark_price);
      } catch {}
    }

    const payload = this.buildOrderPayload(
      {
        ...params,
        symbol: sym,
        max_slippage:
          params.max_slippage !== undefined
            ? params.max_slippage
            : params.maxSlippage !== undefined
              ? params.maxSlippage
              : cfg.maxSlippage,
      },
      instrument,
      markPrice
    );

    const response = await this.signedRequest(userId, 'POST', '/v1/orders', payload);
    const placed = Array.isArray(response?.placed) ? response.placed : [];
    const primaryOrder = placed[0] || response;

    const fillPx = parseFloat(primaryOrder?.fill_price || payload.price || payload.trigger_price || markPrice || 0);
    const orderNotional = fillPx > 0 ? Number(payload.size) * fillPx : Number(params.notionalUsd || params.notional || 0);

    this.recordOrder(
      userId,
      {
        order_id: primaryOrder?.order_id || null,
        client_order_id: primaryOrder?.client_order_id || payload.client_order_id,
        symbol: payload.symbol,
        side: payload.side,
        type: payload.type,
        size: payload.size,
        status: primaryOrder?.status || 'queued',
        fill_price: primaryOrder?.fill_price || null,
        environment: cfg.environment,
        created_at: primaryOrder?.created_at || Date.now(),
      },
      orderNotional
    );
    this.invalidateLivePositionsCache(userId);

    return {
      success: true,
      environment: cfg.environment,
      requestBody: payload,
      placed,
      order: primaryOrder,
    };
  }

  async cancelOrder(userId, { order_id, client_order_id } = {}) {
    const params = [];
    if (order_id) params.push(`order_id=${encodeURIComponent(String(order_id))}`);
    if (client_order_id) params.push(`client_order_id=${encodeURIComponent(String(client_order_id))}`);
    if (params.length === 0) {
      throw new Error('Cần cung cấp order_id hoặc client_order_id để hủy lệnh');
    }
    const res = await this.signedRequest(userId, 'DELETE', `/v1/orders?${params.join('&')}`);
    this.invalidateLivePositionsCache(userId);
    return { success: true, canceled: res?.canceled || [] };
  }

  async cancelAllOrders(userId, { symbol, all } = {}) {
    const params = [];
    if (symbol) {
      params.push(`symbol=${encodeURIComponent(this.normalizeTicker(symbol))}`);
    } else {
      params.push(`all=${all === false ? 'false' : 'true'}`);
    }
    const res = await this.signedRequest(userId, 'DELETE', `/v1/orders/batch?${params.join('&')}`);
    this.invalidateLivePositionsCache(userId);
    return { success: true, canceled: res?.canceled || [] };
  }

  async closePosition(userId, symbol, maxSlippage, fraction = 1.0) {
    const sym = this.normalizeTicker(symbol);
    const pos = await this.getPosition(userId, sym);
    const rawSize = parseFloat(pos?.size || '0');
    if (!Number.isFinite(rawSize) || rawSize === 0) {
      throw new Error(`Không có vị thế đang mở cho ${sym}`);
    }

    const closeSide = rawSize > 0 ? 'sell' : 'buy';
    const frac = Number(fraction);
    let closeSize;
    if (Number.isFinite(frac) && frac > 0 && frac < 0.99) {
      let instrument = null;
      try {
        instrument = await this.getInstrument(userId, sym);
      } catch {}
      closeSize = roundToSizeStep(Math.abs(rawSize) * frac, instrument?.size_step || null);
    } else {
      closeSize = formatDecimalString(Math.abs(rawSize), 12);
    }

    const res = await this.placeOrder(userId, {
      symbol: sym,
      side: closeSide,
      type: 'market',
      size: closeSize,
      reduce_only: true,
      max_slippage: maxSlippage || '0.01',
    });
    this.invalidateLivePositionsCache(userId);
    return res;
  }

  async verifyConnection(userId) {
    const creds = this.resolveSigningCredentials(userId);
    const cfg = this.getUserConfig(userId);

    const [statusRes, accountRes, posRes, ordersRes] = await Promise.all([
      this.getStatus(userId),
      this.getAccount(userId),
      this.getPositions(userId).catch(() => ({ results: [] })),
      this.getOrders(userId).catch(() => ({ results: [] })),
    ]);

    let ethBalance = null;
    if (cfg.walletAddress) {
      try {
        const rpcUrl = creds.envName === 'testnet'
          ? 'https://sepolia-rollup.arbitrum.io/rpc'
          : 'https://arb1.arbitrum.io/rpc';
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const bal = await provider.getBalance(cfg.walletAddress);
        ethBalance = parseFloat(ethers.formatEther(bal)).toFixed(4);
      } catch {}
    }

    const openPositionsCount = Array.isArray(posRes?.results)
      ? posRes.results.filter((p) => Math.abs(parseFloat(p.size || '0')) > 0).length
      : 0;
    const openOrdersCount = Array.isArray(ordersRes?.results) ? ordersRes.results.length : 0;

    return {
      verified: true,
      environment: creds.envName,
      baseUrl: creds.baseUrl,
      publicKey: creds.publicKey,
      apiStatus: statusRes?.status || 'ok',
      equity: accountRes?.equity || '0',
      available: accountRes?.cross?.available || '0',
      unrealizedPnl: accountRes?.unrealized_pnl || '0',
      openPositionsCount,
      openOrdersCount,
      ethBalance,
      message: `Kết nối Variational Omni (${creds.envName.toUpperCase()}) xác thực Ed25519 thành công!`,
    };
  }

  async getDashboardData(userId) {
    const cfg = this.getUserConfig(userId);
    if (!cfg.hasApiKey) {
      return {
        success: true,
        configured: cfg.configured,
        hasApiKey: false,
        environment: cfg.environment,
        baseUrl: cfg.baseUrl,
        appUrl: cfg.appUrl,
        publicKey: cfg.publicKey,
        status: null,
        account: null,
        positions: [],
        orders: [],
        fills: [],
        instruments: [],
      };
    }

    const [statusRes, accountRes, positionsRes, ordersRes, fillsRes, instrumentsRes] = await Promise.allSettled([
      this.getStatus(userId),
      this.getAccount(userId),
      this.getPositions(userId),
      this.getOrders(userId),
      this.getFills(userId, { limit: 15 }),
      this.getInstruments(userId),
    ]);

    const firstErr = [statusRes, accountRes, positionsRes, ordersRes].find((r) => r.status === 'rejected')?.reason || null;
    if (statusRes.status === 'rejected' && accountRes.status === 'rejected') {
      throw firstErr;
    }

    const positions =
      positionsRes.status === 'fulfilled' && Array.isArray(positionsRes.value?.results)
        ? positionsRes.value.results.filter((p) => Math.abs(parseFloat(p.size || '0')) > 0)
        : [];

    return {
      success: true,
      configured: true,
      hasApiKey: true,
      environment: cfg.environment,
      baseUrl: cfg.baseUrl,
      appUrl: cfg.appUrl,
      publicKey: cfg.publicKey,
      status: statusRes.status === 'fulfilled' ? statusRes.value?.status : 'unknown',
      account: accountRes.status === 'fulfilled' ? accountRes.value : null,
      positions,
      orders: ordersRes.status === 'fulfilled' && Array.isArray(ordersRes.value?.results) ? ordersRes.value.results : [],
      fills: fillsRes.status === 'fulfilled' && Array.isArray(fillsRes.value?.results) ? fillsRes.value.results : [],
      instruments: instrumentsRes.status === 'fulfilled' && Array.isArray(instrumentsRes.value) ? instrumentsRes.value : [],
    };
  }

  async getLivePositionsSnapshot(userId, { forceRefresh = false, ttlMs = 10000, allowGuestFallback = false } = {}) {
    const effectiveId = this.resolveEffectiveUserId(userId, allowGuestFallback);
    const cfg = this.getUserConfig(effectiveId);
    if (!cfg.hasApiKey) {
      return {
        connected: false,
        environment: cfg.environment,
        autoMirrorEnabled: false,
        mirrorNotionalUsd: cfg.mirrorNotionalUsd,
        positions: [],
        fetchedAt: Date.now(),
        error: null,
      };
    }

    const cacheKey = sanitizeUserId(effectiveId);
    const now = Date.now();
    const existing = this.livePositionsCache[cacheKey];

    if (!forceRefresh && existing) {
      if (existing.backoffUntil && now < existing.backoffUntil) {
        return {
          ...existing.data,
          autoMirrorEnabled: cfg.autoMirrorEnabled,
          mirrorNotionalUsd: cfg.mirrorNotionalUsd,
        };
      }
      if (now - existing.fetchedAt < ttlMs) {
        return {
          ...existing.data,
          autoMirrorEnabled: cfg.autoMirrorEnabled,
          mirrorNotionalUsd: cfg.mirrorNotionalUsd,
        };
      }
    }

    if (this.livePositionsInFlight[cacheKey]) {
      return this.livePositionsInFlight[cacheKey];
    }

    const task = (async () => {
      try {
        const [posRes, ordRes] = await Promise.allSettled([
          this.getPositions(effectiveId),
          this.getOrders(effectiveId),
        ]);

        const posErr = posRes.status === 'rejected' ? posRes.reason : null;
        const ordErr = ordRes.status === 'rejected' ? ordRes.reason : null;
        const rateErr = [posErr, ordErr].find((e) => e && (e.status === 429 || e.status === 418));

        if (rateErr) {
          const backoffMs = Math.max(30000, Number(rateErr.retryAfterMs) || 30000);
          const stalePositions = existing?.data?.positions || [];
          const snap = {
            connected: true,
            environment: cfg.environment,
            autoMirrorEnabled: cfg.autoMirrorEnabled,
            mirrorNotionalUsd: cfg.mirrorNotionalUsd,
            positions: stalePositions,
            fetchedAt: Date.now(),
            error: rateErr.message,
          };
          this.livePositionsCache[cacheKey] = {
            data: snap,
            fetchedAt: existing?.fetchedAt || Date.now(),
            backoffUntil: Date.now() + backoffMs,
          };
          return snap;
        }

        if (posErr) {
          const stalePositions = existing?.data?.positions || [];
          const snap = {
            connected: false,
            environment: cfg.environment,
            autoMirrorEnabled: cfg.autoMirrorEnabled,
            mirrorNotionalUsd: cfg.mirrorNotionalUsd,
            positions: stalePositions,
            fetchedAt: Date.now(),
            error: posErr.message,
          };
          this.livePositionsCache[cacheKey] = { data: snap, fetchedAt: Date.now(), backoffUntil: 0 };
          return snap;
        }

        const tpMap = {};
        const slMap = {};
        const openOrders = ordRes.status === 'fulfilled' && Array.isArray(ordRes.value?.results) ? ordRes.value.results : [];
        for (const o of openOrders) {
          if (!o || !o.symbol) continue;
          const trig = parseFloat(o.trigger_price || '0');
          if (!Number.isFinite(trig) || trig <= 0) continue;
          if (o.type === 'take_profit' && !tpMap[o.symbol]) tpMap[o.symbol] = trig;
          if (o.type === 'stop_loss' && !slMap[o.symbol]) slMap[o.symbol] = trig;
        }

        const rawList = Array.isArray(posRes.value?.results) ? posRes.value.results : [];
        const positions = [];
        for (const p of rawList) {
          const rawSize = parseFloat(p?.size || '0');
          if (!Number.isFinite(rawSize) || Math.abs(rawSize) <= 0) continue;
          const entryPrice = parseFloat(p.entry_price || '0') || 0;
          const markPrice = parseFloat(p.mark_price || p.entry_price || '0') || 0;
          const lev = parseFloat(p.leverage || '1') || 1;
          const margin = parseFloat(p.isolated_margin || p.initial_margin || '0') || 0;
          const upnl = parseFloat(p.unrealized_pnl || '0') || 0;
          const notional = Math.abs(rawSize) * (markPrice || entryPrice);
          const effectiveMargin = margin > 0 ? margin : (lev > 0 ? notional / lev : notional);

          positions.push({
            id: 'vario_' + p.symbol,
            source: 'VARIATIONAL',
            environment: cfg.environment,
            symbol: p.symbol,
            side: rawSize > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(rawSize),
            rawSize,
            leverage: lev,
            marginMode: p.margin_mode || 'cross',
            entryPrice,
            currentPrice: markPrice,
            takeProfit: tpMap[p.symbol] || null,
            stopLoss: slMap[p.symbol] || null,
            margin: effectiveMargin,
            notional,
            liquidationPrice: parseFloat(p.liquidation_price || '0') || null,
            unrealizedPnl: upnl,
            unrealizedPnlPercent: effectiveMargin > 0 ? Number(((upnl / effectiveMargin) * 100).toFixed(2)) : 0,
          });
        }

        const snap = {
          connected: true,
          environment: cfg.environment,
          autoMirrorEnabled: cfg.autoMirrorEnabled,
          mirrorNotionalUsd: cfg.mirrorNotionalUsd,
          positions,
          fetchedAt: Date.now(),
          error: null,
        };
        this.livePositionsCache[cacheKey] = { data: snap, fetchedAt: Date.now(), backoffUntil: 0 };
        return snap;
      } finally {
        delete this.livePositionsInFlight[cacheKey];
      }
    })();

    this.livePositionsInFlight[cacheKey] = task;
    return task;
  }

  getMirrorTargetUserId() {
    if (!fs.existsSync(VARIO_AGENTS_DIR)) return null;
    try {
      const files = fs.readdirSync(VARIO_AGENTS_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(VARIO_AGENTS_DIR, file), 'utf8'));
          const env = normalizeEnvironment(data.environment || 'testnet');
          if (env === 'testnet' && data.autoMirrorEnabled === true && data.encryptedSeed) {
            return {
              userId: data.userId || file.replace(/\.json$/, ''),
              maxSlippage: String(data.maxSlippage || '0.005'),
              mirrorNotionalUsd: parseFloat(data.mirrorNotionalUsd) || 100,
            };
          }
        } catch {}
      }
    } catch {}
    return null;
  }
}

const variationalConnector = new VariationalConnector();

module.exports = {
  variationalConnector,
  VariationalConnector,
  ENVIRONMENTS,
  parseEd25519Seed,
  deriveEd25519PublicKey,
  buildCanonicalString,
  signRequest,
  roundToSizeStep,
  roundToPricePrecision,
};
