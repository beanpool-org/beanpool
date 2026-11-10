/**
 * Test Suite: Enterprise Derived Credit Floor (the grandfathered opening line is gone: E29)
 *
 * Source: docs/the-commons.md §2.4 Rules 1-4, §6 "Slice 4"
 *
 * Requirements:
 *   Rule 1: Only earned credit backs an enterprise (admin grants = 0).
 *   Rule 2: No multiplier; straight sum of keepers' backing pledges, capped by CREDIT_FLOOR_CAP.
 *   Rule 3: Counted once across enterprises; explicit pledge; never auto-split; never deducted from personal floor.
 *   Covenant: Deficit covenant lock prevents release of backing that would leave enterprise below current deficit.
 *   Opening line: the grandfathered legacy_credit_floor is gone (E29, Marty's yes, 10 Nov 2026): an enterprise created with
 *                 a 200 line has no floor until its keepers pledge, then its pledges alone. Community Eggs reads 0, -80,
 *                 -200, -180 as its keepers pledge and release, never the line, and nothing brings a line back.
 *   Security: Dead plaintext treasury_privkey_* rows dropped on boot and never written on create.
 *   Cache: O(1) floor cache correctly invalidated on trade completion, keeper changes, pledge/release, and freeze/status.
 *   HTTP Routes: /pledge, /release, /pledges endpoints enforce keeper authentication and covenant rules.
 *   Conservation: Zero beans minted or destroyed; SUM(balances) + COMMONS_POOL = 0 strictly maintained.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-derived-enterprise-floor.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, createPost as rawCreatePost, completePostTransaction,
    requestPost, approvePostRequest, transfer, getBalance, getMemberTrustProfile,
    adminAssignTreasuryOperator, adminRevokeTreasuryOperator,
    adminSetCreditFrozen, adminSetUserStatus, adminPruneUser, COMMUNITY_DECISION_ACTOR,
    getEnterpriseFloor, getAvailableBacking, getEnterprisePledges, getKeeperPledges,
    pledgeEnterpriseBacking, releaseEnterpriseBacking, clearEnterpriseFloorCache,
    runLedgerAudit, payFromCommons,
} from './state-engine.js';
import { wrapCreatePost } from './post-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);
import { db, initSchema } from './db/db.js';
import { createTreasuryRoutes } from './routes/treasury.js';
import { PROTOCOL_CONSTANTS } from '@beanpool/core';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
let seq = 0;
/**
 * The story's figures are Beans; the node's are whole hundredths (1 Bean = 100). `hc` turns a Beans figure into hundredths
 * at the door and `beansOf` turns one back for a message: exact for every figure here, each being whole hundredths.
 */
const hc = (beans: number) => Math.round(beans * 100);
const beansOf = (hundredths: number) => hundredths / 100;
/** Does `table` still have the column `column`? */
const hasColumn = (table: string, column: string) =>
    !!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign);
    setMemberPhoto(db, pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

function assignKeeper(treasury: string, keeper: string) {
    adminAssignTreasuryOperator(treasury, keeper, 'admin');
    db.prepare(`UPDATE members SET can_operate = 1 WHERE public_key = ?`).run(keeper);
}

// A completed marketplace trade of `credits` Beans that builds genuine earned credit for both parties
function mtx(buyer: string, seller: string, credits: number) {
    const pid = 'post-trade-' + (seq++);
    db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, status) VALUES (?, 'offer', 'misc', 'goods', 'description', ?, ?, 'completed')`)
        .run(pid, hc(credits), seller);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status) VALUES (?, ?, ?, ?, ?, 'completed')`)
        .run('mtx-trade-' + (seq++), pid, buyer, seller, hc(credits));
}

/** A balance in whole hundredths. */
const bal = (pk: string) => getBalance(pk).balance_c;

async function main() {
    console.log('Running derived enterprise credit floor test suite (no grandfathered line, E29)...\n');
    await initTls();
    initStateEngine();

    // =========================================================================
    // 1. Rule 1: Only earned credit backs an enterprise
    // =========================================================================
    console.log('── Section 1: Rule 1 — Only earned credit backs an enterprise ──');
    const K1 = 'keeper-alice-000000000000000000000000000001';
    seedMember(K1, 'Alice');

    // Give Alice admin granted credit (150)
    db.prepare("UPDATE members SET earned_credit_c = ? WHERE public_key = ?").run(hc(150), K1);

    const aliceProfile = getMemberTrustProfile(K1);
    assert(aliceProfile.grantedCredit === hc(150), `Alice has 150 granted credit in granted-credit lane (${aliceProfile.grantedCredit} hundredths)`);
    assert(aliceProfile.floor === hc(-150), `Alice has personal floor of -150 (150 granted) (${aliceProfile.floor} hundredths)`);
    assert(aliceProfile.earnedCredit === 0, 'Alice has 0 earned credit from trades');
    assert(getAvailableBacking(K1) === 0, 'Rule 1: Alice availableToBack is 0 despite having granted credit');

    const { publicKey: ent1 } = createTreasury('EnterpriseAlpha', AVATAR, 0);
    assignKeeper(ent1, K1);

    let caughtUnbackedPledge = false;
    try {
        pledgeEnterpriseBacking(ent1, K1, hc(20));
    } catch (e: any) {
        caughtUnbackedPledge = true;
        assert(e.message.includes('exceeds available earned credit'), 'Pledge rejected when keeper has 0 earned credit');
    }
    assert(caughtUnbackedPledge, 'Alice cannot pledge backing without earned credit');

    // Now Alice completes real trades with distinct peers to earn legitimate trade standing
    const peer1 = 'peer-one-0000000000000000000000000000001';
    const peer2 = 'peer-two-0000000000000000000000000000002';
    seedMember(peer1, 'Peer1');
    seedMember(peer2, 'Peer2');
    mtx(K1, peer1, 100);
    mtx(K1, peer2, 100);

    const aliceUpdatedProfile = getMemberTrustProfile(K1);
    const aliceEarned = aliceUpdatedProfile.earnedCredit;
    assert(aliceEarned > 0, `Alice now has earnedCredit = ${beansOf(aliceEarned)} from completed trades`);
    assert(getAvailableBacking(K1) === aliceEarned, 'Alice availableToBack equals her genuine earned credit');

    // Alice pledges a portion of her earned credit
    const pledge1Amount = Math.min(hc(30), aliceEarned);
    const pledge1 = pledgeEnterpriseBacking(ent1, K1, pledge1Amount);
    assert(pledge1.amount_c === pledge1Amount, `Alice successfully pledges backing from earned credit (${pledge1.amount_c} hundredths)`);
    const ent1Floor = getEnterpriseFloor(ent1);
    assert(ent1Floor.derivedAllowance === pledge1Amount, `EnterpriseAlpha derivedAllowance = ${beansOf(pledge1Amount)}`);
    assert(ent1Floor.floor === -pledge1Amount, `EnterpriseAlpha floor = -${beansOf(pledge1Amount)}`);

    // =========================================================================
    // 2. Rule 2: No multiplier; straight sum & capped by CREDIT_FLOOR_CAP
    // =========================================================================
    console.log('\n── Section 2: Rule 2 — No multiplier; straight sum ──');
    const K2 = 'keeper-bob-00000000000000000000000000000002';
    seedMember(K2, 'Bob');
    mtx(K2, peer1, 150);
    mtx(K2, peer2, 150);
    const bobEarned = getMemberTrustProfile(K2).earnedCredit;
    assert(bobEarned > 0, `Bob has earnedCredit = ${beansOf(bobEarned)}`);

    assignKeeper(ent1, K2);
    const bobPledgeAmount = Math.min(hc(40), bobEarned);
    pledgeEnterpriseBacking(ent1, K2, bobPledgeAmount);

    const ent1TwoKeepersFloor = getEnterpriseFloor(ent1);
    const expectedAllowance = pledge1Amount + bobPledgeAmount;
    assert(ent1TwoKeepersFloor.derivedAllowance === expectedAllowance, `Rule 2: Plain sum of pledges (${beansOf(pledge1Amount)} + ${beansOf(bobPledgeAmount)} = ${beansOf(expectedAllowance)}) without multiplier`);
    assert(ent1TwoKeepersFloor.floor === -expectedAllowance, `EnterpriseAlpha floor is exactly -${beansOf(expectedAllowance)}`);

    // =========================================================================
    // 3. Rule 3: Counted once across enterprises & personal floor intact
    // =========================================================================
    console.log('\n── Section 3: Rule 3 — Counted once across enterprises & personal floor intact ──');
    // Alice's personal floor is not touched by her backing pledge
    const alicePersonalProfile = getMemberTrustProfile(K1);
    assert(alicePersonalProfile.floor === -(alicePersonalProfile.grantedCredit + aliceEarned), 'Alice personal floor is NOT reduced or deducted by her backing pledge');

    // Alice's remaining available backing
    const aliceRemainingBacking = aliceEarned - pledge1Amount;
    assert(getAvailableBacking(K1) === aliceRemainingBacking, `Alice availableToBack is reduced across enterprises (${beansOf(aliceEarned)} - ${beansOf(pledge1Amount)} = ${beansOf(aliceRemainingBacking)})`);

    const { publicKey: ent2 } = createTreasury('EnterpriseBeta', AVATAR, 0);
    assignKeeper(ent2, K1);

    // Verify EnterpriseAlpha's floor is NOT affected by Alice joining EnterpriseBeta (no auto-split!)
    assert(getEnterpriseFloor(ent1).derivedAllowance === expectedAllowance, 'EnterpriseAlpha floor was not auto-split when Alice joined EnterpriseBeta');

    // Alice pledges remaining backing to EnterpriseBeta
    if (aliceRemainingBacking > 0) {
        pledgeEnterpriseBacking(ent2, K1, aliceRemainingBacking);
        assert(getEnterpriseFloor(ent2).derivedAllowance === aliceRemainingBacking, `EnterpriseBeta received ${beansOf(aliceRemainingBacking)} backing`);
        assert(getAvailableBacking(K1) === 0, 'Alice has 0 available backing left across all enterprises');

        // Alice cannot pledge any further to either enterprise
        let caughtOverpledge = false;
        try {
            pledgeEnterpriseBacking(ent2, K1, hc(10));
        } catch (e: any) {
            caughtOverpledge = true;
            assert(e.message.includes('exceeds available earned credit'), 'Overpledge rejected');
        }
        assert(caughtOverpledge, 'Alice cannot exceed her total earned credit across enterprises');
    }

    // =========================================================================
    // 4. Covenant Lock: Deficit covenant on release
    // =========================================================================
    console.log('\n── Section 4: Covenant Lock — Deficit covenant on release ──');
    // ent1 has allowance = expectedAllowance (e.g. 70).
    // Let ent1 create an offer and a need to spend into deficit.
    const ent1Offer = createPost('offer', 'food', 'Fresh bread', 'Organic bread daily', hc(10), 'fixed', ent1, undefined, undefined, undefined, true);
    assert(ent1Offer !== null, 'EnterpriseAlpha creates live offer (offer covenant satisfied)');

    const ent1Need = createPost('need', 'goods', 'Flour delivery', 'Need 10kg flour', hc(35), 'fixed', ent1);
    assert(ent1Need !== null, 'EnterpriseAlpha creates need for 35 beans');

    const flourSupplier = 'supplier-flour-0000000000000000000000001';
    seedMember(flourSupplier, 'FlourSupplier');

    const bid = requestPost(ent1Need!.id, flourSupplier);
    approvePostRequest(bid.id, ent1, { authSigner: K1 });
    assert(bal(ent1) === hc(-35), `EnterpriseAlpha spends into deficit (-35 beans) (${bal(ent1)} hundredths)`);

    // ent1 is at -35 deficit. Allowance is expectedAllowance (e.g. 70).
    // If Bob attempts to release his full pledge (40), remaining allowance would be 70 - 40 = 30 < 35 deficit!
    let caughtCovenantViolation = false;
    try {
        releaseEnterpriseBacking(ent1, K2, bobPledgeAmount);
    } catch (e: any) {
        caughtCovenantViolation = true;
        assert(e.message.includes('enterprise is in deficit') && e.message.includes('would not cover it'),
            `Covenant violation error explicitly names deficit: ${e.message}`);
    }
    assert(caughtCovenantViolation, 'Bob is blocked from releasing backing that would leave enterprise in deficit');

    // Partial release: Bob can release up to 70 - 35 = 35 beans.
    // If Bob releases 10 beans, remaining allowance is 60 >= 35 deficit:
    const partialRelease = releaseEnterpriseBacking(ent1, K2, hc(10));
    assert(partialRelease.releasedAmount === hc(10), `Partial release permitted when remaining allowance covers deficit (${partialRelease.releasedAmount} hundredths)`);
    assert(getEnterpriseFloor(ent1).derivedAllowance === expectedAllowance - hc(10), 'Enterprise floor updated to reflect partial release');

    // Now supplier completes the transaction and EnterpriseAlpha earns beans from sales to clear deficit
    completePostTransaction(bid.id, ent1, undefined, { authSigner: K1 });

    // Established trader buys from EnterpriseAlpha to bring balance to positive
    payFromCommons(peer1, hc(60), 'test funding', { allowDeficit: true });
    transfer(peer1, ent1, hc(50), 'Bread catering order');

    assert(bal(ent1) >= 0, `EnterpriseAlpha balance is now positive (${bal(ent1)} hundredths)`);

    // Now Bob can release the rest of his backing without covenant restriction
    const bobRemaining = partialRelease.remainingPledge;
    const finalBobRelease = releaseEnterpriseBacking(ent1, K2, bobRemaining);
    assert(finalBobRelease.releasedAmount === bobRemaining, 'Bob released all remaining backing once enterprise is solvent');
    assert(finalBobRelease.remainingPledge === 0, 'Bob has 0 remaining pledge on EnterpriseAlpha');

    // =========================================================================
    // 5. The opening line counts nothing (E29 gone): Community Eggs on test/mullum
    // =========================================================================
    console.log('\n── Section 5: An opening line counts nothing (E29) — Community Eggs ──');
    // An enterprise created with a 200 credit line, as before the derived floor. The grandfathered line is gone (E29, Marty's
    // yes, 10 Nov 2026): createTreasury writes the line as the enterprise's own earned_credit_c, which no floor reads.
    const { publicKey: eggs } = createTreasury('Community Eggs', AVATAR, hc(200));
    const eggsOwnLine = () => (db.prepare('SELECT earned_credit_c AS e FROM members WHERE public_key = ?').get(eggs) as { e: number }).e;

    // Check before any keeper pledges:
    const eggsBefore = getEnterpriseFloor(eggs);
    assert(!hasColumn('members', 'legacy_credit_floor') && !('legacyFloor' in eggsBefore),
        'Community Eggs has no legacy floor: members.legacy_credit_floor and the floor\'s legacyFloor are gone (E29)');
    assert(eggsBefore.derivedAllowance === 0, 'Community Eggs has derivedAllowance = 0');
    assert(eggsBefore.allowance === 0, `Community Eggs effective allowance is 0: its 200 opening line is no allowance (${eggsBefore.allowance})`);
    assert(eggsBefore.floor === 0, `Community Eggs floor before any pledge is 0, never the -200 line (${eggsBefore.floor})`);

    // Seed Keeper Dave with large earned credit
    const K3 = 'keeper-dave-00000000000000000000000000000003';
    seedMember(K3, 'Dave');
    mtx(K3, peer1, 200);
    mtx(K3, peer2, 200);
    assignKeeper(eggs, K3);
    const daveEarned = getMemberTrustProfile(K3).earnedCredit;
    assert(daveEarned >= hc(80), `Dave earned credit = ${beansOf(daveEarned)} (sufficient for 80 pledge)`);

    // Dave pledges 80 (less than the 200 opening line)
    pledgeEnterpriseBacking(eggs, K3, hc(80));
    const eggsMid = getEnterpriseFloor(eggs);
    assert(eggsMid.derivedAllowance === hc(80), 'Community Eggs derivedAllowance is now 80');
    assert(eggsMid.allowance === hc(80), `its allowance is the pledge alone, 80, never the 200 line beside it (${eggsMid.allowance})`);
    assert(eggsMid.floor === hc(-80), `Effective floor is -80, the pledges: no max with a legacy line (${eggsMid.floor})`);

    // Add another keeper with enough earned credit to push total derived >= 200
    const K4 = 'keeper-emma-00000000000000000000000000000004';
    seedMember(K4, 'Emma');
    mtx(K4, peer1, 300);
    mtx(K4, peer2, 300);
    assignKeeper(eggs, K4);
    const emmaEarned = getMemberTrustProfile(K4).earnedCredit;
    assert(emmaEarned >= hc(150), `Emma earned credit = ${beansOf(emmaEarned)}`);

    // Emma pledges 120 (total derived = 80 + 120 = 200)
    pledgeEnterpriseBacking(eggs, K4, hc(120));
    const eggsTransition = getEnterpriseFloor(eggs);
    assert(eggsTransition.derivedAllowance === hc(200), 'Community Eggs total derived allowance reached 200');
    assert(eggsTransition.allowance === hc(200), `allowance 200: the pledges, never the line added to them (${eggsTransition.allowance})`);
    assert(eggsTransition.floor === hc(-200), `Effective floor is -200, its keepers' pledges (${eggsTransition.floor})`);

    // In SQL, the opening line is still the enterprise's own earned_credit_c, which no floor reads (checked below at -180)
    assert(eggsOwnLine() === hc(200), `the 200 opening line is still written as Community Eggs' own earned_credit_c (${eggsOwnLine()})`);

    // If Emma releases 20 beans, floor becomes -180: no line props it up at -200
    releaseEnterpriseBacking(eggs, K4, hc(20));
    const eggsAfter = getEnterpriseFloor(eggs);
    assert(eggsAfter.derivedAllowance === hc(180), 'Community Eggs derived allowance is 180');
    assert(eggsAfter.allowance === hc(180) && eggsOwnLine() === hc(200), `no line comes back: allowance 180 beside its stored 200 line (${eggsAfter.allowance}, ${eggsOwnLine()})`);
    assert(eggsAfter.floor === hc(-180), `Floor is now derived -180 (${eggsAfter.floor})`);

    // =========================================================================
    // 6. Security: Dead plaintext treasury_privkey_* removal
    // =========================================================================
    console.log('\n── Section 6: Security — Dead plaintext treasury private keys ──');
    // Insert a dummy legacy treasury_privkey into node_config
    db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('treasury_privkey_dummy123', 'dead_secret_key')").run();
    assert(!!db.prepare("SELECT value FROM node_config WHERE key = 'treasury_privkey_dummy123'").get(), 'Dummy legacy private key inserted');

    // Run the deletion query that db.ts executes on boot
    db.prepare("DELETE FROM node_config WHERE key LIKE 'treasury_privkey_%'").run();
    const remainingPrivkeys = db.prepare("SELECT COUNT(*) as c FROM node_config WHERE key LIKE 'treasury_privkey_%'").get() as any;
    assert(remainingPrivkeys.c === 0, 'Dead treasury_privkey_* rows dropped from node_config');

    // Create another treasury and verify createTreasury does NOT write any private keys
    const { publicKey: secureTreasury } = createTreasury('SecureCoop', AVATAR, 0);
    const secureKeyCheck = db.prepare("SELECT value FROM node_config WHERE key = ?").get(`treasury_privkey_${secureTreasury}`);
    assert(!secureKeyCheck, 'createTreasury never writes plaintext private keys to node_config');

    // =========================================================================
    // 7. Cache Invalidation
    // =========================================================================
    console.log('\n── Section 7: Cache Invalidation ──');
    const { publicKey: cacheEnt } = createTreasury('CacheCoop', AVATAR, 0);
    assignKeeper(cacheEnt, K3);

    // Initial floor call populates cache
    const f1 = getEnterpriseFloor(cacheEnt);
    assert(f1.floor === 0, 'Initial cache entry floor = 0');

    // Invalidation on pledge
    pledgeEnterpriseBacking(cacheEnt, K3, hc(25));
    const f2 = getEnterpriseFloor(cacheEnt);
    assert(f2.floor === hc(-25), `Cache invalidated on backing pledge (${f2.floor})`);

    // Invalidation on release
    releaseEnterpriseBacking(cacheEnt, K3, hc(10));
    const f3 = getEnterpriseFloor(cacheEnt);
    assert(f3.floor === hc(-15), `Cache invalidated on backing release (${f3.floor})`);

    // Invalidation on credit freeze
    adminSetCreditFrozen(cacheEnt, true);
    const f4 = getEnterpriseFloor(cacheEnt);
    assert(f4.floor === 0, 'Cache invalidated on credit freeze (floor drops to 0)');
    assert(f4.allowance === 0, 'Allowance is 0 when credit frozen');

    // Unfreeze
    adminSetCreditFrozen(cacheEnt, false);
    const f5 = getEnterpriseFloor(cacheEnt);
    assert(f5.floor === hc(-15), `Cache invalidated on unfreeze (floor restored to -15) (${f5.floor})`);

    // Invalidation on keeper assignment
    adminAssignTreasuryOperator(cacheEnt, K4, 'admin');
    clearEnterpriseFloorCache(cacheEnt);
    const f6 = getEnterpriseFloor(cacheEnt);
    assert(f6 !== null, 'Floor retrieved after keeper assignment');

    // Invalidation on keeper revocation
    adminRevokeTreasuryOperator(cacheEnt, K4);
    clearEnterpriseFloorCache(cacheEnt);
    const f7 = getEnterpriseFloor(cacheEnt);
    assert(f7 !== null, 'Floor retrieved after keeper revocation');

    // =========================================================================
    // 8. HTTP Routes through Koa Router
    // =========================================================================
    console.log('\n── Section 8: HTTP Routes through real Koa router ──');
    const router = createTreasuryRoutes({
        checkAdminAuth: async () => false,
        rateLimit: () => true,
        clampLimit: (v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    });

    const findLayer = (path: string, method: string) => {
        const layer = (router as any).stack.find((l: any) =>
            l.path === path && l.methods.includes(method));
        if (!layer) throw new Error(`Route ${method} ${path} is not mounted`);
        return layer.stack[layer.stack.length - 1];
    };

    const pledgeRoute = findLayer('/api/treasury/:treasury/pledge', 'POST');
    const releaseRoute = findLayer('/api/treasury/:treasury/release', 'POST');
    const getPledgesRoute = findLayer('/api/treasury/:treasury/pledges', 'GET');
    const getDetailRoute = findLayer('/api/treasury/:treasury', 'GET');
    const getListRoute = findLayer('/api/treasuries', 'GET');

    const invokeRoute = async (handler: any, params: any, actor: string | undefined, body?: any) => {
        const ctx: any = {
            params,
            state: { actor },
            requestBody: body,
            status: 200,
            body: undefined,
        };
        await handler(ctx, async () => {});
        return ctx;
    };

    const { publicKey: routeEnt } = createTreasury('RouteFarm', AVATAR, 0);
    const routeKeeper = 'keeper-route-000000000000000000000000001';
    const nonKeeper = 'member-outsider-000000000000000000000001';
    seedMember(routeKeeper, 'RouteKeeper');
    seedMember(nonKeeper, 'Outsider');
    mtx(routeKeeper, peer1, 200);
    mtx(routeKeeper, peer2, 200);
    assignKeeper(routeEnt, routeKeeper);

    // 1. Non-keeper rejected from pledge route
    const nonKeeperPledge = await invokeRoute(pledgeRoute, { treasury: routeEnt }, nonKeeper, { amount_c: hc(20) });
    assert(nonKeeperPledge.status === 403, 'Non-keeper rejected with 403 from /api/treasury/:treasury/pledge');

    // 2. Keeper with invalid amount
    const invalidAmtPledge = await invokeRoute(pledgeRoute, { treasury: routeEnt }, routeKeeper, { amount_c: hc(-5) });
    assert(invalidAmtPledge.status === 400, 'Invalid pledge amount rejected with 400');

    // 3. Authorized keeper pledges valid amount
    const validPledge = await invokeRoute(pledgeRoute, { treasury: routeEnt }, routeKeeper, { amount_c: hc(30) });
    assert(validPledge.status === 200 && validPledge.body?.success === true, 'Authorized keeper successfully pledges via HTTP route');
    assert(validPledge.body?.pledge?.amount_c === hc(30), `Route returned pledge object with amount=30 (${validPledge.body?.pledge?.amount_c} hundredths)`);
    assert(validPledge.body?.floor_c === hc(-30), `Route returned updated floor=-30 (${validPledge.body?.floor_c} hundredths)`);

    // 4. GET /api/treasury/:treasury/pledges returns active pledges
    const pledgesRead = await invokeRoute(getPledgesRoute, { treasury: routeEnt }, routeKeeper);
    assert(pledgesRead.status === 200, 'GET /api/treasury/:treasury/pledges returned 200');
    assert(Array.isArray(pledgesRead.body?.pledges), 'Returned pledges array');
    assert(pledgesRead.body?.pledges.length === 1, 'Contains 1 active pledge');
    assert(pledgesRead.body?.pledges[0].keeper === routeKeeper, 'Pledge record names routeKeeper');
    assert(pledgesRead.body?.availableToBack_c !== undefined, 'Returned availableToBack');

    // 5. GET /api/treasury/:treasury detail read includes derived floor and pledges
    const detailRead = await invokeRoute(getDetailRoute, { treasury: routeEnt }, routeKeeper);
    assert(detailRead.status === 200, 'GET /api/treasury/:treasury returned 200');
    assert(detailRead.body?.floor_c === hc(-30), `Detail reports floor=-30 (${detailRead.body?.floor_c} hundredths)`);
    assert(detailRead.body?.creditLine_c === hc(30), `Detail reports creditLine=30 (${detailRead.body?.creditLine_c} hundredths)`);
    assert(detailRead.body?.allowance_c === hc(30), `Detail reports allowance=30 (${detailRead.body?.allowance_c} hundredths)`);
    assert(detailRead.body?.derivedAllowance_c === hc(30), `Detail reports derivedAllowance=30 (${detailRead.body?.derivedAllowance_c} hundredths)`);
    assert(!('legacyFloor' in (detailRead.body ?? {})), 'Detail reports no legacyFloor: the legacy floor is gone (E29)');
    assert(!('legacyCreditFloor' in (detailRead.body ?? {})), 'Detail carries no legacyCreditFloor alias either');
    assert(detailRead.body?.pledges.length === 1, 'Detail includes pledges array');

    // 6. GET /api/treasuries list read includes creditLine and pledges
    const listRead = await invokeRoute(getListRoute, {}, undefined);
    assert(listRead.status === 200, 'GET /api/treasuries returned 200');
    const farmItem = listRead.body?.treasuries.find((t: any) => t.publicKey === routeEnt);
    assert(farmItem !== undefined, 'RouteFarm present in treasuries list');
    assert(farmItem.creditLine_c === hc(30), `List read reports derived creditLine=30 (${farmItem.creditLine_c} hundredths)`);
    assert(farmItem.allowance_c === hc(30), `List read reports allowance=30 (${farmItem.allowance_c} hundredths)`);
    assert(!('legacyFloor' in farmItem), 'List read reports no legacyFloor: the legacy floor is gone (E29)');
    assert(!('legacyCreditFloor' in farmItem), 'List read carries no legacyCreditFloor alias either');

    // 7. Authorized keeper releases backing
    const validRelease = await invokeRoute(releaseRoute, { treasury: routeEnt }, routeKeeper, { amount_c: hc(15) });
    assert(validRelease.status === 200 && validRelease.body?.success === true, 'Authorized keeper successfully releases via HTTP route');
    assert(validRelease.body?.releasedAmount_c === hc(15), `Released 15 beans (${validRelease.body?.releasedAmount_c} hundredths)`);
    assert(validRelease.body?.remainingPledge_c === hc(15), `Remaining pledge is 15 (${validRelease.body?.remainingPledge_c} hundredths)`);
    assert(validRelease.body?.floor_c === hc(-15), `Updated floor is -15 (${validRelease.body?.floor_c} hundredths)`);

    // =========================================================================
    // 10. Review Findings Regression Suite
    // =========================================================================
    console.log('\n── Section 10: Review Findings Regression Suite ──');

    // 10.1: No grandfather migration runs on boot any more (E29 gone): no sentinel, no column, and initSchema() grants no line
    const sentinel = db.prepare("SELECT value FROM node_config WHERE key = 'migration_legacy_credit_floor_v1'").get() as any;
    assert(sentinel === undefined, 'no grandfather migration ran: no migration_legacy_credit_floor_v1 in node_config (E29)');
    const { publicKey: cleanEnt } = createTreasury('CleanCoop', AVATAR, 0);
    assert(getEnterpriseFloor(cleanEnt).floor === 0, 'CleanCoop created with no floor');
    initSchema();
    clearEnterpriseFloorCache(cleanEnt);
    clearEnterpriseFloorCache(eggs);
    assert(!hasColumn('members', 'legacy_credit_floor'), 'initSchema() does not bring members.legacy_credit_floor back');
    assert(getEnterpriseFloor(cleanEnt).floor === 0, `initSchema() does not grant a 200 line to newly created enterprise (${getEnterpriseFloor(cleanEnt).floor})`);
    assert(getEnterpriseFloor(eggs).floor === hc(-180), `initSchema() does not give Community Eggs its 200 line back: still -180, its pledges (${getEnterpriseFloor(eggs).floor})`);

    // 10.2: members_touch_updated_at trigger: no legacy_credit_floor (gone, E29); the money and lifecycle columns fire it
    const triggerSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'members_touch_updated_at'").get() as { sql: string }).sql;
    assert(!/legacy_credit_floor/.test(triggerSql), 'members_touch_updated_at no longer lists legacy_credit_floor (the column is gone, E29)');
    const triggerMember = 'trigger-test-member-00000000000000000001';
    seedMember(triggerMember, 'TriggerMember');
    db.prepare("UPDATE members SET updated_at = '2020-01-01T00:00:00.000Z' WHERE public_key = ?").run(triggerMember);
    db.prepare("UPDATE members SET paused_floor_snapshot_c = ? WHERE public_key = ?").run(hc(-150), triggerMember);
    const updatedMember = db.prepare("SELECT updated_at FROM members WHERE public_key = ?").get(triggerMember) as any;
    assert(updatedMember.updated_at > '2020-01-01T00:00:00.000Z', 'Updating paused_floor_snapshot_c fires members_touch_updated_at trigger');

    db.prepare("UPDATE members SET updated_at = '2020-01-01T00:00:00.000Z' WHERE public_key = ?").run(triggerMember);
    db.prepare("UPDATE members SET paused_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?").run(triggerMember);
    const updatedMemberPaused = db.prepare("SELECT updated_at FROM members WHERE public_key = ?").get(triggerMember) as any;
    assert(updatedMemberPaused.updated_at > '2020-01-01T00:00:00.000Z', 'Updating paused_at fires members_touch_updated_at trigger');

    db.prepare("UPDATE members SET updated_at = '2020-01-01T00:00:00.000Z' WHERE public_key = ?").run(triggerMember);
    db.prepare("UPDATE members SET wind_up_initiated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?").run(triggerMember);
    const updatedMemberWindUp = db.prepare("SELECT updated_at FROM members WHERE public_key = ?").get(triggerMember) as any;
    assert(updatedMemberWindUp.updated_at > '2020-01-01T00:00:00.000Z', 'Updating wind_up_initiated_at fires members_touch_updated_at trigger');

    // 10.3: Inactive or credit-frozen keeper excluded from getEnterpriseFloor
    const { publicKey: freezeEnt } = createTreasury('FreezeEnterprise', AVATAR, 0);
    const KFreeze = 'keeper-freeze-0000000000000000000000000001';
    const TradePartner1 = 'trade-partner-one-0000000000000000000001';
    const TradePartner2 = 'trade-partner-two-0000000000000000000002';
    seedMember(KFreeze, 'KFreeze');
    seedMember(TradePartner1, 'TradePartner1');
    seedMember(TradePartner2, 'TradePartner2');
    mtx(KFreeze, TradePartner1, 100);
    mtx(KFreeze, TradePartner2, 100);
    assignKeeper(freezeEnt, KFreeze);
    pledgeEnterpriseBacking(freezeEnt, KFreeze, hc(40));
    assert(getEnterpriseFloor(freezeEnt).derivedAllowance === hc(40), 'Active unfrozen keeper contributes 40 derived allowance');

    adminSetCreditFrozen(KFreeze, true);
    clearEnterpriseFloorCache(freezeEnt);
    assert(getEnterpriseFloor(freezeEnt).derivedAllowance === 0, 'Credit-frozen keeper excluded from getEnterpriseFloor derived allowance');

    adminSetCreditFrozen(KFreeze, false);
    clearEnterpriseFloorCache(freezeEnt);
    assert(getEnterpriseFloor(freezeEnt).derivedAllowance === hc(40), 'Unfrozen keeper restored to derived allowance');

    adminSetUserStatus(KFreeze, 'disabled');
    clearEnterpriseFloorCache(freezeEnt);
    assert(getEnterpriseFloor(freezeEnt).derivedAllowance === 0, 'Disabled keeper excluded from getEnterpriseFloor derived allowance');

    adminSetUserStatus(KFreeze, 'active');
    clearEnterpriseFloorCache(freezeEnt);
    assert(getEnterpriseFloor(freezeEnt).derivedAllowance === hc(40), 'Re-activated keeper restored to derived allowance');

    // 10.4: Exited keeper can release backing once enterprise returns to solvency
    const { publicKey: exitedEnt } = createTreasury('ExitedEnterprise', AVATAR, 0);
    const KExited = 'keeper-exited-0000000000000000000000000001';
    seedMember(KExited, 'KExited');
    mtx(KExited, TradePartner1, 120);
    mtx(KExited, TradePartner2, 120);
    assignKeeper(exitedEnt, KExited);
    pledgeEnterpriseBacking(exitedEnt, KExited, hc(50));

    // Enter deficit: offer + need
    const entExitOffer = createPost('offer', 'goods', 'Apples', 'Fresh apples', hc(10), 'fixed', exitedEnt, undefined, undefined, undefined, true);
    assert(entExitOffer !== null, 'ExitedEnterprise creates offer');
    const entExitNeed = createPost('need', 'goods', 'Boxes', 'Need packing boxes', hc(30), 'fixed', exitedEnt);
    assert(entExitNeed !== null, 'ExitedEnterprise creates need');
    const exitBid = requestPost(entExitNeed!.id, TradePartner1);
    approvePostRequest(exitBid.id, exitedEnt, { authSigner: KExited });
    completePostTransaction(exitBid.id, exitedEnt, undefined, { authSigner: KExited });
    assert(bal(exitedEnt) === hc(-30), `ExitedEnterprise spends into deficit (-30 beans) (${bal(exitedEnt)} hundredths)`);

    // Revoke operator while in deficit — backing remains covenant-locked
    adminRevokeTreasuryOperator(exitedEnt, KExited);
    const isBound = db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(exitedEnt, KExited);
    assert(!isBound, 'KExited is no longer in treasury_operators');
    assert(getEnterprisePledges(exitedEnt).length === 1, 'Pledge remains locked to cover deficit');

    // While in deficit, release is rejected
    let releaseFailedDuringDeficit = false;
    try {
        releaseEnterpriseBacking(exitedEnt, KExited, hc(30));
    } catch (e: any) {
        releaseFailedDuringDeficit = true;
        assert(e.message.includes('deficit'), 'Deficit covenant blocks release while in deficit');
    }
    assert(releaseFailedDuringDeficit, 'Release blocked during deficit');

    // Enterprise returns to solvency
    payFromCommons(TradePartner1, hc(60), 'funding for fruit order', { allowDeficit: true });
    transfer(TradePartner1, exitedEnt, hc(50), 'Apple catering payment');
    assert(bal(exitedEnt) > 0, `ExitedEnterprise is now solvent (${bal(exitedEnt)} hundredths)`);

    // Exited keeper can now release their pledge (lockedNeeded was 30; release 10 partially)
    const exitedRelease = releaseEnterpriseBacking(exitedEnt, KExited, hc(10));
    assert(exitedRelease.releasedAmount === hc(10), `Exited keeper successfully released pledge after solvency restored (${exitedRelease.releasedAmount} hundredths)`);
    assert(exitedRelease.remainingPledge === hc(20), `Remaining pledge is 20 (${exitedRelease.remainingPledge} hundredths)`);

    // Exited keeper can also release remaining 20 via HTTP route
    const httpExitedRelease = await invokeRoute(releaseRoute, { treasury: exitedEnt }, KExited, { amount_c: hc(20) });
    assert(httpExitedRelease.status === 200 && httpExitedRelease.body?.success === true, 'HTTP /release succeeds for exited keeper holding active pledge');
    assert(httpExitedRelease.body?.remainingPledge_c === 0, `Exited keeper remaining pledge is 0 (${httpExitedRelease.body?.remainingPledge_c})`);

    // 10.5: adminRevokeTreasuryOperator ignores inactive/frozen keepers for deficit covenant
    const { publicKey: revokeEnt } = createTreasury('RevokeEnterprise', AVATAR, 0);
    const KRevoke1 = 'keeper-revoke-1-0000000000000000000000001';
    const KRevoke2 = 'keeper-revoke-2-0000000000000000000000002';
    seedMember(KRevoke1, 'KRevoke1');
    seedMember(KRevoke2, 'KRevoke2');
    mtx(KRevoke1, TradePartner1, 100);
    mtx(KRevoke1, TradePartner2, 100);
    mtx(KRevoke2, TradePartner1, 100);
    mtx(KRevoke2, TradePartner2, 100);
    assignKeeper(revokeEnt, KRevoke1);
    assignKeeper(revokeEnt, KRevoke2);
    pledgeEnterpriseBacking(revokeEnt, KRevoke1, hc(50));
    pledgeEnterpriseBacking(revokeEnt, KRevoke2, hc(50));

    // Enter deficit of 40
    const revOffer = createPost('offer', 'goods', 'Honey', 'Raw honey', hc(10), 'fixed', revokeEnt, undefined, undefined, undefined, true);
    assert(revOffer !== null, 'RevokeEnterprise creates offer');
    const revNeed = createPost('need', 'goods', 'Supplies', 'Need supplies', hc(40), 'fixed', revokeEnt);
    const revBid = requestPost(revNeed!.id, TradePartner1);
    approvePostRequest(revBid.id, revokeEnt, { authSigner: KRevoke1 });
    completePostTransaction(revBid.id, revokeEnt, undefined, { authSigner: KRevoke1 });
    assert(bal(revokeEnt) === hc(-40), `RevokeEnterprise is in deficit (-40 beans) (${bal(revokeEnt)} hundredths)`);

    // Freeze KRevoke2 so their 50 pledge is inactive/phantom backing
    adminSetCreditFrozen(KRevoke2, true);

    // KRevoke1 exits. Because KRevoke2 is credit-frozen, otherAllowance is 0.
    // Deficit is 40. KRevoke1 must have 40 locked to cover deficit, and 10 released.
    adminRevokeTreasuryOperator(revokeEnt, KRevoke1);
    const k1Pledges = getEnterprisePledges(revokeEnt).filter(p => p.keeper === KRevoke1);
    assert(k1Pledges.length === 1, 'KRevoke1 pledge remains to cover deficit when co-keeper is frozen');
    assert(k1Pledges[0].amount_c === hc(40), `KRevoke1 locked pledge is exactly 40 (deficit requirement), got ${k1Pledges[0]?.amount_c} hundredths`);

    // 10.6: getAvailableBacking reports true incremental headroom and respects frozen/inactive status
    const { publicKey: headroomEnt } = createTreasury('HeadroomEnterprise', AVATAR, 0);
    const KHeadroom = 'keeper-headroom-000000000000000000000001';
    seedMember(KHeadroom, 'KHeadroom');
    mtx(KHeadroom, TradePartner1, 100);
    mtx(KHeadroom, TradePartner2, 100);
    const headroomEarned = getMemberTrustProfile(KHeadroom).earnedCredit;
    assert(headroomEarned > 0, `KHeadroom has earnedCredit = ${beansOf(headroomEarned)}`);
    assignKeeper(headroomEnt, KHeadroom);

    assert(getAvailableBacking(KHeadroom) === headroomEarned, 'Available backing matches earned credit before any pledge');
    assert(getAvailableBacking(KHeadroom, headroomEnt) === headroomEarned, 'Available backing forEnterprise matches earned credit before any pledge');

    // Pledge 30 incrementally to headroomEnt
    pledgeEnterpriseBacking(headroomEnt, KHeadroom, hc(30));
    const remainingHeadroom = headroomEarned - hc(30);
    // Calling getAvailableBacking(KHeadroom, headroomEnt) must now report true remaining incremental headroom (20), NOT 50!
    assert(getAvailableBacking(KHeadroom, headroomEnt) === remainingHeadroom, `getAvailableBacking reports remaining headroom (${beansOf(remainingHeadroom)}) after pledge to this enterprise, not un-subtracted (${beansOf(headroomEarned)})`);
    assert(getAvailableBacking(KHeadroom) === remainingHeadroom, 'getAvailableBacking without enterprise parameter reports matching headroom');

    // Account freeze / inactive checks
    adminSetCreditFrozen(KHeadroom, true);
    assert(getAvailableBacking(KHeadroom) === 0, 'getAvailableBacking returns 0 when keeper credit is frozen');
    assert(getAvailableBacking(KHeadroom, headroomEnt) === 0, 'getAvailableBacking forEnterprise returns 0 when keeper credit is frozen');

    adminSetCreditFrozen(KHeadroom, false);
    assert(getAvailableBacking(KHeadroom) === remainingHeadroom, 'getAvailableBacking restores headroom when un-frozen');

    adminSetUserStatus(KHeadroom, 'disabled');
    assert(getAvailableBacking(KHeadroom) === 0, 'getAvailableBacking returns 0 when keeper status is disabled');

    adminSetUserStatus(KHeadroom, 'pruned');
    assert(getAvailableBacking(KHeadroom) === 0, 'getAvailableBacking returns 0 when keeper status is pruned');

    adminSetUserStatus(KHeadroom, 'active');
    assert(getAvailableBacking(KHeadroom) === remainingHeadroom, 'getAvailableBacking restores headroom when re-activated');

    // 10.7: adminPruneUser invalidates enterpriseFloorCache via setUserStatusRow
    const { publicKey: pruneEnt } = createTreasury('PruneEnterprise', AVATAR, 0);
    const KPrune = 'keeper-prune-000000000000000000000000001';
    seedMember(KPrune, 'KPrune');
    mtx(KPrune, TradePartner1, 100);
    mtx(KPrune, TradePartner2, 100);
    assignKeeper(pruneEnt, KPrune);
    pledgeEnterpriseBacking(pruneEnt, KPrune, hc(40));

    // Warm cache
    const floorBeforePrune = getEnterpriseFloor(pruneEnt);
    assert(floorBeforePrune.derivedAllowance === hc(40), 'Floor cache warmed with derivedAllowance 40 before prune');
    assert(floorBeforePrune.floor === hc(-40), `Floor before prune is -40 (${floorBeforePrune.floor})`);

    // Prune keeper via adminPruneUser
    adminPruneUser(KPrune, COMMUNITY_DECISION_ACTOR);

    // Because setUserStatusRow clears enterpriseFloorCache, immediate read must not return stale 40
    const floorAfterPrune = getEnterpriseFloor(pruneEnt);
    assert(floorAfterPrune.derivedAllowance === 0, `Pruned keeper backing immediately dropped from floor (derivedAllowance=${floorAfterPrune.derivedAllowance})`);
    assert(floorAfterPrune.floor === 0, 'Enterprise floor is 0 after keeper pruned');

    // 10.8: Detail endpoint parity check with allowance, and no legacyFloor (E29)
    const detailHeadroom = await invokeRoute(getDetailRoute, { treasury: headroomEnt }, undefined);
    assert(detailHeadroom.status === 200, 'GET /api/treasury/:treasury returns 200');
    assert(detailHeadroom.body?.allowance_c !== undefined, 'Detail reports allowance');
    assert(detailHeadroom.body?.derivedAllowance_c !== undefined, 'Detail reports derivedAllowance');
    assert(!('legacyFloor' in (detailHeadroom.body ?? {})), 'Detail reports no legacyFloor: the legacy floor is gone (E29)');



    // =========================================================================
    // 9. Conservation Check: SUM(balances) + COMMONS_POOL = 0
    // =========================================================================
    console.log('\n── Section 9: Ledger Conservation ──');
    const audit = runLedgerAudit();
    assert(audit.ok, `Ledger audit passed: sum(balances)=${audit.sumBalances}, drift=${audit.drift}`);
    assert(audit.drift === 0, `Ledger conservation strictly preserved (SUM(balances) + COMMONS_POOL = 0) (drift ${audit.drift} hundredths)`);

    console.log(`\n${passed}/${run} checks passed.`);
    console.log('⭐️ Enterprise Derived Credit Floor suite PASSED.');
    process.exit(0);
}

main().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
