const {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} = require('@solana/web3.js');
const bs58 = require('bs58');
const { getConnection, getKeypair } = require('./wallet');
const { sendWithMevProtection } = require('../security/mev');
const logger = require('./logger');

// Secondary wallets loaded from env: WALLET_2=base58key,WALLET_3=base58key,...
const secondaryKeypairs = [];

function loadSecondaryWallets() {
  secondaryKeypairs.length = 0;
  for (let i = 2; i <= 5; i++) {
    const key = process.env[`WALLET_${i}`];
    if (!key) continue;
    try {
      const decoded = bs58.decode(key);
      const kp = Keypair.fromSecretKey(decoded);
      secondaryKeypairs.push(kp);
      logger.info(`💳 Loaded wallet ${i}: ${kp.publicKey.toString().slice(0, 12)}...`);
    } catch (err) {
      logger.error(`Failed to load WALLET_${i}:`, err.message);
    }
  }
  return secondaryKeypairs.length;
}

function getAllKeypairs() {
  return [getKeypair(), ...secondaryKeypairs];
}

function getWalletList() {
  return getAllKeypairs().map((kp, i) => ({
    index: i + 1,
    address: kp.publicKey.toString(),
    label: i === 0 ? 'Primary' : `Wallet ${i + 1}`,
  }));
}

/**
 * Execute a buy across multiple wallets with staggered timing.
 * splitMode: 'equal' | 'random' | 'primary-heavy'
 */
async function multiWalletBuy({ mint, totalSolAmount, splitMode = 'equal', quoteBuilderFn }) {
  const wallets = getAllKeypairs();
  if (wallets.length === 1) {
    // Only primary — just do a regular buy
    return null;
  }

  const splits = calculateSplits(totalSolAmount, wallets.length, splitMode);
  const results = [];

  for (let i = 0; i < wallets.length; i++) {
    const kp = wallets[i];
    const sol = splits[i];
    if (sol < 0.001) continue;

    // Random delay between wallets (100-800ms) to avoid appearing as one actor
    const delay = i === 0 ? 0 : 100 + Math.floor(Math.random() * 700);
    if (delay > 0) await sleep(delay);

    try {
      const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
      const tx = await quoteBuilderFn(mint, lamports, kp.publicKey.toString());
      if (!tx) continue;

      tx.sign([kp]);
      const sig = await sendWithMevProtection(tx);
      results.push({ wallet: kp.publicKey.toString(), sol, sig, success: true });
      logger.trade(`MultiWallet: wallet ${i + 1} bought ${sol.toFixed(4)} SOL of ${mint.slice(0, 8)}...`);
    } catch (err) {
      logger.error(`MultiWallet: wallet ${i + 1} failed:`, err.message);
      results.push({ wallet: kp.publicKey.toString(), sol, sig: null, success: false, error: err.message });
    }
  }

  return results;
}

/**
 * Fund secondary wallets from primary.
 */
async function fundSecondaryWallets(solPerWallet) {
  const conn = getConnection();
  const primary = getKeypair();
  const results = [];

  for (const kp of secondaryKeypairs) {
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: primary.publicKey,
          toPubkey: kp.publicKey,
          lamports: Math.floor(solPerWallet * LAMPORTS_PER_SOL),
        })
      );
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = primary.publicKey;
      tx.sign(primary);

      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction(sig, 'confirmed');
      results.push({ address: kp.publicKey.toString(), success: true, sig });
      logger.success(`Funded ${kp.publicKey.toString().slice(0, 12)}... with ${solPerWallet} SOL`);
    } catch (err) {
      results.push({ address: kp.publicKey.toString(), success: false, error: err.message });
    }
  }

  return results;
}

async function getSecondaryBalances() {
  const conn = getConnection();
  const results = [];
  for (const kp of secondaryKeypairs) {
    try {
      const bal = await conn.getBalance(kp.publicKey);
      results.push({ address: kp.publicKey.toString(), solBalance: bal / LAMPORTS_PER_SOL });
    } catch {
      results.push({ address: kp.publicKey.toString(), solBalance: 0 });
    }
  }
  return results;
}

function calculateSplits(total, count, mode) {
  if (count === 1) return [total];

  if (mode === 'equal') {
    const each = total / count;
    return Array(count).fill(parseFloat(each.toFixed(6)));
  }

  if (mode === 'primary-heavy') {
    const primary = total * 0.5;
    const rest = (total * 0.5) / (count - 1);
    return [primary, ...Array(count - 1).fill(parseFloat(rest.toFixed(6)))];
  }

  if (mode === 'random') {
    // Random weights that sum to 1
    const weights = Array.from({ length: count }, () => Math.random());
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => parseFloat(((w / sum) * total).toFixed(6)));
  }

  return Array(count).fill(total / count);
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

module.exports = {
  loadSecondaryWallets,
  getAllKeypairs,
  getWalletList,
  multiWalletBuy,
  fundSecondaryWallets,
  getSecondaryBalances,
};
