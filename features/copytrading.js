const { Connection, PublicKey } = require('@solana/web3.js');
const { getConnection } = require('../utils/wallet');
const { BotState } = require('../utils/state');
const { executeBuy } = require('../trader/executor');
const { sendTelegramAlert } = require('../bot/telegram');
const { checkRugRisk } = require('../security/rugcheck');
const logger = require('../utils/logger');

const WSOL = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';

// In-memory wallet watchlist (persists in BotState.copyWallets)
const subscriptions = new Map(); // wallet -> subscriptionId

function startCopyTrading() {
  logger.info('📡 Copy trading module loaded (no wallets yet — add via /copywatch)');
}

async function watchWallet(walletAddress) {
  const conn = getConnection();

  if (subscriptions.has(walletAddress)) {
    return { success: false, reason: 'Already watching this wallet' };
  }

  try {
    new PublicKey(walletAddress); // validate
  } catch {
    return { success: false, reason: 'Invalid wallet address' };
  }

  const subId = conn.onLogs(
    new PublicKey(walletAddress),
    async (logInfo) => {
      if (!BotState.sniping || !BotState.copyTrading.enabled) return;
      if (logInfo.err) return;

      const { signature, logs } = logInfo;

      // Check if this is a Jupiter/swap tx
      const isSwap = logs.some(l =>
        l.includes('Program JUP') ||
        l.includes('Program 675kPX9') || // Raydium
        l.includes('Program 6EF8rrecthR5') // pump.fun
      );

      if (!isSwap) return;

      logger.info(`👁 Copy target active: ${walletAddress.slice(0, 8)}... tx: ${signature.slice(0, 8)}...`);

      await processCopyTrade(conn, walletAddress, signature);
    },
    'confirmed'
  );

  subscriptions.set(walletAddress, subId);
  BotState.copyTrading.wallets.add(walletAddress);
  logger.info(`✅ Now watching wallet: ${walletAddress.slice(0, 8)}...`);
  return { success: true };
}

async function unwatchWallet(walletAddress) {
  const conn = getConnection();
  const subId = subscriptions.get(walletAddress);
  if (!subId) return { success: false, reason: 'Not watching this wallet' };

  try {
    await conn.removeAccountChangeListener(subId);
  } catch (_) {}

  subscriptions.delete(walletAddress);
  BotState.copyTrading.wallets.delete(walletAddress);
  return { success: true };
}

async function processCopyTrade(conn, walletAddress, signature) {
  try {
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx) return;

    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    // Find tokens where wallet's balance increased (buy signal)
    const bought = [];
    for (const post of postBalances) {
      if (post.owner !== walletAddress) continue;
      const pre = preBalances.find(b => b.accountIndex === post.accountIndex);
      const preAmt = pre?.uiTokenAmount?.uiAmount || 0;
      const postAmt = post.uiTokenAmount?.uiAmount || 0;

      if (postAmt > preAmt && post.mint !== WSOL) {
        bought.push({ mint: post.mint, delta: postAmt - preAmt });
      }
    }

    if (bought.length === 0) return;

    for (const { mint } of bought) {
      if (BotState.isBlacklisted(mint)) continue;
      if (BotState.positions.has(mint)) continue; // already holding

      logger.info(`🔁 Copy trade signal: wallet ${walletAddress.slice(0, 8)}... bought ${mint.slice(0, 8)}...`);

      // Quick rug check
      const rugResult = await checkRugRisk(mint, {});
      if (!rugResult.safe) {
        await sendTelegramAlert(
          `👁 *Copy Signal Blocked (Rug)*\n` +
          `Wallet: \`${walletAddress.slice(0, 12)}...\`\n` +
          `Token: \`${mint.slice(0, 12)}...\`\n` +
          `Score: ${rugResult.score}/100`
        );
        return;
      }

      await sendTelegramAlert(
        `🔁 *Copy Trade Detected!*\n` +
        `Wallet: \`${walletAddress.slice(0, 12)}...\`\n` +
        `Token: \`${mint}\`\n` +
        `Copying buy...`
      );

      BotState.stats.sniped++;
      await executeBuy({
        mint,
        name: 'CopyTrade',
        symbol: mint.slice(0, 6),
        source: `Copy:${walletAddress.slice(0, 8)}`,
        rugScore: rugResult.score,
      });
    }
  } catch (err) {
    logger.error('processCopyTrade error:', err.message);
  }
}

function getWatchedWallets() {
  return [...BotState.copyTrading.wallets];
}

module.exports = { startCopyTrading, watchWallet, unwatchWallet, getWatchedWallets };
