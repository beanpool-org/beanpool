/**
 * Test Suite: a community's owners are told when its standby stops copying or copies wrongly (standby PR 5: G8 of
 * scratch/global-node/DESIGN-standby-takeover-gaps-opus.md, with Marty's answers of 2026-09-28: owners told in the app, one
 * push and a Settings banner per incident; the standby re-seeds itself when it can; a take-over from a copy known to be
 * stale or wrong goes ahead with a plain warning).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts). The standby pulls through its real puller
 * (services/backup-puller.ts `pullNow`, the loop's own step) from the main server's real backup routes, through a door here
 * that passes every request on, headers and all, except that a step can have the next copy the standby asks for answered
 * with a payload the main server signed. Pushes are handed to a stub of the push service here; nothing leaves this machine.
 * The main server's watch runs on a clock a step moves forward (setStandbyHealthClockForTests).
 *
 *  1. A healthy standby: its first copy, a delta, a whole copy. The main server sends its table hashes with the whole copy
 *     (signed with the rest), the standby finds every table and every account equal, and reports it. No incident, no push,
 *     nothing in the admin queue; the take-over preview says "Last exact copy of the main server: <time>".
 *     A whole copy whose every account entry has no key a server can hold (#1268's case): no force-resync, no verdict.
 *     A listing photo the main server can't read from its own storage: left out of both servers' hashes and said as such,
 *     never a difference and never a force-resync.
 *  2. The standby stops for an hour (the main server's clock): one incident, one push, to the owner's phone only (not the
 *     admin's, the moderator's or a member's); the owner's admin queue and Settings banner show it, an admin's and a
 *     moderator's queue don't. A second check pushes nothing more. The standby pulls again: the incident ends.
 *  3. Three copies in a row refused (payloads the main server signed that make Beans): the standby's record says so, and its
 *     preview; its next pull reports it and an incident opens, with one push; the pull after ends it.
 *  4. A whole copy that isn't the main server's (a planted change in a table, the ledger fine): recorded with what differed,
 *     and one force-resync asked for. That resync is held to the ledger (not a seed): a forged payload that makes Beans is
 *     refused, and the real copy after it lands and is exact. The standby mended it by itself, so nobody was told: no
 *     incident, no push (Marty's answer 2). Planted again, and the standby restarts between asking for its held resync and
 *     taking it, M answering its first pull after with a 503: it still takes that resync, the copy heals, nobody is told,
 *     and another restart takes it no more (review 4119011899). Six hours on (a restart, the record's last resync moved back), planted
 *     again: the held resync lands a copy M signed whose members aren't M's, the check after it still differs, and that is
 *     when the incident opens, with one push. A restart then allows no sooner force-resync (the record keeps when the last was),
 *     the incident stays, and the banner and the preview say what didn't match. Then a whole copy the main
 *     server sends without its hashes (as it does when written to while making one): recorded as not compared in full, it
 *     is no all-clear (review 4118340714): the incident stays open, and the preview still warns and names the older exact copy.
 *  5. The report can't be forged into anything: too long, not JSON, a field out of shape, sent with the admin password
 *     instead of the replication token, or with a wrong token: ignored. A well-formed one with the token from a second
 *     standby is kept (so the refusals aren't vacuous), and an owner stops watching it.
 *  6. The main server dies; the standby, whose last whole copy did not match, is taken over with the recovery code. The
 *     preview says in plain words what didn't match and when the last exact copy was, and the take-over goes ahead.
 *  7. The old main server comes back as a standby, still holding the incident it had open: its owner's admin queue and
 *     Settings show none (it watches no standby now, so the owner could never clear it).
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-health.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Standby-Health-Main-Pw-4471!';
const PW_STANDBY = 'Standby-Health-Standby-Pw-902!';
const HOUR = 60 * 60_000;

// ── The node processes' commands ───────────────────────────────────────────────────────────

/** No node reaches anything but this machine: a push is answered here and kept, anything else refused and counted. */
function guardFetch(): { blocked: string[]; pushes: { to: string[]; title: string; body: string }[] } {
    const seen = { blocked: [] as string[], pushes: [] as { to: string[]; title: string; body: string }[] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') {
            const batch = JSON.parse(String(init?.body ?? '[]')) as { to: string; title: string; body: string }[];
            seen.pushes.push({ to: batch.map((m) => m.to), title: batch[0]?.title ?? '', body: batch[0]?.body ?? '' });
            return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        seen.blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return seen;
}

/** A module this branch adds, or null on a server without it (so the suite runs, and fails, on one). */
async function optional<T>(load: () => Promise<T>): Promise<T | null> {
    try { return await load(); } catch { return null; }
}

async function child(): Promise<void> {
    const fetches = guardFetch();
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; gwen: string; ann: string; bo: string; cy: string }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { grantNodeRole } = await import('./engine/node-roles.js');
            const { payFromCommons } = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const { db } = await import('./db/db.js');
            seedGenesisMember(a.gwen, 'Gwen');
            for (const [pk, callsign] of [[a.ann, 'Ann'], [a.bo, 'Bo'], [a.cy, 'Cy']]) {
                db.prepare('INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)')
                    .run(pk, callsign, new Date().toISOString(), a.gwen, 'TEST');
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
            }
            grantNodeRole(a.ann, 'admin', a.gwen);
            grantNodeRole(a.bo, 'moderator', a.gwen);
            // Beans that moved, so a copy that makes more is one the ledger check refuses.
            payFromCommons(a.cy, 5, 'a commons grant', { allowDeficit: true });
            // Every one of them has a phone that registered with this server.
            for (const [pk, token] of [[a.gwen, 'ExponentPushToken[gwen-owner]'], [a.ann, 'ExponentPushToken[ann-admin]'],
                [a.bo, 'ExponentPushToken[bo-moderator]'], [a.cy, 'ExponentPushToken[cy-member]']]) {
                db.prepare("INSERT INTO push_tokens (public_key, token, platform) VALUES (?, ?, 'android')").run(pk, token);
            }
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
        /** One pull of the kind the loop makes next (and the take-over envelope, as the loop fetches it); `whole` asks the loop's routine whole copy. */
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            process.env.BACKUP_RECONCILE_EVERY_MS = '86400000';
            const envelope = await pullTakeoverEnvelopeNow();
            const after = getBackupStatus();
            return { ...result, mode: after.lastPullMode, whole: after.lastFullReconcileAt !== before, envelope };
        },
        /** The standby's record of its copies (services/standby-copy-record.ts), or null on a server without one. */
        record: async () => {
            const m = await optional(() => import('./services/standby-copy-record.js'));
            return m ? m.readCopyRecord() : null;
        },
        /** The take-over preview's words on the copy, as if it were `offsetMs` later on this standby. */
        'preview-words': async (a: { offsetMs?: number }) => {
            const m = await optional(() => import('./services/standby-copy-record.js'));
            const { getBackupStatus } = await import('./services/backup-puller.js');
            return m ? m.copyCheckForPreview(getBackupStatus().lastSuccessAt, Date.now() + (a.offsetMs ?? 0)) : null;
        },
        /** Move the standby's record of its last force-resync for a copy that didn't match back by `agoMs`. */
        'resync-slot': async (a: { agoMs: number }) => {
            const { db } = await import('./db/db.js');
            const row = db.prepare("SELECT value FROM node_config WHERE key = 'standby_copy_record'").get() as { value: string } | undefined;
            if (!row) return false;
            const r = JSON.parse(row.value);
            r.lastMismatchResyncAt = Date.now() - a.agoMs;
            db.prepare("UPDATE node_config SET value = ? WHERE key = 'standby_copy_record'").run(JSON.stringify(r));
            return true;
        },
        /** A change in a copied table, made on the standby alone, as a bug would make it: the ledger untouched. */
        plant: async (a: { publicKey: string; value: string }) => {
            const { db } = await import('./db/db.js');
            return db.prepare('UPDATE members SET contact_value = ? WHERE public_key = ?').run(a.value, a.publicKey).changes;
        },
        /** A linked community's listing in the cache, as the federation pull writes it (no route: the libp2p pull loop). */
        'cache-peer-listing': async (a: { peerId: string; listing: Record<string, unknown> }) => {
            const { cacheRemoteListings } = await import('./federation-listings.js');
            return cacheRemoteListings(a.peerId, 'https://neighbours.example', [a.listing]);
        },
        /** A write on the main server, so the next whole copy isn't the bodiless "unchanged" 304. */
        touch: async () => {
            const { db } = await import('./db/db.js');
            db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('test_touch', ?)").run(new Date().toISOString());
            return true;
        },
        /** A payload the main server signs that makes 50 Beans for one account: only the ledger's check stands in its way. */
        'forge-mint': async (a: { publicKey: string }) => {
            const { exportSyncState, signSyncPayload } = await import('./state-engine.js');
            const { getPrivateKey } = await import('./p2p.js');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const payload: any = await exportSyncState(peerIdFromPrivateKey(getPrivateKey()).toString());
            delete payload.signature;
            delete payload.publicKey;
            payload.accounts = payload.accounts.map((x: any) => (x.publicKey === a.publicKey ? { ...x, balance: x.balance + 50 } : x));
            payload.generatedAt = new Date().toISOString();
            return signSyncPayload(payload);
        },
        /** A listing of M's whose photo M's own image store doesn't have: its copies leave the photo's row out and name it. */
        'photo-main-cannot-read': async (a: { author: string }) => {
            const { db } = await import('./db/db.js');
            const at = new Date().toISOString();
            db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, created_at, updated_at)
                VALUES ('plums-lost-photo', 'offer', 'food', 'Plums', 'Plums, from Gwen', 2, ?, 'active', ?, ?)`).run(a.author, at, at);
            return db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, updated_at, storage_key, mime)
                VALUES ('plums-lost-photo', NULL, 0, ?, 'photos/lost-on-the-main-server.webp', 'image/webp')`).run(at).changes;
        },
        /** A whole copy M signs whose every account entry has no key a server can hold (none, half a surrogate pair). */
        'forge-unreadable-accounts': async () => {
            const { exportSyncState, signSyncPayload } = await import('./state-engine.js');
            const { getPrivateKey } = await import('./p2p.js');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const payload: any = await exportSyncState(peerIdFromPrivateKey(getPrivateKey()).toString());
            delete payload.signature;
            delete payload.publicKey;
            const at = new Date().toISOString();
            payload.accounts = [
                { publicKey: '', balance: 0, lastUpdatedAt: at, lastDemurrageEpoch: 0 },
                { publicKey: 'zz\ud800', balance: 0, lastUpdatedAt: at, lastDemurrageEpoch: 0 },
            ];
            payload.generatedAt = at;
            return signSyncPayload(payload);
        },
        /**
         * A whole copy M signs with its table hashes, as its route sends one (routes/backup.ts), but with one member's contact
         * not what M holds: the ledger M's, so a held force-resync lands it, and the check after it finds the members differ.
         */
        'forge-content': async (a: { publicKey: string; value: string }) => {
            const { exportSyncState, signSyncPayload } = await import('./state-engine.js');
            const { tableContentHashes } = await import('./engine/replica-hashes.js');
            const { getPrivateKey } = await import('./p2p.js');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const hashes: any = tableContentHashes();
            const payload: any = await exportSyncState(peerIdFromPrivateKey(getPrivateKey()).toString());
            const omitted: string[] = payload.photosOmitted ?? [];
            if (omitted.length > 0) hashes.tables.post_photos = (tableContentHashes as any)({ only: ['post_photos'], photosLeftOut: new Set(omitted) }).tables.post_photos;
            delete payload.signature;
            delete payload.publicKey;
            payload.tableHashes = hashes;
            payload.members = payload.members.map((x: any) => (x.publicKey === a.publicKey ? { ...x, contactValue: a.value } : x));
            payload.generatedAt = new Date().toISOString();
            return signSyncPayload(payload);
        },
        /** M's own whole copy as its route sends one it was written to while making (routes/backup.ts): signed, no table hashes. */
        'copy-without-hashes': async () => {
            const { exportSyncState } = await import('./state-engine.js');
            const { getPrivateKey } = await import('./p2p.js');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            return exportSyncState(peerIdFromPrivateKey(getPrivateKey()).toString());
        },
        /** The main server's watch (services/standby-health.ts), or null on a server without one. */
        health: async () => {
            const m = await optional(() => import('./services/standby-health.js'));
            return m ? { state: m.readStandbyHealthForTests(), banner: m.getStandbyHealthBanner() } : null;
        },
        /** Move the watch's clock (by `offsetMs`, or to `atMs`), then run its check as its timer does. */
        'health-check': async (a: { offsetMs?: number; atMs?: number }) => {
            const m = await optional(() => import('./services/standby-health.js'));
            if (!m) return null;
            if (typeof a.offsetMs === 'number') m.setStandbyHealthClockForTests(a.offsetMs);
            if (typeof a.atMs === 'number') m.setStandbyHealthClockForTests(a.atMs - Date.now());
            m.checkStandbyHealth();
            return m.readStandbyHealthForTests();
        },
        'health-clock': async (a: { offsetMs: number }) => {
            const m = await optional(() => import('./services/standby-health.js'));
            if (m) m.setStandbyHealthClockForTests(a.offsetMs);
            return !!m;
        },
        /** The admin queue as each role gets it (engine/admin-queue.ts). */
        queue: async () => {
            const { getAdminQueue } = await import('./engine/admin-queue.js');
            const q = getAdminQueue as (opts?: { forModerator?: boolean; forOwner?: boolean }) => { total: number; items: { kind: string; count: number; section: string; settingsPath: string; label: string }[] };
            return { owner: q({ forOwner: true }), admin: q({}), moderator: q({ forModerator: true }) };
        },
        fetches: async () => fetches,
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
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

/**
 * The main server as its standby reaches it: every request passed to its real backup routes, with its headers, except that
 * a step can have the next copy the standby asks for answered with a payload M signed.
 */
interface MainServerDoor {
    url: string;
    next: (answer: { status: number; body?: unknown }) => void;
    waiting: () => number;
    /** The main server restarted on another port. */
    retarget: (to: string) => void;
    close: () => Promise<void>;
}
async function mainServerDoor(initialTarget: string): Promise<MainServerDoor> {
    let target = initialTarget;
    const queued: { status: number; body?: unknown }[] = [];
    const server = http.createServer((req, res) => {
        void (async () => {
            try {
                const answer = req.url?.startsWith('/api/local/admin/sync-') ? queued.shift() : undefined;
                if (answer) {
                    res.writeHead(answer.status, { 'Content-Type': 'application/json', 'X-Node-Role': 'primary' });
                    res.end(answer.body === undefined ? JSON.stringify({ error: 'refused by this step' }) : JSON.stringify(answer.body));
                    return;
                }
                const chunks: Buffer[] = [];
                for await (const c of req) chunks.push(c as Buffer);
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && (k.startsWith('x-') || k === 'content-type')) headers[k] = v;
                const r = await fetch(target + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
                const out: Record<string, string> = { 'Content-Type': r.headers.get('content-type') ?? 'application/json' };
                const role = r.headers.get('x-node-role');
                if (role) out['X-Node-Role'] = role;
                res.writeHead(r.status, out);
                res.end(Buffer.from(await r.arrayBuffer()));
            } catch (e: any) {
                res.writeHead(502);
                res.end(String(e?.message || e));
            }
        })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        next: (answer) => { queued.push(answer); },
        waiting: () => queued.length,
        retarget: (to) => { target = to; },
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

const brief = (v: unknown) => JSON.stringify(v)?.slice(0, 240);
/** A time as the servers' words give it (services/standby-report.ts timeInWords). */
const inWords = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString().replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, ' UTC') : 'never');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kinds = (q: { items: { kind: string }[] } | undefined) => (q?.items ?? []).map((i) => i.kind);

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const doors: MainServerDoor[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const [gwen, ann, bo, cy] = ['Gwen', 'Ann', 'Bo', 'Cy'].map(newId);
    const OWNER_TOKEN = 'ExponentPushToken[gwen-owner]';

    try {
        // ── 1. A healthy standby ──
        console.log('\n— 1. a healthy standby —');
        let main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, gwen: gwen.pk, ann: ann.pk, bo: bo.pk, cy: cy.pk });
        let m = `https://localhost:${await main.send('serve')}`;
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        const door = await mainServerDoor(main.base);
        doors.push(door);
        await standby.send('setup-standby', { primaryUrl: door.url, replicationToken, primaryPeerId: main.ready.peerId });
        // Every push M handed the push service, across its restarts (each process keeps its own).
        const pushesBefore: { to: string[]; title: string; body: string }[] = [];
        const pushesSoFar = async () => [...pushesBefore, ...(await main.send('fetches')).pushes];
        const pulls: { mode: string; ok: boolean }[] = [];
        const pull = async (whole = false) => {
            const p = await standby.send('pull', { whole });
            pulls.push({ mode: p.mode, ok: p.ok });
            return p;
        };
        const first = await pull();
        const delta = await pull();
        await main.send('touch');
        const whole = await pull(true);
        require_(first.ok && delta.ok && whole.ok && whole.whole, `S copies M: its first copy, a delta and a whole copy land (${brief([first, delta, whole])})`);

        const snap = await fetch(`${main.base}/api/local/admin/sync-snapshot`, { headers: { 'X-Replication-Token': replicationToken } }).then((r) => r.json());
        const hashed = snap?.tableHashes?.tables ?? {};
        assert(snap?.tableHashes?.v === 1 && ['members', 'accounts', 'transactions', 'posts', 'messages'].every((t) => /^[0-9a-f]{64}$/.test(hashed[t]?.hash ?? ''))
            && !('tombstones' in hashed) && typeof snap.signature === 'string',
            `M's whole copy carries its table hashes, signed with the rest, tombstones left out (${brief(Object.keys(hashed))})`);
        let rec = await standby.send('record');
        assert(rec?.lastWhole?.exact === true && rec.lastWhole.hashed === true && rec.lastWhole.differs.length === 0 && rec.lastOutcome === 'ok',
            `S's whole-copy check found every table's rows and every account equal, hashes compared (${brief(rec?.lastWhole)})`);
        let health = await main.send('health');
        assert(health?.state.standbys.length === 1 && health.state.standbys[0].exact === true && health.state.standbys[0].hashed === true
            && health.state.standbys[0].id === rec?.id, `M keeps S's report: its last whole copy was exact (${brief(health?.state.standbys)})`);
        assert(health?.state.incident === null, 'no incident');
        let queue = await main.send('queue');
        assert(!kinds(queue.owner).includes('standby'), `nothing in the owner's admin queue (${brief(kinds(queue.owner))})`);
        let pushes = await pushesSoFar();
        assert(pushes.length === 0, `no push (${pushes.length})`);
        let words = await standby.send('preview-words', {});
        assert(words?.warning === false && /^Last exact copy of the main server: \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/.test(words.lines[0] ?? '') && words.lines.length === 1,
            `the take-over preview says "${words?.lines?.[0]}", and nothing more`);

        // What each server makes for itself doesn't read as a copy gone wrong: a linked community's listing is cached with
        // no search keywords, and a standby restarted on its own fills them in at its boot, before its main server does.
        const cachedListing = await main.send('cache-peer-listing', {
            peerId: '12D3KooWHealthNeighbourPeer000000000000000000000',
            listing: { id: 'nb-1', type: 'offer', category: 'food', title: 'Neighbour jam', description: 'From next door', credits: 2,
                priceType: 'fixed', authorPublicKey: newId('Nia').pk, authorCallsign: 'Nia', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        });
        require_(cachedListing?.cached === 1, `M caches a linked community's listing (${brief(cachedListing)})`);
        require_((await pull()).ok, 'S copies it');
        await standby.send('checkpoint');
        await standby.kill();
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await main.send('touch');
        const afterRestart = await pull(true);
        rec = await standby.send('record');
        assert(afterRestart.ok && afterRestart.whole && rec?.lastWhole?.exact === true,
            `S restarts on its own; its next whole copy is still exact (${afterRestart.mode}; ${brief(rec?.lastWhole)})`);

        // A whole copy whose every account entry has no key a server can hold carries no ledger, as the importer reads it
        // (#1268): nothing a force-resync would mend, since it would read the same entries (review 4118340781).
        const exactBefore = rec;
        door.next({ status: 200, body: await main.send('forge-unreadable-accounts') });
        const unreadable = await pull(true);
        const afterUnreadable = await pull();
        rec = await standby.send('record');
        assert(unreadable.ok && unreadable.whole && afterUnreadable.ok && afterUnreadable.mode === 'delta',
            `a whole copy M signs whose accounts S can't hold lands, and asks for no force-resync: the next pull is a delta (${brief([unreadable.mode, unreadable.error, afterUnreadable.mode])})`);
        assert(rec?.lastUncompared?.notCompared?.includes('ledger') === true && rec.lastWhole?.exact === true
            && rec.lastWhole.at === exactBefore?.lastWhole?.at && rec.lastExactAt === exactBefore?.lastExactAt,
            `it gives no verdict: recorded as a ledger not compared, the last exact copy unchanged (${brief({ uncompared: rec?.lastUncompared, exactAt: rec?.lastExactAt })})`);
        health = await main.send('health');
        words = await standby.send('preview-words', {});
        assert(health?.state.incident === null && words?.warning === false
            && words.lines[0] === `Last exact copy of the main server: ${inWords(exactBefore?.lastExactAt)}.`
            && words.lines.some((l: string) => /could not be compared with it in full: .*its ledger could not be compared account by account\.$/.test(l)),
            `no incident, and the preview names the last exact copy and says the later one could not be compared in full: ${brief(words?.lines)}`);

        // A listing photo M can't read from its own storage: M's copies leave its row out and name it (photosOmitted), and S,
        // new since, never had it. No copy can bring it, so it is said as such, never as a copy gone wrong that asks for a
        // force-resync every six hours (review 4118340860).
        require_(await main.send('photo-main-cannot-read', { author: gwen.pk }) === 1, 'M holds a listing whose photo its own storage has lost');
        const withLostPhoto = await pull(true);
        const afterLostPhoto = await pull();
        rec = await standby.send('record');
        assert(withLostPhoto.ok && withLostPhoto.whole && rec?.lastWhole?.exact === true && rec.lastWhole.hashed === true
            && rec.lastWhole.photosLeftOut === 1 && rec.lastWhole.differs.length === 0 && rec.lastUncompared === null,
            `S's whole copy is exact, the photo M can't read left out of both sides' hashes and named (${brief(rec?.lastWhole)})`);
        assert(afterLostPhoto.ok && afterLostPhoto.mode === 'delta', `no force-resync: the next pull is a delta (${afterLostPhoto.mode})`);
        words = await standby.send('preview-words', {});
        health = await main.send('health');
        assert(health?.state.incident === null && words?.warning === false && /^Last exact copy of the main server: /.test(words.lines[0] ?? '')
            && words.lines.includes('The main server could not read 1 listing photo from its own storage, so it was left out of that check: no copy can bring it here.'),
            `no incident, and the preview says so in plain words: ${brief(words?.lines)}`);

        // ── 2. Stopped for an hour ──
        console.log('\n— 2. the standby stops for an hour —');
        health = await main.send('health-check', { offsetMs: HOUR + 60_000 });
        const incident1 = health?.incident;
        assert(incident1 && incident1.problems.length === 1 && incident1.problems[0].kind === 'stopped',
            `an hour on M's clock with no copy: one incident, "stopped" (${brief(incident1?.problems)})`);
        pushes = await pushesSoFar();
        assert(pushes.length === 1 && JSON.stringify(pushes[0].to) === JSON.stringify([OWNER_TOKEN]) && /standby/i.test(pushes[0].title),
            `one push, to the owner's phone only: not the admin's, the moderator's or a member's (${brief(pushes)})`);
        queue = await main.send('queue');
        const item = queue.owner.items.find((i: any) => i.kind === 'standby');
        assert(item?.count === 1 && item.section === 'home' && item.settingsPath === '/settings#section=home',
            `the owner's admin queue has it, opening Settings' home (${brief(item)})`);
        assert(!kinds(queue.admin).includes('standby') && !kinds(queue.moderator).includes('standby'),
            `an admin's and a moderator's queue don't (${brief([kinds(queue.admin), kinds(queue.moderator)])})`);
        const qOwner = await api(m, 'GET', '/api/node-admin/queue', { as: gwen });
        const qAdmin = await api(m, 'GET', '/api/node-admin/queue', { as: ann });
        const qMod = await api(m, 'GET', '/api/node-admin/queue', { as: bo });
        assert(qOwner.status === 200 && kinds(qOwner.body).includes('standby') && qAdmin.status === 200 && !kinds(qAdmin.body).includes('standby')
            && qMod.status === 200 && !kinds(qMod.body).includes('standby'),
            `the app's queue route, signed by each: the owner sees it, the admin and the moderator don't (${brief([kinds(qOwner.body), kinds(qAdmin.body), kinds(qMod.body)])})`);
        const diag = await api(m, 'POST', '/api/local/admin/diagnostics', { admin: PW_MAIN });
        const banner = diag.body?.standbyHealth;
        assert(banner?.incident?.lines?.length === 1 && /has not made a copy of this server since/.test(banner.incident.lines[0]) && banner.incident.pushed === true
            && banner.incident.whatToDo.some((w: string) => /running and can reach this one/.test(w)),
            `Settings (the owner, by the node password) shows the banner: "${banner?.incident?.lines?.[0]}"`);
        health = await main.send('health-check', {});
        pushes = await pushesSoFar();
        assert(health?.incident?.id === incident1?.id && pushes.length === 1, `a second check: the same incident, no second push (${pushes.length})`);

        // M restarts with the incident open. In a main server's first hour up a standby isn't found to have stopped (it
        // may only have been unable to reach it); one already found stays found: a restart is no all-clear.
        const quietSince: number = health?.standbys?.[0]?.lastCopyAt ?? Date.now();
        pushesBefore.push(...(await main.send('fetches')).pushes);
        await sleep(2000);
        await main.send('checkpoint');
        await main.kill();
        main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        m = `https://localhost:${await main.send('serve')}`;
        door.retarget(main.base);
        const checkAt = quietSince + HOUR + 500;
        const restarted = await main.send('health-check', { atMs: checkAt });
        pushes = await pushesSoFar();
        assert(restarted && restarted.bootAt > quietSince + 1500 && checkAt - restarted.bootAt < HOUR
            && restarted.incident?.id === incident1?.id && restarted.incident.problems.some((p: any) => p.kind === 'stopped') && pushes.length === 1,
            `M restarts: in its first hour up it keeps the open incident, and pushes nothing again (${brief(restarted?.incident?.problems)}; pushes ${pushes.length})`);
        const back = await pull();
        health = await main.send('health');
        queue = await main.send('queue');
        assert(back.ok && health?.state.incident === null && health.state.lastIncident?.id === incident1?.id && !kinds(queue.owner).includes('standby'),
            `S pulls again: the incident is over, and gone from the queue (${brief(health?.state.lastIncident)})`);
        const diag2 = await api(m, 'POST', '/api/local/admin/diagnostics', { admin: PW_MAIN });
        assert(diag2.body?.standbyHealth?.incident === null && diag2.body.standbyHealth.standbys.length === 1 && diag2.body.standbyHealth.standbys[0].healthy === true,
            'and from the banner');

        // ── 3. Three refused copies in a row ──
        console.log('\n— 3. three copies in a row refused —');
        await main.send('health-clock', { offsetMs: 3 * HOUR });
        assert((await pull()).ok, 'hours later, S pulls: healthy');
        for (let i = 0; i < 3; i++) door.next({ status: 200, body: await main.send('forge-mint', { publicKey: cy.pk }) });
        const refused = [await pull(), await pull(), await pull()];
        assert(refused.every((p) => !p.ok && /conservation/i.test(p.error ?? '')), `three copies M signed that make Beans: each refused by the ledger check (${brief(refused.map((p) => p.error?.slice(0, 60)))})`);
        rec = await standby.send('record');
        assert(rec?.failedImportsInARow === 3 && rec.lastOutcome === 'refused' && rec.lastWhy === 'conservation',
            `S's record: 3 refused in a row, by the ledger check (${brief(rec && { fails: rec.failedImportsInARow, last: rec.lastOutcome, why: rec.lastWhy })})`);
        words = await standby.send('preview-words', {});
        assert(words?.warning === true && words.lines.some((l: string) => l === "Its last 3 copies were refused: the copy would have changed the ledger's total, so the ledger check refused it.")
            && words.lines.at(-1)?.startsWith('The take-over goes ahead all the same'),
            `the preview says so: ${brief(words?.lines)}`);
        health = await main.send('health');
        assert(health?.state.incident === null, 'M has not heard yet (those answers never reached it)');
        const told = await pull();
        health = await main.send('health');
        pushes = await pushesSoFar();
        const incident2 = health?.state.incident;
        assert(told.ok && incident2?.problems.some((p: any) => p.kind === 'refused' && p.count === 3 && p.why === 'conservation'),
            `S's next pull reports it: an incident, "refused" (${brief(incident2?.problems)})`);
        assert(pushes.length === 2 && JSON.stringify(pushes[1].to) === JSON.stringify([OWNER_TOKEN]), `one push for it, to the owner only (${brief(pushes.map((p: any) => p.to))})`);
        await pull();
        health = await main.send('health');
        assert(health?.state.incident === null && health.state.lastIncident?.id === incident2?.id, 'the pull after reports it landed: the incident is over');

        // ── 4. A whole copy that isn't the main server's ──
        console.log('\n— 4. a whole copy that is not the main server\'s —');
        await main.send('health-clock', { offsetMs: 6 * HOUR });
        assert((await pull()).ok, 'hours later, S pulls: healthy');
        // One the standby mends by itself is told to nobody (Marty's answer 2: the standby re-seeds itself when it can).
        assert(await standby.send('plant', { publicKey: cy.pk, value: 'planted on the standby' }) === 1, "a change planted on S alone: Cy's contact, the ledger untouched");
        await main.send('touch');
        const inexact = await pull(true);
        rec = await standby.send('record');
        assert(inexact.ok && inexact.whole && rec?.lastWhole?.exact === false && JSON.stringify(rec.lastWhole.differs) === JSON.stringify(['members'])
            && rec.lastWhole.hashed === true && rec.lastWhole.ledgerDiffering === 0 && rec.lastWhole.resyncAsked === true,
            `S's whole copy lands but isn't M's: the members table's content differs, and only it; it asks for its held force-resync (${brief(rec?.lastWhole)})`);
        door.next({ status: 200, body: await main.send('forge-mint', { publicKey: cy.pk }) });
        const heldResync = await pull();
        assert(heldResync.mode === 'resync' && !heldResync.ok && /conservation/i.test(heldResync.error ?? ''),
            `the next pull is the force-resync it asked for, held to the ledger (not a seed): a copy that makes Beans is refused (${heldResync.mode}: ${heldResync.error?.slice(0, 90)})`);
        const mended = await pull();
        rec = await standby.send('record');
        assert(mended.ok && rec?.lastWhole?.exact === true, `M's real copy after it lands, and is exact (${mended.mode}; ${brief(rec?.lastWhole)})`);
        health = await main.send('health');
        const mending = health?.state.standbys.find((x: any) => x.id === rec?.id);
        assert(mending?.exact === false && mending.healing === true && health?.state.incident === null,
            `that pull reported the copy that didn't match as one S is mending by itself: M opens no incident (${brief(mending && { exact: mending.exact, healing: mending.healing })})`);
        await pull();
        health = await main.send('health');
        pushes = await pushesSoFar();
        assert(health?.state.incident === null && health.state.lastIncident?.id === incident2?.id && pushes.length === 2,
            `a copy that heals itself pushes nobody: no incident at any point, and no push (${brief({ incident: health?.state.incident, pushes: pushes.length })})`);

        // The review's case (4119011899): S restarts between asking for its held resync and taking it, as an update restarts
        // both servers, and M's snapshot route answers S's first pull after that with a 503 (its signing identity not ready
        // yet). That resync is still the next pull, and the one after the unanswered one: the copy heals by itself, and
        // nobody is told. Once a copy came for it, it is taken: another restart asks for it no more.
        await standby.send('checkpoint');
        await standby.kill();
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(await standby.send('resync-slot', { agoMs: 6 * HOUR + 60_000 }) === true, "S's last force-resync, in its record, is more than six hours ago");
        assert(await standby.send('plant', { publicKey: cy.pk, value: 'planted before a restart' }) === 1, 'planted again');
        await main.send('touch');
        const askedBeforeRestart = await pull(true);
        rec = await standby.send('record');
        require_(askedBeforeRestart.ok && rec?.lastWhole?.exact === false && rec.lastWhole.resyncAsked === true,
            `S's whole copy differs, and asks for its held force-resync (${brief(rec?.lastWhole)})`);
        await standby.send('checkpoint');
        await standby.kill();
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        door.next({ status: 503, body: { error: 'Snapshot unavailable: node signing identity not ready' } });
        const unanswered = await pull();
        const takenAfterRestart = await pull();
        rec = await standby.send('record');
        assert(unanswered.mode === 'resync' && !unanswered.ok && /503/.test(unanswered.error ?? ''),
            `S restarts before taking it: its first pull is that held force-resync, and M answers 503 (${unanswered.mode}: ${unanswered.error})`);
        assert(takenAfterRestart.mode === 'resync' && takenAfterRestart.ok && rec?.lastWhole?.exact === true,
            `the pull after is that force-resync again, and the copy it lands is exact (${takenAfterRestart.mode}; ${brief(rec?.lastWhole)})`);
        await pull();
        health = await main.send('health');
        pushes = await pushesSoFar();
        assert(health?.state.incident === null && health.state.lastIncident?.id === incident2?.id && pushes.length === 2,
            `the copy healed by itself across the restart: no incident, no push (${brief({ incident: health?.state.incident, pushes: pushes.length })})`);
        await standby.send('checkpoint');
        await standby.kill();
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        const afterTaken = await pull();
        assert(afterTaken.ok && afterTaken.mode !== 'resync', `a resync taken is taken: S restarts again, and its next pull is a ${afterTaken.mode}, not another`);

        // One the held resync doesn't cure. Six hours on (S restarted, its record's last force-resync moved back past the
        // limit), a difference again; the resync it asks for is served a copy M signed whose members aren't M's (its ledger
        // M's), so the check after it still differs. That is when the owners are told.
        await standby.send('checkpoint');
        await standby.kill();
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(await standby.send('resync-slot', { agoMs: 6 * HOUR + 60_000 }) === true, "S's last force-resync, in its record, is more than six hours ago");
        assert(await standby.send('plant', { publicKey: cy.pk, value: 'planted again' }) === 1, 'planted again');
        await main.send('touch');
        const again = await pull(true);
        rec = await standby.send('record');
        assert(again.ok && rec?.lastWhole?.exact === false && rec.lastWhole.resyncAsked === true, `recorded, and it asks for its held force-resync (${brief(rec?.lastWhole)})`);
        door.next({ status: 200, body: await main.send('forge-content', { publicKey: cy.pk, value: 'not what M holds' }) });
        const uncured = await pull();
        rec = await standby.send('record');
        assert(uncured.mode === 'resync' && uncured.ok && rec?.lastWhole?.exact === false && JSON.stringify(rec.lastWhole.differs) === JSON.stringify(['members'])
            && rec.lastWhole.resyncAsked === false,
            `that force-resync lands a copy M signed whose members aren't M's: the check after it still differs, and asks for no second one inside the limit (${uncured.mode}; ${brief(rec?.lastWhole)})`);
        const toldUncured = await pull();
        health = await main.send('health');
        pushes = await pushesSoFar();
        const incident3 = health?.state.incident;
        assert(toldUncured.ok && toldUncured.mode !== 'resync' && incident3?.problems.some((p: any) => p.kind === 'inexact' && JSON.stringify(p.differs) === JSON.stringify(['members'])),
            `the pull after (a ${toldUncured.mode}) reports it: the held resync did not cure it, and M opens an incident, "inexact", members (${brief(incident3?.problems)})`);
        assert(pushes.length === 3 && JSON.stringify(pushes[2].to) === JSON.stringify([OWNER_TOKEN]), `one push for it, to the owner only (${pushes.length})`);

        // A restart allows no sooner force-resync: S's record keeps when it last asked for one, so a difference a resync
        // doesn't mend never loops.
        await standby.send('checkpoint');
        await standby.kill();
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await main.send('touch');
        const afterRestart4 = await pull(true);
        const next4 = await pull();
        rec = await standby.send('record');
        assert(afterRestart4.ok && afterRestart4.whole && rec?.lastWhole?.exact === false && rec.lastWhole.resyncAsked === false && next4.ok && next4.mode !== 'resync',
            `S restarts: its next whole copy still differs, and asks for no force-resync (the pull after is a ${next4.mode}; ${brief(rec?.lastWhole)})`);
        assert(pulls.filter((p) => p.mode === 'resync').length === 5,
            `force-resyncs in all: the new standby's first copy, and one for each of the three copies that didn't match, six hours apart, one of them tried twice (M answered its first with a 503) (${pulls.map((p) => p.mode).join(',')})`);
        health = await main.send('health');
        pushes = await pushesSoFar();
        assert(health?.state.incident?.id === incident3?.id && pushes.length === 3, `the incident stays open, and nothing is pushed again (${pushes.length})`);
        const bannerNow = (await api(m, 'POST', '/api/local/admin/diagnostics', { admin: PW_MAIN })).body?.standbyHealth;
        assert(bannerNow?.incident?.lines.some((l: string) => /did not match it: members differed\. Last exact copy: \d{4}-/.test(l))
            && bannerNow.incident.whatToDo.some((w: string) => /copies this server afresh by itself, at most every six hours, and its copy still did not match/.test(w)),
            `the banner says what didn't match: ${brief(bannerNow?.incident?.lines)}`);
        words = await standby.send('preview-words', {});
        assert(words?.warning === true && words.lines.some((l: string) => /^This server's last whole copy of the main server, at .* UTC, did not match it: members differed\.$/.test(l))
            && words.lines.some((l: string) => /^Last exact copy of the main server: \d{4}-.* UTC\.$/.test(l)),
            `the preview says what didn't match and when the last exact copy was: ${brief(words?.lines)}`);
        const stale = await standby.send('preview-words', { offsetMs: 2 * HOUR });
        assert(stale?.lines.some((l: string) => /^Its last copy of the main server was at .* UTC: anything that changed there after that is not here\.$/.test(l)),
            `two hours on, it says its last copy is old: ${brief(stale?.lines)}`);

        // The review's case (4118340714): a whole copy M sends without its table hashes, as its route does when it was
        // written to while making it. S's copy is still wrong (a whole copy doesn't rewrite a row whose stamp hasn't moved,
        // so the planted contact stays), and a check that can't see a table's content is no all-clear.
        const openBefore = (await main.send('health'))?.state.incident;
        const recBefore = await standby.send('record');
        door.next({ status: 200, body: await main.send('copy-without-hashes') });
        const unhashed = await pull(true);
        rec = await standby.send('record');
        assert(unhashed.ok && unhashed.whole && rec?.lastUncompared?.notCompared?.includes('content') === true
            && rec.lastWhole?.at === recBefore?.lastWhole?.at && rec.lastWhole?.exact === false && rec.lastExactAt === recBefore?.lastExactAt,
            `a whole copy without M's hashes lands and is recorded as not compared in full: the last verdict (members differed) and the last exact copy's time stay (${brief({ uncompared: rec?.lastUncompared, exact: rec?.lastWhole?.exact, exactAt: rec?.lastExactAt })})`);
        await pull();
        health = await main.send('health');
        assert(openBefore && health?.state.incident?.id === openBefore.id && health.state.incident.problems.some((p: any) => p.kind === 'inexact'),
            `S's next report is no all-clear: M's "inexact" incident stays open (${brief(health?.state.incident?.problems)})`);
        words = await standby.send('preview-words', {});
        assert(words?.warning === true
            && words.lines.some((l: string) => /^This server's last whole copy of the main server that could be compared with it, at .* UTC, did not match it: members differed\.$/.test(l))
            && words.lines.some((l: string) => l === `Last exact copy of the main server: ${inWords(recBefore?.lastExactAt)}.`)
            && words.lines.some((l: string) => /^Its last whole copy of the main server, at .* UTC, could not be compared with it in full: the main server was changing while it made that copy/.test(l)),
            `the preview still warns, names the older exact copy, and says the last whole copy could not be compared in full: ${brief(words?.lines)}`);

        // ── 5. The report can't be forged into anything ──
        console.log('\n— 5. a report that is not one —');
        const standbysNow = async () => ((await main.send('health'))?.state.standbys ?? []).map((s: any) => s.id).sort();
        const known = await standbysNow();
        const good = (id: string) => JSON.stringify({ v: 1, id, last: 'ok', why: null, fails: 0, okAgo: 1000, wholeAgo: 1000, exact: true, exactAgo: 1000, differs: [], hashed: true, healing: false });
        const newIdHex = () => crypto.randomBytes(16).toString('hex');
        const deltaWith = (headers: Record<string, string>) => fetch(`${main.base}/api/local/admin/sync-delta`, { headers: { 'X-Since-Cursor': new Date().toISOString(), ...headers } });
        const forged: [string, Record<string, string>][] = [
            ['too long', { 'X-Replication-Token': replicationToken, 'X-Standby-Report': good(newIdHex()).replace('}', `,"pad":"${'x'.repeat(2100)}"}`) }],
            ['not JSON', { 'X-Replication-Token': replicationToken, 'X-Standby-Report': '{"v":1,"id":' }],
            ['an id that is not one', { 'X-Replication-Token': replicationToken, 'X-Standby-Report': good('__proto__') }],
            ['a count out of range', { 'X-Replication-Token': replicationToken, 'X-Standby-Report': good(newIdHex()).replace('"fails":0', '"fails":-1') }],
            ['a table that is not copied', { 'X-Replication-Token': replicationToken, 'X-Standby-Report': good(newIdHex()).replace('"differs":[]', '"differs":["sqlite_master"]') }],
            ['free text for a reason', { 'X-Replication-Token': replicationToken, 'X-Standby-Report': good(newIdHex()).replace('"why":null', '"why":"call +61 555 0100"') }],
            ['a "mending" that is not a yes or no', { 'X-Replication-Token': replicationToken, 'X-Standby-Report': good(newIdHex()).replace('"healing":false', '"healing":"yes"') }],
            ['the admin password, not the token', { 'X-Admin-Password': PW_MAIN, 'X-Standby-Report': good(newIdHex()) }],
        ];
        // A main server takes the admin password for a pull only with token-only off (its default is on): off, so that
        // pull is served and only its report is left unheard.
        const tokenOnlyOff = await post(main.base, '/api/local/admin/replication-token/mode', { tokenOnly: false }, { 'X-Admin-Password': PW_MAIN });
        require_(tokenOnlyOff.status === 200 && tokenOnlyOff.body?.tokenOnly === false, `M takes the admin password for pulls, for this step (${brief(tokenOnlyOff.body)})`);
        const statuses: string[] = [];
        for (const [what, headers] of forged) {
            const r = await deltaWith(headers);
            statuses.push(`${what} ${r.status}${r.ok ? '' : ` ${(await r.text()).slice(0, 80)}`}`);
        }
        const wrongToken = await deltaWith({ 'X-Replication-Token': 'f'.repeat(64), 'X-Standby-Report': good(newIdHex()) });
        assert(statuses.every((s) => s.endsWith(' 200')) && wrongToken.status === 401,
            `each pull is answered as ever: a report never fails one (${statuses.join('; ')}; a wrong token ${wrongToken.status})`);
        assert(JSON.stringify(await standbysNow()) === JSON.stringify(known), `and none of those reports is kept: no new standby, the one there unchanged (${brief(await standbysNow())})`);
        const second = newIdHex();
        const kept = await deltaWith({ 'X-Replication-Token': replicationToken, 'X-Standby-Report': good(second) });
        assert(kept.status === 200 && (await standbysNow()).includes(second), 'a well-formed report with the token, from a second standby, is kept');
        const forgot = await api(m, 'POST', '/api/local/admin/standby-health/forget', { admin: PW_MAIN, body: { id: second } });
        const forgotAgain = await api(m, 'POST', '/api/local/admin/standby-health/forget', { admin: PW_MAIN, body: { id: second } });
        assert(forgot.status === 200 && !(await standbysNow()).includes(second) && forgotAgain.status === 404,
            `the owner stops watching it from Settings (${forgot.status}; again ${forgotAgain.status})`);

        // ── 6. A take-over from a copy that didn't match ──
        console.log('\n— 6. the main server dies; a take-over from the copy that did not match —');
        rec = await standby.send('record');
        require_(rec?.lastWhole?.exact === false, 'S\'s last whole copy is the one that did not match');
        await standby.send('checkpoint');
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
        const pv = opened.body?.preview;
        assert(opened.status === 200 && pv?.copy?.warning === true
            && pv.copy.lines.some((l: string) => /did not match it: members differed/.test(l))
            && pv.copy.lines.some((l: string) => /^Last exact copy of the main server: /.test(l))
            && pv.copy.lines.at(-1)?.startsWith('The take-over goes ahead all the same'),
            `the preview says, in plain words, what didn't match and when the last exact copy was (${brief(pv?.copy?.lines)})`);
        assert(typeof pv?.mainServer?.lastCopyAt === 'number' && pv.mainServer.lastCopyAt === rec?.lastOkAt,
            `and when S last copied M (${pv?.mainServer?.lastCopyAt})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: pv?.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        assert(confirmed.status === 200, `the confirm goes ahead: never blocked by the copy (${confirmed.status} ${brief(confirmed.body)})`);
        if (confirmed.status === 200) {
            const exit = await standby.exited;
            standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
            nodes.push(standby);
            assert(exit === 0 && standby.ready.role === 'primary' && standby.ready.peerId === main.ready.peerId,
                `S restarted as the main server, with M's identity (${standby.ready.role})`);
        }

        // ── 7. The old main server comes back as a standby ──
        console.log('\n— 7. the old main server comes back as a standby —');
        const demoted = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'backup'));
        nodes.push(demoted);
        const d = `https://localhost:${await demoted.send('serve')}`;
        const heldThere = await demoted.send('health');
        require_(heldThere?.state.incident, `M still holds the incident it had open as the main server (${brief(heldThere?.state.incident?.problems)})`);
        const demotedQueue = await demoted.send('queue');
        const demotedDiag = await api(d, 'POST', '/api/local/admin/diagnostics', { admin: PW_MAIN });
        const demotedBanner = await api(d, 'POST', '/api/local/admin/standby-health', { admin: PW_MAIN });
        assert(!kinds(demotedQueue.owner).includes('standby') && demotedDiag.status === 200 && demotedDiag.body?.standbyHealth === null
            && demotedBanner.status === 200 && demotedBanner.body?.incident === null && demotedBanner.body.standbys.length === 0,
            `a standby now, it tells its owner of none: nothing in the admin queue, no Settings banner (${brief([kinds(demotedQueue.owner), demotedDiag.body?.standbyHealth, demotedBanner.body])})`);

        const blocked = [...(await Promise.all(nodes.filter((n) => n.proc.exitCode === null && n.proc.signalCode === null).map((n) => n.send('fetches'))))]
            .flatMap((f: any) => f.blocked);
        assert(blocked.length === 0, `nothing reached off this machine (refused: ${blocked.join(', ') || 'none'})`);
    } catch (e: any) {
        console.error(`\n💥 ${e?.message || e}`);
        testsRun++;
    } finally {
        for (const d of doors) await d.close().catch(() => {});
        for (const n of nodes) await n.kill().catch(() => {});
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (testsPassed !== testsRun) {
        console.error(`❌ Test failed: ${testsRun - testsPassed} check(s) failed`);
        process.exit(1);
    }
    console.log('✅ A community\'s owners are told when its standby stops copying or copies wrongly.');
    process.exit(0);
}

if (process.argv.includes('--child')) {
    child().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
