/**
 * Test Suite: the standby builds a whole copy in pages in a staging database and swaps it in by rename at a restart (P2 of
 * scratch/global-node/DESIGN-paged-copies-fable.md, §4, §5 and §8's P2 row).
 *
 * A main server M and a standby S, each its own process with its own data dir (takeover-test-harness.ts), M serving its
 * real backup routes and S pulling through its real puller (`pullNow`, the loop's own step; `requestResync`, the
 * operator's). S reaches M through a proxy in this process, which passes every request on and can hold a page back, replay
 * one from another copy, change one, or change the last page's counts and sign it again with M's own key. M's page bounds
 * are scaled to 64 KB and 200 rows (SYNC_PAGE_BYTES, SYNC_PAGE_ROWS), so a small community takes many pages. A standby that
 * makes a whole copy ready restarts to swap it in, and the harness starts it again as Docker would. S's old row cap is
 * scaled to 150 (MAX_IMPORT_ROWS_PER_CATEGORY), as #1304's suite scales it: nothing refuses or leaves out a copy for its
 * size any more. Nothing leaves this machine.
 *
 *  1. S's first copy is M's in many pages, built in a staging database and swapped in at a restart, exact; S's own logs,
 *     cursors, node roles, avatar key and copy record come through the swap. The database it replaced is kept until the next
 *     copy lands, then deleted. (Before: one payload, imported over S's rows, no restart.)
 *  2. A flood of 160 chat lines past the scaled 150-row cap lands whole, by delta and in a whole copy. (Before: left out.)
 *  3. S killed between pages of a whole copy starts again with its old copy and no staging; its stager is gone too.
 *  4. M killed between pages: S discards the copy, keeps its own, takes deltas meanwhile, and takes a whole copy again
 *     after the reconcile interval.
 *  5. A page replayed from another copy, a page changed, a page held back (M answers 404 for it), and a last page whose
 *     counts differ (signed with M's key): each refused, S unchanged, no staging left, the why in S's record.
 *  6. A balance planted on S: a whole copy that is no seed is refused by the conservation guard at the closing check, S
 *     unchanged; the plant gone, the next lands.
 *  7. A listing photo M can't read from its own store: the copy leaves it out and names it, the closing check counts like
 *     with like (the opening page counts it, the last page's rows sent don't), and S keeps its own row through the swap.
 *  8. A delta of 3 pages, with a member re-keyed and a friendship of the old key deleted first: taken as one payload, in
 *     the importer's order, and S is M's.
 *  9. A delta of 5 pages is not taken: the next pull is a whole copy, which lands.
 * 10. A take-over confirmed on S while a whole copy is being built, the database S's last swap replaced still there: the
 *     copy is stopped and its staging deleted, and the promoted server holds the copy it had; that old database goes at the
 *     promoted server's start, once its audit found the ledger adds up. (Before: kept for good; its puller never runs again.)
 * 11. S's files capped (RLIMIT_FSIZE) during a whole copy: the stager runs out of room, the copy fails, and the live
 *     database was never written by it (its WAL stays small); S unchanged.
 * 12. A node_config key the replication manifest doesn't classify, planted on S: the closing check refuses the copy and
 *     names it; the key gone, the next lands.
 * 13. The routine whole copy's cadence: after a copy of more than one page, daily, not every reconcile interval; after a
 *     copy of one page, every interval, imported over S's rows with no restart.
 * 14. S's stager SIGKILLed between two pages (page 1 imported, the puller waiting to ask page 2): the pull fails at the
 *     next page, within seconds, its staging deleted and S unchanged; the next whole copy lands. (Before: the pull waited
 *     PAGE_TIMEOUT_MS, 15 minutes, holding every delta back.)
 * 15. S's orphan sweep run two hours ahead in the middle of a whole copy that brings 60 new listing photos: it removes none
 *     of them (the staging names them, though their objects were aged to before the copy began), nor an object nobody
 *     names written since the copy began; after the swap every photo's object is there, and the next sweep removes that
 *     object. A copy one of whose photo objects is removed while it stages is refused at the closing check, S unchanged,
 *     and the next lands. (Before: the sweep removed every one, and the copy landed "exact" without them.)
 * 16. M with more accounts than a delta's pages of rows (DELTA_PAGES x PAGE_ROWS), which every delta carries whole: four
 *     pulls in a row, a member edited before each, are four deltas that land, with no whole copy and no restart, and the
 *     database the last swap replaced goes at the first. A delta of more bytes than BACKUP_DELTA_BYTES (scaled) is not
 *     taken, and the next pull is a whole copy, which lands. After it, with too little room for a second copy but for that
 *     database's, a whole copy is refused saying so; with room once it goes, it goes first and the copy lands. (Before:
 *     no delta was ever taken, only a whole copy and a restart every other pull, and the database it replaced stayed.)
 * 17. A whole copy swapped in, the start's puller reading its marker, then S restarted before any copy landed: the database
 *     the swap replaced goes at the first delta after. (Before: only the start that read the marker deleted it, so it
 *     stayed for good, holding rows members deleted since.)
 * 18. S killed between the swap's two renames (state.db already state.previous.db, the staging database not yet state.db):
 *     the next start finishes the swap, S's copy row for row as it was, the old database kept; the first delta deletes it.
 * 19. A take-over whose audit finds trouble (a balance planted on the standby): the promoted server keeps the database its
 *     last swap replaced, saying the date it goes, 30 days from the audit; a start past that date deletes it. (Before: kept
 *     for good, a warning nobody on a stranger's install acts on.)
 * 20. S killed in the middle of deleting the database its last swap replaced, right before its `-wal` (where the review
 *     killed it): after a restart, the next delta leaves no file of it. And a `-wal` and `-shm` left on their own, as an older
 *     build's delete stopped part way left them, go at a main server's start. (Before: the WAL stayed for good, holding the
 *     rows it held.)
 * 21. S killed at boot between the swap's two renames (the review's kill point), its staged copy then torn, and started as
 *     a main server by hand: the staging is discarded and state.previous.db, S's own copy, is state.db again; the server runs
 *     on every member and message it had. (Before: it started on a new, empty database and deleted that copy as "the
 *     database the last swap replaced".)
 * 22. A main server a take-over promoted (its audit found trouble, so state.previous.db is kept), its state.db moved away by
 *     hand, then emptied: each start refuses, saying what is missing and what to do, and nothing is lost; the state.db put
 *     back, it runs on it. (Before: it ran as the main server on the older database, unaudited, and said nothing.)
 * 23. A standby whose state.db is moved away by hand: it puts state.previous.db back and the next delta brings it level
 *     with M.
 *
 * The pace of a copy of more than 300 pages against M's administrative limiter is test-standby-paged-copies-pacing.ts.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-paged-copies.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { privateKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys';
import { spawnNode, post, type NodeProc } from './takeover-test-harness.js';
import { runPagedCopyChild } from './paged-copies-test-harness.js';
import { lockedDm } from './dm-test-payload.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Paged-Copies-Main-Pw-7719!';
const PW_STANDBY = 'Paged-Copies-Standby-Pw-3304!';
/** M's page bounds, scaled down from 8 MB and 25,000 rows. */
const PAGE_BYTES = 64 * 1024;
const PAGE_ROWS = 200;
/** #1304's row cap, as its suite scales it (MAX_IMPORT_ROWS_PER_CATEGORY): no copy is left out or refused over it now. */
const CAP = 150;
const FLOOD = 160;
/** The most any file S writes may grow to in step 11 (RLIMIT_FSIZE): its own database fits, a copy with the flood doesn't. */
const CAPPED_BYTES = 6 * 1024 * 1024;
/** Step 7's listing photos M can't read at once: more than the thousand terms SQLite takes in one list. */
const BULK_PHOTOS = 1200;
/** Step 15's new listing photos, which a whole copy brings while S's orphan sweep runs. */
const NEW_PHOTOS = 60;
/** A delta's pages of changes at most (BACKUP_DELTA_PAGES, S's default). */
const DELTA_PAGES = 4;
/** How long M keeps a copy no page was asked of (SYNC_COPY_IDLE_MS), scaled down from two minutes. */
const COPY_IDLE_MS = 3000;
/** The wait after a refused force-resync or first copy (BACKUP_RESYNC_RETRY_MS), scaled down from an hour. */
const RETRY_MS = 3000;
/** The tables hashed on both servers, row for row, to show S is M's, or unchanged. */
const HASHED = [
    'members', 'member_preferences', 'accounts', 'transactions', 'marketplace_transactions', 'posts', 'post_photos', 'projects',
    'conversations', 'conversation_participants', 'messages', 'invite_codes', 'deferred_wage_claims', 'treasury_operators',
    'enterprise_pledges', 'invalidated_keys', 'groups', 'group_members', 'ratings', 'friends', 'tombstones', 'member_blocks',
];

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

type Snap = { tables: Record<string, { count: number; hash: string }>; format: string | null; cursor: string | null; ledgerSum: number };
/** Where two snapshots differ: each table's rows, the format record, the cursor. */
function snapDiff(a: Snap, b: Snap): string[] {
    const out: string[] = [];
    for (const [t, x] of Object.entries(a.tables)) {
        const y = b.tables[t];
        if (!y || x.hash !== y.hash) out.push(`${t} ${x.count}→${y?.count ?? 'none'}`);
    }
    if (a.format !== b.format) out.push(`format ${a.format}→${b.format}`);
    if (a.cursor !== b.cursor) out.push(`cursor ${a.cursor}→${b.cursor}`);
    return out;
}
const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 6).join(' | ')}`);
const counts = (s: Snap, ...ts: string[]) => ts.map((t) => `${t} ${s.tables[t]?.count}`).join(', ');
/** Every copied table S and M both hash, where they differ (engine/replica-hashes.ts). */
function hashDiff(s: Record<string, { rows: number; hash: string }>, m: Record<string, { rows: number; hash: string }>): string[] {
    return Object.keys(m).filter((t) => s[t] && (s[t].rows !== m[t].rows || s[t].hash !== m[t].hash)).map((t) => `${t} ${s[t].rows}/${m[t].rows}`);
}

/**
 * The proxy S reaches M through: every request passed on, and each copy's pages recorded. `fault` changes the page `page`
 * of the next copy opened: held back (404), replayed from an earlier copy, changed by a byte, or (the last page) its counts
 * changed and signed again with M's key.
 */
type Fault = { kind: 'withhold' | 'replay' | 'tamper' | 'counts'; page: number } | null;
interface Proxy {
    url: string;
    setTarget: (base: string) => void;
    arm: (f: Fault) => void;
    /** Copies opened, whole or delta, and the pages served of each (by copy id: every page's text). */
    copies: Map<string, { since: string | null; pages: Map<number, string> }>;
    opened: string[];
    statuses: number[];
    close: () => void;
}
async function startProxy(target: string, mainKeyFile: () => string): Promise<Proxy> {
    let base = target;
    let fault: Fault = null;
    let faultCopy: string | null = null;
    const copies = new Map<string, { since: string | null; pages: Map<number, string> }>();
    const opened: string[] = [];
    const statuses: number[] = [];
    const resign = async (page: Record<string, unknown>): Promise<string> => {
        const key = privateKeyFromProtobuf(fs.readFileSync(mainKeyFile()));
        const { signature: _s, publicKey: _p, ...rest } = page;
        const text = JSON.stringify(rest);
        const sig = Buffer.from(await key.sign(new TextEncoder().encode(text))).toString('hex');
        return `${text.slice(0, -1)},"signature":${JSON.stringify(sig)},"publicKey":${JSON.stringify(Buffer.from(publicKeyToProtobuf(key.publicKey)).toString('hex'))}}`;
    };
    const server = http.createServer((req, res) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'content-length') headers[k] = v;
            let status = 502;
            let raw: Buffer = Buffer.alloc(0);
            const outHeaders: Record<string, string> = {};
            try {
                const up = await fetch(base + req.url, { method: req.method, headers, body: chunks.length > 0 ? Buffer.concat(chunks) : undefined });
                status = up.status;
                raw = status === 304 ? Buffer.alloc(0) : Buffer.from(await up.arrayBuffer());
                for (const k of ['content-type', 'x-node-role', 'cache-control', 'etag']) { const v = up.headers.get(k); if (v) outHeaders[k] = v; }
            } catch {
                status = 502;
                raw = Buffer.from(JSON.stringify({ error: 'the main server is not answering' }));
            }
            const url = new URL(req.url ?? '/', 'http://proxy');
            const page = /^\/api\/local\/admin\/sync-copy(?:\/([^/]+)\/(\d+))?$/.exec(url.pathname);
            // Only a copy's pages are read as text (and may be changed); anything else goes on byte for byte.
            let body: string | Buffer = raw;
            if (page && status === 200 && req.method !== 'DELETE') {
                body = raw.toString('utf-8');
                let parsed: any = null;
                try { parsed = JSON.parse(body); } catch { /* not a page */ }
                if (parsed && typeof parsed.copyId === 'string') {
                    const n = Number(parsed.n);
                    if (n === 0) {
                        opened.push(parsed.copyId);
                        copies.set(parsed.copyId, { since: url.searchParams.get('since'), pages: new Map() });
                        if (fault && faultCopy === null) faultCopy = parsed.copyId;
                    }
                    copies.get(parsed.copyId)?.pages.set(n, body as string);
                    if (fault && faultCopy === parsed.copyId && (fault.kind === 'counts' ? parsed.last === true : n === fault.page)) {
                        const f = fault;
                        fault = null;
                        faultCopy = null;
                        if (f.kind === 'withhold') {
                            status = 404;
                            body = JSON.stringify({ error: 'no such copy' });
                        } else if (f.kind === 'replay') {
                            const other = [...copies.entries()].find(([id, c]) => id !== parsed.copyId && c.pages.has(n));
                            if (other) body = other[1].pages.get(n)!;
                        } else if (f.kind === 'tamper') {
                            body = (body as string).replace(/"ciphertext":"(.)/, (_m, ch) => `"ciphertext":"${ch === 'A' ? 'B' : 'A'}`);
                        } else if (f.kind === 'counts') {
                            parsed.rowsSent = { ...parsed.rowsSent, messages: (parsed.rowsSent?.messages ?? 0) + 1 };
                            body = await resign(parsed);
                        }
                    }
                }
            }
            statuses.push(status);
            res.writeHead(status, outHeaders);
            res.end(body);
        })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        setTarget: (b) => { base = b; },
        arm: (f) => { fault = f; faultCopy = null; },
        copies, opened, statuses,
        close: () => server.close(),
    };
}

/** Whether a process is still running. */
function alive(pid: number | null | undefined): boolean {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until(what: string, cond: () => Promise<boolean> | boolean, ms = 20_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return true;
        await sleep(50);
    }
    console.error(`  (waited ${ms} ms for ${what})`);
    return false;
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const envM = {
        ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', NODE_ENV: 'test',
        SYNC_PAGE_BYTES: String(PAGE_BYTES), SYNC_PAGE_ROWS: String(PAGE_ROWS),
        // A copy a standby left unfinished (it was killed) closes after this, not two minutes (SYNC_COPY_IDLE_MS).
        SYNC_COPY_IDLE_MS: String(COPY_IDLE_MS),
    };
    const envS = {
        ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000',
        MAX_IMPORT_ROWS_PER_CATEGORY: String(CAP), BACKUP_RESYNC_RETRY_MS: String(RETRY_MS), BACKUP_PAGE_GAP_MS: '0',
    };
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee] = ['Ann', 'Bo', 'Cy', 'Dee'].map(newId);
    let proxy: Proxy | null = null;

    // Each step on its own: one that fails says so and the next still runs (on origin/main, where there are no pages).
    // PAGED_STEPS_UNTIL=<n>: only the first n steps (each builds on the one before), for a quicker look at one.
    const until_ = Number(process.env.PAGED_STEPS_UNTIL) || Infinity;
    const step = async (title: string, fn: () => Promise<void>) => {
        if (Number.parseInt(title, 10) > until_) return;
        console.log(`\n— ${title} —`);
        const t = Date.now();
        try { await fn(); } catch (e: any) { assert(false, `${title}: ${e?.message || e}`); }
        console.log(`  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    };

    try {
        // ── M, and S set up against it through the proxy ──
        let main = await spawnNode(SCRIPT, dir('main'), envM);
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        let m = `https://localhost:${await main.send('serve')}`;
        await main.send('settle-pricing');
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
        built('the admin makes Gwen an Elder (a credit line to buy with)', await api(m, 'POST', `/api/local/admin/users/${gwen.pk}/elder`, { admin: PW_MAIN, body: { grant: true } }));
        await offer(gwen, 'Sourdough', 4);
        const honey = await offer(ann, 'Honey', 20);
        const tx = built('Gwen asks for the honey', await As(gwen, '/api/marketplace/posts/request', { postId: honey.id, buyerPublicKey: gwen.pk })).transaction;
        built('Ann approves: the Beans are held', await As(ann, '/api/marketplace/transactions/approve', { transactionId: tx.id, authorPublicKey: ann.pk }));
        built('Gwen confirms: the Beans are released', await As(gwen, '/api/marketplace/transactions/complete', { transactionId: tx.id, confirmerPublicKey: gwen.pk }));
        // A listing photo, and a friendship to end before a re-key (step 8).
        await main.send('sql', { sql: `INSERT INTO post_photos (post_id, photo_data, order_num, updated_at) VALUES (?, ?, 0, ?)`, args: [honey.id, TINY_PNG, new Date().toISOString()] });
        built('Bo adds Cy as a friend', await As(bo, '/api/friends/add', { ownerPubkey: bo.pk, friendPubkey: cy.pk }));
        const conv = built('Ann opens a DM with Bo', await As(ann, '/api/messages/conversation', { type: 'dm', participants: [ann.pk, bo.pk], createdBy: ann.pk }));
        const conversationId: string = conv.conversation?.id ?? conv.id;
        for (let i = 0; i < 3; i++) built('Ann writes to Bo', await As(ann, '/api/messages/send', { conversationId, authorPubkey: ann.pk, ...lockedDm() }));
        // Enough rows for many pages of 200.
        await main.send('flood', { kind: 'messages', n: 600, conversationId, author: ann.pk });

        proxy = await startProxy(main.base, () => path.join(dir('main'), 'libp2p_key'));
        const px = proxy;
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), envS);
        nodes.push(standby);
        let standbyDir = dir('standby');
        await standby.send('setup-standby', { primaryUrl: px.url, replicationToken, primaryPeerId: main.ready.peerId });
        const S = () => standby;
        const snapS = async (): Promise<Snap> => S().send('snapshot', { tables: HASHED });
        const snapM = async (): Promise<Snap> => main.send('snapshot', { tables: HASHED });
        const exactNow = async () => hashDiff(await S().send('hashes'), await main.send('hashes'));
        /** A pull (a whole one when `whole`); one that made a copy ready is waited for until S has started again on it. */
        const pullAndSwap = async (whole: boolean) => {
            const before = standby.swaps();
            const p = await standby.send('pull', whole ? { whole: true } : {});
            if (p.staged) await until('S to start again on the new copy', () => standby.swaps() > before, 60_000);
            return p;
        };
        const wholeCopy = () => pullAndSwap(true);
        /** M's recovery code, made in step 10 (a second would replace it). */
        let recoveryCode: string | null = null;
        /** Kill S and start it again on its data dir, as a crash and Docker would. */
        const restartS = async (opts: { maxFileBytes?: number } = {}) => {
            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, standbyDir, envS, opts);
            nodes.push(standby);
        };

        await step('1. S\'s first copy: M\'s, in many pages, built in a staging database and swapped in at a restart', async () => {
            await standby.send('plant-own', { owner: dee.pk });
            const own0 = await standby.send('own');
            const rec0 = await standby.send('record');
            const opened0 = px.opened.length;
            const first1 = await standby.send('pull', {});
            const copyId = px.opened[opened0];
            const pages = copyId ? px.copies.get(copyId)?.pages.size ?? 0 : 0;
            assert(first1.ok === true && first1.mode === 'resync' && first1.staged === true,
                `S's first pull is the format re-seed, made ready to swap in (${JSON.stringify(first1)})`);
            await until('S to start again on the new copy', () => standby.swaps() >= 1);
            const st1 = await standby.send('staging');
            assert(standby.swaps() === 1 && !st1.staging && st1.previous, `S restarted once, the staging swapped in and gone, the old database kept beside it (${JSON.stringify({ swaps: standby.swaps(), ...st1 })}; before: no restart)`);
            assert(pages >= 4, `the copy came in ${pages} pages of at most ${PAGE_ROWS} rows (before: one payload)`);
            const diff = await exactNow();
            const rec1 = await standby.send('record');
            assert(diff.length === 0 && rec1.lastWhole?.exact === true && rec1.lastOutcome === 'ok',
                `S is M's, every copied table, and its record says exact (differences ${first(diff)}; ${JSON.stringify(rec1.lastWhole)})`);
            const own1 = await standby.send('own');
            // Its own role row as it was (the genesis member's owner row is every start's own backfill, on any node with members).
            const roleOf = (roles: { member_pubkey: string; role: string }[], pk: string) => roles.find((r) => r.member_pubkey === pk)?.role ?? null;
            assert(own1.marker === own0.marker && own0.marker > 0 && own1.otherCursor === own0.otherCursor && own1.otherCursor !== null
                && roleOf(own1.roles, dee.pk) === 'admin' && roleOf(own0.roles, dee.pk) === 'admin' && own1.avatarKey === own0.avatarKey
                && own1.standbyHealthNote === own0.standbyHealthNote && own0.standbyHealthNote !== null && rec1.id === rec0.id,
                `S's own log line, its other cursor, its node role, a setting of its own and its copy record's id came through the swap (${JSON.stringify({ before: own0, after: own1, id: [rec0.id, rec1.id] })})`);
            const s1 = await snapS();
            const m1 = await snapM();
            assert(s1.format === '7' && s1.cursor !== null && s1.tables.messages.count === m1.tables.messages.count,
                `S's copy is format 7, with its cursor, and all ${m1.tables.messages.count} of M's chat lines (${JSON.stringify({ format: s1.format, cursor: s1.cursor })}; ${counts(s1, 'messages')})`);
            const d1 = await standby.send('pull', {});
            const st1b = await standby.send('staging');
            assert(d1.ok === true && d1.mode === 'delta' && !st1b.previous, `the next pull is a delta, and once it lands the old database is deleted (${JSON.stringify({ pull: d1, ...st1b })})`);
        });

        await step('2. a flood past the old row cap lands whole: by delta, and in a whole copy', async () => {
            await main.send('flood', { kind: 'messages', n: FLOOD, conversationId, author: ann.pk });
            const d2 = await standby.send('pull', {});
            const s2 = await snapS();
            const m2 = await snapM();
            const r2 = await standby.send('record');
            assert(d2.ok === true && d2.mode === 'delta' && s2.tables.messages.count === m2.tables.messages.count && r2.lastLeftOut === null,
                `S's delta carries all ${FLOOD} lines, over the old cap of ${CAP} (${JSON.stringify(d2)}; ${counts(s2, 'messages')}, M ${counts(m2, 'messages')}; left out ${JSON.stringify(r2.lastLeftOut)}; before: left out)`);
            const w2 = await wholeCopy();
            const r2w = await standby.send('record');
            const diff = await exactNow();
            assert(w2.ok === true && w2.staged === true && r2w.lastWhole?.exact === true && diff.length === 0 && r2w.lastLeftOut === null,
                `a whole copy of it all lands in pages, exact, nothing left out (${JSON.stringify({ pull: w2, whole: r2w.lastWhole })}; differences ${first(diff)}; before: messages left out)`);
        });

        await step('3. S killed between pages: it starts again with its old copy, and no staging', async () => {
            await main.send('flood', { kind: 'messages', n: 20, conversationId, author: ann.pk });
            await standby.send('pull', {}); // a delta: S is M's again
            await standby.send('checkpoint');
            const before = await snapS();
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '400' } });
            await main.send('flood', { kind: 'messages', n: 5, conversationId, author: ann.pk }); // M moves on: the copy would change S
            const opened = px.opened.length;
            void standby.send('pull', { whole: true }).catch(() => { /* killed */ });
            const midway = await until('two pages of the copy', () => {
                const id = px.opened[opened];
                return !!id && (px.copies.get(id)?.pages.size ?? 0) >= 2;
            });
            const st3 = await standby.send('staging');
            const pid = st3.building?.pid ?? null;
            assert(midway && st3.staging && alive(pid), `the copy is part-built: its staging and its stager are there (${JSON.stringify(st3)})`);
            await restartS();
            const stagerGone = await until('the stager to stop', () => !alive(pid), 10_000);
            const st3b = await standby.send('staging');
            const after = await snapS();
            assert(stagerGone && !st3b.staging && snapDiff(before, after).length === 0,
                `S starts again with no staging, its stager gone, and its copy as it was, row for row (differences ${first(snapDiff(before, after))}; ${JSON.stringify(st3b)})`);
            // M still serves the copy S left: busy until it idles out.
            const busy = await standby.send('pull', { whole: true });
            assert(busy.ok === false && /HTTP 409/.test(busy.error ?? ''), `M answers the next whole copy "busy" while the one S left is open (${JSON.stringify(busy)})`);
            await sleep(COPY_IDLE_MS + 500);
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '0' } });
            const p3 = await wholeCopy();
            assert(p3.ok === true && p3.staged === true && (await exactNow()).length === 0, `the next whole copy lands, and S is M's (${JSON.stringify(p3)})`);
        });

        await step('4. M killed between pages: S discards the copy, takes deltas, and a whole copy again after the interval', async () => {
            const before = await snapS();
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '400', BACKUP_RECONCILE_EVERY_MS: '4000', BACKUP_BIG_COPY_EVERY_MS: '4000' } });
            await sleep(4100); // the routine whole copy is due
            const opened = px.opened.length;
            const pulling = standby.send('pull', {});
            await until('two pages of the copy', () => {
                const id = px.opened[opened];
                return !!id && (px.copies.get(id)?.pages.size ?? 0) >= 2;
            });
            await main.kill('SIGKILL');
            const p4 = await pulling;
            const st4 = await standby.send('staging');
            const mid = await snapS();
            const r4 = await standby.send('record');
            assert(p4.ok === false && p4.mode === 'full' && !st4.staging && st4.building === null && snapDiff(before, mid).length === 0 && r4.lastOutcome === 'fetch-failed',
                `S's copy stops at the page M never sent: its staging deleted, S as it was, the record "no copy came" (${JSON.stringify({ pull: p4, staging: st4, why: r4.lastWhy })}; differences ${first(snapDiff(before, mid))})`);
            main = await spawnNode(SCRIPT, dir('main'), envM);
            nodes.push(main);
            px.setTarget(main.base);
            m = `https://localhost:${await main.send('serve')}`;
            await main.send('settle-pricing');
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '0' } });
            built('Bo offers eggs on M after its restart', await As(bo, '/api/marketplace/posts', {
                type: 'offer', category: 'food', title: 'Eggs', description: 'Eggs', credits: 2, priceType: 'fixed', authorPublicKey: bo.pk,
            }));
            const d4 = await standby.send('pull', {});
            assert(d4.ok === true && d4.mode === 'delta', `within the interval, the next pull is a delta, and it lands (${JSON.stringify(d4)})`);
            await sleep(4100);
            const w4 = await pullAndSwap(false);
            const r4w = await standby.send('record');
            const diff4 = await exactNow();
            assert(w4.ok === true && w4.mode === 'full' && w4.staged === true && r4w.lastWhole?.exact === true && diff4.length === 0,
                `after the interval the whole copy is asked again, lands exact, and S is M's (${JSON.stringify({ pull: w4, whole: r4w.lastWhole })}; differences ${first(diff4)})`);
            await standby.send('set-env', { vars: { BACKUP_RECONCILE_EVERY_MS: '86400000', BACKUP_BIG_COPY_EVERY_MS: null } });
        });

        // A whole copy through the proxy with a fault: refused, S exactly as it was, no staging left.
        const faulted = async (kind: 'replay' | 'tamper' | 'withhold' | 'counts', page: number, why: RegExp, whyCode: string) => {
            await standby.send('checkpoint');
            const before = await snapS();
            const opened = px.opened.length;
            px.arm({ kind, page });
            const p = await standby.send('pull', { whole: true });
            const st = await standby.send('staging');
            const after = await snapS();
            const r = await standby.send('record');
            const id = px.opened[opened];
            const served = id ? px.copies.get(id)?.pages.size ?? 0 : 0;
            assert(p.ok === false && why.test(p.error ?? '') && !st.staging && st.building === null && snapDiff(before, after).length === 0 && r.lastWhy === whyCode && served >= 2,
                `${kind} of page ${page}: refused (${String(p.error).slice(0, 140)}), S unchanged, no staging, the record says ${r.lastWhy} (differences ${first(snapDiff(before, after))}; ${served} page(s) served)`);
        };
        await step('5. a page replayed, changed, held back, or a last page whose counts differ: each refused, S unchanged', async () => {
            await faulted('replay', 1, /another copy|page 1 of copy/, 'import-error');
            await faulted('tamper', 2, /signature/i, 'signature');
            await faulted('withhold', 2, /HTTP 404/, 'http-404');
            await faulted('counts', -1, /don't add up|sent/, 'import-error');
            const p5 = await wholeCopy();
            assert(p5.ok === true && p5.staged === true && (await exactNow()).length === 0, `with nothing in the way, the next whole copy lands (${JSON.stringify(p5)})`);
        });

        await step('6. a balance planted on S: a copy that is no seed is refused by the conservation guard, S unchanged', async () => {
            await standby.send('sql', { sql: 'UPDATE accounts SET balance = balance + 7 WHERE public_key = ?', args: [ann.pk] });
            await standby.send('checkpoint');
            const before = await snapS();
            const opened = px.opened.length;
            const p6 = await standby.send('pull', { whole: true });
            const served = px.copies.get(px.opened[opened] ?? '')?.pages.size ?? 0;
            const after = await snapS();
            const r6 = await standby.send('record');
            const st6 = await standby.send('staging');
            assert(p6.ok === false && /conservation/i.test(p6.error ?? '') && /the copy's ledger totals/.test(p6.error ?? '') && served >= 2
                && r6.lastWhy === 'conservation' && snapDiff(before, after).length === 0 && Math.abs(after.ledgerSum - before.ledgerSum) < 1e-9 && !st6.staging,
                `the routine whole copy, all ${served} pages of it built, is refused at the closing check against S's live ledger; S's ledger as it was, the plant included (${JSON.stringify({ pull: p6, why: r6.lastWhy })}; total ${after.ledgerSum}; before: one payload refused by the import's own guard)`);
            await standby.send('sql', { sql: 'UPDATE accounts SET balance = balance - 7 WHERE public_key = ?', args: [ann.pk] });
            const p6b = await wholeCopy();
            assert(p6b.ok === true && p6b.staged === true && (await exactNow()).length === 0, `the plant gone, the next lands (${JSON.stringify(p6b)})`);
        });

        await step('7. listing photos M can\'t read: left out of the copy and named, and S keeps its own through the swap', async () => {
            const [photo] = await main.send('rows', { sql: 'SELECT post_id, order_num FROM post_photos' });
            require_(!!photo, 'M has a listing photo');
            // More photos of that listing, as many as a lost images directory would leave unreadable at once: past the thousand
            // SQLite would take as one list of terms, which the stager's carry-over must not be.
            await main.send('sql', {
                sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${BULK_PHOTOS})
                      INSERT INTO post_photos (post_id, photo_data, order_num, updated_at) SELECT ?, ?, i, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM n`,
                args: [photo.post_id, TINY_PNG],
            });
            const w7 = await wholeCopy();
            const onS0 = await standby.send('rows', { sql: 'SELECT post_id, order_num FROM post_photos ORDER BY order_num' });
            require_(w7.ok === true && onS0.length === BULK_PHOTOS + 1, `S holds M's ${BULK_PHOTOS + 1} photos (${onS0.length}; ${JSON.stringify(w7)})`);
            // Every one unreadable on M now: each names an object its store doesn't have.
            await main.send('sql', {
                sql: `UPDATE post_photos SET photo_data = NULL, storage_key = 'post-photos/gone/' || order_num || '.png', sha256 = ?, bytes = 70, mime = 'image/png' WHERE post_id = ?`,
                args: ['0'.repeat(64), photo.post_id],
            });
            const p7 = await wholeCopy();
            const onS = await standby.send('rows', { sql: 'SELECT post_id, order_num, photo_data, storage_key FROM post_photos ORDER BY order_num' });
            const r7 = await standby.send('record');
            const lastCopy = px.copies.get(px.opened[px.opened.length - 1] ?? '');
            const last = lastCopy ? JSON.parse(lastCopy.pages.get(Math.max(...lastCopy.pages.keys()))!) : null;
            const opening = lastCopy ? JSON.parse(lastCopy.pages.get(0)!) : null;
            assert(p7.ok === true && p7.staged === true && last?.photosOmitted?.length === BULK_PHOTOS + 1
                && opening?.rowCounts?.photos === BULK_PHOTOS + 1 && last?.rowsSent?.photos === 0,
                `the copy names the ${last?.photosOmitted?.length} photos it left out: counted in the opening page (${opening?.rowCounts?.photos}), not sent (${last?.rowsSent?.photos}), and the closing check lets it through (${JSON.stringify(p7)})`);
            assert(onS.length === BULK_PHOTOS + 1 && onS.every((r: any, i: number) => r.order_num === onS0[i].order_num && (r.photo_data ?? r.storage_key) !== null)
                && r7.lastWhole?.exact === true && r7.lastWhole?.photosLeftOut === BULK_PHOTOS + 1,
                `S keeps its own ${onS.length} rows of them through the swap, and the copy is exact but for them (${JSON.stringify({ whole: r7.lastWhole })})`);
            // M's photos readable again, and the extra ones gone, for the steps after: the next copy carries it.
            await main.send('sql', {
                sql: `UPDATE post_photos SET photo_data = ?, storage_key = NULL, sha256 = NULL, bytes = NULL, mime = NULL WHERE post_id = ? AND order_num = ?`,
                args: [TINY_PNG, photo.post_id, photo.order_num],
            });
            await main.send('sql', { sql: 'DELETE FROM post_photos WHERE post_id = ? AND order_num > ?', args: [photo.post_id, photo.order_num] });
            const w7b = await wholeCopy();
            assert(w7b.ok === true && (await exactNow()).length === 0, `M's photo readable again, the next whole copy brings it and S is M's (${JSON.stringify(w7b)})`);
        });

        await step('8. a delta of 3 pages, a member re-keyed after a friendship of the old key ended: one payload, S is M\'s', async () => {
            const bo2 = newId('Bo2');
            await main.send('unfriend', { owner: bo.pk, friend: cy.pk });
            require_(await main.send('rekey', { oldPk: bo.pk, newPk: bo2.pk, operator: gwen.pk }), 'Bo is re-keyed on M');
            await main.send('flood', { kind: 'messages', n: 380, conversationId, author: ann.pk });
            const opened = px.opened.length;
            const d8 = await standby.send('pull', {});
            const id = px.opened[opened];
            const pages = id ? px.copies.get(id)?.pages.size ?? 0 : 0;
            const diff = await exactNow();
            const friends = await standby.send('rows', { sql: 'SELECT owner_pubkey FROM friends WHERE owner_pubkey IN (?, ?)', args: [bo.pk, bo2.pk] });
            const inv = await standby.send('rows', { sql: 'SELECT reason, rekeyed_to FROM invalidated_keys WHERE public_key = ?', args: [bo.pk] });
            assert(d8.ok === true && d8.mode === 'delta' && pages === 3 && diff.length === 0 && friends.length === 0 && inv[0]?.rekeyed_to === bo2.pk,
                `the delta came in ${pages} pages and landed as one: S is M's, the ended friendship stays ended under Bo's new key, and the old key is replaced (${JSON.stringify(d8)}; differences ${first(diff)}; friends ${friends.length}; before: one payload, its 380 lines left out over the cap)`);
        });

        await step('9. a delta of 5 pages is not taken: the next pull is a whole copy, which lands', async () => {
            await main.send('flood', { kind: 'messages', n: 900, conversationId, author: ann.pk });
            const opened = px.opened.length;
            const d9 = await standby.send('pull', {});
            const id = px.opened[opened];
            const served = id ? px.copies.get(id)?.pages.size ?? 0 : 0;
            const s9 = await snapS();
            const m9 = await snapM();
            assert(d9.ok === true && d9.mode === 'delta' && served === 1 && s9.tables.messages.count < m9.tables.messages.count,
                `the delta's opening page says it holds more than 4 pages: no other page asked, nothing taken (${JSON.stringify(d9)}; ${served} page(s) served; before: taken, its lines left out over the cap)`);
            const w9 = await pullAndSwap(false);
            assert(w9.ok === true && w9.mode === 'full' && w9.staged === true && (await exactNow()).length === 0,
                `the next pull is a whole copy, which lands, and S is M's (${JSON.stringify(w9)})`);
        });

        await step('10. a take-over confirmed while a whole copy is being built: the copy stops, and the promoted server holds the copy it had', async () => {
            const env10 = await main.send('make-envelope');
            recoveryCode = env10.code;
            const held = await standby.send('envelope');
            require_(held === 'stored', `S holds M's take-over envelope (${held})`);
            await standby.send('checkpoint');
            const before = await snapS();
            await main.send('flood', { kind: 'messages', n: 30, conversationId, author: ann.pk });
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '400' } });
            await standby.send('takeover-restart-off');
            const opened = px.opened.length;
            const pulling = standby.send('pull', { whole: true });
            await until('two pages of the copy', () => {
                const id = px.opened[opened];
                return !!id && (px.copies.get(id)?.pages.size ?? 0) >= 2;
            });
            const st10 = await standby.send('staging');
            const pid = st10.building?.pid ?? null;
            require_(st10.previous, `the database S's last swap replaced is there (${JSON.stringify(st10)})`);
            const pw = { 'X-Admin-Password': PW_STANDBY };
            const openT = await post(standby.base, '/api/local/admin/takeover/open', { code: env10.code }, pw);
            const confirmT = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: openT.body?.preview?.sessionId, confirm: true }, pw);
            const p10 = await pulling;
            const st10b = await standby.send('staging');
            const stagerGone = await until('the stager to stop', () => !alive(pid), 10_000);
            assert(st10.staging && confirmT.status === 200 && p10.ok === false && !st10b.staging && stagerGone,
                `the confirm stops the copy being built: its stager killed, its staging deleted, the pull refused (${JSON.stringify({ confirm: confirmT.status, pull: p10, staging: st10b })})`);
            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, dir('standby'), envS);
            nodes.push(standby);
            const role = await standby.send('role');
            const after = await snapS();
            assert(role === 'primary' && after.tables.messages.count === before.tables.messages.count,
                `S starts as the main server on the copy it had, not the one being built (${JSON.stringify({ role, messages: [before.tables.messages.count, after.tables.messages.count] })})`);
            const st10c = await standby.send('staging');
            const audit = await standby.send('audit');
            assert(st10b.previous && !st10c.previous && audit?.ok === true,
                `the database S's last swap replaced, there until the restart, is gone at the promoted server's start, once its audit found the ledger adds up `
                + `(${JSON.stringify({ beforeRestart: st10b.previous, after: st10c.previous, audit })}; before: kept for good, its puller never running again)`);
        });

        // The standby took over: a new one for the rest, set up from nothing.
        const newStandby = async (name: string, opts: { maxFileBytes?: number } = {}) => {
            fs.mkdirSync(dir(name), { recursive: true });
            fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir(name), 'genesis.json'));
            standby = await spawnNode(SCRIPT, dir(name), envS, opts);
            nodes.push(standby);
            standbyDir = dir(name);
            await standby.send('setup-standby', { primaryUrl: px.url, replicationToken, primaryPeerId: main.ready.peerId });
            await sleep(COPY_IDLE_MS + 500); // a copy the standby before it left open on M closes first
            const p = await pullAndSwap(false);
            require_(p.ok === true && p.staged === true && (await exactNow()).length === 0, `a new standby's first copy lands (${JSON.stringify(p)})`);
            return name;
        };

        await step('11. S\'s files capped: the stager runs out of room, the copy fails, and the live database was never written by it', async () => {
            await main.send('unflood');
            const name = await newStandby('standby2');
            // More than S's files may grow to, below: a copy of it needs more room than that, S's own database doesn't.
            await main.send('flood', { kind: 'long-messages', n: 6000, conversationId, author: ann.pk });
            await standby.send('pull', {}); // too big a delta: a whole copy next
            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, dir(name), envS, { maxFileBytes: CAPPED_BYTES });
            nodes.push(standby);
            await standby.send('checkpoint');
            const files0 = await standby.send('files');
            const before = await snapS();
            const p11 = await standby.send('pull', { whole: true });
            const files1 = await standby.send('files');
            const after = await snapS();
            const st11 = await standby.send('staging');
            assert(p11.ok === false && /disk|SQLITE|I\/O|stager/i.test(p11.error ?? '') && snapDiff(before, after).length === 0 && !st11.staging
                && files1.wal < 512 * 1024 && files1.db === files0.db && files0.db < CAPPED_BYTES,
                `the copy fails in the stager, S unchanged, no staging; its live file as it was and its WAL small (${JSON.stringify({ pull: p11, files0, files1 })}; differences ${first(snapDiff(before, after))}; before: the import wrote the copy into the live WAL until the disk refused)`);
            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, dir(name), envS);
            nodes.push(standby);
            const p11b = await wholeCopy();
            assert(p11b.ok === true && p11b.staged === true && (await exactNow()).length === 0, `with room again, it lands (${JSON.stringify(p11b)})`);
        });

        await step('12. a node_config key the manifest doesn\'t classify: the closing check refuses the copy', async () => {
            await standby.send('sql', { sql: `INSERT OR REPLACE INTO node_config (key, value) VALUES ('test_unclassified_key', 'x')` });
            await standby.send('checkpoint');
            const before = await snapS();
            const p12 = await standby.send('pull', { whole: true });
            const after = await snapS();
            assert(p12.ok === false && /test_unclassified_key/.test(p12.error ?? '') && snapDiff(before, after).length === 0,
                `refused, naming the key, S unchanged (${JSON.stringify(p12)}; differences ${first(snapDiff(before, after))})`);
            await standby.send('sql', { sql: `DELETE FROM node_config WHERE key = 'test_unclassified_key'` });
            const p12b = await wholeCopy();
            assert(p12b.ok === true && p12b.staged === true, `the key gone, the next lands (${JSON.stringify(p12b)})`);
        });

        await step('13. the routine whole copy\'s cadence: daily after a copy of many pages, every interval after one of one page', async () => {
            await standby.send('set-env', { vars: { BACKUP_RECONCILE_EVERY_MS: '2000' } });
            await sleep(2100);
            const many = await standby.send('pull', {});
            assert(many.ok === true && many.mode === 'delta' && many.lastWholePages > 1,
                `after a whole copy of ${many.lastWholePages} pages, the routine interval passed asks for none (a delta; ${JSON.stringify(many)}; before: a whole copy every interval)`);
            // M small again, and its pages the real size: an operator's force-resync makes S M's exactly, in one page.
            await main.send('unflood');
            await main.send('set-env', { vars: { SYNC_PAGE_ROWS: '25000', SYNC_PAGE_BYTES: String(8 * 1024 * 1024) } });
            const n0 = standby.swaps();
            const resync = await standby.send('resync');
            await until('S to start again on the new copy', () => standby.swaps() > n0, 60_000);
            const after = await standby.send('pull', {});
            require_(resync.ok === true && resync.restarting === true && after.lastWholePages === 1, `an operator's force-resync of the small copy lands, in one page (${JSON.stringify({ resync, after })})`);
            await standby.send('set-env', { vars: { BACKUP_RECONCILE_EVERY_MS: '2000' } }); // the new start has its own environment
            await sleep(2100);
            const n1 = standby.swaps();
            const small = await standby.send('pull', {});
            const r13 = await standby.send('record');
            assert(small.ok === true && small.mode === 'full' && small.staged === false && small.lastWholePages === 1 && r13.lastWhole?.exact === true && standby.swaps() === n1,
                `after a whole copy of one page, the interval asks for another, imported over S's rows and checked exact, with no restart (${JSON.stringify({ small, whole: r13.lastWhole })})`);
            await standby.send('set-env', { vars: { BACKUP_RECONCILE_EVERY_MS: '86400000' } });
            await main.send('set-env', { vars: { SYNC_PAGE_ROWS: String(PAGE_ROWS), SYNC_PAGE_BYTES: String(PAGE_BYTES) } });
        });

        await step('14. S\'s stager killed between two pages: the pull fails at the next page, within seconds, and the next copy lands', async () => {
            await main.send('flood', { kind: 'messages', n: 600, conversationId, author: ann.pk });
            await standby.send('pull', {}); // a delta: S is M's
            await main.send('flood', { kind: 'messages', n: 5, conversationId, author: ann.pk }); // M moves on: the copy would change S
            await standby.send('checkpoint');
            const before = await snapS();
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '1500' } });
            const opened = px.opened.length;
            const pulling = standby.send('pull', { whole: true });
            // Page 1 served, then imported (its file gone from data/staging/pages): the puller waits out its gap before page 2.
            await until('page 1 of the copy', () => {
                const id = px.opened[opened];
                return !!id && (px.copies.get(id)?.pages.size ?? 0) >= 2;
            });
            await sleep(400);
            const st14 = await standby.send('staging');
            const pid = st14.building?.pid ?? null;
            const served = px.copies.get(px.opened[opened] ?? '')?.pages.size ?? 0;
            require_(st14.staging && st14.pages === 0 && served === 2 && alive(pid),
                `between two pages: pages 0 and 1 in the staging, page 2 not asked yet, the stager waiting (${JSON.stringify({ ...st14, served })})`);
            process.kill(pid!, 'SIGKILL');
            const killedAt = Date.now();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const p14 = await Promise.race([pulling, new Promise<null>((r) => { timer = setTimeout(() => r(null), 30_000); })]);
            clearTimeout(timer);
            const secs = (Date.now() - killedAt) / 1000;
            const st14b = await standby.send('staging');
            const after = await snapS();
            const r14 = await standby.send('record');
            assert(p14 !== null && p14.ok === false && /stager stopped/.test(p14.error ?? '') && secs < 10 && !st14b.staging && st14b.building === null
                && snapDiff(before, after).length === 0 && r14.lastOutcome === 'refused',
                `the pull fails ${secs.toFixed(1)} s after the kill, at page 2 (${JSON.stringify(p14)}): its staging deleted, S as it was, the record "refused" `
                + `(differences ${first(snapDiff(before, after))}; ${JSON.stringify(st14b)}; before: it waited PAGE_TIMEOUT_MS, 15 minutes)`);
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '0' } });
            // S's close of the copy it left waits out its page gap; M has closed it, or idled it out, by then.
            await sleep(COPY_IDLE_MS + 500);
            const p14b = await wholeCopy();
            assert(p14b.ok === true && p14b.staged === true && (await exactNow()).length === 0, `the next whole copy lands, and S is M's (${JSON.stringify(p14b)})`);
        });

        await step('15. the orphan sweep while a whole copy stages removes none of its photos; a copy whose photo object is gone is refused', async () => {
            const [honey] = await main.send('rows', { sql: `SELECT id FROM posts WHERE title = 'Honey'` });
            require_(!!honey, 'M has the honey listing');
            await main.send('sql', {
                sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${NEW_PHOTOS})
                      INSERT INTO post_photos (post_id, photo_data, order_num, updated_at) SELECT ?, ?, 100 + i, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM n`,
                args: [honey.id, TINY_PNG],
            });
            const liveKeys = new Set((await standby.send('photo-objects')).keys as string[]);
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '1000' } });
            const pulling = pullAndSwap(true);
            // The photos' page imported, and more pages to come: the copy is part-built, and only its staging names them.
            let staged: { storage_key: string }[] = [];
            const midway = await until('the new photos in the staging', async () => {
                staged = (await standby.send('staged-photos')) ?? [];
                return staged.length >= NEW_PHOTOS + 1 && (await standby.send('staging')).building !== null;
            });
            const fresh = staged.map((r) => r.storage_key).filter((k) => !liveKeys.has(k));
            require_(midway && fresh.length === NEW_PHOTOS, `the copy is part-built, and its staging alone names the ${fresh.length} new photos`);
            // Their objects as old as three hours: only the staging's names keep them. And an object nobody names, written
            // now: only the copy's start keeps it.
            await standby.send('age-objects', { keys: fresh, ms: 3 * 60 * 60_000 });
            const planted = 'posts/planted-during-the-copy/0-00000000.png';
            await standby.send('put-object', { key: planted });
            const swept = await standby.send('sweep', { aheadMs: 2 * 60 * 60_000 });
            const gone = await standby.send('missing-objects', { keys: [...fresh, planted] });
            assert(gone.length === 0, `the sweep, two hours ahead in the middle of the copy, removes none of its ${fresh.length} photos nor the object written since it began `
                + `(${JSON.stringify({ swept, gone: gone.slice(0, 3) })}; before: it removed every photo only the staging names)`);
            const p15 = await pulling;
            const photos = await standby.send('photo-objects');
            const r15 = await standby.send('record');
            assert(p15.ok === true && p15.staged === true && photos.keys.length >= NEW_PHOTOS + 1 && photos.missing.length === 0 && r15.lastWhole?.exact === true,
                `the copy lands, and every one of S's ${photos.keys.length} listing photos has its object (missing ${JSON.stringify(photos.missing.slice(0, 3))}; ${JSON.stringify(p15)})`);
            const after = await standby.send('sweep', { aheadMs: 2 * 60 * 60_000 });
            const plantedGone = (await standby.send('missing-objects', { keys: [planted] })).length === 1;
            assert(plantedGone && (await standby.send('photo-objects')).missing.length === 0,
                `with no copy staging, the next sweep removes the object nobody names, and no photo's (${JSON.stringify(after)})`);

            // A photo object removed while the copy stages: the closing check refuses the copy.
            await standby.send('checkpoint');
            const before = await snapS();
            const pulling2 = standby.send('pull', { whole: true });
            let staged2: { storage_key: string }[] = [];
            await until('the photos in the staging', async () => {
                staged2 = (await standby.send('staged-photos')) ?? [];
                return staged2.length >= NEW_PHOTOS + 1 && (await standby.send('staging')).building !== null;
            });
            const lost = staged2.map((r) => r.storage_key).find((k) => fresh.includes(k)) ?? '';
            await standby.send('rm-object', { key: lost });
            const p15b = await pulling2;
            const st15 = await standby.send('staging');
            const r15b = await standby.send('record');
            assert(p15b.ok === false && /no object in this server's image store/.test(p15b.error ?? '') && (p15b.error ?? '').includes(lost)
                && !st15.staging && snapDiff(before, await snapS()).length === 0 && r15b.lastOutcome === 'refused',
                `a copy whose photo object is gone is refused at the closing check, naming it, S unchanged, no staging (${JSON.stringify(p15b)}; before: it landed exact)`);
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '0' } });
            const p15c = await wholeCopy();
            assert(p15c.ok === true && p15c.staged === true && (await standby.send('photo-objects')).missing.length === 0 && (await exactNow()).length === 0,
                `the next whole copy puts the object back and lands (${JSON.stringify(p15c)})`);
        });

        await step('16. more accounts than a delta\'s pages of rows: deltas land, with no whole copy every other pull; their bytes bounded; the old database goes', async () => {
            const many = DELTA_PAGES * PAGE_ROWS + 50;
            await main.send('sql', {
                sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${many})
                      INSERT INTO members (public_key, callsign, updated_at) SELECT lower(hex(randomblob(32))), 'Many ' || i, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM n`,
            });
            await main.send('sql', { sql: `INSERT INTO accounts (public_key, balance) SELECT public_key, 0 FROM members WHERE callsign LIKE 'Many %'` });
            const w16 = await wholeCopy();
            const st16 = await standby.send('staging');
            require_(w16.ok === true && w16.staged === true && st16.previous, `S takes a whole copy of M's ${many} more members, swapped in, the old database kept (${JSON.stringify({ w16, st16 })})`);
            const n0 = standby.swaps();
            const pulls: { ok: boolean; mode: string; staged: boolean }[] = [];
            let fewest = Infinity;
            for (let i = 0; i < 4; i++) {
                await main.send('sql', { sql: `UPDATE members SET bio = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [`edit ${i}`, ann.pk] });
                const opened = px.opened.length;
                pulls.push(await standby.send('pull', {}));
                const opening = JSON.parse(px.copies.get(px.opened[opened] ?? '')?.pages.get(0) ?? '{}');
                fewest = Math.min(fewest, opening.rowCounts?.accounts ?? 0);
            }
            const [bio] = await standby.send('rows', { sql: 'SELECT bio FROM members WHERE public_key = ?', args: [ann.pk] });
            const diff16 = await exactNow();
            const st16b = await standby.send('staging');
            assert(pulls.every((p) => p.ok && p.mode === 'delta' && !p.staged) && standby.swaps() === n0 && fewest > DELTA_PAGES * PAGE_ROWS
                && bio?.bio === 'edit 3' && diff16.length === 0 && !st16b.previous,
                `four pulls in a row are four deltas that land, each carrying all ${fewest}+ accounts (more than ${DELTA_PAGES} x ${PAGE_ROWS} rows), with no whole copy and no restart; `
                + `S is M's, and the database the last swap replaced is gone (${JSON.stringify({ pulls: pulls.map((p) => p.mode), swaps: standby.swaps() - n0, bio, st16b })}; `
                + `differences ${first(diff16)}; before: every delta too big, a whole copy and a restart every other pull, the old database kept)`);

            // The delta's bytes bounded: every account is more than 64 KB of it.
            await standby.send('set-env', { vars: { BACKUP_DELTA_BYTES: String(64 * 1024) } });
            await main.send('sql', { sql: `UPDATE members SET bio = 'edit 4', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [ann.pk] });
            const big = await standby.send('pull', {});
            const [bio4] = await standby.send('rows', { sql: 'SELECT bio FROM members WHERE public_key = ?', args: [ann.pk] });
            await standby.send('set-env', { vars: { BACKUP_DELTA_BYTES: null } });
            const after = await pullAndSwap(false);
            assert(big.ok === true && big.mode === 'delta' && bio4?.bio === 'edit 3' && after.ok === true && after.mode === 'full' && after.staged === true && (await exactNow()).length === 0,
                `a delta of more than BACKUP_DELTA_BYTES (scaled to 64 KB) is not taken, and the next pull is a whole copy, which lands (${JSON.stringify({ big, after })})`);

            // Room for a whole copy only once the database the last swap replaced is gone: refused while even that is short.
            // Measured with the WAL checkpointed, as the copy will find it.
            await standby.send('checkpoint');
            const room = await standby.send('room');
            require_(room.previous > 0, `the database the last swap replaced is there (${JSON.stringify(room)})`);
            await standby.send('set-free-bytes', { n: room.need - room.previous - 1024 * 1024 });
            const before = await snapS();
            const short = await standby.send('pull', { whole: true });
            const st16c = await standby.send('staging');
            assert(short.ok === false && /no room on this server's disk for a second copy/.test(short.error ?? '') && /state\.previous\.db/.test(short.error ?? '')
                && st16c.previous && !st16c.staging && snapDiff(before, await snapS()).length === 0,
                `with too little room even without that database, the whole copy is refused saying so, the database kept, S unchanged (${JSON.stringify(short)})`);
            await standby.send('set-free-bytes', { n: room.need - Math.floor(room.previous / 2) });
            const log0 = standby.output().length;
            const roomy = await pullAndSwap(true);
            assert(roomy.ok === true && roomy.staged === true && /state\.previous\.db, the database the last swap replaced, deleted: this whole copy needs its room/.test(standby.output().slice(log0))
                && (await exactNow()).length === 0,
                `with room once it goes, that database is deleted first, and the copy lands (${JSON.stringify(roomy)})`);
        });

        await step('17. S restarted between a swap and the first copy on it: the database the swap replaced goes at the first copy after', async () => {
            const w17 = await wholeCopy();
            const st17 = await standby.send('staging');
            require_(w17.ok === true && w17.staged === true && st17.previous, `a whole copy swapped in, the old database kept beside it (${JSON.stringify({ w17, st17 })})`);
            await standby.send('boot-puller'); // the start's puller, as index.ts starts it: it reads the swap's marker, and deletes it
            await restartS();
            const marker = await standby.send('rows', { sql: `SELECT key FROM node_config WHERE key = 'standby_swapped_copy'` });
            const st17b = await standby.send('staging');
            require_(marker.length === 0 && st17b.previous, `S started again before any copy landed: the swap's marker read, the old database still there (${JSON.stringify(st17b)})`);
            const deltas: { ok: boolean; mode: string }[] = [];
            const left: boolean[] = [];
            for (let i = 0; i < 2; i++) {
                await main.send('sql', { sql: `UPDATE members SET bio = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [`edit 17.${i}`, ann.pk] });
                deltas.push(await standby.send('pull', {}));
                left.push((await standby.send('staging')).previous);
            }
            assert(deltas.every((d) => d.ok && d.mode === 'delta') && left.every((p) => !p) && (await exactNow()).length === 0,
                `the first delta after the restart lands and deletes the database the swap replaced (${JSON.stringify({ deltas: deltas.map((d) => d.mode), previousAfterEach: left })}; `
                + 'before: only the start that read the marker deleted it, so it stayed for good)');
        });

        await step('18. S killed between the swap\'s two renames: the next start finishes the swap, and the first delta deletes the old database', async () => {
            await standby.send('pull', {}); // S is M's
            await standby.send('checkpoint');
            const before = await snapS();
            await standby.kill('SIGKILL');
            // The swap killed between its renames (db/swap-at-boot.ts): state.db (and its WAL) is state.previous.db, and a
            // staging database made ready, S's own copy here, is not yet state.db.
            const f = (n: string) => path.join(standbyDir, n);
            fs.rmSync(f('staging'), { recursive: true, force: true });
            fs.mkdirSync(f('staging'));
            for (const s of ['', '-wal']) if (fs.existsSync(f(`state.db${s}`))) fs.copyFileSync(f(`state.db${s}`), f(`staging/state.db${s}`));
            fs.writeFileSync(f('staging/READY'), JSON.stringify({ pages: 1, generatedAt: new Date().toISOString() }));
            for (const s of ['', '-wal', '-shm']) {
                fs.rmSync(f(`state.previous.db${s}`), { force: true });
                if (fs.existsSync(f(`state.db${s}`))) fs.renameSync(f(`state.db${s}`), f(`state.previous.db${s}`));
            }
            require_(!fs.existsSync(f('state.db')) && fs.existsSync(f('state.previous.db')) && fs.existsSync(f('staging/state.db')), 'S stopped between the two renames');
            standby = await spawnNode(SCRIPT, standbyDir, envS);
            nodes.push(standby);
            const st18 = await standby.send('staging');
            const after = await snapS();
            assert(!st18.staging && st18.previous && snapDiff(before, after).length === 0 && (await exactNow()).length === 0,
                `the next start finishes the swap: no staging, S's copy row for row as it was, the old database kept (${JSON.stringify(st18)}; differences ${first(snapDiff(before, after))})`);
            await main.send('sql', { sql: `UPDATE members SET bio = 'edit 18', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [ann.pk] });
            const d18 = await standby.send('pull', {});
            const st18b = await standby.send('staging');
            assert(d18.ok === true && d18.mode === 'delta' && !st18b.previous && (await exactNow()).length === 0,
                `the first delta lands on it and deletes the old database (${JSON.stringify({ d18, previous: st18b.previous })}; before: kept for good, the copy carrying no marker of the swap)`);
        });

        await step('19. a take-over whose audit finds trouble: the old database kept 30 days from the audit, then deleted', async () => {
            const name = await newStandby('standby4');
            const st19 = await standby.send('staging');
            require_(st19.previous, `S4's first copy swapped in, the old database beside it (${JSON.stringify(st19)})`);
            const code19 = recoveryCode ?? (await main.send('make-envelope')).code;
            require_(await standby.send('envelope') === 'stored', 'S4 holds M\'s take-over envelope');
            // A balance M never had: the take-over's audit finds the ledger isn't the main server's.
            await standby.send('sql', { sql: 'UPDATE accounts SET balance = balance + 7 WHERE public_key = ?', args: [ann.pk] });
            await standby.send('takeover-restart-off');
            const pw = { 'X-Admin-Password': PW_STANDBY };
            const openT = await post(standby.base, '/api/local/admin/takeover/open', { code: code19 }, pw);
            const confirmT = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: openT.body?.preview?.sessionId, confirm: true }, pw);
            require_(confirmT.status === 200, `the take-over is confirmed (${confirmT.status} ${JSON.stringify(confirmT.body).slice(0, 160)})`);
            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, dir(name), envS);
            nodes.push(standby);
            const audit = await standby.send('audit');
            const kept = await standby.send('staging');
            const out = standby.output();
            const goes = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
            assert(await standby.send('role') === 'primary' && audit?.ok === false && kept.previous
                && new RegExp(`state\\.previous\\.db, the database this server's last swap as a standby replaced, is kept until ${goes}`).test(out),
                `the audit found trouble: the promoted server keeps the old database and says it goes on ${goes} (${JSON.stringify({ audit, previous: kept.previous })})`);
            // 31 days on: the journal's audit stamped that long ago, and the next start.
            await standby.kill('SIGKILL');
            const journalFile = path.join(dir(name), 'takeover-journal.json');
            const journal = JSON.parse(fs.readFileSync(journalFile, 'utf-8'));
            journal.steps.audit.at = new Date(Date.now() - 31 * 86_400_000).toISOString();
            fs.writeFileSync(journalFile, JSON.stringify(journal));
            standby = await spawnNode(SCRIPT, dir(name), envS);
            nodes.push(standby);
            const gone = await standby.send('staging');
            assert(await standby.send('role') === 'primary' && !gone.previous && /kept 30 days after the take-over's audit found trouble/.test(standby.output()),
                `a start more than 30 days after the audit deletes it (${JSON.stringify({ previous: gone.previous })}; before: kept for good)`);
        });

        await step('20. a delete of the old database stopped part way: no WAL of it stays; one left on its own goes', async () => {
            const name = await newStandby('standby5');
            const d = dir(name);
            const prev = (s: string) => fs.existsSync(path.join(d, `state.previous.db${s}`));
            const prevFiles = () => ['', '-wal', '-shm'].filter(prev);
            const secret = `OLD-WORDS-${crypto.randomBytes(6).toString('hex')}`;
            const bio = (text: string) => main.send('sql', { sql: `UPDATE members SET bio = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [text, ann.pk] });
            await bio(secret);
            await standby.send('pull', {}); // S holds Ann's words
            const w20 = await wholeCopy(); // and the database holding them becomes state.previous.db
            const inPrevious = () => ['', '-wal'].filter((s) => prev(s) && fs.readFileSync(path.join(d, `state.previous.db${s}`)).includes(secret));
            require_(w20.ok === true && w20.staged === true && prev('') && prev('-wal') && inPrevious().length > 0,
                `the database the swap replaced, with its WAL, holds Ann's words (${JSON.stringify({ w20, files: prevFiles(), inPrevious: inPrevious() })})`);
            // Ann changes her words on M; the delta that brings it deletes the old database, and S is killed right before the WAL.
            await bio('nothing here now');
            await standby.send('kill-before-rm', { suffix: 'state.previous.db-wal' });
            const dying = standby;
            const killed = await Promise.race([dying.send('pull', {}).then(() => false), dying.exited.then(() => true)]);
            require_(killed, 'S is killed in the middle of the delete');
            standby = await spawnNode(SCRIPT, d, envS);
            nodes.push(standby);
            const atStart = prevFiles();
            for (let i = 0; i < 2; i++) {
                await main.send('sql', { sql: `UPDATE members SET bio = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [`edit 20.${i}`, bo.pk] });
                await standby.send('pull', {});
            }
            assert(prevFiles().length === 0,
                `after the restart, the next delta leaves no file of the old database (${JSON.stringify({ afterKill: atStart, now: prevFiles(), wordsIn: inPrevious() })}; before: its WAL stayed for good, Ann's old words in it)`);

            // A -wal and -shm on their own, as an older build's delete left them (the database gone, the kill before the WAL).
            const w20b = await wholeCopy();
            require_(w20b.ok === true && prev('') && prev('-wal'), `another whole copy swapped in, the old database and its WAL beside it (${JSON.stringify(prevFiles())})`);
            await standby.kill('SIGKILL');
            fs.rmSync(path.join(d, 'state.previous.db'));
            standby = await spawnNode(SCRIPT, d, { ...envS, NODE_ROLE: 'primary' }); // its main server gone: promoted by hand
            nodes.push(standby);
            assert(standby.ready.role === 'primary' && prevFiles().length === 0,
                `a main server's start deletes a -wal and -shm left on their own (${JSON.stringify({ role: standby.ready.role, left: prevFiles() })}; before: nothing looked for them without the database)`);
        });

        await step('21. a swap stopped between its renames, its staged copy torn, then a start as a main server: it runs on its own copy', async () => {
            const name = await newStandby('standby6');
            const d = dir(name);
            const w21 = await wholeCopy(); // S's copy is a whole copy of M
            const count = async () => ({
                members: (await standby.send('rows', { sql: 'SELECT COUNT(*) AS n FROM members' }))[0].n as number,
                messages: (await standby.send('rows', { sql: 'SELECT COUNT(*) AS n FROM messages' }))[0].n as number,
            });
            const c0 = await count();
            require_(w21.ok === true && w21.staged === true && c0.messages > 0, `S holds a whole copy of M (${JSON.stringify({ w21, c0 })})`);
            await main.send('sql', { sql: `UPDATE members SET bio = 'edit 21', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [ann.pk] });
            // The next start SIGKILLs itself right before it renames the staged copy into place: after the first rename.
            const arm = `${d}.kill-at`;
            fs.writeFileSync(arm, JSON.stringify({ op: 'renameSync', suffix: '/staging/state.db' }));
            const p21 = await standby.send('pull', { whole: true });
            const f = (n: string) => fs.existsSync(path.join(d, n));
            const stopped = await until('S killed between the swap\'s renames', () => !fs.existsSync(arm) && f('staging/state.db') && !f('state.db') && f('state.previous.db'), 60_000);
            await sleep(1000);
            require_(p21.ok === true && p21.staged === true && stopped, `S is killed between the swap's two renames (${JSON.stringify(p21)})`);
            // The staged copy torn: its second half never reached the disk.
            const staged = path.join(d, 'staging/state.db');
            fs.truncateSync(staged, Math.floor(fs.statSync(staged).size / 2));
            for (const x of ['-wal', '-shm']) fs.rmSync(staged + x, { force: true });
            standby = await spawnNode(SCRIPT, d, { ...envS, NODE_ROLE: 'primary' }); // its main server gone: promoted by hand
            nodes.push(standby);
            const c1 = await count();
            const out = standby.output();
            assert(standby.ready.role === 'primary' && c1.members === c0.members && c1.messages === c0.messages && !f('state.previous.db') && !f('staging')
                && /is state\.db again/.test(out),
                `the torn copy is discarded and S's own copy is state.db again: the main server runs on its ${c1.members} members and ${c1.messages} messages `
                + `(${JSON.stringify({ before: c0, after: c1, previous: f('state.previous.db') })}; before: a new, empty database, and S's copy deleted)`);
        });

        await step('22. a main server a take-over promoted, its state.db moved away or emptied: it refuses to start, and loses nothing', async () => {
            const name = await newStandby('standby8');
            const d = dir(name);
            const f = (n: string) => path.join(d, n);
            const w22 = await wholeCopy();
            require_(w22.ok === true && fs.existsSync(f('state.previous.db')), `S8 holds a whole copy, the old database beside it (${JSON.stringify(w22)})`);
            const code22 = recoveryCode ?? (await main.send('make-envelope')).code;
            require_(await standby.send('envelope') === 'stored', 'S8 holds M\'s take-over envelope');
            await standby.send('sql', { sql: 'UPDATE accounts SET balance = balance + 7 WHERE public_key = ?', args: [ann.pk] }); // the audit finds trouble
            await standby.send('takeover-restart-off');
            const pw = { 'X-Admin-Password': PW_STANDBY };
            const openT = await post(standby.base, '/api/local/admin/takeover/open', { code: code22 }, pw);
            const confirmT = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: openT.body?.preview?.sessionId, confirm: true }, pw);
            require_(confirmT.status === 200, `the take-over is confirmed (${confirmT.status})`);
            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, d, envS);
            nodes.push(standby);
            const audit = await standby.send('audit');
            require_(standby.ready.role === 'primary' && audit?.ok === false && fs.existsSync(f('state.previous.db')), `promoted, the audit found trouble, the old database kept (${JSON.stringify(audit)})`);
            // Written on the promoted server: in its state.db only.
            await standby.send('sql', { sql: `UPDATE members SET bio = 'AFTER-22' WHERE public_key = ?`, args: [ann.pk] });
            const look = async () => ({
                bio: (await standby.send('rows', { sql: 'SELECT bio FROM members WHERE public_key = ?', args: [ann.pk] }))[0]?.bio ?? null,
                balance: (await standby.send('rows', { sql: 'SELECT balance FROM accounts WHERE public_key = ?', args: [ann.pk] }))[0]?.balance ?? null,
                messages: (await standby.send('rows', { sql: 'SELECT COUNT(*) AS n FROM messages' }))[0].n as number,
            });
            const before = await look();
            await standby.kill('SIGKILL');
            // An operator moves state.db away (to look at it, or to "start fresh").
            const aside = f('moved-away');
            fs.mkdirSync(aside);
            for (const x of ['', '-wal', '-shm']) if (fs.existsSync(f(`state.db${x}`))) fs.renameSync(f(`state.db${x}`), path.join(aside, `state.db${x}`));
            const startRefused = async (): Promise<string | null> => {
                try {
                    const n = await spawnNode(SCRIPT, d, envS);
                    nodes.push(n);
                    standby = n;
                    return null;
                } catch (e: any) { return String(e?.output ?? e?.message ?? e); }
            };
            const missing = await startRefused();
            const kept = () => fs.existsSync(f('state.previous.db')) && fs.existsSync(path.join(aside, 'state.db'));
            assert(missing !== null && /FATAL: .*state\.db is missing, and .*state\.previous\.db is there/.test(missing) && /rename state\.previous\.db/.test(missing)
                && kept() && !fs.existsSync(f('state.db')),
                `with state.db moved away, the main server refuses to start, says what is missing and what to do, and changes no file `
                + `(${missing === null ? 'it started' : JSON.stringify(missing.split('\n').find((l) => /FATAL/.test(l)) ?? '').slice(0, 300)}; before: it ran as the main server on the older database, unaudited)`);
            fs.writeFileSync(f('state.db'), ''); // emptied
            const empty = await startRefused();
            assert(empty !== null && /FATAL: .*state\.db is empty, and .*state\.previous\.db is there/.test(empty) && kept(),
                `with state.db emptied, it refuses too (${empty === null ? 'it started' : 'refused'}; before: it served an empty community, and the next start deleted the older database)`);
            fs.rmSync(f('state.db'));
            for (const x of ['', '-wal', '-shm']) if (fs.existsSync(path.join(aside, `state.db${x}`))) fs.renameSync(path.join(aside, `state.db${x}`), f(`state.db${x}`));
            require_(await startRefused() === null, 'with state.db put back, it starts');
            const after = await look();
            assert(standby.ready.role === 'primary' && JSON.stringify(after) === JSON.stringify(before),
                `it runs on the database it had, as it was (${JSON.stringify({ before, after })})`);
        });

        await step('23. a standby whose state.db is moved away: it puts state.previous.db back, and the next delta brings it level', async () => {
            const name = await newStandby('standby9');
            const d = dir(name);
            const f = (n: string) => path.join(d, n);
            const w23 = await wholeCopy();
            require_(w23.ok === true && fs.existsSync(f('state.previous.db')), `S9 holds a whole copy, the old database beside it (${JSON.stringify(w23)})`);
            await standby.kill('SIGKILL');
            const aside = f('moved-away');
            fs.mkdirSync(aside);
            for (const x of ['', '-wal', '-shm']) if (fs.existsSync(f(`state.db${x}`))) fs.renameSync(f(`state.db${x}`), path.join(aside, `state.db${x}`));
            await main.send('sql', { sql: `UPDATE members SET bio = 'edit 23', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [ann.pk] });
            standby = await spawnNode(SCRIPT, d, envS);
            nodes.push(standby);
            const back = /state\.previous\.db was there: it is this server's copy, and is state\.db again/.test(standby.output());
            const d23 = await standby.send('pull', {});
            const diff23 = await exactNow();
            assert(back && !fs.existsSync(f('state.previous.db')) && d23.ok === true && diff23.length === 0,
                `S9 starts on its previous database, put back, and the next pull brings it level with M (${JSON.stringify({ back, pull: d23 })}; differences ${first(diff23)})`);
        });

        const blocked = [...(await main.send('fetches')).blocked, ...(await standby.send('fetches')).blocked];
        assert(blocked.length === 0, `nothing tried to leave this machine (${JSON.stringify(blocked)})`);
    } finally {
        proxy?.close();
        for (const n of nodes) await n.kill().catch(() => {});
        // Each node's own output, beside its data dir, for a look after a failure.
        nodes.forEach((n, i) => { try { fs.writeFileSync(path.join(root, `node-${i}.log`), n.output()); } catch { /* the dir is gone */ } });
        console.log(`\n${testsPassed}/${testsRun} passed (${((Date.now() - started) / 1000).toFixed(0)} s)`);
        if (testsPassed !== testsRun) process.exitCode = 1;
    }
}

/** Step 15's look at S's image store (data/images, the disk store) and the orphan sweep's pass, inside S's process. */
const photoCommands: Record<string, (args: any) => Promise<unknown>> = {
    /** The listing photos a whole copy being built has in its staging database so far; null before it has one. */
    'staged-photos': async () => {
        const file = path.join(process.env.BEANPOOL_DATA_DIR!, 'staging', 'state.db');
        if (!fs.existsSync(file)) return null;
        const Database = (await import('better-sqlite3')).default;
        try {
            const conn = new Database(file, { readonly: true, fileMustExist: true });
            try { return conn.prepare('SELECT post_id, order_num, storage_key FROM post_photos WHERE storage_key IS NOT NULL').all(); } finally { conn.close(); }
        } catch { return null; }
    },
    /** This database's listing photos' objects, and the ones not in the store. */
    'photo-objects': async () => {
        const { db } = await import('./db/db.js');
        const keys = db.prepare('SELECT storage_key FROM post_photos WHERE storage_key IS NOT NULL').pluck().all() as string[];
        return { keys, missing: keys.filter((k) => !fs.existsSync(path.join(process.env.BEANPOOL_DATA_DIR!, 'images', k))) };
    },
    'missing-objects': async (a: { keys: string[] }) => a.keys.filter((k) => !fs.existsSync(path.join(process.env.BEANPOOL_DATA_DIR!, 'images', k))),
    /** Each object's time moved back by `ms`, as if written that long ago. */
    'age-objects': async (a: { keys: string[]; ms: number }) => {
        for (const k of a.keys) {
            const file = path.join(process.env.BEANPOOL_DATA_DIR!, 'images', k);
            const at = new Date(fs.statSync(file).mtimeMs - a.ms);
            fs.utimesSync(file, at, at);
        }
        return true;
    },
    'put-object': async (a: { key: string }) => {
        const file = path.join(process.env.BEANPOOL_DATA_DIR!, 'images', a.key);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from('an object nobody names'));
        return true;
    },
    'rm-object': async (a: { key: string }) => {
        fs.rmSync(path.join(process.env.BEANPOOL_DATA_DIR!, 'images', a.key));
        return true;
    },
    /** One pass of the orphan sweep (engine/storage-health.ts), as it sees the store `aheadMs` from now. */
    sweep: async (a: { aheadMs: number }) => {
        const { sweepOrphanedImageObjects } = await import('./engine/storage-health.js');
        return sweepOrphanedImageObjects({ nowMs: Date.now() + a.aheadMs });
    },
};

/** Step 16's look at the room a whole copy needs (services/stager.ts roomForStaging), and the disk's free space as it sees it. */
const roomCommands: Record<string, (args: any) => Promise<unknown>> = {
    /** Step 20: this process SIGKILLs itself right before it deletes a file whose path ends in `suffix`, as a power cut would. */
    'kill-before-rm': async (a: { suffix: string }) => {
        const real = fs.rmSync;
        (fs as any).rmSync = (p: fs.PathLike, ...rest: any[]) => {
            if (String(p).endsWith(a.suffix)) process.kill(process.pid, 'SIGKILL');
            return (real as any)(p, ...rest);
        };
        return true;
    },
    /** Step 10's promoted server: its take-over audit, as recorded (services/takeover.ts runPendingPromotionAudit). */
    audit: async () => {
        const { getLocalConfig } = await import('./config/local-config.js');
        const a = getLocalConfig().lastPromotionAudit;
        return a ? { ok: a.ok, drift: a.drift, copy: a.copy?.match ?? null } : null;
    },
    room: async () => (await import('./services/stager.js')).roomForStaging(),
    'set-free-bytes': async (a: { n: number | null }) => {
        (await import('./services/stager.js'))._setFreeBytesForTests(a.n);
        return true;
    },
};

if (process.argv.includes('--child')) {
    // Step 21: armed by a file beside the data dir, read once at this start, this process SIGKILLs itself right before the
    // named fs call on a path ending in `suffix`, as a power cut would (before the swap at boot, which runPagedCopyChild runs).
    const arm = `${process.env.BEANPOOL_DATA_DIR}.kill-at`;
    if (fs.existsSync(arm)) {
        const { op, suffix, action = 'kill', when = 'before' } = JSON.parse(fs.readFileSync(arm, 'utf-8')) as {
            op: 'renameSync' | 'rmSync'; suffix: string; action?: 'kill' | 'throw'; when?: 'before' | 'after';
        };
        fs.rmSync(arm);
        const real = (fs as any)[op];
        const act = (p: string) => {
            if (action === 'kill') process.kill(process.pid, 'SIGKILL');
            throw Object.assign(new Error(`test: ${op}(${p}) refused`), { code: 'EACCES' });
        };
        (fs as any)[op] = (p: fs.PathLike, ...rest: any[]) => {
            const hit = String(p).endsWith(suffix);
            if (hit && when === 'before') act(String(p));
            const r = real(p, ...rest);
            if (hit && when === 'after') act(String(p));
            return r;
        };
    }
    runPagedCopyChild({ ...photoCommands, ...roomCommands }).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
