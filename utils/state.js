const config = require('../config');

class BotStateManager {
  constructor() {
    this.sniping = false;
    this.sources = { ...config.sources };
    this.sniper = { ...config.sniper };
    this.rugFilter = { ...config.rugFilter };
    this.autoSell = { ...config.autoSell };
    this.mev = { ...config.mev };

    // Positions & history
    this.positions = new Map();
    this.tradeHistory = [];
    this.stats = { wins: 0, losses: 0, totalPnlSol: 0, sniped: 0 };

    // Security
    this.blacklist = new Set();
    this.devBlacklist = new Set();

    // Copy Trading
    this.copyTrading = {
      enabled: false,
      wallets: new Set(),
    };

    // Dev Tracker
    this.devTrackers = new Map();
    this.devTracker = {
      enabled: true,
      alertThresholdPct: 10,
      autoSellOnDump: true,
    };

    // Volume Spike
    this.volumeSpike = {
      enabled: false,
      minVolume1h: 50000,
      minPriceChange5m: 10,
    };

    // Multi-Wallet Spread
    this.multiWallet = {
      enabled: false,
      wallets: [],
      perWalletSol: 0.05,
    };
  }

  init() {}

  addPosition(mint, data) {
    this.positions.set(mint, { ...data, buyTime: Date.now() });
  }

  removePosition(mint) {
    this.positions.delete(mint);
  }

  addTrade(trade) {
    this.tradeHistory.unshift(trade);
    if (this.tradeHistory.length > 200) this.tradeHistory.pop();
    if (trade.pnlSol > 0) { this.stats.wins++; this.stats.totalPnlSol += trade.pnlSol; }
    else { this.stats.losses++; this.stats.totalPnlSol += trade.pnlSol; }
  }

  isBlacklisted(mint) { return this.blacklist.has(mint); }
  addBlacklist(mint) { this.blacklist.add(mint); }
  removeBlacklist(mint) { this.blacklist.delete(mint); }

  blacklistDevWallet(wallet) { this.devBlacklist.add(wallet); }
  isDevBlacklisted(wallet) { return this.devBlacklist.has(wallet); }

  getSummary() {
    const total = this.stats.wins + this.stats.losses;
    const wr = total > 0 ? ((this.stats.wins / total) * 100).toFixed(1) : '0.0';
    return {
      sniping: this.sniping,
      sources: this.sources,
      positions: this.positions.size,
      sniped: this.stats.sniped,
      wins: this.stats.wins,
      losses: this.stats.losses,
      winRate: wr,
      totalPnlSol: this.stats.totalPnlSol.toFixed(4),
      copyWallets: this.copyTrading.wallets.size,
      subWallets: this.multiWallet.wallets.length,
      volumeSpikeOn: this.volumeSpike.enabled,
      copyTradingOn: this.copyTrading.enabled,
    };
  }
}

const BotState = new BotStateManager();
module.exports = { BotState };
