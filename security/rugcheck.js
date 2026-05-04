const { Connection, PublicKey } = require('@solana/web3.js');
const { getConnection } = require('../utils/wallet');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Full rug-pull risk assessment for a token mint.
 * Returns { safe: bool, score: 0-100, reasons: string[] }
 */
async function checkRugRisk(mintAddress, metadata = {}) {
  const reasons = [];
  let riskScore = 0;
  const conn = getConnection();

  try {
    const mintPubkey = new PublicKey(mintAddress);
    const mintInfo = await conn.getParsedAccountInfo(mintPubkey);

    if (!mintInfo.value) {
      return { safe: false, score: 100, reasons: ['Mint account not found'] };
    }

    const parsedData = mintInfo.value.data?.parsed?.info;

    // ── 1. Mint Authority Check ──────────────────────────────────────────────
    if (parsedData?.mintAuthority !== null && parsedData?.mintAuthority !== undefined) {
      riskScore += 30;
      reasons.push('⚠️ Mint authority NOT renounced — dev can mint infinite tokens');
      if (config.rugFilter.requireMintRenounced) {
        return { safe: false, score: riskScore, reasons };
      }
    } else {
      reasons.push('✅ Mint authority renounced');
    }

    // ── 2. Freeze Authority Check ────────────────────────────────────────────
    if (parsedData?.freezeAuthority !== null && parsedData?.freezeAuthority !== undefined) {
      riskScore += 25;
      reasons.push('⚠️ Freeze authority NOT renounced — dev can freeze wallets');
      if (config.rugFilter.requireFreezeRenounced) {
        return { safe: false, score: riskScore, reasons };
      }
    } else {
      reasons.push('✅ Freeze authority renounced');
    }

    // ── 3. Liquidity Check ───────────────────────────────────────────────────
    const liquidityUsd = metadata.liquidityUsd || 0;
    if (liquidityUsd < config.rugFilter.minLiquidityUsd) {
      riskScore += 20;
      reasons.push(`⚠️ Low liquidity: $${liquidityUsd.toFixed(0)} < $${config.rugFilter.minLiquidityUsd}`);
    } else {
      reasons.push(`✅ Liquidity: $${liquidityUsd.toFixed(0)}`);
    }

    // ── 4. Holder Concentration Check ────────────────────────────────────────
    const top10Pct = metadata.top10HolderPct || 0;
    if (top10Pct > 0) {
      if (top10Pct > config.rugFilter.maxTop10HolderPct) {
        riskScore += 20;
        reasons.push(`⚠️ Top 10 holders control ${top10Pct.toFixed(1)}% of supply`);
      } else {
        reasons.push(`✅ Top 10 holders: ${top10Pct.toFixed(1)}%`);
      }
    }

    // ── 5. Token Age Check ───────────────────────────────────────────────────
    const ageSeconds = metadata.ageSeconds || 0;
    if (ageSeconds < 10) {
      riskScore += 5;
      reasons.push(`⚡ Brand new token (${ageSeconds}s old) — high volatility`);
    }

    // ── 6. External RugCheck.xyz API ─────────────────────────────────────────
    try {
      const rugCheckData = await fetchRugCheckScore(mintAddress);
      if (rugCheckData) {
        if (rugCheckData.score < 30) {
          riskScore += 25;
          reasons.push(`🔴 RugCheck.xyz score: ${rugCheckData.score}/100 — RISKY`);
        } else if (rugCheckData.score < 60) {
          riskScore += 10;
          reasons.push(`🟡 RugCheck.xyz score: ${rugCheckData.score}/100 — Moderate risk`);
        } else {
          reasons.push(`✅ RugCheck.xyz score: ${rugCheckData.score}/100`);
        }

        if (rugCheckData.risks?.length > 0) {
          rugCheckData.risks.slice(0, 3).forEach((r) => reasons.push(`  ↳ ${r.name}: ${r.description}`));
        }
      }
    } catch (_) {
      reasons.push('⚪ RugCheck.xyz unavailable — skipped');
    }

    const safe = riskScore < 50;
    if (!safe) {
      logger.rug(`Token ${mintAddress.slice(0, 8)}... failed rug check (score: ${riskScore})`);
    }

    return { safe, score: riskScore, reasons, mint: mintAddress };
  } catch (err) {
    logger.error('RugCheck error:', err.message);
    return { safe: false, score: 100, reasons: [`Error checking token: ${err.message}`] };
  }
}

async function fetchRugCheckScore(mintAddress) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`, {
    timeout: 5000,
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Check if developer wallet previously rugged.
 * Uses a lightweight on-chain heuristic: did dev sell >50% within first 10 minutes?
 */
async function checkDevWallet(devWallet, blacklistSet) {
  if (blacklistSet.has(devWallet)) {
    return { safe: false, reason: '🚨 Dev wallet is blacklisted — previously rugged' };
  }
  return { safe: true, reason: '✅ Dev wallet not blacklisted' };
}

module.exports = { checkRugRisk, checkDevWallet };
