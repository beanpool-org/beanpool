/**
 * Test Suite: place watches (G5, engine/place-watches.ts) survive a standby and a take-over, and a take-over tells
 * nobody twice. A member sets a watch once; nothing re-creates it, so the standby has to hold it.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), booted as index.ts boots. The
 * directory registry is a FIXTURE on 127.0.0.1; pushes are caught at fetch inside each node, and nothing here reaches
 * another host.
 *
 *  1. A global main server. Members watch places; the mirror sees Mullumbimby for the first time and Wes and Quinn
 *     (whose watches it reaches) are told.
 *  2. Its standby copies it (a force-resync): every watch, its cell, radius and quiet day (`last_notified_at`), and the
 *     directory cache with each community's first sighting.
 *  3. On the main server: Wanda removes a watch, Pru is pruned, Del deletes her account, Wes widens his radius, Vic sets
 *     a watch, and Wes's last notice is two days old. A delta copy brings the standby to exactly the main server's
 *     watches, the removed ones gone (a tombstone each). Then Rex is re-keyed: the copy carries his watch under the new
 *     key. (A delta import after a re-key fails on the members' callsign index before it reaches the watches, so the
 *     move is checked through the force-resync in step 4.)
 *  4. A force-resync clears a watch and a cached community the main server doesn't have, and Rex's watch is his new
 *     key's on the standby.
 *  5. The main server dies and the standby takes over. It has every watch, and Wes and Rex list theirs over HTTPS.
 *     The phones register their push tokens again (as the app does at start), and the first mirror run sees
 *     Byron and Kiezpool, new since the main server stopped: Wes hears about Byron only (not Mullumbimby again),
 *     Wanda about Kiezpool, and Quinn, told a moment before the take-over, keeps his quiet day.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-place-watch-failover.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, type NodeProc } from './takeover-test-harness.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

// Every process of this suite (the orchestrator and each node): an Expo push is recorded, never sent, and any other
// host but this machine is unreachable.
const pushed: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'exp.host') {
        pushed.push(...JSON.parse(String(init?.body ?? '[]')));
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new TypeError(`this suite reaches no host but this machine (${url.host})`);
    return realFetch(input, init);
}) as typeof fetch;

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Watch-Failover-Main-Pw-419!';
const PW_STANDBY = 'Watch-Failover-Standby-Pw-86!';
const DAY_MS = 24 * 60 * 60 * 1000;

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    const { runNodeChild } = await import('./takeover-test-harness.js');
    const watchRows = async () => {
        const { db } = await import('./db/db.js');
        return db.prepare('SELECT id, pubkey, lat, lng, radius_km, created_at, last_notified_at FROM place_watches ORDER BY id').all();
    };
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
            const owner = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            se.seedGenesisMember(owner, 'Anna');
            setReplicationToken(a.replicationToken);
            return { owner, code: (await makeRecoveryCode()).code };
        },
        members: async (a: { members: Record<string, string>; invitedBy: string }) => {
            const { db } = await import('./db/db.js');
            for (const [name, pk] of Object.entries(a.members)) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, updated_at)
                            VALUES (?, ?, ?, ?, 'TEST', 'active', ?)`).run(pk, name, new Date(Date.now() - 30 * DAY_MS).toISOString(), a.invitedBy, new Date().toISOString());
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
            }
            return true;
        },
        watch: async (a: { pk: string; lat: number; lng: number; radiusKm: number }) => {
            const { setPlaceWatch } = await import('./engine/place-watches.js');
            return setPlaceWatch(a.pk, { lat: a.lat, lng: a.lng }, a.radiusKm).watch;
        },
        unwatch: async (a: { pk: string; id: string }) => {
            const { removePlaceWatch } = await import('./engine/place-watches.js');
            return removePlaceWatch(a.pk, a.id);
        },
        prune: async (a: { pk: string }) => {
            const { adminPruneUser } = await import('./state-engine.js');
            adminPruneUser(a.pk, 'test');
            return true;
        },
        'self-delete': async (a: { pk: string }) => {
            const { purgeMemberSelf } = await import('./state-engine.js');
            return purgeMemberSelf(a.pk);
        },
        rekey: async (a: { oldPk: string; newPk: string; operator: string }) => {
            const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
            const { code } = issueRekeyCode(a.oldPk, a.operator);
            return completeRekey(a.oldPk, a.newPk, code, a.operator).success;
        },
        // A day and more since a member's last notice. Stamped as any change to a watch is, where the table has the
        // column, so a delta copy carries it.
        'age-notice': async (a: { pk: string; at: string }) => {
            const { db } = await import('./db/db.js');
            const cols = (db.prepare('PRAGMA table_info(place_watches)').all() as any[]).map((c) => c.name);
            if (cols.includes('updated_at')) {
                db.prepare('UPDATE place_watches SET last_notified_at = ?, updated_at = ? WHERE pubkey = ?').run(a.at, new Date().toISOString(), a.pk);
            } else {
                db.prepare('UPDATE place_watches SET last_notified_at = ? WHERE pubkey = ?').run(a.at, a.pk);
            }
            return true;
        },
        // Rows a standby holds that the main server doesn't: what a force-resync exists to clear.
        strays: async (a: { pk: string }) => {
            const { db } = await import('./db/db.js');
            const now = new Date().toISOString();
            const cols = (db.prepare('PRAGMA table_info(place_watches)').all() as any[]).map((c) => c.name);
            if (cols.includes('updated_at')) {
                db.prepare('INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at, updated_at) VALUES (?, ?, 10, 10, 50, ?, ?)').run('stray-watch', a.pk, now, now);
            } else {
                db.prepare('INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at) VALUES (?, ?, 10, 10, 50, ?)').run('stray-watch', a.pk, now);
            }
            db.prepare(`INSERT INTO directory_cache (community_key, listed, name, lat, lng, first_seen_at, updated_at)
                        VALUES ('peer-stray', 1, 'Stray', 10, 10, ?, ?)`).run(now, now);
            return true;
        },
        watches: watchRows,
        cache: async () => {
            const { db } = await import('./db/db.js');
            return db.prepare('SELECT community_key, listed, name, lat, lng, first_seen_at FROM directory_cache ORDER BY community_key').all();
        },
        mirror: async () => {
            const { runDirectoryMirror } = await import('./services/directory-mirror.js');
            const r = await runDirectoryMirror();
            await new Promise((resolve) => setTimeout(resolve, 100));
            return r;
        },
        'push-tokens': async (a: { tokens: Record<string, string> }) => {
            const { registerPushToken } = await import('./state-engine.js');
            for (const [pk, token] of Object.entries(a.tokens)) registerPushToken(pk, token, 'android');
            return true;
        },
        pushes: async () => pushed.splice(0, pushed.length),
        'export-delta': async (a: { since: string }) => {
            const { exportSyncState } = await import('./state-engine.js');
            return exportSyncState('test', a.since);
        },
        'import': async (a: { payload: any }) => {
            const { importRemoteState } = await import('./state-engine.js');
            return importRemoteState(a.payload);
        },
        now: async () => new Date().toISOString(),
        reseal: async () => {
            const { flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            return (await flushTakeoverChecks()).envelopeId;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { requestResync, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            return { resync, envelope };
        },
        serve: async () => {
            const { initTls } = await import('./services/tls.js');
            const { startHttpsServer } = await import('./https-server.js');
            await initTls();
            return { port: await startHttpsServer(0) };
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
/** For a step the rest of the suite cannot run without. */
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

async function signedGet(port: number, id: Id, route: string): Promise<{ status: number; body: any }> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`https://127.0.0.1:${port}${route}`, {
        headers: {
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`GET\n${route}\n${ts}\n${nonce}\n`), id.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

// The registry's rows. Mullumbimby reaches Wes's and Quinn's watches; Byron (new while the main server is down) does
// too; Kiezpool reaches Wanda's.
const MULLUM = { node_id: 'peer-mullum', community_name: 'Mullumbimby Commons', node_url: 'https://mullum.beanpool.org',
    service_radius: { lat: -28.55, lng: 153.50, radiusKm: 25 }, member_count: 40 };
const BYRON = { node_id: 'peer-byron', community_name: 'Byron Shire Commons', node_url: 'https://byron.beanpool.org',
    service_radius: { lat: -28.65, lng: 153.56, radiusKm: 15 }, member_count: 5 };
const KIEZ = { node_id: 'peer-kiez', community_name: 'Kiezpool', node_url: 'https://kiez.beanpool.org',
    service_radius: { lat: 52.50, lng: 13.42, radiusKm: 10 }, member_count: 6 };

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    delete process.env.NODE_PROFILE;
    delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

    // The fixture registry: GET is the directory each node's mirror reads, paged as PostgREST pages.
    let rows: unknown[] = [];
    const registry = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://fixture');
        const limit = Number(u.searchParams.get('limit') ?? rows.length);
        const offset = Number(u.searchParams.get('offset') ?? 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows.slice(offset, offset + limit)));
    });
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const ENV = {
        NODE_PROFILE: 'global',
        DIRECTORY_MIRROR_URL: `http://127.0.0.1:${(registry.address() as { port: number }).port}/rest/v1/directory_nodes?select=*`,
        DIRECTORY_MIRROR_KEY: 'sb_publishable_TEST-watch-failover',
    };

    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });
    const wes = newId(), quinn = newId(), wanda = newId(), pru = newId(), del = newId(), rex = newId(), rex2 = newId(), vic = newId();
    const token = (id: Id) => `ExponentPushToken[${id.pk.slice(0, 12)}]`;

    try {
        // ── 1. A global main server; members watch places; the mirror sees Mullumbimby ──
        console.log('\n— 1. a global main server; members watch places, and the mirror tells Wes and Quinn about Mullumbimby —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', ...ENV });
        nodes.push(main);
        const { owner, code } = await main.send('setup-primary', { ownerSeedHex, replicationToken });
        await main.send('members', {
            invitedBy: owner,
            members: { Wes: wes.pk, Quinn: quinn.pk, Wanda: wanda.pk, Pru: pru.pk, Del: del.pk, Rex: rex.pk, Vic: vic.pk },
        });
        const wWes = await main.send('watch', { pk: wes.pk, lat: -28.64, lng: 153.61, radiusKm: 50 });
        await main.send('watch', { pk: quinn.pk, lat: -28.70, lng: 153.50, radiusKm: 50 });
        await main.send('watch', { pk: wanda.pk, lat: 52.52, lng: 13.40, radiusKm: 50 });
        const wWandaOslo = await main.send('watch', { pk: wanda.pk, lat: 59.91, lng: 10.75, radiusKm: 30 });
        const wPru = await main.send('watch', { pk: pru.pk, lat: -33.87, lng: 151.21, radiusKm: 40 });
        const wDel = await main.send('watch', { pk: del.pk, lat: -37.81, lng: 144.96, radiusKm: 40 });
        const wRex = await main.send('watch', { pk: rex.pk, lat: -27.47, lng: 153.03, radiusKm: 100 });
        rows = [MULLUM];
        const run1 = await main.send('mirror');
        require_(run1.ok === true && run1.added === 1 && run1.notified === 2, `the main server's mirror sees Mullumbimby and tells two watchers (${JSON.stringify(run1)})`);
        const mainWatches1 = await main.send('watches');
        const heard = (list: any[], pk: string) => list.filter((w) => w.pubkey === pk).map((w) => w.last_notified_at);
        require_(mainWatches1.length === 7 && heard(mainWatches1, wes.pk)[0] && heard(mainWatches1, quinn.pk)[0] && !heard(mainWatches1, wanda.pk)[0],
            'seven watches on the main server; Wes and Quinn have heard, Wanda has not');
        const mainCache1 = await main.send('cache');

        // ── 2. The standby copies it ──
        console.log('\n— 2. its standby copies it —');
        await main.send('reseal');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...ENV });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const pulled = await standby.send('pull');
        require_(pulled.resync?.ok && pulled.envelope === 'stored', `the standby copied the main server and holds its keys (${JSON.stringify(pulled)})`);
        const copied = await standby.send('watches');
        assert(same(copied, mainWatches1),
            `the standby holds every watch: the same ids, members, cells, radii, and when each member last heard (${copied.length} of ${mainWatches1.length})`);
        const copiedCache = await standby.send('cache');
        assert(copiedCache.length === 1 && same(copiedCache, mainCache1),
            `and the directory cache, with Mullumbimby's first sighting as the main server recorded it (${JSON.stringify(copiedCache)})`);

        // ── 3. Changes on the main server reach the standby in a delta ──
        console.log('\n— 3. a removal, a prune, a self-deletion, a wider radius and a new watch, copied as a delta —');
        const since = await main.send('now');
        assert(await main.send('unwatch', { pk: wanda.pk, id: wWandaOslo.id }), 'Wanda removes her Oslo watch');
        await main.send('prune', { pk: pru.pk });
        const deleted = await main.send('self-delete', { pk: del.pk });
        assert(deleted?.ok === true, `Del deletes her own account (${JSON.stringify(deleted)})`);
        const wider = await main.send('watch', { pk: wes.pk, lat: -28.64, lng: 153.61, radiusKm: 60 });
        assert(wider.id === wWes.id && wider.radiusKm === 60, 'Wes widens his watch to 60 km (the same watch)');
        const wVic = await main.send('watch', { pk: vic.pk, lat: -28.80, lng: 153.28, radiusKm: 20 });
        const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS).toISOString();
        await main.send('age-notice', { pk: wes.pk, at: twoDaysAgo });
        const mainWatches2 = await main.send('watches');
        require_(mainWatches2.length === 5, `five watches on the main server now (${mainWatches2.length})`);

        const delta = await main.send('export-delta', { since });
        const watchTombstones = (delta.tombstones ?? []).filter((t: any) => t.tableName === 'place_watches').map((t: any) => t.rowKey).sort();
        assert(same(watchTombstones, [wWandaOslo.id, wPru.id, wDel.id].sort()),
            `the delta carries a tombstone for each removed watch: Wanda's, Pru's and Del's (${JSON.stringify(watchTombstones)})`);
        const imported = await standby.send('import', { payload: delta });
        assert(imported && typeof imported.newMembers === 'number', 'the standby imports the delta');
        const copied2 = await standby.send('watches');
        assert(same(copied2, mainWatches2), `the standby's watches are exactly the main server's again (${copied2.length} of ${mainWatches2.length})`);
        const byId = (list: any[], id: string) => list.find((w) => w.id === id);
        assert(!byId(copied2, wWandaOslo.id), 'Wanda\'s removed watch is gone from the standby');
        assert(!copied2.some((w: any) => w.pubkey === pru.pk) && !copied2.some((w: any) => w.pubkey === del.pk),
            'a pruned member\'s and a deleted account\'s watches are gone from the standby');
        assert(byId(copied2, wWes.id)?.radius_km === 60 && byId(copied2, wWes.id)?.last_notified_at === twoDaysAgo,
            'Wes\'s wider radius and his older last notice reached the standby');
        assert(!!byId(copied2, wVic.id), 'Vic\'s new watch reached the standby');

        // A re-key. Checked in the export and through the force-resync below, not a delta: importing the re-keyed
        // member row into a standby that still holds the old key's row fails on the members' callsign index, whatever
        // the watches do (engine/sync.ts's member import; not this suite's subject).
        console.log('\n— 3b. Rex is re-keyed: the move is in the copy —');
        const sinceRekey = await main.send('now');
        assert(await main.send('rekey', { oldPk: rex.pk, newPk: rex2.pk, operator: owner }), 'Rex is re-keyed to a new key');
        const mainWatches3 = await main.send('watches');
        assert(byId(mainWatches3, wRex.id)?.pubkey === rex2.pk && mainWatches3.length === 5, 'on the main server, Rex\'s watch is his new key\'s, the same watch');
        const rekeyDelta = await main.send('export-delta', { since: sinceRekey });
        const movedOut = (rekeyDelta.placeWatches ?? []).find((w: any) => w.id === wRex.id);
        assert(movedOut?.pubkey === rex2.pk, `the copy after the re-key carries his watch under the new key (${JSON.stringify(movedOut ?? null)})`);

        // ── 4. A force-resync clears what the main server doesn't have ──
        console.log('\n— 4. a force-resync clears a watch and a cached community the main server doesn\'t have —');
        await standby.send('strays', { pk: wes.pk });
        const resynced = await standby.send('pull');
        require_(resynced.resync?.ok, `the standby copies the main server again (${JSON.stringify(resynced.resync)})`);
        const copied3 = await standby.send('watches');
        assert(!byId(copied3, 'stray-watch') && same(copied3, mainWatches3), 'the stray watch is gone and every watch of the main server is there');
        assert(byId(copied3, wRex.id)?.pubkey === rex2.pk && !copied3.some((w: any) => w.pubkey === rex.pk),
            'Rex\'s watch is his new key\'s on the standby, and nothing is left under the old key');
        const copiedCache3 = await standby.send('cache');
        assert(!copiedCache3.some((c: any) => c.community_key === 'peer-stray') && same(copiedCache3, await main.send('cache')),
            'the stray cached community is gone and the cache is the main server\'s');

        // ── 5. The take-over ──
        console.log('\n— 5. the main server dies and the standby takes over —');
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code }, pw(PW_STANDBY));
        require_(opened.status === 200, `the recovery code opens the keys (${opened.status} ${opened.body?.error ?? ''})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        require_(confirmed.status === 200, `confirmed (${confirmed.status})`);
        const exit = await standby.exited;
        assert(exit === 0, `the standby restarts itself (exit ${exit})`);
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...ENV });
        nodes.push(standby);
        require_(standby.ready.role === 'primary', 'it is the main server');

        const after = await standby.send('watches');
        assert(same(after, mainWatches3), `the new main server has every watch the old one had (${after.length} of ${mainWatches3.length})`);
        const port = (await standby.send('serve')).port as number;
        const wesList = await signedGet(port, wes, '/api/global/watches');
        assert(wesList.status === 200 && wesList.body?.watches?.length === 1 && wesList.body.watches[0].id === wWes.id && wesList.body.watches[0].radiusKm === 60,
            `Wes lists his watch on the new main server (${wesList.status} ${JSON.stringify(wesList.body)})`);
        const rexList = await signedGet(port, rex2, '/api/global/watches');
        assert(rexList.status === 200 && rexList.body?.watches?.length === 1 && rexList.body.watches[0].id === wRex.id,
            `and Rex lists his, under his new key (${rexList.status} ${JSON.stringify(rexList.body)})`);

        // The app registers its push token again when it starts; push tokens are the node's own.
        await standby.send('push-tokens', { tokens: { [wes.pk]: token(wes), [quinn.pk]: token(quinn), [wanda.pk]: token(wanda) } });
        await standby.send('pushes');
        rows = [MULLUM, BYRON, KIEZ];
        const run2 = await standby.send('mirror');
        assert(run2.ok === true && run2.added === 2,
            `the new main server's first mirror run finds two communities new: Byron and Kiezpool, not Mullumbimby, which the old one had already seen (${JSON.stringify(run2)})`);
        const pushes = await standby.send('pushes');
        const to = (id: Id) => pushes.filter((m: any) => m.to === token(id));
        assert(to(wes).length === 1 && same(to(wes)[0]?.data?.communities, ['peer-byron']),
            `Wes hears once, about Byron alone: never again about Mullumbimby (${JSON.stringify(to(wes).map((m: any) => m.data))})`);
        assert(to(wanda).length === 1 && same(to(wanda)[0]?.data?.communities, ['peer-kiez']),
            `Wanda hears about Kiezpool (${JSON.stringify(to(wanda).map((m: any) => m.data))})`);
        assert(to(quinn).length === 0,
            `Quinn, told on the old main server a moment ago, keeps his quiet day: no second notice today (${to(quinn).length})`);
        const run3 = await standby.send('mirror');
        assert(run3.ok === true && run3.added === 0 && (await standby.send('pushes')).length === 0, 'the next run finds nothing new and tells nobody');
    } finally {
        for (const n of nodes) await n.kill();
        registry.close();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ Place watches survive a standby and a take-over, and nobody is told twice.');
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
