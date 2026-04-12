#!/usr/bin/env bun
/**
 * bitflow-limit-order — Agent-powered limit orders on Bitflow
 *
 * Subcommands:
 *   doctor        — Verify wallet, API, and order storage health
 *   set           — Create a new limit order
 *   list          — Show all orders with status
 *   cancel <id>   — Cancel a pending order
 *   run           — Check active orders against pool prices, execute triggers
 *   install-packs — Install required npm dependencies
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_API = "https://bff.bitflowapis.finance";
const STACKS_API = "https://api.mainnet.hiro.so";
const EXPLORER_BASE = "https://explorer.hiro.so/txid";

const ORDERS_DIR = path.join(os.homedir(), ".aibtc", "limit-orders");
const ORDERS_FILE = path.join(ORDERS_DIR, "orders.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");

// Safety limits (hardcoded floors — NOT configurable)
const MAX_ORDER_STX = 2000;
const MAX_ORDER_SBTC = 0.005;
const MAX_ACTIVE_ORDERS = 10;
const MAX_SLIPPAGE_PCT = 5;
const DEFAULT_SLIPPAGE_PCT = 1;
const DEFAULT_EXPIRY_HOURS = 24;
const MAX_EXPIRY_DAYS = 7;
const API_TIMEOUT_MS = 10_000;
const TX_FEE_ESTIMATE = 5000; // microSTX

// ─── Types ────────────────────────────────────────────────────────────────────

interface LimitOrder {
  orderId: number;
  pair: string;
  poolId: string;
  side: "buy" | "sell";
  targetPrice: number;
  amount: number;
  slippage: number;
  status: "active" | "filled" | "cancelled" | "expired" | "error";
  createdAt: string;
  expiresAt: string;
  tokenIn: string;
  tokenOut: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  fillData?: {
    txId: string;
    fillPrice: number;
    filledAt: string;
    explorerUrl: string;
  };
  errorMessage?: string;
  lastSkipReason?: string;
  lastSkipAt?: string;
}

interface OrderBook {
  nextId: number;
  orders: LimitOrder[];
}

interface PoolInfo {
  pool_id: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin: number;
  active: boolean;
  pool_name: string;
  pool_symbol: string;
}

interface ActiveBin {
  success: boolean;
  pool_id: string;
  bin_id: number;
  price: string;
  error: string | null;
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function output(status: string, action: string, data: any, error: string | null = null): void {
  console.log(JSON.stringify({ status, action, data, error }));
}

function success(action: string, data: any): void {
  output("success", action, data);
}

function blocked(action: string, data: any, error: string): void {
  output("blocked", action, data, error);
}

function fail(action: string, error: string): void {
  output("error", action, null, error);
}

function log(msg: string): void {
  process.stderr.write(`[limit-order] ${msg}\n`);
}

// ─── Order storage ────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(ORDERS_DIR)) {
    fs.mkdirSync(ORDERS_DIR, { recursive: true });
  }
}

function loadOrderBook(): OrderBook {
  ensureDir();
  if (!fs.existsSync(ORDERS_FILE)) {
    return { nextId: 1, orders: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8"));
  } catch (e: any) {
    log(`Warning: orders.json corrupted, starting fresh — ${e.message}`);
    return { nextId: 1, orders: [] };
  }
}

function saveOrderBook(book: OrderBook): void {
  ensureDir();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(book, null, 2));
}

// ─── Bitflow API helpers ──────────────────────────────────────────────────────

async function fetchPools(): Promise<PoolInfo[]> {
  const res = await fetch(`${BITFLOW_API}/api/quotes/v1/pools`, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Pools API ${res.status}`);
  const data = await res.json() as { pools: PoolInfo[] };
  return data.pools;
}

async function findPool(pair: string): Promise<PoolInfo | null> {
  const pools = await fetchPools();
  const normalized = pair.toUpperCase().replace(/[_\s]/g, "-");
  // Match by pool_symbol (e.g., "STX-sBTC")
  return pools.find(p =>
    p.pool_symbol.toUpperCase().replace(/[_\s]/g, "-") === normalized
  ) ?? null;
}

async function getActiveBinPrice(poolId: string): Promise<{ price: number; binId: number }> {
  const res = await fetch(`${BITFLOW_API}/api/quotes/v1/bins/${poolId}/active`, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Active bin API ${res.status}`);
  const data = await res.json() as ActiveBin;
  if (!data.success) throw new Error(`Active bin error: ${data.error}`);
  return { price: Number(data.price), binId: data.bin_id };
}

// ─── Wallet helpers ───────────────────────────────────────────────────────────

function walletExists(): boolean {
  return (
    fs.existsSync(WALLETS_FILE) ||
    fs.existsSync(path.join(os.homedir(), ".aibtc", "wallet.json")) ||
    !!process.env.STACKS_PRIVATE_KEY
  );
}

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = await import("crypto" as any);
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key = scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8").trim();
}

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  // 1. Direct env var
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as any);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }

  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);

  // 2. AIBTC wallets.json + keystore.json
  if (fs.existsSync(WALLETS_FILE)) {
    try {
      const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
      const activeWallet = (walletsJson.wallets ?? [])[0];
      if (activeWallet?.id) {
        const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
        if (fs.existsSync(keystorePath)) {
          const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
          const enc = keystore.encrypted;
          if (enc?.ciphertext) {
            const mnemonic = await decryptAibtcKeystore(enc, password);
            const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
            const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
          const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
          if (legacyEnc) {
            const { decryptMnemonic } = await import("@stacks/encryption" as any);
            const mnemonic = await decryptMnemonic(legacyEnc, password);
            const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
            const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
        }
      }
    } catch (e: any) {
      log(`Wallet decrypt error: ${e.message}`);
    }
  }

  // 3. Legacy wallet.json
  const legacyPath = path.join(os.homedir(), ".aibtc", "wallet.json");
  if (fs.existsSync(legacyPath)) {
    try {
      const w = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      const mnemonic = w.mnemonic ?? w.encrypted_mnemonic ?? w.encryptedMnemonic;
      if (mnemonic) {
        const wallet = await generateWallet({ secretKey: mnemonic, password });
        const account = deriveAccount(wallet, 0);
        return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
      }
    } catch { /* fall through */ }
  }

  throw new Error(
    "No wallet found or decryption failed.\n" +
    "Options:\n" +
    "  1. Run: npx @aibtc/mcp-server@latest --install\n" +
    "  2. Set STACKS_PRIVATE_KEY env var"
  );
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${STACKS_API}/v2/accounts/${address}?proof=0`, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Balance API ${res.status}`);
  const data = await res.json() as any;
  return Number(BigInt(data.balance) - BigInt(data.locked)) / 1e6;
}

// ─── BitflowSDK helpers ──────────────────────────────────────────────────────

function createBitflowSDK(): any {
  const { BitflowSDK } = require("@bitflowlabs/core-sdk");
  return new BitflowSDK({
    BITFLOW_API_HOST: process.env.BITFLOW_API_HOST || "https://api.bitflowapis.finance",
    API_HOST: process.env.API_HOST || "https://api.bitflowapis.finance",
    STACKS_API_HOST: process.env.STACKS_API_HOST || STACKS_API,
    KEEPER_API_HOST: process.env.KEEPER_API_HOST || "https://api.bitflowapis.finance",
    KEEPER_API_URL: process.env.KEEPER_API_URL || "https://api.bitflowapis.finance",
  });
}

async function findSdkToken(
  sdk: any,
  symbol: string
): Promise<{ tokenId: string; tokenDecimals: number; symbol: string } | null> {
  const tokens = await sdk.getAvailableTokens();
  const sym = symbol.toLowerCase();
  const match = tokens.find((t: any) =>
    (t.symbol ?? "").toLowerCase() === sym ||
    (t.tokenId ?? "").toLowerCase() === sym ||
    (t["token-id"] ?? "").toLowerCase() === sym
  );
  if (!match) return null;
  return {
    tokenId: match.tokenId ?? match["token-id"],
    tokenDecimals: match.tokenDecimals ?? 6,
    symbol: match.symbol ?? symbol.toUpperCase(),
  };
}

// ─── Swap execution ──────────────────────────────────────────────────────────

async function executeSwap(opts: {
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountHuman: number;
  senderAddress: string;
  stxPrivateKey: string;
  slippagePct: number;
  dryRun: boolean;
}): Promise<{ txId: string; explorerUrl: string }> {
  const sdk = createBitflowSDK();

  // Resolve token IDs via SDK (not raw contract addresses)
  const tokenIn = await findSdkToken(sdk, opts.tokenInSymbol);
  if (!tokenIn) throw new Error(`Token not found in Bitflow SDK: ${opts.tokenInSymbol}`);
  const tokenOut = await findSdkToken(sdk, opts.tokenOutSymbol);
  if (!tokenOut) throw new Error(`Token not found in Bitflow SDK: ${opts.tokenOutSymbol}`);

  log(`Resolved tokens: ${tokenIn.symbol} (${tokenIn.tokenId}) → ${tokenOut.symbol} (${tokenOut.tokenId})`);

  const slippageDecimal = opts.slippagePct / 100;

  const quoteResult = await sdk.getQuoteForRoute(
    tokenIn.tokenId, tokenOut.tokenId, opts.amountHuman
  );
  if (!quoteResult?.bestRoute?.route) {
    throw new Error(`No swap route for ${tokenIn.symbol} → ${tokenOut.symbol}`);
  }

  const swapExecutionData = {
    route: quoteResult.bestRoute.route,
    amount: opts.amountHuman,
    tokenXDecimals: tokenIn.tokenDecimals,
    tokenYDecimals: tokenOut.tokenDecimals,
  };

  const swapParams = await sdk.prepareSwap(
    swapExecutionData,
    opts.senderAddress,
    slippageDecimal
  );

  if (opts.dryRun) {
    const fakeTxId = "dry-run-" + crypto.randomBytes(8).toString("hex");
    return { txId: fakeTxId, explorerUrl: `${EXPLORER_BASE}/${fakeTxId}?chain=mainnet` };
  }

  const {
    makeContractCall, broadcastTransaction,
    AnchorMode, PostConditionMode,
  } = await import("@stacks/transactions" as any);
  const { STACKS_MAINNET } = await import("@stacks/network" as any);

  const tx = await makeContractCall({
    contractAddress: swapParams.contractAddress,
    contractName: swapParams.contractName,
    functionName: swapParams.functionName,
    functionArgs: swapParams.functionArgs,
    postConditions: swapParams.postConditions,
    postConditionMode: PostConditionMode.Deny,
    network: STACKS_MAINNET,
    senderKey: opts.stxPrivateKey,
    anchorMode: AnchorMode.Any,
    fee: BigInt(TX_FEE_ESTIMATE),
  });

  const broadcastRes = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if (broadcastRes.error) {
    throw new Error(`Broadcast failed: ${broadcastRes.error} — ${broadcastRes.reason ?? ""}`);
  }

  const txId: string = broadcastRes.txid;
  return { txId, explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet` };
}

// ─── Duration parser ──────────────────────────────────────────────────────────

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(m|h|d)$/);
  if (!m) throw new Error(`Invalid duration: ${s}. Use format like 1h, 24h, 7d`);
  const n = parseInt(m[1]);
  const unit = m[2];
  const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
  const maxMs = MAX_EXPIRY_DAYS * 86_400_000;
  if (ms > maxMs) throw new Error(`Max expiry is ${MAX_EXPIRY_DAYS}d`);
  if (ms < 60_000) throw new Error("Min expiry is 1m");
  return ms;
}

// ─── Token ID resolver ────────────────────────────────────────────────────────

function resolveTokenIds(pool: PoolInfo, side: "buy" | "sell"): {
  tokenIn: string; tokenOut: string;
  tokenInDecimals: number; tokenOutDecimals: number;
} {
  // For HODLMM pools, price = token_y per token_x
  // buy  = buying token_x with token_y → tokenIn = token_y, tokenOut = token_x
  // sell = selling token_x for token_y → tokenIn = token_x, tokenOut = token_y
  if (side === "buy") {
    return {
      tokenIn: pool.token_y,
      tokenOut: pool.token_x,
      tokenInDecimals: getDecimals(pool.token_y),
      tokenOutDecimals: getDecimals(pool.token_x),
    };
  } else {
    return {
      tokenIn: pool.token_x,
      tokenOut: pool.token_y,
      tokenInDecimals: getDecimals(pool.token_x),
      tokenOutDecimals: getDecimals(pool.token_y),
    };
  }
}

function getDecimals(tokenId: string): number {
  // STX wrapped token
  if (tokenId.includes("token-stx")) return 6;
  // sBTC
  if (tokenId.includes("sbtc")) return 8;
  // USDC variants
  if (tokenId.toLowerCase().includes("usdc")) return 6;
  // USDh
  if (tokenId.toLowerCase().includes("usdh")) return 8;
  // Default for SIP-010 tokens
  return 6;
}

function isStxToken(tokenId: string): boolean {
  return tokenId.includes("token-stx");
}

function isSbtcToken(tokenId: string): boolean {
  return tokenId.includes("sbtc");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("bitflow-limit-order")
  .description("Agent-powered limit orders on Bitflow — set price targets, auto-execute swaps");

// Redirect Commander output to stderr
program.configureOutput({
  writeOut: (str) => process.stderr.write(str),
  writeErr: (str) => process.stderr.write(str),
});

// ── doctor ────────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Verify wallet, Bitflow API, and order storage health")
  .action(async () => {
    const checks: Record<string, { ok: boolean; message: string }> = {};

    // 1. Bitflow API
    try {
      const pools = await fetchPools();
      const dlmm = pools.filter(p => p.pool_id.startsWith("dlmm"));
      checks.bitflowApi = { ok: true, message: `Reachable — ${dlmm.length} DLMM pools available` };
    } catch (e: any) {
      checks.bitflowApi = { ok: false, message: `Unreachable: ${e.message}` };
    }

    // 2. Wallet
    try {
      if (walletExists()) {
        checks.wallet = { ok: true, message: "Wallet configuration found" };
      } else {
        checks.wallet = { ok: false, message: "No wallet found. Run: npx @aibtc/mcp-server@latest --install" };
      }
    } catch (e: any) {
      checks.wallet = { ok: false, message: e.message };
    }

    // 3. Order storage
    try {
      ensureDir();
      const book = loadOrderBook();
      const active = book.orders.filter(o => o.status === "active").length;
      checks.storage = { ok: true, message: `OK — ${book.orders.length} total orders, ${active} active` };
    } catch (e: any) {
      checks.storage = { ok: false, message: e.message };
    }

    // 4. Active bin check (STX-sBTC pool)
    try {
      const bin = await getActiveBinPrice("dlmm_6");
      checks.priceFeed = { ok: true, message: `STX-sBTC active bin #${bin.binId}, price: ${bin.price}` };
    } catch (e: any) {
      checks.priceFeed = { ok: false, message: `Price feed error: ${e.message}` };
    }

    const allOk = Object.values(checks).every(c => c.ok);
    success("doctor", { healthy: allOk, checks });
  });

// ── set ───────────────────────────────────────────────────────────────────────

program
  .command("set")
  .description("Create a new limit order")
  .requiredOption("--pair <pair>", "Trading pair (e.g., STX-sBTC)")
  .requiredOption("--side <side>", "buy or sell")
  .requiredOption("--price <price>", "Target price", parseFloat)
  .requiredOption("--amount <amount>", "Amount of input token", parseFloat)
  .option("--slippage <pct>", "Max slippage percent", parseFloat, DEFAULT_SLIPPAGE_PCT)
  .option("--expires <duration>", "Expiry duration (e.g., 1h, 24h, 7d)", DEFAULT_EXPIRY_HOURS + "h")
  .action(async (opts) => {
    try {
      // Validate side
      if (!["buy", "sell"].includes(opts.side)) {
        return fail("set", `Invalid side: ${opts.side}. Use 'buy' or 'sell'`);
      }

      // Validate slippage
      if (opts.slippage > MAX_SLIPPAGE_PCT) {
        return fail("set", `Slippage ${opts.slippage}% exceeds max ${MAX_SLIPPAGE_PCT}%`);
      }
      if (opts.slippage <= 0) {
        return fail("set", "Slippage must be positive");
      }

      // Validate price
      if (opts.price <= 0) {
        return fail("set", "Price must be positive");
      }

      // Validate amount
      if (opts.amount <= 0) {
        return fail("set", "Amount must be positive");
      }

      // Parse expiry
      let expiryMs: number;
      try {
        expiryMs = parseDuration(opts.expires);
      } catch (e: any) {
        return fail("set", e.message);
      }

      // Find pool
      log(`Looking up pool: ${opts.pair}`);
      const pool = await findPool(opts.pair);
      if (!pool) {
        return fail("set", `Pool ${opts.pair} not found. Check available pairs with doctor.`);
      }
      if (!pool.active) {
        return fail("set", `Pool ${opts.pair} is inactive`);
      }

      // Resolve tokens
      const tokens = resolveTokenIds(pool, opts.side);

      // Enforce max order size
      if (isStxToken(tokens.tokenIn) && opts.amount > MAX_ORDER_STX) {
        return fail("set", `Max order size is ${MAX_ORDER_STX} STX`);
      }
      if (isSbtcToken(tokens.tokenIn) && opts.amount > MAX_ORDER_SBTC) {
        return fail("set", `Max order size is ${MAX_ORDER_SBTC} sBTC`);
      }

      // Check active order limit
      const book = loadOrderBook();
      const activeCount = book.orders.filter(o => o.status === "active").length;
      if (activeCount >= MAX_ACTIVE_ORDERS) {
        return blocked("set", { activeOrders: activeCount }, `Max ${MAX_ACTIVE_ORDERS} active orders. Cancel some first.`);
      }

      // Create order
      const now = new Date();
      const order: LimitOrder = {
        orderId: book.nextId,
        pair: opts.pair,
        poolId: pool.pool_id,
        side: opts.side,
        targetPrice: opts.price,
        amount: opts.amount,
        slippage: opts.slippage,
        status: "active",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + expiryMs).toISOString(),
        tokenIn: tokens.tokenIn,
        tokenOut: tokens.tokenOut,
        tokenInDecimals: tokens.tokenInDecimals,
        tokenOutDecimals: tokens.tokenOutDecimals,
      };

      book.orders.push(order);
      book.nextId++;
      saveOrderBook(book);

      success("set", {
        orderId: order.orderId,
        pair: order.pair,
        side: order.side,
        targetPrice: order.targetPrice,
        amount: order.amount,
        slippage: order.slippage,
        expires: order.expiresAt,
        tokenIn: order.tokenIn,
        tokenOut: order.tokenOut,
      });
    } catch (e: any) {
      fail("set", e.message);
    }
  });

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("Show all orders with status")
  .option("--status <status>", "Filter by status (active, filled, cancelled, expired, error)")
  .action(async (opts) => {
    try {
      const book = loadOrderBook();
      let orders = book.orders;

      if (opts.status) {
        orders = orders.filter(o => o.status === opts.status);
      }

      const summary = {
        total: orders.length,
        active: orders.filter(o => o.status === "active").length,
        filled: orders.filter(o => o.status === "filled").length,
        cancelled: orders.filter(o => o.status === "cancelled").length,
        expired: orders.filter(o => o.status === "expired").length,
        errors: orders.filter(o => o.status === "error").length,
      };

      success("list", {
        summary,
        orders: orders.map(o => ({
          orderId: o.orderId,
          pair: o.pair,
          side: o.side,
          targetPrice: o.targetPrice,
          amount: o.amount,
          status: o.status,
          createdAt: o.createdAt,
          expiresAt: o.expiresAt,
          fillData: o.fillData ?? null,
          errorMessage: o.errorMessage ?? null,
          lastSkipReason: o.lastSkipReason ?? null,
          lastSkipAt: o.lastSkipAt ?? null,
        })),
      });
    } catch (e: any) {
      fail("list", e.message);
    }
  });

// ── cancel ────────────────────────────────────────────────────────────────────

program
  .command("cancel <id>")
  .description("Cancel a pending order by ID")
  .action(async (idStr: string) => {
    try {
      const id = parseInt(idStr);
      if (isNaN(id)) return fail("cancel", "Order ID must be a number");

      const book = loadOrderBook();
      const order = book.orders.find(o => o.orderId === id);
      if (!order) return fail("cancel", `Order #${id} not found`);
      if (order.status !== "active") {
        return fail("cancel", `Order #${id} is ${order.status}, cannot cancel`);
      }

      order.status = "cancelled";
      saveOrderBook(book);

      success("cancel", {
        orderId: id,
        pair: order.pair,
        side: order.side,
        targetPrice: order.targetPrice,
        amount: order.amount,
      });
    } catch (e: any) {
      fail("cancel", e.message);
    }
  });

// ── run ───────────────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Check active orders against pool prices, execute triggers")
  .option("--confirm", "Execute swaps on-chain (without this flag, dry-run only)")
  .option("--wallet-password <pw>", "Wallet password for keystore decryption (or set AIBTC_WALLET_PASSWORD)")
  .action(async (opts) => {
    try {
      const book = loadOrderBook();
      const now = new Date();
      const dryRun = !opts.confirm;

      // Phase 1: Expire old orders
      let expiredCount = 0;
      for (const order of book.orders) {
        if (order.status === "active" && new Date(order.expiresAt) <= now) {
          order.status = "expired";
          expiredCount++;
        }
      }
      if (expiredCount > 0) {
        saveOrderBook(book);
        log(`Expired ${expiredCount} order(s)`);
      }

      // Phase 2: Check active orders
      const active = book.orders.filter(o => o.status === "active");
      if (active.length === 0) {
        return success("check", { checked: 0, triggered: 0, expired: expiredCount, message: "No active orders" });
      }

      let triggered = 0;
      let skipped = 0;
      let closestOrder: { orderId: number; distance: string } | null = null;
      let closestDist = Infinity;

      // Process orders one at a time (sequential, no race conditions)
      for (const order of active) {
        try {
          log(`Checking order #${order.orderId}: ${order.pair} ${order.side} @ ${order.targetPrice}`);

          const { price: currentPrice } = await getActiveBinPrice(order.poolId);

          // Calculate distance to target
          const priceDiff = Math.abs(currentPrice - order.targetPrice);
          const distPct = (priceDiff / order.targetPrice) * 100;

          if (distPct < closestDist) {
            closestDist = distPct;
            closestOrder = { orderId: order.orderId, distance: `${distPct.toFixed(2)}%` };
          }

          // Check trigger condition
          const shouldTrigger =
            (order.side === "buy" && currentPrice <= order.targetPrice) ||
            (order.side === "sell" && currentPrice >= order.targetPrice);

          if (!shouldTrigger) {
            log(`  → Not triggered. Current: ${currentPrice}, Target: ${order.targetPrice}, Distance: ${distPct.toFixed(2)}%`);
            continue;
          }

          log(`  → TRIGGERED! Current: ${currentPrice}, Target: ${order.targetPrice}`);

          // Get wallet
          let stxPrivateKey: string;
          let senderAddress: string;
          try {
            const pwd = opts.walletPassword ?? process.env.AIBTC_WALLET_PASSWORD ?? "";
            const wallet = await getWalletKeys(pwd);
            stxPrivateKey = wallet.stxPrivateKey;
            senderAddress = wallet.stxAddress;
          } catch (e: any) {
            order.status = "error";
            order.errorMessage = `Wallet error: ${e.message}`;
            saveOrderBook(book);
            log(`  → Wallet error: ${e.message}`);
            continue;
          }

          // Balance check — skip this cycle if insufficient (order stays active for next run)
          try {
            if (isStxToken(order.tokenIn)) {
              const balance = await getStxBalance(senderAddress);
              const needed = order.amount + (TX_FEE_ESTIMATE / 1e6);
              if (balance < needed) {
                const reason = `Insufficient balance: ${balance.toFixed(4)} STX, need ${needed.toFixed(4)} STX`;
                log(`  → ${reason} — skipping`);
                order.lastSkipReason = reason;
                order.lastSkipAt = new Date().toISOString();
                saveOrderBook(book);
                skipped++;
                continue;
              }
            }
          } catch (e: any) {
            log(`  → Balance check failed: ${e.message}, proceeding anyway`);
          }

          // Execute swap
          try {
            // Resolve symbols from pair (e.g., "STX-sBTC" → "STX", "sBTC")
            const pairParts = order.pair.split("-");
            const tokenInSymbol = order.side === "sell" ? pairParts[0] : pairParts[1];
            const tokenOutSymbol = order.side === "sell" ? pairParts[1] : pairParts[0];

            const result = await executeSwap({
              tokenInSymbol,
              tokenOutSymbol,
              amountHuman: order.amount,
              senderAddress,
              stxPrivateKey,
              slippagePct: order.slippage,
              dryRun,
            });

            order.status = "filled";
            delete order.lastSkipReason;
            delete order.lastSkipAt;
            order.fillData = {
              txId: result.txId,
              fillPrice: currentPrice,
              filledAt: new Date().toISOString(),
              explorerUrl: result.explorerUrl,
            };
            saveOrderBook(book);
            triggered++;

            success("execute", {
              orderId: order.orderId,
              pair: order.pair,
              side: order.side,
              fillPrice: currentPrice,
              targetPrice: order.targetPrice,
              amount: order.amount,
              txId: result.txId,
              explorerUrl: result.explorerUrl,
              dryRun,
            });

            // Only execute ONE order per cycle
            break;
          } catch (e: any) {
            order.status = "error";
            order.errorMessage = `Swap failed: ${e.message}`;
            saveOrderBook(book);
            fail("execute", `Order #${order.orderId} swap failed: ${e.message}`);
            continue;
          }
        } catch (e: any) {
          log(`  → Error checking order #${order.orderId}: ${e.message}`);
          continue;
        }
      }

      // If no trigger happened, emit summary
      if (triggered === 0) {
        success("check", {
          checked: active.length,
          triggered: 0,
          skipped,
          expired: expiredCount,
          closest: closestOrder,
          dryRun,
        });
      }
    } catch (e: any) {
      fail("run", e.message);
    }
  });

// ── install-packs ─────────────────────────────────────────────────────────────

program
  .command("install-packs")
  .description("Install required npm dependencies")
  .action(async () => {
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
      log(`Installing: ${deps.join(", ")}`);
      execSync(`bun add ${deps.join(" ")}`, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: path.resolve(__dirname),
      });
      success("install-packs", { installed: deps });
    } catch (e: any) {
      fail("install-packs", `Install failed: ${e.message}`);
    }
  });

// ── Parse & run ───────────────────────────────────────────────────────────────

program.parse(process.argv);
