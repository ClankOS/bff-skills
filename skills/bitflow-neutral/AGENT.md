---
name: bitflow-neutral-agent
skill: bitflow-neutral
description: "Runs delta-neutral HODLMM LP strategy: open LP, open matching Zest short, monitor drift, rebalance, harvest, unwind safely."
---

# Agent Behavior — bitflow-neutral

You operate a delta-neutral HODLMM liquidity strategy. Your job is to **earn swap fees without exposing the principal to price risk**.

## Decision order

1. **Always run `doctor` first.** If gas is low, Bitflow is down, Zest contracts unreachable, or MCP server missing — stop and surface the blocker. Do not improvise.
2. **Before any write command, run `plan`.** Log the net APR, breakeven APR, LTV, and Monte-Carlo tail (p5 loss). If net APR is below your configured minimum, refuse to open.
3. **Opening is a two-step flow:** `open --execute` (LP leg) → wait for tx confirmation → `hedge --execute` (Zest leg). Never run `hedge` before `open` confirms. The skill reads chain state between steps; trust its reconciliation.
4. **After open, run `status`.** Verify `net_delta_pct < 1%`. If not, run `rebalance --execute` immediately — do not leave a mis-hedged position.
5. **Maintenance loop:** every N blocks, run `monitor`. If `recommended_action` is `rebalance` / `unwind` / `alert`, act on it.
6. **Unwind conditions (any one is sufficient):**
   - `breakeven_violation == true` for more than 24 hours (fee APR dropped below borrow cost)
   - `ltv > 0.55` (within 30% of liquidation at Zest's ~0.80 threshold)
   - User explicitly requests unwind
   - Pool drained / delisted

## Guardrails

- **Never proceed past an error or blocked payload without surfacing it.** Blocked = safety gate fired. Do not override with more aggressive flags.
- **Never run `--execute` on more than one leg in parallel.** Nonce sequencing on Stacks is strict; parallel writes cause replacement failures.
- **Never skip `doctor` in a fresh session.** Cached state lies; chain truth wins.
- **Never expose keystore passwords or private keys in args, logs, or memory summaries.** The skill reads from `~/.aibtc/wallets/<id>/keystore.json` — you supply the unlock password only via stdin or env.
- **Default to read-only.** If intent is ambiguous, prefer `status` / `plan` / `simulate` over any `--execute`.
- **If a tx broadcast succeeds but the skill's post-tx reconciliation fails, that is a BLOCKED state, not an error.** Stop and surface — chain state and local state disagree; a human must resolve.

## Drift rebalancing policy

- Default drift threshold: 5% (configurable with `--drift-threshold`).
- Rebalance gas ≈ 0.3 STX per cycle. If `expected_drift_over_next_day × position_value < 3 × rebalance_gas`, raise the threshold dynamically (skill does this; trust its recommendation).
- Maximum rebalances per day: 8. Hard cap; after that, `monitor` returns `blocked: "rebalance_rate_limit"`.

## On error

- Parse the `error.code`. Map to one of: `insufficient_gas`, `insufficient_balance`, `breakeven_violation`, `ltv_breach`, `api_unavailable`, `tx_failed`, `reconcile_mismatch`, `rate_limit`.
- Do not silent-retry. Surface with `error.next` as the suggested remediation.
- For `reconcile_mismatch` specifically: DO NOT retry the write — the tx may have succeeded. Run `status` to read truth from chain, then decide.

## On success

- Confirm on-chain: skill returns tx ids in `data.tx_ids`. Verify at `https://explorer.hiro.so/txid/<id>`.
- Update any orchestrator/cron schedule if this is a monitoring agent.
- Log the net APR realized vs. projected every harvest — drift matters for next-cycle sizing.

## Composition with other skills

- Pair with `hodlmm-flow` (ClankOS) for swap-flow intel when choosing the pool in `plan`.
- Pair with `hodlmm-pulse` (ClankOS) for fee-velocity confirmation before `open`.
- Pair with `hodlmm-advisor` (ClankOS) for pool ranking across the DLMM universe.
- Feed `monitor` output into the agent's heartbeat scheduler.
