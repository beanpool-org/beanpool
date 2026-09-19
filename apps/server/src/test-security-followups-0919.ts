/**
 * Test Suite: pre-launch security follow-ups from the deciding reviews of #925 and #924 (2026-09-19).
 *
 * 1. Speeding up a community-passed removal of an owner or admin needs owner level: it takes away the grace
 *    window in which an owner could halt it.
 * 2. An admin may not arbitrate an escrow dispute they are a party to (buyer, seller, or keeper of an enterprise
 *    party); the password is refused when an owner is a party.
 * 3. Overlapping holds: an emergency suspension's vote failing while a removal is pending hands the held role to
 *    the removal, so an owner halting the removal gives the member back WITH their role.
 * 4. A branch prune that would leave the node without an active owner is refused before anyone is pruned.
 * 5. Offboard and re-key routes resolve the actor like every other admin route: a key session whose member no
 *    longer holds an admin role is refused.
 * 6. Group chat lines have their own per-member bucket: members chatting behind one IP do not lock that IP out
 *    of recovery lookup.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-security-followups-0919.ts
 */

import crypto from 'node:crypto';
import {
    initStateEngine,
    createDecision,
    getDecision,
    tickDecisions,
    grantNodeRole,
    createGroup,
    joinGroup,
    transfer,
    createPost,
    acceptPost,
} from './state-engine.js';
import * as decisionsEngine from './decisions-engine.js';
import { createAdminRoutes } from './routes/admin.js';
import { createCommunityRoutes } from './routes/community.js';
import { createGroupRoutes } from './routes/groups.js';
import { createMessagingRoutes } from './routes/messaging.js';
import { authRateLimit } from './auth-rate-limit.js';
import { resetChatRateLimit, CHAT_LINES_PER_MINUTE } from './chat-rate-limit.js';
import { db } from './db/db.js';
import { setCommonsBalance } from '@beanpool/core';
import type { RouteDeps } from './routes/types.js';

let testsRun = 0;
let testsPassed = 0;
const SOFT = process.env.SOFT_ASSERT === '1';

function assert(cond: any, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        if (!SOFT) throw new Error(`Assertion failed: ${msg}`);
    }
}

const NAT_IP = '203.0.113.7';

const deps: RouteDeps = {
    checkAdminAuth: async () => true, // password-authenticated admin unless a test passes a signed actor
    rateLimit: authRateLimit,         // the real per-IP auth limiter
    clampLimit: (_v: unknown, def = 20) => def,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
};

async function callRouter(
    router: any,
    method: string,
    path: string,
    opts: { actor?: string; body?: Record<string, unknown>; ip?: string } = {}
): Promise<{ status: number; body: any }> {
    const layer = (router as any).stack.find((l: any) =>
        l.regexp.test(path) && l.methods.includes(method.toUpperCase())
    );
    if (!layer) throw new Error(`${method} ${path} is not mounted in router`);
    const params: Record<string, string> = {};
    const match = layer.regexp.exec(path);
    if (match && layer.paramNames) {
        layer.paramNames.forEach((p: any, i: number) => {
            if (match[i + 1] !== undefined) params[p.name] = decodeURIComponent(match[i + 1]);
        });
    }
    const ctx: any = {
        state: opts.actor ? { actor: opts.actor, auth_signer: opts.actor } : {},
        requestBody: opts.body ?? {},
        params,
        query: {},
        querystring: '',
        ip: opts.ip ?? '198.51.100.1',
        headers: {},
        set: () => {},
        get: () => '',
        status: 200,
        body: undefined,
    };
    try {
        await layer.stack[layer.stack.length - 1](ctx, async () => {});
    } catch (err: any) {
        if (!ctx.status || ctx.status === 200) {
            ctx.status = err.status || 500;
            ctx.body = { error: err.message };
        }
    }
    return { status: ctx.status, body: ctx.body };
}

function makeMember(callsign: string): string {
    const pk = crypto.randomBytes(32).toString('hex');
    db.prepare(`
        INSERT INTO members (public_key, callsign, joined_at, status, earned_credit, avatar_url, updated_at)
        VALUES (?, ?, ?, 'active', 100, 'data:image/png;base64,iVBORw0KGgo=', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(pk, callsign, new Date(Date.now() - 60 * 86400_000).toISOString());
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0) ON CONFLICT(public_key) DO NOTHING').run(pk);
    return pk;
}

const statusOf = (pk: string): string => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as any)?.status;
const roleRow = (pk: string): any =>
    db.prepare('SELECT role, granted_at, granted_by, session_epoch, break_glass_hash FROM node_roles WHERE member_pubkey = ?').get(pk);
const heldRows = (pk: string): any[] => db.prepare('SELECT decision_id, role FROM suspended_node_roles WHERE member_pubkey = ?').all(pk) as any[];
const closeForTick = (id: string) => db.prepare("UPDATE decisions SET closes_at = datetime('now', '-10 seconds') WHERE id = ?").run(id);

function pendingEscrowRow(buyer: string, seller: string): string {
    const id = 'mt-' + crypto.randomUUID();
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
        VALUES (?, ?, ?, ?, 10, 'pending', ?)
    `).run(id, 'post-' + crypto.randomUUID(), buyer, seller, new Date().toISOString());
    return id;
}
const txStatus = (id: string): string => (db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(id) as any)?.status;

async function run() {
    console.log('🔐 Running security follow-ups suite (0919)...\n');
    initStateEngine();
    setCommonsBalance(5000);
    const admin = createAdminRoutes(deps);
    const community = createCommunityRoutes(deps);
    const groups = createGroupRoutes(deps);
    const messaging = createMessagingRoutes(deps);

    const owner = makeMember('Owner');
    grantNodeRole(owner, 'owner');
    const plainAdmin = makeMember('PlainAdmin');
    grantNodeRole(plainAdmin, 'admin', owner);

    // ── 1. Accelerating the removal of an owner or admin ─────────────────────────────────
    console.log('\n--- 1. Accelerate needs owner level for an owner/admin subject ---');
    const doomedAdmin = makeMember('DoomedAdmin');
    grantNodeRole(doomedAdmin, 'admin', owner);
    const removeAdmin = createDecision({ authorPubkey: owner, title: 'Remove DoomedAdmin', description: 'Accelerate test', touches: 'member', effect: 'remove_member', subject: doomedAdmin });
    const exec1 = decisionsEngine.executeDecision(removeAdmin.id);
    assert(exec1.status === 'execution_pending_grace' && statusOf(doomedAdmin) === 'disabled', `the removal enters its grace window (got ${exec1.status})`);
    const accelPlain = await callRouter(admin, 'POST', `/api/local/admin/decisions/${removeAdmin.id}/accelerate`, { actor: plainAdmin });
    assert(accelPlain.status === 403 && /only an owner/i.test(accelPlain.body?.error || '') && /Ask an owner/.test(accelPlain.body?.error || ''),
        `a plain admin cannot cut short the grace window on removing an admin (got ${accelPlain.status} ${JSON.stringify(accelPlain.body)})`);
    assert(getDecision(removeAdmin.id)!.status === 'execution_pending_grace' && statusOf(doomedAdmin) === 'disabled' && heldRows(doomedAdmin).length === 1,
        'and nothing changes: still in grace, still held aside, so an owner can halt it');
    const accelOwner = await callRouter(admin, 'POST', `/api/local/admin/decisions/${removeAdmin.id}/accelerate`, { actor: owner });
    assert(accelOwner.status === 200 && statusOf(doomedAdmin) === 'pruned' && getDecision(removeAdmin.id)!.status === 'executed',
        `an owner can speed it up (got ${accelOwner.status} ${JSON.stringify(accelOwner.body)})`);

    const doomedOwner = makeMember('DoomedOwner');
    grantNodeRole(doomedOwner, 'owner', owner);
    const removeOwner = createDecision({ authorPubkey: owner, title: 'Remove DoomedOwner', description: 'Accelerate test', touches: 'member', effect: 'remove_member', subject: doomedOwner });
    decisionsEngine.executeDecision(removeOwner.id);
    const accelPlainOwner = await callRouter(admin, 'POST', `/api/local/admin/decisions/${removeOwner.id}/accelerate`, { actor: plainAdmin });
    assert(accelPlainOwner.status === 403 && statusOf(doomedOwner) === 'disabled', 'nor on removing an owner');
    const accelPassword = await callRouter(admin, 'POST', `/api/local/admin/decisions/${removeOwner.id}/accelerate`);
    assert(accelPassword.status === 200 && statusOf(doomedOwner) === 'pruned', 'the password (owner level) can');

    const plainMember = makeMember('PlainMember');
    const removePlain = createDecision({ authorPubkey: owner, title: 'Remove PlainMember', description: 'Accelerate test', touches: 'member', effect: 'remove_member', subject: plainMember });
    decisionsEngine.executeDecision(removePlain.id);
    const accelPlainMember = await callRouter(admin, 'POST', `/api/local/admin/decisions/${removePlain.id}/accelerate`, { actor: plainAdmin });
    assert(accelPlainMember.status === 200 && statusOf(plainMember) === 'pruned', 'a plain admin may still speed up the removal of a member with no role');

    // ── 3. Overlapping holds ─────────────────────────────────────────────────────────────
    console.log('\n--- 3. A failed keep vote hands the held role to a pending removal ---');
    const overlap = makeMember('OverlapAdmin');
    grantNodeRole(overlap, 'admin', owner);
    const roleBefore = roleRow(overlap);
    const suspended = await callRouter(admin, 'POST', `/api/local/admin/users/${overlap}/suspend`, { actor: owner, body: { reason: 'Emergency suspension, then a removal vote' } });
    assert(suspended.status === 200, `an owner emergency-suspends an admin (got ${suspended.status} ${JSON.stringify(suspended.body)})`);
    const keep = suspended.body.decision;
    const removeOverlap = createDecision({ authorPubkey: owner, title: 'Remove OverlapAdmin', description: 'Overlap test', touches: 'member', effect: 'remove_member', subject: overlap });
    const exec3 = decisionsEngine.executeDecision(removeOverlap.id);
    assert(exec3.status === 'execution_pending_grace', `the removal passes while the keep vote is open (got ${exec3.status})`);
    assert(heldRows(overlap).length === 1 && heldRows(overlap)[0].decision_id === keep.id, 'the role is held by the keep vote alone');
    closeForTick(keep.id);
    tickDecisions();
    assert(['unresolved', 'failed'].includes(getDecision(keep.id)!.status) && statusOf(overlap) === 'disabled',
        `the keep vote does not pass; the pending removal keeps them suspended (got ${getDecision(keep.id)!.status}, ${statusOf(overlap)})`);
    const held3 = heldRows(overlap);
    assert(held3.length === 1 && held3[0].decision_id === removeOverlap.id && held3[0].role === 'admin',
        `the held admin role moves to the removal instead of being deleted (got ${JSON.stringify(held3)})`);
    const haltPlain3 = await callRouter(admin, 'POST', `/api/local/admin/decisions/${removeOverlap.id}/halt`, { actor: plainAdmin, body: { reason: 'Plain admin tries to halt it' } });
    assert(haltPlain3.status === 403, 'so a plain admin cannot halt the removal (it would hand back an admin role)');
    const haltOwner3 = await callRouter(admin, 'POST', `/api/local/admin/decisions/${removeOverlap.id}/halt`, { actor: owner, body: { reason: 'Owner halts the removal' } });
    const roleAfter = roleRow(overlap);
    assert(haltOwner3.status === 200 && statusOf(overlap) === 'active', 'an owner halts the removal and the member is active again');
    assert(roleAfter?.role === 'admin' && roleAfter.granted_at === roleBefore.granted_at && roleAfter.granted_by === roleBefore.granted_by,
        `WITH their admin role (was ${JSON.stringify(roleBefore)}, now ${JSON.stringify(roleAfter)})`);
    assert(heldRows(overlap).length === 0, 'and nothing is left held aside');

    // ── 2. Escrow dispute: no admin judges their own case ─────────────────────────────────
    console.log('\n--- 2. An admin cannot resolve a dispute they are a party to ---');
    const stranger = makeMember('Stranger');
    const buyerTx = pendingEscrowRow(plainAdmin, stranger);
    const asBuyer = await callRouter(admin, 'POST', `/api/local/admin/disputes/${buyerTx}/resolve`, { actor: plainAdmin, body: { action: 'refund_to_buyer' } });
    assert(asBuyer.status === 403 && /party to this dispute/.test(asBuyer.body?.error || '') && txStatus(buyerTx) === 'pending',
        `the buyer cannot refund themselves (got ${asBuyer.status} ${JSON.stringify(asBuyer.body)})`);
    const sellerTx = pendingEscrowRow(stranger, plainAdmin);
    const asSeller = await callRouter(admin, 'POST', `/api/local/admin/disputes/${sellerTx}/resolve`, { actor: plainAdmin, body: { action: 'release_to_seller' } });
    assert(asSeller.status === 403 && txStatus(sellerTx) === 'pending', 'the seller cannot release to themselves');
    const enterprise = makeMember('Egg Co');
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(enterprise);
    db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role) VALUES (?, ?, 'admin')").run(enterprise, plainAdmin);
    const entTx = pendingEscrowRow(stranger, enterprise);
    const asKeeper = await callRouter(admin, 'POST', `/api/local/admin/disputes/${entTx}/resolve`, { actor: plainAdmin, body: { action: 'release_to_seller' } });
    assert(asKeeper.status === 403 && txStatus(entTx) === 'pending', 'a keeper of an enterprise that is a party cannot resolve it');
    const ownerTx = pendingEscrowRow(owner, stranger);
    const byPassword = await callRouter(admin, 'POST', `/api/local/admin/disputes/${ownerTx}/resolve`, { body: { action: 'refund_to_buyer' } });
    assert(byPassword.status === 403 && /owner is a party/.test(byPassword.body?.error || '') && txStatus(ownerTx) === 'pending',
        `the password is refused when an owner is a party — it cannot show which owner is acting (got ${byPassword.status})`);

    // A dispute with no admin on either side is resolved as before, by a key admin or the password.
    const buyer = makeMember('Buyer');
    const seller = makeMember('Seller');
    const buyer2 = makeMember('Buyer2');
    for (const pk of [buyer, seller, buyer2]) transfer('genesis', pk, 200, 'seed', 'direct', true);
    createPost('offer', 'services', 'Weeding', 'Garden weeding', 20, 'fixed', buyer);
    createPost('offer', 'services', 'Mowing', 'Lawn mowing', 20, 'fixed', buyer2);
    const eggs = createPost('offer', 'goods', 'A dozen eggs', 'Free range eggs from the yard', 10, 'fixed', seller)!;
    const jam = createPost('offer', 'goods', 'Plum jam', 'Homemade plum jam, one jar', 10, 'fixed', seller)!;
    const fairTx = acceptPost(eggs.id, buyer)!;
    const fairTx2 = acceptPost(jam.id, buyer2)!;
    const byOtherAdmin = await callRouter(admin, 'POST', `/api/local/admin/disputes/${fairTx.id}/resolve`, { actor: plainAdmin, body: { action: 'refund_to_buyer' } });
    assert(byOtherAdmin.status === 200 && txStatus(fairTx.id) === 'cancelled', `an admin who is not a party resolves it (got ${byOtherAdmin.status} ${JSON.stringify(byOtherAdmin.body)})`);
    const byPasswordFair = await callRouter(admin, 'POST', `/api/local/admin/disputes/${fairTx2.id}/resolve`, { body: { action: 'release_to_seller' } });
    assert(byPasswordFair.status === 200 && txStatus(fairTx2.id) === 'completed', 'and the password still can when no owner is a party');

    // ── 5. Offboard and re-key resolve the actor like every admin route ──────────────────
    console.log('\n--- 5. Offboard and re-key use resolveAdminActor ---');
    const target = makeMember('RekeyTarget');
    const demoted = makeMember('Demoted'); // a key session whose member holds no admin role (any more)
    const issueDemoted = await callRouter(admin, 'POST', `/api/local/admin/members/${target}/rekey/issue-code`, { actor: demoted });
    assert(issueDemoted.status === 403 && !issueDemoted.body?.code, `a key session without an admin role cannot issue a re-key code (got ${issueDemoted.status})`);
    const completeDemoted = await callRouter(admin, 'POST', `/api/local/admin/members/${target}/rekey/complete`, { actor: demoted, body: { code: 'ABC-123', newPubkey: 'ab'.repeat(32) } });
    assert(completeDemoted.status === 403, 'nor complete one');
    const offboardDemoted = await callRouter(admin, 'POST', `/api/local/admin/members/${target}/offboard`, { actor: demoted, body: { resolution: 'prune_zero_balance' } });
    assert(offboardDemoted.status === 403 && statusOf(target) === 'active', 'nor offboard a member');
    const previewDemoted = await callRouter(admin, 'GET', `/api/local/admin/members/${target}/offboard/preview`, { actor: demoted });
    assert(previewDemoted.status === 403, 'nor read the offboard preview');
    const issueAdmin = await callRouter(admin, 'POST', `/api/local/admin/members/${target}/rekey/issue-code`, { actor: plainAdmin });
    assert(issueAdmin.status === 200 && issueAdmin.body.operator === plainAdmin, 'a key admin can, attributed to their key');
    const issuePassword = await callRouter(admin, 'POST', `/api/local/admin/members/${target}/rekey/issue-code`);
    assert(issuePassword.status === 200 && issuePassword.body.operator === 'owner:password', "and the password can, as 'owner:password'");
    const giftPassword = await callRouter(admin, 'POST', `/api/local/admin/members/${target}/offboard`, { body: { resolution: 'gift_to_member', giftRecipientPubkey: stranger } });
    assert(giftPassword.status === 403 && giftPassword.body?.code === 'KEY_AUTH_REQUIRED', 'gifting offboarded funds still needs a key session');

    // ── 6. Group chat has its own per-member bucket ──────────────────────────────────────
    console.log('\n--- 6. Group chat does not share the per-IP auth limiter ---');
    resetChatRateLimit();
    const alice = makeMember('Alice');
    const bob = makeMember('Bob');
    const hall = createGroup({ name: 'Hall Committee', joinPolicy: 'open', createdBy: alice });
    joinGroup(hall.id, bob);
    let sentOk = 0;
    for (let i = 0; i < 10; i++) {
        for (const pk of [alice, bob]) {
            const r = await callRouter(groups, 'POST', `/api/groups/${hall.id}/chat/message`, { actor: pk, ip: NAT_IP, body: { text: `line ${i}` } });
            if (r.status === 201) sentOk++;
        }
    }
    assert(sentOk === 20, `20 group lines from two members behind one IP all go through (got ${sentOk})`);
    const lookup = await callRouter(community, 'GET', '/api/recovery/lookup/alice', { ip: NAT_IP });
    assert(lookup.status === 200, `a recovery lookup from that IP is not locked out (got ${lookup.status} ${JSON.stringify(lookup.body)})`);
    const viaSend = await callRouter(messaging, 'POST', '/api/messages/send', {
        actor: bob, ip: NAT_IP,
        body: { conversationId: hall.id, authorPubkey: bob, ciphertext: Buffer.from('old app line').toString('base64'), nonce: 'plaintext-v1' },
    });
    assert(viaSend.status === 200 && viaSend.body?.success === true, `a group line through the old send route uses the same chat bucket (got ${viaSend.status})`);
    let aliceLast = 0;
    for (let i = 10; i < CHAT_LINES_PER_MINUTE; i++) {
        aliceLast = (await callRouter(groups, 'POST', `/api/groups/${hall.id}/chat/message`, { actor: alice, ip: NAT_IP, body: { text: `more ${i}` } })).status;
    }
    assert(aliceLast === 201, `Alice can send ${CHAT_LINES_PER_MINUTE} lines in a minute`);
    const aliceOver = await callRouter(groups, 'POST', `/api/groups/${hall.id}/chat/message`, { actor: alice, ip: NAT_IP, body: { text: 'one too many' } });
    assert(aliceOver.status === 429, `line ${CHAT_LINES_PER_MINUTE + 1} from Alice is refused`);
    const bobStill = await callRouter(groups, 'POST', `/api/groups/${hall.id}/chat/message`, { actor: bob, ip: NAT_IP, body: { text: 'still here' } });
    assert(bobStill.status === 201, 'while Bob, on the same IP, keeps his own budget');
    const lookupAfter = await callRouter(community, 'GET', '/api/recovery/lookup/bob', { ip: NAT_IP });
    assert(lookupAfter.status === 200, 'and recovery lookup from that IP still works');

    // ── 4. Branch prune that would leave no owner ────────────────────────────────────────
    // Last: it rearranges who the node's owners are.
    console.log('\n--- 4. A branch prune is all or nothing on the sole-owner rule ---');
    const root = makeMember('BranchRoot');
    const sibling = makeMember('BranchSibling');
    db.prepare('UPDATE members SET invited_by = ? WHERE public_key IN (?, ?)').run(root, sibling, owner);
    const otherOwners = (db.prepare("SELECT nr.member_pubkey FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey WHERE nr.role = 'owner' AND m.status = 'active' AND nr.member_pubkey != ?").all(owner) as any[]);
    assert(otherOwners.length === 0, 'setup: Owner is the only active owner');
    const pruneSole = await callRouter(admin, 'POST', `/api/local/admin/branches/${root}/prune`);
    assert(pruneSole.status === 400 && /only owner/.test(pruneSole.body?.error || ''), `a branch holding the only owner is refused (got ${pruneSole.status} ${JSON.stringify(pruneSole.body)})`);
    assert(statusOf(root) === 'active' && statusOf(sibling) === 'active' && statusOf(owner) === 'active', 'and nobody in it is pruned — not even those walked before the owner');
    const coOwner = makeMember('BranchCoOwner');
    grantNodeRole(coOwner, 'owner', owner);
    db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(sibling, coOwner);
    const pruneBoth = await callRouter(admin, 'POST', `/api/local/admin/branches/${root}/prune`);
    assert(pruneBoth.status === 400 && [root, sibling, owner, coOwner].every(pk => statusOf(pk) === 'active'),
        'two co-owners who are the only owners, both in the branch: refused too, nobody pruned');
    const outsideOwner = makeMember('OutsideOwner');
    grantNodeRole(outsideOwner, 'owner', owner);
    const prunedOk = await callRouter(admin, 'POST', `/api/local/admin/branches/${root}/prune`, { actor: outsideOwner });
    assert(prunedOk.status === 200 && [root, sibling, owner, coOwner].every(pk => statusOf(pk) === 'pruned') && statusOf(outsideOwner) === 'active',
        `with an owner left outside the branch, it prunes the whole branch (got ${prunedOk.status} ${JSON.stringify(prunedOk.body)})`);

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ Security follow-ups hold.');
}

run().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
