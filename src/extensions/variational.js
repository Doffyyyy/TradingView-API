/**
 * Variational Protocol (Omni DEX) Connector & RFQ Farming Extension
 * Supports Zero-Fee Perpetual Trading, RFQ Execution, and Points Farming Automation.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');

const VARIO_AGENTS_DIR = path.join(__dirname, '../../data/user_vario_agents');
if (!fs.existsSync(VARIO_AGENTS_DIR)) {
  fs.mkdirSync(VARIO_AGENTS_DIR, { recursive: true });
}

const STATS_API_URL = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/v2/stats';
const ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';

function sanitizeUserId(userId) {
  if (!userId) return 'anonymous';
  return String(userId).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

class VariationalConnector {
  constructor() {
    this.statsCache = null;
    this.lastStatsFetchTime = 0;
    this.statsCacheTtlMs = 3000; // 3 seconds TTL cache to stay safely under 10 req/10s rate limit
    this.isFetchingStats = false;
  }

  /**
   * Fetches exchange-wide stats & listings with in-memory caching
   */
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
          'Accept': 'application/json'
        }
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

  /**
   * Normalize symbol to Variational Omni Ticker (e.g. BINANCE:BTCUSDT -> BTC-PERP)
   */
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

  /**
   * Get single listing details (Mark price, quotes, base spread bps)
   */
  async getMarketInfo(ticker) {
    const stats = await this.getExchangeStats();
    if (!stats || !stats.listings) return null;
    const normalized = this.normalizeTicker(ticker);
    return stats.listings.find(l => l.ticker === normalized) || null;
  }

  /**
   * Read User's Variational Config
   */
  getUserConfig(userId) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(VARIO_AGENTS_DIR, `${safeId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        const hasKey = Boolean(data.privateKey && data.privateKey.length > 10);
        const maskedKey = hasKey
          ? `${data.privateKey.slice(0, 6)}••••••••••••••••••••••••••••••••${data.privateKey.slice(-4)}`
          : '';

        return {
          configured: Boolean(data.walletAddress),
          hasPrivateKey: hasKey,
          walletAddress: data.walletAddress || '',
          maskedPrivateKey: maskedKey,
          autoFarmEnabled: Boolean(data.autoFarmEnabled),
          maxSlippage: data.maxSlippage || 0.005,
          defaultLeverage: data.defaultLeverage || 2,
          totalFarmedVolume: data.totalFarmedVolume || 0,
          estimatedPoints: data.estimatedPoints || 0,
          farmedTradesCount: data.farmedTradesCount || 0,
          updatedAt: data.updatedAt || null,
        };
      } catch (e) {
        console.warn(`[Variational] Error reading config for ${userId}:`, e.message);
      }
    }

    return {
      configured: false,
      hasPrivateKey: false,
      walletAddress: '',
      maskedPrivateKey: '',
      autoFarmEnabled: false,
      maxSlippage: 0.005,
      defaultLeverage: 2,
      totalFarmedVolume: 0,
      estimatedPoints: 0,
      farmedTradesCount: 0,
      updatedAt: null,
    };
  }

  /**
   * Save User's Variational Config
   */
  saveUserConfig(userId, { walletAddress = '', privateKey = '', autoFarmEnabled = false, maxSlippage = 0.005, defaultLeverage = 2 }) {
    let cleanAddress = (walletAddress || '').trim();
    let cleanKey = (privateKey || '').trim();

    if (cleanKey) {
      if (!cleanKey.startsWith('0x')) cleanKey = '0x' + cleanKey;
      try {
        const wallet = new ethers.Wallet(cleanKey);
        if (!cleanAddress) {
          cleanAddress = wallet.address;
        } else if (cleanAddress.toLowerCase() !== wallet.address.toLowerCase()) {
          throw new Error(`Địa chỉ ví (${cleanAddress.slice(0, 8)}...) không khớp với Private Key (${wallet.address.slice(0, 8)}...)`);
        }
      } catch (err) {
        throw new Error(`Private Key không hợp lệ: ${err.message}`);
      }
    }

    if (cleanAddress) {
      try {
        cleanAddress = ethers.getAddress(cleanAddress.toLowerCase());
      } catch (err) {
        throw new Error('Địa chỉ ví EVM (Arbitrum) không hợp lệ (Phải là địa chỉ hex 0x40 ký tự)');
      }
    }

    if (!cleanAddress && !cleanKey) {
      throw new Error('Vui lòng nhập địa chỉ ví Arbitrum hoặc Private Key');
    }

    const safeId = sanitizeUserId(userId);
    const filePath = path.join(VARIO_AGENTS_DIR, `${safeId}.json`);

    // Merge with existing volume stats if present
    let existing = {};
    if (fs.existsSync(filePath)) {
      try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) {}
    }

    const record = {
      userId,
      walletAddress: cleanAddress,
      privateKey: cleanKey || existing.privateKey || '',
      autoFarmEnabled: Boolean(autoFarmEnabled),
      maxSlippage: parseFloat(maxSlippage) || 0.005,
      defaultLeverage: parseInt(defaultLeverage, 10) || 2,
      totalFarmedVolume: existing.totalFarmedVolume || 0,
      estimatedPoints: existing.estimatedPoints || 0,
      farmedTradesCount: existing.farmedTradesCount || 0,
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');

    const hasKey = Boolean(record.privateKey && record.privateKey.length > 10);
    return {
      success: true,
      configured: true,
      hasPrivateKey: hasKey,
      walletAddress: record.walletAddress,
      maskedPrivateKey: hasKey ? `${record.privateKey.slice(0, 6)}••••••••••••••••••••••••••••••••${record.privateKey.slice(-4)}` : '',
      autoFarmEnabled: record.autoFarmEnabled,
      maxSlippage: record.maxSlippage,
      defaultLeverage: record.defaultLeverage,
      totalFarmedVolume: record.totalFarmedVolume,
      estimatedPoints: record.estimatedPoints,
      farmedTradesCount: record.farmedTradesCount,
      message: 'Đã lưu cấu hình Variational Omni thành công!'
    };
  }

  /**
   * Delete User's Variational Config
   */
  deleteUserConfig(userId) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(VARIO_AGENTS_DIR, `${safeId}.json`);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
    return { success: true, message: 'Đã xóa cấu hình Variational Omni' };
  }

  /**
   * Verify Connection to Arbitrum & Variational
   */
  async verifyConnection(userId) {
    const cfg = this.getUserConfig(userId);
    if (!cfg.configured && !cfg.walletAddress) {
      throw new Error('Chưa cấu hình địa chỉ ví Variational');
    }

    const address = cfg.walletAddress;

    // 1. Check Arbitrum RPC connection and balance
    let ethBalance = '0.00';
    try {
      const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC_URL);
      const bal = await provider.getBalance(address);
      ethBalance = ethers.formatEther(bal);
    } catch (e) {
      console.warn('[Variational] RPC check warning:', e.message);
    }

    // 2. Fetch latest market data for BTC-PERP and ETH-PERP
    const stats = await this.getExchangeStats();
    const btcMarket = stats?.listings?.find(l => l.ticker === 'BTC-PERP');
    const ethMarket = stats?.listings?.find(l => l.ticker === 'ETH-PERP');

    return {
      verified: true,
      address,
      ethBalance: parseFloat(ethBalance).toFixed(4),
      hasPrivateKey: cfg.hasPrivateKey,
      marketsActive: stats?.num_markets || 0,
      protocolVolume24h: stats?.total_volume_24h || '0',
      protocolTvl: stats?.tvl || '0',
      btcMarkPrice: btcMarket ? parseFloat(btcMarket.mark_price).toFixed(2) : 'N/A',
      btcSpreadBps: btcMarket ? parseFloat(btcMarket.base_spread_bps).toFixed(2) : '1.00',
      ethMarkPrice: ethMarket ? parseFloat(ethMarket.mark_price).toFixed(2) : 'N/A',
      ethSpreadBps: ethMarket ? parseFloat(ethMarket.base_spread_bps).toFixed(2) : '1.20',
      message: 'Kết nối Variational Protocol (Omni Arbitrum) hoạt động bình thường! Sẵn sàng giao dịch & cày Points airdrop.'
    };
  }

  /**
   * Record trade execution for volume & points tracking
   */
  recordTrade(userId, { symbol, side, notional, price }) {
    const safeId = sanitizeUserId(userId);
    const filePath = path.join(VARIO_AGENTS_DIR, `${safeId}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const tradeNotional = Math.abs(parseFloat(notional) || 0);

      data.totalFarmedVolume = Math.round(((data.totalFarmedVolume || 0) + tradeNotional) * 100) / 100;
      data.farmedTradesCount = (data.farmedTradesCount || 0) + 1;

      // Approximate points: 1 point per $100 volume (with tier boosts)
      const basePoints = tradeNotional / 100;
      data.estimatedPoints = Math.round(((data.estimatedPoints || 0) + basePoints) * 10) / 10;
      data.updatedAt = new Date().toISOString();

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      return data;
    } catch (e) {
      console.warn('[Variational] Failed to record trade stats:', e.message);
      return null;
    }
  }
}

const variationalConnector = new VariationalConnector();

module.exports = {
  variationalConnector,
  VariationalConnector
};
