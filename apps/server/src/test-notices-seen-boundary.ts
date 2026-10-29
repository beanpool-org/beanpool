/**
 * Unit Test Suite: POST /api/notices/seen Payload Boundary & Validation.
 *
 * Verifies:
 * 1. Valid ids payload marks notices seen and returns 200.
 * 2. Over-limit ids array (>100 elements) returns HTTP 400.
 * 3. Oversized payload (>64 KB) returns HTTP 413 payload_too_large.
 * 4. Non-array or invalid element types in ids return HTTP 400.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm --filter @beanpool/server exec tsx src/test-notices-seen-boundary.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { createNoticeRoutes, MAX_NOTICES_SEEN_PAYLOAD_BYTES } from './routes/notices.js';
import { keepNotice } from './engine/kept-notices.js';

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

const deps: any = {
    checkAdminAuth: async () => false,
    rateLimit: () => true,
    clampLimit: (_v: unknown, def = 20) => def,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
};

let router: any;

async function call(
    method: string,
    path: string,
    opts: { actor?: string; body?: Record<string, unknown>; rawBody?: string } = {}
): Promise<{ status: number; body: any }> {
    const layer = (router as any).stack.find((l: any) =>
        (l.path === path || l.regexp.test(path)) && l.methods.includes(method.toUpperCase())
    );
    if (!layer) throw new Error(`${method} ${path} is not mounted in notices router`);

    const ctx: any = {
        state: opts.actor ? { actor: opts.actor } : {},
        requestBody: opts.body ?? {},
        rawBody: opts.rawBody,
        query: {},
        params: {},
        status: 200,
        body: undefined,
        set: () => {},
    };
    await layer.stack[layer.stack.length - 1](ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

function makeMember(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(
        `INSERT INTO members (public_key, callsign, status, joined_at, updated_at)
         VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pubkey, callsign);
    return pubkey;
}

async function main(): Promise<void> {
    console.log('=== Notices Seen Boundary & Validation Test Suite ===\n');

    initStateEngine();
    router = createNoticeRoutes(deps);

    const alice = makeMember('Alice');
    const noticeId = keepNotice(alice, 'Notice Title', 'Notice body', { kind: 'test' });
    assert(typeof noticeId === 'string', 'Created kept notice for Alice');

    // 1. Valid request
    const validRes = await call('POST', '/api/notices/seen', {
        actor: alice,
        body: { ids: [noticeId] },
    });
    assert(validRes.status === 200, 'Valid ids payload returns 200');
    assert(validRes.body.success === true && validRes.body.marked === 1, 'Marked 1 notice seen');

    // 2. Over-limit array size (>100 elements)
    const overArray = Array.from({ length: 101 }, (_, i) => `id_${i}`);
    const overArrayRes = await call('POST', '/api/notices/seen', {
        actor: alice,
        body: { ids: overArray },
    });
    assert(overArrayRes.status === 400, 'Over-limit ids array (>100) returns 400');

    // 3. Oversized request payload (>64 KB)
    const hugeId = 'a'.repeat(50);
    const hugeArray = Array.from({ length: 90 }, () => hugeId);
    const hugePadding = 'x'.repeat(MAX_NOTICES_SEEN_PAYLOAD_BYTES + 100);
    const hugeRawBody = JSON.stringify({ ids: hugeArray, padding: hugePadding });
    const hugeRes = await call('POST', '/api/notices/seen', {
        actor: alice,
        body: JSON.parse(hugeRawBody),
        rawBody: hugeRawBody,
    });
    assert(hugeRes.status === 413, 'Oversized payload (>64KB) returns 413');
    assert(hugeRes.body.error === 'payload_too_large', 'Error code is payload_too_large');

    // 4. Invalid item types or non-array
    const nonArrayRes = await call('POST', '/api/notices/seen', {
        actor: alice,
        body: { ids: 'not-an-array' as any },
    });
    assert(nonArrayRes.status === 400, 'Non-array ids parameter returns 400');

    const invalidTypeRes = await call('POST', '/api/notices/seen', {
        actor: alice,
        body: { ids: [123, 456] as any },
    });
    assert(invalidTypeRes.status === 400, 'Non-string elements in ids return 400');

    const emptyIdsRes = await call('POST', '/api/notices/seen', {
        actor: alice,
        body: { ids: [] },
    });
    assert(emptyIdsRes.status === 400, 'Empty ids array returns 400');

    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
