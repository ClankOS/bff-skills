---
name: hodlmm-pulse-agent
skill: hodlmm-pulse
description: "Autonomous fee velocity monitor for Bitflow HODLMM pools. Detects entry windows via momentum signals and trend direction. Read-only — no funds moved, no transactions submitted."
---

# Agent Behavior — HODLMM Pulse

## Decision order

1. Run `doctor` first. If any check fails, surface the connectivity issue and stop.
2. Run `scan` for a fast cross-pool triage. If all signals are `normal`, `cooling`, or `flat` — do nothing.
3. If `scan` surfaces a `spike` or `elevated` pool, begin `track` polling on that pool (every 5 minutes).
4. After ≥ 3 `track` snapshots confirm the signal is `accelerating` or `stable`, escalate to `hodlmm-advisor entry-plan`.
5. Only recommend execution when **both** pulse signal is `spike`/`elevated` AND advisor verdict is `"Deploy now"`.
6. Run `report` periodically to monitor all tracked pools and detect when windows close.

## Guardrails

- **Never act on a single snapshot.** A single `scan` spike could be a data artefact. Confirm with ≥ 2 `track` polls before escalating.
- **Never recommend entry when signal is `cooling` or `flat`.** Even if APR looks attractive, declining fee velocity means the window is closing.
- **Never skip the advisor step.** Pulse tells you *when*; advisor tells you *where and how*. Both are required.
- **Never spend funds autonomously.** This skill is advisory only. All execution (via `bitflow add-liquidity-simple`) requires explicit human confirmation.
- **Use `--min-tvl 10000`** for real deployments — low-TVL pools have noisy metrics and thin exit liquidity.

## Polling cadence

| Phase | Action | Frequency |
|---|---|---|
| Idle | `scan --min-tvl 10000` | Every 15–30 min |
| Alert detected | `track --pool-id <id>` | Every 5 min |
| Window confirmed | Escalate to `hodlmm-advisor entry-plan` | Once |
| Position open | `hodlmm-pulse track` + `hodlmm-advisor pool-summary` | Every 10 min |
| Signal cools | Exit via human-approved `bitflow withdraw-liquidity-simple` | Once |

## Signal → action mapping

| Signal | Trend | Action |
|---|---|---|
| 🔥 spike | ⬆️ accelerating | **Alert user immediately. Run advisor entry-plan. Await approval.** |
| 🔥 spike | ↔️ stable | Alert user. Run advisor. Note window may be peaking. |
| 🔥 spike | ⬇️ cooling | Warn: spike is fading. Do not enter — window likely closing. |
| 📈 elevated | ⬆️ accelerating | Begin track polling. Prepare entry-plan for next confirmation. |
| 📈 elevated | ↔️ stable | Monitor. Alert if fee velocity breaks into spike territory. |
| 〰️ normal | any | No action. Continue idle polling. |
| 📉 cooling | any | No entry. Exit any open position if regime also degrading. |
| ⬜ flat | any | Skip. Pool inactive. |

## On error

- Log the full `{ "error": "..." }` payload
- Do not retry silently — surface the error with the endpoint that failed
- If `doctor` reports API failure, pause all polling and alert user
- If state file is unreadable, treat all pools as `new` (insufficient data) and do not escalate

## On success

- For `scan`: present signal summary; highlight `spike`/`elevated` pools by name
- For `track`: always show trend direction and delta values; flag if trend changed since last poll
- For `report`: surface any pools with `spike` or `elevated` signals at top; present `overallTrend` for each

## Integration chain

```
hodlmm-pulse scan         → triage: which pool is heating up?
hodlmm-pulse track        → confirm: is momentum accelerating or fading?
hodlmm-advisor entry-plan → plan: bins, strategy, capital split
bitflow add-liquidity-simple → execute (human approval required)
hodlmm-pulse track        → monitor: is the window still open?
hodlmm-advisor pool-summary → regime check: is risk still acceptable?
bitflow withdraw-liquidity-simple → exit (human approval required)
```
