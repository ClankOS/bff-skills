---
name: hodlmm-shadow
description: "Whale-mirror autopilot for Bitflow HODLMM. Snapshots a target wallet's live concentrated-liquidity footprint (bin distribution, range, concentration), then deploys and maintains a scaled-down mirror from the agent's own sBTC/STX. Re-syncs on demand — when the target rebalances, the shadow rebalances. Budget-locked, slippage-guarded, dry-run by default."
metadata:
  author: "ClankOS"
  author-agent: "Grim Seraph (Agent #122) — SP1KVZTZCTCN9TNA1H5MHQ3H0225JGN1RJHY4HA9W | bc1qel38f4fv08c7qffwa5jl92sp5e8meuytw3u0n9"
  user-invocable: "false"
  arguments: "doctor | install-packs | scout <wallet> [--pool-id <id>] | follow <wallet> --budget <sats> [--pool-id <id>] [--max-bins <n>] [--max-slippage <pct>] [--execute] | sync [--execute] | unfollow | panic [--execute] | status"
  entry: "hodlmm-shadow/hodlmm-shadow.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, yield, hodlmm, mainnet-only, l2"
---

# HODLMM Shadow — Whale-Mirror LP Autopilot

## What it does

Picks a target Stacks wallet — a whale, a top-performing agent, a trusted KOL — and deploys a **scaled-down mirror** of their live Bitflow HODLMM (DLMM) position. Reads the target's bin distribution via `bff.bitflowapis.finance`, normalises the *shape* (bin range, relative weights, concentration), and then sizes an allocation against the agent's own budget. `sync` diffs the shadow position against the target's current footprint and emits the exact add/withdraw plan required to close the gap.

It's copy-trading, but for concentrated liquidity — a primitive no one on Stacks has yet.

## Why agents need it

Top LP strategists on HODLMM are living signal feeds. Their bin placement is strategy made visible on-chain. An autonomous agent with a modest budget can piggyback on that strategy without: (a) building an in-house bin-selection model, (b) monitoring 24/7, or (c) paying for alpha. This is the fastest way for a new agent to deploy capital on HODLMM with non-random bin selection.

## Safety notes

- **Writes on-chain.** `follow`, `sync`, and `panic` can broadcast Stacks transactions when `--execute` is passed. Default is dry-run.
- **Mainnet only.** Bitflow HODLMM does not run on testnet.
- **Budget-locked.** A follow-relationship is pinned to a `--budget` (microSat / microSTX). `sync` will never deploy more than `budget − already_deployed`. No top-ups without an explicit new `follow`.
- **Slippage-capped.** Default `--max-slippage 1%`. Any sync action whose expected price deviation exceeds the cap is skipped and logged.
- **Drift threshold.** `sync` only acts when the shadow has drifted ≥ 10% (configurable) from target shape. Prevents churn on noise.
- **Bin cap.** `--max-bins` (default 20) bounds the number of bins the shadow will occupy. Protects against targets with pathological 500-bin positions.
- **Target whitelist.** Only wallets present in `~/.aibtc/hodlmm-shadow/whitelist.json` can be followed. Must be added manually — no arbitrary follow.
- **Panic is unconditional.** `panic --execute` withdraws every bin the shadow holds, regardless of target state. Use after target compromise or market regime change.
- **No self-mirror.** Skill refuses to follow the agent's own wallet.

## Commands

### doctor
Verifies wallet readiness, Bitflow HODLMM API reachability, state directory, and sBTC/STX balances.
```bash
bun run hodlmm-shadow/hodlmm-shadow.ts doctor
```

### install-packs
Installs the npm dependencies required for signing and broadcasting.
```bash
bun run hodlmm-shadow/hodlmm-shadow.ts install-packs
```

### scout
Read-only preview of a target wallet's HODLMM footprint across all pools (or a single pool with `--pool-id`). Returns per-bin liquidity, pool-level concentration score, and estimated USD value. Never writes to state.
```bash
bun run hodlmm-shadow/hodlmm-shadow.ts scout SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR
```

### follow
Registers a target wallet as the shadow source, snapshots their current position, and emits a deployment plan (dry-run) or broadcasts it (`--execute`). Budget is pinned at follow time.
```bash
# dry-run (default)
bun run hodlmm-shadow/hodlmm-shadow.ts follow SP2C2YF... --budget 100000 --pool-id dlmm_1
# live
bun run hodlmm-shadow/hodlmm-shadow.ts follow SP2C2YF... --budget 100000 --pool-id dlmm_1 --execute
```

### sync
Diffs the shadow vs target's current shape; emits the minimum add/withdraw plan to close the gap. Skips if drift < threshold or slippage > cap.
```bash
bun run hodlmm-shadow/hodlmm-shadow.ts sync            # dry-run
bun run hodlmm-shadow/hodlmm-shadow.ts sync --execute  # broadcast
```

### unfollow
Stops syncing. Does **not** withdraw the shadow position — use `panic` for that.
```bash
bun run hodlmm-shadow/hodlmm-shadow.ts unfollow
```

### panic
Emergency full exit. Withdraws every bin the shadow holds in the followed pool. Ignores target state.
```bash
bun run hodlmm-shadow/hodlmm-shadow.ts panic --execute
```

### status
Dumps the current follow-relationship, last sync, drift, and deployed bins.
```bash
bun run hodlmm-shadow/hodlmm-shadow.ts status
```

## Output contract

All output is JSON-to-stdout matching the AIBTC skill contract:

```json
{ "status": "success" | "blocked" | "error",
  "action": "doctor" | "scout" | "follow" | "sync" | "unfollow" | "panic" | "status" | "install-packs",
  "data": { /* action-specific */ },
  "error": null | "string" }
```

## Data sources

| Source | Purpose | Endpoint |
|---|---|---|
| Bitflow HODLMM API | Pool state, active bin, bin reserves | `bff.bitflowapis.finance/api/quotes/v1/pools` and `/bins/{id}` |
| Bitflow App API | USD pricing, TVL, 24h volume | `bff.bitflowapis.finance/api/app/v1/pools/{id}` |
| Bitflow Positions API | User bin holdings | `bff.bitflowapis.finance/api/app/v1/users/{addr}/positions/{poolId}/bins` |
| Hiro Stacks API | Wallet balances, nonce | `api.mainnet.hiro.so/extended/v1/address/{addr}/balances` |
| Bitflow SDK | `prepareAddLiquidity`, `prepareWithdrawLiquidity` for HODLMM | `@bitflowlabs/core-sdk` |

## State files

- `~/.aibtc/hodlmm-shadow/state.json` — active follow-relationship, budget, deployed bins, last sync
- `~/.aibtc/hodlmm-shadow/whitelist.json` — permitted target wallets (one-per-line or JSON array)
- `~/.aibtc/hodlmm-shadow/events.jsonl` — append-only audit log (all follow/sync/panic events)

## Proof of work

Included in the PR description:
- `doctor` JSON output
- `scout` run against a live HODLMM whale wallet
- Dry-run `follow` transaction plan with actual contract address, function name, post-conditions
- Explorer link for any broadcasted tx used as proof
