const { BotState } = require('../utils/state');
const { checkRugRisk } = require('../security/rugcheck');
const { executeBuy } = require('../trader/executor');
const { sendTelegramAlert } = require('../bot/telegram');
const logger = require('../utils/logger');

const POLL_INTERVAL_MS = 30000; // 30s
const seen = new Set();
let intervalId = null;

function startVolumeSpikeDetector() {
  logger.info('📈 Volume spike detector starting (30s interval)...');
  poll();
  intervalId = setInterval(poll, POLL_INTERVAL_MS);
}

async function poll() {
  if (!BotState.sniping || !BotState.volumeSpike.enabled) return;

  try {
    const fetch = (await import('node-fetch')).default;

    // Fetch top boosted / trending from DexScreener
    const [trendingRes, boostedRes] = await Promise.allSettled([
      fetch('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 8000 }),
      fetch('https://api.dexscreener.com/token-boosts/latest/v1', { timeout: 8000 }),
    ]);

    const tokens = [];

    if (trendingRes.status === 'fulfilled' && trendingRes.value.ok) {
      const data = await trendingRes.value.json();
      tokens.push(...(Array.isArray(data) ? data : []));
    }

    if (boostedRes.status === 'fulfilled' && boostedRes.value.ok) {
      const data = await boostedRes.value.json();
      tokens.push(...(Array.isArray(data) ? data : []));
    }

    const solanaTokens = tokens.filter(t => t.chainId === 'solana');
    const unique = [...new Map(solanaTokens.map(t => [t.tokenAddress, t])).values()];

    for (const token of unique.slice(0, 30)) {
      const mint = token.tokenAddress;
      if (!mint || seen.has(mint)) continue;

      // Fetch pair details for volume/price change analysis
      const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 5000 });
      if (!pairRes.ok) continue;
      const pairData = await pairRes.json();
      const pairs = pairData?.pairs || [];
      if (pairs.length === 0) continue;

      const pair = pairs.sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0))[0];
      const vol1h = pair.volume?.h1 || 0;
      const vol5m = pair.volume?.m5 || 0;
      const priceChange5m = pair.priceChange?.m5 || 0;
      const priceChange1h = pair.priceChange?.h1 || 0;
      const liquidityUsd = pair.liquidity?.usd || 0;
      const name = pair.baseToken?.name || 'Unknown';
      const symbol = pair.baseToken?.symbol || '???';
      const ageMs = Date.now() - (pair.pairCreatedAt || Date.now());
      const ageMinutes = ageMs / 60000;

      // Volume spike criteria
      const spikeThreshold = BotState.volumeSpike.minVolume1h;
      const priceChangeThreshold = BotState.volumeSpike.minPriceChange5m;

      const isSpike =
        vol1h >= spikeThreshold &&
        priceChange5m >= priceChangeThreshold &&
        liquidityUsd >= 2000 &&
        ageMinutes <= 120 && // less than 2 hours old
        priceChange1h > 0; // overall uptrend

      if (!isSpike) continue;

      seen.add(mint);
      if (seen.size > 3000) { const f = seen.values().next().value; seen.delete(f); }

      logger.info(`📈 Volume spike: ${symbol} | vol1h=$${vol1h.toFixed(0)} | +${priceChange5m.toFixed(1)}% (5m)`);

      if (BotState.isBlacklisted(mint)) continue;
      if (BotState.positions.has(mint)) continue;

      const rugResult = await checkRugRisk(mint, { liquidityUsd });

      if (!rugResult.safe) {
        logger.rug(`[VolumeSpike] ${symbol} failed rug check`);
        continue;
      }

      await sendTelegramAlert(
        `📈 *Volume Spike Detected!*\n\n` +
        `*${name}* (${symbol})\n` +
        `Volume 1h: $${vol1h.toFixed(0)}\n` +
        `Volume 5m: $${vol5m.toFixed(0)}\n` +
        `Price +${priceChange5m.toFixed(1)}% (5m)\n` +
        `Price +${priceChange1h.toFixed(1)}% (1h)\n` +
        `Liquidity: $${liquidityUsd.toFixed(0)}\n` +
        `Age: ${ageMinutes.toFixed(0)}m\n` +
        `Mint: \`${mint}\``
      );

      BotState.stats.sniped++;
      await executeBuy({
        mint,
        name,
        symbol,
        source: 'VolumeSpike',
        liquidityUsd,
        rugScore: rugResult.score,
      });
    }
  } catch (err) {
    logger.error('VolumeSpike poll error:', err.message);
  }
}

function stopVolumeSpikeDetector() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}

module.exports = { startVolumeSpikeDetector, stopVolumeSpikeDetector };
