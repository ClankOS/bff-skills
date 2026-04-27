#!/usr/bin/env bun
/**
 * bitflow-neutral — Delta-neutral HODLMM liquidity farming.
 *
 * Farms Bitflow DLMM swap fees while cancelling out directional price risk
 * via a matching Zest short. Net exposure ≈ zero — you earn the spread
 * between HODLMM fee APR and Zest borrow APR, not the price move.
 *
 * Commands:
 *   doctor       Environment + wallet + contract reachability checks
 *   plan         Analyze a prospective position (reads chain, no writes)
 *   simulate     Monte Carlo P&L — pure math, no network
 *   open         Leg 1: add HODLMM liquidity around active bin
 *   hedge        Leg 2: open matching Zest borrow to zero net delta
 *   status       Live position X-ray
 *   rebalance    Adjust Zest debt to re-flatten net delta after drift
 *   harvest      Withdraw-and-redeposit at active bin to compound fees
 *   unwind       Full teardown: repay Zest + withdraw LP + swap to base
 *   monitor      Single JSON snapshot for cron / agent loops
 *
 * Built by Clank (ClankOS) — @claim clank.btc — for the AIBTC × BFF comp.
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ═════════════════════════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════════════════════════

const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.mainnet.hiro.so";

// DLMM router v-1-1 — mainnet, current.
const ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME = "dlmm-liquidity-router-v-1-1";

// Zest Protocol v2 (from zest-yield-manager, mainnet).
const ZEST_POOL = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3";
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const USDCX_TOKEN = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";

// Safety defaults.
const DEFAULT_MAX_POSITION_SATS = 5_000_000;              // ~0.05 BTC
const DEFAULT_SPREAD_BINS = 5;                            // ±5 bins around active
const DEFAULT_DRIFT_THRESHOLD = 0.05;                     // 5% delta drift trips rebalance
const DEFAULT_MIN_NET_APR = 0.02;                         // 2% annualized net APR required to open
const DEFAULT_MAX_LTV = 0.50;                             // 50% LTV cap (Zest liquidates ~80%)
const DEFAULT_MONTE_CARLO_PATHS = 10_000;
const MIN_GAS_USTX = 200_000;                             // 0.2 STX reserved for gas per leg
const RECONCILE_POLL_MS = 5_000;
const RECONCILE_MAX_POLLS = 24;                           // 2 min max wait per tx
const FETCH_TIMEOUT_MS = 30_000;
const CENTER_BIN_ID = 500;                                // NUM_BINS (1001) / 2 → contract signed bin offset

const STATE_DIR = path.join(os.homedir(), ".aibtc", "bitflow-neutral");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");

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
}

interface PoolMeta {
  poolId: string;
  poolContract: string;
  tokenX: TokenMeta;
  tokenY: TokenMeta;
  activeBin: number;
  binStep: number;
  tvlUsd: number;
  tvlBtc: number;
  feesUsd1d: number;
  volumeUsd1d: number;
  apr: number;
  apr24h: number;
  baseFee: number;
}

interface BinData {
  bin_id: number;
  reserve_x: bigint;
  reserve_y: bigint;
  price: number;           // tokenY per tokenX in raw-unit ratio
  liquidity: bigint;
}

interface UserBin {
  bin_id: number;
  liquidity: bigint;
  reserve_x: bigint;
  reserve_y: bigint;
  price: number;
}

interface ZestPosition {
  supplied_sbtc_sats: bigint;
  borrowed_sbtc_sats: bigint;
  supplied_stx_ustx: bigint;
  borrowed_stx_ustx: bigint;
  supplied_usdcx: bigint;
  borrowed_usdcx: bigint;
  ltv: number;
  liquidation_threshold: number;
}

interface DeltaReport {
  total_x_raw: bigint;
  total_y_raw: bigint;
  total_x_display: number;
  total_y_display: number;
  position_value_y: number;
  delta_x_display: number;
  delta_pct: number;
}

interface HedgePlan {
  borrow_token: "sBTC" | "STX";
  borrow_amount_raw: bigint;
  borrow_amount_display: number;
  collateral_token: "USDCx" | "sBTC";
  collateral_amount_raw: bigint;
  collateral_amount_display: number;
  resulting_ltv: number;
  resulting_liquidation_distance_pct: number;
}

interface MonteCarloResult {
  paths: number;
  days: number;
  vol_annual: number;
  drift_annual: number;
  expected_pnl_pct: number;
  p5_pnl_pct: number;
  p50_pnl_pct: number;
  p95_pnl_pct: number;
  worst_pnl_pct: number;
  prob_loss_gt_2pct: number;
  prob_liquidation: number;
}

interface StrategyState {
  pool_id: string;
  opened_at: string;
  initial_amount_sats: number;
  target_spread_bins: number;
  target_drift_threshold: number;
  lp_tx_id?: string;
  hedge_tx_id?: string;
  rebalance_count: number;
  harvest_count: number;
  last_rebalance_at?: string;
  notes?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Output helpers
// ═════════════════════════════════════════════════════════════════════════════

function out(o: SkillOutput): void {
  console.log(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function success(action: string, data: Record<string, unknown>): void {
  out({ status: "success", action, data, error: null });
}

function blocked(code: string, message: string, next: string, data: Record<string, unknown> = {}): void {
  out({ status: "blocked", action: next, data, error: { code, message, next } });
}

function errorOut(code: string, message: string, next: string, data: Record<string, unknown> = {}): void {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

function log(...args: unknown[]): void {
  process.stderr.write(`[bitflow-neutral] ${args.join(" ")}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// Generic helpers
// ═════════════════════════════════════════════════════════════════════════════

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function splitContract(id: string): { address: string; name: string } {
  const [address, name] = id.split(".");
  return { address, name };
}

function rawToDisplay(raw: bigint, decimals: number): number {
  const d = Number(raw) / Math.pow(10, decimals);
  return d;
}

function displayToRaw(display: number, decimals: number): bigint {
  return BigInt(Math.floor(display * Math.pow(10, decimals)));
}

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readState(): StrategyState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as StrategyState;
  } catch {
    return null;
  }
}

function writeState(s: StrategyState): void {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function clearState(): void {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

// ═════════════════════════════════════════════════════════════════════════════
// Bitflow API reads
// ═════════════════════════════════════════════════════════════════════════════

async function fetchDlmmPools(): Promise<PoolMeta[]> {
  const raw = await fetchJson<{ data: Record<string, unknown>[] }>(
    `${BITFLOW_APP}/pools?amm_type=dlmm`
  );
  return (raw.data ?? []).map((p) => {
    const tx = p.tokens as Record<string, Record<string, unknown>>;
    const parseToken = (t: Record<string, unknown>): TokenMeta => ({
      contract: String(t.contract ?? ""),
      symbol: String(t.symbol ?? "?"),
      decimals: Number(t.decimals ?? 8),
      priceUsd: Number(t.priceUsd ?? 0),
    });
    return {
      poolId: String(p.poolId ?? ""),
      poolContract: String(p.poolContract ?? ""),
      tokenX: parseToken(tx.tokenX),
      tokenY: parseToken(tx.tokenY),
      activeBin: 0, // filled by fetchPoolBins
      binStep: Number(p.binStep ?? 0),
      tvlUsd: Number(p.tvlUsd ?? 0),
      tvlBtc: Number(p.tvlBtc ?? 0),
      feesUsd1d: Number(p.feesUsd1d ?? 0),
      volumeUsd1d: Number(p.volumeUsd1d ?? 0),
      apr: Number(p.apr ?? 0),
      apr24h: Number(p.apr24h ?? 0),
      baseFee: Number(p.baseFee ?? 0),
    };
  });
}

async function fetchPoolBins(poolId: string): Promise<{ active_bin: number; bins: BinData[] }> {
  const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/${poolId}`);
  const active = Number(raw.active_bin_id ?? 0);
  const bins = ((raw.bins ?? []) as Record<string, unknown>[]).map((b) => ({
    bin_id: Number(b.bin_id),
    reserve_x: BigInt(String(b.reserve_x ?? "0")),
    reserve_y: BigInt(String(b.reserve_y ?? "0")),
    price: Number(b.price ?? 0),
    liquidity: BigInt(String(b.liquidity ?? "0")),
  }));
  return { active_bin: active, bins };
}

async function fetchPoolActiveBin(poolId: string): Promise<{ active_bin: number; active_price: number }> {
  const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/${poolId}/active`);
  return {
    active_bin: Number(raw.bin_id ?? raw.active_bin_id ?? 0),
    active_price: Number(raw.price ?? 0),
  };
}

async function fetchUserLp(poolId: string, wallet: string): Promise<UserBin[]> {
  try {
    const raw = await fetchJson<Record<string, unknown>>(
      `${BITFLOW_APP}/users/${wallet}/positions/${poolId}/bins`
    );
    const bins = (raw.bins ?? []) as Record<string, unknown>[];
    return bins
      .filter((b) => BigInt(String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0")) > 0n)
      .map((b) => ({
        bin_id: Number(b.bin_id),
        liquidity: BigInt(String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0")),
        reserve_x: BigInt(String(b.reserve_x ?? "0")),
        reserve_y: BigInt(String(b.reserve_y ?? "0")),
        price: Number(b.price ?? 0),
      }));
  } catch {
    return [];
  }
}

async function fetchStxBalance(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, string>>(`${HIRO_API}/extended/v1/address/${wallet}/stx`);
  return BigInt(data?.balance ?? "0") - BigInt(data?.locked ?? "0");
}

async function fetchFtBalance(wallet: string, tokenContract: string, assetName: string): Promise<bigint> {
  const data = await fetchJson<Record<string, unknown>>(`${HIRO_API}/extended/v1/address/${wallet}/balances`);
  const ft = (data.fungible_tokens ?? {}) as Record<string, { balance?: string }>;
  const key = `${tokenContract}::${assetName}`;
  return BigInt(ft[key]?.balance ?? "0");
}

async function fetchSbtcBalance(wallet: string): Promise<bigint> {
  return fetchFtBalance(wallet, SBTC_TOKEN, "sbtc-token");
}

async function fetchUsdcxBalance(wallet: string): Promise<bigint> {
  return fetchFtBalance(wallet, USDCX_TOKEN, "usdcx");
}

async function fetchNextNonce(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, unknown>>(`${HIRO_API}/extended/v1/address/${wallet}/nonces`);
  const pn = data.possible_next_nonce;
  if (pn !== undefined && pn !== null) return BigInt(Number(pn));
  const le = data.last_executed_tx_nonce;
  return le !== undefined && le !== null ? BigInt(Number(le) + 1) : 0n;
}

async function fetchZestContractReachable(): Promise<boolean> {
  try {
    const { address, name } = splitContract(ZEST_POOL);
    const res = await fetch(`${HIRO_API}/v2/contracts/interface/${address}/${name}`);
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchTxStatus(txid: string): Promise<{ status: string; success: boolean } | null> {
  try {
    const data = await fetchJson<Record<string, unknown>>(`${HIRO_API}/extended/v1/tx/${txid}`);
    const ts = String(data.tx_status ?? "pending");
    return { status: ts, success: ts === "success" };
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Wallet helpers (keystore-unlock pattern from move-liquidity)
// ═════════════════════════════════════════════════════════════════════════════

async function resolveWalletAddress(): Promise<string> {
  if (process.env.STACKS_ADDRESS) return process.env.STACKS_ADDRESS;
  if (process.env.STX_ADDRESS) return process.env.STX_ADDRESS;
  if (fs.existsSync(WALLETS_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
      const active = (j.wallets ?? [])[0];
      if (active?.stxAddress) return active.stxAddress;
      if (active?.address) return active.address;
    } catch { /* fall through */ }
  }
  throw new Error("No wallet address. Set STACKS_ADDRESS or run: npx @aibtc/mcp-server@latest --install");
}

function mcpServerInstalled(): boolean {
  try {
    // Heuristic: check common npx cache locations
    const npmDir = path.join(os.homedir(), ".npm", "_npx");
    if (!fs.existsSync(npmDir)) return false;
    const entries = fs.readdirSync(npmDir);
    return entries.some((e) => {
      const p = path.join(npmDir, e, "node_modules", "@aibtc", "mcp-server");
      return fs.existsSync(p);
    });
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Delta math — the heart of the strategy
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Compute the LP's current position in raw token units, given user bins
 * and the pool's bin-level state. For bins where user reserve fields are
 * missing, estimate the user's share from dlp_share × pool_bin_reserves.
 */
function computeLpComposition(
  userBins: UserBin[],
  poolBins: BinData[],
  tokenX: TokenMeta,
  tokenY: TokenMeta,
  activePrice: number
): DeltaReport {
  const poolBinMap = new Map(poolBins.map((b) => [b.bin_id, b]));

  let xRaw = 0n;
  let yRaw = 0n;

  for (const ub of userBins) {
    if (ub.reserve_x > 0n || ub.reserve_y > 0n) {
      xRaw += ub.reserve_x;
      yRaw += ub.reserve_y;
      continue;
    }
    const pb = poolBinMap.get(ub.bin_id);
    if (!pb || pb.liquidity <= 0n) continue;
    xRaw += (ub.liquidity * pb.reserve_x) / pb.liquidity;
    yRaw += (ub.liquidity * pb.reserve_y) / pb.liquidity;
  }

  const xDisp = rawToDisplay(xRaw, tokenX.decimals);
  const yDisp = rawToDisplay(yRaw, tokenY.decimals);

  // Position value denominated in tokenY (usually the stablecoin side).
  // If both sides volatile, we still denominate in Y but caller should
  // interpret delta w.r.t. each side independently.
  const positionValueY = xDisp * activePrice + yDisp;

  // Delta = quantity of tokenX we hold (in tokenX units). That's the
  // long exposure to the X/Y exchange rate.
  const deltaX = xDisp;
  const deltaPct = positionValueY > 0 ? (deltaX * activePrice) / positionValueY : 0;

  return {
    total_x_raw: xRaw,
    total_y_raw: yRaw,
    total_x_display: xDisp,
    total_y_display: yDisp,
    position_value_y: positionValueY,
    delta_x_display: deltaX,
    delta_pct: deltaPct,
  };
}

/**
 * Expected LP composition when opening a fresh position of `amountY_display`
 * tokenY-equivalent value, centered on the active bin with `±spreadBins`.
 *
 * In the equal-liquidity-per-bin placement (the skill's default), with the
 * active bin in the middle of the range, ~50% of value is tokenX and ~50%
 * is tokenY at t=0. Under more sophisticated distributions (bid-ask, curve),
 * this would differ; we model the simple uniform case and document it.
 */
function projectOpenComposition(
  amountYValue: number,
  activePrice: number,
  _spreadBins: number,
  tokenX: TokenMeta,
  tokenY: TokenMeta
): { x_display: number; y_display: number; x_raw: bigint; y_raw: bigint; delta_pct: number } {
  const halfValue = amountYValue / 2;
  const xDisp = halfValue / activePrice;
  const yDisp = halfValue;
  return {
    x_display: xDisp,
    y_display: yDisp,
    x_raw: displayToRaw(xDisp, tokenX.decimals),
    y_raw: displayToRaw(yDisp, tokenY.decimals),
    delta_pct: 0.5,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Hedge sizing
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Size the short hedge and the collateral it requires. Collateral is SEPARATE
 * from LP capital — the LP's tokenY side is locked in the pool and cannot
 * secure a Zest loan. Required total-capital = LP_amount + collateral_needed.
 */
function computeHedgePlan(
  lpDeltaXDisplay: number,
  tokenX: TokenMeta,
  activePrice: number,
  maxLtv: number
): HedgePlan {
  const borrowDisplay = lpDeltaXDisplay;
  const borrowValueY = borrowDisplay * activePrice;
  // Collateral = borrow_value / target_LTV. max_ltv is the ceiling; target a
  // slightly lower value for headroom (80% of max_ltv).
  const targetLtv = maxLtv * 0.8;
  const collateralNeeded = borrowValueY / targetLtv;
  const resultingLtv = borrowValueY / collateralNeeded;
  // Distance to liquidation at Zest's ~80% threshold.
  const liquidationPriceMove = resultingLtv > 0 ? 0.80 / resultingLtv - 1 : Infinity;

  return {
    borrow_token: tokenX.symbol === "sBTC" ? "sBTC" : "STX",
    borrow_amount_raw: displayToRaw(borrowDisplay, tokenX.decimals),
    borrow_amount_display: borrowDisplay,
    collateral_token: "USDCx",
    collateral_amount_raw: displayToRaw(collateralNeeded, 6),
    collateral_amount_display: collateralNeeded,
    resulting_ltv: resultingLtv,
    resulting_liquidation_distance_pct: liquidationPriceMove,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Cost model
// ═════════════════════════════════════════════════════════════════════════════

interface CostModel {
  fee_apr: number;
  borrow_apr: number;
  hedge_ratio: number;           // borrow value / total position value
  gross_apr: number;
  net_apr: number;
  breakeven_fee_apr: number;
  profitable: boolean;
}

function computeCostModel(
  poolFeeApr24h: number,
  zestBorrowApr: number,
  hedgeRatio: number,
  minNetApr: number
): CostModel {
  // Pool APR from Bitflow is reported as a 24h annualized %, treat as fraction.
  const feeApr = poolFeeApr24h / 100;
  // Zest APR likewise.
  const borrowApr = zestBorrowApr;
  const grossApr = feeApr;
  // Cost attributable to the hedge = borrow_apr × (borrow_value / position_value).
  // hedgeRatio reflects how much of position is short-hedged (~50% for vol/stable).
  const hedgeCost = borrowApr * hedgeRatio;
  const netApr = grossApr - hedgeCost;
  const breakeven = hedgeCost;
  return {
    fee_apr: feeApr,
    borrow_apr: borrowApr,
    hedge_ratio: hedgeRatio,
    gross_apr: grossApr,
    net_apr: netApr,
    breakeven_fee_apr: breakeven,
    profitable: netApr >= minNetApr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Monte Carlo — Geometric Brownian Motion P&L simulator
// ═════════════════════════════════════════════════════════════════════════════

function gaussian(): number {
  // Box-Muller transform. Adequate for Monte Carlo at 10^4 paths.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

/**
 * Delta-neutral LP P&L simulator.
 *
 * Model: the strategy earns fee_apr continuously on the LP notional, pays
 * borrow_apr × hedge_ratio continuously on the short leg, and accrues a
 * rebalancing cost proportional to realized volatility (quadratic in drift).
 * Residual delta after rebalance is ~drift_threshold * position_value, times
 * the price move, so some path-dependency remains.
 *
 * Liquidation: when cumulative price move exceeds 1/max_ltv - 1 (roughly
 * 60% for max_ltv=0.5 at Zest's 0.80 liquidation line), we count it.
 */
function monteCarloSimulate(
  amount: number,
  feeApr: number,
  borrowApr: number,
  hedgeRatio: number,
  days: number,
  volAnnual: number,
  driftAnnual: number,
  driftThreshold: number,
  maxLtv: number,
  paths: number = DEFAULT_MONTE_CARLO_PATHS
): MonteCarloResult {
  const dt = 1 / 365;                                  // daily steps
  const sigma = volAnnual * Math.sqrt(dt);
  const mu = (driftAnnual - 0.5 * volAnnual * volAnnual) * dt;
  const liqMove = 1 / maxLtv - 1;                      // price-move fraction to liquidation
  const rebalanceGasCostDaily = 0.0005;                // ~0.05% of position per day amortized (8 rebalances/day cap × ~$0.30 STX gas → scaled)

  const pnls: number[] = [];
  let liqCount = 0;

  for (let p = 0; p < paths; p++) {
    let lnPrice = 0;
    let maxMove = 0;
    let liquidated = false;

    for (let d = 0; d < days; d++) {
      lnPrice += mu + sigma * gaussian();
      const move = Math.abs(Math.exp(lnPrice) - 1);
      if (move > maxMove) maxMove = move;
      if (move >= liqMove) { liquidated = true; break; }
    }

    if (liquidated) {
      // Liquidation penalty: lose the hedge collateral + liquidation fee (~10%).
      pnls.push(-hedgeRatio * 1.1);
      liqCount++;
      continue;
    }

    // Gross fee earnings over the period.
    const grossFees = feeApr * (days / 365);
    // Borrow cost.
    const borrowCost = borrowApr * hedgeRatio * (days / 365);
    // Rebalance residual: the hedge lags price by drift_threshold on average; slippage is order(drift^2).
    const residualSlippage = driftThreshold * driftThreshold * maxMove;
    // Amortized rebalance gas/slippage.
    const gasDrag = rebalanceGasCostDaily * days;
    const netPct = grossFees - borrowCost - residualSlippage - gasDrag;
    pnls.push(netPct);
  }

  pnls.sort((a, b) => a - b);
  const mean = pnls.reduce((s, x) => s + x, 0) / pnls.length;
  const lossCount = pnls.filter((x) => x < -0.02).length;

  return {
    paths,
    days,
    vol_annual: volAnnual,
    drift_annual: driftAnnual,
    expected_pnl_pct: mean,
    p5_pnl_pct: percentile(pnls, 0.05),
    p50_pnl_pct: percentile(pnls, 0.50),
    p95_pnl_pct: percentile(pnls, 0.95),
    worst_pnl_pct: pnls[0],
    prob_loss_gt_2pct: lossCount / pnls.length,
    prob_liquidation: liqCount / pnls.length,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Pool selection + Zest rate heuristic
// ═════════════════════════════════════════════════════════════════════════════

async function resolvePool(poolId: string | undefined): Promise<PoolMeta> {
  const pools = await fetchDlmmPools();
  if (poolId) {
    const p = pools.find((x) => x.poolId === poolId);
    if (!p) throw new Error(`pool ${poolId} not found (have: ${pools.map((x) => x.poolId).join(", ")})`);
    const active = await fetchPoolActiveBin(p.poolId);
    p.activeBin = active.active_bin;
    return p;
  }
  // Default: highest 24h APR DLMM pool with TVL > $10K (avoid micro pools).
  const viable = pools.filter((p) => p.tvlUsd > 10_000 && p.apr24h > 0);
  if (viable.length === 0) throw new Error("no viable DLMM pool found (TVL>$10K, APR>0)");
  viable.sort((a, b) => b.apr24h - a.apr24h);
  const p = viable[0];
  const active = await fetchPoolActiveBin(p.poolId);
  p.activeBin = active.active_bin;
  return p;
}

/**
 * Heuristic for Zest borrow APR. In production this should read the on-chain
 * rate curve; for now, we use conservative static estimates consistent with
 * observed Zest rates on mainnet at time of writing.
 */
function estimateZestBorrowApr(asset: "sBTC" | "STX"): number {
  if (asset === "sBTC") return 0.08;                   // 8% typical sBTC borrow
  if (asset === "STX") return 0.05;                    // 5% typical STX borrow
  return 0.10;
}

// ═════════════════════════════════════════════════════════════════════════════
// Plan builder
// ═════════════════════════════════════════════════════════════════════════════

interface StrategyPlan {
  pool: {
    id: string;
    contract: string;
    pair: string;
    active_bin: number;
    bin_step: number;
    base_fee: number;
    apr_24h: number;
    tvl_usd: number;
    volume_1d_usd: number;
  };
  position: {
    base_asset: "sBTC" | "USDCx";
    amount_display: number;
    amount_value_usd: number;
    active_price: number;
    spread_bins: number;
    projected_composition: { x_display: number; y_display: number };
  };
  hedge: HedgePlan;
  cost_model: CostModel;
  monte_carlo: MonteCarloResult;
  safety: {
    max_ltv: number;
    min_net_apr: number;
    drift_threshold: number;
    breakeven_ok: boolean;
    ltv_ok: boolean;
    monte_carlo_ok: boolean;
    all_checks_passed: boolean;
  };
}

async function buildPlan(opts: {
  amountDisplay: number;
  baseAsset: "sBTC" | "USDCx";
  poolId?: string;
  spreadBins: number;
  days: number;
  volAnnual: number;
  driftAnnual: number;
  driftThreshold: number;
  maxLtv: number;
  minNetApr: number;
}): Promise<StrategyPlan> {
  const pool = await resolvePool(opts.poolId);

  // For a sBTC/USDCx pool: tokenX = sBTC (volatile), tokenY = USDCx (stable).
  // If user supplies in sBTC, half is swapped to USDCx before LPing.
  // If user supplies in USDCx, half is swapped to sBTC.
  // Net: LP receives ~50% of value in each.
  const activePrice = pool.tokenY.priceUsd > 0
    ? pool.tokenX.priceUsd / pool.tokenY.priceUsd
    : pool.tokenX.priceUsd;

  const amountValueY = opts.baseAsset === "sBTC"
    ? opts.amountDisplay * pool.tokenX.priceUsd / Math.max(pool.tokenY.priceUsd, 1e-9)
    : opts.amountDisplay;

  const composition = projectOpenComposition(
    amountValueY,
    activePrice,
    opts.spreadBins,
    pool.tokenX,
    pool.tokenY
  );

  const hedge = computeHedgePlan(
    composition.x_display,
    pool.tokenX,
    activePrice,
    opts.maxLtv
  );

  const borrowApr = estimateZestBorrowApr(hedge.borrow_token);
  const costModel = computeCostModel(pool.apr24h, borrowApr, hedge.resulting_ltv > 0 ? 0.5 : 0.5, opts.minNetApr);
  const mc = monteCarloSimulate(
    amountValueY,
    costModel.fee_apr,
    costModel.borrow_apr,
    costModel.hedge_ratio,
    opts.days,
    opts.volAnnual,
    opts.driftAnnual,
    opts.driftThreshold,
    opts.maxLtv
  );

  const breakevenOk = costModel.profitable;
  const ltvOk = hedge.resulting_ltv <= opts.maxLtv;
  const mcOk = mc.prob_liquidation < 0.02 && mc.p5_pnl_pct > -0.10;

  return {
    pool: {
      id: pool.poolId,
      contract: pool.poolContract,
      pair: `${pool.tokenX.symbol}/${pool.tokenY.symbol}`,
      active_bin: pool.activeBin,
      bin_step: pool.binStep,
      base_fee: pool.baseFee,
      apr_24h: pool.apr24h,
      tvl_usd: pool.tvlUsd,
      volume_1d_usd: pool.volumeUsd1d,
    },
    position: {
      base_asset: opts.baseAsset,
      amount_display: opts.amountDisplay,
      amount_value_usd: amountValueY * pool.tokenY.priceUsd,
      active_price: activePrice,
      spread_bins: opts.spreadBins,
      projected_composition: {
        x_display: composition.x_display,
        y_display: composition.y_display,
      },
    },
    hedge,
    cost_model: costModel,
    monte_carlo: mc,
    safety: {
      max_ltv: opts.maxLtv,
      min_net_apr: opts.minNetApr,
      drift_threshold: opts.driftThreshold,
      breakeven_ok: breakevenOk,
      ltv_ok: ltvOk,
      monte_carlo_ok: mcOk,
      all_checks_passed: breakevenOk && ltvOk && mcOk,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Executors — LP leg via direct contract call
// ═════════════════════════════════════════════════════════════════════════════

interface TxBroadcastRequest {
  contract_address: string;
  contract_name: string;
  function_name: string;
  function_args_description: string[];
  post_condition_mode: "allow" | "deny";
  fee_ustx: number;
}

/**
 * Build the add-liquidity-multi transaction payload. This skill emits the
 * MCP command descriptor; the agent harness (or `mcp-bridge` CLI) signs and
 * broadcasts using the wallet keystore. We never touch private keys here.
 */
function buildAddLiquidityPayload(
  pool: PoolMeta,
  composition: { x_raw: bigint; y_raw: bigint },
  spreadBins: number
): { mcp_tool: string; description: string; params: Record<string, unknown> } {
  const binsPerSide = spreadBins;
  const numBins = binsPerSide * 2 + 1;
  const xPerBin = composition.x_raw / BigInt(numBins);
  const yPerBin = composition.y_raw / BigInt(numBins);

  // Positions list centered on active bin ± spread.
  const positions = [];
  for (let offset = -binsPerSide; offset <= binsPerSide; offset++) {
    positions.push({
      bin_id: pool.activeBin + offset - CENTER_BIN_ID,
      x_amount: xPerBin.toString(),
      y_amount: yPerBin.toString(),
      max_x_fee: "0",
      max_y_fee: "0",
      min_dlp: "1",
    });
  }

  return {
    mcp_tool: "call_contract",
    description: `Add liquidity to ${pool.poolId} across ±${spreadBins} bins`,
    params: {
      contract_id: `${ROUTER_ADDR}.${ROUTER_NAME}`,
      function_name: "add-liquidity-multi",
      args_hint: "positions: list of tuples { bin-id, x-amount, y-amount, max-x-liquidity-fee, max-y-liquidity-fee, min-dlp, pool-trait, x-token-trait, y-token-trait }",
      positions,
      pool_contract: pool.poolContract,
      x_token_contract: pool.tokenX.contract,
      y_token_contract: pool.tokenY.contract,
      post_condition_mode: "allow",
      fee_ustx: 200_000,
    },
  };
}

function buildWithdrawPayload(
  pool: PoolMeta,
  userBins: UserBin[]
): { mcp_tool: string; description: string; params: Record<string, unknown> } {
  const activeBin = pool.activeBin;
  const positions = userBins.map((ub) => {
    // Bins above active are X-only; bins at or below active may have Y.
    // Core requires min-x-amount + min-y-amount > 0 (err u1002 otherwise).
    const isXSide = ub.bin_id >= activeBin;
    return {
      bin_id: ub.bin_id - CENTER_BIN_ID,  // convert pool uint bin ID → router signed bin ID
      amount: ub.liquidity.toString(),
      min_x_amount: isXSide ? "1" : "0",
      min_y_amount: isXSide ? "0" : "1",
    };
  });
  return {
    mcp_tool: "call_contract",
    description: `Withdraw all liquidity from ${pool.poolId}`,
    params: {
      contract_id: `${ROUTER_ADDR}.${ROUTER_NAME}`,
      function_name: "withdraw-liquidity-same-multi",
      args_hint: "positions: list of tuples { bin-id, amount, min-x-amount, min-y-amount, pool-trait }",
      positions,
      pool_contract: pool.poolContract,
      x_token_contract: pool.tokenX.contract,
      y_token_contract: pool.tokenY.contract,
      post_condition_mode: "allow",
      fee_ustx: 200_000,
    },
  };
}

function buildZestBorrowPayload(
  asset: "sBTC" | "STX",
  amountRaw: bigint
): { mcp_tool: string; description: string; params: Record<string, unknown> } {
  return {
    mcp_tool: "zest_borrow",
    description: `Borrow ${amountRaw.toString()} units of ${asset} from Zest`,
    params: {
      asset,
      amount: amountRaw.toString(),
    },
  };
}

function buildZestRepayPayload(
  asset: "sBTC" | "STX",
  amountRaw: bigint
): { mcp_tool: string; description: string; params: Record<string, unknown> } {
  return {
    mcp_tool: "zest_repay",
    description: `Repay ${amountRaw.toString()} units of ${asset} debt on Zest`,
    params: {
      asset,
      amount: amountRaw.toString(),
    },
  };
}

function buildZestSupplyPayload(
  asset: "sBTC" | "USDCx",
  amountRaw: bigint
): { mcp_tool: string; description: string; params: Record<string, unknown> } {
  return {
    mcp_tool: "zest_supply",
    description: `Supply ${amountRaw.toString()} units of ${asset} as Zest collateral`,
    params: {
      asset,
      amount: amountRaw.toString(),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Reconciliation — wait for tx then verify on-chain state
// ═════════════════════════════════════════════════════════════════════════════

async function waitForTx(txid: string): Promise<{ confirmed: boolean; status: string }> {
  for (let i = 0; i < RECONCILE_MAX_POLLS; i++) {
    const s = await fetchTxStatus(txid);
    if (s && s.status !== "pending") {
      return { confirmed: s.success, status: s.status };
    }
    await new Promise((r) => setTimeout(r, RECONCILE_POLL_MS));
  }
  return { confirmed: false, status: "timeout" };
}

// ═════════════════════════════════════════════════════════════════════════════
// Commands
// ═════════════════════════════════════════════════════════════════════════════

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  let address = "";

  try {
    address = await resolveWalletAddress();
    checks.wallet = { ok: true, detail: address };
  } catch (e) {
    checks.wallet = { ok: false, detail: (e as Error).message };
  }

  if (address) {
    try {
      const stx = await fetchStxBalance(address);
      const hasGas = stx >= BigInt(MIN_GAS_USTX);
      checks.stx_gas = { ok: hasGas, detail: `${Number(stx) / 1e6} STX (need ≥ ${MIN_GAS_USTX / 1e6})` };
    } catch (e) {
      checks.stx_gas = { ok: false, detail: (e as Error).message };
    }
    try {
      const sbtc = await fetchSbtcBalance(address);
      checks.sbtc_balance = { ok: true, detail: `${Number(sbtc) / 1e8} sBTC` };
    } catch (e) {
      checks.sbtc_balance = { ok: false, detail: (e as Error).message };
    }
    try {
      const usdcx = await fetchUsdcxBalance(address);
      checks.usdcx_balance = { ok: true, detail: `${Number(usdcx) / 1e6} USDCx` };
    } catch (e) {
      checks.usdcx_balance = { ok: false, detail: (e as Error).message };
    }
  }

  try {
    const pools = await fetchDlmmPools();
    checks.bitflow_api = { ok: pools.length > 0, detail: `${pools.length} DLMM pools` };
  } catch (e) {
    checks.bitflow_api = { ok: false, detail: (e as Error).message };
  }

  try {
    const ok = await fetchZestContractReachable();
    checks.zest_contract = { ok, detail: ok ? ZEST_POOL : "unreachable" };
  } catch (e) {
    checks.zest_contract = { ok: false, detail: (e as Error).message };
  }

  try {
    const res = await fetch(`${HIRO_API}/v2/contracts/interface/${ROUTER_ADDR}/${ROUTER_NAME}`);
    checks.dlmm_router = { ok: res.ok, detail: res.ok ? `${ROUTER_ADDR}.${ROUTER_NAME}` : `HTTP ${res.status}` };
  } catch (e) {
    checks.dlmm_router = { ok: false, detail: (e as Error).message };
  }

  checks.mcp_server = {
    ok: mcpServerInstalled(),
    detail: mcpServerInstalled() ? "@aibtc/mcp-server cached" : "run: npx @aibtc/mcp-server@latest --install",
  };

  ensureStateDir();
  checks.state_dir = { ok: fs.existsSync(STATE_DIR), detail: STATE_DIR };

  const allOk = Object.values(checks).every((c) => c.ok);
  if (allOk) {
    success("Environment ready. Try: plan --amount 100000 --pool dlmm_1", { checks, address });
  } else {
    const blockers = Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail}`);
    blocked("doctor_failed", blockers.join("; "), "Resolve blockers and re-run doctor", { checks, address });
  }
}

async function cmdPlan(opts: {
  amount: string;
  pool?: string;
  base?: string;
  spread?: string;
  days?: string;
  vol?: string;
  drift?: string;
  driftThreshold?: string;
  maxLtv?: string;
  minNetApr?: string;
}): Promise<void> {
  try {
    const amountRaw = BigInt(opts.amount);
    const baseAsset = (opts.base ?? "sBTC") as "sBTC" | "USDCx";
    const decimals = baseAsset === "sBTC" ? 8 : 6;
    const amountDisplay = rawToDisplay(amountRaw, decimals);

    const plan = await buildPlan({
      amountDisplay,
      baseAsset,
      poolId: opts.pool,
      spreadBins: Number(opts.spread ?? DEFAULT_SPREAD_BINS),
      days: Number(opts.days ?? 30),
      volAnnual: Number(opts.vol ?? 0.6),
      driftAnnual: Number(opts.drift ?? 0),
      driftThreshold: Number(opts.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD),
      maxLtv: Number(opts.maxLtv ?? DEFAULT_MAX_LTV),
      minNetApr: Number(opts.minNetApr ?? DEFAULT_MIN_NET_APR),
    });

    const action = plan.safety.all_checks_passed
      ? `Plan passes all gates. Open with: open --amount ${opts.amount} --pool ${plan.pool.id} --execute`
      : `Plan BLOCKED by safety gates: ${[
          plan.safety.breakeven_ok ? "" : "net APR < min",
          plan.safety.ltv_ok ? "" : "LTV exceeds cap",
          plan.safety.monte_carlo_ok ? "" : "MC risk too high",
        ].filter(Boolean).join(", ")}`;

    if (plan.safety.all_checks_passed) {
      success(action, { plan });
    } else {
      blocked("plan_unsafe", action, "Adjust params or pick a different pool", { plan });
    }
  } catch (e) {
    errorOut("plan_failed", (e as Error).message, "Retry with --pool specified");
  }
}

async function cmdSimulate(opts: {
  amount: string;
  feeApr: string;
  borrowApr: string;
  hedgeRatio?: string;
  days?: string;
  vol?: string;
  drift?: string;
  driftThreshold?: string;
  maxLtv?: string;
  paths?: string;
}): Promise<void> {
  try {
    const amount = Number(opts.amount);
    const feeApr = Number(opts.feeApr);
    const borrowApr = Number(opts.borrowApr);
    const hedgeRatio = Number(opts.hedgeRatio ?? 0.5);
    const days = Number(opts.days ?? 30);
    const volAnnual = Number(opts.vol ?? 0.6);
    const driftAnnual = Number(opts.drift ?? 0);
    const driftThreshold = Number(opts.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD);
    const maxLtv = Number(opts.maxLtv ?? DEFAULT_MAX_LTV);
    const paths = Number(opts.paths ?? DEFAULT_MONTE_CARLO_PATHS);

    const mc = monteCarloSimulate(amount, feeApr, borrowApr, hedgeRatio, days, volAnnual, driftAnnual, driftThreshold, maxLtv, paths);
    const cost = computeCostModel(feeApr * 100, borrowApr, hedgeRatio, DEFAULT_MIN_NET_APR);

    success(`Simulation complete: ${paths} paths × ${days} days @ vol=${volAnnual}`, {
      monte_carlo: mc,
      cost_model: cost,
    });
  } catch (e) {
    errorOut("simulate_failed", (e as Error).message, "Check numeric args");
  }
}

async function cmdStatus(opts: { pool?: string }): Promise<void> {
  try {
    const address = await resolveWalletAddress();
    const state = readState();
    const poolId = opts.pool ?? state?.pool_id;
    if (!poolId) {
      blocked("no_active_strategy", "No state file found and no --pool provided", "Pass --pool or run open first", {});
      return;
    }
    const pools = await fetchDlmmPools();
    const pool = pools.find((p) => p.poolId === poolId);
    if (!pool) throw new Error(`pool ${poolId} not found`);
    const bins = await fetchPoolBins(poolId);
    pool.activeBin = bins.active_bin;

    const userBins = await fetchUserLp(poolId, address);
    const activePrice = pool.tokenY.priceUsd > 0 ? pool.tokenX.priceUsd / pool.tokenY.priceUsd : pool.tokenX.priceUsd;
    const lp = computeLpComposition(userBins, bins.bins, pool.tokenX, pool.tokenY, activePrice);

    // Drift = how far active bin has moved from LP center
    const binIds = userBins.map((u) => u.bin_id).sort((a, b) => a - b);
    const center = binIds.length > 0 ? Math.round((binIds[0] + binIds[binIds.length - 1]) / 2) : pool.activeBin;
    const drift = pool.activeBin - center;
    const inRange = binIds.length > 0 && pool.activeBin >= binIds[0] && pool.activeBin <= binIds[binIds.length - 1];

    // Note: on-chain Zest position requires MCP zest_get_position or read-only contract call.
    // We emit a descriptor so the agent can fill it.
    const zestDescriptor = {
      mcp_tool: "zest_get_position",
      params: { address, asset: "sBTC" },
    };

    success(`Position in ${pool.tokenX.symbol}/${pool.tokenY.symbol}`, {
      address,
      pool: { id: pool.poolId, active_bin: pool.activeBin, active_price: activePrice },
      lp: {
        bin_count: userBins.length,
        bin_range: binIds.length > 0 ? [binIds[0], binIds[binIds.length - 1]] : [],
        drift_from_center: drift,
        in_range: inRange,
        composition: lp,
      },
      zest_position_descriptor: zestDescriptor,
      state,
      recommended_action: userBins.length === 0
        ? "no LP position on this pool — run open first"
        : !inRange
        ? "position out of range — consider harvest or rebalance"
        : Math.abs(drift) > 3
        ? "drift > 3 bins — hedge may need rebalancing"
        : "healthy",
    });
  } catch (e) {
    errorOut("status_failed", (e as Error).message, "Run doctor; pass --pool if no state");
  }
}

async function cmdOpen(opts: {
  amount: string;
  pool?: string;
  base?: string;
  spread?: string;
  execute?: boolean;
  maxPosition?: string;
  minNetApr?: string;
}): Promise<void> {
  try {
    const amountRaw = BigInt(opts.amount);
    const baseAsset = (opts.base ?? "sBTC") as "sBTC" | "USDCx";
    const decimals = baseAsset === "sBTC" ? 8 : 6;
    const amountDisplay = rawToDisplay(amountRaw, decimals);
    const maxPos = BigInt(opts.maxPosition ?? DEFAULT_MAX_POSITION_SATS);

    if (amountRaw > maxPos) {
      blocked("exceeds_max_position", `${amountRaw} > ${maxPos}`, `Use --max-position ${amountRaw} to override`, {});
      return;
    }
    if (amountRaw <= 0n) {
      errorOut("invalid_amount", "amount must be > 0", "Pass --amount <positive raw units>");
      return;
    }

    const address = await resolveWalletAddress();
    const stx = await fetchStxBalance(address);
    if (stx < BigInt(MIN_GAS_USTX)) {
      blocked("insufficient_gas", `${stx} < ${MIN_GAS_USTX}`, "Acquire STX for gas", { stx_balance: Number(stx) });
      return;
    }
    const bal = baseAsset === "sBTC" ? await fetchSbtcBalance(address) : await fetchUsdcxBalance(address);
    if (bal < amountRaw) {
      blocked("insufficient_balance", `have ${bal}, need ${amountRaw}`, "Fund wallet or reduce amount", { balance: bal.toString() });
      return;
    }

    const plan = await buildPlan({
      amountDisplay,
      baseAsset,
      poolId: opts.pool,
      spreadBins: Number(opts.spread ?? DEFAULT_SPREAD_BINS),
      days: 30,
      volAnnual: 0.6,
      driftAnnual: 0,
      driftThreshold: DEFAULT_DRIFT_THRESHOLD,
      maxLtv: DEFAULT_MAX_LTV,
      minNetApr: Number(opts.minNetApr ?? DEFAULT_MIN_NET_APR),
    });

    if (!plan.safety.all_checks_passed) {
      blocked("plan_unsafe", "Safety gates failed; refusing to open", "Review plan output", { plan });
      return;
    }

    const pool = await resolvePool(plan.pool.id);
    const composition = projectOpenComposition(
      plan.position.amount_value_usd / Math.max(pool.tokenY.priceUsd, 1e-9),
      plan.position.active_price,
      plan.position.spread_bins,
      pool.tokenX,
      pool.tokenY
    );

    const payload = buildAddLiquidityPayload(pool, { x_raw: composition.x_raw, y_raw: composition.y_raw }, plan.position.spread_bins);

    if (!opts.execute) {
      success("DRY RUN. Re-run with --execute to broadcast.", {
        plan,
        mcp_payload: payload,
        next_steps: [
          "1. bitflow-neutral open --execute (this tx)",
          "2. Wait for tx confirmation",
          "3. bitflow-neutral hedge --execute (opens Zest short)",
          "4. bitflow-neutral status (verify net delta < 1%)",
        ],
      });
      return;
    }

    // Execute: emit the MCP command. The agent harness signs and broadcasts.
    ensureStateDir();
    const newState: StrategyState = {
      pool_id: pool.poolId,
      opened_at: new Date().toISOString(),
      initial_amount_sats: Number(amountRaw),
      target_spread_bins: plan.position.spread_bins,
      target_drift_threshold: DEFAULT_DRIFT_THRESHOLD,
      rebalance_count: 0,
      harvest_count: 0,
    };
    writeState(newState);

    success("Execute add-liquidity transaction via MCP", {
      plan_summary: {
        pool: plan.pool.pair,
        amount_sats: Number(amountRaw),
        bins: plan.position.spread_bins * 2 + 1,
        expected_net_apr: plan.cost_model.net_apr,
        monte_carlo_p5: plan.monte_carlo.p5_pnl_pct,
      },
      mcp_payload: payload,
      state_written: STATE_FILE,
      next_step: "After tx confirms, run: hedge --execute",
    });
  } catch (e) {
    errorOut("open_failed", (e as Error).message, "Check doctor output");
  }
}

async function cmdHedge(opts: { execute?: boolean }): Promise<void> {
  try {
    const address = await resolveWalletAddress();
    const state = readState();
    if (!state) {
      blocked("no_state", "No active strategy", "Run open --execute first", {});
      return;
    }

    const pool = await resolvePool(state.pool_id);
    const bins = await fetchPoolBins(pool.poolId);
    pool.activeBin = bins.active_bin;

    const userBins = await fetchUserLp(pool.poolId, address);
    if (userBins.length === 0) {
      blocked("no_lp_position", "No LP found on-chain; open may not have confirmed yet", "Wait 2 min and retry", { pool: pool.poolId });
      return;
    }

    const activePrice = pool.tokenY.priceUsd > 0 ? pool.tokenX.priceUsd / pool.tokenY.priceUsd : pool.tokenX.priceUsd;
    const lp = computeLpComposition(userBins, bins.bins, pool.tokenX, pool.tokenY, activePrice);

    const usdcxBal = await fetchUsdcxBalance(address);
    const usdcxBalDisp = rawToDisplay(usdcxBal, 6);

    const hedge = computeHedgePlan(lp.total_x_display, pool.tokenX, activePrice, DEFAULT_MAX_LTV);
    if (usdcxBalDisp < hedge.collateral_amount_display) {
      blocked(
        "insufficient_collateral",
        `Need ${hedge.collateral_amount_display.toFixed(2)} USDCx as Zest collateral, have ${usdcxBalDisp.toFixed(2)}`,
        `Fund ${(hedge.collateral_amount_display - usdcxBalDisp).toFixed(2)} USDCx or reduce LP size`,
        { hedge, usdcx_balance: usdcxBalDisp }
      );
      return;
    }

    // Leg 2a: supply USDCx as Zest collateral.
    const supplyPayload = buildZestSupplyPayload("USDCx", hedge.collateral_amount_raw);
    // Leg 2b: borrow sBTC equal to LP's long side.
    const borrowPayload = buildZestBorrowPayload(hedge.borrow_token, hedge.borrow_amount_raw);

    if (!opts.execute) {
      success("DRY RUN. Re-run with --execute to broadcast both Zest transactions.", {
        hedge,
        mcp_payloads: [supplyPayload, borrowPayload],
        next_steps: [
          "1. Execute zest_supply (collateral)",
          "2. Execute zest_enable_collateral (if not already)",
          "3. Execute zest_borrow",
          "4. Run status to verify net delta",
        ],
      });
      return;
    }

    success("Execute Zest supply + borrow via MCP", {
      hedge,
      mcp_payloads: [
        supplyPayload,
        { mcp_tool: "zest_enable_collateral", description: "Enable supplied USDCx as collateral", params: { asset: "USDCx" } },
        borrowPayload,
      ],
      next_step: "After both txs confirm, run: status",
    });
  } catch (e) {
    errorOut("hedge_failed", (e as Error).message, "Check doctor + open state");
  }
}

async function cmdRebalance(opts: { driftThreshold?: string; execute?: boolean }): Promise<void> {
  try {
    const address = await resolveWalletAddress();
    const state = readState();
    if (!state) {
      blocked("no_state", "No active strategy", "Run open first", {});
      return;
    }
    const pool = await resolvePool(state.pool_id);
    const bins = await fetchPoolBins(pool.poolId);
    pool.activeBin = bins.active_bin;

    const userBins = await fetchUserLp(pool.poolId, address);
    const activePrice = pool.tokenY.priceUsd > 0 ? pool.tokenX.priceUsd / pool.tokenY.priceUsd : pool.tokenX.priceUsd;
    const lp = computeLpComposition(userBins, bins.bins, pool.tokenX, pool.tokenY, activePrice);

    const threshold = Number(opts.driftThreshold ?? state.target_drift_threshold ?? DEFAULT_DRIFT_THRESHOLD);
    const currentDelta = lp.delta_pct - 0.5;
    const absDrift = Math.abs(currentDelta);

    if (absDrift < threshold) {
      success(`Drift ${(absDrift * 100).toFixed(2)}% < threshold ${(threshold * 100).toFixed(2)}%. No action.`, {
        delta_pct: lp.delta_pct,
        drift_vs_neutral: currentDelta,
        threshold,
      });
      return;
    }

    // Compute adjustment: borrow more X (if drift positive = too long X) or repay partial.
    const adjustmentX = currentDelta * lp.position_value_y / activePrice;
    const action = currentDelta > 0 ? "borrow_more" : "repay_partial";
    const adjustmentRaw = displayToRaw(Math.abs(adjustmentX), pool.tokenX.decimals);

    const payload = action === "borrow_more"
      ? buildZestBorrowPayload(pool.tokenX.symbol === "sBTC" ? "sBTC" : "STX", adjustmentRaw)
      : buildZestRepayPayload(pool.tokenX.symbol === "sBTC" ? "sBTC" : "STX", adjustmentRaw);

    if (!opts.execute) {
      success("DRY RUN. Re-run with --execute.", {
        rebalance: { action, amount_raw: adjustmentRaw.toString(), amount_display: Math.abs(adjustmentX) },
        mcp_payload: payload,
      });
      return;
    }

    const updatedState: StrategyState = {
      ...state,
      rebalance_count: state.rebalance_count + 1,
      last_rebalance_at: new Date().toISOString(),
    };
    writeState(updatedState);

    success(`Rebalance ${action} queued`, { mcp_payload: payload, state: updatedState });
  } catch (e) {
    errorOut("rebalance_failed", (e as Error).message, "Check status first");
  }
}

async function cmdHarvest(opts: { execute?: boolean }): Promise<void> {
  try {
    const address = await resolveWalletAddress();
    const state = readState();
    if (!state) {
      blocked("no_state", "No active strategy", "Run open first", {});
      return;
    }
    const pool = await resolvePool(state.pool_id);
    const bins = await fetchPoolBins(pool.poolId);
    pool.activeBin = bins.active_bin;
    const userBins = await fetchUserLp(pool.poolId, address);

    if (userBins.length === 0) {
      blocked("no_lp_position", "Nothing to harvest", "Run open first", {});
      return;
    }

    // Harvest strategy: withdraw all bins → re-add at active bin (captures fees as balance delta).
    const withdrawPayload = buildWithdrawPayload(pool, userBins);

    if (!opts.execute) {
      success("DRY RUN. Re-run with --execute.", { withdraw_payload: withdrawPayload, note: "After withdraw, re-open with current balances" });
      return;
    }

    const updatedState: StrategyState = {
      ...state,
      harvest_count: state.harvest_count + 1,
    };
    writeState(updatedState);

    success("Harvest: withdraw → re-open flow", {
      mcp_payloads: [withdrawPayload],
      next_step: "After withdraw confirms, run: open --amount <current_balance> --execute",
      state: updatedState,
    });
  } catch (e) {
    errorOut("harvest_failed", (e as Error).message, "Check status first");
  }
}

async function cmdUnwind(opts: { execute?: boolean }): Promise<void> {
  try {
    const address = await resolveWalletAddress();
    const state = readState();
    if (!state) {
      blocked("no_state", "No active strategy", "Nothing to unwind", {});
      return;
    }
    const pool = await resolvePool(state.pool_id);
    const bins = await fetchPoolBins(pool.poolId);
    pool.activeBin = bins.active_bin;
    const userBins = await fetchUserLp(pool.poolId, address);

    const payloads: unknown[] = [];

    // Step 1: repay Zest debt in full. Amount read from zest_get_position via MCP.
    payloads.push({
      mcp_tool: "zest_get_position",
      description: "Read current Zest debt to repay in full",
      params: { address, asset: "sBTC" },
    });
    payloads.push({
      mcp_tool: "zest_repay",
      description: "Repay all sBTC debt (use --amount from previous step)",
      params: { asset: "sBTC", amount: "MAX" },
    });

    // Step 2: withdraw all HODLMM liquidity.
    if (userBins.length > 0) {
      payloads.push(buildWithdrawPayload(pool, userBins));
    }

    // Step 3: withdraw Zest collateral.
    payloads.push({
      mcp_tool: "zest_withdraw",
      description: "Withdraw all USDCx collateral from Zest",
      params: { asset: "USDCx", amount: "MAX" },
    });

    if (!opts.execute) {
      success("DRY RUN. Re-run with --execute to broadcast unwind sequence.", { unwind_sequence: payloads });
      return;
    }

    clearState();
    success("Unwind sequence queued. Execute in order.", {
      unwind_sequence: payloads,
      state_cleared: true,
      warning: "Execute payloads sequentially; nonces must be strict. Verify each tx before next.",
    });
  } catch (e) {
    errorOut("unwind_failed", (e as Error).message, "Manual intervention may be required");
  }
}

async function cmdMonitor(): Promise<void> {
  try {
    const address = await resolveWalletAddress();
    const state = readState();
    if (!state) {
      success("No active strategy. Idle.", { address, state: null });
      return;
    }
    const pool = await resolvePool(state.pool_id);
    const bins = await fetchPoolBins(pool.poolId);
    pool.activeBin = bins.active_bin;
    const userBins = await fetchUserLp(pool.poolId, address);
    const activePrice = pool.tokenY.priceUsd > 0 ? pool.tokenX.priceUsd / pool.tokenY.priceUsd : pool.tokenX.priceUsd;
    const lp = computeLpComposition(userBins, bins.bins, pool.tokenX, pool.tokenY, activePrice);

    const binIds = userBins.map((u) => u.bin_id).sort((a, b) => a - b);
    const inRange = binIds.length > 0 && pool.activeBin >= binIds[0] && pool.activeBin <= binIds[binIds.length - 1];
    const absDrift = Math.abs(lp.delta_pct - 0.5);

    let recommended = "hold";
    let reason = "position within tolerances";
    if (!inRange) { recommended = "harvest"; reason = "position out of range — fees zero"; }
    else if (absDrift > state.target_drift_threshold) { recommended = "rebalance"; reason = `delta drift ${(absDrift * 100).toFixed(2)}% > ${(state.target_drift_threshold * 100).toFixed(2)}%`; }
    else if (pool.apr24h < 5) { recommended = "consider_unwind"; reason = `pool APR24h dropped to ${pool.apr24h}%`; }

    success(`Monitor tick: ${recommended} — ${reason}`, {
      address,
      pool: { id: pool.poolId, active_bin: pool.activeBin, apr_24h: pool.apr24h },
      lp: {
        bin_count: userBins.length,
        in_range: inRange,
        delta_pct: lp.delta_pct,
        drift_vs_neutral: lp.delta_pct - 0.5,
      },
      state,
      recommended_action: recommended,
      reason,
    });
  } catch (e) {
    errorOut("monitor_failed", (e as Error).message, "Run doctor");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════

const program = new Command();
program.name("bitflow-neutral").description("Delta-neutral HODLMM LP strategy");

program.command("doctor").description("Check env + wallet + contracts").action(cmdDoctor);

program
  .command("plan")
  .description("Analyze a prospective delta-neutral position (read-only)")
  .requiredOption("--amount <raw>", "Position size in base-asset raw units (sBTC sats or USDCx micro-units)")
  .option("--pool <id>", "DLMM pool id; default = highest-APR viable pool")
  .option("--base <asset>", "Base asset: sBTC or USDCx (default sBTC)", "sBTC")
  .option("--spread <bins>", "Bins per side around active (default 5)")
  .option("--days <n>", "Monte Carlo horizon in days (default 30)")
  .option("--vol <frac>", "Annualized vol fraction (default 0.6)")
  .option("--drift <frac>", "Annualized drift (default 0)")
  .option("--drift-threshold <frac>", "Rebalance drift threshold (default 0.05)")
  .option("--max-ltv <frac>", "Max Zest LTV (default 0.50)")
  .option("--min-net-apr <frac>", "Min net APR to proceed (default 0.02)")
  .action(cmdPlan);

program
  .command("simulate")
  .description("Monte Carlo P&L; no network, no wallet")
  .requiredOption("--amount <n>", "Position value (display units)")
  .requiredOption("--fee-apr <frac>", "HODLMM fee APR as fraction (e.g., 2.5 for 250%)")
  .requiredOption("--borrow-apr <frac>", "Zest borrow APR as fraction (e.g., 0.08)")
  .option("--hedge-ratio <frac>", "Fraction of position short-hedged (default 0.5)")
  .option("--days <n>", "Horizon in days (default 30)")
  .option("--vol <frac>", "Annualized vol (default 0.6)")
  .option("--drift <frac>", "Annualized drift (default 0)")
  .option("--drift-threshold <frac>", "Rebalance threshold (default 0.05)")
  .option("--max-ltv <frac>", "Max LTV (default 0.5)")
  .option("--paths <n>", "Monte Carlo path count (default 10000)")
  .action(cmdSimulate);

program
  .command("status")
  .description("Live position X-ray")
  .option("--pool <id>", "Override pool id")
  .action(cmdStatus);

program
  .command("open")
  .description("Leg 1: add HODLMM liquidity around active bin")
  .requiredOption("--amount <raw>", "Amount in base-asset raw units")
  .option("--pool <id>", "DLMM pool id")
  .option("--base <asset>", "Base asset (default sBTC)", "sBTC")
  .option("--spread <bins>", "Bins per side (default 5)")
  .option("--max-position <raw>", "Override hardcoded max")
  .option("--min-net-apr <frac>", "Min net APR to proceed")
  .option("--execute", "Actually broadcast (default dry-run)")
  .action(cmdOpen);

program
  .command("hedge")
  .description("Leg 2: open matching Zest short")
  .option("--execute", "Actually broadcast (default dry-run)")
  .action(cmdHedge);

program
  .command("rebalance")
  .description("Adjust hedge to re-flatten net delta after drift")
  .option("--drift-threshold <frac>", "Override threshold")
  .option("--execute", "Actually broadcast")
  .action(cmdRebalance);

program
  .command("harvest")
  .description("Withdraw + re-add at active bin to realize fees")
  .option("--execute", "Actually broadcast")
  .action(cmdHarvest);

program
  .command("unwind")
  .description("Full teardown: repay Zest + withdraw LP + withdraw collateral")
  .option("--execute", "Actually broadcast sequence")
  .action(cmdUnwind);

program.command("monitor").description("Single JSON snapshot with recommended action").action(cmdMonitor);

program
  .command("install-packs")
  .description("Report required runtime dependencies")
  .action(() => {
    const deps = ["commander"];
    const missing: string[] = [];
    for (const d of deps) {
      try { require.resolve(d); } catch { missing.push(d); }
    }
    if (missing.length === 0) {
      success("All deps installed", { deps });
    } else {
      blocked("missing_deps", `missing: ${missing.join(", ")}`, `bun add ${missing.join(" ")}`, { missing });
    }
  });

program.parseAsync(process.argv).catch((e) => {
  errorOut("unhandled", (e as Error).message, "Check CLI args; run doctor");
  process.exit(1);
});
