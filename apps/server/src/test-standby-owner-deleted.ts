/**
 * Test Suite: a standby follows its main server when a removed member deletes their account (Marty's card
 * removed-member-delete, 2026-09-27: "Erase their profile").
 *
 * The removal kept the member's profile on the main server and on its standby. Their Delete account erases it on the main
 * server and marks the account deleted by its owner (members.deleted_by_owner_at), which nothing brings back. A standby
 * that is promoted must know that too, or a reinstate vote there would bring the account back, and it must not keep the
 * profile or the friends the main server erased.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), and the standby pulls through the real
 * puller (services/backup-puller.ts `pullNow`, the loop's own step) from the main server's real backup routes.
 *
 *  1. A main server where Rhea, removed by an admin, keeps her name, bio and a friend each way; its standby copies it.
 *  2. Rhea deletes her account on the main server (purgeMemberSelf, as the route calls it for her signed request).
 *  3. The standby's next pull (a delta) brings the erased profile, the mark and the friends' deletion, at the main
 *     server's stamp; there, the account reads as deleted by its owner.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-owner-deleted.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Owner-Deleted-Main-Pw-517!';
const PW_STANDBY = 'Owner-Deleted-Standby-Pw-29!';

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { replicationToken: string; rhea: string; friend: string }) => {
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const genesis = crypto.randomBytes(32).toString('hex');
            se.seedGenesisMember(genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            for (const [key, name] of [[a.rhea, 'Rhea'], [a.friend, 'Finn']]) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, bio, contact_value)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?, ?)`).run(key, name, genesis, `INV-${name}`, `${name} keeps bees`, `${name.toLowerCase()}@example.com`);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
            }
            db.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(a.rhea, a.friend);
            db.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(a.friend, a.rhea);
            se.adminPruneUser(a.rhea, 'owner:password');
            return true;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
        },
        pull: async () => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before };
        },
        'delete-account': async (a: { key: string }) => {
            const se = await import('./state-engine.js');
            return se.purgeMemberSelf(a.key);
        },
        row: async (a: { key: string }) => {
            const { db } = await import('./db/db.js');
            const se = await import('./state-engine.js');
            // Every column, so a node without deleted_by_owner_at answers null rather than failing.
            const r = db.prepare('SELECT * FROM members WHERE public_key = ?').get(a.key) as Record<string, any> | undefined;
            const friends = (db.prepare('SELECT COUNT(*) AS n FROM friends WHERE owner_pubkey = ? OR friend_pubkey = ?').get(a.key, a.key) as { n: number }).n;
            return {
                callsign: r?.callsign ?? null, bio: r?.bio ?? null, contact: r?.contact_value ?? null, status: r?.status ?? null,
                deletedByOwnerAt: r?.deleted_by_owner_at ?? null, updatedAt: r?.updated_at ?? null, friends,
                deletedByOwner: typeof (se as any).isDeletedByOwner === 'function' ? (se as any).isDeletedByOwner(a.key) : false,
                role: se.getNodeRole(),
            };
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}

const newKey = () => (crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const rhea = newKey();
    const finn = newKey();

    try {
        console.log('\n— 1. a main server where a removed member keeps her profile, and its standby —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, rhea, friend: finn });
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const seeded = await standby.send('resync');
        require_(seeded.ok, `the standby copies its main server (${JSON.stringify(seeded)})`);
        const kept = await standby.send('row', { key: rhea });
        require_(kept.status === 'pruned' && kept.callsign === 'Rhea' && kept.bio === 'Rhea keeps bees' && kept.friends === 2 && kept.deletedByOwnerAt === null,
            `there, Rhea is removed and keeps her name, bio and 2 friends (${JSON.stringify(kept)})`);

        console.log('\n— 2. she deletes her account on the main server —');
        const deleted = await main.send('delete-account', { key: rhea });
        const onMain = await main.send('row', { key: rhea });
        assert(deleted?.ok === true && onMain.callsign === 'Deleted Member' && onMain.bio === null && onMain.friends === 0 && !!onMain.deletedByOwnerAt && onMain.deletedByOwner,
            `the main server erases it and marks it deleted by its owner (${JSON.stringify(deleted)}; ${JSON.stringify(onMain)})`);

        console.log('\n— 3. the standby\'s next pull —');
        const pulled = await standby.send('pull');
        const onStandby = await standby.send('row', { key: rhea });
        assert(pulled.ok && !pulled.whole, `the pull is a delta (${JSON.stringify(pulled)})`);
        assert(onStandby.callsign === 'Deleted Member' && onStandby.bio === null && onStandby.contact === null && onStandby.status === 'pruned',
            `her profile is erased there too (${JSON.stringify(onStandby)})`);
        assert(onStandby.friends === 0, `and her friends are gone there, both ways (${onStandby.friends} left)`);
        assert(onStandby.deletedByOwnerAt === onMain.deletedByOwnerAt && onStandby.deletedByOwner && onStandby.role === 'backup',
            `the standby holds the mark as the main server wrote it, so a promotion can't bring the account back (${onStandby.deletedByOwnerAt} / ${onMain.deletedByOwnerAt})`);
        assert(onStandby.updatedAt === onMain.updatedAt, `at the main server's stamp (${onStandby.updatedAt} / ${onMain.updatedAt})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby follows its main server when a removed member deletes their account.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        process.exit(1);
    });
}
