require('dotenv').config();
const { startTelegramBot } = require('./bot/telegram');
const { startPumpFunListener } = require('./sniper/pumpfun');
const { startDexScreenerListener } = require('./sniper/dexscreener');
const { startRaydiumListener } = require('./sniper/raydium');
const { startMigrationListener } = require('./sniper/migrations');
const { startCopyTrader } = require('./features/copytrader');
const { startDevTracker } = require('./features/devtracker');
const { startVolumeSpikeDetector } = require('./features/volumespike');
const { startDailyReport, startMorningBriefing, startHealthMonitor, startNewsFeedMonitor } = require('./features/features16');
const { BotState } = require('./utils/state');
const { loadSettings, saveSettings, startAutoSave } = require('./utils/persistence');
const logger = require('./utils/logger');
const http = require('http');

async function main() {
  logger.info('🚀 SolSnipe Bot v3 starting...');

  // Init state with defaults
  BotState.init();
  if (BotState.initExtended) BotState.initExtended();

  // Init all feature flags with defaults first
  BotState.sources = BotState.sources || {};
  BotState.sources.migrated = false;
  BotState.sources.soonMigrated = false;
  BotState.autoSnipeMigrated = false;
  BotState.autoSnipeSoonMigrated = false;
  BotState.bubbleMapSettings = {
    maxClusterPct: 50,
    minDecentScore: 0,
    maxTop1Pct: 30,
    blockRisky: false,
  };

  // Load saved settings — OVERRIDES defaults with your saved values
  const loaded = loadSettings(BotState);
  if (loaded) {
    logger.info('✅ Previous settings restored successfully');
  } else {
    logger.info('📋 Using default settings');
  }

  // Start auto-save every 2 minutes
  startAutoSave(BotState);

  await startTelegramBot();
  logger.info('✅ Telegram bot online');

  startPumpFunListener();
  startDexScreenerListener();
  startRaydiumListener();
  startMigrationListener();
  logger.info('✅ All sniper listeners active');

  startCopyTrader();
  startDevTracker();
  startVolumeSpikeDetector();
  logger.info('✅ Core features active');

  startDailyReport();
  startMorningBriefing();
  startHealthMonitor();
  await startNewsFeedMonitor();
  logger.info('✅ All features active');

  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('  SolSnipe Bot v3 ready 🎯          ');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Keep-alive for Render
  http.createServer((req, res) => res.end('SolSnipe alive')).listen(process.env.PORT || 3000);

  // Heartbeat every 5 min
  setInterval(() => {
    const mem = process.memoryUsage();
    logger.info(`💓 Alive | Positions: ${BotState.positions.size} | Mem: ${Math.round(mem.rss/1024/1024)}MB`);
    saveSettings(BotState); // also save on heartbeat
  }, 5 * 60 * 1000);
}

main();
