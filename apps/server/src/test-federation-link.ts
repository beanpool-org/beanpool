/**
 * Federation link enterprises (#143, slice step 3) — a peer relationship with a treasury, a keeper and a
 * visible energy balance.
 *
 * WHAT THIS SUITE IS GUARDING. Steps 1 and 2 proved the tab moves in both directions, but nothing in the app
 * showed it to anyone: a community could be owed 480 beans of work and have no way to find out, and nobody
 * was accountable for acting on it. §7 answers that with an enterprise per peer, created at the moment a cap
 * is set. So the assertions here are mostly about a number reaching a member's screen with the right sign,
 * and about the two balances on a link never being confused for each other:
 *
 *   energy balance = `bridge_<peer>` — what we owe / are owed. NOT spendable (§2.2).
 *   treasury       = the link's own account — real beans a keeper commissions with (step 5).
 *
 * Over a real HTTPS server, not the router handlers: the #144 review caught a route that 403'd on every real
 * request while 36 handler-level checks passed.
 *
 * Run with a throwaway data dir (self-signed TLS):
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-federation-link.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!';

import fs from 'node:fs';
import path from 'node:path';
import { initTls } from './services/tls.js';
import { initStateEngine, createTreasury } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { loadConnectors } from './connector-manager.js';
import {
    getFederationLink, getLinkByTreasury, listFederationLinks, reconcileFederationLinks, linkNameFor,
    ensureFederationLink,
} from './federation-link.js';
import { bridgeAccountId } from './federation-bridge.js';

const PORT = 8552;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestAdmin123!';

const PEER_ID = '12D3KooWEastGippyLinkTestPeer00000000000000';
const ADDRESS = `/ip4/172.18.0.4/tcp/4001/p2p/${PEER_ID}`;
// A second peer whose operator chose the SAME callsign, to prove a name collision cannot block a link.
const PEER_ID_2 = '12D3KooWSecondPeerSameCallsign000000000000';
const ADDRESS_2 = `/ip4/172.18.0.9/tcp/4001/p2p/${PEER_ID_2}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, json };
}
async function get(path: string): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}${path}`);
    let json: any = null;
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, json };
}

const setCap = (body: Record<string, unknown>) => post('/api/local/connectors/credit-cap', body);
const setCeiling = (body: Record<string, unknown>) => post('/api/local/federation/links/ceiling', body);

const nodeTotal = (): number =>
    (db.prepare('SELECT COALESCE(SUM(balance),0) AS t FROM accounts').get() as any).t;

/**
 * Move beans into a peer's bridge account WITHOUT minting any, so the energy-balance read can be exercised
 * against a non-zero tab while the ledger still sums to where it started. A real trade does exactly this
 * shape (escrow → bridge); this is the same paired write with the trade left out.
 */
function tiltBridge(peerId: string, amount: number): void {
    db.transaction(() => {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE public_key = ?').run(amount, bridgeAccountId(peerId));
        db.prepare('UPDATE accounts SET balance = balance - ? WHERE public_key = ?').run(amount, 'COMMONS_POOL');
    })();
}

/**
 * A peer with a cap already on disk BEFORE anything boots — which is what every already-configured node looks
 * like, and the case that shipped broken.
 *
 * The reconcile lived in `initStateEngine`, which runs before `initConnectorManager` loads connectors.json, so
 * it iterated an empty list and created nothing. The rest of this suite added connectors over HTTP *after*
 * boot, where the cap route's reconcile covers for it — so every check passed and two live nodes came up with
 * correct caps and no links at all.
 */
const PRECONFIGURED = '12D3KooWPreconfiguredOnDiskPeer00000';
const PRECONFIGURED_ADDR = `/ip4/172.18.0.77/tcp/4001/p2p/${PRECONFIGURED}`;

function writeConnectorsJson(): void {
    const dir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'connectors.json'), JSON.stringify([{
        address: PRECONFIGURED_ADDR,
        trustLevel: 'peer',
        enabled: true,
        callsign: 'ondisk',
        publicUrl: 'https://ondisk.beanpool.org',
        creditCap: 250,
        addedAt: 1,
    }], null, 2));
}

async function main() {
    console.log('Running federation link enterprise tests (#143 step 3)...\n');
    // Written BEFORE any init, so the boot path sees it exactly as a real node would.
    writeConnectorsJson();
    initAdminPassword();
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const baseline = nodeTotal();

    // ── 0. THE BOOT PATH, which is the one that shipped broken. ─────────────────────────────────────────
    // `initStateEngine()` has now run, and a capped peer has been sitting in connectors.json the whole time.
    // Nothing should have created its link yet, because nothing has loaded the file — which is exactly the
    // state the reconcile used to run in.
    assert(getFederationLink(PRECONFIGURED) === null,
        '0a. before connectors are loaded there is no link, and no way to make one — the reconcile used to run HERE, against an empty list, which is why two live nodes came up with correct caps and zero links');
    loadConnectors();
    const createdAtBoot = reconcileFederationLinks(createTreasury);
    assert(createdAtBoot === 1,
        `0b. THE FIX: reconciling AFTER connectors are loaded creates the link (${createdAtBoot}) — the boot order is the whole bug, not the reconcile`);
    const onDisk = getFederationLink(PRECONFIGURED);
    assert(onDisk?.name === 'ondisk Link',
        `0c. named from the on-disk callsign (got "${onDisk?.name}") — an already-configured node needs no operator action to get its enterprise`);
    assert(reconcileFederationLinks(createTreasury) === 0, '0d. and a second boot creates nothing');

    // ── 1. A capless peer has no link. Adding a connector is not the deliberate act; setting a cap is. ────
    const added = await post('/api/local/connectors', {
        password: PW, address: ADDRESS, trustLevel: 'peer', callsign: 'eastgippy', enabled: true,
    });
    assert(added.status === 200, `1a. setup: peer connector added over HTTP (got ${added.status})`);
    assert(getFederationLink(PEER_ID) === null,
        '1b. a peer with no credit cap has NO link — a connector alone does not enable settlement, so there is nothing to be accountable for yet');
    assert(reconcileFederationLinks(createTreasury) === 0,
        '1c. and the reconciler agrees: nothing to create for a capless peer');

    // ── 2. THE POINT OF THE STEP. Setting a cap creates the enterprise, in the same request. ─────────────
    const capped = await setCap({ password: PW, address: ADDRESS, cap: 100 });
    assert(capped.status === 200, `2a. a cap of 100 is accepted (got ${capped.status})`);
    const link = getFederationLink(PEER_ID);
    assert(link !== null, '2b. THE POINT: the link enterprise now exists, created by the act of setting a cap');
    assert(capped.json?.link?.peerId === PEER_ID,
        '2c. and the response carries it, so an operator sees the enterprise appear rather than discovering it later');
    assert(link?.name === 'eastgippy Link',
        `2d. named from the peer's callsign (got "${link?.name}") — "Byron Link", per §7`);
    assert(link?.commissionCeiling === 0,
        '2e. ceiling starts at 0: a link is created automatically, so anything it could do unattended starts switched OFF');
    assert(link?.treasuryBalance === 0, '2f. and holds no beans');
    assert(nodeTotal() === baseline,
        `2g. creating a link MINTED NOTHING (${baseline} → ${nodeTotal()}) — a new account with a balance would be beans from nowhere`);

    const treasuryRow = db.prepare('SELECT is_treasury, earned_credit FROM members WHERE public_key = ?')
        .get(link!.treasuryPubkey) as any;
    assert(treasuryRow?.is_treasury === 1,
        '2h. the link IS an enterprise (is_treasury=1), not a parallel concept — so it inherits keepers, demurrage exemption and the Commons card for free');
    assert(treasuryRow?.earned_credit === 0,
        '2i. with a credit line of ZERO (§7: a credit line on a link treasury "creates a negative nobody earns back")');

    // ── 3. Idempotence. This runs on every boot, and a cap can be set repeatedly. ────────────────────────
    const linksBefore = listFederationLinks().length;
    await setCap({ password: PW, address: ADDRESS, cap: 250 });
    assert(listFederationLinks().length === linksBefore,
        `3a. re-setting the cap does not create a second link (${linksBefore} → ${listFederationLinks().length})`);
    assert(getFederationLink(PEER_ID)?.treasuryPubkey === link!.treasuryPubkey,
        '3b. and the treasury is the same account — a link holds real beans, so replacing it would strand them');
    assert(reconcileFederationLinks(createTreasury) === 0, '3c. the reconciler has converged: a second run creates nothing');

    // ── 4. The energy balance, with the sign the member sees. ────────────────────────────────────────────
    // `getEnergyBalance` documents positive as "we owe them work". Our member buying from theirs pushes it
    // positive — their community did the work and ours has not returned it. Getting this backwards on a card
    // would tell a community it is owed when it owes.
    tiltBridge(PEER_ID, 5);
    assert(getFederationLink(PEER_ID)?.energyBalance === 5,
        `4a. the link reports the bridge tab as its energy balance (got ${getFederationLink(PEER_ID)?.energyBalance})`);
    assert(getFederationLink(PEER_ID)?.treasuryBalance === 0,
        '4b. and the tab did NOT land in the treasury — the two numbers are separate, which is the §2.4 distinction the card must not blur');
    tiltBridge(PEER_ID, -13);
    assert(getFederationLink(PEER_ID)?.energyBalance === -8,
        `4c. and it goes negative when they owe us (got ${getFederationLink(PEER_ID)?.energyBalance})`);
    tiltBridge(PEER_ID, 8);   // back to square
    assert(nodeTotal() === baseline, '4d. and the ledger still sums to where it started');

    // ── 5. Members can SEE it. The read is public by design (§7), the ceiling is not. ────────────────────
    const publicRead = await get('/api/federation/links');
    assert(publicRead.status === 200, `5a. GET /api/federation/links needs no password (got ${publicRead.status})`);
    const shown = (publicRead.json?.links ?? []).find((l: any) => l.peerId === PEER_ID);
    assert(!!shown, '5b. THE POINT OF THE CARD: a member can read the community\'s own energy position');
    assert(shown?.commissionCeiling === 0 && shown?.energyBalance === 0,
        '5c. with the ceiling beside the balance — §7 makes the ceiling the safety, so it must be visible too');
    assert(!('address' in (shown ?? {})) && !('creditCap' in (shown ?? {})),
        '5d. and it leaks no operator configuration — no peer address, no credit cap');

    // ── 6. The Commons list, which is where a member actually meets this. ────────────────────────────────
    const ordinary = createTreasury('Egg Flock', 'bundled://sprout', 0);
    const treasuries = await get('/api/treasuries');
    const linkCard = (treasuries.json?.treasuries ?? []).find((t: any) => t.publicKey === link!.treasuryPubkey);
    const plainCard = (treasuries.json?.treasuries ?? []).find((t: any) => t.publicKey === ordinary.publicKey);
    assert(linkCard?.link?.peerId === PEER_ID,
        '6a. the link appears in the Commons list carrying its link fields, so the card can say what it is');
    assert(plainCard !== undefined && plainCard.link == null,
        '6b. and an ORDINARY enterprise carries link=null — the card must not imply an egg flock owes another community work');
    const detail = await get(`/api/treasury/${link!.treasuryPubkey}`);
    assert(detail.json?.link?.peerId === PEER_ID, '6c. the detail read carries it too, keyed by peer id for the ceiling route');
    assert(getLinkByTreasury(ordinary.publicKey) === null, '6d. and the treasury→link lookup does not invent one');

    // #143 step 5: the CARD MUST SHOW THE ALLOWANCE, not the ceiling, and the two are different numbers.
    //
    // The card used to read "commissioning off" whenever the ceiling was 0, which is wrong in exactly the case
    // §3 is about: a ceiling of 0 still permits calling in credit the community is owed. So the allowance is
    // computed on the SERVER, by the same `commissionAllowanceFor` the enforcement path uses, and shipped on
    // both reads. A client recomputing it would be a second definition of the rule that refuses the button.
    tiltBridge(PEER_ID, -480);
    const owedList = await get('/api/treasuries');
    const owedCard = (owedList.json?.treasuries ?? []).find((t: any) => t.publicKey === link!.treasuryPubkey);
    assert(owedCard?.link?.commissionAllowance === 480,
        `6e. with a tab of −480 and a ceiling of 0 the card carries an allowance of 480 (got ${owedCard?.link?.commissionAllowance}) — "commissioning off" beside "they owe us 480" told the keeper the opposite of the truth`);
    assert(owedCard?.link?.commissionCeiling === 0,
        '6f. while still reporting the ceiling separately — they are different facts and the card shows both');
    const owedDetail = await get(`/api/treasury/${link!.treasuryPubkey}`);
    assert(owedDetail.json?.link?.commissionAllowance === 480,
        `6g. and the detail read agrees with the list (got ${owedDetail.json?.link?.commissionAllowance}) — one shape function, so they cannot drift`);
    tiltBridge(PEER_ID, 480);   // back to square, so the checks below start where they expect

    // ── 7. The ceiling: admin-gated, bounded, and with no "unlimited". ───────────────────────────────────
    assert((await setCeiling({ peerId: PEER_ID, ceiling: 20 })).status === 401, '7a. a missing password is rejected');
    assert((await setCeiling({ password: 'nope', peerId: PEER_ID, ceiling: 20 })).status === 401, '7b. a wrong password is rejected');
    assert(getFederationLink(PEER_ID)?.commissionCeiling === 0, '7c. and neither set anything');

    assert((await setCeiling({ password: PW, ceiling: 20 })).status === 400, '7d. a missing peerId is a 400');
    const unknownPeer = await setCeiling({ password: PW, peerId: '12D3KooWNoSuchPeer', ceiling: 20 });
    assert(unknownPeer.status === 404 && /credit cap/i.test(unknownPeer.json?.error ?? ''),
        `7e. an unknown peer is a 404 that says how a link comes into being (got ${unknownPeer.status})`);

    // The omission guard, same shape as the credit cap's: a dropped field must not remove a safety.
    const absent = await setCeiling({ password: PW, peerId: PEER_ID });
    assert(absent.status === 400 && /unlimited/i.test(absent.json?.error ?? ''),
        `7f. an ABSENT ceiling is a 400, not "no limit" — there is no unlimited value (got ${absent.status})`);
    assert((await setCeiling({ password: PW, peerId: PEER_ID, ceiling: '20' })).status === 400,
        '7g. a string ceiling is a 400, not coerced');
    assert((await setCeiling({ password: PW, peerId: PEER_ID, ceiling: -5 })).status === 400,
        '7h. a negative ceiling is refused');
    assert(getFederationLink(PEER_ID)?.commissionCeiling === 0, '7i. none of the malformed requests moved it');

    const ok = await setCeiling({ password: PW, peerId: PEER_ID, ceiling: 20 });
    assert(ok.status === 200 && ok.json?.link?.commissionCeiling === 20,
        `7j. a ceiling of 20 is accepted and echoed (got ${ok.status} ceiling=${ok.json?.link?.commissionCeiling})`);
    assert(getFederationLink(PEER_ID)?.commissionCeiling === 20, '7k. and reads back through the accessor');
    assert((await get('/api/federation/links')).json.links.find((l: any) => l.peerId === PEER_ID)?.commissionCeiling === 20,
        '7l. and is visible on the public read, which is the point of a ceiling being a safety');
    assert((await setCeiling({ password: PW, peerId: PEER_ID, ceiling: 0 })).json?.link?.commissionCeiling === 0,
        '7m. and 0 turns commissioning back off — the documented way to stop it');

    // ── 8. A name collision cannot block a link. ─────────────────────────────────────────────────────────
    await post('/api/local/connectors', {
        password: PW, address: ADDRESS_2, trustLevel: 'peer', callsign: 'eastgippy', enabled: false,
    });
    await setCap({ password: PW, address: ADDRESS_2, cap: 50 });
    const second = getFederationLink(PEER_ID_2);
    assert(second !== null,
        '8a. a second peer whose operator chose the SAME callsign still gets a link — two communities picking one name is not a reason to refuse accountability');
    assert(second?.name !== link?.name && (second?.name ?? '').includes('eastgippy'),
        `8b. and it is distinguishable (got "${second?.name}")`);
    assert(second?.treasuryPubkey !== link?.treasuryPubkey,
        '8c. with its own treasury — sharing one would pool two separate obligations into one pot');

    // ── 9. Clearing a cap must not delete a link. ────────────────────────────────────────────────────────
    const clearing = await setCap({ password: PW, address: ADDRESS_2, cap: null });
    assert(clearing.status === 200, '9a. the cap clears');
    assert(getFederationLink(PEER_ID_2) !== null,
        '9b. but the LINK SURVIVES — its treasury can hold beans and its bridge can hold a tab, so dropping it would orphan both. Withdrawing a cap stops new settlement, which is what it is for');

    // ── 10. Naming, at the edge. ─────────────────────────────────────────────────────────────────────────
    assert(linkNameFor('Byron', 'abc12345678') === 'Byron Link', '10a. "Byron" → "Byron Link"');
    assert(linkNameFor(undefined, '12D3KooWabcdefgh') === 'Peer abcdefgh Link',
        `10b. a peer with no callsign is still nameable, from the id tail every log line already uses (got "${linkNameFor(undefined, '12D3KooWabcdefgh')}")`);
    assert(linkNameFor('   ', 'xyz98765432') === 'Peer 98765432 Link', '10c. and a blank callsign is treated as absent, not used');

    // ── 11. A failed link row must not leave an orphaned treasury. ───────────────────────────────────────
    // The rollback (review finding). Forced by a createTreasury that really creates one — so there IS a
    // treasury inside the transaction to roll back — but returns a pubkey another link already holds, which
    // violates the unique index on treasury_pubkey. That is the shape of the failure the finding described,
    // with the real `createTreasury` doing the work whose undo is being asserted.
    const treasuriesBefore = (db.prepare('SELECT COUNT(*) AS n FROM members WHERE is_treasury = 1').get() as any).n;
    let threw = false;
    try {
        ensureFederationLink('12D3KooWRollbackTest0000', 'Rollback', (n, a, c, o) => {
            createTreasury(n, a, c, o);                      // really created, inside the transaction
            return { publicKey: link!.treasuryPubkey };       // already linked → unique index fires
        });
    } catch { threw = true; }
    assert(threw, '11a. a link row that cannot be written throws rather than reporting success');
    assert(getFederationLink('12D3KooWRollbackTest0000') === null, '11b. and no link exists for that peer');
    const treasuriesAfter = (db.prepare('SELECT COUNT(*) AS n FROM members WHERE is_treasury = 1').get() as any).n;
    assert(treasuriesAfter === treasuriesBefore,
        `11c. THE POINT: the treasury created inside the failed transaction was rolled back (${treasuriesBefore} → ${treasuriesAfter}) — no nameless enterprise left in the Commons list for members to puzzle over`);
    assert(db.prepare("SELECT 1 FROM members WHERE callsign = 'Rollback Link'").get() === undefined,
        '11d. by name too, so a retry is not blocked by the corpse of the last attempt');

    assert(nodeTotal() === baseline,
        `12. FINALLY: across every link created here the ledger is unchanged (${baseline} → ${nodeTotal()}) — links account, they do not mint`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ #143 step 3: a peer relationship has a home, a keeper can be named, and a community can see what it owes.');
}

main().then(() => process.exit(0)).catch(e => { console.error('\n❌ Test failed:', e); process.exit(1); });
