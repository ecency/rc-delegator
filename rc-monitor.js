// Daily RC monitor CLI (read-only, needs no key). See lib/rc-monitor.js.
//
// Usage:
//   HIVE_NODE=https://api.hive.blog \
//   DELEGATOR=ecency \
//   HISTORY_FILE=./data/rc-monitor-history.jsonl \
//   DATE=2026-11-21          # optional, defaults to yesterday (UTC)
//   EPOINTS_API=... EPOINTS_UA=...   # optional, adds the active top-up count
//   node rc-monitor.js
//
// Exits non-zero on any RPC failure and then writes nothing for that day.

const https = require('https');
const { run, createRpcClient } = require('./lib/rc-monitor');

const HIVE_NODE = process.env.HIVE_NODE || 'https://api.hive.blog';
const DELEGATOR = process.env.DELEGATOR || 'ecency';
const HISTORY_FILE = process.env.HISTORY_FILE || './data/rc-monitor-history.jsonl';
const EPOINTS_API = process.env.EPOINTS_API || 'https://epoints.ecency.com';
const API_UA = process.env.EPOINTS_UA;

function yesterdayUtc() {
  return new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': API_UA }, timeout: 15_000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`GET ${url} -> ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
  });
}

// Optional extra: an ePoints outage records the count as null (unknown)
// instead of losing the chain measurement for the day.
async function fetchActiveTopups() {
  try {
    const rows = await httpGetJson(`${EPOINTS_API}/api/rc-delegations-all`);
    return new Set((Array.isArray(rows) ? rows : []).map((r) => r.user).filter(Boolean));
  } catch (e) {
    console.warn('RC monitor: active top-ups unavailable:', e && e.message ? e.message : e);
    return null;
  }
}

async function main() {
  const date = process.env.DATE || yesterdayUtc();
  const client = createRpcClient([HIVE_NODE, 'https://api.openhive.network', 'https://techcoderx.com', 'https://rpc.mahdiyari.info']);
  const s = await run({
    client,
    date,
    historyFile: HISTORY_FILE,
    delegator: DELEGATOR,
    fetchTopups: API_UA ? fetchActiveTopups : null
  });
  console.log(
    `RC monitor ${s.date}: ${s.authors} Ecency authors; ` +
    `${s.below_1_comment} below 1 comment, ${s.below_3_comments} below 3 comments, ` +
    `${s.max_below_5_comments} with a full tank under 5 comments, ` +
    `${s.holding_ecency_rc} holding @${DELEGATOR} RC, ` +
    `RC read ${s.snapshot_hours_after_day_end}h after the day ended, ` +
    `active top-ups ${s.active_topups === null ? 'n/a' : s.active_topups} ` +
    `(avg comment ${s.avg_comment_rc_b}B RC). History: ${HISTORY_FILE}`
  );
}

main().catch((e) => {
  console.error('RC monitor failed:', e && e.message ? e.message : e);
  process.exit(1);
});
