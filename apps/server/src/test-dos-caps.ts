/**
 * DoS-cap tests (audit findings A2-10, A2-11).
 *
 *   A2-10 the JSON body parser rejects an over-limit body with 413 (incl. on the
 *         unauthenticated /api/invite/redeem path) instead of buffering unbounded.
 *   A2-11 importRemoteState rejects a payload whose any category exceeds the
 *         per-category row cap, before entering the single sync transaction.
 *
 * Run (override the cap low so the test stays fast):
 *   MAX_IMPORT_ROWS_PER_CATEGORY=100 ENFORCE... not needed
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-dos-caps.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.MAX_IMPORT_ROWS_PER_CATEGORY = '100'; // small cap so we don't build 250k rows
process.env.NODE_ROLE = 'backup';                 // importRemoteState only runs on a backup

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, exportSyncState, importRemoteState, setNodeRole, signSyncPayload, type SyncPayload } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

const PORT = 8548;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
async function assertRejects(fn: () => Promise<unknown>, msg: string): Promise<string> {
    run++;
    try { await fn(); console.error(`✗ ${msg} (resolved)`); return ''; }
    catch (e: any) { passed++; console.log(`✓ ${msg} → ${e.message}`); return e.message || ''; }
}

async function main() {
    console.log('Running DoS-cap tests (A2-10/A2-11)...\n');
    await initTls();
    initStateEngine();
    const node = await startP2P(4022, 4023);
    await startHttpsServer(PORT);
    const nodeId = node.peerId.toString();

    try {
        // A2-10 — an over-limit JSON body → 413 (unauthenticated redeem path).
        const small = await fetch(`${BASE}/api/invite/redeem`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'x' }),
        });
        assert(small.status !== 413, `A2-10: a normal small body is not 413 (got ${small.status})`);

        const huge = 'a'.repeat(3 * 1024 * 1024); // 3 MB > 2 MB cap
        const big = await fetch(`${BASE}/api/invite/redeem`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: huge }),
        });
        assert(big.status === 413, `A2-10: a >2MB body is rejected with 413 (got ${big.status})`);

        // A2-11 — an oversized import category is rejected before the transaction.
        setNodeRole('backup');
        addConnector(`/ip4/127.0.0.1/tcp/4023/p2p/${nodeId}`, 'mirror', 'self');
        const fat: SyncPayload = await signSyncPayload({
            nodeId,
            recoveryApprovals: Array.from({ length: 101 }, (_v, i) => ({ requestId: 'r' + i, guardianPubkey: 'g', decision: 'approve', createdAt: '2026-01-01T00:00:00Z' })) as any,
        });
        const err = await assertRejects(() => importRemoteState(fat), 'A2-11: oversized import category (>100) is rejected');
        assert(/oversized|rows/i.test(err), 'A2-11: rejection cites the oversized payload');

        // A small import still works (sanity — the cap is not over-zealous).
        const ok = await exportSyncState(nodeId);
        await importRemoteState(ok);
        assert(true, 'A2-11: a normal-sized snapshot still imports');

        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log('⭐️ DoS-cap checks PASSED (A2-10/A2-11).');
    } finally {
        await node.stop();
    }
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
