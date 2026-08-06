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
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import { initStateEngine, submitReport, getReports, dismissReport, actionReport, createPost, getPosts, getMember } from './state-engine.js';
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
    db.prepare(`INSERT INTO members (public_key, callsign, avatar_url, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'https://example.com/avatar.jpg', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pubKey, callsign);
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

const actionedReports = getReports('actioned');
assert.strictEqual(actionedReports.reports.length, 1, 'E. Actioned filter must return 1 item');
assert.strictEqual(actionedReports.reports[0].id, r2.id, 'E. Actioned report ID must match');
console.log('  E. actionReport correctly deletes post, suspends user, and sets status to actioned');

// F. Non-existent report handling
const dismissFake = dismissReport('non-existent-id-999');
assert.strictEqual(dismissFake, false, 'F. dismissReport must return false for fake ID');

const actionFake = actionReport('non-existent-id-999', true, true);
assert.strictEqual(actionFake, false, 'F. actionReport must return false for fake ID');
console.log('  F. Non-existent report IDs handled cleanly without errors');

console.log('✅ #172 moderation admin portal test PASSED!');
