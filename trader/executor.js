const { VersionedTransaction, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getConnection, getKeypair, getPublicKey, getTokenBalance } = require('../utils/wallet');
const { sendWithMevProtection } = require('../security/mev');
const { BotState } = require('../utils/state');
const { resilientFetch, getJupiterBase } = require('../utils/fetcher');
const logger = require('../utils/logger');

const getTelegram = () => require('../bot/telegram');
const getFeatures = () => require('../features/features16');

const WSOL = 'So11111111111111111111111111111111111111112';

// Monitor positions every 15s
setInterval(monitorPositions, 15000);

// ─────────────────────────────────────────────────────────────────
// DETECT TOKEN TYPE
// ─────────────────────────────────────────────────────────────────
function isPumpFunToken(mint, source) {
  return (
    mint?.endsWith('pump') ||
    source?.toLowerCase().includes('pump.fun') ||
    source?.toLowerCase().includes('pumpfun') ||
    source?.toLowerCase().includes('soon migrated') ||
    source?.toLowerCase().includes('migrated')
  );
}

// ─────────────────────────────────────────────────────────────────
// MAIN BUY ENTRY POINT
// ─────────────────────────────────────────────────────────────────
async function executeBuy({ mint, name, symbol, source, devWallet, liquidityUsd = 0, priceUsd = 0, rugScore = 0 }) {

  // Multi-wallet spread
  if (BotState.multiWallet?.enabled && BotState.multiWallet.wallets?.length > 0) {
    const { executeSpreadBuy } = require('../features/multiwallet');
    return executeSpreadBuy({ mint, name, symbol, source, rugScore });
  }

  // Run filters (skip liquidity check for migrations)
  try {
    const { runAllFilters, recordSpend } = getFeatures();
    const isMigration = source?.includes('Migrated');
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
  const usePumpSwap = isPumpFunToken(mint, source);

  logger.trade(`BUY: ${symbol} | ${source} | ${BotState.sniper.buyAmountSol} SOL | router: ${usePumpSwap ? 'PumpSwap' : 'Jupiter'}`);

  // Pre-buy Telegram alert
  await getTelegram().sendTelegramAlert(
    `⚡ *Attempting Buy...*\n\n` +
    `*${name}* (${symbol})\n` +
    `Source: ${source}\n` +
    `Spending: *${BotState.sniper.buyAmountSol} SOL*\n` +
    `Router: ${usePumpSwap ? '🟣 PumpSwap' : '🔵 Jupiter'}\n\n` +
    `📋 *CA:*\n\`${mint}\`\n\n` +
    `🔗 [DexScreener](https://dexscreener.com/solana/${mint}) | [pump.fun](https://pump.fun/${mint})\n` +
    `Rug: ${rugScore}/100 | Liq: $${liquidityUsd.toFixed(0)}\n` +
    `_Processing..._`
  ).catch(() => {});

  // Route to correct swap
  let sig = null;
  if (usePumpSwap) {
    sig = await swapOnPump(mint, amountLamports, keypair, name, symbol);
  } else {
    sig = await swapOnJupiter(mint, amountLamports, keypair, pubkey, name, symbol, priceUsd, rugScore, source);
  }

  if (!sig) return null;

  // Record position
  BotState.addPosition(mint, {
    mint, name, symbol, source,
    buyPrice: priceUsd || BotState.sniper.buyAmountSol,
    buySol: BotState.sniper.buyAmountSol,
    sig, rugScore, devWallet,
  });
  BotState.stats.sniped++;
  try { getFeatures().recordSpend(BotState.sniper.buyAmountSol); } catch (_) {}
  if (devWallet) {
    try { const { trackDevWallet } = require('../features/devtracker'); trackDevWallet(mint, devWallet); } catch (_) {}
  }

  await getTelegram().sendTelegramAlert(
    `✅ *SNIPED!*\n` +
    `*${name}* (${symbol})\n` +
    `Source: ${source}\n` +
    `Spent: ${BotState.sniper.buyAmountSol} SOL\n` +
    `Rug: ${rugScore}/100\n` +
    `TX: [View](https://solscan.io/tx/${sig})`
  ).catch(() => {});

  return sig;
}

// ─────────────────────────────────────────────────────────────────
// PUMP.FUN SWAP — for all pump.fun bonding curve tokens
// Uses pumpportal.fun API — completely separate from Jupiter
// ─────────────────────────────────────────────────────────────────
async function swapOnPump(mint, amountLamports, keypair, name, symbol) {
  const conn = getConnection();
  const solAmount = amountLamports / LAMPORTS_PER_SOL;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const slippage = Math.min(25 * attempt, 50); // 25%, 50%, 50%
    const priorityFee = (BotState.sniper.priorityFeeLamports / LAMPORTS_PER_SOL) * attempt;

    logger.info(`[PumpSwap] Attempt ${attempt}/3 | SOL: ${solAmount} | Slip: ${slippage}% | Fee: ${priorityFee}`);

    try {
      const res = await resilientFetch('https://pumpportal.fun/api/trade-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: keypair.publicKey.toString(),
          action: 'buy',
          mint: mint,
          denominatedInSol: 'true',
          amount: solAmount,
          slippage: slippage,
          priorityFee: priorityFee,
          pool: 'pump',
        }),
      }, 2);

      if (!res.ok) {
        const errText = await res.text().catch(() => res.status);
        logger.warn(`[PumpSwap] API error ${res.status}: ${errText}`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const txBuf = Buffer.from(await res.arrayBuffer());
      if (txBuf.length < 10) {
        logger.warn(`[PumpSwap] Empty response — token may not be on bonding curve`);
        continue;
      }

      // Deserialize transaction
      let tx;
      try {
        tx = VersionedTransaction.deserialize(txBuf);
        tx.sign([keypair]);
      } catch (_) {
        try {
          tx = Transaction.from(txBuf);
          tx.sign(keypair);
        } catch (e) {
          logger.warn(`[PumpSwap] TX deserialize failed: ${e.message}`);
          continue;
        }
      }

      // Send with skipPreflight — critical for bonding curve tokens
      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 0,
      });

      logger.info(`[PumpSwap] TX sent: ${sig.slice(0, 12)}... confirming...`);

      // Confirm with 30s timeout
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const result = await Promise.race([
        conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('30s timeout')), 30000)),
      ]);

      if (result?.value?.err) {
        logger.warn(`[PumpSwap] On-chain error: ${JSON.stringify(result.value.err)}`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      logger.trade(`✅ [PumpSwap] Success: ${sig.slice(0, 12)}...`);
      return sig;

    } catch (err) {
      logger.warn(`[PumpSwap] Attempt ${attempt} failed: ${err.message?.slice(0, 100)}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  logger.error(`[PumpSwap] All attempts failed for ${symbol}`);
  await getTelegram().sendTelegramAlert(
    `❌ *PumpSwap Failed*\n*${name}* (${symbol})\n` +
    `Token may have already graduated or bonding curve full\n` +
    `[Check manually](https://pump.fun/${mint})`
  ).catch(() => {});
  return null;
}

// ─────────────────────────────────────────────────────────────────
// JUPITER SWAP — for Raydium and DexScreener tokens ONLY
// ─────────────────────────────────────────────────────────────────
async function swapOnJupiter(mint, amountLamports, keypair, pubkey, name, symbol, priceUsd, rugScore, source) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const slippage = BotState.sniper.slippageBps * attempt; // increase per retry
    const priorityFee = BotState.sniper.priorityFeeLamports * attempt;

    logger.info(`[Jupiter] Attempt ${attempt}/3 | Slip: ${slippage / 100}% | Fee: ${priorityFee}`);

    try {
      const jupBase = getJupiterBase();

      const quoteUrl = `${jupBase}/quote?` + new URLSearchParams({
        inputMint: WSOL,
        outputMint: mint,
        amount: amountLamports,
        slippageBps: slippage,
        onlyDirectRoutes: 'false',
      });

      const quoteRes = await resilientFetch(quoteUrl, {}, 2);
      if (!quoteRes.ok) { await new Promise(r => setTimeout(r, 2000)); continue; }
      const quote = await quoteRes.json();
      if (quote.error) { logger.warn(`[Jupiter] Quote error: ${quote.error}`); continue; }

      const impact = parseFloat(quote.priceImpactPct || '0');
      if (impact > BotState.sniper.maxPriceImpact) {
        logger.warn(`[Jupiter] Price impact too high: ${impact.toFixed(2)}%`);
        break;
      }

      const swapRes = await resilientFetch(`${jupBase}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: pubkey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: priorityFee,
        }),
      }, 2);

      const swapData = await swapRes.json();
      if (swapData.error) { logger.warn(`[Jupiter] Swap error: ${swapData.error}`); continue; }

      const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      tx.sign([keypair]);
      const sig = await sendWithMevProtection(tx);

      logger.trade(`✅ [Jupiter] Success: ${sig?.slice(0, 12)}...`);
      return sig;

    } catch (err) {
      logger.warn(`[Jupiter] Attempt ${attempt} failed: ${err.message?.slice(0, 100)}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  logger.error(`[Jupiter] All attempts failed for ${symbol}`);
  await getTelegram().sendTelegramAlert(
    `❌ *Jupiter Swap Failed*\n*${name}* (${symbol})\n` +
    `Try checking token on DexScreener`
  ).catch(() => {});
  return null;
}

// ─────────────────────────────────────────────────────────────────
// SELL — always uses Jupiter (selling back to SOL)
// ─────────────────────────────────────────────────────────────────
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

    // For pump.fun tokens that haven't graduated — use pump sell
    const usePumpSell = isPumpFunToken(mint, position.source);
    let sig;

    if (usePumpSell) {
      sig = await sellOnPump(mint, tokenBalRaw, keypair, position);
    }

    if (!sig) {
      // Fall back to Jupiter sell for all tokens
      const quoteUrl = `${jupBase}/quote?` + new URLSearchParams({
        inputMint: mint,
        outputMint: WSOL,
        amount: tokenBalRaw,
        slippageBps: BotState.sniper.slippageBps + 500,
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
          prioritizationFeeLamports: BotState.sniper.priorityFeeLamports * 2,
        }),
      }, 3)).json();

      if (swapData.error) throw new Error(swapData.error);
      const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      tx.sign([keypair]);
      sig = await sendWithMevProtection(tx);
    }

    const receivedSol = parseInt(sig?.outAmount || '0') / LAMPORTS_PER_SOL || BotState.sniper.buyAmountSol;
    const pnlSol = receivedSol - position.buySol;
    const pnlPct = ((pnlSol / position.buySol) * 100).toFixed(1);
    const emoji = pnlSol >= 0 ? '🟢' : '🔴';

    try { getFeatures().recordDailyTrade({ mint, name: position.name, symbol: position.symbol, pnlSol, ts: Date.now() }); } catch (_) {}
    BotState.addTrade({ mint, name: position.name, symbol: position.symbol, pnlSol, pnlPct, reason, sig, ts: Date.now() });
    BotState.removePosition(mint);
    try { const { stopTrackingMint } = require('../features/devtracker'); stopTrackingMint(mint); } catch (_) {}

    await getTelegram().sendTelegramAlert(
      `${emoji} *SOLD!*\n*${position.name}* (${position.symbol})\n` +
      `Reason: ${reason}\n` +
      `P&L: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct}%)\n` +
      `TX: [View](https://solscan.io/tx/${sig})`
    ).catch(() => {});

  } catch (err) {
    logger.error(`SELL failed (${mint?.slice(0, 8)}):`, err.message);
    await getTelegram().sendTelegramAlert(`❌ *Sell Failed*\n\`${mint?.slice(0, 12)}...\`\n${err.message?.slice(0, 100)}`).catch(() => {});
  }
}

// Pump.fun sell
async function sellOnPump(mint, tokenAmount, keypair, position) {
  try {
    const conn = getConnection();
    const res = await resilientFetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: keypair.publicKey.toString(),
        action: 'sell',
        mint: mint,
        denominatedInSol: 'false',
        amount: tokenAmount,
        slippage: 25,
        priorityFee: BotState.sniper.priorityFeeLamports / LAMPORTS_PER_SOL,
        pool: 'pump',
      }),
    }, 2);

    if (!res.ok) return null;
    const txBuf = Buffer.from(await res.arrayBuffer());
    if (txBuf.length < 10) return null;

    let tx;
    try { tx = VersionedTransaction.deserialize(txBuf); tx.sign([keypair]); }
    catch (_) { tx = Transaction.from(txBuf); tx.sign(keypair); }

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────
// POSITION MONITOR
// ─────────────────────────────────────────────────────────────────
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

      try {
        const { updateTrailingStop, checkTrailingStop, checkPartialTakeProfit } = getFeatures();
        updateTrailingStop(mint, currentPrice);

        if (BotState.partialTP?.enabled) {
          const partial = await checkPartialTakeProfit(mint, currentPrice, pos.buyPrice);
          if (partial?.shouldSell) {
            await getTelegram().sendTelegramAlert(`🎯 *Partial TP!*\n*${pos.symbol}* hit ${partial.multiple}x\nSelling ${partial.pct}%`).catch(() => {});
            await executeSell(mint, `Partial TP ${partial.multiple}x`);
            continue;
          }
        }

        if (BotState.trailingStopPct > 0 && checkTrailingStop(mint, currentPrice)) {
          await executeSell(mint, `Trailing Stop -${BotState.trailingStopPct}%`);
          continue;
        }
      } catch (_) {}

      if (multiple >= BotState.autoSell.takeProfitMultiplier) {
        await executeSell(mint, `Take Profit ${multiple.toFixed(2)}x`);
      } else if (dropPct >= BotState.autoSell.stopLossPct) {
        await executeSell(mint, `Stop Loss -${dropPct.toFixed(1)}%`);
      }
    } catch (_) {}
  }
}

module.exports = { executeBuy, executeSell };
