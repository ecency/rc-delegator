// RC (Un)Delegator for @ecency  -  two jobs from ONE bot, ONE posting key:
//
//   1) RC TOP-UPS (always, light, idempotent): give RC to users with an active
//      purchased top-up (ePoints /api/rc-delegations-all) and reclaim it when
//      their top-up expires (ePoints /api/rc-delegations-expired). Safe to run
//      every few minutes -> near-instant delivery.
//
//   2) PREMIUM CLEANUP (only when RUN_CLEANUP=1, heavy, daily): the original
//      job - reclaim RC from premium-signup accounts created >= 90 days ago.
//
// Usage:
//   HIVE_NODE=https://hapi.ecency.com \
//   DELEGATOR=ecency \
//   POSTING_WIF=5K... \
//   EPOINTS_API=https://epoints.ecency.com \
//   RUN_CLEANUP=1            # only on the daily run
//   DRY_RUN=1               # log, don't broadcast
//   node index.js

const dhive = require('@hiveio/dhive');
const https = require('https');

const HIVE_NODE   = process.env.HIVE_NODE || 'https://hapi.ecency.com';
const DELEGATOR   = process.env.DELEGATOR || 'ecency';        // required
const POSTING_WIF = process.env.POSTING_WIF;      // required (posting key)
const DRY_RUN     = process.env.DRY_RUN === '1';  // optional dry-run
const RUN_CLEANUP = process.env.RUN_CLEANUP === '1';          // run 90-day cleanup
const EPOINTS_API = process.env.EPOINTS_API || 'https://epoints.ecency.com';
const API_UA      = process.env.EPOINTS_UA; // gated ePoints UA - set in the env file, never hardcode
// Reserved sentinel: the EXACT RC amount a top-up delegates. @ecency never
// delegates this amount for anything else (premium-signup grants are 15B/8.116B),
// so the cleanup leaves any edge at this exact amount untouched. Keep in sync
// with ePoints RC_DELEGATION_AMOUNT.
const RC_TOPUP_AMOUNT = Number(process.env.RC_TOPUP_AMOUNT || 16_000_000_000);

if (!POSTING_WIF) {
  console.error('Please set POSTING_WIF and matching DELEGATOR env vars.');
  process.exit(1);
}

if (!API_UA) {
  console.warn('EPOINTS_UA not set; gated RC top-up endpoints will be skipped (premium cleanup still runs).');
}

const client = new dhive.Client([HIVE_NODE, 'https://api.openhive.network', 'https://techcoderx.com', 'https://rpc.mahdiyari.info'], { timeout: 8_000 });

const DAYS_90_MS = 90 * 24 * 60 * 60 * 1000;

async function listAllDirectDelegations(fromAccount) {
  const limit = 1000;
  let startTo = '';
  const all = [];

  while (true) {
    const res = await client.call('rc_api', 'list_rc_direct_delegations', {
      start: [fromAccount, startTo],
      limit
    });

    const items = (res && res.rc_direct_delegations) || [];
    // Filter just the rows from our delegator (pagination can roll over)
    const ours = items.filter(it => it.from === fromAccount);
    if (ours.length === 0) break;

    all.push(...ours);

    if (ours.length < limit) break;
    // continue from the last "to"
    startTo = ours[ours.length - 1].to;
  }

  return all;
}

async function getAccounts(names) {
  // Array of names
  const chunks = [];
  for (let i = 0; i < names.length; i += 100) chunks.push(names.slice(i, i + 100));

  const out = new Map();
  for (const ch of chunks) {
    const res = await client.call('condenser_api', 'get_accounts', [ch]);
    (res || []).forEach(acc => out.set(acc.name, acc));
  }
  return out;
}

function is90DaysOld(creationISO) {
  const createdAt = new Date(creationISO + 'Z'); // ensure UTC
  return (Date.now() - createdAt.getTime()) >= DAYS_90_MS;
}

async function undelegateBatch(delegatees) {
  if (delegatees.length === 0) return { ok: [], errors: [] };

  // Include up to 100 delegatees per op (per RC rules).
  const batches = [];
  for (let i = 0; i < delegatees.length; i += 100) {
    batches.push(delegatees.slice(i, i + 100));
  }

  const key = dhive.PrivateKey.fromString(POSTING_WIF);
  const ok = [], errors = [];

  for (const batch of batches) {
    const json = JSON.stringify([
      'delegate_rc',
      {
        from: DELEGATOR,
        delegatees: batch,
        max_rc: 0 // undelegate
      }
    ]);

    const op = [
      'custom_json',
      {
        id: 'rc',
        required_auths: [],
        required_posting_auths: [DELEGATOR],
        json
      }
    ];

    if (DRY_RUN) {
      console.log('[DRY_RUN] Would broadcast custom_json rc delegate_rc -> 0 for:', batch);
      ok.push(...batch);
      continue;
    }

    try {
      const tx = await client.broadcast.sendOperations([op], key);
      console.log('Broadcasted undelegation for:', batch, 'tx:', tx.id);
      ok.push(...batch);
    } catch (e) {
      console.error('Failed undelegation for batch', batch, e?.message || e);
      errors.push({ batch, error: String(e?.message || e) });
    }
  }

  return { ok, errors };
}

// ---------------------------------------------------------------------------
// RC TOP-UPS (Ecency Points purchases)
// ---------------------------------------------------------------------------

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: API_UA ? { 'User-Agent': API_UA } : {}, timeout: 15_000 }, (res) => {
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

// Delegate a fixed RC amount to a batch of users (<=100 delegatees per op).
async function delegateRcBatch(users, maxRc) {
  if (users.length === 0) return { ok: [], errors: [] };

  const key = dhive.PrivateKey.fromString(POSTING_WIF);
  const ok = [], errors = [];

  for (let i = 0; i < users.length; i += 100) {
    const batch = users.slice(i, i + 100);

    const json = JSON.stringify([
      'delegate_rc',
      {
        from: DELEGATOR,
        delegatees: batch,
        max_rc: maxRc
      }
    ]);

    const op = [
      'custom_json',
      {
        id: 'rc',
        required_auths: [],
        required_posting_auths: [DELEGATOR],
        json
      }
    ];

    if (DRY_RUN) {
      console.log(`[DRY_RUN] Would broadcast delegate_rc -> ${maxRc} for:`, batch);
      ok.push(...batch);
      continue;
    }

    try {
      const tx = await client.broadcast.sendOperations([op], key);
      console.log(`Delegated ${maxRc} RC to:`, batch, 'tx:', tx.id);
      ok.push(...batch);
    } catch (e) {
      console.error('Failed delegation for batch', batch, e?.message || e);
      errors.push({ batch, error: String(e?.message || e) });
    }
  }

  return { ok, errors };
}

async function runRcTopups() {
  let active = [];
  let expired = [];
  try {
    active = await httpGetJson(`${EPOINTS_API}/api/rc-delegations-all`);
    expired = await httpGetJson(`${EPOINTS_API}/api/rc-delegations-expired?limit=1000`);
  } catch (e) {
    console.error('RC top-up: failed to fetch ePoints state:', e?.message || e);
    return new Set();
  }
  active = Array.isArray(active) ? active : [];
  expired = Array.isArray(expired) ? expired : [];
  // every user that currently has a top-up (active or recently expired); the
  // cleanup uses this to never reclaim a paid top-up edge.
  const topupUsers = new Set([...active, ...expired].map((r) => r.user).filter(Boolean));
  console.log(`RC top-up: ${active.length} active, ${expired.length} expired (recent).`);

  // Live direct RC delegations from @ecency: user -> delegated_rc
  const current = new Map();
  try {
    const rows = await listAllDirectDelegations(DELEGATOR);
    rows.forEach((r) => current.set(r.to, Number(r.delegated_rc || 0)));
  } catch (e) {
    console.error('RC top-up: failed to list current delegations:', e?.message || e);
    return topupUsers;
  }

  // DELEGATE active top-ups, grouped by amount (op needs one max_rc per batch).
  // Deliver ONLY onto an empty edge: delegate_rc REPLACES, so we must never write
  // over an existing premium-signup grant (which shares the one ecency->user edge).
  const byAmount = new Map(); // amount -> [users]
  for (const row of active) {
    const user = row.user;
    const amount = Number(row.amount || 0);
    if (!user || !(amount > 0)) continue;
    const cur = current.get(user) || 0;
    if (cur === 0) {
      // empty edge -> safe to deliver the top-up
      if (!byAmount.has(amount)) byAmount.set(amount, []);
      byAmount.get(amount).push(user);
    } else if (cur === amount) {
      // already delivered -> idempotent, nothing to do
    } else {
      // user already holds a DIFFERENT (e.g. premium) ecency->user delegation;
      // delegating would overwrite it. Never do that. ePoints should have blocked
      // this purchase up front - log loudly so the case is visible.
      console.warn(`RC top-up: SKIP ${user} - existing non-topup delegation ${cur} (expected 0 or ${amount}); not overwriting.`);
    }
  }
  for (const [amount, users] of byAmount) {
    await delegateRcBatch(users, amount);
  }

  // RECLAIM expired top-ups -> max_rc 0. Skip anyone who still has an active
  // top-up, and reclaim ONLY an exact top-up edge (current === the top-up amount)
  // so a premium-signup grant of a different size is never zeroed.
  const activeUsers = new Set(active.map((r) => r.user));
  const toReclaim = [];
  for (const row of expired) {
    const user = row.user;
    const amount = Number(row.amount || 0);
    if (!user || activeUsers.has(user)) continue;
    const cur = current.get(user) || 0;
    if (amount > 0 && cur === amount) toReclaim.push(user);
  }
  if (toReclaim.length > 0) {
    await undelegateBatch(toReclaim);
  }

  return topupUsers;
}

// ---------------------------------------------------------------------------
// PREMIUM CLEANUP (original job): reclaim RC from accounts >= 90 days old
// ---------------------------------------------------------------------------

async function runPremiumCleanup(topupUsers = new Set()) {
  // 1) Fetch delegations out of DELEGATOR
  const delegations = await listAllDirectDelegations(DELEGATOR);
  console.log(`Found ${delegations.length} direct RC delegations from @${DELEGATOR}.`);

  if (delegations.length === 0) return;

  // live delegated_rc per delegatee, so we can leave top-up edges (the reserved
  // sentinel amount) untouched by the 90-day premium reclaim.
  const rcByName = new Map();
  delegations.forEach(d => rcByName.set(d.to, Number(d.delegated_rc || 0)));

  // 2) Load account info for all delegatees
  const delegateeNames = [...new Set(delegations.map(d => d.to))];
  const accMap = await getAccounts(delegateeNames);

  // 3) Filter those created >= 90 days ago
  const now = new Date();
  const cutoff = new Date(Date.now() - DAYS_90_MS);
  console.log(`Cutoff date: ${cutoff.toISOString().slice(0, 10)} (90 days ago from ${now.toISOString().slice(0,10)})`);

  const eligible = delegateeNames.filter(name => {
    // never reclaim a top-up: the reserved-amount edge, or a known active/expired
    // top-up user from ePoints (belt and suspenders if the amount ever drifts).
    if (rcByName.get(name) === RC_TOPUP_AMOUNT) return false;
    if (topupUsers.has(name)) return false;
    const acc = accMap.get(name);
    if (!acc) return false;
    return is90DaysOld(acc.created);
  });

  console.log(`Eligible for undelegation (created >= 90 days ago, excl top-ups): ${eligible.length}/${delegateeNames.length}`);
  if (eligible.length === 0) return;

  // 4) Broadcast custom_json undelegations (max 100 per op)
  const { ok, errors } = await undelegateBatch(eligible);

  console.log('Undelegated (intended):', ok.length);
  if (errors.length) {
    console.log('Errors:', errors);
  }
}

(async function main() {
  console.log('Node:', HIVE_NODE);
  console.log('Delegator:', DELEGATOR);
  console.log('Mode:', DRY_RUN ? 'DRY RUN' : 'LIVE');

  // 1) RC top-ups (purchased) - light + idempotent, safe to run frequently.
  const topupUsers = await runRcTopups();

  // 2) Premium-signup RC cleanup (>= 90 days) - heavy; only on the daily run.
  // Pass the top-up users so cleanup never reclaims a paid top-up edge.
  if (RUN_CLEANUP) {
    await runPremiumCleanup(topupUsers);
  } else {
    console.log('RUN_CLEANUP not set; skipping 90-day premium cleanup.');
  }
})();
