/**
 * Test Suite: a standby's listings, deals, their photos and projects are its main server's rows verbatim, and a promoted
 * standby's listings are its own (G1 and G1b of scratch/global-node/DESIGN-standby-takeover-gaps-opus.md; §5.3's G1 suite).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; members
 * act through it with signed requests, the admin with the password. The standby pulls through its real puller
 * (services/backup-puller.ts `pullNow`, the loop's own step) from the main server's real backup routes, and takes over
 * with the recovery code through the real path. Nothing leaves this machine.
 *
 * The standby's clock runs an hour ahead of the main server's until the take-over (SQLite's `strftime('now')`, which
 * writes every stamp in the schema): a stamp of its own on a copied row outranks every change the main server makes to
 * it in that hour, and every delete.
 *
 *  1. The main server M: listings (one with three photos, one offered to linked communities), deals (one held, one held
 *     for over a week, one disputed), a project (a bounded enterprise's crowdfund row), a linked community's listing in
 *     its cache.
 *  2. The standby S's first copy: every listing, photo, deal and project row is M's, every column and stamp; a listing
 *     of M's own names no origin (before, M's PeerId), the cached one its community's address.
 *  3. After the first copy, on M: a listing recategorised, a cash note switched on, the dispute resolved, the lingering
 *     deal nudged, two of the three photos taken off the listing, a request made and not yet approved, a pledge into the
 *     project. A delta brings every one, the photos' delete included, with S's clock ahead.
 *  4. A whole copy leaves every row and stamp as M's (before, the deals' upsert restamped every deal it sent again). A
 *     copy that throws after the listings are written leaves S's rows, and the touch triggers the import sets aside, as
 *     they were.
 *  5. A standby as the old importer left it (M's PeerId on every local listing, its own stamps, the first copy's
 *     category, no cash note, no dispute resolution or reminder, a photo M took off, a project not migrated, format 1)
 *     re-seeds itself with its next pull, once, and ends equal to M; the pull after is a delta. A photo and a project M
 *     holds unstamped (an older database's ALTER) take M's listing stamp and its created_at, never NULL.
 *  6. M dies, S takes over with the recovery code. On the promoted S: the request made before the take-over is approved;
 *     a listing from before is requested and approved; a linked community's cached listing is still refused; probation
 *     counts each member's old listings as M did; linked communities are offered what M offered; a member going on
 *     holiday takes their old listings off phones (the delta's author half).
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-listings-verbatim.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, post, copyDir, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Listings-Main-Pw-5092!';
const PW_STANDBY = 'Listings-Standby-Pw-6613!';
const NEIGHBOUR_URL = 'https://neighbours.example';
const NEIGHBOUR_PEER = '12D3KooWListingsNeighbourPeer000000000000000000000';
const AHEAD_MS = 3600_000;

// ── The node processes' commands ───────────────────────────────────────────────────────────

/** No node reaches anything but this machine: a push to Expo is answered here, anything else refused and counted. */
function guardFetch(): { blocked: string[] } {
    const seen = { blocked: [] as string[] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        seen.blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return seen;
}

async function child(): Promise<void> {
    const fetches = guardFetch();
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; genesis: string }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            seedGenesisMember(a.genesis, 'Gwen');
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
        /**
         * This server's SQLite clock `aheadMs` ahead: `strftime(…, 'now')`, which every stamp in the schema is written with
         * (column defaults, touch triggers). Any other time it is asked for is SQLite's own, from a connection of its own.
         */
        'skew-clock': async (a: { aheadMs: number }) => {
            const { db } = await import('./db/db.js');
            const plain = new Database(':memory:');
            db.function('strftime', { varargs: true, deterministic: false }, (format: unknown, time: unknown, ...modifiers: unknown[]) => {
                const at = time === 'now' ? new Date(Date.now() + a.aheadMs).toISOString().replace('T', ' ').replace('Z', '') : time;
                return plain.prepare(`SELECT strftime(?, ?${modifiers.map(() => ', ?').join('')})`).pluck().get(format, at, ...modifiers);
            });
            return (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`).get() as { now: string }).now;
        },
        /** One pull of the kind the loop makes next, then the take-over envelope; `whole` asks the routine whole copy. */
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            process.env.BACKUP_RECONCILE_EVERY_MS = '86400000';
            const after = getBackupStatus();
            const envelope = await pullTakeoverEnvelopeNow();
            return { ...result, whole: after.lastFullReconcileAt !== before, mode: after.lastPullMode ?? null, envelope };
        },
        /** The listings, their photos, the deals and the projects as this server holds them, and its copy's format. */
        rows: async () => {
            const { db } = await import('./db/db.js');
            const posts = (db.prepare('SELECT * FROM posts ORDER BY id').all() as Record<string, unknown>[]).map((r) => {
                // Dormant: nothing reads or writes them (engine/replication-manifest.ts).
                const { target_archetypes: _a, event_conversation_id: _e, ...rest } = r;
                return rest;
            });
            return {
                posts,
                post_photos: db.prepare('SELECT post_id, order_num, updated_at FROM post_photos ORDER BY post_id, order_num').all(),
                marketplace_transactions: db.prepare('SELECT * FROM marketplace_transactions ORDER BY id').all(),
                projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
                format: (db.prepare(`SELECT value FROM node_config WHERE key = 'replica_format'`).get() as { value: string } | undefined)?.value ?? null,
                touch: (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%touch_updated_at' ORDER BY name`).all() as { name: string }[]).map((r) => r.name),
            };
        },
        /**
         * M's whole copy, signed with its own key, with every listing retitled and one more deal that names no listing: the
         * import writes the listings, then throws on the deal (as a disk error there would).
         */
        'forge-throws': async () => {
            const { exportSyncState, signSyncPayload } = await import('./state-engine.js');
            const { getPrivateKey } = await import('./p2p.js');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const payload: any = await exportSyncState(peerIdFromPrivateKey(getPrivateKey()).toString());
            delete payload.signature;
            delete payload.publicKey;
            const later = new Date(Date.now() + 1000).toISOString();
            payload.posts = payload.posts.map((x: any) => ({ ...x, title: `${x.title} (forged)`, updatedAt: later }));
            payload.marketplaceTransactions = [...(payload.marketplaceTransactions ?? []), {
                id: `forged-${crypto.randomUUID()}`, postId: null, buyerPubkey: 'x', sellerPubkey: 'y', credits: 1, status: 'pending', createdAt: later,
            }];
            payload.generatedAt = new Date().toISOString();
            return signSyncPayload(payload);
        },
        /** Import a payload as the puller does, straight into this standby. */
        import: async (a: { payload: any }) => {
            const { importRemoteState } = await import('./state-engine.js');
            try { await importRemoteState(a.payload); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
        },
        /** A linked community's listing in the cache, as the federation pull writes it (no route: the libp2p pull loop). */
        'cache-peer-listing': async (a: { listing: Record<string, unknown> }) => {
            const { cacheRemoteListings } = await import('./federation-listings.js');
            return cacheRemoteListings(NEIGHBOUR_PEER, NEIGHBOUR_URL, [a.listing]);
        },
        /** A held deal made over a week ago, and the hygiene run that nudges its buyer (state-engine.ts runMarketplaceHygiene). */
        nudge: async (a: { id: string }) => {
            const { db } = await import('./db/db.js');
            const { runMarketplaceHygiene } = await import('./state-engine.js');
            db.prepare(`UPDATE marketplace_transactions SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days') WHERE id = ?`).run(a.id);
            runMarketplaceHygiene();
            return (db.prepare('SELECT last_reminded_at FROM marketplace_transactions WHERE id = ?').get(a.id) as { last_reminded_at: string | null }).last_reminded_at;
        },
        /** Each member's kept posts, which probation counts (engine/probation.ts), and what a linked community is offered. */
        standing: async (a: { keys: string[] }) => {
            const { keptPostCount } = await import('./engine/probation.js');
            const { listingsForPeer } = await import('./federation-listings.js');
            return {
                kept: Object.fromEntries(a.keys.map((k) => [k, keptPostCount(k)])),
                offered: listingsForPeer(NEIGHBOUR_PEER).map((l) => l.id).sort(),
            };
        },
        /** A listing's photos and a project unstamped, as an older database holds them: its ALTER added `updated_at` with no default and no backfill (db.ts). */
        unstamp: async (a: { postId: string; projectId: string }) => {
            const { db } = await import('./db/db.js');
            db.prepare('UPDATE post_photos SET updated_at = NULL WHERE post_id = ?').run(a.postId);
            db.prepare('UPDATE projects SET updated_at = NULL WHERE id = ?').run(a.projectId);
            return true;
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        fetches: async () => fetches,
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

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Answer { status: number; body: any }

/** A call to a node's real HTTPS server, signed by `as`, with the admin password in `admin`, or neither. */
async function api(base: string, method: 'GET' | 'POST', route: string, opts: { as?: Id; admin?: string; body?: unknown } = {}): Promise<Answer> {
    const raw = method === 'GET' ? '' : JSON.stringify(opts.body ?? {});
    const headers: Record<string, string> = {};
    if (opts.as) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = opts.as.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), opts.as.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (opts.admin) headers['X-Admin-Password'] = opts.admin;
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
}

const brief = (a: Answer) => `${a.status} ${JSON.stringify(a.body)?.slice(0, 160)}`;
function built(what: string, a: Answer): any {
    require_(a.status >= 200 && a.status < 300, `M: ${what} (${brief(a)})`);
    return a.body;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

type Rows = { posts: any[]; post_photos: any[]; marketplace_transactions: any[]; projects: any[]; format: string | null; touch: string[] };
const TOUCH = ['marketplace_transactions_touch_updated_at', 'post_photos_touch_updated_at', 'posts_touch_updated_at', 'projects_touch_updated_at'];
const TABLE_KEYS: Record<Exclude<keyof Rows, 'format' | 'touch'>, string[]> = {
    posts: ['id'], post_photos: ['post_id', 'order_num'], marketplace_transactions: ['id'], projects: ['id'],
};

/** Where S's rows differ from M's: each table row for row and column for column. */
function rowsDiff(m: Rows, s: Rows): string[] {
    const out: string[] = [];
    for (const [table, key] of Object.entries(TABLE_KEYS) as [Exclude<keyof Rows, 'format' | 'touch'>, string[]][]) {
        const k = (r: any) => key.map((c) => String(r[c])).join('|');
        const ms = new Map(m[table].map((r) => [k(r), r]));
        const ss = new Map(s[table].map((r) => [k(r), r]));
        for (const [id, r] of ms) {
            const o = ss.get(id);
            if (!o) { out.push(`${table} ${id.slice(0, 20)} missing`); continue; }
            for (const c of Object.keys(r)) {
                if (JSON.stringify(r[c]) !== JSON.stringify(o[c])) {
                    out.push(`${table} ${id.slice(0, 20)}.${c}: main ${JSON.stringify(r[c])?.slice(0, 40)}, standby ${JSON.stringify(o[c])?.slice(0, 40)}`);
                }
            }
        }
        for (const id of ss.keys()) if (!ms.has(id)) out.push(`${table} ${id.slice(0, 20)} extra`);
    }
    return out;
}
const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 5).join(' | ')}`);

/** A stopped node's database, written as the old importer left it. */
function withDb(dir: string, fn: (db: Database.Database) => void): void {
    const db = new Database(path.join(dir, 'state.db'));
    try { fn(db); } finally { db.close(); }
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee, kip] = ['Ann', 'Bo', 'Cy', 'Dee', 'Kip'].map(newId);
    const refused: string[] = [];

    try {
        // ── 1. M ──
        console.log('\n— 1. the main server: listings, photos, deals, a project, a linked community\'s listing —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        const A = (route: string, body: unknown) => api(m, 'POST', route, { admin: PW_MAIN, body });
        const S_ = (who: Id, route: string, body: unknown = {}) => api(m, 'POST', route, { as: who, body });
        built('Gwen sets a profile photo', await S_(gwen, '/api/profile/update', { avatar: TINY_PNG }));
        for (const who of [ann, bo, cy, dee, kip]) {
            const inv = built(`Gwen makes an invite for ${who.name}`, await S_(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
            built(`${who.name} joins with it`, await api(m, 'POST', '/api/invite/redeem', { body: { code: inv.invite?.code ?? inv.code, publicKey: who.pk, callsign: who.name } }));
            built(`${who.name} sets a profile photo`, await S_(who, '/api/profile/update', { avatar: TINY_PNG }));
        }
        const offer = async (who: Id, title: string, credits: number, extra: Record<string, unknown> = {}) => built(`${who.name} offers ${title}`, await S_(who, '/api/marketplace/posts', {
            type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits, priceType: 'fixed', authorPublicKey: who.pk, ...extra,
        })).post;
        const deal = async (buyer: Id, seller: Id, postId: string, finish: boolean) => {
            const tx = built(`${buyer.name} asks for ${seller.name}'s listing`, await S_(buyer, '/api/marketplace/posts/request', { postId, buyerPublicKey: buyer.pk })).transaction;
            built(`${seller.name} approves: the Beans are held`, await S_(seller, '/api/marketplace/transactions/approve', { transactionId: tx.id, authorPublicKey: seller.pk }));
            if (finish) built(`${buyer.name} confirms: the Beans are released`, await S_(buyer, '/api/marketplace/transactions/complete', { transactionId: tx.id, confirmerPublicKey: buyer.pk }));
            return tx.id as string;
        };
        built('the admin makes Gwen an Elder (a credit line to buy with)', await A(`/api/local/admin/users/${gwen.pk}/elder`, { grant: true }));
        const sourdough = await offer(gwen, 'Sourdough', 4); // a buyer lists an offer first (the offer covenant)
        const honey = await offer(ann, 'Honey', 3, { photos: [TINY_PNG, TINY_PNG, TINY_PNG] });
        await offer(ann, 'Jam', 2);
        const seedlings = await offer(bo, 'Seedlings', 3);
        const compost = await offer(bo, 'Compost', 2, { reach: 'everywhere' });
        const kindling = await offer(dee, 'Kindling', 3);
        await deal(gwen, cy, (await offer(cy, 'Bike repair', 6)).id, true); // Cy has Beans to buy with
        await deal(gwen, dee, (await offer(dee, 'Firewood', 5)).id, true); // and Dee
        const disputed = await deal(cy, kip, (await offer(kip, 'Tune-up', 2)).id, false); // no owner a party: the password resolves it
        const lingering = await deal(dee, kip, (await offer(kip, 'Mending', 1)).id, false);
        const seed = built('Ann starts a project with a goal', await S_(ann, '/api/treasury', { name: 'Seed Fund', purpose: 'A seed library', lifecycle: 'bounded', goalAmount: 100 }));
        const cached = await main.send('cache-peer-listing', {
            listing: { id: 'nb-1', type: 'offer', category: 'food', title: 'Neighbour jam', description: 'From next door', credits: 2,
                priceType: 'fixed', authorPublicKey: newId('Nia').pk, authorCallsign: 'Nia', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        });
        require_(cached.cached === 1, `M: a linked community's listing is in its cache (${JSON.stringify(cached)})`);
        const m1: Rows = await main.send('rows');
        const cachedRow = m1.posts.find((p) => p.origin_node === NEIGHBOUR_URL);
        require_(m1.post_photos.filter((p) => p.post_id === honey.id).length === 3 && m1.projects.some((p) => p.id === seed.publicKey && p.enterprise_pubkey && p.migrated_at)
            && !!cachedRow && m1.posts.filter((p) => p.origin_node === null).length >= 9,
        `M: Honey's three photos, the project's row made as an enterprise's, the cached listing and M's own (${m1.posts.length} listings)`);

        // ── 2. S's first copy ──
        console.log('\n— 2. the standby, its clock an hour ahead, takes its first copy —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const skewed = await standby.send('skew-clock', { aheadMs: AHEAD_MS });
        require_(Date.parse(skewed) - Date.now() > AHEAD_MS - 60_000, `S: its SQLite clock reads an hour ahead (${skewed})`);
        const firstPull = await standby.send('pull', {});
        require_(firstPull.ok === true, `S: the loop's first pull lands (${firstPull.ok ? firstPull.mode : firstPull.error})`);
        let s: Rows = await standby.send('rows');
        assert(rowsDiff(m1, s).length === 0, `its listings, photos, deals and projects are M's, every column and stamp (differences ${first(rowsDiff(m1, s))})`);
        const ownOrigins = [...new Set(s.posts.filter((p) => p.id !== cachedRow.id).map((p) => p.origin_node))];
        assert(ownOrigins.length === 1 && ownOrigins[0] === null, `a listing of M's own names no origin on S (${JSON.stringify(ownOrigins)})`);
        assert(s.posts.find((p) => p.id === cachedRow.id)?.origin_node === NEIGHBOUR_URL, 'the cached one names its community');
        assert(s.format === '4', `the copy records the importer's format, 4 (${s.format})`); // 2 was this suite's (#1272); 3 is #1268's; 4 the standing copy's (G2)

        // ── 3. Changes after the first copy, then a delta ──
        console.log('\n— 3. after the first copy: the changes a delta must carry —');
        built('Bo recategorises Seedlings', await S_(bo, '/api/marketplace/posts/update', { id: seedlings.id, authorPublicKey: bo.pk, category: 'garden' }));
        built('Dee says Kindling needs cash too', await S_(dee, '/api/marketplace/posts/update', { id: kindling.id, authorPublicKey: dee.pk, cashAlsoNeeded: true }));
        built('the admin resolves the dispute over the tune-up', await A(`/api/local/admin/disputes/${disputed}/resolve`, { action: 'release_to_seller', reason: 'The tune-up was done' }));
        const nudged = await main.send('nudge', { id: lingering });
        require_(typeof nudged === 'string', `M: the hygiene run nudges Dee about the deal held for a week (${nudged})`);
        built('Ann takes two of Honey\'s three photos off', await S_(ann, '/api/marketplace/posts/update', { id: honey.id, authorPublicKey: ann.pk, photos: [TINY_PNG] }));
        const pending = built('Cy asks for Ann\'s honey (not approved yet)', await S_(cy, '/api/marketplace/posts/request', { postId: honey.id, buyerPublicKey: cy.pk })).transaction;
        built('Kip, paid for the tune-up, pledges 1 Bean to the project', await S_(kip, `/api/treasury/${seed.publicKey}/pledge`, { amount: 1 }));
        const delta = await standby.send('pull', {});
        const m3: Rows = await main.send('rows');
        s = await standby.send('rows');
        require_(m3.post_photos.filter((p) => p.post_id === honey.id).length === 1, 'M: Honey has one photo');
        assert(delta.ok === true && delta.mode === 'delta', `the delta lands (${delta.ok ? delta.mode : delta.error})`);
        const onS = (id: string) => s.posts.find((p) => p.id === id);
        const dealOnS = (id: string) => s.marketplace_transactions.find((t) => t.id === id);
        assert(onS(seedlings.id)?.category === 'garden', `the recategorised listing is in its new category on S (${onS(seedlings.id)?.category})`);
        assert(onS(kindling.id)?.cash_also_needed === 1, `the cash note arrives (${onS(kindling.id)?.cash_also_needed})`);
        assert(dealOnS(disputed)?.dispute_resolution && dealOnS(disputed)?.dispute_resolved_by, `the dispute stays resolved on S (${JSON.stringify(dealOnS(disputed)?.dispute_resolution)})`);
        assert(dealOnS(lingering)?.last_reminded_at === nudged, `the nudge is remembered (${dealOnS(lingering)?.last_reminded_at})`);
        assert(s.post_photos.filter((p) => p.post_id === honey.id).length === 1,
            `the two photos M took off are gone from S, its clock an hour ahead (${s.post_photos.filter((p) => p.post_id === honey.id).length} left)`);
        assert(rowsDiff(m3, s).length === 0, `every row and stamp is M's after the delta (differences ${first(rowsDiff(m3, s))})`);

        // ── 4. A whole copy ──
        console.log('\n— 4. a whole copy —');
        const whole = await standby.send('pull', { whole: true });
        const m4: Rows = await main.send('rows');
        s = await standby.send('rows');
        assert(whole.ok === true && whole.whole === true, `the whole copy lands (${whole.ok ? whole.mode : whole.error}; whole ${whole.whole})`);
        assert(rowsDiff(m4, s).length === 0, `every row and stamp is still M's: a deal sent again unchanged is not restamped with S's clock (differences ${first(rowsDiff(m4, s))})`);
        assert(TOUCH.every((t) => s.touch.includes(t)), `the touch triggers the import set aside are back (${s.touch.join(', ')})`);
        const thrown = await standby.send('import', { payload: await main.send('forge-throws') });
        const s4: Rows = await standby.send('rows');
        assert(thrown.ok === false && /NOT NULL/.test(thrown.error ?? ''), `a copy that throws on a deal after its listings is refused (${thrown.error?.slice(0, 100)})`);
        assert(rowsDiff(m4, s4).length === 0 && TOUCH.every((t) => s4.touch.includes(t)),
            `and leaves S's rows and its touch triggers as they were (differences ${first(rowsDiff(m4, s4))}; triggers ${s4.touch.length})`);

        // ── 5. A standby as the old importer left it ──
        console.log('\n— 5. a standby holding the old importer\'s rows re-seeds itself once —');
        await standby.send('checkpoint');
        refused.push(...(await standby.send('fetches')).blocked);
        await standby.kill('SIGTERM');
        copyDir(dir('standby'), dir('old'));
        withDb(dir('old'), (db) => {
            const ahead = new Date(Date.now() + AHEAD_MS).toISOString();
            // Its own writes, with the touch triggers set aside so each stamp is the one planted.
            const touch = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN
                ('posts_touch_updated_at', 'post_photos_touch_updated_at', 'marketplace_transactions_touch_updated_at', 'projects_touch_updated_at')`).all() as { name: string; sql: string }[];
            for (const t of touch) db.exec(`DROP TRIGGER ${t.name}`);
            // The old posts import: M's PeerId on each of M's own listings; the update left the first copy's category and
            // no cash note.
            db.prepare('UPDATE posts SET origin_node = ?, cash_also_needed = 0 WHERE origin_node IS NULL').run(main.ready.peerId);
            db.prepare(`UPDATE posts SET category = 'food' WHERE id = ?`).run(seedlings.id);
            // Its photos stamped with its own clock, and one M took off, which never reached it.
            db.prepare('UPDATE post_photos SET updated_at = ?').run(ahead);
            db.prepare('INSERT OR REPLACE INTO post_photos (post_id, photo_data, order_num, updated_at) VALUES (?, ?, 1, ?)').run(honey.id, TINY_PNG, ahead);
            // Its deals with no resolution or nudge, stamped with its clock; the project as ten columns left it.
            db.prepare('UPDATE marketplace_transactions SET dispute_resolution = NULL, dispute_resolved_at = NULL, dispute_resolved_by = NULL, last_reminded_at = NULL, updated_at = ?').run(ahead);
            db.prepare('UPDATE projects SET migrated_at = NULL, enterprise_pubkey = NULL, updated_at = ?').run(ahead);
            for (const t of touch) db.exec(t.sql);
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('replica_format', '1')`).run();
        });
        const old = await spawnNode(SCRIPT, dir('old'), env(PW_STANDBY, 'backup'));
        nodes.push(old);
        const planted: Rows = await old.send('rows');
        require_(rowsDiff(m4, planted).length > 5 && planted.format === '1', `the planted standby differs from M (${first(rowsDiff(m4, planted))})`);
        const reseed = await old.send('pull', {});
        const m5: Rows = await main.send('rows');
        const o5: Rows = await old.send('rows');
        assert(reseed.ok === true && reseed.mode === 'resync', `its next pull is one re-seed, and it lands (${JSON.stringify({ ok: reseed.ok, mode: reseed.mode, error: reseed.error })})`);
        assert(rowsDiff(m5, o5).length === 0, `it ends equal to M, every row and stamp (differences ${first(rowsDiff(m5, o5))})`);
        assert(o5.format === '4', `and records format 4 (${o5.format})`);
        const after = await old.send('pull', {});
        assert(after.ok === true && after.mode === 'delta', `the pull after it is a delta, not a second re-seed (${JSON.stringify({ ok: after.ok, mode: after.mode, error: after.error })})`);
        // A main server whose older database holds a photo and a project unstamped: the copy stamps each from M's own rows,
        // never NULL (a NULL one is in no delta, and every tombstone for it wins).
        await main.send('unstamp', { postId: honey.id, projectId: seed.publicKey });
        const mNull: Rows = await main.send('rows');
        const seedOnM = mNull.projects.find((p) => p.id === seed.publicKey);
        require_(mNull.post_photos.some((p) => p.post_id === honey.id && p.updated_at === null) && seedOnM?.updated_at === null,
            'M: Honey\'s photo and the project hold no stamp');
        const unstamped = await old.send('pull', { whole: true });
        const o6: Rows = await old.send('rows');
        const honeyStamp = mNull.posts.find((p) => p.id === honey.id)?.updated_at;
        const photoStamps = o6.post_photos.filter((p) => p.post_id === honey.id).map((p) => p.updated_at);
        assert(unstamped.ok === true && unstamped.whole === true && photoStamps.length === 1 && typeof honeyStamp === 'string' && photoStamps[0] === honeyStamp,
            `a photo M holds unstamped takes its listing's stamp, M's (${JSON.stringify(photoStamps)} against ${honeyStamp})`);
        const seedStamp = o6.projects.find((p) => p.id === seed.publicKey)?.updated_at;
        assert(typeof seedStamp === 'string' && seedStamp === seedOnM?.created_at,
            `a project M holds unstamped takes its created_at (${seedStamp} against ${seedOnM?.created_at})`);
        refused.push(...(await old.send('fetches')).blocked);
        await old.kill('SIGTERM');

        // ── 6. The take-over ──
        console.log('\n— 6. M dies; S takes over with the recovery code —');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup')); // its own clock again
        nodes.push(standby);
        const last = await standby.send('pull', {});
        require_(last.ok === true && last.envelope !== undefined, `S: a last pull, and the take-over envelope (${last.ok ? last.mode : last.error}; envelope ${JSON.stringify(last.envelope)?.slice(0, 80)})`);
        const keys = [ann.pk, bo.pk, cy.pk, dee.pk, kip.pk];
        const onMain = await main.send('standing', { keys });
        require_(Object.values(onMain.kept as Record<string, number>).every((n) => n > 0) && onMain.offered.includes(compost.id),
            `M: every member has kept listings, and Compost is offered to linked communities (${JSON.stringify(onMain)})`);
        refused.push(...(await main.send('fetches')).blocked);
        await main.send('checkpoint');
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
        require_(opened.status === 200 && opened.body.success, `the code opens the keys (${opened.status} ${JSON.stringify(opened.body).slice(0, 160)})`);
        refused.push(...(await standby.send('fetches')).blocked);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        require_(confirmed.status === 200, `confirm (${confirmed.status})`);
        require_(await standby.exited === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(standby.ready.role === 'primary' && standby.ready.peerId === main.ready.peerId,
            `promoted, with M's PeerId (${JSON.stringify({ role: standby.ready.role, peerId: standby.ready.peerId?.slice(-8) })})`);
        const p = `https://localhost:${await standby.send('serve')}`;
        const P_ = (who: Id, route: string, body: unknown = {}) => api(p, 'POST', route, { as: who, body });

        console.log('\n— 6. the promoted server\'s listings are its own —');
        const approved = await P_(ann, '/api/marketplace/transactions/approve', { transactionId: pending.id, authorPublicKey: ann.pk });
        assert(approved.status === 200, `Ann approves Cy's request, made before the take-over (${brief(approved)})`);
        const asked = await P_(dee, '/api/marketplace/posts/request', { postId: seedlings.id, buyerPublicKey: dee.pk });
        assert(asked.status === 200, `Dee asks for Bo's seedlings, listed before the take-over (${brief(asked)})`);
        const bothOk = asked.status === 200 && (await P_(bo, '/api/marketplace/transactions/approve', { transactionId: asked.body.transaction.id, authorPublicKey: bo.pk }));
        assert(bothOk && bothOk.status === 200, `and Bo approves it: the Beans are held (${bothOk ? brief(bothOk) : 'not asked'})`);
        const foreign = await P_(dee, '/api/marketplace/posts/request', { postId: cachedRow.id, buyerPublicKey: dee.pk });
        assert(foreign.status >= 400 && /belongs to another community/.test(foreign.body?.error ?? ''),
            `a linked community's cached listing is still refused here (${brief(foreign)})`);
        const onPromoted = await standby.send('standing', { keys });
        assert(JSON.stringify(onPromoted.kept) === JSON.stringify(onMain.kept),
            `probation counts each member's listings from before, as M did (${JSON.stringify(Object.values(onPromoted.kept))} against ${JSON.stringify(Object.values(onMain.kept))})`);
        assert(JSON.stringify(onPromoted.offered) === JSON.stringify(onMain.offered),
            `linked communities are offered what M offered them (${onPromoted.offered.length} against ${onMain.offered.length})`);
        const cursor = new Date().toISOString();
        await sleep(20);
        const away = await P_(gwen, '/api/members/holiday', { enabled: true });
        require_(away.status === 200, `Gwen, with no trade open, goes on holiday on the promoted server (${brief(away)})`);
        const phone = await api(p, 'GET', `/api/marketplace/posts?sync=true&updatedAfter=${encodeURIComponent(cursor)}`, { as: dee });
        const sent = (Array.isArray(phone.body) ? phone.body : phone.body?.posts ?? []).map((x: any) => x.id);
        assert(phone.status === 200 && sent.includes(sourdough.id),
            `a phone's delta from before it carries her listing from before the take-over, so it comes off the phone (${phone.status}; ${sent.length} sent)`);
        refused.push(...(await standby.send('fetches')).blocked);
        assert(refused.length === 0, `nothing reached off this machine (refused: ${refused.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby\'s listings, deals, photos and projects are its main server\'s, and a promoted one\'s listings are its own.');
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
