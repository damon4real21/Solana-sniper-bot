const { Connection, PublicKey } = require('@solana/web3.js');
const { getConnection } = require('../utils/wallet');
const { BotState } = require('../utils/state');
const { checkRugRisk } = require('../security/rugcheck');
const { executeBuy } = require('../trader/executor');
const { sendTelegramAlert } = require('../bot/telegram');
const logger = require('../utils/logger');

// Token Program ID
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// Jupiter Aggregator — skip these (not real token buys)
const SKIP_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
]);

const watchedWallets = new Map(); // address -> { label, subscriptionId }
let subscriptionMap = new Map();

function startCopyTrader() {
  logger.info('👁 Copy trader module loaded');
}

async function addWatchWallet(address, label = '') {
  if (watchedWallets.has(address)) {
    return { success: false, reason: 'Already watching this wallet' };
  }

  const conn = getConnection();
  try {
    const pubkey = new PublicKey(address);
    const subId = conn.onLogs(
      pubkey,
      (logInfo) => handleWalletLogs(address, label, logInfo),
      'confirmed'
    );
    watchedWallets.set(address, { label: label || address.slice(0, 8), subId });
    logger.info(`👁 Watching wallet: ${label || address.slice(0, 8)} (${address})`);
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function removeWatchWallet(address) {
  if (!watchedWallets.has(address)) return { success: false, reason: 'Not watching' };
  const conn = getConnection();
  const { subId } = watchedWallets.get(address);
  try { await conn.removeOnLogsListener(subId); } catch (_) {}
  watchedWallets.delete(address);
  return { success: true };
}

async function handleWalletLogs(walletAddress, label, logInfo) {
  if (!BotState.copyTrading || logInfo.err) return;

  const { logs, signature } = logInfo;

  // Must involve token program (a swap/buy)
  const isTokenActivity = logs.some(l =>
    l.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') ||
    l.includes('Instruction: Transfer') ||
    l.includes('Instruction: MintTo')
  );
  if (!isTokenActivity) return;

  // Skip if it's just a Jupiter route we don't need to copy
  const isJupiter = logs.some(l => l.includes('JUP6'));

  logger.info(`👁 [CopyTrade] Activity from ${label}: ${signature.slice(0, 12)}...`);

  try {
    const conn = getConnection();
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx) return;

    // Find token mints involved in this tx
    const mints = extractMintsBought(tx, walletAddress);
    if (mints.length === 0) return;

    for (const mint of mints) {
      if (BotState.isBlacklisted(mint)) continue;
      if (BotState.positions.has(mint)) continue; // already in

      logger.info(`👁 [CopyTrade] ${label} bought: ${mint.slice(0, 12)}...`);

      // Rug check before copying
      const rug = await checkRugRisk(mint, {});
      if (!rug.safe) {
        await sendTelegramAlert(
          `👁 *Copy Trade Blocked*\n` +
          `Wallet: ${label}\n` +
          `Mint: \`${mint.slice(0, 12)}...\`\n` +
          `Rug score: ${rug.score}/100 — skipped`
        );
        continue;
      }

      await sendTelegramAlert(
        `👁 *Copy Trade Triggered*\n` +
        `Wallet: *${label}*\n` +
        `Mint: \`${mint.slice(0, 12)}...\`\n` +
        `Copying buy now...`
      );

      BotState.stats.sniped++;
      await executeBuy({
        mint,
        name: mint.slice(0, 8),
        symbol: 'COPY',
        source: `CopyTrade:${label}`,
        rugScore: rug.score,
      });
    }
  } catch (err) {
    logger.error('CopyTrade tx parse error:', err.message);
  }
}

function extractMintsBought(tx, walletAddress) {
  const mints = new Set();
  const WSOL = 'So11111111111111111111111111111111111111112';

  try {
    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];
    const accountKeys = tx.transaction?.message?.accountKeys || [];

    // Find wallet's account index
    const walletIdx = accountKeys.findIndex(
      (k) => (k.pubkey?.toString?.() || k.toString()) === walletAddress
    );

    for (const post of postBalances) {
      if (post.owner !== walletAddress) continue;
      const mint = post.mint;
      if (!mint || mint === WSOL) continue;

      const pre = preBalances.find(p => p.accountIndex === post.accountIndex && p.owner === walletAddress);
      const preAmt = pre?.uiTokenAmount?.uiAmount || 0;
      const postAmt = post.uiTokenAmount?.uiAmount || 0;

      // Wallet gained tokens → they bought
      if (postAmt > preAmt) {
        mints.add(mint);
      }
    }
  } catch (_) {}

  return [...mints];
}

function getWatchedWallets() {
  return [...watchedWallets.entries()].map(([address, info]) => ({
    address,
    label: info.label,
  }));
}

module.exports = { startCopyTrader, addWatchWallet, removeWatchWallet, getWatchedWallets };
