// One-off: deliver premium-signup RC delegations that the create-account bot
// missed (it signed the rc custom_json with an active key - posting required).
//
// GUARD: never delegate a premium grant onto an account that holds an RC top-up.
// Top-ups and premium share the single DELEGATOR->user RC edge and delegate_rc
// REPLACES, so writing a 15B premium grant over a 16B top-up would wipe it (and
// make ePoints auto-refund a top-up that was actually delivered). Skip any
// delegatee that has an active top-up in ePoints OR a live top-up edge on-chain.
const dhive = require("@hiveio/dhive");
const https = require("https");

const DELEGATOR = process.env.DELEGATOR || "ecency";
const POSTING_WIF = process.env.POSTING_WIF;
const MAX_RC = 15000000000;
// Reserved top-up sentinel - keep in sync with ePoints RC_DELEGATION_AMOUNT and
// the delegator bot's RC_TOPUP_AMOUNT.
const TOPUP_AMOUNT = Number(process.env.RC_TOPUP_AMOUNT || 16000000000);
const EPOINTS_API = process.env.EPOINTS_API || "https://epoints.ecency.com";
const API_UA = process.env.EPOINTS_UA; // gated ePoints UA - set in the env file, never hardcode

const requested = process.argv.slice(2);
if (!POSTING_WIF || requested.length === 0) {
  console.error("usage: POSTING_WIF=... node backfill-premium-rc.js acc1 acc2 ...");
  process.exit(1);
}

const client = new dhive.Client([
  "https://hapi.ecency.com",
  "https://api.deathwing.me",
  "https://api.hive.blog",
  "https://rpc.mahdiyari.info",
]);

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: API_UA ? { "User-Agent": API_UA } : {}, timeout: 15000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`GET ${url} -> ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

async function currentRc(user) {
  const res = await client.call("rc_api", "list_rc_direct_delegations", {
    start: [DELEGATOR, user], limit: 1,
  });
  const row = ((res && res.rc_direct_delegations) || [])[0];
  if (row && row.from === DELEGATOR && row.to === user) return Number(row.delegated_rc || 0);
  return 0;
}

(async () => {
  // active top-up users from ePoints (skip outright, even if not yet delivered)
  const activeTopup = new Set();
  try {
    const rows = await httpGetJson(`${EPOINTS_API}/api/rc-delegations-all`);
    (Array.isArray(rows) ? rows : []).forEach((r) => r.user && activeTopup.add(r.user));
  } catch (e) {
    console.error("warn: could not fetch ePoints active top-ups; relying on on-chain check only:", e.message);
  }

  const delegatees = [];
  for (const user of requested) {
    if (activeTopup.has(user)) { console.log(`skip ${user}: active RC top-up (ePoints)`); continue; }
    const cur = await currentRc(user);
    if (cur === TOPUP_AMOUNT) { console.log(`skip ${user}: live top-up edge (${cur})`); continue; }
    delegatees.push(user);
  }

  if (delegatees.length === 0) { console.log("nothing to backfill after top-up filter."); return; }

  const key = dhive.PrivateKey.fromString(POSTING_WIF);
  const op = ["custom_json", {
    id: "rc",
    required_auths: [],
    required_posting_auths: [DELEGATOR],
    json: JSON.stringify(["delegate_rc", { from: DELEGATOR, delegatees, max_rc: MAX_RC }]),
  }];
  const res = await client.broadcast.sendOperations([op], key);
  console.log(`backfilled ${delegatees.length}/${requested.length}:`, delegatees, "id:", res.id);
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
