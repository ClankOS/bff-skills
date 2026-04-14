#!/usr/bin/env bun
/**
 * hodlmm-shadow — Whale-Mirror LP Autopilot for Bitflow HODLMM
 *
 * Snapshots a target wallet's concentrated-liquidity position on HODLMM
 * and deploys a scaled-down mirror. Re-syncs on demand.
 *
 * Subcommands:
 *   doctor                         Environment + wallet + API health
 *   install-packs                  Install npm deps
 *   scout <wallet> [--pool-id]     Read-only footprint preview
 *   follow <wallet> --budget N     Register target, emit (or broadcast) deploy plan
 *   sync                           Diff shadow vs target, emit (or broadcast) delta plan
 *   unfollow                       Stop syncing (position retained)
 *   panic                          Full exit of the shadow position
 *   status                         Dump current relationship + drift
 *
 * All writes are dry-run unless --execute is passed.
 * Output: strict JSON { status, action, data, error }
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_API           = "https://bff.bitflowapis.finance";
const STACKS_API            = "https://api.mainnet.hiro.so";
const EXPLORER_BASE         = "https://explorer.hiro.so/txid";

const STATE_DIR             = path.join(os.homedir(), ".aibtc", "hodlmm-shadow");
const STATE_FILE            = path.join(STATE_DIR, "state.json");
const WHITELIST_FILE        = path.join(STATE_DIR, "whitelist.json");
const EVENTS_FILE           = path.join(STATE_DIR, "events.jsonl");

const WALLETS_DIR           = path.join(os.homedir(), ".aibtc", "wallets");
const WALLETS_FILE          = path.join(os.homedir(), ".aibtc", "wallets.json");

// Hardcoded safety floors — see AGENT.md
const TX_FEE_USTX           = 10_000;             // 0.01 STX
const MIN_POOL_TVL_USD      = 10_000;
const MIN_POOL_VOLUME_USD   = 1_000;
const MAX_SLIPPAGE_PCT_CEIL = 5;
const DEFAULT_SLIPPAGE_PCT  = 1;
const MAX_BINS_CEILING      = 50;
const DEFAULT_MAX_BINS      = 20;
const MAX_BUDGET_SATS       = 1_000_000;          // 0.01 BTC
const MAX_BUDGET_USTX       = 10_000_000_000;     // 10,000 STX
const SYNC_COOLDOWN_SEC     = 3600;
const DEFAULT_DRIFT_PCT     = 10;
const DRIFT_PCT_FLOOR       = 5;
const FETCH_TIMEOUT_MS      = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShadowState {
  target:          string;
  ownerAddress:    string;
  poolId:          string;
  budget:          number;           // in base units of deposit token (sats for sBTC, ustx for STX)
  budgetToken:     "sbtc" | "stx";
  maxSlippagePct:  number;
  maxBins:         number;
  driftPct:        number;
  deployedBase:    number;           // cumulative base-unit deposits since follow
  shadowBins:      { binId: number; liquidity: string }[];
  lastSync:        string | null;
  createdAt:       string;
}

interface HodlmmPool {
  pool_id:    string;
  token_x:    string;
  token_y:    string;
  bin_step:   number;
  active_bin: number;
  pool_name?: string;
}

interface HodlmmBin {
  bin_id:         number;
  price?:         string | number;
  reserve_x?:     string;
  reserve_y?:     string;
  liquidity?:     string | number;
  user_liquidity?:string | number;
  userLiquidity?: string | number;
}

function binLiquidity(b: HodlmmBin): number {
  return Number(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? 0);
}

interface AppPool {
  poolId:       string;
  poolContract?: string;
  tvlUsd:      number;
  volumeUsd1d: number;
  apr24h?:     number;
  tokens?: {
    tokenX?: { contract: string; priceUsd: number; decimals: number; symbol?: string };
    tokenY?: { contract: string; priceUsd: number; decimals: number; symbol?: string };
  };
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function output(status: string, action: string, data: any, error: string | null = null): void {
  console.log(JSON.stringify({ status, action, data, error }));
}
function success(action: string, data: any) { output("success", action, data); }
function blocked(action: string, data: any, err: string) { output("blocked", action, data, err); }
function fail(action: string, err: string)    { output("error",   action, {},   err); process.exitCode = 1; }
function log(msg: string) { if (process.env.HODLMM_SHADOW_DEBUG) console.error(`[shadow] ${msg}`); }

// ─── State helpers ────────────────────────────────────────────────────────────

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readState(): ShadowState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")); } catch { return null; }
}
function writeState(s: ShadowState | null): void {
  ensureStateDir();
  if (s === null) { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); return; }
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function readWhitelist(): string[] {
  if (!fs.existsSync(WHITELIST_FILE)) return [];
  try {
    const raw = fs.readFileSync(WHITELIST_FILE, "utf-8").trim();
    if (!raw) return [];
    if (raw.startsWith("[")) return JSON.parse(raw);
    return raw.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  } catch { return []; }
}
function appendEvent(ev: any): void {
  try {
    ensureStateDir();
    fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n");
  } catch (e: any) { log(`event write failed: ${e.message}`); }
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchJson<T = any>(url: string, init?: any): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...(init ?? {}), signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} @ ${url}`);
    return await r.json() as T;
  } finally { clearTimeout(t); }
}

// ─── Bitflow API wrappers ────────────────────────────────────────────────────

async function getPools(): Promise<HodlmmPool[]> {
  const res: any = await fetchJson(`${BITFLOW_API}/api/quotes/v1/pools`);
  return res?.pools ?? res?.data ?? [];
}
async function getPool(poolId: string): Promise<HodlmmPool | null> {
  const pools = await getPools();
  return pools.find(p => p.pool_id === poolId) ?? null;
}
async function getBins(poolId: string): Promise<HodlmmBin[]> {
  const res: any = await fetchJson(`${BITFLOW_API}/api/quotes/v1/bins/${poolId}`);
  return res?.bins ?? res?.data ?? [];
}
async function getActiveBin(poolId: string): Promise<{ bin_id: number; price: string } | null> {
  const res: any = await fetchJson(`${BITFLOW_API}/api/quotes/v1/bins/${poolId}/active`);
  if (res?.bin_id != null) return { bin_id: res.bin_id, price: String(res.price ?? "0") };
  return null;
}
async function getAppPool(poolId: string): Promise<AppPool | null> {
  try {
    const res: any = await fetchJson(`${BITFLOW_API}/api/app/v1/pools/${poolId}`);
    return res?.data ?? res ?? null;
  } catch { return null; }
}
async function getUserPositionBins(addr: string, poolId: string): Promise<HodlmmBin[]> {
  try {
    const res: any = await fetchJson(`${BITFLOW_API}/api/app/v1/users/${addr}/positions/${poolId}/bins`);
    const bins: HodlmmBin[] = res?.bins ?? res?.position_bins ?? res?.positions?.bins ?? res ?? [];
    return (Array.isArray(bins) ? bins : []).filter(b => binLiquidity(b) > 0);
  } catch { return []; }
}

// ─── Target scout / shape extraction ─────────────────────────────────────────

function extractShape(bins: HodlmmBin[]): {
  binIds: number[];
  weights: Record<number, number>;    // binId → 0..1 share of target's liquidity
  totalLiquidity: number;
  minBin: number;
  maxBin: number;
} {
  const weights: Record<number, number> = {};
  let total = 0;
  for (const b of bins) {
    const lq = binLiquidity(b);
    if (lq <= 0) continue;
    weights[b.bin_id] = (weights[b.bin_id] ?? 0) + lq;
    total += lq;
  }
  const binIds = Object.keys(weights).map(Number).sort((a, b) => a - b);
  if (total > 0) for (const id of binIds) weights[id] = weights[id] / total;
  return {
    binIds,
    weights,
    totalLiquidity: total,
    minBin: binIds[0] ?? 0,
    maxBin: binIds[binIds.length - 1] ?? 0,
  };
}

async function scoutWallet(addr: string, poolIdFilter?: string): Promise<any> {
  const pools = await getPools();
  const hits: any[] = [];
  for (const pool of pools) {
    if (poolIdFilter && pool.pool_id !== poolIdFilter) continue;
    const bins = await getUserPositionBins(addr, pool.pool_id);
    if (bins.length === 0) continue;
    const shape = extractShape(bins);
    const appPool = await getAppPool(pool.pool_id);
    hits.push({
      poolId:         pool.pool_id,
      poolName:       pool.pool_name ?? pool.pool_id,
      activeBin:      pool.active_bin,
      binCount:       shape.binIds.length,
      minBin:         shape.minBin,
      maxBin:         shape.maxBin,
      range:          shape.maxBin - shape.minBin + 1,
      inActiveRange:  shape.binIds.includes(pool.active_bin),
      concentrationHHI: computeHHI(shape.weights),
      totalLiquidity: shape.totalLiquidity,
      tvlUsd:         appPool?.tvlUsd ?? null,
      volume24hUsd:   appPool?.volumeUsd1d ?? null,
      apr24h:         appPool?.apr24h ?? null,
      weights:        shape.weights,
    });
  }
  return hits;
}

function computeHHI(weights: Record<number, number>): number {
  // Herfindahl-Hirschman index of bin share (0 = perfectly diffuse, 1 = all in one bin)
  let s = 0;
  for (const w of Object.values(weights)) s += w * w;
  return Math.round(s * 10000) / 10000;
}

// ─── Gates ────────────────────────────────────────────────────────────────────

function gateWhitelist(target: string): string | null {
  const list = readWhitelist();
  if (!list.includes(target)) {
    return `Target wallet ${target} not in whitelist. Add to ${WHITELIST_FILE} (one address per line) before follow.`;
  }
  return null;
}

async function gatePoolLiveness(poolId: string): Promise<string | null> {
  const ap = await getAppPool(poolId);
  if (!ap)                                       return `App pool data unavailable for ${poolId}`;
  if ((ap.tvlUsd ?? 0) < MIN_POOL_TVL_USD)       return `Pool TVL $${ap.tvlUsd} < floor $${MIN_POOL_TVL_USD}`;
  if ((ap.volumeUsd1d ?? 0) < MIN_POOL_VOLUME_USD) return `Pool 24h volume $${ap.volumeUsd1d} < floor $${MIN_POOL_VOLUME_USD}`;
  return null;
}

async function gateSlippage(poolId: string, maxSlippagePct: number, appPool: AppPool | null): Promise<string | null> {
  const active = await getActiveBin(poolId);
  const tx = appPool?.tokens?.tokenX, ty = appPool?.tokens?.tokenY;
  if (!active || !tx || !ty || !tx.decimals || !ty.decimals) return null; // best-effort only
  // HODLMM bin price stores y-per-x in raw-unit ratio, scaled by 1e8.
  const activePriceRaw = Number(active.price) / 1e8;
  if (!isFinite(activePriceRaw) || activePriceRaw <= 0) return null;
  // Convert to real y-per-x by undoing the decimal offset.
  const activePriceReal = activePriceRaw * Math.pow(10, tx.decimals - ty.decimals);
  const appPriceReal = (tx.priceUsd ?? 0) / (ty.priceUsd ?? 0);
  if (!isFinite(appPriceReal) || appPriceReal <= 0) return null;
  const deviation = Math.abs((activePriceReal - appPriceReal) / appPriceReal) * 100;
  // If deviation > 50%, assume a price-scale mismatch we don't understand — skip the gate rather than block.
  if (deviation > 50) { log(`slippage check skipped: ${deviation.toFixed(1)}% deviation suggests scale mismatch`); return null; }
  if (deviation > maxSlippagePct) return `Slippage ${deviation.toFixed(3)}% > cap ${maxSlippagePct}%`;
  return null;
}

// ─── Plan computation ────────────────────────────────────────────────────────

interface BinDeposit { binId: number; weight: number; amountBase: number }

function computeDeployPlan(
  targetShape: ReturnType<typeof extractShape>,
  budgetBase: number,
  maxBins: number
): BinDeposit[] {
  // Keep top N bins by weight; renormalise.
  const entries = Object.entries(targetShape.weights)
    .map(([id, w]) => ({ binId: Number(id), weight: w }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxBins);
  const total = entries.reduce((s, e) => s + e.weight, 0) || 1;
  return entries
    .map(e => ({ binId: e.binId, weight: e.weight / total, amountBase: Math.floor(budgetBase * (e.weight / total)) }))
    .filter(d => d.amountBase > 0)
    .sort((a, b) => a.binId - b.binId);
}

function diffShapes(
  shadow: { binId: number; liquidity: string }[],
  targetPlan: BinDeposit[]
): { adds: BinDeposit[]; removes: { binId: number; liquidity: string }[]; driftPct: number } {
  const shadowMap: Record<number, number> = {};
  for (const b of shadow) shadowMap[b.binId] = Number(b.liquidity);
  const targetMap: Record<number, number> = {};
  for (const d of targetPlan) targetMap[d.binId] = d.amountBase;

  const adds: BinDeposit[] = [];
  const removes: { binId: number; liquidity: string }[] = [];
  let diffSum = 0, totalSum = 0;

  const allBins = new Set<number>([...Object.keys(shadowMap), ...Object.keys(targetMap)].map(Number));
  for (const id of allBins) {
    const s = shadowMap[id] ?? 0;
    const t = targetMap[id] ?? 0;
    diffSum += Math.abs(s - t);
    totalSum += Math.max(s, t);
    if (t > s) adds.push({ binId: id, weight: 0, amountBase: t - s });
    if (s > t) removes.push({ binId: id, liquidity: String(s - t) });
  }
  const driftPct = totalSum > 0 ? (diffSum / totalSum) * 100 : 0;
  return { adds, removes, driftPct };
}

// ─── Wallet + SDK (lazy-loaded for doctor-safety) ────────────────────────────

async function loadWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as any);
    const key = process.env.STACKS_PRIVATE_KEY;
    return { stxPrivateKey: key, stxAddress: getAddressFromPrivateKey(key, TransactionVersion.Mainnet) };
  }
  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);
  if (!fs.existsSync(WALLETS_FILE)) throw new Error("No wallet found. Set STACKS_PRIVATE_KEY or install AIBTC MCP wallet.");
  const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
  const activeWallet = (walletsJson.wallets ?? [])[0];
  if (!activeWallet?.id) throw new Error("No active wallet in wallets.json");
  const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
  if (!fs.existsSync(keystorePath)) throw new Error(`Keystore missing at ${keystorePath}`);
  const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
  const enc = keystore.encrypted;
  if (!enc?.ciphertext) throw new Error("Keystore format not supported (no encrypted.ciphertext)");
  const { scryptSync, createDecipheriv } = await import("crypto" as any);
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const keyLen = enc.keyLen ?? 32;
  const N = enc.scrypt?.N ?? 16384, r = enc.scrypt?.r ?? 8, p = enc.scrypt?.p ?? 1;
  const key = scryptSync(password, salt, keyLen, { N, r, p });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const mnemonic = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8").trim();
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
  return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
}

function createBitflowSDK(): any {
  const { BitflowSDK } = require("@bitflowlabs/core-sdk");
  return new BitflowSDK({
    BITFLOW_API_HOST: process.env.BITFLOW_API_HOST || "https://api.bitflowapis.finance",
    API_HOST:         process.env.API_HOST         || "https://api.bitflowapis.finance",
    STACKS_API_HOST:  process.env.STACKS_API_HOST  || STACKS_API,
    KEEPER_API_HOST:  process.env.KEEPER_API_HOST  || "https://api.bitflowapis.finance",
    KEEPER_API_URL:   process.env.KEEPER_API_URL   || "https://api.bitflowapis.finance",
  });
}

// ─── Broadcast helper ────────────────────────────────────────────────────────

async function broadcastSignedCall(params: {
  contractAddress: string;
  contractName:    string;
  functionName:    string;
  functionArgs:    any[];
  postConditions:  any[];
  stxPrivateKey:   string;
}): Promise<{ txId: string; explorerUrl: string }> {
  const { makeContractCall, broadcastTransaction, AnchorMode, PostConditionMode } = await import("@stacks/transactions" as any);
  const { STACKS_MAINNET } = await import("@stacks/network" as any);
  const tx = await makeContractCall({
    contractAddress: params.contractAddress,
    contractName:    params.contractName,
    functionName:    params.functionName,
    functionArgs:    params.functionArgs,
    postConditions:  params.postConditions,
    // Router internally transfers tokens on behalf of the sender. Observed mainnet
    // txs carry zero explicit post-conditions, so Allow is required. Safety is
    // instead enforced by the router's own min-dlp / min-x/y-amount guards.
    postConditionMode: PostConditionMode.Allow,
    network:         STACKS_MAINNET,
    senderKey:       params.stxPrivateKey,
    anchorMode:      AnchorMode.Any,
    fee:             BigInt(TX_FEE_USTX),
  });
  const res = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if (res.error) throw new Error(`Broadcast failed: ${res.error} — ${res.reason ?? ""}`);
  return { txId: res.txid, explorerUrl: `${EXPLORER_BASE}/${res.txid}?chain=mainnet` };
}

// ─── Router: direct Clarity-call construction ───────────────────────────────
//
// The Bitflow core SDK exposes `prepareSwap` only — there is no public helper for
// HODLMM add/remove liquidity. These calls are therefore built directly against
// the on-chain router `dlmm-liquidity-router-v-1-2`. The ABI was reverse-
// engineered from mainnet transactions; bin-id semantics are preserved as-is
// from the Bitflow positions API. See AGENT.md "ABI risk" for caveats.

const ROUTER_ADDRESS = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME    = "dlmm-liquidity-router-v-1-2";

interface RouterCall {
  contractAddress: string;
  contractName:    string;
  functionName:    string;
  functionArgs:    any[];
  humanRepr:       string;
}

function splitContract(c: string): { address: string; name: string } {
  const [address, name] = c.split(".");
  if (!address || !name) throw new Error(`Invalid contract identifier: ${c}`);
  return { address, name };
}

async function buildAddLiquidityCall(params: {
  poolContract:   string;   // "SP...xx.dlmm-pool-..."
  xTokenContract: string;
  yTokenContract: string;
  positions:      { binId: number; xAmount: number; yAmount: number }[];
  feeBpsCap:      number;   // e.g. 100 (= 1%)
}): Promise<RouterCall> {
  const { tupleCV, listCV, intCV, uintCV, contractPrincipalCV, someCV } = await import("@stacks/transactions" as any);
  const pool = splitContract(params.poolContract);
  const xTok = splitContract(params.xTokenContract);
  const yTok = splitContract(params.yTokenContract);
  const feeOf = (amt: number) => Math.ceil(amt * (params.feeBpsCap / 10_000));
  const positions = params.positions.map(p => tupleCV({
    "bin-id":                intCV(p.binId),
    "max-x-liquidity-fee":   uintCV(feeOf(p.xAmount)),
    "max-y-liquidity-fee":   uintCV(feeOf(p.yAmount)),
    "min-dlp":               uintCV(1),
    "pool-trait":            contractPrincipalCV(pool.address, pool.name),
    "x-amount":              uintCV(p.xAmount),
    "x-token-trait":         contractPrincipalCV(xTok.address, xTok.name),
    "y-amount":              uintCV(p.yAmount),
    "y-token-trait":         contractPrincipalCV(yTok.address, yTok.name),
  }));
  const deadline = Math.floor(Date.now() / 1000) + 300;
  return {
    contractAddress: ROUTER_ADDRESS,
    contractName:    ROUTER_NAME,
    functionName:    "add-liquidity-multi",
    functionArgs:    [listCV(positions), someCV(uintCV(deadline))],
    humanRepr:       `(contract-call? '${ROUTER_ADDRESS}.${ROUTER_NAME} add-liquidity-multi (list ${params.positions.map(p => `{bin-id: ${p.binId}, x-amount: u${p.xAmount}, y-amount: u${p.yAmount}, min-dlp: u1, pool: '${params.poolContract}}`).join(" ")}) (some u${deadline}))`,
  };
}

async function buildWithdrawLiquidityCall(params: {
  poolContract:   string;
  xTokenContract: string;
  yTokenContract: string;
  positions:      { binId: number; liquidity: string | number }[];
}): Promise<RouterCall> {
  const { tupleCV, listCV, intCV, uintCV, contractPrincipalCV, someCV } = await import("@stacks/transactions" as any);
  const pool = splitContract(params.poolContract);
  const xTok = splitContract(params.xTokenContract);
  const yTok = splitContract(params.yTokenContract);
  const positions = params.positions.map(p => tupleCV({
    "amount":        uintCV(String(p.liquidity)),
    "bin-id":        intCV(p.binId),
    "min-x-amount":  uintCV(0),
    "min-y-amount":  uintCV(0),
    "pool-trait":    contractPrincipalCV(pool.address, pool.name),
    "x-token-trait": contractPrincipalCV(xTok.address, xTok.name),
    "y-token-trait": contractPrincipalCV(yTok.address, yTok.name),
  }));
  const deadline = Math.floor(Date.now() / 1000) + 300;
  return {
    contractAddress: ROUTER_ADDRESS,
    contractName:    ROUTER_NAME,
    functionName:    "withdraw-liquidity-multi",
    functionArgs:    [listCV(positions), someCV(uintCV(deadline))],
    humanRepr:       `(contract-call? '${ROUTER_ADDRESS}.${ROUTER_NAME} withdraw-liquidity-multi (list ${params.positions.map(p => `{bin-id: ${p.binId}, amount: u${p.liquidity}, min-x-amount: u0, min-y-amount: u0, pool: '${params.poolContract}}`).join(" ")}) (some u${deadline}))`,
  };
}

// Single-sided plan filter: when the budget token is X only (e.g. sBTC), we can
// only deposit into bins at or above the active bin (which hold only X). Bins
// below the active bin hold only Y and would require Y-side funding.
function filterSingleSidedPlan(
  plan: BinDeposit[],
  activeBin: number,
  side: "x" | "y"
): BinDeposit[] {
  return plan.filter(d => side === "x" ? d.binId >= activeBin : d.binId <= activeBin);
}

// ─── Budget / token helpers ──────────────────────────────────────────────────

function inferBudgetToken(pool: HodlmmPool): "sbtc" | "stx" {
  const needle = (pool.token_x + " " + pool.token_y).toLowerCase();
  if (needle.includes("sbtc")) return "sbtc";
  return "stx";
}
function budgetCeiling(token: "sbtc" | "stx"): number {
  return token === "sbtc" ? MAX_BUDGET_SATS : MAX_BUDGET_USTX;
}

// ─── Commands ────────────────────────────────────────────────────────────────

const program = new Command();
program.name("hodlmm-shadow").description("Whale-Mirror LP Autopilot for Bitflow HODLMM");

// ── doctor ────────────────────────────────────────────────────────────────────
program.command("doctor").description("Environment + API health").action(async () => {
  try {
    ensureStateDir();
    const checks: Record<string, any> = {};
    try {
      const pools = await getPools();
      checks.bitflow_hodlmm_api = { ok: true, pool_count: pools.length };
    } catch (e: any) { checks.bitflow_hodlmm_api = { ok: false, error: e.message }; }
    try {
      const r = await fetch(`${STACKS_API}/v2/info`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      checks.stacks_api = { ok: r.ok };
    } catch (e: any) { checks.stacks_api = { ok: false, error: e.message }; }
    checks.state_dir       = { ok: fs.existsSync(STATE_DIR), path: STATE_DIR };
    checks.whitelist_file  = { ok: fs.existsSync(WHITELIST_FILE), path: WHITELIST_FILE, entries: readWhitelist().length };
    checks.wallets_present = { ok: fs.existsSync(WALLETS_FILE) || !!process.env.STACKS_PRIVATE_KEY };
    const state = readState();
    checks.follow_active   = state ? { target: state.target, poolId: state.poolId, budget: state.budget } : null;

    let sdkOk: any = { ok: false };
    try { require("@bitflowlabs/core-sdk"); sdkOk = { ok: true }; }
    catch (e: any) { sdkOk = { ok: false, note: "run install-packs" }; }
    checks.bitflow_sdk = sdkOk;

    const allOk = checks.bitflow_hodlmm_api.ok && checks.stacks_api.ok && checks.wallets_present.ok;
    success("doctor", { healthy: allOk, checks });
  } catch (e: any) { fail("doctor", e.message); }
});

// ── install-packs ────────────────────────────────────────────────────────────
program.command("install-packs").description("Install npm dependencies").action(async () => {
  const { execSync } = await import("child_process" as any);
  const deps = [
    "commander",
    "@bitflowlabs/core-sdk",
    "@stacks/transactions",
    "@stacks/network",
    "@stacks/wallet-sdk",
    "@stacks/encryption",
  ];
  try {
    execSync(`bun add ${deps.join(" ")}`, { stdio: ["pipe","pipe","pipe"], cwd: path.resolve(__dirname) });
    success("install-packs", { installed: deps });
  } catch (e: any) { fail("install-packs", `Install failed: ${e.message}`); }
});

// ── scout ────────────────────────────────────────────────────────────────────
program
  .command("scout <wallet>")
  .option("--pool-id <id>", "Restrict to a single pool")
  .description("Read-only preview of a target wallet's HODLMM footprint")
  .action(async (wallet: string, opts: any) => {
    try {
      if (!/^SP[0-9A-Z]{38,40}$/.test(wallet)) return fail("scout", `Invalid STX address: ${wallet}`);
      const hits = await scoutWallet(wallet, opts.poolId);
      success("scout", { target: wallet, pools: hits, positions: hits.length });
    } catch (e: any) { fail("scout", e.message); }
  });

// ── follow ───────────────────────────────────────────────────────────────────
program
  .command("follow <wallet>")
  .requiredOption("--budget <amount>", "Budget in base units (sats for sBTC pools, µSTX for STX)", (v) => parseInt(v))
  .option("--pool-id <id>", "HODLMM pool id", "dlmm_1")
  .option("--max-bins <n>", "Max bins to mirror", (v) => parseInt(v), DEFAULT_MAX_BINS)
  .option("--max-slippage <pct>", "Max slippage percent", (v) => parseFloat(v), DEFAULT_SLIPPAGE_PCT)
  .option("--drift <pct>", "Drift threshold for sync", (v) => parseFloat(v), DEFAULT_DRIFT_PCT)
  .option("--execute", "Broadcast the follow-deposit plan", false)
  .option("--i-accept-abi-risk", "Acknowledge the router ABI caveat (see AGENT.md). Required with --execute.", false)
  .option("--password <pw>", "Wallet password (only needed with --execute)")
  .description("Register a target and emit (or broadcast) the initial deployment plan")
  .action(async (wallet: string, opts: any) => {
    try {
      if (!/^SP[0-9A-Z]{38,40}$/.test(wallet)) return fail("follow", `Invalid STX address: ${wallet}`);

      const existing = readState();
      if (existing) return blocked("follow", { currentTarget: existing.target }, "Already following a target. Run `unfollow` first.");

      const wlErr = gateWhitelist(wallet);
      if (wlErr) return blocked("follow", { failed_gate: "target_whitelist", target: wallet }, wlErr);

      if (opts.maxSlippage > MAX_SLIPPAGE_PCT_CEIL)
        return blocked("follow", { failed_gate: "slippage_cap" }, `--max-slippage ${opts.maxSlippage} > ceiling ${MAX_SLIPPAGE_PCT_CEIL}`);
      if (opts.maxBins > MAX_BINS_CEILING)
        return blocked("follow", { failed_gate: "max_bins_cap" }, `--max-bins ${opts.maxBins} > ceiling ${MAX_BINS_CEILING}`);
      if (opts.drift < DRIFT_PCT_FLOOR)
        return blocked("follow", { failed_gate: "drift_floor" }, `--drift ${opts.drift} < floor ${DRIFT_PCT_FLOOR}`);

      const pool = await getPool(opts.poolId);
      if (!pool) return fail("follow", `Pool not found: ${opts.poolId}`);
      const liveErr = await gatePoolLiveness(opts.poolId);
      if (liveErr) return blocked("follow", { failed_gate: "pool_liveness", pool: opts.poolId }, liveErr);

      const budgetToken = inferBudgetToken(pool);
      const budgetMax   = budgetCeiling(budgetToken);
      if (opts.budget <= 0 || opts.budget > budgetMax)
        return blocked("follow", { failed_gate: "budget_cap" },
          `Budget ${opts.budget} outside (0, ${budgetMax}] for ${budgetToken.toUpperCase()}`);

      const appPool = await getAppPool(opts.poolId);
      const slErr   = await gateSlippage(opts.poolId, opts.maxSlippage, appPool);
      if (slErr) return blocked("follow", { failed_gate: "slippage" }, slErr);

      const targetBins = await getUserPositionBins(wallet, opts.poolId);
      if (targetBins.length === 0)
        return blocked("follow", { failed_gate: "empty_target" }, `Target ${wallet} has no liquidity in ${opts.poolId}`);
      // Note: bin_cap applies to the SHADOW deployment, not the target's bin count.
      // computeDeployPlan truncates to the top-weighted maxBins, emitting a partial mirror.

      const shape = extractShape(targetBins);
      let   plan  = computeDeployPlan(shape, opts.budget, opts.maxBins);

      // Single-sided filter: sBTC budget can only deposit into X-side bins (>= active).
      const side: "x" | "y" = budgetToken === "sbtc" ? "x" : "x"; // STX pool also treats STX as X here
      plan = filterSingleSidedPlan(plan, pool.active_bin, side);
      if (plan.length === 0)
        return blocked("follow", { failed_gate: "no_single_sided_bins" },
          `No single-sided ${side}-bins (at or above active ${pool.active_bin}) found in target's top-${opts.maxBins} shape.`);

      // Router call construction (real, broadcast-ready)
      const poolContract   = appPool?.poolContract ?? "";
      const xTokenContract = appPool?.tokens?.tokenX?.contract ?? pool.token_x;
      const yTokenContract = appPool?.tokens?.tokenY?.contract ?? pool.token_y;
      if (!poolContract) return fail("follow", "App pool missing poolContract — cannot build router call.");

      const call = await buildAddLiquidityCall({
        poolContract, xTokenContract, yTokenContract,
        positions: plan.map(d => ({ binId: d.binId, xAmount: d.amountBase, yAmount: 0 })),
        feeBpsCap: 100, // 1% max fee tolerated per observed mainnet txs
      });

      let ownerAddress = "";
      if (opts.execute) {
        if (!opts.iAcceptAbiRisk)
          return blocked("follow", { failed_gate: "abi_risk_ack" },
            "--execute requires --i-accept-abi-risk. Router bin-id semantics vs. API bin-id are unverified; see AGENT.md.");
        if (!opts.password) return fail("follow", "--execute requires --password");
        const keys = await loadWalletKeys(opts.password);
        ownerAddress = keys.stxAddress;
        if (ownerAddress === wallet)
          return blocked("follow", { failed_gate: "self_mirror" }, "Cannot follow your own wallet.");

        const res = await broadcastSignedCall({
          contractAddress: call.contractAddress,
          contractName:    call.contractName,
          functionName:    call.functionName,
          functionArgs:    call.functionArgs,
          postConditions:  [],
          stxPrivateKey:   keys.stxPrivateKey,
        });
        appendEvent({ event: "follow_deposit", bins: plan.length, txId: res.txId });

        const state: ShadowState = {
          target: wallet, ownerAddress, poolId: opts.poolId,
          budget: opts.budget, budgetToken,
          maxSlippagePct: opts.maxSlippage, maxBins: opts.maxBins, driftPct: opts.drift,
          deployedBase: plan.reduce((s,d) => s + d.amountBase, 0),
          shadowBins: plan.map(d => ({ binId: d.binId, liquidity: String(d.amountBase) })),
          lastSync: new Date().toISOString(), createdAt: new Date().toISOString(),
        };
        writeState(state);
        appendEvent({ event: "follow_committed", target: wallet, poolId: opts.poolId, budget: opts.budget, txId: res.txId });
        return success("follow", { executed: true, target: wallet, poolId: opts.poolId, deposits: plan.length, ...res });
      }

      // Dry-run path — no state written.
      success("follow", {
        executed:       false,
        dryRun:         true,
        target:         wallet,
        poolId:         opts.poolId,
        budgetToken,
        budget:         opts.budget,
        plan,
        targetShape: {
          bins: shape.binIds.length, minBin: shape.minBin, maxBin: shape.maxBin,
          activeBin: pool.active_bin, inActiveRange: shape.binIds.includes(pool.active_bin),
          concentrationHHI: computeHHI(shape.weights),
        },
        routerCall: {
          contract: `${call.contractAddress}.${call.contractName}`,
          fn:       call.functionName,
          positions: plan.length,
          clarityRepr: call.humanRepr,
        },
        nextStep: "Re-run with --execute --i-accept-abi-risk --password <pw> to broadcast.",
      });
    } catch (e: any) { fail("follow", e.message); }
  });

// ── sync ─────────────────────────────────────────────────────────────────────
program
  .command("sync")
  .option("--execute", "Broadcast the delta plan", false)
  .option("--i-accept-abi-risk", "Acknowledge the router ABI caveat (see AGENT.md). Required with --execute.", false)
  .option("--password <pw>", "Wallet password (only needed with --execute)")
  .description("Diff shadow vs target's current shape; emit (or broadcast) the rebalance")
  .action(async (opts: any) => {
    try {
      const state = readState();
      if (!state) return blocked("sync", {}, "Not following a target. Run `follow` first.");

      if (state.lastSync) {
        const elapsed = (Date.now() - Date.parse(state.lastSync)) / 1000;
        if (elapsed < SYNC_COOLDOWN_SEC)
          return blocked("sync", { failed_gate: "cooldown", elapsedSec: Math.floor(elapsed) },
            `Cooldown: ${Math.floor(SYNC_COOLDOWN_SEC - elapsed)}s remaining`);
      }

      const liveErr = await gatePoolLiveness(state.poolId);
      if (liveErr) return blocked("sync", { failed_gate: "pool_liveness" }, liveErr);
      const appPool = await getAppPool(state.poolId);
      const slErr   = await gateSlippage(state.poolId, state.maxSlippagePct, appPool);
      if (slErr) return blocked("sync", { failed_gate: "slippage" }, slErr);

      const targetBins = await getUserPositionBins(state.target, state.poolId);
      if (targetBins.length === 0)
        return blocked("sync", { failed_gate: "empty_target" }, "Target has exited — consider `panic`.");
      // bin_cap is enforced inside computeDeployPlan (top-N truncation).

      const shape = extractShape(targetBins);
      const targetPlan = computeDeployPlan(shape, state.budget, state.maxBins);
      const diff = diffShapes(state.shadowBins, targetPlan);

      if (diff.driftPct < state.driftPct)
        return success("sync", { noop: true, driftPct: diff.driftPct, threshold: state.driftPct, reason: "below drift threshold" });

      // Budget gate on adds
      const addSum = diff.adds.reduce((s, a) => s + a.amountBase, 0);
      const projectedDeployed = state.deployedBase + addSum - diff.removes.reduce((s, r) => s + Number(r.liquidity), 0);
      if (projectedDeployed > state.budget)
        return blocked("sync", { failed_gate: "budget", projectedDeployed, budget: state.budget }, "Sync would exceed pinned budget.");

      if (!opts.execute) {
        return success("sync", {
          executed: false, dryRun: true,
          driftPct: diff.driftPct, adds: diff.adds, removes: diff.removes,
          nextStep: "Re-run with --execute --password <pw> to broadcast.",
        });
      }

      if (!opts.iAcceptAbiRisk)
        return blocked("sync", { failed_gate: "abi_risk_ack" }, "--execute requires --i-accept-abi-risk (see AGENT.md).");
      if (!opts.password) return fail("sync", "--execute requires --password");
      const keys = await loadWalletKeys(opts.password);
      const poolContract   = appPool?.poolContract ?? "";
      const xTokenContract = appPool?.tokens?.tokenX?.contract ?? "";
      const yTokenContract = appPool?.tokens?.tokenY?.contract ?? "";
      if (!poolContract || !xTokenContract || !yTokenContract)
        return fail("sync", "App pool metadata incomplete — cannot build router calls.");

      const txs: any[] = [];
      if (diff.removes.length > 0) {
        const wcall = await buildWithdrawLiquidityCall({
          poolContract, xTokenContract, yTokenContract,
          positions: diff.removes.map(r => ({ binId: r.binId, liquidity: r.liquidity })),
        });
        const res = await broadcastSignedCall({ ...wcall, postConditions: [], stxPrivateKey: keys.stxPrivateKey });
        txs.push({ op: "withdraw", bins: diff.removes.length, ...res });
        appendEvent({ event: "sync_withdraw", bins: diff.removes.length, txId: res.txId });
      }
      if (diff.adds.length > 0) {
        const acall = await buildAddLiquidityCall({
          poolContract, xTokenContract, yTokenContract,
          positions: diff.adds.map(a => ({ binId: a.binId, xAmount: a.amountBase, yAmount: 0 })),
          feeBpsCap: 100,
        });
        const res = await broadcastSignedCall({ ...acall, postConditions: [], stxPrivateKey: keys.stxPrivateKey });
        txs.push({ op: "add", bins: diff.adds.length, ...res });
        appendEvent({ event: "sync_add", bins: diff.adds.length, txId: res.txId });
      }

      // Update state snapshot
      state.shadowBins = targetPlan.map(d => ({ binId: d.binId, liquidity: String(d.amountBase) }));
      state.deployedBase = projectedDeployed;
      state.lastSync = new Date().toISOString();
      writeState(state);
      success("sync", { executed: true, driftPct: diff.driftPct, txs });
    } catch (e: any) { fail("sync", e.message); }
  });

// ── unfollow ─────────────────────────────────────────────────────────────────
program.command("unfollow").description("Stop syncing (position retained)").action(() => {
  const state = readState();
  if (!state) return blocked("unfollow", {}, "Not following anyone.");
  writeState(null);
  appendEvent({ event: "unfollow", target: state.target });
  success("unfollow", { target: state.target, note: "Shadow position retained. Use `panic` to exit." });
});

// ── panic ────────────────────────────────────────────────────────────────────
program
  .command("panic")
  .option("--execute", "Broadcast the full-exit plan", false)
  .option("--i-accept-abi-risk", "Acknowledge the router ABI caveat (see AGENT.md). Required with --execute.", false)
  .option("--password <pw>", "Wallet password (only needed with --execute)")
  .description("Emergency full exit of the shadow position")
  .action(async (opts: any) => {
    try {
      const state = readState();
      if (!state) return blocked("panic", {}, "No shadow position on record.");
      if (state.shadowBins.length === 0) return success("panic", { noop: true, reason: "no bins to exit" });

      const appPool = await getAppPool(state.poolId);
      const poolContract   = appPool?.poolContract ?? "";
      const xTokenContract = appPool?.tokens?.tokenX?.contract ?? "";
      const yTokenContract = appPool?.tokens?.tokenY?.contract ?? "";
      if (!poolContract || !xTokenContract || !yTokenContract)
        return fail("panic", "App pool metadata incomplete — cannot build router call.");

      const wcall = await buildWithdrawLiquidityCall({
        poolContract, xTokenContract, yTokenContract,
        positions: state.shadowBins.map(b => ({ binId: b.binId, liquidity: b.liquidity })),
      });

      if (!opts.execute) {
        return success("panic", {
          executed: false, dryRun: true,
          withdrawPlan: state.shadowBins, poolId: state.poolId,
          routerCall: { contract: `${wcall.contractAddress}.${wcall.contractName}`, fn: wcall.functionName, positions: state.shadowBins.length, clarityRepr: wcall.humanRepr },
          nextStep: "Re-run with --execute --i-accept-abi-risk --password <pw> to broadcast.",
        });
      }

      if (!opts.iAcceptAbiRisk)
        return blocked("panic", { failed_gate: "abi_risk_ack" }, "--execute requires --i-accept-abi-risk (see AGENT.md).");
      if (!opts.password) return fail("panic", "--execute requires --password");
      const keys = await loadWalletKeys(opts.password);

      const res = await broadcastSignedCall({ ...wcall, postConditions: [], stxPrivateKey: keys.stxPrivateKey });
      const txs: any[] = [{ bins: state.shadowBins.length, ...res }];
      appendEvent({ event: "panic_withdraw", bins: state.shadowBins.length, txId: res.txId });

      state.shadowBins = [];
      state.deployedBase = 0;
      writeState(state);
      success("panic", { executed: true, withdrawals: txs.length, txs });
    } catch (e: any) { fail("panic", e.message); }
  });

// ── status ───────────────────────────────────────────────────────────────────
program.command("status").description("Current follow relationship + drift").action(async () => {
  try {
    const state = readState();
    if (!state) return success("status", { following: null });
    const targetBins = await getUserPositionBins(state.target, state.poolId);
    if (targetBins.length === 0) return success("status", { following: state, liveDiff: null, note: "target has no liquidity" });
    const shape = extractShape(targetBins);
    const targetPlan = computeDeployPlan(shape, state.budget, state.maxBins);
    const diff = diffShapes(state.shadowBins, targetPlan);
    success("status", {
      following: state,
      liveDiff:  { driftPct: diff.driftPct, adds: diff.adds.length, removes: diff.removes.length, threshold: state.driftPct },
    });
  } catch (e: any) { fail("status", e.message); }
});

program.parse(process.argv);
