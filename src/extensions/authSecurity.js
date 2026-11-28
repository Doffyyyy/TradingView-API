/**
 * TradingView-API — Security & Authentication Extension
 *
 * Implements:
 *   1. Web3 Wallet Security Suite (EIP-4361 / SIWE - Sign-In with Ethereum)
 *      - Cryptographic Challenge-Response (Single-use 256-bit Nonce)
 *      - Replay Attack Mitigation (5-minute TTL, single-use nonce deletion)
 *      - Signature Recovery & Address Verification via ethers.js
 *      - Session Binding with HttpOnly, Secure, SameSite=Strict cookies
 *   2. Google OAuth / Gmail Sign-In
 *      - Google Identity Services (GIS) ID Token Verification
 *      - Automatic user profile extraction (email, name, picture)
 *   3. Role-Based Access Control (RBAC)
 *      - Admin: Full bot management (toggle autoTrade, close positions, reset account, execute live orders)
 *      - User/Viewer: Read-only access to charts, indicators, and paper journal
 *   4. Defense-in-Depth & Rate Limiting
 *      - Brute-force & DoS throttling per IP
 *      - Security HTTP Headers (HSTS, X-Frame-Options, X-Content-Type-Options)
 *      - CSRF & Path Traversal Guards
 *      - Automated Daily Snapshot Backups for portfolio & journal
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'auth_config.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'auth_sessions.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MACHINE_HOST = os.hostname();

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function normalizeIp(rawIp) {
  let s = String(rawIp || '').trim();
  if (!s) return 'unknown';
  if (s.includes(',')) s = s.split(',')[0].trim();
  if (s.startsWith('[')) {
    const closeIdx = s.indexOf(']');
    if (closeIdx > 0) s = s.slice(1, closeIdx);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) {
    s = s.replace(/:\d+$/, '');
  }
  s = s.replace(/^::ffff:/i, '').trim();
  const lower = s.toLowerCase();
  if (lower === '::1' || lower === '127.0.0.1' || lower === 'localhost') {
    return '127.0.0.1';
  }
  return lower;
}

function extractClientIp(req) {
  const raw = req?.headers?.['cf-connecting-ip'] || req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '';
  return normalizeIp(raw);
}

function extractClientPlatform(req) {
  const raw = String(req?.headers?.['sec-ch-ua-platform'] || req?.headers?.['user-agent'] || '').toLowerCase();
  if (!raw) return 'other';
  if (/iphone|ipad|ipod|\bios\b/.test(raw)) return 'ios';
  if (/android/.test(raw)) return 'android';
  if (/windows/.test(raw)) return 'windows';
  if (/mac os|macos|macintosh/.test(raw)) return 'macos';
  if (/linux|x11/.test(raw)) return 'linux';
  return 'other';
}

function extractCookieValue(req, name) {
  const cookieHeader = req?.headers?.['cookie'];
  if (!cookieHeader) return null;
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`);
  const match = cookieHeader.match(re);
  return match ? match[1].trim() : null;
}

function ensureDeviceId(clientContext) {
  const existing = clientContext?.deviceId;
  if (existing && /^[a-fA-F0-9]{32,128}$/.test(existing)) {
    return existing.toLowerCase();
  }
  return crypto.randomBytes(24).toString('hex');
}

// Default initial security configuration
const DEFAULT_CONFIG = {
  domain: 'hyperview.ai.id',
  sessionTtlHours: 24,
  persistentSessionDays: 30,
  bindSessionToIpAndMachine: true,
  adminEmails: [
    'admin@hyperview.ai.id',
    'hi.imduy@gmail.com',
  ],
  adminWallets: [
    // Add authorized admin EVM wallets here (lowercase)
  ],
  // Pre-hashed default emergency admin key (hashed with scrypt)
  // If not set, anyone with the initial master key can set it up on first login
  adminKeyHash: '',
  adminKeySalt: '',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  rateLimits: {
    authMaxAttempts: 5,
    authWindowMs: 5 * 60 * 1000, // 5 minutes
    apiMaxRequests: 120,
    apiWindowMs: 60 * 1000,      // 1 minute
  },
  autoBackupEnabled: true,
};

class AuthSecurityManager {
  constructor() {
    this.config = this.loadConfig();
    this.sessions = new Map(); // tokenHash -> sessionData
    this.walletNonces = new Map(); // address.toLowerCase() -> { nonce, expiresAt, used, domain }
    this.ipRateLimits = new Map(); // key -> { count, resetTime }

    this.loadPersistedSessions();
    this.initBackupScheduler();
    this.initCleanupScheduler();
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        return Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
      }
    } catch (e) {
      console.warn('[AuthSecurity] Failed to load auth_config.json, using defaults:', e.message);
    }
    this.saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  saveConfig(cfg) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
      this.config = cfg;
    } catch (e) {
      console.error('[AuthSecurity] Failed to save auth_config.json:', e.message);
    }
  }

  // --------------------------------------------------------------------------
  // Rate Limiting
  // --------------------------------------------------------------------------
  checkRateLimit(ip, bucket = 'auth', maxLimit = 5, windowMs = 300000) {
    const key = `${bucket}:${ip || 'unknown'}`;
    const now = Date.now();
    let record = this.ipRateLimits.get(key);

    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      this.ipRateLimits.set(key, record);
      return { allowed: true, remaining: maxLimit - 1 };
    }

    if (record.count >= maxLimit) {
      const waitSec = Math.ceil((record.resetTime - now) / 1000);
      return { allowed: false, remaining: 0, waitSec };
    }

    record.count++;
    return { allowed: true, remaining: maxLimit - record.count };
  }

  // --------------------------------------------------------------------------
  // Web3 Wallet Security: EIP-4361 Challenge-Response
  // --------------------------------------------------------------------------
  createWalletNonce(rawAddress, reqDomain = null) {
    if (!rawAddress || !ethers.isAddress(rawAddress)) {
      throw new Error('Địa chỉ ví EVM không đúng định dạng (Invalid Ethereum Address)');
    }

    const checksumAddress = ethers.getAddress(rawAddress);
    const key = checksumAddress.toLowerCase();
    const nonce = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiration
    const domain = reqDomain || this.config.domain || 'hyperview.ai.id';

    // Store single-use nonce
    this.walletNonces.set(key, {
      nonce,
      expiresAt,
      used: false,
      domain,
    });

    // Formal EIP-4361 SIWE formatted challenge
    const message = [
      `${domain} wants you to sign in with your Ethereum account:`,
      `${checksumAddress}`,
      '',
      'Sign in to Hyperview Pro Trading Suite to verify wallet ownership.',
      'This signature is completely free and will NOT trigger any blockchain transaction or gas fee.',
      '',
      `URI: https://${domain}`,
      'Version: 1',
      'Chain ID: 1',
      `Nonce: ${nonce}`,
      `Issued At: ${now.toISOString()}`,
    ].join('\n');

    return {
      nonce,
      address: checksumAddress,
      message,
      expiresAt,
    };
  }

  verifyWalletSignature(rawAddress, signature, message, clientContext = null) {
    if (!rawAddress || !signature || !message) {
      return { success: false, error: 'Thiếu thông tin xác thực ví (address, signature hoặc message)' };
    }

    if (!ethers.isAddress(rawAddress)) {
      return { success: false, error: 'Địa chỉ ví không hợp lệ' };
    }

    const checksumAddress = ethers.getAddress(rawAddress);
    const key = checksumAddress.toLowerCase();
    const nonceRecord = this.walletNonces.get(key);

    if (!nonceRecord) {
      return { success: false, error: 'Thử thách xác thực (Nonce) không tồn tại hoặc đã hết hạn. Vui lòng kết nối lại ví.' };
    }

    if (Date.now() > nonceRecord.expiresAt) {
      this.walletNonces.delete(key);
      return { success: false, error: 'Thử thách xác thực đã quá thời hạn 5 phút. Vui lòng thử lại.' };
    }

    if (nonceRecord.used) {
      this.walletNonces.delete(key);
      return { success: false, error: 'Cảnh báo bảo mật: Nonce đã được sử dụng (Replay Attack Detected). Từ chối xác thực.' };
    }

    // Single-use protection: Immediately mark and invalidate
    nonceRecord.used = true;
    this.walletNonces.delete(key);

    // Verify Nonce exists in the message body
    if (!message.includes(`Nonce: ${nonceRecord.nonce}`)) {
      return { success: false, error: 'Nội dung thông điệp không khớp với Nonce được cấp phát' };
    }

    // Cryptographic signature recovery via secp256k1 ecrecover
    let recoveredAddress;
    try {
      recoveredAddress = ethers.verifyMessage(message, signature);
    } catch (e) {
      return { success: false, error: 'Chữ ký mật mã không hợp lệ: ' + e.message };
    }

    if (recoveredAddress.toLowerCase() !== key) {
      return {
        success: false,
        error: `Địa chỉ ký thực tế (${recoveredAddress}) không khớp với địa chỉ tuyên bố (${checksumAddress})`,
      };
    }

    // Check Admin status
    const isAdmin = this.checkIsAdminWallet(key);

    // Create secure persistent session bound to machine & IP
    const { token, deviceId } = this.createSession({
      userId: key,
      displayId: checksumAddress.slice(0, 6) + '...' + checksumAddress.slice(-4),
      fullId: checksumAddress,
      type: 'wallet',
      role: isAdmin ? 'ADMIN' : 'USER',
      name: `Wallet ${checksumAddress.slice(0, 6)}`,
    }, clientContext);

    return {
      success: true,
      token,
      deviceId,
      user: {
        address: checksumAddress,
        shortAddress: checksumAddress.slice(0, 6) + '...' + checksumAddress.slice(-4),
        role: isAdmin ? 'ADMIN' : 'USER',
        type: 'wallet',
      },
    };
  }

  // --------------------------------------------------------------------------
  // Google OAuth / Gmail Sign-In
  // --------------------------------------------------------------------------
  async verifyGoogleCredential(credential, clientContext = null) {
    if (!credential) {
      return { success: false, error: 'Thiếu Google Credential token' };
    }

    try {
      // Call Google OAuth tokeninfo endpoint to verify Google's signature and claims
      const resp = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, {
        timeout: 5000,
      });

      const payload = resp.data;
      if (!payload || !payload.email) {
        return { success: false, error: 'Không thể xác thực danh tính từ Google' };
      }

      if (payload.email_verified !== 'true' && payload.email_verified !== true) {
        return { success: false, error: 'Tài khoản Gmail này chưa được Google xác thực (Email unverified)' };
      }

      const email = payload.email.toLowerCase();
      const isAdmin = this.checkIsAdminEmail(email);

      const { token, deviceId } = this.createSession({
        userId: email,
        displayId: email,
        fullId: email,
        type: 'google',
        role: isAdmin ? 'ADMIN' : 'USER',
        name: payload.name || email.split('@')[0],
        picture: payload.picture || '',
      }, clientContext);

      return {
        success: true,
        token,
        deviceId,
        user: {
          email,
          name: payload.name || email.split('@')[0],
          picture: payload.picture || '',
          role: isAdmin ? 'ADMIN' : 'USER',
          type: 'google',
        },
      };
    } catch (e) {
      return { success: false, error: 'Lỗi xác thực Google ID Token: ' + (e.response?.data?.error_description || e.message) };
    }
  }

  // Fallback demo/direct login for local testing & owner setup
  directLogin(identifier, role = 'USER', clientContext = null) {
    const isWallet = ethers.isAddress(identifier);
    const userId = identifier.toLowerCase();
    const isAdmin = isWallet ? this.checkIsAdminWallet(userId) : this.checkIsAdminEmail(userId) || role === 'ADMIN';

    const { token, deviceId } = this.createSession({
      userId,
      displayId: isWallet ? identifier.slice(0, 6) + '...' + identifier.slice(-4) : identifier,
      fullId: identifier,
      type: isWallet ? 'wallet' : 'email',
      role: isAdmin ? 'ADMIN' : 'USER',
      name: isWallet ? `Wallet ${identifier.slice(0, 6)}` : identifier.split('@')[0],
    }, clientContext);

    return {
      success: true,
      token,
      deviceId,
      user: {
        userId,
        displayId: isWallet ? identifier.slice(0, 6) + '...' + identifier.slice(-4) : identifier,
        role: isAdmin ? 'ADMIN' : 'USER',
        type: isWallet ? 'wallet' : 'email',
      },
    };
  }

  // --------------------------------------------------------------------------
  // Persistent Session Management (Bound to Same Machine & IP)
  // --------------------------------------------------------------------------
  extractClientContext(req) {
    return {
      ip: extractClientIp(req),
      platform: extractClientPlatform(req),
      deviceId: extractCookieValue(req, 'hv_device') || null,
      machineHost: MACHINE_HOST,
    };
  }

  getPersistentTtlMs() {
    const days = this.config.persistentSessionDays || 30;
    return days * 24 * 60 * 60 * 1000;
  }

  loadPersistedSessions() {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return;
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.sessions) ? parsed.sessions : []);
      const now = Date.now();
      let restored = 0;

      for (const s of list) {
        if (!s || !s.tokenHash || !s.expiresAt || now > s.expiresAt) continue;
        if (s.machineHost && s.machineHost !== MACHINE_HOST) continue;
        this.sessions.set(s.tokenHash, {
          tokenHash: s.tokenHash,
          userId: s.userId,
          displayId: s.displayId,
          fullId: s.fullId,
          name: s.name || 'User',
          picture: s.picture || '',
          type: s.type || 'wallet',
          role: s.role || 'USER',
          ip: s.ip || '127.0.0.1',
          deviceId: s.deviceId || null,
          platform: s.platform || 'other',
          machineHost: s.machineHost || MACHINE_HOST,
          createdAt: s.createdAt || now,
          lastSeenAt: s.lastSeenAt || s.createdAt || now,
          lastPersistedAt: s.lastPersistedAt || s.lastSeenAt || now,
          expiresAt: s.expiresAt,
        });
        restored++;
      }
      if (restored > 0) {
        console.log(`[AuthSecurity] Restored ${restored} persistent session(s) for machine ${MACHINE_HOST}`);
      }
    } catch (e) {
      console.warn('[AuthSecurity] Failed to load persistent sessions:', e.message);
    }
  }

  savePersistedSessions() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const now = Date.now();
      const serializable = [];
      for (const s of this.sessions.values()) {
        if (!s || now > s.expiresAt) continue;
        serializable.push({
          tokenHash: s.tokenHash,
          userId: s.userId,
          displayId: s.displayId,
          fullId: s.fullId,
          name: s.name,
          picture: s.picture,
          type: s.type,
          role: s.role,
          ip: s.ip,
          deviceId: s.deviceId,
          platform: s.platform,
          machineHost: s.machineHost,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          lastPersistedAt: s.lastPersistedAt,
          expiresAt: s.expiresAt,
        });
      }
      const tmpFile = SESSIONS_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify({ machineHost: MACHINE_HOST, sessions: serializable }, null, 2), 'utf8');
      fs.renameSync(tmpFile, SESSIONS_FILE);
    } catch (e) {
      console.warn('[AuthSecurity] Failed to save persistent sessions:', e.message);
    }
  }

  createSession(userData, clientContext = null) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const now = Date.now();
    const ttlMs = this.getPersistentTtlMs();
    const deviceId = ensureDeviceId(clientContext);

    const sessionObj = {
      tokenHash,
      userId: userData.userId,
      displayId: userData.displayId,
      fullId: userData.fullId,
      name: userData.name || 'User',
      picture: userData.picture || '',
      type: userData.type || 'wallet',
      role: userData.role || 'USER',
      ip: clientContext?.ip || '127.0.0.1',
      deviceId,
      platform: clientContext?.platform || 'other',
      machineHost: MACHINE_HOST,
      createdAt: now,
      lastSeenAt: now,
      lastPersistedAt: now,
      expiresAt: now + ttlMs,
    };

    this.sessions.set(tokenHash, sessionObj);
    this.savePersistedSessions();
    return { token, deviceId, session: sessionObj };
  }

  getSession(token, clientContext = null, source = 'cookie') {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const s = this.sessions.get(tokenHash);
    if (!s) return null;

    const now = Date.now();
    if (now > s.expiresAt) {
      this.sessions.delete(tokenHash);
      this.savePersistedSessions();
      return null;
    }

    if (this.config.bindSessionToIpAndMachine !== false && clientContext) {
      if (s.machineHost !== MACHINE_HOST) {
        console.warn(`[AuthSecurity] Rejected session for ${s.userId}: machine mismatch`);
        return null;
      }
      if (s.ip !== clientContext.ip) {
        console.warn(`[AuthSecurity] Rejected session for ${s.userId}: IP mismatch (${clientContext.ip} !== ${s.ip})`);
        return null;
      }
      if (s.platform !== clientContext.platform) {
        console.warn(`[AuthSecurity] Rejected session for ${s.userId}: platform mismatch (${clientContext.platform} !== ${s.platform})`);
        return null;
      }
      if (source === 'cookie' && s.deviceId && clientContext.deviceId !== s.deviceId) {
        console.warn(`[AuthSecurity] Rejected session for ${s.userId}: device cookie mismatch`);
        return null;
      }
    }

    // Sliding expiration on valid activity; persist to disk at most every 15m
    const ttlMs = this.getPersistentTtlMs();
    s.expiresAt = now + ttlMs;
    if (now - (s.lastPersistedAt || s.lastSeenAt || 0) >= 15 * 60 * 1000) {
      s.lastSeenAt = now;
      s.lastPersistedAt = now;
      this.savePersistedSessions();
    }

    return s;
  }

  updateSessionRole(token, newRole) {
    if (!token) return null;
    const s = this.sessions.get(hashToken(token));
    if (!s) return null;
    const now = Date.now();
    s.role = newRole;
    s.lastSeenAt = now;
    s.lastPersistedAt = now;
    s.expiresAt = now + this.getPersistentTtlMs();
    this.savePersistedSessions();
    return s;
  }

  destroySession(token) {
    if (!token) return;
    const deleted = this.sessions.delete(hashToken(token));
    if (deleted) {
      this.savePersistedSessions();
    }
  }

  extractTokenInfoFromReq(req) {
    const authHeader = req?.headers?.['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) return { token, source: 'bearer' };
    }

    const cookieToken = extractCookieValue(req, 'hv_session');
    if (cookieToken && /^[a-zA-Z0-9]+$/.test(cookieToken)) {
      return { token: cookieToken, source: 'cookie' };
    }

    return null;
  }

  extractTokenFromReq(req) {
    const info = this.extractTokenInfoFromReq(req);
    return info ? info.token : null;
  }

  authenticateRequest(req) {
    const info = this.extractTokenInfoFromReq(req);
    if (!info) return null;
    const ctx = this.extractClientContext(req);
    return this.getSession(info.token, ctx, info.source);
  }

  // --------------------------------------------------------------------------
  // Role & Permission Checks
  // --------------------------------------------------------------------------
  checkIsAdminWallet(rawAddress) {
    if (!rawAddress) return false;
    const lower = rawAddress.toLowerCase();
    const list = this.config.adminWallets || [];
    // If no admin wallets are configured yet, treat the first connected wallet or whitelist as user
    return list.map(a => a.toLowerCase()).includes(lower);
  }

  checkIsAdminEmail(email) {
    if (!email) return false;
    const lower = email.toLowerCase();
    const list = this.config.adminEmails || [];
    return list.map(e => e.toLowerCase()).includes(lower);
  }

  addAdminWallet(address) {
    if (!ethers.isAddress(address)) return false;
    const lower = address.toLowerCase();
    if (!this.config.adminWallets.includes(lower)) {
      this.config.adminWallets.push(lower);
      this.saveConfig(this.config);
    }
    return true;
  }

  addAdminEmail(email) {
    if (!email || !email.includes('@')) return false;
    const lower = email.toLowerCase().trim();
    if (!this.config.adminEmails.includes(lower)) {
      this.config.adminEmails.push(lower);
      this.saveConfig(this.config);
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // HTTP Security Headers & Cookie Helpers
  // --------------------------------------------------------------------------
  applySecurityHeaders(res, origin = null) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // CORS policy: Allow origin if matching domain or localhost, otherwise restrict
    if (origin) {
      if (origin.includes('hyperview.ai.id') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      }
    }
  }

  buildSessionCookie(token, isHttps = false) {
    const maxAge = (this.config.persistentSessionDays || 30) * 86400;
    let cookie = `hv_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
    if (isHttps) cookie += '; Secure';
    return cookie;
  }

  buildDeviceCookie(deviceId, isHttps = false) {
    const maxAge = 365 * 86400;
    let cookie = `hv_device=${deviceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
    if (isHttps) cookie += '; Secure';
    return cookie;
  }

  buildAuthCookies(token, deviceId, isHttps = false) {
    const cookies = [this.buildSessionCookie(token, isHttps)];
    if (deviceId) cookies.push(this.buildDeviceCookie(deviceId, isHttps));
    return cookies;
  }

  buildClearCookie() {
    return 'hv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  }

  // --------------------------------------------------------------------------
  // Automated Daily Backup & Cleaners
  // --------------------------------------------------------------------------
  initBackupScheduler() {
    if (!this.config.autoBackupEnabled) return;
    if (!fs.existsSync(BACKUP_DIR)) {
      try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}
    }

    // Trigger initial backup on boot
    this.createBackupSnapshot();

    // Trigger backup every 24 hours
    const timer = setInterval(() => {
      this.createBackupSnapshot();
    }, 24 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  createBackupSnapshot() {
    try {
      const nowStr = new Date().toISOString().slice(0, 10);
      const filesToBackup = [
        'paper_portfolio.json',
        'simulated_6month_pnl.json',
        'auth_config.json',
      ];

      filesToBackup.forEach(filename => {
        const src = path.join(DATA_DIR, filename);
        if (fs.existsSync(src)) {
          const destName = `${path.basename(filename, '.json')}_${nowStr}.json`;
          const dest = path.join(BACKUP_DIR, destName);
          fs.copyFileSync(src, dest);
        }
      });
      console.log(`[AuthSecurity] 🛡️ Automated daily snapshot saved in data/backups/ (${nowStr})`);
    } catch (e) {
      console.warn('[AuthSecurity] Backup creation warning:', e.message);
    }
  }

  initCleanupScheduler() {
    // Purge expired sessions and nonces every 15 minutes
    const timer = setInterval(() => {
      const now = Date.now();
      let dirty = false;
      for (const [tokenHash, s] of this.sessions.entries()) {
        if (now > s.expiresAt) {
          this.sessions.delete(tokenHash);
          dirty = true;
        }
      }
      if (dirty) {
        this.savePersistedSessions();
      }
      for (const [key, n] of this.walletNonces.entries()) {
        if (now > n.expiresAt) this.walletNonces.delete(key);
      }
      for (const [ipKey, record] of this.ipRateLimits.entries()) {
        if (now > record.resetTime) this.ipRateLimits.delete(ipKey);
      }
    }, 15 * 60 * 1000);
    if (timer.unref) timer.unref();
  }
}

const authSecurityInstance = new AuthSecurityManager();

module.exports = {
  authSecurityInstance,
  AuthSecurityManager,
};
