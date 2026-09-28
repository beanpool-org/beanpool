/**
 * Integration & unit tests for `routes/standby-ledger-gate.ts`.
 *
 * Verifies:
 * 1. standbyRefuses function correctly identifies write routes that affect ledger/trades/members on a standby.
 * 2. standbyRefuses permits safe HTTP methods (GET, HEAD, OPTIONS) and non-ledger write routes.
 * 3. standbyLedgerGate Koa middleware returns HTTP 409 { error, code: 'standby' } when node role is 'backup' for protected routes.
 * 4. standbyLedgerGate passes through (calls next()) when node role is 'primary' or for un-gated routes.
 */
import assert from 'node:assert';
import type { Context } from 'koa';
import { standbyRefuses, standbyLedgerGate } from './routes/standby-ledger-gate.js';
import { setNodeRole, STANDBY_CODE, STANDBY_LEDGER_MESSAGE } from './config/node-role.js';

console.log('Running standby-ledger-gate tests...');

// 1. standbyRefuses - Safe methods vs Write methods
assert.strictEqual(standbyRefuses('/api/ledger/transfer', 'GET'), false, 'GET is never refused');
assert.strictEqual(standbyRefuses('/api/ledger/transfer', 'HEAD'), false, 'HEAD is never refused');
assert.strictEqual(standbyRefuses('/api/ledger/transfer', 'OPTIONS'), false, 'OPTIONS is never refused');

// 2. standbyRefuses - Protected routes (POST/DELETE/PUT)
const protectedPaths = [
    '/api/ledger/transfer',
    '/api/marketplace/posts/accept',
    '/api/marketplace/posts/request',
    '/api/marketplace/transactions/approve',
    '/api/marketplace/transactions/reject',
    '/api/marketplace/transactions/cancel-request',
    '/api/marketplace/transactions/complete',
    '/api/marketplace/transactions/cancel',
    '/api/treasury/corp1/approve',
    '/api/enterprise/corp1/complete',
    '/api/treasury/corp1/sweep',
    '/api/treasury/corp1/pledge',
    '/api/treasury/corp1/wind-up/finalise',
    '/api/enterprise/corp1/backing',
    '/api/enterprise/corp1/release',
    '/api/enterprise/corp1/pledge/release',
    '/api/crowdfund/projects/delete',
    '/api/crowdfund/projects/p1/pledge',
    '/api/commons/decisions',
    '/api/commons/decisions/123/vote',
    '/api/local/admin/decisions/123/halt',
    '/api/local/admin/decisions/123/accelerate',
    '/api/member/purge',
    '/api/member/re-enroll',
    '/api/local/admin/members/m1/offboard',
    '/api/local/admin/members/m1/rekey/complete',
    '/api/local/admin/users/u1/prune',
    '/api/local/admin/posts/p1/delete',
    '/api/local/admin/posts/bulk-delete',
    '/api/local/admin/reports/r1/action',
    '/api/local/admin/disputes/d1/resolve',
    '/api/federation/purchase',
    '/api/federation/commission',
];

for (const p of protectedPaths) {
    assert.strictEqual(standbyRefuses(p, 'POST'), true, `POST ${p} should be refused on standby`);
    assert.strictEqual(standbyRefuses(p, 'DELETE'), true, `DELETE ${p} should be refused on standby`);
}

console.log('  1 & 2. standbyRefuses route matching verified');

// 3. standbyRefuses - Unprotected write routes (writes with no Bean move)
const allowedWritePaths = [
    '/api/marketplace/posts',
    '/api/profile',
    '/api/settings',
    '/api/knocks',
    '/api/notices',
];

for (const p of allowedWritePaths) {
    assert.strictEqual(standbyRefuses(p, 'POST'), false, `POST ${p} should NOT be refused on standby`);
}

console.log('  3. Unprotected write routes verified');

// Helper to mock Koa Context
function createMockContext(path: string, method: string): Context {
    return {
        path,
        method,
        status: 200,
        body: undefined,
    } as unknown as Context;
}

// 4. Middleware logic when Node Role is 'primary'
setNodeRole('primary');

let nextCalled = false;
const mockNext = async () => { nextCalled = true; };

const ctxPrimary = createMockContext('/api/ledger/transfer', 'POST');
await standbyLedgerGate(ctxPrimary, mockNext);

assert.strictEqual(nextCalled, true, 'Middleware must call next() when node role is primary');
assert.strictEqual(ctxPrimary.status, 200, 'Status must remain 200 on primary');

console.log('  4. standbyLedgerGate on primary node verified');

// 5. Middleware logic when Node Role is 'backup' (standby)
setNodeRole('backup');

// Case A: Protected path -> 409 standby
nextCalled = false;
const ctxBackupProtected = createMockContext('/api/ledger/transfer', 'POST');
await standbyLedgerGate(ctxBackupProtected, mockNext);

assert.strictEqual(nextCalled, false, 'Middleware must NOT call next() for protected write on backup');
assert.strictEqual(ctxBackupProtected.status, 409, 'Status must be set to 409');
assert.deepStrictEqual(
    ctxBackupProtected.body,
    { error: STANDBY_LEDGER_MESSAGE, code: STANDBY_CODE },
    'Body must return STANDBY error code and message'
);

// Case B: Safe path or GET -> next()
nextCalled = false;
const ctxBackupGet = createMockContext('/api/ledger/transfer', 'GET');
await standbyLedgerGate(ctxBackupGet, mockNext);

assert.strictEqual(nextCalled, true, 'Middleware must call next() for GET request on backup');
assert.strictEqual(ctxBackupGet.status, 200, 'Status must remain 200 for GET on backup');

console.log('  5. standbyLedgerGate on backup node verified');

console.log('✅ standby-ledger-gate tests PASSED!');
process.exit(0);
