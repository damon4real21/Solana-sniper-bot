// ═══════════════════════════════════════════════════════════════
// PERSISTENCE — saves and loads all bot settings to disk
// So settings survive Render restarts
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');
const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Save all settings to disk
function saveSettings(BotState) {
  try {
    ensureDataDir();
    const settings = {
      sniping: BotState.sniping,
      sources: BotState.sources,
      sniper: BotState.sniper,
      rugFilter: BotState.rugFilter,
      autoSell: BotState.autoSell,
      mev: BotState.mev,
      copyTrading: {
        enabled: BotState.copyTrading?.enabled || false,
      },
      volumeSpike: BotState.volumeSpike,
      multiWallet: {
        enabled: BotState.multiWallet?.enabled || false,
        perWalletSol: BotState.multiWallet?.perWalletSol || null,
      },
      trailingStopPct: BotState.trailingStopPct,
      partialTP: BotState.partialTP,
      dailyBudgetSol: BotState.dailyBudgetSol,
      maxMarketCapUsd: BotState.maxMarketCapUsd,
      maxTokenAgeSec: BotState.maxTokenAgeSec,
      minDeployerAgeDays: BotState.minDeployerAgeDays,
      honeypotCheck: BotState.honeypotCheck,
      twitterCheck: BotState.twitterCheck,
      bubbleMapSettings: BotState.bubbleMapSettings,
      autoSnipeMigrated: BotState.autoSnipeMigrated,
      autoSnipeSoonMigrated: BotState.autoSnipeSoonMigrated,
      blacklist: [...(BotState.blacklist || new Set())],
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[Persistence] Save error:', err.message);
  }
}

// Load settings from disk into BotState
function loadSettings(BotState) {
  try {
    ensureDataDir();
    if (!fs.existsSync(SETTINGS_FILE)) {
      console.log('[Persistence] No saved settings found — using defaults');
      return false;
    }

    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw);

    // Restore all settings
    if (settings.sniping !== undefined) BotState.sniping = settings.sniping;
    if (settings.sources) BotState.sources = { ...BotState.sources, ...settings.sources };
    if (settings.sniper) BotState.sniper = { ...BotState.sniper, ...settings.sniper };
    if (settings.rugFilter) BotState.rugFilter = { ...BotState.rugFilter, ...settings.rugFilter };
    if (settings.autoSell) BotState.autoSell = { ...BotState.autoSell, ...settings.autoSell };
    if (settings.mev) BotState.mev = { ...BotState.mev, ...settings.mev };
    if (settings.copyTrading) BotState.copyTrading = { ...BotState.copyTrading, ...settings.copyTrading };
    if (settings.volumeSpike) BotState.volumeSpike = { ...BotState.volumeSpike, ...settings.volumeSpike };
    if (settings.multiWallet) BotState.multiWallet = { ...BotState.multiWallet, ...settings.multiWallet };
    if (settings.trailingStopPct !== undefined) BotState.trailingStopPct = settings.trailingStopPct;
    if (settings.partialTP) BotState.partialTP = settings.partialTP;
    if (settings.dailyBudgetSol !== undefined) BotState.dailyBudgetSol = settings.dailyBudgetSol;
    if (settings.maxMarketCapUsd !== undefined) BotState.maxMarketCapUsd = settings.maxMarketCapUsd;
    if (settings.maxTokenAgeSec !== undefined) BotState.maxTokenAgeSec = settings.maxTokenAgeSec;
    if (settings.minDeployerAgeDays !== undefined) BotState.minDeployerAgeDays = settings.minDeployerAgeDays;
    if (settings.honeypotCheck !== undefined) BotState.honeypotCheck = settings.honeypotCheck;
    if (settings.twitterCheck) BotState.twitterCheck = settings.twitterCheck;
    if (settings.bubbleMapSettings) BotState.bubbleMapSettings = settings.bubbleMapSettings;
    if (settings.autoSnipeMigrated !== undefined) BotState.autoSnipeMigrated = settings.autoSnipeMigrated;
    if (settings.autoSnipeSoonMigrated !== undefined) BotState.autoSnipeSoonMigrated = settings.autoSnipeSoonMigrated;
    if (settings.blacklist?.length) {
      settings.blacklist.forEach(m => BotState.blacklist.add(m));
    }

    console.log(`[Persistence] ✅ Settings restored from ${settings.savedAt}`);
    return true;
  } catch (err) {
    console.error('[Persistence] Load error:', err.message);
    return false;
  }
}

// Auto-save every 2 minutes
function startAutoSave(BotState) {
  setInterval(() => saveSettings(BotState), 2 * 60 * 1000);
  console.log('[Persistence] Auto-save every 2 minutes ✅');
}

module.exports = { saveSettings, loadSettings, startAutoSave };
