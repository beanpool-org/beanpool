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
    canOperateTreasury, canAdministerTreasury, keeperOf, treasuryKeepers,
    adminAssignTreasuryOperator, adminRevokeTreasuryOperator,
    getBalance, adminSetUserStatus, adminDeletePost, getAdminPubkey,
    transfer, createPost,
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
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, 'data:image/png;base64,iVBORw0KGgo=', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
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
    const offerRow = db.prepare('SELECT created_by FROM posts WHERE id=?').get(own.body.post.id) as any;
    assert(offerRow?.created_by === doone.pubKeyHex, 'offer post created_by records acting operator');

    // Keeper posts a Need, worker bids, keeper approves and completes — verifying audit trail
    const needRes = await signedFetch('POST', `/api/treasury/${eggs}/need`, doone, { title: 'Tend chickens', category: 'work', credits: 20 });
    assert(needRes.status === 200, `keeper posts a Need on enterprise (got ${needRes.status})`);
    const needRow = db.prepare('SELECT created_by FROM posts WHERE id=?').get(needRes.body.post.id) as any;
    assert(needRow?.created_by === doone.pubKeyHex, 'need post created_by records acting operator');

    const reqRes = await signedFetch('POST', `/api/marketplace/posts/request`, river, { postId: needRes.body.post.id, buyerPublicKey: river.pubKeyHex });
    assert(reqRes.status === 200, `worker bids on enterprise Need (got ${reqRes.status} ${reqRes.error ?? ''})`);
    const dealTxId = reqRes.body.transaction.id;

    // Verify treasury detail exposes pendingBids and activeDeals to operator, but hides them on unauthenticated read
    const unauthBeforeApprove = await fetch(`${BASE}/api/treasury/${eggs}`).then(r => r.json()) as any;
    assert(Array.isArray(unauthBeforeApprove.pendingBids) && unauthBeforeApprove.pendingBids.length === 0, 'public read hides pending bids');
    const detailBeforeApprove = (await signedFetch('GET', `/api/treasury/${eggs}`, doone)).body;
    assert(detailBeforeApprove.pendingBids?.some((b: any) => b.id === dealTxId), 'detail exposes pending bid on need to keeper');

    const approveRes = await signedFetch('POST', `/api/treasury/${eggs}/approve`, doone, { transactionId: dealTxId });
    assert(approveRes.status === 200, `keeper approves bid on enterprise Need (got ${approveRes.status})`);
    const escrowTxRow = db.prepare('SELECT auth_signer FROM transactions WHERE from_pubkey=? AND to_pubkey=?').get(eggs, `escrow_${dealTxId}`) as any;
    assert(escrowTxRow?.auth_signer === doone.pubKeyHex, 'escrow hold transaction auth_signer records acting operator');

    const unauthAfterApprove = await fetch(`${BASE}/api/treasury/${eggs}`).then(r => r.json()) as any;
    assert(Array.isArray(unauthAfterApprove.activeDeals) && unauthAfterApprove.activeDeals.length === 0, 'public read hides active deals');
    const detailAfterApprove = (await signedFetch('GET', `/api/treasury/${eggs}`, doone)).body;
    assert(detailAfterApprove.activeDeals?.some((d: any) => d.id === dealTxId), 'detail exposes active deal on need to keeper');

    const completeRes = await signedFetch('POST', `/api/treasury/${eggs}/complete`, doone, { transactionId: dealTxId });
    assert(completeRes.status === 200, `keeper completes deal on enterprise Need (got ${completeRes.status})`);
    const payoutTxRow = db.prepare('SELECT auth_signer FROM transactions WHERE from_pubkey=? AND to_pubkey=?').get(`escrow_${dealTxId}`, river.pubKeyHex) as any;
    assert(payoutTxRow?.auth_signer === doone.pubKeyHex, 'escrow payout transaction auth_signer records acting operator');

    // Sweep test with audit trail
    // Give eggs a positive balance to sweep via genesis transfer
    transfer('genesis', eggs, 50, 'seed test', 'direct', true);
    const sweepRes = await signedFetch('POST', `/api/treasury/${eggs}/sweep`, doone, { amount: 15 });
    assert(sweepRes.status === 200, `keeper sweeps surplus from enterprise (got ${sweepRes.status})`);
    const sweepTxRow = db.prepare("SELECT auth_signer FROM transactions WHERE from_pubkey=? AND to_pubkey='COMMONS_POOL' ORDER BY timestamp DESC LIMIT 1").get(eggs) as any;
    assert(sweepTxRow?.auth_signer === doone.pubKeyHex, 'sweep transaction auth_signer records acting operator');

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

    // ── 8. Admin cannot SPEND an enterprise's money; administration/moderation preserved ──
    const admin = makeIdentity('genesis-admin');
    db.prepare("UPDATE members SET invited_by = 'genesis' WHERE public_key = ?").run(admin.pubKeyHex);
    assert(getAdminPubkey() === admin.pubKeyHex, 'genesis-admin is recognized as node admin');

    // Admin without binding cannot spend:
    assert(canOperateTreasury(admin.pubKeyHex, eggs) === false, 'admin without binding cannot operate Eggs treasury');
    assert(canAdministerTreasury(admin.pubKeyHex, eggs) === true, 'admin CAN administer Eggs treasury (repair / moderation)');
    assert(keeperOf(admin.pubKeyHex).length === 0, 'admin without binding keeps no enterprises');

    // Refused on all 5 spending routes on live server:
    for (const [route, payload] of [
        ['offer', { title: 'Admin eggs', category: 'food', credits: 10 }],
        ['need', { title: 'Admin need', category: 'food', credits: 20 }],
        ['approve', { transactionId: 'any-id' }],
        ['complete', { transactionId: 'any-id' }],
        ['sweep', { amount: 1 }],
    ] as Array<[string, any]>) {
        const r = await signedFetch('POST', `/api/treasury/${eggs}/${route}`, admin, payload);
        assert(r.status === 403, `admin without keeper binding is REFUSED on /api/treasury/:treasury/${route} (got ${r.status} ${r.error ?? ''})`);
    }

    // Repair and moderation actions succeed for admin:
    adminSetUserStatus(eggs, 'disabled');
    const pausedOffer = await signedFetch('POST', `/api/treasury/${eggs}/offer`, doone, { title: 'Paused eggs', category: 'food', credits: 10 });
    assert(pausedOffer.status === 403 && Boolean(pausedOffer.error?.startsWith('This enterprise has been closed')), `pausing enterprise blocks route operations (got ${pausedOffer.status} "${pausedOffer.error}")`);
    adminSetUserStatus(eggs, 'active');
    const unpausedOffer = await signedFetch('POST', `/api/treasury/${eggs}/offer`, doone, { title: 'Unpaused eggs', category: 'food', credits: 10 });
    assert(unpausedOffer.status === 200, 'unpausing enterprise restores keeper operations');

    // Admin legitimately appointed to keep an enterprise:
    adminAssignTreasuryOperator(eggs, admin.pubKeyHex, 'admin');
    const bindingRow = db.prepare('SELECT granted_by FROM treasury_operators WHERE member_pubkey = ? AND treasury_pubkey = ?').get(admin.pubKeyHex, eggs) as any;
    assert(bindingRow?.granted_by === 'admin', 'admin appointment recorded with granted_by = admin in treasury_operators');
    assert(canOperateTreasury(admin.pubKeyHex, eggs) === true, 'appointed admin can now operate Eggs');
    assert(keeperOf(admin.pubKeyHex).includes(eggs), 'appointed admin lists Eggs in keeperOf');

    // Appointed admin can now spend:
    const adminOffer = await signedFetch('POST', `/api/treasury/${eggs}/offer`, admin, { title: 'Admin posted offer', category: 'food', credits: 15 });
    assert(adminOffer.status === 200, `appointed admin can post offer (got ${adminOffer.status})`);
    if (adminOffer.body?.post?.id) {
        const deleted = adminDeletePost(adminOffer.body.post.id);
        assert(deleted === true, 'admin can take down / delete listing');
        const postRow = db.prepare('SELECT status, active FROM posts WHERE id = ?').get(adminOffer.body.post.id) as any;
        assert(postRow?.status === 'cancelled' && postRow?.active === 0, 'listing is cancelled after admin takedown');
    }

    // Revoking removes spending again:
    adminRevokeTreasuryOperator(eggs, admin.pubKeyHex);
    assert(canOperateTreasury(admin.pubKeyHex, eggs) === false, 'revoking admin appointment removes spending authority');
    const afterRevokeOffer = await signedFetch('POST', `/api/treasury/${eggs}/offer`, admin, { title: 'Admin post after revoke', category: 'food', credits: 15 });
    assert(afterRevokeOffer.status === 403, `revoked admin is REFUSED again on spend route (got ${afterRevokeOffer.status})`);

    // ── 9. Two-person rule & self-dealing guard for enterprise Needs ───────────
    const bakery = createTreasury('CommunityBakery', 'data:image/png;base64,iVBORw0KGgo=', 200).publicKey;
    const alice = makeIdentity('alice');
    const bob = makeIdentity('bob');

    adminAssignTreasuryOperator(bakery, alice.pubKeyHex, 'admin');

    // Keeper Alice posts Offer then Need for Bakery
    const bakeryOffer = await signedFetch('POST', `/api/treasury/${bakery}/offer`, alice, { title: 'Sourdough loaf', category: 'food', credits: 8 });
    assert(bakeryOffer.status === 200, 'Alice posts offer on Bakery');
    const bakeryNeed = await signedFetch('POST', `/api/treasury/${bakery}/need`, alice, { title: 'Bake morning bread', category: 'work', credits: 30 });
    assert(bakeryNeed.status === 200, 'Alice posts need on Bakery');

    // Under Rules 5 & 6 (PR #775), enterprises cannot borrow into credit to pay keepers;
    // keeper wages require positive balance and earned surplus. Seed Bakery with surplus
    // so the two-person rule approval/completion workflow can be exercised.
    transfer('genesis', bakery, 100, 'seed bakery balance', 'direct', true);
    db.prepare('UPDATE members SET earned_surplus = 100 WHERE public_key = ?').run(bakery);

    // Keeper Alice bids on the need from her personal account
    const aliceBid = await signedFetch('POST', '/api/marketplace/posts/request', alice, { postId: bakeryNeed.body.post.id, buyerPublicKey: alice.pubKeyHex });
    assert(aliceBid.status === 200, 'Alice bids on Bakery need from personal account');
    const selfDealTxId = aliceBid.body.transaction.id;

    // Keeper Alice tries to approve her own bid -> REFUSED (403, friendly copy)
    const selfApprove = await signedFetch('POST', `/api/treasury/${bakery}/approve`, alice, { transactionId: selfDealTxId });
    assert(selfApprove.status === 403, `Alice approving own bid is REFUSED 403 (got ${selfApprove.status})`);
    assert(selfApprove.error === 'Another keeper of CommunityBakery needs to approve this — you cannot approve a job you are being paid for.',
        `friendly refusal on self-approve: "${selfApprove.error}"`);

    // Appoint Bob as second keeper: Bob approves Alice's bid -> SUCCEEDS
    adminAssignTreasuryOperator(bakery, bob.pubKeyHex, 'admin');
    const bobApprove = await signedFetch('POST', `/api/treasury/${bakery}/approve`, bob, { transactionId: selfDealTxId });
    assert(bobApprove.status === 200, `second keeper Bob approves Alice's bid (got ${bobApprove.status})`);

    // Keeper Alice tries to complete and pay herself -> REFUSED (403, friendly copy)
    const selfComplete = await signedFetch('POST', `/api/treasury/${bakery}/complete`, alice, { transactionId: selfDealTxId });
    assert(selfComplete.status === 403, `Alice completing deal paying herself is REFUSED 403 (got ${selfComplete.status})`);
    assert(selfComplete.error === 'Another keeper of CommunityBakery needs to complete this — you cannot complete a job you are being paid for.',
        `friendly refusal on self-complete: "${selfComplete.error}"`);

    // Keeper Bob completes and pays Alice -> SUCCEEDS
    const bobComplete = await signedFetch('POST', `/api/treasury/${bakery}/complete`, bob, { transactionId: selfDealTxId });
    assert(bobComplete.status === 200, `second keeper Bob completes deal paying Alice (got ${bobComplete.status})`);
    // Alice receives payout (30 minus 1.5% fee = 29.55)
    assert(getBalance(alice.pubKeyHex).balance === 29.55, 'Alice received payment minus fee');

    // Single-keeper enterprise: sole keeper cannot approve own bid -> REFUSED
    const solo = createTreasury('SoloEnterprise', 'data:image/png;base64,iVBORw0KGgo=', 200).publicKey;
    const charlie = makeIdentity('charlie');
    adminAssignTreasuryOperator(solo, charlie.pubKeyHex, 'admin');
    await signedFetch('POST', `/api/treasury/${solo}/offer`, charlie, { title: 'Solo item', category: 'goods', credits: 10 });
    const soloNeed = await signedFetch('POST', `/api/treasury/${solo}/need`, charlie, { title: 'Solo errand', category: 'work', credits: 20 });
    const soloBid = await signedFetch('POST', '/api/marketplace/posts/request', charlie, { postId: soloNeed.body.post.id, buyerPublicKey: charlie.pubKeyHex });
    const soloApprove = await signedFetch('POST', `/api/treasury/${solo}/approve`, charlie, { transactionId: soloBid.body.transaction.id });
    assert(soloApprove.status === 403, `single keeper cannot approve own bid (got ${soloApprove.status})`);
    assert(soloApprove.error === 'Another keeper of SoloEnterprise needs to approve this — you cannot approve a job you are being paid for.',
        'single keeper gets friendly copy naming enterprise');

    // Non-enterprise deals (peer to peer) are UNTOUCHED by this rule:
    transfer('genesis', charlie.pubKeyHex, 100, 'seed charlie for escrow', 'direct', true);
    createPost('offer', 'help', 'Charlie gardening', 'Garden help', 10, 'fixed', charlie.pubKeyHex);
    const peerNeed = createPost('need', 'help', 'Help Charlie move', 'Moving boxes', 15, 'fixed', charlie.pubKeyHex);
    assert(peerNeed !== null, 'Charlie creates personal need');
    const dave = makeIdentity('dave');
    const daveBid = await signedFetch('POST', '/api/marketplace/posts/request', dave, { postId: peerNeed!.id, buyerPublicKey: dave.pubKeyHex });
    assert(daveBid.status === 200, 'Dave bids on Charlie personal need');
    const peerApprove = await signedFetch('POST', '/api/marketplace/transactions/approve', charlie, { transactionId: daveBid.body.transaction.id, authorPublicKey: charlie.pubKeyHex });
    assert(peerApprove.status === 200, `peer-to-peer personal need approval succeeds (got ${peerApprove.status})`);
    const peerComplete = await signedFetch('POST', '/api/marketplace/transactions/complete', charlie, { transactionId: daveBid.body.transaction.id, confirmerPublicKey: charlie.pubKeyHex });
    assert(peerComplete.status === 200, `peer-to-peer personal need completion succeeds (got ${peerComplete.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Per-enterprise keepership checks PASSED (#106).');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
