/**
 * Test Suite: a standby's copy whose listing photos can't all be fetched (F4 and F5 of the 2026-10-01 standby review,
 * scratch/reviews/FABLE-standby-e2e.md; the follow-up to #1378). A broken photo on the main server must not make a standby
 * ask it for a whole copy, built, signed and sent, at a fixed pace for ever; and what a failed pull fetched stays, so the
 * next asks only for the rest.
 *
 * A main server M and a standby S, each its own process with its own data dir (takeover-test-harness.ts), M serving its real
 * backup routes and S pulling through its real puller. S reaches M through a proxy in this process, which passes every
 * request on, notes each copy opened and when, counts the objects S fetches, and answers 503 for the objects it is told
 * are broken, as a main server whose image store refuses one object. M's page bounds are scaled to 64 KB and 200 rows,
 * so its copies take many pages; S's waits are scaled from an hour (BACKUP_RESYNC_RETRY_MS) and a day
 * (BACKUP_COPY_RETRY_MAX_MS) to seconds. Nothing leaves this machine.
 *
 *  1. S's first copy, one of M's photos broken: every page comes, and the copy fails at that photo, each time. Each such
 *     copy in a row waits about twice as long as the one before (the first RESYNC_RETRY_MS), never longer than the cap, each
 *     wait shortened by up to a fifth at random; S asks M for nothing in between. An operator's resync is still taken at
 *     once. No object is fetched twice; those fetched are kept through an orphan sweep past the sweep's hour of grace.
 *     Settings (backup-status) says what S is waiting on, until when, how many tries, and how many photos are kept.
 *     (Before: the same wait every time, RESYNC_RETRY_MS, for ever; Settings said nothing of it.)
 *  2. The photo comes back: once the wait has passed, the next copy lands, fetching only what S lacked, none of what it
 *     fetched before; the kept objects are let go, and Settings says nothing is waited on.
 *  3. A delta whose new photo is broken: the next delta is asked for at once (deltas cost little), and the objects the
 *     failed delta fetched are kept through an orphan sweep past the sweep's hour of grace; once the photo comes back the
 *     delta lands, fetching only the rest. (Before: swept, and every one fetched again.)
 *  4. A routine whole copy that needs a photo S lost, broken on M: it waits from the routine interval again (a whole copy
 *     landed in step 2, so the count started over), twice as long each time, while every delta meanwhile lands.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-copy-retries.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, type NodeProc } from './takeover-test-harness.js';
import { runPagedCopyChild } from './paged-copies-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Copy-Retries-Main-Pw-6612!';
const PW_STANDBY = 'Copy-Retries-Standby-Pw-1904!';
/** M's page bounds, scaled down from 8 MB and 25,000 rows. */
const PAGE_BYTES = 64 * 1024;
const PAGE_ROWS = 200;
const LISTINGS = 16;
const PER_LISTING = 2;
const PHOTO_BYTES = 3000;
/** S's BACKUP_RESYNC_RETRY_MS: a first copy's first wait (an hour in production). */
const RETRY_MS = 1000;
/** S's BACKUP_COPY_RETRY_MAX_MS: the longest wait (a day in production). */
const CAP_MS = 4000;
/** How much shorter than its schedule a wait may be drawn (services/backup-puller.ts COPY_RETRY_JITTER). */
const JITTER = 0.2;
/** Step 1's failed copies in a row before the operator's resync. */
const FAILS = 5;
/** Step 4's routine whole-copy interval (BACKUP_RECONCILE_EVERY_MS), scaled from 15 minutes. */
const ROUTINE_MS = 1000;
/** The orphan sweep's grace (engine/storage-health.ts ORPHAN_OBJECT_GRACE_MS): an object no row names is kept this long. */
const ORPHAN_GRACE_MS = 60 * 60_000;
/** Slack for a reply's way back to this process: a wait read here is at most this much shorter than the one S drew. */
const SLACK_MS = 150;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const first = (xs: unknown[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 5).map((x) => JSON.stringify(x)).join(' | ')}`);
/** The wait S draws for the `n`-th failed copy in a row from `base`, before its jitter (services/backup-puller.ts). */
const schedule = (base: number, n: number) => Math.min(Math.max(CAP_MS, base), base * 2 ** (n - 1));

/** The proxy S reaches M through. `broken`: objects answered 503 here, as a main server whose store refuses them. */
interface Proxy {
    url: string;
    opened: { id: string; at: number; delta: boolean }[];
    objectGets: string[];
    broken: Set<string>;
    close: () => void;
}
async function startProxy(target: string): Promise<Proxy> {
    const px: Proxy = { url: '', opened: [], objectGets: [], broken: new Set(), close: () => {} };
    const server = http.createServer((req, res) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'content-length') headers[k] = v;
            const url = new URL(req.url ?? '/', 'http://proxy');
            const object = /^\/api\/local\/admin\/sync-object\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
            const opening = req.method === 'POST' && url.pathname === '/api/local/admin/sync-copy';
            const askedAt = Date.now();
            let status = 502;
            let raw: Buffer = Buffer.alloc(0);
            const outHeaders: Record<string, string> = {};
            if (object && px.broken.has(object)) {
                status = 503;
                raw = Buffer.from(JSON.stringify({ error: 'the image store is not answering' }));
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
            if (object && status === 200) px.objectGets.push(object);
            if (opening && status === 200) {
                try {
                    const parsed = JSON.parse(raw.toString('utf-8'));
                    if (typeof parsed?.copyId === 'string') px.opened.push({ id: parsed.copyId, at: askedAt, delta: url.searchParams.has('since') });
                } catch { /* not a page */ }
            }
            res.writeHead(status, outHeaders);
            res.end(raw);
        })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    px.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    px.close = () => server.close();
    return px;
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
        BACKUP_RESYNC_RETRY_MS: String(RETRY_MS), BACKUP_COPY_RETRY_MAX_MS: String(CAP_MS), BACKUP_PAGE_GAP_MS: '0',
    };
    const gwen = crypto.randomBytes(32).toString('hex');
    let proxy: Proxy | null = null;

    const step = async (title: string, fn: () => Promise<void>) => {
        console.log(`\n— ${title} —`);
        const t = Date.now();
        try { await fn(); } catch (e: any) { assert(false, `${title}: ${e?.message || e}`); }
        console.log(`  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    };

    try {
        // ── M: listings with photos in its image store ──
        const main = await spawnNode(SCRIPT, dir('main'), envM);
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, genesis: gwen });
        await main.send('serve');
        await main.send('settle-pricing');
        await main.send('flood', { kind: 'posts', n: LISTINGS, author: gwen });
        const listings = (await main.send('rows', { sql: `SELECT id FROM posts WHERE id LIKE 'flood-%' ORDER BY id` })).map((r: { id: string }) => r.id) as string[];
        const made: { post_id: string; order_num: number; sha256: string; key: string }[] = await main.send('add-photos', { posts: listings, perPost: PER_LISTING, bytes: PHOTO_BYTES });
        require_(listings.length === LISTINGS && made.length === LISTINGS * PER_LISTING, `M holds ${made.length} listing photos in its image store, on ${listings.length} listings`);

        proxy = await startProxy(main.base);
        const px = proxy;
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        const s = await spawnNode(SCRIPT, dir('standby'), envS);
        nodes.push(s);
        await s.send('setup-standby', { primaryUrl: px.url, replicationToken, primaryPeerId: main.ready.peerId });

        const photosOf = async (node: NodeProc): Promise<PhotoRow[]> => node.send('photo-state');
        /** S's photos against M's: each slot's sha256, and S's object of it holding those bytes. */
        const photosMatch = async (): Promise<string[]> => {
            const mine = new Map((await photosOf(s)).map((r) => [slot(r), r]));
            const out: string[] = [];
            for (const r of await photosOf(main)) {
                const got = mine.get(slot(r));
                if (!got) out.push(`${slot(r)} missing`);
                else if (got.sha256 !== r.sha256 || got.objectSha !== r.sha256) out.push(`${slot(r)} ${got.sha256?.slice(0, 8)}/${got.objectSha?.slice(0, 8)} not ${r.sha256?.slice(0, 8)}`);
            }
            return out;
        };
        /** Settings' view of S: its backup-status, over its own HTTP server, with its admin password. */
        const settings = async (): Promise<any> => {
            const r = await fetch(`${s.base}/api/local/admin/backup-status`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': PW_STANDBY }, body: '{}',
            });
            require_(r.ok, `S's backup-status answers (${r.status})`);
            return r.json();
        };
        /** A pull by S; one that made a copy ready is waited for until S has started again on it. */
        const pullAndSwap = async (whole = false) => {
            const before = s.swaps();
            const p = await s.send('pull', whole ? { whole: true } : {});
            if (p.staged) await until('the standby to start again on the new copy', () => s.swaps() > before, 60_000);
            return p;
        };
        /**
         * S's pulls, one every 100 ms, until `copies` copies (of the kind `isCopy` picks) have been opened on M and failed:
         * each one's opening, the time its pull answered, and the retry time S then gave it (`retryAt`); and every other
         * pull's answer.
         */
        const pullUntilFailed = async (copies: number, retryAtOf: (st: any) => number | null, isCopy: (o: { delta: boolean }) => boolean) => {
            const tries: { openedAt: number; answeredAt: number; retryAt: number; error: string | null; tries: number | null }[] = [];
            const between: { ok: boolean; mode: string | null; error: string | null; opened: boolean }[] = [];
            const deadline = Date.now() + 60_000;
            while (tries.length < copies && Date.now() < deadline) {
                const o0 = px.opened.length;
                const r = await s.send('pull', {});
                const answeredAt = Date.now();
                const mine = px.opened.slice(o0).find(isCopy);
                if (mine && !r.ok) {
                    const st = await s.send('status');
                    tries.push({ openedAt: mine.at, answeredAt, retryAt: retryAtOf(st) ?? 0, error: r.error, tries: st.copyWait?.tries ?? null });
                } else {
                    between.push({ ok: r.ok, mode: r.mode, error: r.error, opened: px.opened.length > o0 });
                }
                await sleep(100);
            }
            return { tries, between };
        };

        const allShas = new Set(made.map((p) => p.sha256));
        const broken = made[Math.floor(made.length / 3)];
        /** Every object S fetched in step 1, by sha256: none twice, and the ones the copy that lands fetches none of. */
        let fetchedBefore = new Set<string>();

        await step('1. a first copy that fails at a broken photo, again and again: each waits about twice as long, never past the cap', async () => {
            px.broken.add(broken.sha256);
            const g0 = px.objectGets.length;
            const { tries, between } = await pullUntilFailed(FAILS, (st) => st.resyncRetryAt, () => true);
            require_(tries.length === FAILS && tries.every((t) => /HTTP 503/.test(t.error ?? '')),
                `S's first copy came, every page, and failed at the broken photo, M's store answering 503, ${tries.length} times (${first(tries.map((t) => t.error?.slice(0, 120)))})`);
            const waits = tries.map((t, i) => ({ n: i + 1, drawn: t.retryAt - t.answeredAt, schedule: schedule(RETRY_MS, i + 1) }));
            const off = waits.filter((w) => w.drawn > w.schedule || w.drawn < (1 - JITTER) * w.schedule - SLACK_MS);
            assert(off.length === 0,
                `each failed copy in a row waits about twice as long as the one before, from RESYNC_RETRY_MS (${RETRY_MS} ms) to the cap (${CAP_MS} ms), `
                + `each at most a fifth shorter: ${waits.map((w) => `${w.drawn}/${w.schedule}`).join(', ')} ms (outside: ${first(off)}; before: ${RETRY_MS} every time)`);
            assert(waits.every((w) => w.drawn <= CAP_MS) && waits.slice(-2).every((w) => w.drawn >= (1 - JITTER) * CAP_MS - SLACK_MS),
                `the waits stop growing at the cap: the last two ${waits.slice(-2).map((w) => w.drawn).join(' and ')} ms, none past ${CAP_MS} ms`);
            // Each wait over its schedule: between 0.8 and 1, and not the same for all (six draws all within 0.01 of each other
            // happen about twice in a million runs).
            const ratios = waits.map((w) => w.drawn / w.schedule);
            assert(ratios.every((r, i) => r >= 1 - JITTER - SLACK_MS / waits[i].schedule && r <= 1) && Math.max(...ratios) - Math.min(...ratios) > 0.01,
                `the waits are jittered, each its schedule shortened by a different fraction up to a fifth (${ratios.map((r) => r.toFixed(3)).join(', ')}; before: 1, 1/2, 1/4…)`);
            const early = tries.slice(1).filter((t, i) => t.openedAt < tries[i].retryAt);
            const askedBetween = between.filter((b) => b.opened);
            assert(early.length === 0 && askedBetween.length === 0 && between.length > 0 && between.every((b) => /asked for at/.test(b.error ?? '')),
                `S asks M for no copy before each wait has passed: ${between.length} pulls meanwhile each answered that it waits (${first(askedBetween)}; early ${first(early)})`);
            assert(tries.every((t, i) => t.tries === i + 1), `S counts the failed copies in a row (${tries.map((t) => t.tries).join(', ')})`);

            // Settings: what S waits on, in words, until when, the try, and the photos kept for the next.
            const st = await settings();
            const wait = st.copyWait;
            fetchedBefore = new Set(px.objectGets.slice(g0));
            assert(px.objectGets.length - g0 === fetchedBefore.size && fetchedBefore.size > 0 && !fetchedBefore.has(broken.sha256),
                `no object is fetched twice across the ${FAILS} copies: ${px.objectGets.length - g0} fetches, ${fetchedBefore.size} distinct`);
            assert(wait && wait.until === st.resyncRetryAt && wait.kind === 'first' && wait.tries === FAILS && wait.keptObjects === fetchedBefore.size
                && typeof wait.waitingOn === 'string' && /photo/i.test(wait.waitingOn) && /503/.test(wait.waitingOn) && /twice/.test(wait.waitingOn)
                && new RegExp(`${fetchedBefore.size} photos? .*kept`).test(wait.waitingOn) && /Resync/.test(wait.waitingOn),
                `Settings says what S waits on, until when, which try, and the photos kept (${JSON.stringify(wait)}; before: nothing)`);

            // The operator's resync is taken at once, whatever the wait; failing so too, it waits at the cap.
            const o0 = px.opened.length;
            const r = await s.send('resync');
            const answeredAt = Date.now();
            const st2 = await s.send('status');
            assert(r.ok === false && px.opened.length === o0 + 1 && st2.copyWait?.tries === FAILS + 1
                && st2.resyncRetryAt - answeredAt <= CAP_MS && st2.resyncRetryAt - answeredAt >= (1 - JITTER) * CAP_MS - SLACK_MS,
                `an operator's resync is asked for at once, and, failing so, waits at the cap (${JSON.stringify({ r, opened: px.opened.length - o0, wait: st2.resyncRetryAt - answeredAt, tries: st2.copyWait?.tries })})`);
            fetchedBefore = new Set(px.objectGets.slice(g0));
            require_(px.objectGets.length - g0 === fetchedBefore.size, `the resync fetched nothing fetched before (${px.objectGets.length - g0}/${fetchedBefore.size})`);

            // F5: what the failed copies fetched outlives the orphan sweep's hour of grace (no row names it, no staging does).
            const swept = await s.send('sweep-orphans', { aheadMs: ORPHAN_GRACE_MS + 60_000 });
            const held: number = await s.send('has-objects', { groups: made.filter((p) => fetchedBefore.has(p.sha256)).map((p) => [p.key]) });
            assert(held === made.filter((p) => fetchedBefore.has(p.sha256)).length,
                `the ${fetchedBefore.size} objects the failed copies fetched are kept through an orphan sweep an hour and a minute on (${held} held; ${JSON.stringify(swept)})`);
        });

        await step('2. the photo comes back: the next copy lands once the wait has passed, fetching only what S lacked', async () => {
            px.broken.delete(broken.sha256);
            const st0 = await s.send('status');
            await sleep(Math.max(0, (st0.resyncRetryAt ?? 0) + 150 - Date.now()));
            const g0 = px.objectGets.length;
            const p = await pullAndSwap();
            const got = px.objectGets.slice(g0);
            const again = got.filter((x) => fetchedBefore.has(x));
            const lacked = [...allShas].filter((x) => !fetchedBefore.has(x));
            assert(p.ok === true && p.staged === true, `the next copy lands (${JSON.stringify(p)})`);
            assert(again.length === 0 && got.length === lacked.length && lacked.every((x) => got.includes(x)),
                `it fetches only the ${lacked.length} object(s) S lacked, none of the ${fetchedBefore.size} fetched before (${got.length} fetched, ${again.length} again)`);
            const mismatch = await photosMatch();
            const st = await settings();
            assert(mismatch.length === 0 && (await s.send('kept')) === null && st.copyWait === null && st.resyncRetryAt === null,
                `every photo of M's is S's, the kept objects are let go, and Settings says nothing is waited on (${first(mismatch)}; ${JSON.stringify(st.copyWait)})`);
        });

        await step('3. a delta whose new photo is broken: asked for again at once, and what it fetched stays for the next', async () => {
            const fresh: { post_id: string; order_num: number; sha256: string; key: string }[] = await main.send('add-photos', { posts: listings.slice(0, 10), from: 5, bytes: PHOTO_BYTES });
            const bad = fresh[fresh.length - 1];
            px.broken.add(bad.sha256);
            const g0 = px.objectGets.length;
            const o0 = px.opened.length;
            const d1 = await s.send('pull', {});
            const d2 = await s.send('pull', {});
            const firstFetched = new Set(px.objectGets.slice(g0));
            require_(d1.ok === false && d1.mode === 'delta' && /HTTP 503/.test(d1.error ?? '') && firstFetched.size > 0,
                `the delta fails at the broken photo, having fetched ${firstFetched.size} of the ${fresh.length} new ones (${JSON.stringify(d1)})`);
            assert(d2.ok === false && d2.mode === 'delta' && px.opened.length === o0 + 2 && px.opened.slice(o0).every((o) => o.delta)
                && px.objectGets.length - g0 === firstFetched.size,
                `the next delta is asked for at once, deltas costing little, and fetches nothing fetched before (${JSON.stringify(d2)})`);
            const swept = await s.send('sweep-orphans', { aheadMs: ORPHAN_GRACE_MS + 60_000 });
            const held: number = await s.send('has-objects', { groups: fresh.filter((p) => firstFetched.has(p.sha256)).map((p) => [p.key]) });
            assert(held === firstFetched.size,
                `the ${firstFetched.size} objects the failed delta fetched are kept through an orphan sweep an hour and a minute on (${held} held; ${JSON.stringify(swept)}; before: swept)`);
            px.broken.delete(bad.sha256);
            const g1 = px.objectGets.length;
            const d3 = await s.send('pull', {});
            const got = px.objectGets.slice(g1);
            assert(d3.ok === true && d3.mode === 'delta' && got.length === fresh.length - firstFetched.size && !got.some((x) => firstFetched.has(x))
                && (await photosMatch()).length === 0,
                `once the photo comes back the delta lands, fetching only the ${fresh.length - firstFetched.size} it lacked (${got.length} fetched; ${JSON.stringify(d3)}; before: all ${fresh.length})`);
        });

        await step('4. a routine whole copy that needs a broken photo waits from the routine interval again, twice as long each time, deltas landing meanwhile', async () => {
            const lost = made[made.length - 1];
            require_(await s.send('rm-object', { key: lost.key }), `S loses ${slot(lost)}'s object`);
            px.broken.add(lost.sha256);
            await s.send('set-env', { vars: { BACKUP_RECONCILE_EVERY_MS: String(ROUTINE_MS), BACKUP_BIG_COPY_EVERY_MS: String(ROUTINE_MS) } });
            await sleep(ROUTINE_MS + 50);
            const { tries, between } = await pullUntilFailed(3, (st) => st.wholeRetryAt, (o) => !o.delta);
            await s.send('set-env', { vars: { BACKUP_RECONCILE_EVERY_MS: '86400000', BACKUP_BIG_COPY_EVERY_MS: null } });
            px.broken.delete(lost.sha256);
            require_(tries.length === 3 && tries.every((t) => /HTTP 503/.test(t.error ?? '')),
                `three routine whole copies fail at the broken photo (${first(tries.map((t) => t.error?.slice(0, 120)))})`);
            const waits = tries.map((t, i) => ({ drawn: t.retryAt - t.answeredAt, schedule: schedule(ROUTINE_MS, i + 1) }));
            const off = waits.filter((w) => w.drawn > w.schedule || w.drawn < (1 - JITTER) * w.schedule - SLACK_MS);
            assert(off.length === 0 && tries[0].tries === 1,
                `they wait from the routine interval, the count started over by the copy that landed, twice as long each time: `
                + `${waits.map((w) => `${w.drawn}/${w.schedule}`).join(', ')} ms (tries ${tries.map((t) => t.tries).join(', ')}; before: ${ROUTINE_MS} every time)`);
            const deltas = between.filter((b) => b.opened);
            assert(deltas.length > 0 && deltas.every((b) => b.ok && b.mode === 'delta'),
                `every pull between them is a delta, and lands (${deltas.length}: ${first(deltas.filter((b) => !b.ok || b.mode !== 'delta'))})`);
        });
    } finally {
        proxy?.close();
        for (const n of nodes) await n.kill().catch(() => {});
        nodes.forEach((n, i) => { try { fs.writeFileSync(path.join(root, `node-${i}.log`), n.output()); } catch { /* the dir is gone */ } });
        console.log(`\n${testsPassed}/${testsRun} passed (${((Date.now() - started) / 1000).toFixed(0)} s)`);
        if (testsPassed !== testsRun) process.exitCode = 1;
    }
}

// ── Inside M's or S's process ──────────────────────────────────────────────────────────────

const commands: Record<string, (args: any) => Promise<unknown>> = {
    /** The puller's status, as backup-status reads it. */
    status: async () => {
        const { getBackupStatus } = await import('./services/backup-puller.js');
        return getBackupStatus();
    },
    /** Listing photos in this server's image store, as a member's upload puts them: `perPost` on every listing, from slot `from`. */
    'add-photos': async (a: { posts: string[]; perPost?: number; bytes?: number; from?: number }) => {
        const { db } = await import('./db/db.js');
        const { getImageStore, postPhotoKey } = await import('./storage/image-store.js');
        const { storePhotoColumns } = await import('./storage/image-columns.js');
        const store = getImageStore();
        const now = new Date().toISOString();
        const out: { post_id: string; order_num: number; sha256: string; key: string }[] = [];
        for (const postId of a.posts) {
            for (let i = 0; i < (a.perPost ?? 1); i++) {
                const order = (a.from ?? 0) + i;
                const bytes = crypto.randomBytes(a.bytes ?? 1000);
                const cols = storePhotoColumns(store, (sb) => postPhotoKey(postId, order, sb.sha256, sb.mime), `data:image/jpeg;base64,${bytes.toString('base64')}`);
                if (!cols.storage_key || !cols.sha256) throw new Error('the photo stayed inline');
                db.prepare(`INSERT OR REPLACE INTO post_photos (post_id, photo_data, order_num, updated_at, storage_key, sha256, bytes, mime) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`)
                    .run(postId, order, now, cols.storage_key, cols.sha256, cols.bytes, cols.mime);
                out.push({ post_id: postId, order_num: order, sha256: cols.sha256, key: cols.storage_key });
            }
        }
        return out;
    },
    /** One pass of the orphan sweep (engine/storage-health.ts), as its clock would run it `aheadMs` from now. */
    'sweep-orphans': async (a: { aheadMs: number }) => {
        const { sweepOrphanedImageObjects } = await import('./engine/storage-health.js');
        return sweepOrphanedImageObjects({ nowMs: Date.now() + a.aheadMs });
    },
    /** How many of these groups of keys this server's image store holds an object under one of. */
    'has-objects': async (a: { groups: string[][] }) => {
        const { getImageStore } = await import('./storage/image-store.js');
        const store = getImageStore();
        return a.groups.filter((keys) => keys.some((k) => !!store.head(k))).length;
    },
    /** What a failed pull's objects are kept for the next with (services/stager.ts KEPT_OBJECTS_FILE), or null: none. */
    kept: async () => {
        try { return JSON.parse(fs.readFileSync(path.join(process.env.BEANPOOL_DATA_DIR!, 'copy-objects-kept.json'), 'utf-8')); } catch { return null; }
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
    'rm-object': async (a: { key: string }) => {
        const { getImageStore } = await import('./storage/image-store.js');
        return getImageStore().delete(a.key);
    },
};

if (process.argv.includes('--child')) {
    runPagedCopyChild(commands).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
