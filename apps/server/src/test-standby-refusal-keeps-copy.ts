/**
 * Test Suite: a refused copy never leaves a standby with less, and one table never blocks the rest (N and D of
 * scratch/global-node/DESIGN-replica-flood-bounds-opus.md, §4.4), as they stand since paged copies (P2 of
 * scratch/global-node/DESIGN-paged-copies-fable.md): a whole copy is built in pages in a staging database and swapped in
 * at a restart (services/stager.ts), a delta comes in pages imported as one payload, and nothing refuses or leaves out a
 * copy for its size. The steps that checked the row cap's rule (a table over it left out, or a copy refused over one the
 * ledger needs whole) now check that the same floods land whole: the intended change P retires the cap for, not a
 * weakened test. Each refusal is now made by what still refuses a copy: a node_config key the replication manifest
 * doesn't classify (the stager refuses a whole copy over it; no delta reads it), the conservation guard, a disk cap, a
 * trigger on a row a delta writes.
 *
 * A main server M and a standby S, each its own process with its own data dir (takeover-test-harness.ts), M serving its
 * real HTTPS server (members act through it with signed requests) and S pulling through its real puller (`pullNow`, the
 * loop's own step; `requestResync`, the operator's) from M's real backup routes. S's old row cap is scaled to 150
 * (MAX_IMPORT_ROWS_PER_CATEGORY), as a flood past the real 250,000 would be; the flood's rows are written on M behind the
 * routes, to stay fast. A standby that makes a whole copy ready restarts, and the harness starts it again as Docker does.
 * Nothing leaves this machine.
 *
 *  1. M: members, listings, a DM, a completed trade (Beans in the ledger), an unused invite. S's first copy (the format
 *     re-seed a new standby takes) lands, exact.
 *  2. Chat messages and invites past the old cap: S's delta carries them whole, with a member M made after the flood; a
 *     whole copy lands exact, nothing left out; M's owners are told of nothing; an operator's force-resync lands. The flood
 *     gone from M with no tombstone, the next whole copy finds S holding it and asks for the held force-resync, which lands
 *     exact. (Before P2: the two tables left out, reported, and kept stale.)
 *  3. Keepers' wages owed (a table of the ledger set) past the old cap: the delta lands with them. Members past it in whole
 *     copies only (stamped long ago): the whole copy lands, exact. (Before P2: refused over them.)
 *  4. Members past the old cap by delta: it lands. Five pulls inside one reconcile interval ask M for one whole copy.
 *  5. The force-resync a copy that didn't match asks for (a balance planted on S; S restarted, its puller resuming from the
 *     cursor it saved), refused: S's ledger as it was (the plant included), and nothing held (no `replica_held_sum`).
 *  6. An operator's force-resync, refused: S holds every member, listing, account and balance it had, its format record
 *     and its cursor. A new standby with no copy, refused the same way, waits instead of asking again at once.
 *  7. The format re-seed (S restarted with the format before this one), refused: S keeps everything and its old format
 *     record, the next pull is a delta, and the re-seed is asked for again once the retry time passes, not before.
 *  8. The key gone: the format re-seed lands, exact, the format recorded, S's ledger M's.
 *  9. Deletions past the old cap: S's delta carries them, the message M deleted is gone, and no force-resync is asked.
 *     (Before P2: left out, and one force-resync to mend them.)
 * 10. A copy that fails fails whole, and S is exactly as it was, on disk too: S's files capped (RLIMIT_FSIZE) during an
 *     operator's force-resync, so the copy's staging database runs out of room; a trigger's RAISE(ROLLBACK) on a single row
 *     a delta's block lists write. A trigger planted on S's live tables is nothing to a copy built beside them: that
 *     force-resync lands. (Before P2: the clear ran on the live tables, and a trigger on it refused the copy.)
 * 11. A standby with a cursor and no format record (every standby that copied before the record), its re-seed refused:
 *     its deltas still land, and are held to its ledger. M's +7 Beans planted on one account is refused (before: taken as
 *     a seed, and S's total went from 0 to 7). The plant and the key gone, the re-seed lands, exact.
 * 12. Listings past the old cap: twelve pulls ask M for no whole copy (they come by delta, and the canary finds nothing).
 *     The routine whole copy lands whole and holds nothing back: drift the canary finds after it (a listing gone from S)
 *     is mended by a whole copy at the next pull. (Before P2: listings left out, the canary off, and drift held back.)
 * 13. Listings flooded per delta, then a restart whose routine whole copy (due by the cadence S's record keeps) carries
 *     them all, exact; a group membership gone from S with no tombstone is drift the canary finds, and one whole copy
 *     brings it back.
 * 14. Listings flooded, and a trade on M, just before a whole copy: the copy carries them and moves S's cursor to its own,
 *     and the trade is on S once after the next delta too. A record an older version wrote (no lastLacking, lastLeftOut
 *     naming listings) reads them as lacking until the next whole copy, which leaves nothing out, clears both.
 * 15. The flood running on and a membership gone from S: the canary finds it at the first delta, the next pull's whole
 *     copy brings it back, and no listing of M's is ever missing from S; S's ledger is M's.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-refusal-keeps-copy.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';
import { lockedDm } from './dm-test-payload.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Refusal-Keeps-Main-Pw-4471!';
const PW_STANDBY = 'Refusal-Keeps-Standby-Pw-9082!';
/** S's row cap, scaled down from 250,000 as test-dos-caps scales it. */
const CAP = 150;
const FLOOD = 160;
/** The wait after a refused force-resync or first copy (BACKUP_RESYNC_RETRY_MS), scaled down from an hour. */
const RETRY_MS = 3000;
/** The tables hashed on S, row for row, to show a refused copy changed nothing. */
const HASHED = [
    'members', 'member_preferences', 'accounts', 'transactions', 'marketplace_transactions', 'posts', 'post_photos', 'projects',
    'conversations', 'conversation_participants', 'messages', 'invite_codes', 'deferred_wage_claims', 'treasury_operators',
    'enterprise_pledges', 'invalidated_keys', 'groups', 'group_members', 'ratings', 'friends', 'tombstones', 'member_blocks',
];
/** Long chat messages S holds of its own for step 10, and the cap on its files then: its clear needs more room than that. */
const LONG_MESSAGES = 12_000;
const CAPPED_BYTES = 4 * 1024 * 1024;

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
        /** An environment setting the puller reads live (the whole copy's size gate, BACKUP_RECONCILE_MAX_BYTES). */
        'set-env': async (a: { name: string; value: string | null }) => {
            if (a.value === null) delete process.env[a.name];
            else process.env[a.name] = a.value;
            return true;
        },
        /** The routine whole copy's interval, live (services/backup-puller.ts reads it at every pull). */
        'set-reconcile-ms': async (a: { ms: number }) => { process.env.BACKUP_RECONCILE_EVERY_MS = String(a.ms); return true; },
        /** One pull of the kind the loop makes next; `whole` asks the routine whole copy. */
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            const was = process.env.BACKUP_RECONCILE_EVERY_MS;
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = was;
            const s = getBackupStatus() as any;
            return { ok: result.ok, error: result.error ?? null, mode: s.lastPullMode ?? null, landedWhole: s.lastFullReconcileAt !== before, staged: (result as any).staged === true };
        },
        /**
         * The puller's start as index.ts makes it (initBackupPuller): it resumes from the cursor this database saved. Its
         * loop is stopped at once: the suite pulls by hand.
         */
        'boot-puller': async () => {
            const { initBackupPuller, stopBackupPuller, getBackupStatus } = await import('./services/backup-puller.js');
            initBackupPuller();
            stopBackupPuller();
            return getBackupStatus().cursor;
        },
        /** The force-resync an operator runs from Settings. */
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
        },
        /** Every table in HASHED, counted and hashed row for row; the triggers; the format record, the cursor and the held total. */
        snapshot: async (a: { tables: string[] }) => {
            const { db } = await import('./db/db.js');
            const { getBackupStatus } = await import('./services/backup-puller.js');
            const tables: Record<string, { count: number; hash: string }> = {};
            for (const t of a.tables) {
                const rows = (db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[])
                    .map(({ last_active_at: _l, ...rest }) => JSON.stringify(rest)).sort();
                tables[t] = { count: rows.length, hash: crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16) };
            }
            const cfg = (k: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
            const cursor = (db.prepare(`SELECT last_synced_at AS c FROM sync_cursors WHERE peer_id = 'backup:primary'`).get() as { c: string } | undefined)?.c ?? null;
            const triggers = (db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).all() as { name: string; sql: string }[]);
            return {
                tables, format: cfg('replica_format'), held: cfg('replica_held_sum'), savedCursor: cursor,
                triggers: { count: triggers.length, hash: crypto.createHash('sha256').update(JSON.stringify(triggers)).digest('hex').slice(0, 16) },
                cursor: (getBackupStatus() as any).cursor ?? null,
                ledgerSum: (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s,
            };
        },
        /** This standby's record of its copies, and the report its next pull sends (services/standby-copy-record.ts). */
        record: async () => {
            const { readCopyRecord, standbyReport } = await import('./services/standby-copy-record.js');
            const r = readCopyRecord() as any;
            const report = standbyReport() as any;
            return {
                lastOutcome: r.lastOutcome, lastWhy: r.lastWhy, fails: r.failedImportsInARow, lastWhole: r.lastWhole,
                lastLeftOut: r.lastLeftOut ?? null, lastLacking: r.lastLacking ?? null, lastOversized: r.lastOversized ?? null, lastMismatchResyncAt: r.lastMismatchResyncAt,
                report: { why: report.why, leftOut: report.leftOut ?? null, oversized: report.oversized ?? null, exact: report.exact, differs: report.differs },
            };
        },
        /** SQL on this server, as a flood's rows or a bug would write them. */
        sql: async (a: { sql: string; args?: unknown[] }) => {
            const { db } = await import('./db/db.js');
            return db.prepare(a.sql).run(...(a.args ?? [])).changes;
        },
        /** `n` rows of a table, written in one go behind the routes, each a new key starting `flood-`. */
        flood: async (a: { kind: 'messages' | 'long-messages' | 'invites' | 'members' | 'wages' | 'tombstones' | 'posts'; n: number; conversationId?: string; author?: string; old?: boolean }) => {
            const { db } = await import('./db/db.js');
            // `old`: stamped long ago, so no delta carries the rows and only a whole copy does (as years of real growth).
            const now = () => (a.old ? '2000-01-01T00:00:00.000Z' : new Date().toISOString());
            db.transaction(() => {
                for (let i = 0; i < a.n; i++) {
                    const id = `flood-${crypto.randomUUID()}`;
                    if (a.kind === 'messages' || a.kind === 'long-messages') {
                        const words = a.kind === 'messages' ? Buffer.from(`line ${i}`) : crypto.randomBytes(1500);
                        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp, updated_at) VALUES (?, ?, ?, ?, ?, 'text', ?, ?)`)
                            .run(id, a.conversationId, a.author, words.toString('base64'), crypto.randomBytes(24).toString('base64'), now(), now());
                    } else if (a.kind === 'posts') {
                        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at) VALUES (?, 'offer', 'food', ?, 'a flood', 1, ?, ?, ?)`)
                            .run(id, `Flood ${i}`, a.author, now(), now());
                    } else if (a.kind === 'invites') {
                        db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, a.author, now(), now());
                    } else if (a.kind === 'members') {
                        // A visitor's row, as a member's DM to a fresh key makes one (engine/members.ts registerVisitor).
                        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_visitor, updated_at) VALUES (?, ?, ?, 'active', 1, ?)`)
                            .run(id, `v-${id.slice(6, 22)}`, now(), now());
                    } else if (a.kind === 'wages') {
                        db.prepare(`INSERT INTO deferred_wage_claims (id, enterprise_pubkey, keeper_pubkey, amount, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'pending', ?, ?)`)
                            .run(id, a.author, a.author, now(), now());
                    } else {
                        db.prepare(`INSERT INTO tombstones (table_name, row_key, deleted_at) VALUES ('messages', ?, ?)`).run(id, now());
                    }
                }
            })();
            return true;
        },
        /** The flood's rows, gone from this server (as the maintainers would bring a table down). */
        unflood: async () => {
            const { db } = await import('./db/db.js');
            let n = 0;
            for (const [t, k] of [['messages', 'id'], ['invite_codes', 'code'], ['members', 'public_key'], ['deferred_wage_claims', 'id'], ['tombstones', 'row_key'], ['posts', 'id']]) {
                n += db.prepare(`DELETE FROM ${t} WHERE ${k} LIKE 'flood-%'`).run().changes;
            }
            return n;
        },
        /** A message deleted on this server, with its tombstone, as the event scrub deletes one (db/db.ts writeTombstone). */
        'delete-message': async (a: { id: string }) => {
            const { db, writeTombstone } = await import('./db/db.js');
            db.prepare('DELETE FROM messages WHERE id = ?').run(a.id);
            writeTombstone('messages', a.id);
            return true;
        },
        /**
         * Every pull this main server records from now on, kept here uncapped. The access log it writes
         * (state-engine.ts recordReplicationAccess) keeps its last 20 pulls, and a flood's pulls come faster on a
         * fast machine: a whole copy served before 20 more pulls fell off it, and read as never served. A temp trigger
         * on this process's own connection copies each new entry as the log's row is written: the same entries the log
         * holds, none lost. Temp: in no table of the database, so in no copy M serves.
         */
        'watch-pulls': async () => {
            const { db } = await import('./db/db.js');
            db.exec(`CREATE TEMP TABLE IF NOT EXISTS pulls_seen (at INTEGER NOT NULL, auth TEXT, reason TEXT)`);
            db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS pulls_seen_log AFTER INSERT ON main.node_config WHEN NEW.key = 'replication_access'
                BEGIN INSERT INTO pulls_seen (at, auth, reason) VALUES (json_extract(NEW.value, '$.recent[0].at'),
                    json_extract(NEW.value, '$.recent[0].auth'), json_extract(NEW.value, '$.recent[0].reason')); END`);
            return true;
        },
        /** The whole copies this main server opened (routes/backup.ts sync-copy, logged as 'whole copy in pages'), since `since`, as 'watch-pulls' saw them. */
        'whole-copies': async (a: { since: number }) => {
            const { db } = await import('./db/db.js');
            return (db.prepare(`SELECT COUNT(*) AS n FROM temp.pulls_seen WHERE at >= ? AND auth <> 'rejected' AND reason = 'whole copy in pages'`).get(a.since) as { n: number }).n;
        },
        /** The whole-copy check on M's current whole copy, fetched with the replication token and not imported. */
        'check-copy': async () => {
            const { getLocalConfig } = await import('./config/local-config.js');
            const { checkWholeCopy } = await import('./services/backup-puller.js');
            const c = getLocalConfig();
            const res = await fetch(`${c.backupPrimaryUrl}/api/local/admin/sync-snapshot`, { headers: { 'X-Replication-Token': c.backupReplicationToken! } });
            const consistency = checkWholeCopy(await res.json());
            return { ok: consistency.ok, differing: consistency.ledger?.differing ?? null };
        },
        /** What the owners are shown about their standbys (the Settings banner, services/standby-health.ts). */
        health: async () => {
            const { getStandbyHealthBanner } = await import('./services/standby-health.js');
            return getStandbyHealthBanner();
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        /** The database's write-ahead log, in bytes (design §4.3: a force-resync writes every row twice into it). */
        'wal-bytes': async () => {
            const file = path.join(process.env.BEANPOOL_DATA_DIR!, 'state.db-wal');
            return { wal: fs.existsSync(file) ? fs.statSync(file).size : 0, db: fs.statSync(path.join(process.env.BEANPOOL_DATA_DIR!, 'state.db')).size };
        },
        fetches: async () => fetches,
        /** A table's primary keys (`key`), counted and hashed: which rows it holds, whatever a boot restamped in them. */
        keys: async (a: { table: string; key: string }) => {
            const { db } = await import('./db/db.js');
            const ks = db.prepare(`SELECT ${a.key} AS k FROM ${a.table} ORDER BY ${a.key}`).pluck().all() as string[];
            return { count: ks.length, distinct: new Set(ks).size, hash: crypto.createHash('sha256').update(ks.join('\n')).digest('hex').slice(0, 16) };
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
const brief = (a: Answer) => `${a.status} ${JSON.stringify(a.body)?.slice(0, 160)}`;
function built(what: string, a: Answer): any {
    require_(a.status >= 200 && a.status < 300, `M: ${what} (${brief(a)})`);
    return a.body;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

type Snap = {
    tables: Record<string, { count: number; hash: string }>; triggers: { count: number; hash: string }; format: string | null; held: string | null;
    savedCursor: string | null; cursor: string | null; ledgerSum: number;
};
/** Where two snapshots of S differ: each table's rows, the triggers, the format record, the cursors, the held total. */
function snapDiff(a: Snap, b: Snap): string[] {
    const out: string[] = [];
    for (const [t, x] of Object.entries(a.tables)) {
        const y = b.tables[t];
        if (!y || x.hash !== y.hash) out.push(`${t} ${x.count}→${y?.count ?? 'none'}`);
    }
    if (a.triggers.hash !== b.triggers.hash) out.push(`triggers ${a.triggers.count}→${b.triggers.count}`);
    if (a.format !== b.format) out.push(`format ${a.format}→${b.format}`);
    if (a.savedCursor !== b.savedCursor) out.push(`saved cursor ${a.savedCursor}→${b.savedCursor}`);
    if (a.cursor !== b.cursor) out.push(`cursor ${a.cursor}→${b.cursor}`);
    if (a.held !== b.held) out.push(`held ${a.held}→${b.held}`);
    return out;
}
const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 6).join(' | ')}`);
const counts = (s: Snap, ...ts: string[]) => ts.map((t) => `${t} ${s.tables[t]?.count}`).join(', ');

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
    const env = (pw: string, role: string) => ({
        ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000',
        ...(role === 'backup' ? { MAX_IMPORT_ROWS_PER_CATEGORY: String(CAP), BACKUP_RESYNC_RETRY_MS: String(RETRY_MS) } : {}),
    });
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee, eve] = ['Ann', 'Bo', 'Cy', 'Dee', 'Eve'].map(newId);
    const refused: string[] = [];

    try {
        // ── 1. M, and S's first copy ──
        console.log('\n— 1. the main server, and a new standby\'s first copy —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        await main.send('watch-pulls');
        const m = `https://localhost:${await main.send('serve')}`;
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
        await offer(gwen, 'Sourdough', 4); // a buyer lists an offer first (the offer covenant)
        await offer(cy, 'Bike repair', 6);
        const honey = await offer(ann, 'Honey', 20);
        const tx = built('Gwen asks for the honey', await As(gwen, '/api/marketplace/posts/request', { postId: honey.id, buyerPublicKey: gwen.pk })).transaction;
        built('Ann approves: the Beans are held', await As(ann, '/api/marketplace/transactions/approve', { transactionId: tx.id, authorPublicKey: ann.pk }));
        built('Gwen confirms: the Beans are released', await As(gwen, '/api/marketplace/transactions/complete', { transactionId: tx.id, confirmerPublicKey: gwen.pk }));
        built('Gwen makes an invite nobody has used yet', await As(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
        // A group, and a listing aimed at it alone: a group's delete cancels the listings aimed at it (db/schema.sql
        // posts_cleanup_on_group_delete), which a force-resync's clear must never do (step 10).
        const group = built('Ann starts a group', await As(ann, '/api/groups', { name: 'Beekeepers' }));
        const groupId: string = group.id ?? group.group?.id;
        require_(typeof groupId === 'string', `M: the group has an id (${JSON.stringify(group)?.slice(0, 120)})`);
        built('Ann lists a swarm for the group alone', await As(ann, '/api/marketplace/posts', {
            type: 'offer', category: 'food', title: 'Swarm', description: 'A swarm, for the group', credits: 3, priceType: 'fixed',
            authorPublicKey: ann.pk, audienceScope: 'group', targetGroupId: groupId,
        }));
        const conv = built('Ann opens a DM with Bo', await As(ann, '/api/messages/conversation', { type: 'dm', participants: [ann.pk, bo.pk], createdBy: ann.pk }));
        const conversationId: string = conv.conversation?.id ?? conv.id;
        const sent: string[] = [];
        for (const line of ['Hi Bo', 'Honey is ready', 'See you Saturday']) {
            const r = built(`Ann tells Bo "${line}"`, await As(ann, '/api/messages/send', { conversationId, authorPubkey: ann.pk, ...lockedDm() }));
            sent.push(r.message?.id ?? r.id);
        }
        require_(sent.every((id) => typeof id === 'string'), `M: the DM's lines have ids (${JSON.stringify(sent)})`);

        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const first1 = await standby.send('pull', {});
        require_(first1.ok === true && first1.mode === 'resync', `S's first pull is the format re-seed, and it lands (${JSON.stringify(first1)})`);
        const r1 = await standby.send('record');
        const m1: Snap = await main.send('snapshot', { tables: HASHED });
        const s1: Snap = await standby.send('snapshot', { tables: HASHED });
        require_(r1.lastWhole?.exact === true && s1.tables.messages.count === m1.tables.messages.count && s1.tables.messages.count >= 3 && s1.tables.transactions.count > 0 && s1.format !== null,
            `S's copy is M's, exact: ${counts(s1, 'members', 'posts', 'accounts', 'transactions', 'messages', 'invite_codes')} (M: ${counts(m1, 'members', 'posts', 'accounts', 'transactions', 'messages', 'invite_codes')}; verdict ${JSON.stringify(r1.lastWhole?.differs)})`);

        /**
         * A pull that makes a whole copy ready restarts S (the harness starts it again): this waits for the new start, and
         * starts its puller as index.ts does, so it resumes from the copy swapped in.
         */
        const pullAndSwap = async (args: Record<string, unknown> = {}, cmd: 'pull' | 'resync' = 'pull') => {
            const before = standby.swaps();
            const p = await standby.send(cmd, args);
            if (p?.staged || p?.restarting) {
                const end = Date.now() + 30_000;
                while (standby.swaps() === before && Date.now() < end) await sleep(50);
                await standby.send('boot-puller');
            }
            return p;
        };
        // A key no replication manifest entry classifies, planted on S: the stager refuses every whole copy over it (it can't
        // tell whether S keeps it of its own), and no delta reads it. Before P2 a flood of members past the row cap refused
        // these copies; nothing refuses a copy for its size now, so this is what makes one refused.
        const UNCLASSIFIED = 'refusal_test_unclassified';
        const plantUnclassified = (on: NodeProc) => on.send('sql', { sql: `INSERT OR REPLACE INTO node_config (key, value) VALUES ('${UNCLASSIFIED}', 'x')` });
        const unplantUnclassified = (on: NodeProc) => on.send('sql', { sql: `DELETE FROM node_config WHERE key = '${UNCLASSIFIED}'` });

        // ── 2. Chat messages and invites past the old row cap: carried whole ──
        console.log('\n— 2. chat messages and invites past the old row cap: every copy carries them whole —');
        await main.send('flood', { kind: 'messages', n: FLOOD, conversationId, author: ann.pk });
        await main.send('flood', { kind: 'invites', n: FLOOD, author: gwen.pk });
        await join(eve); // a member made after the flood
        const delta2 = await standby.send('pull', {});
        let s2: Snap = await standby.send('snapshot', { tables: HASHED });
        let m2: Snap = await main.send('snapshot', { tables: HASHED });
        const r2 = await standby.send('record');
        assert(delta2.ok === true && delta2.mode === 'delta' && s2.tables.members.count === s1.tables.members.count + 1
            && s2.tables.messages.hash === m2.tables.messages.hash && s2.tables.invite_codes.hash === m2.tables.invite_codes.hash
            && r2.lastLeftOut === null && Array.isArray(r2.report.leftOut) && r2.report.leftOut.length === 0,
            `S's delta lands whole: Eve, who joined after the flood, and every line and invite of it (${JSON.stringify(delta2)}; ${counts(s2, 'members', 'messages', 'invite_codes')}; before: the two tables left out)`);
        const whole2 = await standby.send('pull', { whole: true });
        const r2w = await standby.send('record');
        assert(whole2.ok === true && whole2.mode === 'full' && whole2.landedWhole === true && r2w.lastWhole?.exact === true && r2w.lastLeftOut === null,
            `S's whole copy lands, exact, nothing left out (${JSON.stringify({ pull: whole2, whole: r2w.lastWhole })}; before: not exact, the two tables named)`);
        const banner2 = await main.send('health');
        assert(!/leave out/.test((banner2.incident?.lines ?? []).join(' ')),
            `M's owners are told of no table left out (${JSON.stringify(banner2.incident?.lines ?? null)})`);
        const resync2 = await pullAndSwap({}, 'resync');
        s2 = await standby.send('snapshot', { tables: HASHED });
        m2 = await main.send('snapshot', { tables: HASHED });
        assert(resync2.ok === true && resync2.restarting === true && s2.tables.members.hash === m2.tables.members.hash && s2.tables.posts.hash === m2.tables.posts.hash
            && s2.tables.accounts.hash === m2.tables.accounts.hash && s2.tables.transactions.hash === m2.tables.transactions.hash && s2.tables.messages.hash === m2.tables.messages.hash,
            `an operator's force-resync lands, built in a staging database and swapped in at a restart: S's members, listings, ledger and messages are M's (${JSON.stringify(resync2)}; ${counts(s2, 'members', 'posts', 'accounts', 'messages')}; before: refused, and S left with 0 members)`);
        // The flood gone from M with no tombstone: S still holds it, so the next whole copy doesn't match, and the held
        // force-resync it asks for, built from nothing, mends it.
        const gone2 = await main.send('unflood');
        const clean2 = await standby.send('pull', { whole: true });
        const r2c = await standby.send('record');
        const mend2 = await pullAndSwap({});
        const r2m = await standby.send('record');
        s2 = await standby.send('snapshot', { tables: HASHED });
        m2 = await main.send('snapshot', { tables: HASHED });
        assert(gone2 === 2 * FLOOD && clean2.ok === true && r2c.lastWhole?.exact === false && r2c.lastWhole?.resyncAsked === true
            && mend2.ok === true && mend2.mode === 'resync' && r2m.lastWhole?.exact === true && s2.tables.messages.hash === m2.tables.messages.hash,
            `the flood gone from M with no tombstone, the next whole copy finds S holding it and asks for the held force-resync, which lands exact (${JSON.stringify({ gone: gone2, whole: r2c.lastWhole, mend: mend2, after: r2m.lastWhole })})`);

        // ── 3. A table of the ledger set past the old row cap: carried whole ──
        console.log('\n— 3. keepers\' wages owed, and members stamped long ago, past the old row cap: carried whole —');
        await main.send('flood', { kind: 'wages', n: FLOOD, author: gwen.pk });
        const delta3 = await standby.send('pull', {});
        let s3: Snap = await standby.send('snapshot', { tables: HASHED });
        let m3: Snap = await main.send('snapshot', { tables: HASHED });
        const r3 = await standby.send('record');
        assert(delta3.ok === true && delta3.mode === 'delta' && s3.tables.deferred_wage_claims.hash === m3.tables.deferred_wage_claims.hash && r3.lastOversized === null,
            `S's delta lands with every wage owed (${JSON.stringify(delta3)}; ${counts(s3, 'deferred_wage_claims')}; before: refused, naming the table)`);
        // Members past the old cap in whole copies only (stamped long ago, as years of growth): no delta carries them, and a
        // whole copy does.
        await main.send('flood', { kind: 'members', n: FLOOD, old: true });
        const whole3 = await standby.send('pull', { whole: true });
        s3 = await standby.send('snapshot', { tables: HASHED });
        m3 = await main.send('snapshot', { tables: HASHED });
        const r3b = await standby.send('record');
        assert(whole3.ok === true && whole3.mode === 'full' && s3.tables.members.count === m3.tables.members.count && r3b.lastOversized === null
            && r3b.lastWhole?.exact === true && JSON.stringify(r3b.report.oversized) === '[]',
            `the whole copy lands with all ${m3.tables.members.count} members, exact, and S reports nothing over any cap (${JSON.stringify({ pull: whole3, whole: r3b.lastWhole })}; before: refused over members, deltas only)`);
        const banner3 = await main.send('health');
        assert(!/more rows of/.test((banner3.incident?.lines ?? []).join(' ')), `M's owners are told of no table refused (${JSON.stringify(banner3.incident?.lines ?? null)})`);

        // ── 4. Members past the old cap, by delta; the routine whole copy's cadence ──
        console.log('\n— 4. members past the old cap: the delta lands, and five pulls in one interval ask M for one whole copy —');
        await main.send('flood', { kind: 'members', n: FLOOD });
        const delta4 = await standby.send('pull', {});
        const s4: Snap = await standby.send('snapshot', { tables: HASHED });
        const m4: Snap = await main.send('snapshot', { tables: HASHED });
        const r4 = await standby.send('record');
        assert(delta4.ok === true && delta4.mode === 'delta' && s4.tables.members.hash === m4.tables.members.hash && r4.lastWhy === null,
            `S's delta lands with every member (${JSON.stringify(delta4)}; ${counts(s4, 'members')}; before: refused, why 'oversized')`);
        // Five pulls inside one reconcile interval: the first is the routine whole copy, due, and lands; then deltas.
        await standby.send('set-reconcile-ms', { ms: 4000 });
        await sleep(4200);
        const t4 = Date.now();
        const modes4: string[] = [];
        for (let i = 0; i < 5; i++) {
            const p = await standby.send('pull', {});
            modes4.push(`${p.mode}:${p.ok ? 'ok' : 'refused'}`);
            await sleep(400);
        }
        await standby.send('set-reconcile-ms', { ms: 86400000 });
        const served4 = await main.send('whole-copies', { since: t4 });
        assert(served4 === 1 && modes4[0] === 'full:ok' && modes4.slice(1).every((x) => x === 'delta:ok'),
            `five pulls inside one reconcile interval ask M for one whole copy, which lands, then deltas (${served4} served; ${modes4.join(', ')})`);
        const s4a: Snap = await standby.send('snapshot', { tables: HASHED });

        // A standby restarted as index.ts starts one: its puller resumes from the cursor it saved. Its record's last
        // force-resync for a copy that didn't match is put more than six hours back, so each step below may ask one.
        const restart = async (patch: (db: Database.Database) => void = () => {}, opts: { maxFileBytes?: number } = {}) => {
            refused.push(...(await standby.send('fetches')).blocked);
            // A standby whose files are capped may have no room to checkpoint: its log is read back at the next start.
            await standby.send('checkpoint').catch(() => {});
            await standby.kill('SIGTERM');
            withDb(dir('standby'), (db) => {
                patch(db);
                const row = db.prepare("SELECT value FROM node_config WHERE key = 'standby_copy_record'").get() as { value: string } | undefined;
                if (!row) return;
                const r = JSON.parse(row.value);
                r.lastMismatchResyncAt = Date.now() - 7 * 60 * 60_000;
                db.prepare("UPDATE node_config SET value = ? WHERE key = 'standby_copy_record'").run(JSON.stringify(r));
            });
            standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'), opts);
            nodes.push(standby);
            return standby.send('boot-puller');
        };

        // ── 5. The force-resync a copy that didn't match asks for ──
        console.log('\n— 5. the held force-resync (not a seed), refused: S\'s ledger as it was, and nothing held —');
        const resumed5 = await restart();
        assert(resumed5 === s4a.savedCursor && !!resumed5, `S restarts, and its puller resumes from the cursor it saved (${resumed5})`);
        await standby.send('sql', { sql: 'UPDATE accounts SET balance = balance + 4 WHERE public_key = ?', args: [ann.pk] });
        await standby.send('sql', { sql: 'UPDATE accounts SET balance = balance - 4 WHERE public_key = ?', args: [bo.pk] });
        await plantUnclassified(standby);
        const s5a: Snap = await standby.send('snapshot', { tables: HASHED });
        const check5 = await standby.send('check-copy');
        const r5a = await standby.send('record');
        assert(check5.differing === 2 && r5a.lastMismatchResyncAt !== null && Date.now() - r5a.lastMismatchResyncAt < 60_000,
            `a whole copy whose ledger doesn't match S's (4 Beans planted on S) asks for a force-resync (${JSON.stringify({ check5, asked: r5a.lastMismatchResyncAt })})`);
        const held5 = await standby.send('pull', {});
        const s5: Snap = await standby.send('snapshot', { tables: HASHED });
        assert(held5.mode === 'resync' && held5.ok === false && new RegExp(UNCLASSIFIED).test(held5.error ?? ''),
            `that force-resync is refused at the stager's closing check (${JSON.stringify(held5)})`);
        assert(snapDiff(s5a, s5).length === 0 && s5.held === null && s5.tables.members.count > 0 && Math.abs(s5.ledgerSum - s5a.ledgerSum) < 1e-9,
            `S's ledger is as it was, the plant included, its rows and cursor too, and nothing is held (differences ${first(snapDiff(s5a, s5))}; held ${s5.held}; ${counts(s5, 'members', 'accounts')}; before: S cleared, and its next copies held to replica_held_sum)`);

        // ── 6. An operator's force-resync ──
        console.log('\n— 6. an operator\'s force-resync, refused: S keeps everything; a new standby refused waits —');
        const resync6 = await standby.send('resync');
        const s6: Snap = await standby.send('snapshot', { tables: HASHED });
        assert(resync6.ok === false && new RegExp(UNCLASSIFIED).test(resync6.error ?? ''), `an operator's force-resync is refused, naming the key (${JSON.stringify(resync6)})`);
        assert(snapDiff(s5, s6).length === 0 && s6.tables.members.count > 0 && s6.tables.posts.count > 0 && s6.tables.accounts.count > 0 && s6.format !== null && s6.savedCursor === s4a.savedCursor,
            `S holds every member, listing, account and balance it had, its format record and its cursor (differences ${first(snapDiff(s5, s6))}; ${counts(s6, 'members', 'posts', 'accounts')}; format ${s6.format}; before: 0 members, 0 listings, 0 accounts, no format, cursor '')`);
        // A new standby, with no copy yet, refused the same way: it waits, and doesn't ask M for another whole copy at once.
        fs.mkdirSync(dir('fresh'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('fresh'), 'genesis.json'));
        const fresh = await spawnNode(SCRIPT, dir('fresh'), env(PW_STANDBY, 'backup'));
        nodes.push(fresh);
        await fresh.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        await plantUnclassified(fresh);
        const f1 = await fresh.send('pull', {});
        const tf = Date.now();
        const f2 = await fresh.send('pull', {});
        const servedF = await main.send('whole-copies', { since: tf });
        assert(f1.ok === false && f1.mode === 'resync' && f2.ok === false && servedF === 0,
            `a new standby's first copy is refused, and its next pull waits instead of asking M for another (${JSON.stringify({ first: f1, next: f2, served: servedF })}; before: a whole copy every pull)`);
        await sleep(RETRY_MS + 300);
        const tf3 = Date.now();
        const f3 = await fresh.send('pull', {});
        const servedF3 = await main.send('whole-copies', { since: tf3 });
        assert(f3.mode === 'resync' && servedF3 === 1, `after the retry time it asks again (${JSON.stringify({ pull: f3, served: servedF3 })})`);
        refused.push(...(await fresh.send('fetches')).blocked);
        await fresh.kill('SIGTERM');

        // ── 7. The format re-seed ──
        console.log('\n— 7. the format re-seed, refused: S keeps everything, and asks again after the retry time —');
        const olderFormat = String(Number(s6.format) - 1);
        const resumed7 = await restart((db) => { db.prepare("UPDATE node_config SET value = ? WHERE key = 'replica_format'").run(olderFormat); });
        assert(resumed7 === s4a.savedCursor && !!resumed7, `S restarts with the format before this one, and resumes from its cursor (${resumed7})`);
        const s7a: Snap = await standby.send('snapshot', { tables: HASHED });
        const reseed7 = await standby.send('pull', {});
        const s7: Snap = await standby.send('snapshot', { tables: HASHED });
        assert(reseed7.mode === 'resync' && reseed7.ok === false && new RegExp(UNCLASSIFIED).test(reseed7.error ?? ''), `S's first pull is the format re-seed, and it is refused (${JSON.stringify(reseed7)})`);
        assert(snapDiff(s7a, s7).length === 0 && s7.format === olderFormat,
            `S keeps everything, its old format record and its cursor (differences ${first(snapDiff(s7a, s7))}; format ${s7.format}; before: every row cleared, no format, cursor '')`);
        const next7 = await standby.send('pull', {});
        assert(next7.mode === 'delta', `the next pull is a delta from the cursor it kept, not another re-seed (${JSON.stringify(next7)})`);
        await sleep(RETRY_MS + 300);
        const again7 = await standby.send('pull', {});
        assert(again7.mode === 'resync' && again7.ok === false, `after the retry time the re-seed is asked for again (${JSON.stringify(again7)})`);

        // ── 8. The key gone ──
        console.log('\n— 8. the key gone: the re-seed lands, exact —');
        await unplantUnclassified(standby);
        await main.send('unflood');
        await sleep(RETRY_MS + 300);
        const land8 = await pullAndSwap({});
        const s8: Snap = await standby.send('snapshot', { tables: HASHED });
        const m8: Snap = await main.send('snapshot', { tables: HASHED });
        const r8 = await standby.send('record');
        assert(land8.ok === true && land8.mode === 'resync' && r8.lastWhole?.exact === true && Number(s8.format) > Number(olderFormat),
            `the format re-seed lands, exact, and the format is recorded (${JSON.stringify({ pull: land8, verdict: r8.lastWhole, format: s8.format })})`);
        assert(s8.tables.accounts.hash === m8.tables.accounts.hash && s8.tables.members.count === m8.tables.members.count && s8.tables.transactions.hash === m8.tables.transactions.hash,
            `S's ledger and members are M's again, the plant gone (${counts(s8, 'members', 'accounts', 'transactions')}; M ${counts(m8, 'members', 'accounts', 'transactions')})`);

        // ── 9. Deletions past the old cap: carried whole ──
        console.log('\n— 9. deletions past the old row cap: the delta carries them, and no force-resync is asked —');
        await main.send('delete-message', { id: sent[0] });
        await main.send('flood', { kind: 'tombstones', n: FLOOD });
        const r9a = await standby.send('record');
        const delta9 = await standby.send('pull', {});
        const s9: Snap = await standby.send('snapshot', { tables: HASHED });
        const m9: Snap = await main.send('snapshot', { tables: HASHED });
        const r9 = await standby.send('record');
        assert(delta9.ok === true && delta9.mode === 'delta' && s9.tables.messages.count === s1.tables.messages.count - 1 && s9.tables.messages.hash === m9.tables.messages.hash,
            `S's delta carries every deletion: the message M deleted is gone (${JSON.stringify(delta9)}; ${counts(s9, 'messages')}; before: left out, and one force-resync to mend it)`);
        assert(r9.lastMismatchResyncAt === r9a.lastMismatchResyncAt && r9.lastLeftOut === null,
            `and asks for no force-resync (${JSON.stringify({ asked: [r9a.lastMismatchResyncAt, r9.lastMismatchResyncAt], leftOut: r9.lastLeftOut })})`);
        const next9 = await standby.send('pull', {});
        assert(next9.ok === true && next9.mode === 'delta', `the pull after it is a delta (${JSON.stringify(next9)})`);

        // ── 10. A copy that fails fails whole ──
        console.log('\n— 10. a copy that fails: refused whole, and S exactly as it was —');
        // M holds many long chat messages S hasn't copied yet, so a whole copy's staging database needs more room than S's
        // files may take once they are capped, as a disk full or failing stops them; S's own database needs none of it.
        await main.send('flood', { kind: 'long-messages', n: LONG_MESSAGES, conversationId, author: ann.pk });
        const resumed10 = await restart(() => {}, { maxFileBytes: CAPPED_BYTES });
        require_(!!resumed10, `S restarts with its files capped at ${CAPPED_BYTES / 1048576} MB, and resumes from its cursor (${resumed10})`);
        const s10a: Snap = await standby.send('snapshot', { tables: HASHED });
        const disk10 = await standby.send('resync');
        const s10: Snap = await standby.send('snapshot', { tables: HASHED });
        const r10 = await standby.send('record');
        assert(disk10.ok === false && r10.lastOutcome === 'refused' && /disk|I\/O|full|stager|EFBIG|too large/i.test(disk10.error ?? ''),
            `an operator's force-resync that runs out of room in its staging database is refused, as the disk error it is (${JSON.stringify({ pull: disk10, outcome: r10.lastOutcome, why: r10.lastWhy })})`);
        assert(snapDiff(s10a, s10).length === 0 && s10.tables.groups.count > 0 && s10.tables.messages.count === s10a.tables.messages.count,
            `S is exactly as it was: every table row for row, its cursor and its format record (differences ${first(snapDiff(s10a, s10))}; ${counts(s10, 'groups', 'group_members', 'posts', 'messages')}; before: the tables after chat messages cleared, groups among them, and the listing aimed at the group cancelled)`);
        await restart();
        const s10b: Snap = await standby.send('snapshot', { tables: HASHED });
        assert(snapDiff(s10a, s10b).length === 0, `and so it is on disk: restarted without the cap, S still holds all of it (differences ${first(snapDiff(s10a, s10b))})`);
        // A trigger planted on S's live database (a RAISE(ROLLBACK) on any delete of a chat) is nothing to a copy built from
        // nothing in a staging database: the force-resync lands, and S's own long messages, which M never had, are gone.
        await standby.send('sql', { sql: "CREATE TRIGGER planted_refusal BEFORE DELETE ON conversations BEGIN SELECT RAISE(ROLLBACK, 'planted: this delete is refused'); END" });
        const trig10 = await pullAndSwap({}, 'resync');
        const s10d: Snap = await standby.send('snapshot', { tables: HASHED });
        const m10d: Snap = await main.send('snapshot', { tables: HASHED });
        assert(trig10.ok === true && trig10.restarting === true && s10d.tables.messages.hash === m10d.tables.messages.hash,
            `a force-resync with a trigger planted on S's live tables lands: the copy is built beside them (${JSON.stringify(trig10)}; ${counts(s10d, 'messages')}; M ${counts(m10d, 'messages')}; before: refused, the clear rolled back)`);
        // And one on a single row a delta writes, over S's own rows: the delta's block lists, whose merge leaves a row this
        // table refuses out.
        for (const who of [bo, cy, dee]) {
            built(`Ann blocks ${who.name}`, await As(ann, '/api/blocks', { targetPubkey: who.pk }));
            await sleep(5); // each block its own stamp, in this order
        }
        await standby.send('sql', { sql: `CREATE TRIGGER planted_block BEFORE INSERT ON member_blocks WHEN NEW.blocked_pubkey = '${bo.pk}' BEGIN SELECT RAISE(ROLLBACK, 'planted: this row is refused'); END` });
        const s10e: Snap = await standby.send('snapshot', { tables: HASHED });
        const row10 = await standby.send('pull', {});
        const s10f: Snap = await standby.send('snapshot', { tables: HASHED });
        await standby.send('sql', { sql: 'DROP TRIGGER planted_block' });
        assert(row10.ok === false && row10.mode === 'delta' && snapDiff(s10e, s10f).length === 0 && s10f.tables.member_blocks.count === 0,
            `a delta one of whose rows a trigger rolls back is refused whole, and S is exactly as it was (${JSON.stringify(row10)}; differences ${first(snapDiff(s10e, s10f))}; before: the blocks after the refused one landed)`);
        const land10 = await standby.send('pull', {});
        const s10g: Snap = await standby.send('snapshot', { tables: HASHED });
        const m10: Snap = await main.send('snapshot', { tables: HASHED });
        assert(land10.ok === true && land10.mode === 'delta' && s10g.tables.member_blocks.hash === m10.tables.member_blocks.hash
            && s10g.tables.messages.hash === m10.tables.messages.hash && s10g.tables.posts.hash === m10.tables.posts.hash,
            `with nothing in the way, the delta lands: S's block lists, messages and listings are M's (${JSON.stringify(land10)}; ${counts(s10g, 'member_blocks', 'messages', 'posts')}; M ${counts(m10, 'member_blocks', 'messages', 'posts')})`);
        // M's long messages gone (no tombstone): an operator's force-resync makes S M's again, small, for the steps after.
        await main.send('unflood');
        await pullAndSwap({}, 'resync');

        // ── 11. A standby from before the format record ──
        console.log('\n— 11. a cursor and no format record, the re-seed refused: deltas land, held to the ledger —');
        const resumed11 = await restart((db) => {
            db.prepare("DELETE FROM node_config WHERE key = 'replica_format'").run();
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('${UNCLASSIFIED}', 'x')`).run();
        });
        const s11a: Snap = await standby.send('snapshot', { tables: HASHED });
        require_(!!resumed11 && s11a.format === null, `S restarts with a cursor and no format record, as every standby that copied before the record (${JSON.stringify({ cursor: resumed11, format: s11a.format })})`);
        const reseed11 = await standby.send('pull', {});
        const s11b: Snap = await standby.send('snapshot', { tables: HASHED });
        assert(reseed11.mode === 'resync' && reseed11.ok === false && new RegExp(UNCLASSIFIED).test(reseed11.error ?? '') && snapDiff(s11a, s11b).length === 0,
            `its re-seed is refused, and S keeps everything (${JSON.stringify(reseed11)}; differences ${first(snapDiff(s11a, s11b))})`);
        const jam = await offer(gwen, 'Jam', 2);
        const jam11 = await standby.send('pull', {});
        const s11c: Snap = await standby.send('snapshot', { tables: HASHED });
        assert(jam11.ok === true && jam11.mode === 'delta' && s11c.tables.posts.count === s11b.tables.posts.count + 1,
            `its deltas carry on meanwhile: a listing Gwen made reaches S (${JSON.stringify(jam11)}; ${counts(s11c, 'posts')})`);
        await main.send('sql', { sql: 'UPDATE accounts SET balance = balance + 7 WHERE public_key = ?', args: [ann.pk] });
        const mint11 = await standby.send('pull', {});
        const s11d: Snap = await standby.send('snapshot', { tables: HASHED });
        assert(mint11.ok === false && mint11.mode === 'delta' && /conservation/i.test(mint11.error ?? '') && s11d.tables.accounts.hash === s11c.tables.accounts.hash
            && Math.abs(s11d.ledgerSum - s11c.ledgerSum) < 1e-9,
            `7 Beans planted on M's ledger come in a delta, which the ledger check refuses: S's total stays ${s11c.ledgerSum} (${JSON.stringify(mint11)}; total ${s11d.ledgerSum}; before: taken as a seed, unchecked, and S's total went up 7)`);
        await main.send('sql', { sql: 'UPDATE accounts SET balance = balance - 7 WHERE public_key = ?', args: [ann.pk] });
        await unplantUnclassified(standby);
        await sleep(RETRY_MS + 300);
        const land11 = await pullAndSwap({});
        const s11e: Snap = await standby.send('snapshot', { tables: HASHED });
        const m11: Snap = await main.send('snapshot', { tables: HASHED });
        const r11 = await standby.send('record');
        assert(land11.ok === true && land11.mode === 'resync' && r11.lastWhole?.exact === true && s11e.format !== null && s11e.tables.accounts.hash === m11.tables.accounts.hash,
            `the plant and the key gone, the re-seed lands, exact, and the format is recorded (${JSON.stringify({ pull: land11, verdict: r11.lastWhole, format: s11e.format })})`);

        // ── 12. Listings past the old cap: the canary reads them, and a whole copy is never held back ──
        console.log('\n— 12. listings past the old cap: no whole copy asked for while nothing drifts; drift found after a whole copy is mended at once —');
        await main.send('flood', { kind: 'posts', n: FLOOD, author: gwen.pk });
        const t12 = Date.now();
        const modes12: string[] = [];
        for (let i = 0; i < 12; i++) {
            const p = await standby.send('pull', {});
            modes12.push(`${p.mode}:${p.ok ? 'ok' : 'refused'}`);
        }
        const served12 = await main.send('whole-copies', { since: t12 });
        const r12 = await standby.send('record');
        assert(served12 === 0 && modes12.every((x) => x === 'delta:ok') && r12.lastLeftOut === null,
            `twelve pulls with listings past the old cap ask M for no whole copy: they come by delta, and the canary finds nothing (${served12} served; ${modes12.join(', ')}; before: left out, and the canary off)`);
        // Chat messages past the old cap too, and the routine whole copy every 5 s: it lands whole, and holds nothing back. A
        // listing then gone from S with no tombstone is drift the canary sees, and the next pull mends it.
        await main.send('flood', { kind: 'messages', n: FLOOD, conversationId, author: ann.pk });
        const HOLD_MS = 5000;
        await standby.send('set-reconcile-ms', { ms: HOLD_MS });
        await sleep(HOLD_MS + 200);
        const routine12 = await standby.send('pull', {});
        await standby.send('sql', { sql: 'DELETE FROM posts WHERE id = ?', args: [jam.id] });
        const drift12 = await standby.send('pull', {});
        const mend12 = await standby.send('pull', {});
        const s12: Snap = await standby.send('snapshot', { tables: HASHED });
        const m12: Snap = await main.send('snapshot', { tables: HASHED });
        await standby.send('set-reconcile-ms', { ms: 86400000 });
        assert(routine12.ok === true && routine12.mode === 'full' && drift12.ok === true && drift12.mode === 'delta'
            && mend12.ok === true && mend12.mode === 'full' && s12.tables.posts.hash === m12.tables.posts.hash,
            `the routine whole copy lands whole; the drift the next delta's canary finds is mended by a whole copy at the next pull (${JSON.stringify({ routine: [routine12.mode, routine12.ok], then: [drift12.mode, mend12.mode] })}; ${counts(s12, 'posts')}; M ${counts(m12, 'posts')}; before: held back until the next routine time)`);
        await main.send('unflood');
        await pullAndSwap({}, 'resync');

        // ── 13. The canary reads every table, whatever a whole copy carried ──
        console.log('\n— 13. listings flooded per delta, then a restart: the whole copy carries them, and the canary still reads —');
        for (let i = 0; i < 3; i++) {
            await main.send('flood', { kind: 'posts', n: 60, author: gwen.pk });
            const d = await standby.send('pull', {});
            require_(d.ok === true && d.mode === 'delta', `S's delta after 60 more listings on M lands (${JSON.stringify(d)})`);
        }
        const s13a: Snap = await standby.send('snapshot', { tables: HASHED });
        const m13a: Snap = await main.send('snapshot', { tables: HASHED });
        assert(s13a.tables.posts.hash === m13a.tables.posts.hash && s13a.tables.posts.count > CAP,
            `every listing reached S by delta (${counts(s13a, 'posts')}; M ${counts(m13a, 'posts')})`);
        // A restart with the last whole copy an interval old (S's record keeps when it landed): the first pull is the
        // routine whole copy, which carries every listing.
        await restart((db) => {
            const row = db.prepare("SELECT value FROM node_config WHERE key = 'standby_copy_record'").get() as { value: string } | undefined;
            const r = row ? JSON.parse(row.value) : {};
            r.lastWholeCopy = { ...(r.lastWholeCopy ?? { pages: 1, generatedAt: null }), at: Date.now() - 2 * HOLD_MS };
            db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('standby_copy_record', ?)").run(JSON.stringify(r));
        });
        await standby.send('set-reconcile-ms', { ms: HOLD_MS });
        const whole13 = await standby.send('pull', {});
        const r13a = await standby.send('record');
        assert(whole13.ok === true && whole13.mode === 'full' && r13a.lastLeftOut === null && r13a.lastLacking === null && r13a.lastWhole?.exact === true,
            `the restart's routine whole copy lands, exact, carrying every listing (${JSON.stringify({ pull: whole13, leftOut: r13a.lastLeftOut, lacking: r13a.lastLacking, whole: r13a.lastWhole })}; before: listings left out)`);
        const t13 = Date.now();
        require_((await standby.send('sql', { sql: 'DELETE FROM group_members WHERE group_id = ?', args: [groupId] })) > 0,
            'S: the group\'s membership deleted, with no tombstone');
        const drift13 = await standby.send('pull', {});
        const mend13 = await standby.send('pull', {});
        const s13b: Snap = await standby.send('snapshot', { tables: HASHED });
        const m13b: Snap = await main.send('snapshot', { tables: HASHED });
        const served13 = await main.send('whole-copies', { since: t13 });
        assert(drift13.ok === true && drift13.mode === 'delta' && mend13.ok === true && mend13.mode === 'full' && served13 === 1
            && s13b.tables.group_members.hash === m13b.tables.group_members.hash,
            `the next delta's canary finds the drift, and one whole copy brings the membership back (${JSON.stringify({ drift: drift13.mode, mend: mend13.mode, served: served13 })}; ${counts(s13b, 'group_members')}; M ${counts(m13b, 'group_members')})`);
        await main.send('unflood');
        await standby.send('set-reconcile-ms', { ms: 86400000 });
        await pullAndSwap({}, 'resync');

        // ── 14. A record an older version wrote ──
        console.log('\n— 14. listings flooded, a whole copy carrying them and the trade in its window, and a record an older version wrote —');
        for (let i = 0; i < 3; i++) {
            await main.send('flood', { kind: 'posts', n: 60, author: gwen.pk });
            const d = await standby.send('pull', {});
            require_(d.ok === true && d.mode === 'delta', `S's delta after 60 more listings on M lands (${JSON.stringify(d)})`);
        }
        await main.send('flood', { kind: 'posts', n: 20, author: gwen.pk });
        // A trade on M in the same window: the whole copy brings its rows, and the next delta brings them again.
        const jam14 = await offer(ann, 'Plum jam', 3);
        const tx14 = built('Gwen asks for the plum jam', await As(gwen, '/api/marketplace/posts/request', { postId: jam14.id, buyerPublicKey: gwen.pk })).transaction;
        built('Ann approves: the Beans are held', await As(ann, '/api/marketplace/transactions/approve', { transactionId: tx14.id, authorPublicKey: ann.pk }));
        built('Gwen confirms: the Beans are released', await As(gwen, '/api/marketplace/transactions/complete', { transactionId: tx14.id, confirmerPublicKey: gwen.pk }));
        const cursor14: string | null = (await standby.send('snapshot', { tables: [] }) as Snap).savedCursor;
        const whole14 = await standby.send('pull', { whole: true });
        const r14a = await standby.send('record');
        const after14: string | null = (await standby.send('snapshot', { tables: [] }) as Snap).savedCursor;
        assert(whole14.ok === true && whole14.mode === 'full' && r14a.lastLeftOut === null && r14a.lastLacking === null && after14 !== cursor14,
            `the whole copy lands with every listing, and moves S's cursor to its own (${JSON.stringify({ pull: whole14, leftOut: r14a.lastLeftOut, lacking: r14a.lastLacking, cursor: [cursor14, after14] })}; before: listings left out, the cursor kept)`);
        const next14 = await standby.send('pull', {});
        const LEDGER = ['accounts', 'transactions', 'marketplace_transactions'];
        const s14l: Snap = await standby.send('snapshot', { tables: [...LEDGER, 'posts'] });
        const m14l: Snap = await main.send('snapshot', { tables: [...LEDGER, 'posts'] });
        assert(next14.ok === true && next14.mode === 'delta' && LEDGER.every((t) => s14l.tables[t].hash === m14l.tables[t].hash) && s14l.ledgerSum === m14l.ledgerSum
            && s14l.tables.posts.count === m14l.tables.posts.count,
            `the trade M made in that window, in the whole copy and again in the next delta, is on S once: its accounts, transactions and trades are M's, and every listing (${counts(s14l, ...LEDGER, 'posts')}; M ${counts(m14l, ...LEDGER, 'posts')})`);
        // A record an older version wrote: no lastLacking, and lastLeftOut naming listings (no copy leaves a table out now,
        // but a record from before P2 may say one did). It reads them as lacking until a whole copy clears it, as before.
        require_((await standby.send('sql', {
            sql: `UPDATE node_config SET value = json_set(json_remove(value, '$.lastLacking'), '$.lastLeftOut', json(?)) WHERE key = 'standby_copy_record'`,
            args: [JSON.stringify({ since: Date.now() - 60_000, at: Date.now() - 60_000, tables: ['posts'] })],
        })) === 1, 'S: its record as a version before lastLacking wrote it, naming listings left out');
        const r14b = await standby.send('record');
        const clear14 = await standby.send('pull', { whole: true });
        const r14c = await standby.send('record');
        assert(JSON.stringify(r14b.lastLacking?.tables) === JSON.stringify(['posts']) && clear14.ok === true && r14c.lastLacking === null && r14c.lastLeftOut === null,
            `that record reads its left-out listings as lacking, and the next whole copy, which leaves nothing out, clears both (${JSON.stringify({ lacking: r14b.lastLacking?.tables ?? null, after: { lacking: r14c.lastLacking, leftOut: r14c.lastLeftOut } })})`);
        await main.send('unflood');
        await pullAndSwap({}, 'resync');

        // ── 15. Drift found while listings flood on: mended at once, the cursor moved, nothing missed ──
        console.log('\n— 15. the flood running on and a membership gone from S: one whole copy mends it, and no listing is missed —');
        for (let i = 0; i < 3; i++) {
            await main.send('flood', { kind: 'posts', n: 60, author: gwen.pk });
            const d = await standby.send('pull', {});
            require_(d.ok === true && d.mode === 'delta', `S's delta after 60 more listings on M lands (${JSON.stringify(d)})`);
        }
        require_((await standby.send('sql', { sql: 'DELETE FROM group_members WHERE group_id = ?', args: [groupId] })) > 0,
            'S: the group\'s membership deleted, with no tombstone');
        const ledger15: Snap = await standby.send('snapshot', { tables: ['accounts', 'transactions', 'marketplace_transactions'] });
        const pulls15: { mode: string; ok: boolean; whole: boolean; gap: number; members: string }[] = [];
        for (let i = 0; i < 6; i++) {
            await main.send('flood', { kind: 'posts', n: 5, author: gwen.pk });
            const p = await standby.send('pull', {});
            const gs: Snap = await standby.send('snapshot', { tables: ['posts', 'group_members'] });
            const gm: Snap = await main.send('snapshot', { tables: ['posts', 'group_members'] });
            pulls15.push({ mode: p.mode, ok: p.ok, whole: p.landedWhole === true, gap: gm.tables.posts.count - gs.tables.posts.count, members: `${gs.tables.group_members.count}/${gm.tables.group_members.count}` });
            await sleep(300);
        }
        const show15 = pulls15.map((p) => `${p.mode}${p.ok ? '' : '!'}[gap ${p.gap}; members ${p.members}]`).join(', ');
        const s15b: Snap = await standby.send('snapshot', { tables: HASHED });
        const m15b: Snap = await main.send('snapshot', { tables: HASHED });
        assert(pulls15.every((p) => p.ok) && pulls15.filter((p) => p.whole).length === 1 && pulls15[1].mode === 'full'
            && s15b.tables.group_members.hash === m15b.tables.group_members.hash && pulls15.every((p) => p.gap === 0),
            `the canary finds the drift at the first delta, the next pull's whole copy brings the membership back, and no listing of M's is ever missing from S (${show15}; before: held back until the routine time)`);
        const sk15 = await standby.send('keys', { table: 'posts', key: 'id' });
        const mk15 = await main.send('keys', { table: 'posts', key: 'id' });
        assert(sk15.hash === mk15.hash && sk15.count === sk15.distinct
            && ['accounts', 'transactions', 'marketplace_transactions'].every((t) => s15b.tables[t].hash === ledger15.tables[t].hash && s15b.tables[t].hash === m15b.tables[t].hash)
            && s15b.ledgerSum === m15b.ledgerSum,
            `S holds M's listings, each once, and its accounts, transactions and trades are as before and M's (${JSON.stringify({ S: sk15, M: mk15, sum: [s15b.ledgerSum, m15b.ledgerSum] })})`);
        await main.send('unflood');

        refused.push(...(await standby.send('fetches')).blocked, ...(await main.send('fetches')).blocked);
        assert(refused.length === 0, `no node reached anything off this machine (${JSON.stringify(refused)})`);
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
