const WebSocket = require('ws');
const { BotState } = require('../utils/state');
const { checkRugRisk } = require('../security/rugcheck');
const { executeBuy } = require('../trader/executor');
const { sendTelegramAlert } = require('../bot/telegram');
const logger = require('../utils/logger');

const PUMPFUN_WS = 'wss://pumpportal.fun/api/data';
let ws = null;
let reconnectTimeout = null;

function startPumpFunListener() {
  connect();
}

function connect() {
  if (ws) {
    try { ws.terminate(); } catch (_) {}
  }

  ws = new WebSocket(PUMPFUN_WS);

  ws.on('open', () => {
    logger.info('🟢 pump.fun WebSocket connected');
    // Subscribe to new token events
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    // Subscribe to new migrations (pump -> raydium)
    ws.send(JSON.stringify({ method: 'subscribeTokenTrade' }));
  });

  ws.on('message', async (raw) => {
    if (!BotState.sniping || !BotState.sources.pumpfun) return;

    try {
      const data = JSON.parse(raw.toString());
      if (data.txType !== 'create') return; // only new token launches

      const mint = data.mint;
      const name = data.name || 'Unknown';
      const symbol = data.symbol || '???';
      const devWallet = data.traderPublicKey || '';
      const liquidityUsd = (data.solAmount || 0) * 150; // rough estimate

      logger.info(`🆕 [pump.fun] ${name} (${symbol}) — ${mint?.slice(0, 8)}...`);

      if (BotState.isBlacklisted(mint)) {
        logger.warn(`Skipping blacklisted token: ${mint?.slice(0, 8)}...`);
        return;
      }

      // Rug pull check
      const rugResult = await checkRugRisk(mint, {
        liquidityUsd,
        ageSeconds: 0,
      });

      if (!rugResult.safe) {
        logger.rug(`[pump.fun] ${symbol} failed rug check (score: ${rugResult.score})`);
        await sendTelegramAlert(
          `🚫 *Skipped (Rug Risk)*\n` +
          `*${name}* (${symbol})\n` +
          `Mint: \`${mint?.slice(0, 12)}...\`\n` +
          `Score: ${rugResult.score}/100\n` +
          rugResult.reasons.slice(0, 3).map(r => `• ${r}`).join('\n')
        );
        return;
      }

      // Execute snipe
      BotState.stats.sniped++;
      await executeBuy({
        mint,
        name,
        symbol,
        source: 'pump.fun',
        devWallet,
        liquidityUsd,
        rugScore: rugResult.score,
      });

    } catch (err) {
      logger.error('pump.fun message error:', err.message);
    }
  });

  ws.on('error', (err) => {
    logger.error('pump.fun WS error:', err.message);
  });

  ws.on('close', () => {
    logger.warn('pump.fun WS closed — reconnecting in 5s...');
    clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connect, 5000);
  });

  // Keepalive ping every 30s
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);
}

module.exports = { startPumpFunListener };
