/**
 * Test Suite: abuse report duplicates, the per-reporter limit, and status replication.
 *
 * Verifies:
 * 1. Reporting the same member, post or Pulse item again while the first report is pending
 *    succeeds and returns the original report without writing a new row.
 * 2. A different target (another post, the member rather than their post) is a new report.
 * 3. Once a report is no longer pending, reporting the same target again files a new one.
 * 4. A reporter past REPORTS_PER_REPORTER_PER_HOUR gets 429 and no row; a duplicate still succeeds.
 *    Reports older than an hour do not count.
 * 5. dismissReport and actionReport bump updated_at, so a delta sync export (which selects on
 *    updated_at) carries the new status to replicas.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-report-dedup-and-sync.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import * as stateEngine from './state-engine.js';
import { initStateEngine, exportSyncState, dismissReport, actionReport, submitReport } from './state-engine.js';
import { createCommunityRoutes } from './routes/community.js';

// Read through the namespace so this file still loads against a tree without the limit.
const REPORTS_PER_REPORTER_PER_HOUR: number = (stateEngine as any).REPORTS_PER_REPORTER_PER_HOUR ?? 10;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

async function callRouter(router: any, method: string, path: string, actor: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const layer = router.stack.find((l: any) => (l.path === path || l.regexp.test(path)) && l.methods.includes(method));
    if (!layer) throw new Error(`${method} ${path} is not mounted in router`);
    const ctx: any = {
        headers: {}, get: () => undefined, request: { headers: {}, body }, requestBody: body,
        query: {}, params: {}, state: { actor }, status: 200, body: undefined,
    };
    await layer.stack[layer.stack.length - 1](ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

function makeMember(callsign: string): string {
    const pubkey = crypto.randomBytes(32).toString('hex');
    db.prepare(
        `INSERT INTO members (public_key, callsign, status, joined_at, updated_at)
         VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pubkey, callsign);
    return pubkey;
}

function rowsBy(reporter: string): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM abuse_reports WHERE reporter_pubkey = ?').get(reporter) as { c: number }).c;
}

async function main(): Promise<void> {
    console.log('=== Report Dedup, Rate Limit & Sync Tests ===\n');
    initStateEngine();

    const deps: any = {
        checkAdminAuth: async () => true,
        rateLimit: () => true,
        clampLimit: (_v: unknown, def = 20) => def,
        clampOffset: () => 0,
        enforceReadAuth: false,
    };
    const community = createCommunityRoutes(deps);
    const report = (actor: string, body: Record<string, unknown>) => callRouter(community, 'POST', '/api/reports', actor, body);

    const target = makeMember('Target');

    // ── 1–3. Duplicates ─────────────────────────────────────────────────────────
    console.log('--- 1. Duplicate while pending ---');
    const dupReporter = makeMember('DupReporter');
    const first = await report(dupReporter, { targetPubkey: target, reason: 'spam', targetPostId: 'post_a' });
    assert(first.status === 200 && first.body?.success === true, 'First report on a post succeeds');
    const again = await report(dupReporter, { targetPubkey: target, reason: 'still spam', targetPostId: 'post_a' });
    assert(again.status === 200 && again.body?.success === true, 'Reporting the same post again succeeds');
    assert(again.body?.report?.id === first.body?.report?.id, 'The repeat returns the original report');
    assert(rowsBy(dupReporter) === 1, 'The repeat writes no new row');

    const direct = submitReport(dupReporter, target, 'third time', 'post_a');
    assert(direct?.id === first.body?.report?.id && rowsBy(dupReporter) === 1, 'submitReport itself also collapses the duplicate');

    console.log('\n--- 2. Different targets are separate reports ---');
    await report(dupReporter, { targetPubkey: target, reason: 'another', targetPostId: 'post_b' });
    await report(dupReporter, { targetPubkey: target, reason: 'the member' });
    assert(rowsBy(dupReporter) === 3, 'Another post and the member themself each get a row');
    const memberAgain = await report(dupReporter, { targetPubkey: target, reason: 'the member again' });
    assert(memberAgain.status === 200 && rowsBy(dupReporter) === 3, 'A repeat member report (no post) is collapsed too');

    console.log('\n--- 3. After review, a new report is filed ---');
    assert(dismissReport(first.body.report.id), 'Dismiss the first report');
    const afterReview = await report(dupReporter, { targetPubkey: target, reason: 'back again', targetPostId: 'post_a' });
    assert(afterReview.status === 200 && afterReview.body?.report?.id !== first.body.report.id, 'Reporting after review is a new report');
    assert(rowsBy(dupReporter) === 4, 'It writes a new row');

    // ── 4. Rate limit ───────────────────────────────────────────────────────────
    console.log('\n--- 4. Per-reporter limit ---');
    const busy = makeMember('BusyReporter');
    // An old report outside the window does not count toward the limit.
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), busy, target, 'post_old', 'old', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
    let allOk = true;
    for (let i = 0; i < REPORTS_PER_REPORTER_PER_HOUR; i++) {
        const r = await report(busy, { targetPubkey: target, reason: `r${i}`, targetPostId: `post_${i}` });
        if (r.status !== 200) allOk = false;
    }
    assert(allOk, `${REPORTS_PER_REPORTER_PER_HOUR} reports within the hour all succeed (an older one does not count)`);
    const over = await report(busy, { targetPubkey: target, reason: 'one too many', targetPostId: 'post_over' });
    assert(over.status === 429 && over.body?.error === 'rate_limited', `Report ${REPORTS_PER_REPORTER_PER_HOUR + 1} is refused with 429`);
    assert(rowsBy(busy) === REPORTS_PER_REPORTER_PER_HOUR + 1, 'The refused report writes no row');
    const dupAtLimit = await report(busy, { targetPubkey: target, reason: 'repeat', targetPostId: 'post_0' });
    assert(dupAtLimit.status === 200 && dupAtLimit.body?.success === true, 'A duplicate at the limit still succeeds');
    const other = await report(makeMember('Other'), { targetPubkey: target, reason: 'mine', targetPostId: 'post_over' });
    assert(other.status === 200, 'The limit is per reporter');

    // ── 5. Status replicates ────────────────────────────────────────────────────
    console.log('\n--- 5. Status changes reach the delta export ---');
    const syncReporter = makeMember('SyncReporter');
    const toDismiss = submitReport(syncReporter, target, 'dismiss me', 'post_sync_1')!;
    const toAction = submitReport(syncReporter, target, 'action me', 'post_sync_2')!;
    const old = '2020-01-01T00:00:00.000Z';
    db.prepare('UPDATE abuse_reports SET created_at = ?, updated_at = ? WHERE id IN (?, ?)').run(old, old, toDismiss.id, toAction.id);
    const since = new Date(Date.now() - 1000).toISOString();

    assert(dismissReport(toDismiss.id), 'Dismiss succeeds');
    assert(actionReport(toAction.id), 'Action succeeds');
    const payload: any = await exportSyncState('test-node', since);
    const dismissed = payload?.abuseReports?.find((r: any) => r.id === toDismiss.id);
    const actioned = payload?.abuseReports?.find((r: any) => r.id === toAction.id);
    assert(dismissed?.status === 'reviewed', 'A dismissed report is in the delta export as reviewed');
    assert(actioned?.status === 'actioned', 'An actioned report is in the delta export as actioned');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
