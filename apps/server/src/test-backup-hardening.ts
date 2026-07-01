/**
 * Phase-1 backup-hardening tests (audit findings A2-8, A2-9, A2-17).
 *
 *   A2-8  the zero-sum conservation guard runs on a BACKUP import UNCONDITIONALLY
 *         (not only under ENFORCE_LEDGER_AUTH) → a value-creating snapshot is
 *         rejected even on a stock backup.
 *   A2-9  isAllowedPrimaryUrl rejects a cleartext (non-loopback) primary URL so
 *         the puller never leaks the admin password + ledger over plaintext.
 *   A2-17 exportSyncState stamps a signed `generatedAt` freshness marker.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-backup-hardening.ts
 * (ENFORCE_LEDGER_AUTH intentionally left UNSET to prove A2-8 is flag-independent.)
 */
import {
    exportSyncState, importRemoteState, initStateEngine, setNodeRole, signSyncPayload,
    type SyncPayload,
} from './state-engine.js';
import { startP2P } from './p2p.js';
import { addConnector, removeConnector } from './connector-manager.js';
import { isAllowedPrimaryUrl } from './backup-puller.js';
import { db } from './db/db.js';

let testsRun = 0, testsPassed = 0;
function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) { testsPassed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}
async function assertRejects(fn: () => Promise<unknown>, msg: string): Promise<string> {
    testsRun++;
    try { await fn(); console.error(`✗ ${msg} (resolved, expected throw)`); return ''; }
    catch (e: any) { testsPassed++; console.log(`✓ ${msg} → ${e.message}`); return e.message || ''; }
}

async function run() {
    console.log('Running Phase-1 backup-hardening tests (A2-8/A2-9/A2-17)...\n');

    // A2-9 — pure URL policy (no engine needed).
    assert(isAllowedPrimaryUrl('https://test.beanpool.org') === true, 'A2-9: https:// primary allowed');
    assert(isAllowedPrimaryUrl('http://localhost:8443') === true, 'A2-9: http://localhost allowed (dev)');
    assert(isAllowedPrimaryUrl('http://127.0.0.1') === true, 'A2-9: http://127.0.0.1 allowed (dev)');
    assert(isAllowedPrimaryUrl('http://test.beanpool.org') === false, 'A2-9: http:// to a public host REJECTED');
    assert(isAllowedPrimaryUrl('http://192.168.1.5:8443') === false, 'A2-9: http:// to a LAN host REJECTED (would leak admin pw)');
    assert(isAllowedPrimaryUrl('ftp://x') === false, 'A2-9: non-http(s) scheme rejected');
    assert(isAllowedPrimaryUrl('not a url') === false, 'A2-9: garbage rejected');

    initStateEngine();
    const node = await startP2P(4020, 4021);
    const nodeId = node.peerId.toString();
    const trustedAddr = `/ip4/127.0.0.1/tcp/4021/p2p/${nodeId}`;

    try {
        // A2-17 — exportSyncState stamps a signed freshness marker.
        const snap = await exportSyncState(nodeId);
        assert(typeof snap.generatedAt === 'string' && !!snap.generatedAt, 'A2-17: exportSyncState includes generatedAt');
        assert(!!snap.signature && !!snap.publicKey, 'A2-17: snapshot is signed (generatedAt is inside the signed base)');

        // Act as a backup whose only trusted mirror is this node.
        setNodeRole('backup');
        addConnector(trustedAddr, 'mirror', 'self-test-peer');

        // Seed >1 account (COMMONS_POOL + A + B) so the conservation guard is armed
        // (bootstrapping nodes with ≤1 account are exempt).
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch) VALUES ('mintA', 50, '2026-01-01T00:00:00.000Z', 0)`).run();
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch) VALUES ('mintB', 50, '2026-01-01T00:00:00.000Z', 0)`).run();

        // A zero-delta re-export of current state imports cleanly (sanity).
        const clean = await exportSyncState(nodeId);
        await importRemoteState(clean);
        assert(true, 'A2-8: a zero-sum (re-exported) snapshot imports without tripping conservation');

        // A2-8 — a validly-signed, value-CREATING snapshot (mintA: 50 → 9999, newer
        // timestamp so LWW imports it) must be REJECTED by the conservation guard
        // even though ENFORCE_LEDGER_AUTH is unset, because nodeRole === 'backup'.
        const forged: SyncPayload = await signSyncPayload({
            nodeId,
            generatedAt: new Date().toISOString(),
            accounts: [{ publicKey: 'mintA', balance: 9999, lastUpdatedAt: '2030-01-01T00:00:00.000Z', lastDemurrageEpoch: 0 } as any],
        });
        const err = await assertRejects(() => importRemoteState(forged),
            'A2-8: value-creating snapshot REJECTED on a backup with ENFORCE_LEDGER_AUTH unset');
        assert(/conservation/i.test(err), 'A2-8: rejection cites the conservation guard');

        // And the rollback held — the forged balance did not land.
        const bal = (db.prepare(`SELECT balance FROM accounts WHERE public_key='mintA'`).get() as { balance: number }).balance;
        assert(bal === 50, 'A2-8: forged balance rolled back (mintA still 50, not 9999)');

        removeConnector(trustedAddr);
        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
        console.log('⭐️ Backup-hardening checks PASSED (A2-8/A2-9/A2-17).');
    } finally {
        await node.stop();
    }
}
run().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
