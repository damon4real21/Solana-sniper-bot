require('dotenv').config();
const { startTelegramBot } = require('./bot/telegram');
const { startPumpFunListener } = require('./sniper/pumpfun');
const { startDexScreenerListener } = require('./sniper/dexscreener');
const { startRaydiumListener } = require('./sniper/raydium');
const { startCopyTrader } = require('./features/copytrader');
const { startDevTracker } = require('./features/devtracker');
const { startVolumeSpikeDetector } = require('./features/volumespike');
const {
  startDailyReport,
  startMorningBriefing,
  startHealthMonitor,
  startNewsFeedMonitor,
} = require('./features/features16');
const { BotState } = require('./utils/state');
const logger = require('./utils/logger');
const http = require('http');

async function main() {
  logger.info('🚀 SolSnipe Bot v3 starting...');

  BotState.init();
  if (BotState.initExtended) BotState.initExtended();

  await startTelegramBot();
  logger.info('✅ Telegram bot online');

  startPumpFunListener();
  startDexScreenerListener();
  startRaydiumListener();
  logger.info('✅ Core sniper listeners active');

  startCopyTrader();
  startDevTracker();
  startVolumeSpikeDetector();
  logger.info('✅ Core features active');

  // New features
  startDailyReport();
  startMorningBriefing();
  startHealthMonitor();
  await startNewsFeedMonitor();
  logger.info('✅ 16 new features active');

  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('  SolSnipe Bot v3 ready 🎯          ');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Render keep-alive
  http.createServer((req, res) => res.end('SolSnipe alive')).listen(process.env.PORT || 3000);

  setInterval(() => {
    const mem = process.memoryUsage();
    logger.info(`💓 Alive | Positions: ${BotState.positions.size} | Mem: ${Math.round(mem.rss/1024/1024)}MB`);
  }, 5 * 60 * 1000);
}

main();
