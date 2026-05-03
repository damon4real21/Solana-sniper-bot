# 🎯 Solana Sniper Bot

Automated memecoin sniper for **pump.fun**, **DexScreener**, and **Raydium** — controlled entirely from Telegram.

## Features

- ⚡ Real-time sniping from 3 sources simultaneously
- 🛡 Rug pull detection (mint authority, freeze authority, liquidity, RugCheck.xyz)
- 🔐 MEV protection (priority fees + optional Jito bundles)
- 🤖 Full Telegram control panel
- 📈 Auto take-profit & stop-loss
- 📊 P&L tracking & trade history
- 🚫 Token blacklist system
- 💰 Jupiter V6 swaps (best price routing)

---

## Setup

### 1. Clone & Install
```bash
git clone <your-repo>
cd solana-sniper-bot
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
nano .env   # Fill in your values
```

Required values:
- `TELEGRAM_BOT_TOKEN` — from @BotFather on Telegram
- `TELEGRAM_CHAT_ID` — your Telegram user ID (get from @userinfobot)
- `PRIVATE_KEY` — your Solana wallet private key (base58)

### 3. Run
```bash
npm start
```

---

## Free 24/7 Hosting Options

### Koyeb (Recommended — truly free)
1. Push code to GitHub
2. Go to koyeb.com → New App → GitHub
3. Build: `npm install` | Run: `node index.js`
4. Add all env vars in the Koyeb dashboard

### Render (Free tier)
1. Push to GitHub
2. render.com → New Web Service → Connect repo
3. Build Command: `npm install`
4. Start Command: `node index.js`
5. Add env vars

### Railway
```bash
railway init
railway up
railway variables set KEY=VALUE
```

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/snipe` | Start sniping |
| `/stop` | Stop sniping |
| `/status` | Full bot status |
| `/positions` | Open positions |
| `/sell [mint]` | Sell specific token |
| `/sellall` | Sell all positions |
| `/history` | Last 10 trades |
| `/stats` | Win/loss stats & P&L |
| `/wallet` | SOL balance |
| `/config` | Current settings |
| `/set key value` | Update a setting |
| `/sources` | Toggle sources |
| `/togglepump` | Toggle pump.fun |
| `/toggledex` | Toggle DexScreener |
| `/toggleray` | Toggle Raydium |
| `/blacklist [mint]` | Blacklist token |
| `/mev` | Toggle Jito MEV |

### Configurable Settings via `/set`
```
/set buy_sol 0.05        — Buy amount in SOL
/set slippage 500        — Slippage in bps (500 = 5%)
/set priority_fee 100000 — Priority fee in lamports
/set take_profit 3       — Sell at 3x
/set stop_loss 40        — Sell at -40%
/set min_liquidity 1000  — Min liquidity in USD
/set auto_sell true      — Auto take profit/stop loss
```

---

## Rug Pull Checks

Every token is checked before buying:
1. ✅ Mint authority renounced
2. ✅ Freeze authority renounced  
3. ✅ Minimum liquidity threshold
4. ✅ Top 10 holder concentration
5. ✅ RugCheck.xyz external score
6. ✅ Token blacklist

---

## MEV Protection

- **Default**: High priority fee (faster inclusion, front-run resistance)
- **Jito mode** (`/mev`): Submits as a private bundle to Jito block engine — completely bypasses public mempool, eliminating sandwich attacks

---

## Architecture

```
index.js              ← Entry point
config.js             ← Central config
bot/telegram.js       ← Telegram command handler
sniper/
  pumpfun.js          ← WebSocket listener (wss://pumpportal.fun)
  dexscreener.js      ← REST poller (new pairs)
  raydium.js          ← On-chain log subscription
security/
  rugcheck.js         ← Multi-layer rug detection
  mev.js              ← Jito + priority fee protection
trader/
  executor.js         ← Jupiter V6 buy/sell + position monitor
utils/
  state.js            ← Global bot state
  wallet.js           ← Solana connection + keypair
  logger.js           ← Colored console logger
```

---

## Ideas to Add Next

- [ ] Copy trading (mirror profitable wallets)
- [ ] Twitter/X sentiment scanner before buying
- [ ] Dev wallet sell tracker
- [ ] Volume spike detector (DexScreener trending)
- [ ] Multi-wallet spread buys
- [ ] Liquidity lock verifier (Streamflow/Locker)
- [ ] Holder concentration live check
- [ ] Telegram inline keyboard UI
- [ ] Web dashboard

---

## ⚠️ Disclaimer

Trading memecoins carries extreme risk. Only use funds you can afford to lose entirely. This bot is a tool — not financial advice.
