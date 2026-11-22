// Acceptance tests for ecency/rc-delegator#2 (daily RC monitor).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const m = require('../lib/rc-monitor');

const tmpDirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rcmon-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const B = 1_000_000_000;
const DAY = '2026-11-21';
const dayStartSec = Date.parse(DAY + 'T00:00:00Z') / 1000;

function commentOp(author, app, extra = {}) {
  return ['comment', {
    parent_author: extra.parent_author ?? 'someone',
    parent_permlink: 'p',
    author,
    permlink: 'x',
    title: '',
    body: extra.body ?? 'hello',
    json_metadata: app === null ? '{not json' : JSON.stringify({ app })
  }];
}

function block(ts, ops) {
  return { timestamp: ts, transactions: [{ operations: ops }] };
}

// Same blocks in the appbase shape block_api.get_block_range returns.
function appbaseBlock(ts, ops) {
  return {
    timestamp: ts,
    transactions: [{ operations: ops.map(([type, value]) => ({ type: type + '_operation', value })) }]
  };
}

test('collects only Ecency authors, broken metadata does not throw', () => {
  const blocks = [
    block('2026-11-21T01:00:00', [
      commentOp('alice', 'ecency/4.2.1-vision'),
      commentOp('bob', 'peakd/2025.1'),
      commentOp('carol', null),
      commentOp('dave', 'Ecency/3.0 mobile', { parent_author: '' })
    ]),
    appbaseBlock('2026-11-21T02:00:00', [commentOp('alice', 'ecency/4.2.1-vision')])
  ];
  const authors = m.collectEcencyAuthors(blocks, dayStartSec, dayStartSec + 86400);
  assert.deepEqual([...authors.keys()].sort(), ['alice', 'dave']);
  assert.equal(authors.get('alice').comment_ops, 2);
  assert.equal(authors.get('dave').root_ops, 1);
});

test('only blocks inside the UTC day are counted', () => {
  const blocks = [
    block('2026-11-20T23:59:57', [commentOp('early', 'ecency/1')]),
    block('2026-11-21T00:00:00', [commentOp('first', 'ecency/1')]),
    block('2026-11-21T23:59:57', [commentOp('last', 'ecency/1')]),
    block('2026-11-22T00:00:00', [commentOp('late', 'ecency/1')])
  ];
  const authors = m.collectEcencyAuthors(blocks, dayStartSec, dayStartSec + 86400);
  assert.deepEqual([...authors.keys()].sort(), ['first', 'last']);
});

test('current mana regenerates linearly over 5 days, capped at max', () => {
  const now = 1_000_000;
  const acc = { max_rc: String(10 * B), rc_manabar: { current_mana: '0', last_update_time: now - 2.5 * 86400 } };
  assert.equal(m.currentMana(acc, now), 5 * B);
  const full = { max_rc: String(10 * B), rc_manabar: { current_mana: String(9 * B), last_update_time: now - 5 * 86400 } };
  assert.equal(m.currentMana(full, now), 10 * B);
});

test('an author holding less than one live average comment counts as starved', () => {
  const now = Date.parse("2026-11-21T00:00:00Z") / 1000;
  const rcAccounts = [
    { account: 'alice', max_rc: String(5 * B), received_delegated_rc: '0', rc_manabar: { current_mana: String(1 * B), last_update_time: now } },
    { account: 'dave', max_rc: String(50 * B), received_delegated_rc: String(15 * B), rc_manabar: { current_mana: String(40 * B), last_update_time: now } }
  ];
  const authors = new Map([['alice', { comment_ops: 3, root_ops: 1 }], ['dave', { comment_ops: 1, root_ops: 0 }]]);
  const created = new Map([['alice', '2026-11-01T00:00:00'], ['dave', '2020-01-01T00:00:00']]);
  const s = m.summarize({
    date: DAY, authors, rcAccounts, created, avgCommentRc: 1.2 * B,
    ecencyDelegatees: new Set(['dave']), activeTopups: new Set(), nowSec: now
  });
  assert.equal(s.authors, 2);
  assert.equal(s.below_1_comment, 1);
  assert.equal(s.below_3_comments, 1);
  assert.equal(s.max_below_5_comments, 1);
  assert.equal(s.holding_ecency_rc, 1);
  assert.equal(s.short.length, 1);
  assert.equal(s.short[0].name, 'alice');
  assert.equal(s.short[0].age_days, 20);
  assert.equal(s.short[0].root_ops, 1);
});

test('two runs on the same date keep one line for that date', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.jsonl');
  m.writeHistory(file, { date: '2026-11-20', authors: 1 });
  m.writeHistory(file, { date: DAY, authors: 5 });
  m.writeHistory(file, { date: DAY, authors: 7 });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => [l.date, l.authors]), [['2026-11-20', 1], [DAY, 7]]);
});

test('RPC failure rejects and writes nothing', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.jsonl');
  const client = { call: async () => { throw new Error('node down'); } };
  await assert.rejects(m.run({ client, date: DAY, historyFile: file, delegator: 'ecency' }), /node down/);
  assert.equal(fs.existsSync(file), false);
});

test('the monitor never broadcasts', () => {
  for (const f of ['../lib/rc-monitor.js', '../rc-monitor.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotMatch(src, /broadcast|PrivateKey|POSTING_WIF|sendOperations/);
  }
});

test('delegatee pagination follows a full page even after the repeated start row', async () => {
  const names = Array.from({ length: 1999 }, (_, i) => 'u' + String(i).padStart(5, '0'));
  const client = {
    call: async (api, method, params) => {
      const startName = params.start[1];
      const from = startName === '' ? 0 : names.indexOf(startName); // start is inclusive
      const rows = names.slice(from, from + 1000).map((to) => ({ from: 'ecency', to }));
      if (rows.length < 1000) rows.push({ from: 'other', to: 'zzz' }); // rolls into the next delegator
      return { rc_direct_delegations: rows.slice(0, 1000) };
    }
  };
  const out = await m.listDelegatees(client, 'ecency');
  assert.equal(out.size, 1999);
});

// A fake chain from 2026-11-20 00:00 UTC. `missed` = slot numbers with no block
// (missed slots), so block numbers drift behind the 3s slot clock.
function fakeChain({ headIso, missed = new Set(), ops = {}, rcOf = () => 4 * B, shortChunkAt = null, breakLinkAt = null }) {
  const genesis = Date.parse('2026-11-20T00:00:00Z') / 1000;
  const headSlot = Math.floor((Date.parse(headIso + 'Z') / 1000 - genesis) / 3);
  const slotOf = []; // block number (1-based) -> slot
  for (let slot = 0; slot <= headSlot; slot++) if (!missed.has(slot)) slotOf.push(slot);
  const head = slotOf.length;
  const ts = (n) => new Date((genesis + slotOf[n - 1] * 3) * 1000).toISOString().slice(0, 19);
  const id = (n) => (n === breakLinkAt ? 'ffff' : '') + n.toString(16).padStart(8, '0') + 'aa';
  const nowSec = Date.parse(headIso + 'Z') / 1000;
  const calls = { range: 0 };
  const rc = (account) => ({ account, max_rc: String(5 * B), received_delegated_rc: '0', rc_manabar: { current_mana: String(rcOf(account)), last_update_time: nowSec } });
  const client = {
    call: async (api, method, params) => {
      if (method === 'get_dynamic_global_properties') return { head_block_number: head, time: ts(head) };
      if (method === 'get_block_header') return { header: { timestamp: ts(params.block_num), previous: id(params.block_num - 1) } };
      if (method === 'get_block_range') {
        calls.range += 1;
        let count = params.count;
        if (shortChunkAt !== null && params.starting_block_num <= shortChunkAt && shortChunkAt < params.starting_block_num + count) count = 400;
        const out = [];
        for (let n = params.starting_block_num; n < params.starting_block_num + count && n <= head; n++) {
          const b = block(ts(n), ops[ts(n)] || []);
          b.block_id = id(n);
          b.previous = id(n - 1);
          if (n === breakLinkAt) b.block_id = 'broken';
          out.push(b);
        }
        return { blocks: out };
      }
      if (method === 'get_rc_stats') return { rc_stats: { ops: { comment_operation: { avg_cost: 1.2 * B } } } };
      if (method === 'find_rc_accounts') return { rc_accounts: params.accounts.map(rc) };
      if (method === 'get_accounts') return params[0].map((name) => ({ name, created: '2026-11-01T00:00:00' }));
      if (method === 'list_rc_direct_delegations') return { rc_direct_delegations: [{ from: 'ecency', to: 'bob' }] };
      throw new Error('unexpected ' + method);
    }
  };
  return { client, nowSec, calls };
}

const EDGE_OPS = {
  '2026-11-20T23:59:57': [commentOp('early', 'ecency/1')],
  '2026-11-21T00:00:00': [commentOp('alice', 'ecency/1')],
  '2026-11-21T23:59:57': [commentOp('bob', 'ecency/1', { parent_author: '' })],
  '2026-11-22T00:00:00': [commentOp('late', 'ecency/1')]
};

test('a full run over a fake chain writes the day line, including the day edges', async () => {
  const file = path.join(tmpDir(), 'history.jsonl');
  const { client, nowSec } = fakeChain({ headIso: '2026-11-22T00:20:00', ops: EDGE_OPS, rcOf: (a) => (a === 'alice' ? 0.5 * B : 4 * B) });
  const s = await m.run({ client, date: DAY, historyFile: file, delegator: 'ecency', nowSec });
  assert.equal(s.authors, 2);
  assert.equal(s.below_1_comment, 1);
  assert.equal(s.holding_ecency_rc, 1);
  assert.equal(s.active_topups, null);
  assert.equal(s.snapshot_hours_after_day_end, 0.33);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => [l.date, l.authors]), [[DAY, 2]]);
});

test('missed slots and a re-run 60 days later still count the day exactly, in about one day of requests', async () => {
  // drop every 7th slot (~14% missed), far more than the real chain
  const missed = new Set();
  for (let slot = 0; slot < 2_000_000; slot += 7) missed.add(slot);
  const ops = {};
  // after missing slots, the edge timestamps that still have blocks
  const { client, nowSec, calls } = fakeChain({ headIso: '2027-01-20T00:00:00', missed, ops });
  // place ops on the first and last real block of the day, and just outside
  const tsList = [];
  const genesis = Date.parse('2026-11-20T00:00:00Z') / 1000;
  for (let slot = 0; slot < 3 * 28800; slot++) if (!missed.has(slot)) tsList.push(new Date((genesis + slot * 3) * 1000).toISOString().slice(0, 19));
  const inDay = tsList.filter((t) => t >= '2026-11-21T00:00:00' && t < '2026-11-22T00:00:00');
  ops[tsList[tsList.indexOf(inDay[0]) - 1]] = [commentOp('early', 'ecency/1')];
  ops[inDay[0]] = [commentOp('alice', 'ecency/1')];
  ops[inDay[inDay.length - 1]] = [commentOp('bob', 'ecency/1')];
  ops[tsList[tsList.indexOf(inDay[inDay.length - 1]) + 1]] = [commentOp('late', 'ecency/1')];
  const s = await m.run({ client, date: DAY, historyFile: path.join(tmpDir(), 'h'), delegator: 'ecency', nowSec });
  assert.equal(s.authors, 2);
  assert.ok(calls.range <= 30, `range calls ${calls.range}`);
});

test('a short block range response mid-day is refused, not silently undercounted', async () => {
  const file = path.join(tmpDir(), 'h');
  const { client, nowSec } = fakeChain({ headIso: '2026-11-22T00:20:00', ops: EDGE_OPS, shortChunkAt: 30000 });
  await assert.rejects(m.run({ client, date: DAY, historyFile: file, delegator: 'ecency', nowSec }), /incomplete|short/);
  assert.equal(fs.existsSync(file), false);
});

test('a broken block chain linkage is refused', async () => {
  const { client, nowSec } = fakeChain({ headIso: '2026-11-22T00:20:00', ops: EDGE_OPS, breakLinkAt: 31000 });
  await assert.rejects(m.run({ client, date: DAY, historyFile: path.join(tmpDir(), 'h'), delegator: 'ecency', nowSec }), /linkage/);
});

test('an impossible date is refused', async () => {
  const { client, nowSec } = fakeChain({ headIso: '2026-11-22T00:20:00' });
  await assert.rejects(m.run({ client, date: '2026-02-30', historyFile: path.join(tmpDir(), 'h'), delegator: 'ecency', nowSec }), /bad date/);
});

test('a day that has not ended on chain is refused', async () => {
  const { client, nowSec } = fakeChain({ headIso: '2026-11-21T12:00:00' });
  await assert.rejects(m.run({ client, date: DAY, historyFile: path.join(tmpDir(), 'h'), delegator: 'ecency', nowSec }), /not over yet/);
});

test('the JSON-RPC client fails over to the next node and surfaces RPC errors', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push(url);
    if (url === 'https://a') throw new Error('ECONNRESET');
    const req = JSON.parse(opts.body);
    if (req.method === 'x.bad') return { ok: true, status: 200, json: async () => ({ error: { message: 'nope' } }) };
    return { ok: true, status: 200, json: async () => ({ result: { method: req.method } }) };
  };
  const c = m.createRpcClient(['https://a', 'https://b'], { fetchImpl, rounds: 1 });
  assert.deepEqual(await c.call('block_api', 'get_block_range', {}), { method: 'block_api.get_block_range' });
  assert.deepEqual(seen, ['https://a', 'https://b']);
  await assert.rejects(c.call('x', 'bad', {}), /nope/);
});

test('a chain break exactly at a chunk boundary is refused', async () => {
  // chunks of 1000 start at the day's first block; break the first block of the 2nd chunk
  const probe = fakeChain({ headIso: '2026-11-22T00:20:00' });
  let firstOfDay = null;
  const orig = probe.client.call;
  probe.client.call = async (api, method, params) => {
    if (method === 'get_block_range' && firstOfDay === null) firstOfDay = params.starting_block_num;
    return orig(api, method, params);
  };
  await m.run({ client: probe.client, date: DAY, historyFile: path.join(tmpDir(), 'h'), delegator: 'ecency', nowSec: probe.nowSec });
  const { client, nowSec } = fakeChain({ headIso: '2026-11-22T00:20:00', breakLinkAt: firstOfDay + 1000 - 1 });
  await assert.rejects(m.run({ client, date: DAY, historyFile: path.join(tmpDir(), 'h'), delegator: 'ecency', nowSec }), /linkage/);
});

test('empty or partial RPC results write nothing', async () => {
  const cases = {
    'dgp empty': (method) => (method === 'get_dynamic_global_properties' ? {} : undefined),
    'rc accounts missing': (method) => (method === 'find_rc_accounts' ? {} : undefined),
    'rc accounts short': (method, params) => (method === 'find_rc_accounts' ? { rc_accounts: [] } : undefined),
    'delegations missing': (method) => (method === 'list_rc_direct_delegations' ? {} : undefined),
    'accounts short': (method) => (method === 'get_accounts' ? [] : undefined)
  };
  for (const [name, override] of Object.entries(cases)) {
    const file = path.join(tmpDir(), 'h');
    const { client, nowSec } = fakeChain({ headIso: '2026-11-22T00:20:00', ops: EDGE_OPS });
    const orig = client.call;
    client.call = async (api, method, params) => {
      const o = override(method, params);
      return o === undefined ? orig(api, method, params) : o;
    };
    await assert.rejects(m.run({ client, date: DAY, historyFile: file, delegator: 'ecency', nowSec }), undefined, name);
    assert.equal(fs.existsSync(file), false, name);
  }
});

test('a date before the chain began is refused', async () => {
  const { client, nowSec } = fakeChain({ headIso: '2026-11-22T00:20:00' });
  await assert.rejects(m.run({ client, date: '2026-11-19', historyFile: path.join(tmpDir(), 'h'), delegator: 'ecency', nowSec }), /no blocks/);
});

test('absolute 5B and 15B tank counts are recorded next to the relative ones', () => {
  const now = Date.parse('2026-11-21T00:00:00Z') / 1000;
  const row = (account, max) => ({ account, max_rc: String(max), received_delegated_rc: '0', rc_manabar: { current_mana: String(max), last_update_time: now } });
  const s = m.summarize({
    date: DAY,
    authors: new Map([['a', { comment_ops: 1, root_ops: 0 }], ['b', { comment_ops: 1, root_ops: 0 }], ['c', { comment_ops: 1, root_ops: 0 }]]),
    rcAccounts: [row('a', 4.8 * B), row('b', 10 * B), row('c', 20 * B)],
    created: new Map(), avgCommentRc: 1.2 * B, ecencyDelegatees: new Set(), activeTopups: null, nowSec: now
  });
  assert.equal(s.max_below_5b, 1);
  assert.equal(s.max_below_15b, 2);
});

test('malformed RPC data aborts instead of lowering counts', async () => {
  const cases = {
    'header without timestamp': (method, params, orig) => (method === 'get_block_header' ? { header: { timestamp: 'garbage' } } : orig()),
    'block without transactions': async (method, params, orig) => {
      const r = await orig();
      if (method === 'get_block_range') delete r.blocks[5].transactions;
      return r;
    },
    'transaction without operations': async (method, params, orig) => {
      const r = await orig();
      if (method === 'get_block_range') r.blocks.forEach((b) => b.transactions.forEach((t) => { delete t.operations; }));
      return r;
    },
    'non-numeric RC': async (method, params, orig) => {
      const r = await orig();
      if (method === 'find_rc_accounts') r.rc_accounts[0].max_rc = 'x';
      return r;
    },
    'duplicate RC row in place of an author': async (method, params, orig) => {
      const r = await orig();
      if (method === 'find_rc_accounts' && r.rc_accounts.length > 1) r.rc_accounts[1] = r.rc_accounts[0];
      return r;
    },
    'infinite comment cost': (method, params, orig) => (method === 'get_rc_stats' ? { rc_stats: { ops: { comment_operation: { avg_cost: 'Infinity' } } } } : orig())
  };
  for (const [name, override] of Object.entries(cases)) {
    const file = path.join(tmpDir(), 'h');
    const { client, nowSec } = fakeChain({ headIso: '2026-11-22T00:20:00', ops: EDGE_OPS });
    const orig = client.call;
    client.call = async (api, method, params) => override(method, params, () => orig(api, method, params));
    await assert.rejects(m.run({ client, date: DAY, historyFile: file, delegator: 'ecency', nowSec }), /malformed|invalid|incomplete|not finite|no comment cost/i, name);
    assert.equal(fs.existsSync(file), false, name);
  }
});

test('the journal line names the short accounts', () => {
  const line = m.formatSummary({ date: DAY, authors: 2, below_1_comment: 1, below_3_comments: 1, max_below_5_comments: 1, max_below_5b: 1, max_below_15b: 1, holding_ecency_rc: 0, snapshot_hours_after_day_end: 0.3, active_topups: null, avg_comment_rc_b: 1.2, short: [{ name: 'alice' }, { name: 'bob' }] }, 'ecency');
  assert.match(line, /short: alice, bob/);
});
