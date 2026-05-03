const { PublicKey } = require('@solana/web3.js');
const { getConnection } = require('../utils/wallet');
const { BotState } = require('../utils/state');
const { executeSell } = require('../trader/executor');
const { sendTelegramAlert } = require('../bot/telegram');
const logger = require('../utils/logger');

const devSubscriptions = new Map(); // mint -> { subId, devWallet, initialSupply }

/**
 * Start watching a dev wallet for a specific token.
 * Called automatically after every successful snipe.
 */
async function trackDevWallet(mint, devWallet, totalSupply) {
  if (!devWallet || devSubscriptions.has(mint)) return;
  const conn = getConnection();

  try {
    new PublicKey(devWallet);
  } catch { return; }

  logger.info(`👁 Tracking dev wallet ${devWallet.slice(0, 8)}... for ${mint.slice(0, 8)}...`);

  const subId = conn.onLogs(
    new PublicKey(devWallet),
    async (logInfo) => {
      if (logInfo.err) return;
      await checkDevActivity(conn, mint, devWallet, logInfo.signature, totalSupply);
    },
    'confirmed'
  );

  devSubscriptions.set(mint, { subId, devWallet, totalSupply });
  BotState.devTrackers.set(mint, devWallet);
}

async function checkDevActivity(conn, mint, devWallet, signature, totalSupply) {
  try {
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx) return;

    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    // Check if dev's token balance for this mint decreased
    const preDevBal = preBalances.find(b => b.owner === devWallet && b.mint === mint);
    const postDevBal = postBalances.find(b => b.owner === devWallet && b.mint === mint);

    const preAmt = preDevBal?.uiTokenAmount?.uiAmount || 0;
    const postAmt = postDevBal?.uiTokenAmount?.uiAmount || 0;

    if (preAmt <= 0 || postAmt >= preAmt) return; // no sell

    const soldAmt = preAmt - postAmt;
    const soldPct = totalSupply > 0 ? (soldAmt / totalSupply) * 100 : 0;

    logger.warn(`🚨 Dev sell detected! ${mint.slice(0, 8)}... sold ${soldPct.toFixed(2)}% of supply`);

    // Alert thresholds
    const threshold = BotState.devTracker.alertThresholdPct;

    if (soldPct >= threshold) {
      const pos = BotState.positions.get(mint);
      const name = pos?.symbol || mint.slice(0, 8);

      await sendTelegramAlert(
        `🚨 *DEV SELLING ALERT*\n\n` +
        `Token: *${name}*\n` +
        `Dev wallet: \`${devWallet.slice(0, 16)}...\`\n` +
        `Sold: ${soldPct.toFixed(2)}% of total supply\n` +
        `TX: [View](https://solscan.io/tx/${signature})\n\n` +
        `${BotState.devTracker.autoSellOnDump ? '⚡ Auto-selling your position...' : '⚠️ Consider selling!'}`
      );

      // Auto-sell if enabled
      if (BotState.devTracker.autoSellOnDump && BotState.positions.has(mint)) {
        logger.warn(`Auto-selling ${name} due to dev dump`);
        await executeSell(mint, `Dev Dump ${soldPct.toFixed(1)}%`);
        stopTrackingDev(mint);
      }

      // Blacklist the dev wallet
      BotState.blacklistDevWallet(devWallet);
      logger.warn(`Dev ${devWallet.slice(0, 8)}... auto-blacklisted after dump`);
    }
  } catch (err) {
    logger.error('checkDevActivity error:', err.message);
  }
}

function stopTrackingDev(mint) {
  const conn = getConnection();
  const entry = devSubscriptions.get(mint);
  if (!entry) return;
  try { conn.removeAccountChangeListener(entry.subId); } catch (_) {}
  devSubscriptions.delete(mint);
  BotState.devTrackers.delete(mint);
}

function getTrackedDevs() {
  const result = [];
  for (const [mint, devWallet] of BotState.devTrackers.entries()) {
    result.push({ mint, devWallet });
  }
  return result;
}

function startDevTracker() { }
module.exports = { startDevTracker, trackDevWallet, stopTrackingDev, getTrackedDevs };
