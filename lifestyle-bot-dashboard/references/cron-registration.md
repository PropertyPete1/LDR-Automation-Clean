# Agent Bot Cron Registration

Run these commands **after publishing the site**. All times are UTC (CT = UTC-5 winter / UTC-6 summer).
The schedule below uses UTC-5 (winter/standard time). Adjust to UTC-6 in summer if needed.

---

## Schedule Overview

| Time (CT) | Time (UTC) | Action |
|---|---|---|
| 10:00 AM | 15:00 | Clock-in emails sent |
| 10:05 AM | 15:05 | Bots run follow-ups |
| 6:00 PM | 23:00 | Clock-off summary emails |
| 4:00 AM | 09:00 | Bot monitor / nightly health check |

---

## S&P500 Lifestyle Bot (Steven + Peter)

```bash
# Clock-in (10am CT = 15:00 UTC)
manus-heartbeat create \
  --name "sp500-clockin" \
  --cron "0 0 15 * * *" \
  --path /api/scheduled/sp-clockin \
  --description "S&P500 Lifestyle Bot clock-in email at 10am CT"

# Main run + clock-off (10:05am CT = 15:05 UTC)
manus-heartbeat create \
  --name "sp500-run" \
  --cron "0 5 15 * * *" \
  --path /api/scheduled/sp-run \
  --description "S&P500 Lifestyle Bot daily follow-up run at 10:05am CT"

# Standalone clock-off (6pm CT = 23:00 UTC)
manus-heartbeat create \
  --name "sp500-clockoff" \
  --cron "0 0 23 * * *" \
  --path /api/scheduled/sp-clockoff \
  --description "S&P500 Lifestyle Bot clock-off summary email at 6pm CT"
```

---

## Tiffany's Lifestyle Bot

```bash
manus-heartbeat create \
  --name "tiffany-clockin" \
  --cron "0 0 15 * * *" \
  --path /api/scheduled/tiffany-clockin \
  --description "Tiffany's Lifestyle Bot clock-in email at 10am CT"

manus-heartbeat create \
  --name "tiffany-run" \
  --cron "0 5 15 * * *" \
  --path /api/scheduled/tiffany-run \
  --description "Tiffany's Lifestyle Bot daily follow-up run at 10:05am CT"

manus-heartbeat create \
  --name "tiffany-clockoff" \
  --cron "0 0 23 * * *" \
  --path /api/scheduled/tiffany-clockoff \
  --description "Tiffany's Lifestyle Bot clock-off summary email at 6pm CT"
```

---

## Rue Lifestyle Bot

```bash
manus-heartbeat create \
  --name "stefanie-clockin" \
  --cron "0 0 15 * * *" \
  --path /api/scheduled/stefanie-clockin \
  --description "Rue Lifestyle Bot clock-in email at 10am CT"

manus-heartbeat create \
  --name "stefanie-run" \
  --cron "0 5 15 * * *" \
  --path /api/scheduled/stefanie-run \
  --description "Rue Lifestyle Bot daily follow-up run at 10:05am CT"

manus-heartbeat create \
  --name "stefanie-clockoff" \
  --cron "0 0 23 * * *" \
  --path /api/scheduled/stefanie-clockoff \
  --description "Rue Lifestyle Bot clock-off summary email at 6pm CT"
```

---

## Abby's Lifestyle Bot

```bash
manus-heartbeat create \
  --name "abby-clockin" \
  --cron "0 0 15 * * *" \
  --path /api/scheduled/abby-clockin \
  --description "Abby's Lifestyle Bot clock-in email at 10am CT"

manus-heartbeat create \
  --name "abby-run" \
  --cron "0 5 15 * * *" \
  --path /api/scheduled/abby-run \
  --description "Abby's Lifestyle Bot daily follow-up run at 10:05am CT"

manus-heartbeat create \
  --name "abby-clockoff" \
  --cron "0 0 23 * * *" \
  --path /api/scheduled/abby-clockoff \
  --description "Abby's Lifestyle Bot clock-off summary email at 6pm CT"
```

---

## Irma's Lifestyle Bot

```bash
manus-heartbeat create \
  --name "irma-clockin" \
  --cron "0 0 15 * * *" \
  --path /api/scheduled/irma-clockin \
  --description "Irma's Lifestyle Bot clock-in email at 10am CT"

manus-heartbeat create \
  --name "irma-run" \
  --cron "0 5 15 * * *" \
  --path /api/scheduled/irma-run \
  --description "Irma's Lifestyle Bot daily follow-up run at 10:05am CT"

manus-heartbeat create \
  --name "irma-clockoff" \
  --cron "0 0 23 * * *" \
  --path /api/scheduled/irma-clockoff \
  --description "Irma's Lifestyle Bot clock-off summary email at 6pm CT"
```

---

## Laila's Lifestyle Bot

```bash
manus-heartbeat create \
  --name "laila-clockin" \
  --cron "0 0 15 * * *" \
  --path /api/scheduled/laila-clockin \
  --description "Laila's Lifestyle Bot clock-in email at 10am CT"

manus-heartbeat create \
  --name "laila-run" \
  --cron "0 5 15 * * *" \
  --path /api/scheduled/laila-run \
  --description "Laila's Lifestyle Bot daily follow-up run at 10:05am CT"

manus-heartbeat create \
  --name "laila-clockoff" \
  --cron "0 0 23 * * *" \
  --path /api/scheduled/laila-clockoff \
  --description "Laila's Lifestyle Bot clock-off summary email at 6pm CT"
```

---

## Bot Monitor (Nightly Health Check)

```bash
manus-heartbeat create \
  --name "bot-monitor" \
  --cron "0 0 9 * * *" \
  --path /api/scheduled/bot-monitor \
  --description "Nightly bot health check at 4am CT — surfaces missed runs in morning summary"
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
