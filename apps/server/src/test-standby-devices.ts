/**
 * Test Suite: members' devices and conveniences replicate to a standby through the generic plain-table path, a standby
 * writes none of them and sends no push, and a promoted standby carries them on (G4 of
 * scratch/global-node/DESIGN-standby-takeover-gaps-opus.md; engine/plain-tables.ts, engine/replication-manifest.ts).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; members
 * act through it with signed requests, the admin with the password. The standby pulls through its real puller
 * (services/backup-puller.ts `pullNow`) from the main server's real backup routes, and takes over with the recovery code
 * through the real path. Every push is caught at fetch inside each node (never sent), and nothing leaves this machine.
 *
 * The standby's clock runs an hour ahead of the main server's until the take-over (SQLite's `strftime('now')`, which every
 * stamping trigger writes): a stamp of its own on a copied row would show.
 *
 *  1. The main server M: members register their phones (one phone two accounts share, #1184; Kip leaves a phone with a
 *     stamped leave, #1258, and signs back in on it), mute chats, a keeper reads the enterprise's thread, an event
 *     reminder is sent, the activity list fills (a line older than a month pruned), the admin edits the pricing guide and
 *     a member reports a price.
 *  2. The standby S's first copy: every G4 table is M's, row for row and stamp for stamp, and its copy is format 6.
 *  3. More on M, then a delta: Ann unmutes one chat and is re-keyed (her phone goes, her mute moves to her new key) and
 *     registers again; Bo leaves a phone; a custom pricing item is made and deleted; another activity line. S is M's
 *     again, each delete by its tombstone, the unmute's applied before S follows the re-key.
 *  4. On S, every writer of these tables refuses (the routes with 409 `standby`, the engine's functions before they
 *     write), the side writes of a read or a listing write nothing, and its G4 tables are exactly as before.
 *  5. A whole copy with a plain row and values S's table refuses (a stricter, older standby's CHECKs on invites): the
 *     copy is not exact, reported, and asks for no force-resync (review 4123472786); the next pull is a delta.
 *  6. S sends no push, by any sender: the dispatcher for each category, the escrow and announcement senders, the
 *     timers, and a chat message and an enterprise thread post over HTTPS. The only call of the push service in the
 *     server's source is the dispatcher's, and the copy with the tokens is served to the replication token alone.
 *  7. A standby as a format 5 importer left it, holding a pricing item of its own: it re-seeds itself once.
 *  8. M dies; S takes over with the recovery code. On the promoted server: every phone is M's, verbatim, and a push of
 *     each category reaches exactly as many phones as M's did; the copied leave refuses the late registration Kip's
 *     phone sent before it, and a leave presented there removes exactly the (key, token) stamped at or before it; Cy's
 *     row for the shared phone outlives Dee's delete; a muted chat stays muted and an unmuted one pushes; the keepers'
 *     read marks, the activity list and the pricing guide answer as M's did; a reminder M sent is not sent again, and
 *     the next one is sent once; the next activity line is numbered after M's.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-devices.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, post, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const HERE = path.dirname(SCRIPT);
const PW_MAIN = 'Devices-Main-Pw-5521!';
const PW_STANDBY = 'Devices-Standby-Pw-8830!';
const AHEAD_MS = 3600_000;
const DAY = 86400_000;
const MIN = 60_000;
/** The importer format this change's copy records (engine/sync.ts REPLICA_FORMAT); the one before it, a standby to re-seed. */
const FORMAT = '6';
const FORMAT_BEFORE = '5';

/** The G4 tables on the plain path (engine/replication-manifest.ts). */
const DEVICES = [
    'push_tokens', 'push_token_leaves', 'chat_mutes', 'thread_read_cursors', 'event_reminders_sent', 'activity_feed',
    'pricing_guide_items', 'pricing_reports',
] as const;
type Tables = Record<string, Record<string, unknown>[]>;
type Push = { to: string; title: string; categoryId: string };

// ── The node processes' commands ───────────────────────────────────────────────────────────

/** No node reaches anything but this machine: a push to Expo is caught here and answered, anything else refused and counted. */
function guardFetch(): { blocked: string[]; pushes: Push[] } {
    const seen = { blocked: [] as string[], pushes: [] as Push[] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') {
            for (const m of JSON.parse(String(init?.body ?? '[]'))) seen.pushes.push({ to: m.to, title: m.title, categoryId: m.categoryId });
            return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        seen.blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return seen;
}

/** Each G4 table as this server holds it, every column, ordered by its key. */
async function deviceRows(): Promise<Tables> {
    const { db } = await import('./db/db.js');
    const out: Tables = {};
    for (const t of DEVICES) {
        const key = (db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk').all(t) as { name: string }[]).map((c) => `"${c.name}"`);
        out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY ${key.join(', ')}`).all() as Record<string, unknown>[];
    }
    return out;
}

async function child(): Promise<void> {
    const fetches = guardFetch();
    /** The pushes handed to the push service since the last call of `takePushes`. */
    const takePushes = () => fetches.pushes.splice(0);
    /** invite_codes' own text, while the table is held to a stricter rule ('strict-invites'). */
    let invitesAsBuilt: string | null = null;
    await runNodeChild({
        ...serveCommands,
        /** The real server, without the pricing guide's own timer: the scenario runs its cycle itself. */
        serve: async () => {
            const port = await serveCommands.serve({});
            (await import('./pricing-aggregator.js')).stopPricingAggregatorWorker();
            return port;
        },
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
        /** This server's SQLite clock `aheadMs` ahead: `strftime(…, 'now')`, which every stamping trigger writes. */
        'skew-clock': async (a: { aheadMs: number }) => {
            const { db } = await import('./db/db.js');
            const plain = new Database(':memory:');
            db.function('strftime', { varargs: true, deterministic: false }, (format: unknown, time: unknown, ...modifiers: unknown[]) => {
                const at = time === 'now' ? new Date(Date.now() + a.aheadMs).toISOString().replace('T', ' ').replace('Z', '') : time;
                return plain.prepare(`SELECT strftime(?, ?${modifiers.map(() => ', ?').join('')})`).pluck().get(format, at, ...modifiers);
            });
            return (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`).get() as { now: string }).now;
        },
        /** One pull of the kind the loop makes next; `whole` asks the routine whole copy. */
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
        rows: async () => {
            const { db } = await import('./db/db.js');
            const format = (db.prepare(`SELECT value FROM node_config WHERE key = 'replica_format'`).get() as { value: string } | undefined)?.value ?? null;
            const tombstones = db.prepare(`SELECT table_name, row_key FROM tombstones WHERE table_name IN (${DEVICES.map(() => '?').join(', ')})
                                           ORDER BY table_name, row_key`).all(...DEVICES) as { table_name: string; row_key: string }[];
            return { tables: await deviceRows(), format, tombstones };
        },
        /** What the last whole copy's check found, and this standby's record of it (services/standby-copy-record.ts). */
        record: async () => {
            const { getBackupStatus } = await import('./services/backup-puller.js');
            const { readCopyRecord } = await import('./services/standby-copy-record.js');
            const r = readCopyRecord();
            return { consistency: getBackupStatus().consistency ?? null, lastWhole: r.lastWhole, lastMismatchResyncAt: r.lastMismatchResyncAt };
        },
        /**
         * invite_codes held to a stricter rule than the main server's, as an older standby's CHECK that doesn't know a value
         * would be (`on`), or given its own text back (`off`): a used invite's `used_by` is a value this table refuses, and
         * the invite `refuse` is a row it refuses whatever is left out (its key).
         */
        'strict-invites': async (a: { on: boolean; refuse?: string }) => {
            const { db } = await import('./db/db.js');
            const rebuild = (sql: string) => db.transaction(() => {
                db.exec('DROP TABLE IF EXISTS invite_codes_held; CREATE TABLE invite_codes_held AS SELECT * FROM invite_codes; DROP TABLE invite_codes;');
                db.exec(sql);
                db.exec('INSERT INTO invite_codes SELECT * FROM invite_codes_held; DROP TABLE invite_codes_held;');
            })();
            if (a.on) {
                invitesAsBuilt = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invite_codes'`).get() as { sql: string }).sql;
                db.prepare('UPDATE invite_codes SET used_by = NULL').run();
                db.prepare('DELETE FROM invite_codes WHERE code = ?').run(a.refuse ?? '');
                rebuild(invitesAsBuilt.replace(/\)\s*$/, `, CHECK (used_by IS NULL), CHECK (code != '${String(a.refuse ?? '').replace(/'/g, "''")}'))`));
            } else if (invitesAsBuilt) {
                rebuild(invitesAsBuilt);
                invitesAsBuilt = null;
            }
            return (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invite_codes'`).get() as { sql: string }).sql.includes('used_by IS NULL');
        },
        /** The pushes this server handed to the push service since the last ask. */
        pushes: async () => takePushes(),
        /** A push of each category to every member, as the push service is handed it (dispatchPushNotification's count). */
        'push-counts': async () => {
            const { db } = await import('./db/db.js');
            const { dispatchPushNotification } = await import('./state-engine.js');
            const everyone = (db.prepare("SELECT public_key FROM members WHERE public_key != 'SYSTEM'").all() as { public_key: string }[]).map((r) => r.public_key);
            takePushes();
            const counts: Record<string, number> = {};
            for (const category of ['chat', 'marketplace', 'escrow', 'recovery'] as const) {
                counts[category] = dispatchPushNotification(everyone, 'SYSTEM', 'Devices', 'A push of each category', {}, category);
            }
            return { counts, handed: takePushes().length };
        },
        /** The event reminders' minute tick (state-engine.ts initStateEngine), as of `asOf`. */
        'tick-reminders': async (a: { asOf: number }) => {
            const { dispatchPushNotification } = await import('./state-engine.js');
            const { tickEventReminders } = await import('./engine/event-reminders.js');
            takePushes();
            const claimed = tickEventReminders(dispatchPushNotification, a.asOf);
            return { claimed, pushes: takePushes() };
        },
        'pricing-cycle': async () => (await import('./pricing-aggregator.js')).runPricingAggregationCycle(),
        /** An activity line from `days` ago (a join the list recorded then), and the hourly prune of those past 30 days. */
        'old-activity-line': async (a: { actor: string; days: number }) => {
            const { db } = await import('./db/db.js');
            return Number(db.prepare(`INSERT INTO activity_feed (event_type, actor_pubkey, created_at) VALUES ('member_joined', ?, ?)`)
                .run(a.actor, new Date(Date.now() - a.days * DAY).toISOString()).lastInsertRowid);
        },
        'prune-activity': async () => (await import('./db/activity-feed-db.js')).pruneOldActivity(30),
        /**
         * Every writer of these tables, called on this server as a route would call it: each answer (a refusal's code, or
         * what it returned), then the writes on the side of a read, a listing or a timer, and every G4 table before and after.
         */
        'call-writers': async (a: { ids: Record<string, string> }) => {
            const before = await deviceRows();
            const se = await import('./state-engine.js');
            const mutes = await import('./engine/chat-mutes.js');
            const thread = await import('./engine/enterprise-thread.js');
            const pricing = await import('./db/pricing-guide-db.js');
            const feed = await import('./db/activity-feed-db.js');
            const aggregator = await import('./pricing-aggregator.js');
            const id = a.ids;
            const answers: Record<string, string> = {};
            const tryEach = (calls: [string, () => unknown][]) => {
                for (const [name, call] of calls) {
                    try {
                        answers[name] = `returned ${JSON.stringify(call())?.slice(0, 80)}`;
                    } catch (e: any) {
                        answers[name] = e?.code === 'standby' ? 'standby' : `threw ${e?.message?.slice(0, 80)}`;
                    }
                }
            };
            tryEach([
                ['registerPushToken', () => se.registerPushToken(id.cy, 'ExponentPushToken[on-a-standby]', 'ios', 9_000_000)],
                ['applyPushLeave', () => se.applyPushLeave(id.cy, id.sharedToken, 9_000_000)],
                ['removePushToken', () => se.removePushToken(id.cy)],
                ['setChatMute', () => mutes.setChatMute(id.chatAB, id.bo, 'always')],
                ['clearChatMute', () => mutes.clearChatMute(id.chatAB, id.ann2)],
                ['markKeeperThreadRead', () => thread.markKeeperThreadRead(id.probe, id.kip)],
                ['savePricingGuideItem', () => pricing.savePricingGuideItem({ category: 'food', emoji: '🥕', name: 'On a standby', description: '', priceBeans: 3 } as any)],
                ['deletePricingGuideItem', () => pricing.deletePricingGuideItem(id.itemEdited)],
                ['pinPricingGuideItem', () => pricing.pinPricingGuideItem(id.itemEdited, false)],
                ['submitPricingReport', () => pricing.submitPricingReport(id.itemEdited, 'too_low', 'On a standby', id.bo)],
                ['updatePricingReportStatus', () => pricing.updatePricingReportStatus(id.report, 'dismissed')],
                ['seedPricingGuideIfEmpty(reset)', () => pricing.seedPricingGuideIfEmpty(true)],
            ]);
            const sideWrites: Record<string, string> = {};
            for (const [name, call] of [
                ['ensureKeeperReadCursor', () => thread.ensureKeeperReadCursor(id.probe, id.cy)],
                ['recordActivity', () => feed.recordActivity('post_created', id.bo, null, { title: 'On a standby' })],
                ['pruneOldActivity', () => feed.pruneOldActivity(0)],
                ['runPricingAggregationCycle', () => aggregator.runPricingAggregationCycle()],
                ['runEventReminderSweep', () => se.runEventReminderSweep(se.dispatchPushNotification, Number(id.remindAt))],
                ['runMarketplaceHygiene', () => se.runMarketplaceHygiene()],
            ] as [string, () => unknown][]) {
                try { sideWrites[name] = `returned ${JSON.stringify(call())?.slice(0, 60)}`; } catch (e: any) { sideWrites[name] = `threw ${e?.message?.slice(0, 80)}`; }
            }
            const after = await deviceRows();
            const changed = DEVICES.filter((t) => JSON.stringify(before[t]) !== JSON.stringify(after[t]));
            return { answers, sideWrites, changed };
        },
        /**
         * Every push sender, called on this server with recipients whose phones it holds: the dispatcher for each category,
         * the escrow and announcement senders, the timers (a reminder due at `remindAt`). What each handed to the push
         * service, and what they handed in all.
         */
        'push-senders': async (a: { ids: Record<string, string>; everyone: string[] }) => {
            const se = await import('./state-engine.js');
            const { tickEventReminders } = await import('./engine/event-reminders.js');
            const { SystemMessageType } = se;
            const id = a.ids;
            takePushes();
            const answers: Record<string, unknown> = {};
            for (const category of ['chat', 'marketplace', 'escrow', 'recovery'] as const) {
                answers[`dispatchPushNotification(${category})`] = se.dispatchPushNotification(a.everyone, 'SYSTEM', 'On a standby', 'Never sent', {}, category);
            }
            answers.sendPushNotification = se.sendPushNotification(id.post, SystemMessageType.ESCROW_FUNDED, { amount: 1, actorPubkey: id.gwen } as any, a.everyone) ?? 'no answer';
            answers.adminBroadcastAnnouncement = se.adminBroadcastAnnouncement('On a standby', 'Never sent', 'info') ?? 'no answer';
            answers.tickEventReminders = tickEventReminders(se.dispatchPushNotification, Number(id.remindAt));
            answers.runMarketplaceHygiene = se.runMarketplaceHygiene() ?? 'no answer';
            return { answers, handed: takePushes() };
        },
        /** The first unread count and read mark of each keeper's enterprise thread, as "Your groups" gives it. */
        'your-groups': async (a: { keepers: string[] }) => {
            const { listYourChats } = await import('./state-engine.js');
            const out: Record<string, unknown> = {};
            for (const k of a.keepers) {
                out[k] = listYourChats(k).items.filter((c) => c.kind === 'enterprise').map((c) => ({ id: c.id, unread: c.unreadCount }));
            }
            return out;
        },
        /** The biggest activity line id this server holds. */
        'last-activity-id': async () => {
            const { db } = await import('./db/db.js');
            return (db.prepare('SELECT MAX(id) AS id FROM activity_feed').get() as { id: number | null }).id;
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        fetches: async () => ({ blocked: fetches.blocked }),
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
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A call to a node's real HTTPS server, signed by `as`, with the admin password in `admin`, or neither. */
async function api(base: string, method: Method, route: string, opts: { as?: Id; admin?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
    const raw = method === 'GET' ? '' : JSON.stringify(opts.body ?? {});
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
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

/** Where S's G4 tables differ from M's: each table, row for row and column for column, every column. */
function tablesDiff(m: Tables, s: Tables): string[] {
    const out: string[] = [];
    for (const t of DEVICES) {
        const width = t === 'event_reminders_sent' ? 3 : t === 'activity_feed' || t.startsWith('pricing') ? 1 : 2;
        const k = (r: Record<string, unknown>) => JSON.stringify(Object.values(r).slice(0, width));
        const ms = new Map(m[t].map((r) => [k(r), r]));
        const ss = new Map(s[t].map((r) => [k(r), r]));
        for (const [key, r] of ms) {
            const o = ss.get(key);
            if (!o) { out.push(`${t} ${key.slice(0, 40)} missing`); continue; }
            for (const c of Object.keys(r)) {
                if (JSON.stringify(r[c]) !== JSON.stringify(o[c])) out.push(`${t} ${key.slice(0, 40)}.${c}: main ${JSON.stringify(r[c])?.slice(0, 30)}, standby ${JSON.stringify(o[c])?.slice(0, 30)}`);
            }
        }
        for (const key of ss.keys()) if (!ms.has(key)) out.push(`${t} ${key.slice(0, 40)} extra`);
    }
    return out;
}
const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 4).join(' | ')}`);
const count = (t: Tables) => DEVICES.map((n) => `${n} ${t[n].length}`).join(', ');
const has = (t: Tables, table: string, match: Record<string, unknown>) => t[table].some((r) => Object.entries(match).every(([c, v]) => r[c] === v));

function withDb(dir: string, fn: (db: Database.Database) => void): void {
    const db = new Database(path.join(dir, 'state.db'));
    try { fn(db); } finally { db.close(); }
}

/** Every place the server's own source (not a test, a bench or a harness) names `needle`, as `file:line`. */
function sourceMentions(needle: RegExp): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!['node_modules', 'dist', '__tests__', '__fixtures__'].includes(e.name)) walk(file);
                continue;
            }
            if (!e.name.endsWith('.ts') || /^(test-|bench-)|-test-harness\.ts$|-test-http\.ts$|\.test\.ts$/.test(e.name)) continue;
            fs.readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
                if (needle.test(line) && !/^\s*(\/\/|\*)/.test(line)) out.push(`${path.relative(HERE, file)}:${i + 1}`);
            });
        }
    };
    walk(HERE);
    return out;
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    if (process.env.ENABLE_PEER_CONNECTORS !== 'true') throw new Error('Run with ENABLE_PEER_CONNECTORS=true, as the other take-over suites do');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee, kip] = ['Ann', 'Bo', 'Cy', 'Dee', 'Kip'].map(newId);
    const ann2 = newId('Ann (new key)');
    const refused: string[] = [];
    const token = (name: string) => `ExponentPushToken[devices-${name}]`;
    const SHARED = token('shared-phone');

    try {
        // ── 1. M ──
        console.log('\n— 1. the main server: phones, mutes, read marks, a reminder, the activity list, the pricing guide —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        const A = (method: Method, route: string, body?: unknown) => api(m, method, route, { admin: PW_MAIN, body });
        const S_ = (who: Id, route: string, body: unknown = {}, method: Method = 'POST') => api(m, method, route, { as: who, body });
        const invite = async () => {
            const inv = built('Gwen makes an invite', await S_(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
            return (inv.invite?.code ?? inv.code) as string;
        };
        built('Gwen sets a profile photo', await S_(gwen, '/api/profile/update', { avatar: TINY_PNG }));
        const joinedWith: Record<string, string> = {};
        for (const who of [ann, bo, cy, dee, kip]) {
            joinedWith[who.name] = await invite();
            built(`${who.name} joins`, await api(m, 'POST', '/api/invite/redeem', { body: { code: joinedWith[who.name], publicKey: who.pk, callsign: who.name } }));
            built(`${who.name} sets a profile photo`, await S_(who, '/api/profile/update', { avatar: TINY_PNG }));
        }
        const phone = (who: Id, t: string, registeredAt: number | null, platform = 'android') =>
            S_(who, '/api/push-tokens', { publicKey: who.pk, token: t, platform, ...(registeredAt === null ? {} : { registeredAt }) });
        built('Ann registers her phone', await phone(ann, token('ann'), 1000));
        built('Bo registers two phones', await phone(bo, token('bo-1'), 2000, 'ios'));
        built('and the second', await phone(bo, token('bo-2'), 2100));
        built('Cy registers the phone he shares with Dee', await phone(cy, SHARED, 3000));
        built('and Dee registers it too: her own row, Cy\'s untouched (#1184)', await phone(dee, SHARED, 3500));
        built('Gwen registers hers, from an app before stamps', await phone(gwen, token('gwen'), null, 'ios'));
        built('Kip registers two phones', await phone(kip, token('kip-1'), 5000));
        built('and the second', await phone(kip, token('kip-2'), 8000));
        built('Kip leaves the first, with a stamp (#1258, the online form)', await S_(kip, '/api/push-tokens', { publicKey: kip.pk, token: token('kip-1'), leftAt: 6000 }, 'DELETE'));
        const late = await phone(kip, token('kip-1'), 5500);
        require_(late.status === 409 && late.body?.code === 'push_token_left', `M: a registration Kip's phone sent before the leave, delivered after it, is refused (${brief(late)})`);
        const chat = async (a: Id, b: Id) => {
            const c = built(`${a.name} starts a chat with ${b.name}`, await S_(a, '/api/messages/conversation', { type: 'dm', participants: [a.pk, b.pk], createdBy: a.pk }));
            return (c.conversation?.id ?? c.id) as string;
        };
        const say = (who: Id, conversationId: string, text: string) => S_(who, '/api/messages/send', {
            conversationId, authorPubkey: who.pk, ciphertext: Buffer.from(text).toString('base64'), nonce: crypto.randomBytes(24).toString('base64'),
        });
        const chatAB = await chat(ann, bo);
        const chatAC = await chat(ann, cy);
        built('Ann says hello to Bo', await say(ann, chatAB, 'hello'));
        built('Ann says hello to Cy', await say(ann, chatAC, 'hello'));
        const mute = (who: Id, conversationId: string, duration: string) => S_(who, '/api/messages/mute', { conversationId, duration });
        built('Ann mutes her chat with Bo, always', await mute(ann, chatAB, 'always'));
        built('and her chat with Cy, for 8 hours', await mute(ann, chatAC, '8h'));
        built('Bo mutes his chat with Ann for a week', await mute(bo, chatAB, '1w'));
        // An enterprise and its thread: Kip keeps it, posts in it, and both keepers read it.
        const probe = built('Cy starts an enterprise, Probe Co', await S_(cy, '/api/treasury', { name: 'Probe Co', purpose: 'Repairs for the street', avatar: TINY_PNG }));
        built('the admin makes Kip a keeper of Probe Co', await A('POST', `/api/local/admin/treasury/${probe.publicKey}/operators`, { pubkey: kip.pk }));
        built('Kip opens Probe Co\'s thread', await api(m, 'GET', `/api/treasury/${probe.publicKey}/thread`, { as: kip }));
        built('Cy lists his groups (his first read mark on the thread)', await api(m, 'GET', '/api/your-groups', { as: cy }));
        built('Kip posts in the thread', await S_(kip, `/api/treasury/${probe.publicKey}/thread/message`, { text: 'The bench vice is back' }));
        built('Kip marks it read', await S_(kip, '/api/messages/mark-read', { conversationId: probe.publicKey }));
        // An event three days out, Bo going, with a reminder a day before and one an hour before.
        const startMs = Date.now() + 3 * DAY;
        const event = built('Ann hosts an event', await S_(ann, '/api/marketplace/posts', {
            type: 'event', title: 'Street picnic', description: 'Bring a plate', authorPublicKey: ann.pk, lat: -28.55, lng: 153.5,
            eventStartAt: new Date(startMs).toISOString(), eventEndAt: new Date(startMs + 3 * 3600_000).toISOString(), eventPlaceName: 'The park',
        }));
        const eventId = (event.post?.id ?? event.id) as string;
        built('Bo is going', await S_(bo, `/api/marketplace/posts/${eventId}/rsvp`, { status: 'going' }));
        built('and wants reminders a day and an hour before', await S_(bo, `/api/events/${eventId}/reminder`, { offsets: [1440, 60] }, 'PUT'));
        const dayBefore = startMs - 1440 * MIN + MIN;
        const hourBefore = startMs - 60 * MIN + MIN;
        await main.send('pushes');
        const reminded = await main.send('tick-reminders', { asOf: dayBefore });
        require_(reminded.claimed === 1 && reminded.pushes.length === 2 && reminded.pushes.every((p: Push) => p.to.includes('bo-')),
            `M: the day-before reminder goes to Bo's two phones (${JSON.stringify(reminded)})`);
        // Listings, a deal, and a line from 40 days ago that the hourly prune takes.
        const offer = async (who: Id, title: string, credits: number) => built(`${who.name} offers ${title}`, await S_(who, '/api/marketplace/posts', {
            type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits, priceType: 'fixed', authorPublicKey: who.pk,
        })).post;
        built('the admin makes Gwen an Elder (credit to buy with)', await A('POST', `/api/local/admin/users/${gwen.pk}/elder`, { grant: true }));
        await offer(gwen, 'Sourdough loaf', 4);
        const tuneUp = await offer(kip, 'Bike tune-up', 10);
        const tx = built('Gwen asks for Kip\'s tune-up', await S_(gwen, '/api/marketplace/posts/request', { postId: tuneUp.id, buyerPublicKey: gwen.pk })).transaction;
        built('Kip approves: the Beans are held', await S_(kip, '/api/marketplace/transactions/approve', { transactionId: tx.id, authorPublicKey: kip.pk }));
        built('Gwen confirms: the deal is done', await S_(gwen, '/api/marketplace/transactions/complete', { transactionId: tx.id, confirmerPublicKey: gwen.pk }));
        const oldLine = await main.send('old-activity-line', { actor: dee.pk, days: 40 });
        await main.send('prune-activity');
        // The pricing guide: the admin edits an item's price and pins another; Ann reports one, and the admin accepts it.
        const guide = await api(m, 'GET', '/api/pricing-guide', { as: ann });
        const [edited, pinned] = (guide.body?.items ?? []) as any[];
        require_(!!edited && !!pinned, `M: the pricing guide, seeded at boot (${guide.body?.items?.length} items)`);
        built(`the admin edits ${edited.name}'s price`, await A('POST', '/api/pricing-guide/admin/item', { ...edited, priceBeans: edited.priceBeans + 7 }));
        built(`and pins ${pinned.name}`, await A('POST', '/api/pricing-guide/admin/pin', { id: pinned.id, isPinned: true }));
        const report = built(`Ann says ${edited.name} is too high`, await S_(ann, '/api/pricing-guide/report', { itemId: edited.id, reportType: 'too_high', comment: 'Half that at the market' }));
        built('the admin accepts the report', await A('POST', `/api/pricing-guide/reports/${report.reportId}/status`, { status: 'accepted' }));
        const priced = await main.send('pricing-cycle');
        const m1 = await main.send('rows');
        assert(m1.tables.push_tokens.length === 7 && has(m1.tables, 'push_tokens', { public_key: cy.pk, token: SHARED }) && has(m1.tables, 'push_tokens', { public_key: dee.pk, token: SHARED })
            && !has(m1.tables, 'push_tokens', { public_key: kip.pk, token: token('kip-1') }) && m1.tables.push_token_leaves.length === 1,
            `M: seven phones (the shared one under both keys), Kip's first gone by his leave, which is kept (${count(m1.tables)})`);
        assert(m1.tables.activity_feed.length > 0 && !m1.tables.activity_feed.some((r: any) => r.id === oldLine)
            && m1.tombstones.some((t: any) => t.table_name === 'activity_feed' && t.row_key === String(oldLine)),
            `M: the month-old activity line is pruned, with a tombstone (${JSON.stringify(priced)})`);

        // ── 2. S's first copy ──
        console.log('\n— 2. the standby, its clock an hour ahead, takes its first copy —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        const bootRows = await standby.send('rows');
        assert(bootRows.tables.pricing_guide_items.length === 0, `S seeds no pricing guide of its own at boot (${bootRows.tables.pricing_guide_items.length} items)`);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const skewed = await standby.send('skew-clock', { aheadMs: AHEAD_MS });
        require_(Date.parse(skewed) - Date.now() > AHEAD_MS - 60_000, `S: its SQLite clock reads an hour ahead (${skewed})`);
        const firstPull = await standby.send('pull', {});
        require_(firstPull.ok === true, `S: the loop's first pull lands (${firstPull.ok ? firstPull.mode : firstPull.error})`);
        let s = await standby.send('rows');
        assert(tablesDiff(m1.tables, s.tables).length === 0, `every G4 table is M's, row for row and stamp for stamp (${count(s.tables)}; differences ${first(tablesDiff(m1.tables, s.tables))})`);
        assert(s.format === FORMAT, `and its copy is one this importer made, format ${FORMAT} (${s.format})`);

        // ── 3. More on M, then a delta ──
        console.log('\n— 3. an unmute, a re-key, a leave, a pricing item made and deleted; then a delta —');
        built('Ann unmutes her chat with Cy', await mute(ann, chatAC, 'off'));
        const code = built('the admin issues Ann a re-key code', await A('POST', `/api/local/admin/members/${ann.pk}/rekey/issue-code`, {}));
        const rekeyCode = (code.code ?? code.request?.code ?? code.rekeyCode) as string;
        built('and her new phone takes over her account', await A('POST', `/api/local/admin/members/${ann.pk}/rekey/complete`, { code: rekeyCode, newPubkey: ann2.pk }));
        built('Ann registers her phone again, under her new key', await phone(ann2, token('ann'), 1100));
        built('Bo leaves his second phone', await S_(bo, '/api/push-tokens', { publicKey: bo.pk, token: token('bo-2'), leftAt: 2200 }, 'DELETE'));
        built('Kip signs back in on his first phone, after his leave', await phone(kip, token('kip-1'), 9000));
        const custom = built('the admin adds a pricing item', await A('POST', '/api/pricing-guide/admin/item', { category: edited.category, emoji: '🧺', name: 'Picnic basket', description: 'Wicker', priceBeans: 6 }));
        built('and deletes it again', await A('DELETE', `/api/pricing-guide/admin/item/${custom.item.id}`));
        await offer(bo, 'Honey', 5);
        const m3 = await main.send('rows');
        assert(!has(m3.tables, 'chat_mutes', { conversation_id: chatAC }) && has(m3.tables, 'chat_mutes', { conversation_id: chatAB, member_pubkey: ann2.pk })
            && !has(m3.tables, 'push_tokens', { public_key: ann.pk }) && has(m3.tables, 'push_tokens', { public_key: ann2.pk, token: token('ann') })
            && has(m3.tables, 'push_tokens', { public_key: kip.pk, token: token('kip-1'), registered_at: 9000 }) && !has(m3.tables, 'push_tokens', { public_key: bo.pk, token: token('bo-2') }),
            'M: Ann\'s mute of her chat with Bo is her new key\'s, the other gone; her old key\'s phone gone and her new one\'s there; Kip back on his first phone; Bo\'s second gone');
        const delta = await standby.send('pull', {});
        require_(delta.ok === true && delta.mode === 'delta', `S: a delta (${delta.ok ? delta.mode : delta.error})`);
        s = await standby.send('rows');
        assert(tablesDiff(m3.tables, s.tables).length === 0,
            `every G4 table is M's again: the unmute before the re-key, the re-key, the leave and the deleted item included (${count(s.tables)}; differences ${first(tablesDiff(m3.tables, s.tables))})`);
        assert(has(s.tables, 'push_tokens', { public_key: kip.pk, token: token('kip-1'), registered_at: 9000 }),
            'Kip\'s first phone, registered again after his leave\'s tombstone, stays on S: the row is stamped after it');
        const ids: Record<string, string> = {
            gwen: gwen.pk, ann2: ann2.pk, bo: bo.pk, cy: cy.pk, dee: dee.pk, kip: kip.pk, probe: probe.publicKey, chatAB, chatAC,
            sharedToken: SHARED, itemEdited: edited.id, report: report.reportId, post: tuneUp.id, remindAt: String(hourBefore),
        };

        // ── 4. On S, nothing of these is written ──
        console.log('\n— 4. the standby writes none of it itself —');
        const sv = `https://localhost:${await standby.send('serve')}`;
        const onS = (method: Method, route: string, who: Id | null, body: unknown = {}) => api(sv, method, route, who ? { as: who, body } : { admin: PW_STANDBY, body });
        const routes: [string, Promise<Answer>][] = [
            ['a phone registered', onS('POST', '/api/push-tokens', cy, { publicKey: cy.pk, token: token('on-standby'), registeredAt: 9_000_000 })],
            ['a phone removed', onS('DELETE', '/api/push-tokens', cy, { publicKey: cy.pk, token: SHARED })],
            ['a leave statement', api(sv, 'POST', `/api/push-tokens/leave/${cy.pk}`, { body: { token: SHARED, leftAt: 9_000_000, signature: 'x', signedFor: 'x' } })],
            ['a chat muted', onS('POST', '/api/messages/mute', bo, { conversationId: chatAB, duration: 'always' })],
            ['a keeper\'s read mark', onS('POST', '/api/messages/mark-read', kip, { conversationId: probe.publicKey })],
            ['a price report', onS('POST', '/api/pricing-guide/report', bo, { itemId: edited.id, reportType: 'too_low' })],
            ['a report\'s answer', onS('POST', `/api/pricing-guide/reports/${report.reportId}/status`, null, { status: 'dismissed' })],
            ['a pricing item saved', onS('POST', '/api/pricing-guide/admin/item', null, { category: edited.category, emoji: '🥕', name: 'Carrots', priceBeans: 2 })],
            ['a pricing item deleted', onS('DELETE', `/api/pricing-guide/admin/item/${edited.id}`, null)],
            ['a pricing item pinned', onS('POST', '/api/pricing-guide/admin/pin', null, { id: edited.id, isPinned: false })],
            ['the pricing guide reset', onS('POST', '/api/pricing-guide/admin/reset', null)],
            ['a pricing cycle', onS('POST', '/api/pricing-guide/admin/aggregate', null)],
        ];
        for (const [what, call] of routes) {
            const r = await call;
            assert(r.status === 409 && r.body?.code === 'standby', `S refuses ${what} with 409 standby (${brief(r)})`);
        }
        const writers = await standby.send('call-writers', { ids });
        const wrote = Object.entries(writers.answers as Record<string, string>).filter(([, v]) => v !== 'standby');
        assert(wrote.length === 0, `every writer of these tables refuses on S before it writes (${wrote.length ? wrote.map(([k, v]) => `${k}: ${v}`).join('; ') : `${Object.keys(writers.answers).length} refused`})`);
        const sideThrew = Object.entries(writers.sideWrites as Record<string, string>).filter(([, v]) => v.startsWith('threw'));
        assert(sideThrew.length === 0, `a read's, a listing's and the timers' writes on the side answer on S, writing nothing (${JSON.stringify(writers.sideWrites)})`);
        assert(writers.changed.length === 0, `and S's G4 tables are exactly as before (changed: ${writers.changed.join(', ') || 'none'})`);

        // ── 5. A plain value S's table refuses ──
        console.log('\n— 5. a whole copy with a row and values S refuses is not exact, and asks for no force-resync —');
        require_(await standby.send('strict-invites', { on: true, refuse: joinedWith.Bo }),
            'S: its invites table holds a used invite\'s taker, and the invite Bo joined with, to rules M\'s doesn\'t (an older standby\'s CHECK)');
        const before5 = await standby.send('record');
        const whole5 = await standby.send('pull', { whole: true });
        const record5 = await standby.send('record');
        const c5 = record5.consistency;
        assert(whole5.ok === true && whole5.whole === true && JSON.stringify(c5?.plainTablesLeftOut?.tables) === '["invite_codes"]' && c5.ok === false
            && c5.plainTablesLeftOut.count === 5 && c5.plainTablesLeftOut.examples.includes(`invite_codes:${joinedWith.Bo}`)
            && c5.tables.some((t: any) => t.name === 'invite_codes' && !t.match),
            `the whole copy lands; the row (Bo's invite, so a count short) and the values (four takers) left out are reported (${whole5.ok ? whole5.mode : whole5.error}; ${JSON.stringify(c5?.plainTablesLeftOut ?? null)})`);
        assert(before5.lastMismatchResyncAt === null && record5.lastWhole?.exact === false && record5.lastWhole.differs?.includes('invite_codes')
            && record5.lastWhole.resyncAsked === false && record5.lastMismatchResyncAt === null,
            `its record: not exact, invite_codes differing, and no force-resync asked (${JSON.stringify(record5.lastWhole)})`);
        const after5 = await standby.send('pull', {});
        assert(after5.ok === true && after5.mode === 'delta', `and its next pull is a delta, not a force-resync (${after5.ok ? after5.mode : after5.error})`);
        require_(!(await standby.send('strict-invites', { on: false })), 'S: its invites table has its own rule back');
        const whole5b = await standby.send('pull', { whole: true });
        const record5b = await standby.send('record');
        assert(whole5b.ok === true && record5b.lastWhole?.exact === true && !record5b.consistency?.plainTablesLeftOut,
            `the next whole copy is exact again (${JSON.stringify(record5b.lastWhole)})`);

        // ── 6. S sends no push ──
        console.log('\n— 6. the standby sends no push, by any sender —');
        const everyone = [gwen, ann2, bo, cy, dee, kip].map((w) => w.pk);
        const senders = await standby.send('push-senders', { ids, everyone });
        const sent = Object.entries(senders.answers as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && v > 0);
        assert(senders.handed.length === 0 && sent.length === 0,
            `the dispatcher for each category, the escrow and announcement senders and the timers hand nothing to the push service on S (${JSON.stringify(senders.answers)}; handed ${senders.handed.length})`);
        const chatOnS = await api(sv, 'POST', '/api/messages/send', { as: cy, body: {
            conversationId: chatAC, authorPubkey: cy.pk, ciphertext: Buffer.from('on a standby').toString('base64'), nonce: crypto.randomBytes(24).toString('base64'),
        } });
        const threadOnS = await api(sv, 'POST', `/api/treasury/${probe.publicKey}/thread/message`, { as: kip, body: { text: 'On a standby' } });
        const announceOnS = await api(sv, 'POST', '/api/local/admin/announcements', { admin: PW_STANDBY, body: { title: 'On a standby', body: 'Never sent' } });
        await sleep(200);
        const httpPushes = await standby.send('pushes');
        assert(httpPushes.length === 0, `a chat message, an enterprise thread post and an announcement over HTTPS push nothing from S (${chatOnS.status}, ${threadOnS.status}, ${announceOnS.status}; ${httpPushes.length} pushes)`);
        const calls = sourceMentions(/exp\.host/);
        assert(calls.length === 1 && calls[0].startsWith('state-engine.ts:'),
            `the only call of the push service in the server's source is the dispatcher's, which every sender comes through (${calls.join(', ')})`);
        const serving = sourceMentions(/\bexportSyncState\(/).filter((at) => at.startsWith('routes/'));
        assert(serving.length > 0 && serving.every((at) => at.startsWith('routes/backup.ts:')), `only the backup routes serve the copy with the phones (${serving.join(', ')})`);
        for (const route of ['/api/local/admin/sync-snapshot', '/api/local/admin/sync-delta']) {
            const none = await api(m, 'GET', route);
            const member = await api(m, 'GET', route, { as: cy });
            assert(none.status === 401 && member.status === 401 && !JSON.stringify(member.body).includes(SHARED),
                `M serves ${route} to nobody without the replication token or its admin password, a member's signature included (${none.status}, ${member.status})`);
        }
        refused.push(...(await standby.send('fetches')).blocked);
        await standby.kill('SIGTERM');

        // ── 7. A format 5 standby re-seeds once ──
        console.log('\n— 7. a standby from before this format re-seeds itself once —');
        withDb(dir('standby'), (db) => {
            db.pragma('foreign_keys = OFF');
            db.prepare(`INSERT INTO pricing_guide_items (id, category, emoji, name, description, price_beans, updated_at)
                        VALUES ('standby-own', 'food', '🍎', 'Its own apples', '', 1, ?)`).run(new Date().toISOString());
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('replica_format', ?)`).run(FORMAT_BEFORE);
        });
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        const planted = await standby.send('rows');
        require_(planted.format === FORMAT_BEFORE && has(planted.tables, 'pricing_guide_items', { id: 'standby-own' }), `S: format ${FORMAT_BEFORE}, with a pricing item of its own`);
        const reseed = await standby.send('pull', {});
        const m7 = await main.send('rows');
        s = await standby.send('rows');
        assert(reseed.ok === true && reseed.mode === 'resync' && s.format === FORMAT, `its next pull re-seeds it, once, to format ${FORMAT} (${reseed.ok ? reseed.mode : reseed.error}; format ${s.format})`);
        assert(!has(s.tables, 'pricing_guide_items', { id: 'standby-own' }) && tablesDiff(m7.tables, s.tables).length === 0,
            `its own item is gone, and every G4 table is M's (differences ${first(tablesDiff(m7.tables, s.tables))})`);

        // ── 8. The take-over ──
        console.log('\n— 8. M dies; S takes over with the recovery code; the promoted server carries it all on —');
        const last = await standby.send('pull', {});
        require_(last.ok === true && last.envelope !== undefined, `S: a last pull, and the take-over envelope (${last.ok ? last.mode : last.error})`);
        const onMain = await main.send('rows');
        s = await standby.send('rows');
        require_(tablesDiff(onMain.tables, s.tables).length === 0, `S holds M's G4 tables at its last copy (differences ${first(tablesDiff(onMain.tables, s.tables))})`);
        const mainCounts = await main.send('push-counts');
        const mainFeed = await api(m, 'GET', '/api/activity/feed', { as: bo });
        const mainGuide = await api(m, 'GET', '/api/pricing-guide', { as: bo });
        const mainGroups = await main.send('your-groups', { keepers: [cy.pk, kip.pk] });
        const mainLastLine = await main.send('last-activity-id');
        require_(Object.values(mainCounts.counts as Record<string, number>).every((n) => n > 0) && mainFeed.status === 200 && mainGuide.status === 200,
            `M: a push of each category reaches phones (${JSON.stringify(mainCounts.counts)}), and its activity list and pricing guide answer`);
        refused.push(...(await main.send('fetches')).blocked);
        await main.send('checkpoint');
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
        require_(opened.status === 200 && opened.body.success, `the code opens the keys (${opened.status} ${JSON.stringify(opened.body).slice(0, 160)})`);
        const missing: string[] = opened.body.preview.missing ?? [];
        assert(!missing.some((line) => /notifications on|muted chats|activity list|pricing guide/.test(line)) && missing.some((line) => /photos sent in chats/.test(line)),
            `the preview no longer says phones or members' conveniences will be missing, and still names chat photos (${JSON.stringify(missing).slice(0, 200)})`);
        refused.push(...(await standby.send('fetches')).blocked);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        require_(confirmed.status === 200, `confirm (${confirmed.status})`);
        require_(await standby.exited === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(standby.ready.role === 'primary' && standby.ready.peerId === main.ready.peerId, `promoted, with M's PeerId (${standby.ready.role})`);
        const p = `https://localhost:${await standby.send('serve')}`;
        const P_ = (who: Id, route: string, body: unknown = {}, method: Method = 'POST') => api(p, method, route, { as: who, body });
        let pr = await standby.send('rows');
        assert(tablesDiff(onMain.tables, pr.tables).length === 0, `the promoted server's G4 tables are M's, every row and stamp (differences ${first(tablesDiff(onMain.tables, pr.tables))})`);

        // Phones.
        const promotedCounts = await standby.send('push-counts');
        assert(JSON.stringify(promotedCounts.counts) === JSON.stringify(mainCounts.counts) && promotedCounts.handed === mainCounts.handed,
            `a push of each category reaches exactly the phones M's did (${JSON.stringify(promotedCounts.counts)}; M ${JSON.stringify(mainCounts.counts)})`);
        const lateAgain = await phone2(p, kip, token('kip-1'), 5500);
        assert(lateAgain.status === 409 && lateAgain.body?.code === 'push_token_left',
            `the leave M applied refuses, on the promoted server, a registration Kip's phone sent before it (${brief(lateAgain)})`);
        const kipLeavesAgain = await P_(kip, '/api/push-tokens', { publicKey: kip.pk, token: token('kip-2'), leftAt: 7000 }, 'DELETE');
        pr = await standby.send('rows');
        assert(kipLeavesAgain.status === 200 && has(pr.tables, 'push_tokens', { public_key: kip.pk, token: token('kip-2'), registered_at: 8000 }),
            `a leave stamped before Kip's second phone registered removes nothing there: its stamp is M's (${brief(kipLeavesAgain)})`);
        const deeLeaves = await P_(dee, '/api/push-tokens', { publicKey: dee.pk, token: SHARED, leftAt: 3600 }, 'DELETE');
        pr = await standby.send('rows');
        assert(deeLeaves.status === 200 && !has(pr.tables, 'push_tokens', { public_key: dee.pk, token: SHARED }) && has(pr.tables, 'push_tokens', { public_key: cy.pk, token: SHARED })
            && pr.tables.push_tokens.length === onMain.tables.push_tokens.length - 1,
            `Dee's leave of the shared phone removes exactly her row: Cy's for it, and every other, stay (#1184) (${brief(deeLeaves)})`);
        const cyAgain = await phone2(p, cy, SHARED, 3700);
        pr = await standby.send('rows');
        assert(cyAgain.status === 200 && has(pr.tables, 'push_tokens', { public_key: cy.pk, token: SHARED, registered_at: 3700 }),
            `Cy's phone registers again on the promoted server, as on M (${brief(cyAgain)})`);

        // Mutes.
        await standby.send('pushes');
        built('Bo writes to Ann, who muted their chat', await api(p, 'POST', '/api/messages/send', { as: bo, body: {
            conversationId: chatAB, authorPubkey: bo.pk, ciphertext: Buffer.from('lunch?').toString('base64'), nonce: crypto.randomBytes(24).toString('base64'),
        } }));
        built('Cy writes to Ann, who unmuted theirs', await api(p, 'POST', '/api/messages/send', { as: cy, body: {
            conversationId: chatAC, authorPubkey: cy.pk, ciphertext: Buffer.from('tools?').toString('base64'), nonce: crypto.randomBytes(24).toString('base64'),
        } }));
        await sleep(200);
        const chatPushes: Push[] = await standby.send('pushes');
        const toAnn = chatPushes.filter((x) => x.to === token('ann'));
        assert(toAnn.length === 1, `Ann's phone hears Cy's message and not Bo's: her mute holds on the promoted server (${JSON.stringify(chatPushes.map((x) => x.to))})`);

        // Read marks, the activity list, the pricing guide.
        const groupsHere = await standby.send('your-groups', { keepers: [cy.pk, kip.pk] });
        assert(JSON.stringify(groupsHere) === JSON.stringify(mainGroups), `the keepers' unread counts are M's (${JSON.stringify(groupsHere).slice(0, 200)})`);
        const feedHere = await api(p, 'GET', '/api/activity/feed', { as: bo });
        assert(feedHere.status === 200 && JSON.stringify(feedHere.body) === JSON.stringify(mainFeed.body),
            `the activity list answers as M's did (${feedHere.status}, ${Array.isArray(feedHere.body?.items ?? feedHere.body?.feed ?? feedHere.body) ? 'a list' : JSON.stringify(feedHere.body).slice(0, 80)})`);
        const guideHere = await api(p, 'GET', '/api/pricing-guide', { as: bo });
        assert(guideHere.status === 200 && JSON.stringify(guideHere.body) === JSON.stringify(mainGuide.body),
            `the pricing guide answers as M's did: the admin's edit, the pin and the prices M worked out (${guideHere.status})`);
        await offer2(p, gwen, 'Plum jam', 3);
        const lineHere = await standby.send('last-activity-id');
        assert(typeof mainLastLine === 'number' && lineHere === mainLastLine + 1, `the next activity line is numbered after M's last (${mainLastLine} → ${lineHere})`);

        // Reminders.
        const again = await standby.send('tick-reminders', { asOf: dayBefore });
        assert(again.claimed === 0 && again.pushes.length === 0, `the day-before reminder M sent is not sent again (${JSON.stringify(again)})`);
        const next = await standby.send('tick-reminders', { asOf: hourBefore });
        const nextAgain = await standby.send('tick-reminders', { asOf: hourBefore + MIN });
        assert(next.claimed === 1 && next.pushes.length === 1 && next.pushes[0].to === token('bo-1') && nextAgain.claimed === 0 && nextAgain.pushes.length === 0,
            `the hour-before one is sent once, to Bo's phone that is still his (${JSON.stringify(next)}; then ${JSON.stringify(nextAgain)})`);

        refused.push(...(await standby.send('fetches')).blocked);
        assert(refused.length === 0, `nothing reached off this machine (refused: ${refused.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ Members\' devices and conveniences are the main server\'s on a standby, and a promoted one carries them on.');
}

/** A phone's registration on the server at `base`. */
function phone2(base: string, who: Id, t: string, registeredAt: number): Promise<Answer> {
    return api(base, 'POST', '/api/push-tokens', { as: who, body: { publicKey: who.pk, token: t, platform: 'android', registeredAt } });
}

/** An offer on the server at `base`. */
async function offer2(base: string, who: Id, title: string, credits: number): Promise<void> {
    const r = await api(base, 'POST', '/api/marketplace/posts', { as: who, body: {
        type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits, priceType: 'fixed', authorPublicKey: who.pk,
    } });
    require_(r.status >= 200 && r.status < 300, `the promoted server: ${who.name} offers ${title} (${brief(r)})`);
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
