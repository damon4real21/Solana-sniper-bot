// ═══════════════════════════════════════════════════════════════
// BUBBLEMAPS INTEGRATION
// Detects connected wallets, cluster analysis, decentralization score
// Free API — no key needed
// ═══════════════════════════════════════════════════════════════

const { resilientFetch } = require('../utils/fetcher');
const logger = require('../utils/logger');

const BUBBLEMAP_API = 'https://api-legacy.bubblemaps.io';
const CACHE = new Map(); // mint -> { data, ts }
const CACHE_TTL = 5 * 60 * 1000; // 5 min cache

// ─────────────────────────────────────────────────────────────────
// MAIN FUNCTION — call this for every token alert
// Returns full analysis formatted for Telegram
// ─────────────────────────────────────────────────────────────────
async function getBubbleMapAnalysis(mint) {
  // Check cache
  const cached = CACHE.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    // Fetch both endpoints in parallel
    const [mapData, metaData] = await Promise.allSettled([
      fetchMapData(mint),
      fetchMetaData(mint),
    ]);

    const holders = mapData.status === 'fulfilled' ? mapData.value : null;
    const meta = metaData.status === 'fulfilled' ? metaData.value : null;

    if (!holders && !meta) {
      return buildFallbackResult(mint);
    }

    const analysis = analyzeHolders(holders, meta, mint);
    CACHE.set(mint, { data: analysis, ts: Date.now() });
    return analysis;
  } catch (err) {
    logger.warn(`[BubbleMaps] Failed for ${mint.slice(0,8)}: ${err.message}`);
    return buildFallbackResult(mint);
  }
}

// ─────────────────────────────────────────────────────────────────
// Fetch holder/cluster map data
// ─────────────────────────────────────────────────────────────────
async function fetchMapData(mint) {
  const res = await resilientFetch(
    `${BUBBLEMAP_API}/map-data?token=${mint}&chain=sol`,
    { headers: { 'Accept': 'application/json' }, timeout: 8000 },
    2
  );
  if (!res.ok) throw new Error(`Map data ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────
// Fetch decentralization score metadata
// ─────────────────────────────────────────────────────────────────
async function fetchMetaData(mint) {
  const res = await resilientFetch(
    `${BUBBLEMAP_API}/map-metadata?token=${mint}&chain=sol`,
    { headers: { 'Accept': 'application/json' }, timeout: 8000 },
    2
  );
  if (!res.ok) throw new Error(`Meta data ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────
// Core analysis logic
// ─────────────────────────────────────────────────────────────────
function analyzeHolders(mapData, metaData, mint) {
  const nodes = mapData?.nodes || [];
  const links = mapData?.links || [];
  const decentralScore = metaData?.decentralisationScore ?? null;

  // ── Top holders ──
  const topHolders = nodes
    .sort((a, b) => (b.percentage || 0) - (a.percentage || 0))
    .slice(0, 10)
    .map((n, i) => ({
      rank: i + 1,
      address: n.address || '',
      percentage: parseFloat(n.percentage || 0),
      isContract: n.is_contract || false,
      name: n.name || null,
      transferCount: n.transfer_count || 0,
    }));

  // ── Cluster detection ──
  // Build adjacency from links
  const adjacency = new Map();
  for (const link of links) {
    const src = link.source?.toString();
    const tgt = link.target?.toString();
    if (!src || !tgt) continue;
    if (!adjacency.has(src)) adjacency.set(src, new Set());
    if (!adjacency.has(tgt)) adjacency.set(tgt, new Set());
    adjacency.get(src).add(tgt);
    adjacency.get(tgt).add(src);
  }

  // Find clusters via BFS
  const visited = new Set();
  const clusters = [];

  for (const node of nodes) {
    const id = nodes.indexOf(node).toString();
    if (visited.has(id)) continue;

    const cluster = new Set([id]);
    const queue = [id];
    while (queue.length > 0) {
      const curr = queue.shift();
      const neighbors = adjacency.get(curr) || new Set();
      for (const nb of neighbors) {
        if (!visited.has(nb) && !cluster.has(nb)) {
          cluster.add(nb);
          queue.push(nb);
        }
      }
      visited.add(curr);
    }

    if (cluster.size > 1) {
      // Calculate total % held by this cluster
      const clusterPct = [...cluster].reduce((sum, idx) => {
        const n = nodes[parseInt(idx)];
        return sum + parseFloat(n?.percentage || 0);
      }, 0);
      clusters.push({ size: cluster.size, totalPct: clusterPct });
    }
  }

  // Sort by total percentage
  clusters.sort((a, b) => b.totalPct - a.totalPct);
  const biggestCluster = clusters[0] || null;

  // ── Risk assessment ──
  const top1Pct = topHolders[0]?.percentage || 0;
  const top5Pct = topHolders.slice(0, 5).reduce((s, h) => s + h.percentage, 0);
  const top10Pct = topHolders.reduce((s, h) => s + h.percentage, 0);
  const clusterPct = biggestCluster?.totalPct || 0;
  const clusterSize = biggestCluster?.size || 0;

  let riskLevel = 'LOW';
  const redFlags = [];

  if (top1Pct > 20) { riskLevel = 'HIGH'; redFlags.push(`🔴 #1 holder owns ${top1Pct.toFixed(1)}%`); }
  else if (top1Pct > 10) { riskLevel = 'MEDIUM'; redFlags.push(`🟡 #1 holder owns ${top1Pct.toFixed(1)}%`); }

  if (clusterPct > 40) { riskLevel = 'HIGH'; redFlags.push(`🔴 Biggest cluster: ${clusterSize} wallets = ${clusterPct.toFixed(1)}%`); }
  else if (clusterPct > 20) { if (riskLevel !== 'HIGH') riskLevel = 'MEDIUM'; redFlags.push(`🟡 Cluster of ${clusterSize} wallets = ${clusterPct.toFixed(1)}%`); }

  if (top5Pct > 60) { riskLevel = 'HIGH'; redFlags.push(`🔴 Top 5 wallets hold ${top5Pct.toFixed(1)}%`); }
  if (decentralScore !== null && decentralScore < 30) { riskLevel = 'HIGH'; redFlags.push(`🔴 Decentralization score: ${decentralScore}/100`); }
  else if (decentralScore !== null && decentralScore < 60) { if (riskLevel !== 'HIGH') riskLevel = 'MEDIUM'; }

  const riskEmoji = riskLevel === 'HIGH' ? '🔴' : riskLevel === 'MEDIUM' ? '🟡' : '🟢';

  return {
    mint,
    decentralScore,
    riskLevel,
    riskEmoji,
    redFlags,
    topHolders,
    biggestCluster,
    clusterCount: clusters.length,
    top1Pct,
    top5Pct,
    top10Pct,
    clusterPct,
    clusterSize,
    totalNodes: nodes.length,
    bubblemapUrl: `https://app.bubblemaps.io/sol/token/${mint}`,
    available: true,
  };
}

function buildFallbackResult(mint) {
  return {
    mint,
    decentralScore: null,
    riskLevel: 'UNKNOWN',
    riskEmoji: '⚪',
    redFlags: [],
    topHolders: [],
    biggestCluster: null,
    clusterCount: 0,
    top1Pct: 0,
    top5Pct: 0,
    top10Pct: 0,
    clusterPct: 0,
    clusterSize: 0,
    totalNodes: 0,
    bubblemapUrl: `https://app.bubblemaps.io/sol/token/${mint}`,
    available: false,
  };
}

// ─────────────────────────────────────────────────────────────────
// FORMAT for Telegram — compact version for alerts
// ─────────────────────────────────────────────────────────────────
function formatBubbleMapAlert(analysis) {
  if (!analysis.available) {
    return (
      `🫧 *BubbleMaps:* Data loading...\n` +
      `[View Map](${analysis.bubblemapUrl})`
    );
  }

  const { decentralScore, riskEmoji, riskLevel, topHolders, biggestCluster,
          clusterCount, top1Pct, top5Pct, top10Pct, redFlags, bubblemapUrl } = analysis;

  let text = `🫧 *BubbleMaps Analysis*\n`;
  text += `━━━━━━━━━━━━━━━━━\n`;

  // Decentralization score
  if (decentralScore !== null) {
    const scoreBar = buildScoreBar(decentralScore);
    text += `📊 Decentralization: *${decentralScore}/100* ${scoreBar}\n`;
  }

  text += `${riskEmoji} Cluster Risk: *${riskLevel}*\n\n`;

  // Top holders breakdown
  text += `*Top Holders:*\n`;
  text += `┌ #1 wallet: *${top1Pct.toFixed(1)}%*\n`;
  text += `├ Top 5: *${top5Pct.toFixed(1)}%*\n`;
  text += `└ Top 10: *${top10Pct.toFixed(1)}%*\n\n`;

  // Top 5 wallets list
  if (topHolders.length > 0) {
    text += `*Wallet Breakdown:*\n`;
    for (const h of topHolders.slice(0, 5)) {
      const tag = h.name ? ` (${h.name})` : h.isContract ? ' 📜' : '';
      text += `${h.rank}. \`${h.address.slice(0,8)}...\`${tag} — *${h.percentage.toFixed(2)}%*\n`;
    }
    text += '\n';
  }

  // Cluster info
  if (biggestCluster && biggestCluster.totalPct > 5) {
    text += `🕸 *Connected Cluster:*\n`;
    text += `${biggestCluster.size} wallets linked = *${biggestCluster.totalPct.toFixed(1)}%* of supply\n`;
    if (clusterCount > 1) text += `(${clusterCount} total clusters detected)\n`;
    text += '\n';
  }

  // Red flags
  if (redFlags.length > 0) {
    text += `⚠️ *Red Flags:*\n`;
    for (const flag of redFlags) text += `${flag}\n`;
    text += '\n';
  }

  text += `[🫧 View Full BubbleMap](${bubblemapUrl})`;
  return text;
}

function buildScoreBar(score) {
  const filled = Math.round(score / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `[${bar}]`;
}

// ─────────────────────────────────────────────────────────────────
// RISK GATE — returns true if token should be skipped
// ─────────────────────────────────────────────────────────────────
function isBubbleMapRisky(analysis, settings = {}) {
  if (!analysis.available) return false; // can't determine, allow

  const maxClusterPct = settings.maxClusterPct || 50;
  const minDecentScore = settings.minDecentScore || 0;
  const maxTop1Pct = settings.maxTop1Pct || 30;

  if (analysis.clusterPct > maxClusterPct) return true;
  if (analysis.top1Pct > maxTop1Pct) return true;
  if (minDecentScore > 0 && analysis.decentralScore !== null && analysis.decentralScore < minDecentScore) return true;
  return false;
}

module.exports = {
  getBubbleMapAnalysis,
  formatBubbleMapAlert,
  isBubbleMapRisky,
};
