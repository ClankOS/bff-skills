---
name: hodlmm-advisor-agent
skill: hodlmm-advisor
description: "Advisory agent that ranks Bitflow HODLMM pools by risk-adjusted yield and generates LP entry plans with strategy, bin range, and capital split recommendations."
---

# Agent Behavior — HODLMM Advisor

## Decision order

1. Run `doctor` first. If any check fails, stop and surface the API connectivity issue.
2. Run `best-pools --limit 5 --min-liquidity 10000` to identify candidate pools.
3. For each pool with `verdict: enter`, run `entry-plan` to get deployment specifics.
4. Only proceed to `bitflow add-liquidity-simple` if `plan.verdict` is exactly `"Deploy now"`.
5. For open positions, run `pool-summary` every 4–12 hours to monitor regime changes.

## Guardrails

- **Never act on `verdict: avoid` or `regime: crisis`** — these are hard blocks regardless of APR
- **Never pass `entry-plan` output to `bitflow` without checking `plan.verdict` first**
- **Use `--min-liquidity 10000`** for real deployments — low-TVL pools have unreliable metrics
- **Re-run `best-pools` immediately before executing** — pool state can change between calls
- This skill is advisory only — it does not verify wallet balances or STX gas availability

## On error

- Log the full error payload
- Do not retry silently — surface the error with a suggested next action
- If doctor fails, check network connectivity before any other action

## On success

- For `best-pools`: present ranked list, highlight `verdict: enter` pools for follow-up
- For `entry-plan`: confirm `plan.verdict` before acting; present `binRange` and `strategy` to user
- For `pool-summary`: flag any regime worsening (e.g. calm → elevated → crisis)

## Regime change actions

| Regime change | Action |
|---|---|
| calm → elevated | Widen bin range; run `hodlmm-risk assess-pool` for secondary confirmation |
| elevated → crisis | Exit position via `bitflow withdraw-liquidity-simple` |
| `reserveImbalanceRatio > 0.8` | Position likely out of range — consider exit |
| `activePositionPct < 0.15` or `> 0.85` | Price drifting away from range — monitor closely |

## Integration with other skills

- Use `hodlmm-risk assess-pool` for secondary risk confirmation when regime is `elevated`
- Use `bitflow add-liquidity-simple` to execute after `verdict: "Deploy now"`
- Use `bitflow withdraw-liquidity-simple` to exit when `pool-summary` shows crisis
