const { PublicKey } = require('@solana/web3.js');
const { getConnection } = require('../utils/wallet');
const { BotState } = require('../utils/state');
const { executeBuy } = require('../trader/executor');
const { sendTelegramAlert } = require('../bot/telegram');
const { checkRugRisk } = require('../security/rugcheck');
const logger = require('../utils/logger');

// ── Known DEX Program IDs ─────────────────────────────────────────────────────
const DEX_PROGRAMS = {
  // Jupiter aggregator (routes through DexScreener-listed pairs too)
  JUPITER_V6:       'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  JUPITER_V4:       'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',

  // Raydium
  RAYDIUM_AMM_V4:   '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM:     'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  RAYDIUM_CPMM:     'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',

  // pump.fun AMM (tokens that graduated to Raydium via pump)
  PUMPFUN_AMM:      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  // Orca / Whirlpool
  ORCA_WHIRLPOOL:   'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  ORCA_V2:          '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',

  // Meteora DLMM / Dynamic AMM
  METEORA_DLMM:     'LBUZKhRxPF3XUpBCjp4YzTKgLLjgovergan179x23GS',
  METEORA_AMM:      'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EqoIHp7h',

  // Lifinity
  LIFINITY_V2:      '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
};

const DEX_PROGRAM_SET = new Set(Object.values(DEX_PROGRAMS));
const WSOL = 'So11111111111111111111111111111111111111112';

// Source detection from program IDs found in tx
const DEX_LABELS = {
  [DEX_PROGRAMS.JUPITER_V6]:     'Jupiter',
  [DEX_PROGRAMS.JUPITER_V4]:     'Jupiter',
  [DEX_PROGRAMS.RAYDIUM_AMM_V4]: 'Raydium',
  [DEX_PROGRAMS.RAYDIUM_CLMM]:   'Raydium CLMM',
  [DEX_PROGRAMS.RAYDIUM_CPMM]:   'Raydium CPMM',
  [DEX_PROGRAMS.PUMPFUN_AMM]:    'pump.fun',
  [DEX_PROGRAMS.ORCA_WHIRLPOOL]: 'Orca',
  [DEX_PROGRAMS.ORCA_V2]:        'Orca v2',
  [DEX_PROGRAMS.METEORA_DLMM]:   'Meteora DLMM',
  [DEX_PROGRAMS.METEORA_AMM]:    'Meteora AMM',
  [DEX_PROGRAMS.LIFINITY_V2]:    'Lifinity',
};

// Log-level swap detection patterns (fast path before fetching full tx)
const SWAP_LOG_PATTERNS = [
  'Instruction: Route',
  'Instruction: SharedAccountsRoute',
  'Instruction: ExactOutRoute',
  'Instruction: Swap',
  'Instruction: SwapV2',
  'Instruction: ProxySwap',
  'Instruction: SwapBaseIn',
  'Instruction: SwapBaseOut',
  'Instruction: TwoHopSwap',
  'Instruction: Swap2',
  'Program log: Instruction: swap',
  'ray_log',   // Raydium emits this in every swap
];

// ── State ─────────────────────────────────────────────────────────────────────
const watchedWallets = new Map(); // address -> { label, subscriptionId, trades, stats }

// ── Public API ────────────────────────────────────────────────────────────────
function startCopyTrader() {
  logger.info('👥 Copy trader ready — detects Jupiter, Raydium, DexScreener routes, Orca, Meteora, pump.fun');
  for (const [addr, data] of watchedWallets.entries()) {
    subscribeWallet(addr, data.label);
  }
}

function addWatchWallet(address, label = 'Wallet') {
  if (watchedWallets.has(address)) return false;
  watchedWallets.set(address, { label, subscriptionId: null, trades: [], stats: { copied: 0, skipped: 0 } });
  subscribeWallet(address, label);
  return true;
}

function removeWatchWallet(address) {
  const conn = getConnection();
  const data = watchedWallets.get(address);
  if (!data) return false;
  if (data.subscriptionId !== null) {
    try { conn.removeAccountChangeListener(data.subscriptionId); } catch (_) {}
  }
  watchedWallets.delete(address);
  return true;
}

function getWatchedWallets() {
  return [...watchedWallets.entries()].map(([addr, d]) => ({
    address: addr,
    label: d.label,
    trades: d.trades.length,
    copied: d.stats.copied,
    skipped: d.stats.skipped,
  }));
}

// ── Core subscription ─────────────────────────────────────────────────────────
function subscribeWallet(address, label) {
  const conn = getConnection();
  try {
    const subId = conn.onLogs(
      new PublicKey(address),
      async (logInfo) => {
        if (logInfo.err) return;
        if (!BotState.sniping || !BotState.copyTrading?.enabled) return;

        const { logs, signature } = logInfo;

        // Fast pre-filter: does any log line look like a swap?
        const looksLikeSwap =
          SWAP_LOG_PATTERNS.some(p => logs.some(l => l.includes(p))) ||
          [...DEX_PROGRAM_SET].some(pid => logs.some(l => l.includes(pid)));

        if (!looksLikeSwap) return;

        // Fetch and parse the full transaction
        await processCopyTx(conn, signature, address, label);
      },
      'confirmed'
    );

    const data = watchedWallets.get(address);
    if (data) data.subscriptionId = subId;
    logger.info(`✅ [CopyTrade] Watching ${label} (${address.slice(0, 12)}...) — all DEXes`);
  } catch (err) {
    logger.error('[CopyTrade] subscribe error:', err.message);
    // Retry in 10s
    setTimeout(() => subscribeWallet(address, label), 10000);
  }
}

// ── Transaction Analysis ──────────────────────────────────────────────────────
async function processCopyTx(conn, signature, walletAddress, label) {
  try {
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx || tx.meta?.err) return;

    // Identify which DEX was used
    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const programIds = accountKeys.map(k =>
      typeof k === 'string' ? k : (k.pubkey?.toString?.() || '')
    );

    const detectedDex = programIds.find(pid => DEX_PROGRAM_SET.has(pid));
    const dexLabel = detectedDex ? (DEX_LABELS[detectedDex] || 'Unknown DEX') : null;

    if (!detectedDex) {
      // Not a recognized DEX — could be a transfer or something else
      return;
    }

    // Find the token they BOUGHT (balance increased for target wallet)
    const preBalances  = tx.meta?.preTokenBalances  || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    let boughtMint = null;
    let soldMint = null;
    let boughtAmount = 0;

    for (const post of postBalances) {
      const owner = post.owner || post.accountIndex;
      // Match by owner address or try to identify via account index
      const isTargetWallet = post.owner === walletAddress;
      if (!isTargetWallet) continue;
      if (post.mint === WSOL) continue; // skip wrapped SOL

      const pre = preBalances.find(p => p.mint === post.mint && p.owner === walletAddress);
      const postAmt = parseFloat(post.uiTokenAmount?.uiAmount || '0');
      const preAmt  = parseFloat(pre?.uiTokenAmount?.uiAmount  || '0');

      if (postAmt > preAmt) {
        boughtMint = post.mint;
        boughtAmount = postAmt - preAmt;
      }
    }

    // Find what they sold (SOL decrease or token decrease)
    // Check if they sold SOL (native balance decreased significantly)
    const preNative  = tx.meta?.preBalances  || [];
    const postNative = tx.meta?.postBalances || [];

    // Find the account index of target wallet
    const walletIdx = accountKeys.findIndex(k => {
      const key = typeof k === 'string' ? k : (k.pubkey?.toString?.() || '');
      return key === walletAddress;
    });

    let spentSol = 0;
    if (walletIdx >= 0) {
      const pre  = preNative[walletIdx]  || 0;
      const post = postNative[walletIdx] || 0;
      if (pre > post) spentSol = (pre - post) / 1e9;
    }

    // Also detect token→token swaps (sold another token)
    for (const pre of preBalances) {
      if (pre.owner !== walletAddress) continue;
      if (pre.mint === WSOL || pre.mint === boughtMint) continue;
      const post = postBalances.find(p => p.mint === pre.mint && p.owner === walletAddress);
      const preAmt  = parseFloat(pre.uiTokenAmount?.uiAmount  || '0');
      const postAmt = parseFloat(post?.uiTokenAmount?.uiAmount || '0');
      if (preAmt > postAmt) {
        soldMint = pre.mint;
        break;
      }
    }

    if (!boughtMint) return; // no clear buy detected

    // Determine the context
    const swapContext = soldMint
      ? `Token→Token swap via ${dexLabel}`
      : spentSol > 0
        ? `SOL→Token via ${dexLabel} (${spentSol.toFixed(4)} SOL)`
        : `Swap via ${dexLabel}`;

    logger.info(`👥 [CopyTrade] ${label} | ${swapContext} | bought ${boughtMint.slice(0, 8)}...`);

    // Guard checks
    if (BotState.isBlacklisted(boughtMint)) {
      logger.warn(`[CopyTrade] Skipping blacklisted: ${boughtMint.slice(0, 8)}...`);
      return;
    }
    if (BotState.positions.has(boughtMint)) {
      logger.info(`[CopyTrade] Already holding ${boughtMint.slice(0, 8)}... — skipping`);
      return;
    }

    // Rug check
    const rugResult = await checkRugRisk(boughtMint, {});
    const walletData = watchedWallets.get(walletAddress);

    if (!rugResult.safe) {
      logger.rug(`[CopyTrade] ${label}'s pick failed rug check (score: ${rugResult.score})`);
      if (walletData) walletData.stats.skipped++;
      await sendTelegramAlert(
        `👥 *Copy Trade Skipped*\n` +
        `Wallet: *${label}*\n` +
        `DEX: ${dexLabel}\n` +
        `Mint: \`${boughtMint.slice(0, 16)}...\`\n` +
        `🚨 Rug score: ${rugResult.score}/100\n` +
        rugResult.reasons.slice(0, 2).map(r => `• ${r}`).join('\n')
      );
      return;
    }

    // Fetch token name/symbol from DexScreener
    let name = 'Unknown', symbol = '???', liquidityUsd = 0;
    try {
      const fetch = (await import('node-fetch')).default;
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${boughtMint}`, { timeout: 5000 });
      const dexData = await res.json();
      const pair = (dexData?.pairs || [])[0];
      if (pair) {
        name = pair.baseToken?.name || 'Unknown';
        symbol = pair.baseToken?.symbol || '???';
        liquidityUsd = pair.liquidity?.usd || 0;
      }
    } catch (_) {}

    // Record trade
    if (walletData) {
      walletData.stats.copied++;
      walletData.trades.unshift({ mint: boughtMint, symbol, dex: dexLabel, ts: Date.now() });
      if (walletData.trades.length > 50) walletData.trades.pop();
    }

    await sendTelegramAlert(
      `👥 *Copying Trade!*\n` +
      `Wallet: *${label}*\n` +
      `\`${walletAddress.slice(0, 16)}...\`\n\n` +
      `*${name}* (${symbol})\n` +
      `DEX: ${dexLabel}\n` +
      `${spentSol > 0 ? `They spent: ${spentSol.toFixed(4)} SOL\n` : ''}` +
      `Liquidity: $${liquidityUsd.toFixed(0)}\n` +
      `Rug Score: ${rugResult.score}/100\n\n` +
      `⚡ Buying with ${BotState.sniper.buyAmountSol} SOL...`
    );

    BotState.stats.sniped++;
    await executeBuy({
      mint: boughtMint,
      name,
      symbol,
      source: `Copy:${label}(${dexLabel})`,
      liquidityUsd,
      rugScore: rugResult.score,
    });

  } catch (err) {
    logger.error(`[CopyTrade] processCopyTx error:`, err.message);
  }
}

module.exports = { startCopyTrader, addWatchWallet, removeWatchWallet, getWatchedWallets };
