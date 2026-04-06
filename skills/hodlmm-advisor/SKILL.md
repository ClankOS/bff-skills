---
name: hodlmm-advisor
description: "HODLMM LP advisor for Bitflow — ranks all active pools by risk-adjusted score, generates entry plans with bin range and strategy recommendations, and summarizes individual pool health. Read-only; no wallet required."
metadata:
  author: "ghislo749"
  author-agent: "Grim Seraph"
  user-invocable: "false"
  arguments: "doctor | best-pools | pool-summary | entry-plan"
  entry: "hodlmm-advisor/hodlmm-advisor.ts"
  requires: ""
  tags: "l2, defi, read-only, mainnet-only"
---

# HODLMM Advisor

LP advisory layer for Bitflow HODLMM (DLMM) concentrated liquidity pools.

## What it does

Answers the core question: **"Where and how should I deploy liquidity right now?"**

Fetches live data from Bitflow's public API, computes a risk-adjusted score for every active HODLMM pool, and returns ranked recommendations with verdicts (`enter` / `wait` / `avoid`). For a selected pool, generates a full entry plan: strategy shape (spot / curve / bid-ask), bin range, estimated fee APR, capital split, and IL warning.

## Why agents need it

Agents managing HODLMM LP positions need a decision layer before acting. This skill provides:
- **Pool ranking** — which pool has the best risk-adjusted yield right now
- **Entry planning** — exactly how to deploy capital (which bins, which strategy, how to split tokens)
- **Health monitoring** — a single-call snapshot of any pool's regime and risk

## Safety notes

- **Read-only** — never submits transactions or moves funds
- **No wallet required** — safe to call from any agent without authentication
- **Mainnet-only** — Bitflow HODLMM is mainnet-only

## Commands

### doctor
Checks connectivity to all three Bitflow API endpoints used by this skill.

```bash
bun run skills/hodlmm-advisor/hodlmm-advisor.ts doctor
```

### best-pools
Fetches all active HODLMM pools, scores each by risk-adjusted yield, and returns a ranked list with verdicts.

```bash
bun run skills/hodlmm-advisor/hodlmm-advisor.ts best-pools [--limit 5] [--min-liquidity 10000]
```

Options:
- `--limit <n>` — max pools to return (default: 5)
- `--min-liquidity <usd>` — filter pools below this TVL in USD (default: 0)

### pool-summary
Compact health snapshot of a single pool: tokens, APR, TVL, bin stats, regime, score, verdict.

```bash
bun run skills/hodlmm-advisor/hodlmm-advisor.ts pool-summary --pool-id dlmm_3
```

### entry-plan
Full LP entry plan for a pool: strategy, bin range, capital split, IL warning, plain-English verdict.

```bash
bun run skills/hodlmm-advisor/hodlmm-advisor.ts entry-plan --pool-id dlmm_3 --amount-sats 100000
```

Options:
- `--pool-id` (required)
- `--amount-sats` (required) — capital in sats
- `--strategy` (optional) — override auto-selection: `spot` | `curve` | `bid-ask`

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{ "status": "success", "network": "mainnet", "timestamp": "...", ... }
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Risk scoring

**Volatility score (0–100):** bin density spread (40%) + USD-normalised reserve imbalance (30%) + active bin concentration penalty (30%)

**Regimes:**
- `calm` (0–30) — optimal LP conditions
- `elevated` (31–60) — acceptable, widen range
- `crisis` (61–100) — IL risk dominates, avoid new entries

**Yield signal:** `apr24h` (actual realized 24h fees, annualized). Reflects live trading volume, not just the protocol fee setting. Falls back to 10% of full APR if `apr24h` is unavailable.

**Score formula:** `log-normalized(apr24h) / (1 + binSpread × (1 + reserveImbalanceRatio))` — capped at 100.

**Verdict thresholds (consistent across all commands):**
- `score ≥ 60` → `enter`
- `score ≥ 30` → `wait`
- `score < 30` or `regime === crisis` → `avoid`

**Strategy auto-selection:**
- `spot` — calm regime, balanced reserves
- `curve` — skewed reserves (>60% imbalance)
- `bid-ask` — crisis regime or high volatility

**`entry-plan` verdict — when "Deploy now" is emitted:**
- Calm regime + APR > 20%
- Elevated regime + score ≥ 70 + reserve imbalance ≤ 30% + APR > 20%

An agent should only execute liquidity deployment when `plan.verdict === "Deploy now"`.

## Known constraints

- Bitflow HODLMM APIs are public during beta (no API key needed)
- All pool data is live; no caching
- `entry-plan` capital split is based on current pool composition and may shift before execution
- `skippedPools` in `best-pools` output indicates pools that could not be evaluated (API errors). If non-zero, results may be incomplete — re-run or check individual pools with `pool-summary`
