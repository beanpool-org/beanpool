/**
 * Per-enterprise keepership (#106) against the REAL server.
 *
 * `members.can_operate` was a node-wide boolean: `requireOperator` checked that the actor was *an*
 * operator and the target was *a* treasury, never that the two were related. So appointing someone
 * to run the egg flock also handed them every other enterprise on the node.
 *
 * Authority is now `can_operate = 1` AND a `treasury_operators` row. These checks pin the four
 * acceptance criteria from the issue:
 *
 *   1. A keeper bound to enterprise A cannot post/approve/complete/sweep on enterprise B.
 *   2. Admin can assign and revoke per-enterprise, effective without a restart.
 *   3. Existing operators keep working after migration.
 *   4. Members can see who keeps a given enterprise.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-treasury-keepership.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, adminSetOperator,
    canOperateTreasury, keeperOf, treasuryKeepers,
    adminAssignTreasuryOperator, adminRevokeTreasuryOperator,
    getBalance,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db, seedTreasuryOperatorsFromLegacyFlag } from './db/db.js';

const PORT = 8549;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function makeIdentity(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'GET' | 'POST', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, error: json?.error as string | undefined, body: json };
}

async function main() {
    console.log('Running per-enterprise keepership tests (#106)...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // Two enterprises and two members.
    const eggs = createTreasury('CommunityEggs', 'data:image/png;base64,iVBORw0KGgo=', 200).publicKey;
    const wood = createTreasury('FirewoodCoop', 'data:image/png;base64,iVBORw0KGgo=', 200).publicKey;
    const doone = makeIdentity('doone');
    const river = makeIdentity('riverbend');

    // ── 1. Scoping — the whole point of the issue ────────────────────────────────
    adminAssignTreasuryOperator(eggs, doone.pubKeyHex, 'admin');
    adminAssignTreasuryOperator(wood, river.pubKeyHex, 'admin');

    assert(canOperateTreasury(doone.pubKeyHex, eggs) === true, 'a keeper of Eggs may drive Eggs');
    assert(canOperateTreasury(doone.pubKeyHex, wood) === false, 'a keeper of Eggs may NOT drive Firewood');
    assert(canOperateTreasury(river.pubKeyHex, wood) === true, 'a keeper of Firewood may drive Firewood');
    assert(canOperateTreasury(river.pubKeyHex, eggs) === false, 'a keeper of Firewood may NOT drive Eggs');

    // Every operator-gated route, not just one — a scope check is only as good as its coverage.
    const offer = { title: 'Dozen eggs', category: 'food', credits: 12 };
    const own = await signedFetch('POST', `/api/treasury/${eggs}/offer`, doone, offer);
    assert(own.status === 200, `keeper posts an Offer on their OWN enterprise (got ${own.status} ${own.error ?? ''})`);

    for (const [route, payload] of [
        ['offer', offer],
        ['need', { title: 'Tend the chickens', category: 'food', credits: 40 }],
        ['approve', { transactionId: 'does-not-matter' }],
        ['complete', { transactionId: 'does-not-matter' }],
        ['sweep', { amount: 1 }],
    ] as Array<[string, any]>) {
        const r = await signedFetch('POST', `/api/treasury/${wood}/${route}`, doone, payload);
        assert(r.status === 403, `cross-enterprise ${route} is REFUSED (got ${r.status} ${r.error ?? ''})`);
    }

    // A non-treasury target is a 404, not a 403 — it isn't a permission problem.
    const notT = await signedFetch('POST', `/api/treasury/${river.pubKeyHex}/offer`, doone, offer);
    assert(notT.status === 404, `a non-treasury target is 404, not 403 (got ${notT.status})`);

    // ── 2. The client signal is a list, not a boolean ────────────────────────────
    const dBal = getBalance(doone.pubKeyHex);
    assert(Array.isArray(dBal.keeperOf), 'getBalance exposes keeperOf as an array');
    assert(dBal.keeperOf.length === 1 && dBal.keeperOf[0] === eggs, 'keeperOf lists only the enterprise they keeper');
    assert(dBal.canOperate === true, 'canOperate stays true as the coarse "is a keeper" flag');

    // ── 3. Transparency — members can see who keepers what ─────────────────────
    const pub = await fetch(`${BASE}/api/treasury/${eggs}`).then(r => r.json()) as any;
    assert(Array.isArray(pub.keepers), 'public treasury detail exposes keepers');
    assert(pub.keepers.length === 1 && pub.keepers[0].callsign === 'doone', 'keepers names the accountable member');
    const list = await fetch(`${BASE}/api/treasuries`).then(r => r.json()) as any;
    assert(list.treasuries.every((t: any) => Array.isArray(t.keepers)), 'treasury list carries keepers per enterprise');

    // ── 4. Revoke takes effect with no restart ──────────────────────────────────
    adminRevokeTreasuryOperator(eggs, doone.pubKeyHex);
    assert(canOperateTreasury(doone.pubKeyHex, eggs) === false, 'revoke removes authority immediately');
    const afterRevoke = await signedFetch('POST', `/api/treasury/${eggs}/offer`, doone, offer);
    assert(afterRevoke.status === 403, `revoked keeper is refused on the live server (got ${afterRevoke.status})`);
    assert(getBalance(doone.pubKeyHex).canOperate === false, 'can_operate clears once a member keepers nothing');
    assert(treasuryKeepers(eggs).length === 0, 'the public keeper list empties on revoke');

    // ── 5. The master switch suspends without losing assignments ────────────────
    adminSetOperator(river.pubKeyHex, false);
    assert(canOperateTreasury(river.pubKeyHex, wood) === false, 'clearing can_operate suspends a keeper node-wide');
    assert(keeperOf(river.pubKeyHex).length === 0, 'a suspended keeper reports no enterprises');
    assert(
        !!db.prepare('SELECT 1 FROM treasury_operators WHERE member_pubkey=? AND treasury_pubkey=?').get(river.pubKeyHex, wood),
        'the binding SURVIVES suspension — suspend is not revoke',
    );
    adminSetOperator(river.pubKeyHex, true);
    assert(canOperateTreasury(river.pubKeyHex, wood) === true, 're-enabling restores the existing binding');

    // ── 6. Guards ───────────────────────────────────────────────────────────────
    let threw = '';
    try { adminAssignTreasuryOperator(river.pubKeyHex, doone.pubKeyHex, 'admin'); } catch (e: any) { threw = e.message; }
    assert(/not a treasury/i.test(threw), `assigning against a non-treasury is refused (got "${threw}")`);
    threw = '';
    try { adminAssignTreasuryOperator(eggs, wood, 'admin'); } catch (e: any) { threw = e.message; }
    assert(/cannot keep another treasury/i.test(threw), `a treasury cannot keep another treasury (got "${threw}")`);

    // ── 7. Migration — existing operators keep working ──────────────────────────
    // Simulate a pre-#106 node: legacy flag set, no bindings.
    db.prepare('DELETE FROM treasury_operators').run();
    adminSetOperator(doone.pubKeyHex, true);
    assert(canOperateTreasury(doone.pubKeyHex, eggs) === false, 'pre-migration: the legacy flag alone grants nothing');

    // Expect the rule (legacy operators × enterprises), not a magic number — earlier steps in this
    // file change how many members hold the flag.
    const legacyCount = (db.prepare('SELECT COUNT(*) AS c FROM members WHERE can_operate = 1').get() as any).c;
    const treasuryCount = (db.prepare('SELECT COUNT(*) AS c FROM members WHERE is_treasury = 1').get() as any).c;
    const written = seedTreasuryOperatorsFromLegacyFlag();
    assert(
        written === legacyCount * treasuryCount,
        `migration over-grants one row per enterprise: ${legacyCount} keeper(s) × ${treasuryCount} enterprise(s) = ${legacyCount * treasuryCount} (wrote ${written})`,
    );
    assert(canOperateTreasury(doone.pubKeyHex, eggs) === true, 'post-migration: an existing operator keeps Eggs');
    assert(canOperateTreasury(doone.pubKeyHex, wood) === true, 'post-migration: and keeps Firewood — pruning is the admin\'s job');

    // Re-running must not resurrect what an admin pruned.
    adminRevokeTreasuryOperator(wood, doone.pubKeyHex);
    const again = seedTreasuryOperatorsFromLegacyFlag();
    assert(again === 0, `migration is a no-op once the table is non-empty (wrote ${again})`);
    assert(canOperateTreasury(doone.pubKeyHex, wood) === false, 'a pruned binding STAYS pruned across re-runs');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Per-enterprise keepership checks PASSED (#106).');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
