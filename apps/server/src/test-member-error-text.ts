/**
 * Unit and HTTP integration tests for routes/member-error-text.ts (FABLE-sec-errors MEDIUM-3, 2026-10-01):
 *
 *   1. looksLikeServerFault: detects database error codes, schema faults, JS engine exceptions, network codes,
 *      and embedded IPv4 addresses while keeping member-facing refusals intact.
 *   2. isServerFault: classifies thrown Error types (TypeError, SqliteError, SystemError, etc.), code/errno/syscall
 *      properties, non-Error values, and plain refusal Errors correctly.
 *   3. memberErrorText: passes refusal messages through while replacing server faults with general fallback text.
 *   4. scrubServerFaults middleware: over HTTP, replaces server fault details with SERVER_FAULT_TEXT and 500 on member
 *      routes while preserving detailed errors for operator routes (/api/local/ and /api/admin/).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-member-error-text.ts
 */
import http from 'node:http';
import Koa from 'koa';
import {
    looksLikeServerFault,
    isServerFault,
    memberErrorText,
    scrubServerFaults,
    SERVER_FAULT_TEXT,
} from './routes/member-error-text.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

async function testLooksLikeServerFault(): Promise<void> {
    console.log('\n— 1. looksLikeServerFault —');

    const faultSamples = [
        'SQLITE_CONSTRAINT: UNIQUE constraint failed',
        'SQLITE_BUSY: database is locked',
        'no such table: members',
        'no such column: callsign',
        'no such function: custom_fn',
        'datatype mismatch',
        'can only bind Blob, Buffer, ArrayBuffer',
        'parameter values must be numbers',
        'database disk image is malformed',
        'disk I/O error occurred',
        'Cannot read property "id" of undefined',
        'Cannot set property "name" of null',
        'Cannot destructure property "a" of "undefined"',
        'x is not a function',
        'y is not iterable',
        'z is not defined',
        'Unexpected token { in JSON at position 12',
        'Unexpected end of JSON input',
        'JSON at position 45',
        'Invalid time value',
        'Invalid array length',
        'Maximum call stack size exceeded',
        'connect ECONNREFUSED 127.0.0.1:443',
        'socket hang up',
        'fetch failed',
        'getaddrinfo ENOTFOUND api.beanpool.org',
        'EADDRINUSE: address already in use 0.0.0.0:8080',
        'Failed to connect to 10.0.0.5',
    ];

    for (const sample of faultSamples) {
        assert(looksLikeServerFault(sample), `recognizes server fault: "${sample}"`);
    }

    const refusalSamples = [
        'Group not found',
        'Only a convenor can do that',
        'Insufficient balance',
        'Invalid credentials',
        'You must be a member of this community to do that',
        'Post has expired',
        'Rate limit exceeded',
        'A signed request is required',
    ];

    for (const sample of refusalSamples) {
        assert(!looksLikeServerFault(sample), `keeps refusal intact: "${sample}"`);
    }
}

async function testIsServerFault(): Promise<void> {
    console.log('\n— 2. isServerFault —');

    // Non-Error thrown values are server faults
    assert(isServerFault(null), 'null is treated as a server fault');
    assert(isServerFault(undefined), 'undefined is treated as a server fault');
    assert(isServerFault('string error'), 'primitive string is treated as a server fault');
    assert(isServerFault(123), 'primitive number is treated as a server fault');
    assert(isServerFault({ message: 'plain object' }), 'plain object is treated as a server fault');

    // Specific Error subclasses in FAULT_NAMES
    assert(isServerFault(new TypeError('Cannot read properties of undefined')), 'TypeError is a server fault');
    assert(isServerFault(new RangeError('Invalid array length')), 'RangeError is a server fault');
    assert(isServerFault(new SyntaxError('Unexpected token')), 'SyntaxError is a server fault');
    assert(isServerFault(new ReferenceError('x is not defined')), 'ReferenceError is a server fault');

    class SqliteError extends Error {
        constructor(msg: string) {
            super(msg);
            this.name = 'SqliteError';
        }
    }
    assert(isServerFault(new SqliteError('table missing')), 'SqliteError is a server fault');

    // System and network error properties
    const sysErr = new Error('network failure');
    (sysErr as any).syscall = 'connect';
    (sysErr as any).errno = -111;
    assert(isServerFault(sysErr), 'Error with syscall/errno is a server fault');

    const codeErr = new Error('sqlite failure');
    (codeErr as any).code = 'SQLITE_CONSTRAINT';
    assert(isServerFault(codeErr), 'Error with SQLITE_ code is a server fault');

    // Plain refusal Errors are NOT server faults
    assert(!isServerFault(new Error('Group not found')), 'Error with plain refusal text is not a server fault');
    assert(!isServerFault(new Error('Only a convenor can do that')), 'Error with convenor refusal is not a server fault');
}

async function testMemberErrorText(): Promise<void> {
    console.log('\n— 3. memberErrorText —');

    const refusalErr = new Error('Only a convenor can do that');
    assert(memberErrorText(refusalErr, 'Failed to perform action') === 'Only a convenor can do that',
        'preserves refusal error message');

    const faultErr = new TypeError('Cannot read property "id" of undefined');
    assert(memberErrorText(faultErr, 'Failed to update group') === 'Failed to update group',
        'replaces JS TypeError with fallback text');

    const sqliteErr = new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: members.slug');
    (sqliteErr as any).code = 'SQLITE_CONSTRAINT';
    assert(memberErrorText(sqliteErr, 'Failed to register member') === 'Failed to register member',
        'replaces SQLite error with fallback text');

    assert(memberErrorText(null, 'Fallback message') === 'Fallback message',
        'returns fallback message for non-Error thrown value');
}

async function testScrubServerFaultsMiddleware(): Promise<void> {
    console.log('\n— 4. scrubServerFaults HTTP middleware —');

    const app = new Koa();
    app.use(scrubServerFaults());

    app.use(async (ctx) => {
        if (ctx.path === '/api/groups/success') {
            ctx.status = 200;
            ctx.body = { ok: true, message: 'Group created successfully' };
            return;
        }
        if (ctx.path === '/api/groups/refusal') {
            ctx.status = 400;
            ctx.body = { error: 'Group not found' };
            return;
        }
        if (ctx.path === '/api/groups/db-fault') {
            ctx.status = 400;
            ctx.body = { error: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: groups.slug' };
            return;
        }
        if (ctx.path === '/api/groups/net-fault') {
            ctx.status = 502;
            ctx.body = { error: 'bad_gateway', message: 'connect ECONNREFUSED 10.1.2.3:443' };
            return;
        }
        if (ctx.path === '/api/local/admin/db-fault') {
            ctx.status = 400;
            ctx.body = { error: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: groups.slug' };
            return;
        }
        if (ctx.path === '/api/admin/system-fault') {
            ctx.status = 500;
            ctx.body = { message: 'no such table: system_settings' };
            return;
        }
    });

    const server = http.createServer(app.callback()).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        // Success responses pass through
        const resSuccess = await fetch(`${baseUrl}/api/groups/success`);
        const jsonSuccess = await resSuccess.json();
        assert(resSuccess.status === 200 && jsonSuccess.message === 'Group created successfully',
            'successful response (200) is untouched');

        // Plain member refusals pass through
        const resRefusal = await fetch(`${baseUrl}/api/groups/refusal`);
        const jsonRefusal = await resRefusal.json();
        assert(resRefusal.status === 400 && jsonRefusal.error === 'Group not found',
            'plain member refusal (400) is untouched');

        // Member route database fault -> 500 & SERVER_FAULT_TEXT
        const resDbFault = await fetch(`${baseUrl}/api/groups/db-fault`);
        const jsonDbFault = await resDbFault.json();
        assert(resDbFault.status === 500 && jsonDbFault.error === SERVER_FAULT_TEXT,
            `member route database fault is converted to 500 and "${SERVER_FAULT_TEXT}"`);

        // Member route network fault -> 500 & SERVER_FAULT_TEXT
        const resNetFault = await fetch(`${baseUrl}/api/groups/net-fault`);
        const jsonNetFault = await resNetFault.json();
        assert(resNetFault.status === 500 && jsonNetFault.message === SERVER_FAULT_TEXT && jsonNetFault.error === 'bad_gateway',
            `member route network fault message is scrubbed to "${SERVER_FAULT_TEXT}" and status changed to 500`);

        // Operator route /api/local/ -> preserved
        const resOperatorLocal = await fetch(`${baseUrl}/api/local/admin/db-fault`);
        const jsonOperatorLocal = await resOperatorLocal.json();
        assert(resOperatorLocal.status === 400 && jsonOperatorLocal.error === 'SQLITE_CONSTRAINT: UNIQUE constraint failed: groups.slug',
            'operator route /api/local/ preserves exact error details and status');

        // Operator route /api/admin/ -> preserved
        const resOperatorAdmin = await fetch(`${baseUrl}/api/admin/system-fault`);
        const jsonOperatorAdmin = await resOperatorAdmin.json();
        assert(resOperatorAdmin.status === 500 && jsonOperatorAdmin.message === 'no such table: system_settings',
            'operator route /api/admin/ preserves exact error details');

    } finally {
        server.close();
    }
}

async function main(): Promise<void> {
    console.log('=== Testing routes/member-error-text.ts ===');
    await testLooksLikeServerFault();
    await testIsServerFault();
    await testMemberErrorText();
    await testScrubServerFaultsMiddleware();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
}

main().then(() => process.exit(0)).catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
