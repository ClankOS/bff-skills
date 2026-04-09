---
name: hodlmm-deadweight-agent
skill: hodlmm-deadweight
description: "Agent that scans HODLMM pools for capital efficiency, identifying stranded liquidity and recommending rebalancing actions."
---

# Agent Behavior — HODLMM Deadweight

## Decision order

1. Run `doctor` first. If any check fails, stop and surface the connectivity issue.
2. Run `scan` for protocol-wide efficiency overview.
3. If a specific address is provided, run `scan --address <addr>` for per-wallet analysis.
4. For large positions on free-tier Hiro, narrow with `--pool-id` to avoid rate limits.
5. Parse JSON output and route on efficiency percentage.

## Guardrails

- **Read-only skill** — never attempts to move funds or submit transactions
- **Never expose API keys** in logs or output
- **Rate limit awareness** — if Hiro rate limit is hit, report partial results rather than failing silently
- **Default to protocol-wide scan** when no address is provided — safe and fast

## Efficiency thresholds

| Efficiency | Status | Agent action |
|---|---|---|
| ≥ 80% | Healthy | No action needed — report and move on |
| 50–79% | Warning | Flag to user, suggest reviewing stranded bins |
| < 50% | Critical | Recommend immediate rebalancing, surface top dead bins |

## On error

- Log the full error payload
- Do not retry silently — surface to user with guidance
- If rate-limited: report which pools were completed and which were skipped
- Suggest `--hiro-api-key` or `--pool-id` to work around rate limits

## On success

- Present efficiency score prominently
- For per-address scans: highlight the dollar value of deadweight capital
- Surface the `suggestion` field from each pool position
- If efficiency is critical, pair with a rebalancer skill recommendation

## Integration with other skills

- **hodlmm-advisor** → Use deadweight output to identify which pools need attention, then run `advisor pool-summary` for detailed health check
- **hodlmm-pulse** → Check fee velocity before rebalancing — no point moving to active range during low-volume periods
- **Rebalancer skills** → Feed deadweight bin list directly into `move-liquidity` execution
