/**
 * Test Suite: Delete account wipes the words, photos and places of the member's posts, on the main server, on its standby
 * and after a take-over (report C14, recommendation b; engine/post-scrub.ts).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; members
 * act through it with signed requests, the admin with the password. The standby pulls through its real puller
 * (services/backup-puller.ts `pullNow`) from the main server's real backup routes, and takes over with the recovery code
 * through the real path. Nothing leaves this machine.
 *
 *  1. The main server M. Rhea has: a listing up, with two photos and a pin, that Cy reports and the pricing guide takes
 *     its picture from; a listing Bo bought (a done deal); a listing she took down herself; a listing whose deal an admin
 *     ruled on; an event with a photo, a pin, a place name and a note for the people going, Bo going; a poll Bo voted in.
 *     Every one names words found nowhere else. Before she deletes, each route shows them (so the checks below can fail).
 *  2. The standby S copies M: it holds the words and the photos too.
 *  3. Rhea deletes her account (POST /api/member/purge). On M: every post of hers but the poll, whatever its status, keeps
 *     its row and id and loses its title, description, photos (rows, objects, a tombstone per slot) and place; the event's
 *     chat takes the neutral name, and Bo, going, still reads it until the 30-day scrub; the poll is closed and keeps its
 *     question and votes; the deals and ledger rows still name the posts. Search finds none of her words, the index is sound (the cancel and
 *     the wipe write each post twice in one millisecond: #878) and holds none of her words in its bytes. No route, read by
 *     a member, a guest, the admin or the replication export, returns one of her words, a photo link or a pin.
 *  4. S's next pull (a delta) makes its rows, photos, replies and chat names M's, deletes its photo objects, and leaves its
 *     search index as clean. So do a restart of S (the boot keyword backfill), the pull after it, and a whole copy.
 *  5. M dies and S takes over: the promoted server's routes return none of her words, photos or pins either.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-delete-scrubs-posts.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Scrub-Main-Pw-4471!';
const PW_STANDBY = 'Scrub-Standby-Pw-8830!';

/** Words and places Rhea's posts use, found nowhere else. None may be read after she deletes her account. */
const WORDS = {
    upTitle: 'Quorvex lantern', upText: 'Brindlewick shade, hand blown',
    soldTitle: 'Zelkovan honey', soldText: 'Marmalith comb from the ridge',
    downTitle: 'Tavirush bicycle', downText: 'Pellucine frame, needs a chain',
    ruledTitle: 'Wexmoorian jam', ruledText: 'Oxbalm plums, six jars',
    eventTitle: 'Oskaloo picnic', eventText: 'Fennimore lawn games', eventPlace: 'Glimmerhook Hall', eventNote: 'Doorcode Xanthrip',
};
/** The pins, each to four places (a listing's pin, about 11 metres): a JSON body carries them as written. */
const PINS = { up: [-28.6432, 153.6198], sold: [-28.6543, 153.6287], down: [-28.6654, 153.6376], ruled: [-28.6765, 153.6465], event: [-28.6876, 153.6554] };
/** The poll's question stays after she deletes: a closed poll is the community's record. */
const POLL_QUESTION = 'Quibblefen question: which day suits the market?';
const CALLSIGN = 'Rheanwyn';
const TITLE_WORDS = ['Quorvex', 'Brindlewick', 'Zelkovan', 'Marmalith', 'Tavirush', 'Pellucine', 'Wexmoorian', 'Oxbalm', 'Oskaloo', 'Fennimore', 'Glimmerhook', 'Xanthrip'];
const DELETED_POST_TITLE = 'Deleted post';

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
        /** Anyone who isn't a member reads the listings, as on the global node (G9a): the guest's view, to check it too. */
        'guest-view': async () => {
            const { setSwitchOverride } = await import('./config/node-profile.js');
            setSwitchOverride('guestListingsOnly', true);
            return true;
        },
        /** The rows a standby must hold as this server does: the posts, their photos, the replies, the chats. */
        rows: async () => {
            const { db } = await import('./db/db.js');
            return {
                posts: (db.prepare('SELECT * FROM posts ORDER BY id').all() as Record<string, unknown>[]).map((r) => {
                    // Dormant: nothing reads or writes them (engine/replication-manifest.ts).
                    const { target_archetypes: _a, event_conversation_id: _e, ...rest } = r;
                    return rest;
                }),
                post_photos: db.prepare('SELECT post_id, order_num, updated_at FROM post_photos ORDER BY post_id, order_num').all(),
                event_rsvps: db.prepare('SELECT post_id, member_pubkey, status, updated_at FROM event_rsvps ORDER BY post_id, member_pubkey').all(),
                conversations: db.prepare('SELECT id, type, post_id, name, created_by, created_at FROM conversations ORDER BY id').all(),
            };
        },
        /** Rhea's posts, the objects of their photos, and the tombstones written for them. */
        posts: async (a: { ids: string[] }) => {
            const { db } = await import('./db/db.js');
            const { getImageStore } = await import('./storage/image-store.js');
            const store = getImageStore();
            return a.ids.map((id) => ({
                row: db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Record<string, any> | undefined,
                photos: (db.prepare('SELECT COUNT(*) AS n FROM post_photos WHERE post_id = ?').get(id) as { n: number }).n,
                objects: store.list(`posts/${id}/`).length,
                photoTombstones: (db.prepare(`SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'post_photos' AND row_key LIKE ?`).get(`${id}|%`) as { n: number }).n,
                rsvps: (db.prepare('SELECT COUNT(*) AS n FROM event_rsvps WHERE post_id = ?').get(id) as { n: number }).n,
                rsvpTombstones: (db.prepare(`SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'event_rsvps' AND row_key LIKE ?`).get(`${id}|%`) as { n: number }).n,
                chat: (db.prepare('SELECT name FROM conversations WHERE id = ?').get(id) as { name: string | null } | undefined)?.name ?? null,
                votes: (db.prepare('SELECT COUNT(*) AS n FROM poll_votes WHERE post_id = ?').get(id) as { n: number }).n,
            }));
        },
        /** What the search index holds: matches for each word, blocks of the index holding it, and FTS5's own check. */
        'search-index': async (a: { words: string[] }) => {
            const { db } = await import('./db/db.js');
            const matches: Record<string, number> = {};
            const bytes: Record<string, number> = {};
            for (const w of a.words) {
                matches[w] = (db.prepare('SELECT COUNT(*) AS n FROM posts_fts WHERE posts_fts MATCH ?').get(`"${w.toLowerCase()}"`) as { n: number }).n;
                // FTS5 stores a term whole where it starts a leaf and shares a prefix with the term before it otherwise: the
                // word without its first letter is in the index's bytes either way.
                bytes[w] = (db.prepare('SELECT COUNT(*) AS n FROM posts_fts_data WHERE instr(block, CAST(? AS BLOB)) > 0').get(w.toLowerCase().slice(1)) as { n: number }).n;
            }
            let integrity = 'ok';
            try { db.prepare(`INSERT INTO posts_fts(posts_fts) VALUES('integrity-check')`).run(); } catch (e: any) { integrity = e?.message || String(e); }
            const neutral = (db.prepare('SELECT COUNT(*) AS n FROM posts_fts WHERE posts_fts MATCH ?').get('"deleted post"') as { n: number }).n;
            return { matches, bytes, integrity, neutral };
        },
        /** The deals and ledger rows that name the posts, and whether each still finds its post. */
        trades: async (a: { ids: string[] }) => {
            const { db } = await import('./db/db.js');
            const ph = a.ids.map(() => '?').join(',');
            return {
                deals: db.prepare(`SELECT mt.id, mt.post_id, mt.status, p.id AS found FROM marketplace_transactions mt LEFT JOIN posts p ON p.id = mt.post_id
                                   WHERE mt.post_id IN (${ph}) ORDER BY mt.id`).all(...a.ids),
                ledger: db.prepare(`SELECT id, from_pubkey, to_pubkey, amount, memo FROM transactions ORDER BY id`).all(),
            };
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

interface Answer { status: number; body: any; text: string }

/** A call to a node's real HTTPS server, signed by `as`, with the admin password in `admin`, or neither, and any `headers`. */
async function api(base: string, method: 'GET' | 'POST', route: string, opts: { as?: Id; admin?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
    const raw = method === 'GET' ? '' : JSON.stringify(opts.body ?? {});
    const headers: Record<string, string> = { ...opts.headers };
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
    return { status: res.status, body, text };
}

const brief = (a: Answer) => `${a.status} ${a.text.slice(0, 160)}`;
function built(what: string, a: Answer): any {
    require_(a.status >= 200 && a.status < 300, `M: ${what} (${brief(a)})`);
    return a.body;
}
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const EPOCH = encodeURIComponent('1970-01-01T00:00:00.000Z');

type Rows = { posts: any[]; post_photos: any[]; event_rsvps: any[]; conversations: any[] };
const TABLE_KEYS: Record<keyof Rows, string[]> = {
    posts: ['id'], post_photos: ['post_id', 'order_num'], event_rsvps: ['post_id', 'member_pubkey'], conversations: ['id'],
};

/** Where S's rows differ from M's: each table row for row and column for column. */
function rowsDiff(m: Rows, s: Rows): string[] {
    const out: string[] = [];
    for (const [table, key] of Object.entries(TABLE_KEYS) as [keyof Rows, string[]][]) {
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

/** What a body gives away of Rhea's posts: any of their words, a link to one of their photos, one of their pins. */
function leaks(text: string, ids: string[]): string[] {
    const found: string[] = [];
    const lower = text.toLowerCase();
    for (const w of TITLE_WORDS) if (lower.includes(w.toLowerCase())) found.push(w);
    for (const id of ids) if (text.includes(`/api/marketplace/posts/${id}/photos/`)) found.push(`photo of ${id.slice(0, 8)}`);
    for (const [name, [lat, lng]] of Object.entries(PINS)) if (text.includes(String(lat)) || text.includes(String(lng))) found.push(`pin ${name}`);
    return found;
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const gwen = newId('Gwen');
    const rhea = newId(CALLSIGN);
    const bo = newId('Bo');
    const cy = newId('Cy');
    const refused: string[] = [];

    try {
        // ── 1. M ──
        console.log('\n— 1. the main server: Rhea\'s posts, in every state —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        const A = (route: string, body: unknown = {}) => api(m, 'POST', route, { admin: PW_MAIN, body });
        const S_ = (who: Id, route: string, body: unknown = {}) => api(m, 'POST', route, { as: who, body });
        built('Gwen sets a profile photo', await S_(gwen, '/api/profile/update', { avatar: TINY_PNG }));
        for (const who of [rhea, bo, cy]) {
            const inv = built(`Gwen makes an invite for ${who.name}`, await S_(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
            built(`${who.name} joins with it`, await api(m, 'POST', '/api/invite/redeem', { body: { code: inv.invite?.code ?? inv.code, publicKey: who.pk, callsign: who.name } }));
            built(`${who.name} sets a profile photo`, await S_(who, '/api/profile/update', { avatar: TINY_PNG }));
        }
        built('the admin makes Bo an Elder (a credit line to buy with)', await A(`/api/local/admin/users/${bo.pk}/elder`, { grant: true }));
        const offer = async (who: Id, title: string, description: string, pin: number[] | null, photos: string[]) => built(`${who.name} offers ${title}`, await S_(who, '/api/marketplace/posts', {
            type: 'offer', category: 'food', title, description, credits: 3, priceType: 'fixed', authorPublicKey: who.pk,
            ...(pin ? { lat: pin[0], lng: pin[1] } : {}), photos,
        })).post;
        await offer(bo, 'Plain seedlings', 'Tomato seedlings', null, [TINY_PNG]); // a buyer lists an offer first (the offer covenant)
        const up = await offer(rhea, WORDS.upTitle, WORDS.upText, PINS.up, [TINY_PNG, TINY_PNG]);
        const sold = await offer(rhea, WORDS.soldTitle, WORDS.soldText, PINS.sold, [TINY_PNG]);
        const down = await offer(rhea, WORDS.downTitle, WORDS.downText, PINS.down, [TINY_PNG]);
        const ruled = await offer(rhea, WORDS.ruledTitle, WORDS.ruledText, PINS.ruled, [TINY_PNG]);
        const deal = async (postId: string, finish: boolean) => {
            const tx = built('Bo asks for Rhea\'s listing', await S_(bo, '/api/marketplace/posts/request', { postId, buyerPublicKey: bo.pk })).transaction;
            built('Rhea approves: the Beans are held', await S_(rhea, '/api/marketplace/transactions/approve', { transactionId: tx.id, authorPublicKey: rhea.pk }));
            if (finish) built('Bo confirms: the Beans are released', await S_(bo, '/api/marketplace/transactions/complete', { transactionId: tx.id, confirmerPublicKey: bo.pk }));
            return tx.id as string;
        };
        const soldDeal = await deal(sold.id, true);
        const ruledDeal = await deal(ruled.id, false);
        built('the admin rules on the deal still held', await A(`/api/local/admin/disputes/${ruledDeal}/resolve`, { action: 'release_to_seller', reason: 'It was delivered' }));
        built('Rhea takes one listing down herself', await S_(rhea, '/api/marketplace/posts/remove', { id: down.id, authorPublicKey: rhea.pk }));
        const startAt = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
        const event = built('Rhea hosts an event', await S_(rhea, '/api/marketplace/posts', {
            type: 'event', title: WORDS.eventTitle, description: WORDS.eventText, authorPublicKey: rhea.pk,
            lat: PINS.event[0], lng: PINS.event[1], eventStartAt: startAt, eventPlaceName: WORDS.eventPlace, eventPrivateNote: WORDS.eventNote,
            photos: [TINY_PNG],
        })).post;
        built('Bo is going', await S_(bo, `/api/marketplace/posts/${event.id}/rsvp`, { status: 'going' }));
        const poll = built('Rhea asks a poll', await S_(rhea, '/api/marketplace/posts', {
            type: 'poll', category: 'general', title: POLL_QUESTION, description: 'Pick one', authorPublicKey: rhea.pk,
            pollOptions: [{ id: 'sat', text: 'Saturday' }, { id: 'sun', text: 'Sunday' }], durationDays: 7,
        })).post;
        built('Bo votes in it', await S_(bo, `/api/marketplace/posts/${poll.id}/vote`, { optionId: 'sat' }));
        built('Cy reports the listing that is up', await S_(cy, '/api/reports', { reporterPubkey: cy.pk, targetPubkey: rhea.pk, targetPostId: up.id, reason: 'Testing the report view' }));
        built('the admin adds a pricing guide item', await A('/api/pricing-guide/admin/item', { category: 'food', emoji: '🏮', name: 'Lantern', priceBeans: 3 }));
        built('the pricing guide runs', await A('/api/pricing-guide/admin/aggregate'));
        const wiped = [up.id, sold.id, down.id, ruled.id, event.id];
        const guide0 = await api(m, 'GET', '/api/pricing-guide', { as: cy });
        require_(guide0.text.includes(`/api/marketplace/posts/${up.id}/photos/0`), 'M: the pricing guide takes its picture from Rhea\'s listing');
        await main.send('guest-view');

        /** Every route that can show a post, read as Bo, Cy, a guest and the admin, and the replication export. */
        const sweep = async (base: string, adminPw: string): Promise<{ route: string; status: number; leaked: string[] }[]> => {
            const reads: [string, Promise<Answer>][] = [];
            const get = (label: string, route: string, as?: Id) => reads.push([label, api(base, 'GET', route, as ? { as } : {})]);
            for (const [who, as] of [['Bo', bo], ['Cy', cy], ['a guest', undefined]] as [string, Id | undefined][]) {
                get(`${who}: the board`, '/api/marketplace/posts', as);
                get(`${who}: a phone's full sync`, `/api/marketplace/posts?sync=true&updatedAfter=${EPOCH}`, as);
                get(`${who}: a phone's full sync of events`, `/api/marketplace/posts?type=event&sync=true&updatedAfter=${EPOCH}`, as);
                get(`${who}: Rhea's posts`, `/api/marketplace/posts?author=${rhea.pk}`, as);
                for (const w of ['Quorvex', 'Zelkovan', 'Oskaloo', 'Glimmerhook', 'deleted']) get(`${who}: search ${w}`, `/api/marketplace/posts?q=${w}`, as);
                for (const id of wiped) get(`${who}: post ${id.slice(0, 8)} by id`, `/api/marketplace/posts?id=${id}`, as);
            }
            for (const [who, as] of [['Bo', bo], ['Cy', cy]] as [string, Id][]) {
                get(`${who}: deals`, `/api/marketplace/transactions?publicKey=${as.pk}`, as);
                get(`${who}: chats`, `/api/messages/conversations/${as.pk}`, as);
                get(`${who}: the event's chat`, `/api/marketplace/posts/${event.id}/chat`, as);
                get(`${who}: my events`, '/api/events/mine', as);
                get(`${who}: the activity feed`, '/api/activity/feed', as);
                get(`${who}: the pricing guide`, '/api/pricing-guide', as);
                get(`${who}: the ledger`, `/api/ledger/transactions?publicKey=${as.pk}`, as);
                get(`${who}: Rhea's profile`, `/api/profile/${rhea.pk}`, as);
            }
            reads.push(['admin: the manager\'s data', api(base, 'POST', '/api/local/admin/data', { admin: adminPw })]);
            reads.push(['admin: reports', api(base, 'GET', '/api/local/admin/reports', { admin: adminPw })]);
            reads.push(['admin: disputes', api(base, 'GET', '/api/local/admin/disputes', { admin: adminPw })]);
            reads.push(['admin: logs', api(base, 'POST', '/api/local/admin/logs', { admin: adminPw, body: { limit: 500 } })]);
            reads.push(['the replication export', api(base, 'GET', '/api/local/admin/sync-snapshot', { headers: { 'X-Replication-Token': replicationToken } })]);
            const out = [];
            for (const [route, p] of reads) {
                const a = await p;
                out.push({ route, status: a.status, leaked: leaks(a.text, wiped) });
            }
            return out;
        };
        const before = await sweep(m, PW_MAIN);
        const shownBefore = before.filter((r) => r.leaked.length > 0);
        const showed = (route: string, what: string) => shownBefore.some((r) => r.route === route && r.leaked.includes(what));
        require_(showed('a guest: the board', 'Quorvex') && showed('Bo: a phone\'s full sync', 'Tavirush') && showed('Bo: a phone\'s full sync', 'pin down')
            && showed('Bo: chats', 'Oskaloo') && showed('Bo: the activity feed', 'Zelkovan') && showed('Cy: the pricing guide', `photo of ${up.id.slice(0, 8)}`)
            && showed('admin: reports', 'Quorvex') && showed('the replication export', 'Xanthrip'),
            `before she deletes, the routes show her posts: ${shownBefore.length} of ${before.length} reads (${shownBefore.map((r) => `${r.route}: ${r.leaked.join('/')}`).join('; ')}; `
            + `none from ${before.filter((r) => r.leaked.length === 0).map((r) => `${r.route} ${r.status}`).join(', ')})`);
        const photoRoute = (base: string, id: string, n: number, as: Id) => api(base, 'GET', `/api/marketplace/posts/${id}/photos/${n}`, { as });
        require_((await photoRoute(m, up.id, 1, cy)).status === 200, 'M: her listing\'s second photo is served');
        const m1 = await main.send('posts', { ids: [...wiped, poll.id] });
        require_(m1[0].objects === 2 && m1[4].objects === 1 && m1[4].rsvps === 1 && m1[4].chat === WORDS.eventTitle,
            `M: the photos are in the image store, Bo is going, the event's chat bears its title (${JSON.stringify(m1.map((p: any) => [p.objects, p.rsvps, p.chat]))})`);
        const index1 = await main.send('search-index', { words: TITLE_WORDS });
        require_(index1.matches.Quorvex === 1 && index1.bytes.Quorvex > 0, `M: search finds her words (${JSON.stringify(index1.matches)})`);
        const ledgerBefore = (await main.send('trades', { ids: wiped })).ledger;

        // ── 2. S's first copy ──
        console.log('\n— 2. the standby copies M —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const firstPull = await standby.send('pull', {});
        require_(firstPull.ok === true, `S: the first pull lands (${firstPull.ok ? firstPull.mode : firstPull.error})`);
        const s1 = await standby.send('posts', { ids: wiped });
        const sIndex1 = await standby.send('search-index', { words: TITLE_WORDS });
        require_(s1[0].objects === 2 && s1[0].row?.title === WORDS.upTitle && sIndex1.matches.Quorvex === 1,
            `S: holds her words and photos too (${s1[0].objects} objects; ${s1[0].row?.title})`);

        // ── 3. She deletes ──
        console.log('\n— 3. Rhea deletes her account —');
        const purged = await S_(rhea, '/api/member/purge');
        require_(purged.status === 200 && purged.body?.ok === true, `her Delete account succeeds (${brief(purged)})`);
        const m3 = await main.send('posts', { ids: [...wiped, poll.id] });
        const rowsOf = (ps: any[]) => ps.slice(0, wiped.length);
        assert(rowsOf(m3).every((p: any) => p.row && p.row.title === DELETED_POST_TITLE && p.row.description === ''),
            `every post of hers but the poll keeps its row and is called "${DELETED_POST_TITLE}", with no description (${JSON.stringify(rowsOf(m3).map((p: any) => p.row?.title))})`);
        assert(rowsOf(m3).every((p: any) => p.row.lat === null && p.row.lng === null && p.row.event_place_name === null && p.row.event_private_note === null),
            'none has a pin, a place name or a note for the people going');
        assert(rowsOf(m3).every((p: any) => p.photos === 0 && p.objects === 0),
            `none has a photo, in the database or the image store (${JSON.stringify(rowsOf(m3).map((p: any) => [p.photos, p.objects]))})`);
        assert(rowsOf(m3).map((p: any) => p.photoTombstones).join() === '2,1,1,1,1',
            `a tombstone for each photo slot, so a standby deletes them too (${rowsOf(m3).map((p: any) => p.photoTombstones).join()})`);
        const statuses = rowsOf(m3).map((p: any) => p.row.status);
        assert(statuses[0] === 'cancelled' && statuses[2] === 'cancelled' && statuses[4] === 'cancelled'
            && JSON.stringify([statuses[1], statuses[3]]) === JSON.stringify([m1[1].row.status, m1[3].row.status]) && statuses.every((st: string) => st === 'cancelled' || st === 'completed'),
            `the one that was up and the event are cancelled, the two whose deals are done keep their status (${statuses.join(', ')})`);
        assert(m3[4].rsvps === 1 && m3[4].rsvpTombstones === 0 && m3[4].chat === DELETED_POST_TITLE,
            `the event: Bo's reply stays until the 30-day scrub, and its chat is called "${DELETED_POST_TITLE}" (${m3[4].rsvps}; ${m3[4].rsvpTombstones}; ${m3[4].chat})`);
        const chat = await api(m, 'GET', `/api/marketplace/posts/${event.id}/chat`, { as: bo });
        assert(chat.status === 200 && chat.body?.readOnly === true && chat.body?.title === DELETED_POST_TITLE && chat.body?.privateNote === null,
            `Bo, going, still reads the event's chat, read-only, under the neutral title and with no note (${brief(chat)})`);
        const pollAfter = m3[wiped.length];
        assert(pollAfter.row.title === POLL_QUESTION && pollAfter.row.description === 'Pick one' && pollAfter.row.status === 'completed'
            && pollAfter.votes === 1 && pollAfter.row.poll_options === m1[wiped.length].row.poll_options,
            `the poll is closed and keeps its question, options and vote (${pollAfter.row.status}; ${pollAfter.votes} vote)`);
        const trades = await main.send('trades', { ids: wiped });
        assert(trades.deals.length === 2 && trades.deals.every((d: any) => d.found === d.post_id && d.status === 'completed'),
            `the two deals still find their listings (${JSON.stringify(trades.deals.map((d: any) => [d.status, !!d.found]))})`);
        const ledgerNow = new Map((trades.ledger as any[]).map((r) => [r.id, JSON.stringify(r)]));
        assert((ledgerBefore as any[]).every((r) => ledgerNow.get(r.id) === JSON.stringify(r)),
            `every ledger row from before is as it was, her deals' among them (${ledgerBefore.length} before, ${trades.ledger.length} now: her balance's settlement added)`);
        const boDeals = await api(m, 'GET', `/api/marketplace/transactions?publicKey=${bo.pk}`, { as: bo });
        const boList = Array.isArray(boDeals.body) ? boDeals.body : boDeals.body?.transactions ?? [];
        assert(boDeals.status === 200 && [soldDeal, ruledDeal].every((t) => boList.some((d: any) => d.id === t && d.postTitle === DELETED_POST_TITLE)),
            `Bo's deals are still listed, under "${DELETED_POST_TITLE}" (${boDeals.status}; ${boList.map((d: any) => d.postTitle).join(', ')})`);
        const index3 = await main.send('search-index', { words: TITLE_WORDS });
        assert(Object.values(index3.matches).every((n) => n === 0), `search finds none of her words (${JSON.stringify(index3.matches)})`);
        assert(index3.integrity === 'ok', `the search index is sound, the cancel and the wipe in one millisecond included (${index3.integrity})`);
        assert(Object.values(index3.bytes).every((n) => n === 0), `and holds none of her words in its bytes (${JSON.stringify(index3.bytes)})`);
        assert(index3.neutral === wiped.length, `it finds her wiped posts under the neutral words, once each (${index3.neutral})`);
        const after = await sweep(m, PW_MAIN);
        const leaked = after.filter((r) => r.leaked.length > 0);
        assert(leaked.length === 0, `no route read by Bo, Cy, a guest or the admin, nor the replication export, returns her words, photos or pins (${after.length} reads; ${leaked.map((r) => `${r.route}: ${r.leaked.join('/')}`).join('; ') || 'none'})`);
        assert(after.filter((r) => r.status >= 400).length <= before.filter((r) => r.status >= 400).length,
            `and no read that answered before refuses now (${after.filter((r) => r.status >= 400).map((r) => `${r.route} ${r.status}`).join(', ') || 'none'})`);
        const photo404 = await Promise.all(wiped.map((id) => photoRoute(m, id, 0, cy)));
        assert(photo404.every((a) => a.status === 404) && (await photoRoute(m, up.id, 1, cy)).status === 404,
            `every photo link of hers is a 404 (${photo404.map((a) => a.status).join(', ')})`);
        const feed = await api(m, 'GET', '/api/activity/feed', { as: bo });
        const named = feed.text.indexOf(CALLSIGN);
        assert(feed.status === 200 && named < 0 && feed.text.includes(DELETED_POST_TITLE),
            `the activity feed names her posts "${DELETED_POST_TITLE}", and her nowhere (${feed.status}; ${named < 0 ? 'no name' : feed.text.slice(Math.max(0, named - 300), named + 40)})`);
        const pollRead = await api(m, 'GET', `/api/marketplace/posts?sync=true&updatedAfter=${EPOCH}`, { as: bo });
        assert(pollRead.text.includes('Quibblefen'), 'a phone\'s sync still carries the poll with its question');

        // ── 4. S's next pull, a restart, a whole copy ──
        console.log('\n— 4. the standby follows —');
        const delta = await standby.send('pull', {});
        assert(delta.ok === true && delta.mode === 'delta', `S: the next pull is a delta and lands (${delta.ok ? delta.mode : delta.error})`);
        const mRows: Rows = await main.send('rows');
        let sRows: Rows = await standby.send('rows');
        assert(rowsDiff(mRows, sRows).length === 0, `S's posts, photos, replies and chats are M's, every column and stamp (differences ${first(rowsDiff(mRows, sRows))})`);
        const s4 = await standby.send('posts', { ids: wiped });
        assert(s4.every((p: any) => p.photos === 0 && p.objects === 0), `S deletes its photo objects too (${JSON.stringify(s4.map((p: any) => p.objects))})`);
        const sIndex4 = await standby.send('search-index', { words: TITLE_WORDS });
        assert(Object.values(sIndex4.matches).every((n) => n === 0) && sIndex4.integrity === 'ok' && Object.values(sIndex4.bytes).every((n) => n === 0),
            `S's search index finds none of her words, is sound, and holds none in its bytes (${JSON.stringify(sIndex4.matches)}; ${sIndex4.integrity}; ${JSON.stringify(sIndex4.bytes)})`);
        await standby.send('checkpoint');
        refused.push(...(await standby.send('fetches')).blocked);
        await standby.kill('SIGTERM');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        sRows = await standby.send('rows');
        assert(rowsDiff(mRows, sRows).length === 0, `after a restart, still M's, stamps included (differences ${first(rowsDiff(mRows, sRows))})`);
        const again = await standby.send('pull', {});
        sRows = await standby.send('rows');
        assert(again.ok === true && rowsDiff(await main.send('rows'), sRows).length === 0,
            `and after the pull that follows (${again.ok ? again.mode : again.error}; differences ${first(rowsDiff(await main.send('rows'), sRows))})`);
        const whole = await standby.send('pull', { whole: true });
        sRows = await standby.send('rows');
        const sIndex5 = await standby.send('search-index', { words: TITLE_WORDS });
        assert(whole.ok === true && whole.whole === true && rowsDiff(await main.send('rows'), sRows).length === 0 && Object.values(sIndex5.matches).every((n) => n === 0),
            `and after a whole copy (${whole.ok ? whole.mode : whole.error}; differences ${first(rowsDiff(await main.send('rows'), sRows))})`);

        // ── 5. The take-over ──
        console.log('\n— 5. M dies; S takes over with the recovery code —');
        const last = await standby.send('pull', {});
        require_(last.ok === true && last.envelope !== undefined, `S: a last pull, and the take-over envelope (${last.ok ? last.mode : last.error})`);
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
        require_(standby.ready.role === 'primary', `promoted (${standby.ready.role})`);
        const p = `https://localhost:${await standby.send('serve')}`;
        await standby.send('guest-view');
        const promoted = await sweep(p, PW_STANDBY);
        const leakedP = promoted.filter((r) => r.leaked.length > 0);
        assert(leakedP.length === 0, `on the promoted server no route returns her words, photos or pins either (${promoted.length} reads; ${leakedP.map((r) => `${r.route}: ${r.leaked.join('/')}`).join('; ') || 'none'})`);
        const photoP = await Promise.all(wiped.map((id) => photoRoute(p, id, 0, cy)));
        assert(photoP.every((a) => a.status === 404), `and every photo link of hers is a 404 there (${photoP.map((a) => a.status).join(', ')})`);
        refused.push(...(await standby.send('fetches')).blocked);
        assert(refused.length === 0, `nothing reached off this machine (refused: ${refused.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ Delete account wipes the words, photos and places of the member\'s posts, on the main server, its standby and after a take-over.');
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
