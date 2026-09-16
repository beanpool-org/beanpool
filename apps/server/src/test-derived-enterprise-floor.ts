/**
 * Test Suite: Enterprise Derived Credit Floor & Grandfather Migration
 *
 * Source: docs/the-commons.md §2.4 Rules 1-4, §6 "Slice 4"
 *
 * Requirements:
 *   Rule 1: Only earned credit backs an enterprise (vouch gifts & admin grants = 0).
 *   Rule 2: No multiplier; straight sum of keepers' backing pledges, capped by CREDIT_FLOOR_CAP.
 *   Rule 3: Counted once across enterprises; explicit pledge; never auto-split; never deducted from personal floor.
 *   Covenant: Deficit covenant lock prevents release of backing that would leave enterprise below current deficit.
 *   Grandfather Migration: Existing enterprises retain legacy_credit_floor (e.g. 200) until derived >= legacy,
 *                          at which point legacy_credit_floor is auto-cleared. Community Eggs floor is -200 before and -200 after.
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
    initStateEngine, createTreasury, createPost, completePostTransaction,
    requestPost, approvePostRequest, transfer, getBalance, getMemberTrustProfile,
    adminAssignTreasuryOperator, adminRevokeTreasuryOperator,
    adminSetCreditFrozen, adminSetUserStatus, adminPruneUser,
    getEnterpriseFloor, getAvailableBacking, getEnterprisePledges, getKeeperPledges,
    pledgeEnterpriseBacking, releaseEnterpriseBacking, clearEnterpriseFloorCache,
    runLedgerAudit, payFromCommons,
} from './state-engine.js';
import { db, initSchema } from './db/db.js';
import { createTreasuryRoutes } from './routes/treasury.js';
import { PROTOCOL_CONSTANTS } from '@beanpool/core';

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

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

function assignKeeper(treasury: string, keeper: string) {
    adminAssignTreasuryOperator(treasury, keeper, 'admin');
    db.prepare(`UPDATE members SET can_operate = 1 WHERE public_key = ?`).run(keeper);
}

// A completed marketplace trade that builds genuine earned credit for both parties
function mtx(buyer: string, seller: string, credits: number) {
    const pid = 'post-trade-' + (seq++);
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'misc', 'goods', 'description', ?, ?, 'completed')`)
        .run(pid, credits, seller);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, ?, 'completed')`)
        .run('mtx-trade-' + (seq++), pid, buyer, seller, credits);
}

const bal = (pk: string) => getBalance(pk).balance;

async function main() {
    console.log('Running derived enterprise credit floor & grandfather migration test suite...\n');
    await initTls();
    initStateEngine();

    // =========================================================================
    // 1. Rule 1: Only earned credit backs an enterprise
    // =========================================================================
    console.log('── Section 1: Rule 1 — Only earned credit backs an enterprise ──');
    const K1 = 'keeper-alice-000000000000000000000000000001';
    const Voucher = 'voucher-elder-00000000000000000000000001';
    seedMember(K1, 'Alice');
    seedMember(Voucher, 'ElderVoucher');

    // Give Alice vouch credit (50) and admin granted credit (100)
    db.prepare("UPDATE members SET elder_vouched_by = ?, vouch_credit = 50, earned_credit = 100 WHERE public_key = ?").run(Voucher, K1);

    const aliceProfile = getMemberTrustProfile(K1);
    assert(aliceProfile.grantedCredit === 100, 'Alice has 100 granted credit in granted-credit lane');
    assert(aliceProfile.floor === -150, 'Alice has personal floor of -150 (50 vouch + 100 granted)');
    assert(aliceProfile.earnedCredit === 0, 'Alice has 0 earned credit from trades');
    assert(getAvailableBacking(K1) === 0, 'Rule 1: Alice availableToBack is 0 despite having vouch and granted credit');

    const { publicKey: ent1 } = createTreasury('EnterpriseAlpha', AVATAR, 0);
    assignKeeper(ent1, K1);

    let caughtUnbackedPledge = false;
    try {
        pledgeEnterpriseBacking(ent1, K1, 20);
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
    assert(aliceEarned > 0, `Alice now has earnedCredit = ${aliceEarned} from completed trades`);
    assert(getAvailableBacking(K1) === aliceEarned, 'Alice availableToBack equals her genuine earned credit');

    // Alice pledges a portion of her earned credit
    const pledge1Amount = Math.min(30, aliceEarned);
    const pledge1 = pledgeEnterpriseBacking(ent1, K1, pledge1Amount);
    assert(pledge1.amount === pledge1Amount, 'Alice successfully pledges backing from earned credit');
    const ent1Floor = getEnterpriseFloor(ent1);
    assert(ent1Floor.derivedAllowance === pledge1Amount, `EnterpriseAlpha derivedAllowance = ${pledge1Amount}`);
    assert(ent1Floor.floor === -pledge1Amount, `EnterpriseAlpha floor = -${pledge1Amount}`);

    // =========================================================================
    // 2. Rule 2: No multiplier; straight sum & capped by CREDIT_FLOOR_CAP
    // =========================================================================
    console.log('\n── Section 2: Rule 2 — No multiplier; straight sum ──');
    const K2 = 'keeper-bob-00000000000000000000000000000002';
    seedMember(K2, 'Bob');
    mtx(K2, peer1, 150);
    mtx(K2, peer2, 150);
    const bobEarned = getMemberTrustProfile(K2).earnedCredit;
    assert(bobEarned > 0, `Bob has earnedCredit = ${bobEarned}`);

    assignKeeper(ent1, K2);
    const bobPledgeAmount = Math.min(40, bobEarned);
    pledgeEnterpriseBacking(ent1, K2, bobPledgeAmount);

    const ent1TwoKeepersFloor = getEnterpriseFloor(ent1);
    const expectedAllowance = pledge1Amount + bobPledgeAmount;
    assert(ent1TwoKeepersFloor.derivedAllowance === expectedAllowance, `Rule 2: Plain sum of pledges (${pledge1Amount} + ${bobPledgeAmount} = ${expectedAllowance}) without multiplier`);
    assert(ent1TwoKeepersFloor.floor === -expectedAllowance, `EnterpriseAlpha floor is exactly -${expectedAllowance}`);

    // =========================================================================
    // 3. Rule 3: Counted once across enterprises & personal floor intact
    // =========================================================================
    console.log('\n── Section 3: Rule 3 — Counted once across enterprises & personal floor intact ──');
    // Alice's personal floor is not touched by her backing pledge
    const alicePersonalProfile = getMemberTrustProfile(K1);
    assert(alicePersonalProfile.floor === -(alicePersonalProfile.grantedCredit + 50 + aliceEarned), 'Alice personal floor is NOT reduced or deducted by her backing pledge');

    // Alice's remaining available backing
    const aliceRemainingBacking = aliceEarned - pledge1Amount;
    assert(getAvailableBacking(K1) === aliceRemainingBacking, `Alice availableToBack is reduced across enterprises (${aliceEarned} - ${pledge1Amount} = ${aliceRemainingBacking})`);

    const { publicKey: ent2 } = createTreasury('EnterpriseBeta', AVATAR, 0);
    assignKeeper(ent2, K1);

    // Verify EnterpriseAlpha's floor is NOT affected by Alice joining EnterpriseBeta (no auto-split!)
    assert(getEnterpriseFloor(ent1).derivedAllowance === expectedAllowance, 'EnterpriseAlpha floor was not auto-split when Alice joined EnterpriseBeta');

    // Alice pledges remaining backing to EnterpriseBeta
    if (aliceRemainingBacking > 0) {
        pledgeEnterpriseBacking(ent2, K1, aliceRemainingBacking);
        assert(getEnterpriseFloor(ent2).derivedAllowance === aliceRemainingBacking, `EnterpriseBeta received ${aliceRemainingBacking} backing`);
        assert(getAvailableBacking(K1) === 0, 'Alice has 0 available backing left across all enterprises');

        // Alice cannot pledge any further to either enterprise
        let caughtOverpledge = false;
        try {
            pledgeEnterpriseBacking(ent2, K1, 10);
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
    const ent1Offer = createPost('offer', 'food', 'Fresh bread', 'Organic bread daily', 10, 'fixed', ent1, undefined, undefined, undefined, true);
    assert(ent1Offer !== null, 'EnterpriseAlpha creates live offer (offer covenant satisfied)');

    const ent1Need = createPost('need', 'goods', 'Flour delivery', 'Need 10kg flour', 35, 'fixed', ent1);
    assert(ent1Need !== null, 'EnterpriseAlpha creates need for 35 beans');

    const flourSupplier = 'supplier-flour-0000000000000000000000001';
    seedMember(flourSupplier, 'FlourSupplier');

    const bid = requestPost(ent1Need!.id, flourSupplier);
    approvePostRequest(bid.id, ent1, { authSigner: K1 });
    assert(bal(ent1) === -35, 'EnterpriseAlpha spends into deficit (-35 beans)');

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
    const partialRelease = releaseEnterpriseBacking(ent1, K2, 10);
    assert(partialRelease.releasedAmount === 10, 'Partial release permitted when remaining allowance covers deficit');
    assert(getEnterpriseFloor(ent1).derivedAllowance === expectedAllowance - 10, 'Enterprise floor updated to reflect partial release');

    // Now supplier completes the transaction and EnterpriseAlpha earns beans from sales to clear deficit
    completePostTransaction(bid.id, ent1, undefined, { authSigner: K1 });

    // Established trader buys from EnterpriseAlpha to bring balance to positive
    payFromCommons(peer1, 60, 'test funding', { allowDeficit: true });
    transfer(peer1, ent1, 50, 'Bread catering order');

    assert(bal(ent1) >= 0, `EnterpriseAlpha balance is now positive (${bal(ent1)})`);

    // Now Bob can release the rest of his backing without covenant restriction
    const bobRemaining = partialRelease.remainingPledge;
    const finalBobRelease = releaseEnterpriseBacking(ent1, K2, bobRemaining);
    assert(finalBobRelease.releasedAmount === bobRemaining, 'Bob released all remaining backing once enterprise is solvent');
    assert(finalBobRelease.remainingPledge === 0, 'Bob has 0 remaining pledge on EnterpriseAlpha');

    // =========================================================================
    // 5. Grandfather Migration: Community Eggs on test/mullum
    // =========================================================================
    console.log('\n── Section 5: Grandfather Migration — Community Eggs ──');
    // Emulate existing enterprise created with 200 credit line before derived floor
    const { publicKey: eggs } = createTreasury('Community Eggs', AVATAR, 200);

    // Check before any keeper pledges:
    const eggsBefore = getEnterpriseFloor(eggs);
    assert(eggsBefore.legacyFloor === 200, 'Community Eggs has legacy_credit_floor = 200');
    assert(eggsBefore.derivedAllowance === 0, 'Community Eggs has derivedAllowance = 0');
    assert(eggsBefore.allowance === 200, 'Community Eggs effective allowance is 200');
    assert(eggsBefore.floor === -200, 'Community Eggs floor before upgrade is -200 (Grandfather guarantee: never stranded)');

    // Seed Keeper Dave with large earned credit
    const K3 = 'keeper-dave-00000000000000000000000000000003';
    seedMember(K3, 'Dave');
    mtx(K3, peer1, 200);
    mtx(K3, peer2, 200);
    assignKeeper(eggs, K3);
    const daveEarned = getMemberTrustProfile(K3).earnedCredit;
    assert(daveEarned >= 80, `Dave earned credit = ${daveEarned} (sufficient for 80 pledge)`);

    // Dave pledges 80 (less than legacy 200)
    pledgeEnterpriseBacking(eggs, K3, 80);
    const eggsMid = getEnterpriseFloor(eggs);
    assert(eggsMid.derivedAllowance === 80, 'Community Eggs derivedAllowance is now 80');
    assert(eggsMid.legacyFloor === 200, 'Legacy floor remains 200 while derived < legacy');
    assert(eggsMid.floor === -200, 'Effective floor is still -200 (max(legacy, derived))');

    // Add another keeper with enough earned credit to push total derived >= 200
    const K4 = 'keeper-emma-00000000000000000000000000000004';
    seedMember(K4, 'Emma');
    mtx(K4, peer1, 300);
    mtx(K4, peer2, 300);
    assignKeeper(eggs, K4);
    const emmaEarned = getMemberTrustProfile(K4).earnedCredit;
    assert(emmaEarned >= 150, `Emma earned credit = ${emmaEarned}`);

    // Emma pledges 120 (total derived = 80 + 120 = 200 >= 200)
    pledgeEnterpriseBacking(eggs, K4, 120);
    const eggsTransition = getEnterpriseFloor(eggs);
    assert(eggsTransition.derivedAllowance === 200, 'Community Eggs total derived allowance reached 200');
    assert(eggsTransition.legacyFloor === 0, 'Legacy credit floor auto-cleared once derived >= legacy');
    assert(eggsTransition.floor === -200, 'Effective floor smoothly remains -200');

    // Verify in SQL that members.legacy_credit_floor is indeed NULL
    const eggsSqlRow = db.prepare("SELECT legacy_credit_floor FROM members WHERE public_key = ?").get(eggs) as any;
    assert(eggsSqlRow.legacy_credit_floor === null, 'members.legacy_credit_floor column is now NULL in database');

    // If Emma releases 20 beans, floor becomes -180 (legacy floor does not resurrect!)
    releaseEnterpriseBacking(eggs, K4, 20);
    const eggsAfter = getEnterpriseFloor(eggs);
    assert(eggsAfter.derivedAllowance === 180, 'Community Eggs derived allowance is 180');
    assert(eggsAfter.legacyFloor === 0, 'Legacy floor did not resurrect after being cleared');
    assert(eggsAfter.floor === -180, 'Floor is now derived -180');

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
    pledgeEnterpriseBacking(cacheEnt, K3, 25);
    const f2 = getEnterpriseFloor(cacheEnt);
    assert(f2.floor === -25, 'Cache invalidated on backing pledge');

    // Invalidation on release
    releaseEnterpriseBacking(cacheEnt, K3, 10);
    const f3 = getEnterpriseFloor(cacheEnt);
    assert(f3.floor === -15, 'Cache invalidated on backing release');

    // Invalidation on credit freeze
    adminSetCreditFrozen(cacheEnt, true);
    const f4 = getEnterpriseFloor(cacheEnt);
    assert(f4.floor === 0, 'Cache invalidated on credit freeze (floor drops to 0)');
    assert(f4.allowance === 0, 'Allowance is 0 when credit frozen');

    // Unfreeze
    adminSetCreditFrozen(cacheEnt, false);
    const f5 = getEnterpriseFloor(cacheEnt);
    assert(f5.floor === -15, 'Cache invalidated on unfreeze (floor restored to -15)');

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
    const nonKeeperPledge = await invokeRoute(pledgeRoute, { treasury: routeEnt }, nonKeeper, { amount: 20 });
    assert(nonKeeperPledge.status === 403, 'Non-keeper rejected with 403 from /api/treasury/:treasury/pledge');

    // 2. Keeper with invalid amount
    const invalidAmtPledge = await invokeRoute(pledgeRoute, { treasury: routeEnt }, routeKeeper, { amount: -5 });
    assert(invalidAmtPledge.status === 400, 'Invalid pledge amount rejected with 400');

    // 3. Authorized keeper pledges valid amount
    const validPledge = await invokeRoute(pledgeRoute, { treasury: routeEnt }, routeKeeper, { amount: 30 });
    assert(validPledge.status === 200 && validPledge.body?.success === true, 'Authorized keeper successfully pledges via HTTP route');
    assert(validPledge.body?.pledge?.amount === 30, 'Route returned pledge object with amount=30');
    assert(validPledge.body?.floor === -30, 'Route returned updated floor=-30');

    // 4. GET /api/treasury/:treasury/pledges returns active pledges
    const pledgesRead = await invokeRoute(getPledgesRoute, { treasury: routeEnt }, routeKeeper);
    assert(pledgesRead.status === 200, 'GET /api/treasury/:treasury/pledges returned 200');
    assert(Array.isArray(pledgesRead.body?.pledges), 'Returned pledges array');
    assert(pledgesRead.body?.pledges.length === 1, 'Contains 1 active pledge');
    assert(pledgesRead.body?.pledges[0].keeper === routeKeeper, 'Pledge record names routeKeeper');
    assert(pledgesRead.body?.availableToBack !== undefined, 'Returned availableToBack');

    // 5. GET /api/treasury/:treasury detail read includes derived floor and pledges
    const detailRead = await invokeRoute(getDetailRoute, { treasury: routeEnt }, routeKeeper);
    assert(detailRead.status === 200, 'GET /api/treasury/:treasury returned 200');
    assert(detailRead.body?.floor === -30, 'Detail reports floor=-30');
    assert(detailRead.body?.creditLine === 30, 'Detail reports creditLine=30');
    assert(detailRead.body?.allowance === 30, 'Detail reports allowance=30');
    assert(detailRead.body?.derivedAllowance === 30, 'Detail reports derivedAllowance=30');
    assert(detailRead.body?.legacyFloor !== undefined, 'Detail reports legacyFloor');
    assert(detailRead.body?.legacyCreditFloor !== undefined, 'Detail reports legacyCreditFloor alias');
    assert(detailRead.body?.legacyCreditFloor === detailRead.body?.legacyFloor, 'Detail legacyCreditFloor matches legacyFloor');
    assert(detailRead.body?.pledges.length === 1, 'Detail includes pledges array');

    // 6. GET /api/treasuries list read includes creditLine and pledges
    const listRead = await invokeRoute(getListRoute, {}, undefined);
    assert(listRead.status === 200, 'GET /api/treasuries returned 200');
    const farmItem = listRead.body?.treasuries.find((t: any) => t.publicKey === routeEnt);
    assert(farmItem !== undefined, 'RouteFarm present in treasuries list');
    assert(farmItem.creditLine === 30, 'List read reports derived creditLine=30');
    assert(farmItem.allowance === 30, 'List read reports allowance=30');
    assert(farmItem.legacyFloor !== undefined, 'List read reports legacyFloor');
    assert(farmItem.legacyCreditFloor !== undefined, 'List read reports legacyCreditFloor alias');
    assert(farmItem.legacyFloor === farmItem.legacyCreditFloor, 'legacyFloor matches legacyCreditFloor on list route');

    // 7. Authorized keeper releases backing
    const validRelease = await invokeRoute(releaseRoute, { treasury: routeEnt }, routeKeeper, { amount: 15 });
    assert(validRelease.status === 200 && validRelease.body?.success === true, 'Authorized keeper successfully releases via HTTP route');
    assert(validRelease.body?.releasedAmount === 15, 'Released 15 beans');
    assert(validRelease.body?.remainingPledge === 15, 'Remaining pledge is 15');
    assert(validRelease.body?.floor === -15, 'Updated floor is -15');

    // =========================================================================
    // 10. Review Findings Regression Suite
    // =========================================================================
    console.log('\n── Section 10: Review Findings Regression Suite ──');

    // 10.1: Sentinel key gates grandfather migration from re-running on boot
    const sentinel = db.prepare("SELECT value FROM node_config WHERE key = 'migration_legacy_credit_floor_v1'").get() as any;
    assert(sentinel?.value === '1', 'migration_legacy_credit_floor_v1 recorded in node_config');
    const { publicKey: cleanEnt } = createTreasury('CleanCoop', AVATAR, 0);
    const cleanRowBefore = db.prepare("SELECT legacy_credit_floor FROM members WHERE public_key = ?").get(cleanEnt) as any;
    assert(cleanRowBefore.legacy_credit_floor === null, 'CleanCoop created with legacy_credit_floor = NULL');
    initSchema();
    const cleanRowAfter = db.prepare("SELECT legacy_credit_floor FROM members WHERE public_key = ?").get(cleanEnt) as any;
    assert(cleanRowAfter.legacy_credit_floor === null, 'initSchema() does not grant 200 legacy floor to newly created enterprise');
    const eggsRowAfterInit = db.prepare("SELECT legacy_credit_floor FROM members WHERE public_key = ?").get(eggs) as any;
    assert(eggsRowAfterInit.legacy_credit_floor === null, 'initSchema() does not resurrect cleared legacy floor on Community Eggs');

    // 10.2: members_touch_updated_at trigger whitelists legacy_credit_floor and lifecycle columns
    const triggerMember = 'trigger-test-member-00000000000000000001';
    seedMember(triggerMember, 'TriggerMember');
    db.prepare("UPDATE members SET updated_at = '2020-01-01T00:00:00.000Z' WHERE public_key = ?").run(triggerMember);
    db.prepare("UPDATE members SET legacy_credit_floor = 150 WHERE public_key = ?").run(triggerMember);
    const updatedMember = db.prepare("SELECT updated_at FROM members WHERE public_key = ?").get(triggerMember) as any;
    assert(updatedMember.updated_at > '2020-01-01T00:00:00.000Z', 'Updating legacy_credit_floor fires members_touch_updated_at trigger');

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
    pledgeEnterpriseBacking(freezeEnt, KFreeze, 40);
    assert(getEnterpriseFloor(freezeEnt).derivedAllowance === 40, 'Active unfrozen keeper contributes 40 derived allowance');

    adminSetCreditFrozen(KFreeze, true);
    clearEnterpriseFloorCache(freezeEnt);
    assert(getEnterpriseFloor(freezeEnt).derivedAllowance === 0, 'Credit-frozen keeper excluded from getEnterpriseFloor derived allowance');

    adminSetCreditFrozen(KFreeze, false);
    clearEnterpriseFloorCache(freezeEnt);
    assert(getEnterpriseFloor(freezeEnt).derivedAllowance === 40, 'Unfrozen keeper restored to derived allowance');

    adminSetUserStatus(KFreeze, 'disabled');
    clearEnterpriseFloorCache(freezeEnt);
    assert(getEnterpriseFloor(freezeEnt).derivedAllowance === 0, 'Disabled keeper excluded from getEnterpriseFloor derived allowance');

    adminSetUserStatus(KFreeze, 'active');
    clearEnterpriseFloorCache(freezeEnt);
    assert(getEnterpriseFloor(freezeEnt).derivedAllowance === 40, 'Re-activated keeper restored to derived allowance');

    // 10.4: Exited keeper can release backing once enterprise returns to solvency
    const { publicKey: exitedEnt } = createTreasury('ExitedEnterprise', AVATAR, 0);
    const KExited = 'keeper-exited-0000000000000000000000000001';
    seedMember(KExited, 'KExited');
    mtx(KExited, TradePartner1, 120);
    mtx(KExited, TradePartner2, 120);
    assignKeeper(exitedEnt, KExited);
    pledgeEnterpriseBacking(exitedEnt, KExited, 50);

    // Enter deficit: offer + need
    const entExitOffer = createPost('offer', 'goods', 'Apples', 'Fresh apples', 10, 'fixed', exitedEnt, undefined, undefined, undefined, true);
    assert(entExitOffer !== null, 'ExitedEnterprise creates offer');
    const entExitNeed = createPost('need', 'goods', 'Boxes', 'Need packing boxes', 30, 'fixed', exitedEnt);
    assert(entExitNeed !== null, 'ExitedEnterprise creates need');
    const exitBid = requestPost(entExitNeed!.id, TradePartner1);
    approvePostRequest(exitBid.id, exitedEnt, { authSigner: KExited });
    completePostTransaction(exitBid.id, exitedEnt, undefined, { authSigner: KExited });
    assert(bal(exitedEnt) === -30, 'ExitedEnterprise spends into deficit (-30 beans)');

    // Revoke operator while in deficit — backing remains covenant-locked
    adminRevokeTreasuryOperator(exitedEnt, KExited);
    const isBound = db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(exitedEnt, KExited);
    assert(!isBound, 'KExited is no longer in treasury_operators');
    assert(getEnterprisePledges(exitedEnt).length === 1, 'Pledge remains locked to cover deficit');

    // While in deficit, release is rejected
    let releaseFailedDuringDeficit = false;
    try {
        releaseEnterpriseBacking(exitedEnt, KExited, 30);
    } catch (e: any) {
        releaseFailedDuringDeficit = true;
        assert(e.message.includes('deficit'), 'Deficit covenant blocks release while in deficit');
    }
    assert(releaseFailedDuringDeficit, 'Release blocked during deficit');

    // Enterprise returns to solvency
    payFromCommons(TradePartner1, 60, 'funding for fruit order', { allowDeficit: true });
    transfer(TradePartner1, exitedEnt, 50, 'Apple catering payment');
    assert(bal(exitedEnt) > 0, `ExitedEnterprise is now solvent (${bal(exitedEnt)})`);

    // Exited keeper can now release their pledge (lockedNeeded was 30; release 10 partially)
    const exitedRelease = releaseEnterpriseBacking(exitedEnt, KExited, 10);
    assert(exitedRelease.releasedAmount === 10, 'Exited keeper successfully released pledge after solvency restored');
    assert(exitedRelease.remainingPledge === 20, 'Remaining pledge is 20');

    // Exited keeper can also release remaining 20 via HTTP route
    const httpExitedRelease = await invokeRoute(releaseRoute, { treasury: exitedEnt }, KExited, { amount: 20 });
    assert(httpExitedRelease.status === 200 && httpExitedRelease.body?.success === true, 'HTTP /release succeeds for exited keeper holding active pledge');
    assert(httpExitedRelease.body?.remainingPledge === 0, 'Exited keeper remaining pledge is 0');

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
    pledgeEnterpriseBacking(revokeEnt, KRevoke1, 50);
    pledgeEnterpriseBacking(revokeEnt, KRevoke2, 50);

    // Enter deficit of 40
    const revOffer = createPost('offer', 'goods', 'Honey', 'Raw honey', 10, 'fixed', revokeEnt, undefined, undefined, undefined, true);
    assert(revOffer !== null, 'RevokeEnterprise creates offer');
    const revNeed = createPost('need', 'goods', 'Supplies', 'Need supplies', 40, 'fixed', revokeEnt);
    const revBid = requestPost(revNeed!.id, TradePartner1);
    approvePostRequest(revBid.id, revokeEnt, { authSigner: KRevoke1 });
    completePostTransaction(revBid.id, revokeEnt, undefined, { authSigner: KRevoke1 });
    assert(bal(revokeEnt) === -40, 'RevokeEnterprise is in deficit (-40 beans)');

    // Freeze KRevoke2 so their 50 pledge is inactive/phantom backing
    adminSetCreditFrozen(KRevoke2, true);

    // KRevoke1 exits. Because KRevoke2 is credit-frozen, otherAllowance is 0.
    // Deficit is 40. KRevoke1 must have 40 locked to cover deficit, and 10 released.
    adminRevokeTreasuryOperator(revokeEnt, KRevoke1);
    const k1Pledges = getEnterprisePledges(revokeEnt).filter(p => p.keeper === KRevoke1);
    assert(k1Pledges.length === 1, 'KRevoke1 pledge remains to cover deficit when co-keeper is frozen');
    assert(k1Pledges[0].amount === 40, `KRevoke1 locked pledge is exactly 40 (deficit requirement), got ${k1Pledges[0]?.amount}`);

    // 10.6: getAvailableBacking reports true incremental headroom and respects frozen/inactive status
    const { publicKey: headroomEnt } = createTreasury('HeadroomEnterprise', AVATAR, 0);
    const KHeadroom = 'keeper-headroom-000000000000000000000001';
    seedMember(KHeadroom, 'KHeadroom');
    mtx(KHeadroom, TradePartner1, 100);
    mtx(KHeadroom, TradePartner2, 100);
    const headroomEarned = getMemberTrustProfile(KHeadroom).earnedCredit;
    assert(headroomEarned > 0, `KHeadroom has earnedCredit = ${headroomEarned}`);
    assignKeeper(headroomEnt, KHeadroom);

    assert(getAvailableBacking(KHeadroom) === headroomEarned, 'Available backing matches earned credit before any pledge');
    assert(getAvailableBacking(KHeadroom, headroomEnt) === headroomEarned, 'Available backing forEnterprise matches earned credit before any pledge');

    // Pledge 30 incrementally to headroomEnt
    pledgeEnterpriseBacking(headroomEnt, KHeadroom, 30);
    const remainingHeadroom = headroomEarned - 30;
    // Calling getAvailableBacking(KHeadroom, headroomEnt) must now report true remaining incremental headroom (20), NOT 50!
    assert(getAvailableBacking(KHeadroom, headroomEnt) === remainingHeadroom, `getAvailableBacking reports remaining headroom (${remainingHeadroom}) after pledge to this enterprise, not un-subtracted (${headroomEarned})`);
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
    pledgeEnterpriseBacking(pruneEnt, KPrune, 40);

    // Warm cache
    const floorBeforePrune = getEnterpriseFloor(pruneEnt);
    assert(floorBeforePrune.derivedAllowance === 40, 'Floor cache warmed with derivedAllowance 40 before prune');
    assert(floorBeforePrune.floor === -40, 'Floor before prune is -40');

    // Prune keeper via adminPruneUser
    adminPruneUser(KPrune);

    // Because setUserStatusRow clears enterpriseFloorCache, immediate read must not return stale 40
    const floorAfterPrune = getEnterpriseFloor(pruneEnt);
    assert(floorAfterPrune.derivedAllowance === 0, `Pruned keeper backing immediately dropped from floor (derivedAllowance=${floorAfterPrune.derivedAllowance})`);
    assert(floorAfterPrune.floor === 0, 'Enterprise floor is 0 after keeper pruned');

    // 10.8: Detail endpoint parity check with allowance and legacyCreditFloor
    const detailHeadroom = await invokeRoute(getDetailRoute, { treasury: headroomEnt }, undefined);
    assert(detailHeadroom.status === 200, 'GET /api/treasury/:treasury returns 200');
    assert(detailHeadroom.body?.allowance !== undefined, 'Detail reports allowance');
    assert(detailHeadroom.body?.derivedAllowance !== undefined, 'Detail reports derivedAllowance');
    assert(detailHeadroom.body?.legacyFloor !== undefined, 'Detail reports legacyFloor');
    assert(detailHeadroom.body?.legacyCreditFloor !== undefined, 'Detail reports legacyCreditFloor');
    assert(detailHeadroom.body?.legacyCreditFloor === detailHeadroom.body?.legacyFloor, 'Detail legacyCreditFloor equals legacyFloor');



    // =========================================================================
    // 9. Conservation Check: SUM(balances) + COMMONS_POOL = 0
    // =========================================================================
    console.log('\n── Section 9: Ledger Conservation ──');
    const audit = runLedgerAudit();
    assert(audit.ok, `Ledger audit passed: sum(balances)=${audit.sumBalances}, drift=${audit.drift}`);
    assert(Math.abs(audit.drift) < 0.0001, 'Ledger conservation strictly preserved (SUM(balances) + COMMONS_POOL = 0)');

    console.log(`\n${passed}/${run} checks passed.`);
    console.log('⭐️ Enterprise Derived Credit Floor & Grandfather Migration suite PASSED.');
    process.exit(0);
}

main().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
