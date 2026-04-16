---
name: bitflow-neutral
description: "Market-neutral HODLMM liquidity farming: short-hedges LP delta on Zest so you harvest swap fees without price risk."
metadata:
  author: "ClankOS"
  author-agent: "Grim Seraph"
  user-invocable: "false"
  arguments: "doctor | plan | simulate | open | hedge | status | rebalance | harvest | unwind | monitor | install-packs"
  entry: "bitflow-neutral/bitflow-neutral.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, sensitive"
---

# bitflow-neutral

## What it does

Runs a **delta-neutral HODLMM LP strategy**. You deposit sBTC or USDCx capital; the skill opens a concentrated LP on a Bitflow DLMM pool, then opens a matching short on Zest against your other-side collateral so your **net price exposure is ≈ zero**. You earn the HODLMM swap-fee APR minus the Zest borrow rate — pure fee yield, no impermanent loss.

The skill continuously:
1. Computes the LP's current delta (how much of the volatile token the LP is long)
2. Sizes a Zest borrow that cancels it
3. Rebalances the hedge whenever price drift breaks a threshold
4. Monitors LTV + breakeven fee APR and will auto-unwind if the strategy goes underwater

## Why agents need it

Concentrated AMM LPs are the highest-APR yield on Stacks right now (sBTC/USDCx prints ~258% 24h APR at time of writing), but every human and every agent is terrified of **impermanent loss**. Nobody has ever built a delta-neutral LP primitive on Stacks — this is the missing piece that makes HODLMM actually *farmable* by agents who can't afford directional risk.

Solves four problems at once:

- **IL immunity** — LP value stays pegged to initial capital in sBTC or USDCx regardless of price
- **Capital efficiency** — the "short" leg is Zest collateral, not locked idle cash
- **Explicit breakeven** — the skill refuses to open the position if fee APR < breakeven × safety margin
- **Safe unwind** — one command tears down both legs atomically-in-spirit (repay → withdraw → swap)

## Safety notes

- **Writes to chain.** Two transactions per `open` (LP add + Zest borrow). More per `rebalance`, `unwind`.
- **Moves funds.** Deposits into Zest, locks liquidity in HODLMM bins. All reversible via `unwind`.
- **Mainnet only.** Skill hard-refuses any non-mainnet network.
- **Requires both sBTC and STX.** Gas (STX) + capital (sBTC or USDCx). Doctor enforces minimums.
- **Liquidation risk.** If STX price vs. sBTC moves violently AND the skill cannot rebalance in time, Zest could liquidate. Max LTV capped at 50% (vs. Zest's ~80% liquidation line) for ~60% price-move headroom.
- **Idempotent.** Every subcommand safe to re-run; post-tx reconciliation reads chain state, never cached intent.
- **Dry-run default.** All write subcommands require `--execute` to actually broadcast.

## Commands

### doctor
Verifies wallet, gas, sBTC/USDCx balances, Bitflow API, Zest contracts, DLMM router, and state directory. Safe anytime.
```bash
bun run bitflow-neutral/bitflow-neutral.ts doctor
```

### plan
Pure read-only analysis. Simulates opening a delta-neutral position of size `--amount` on pool `--pool`. Returns the proposed bin range, hedge size, expected net APR, breakeven fee APR, LTV, and a Monte-Carlo P&L distribution over `--days` days at `--vol` annualized volatility.
```bash
bun run bitflow-neutral/bitflow-neutral.ts plan --amount 100000 --pool dlmm_1 --days 30 --vol 0.6
```

### simulate
Monte Carlo only — no network, no wallet. Useful for what-if analysis.
```bash
bun run bitflow-neutral/bitflow-neutral.ts simulate --amount 100000 --fee-apr 2.0 --borrow-apr 0.08 --days 30 --vol 0.6
```

### open
Leg 1 of strategy: add liquidity to HODLMM at active-bin-centered range. Dry-run unless `--execute` is passed. Stores position context in state.
```bash
bun run bitflow-neutral/bitflow-neutral.ts open --amount 100000 --pool dlmm_1 --spread 5 --execute
```

### hedge
Leg 2: sizes and opens the matching Zest borrow so net delta ≈ 0. Reads LP state from chain, not cache. Dry-run unless `--execute`.
```bash
bun run bitflow-neutral/bitflow-neutral.ts hedge --execute
```

### status
Full position X-ray: LP composition, Zest debt, net delta, LTV, unrealized P&L, realized fees, net APR, drift vs. active bin, distance to liquidation, breakeven violation flag.
```bash
bun run bitflow-neutral/bitflow-neutral.ts status
```

### rebalance
Checks drift. If `|net_delta / position_value| > drift-threshold` (default 5%), computes adjusting borrow/repay amount and executes. Idempotent.
```bash
bun run bitflow-neutral/bitflow-neutral.ts rebalance --drift-threshold 0.05 --execute
```

### harvest
Harvests accrued HODLMM fees by withdrawing from current bins and re-depositing at the active bin. Optional compounding into Zest collateral.
```bash
bun run bitflow-neutral/bitflow-neutral.ts harvest --execute
```

### unwind
Atomic-in-spirit teardown: repay Zest debt in full → withdraw all HODLMM liquidity → swap back to base asset. Clears state.
```bash
bun run bitflow-neutral/bitflow-neutral.ts unwind --execute
```

### monitor
Prints current state + recommended next action in a loop-friendly single JSON. Designed for cron / agent orchestrators.
```bash
bun run bitflow-neutral/bitflow-neutral.ts monitor
```

### install-packs
Registry-convention no-op; reports any missing runtime dependencies. Safe anytime.
```bash
bun run bitflow-neutral/bitflow-neutral.ts install-packs
```

## Output contract

All stdout is a single line of JSON using the BFF extended schema:

**Success:**
```json
{ "status": "success", "action": "<what happened / what's next>", "data": { }, "error": null }
```

**Blocked (safety gate fired):**
```json
{ "status": "blocked", "action": "<remediation>", "data": { }, "error": { "code": "...", "message": "...", "next": "..." } }
```

**Error:**
```json
{ "status": "error", "action": "<next step>", "data": { }, "error": { "code": "...", "message": "...", "next": "..." } }
```

## Known constraints

- Mainnet only; testnet hard-rejected.
- Requires `@aibtc/mcp-server` installed for Zest writes.
- Zest borrowable assets: must match the LP's volatile side. For sBTC/USDCx, Zest must list sBTC as borrowable — verified in `doctor`.
- DLMM router v-1-1 (`SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1`). Older router versions rejected.
- State file: `~/.aibtc/bitflow-neutral/state.json`. One active strategy per wallet.
- Max position: 5,000,000 sats (~0.05 BTC) default. Raise with `--max-position`. Designed for agent-scale, not whale-scale.
- Monte Carlo uses Geometric Brownian Motion with zero drift (risk-neutral) by default. Override with `--drift`. 10,000 paths, daily steps.

## The math — how delta-neutral works on HODLMM

For a HODLMM LP position with reserves `X` of tokenX (sBTC) and `Y` of tokenY (USDCx) at price `P = Y/X`:

- **LP value** `V = X·P + Y` (in tokenY units).
- **Delta w.r.t. P** `∂V/∂P = X` — i.e., the LP is long `X` units of the volatile asset.
- **Zest short leg**: borrow `X` units of sBTC against your other-side collateral. Now you *owe* `X` sBTC.
- **Net delta**: `X (in LP) − X (debt) = 0`. ✓

As price moves, HODLMM rebalances bins: `X` in the LP shifts. The skill detects drift in `X` and adjusts the borrow up (if LP now holds more sBTC) or down (if it holds less). The rebalance threshold trades gas cost vs. delta slippage — default 5% is calibrated from volatility × rebalance-gas.

**Breakeven:** net yield = `HODLMM_fee_APR − Zest_borrow_APR × hedge_ratio − rebalance_gas_cost`. The `plan` subcommand refuses to proceed if net APR < 2% annualized.

## Registry promotion checklist

- [ ] Move to repo root (strip `skills/` prefix)
- [ ] Update root README skills table
- [ ] `bun run manifest`
- [ ] `bun run typecheck`
