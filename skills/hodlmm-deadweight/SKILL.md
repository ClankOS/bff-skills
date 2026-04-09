---
name: hodlmm-deadweight
description: "Capital efficiency X-ray for HODLMM — scans all pools to show how much liquidity is earning fees vs stranded out of range, protocol-wide or per-address with on-chain position reads."
metadata:
  author: "ghislo749"
  author-agent: "Grim Seraph"
  user-invocable: "false"
  arguments: "doctor | scan"
  entry: "hodlmm-deadweight/hodlmm-deadweight.ts"
  requires: ""
  tags: "l2, defi, read-only, mainnet-only"
---

# HODLMM Deadweight

Capital efficiency X-ray for Bitflow HODLMM concentrated liquidity pools.

## What it does

Answers the question LPs can't answer with existing tools: **"How much of my liquidity is actually earning fees right now?"**

Scans every HODLMM pool's bin distribution and separates capital into two buckets: **active** (within fee-earning range of the current price) and **deadweight** (stranded out of range, earning nothing). Runs protocol-wide for a bird's-eye view, or per-address with on-chain position reads for a personal X-ray.

## Why agents need it

Concentrated liquidity only works when it's in range. Price moves, bins go stale, capital sits idle — but nothing tells you how much or where. This skill gives agents the data to:
- **Detect stranded capital** — quantify deadweight in USD across all pools
- **Trigger rebalancing** — feed the output into a rebalancer skill when efficiency drops
- **Audit LP health** — per-address scan shows exactly which bins are earning and which are dead

## Safety notes

- **Read-only** — never submits transactions or moves funds
- **No wallet required** — safe to call from any agent without authentication
- **Mainnet-only** — Bitflow HODLMM is mainnet-only
- Per-address scans make on-chain reads via Hiro API — a Hiro API key (`--hiro-api-key`) is recommended for large positions to avoid rate limits

## Commands

### doctor
Checks connectivity to Bitflow APIs (quotes, app, bins) and Hiro Stacks API. Verifies on-chain read-only calls work.

```bash
bun run skills/hodlmm-deadweight/hodlmm-deadweight.ts doctor
```

### scan
Protocol-wide capital efficiency scan across all active HODLMM pools.

```bash
bun run skills/hodlmm-deadweight/hodlmm-deadweight.ts scan
```

### scan --address
Per-address X-ray. Reads `get-user-bins` on-chain for each pool, fetches per-bin balances and total supplies, cross-references with bin reserves and token prices to compute USD value of earning vs dead capital.

```bash
bun run skills/hodlmm-deadweight/hodlmm-deadweight.ts scan --address SP2V3J7G42E8ZD1YPK6G6295EQ1EGZMPGDZQSRDWT
```

Options:
- `--address <stx-address>` — STX address to scan
- `--pool-id <id>` — narrow to a single pool (recommended on free-tier Hiro to avoid rate limits)
- `--hiro-api-key <key>` — Hiro API key for elevated rate limits

```bash
bun run skills/hodlmm-deadweight/hodlmm-deadweight.ts scan --address SP2V3J... --pool-id dlmm_3
bun run skills/hodlmm-deadweight/hodlmm-deadweight.ts scan --address SP2V3J... --hiro-api-key <key>
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{ "status": "success", "network": "mainnet", "timestamp": "...", "protocolEfficiency": 34.2, "pools": [...] }
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Active range model

A bin is classified as "earning" if it is within `activeRadius` bins of the current active bin, where:

```
activeRadius = max(5, round(50 / bin_step))
```

| bin_step | activeRadius | Rationale |
|---|---|---|
| 1 | 50 | Narrow steps — need wide bin count to cover meaningful price range |
| 4 | 13 | Moderate |
| 10 | 5 | Wide steps — 5 bins already covers significant range |
| 15 | 5 | Floor at 5 |

Bins outside this radius have zero probability of receiving swap volume at the current price level and are classified as deadweight.

## Positions indexer (reference implementation)

`positions-indexer.ts` is a standalone script included as a reference implementation for a proposed Bitflow API endpoint:

```
GET /api/app/v1/positions/{stx-address}
```

Currently, per-address position data requires `2 × bins × pools` on-chain reads via Hiro API. An LP with 500 bins across 3 pools triggers ~3,000 API calls. A native endpoint would reduce this to a single REST call.

The indexer demonstrates the exact response shape and data pipeline. Bitflow could implement this server-side by indexing `add-liquidity` / `withdraw-liquidity` / `move-liquidity` contract events and caching position state.

## Known constraints

- Bitflow HODLMM APIs are public during beta (no API key needed)
- Per-address scan requires 2 Hiro API calls per bin (`get-balance` + `get-total-supply`). An LP with 500 bins across multiple pools will make ~1,000 calls. A Hiro API key is strongly recommended for heavy users
- If rate-limited mid-scan, partial results are returned with a warning
- Active range heuristic is a conservative estimate — actual fee-earning range depends on swap routing and volume distribution
- Requires `@stacks/transactions` for Clarity value encoding/decoding
