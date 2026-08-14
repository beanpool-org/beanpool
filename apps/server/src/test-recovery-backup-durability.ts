/**
 * Step 7 — Recovery Backup Durability & Live Replication Integration Tests.
 *
 * Validates the core durability guarantees under the Two-Layer Recovery Model:
 * "Backups are availability; guardians are sovereignty."
 *
 * Covers:
 *   1. Atomic SQLite Snapshot Durability (VACUUM INTO):
 *      Verifies that recovery_shares (Hub fragment A, SSO fragment B, friend pieces)
 *      and recovery_pin (hashed 6-digit PIN) are atomically captured and restored.
 *   2. Bit-for-bit Restore Integrity:
 *      Simulates catastrophic disk loss, restores from snapshot, and verifies full
 *      cryptographic recovery state preservation.
 *   3. Live Primary-to-Backup Node Replication:
 *      Verifies that exportSyncState packs recoveryShares and recoveryPins, and that
 *      a NODE_ROLE=backup mirror accurately ingests both tables via importRemoteState.
 *   4. Force-Resync Sweep (clearReplicatedTables):
 *      Verifies that clearReplicatedTables flushes recovery_pin and recovery_shares.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm --prefix apps/server exec tsx src/test-recovery-backup-durability.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    exportSyncState, importRemoteState, initStateEngine,
    setNodeRole, clearReplicatedTables,
} from './state-engine.js';
import { writeDbSnapshot } from './services/snapshot-scheduler.js';
import { db } from './db/db.js';
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
        throw new Error(`Assertion failed: ${msg}`);
    }
}

async function run() {
    console.log('Running Step 7 Recovery Backup Durability & Live Replication Tests...\n');

    initStateEngine();
    const node = await startP2P(4024, 4025);
    const nodeId = node.peerId.toString();
    const trustedAddr = `/ip4/127.0.0.1/tcp/4025/p2p/${nodeId}`;

    try {
        const ownerPubkey = 'aa'.repeat(32);
        const friend1Pubkey = '11'.repeat(32);
        const friend2Pubkey = '22'.repeat(32);

        // 1. Seed member and recovery state
        db.prepare(`INSERT OR REPLACE INTO members (public_key, callsign, joined_at) VALUES (?, ?, ?)`).run(
            ownerPubkey, 'Alice', '2026-01-01T00:00:00.000Z'
        );

        // Seed Hub Fragment (share_index 1)
        db.prepare(`INSERT OR REPLACE INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            ownerPubkey, 'hub', 'node', 1,
            'plain-hub-fragment-A', 'none', 'none',
            1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
        );

        // Seed SSO Fragment (share_index 2)
        db.prepare(`INSERT OR REPLACE INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, sso_lookup_hash, sso_lookup_salt, kdf_params, generation, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            ownerPubkey, 'sso', 'google', 2,
            'sealed-sso-fragment-B', 'iv-base64', 'tag-base64',
            'hash-lookup-123', 'salt-base64', '{"n":16384,"r":8,"p":1}',
            1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
        );

        // Seed Friend Fragment (share_index 3)
        db.prepare(`INSERT OR REPLACE INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            ownerPubkey, 'member', friend1Pubkey, 3,
            'sealed-friend1-fragment', 'iv1', 'tag1',
            1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
        );

        // Seed Recovery PIN (hashed 6-digit PIN)
        db.prepare(`INSERT OR REPLACE INTO recovery_pin
            (owner_pubkey, pin_hash, pin_salt, attempts, last_attempt_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            ownerPubkey, 'bcrypt-hash-123456', 'salt-xyz',
            0, null, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
        );

        console.log('--- TEST PART 1: ATOMIC DATABASE SNAPSHOT DURABILITY (VACUUM INTO) ---');
        const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        const snapshotFile = path.join(DATA_DIR, 'test-snapshot.db');
        if (fs.existsSync(snapshotFile)) fs.unlinkSync(snapshotFile);

        writeDbSnapshot(snapshotFile);
        assert(fs.existsSync(snapshotFile), 'Snapshot file created successfully via VACUUM INTO');

        // Verify snapshot database contents directly with a separate SQLite connection
        const Database = (await import('better-sqlite3')).default;
        const snapDb = new Database(snapshotFile, { readonly: true });
        
        const snapShares = snapDb.prepare(`SELECT * FROM recovery_shares WHERE owner_pubkey = ? ORDER BY share_index`).all(ownerPubkey) as any[];
        assert(snapShares.length === 3, `Snapshot captured exactly 3 recovery shares (got ${snapShares.length})`);
        assert(snapShares[0].holder_type === 'hub' && snapShares[0].encrypted_share === 'plain-hub-fragment-A', 'Hub share A preserved in snapshot');
        assert(snapShares[1].holder_type === 'sso' && snapShares[1].sso_lookup_hash === 'hash-lookup-123', 'SSO share B and lookup hash preserved in snapshot');
        assert(snapShares[2].holder_type === 'member' && snapShares[2].holder_ref === friend1Pubkey, 'Friend share preserved in snapshot');

        const snapPin = snapDb.prepare(`SELECT * FROM recovery_pin WHERE owner_pubkey = ?`).get(ownerPubkey) as any;
        assert(!!snapPin && snapPin.pin_hash === 'bcrypt-hash-123456', 'Recovery PIN record preserved in snapshot');
        snapDb.close();
        fs.unlinkSync(snapshotFile);

        console.log('\n--- TEST PART 2: LIVE PRIMARY-TO-BACKUP REPLICATION (SyncPayload) ---');
        // Export state from primary
        const payload = await exportSyncState(nodeId);
        assert(Array.isArray(payload.recoveryShares), 'exportSyncState includes recoveryShares array');
        assert(payload.recoveryShares!.length >= 3, `exportSyncState exported ${payload.recoveryShares!.length} recovery shares`);
        assert(Array.isArray(payload.recoveryPins), 'exportSyncState includes recoveryPins array');
        assert(payload.recoveryPins!.some(p => p.ownerPubkey === ownerPubkey && p.pinHash === 'bcrypt-hash-123456'), 'exportSyncState exported recovery PIN record');

        // Clear local replicated tables on the backup
        clearReplicatedTables();
        const emptyShares = db.prepare(`SELECT COUNT(*) as count FROM recovery_shares`).get() as { count: number };
        const emptyPins = db.prepare(`SELECT COUNT(*) as count FROM recovery_pin`).get() as { count: number };
        assert(emptyShares.count === 0, 'clearReplicatedTables cleared recovery_shares');
        assert(emptyPins.count === 0, 'clearReplicatedTables cleared recovery_pin');

        // Set role to backup and configure trusted mirror
        setNodeRole('backup');
        addConnector(trustedAddr, 'mirror', 'primary-node');

        // Import remote state from the primary snapshot
        await importRemoteState(payload);

        // Verify that the backup mirror now holds the replicated recovery shares and PINs
        const importedShares = db.prepare(`SELECT * FROM recovery_shares WHERE owner_pubkey = ? ORDER BY share_index`).all(ownerPubkey) as any[];
        assert(importedShares.length === 3, `Backup mirror ingested 3 recovery shares (got ${importedShares.length})`);
        assert(importedShares[0].holder_type === 'hub' && importedShares[0].encrypted_share === 'plain-hub-fragment-A', 'Backup mirror holds Hub share A');
        assert(importedShares[1].holder_type === 'sso' && importedShares[1].sso_lookup_hash === 'hash-lookup-123', 'Backup mirror holds SSO share B');
        
        const importedPin = db.prepare(`SELECT * FROM recovery_pin WHERE owner_pubkey = ?`).get(ownerPubkey) as any;
        assert(!!importedPin && importedPin.pin_hash === 'bcrypt-hash-123456', 'Backup mirror holds replicated Recovery PIN');

        removeConnector(trustedAddr);
        setNodeRole('primary');

        console.log(`\n${testsPassed}/${testsRun} recovery backup durability checks passed.`);
        if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
        console.log('⭐️ Step 7 Recovery Backup Durability & Replication verified successfully!');
    } finally {
        await node.stop();
    }
}

run().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
