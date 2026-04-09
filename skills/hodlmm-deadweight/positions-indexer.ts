#!/usr/bin/env bun
/**
 * HODLMM Positions Indexer — Reference Implementation
 *
 * This is NOT part of the skill itself. It is a standalone reference
 * implementation for a proposed Bitflow API endpoint:
 *
 *   GET /api/app/v1/positions/{stx-address}
 *
 * Currently, per-address HODLMM position data requires hundreds of on-chain
 * reads via the Hiro Stacks API (get-user-bins + get-balance + get-total-supply
 * per bin, per pool). This is slow and rate-limit-prone.
 *
 * A native endpoint would:
 *   - Eliminate O(bins × pools) on-chain calls per address lookup
 *   - Make per-wallet position data instant
 *   - Benefit any skill that needs LP position awareness (deadweight,
 *     rebalancers, portfolio trackers, exit optimizers)
 *
 * This script demonstrates the exact response shape and data pipeline.
 * Bitflow could implement this as a server-side indexer that pre-caches
 * position data from on-chain events, serving it via a single REST call.
 *
 * Usage:
 *   bun run positions-indexer.ts SP2V3J7G42E8ZD1YPK6G6295EQ1EGZMPGDZQSRDWT
 *   bun run positions-indexer.ts SP2V3J... --pool-id dlmm_3
 *   bun run positions-indexer.ts SP2V3J... --hiro-api-key <key>
 */

import {
  standardPrincipalCV,
  cvToHex,
  uintCV,
  hexToCV,
  cvToJSON,
} from "@stacks/transactions";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 200;

let hiroApiKey: string | undefined;

// ---------------------------------------------------------------------------
// Types — this is the proposed response shape for GET /positions/{address}
// ---------------------------------------------------------------------------

interface PositionBin {
  binId: number;
  shares: number;
  totalSupply: number;
  ownershipPct: number;
  reserveX: number;
  reserveY: number;
  valueUsd: number;
  earning: boolean;
}

interface PoolPosition {
  poolId: string;
  poolContract: string;
  pair: string;
  activeBin: number;
  binStep: number;
  bins: PositionBin[];
  totalValueUsd: number;
  earningUsd: number;
  deadUsd: number;
  efficiency: number;
}

interface PositionsResponse {
  address: string;
  timestamp: string;
  positions: PoolPosition[];
  totalValueUsd: number;
  totalEarningUsd: number;
  totalDeadUsd: number;
  overallEfficiency: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hiroHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (hiroApiKey) h["x-hiro-api-key"] = hiroApiKey;
  return h;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json() as Promise<T>;
}

async function callReadOnly(
  contractId: string,
  fn: string,
  args: string[],
  sender: string
): Promise<string> {
  const [addr, name] = contractId.split(".");
  const url = `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fn}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...hiroHeaders() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({ sender, arguments: args }),
  });
  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (!res.ok) throw new Error(`Hiro ${res.status}: ${fn}`);
  const data = (await res.json()) as {
    okay: boolean;
    result: string;
    cause?: string;
  };
  if (!data.okay) throw new Error(`Call failed: ${data.cause}`);
  return data.result;
}

function activeRadius(binStep: number): number {
  return Math.max(5, Math.round(50 / binStep));
}

async function batchedCalls<T>(
  items: number[],
  fn: (item: number) => Promise<T>
): Promise<(T | null)[]> {
  const results: (T | null)[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const r of settled) {
      results.push(r.status === "fulfilled" ? r.value : null);
    }
    if (i + BATCH_SIZE < items.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main pipeline — this is what the server-side indexer would do
// ---------------------------------------------------------------------------

async function indexPositions(
  address: string,
  filterPoolId?: string
): Promise<PositionsResponse> {
  // 1. Fetch all pools
  const poolsData = await fetchJson<{
    pools: {
      pool_id: string;
      pool_token: string;
      bin_step: number;
      active: boolean;
    }[];
  }>(`${BITFLOW_QUOTES_API}/pools`);

  let pools = poolsData.pools.filter((p) => p.active);
  if (filterPoolId) pools = pools.filter((p) => p.pool_id === filterPoolId);

  const positions: PoolPosition[] = [];
  const principalHex = cvToHex(standardPrincipalCV(address));

  for (const pool of pools) {
    // 2. Check if user has bins in this pool
    let userBinIds: number[];
    try {
      const result = await callReadOnly(
        pool.pool_token,
        "get-user-bins",
        [principalHex],
        address
      );
      const cv = hexToCV(result);
      const json = cvToJSON(cv);
      const list = json.value?.value ?? json.value ?? [];
      userBinIds = Array.isArray(list)
        ? list.map((v: { value: string }) => parseInt(v.value, 10))
        : [];
    } catch {
      continue; // skip pool on error
    }

    if (userBinIds.length === 0) continue;

    // 3. Fetch pool detail + bins from Bitflow API
    const [detail, binsData] = await Promise.all([
      fetchJson<{
        tokens: {
          tokenX: { symbol: string; decimals: number; priceUsd: number };
          tokenY: { symbol: string; decimals: number; priceUsd: number };
        };
      }>(`${BITFLOW_APP_API}/pools/${pool.pool_id}`),
      fetchJson<{
        bins: { bin_id: number; reserve_x: string; reserve_y: string }[];
        active_bin_id: number;
      }>(`${BITFLOW_QUOTES_API}/bins/${pool.pool_id}`),
    ]);

    const priceX = detail.tokens.tokenX.priceUsd;
    const priceY = detail.tokens.tokenY.priceUsd;
    const decX = detail.tokens.tokenX.decimals;
    const decY = detail.tokens.tokenY.decimals;
    const activeBin = binsData.active_bin_id;
    const radius = activeRadius(pool.bin_step);
    const pair = `${detail.tokens.tokenX.symbol}/${detail.tokens.tokenY.symbol}`;

    const binMap = new Map(binsData.bins.map((b) => [b.bin_id, b]));

    // 4. Fetch per-bin balances and supplies
    const balances = await batchedCalls(userBinIds, async (binId) => {
      const r = await callReadOnly(
        pool.pool_token,
        "get-balance",
        [cvToHex(uintCV(binId)), principalHex],
        address
      );
      return parseInt(
        cvToJSON(hexToCV(r)).value?.value ?? cvToJSON(hexToCV(r)).value ?? "0",
        10
      );
    });

    const supplies = await batchedCalls(userBinIds, async (binId) => {
      const r = await callReadOnly(
        pool.pool_token,
        "get-total-supply",
        [cvToHex(uintCV(binId))],
        address
      );
      return parseInt(
        cvToJSON(hexToCV(r)).value?.value ?? cvToJSON(hexToCV(r)).value ?? "0",
        10
      );
    });

    // 5. Compute position data per bin
    const bins: PositionBin[] = [];
    let earningUsd = 0;
    let deadUsd = 0;

    for (let i = 0; i < userBinIds.length; i++) {
      const binId = userBinIds[i];
      const bal = balances[i];
      const sup = supplies[i];
      if (bal == null || sup == null || sup === 0 || bal === 0) continue;

      const binData = binMap.get(binId);
      const rx = binData ? Number(binData.reserve_x) / 10 ** decX : 0;
      const ry = binData ? Number(binData.reserve_y) / 10 ** decY : 0;
      const ownership = bal / sup;
      const valueUsd = rx * ownership * priceX + ry * ownership * priceY;
      const earning = Math.abs(binId - activeBin) <= radius;

      if (earning) earningUsd += valueUsd;
      else deadUsd += valueUsd;

      bins.push({
        binId,
        shares: bal,
        totalSupply: sup,
        ownershipPct: Math.round(ownership * 10000) / 100,
        reserveX: Math.round(rx * ownership * 10 ** decX),
        reserveY: Math.round(ry * ownership * 10 ** decY),
        valueUsd: Math.round(valueUsd * 100) / 100,
        earning,
      });
    }

    const totalUsd = earningUsd + deadUsd;

    positions.push({
      poolId: pool.pool_id,
      poolContract: pool.pool_token,
      pair,
      activeBin,
      binStep: pool.bin_step,
      bins,
      totalValueUsd: Math.round(totalUsd * 100) / 100,
      earningUsd: Math.round(earningUsd * 100) / 100,
      deadUsd: Math.round(deadUsd * 100) / 100,
      efficiency:
        totalUsd > 0
          ? Math.round((earningUsd / totalUsd) * 1000) / 10
          : 0,
    });
  }

  const totalVal = positions.reduce((s, p) => s + p.totalValueUsd, 0);
  const totalEarning = positions.reduce((s, p) => s + p.earningUsd, 0);
  const totalDead = positions.reduce((s, p) => s + p.deadUsd, 0);

  return {
    address,
    timestamp: new Date().toISOString(),
    positions,
    totalValueUsd: Math.round(totalVal * 100) / 100,
    totalEarningUsd: Math.round(totalEarning * 100) / 100,
    totalDeadUsd: Math.round(totalDead * 100) / 100,
    overallEfficiency:
      totalVal > 0
        ? Math.round((totalEarning / totalVal) * 1000) / 10
        : 0,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const address = args.find((a) => a.startsWith("SP") || a.startsWith("SM"));
  const poolIdIdx = args.indexOf("--pool-id");
  const poolId =
    poolIdIdx >= 0 && args[poolIdIdx + 1] ? args[poolIdIdx + 1] : undefined;
  const keyIdx = args.indexOf("--hiro-api-key");
  hiroApiKey =
    keyIdx >= 0 && args[keyIdx + 1] ? args[keyIdx + 1] : undefined;

  if (!address) {
    console.log(
      JSON.stringify(
        {
          error:
            "Usage: bun run positions-indexer.ts <STX-address> [--pool-id dlmm_3] [--hiro-api-key <key>]",
          description:
            "Reference implementation for a proposed GET /api/app/v1/positions/{address} endpoint. " +
            "This demonstrates the exact response shape that would replace hundreds of on-chain reads with a single API call.",
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  try {
    const result = await indexPositions(address, poolId);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.log(
      JSON.stringify(
        { error: e instanceof Error ? e.message : String(e) },
        null,
        2
      )
    );
    process.exit(1);
  }
}

main();
