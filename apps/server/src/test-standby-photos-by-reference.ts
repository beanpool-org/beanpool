/**
 * Test Suite: listing photos travel by reference (P4 of scratch/global-node/DESIGN-paged-copies-fable.md, §6 and §8's P4
 * row), and every delta lands however many accounts the main server holds (review 4144658064 of #1334).
 *
 * A main server M and a standby S, each its own process with its own data dir (takeover-test-harness.ts), M serving its real
 * backup routes and S pulling through its real puller. S reaches M through a proxy in this process, which passes every
 * request on, counts the objects S asks for (routes/backup.ts sync-object), and can change an object's bytes in transit,
 * answer one as gone, or take the format header off a copy's opening. M's page bounds are scaled to 64 KB and 200 rows, so
 * its copies take many pages, and S's BACKUP_DELTA_BYTES to 64 KB for its whole life. M's listing photos are in its image
 * store, as every photo a member posts is, but one held inline. Nothing leaves this machine.
 *
 *  1. S's first copy: each of M's listing photos by reference, its object fetched once (a photo on two listings once), the
 *     one inline with its bytes; every row's object in S's store with its sha256, and S is M's. (Before: every photo's
 *     bytes inline in the pages, no object fetched.) M checks S's replication token with scrypt once for the whole copy,
 *     not once for each object (review 4148896207).
 *  2. A second whole copy fetches no object; one new photo on M is fetched alone, by the next delta.
 *  3. An object M can't find: the copy names it in photosOmitted and S keeps its own row and object, exact. An object M no
 *     longer serves when S asks (a 404): a delta and a whole copy are each not taken, saying so, nothing of them landing and
 *     S unchanged; once M serves it again, the next delta brings it. Three staged copies that fail so, in their fetch, leave
 *     no descriptor open on the references file each read from (review 4148896385).
 *  4. An object changed in transit: asked for again, and the right one lands. Changed every time: the delta and the whole
 *     copy are each refused, loudly, nothing of the object or its row written, and the next pull lands.
 *  5. The object route: no token or a wrong one is 401, an address not in lowercase hex 400, one no listing photo of M names
 *     404 (a chat attachment's object in M's store, a member's avatar, nothing at all), a listing photo's the bytes. Each
 *     wrong token pays its scrypt; a token rotated or revoked on M is refused at once, though the old one was remembered. A copy
 *     asked for without the format that reads photos by reference (an older standby) is refused, 426, logged on M; S's
 *     pull fails saying so, S unchanged.
 *  6. More accounts than BACKUP_DELTA_BYTES (scaled) of them, which every delta carries whole: eight pulls in a row, a member
 *     edited before each, are eight deltas that land, with no whole copy and no restart. A delta of more changed bytes than
 *     that is still not taken. (Before: delta, whole copy, delta, whole copy: no delta ever landed.)
 *  7. A take-over confirmed while a whole copy fetches its objects stops the fetch: no more than the requests already on their
 *     way reach the old main server (review 4148896584). The promoted server, on the copies by reference it had, opens every
 *     listing's photo with M's bytes.
 *  8. The object route is under M's administrative limiter: past its requests a minute from one address, 429.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-photos-by-reference.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { spawnNode, post, type NodeProc } from './takeover-test-harness.js';
import { runPagedCopyChild } from './paged-copies-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Photos-By-Ref-Main-Pw-5521!';
const PW_STANDBY = 'Photos-By-Ref-Standby-Pw-8830!';
/** M's page bounds, scaled down from 8 MB and 25,000 rows. */
const PAGE_BYTES = 64 * 1024;
const PAGE_ROWS = 200;
/** S's bound on a delta's changes (BACKUP_DELTA_BYTES), scaled down from 32 MB, for its whole life. */
const DELTA_BYTES = 64 * 1024;
const LISTINGS = 20;
const PER_LISTING = 2;
const PHOTO_BYTES = 3000;
/** Step 6's accounts: more than DELTA_BYTES of them in every delta (about 170 bytes each). */
const MANY = 900;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const HASHED = ['members', 'accounts', 'posts', 'post_photos', 'messages'];
/** Step 7's photos M gains while S's copy is fetching when the take-over is confirmed. */
const TAKEOVER_PHOTOS = 200;
/**
 * Step 3's more photos, on the last listings, from slot 10: a staged copy's references to them (about 250 bytes each) are
 * more than its file's reader takes in before it waits for them to be read (readline: 1,024 lines queued).
 */
const EXTRA_LISTINGS = 8;
const EXTRA_PER_LISTING = 250;

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

/** A call to a node's real HTTPS server, signed by `as`. */
async function api(base: string, route: string, as: Id, body: unknown): Promise<{ status: number; body: any }> {
    const raw = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'Content-Type': 'application/json', 'X-Public-Key': as.pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
        'X-Signature': crypto.sign(null, Buffer.from(`POST\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), as.priv).toString('base64'),
    };
    const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
}
function built(what: string, a: { status: number; body: any }): any {
    require_(a.status >= 200 && a.status < 300, `M: ${what} (${a.status} ${JSON.stringify(a.body)?.slice(0, 160)})`);
    return a.body;
}
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
/** The files a process holds open whose path ends in `name` (deleted ones too): /proc on Linux, lsof elsewhere. */
function openFilesNamed(pid: number, name: string): string[] {
    const proc = `/proc/${pid}/fd`;
    if (fs.existsSync(proc)) {
        const out: string[] = [];
        for (const fd of fs.readdirSync(proc)) {
            try { const target = fs.readlinkSync(path.join(proc, fd)); if (target.includes(name)) out.push(`${fd} ${target}`); } catch { /* closed meanwhile */ }
        }
        return out;
    }
    const r = spawnSync('lsof', ['-n', '-P', '-p', String(pid), '-F', 'fn'], { encoding: 'utf-8' });
    if (r.error || typeof r.stdout !== 'string' || !r.stdout.includes(`p${pid}`)) throw new Error(`could not list process ${pid}'s open files: ${r.error?.message ?? r.stderr}`);
    return r.stdout.split('\n').filter((l) => l.startsWith('n') && l.includes(name)).map((l) => l.slice(1));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 5).join(' | ')}`);
/** Every copied table S and M both hash, where they differ (engine/replica-hashes.ts). */
function hashDiff(s: Record<string, { rows: number; hash: string }>, m: Record<string, { rows: number; hash: string }>): string[] {
    return Object.keys(m).filter((t) => s[t] && (s[t].rows !== m[t].rows || s[t].hash !== m[t].hash)).map((t) => `${t} ${s[t].rows}/${m[t].rows}`);
}

/**
 * The proxy S reaches M through: every request passed on; each copy's pages kept; each object S asks for counted by its
 * sha256. `corrupt`: the next that many objects' bytes are changed on their way to S. `gone`: objects answered 404 here,
 * as a main server that no longer holds them answers. `stripFormat`: the next that many copies are opened without the
 * format header, as an older standby opens one.
 */
interface Proxy {
    url: string;
    objectGets: string[];
    /** Object requests as each reaches the proxy, whatever M answers. */
    objectAsks: number;
    corrupt: number;
    gone: Set<string>;
    stripFormat: number;
    opened: string[];
    pages: Map<string, Map<number, string>>;
    statuses: { path: string; status: number }[];
    close: () => void;
}
async function startProxy(target: string): Promise<Proxy> {
    const px: Proxy = {
        url: '', objectGets: [], objectAsks: 0, corrupt: 0, gone: new Set(), stripFormat: 0, opened: [], pages: new Map(), statuses: [], close: () => {},
    };
    const server = http.createServer((req, res) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'content-length') headers[k] = v;
            const url = new URL(req.url ?? '/', 'http://proxy');
            const object = /^\/api\/local\/admin\/sync-object\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
            if (object) px.objectAsks++;
            if (req.method === 'POST' && url.pathname === '/api/local/admin/sync-copy' && px.stripFormat > 0) {
                px.stripFormat--;
                delete headers['x-replica-format'];
            }
            let status = 502;
            let raw: Buffer = Buffer.alloc(0);
            const outHeaders: Record<string, string> = {};
            if (object && px.gone.has(object)) {
                status = 404;
                raw = Buffer.from(JSON.stringify({ error: 'no listing photo of this server has that address', why: 'not-named' }));
            } else {
                try {
                    const up = await fetch(target + req.url, { method: req.method, headers, body: chunks.length > 0 ? Buffer.concat(chunks) : undefined });
                    status = up.status;
                    raw = Buffer.from(await up.arrayBuffer());
                    for (const k of ['content-type', 'x-node-role', 'cache-control']) { const v = up.headers.get(k); if (v) outHeaders[k] = v; }
                } catch {
                    raw = Buffer.from(JSON.stringify({ error: 'the main server is not answering' }));
                }
            }
            if (object && status === 200) {
                px.objectGets.push(object);
                if (px.corrupt > 0 && raw.length > 0) {
                    px.corrupt--;
                    raw = Buffer.from(raw);
                    raw[0] ^= 0xff;
                }
            }
            const page = /^\/api\/local\/admin\/sync-copy(?:\/([^/]+)\/(\d+))?$/.exec(url.pathname);
            if (page && status === 200 && req.method !== 'DELETE') {
                try {
                    const parsed = JSON.parse(raw.toString('utf-8'));
                    if (typeof parsed?.copyId === 'string') {
                        if (parsed.n === 0) {
                            px.opened.push(parsed.copyId);
                            px.pages.set(parsed.copyId, new Map());
                        }
                        px.pages.get(parsed.copyId)?.set(parsed.n, raw.toString('utf-8'));
                    }
                } catch { /* not a page */ }
            }
            px.statuses.push({ path: url.pathname, status });
            res.writeHead(status, outHeaders);
            res.end(raw);
        })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    px.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    px.close = () => server.close();
    return px;
}

/** Every page of the copy opened last (or the `back`-th before it), parsed. */
function pagesOf(px: Proxy, back = 0): any[] {
    const id = px.opened[px.opened.length - 1 - back];
    const pages = id ? px.pages.get(id) : null;
    return pages ? [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => JSON.parse(t)) : [];
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

type PhotoRow = { post_id: string; order_num: number; sha256: string | null; storage_key: string | null; inline: number; objectSha: string | null };
const slot = (r: { post_id: string; order_num: number }) => `${r.post_id}|${r.order_num}`;

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
    };
    const envS = {
        ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000',
        BACKUP_RESYNC_RETRY_MS: '3000', BACKUP_PAGE_GAP_MS: '0', BACKUP_DELTA_BYTES: String(DELTA_BYTES),
    };
    const gwen = newId('Gwen');
    const ann = newId('Ann');
    let proxy: Proxy | null = null;

    const step = async (title: string, fn: () => Promise<void>) => {
        console.log(`\n— ${title} —`);
        const t = Date.now();
        try { await fn(); } catch (e: any) { assert(false, `${title}: ${e?.message || e}`); }
        console.log(`  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    };

    try {
        // ── M: members, listings with photos in its image store, one photo on two listings, one held inline ──
        const main = await spawnNode(SCRIPT, dir('main'), envM);
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        await main.send('settle-pricing');
        const inv = built('Gwen makes an invite for Ann', await api(m, '/api/invite/generate', gwen, { publicKey: gwen.pk }));
        built('Ann joins with it', await api(m, '/api/invite/redeem', ann, { code: inv.invite?.code ?? inv.code, publicKey: ann.pk, callsign: 'Ann' }));
        built('Gwen sets a profile photo', await api(m, '/api/profile/update', gwen, { avatar: TINY_PNG }));
        const conv = built('Ann opens a DM with Gwen', await api(m, '/api/messages/conversation', ann, { type: 'dm', participants: [ann.pk, gwen.pk], createdBy: ann.pk }));
        const conversationId: string = conv.conversation?.id ?? conv.id;
        await main.send('flood', { kind: 'posts', n: LISTINGS, author: ann.pk });
        const listings = (await main.send('rows', { sql: `SELECT id FROM posts WHERE id LIKE 'flood-%' ORDER BY id` })).map((r: { id: string }) => r.id) as string[];
        require_(listings.length === LISTINGS, `M has ${LISTINGS} listings (${listings.length})`);
        const made: { post_id: string; order_num: number; sha256: string; key: string }[] = await main.send('add-photos', { posts: listings, perPost: PER_LISTING, bytes: PHOTO_BYTES });
        const shared = (await main.send('add-photos', { posts: [listings[1]], from: 5, sameAs: made[0].key }))[0];
        await main.send('sql', { sql: `INSERT INTO post_photos (post_id, photo_data, order_num, updated_at) VALUES (?, ?, 7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, args: [listings[2], TINY_PNG] });
        require_(made.length === LISTINGS * PER_LISTING && shared?.sha256 === made[0].sha256 && shared.key !== made[0].key,
            `M holds ${made.length + 1} listing photos in its image store, one of them on two listings under two keys, and one inline`);
        const distinct = new Set([...made.map((x) => x.sha256), shared.sha256]).size;

        proxy = await startProxy(main.base);
        const px = proxy;
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), envS);
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: px.url, replicationToken, primaryPeerId: main.ready.peerId });
        const exactNow = async () => hashDiff(await standby.send('hashes'), await main.send('hashes'));
        /** A pull (a whole one when `whole`); one that made a copy ready is waited for until S has started again on it. */
        const pullAndSwap = async (whole: boolean) => {
            const before = standby.swaps();
            const p = await standby.send('pull', whole ? { whole: true } : {});
            if (p.staged) await until('S to start again on the new copy', () => standby.swaps() > before, 60_000);
            return p;
        };
        const photosOf = async (node: NodeProc): Promise<PhotoRow[]> => node.send('photo-state');
        /** S's photos against M's: each slot's sha256, and S's object of it holding those bytes. */
        const photosMatch = async (): Promise<string[]> => {
            const mine = new Map((await photosOf(standby)).map((r) => [slot(r), r]));
            const out: string[] = [];
            for (const r of await photosOf(main)) {
                const s = mine.get(slot(r));
                const want = r.inline ? null : r.sha256;
                if (!s) out.push(`${slot(r)} missing`);
                else if (want && (s.sha256 !== want || s.objectSha !== want)) out.push(`${slot(r)} ${s.sha256?.slice(0, 8)}/${s.objectSha?.slice(0, 8)} not ${want.slice(0, 8)}`);
                else if (!want && !s.inline && !s.objectSha) out.push(`${slot(r)} no bytes`);
            }
            return out;
        };
        const gets = () => px.objectGets.length;

        await step('1. S\'s first copy: each listing photo by reference, its object fetched once; the inline one with its bytes', async () => {
            const g0 = gets();
            const k0: number = await main.send('count-scrypts');
            const p1 = await pullAndSwap(false);
            const fetched = px.objectGets.slice(g0);
            const tokenScrypts = (await main.send('count-scrypts')) - k0;
            const pages = pagesOf(px);
            const photos = pages.flatMap((pg) => Array.isArray(pg.photos) ? pg.photos : []);
            const byRef = photos.filter((r: any) => typeof r.sha256 === 'string' && r.photo_data === undefined);
            const inline = photos.filter((r: any) => typeof r.photo_data === 'string');
            require_(p1.ok === true && p1.staged === true, `S's first copy lands, built in a staging database and swapped in (${JSON.stringify(p1)})`);
            assert(pages.length > 1 && byRef.length === made.length + 1 && inline.length === 1 && inline[0].photo_data === TINY_PNG,
                `the copy's ${pages.length} pages name ${byRef.length} photos by reference, with no bytes, and carry the inline one's bytes (${inline.length}; before: every photo's bytes inline)`);
            assert(fetched.length === distinct && new Set(fetched).size === distinct,
                `S fetched each of the ${distinct} objects once, the photo on two listings once (${fetched.length} fetches, ${new Set(fetched).size} distinct; before: none, the bytes came in the pages)`);
            const mismatch = await photosMatch();
            const diff = await exactNow();
            const rec = await standby.send('record');
            assert(mismatch.length === 0 && diff.length === 0 && rec.lastWhole?.exact === true,
                `every one of S's listing photos has its object in S's store with M's bytes, and S is M's (photos ${first(mismatch)}; tables ${first(diff)}; ${JSON.stringify(rec.lastWhole)})`);
            // Review 4148896207: the replication token's scrypt, once for the copy, not once for every object it fetched.
            assert(fetched.length > 20 && tokenScrypts >= 1 && tokenScrypts <= 2,
                `M checked S's replication token with scrypt ${tokenScrypts} time(s) for a copy of ${pages.length} pages and ${fetched.length} objects (before: once per request, ${fetched.length + pages.length}+)`);
        });

        await step('2. a second whole copy fetches nothing; one new photo is fetched alone by the next delta', async () => {
            const g0 = gets();
            const w2 = await pullAndSwap(true);
            assert(w2.ok === true && w2.staged === true && gets() === g0 && (await exactNow()).length === 0,
                `a whole copy of it all lands, exact, and fetches no object (${gets() - g0} fetches; ${JSON.stringify(w2)}; before: every photo's bytes again)`);
            const [fresh] = await main.send('add-photos', { posts: [listings[3]], from: 2, bytes: PHOTO_BYTES });
            const d2 = await standby.send('pull', {});
            const fetched = px.objectGets.slice(g0);
            assert(d2.ok === true && d2.mode === 'delta' && fetched.length === 1 && fetched[0] === fresh.sha256 && (await photosMatch()).length === 0,
                `the new photo comes by the next delta, its object fetched alone (${JSON.stringify({ pull: d2, fetched })})`);
        });

        await step('3. an object M can\'t read is named and S keeps its own; one M can no longer serve is left out, and comes later', async () => {
            const lost = made[8];
            const bytes: string = await standby.send('object', { key: lost.key });
            require_(!!bytes, `S holds ${slot(lost)}'s object`);
            await main.send('rm-object', { key: lost.key });
            const w3 = await pullAndSwap(true);
            const last = pagesOf(px).at(-1);
            const onS = (await photosOf(standby)).find((r) => slot(r) === slot(lost));
            const rec3 = await standby.send('record');
            assert(w3.ok === true && w3.staged === true && Array.isArray(last?.photosOmitted) && last.photosOmitted.includes(slot(lost))
                && onS?.objectSha === lost.sha256 && rec3.lastWhole?.exact === true && rec3.lastWhole?.photosLeftOut === 1,
                `the copy names ${slot(lost)} in photosOmitted, and S keeps its own row and object through the swap, exact (${JSON.stringify({ omitted: last?.photosOmitted, onS: onS?.objectSha?.slice(0, 8), whole: rec3.lastWhole })})`);
            await main.send('put-object', { key: lost.key, data: bytes, mime: 'image/jpeg' });

            // Gone when S asks for it (a photo replaced on M after the copy's snapshot): M answers 404 for its object.
            const [late] = await main.send('add-photos', { posts: [listings[5]], from: 3, bytes: PHOTO_BYTES });
            px.gone.add(late.sha256);
            const before = await standby.send('snapshot', { tables: HASHED });
            const d3 = await standby.send('pull', {});
            const w3b = await standby.send('pull', { whole: true });
            const st3 = await standby.send('staging');
            const after = await standby.send('snapshot', { tables: HASHED });
            const rec3b = await standby.send('record');
            // Review 4148896385: a staged copy that fails in its fetch closes the references file it read from. With many more
            // photos S lacks, late in the copy's order (each listing's, then its slot's), the fetch fails at the gone one early,
            // most of that file unread. Gone again after.
            await main.send('add-photos', { posts: listings.slice(LISTINGS - EXTRA_LISTINGS), perPost: EXTRA_PER_LISTING, from: 10, bytes: 100 });
            const w3more: { ok: boolean; error?: string }[] = [];
            for (let i = 0; i < 3; i++) w3more.push(await standby.send('pull', { whole: true }));
            const refsOpen = openFilesNamed(standby.proc.pid!, 'photo-references.jsonl');
            assert(w3more.every((p) => p.ok === false && /no longer on the main server/.test(p.error ?? '')) && refsOpen.length === 0,
                `three staged copies that failed in their fetch leave no descriptor open on the references file each read from `
                + `(${refsOpen.length} open${refsOpen.length ? `: ${refsOpen.slice(0, 3).join(' | ')}` : ''}; before: one more for each)`);
            await main.send('sql', { sql: 'DELETE FROM post_photos WHERE order_num >= 10' });
            assert(d3.ok === false && w3b.ok === false && /no longer on the main server/.test(d3.error ?? '') && /no longer on the main server/.test(w3b.error ?? '')
                && !st3.staging && JSON.stringify(before.tables) === JSON.stringify(after.tables) && rec3b.lastWhy === 'http-404',
                `a delta and a whole copy whose photo M no longer serves are each not taken, saying so: nothing of them lands, no staging left, S unchanged `
                + `(${JSON.stringify({ delta: d3.error?.slice(0, 90), whole: w3b.error?.slice(0, 90), staging: st3.staging, why: rec3b.lastWhy })})`);
            px.gone.clear();
            const g0 = gets();
            const d3b = await standby.send('pull', {});
            const w3c = await pullAndSwap(true);
            const mismatch = await photosMatch();
            assert(d3b.ok === true && w3c.ok === true && px.objectGets.slice(g0).length === 1 && mismatch.length === 0 && (await exactNow()).length === 0,
                `served again, the next delta brings it, one object fetched, and the next whole copy fetches nothing; S is M's (${px.objectGets.slice(g0).length} fetched; photos ${first(mismatch)})`);
        });

        await step('4. an object changed in transit: asked for again; changed every time, the pull is refused and nothing lands', async () => {
            const [a] = await main.send('add-photos', { posts: [listings[6]], from: 3, bytes: PHOTO_BYTES });
            const g0 = gets();
            px.corrupt = 1;
            const d4 = await standby.send('pull', {});
            const asked = px.objectGets.slice(g0).filter((s) => s === a.sha256).length;
            assert(d4.ok === true && asked === 2 && (await photosMatch()).length === 0,
                `a delta whose object came changed once asks for it again, and M's bytes land (${JSON.stringify({ pull: d4, asked })})`);

            const [b] = await main.send('add-photos', { posts: [listings[7]], from: 3, bytes: PHOTO_BYTES });
            px.corrupt = 3;
            const d4b = await standby.send('pull', {});
            const rowB = (await photosOf(standby)).find((r) => slot(r) === slot(b));
            const objB = await standby.send('object', { key: b.key });
            const rec4 = await standby.send('record');
            assert(d4b.ok === false && /bytes its row doesn't name/.test(d4b.error ?? '') && !rowB && !objB && rec4.lastOutcome === 'refused',
                `changed every time, the delta is refused, saying why, with neither the object nor its row written (${JSON.stringify({ pull: d4b, row: !!rowB, object: !!objB, outcome: rec4.lastOutcome, why: rec4.lastWhy })})`);

            px.corrupt = 3;
            const before = await standby.send('snapshot', { tables: HASHED });
            const w4 = await standby.send('pull', { whole: true });
            const st4 = await standby.send('staging');
            const after = await standby.send('snapshot', { tables: HASHED });
            assert(w4.ok === false && /bytes its row doesn't name/.test(w4.error ?? '') && !st4.staging && JSON.stringify(before.tables) === JSON.stringify(after.tables)
                && !(await standby.send('object', { key: b.key })),
                `changed every time, a whole copy is refused too: no staging left, S unchanged, the object not written (${JSON.stringify({ pull: w4, staging: st4.staging })})`);
            px.corrupt = 0;
            const d4c = await standby.send('pull', {});
            assert(d4c.ok === true && (await photosMatch()).length === 0, `the next pull lands, with M's bytes (${JSON.stringify(d4c)})`);
        });

        await step('5. the object route answers a listing photo\'s address only, to the replication token; an older standby is refused, loudly', async () => {
            // On M's real HTTPS server, every middleware it runs in front of the routes.
            const at = (sha: string, headers: Record<string, string> = { 'X-Replication-Token': replicationToken }) =>
                fetch(`${m}/api/local/admin/sync-object/${sha}`, { headers }).then(async (r) => ({ status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }));
            const good = await at(made[0].sha256);
            const noToken = await at(made[0].sha256, {});
            const badToken = await at(made[0].sha256, { 'X-Replication-Token': 'f'.repeat(64) });
            assert(good.status === 200 && sha256(good.bytes) === made[0].sha256 && noToken.status === 401 && badToken.status === 401,
                `a listing photo's address gets its bytes with the token, and 401 without it or with a wrong one (${good.status}, ${noToken.status}, ${badToken.status})`);
            // The token's verdict is remembered (review 4148896207), and only a right one: each wrong one still pays its scrypt,
            // and a token rotated or revoked on M is refused at once.
            const k5: number = await main.send('count-scrypts');
            for (let i = 0; i < 3; i++) await at(made[0].sha256, { 'X-Replication-Token': crypto.randomBytes(32).toString('hex') });
            const k5b: number = await main.send('count-scrypts');
            const rotated = crypto.randomBytes(32).toString('hex');
            await main.send('set-token', { token: rotated });
            const oldAfterRotation = await at(made[0].sha256);
            const newAfterRotation = await at(made[0].sha256, { 'X-Replication-Token': rotated });
            await main.send('set-token', { token: null });
            const afterRevocation = await at(made[0].sha256, { 'X-Replication-Token': rotated });
            await main.send('set-token', { token: replicationToken });
            const restored = await at(made[0].sha256);
            assert(k5b - k5 === 3 && oldAfterRotation.status === 401 && newAfterRotation.status === 200 && afterRevocation.status === 401 && restored.status === 200,
                `three wrong tokens pay three scrypts (${k5b - k5}); rotated, the old token is refused at once (${oldAfterRotation.status}) and the new one taken `
                + `(${newAfterRotation.status}); revoked, refused (${afterRevocation.status}); set again, taken (${restored.status})`);
            const upper = await at(made[0].sha256.toUpperCase());
            const junk = await at('not-an-address');
            const nobody = await at(crypto.randomBytes(32).toString('hex'));
            const attachment: string = await main.send('attachment-object');
            const avatar: string = await main.send('avatar-sha', { pk: gwen.pk });
            const att = await at(attachment);
            const ava = await at(avatar);
            assert(upper.status === 400 && junk.status === 400 && nobody.status === 404 && att.status === 404 && ava.status === 404 && !!attachment && !!avatar,
                `an address not in lowercase hex is 400; one no listing photo names is 404: nothing, a chat attachment's object in M's store, a member's avatar `
                + `(${JSON.stringify({ upper: upper.status, junk: junk.status, nobody: nobody.status, attachment: att.status, avatar: ava.status })})`);

            const open = (format: string | null) => fetch(`${m}/api/local/admin/sync-copy`, {
                method: 'POST', headers: { 'X-Replication-Token': replicationToken, ...(format ? { 'X-Replica-Format': format } : {}) },
            }).then(async (r) => ({ status: r.status, text: await r.text() }));
            // A copy one of them opens after all is closed at once, so the steps after it can open theirs.
            const closeIfOpened = async (a: { status: number; text: string }) => {
                if (a.status !== 200) return;
                const id = (JSON.parse(a.text) as { copyId?: string }).copyId;
                if (id) await fetch(`${m}/api/local/admin/sync-copy/${id}`, { method: 'DELETE', headers: { 'X-Replication-Token': replicationToken } });
            };
            const none = await open(null);
            await closeIfOpened(none);
            const seven = await open('7');
            await closeIfOpened(seven);
            const log = await main.send('access-log');
            assert(none.status === 426 && seven.status === 426 && /replica format 8/.test(none.text) && /replica format 8/.test(log?.[0]?.reason ?? '') && log?.[0]?.auth === 'rejected',
                `a copy asked for by a standby that doesn't read photos by reference (no format, or 7) is refused, 426, and M's Replication Access log says why `
                + `(${none.status} ${none.text.slice(0, 120)}; ${seven.status}; ${JSON.stringify(log?.[0])})`);
            const before = await standby.send('snapshot', { tables: HASHED });
            px.stripFormat = 1;
            const p5 = await standby.send('pull', {});
            const rec5 = await standby.send('record');
            const after = await standby.send('snapshot', { tables: HASHED });
            assert(p5.ok === false && /426/.test(p5.error ?? '') && rec5.lastWhy === 'http-426' && JSON.stringify(before.tables) === JSON.stringify(after.tables),
                `S's pull, opened as an older standby opens it, fails saying so, in its record too, S unchanged (${JSON.stringify({ pull: p5, why: rec5.lastWhy })})`);
            const p5b = await standby.send('pull', {});
            assert(p5b.ok === true, `the next pull lands (${JSON.stringify(p5b)})`);
        });

        await step('6. more accounts than a delta\'s bytes: eight deltas in a row land; a delta of more changed bytes is still not taken', async () => {
            await main.send('many-accounts', { n: MANY });
            const w6 = await pullAndSwap(true);
            require_(w6.ok === true && (await exactNow()).length === 0, `S takes a whole copy of M's ${MANY} more members (${JSON.stringify(w6)})`);
            const n0 = standby.swaps();
            const pulls: { ok: boolean; mode: string; staged: boolean }[] = [];
            let fewest = Infinity;
            for (let i = 0; i < 8; i++) {
                await main.send('sql', { sql: `UPDATE members SET bio = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [`edit ${i}`, ann.pk] });
                pulls.push(await standby.send('pull', {}));
                const accountBytes = pagesOf(px).reduce((n, pg) => n + (Array.isArray(pg.accounts) ? Buffer.byteLength(JSON.stringify(pg.accounts)) : 0), 0);
                fewest = Math.min(fewest, accountBytes);
            }
            const [bio] = await standby.send('rows', { sql: 'SELECT bio FROM members WHERE public_key = ?', args: [ann.pk] });
            const diff = await exactNow();
            assert(pulls.every((p) => p.ok && p.mode === 'delta' && !p.staged) && standby.swaps() === n0 && fewest > DELTA_BYTES && bio?.bio === 'edit 7' && diff.length === 0,
                `eight pulls are eight deltas that land, each carrying ${fewest}+ bytes of accounts (more than BACKUP_DELTA_BYTES, ${DELTA_BYTES}), with no whole copy and no restart; S is M's `
                + `(${JSON.stringify({ pulls: pulls.map((p) => `${p.mode}${p.staged ? '+staged' : ''}`), swaps: standby.swaps() - n0, bio: bio?.bio })}; differences ${first(diff)}; `
                + 'before: delta, full+staged, delta, full+staged: no delta landed)');
            // More changed bytes than the bound: still a whole copy instead.
            await main.send('flood', { kind: 'long-messages', n: 40, conversationId, author: ann.pk });
            const big = await standby.send('pull', {});
            const [lines] = await standby.send('rows', { sql: `SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'flood-%'` });
            const after = await pullAndSwap(false);
            assert(big.ok === true && big.mode === 'delta' && lines.n === 0 && after.ok === true && after.mode === 'full' && after.staged === true && (await exactNow()).length === 0,
                `a delta of more changed bytes than BACKUP_DELTA_BYTES is not taken, and the next pull is a whole copy, which lands (${JSON.stringify({ big, lines: lines.n, after })})`);
        });

        await step('7. a take-over confirmed during a copy\'s fetch stops it; after copies by reference, every listing\'s photo opens on the promoted server', async () => {
            const d7 = await standby.send('pull', {});
            require_(d7.ok === true && (await photosMatch()).length === 0, `S is level with M, every photo (${JSON.stringify(d7)})`);
            const mine = new Map((await photosOf(main)).map((r) => [slot(r), r]));
            const env = await main.send('make-envelope');
            const held = await standby.send('envelope');
            require_(held === 'stored', `S holds M's take-over envelope (${held})`);
            await standby.send('takeover-restart-off');

            // Review 4148896584: M gains photos S lacks, and S takes a whole copy at a pace; the take-over is confirmed once
            // it has fetched some of their objects. Nothing more is asked of the old main server than was already on its way.
            await main.send('add-photos', { posts: listings.slice(0, 4), perPost: TAKEOVER_PHOTOS / 4, from: 20, bytes: 200 });
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '100' } });
            const g0 = gets();
            const pulling = standby.send('pull', { whole: true });
            const fetchedSome = await until('S to fetch 10 of the new objects', () => gets() >= g0 + 10, 30_000);
            const pw = { 'X-Admin-Password': PW_STANDBY };
            const openT = await post(standby.base, '/api/local/admin/takeover/open', { code: env.code }, pw);
            const confirmT = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: openT.body?.preview?.sessionId, confirm: true }, pw);
            const asksAtConfirm = px.objectAsks;
            require_(confirmT.status === 200, `the take-over is confirmed (${confirmT.status} ${JSON.stringify(confirmT.body)?.slice(0, 160)})`);
            const stopped = await pulling;
            await sleep(1500); // at the copy's pace, 15 more requests' time
            const asksAfter = px.objectAsks - asksAtConfirm;
            assert(fetchedSome && stopped.ok === false && /take-over was confirmed/.test(stopped.error ?? '') && asksAfter <= 8,
                `a whole copy's fetch stops once the take-over is confirmed: ${asksAfter} object request(s) reached the old main server after the confirm, `
                + `at most the 8 already on their way (before: every remaining one of the ${TAKEOVER_PHOTOS}), and the copy says why (${stopped.error?.slice(0, 120)})`);

            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, dir('standby'), envS);
            nodes.push(standby);
            const role = await standby.send('role');
            const s = `https://localhost:${await standby.send('serve')}`;
            const urls: { slot: string; url: string }[] = await standby.send('photo-urls');
            const failed: string[] = [];
            for (const u of urls) {
                const r = await fetch(`${s}${u.url}`);
                const body = Buffer.from(await r.arrayBuffer());
                const want = mine.get(u.slot);
                const wantSha = want?.inline ? sha256(Buffer.from(TINY_PNG.split(',')[1], 'base64')) : want?.sha256;
                if (r.status !== 200 || sha256(body) !== wantSha) failed.push(`${u.slot} ${r.status}`);
            }
            assert(role === 'primary' && urls.length === mine.size && failed.length === 0,
                `S starts as the main server, and every one of its ${urls.length} listing photos opens with M's bytes (${JSON.stringify({ role, of: mine.size })}; failed ${first(failed)})`);
        });

        await step('8. the object route is under M\'s administrative limiter', async () => {
            let status = 0;
            let n = 0;
            const before429 = new Set<number>();
            for (; n < 400 && status !== 429; n++) {
                const r = await fetch(`${m}/api/local/admin/sync-object/${made[1].sha256}`, { headers: { 'X-Replication-Token': replicationToken } });
                status = r.status;
                if (status !== 429) before429.add(status);
                await r.arrayBuffer();
            }
            assert(status === 429 && n <= 301 && before429.size === 1 && before429.has(200),
                `the object route serves the photo until, past its administrative requests a minute from one address, it answers 429 (${status} after ${n}; before it ${JSON.stringify([...before429])})`);
        });

        const blocked = [...(await main.send('fetches')).blocked, ...(await standby.send('fetches')).blocked];
        assert(blocked.length === 0, `nothing tried to leave this machine (${JSON.stringify(blocked)})`);
    } finally {
        proxy?.close();
        for (const n of nodes) await n.kill().catch(() => {});
        nodes.forEach((n, i) => { try { fs.writeFileSync(path.join(root, `node-${i}.log`), n.output()); } catch { /* the dir is gone */ } });
        console.log(`\n${testsPassed}/${testsRun} passed (${((Date.now() - started) / 1000).toFixed(0)} s)`);
        if (testsPassed !== testsRun) process.exitCode = 1;
    }
}

// ── Inside M's or S's process ──────────────────────────────────────────────────────────────

/** How many scrypts this process has started (count-scrypts): node:crypto's `scrypt`, wrapped once, as every module sees it. */
let scrypts: number | null = null;

const photoCommands: Record<string, (args: any) => Promise<unknown>> = {
    'count-scrypts': async () => {
        if (scrypts === null) {
            scrypts = 0;
            const nodeCrypto = (await import('node:crypto')).default as unknown as Record<string, unknown>;
            const { syncBuiltinESMExports } = await import('node:module');
            const real = nodeCrypto.scrypt as (...a: unknown[]) => unknown;
            nodeCrypto.scrypt = (...a: unknown[]) => { scrypts!++; return real(...a); };
            syncBuiltinESMExports();
        }
        return scrypts;
    },
    /** The replication token this main server takes, set (as the operator rotates it) or, with null, revoked. */
    'set-token': async (a: { token: string | null }) => {
        const { setReplicationToken, clearReplicationToken } = await import('./config/local-config.js');
        if (a.token) setReplicationToken(a.token);
        else clearReplicationToken();
        return true;
    },
    /**
     * Listing photos in this server's image store, as a member's upload puts them (storage/image-columns.ts): `perPost` of
     * `bytes` random bytes each on every listing in `posts`, from slot `from`; or one with the bytes of the object `sameAs`.
     */
    'add-photos': async (a: { posts: string[]; perPost?: number; bytes?: number; from?: number; sameAs?: string }) => {
        const { db } = await import('./db/db.js');
        const { getImageStore, postPhotoKey } = await import('./storage/image-store.js');
        const { storePhotoColumns } = await import('./storage/image-columns.js');
        const store = getImageStore();
        const now = new Date().toISOString();
        const out: { post_id: string; order_num: number; sha256: string; key: string }[] = [];
        for (const postId of a.posts) {
            for (let i = 0; i < (a.perPost ?? 1); i++) {
                const order = (a.from ?? 0) + i;
                const bytes = a.sameAs ? store.get(a.sameAs)! : crypto.randomBytes(a.bytes ?? 1000);
                const cols = storePhotoColumns(store, (sb) => postPhotoKey(postId, order, sb.sha256, sb.mime), `data:image/jpeg;base64,${bytes.toString('base64')}`);
                if (!cols.storage_key || !cols.sha256) throw new Error('the photo stayed inline');
                db.prepare(`INSERT OR REPLACE INTO post_photos (post_id, photo_data, order_num, updated_at, storage_key, sha256, bytes, mime) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`)
                    .run(postId, order, now, cols.storage_key, cols.sha256, cols.bytes, cols.mime);
                out.push({ post_id: postId, order_num: order, sha256: cols.sha256, key: cols.storage_key });
            }
        }
        return out;
    },
    /** Every listing photo row, and the sha256 of the object it names as this server's store holds it (null: none). */
    'photo-state': async () => {
        const { db } = await import('./db/db.js');
        const { getImageStore } = await import('./storage/image-store.js');
        const store = getImageStore();
        const rows = db.prepare(`SELECT post_id, order_num, sha256, storage_key, (photo_data IS NOT NULL AND photo_data != '') AS inline FROM post_photos ORDER BY post_id, order_num`).all() as PhotoRow[];
        return rows.map((r) => {
            const b = r.storage_key ? store.get(r.storage_key) : null;
            return { ...r, objectSha: b ? sha256(b) : null };
        });
    },
    object: async (a: { key: string }) => {
        const { getImageStore } = await import('./storage/image-store.js');
        return getImageStore().get(a.key)?.toString('base64') ?? null;
    },
    'rm-object': async (a: { key: string }) => {
        const { getImageStore } = await import('./storage/image-store.js');
        return getImageStore().delete(a.key);
    },
    'put-object': async (a: { key: string; data: string; mime: string }) => {
        const { getImageStore } = await import('./storage/image-store.js');
        getImageStore().put(a.key, Buffer.from(a.data, 'base64'), { mime: a.mime });
        return true;
    },
    /** A chat attachment's object in this server's store, as a member's attachment puts it; its sha256. */
    'attachment-object': async () => {
        const { getImageStore, attachmentKey } = await import('./storage/image-store.js');
        const { storeAttachmentColumns } = await import('./storage/image-columns.js');
        const bytes = crypto.randomBytes(900);
        const cols = storeAttachmentColumns(getImageStore(), attachmentKey(`msg-${crypto.randomUUID()}`), bytes.toString('base64'));
        if (!cols.storage_key) throw new Error('the attachment stayed inline');
        return sha256(bytes);
    },
    /** The sha256 of a member's avatar's bytes, as its members row holds them. */
    'avatar-sha': async (a: { pk: string }) => {
        const { db } = await import('./db/db.js');
        const row = db.prepare('SELECT avatar_url FROM members WHERE public_key = ?').get(a.pk) as { avatar_url: string | null } | undefined;
        const m = /^data:[^;]+;base64,(.*)$/.exec(row?.avatar_url ?? '');
        return m ? sha256(Buffer.from(m[1], 'base64')) : null;
    },
    'access-log': async () => {
        const { getReplicationAccessLog } = await import('./state-engine.js');
        return getReplicationAccessLog().recent ?? [];
    },
    /** `n` more members, each with an empty account. */
    'many-accounts': async (a: { n: number }) => {
        const { db } = await import('./db/db.js');
        db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
                    INSERT INTO members (public_key, callsign, updated_at) SELECT lower(hex(randomblob(32))), 'Many ' || i, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM n`).run(a.n);
        db.prepare(`INSERT INTO accounts (public_key, balance) SELECT public_key, 0 FROM members WHERE callsign LIKE 'Many %'`).run();
        return true;
    },
    /** Each listing photo's URL as this server hands it out with its listing (its key included). */
    'photo-urls': async () => {
        const { db } = await import('./db/db.js');
        const { postPhotoUrl } = await import('@beanpool/engine');
        const rows = db.prepare(`SELECT pp.post_id, pp.order_num, pp.updated_at, p.audience_scope FROM post_photos pp JOIN posts p ON p.id = pp.post_id`).all() as
            { post_id: string; order_num: number; updated_at: string | null; audience_scope: string | null }[];
        return rows.map((r) => ({ slot: slot(r), url: postPhotoUrl(r.post_id, r.order_num, r.updated_at, r.audience_scope) }));
    },
};

if (process.argv.includes('--child')) {
    runPagedCopyChild(photoCommands).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
