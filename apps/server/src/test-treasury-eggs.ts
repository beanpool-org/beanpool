/**
 * Community Treasury — eggs end-to-end (the "project-zero" proof).
 *
 * Exercises the whole enterprise concept through the real engine functions, no HTTP/UI:
 *   1. createTreasury mints a real member account (the Commons' trading face) that is
 *      demurrage-exempt, flagged is_treasury, and granted a bounded credit line.
 *   2. The treasury AUTHORS a recurring eggs Offer and a paid tending Need (proving a
 *      treasury-member clears the createPost member gate + the need "offer covenant").
 *   3. It pays the chicken-tender FIRST, at zero balance — going into a bounded deficit on
 *      its credit line (the overdraft), settled to the tender fee-exempt.
 *   4. Egg sales then REPAY the deficit and return it to surplus.
 *   5. Exact-integer balances prove escrow settlements carry NO 1.5% fee (the Commons isn't taxed).
 *   6. The operator capability (can_operate) grants/exposes the client role signal.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-treasury-eggs.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, createPost, acceptPost, completePostTransaction,
    requestPost, approvePostRequest, transfer, getBalance, adminSetOperator, canOperate,
} from './state-engine.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const AVATAR = 'data:image/png;base64,iVBORw0KGgo='; // any non-empty value clears assertProfileComplete
function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}
const bal = (pk: string) => getBalance(pk).balance;

async function main() {
    console.log('Running community-treasury eggs end-to-end test...\n');
    await initTls();
    initStateEngine();

    // ---- 1. Create the treasury ---------------------------------------------------------
    const { publicKey: T } = createTreasury('Community Eggs', AVATAR, 200);
    const trow = db.prepare("SELECT is_treasury, status, callsign FROM members WHERE public_key=?").get(T) as any;
    assert(!!trow && trow.is_treasury === 1 && trow.status === 'active', '1. createTreasury inserts an active is_treasury member row');
    assert(getBalance(T).isTreasury === true, '1. balance endpoint reports isTreasury=true for the treasury');
    assert(getBalance(T).activated === true && getBalance(T).floor <= -200, '1. treasury has a bounded credit line (floor ≤ -200)');
    assert(bal(T) === 0, '1. treasury starts at 0 balance (no beans minted)');

    // ---- 2. Treasury authors its offer + need (the member-gate + covenant proof) ---------
    const eggs = createPost('offer', 'food', 'Dozen free-range eggs', 'Fresh daily from the community flock', 12, 'fixed', T, undefined, undefined, undefined, true);
    assert(eggs !== null && eggs.authorPublicKey === T, '2. treasury AUTHORS a recurring eggs Offer (clears createPost member gate)');
    const tend = createPost('need', 'labour', 'Tend the chickens this week', 'Feed, water, collect + clean', 20, 'fixed', T);
    assert(tend !== null, '2. treasury authors a paid tending Need (need "offer covenant" satisfied by the eggs offer)');

    // ---- 3. Pay the tender FIRST, from 0 → bounded deficit on the credit line ------------
    const F = 'tender-fiona-000000000000000000000000000000';
    seedMember(F, 'Fiona-Tender');
    const req = requestPost(tend!.id, F);                 // tender bids to help
    approvePostRequest(req.id, T);                        // treasury approves → funds escrow (T → escrow 20)
    assert(bal(T) === -20, '3. treasury funds tending from 0 → -20 (bounded overdraft in action)');
    completePostTransaction(req.id, T);                   // treasury releases → tender paid
    assert(bal(F) === 20, '3. tender receives exactly 20 (escrow settlement is fee-exempt)');
    assert(bal(T) === -20, '3. treasury sits at -20 (a real deficit, repaid below by income)');

    // ---- 4. Egg sales repay the deficit and return the enterprise to surplus -------------
    const B = 'egg-buyer-brenda-0000000000000000000000000000';
    seedMember(B, 'Brenda-Buyer');
    createPost('offer', 'misc', 'Homemade jam', 'so Brenda can trade', 5, 'fixed', B); // buyer needs a live offer to trade
    transfer('COMMONS_POOL', B, 50, 'test funding', 'direct', true);                    // give the buyer some beans
    assert(bal(B) === 50, '4. buyer funded with 50 beans');

    for (let i = 1; i <= 2; i++) {
        const sale = acceptPost(eggs!.id, B);            // buyer pays 12 into escrow
        completePostTransaction(sale.id, B);             // buyer confirms → escrow releases to treasury
        const still = db.prepare("SELECT status FROM posts WHERE id=?").get(eggs!.id) as any;
        assert(still.status === 'active', `4. recurring eggs offer stays live after sale #${i}`);
    }
    assert(bal(B) === 26, '4. buyer paid 24 for two dozen (50 → 26)');
    assert(bal(T) === 4, '4. treasury -20 + 24 income = +4: deficit repaid, back in surplus (and no fee skimmed)');

    // ---- 5. Operator capability (the client role signal) --------------------------------
    const OP = 'operator-otto-00000000000000000000000000000000';
    seedMember(OP, 'Otto-Operator');
    assert(canOperate(OP) === false && getBalance(OP).canOperate === false, '5. a normal member cannot operate treasuries');
    adminSetOperator(OP, true);
    assert(canOperate(OP) === true && getBalance(OP).canOperate === true, '5. adminSetOperator grants can_operate (drives the Commons-tab operator UI)');
    assert(getBalance(OP).isTreasury === false, '5. an operator is a person, not a treasury (isTreasury=false)');

    console.log(`\n${passed}/${run} assertions passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
