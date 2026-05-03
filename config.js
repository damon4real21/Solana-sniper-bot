const config = {
  rpc: process.env.HELIUS_RPC_URL,
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  wallet: {
    privateKey: process.env.PRIVATE_KEY,
  },
  sniper: {
    buyAmountSol: parseFloat(process.env.BUY_AMOUNT_SOL || '0.1'),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '500'),
    priorityFeeLamports: parseInt(process.env.PRIORITY_FEE_LAMPORTS || '100000'),
    maxPriceImpact: parseFloat(process.env.MAX_PRICE_IMPACT || '15'),
  },
  rugFilter: {
    minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '1000'),
    maxTop10HolderPct: parseFloat(process.env.MAX_TOP10_HOLDER_PCT || '80'),
    requireMintRenounced: process.env.REQUIRE_MINT_RENOUNCED === 'true',
    requireFreezeRenounced: process.env.REQUIRE_FREEZE_RENOUNCED === 'true',
    minLpLockDays: parseInt(process.env.MIN_LP_LOCK_DAYS || '0'),
  },
  autoSell: {
    enabled: process.env.AUTO_SELL === 'true',
    takeProfitMultiplier: parseFloat(process.env.TAKE_PROFIT_MULTIPLIER || '3'),
    stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '40'),
  },
  sources: {
    pumpfun: process.env.SNIPE_PUMPFUN !== 'false',
    dexscreener: process.env.SNIPE_DEXSCREENER !== 'false',
    raydium: process.env.SNIPE_RAYDIUM !== 'false',
  },
  mev: {
    useJito: process.env.USE_JITO === 'true',
    jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS || '10000'),
  },
};

module.exports = config;
