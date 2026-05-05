const TelegramBot = require('node-telegram-bot-api');
const { BotState } = require('../utils/state');
const { executeSell } = require('../trader/executor');
const { getSolBalance, getPublicKey } = require('../utils/wallet');
const config = require('../config');
const logger = require('../utils/logger');

let bot = null;
const chatId = config.telegram.chatId;

// ── Guard ─────────────────────────────────────────────────────────────────────
function guard(msg) {
  const id = msg?.chat?.id?.toString() || msg?.toString();
  return id === chatId?.toString();
}

// ── Send alert ────────────────────────────────────────────────────────────────
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

// ── Keyboards ─────────────────────────────────────────────────────────────────
function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: BotState.sniping ? '⏹ Stop Sniping' : '▶️ Start Sniping', callback_data: 'toggle_snipe' },
        { text: '📊 Status', callback_data: 'status' },
      ],
      [
        { text: '💼 Positions', callback_data: 'positions' },
        { text: '📜 History', callback_data: 'history' },
        { text: '👛 Wallet', callback_data: 'wallet' },
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
        { text: '🚫 Blacklist', callback_data: 'blacklist_menu' },
      ],
      [
        { text: '🐳 Whale Watch', callback_data: 'whale_menu' },
        { text: '📋 Trade Summary', callback_data: 'trade_summary' },
      ],
      [
        { text: `🍯 Honeypot ${BotState.honeypotCheck ? '✅' : '❌'}`, callback_data: 'toggle_honeypot' },
        { text: `🎯 Partial TP ${BotState.partialTP?.enabled ? '✅' : '❌'}`, callback_data: 'toggle_partialtp' },
      ],
      [
        { text: '📉 Trail Stop', callback_data: 'trail_menu' },
        { text: '💰 Budget', callback_data: 'budget_menu' },
        { text: '📊 Mcap', callback_data: 'mcap_menu' },
      ],
      [
        { text: '⏱ Token Age', callback_data: 'tokenage_menu' },
        { text: `🐦 Twitter ${BotState.twitterCheck?.enabled ? '✅' : '❌'}`, callback_data: 'toggle_twitter' },
      ],
      [
        { text: '🌅 Morning Briefing', callback_data: 'briefing_now' },
        { text: '📈 P&L Report', callback_data: 'report_now' },
      ],
      [
        { text: `🎓 Migrated ${BotState.sources?.migrated ? '✅' : '❌'}`, callback_data: 'migration_menu' },
        { text: `⏳ Soon Migrated ${BotState.sources?.soonMigrated ? '✅' : '❌'}`, callback_data: 'soonmigrated_menu' },
      ],
      [
        { text: '🫧 BubbleMaps Settings', callback_data: 'bubblemap_menu' },
      ],
    ],
  };
}

function sourcesKeyboard() {
  const s = BotState.sources;
  return {
    inline_keyboard: [
      [
        { text: `pump.fun ${s.pumpfun ? '✅' : '❌'}`, callback_data: 'toggle_pumpfun' },
        { text: `DexScreener ${s.dexscreener ? '✅' : '❌'}`, callback_data: 'toggle_dexscreener' },
        { text: `Raydium ${s.raydium ? '✅' : '❌'}`, callback_data: 'toggle_raydium' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  };
}

function settingsKeyboard() {
  return {
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
        { text: `🔑 Mint Ren: ${BotState.rugFilter.requireMintRenounced ? '✅' : '❌'}`, callback_data: 'toggle_mint' },
        { text: `❄️ Freeze Ren: ${BotState.rugFilter.requireFreezeRenounced ? '✅' : '❌'}`, callback_data: 'toggle_freeze' },
      ],
      [{ text: '« Back', callback_data: 'main_menu' }],
    ],
  };
}

const backKeyboard = { inline_keyboard: [[{ text: '« Main Menu', callback_data: 'main_menu' }]] };

// ── Awaiting input ────────────────────────────────────────────────────────────
const awaitingInput = new Map();

// ── Start bot ─────────────────────────────────────────────────────────────────
async function startTelegramBot() {
  bot = new TelegramBot(config.telegram.token, { polling: true });
  bot.on('polling_error', err => logger.error('TG poll error:', err.message));

  // ── Text commands ──
  bot.onText(/\/start|\/menu/, async (msg) => {
    if (!guard(msg)) return;
    await sendMenu();
  });

  bot.onText(/\/snipe/, async (msg) => {
    if (!guard(msg)) return;
    BotState.sniping = true;
    await sendTelegramAlert('🟢 *Sniping STARTED*', { reply_markup: mainKeyboard() });
  });

  bot.onText(/\/stop/, async (msg) => {
    if (!guard(msg)) return;
    BotState.sniping = false;
    await sendTelegramAlert('🔴 *Sniping STOPPED*', { reply_markup: mainKeyboard() });
  });

  bot.onText(/\/summary/, async (msg) => {
    if (!guard(msg)) return;
    try { const { sendTradeSummary } = require('../features/features16'); await sendTradeSummary(); } catch (e) { await sendTelegramAlert('❌ ' + e.message); }
  });

  bot.onText(/\/report/, async (msg) => {
    if (!guard(msg)) return;
    try { const { sendDailyReport } = require('../features/features16'); await sendDailyReport(); } catch (e) { await sendTelegramAlert('❌ ' + e.message); }
  });

  bot.onText(/\/briefing/, async (msg) => {
    if (!guard(msg)) return;
    try { const { sendMorningBriefing } = require('../features/features16'); await sendMorningBriefing(); } catch (e) { await sendTelegramAlert('❌ ' + e.message); }
  });

  bot.onText(/\/budget (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    const v = parseFloat(match[1]);
    if (isNaN(v)) return;
    BotState.dailyBudgetSol = v;
    await sendTelegramAlert(`💰 Daily budget: *${v === 0 ? 'Unlimited' : v + ' SOL/day'}*`);
  });

  bot.onText(/\/mcap (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    const v = parseFloat(match[1]);
    BotState.maxMarketCapUsd = v;
    await sendTelegramAlert(`📊 Max mcap: *${v === 0 ? 'Disabled' : '$' + v.toLocaleString()}*`);
  });

  bot.onText(/\/tokenage (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    BotState.maxTokenAgeSec = parseInt(match[1]);
    await sendTelegramAlert(`⏱ Max token age: *${match[1]}s*`);
  });

  bot.onText(/\/trailstop (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    BotState.trailingStopPct = parseFloat(match[1]);
    await sendTelegramAlert(`📉 Trailing stop: *${match[1]}% from peak*`);
  });

  bot.onText(/\/whale (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    const parts = match[1].trim().split(' ');
    const address = parts[0]; const label = parts[1] || 'Whale'; const autoBuy = parts[2] === 'auto';
    try { const { addWhaleWallet } = require('../features/features16'); addWhaleWallet(address, label, autoBuy); } catch (_) {}
    await sendTelegramAlert(`🐳 Watching *${label}*\n\`${address.slice(0,16)}...\`\nAuto-Buy: ${autoBuy ? '✅' : '❌'}`);
  });

  bot.onText(/\/blacklist (.+)/, async (msg, match) => {
    if (!guard(msg)) return;
    BotState.addBlacklist(match[1].trim());
    await sendTelegramAlert(`🚫 Blacklisted: \`${match[1].trim()}\``);
  });

  bot.onText(/\/sellall/, async (msg) => {
    if (!guard(msg)) return;
    if (BotState.positions.size === 0) { await sendTelegramAlert('📭 No open positions'); return; }
    await sendTelegramAlert(`🔄 Selling all ${BotState.positions.size} positions...`);
    for (const mint of [...BotState.positions.keys()]) await executeSell(mint, 'Sell All').catch(() => {});
  });

  // ── Callback buttons ──
  bot.on('callback_query', handleCallback);

  // ── Free text replies ──
  bot.on('message', handleFreeText);

  // Send welcome message
  await sendTelegramAlert(
    `🚀 *SolSnipe Bot v3 Online!*\n` +
    `All 16 features active\n\n` +
    `Tap *▶️ Start Sniping* to begin:`,
    { reply_markup: mainKeyboard() }
  );

  return bot;
}

// ── Send / refresh menu ───────────────────────────────────────────────────────
async function sendMenu(text) {
  await sendTelegramAlert(
    text || `🎯 *SolSnipe Control Panel*\nStatus: ${BotState.sniping ? '🟢 ACTIVE' : '🔴 STOPPED'}`,
    { reply_markup: mainKeyboard() }
  );
}

// ── Callback handler ──────────────────────────────────────────────────────────
async function handleCallback(query) {
  const cid = query.message?.chat?.id?.toString();
  if (cid !== chatId?.toString()) return;
  const data = query.data;
  const msgId = query.message?.message_id;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  const edit = async (text, keyboard) => {
    try {
      await bot.editMessageText(text, {
        chat_id: cid, message_id: msgId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: keyboard || mainKeyboard(),
      });
    } catch (_) {
      await sendTelegramAlert(text, { reply_markup: keyboard || mainKeyboard() });
    }
  };

  // ── Main menu ──
  if (data === 'main_menu') {
    await edit(`🎯 *SolSnipe Control Panel*\nStatus: ${BotState.sniping ? '🟢 ACTIVE' : '🔴 STOPPED'}`, mainKeyboard());
    return;
  }

  // ── Toggle snipe (START / STOP) ──
  if (data === 'toggle_snipe') {
    BotState.sniping = !BotState.sniping;
    if (BotState.sniping) {
      await edit(
        `🟢 *Sniping STARTED!*\n\n` +
        `Buy: ${BotState.sniper.buyAmountSol} SOL\n` +
        `Slippage: ${BotState.sniper.slippageBps / 100}%\n` +
        `Take Profit: ${BotState.autoSell.takeProfitMultiplier}x\n` +
        `Stop Loss: -${BotState.autoSell.stopLossPct}%\n` +
        `Honeypot: ${BotState.honeypotCheck ? '✅' : '❌'}\n` +
        `Partial TP: ${BotState.partialTP?.enabled ? '✅' : '❌'}\n\n` +
        `_Watching all 3 sources..._`,
        mainKeyboard()
      );
    } else {
      await edit(`🔴 *Sniping STOPPED*\nOpen positions: ${BotState.positions.size}`, mainKeyboard());
    }
    return;
  }

  // ── Status ──
  if (data === 'status') {
    const s = BotState.getSummary();
    const bal = await getSolBalance().catch(() => '?');
    await edit(
      `📊 *Status*\n\n` +
      `Sniping: ${s.sniping ? '🟢 ON' : '🔴 OFF'}\n` +
      `Balance: ${typeof bal === 'number' ? bal.toFixed(4) : bal} SOL\n\n` +
      `*Sources:*\n` +
      `pump.fun: ${s.sources.pumpfun ? '✅' : '❌'} | DEX: ${s.sources.dexscreener ? '✅' : '❌'} | Raydium: ${s.sources.raydium ? '✅' : '❌'}\n\n` +
      `*Performance:*\n` +
      `Sniped: ${s.sniped} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `Win Rate: ${s.winRate}%\n` +
      `Total P&L: ${parseFloat(s.totalPnlSol) >= 0 ? '+' : ''}${s.totalPnlSol} SOL\n` +
      `Open Positions: ${s.positions}\n\n` +
      `*Settings:*\n` +
      `Buy: ${BotState.sniper.buyAmountSol} SOL | Slip: ${BotState.sniper.slippageBps/100}%\n` +
      `TP: ${BotState.autoSell.takeProfitMultiplier}x | SL: -${BotState.autoSell.stopLossPct}%\n` +
      `MEV: ${BotState.mev?.useJito ? '🛡 Jito' : '⚡ Priority Fee'}`,
      backKeyboard
    );
    return;
  }

  // ── Positions ──
  if (data === 'positions') {
    if (BotState.positions.size === 0) { await edit('📭 No open positions', backKeyboard); return; }
    let txt = `💼 *Open Positions (${BotState.positions.size})*\n\n`;
    const rows = [];
    for (const [mint, p] of BotState.positions.entries()) {
      const age = Math.floor((Date.now() - p.buyTime) / 60000);
      txt += `• *${p.symbol}* (${p.source}) — ${age}m\n  \`${mint.slice(0,16)}...\`\n`;
      rows.push([{ text: `💊 Sell ${p.symbol}`, callback_data: `sell_${mint}` }]);
    }
    rows.push([{ text: '💣 Sell ALL', callback_data: 'sell_all' }, { text: '« Back', callback_data: 'main_menu' }]);
    await edit(txt, { inline_keyboard: rows });
    return;
  }

  // ── Sell individual ──
  if (data.startsWith('sell_') && data !== 'sell_all') {
    const mint = data.replace('sell_', '');
    await sendTelegramAlert(`🔄 Selling \`${mint.slice(0,12)}...\``);
    await executeSell(mint, 'Button Sell').catch(() => {});
    return;
  }

  // ── Sell all ──
  if (data === 'sell_all') {
    if (BotState.positions.size === 0) { await sendTelegramAlert('📭 No positions'); return; }
    await sendTelegramAlert(`🔄 Selling all ${BotState.positions.size}...`);
    for (const mint of [...BotState.positions.keys()]) await executeSell(mint, 'Sell All').catch(() => {});
    return;
  }

  // ── History ──
  if (data === 'history') {
    const trades = BotState.tradeHistory.slice(0, 10);
    if (!trades.length) { await edit('📭 No history yet', backKeyboard); return; }
    let txt = `📜 *Last ${trades.length} Trades*\n\n`;
    for (const t of trades) {
      txt += `${t.pnlSol >= 0 ? '🟢' : '🔴'} *${t.symbol}* | ${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol?.toFixed(4)} SOL | ${t.reason}\n`;
    }
    await edit(txt, backKeyboard);
    return;
  }

  // ── Wallet ──
  if (data === 'wallet') {
    const bal = await getSolBalance().catch(() => '?');
    const pub = getPublicKey().toString();
    await edit(
      `👛 *Wallet*\n\n\`${pub}\`\n\nBalance: *${typeof bal === 'number' ? bal.toFixed(6) : bal} SOL*\n[View on Solscan](https://solscan.io/account/${pub})`,
      backKeyboard
    );
    return;
  }

  // ── Sources ──
  if (data === 'sources_menu') { await edit('📡 *Sources* — tap to toggle:', sourcesKeyboard()); return; }
  if (data === 'toggle_pumpfun') { BotState.sources.pumpfun = !BotState.sources.pumpfun; await edit(`pump.fun: ${BotState.sources.pumpfun ? '✅ ON' : '❌ OFF'}`, sourcesKeyboard()); return; }
  if (data === 'toggle_dexscreener') { BotState.sources.dexscreener = !BotState.sources.dexscreener; await edit(`DexScreener: ${BotState.sources.dexscreener ? '✅ ON' : '❌ OFF'}`, sourcesKeyboard()); return; }
  if (data === 'toggle_raydium') { BotState.sources.raydium = !BotState.sources.raydium; await edit(`Raydium: ${BotState.sources.raydium ? '✅ ON' : '❌ OFF'}`, sourcesKeyboard()); return; }

  // ── Settings ──
  if (data === 'settings_menu') { await edit('⚙️ *Settings* — tap to change:', settingsKeyboard()); return; }
  if (data === 'toggle_autosell') { BotState.autoSell.enabled = !BotState.autoSell.enabled; await edit(`Auto-Sell: ${BotState.autoSell.enabled ? '✅ ON' : '❌ OFF'}`, settingsKeyboard()); return; }
  if (data === 'toggle_mint') { BotState.rugFilter.requireMintRenounced = !BotState.rugFilter.requireMintRenounced; await edit(`Mint Renounced: ${BotState.rugFilter.requireMintRenounced ? '✅' : '❌'}`, settingsKeyboard()); return; }
  if (data === 'toggle_freeze') { BotState.rugFilter.requireFreezeRenounced = !BotState.rugFilter.requireFreezeRenounced; await edit(`Freeze Renounced: ${BotState.rugFilter.requireFreezeRenounced ? '✅' : '❌'}`, settingsKeyboard()); return; }

  // ── MEV ──
  if (data === 'mev_toggle') {
    if (!BotState.mev) BotState.mev = {};
    BotState.mev.useJito = !BotState.mev.useJito;
    config.mev = config.mev || {};
    config.mev.useJito = BotState.mev.useJito;
    await edit(`🛡 *MEV Protection*\nJito Bundles: ${BotState.mev.useJito ? '✅ ON' : '❌ OFF'}`, backKeyboard);
    return;
  }

  // ── Toggles ──
  if (data === 'toggle_honeypot') { BotState.honeypotCheck = !BotState.honeypotCheck; await edit(`🍯 Honeypot: ${BotState.honeypotCheck ? '✅ ON' : '❌ OFF'}`, mainKeyboard()); return; }
  if (data === 'toggle_partialtp') {
    if (!BotState.partialTP) BotState.partialTP = { enabled: false };
    BotState.partialTP.enabled = !BotState.partialTP.enabled;
    await edit(`🎯 Partial TP: ${BotState.partialTP.enabled ? '✅ ON' : '❌ OFF'}\n\nStages:\n• Sell 50% at 2x\n• Sell 25% at 5x\n• Sell 25% at 10x`, mainKeyboard());
    return;
  }
  if (data === 'toggle_twitter') {
    if (!BotState.twitterCheck) BotState.twitterCheck = { enabled: false };
    BotState.twitterCheck.enabled = !BotState.twitterCheck.enabled;
    await edit(`🐦 Twitter check: ${BotState.twitterCheck.enabled ? '✅ ON' : '❌ OFF'}`, mainKeyboard());
    return;
  }

  // ── Feature menus with input prompts ──
  const inputMap = {
    set_buy:      '💰 Enter buy amount in SOL:\n_e.g. `0.05`_',
    set_slip:     '📉 Enter slippage %:\n_e.g. `5`_',
    set_tp:       '🎯 Enter take profit multiplier:\n_e.g. `3`_',
    set_sl:       '🛑 Enter stop loss %:\n_e.g. `40`_',
    set_liq:      '💧 Enter min liquidity USD:\n_e.g. `10000`_',
    trail_menu:   '📉 Enter trailing stop % from peak:\n_e.g. `25`_',
    budget_menu:  '💰 Enter daily budget in SOL (0=unlimited):\n_e.g. `1.0`_',
    mcap_menu:    '📊 Enter max market cap in USD (0=disabled):\n_e.g. `500000`_',
    tokenage_menu:'⏱ Enter max token age in seconds:\n_e.g. `120`_',
    whale_menu:   '🐳 Enter: `ADDRESS LABEL auto`\n_Example: `ABC123 MyWhale auto`\nRemove `auto` for alert-only_',
    blacklist_menu:'🚫 Enter token mint to blacklist:',
    copy_menu:    '👥 Enter wallet address to mirror:\n_Paste full Solana address_',
    vol_menu:     '📈 Enter min 1h volume USD:\n_e.g. `5000`_',
    mw_menu:      '🔀 Enter sub-wallet private key:\n_⚠️ Use funded burner wallet only_',
  };

  if (inputMap[data]) {
    awaitingInput.set(cid, { type: data });
    await sendTelegramAlert(inputMap[data]);
    return;
  }

  // ── Trade summary ──
  if (data === 'trade_summary') {
    try { const { sendTradeSummary } = require('../features/features16'); await sendTradeSummary(); } catch (e) { await sendTelegramAlert('❌ ' + e.message); }
    return;
  }

  // ── Migration menus ──
  if (data === 'migration_menu') {
    const { getMigrationStatus, enableMigrated, disableMigrated } = require('../sniper/migrations');
    const ms = getMigrationStatus();
    await edit(
      `🎓 *Migrated Token Sniper*\n\n` +
      `Catches tokens that just graduated\nfrom pump.fun → Raydium\n\n` +
      `Status: ${ms.migrated.enabled ? '✅ ON' : '❌ OFF'}\n` +
      `Auto-Buy: ${ms.migrated.autoBuy ? '✅ ON' : '❌ OFF'}\n` +
      `Tokens seen: ${ms.seenMigrated}\n\n` +
      `_Toggle below:_`,
      {
        inline_keyboard: [
          [
            { text: `${ms.migrated.enabled ? '⏹ Disable' : '▶️ Enable'} Alerts`, callback_data: 'toggle_migrated' },
          ],
          [
            { text: `Auto-Buy: ${ms.migrated.autoBuy ? '✅ ON' : '❌ OFF'}`, callback_data: 'toggle_migrated_auto' },
          ],
          [{ text: '« Back', callback_data: 'main_menu' }],
        ],
      }
    );
    return;
  }

  if (data === 'toggle_migrated') {
    const { getMigrationStatus, enableMigrated, disableMigrated } = require('../sniper/migrations');
    const ms = getMigrationStatus();
    if (ms.migrated.enabled) { disableMigrated(); await sendTelegramAlert('🎓 Migrated alerts: ❌ OFF'); }
    else { enableMigrated(ms.migrated.autoBuy); await sendTelegramAlert('🎓 Migrated alerts: ✅ ON\nYou will get a Telegram alert with CA for every token that graduates to Raydium!'); }
    return;
  }

  if (data === 'toggle_migrated_auto') {
    const { getMigrationStatus, enableMigrated, disableMigrated } = require('../sniper/migrations');
    const ms = getMigrationStatus();
    const newAuto = !ms.migrated.autoBuy;
    if (ms.migrated.enabled) enableMigrated(newAuto); else BotState.autoSnipeMigrated = newAuto;
    await sendTelegramAlert(`🎓 Migrated Auto-Buy: ${newAuto ? '✅ ON — will auto-snipe graduated tokens' : '❌ OFF — alerts only'}`);
    return;
  }

  if (data === 'soonmigrated_menu') {
    const { getMigrationStatus } = require('../sniper/migrations');
    const ms = getMigrationStatus();
    await edit(
      `⏳ *Soon-to-Migrate Sniper*\n\n` +
      `Catches tokens with bonding curve\n70%+ full — about to graduate\n\n` +
      `Status: ${ms.soonMigrated.enabled ? '✅ ON' : '❌ OFF'}\n` +
      `Auto-Buy: ${ms.soonMigrated.autoBuy ? '✅ ON' : '❌ OFF'}\n` +
      `Tokens seen: ${ms.seenSoon}\n\n` +
      `_Threshold: 70+ SOL in bonding curve_`,
      {
        inline_keyboard: [
          [
            { text: `${ms.soonMigrated.enabled ? '⏹ Disable' : '▶️ Enable'} Alerts`, callback_data: 'toggle_soonmigrated' },
          ],
          [
            { text: `Auto-Buy: ${ms.soonMigrated.autoBuy ? '✅ ON' : '❌ OFF'}`, callback_data: 'toggle_soonmigrated_auto' },
          ],
          [{ text: '« Back', callback_data: 'main_menu' }],
        ],
      }
    );
    return;
  }

  if (data === 'toggle_soonmigrated') {
    const { getMigrationStatus, enableSoonMigrated, disableSoonMigrated } = require('../sniper/migrations');
    const ms = getMigrationStatus();
    if (ms.soonMigrated.enabled) { disableSoonMigrated(); await sendTelegramAlert('⏳ Soon-Migrated alerts: ❌ OFF'); }
    else { enableSoonMigrated(ms.soonMigrated.autoBuy); await sendTelegramAlert('⏳ Soon-Migrated alerts: ✅ ON\nYou will get an alert with CA + bonding curve progress when a token is about to graduate!'); }
    return;
  }

  if (data === 'toggle_soonmigrated_auto') {
    const { getMigrationStatus, enableSoonMigrated } = require('../sniper/migrations');
    const ms = getMigrationStatus();
    const newAuto = !ms.soonMigrated.autoBuy;
    if (ms.soonMigrated.enabled) enableSoonMigrated(newAuto); else BotState.autoSnipeSoonMigrated = newAuto;
    await sendTelegramAlert(`⏳ Soon-Migrated Auto-Buy: ${newAuto ? '✅ ON' : '❌ OFF'}`);
    return;
  }

  // ── BubbleMaps settings ──
  if (data === 'bubblemap_menu') {
    if (!BotState.bubbleMapSettings) BotState.bubbleMapSettings = { maxClusterPct: 50, minDecentScore: 0, maxTop1Pct: 30, blockRisky: false };
    const bm = BotState.bubbleMapSettings;
    await edit(
      `🫧 *BubbleMaps Settings*\n\n` +
      `Checks connected wallets and cluster risk\nfor every migrated + soon-migrated token\n\n` +
      `*Current Limits:*\n` +
      `Max cluster % (skip if exceeded): *${bm.maxClusterPct}%*\n` +
      `Max #1 holder %: *${bm.maxTop1Pct}%*\n` +
      `Min decentralization score: *${bm.minDecentScore}/100*\n` +
      `Block risky tokens: *${bm.blockRisky ? '✅ ON' : '❌ OFF'}*\n\n` +
      `_Tap a setting to change it:_`,
      {
        inline_keyboard: [
          [
            { text: `🕸 Max Cluster: ${bm.maxClusterPct}%`, callback_data: 'set_bm_cluster' },
            { text: `👤 Max #1 Holder: ${bm.maxTop1Pct}%`, callback_data: 'set_bm_top1' },
          ],
          [
            { text: `📊 Min Score: ${bm.minDecentScore}`, callback_data: 'set_bm_score' },
            { text: `🚫 Block Risky: ${bm.blockRisky ? '✅' : '❌'}`, callback_data: 'toggle_bm_block' },
          ],
          [{ text: '« Back', callback_data: 'main_menu' }],
        ],
      }
    );
    return;
  }

  if (data === 'toggle_bm_block') {
    if (!BotState.bubbleMapSettings) BotState.bubbleMapSettings = { maxClusterPct: 50, minDecentScore: 0, maxTop1Pct: 30, blockRisky: false };
    BotState.bubbleMapSettings.blockRisky = !BotState.bubbleMapSettings.blockRisky;
    await sendTelegramAlert(
      BotState.bubbleMapSettings.blockRisky
        ? '🫧 BubbleMaps gate: ✅ ON\nTokens with risky clusters will be *blocked* from auto-buy'
        : '🫧 BubbleMaps gate: ❌ OFF\nBubbleMaps shows info only — does not block buys'
    );
    return;
  }

  if (['set_bm_cluster','set_bm_top1','set_bm_score'].includes(data)) {
    const prompts = {
      set_bm_cluster: 'Enter max cluster % (skip token if connected wallets hold more than this):\n_e.g. `50` — skip if cluster > 50%_',
      set_bm_top1: 'Enter max % for single top holder:\n_e.g. `30` — skip if #1 wallet > 30%_',
      set_bm_score: 'Enter minimum decentralization score (0=disabled):\n_e.g. `40` — skip if score below 40_',
    };
    awaitingInput.set(cid, { type: data });
    await sendTelegramAlert(prompts[data]);
    return;
  }

  // ── Briefing & Report ──
  if (data === 'briefing_now') {
    try { const { sendMorningBriefing } = require('../features/features16'); await sendMorningBriefing(); } catch (e) { await sendTelegramAlert('❌ ' + e.message); }
    return;
  }
  if (data === 'report_now') {
    try { const { sendDailyReport } = require('../features/features16'); await sendDailyReport(); } catch (e) { await sendTelegramAlert('❌ ' + e.message); }
    return;
  }
}

// ── Free text handler ─────────────────────────────────────────────────────────
async function handleFreeText(msg) {
  if (!guard(msg)) return;
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;
  const waiting = awaitingInput.get(cid);
  if (!waiting) return;
  awaitingInput.delete(cid);

  const handlers = {
    set_buy:       () => { const v = parseFloat(text); if (!isNaN(v) && v > 0) { BotState.sniper.buyAmountSol = v; return `✅ Buy amount: *${v} SOL*`; } return '❌ Invalid'; },
    set_slip:      () => { const v = parseFloat(text); if (!isNaN(v)) { BotState.sniper.slippageBps = Math.round(v * 100); return `✅ Slippage: *${v}%*`; } return '❌ Invalid'; },
    set_tp:        () => { const v = parseFloat(text); if (!isNaN(v)) { BotState.autoSell.takeProfitMultiplier = v; return `✅ Take Profit: *${v}x*`; } return '❌ Invalid'; },
    set_sl:        () => { const v = parseFloat(text); if (!isNaN(v)) { BotState.autoSell.stopLossPct = v; return `✅ Stop Loss: *-${v}%*`; } return '❌ Invalid'; },
    set_liq:       () => { const v = parseFloat(text); if (!isNaN(v)) { BotState.rugFilter.minLiquidityUsd = v; return `✅ Min Liquidity: *$${v}*`; } return '❌ Invalid'; },
    trail_menu:    () => { const v = parseFloat(text); if (!isNaN(v)) { BotState.trailingStopPct = v; return `✅ Trailing Stop: *${v}% from peak*`; } return '❌ Invalid'; },
    budget_menu:   () => { const v = parseFloat(text); if (!isNaN(v)) { BotState.dailyBudgetSol = v; return `✅ Daily Budget: *${v === 0 ? 'Unlimited' : v + ' SOL'}*`; } return '❌ Invalid'; },
    mcap_menu:     () => { const v = parseFloat(text); if (!isNaN(v)) { BotState.maxMarketCapUsd = v; return `✅ Max Mcap: *${v === 0 ? 'Disabled' : '$' + v.toLocaleString()}*`; } return '❌ Invalid'; },
    tokenage_menu: () => { const v = parseInt(text); if (!isNaN(v)) { BotState.maxTokenAgeSec = v; return `✅ Max Token Age: *${v}s*`; } return '❌ Invalid'; },
    blacklist_menu:() => { if (text.length > 20) { BotState.addBlacklist(text); return `🚫 Blacklisted:\n\`${text}\``; } return '❌ Invalid mint'; },
    whale_menu: () => {
      const parts = text.split(' ');
      const address = parts[0]; const label = parts[1] || 'Whale'; const autoBuy = parts[2] === 'auto';
      if (address.length < 30) return '❌ Invalid address';
      try { const { addWhaleWallet } = require('../features/features16'); addWhaleWallet(address, label, autoBuy); } catch (_) {}
      return `🐳 Watching *${label}*\nAuto-Buy: ${autoBuy ? '✅' : '❌ Alert only'}`;
    },
    copy_menu: () => {
      if (text.length < 30) return '❌ Invalid address';
      try { const { addWatchWallet } = require('../features/copytrader'); addWatchWallet(text, `Wallet${Date.now()}`); } catch (_) {}
      return `👥 Now mirroring:\n\`${text.slice(0,20)}...\``;
    },
    vol_menu: () => { const v = parseFloat(text); if (!isNaN(v)) { if (!BotState.volumeSpike) BotState.volumeSpike = {}; BotState.volumeSpike.minVolume1h = v; return `✅ Min Volume: *$${v}*`; } return '❌ Invalid'; },
    set_bm_cluster: () => {
      const v = parseFloat(text);
      if (isNaN(v) || v < 0 || v > 100) return '❌ Enter a number between 0-100';
      if (!BotState.bubbleMapSettings) BotState.bubbleMapSettings = {};
      BotState.bubbleMapSettings.maxClusterPct = v;
      return `✅ Max cluster: *${v}%*\nTokens where connected wallets hold >${v}% will be flagged`;
    },
    set_bm_top1: () => {
      const v = parseFloat(text);
      if (isNaN(v)) return '❌ Invalid';
      if (!BotState.bubbleMapSettings) BotState.bubbleMapSettings = {};
      BotState.bubbleMapSettings.maxTop1Pct = v;
      return `✅ Max #1 holder: *${v}%*`;
    },
    set_bm_score: () => {
      const v = parseFloat(text);
      if (isNaN(v)) return '❌ Invalid';
      if (!BotState.bubbleMapSettings) BotState.bubbleMapSettings = {};
      BotState.bubbleMapSettings.minDecentScore = v;
      return `✅ Min decentralization score: *${v}*\n${v === 0 ? 'Score gate disabled' : `Tokens scoring below ${v} will be flagged`}`;
    },
    mw_menu: () => {
      if (text.length < 40) return '❌ Invalid key';
      try { const { addSubWallet } = require('../features/multiwallet'); const r = addSubWallet(text, `W${Date.now()}`); return r.success ? `✅ Sub-wallet added` : `❌ ${r.reason}`; } catch (_) { return '❌ Error adding wallet'; }
    },
  };

  const handler = handlers[waiting.type];
  const result = handler ? handler() : '❌ Unknown input';
  await sendTelegramAlert(result, { reply_markup: backKeyboard });
}

module.exports = { startTelegramBot, sendTelegramAlert };
