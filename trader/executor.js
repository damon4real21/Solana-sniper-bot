const { VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getConnection, getKeypair, getPublicKey, getTokenBalance } = require('../utils/wallet');
const { sendWithMevProtection } = require('../security/mev');
// telegram loaded lazily to avoid circular dep
const getTelegram = () => require('../bot/telegram');
const { BotState } = require('../utils/state');
const config = require('../config');
const logger = require('../utils/logger');
const { runAllFilters, recordSpend, recordDailyTrade, updateTrailingStop, checkTrailingStop, checkPartialTakeProfit } = require('../features/features16');

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

setInterval(monitorPositions, 15000);

async function executeBuy({ mint, name, symbol, source, devWallet, liquidityUsd = 0, priceUsd = 0, rugScore = 0 }) {
  // Route to spread buy if multi-wallet is enabled
  if (BotState.multiWallet.enabled && BotState.multiWallet.wallets.length > 0) {
    const { executeSpreadBuy } = require('../features/multiwallet');
    return executeSpreadBuy({ mint, name, symbol, source, rugScore });
  }

  const keypair = getKeypair();
  const pubkey = getPublicKey();
  const amountLamports = Math.floor(BotState.sniper.buyAmountSol * LAMPORTS_PER_SOL);

  // Run all 16 filters
  const filterResult = await runAllFilters({ mint, name, symbol, devWallet, liquidityUsd, priceUsd }).catch(() => ({ pass: true }));
  if (!filterResult.pass) {
    logger.warn(`[Filter] Skipped ${symbol}: ${filterResult.reason}`);
    await getTelegram().sendTelegramAlert(`🚫 *Filtered*
*${name}* (${symbol})
${filterResult.reason}`).catch(() => {});
    return null;
  }

  logger.trade(`BUY: ${symbol} | ${source} | ${BotState.sniper.buyAmountSol} SOL`);

  try {
    const fetch = (await import('node-fetch')).default;

    const quoteUrl = `${JUPITER_QUOTE_API}/quote?` + new URLSearchParams({
      inputMint: WSOL_MINT,
      outputMint: mint,
      amount: amountLamports,
      slippageBps: BotState.sniper.slippageBps,
      onlyDirectRoutes: 'false',
    });

    let quoteRes, quoteAttempts = 0;
    while (quoteAttempts < 3) {
      try { quoteRes = await fetch(quoteUrl, { timeout: 8000 }); break; }
      catch(e) { quoteAttempts++; if(quoteAttempts >= 3) throw e; await new Promise(r=>setTimeout(r,2000)); }
    }
    if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status}`);
    const quote = await quoteRes.json();
    if (quote.error) throw new Error(quote.error);

    const priceImpact = parseFloat(quote.priceImpactPct || '0');
    if (priceImpact > BotState.sniper.maxPriceImpact) throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}%`);

    const outAmount = parseInt(quote.outAmount || '0');

    const swapRes = await fetch(`${JUPITER_QUOTE_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: pubkey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: BotState.sniper.priorityFeeLamports,
      }),
      timeout: 10000,
    });

    const swapData = await swapRes.json();
    if (swapData.error) throw new Error(swapData.error);

    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    tx.sign([keypair]);

    const sig = await sendWithMevProtection(tx);
    const buyPrice = priceUsd || (BotState.sniper.buyAmountSol / (outAmount / 1e9));

    BotState.addPosition(mint, { mint, name, symbol, source, buyPrice, buySol: BotState.sniper.buyAmountSol, outAmount, sig, rugScore, devWallet });

    // Auto-start dev tracker if we have dev wallet
    if (devWallet) {
      const { trackDevWallet } = require('../features/devtracker');
      trackDevWallet(mint, devWallet).catch(() => {});
    }

    BotState.stats.sniped++;
    recordSpend(BotState.sniper.buyAmountSol);

    await getTelegram().sendTelegramAlert(
      `✅ *SNIPED!*\n` +
      `*${name}* (${symbol})\n` +
      `Source: ${source}\n` +
      `Spent: ${BotState.sniper.buyAmountSol} SOL\n` +
      `Got: ${(outAmount / 1e9).toFixed(4)} tokens\n` +
      `Impact: ${priceImpact.toFixed(2)}% | Rug: ${rugScore}/100\n` +
      `TX: [View](https://solscan.io/tx/${sig})`
    );

    logger.trade(`✅ BUY OK: ${symbol} | ${sig?.slice(0, 12)}...`);
    return sig;
  } catch (err) {
    logger.error(`BUY failed (${symbol}):`, err.message);
    await getTelegram().sendTelegramAlert(`❌ *Buy Failed*\n*${name}* (${symbol})\n${err.message}`);
    return null;
  }
}

async function executeSell(mint, reason = 'Manual') {
  const position = BotState.positions.get(mint);
  if (!position) return;

  const keypair = getKeypair();
  const pubkey = getPublicKey();

  try {
    const fetch = (await import('node-fetch')).default;
    const tokenBal = await getTokenBalance(mint);
    if (tokenBal <= 0) { BotState.removePosition(mint); return; }

    const tokenBalRaw = Math.floor(tokenBal * 1e9);

    const quoteUrl = `${JUPITER_QUOTE_API}/quote?` + new URLSearchParams({
      inputMint: mint,
      outputMint: WSOL_MINT,
      amount: tokenBalRaw,
      slippageBps: BotState.sniper.slippageBps + 200,
    });

    const quote = await (await fetch(quoteUrl, { timeout: 8000 })).json();
    if (quote.error) throw new Error(quote.error);

    const swapData = await (await fetch(`${JUPITER_QUOTE_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: pubkey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: BotState.sniper.priorityFeeLamports,
      }),
      timeout: 10000,
    })).json();

    if (swapData.error) throw new Error(swapData.error);

    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    tx.sign([keypair]);
    const sig = await sendWithMevProtection(tx);

    const receivedSol = parseInt(quote.outAmount || '0') / LAMPORTS_PER_SOL;
    const pnlSol = receivedSol - position.buySol;
    const pnlPct = ((pnlSol / position.buySol) * 100).toFixed(1);
    const emoji = pnlSol >= 0 ? '🟢' : '🔴';

    recordDailyTrade({ mint, name: position.name, symbol: position.symbol, pnlSol, ts: Date.now() });
    BotState.addTrade({ mint, name: position.name, symbol: position.symbol, pnlSol, pnlPct, reason, sig, ts: Date.now() });
    BotState.removePosition(mint);

    // Stop dev tracker for this mint
    const { stopTrackingMint } = require('../features/devtracker');
    stopTrackingMint(mint);

    await getTelegram().sendTelegramAlert(
      `${emoji} *SOLD!*\n` +
      `*${position.name}* (${position.symbol})\n` +
      `Reason: ${reason}\n` +
      `Received: ${receivedSol.toFixed(4)} SOL\n` +
      `P&L: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct}%)\n` +
      `TX: [View](https://solscan.io/tx/${sig})`
    );

    logger.trade(`SELL ${position.symbol} | ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL | ${reason}`);
  } catch (err) {
    logger.error(`SELL failed (${mint?.slice(0, 8)}):`, err.message);
    await getTelegram().sendTelegramAlert(`❌ *Sell Failed*\n\`${mint?.slice(0, 12)}...\`\n${err.message}`);
  }
}

async function monitorPositions() {
  if (!BotState.autoSell?.enabled || BotState.positions.size === 0) return;
  const fetch = (await import('node-fetch')).default;

  for (const [mint, pos] of BotState.positions.entries()) {
    // Skip sub-wallet composite keys
    if (mint.includes(':')) continue;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 5000 });
      const data = await res.json();
      const pair = (data?.pairs || [])[0];
      if (!pair) continue;

      const currentPrice = parseFloat(pair.priceUsd || '0');
      if (!currentPrice || !pos.buyPrice) continue;

      const multiple = currentPrice / pos.buyPrice;
      const dropPct = ((pos.buyPrice - currentPrice) / pos.buyPrice) * 100;

      // Update trailing stop peak
      updateTrailingStop(mint, currentPrice);

      // Partial take profit
      if (BotState.partialTP?.enabled) {
        const partial = await checkPartialTakeProfit(mint, currentPrice, pos.buyPrice);
        if (partial?.shouldSell) {
          logger.trade(`🎯 Partial TP stage: sell ${partial.pct}% at ${partial.multiple}x`);
          await getTelegram().sendTelegramAlert(`🎯 *Partial Take Profit!*
*${pos.symbol}* hit ${partial.multiple}x
Selling ${partial.pct}% of position`).catch(()=>{});
          await executeSell(mint, `Partial TP ${partial.multiple}x (${partial.pct}%)`);
          continue;
        }
      }

      // Trailing stop loss
      if (BotState.trailingStopPct > 0 && checkTrailingStop(mint, currentPrice)) {
        await executeSell(mint, `Trailing Stop -${BotState.trailingStopPct}% from peak`);
        continue;
      }

      if (multiple >= BotState.autoSell.takeProfitMultiplier) {
        await executeSell(mint, `Take Profit ${multiple.toFixed(2)}x`);
      } else if (dropPct >= BotState.autoSell.stopLossPct) {
        await executeSell(mint, `Stop Loss -${dropPct.toFixed(1)}%`);
      }
    } catch (_) {}
  }
}

module.exports = { executeBuy, executeSell };
