require('dotenv').config();
const { startTelegramBot } = require('./bot/telegram');
const { startPumpFunListener } = require('./sniper/pumpfun');
const { startDexScreenerListener } = require('./sniper/dexscreener');
const { startRaydiumListener } = require('./sniper/raydium');
const { startCopyTrader } = require('./features/copytrader');
const { startDevTracker } = require('./features/devtracker');
const { startVolumeSpikeDetector } = require('./features/volumespike');
const { BotState } = require('./utils/state');
const logger = require('./utils/logger');

async function main() {
  logger.info('🚀 Solana Sniper Bot v2 starting...');
  BotState.init();

  await startTelegramBot();
  logger.info('✅ Telegram bot online');

  startPumpFunListener();
  startDexScreenerListener();
  startRaydiumListener();
  logger.info('✅ Core sniper listeners active');

  startCopyTrader();
  startDevTracker();
  startVolumeSpikeDetector();
  logger.info('✅ Feature modules active (CopyTrader | DevTracker | VolumeSpike)');

  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('  Bot ready. Send /start in Telegram       ');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  setInterval(() => {
    const mem = process.memoryUsage();
    logger.info(`💓 Heartbeat | Positions: ${BotState.positions.size} | Mem: ${Math.round(mem.rss/1024/1024)}MB`);
  }, 5 * 60 * 1000);
}

process.on('uncaughtException', err => logger.error('Uncaught:', err.message));
process.on('unhandledRejection', err => logger.error('Unhandled:', err?.message || err));

main();

// Render keep-alive
const http = require('http');
http.createServer((req, res) => res.end('alive')).listen(process.env.PORT || 3000);
