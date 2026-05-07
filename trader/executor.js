const { VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getConnection, getKeypair, getPublicKey, getTokenBalance } = require('../utils/wallet');
const { sendWithMevProtection } = require('../security/mev');
const { BotState } = require('../utils/state');
const { resilientFetch, getJupiterBase } = require('../utils/fetcher');
const logger = require('../utils/logger');

const getTelegram = () => require('../bot/telegram');
const getFeatures = () => require('../features/features16');

const WSOL = 'So11111111111111111111111111111111111111112';

// Position monitor every 15s
setInterval(monitorPositions, 15000);

async function executeBuy({ mint, name, symbol, source, devWallet, liquidityUsd = 0, priceUsd = 0, rugScore = 0 }) {
  // Multi-wallet spread
  if (BotState.multiWallet?.enabled && BotState.multiWallet.wallets?.length > 0) {
    const { executeSpreadBuy } = require('../features/multiwallet');
    return executeSpreadBuy({ mint, name, symbol, source, rugScore });
  }

  // Run all 16 filters — but skip liquidity filter for confirmed migrations
  try {
    const { runAllFilters, recordSpend } = getFeatures();
    const isMigration = source?.includes('Migrated') || source?.includes('Migration');
    // For migrations, graduation guarantees ~$69k liquidity — bypass min liq filter
    const effectiveLiquidity = isMigration && liquidityUsd < 1000 ? 69000 : liquidityUsd;
    const filterResult = await runAllFilters({ mint, name, symbol, devWallet, liquidityUsd: effectiveLiquidity, priceUsd }).catch(() => ({ pass: true }));
    if (!filterResult.pass) {
      logger.warn(`[Filter] Skipped ${symbol}: ${filterResult.reason}`);
      await getTelegram().sendTelegramAlert(`🚫 *Filtered*\n*${name}* (${symbol})\n${filterResult.reason}`).catch(() => {});
      return null;
    }
  } catch (_) {}

  const keypair = getKeypair();
  const pubkey = getPublicKey();
  const amountLamports = Math.floor(BotState.sniper.buyAmountSol * LAMPORTS_PER_SOL);

  // Detect if token is still on pump.fun AMM (CA ends with 'pump')
  const isPumpFunToken = mint.endsWith('pump') || source?.toLowerCase().includes('pump');
  
  logger.trade(`BUY: ${symbol} | ${source} | ${BotState.sniper.buyAmountSol} SOL | pump:${isPumpFunToken}`);

  // 🔔 Pre-buy alert with full CA details
  await getTelegram().sendTelegramAlert(
    `⚡ *Attempting Buy...*\n\n` +
    `*${name}* (${symbol})\n` +
    `Source: ${source}\n` +
    `Spending: *${BotState.sniper.buyAmountSol} SOL*\n\n` +
    `📋 *Contract Address (CA):*\n` +
    `\`${mint}\`\n\n` +
    `🔗 [DexScreener](https://dexscreener.com/solana/${mint}) | [Solscan](https://solscan.io/token/${mint})\n` +
    `[pump.fun](https://pump.fun/${mint}) | [Birdeye](https://birdeye.so/token/${mint})\n\n` +
    `Rug Score: ${rugScore}/100 | Liq: $${liquidityUsd.toFixed(0)}\n` +
    `_Processing swap..._`
  ).catch(() => {});

  try {
    // For pump.fun tokens use their native swap API
    if (isPumpFunToken) {
      logger.info('[Executor] Token is on pump.fun AMM — using pump.fun swap');
      const pfResult = await buyOnPumpFun(mint, amountLamports, keypair);
      if (pfResult) return pfResult;
      logger.warn('[Executor] pump.fun swap failed — falling back to Jupiter');
    }

    const jupBase = getJupiterBase();
    const quoteUrl = `${jupBase}/quote?` + new URLSearchParams({
      inputMint: WSOL,
      outputMint: mint,
      amount: amountLamports,
      slippageBps: BotState.sniper.slippageBps,
      onlyDirectRoutes: 'false',
    });

    // Resilient fetch with auto-retry + endpoint rotation
    const quoteRes = await resilientFetch(quoteUrl, {}, 3);
    if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status}`);
    const quote = await quoteRes.json();
    if (quote.error) throw new Error(quote.error);

    const priceImpact = parseFloat(quote.priceImpactPct || '0');
    if (priceImpact > BotState.sniper.maxPriceImpact) throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}%`);
    const outAmount = parseInt(quote.outAmount || '0');

    const swapRes = await resilientFetch(`${jupBase}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: pubkey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: BotState.sniper.priorityFeeLamports,
      }),
    }, 3);

    const swapData = await swapRes.json();
    if (swapData.error) throw new Error(swapData.error);

    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    tx.sign([keypair]);
    const sig = await sendWithMevProtection(tx);

    const buyPrice = priceUsd || (BotState.sniper.buyAmountSol / (outAmount / 1e9));
    BotState.addPosition(mint, { mint, name, symbol, source, buyPrice, buySol: BotState.sniper.buyAmountSol, outAmount, sig, rugScore, devWallet });
    BotState.stats.sniped++;

    // Record spend for budget tracking
    try { getFeatures().recordSpend(BotState.sniper.buyAmountSol); } catch (_) {}

    // Start dev tracker
    if (devWallet) {
      try { const { trackDevWallet } = require('../features/devtracker'); trackDevWallet(mint, devWallet); } catch (_) {}
    }

    await getTelegram().sendTelegramAlert(
      `✅ *SNIPED!*\n*${name}* (${symbol})\nSource: ${source}\n` +
      `Spent: ${BotState.sniper.buyAmountSol} SOL\nGot: ${(outAmount/1e9).toFixed(4)} tokens\n` +
      `Impact: ${priceImpact.toFixed(2)}% | Rug: ${rugScore}/100\n` +
      `TX: [View](https://solscan.io/tx/${sig})`
    ).catch(() => {});

    logger.trade(`✅ BUY OK: ${symbol} | ${sig?.slice(0,12)}...`);
    return sig;
  } catch (err) {
    logger.error(`BUY failed (${symbol}):`, err.message);
    await getTelegram().sendTelegramAlert(`❌ *Buy Failed*\n*${name}* (${symbol})\n${err.message}`).catch(() => {});
    return null;
  }
}

async function executeSell(mint, reason = 'Manual') {
  const position = BotState.positions.get(mint);
  if (!position) return;

  const keypair = getKeypair();
  const pubkey = getPublicKey();

  try {
    const tokenBal = await getTokenBalance(mint);
    if (tokenBal <= 0) { BotState.removePosition(mint); return; }

    const tokenBalRaw = Math.floor(tokenBal * 1e9);
    const jupBase = getJupiterBase();

    const quoteUrl = `${jupBase}/quote?` + new URLSearchParams({
      inputMint: mint, outputMint: WSOL,
      amount: tokenBalRaw,
      slippageBps: BotState.sniper.slippageBps + 200,
    });

    const quote = await (await resilientFetch(quoteUrl, {}, 3)).json();
    if (quote.error) throw new Error(quote.error);

    const swapData = await (await resilientFetch(`${jupBase}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: pubkey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: BotState.sniper.priorityFeeLamports,
      }),
    }, 3)).json();

    if (swapData.error) throw new Error(swapData.error);

    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    tx.sign([keypair]);
    const sig = await sendWithMevProtection(tx);

    const receivedSol = parseInt(quote.outAmount || '0') / LAMPORTS_PER_SOL;
    const pnlSol = receivedSol - position.buySol;
    const pnlPct = ((pnlSol / position.buySol) * 100).toFixed(1);
    const emoji = pnlSol >= 0 ? '🟢' : '🔴';

    // Record daily trade
    try { getFeatures().recordDailyTrade({ mint, name: position.name, symbol: position.symbol, pnlSol, ts: Date.now() }); } catch (_) {}

    BotState.addTrade({ mint, name: position.name, symbol: position.symbol, pnlSol, pnlPct, reason, sig, ts: Date.now() });
    BotState.removePosition(mint);

    // Stop dev tracker
    try { const { stopTrackingMint } = require('../features/devtracker'); stopTrackingMint(mint); } catch (_) {}

    await getTelegram().sendTelegramAlert(
      `${emoji} *SOLD!*\n*${position.name}* (${position.symbol})\n` +
      `Reason: ${reason}\nReceived: ${receivedSol.toFixed(4)} SOL\n` +
      `P&L: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct}%)\n` +
      `TX: [View](https://solscan.io/tx/${sig})`
    ).catch(() => {});

    logger.trade(`SELL ${position.symbol} | ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL | ${reason}`);
  } catch (err) {
    logger.error(`SELL failed (${mint?.slice(0,8)}):`, err.message);
    await getTelegram().sendTelegramAlert(`❌ *Sell Failed*\n\`${mint?.slice(0,12)}...\`\n${err.message}`).catch(() => {});
  }
}

async function monitorPositions() {
  if (!BotState.autoSell?.enabled || BotState.positions.size === 0) return;

  for (const [mint, pos] of BotState.positions.entries()) {
    if (mint.includes(':')) continue;
    try {
      const res = await resilientFetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, 2);
      const data = await res.json();
      const pair = (data?.pairs || [])[0];
      if (!pair) continue;

      const currentPrice = parseFloat(pair.priceUsd || '0');
      if (!currentPrice || !pos.buyPrice) continue;

      const multiple = currentPrice / pos.buyPrice;
      const dropPct = ((pos.buyPrice - currentPrice) / pos.buyPrice) * 100;

      // Update trailing stop peak
      try {
        const { updateTrailingStop, checkTrailingStop, checkPartialTakeProfit } = getFeatures();
        updateTrailingStop(mint, currentPrice);

        // Partial take profit
        if (BotState.partialTP?.enabled) {
          const partial = await checkPartialTakeProfit(mint, currentPrice, pos.buyPrice);
          if (partial?.shouldSell) {
            await getTelegram().sendTelegramAlert(`🎯 *Partial TP!*\n*${pos.symbol}* hit ${partial.multiple}x\nSelling ${partial.pct}%`).catch(() => {});
            await executeSell(mint, `Partial TP ${partial.multiple}x (${partial.pct}%)`);
            continue;
          }
        }

        // Trailing stop
        if (BotState.trailingStopPct > 0 && checkTrailingStop(mint, currentPrice)) {
          await executeSell(mint, `Trailing Stop -${BotState.trailingStopPct}% from peak`);
          continue;
        }
      } catch (_) {}

      // Fixed take profit
      if (multiple >= BotState.autoSell.takeProfitMultiplier) {
        await executeSell(mint, `Take Profit ${multiple.toFixed(2)}x`);
      } else if (dropPct >= BotState.autoSell.stopLossPct) {
        await executeSell(mint, `Stop Loss -${dropPct.toFixed(1)}%`);
      }
    } catch (_) {}
  }
}

// ── pump.fun native swap ──────────────────────────────────────────
async function buyOnPumpFun(mint, amountLamports, keypair) {
  try {
    const { Connection, Transaction, SystemProgram, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
    const conn = getConnection();

    // Get pump.fun bonding curve data
    const pfRes = await resilientFetch(
      `https://frontend-api.pump.fun/coins/${mint}`,
      { headers: { 'Accept': 'application/json' }, timeout: 8000 }, 2
    );
    if (!pfRes.ok) return null;
    const pfData = await pfRes.json();

    if (!pfData.bonding_curve) return null;

    // Use pump.fun trade API
    const tradeRes = await resilientFetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: keypair.publicKey.toString(),
        action: 'buy',
        mint: mint,
        denominatedInSol: 'true',
        amount: amountLamports / LAMPORTS_PER_SOL,
        slippage: BotState.sniper.slippageBps / 100,
        priorityFee: BotState.sniper.priorityFeeLamports / LAMPORTS_PER_SOL,
        pool: 'pump',
      }),
    }, 2);

    if (!tradeRes.ok) return null;
    const txBuf = Buffer.from(await tradeRes.arrayBuffer());
    const tx = Transaction.from(txBuf);
    tx.sign(keypair);

    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false, maxRetries: 3,
    });
    await conn.confirmTransaction(sig, 'confirmed');
    logger.success(`[pump.fun swap] TX: ${sig.slice(0,12)}...`);
    return sig;
  } catch (err) {
    logger.error('[pump.fun swap] Error:', err.message);
    return null;
  }
}

module.exports = { executeBuy, executeSell };
