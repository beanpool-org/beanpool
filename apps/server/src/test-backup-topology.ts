/**
 * Phase 1 — one-directional live backup topology tests.
 *
 * Validates the structural invariant that makes the SRV-20/21 ledger-forgery
 * vector unreachable on the live authority: a PRIMARY imports state from NOBODY,
 * and only a BACKUP imports — and only a snapshot whose signer is its trusted
 * `mirror` (the primary). Also exercises the failover promotion sanity check.
 *
 * Run with a throwaway data dir so it never touches a real node:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-backup-topology.ts
 *
 * Covers, in order:
 *   1. DEFAULT role is 'primary' and importRemoteState refuses even a valid,
 *      mirror-trusted payload (the role guard, before any signature work).
 *   2. As a 'backup' with the signer configured as a trusted mirror, the SAME
 *      signed snapshot is imported (this is the HTTPS-pull semantics: fetch the
 *      primary's exportSyncState() output, then importRemoteState locally).
 *   3. A snapshot from a NON-mirror (peer) signer is still rejected as a backup
 *      (the dormant SRV-20 mirror-only gate remains a live safety net).
 *   4. promotionSanityCheck() reports OK on a conservation-consistent ledger.
 *   5. After promotion back to 'primary', importRemoteState refuses again — a
 *      promoted node stops importing.
 */

import {
    exportSyncState, importRemoteState, initStateEngine,
    setNodeRole, getNodeRole, promotionSanityCheck,
} from './state-engine.js';
import { startP2P } from './p2p.js';
import { addConnector, removeConnector } from './connector-manager.js';

let testsRun = 0;
let testsPassed = 0;

function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

async function assertRejects(fn: () => Promise<unknown>, msg: string): Promise<string> {
    testsRun++;
    try {
        await fn();
        console.error(`✗ ${msg} (expected rejection, but it resolved)`);
        return '';
    } catch (e: any) {
        testsPassed++;
        console.log(`✓ ${msg} → ${e.message}`);
        return e.message || '';
    }
}

async function run() {
    console.log('Running Phase 1 one-directional backup topology tests...\n');

    initStateEngine();
    const p2pNode = await startP2P(4018, 4019);
    const nodeId = p2pNode.peerId.toString();
    const trustedAddr = `/ip4/127.0.0.1/tcp/4019/p2p/${nodeId}`;

    try {
        // The primary's snapshot: exactly what GET /api/local/admin/sync-snapshot
        // returns — a signed full SyncPayload from exportSyncState().
        const snapshot = await exportSyncState(nodeId);
        assert(!!snapshot.signature && !!snapshot.publicKey,
            'primary snapshot is signed (signature + publicKey)');

        // 1. Default role: primary imports from nobody — even a valid mirror payload.
        assert(getNodeRole() === 'primary', 'default NODE_ROLE is primary (fail-safe)');
        addConnector(trustedAddr, 'mirror', 'self-test-peer');
        const primaryErr = await assertRejects(() => importRemoteState(snapshot),
            'PRIMARY refuses to import a valid, mirror-trusted snapshot');
        assert(/primary|imports no remote state/i.test(primaryErr),
            'rejection cites the primary role / one-directional topology (not a sig/trust failure)');

        // 2. Backup imports the same snapshot (HTTPS-pull semantics).
        setNodeRole('backup');
        const result = await importRemoteState(snapshot);
        assert(!!result, 'BACKUP imports the primary snapshot once role=backup + mirror trust');

        // 3. Safety net intact: a non-mirror (peer) signer is still rejected as a backup.
        removeConnector(trustedAddr);
        addConnector(trustedAddr, 'peer', 'self-test-peer');
        const peerErr = await assertRejects(() => importRemoteState(snapshot),
            'SRV-20 safety net: a peer (non-mirror) snapshot is rejected even on a backup');
        assert(/mirror/i.test(peerErr), 'rejection cites the mirror-only requirement');
        removeConnector(trustedAddr);
        addConnector(trustedAddr, 'mirror', 'self-test-peer');

        // 4. Failover promotion sanity check on a consistent (freshly-seeded) ledger.
        const audit = promotionSanityCheck();
        assert(audit.ok, 'promotionSanityCheck() reports OK on a conservation-consistent ledger');

        // 5. Promotion: a node restarted as primary stops importing.
        setNodeRole('primary');
        const repromotedErr = await assertRejects(() => importRemoteState(snapshot),
            'a promoted node (back to primary) refuses inbound state again');
        assert(/primary|imports no remote state/i.test(repromotedErr),
            'promoted-primary rejection cites the role guard');

        removeConnector(trustedAddr);

        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        if (testsPassed !== testsRun) {
            throw new Error(`${testsRun - testsPassed} check(s) failed`);
        }
        console.log('⭐️ ALL PHASE 1 BACKUP-TOPOLOGY CHECKS PASSED.');
    } finally {
        await p2pNode.stop();
    }
}

run().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
