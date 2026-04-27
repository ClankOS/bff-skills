#!/usr/bin/env bun
/**
 * hodlmm-predator — Just-In-Time HODLMM liquidity searcher for Bitflow.
 *
 * Watches the Stacks mempool for pending HODLMM swaps. When a whale swap
 * is detected, the skill computes the bin it will cross, emits an
 * add-liquidity MCP payload that lands in that bin in the same anchor
 * block, then a retreat withdraw payload the next block. Net realized
 * return per cycle = fee_captured − gas − IL_one_block.
 *
 * Commands:
 *   doctor       Preflight: mempool, APIs, wallet, MCP, clocks, allowlist
 *   calibrate    Read-only pool analysis: whale thresholds + backtest
 *   hunt         Poll mempool and stream detections as JSONL
 *   arm          Compute a strike plan for a detected swap
 *   simulate     Counterfactual replay of a past swap with strike params
 *   strike       Emit MCP add-liquidity payload (WRITES via harness)
 *   retreat      Emit MCP withdraw payload + book realized PnL (WRITES)
 *   autopilot    Closed loop: hunt → arm → strike → retreat, gated
 *   ledger       Summarize strike history (read-only)
 *   abort        Force retreat of any open strike (WRITES)
 *
 * Built by Clank (ClankOS / Grim Seraph / clank.btc / BTC agent #122). 🔧
 *
 * BFF extended output shape: { status, action, data, error }.
 * Flat-error fallback: { error: string } — both pass CI.
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ═════════════════════════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════════════════════════

const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.mainnet.hiro.so";

// HODLMM liquidity router (used for add-liquidity-multi / withdraw).
const ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME = "dlmm-liquidity-router-v-1-1";

// Known deployer of pool contracts — used to filter mempool to HODLMM swaps.
const POOL_CONTRACT_PREFIX = `${ROUTER_ADDR}.dlmm-pool-`;
// Swap router that wraps pool calls — most swaps flow through here.
const SWAP_ROUTER_PREFIX = `${ROUTER_ADDR}.dlmm-swap-router-`;

// Swap function names that indicate a HODLMM swap in the mempool.
const SWAP_FUNCTIONS = new Set([
  "swap-x-for-y-simple-range-multi",
  "swap-y-for-x-simple-range-multi",
  "swap-simple-multi",
]);

// Defaults — safety rails (also echoed in AGENT.md).
const DEFAULTS = {
  MAX_STRIKE_SATS: 10_000,
  MAX_DAILY_STRIKES: 5,
  MAX_DAILY_LOSS_SATS: 5_000,
  MIN_EXPECTED_PROFIT_SATS: 200,
  MIN_CONFIDENCE: 0.7,
  FEE_PREMIUM_BPS: 50,
  COOLDOWN_SECONDS: 15,
  AUTO_RETREAT_BLOCKS: 3,
  MIN_SWAP_SIZE_SATS: 500_000,
  PLAN_TTL_SECONDS: 30,
  MIN_GAS_USTX: 400_000,               // 0.4 STX reserved (2 legs × 0.2)
  FETCH_TIMEOUT_MS: 20_000,
  MEMPOOL_POLL_MS: 2_000,
  MEMPOOL_PAGE_LIMIT: 50,
  MAX_HUNT_ITERATIONS: 60,
  CENTER_BIN_ID: 500,                   // HODLMM contract signed-offset center
  STRIKE_GAS_USTX: 200_000,
  WITHDRAW_GAS_USTX: 200_000,
  MIN_WIN_RATE_RECENT: 0.35,            // over last 20 strikes
  MAX_CLOCK_DRIFT_MS: 2_000,
  MAX_SHARE_OF_BIN: 0.7,                // above this, cap deposit
  MIN_SHARE_OF_BIN: 0.05,               // below this, skip (too dilute)
};

const STATE_DIR = path.join(os.homedir(), ".aibtc", "hodlmm-predator");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LEDGER_FILE = path.join(STATE_DIR, "ledger.jsonl");
const PLAN_DIR = path.join(STATE_DIR, "plans");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");

// Expected USTX per Stacks block (≈5s Nakamoto) — for gas-per-sat estimates.
const STX_TO_SATS_FALLBACK = 2;                // fallback if price lookup fails
const MICRO_STX_PER_STX = 1_000_000;

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

type Status = "success" | "blocked" | "error";

interface SkillOutput {
  status: Status;
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface TokenMeta {
  contract: string;
  symbol: string;
  decimals: number;
  priceUsd: number;
  priceBtc: number;
}

interface PoolMeta {
  poolId: string;
  poolContract: string;      // e.g. SM1F...dlmm-pool-stx-sbtc-v-1-bps-15
  tokenX: TokenMeta;
  tokenY: TokenMeta;
  activeBin: number;
  binStep: number;           // in bps × bin_step; semantic is pool-specific
  feeBpsX: number;           // total fee bps for x→y swaps
  feeBpsY: number;           // total fee bps for y→x swaps
  tvlUsd: number;
  volumeUsd24h: number;
  volumeUsd7d: number;
  apr: number;
  active: boolean;
}

interface ActiveBinState {
  binId: number;
  reserveX: bigint;
  reserveY: bigint;
  liquidity: bigint;         // opaque L-number
  priceRaw: string;          // contract-native price integer
  isActive: boolean;
}

interface MempoolSwap {
  txId: string;
  senderAddress: string;
  feeRate: number;           // ustx
  nonce: number;
  receiptTimeIso: string;
  poolContract: string;
  functionName: string;
  direction: "x_for_y" | "y_for_x";
  xAmountRaw?: bigint;       // present for x-for-y
  yAmountRaw?: bigint;       // present for y-for-x
  minOutRaw: bigint;
  maxSteps: number;
  deadlineTime: number | null;
}

interface StrikePlan {
  planId: string;
  createdAt: string;
  validUntil: string;
  target: {
    swapTxId: string;
    poolId: string;
    poolContract: string;
    direction: "x_for_y" | "y_for_x";
    swapSizeRaw: string;
    swapSizeDisplay: string;
    feeBps: number;
    totalFeeEstSats: number;
    detectedAt: string;
    whaleFeeRateUstx: number;
  };
  strike: {
    poolContract: string;
    xTokenContract: string;
    yTokenContract: string;
    targetBinOffset: number;          // signed offset from active bin
    absoluteBinId: number;
    capitalSats: number;
    capitalXRaw: string;
    capitalYRaw: string;
    expectedShareOfBin: number;
    expectedFeeCaptureSats: number;
    expectedGasSats: number;
    expectedNetSats: number;
    expectedRoiPct: number;
    confidence: number;
  };
  mcpAddLiquidity: McpCallContract;
  mcpWithdraw: McpCallContract;      // precomputed, used by retreat
  retreatDeadlineBlock: number;
  feeRateUstx: number;
}

interface McpCallContract {
  mcp_tool: "call_contract";
  description: string;
  params: Record<string, unknown>;
}

interface LedgerEntry {
  ts: string;
  planId: string;
  outcome: "success" | "loss" | "aborted" | "simulated";
  poolId: string;
  swapTxId: string;
  strikeTxId?: string;
  retreatTxId?: string;
  capitalSats: number;
  expectedNetSats: number;
  realizedFeeSats?: number;
  realizedGasSats?: number;
  realizedNetSats?: number;
  note?: string;
}

interface WalletSummary {
  walletId: string;
  address: string;
  ustxBalance: bigint;
  sbtcBalanceRaw: bigint;
  usdcxBalanceRaw: bigint;
  stxUsd: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// JSON output + state helpers
// ═════════════════════════════════════════════════════════════════════════════

function emitOut(out: SkillOutput): void {
  // Serialize with BigInt → string coercion.
  console.log(
    JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

function success(action: string, data: Record<string, unknown>): void {
  emitOut({ status: "success", action, data, error: null });
}

function blocked(
  action: string,
  code: string,
  message: string,
  next: string,
  data: Record<string, unknown> = {}
): void {
  emitOut({
    status: "blocked",
    action,
    data,
    error: { code, message, next },
  });
}

function errorOut(action: string, code: string, message: string, next: string): void {
  emitOut({
    status: "error",
    action,
    data: {},
    error: { code, message, next },
  });
}

function ensureDirs(): void {
  for (const d of [STATE_DIR, PLAN_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function loadState(): Record<string, unknown> {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(s: Record<string, unknown>): void {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function planPath(planId: string): string {
  return path.join(PLAN_DIR, `${planId}.json`);
}

function savePlan(plan: StrikePlan): void {
  ensureDirs();
  fs.writeFileSync(
    planPath(plan.planId),
    JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
  );
}

function loadPlan(planId: string): StrikePlan | null {
  const p = planPath(planId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as StrikePlan;
  } catch {
    return null;
  }
}

function appendLedger(entry: LedgerEntry): void {
  ensureDirs();
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + "\n");
}

function readLedger(): LedgerEntry[] {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  return fs
    .readFileSync(LEDGER_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as LedgerEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is LedgerEntry => e !== null);
}

function newPlanId(): string {
  return "jit-" + crypto.randomBytes(4).toString("hex");
}

// ═════════════════════════════════════════════════════════════════════════════
// Fetch with timeout
// ═════════════════════════════════════════════════════════════════════════════

async function fetchJson<T>(url: string, timeoutMs = DEFAULTS.FETCH_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} for ${url}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Pool + bin loaders
// ═════════════════════════════════════════════════════════════════════════════

async function loadPools(): Promise<PoolMeta[]> {
  const data = await fetchJson<{ pools: any[] }>(`${BITFLOW_QUOTES}/pools`);
  const raw = data.pools ?? [];
  const metas: PoolMeta[] = [];
  for (const p of raw) {
    // Fetch token metadata from pool detail (has decimals + prices).
    try {
      const detail = await fetchJson<any>(`${BITFLOW_APP}/pools/${p.pool_id}`);
      metas.push({
        poolId: p.pool_id,
        poolContract: detail.poolContract ?? p.pool_token,
        tokenX: {
          contract: detail.tokens.tokenX.contract,
          symbol: detail.tokens.tokenX.symbol,
          decimals: detail.tokens.tokenX.decimals,
          priceUsd: detail.tokens.tokenX.priceUsd,
          priceBtc: detail.tokens.tokenX.priceBtc,
        },
        tokenY: {
          contract: detail.tokens.tokenY.contract,
          symbol: detail.tokens.tokenY.symbol,
          decimals: detail.tokens.tokenY.decimals,
          priceUsd: detail.tokens.tokenY.priceUsd,
          priceBtc: detail.tokens.tokenY.priceBtc,
        },
        activeBin: Number(p.active_bin),
        binStep: Number(p.bin_step),
        feeBpsX: Number(p.x_total_fee_bps),
        feeBpsY: Number(p.y_total_fee_bps),
        tvlUsd: Number(detail.tvlUsd ?? 0),
        volumeUsd24h: Number(detail.volumeUsd1d ?? 0),
        volumeUsd7d: Number(detail.volumeUsd7d ?? 0),
        apr: Number(detail.apr ?? 0),
        active: Boolean(p.active),
      });
    } catch {
      // Skip pool on detail failure.
    }
  }
  return metas;
}

async function loadPool(poolId: string): Promise<PoolMeta | null> {
  const pools = await loadPools();
  return pools.find((p) => p.poolId === poolId) ?? null;
}

async function loadPoolByContract(contract: string): Promise<PoolMeta | null> {
  const pools = await loadPools();
  return pools.find((p) => p.poolContract === contract) ?? null;
}

async function loadActiveBin(poolId: string): Promise<ActiveBinState> {
  const d = await fetchJson<any>(`${BITFLOW_QUOTES}/bins/${poolId}/active`);
  return {
    binId: Number(d.bin_id),
    reserveX: BigInt(d.reserve_x ?? "0"),
    reserveY: BigInt(d.reserve_y ?? "0"),
    liquidity: BigInt(d.liquidity ?? "0"),
    priceRaw: String(d.price ?? "0"),
    isActive: Boolean(d.is_active),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Mempool scanner + Clarity decoding
// ═════════════════════════════════════════════════════════════════════════════

function parseClarityUint(repr: string): bigint {
  // Clarity uint repr is "u1234"
  const m = repr.match(/^u(\d+)$/);
  if (!m) throw new Error(`not a uint: ${repr}`);
  return BigInt(m[1]);
}

function parseClarityOptionalUint(repr: string): bigint | null {
  if (repr === "none") return null;
  const m = repr.match(/^\(some u(\d+)\)$/);
  if (!m) return null;
  return BigInt(m[1]);
}

function parseClarityPrincipal(repr: string): string {
  // Principal repr starts with a leading apostrophe.
  return repr.replace(/^'/, "");
}

function decodeSwap(
  tx: any
): {
  direction: "x_for_y" | "y_for_x";
  amount: bigint;
  minOut: bigint;
  maxSteps: number;
  deadline: bigint | null;
  poolContract: string;
} | null {
  const cc = tx.contract_call;
  if (!cc) return null;
  const fn = cc.function_name;
  if (!SWAP_FUNCTIONS.has(fn)) return null;

  const args: any[] = cc.function_args ?? [];
  const argByName = (n: string) => args.find((a) => a.name === n);
  // Resolve the pool contract: either the tx target itself (direct pool call)
  // or the `pool-trait` arg when the tx hit the swap router.
  let poolContract = cc.contract_id as string;
  if (poolContract.startsWith(SWAP_ROUTER_PREFIX)) {
    const pt = argByName("pool-trait");
    if (pt) poolContract = parseClarityPrincipal(pt.repr);
  }
  if (!poolContract.startsWith(POOL_CONTRACT_PREFIX)) return null;

  let direction: "x_for_y" | "y_for_x";
  let amount: bigint | null = null;
  let minOut: bigint = 0n;
  if (fn === "swap-x-for-y-simple-range-multi" || fn === "swap-simple-multi") {
    direction = "x_for_y";
    const xArg = argByName("x-amount");
    if (xArg) amount = parseClarityUint(xArg.repr);
    const minDy = argByName("min-dy");
    if (minDy) minOut = parseClarityUint(minDy.repr);
  } else if (fn === "swap-y-for-x-simple-range-multi") {
    direction = "y_for_x";
    const yArg = argByName("y-amount");
    if (yArg) amount = parseClarityUint(yArg.repr);
    const minDx = argByName("min-dx");
    if (minDx) minOut = parseClarityUint(minDx.repr);
  } else {
    return null;
  }
  if (amount === null) return null;

  const maxStepsArg = argByName("max-steps");
  const maxSteps = maxStepsArg ? Number(parseClarityUint(maxStepsArg.repr)) : 230;
  const deadlineArg = argByName("deadline-time");
  const deadline = deadlineArg ? parseClarityOptionalUint(deadlineArg.repr) : null;

  return { direction, amount, minOut, maxSteps, deadline, poolContract };
}

async function pollMempool(allowlist: Set<string>): Promise<MempoolSwap[]> {
  // Hiro caps mempool ?limit to 50; page up to 4× to cover ~200 pending txs.
  const pageSize = DEFAULTS.MEMPOOL_PAGE_LIMIT;
  const maxPages = 4;
  const results: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const d = await fetchJson<any>(
      `${HIRO_API}/extended/v1/tx/mempool?limit=${pageSize}&offset=${page * pageSize}`
    );
    const rs = d.results ?? [];
    results.push(...rs);
    if (rs.length < pageSize) break;
  }
  const swaps: MempoolSwap[] = [];
  for (const tx of results) {
    if (tx.tx_type !== "contract_call") continue;
    const contractId = tx.contract_call?.contract_id ?? "";
    // Accept both direct pool calls and swap-router calls.
    if (
      !contractId.startsWith(POOL_CONTRACT_PREFIX) &&
      !contractId.startsWith(SWAP_ROUTER_PREFIX)
    ) {
      continue;
    }
    const decoded = decodeSwap(tx);
    if (!decoded) continue;
    // Enforce pool-level allowlist (use decoded.poolContract — NOT contract_id).
    if (allowlist.size > 0 && !allowlist.has(decoded.poolContract)) continue;
    swaps.push({
      txId: tx.tx_id,
      senderAddress: tx.sender_address,
      feeRate: Number(tx.fee_rate),
      nonce: Number(tx.nonce),
      receiptTimeIso: tx.receipt_time_iso,
      poolContract: decoded.poolContract,
      functionName: tx.contract_call.function_name,
      direction: decoded.direction,
      xAmountRaw: decoded.direction === "x_for_y" ? decoded.amount : undefined,
      yAmountRaw: decoded.direction === "y_for_x" ? decoded.amount : undefined,
      minOutRaw: decoded.minOut,
      maxSteps: decoded.maxSteps,
      deadlineTime: decoded.deadline ? Number(decoded.deadline) : null,
    });
  }
  return swaps;
}

async function fetchTxById(txId: string): Promise<any | null> {
  try {
    // Mempool first, then confirmed.
    return await fetchJson<any>(`${HIRO_API}/extended/v1/tx/${txId}`);
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Math: bin walk, fee capture, confidence
// ═════════════════════════════════════════════════════════════════════════════

function formatDisplayAmount(raw: bigint, decimals: number, symbol: string): string {
  const d = 10n ** BigInt(decimals);
  const whole = raw / d;
  const frac = raw % d;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}${fracStr.length > 0 ? "." + fracStr : ""} ${symbol}`;
}

function rawToSats(raw: bigint, token: TokenMeta): number {
  // Convert an arbitrary raw amount to *sats-equivalent* for ledger normalization.
  // sats-equiv := BTC-denominated value × 1e8
  const d = 10n ** BigInt(token.decimals);
  const whole = Number(raw) / Number(d);
  const btc = whole * token.priceBtc;
  return Math.round(btc * 1e8);
}

function satsToRaw(sats: number, token: TokenMeta): bigint {
  if (token.priceBtc <= 0) return 0n;
  const btc = sats / 1e8;
  const whole = btc / token.priceBtc;
  const d = 10n ** BigInt(token.decimals);
  return BigInt(Math.max(0, Math.floor(whole * Number(d))));
}

/**
 * Project the primary bin the swap will cross, and the portion of the swap
 * that crosses *that* bin. Simplified model: assume the swap hits the
 * currently-active bin first and most of its volume lands there unless
 * reserves in the active bin are clearly insufficient.
 *
 * This deliberately conservative model keeps the math honest: we strike
 * the active bin, we project ρ based on how much of the swap can fit
 * against current reserves, and we take ρ=0.7 as a cap so we never
 * assume more than 70% of the swap crosses one bin.
 */
function projectBinCross(
  swap: MempoolSwap,
  pool: PoolMeta,
  activeBin: ActiveBinState
): { primaryBinId: number; portion: number } {
  const exitReserve =
    swap.direction === "x_for_y" ? activeBin.reserveY : activeBin.reserveX;
  const swapSize = swap.direction === "x_for_y" ? swap.xAmountRaw! : swap.yAmountRaw!;

  // Portion projection: if exit reserve is large relative to swap, the
  // active bin can absorb the full trade at its price → ρ≈1.0. If exit
  // reserve is thin, the swap keeps walking → ρ shrinks.
  //
  // Heuristic: ρ = min(1, exitReserve_in_swap_input_terms / swapSize),
  // capped at 0.7 so we never assume 100% concentration in one bin.
  let portion: number;
  if (exitReserve === 0n || swapSize === 0n) {
    portion = 0.3; // pool is bone dry in the exit side — assume the swap fans across bins
  } else {
    const r = Number(exitReserve) / Number(swapSize);
    portion = Math.min(0.7, Math.max(0.15, r));
  }
  return { primaryBinId: activeBin.binId, portion };
}

/**
 * Given the strike capital C, existing bin L and swap S at fee f_bps:
 *   fee_total = S × f_bps / 10000
 *   fee_captured = fee_total × ρ × C / (L + C)
 * Gas cost and IL come from skill defaults.
 */
function estimateFeeCapture(params: {
  swapSizeRaw: bigint;
  swapFeeBps: number;
  portion: number;
  binLiquidity: bigint;
  capitalRaw: bigint;
  swapInputToken: TokenMeta;
}): { totalFeeSats: number; feeCapturedSats: number; shareOfBin: number } {
  const feeTotalRaw =
    (params.swapSizeRaw * BigInt(params.swapFeeBps)) / 10_000n;
  // L + C — both in the same token terms as the swap input for directional swaps.
  const denom = params.binLiquidity + params.capitalRaw;
  let shareOfBin: number;
  if (denom === 0n) {
    shareOfBin = 1;
  } else {
    // Use float for the ratio; precision is fine for ≤ 1 BTC amounts.
    shareOfBin = Number(params.capitalRaw) / Number(denom);
  }
  const feeCaptureRaw =
    denom === 0n
      ? feeTotalRaw
      : (feeTotalRaw * params.capitalRaw) / denom;
  // Scale by portion ρ.
  const feeCapturePortionRaw =
    (feeCaptureRaw * BigInt(Math.round(params.portion * 10_000))) / 10_000n;
  return {
    totalFeeSats: rawToSats(feeTotalRaw, params.swapInputToken),
    feeCapturedSats: rawToSats(feeCapturePortionRaw, params.swapInputToken),
    shareOfBin,
  };
}

/**
 * Convert gas (ustx) to sats-equivalent via STX/USD and USD/BTC implied.
 * Uses pool.tokenX or tokenY USD price as a proxy when either is USD-pegged.
 */
function gasSats(ustx: number, stxPriceUsd: number, btcPriceUsd: number): number {
  if (btcPriceUsd <= 0 || stxPriceUsd <= 0) {
    // Fallback: assume 2 sats per 1000 ustx (conservative for hot markets).
    return Math.ceil(ustx / 1000) * STX_TO_SATS_FALLBACK;
  }
  const stxUsd = (ustx / MICRO_STX_PER_STX) * stxPriceUsd;
  const btc = stxUsd / btcPriceUsd;
  return Math.ceil(btc * 1e8);
}

/**
 * Confidence blends: (1) swap-size certainty, (2) mempool freshness, (3)
 * share-of-bin sanity, (4) historical ledger win rate on this pool.
 */
function scoreConfidence(params: {
  swapSizeRaw: bigint;
  poolMinSwapSats: number;
  detectedAgeSeconds: number;
  shareOfBin: number;
  poolRecentWinRate: number | null;
  swapInputToken: TokenMeta;
}): number {
  const sizeSats = rawToSats(params.swapSizeRaw, params.swapInputToken);
  // Size certainty: linearly grows up to 5× threshold, cap at 1.
  const sizeScore = Math.min(
    1,
    Math.max(0, sizeSats / Math.max(1, params.poolMinSwapSats * 5))
  );
  // Freshness: 1 at 0s, drops to 0 at 20s.
  const freshness = Math.max(0, 1 - params.detectedAgeSeconds / 20);
  // Share-of-bin: peaks at 0.4, drops outside 0.05..0.7.
  let share = 0;
  const s = params.shareOfBin;
  if (s >= DEFAULTS.MIN_SHARE_OF_BIN && s <= DEFAULTS.MAX_SHARE_OF_BIN) {
    share = 1 - Math.abs(s - 0.4) / 0.3;
    share = Math.max(0.4, Math.min(1, share));
  }
  // Win rate: null → neutral 0.7.
  const win = params.poolRecentWinRate ?? 0.7;
  const c = 0.25 * sizeScore + 0.3 * freshness + 0.25 * share + 0.2 * win;
  return Math.max(0, Math.min(1, c));
}

// ═════════════════════════════════════════════════════════════════════════════
// MCP payload builders
// ═════════════════════════════════════════════════════════════════════════════

function buildAddLiquidityPayload(params: {
  pool: PoolMeta;
  strikeBinIdAbsolute: number;
  xRaw: bigint;
  yRaw: bigint;
  feeRateUstx: number;
}): McpCallContract {
  const binOffset = params.strikeBinIdAbsolute - DEFAULTS.CENTER_BIN_ID;
  const positions = [
    {
      bin_id: binOffset,
      x_amount: params.xRaw.toString(),
      y_amount: params.yRaw.toString(),
      max_x_fee: "0",
      max_y_fee: "0",
      min_dlp: "1",
    },
  ];
  return {
    mcp_tool: "call_contract",
    description: `JIT predator strike: add-liquidity-multi into bin ${params.strikeBinIdAbsolute} of ${params.pool.poolId}`,
    params: {
      contract_id: `${ROUTER_ADDR}.${ROUTER_NAME}`,
      function_name: "add-liquidity-multi",
      args_hint:
        "positions: list of tuples { bin-id, x-amount, y-amount, max-x-liquidity-fee, max-y-liquidity-fee, min-dlp }",
      positions,
      pool_contract: params.pool.poolContract,
      x_token_contract: params.pool.tokenX.contract,
      y_token_contract: params.pool.tokenY.contract,
      post_condition_mode: "allow",
      fee_ustx: params.feeRateUstx,
    },
  };
}

function buildWithdrawPayload(params: {
  pool: PoolMeta;
  binIdAbsolute: number;
  amount: bigint;
  feeRateUstx: number;
  // After an x_for_y swap the LP's Y was consumed → fee captured in X.
  // After a y_for_x swap the LP's X was consumed → fee captured in Y.
  // Core requires min-x-amount + min-y-amount > 0 (err u1002 otherwise).
  swapDirection: "x_for_y" | "y_for_x";
}): McpCallContract {
  const binOffset = params.binIdAbsolute - DEFAULTS.CENTER_BIN_ID;
  const positions = [
    {
      bin_id: binOffset,
      amount: params.amount.toString(),
      min_x_amount: params.swapDirection === "x_for_y" ? "1" : "0",
      min_y_amount: params.swapDirection === "y_for_x" ? "1" : "0",
    },
  ];
  return {
    mcp_tool: "call_contract",
    description: `JIT predator retreat: withdraw-liquidity-same-multi from bin ${params.binIdAbsolute} of ${params.pool.poolId}`,
    params: {
      contract_id: `${ROUTER_ADDR}.${ROUTER_NAME}`,
      function_name: "withdraw-liquidity-same-multi",
      args_hint:
        "positions: list of tuples { bin-id, amount, min-x-amount, min-y-amount }",
      positions,
      pool_contract: params.pool.poolContract,
      x_token_contract: params.pool.tokenX.contract,
      y_token_contract: params.pool.tokenY.contract,
      post_condition_mode: "allow",
      fee_ustx: params.feeRateUstx,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Wallet summary (best-effort — reads ~/.aibtc/wallets.json if present)
// ═════════════════════════════════════════════════════════════════════════════

async function getWalletSummary(): Promise<WalletSummary | null> {
  if (!fs.existsSync(WALLETS_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
    // Support both shapes: { active: {...} } and { wallets: [...] }
    let active: any = raw.active ?? raw.default ?? null;
    if (!active && Array.isArray(raw.wallets)) {
      // Prefer the wallet named "clank-main" or the first mainnet wallet.
      active =
        raw.wallets.find((w: any) => w.name === "clank-main") ??
        raw.wallets.find((w: any) => w.network === "mainnet") ??
        raw.wallets[0];
    }
    if (!active) return null;
    const address: string = active.address ?? active.stx_address;
    if (!address) return null;
    const bal = await fetchJson<any>(
      `${HIRO_API}/extended/v1/address/${address}/stx`
    );
    const sbtc = await fetchJson<any>(
      `${HIRO_API}/extended/v1/address/${address}/balances`
    ).catch(() => null);
    const stxUsd = await fetchJson<any>(
      `${BITFLOW_QUOTES}/pools`
    )
      .then(() => 1)
      .catch(() => 0); // price resolution done via pool data elsewhere
    const ft = sbtc?.fungible_tokens ?? {};
    const sbtcKey = Object.keys(ft).find((k) => k.includes("sbtc-token"));
    const usdcxKey = Object.keys(ft).find((k) => k.includes("usdcx"));
    return {
      walletId: active.id ?? "default",
      address,
      ustxBalance: BigInt(bal.balance ?? "0"),
      sbtcBalanceRaw: sbtcKey ? BigInt(ft[sbtcKey].balance ?? "0") : 0n,
      usdcxBalanceRaw: usdcxKey ? BigInt(ft[usdcxKey].balance ?? "0") : 0n,
      stxUsd,
    };
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Safety rails
// ═════════════════════════════════════════════════════════════════════════════

function todayUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailyStats(): { strikes: number; loss: number } {
  const today = todayUtcDay();
  const entries = readLedger().filter((e) => e.ts.slice(0, 10) === today);
  const strikes = entries.filter(
    (e) => e.outcome === "success" || e.outcome === "loss"
  ).length;
  const loss = entries.reduce(
    (acc, e) => acc + Math.max(0, -(e.realizedNetSats ?? 0)),
    0
  );
  return { strikes, loss };
}

function recentWinRate(lookback = 20): number | null {
  const entries = readLedger()
    .filter((e) => e.outcome === "success" || e.outcome === "loss")
    .slice(-lookback);
  if (entries.length === 0) return null;
  const wins = entries.filter(
    (e) => (e.realizedNetSats ?? 0) > 0
  ).length;
  return wins / entries.length;
}

function recentWinRateForPool(poolId: string, lookback = 20): number | null {
  const entries = readLedger()
    .filter(
      (e) =>
        (e.outcome === "success" || e.outcome === "loss") && e.poolId === poolId
    )
    .slice(-lookback);
  if (entries.length === 0) return null;
  const wins = entries.filter((e) => (e.realizedNetSats ?? 0) > 0).length;
  return wins / entries.length;
}

// ═════════════════════════════════════════════════════════════════════════════
// Commands
// ═════════════════════════════════════════════════════════════════════════════

async function cmdDoctor(opts: { pools?: string }): Promise<void> {
  const action = "doctor";
  const checks: Record<string, unknown> = {};
  let allOk = true;

  // 1. Mempool reachable
  try {
    const t0 = Date.now();
    const mp = await fetchJson<any>(
      `${HIRO_API}/extended/v1/tx/mempool?limit=1`,
      8000
    );
    checks.mempool = {
      ok: true,
      total_pending: mp.total ?? 0,
      latency_ms: Date.now() - t0,
    };
  } catch (e: any) {
    checks.mempool = { ok: false, err: e?.message ?? "unreachable" };
    allOk = false;
  }

  // 2. Bitflow quotes reachable
  try {
    const pools = await loadPools();
    checks.bitflow_quotes = { ok: true, pools_loaded: pools.length };
    if (pools.length === 0) allOk = false;
  } catch (e: any) {
    checks.bitflow_quotes = { ok: false, err: e?.message ?? "unreachable" };
    allOk = false;
  }

  // 3. Pool allowlist validity
  const allowlistIds = (opts.pools ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowlistReport: Record<string, unknown> = {};
  if (allowlistIds.length === 0) {
    allowlistReport["status"] = "empty";
    allowlistReport["hint"] = "Pass --pools dlmm_2,dlmm_6 to enable strikes";
  } else {
    try {
      const pools = await loadPools();
      const byId = new Map(pools.map((p) => [p.poolId, p]));
      for (const id of allowlistIds) {
        const p = byId.get(id);
        if (!p) {
          allowlistReport[id] = { ok: false, reason: "unknown pool" };
          allOk = false;
        } else if (!p.active) {
          allowlistReport[id] = { ok: false, reason: "pool inactive" };
          allOk = false;
        } else {
          allowlistReport[id] = {
            ok: true,
            symbol: `${p.tokenX.symbol}/${p.tokenY.symbol}`,
            fee_bps: p.feeBpsX,
            volume_usd_24h: p.volumeUsd24h,
          };
        }
      }
    } catch (e: any) {
      allowlistReport["error"] = e?.message ?? "allowlist check failed";
      allOk = false;
    }
  }
  checks.allowlist = allowlistReport;

  // 4. Wallet
  const wallet = await getWalletSummary();
  if (!wallet) {
    checks.wallet = {
      ok: false,
      hint: "Install AIBTC MCP + provision wallet: npx @aibtc/mcp-server@latest --install",
    };
    allOk = false;
  } else {
    const enoughGas = wallet.ustxBalance >= BigInt(DEFAULTS.MIN_GAS_USTX);
    checks.wallet = {
      ok: enoughGas,
      address: wallet.address,
      ustx_balance: wallet.ustxBalance.toString(),
      min_gas_ustx: DEFAULTS.MIN_GAS_USTX,
      enough_gas: enoughGas,
      sbtc_raw: wallet.sbtcBalanceRaw.toString(),
      usdcx_raw: wallet.usdcxBalanceRaw.toString(),
    };
    if (!enoughGas) allOk = false;
  }

  // 5. Clock drift vs. Hiro (best-effort)
  try {
    const resp = await fetch(`${HIRO_API}/v2/info`);
    const dateHeader = resp.headers.get("date");
    if (dateHeader) {
      const serverMs = new Date(dateHeader).getTime();
      const localMs = Date.now();
      const driftMs = Math.abs(serverMs - localMs);
      checks.clock_drift = {
        ok: driftMs <= DEFAULTS.MAX_CLOCK_DRIFT_MS,
        drift_ms: driftMs,
        max_ms: DEFAULTS.MAX_CLOCK_DRIFT_MS,
      };
      if (driftMs > DEFAULTS.MAX_CLOCK_DRIFT_MS) allOk = false;
    } else {
      checks.clock_drift = { ok: true, note: "no Date header; skipped" };
    }
  } catch (e: any) {
    checks.clock_drift = { ok: false, err: e?.message ?? "clock check failed" };
    allOk = false;
  }

  // 6. State dir writable
  try {
    ensureDirs();
    const probe = path.join(STATE_DIR, ".probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    checks.state_dir = { ok: true, path: STATE_DIR };
  } catch (e: any) {
    checks.state_dir = { ok: false, err: e?.message ?? "not writable" };
    allOk = false;
  }

  // 7. Ledger health
  const dayStats = dailyStats();
  const winRate = recentWinRate();
  checks.ledger = {
    ok:
      winRate === null ||
      winRate >= DEFAULTS.MIN_WIN_RATE_RECENT,
    today_strikes: dayStats.strikes,
    today_loss_sats: dayStats.loss,
    recent_win_rate: winRate,
    min_win_rate: DEFAULTS.MIN_WIN_RATE_RECENT,
  };
  if (winRate !== null && winRate < DEFAULTS.MIN_WIN_RATE_RECENT) allOk = false;

  if (allOk) {
    success(action, { all_ok: true, checks });
  } else {
    blocked(
      action,
      "preflight_failed",
      "One or more preflight checks failed",
      "Review the checks object and fix before running strikes",
      { all_ok: false, checks }
    );
  }
}

async function cmdCalibrate(opts: {
  poolId: string;
  lookbackDays: number;
  maxStrikeSats: number;
}): Promise<void> {
  const action = "calibrate";
  const pool = await loadPool(opts.poolId);
  if (!pool) {
    errorOut(action, "unknown_pool", `Pool ${opts.poolId} not found`, "Run doctor with --pools=<id> to verify allowlist");
    return;
  }

  // Fetch recent swaps on the pool contract. Hiro caps limit at 50, so page.
  const pageSize = 50;
  const maxPages = 8;
  const txs: any[] = [];
  try {
    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      const r = await fetchJson<any>(
        `${HIRO_API}/extended/v1/address/${pool.poolContract}/transactions?limit=${pageSize}&offset=${offset}`
      );
      const rs = r.results ?? [];
      txs.push(...rs);
      if (rs.length < pageSize) break;
      // Early-exit if we're already past lookback window.
      const last = rs[rs.length - 1];
      const lastTs = last?.burn_block_time_iso
        ? new Date(last.burn_block_time_iso).getTime()
        : null;
      if (lastTs && Date.now() - lastTs > opts.lookbackDays * 86400 * 1000) break;
    }
  } catch (e: any) {
    errorOut(action, "hiro_unreachable", e?.message ?? "hiro error", "Retry later");
    return;
  }

  const nowMs = Date.now();
  const lookbackMs = opts.lookbackDays * 86400 * 1000;
  const swaps = txs
    .filter((t) => t.tx_type === "contract_call")
    .filter((t) => SWAP_FUNCTIONS.has(t.contract_call?.function_name))
    .filter((t) => t.tx_status === "success")
    .filter(
      (t) =>
        !t.burn_block_time_iso ||
        nowMs - new Date(t.burn_block_time_iso).getTime() <= lookbackMs
    );

  if (swaps.length === 0) {
    success(action, {
      pool_id: pool.poolId,
      symbol: `${pool.tokenX.symbol}/${pool.tokenY.symbol}`,
      lookback_days: opts.lookbackDays,
      n_swaps: 0,
      note: "No successful swaps in the window. Not a viable predator pool right now.",
      recommendation: {
        min_swap_size_sats: null,
        max_strike_sats: opts.maxStrikeSats,
      },
    });
    return;
  }

  // Extract swap input sizes in sats-equivalent.
  const swapSizes: { xFor_y: boolean; sizeSats: number; feeSats: number }[] = [];
  for (const t of swaps) {
    const d = decodeSwap(t);
    if (!d) continue;
    const token = d.direction === "x_for_y" ? pool.tokenX : pool.tokenY;
    const feeBps = d.direction === "x_for_y" ? pool.feeBpsX : pool.feeBpsY;
    const sizeSats = rawToSats(d.amount, token);
    const feeSats = Math.round((sizeSats * feeBps) / 10_000);
    swapSizes.push({ xFor_y: d.direction === "x_for_y", sizeSats, feeSats });
  }

  swapSizes.sort((a, b) => a.sizeSats - b.sizeSats);
  const percentile = (p: number) =>
    swapSizes[Math.min(swapSizes.length - 1, Math.floor((p / 100) * swapSizes.length))].sizeSats;
  const p50 = percentile(50);
  const p90 = percentile(90);
  const p95 = percentile(95);
  const p99 = percentile(99);
  const max = swapSizes[swapSizes.length - 1].sizeSats;

  // Backtest: if we had struck every swap ≥ p90 with strike = maxStrikeSats,
  // and assumed median bin TVL = 2× strike capital (share = 33%), what would
  // total net have been?
  const backtestThreshold = p90;
  const whales = swapSizes.filter((s) => s.sizeSats >= backtestThreshold);
  const assumedShare = 0.33;
  const gasPerRoundtripSats = 180;
  let gross = 0;
  let net = 0;
  for (const w of whales) {
    const captured = Math.round(w.feeSats * 0.6 * assumedShare); // ρ≈0.6
    const n = captured - gasPerRoundtripSats;
    gross += captured;
    net += Math.max(n, 0);
  }

  success(action, {
    pool_id: pool.poolId,
    symbol: `${pool.tokenX.symbol}/${pool.tokenY.symbol}`,
    lookback_days: opts.lookbackDays,
    fee_bps: pool.feeBpsX,
    tvl_usd: pool.tvlUsd,
    volume_usd_24h: pool.volumeUsd24h,
    volume_usd_7d: pool.volumeUsd7d,
    apr_passive: pool.apr,
    swap_distribution: {
      n: swapSizes.length,
      p50_sats: p50,
      p90_sats: p90,
      p95_sats: p95,
      p99_sats: p99,
      max_sats: max,
    },
    recommendation: {
      min_swap_size_sats: p95,
      max_strike_sats: opts.maxStrikeSats,
      note: "Use p95 as `--min-swap-size-sats` to catch top 5% of flow.",
    },
    backtest: {
      threshold_sats: backtestThreshold,
      n_whales: whales.length,
      avg_whales_per_day: whales.length / Math.max(1, opts.lookbackDays),
      gross_capture_sats: gross,
      net_est_sats: net,
      assumed_share_of_bin: assumedShare,
      assumed_portion_in_bin: 0.6,
      gas_per_cycle_sats: gasPerRoundtripSats,
    },
  });
}

async function cmdHunt(opts: {
  pools: string;
  minSwapSizeSats: number;
  maxIterations: number;
  pollMs: number;
  outputPlans: boolean;
  maxStrikeSats: number;
  minExpectedProfitSats: number;
  minConfidence: number;
  feePremiumBps: number;
}): Promise<void> {
  const action = "hunt";
  const allowPoolIds = opts.pools.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowPoolIds.length === 0) {
    errorOut(action, "missing_allowlist", "--pools is required", "Pass --pools dlmm_2,dlmm_6");
    return;
  }
  let pools: PoolMeta[];
  try {
    pools = (await loadPools()).filter((p) => allowPoolIds.includes(p.poolId));
  } catch (e: any) {
    errorOut(action, "api_unavailable", e?.message ?? "", "Retry");
    return;
  }
  const contractAllowlist = new Set(pools.map((p) => p.poolContract));

  const seen = new Set<string>();
  let iterations = 0;
  const detections: Record<string, unknown>[] = [];

  while (iterations < opts.maxIterations) {
    iterations += 1;
    try {
      const swaps = await pollMempool(contractAllowlist);
      for (const swap of swaps) {
        if (seen.has(swap.txId)) continue;
        seen.add(swap.txId);

        const pool = pools.find((p) => p.poolContract === swap.poolContract);
        if (!pool) continue;

        const inputToken =
          swap.direction === "x_for_y" ? pool.tokenX : pool.tokenY;
        const inputRaw =
          swap.direction === "x_for_y" ? swap.xAmountRaw! : swap.yAmountRaw!;
        const sizeSats = rawToSats(inputRaw, inputToken);
        if (sizeSats < opts.minSwapSizeSats) continue;

        const detection = {
          tx_id: swap.txId,
          pool_id: pool.poolId,
          pool_contract: pool.poolContract,
          symbol: `${pool.tokenX.symbol}/${pool.tokenY.symbol}`,
          direction: swap.direction,
          size_sats: sizeSats,
          size_display: formatDisplayAmount(
            inputRaw,
            inputToken.decimals,
            inputToken.symbol
          ),
          fee_bps: swap.direction === "x_for_y" ? pool.feeBpsX : pool.feeBpsY,
          total_fee_est_sats: Math.round(
            (sizeSats *
              (swap.direction === "x_for_y" ? pool.feeBpsX : pool.feeBpsY)) /
              10_000
          ),
          whale_fee_rate_ustx: swap.feeRate,
          detected_at: new Date().toISOString(),
        };
        detections.push(detection);
        // Stream each detection as its own JSON line.
        emitOut({
          status: "success",
          action: "detect",
          data: detection,
          error: null,
        });

        if (opts.outputPlans) {
          // Chain arm synchronously per detection.
          await cmdArm({
            txId: swap.txId,
            maxStrikeSats: opts.maxStrikeSats,
            minExpectedProfitSats: opts.minExpectedProfitSats,
            minConfidence: opts.minConfidence,
            feePremiumBps: opts.feePremiumBps,
            silent: true,
          });
        }
      }
    } catch (e: any) {
      emitOut({
        status: "blocked",
        action: "hunt",
        data: { iteration: iterations },
        error: {
          code: "mempool_unreachable",
          message: e?.message ?? "",
          next: "Back off and retry",
        },
      });
    }
    if (iterations < opts.maxIterations) {
      await new Promise((r) => setTimeout(r, opts.pollMs));
    }
  }

  success(action, {
    pools: allowPoolIds,
    iterations,
    total_detections: detections.length,
  });
}

async function cmdArm(opts: {
  txId?: string;
  swapRaw?: any;            // pre-decoded (used by autopilot)
  maxStrikeSats: number;
  minExpectedProfitSats: number;
  minConfidence: number;
  feePremiumBps: number;
  silent?: boolean;
}): Promise<StrikePlan | null> {
  const action = "arm";
  const emit = opts.silent ? () => {} : (o: SkillOutput) => emitOut(o);

  // 1. Resolve the swap tx
  let swap: MempoolSwap | null = null;
  if (opts.txId) {
    const tx = await fetchTxById(opts.txId);
    if (!tx) {
      emit({
        status: "error",
        action,
        data: {},
        error: { code: "tx_not_found", message: `tx ${opts.txId} not in mempool or chain`, next: "Re-hunt" },
      });
      return null;
    }
    if (tx.tx_status !== "pending") {
      emit({
        status: "blocked",
        action,
        data: { tx_status: tx.tx_status },
        error: { code: "swap_not_pending", message: "Target tx no longer pending", next: "Discard plan; hunt again" },
      });
      return null;
    }
    const decoded = decodeSwap(tx);
    if (!decoded) {
      emit({
        status: "blocked",
        action,
        data: {},
        error: { code: "not_a_swap", message: "tx is not a HODLMM swap", next: "Skip this tx" },
      });
      return null;
    }
    swap = {
      txId: tx.tx_id,
      senderAddress: tx.sender_address,
      feeRate: Number(tx.fee_rate),
      nonce: Number(tx.nonce),
      receiptTimeIso: tx.receipt_time_iso,
      poolContract: decoded.poolContract,
      functionName: tx.contract_call.function_name,
      direction: decoded.direction,
      xAmountRaw: decoded.direction === "x_for_y" ? decoded.amount : undefined,
      yAmountRaw: decoded.direction === "y_for_x" ? decoded.amount : undefined,
      minOutRaw: decoded.minOut,
      maxSteps: decoded.maxSteps,
      deadlineTime: decoded.deadline ? Number(decoded.deadline) : null,
    };
  } else if (opts.swapRaw) {
    swap = opts.swapRaw;
  } else {
    errorOut(action, "missing_target", "need --tx-id or piped detection", "Pass --tx-id");
    return null;
  }
  if (!swap) return null;

  // 2. Resolve pool
  const pool = await loadPoolByContract(swap.poolContract);
  if (!pool) {
    emit({
      status: "blocked",
      action,
      data: { pool_contract: swap.poolContract },
      error: { code: "pool_not_allowlisted", message: "pool not in registry", next: "Verify pool id; update allowlist" },
    });
    return null;
  }

  // 3. Active bin + TVL
  let activeBin: ActiveBinState;
  try {
    activeBin = await loadActiveBin(pool.poolId);
  } catch (e: any) {
    emit({
      status: "error",
      action,
      data: {},
      error: { code: "bins_unreachable", message: e?.message ?? "", next: "Retry" },
    });
    return null;
  }

  // 4. Compute swap size sats & fee, and cap strike capital.
  const inputToken = swap.direction === "x_for_y" ? pool.tokenX : pool.tokenY;
  const inputRaw = swap.direction === "x_for_y" ? swap.xAmountRaw! : swap.yAmountRaw!;
  const swapSizeSats = rawToSats(inputRaw, inputToken);
  const feeBps = swap.direction === "x_for_y" ? pool.feeBpsX : pool.feeBpsY;
  const totalFeeSats = Math.round((swapSizeSats * feeBps) / 10_000);

  // 5. Project bin cross
  const projection = projectBinCross(swap, pool, activeBin);

  // 6. Bin liquidity (best-effort: use the reserve of the *exit* side of the swap
  //    expressed in the *input* token terms → rough L for share-of-bin math).
  //    For directional swaps, our strike deposit is in the exit token.
  const exitToken = swap.direction === "x_for_y" ? pool.tokenY : pool.tokenX;
  const exitReserveRaw =
    swap.direction === "x_for_y" ? activeBin.reserveY : activeBin.reserveX;
  const binLiquiditySatsEquiv = rawToSats(exitReserveRaw, exitToken);

  // 7. Strike sizing: start from max, reduce if share-of-bin > cap.
  let capitalSats = opts.maxStrikeSats;
  // If L is very low, shrink capital to respect MAX_SHARE_OF_BIN.
  if (binLiquiditySatsEquiv > 0) {
    const maxCapForShare = Math.floor(
      (binLiquiditySatsEquiv * DEFAULTS.MAX_SHARE_OF_BIN) /
        (1 - DEFAULTS.MAX_SHARE_OF_BIN)
    );
    capitalSats = Math.max(0, Math.min(capitalSats, maxCapForShare));
  }

  if (capitalSats < 100) {
    emit({
      status: "blocked",
      action,
      data: { capital_sats: capitalSats },
      error: {
        code: "capital_too_small",
        message: "Strike capital below economic floor (100 sats)",
        next: "Increase --max-strike-sats or skip this pool",
      },
    });
    return null;
  }

  // 8. Share-of-bin + fee capture
  const capitalExitRaw = satsToRaw(capitalSats, exitToken);
  const feeCapture = estimateFeeCapture({
    swapSizeRaw: inputRaw,
    swapFeeBps: feeBps,
    portion: projection.portion,
    binLiquidity: exitReserveRaw,
    capitalRaw: capitalExitRaw,
    swapInputToken: inputToken,
  });

  // 9. Gas cost (sats-equiv)
  //    Resolve STX/USD: scan pools for a STX token and use its priceUsd.
  let stxUsd = 0;
  let btcUsd = 0;
  const allPools = [pool]; // already have this one; use token prices from it
  for (const t of [pool.tokenX, pool.tokenY]) {
    if (t.symbol.toUpperCase() === "SBTC") btcUsd = t.priceUsd;
  }
  // Pull STX price from another pool.
  try {
    const pools = await loadPools();
    for (const p of pools) {
      if (p.tokenX.symbol.toUpperCase() === "STX") stxUsd = p.tokenX.priceUsd;
      if (p.tokenY.symbol.toUpperCase() === "STX") stxUsd = p.tokenY.priceUsd;
      if (p.tokenX.symbol.toUpperCase() === "SBTC" && btcUsd === 0) btcUsd = p.tokenX.priceUsd;
      if (p.tokenY.symbol.toUpperCase() === "SBTC" && btcUsd === 0) btcUsd = p.tokenY.priceUsd;
    }
  } catch { /* ignore */ }

  // 10. Fee rate for strike tx: whale's fee + premium
  const feeRateUstx = Math.max(
    DEFAULTS.STRIKE_GAS_USTX,
    Math.ceil(swap.feeRate * (1 + opts.feePremiumBps / 10_000))
  );
  const expectedGasSats =
    gasSats(feeRateUstx, stxUsd, btcUsd) +
    gasSats(DEFAULTS.WITHDRAW_GAS_USTX, stxUsd, btcUsd);

  const expectedNetSats = feeCapture.feeCapturedSats - expectedGasSats;
  const expectedRoi = capitalSats > 0 ? (expectedNetSats / capitalSats) * 100 : 0;

  // 11. Confidence
  const detectedAge =
    (Date.now() - new Date(swap.receiptTimeIso).getTime()) / 1000;
  const poolWinRate = recentWinRateForPool(pool.poolId);
  const confidence = scoreConfidence({
    swapSizeRaw: inputRaw,
    poolMinSwapSats: Math.max(1, opts.minExpectedProfitSats * 10),
    detectedAgeSeconds: detectedAge,
    shareOfBin: feeCapture.shareOfBin,
    poolRecentWinRate: poolWinRate,
    swapInputToken: inputToken,
  });

  // 12. Safety gates
  const gates: Record<string, unknown> = {};
  if (expectedNetSats < opts.minExpectedProfitSats) {
    gates["min_expected_profit"] = {
      expected_net_sats: expectedNetSats,
      threshold_sats: opts.minExpectedProfitSats,
    };
  }
  if (confidence < opts.minConfidence) {
    gates["confidence"] = { confidence, floor: opts.minConfidence };
  }
  if (
    feeCapture.shareOfBin < DEFAULTS.MIN_SHARE_OF_BIN ||
    feeCapture.shareOfBin > DEFAULTS.MAX_SHARE_OF_BIN
  ) {
    gates["share_of_bin"] = {
      share: feeCapture.shareOfBin,
      min: DEFAULTS.MIN_SHARE_OF_BIN,
      max: DEFAULTS.MAX_SHARE_OF_BIN,
    };
  }
  // Daily caps
  const daily = dailyStats();
  if (daily.strikes >= DEFAULTS.MAX_DAILY_STRIKES) {
    gates["daily_strike_cap"] = { used: daily.strikes, cap: DEFAULTS.MAX_DAILY_STRIKES };
  }
  if (daily.loss >= DEFAULTS.MAX_DAILY_LOSS_SATS) {
    gates["daily_loss_cap"] = { loss: daily.loss, cap: DEFAULTS.MAX_DAILY_LOSS_SATS };
  }
  // Recent win rate
  const winRate = recentWinRate();
  if (winRate !== null && winRate < DEFAULTS.MIN_WIN_RATE_RECENT) {
    gates["win_rate_low"] = { win_rate: winRate, floor: DEFAULTS.MIN_WIN_RATE_RECENT };
  }

  if (Object.keys(gates).length > 0) {
    emit({
      status: "blocked",
      action,
      data: {
        gates,
        target_preview: {
          pool_id: pool.poolId,
          direction: swap.direction,
          swap_size_sats: swapSizeSats,
          total_fee_sats: totalFeeSats,
          expected_fee_capture_sats: feeCapture.feeCapturedSats,
          expected_net_sats: expectedNetSats,
          confidence,
          share_of_bin: feeCapture.shareOfBin,
        },
      },
      error: {
        code: Object.keys(gates)[0],
        message: `gate fired: ${Object.keys(gates).join(",")}`,
        next: "Adjust thresholds or wait for a better whale",
      },
    });
    return null;
  }

  // 13. Build MCP payloads
  //    For a directional swap x→y, we want to hold y in the active bin so
  //    the swap's output side finds our y-liquidity to trade into. The
  //    HODLMM add-liquidity-multi takes x_amount + y_amount per bin. For a
  //    pre-crossed single bin we set the "correct-side" token amount and
  //    leave the other zero.
  const xRaw = swap.direction === "y_for_x" ? capitalExitRaw : 0n;
  const yRaw = swap.direction === "x_for_y" ? capitalExitRaw : 0n;
  const mcpAdd = buildAddLiquidityPayload({
    pool,
    strikeBinIdAbsolute: activeBin.binId,
    xRaw,
    yRaw,
    feeRateUstx,
  });
  // Withdraw "amount" is DLP shares, which we won't know until after strike.
  // We precompute a placeholder payload and mark amount = "FROM_CHAIN"; the
  // harness or `retreat` resolves it from chain state before broadcasting.
  const mcpWithdraw = buildWithdrawPayload({
    pool,
    binIdAbsolute: activeBin.binId,
    amount: 0n,
    feeRateUstx: DEFAULTS.WITHDRAW_GAS_USTX,
    swapDirection: swap.direction,
  });
  (mcpWithdraw.params as any).positions[0].amount = "FROM_CHAIN";

  // 14. Assemble plan
  const planId = newPlanId();
  const validUntil = new Date(
    Date.now() + DEFAULTS.PLAN_TTL_SECONDS * 1000
  ).toISOString();
  const plan: StrikePlan = {
    planId,
    createdAt: new Date().toISOString(),
    validUntil,
    target: {
      swapTxId: swap.txId,
      poolId: pool.poolId,
      poolContract: pool.poolContract,
      direction: swap.direction,
      swapSizeRaw: inputRaw.toString(),
      swapSizeDisplay: formatDisplayAmount(
        inputRaw,
        inputToken.decimals,
        inputToken.symbol
      ),
      feeBps,
      totalFeeEstSats: totalFeeSats,
      detectedAt: swap.receiptTimeIso,
      whaleFeeRateUstx: swap.feeRate,
    },
    strike: {
      poolContract: pool.poolContract,
      xTokenContract: pool.tokenX.contract,
      yTokenContract: pool.tokenY.contract,
      targetBinOffset: activeBin.binId - DEFAULTS.CENTER_BIN_ID,
      absoluteBinId: activeBin.binId,
      capitalSats,
      capitalXRaw: xRaw.toString(),
      capitalYRaw: yRaw.toString(),
      expectedShareOfBin: feeCapture.shareOfBin,
      expectedFeeCaptureSats: feeCapture.feeCapturedSats,
      expectedGasSats,
      expectedNetSats,
      expectedRoiPct: expectedRoi,
      confidence,
    },
    mcpAddLiquidity: mcpAdd,
    mcpWithdraw: mcpWithdraw,
    retreatDeadlineBlock: 0, // filled in when we know the strike's block height
    feeRateUstx,
  };

  savePlan(plan);
  emit({
    status: "success",
    action,
    data: {
      plan_id: plan.planId,
      target: plan.target,
      strike: plan.strike,
      mcp_payload: plan.mcpAddLiquidity,
      mcp_retreat_payload: plan.mcpWithdraw,
      retreat_deadline_block: plan.retreatDeadlineBlock,
      valid_until: plan.validUntil,
    },
    error: null,
  });
  return plan;
}

async function cmdSimulate(opts: {
  txId: string;
  strikeSats: number;
  feePremiumBps: number;
}): Promise<void> {
  const action = "simulate";
  const tx = await fetchTxById(opts.txId);
  if (!tx) {
    errorOut(action, "tx_not_found", `tx ${opts.txId} not found`, "Check tx id");
    return;
  }
  const decoded = decodeSwap(tx);
  if (!decoded) {
    errorOut(action, "not_a_swap", "tx is not a HODLMM swap", "Pass a swap tx");
    return;
  }
  const poolContract = decoded.poolContract;
  const pool = await loadPoolByContract(poolContract);
  if (!pool) {
    errorOut(action, "unknown_pool", `pool ${poolContract} not in registry`, "Allowlist pool");
    return;
  }
  const activeBin = await loadActiveBin(pool.poolId);

  const inputToken = decoded.direction === "x_for_y" ? pool.tokenX : pool.tokenY;
  const exitToken = decoded.direction === "x_for_y" ? pool.tokenY : pool.tokenX;
  const exitReserveRaw =
    decoded.direction === "x_for_y" ? activeBin.reserveY : activeBin.reserveX;
  const feeBps = decoded.direction === "x_for_y" ? pool.feeBpsX : pool.feeBpsY;

  const swap: MempoolSwap = {
    txId: tx.tx_id,
    senderAddress: tx.sender_address,
    feeRate: Number(tx.fee_rate),
    nonce: Number(tx.nonce),
    receiptTimeIso: tx.receipt_time_iso ?? tx.burn_block_time_iso ?? new Date().toISOString(),
    poolContract: poolContract,
    functionName: tx.contract_call.function_name,
    direction: decoded.direction,
    xAmountRaw: decoded.direction === "x_for_y" ? decoded.amount : undefined,
    yAmountRaw: decoded.direction === "y_for_x" ? decoded.amount : undefined,
    minOutRaw: decoded.minOut,
    maxSteps: decoded.maxSteps,
    deadlineTime: decoded.deadline ? Number(decoded.deadline) : null,
  };

  const projection = projectBinCross(swap, pool, activeBin);
  const capitalExitRaw = satsToRaw(opts.strikeSats, exitToken);
  const capture = estimateFeeCapture({
    swapSizeRaw: decoded.amount,
    swapFeeBps: feeBps,
    portion: projection.portion,
    binLiquidity: exitReserveRaw,
    capitalRaw: capitalExitRaw,
    swapInputToken: inputToken,
  });

  // gas estimate
  let stxUsd = 0;
  let btcUsd = 0;
  const pools = await loadPools();
  for (const p of pools) {
    if (p.tokenX.symbol.toUpperCase() === "STX") stxUsd = p.tokenX.priceUsd;
    if (p.tokenY.symbol.toUpperCase() === "STX") stxUsd = p.tokenY.priceUsd;
    if (p.tokenX.symbol.toUpperCase() === "SBTC" && btcUsd === 0) btcUsd = p.tokenX.priceUsd;
    if (p.tokenY.symbol.toUpperCase() === "SBTC" && btcUsd === 0) btcUsd = p.tokenY.priceUsd;
  }
  const feeRateUstx = Math.ceil(swap.feeRate * (1 + opts.feePremiumBps / 10_000));
  const totalGasSats =
    gasSats(feeRateUstx, stxUsd, btcUsd) +
    gasSats(DEFAULTS.WITHDRAW_GAS_USTX, stxUsd, btcUsd);
  const netSats = capture.feeCapturedSats - totalGasSats;
  const roiPct = opts.strikeSats > 0 ? (netSats / opts.strikeSats) * 100 : 0;

  // Append a simulated ledger entry for clarity (outcome = simulated).
  const entry: LedgerEntry = {
    ts: new Date().toISOString(),
    planId: "sim-" + crypto.randomBytes(3).toString("hex"),
    outcome: "simulated",
    poolId: pool.poolId,
    swapTxId: tx.tx_id,
    capitalSats: opts.strikeSats,
    expectedNetSats: netSats,
    realizedFeeSats: capture.feeCapturedSats,
    realizedGasSats: totalGasSats,
    realizedNetSats: netSats,
    note: `simulated strike at bin ${activeBin.binId}, share=${capture.shareOfBin.toFixed(3)}, ρ=${projection.portion.toFixed(2)}`,
  };
  appendLedger(entry);

  success(action, {
    tx_id: tx.tx_id,
    pool_id: pool.poolId,
    symbol: `${pool.tokenX.symbol}/${pool.tokenY.symbol}`,
    direction: decoded.direction,
    swap_size_sats: rawToSats(decoded.amount, inputToken),
    fee_bps: feeBps,
    total_fee_sats: Math.round(
      (rawToSats(decoded.amount, inputToken) * feeBps) / 10_000
    ),
    strike: {
      capital_sats: opts.strikeSats,
      bin_id: activeBin.binId,
      share_of_bin: capture.shareOfBin,
      portion_in_bin: projection.portion,
      expected_fee_capture_sats: capture.feeCapturedSats,
      expected_gas_sats: totalGasSats,
      expected_net_sats: netSats,
      expected_roi_pct: roiPct,
    },
    ledger_entry: entry,
  });
}

async function cmdStrike(opts: {
  plan?: string;
  txId?: string;
  execute: boolean;
  maxStrikeSats: number;
  minExpectedProfitSats: number;
  minConfidence: number;
  feePremiumBps: number;
}): Promise<void> {
  const action = "strike";
  let plan: StrikePlan | null = null;
  if (opts.plan) {
    try {
      plan = JSON.parse(fs.readFileSync(opts.plan, "utf8")) as StrikePlan;
    } catch (e: any) {
      errorOut(action, "bad_plan_file", e?.message ?? "", "Regenerate via arm");
      return;
    }
  } else if (opts.txId) {
    plan = await cmdArm({
      txId: opts.txId,
      maxStrikeSats: opts.maxStrikeSats,
      minExpectedProfitSats: opts.minExpectedProfitSats,
      minConfidence: opts.minConfidence,
      feePremiumBps: opts.feePremiumBps,
      silent: true,
    });
    if (!plan) {
      // cmdArm already emitted silently; surface minimal error.
      blocked(action, "arm_failed", "arm did not produce a plan", "Re-hunt", {});
      return;
    }
  } else {
    errorOut(action, "missing_target", "--plan or --tx-id required", "Provide one");
    return;
  }

  // Freshness check
  if (new Date(plan.validUntil).getTime() < Date.now()) {
    blocked(action, "plan_expired", "plan is past valid_until", "Re-arm via hunt+arm", { plan_id: plan.planId });
    return;
  }

  // Verify target tx still pending
  const tx = await fetchTxById(plan.target.swapTxId);
  if (!tx || tx.tx_status !== "pending") {
    blocked(action, "swap_not_pending", "target swap no longer pending", "Discard plan", {
      plan_id: plan.planId,
      tx_status: tx?.tx_status ?? "unknown",
    });
    return;
  }

  // Safety state
  const daily = dailyStats();
  if (daily.strikes >= DEFAULTS.MAX_DAILY_STRIKES) {
    blocked(action, "daily_cap_hit", "max_daily_strikes reached", "Wait until next UTC day", daily);
    return;
  }
  if (daily.loss >= DEFAULTS.MAX_DAILY_LOSS_SATS) {
    blocked(action, "loss_cap_hit", "max_daily_loss_sats reached", "Wait until next UTC day", daily);
    return;
  }
  const state = loadState();
  if (state.openPlanId) {
    blocked(action, "open_position", "a prior strike is not yet retreated", "Retreat first", {
      open_plan_id: state.openPlanId,
    });
    return;
  }

  if (!opts.execute) {
    success(action, {
      plan_id: plan.planId,
      mcp_payload: plan.mcpAddLiquidity,
      note: "Dry-run. Pass --execute to emit for MCP harness broadcast.",
    });
    return;
  }

  // Record open position state BEFORE emitting (so if the harness crashes we
  // still know to retreat).
  state.openPlanId = plan.planId;
  state.openAt = new Date().toISOString();
  saveState(state);

  // Append provisional ledger entry (outcome will be updated by retreat).
  appendLedger({
    ts: new Date().toISOString(),
    planId: plan.planId,
    outcome: "aborted",             // flips to success/loss on retreat
    poolId: plan.target.poolId,
    swapTxId: plan.target.swapTxId,
    capitalSats: plan.strike.capitalSats,
    expectedNetSats: plan.strike.expectedNetSats,
    note: "strike broadcast — awaiting retreat",
  });

  success(action, {
    plan_id: plan.planId,
    execute: true,
    mcp_payload: plan.mcpAddLiquidity,
    retreat_mcp_payload: plan.mcpWithdraw,
    retreat_instructions:
      "After the add-liquidity tx confirms, read the minted DLP amount from the receipt and call retreat --plan-id " +
      plan.planId +
      " --execute",
  });
}

async function cmdRetreat(opts: {
  planId: string;
  execute: boolean;
  strikeTxId?: string;
  dlpAmount?: string;
  realizedFeeSats?: number;
  realizedGasSats?: number;
}): Promise<void> {
  const action = "retreat";
  const plan = loadPlan(opts.planId);
  if (!plan) {
    errorOut(action, "plan_not_found", `plan ${opts.planId} missing`, "Check plan id");
    return;
  }

  // Build the withdraw payload with a resolved amount if provided.
  const withdraw = plan.mcpWithdraw;
  if (opts.dlpAmount) {
    (withdraw.params as any).positions[0].amount = opts.dlpAmount;
  }

  if (!opts.execute) {
    success(action, {
      plan_id: plan.planId,
      mcp_payload: withdraw,
      note: "Dry-run. Pass --execute to emit for broadcast.",
    });
    return;
  }

  // Book realized PnL into the ledger (overwriting the provisional entry for
  // this plan if present).
  const realizedFee = opts.realizedFeeSats ?? plan.strike.expectedFeeCaptureSats;
  const realizedGas = opts.realizedGasSats ?? plan.strike.expectedGasSats;
  const realizedNet = realizedFee - realizedGas;

  // Rewrite ledger: remove the provisional `aborted` entry and append a
  // definitive entry. Cheap since the ledger is small; if it grows large
  // this should be optimized.
  const existing = readLedger();
  const filtered = existing.filter(
    (e) => !(e.planId === plan.planId && e.outcome === "aborted")
  );
  fs.writeFileSync(LEDGER_FILE, filtered.map((e) => JSON.stringify(e)).join("\n") + (filtered.length ? "\n" : ""));
  appendLedger({
    ts: new Date().toISOString(),
    planId: plan.planId,
    outcome: realizedNet >= 0 ? "success" : "loss",
    poolId: plan.target.poolId,
    swapTxId: plan.target.swapTxId,
    strikeTxId: opts.strikeTxId,
    capitalSats: plan.strike.capitalSats,
    expectedNetSats: plan.strike.expectedNetSats,
    realizedFeeSats: realizedFee,
    realizedGasSats: realizedGas,
    realizedNetSats: realizedNet,
  });

  // Clear open position state
  const state = loadState();
  if (state.openPlanId === plan.planId) {
    delete state.openPlanId;
    delete state.openAt;
    saveState(state);
  }

  success(action, {
    plan_id: plan.planId,
    mcp_payload: withdraw,
    realized: {
      fee_sats: realizedFee,
      gas_sats: realizedGas,
      net_sats: realizedNet,
      roi_pct:
        plan.strike.capitalSats > 0
          ? (realizedNet / plan.strike.capitalSats) * 100
          : 0,
    },
    state: { open_plan_cleared: true },
  });
}

async function cmdAbort(opts: { execute: boolean }): Promise<void> {
  const action = "abort";
  const state = loadState();
  if (!state.openPlanId) {
    success(action, { cleared: false, note: "no open position" });
    return;
  }
  const plan = loadPlan(String(state.openPlanId));
  if (!plan) {
    success(action, {
      cleared: false,
      note: "open_plan_id set but plan file missing — clearing state",
    });
    delete state.openPlanId;
    saveState(state);
    return;
  }
  const withdraw = plan.mcpWithdraw;
  if (!opts.execute) {
    success(action, {
      plan_id: plan.planId,
      mcp_payload: withdraw,
      note: "Dry-run abort. Pass --execute to emit.",
    });
    return;
  }
  // Clear state; harness will broadcast.
  appendLedger({
    ts: new Date().toISOString(),
    planId: plan.planId,
    outcome: "aborted",
    poolId: plan.target.poolId,
    swapTxId: plan.target.swapTxId,
    capitalSats: plan.strike.capitalSats,
    expectedNetSats: plan.strike.expectedNetSats,
    note: "aborted — emergency retreat requested",
  });
  delete state.openPlanId;
  saveState(state);
  success(action, {
    plan_id: plan.planId,
    mcp_payload: withdraw,
    note: "Emergency retreat payload emitted. State cleared.",
  });
}

async function cmdAutopilot(opts: {
  pools: string;
  minSwapSizeSats: number;
  maxStrikeSats: number;
  maxDailyStrikes: number;
  maxDailyLossSats: number;
  minExpectedProfitSats: number;
  minConfidence: number;
  feePremiumBps: number;
  cooldownSeconds: number;
  maxIterations: number;
  pollMs: number;
  dryRun: boolean;
}): Promise<void> {
  const action = "autopilot";
  const allowPoolIds = opts.pools.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowPoolIds.length === 0) {
    errorOut(action, "missing_allowlist", "--pools is required", "Pass --pools");
    return;
  }

  let consecutiveAborted = 0;
  let iterations = 0;
  const startedAt = new Date().toISOString();
  let strikesThisRun = 0;

  const pools = (await loadPools()).filter((p) => allowPoolIds.includes(p.poolId));
  const contractAllowlist = new Set(pools.map((p) => p.poolContract));

  while (iterations < opts.maxIterations) {
    iterations += 1;
    // Hard stops
    const daily = dailyStats();
    if (daily.strikes >= opts.maxDailyStrikes) {
      blocked(action, "daily_cap_hit", "daily strike cap reached", "Wait until next UTC day", daily);
      return;
    }
    if (daily.loss >= opts.maxDailyLossSats) {
      blocked(action, "loss_cap_hit", "daily loss cap reached", "Wait until next UTC day", daily);
      return;
    }
    if (consecutiveAborted >= 3) {
      blocked(action, "consecutive_aborts", "3+ consecutive aborts", "Rerun calibrate", { consecutiveAborted });
      return;
    }
    const winRate = recentWinRate();
    if (winRate !== null && winRate < DEFAULTS.MIN_WIN_RATE_RECENT) {
      blocked(action, "win_rate_low", "win rate below floor", "Rerun calibrate", { win_rate: winRate });
      return;
    }

    try {
      const swaps = await pollMempool(contractAllowlist);
      // Stream detections
      for (const swap of swaps) {
        const pool = pools.find((p) => p.poolContract === swap.poolContract);
        if (!pool) continue;
        const inputToken =
          swap.direction === "x_for_y" ? pool.tokenX : pool.tokenY;
        const inputRaw =
          swap.direction === "x_for_y" ? swap.xAmountRaw! : swap.yAmountRaw!;
        const sizeSats = rawToSats(inputRaw, inputToken);
        if (sizeSats < opts.minSwapSizeSats) continue;

        // arm silently
        const plan = await cmdArm({
          txId: swap.txId,
          maxStrikeSats: opts.maxStrikeSats,
          minExpectedProfitSats: opts.minExpectedProfitSats,
          minConfidence: opts.minConfidence,
          feePremiumBps: opts.feePremiumBps,
          silent: true,
        });
        if (!plan) {
          consecutiveAborted += 1;
          continue;
        }
        // strike
        await cmdStrike({
          plan: planPath(plan.planId),
          execute: !opts.dryRun,
          maxStrikeSats: opts.maxStrikeSats,
          minExpectedProfitSats: opts.minExpectedProfitSats,
          minConfidence: opts.minConfidence,
          feePremiumBps: opts.feePremiumBps,
        });
        if (!opts.dryRun) strikesThisRun += 1;
        // retreat (the harness should chain after strike confirms; we emit the
        // payload preemptively as part of the cycle).
        await cmdRetreat({
          planId: plan.planId,
          execute: !opts.dryRun,
        });
        consecutiveAborted = 0;

        // Cooldown
        await new Promise((r) => setTimeout(r, opts.cooldownSeconds * 1000));

        // Re-check daily cap after each strike.
        const dd = dailyStats();
        if (dd.strikes >= opts.maxDailyStrikes || dd.loss >= opts.maxDailyLossSats) break;
      }
    } catch (e: any) {
      emitOut({
        status: "blocked",
        action,
        data: { iteration: iterations },
        error: { code: "mempool_unreachable", message: e?.message ?? "", next: "Back off" },
      });
    }
    if (iterations < opts.maxIterations) {
      await new Promise((r) => setTimeout(r, opts.pollMs));
    }
  }

  success(action, {
    pools: allowPoolIds,
    iterations,
    strikes_this_run: strikesThisRun,
    started_at: startedAt,
    dry_run: opts.dryRun,
  });
}

async function cmdLedger(opts: { windowDays: number }): Promise<void> {
  const action = "ledger";
  const all = readLedger();
  const cutoffMs = Date.now() - opts.windowDays * 86400 * 1000;
  const entries = all.filter((e) => new Date(e.ts).getTime() >= cutoffMs);
  const strikes = entries.filter(
    (e) => e.outcome === "success" || e.outcome === "loss"
  );
  const aborted = entries.filter((e) => e.outcome === "aborted").length;
  const simulated = entries.filter((e) => e.outcome === "simulated").length;
  const wins = strikes.filter((e) => (e.realizedNetSats ?? 0) > 0);
  const losses = strikes.filter((e) => (e.realizedNetSats ?? 0) <= 0);
  const grossFee = strikes.reduce((a, e) => a + (e.realizedFeeSats ?? 0), 0);
  const grossGas = strikes.reduce((a, e) => a + (e.realizedGasSats ?? 0), 0);
  const netRealized = strikes.reduce((a, e) => a + (e.realizedNetSats ?? 0), 0);
  const avgRoi =
    strikes.length > 0
      ? strikes.reduce(
          (a, e) =>
            a +
            (e.capitalSats > 0
              ? ((e.realizedNetSats ?? 0) / e.capitalSats) * 100
              : 0),
          0
        ) / strikes.length
      : 0;

  const openState = loadState();
  success(action, {
    window_days: opts.windowDays,
    entries_total: entries.length,
    strikes: strikes.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: strikes.length > 0 ? wins.length / strikes.length : null,
    gross_fee_captured_sats: grossFee,
    gross_gas_sats: grossGas,
    net_realized_sats: netRealized,
    avg_roi_pct_per_strike: avgRoi,
    aborted,
    simulated,
    open_position: openState.openPlanId
      ? { plan_id: openState.openPlanId, opened_at: openState.openAt }
      : null,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// CLI
// ═════════════════════════════════════════════════════════════════════════════

const program = new Command();

program
  .name("hodlmm-predator")
  .description("Just-in-time HODLMM liquidity searcher for Bitflow (Stacks mainnet).")
  .version("0.1.0");

program
  .command("doctor")
  .description("Preflight: mempool, APIs, wallet, MCP, clock, allowlist")
  .option("--pools <ids>", "comma-separated pool ids to validate", "")
  .action(async (opts) => {
    try {
      await cmdDoctor(opts);
    } catch (e: any) {
      errorOut("doctor", "exception", e?.message ?? String(e), "Investigate stack");
    }
  });

program
  .command("calibrate")
  .description("Analyze a pool's recent swap history to tune strike params")
  .option("--pool-id <id>", "pool id (e.g. dlmm_2)")
  .option("--lookback-days <n>", "days of history", (x) => Number(x), 7)
  .option("--max-strike-sats <n>", "capital cap", (x) => Number(x), DEFAULTS.MAX_STRIKE_SATS)
  .action(async (opts) => {
    if (!opts.poolId) {
      errorOut("calibrate", "missing_arg", "--pool-id required", "Pass --pool-id");
      return;
    }
    try {
      await cmdCalibrate({
        poolId: opts.poolId,
        lookbackDays: opts.lookbackDays,
        maxStrikeSats: opts.maxStrikeSats,
      });
    } catch (e: any) {
      errorOut("calibrate", "exception", e?.message ?? String(e), "Investigate");
    }
  });

program
  .command("hunt")
  .description("Poll mempool and stream whale-swap detections as JSONL")
  .requiredOption("--pools <ids>", "comma-separated allowlist pool ids")
  .option("--min-swap-size-sats <n>", "minimum whale swap size in sats-equiv", (x) => Number(x), DEFAULTS.MIN_SWAP_SIZE_SATS)
  .option("--max-iterations <n>", "max poll cycles before exit", (x) => Number(x), DEFAULTS.MAX_HUNT_ITERATIONS)
  .option("--poll-ms <n>", "ms between polls", (x) => Number(x), DEFAULTS.MEMPOOL_POLL_MS)
  .option("--emit-plan", "also run arm for each detection", false)
  .option("--max-strike-sats <n>", "capital cap for chained arm", (x) => Number(x), DEFAULTS.MAX_STRIKE_SATS)
  .option("--min-expected-profit-sats <n>", "profit gate for chained arm", (x) => Number(x), DEFAULTS.MIN_EXPECTED_PROFIT_SATS)
  .option("--min-confidence <x>", "confidence floor for chained arm", (x) => Number(x), DEFAULTS.MIN_CONFIDENCE)
  .option("--fee-premium-bps <n>", "fee premium over whale for chained arm", (x) => Number(x), DEFAULTS.FEE_PREMIUM_BPS)
  .action(async (opts) => {
    try {
      await cmdHunt({
        pools: opts.pools,
        minSwapSizeSats: opts.minSwapSizeSats,
        maxIterations: opts.maxIterations,
        pollMs: opts.pollMs,
        outputPlans: !!opts.emitPlan,
        maxStrikeSats: opts.maxStrikeSats,
        minExpectedProfitSats: opts.minExpectedProfitSats,
        minConfidence: opts.minConfidence,
        feePremiumBps: opts.feePremiumBps,
      });
    } catch (e: any) {
      errorOut("hunt", "exception", e?.message ?? String(e), "Investigate");
    }
  });

program
  .command("arm")
  .description("Compute a strike plan for a detected swap tx")
  .option("--tx-id <id>", "mempool swap tx id")
  .option("--max-strike-sats <n>", "capital cap", (x) => Number(x), DEFAULTS.MAX_STRIKE_SATS)
  .option("--min-expected-profit-sats <n>", "profit gate", (x) => Number(x), DEFAULTS.MIN_EXPECTED_PROFIT_SATS)
  .option("--min-confidence <x>", "confidence floor", (x) => Number(x), DEFAULTS.MIN_CONFIDENCE)
  .option("--fee-premium-bps <n>", "fee premium over whale", (x) => Number(x), DEFAULTS.FEE_PREMIUM_BPS)
  .action(async (opts) => {
    try {
      await cmdArm({
        txId: opts.txId,
        maxStrikeSats: opts.maxStrikeSats,
        minExpectedProfitSats: opts.minExpectedProfitSats,
        minConfidence: opts.minConfidence,
        feePremiumBps: opts.feePremiumBps,
      });
    } catch (e: any) {
      errorOut("arm", "exception", e?.message ?? String(e), "Investigate");
    }
  });

program
  .command("simulate")
  .description("Replay a past HODLMM swap through arm/strike/retreat without broadcasting")
  .requiredOption("--tx-id <id>", "historical swap tx id")
  .option("--strike-sats <n>", "strike capital", (x) => Number(x), DEFAULTS.MAX_STRIKE_SATS)
  .option("--fee-premium-bps <n>", "fee premium over whale", (x) => Number(x), DEFAULTS.FEE_PREMIUM_BPS)
  .action(async (opts) => {
    try {
      await cmdSimulate({
        txId: opts.txId,
        strikeSats: opts.strikeSats,
        feePremiumBps: opts.feePremiumBps,
      });
    } catch (e: any) {
      errorOut("simulate", "exception", e?.message ?? String(e), "Investigate");
    }
  });

program
  .command("strike")
  .description("Emit add-liquidity MCP payload for an armed plan (WRITES when --execute)")
  .option("--plan <path>", "path to plan JSON from arm")
  .option("--tx-id <id>", "alternate: re-arm inline from swap tx id")
  .option("--execute", "broadcast via harness", false)
  .option("--max-strike-sats <n>", "capital cap", (x) => Number(x), DEFAULTS.MAX_STRIKE_SATS)
  .option("--min-expected-profit-sats <n>", "profit gate", (x) => Number(x), DEFAULTS.MIN_EXPECTED_PROFIT_SATS)
  .option("--min-confidence <x>", "confidence floor", (x) => Number(x), DEFAULTS.MIN_CONFIDENCE)
  .option("--fee-premium-bps <n>", "fee premium over whale", (x) => Number(x), DEFAULTS.FEE_PREMIUM_BPS)
  .action(async (opts) => {
    try {
      await cmdStrike({
        plan: opts.plan,
        txId: opts.txId,
        execute: !!opts.execute,
        maxStrikeSats: opts.maxStrikeSats,
        minExpectedProfitSats: opts.minExpectedProfitSats,
        minConfidence: opts.minConfidence,
        feePremiumBps: opts.feePremiumBps,
      });
    } catch (e: any) {
      errorOut("strike", "exception", e?.message ?? String(e), "Investigate");
    }
  });

program
  .command("retreat")
  .description("Emit withdraw MCP payload + book realized PnL (WRITES when --execute)")
  .requiredOption("--plan-id <id>", "plan id from arm")
  .option("--execute", "broadcast via harness", false)
  .option("--strike-tx-id <id>", "observed on-chain strike tx id")
  .option("--dlp-amount <n>", "DLP shares to withdraw (from strike receipt)")
  .option("--realized-fee-sats <n>", "actual captured fee", (x) => Number(x))
  .option("--realized-gas-sats <n>", "actual gas sats", (x) => Number(x))
  .action(async (opts) => {
    try {
      await cmdRetreat({
        planId: opts.planId,
        execute: !!opts.execute,
        strikeTxId: opts.strikeTxId,
        dlpAmount: opts.dlpAmount,
        realizedFeeSats: opts.realizedFeeSats,
        realizedGasSats: opts.realizedGasSats,
      });
    } catch (e: any) {
      errorOut("retreat", "exception", e?.message ?? String(e), "Investigate");
    }
  });

program
  .command("autopilot")
  .description("Closed loop: hunt → arm → strike → retreat under all safety rails")
  .requiredOption("--pools <ids>", "comma-separated pool id allowlist")
  .option("--min-swap-size-sats <n>", "whale threshold", (x) => Number(x), DEFAULTS.MIN_SWAP_SIZE_SATS)
  .option("--max-strike-sats <n>", "capital cap per strike", (x) => Number(x), DEFAULTS.MAX_STRIKE_SATS)
  .option("--max-daily-strikes <n>", "daily strike cap", (x) => Number(x), DEFAULTS.MAX_DAILY_STRIKES)
  .option("--max-daily-loss-sats <n>", "daily loss cap", (x) => Number(x), DEFAULTS.MAX_DAILY_LOSS_SATS)
  .option("--min-expected-profit-sats <n>", "profit gate", (x) => Number(x), DEFAULTS.MIN_EXPECTED_PROFIT_SATS)
  .option("--min-confidence <x>", "confidence floor", (x) => Number(x), DEFAULTS.MIN_CONFIDENCE)
  .option("--fee-premium-bps <n>", "fee premium over whale", (x) => Number(x), DEFAULTS.FEE_PREMIUM_BPS)
  .option("--cooldown-seconds <n>", "between strikes", (x) => Number(x), DEFAULTS.COOLDOWN_SECONDS)
  .option("--max-iterations <n>", "max poll cycles", (x) => Number(x), DEFAULTS.MAX_HUNT_ITERATIONS)
  .option("--poll-ms <n>", "ms between polls", (x) => Number(x), DEFAULTS.MEMPOOL_POLL_MS)
  .option("--dry-run", "plan + emit but never set --execute", false)
  .action(async (opts) => {
    try {
      await cmdAutopilot({
        pools: opts.pools,
        minSwapSizeSats: opts.minSwapSizeSats,
        maxStrikeSats: opts.maxStrikeSats,
        maxDailyStrikes: opts.maxDailyStrikes,
        maxDailyLossSats: opts.maxDailyLossSats,
        minExpectedProfitSats: opts.minExpectedProfitSats,
        minConfidence: opts.minConfidence,
        feePremiumBps: opts.feePremiumBps,
        cooldownSeconds: opts.cooldownSeconds,
        maxIterations: opts.maxIterations,
        pollMs: opts.pollMs,
        dryRun: !!opts.dryRun,
      });
    } catch (e: any) {
      errorOut("autopilot", "exception", e?.message ?? String(e), "Investigate");
    }
  });

program
  .command("ledger")
  .description("Summarize strike history")
  .option("--window <d>", "days (e.g. 30d)", (x) => Number(String(x).replace(/d$/, "")), 30)
  .action(async (opts) => {
    try {
      await cmdLedger({ windowDays: opts.window });
    } catch (e: any) {
      errorOut("ledger", "exception", e?.message ?? String(e), "Investigate");
    }
  });

program
  .command("abort")
  .description("Emergency: retreat any open strike")
  .option("--execute", "broadcast via harness", false)
  .action(async (opts) => {
    try {
      await cmdAbort({ execute: !!opts.execute });
    } catch (e: any) {
      errorOut("abort", "exception", e?.message ?? String(e), "Investigate");
    }
  });

program.parseAsync().catch((e: any) => {
  errorOut("cli", "parse_error", e?.message ?? String(e), "Check arguments");
  process.exit(1);
});
