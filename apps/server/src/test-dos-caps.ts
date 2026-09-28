/**
 * DoS-cap tests (audit findings A2-10, A2-11).
 *
 *   A2-10 the JSON body parser rejects an over-limit body with 413 (incl. on the
 *         unauthenticated /api/invite/redeem path) instead of buffering unbounded.
 *   A2-11 importRemoteState holds every category to the per-category row cap, before entering the single sync
 *         transaction: a table of the ledger set over it refuses the whole payload (OversizedCopyError, naming it); any
 *         other is left out of the import, named in `tablesLeftOut`, and the rest lands (design
 *         scratch/global-node/DESIGN-replica-flood-bounds-opus.md §5, D). Before D, any category over the cap refused
 *         the payload, which let one flooded table stop every copy.
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
import { db } from './db/db.js';
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

        // A2-11 — a table of the ledger set over the cap refuses the payload before the transaction.
        setNodeRole('backup');
        addConnector(`/ip4/127.0.0.1/tcp/4023/p2p/${nodeId}`, 'mirror', 'self');
        const now = new Date().toISOString();
        const hex = () => crypto.randomBytes(32).toString('hex');
        const membersBefore = (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c;
        const fat: SyncPayload = await signSyncPayload({
            nodeId,
            members: Array.from({ length: 101 }, (_v, i) => ({ publicKey: hex(), callsign: `flood-${i}`, joinedAt: now, updatedAt: now, status: 'active' })) as any,
        });
        const err = await assertRejects(() => importRemoteState(fat), 'A2-11: members (the ledger set) over the cap (>100) refuses the payload');
        assert(/rows/i.test(err) && /members/.test(err), `A2-11: the refusal names the table (${err.slice(0, 120)})`);
        const membersAfter = (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c;
        assert(membersAfter === membersBefore, `A2-11: nothing of it was written (${membersBefore} → ${membersAfter} members)`);

        // A2-11 — any other table over the cap is left out of the import, named, and the rest lands.
        const zed = hex();
        const messagesBefore = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
        const partial: SyncPayload = await signSyncPayload({
            nodeId,
            members: [{ publicKey: zed, callsign: 'Zed', joinedAt: now, updatedAt: now, status: 'active' }] as any,
            messages: Array.from({ length: 101 }, (_v, i) => ({ id: `m${i}`, conversationId: 'c', authorPubkey: zed, ciphertext: 'x', nonce: 'n', timestamp: now, updatedAt: now })) as any,
            // A category nothing imports any more (always empty on a main server): not held to the cap, never written.
            recoveryApprovals: Array.from({ length: 101 }, (_v, i) => ({ requestId: 'r' + i, guardianPubkey: 'g', decision: 'approve', createdAt: '2026-01-01T00:00:00Z' })) as any,
        });
        const landed = await importRemoteState(partial);
        const zedHere = !!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(zed);
        const messagesAfter = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
        assert(JSON.stringify(landed.tablesLeftOut) === JSON.stringify(['messages']) && zedHere && messagesAfter === messagesBefore,
            `A2-11: messages over the cap are left out and named, and the member in the same payload lands (${JSON.stringify({ leftOut: landed.tablesLeftOut, zedHere, messagesBefore, messagesAfter })})`);

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
