// ═══════════════════════════════════════════════════════════════
// MIGRATION SNIPER — Detects pump.fun → Raydium migrations
// "Soon Migrated" = approaching bonding curve completion (~$69k)
// "Migrated" = just graduated and created Raydium pool
// ═══════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const { BotState } = require('../utils/state');
const { checkRugRisk } = require('../security/rugcheck');
const { executeBuy } = require('../trader/executor');
const { sendTelegramAlert } = require('../bot/telegram');
const { resilientFetch } = require('../utils/fetcher');
const { getBubbleMapAnalysis, formatBubbleMapAlert, isBubbleMapRisky } = require('../security/bubblemaps');
const logger = require('../utils/logger');

// pump.fun bonding curve graduation threshold (SOL)
const GRADUATION_THRESHOLD_SOL = 85; // ~$69k market cap
const SOON_MIGRATED_THRESHOLD_SOL = 70; // alert at 70+ SOL = ~80% full

// Track seen tokens to avoid duplicates
const seenSoonMigrated = new Set();
const seenMigrated = new Set();

// Migration state
let migrationEnabled = false;
let soonMigratedEnabled = false;
let wsConnection = null;
let pollInterval = null;

// ─────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────
function startMigrationListener() {
  logger.info('🔄 Migration listener: monitoring pump.fun graduations...');
  connectMigrationWS();
  startMigrationPoller();
}

// ─────────────────────────────────────────────────────────────────
// METHOD 1: WebSocket — catches migrations in real-time
// ─────────────────────────────────────────────────────────────────
function connectMigrationWS() {
  if (wsConnection) { try { wsConnection.terminate(); } catch (_) {} }

  wsConnection = new WebSocket('wss://pumpportal.fun/api/data');

  wsConnection.on('open', () => {
    logger.info('🟢 Migration WS connected');
    // Subscribe to migration events (pump → raydium)
    wsConnection.send(JSON.stringify({ method: 'subscribeMigration' }));
    // Also subscribe to token trades to track bonding curve progress
    wsConnection.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  wsConnection.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      await handleMigrationEvent(data);
    } catch (_) {}
  });

  wsConnection.on('error', (err) => logger.error('Migration WS error:', err.message));
  wsConnection.on('close', () => {
    logger.warn('Migration WS closed — reconnecting in 5s...');
    setTimeout(connectMigrationWS, 5000);
  });

  // Keepalive
  setInterval(() => {
    if (wsConnection?.readyState === WebSocket.OPEN) wsConnection.ping();
  }, 30000);
}

// ─────────────────────────────────────────────────────────────────
// Handle incoming WS events
// ─────────────────────────────────────────────────────────────────
async function handleMigrationEvent(data) {
  // ── MIGRATED: token just graduated to Raydium ──
  if (data.txType === 'migrate' || data.type === 'migration') {
    if (!migrationEnabled || !BotState.sniping || !BotState.sources?.migrated) return;
    const mint = data.mint;
    if (!mint || seenMigrated.has(mint)) return;
    seenMigrated.add(mint);

    logger.info(`🎓 MIGRATED: ${mint.slice(0,8)}... just graduated to Raydium!`);
    await processMigratedToken(mint, data);
    return;
  }

  // ── SOON MIGRATED: track bonding curve fill level ──
  if (data.txType === 'buy' && data.mint && data.vSolInBondingCurve) {
    if (!soonMigratedEnabled || !BotState.sniping || !BotState.sources?.soonMigrated) return;
    const mint = data.mint;
    if (seenSoonMigrated.has(mint) || seenMigrated.has(mint)) return;

    const solInCurve = parseFloat(data.vSolInBondingCurve || 0);
    const fillPct = (solInCurve / GRADUATION_THRESHOLD_SOL) * 100;

    if (solInCurve >= SOON_MIGRATED_THRESHOLD_SOL) {
      seenSoonMigrated.add(mint);
      const name = data.name || 'Unknown';
      const symbol = data.symbol || '???';
      logger.info(`⏳ SOON MIGRATED: ${symbol} — ${solInCurve.toFixed(1)} SOL (${fillPct.toFixed(0)}% full)`);
      await processSoonMigratedToken(mint, name, symbol, solInCurve, fillPct);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// METHOD 2: Poller — catches any migrations WS might miss
// ─────────────────────────────────────────────────────────────────
function startMigrationPoller() {
  pollInterval = setInterval(async () => {
    if (!BotState.sniping) return;
    if (!migrationEnabled && !soonMigratedEnabled) return;

    try {
      // Poll pump.fun API for recently migrated tokens
      const res = await resilientFetch(
        'https://frontend-api.pump.fun/coins/recently-graduated?offset=0&limit=20&includeNsfw=false',
        { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } },
        2
      );
      if (!res.ok) return;
      const coins = await res.json();

      for (const coin of (coins || [])) {
        const mint = coin.mint;
        if (!mint || seenMigrated.has(mint)) continue;

        // Only process if migrated within last 10 minutes
        const migratedAt = coin.raydium_pool ? Date.now() : null;
        const ageMs = coin.last_trade_timestamp
          ? Date.now() - (coin.last_trade_timestamp * 1000)
          : 999999999;
        if (ageMs > 10 * 60 * 1000) continue; // skip if older than 10 min

        if (migrationEnabled && coin.raydium_pool && BotState.sources?.migrated) {
          seenMigrated.add(mint);
          await processMigratedToken(mint, coin);
        }

        // Soon migrated check via sol in bonding curve
        const solInCurve = parseFloat(coin.virtual_sol_reserves || 0) / 1e9;
        if (soonMigratedEnabled && !seenSoonMigrated.has(mint) && solInCurve >= SOON_MIGRATED_THRESHOLD_SOL && BotState.sources?.soonMigrated) {
          seenSoonMigrated.add(mint);
          const fillPct = (solInCurve / GRADUATION_THRESHOLD_SOL) * 100;
          await processSoonMigratedToken(mint, coin.name, coin.symbol, solInCurve, fillPct);
        }
      }

      // Poll soon-to-migrate tokens
      if (soonMigratedEnabled && BotState.sources?.soonMigrated) {
        const res2 = await resilientFetch(
          'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false',
          { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } },
          2
        );
        if (res2.ok) {
          const active = await res2.json();
          for (const coin of (active || [])) {
            const mint = coin.mint;
            if (!mint || seenSoonMigrated.has(mint) || seenMigrated.has(mint)) continue;
            const solInCurve = parseFloat(coin.virtual_sol_reserves || 0) / 1e9;
            if (solInCurve >= SOON_MIGRATED_THRESHOLD_SOL) {
              seenSoonMigrated.add(mint);
              const fillPct = (solInCurve / GRADUATION_THRESHOLD_SOL) * 100;
              await processSoonMigratedToken(mint, coin.name, coin.symbol, solInCurve, fillPct);
            }
          }
        }
      }
    } catch (err) {
      logger.error('[Migration poller] error:', err.message);
    }
  }, 20000); // poll every 20s
}

// ─────────────────────────────────────────────────────────────────
// Process MIGRATED token (graduated → Raydium)
// ─────────────────────────────────────────────────────────────────
async function processMigratedToken(mint, data) {
  const name = data.name || 'Unknown';
  const symbol = data.symbol || '???';
  const marketCap = data.usd_market_cap || data.market_cap || 0;
  const raydiumPool = data.raydium_pool || 'N/A';

  logger.info(`🎓 Processing migrated: ${symbol} (${mint.slice(0,8)}...)`);

  // Wait for DexScreener to index the token (retry up to 5x with 8s delay)
  let liquidityUsd = 0, priceUsd = 0, retryName = name, retrySymbol = symbol;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await resilientFetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, 2);
      const dex = await res.json();
      const pair = (dex?.pairs || [])[0];
      if (pair && (pair.liquidity?.usd || 0) > 0) {
        liquidityUsd = pair.liquidity?.usd || 0;
        priceUsd = parseFloat(pair.priceUsd || '0');
        retryName = pair.baseToken?.name || name;
        retrySymbol = pair.baseToken?.symbol || symbol;
        logger.info(`[Migration] DEX data ready after ${attempt} attempt(s): liq=$${liquidityUsd.toFixed(0)}`);
        break;
      }
      if (attempt < 5) {
        logger.info(`[Migration] Waiting for DEX indexing... attempt ${attempt}/5`);
        await new Promise(r => setTimeout(r, 8000)); // wait 8s between retries
      }
    } catch (_) {
      if (attempt < 5) await new Promise(r => setTimeout(r, 8000));
    }
  }

  // Skip if still no liquidity after all retries
  if (liquidityUsd === 0) {
    logger.warn(`[Migration] No liquidity found after 5 attempts — skipping ${mint.slice(0,8)}...`);
    await sendTelegramAlert(
      `⏭ *Migration Skipped*\n` +
      `No liquidity data after 40s\n` +
      `Mint: \`${mint.slice(0,16)}...\`\n` +
      `[Check manually](https://dexscreener.com/solana/${mint})`
    );
    return;
  }

  // Update name/symbol with real data
  name = retryName; symbol = retrySymbol;
  
  // Also enforce minimum liquidity filter
  const minLiq = BotState.rugFilter?.minLiquidityUsd || 1000;
  if (liquidityUsd < minLiq) {
    logger.warn(`[Migration] Liquidity $${liquidityUsd.toFixed(0)} below minimum $${minLiq} — skipping`);
    await sendTelegramAlert(
      `⏭ *Migration Skipped*\n` +
      `*${name}* (${symbol})\n` +
      `Liquidity $${liquidityUsd.toFixed(0)} < minimum $${minLiq}`
    );
    return;
  }

  // Rug check + BubbleMaps in parallel
  const [rugResult, bubbleAnalysis] = await Promise.allSettled([
    checkRugRisk(mint, { liquidityUsd }),
    getBubbleMapAnalysis(mint),
  ]);

  const rug = rugResult.status === 'fulfilled' ? rugResult.value : { safe: true, score: 0, reasons: [] };
  const bubble = bubbleAnalysis.status === 'fulfilled' ? bubbleAnalysis.value : null;
  const bubbleText = bubble ? formatBubbleMapAlert(bubble) : '🫧 BubbleMaps: unavailable';

  const rugEmoji = rug.score < 30 ? '🟢' : rug.score < 60 ? '🟡' : '🔴';

  // Check bubble risk gate
  const bubbleRisky = bubble && isBubbleMapRisky(bubble, {
    maxClusterPct: BotState.bubbleMapSettings?.maxClusterPct || 50,
    minDecentScore: BotState.bubbleMapSettings?.minDecentScore || 0,
    maxTop1Pct: BotState.bubbleMapSettings?.maxTop1Pct || 30,
  });

  await sendTelegramAlert(
    `🎓 *MIGRATED to Raydium!*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `*${name}* (${symbol})\n\n` +
    `📋 *CA:*\n\`${mint}\`\n\n` +
    `💧 Liquidity: $${liquidityUsd.toFixed(0)}\n` +
    `📊 Market Cap: $${marketCap > 0 ? (marketCap/1000).toFixed(0)+'k' : 'N/A'}\n` +
    `${rugEmoji} Rug Score: ${rug.score}/100\n\n` +
    `🔗 [DexScreener](https://dexscreener.com/solana/${mint}) | [Solscan](https://solscan.io/token/${mint})\n` +
    `[pump.fun](https://pump.fun/${mint}) | [Birdeye](https://birdeye.so/token/${mint})\n\n` +
    bubbleText + `\n\n` +
    `${bubbleRisky ? '🚫 *BubbleMaps risk gate triggered — skipping*' : rug.safe ? '✅ Passed all checks — sniping...' : `⚠️ Rug risk — skipping\n${rug.reasons.slice(0,2).map(r=>'• '+r).join('\n')}`}`
  );

  if (!rugResult.safe) return;

  // Auto-snipe if enabled
  if (BotState.autoSnipeMigrated) {
    BotState.stats.sniped++;
    await executeBuy({
      mint, name, symbol,
      source: '🎓 Migrated',
      liquidityUsd,
      priceUsd,
      rugScore: rugResult.score,
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Process SOON MIGRATED token (bonding curve almost full)
// ─────────────────────────────────────────────────────────────────
async function processSoonMigratedToken(mint, name, symbol, solInCurve, fillPct) {
  logger.info(`⏳ Soon migrated: ${symbol} ${fillPct.toFixed(0)}% full`);

  // Fetch price data
  let liquidityUsd = 0, priceUsd = 0;
  try {
    const res = await resilientFetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, 2);
    const dex = await res.json();
    const pair = (dex?.pairs || [])[0];
    if (pair) {
      liquidityUsd = pair.liquidity?.usd || 0;
      priceUsd = parseFloat(pair.priceUsd || '0');
    }
  } catch (_) {}

  // Progress bar
  const filled = Math.round(fillPct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

  // Rug check + BubbleMaps in parallel
  const [rugResult, bubbleAnalysis] = await Promise.allSettled([
    checkRugRisk(mint, { liquidityUsd }),
    getBubbleMapAnalysis(mint),
  ]);

  const rug = rugResult.status === 'fulfilled' ? rugResult.value : { safe: true, score: 0, reasons: [] };
  const bubble = bubbleAnalysis.status === 'fulfilled' ? bubbleAnalysis.value : null;
  const bubbleText = bubble ? formatBubbleMapAlert(bubble) : '🫧 BubbleMaps: loading...';
  const rugEmoji = rug.score < 30 ? '🟢' : rug.score < 60 ? '🟡' : '🔴';

  const bubbleRisky = bubble && isBubbleMapRisky(bubble, {
    maxClusterPct: BotState.bubbleMapSettings?.maxClusterPct || 50,
    minDecentScore: BotState.bubbleMapSettings?.minDecentScore || 0,
    maxTop1Pct: BotState.bubbleMapSettings?.maxTop1Pct || 30,
  });

  await sendTelegramAlert(
    `⏳ *SOON TO MIGRATE!*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `*${name}* (${symbol})\n\n` +
    `📋 *CA:*\n\`${mint}\`\n\n` +
    `🎯 Bonding Curve: *${fillPct.toFixed(0)}%* full\n` +
    `[${bar}] ${solInCurve.toFixed(1)}/${GRADUATION_THRESHOLD_SOL} SOL\n\n` +
    `💧 Liquidity: $${liquidityUsd.toFixed(0)}\n` +
    `${rugEmoji} Rug Score: ${rug.score}/100\n\n` +
    bubbleText + `\n\n` +
    `🔗 [DexScreener](https://dexscreener.com/solana/${mint}) | [pump.fun](https://pump.fun/${mint})\n` +
    `[Birdeye](https://birdeye.so/token/${mint}) | [Solscan](https://solscan.io/token/${mint})\n\n` +
    `${bubbleRisky ? '🚫 BubbleMaps flagged — high cluster risk' : rug.safe ? (BotState.autoSnipeSoonMigrated ? '✅ Auto-buying now!' : '⚡ _Review above then buy manually_') : `⚠️ Rug risk — monitor only\n${rug.reasons.slice(0,2).map(r=>'• '+r).join('\n')}`}`
  );

  if (!rugResult.safe) return;

  // Auto-snipe if enabled
  if (BotState.autoSnipeSoonMigrated) {
    BotState.stats.sniped++;
    await executeBuy({
      mint, name, symbol,
      source: '⏳ Soon Migrated',
      liquidityUsd,
      priceUsd,
      rugScore: rugResult.score,
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────
function enableMigrated(auto = false) {
  migrationEnabled = true;
  BotState.autoSnipeMigrated = auto;
  if (!BotState.sources) BotState.sources = {};
  BotState.sources.migrated = true;
  logger.info(`🎓 Migrated sniper: ON (auto-buy: ${auto})`);
}

function disableMigrated() {
  migrationEnabled = false;
  if (BotState.sources) BotState.sources.migrated = false;
  logger.info('🎓 Migrated sniper: OFF');
}

function enableSoonMigrated(auto = false) {
  soonMigratedEnabled = true;
  BotState.autoSnipeSoonMigrated = auto;
  if (!BotState.sources) BotState.sources = {};
  BotState.sources.soonMigrated = true;
  logger.info(`⏳ Soon-migrated sniper: ON (auto-buy: ${auto})`);
}

function disableSoonMigrated() {
  soonMigratedEnabled = false;
  if (BotState.sources) BotState.sources.soonMigrated = false;
  logger.info('⏳ Soon-migrated sniper: OFF');
}

function getMigrationStatus() {
  return {
    migrated: { enabled: migrationEnabled, autoBuy: BotState.autoSnipeMigrated },
    soonMigrated: { enabled: soonMigratedEnabled, autoBuy: BotState.autoSnipeSoonMigrated },
    seenMigrated: seenMigrated.size,
    seenSoon: seenSoonMigrated.size,
  };
}

module.exports = {
  startMigrationListener,
  enableMigrated,
  disableMigrated,
  enableSoonMigrated,
  disableSoonMigrated,
  getMigrationStatus,
};
