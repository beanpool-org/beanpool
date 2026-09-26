/**
 * Test Suite: a standby upgraded after its main server gets the main server's visitors' marks from its own pulls, before
 * any promotion (PR #1182, review comment 4110436371).
 *
 * The main server marks its visitors' rows once (db.ts markExistingVisitors) and stamps each, so a standby with the
 * column gets the marks by delta. A standby still on an older version had no column: its import copied each of those
 * rows with the main server's stamp and dropped the mark. Once upgraded, it holds them unmarked, and the main server
 * never stamps them again, so no delta brings them back, and a whole copy used to skip them too (a copy is taken only
 * when its stamp is newer). A promoted standby keeps its main server's marks and never marks again itself, so those
 * visitors read as members for good.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), and the standby pulls through the
 * real puller (services/backup-puller.ts `pullNow`, the loop's own step) from the main server's real backup routes.
 *
 *  1. A main server whose visitors are marked: Vi, a visitor's row, and Mo, a member's.
 *  2. Its standby copies it, and is then set back to what an import from before this version left: Vi's row unmarked
 *     with the main server's stamp, and no marker of its own. There, Vi reads as a member.
 *  3. The standby's next pull is a delta, which carries no row of Vi's: she is still unmarked, and the standby now
 *     holds the main server's word that its visitors are marked (so a promotion doesn't mark on less).
 *  4. Its pull after that is one whole copy of the main server, which it asks for because it heard that word with no
 *     marker of its own, and says so in its log. Vi's row takes the main server's mark at the same stamp (the same
 *     version of the row; the main server is the only writer of a standby's copy), keeps that stamp, and she reads as a
 *     visitor, before any promotion. Mo stays a member.
 *  5. The pull after that is a delta again: the whole copy was asked for once.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-visitor-marks.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Visitor-Marks-Main-Pw-417!';
const PW_STANDBY = 'Visitor-Marks-Standby-Pw-93!';
const MARKER = 'migration_mark_visitors_v1';

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { replicationToken: string; visitor: string; member: string }) => {
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const genesis = crypto.randomBytes(32).toString('hex');
            se.seedGenesisMember(genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            // A key a member messaged or sent Beans to: registerVisitor, the only writer of a visitor's row.
            se.registerVisitor(a.visitor, 'Vi');
            // A member, as the doors write one (an inviter and a code).
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code)
                        VALUES (?, 'Mo', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'INV-MO')`).run(a.member, genesis);
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(a.member);
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
        // The puller's next pull, of the kind it chooses (a delta, or a whole copy), and whether it was a whole one.
        pull: async () => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before };
        },
        // A standby as an import from before this version left it: the row unmarked (it had no column), with the
        // main server's stamp, and no marker. The touch trigger restamps a change of the mark, so the stamp is put
        // back by itself (updated_at alone fires nothing).
        'as-old-import': async (a: { keys: string[] }) => {
            const { db } = await import('./db/db.js');
            for (const key of a.keys) {
                const { updated_at } = db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(key) as { updated_at: string };
                db.prepare('UPDATE members SET is_visitor = 0 WHERE public_key = ?').run(key);
                db.prepare('UPDATE members SET updated_at = ? WHERE public_key = ?').run(updated_at, key);
            }
            db.prepare('DELETE FROM node_config WHERE key = ?').run(MARKER);
            return true;
        },
        rows: async (a: { keys: string[] }) => {
            const { db } = await import('./db/db.js');
            const se = await import('./state-engine.js');
            const rows: Record<string, { isVisitor: number | null; updatedAt: string | null; readsAsMember: boolean }> = {};
            for (const key of a.keys) {
                const r = db.prepare('SELECT is_visitor, updated_at FROM members WHERE public_key = ?').get(key) as { is_visitor: number; updated_at: string } | undefined;
                rows[key] = { isVisitor: r?.is_visitor ?? null, updatedAt: r?.updated_at ?? null, readsAsMember: se.readsAsMember(key) };
            }
            const marker = (db.prepare('SELECT value FROM node_config WHERE key = ?').get(MARKER) as { value: string } | undefined)?.value ?? null;
            return { rows, marker, role: se.getNodeRole() };
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
    const vi = newKey();
    const mo = newKey();

    try {
        console.log('\n— 1. a main server whose visitors are marked —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, visitor: vi, member: mo });
        const onMain = await main.send('rows', { keys: [vi, mo] });
        require_(onMain.marker !== null && onMain.rows[vi].isVisitor === 1 && onMain.rows[mo].isVisitor === 0,
            `the main server has marked its visitors: Vi is a visitor, Mo a member (marker ${onMain.marker}, ${onMain.rows[vi].isVisitor}, ${onMain.rows[mo].isVisitor})`);

        console.log('\n— 2. its standby, as an import from before this version left it —');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const seeded = await standby.send('resync');
        require_(seeded.ok, `the standby copies its main server (${JSON.stringify(seeded)})`);
        await standby.send('as-old-import', { keys: [vi] });
        const old = await standby.send('rows', { keys: [vi, mo] });
        require_(old.rows[vi].isVisitor === 0 && old.rows[vi].updatedAt === onMain.rows[vi].updatedAt && old.marker === null && old.role === 'backup',
            `Vi's row there is unmarked, with the main server's stamp, and the standby has no marker (${old.rows[vi].isVisitor}, ${old.rows[vi].updatedAt} / ${onMain.rows[vi].updatedAt}, ${old.marker})`);
        require_(old.rows[vi].readsAsMember === true, 'so, there, Vi reads as a member');

        console.log('\n— 3. its next pull: a delta —');
        const first = await standby.send('pull');
        const afterDelta = await standby.send('rows', { keys: [vi] });
        require_(first.ok && !first.whole, `the pull is a delta (${JSON.stringify(first)})`);
        assert(afterDelta.rows[vi].isVisitor === 0, `it carries no row of Vi's, so she is still unmarked (${afterDelta.rows[vi].isVisitor})`);
        assert(afterDelta.marker !== null, `the standby now holds its main server's word that its visitors are marked, so a promotion doesn't mark on less (${afterDelta.marker})`);

        console.log('\n— 4. the pull after that: one whole copy —');
        const second = await standby.send('pull');
        const healed = await standby.send('rows', { keys: [vi, mo] });
        assert(second.ok && second.whole, `the standby asks for one whole copy of its main server, having heard that word with no marker of its own (${JSON.stringify(second)})`);
        assert(/Visitors' rows: taking one whole copy/.test(standby.output()), 'and says so in its log');
        assert(healed.rows[vi].isVisitor === 1, `Vi's row takes the main server's mark (is_visitor ${healed.rows[vi].isVisitor})`);
        assert(healed.rows[vi].updatedAt === onMain.rows[vi].updatedAt, `…and keeps the main server's stamp (${healed.rows[vi].updatedAt} / ${onMain.rows[vi].updatedAt})`);
        assert(healed.rows[vi].readsAsMember === false && healed.role === 'backup', `Vi reads as a visitor there, before any promotion (${healed.rows[vi].readsAsMember}, ${healed.role})`);
        assert(healed.rows[mo].isVisitor === 0 && healed.rows[mo].readsAsMember === true, 'Mo is still a member');

        console.log('\n— 5. and after that, deltas again —');
        const third = await standby.send('pull');
        const after = await standby.send('rows', { keys: [vi] });
        assert(third.ok && !third.whole, `the whole copy was asked for once: the next pull is a delta (${JSON.stringify(third)})`);
        assert(after.rows[vi].isVisitor === 1, 'Vi is still marked');
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby upgraded after its main server gets its visitors\' marks, before any promotion.');
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
