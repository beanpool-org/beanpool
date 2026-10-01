/**
 * Shared by test-standby-paged-copies.ts and test-standby-swap-at-boot.ts (not a suite itself): the orchestrator's side of a
 * main server M and a standby S, each its own process with its own data dir (takeover-test-harness.ts), S reaching M through
 * a proxy in this process. Each node's own process answers paged-copies-test-harness.ts's commands. Nothing leaves this
 * machine.
 *
 * One suite used to hold both halves (25 steps, 185-197 s alone on a Mac, 255 s on CI run 36747148280, against the
 * runner's 300 s per suite). Each suite now builds its own M, community and S here, the same way, and runs its steps.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { privateKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys';
import { spawnNode, type NodeProc } from './takeover-test-harness.js';
import { lockedDm } from './dm-test-payload.js';

export const PW_MAIN = 'Paged-Copies-Main-Pw-7719!';
export const PW_STANDBY = 'Paged-Copies-Standby-Pw-3304!';
/** M's page bounds, scaled down from 8 MB and 25,000 rows. */
export const PAGE_BYTES = 64 * 1024;
export const PAGE_ROWS = 200;
/** #1304's row cap, as its suite scales it (MAX_IMPORT_ROWS_PER_CATEGORY): no copy is left out or refused over it now. */
export const CAP = 150;
/** How long M keeps a copy no page was asked of (SYNC_COPY_IDLE_MS), scaled down from two minutes. */
export const COPY_IDLE_MS = 3000;
/** The wait after a refused force-resync or first copy (BACKUP_RESYNC_RETRY_MS), scaled down from an hour. */
export const RETRY_MS = 3000;
/** The tables hashed on both servers, row for row, to show S is M's, or unchanged. */
export const HASHED = [
    'members', 'member_preferences', 'accounts', 'transactions', 'marketplace_transactions', 'posts', 'post_photos', 'projects',
    'conversations', 'conversation_participants', 'messages', 'invite_codes', 'deferred_wage_claims', 'treasury_operators',
    'enterprise_pledges', 'invalidated_keys', 'groups', 'group_members', 'ratings', 'friends', 'tombstones', 'member_blocks',
];

// ── Checks ─────────────────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
export function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
export function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}

// Each step on its own: one that fails says so and the next still runs (on origin/main, where there are no pages).
// PAGED_STEPS_UNTIL=<n>: only the steps up to n (each builds on the one before), for a quicker look at one.
const until_ = Number(process.env.PAGED_STEPS_UNTIL) || Infinity;
export async function step(title: string, fn: () => Promise<void>): Promise<void> {
    if (Number.parseInt(title, 10) > until_) return;
    console.log(`\n— ${title} —`);
    const t = Date.now();
    try { await fn(); } catch (e: any) { assert(false, `${title}: ${e?.message || e}`); }
    console.log(`  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
}

// ── Calls, snapshots, waits ────────────────────────────────────────────────────────────────

export interface Id { pk: string; priv: crypto.KeyObject; name: string }
export function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

export interface Answer { status: number; body: any }

/** A call to a node's real HTTPS server, signed by `as`, with the admin password in `admin`, or neither. */
export async function api(base: string, method: 'GET' | 'POST', route: string, opts: { as?: Id; admin?: string; body?: unknown } = {}): Promise<Answer> {
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
export function built(what: string, a: Answer): any {
    require_(a.status >= 200 && a.status < 300, `M: ${what} (${brief(a)})`);
    return a.body;
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

export type Snap = { tables: Record<string, { count: number; hash: string }>; format: string | null; cursor: string | null; ledgerSum: number };
/** Where two snapshots differ: each table's rows, the format record, the cursor. */
export function snapDiff(a: Snap, b: Snap): string[] {
    const out: string[] = [];
    for (const [t, x] of Object.entries(a.tables)) {
        const y = b.tables[t];
        if (!y || x.hash !== y.hash) out.push(`${t} ${x.count}→${y?.count ?? 'none'}`);
    }
    if (a.format !== b.format) out.push(`format ${a.format}→${b.format}`);
    if (a.cursor !== b.cursor) out.push(`cursor ${a.cursor}→${b.cursor}`);
    return out;
}
export const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 6).join(' | ')}`);
export const counts = (s: Snap, ...ts: string[]) => ts.map((t) => `${t} ${s.tables[t]?.count}`).join(', ');
/** Every copied table S and M both hash, where they differ (engine/replica-hashes.ts). */
function hashDiff(s: Record<string, { rows: number; hash: string }>, m: Record<string, { rows: number; hash: string }>): string[] {
    return Object.keys(m).filter((t) => s[t] && (s[t].rows !== m[t].rows || s[t].hash !== m[t].hash)).map((t) => `${t} ${s[t].rows}/${m[t].rows}`);
}

/** Whether a process is still running. */
export function alive(pid: number | null | undefined): boolean {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}
export async function until(what: string, cond: () => Promise<boolean> | boolean, ms = 20_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return true;
        await sleep(50);
    }
    console.error(`  (waited ${ms} ms for ${what})`);
    return false;
}

// ── The proxy S reaches M through ──────────────────────────────────────────────────────────

/**
 * The proxy S reaches M through: every request passed on, and each copy's pages recorded. `fault` changes the page `page`
 * of the next copy opened: held back (404), replayed from an earlier copy, changed by a byte, or (the last page) its counts
 * changed and signed again with M's key.
 */
type Fault = { kind: 'withhold' | 'replay' | 'tamper' | 'counts'; page: number } | null;
export interface Proxy {
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

// ── The pair ───────────────────────────────────────────────────────────────────────────────

export interface Pair {
    /** The suite's own file, which each node process runs with --child. */
    script: string;
    root: string;
    dir: (n: string) => string;
    /** Every process started, for the clean-up (and each one's log beside the data dir). */
    nodes: NodeProc[];
    started: number;
    replicationToken: string;
    envM: Record<string, string>;
    envS: Record<string, string>;
    gwen: Id; ann: Id; bo: Id; cy: Id; dee: Id;
    /** Set by startMain. */
    proxy: Proxy | null;
    conversationId: string;
}

/** The pair's data dirs, environments and members; nothing started yet. */
export function newPair(script: string): Pair {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const [gwen, ann, bo, cy, dee] = ['Gwen', 'Ann', 'Bo', 'Cy', 'Dee'].map(newId);
    return {
        script, root, dir: (n: string) => path.join(root, n), nodes: [], started: Date.now(),
        replicationToken: crypto.randomBytes(32).toString('hex'),
        envM: {
            ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', NODE_ENV: 'test',
            SYNC_PAGE_BYTES: String(PAGE_BYTES), SYNC_PAGE_ROWS: String(PAGE_ROWS),
            // A copy a standby left unfinished (it was killed) closes after this, not two minutes (SYNC_COPY_IDLE_MS).
            SYNC_COPY_IDLE_MS: String(COPY_IDLE_MS),
        },
        envS: {
            ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000',
            MAX_IMPORT_ROWS_PER_CATEGORY: String(CAP), BACKUP_RESYNC_RETRY_MS: String(RETRY_MS), BACKUP_PAGE_GAP_MS: '0',
        },
        gwen, ann, bo, cy, dee,
        proxy: null, conversationId: '',
    };
}

/**
 * M, its community (five members with profile photos, a sale settled, a listing photo, a friendship, a DM of 3 lines and
 * 600 flooded chat lines, enough for many pages of 200), and the proxy to it. Each step of that is a check (24).
 */
export async function startMain(pair: Pair): Promise<{ main: NodeProc; m: string }> {
    const { dir, gwen, ann, bo, cy, dee } = pair;
    const main = await spawnNode(pair.script, dir('main'), pair.envM);
    pair.nodes.push(main);
    await main.send('setup-primary', { replicationToken: pair.replicationToken, genesis: gwen.pk });
    const m = `https://localhost:${await main.send('serve')}`;
    await main.send('settle-pricing');
    const As = (who: Id, route: string, body: unknown = {}) => api(m, 'POST', route, { as: who, body });
    const join = async (who: Id) => {
        const inv = built(`Gwen makes an invite for ${who.name}`, await As(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
        built(`${who.name} joins with it`, await api(m, 'POST', '/api/invite/redeem', { as: who, body: { code: inv.invite?.code ?? inv.code, publicKey: who.pk, callsign: who.name } }));
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

    pair.conversationId = conversationId;
    pair.proxy = await startProxy(main.base, () => path.join(dir('main'), 'libp2p_key'));
    return { main, m };
}

/** A standby on data dir `name`, set up against M through the proxy, with no copy yet. */
export async function startStandby(pair: Pair, name: string, main: NodeProc, opts: { maxFileBytes?: number } = {}): Promise<NodeProc> {
    fs.mkdirSync(pair.dir(name), { recursive: true });
    fs.copyFileSync(path.join(pair.dir('main'), 'genesis.json'), path.join(pair.dir(name), 'genesis.json'));
    const standby = await spawnNode(pair.script, pair.dir(name), pair.envS, opts);
    pair.nodes.push(standby);
    await standby.send('setup-standby', { primaryUrl: pair.proxy!.url, replicationToken: pair.replicationToken, primaryPeerId: main.ready.peerId });
    return standby;
}

/** The looks and pulls every step makes, on whichever M and S are current (`now`). */
export function pairHelpers(now: () => { main: NodeProc; standby: NodeProc }) {
    const snapS = async (): Promise<Snap> => now().standby.send('snapshot', { tables: HASHED });
    const snapM = async (): Promise<Snap> => now().main.send('snapshot', { tables: HASHED });
    const exactNow = async () => hashDiff(await now().standby.send('hashes'), await now().main.send('hashes'));
    /** A pull (a whole one when `whole`); one that made a copy ready is waited for until S has started again on it. */
    const pullAndSwap = async (whole: boolean) => {
        const standby = now().standby;
        const before = standby.swaps();
        const p = await standby.send('pull', whole ? { whole: true } : {});
        if (p.staged) await until('S to start again on the new copy', () => standby.swaps() > before, 60_000);
        return p;
    };
    const wholeCopy = () => pullAndSwap(true);
    return { snapS, snapM, exactNow, pullAndSwap, wholeCopy };
}

/** Every process stopped, each one's output written beside its data dir, and the count. */
export async function closePair(pair: Pair): Promise<void> {
    pair.proxy?.close();
    for (const n of pair.nodes) await n.kill().catch(() => {});
    // Each node's own output, beside its data dir, for a look after a failure.
    pair.nodes.forEach((n, i) => { try { fs.writeFileSync(path.join(pair.root, `node-${i}.log`), n.output()); } catch { /* the dir is gone */ } });
    console.log(`\n${testsPassed}/${testsRun} passed (${((Date.now() - pair.started) / 1000).toFixed(0)} s)`);
    if (testsPassed !== testsRun) process.exitCode = 1;
}

/** Steps 10, 19 and 22's promoted server: its take-over audit, as recorded (services/takeover.ts runPendingPromotionAudit). Runs in the node's process. */
export const auditCommand: Record<string, (args: any) => Promise<unknown>> = {
    audit: async () => {
        const { getLocalConfig } = await import('./config/local-config.js');
        const a = getLocalConfig().lastPromotionAudit;
        return a ? { ok: a.ok, drift: a.drift, copy: a.copy?.match ?? null } : null;
    },
};
