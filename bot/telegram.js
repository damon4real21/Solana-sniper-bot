const TelegramBot = require('node-telegram-bot-api');
const { BotState } = require('../utils/state');
const { executeSell } = require('../trader/executor');
const { getSolBalance, getPublicKey } = require('../utils/wallet');
const { addWatchWallet, removeWatchWallet, getWatchedWallets } = require('../features/copytrader');
const { getTrackedTokens } = require('../features/devtracker');
const { addSubWallet, removeSubWallet } = require('../features/multiwallet');
const config = require('../config');
const logger = require('../utils/logger');

let bot = null;
const chatId = config.telegram.chatId;

// ── Keyboard Layouts ─────────────────────────────────────────────────────────

const KB = {
  main: {
    inline_keyboard: [
      [
        { text: '▶️ Start Sniping', callback_data: 'snipe_start' },
        { text: '⏹ Stop', callback_data: 'snipe_stop' },
      ],
      [
        { text: '📊 Status', callback_data: 'status' },
        { text: '💼 Positions', callback_data: 'positions' },
        { text: '📜 History', callback_data: 'history' },
      ],
      [
        { text: '📡 Sources', callback_data: 'sources_menu' },
        { text: '⚙️ Settings', callback_data: 'settings_menu' },
      ],
      [
        { text: '👥 Copy Trade', callback_data: 'copy_menu' },
        { text: '📈 Vol Spike', callback_data: 'vol_menu' },
        { text: '🔀 Multi-Wallet', callback_data: 'mw_menu' },
      ],
      [
        { text: '🛡 MEV', callback_data: 'mev_toggle' },
        { text: '👛 Wallet', callback_data: 'wallet' },
        { text: '🚫 Blacklist', callback_data: 'blacklist_menu' },
      ],
      // ── New Feature Buttons ──
      [
        { text: '🐳 Whale Wallets', callback_data: 'whale_menu' },
        { text: '📋 Trade Summary', callback_data: 'trade_summary' },
      ],
      [
        { text: '🍯 Honeypot', callback_data: 'honeypot_toggle' },
        { text: '🎯 Partial TP', callback_data: 'partialtp_toggle' },
        { text: '📉 Trail Stop', callback_data: 'trail_menu' },
      ],
      [
        { text: '💰 Budget', callback_data: 'budget_menu' },
        { text: '📊 Mcap Filter', callback_data: 'mcap_menu' },
        { text: '⏱ Token Age', callback_data: 'tokenage_menu' },
      ],
      [
        { text: '🐦 Twitter Check', callback_data: 'twitter_toggle' },
        { text: '📰 News Feed', callback_data: 'news_menu' },
      ],
      [
        { text: '🌅 Briefing Now', callback_data: 'briefing_now' },
        { text: '📈 P&L Report', callback_data: 'report_now' },
      ],
    ],
  },

  sources: (s) => ({
    inline_keyboard: [
      [
        { text: `pump.fun ${s.pumpfun ? '✅' : '❌'}`, callback_data: 'toggle_pumpfun' },
        { text: `DexScreener ${s.dexscreener ? '✅' : '❌'}`, callback_data: 'toggle_dexscreener' },
        { text: `Raydium ${s.raydium ? '✅' : '❌'}`, callback_data: 'toggle_raydium' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),

  settings: () => ({
    inline_keyboard: [
      [
        { text: `💰 Buy: ${BotState.sniper.buyAmountSol} SOL`, callback_data: 'set_buy' },
        { text: `📉 Slip: ${BotState.sniper.slippageBps / 100}%`, callback_data: 'set_slip' },
      ],
      [
        { text: `🎯 TP: ${BotState.autoSell.takeProfitMultiplier}x`, callback_data: 'set_tp' },
        { text: `🛑 SL: -${BotState.autoSell.stopLossPct}%`, callback_data: 'set_sl' },
      ],
      [
        { text: `💧 Min Liq: $${BotState.rugFilter.minLiquidityUsd}`, callback_data: 'set_liq' },
        { text: `🔥 Auto-Sell: ${BotState.autoSell.enabled ? 'ON ✅' : 'OFF ❌'}`, callback_data: 'toggle_autosell' },
      ],
      [
        { text: `🔑 Mint Renounced: ${BotState.rugFilter.requireMintRenounced ? '✅' : '❌'}`, callback_data: 'toggle_mint' },
        { text: `❄️ Freeze Ren: ${BotState.rugFilter.requireFreezeRenounced ? '✅' : '❌'}`, callback_data: 'toggle_freeze' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),

  copy: () => ({
    inline_keyboard: [
      [
        { text: `Copy Trade: ${BotState.copyTrading.enabled ? 'ON ✅' : 'OFF ❌'}`, callback_data: 'toggle_copy' },
      ],
      [
        { text: '➕ Add Wallet', callback_data: 'copy_add' },
        { text: '📋 List Wallets', callback_data: 'copy_list' },
      ],
      [
        { text: '➖ Remove Wallet', callback_data: 'copy_remove' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),

  vol: () => ({
    inline_keyboard: [
      [
        { text: `Vol Spike: ${BotState.volumeSpike.enabled ? 'ON ✅' : 'OFF ❌'}`, callback_data: 'toggle_vol' },
      ],
      [
        { text: `Min Vol 1h: $${BotState.volumeSpike.minVolume1h.toLocaleString()}`, callback_data: 'set_vol_min' },
        { text: `Min +%: ${BotState.volumeSpike.minPriceChange5m}%`, callback_data: 'set_vol_pct' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),

  multiWallet: () => ({
    inline_keyboard: [
      [
        { text: `Spread Buy: ${BotState.multiWallet.enabled ? 'ON ✅' : 'OFF ❌'}`, callback_data: 'toggle_mw' },
      ],
      [
        { text: '➕ Add Sub-Wallet', callback_data: 'mw_add' },
        { text: '📋 List Wallets', callback_data: 'mw_list' },
      ],
      [
        { text: `Per-Wallet SOL: ${BotState.multiWallet.perWalletSol}`, callback_data: 'set_mw_sol' },
        { text: '➖ Remove', callback_data: 'mw_remove' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),

  positions: (posArr) => {
    const rows = posArr.slice(0, 8).map(p => ([
      { text: `💊 Sell ${p.symbol}`, callback_data: `sell_${p.mint}` },
    ]));
    rows.push([
      { text: '💣 Sell ALL', callback_data: 'sell_all' },
      { text: '« Back', callback_data: 'main_menu' },
    ]);
    return { inline_keyboard: rows };
  },

  backToMain: { inline_keyboard: [[{ text: '« Main Menu', callback_data: 'main_menu' }]] },

  // ── New Feature Keyboards ────────────────────────────────────────────────────

  whale: () => ({
    inline_keyboard: [
      [{ text: '➕ Add Whale (Alert Only)', callback_data: 'whale_add_alert' }],
      [{ text: '➕ Add Whale (Auto-Buy)', callback_data: 'whale_add_auto' }],
      [{ text: '📋 List Whale Wallets', callback_data: 'whale_list' }],
      [{ text: '➖ Remove Whale', callback_data: 'whale_remove' }],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),

  trail: () => ({
    inline_keyboard: [
      [{ text: `📉 Trailing Stop: ${BotState.trailingStopPct || 25}% from peak`, callback_data: 'trail_set' }],
      [
        { text: '15% (Tight)', callback_data: 'trail_15' },
        { text: '25% (Default)', callback_data: 'trail_25' },
        { text: '40% (Loose)', callback_data: 'trail_40' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),

  budget: () => ({
    inline_keyboard: [
      [{ text: `💰 Daily Budget: ${BotState.dailyBudgetSol === 0 ? 'Unlimited' : BotState.dailyBudgetSol + ' SOL'}`, callback_data: 'budget_set' }],
      [
        { text: '0.5 SOL/day', callback_data: 'budget_05' },
        { text: '1 SOL/day', callback_data: 'budget_1' },
        { text: 'Unlimited', callback_data: 'budget_0' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),

  mcap: () => ({
    inline_keyboard: [
      [{ text: `📊 Max Mcap: ${BotState.maxMarketCapUsd === 0 ? 'Disabled' : '$' + (BotState.maxMarketCapUsd/1000).toFixed(0) + 'k'}`, callback_data: 'mcap_set' }],
      [
        { text: '$100k', callback_data: 'mcap_100k' },
        { text: '$500k', callback_data: 'mcap_500k' },
        { text: 'Disabled', callback_data: 'mcap_0' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),

  tokenage: () => ({
    inline_keyboard: [
      [{ text: `⏱ Max Age: ${BotState.maxTokenAgeSec || 300}s (${((BotState.maxTokenAgeSec||300)/60).toFixed(1)} min)`, callback_data: 'tokenage_set' }],
      [
        { text: '60s (1 min)', callback_data: 'age_60' },
        { text: '120s (2 min)', callback_data: 'age_120' },
        { text: '300s (5 min)', callback_data: 'age_300' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),

  news: () => ({
    inline_keyboard: [
      [{ text: `📰 News Feed: ${BotState.newsFeed?.enabled ? 'ON ✅' : 'OFF ❌'}`, callback_data: 'toggle_news' }],
      [{ text: '📰 Trending Alert — sends top 5 trending Solana tokens now', callback_data: 'news_now' }],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  }),
};

// ── Awaiting Input State ─────────────────────────────────────────────────────
const awaitingInput = new Map(); // chatId -> { type, ... }

// ── Init ─────────────────────────────────────────────────────────────────────
async function startTelegramBot() {
  bot = new TelegramBot(config.telegram.token, { polling: true });
  bot.on('polling_error', err => logger.error('TG poll error:', err.message));

  // Text commands
  bot.onText(/\/start/, handleStart);
  bot.onText(/\/menu/, handleStart);
  bot.onText(/\/snipe/, () => { BotState.sniping = true; sendTelegramAlert('🟢 Sniping started!'); });
  bot.onText(/\/stop/, () => { BotState.sniping = false; sendTelegramAlert('🔴 Sniping stopped.'); });
  bot.onText(/\/status/, handleStatus);
  bot.onText(/\/sellall/, handleSellAll);
  bot.onText(/\/sell (.+)/, async (msg, match) => handleSellPartial(msg, match[1].trim()));
  bot.onText(/\/blacklist (.+)/, (msg, match) => {
    if (!guard(msg)) return;
    BotState.addBlacklist(match[1].trim());
    sendTelegramAlert(`🚫 Blacklisted: \`${match[1].trim()}\``);
  });

  // Callback query handler (inline buttons)
  bot.on('callback_query', handleCallback);

  // Free-text reply handler (for awaiting input)
  bot.on('message', handleFreeText);

  await sendMenu('🚀 *Solana Sniper Bot v2 Online!*\n\nChoose an action:');
  return bot;
}

// ── Guards & Helpers ─────────────────────────────────────────────────────────
function guard(msg) {
  return msg?.chat?.id?.toString() === chatId?.toString();
}

async function sendTelegramAlert(text, extra = {}) {
  if (!bot || !chatId) return;
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    logger.error('TG send error:', err.message);
  }
}

async function sendMenu(text) {
  await sendTelegramAlert(text, { reply_markup: KB.main });
}

async function editMenu(chatId, msgId, text, keyboard) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
  } catch (_) {
    await sendTelegramAlert(text, { reply_markup: keyboard });
  }
}

// ── Command Handlers ─────────────────────────────────────────────────────────
async function handleStart(msg) {
  if (!guard(msg)) return;
  const status = BotState.sniping ? '🟢 ACTIVE' : '🔴 STOPPED';
  await sendMenu(`🎯 *Solana Sniper Bot*\nStatus: ${status}\n\nSelect an option:`);
}

async function handleStatus(msg) {
  if (msg && !guard(msg)) return;
  const s = BotState.getSummary();
  const bal = await getSolBalance().catch(() => '?');
  const text =
    `📊 *Status*\n\n` +
    `Sniping: ${s.sniping ? '🟢 ON' : '🔴 OFF'} | Wallet: ${typeof bal === 'number' ? bal.toFixed(4) : bal} SOL\n` +
    `Sources: pump.fun ${s.sources.pumpfun ? '✅' : '❌'} | DEX ${s.sources.dexscreener ? '✅' : '❌'} | Ray ${s.sources.raydium ? '✅' : '❌'}\n\n` +
    `*Trades:* ${s.sniped} sniped | ${s.wins}W/${s.losses}L | WR: ${s.winRate}%\n` +
    `*P&L:* ${parseFloat(s.totalPnlSol) >= 0 ? '+' : ''}${s.totalPnlSol} SOL\n` +
    `*Open:* ${s.positions} positions\n\n` +
    `*Features:*\n` +
    `Copy Trade: ${s.copyTradingOn ? '✅' : '❌'} (${s.copyWallets} wallets)\n` +
    `Vol Spike: ${s.volumeSpikeOn ? '✅' : '❌'}\n` +
    `Multi-Wallet: ${BotState.multiWallet.enabled ? `✅ (${s.subWallets} wallets)` : '❌'}\n` +
    `MEV: ${BotState.mev.useJito ? '🛡 Jito' : '⚡ Priority Fee'}`;
  return text;
}

async function handleSellAll(msg) {
  if (msg && !guard(msg)) return;
  if (BotState.positions.size === 0) { await sendTelegramAlert('📭 No open positions'); return; }
  await sendTelegramAlert(`🔄 Selling all ${BotState.positions.size} positions...`);
  for (const mint of [...BotState.positions.keys()]) {
    await executeSell(mint, 'Sell All').catch(() => {});
  }
}

async function handleSellPartial(msg, partial) {
  if (!guard(msg)) return;
  for (const mint of BotState.positions.keys()) {
    if (mint.startsWith(partial) || mint === partial) {
      await sendTelegramAlert(`🔄 Selling \`${mint.slice(0, 12)}...\``);
      await executeSell(mint, 'Manual');
      return;
    }
  }
  await sendTelegramAlert(`❌ Position not found: ${partial}`);
}

// ── Callback Handler (inline buttons) ────────────────────────────────────────
async function handleCallback(query) {
  const cid = query.message?.chat?.id?.toString();
  if (cid !== chatId?.toString()) return;

  const data = query.data;
  const msgId = query.message?.message_id;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ── Main Menu ──
  if (data === 'main_menu') {
    await editMenu(cid, msgId, '🎯 *Main Menu*', KB.main);
    return;
  }

  // ── Snipe control ──
  if (data === 'snipe_start') {
    BotState.sniping = true;
    await editMenu(cid, msgId,
      `🟢 *Sniping STARTED*\nBuy: ${BotState.sniper.buyAmountSol} SOL | TP: ${BotState.autoSell.takeProfitMultiplier}x | SL: -${BotState.autoSell.stopLossPct}%`,
      KB.main
    );
    return;
  }
  if (data === 'snipe_stop') {
    BotState.sniping = false;
    await editMenu(cid, msgId, `🔴 *Sniping STOPPED*\nOpen positions: ${BotState.positions.size}`, KB.main);
    return;
  }

  // ── Status ──
  if (data === 'status') {
    const txt = await handleStatus();
    await editMenu(cid, msgId, txt, KB.backToMain);
    return;
  }

  // ── Positions ──
  if (data === 'positions') {
    if (BotState.positions.size === 0) {
      await editMenu(cid, msgId, '📭 No open positions', KB.backToMain);
      return;
    }
    const posArr = [...BotState.positions.entries()].map(([mint, p]) => ({ mint, ...p }));
    let txt = `💼 *Open Positions (${posArr.length})*\n\n`;
    for (const p of posArr.slice(0, 8)) {
      const age = Math.floor((Date.now() - p.buyTime) / 60000);
      txt += `• *${p.symbol}* (${p.source}) — ${age}m ago\n  \`${p.mint.slice(0, 16)}...\`\n`;
    }
    await editMenu(cid, msgId, txt, KB.positions(posArr));
    return;
  }

  // ── Sell individual from button ──
  if (data.startsWith('sell_') && data !== 'sell_all') {
    const mint = data.replace('sell_', '');
    await sendTelegramAlert(`🔄 Selling \`${mint.slice(0, 12)}...\``);
    await executeSell(mint, 'Button Sell').catch(() => {});
    return;
  }
  if (data === 'sell_all') {
    await handleSellAll(null);
    return;
  }

  // ── History ──
  if (data === 'history') {
    const trades = BotState.tradeHistory.slice(0, 10);
    if (!trades.length) { await editMenu(cid, msgId, '📭 No trade history yet', KB.backToMain); return; }
    let txt = `📜 *Last ${trades.length} Trades*\n\n`;
    for (const t of trades) {
      const e = t.pnlSol >= 0 ? '🟢' : '🔴';
      txt += `${e} *${t.symbol}* | ${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)} SOL | ${t.reason}\n`;
    }
    await editMenu(cid, msgId, txt, KB.backToMain);
    return;
  }

  // ── Wallet ──
  if (data === 'wallet') {
    const bal = await getSolBalance().catch(() => '?');
    const pubkey = getPublicKey().toString();
    const txt =
      `👛 *Wallet*\n\n` +
      `\`${pubkey}\`\n` +
      `Balance: *${typeof bal === 'number' ? bal.toFixed(6) : bal} SOL*\n` +
      `[View on Solscan](https://solscan.io/account/${pubkey})`;
    await editMenu(cid, msgId, txt, KB.backToMain);
    return;
  }

  // ── Sources menu ──
  if (data === 'sources_menu') {
    await editMenu(cid, msgId, '📡 *Sniper Sources*\nToggle each source:', KB.sources(BotState.sources));
    return;
  }
  if (data === 'toggle_pumpfun') {
    BotState.sources.pumpfun = !BotState.sources.pumpfun;
    await editMenu(cid, msgId, `📡 *Sources* — pump.fun ${BotState.sources.pumpfun ? 'enabled ✅' : 'disabled ❌'}`, KB.sources(BotState.sources));
    return;
  }
  if (data === 'toggle_dexscreener') {
    BotState.sources.dexscreener = !BotState.sources.dexscreener;
    await editMenu(cid, msgId, `📡 *Sources* — DexScreener ${BotState.sources.dexscreener ? 'enabled ✅' : 'disabled ❌'}`, KB.sources(BotState.sources));
    return;
  }
  if (data === 'toggle_raydium') {
    BotState.sources.raydium = !BotState.sources.raydium;
    await editMenu(cid, msgId, `📡 *Sources* — Raydium ${BotState.sources.raydium ? 'enabled ✅' : 'disabled ❌'}`, KB.sources(BotState.sources));
    return;
  }

  // ── Settings menu ──
  if (data === 'settings_menu') {
    await editMenu(cid, msgId, '⚙️ *Settings* — tap a value to change it:', KB.settings());
    return;
  }
  if (data === 'toggle_autosell') {
    BotState.autoSell.enabled = !BotState.autoSell.enabled;
    await editMenu(cid, msgId, `⚙️ Auto-Sell ${BotState.autoSell.enabled ? 'ON ✅' : 'OFF ❌'}`, KB.settings());
    return;
  }
  if (data === 'toggle_mint') {
    BotState.rugFilter.requireMintRenounced = !BotState.rugFilter.requireMintRenounced;
    await editMenu(cid, msgId, `⚙️ Mint Renounced filter ${BotState.rugFilter.requireMintRenounced ? 'ON' : 'OFF'}`, KB.settings());
    return;
  }
  if (data === 'toggle_freeze') {
    BotState.rugFilter.requireFreezeRenounced = !BotState.rugFilter.requireFreezeRenounced;
    await editMenu(cid, msgId, `⚙️ Freeze Renounced filter ${BotState.rugFilter.requireFreezeRenounced ? 'ON' : 'OFF'}`, KB.settings());
    return;
  }
  // Prompt for numeric values
  const inputPrompts = {
    set_buy:     { type: 'set_buy',     prompt: '💰 Enter new buy amount in SOL:\n_e.g. `0.1`_' },
    set_slip:    { type: 'set_slip',    prompt: '📉 Enter slippage in % (e.g. `5` for 5%):' },
    set_tp:      { type: 'set_tp',      prompt: '🎯 Enter take profit multiplier:\n_e.g. `3` for 3x_' },
    set_sl:      { type: 'set_sl',      prompt: '🛑 Enter stop loss %:\n_e.g. `40` for -40%_' },
    set_liq:     { type: 'set_liq',     prompt: '💧 Enter minimum liquidity in USD:\n_e.g. `1000`_' },
    set_vol_min: { type: 'set_vol_min', prompt: '📈 Enter minimum 1h volume in USD:\n_e.g. `5000`_' },
    set_vol_pct: { type: 'set_vol_pct', prompt: '📈 Enter minimum 5m price change %:\n_e.g. `10`_' },
    set_mw_sol:  { type: 'set_mw_sol',  prompt: '🔀 Enter SOL per sub-wallet:\n_e.g. `0.05`_' },
    copy_add:    { type: 'copy_add',    prompt: '👥 Enter wallet address to mirror:\n_Paste the full Solana address_' },
    copy_remove: { type: 'copy_remove', prompt: '👥 Enter wallet address to remove:' },
    mw_add:      { type: 'mw_add',      prompt: '🔀 Enter sub-wallet private key (base58):\n⚠️ Use a funded burner wallet only' },
    mw_remove:   { type: 'mw_remove',   prompt: '🔀 Enter wallet index (0-based) to remove:' },
    blacklist_menu: { type: 'blacklist_add', prompt: '🚫 Enter token mint to blacklist:' },
  };

  if (inputPrompts[data]) {
    awaitingInput.set(cid, inputPrompts[data]);
    await sendTelegramAlert(inputPrompts[data].prompt);
    return;
  }

  // ── MEV toggle ──
  if (data === 'mev_toggle') {
    BotState.mev.useJito = !BotState.mev.useJito;
    config.mev.useJito = BotState.mev.useJito;
    await editMenu(cid, msgId,
      `🛡 *MEV Protection*\n\nJito Bundles: ${BotState.mev.useJito ? '✅ ON' : '❌ OFF'}\n` +
      `${BotState.mev.useJito ? `Tip: ${BotState.mev.jitoTipLamports} lamports` : 'Using priority fee only'}`,
      KB.backToMain
    );
    return;
  }

  // ── Copy Trade menu ──
  if (data === 'copy_menu') {
    await editMenu(cid, msgId, '👥 *Copy Trade*\nMirror profitable wallets in real-time:', KB.copy());
    return;
  }
  if (data === 'toggle_copy') {
    BotState.copyTrading.enabled = !BotState.copyTrading.enabled;
    await editMenu(cid, msgId, `👥 Copy Trading: ${BotState.copyTrading.enabled ? 'ON ✅' : 'OFF ❌'}`, KB.copy());
    return;
  }
  if (data === 'copy_list') {
    const wallets = getWatchedWallets();
    const txt = wallets.length === 0
      ? '👥 No wallets being watched'
      : `👥 *Watched Wallets (${wallets.length})*\n\n` +
        wallets.map((w, i) => `${i + 1}. *${w.label}*\n   \`${w.address.slice(0, 16)}...\`\n   Trades: ${w.trades}`).join('\n\n');
    await editMenu(cid, msgId, txt, KB.copy());
    return;
  }

  // ── Volume Spike menu ──
  if (data === 'vol_menu') {
    await editMenu(cid, msgId, '📈 *Volume Spike Detector*\nSnipe trending tokens:', KB.vol());
    return;
  }
  if (data === 'toggle_vol') {
    BotState.volumeSpike.enabled = !BotState.volumeSpike.enabled;
    await editMenu(cid, msgId, `📈 Volume Spike: ${BotState.volumeSpike.enabled ? 'ON ✅' : 'OFF ❌'}`, KB.vol());
    return;
  }

  // ── Multi-Wallet menu ──
  if (data === 'mw_menu') {
    await editMenu(cid, msgId, '🔀 *Multi-Wallet Spread*\nSplit buys across wallets:', KB.multiWallet());
    return;
  }
  if (data === 'toggle_mw') {
    BotState.multiWallet.enabled = !BotState.multiWallet.enabled;
    await editMenu(cid, msgId, `🔀 Spread Buy: ${BotState.multiWallet.enabled ? 'ON ✅' : 'OFF ❌'}`, KB.multiWallet());
    return;
  }
  if (data === 'mw_list') {
    const ws = BotState.multiWallet.wallets;
    const txt = ws.length === 0
      ? '🔀 No sub-wallets configured'
      : `🔀 *Sub-Wallets (${ws.length})*\n\n` +
        ws.map((w, i) => `${i}. *${w.label}*\n   \`${w.address.slice(0, 20)}...\``).join('\n\n');
    await editMenu(cid, msgId, txt, KB.multiWallet());
    return;
  }

  // ── Blacklist menu ──
  if (data === 'blacklist_menu') {
    awaitingInput.set(cid, { type: 'blacklist_add', prompt: '🚫 Enter token mint to blacklist:' });
    const bl = [...BotState.blacklist].slice(0, 5);
    await sendTelegramAlert(
      `🚫 *Blacklist (${BotState.blacklist.size})*\n` +
      (bl.length ? bl.map(m => `• \`${m.slice(0, 16)}...\``).join('\n') : '_Empty_') +
      `\n\nPaste a mint address to blacklist it:`
    );
    return;
  }

  // ── New Feature Callbacks ──
  const handled = await handleNewFeatureCallbacks(data, cid, msgId);
  if (handled) return;
}

// ── Free-text Input Handler ───────────────────────────────────────────────────
async function handleFreeText(msg) {
  if (!guard(msg)) return;
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;

  const waiting = awaitingInput.get(cid);
  if (!waiting) return;
  awaitingInput.delete(cid);

  const handlers = {
    set_buy: () => {
      const v = parseFloat(text);
      if (isNaN(v) || v <= 0) return '❌ Invalid amount';
      BotState.sniper.buyAmountSol = v;
      return `✅ Buy amount set to *${v} SOL*`;
    },
    set_slip: () => {
      const v = parseFloat(text);
      if (isNaN(v)) return '❌ Invalid';
      BotState.sniper.slippageBps = Math.round(v * 100);
      return `✅ Slippage set to *${v}%*`;
    },
    set_tp: () => {
      const v = parseFloat(text);
      if (isNaN(v) || v <= 1) return '❌ Must be > 1';
      BotState.autoSell.takeProfitMultiplier = v;
      return `✅ Take Profit set to *${v}x*`;
    },
    set_sl: () => {
      const v = parseFloat(text);
      if (isNaN(v) || v <= 0) return '❌ Invalid';
      BotState.autoSell.stopLossPct = v;
      return `✅ Stop Loss set to *-${v}%*`;
    },
    set_liq: () => {
      const v = parseFloat(text);
      if (isNaN(v)) return '❌ Invalid';
      BotState.rugFilter.minLiquidityUsd = v;
      return `✅ Min liquidity set to *$${v}*`;
    },
    set_vol_min: () => {
      const v = parseFloat(text);
      if (isNaN(v)) return '❌ Invalid';
      BotState.volumeSpike.minVolume1h = v;
      return `✅ Min 1h volume set to *$${v}*`;
    },
    set_vol_pct: () => {
      const v = parseFloat(text);
      if (isNaN(v)) return '❌ Invalid';
      BotState.volumeSpike.minPriceChange5m = v;
      return `✅ Min 5m price change set to *${v}%*`;
    },
    set_mw_sol: () => {
      const v = parseFloat(text);
      if (isNaN(v) || v <= 0) return '❌ Invalid';
      BotState.multiWallet.perWalletSol = v;
      return `✅ Per-wallet SOL set to *${v}*`;
    },
    copy_add: () => {
      if (text.length < 30) return '❌ Invalid wallet address';
      const parts = text.split(' ');
      const address = parts[0];
      const label = parts[1] || `Wallet${BotState.copyTrading.wallets.size + 1}`;
      const added = addWatchWallet(address, label);
      BotState.copyTrading.wallets.add(address);
      return added ? `✅ Now watching *${label}*\n\`${address.slice(0, 20)}...\`` : `⚠️ Already watching this wallet`;
    },
    copy_remove: () => {
      removeWatchWallet(text);
      BotState.copyTrading.wallets.delete(text);
      return `✅ Removed \`${text.slice(0, 16)}...\` from watchlist`;
    },
    mw_add: () => {
      if (text.length < 40) return '❌ Invalid private key';
      const result = addSubWallet(text, `W${BotState.multiWallet.wallets.length + 1}`);
      return result.success
        ? `✅ Added sub-wallet *${result.label}*\n\`${result.address.slice(0, 20)}...\``
        : `❌ ${result.reason}`;
    },
    mw_remove: () => {
      const idx = parseInt(text);
      if (isNaN(idx)) return '❌ Enter a number';
      const result = removeSubWallet(idx);
      return result.success ? `✅ Removed wallet ${idx}` : `❌ ${result.reason}`;
    },
    blacklist_add: () => {
      if (text.length < 30) return '❌ Invalid mint address';
      BotState.addBlacklist(text);
      return `🚫 Blacklisted:\n\`${text}\``;
    },
    // New feature input handlers
    trail_set: () => {
      const v = parseFloat(text);
      if (isNaN(v) || v <= 0) return '❌ Invalid';
      BotState.trailingStopPct = v;
      return `📉 Trailing stop set to *${v}% from peak*`;
    },
    budget_set: () => {
      const v = parseFloat(text);
      if (isNaN(v) || v < 0) return '❌ Invalid';
      BotState.dailyBudgetSol = v;
      return `💰 Daily budget set to *${v === 0 ? 'Unlimited' : v + ' SOL/day'}*`;
    },
    mcap_set: () => {
      const v = parseFloat(text);
      if (isNaN(v) || v < 0) return '❌ Invalid';
      BotState.maxMarketCapUsd = v;
      return `📊 Max market cap set to *${v === 0 ? 'Disabled' : '$' + v.toLocaleString()}*`;
    },
    tokenage_set: () => {
      const v = parseInt(text);
      if (isNaN(v) || v <= 0) return '❌ Invalid';
      BotState.maxTokenAgeSec = v;
      return `⏱ Max token age set to *${v}s (${(v/60).toFixed(1)} min)*`;
    },
    whale_add_alert: () => {
      if (text.length < 30) return '❌ Invalid wallet address';
      const parts = text.split(' ');
      const address = parts[0]; const label = parts[1] || 'Whale';
      const { addWhaleWallet } = require('../features/features16');
      if (!BotState.whaleWallets) BotState.whaleWallets = new Map();
      addWhaleWallet(address, label, false);
      BotState.whaleWallets.set(address, { label, autoBuy: false });
      return `🐳 Watching *${label}* (alert only)\n\`${address.slice(0,16)}...\``;
    },
    whale_add_auto: () => {
      if (text.length < 30) return '❌ Invalid wallet address';
      const parts = text.split(' ');
      const address = parts[0]; const label = parts[1] || 'Whale';
      const { addWhaleWallet } = require('../features/features16');
      if (!BotState.whaleWallets) BotState.whaleWallets = new Map();
      addWhaleWallet(address, label, true);
      BotState.whaleWallets.set(address, { label, autoBuy: true });
      return `🐳 Watching *${label}* (auto-buy ON ⚡)\n\`${address.slice(0,16)}...\``;
    },
  };

  const handler = handlers[waiting.type];
  if (handler) {
    const result = handler();
    await sendTelegramAlert(result, { reply_markup: KB.backToMain });
  }
}

// ── New Feature Callback Handlers ─────────────────────────────────
async function handleNewFeatureCallbacks(data, cid, msgId) {
  const { sendTradeSummary, sendMorningBriefing, sendDailyReport, addWhaleWallet } = require('../features/features16');

  // ── Trade Summary ──
  if (data === 'trade_summary') {
    await sendTradeSummary();
    return true;
  }

  // ── Briefing & Report ──
  if (data === 'briefing_now') {
    await sendMorningBriefing();
    return true;
  }
  if (data === 'report_now') {
    await sendDailyReport();
    return true;
  }

  // ── Honeypot Toggle ──
  if (data === 'honeypot_toggle') {
    BotState.honeypotCheck = !BotState.honeypotCheck;
    await editMenu(cid, msgId,
      `🍯 *Honeypot Detector*\n\n${BotState.honeypotCheck ? '✅ ON — simulates sell before every buy' : '❌ OFF — no honeypot simulation'}`,
      KB.backToMain
    );
    return true;
  }

  // ── Partial TP Toggle ──
  if (data === 'partialtp_toggle') {
    if (!BotState.partialTP) BotState.partialTP = { enabled: false };
    BotState.partialTP.enabled = !BotState.partialTP.enabled;
    await editMenu(cid, msgId,
      `🎯 *Partial Take Profit*: ${BotState.partialTP.enabled ? '✅ ON' : '❌ OFF'}\n\n` +
      `Sell stages:\n• 50% at 2x\n• 25% at 5x\n• 25% at 10x`,
      KB.backToMain
    );
    return true;
  }

  // ── Twitter Toggle ──
  if (data === 'twitter_toggle') {
    if (!BotState.twitterCheck) BotState.twitterCheck = { enabled: false };
    BotState.twitterCheck.enabled = !BotState.twitterCheck.enabled;
    await editMenu(cid, msgId,
      `🐦 *Twitter/X Sentiment*: ${BotState.twitterCheck.enabled ? '✅ ON' : '❌ OFF'}\n\nChecks if token has Twitter, Telegram & website before buying.`,
      KB.backToMain
    );
    return true;
  }

  // ── Trail Stop Menu ──
  if (data === 'trail_menu') {
    await editMenu(cid, msgId, `📉 *Trailing Stop Loss*\nSells when price drops X% from its peak.\nCurrently: *${BotState.trailingStopPct || 25}%*`, KB.trail());
    return true;
  }
  if (data === 'trail_15') { BotState.trailingStopPct = 15; await editMenu(cid, msgId, '📉 Trailing stop set to *15%* (tight)', KB.trail()); return true; }
  if (data === 'trail_25') { BotState.trailingStopPct = 25; await editMenu(cid, msgId, '📉 Trailing stop set to *25%* (default)', KB.trail()); return true; }
  if (data === 'trail_40') { BotState.trailingStopPct = 40; await editMenu(cid, msgId, '📉 Trailing stop set to *40%* (loose)', KB.trail()); return true; }
  if (data === 'trail_set') { awaitingInput.set(cid, { type: 'trail_set', prompt: '📉 Enter trailing stop % from peak:\n_e.g. `25` for 25%_' }); await sendTelegramAlert('📉 Enter trailing stop % from peak:'); return true; }

  // ── Budget Menu ──
  if (data === 'budget_menu') {
    await editMenu(cid, msgId,
      `💰 *Daily Budget Limit*\nStops buying when daily SOL spend is reached.\nCurrently: *${BotState.dailyBudgetSol === 0 ? 'Unlimited' : BotState.dailyBudgetSol + ' SOL/day'}*`,
      KB.budget()
    );
    return true;
  }
  if (data === 'budget_05') { BotState.dailyBudgetSol = 0.5; await editMenu(cid, msgId, '💰 Budget set to *0.5 SOL/day*', KB.budget()); return true; }
  if (data === 'budget_1') { BotState.dailyBudgetSol = 1; await editMenu(cid, msgId, '💰 Budget set to *1 SOL/day*', KB.budget()); return true; }
  if (data === 'budget_0') { BotState.dailyBudgetSol = 0; await editMenu(cid, msgId, '💰 Budget set to *Unlimited*', KB.budget()); return true; }
  if (data === 'budget_set') { awaitingInput.set(cid, { type: 'budget_set', prompt: '💰 Enter max SOL to spend per day:\n_e.g. `1.0` — type `0` for unlimited_' }); await sendTelegramAlert('💰 Enter daily budget in SOL (0 = unlimited):'); return true; }

  // ── Mcap Menu ──
  if (data === 'mcap_menu') {
    await editMenu(cid, msgId,
      `📊 *Market Cap Filter*\nSkips tokens already above this market cap.\nCurrently: *${BotState.maxMarketCapUsd === 0 ? 'Disabled' : '$' + (BotState.maxMarketCapUsd/1000).toFixed(0) + 'k'}*`,
      KB.mcap()
    );
    return true;
  }
  if (data === 'mcap_100k') { BotState.maxMarketCapUsd = 100000; await editMenu(cid, msgId, '📊 Max mcap set to *$100k*', KB.mcap()); return true; }
  if (data === 'mcap_500k') { BotState.maxMarketCapUsd = 500000; await editMenu(cid, msgId, '📊 Max mcap set to *$500k*', KB.mcap()); return true; }
  if (data === 'mcap_0') { BotState.maxMarketCapUsd = 0; await editMenu(cid, msgId, '📊 Market cap filter *disabled*', KB.mcap()); return true; }
  if (data === 'mcap_set') { awaitingInput.set(cid, { type: 'mcap_set', prompt: '📊 Enter max market cap in USD:\n_e.g. `500000` for $500k — `0` to disable_' }); await sendTelegramAlert('📊 Enter max market cap in USD:'); return true; }

  // ── Token Age Menu ──
  if (data === 'tokenage_menu') {
    await editMenu(cid, msgId,
      `⏱ *Token Age Filter*\nOnly snipes tokens newer than this.\nCurrently: *${BotState.maxTokenAgeSec || 300}s (${((BotState.maxTokenAgeSec||300)/60).toFixed(1)} min)*`,
      KB.tokenage()
    );
    return true;
  }
  if (data === 'age_60') { BotState.maxTokenAgeSec = 60; await editMenu(cid, msgId, '⏱ Max token age set to *60s (1 min)*', KB.tokenage()); return true; }
  if (data === 'age_120') { BotState.maxTokenAgeSec = 120; await editMenu(cid, msgId, '⏱ Max token age set to *120s (2 min)*', KB.tokenage()); return true; }
  if (data === 'age_300') { BotState.maxTokenAgeSec = 300; await editMenu(cid, msgId, '⏱ Max token age set to *300s (5 min)*', KB.tokenage()); return true; }
  if (data === 'tokenage_set') { awaitingInput.set(cid, { type: 'tokenage_set', prompt: '⏱ Enter max token age in seconds:\n_e.g. `120` for 2 minutes_' }); await sendTelegramAlert('⏱ Enter max token age in seconds:'); return true; }

  // ── Whale Menu ──
  if (data === 'whale_menu') {
    const wallets = BotState.whaleWallets ? [...BotState.whaleWallets.entries()] : [];
    const list = wallets.length > 0
      ? wallets.map(([addr, d]) => `• *${d.label}* ${d.autoBuy ? '⚡' : '👁'} \`${addr.slice(0,12)}...\``).join('\n')
      : '_No whale wallets yet_';
    await editMenu(cid, msgId, `🐳 *Whale Wallets*\n⚡ = Auto-Buy | 👁 = Alert Only\n\n${list}`, KB.whale());
    return true;
  }
  if (data === 'whale_add_alert') {
    awaitingInput.set(cid, { type: 'whale_add_alert', prompt: '🐳 Enter wallet address and label:\n_e.g. `WALLETADDRESS AlphaSniper`_' });
    await sendTelegramAlert('🐳 Paste wallet address (and optional label):');
    return true;
  }
  if (data === 'whale_add_auto') {
    awaitingInput.set(cid, { type: 'whale_add_auto', prompt: '🐳 Enter wallet address and label:\n_e.g. `WALLETADDRESS AlphaSniper`_\n⚡ Bot will auto-buy whatever they buy!' });
    await sendTelegramAlert('🐳 Paste wallet address (and optional label) — will AUTO-BUY:');
    return true;
  }
  if (data === 'whale_list') {
    const wallets = BotState.whaleWallets ? [...BotState.whaleWallets.entries()] : [];
    if (!wallets.length) { await sendTelegramAlert('🐳 No whale wallets added yet'); return true; }
    const list = wallets.map(([addr, d], i) => `${i+1}. *${d.label}* ${d.autoBuy ? '⚡ Auto-Buy' : '👁 Alert'}\n   \`${addr}\``).join('\n\n');
    await sendTelegramAlert(`🐳 *Whale Wallets*\n\n${list}`);
    return true;
  }
  if (data === 'whale_remove') {
    awaitingInput.set(cid, { type: 'whale_remove_addr', prompt: '🐳 Enter wallet address to remove:' });
    await sendTelegramAlert('🐳 Paste the wallet address to remove:');
    return true;
  }

  // ── News Feed Menu ──
  if (data === 'news_menu') {
    if (!BotState.newsFeed) BotState.newsFeed = { enabled: false };
    await editMenu(cid, msgId, '📰 *News Feed Monitor*\nTracks trending tokens and social signals.', KB.news());
    return true;
  }
  if (data === 'toggle_news') {
    if (!BotState.newsFeed) BotState.newsFeed = { enabled: false };
    BotState.newsFeed.enabled = !BotState.newsFeed.enabled;
    await editMenu(cid, msgId, `📰 News Feed: ${BotState.newsFeed.enabled ? '✅ ON' : '❌ OFF'}`, KB.news());
    return true;
  }
  if (data === 'news_now') {
    await sendTelegramAlert('📰 Fetching trending tokens...');
    try {
      const fetch = (await import('node-fetch')).default;
      const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 6000 });
      const boosts = await res.json();
      const sol = (boosts || []).filter(b => b.chainId === 'solana').slice(0, 5);
      if (!sol.length) { await sendTelegramAlert('📰 No trending Solana tokens right now'); return true; }
      let msg = '📰 *Top Trending Solana Tokens*\n\n';
      sol.forEach((b, i) => {
        msg += `${i+1}. *${b.description || 'Unknown'}*\n   \`${b.tokenAddress?.slice(0,20)}...\`\n   [DexScreener](https://dexscreener.com/solana/${b.tokenAddress})\n\n`;
      });
      await sendTelegramAlert(msg);
    } catch (e) { await sendTelegramAlert('📰 Could not fetch trending tokens'); }
    return true;
  }

  return false; // not handled here
}

module.exports = { startTelegramBot, sendTelegramAlert };

// ── New Feature Commands ──────────────────────────────────────────
// These are appended to the existing telegram.js

// Re-export sendTelegramAlert (already exported above)
// Add whale commands via text
if (typeof bot !== 'undefined' && bot) {
  bot.onText(/\/whale (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    const parts = match[1].trim().split(' ');
    const address = parts[0];
    const label = parts[1] || 'Whale';
    const autoBuy = parts[2] === 'auto';
    const { addWhaleWallet } = require('../features/features16');
    addWhaleWallet(address, label, autoBuy);
    await sendTelegramAlert(
      `🐳 *Whale Wallet Added*\n` +
      `Label: *${label}*\n` +
      `\`${address.slice(0,16)}...\`\n` +
      `Auto-Buy: ${autoBuy ? '✅ ON' : '❌ OFF (alert only)'}\n\n` +
      `_Usage: /whale ADDRESS LABEL auto_`
    );
  });

  bot.onText(/\/summary/, async (msg) => {
    if (!guard(msg)) return;
    const { sendTradeSummary } = require('../features/features16');
    await sendTradeSummary();
  });

  bot.onText(/\/budget (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    const val = parseFloat(match[1]);
    if (isNaN(val)) return sendTelegramAlert('Usage: /budget 1.0 (SOL per day, 0 = unlimited)');
    BotState.dailyBudgetSol = val;
    await sendTelegramAlert(`💰 Daily budget set to *${val === 0 ? 'Unlimited' : val + ' SOL'}*`);
  });

  bot.onText(/\/mcap (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    const val = parseFloat(match[1]);
    BotState.maxMarketCapUsd = val;
    await sendTelegramAlert(`📊 Max market cap set to *${val === 0 ? 'Disabled' : '$' + val.toLocaleString()}*`);
  });

  bot.onText(/\/tokenage (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    const val = parseInt(match[1]);
    BotState.maxTokenAgeSec = val;
    await sendTelegramAlert(`⏱ Max token age set to *${val}s (${(val/60).toFixed(1)} min)*`);
  });

  bot.onText(/\/trailstop (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    const val = parseFloat(match[1]);
    BotState.trailingStopPct = val;
    await sendTelegramAlert(`📉 Trailing stop loss set to *${val}% from peak*`);
  });

  bot.onText(/\/partialtp/, async (msg) => {
    if (!guard(msg)) return;
    BotState.partialTP.enabled = !BotState.partialTP.enabled;
    await sendTelegramAlert(
      `🎯 *Partial Take Profit*: ${BotState.partialTP.enabled ? '✅ ON' : '❌ OFF'}\n\n` +
      `Stages:\n` +
      `• Sell 50% at 2x\n` +
      `• Sell 25% at 5x\n` +
      `• Sell 25% at 10x`
    );
  });

  bot.onText(/\/honeypot/, async (msg) => {
    if (!guard(msg)) return;
    BotState.honeypotCheck = !BotState.honeypotCheck;
    await sendTelegramAlert(`🍯 Honeypot detector: ${BotState.honeypotCheck ? '✅ ON' : '❌ OFF'}`);
  });

  bot.onText(/\/twitter/, async (msg) => {
    if (!guard(msg)) return;
    BotState.twitterCheck.enabled = !BotState.twitterCheck.enabled;
    await sendTelegramAlert(`🐦 Twitter sentiment check: ${BotState.twitterCheck.enabled ? '✅ ON' : '❌ OFF'}`);
  });

  bot.onText(/\/briefing/, async (msg) => {
    if (!guard(msg)) return;
    const { sendMorningBriefing } = require('../features/features16');
    await sendMorningBriefing();
  });

  bot.onText(/\/report/, async (msg) => {
    if (!guard(msg)) return;
    const { sendDailyReport } = require('../features/features16');
    await sendDailyReport();
  });
}
