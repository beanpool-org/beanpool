/**
 * Regression test for Issue #172: Moderation Admin Portal & UGC Abuse Report Management.
 *
 * Verifies:
 * A. submitting abuse reports creates pending reports
 * B. getReports() returns reports with status filtering ('pending', 'reviewed', 'actioned', 'all')
 * C. getReports() pagination (limit clamping, offset, total count, pendingCount)
 * D. dismissReport() marks report as 'reviewed'
 * E. actionReport() marks report as 'actioned', deletes target post, and suspends target user
 * F. dismissReport() & actionReport() return false for non-existent report IDs
 * H. child-safety reports are marked and listed first
 * I. "All": only OPEN child-safety reports go first; a handled one takes its date's place (director, 14 Oct, review of #1912)
 * J. the AI assistant's reports_list says which reports are child safety, in the order its description promises (finding 5)
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import { initStateEngine, submitReport, getReports, dismissReport, actionReport, createPost, getPosts, getMember, adminDeletePost } from './state-engine.js';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';

console.log('Running #172 moderation admin portal test...');

initStateEngine();

// Generate valid Ed25519 raw 32-byte public key hexes
function generateTestKeyHex(): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return der.subarray(-32).toString('hex');
}

const reporterKey = generateTestKeyHex();
const offenderKey = generateTestKeyHex();

function createTestMember(pubKey: string, callsign: string) {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pubKey, callsign);
    setMemberPhoto(db, pubKey, 'https://example.com/avatar.jpg');
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 100, 0)`).run(pubKey);
    ledger.initializeGenesisAccount(pubKey);
}

createTestMember(reporterKey, 'reporter_callsign');
createTestMember(offenderKey, 'offender_callsign');

const reporter = getMember(reporterKey);
const offender = getMember(offenderKey);
assert.ok(reporter && offender, 'Setup: test members must be created');

const offensivePost = createPost(
    'offer',
    'other',
    'Offensive Post Title',
    'Offensive content description',
    10,
    'fixed',
    offenderKey
);
assert.ok(offensivePost, 'Setup: offensive post must be created');

// A. Submit abuse reports
const r1 = submitReport(reporterKey, offenderKey, 'Spam content');
const r2 = submitReport(reporterKey, offenderKey, 'Harassment and abusive language', offensivePost.id);
assert.ok(r1 && r2, 'A. Abuse reports must be submitted successfully');
assert.strictEqual(r1.status, 'pending', 'A. New report status must default to pending');
console.log('  A. Abuse reports submitted successfully');

// B. Status filtering in getReports()
const pendingReports = getReports('pending');
assert.ok(pendingReports.reports.length >= 2, 'B. Pending filter must return created pending reports');
assert.strictEqual(pendingReports.pendingCount >= 2, true, 'B. pendingCount must be at least 2');

const reviewedBefore = getReports('reviewed');
assert.strictEqual(reviewedBefore.reports.length, 0, 'B. Reviewed filter should return 0 before dismissals');
console.log('  B. Status filtering correctly isolates pending reports');

// C. Pagination & limit clamping
const paginated = getReports('all', 1, 0);
assert.strictEqual(paginated.reports.length, 1, 'C. Limit 1 must return exactly 1 item');
assert.ok(paginated.total >= 2, 'C. Total count must reflect all matching items');
console.log('  C. Pagination & limit clamping operating as expected');

// D. Dismiss report
const dismissResult = dismissReport(r1.id);
assert.strictEqual(dismissResult, true, 'D. dismissReport must return true for valid report');

const reviewedAfter = getReports('reviewed');
assert.strictEqual(reviewedAfter.reports.length, 1, 'D. Reviewed filter must return 1 item after dismissal');
assert.strictEqual(reviewedAfter.reports[0].id, r1.id, 'D. Dismissed report ID must match');
console.log('  D. dismissReport correctly transitions status to reviewed');

// E. Action report (delete post & suspend user)
const postBeforeAction = getPosts({ includeInactive: true }).find(p => p.id === offensivePost.id);
assert.ok(postBeforeAction && Boolean(postBeforeAction.active) === true, 'E. Post must be active before actioning report');

const actionResult = actionReport(r2.id, true, true);
assert.strictEqual(actionResult, true, 'E. actionReport must return true');

const postAfterAction = getPosts({ includeInactive: true }).find(p => p.id === offensivePost.id);
assert.strictEqual(Boolean(postAfterAction?.active), false, 'E. Actioning report with deletePost=true must soft-delete post');

const offenderMember = getMember(offenderKey);
assert.strictEqual(offenderMember?.status, 'suspended', 'E. Actioning report with suspendUser=true must suspend offender');

// G. Verify assertMemberActive rejects suspended member
import { assertMemberActive } from './state-engine.js';
import { setMemberPhoto } from '@beanpool/engine';
assert.throws(
    () => assertMemberActive(offenderKey),
    /Account is suspended or disabled/,
    'G. assertMemberActive must throw error for suspended members'
);
console.log('  G. assertMemberActive correctly rejects suspended members');

const actionedReports = getReports('actioned');
assert.strictEqual(actionedReports.reports.length, 1, 'E. Actioned filter must return 1 item');
assert.strictEqual(actionedReports.reports[0].id, r2.id, 'E. Actioned report ID must match');
console.log('  E. actionReport correctly deletes post, suspends user, and sets status to actioned');

// F. Non-existent report and post deletion handling
const dismissFake = dismissReport('non-existent-id-999');
assert.strictEqual(dismissFake, false, 'F. dismissReport must return false for fake ID');

const actionFake = actionReport('non-existent-id-999', true, true);
assert.strictEqual(actionFake, false, 'F. actionReport must return false for fake ID');

const deleteFakePost = adminDeletePost('non-existent-post-id-999');
assert.strictEqual(deleteFakePost, false, 'F. adminDeletePost must return false for non-existent post ID');
console.log('  F. Non-existent report and post IDs handled cleanly without errors');

// H. Child-safety reports are marked and listed first (the follow-up to #1895: the alert says "look at it first, in the
// Manager's Reports queue"), read as the alerts read them: picked, or written in on an older app. Newer reports of any
// other kind still come after them, and a page of the queue holds them first.
{
    const ids: Record<string, string> = {};
    const file = (name: string, reason: string) => {
        const who = generateTestKeyHex();
        createTestMember(who, `g_${name}`);
        const r = submitReport(who, offenderKey, reason);
        assert.ok(r, `H. ${name} filed`);
        ids[name] = r!.id;
        // One millisecond apart at least, so "newest first" is a real order.
        db.prepare('UPDATE abuse_reports SET created_at = ? WHERE id = ?').run(new Date(Date.now() + Object.keys(ids).length).toISOString(), r!.id);
    };
    file('picked', 'Child safety');
    file('writtenIn', 'Other: he is grooming an underage kid');
    file('spamAfter', 'Spam or scam: fake gates');
    file('pickedWords', 'Child safety: messages to my daughter');
    file('otherLast', 'Other');

    const all = getReports('pending').reports;
    const order = all.map((r) => r.id);
    const childIds = [ids.pickedWords, ids.writtenIn, ids.picked];
    assert.deepStrictEqual(order.slice(0, 3), childIds, `H. child-safety reports come first, newest first among them (got ${JSON.stringify(all.slice(0, 5).map((r) => r.reason))})`);
    assert.ok(order.indexOf(ids.otherLast) < order.indexOf(ids.spamAfter), 'H. the rest stay newest first');
    for (const r of all) assert.strictEqual(r.childSafety, childIds.includes(r.id), `H. "${r.reason}" is marked ${childIds.includes(r.id)}`);
    assert.strictEqual(all.find((r) => r.id === ids.picked)!.reason, 'Child safety', 'H. the reason itself is shown as before');
    assert.deepStrictEqual(getReports('pending', 2, 0).reports.map((r) => r.id), childIds.slice(0, 2), 'H. the first page of the queue holds them');
    assert.deepStrictEqual(getReports('all', 1, 0).reports.map((r) => r.id), [ids.pickedWords], 'H. and so does "all"');
    console.log('  H. Child-safety reports are marked and listed first, on every page');

    // I. Two of them handled (the two oldest, as a moderator clears a false positive): the Open tab is as before, and in
    // "All" they take their date's place below the open ordinary reports filed after them, still marked.
    assert.ok(dismissReport(ids.picked) && dismissReport(ids.writtenIn), 'I. two child-safety reports dismissed');
    const open = getReports('pending').reports.map((r) => r.id);
    assert.deepStrictEqual(open, [ids.pickedWords, ids.otherLast, ids.spamAfter], `I. the Open tab: the open child-safety report first, then newest first (got ${JSON.stringify(open)})`);
    const everyOne = getReports('all').reports;
    const allIds = everyOne.map((r) => r.id);
    assert.deepStrictEqual(allIds.slice(0, 5), [ids.pickedWords, ids.otherLast, ids.spamAfter, ids.writtenIn, ids.picked],
        `I. "All": the open child-safety report, then by date; a dismissed one is not above the open ordinary ones (got ${JSON.stringify(everyOne.slice(0, 5).map((r) => `${r.outcome}:${r.reason}`))})`);
    for (const id of [ids.picked, ids.writtenIn]) assert.strictEqual(everyOne.find((r) => r.id === id)!.childSafety, true, 'I. a handled child-safety report is still marked');
    assert.deepStrictEqual(getReports('all', 2, 0).reports.map((r) => r.id), [ids.pickedWords, ids.otherLast], 'I. and a page of "All" holds the same order');
    assert.deepStrictEqual(getReports('all', 2, 3).reports.map((r) => r.id), [ids.writtenIn, ids.picked], 'I. the next page carries on in date order');
    const dismissedTab = getReports('reviewed').reports.map((r) => r.id);
    assert.deepStrictEqual(dismissedTab.slice(0, 2), [ids.writtenIn, ids.picked], 'I. the Dismissed tab is in date order');
    console.log('  I. "All" lists only open child-safety reports first; handled ones take their date\'s place, still marked');

    // J. The assistant's reports_list: a childSafety field on every report, and the order its description promises.
    const { AGENT_TOOLS } = await import('./agent/tools.js');
    const list = AGENT_TOOLS.find((t) => t.name === 'reports_list')!;
    assert.match(list.reads, /open child-safety reports first, then newest first/, 'J. the description says the order');
    assert.doesNotMatch(list.reads, /or all, newest first/, 'J. and no longer says newest first alone');
    const promised = (rows: Array<{ id: string; at: string; status: string; childSafety: unknown }>, label: string) => {
        const lead = (r: { status: string; childSafety: unknown }) => r.status === 'open' && r.childSafety === true;
        const k = rows.findIndex((r) => !lead(r));
        const head = k < 0 ? rows : rows.slice(0, k), rest = k < 0 ? [] : rows.slice(k);
        assert.ok(rest.every((r) => !lead(r)), `J. ${label}: open child-safety reports all come first`);
        for (const part of [head, rest]) for (let i = 1; i < part.length; i++) assert.ok(part[i - 1].at >= part[i].at, `J. ${label}: newest first after that`);
        return head.map((r) => r.id);
    };
    for (const status of ['open', 'all'] as const) {
        const res: any = list.run({ role: 'owner' } as any, { status }, 'bnd');
        const rows = res.result.reports as Array<{ id: string; at: string; status: string; childSafety: unknown }>;
        assert.ok(rows.length > 0 && rows.every((r) => typeof r.childSafety === 'boolean'), `J. ${status}: every report says whether it is child safety`);
        for (const r of rows) assert.strictEqual(r.childSafety, getReports('all').reports.find((x) => x.id === r.id)!.childSafety, `J. ${status}: ${r.id} flagged as the queue flags it`);
        assert.deepStrictEqual(promised(rows, status), [ids.pickedWords], `J. ${status}: the open child-safety report leads`);
        assert.deepStrictEqual(rows.map((r) => r.id), getReports(status === 'all' ? 'all' : 'pending').reports.map((r) => r.id), `J. ${status}: the queue's order`);
    }
    const one: any = AGENT_TOOLS.find((t) => t.name === 'report_get')!.run({ role: 'owner' } as any, { report_id: ids.picked }, 'bnd');
    assert.strictEqual(one.result.report.childSafety, true, 'J. report_get says it too');
    console.log('  J. The assistant reads which reports are child safety, in the order it is told');
}

console.log('✅ #172 moderation admin portal test PASSED!');

// Exit explicitly. This suite leaves the engine's timers and handles open, so returning normally
// keeps the event loop alive and the process never terminates — it prints a pass and then hangs.
// In CI that is indistinguishable from a slow run and blocks every suite after it (scripts/test-all.sh
// runs them in sequence), which is how a single test burns hours of Actions time. Reaching here means
// every assertion above held; a failure throws and exits non-zero long before this line.
process.exit(0);
