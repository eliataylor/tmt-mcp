---
name: reconcile-queue
description: After a tunnel or orchestrator outage, list recent GitHub issue events that should have queued agent work, compare to the SQLite task queue, and enqueue missed deliveries. Use when the user asks to recover, reconcile, catch up, or backfill missed webhooks.
---

# Reconcile agent queue

## When to use

The webhook path is event-driven. If cloudflared or the queue was down, GitHub may have failed deliveries (redeliver in **Settings → Webhooks → Recent Deliveries**) or humans may have left control labels on issues with no matching task.

## Prerequisites

- Queue running (`docker compose -f docker-compose.dev.yml up`)
- `.env.orchestrator` with `GITHUB_TOKEN` and `AGENT_POLL_SECRET`
- Optional: orchestrator running to drain new tasks after enqueue

## Commands

From the `tmt-mcp` repo root:

```bash
npm run reconcile
npm run reconcile -- --since 48h
npm run reconcile -- --project main-app
npm run reconcile -- --enqueue 3
npm run reconcile -- --json
npm run reconcile -- --comments
```

## Read the table

| Column | Meaning |
| --- | --- |
| **Queue action** | What `classify()` in `src/triggers.mjs` would enqueue (`agent:sdd`, `agent:execute`, `agent:test`, `agent:research`, …) or `—` if ignored |
| **Latest task** | Most recent queue row for that issue (any time), not only since the event |
| **Next step** | Copy-paste `npm run reconcile -- --enqueue <#>` when a row missed the queue; `queued` / `task completed after event` → usually no action |

## Enqueue options

1. **`--enqueue <row#>`** — `POST /api/agent/ingest` on the control listener when the image includes that route; otherwise the script enqueues via the host-mounted `sqlite_data/*/agent_queue.db` (same `handleDelivery` path). Rebuild `webhook-server` if you want HTTP-only ingest.
2. **GitHub redelivery** — use when the original delivery still appears in Recent Deliveries; dedupes on `X-GitHub-Delivery`.
3. **Manual** — toggle a control label, or comment with the project `mention` plus a control-label token (e.g. `@tmt-agent agent:sdd …`). A bare mention with no token and no control label on the issue queues `mention_help` only.

## Limits

- Scans **open issues updated since `--since`** (default `72h`), then issue events and comments in that window. Very old activity on stale open issues may not appear until the issue is touched or you widen `--since`.
- Does not replace GitHub’s delivery log for exact webhook replay.
