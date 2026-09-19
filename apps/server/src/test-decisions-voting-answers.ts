/**
 * Test Suite: Marty's voting answers for Community Decisions (board, 2026-09-19).
 *
 * H. Pool-money votes: quadratic, a fresh allowance on each Decision; a member with no completed trade is told
 *    plainly; the list serves the number the server checks (qualifiedTradeValue).
 * I. Secret ballots: no response or broadcast says who voted how; the caller still sees their own vote.
 * J. Who may vote: active, unfrozen members who joined BEFORE the Decision opened. joined_at survives a
 *    backup restore.
 * K. Turnout: 30% (25% for removal) of the Decision's electorate ACTIVE in the last 30 days — any signed
 *    activity, not only trades — never fewer than 3. Last activity is backed by records that survive a restore.
 * L. Emergency suspension: an admin suspends at once and a 7-day "Keep this suspension?" Decision opens in the
 *    same step; not passing lifts it; the admin halt works from the settings app (password auth) with a reason.
 *
 * Follow-ups from the review of #921:
 * - L: a plain admin cannot emergency-suspend an owner; a suspension that is lifted (voted down, unresolved,
 *   halted, lifted by hand) gives back exactly the node role the member held; a kept one does not.
 * - K: node-written ledger rows FROM a member (the circulation fee) are not member activity.
 * - I: lastActiveAt is served to the UTC day to everyone but the member; admin keys (params.suspendedBy,
 *   adminHaltedBy) are not served to members.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-decisions-voting-answers.ts
 */

import crypto from 'node:crypto';
import {
    initStateEngine,
    createDecision,
    getDecision,
    castDecisionVote,
    tallyDecision,
    tickDecisions,
    getActiveMembersCount30d,
    grantNodeRole,
    addWsClient,
    removeWsClient,
    exportSyncState,
    importRemoteState,
    setNodeRole,
} from './state-engine.js';
import * as decisionsEngine from './decisions-engine.js';
import { createCommonsRoutes } from './routes/commons.js';
import { createAdminRoutes } from './routes/admin.js';
import { createCommunityRoutes } from './routes/community.js';
import { db } from './db/db.js';
import { setCommonsBalance } from '@beanpool/core';
import * as engine from '@beanpool/engine';
import type { RouteDeps } from './routes/types.js';

let testsRun = 0;
let testsPassed = 0;
// SOFT_ASSERT=1 keeps going past a failed check, so the suite can be run against an older server to list every
// rule it does not meet. CI never sets it.
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

const deps: RouteDeps = {
    checkAdminAuth: async () => true, // password-authenticated admin: owner level, no signed actor
    rateLimit: () => true,
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
    opts: { actor?: string; body?: Record<string, unknown> } = {}
): Promise<{ status: number; body: any }> {
    const layer = (router as any).stack.find((l: any) =>
        l.regexp.test(path) && l.methods.includes(method.toUpperCase())
    );
    if (!layer) {
        if (SOFT) return { status: 404, body: { error: 'not mounted' } };
        throw new Error(`${method} ${path} is not mounted in router`);
    }
    const params: Record<string, string> = {};
    const match = layer.regexp.exec(path);
    if (match && layer.paramNames) {
        layer.paramNames.forEach((p: any, i: number) => {
            if (match[i + 1] !== undefined) params[p.name] = decodeURIComponent(match[i + 1]);
        });
    }
    const ctx: any = {
        state: opts.actor ? { actor: opts.actor } : {},
        requestBody: opts.body ?? {},
        params,
        query: {},
        querystring: '',
        set: () => {},
        get: () => '',
        status: 200,
        body: undefined,
        throw: (status: number, message: string) => {
            ctx.status = status;
            ctx.body = { error: message };
            const err = new Error(message);
            (err as any).status = status;
            throw err;
        },
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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A member. By default they joined 60 days ago and have NO recorded activity (last_active_at NULL), so they
 * count toward no turnout until a test gives them some.
 */
function makeMember(callsign: string, opts: { joinedAt?: string; lastActiveAt?: string | null; earnedCredit?: number; frozen?: boolean; status?: string } = {}): string {
    const pk = crypto.randomBytes(32).toString('hex');
    db.prepare(`
        INSERT INTO members (public_key, callsign, joined_at, status, credit_frozen, earned_credit, last_active_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(pk, callsign, opts.joinedAt ?? new Date(Date.now() - 60 * DAY).toISOString(), opts.status ?? 'active',
        opts.frozen ? 1 : 0, opts.earnedCredit ?? 100, opts.lastActiveAt ?? null);
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0) ON CONFLICT(public_key) DO NOTHING').run(pk);
    return pk;
}

function completedTrade(buyer: string, seller: string, credits: number, at = new Date()): void {
    const iso = at.toISOString();
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)
    `).run('mt-' + crypto.randomUUID(), 'post-' + crypto.randomUUID(), buyer, seller, credits, iso, iso);
}

function markActive(pk: string, at = new Date()): void {
    db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(at.toISOString(), pk);
}

function closeForTick(id: string): void {
    db.prepare("UPDATE decisions SET closes_at = datetime('now', '-10 seconds') WHERE id = ?").run(id);
}

function roleRow(pk: string): any {
    return db.prepare('SELECT role, granted_at, granted_by, session_epoch, break_glass_hash FROM node_roles WHERE member_pubkey = ?').get(pk);
}

/** The role row, bar the session epoch, which a restore moves on by one (old admin sessions stay dead). */
function sameRole(before: any, after: any): boolean {
    return !!before && !!after && before.role === after.role && before.granted_at === after.granted_at
        && before.granted_by === after.granted_by && before.break_glass_hash === after.break_glass_hash
        && after.session_epoch === before.session_epoch + 1;
}

function statusOf(pk: string): string {
    return (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as any)?.status;
}

/** Retire everyone who could still count toward turnout, so each block measures its own electorate. */
function quietEveryone(): void {
    db.prepare("UPDATE members SET last_active_at = NULL").run();
    db.prepare("DELETE FROM marketplace_transactions").run();
    db.prepare("DELETE FROM posts").run();
    db.prepare("DELETE FROM decision_votes").run();
    db.prepare("UPDATE decisions SET status = 'failed' WHERE status = 'open'").run();
}

async function run() {
    console.log('🗳️  Running voting-answers suite (H, I, J, K, L)...\n');
    initStateEngine();
    setCommonsBalance(5000);
    const commons = createCommonsRoutes(deps);
    const admin = createAdminRoutes(deps);

    const community = createCommunityRoutes(deps);
    const owner = makeMember('Owner', { lastActiveAt: new Date().toISOString() });
    grantNodeRole(owner, 'owner');
    const secondOwner = makeMember('SecondOwner');
    grantNodeRole(secondOwner, 'owner', owner);
    const enterprise = makeMember('Egg Co');
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(enterprise);

    // ── H. Pool-money votes ───────────────────────────────────────────────
    console.log('\n--- H. Pool-money votes ---');
    const proposerA = makeMember('ProposerA');
    const proposerB = makeMember('ProposerB');
    const trader = makeMember('Trader');
    const partner1 = makeMember('Partner1');
    const partner2 = makeMember('Partner2');
    const noTrader = makeMember('NoTrader');
    completedTrade(trader, partner1, 10);
    completedTrade(partner2, trader, 6);

    const poolA = createDecision({ authorPubkey: proposerA, title: 'Grant A', description: 'Seed money for the eggs', touches: 'pool', effect: 'grant_enterprise', subject: enterprise, params: { amount: 10 } });
    const poolB = createDecision({ authorPubkey: proposerB, title: 'Grant B', description: 'Feed for the winter', touches: 'pool', effect: 'grant_enterprise', subject: enterprise, params: { amount: 10 } });

    const noTradeVote = castDecisionVote(poolA.id, noTrader, true, 1);
    assert(!noTradeVote.success && noTradeVote.error === 'Voting on community money opens after your first completed trade.',
        `a member with no completed trade is told plainly (got "${noTradeVote.error}")`);
    assert((decisionsEngine as any).NO_TRADE_POOL_VOTE_ERROR === noTradeVote.error, 'the message is the exported constant the apps mirror');
    const noTradeMemberVote = castDecisionVote(
        createDecision({ authorPubkey: noTrader, title: 'Freeze someone', description: 'Member vote, not money', touches: 'member', effect: 'freeze_credit', subject: makeMember('FreezeTarget') }).id,
        noTrader, true);
    assert(noTradeMemberVote.success, 'the same member still votes one-member-one-vote on member Decisions');

    const qtv = engine.qualifiedTradeValue(db, trader);
    assert(qtv === 16, `trader's qualified trade value is 16 (got ${qtv})`);
    const onA = castDecisionVote(poolA.id, trader, true, 4);
    const onB = castDecisionVote(poolB.id, trader, true, 4);
    assert(onA.success && onA.creditsUsed === 16, '4 votes (16 credits) on the first pool Decision');
    assert(onB.success && onB.creditsUsed === 16, 'a fresh allowance: 4 votes (16 credits) again on the second one');
    const tooMany = castDecisionVote(poolA.id, trader, true, 5);
    assert(!tooMany.success && tooMany.error === '5 votes cost 25 voice credits, and you have 16.',
        `over-spending one Decision is refused in plain words (got "${tooMany.error}")`);

    const listForTrader = await callRouter(commons, 'GET', '/api/commons/decisions', { actor: trader });
    assert(listForTrader.body.myPoolVoting?.voiceCredits === 16,
        `the list serves the signer's voice credits = qualifiedTradeValue (got ${JSON.stringify(listForTrader.body.myPoolVoting)})`);
    assert(listForTrader.body.myPoolVoting?.hasCompletedTrade === true, 'and that they have a completed trade');
    const listForNoTrader = await callRouter(commons, 'GET', '/api/commons/decisions', { actor: noTrader });
    assert(listForNoTrader.body.myPoolVoting?.voiceCredits === 0 && listForNoTrader.body.myPoolVoting?.hasCompletedTrade === false,
        'a no-trade member is told 0 credits and no trade, so the card can say so before they try');
    const listUnsigned = await callRouter(commons, 'GET', '/api/commons/decisions');
    assert(listUnsigned.body.myPoolVoting === null, 'an unsigned caller gets no voice credits');
    // Who may propose, served so the apps gate on the node's rule: earned standing, or a node admin.
    const noStanding = makeMember('NoStanding', { earnedCredit: 0 });
    const bareAdmin = makeMember('BareAdmin', { earnedCredit: 0 });
    grantNodeRole(bareAdmin, 'admin', owner);
    assert((await callRouter(commons, 'GET', '/api/commons/decisions', { actor: trader })).body.canPropose === true, 'a member with earned standing may propose');
    assert((await callRouter(commons, 'GET', '/api/commons/decisions', { actor: noStanding })).body.canPropose === false, 'a member with no earned standing may not');
    assert((await callRouter(commons, 'GET', '/api/commons/decisions', { actor: bareAdmin })).body.canPropose === true, 'a node admin with no trades may');
    assert(listUnsigned.body.canPropose === false, 'an unsigned caller may not');

    // ── I. Secret ballots ─────────────────────────────────────────────────
    console.log('\n--- I. Secret ballots ---');
    const seen: any[] = [];
    const fakeSocket = { send: (m: string) => seen.push(JSON.parse(m)), readyState: 1 };
    addWsClient(fakeSocket);
    seen.length = 0;
    const secretVote = castDecisionVote(poolA.id, partner1, false, 1);
    removeWsClient(fakeSocket);
    assert(secretVote.success, 'partner1 votes No on pool A');
    const castEvent = seen.find(e => e.type === 'decision_vote_cast');
    assert(!!castEvent && castEvent.decisionId === poolA.id, 'a decision_vote_cast event still announces that the tally moved');
    assert(castEvent && !('voterPubkey' in castEvent) && !('support' in castEvent) && !('weight' in castEvent) && !('creditCost' in castEvent),
        `the broadcast names no voter, side or weight (got keys ${castEvent ? Object.keys(castEvent).join(',') : 'none'})`);
    assert(!JSON.stringify(seen).includes(partner1), 'no broadcast carries the voter key');

    const detailAsOther = await callRouter(commons, 'GET', `/api/commons/decisions/${poolA.id}`, { actor: proposerA });
    assert(detailAsOther.status === 200 && !('votes' in detailAsOther.body), 'GET /decisions/:id no longer returns a votes list');
    const detailJson = JSON.stringify(detailAsOther.body);
    assert(!detailJson.includes(partner1) && !detailJson.includes(trader), 'the detail response contains no other voter key');
    assert(detailAsOther.body.tally.noWeight === 1 && detailAsOther.body.tally.yesWeight === 4, 'totals are still served');
    const detailAsVoter = await callRouter(commons, 'GET', `/api/commons/decisions/${poolA.id}`, { actor: partner1 });
    assert(detailAsVoter.body.myVote?.support === false, 'the caller still sees their own vote');
    const listAsOther = await callRouter(commons, 'GET', '/api/commons/decisions', { actor: proposerA });
    const listJson = JSON.stringify(listAsOther.body);
    assert(!listJson.includes(partner1) && !listJson.includes(trader), 'the list contains no voter key');
    const adminList = await callRouter(admin, 'POST', '/api/local/admin/decisions');
    const adminJson = JSON.stringify(adminList.body);
    assert(adminList.status === 200 && !adminJson.includes(partner1) && !adminJson.includes(trader),
        'the admin Decisions list serves totals only, never voters');
    assert((db.prepare('SELECT COUNT(*) AS c FROM decision_votes WHERE decision_id = ?').get(poolA.id) as any).c === 2,
        'votes stay stored against keys (dedup and verification)');

    // ── J. Who may vote ───────────────────────────────────────────────────
    console.log('\n--- J. Joined before the Decision opened ---');
    const jProposer = makeMember('JProposer');
    const oldHand = makeMember('OldHand');
    const jSubject = makeMember('JSubject');
    const jDecision = createDecision({ authorPubkey: jProposer, title: 'Freeze JSubject', description: 'Late invitees test', touches: 'member', effect: 'freeze_credit', subject: jSubject });
    const newcomer = makeMember('Newcomer', { joinedAt: new Date(Date.now() + 1000).toISOString() });
    const lateVote = castDecisionVote(jDecision.id, newcomer, true);
    assert(!lateVote.success && lateVote.error === 'Only members who joined before this Decision opened can vote on it.',
        `a member who joined after the Decision opened cannot vote on it (got "${lateVote.error}")`);
    const sameInstant = makeMember('SameInstant', { joinedAt: jDecision.opensAt });
    assert(!castDecisionVote(jDecision.id, sameInstant, true).success, 'joining at the very instant it opened is not "before"');
    assert(castDecisionVote(jDecision.id, oldHand, true).success, 'a member who joined earlier votes');
    const frozen = makeMember('Frozen', { frozen: true });
    assert(!castDecisionVote(jDecision.id, frozen, true).success, 'a frozen member cannot vote');
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(new Date(Date.now() - HOUR).toISOString(), newcomer);
    const laterDecision = createDecision({ authorPubkey: oldHand, title: 'Unfreeze JSubject', description: 'Opened after the newcomer joined', touches: 'member', effect: 'unfreeze_credit', subject: jSubject });
    assert(castDecisionVote(laterDecision.id, newcomer, true).success, 'the same member votes on a Decision opened after they joined');

    // ── K. Turnout ────────────────────────────────────────────────────────
    console.log('\n--- K. Turnout: 30% of members active in 30 days ---');
    quietEveryone();
    const kNow = Date.now();
    // Ten members active by signed activity alone — no trades at all.
    const signedOnly = Array.from({ length: 10 }, (_, i) => makeMember(`SignedOnly${i}`, { lastActiveAt: new Date(kNow - 2 * DAY).toISOString() }));
    assert(getActiveMembersCount30d() === 10, `members active only by signed activity count (got ${getActiveMembersCount30d()}; main counted traders only)`);
    makeMember('LongQuiet', { lastActiveAt: new Date(kNow - 45 * DAY).toISOString() });
    assert(getActiveMembersCount30d() === 10, 'a member last active 45 days ago does not count');
    const quietFrozen = makeMember('ActiveButFrozen', { lastActiveAt: new Date().toISOString(), frozen: true });
    const quietSuspended = makeMember('ActiveButSuspended', { lastActiveAt: new Date().toISOString(), status: 'disabled' });
    assert(getActiveMembersCount30d() === 10, 'frozen and suspended members, who cannot vote, are not in the turnout base');
    void quietFrozen; void quietSuspended;
    // Restored from a delta backup: last_active_at lagged, but the trade and the post travelled with the backup.
    const restoredTrader = makeMember('RestoredTrader', { lastActiveAt: new Date(kNow - 90 * DAY).toISOString() });
    completedTrade(restoredTrader, signedOnly[0], 5, new Date(kNow - 3 * DAY));
    const restoredPoster = makeMember('RestoredPoster');
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at) VALUES (?, 'offer', 'food', 'Eggs', 'Fresh eggs', 5, ?, ?)`)
        .run('post-' + crypto.randomUUID(), restoredPoster, new Date(kNow - 3 * DAY).toISOString());
    assert(getActiveMembersCount30d() === 12, `a stale last_active_at is backed by the trade and post records a backup carries (got ${getActiveMembersCount30d()})`);
    // The node writes the daily circulation fee as a ledger row FROM the member (engine/audit.ts), unsigned by
    // them. A member whose only recent row is that fee did nothing and is not active.
    const demurrageOnly = makeMember('DemurrageOnly');
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, 'COMMONS_POOL', 0.05, 0, 'Circulation fee (demurrage, 1d)', ?)`)
        .run(`demurrage_${demurrageOnly.slice(0, 16)}_1_2`, demurrageOnly, new Date(kNow - DAY).toISOString());
    assert(getActiveMembersCount30d() === 12, `a member whose only ledger row is the node's circulation fee is not active (got ${getActiveMembersCount30d()})`);
    // A payment the member signed (auth_signer = them) is activity even with a stale last_active_at.
    const signedSender = makeMember('SignedSender', { lastActiveAt: new Date(kNow - 90 * DAY).toISOString() });
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp, auth_signer) VALUES (?, ?, ?, 2, 0, 'Thanks for the eggs', ?, ?)`)
        .run('tx-' + crypto.randomUUID(), signedSender, signedOnly[0], new Date(kNow - DAY).toISOString(), signedSender);
    assert(getActiveMembersCount30d() === 13, `a payment the member signed counts (got ${getActiveMembersCount30d()})`);
    db.prepare('DELETE FROM transactions WHERE from_pubkey = ?').run(signedSender);
    assert(getActiveMembersCount30d() === 12, 'back to 12 without it');

    const kSubject = makeMember('KSubject');
    const kDecision = createDecision({ authorPubkey: signedOnly[1], title: 'Suspend KSubject', description: 'Turnout test', touches: 'member', effect: 'suspend_member', subject: kSubject });
    const kTally = tallyDecision(kDecision.id);
    assert(kTally.electorate === 12 && kTally.quorumRatio === 0.3 && kTally.quorumRequired === 4,
        `quorum = ceil(30% x 12) = 4 (got electorate ${kTally.electorate}, ratio ${kTally.quorumRatio}, required ${kTally.quorumRequired})`);
    const lateActive = makeMember('LateActive', { joinedAt: new Date(Date.now() + 1000).toISOString(), lastActiveAt: new Date().toISOString() });
    assert(tallyDecision(kDecision.id).electorate === 12, 'a member who joined after it opened is not in its electorate (they cannot vote on it)');
    assert(getActiveMembersCount30d() === 13, 'though they count for a later Decision');
    void lateActive;
    const removal = createDecision({ authorPubkey: signedOnly[2], title: 'Remove KSubject', description: 'Removal turnout test', touches: 'member', effect: 'remove_member', subject: kSubject });
    const rTally = tallyDecision(removal.id);
    assert(rTally.quorumRatio === 0.25 && rTally.quorumRequired === 3, `removal stays at 25% (ceil(0.25 x 12) = 3; got ${rTally.quorumRequired})`);
    quietEveryone();
    const tiny = createDecision({ authorPubkey: signedOnly[3], title: 'Suspend again', description: 'Floor test', touches: 'member', effect: 'suspend_member', subject: kSubject });
    assert(tallyDecision(tiny.id).quorumRequired === 3, 'never fewer than 3');
    // A vote is itself signed activity.
    castDecisionVote(tiny.id, signedOnly[4], true);
    assert(getActiveMembersCount30d() >= 1, 'casting a vote counts as activity');

    // Recording: every signed write stamps last_active_at, and a heartbeat does not resend the member row.
    const heartbeat = makeMember('Heartbeat');
    const before = (db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(heartbeat) as any).updated_at;
    markActive(heartbeat);
    const after = (db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(heartbeat) as any).updated_at;
    assert(before === after, 'a last_active_at heartbeat does not bump updated_at — why delta backups can lag it (documented, and why trades/posts back it up)');

    // ── L. Emergency suspension ───────────────────────────────────────────
    console.log('\n--- L. Emergency suspension ---');
    quietEveryone();
    const voters = Array.from({ length: 5 }, (_, i) => makeMember(`LVoter${i}`, { lastActiveAt: new Date().toISOString() }));
    const troll = makeMember('Troll', { lastActiveAt: new Date().toISOString() });
    // Troll is an admin: each suspension that does not hold must give that role back exactly.
    grantNodeRole(troll, 'admin', owner);
    const trollRole = roleRow(troll);

    const noReason = await callRouter(admin, 'POST', `/api/local/admin/users/${troll}/suspend`, { body: { reason: 'bad' } });
    assert(noReason.status === 400 && statusOf(troll) === 'active', 'a suspension needs a reason of at least 10 characters');
    const oldRoute = await callRouter(admin, 'POST', `/api/local/admin/users/${troll}/status`, { body: { status: 'disabled' } });
    assert(oldRoute.status === 400 && statusOf(troll) === 'active', 'the old status route can no longer suspend without a community vote');

    const suspended = await callRouter(admin, 'POST', `/api/local/admin/users/${troll}/suspend`, { body: { reason: 'Posting threats in the market chat' } });
    assert(suspended.status === 200 && statusOf(troll) === 'disabled', 'an admin suspends immediately');
    const keep = suspended.body.decision;
    assert(keep && keep.effect === 'keep_suspension' && keep.status === 'open' && keep.subject === troll,
        'the same step opens a "Keep this suspension?" Decision');
    const windowDays = (Date.parse(keep.closesAt) - Date.parse(keep.opensAt)) / DAY;
    assert(Math.abs(windowDays - 7) < 0.001, `it runs 7 days (got ${windowDays})`);
    assert(keep.franchise === '1m1v' && keep.touches === 'member' && keep.authorPubkey === 'SYSTEM',
        'one member one vote, opened by the node itself');
    assert(keep.params.memberName === 'Troll' && keep.params.reason === 'Posting threats in the market chat' && keep.params.suspendedBy === 'owner:password',
        'the card has the name, the reason and who suspended');
    assert(keep.description.startsWith(`An admin suspended Troll on ${keep.opensAt.slice(0, 10)}. Keep the suspension?`),
        `the Decision explains itself (got "${keep.description}")`);
    const keepTally = tallyDecision(keep.id);
    assert(keepTally.thresholdRequired === 0.6 && keepTally.quorumRatio === 0.3, '60% to keep, usual 30% quorum');

    const again = await callRouter(admin, 'POST', `/api/local/admin/users/${troll}/suspend`, { body: { reason: 'Posting threats in the market chat' } });
    assert(again.status === 409, 'suspending someone already suspended is refused');
    const troll2 = makeMember('Troll2');
    const second = await callRouter(admin, 'POST', `/api/local/admin/users/${troll2}/suspend`, { body: { reason: 'Second emergency the same day' } });
    assert(second.status === 200, 'a second emergency suspension can be open at the same time (the node authors both)');
    let memberRefused = '';
    try {
        createDecision({ authorPubkey: voters[0], title: 'Keep?', description: 'A member trying the system effect', touches: 'member', effect: 'keep_suspension', subject: troll2 });
    } catch (e: any) { memberRefused = e.message; }
    assert(/opened by the node/.test(memberRefused), 'a member cannot propose a keep_suspension Decision');
    // node_roles: only an owner may take an owner's role, and a suspension takes it. A plain admin cannot.
    const plainAdmin = makeMember('PlainAdmin');
    grantNodeRole(plainAdmin, 'admin', owner);
    const byPlainAdmin = await callRouter(admin, 'POST', `/api/local/admin/users/${secondOwner}/suspend`, { actor: plainAdmin, body: { reason: 'An admin trying to strip a co-owner' } });
    assert(byPlainAdmin.status === 403 && statusOf(secondOwner) === 'active' && roleRow(secondOwner)?.role === 'owner',
        `a plain admin cannot emergency-suspend an owner (got ${byPlainAdmin.status} ${JSON.stringify(byPlainAdmin.body)})`);
    assert(!(db.prepare("SELECT 1 FROM decisions WHERE subject = ? AND effect = 'keep_suspension'").get(secondOwner)), 'and no vote opens');
    const secondOwnerRole = roleRow(secondOwner);
    const ownerSuspend = await callRouter(admin, 'POST', `/api/local/admin/users/${secondOwner}/suspend`, { actor: owner, body: { reason: 'Trying to lock out the other owner' } });
    assert(ownerSuspend.status === 200, 'with two owners, another owner can suspend one (and the vote decides)');
    assert(!roleRow(secondOwner), 'while suspended they hold no node role');
    const nonAdmin = await callRouter(admin, 'POST', `/api/local/admin/users/${voters[4]}/suspend`, { actor: voters[3], body: { reason: 'A key session without an admin role' } });
    assert(nonAdmin.status === 403 && statusOf(voters[4]) === 'active', 'a key session whose member holds no admin role is refused');
    const enterpriseSuspend = await callRouter(admin, 'POST', `/api/local/admin/users/${enterprise}/suspend`, { body: { reason: 'An enterprise is not a person' } });
    assert(enterpriseSuspend.status === 400, 'an enterprise account cannot be emergency-suspended');

    // Not enough turnout → it lifts by itself.
    closeForTick(keep.id);
    tickDecisions();
    const keepAfter = getDecision(keep.id)!;
    assert(keepAfter.status === 'unresolved' && statusOf(troll) === 'active',
        `unresolved on quorum lifts the suspension (status ${keepAfter.status}, member ${statusOf(troll)})`);
    assert(/lifted/.test(keepAfter.executionReason || ''), 'the record says it was lifted');
    assert(sameRole(trollRole, roleRow(troll)), `unresolved gives back exactly the admin role Troll held (was ${JSON.stringify(trollRole)}, now ${JSON.stringify(roleRow(troll))})`);
    const trollRole2 = roleRow(troll);

    // Voted down → it lifts.
    const downVote = (await callRouter(admin, 'POST', `/api/local/admin/users/${troll}/suspend`, { body: { reason: 'Second incident, same person' } })).body.decision;
    for (const v of voters.slice(0, 3)) castDecisionVote(downVote.id, v, false);
    castDecisionVote(downVote.id, voters[3], true);
    closeForTick(downVote.id);
    tickDecisions();
    assert(getDecision(downVote.id)!.status === 'failed' && statusOf(troll) === 'active', 'voted down (25% yes) lifts the suspension');
    assert(sameRole(trollRole2, roleRow(troll)), 'and gives the role back exactly');

    // Kept → stays suspended.
    const keptVote = (await callRouter(admin, 'POST', `/api/local/admin/users/${troll}/suspend`, { body: { reason: 'Third incident, same person' } })).body.decision;
    for (const v of voters.slice(0, 4)) castDecisionVote(keptVote.id, v, true);
    closeForTick(keptVote.id);
    tickDecisions();
    assert(getDecision(keptVote.id)!.status === 'executed' && statusOf(troll) === 'disabled', 'kept by 60%+ → the suspension stays');
    assert(!roleRow(troll), 'kept: the node role stays gone');
    assert(!(db.prepare('SELECT 1 FROM suspended_node_roles WHERE decision_id = ?').get(keptVote.id)), 'and nothing is held aside for it any more');

    // The admin halt from the settings app: password auth, written reason required; halting the vote lifts it.
    const halt = second.body.decision;
    // Troll2 was a moderator before their suspension (set up here: the role row is what was held aside).
    db.prepare(`INSERT INTO suspended_node_roles (decision_id, member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
                VALUES (?, ?, 'moderator', '2026-01-01T00:00:00.000Z', ?, 3, NULL)`).run(halt.id, troll2, owner);
    const haltNoReason = await callRouter(admin, 'POST', `/api/local/admin/decisions/${halt.id}/halt`, { body: { reason: 'short' } });
    assert(haltNoReason.status === 400 && getDecision(halt.id)!.status === 'open', 'halting needs a written reason (10+ characters)');
    const halted = await callRouter(admin, 'POST', `/api/local/admin/decisions/${halt.id}/halt`, { body: { reason: 'Suspended the wrong account by mistake' } });
    assert(halted.status === 200, `a password-authenticated admin (the settings app) can halt (got ${halted.status} ${JSON.stringify(halted.body)})`);
    const haltedRow = getDecision(halt.id)!;
    assert(haltedRow.status === 'admin_halted' && haltedRow.adminHaltReason === 'Suspended the wrong account by mistake', 'halted with the public reason');
    assert(statusOf(troll2) === 'active', 'halting the ratifying vote lifts the suspension');
    const troll2Role = roleRow(troll2);
    assert(troll2Role?.role === 'moderator' && troll2Role.granted_by === owner && troll2Role.granted_at === '2026-01-01T00:00:00.000Z' && troll2Role.session_epoch === 4,
        `halting gives back the role held aside (got ${JSON.stringify(troll2Role)})`);

    // An admin lifting by hand closes the open vote.
    const ownerKeep = ownerSuspend.body.decision;
    const lifted = await callRouter(admin, 'POST', `/api/local/admin/users/${secondOwner}/status`, { body: { status: 'active' } });
    assert(lifted.status === 200 && statusOf(secondOwner) === 'active', 'an admin can lift a suspension');
    assert(getDecision(ownerKeep.id)!.status === 'admin_halted', 'and the open "Keep?" vote closes with it');
    assert(sameRole(secondOwnerRole, roleRow(secondOwner)), `lifting by hand gives the owner role back exactly (was ${JSON.stringify(secondOwnerRole)}, now ${JSON.stringify(roleRow(secondOwner))})`);
    const plainAgain = await callRouter(admin, 'POST', `/api/local/admin/users/${secondOwner}/suspend`, { actor: plainAdmin, body: { reason: 'Still an owner after the restore' } });
    assert(plainAgain.status === 403, 'restored, they are an owner again: a plain admin still cannot suspend them');

    // Key session admin: attributed to their key.
    const keyAdmin = voters[2];
    grantNodeRole(keyAdmin, 'admin', owner);
    const byKey = await callRouter(admin, 'POST', `/api/local/admin/users/${voters[1]}/suspend`, { actor: keyAdmin, body: { reason: 'Signed admin session suspension' } });
    assert(byKey.status === 200 && byKey.body.decision.params.suspendedBy === keyAdmin, 'a signed admin session is attributed to its key');

    // Giving back an owner or admin role takes an owner (node_roles: only an owner grants them). These use a
    // KEY-authenticated plain admin — the password acts as owner, which is how the halt test above missed it.
    const coAdmin = makeMember('CoAdmin');
    grantNodeRole(coAdmin, 'admin', owner);
    const coAdminRole = roleRow(coAdmin);
    const coAdminSuspend = await callRouter(admin, 'POST', `/api/local/admin/users/${coAdmin}/suspend`, { actor: keyAdmin, body: { reason: 'Suspending a fellow admin at once' } });
    assert(coAdminSuspend.status === 200 && statusOf(coAdmin) === 'disabled' && !roleRow(coAdmin), 'a plain admin may emergency-suspend another admin');
    const coAdminKeepId = coAdminSuspend.body.decision.id;
    const liftByPlain = await callRouter(admin, 'POST', `/api/local/admin/users/${coAdmin}/status`, { actor: keyAdmin, body: { status: 'active' } });
    assert(liftByPlain.status === 403 && statusOf(coAdmin) === 'disabled' && !roleRow(coAdmin),
        `a key-authenticated plain admin cannot lift it — that would hand back an admin role (got ${liftByPlain.status} ${JSON.stringify(liftByPlain.body)})`);
    assert(/only an owner/i.test(liftByPlain.body?.error || ''), `and is told why (got "${liftByPlain.body?.error}")`);
    const haltKeepByPlain = await callRouter(admin, 'POST', `/api/local/admin/decisions/${coAdminKeepId}/halt`, { actor: keyAdmin, body: { reason: 'Halting to give the admin role back' } });
    assert(haltKeepByPlain.status === 403 && getDecision(coAdminKeepId)!.status === 'open' && statusOf(coAdmin) === 'disabled' && !roleRow(coAdmin),
        `nor halt its "Keep?" vote (got ${haltKeepByPlain.status} ${JSON.stringify(haltKeepByPlain.body)})`);
    const liftByOwnerKey = await callRouter(admin, 'POST', `/api/local/admin/users/${coAdmin}/status`, { actor: owner, body: { status: 'active' } });
    assert(liftByOwnerKey.status === 200 && statusOf(coAdmin) === 'active' && sameRole(coAdminRole, roleRow(coAdmin)),
        `an owner's key lifts it and the admin role comes back exactly (got ${liftByOwnerKey.status}, ${JSON.stringify(roleRow(coAdmin))})`);
    // Held owner role, halted by a plain admin: refused too.
    const thirdOwner = makeMember('ThirdOwner');
    grantNodeRole(thirdOwner, 'owner', owner);
    const thirdOwnerSuspend = await callRouter(admin, 'POST', `/api/local/admin/users/${thirdOwner}/suspend`, { actor: owner, body: { reason: 'An owner suspends a co-owner' } });
    const haltOwnerKeepByPlain = await callRouter(admin, 'POST', `/api/local/admin/decisions/${thirdOwnerSuspend.body.decision.id}/halt`, { actor: keyAdmin, body: { reason: 'Halting to give the owner role back' } });
    assert(haltOwnerKeepByPlain.status === 403 && statusOf(thirdOwner) === 'disabled' && !roleRow(thirdOwner), 'a plain admin cannot halt the vote on a suspended owner either');
    const haltOwnerKeepByOwner = await callRouter(admin, 'POST', `/api/local/admin/decisions/${thirdOwnerSuspend.body.decision.id}/halt`, { actor: owner, body: { reason: 'Owner halts it, role comes back' } });
    assert(haltOwnerKeepByOwner.status === 200 && statusOf(thirdOwner) === 'active' && roleRow(thirdOwner)?.role === 'owner', 'an owner can, and the owner role comes back');
    db.prepare('DELETE FROM node_roles WHERE member_pubkey = ?').run(thirdOwner); // the sole-owner check below needs Owner alone
    // A member who held no role: a plain admin still lifts it.
    const roleless = makeMember('Roleless');
    await callRouter(admin, 'POST', `/api/local/admin/users/${roleless}/suspend`, { actor: keyAdmin, body: { reason: 'Suspending a member with no role' } });
    const liftRoleless = await callRouter(admin, 'POST', `/api/local/admin/users/${roleless}/status`, { actor: keyAdmin, body: { status: 'active' } });
    assert(liftRoleless.status === 200 && statusOf(roleless) === 'active' && !roleRow(roleless), 'a plain admin may lift the suspension of a member who held no role');

    // A passed removal holds the role aside through its grace window; halting it gives the role back (owner only).
    const graceAdmin = makeMember('GraceAdmin');
    grantNodeRole(graceAdmin, 'admin', owner);
    const graceRole = roleRow(graceAdmin);
    const removeAdmin = createDecision({ authorPubkey: owner, title: 'Remove GraceAdmin', description: 'Grace-window role test', touches: 'member', effect: 'remove_member', subject: graceAdmin });
    const graceExec = decisionsEngine.executeDecision(removeAdmin.id);
    assert(graceExec.status === 'execution_pending_grace' && statusOf(graceAdmin) === 'disabled' && !roleRow(graceAdmin),
        `a passed removal suspends them for the grace window and takes the role (got ${graceExec.status})`);
    const graceHaltPlain = await callRouter(admin, 'POST', `/api/local/admin/decisions/${removeAdmin.id}/halt`, { actor: keyAdmin, body: { reason: 'Halting the removal of an admin' } });
    assert(graceHaltPlain.status === 403 && getDecision(removeAdmin.id)!.status === 'execution_pending_grace' && statusOf(graceAdmin) === 'disabled',
        `a plain admin cannot halt it — it would hand back an admin role (got ${graceHaltPlain.status} ${JSON.stringify(graceHaltPlain.body)})`);
    const graceHaltOwner = await callRouter(admin, 'POST', `/api/local/admin/decisions/${removeAdmin.id}/halt`, { actor: owner, body: { reason: 'Owner halts the removal in grace' } });
    assert(graceHaltOwner.status === 200 && statusOf(graceAdmin) === 'active' && sameRole(graceRole, roleRow(graceAdmin)),
        `an owner halts it: reactivated WITH the admin role, exactly (got ${JSON.stringify(roleRow(graceAdmin))})`);
    // A community reinstatement cancelling the grace window gives the role back too.
    const reinstated = makeMember('Reinstated');
    grantNodeRole(reinstated, 'moderator', owner);
    const reinstatedRole = roleRow(reinstated);
    const removeMod = createDecision({ authorPubkey: owner, title: 'Remove Reinstated', description: 'Reinstatement role test', touches: 'member', effect: 'remove_member', subject: reinstated });
    decisionsEngine.executeDecision(removeMod.id);
    const reinstate = createDecision({ authorPubkey: owner, title: 'Reinstate', description: 'Community changes its mind', touches: 'member', effect: 'reinstate_member', subject: reinstated });
    decisionsEngine.executeDecision(reinstate.id);
    assert(getDecision(removeMod.id)!.status === 'failed' && statusOf(reinstated) === 'active' && sameRole(reinstatedRole, roleRow(reinstated)),
        `reinstatement cancels the removal and gives the role back (got ${getDecision(removeMod.id)!.status}, ${JSON.stringify(roleRow(reinstated))})`);

    // Pruning: only an owner may prune an owner or admin (a suspended one's held role counts).
    const pruneCoOwner = makeMember('PruneCoOwner');
    grantNodeRole(pruneCoOwner, 'owner', owner);
    const prunePlain = await callRouter(admin, 'POST', `/api/local/admin/users/${pruneCoOwner}/prune`, { actor: keyAdmin });
    assert(prunePlain.status === 403 && statusOf(pruneCoOwner) === 'active' && roleRow(pruneCoOwner)?.role === 'owner',
        `a plain admin cannot prune a co-owner (got ${prunePlain.status} ${JSON.stringify(prunePlain.body)})`);
    const branchRoot = makeMember('BranchRoot');
    db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(branchRoot, pruneCoOwner);
    const branchPlain = await callRouter(admin, 'POST', `/api/local/admin/branches/${branchRoot}/prune`, { actor: keyAdmin });
    assert(branchPlain.status === 403 && statusOf(branchRoot) === 'active' && statusOf(pruneCoOwner) === 'active',
        `nor a branch holding one — and nobody in it is pruned (got ${branchPlain.status})`);
    const heldAdmin = makeMember('HeldAdmin');
    grantNodeRole(heldAdmin, 'admin', owner);
    await callRouter(admin, 'POST', `/api/local/admin/users/${heldAdmin}/suspend`, { actor: owner, body: { reason: 'Suspended admin, role held aside' } });
    const pruneHeldPlain = await callRouter(admin, 'POST', `/api/local/admin/users/${heldAdmin}/prune`, { actor: keyAdmin });
    assert(pruneHeldPlain.status === 403 && statusOf(heldAdmin) === 'disabled', 'nor a suspended admin whose role is held aside');
    const pruneRoleless = makeMember('PruneRoleless');
    const prunePlainMember = await callRouter(admin, 'POST', `/api/local/admin/users/${pruneRoleless}/prune`, { actor: keyAdmin });
    assert(prunePlainMember.status === 200 && statusOf(pruneRoleless) === 'pruned', 'a plain admin may still prune a member with no role');
    const pruneByOwner = await callRouter(admin, 'POST', `/api/local/admin/users/${pruneCoOwner}/prune`, { actor: owner });
    assert(pruneByOwner.status === 200 && statusOf(pruneCoOwner) === 'pruned' && !roleRow(pruneCoOwner), 'an owner may prune a co-owner');
    const pruneHeldOwner = await callRouter(admin, 'POST', `/api/local/admin/users/${heldAdmin}/prune`, { actor: owner });
    assert(pruneHeldOwner.status === 200 && statusOf(heldAdmin) === 'pruned'
        && !(db.prepare('SELECT 1 FROM suspended_node_roles WHERE member_pubkey = ?').get(heldAdmin)),
        'an owner may prune the suspended admin, and the held role goes with them');

    // The only owner cannot be suspended.
    db.prepare("DELETE FROM node_roles WHERE member_pubkey = ? AND role = 'owner'").run(secondOwner);
    const soleOwner = await callRouter(admin, 'POST', `/api/local/admin/users/${owner}/suspend`, { body: { reason: 'Trying to suspend the only owner' } });
    assert(soleOwner.status === 400 && statusOf(owner) === 'active', "the node's only owner cannot be suspended");

    // ── I. What members are served ────────────────────────────────────────
    console.log('\n--- I. No timing side channel, no admin keys ---');
    const exactAt = '2026-09-18T13:47:12.345Z';
    const timed = makeMember('Timed', { lastActiveAt: exactAt });
    const dayOnly = '2026-09-18T00:00:00.000Z';
    const trustByOther = await callRouter(community, 'POST', '/api/trust/profile', { actor: voters[0], body: { targetPubkey: timed } });
    assert(trustByOther.status === 200 && trustByOther.body.lastActiveAt === dayOnly,
        `another member sees the UTC day only (got ${trustByOther.body.lastActiveAt})`);
    const trustBySelf = await callRouter(community, 'POST', '/api/trust/profile', { actor: timed, body: { targetPubkey: timed } });
    assert(trustBySelf.body.lastActiveAt === exactAt, `the member sees their own exact time (got ${trustBySelf.body.lastActiveAt})`);
    const directory = await callRouter(community, 'GET', '/api/community/members');
    const dirRow = (JSON.parse(directory.body) as any[]).find(m => m.publicKey === timed);
    assert(dirRow?.lastActiveAt === dayOnly, `the member directory serves the day only (got ${dirRow?.lastActiveAt})`);
    assert(!String(directory.body).includes(exactAt), 'the exact time appears nowhere in the directory');
    const adminData = await callRouter(admin, 'POST', '/api/local/admin/data');
    const adminRow = adminData.body.members.find((m: any) => m.publicKey === timed);
    assert(adminRow?.lastActiveAt === dayOnly, `the admin member list serves the day only too (got ${adminRow?.lastActiveAt})`);

    const suspendedCard = byKey.body.decision;
    const memberList = await callRouter(commons, 'GET', '/api/commons/decisions', { actor: voters[0] });
    const memberCard = memberList.body.decisions.find((d: any) => d.id === suspendedCard.id);
    assert(memberCard && !('suspendedBy' in (memberCard.params || {})) && memberCard.params.reason === 'Signed admin session suspension',
        'members see the reason on the keep-suspension card, not which admin key suspended');
    const listJson2 = JSON.stringify(memberList.body);
    assert(!listJson2.includes(keyAdmin) && !listJson2.includes('owner:password'), 'no admin key anywhere in the member list');
    const haltedCard = memberList.body.decisions.find((d: any) => d.id === halt.id);
    assert(haltedCard && !('adminHaltedBy' in haltedCard) && haltedCard.adminHaltReason === 'Suspended the wrong account by mistake',
        'a halted card carries the public reason, not the halting admin');
    const memberDetail = await callRouter(commons, 'GET', `/api/commons/decisions/${suspendedCard.id}`, { actor: voters[0] });
    assert(memberDetail.status === 200 && !JSON.stringify(memberDetail.body).includes(keyAdmin), 'nor in the detail response');
    const adminDecisions = await callRouter(admin, 'POST', '/api/local/admin/decisions');
    const adminCard = adminDecisions.body.decisions.find((d: any) => d.id === suspendedCard.id);
    assert(adminCard?.params?.suspendedBy === keyAdmin, 'the admin Decisions list still says who suspended');
    const heard: any[] = [];
    const listener = { send: (m: string) => heard.push(JSON.parse(m)), readyState: 1 };
    addWsClient(listener);
    const wsTarget = makeMember('WsTarget');
    const wsSuspend = await callRouter(admin, 'POST', `/api/local/admin/users/${wsTarget}/suspend`, { actor: keyAdmin, body: { reason: 'Broadcast carries no admin key' } });
    await callRouter(admin, 'POST', `/api/local/admin/decisions/${wsSuspend.body.decision.id}/halt`, { actor: keyAdmin, body: { reason: 'Checking the halt broadcast too' } });
    removeWsClient(listener);
    assert(heard.some(e => e.type === 'decision_created') && heard.some(e => e.type === 'decision_halted'), 'the created and halted events went out');
    assert(!JSON.stringify(heard).includes(keyAdmin), `no broadcast carries the admin key (got ${heard.map(e => e.type).join(',')})`);

    // ── J/K. joined_at and last activity survive a backup restore ─────────
    console.log('\n--- J/K. Backup restore keeps joined_at ---');
    const restored = makeMember('RestoreMe', { joinedAt: '2026-01-02T03:04:05.678Z', lastActiveAt: new Date(Date.now() - DAY).toISOString() });
    completedTrade(restored, voters[0], 3, new Date(Date.now() - DAY));
    const { startP2P } = await import('./p2p.js');
    const { addConnector } = await import('./connector-manager.js');
    const p2pNode = await startP2P(4038, 4039);
    try {
        const nodeId = p2pNode.peerId.toString();
        const snapshot = await exportSyncState(nodeId);
        // Lose the member row, as a fresh replica would not have it, then restore from the snapshot.
        db.prepare('DELETE FROM members WHERE public_key = ?').run(restored);
        db.prepare('DELETE FROM accounts WHERE public_key = ?').run(restored);
        addConnector(`/ip4/127.0.0.1/tcp/4039/p2p/${nodeId}`, 'mirror', 'voting-answers-self');
        setNodeRole('backup');
        await importRemoteState(snapshot);
        const back = db.prepare('SELECT joined_at, last_active_at FROM members WHERE public_key = ?').get(restored) as any;
        assert(back?.joined_at === '2026-01-02T03:04:05.678Z', `a restored member keeps their joined_at (got ${back?.joined_at})`);
        assert(!!back?.last_active_at, 'and their last activity');
        // The update path (a newer copy of an existing row) never rewrites joined_at: change it locally, make the
        // local row older than the snapshot's, re-import — the snapshot's joinedAt does not overwrite it.
        db.prepare("UPDATE members SET joined_at = '2025-05-05T05:05:05.000Z', updated_at = '2000-01-01T00:00:00.000Z' WHERE public_key = ?").run(restored);
        await importRemoteState(snapshot);
        const afterUpdate = db.prepare('SELECT joined_at FROM members WHERE public_key = ?').get(restored) as any;
        assert(afterUpdate?.joined_at === '2025-05-05T05:05:05.000Z', `the update path never rewrites joined_at (got ${afterUpdate?.joined_at})`);
        db.prepare("UPDATE members SET joined_at = '2026-01-02T03:04:05.678Z' WHERE public_key = ?").run(restored);
        const restoredDecision = createDecision({ authorPubkey: voters[0], title: 'Freeze after restore', description: 'Restored member votes', touches: 'member', effect: 'freeze_credit', subject: troll2 });
        assert(castDecisionVote(restoredDecision.id, restored, true).success, 'the restored member can vote (joined before it opened)');
    } finally {
        setNodeRole('primary');
        await p2pNode.stop();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ Voting answers hold.');
}

run().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
