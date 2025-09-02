// Simple RC (Un)Delegator
// Usage:
//   HIVE_NODE=https://api.hive.blog \
//   DELEGATOR=username \
//   POSTING_WIF=5K... \
//   DRY_RUN=1 \
//   node index.js
//
// Remove DRY_RUN to actually broadcast.

const dhive = require('@hiveio/dhive');

const HIVE_NODE   = process.env.HIVE_NODE || 'https://api.hive.blog';
const DELEGATOR   = process.env.DELEGATOR || 'ecency';        // required
const POSTING_WIF = process.env.POSTING_WIF;      // required (posting key)
const DRY_RUN     = process.env.DRY_RUN === '1';  // optional dry-run

if (!POSTING_WIF) {
  console.error('Please set POSTING_WIF and matching DELEGATOR env vars.');
  process.exit(1);
}

const client = new dhive.Client([HIVE_NODE], { timeout: 8_000 });

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

(async function main() {
  console.log('Node:', HIVE_NODE);
  console.log('Delegator:', DELEGATOR);
  console.log('Mode:', DRY_RUN ? 'DRY RUN' : 'LIVE');

  // 1) Fetch delegations out of DELEGATOR
  const delegations = await listAllDirectDelegations(DELEGATOR);
  console.log(`Found ${delegations.length} direct RC delegations from @${DELEGATOR}.`);

  if (delegations.length === 0) return;

  // 2) Load account info for all delegatees
  const delegateeNames = [...new Set(delegations.map(d => d.to))];
  const accMap = await getAccounts(delegateeNames);

  // 3) Filter those created ≥ 90 days ago
  const now = new Date();
  const cutoff = new Date(Date.now() - DAYS_90_MS);
  console.log(`Cutoff date: ${cutoff.toISOString().slice(0, 10)} (90 days ago from ${now.toISOString().slice(0,10)})`);

  const eligible = delegateeNames.filter(name => {
    const acc = accMap.get(name);
    if (!acc) return false;
    return is90DaysOld(acc.created);
  });

  console.log(`Eligible for undelegation (created ≥ 90 days ago): ${eligible.length}/${delegateeNames.length}`);
  if (eligible.length === 0) return;

  // 4) Broadcast custom_json undelegations (max 100 per op)
  const { ok, errors } = await undelegateBatch(eligible);

  console.log('Undelegated (intended):', ok.length);
  if (errors.length) {
    console.log('Errors:', errors);
  }
})();
