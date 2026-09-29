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
 * 10. A take-over confirmed on S while a whole copy is being built: the copy is stopped and its staging deleted, and the
 *     promoted server holds the copy it had.
 * 11. S's files capped (RLIMIT_FSIZE) during a whole copy: the stager runs out of room, the copy fails, and the live
 *     database was never written by it (its WAL stays small); S unchanged.
 * 12. A node_config key the replication manifest doesn't classify, planted on S: the closing check refuses the copy and
 *     names it; the key gone, the next lands.
 * 13. The routine whole copy's cadence: after a copy of more than one page, daily, not every reconcile interval; after a
 *     copy of one page, every interval, imported over S's rows with no restart; and a whole copy asked with the last one's
 *     time is answered "unchanged" (304) when nothing was written on M since.
 * 14. A copy of more than 300 pages from M's real HTTPS server, whose administrative limiter allows 300 requests a minute
 *     from one address: at S's default pace (BACKUP_PAGE_GAP_MS 250) it never trips it and lands; unpaced it would (429).
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
import { spawnNode, runNodeChild, serveCommands, post, type NodeProc } from './takeover-test-harness.js';
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

// ── The node processes' commands ───────────────────────────────────────────────────────────

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
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; genesis: string }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            seedGenesisMember(a.genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            return true;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        'set-primary-url': async (a: { url: string }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            updateLocalConfig({ backupPrimaryUrl: a.url });
            return true;
        },
        /** This process's environment, live (the puller reads its paces and intervals at each pull); null removes one. */
        'set-env': async (a: { vars: Record<string, string | null> }) => {
            for (const [k, v] of Object.entries(a.vars)) {
                if (v === null) delete process.env[k];
                else process.env[k] = v;
            }
            return true;
        },
        /** One pull of the kind the loop makes next; `whole` asks the routine whole copy. */
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            const was = [process.env.BACKUP_RECONCILE_EVERY_MS, process.env.BACKUP_BIG_COPY_EVERY_MS];
            if (a.whole) {
                process.env.BACKUP_RECONCILE_EVERY_MS = '1';
                process.env.BACKUP_BIG_COPY_EVERY_MS = '1';
            }
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            if (a.whole) {
                for (const [k, v] of [['BACKUP_RECONCILE_EVERY_MS', was[0]], ['BACKUP_BIG_COPY_EVERY_MS', was[1]]] as const) {
                    if (v === undefined) delete process.env[k];
                    else process.env[k] = v;
                }
            }
            const s = getBackupStatus();
            return {
                ok: result.ok, error: result.error ?? null, staged: result.staged === true, mode: s.lastPullMode ?? null,
                landedWhole: s.lastFullReconcileAt !== before, lastWholePages: s.lastWholePages,
            };
        },
        /** The force-resync an operator runs from Settings. */
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
        },
        /** The puller's start as index.ts makes it; its loop stopped at once: the suite pulls by hand. */
        'boot-puller': async () => {
            const { initBackupPuller, stopBackupPuller, getBackupStatus } = await import('./services/backup-puller.js');
            initBackupPuller();
            stopBackupPuller();
            return getBackupStatus().cursor;
        },
        /** Every table in `tables`, counted and hashed row for row; the format record, the cursor and the ledger's total. */
        snapshot: async (a: { tables: string[] }) => {
            const { db } = await import('./db/db.js');
            const tables: Record<string, { count: number; hash: string }> = {};
            for (const t of a.tables) {
                const rows = (db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[])
                    .map(({ last_active_at: _l, ...rest }) => JSON.stringify(rest)).sort();
                tables[t] = { count: rows.length, hash: crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16) };
            }
            const cfg = (k: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
            const cursor = (db.prepare(`SELECT last_synced_at AS c FROM sync_cursors WHERE peer_id = 'backup:primary'`).get() as { c: string } | undefined)?.c ?? null;
            return {
                tables, format: cfg('replica_format'), cursor,
                ledgerSum: (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s,
            };
        },
        /** The copied tables' hashes as the whole-copy check makes them (engine/replica-hashes.ts). */
        hashes: async () => {
            const { tableContentHashes } = await import('./engine/replica-hashes.js');
            return tableContentHashes().tables;
        },
        /** This standby's record of its copies, and the report its next pull sends (services/standby-copy-record.ts). */
        record: async () => {
            const { readCopyRecord, standbyReport } = await import('./services/standby-copy-record.js');
            // The report first: it writes the record, and its id, when there is none yet.
            const report = standbyReport() as any;
            const r = readCopyRecord() as any;
            return {
                id: r.id, lastOutcome: r.lastOutcome, lastWhy: r.lastWhy, fails: r.failedImportsInARow, lastWhole: r.lastWhole,
                lastLeftOut: r.lastLeftOut ?? null, lastWholeCopy: r.lastWholeCopy ?? null,
                report: { why: report.why, leftOut: report.leftOut ?? null, exact: report.exact, differs: report.differs },
            };
        },
        sql: async (a: { sql: string; args?: unknown[] }) => {
            const { db } = await import('./db/db.js');
            return db.prepare(a.sql).run(...(a.args ?? [])).changes;
        },
        rows: async (a: { sql: string; args?: unknown[] }) => {
            const { db } = await import('./db/db.js');
            return db.prepare(a.sql).all(...(a.args ?? []));
        },
        /** `n` rows written in one go behind the routes, each a new key starting `flood-`. */
        flood: async (a: { kind: 'messages' | 'long-messages' | 'posts'; n: number; conversationId?: string; author?: string }) => {
            const { db } = await import('./db/db.js');
            const now = () => new Date().toISOString();
            db.transaction(() => {
                for (let i = 0; i < a.n; i++) {
                    const id = `flood-${crypto.randomUUID()}`;
                    if (a.kind === 'posts') {
                        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at) VALUES (?, 'offer', 'food', ?, 'a flood', 1, ?, ?, ?)`)
                            .run(id, `Flood ${i}`, a.author, now(), now());
                    } else {
                        const words = a.kind === 'messages' ? Buffer.from(`line ${i}`) : crypto.randomBytes(1500);
                        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp, updated_at) VALUES (?, ?, ?, ?, ?, 'text', ?, ?)`)
                            .run(id, a.conversationId, a.author, words.toString('base64'), crypto.randomBytes(24).toString('base64'), now(), now());
                    }
                }
            })();
            return true;
        },
        /** The flood's rows gone from this server, as a delete that writes no tombstone. */
        unflood: async () => {
            const { db } = await import('./db/db.js');
            return db.prepare(`DELETE FROM messages WHERE id LIKE 'flood-%'`).run().changes + db.prepare(`DELETE FROM posts WHERE id LIKE 'flood-%'`).run().changes;
        },
        /** A friendship ended on this server, with its tombstone, as the route ends one. */
        unfriend: async (a: { owner: string; friend: string }) => {
            const { removeFriend } = await import('./state-engine.js');
            return removeFriend(a.owner, a.friend);
        },
        rekey: async (a: { oldPk: string; newPk: string; operator: string }) => {
            const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
            const { code } = issueRekeyCode(a.oldPk, a.operator);
            return completeRekey(a.oldPk, a.newPk, code, a.operator).success;
        },
        /** A whole copy being built here: its stager's PID; and what the data directory holds of copies. */
        staging: async () => {
            const stager: { copyStaging?: () => { pid: number | null } | null } | null = await import('./services/stager.js').catch(() => null);
            const dir = process.env.BEANPOOL_DATA_DIR!;
            const staging = path.join(dir, 'staging');
            return {
                building: stager?.copyStaging?.() ?? null, staging: fs.existsSync(staging), ready: fs.existsSync(path.join(staging, 'READY')),
                previous: fs.existsSync(path.join(dir, 'state.previous.db')),
                pages: fs.existsSync(path.join(staging, 'pages')) ? fs.readdirSync(path.join(staging, 'pages')).length : 0,
            };
        },
        /** This standby's own things, which no copy brings: they must come through a swap. */
        own: async () => {
            const { db } = await import('./db/db.js');
            const cfg = (k: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
            return {
                marker: (db.prepare(`SELECT COUNT(*) AS n FROM system_logs WHERE message LIKE '%paged-copies-marker%'`).get() as { n: number }).n,
                otherCursor: (db.prepare(`SELECT last_synced_at AS c FROM sync_cursors WHERE peer_id = 'test:elsewhere'`).get() as { c: string } | undefined)?.c ?? null,
                roles: db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all(),
                avatarKey: cfg('avatarKeySecret'),
                standbyHealthNote: cfg('appAddressStaffSeen'),
            };
        },
        'plant-own': async (a: { owner: string }) => {
            const { db } = await import('./db/db.js');
            const { logger } = await import('./logger.js');
            logger.info('SYS', 'paged-copies-marker: a line this standby logged itself');
            db.prepare(`INSERT OR REPLACE INTO sync_cursors (peer_id, last_synced_at, last_sync_attempt_at) VALUES ('test:elsewhere', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z')`).run();
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('appAddressStaffSeen', '{"seen":"by this standby"}')`).run();
            // A role of this standby's own (the take-over bundle brings the main server's; this one is the standby's).
            db.prepare(`INSERT OR REPLACE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'test')`).run(a.owner);
            return true;
        },
        /** The database's files, in bytes. */
        files: async () => {
            const dir = process.env.BEANPOOL_DATA_DIR!;
            const size = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.statSync(path.join(dir, f)).size : 0);
            return { db: size('state.db'), wal: size('state.db-wal') };
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        /** M's recovery code and take-over envelope (services/takeover-envelope.ts). */
        'make-envelope': async () => {
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const made = await makeRecoveryCode();
            const st = await flushTakeoverChecks();
            return { code: made.code, envelopeId: st.envelopeId };
        },
        envelope: async () => {
            const { pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            return pullTakeoverEnvelopeNow();
        },
        'takeover-restart-off': async () => {
            const t = await import('./services/takeover.js');
            t.setTakeoverRestartForTests(() => { /* the suite starts the next one */ });
            return true;
        },
        role: async () => {
            const { getNodeRole } = await import('./state-engine.js');
            return getNodeRole();
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
        try { await fn(); } catch (e: any) { assert(false, `${title}: ${e?.message || e}`); }
    };

    try {
        // ── M, and S set up against it through the proxy ──
        let main = await spawnNode(SCRIPT, dir('main'), envM);
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        let m = `https://localhost:${await main.send('serve')}`;
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
        /** Kill S and start it again on its data dir, as a crash and Docker would. */
        const restartS = async (opts: { maxFileBytes?: number } = {}) => {
            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, dir('standby'), envS, opts);
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
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '0' } });
            built('Bo offers eggs on M after its restart', await As(bo, '/api/marketplace/posts', {
                type: 'offer', category: 'food', title: 'Eggs', description: 'Eggs', credits: 2, priceType: 'fixed', authorPublicKey: bo.pk,
            }));
            const d4 = await standby.send('pull', {});
            assert(d4.ok === true && d4.mode === 'delta', `within the interval, the next pull is a delta, and it lands (${JSON.stringify(d4)})`);
            await sleep(4100);
            const w4 = await pullAndSwap(false);
            const r4w = await standby.send('record');
            // M's own pricing guide worker, started again with it, may move its rows after the copy's snapshot: a delta
            // brings them.
            await standby.send('pull', {});
            const diff4 = await exactNow();
            assert(w4.ok === true && w4.mode === 'full' && w4.staged === true && r4w.lastWhole?.exact === true && diff4.length === 0,
                `after the interval the whole copy is asked again, lands exact, and S is M's (${JSON.stringify({ pull: w4, whole: r4w.lastWhole })}; differences after a delta ${first(diff4)})`);
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
        });

        // The standby took over: a new one for the rest, set up from nothing.
        const newStandby = async (name: string, opts: { maxFileBytes?: number } = {}) => {
            fs.mkdirSync(dir(name), { recursive: true });
            fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir(name), 'genesis.json'));
            standby = await spawnNode(SCRIPT, dir(name), envS, opts);
            nodes.push(standby);
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

        await step('14. a copy of more than 300 pages from M\'s real HTTPS server never trips its limiter at S\'s pace', async () => {
            await main.send('flood', { kind: 'messages', n: 63_000, conversationId, author: ann.pk });
            await standby.send('set-primary-url', { url: m });
            // Unpaced first, in a fresh minute of M's limiter: it trips.
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '0' } });
            const fast = await standby.send('pull', { whole: true });
            assert(fast.ok === false && /HTTP 429/.test(fast.error ?? ''), `unpaced, a copy this size trips M's limit of 300 administrative requests a minute (${JSON.stringify(fast)})`);
            await sleep(61_000);
            await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: null } });
            const t0 = Date.now();
            const p14 = await wholeCopy();
            const secs = (Date.now() - t0) / 1000;
            const s14 = await snapS();
            const m14 = await snapM();
            assert(p14.ok === true && p14.staged === true && s14.tables.messages.count === m14.tables.messages.count,
                `at S's own pace the same copy, ${m14.tables.messages.count} chat lines in more than 300 pages, lands in ${secs.toFixed(0)} s with no 429 (${JSON.stringify(p14)})`);
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

if (process.argv.includes('--child')) {
    child().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
