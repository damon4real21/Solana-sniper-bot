const { PublicKey } = require('@solana/web3.js');
const { getConnection } = require('../utils/wallet');
const { BotState } = require('../utils/state');
const { sendTelegramAlert } = require('../bot/telegram');
const logger = require('../utils/logger');

// tracked: mint -> { devWallet, symbol, name, initialBalance, subId }
const trackedTokens = new Map();

function startDevTracker() {
  logger.info('🔍 Dev tracker module loaded');
}

async function trackDevWallet(mint, devWallet, symbol = '???', name = 'Unknown') {
  if (trackedTokens.has(mint)) return;

  const conn = getConnection();
  try {
    const devPubkey = new PublicKey(devWallet);

    // Get dev's initial token balance
    let initialBalance = 0;
    try {
      const tokenAccounts = await conn.getParsedTokenAccountsByOwner(devPubkey, {
        mint: new PublicKey(mint),
      });
      initialBalance = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
    } catch (_) {}

    if (initialBalance <= 0) {
      logger.warn(`Dev tracker: no initial balance found for ${symbol}`);
      return;
    }

    const subId = conn.onLogs(
      devPubkey,
      (logInfo) => handleDevLog(mint, devWallet, symbol, name, initialBalance, logInfo),
      'confirmed'
    );

    trackedTokens.set(mint, { devWallet, symbol, name, initialBalance, subId });
    logger.info(`🔍 Tracking dev of ${symbol} — initial balance: ${initialBalance.toLocaleString()}`);
  } catch (err) {
    logger.error('trackDevWallet error:', err.message);
  }
}

async function handleDevLog(mint, devWallet, symbol, name, initialBalance, logInfo) {
  if (logInfo.err) return;

  const { logs } = logInfo;
  const isTransfer = logs.some(l => l.includes('Instruction: Transfer') || l.includes('Instruction: Burn'));
  if (!isTransfer) return;

  const conn = getConnection();
  try {
    const devPubkey = new PublicKey(devWallet);
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(devPubkey, {
      mint: new PublicKey(mint),
    });

    const currentBalance = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
    const soldAmount = initialBalance - currentBalance;
    const soldPct = initialBalance > 0 ? (soldAmount / initialBalance) * 100 : 0;

    if (soldPct < 5) return; // ignore tiny moves

    const urgency = soldPct >= 50 ? '🚨🚨🚨' : soldPct >= 20 ? '⚠️⚠️' : '⚠️';

    logger.warn(`Dev sell detected: ${symbol} — ${soldPct.toFixed(1)}% dumped`);

    const msg =
      `${urgency} *DEV SELL ALERT*\n\n` +
      `Token: *${name}* (${symbol})\n` +
      `Dev sold: *${soldPct.toFixed(1)}%* of holdings\n` +
      `Remaining: ${currentBalance.toLocaleString()} tokens\n` +
      `Mint: \`${mint}\`\n\n` +
      (soldPct >= 30 ? `🔴 *Consider selling your position!*` : `🟡 Monitor closely`);

    await sendTelegramAlert(msg);

    // Auto-sell our position if dev dumps >50%
    if (soldPct >= 50 && BotState.positions.has(mint)) {
      logger.warn(`Auto-selling due to dev dump: ${symbol}`);
      await sendTelegramAlert(`🚨 Auto-selling *${symbol}* due to dev dump (${soldPct.toFixed(1)}%)`);
      const { executeSell } = require('../trader/executor');
      await executeSell(mint, `Dev Dump ${soldPct.toFixed(1)}%`);
    }
  } catch (err) {
    logger.error('handleDevLog error:', err.message);
  }
}

async function untrackDev(mint) {
  if (!trackedTokens.has(mint)) return false;
  const conn = getConnection();
  const { subId } = trackedTokens.get(mint);
  try { await conn.removeOnLogsListener(subId); } catch (_) {}
  trackedTokens.delete(mint);
  return true;
}

function getTrackedDevs() {
  return [...trackedTokens.entries()].map(([mint, info]) => ({
    mint,
    symbol: info.symbol,
    devWallet: info.devWallet,
    initialBalance: info.initialBalance,
  }));
}

module.exports = { startDevTracker, trackDevWallet, untrackDev, getTrackedDevs };
