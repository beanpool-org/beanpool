/**
 * Test Suite: a standby's boot keeps the main server's listing times, so what the main server changed reaches it, and a
 * phone's replace after a take-over drops what only the old server had.
 *
 * Every boot, in every role, fills in the search keywords of the listings that have none (state-engine.ts
 * backfillSearchKeywords). A standby's import writes the main server's (G1b, standby PR 2); a copy an older importer made
 * has none, and this suite plants that copy's (no words, the main server's times) to boot on. That fill once moved each
 * listing's `updated_at` to the booting server's clock (the posts touch trigger), with two consequences this suite pins:
 *
 *  1. A standby restarted between two pulls. The main server edits a listing's title and withdraws another while the
 *     standby is down. After the standby's boot and its pulls it holds the main server's values: the import skips a
 *     change whose time is not later than the row's own, so a restamped row refused both, for good (#1253's finding).
 *  2. A take-over. Listings copied to the standby, then one more on the main server (the tail, which the standby never
 *     copies), the main server killed, the take-over with the recovery code and its restart. The new server's whole
 *     posts pull (the phone's, `sync=true`) carries the main server's times, and the phone's own replace rule
 *     (apps/native utils/posts-replace.ts, run here as it is) drops the tail listing. A restamped answer set its bound
 *     after the tail, so the phone kept the tail and stored the new epoch for good (design §2 "G7", PR #1254's review).
 *     Search still finds the copied listings by their keywords.
 *
 * Every node is its own process (takeover-test-harness.ts), serving the real posts routes on a port of its own
 * (`serve-sync`, as test-sync-reads-carry-epoch.ts does). Nothing leaves this machine.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-keeps-listing-times.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawnNode, post, runNodeChild, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

const SCRIPT = fileURLToPath(import.meta.url);
/** The phone's replace rule, as the app runs it (a pure module with no imports). */
const PHONE_RULE = new URL('../../native/utils/posts-replace.ts', import.meta.url).href;
const PW_MAIN = 'Keeps-Main-Pw-6613!';
const PW_STANDBY = 'Keeps-Standby-Pw-2087!';
/** More than a page (engine MAX_PAGE_LIMIT, 200), so the phone's bound comes from inside the copied listings. */
const COPIED = 205;
/** The phone's whole posts pull (apps/native services/pillar-sync.ts, utils/events.ts EVENT_TYPES_QUERY). */
const WHOLE_PULL = '/api/marketplace/posts?limit=1000&sync=true&types=offer,need,poll,event';

// ── The node processes' commands ───────────────────────────────────────────────────────────

/** No node here reaches anything but localhost; what it tried is counted, so the suite can say so. */
function guardFetch(): string[] {
    const blocked: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return blocked;
}

async function child(): Promise<void> {
    const blocked = guardFetch();
    let owner = '';
    const ownerOf = async () => {
        if (owner) return owner;
        const { db } = await import('./db/db.js');
        owner = (db.prepare("SELECT member_pubkey FROM node_roles WHERE role = 'owner' LIMIT 1").get() as { member_pubkey: string }).member_pubkey;
        return owner;
    };
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const { db } = await import('./db/db.js');
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            owner = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            se.seedGenesisMember(owner, 'Anna');
            // A profile photo, which the marketplace asks for before a first listing.
            db.prepare("UPDATE members SET avatar_url = 'bundled://leaf' WHERE public_key = ?").run(owner);
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            await flushTakeoverChecks();
            return { code: made.code };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        /** The owner lists offers, one by one, as the marketplace route does. */
        list: async (a: { titles: string[]; category: string }) => {
            const se = await import('./state-engine.js');
            const pk = await ownerOf();
            return a.titles.map((t) => se.createPost('offer', a.category, t, '', 5, 'fixed', pk)!.id);
        },
        edit: async (a: { id: string; title: string }) => {
            const se = await import('./state-engine.js');
            return !!se.updatePost(a.id, await ownerOf(), { title: a.title });
        },
        withdraw: async (a: { id: string }) => {
            const se = await import('./state-engine.js');
            return se.removePost(a.id, await ownerOf());
        },
        /** The force-resync an operator runs for a new standby (its own first pull is refused on main today, G9), and the keys. */
        resync: async () => {
            const { requestResync, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            return { resync: await requestResync(), envelope: await pullTakeoverEnvelopeNow() };
        },
        /** What index.ts does at a standby's boot: the puller resumes from its saved cursor (its loop is not left running). */
        'resume-puller': async () => {
            const { initBackupPuller, stopBackupPuller, getBackupStatus } = await import('./services/backup-puller.js');
            initBackupPuller();
            stopBackupPuller();
            return getBackupStatus().cursor;
        },
        /** One pull of the kind the loop makes next, and the keys. */
        pull: async () => {
            const { pullNow, getBackupStatus, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            const result = await pullNow();
            return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before, envelope: await pullTakeoverEnvelopeNow() };
        },
        /**
         * The listings as a copy an older importer made holds them: no search keywords (it wrote none), each at the time
         * it was copied with. The posts touch trigger is set aside for the write, so no stamp moves.
         */
        'clear-keywords': async (a: { ids: string[] }) => {
            const { db } = await import('./db/db.js');
            db.transaction(() => {
                const touch = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'posts_touch_updated_at'`).get() as { sql: string }).sql;
                db.exec('DROP TRIGGER posts_touch_updated_at');
                const clear = db.prepare(`UPDATE posts SET search_keywords = '' WHERE id = ?`);
                for (const id of a.ids) clear.run(id);
                db.exec(touch);
            })();
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        /** Every listing as it lies. */
        rows: async () => {
            const { db } = await import('./db/db.js');
            return db.prepare(`SELECT id, title, active, status, created_at, updated_at, audience_scope, search_keywords FROM posts ORDER BY id`).all();
        },
        // The routes a phone syncs and searches by, as https-server.ts mounts them, on a port of their own.
        'serve-sync': async () => {
            const Koa = (await import('koa')).default;
            const { createMarketplaceRoutes } = await import('./routes/marketplace.js');
            const deps: any = {
                checkAdminAuth: async () => false, rateLimit: () => true,
                clampLimit: (v: unknown, d = 50) => { const n = Math.floor(Number(v)); return n > 0 ? Math.min(n, 200) : d; },
                clampOffset: () => 0, activeConnections: new Map(), calculateAnalytics: () => ({}),
                enforceReadAuth: false, broadcast: () => {},
            };
            const app = new Koa();
            app.use(createMarketplaceRoutes(deps).routes());
            const server = http.createServer(app.callback());
            await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
            return { port: (server.address() as AddressInfo).port };
        },
        blocked: async () => blocked,
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

interface Row { id: string; title: string; active: number; status: string; created_at: string; updated_at: string | null; audience_scope: string | null; search_keywords: string | null }
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id, r]));

async function getJson(url: string): Promise<any> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const pw = (p: string) => ({ 'X-Admin-Password': p });

    try {
        const main = await spawnNode(SCRIPT, dirs.main, env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { ownerSeedHex, replicationToken });
        const mainPeerId = main.ready.peerId;

        // ── 1. A standby restarted between two pulls ──
        console.log('\n— 1. a standby restarted between two pulls keeps the main server\'s times, and takes its changes —');
        const [honey, eggs] = await main.send('list', { titles: ['Honey', 'Eggs'], category: 'food' });
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: mainPeerId });
        const first = await standby.send('resync');
        require_(first.resync.ok && first.envelope === 'stored', `S: the first copy and the keys (${JSON.stringify(first.resync).slice(0, 120)})`);
        const onMain = byId(await main.send('rows'));
        const imported = byId(await standby.send('rows'));
        require_([honey, eggs].every((id) => imported.get(id)?.updated_at === onMain.get(id)?.updated_at
            && !!onMain.get(id)?.search_keywords && imported.get(id)?.search_keywords === onMain.get(id)?.search_keywords),
        'S holds Honey and Eggs at the main server\'s times, with its search keywords (the import writes them)');
        await standby.send('clear-keywords', { ids: [honey, eggs] });
        const copied = byId(await standby.send('rows'));
        require_([honey, eggs].every((id) => copied.get(id)?.updated_at === onMain.get(id)?.updated_at && !copied.get(id)?.search_keywords),
            'planted as an older importer copied them: the main server\'s times, no search keywords');

        await standby.kill();
        await main.send('edit', { id: honey, title: 'Honey, now 4 jars' });
        await main.send('withdraw', { id: eggs });
        const edited = byId(await main.send('rows'));
        await new Promise((r) => setTimeout(r, 20)); // the standby's boot is clearly later than the main server's changes
        standby = await spawnNode(SCRIPT, dirs.standby, env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        const booted = byId(await standby.send('rows'));
        assert([honey, eggs].every((id) => booted.get(id)?.updated_at === copied.get(id)?.updated_at),
            `S's boot moves no listing's time (Honey ${booted.get(honey)?.updated_at}, as copied ${copied.get(honey)?.updated_at})`);
        assert([honey, eggs].every((id) => (booted.get(id)?.search_keywords ?? '').includes('food')),
            `and it fills in their search keywords (Honey: "${booted.get(honey)?.search_keywords}")`);

        const cursor = await standby.send('resume-puller');
        require_(!!cursor, 'S resumes its pulls from its saved cursor, as a boot does');
        const pulls = [await standby.send('pull'), await standby.send('pull')];
        require_(pulls.every((p) => p.ok), `S pulls twice after its boot (${pulls.map((p) => (p.whole ? 'whole' : 'delta')).join(', ')})`);
        const after = byId(await standby.send('rows'));
        assert(after.get(honey)?.title === 'Honey, now 4 jars',
            `the main server's title edit reached S ("${after.get(honey)?.title}")`);
        assert(after.get(eggs)?.active === 0 && after.get(eggs)?.status === 'cancelled',
            `the main server's withdrawal reached S (Eggs: active ${after.get(eggs)?.active}, ${after.get(eggs)?.status})`);
        assert([honey, eggs].every((id) => after.get(id)?.updated_at === edited.get(id)?.updated_at),
            `S holds both at the main server's new times (Honey ${after.get(honey)?.updated_at}, main ${edited.get(honey)?.updated_at})`);

        // ── 2. A take-over ──
        console.log(`\n— 2. a take-over: the new server's whole pull carries the main server's times, and the phone drops the tail —`);
        const many = await main.send('list', { titles: Array.from({ length: COPIED }, (_, i) => `Jar ${i + 1}`), category: 'food' });
        const pulled = await standby.send('pull');
        require_(pulled.ok, `S copies the ${COPIED} new listings (${pulled.whole ? 'whole' : 'delta'})`);
        const importedMany = byId(await standby.send('rows'));
        require_(many.every((id: string) => !!importedMany.get(id)?.search_keywords),
            `S holds all ${COPIED}, with the main server's search keywords (the import writes them)`);
        await standby.send('clear-keywords', { ids: many });
        const heldBefore = byId(await standby.send('rows'));
        require_(many.every((id: string) => heldBefore.get(id) && !heldBefore.get(id)!.search_keywords && heldBefore.get(id)!.updated_at === importedMany.get(id)!.updated_at),
            `planted as an older importer copied them: none with search keywords yet, each at its copied time`);
        await new Promise((r) => setTimeout(r, 20));
        const [tail] = await main.send('list', { titles: ['Firewood, a trailer load'], category: 'fuel' });
        // A phone that synced everything the main server had, the tail too, holds each listing at the main server's time.
        const mainRows: Row[] = await main.send('rows');
        const phoneHeld = mainRows.map((r) => ({ id: r.id, at: r.updated_at ?? r.created_at, scope: r.audience_scope }));
        const mainTimes = byId(mainRows);
        const mainBlocked: string[] = await main.send('blocked');
        await main.kill('SIGKILL');

        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, pw(PW_STANDBY));
        require_(opened.status === 200 && opened.body.preview?.peerId === mainPeerId, `the recovery code opens the keys (${opened.status})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        require_(confirmed.status === 200, `the take-over is confirmed (${confirmed.status})`);
        require_((await standby.exited) === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dirs.standby, env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(standby.ready.role === 'primary' && standby.ready.peerId === mainPeerId, 'it is the main server, with the same PeerId');

        const { port } = await standby.send('serve-sync');
        const base = `http://127.0.0.1:${port}`;
        const whole: any[] = await getJson(base + WHOLE_PULL);
        require_(whole.length === 200, `the new server's whole pull is a page of 200 (${whole.length})`);
        const moved = whole.filter((p) => p.updatedAt !== mainTimes.get(p.id)?.updated_at);
        assert(moved.length === 0,
            `every listing in it carries the main server's time (${moved.length} moved${moved.length ? `, e.g. ${moved[0].updatedAt} where main had ${mainTimes.get(moved[0].id)?.updated_at}` : ''})`);
        assert(!whole.some((p) => p.id === tail), 'the tail listing is not in it: the standby never copied it');

        const { postsTheNodeNoLongerHas } = await import(PHONE_RULE);
        const gone: string[] = postsTheNodeNoLongerHas(whole, phoneHeld);
        assert(gone.includes(tail), `the phone's replace drops the tail listing (it drops ${gone.length}: ${gone.map((id) => mainTimes.get(id)?.title).join(', ') || 'none'})`);
        assert(gone.length === 1, 'and nothing else: every listing the new server has stays on the phone');

        const found: any[] = await getJson(`${base}/api/marketplace/posts?q=food`);
        assert(found.length > 0 && found.every((p) => many.includes(p.id) || p.id === honey || p.id === eggs),
            `search still finds the copied listings by their keywords ("food" is only in their keywords: ${found.length} found)`);

        const blocked = [...mainBlocked, ...await standby.send('blocked')];
        assert(blocked.length === 0, `nothing reached off this machine, from the main server or the new one (refused: ${blocked.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill().catch(() => {});
    }

    console.log(`\n${testsPassed}/${testsRun} passed`);
    if (testsPassed !== testsRun) process.exit(1);
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error(e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error(e?.output ? `${e.message}\n--- node output ---\n${e.output}` : e);
        console.log(`\n${testsPassed}/${testsRun} passed`);
        process.exit(1);
    });
}
