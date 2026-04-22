---
name: hodlmm-predator
description: "Just-in-time HODLMM liquidity — ambush whale swaps in the mempool, deploy razor-thin LP into the exact bin they will cross, capture a disproportionate share of their fee, retreat."
metadata:
  author: "ClankOS"
  author-agent: "Grim Seraph"
  user-invocable: "false"
  arguments: "doctor | calibrate | hunt | arm | simulate | strike | retreat | autopilot | ledger | abort"
  entry: "hodlmm-predator/hodlmm-predator.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, sensitive, infrastructure"
---

# hodlmm-predator

**Just-In-Time (JIT) liquidity for Bitflow HODLMM — the first mempool-driven LP searcher on Stacks.**

## What it does

Watches the Stacks mempool in real time for pending HODLMM swaps. When a **whale swap** appears — a trade large enough that its fee alone covers the cost of a round-trip LP deployment — the skill:

1. **Decodes the swap** from its Clarity function args (pool, direction, size, slippage window).
2. **Projects the bin path** the swap will traverse given the pool's current active bin, bin step, and pre-swap bin liquidity.
3. **Computes the strike**: a razor-thin, single-bin LP add-liquidity tx sized to capture the maximum fraction of that swap's fee without exceeding configured risk caps.
4. **Broadcasts the strike tx** with a fee rate above the whale's, so a rational miner orders it first in the same anchor block.
5. **Retreats** the next block with `withdraw-liquidity-same-multi`, booking the captured fee as realized yield.

This is the classic Uniswap v3 JIT searcher alpha — never before ported to Stacks, never before possible at agent speed until 5-second Nakamoto blocks. It is also the **first mempool-aware skill in the BFF registry**.

## Why agents need it

A passive LP earns fees proportional to time × share-of-bin. A JIT predator earns fees proportional to **precision × share-of-moment**. On thin bins, the second number can be 10–100× the first for the same capital, for the same day, with a fraction of the impermanent-loss exposure (you are in the bin for ~1 anchor block, not ~8 hours).

Concretely, on today's HODLMM pools:

- **Passive LP** on sBTC-USDCx dlmm_2 at ±5 bins ≈ 30 bps × pool-wide daily volume × your-share-of-pool. Realistic: **150-250% APR**, but you wear 100% of the IL.
- **Predator strike** on the same pool: one 1M-sat whale swap pays 3000 sats in fees. If the strike lands in a bin with 100k sats of existing TVL and you deposit 500k sats, your share of bin = 83%, fee capture ≈ **2490 sats on 500k deployed for 1 block — annualized that is a theoretical rate orders of magnitude higher**, bounded only by whale-swap frequency.

The skill closes the gap between "humans click fast" and "agents click the *instant* the mempool updates." No human has ever placed JIT liquidity on Stacks. This is a category-defining capability for the agent economy.

**Crucially, JIT is positive-sum for swappers.** The whale's swap executes at a *better* effective price because the bin they cross now holds more depth. JIT is **not** a sandwich — there is no front-run buy + back-run sell of the victim's position. The predator adds liquidity, the swapper benefits from tighter execution, the predator earns a share of the fee the swapper already agreed to pay. Everyone wins except the passive LPs who didn't show up at the right bin at the right moment.

## Safety notes

- **Writes to chain.** Each cycle is 2 txs (add-liquidity + withdraw-liquidity). A failed strike still costs gas.
- **Moves funds.** Capital is locked in a HODLMM bin for roughly one anchor block per strike. If the withdraw tx fails (e.g., network partition, nonce conflict), capital is *temporarily* stuck in an LP position — recoverable by re-running `retreat` or any HODLMM exit skill.
- **Mainnet-only.** No testnet HODLMM deployment.
- **Requires funds.** Strike capital + gas reserve. Never use funds you need liquid for other obligations.
- **Hard spend caps.** Default `max_strike_sats=10_000` (≈ $0.70), `max_daily_strikes=5`, `max_daily_loss_sats=5_000`. The skill will refuse to strike past any cap regardless of expected profit.
- **Pool allowlist required.** The skill will not strike on any pool unless explicitly allowlisted. This prevents an exotic-pool exploit from draining the wallet.
- **Mempool races are adversarial.** Other predators exist on other chains; on Stacks this skill is the first, but assume competition appears. The `ledger` command tracks win rate; if it drops below breakeven the skill auto-pauses.
- **No private-key handling.** The skill emits MCP call descriptors — the AIBTC MCP harness signs and broadcasts. Keystore passwords never touch this process.

## Commands

All output is flat JSON to stdout. BFF-extended shape: `{ status, action, data, error }`.

### doctor

Preflight everything before your first hunt. Safe to run anytime.

```bash
bun run hodlmm-predator/hodlmm-predator.ts doctor
```

Checks:
- Stacks mempool endpoint reachable
- Bitflow pools + bins endpoints reachable
- MCP wallet installed and unlocked (or returns `blocked` with install hint)
- Wallet gas reserve ≥ `min_gas_ustx`
- Wallet strike capital ≥ `max_strike_sats`
- Pool allowlist validity (every allowlisted pool exists + is active)
- Local ledger + state dir writable
- Clock drift vs. Hiro API (mempool timing requires ≤ 2s drift)

### calibrate

Analyze the recent history of an allowlisted pool and suggest whale threshold, strike sizing, and expected profit per strike. Read-only — no tx broadcast.

```bash
bun run hodlmm-predator/hodlmm-predator.ts calibrate --pool-id dlmm_2 --lookback-days 7
```

Outputs:
- Swap-size distribution (p50, p90, p99)
- Recommended `min_swap_size_sats` (default = p95)
- Median bin TVL — drives strike sizing
- Historical whale frequency (strikes/day)
- Backtest: if the predator had struck every whale in the window, realized vs. projected PnL

### hunt

Poll the mempool and stream detections as JSONL. Non-writing. Run this first to watch activity before enabling strikes.

```bash
bun run hodlmm-predator/hodlmm-predator.ts hunt --pools dlmm_2,dlmm_6 --min-swap-size-sats 500000 --max-iterations 60
```

Each line emitted is a `SkillOutput` with `action: "detect"` and the decoded swap. `--emit-plan` also chains `arm` per detection.

### arm

Given a detected swap (by `--tx-id` or piped `--stdin`), compute a strike plan. Non-writing. Output includes the MCP payload ready for `strike`.

```bash
bun run hodlmm-predator/hodlmm-predator.ts arm --tx-id 0xabc... --max-strike-sats 500000
```

Fails with `blocked` if:
- Expected net profit < `--min-expected-profit-sats`
- Swap is already mined (too late)
- Pool not allowlisted
- Current wallet capital < strike size
- Confidence score < `--min-confidence`

### simulate

Replay a past swap through the arm + strike + retreat logic without broadcasting. Gold for judging the skill and for the ledger.

```bash
bun run hodlmm-predator/hodlmm-predator.ts simulate --tx-id 0xee0d7ff04d4acb91541e7c4a4ac228e73420058f98836aa69dbb51d3fac99c11 --strike-sats 100000
```

Returns the counterfactual: fee captured, gas spent, net sats, round-trip return %.

### strike

Execute an armed plan. **WRITES** via MCP `call_contract` (add-liquidity-multi). Requires `--plan <path-to-plan.json>` from a prior `arm`, or `--tx-id` to re-arm inline.

```bash
bun run hodlmm-predator/hodlmm-predator.ts strike --plan /tmp/predator-plan-abc.json --execute
```

Without `--execute`, returns the MCP payload for review. With `--execute`, emits the MCP payload to stdout where the agent harness consumes it.

### retreat

Withdraw the open strike position + book realized PnL into the ledger. **WRITES.**

```bash
bun run hodlmm-predator/hodlmm-predator.ts retreat --plan-id jit-abc123 --execute
```

### autopilot

Full closed loop: hunt → arm → strike → retreat, under every safety rail. The agent's hands-off mode.

```bash
bun run hodlmm-predator/hodlmm-predator.ts autopilot --pools dlmm_2,dlmm_6 --max-strike-sats 200000 --max-daily-strikes 5 --max-daily-loss-sats 5000
```

Exits automatically on any of: daily strike cap hit, daily loss cap hit, three consecutive aborted strikes, external `SIGINT`.

### ledger

Summarize strike history. Read-only.

```bash
bun run hodlmm-predator/hodlmm-predator.ts ledger --window 30d
```

Reports: total strikes, win rate, gross fee captured, total gas, net PnL, avg roi per strike, current open positions.

### abort

Emergency: retreat all open positions immediately. **WRITES.** Use if the skill hangs mid-autopilot, if the network misbehaves, or if you need capital back NOW.

```bash
bun run hodlmm-predator/hodlmm-predator.ts abort --execute
```

## Output contract

Every command emits a single JSON object to stdout. Success shape:

```json
{
  "status": "success",
  "action": "arm",
  "data": {
    "plan_id": "jit-f1a9c0",
    "target": {
      "swap_tx_id": "0xee0d...",
      "pool_id": "dlmm_2",
      "direction": "x_for_y",
      "swap_size_raw": "964537051",
      "swap_size_display": "9645.37051 STX",
      "fee_bps": 30,
      "total_fee_est_sats": 2893,
      "detected_at": "2026-04-22T20:45:12Z"
    },
    "strike": {
      "pool_contract": "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-1",
      "target_bin_offset": 0,
      "capital_sats": 100000,
      "expected_share_of_bin": 0.42,
      "expected_fee_capture_sats": 1215,
      "expected_gas_sats": 180,
      "expected_net_sats": 1035,
      "expected_roi_pct": 1.04,
      "confidence": 0.81
    },
    "mcp_payload": { "/* ... */": "ready for MCP harness" },
    "retreat_deadline_block": 178904,
    "valid_until": "2026-04-22T20:45:42Z"
  },
  "error": null
}
```

Blocked (safety gate fired):

```json
{
  "status": "blocked",
  "action": "arm",
  "data": { "gate": "min_expected_profit", "expected_net_sats": 40, "threshold_sats": 200 },
  "error": null
}
```

Error (failure, not a gate):

```json
{ "error": "descriptive message" }
```

## Math model

Given a detected whale swap on pool *P*:

- **Input size** `S` (raw units of input token)
- **Pool fee** `f_bps` (from `x_total_fee_bps`)
- **Current active bin** `b0`, **bin step** `Δ` (bps), **direction** `d ∈ {+1, -1}`

For a "simple range" swap the swap walks bins `b0, b0+d, b0+2d, ...` consuming reserves until either:
- `S` is exhausted, or
- `max-steps` reached, or
- slippage hits `min-dy`

Given pre-swap bin liquidities `L_0, L_1, …`, the predator computes which bin will be the **primary cross bin** — the bin in which the majority of `S` gets swapped. Call this bin `b*`.

Strike deposit of `C` sats into bin `b*` (after the swap, but same block — that is, added to the bin state that existed before the swap tx is processed):

- **Our share of bin**: `σ = C / (L_{b*} + C)`
- **Portion of swap crossing b***: `ρ` (projected from size walk)
- **Expected fee capture**: `F_exp = S × f_bps × ρ × σ`
- **Gas cost**: `G` (add + withdraw ≈ 180 sats-equivalent at normal fee rates)
- **Expected net**: `N_exp = F_exp − G − slip_penalty − IL_expected`

The predator strikes iff `N_exp ≥ min_expected_profit_sats` AND safety rails all pass.

Confidence `c` combines (a) freshness of mempool state, (b) age of detected tx, (c) historical outcome of similar swaps in the ledger, (d) distance of `b*` from `b0` (farther = more uncertainty). Strikes require `c ≥ --min-confidence` (default 0.70).

## Composition with other Clank skills

- **`hodlmm-advisor`** — choose the pool allowlist from ranked-by-volume pools before `calibrate`.
- **`hodlmm-flow`** (Clank, merged #257) — flow-intel feeds the confidence score when sizing.
- **`hodlmm-deadweight`** (Clank, #256) — if a bin shows up as deadweight in advisor, it is a better predator target (thin = high σ).
- **`bitflow-neutral`** (Clank, #464) — predator earnings auto-fund the delta-neutral LP leg in a longer-running agent.
- **`bitflow-limit-order`** (Clank, merged #277) — shares wallet and MCP plumbing; predator is the inverse (take fee) of limit-order (pay fee).

## Known constraints

- **Mempool visibility only.** Private-mempool / Flashbots-style relays don't exist on Stacks. Every predator sees the same mempool. When this skill is adopted, expect competition and rising strike fees.
- **Anchor-block ordering.** Stacks Nakamoto orders by fee-rate within a block. Strikes with fee < whale's fee lose the race. The skill auto-escalates fee-rate by `fee_premium_bps` above the whale.
- **Non-atomic round-trip.** Add-liquidity and withdraw are two separate txs. If the withdraw is delayed more than `auto_retreat_blocks` (default 3), the skill raises a `blocked: retreat_overdue` and surfaces for human triage.
- **Variable fees.** HODLMM supports variable fee multipliers; the skill reads `x_variable_fee` + `y_variable_fee` and adds them to `x_total_fee_bps`. Pools with dynamic fee managers may update mid-strike; the skill re-fetches pool state at `arm` time.
- **Kick-in volume floor.** Pools with <$10k daily volume rarely produce whale swaps; `hunt` will return `status: success` with zero detections.
- **First-mover game.** The profit frontier for JIT on Stacks is currently wide open. It will compress once competition arrives. The skill's `calibrate` command tracks this frontier weekly.

## Proof

Run `simulate --tx-id <any past whale swap>` to see the counterfactual strike without spending a sat. A live mainnet strike tx will be linked in the PR description once capital is provisioned.
