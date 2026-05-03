const { BotState } = require('../utils/state');
const { checkRugRisk } = require('../security/rugcheck');
const { executeBuy } = require('../trader/executor');
const { sendTelegramAlert } = require('../bot/telegram');
const logger = require('../utils/logger');

const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/pairs/solana';
const POLL_INTERVAL_MS = 12000; // 12s — DexScreener free tier rate limit
const seen = new Set();

function startDexScreenerListener() {
  logger.info('📡 DexScreener listener polling every 12s...');
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

async function poll() {
  if (!BotState.sniping || !BotState.sources.dexscreener) return;

  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(
      'https://api.dexscreener.com/token-profiles/latest/v1',
      { headers: { 'User-Agent': 'SniperBot/1.0' }, timeout: 8000 }
    );

    if (!res.ok) return;
    const profiles = await res.json();

    for (const profile of (profiles || []).slice(0, 20)) {
      if (profile.chainId !== 'solana') continue;
      const mint = profile.tokenAddress;
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      if (seen.size > 5000) {
        const first = seen.values().next().value;
        seen.delete(first);
      }

      // Get pair details for liquidity data
      processNewDexToken(mint, profile).catch(() => {});
    }
  } catch (err) {
    logger.error('DexScreener poll error:', err.message);
  }
}

async function processNewDexToken(mint, profile) {
  if (BotState.isBlacklisted(mint)) return;

  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 5000 }
    );
    const data = await res.json();
    const pairs = data?.pairs || [];
    if (pairs.length === 0) return;

    // Find best pair by liquidity
    const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const liquidityUsd = pair.liquidity?.usd || 0;
    const priceUsd = parseFloat(pair.priceUsd || '0');
    const name = pair.baseToken?.name || 'Unknown';
    const symbol = pair.baseToken?.symbol || '???';
    const ageMs = Date.now() - (pair.pairCreatedAt || Date.now());
    const ageSeconds = ageMs / 1000;

    // Only snipe if pair is less than 5 minutes old
    if (ageSeconds > 300) return;

    logger.info(`🆕 [DexScreener] ${name} (${symbol}) — ${mint.slice(0, 8)}... liq=$${liquidityUsd.toFixed(0)}`);

    const rugResult = await checkRugRisk(mint, {
      liquidityUsd,
      ageSeconds,
      top10HolderPct: 0, // DexScreener doesn't provide this
    });

    if (!rugResult.safe) {
      logger.rug(`[DexScreener] ${symbol} failed rug check (score: ${rugResult.score})`);
      await sendTelegramAlert(
        `🚫 *Skipped (Rug Risk)*\n*${name}* (${symbol})\n` +
        `Score: ${rugResult.score}/100\n` +
        rugResult.reasons.slice(0, 2).map(r => `• ${r}`).join('\n')
      );
      return;
    }

    BotState.stats.sniped++;
    await executeBuy({
      mint,
      name,
      symbol,
      source: 'DexScreener',
      liquidityUsd,
      priceUsd,
      rugScore: rugResult.score,
    });
  } catch (err) {
    logger.error(`DexScreener processToken error (${mint?.slice(0, 8)}):`, err.message);
  }
}

module.exports = { startDexScreenerListener };
