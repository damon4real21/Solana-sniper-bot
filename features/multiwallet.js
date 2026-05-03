const { Keypair, VersionedTransaction, LAMPORTS_PER_SOL, Connection } = require('@solana/web3.js');
const bs58 = require('bs58');
const { getConnection } = require('../utils/wallet');
const { sendWithMevProtection } = require('../security/mev');
const { BotState } = require('../utils/state');
const { sendTelegramAlert } = require('../bot/telegram');
const config = require('../config');
const logger = require('../utils/logger');

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Execute a spread buy across all configured sub-wallets.
 * Each wallet buys a fraction of the total amount independently.
 */
async function executeSpreadBuy({ mint, name, symbol, source, rugScore = 0 }) {
  const wallets = BotState.multiWallet.wallets;

  if (!wallets || wallets.length === 0) {
    logger.warn('No sub-wallets configured for spread. Falling back to primary wallet.');
    const { executeBuy } = require('../trader/executor');
    return executeBuy({ mint, name, symbol, source, rugScore });
  }

  const perWalletSol = BotState.multiWallet.perWalletSol || (config.sniper.buyAmountSol / wallets.length);
  const amountLamports = Math.floor(perWalletSol * LAMPORTS_PER_SOL);

  logger.trade(`🔀 Spread buy: ${symbol} across ${wallets.length} wallets (${perWalletSol} SOL each)`);

  await sendTelegramAlert(
    `🔀 *Spread Buy Starting*\n` +
    `Token: *${name}* (${symbol})\n` +
    `Wallets: ${wallets.length}\n` +
    `Per wallet: ${perWalletSol} SOL\n` +
    `Total: ${(perWalletSol * wallets.length).toFixed(4)} SOL`
  );

  const results = [];
  const fetch = (await import('node-fetch')).default;

  // Stagger each buy by 1-3 seconds to avoid pattern detection
  for (let i = 0; i < wallets.length; i++) {
    const walletEntry = wallets[i];
    if (i > 0) {
      const delay = 1000 + Math.random() * 2000;
      await sleep(delay);
    }

    try {
      const keypair = getKeypairFromEntry(walletEntry);

      // Get quote
      const quoteUrl = `${JUPITER_QUOTE_API}/quote?` + new URLSearchParams({
        inputMint: WSOL_MINT,
        outputMint: mint,
        amount: amountLamports,
        slippageBps: config.sniper.slippageBps,
      });

      const quoteRes = await fetch(quoteUrl, { timeout: 8000 });
      if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status}`);
      const quote = await quoteRes.json();
      if (quote.error) throw new Error(quote.error);

      // Build swap tx
      const swapRes = await fetch(`${JUPITER_QUOTE_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: keypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: config.sniper.priorityFeeLamports,
        }),
        timeout: 10000,
      });

      const swapData = await swapRes.json();
      if (swapData.error) throw new Error(swapData.error);

      const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([keypair]);

      // Send directly (each wallet signs its own tx)
      const conn = getConnection();
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

      const outAmount = parseInt(quote.outAmount || '0');
      results.push({ wallet: keypair.publicKey.toString(), sig, outAmount, success: true });
      logger.trade(`✅ Wallet ${i + 1}/${wallets.length} bought — sig: ${sig.slice(0, 12)}...`);

      // Track position per sub-wallet
      const subKey = `${mint}:${keypair.publicKey.toString().slice(0, 8)}`;
      BotState.positions.set(subKey, {
        mint, name, symbol, source,
        buyPrice: perWalletSol / (outAmount / 1e9),
        buySol: perWalletSol,
        outAmount, sig, rugScore,
        subWallet: keypair.publicKey.toString(),
        buyTime: Date.now(),
      });

    } catch (err) {
      logger.error(`Wallet ${i + 1} spread buy failed:`, err.message);
      results.push({ wallet: walletEntry.address, sig: null, success: false, error: err.message });
    }
  }

  const successes = results.filter(r => r.success).length;
  const totalOut = results.reduce((sum, r) => sum + (r.outAmount || 0), 0);

  await sendTelegramAlert(
    `✅ *Spread Buy Complete*\n` +
    `Token: *${name}* (${symbol})\n` +
    `Success: ${successes}/${wallets.length} wallets\n` +
    `Total received: ${(totalOut / 1e9).toFixed(4)} tokens\n` +
    results.map((r, i) =>
      r.success
        ? `  W${i + 1}: ✅ [tx](https://solscan.io/tx/${r.sig})`
        : `  W${i + 1}: ❌ ${r.error?.slice(0, 30)}`
    ).join('\n')
  );

  return results;
}

/**
 * Sell all positions for a token across all sub-wallets.
 */
async function executeSpreadSell(mint, reason = 'Manual') {
  const wallets = BotState.multiWallet.wallets;
  if (!wallets?.length) return;

  const fetch = (await import('node-fetch')).default;
  const conn = getConnection();

  for (let i = 0; i < wallets.length; i++) {
    const subKey = `${mint}:${wallets[i].address?.slice(0, 8)}`;
    const pos = BotState.positions.get(subKey);
    if (!pos) continue;

    try {
      const keypair = getKeypairFromEntry(wallets[i]);
      const tokenAccounts = await conn.getParsedTokenAccountsByOwner(keypair.publicKey, {
        mint: new (require('@solana/web3.js').PublicKey)(mint),
      });

      const bal = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
      if (bal <= 0) { BotState.positions.delete(subKey); continue; }

      const balRaw = Math.floor(bal * 1e9);
      const quoteUrl = `${JUPITER_QUOTE_API}/quote?` + new URLSearchParams({
        inputMint: mint,
        outputMint: WSOL_MINT,
        amount: balRaw,
        slippageBps: config.sniper.slippageBps + 200,
      });

      const quote = await (await fetch(quoteUrl, { timeout: 8000 })).json();
      if (quote.error) throw new Error(quote.error);

      const swapData = await (await fetch(`${JUPITER_QUOTE_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: keypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: config.sniper.priorityFeeLamports,
        }),
      })).json();

      const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
      tx.sign([keypair]);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      await conn.confirmTransaction(sig, 'confirmed');

      const receivedSol = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
      const pnlSol = receivedSol - pos.buySol;
      BotState.positions.delete(subKey);

      logger.trade(`✅ Spread wallet ${i + 1} sold ${pos.symbol} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`);

    } catch (err) {
      logger.error(`Spread sell wallet ${i + 1} failed:`, err.message);
    }

    if (i < wallets.length - 1) await sleep(800 + Math.random() * 1200);
  }
}

function addSubWallet(privateKeyBase58, label = '') {
  try {
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    const entry = {
      privateKey: privateKeyBase58,
      address: keypair.publicKey.toString(),
      label: label || `W${BotState.multiWallet.wallets.length + 1}`,
    };
    BotState.multiWallet.wallets.push(entry);
    return { success: true, address: entry.address, label: entry.label };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

function removeSubWallet(index) {
  if (index < 0 || index >= BotState.multiWallet.wallets.length) {
    return { success: false, reason: 'Invalid index' };
  }
  const removed = BotState.multiWallet.wallets.splice(index, 1)[0];
  return { success: true, address: removed.address };
}

function getKeypairFromEntry(entry) {
  return Keypair.fromSecretKey(bs58.decode(entry.privateKey));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { executeSpreadBuy, executeSpreadSell, addSubWallet, removeSubWallet };
