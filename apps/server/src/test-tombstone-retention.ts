/**
 * Test Suite: tombstones are kept 30 days on every server, and a standby that has been away longer takes a force-resync
 * (T6 of scratch/global-node/DESIGN-replica-flood-bounds-opus.md §6.3).
 *
 * A main server M and a standby S, each its own process with its own data dir (takeover-test-harness.ts), M serving its
 * real HTTPS server (members act through it with signed requests) and S pulling through its real puller (`pullNow`, the
 * loop's own step) from M's real backup routes. A delete travels to a standby only as its tombstone, so a tombstone
 * pruned before a standby copied it leaves the row on that standby. Time is not waited for: tombstones are stamped 31 days
 * ago, and a cursor that old stands for a standby switched off that long. The prune is the daily one
 * (connector-manager.ts). Nothing leaves this machine.
 *
 *  1. M: members, a DM, a listing, a recovery code. S's first copy lands, exact, with M's take-over keys. S's routine
 *     whole copies are off (Settings' cadence, as an operator sets it for a large community), so its next pull after a
 *     restart is a delta, as between restarts.
 *  2. A standby whose copies have been refused for 40 days (its cursor stays where the last copy that landed put it)
 *     prunes a 35-day-old tombstone and keeps a 29-day-old one (before: the cursor floored the prune, and both stayed).
 *     One whose cursor an older version's refused force-resync left `''` prunes too (it did before: `''` never floored it).
 *  3. S away 31 days: M deleted a DM line 31 days ago and has pruned its tombstone. S's next pull is a force-resync, not a
 *     delta, and lands exact: the line is gone from S, and the listing M made since is there. The pull after is a delta.
 *     (Before: a delta, which left the line on S for good. With routine whole copies on, a restart's first pull was a
 *     whole copy, which left the line too, and whose check asked for a force-resync only outside its six-hour limit.)
 *  4. The same, with the force-resync refused (a node_config key on S that the replication manifest doesn't classify,
 *     which the stager's closing check refuses a whole copy over and a delta never reads; members over the row cap
 *     refused it before P2, and nothing refuses a copy for its size now): a delta lands meanwhile and moves the cursor,
 *     and S restarts; the resync is still owed, asked for again, and lands exact once the key is gone. (A delta that
 *     lands never mends the deletes it missed.)
 *  5. The same, with M unable to send a whole copy (it answers 503, as a community too large to build one in time does):
 *     the failed force-resync is asked for again only after the retry wait (an hour, scaled down), deltas landing in
 *     between (a listing M made meanwhile reaches S), and it stays owed until one lands exact. (Before: a copy that never
 *     came was asked for again on every pull, and no delta ever landed.) With routine whole copies on (5b), the routine
 *     whole copy due at once after the restart, which M can't send either, waits for the next routine time too: the pulls
 *     after it are deltas, and land. (Before: a routine whole copy on every pull, and no delta.) The routine whole copy
 *     is due from when the last one landed, which S's record keeps across a restart (P2: a whole copy of more than one
 *     page restarts the standby), so the restart comes with its last whole copy made 11 minutes before. And (5c) a
 *     restart just under 29 days after the last delta, whose routine whole copy lands (M holding more listings than the
 *     old row cap: nothing is left out now), moves the cursor: that copy carried every tombstone M holds, so the pulls
 *     after it are deltas, even past the 29 days. (Before: a whole copy that left listings out kept the cursor, which
 *     passed 29 days and asked for a force-resync.)
 *  6. S takes over with the recovery code. The promoted server forgets its pull cursor, and prunes a tombstone written
 *     35 days ago, after a take-over 40 days ago, and keeps a 29-day-old one. (Before: its last pull's cursor floored the
 *     prune, so no tombstone written after the take-over was ever pruned.)
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-tombstone-retention.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, post, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';
import { lockedDm } from './dm-test-payload.js';
import http from 'node:http';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Retention-Main-Pw-5528!';
const PW_STANDBY = 'Retention-Standby-Pw-6613!';
/** S's row cap, scaled down from 250,000 as test-dos-caps scales it. */
const CAP = 150;
const FLOOD = 160;
/** The wait after a refused force-resync (BACKUP_RESYNC_RETRY_MS), scaled down from an hour. */
const RETRY_MS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Step 5c's cursor is this much short of 29 days old at S's restart: room for the restart and its whole copy. */
const NEAR_MS = 15_000;
const TABLES = ['members', 'accounts', 'posts', 'conversations', 'conversation_participants', 'messages'];

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
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            seedGenesisMember(a.genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            await flushTakeoverChecks();
            return { code: made.code };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig, updateBackupCadence } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            // Routine whole copies off, as Settings' cadence sets it: the pull after a restart is a delta.
            updateBackupCadence({ reconcileMinutes: 0 });
            return true;
        },
        /** Settings' cadence of routine whole copies, in minutes (0: off); kept in the local config, across a restart. */
        'set-cadence': async (a: { minutes: number }) => {
            const { updateBackupCadence } = await import('./config/local-config.js');
            updateBackupCadence({ reconcileMinutes: a.minutes });
            return true;
        },
        /** The main server's address this standby pulls from (read on each pull). */
        'point-at': async (a: { url: string }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            updateLocalConfig({ backupPrimaryUrl: a.url });
            return true;
        },
        /** One pull of the kind the loop makes next, and the take-over keys after it, as the loop fetches them. */
        pull: async () => {
            const { pullNow, getBackupStatus, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            const s = getBackupStatus();
            const envelope = await pullTakeoverEnvelopeNow();
            return { ok: result.ok, error: result.error ?? null, mode: s.lastPullMode ?? null, envelope };
        },
        /** The puller's start as index.ts makes it: it resumes from the cursor this database saved. Its loop is stopped at once. */
        'boot-puller': async () => {
            const { initBackupPuller, stopBackupPuller, getBackupStatus } = await import('./services/backup-puller.js');
            initBackupPuller();
            stopBackupPuller();
            return getBackupStatus().cursor;
        },
        /** Each table's rows, counted and hashed; the saved pull cursor; the standby's record of its copies. */
        snapshot: async (a: { tables: string[] }) => {
            const { db } = await import('./db/db.js');
            const { readCopyRecord } = await import('./services/standby-copy-record.js');
            const tables: Record<string, { count: number; hash: string }> = {};
            for (const t of a.tables) {
                const rows = (db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[])
                    .map(({ last_active_at: _l, ...rest }) => JSON.stringify(rest)).sort();
                tables[t] = { count: rows.length, hash: crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16) };
            }
            const cursorRow = db.prepare(`SELECT last_synced_at AS c FROM sync_cursors WHERE peer_id = 'backup:primary'`).get() as { c: string } | undefined;
            const r = readCopyRecord() as any;
            return {
                tables, savedCursor: cursorRow ? cursorRow.c : null,
                record: { lastWhole: r.lastWhole, lastOutcome: r.lastOutcome, lastWhy: r.lastWhy, pastRetentionAt: r.pastRetentionAt ?? null },
            };
        },
        /** SQL on this server, as a bug, an older version or the passing of time would leave it. */
        sql: async (a: { sql: string; args?: unknown[] }) => {
            const { db } = await import('./db/db.js');
            return db.prepare(a.sql).run(...(a.args ?? [])).changes;
        },
        /** Whether a message is on this server. */
        'has-message': async (a: { id: string }) => {
            const { db } = await import('./db/db.js');
            return !!db.prepare('SELECT 1 FROM messages WHERE id = ?').get(a.id);
        },
        /** A message deleted on this server, with its tombstone (db/db.ts writeTombstone), stamped `daysAgo` days ago. */
        'delete-message': async (a: { id: string; daysAgo: number }) => {
            const { db, writeTombstone } = await import('./db/db.js');
            db.prepare('DELETE FROM messages WHERE id = ?').run(a.id);
            writeTombstone('messages', a.id);
            db.prepare(`UPDATE tombstones SET deleted_at = ? WHERE table_name = 'messages' AND row_key = ?`)
                .run(new Date(Date.now() - a.daysAgo * DAY_MS).toISOString(), a.id);
            return true;
        },
        /** Tombstones keyed `row_key`, stamped `daysAgo` days ago. */
        plant: async (a: { tombstones: { key: string; daysAgo: number }[] }) => {
            const { db } = await import('./db/db.js');
            for (const t of a.tombstones) {
                db.prepare(`INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at) VALUES ('messages', ?, ?)`)
                    .run(t.key, new Date(Date.now() - t.daysAgo * DAY_MS).toISOString());
            }
            return true;
        },
        /** The daily prune (connector-manager.ts), then which of `keys` are still there. */
        prune: async (a: { keys: string[] }) => {
            const { db } = await import('./db/db.js');
            const { pruneTombstones } = await import('./connector-manager.js');
            pruneTombstones();
            return a.keys.filter((k) => !!db.prepare(`SELECT 1 FROM tombstones WHERE table_name = 'messages' AND row_key = ?`).get(k));
        },
        /** `n` listings by `author`, written now: more than the old row cap (MAX_IMPORT_ROWS_PER_CATEGORY), which left them out of a whole copy. */
        'flood-posts': async (a: { n: number; author: string }) => {
            const { db } = await import('./db/db.js');
            const now = new Date().toISOString();
            db.transaction(() => {
                for (let i = 0; i < a.n; i++) {
                    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at) VALUES (?, 'offer', 'food', ?, 'a flood', 1, ?, ?, ?)`)
                        .run(`flood-${crypto.randomUUID()}`, `Flood ${i}`, a.author, now, now);
                }
            })();
            return true;
        },
        'unflood-posts': async () => {
            const { db } = await import('./db/db.js');
            return db.prepare(`DELETE FROM posts WHERE id LIKE 'flood-%'`).run().changes;
        },
        /** The standby's record: the tables its last copy left out. */
        'left-out': async () => {
            const { readCopyRecord } = await import('./services/standby-copy-record.js');
            return readCopyRecord().lastLeftOut?.tables ?? null;
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

/** A POST to a node's real HTTPS server, signed by `as`, or not signed. */
async function api(base: string, route: string, as: Id | null, body: unknown = {}): Promise<Answer> {
    const raw = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (as) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = as.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`POST\n${route}\n${ts}\n${nonce}\n${raw}`), as.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: raw });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json };
}
function built(what: string, a: Answer): any {
    require_(a.status >= 200 && a.status < 300, `M: ${what} (${a.status} ${JSON.stringify(a.body)?.slice(0, 160)})`);
    return a.body;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

type Snap = {
    tables: Record<string, { count: number; hash: string }>; savedCursor: string | null;
    record: { lastWhole: any; lastOutcome: string | null; lastWhy: string | null; pastRetentionAt: number | null };
};
const counts = (s: Snap, ...ts: string[]) => ts.map((t) => `${t} ${s.tables[t]?.count}`).join(', ');
const same = (a: Snap, b: Snap, ...ts: string[]) => ts.every((t) => a.tables[t]?.hash === b.tables[t]?.hash);

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
    const [ann, bo] = ['Ann', 'Bo'].map(newId);
    const refused: string[] = [];

    try {
        // ── 1. M, and S's first copy ──
        console.log('\n— 1. the main server, and its standby\'s first copy —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        for (const who of [ann, bo]) {
            const inv = built(`Gwen makes an invite for ${who.name}`, await api(m, '/api/invite/generate', gwen, { publicKey: gwen.pk }));
            built(`${who.name} joins with it`, await api(m, '/api/invite/redeem', null, { code: inv.invite?.code ?? inv.code, publicKey: who.pk, callsign: who.name }));
            built(`${who.name} sets a profile photo (listings need one)`, await api(m, '/api/profile/update', who, { avatar: TINY_PNG }));
        }
        const offer = async (who: Id, title: string) => built(`${who.name} offers ${title}`, await api(m, '/api/marketplace/posts', who, {
            type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits: 3, priceType: 'fixed', authorPublicKey: who.pk,
        })).post;
        await offer(ann, 'Honey');
        const conv = built('Ann opens a DM with Bo', await api(m, '/api/messages/conversation', ann, { type: 'dm', participants: [ann.pk, bo.pk], createdBy: ann.pk }));
        const conversationId: string = conv.conversation?.id ?? conv.id;
        const lines: string[] = [];
        for (let i = 0; i < 3; i++) {
            const r = built(`Ann sends Bo line ${i + 1}`, await api(m, '/api/messages/send', ann, { conversationId, authorPubkey: ann.pk, ...lockedDm() }));
            lines.push(r.message?.id ?? r.id);
        }
        require_(lines.every((id) => typeof id === 'string'), `M: the DM's lines have ids (${JSON.stringify(lines)})`);

        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const first1 = await standby.send('pull');
        const s1: Snap = await standby.send('snapshot', { tables: TABLES });
        const m1: Snap = await main.send('snapshot', { tables: TABLES });
        require_(first1.ok === true && s1.record.lastWhole?.exact === true && s1.tables.messages.count === 3 && same(s1, m1, 'messages', 'posts')
            && first1.envelope === 'stored',
            `S's first copy lands, exact, with M's take-over keys (${JSON.stringify(first1)}; ${counts(s1, 'members', 'posts', 'messages')})`);

        /** S stopped, its database changed as `patch` says (it is off meanwhile), and started again, its puller resuming. */
        const restart = async (patch: (db: Database.Database) => void = () => {}) => {
            refused.push(...(await standby.send('fetches')).blocked);
            await standby.send('checkpoint');
            await standby.kill('SIGTERM');
            withDb(dir('standby'), patch);
            standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
            nodes.push(standby);
            return standby.send('boot-puller');
        };
        const awayCursor = (days: number) => (db: Database.Database) => {
            db.prepare(`UPDATE sync_cursors SET last_synced_at = ? WHERE peer_id = 'backup:primary'`).run(new Date(Date.now() - days * DAY_MS).toISOString());
        };
        /** S's record says its last whole copy landed `ms` ago (standby-copy-record.ts lastWholeCopy), as time passing would. */
        const lastWholeCopyAgo = (ms: number) => (db: Database.Database) => {
            const row = db.prepare(`SELECT value FROM node_config WHERE key = 'standby_copy_record'`).get() as { value: string } | undefined;
            const r = row ? JSON.parse(row.value) : {};
            r.lastWholeCopy = { ...(r.lastWholeCopy ?? { pages: 1, generatedAt: null }), at: Date.now() - ms };
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('standby_copy_record', ?)`).run(JSON.stringify(r));
        };

        // ── 2. A standby whose copies were refused for 40 days prunes ──
        console.log('\n— 2. a standby whose cursor is 40 days old (its copies refused since), or empty, still prunes —');
        const saved2 = s1.savedCursor;
        await standby.send('sql', { sql: `UPDATE sync_cursors SET last_synced_at = ? WHERE peer_id = 'backup:primary'`, args: [new Date(Date.now() - 40 * DAY_MS).toISOString()] });
        await standby.send('plant', { tombstones: [{ key: 'retention-35d', daysAgo: 35 }, { key: 'retention-29d', daysAgo: 29 }] });
        const left2 = await standby.send('prune', { keys: ['retention-35d', 'retention-29d'] });
        assert(JSON.stringify(left2) === JSON.stringify(['retention-29d']),
            `a 35-day-old tombstone is pruned and a 29-day-old one kept (left: ${JSON.stringify(left2)}; before: both kept, the 40-day-old cursor floored the prune)`);
        await standby.send('sql', { sql: `UPDATE sync_cursors SET last_synced_at = '' WHERE peer_id = 'backup:primary'` });
        await standby.send('plant', { tombstones: [{ key: 'retention-31d', daysAgo: 31 }] });
        const empty2 = await standby.send('prune', { keys: ['retention-31d', 'retention-29d'] });
        assert(JSON.stringify(empty2) === JSON.stringify(['retention-29d']),
            `with the cursor an older version's refused force-resync left empty, a 31-day-old tombstone is pruned too (left: ${JSON.stringify(empty2)})`);
        await standby.send('sql', { sql: `UPDATE sync_cursors SET last_synced_at = ? WHERE peer_id = 'backup:primary'`, args: [saved2] });
        await standby.send('sql', { sql: `DELETE FROM tombstones WHERE row_key LIKE 'retention-%'` });

        // ── 3. S away 31 days ──
        console.log('\n— 3. a standby away 31 days takes a force-resync, not a delta —');
        await main.send('delete-message', { id: lines[0], daysAgo: 31 });
        const mLeft3 = await main.send('prune', { keys: [lines[0]] });
        require_(mLeft3.length === 0, `M: the line deleted 31 days ago has its tombstone pruned (${JSON.stringify(mLeft3)})`);
        const jam = await offer(bo, 'Jam');
        const resumed3 = await restart(awayCursor(31));
        require_(!!resumed3 && Date.parse(resumed3) < Date.now() - 30 * DAY_MS, `S restarts with the cursor of a copy 31 days ago (${resumed3})`);
        const pull3 = await standby.send('pull');
        const s3: Snap = await standby.send('snapshot', { tables: TABLES });
        const m3: Snap = await main.send('snapshot', { tables: TABLES });
        assert(pull3.ok === true && pull3.mode === 'resync', `S's next pull is a force-resync, and it lands (${JSON.stringify(pull3)}; before: a delta)`);
        assert(!(await standby.send('has-message', { id: lines[0] })) && same(s3, m3, 'messages', 'posts', 'members', 'accounts') && s3.record.lastWhole?.exact === true,
            `S's copy is M's, exact: the line M deleted 31 days ago is gone, and Bo's jam is there (${counts(s3, 'messages', 'posts')}; M ${counts(m3, 'messages', 'posts')}; verdict ${JSON.stringify(s3.record.lastWhole?.differs)}; before: the line stayed on S)`);
        assert(s3.record.pastRetentionAt === null && typeof jam?.id === 'string', `S owes no force-resync now (${s3.record.pastRetentionAt})`);
        const after3 = await standby.send('pull');
        assert(after3.ok === true && after3.mode === 'delta', `the pull after it is a delta (${JSON.stringify(after3)})`);

        // ── 4. The force-resync refused: owed until one lands ──
        console.log('\n— 4. the force-resync refused: a delta and a restart don\'t forget it —');
        await main.send('delete-message', { id: lines[1], daysAgo: 31 });
        require_((await main.send('prune', { keys: [lines[1]] })).length === 0, 'M: a second line deleted 31 days ago, its tombstone pruned');
        // A key no manifest entry classifies: the stager refuses a whole copy over it, and a delta never reads it.
        await restart((db) => {
            awayCursor(31)(db);
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('retention_test_unclassified', 'x')`).run();
        });
        const pull4 = await standby.send('pull');
        const s4a: Snap = await standby.send('snapshot', { tables: TABLES });
        assert(pull4.mode === 'resync' && pull4.ok === false && /retention_test_unclassified/.test(pull4.error ?? '') && s4a.record.pastRetentionAt !== null,
            `S's force-resync is refused (a key the manifest doesn't classify) and still owed (${JSON.stringify({ pull: pull4, owed: s4a.record.pastRetentionAt })})`);
        const delta4 = await standby.send('pull');
        const s4b: Snap = await standby.send('snapshot', { tables: TABLES });
        assert(delta4.ok === true && delta4.mode === 'delta' && !!s4b.savedCursor && Date.parse(s4b.savedCursor) > Date.now() - DAY_MS
            && await standby.send('has-message', { id: lines[1] }) && s4b.record.pastRetentionAt !== null,
            `a delta lands meanwhile and moves the cursor to today, the line M deleted still on S, and the resync still owed (${JSON.stringify({ pull: delta4, cursor: s4b.savedCursor, owed: s4b.record.pastRetentionAt })})`);
        const resumed4 = await restart();
        const again4 = await standby.send('pull');
        assert(resumed4 === s4b.savedCursor && again4.mode === 'resync' && again4.ok === false,
            `S restarted with a cursor of today asks for the force-resync again, and it is refused again (${JSON.stringify({ cursor: resumed4, pull: again4 })})`);
        await standby.send('sql', { sql: `DELETE FROM node_config WHERE key = 'retention_test_unclassified'` });
        await sleep(RETRY_MS + 300);
        const land4 = await standby.send('pull');
        const s4c: Snap = await standby.send('snapshot', { tables: TABLES });
        const m4: Snap = await main.send('snapshot', { tables: TABLES });
        assert(land4.ok === true && land4.mode === 'resync' && !(await standby.send('has-message', { id: lines[1] }))
            && same(s4c, m4, 'messages', 'members', 'accounts') && s4c.record.lastWhole?.exact === true && s4c.record.pastRetentionAt === null,
            `the key gone, the force-resync lands, exact: the second line is gone from S, and nothing is owed (${JSON.stringify({ pull: land4, verdict: s4c.record.lastWhole?.differs, owed: s4c.record.pastRetentionAt })}; ${counts(s4c, 'messages', 'members')}; M ${counts(m4, 'messages', 'members')})`);
        const after4 = await standby.send('pull');
        assert(after4.ok === true && after4.mode === 'delta', `the pull after it is a delta (${JSON.stringify(after4)})`);

        // ── 5. The force-resync's copy never comes: deltas meanwhile, asked for again after the wait ──
        console.log('\n— 5. M can\'t send the force-resync\'s copy: deltas land meanwhile, and it is asked for again after the wait —');
        // A localhost proxy in front of M: it passes everything, or answers 503 to a whole copy while deltas pass.
        let failWhole = false;
        const asked = { whole: 0, delta: 0 };
        const proxy = http.createServer(async (req, res) => {
            try {
                const chunks: Buffer[] = [];
                for await (const c of req) chunks.push(c as Buffer);
                const p = req.url ?? '/';
                // A copy is opened by a POST to sync-copy: a whole one with no `since`, a delta with one (routes/backup.ts).
                const opens = req.method === 'POST' && /^\/api\/local\/admin\/sync-copy(\?|$)/.test(p);
                const isWhole = opens && !/[?&]since=/.test(p);
                if (isWhole) asked.whole++;
                if (opens && !isWhole) asked.delta++;
                if (failWhole && isWhole) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Snapshot unavailable' }));
                    return;
                }
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'content-length') headers[k] = v;
                const r = await fetch(main.base + p, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
                const out: Record<string, string> = {};
                r.headers.forEach((v, k) => { if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') out[k] = v; });
                res.writeHead(r.status, out);
                res.end(Buffer.from(await r.arrayBuffer()));
            } catch (e: any) {
                res.writeHead(502);
                res.end(String(e?.message || e));
            }
        });
        await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
        try {
            await standby.send('point-at', { url: `http://127.0.0.1:${(proxy.address() as any).port}` });
            await main.send('delete-message', { id: lines[2], daysAgo: 31 });
            require_((await main.send('prune', { keys: [lines[2]] })).length === 0, 'M: a third line deleted 31 days ago, its tombstone pruned');
            await restart(awayCursor(31));
            failWhole = true;
            const bread = await offer(bo, 'Bread');
            const before5 = { ...asked };
            const pull5 = await standby.send('pull');
            const s5a: Snap = await standby.send('snapshot', { tables: TABLES });
            assert(pull5.mode === 'resync' && pull5.ok === false && s5a.record.pastRetentionAt !== null,
                `S's force-resync gets no copy (M answers 503), and is still owed (${JSON.stringify({ pull: pull5, owed: s5a.record.pastRetentionAt })})`);
            const between5: string[] = [];
            for (let i = 0; i < 3; i++) {
                const p = await standby.send('pull');
                between5.push(`${p.mode}:${p.ok ? 'ok' : 'failed'}`);
            }
            const s5b: Snap = await standby.send('snapshot', { tables: TABLES });
            const hasBread = (await standby.send('sql', { sql: 'UPDATE posts SET title = title WHERE id = ?', args: [bread.id] })) === 1;
            assert(between5.every((x) => x === 'delta:ok') && asked.whole - before5.whole === 1 && asked.delta - before5.delta === 3,
                `the next three pulls are deltas, and land; M was asked for one whole copy, not four (${between5.join(', ')}; whole ${asked.whole - before5.whole}, deltas ${asked.delta - before5.delta}; before: four failed force-resyncs, no delta)`);
            assert(hasBread && !!s5b.savedCursor && Date.parse(s5b.savedCursor) > Date.now() - DAY_MS,
                `Bo's bread, listed on M after S came back, is on S, and the cursor is today's (${JSON.stringify({ bread: hasBread, cursor: s5b.savedCursor })}; before: neither)`);
            assert(s5b.record.pastRetentionAt !== null && await standby.send('has-message', { id: lines[2] }),
                `the force-resync is still owed, and the line M deleted is still on S (${s5b.record.pastRetentionAt})`);
            await sleep(RETRY_MS + 300);
            const again5 = await standby.send('pull');
            const next5 = await standby.send('pull');
            assert(again5.mode === 'resync' && again5.ok === false && next5.mode === 'delta' && next5.ok === true,
                `after the wait the force-resync is asked for again, fails again, and a delta follows (${JSON.stringify({ again: again5, next: next5 })})`);
            failWhole = false;
            await sleep(RETRY_MS + 300);
            const land5 = await standby.send('pull');
            const s5c: Snap = await standby.send('snapshot', { tables: TABLES });
            const m5: Snap = await main.send('snapshot', { tables: TABLES });
            assert(land5.ok === true && land5.mode === 'resync' && !(await standby.send('has-message', { id: lines[2] }))
                && same(s5c, m5, 'messages', 'posts', 'members', 'accounts') && s5c.record.lastWhole?.exact === true && s5c.record.pastRetentionAt === null,
                `M sending whole copies again, the force-resync lands, exact: the third line is gone from S, and nothing is owed (${JSON.stringify({ pull: land5, verdict: s5c.record.lastWhole?.differs, owed: s5c.record.pastRetentionAt })}; ${counts(s5c, 'messages', 'posts')}; M ${counts(m5, 'messages', 'posts')})`);

            // 5b. Routine whole copies on (every 10 minutes, the default cadence's kind): after a restart the routine one is
            // due at once, and M can't send it either.
            console.log('\n— 5b. the same with routine whole copies on: the routine whole copy that never comes waits for the next routine time —');
            await standby.send('set-cadence', { minutes: 10 });
            await restart((db) => { awayCursor(31)(db); lastWholeCopyAgo(11 * 60_000)(db); });
            failWhole = true;
            const plums = await offer(bo, 'Plums');
            const before5b = { ...asked };
            const t5b = Date.now();
            const pulls5b: string[] = [];
            for (let i = 0; i < 6; i++) {
                const p = await standby.send('pull');
                pulls5b.push(`${p.mode}:${p.ok ? 'ok' : 'failed'}`);
            }
            const took5b = Date.now() - t5b;
            const s5d: Snap = await standby.send('snapshot', { tables: TABLES });
            const hasPlums = (await standby.send('sql', { sql: 'UPDATE posts SET title = title WHERE id = ?', args: [plums.id] })) === 1;
            require_(took5b < RETRY_MS, `S: the six pulls take less than the retry wait (${took5b} ms)`);
            assert(pulls5b[0] === 'resync:failed' && pulls5b[1] === 'full:failed' && pulls5b.slice(2).every((x) => x === 'delta:ok')
                && asked.whole - before5b.whole === 2 && asked.delta - before5b.delta === 4,
                `the force-resync, then the routine whole copy, get no copy; the next four pulls are deltas, and land; M was asked for two whole copies, not six (${pulls5b.join(', ')}; whole ${asked.whole - before5b.whole}, deltas ${asked.delta - before5b.delta}; before: five failed routine whole copies, no delta)`);
            assert(hasPlums && !!s5d.savedCursor && Date.parse(s5d.savedCursor) > Date.now() - DAY_MS && s5d.record.pastRetentionAt !== null,
                `Bo's plums, listed on M after S came back, are on S, the cursor is today's, and the force-resync is still owed (${JSON.stringify({ plums: hasPlums, cursor: s5d.savedCursor, owed: s5d.record.pastRetentionAt })}; before: no plums, and the cursor 31 days old)`);
            failWhole = false;
            await sleep(RETRY_MS + 300);
            const land5b = await standby.send('pull');
            const s5e: Snap = await standby.send('snapshot', { tables: TABLES });
            require_(land5b.ok === true && land5b.mode === 'resync' && s5e.record.pastRetentionAt === null,
                `S: M sending whole copies again, the force-resync lands, and nothing is owed (${JSON.stringify({ pull: land5b, owed: s5e.record.pastRetentionAt })})`);

            // 5c. S switched off just under 29 days after its last delta, M holding more listings than the old cap let one copy
            // carry: the restart's routine whole copy lands in pages with every one of them (before paged copies it left
            // listings out), and carries every tombstone M holds. It doesn't keep a cursor that passes 29 days before the next
            // pull, which would ask for a force-resync of deletes it already applied, and have M build and sign its whole
            // database again (#1315 review 4133485540).
            console.log('\n— 5c. a restart just under 29 days on, whose whole copy holds more listings than the old cap: no retention force-resync after it —');
            await main.send('flood-posts', { n: FLOOD, author: gwen.pk });
            const near5c = Date.now() - 29 * DAY_MS + NEAR_MS;
            const nearCursor = new Date(near5c).toISOString();
            await restart((db) => {
                db.prepare(`UPDATE sync_cursors SET last_synced_at = ? WHERE peer_id = 'backup:primary'`).run(nearCursor);
                lastWholeCopyAgo(11 * 60_000)(db);
            });
            const before5c = { ...asked };
            const whole5c = await standby.send('pull');
            const s5f: Snap = await standby.send('snapshot', { tables: ['posts'] });
            const left5c = await standby.send('left-out');
            require_(whole5c.ok === true && whole5c.mode === 'full' && (left5c === null || left5c.length === 0),
                `S: the restart's whole copy lands with nothing left out, M's ${FLOOD} more listings included (${JSON.stringify({ pull: whole5c, leftOut: left5c })}; before: listings left out over the cap)`);
            assert(!!s5f.savedCursor && s5f.savedCursor !== nearCursor && Date.parse(s5f.savedCursor) > Date.now() - DAY_MS,
                `the whole copy moves the cursor to today, not keeping one 29 days less ${NEAR_MS / 1000} s old (${JSON.stringify({ was: nearCursor, now: s5f.savedCursor })}; before: kept)`);
            // Past the 29 days the old cursor would have reached by now.
            await sleep(Math.max(0, near5c + 29 * DAY_MS - Date.now()) + 500);
            const pulls5c: string[] = [];
            for (let i = 0; i < 2; i++) {
                const p = await standby.send('pull');
                pulls5c.push(`${p.mode}:${p.ok ? 'ok' : 'failed'}`);
            }
            const s5g: Snap = await standby.send('snapshot', { tables: ['posts'] });
            assert(pulls5c.every((x) => x === 'delta:ok') && asked.whole - before5c.whole === 1 && asked.delta - before5c.delta === 2
                && s5g.record.pastRetentionAt === null,
                `past the 29 days, the next two pulls are deltas, and land; M was asked for one whole copy, and nothing is owed (full:ok, ${pulls5c.join(', ')}; whole ${asked.whole - before5c.whole}, deltas ${asked.delta - before5c.delta}; owed ${s5g.record.pastRetentionAt}; before: a retention force-resync, then a delta)`);
            // M's flood gone, a restart's whole copy carries listings again, so S's record leaves nothing out for the take-over.
            await main.send('unflood-posts');
            await restart(lastWholeCopyAgo(11 * 60_000));
            const clean5c = await standby.send('pull');
            const leftAfter5c = await standby.send('left-out');
            require_(clean5c.ok === true && clean5c.mode === 'full' && (leftAfter5c === null || leftAfter5c.length === 0),
                `S: M's flood gone, the restart's whole copy lands with nothing left out (${JSON.stringify({ pull: clean5c, leftOut: leftAfter5c })})`);
            await standby.send('set-cadence', { minutes: 0 });
            await standby.send('point-at', { url: main.base });
        } finally {
            proxy.close();
        }

        // ── 6. The take-over ──
        console.log('\n— 6. S takes over: it forgets its pull cursor and prunes what it writes —');
        refused.push(...(await main.send('fetches')).blocked);
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
        require_(opened.status === 200 && opened.body.success, `the code opens the keys (${opened.status} ${JSON.stringify(opened.body).slice(0, 160)})`);
        refused.push(...(await standby.send('fetches')).blocked);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        require_(confirmed.status === 200, `confirm (${confirmed.status})`);
        require_(await standby.exited === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(standby.ready.role === 'primary' && standby.ready.peerId === main.ready.peerId, `promoted, with M's PeerId (${standby.ready.role})`);
        const s6: Snap = await standby.send('snapshot', { tables: TABLES });
        assert(s6.savedCursor === null, `the promoted server holds no pull cursor (${s6.savedCursor}; before: its last pull's)`);
        // Forty days on: whatever the last pull before the take-over left is that old, and the tombstones below were
        // written 35 and 29 days ago, after the take-over.
        await standby.send('sql', { sql: `UPDATE sync_cursors SET last_synced_at = ? WHERE peer_id = 'backup:primary'`, args: [new Date(Date.now() - 40 * DAY_MS).toISOString()] });
        await standby.send('plant', { tombstones: [{ key: 'promoted-35d', daysAgo: 35 }, { key: 'promoted-29d', daysAgo: 29 }] });
        const left6 = await standby.send('prune', { keys: ['promoted-35d', 'promoted-29d'] });
        assert(JSON.stringify(left6) === JSON.stringify(['promoted-29d']),
            `a tombstone the promoted server wrote 35 days ago is pruned, and one of 29 days kept (left: ${JSON.stringify(left6)}; before: both kept, floored by the last pull before the take-over)`);

        refused.push(...(await standby.send('fetches')).blocked);
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
