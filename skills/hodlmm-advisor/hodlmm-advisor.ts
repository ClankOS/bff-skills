#!/usr/bin/env bun
/**
 * HODLMM Advisor
 * LP advisory layer for Bitflow HODLMM pools — read-only, no wallet required.
 *
 * Answers: "Where and how should I deploy liquidity right now?"
 * Ranks all active pools by risk-adjusted score, generates entry plans,
 * and summarizes individual pool health.
 *
 * Usage:
 *   bun run skills/hodlmm-advisor/hodlmm-advisor.ts doctor
 *   bun run skills/hodlmm-advisor/hodlmm-advisor.ts best-pools [--limit 5] [--min-liquidity 10000]
 *   bun run skills/hodlmm-advisor/hodlmm-advisor.ts pool-summary --pool-id dlmm_3
 *   bun run skills/hodlmm-advisor/hodlmm-advisor.ts entry-plan --pool-id dlmm_3 --amount-sats 100000
 */

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1";
const FETCH_TIMEOUT_MS = 30_000;
const NETWORK = "mainnet";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PoolListItem {
  pool_id: string;
  pool_name?: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin: number;
  active: boolean;
  x_total_fee_bps?: number;
  x_protocol_fee: number;
  x_provider_fee: number;
}

interface PoolDetail {
  poolId: string;
  apr: number;
  apr24h: number;
  tvlUsd: number;
  baseFee: number;
  binStep: number;
  feesUsd1d: number;
  poolComposition: {
    tokenX: { liquidity: number; liquidityUsd: number; percentage: number };
    tokenY: { liquidity: number; liquidityUsd: number; percentage: number };
  };
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price?: string;
  liquidity?: string;
}

interface BinsResponse {
  success: boolean;
  pool_id: string;
  bins: BinData[];
  total_bins: number;
  active_bin_id: number;
  error?: string;
}

interface RiskMetrics {
  activeBinId: number;
  totalBins: number;
  nonEmptyBins: number;
  binSpread: number;
  reserveImbalanceRatio: number;
  activeBinConcentration: number;
  volatilityScore: number;
  regime: "calm" | "elevated" | "crisis";
  activePositionPct: number;
}

interface ScoredPool {
  poolId: string;
  name: string;
  tokenX: string;
  tokenY: string;
  feeBps: number;
  apr: number;
  apr24h: number;
  tvlUsd: number;
  feesUsd1d: number;
  risk: RiskMetrics;
  score: number;
  verdict: "enter" | "wait" | "avoid";
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}: ${url}`);
  return res.json() as Promise<T>;
}

async function getAllPools(): Promise<PoolListItem[]> {
  const data = await fetchJson<{ pools: PoolListItem[] }>(
    `${BITFLOW_QUOTES_API}/pools`
  );
  return data.pools ?? [];
}

async function getPoolDetail(poolId: string): Promise<PoolDetail> {
  return fetchJson<PoolDetail>(`${BITFLOW_APP_API}/pools/${poolId}`);
}

async function getPoolBins(poolId: string): Promise<BinsResponse> {
  return fetchJson<BinsResponse>(`${BITFLOW_QUOTES_API}/bins/${poolId}`);
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function getSymbolFromContract(contract: string): string {
  const name = contract.split(".")[1] ?? contract.split(".")[0] ?? contract;
  if (name.includes("sbtc")) return "sBTC";
  if (name.includes("stx")) return "STX";
  if (name.toLowerCase().includes("usdh")) return "USDh";
  if (name.toLowerCase().includes("aeusdc")) return "aeUSDC";
  if (name.toLowerCase().includes("usdc")) return "USDCx";
  return name.split("-").slice(0, 2).join("-").toUpperCase();
}

function computeRiskMetrics(
  binsData: BinsResponse,
  poolDetail: PoolDetail
): RiskMetrics {
  const bins = binsData.bins ?? [];
  const activeBinId = binsData.active_bin_id;
  const totalBins = binsData.total_bins ?? bins.length;

  const nonEmpty = bins.filter(
    (b) => Number(b.reserve_x) > 0 || Number(b.reserve_y) > 0
  );
  if (nonEmpty.length === 0) {
    throw new Error("No active liquidity — all bins are empty");
  }

  const nonEmptyBins = nonEmpty.length;
  const binIds = nonEmpty.map((b) => b.bin_id);
  const minBin = Math.min(...binIds);
  const maxBin = Math.max(...binIds);

  // Bin density: ratio of populated bins to their range.
  // A dense pool (most bins filled) = score close to 1 = normal/lower risk.
  // A sparse pool (few bins scattered) = lower density = higher risk.
  const nonEmptyRange = Math.max(maxBin - minBin, 1);
  const binDensity = Math.min(nonEmptyBins / nonEmptyRange, 1);
  // Convert density to a spread score: low density = high spread risk
  const binSpread = 1 - binDensity;

  // USD-normalised reserve imbalance from app API (avoids unit mismatch)
  const xPct = poolDetail.poolComposition.tokenX.percentage / 100;
  const yPct = poolDetail.poolComposition.tokenY.percentage / 100;
  const reserveImbalanceRatio = Math.abs(xPct - yPct);

  // Active bin concentration via liquidity field
  const totalLiquidity = bins.reduce((s, b) => s + Number(b.liquidity ?? 0), 0);
  const activeBin = bins.find((b) => b.bin_id === activeBinId);
  const activeLiquidity = Number(activeBin?.liquidity ?? 0);
  const activeBinConcentration =
    totalLiquidity > 0 ? activeLiquidity / totalLiquidity : 0;

  // Volatility score 0–100
  // spread (40%) + imbalance (30%) + low-concentration penalty (30%)
  const spreadScore = binSpread * 100 * 0.4;
  const imbalanceScore = reserveImbalanceRatio * 100 * 0.3;
  const concentrationScore = (1 - activeBinConcentration) * 100 * 0.3;
  const volatilityScore = Math.round(
    Math.min(spreadScore + imbalanceScore + concentrationScore, 100)
  );

  const regime: "calm" | "elevated" | "crisis" =
    volatilityScore <= 30 ? "calm" : volatilityScore <= 60 ? "elevated" : "crisis";

  // Active bin position in non-empty range (0=bottom, 1=top)
  const activePositionPct =
    maxBin > minBin ? (activeBinId - minBin) / (maxBin - minBin) : 0.5;

  return {
    activeBinId,
    totalBins,
    nonEmptyBins,
    binSpread: Math.round(binSpread * 1000) / 1000,
    reserveImbalanceRatio: Math.round(reserveImbalanceRatio * 1000) / 1000,
    activeBinConcentration: Math.round(activeBinConcentration * 1000) / 1000,
    volatilityScore,
    regime,
    activePositionPct: Math.round(activePositionPct * 1000) / 1000,
  };
}

function scorePool(feeBps: number, risk: RiskMetrics): number {
  if (feeBps === 0) return 0;
  // Risk-adjusted: higher fee, lower spread, lower imbalance = better score
  const rawScore =
    feeBps / (1 + risk.binSpread * (1 + risk.reserveImbalanceRatio));
  return Math.round(Math.min(rawScore * 2.5, 100));
}

// ---------------------------------------------------------------------------
// Subcommand: doctor
// ---------------------------------------------------------------------------

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; status: string; detail: string }> = [];

  // 1. Bitflow quotes API
  try {
    await fetchJson<{ pools: unknown[] }>(`${BITFLOW_QUOTES_API}/pools`);
    checks.push({
      check: "bitflow_quotes_api",
      status: "ok",
      detail: `${BITFLOW_QUOTES_API}/pools reachable`,
    });
  } catch (e) {
    checks.push({
      check: "bitflow_quotes_api",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 2. Bitflow app API
  try {
    await fetchJson<unknown>(`${BITFLOW_APP_API}/pools/dlmm_3`);
    checks.push({
      check: "bitflow_app_api",
      status: "ok",
      detail: `${BITFLOW_APP_API}/pools/dlmm_3 reachable`,
    });
  } catch (e) {
    checks.push({
      check: "bitflow_app_api",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 3. Bins API
  try {
    const bins = await fetchJson<BinsResponse>(
      `${BITFLOW_QUOTES_API}/bins/dlmm_3`
    );
    checks.push({
      check: "bitflow_bins_api",
      status: "ok",
      detail: `dlmm_3 bins: ${bins.bins?.length ?? 0} total, active_bin_id: ${bins.active_bin_id}`,
    });
  } catch (e) {
    checks.push({
      check: "bitflow_bins_api",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const allOk = checks.every((c) => c.status === "ok");

  printJson({
    status: allOk ? "ready" : "degraded",
    network: NETWORK,
    checks,
    note: "Read-only skill — no wallet required",
  } as Record<string, unknown>);

  if (!allOk) process.exit(1);
}

// ---------------------------------------------------------------------------
// Subcommand: best-pools
// ---------------------------------------------------------------------------

async function bestPools(opts: {
  limit: number;
  minLiquidity: number;
}): Promise<void> {
  const allPools = await getAllPools();
  const activePools = allPools.filter((p) => p.active);

  const results: ScoredPool[] = [];

  await Promise.all(
    activePools.map(async (pool) => {
      try {
        const [detail, binsData] = await Promise.all([
          getPoolDetail(pool.pool_id),
          getPoolBins(pool.pool_id),
        ]);

        if (detail.tvlUsd < opts.minLiquidity) return;

        const risk = computeRiskMetrics(binsData, detail);
        const feeBps =
          pool.x_total_fee_bps ?? pool.x_protocol_fee + pool.x_provider_fee;
        const score = scorePool(feeBps, risk);

        results.push({
          poolId: pool.pool_id,
          name:
            pool.pool_name ??
            `${getSymbolFromContract(pool.token_x)}-${getSymbolFromContract(pool.token_y)}`,
          tokenX: getSymbolFromContract(pool.token_x),
          tokenY: getSymbolFromContract(pool.token_y),
          feeBps,
          apr: detail.apr,
          apr24h: detail.apr24h,
          tvlUsd: detail.tvlUsd,
          feesUsd1d: detail.feesUsd1d,
          risk,
          score,
          verdict: "wait",
        });
      } catch {
        // skip pools with API errors silently
      }
    })
  );

  results.sort((a, b) => b.score - a.score);
  const topThird = Math.ceil(results.length / 3);
  const bottomIdx = results.length - Math.ceil(results.length / 3);
  results.forEach((r, i) => {
    if (r.risk.regime === "crisis") {
      r.verdict = "avoid";
    } else if (i < topThird) {
      r.verdict = "enter";
    } else if (i >= bottomIdx) {
      r.verdict = "avoid";
    } else {
      r.verdict = "wait";
    }
  });

  const limited = results.slice(0, opts.limit);

  printJson({
    status: "success",
    network: NETWORK,
    timestamp: new Date().toISOString(),
    totalPoolsEvaluated: results.length,
    ranked: limited.map((r) => ({
      poolId: r.poolId,
      name: r.name,
      tokenX: r.tokenX,
      tokenY: r.tokenY,
      feeBps: r.feeBps,
      apr: `${r.apr.toFixed(2)}%`,
      apr24h: `${r.apr24h.toFixed(2)}%`,
      tvlUsd: `$${r.tvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      feesUsd1d: `$${r.feesUsd1d.toFixed(2)}`,
      volatilityScore: r.risk.volatilityScore,
      regime: r.risk.regime,
      score: r.score,
      verdict: r.verdict,
    })),
  } as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Subcommand: pool-summary
// ---------------------------------------------------------------------------

async function poolSummary(poolId: string): Promise<void> {
  const [pools, detail, binsData] = await Promise.all([
    getAllPools(),
    getPoolDetail(poolId),
    getPoolBins(poolId),
  ]);

  const pool = pools.find((p) => p.pool_id === poolId);
  if (!pool) throw new Error(`Pool ${poolId} not found`);

  const risk = computeRiskMetrics(binsData, detail);
  const feeBps =
    pool.x_total_fee_bps ?? pool.x_protocol_fee + pool.x_provider_fee;
  const score = scorePool(feeBps, risk);

  let verdict: "enter" | "wait" | "avoid";
  if (risk.regime === "crisis") verdict = "avoid";
  else if (score >= 60) verdict = "enter";
  else if (score >= 30) verdict = "wait";
  else verdict = "avoid";

  printJson({
    status: "success",
    network: NETWORK,
    timestamp: new Date().toISOString(),
    poolId,
    name:
      pool.pool_name ??
      `${getSymbolFromContract(pool.token_x)}-${getSymbolFromContract(pool.token_y)}`,
    tokenX: getSymbolFromContract(pool.token_x),
    tokenY: getSymbolFromContract(pool.token_y),
    feeBps,
    apr: `${detail.apr.toFixed(2)}%`,
    apr24h: `${detail.apr24h.toFixed(2)}%`,
    tvlUsd: `$${detail.tvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    feesUsd1d: `$${detail.feesUsd1d.toFixed(2)}`,
    activeBin: risk.activeBinId,
    totalBins: risk.totalBins,
    nonEmptyBins: risk.nonEmptyBins,
    volatilityScore: risk.volatilityScore,
    regime: risk.regime,
    binSpread: risk.binSpread,
    reserveImbalanceRatio: risk.reserveImbalanceRatio,
    activePositionPct: risk.activePositionPct,
    poolComposition: {
      tokenX: `${detail.poolComposition.tokenX.percentage.toFixed(1)}%`,
      tokenY: `${detail.poolComposition.tokenY.percentage.toFixed(1)}%`,
    },
    score,
    verdict,
  } as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Subcommand: entry-plan
// ---------------------------------------------------------------------------

async function entryPlan(opts: {
  poolId: string;
  amountSats: number;
  strategy?: string;
}): Promise<void> {
  const [pools, detail, binsData] = await Promise.all([
    getAllPools(),
    getPoolDetail(opts.poolId),
    getPoolBins(opts.poolId),
  ]);

  const pool = pools.find((p) => p.pool_id === opts.poolId);
  if (!pool) throw new Error(`Pool ${opts.poolId} not found`);

  const risk = computeRiskMetrics(binsData, detail);

  // Strategy auto-selection
  let strategy: string;
  if (opts.strategy) {
    strategy = opts.strategy;
  } else if (risk.regime === "crisis") {
    strategy = "bid-ask";
  } else if (risk.reserveImbalanceRatio > 0.6) {
    strategy = "curve";
  } else {
    strategy = "spot";
  }

  // Bin range width scales with volatility
  const halfRange = risk.regime === "calm" ? 2 : risk.regime === "elevated" ? 4 : 8;
  const binRange = {
    from: risk.activeBinId - halfRange,
    to: risk.activeBinId + halfRange,
    activeBin: risk.activeBinId,
    halfWidth: halfRange,
  };

  // IL warning: active bin in outer 20% of range
  const ilWarning =
    risk.activePositionPct < 0.2 || risk.activePositionPct > 0.8;

  // Fee APR estimate from 1d fees / TVL * 365
  const estimatedFeeApr =
    detail.tvlUsd > 0
      ? ((detail.feesUsd1d / detail.tvlUsd) * 365 * 100).toFixed(2)
      : detail.apr.toFixed(2);

  // Capital split from current composition
  const xPct = detail.poolComposition.tokenX.percentage / 100;
  const yPct = detail.poolComposition.tokenY.percentage / 100;

  let verdict: string;
  let reasoning: string;
  if (risk.regime === "crisis") {
    verdict = "High IL risk — wait for regime to calm";
    reasoning = `Volatility score ${risk.volatilityScore} (crisis). Pool is ${detail.poolComposition.tokenX.percentage.toFixed(0)}% ${getSymbolFromContract(pool.token_x)} / ${detail.poolComposition.tokenY.percentage.toFixed(0)}% ${getSymbolFromContract(pool.token_y)} — heavily imbalanced. LP losses from IL likely exceed fee income.`;
  } else if (ilWarning) {
    verdict = "Deploy with caution — price near range edge";
    reasoning = `Active bin at ${(risk.activePositionPct * 100).toFixed(0)}% of the liquidity range. Consider narrowing range to stay in-range longer.`;
  } else if (risk.regime === "calm" && detail.apr > 20) {
    verdict = "Deploy now";
    reasoning = `Calm regime, APR ${detail.apr.toFixed(1)}%, balanced reserves. Good entry conditions.`;
  } else {
    verdict = "Wait for better entry";
    reasoning = `Regime is ${risk.regime} with APR ${detail.apr.toFixed(1)}%. Monitor for improved conditions before deploying.`;
  }

  printJson({
    status: "success",
    network: NETWORK,
    timestamp: new Date().toISOString(),
    poolId: opts.poolId,
    tokenX: getSymbolFromContract(pool.token_x),
    tokenY: getSymbolFromContract(pool.token_y),
    amountSats: opts.amountSats,
    plan: {
      strategy,
      binRange,
      estimatedFeeApr: `${estimatedFeeApr}%`,
      aprFull: `${detail.apr.toFixed(2)}%`,
      apr24h: `${detail.apr24h.toFixed(2)}%`,
      suggestedSplit: {
        tokenX: `${(xPct * 100).toFixed(0)}% (~${Math.round(opts.amountSats * xPct)} sats equivalent)`,
        tokenY: `${(yPct * 100).toFixed(0)}% (~${Math.round(opts.amountSats * yPct)} sats equivalent)`,
      },
      ilWarning,
      verdict,
      reasoning,
    },
    riskMetrics: {
      volatilityScore: risk.volatilityScore,
      regime: risk.regime,
      binSpread: risk.binSpread,
      reserveImbalanceRatio: risk.reserveImbalanceRatio,
      activePositionPct: risk.activePositionPct,
    },
  } as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("hodlmm-advisor")
  .description(
    "HODLMM LP advisor — ranks pools by risk-adjusted score, generates entry plans, and summarizes pool health. Read-only, no wallet required."
  )
  .version("1.0.0");

program
  .command("doctor")
  .description("Check API connectivity and environment readiness")
  .action(async () => {
    try {
      await doctor();
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("best-pools")
  .description("Rank all active HODLMM pools by risk-adjusted score")
  .option("--limit <n>", "Max pools to return", (v) => parseInt(v, 10), 5)
  .option(
    "--min-liquidity <usd>",
    "Minimum TVL in USD",
    (v) => parseFloat(v),
    0
  )
  .action(async (opts: { limit: number; minLiquidity: number }) => {
    try {
      await bestPools(opts);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("pool-summary")
  .description("Compact health snapshot and verdict for a single HODLMM pool")
  .requiredOption("--pool-id <id>", "Pool identifier (e.g. dlmm_3)")
  .action(async (opts: { poolId: string }) => {
    try {
      await poolSummary(opts.poolId);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("entry-plan")
  .description("Generate bin range, strategy, and entry recommendation for a pool")
  .requiredOption("--pool-id <id>", "Pool identifier (e.g. dlmm_3)")
  .requiredOption(
    "--amount-sats <n>",
    "Capital to deploy in sats",
    (v) => parseInt(v, 10)
  )
  .option("--strategy <type>", "Override strategy: spot | curve | bid-ask")
  .action(
    async (opts: { poolId: string; amountSats: number; strategy?: string }) => {
      try {
        await entryPlan(opts);
      } catch (e) {
        handleError(e);
      }
    }
  );

program.parse(process.argv);
