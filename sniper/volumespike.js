const { BotState } = require('../utils/state');
const { checkRugRisk } = require('../security/rugcheck');
const { executeBuy } = require('../trader/executor');
const { sendTelegramAlert } = require('../bot/telegram');
const logger = require('../utils/logger');

const POLL_INTERVAL_MS = 30000; // 30s
const seen = new Set();

// Store recent volume snapshots: mint -> { vol24h, lastSeen }
const volumeSnapshots = new Map();

function startVolumeSpike() {
  logger.info('📊 Volume spike detector started');
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

async function poll() {
  if (!BotState.sniping || !BotState.volumeSpike?.enabled) return;

  try {
    const fetch = (await import('node-fetch')).default;

    // DexScreener trending Solana tokens
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/search?q=solana',
      { headers: { 'User-Agent': 'SniperBot/1.0' }, timeout: 8000 }
    );
    if (!res.ok) return;
    const data = await res.json();
    const pairs = data?.pairs || [];

    for (const pair of pairs.slice(0, 50)) {
      if (pair.chainId !== 'solana') continue;

      const mint = pair.baseToken?.address;
      if (!mint) continue;

      const vol24h = pair.volume?.h24 || 0;
      const vol1h = pair.volume?.h1 || 0;
      const vol5m = pair.volume?.m5 || 0;
      const liquidityUsd = pair.liquidity?.usd || 0;
      const priceChange5m = pair.priceChange?.m5 || 0;
      const ageMs = Date.now() - (pair.pairCreatedAt || 0);
      const ageMinutes = ageMs / 60000;
      const name = pair.baseToken?.name || 'Unknown';
      const symbol = pair.baseToken?.symbol || '???';

      // Skip old tokens (> 30 min), too new (< 1 min), or already seen
      if (ageMinutes > 30 || ageMinutes < 1) continue;
      if (seen.has(mint)) continue;
      if (BotState.isBlacklisted(mint)) continue;

      // Volume spike logic: 5m volume is large relative to liquidity
      const volToLiqRatio = liquidityUsd > 0 ? vol5m / liquidityUsd : 0;
      const minThreshold = BotState.volumeSpike?.minVolToLiqRatio || 0.3;
      const minLiq = BotState.volumeSpike?.minLiquidity || 2000;
      const minPriceChange = BotState.volumeSpike?.minPriceChange5m || 10; // %

      if (liquidityUsd < minLiq) continue;
      if (volToLiqRatio < minThreshold && priceChange5m < minPriceChange) continue;

      // Check vs previous snapshot for ACCELERATION
      const prev = volumeSnapshots.get(mint);
      if (prev) {
        const volAccel = prev.vol5m > 0 ? vol5m / prev.vol5m : 1;
        if (volAccel < 1.5 && priceChange5m < minPriceChange) {
          volumeSnapshots.set(mint, { vol5m, lastSeen: Date.now() });
          continue;
        }
      }
      volumeSnapshots.set(mint, { vol5m, lastSeen: Date.now() });

      seen.add(mint);
      if (seen.size > 3000) {
        const first = seen.values().next().value;
        seen.delete(first);
      }

      logger.info(
        `📊 [VolumeSpike] ${name} (${symbol}) — vol5m=$${vol5m.toFixed(0)} | liq=$${liquidityUsd.toFixed(0)} | +${priceChange5m.toFixed(1)}%`
      );

      await sendTelegramAlert(
        `📊 *Volume Spike Detected*\n` +
        `*${name}* (${symbol})\n` +
        `5m Volume: $${vol5m.toFixed(0)}\n` +
        `Liquidity: $${liquidityUsd.toFixed(0)}\n` +
        `Price Change 5m: +${priceChange5m.toFixed(2)}%\n` +
        `Age: ${ageMinutes.toFixed(1)} min\n` +
        `Checking safety...`
      );

      // Rug check
      const rug = await checkRugRisk(mint, { liquidityUsd, ageSeconds: ageMinutes * 60 });
      if (!rug.safe) {
        await sendTelegramAlert(
          `🚫 *VolumeSpike Skipped* — Rug risk\n*${symbol}* | Score: ${rug.score}/100`
        );
        continue;
      }

      BotState.stats.sniped++;
      await executeBuy({
        mint,
        name,
        symbol,
        source: 'VolumeSpike',
        liquidityUsd,
        rugScore: rug.score,
      });
    }

    // Cleanup old snapshots
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [mint, snap] of volumeSnapshots.entries()) {
      if (snap.lastSeen < cutoff) volumeSnapshots.delete(mint);
    }
  } catch (err) {
    logger.error('VolumeSpike poll error:', err.message);
  }
}

module.exports = { startVolumeSpike };
