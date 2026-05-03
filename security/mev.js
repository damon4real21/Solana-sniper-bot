const {
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { getConnection, getKeypair } = require('../utils/wallet');
const config = require('../config');
const logger = require('../utils/logger');

// Jito block engine endpoints (regional)
const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// Known Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjY4uccDchSDqn6iv7yj',
];

/**
 * Build a transaction with high priority fee for MEV protection.
 * If Jito is enabled, submit as a bundle to private mempool.
 */
async function sendWithMevProtection(transaction) {
  const conn = getConnection();
  const keypair = getKeypair();

  if (config.mev.useJito) {
    return sendJitoBundle(transaction, keypair, conn);
  }

  // Standard: high priority fee via compute budget
  return sendWithPriorityFee(transaction, keypair, conn);
}

async function sendWithPriorityFee(transaction, keypair, conn) {
  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');

    if (transaction.message) {
      // VersionedTransaction
      transaction.message.recentBlockhash = blockhash;
      transaction.sign([keypair]);
    } else {
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = keypair.publicKey;
      transaction.sign(keypair);
    }

    const sig = await conn.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    });

    const confirmation = await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    if (confirmation.value.err) throw new Error('Transaction failed: ' + JSON.stringify(confirmation.value.err));

    logger.success(`TX confirmed: https://solscan.io/tx/${sig}`);
    return sig;
  } catch (err) {
    logger.error('sendWithPriorityFee error:', err.message);
    throw err;
  }
}

async function sendJitoBundle(transaction, keypair, conn) {
  const fetch = (await import('node-fetch')).default;

  try {
    const { blockhash } = await conn.getLatestBlockhash('finalized');

    // Build tip instruction to a random Jito tip account
    const tipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    );

    const tipIx = SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: tipAccount,
      lamports: config.mev.jitoTipLamports,
    });

    const tipMsg = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipIx],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(tipMsg);
    tipTx.sign([keypair]);

    // Sign main tx
    if (transaction.message) {
      transaction.message.recentBlockhash = blockhash;
      transaction.sign([keypair]);
    }

    const bundle = [
      Buffer.from(transaction.serialize()).toString('base64'),
      Buffer.from(tipTx.serialize()).toString('base64'),
    ];

    // Try each endpoint
    for (const endpoint of JITO_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [bundle] }),
          timeout: 5000,
        });
        const data = await res.json();
        if (data.result) {
          logger.success(`Jito bundle accepted: ${data.result}`);
          return data.result;
        }
      } catch (_) {}
    }

    // Fallback to normal send
    logger.warn('Jito bundle failed, falling back to standard send');
    return sendWithPriorityFee(transaction, keypair, conn);
  } catch (err) {
    logger.error('Jito bundle error:', err.message);
    return sendWithPriorityFee(transaction, keypair, conn);
  }
}

module.exports = { sendWithMevProtection };
