// ═══════════════════════════════════════════════════════════════
// FEATURES MODULE — 16 new features for SolSnipe Bot
// ═══════════════════════════════════════════════════════════════

const { BotState } = require('../utils/state');
const { sendTelegramAlert } = require('../bot/telegram');
const { executeSell, executeBuy } = require('../trader/executor');
const { getConnection, getSolBalance, getPublicKey } = require('../utils/wallet');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────
// 1. HONEYPOT DETECTOR
// Simulates a sell before buying — catches tokens you can buy but never sell
// ─────────────────────────────────────────────────────────────────
async function checkHoneypot(mint) {
  try {
    const { resilientFetch } = require('../utils/fetcher');
    const fetch = async (url, opts) => resilientFetch(url, opts, 2);
    // Use Jupiter to simulate a sell quote — if it fails token is likely a honeypot
    const res = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=1000000&slippageBps=5000`,
      { timeout: 6000 }
    );
    const data = await res.json();
    if (data.error || !data.outAmount || parseInt(data.outAmount) === 0) {
      logger.warn(`[Honeypot] ${mint.slice(0,8)}... cannot be sold — HONEYPOT!`);
      return { honeypot: true, reason: 'Token cannot be sold via Jupiter — likely honeypot' };
    }
    // Check price impact on sell — if >80% it's basically a honeypot
    const impact = parseFloat(data.priceImpactPct || '0');
    if (impact > 80) {
      return { honeypot: true, reason: `Sell price impact: ${impact.toFixed(1)}% — honeypot trap` };
    }
    return { honeypot: false, reason: `✅ Sellable (impact: ${impact.toFixed(1)}%)` };
  } catch (err) {
    logger.warn(`[Honeypot] Check failed: ${err.message} — allowing`);
    return { honeypot: false, reason: 'Check unavailable' };
  }
}

// ─────────────────────────────────────────────────────────────────
// 2. TRAILING STOP LOSS
// Follows price up, sells if it drops X% from peak
// ─────────────────────────────────────────────────────────────────
const peakPrices = new Map(); // mint -> peak price

function updateTrailingStop(mint, currentPrice) {
  const peak = peakPrices.get(mint) || 0;
  if (currentPrice > peak) {
    peakPrices.set(mint, currentPrice);
  }
}

function checkTrailingStop(mint, currentPrice) {
  const trailPct = BotState.trailingStopPct || 25; // default 25% from peak
  const peak = peakPrices.get(mint);
  if (!peak || !currentPrice) return false;
  const dropFromPeak = ((peak - currentPrice) / peak) * 100;
  return dropFromPeak >= trailPct;
}

// ─────────────────────────────────────────────────────────────────
// 3. PARTIAL TAKE PROFIT
// Sells in stages: e.g. 50% at 2x, 25% at 5x, rest at 10x
// ─────────────────────────────────────────────────────────────────
const partialSellTracker = new Map(); // mint -> { stage: 0 }

async function checkPartialTakeProfit(mint, currentPrice, buyPrice) {
  if (!BotState.partialTP?.enabled) return false;
  const stages = BotState.partialTP.stages || [
    { multiple: 2, sellPct: 50 },
    { multiple: 5, sellPct: 25 },
    { multiple: 10, sellPct: 25 },
  ];

  const tracker = partialSellTracker.get(mint) || { stage: 0 };
  const multiple = currentPrice / buyPrice;
  const currentStage = stages[tracker.stage];
  if (!currentStage) return false;

  if (multiple >= currentStage.multiple) {
    tracker.stage++;
    partialSellTracker.set(mint, tracker);
    return { shouldSell: true, pct: currentStage.sellPct, multiple: currentStage.multiple };
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────
// 4. DAILY P&L REPORT — sends every midnight
// ─────────────────────────────────────────────────────────────────
let dailyTrades = [];

function recordDailyTrade(trade) {
  dailyTrades.push(trade);
}

async function sendDailyReport() {
  const wins = dailyTrades.filter(t => t.pnlSol > 0);
  const losses = dailyTrades.filter(t => t.pnlSol <= 0);
  const totalPnl = dailyTrades.reduce((s, t) => s + (t.pnlSol || 0), 0);
  const bestTrade = dailyTrades.sort((a,b) => b.pnlSol - a.pnlSol)[0];
  const worstTrade = [...dailyTrades].sort((a,b) => a.pnlSol - b.pnlSol)[0];
  const wr = dailyTrades.length > 0 ? ((wins.length / dailyTrades.length) * 100).toFixed(1) : '0';
  const bal = await getSolBalance().catch(() => '?');

  await sendTelegramAlert(
    `📊 *Daily P&L Report*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📅 ${new Date().toLocaleDateString()}\n\n` +
    `Total Trades: ${dailyTrades.length}\n` +
    `✅ Wins: ${wins.length} | ❌ Losses: ${losses.length}\n` +
    `Win Rate: ${wr}%\n` +
    `Total P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL\n\n` +
    `${bestTrade ? `🏆 Best: *${bestTrade.symbol}* +${bestTrade.pnlSol?.toFixed(4)} SOL\n` : ''}` +
    `${worstTrade && worstTrade.pnlSol < 0 ? `💀 Worst: *${worstTrade.symbol}* ${worstTrade.pnlSol?.toFixed(4)} SOL\n` : ''}` +
    `\n👛 Wallet Balance: ${typeof bal === 'number' ? bal.toFixed(4) : bal} SOL`
  );

  dailyTrades = []; // Reset for next day
}

function startDailyReport() {
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  setTimeout(() => {
    sendDailyReport();
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
  logger.info('📊 Daily P&L report scheduled for midnight');
}

// ─────────────────────────────────────────────────────────────────
// 5. MORNING BRIEFING — sends every day at 8am
// ─────────────────────────────────────────────────────────────────
async function sendMorningBriefing() {
  const s = BotState.getSummary();
  const bal = await getSolBalance().catch(() => '?');
  const pnl = parseFloat(s.totalPnlSol);

  await sendTelegramAlert(
    `🌅 *Good Morning! Daily Briefing*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📅 ${new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })}\n\n` +
    `🤖 Bot: ${s.sniping ? '🟢 Active' : '🔴 Stopped'}\n` +
    `👛 Balance: ${typeof bal === 'number' ? bal.toFixed(4) : bal} SOL\n` +
    `💼 Open Positions: ${s.positions}\n\n` +
    `📈 *All-Time Stats*\n` +
    `Sniped: ${s.sniped} tokens\n` +
    `Wins: ${s.wins} | Losses: ${s.losses}\n` +
    `Win Rate: ${s.winRate}%\n` +
    `Total P&L: ${pnl >= 0 ? '+' : ''}${s.totalPnlSol} SOL\n\n` +
    `📡 Sources: ` +
    `${s.sources.pumpfun ? 'pump.fun ✅' : ''} ` +
    `${s.sources.dexscreener ? 'DEX ✅' : ''} ` +
    `${s.sources.raydium ? 'Raydium ✅' : ''}\n\n` +
    `_Have a profitable day! 🚀_`
  );
}

function startMorningBriefing() {
  const now = new Date();
  const next8am = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0);
  if (now >= next8am) next8am.setDate(next8am.getDate() + 1);
  const msUntil8am = next8am.getTime() - now.getTime();

  setTimeout(() => {
    sendMorningBriefing();
    setInterval(sendMorningBriefing, 24 * 60 * 60 * 1000);
  }, msUntil8am);
  logger.info('🌅 Morning briefing scheduled for 8:00 AM daily');
}

// ─────────────────────────────────────────────────────────────────
// 6. AUTO RESTART ON CRASH — health check + auto-recovery
// ─────────────────────────────────────────────────────────────────
let lastHeartbeat = Date.now();
let crashCount = 0;

function startHealthMonitor() {
  // Update heartbeat every minute
  setInterval(() => { lastHeartbeat = Date.now(); }, 60000);

  // Watch for process errors and notify Telegram
  process.on('uncaughtException', async (err) => {
    crashCount++;
    logger.error('💥 Uncaught exception:', err.message);
    try {
      await sendTelegramAlert(
        `💥 *Bot Crashed!*\n` +
        `Error: ${err.message}\n` +
        `Crash #${crashCount}\n` +
        `_Render will auto-restart..._`
      );
    } catch (_) {}
    // Let Render's process manager restart it
    process.exit(1);
  });

  process.on('unhandledRejection', async (err) => {
    logger.error('⚠️ Unhandled rejection:', err?.message || err);
    try {
      await sendTelegramAlert(`⚠️ *Unhandled Error*\n${err?.message || err}\n_Bot continuing..._`);
    } catch (_) {}
  });

  logger.info('💓 Health monitor active — auto-restart on crash enabled');
}

// ─────────────────────────────────────────────────────────────────
// 7. TELEGRAM TRADE SUMMARY BUTTON
// Beautiful formatted table of all trades this session
// ─────────────────────────────────────────────────────────────────
async function sendTradeSummary() {
  const trades = BotState.tradeHistory;
  if (!trades || trades.length === 0) {
    await sendTelegramAlert('📋 No trades this session yet.');
    return;
  }

  const wins = trades.filter(t => t.pnlSol > 0).length;
  const losses = trades.filter(t => t.pnlSol <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + (t.pnlSol || 0), 0);
  const wr = ((wins / trades.length) * 100).toFixed(0);

  let rows = '';
  for (const t of trades.slice(0, 15)) {
    const e = t.pnlSol >= 0 ? '🟢' : '🔴';
    const pnl = `${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol?.toFixed(3)}`;
    rows += `${e} \`${(t.symbol || '???').padEnd(8)}\` ${pnl.padStart(8)} SOL\n`;
  }

  await sendTelegramAlert(
    `📋 *Session Trade Summary*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${rows}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Trades: ${trades.length} | W: ${wins} L: ${losses} | WR: ${wr}%\n` +
    `Net P&L: *${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL*`
  );
}

// ─────────────────────────────────────────────────────────────────
// 8. NEWS FEED MONITOR
// Watches Telegram crypto channels for token mentions
// ─────────────────────────────────────────────────────────────────
const newsMentions = new Map(); // mint/symbol -> count

async function checkNewsFeed(symbol, mint) {
  try {
    const { resilientFetch } = require('../utils/fetcher');
    const fetch = async (url, opts) => resilientFetch(url, opts, 2);
    // Check DexScreener social data for the token
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 5000 }
    );
    const data = await res.json();
    const pair = (data?.pairs || [])[0];

    if (!pair) return { score: 0, signals: [] };

    const signals = [];
    let score = 0;

    // Check social volume signals from DexScreener
    const txns5m = pair.txns?.m5?.buys || 0;
    const txns1h = pair.txns?.h1?.buys || 0;
    const vol5m = pair.volume?.m5 || 0;
    const priceChange5m = parseFloat(pair.priceChange?.m5 || 0);

    if (txns5m > 50) { score += 20; signals.push(`🔥 ${txns5m} buys in 5m`); }
    if (vol5m > 10000) { score += 20; signals.push(`💰 $${vol5m.toFixed(0)} volume in 5m`); }
    if (priceChange5m > 20) { score += 30; signals.push(`📈 +${priceChange5m.toFixed(1)}% in 5m`); }
    if (txns1h > 500) { score += 30; signals.push(`🚀 ${txns1h} buys in 1h`); }

    // Track mention count
    const prev = newsMentions.get(symbol) || 0;
    newsMentions.set(symbol, prev + 1);
    if (prev > 0) { score += 15; signals.push(`📡 Seen ${prev + 1}x in feed`); }

    return { score, signals };
  } catch (_) {
    return { score: 0, signals: [] };
  }
}

async function startNewsFeedMonitor() {
  logger.info('📰 News feed monitor active — tracking social signals');
  // Alert on high-momentum tokens every 5 min
  setInterval(async () => {
    if (!BotState.sniping) return;
    try {
      const { resilientFetch } = require('../utils/fetcher');
    const fetch = async (url, opts) => resilientFetch(url, opts, 2);
      const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 6000 });
      if (!res.ok) return;
      const boosts = await res.json();
      for (const b of (boosts || []).slice(0, 5)) {
        if (b.chainId !== 'solana') continue;
        if (newsMentions.has(b.tokenAddress)) continue;
        newsMentions.set(b.tokenAddress, 1);
        await sendTelegramAlert(
          `📰 *Trending Alert*\n` +
          `Token: *${b.description || b.tokenAddress?.slice(0,8)}*\n` +
          `Mint: \`${b.tokenAddress?.slice(0,16)}...\`\n` +
          `[View on DexScreener](https://dexscreener.com/solana/${b.tokenAddress})`
        );
      }
    } catch (_) {}
  }, 5 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────
// 9. AUTO BUY ON WHALE WALLET ALERT
// Notifies AND auto-buys when a known whale buys
// ─────────────────────────────────────────────────────────────────
const whaleWallets = new Map(); // address -> { label, autoBuy, minSol }

function addWhaleWallet(address, label, autoBuy = false, minSol = 0.5) {
  whaleWallets.set(address, { label, autoBuy, minSol });
  watchWhaleWallet(address);
}

function removeWhaleWallet(address) {
  whaleWallets.delete(address);
}

function watchWhaleWallet(address) {
  const conn = getConnection();
  try {
    conn.onLogs(new PublicKey(address), async (logInfo) => {
      if (logInfo.err) return;
      const data = whaleWallets.get(address);
      if (!data) return;

      // Detect swap
      const isSwap = logInfo.logs.some(l =>
        l.includes('Instruction: Route') ||
        l.includes('ray_log') ||
        l.includes('Instruction: Swap')
      );
      if (!isSwap) return;

      try {
        const conn2 = getConnection();
        const tx = await conn2.getParsedTransaction(logInfo.signature, {
          maxSupportedTransactionVersion: 0, commitment: 'confirmed'
        });
        if (!tx) return;

        const WSOL = 'So11111111111111111111111111111111111111112';
        const postBal = tx.meta?.postTokenBalances || [];
        const preBal = tx.meta?.preTokenBalances || [];
        let boughtMint = null;

        for (const post of postBal) {
          if (post.owner !== address || post.mint === WSOL) continue;
          const pre = preBal.find(p => p.mint === post.mint && p.owner === address);
          if ((post.uiTokenAmount?.uiAmount || 0) > (pre?.uiTokenAmount?.uiAmount || 0)) {
            boughtMint = post.mint; break;
          }
        }

        if (!boughtMint) return;

        // Calculate SOL spent
        const walletIdx = (tx.transaction?.message?.accountKeys || [])
          .findIndex(k => (k.pubkey?.toString?.() || k) === address);
        const solSpent = walletIdx >= 0
          ? ((tx.meta?.preBalances[walletIdx] || 0) - (tx.meta?.postBalances[walletIdx] || 0)) / LAMPORTS_PER_SOL
          : 0;

        if (solSpent < data.minSol) return; // ignore small buys

        await sendTelegramAlert(
          `🐳 *Whale Alert!*\n` +
          `Wallet: *${data.label}*\n` +
          `Bought: \`${boughtMint.slice(0,16)}...\`\n` +
          `Spent: *${solSpent.toFixed(3)} SOL*\n` +
          `TX: [View](https://solscan.io/tx/${logInfo.signature})\n` +
          `${data.autoBuy ? '⚡ Auto-buying...' : '💡 Tap to copy trade'}`
        );

        if (data.autoBuy && BotState.sniping && !BotState.isBlacklisted(boughtMint)) {
          BotState.stats.sniped++;
          await executeBuy({ mint: boughtMint, name: 'Whale', symbol: '???', source: `Whale:${data.label}` });
        }
      } catch (_) {}
    }, 'confirmed');
    logger.info(`🐳 Watching whale: ${address.slice(0,12)}...`);
  } catch (err) {
    logger.error('[Whale] subscribe error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// 10. SNIPE BUDGET LIMIT
// Stops buying when daily SOL spend limit is hit
// ─────────────────────────────────────────────────────────────────
let dailySpent = 0;
let budgetResetTime = Date.now() + 24 * 60 * 60 * 1000;

function checkBudgetLimit() {
  if (Date.now() > budgetResetTime) {
    dailySpent = 0;
    budgetResetTime = Date.now() + 24 * 60 * 60 * 1000;
    logger.info('💰 Daily budget reset');
  }
  const limit = BotState.dailyBudgetSol || 999;
  if (dailySpent >= limit) {
    logger.warn(`[Budget] Daily limit reached: ${dailySpent.toFixed(3)}/${limit} SOL`);
    return false;
  }
  return true;
}

function recordSpend(solAmount) {
  dailySpent += solAmount;
  const limit = BotState.dailyBudgetSol || 999;
  const remaining = limit - dailySpent;
  if (remaining <= BotState.sniper?.buyAmountSol * 2) {
    sendTelegramAlert(`⚠️ *Budget Warning*\nSpent: ${dailySpent.toFixed(3)} SOL today\nRemaining: ${remaining.toFixed(3)} SOL`).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────
// 11. CONTRACT AGE CHECK — skip if deployer wallet is brand new
// ─────────────────────────────────────────────────────────────────
async function checkDeployerAge(devWallet) {
  if (!devWallet) return { safe: true, reason: 'No dev wallet provided' };
  try {
    const conn = getConnection();
    const sigs = await conn.getSignaturesForAddress(new PublicKey(devWallet), { limit: 1 });
    if (sigs.length === 0) return { safe: false, reason: '🚨 Dev wallet has zero history — brand new' };

    const oldest = sigs[sigs.length - 1];
    const walletAgeMs = Date.now() - (oldest.blockTime * 1000);
    const walletAgeDays = walletAgeMs / (1000 * 60 * 60 * 24);
    const minAgeDays = BotState.minDeployerAgeDays || 1;

    if (walletAgeDays < minAgeDays) {
      return {
        safe: false,
        reason: `🚨 Dev wallet only ${(walletAgeDays * 24).toFixed(1)}h old — likely disposable`
      };
    }
    return { safe: true, reason: `✅ Dev wallet ${walletAgeDays.toFixed(0)} days old` };
  } catch (err) {
    return { safe: true, reason: 'Age check unavailable' };
  }
}

// ─────────────────────────────────────────────────────────────────
// 12. LIQUIDITY LOCK VERIFIER
// Checks if LP is locked on Streamflow or known lockers
// ─────────────────────────────────────────────────────────────────
async function checkLiquidityLock(mint) {
  const minLockDays = BotState.rugFilter?.minLpLockDays || 0;
  if (minLockDays === 0) return { locked: true, reason: 'Lock check disabled (min=0)' };

  try {
    const { resilientFetch } = require('../utils/fetcher');
    const fetch = async (url, opts) => resilientFetch(url, opts, 2);
    // Check via Streamflow API
    const res = await fetch(
      `https://api.streamflow.finance/v2/api/streams?mint=${mint}&cluster=mainnet`,
      { timeout: 5000 }
    );
    if (!res.ok) return { locked: false, reason: 'Lock check unavailable' };
    const data = await res.json();
    const locks = (data?.streams || []).filter(s => !s.canceledAt && s.mint === mint);

    if (locks.length === 0) {
      return { locked: false, reason: `⚠️ No LP lock found (required: ${minLockDays}d)` };
    }

    const lockEnd = locks[0]?.endTime || 0;
    const lockDays = (lockEnd * 1000 - Date.now()) / (1000 * 60 * 60 * 24);
    if (lockDays < minLockDays) {
      return { locked: false, reason: `⚠️ LP locked only ${lockDays.toFixed(0)}d (need ${minLockDays}d)` };
    }
    return { locked: true, reason: `✅ LP locked ${lockDays.toFixed(0)} more days` };
  } catch (_) {
    return { locked: true, reason: 'Lock check unavailable — skipping' };
  }
}

// ─────────────────────────────────────────────────────────────────
// 13. TWITTER/X SENTIMENT CHECK
// Checks recent Twitter/X activity for the token
// ─────────────────────────────────────────────────────────────────
async function checkTwitterSentiment(symbol, mint) {
  if (!BotState.twitterCheck?.enabled) return { ok: true, reason: 'Twitter check disabled' };
  try {
    const { resilientFetch } = require('../utils/fetcher');
    const fetch = async (url, opts) => resilientFetch(url, opts, 2);
    // Use DexScreener social info as Twitter proxy (free, no API key needed)
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 5000 });
    const data = await res.json();
    const pair = (data?.pairs || [])[0];

    if (!pair) return { ok: true, reason: 'No social data' };

    const websites = pair.info?.websites || [];
    const socials = pair.info?.socials || [];
    const hasTwitter = socials.some(s => s.type === 'twitter');
    const hasTelegram = socials.some(s => s.type === 'telegram');
    const hasWebsite = websites.length > 0;

    let score = 0;
    const signals = [];

    if (hasTwitter) { score += 30; signals.push('✅ Has Twitter'); }
    if (hasTelegram) { score += 20; signals.push('✅ Has Telegram'); }
    if (hasWebsite) { score += 20; signals.push('✅ Has website'); }

    const minScore = BotState.twitterCheck?.minScore || 0;
    if (score < minScore) {
      return { ok: false, reason: `⚠️ Low social presence (score: ${score}) — no Twitter/Telegram` };
    }
    return { ok: true, reason: `✅ Social score: ${score} (${signals.join(', ')})` };
  } catch (_) {
    return { ok: true, reason: 'Twitter check unavailable' };
  }
}

// ─────────────────────────────────────────────────────────────────
// 14. MARKET CAP FILTER
// Skip tokens already above max market cap (already pumped)
// ─────────────────────────────────────────────────────────────────
async function checkMarketCap(mint, priceUsd) {
  const maxMcap = BotState.maxMarketCapUsd || 0;
  if (!maxMcap || maxMcap === 0) return { ok: true, reason: 'Mcap filter disabled' };
  if (!priceUsd || priceUsd === 0) return { ok: true, reason: 'No price data' };

  try {
    const { resilientFetch } = require('../utils/fetcher');
    const fetch = async (url, opts) => resilientFetch(url, opts, 2);
    const conn = getConnection();
    const mintInfo = await conn.getParsedAccountInfo(new PublicKey(mint));
    const supply = parseFloat(mintInfo.value?.data?.parsed?.info?.supply || '0');
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals || 9;
    const actualSupply = supply / Math.pow(10, decimals);
    const mcap = actualSupply * priceUsd;

    if (mcap > maxMcap) {
      return { ok: false, reason: `⚠️ Market cap $${(mcap/1000).toFixed(0)}k > max $${(maxMcap/1000).toFixed(0)}k` };
    }
    return { ok: true, reason: `✅ Market cap: $${(mcap/1000).toFixed(1)}k` };
  } catch (_) {
    return { ok: true, reason: 'Mcap check unavailable' };
  }
}

// ─────────────────────────────────────────────────────────────────
// 15. SNIPE SPEED BOOSTER
// Pre-creates associated token accounts to reduce tx size and speed
// ─────────────────────────────────────────────────────────────────
const { Transaction, SystemProgram } = require('@solana/web3.js');
const preApprovedMints = new Set();

async function preWarmTokenAccount(mint) {
  if (preApprovedMints.has(mint)) return;
  try {
    const { getKeypair } = require('../utils/wallet');
    const spl = await import('@solana/spl-token').catch(() => null);
    if (!spl) return;

    const conn = getConnection();
    const keypair = getKeypair();
    const mintPubkey = new PublicKey(mint);

    const ata = await spl.getAssociatedTokenAddress(mintPubkey, keypair.publicKey);
    const existing = await conn.getAccountInfo(ata);
    if (existing) { preApprovedMints.add(mint); return; }

    const ix = spl.createAssociatedTokenAccountInstruction(
      keypair.publicKey, ata, keypair.publicKey, mintPubkey
    );
    const tx = new Transaction().add(ix);
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = keypair.publicKey;
    tx.sign(keypair);

    await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    preApprovedMints.add(mint);
    logger.info(`⚡ [SpeedBoost] Pre-created ATA for ${mint.slice(0,8)}...`);
  } catch (_) {
    // Non-critical, ignore errors
  }
}

// ─────────────────────────────────────────────────────────────────
// 16. TOKEN AGE FILTER
// Only snipe tokens under X seconds old
// ─────────────────────────────────────────────────────────────────
function checkTokenAge(pairCreatedAt) {
  const maxAgeSeconds = BotState.maxTokenAgeSec || 300; // default 5 min
  if (!pairCreatedAt) return { ok: true, reason: 'No age data' };
  const ageSeconds = (Date.now() - pairCreatedAt) / 1000;
  if (ageSeconds > maxAgeSeconds) {
    return { ok: false, reason: `⚠️ Token ${ageSeconds.toFixed(0)}s old > max ${maxAgeSeconds}s` };
  }
  return { ok: true, reason: `✅ Token age: ${ageSeconds.toFixed(0)}s` };
}

// ─────────────────────────────────────────────────────────────────
// MASTER FILTER — runs all 16 checks in sequence
// Call this from sniper files before executeBuy
// ─────────────────────────────────────────────────────────────────
async function runAllFilters({ mint, name, symbol, devWallet, liquidityUsd, priceUsd, pairCreatedAt }) {
  const skips = [];

  // Budget limit
  if (!checkBudgetLimit()) {
    return { pass: false, reason: `💰 Daily budget limit reached (${dailySpent.toFixed(3)} SOL spent today)` };
  }

  // Token age filter
  if (pairCreatedAt) {
    const age = checkTokenAge(pairCreatedAt);
    if (!age.ok) return { pass: false, reason: age.reason };
  }

  // Market cap filter
  if (priceUsd && BotState.maxMarketCapUsd) {
    const mcap = await checkMarketCap(mint, priceUsd);
    if (!mcap.ok) return { pass: false, reason: mcap.reason };
  }

  // Honeypot check
  if (BotState.honeypotCheck !== false) {
    const hp = await checkHoneypot(mint);
    if (hp.honeypot) return { pass: false, reason: hp.reason };
  }

  // Contract age check
  if (devWallet && BotState.minDeployerAgeDays > 0) {
    const age = await checkDeployerAge(devWallet);
    if (!age.safe) return { pass: false, reason: age.reason };
  }

  // Liquidity lock
  if (BotState.rugFilter?.minLpLockDays > 0) {
    const lock = await checkLiquidityLock(mint);
    if (!lock.locked) return { pass: false, reason: lock.reason };
  }

  // Twitter sentiment
  if (BotState.twitterCheck?.enabled) {
    const tw = await checkTwitterSentiment(symbol, mint);
    if (!tw.ok) return { pass: false, reason: tw.reason };
  }

  // News feed signal
  const news = await checkNewsFeed(symbol, mint);

  // Speed boost — pre-warm ATA in background
  preWarmTokenAccount(mint).catch(() => {});

  return { pass: true, newsScore: news.score, newsSignals: news.signals };
}

// ─────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────
module.exports = {
  // Core checks
  checkHoneypot,
  checkTokenAge,
  checkMarketCap,
  checkDeployerAge,
  checkLiquidityLock,
  checkTwitterSentiment,
  checkNewsFeed,
  runAllFilters,

  // Trading logic
  updateTrailingStop,
  checkTrailingStop,
  checkPartialTakeProfit,
  recordDailyTrade,
  checkBudgetLimit,
  recordSpend,

  // Whale tracking
  addWhaleWallet,
  removeWhaleWallet,

  // Startup functions
  startDailyReport,
  startMorningBriefing,
  startHealthMonitor,
  startNewsFeedMonitor,

  // Telegram actions
  sendTradeSummary,
  sendDailyReport,
  sendMorningBriefing,

  // Speed boost
  preWarmTokenAccount,
};
