// Daily RC monitor (read-only). Measures how many accounts that posted or
// commented with an Ecency app during one UTC day are short of Resource Credits,
// so a later decision on free short RC grants rests on numbers.
//
// It only reads chain data and holds no key.

const fs = require('fs');
const path = require('path');

const RC_REGEN_SECONDS = 5 * 24 * 60 * 60; // full manabar regen time
const BLOCK_SECONDS = 3;
const RANGE_LIMIT = 1000; // block_api.get_block_range max count
const DAY_SECONDS = 86400;

function isEcencyApp(jsonMetadata) {
  if (!jsonMetadata) return false;
  try {
    const meta = JSON.parse(jsonMetadata);
    const app = meta && typeof meta === 'object' ? meta.app : '';
    return typeof app === 'string' && app.toLowerCase().startsWith('ecency');
  } catch (e) {
    return false;
  }
}

function blockTimeSec(blk) {
  return Date.parse(blk.timestamp + 'Z') / 1000;
}

// Accepts both [type, value] (condenser) and {type: 'x_operation', value} (appbase) ops.
function normalizeOp(op) {
  if (Array.isArray(op)) return { type: op[0], value: op[1] };
  return { type: String(op.type || '').replace(/_operation$/, ''), value: op.value };
}

// name -> { comment_ops, root_ops } for comment ops made with an Ecency app in
// [startSec, endSec). A comment op is also how an edit is written, so both
// counts include edits; root_ops are ops on top-level posts (new or edited).
// Pass `authors` to accumulate across chunks.
function collectEcencyAuthors(blocks, startSec, endSec, authors = new Map()) {
  blocks.forEach((blk) => {
    const t = blockTimeSec(blk);
    if (!(t >= startSec && t < endSec)) return;
    (blk.transactions || []).forEach((tx) => {
      (tx.operations || []).forEach((raw) => {
        const op = normalizeOp(raw);
        if (op.type !== 'comment' || !op.value) return;
        if (!isEcencyApp(op.value.json_metadata)) return;
        const row = authors.get(op.value.author) || { comment_ops: 0, root_ops: 0 };
        row.comment_ops += 1;
        if (op.value.parent_author === '') row.root_ops += 1;
        authors.set(op.value.author, row);
      });
    });
  });
  return authors;
}

// Mana now, applying linear regeneration since the last manabar update.
function currentMana(rcAccount, nowSec) {
  const max = Number(rcAccount.max_rc);
  const bar = rcAccount.rc_manabar || {};
  const elapsed = Math.max(0, nowSec - Number(bar.last_update_time || nowSec));
  const regen = (max * elapsed) / RC_REGEN_SECONDS;
  return Math.min(max, Number(bar.current_mana || 0) + regen);
}

function ageDays(createdISO, nowSec) {
  if (!createdISO) return null;
  return Math.floor((nowSec - Date.parse(createdISO + 'Z') / 1000) / DAY_SECONDS);
}

const toB = (n) => Math.round((n / 1e9) * 100) / 100;

// One history line. `short` lists every author below 3 average comments, with
// the fields a later grant rule would need (age, tank size, delegation state).
function summarize({ date, authors, rcAccounts, created, avgCommentRc, ecencyDelegatees, activeTopups, nowSec }) {
  const dayEndSec = Date.parse(date + 'T00:00:00Z') / 1000 + DAY_SECONDS;
  const s = {
    date,
    measured_at: new Date(nowSec * 1000).toISOString(),
    // RC is read when the job runs, not at the moment each author acted: the
    // later the snapshot, the more regeneration hides who ran short that day.
    snapshot_hours_after_day_end: Math.round(((nowSec - dayEndSec) / 3600) * 100) / 100,
    avg_comment_rc_b: toB(avgCommentRc),
    authors: authors.size,
    below_1_comment: 0,
    below_3_comments: 0,
    max_below_5_comments: 0,
    holding_ecency_rc: 0,
    active_topups: activeTopups ? activeTopups.size : null,
    short: []
  };
  rcAccounts.forEach((acc) => {
    const name = acc.account;
    if (!authors.has(name)) return;
    const max = Number(acc.max_rc);
    const cur = currentMana(acc, nowSec);
    const holding = ecencyDelegatees.has(name);
    if (cur < avgCommentRc) s.below_1_comment += 1;
    if (max < 5 * avgCommentRc) s.max_below_5_comments += 1;
    if (holding) s.holding_ecency_rc += 1;
    if (cur < 3 * avgCommentRc) {
      s.below_3_comments += 1;
      const a = authors.get(name);
      s.short.push({
        name,
        cur_rc_b: toB(cur),
        max_rc_b: toB(max),
        received_rc_b: toB(Number(acc.received_delegated_rc || 0)),
        age_days: ageDays(created.get(name), nowSec),
        comment_ops: a.comment_ops,
        root_ops: a.root_ops,
        holding_ecency_rc: holding,
        active_topup: activeTopups ? activeTopups.has(name) : null
      });
    }
  });
  s.short.sort((x, y) => x.cur_rc_b - y.cur_rc_b || x.name.localeCompare(y.name));
  return s;
}

// Append the day's line, replacing any earlier line for the same date. Written
// to a temp file and renamed so a crash never leaves a half-written history.
function writeHistory(file, summary) {
  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).filter((l) => {
      try { return JSON.parse(l).date !== summary.date; } catch (e) { return true; }
    });
  }
  lines.push(JSON.stringify(summary));
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  fs.renameSync(tmp, file);
}

async function blockTime(client, n) {
  const res = await client.call('block_api', 'get_block_header', { block_num: n });
  if (!res || !res.header) throw new Error(`no header for block ${n}`);
  return blockTimeSec(res.header);
}

// Lowest block number whose timestamp is >= sec, searching [lo, hi]
// (hi must already satisfy it).
async function firstBlockAtOrAfter(client, sec, lo, hi) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTime(client, mid)) >= sec) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Streams the day's blocks chunk by chunk into `onChunk`, never holding more
// than one chunk. The exact first/last block of the day are found by binary
// search on timestamps, so a re-run of an old day costs the same as a fresh one.
async function scanDay(client, startSec, endSec, onChunk) {
  const props = (await client.call('condenser_api', 'get_dynamic_global_properties', [])) || {};
  const head = Number(props.head_block_number);
  const headSec = Date.parse(props.time + 'Z') / 1000;
  // An empty result would make these NaN, and NaN slips past a plain `<`.
  if (!Number.isInteger(head) || head < 1 || !Number.isFinite(headSec)) throw new Error('bad global properties');
  if (!(headSec >= endSec)) throw new Error(`day ${new Date(startSec * 1000).toISOString().slice(0, 10)} is not over yet on chain`);
  // Missed slots mean fewer blocks than elapsed 3s slots, so the block at a
  // past time has a number >= this slot-based estimate: a safe lower bound.
  const lowerBound = (sec) => Math.max(1, head - Math.ceil((headSec - sec) / BLOCK_SECONDS));
  const first = await firstBlockAtOrAfter(client, startSec, lowerBound(startSec), head);
  const last = (await firstBlockAtOrAfter(client, endSec, Math.max(first, lowerBound(endSec)), head)) - 1;
  if (last < first) throw new Error('no blocks in that day');
  let prevId = null;
  for (let n = first; n <= last; n += RANGE_LIMIT) {
    const count = Math.min(RANGE_LIMIT, last - n + 1);
    const res = await client.call('block_api', 'get_block_range', { starting_block_num: n, count });
    const blocks = (res && res.blocks) || [];
    // A node can return fewer blocks than asked (failover, lagging node, a
    // truncating proxy). Skipping the gap would silently undercount the day.
    if (blocks.length !== count) throw new Error(`incomplete block range at ${n}: got ${blocks.length} of ${count}`);
    blocks.forEach((blk, i) => {
      if (prevId !== null && blk.previous !== prevId) throw new Error(`block linkage broken at ${n + i}`);
      prevId = blk.block_id;
    });
    onChunk(blocks);
  }
  return { first, last };
}

async function listDelegatees(client, from) {
  const out = new Set();
  let start = '';
  for (;;) {
    const res = await client.call('rc_api', 'list_rc_direct_delegations', { start: [from, start], limit: 1000 });
    if (!res || !Array.isArray(res.rc_direct_delegations)) throw new Error('bad rc delegation list');
    const page = res.rc_direct_delegations.filter((r) => r.from === from);
    page.forEach((r) => out.add(r.to));
    // A short page (or one that rolled past our account) is the last one.
    // `start` is inclusive, so the next page repeats this page's last row.
    if (page.length < 1000) break;
    start = page[page.length - 1].to;
  }
  return out;
}

async function inChunks(names, size, fn) {
  const out = [];
  for (let i = 0; i < names.length; i += size) out.push(...(await fn(names.slice(i, i + size))));
  return out;
}

// date = 'YYYY-MM-DD' (UTC). fetchTopups is optional: () => Promise<Set<name>>.
async function run({ client, date, historyFile, delegator, fetchTopups, nowSec }) {
  const startSec = Date.parse(date + 'T00:00:00Z') / 1000;
  // Date.parse rolls '2026-02-30' over to March 2; require a round trip.
  if (Number.isNaN(startSec) || new Date(startSec * 1000).toISOString().slice(0, 10) !== date) {
    throw new Error(`bad date ${date}`);
  }
  const endSec = startSec + DAY_SECONDS;

  const authors = new Map();
  await scanDay(client, startSec, endSec, (blocks) => collectEcencyAuthors(blocks, startSec, endSec, authors));
  const names = [...authors.keys()];

  const stats = await client.call('rc_api', 'get_rc_stats', {});
  const avgCommentRc = Number(stats.rc_stats.ops.comment_operation.avg_cost);
  if (!(avgCommentRc > 0)) throw new Error('rc_stats has no comment cost');

  // Every author must come back: a node silently omits names it does not know,
  // and a missing row would drop that author from every below_* count.
  const complete = (label, rows, ch) => {
    if (!Array.isArray(rows) || rows.length !== ch.length) throw new Error(`incomplete ${label}: ${rows ? rows.length : 'none'} of ${ch.length}`);
    return rows;
  };
  const rcAccounts = await inChunks(names, 100, async (ch) =>
    complete('rc accounts', ((await client.call('rc_api', 'find_rc_accounts', { accounts: ch })) || {}).rc_accounts, ch));
  const accounts = await inChunks(names, 100, async (ch) =>
    complete('accounts', await client.call('condenser_api', 'get_accounts', [ch]), ch));
  const created = new Map(accounts.map((a) => [a.name, a.created]));
  const ecencyDelegatees = await listDelegatees(client, delegator);
  const activeTopups = fetchTopups ? await fetchTopups() : null;

  const summary = summarize({
    date, authors, rcAccounts, created, avgCommentRc, ecencyDelegatees, activeTopups,
    nowSec: nowSec || Math.floor(Date.now() / 1000)
  });
  writeHistory(historyFile, summary);
  return summary;
}

// Minimal JSON-RPC client over fetch with node failover. dhive's client
// aborts read calls after 500ms on the first try, which re-downloads
// every ~10 MB block range at least twice.
function createRpcClient(nodes, { fetchImpl = fetch, timeoutMs = 60_000, rounds = 2 } = {}) {
  let id = 0;
  return {
    async call(api, method, params) {
      let lastErr;
      for (let round = 0; round < rounds; round++) {
        for (const url of nodes) {
          try {
            const res = await fetchImpl(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: `${api}.${method}`, params }),
              signal: AbortSignal.timeout(timeoutMs)
            });
            if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
            const body = await res.json();
            if (body.error) throw new Error(`${api}.${method}: ${body.error.message || JSON.stringify(body.error)}`);
            return body.result;
          } catch (e) {
            lastErr = e;
          }
        }
      }
      throw lastErr;
    }
  };
}

module.exports = { collectEcencyAuthors, currentMana, summarize, writeHistory, run, isEcencyApp, listDelegatees, createRpcClient };
