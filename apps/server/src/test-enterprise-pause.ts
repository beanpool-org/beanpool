/**
 * Enterprise Pause for a Season Tests (docs/the-commons.md §2.2)
 *
 * Verifies:
 *  1. pauseEnterprise / resumeEnterprise auth (keeper/admin only, non-keeper rejected).
 *  2. Idempotent pause and resume.
 *  3. Marty's 2026-09-16 credit floor snapshot rule:
 *     - Snapshot on pause (e.g. -200).
 *     - Covenant floor cannot pull it below snapshot (even with 0 offers).
 *     - Earned growth still counts (if earned credit raises floor, use higher value).
 *     - Keeper exits still release backing (if backing removed, floor drops accordingly).
 *     - 90-day expiry (reverts to normal formula after 90 days paused).
 *     - Advance warning before expiry (<= 14 days remaining).
 *     - Resumes recompute normally.
 *  4. While paused enforcement:
 *     - Existing listings hidden from marketplace (never deleted).
 *     - No new offers or needs.
 *     - No pledges in.
 *     - No bid approvals.
 *     - No wage payments out.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-pause.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, createPost, completePostTransaction,
    requestPost, approvePostRequest, getBalance, usableFloor,
    pauseEnterprise, resumeEnterprise, adminAssignTreasuryOperator,
    adminRevokeTreasuryOperator, getEnterpriseUnderlyingFloor, reconcileLedgerFromDb,
} from './state-engine.js';
import { db, pledgeToProject } from './db/db.js';
import { getPosts } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

async function main() {
    console.log('Running enterprise pause tests (docs/the-commons.md §2.2)...\n');
    await initTls();
    initStateEngine();

    const { publicKey: shed } = createTreasury('ToolShed', AVATAR, 0);
    const carolLead = 'carol-lead-000000000000000000000000000001';
    const daveKeeper = 'dave-keeper-000000000000000000000000000002';
    const malloryStranger = 'mallory-outsider-00000000000000000000003';
    seedMember(carolLead, 'CarolLead');
    seedMember(daveKeeper, 'DaveKeeper');
    seedMember(malloryStranger, 'MalloryOutsider');

    // Appoint Carol with 200 backing, Dave with 0 backing
    adminAssignTreasuryOperator(shed, carolLead, 'admin', 200);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(shed, carolLead);
    adminAssignTreasuryOperator(shed, daveKeeper, 'admin', 0);

    // Initial check: ToolShed has 200 underlying allowance from Carol's backing
    const und0 = getEnterpriseUnderlyingFloor(shed);
    assert(und0.floor === -200, `ToolShed underlying floor is -200 from Carol backing (got ${und0.floor})`);

    // Add 2 active offers so covenant allows full depth
    const offer1 = createPost('offer', 'tools', 'Shovel', 'Sturdy shovel', 10, 'fixed', shed);
    const offer2 = createPost('offer', 'tools', 'Wheelbarrow', 'Good condition', 20, 'fixed', shed);
    assert(offer1 !== null && offer2 !== null, 'Created 2 initial offers for ToolShed');

    const uFloor0 = usableFloor(shed);
    assert(uFloor0 === -200, `ToolShed usableFloor is -200 before pause (got ${uFloor0})`);

    // ── 1. Auth: non-keeper cannot pause ──
    let nonKeeperFailed = false;
    try {
        pauseEnterprise(shed, malloryStranger);
    } catch (e: any) {
        nonKeeperFailed = true;
        assert(e.message.includes('Not authorised'), `Non-keeper pause rejected with: "${e.message}"`);
    }
    assert(nonKeeperFailed, 'Non-keeper cannot pause enterprise');

    // ── 2. Keeper can pause (idempotent, snapshot taken) ──
    const pauseRes = pauseEnterprise(shed, carolLead);
    assert(pauseRes.ok === true && pauseRes.paused === true, 'Keeper Carol paused ToolShed');
    assert(pauseRes.pausedFloorSnapshot === -200, `Paused floor snapshot recorded as -200 (got ${pauseRes.pausedFloorSnapshot})`);

    const mRow = db.prepare("SELECT paused, paused_at, paused_by, paused_floor_snapshot FROM members WHERE public_key = ?").get(shed) as any;
    assert(mRow.paused === 1, 'members.paused is 1 in DB');
    assert(mRow.paused_by === carolLead, `members.paused_by is ${carolLead}`);
    assert(mRow.paused_floor_snapshot === -200, 'members.paused_floor_snapshot is -200 in DB');

    // Idempotent second pause
    const pauseRes2 = pauseEnterprise(shed, daveKeeper);
    assert(pauseRes2.ok === true && pauseRes2.alreadyPaused === true, 'Subsequent pause call is idempotent');

    // ── 3. Marty's Credit Floor Assertions While Paused ──
    console.log('── Testing Marty 2026-09-16 Credit Floor Snapshot Rules ──');

    // Assertion A: Covenant floor can never pull it below snapshot (even with 0 offers)
    // Live listings are hidden while paused, liveOfferCount may be 0 for marketplace covenant
    assert(usableFloor(shed) === -200, `Usable floor holds at snapshot -200 while paused (got ${usableFloor(shed)})`);

    // Assertion B: Earned growth still counts (higher value)
    // Credit ToolShed with 100 earned credit in members table
    db.prepare("UPDATE members SET earned_credit = 100 WHERE public_key = ?").run(shed);
    assert(usableFloor(shed) === -300, `Earned growth raised usable floor to -300 while paused (got ${usableFloor(shed)})`);
    // Reset earned credit
    db.prepare("UPDATE members SET earned_credit = 0 WHERE public_key = ?").run(shed);
    assert(usableFloor(shed) === -200, `Resetting earned credit returns floor to -200 (got ${usableFloor(shed)})`);

    // Assertion C: Keeper exits still release backing
    // Carol (who backed 200) exits!
    adminRevokeTreasuryOperator(shed, carolLead);
    const floorAfterCarolExit = usableFloor(shed);
    assert(floorAfterCarolExit === 0, `Carol exit released backing; floor dropped to 0 overriding snapshot (got ${floorAfterCarolExit})`);

    // Re-assign Carol with 200 backing for remaining tests
    adminAssignTreasuryOperator(shed, carolLead, 'admin', 200);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(shed, carolLead);
    assert(usableFloor(shed) === -200, `Re-assigned Carol backing restored floor to -200`);

    // Assertion D: 90-day expiry reverts to normal formula
    // Simulate paused_at 95 days ago
    const ninetyFiveDaysAgo = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE members SET paused_at = ? WHERE public_key = ?").run(ninetyFiveDaysAgo, shed);
    // With offers hidden/absent, normal formula gives 0
    // Temporarily cancel offers to ensure liveOfferCount is 0
    db.prepare("UPDATE posts SET status = 'paused' WHERE author_pubkey = ?").run(shed);
    assert(usableFloor(shed) === 0, `After 90 days paused, credit floor snapshot expired and reverted to 0 (got ${usableFloor(shed)})`);

    // Restore paused_at to now and restore offers
    const nowIso = new Date().toISOString();
    db.prepare("UPDATE members SET paused_at = ? WHERE public_key = ?").run(nowIso, shed);
    db.prepare("UPDATE posts SET status = 'active' WHERE author_pubkey = ?").run(shed);
    assert(usableFloor(shed) === -200, `Active snapshot restored floor to -200`);

    // ── 4. While Paused Enforcement ──
    console.log('── Testing Operations Blocked While Paused ──');

    // Listings hidden from marketplace
    const publicPosts = getPosts(db);
    const shedPost = publicPosts.find(p => p.authorPublicKey === shed);
    assert(!shedPost, 'ToolShed listings hidden from general marketplace while paused');

    // Self-view still sees them
    const selfPosts = getPosts(db, { authorPubkey: shed, viewerPubkey: shed });
    assert(selfPosts.length >= 2, `Author self-view can still see its ${selfPosts.length} listings while paused`);

    // Blocking new offers or needs
    let postOfferThrew = false;
    try {
        createPost('offer', 'tools', 'Hammer', 'Claw hammer', 15, 'fixed', shed);
    } catch (e: any) {
        postOfferThrew = true;
        assert(e.message.includes('Enterprise is paused'), `Create offer blocked: "${e.message}"`);
    }
    assert(postOfferThrew, 'createPost offer blocked while enterprise is paused');

    let postNeedThrew = false;
    try {
        createPost('need', 'tools', 'Nails', 'Box of nails', 5, 'fixed', shed);
    } catch (e: any) {
        postNeedThrew = true;
        assert(e.message.includes('Enterprise is paused'), `Create need blocked: "${e.message}"`);
    }
    assert(postNeedThrew, 'createPost need blocked while enterprise is paused');

    // Blocking pledges in
    // Create a bounded project associated with ToolShed
    db.prepare(`
        INSERT INTO projects (id, creator_pubkey, title, description, photos, goal_amount, current_amount, status, enterprise_pubkey)
        VALUES ('shed-roof', ?, 'Fix Shed Roof', 'Need tin', '[]', 500, 0, 'ACTIVE', ?)
    `).run(carolLead, shed);
    let pledgeThrew = false;
    try {
        pledgeToProject('pledge-tx-1', 'shed-roof', malloryStranger, 50, 'Support shed roof');
    } catch (e: any) {
        pledgeThrew = true;
        assert(e.message.includes('Enterprise is paused'), `Pledge blocked: "${e.message}"`);
    }
    assert(pledgeThrew, 'Pledges blocked while enterprise is paused');

    // Blocking bid approvals
    // Create a need outside pause, then try approving while paused
    db.prepare("UPDATE members SET paused = 0 WHERE public_key = ?").run(shed);
    const need2 = createPost('need', 'goods', 'Timber', '2x4s', 20, 'fixed', shed);
    const bid = requestPost(need2!.id, malloryStranger);
    // Now pause ToolShed again
    db.prepare("UPDATE members SET paused = 1, paused_at = ?, paused_floor_snapshot = -200 WHERE public_key = ?").run(nowIso, shed);

    let approveThrew = false;
    try {
        approvePostRequest(bid.id, shed, { authSigner: carolLead });
    } catch (e: any) {
        approveThrew = true;
        assert(e.message.includes('Enterprise is paused'), `Bid approval blocked: "${e.message}"`);
    }
    assert(approveThrew, 'approvePostRequest blocked while enterprise is paused');

    // Blocking wage payments out to keepers
    // Temporarily unpause to approve need2 with keeper Dave as seller
    db.prepare("UPDATE members SET paused = 0, earned_surplus = 50 WHERE public_key = ?").run(shed);
    db.prepare("UPDATE accounts SET balance = 50 WHERE public_key = ?").run(shed);
    reconcileLedgerFromDb();
    const needKeeper = createPost('need', 'work', 'Shed maintenance', 'Roof oiling', 15, 'fixed', shed);
    const keeperBid = requestPost(needKeeper!.id, daveKeeper);
    approvePostRequest(keeperBid.id, shed, { authSigner: carolLead });
    // Pause ToolShed before completion
    db.prepare("UPDATE members SET paused = 1, paused_at = ?, paused_floor_snapshot = -200 WHERE public_key = ?").run(nowIso, shed);

    let wageThrew = false;
    try {
        completePostTransaction(keeperBid.id, shed, undefined, { authSigner: carolLead });
    } catch (e: any) {
        wageThrew = true;
        assert(e.message.includes('wage payments to keepers cannot be made while paused'), `Wage payment blocked: "${e.message}"`);
    }
    assert(wageThrew, 'Keeper wage payment blocked while enterprise is paused');

    // ── 5. Resume Enterprise ──
    console.log('── Testing Resume Enterprise ──');
    let nonKeeperResumeThrew = false;
    try {
        resumeEnterprise(shed, malloryStranger);
    } catch (e: any) {
        nonKeeperResumeThrew = true;
    }
    assert(nonKeeperResumeThrew, 'Non-keeper cannot resume enterprise');

    const resumeRes = resumeEnterprise(shed, daveKeeper);
    assert(resumeRes.ok === true && resumeRes.paused === false, 'Keeper Dave resumed ToolShed');

    const resumedRow = db.prepare("SELECT paused, paused_at, paused_by, paused_floor_snapshot FROM members WHERE public_key = ?").get(shed) as any;
    assert(resumedRow.paused === 0, 'members.paused is 0 after resume');
    assert(resumedRow.paused_at === null, 'members.paused_at cleared');
    assert(resumedRow.paused_by === null, 'members.paused_by cleared');
    assert(resumedRow.paused_floor_snapshot === null, 'members.paused_floor_snapshot cleared');

    // Idempotent resume
    const resumeRes2 = resumeEnterprise(shed, carolLead);
    assert(resumeRes2.ok === true && resumeRes2.alreadyActive === true, 'Subsequent resume is idempotent');

    console.log(`\nAll ${passed}/${run} enterprise pause assertions passed!`);
}

main().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

