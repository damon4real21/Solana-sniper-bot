const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getConnection } = require('../utils/wallet');
const { BotState } = require('../utils/state');
const { checkRugRisk } = require('../security/rugcheck');
const { executeBuy } = require('../trader/executor');
const { sendTelegramAlert } = require('../bot/telegram');
const logger = require('../utils/logger');

// Raydium AMM v4 program ID
const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const seen = new Set();
let subscriptionId = null;

function startRaydiumListener() {
  const conn = getConnection();
  logger.info('📡 Raydium listener: watching for new pool logs...');
  subscribe(conn);
}

function subscribe(conn) {
  try {
    subscriptionId = conn.onLogs(
      RAYDIUM_AMM_V4,
      async (logInfo, ctx) => {
        if (!BotState.sniping || !BotState.sources.raydium) return;

        const { logs, signature } = logInfo;
        if (logInfo.err) return;

        // "initialize2" appears in Raydium pool init logs
        if (!logs.some(l => l.includes('initialize2') || l.includes('InitializeInstruction2'))) return;

        if (seen.has(signature)) return;
        seen.add(signature);
        if (seen.size > 2000) {
          const first = seen.values().next().value;
          seen.delete(first);
        }

        logger.info(`🆕 [Raydium] New pool detected — tx: ${signature.slice(0, 12)}...`);
        await processRaydiumPool(conn, signature);
      },
      'confirmed'
    );
    logger.info('✅ Raydium log subscription active');
  } catch (err) {
    logger.error('Raydium subscribe error:', err.message);
    setTimeout(() => subscribe(conn), 10000);
  }
}

async function processRaydiumPool(conn, signature) {
  try {
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx) return;

    // Extract token mint from tx accounts
    const accounts = tx.transaction?.message?.accountKeys || [];
    let tokenMint = null;

    // Look for token mint in the accounts list (heuristic: skip SOL and Raydium program)
    const WSOL = 'So11111111111111111111111111111111111111112';
    for (const acc of accounts) {
      const key = acc.pubkey?.toString?.() || acc.toString();
      if (key !== WSOL && key !== RAYDIUM_AMM_V4.toString()) {
        // Further validate it's a token mint via metadata
        try {
          const info = await conn.getParsedAccountInfo(new PublicKey(key));
          if (info.value?.data?.parsed?.type === 'mint') {
            tokenMint = key;
            break;
          }
        } catch (_) {}
      }
    }

    if (!tokenMint) {
      logger.warn('Could not extract mint from Raydium pool tx');
      return;
    }

    if (BotState.isBlacklisted(tokenMint)) return;

    // Fetch metadata from DexScreener
    const fetch = (await import('node-fetch')).default;
    let name = 'Unknown', symbol = '???', liquidityUsd = 0, priceUsd = 0;

    try {
      const dexRes = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
        { timeout: 5000 }
      );
      const dexData = await dexRes.json();
      const pair = (dexData?.pairs || [])[0];
      if (pair) {
        name = pair.baseToken?.name || 'Unknown';
        symbol = pair.baseToken?.symbol || '???';
        liquidityUsd = pair.liquidity?.usd || 0;
        priceUsd = parseFloat(pair.priceUsd || '0');
      }
    } catch (_) {}

    logger.info(`[Raydium] ${name} (${symbol}) — mint: ${tokenMint.slice(0, 8)}... liq=$${liquidityUsd.toFixed(0)}`);

    const rugResult = await checkRugRisk(tokenMint, { liquidityUsd });

    if (!rugResult.safe) {
      logger.rug(`[Raydium] ${symbol} failed rug check (score: ${rugResult.score})`);
      await sendTelegramAlert(
        `🚫 *Skipped (Rug Risk)*\n*${name}* (${symbol})\nSource: Raydium\n` +
        `Score: ${rugResult.score}/100\n` +
        rugResult.reasons.slice(0, 2).map(r => `• ${r}`).join('\n')
      );
      return;
    }

    BotState.stats.sniped++;
    await executeBuy({ mint: tokenMint, name, symbol, source: 'Raydium', liquidityUsd, priceUsd, rugScore: rugResult.score });

  } catch (err) {
    logger.error('processRaydiumPool error:', err.message);
  }
}

module.exports = { startRaydiumListener };
