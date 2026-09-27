/**
 * Test Suite: a standby keeps each member's board standing as its main server wrote it, so once promoted its Market
 * deltas carry the authors its main server's would (card f8, 2026-09-27).
 *
 * The phone's Market delta carries a local author's listings when members.board_standing_changed_at moved after its
 * cursor (engine posts.ts getPosts): holiday, and an enterprise's pause or wind-up. The column travels with the member
 * row: the replication export, the standby's insert and update, and a whole copy for a row at the same stamp.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), and the standby pulls through the real
 * puller (services/backup-puller.ts `pullNow`, the loop's own step) from the main server's real backup routes. Each
 * node's delta is read with getPosts as the marketplace route calls it for a phone (the harness serves only the backup
 * routes).
 *
 *  1. A main server with an enterprise (a lead keeper, an offer), Hana (an offer) and Olly (an offer); its standby
 *     copies it.
 *  2. On the main server the enterprise starts winding up, Hana goes on holiday and Olly edits his bio.
 *  3. The standby's next pull (a delta) holds the enterprise's and Hana's standing as the main server wrote it, at its
 *     stamp: the wind-up's status comes with it and doesn't stamp the standby's own time over the main server's. Olly
 *     has none, there as here.
 *  4. A delta since before step 2 on the main server carries the enterprise's and Hana's listings, not Olly's; and on
 *     each node the authors whose standing moved since then, which is what that delta's author half reads, are the same
 *     two.
 *  5. The main server fills a standing without stamping the row, as its upgrade does (db.ts backfillBoardStanding): no
 *     delta brings it, and a whole copy does.
 *
 * Not asserted, because it doesn't hold on main either (found writing this suite): the standby's copy of a listing
 * carries its main server's node id in posts.origin_node, and the delta's author half reads local authors only
 * (`origin_node IS NULL`), so a promoted standby's delta carries no listing for its author's standing, whatever the
 * column says. Nothing in a take-over makes the old main server's listings local again.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-board-standing.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Board-Standing-Main-Pw-731!';
const PW_STANDBY = 'Board-Standing-Standby-Pw-58!';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { replicationToken: string; pat: string; hana: string; olly: string }) => {
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const genesis = crypto.randomBytes(32).toString('hex');
            se.seedGenesisMember(genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            for (const [key, name] of [[a.pat, 'Pat'], [a.hana, 'Hana'], [a.olly, 'Olly']]) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?)`).run(key, name, genesis, `INV-${name}`, AVATAR);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
            }
            const { publicKey: mill } = se.createTreasury('Mill', AVATAR, 100);
            db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by) VALUES (?, ?, 'lead', 'admin')`).run(mill, a.pat);
            db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(a.pat);
            const offer = (author: string, title: string) =>
                se.createPost('offer', 'food', title, '', 5, 'fixed', author, undefined, undefined, undefined, true)!.id;
            return { mill, posts: { mill: offer(mill, 'Flour'), hana: offer(a.hana, 'Lemons'), olly: offer(a.olly, 'Firewood') } };
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
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            await new Promise((r) => setTimeout(r, 5));
            // A whole copy the way the routine re-read takes one: into the rows it has, nothing cleared first.
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            try {
                const result = await pullNow();
                return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before };
            } finally {
                delete process.env.BACKUP_RECONCILE_EVERY_MS;
            }
        },
        change: async (a: { mill: string; pat: string; hana: string; olly: string }) => {
            const se = await import('./state-engine.js');
            se.initiateWindUp(a.mill, a.pat);
            se.setHolidayMode(a.hana, true);
            return !!se.updateProfile(a.olly, { bio: 'Splits and stacks it too' });
        },
        fill: async (a: { key: string; at: string }) => {
            const { db } = await import('./db/db.js');
            return db.prepare('UPDATE members SET board_standing_changed_at = ? WHERE public_key = ?').run(a.at, a.key).changes;
        },
        row: async (a: { key: string }) => {
            const { db } = await import('./db/db.js');
            const se = await import('./state-engine.js');
            // Every column, so a node without board_standing_changed_at answers null rather than failing.
            const r = db.prepare('SELECT * FROM members WHERE public_key = ?').get(a.key) as Record<string, any> | undefined;
            return {
                standing: r?.board_standing_changed_at ?? null, updatedAt: r?.updated_at ?? null, status: r?.status ?? null,
                bio: r?.bio ?? null, role: se.getNodeRole(),
            };
        },
        delta: async (a: { since: string }) => {
            const se = await import('./state-engine.js');
            return se.getPosts({ updatedAfter: a.since, sync: true, types: ['offer', 'need', 'poll', 'event'], limit: 1000 })
                .map(p => ({ id: p.id, status: p.status }));
        },
        // The members whose standing moved since then (every column, so a node without it answers none).
        'standing-since': async (a: { since: string }) => {
            const { db } = await import('./db/db.js');
            return (db.prepare('SELECT * FROM members').all() as Array<Record<string, any>>)
                .filter(r => typeof r.board_standing_changed_at === 'string' && r.board_standing_changed_at >= a.since)
                .map(r => r.public_key as string).sort();
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pat = newKey();
    const hana = newKey();
    const olly = newKey();

    try {
        console.log('\n— 1. a main server with an enterprise, Hana and Olly, and its standby —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        const { mill, posts } = await main.send('setup-primary', { replicationToken, pat, hana, olly });
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const seeded = await standby.send('resync');
        require_(seeded.ok, `the standby copies its main server (${JSON.stringify(seeded)})`);
        const copied = await standby.send('row', { key: mill });
        require_(copied.status === 'active' && copied.standing === null, `there, the enterprise is active and its standing never changed (${JSON.stringify(copied)})`);

        console.log('\n— 2. on the main server: a wind-up, a holiday, a bio —');
        const since = new Date(Date.now() - 1).toISOString();
        await sleep(5);
        require_(await main.send('change', { mill, pat, hana, olly }), 'the enterprise starts winding up, Hana goes on holiday, Olly edits his bio');
        const onMain = { mill: await main.send('row', { key: mill }), hana: await main.send('row', { key: hana }), olly: await main.send('row', { key: olly }) };
        assert(onMain.mill.status === 'winding_up' && onMain.mill.standing > since && onMain.hana.standing > since && onMain.olly.standing === null,
            `the main server stamps the enterprise's and Hana's standing, not Olly's (${onMain.mill.standing}, ${onMain.hana.standing}, ${onMain.olly.standing})`);

        console.log('\n— 3. the standby\'s next pull —');
        await sleep(20);
        const pulled = await standby.send('pull', {});
        assert(pulled.ok && !pulled.whole, `the pull is a delta (${JSON.stringify(pulled)})`);
        const onStandby = { mill: await standby.send('row', { key: mill }), hana: await standby.send('row', { key: hana }), olly: await standby.send('row', { key: olly }) };
        assert(onStandby.mill.status === 'winding_up' && onStandby.mill.standing === onMain.mill.standing && onStandby.mill.updatedAt === onMain.mill.updatedAt,
            `the standby holds the enterprise winding up, with the main server's standing and stamp, not its own time (${onStandby.mill.standing} / ${onMain.mill.standing})`);
        assert(onStandby.hana.standing === onMain.hana.standing && onStandby.hana.updatedAt === onMain.hana.updatedAt,
            `and Hana's standing as the main server wrote it (${onStandby.hana.standing} / ${onMain.hana.standing})`);
        assert(onStandby.olly.bio === 'Splits and stacks it too' && onStandby.olly.standing === null,
            `Olly's bio reaches it, and he has no standing there either (${onStandby.olly.standing})`);

        console.log('\n— 4. a delta since before the changes —');
        const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id).filter(id => Object.values(posts).includes(id)).sort();
        const mainDelta = ids(await main.send('delta', { since }));
        assert(JSON.stringify(mainDelta) === JSON.stringify([posts.mill, posts.hana].sort()),
            `the main server's carries the enterprise's and Hana's listings, not Olly's (${mainDelta.length} of ours)`);
        const moved = { main: await main.send('standing-since', { since }), standby: await standby.send('standing-since', { since }) };
        assert(JSON.stringify(moved.main) === JSON.stringify([mill, hana].sort()) && JSON.stringify(moved.standby) === JSON.stringify(moved.main),
            `on each node the authors whose standing moved since then are the enterprise and Hana (main ${moved.main.length}, standby ${moved.standby.length})`);

        console.log('\n— 5. a standing the main server fills without stamping the row —');
        const filledAt = new Date().toISOString();
        assert(await main.send('fill', { key: olly, at: filledAt }) === 1, 'the main server fills Olly\'s standing, as its upgrade does, leaving updated_at');
        await sleep(20);
        await standby.send('pull', {});
        assert((await standby.send('row', { key: olly })).standing === null, 'a delta doesn\'t bring it: the row\'s stamp didn\'t move');
        const whole = await standby.send('pull', { whole: true });
        const ollyThere = await standby.send('row', { key: olly });
        assert(whole.ok && whole.whole && ollyThere.standing === filledAt && ollyThere.updatedAt === (await main.send('row', { key: olly })).updatedAt,
            `a whole copy does, at the same stamp (${JSON.stringify(whole)}; ${ollyThere.standing})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby keeps each member\'s board standing as its main server wrote it.');
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
