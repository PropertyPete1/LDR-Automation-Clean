# Agent Bot Cron Registration

Run these commands **after publishing the site**. All times are UTC (CT = UTC-5 winter / UTC-6 summer).
The schedule below uses UTC-5 (winter/standard time). Adjust to UTC-6 in summer if needed.

> **Rewritten after the engine migration.** This file used to list one clock-in /
> run / clock-off trio per agent (`/api/scheduled/tiffany-run`, `sp-run`, …).
> Every one of those endpoints was deleted along with the per-agent bot files —
> registering them now creates heartbeats that 404 daily. All agents run on the
> data-driven engine, so **one** trio covers the whole roster.

---

## Schedule Overview

| Time (CT) | Time (UTC) | Action |
|---|---|---|
| 10:00 AM | 15:00 | Clock-in emails sent (all engine agents) |
| 10:05 AM | 15:05 | Peter + Steven runs (staggered, see note) |
| 10:10 AM | 15:10 | Engine run — all remaining agents |
| 6:00 PM | 23:00 | Clock-off summary emails (all engine agents) |
| 3:50 AM | 08:50 | Lead reply check |
| 4:00 AM | 09:00 | Bot monitor / nightly health check |

---

## Engine — clock-in, run, clock-off (covers every agent)

Agents are read from the `agent_bots` table at run time (`engineActive=true`).
Adding or removing an agent needs **no cron change**.

```bash
# Clock-in for ALL engine agents (10am CT = 15:00 UTC)
manus-heartbeat create \
  --name "engine-clockin" \
  --cron "0 0 15 * * *" \
  --path /api/scheduled/engine-clockin \
  --description "Clock-in emails for all engine agents at 10am CT"

# Follow-up run for ALL engine agents (10:10am CT = 15:10 UTC)
manus-heartbeat create \
  --name "engine-run" \
  --cron "0 10 15 * * *" \
  --path /api/scheduled/engine-run \
  --description "Follow-up run for all engine agents at 10:10am CT"

# Clock-off for ALL engine agents (6pm CT = 23:00 UTC)
manus-heartbeat create \
  --name "engine-clockoff" \
  --cron "0 0 23 * * *" \
  --path /api/scheduled/engine-clockoff \
  --description "Clock-off summary emails for all engine agents at 6pm CT"
```

---

## S&P500 split runs (Peter / Steven)

These two keep their own endpoints purely to spread load — each is a thin
wrapper over `runEngineForAgent(...)`, not a separate motor.

```bash
manus-heartbeat create \
  --name "sp500-peter-run" \
  --cron "0 5 15 * * *" \
  --path /api/scheduled/sp-peter-run \
  --description "Peter's engine run at 10:05am CT (split to avoid heartbeat timeout)"

manus-heartbeat create \
  --name "sp500-steven-run" \
  --cron "0 7 15 * * *" \
  --path /api/scheduled/sp-steven-run \
  --description "Steven's engine run at 10:07am CT (split to avoid heartbeat timeout)"
```

> **Overlap note.** `engine-run` iterates *every* engine-active agent, which
> includes `sp500_peter` and `sp500_steven` — so with all three registered those
> two agents are processed twice a day. No lead is emailed twice (the
> `recordSmsSentToday` dedup makes the second pass a no-op), but the work and
> the run-log rows are duplicated. If you want them handled once, keep the two
> split crons and drop them from the engine sweep, or drop the split crons and
> let `engine-run` cover all six.

---

## Intro emails (new agents only)

Sends the one-time introduction email to any engine agent that has not received
one. `engine-clockin` already calls this, so register it only if you want a
separate manual trigger.

```bash
manus-heartbeat create \
  --name "engine-intro" \
  --cron "0 30 15 * * *" \
  --path /api/scheduled/engine-intro \
  --description "One-time intro emails for newly added engine agents"
```

---

## Lead Reply Check + Bot Monitor

```bash
manus-heartbeat create \
  --name "lead-reply-check" \
  --cron "0 50 8 * * *" \
  --path /api/scheduled/lead-reply-check \
  --description "Scan for lead replies at 3:50am CT — 10 min before the healer report"

manus-heartbeat create \
  --name "bot-monitor" \
  --cron "0 0 9 * * *" \
  --path /api/scheduled/bot-monitor \
  --description "Nightly bot health check at 4am CT — surfaces missed runs in morning summary"
```

---

## Single-agent run (manual / debugging)

Not a scheduled job — takes the slug as a query param:

```bash
POST /api/scheduled/engine-run-single?slug=tiffany
```

---

## Retiring the old per-agent heartbeats

If this deployment still has heartbeats from the pre-engine layout, they now
point at deleted routes. List and remove them:

```bash
manus-heartbeat list
```

Delete any heartbeat whose `--path` is one of:

```
/api/scheduled/sp-clockin        /api/scheduled/sp-run         /api/scheduled/sp-clockoff
/api/scheduled/tiffany-clockin   /api/scheduled/tiffany-run    /api/scheduled/tiffany-clockoff
/api/scheduled/stefanie-clockin  /api/scheduled/stefanie-run   /api/scheduled/stefanie-clockoff
/api/scheduled/abby-clockin      /api/scheduled/abby-run       /api/scheduled/abby-clockoff
/api/scheduled/irma-clockin      /api/scheduled/irma-run       /api/scheduled/irma-clockoff
/api/scheduled/laila-clockin     /api/scheduled/laila-run      /api/scheduled/laila-clockoff
```

---

## After Registration

Save the `task_uid` returned by each command. You can always retrieve them later with:

```bash
manus-heartbeat list
```

To pause a bot temporarily:
```bash
manus-heartbeat update --task-uid <uid> --enable false
```

To resume:
```bash
manus-heartbeat update --task-uid <uid> --enable true
```
