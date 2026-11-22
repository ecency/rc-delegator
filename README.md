# rc-delegator

RC jobs for @ecency.

## index.js (delegates and reclaims, needs the posting key)
- RC top-ups: delivers purchased top-ups and reclaims them on expiry (frequent run).
- Premium cleanup (`RUN_CLEANUP=1`, daily): reclaims signup RC grants from accounts 90+ days old.

## rc-monitor.js (read-only, no key)
Daily count of accounts that posted or commented with an Ecency app during one
UTC day and are short of Resource Credits. Costs come from the live
`rc_api.get_rc_stats` average comment cost, so no RC prices are hard-coded.

```
DATE=2026-11-21 HISTORY_FILE=./data/rc-monitor-history.jsonl node rc-monitor.js
```

`DATE` defaults to yesterday (UTC). Each run writes ONE JSON line per date to
`HISTORY_FILE` (a re-run for the same date replaces it). Fields:

| Field | Meaning |
|---|---|
| `authors` | accounts with a comment op (post, reply or an edit of either) from an Ecency app that day |
| `snapshot_hours_after_day_end` | how long after the day ended RC was read (see limits below) |
| `below_1_comment` | current RC below one average comment |
| `below_3_comments` | current RC below three average comments |
| `max_below_5_comments` | even a full RC tank holds fewer than five comments |
| `max_below_5b`, `max_below_15b` | full RC tank under 5B / 15B RC (absolute, for comparing with the 15B signup grant) |
| `holding_ecency_rc` | authors holding a direct RC delegation from @ecency |
| `active_topups` | active paid top-ups (null when `EPOINTS_UA` is unset or ePoints is down) |
| `short[]` | every author below three comments, with current/max/received RC, account age, `comment_ops` and `root_ops` that day (both include edits) |

The day's first and last block are found by timestamp, then the blocks are
streamed in chunks; a short chunk or broken block linkage aborts the run. Any
RPC failure, or malformed or partial data (bad timestamps, missing
transactions, non-numeric RC, missing or duplicated account rows), exits
non-zero and writes nothing for that day. The journal line repeats the counts
and names the short accounts.

### Limits of the numbers
- **Invisible users.** An account with too little RC to comment never lands on
  chain, so it is not in `authors`. The users who most need RC are missing here;
  the web and mobile apps count failed attempts in Sentry (`rc-shortfall`).
- **Snapshot timing.** RC is read when the job runs, not when each author acted.
  RC regenerates 20% of max per day, so someone who ran dry early in the day may
  have recovered by the snapshot: `below_*` undercounts. A backfill (`DATE=` an
  old day) shows today's RC for that day's authors; `snapshot_hours_after_day_end`
  says how stale it is.

Tests: `yarn test`. Schedule it once a day, a little after 00:00 UTC (the day
must be over on chain), and retry on a non-zero exit.
