#!/usr/bin/env bun
/**
 * HODLMM Deadweight — Capital Efficiency X-Ray for Bitflow HODLMM
 *
 * Answers: "How much of my (or the protocol's) liquidity is actually earning fees?"
 *
 * Scans HODLMM bin data to separate active capital (in fee-earning range)
 * from deadweight (stranded out of range, earning nothing). Protocol-wide
 * or per-address with on-chain position reads.
 *
 * Usage:
 *   bun run skills/hodlmm-deadweight/hodlmm-deadweight.ts doctor
 *   bun run skills/hodlmm-deadweight/hodlmm-deadweight.ts scan
 *   bun run skills/hodlmm-deadweight/hodlmm-deadweight.ts scan --address SP2V3J...
 *   bun run skills/hodlmm-deadweight/hodlmm-deadweight.ts scan --address SP2V3J... --pool-id dlmm_3
 *   bun run skills/hodlmm-deadweight/hodlmm-deadweight.ts scan --address SP2V3J... --hiro-api-key <key>
 */

import { Command } from "commander";
import {
  standardPrincipalCV,
  cvToHex,
  uintCV,
  hexToCV,
  cvToJSON,
} from "@stacks/transactions";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT_MS = 30_000;
const HIRO_BATCH_SIZE = 20;
const HIRO_BATCH_DELAY_MS = 200;

// Active range heuristic: bins within this radius of the active bin earn fees.
// Wider bin_step = fewer bins needed to cover the same price range.
function activeRadius(binStep: number): number {
  return Math.max(5, Math.round(50 / binStep));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PoolListItem {
  pool_id: string;
  pool_name?: string;
  pool_token: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin: number;
  active: boolean;
}

interface PoolDetail {
  poolId: string;
  tvlUsd: number;
  apr: number;
  apr24h: number;
  feesUsd1d: number;
  tokens: {
    tokenX: { symbol: string; decimals: number; priceUsd: number };
    tokenY: { symbol: string; decimals: number; priceUsd: number };
  };
  poolComposition: {
    tokenX: { liquidity: number; liquidityUsd: number; percentage: number };
    tokenY: { liquidity: number; liquidityUsd: number; percentage: number };
  };
}

interface BinData {
  pool_id: string;
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

interface BinsResponse {
  success: boolean;
  pool_id: string;
  bins: BinData[];
  total_bins: number;
  active_bin_id: number;
}

interface PoolEfficiency {
  poolId: string;
  pair: string;
  tvlUsd: number;
  activeBin: number;
  activeRadius: number;
  totalBins: number;
  activeBins: number;
  deadBins: number;
  activeUsd: number;
  deadUsd: number;
  efficiency: number;
  verdict: string;
}

interface UserBinPosition {
  binId: number;
  shares: number;
  totalSupply: number;
  ownershipPct: number;
  reserveX: number;
  reserveY: number;
  valueUsd: number;
  earning: boolean;
  distanceFromActive: number;
}

interface UserPoolPosition {
  poolId: string;
  pair: string;
  activeBin: number;
  userBinCount: number;
  earningBins: number;
  deadBins: number;
  earningUsd: number;
  deadUsd: number;
  totalUsd: number;
  efficiency: number;
  suggestion: string;
  bins: UserBinPosition[];
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
// Fetch helpers
// ---------------------------------------------------------------------------

let hiroApiKey: string | undefined;

function hiroHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (hiroApiKey) h["x-hiro-api-key"] = hiroApiKey;
  return h;
}

async function fetchJson<T>(
  url: string,
  headers?: Record<string, string>
): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json", ...headers },
  });
  if (res.status === 429) {
    throw new Error(
      `Rate limited by ${new URL(url).hostname}. Use --hiro-api-key for elevated limits, or narrow your scan with --pool-id.`
    );
  }
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}: ${url}`);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Bitflow API
// ---------------------------------------------------------------------------

async function getAllPools(): Promise<PoolListItem[]> {
  const data = await fetchJson<{ pools: PoolListItem[] }>(
    `${BITFLOW_QUOTES_API}/pools`
  );
  return (data.pools ?? []).filter((p) => p.active);
}

async function getPoolDetail(poolId: string): Promise<PoolDetail> {
  return fetchJson<PoolDetail>(`${BITFLOW_APP_API}/pools/${poolId}`);
}

async function getPoolBins(poolId: string): Promise<BinsResponse> {
  return fetchJson<BinsResponse>(`${BITFLOW_QUOTES_API}/bins/${poolId}`);
}

// ---------------------------------------------------------------------------
// Stacks on-chain reads
// ---------------------------------------------------------------------------

function splitContractId(contractId: string): {
  address: string;
  name: string;
} {
  const [address, name] = contractId.split(".");
  return { address, name };
}

async function callReadOnly(
  contractId: string,
  fn: string,
  args: string[],
  sender: string
): Promise<string> {
  const { address, name } = splitContractId(contractId);
  const url = `${HIRO_API}/v2/contracts/call-read/${address}/${name}/${fn}`;
  const body = JSON.stringify({ sender, arguments: args });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...hiroHeaders() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body,
  });
  if (res.status === 429) {
    throw new Error(
      "Hiro API rate limit hit during on-chain read. Use --hiro-api-key for elevated limits."
    );
  }
  if (!res.ok)
    throw new Error(`Hiro API ${res.status}: ${fn} on ${contractId}`);
  const data = (await res.json()) as {
    okay: boolean;
    result: string;
    cause?: string;
  };
  if (!data.okay) throw new Error(`Contract call failed: ${data.cause}`);
  return data.result;
}

async function getUserBins(
  poolContract: string,
  address: string
): Promise<number[]> {
  const principalHex = cvToHex(standardPrincipalCV(address));
  const result = await callReadOnly(
    poolContract,
    "get-user-bins",
    [principalHex],
    address
  );
  const cv = hexToCV(result);
  const json = cvToJSON(cv);
  // Response: (ok (list uint))
  const list = json.value?.value ?? json.value ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((v: { value: string }) => parseInt(v.value, 10));
}

async function getBalance(
  poolContract: string,
  binId: number,
  address: string
): Promise<number> {
  const binHex = cvToHex(uintCV(binId));
  const principalHex = cvToHex(standardPrincipalCV(address));
  const result = await callReadOnly(
    poolContract,
    "get-balance",
    [binHex, principalHex],
    address
  );
  const cv = hexToCV(result);
  const json = cvToJSON(cv);
  return parseInt(json.value?.value ?? json.value ?? "0", 10);
}

async function getTotalSupply(
  poolContract: string,
  binId: number,
  address: string
): Promise<number> {
  const binHex = cvToHex(uintCV(binId));
  const result = await callReadOnly(
    poolContract,
    "get-total-supply",
    [binHex],
    address
  );
  const cv = hexToCV(result);
  const json = cvToJSON(cv);
  return parseInt(json.value?.value ?? json.value ?? "0", 10);
}

// ---------------------------------------------------------------------------
// Batch helper — chunks parallel calls to avoid rate limits
// ---------------------------------------------------------------------------

async function batchedCalls<T>(
  items: number[],
  fn: (item: number) => Promise<T>,
  batchSize: number = HIRO_BATCH_SIZE,
  delayMs: number = HIRO_BATCH_DELAY_MS
): Promise<(T | Error)[]> {
  const results: (T | Error)[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    for (const r of batchResults) {
      results.push(
        r.status === "fulfilled" ? r.value : new Error(String(r.reason))
      );
    }
    if (i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Protocol-wide scan
// ---------------------------------------------------------------------------

function computePoolEfficiency(
  pool: PoolListItem,
  detail: PoolDetail,
  bins: BinsResponse
): PoolEfficiency {
  const radius = activeRadius(pool.bin_step);
  const activeBin = bins.active_bin_id;
  const priceX = detail.tokens.tokenX.priceUsd;
  const priceY = detail.tokens.tokenY.priceUsd;
  const decX = detail.tokens.tokenX.decimals;
  const decY = detail.tokens.tokenY.decimals;

  let activeUsd = 0;
  let deadUsd = 0;
  let activeBinCount = 0;
  let deadBinCount = 0;

  for (const bin of bins.bins) {
    const rx = Number(bin.reserve_x) / 10 ** decX;
    const ry = Number(bin.reserve_y) / 10 ** decY;
    const binUsd = rx * priceX + ry * priceY;
    if (binUsd < 0.001) continue; // skip dust

    const dist = Math.abs(bin.bin_id - activeBin);
    if (dist <= radius) {
      activeUsd += binUsd;
      activeBinCount++;
    } else {
      deadUsd += binUsd;
      deadBinCount++;
    }
  }

  const totalUsd = activeUsd + deadUsd;
  const efficiency = totalUsd > 0 ? (activeUsd / totalUsd) * 100 : 0;
  const pair = `${detail.tokens.tokenX.symbol}/${detail.tokens.tokenY.symbol}`;
  const deadPct = (100 - efficiency).toFixed(1);
  const verdict =
    efficiency >= 80
      ? `Healthy — ${efficiency.toFixed(1)}% capital active`
      : efficiency >= 50
        ? `Warning — ${deadPct}% capital earning nothing`
        : `Critical — ${deadPct}% capital stranded`;

  return {
    poolId: pool.pool_id,
    pair,
    tvlUsd: Math.round(totalUsd * 100) / 100,
    activeBin,
    activeRadius: radius,
    totalBins: activeBinCount + deadBinCount,
    activeBins: activeBinCount,
    deadBins: deadBinCount,
    activeUsd: Math.round(activeUsd * 100) / 100,
    deadUsd: Math.round(deadUsd * 100) / 100,
    efficiency: Math.round(efficiency * 10) / 10,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Per-address scan
// ---------------------------------------------------------------------------

async function scanUserPool(
  pool: PoolListItem,
  detail: PoolDetail,
  bins: BinsResponse,
  address: string
): Promise<UserPoolPosition | null> {
  const poolContract = pool.pool_token;
  const userBinIds = await getUserBins(poolContract, address);
  if (userBinIds.length === 0) return null;

  const radius = activeRadius(pool.bin_step);
  const activeBin = bins.active_bin_id;
  const priceX = detail.tokens.tokenX.priceUsd;
  const priceY = detail.tokens.tokenY.priceUsd;
  const decX = detail.tokens.tokenX.decimals;
  const decY = detail.tokens.tokenY.decimals;
  const pair = `${detail.tokens.tokenX.symbol}/${detail.tokens.tokenY.symbol}`;

  // Build a map of bin reserves from API
  const binMap = new Map<number, BinData>();
  for (const b of bins.bins) binMap.set(b.bin_id, b);

  // Fetch balances and total supplies in batches
  const balances = await batchedCalls(userBinIds, (binId) =>
    getBalance(poolContract, binId, address)
  );
  const supplies = await batchedCalls(userBinIds, (binId) =>
    getTotalSupply(poolContract, binId, address)
  );

  const positions: UserBinPosition[] = [];
  let earningUsd = 0;
  let deadUsd = 0;
  let rateLimited = false;

  for (let i = 0; i < userBinIds.length; i++) {
    const binId = userBinIds[i];
    const bal = balances[i];
    const sup = supplies[i];

    if (bal instanceof Error || sup instanceof Error) {
      if (
        (bal instanceof Error && bal.message.includes("rate limit")) ||
        (sup instanceof Error && sup.message.includes("rate limit"))
      ) {
        rateLimited = true;
        break;
      }
      continue;
    }

    if (sup === 0 || bal === 0) continue;

    const binData = binMap.get(binId);
    const rx = binData ? Number(binData.reserve_x) / 10 ** decX : 0;
    const ry = binData ? Number(binData.reserve_y) / 10 ** decY : 0;
    const ownershipPct = bal / sup;
    const userRx = rx * ownershipPct;
    const userRy = ry * ownershipPct;
    const valueUsd = userRx * priceX + userRy * priceY;
    const dist = Math.abs(binId - activeBin);
    const earning = dist <= radius;

    if (earning) earningUsd += valueUsd;
    else deadUsd += valueUsd;

    positions.push({
      binId,
      shares: bal,
      totalSupply: sup,
      ownershipPct: Math.round(ownershipPct * 10000) / 100,
      reserveX: Math.round(userRx * 10 ** decX),
      reserveY: Math.round(userRy * 10 ** decY),
      valueUsd: Math.round(valueUsd * 100) / 100,
      earning,
      distanceFromActive: dist,
    });
  }

  const totalUsd = earningUsd + deadUsd;
  const efficiency = totalUsd > 0 ? (earningUsd / totalUsd) * 100 : 0;
  const earningBins = positions.filter((p) => p.earning).length;
  const deadBins = positions.filter((p) => !p.earning).length;

  // Generate suggestion
  const lo = activeBin - radius;
  const hi = activeBin + radius;
  let suggestion: string;
  if (efficiency >= 80) {
    suggestion = "Capital is well-positioned. No action needed.";
  } else if (deadBins > 0 && earningBins > 0) {
    suggestion = `Move liquidity from stranded bins to range ${lo}–${hi} to recapture yield.`;
  } else if (earningBins === 0) {
    suggestion = `Entire position is out of range. Active zone is bins ${lo}–${hi}.`;
  } else {
    suggestion = `Consider rebalancing toward bins ${lo}–${hi}.`;
  }

  if (rateLimited) {
    suggestion +=
      " (partial scan — Hiro API rate limit hit, use --hiro-api-key for full results)";
  }

  return {
    poolId: pool.pool_id,
    pair,
    activeBin,
    userBinCount: positions.length,
    earningBins,
    deadBins,
    earningUsd: Math.round(earningUsd * 100) / 100,
    deadUsd: Math.round(deadUsd * 100) / 100,
    totalUsd: Math.round(totalUsd * 100) / 100,
    efficiency: Math.round(efficiency * 10) / 10,
    suggestion,
    bins: positions.sort(
      (a, b) => a.distanceFromActive - b.distanceFromActive
    ),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function doctor(): Promise<void> {
  const checks: { check: string; status: string; detail: string }[] = [];

  // Check Bitflow quotes API
  try {
    const pools = await getAllPools();
    checks.push({
      check: "bitflow_quotes_api",
      status: "ok",
      detail: `${BITFLOW_QUOTES_API}/pools reachable — ${pools.length} pools`,
    });
  } catch (e) {
    checks.push({
      check: "bitflow_quotes_api",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // Check Bitflow app API
  try {
    const detail = await getPoolDetail("dlmm_3");
    checks.push({
      check: "bitflow_app_api",
      status: "ok",
      detail: `dlmm_3 TVL: $${detail.tvlUsd.toLocaleString()}, APR: ${detail.apr}%`,
    });
  } catch (e) {
    checks.push({
      check: "bitflow_app_api",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // Check Bitflow bins API
  try {
    const bins = await getPoolBins("dlmm_3");
    checks.push({
      check: "bitflow_bins_api",
      status: "ok",
      detail: `dlmm_3 bins: ${bins.total_bins}, active bin: ${bins.active_bin_id}`,
    });
  } catch (e) {
    checks.push({
      check: "bitflow_bins_api",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // Check Hiro API
  try {
    const result = await callReadOnly(
      "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10",
      "get-active-bin-id",
      [],
      "SP2V3J7G42E8ZD1YPK6G6295EQ1EGZMPGDZQSRDWT"
    );
    const cv = hexToCV(result);
    const json = cvToJSON(cv);
    const activeBin = json.value?.value ?? json.value;
    checks.push({
      check: "hiro_stacks_api",
      status: "ok",
      detail: `Stacks read-only calls working — active bin: ${activeBin}${hiroApiKey ? " (API key configured)" : " (free tier — use --hiro-api-key for per-address scans)"}`,
    });
  } catch (e) {
    checks.push({
      check: "hiro_stacks_api",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const allOk = checks.every((c) => c.status === "ok");
  printJson({
    status: allOk ? "ready" : "degraded",
    network: "mainnet",
    checks,
    note: "Read-only skill — no wallet required",
  });

  if (!allOk) process.exit(1);
}

async function scan(opts: {
  address?: string;
  poolId?: string;
  hiroApiKey?: string;
}): Promise<void> {
  if (opts.hiroApiKey) hiroApiKey = opts.hiroApiKey;

  const allPools = await getAllPools();
  const pools = opts.poolId
    ? allPools.filter((p) => p.pool_id === opts.poolId)
    : allPools;

  if (pools.length === 0) {
    printJson({ error: `Pool ${opts.poolId} not found` });
    process.exit(1);
  }

  if (opts.address) {
    await scanAddress(pools, opts.address);
  } else {
    await scanProtocol(pools);
  }
}

async function scanProtocol(pools: PoolListItem[]): Promise<void> {
  const results: PoolEfficiency[] = [];
  const skipped: string[] = [];

  for (const pool of pools) {
    try {
      const [detail, bins] = await Promise.all([
        getPoolDetail(pool.pool_id),
        getPoolBins(pool.pool_id),
      ]);
      results.push(computePoolEfficiency(pool, detail, bins));
    } catch (e) {
      skipped.push(
        `${pool.pool_id}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // Sort by deadweight USD descending (worst offenders first)
  results.sort((a, b) => b.deadUsd - a.deadUsd);

  const totalTvl = results.reduce((s, r) => s + r.tvlUsd, 0);
  const totalActive = results.reduce((s, r) => s + r.activeUsd, 0);
  const totalDead = results.reduce((s, r) => s + r.deadUsd, 0);
  const protocolEfficiency =
    totalTvl > 0 ? (totalActive / totalTvl) * 100 : 0;

  printJson({
    status: "success",
    network: "mainnet",
    timestamp: new Date().toISOString(),
    protocolEfficiency: Math.round(protocolEfficiency * 10) / 10,
    totalTvlUsd: Math.round(totalTvl * 100) / 100,
    activeTvlUsd: Math.round(totalActive * 100) / 100,
    deadTvlUsd: Math.round(totalDead * 100) / 100,
    poolsScanned: results.length,
    skippedPools: skipped.length,
    pools: results,
    ...(skipped.length > 0 ? { skippedDetails: skipped } : {}),
  } as Record<string, unknown>);
}

async function scanAddress(
  pools: PoolListItem[],
  address: string
): Promise<void> {
  const positions: UserPoolPosition[] = [];
  const skipped: string[] = [];

  for (const pool of pools) {
    try {
      const [detail, bins] = await Promise.all([
        getPoolDetail(pool.pool_id),
        getPoolBins(pool.pool_id),
      ]);
      const pos = await scanUserPool(pool, detail, bins, address);
      if (pos) positions.push(pos);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("rate limit")) {
        skipped.push(
          `${pool.pool_id}: rate limited — remaining pools skipped`
        );
        break;
      }
      skipped.push(`${pool.pool_id}: ${msg}`);
    }
  }

  const totalEarning = positions.reduce((s, p) => s + p.earningUsd, 0);
  const totalDead = positions.reduce((s, p) => s + p.deadUsd, 0);
  const totalUsd = totalEarning + totalDead;
  const efficiency = totalUsd > 0 ? (totalEarning / totalUsd) * 100 : 0;

  printJson({
    status: "success",
    network: "mainnet",
    timestamp: new Date().toISOString(),
    address,
    totalValueUsd: Math.round(totalUsd * 100) / 100,
    earningUsd: Math.round(totalEarning * 100) / 100,
    deadUsd: Math.round(totalDead * 100) / 100,
    efficiency: Math.round(efficiency * 10) / 10,
    poolsWithPositions: positions.length,
    skippedPools: skipped.length,
    positions: positions.map((p) => ({
      ...p,
      bins: undefined,
      topDeadBins: p.bins
        .filter((b) => !b.earning)
        .sort((a, b) => b.valueUsd - a.valueUsd)
        .slice(0, 10),
      topEarningBins: p.bins
        .filter((b) => b.earning)
        .sort((a, b) => b.valueUsd - a.valueUsd)
        .slice(0, 5),
    })),
    ...(skipped.length > 0 ? { skippedDetails: skipped } : {}),
    apiNote:
      "Per-address scans require 2 Hiro API calls per bin. For large positions, use --hiro-api-key or --pool-id to avoid rate limits.",
  } as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("hodlmm-deadweight")
  .description(
    "HODLMM capital efficiency X-ray — shows how much liquidity is earning fees vs sitting dead. Read-only, no wallet required."
  )
  .version("1.0.0");

program
  .command("doctor")
  .description("Check Bitflow API and Hiro API connectivity")
  .option("--hiro-api-key <key>", "Hiro API key for elevated rate limits")
  .action(async (opts: { hiroApiKey?: string }) => {
    try {
      if (opts.hiroApiKey) hiroApiKey = opts.hiroApiKey;
      await doctor();
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("scan")
  .description(
    "Scan capital efficiency — protocol-wide or per-address with on-chain reads"
  )
  .option(
    "--address <stx-address>",
    "STX address to scan (omit for protocol-wide)"
  )
  .option("--pool-id <id>", "Narrow scan to a single pool (e.g. dlmm_3)")
  .option("--hiro-api-key <key>", "Hiro API key for elevated rate limits")
  .action(
    async (opts: {
      address?: string;
      poolId?: string;
      hiroApiKey?: string;
    }) => {
      try {
        await scan(opts);
      } catch (e) {
        handleError(e);
      }
    }
  );

program.parse(process.argv);
