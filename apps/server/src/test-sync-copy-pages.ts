/**
 * Test Suite: the main server serves a copy in pages from one snapshot (P1 of scratch/global-node/DESIGN-paged-copies-fable.md,
 * §3, §5 and §8's P1 row).
 *
 * A main server M, its own process with its own data dir (takeover-test-harness.ts), serving its real HTTPS server (members
 * act through it with signed requests) and its real backup routes; the suite asks for copies as a standby would, with the
 * replication token, and checks every page's signature as the importer checks a payload's. M's page bounds are scaled to
 * 64 KB and 200 rows (SYNC_PAGE_BYTES, SYNC_PAGE_ROWS), so a small community takes many pages; the size run at the end uses
 * the real 8 MB and 25,000. Bulk rows are written on M behind the routes, to stay fast. Nothing leaves this machine.
 *
 *  1. M: members, listings, a photo, a DM, deals (Beans in the ledger), an invite, a group, and bulk chat, members and
 *     listings. The old routes still answer, signed. A whole copy in pages carries exactly what today's whole payload
 *     carries, category by category and table by table, with the same listing hash, pot, keepers and table hashes.
 *  2. A whole copy's pages under writes on M between pages (chat lines, members, a deal completed through the routes, a
 *     message deleted): every page is the snapshot's. Its counts are the opening page's, its table hashes are M's at the
 *     open, not M's now, its accounts are the ledger at the open, and nothing written after the open is in it (the deleted
 *     line is, its tombstone isn't). The delta copy from its cursor carries every one of those writes, and the ledger now.
 *  3. A delta copy whose rows share one watermark across many pages carries each row once, and exactly the rows at or after
 *     its cursor.
 *  4. Rows bigger than a page (a 150 KB line, a 100 KB avatar): no page splits a row, a page over the byte bound holds that
 *     one row alone, every page holds at least one row, and each big row arrives whole.
 *  5. One copy at a time (a second open is 409 busy), pages in order (a page skipped or asked again after the next is 409),
 *     a retry of the last page gets the same bytes, an unknown copy is 404, and every copy route wants the replication
 *     token or the admin password (401).
 *  6. A page's signature covers its copy id and number: one with either changed doesn't verify, and a page of another copy
 *     verifies but names that copy.
 *  7. Expiry: a copy no page is asked of closes, and the WAL it held truncates after (it could not while the copy was open);
 *     a copy open too long closes whatever is asked of it.
 *  8. The recovery seal's VACUUM succeeds with a copy open: the copy closes first (404 after), and the WAL empties. So do
 *     the operator's Clean storage and the image evacuation's reclaim (a truncating checkpoint, a VACUUM): each closes the
 *     copy first, never waits out the busy timeout on it with the event loop held, and leaves the WAL empty.
 *  9. After M restarts, the copy it was serving is 404, and a new one opens.
 * 10. The size run, at the real bounds: a community of 40,000 members, 80,000 chat lines and 40,000 trades. Each page within
 *     its bounds, and M's event loop never blocked a second by any page; today's whole payload of the same community, for
 *     comparison.
 * 11. Wide rows under the deployed heap: M restarted with `--max-old-space-size=512` (docker-compose.yml runs the main
 *     server so), 6,000 more members each carrying a 70,000-character photo inline (the app's 512 px JPEG): a whole copy
 *     of it all completes, M's resident memory stays bounded, and neither the open nor any page holds the event loop long.
 *     With slices sized in rows (1,000 a page slice, 5,000 a hash slice) M ran out of heap here.
 * 12. Wide chat lines under the same heap: 1,200 more chat lines of 500 KB each (600 MB). A whole copy of it all completes,
 *     every row carried and each wide line whole, each page within 8 MB and 25,000 rows, M's heap and event loop bounded.
 *     Step 11's members come first in the table hashes' order and so load the hash slices; these lines load the page
 *     slices: with page slices ended by rows alone (1,000 a slice, 500 MB of these lines) M ran out of heap here.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-sync-copy-pages.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { spawnNode, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';
import { lockedDm } from './dm-test-payload.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the node's own self-signed certificate

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Copy-Pages-Main-Pw-5521!';
/** M's page bounds, scaled down from 8 MB and 25,000 rows. */
const PAGE_BYTES = 64 * 1024;
const PAGE_ROWS = 200;
/**
 * Step 11's bounds, M at a 512 MB heap serving pages of 8 MB. Its event loop held by the open or any page at most as long
 * as step 10 allows (measured 30 to 130 ms here, the design's 70 to 260 ms a page; a loaded machine has shown 500). Its heap
 * in use and its resident memory's growth at most these: a page holds a page of rows, its JSON and its text (measured
 * 150 to 195 MB of heap, 100 to 210 MB of growth); with slices sized in rows it held 390 MB of heap or ran out.
 */
const WIDE_LAG_MS = 1000;
const WIDE_HEAP_BYTES = 320 * 1024 * 1024;
const WIDE_RSS_GROWTH = 320 * 1024 * 1024;
/**
 * Step 12's chat lines: this many, each this many characters of ciphertext, more than a 512 MB heap holds at once. Held to
 * step 11's bounds (measured 210 to 260 MB of heap, 80 to 160 ms of the loop a page); read 1,000 to a slice, M ran out of heap.
 */
const WIDE_LINES = 1200;
const WIDE_LINE_BYTES = 500_000;

// ── The node process's commands ────────────────────────────────────────────────────────────

/** No node reaches anything but this machine (a push to Expo, the update check's ask of GitHub, are answered here). */
function guardFetch(): { blocked: string[] } {
    const seen = { blocked: [] as string[] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.hostname === 'api.github.com') return new Response('{}', { status: 404 });
        seen.blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return seen;
}

async function child(): Promise<void> {
    const fetches = guardFetch();
    const { monitorEventLoopDelay } = await import('node:perf_hooks');
    const lag = monitorEventLoopDelay({ resolution: 5 });
    lag.enable();
    // The most memory this process held since the last reset, sampled every 5 ms (a page's rows live for a few ms).
    let peakRss = 0;
    let peakHeap = 0;
    const sample = () => {
        const u = process.memoryUsage();
        peakRss = Math.max(peakRss, u.rss);
        peakHeap = Math.max(peakHeap, u.heapUsed);
    };
    setInterval(sample, 5).unref();
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; genesis: string }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            seedGenesisMember(a.genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            return true;
        },
        /** Whether copies take the replication token only, as the operator sets it in Settings. */
        'token-only': async (a: { on: boolean }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            updateLocalConfig({ replicationTokenOnly: a.on });
            return true;
        },
        /** This process's environment, live (the copy reads its bounds and times at each open); '' removes one. */
        'set-env': async (a: { vars: Record<string, string> }) => {
            for (const [k, v] of Object.entries(a.vars)) {
                if (v === '') delete process.env[k];
                else process.env[k] = v;
            }
            return true;
        },
        /** This server's table hashes and listing hash, read now, as a whole copy's would be. */
        state: async () => {
            const { tableContentHashes } = await import('./engine/replica-hashes.js');
            const { getStateHash } = await import('./state-engine.js');
            return { hashes: tableContentHashes(), stateHash: getStateHash() };
        },
        rows: async (a: { sql: string; args?: unknown[] }) => {
            const { db } = await import('./db/db.js');
            return db.prepare(a.sql).all(...(a.args ?? []));
        },
        sql: async (a: { sql: string; args?: unknown[] }) => {
            const { db } = await import('./db/db.js');
            return db.prepare(a.sql).run(...(a.args ?? [])).changes;
        },
        /**
         * `n` rows written in one go behind the routes, each a new key starting `<prefix>-`: chat lines (`bytes` of
         * ciphertext each), visitors' member rows (an avatar of `bytes`), listings, or trades between two keys. `stamp`: one
         * watermark for them all. The keys, when `ids`.
         */
        flood: async (a: {
            kind: 'messages' | 'members' | 'posts' | 'transactions'; n: number; prefix: string; conversationId?: string; author?: string;
            to?: string; stamp?: string; bytes?: number; ids?: boolean;
        }) => {
            const { db } = await import('./db/db.js');
            const now = () => a.stamp ?? new Date().toISOString();
            const ids: string[] = [];
            const line = db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp, updated_at) VALUES (?, ?, ?, ?, ?, 'text', ?, ?)`);
            const member = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_visitor, avatar_url, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)`);
            const post = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at) VALUES (?, 'offer', 'food', ?, 'a flood', 1, ?, ?, ?)`);
            const trade = db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?, ?, ?, 0.01, 'a flood', ?)`);
            db.transaction(() => {
                for (let i = 0; i < a.n; i++) {
                    const u = crypto.randomUUID();
                    const id = `${a.prefix}-${u}`;
                    ids.push(id);
                    if (a.kind === 'messages') {
                        line.run(id, a.conversationId, a.author, crypto.randomBytes(Math.ceil((a.bytes ?? 160) * 3 / 4)).toString('base64').slice(0, a.bytes ?? 160),
                            crypto.randomBytes(24).toString('base64'), now(), now());
                    } else if (a.kind === 'members') {
                        const avatar = a.bytes ? `data:image/png;base64,${crypto.randomBytes(Math.ceil(a.bytes * 3 / 4)).toString('base64').slice(0, a.bytes)}` : null;
                        member.run(id, `v-${u.slice(0, 18)}`, now(), avatar, now());
                    } else if (a.kind === 'posts') {
                        post.run(id, `Flood ${i}`, a.author, now(), now());
                    } else {
                        trade.run(id, a.author, a.to, now());
                    }
                }
            })();
            return a.ids ? ids : ids.length;
        },
        /** A chat line deleted on this server, with its tombstone, as the event scrub deletes one (db/db.ts writeTombstone). */
        'delete-message': async (a: { id: string }) => {
            const { db, writeTombstone } = await import('./db/db.js');
            db.prepare('DELETE FROM messages WHERE id = ?').run(a.id);
            writeTombstone('messages', a.id);
            return true;
        },
        /** The recovery seal's one VACUUM and its checkpoint, as the seal runs them (services/recovery-seal-key.ts). */
        vacuum: async () => {
            const { vacuumAndCheckpoint } = await import('./services/recovery-seal-key.js');
            try {
                return { ok: true, ...vacuumAndCheckpoint() };
            } catch (e: any) {
                return { ok: false, error: e?.message || String(e) };
            }
        },
        /** The database's write-ahead log, in bytes. */
        wal: async () => {
            const file = path.join(process.env.BEANPOOL_DATA_DIR!, 'state.db-wal');
            return fs.existsSync(file) ? fs.statSync(file).size : 0;
        },
        'lag-reset': async () => { lag.reset(); return true; },
        /** The longest this process's event loop was blocked since the last reset, in ms, and its resident memory. */
        'lag-read': async () => ({ maxMs: lag.max / 1e6, rss: process.memoryUsage().rss }),
        'peak-reset': async () => { peakRss = 0; peakHeap = 0; sample(); return true; },
        /** The most resident memory and V8 heap in use since the last peak-reset, and the heap's limit. */
        'peak-read': async () => {
            sample();
            const { getHeapStatistics } = await import('node:v8');
            return { rss: peakRss, heap: peakHeap, heapLimit: getHeapStatistics().heap_size_limit };
        },
        /** The operator's Clean storage (routes/admin.ts POST /api/local/admin/storage/clean), timed. */
        'clean-storage': async () => {
            const { cleanStorageAndCompressLogs } = await import('./engine/storage-health.js');
            const t0 = performance.now();
            const r = await cleanStorageAndCompressLogs();
            return { ms: performance.now() - t0, success: r.success };
        },
        /**
         * The image evacuation's once-per-node reclaim (a truncating checkpoint, a VACUUM, another), as the evacuation runs
         * it when it is done: its marker removed first so it runs again. Timed; whether it recorded itself done.
         */
        reclaim: async () => {
            const { db } = await import('./db/db.js');
            const { reclaimSpaceOnce } = await import('./services/image-evacuation.js');
            db.prepare(`DELETE FROM node_config WHERE key = 'image_store_evacuation_vacuumed_v1'`).run();
            const t0 = performance.now();
            reclaimSpaceOnce();
            const ms = performance.now() - t0;
            const marked = !!db.prepare(`SELECT 1 FROM node_config WHERE key = 'image_store_evacuation_vacuumed_v1'`).get();
            return { ms, marked };
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

/**
 * A page's lists that are not a category's rows: the keepers, a whole set in the opening page, and the photos left out.
 * Every other list on a page, and each plain table under `plainTables`, is rows.
 */
const NOT_ROWS = new Set(['treasuryOperators', 'photosOmitted']);

/** A page as the route sent it: status, text, and the page itself. */
interface Got { status: number; text: string; page: any; ms: number }

/** Whether a page's signature is this server's over the rest of it, as the importer checks a payload (engine/sync.ts importRemoteState). */
async function verifies(page: any): Promise<boolean> {
    try {
        const { signature, publicKey, ...rest } = page;
        if (typeof signature !== 'string' || typeof publicKey !== 'string') return false;
        const key = publicKeyFromProtobuf(Buffer.from(publicKey, 'hex'));
        return await key.verify(new TextEncoder().encode(JSON.stringify(rest)), Buffer.from(signature, 'hex'));
    } catch {
        return false;
    }
}

/** Every row of a page with its key (a category, or `plainTables.<table>`), and each row's JSON size. */
function rowsOf(page: any): { key: string; row: any; bytes: number }[] {
    const out: { key: string; row: any; bytes: number }[] = [];
    for (const [k, rows] of Object.entries(page ?? {})) {
        if (!Array.isArray(rows) || NOT_ROWS.has(k)) continue;
        for (const row of rows) out.push({ key: k, row, bytes: Buffer.byteLength(JSON.stringify(row)) });
    }
    for (const [t, rows] of Object.entries(page.plainTables ?? {})) {
        for (const row of rows as any[]) out.push({ key: `plainTables.${t}`, row, bytes: Buffer.byteLength(JSON.stringify(row)) });
    }
    return out;
}

/** The pages' rows merged, in page order, as a payload holds them. */
function merged(pages: any[]): Record<string, any[]> {
    const out: Record<string, any[]> = {};
    for (const p of pages) for (const { key, row } of rowsOf(p)) (out[key] ??= []).push(row);
    return out;
}

/** A category's rows as a sorted list of their JSON, to compare as sets. */
const asSet = (rows: any[] | undefined) => (rows ?? []).map((r) => JSON.stringify(r)).sort();
const sameSet = (a: any[] | undefined, b: any[] | undefined) => JSON.stringify(asSet(a)) === JSON.stringify(asSet(b));

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = path.join(root, 'main');
    const nodes: NodeProc[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = {
        ADMIN_PASSWORD: PW, NODE_ROLE: 'primary', NODE_ENV: 'test',
        SYNC_PAGE_BYTES: String(PAGE_BYTES), SYNC_PAGE_ROWS: String(PAGE_ROWS),
    };
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee] = ['Ann', 'Bo', 'Cy', 'Dee'].map(newId);
    // As a standby asks: with the importer format it reads (engine/sync.ts REPLICA_FORMAT; routes/backup.ts refuses a copy to
    // one older than photos by reference). The old routes ignore it.
    const auth = { 'X-Replication-Token': replicationToken, 'X-Replica-Format': '8' };
    const unsigned: string[] = [];

    let main = await spawnNode(SCRIPT, dir, env);
    nodes.push(main);
    const copyUrl = () => `${main.base}/api/local/admin/sync-copy`;
    const open = async (since?: string, headers: Record<string, string> = auth): Promise<Got> => {
        const t0 = Date.now();
        const res = await fetch(`${copyUrl()}${since ? `?since=${encodeURIComponent(since)}` : ''}`, { method: 'POST', headers });
        const text = await res.text();
        let page: any = null;
        try { page = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, text, page, ms: Date.now() - t0 };
    };
    const get = async (copyId: string, n: number | string, headers: Record<string, string> = auth): Promise<Got> => {
        const t0 = Date.now();
        const res = await fetch(`${copyUrl()}/${copyId}/${n}`, { headers });
        const text = await res.text();
        let page: any = null;
        try { page = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, text, page, ms: Date.now() - t0 };
    };
    /**
     * A whole copy, or a delta from `since`, page after page to its last, each page's signature and copy id and number
     * checked as it comes (a failure is kept in `unsigned`). `between(n)` runs before page n is asked for; `page(g)` after
     * each page arrives. `lean`: each page's signature, copy id and number are checked as it arrives, after `page(g)`,
     * and then its rows and text are dropped (its `copyId`, `n`, `last` and `rowCounts` kept), so a copy bigger than
     * this process's heap can be walked.
     */
    const copy = async (opts: { since?: string; between?: (n: number) => Promise<void>; onPage?: (g: Got) => Promise<void>; lean?: boolean } = {}): Promise<{ pages: any[]; got: Got[] }> => {
        const first = await open(opts.since);
        require_(first.status === 200 && first.page?.n === 0, `M opens a ${opts.since ? 'delta' : 'whole'} copy (${first.status} ${first.text.slice(0, 200)})`);
        const copyId: string = first.page.copyId;
        const check = async (g: Got, n: number) => {
            if (!(await verifies(g.page)) || g.page.copyId !== copyId || g.page.n !== n) unsigned.push(`${copyId.slice(0, 8)}/${n}`);
        };
        const arrived = async (g: Got, n: number) => {
            await opts.onPage?.(g);
            if (!opts.lean) return;
            await check(g, n);
            g.page = { copyId: g.page.copyId, n: g.page.n, last: g.page.last, rowCounts: g.page.rowCounts };
            g.text = '';
        };
        const got = [first];
        await arrived(first, 0);
        while (!got[got.length - 1].page.last) {
            const n = got.length;
            await opts.between?.(n);
            const g = await get(copyId, n);
            require_(g.status === 200, `page ${n} of the copy arrives (${g.status} ${g.text.slice(0, 200)})`);
            got.push(g);
            await arrived(g, n);
        }
        if (!opts.lean) for (let n = 0; n < got.length; n++) await check(got[n], n);
        return { pages: got.map((g) => g.page), got };
    };

    try {
        // ── 1. M, the old routes, and a whole copy that is today's payload ──
        console.log('\n— 1. the main server; the old routes; a whole copy in pages carries what the whole payload carries —');
        await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        const As = (who: Id, route: string, body: unknown = {}) => api(m, 'POST', route, { as: who, body });
        const join = async (who: Id) => {
            const inv = built(`Gwen makes an invite for ${who.name}`, await As(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
            built(`${who.name} joins with it`, await api(m, 'POST', '/api/invite/redeem', { body: { code: inv.invite?.code ?? inv.code, publicKey: who.pk, callsign: who.name } }));
            built(`${who.name} sets a profile photo`, await As(who, '/api/profile/update', { avatar: TINY_PNG }));
        };
        built('Gwen sets a profile photo', await As(gwen, '/api/profile/update', { avatar: TINY_PNG }));
        for (const who of [ann, bo, cy, dee]) await join(who);
        const offer = async (who: Id, title: string, credits: number) => built(`${who.name} offers ${title}`, await As(who, '/api/marketplace/posts', {
            type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits, priceType: 'fixed', authorPublicKey: who.pk,
        })).post;
        built('the admin makes Gwen an Elder (a credit line to buy with)', await api(m, 'POST', `/api/local/admin/users/${gwen.pk}/elder`, { admin: PW, body: { grant: true } }));
        await offer(gwen, 'Sourdough', 4);
        const bike = await offer(cy, 'Bike repair', 6);
        const honey = await offer(ann, 'Honey', 20);
        const deal = async (buyer: Id, seller: Id, post: any) => {
            const tx = built(`${buyer.name} asks for ${post.title}`, await As(buyer, '/api/marketplace/posts/request', { postId: post.id, buyerPublicKey: buyer.pk })).transaction;
            built(`${seller.name} approves: the Beans are held`, await As(seller, '/api/marketplace/transactions/approve', { transactionId: tx.id, authorPublicKey: seller.pk }));
            built(`${buyer.name} confirms: the Beans are released`, await As(buyer, '/api/marketplace/transactions/complete', { transactionId: tx.id, confirmerPublicKey: buyer.pk }));
            return tx.id as string;
        };
        await deal(gwen, ann, honey);
        built('Gwen makes an invite nobody has used yet', await As(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
        built('Ann starts a group', await As(ann, '/api/groups', { name: 'Beekeepers' }));
        const conv = built('Ann opens a DM with Bo', await As(ann, '/api/messages/conversation', { type: 'dm', participants: [ann.pk, bo.pk], createdBy: ann.pk }));
        const conversationId: string = conv.conversation?.id ?? conv.id;
        const lines: string[] = [];
        for (let i = 0; i < 3; i++) {
            const r = built(`Ann writes to Bo (${i + 1})`, await As(ann, '/api/messages/send', { conversationId, authorPubkey: ann.pk, ...lockedDm() }));
            lines.push(r.message?.id ?? r.id);
        }
        await main.send('sql', { sql: `INSERT INTO post_photos (post_id, photo_data, order_num, updated_at) VALUES (?, ?, 0, ?)`, args: [honey.id, TINY_PNG, new Date().toISOString()] });
        await main.send('flood', { kind: 'messages', n: 1200, prefix: 'pre', conversationId, author: ann.pk });
        await main.send('flood', { kind: 'members', n: 300, prefix: 'pre' });
        await main.send('flood', { kind: 'posts', n: 200, prefix: 'pre', author: cy.pk });

        const snap = await fetch(`${main.base}/api/local/admin/sync-snapshot`, { headers: auth });
        const payload = await snap.json() as any;
        const since0 = new Date(Date.now() - 60_000).toISOString();
        const deltaOld = await fetch(`${main.base}/api/local/admin/sync-delta`, { headers: { ...auth, 'X-Since-Cursor': since0 } });
        const deltaPayload = await deltaOld.json() as any;
        assert(snap.status === 200 && typeof payload.signature === 'string' && payload.members?.length >= 305 && payload.tableHashes,
            `the old whole copy (sync-snapshot) still answers, signed, with its table hashes (${snap.status}, ${payload.members?.length} members)`);
        assert(deltaOld.status === 200 && typeof deltaPayload.signature === 'string' && deltaPayload.messages?.length >= 1200,
            `the old delta (sync-delta) still answers, signed (${deltaOld.status}, ${deltaPayload.messages?.length} lines)`);

        const whole = await copy();
        const w = merged(whole.pages);
        const opening = whole.pages[0];
        const closing = whole.pages[whole.pages.length - 1];
        // Every list the whole payload carries, and every category the pages carry: none missing on either side.
        const categories = [...new Set([...Object.keys(payload).filter((k) => Array.isArray(payload[k])), ...Object.keys(w)])]
            .filter((k) => !NOT_ROWS.has(k) && !k.startsWith('plainTables.'));
        const differing = categories.filter((k) => !sameSet(w[k], payload[k]));
        const plainDiffering = Object.keys({ ...payload.plainTables, ...opening.rowCounts.plainTables })
            .filter((t) => !sameSet(w[`plainTables.${t}`], payload.plainTables?.[t]));
        assert(whole.pages.length > 10, `a whole copy of it takes many pages at ${PAGE_ROWS} rows or ${PAGE_BYTES / 1024} KB (${whole.pages.length})`);
        assert(differing.length === 0 && plainDiffering.length === 0,
            `its pages carry the whole payload's rows, category by category (${categories.length}) and plain table by table (${Object.keys(payload.plainTables ?? {}).length}): differing ${JSON.stringify([...differing, ...plainDiffering])}`);
        assert(opening.stateHash === payload.stateHash && opening.commonsBalance === payload.commonsBalance
            && JSON.stringify(opening.treasuryOperators) === JSON.stringify(payload.treasuryOperators)
            && JSON.stringify(opening.communitySettings) === JSON.stringify(payload.communitySettings)
            && JSON.stringify(opening.nodeProfile) === JSON.stringify(payload.nodeProfile) && opening.openJoinKeyId === payload.openJoinKeyId,
            `its opening page carries the payload's listing hash, pot, keepers, settings and records (${opening.stateHash} / ${payload.stateHash})`);
        assert(JSON.stringify(closing.tableHashes) !== undefined && JSON.stringify(Object.entries(closing.tableHashes?.tables ?? {}).sort())
            === JSON.stringify(Object.entries(payload.tableHashes?.tables ?? {}).sort()),
            `its last page carries the payload's table hashes (${Object.keys(closing.tableHashes?.tables ?? {}).length} tables)`);
        assert(w.photos?.length === 1 && w.photos[0].photo_data === TINY_PNG, `the listing photo travels with its bytes put back (${JSON.stringify(w.photos)?.slice(0, 120)})`);

        // ── 2. Pages under writes hold the snapshot; the delta after carries the writes ──
        console.log('\n— 2. a copy\'s pages under writes on M hold the snapshot; the delta from its cursor carries the writes —');
        const before = await main.send('state');
        const ledgerAtOpen = await main.send('rows', { sql: 'SELECT public_key, balance FROM accounts ORDER BY public_key' });
        const during: { messages: string[]; members: string[] } = { messages: [], members: [] };
        let dealDuring = '';
        const deleted = lines[0];
        const under = await copy({
            between: async (n) => {
                during.messages.push(...await main.send('flood', { kind: 'messages', n: 15, prefix: 'during', conversationId, author: bo.pk, ids: true }));
                during.members.push(...await main.send('flood', { kind: 'members', n: 3, prefix: 'during', ids: true }));
                if (n === 1) dealDuring = await deal(gwen, cy, bike);
                if (n === 2) await main.send('delete-message', { id: deleted });
            },
        });
        const u = merged(under.pages);
        const uOpen = under.pages[0];
        const uLast = under.pages[under.pages.length - 1];
        const after = await main.send('state');
        const countsOf = (rows: Record<string, any[]>) => {
            const out: Record<string, number> = {};
            for (const [k, v] of Object.entries(rows)) out[k] = v.length;
            return out;
        };
        const flat = (c: any) => {
            const out: Record<string, number> = {};
            for (const [k, v] of Object.entries(c ?? {})) {
                if (k === 'plainTables') for (const [t, n] of Object.entries(v as Record<string, number>)) { if (n) out[`plainTables.${t}`] = n; }
                else if (v) out[k] = v as number;
            }
            return out;
        };
        const sortKeys = (o: Record<string, number>) => JSON.stringify(Object.entries(o).sort());
        assert(under.pages.length > 10 && during.messages.length >= 150 && dealDuring !== '',
            `M took chat lines, members and a deal between the copy's ${under.pages.length} pages (${during.messages.length} lines, ${during.members.length} members)`);
        assert(sortKeys(flat(uOpen.rowCounts)) === sortKeys(countsOf(u)) && sortKeys(flat(uLast.rowsSent)) === sortKeys(countsOf(u)),
            `the rows it carries are the opening page's counts, and the last page's (${u.messages?.length} lines, ${u.members?.length} members)`);
        const hashesAsSet = (h: any) => JSON.stringify([h?.v, Object.entries(h?.tables ?? {}).sort()]);
        assert(Object.keys(before.hashes.tables).length > 10 && hashesAsSet(uLast.tableHashes) === hashesAsSet(before.hashes),
            `its table hashes are M's at the open, table for table (${Object.keys(before.hashes.tables).length} tables)`);
        assert(after.hashes.tables.messages.hash !== before.hashes.tables.messages.hash && after.hashes.tables.members.hash !== before.hashes.tables.members.hash
            && after.hashes.tables.accounts.hash !== before.hashes.tables.accounts.hash,
            `...not M's now: its lines, members and accounts have moved since (${after.hashes.tables.messages.rows} lines now, ${before.hashes.tables.messages.rows} at the open)`);
        assert(uOpen.stateHash === before.stateHash && uOpen.stateHash !== after.stateHash, `its listing hash is the open's (${uOpen.stateHash}; now ${after.stateHash})`);
        const copiedLedger = (u.accounts ?? []).map((a: any) => ({ public_key: a.publicKey, balance: a.balance })).sort((a: any, b: any) => (a.public_key < b.public_key ? -1 : 1));
        assert(JSON.stringify(copiedLedger) === JSON.stringify(ledgerAtOpen), `its accounts are the ledger at the open, balance for balance (${copiedLedger.length} accounts)`);
        const leaked = [
            ...(u.messages ?? []).filter((r: any) => String(r.id).startsWith('during-')).map((r: any) => r.id),
            ...(u.members ?? []).filter((r: any) => String(r.publicKey).startsWith('during-')).map((r: any) => r.publicKey),
            ...(u.marketplaceTransactions ?? []).filter((r: any) => r.id === dealDuring).map((r: any) => r.id),
        ];
        assert(leaked.length === 0, `nothing written after the open is in it (${JSON.stringify(leaked.slice(0, 3))})`);
        assert((u.messages ?? []).some((r: any) => r.id === deleted) && !(u.tombstones ?? []).some((t: any) => t.rowKey === deleted),
            'the line deleted during the copy is in it, and its tombstone is not');
        const delta = await copy({ since: uOpen.cursor });
        const d = merged(delta.pages);
        const dIds = new Set((d.messages ?? []).map((r: any) => r.id));
        const dKeys = new Set((d.members ?? []).map((r: any) => r.publicKey));
        const ledgerNow = await main.send('rows', { sql: 'SELECT public_key, balance FROM accounts ORDER BY public_key' });
        const deltaLedger = (d.accounts ?? []).map((a: any) => ({ public_key: a.publicKey, balance: a.balance })).sort((a: any, b: any) => (a.public_key < b.public_key ? -1 : 1));
        assert(during.messages.every((id) => dIds.has(id)) && during.members.every((k) => dKeys.has(k)),
            `the delta copy from its cursor carries every line and member written during it (${during.messages.filter((id) => dIds.has(id)).length}/${during.messages.length}, ${during.members.filter((k) => dKeys.has(k)).length}/${during.members.length})`);
        assert((d.marketplaceTransactions ?? []).some((r: any) => r.id === dealDuring) && (d.transactions ?? []).length >= 1
            && (d.tombstones ?? []).some((t: any) => t.tableName === 'messages' && t.rowKey === deleted),
            `...the deal, its trades and the deleted line's tombstone (${(d.transactions ?? []).length} trades, ${(d.tombstones ?? []).length} tombstones)`);
        assert(JSON.stringify(deltaLedger) === JSON.stringify(ledgerNow) && JSON.stringify(ledgerNow) !== JSON.stringify(ledgerAtOpen),
            `...and the whole ledger as it is now (${deltaLedger.length} accounts)`);
        assert(delta.pages[0].since === uOpen.cursor && !delta.pages[delta.pages.length - 1].tableHashes, 'the delta names its cursor, and carries no table hashes');

        // ── 3. A delta over many pages of rows with one watermark carries each row once ──
        console.log('\n— 3. a delta copy whose rows share one watermark across many pages carries each row once —');
        const stamp = new Date().toISOString();
        await main.send('flood', { kind: 'messages', n: 700, prefix: 'same', conversationId, author: ann.pk, stamp });
        await main.send('flood', { kind: 'members', n: 250, prefix: 'same', stamp });
        const same = await copy({ since: stamp });
        const s = merged(same.pages);
        const sIds = (s.messages ?? []).map((r: any) => r.id);
        const sKeys = (s.members ?? []).map((r: any) => r.publicKey);
        const wantIds = (await main.send('rows', { sql: 'SELECT id FROM messages WHERE updated_at >= ?', args: [stamp] })).map((r: any) => r.id).sort();
        const wantKeys = (await main.send('rows', { sql: 'SELECT public_key FROM members WHERE updated_at >= ?', args: [stamp] })).map((r: any) => r.public_key).sort();
        assert(same.pages.length >= 5, `the delta takes ${same.pages.length} pages`);
        assert(new Set(sIds).size === sIds.length && new Set(sKeys).size === sKeys.length, `no line or member comes twice (${sIds.length} lines, ${sKeys.length} members)`);
        assert(JSON.stringify([...sIds].sort()) === JSON.stringify(wantIds) && JSON.stringify([...sKeys].sort()) === JSON.stringify(wantKeys),
            `and they are exactly M's rows at or after its cursor (${wantIds.length} lines, ${wantKeys.length} members)`);
        // The keyset itself (engine/keyset.ts), on a table whose order has NULLs and ties in it, as a plain table ordered by
        // its watermark and key could: read 7 rows at a time, every row once, in the order one query gives.
        let walked: string[] = [];
        let whole1: string[] = [];
        try {
            const { afterRow } = await import('./engine/keyset.js');
            const mem = new Database(':memory:');
            mem.exec('CREATE TABLE t (w TEXT, k INTEGER, v TEXT)');
            const put = mem.prepare('INSERT INTO t (w, k, v) VALUES (?, ?, ?)');
            for (let i = 0; i < 500; i++) put.run([null, 'a', 'b'][i % 3], [null, 1, 2, 3][(i * 7) % 4], `v${i}`);
            const order = ['w', 'k', 'rowid'];
            for (let last: unknown[] | null = null; ;) {
                const past = last ? afterRow(order, last) : null;
                const rows = mem.prepare(`SELECT v, w, k, rowid AS r FROM t${past ? ` WHERE ${past.sql}` : ''} ORDER BY w, k, rowid LIMIT 7`)
                    .all(...(past?.params ?? [])) as { v: string; w: string | null; k: number | null; r: number }[];
                walked.push(...rows.map((r) => r.v));
                if (rows.length < 7) break;
                const end = rows[rows.length - 1];
                last = [end.w, end.k, end.r];
            }
            whole1 = (mem.prepare('SELECT v FROM t ORDER BY w, k, rowid').all() as { v: string }[]).map((r) => r.v);
            mem.close();
        } catch (e: any) {
            walked = [`failed: ${e?.message || e}`];
        }
        assert(walked.length === 500 && JSON.stringify(walked) === JSON.stringify(whole1),
            `read a slice at a time over NULLs and ties in its order, a table gives every row once, in order (${walked.length} of 500${walked.length === 1 ? `: ${walked[0]}` : ''})`);

        // ── 4. Rows bigger than a page ──
        console.log('\n— 4. rows bigger than a page: no page splits a row, and each arrives whole —');
        const [bigLine] = await main.send('flood', { kind: 'messages', n: 1, prefix: 'big', conversationId, author: ann.pk, bytes: 150_000, ids: true });
        const [midLine] = await main.send('flood', { kind: 'messages', n: 1, prefix: 'mid', conversationId, author: ann.pk, bytes: 40_000, ids: true });
        const [bigMember] = await main.send('flood', { kind: 'members', n: 1, prefix: 'big', bytes: 100_000, ids: true });
        const [held] = await main.send('rows', { sql: 'SELECT ciphertext FROM messages WHERE id = ?', args: [bigLine] });
        const [heldMember] = await main.send('rows', { sql: 'SELECT avatar_url FROM members WHERE public_key = ?', args: [bigMember] });
        const bounded = await copy();
        const over: string[] = [];
        const empty: number[] = [];
        let largest = 0;
        for (const p of bounded.pages) {
            const rows = rowsOf(p);
            const bytes = rows.reduce((a, r) => a + r.bytes, 0);
            largest = Math.max(largest, bytes);
            if (rows.length === 0 && !p.last) empty.push(p.n);
            if ((bytes > PAGE_BYTES && rows.length !== 1) || rows.length > PAGE_ROWS) over.push(`${p.n}: ${rows.length} rows, ${bytes} bytes`);
        }
        const b = merged(bounded.pages);
        const bigAlone = bounded.pages.filter((p) => rowsOf(p).some((r) => r.row.id === bigLine || r.row.publicKey === bigMember));
        assert(over.length === 0 && empty.length === 0,
            `every page is within ${PAGE_BYTES} bytes and ${PAGE_ROWS} rows, or one row alone, and holds a row (over: ${JSON.stringify(over)}; empty: ${JSON.stringify(empty)}; largest ${largest} bytes)`);
        assert(bigAlone.length === 2 && bigAlone.every((p) => rowsOf(p).length === 1),
            `the 150 KB line and the 100 KB avatar each fill a page of their own (${bigAlone.map((p) => `${p.n}: ${rowsOf(p).length} rows`).join(', ')})`);
        assert((b.messages ?? []).find((r: any) => r.id === bigLine)?.ciphertext === held.ciphertext
            && (b.messages ?? []).some((r: any) => r.id === midLine)
            && (b.members ?? []).find((r: any) => r.publicKey === bigMember)?.standing?.avatar_url === heldMember.avatar_url,
            'each big row arrives whole');

        // ── 5. One at a time, in order, with retries; auth ──
        console.log('\n— 5. one copy at a time, pages in order, a retry gets the same bytes, and the replication token —');
        const o = await open();
        require_(o.status === 200 && o.page.last === false, `a whole copy opens (${o.status})`);
        const busy = await open();
        assert(busy.status === 409 && /busy/.test(busy.text), `a second copy while it is open is 409 busy (${busy.status} ${busy.text.slice(0, 120)})`);
        const skipped = await get(o.page.copyId, 2);
        const p1 = await get(o.page.copyId, 1);
        const p1again = await get(o.page.copyId, 1);
        const back = await get(o.page.copyId, 0);
        const ahead = await get(o.page.copyId, 3);
        assert(skipped.status === 409 && skipped.page?.expected === 1, `page 2 before page 1 is 409, naming the page expected (${skipped.status} ${skipped.text.slice(0, 120)})`);
        assert(p1.status === 200 && p1again.status === 200 && p1again.text === p1.text, `page 1 asked again gets the same bytes (${p1.text.length} bytes)`);
        assert(back.status === 409 && ahead.status === 409, `page 0 after page 1, and page 3, are 409 (${back.status}, ${ahead.status})`);
        const unknown = await get(crypto.randomUUID(), 2);
        const noToken = await get(o.page.copyId, 2, {});
        const badToken = await get(o.page.copyId, 2, { 'X-Replication-Token': 'f'.repeat(64) });
        const openNoToken = await open(undefined, {});
        assert(unknown.status === 404 && noToken.status === 401 && badToken.status === 401 && openNoToken.status === 401,
            `an unknown copy is 404, and a page or a copy without the replication token is 401 (${unknown.status}, ${noToken.status}, ${badToken.status}, ${openNoToken.status})`);
        // A server with a replication token takes only the token until its operator says otherwise, on every copy route.
        const byPassword = await get(o.page.copyId, 2, { 'X-Admin-Password': PW });
        const oldByPassword = await fetch(`${main.base}/api/local/admin/sync-snapshot`, { headers: { 'X-Admin-Password': PW } });
        const oldPwText = await oldByPassword.text();
        assert(byPassword.status === 401 && oldByPassword.status === 401 && byPassword.text === oldPwText,
            `the admin password is answered as the old routes answer it (${byPassword.status} ${byPassword.text.slice(0, 80)}; sync-snapshot ${oldByPassword.status} ${oldPwText.slice(0, 80)})`);
        await main.send('token-only', { on: false });
        const byPasswordNow = await get(o.page.copyId, 2, { 'X-Admin-Password': PW });
        const wrongPassword = await get(o.page.copyId, 2, { 'X-Admin-Password': `${PW}x` });
        await main.send('token-only', { on: true });
        assert(byPasswordNow.status === 200 && byPasswordNow.page?.n === 2 && wrongPassword.status === 401,
            `with the token-only setting off, the admin password gets a page and a wrong one is 401 (${byPasswordNow.status}, ${wrongPassword.status} ${wrongPassword.text.slice(0, 80)})`);

        // ── 6. What the signature covers ──
        console.log('\n— 6. a page\'s signature covers its copy id and its number —');
        const renumbered = { ...p1.page, n: 5 };
        const moved = { ...p1.page, copyId: crypto.randomUUID() };
        assert(await verifies(p1.page) && !(await verifies(renumbered)) && !(await verifies(moved)),
            'a page verifies, and the same page with another number or another copy id does not');
        /** Ask for a copy's pages from `from` to its last, so the next copy can open. */
        const drain = async (copyId: string, from: number) => {
            let k = from;
            for (let g = await get(copyId, k); ; g = await get(copyId, k)) {
                if (g.status === 409 && typeof g.page?.expected === 'number') k = g.page.expected;
                else if (g.status === 200 && !g.page.last) k++;
                else return;
            }
        };
        await drain(o.page.copyId, 3);
        const other = await open();
        const otherP1 = await get(other.page.copyId, 1);
        assert(await verifies(otherP1.page) && otherP1.page.copyId === other.page.copyId && otherP1.page.copyId !== p1.page.copyId && otherP1.page.n === 1,
            'page 1 of another copy verifies too, and names that copy, so a standby holding this copy tells it apart');
        await drain(other.page.copyId, 2);

        // ── 7. Expiry ──
        console.log('\n— 7. a copy no page is asked of closes, and the WAL it held truncates after —');
        await main.send('set-env', { vars: { SYNC_COPY_IDLE_MS: '1500' } });
        const e = await open();
        require_(e.status === 200 && e.page.last === false, `a copy opens (${e.status})`);
        await main.send('flood', { kind: 'messages', n: 2000, prefix: 'wal', conversationId, author: ann.pk });
        const checkpoint = () => {
            const conn = new Database(path.join(dir, 'state.db'), { timeout: 0 });
            try {
                const [cp] = conn.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[];
                return cp;
            } finally {
                conn.close();
            }
        };
        const walSize = () => (fs.existsSync(path.join(dir, 'state.db-wal')) ? fs.statSync(path.join(dir, 'state.db-wal')).size : 0);
        const pinned = checkpoint();
        const walPinned = walSize();
        assert(pinned.busy === 1 && walPinned > 0, `while it is open, a truncating checkpoint can't finish and the WAL keeps ${walPinned} bytes (${JSON.stringify(pinned)})`);
        await sleep(2600);
        const expired = await get(e.page.copyId, 1);
        const freed = checkpoint();
        assert(expired.status === 404, `no page asked for in 1.5 s, the copy is gone (${expired.status} ${expired.text.slice(0, 80)})`);
        assert(freed.busy === 0 && walSize() === 0, `and the checkpoint truncates the WAL after it (${JSON.stringify(freed)}, ${walSize()} bytes)`);
        await main.send('set-env', { vars: { SYNC_COPY_IDLE_MS: '', SYNC_COPY_MAX_MS: '2000' } });
        const longOne = await open();
        require_(longOne.status === 200 && longOne.page.last === false, `a copy opens (${longOne.status})`);
        const t0 = Date.now();
        let kept = 0;
        for (let g = await get(longOne.page.copyId, 0); g.status === 200 && Date.now() - t0 < 6000; g = await get(longOne.page.copyId, 0)) {
            kept++;
            await sleep(250);
        }
        const heldFor = Date.now() - t0;
        assert(kept >= 4 && heldFor >= 1000 && heldFor < 4000, `a copy asked for again and again still closes 2 s after it opened (${kept} retries, closed after ${heldFor} ms)`);
        await main.send('set-env', { vars: { SYNC_COPY_MAX_MS: '' } });

        // ── 8. The recovery seal's VACUUM with a copy open ──
        console.log('\n— 8. the recovery seal\'s VACUUM with a copy open —');
        const v = await open();
        require_(v.status === 200 && v.page.last === false, `a copy opens (${v.status})`);
        await main.send('flood', { kind: 'messages', n: 200, prefix: 'vac', conversationId, author: ann.pk });
        const vacuumed = await main.send('vacuum');
        const vAfter = await get(v.page.copyId, 1);
        assert(vacuumed.ok === true, `the VACUUM and the checkpoint that empties the WAL both succeed (${JSON.stringify(vacuumed)})`);
        assert(vAfter.status === 404, `the copy was closed first: its next page is 404 (${vAfter.status} ${vAfter.text.slice(0, 80)})`);
        const reopened0 = await open();
        assert(reopened0.status === 200, `a new copy opens after it (${reopened0.status})`);
        // The two other truncating checkpoints on M's own connection. With the copy's read open, each would wait out the
        // busy timeout (5 s), synchronously, and leave the WAL as it was.
        for (const [what, cmd] of [['Clean storage', 'clean-storage'], ['the image evacuation reclaim', 'reclaim']] as const) {
            const c = cmd === 'clean-storage' ? reopened0 : await open();
            require_(c.status === 200 && c.page.last === false, `a copy opens before ${what} (${c.status})`);
            await main.send('flood', { kind: 'messages', n: 50, prefix: `ck-${cmd}`, conversationId, author: ann.pk });
            const walHeld = await main.send('wal');
            await main.send('lag-reset');
            const r = await main.send(cmd);
            const l = await main.send('lag-read');
            const cAfter = await get(c.page.copyId, 1);
            const walLeft = await main.send('wal');
            assert(r.ms < 1500 && l.maxMs < 1500 && (cmd === 'reclaim' ? r.marked === true : r.success === true),
                `${what} with a copy open doesn't wait on it: ${r.ms.toFixed(0)} ms, M's loop blocked up to ${l.maxMs.toFixed(0)} ms (${JSON.stringify(r)})`);
            // The reclaim records itself done after its last checkpoint: that one write is all its WAL may hold.
            const walAllowed = cmd === 'reclaim' ? 16 * 1024 : 0;
            assert(cAfter.status === 404 && walHeld > 0 && walLeft <= walAllowed,
                `it closed the copy first (its next page ${cAfter.status}), and the WAL of ${walHeld} bytes is empty after (${walLeft}${walAllowed ? `, at most ${walAllowed} for its own mark` : ''})`);
            // A copy it left open is served to its end, so the next one can open.
            if (cAfter.status === 200 && !cAfter.page.last) await drain(c.page.copyId, 2);
        }
        const reopened = await open();
        assert(reopened.status === 200, `a new copy opens after them (${reopened.status})`);

        // ── 9. A restart ──
        console.log('\n— 9. after M restarts, the copy it was serving is gone —');
        await main.kill();
        main = await spawnNode(SCRIPT, dir, env);
        nodes.push(main);
        const lost = await get(reopened.page.copyId, 1);
        const fresh = await open();
        assert(lost.status === 404 && fresh.status === 200, `the copy from before the restart is 404, and a new one opens (${lost.status}, ${fresh.status})`);
        await drain(fresh.page.copyId, 1);

        // ── 10. The size run, at the real bounds ──
        console.log('\n— 10. the size run: 40,000 members, 80,000 chat lines, 40,000 trades, pages of 8 MB or 25,000 rows —');
        await main.send('set-env', { vars: { SYNC_PAGE_BYTES: '', SYNC_PAGE_ROWS: '', SYNC_COPY_IDLE_MS: '' } });
        const tSeed = Date.now();
        await main.send('flood', { kind: 'members', n: 40_000, prefix: 'size' });
        await main.send('flood', { kind: 'messages', n: 80_000, prefix: 'size', conversationId, author: ann.pk });
        await main.send('flood', { kind: 'transactions', n: 40_000, prefix: 'size', author: ann.pk, to: bo.pk });
        const rssBefore = (await main.send('lag-read')).rss;
        console.log(`  (written in ${((Date.now() - tSeed) / 1000).toFixed(1)} s; M's RSS ${(rssBefore / 1e6).toFixed(0)} MB)`);
        const perPage: { n: number; rows: number; mb: number; ms: number; lag: number; rss: number }[] = [];
        await main.send('lag-reset');
        const tNew = Date.now();
        const sized = await copy({
            onPage: async (g) => {
                const l = await main.send('lag-read');
                const rows = rowsOf(g.page);
                perPage.push({ n: g.page.n, rows: rows.length, mb: rows.reduce((a, r) => a + r.bytes, 0) / 1e6, ms: g.ms, lag: l.maxMs, rss: l.rss });
                await main.send('lag-reset');
            },
        });
        const totalMs = Date.now() - tNew;
        for (const p of perPage) {
            console.log(`  page ${String(p.n).padStart(2)}: ${String(p.rows).padStart(6)} rows, ${p.mb.toFixed(2).padStart(5)} MB, ${String(p.ms).padStart(4)} ms, loop blocked up to ${p.lag.toFixed(0).padStart(3)} ms, RSS ${(p.rss / 1e6).toFixed(0)} MB`);
        }
        // Today's whole payload of the same community, after, so the pages' memory above is theirs alone.
        await main.send('lag-reset');
        const tOld = Date.now();
        const oldRes = await fetch(`${main.base}/api/local/admin/sync-snapshot`, { headers: auth });
        const oldText = await oldRes.text();
        const oldLag = await main.send('lag-read');
        console.log(`  today's whole payload: ${(oldText.length / 1e6).toFixed(1)} MB in ${Date.now() - tOld} ms, M's loop blocked up to ${oldLag.maxMs.toFixed(0)} ms (RSS ${(oldLag.rss / 1e6).toFixed(0)} MB)`);
        const sm = merged(sized.pages);
        const maxLag = Math.max(...perPage.map((p) => p.lag));
        assert(sized.pages.length >= 8 && perPage.every((p) => p.rows <= 25_000 && (p.mb * 1e6 <= 8 * 1024 * 1024 || p.rows === 1)),
            `the copy is ${sized.pages.length} pages in ${(totalMs / 1000).toFixed(1)} s, each within 8 MB and 25,000 rows (${JSON.stringify({ members: sm.members?.length, messages: sm.messages?.length, transactions: sm.transactions?.length })})`);
        assert(sortKeys(flat(sized.pages[0].rowCounts)) === sortKeys(countsOf(sm)), 'it carries every row its opening page counts');
        assert(maxLag < 1000, `no page blocked M's event loop for a second: at most ${maxLag.toFixed(0)} ms (today's whole payload: ${oldLag.maxMs.toFixed(0)} ms at once)`);

        // ── 11. Wide rows under the deployed heap ──
        console.log('\n— 11. wide rows under the deployed heap: M at --max-old-space-size=512, 6,000 more members with a 70 KB photo inline —');
        await main.kill();
        main = await spawnNode(SCRIPT, dir, { ...env, SYNC_PAGE_BYTES: '', SYNC_PAGE_ROWS: '', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=512`.trim() });
        nodes.push(main);
        const heapLimit = (await main.send('peak-read')).heapLimit;
        // V8's limit is the old space's 512 MB and the young space's beside it.
        require_(heapLimit < 700 * 1024 * 1024, `M runs with the deployed heap limit (V8's heap_size_limit ${(heapLimit / 1e6).toFixed(0)} MB)`);
        const tWide = Date.now();
        // In batches, each its own transaction, so writing them never needs them all in memory at once. Keys starting `0w`
        // come before nearly every other member's (hex) in the table hashes' order, so the first slices of members hashed
        // are all wide, as on a community whose every member has a photo.
        for (let i = 0; i < 6; i++) await main.send('flood', { kind: 'members', n: 1000, prefix: `0wide${i}`, bytes: 70_000 });
        const wideDb = fs.statSync(path.join(dir, 'state.db')).size + (fs.existsSync(path.join(dir, 'state.db-wal')) ? fs.statSync(path.join(dir, 'state.db-wal')).size : 0);
        const rssWide = (await main.send('lag-read')).rss;
        console.log(`  (written in ${((Date.now() - tWide) / 1000).toFixed(1)} s; state.db and its WAL ${(wideDb / 1e6).toFixed(0)} MB; M's RSS ${(rssWide / 1e6).toFixed(0)} MB)`);
        const widePages: { n: number; rows: number; mb: number; ms: number; lag: number }[] = [];
        await main.send('peak-reset');
        await main.send('lag-reset');
        const tWideCopy = Date.now();
        let wide: { pages: any[] } | null = null;
        let wideError = '';
        try {
            wide = await copy({
                onPage: async (g) => {
                    const l = await main.send('lag-read');
                    const rows = rowsOf(g.page);
                    widePages.push({ n: g.page.n, rows: rows.length, mb: rows.reduce((a, r) => a + r.bytes, 0) / 1e6, ms: g.ms, lag: l.maxMs });
                    await main.send('lag-reset');
                },
            });
        } catch (e: any) {
            const code = await Promise.race([main.exited, sleep(2000).then(() => 'still running')]);
            wideError = `${e?.message || e}; M ${code === 'still running' ? 'is still running' : `exited (${code})`}${/heap out of memory/.test(main.output()) ? ', out of heap' : ''}`;
        }
        const wideMs = Date.now() - tWideCopy;
        // A dead M answers no command: the suite stops here rather than wait on it.
        require_(wide !== null, `M serves the whole copy under a 512 MB heap: ${wide ? `${wide.pages.length} pages in ${(wideMs / 1000).toFixed(1)} s` : wideError}`);
        if (wide) {
            const peak = await main.send('peak-read');
            const worst = widePages.reduce((a, p) => (p.lag > a.lag ? p : a), widePages[0]);
            const opening = widePages[0];
            const ws = merged(wide.pages);
            const wideMembers = (ws.members ?? []).filter((r: any) => /^0wide\d-/.test(r.publicKey ?? r.public_key ?? '')).length;
            console.log(`  pages ${widePages.length}; the open (page 0): ${opening.rows} rows, ${opening.mb.toFixed(2)} MB, loop blocked up to ${opening.lag.toFixed(0)} ms;`
                + ` worst page ${worst.n}: ${worst.rows} rows, ${worst.mb.toFixed(2)} MB, loop blocked up to ${worst.lag.toFixed(0)} ms;`
                + ` peak RSS ${(peak.rss / 1e6).toFixed(0)} MB (before ${(rssWide / 1e6).toFixed(0)} MB), peak heap ${(peak.heap / 1e6).toFixed(0)} MB of ${(peak.heapLimit / 1e6).toFixed(0)} MB`);
            assert(sortKeys(flat(wide.pages[0].rowCounts)) === sortKeys(countsOf(ws)) && wideMembers === 6000,
                `it carries every row its opening page counts, the 6,000 wide members among them (${wideMembers})`);
            assert(widePages.every((p) => p.rows <= 25_000 && (p.mb * 1e6 <= 8 * 1024 * 1024 || p.rows === 1)), 'each page within 8 MB and 25,000 rows');
            assert(opening.lag < WIDE_LAG_MS && worst.lag < WIDE_LAG_MS,
                `neither the open nor any page held M's event loop ${WIDE_LAG_MS} ms (the open ${opening.lag.toFixed(0)} ms, worst page ${worst.lag.toFixed(0)} ms)`);
            assert(peak.heap < WIDE_HEAP_BYTES && peak.rss - rssWide < WIDE_RSS_GROWTH,
                `M's memory stays bounded: peak heap ${(peak.heap / 1e6).toFixed(0)} MB (< ${(WIDE_HEAP_BYTES / 1e6).toFixed(0)}), RSS grew ${((peak.rss - rssWide) / 1e6).toFixed(0)} MB (< ${(WIDE_RSS_GROWTH / 1e6).toFixed(0)})`);
        }

        // ── 12. Wide chat lines under the same heap ──
        console.log(`\n— 12. wide chat lines under the deployed heap: ${WIDE_LINES.toLocaleString('en')} more chat lines of ${WIDE_LINE_BYTES / 1000} KB each, M still at 512 MB —`);
        const tLines = Date.now();
        // In batches of 100 (50 MB), each its own transaction. They are the newest rows of the messages table, so a whole
        // copy reads them last, after 80,000 narrow lines, a page slice at a time: 1,000 of them would be 500 MB.
        for (let i = 0; i < WIDE_LINES / 100; i++) {
            await main.send('flood', { kind: 'messages', n: 100, prefix: `wline${i}`, conversationId, author: ann.pk, bytes: WIDE_LINE_BYTES });
        }
        const rssLines = (await main.send('lag-read')).rss;
        console.log(`  (written in ${((Date.now() - tLines) / 1000).toFixed(1)} s; M's RSS ${(rssLines / 1e6).toFixed(0)} MB)`);
        // Counted as the pages arrive and then dropped (`lean`): the whole copy is over a GB of rows.
        const linePages: { n: number; rows: number; mb: number; ms: number; lag: number }[] = [];
        const lineCounts: Record<string, number> = {};
        let wideLines = 0;
        let wholeLines = 0;
        await main.send('peak-reset');
        await main.send('lag-reset');
        const tLineCopy = Date.now();
        let wideLineCopy: { pages: any[] } | null = null;
        let linesError = '';
        try {
            wideLineCopy = await copy({
                lean: true,
                onPage: async (g) => {
                    const l = await main.send('lag-read');
                    const rows = rowsOf(g.page);
                    for (const { key, row } of rows) {
                        lineCounts[key] = (lineCounts[key] ?? 0) + 1;
                        if (key === 'messages' && /^wline\d+-/.test(row.id)) {
                            wideLines++;
                            if (row.ciphertext?.length === WIDE_LINE_BYTES) wholeLines++;
                        }
                    }
                    linePages.push({ n: g.page.n, rows: rows.length, mb: rows.reduce((a, r) => a + r.bytes, 0) / 1e6, ms: g.ms, lag: l.maxMs });
                    await main.send('lag-reset');
                },
            });
        } catch (e: any) {
            const code = await Promise.race([main.exited, sleep(2000).then(() => 'still running')]);
            linesError = `${e?.message || e}; M ${code === 'still running' ? 'is still running' : `exited (${code})`}${/heap out of memory/.test(main.output()) ? ', out of heap' : ''}`;
        }
        const linesMs = Date.now() - tLineCopy;
        require_(wideLineCopy !== null, `M serves the whole copy with the wide lines under a 512 MB heap: ${wideLineCopy ? `${wideLineCopy.pages.length} pages in ${(linesMs / 1000).toFixed(1)} s` : linesError}`);
        if (wideLineCopy) {
            const peak = await main.send('peak-read');
            const worst = linePages.reduce((a, p) => (p.lag > a.lag ? p : a), linePages[0]);
            const biggest = linePages.reduce((a, p) => (p.mb > a.mb ? p : a), linePages[0]);
            console.log(`  pages ${linePages.length}; the open (page 0) loop blocked up to ${linePages[0].lag.toFixed(0)} ms; worst page ${worst.n}: ${worst.rows} rows,`
                + ` ${worst.mb.toFixed(2)} MB, loop blocked up to ${worst.lag.toFixed(0)} ms; biggest page ${biggest.n}: ${biggest.rows} rows, ${biggest.mb.toFixed(2)} MB;`
                + ` peak RSS ${(peak.rss / 1e6).toFixed(0)} MB (before ${(rssLines / 1e6).toFixed(0)} MB), peak heap ${(peak.heap / 1e6).toFixed(0)} MB of ${(peak.heapLimit / 1e6).toFixed(0)} MB`);
            assert(sortKeys(flat(wideLineCopy.pages[0].rowCounts)) === sortKeys(lineCounts) && wideLines === WIDE_LINES && wholeLines === WIDE_LINES,
                `it carries every row its opening page counts, the ${WIDE_LINES.toLocaleString('en')} wide lines among them, each whole (${wideLines}, ${wholeLines} whole)`);
            assert(linePages.every((p) => p.rows <= 25_000 && p.mb * 1e6 <= 8 * 1024 * 1024), 'each page within 8 MB and 25,000 rows');
            assert(worst.lag < WIDE_LAG_MS, `no page held M's event loop ${WIDE_LAG_MS} ms (worst ${worst.lag.toFixed(0)} ms)`);
            assert(peak.heap < WIDE_HEAP_BYTES, `M's heap stays bounded: peak ${(peak.heap / 1e6).toFixed(0)} MB (< ${(WIDE_HEAP_BYTES / 1e6).toFixed(0)})`);
        }

        assert(unsigned.length === 0, `every page of every copy verifies, naming its copy and its number (${JSON.stringify(unsigned.slice(0, 5))})`);
        const blocked = (await main.send('fetches')).blocked;
        assert(blocked.length === 0, `M reached nothing off this machine (${JSON.stringify(blocked)})`);
    } catch (e: any) {
        console.error(`\n✗ suite aborted: ${e?.message || e}`);
        if (e?.output) console.error(String(e.output).slice(-3000));
        testsRun++;
    } finally {
        for (const n of nodes) await n.kill().catch(() => {});
    }

    console.log(`\n${testsPassed}/${testsRun} passed (${Math.round((Date.now() - started) / 1000)} s)`);
    process.exit(testsPassed === testsRun ? 0 : 1);
}

if (process.argv.includes('--child')) {
    child().catch((e) => { console.error('child failed:', e); process.exit(1); });
} else {
    main().catch((e) => { console.error('failed:', e?.message || e); process.exit(1); });
}
