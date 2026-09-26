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
 *   3a. Recovery seal S2: a member's sign-in copy reaches the standby, in a delta,
 *      as the main server's wrapped bytes, never the client's; the key never.
 */

import { exportSyncState, importRemoteState, initStateEngine, setNodeRole } from './state-engine.js';
import { startP2P } from './p2p.js';
import { addConnector, removeConnector } from './connector-manager.js';
import fs from 'node:fs';
import path from 'node:path';

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


        // 3a. Recovery seal S2: a member's sign-in recovery copy reaches the standby as the main server's WRAPPED
        //     bytes in delta (what a standby pulls since its last copy), never the client's, and the recovery-seal key never travels. The deposit goes over
        //     HTTPS through the signature middleware (recovery-seal-test-http.ts).
        {
            setNodeRole('primary');
            const { startRecoveryHttps, fixtureWords } = await import('./recovery-seal-test-http.js');
            const { db } = await import('./db/db.js');
            const since = new Date(Date.now() - 1000).toISOString();
            const w = fixtureWords(6);
            const dep = await (await startRecoveryHttps()).deposit({ seedHex: w.seedHex, words: w.words, callsign: 'Eve', addMember: true });
            assert(dep.status === 200, `3a. (setup) a member deposits a sign-in copy over HTTPS (${dep.status})`);
            const row = () => db.prepare('SELECT encrypted_share, share_iv, share_tag, kdf_params FROM recovery_shares WHERE owner_pubkey = ?').get(dep.pk) as any;
            const onMain = row();
            const payload = await exportSyncState(nodeId, since);
            const sent: any = (payload.recoveryShares ?? []).find((r: any) => r.ownerPubkey === dep.pk);
            assert(!!sent && sent.encryptedShare === onMain.encrypted_share && sent.shareIv === onMain.share_iv
                && sent.shareTag === onMain.share_tag && sent.kdfParams === onMain.kdf_params && JSON.parse(sent.kdfParams).alg === 'node-wrap-xc20p-v1',
                `3a. the delta (what a standby pulls since its last copy) carries the main server's wrapped row, byte for byte`);
            const text = JSON.stringify(payload);
            const kdf = JSON.parse(dep.sealed.kdfParams);
            const clientPieces = [dep.sealed.encryptedShare, dep.sealed.shareIv, dep.sealed.shareTag, kdf.salt, kdf.words?.ct, kdf.words?.tag].filter(Boolean);
            assert(!clientPieces.some((p: string) => text.includes(p)), `3a. …and none of the client's bytes (seed box, salt, words box)`);
            const key = fs.readFileSync(path.join(process.env.BEANPOOL_DATA_DIR!, 'recovery-seal.key'));
            assert(![key.toString('base64'), key.toString('hex'), key.toString('base64url')].some((n) => text.includes(n)),
                `3a. …and never the recovery-seal key`);
            // A standby that has not copied it yet: the same database, the row removed, then the import.
            db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ?').run(dep.pk);
            setNodeRole('backup');
            await importRemoteState(payload);
            const onStandby = row();
            assert(!!onStandby && onStandby.encrypted_share === onMain.encrypted_share && onStandby.share_iv === onMain.share_iv
                && onStandby.share_tag === onMain.share_tag && onStandby.kdf_params === onMain.kdf_params,
                `3a. the standby's row equals the main server's wrapped bytes`);
            assert(onStandby.encrypted_share !== dep.sealed.encryptedShare && onStandby.kdf_params !== dep.sealed.kdfParams,
                `3a. …never the client's`);
        }
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
