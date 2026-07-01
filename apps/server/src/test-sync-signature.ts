/**
 * Sync payload security tests — validates importRemoteState's trust boundary.
 *
 * Run with a throwaway data dir so it never touches a real node's DB/connectors:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-sync-signature.ts
 *
 * Covers, in order:
 *   1. exportSyncState produces a signed payload (signature + publicKey)
 *   2. SRV-1 Gate B: a VALID-signed payload whose signer is NOT a trusted
 *      connector is REJECTED (the hole SRV-1 closed — self-attested signatures
 *      are no longer sufficient)
 *   3. SRV-1 Gate B: once the signer's PeerID is a trusted connector, the same
 *      payload is ACCEPTED (no false negatives for configured peers)
 *   4. A forged signature is rejected (signature verification still holds)
 *   5. A payload missing the signature/publicKey is rejected
 */

import { exportSyncState, importRemoteState, initStateEngine, setNodeRole } from './state-engine.js';
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

/** Assert that an async call rejects (throws). Returns the caught error message. */
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
    console.log('Running sync payload security tests (SRV-1 trust boundary)...\n');

    initStateEngine();
    const p2pNode = await startP2P(4016, 4017);
    const nodeId = p2pNode.peerId.toString();
    // A multiaddr whose /p2p/<id> component makes isPeerTrusted(nodeId) true.
    const trustedAddr = `/ip4/127.0.0.1/tcp/4017/p2p/${nodeId}`;

    try {
        // 1. Export a signed payload.
        const payload = await exportSyncState(nodeId);
        assert(!!payload.signature && !!payload.publicKey,
            'exportSyncState produces a signed payload (signature + publicKey)');

        // 1b. Phase 1 (one-directional backup): the DEFAULT role is 'primary',
        //     which imports state from NOBODY. Even a perfectly valid,
        //     mirror-trusted payload must be rejected by the structural role guard
        //     before any signature/trust work. Configure trust first to prove the
        //     rejection is the role guard, not the trust gate.
        addConnector(trustedAddr, 'mirror', 'self-test-peer');
        const primaryErr = await assertRejects(() => importRemoteState(payload),
            'Phase 1: a PRIMARY rejects inbound state even from a trusted mirror');
        assert(/primary|imports no remote state/i.test(primaryErr),
            'Phase 1: rejection cites the primary role / one-directional topology');
        removeConnector(trustedAddr);

        // From here on, act as a BACKUP (the only role that imports) so the
        // existing SRV-1 / SRV-20 trust-boundary checks below exercise the import.
        setNodeRole('backup');

        // 2. SRV-1 Gate B: valid signature, but signer is not a trusted connector → reject.
        //    (No connectors are configured at this point.)
        const untrustedErr = await assertRejects(() => importRemoteState(payload),
            'SRV-1: validly-signed payload from a NON-trusted signer is rejected');
        assert(/untrusted peer/i.test(untrustedErr),
            'SRV-1: rejection reason cites the untrusted signing key (not a sig failure)');

        // 3. SRV-1 Gate B: trust the signer's PeerID → same payload now accepted.
        addConnector(trustedAddr, 'mirror', 'self-test-peer');
        await importRemoteState(payload);
        assert(true, 'SRV-1: same payload ACCEPTED once signer is a trusted connector (no false negative)');

        // 3b. SRV-20: a 'peer' (cross-community federation) connector must NOT be
        //     able to import ledger state — only 'mirror' connectors may. Re-classify
        //     the same trusted signer as a peer and confirm the identical, validly
        //     signed payload is now rejected.
        removeConnector(trustedAddr);
        addConnector(trustedAddr, 'peer', 'self-test-peer');
        const peerErr = await assertRejects(() => importRemoteState(payload),
            'SRV-20: payload from a non-mirror (peer) connector is rejected');
        assert(/mirror/i.test(peerErr),
            'SRV-20: rejection cites the mirror-only requirement');
        // Restore mirror trust for the remaining cases.
        removeConnector(trustedAddr);
        addConnector(trustedAddr, 'mirror', 'self-test-peer');

        // 4. Forged signature is rejected (sig verification runs before the trust check).
        await assertRejects(() => importRemoteState({ ...payload, signature: 'a'.repeat(128) }),
            'Forged signature is rejected');

        // 5. Missing signature/publicKey is rejected.
        await assertRejects(() => importRemoteState({ ...payload, signature: undefined }),
            'Payload missing signature is rejected');

        // Cleanup the test connector so a shared data dir isn't polluted.
        removeConnector(trustedAddr);

        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        if (testsPassed !== testsRun) {
            throw new Error(`${testsRun - testsPassed} check(s) failed`);
        }
        console.log('⭐️ ALL SYNC PAYLOAD SECURITY CHECKS PASSED.');
    } finally {
        await p2pNode.stop();
    }
}

run().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
