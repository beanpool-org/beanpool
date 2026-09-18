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
    const ownerSuspend = await callRouter(admin, 'POST', `/api/local/admin/users/${secondOwner}/suspend`, { body: { reason: 'Trying to lock out the other owner' } });
    assert(ownerSuspend.status === 200, 'with two owners, one owner can be suspended (and the vote decides)');
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

    // Voted down → it lifts.
    const downVote = (await callRouter(admin, 'POST', `/api/local/admin/users/${troll}/suspend`, { body: { reason: 'Second incident, same person' } })).body.decision;
    for (const v of voters.slice(0, 3)) castDecisionVote(downVote.id, v, false);
    castDecisionVote(downVote.id, voters[3], true);
    closeForTick(downVote.id);
    tickDecisions();
    assert(getDecision(downVote.id)!.status === 'failed' && statusOf(troll) === 'active', 'voted down (25% yes) lifts the suspension');

    // Kept → stays suspended.
    const keptVote = (await callRouter(admin, 'POST', `/api/local/admin/users/${troll}/suspend`, { body: { reason: 'Third incident, same person' } })).body.decision;
    for (const v of voters.slice(0, 4)) castDecisionVote(keptVote.id, v, true);
    closeForTick(keptVote.id);
    tickDecisions();
    assert(getDecision(keptVote.id)!.status === 'executed' && statusOf(troll) === 'disabled', 'kept by 60%+ → the suspension stays');

    // The admin halt from the settings app: password auth, written reason required; halting the vote lifts it.
    const halt = second.body.decision;
    const haltNoReason = await callRouter(admin, 'POST', `/api/local/admin/decisions/${halt.id}/halt`, { body: { reason: 'short' } });
    assert(haltNoReason.status === 400 && getDecision(halt.id)!.status === 'open', 'halting needs a written reason (10+ characters)');
    const halted = await callRouter(admin, 'POST', `/api/local/admin/decisions/${halt.id}/halt`, { body: { reason: 'Suspended the wrong account by mistake' } });
    assert(halted.status === 200, `a password-authenticated admin (the settings app) can halt (got ${halted.status} ${JSON.stringify(halted.body)})`);
    const haltedRow = getDecision(halt.id)!;
    assert(haltedRow.status === 'admin_halted' && haltedRow.adminHaltReason === 'Suspended the wrong account by mistake', 'halted with the public reason');
    assert(statusOf(troll2) === 'active', 'halting the ratifying vote lifts the suspension');

    // An admin lifting by hand closes the open vote.
    const ownerKeep = ownerSuspend.body.decision;
    const lifted = await callRouter(admin, 'POST', `/api/local/admin/users/${secondOwner}/status`, { body: { status: 'active' } });
    assert(lifted.status === 200 && statusOf(secondOwner) === 'active', 'an admin can lift a suspension');
    assert(getDecision(ownerKeep.id)!.status === 'admin_halted', 'and the open "Keep?" vote closes with it');

    // Key session admin: attributed to their key.
    const keyAdmin = voters[2];
    grantNodeRole(keyAdmin, 'admin', owner);
    const byKey = await callRouter(admin, 'POST', `/api/local/admin/users/${voters[1]}/suspend`, { actor: keyAdmin, body: { reason: 'Signed admin session suspension' } });
    assert(byKey.status === 200 && byKey.body.decision.params.suspendedBy === keyAdmin, 'a signed admin session is attributed to its key');

    // The only owner cannot be suspended.
    db.prepare("DELETE FROM node_roles WHERE member_pubkey = ? AND role = 'owner'").run(secondOwner);
    const soleOwner = await callRouter(admin, 'POST', `/api/local/admin/users/${owner}/suspend`, { body: { reason: 'Trying to suspend the only owner' } });
    assert(soleOwner.status === 400 && statusOf(owner) === 'active', "the node's only owner cannot be suspended");

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
