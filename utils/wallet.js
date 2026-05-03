const { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const config = require('../config');

let _keypair = null;
let _connection = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(config.rpc, {
      commitment: 'confirmed',
      wsEndpoint: config.rpc.replace('https', 'wss'),
    });
  }
  return _connection;
}

function getKeypair() {
  if (!_keypair) {
    const decoded = bs58.decode(config.wallet.privateKey);
    _keypair = Keypair.fromSecretKey(decoded);
  }
  return _keypair;
}

function getPublicKey() {
  return getKeypair().publicKey;
}

async function getSolBalance() {
  const conn = getConnection();
  const bal = await conn.getBalance(getPublicKey());
  return bal / LAMPORTS_PER_SOL;
}

async function getTokenBalance(mintPubkey) {
  const conn = getConnection();
  try {
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(getPublicKey(), {
      mint: new PublicKey(mintPubkey),
    });
    if (tokenAccounts.value.length === 0) return 0;
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  } catch {
    return 0;
  }
}

module.exports = { getConnection, getKeypair, getPublicKey, getSolBalance, getTokenBalance };
