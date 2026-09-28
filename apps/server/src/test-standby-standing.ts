/**
 * Test Suite: a member's and an enterprise's standing replicate, and a promoted standby holds them as its main server did
 * (G2a, G2b and G2c of scratch/global-node/DESIGN-standby-takeover-gaps-opus.md; §5.3's G2 suite).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; members
 * act through it with signed requests, the admin with the password. The standby pulls through its real puller
 * (services/backup-puller.ts `pullNow`, the loop's own step) from the main server's real backup routes, and takes over
 * with the recovery code through the real path. Nothing leaves this machine.
 *
 * The standby's clock runs an hour ahead of the main server's until the take-over (SQLite's `strftime('now')`, which every
 * stamp in the schema is written with): a stamp of its own on a copied row, a touch trigger's, shows as a difference.
 *
 *  1. The main server M: an enterprise, Probe Co, with a purpose, a map pin, a working capital ceiling, two keepers who
 *     each pledge backing, an external sale (earned surplus) and a legacy credit floor; a project with a goal and a
 *     deadline; Elders (granted credit), an appointed voucher and two members he vouched for (at 50 and 25), a frozen
 *     Elder, a member on holiday and one with a notification opt-out and a reminder default. A preference save moves the
 *     member's row, as holiday does.
 *  2. The standby S's first copy: every members column (but last_active_at), every preference, keeper and pledge is M's,
 *     stamps included; the copy records the importer's format.
 *  3. Between two pulls, on M: the vouch at 25 withdrawn, a keeper unbound, a pledge released, the enterprise paused, its
 *     ceiling changed by the admin (a write of that column alone), another opt-out. A delta brings every one.
 *  4. A whole copy leaves every row and stamp as M's, and puts back the members touch triggers the import set aside.
 *  5. A keeper who is also a pledger, and a pledger no longer a keeper, are re-keyed between two pulls: the standby follows
 *     both re-keys and the whole set of keepers together, and ends equal to M.
 *  6. A standby as the old importer left it (no standing, no preferences, keepers or pledges, the withdrawn vouch kept,
 *     format 3) re-seeds itself with its next pull, once, and ends equal to M; the pull after is a delta.
 *  7. A standby writes no pledge of its own (#1276 review 4118882837): on S, a keeper's release (by every alias), a new
 *     pledge, a step-down and an admin's unbind that would settle a pledge each answer 409 standby, and its engine refuses
 *     a pledge and a release under the routes; nothing is written. A pledge S holds that M doesn't (as its own release
 *     route wrote one before it refused) is counted by the whole-copy check, and a whole copy deletes it: Probe Co's
 *     floor, allowance and backing on S are M's again (before, it stayed through every copy and a take-over).
 *  8. A value the standby's own table refuses (#1276 review 4118882942). M's members table is a community's from before
 *     the enterprise unification (Slice 3's columns came from ALTERs, with no CHECK); S's is a fresh install's. M refuses a
 *     goal below 0 now, and holds one as an older build wrote it. The running S's delta and whole copy land, the goal
 *     left out (S keeps its own), a listing made after it arrives, and the whole-copy check reports the value; a fresh
 *     standby's first copy lands with the goal at its default, and so do its next pulls (before, every copy was refused
 *     on the CHECK, and a fresh standby held no member). Neither copy is exact, and neither asks for a force-resync (one
 *     would leave the same value out; #1274's content check read the goal as members differing and asked for one): the
 *     next pull is a delta. A members row that differs anywhere else still asks for the force-resync. A standby cleans
 *     none of its rows at boot. M, booted on this
 *     build as if for the first time (its marker gone), brings the goal into the schema's rules once: the column's
 *     default, the row stamped, nothing else changed.
 *  9. M dies; S takes over with the recovery code. On the promoted S: every floor and granted credit is M's (the withdrawn
 *     vouch gives no credit back, the frozen Elder stays at 0); the enterprise's page answers for its keeper, paused; the
 *     board is M's (the paused enterprise's listing and the holiday member's stay off); the holiday member can't be traded
 *     with; the enterprises pay no demurrage; the opt-outs hold; the appointed voucher vouches; the enterprise is on the
 *     map; its lead resumes it and a re-keyed keeper posts for it.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-standing.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, post, copyDir, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Standing-Main-Pw-7314!';
const PW_STANDBY = 'Standing-Standby-Pw-2208!';
const AHEAD_MS = 3600_000;
/** The importer format this change's copy records (engine/sync.ts REPLICA_FORMAT). */
const FORMAT = '4';

// ── The node processes' commands ───────────────────────────────────────────────────────────

/**
 * No node reaches anything but this machine: a push to Expo is answered here, and so is the update check's ask of GitHub
 * for the latest release (routes/settings.ts, 30 s after a node serves, as test-standby-ledger-copy answers it);
 * anything else is refused and counted.
 */
function guardFetch(): { blocked: string[] } {
    const seen = { blocked: [] as string[] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.hostname === 'api.github.com' && url.pathname.startsWith('/repos/beanpool-org/beanpool/')) return new Response('{}', { status: 404 });
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
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        /**
         * This server's SQLite clock `aheadMs` ahead: `strftime(…, 'now')`, which every stamp in the schema is written with
         * (column defaults, touch triggers). Any other time it is asked for is SQLite's own, from a connection of its own.
         */
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
        /**
         * Standing as this server holds it: every members column but `last_active_at` (it moves on every signed request and
         * travels only with another change of the row, by design), each member's preferences, the keepers and the pledges;
         * and the copy's format and the members touch triggers.
         */
        rows: async () => {
            const { db } = await import('./db/db.js');
            const members = (db.prepare('SELECT * FROM members ORDER BY public_key').all() as Record<string, unknown>[])
                .map(({ last_active_at: _l, ...rest }) => rest);
            return {
                members,
                member_preferences: db.prepare('SELECT * FROM member_preferences ORDER BY public_key, pref_key').all(),
                treasury_operators: db.prepare('SELECT * FROM treasury_operators ORDER BY treasury_pubkey, member_pubkey').all(),
                enterprise_pledges: db.prepare('SELECT * FROM enterprise_pledges ORDER BY id').all(),
                format: (db.prepare(`SELECT value FROM node_config WHERE key = 'replica_format'`).get() as { value: string } | undefined)?.value ?? null,
                touch: (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'members_touch_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name),
            };
        },
        /** An enterprise's grandfathered credit floor, as the Slice 4 migration wrote it on a node older than it (db.ts). */
        'legacy-floor': async (a: { pk: string; floor: number }) => {
            const { db } = await import('./db/db.js');
            const { clearEnterpriseFloorCache } = await import('./state-engine.js');
            db.prepare('UPDATE members SET legacy_credit_floor = ? WHERE public_key = ?').run(a.floor, a.pk);
            clearEnterpriseFloorCache(a.pk);
            return true;
        },
        rekey: async (a: { oldPk: string; newPk: string; operator: string }) => {
            const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
            const { code } = issueRekeyCode(a.oldPk, a.operator);
            return completeRekey(a.oldPk, a.newPk, code, a.operator).success;
        },
        /** Which of `keys` the in-memory ledger holds exempt from demurrage (state-engine.ts registers them at boot). */
        exempt: async (a: { keys: string[] }) => {
            const { ledger } = await import('./engine/ledger.js');
            const set = (ledger as unknown as { decayExemptIds: Set<string> }).decayExemptIds;
            return a.keys.filter((k) => set.has(k));
        },
        /**
         * The wash-trading analysis every floor reads is kept for 10 s (engine trust.ts getWashTradingEnforcement): cleared,
         * so the floors read next are this database's now, not an analysis made mid-scenario.
         */
        'fresh-trust': async () => {
            const { db } = await import('./db/db.js');
            const { clearWashTradingCache } = await import('@beanpool/engine');
            clearWashTradingCache(db as any);
            return true;
        },
        /** Whom a push of each category reaches among members with a phone (state-engine.ts pushableMembers). */
        pushable: async () => {
            const { pushableMembers } = await import('./state-engine.js');
            return Object.fromEntries((['chat', 'marketplace', 'escrow', 'recovery'] as const).map((c) => [c, [...pushableMembers(c)].sort()]));
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        /** A pledge or a release asked of the engine itself, under the routes (state-engine.ts). */
        'engine-pledge': async (a: { kind: 'pledge' | 'release'; enterprise: string; keeper: string; amount: number }) => {
            const se = await import('./state-engine.js');
            try {
                if (a.kind === 'pledge') se.pledgeEnterpriseBacking(a.enterprise, a.keeper, a.amount);
                else se.releaseEnterpriseBacking(a.enterprise, a.keeper, a.amount);
                return { ok: true };
            } catch (e: any) {
                return { ok: false, code: e?.code ?? null, error: e?.message || String(e) };
            }
        },
        /**
         * A pledge of this server's own, as a keeper's release on a standby's route wrote one before its pledge writers
         * refused there: a partial release pledges the rest again under a new id, which no copy names.
         */
        'plant-pledge': async (a: { keeper: string; enterprise: string; amount: number }) => {
            const { db } = await import('./db/db.js');
            const { clearEnterpriseFloorCache } = await import('./state-engine.js');
            db.prepare(`INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
                        VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)`).run(crypto.randomUUID(), a.keeper, a.enterprise, a.amount);
            clearEnterpriseFloorCache(a.enterprise);
            return true;
        },
        /** The whole-copy check's counts on M's current whole copy, fetched with the replication token and not imported. */
        'check-copy': async () => {
            const { getLocalConfig } = await import('./config/local-config.js');
            const { getReplicaConsistency } = await import('./state-engine.js');
            const c = getLocalConfig();
            const res = await fetch(`${c.backupPrimaryUrl}/api/local/admin/sync-snapshot`, { headers: { 'X-Replication-Token': c.backupReplicationToken! } });
            return getReplicaConsistency(await res.json());
        },
        /** What the last whole-copy check after a pull found (services/backup-puller.ts checkWholeCopy). */
        consistency: async () => {
            const { getBackupStatus } = await import('./services/backup-puller.js');
            return getBackupStatus().consistency ?? null;
        },
        /** This standby's record of its copies: its last whole copy's verdict, and when it last asked for a force-resync. */
        record: async () => {
            const { readCopyRecord } = await import('./services/standby-copy-record.js');
            const r = readCopyRecord();
            return { lastWhole: r.lastWhole, lastMismatchResyncAt: r.lastMismatchResyncAt };
        },
        /** A member's bio changed on this server alone, as nothing a copy sends. */
        'plant-bio': async (a: { pk: string; bio: string }) => {
            const { db } = await import('./db/db.js');
            return db.prepare('UPDATE members SET bio = ? WHERE public_key = ?').run(a.bio, a.pk).changes === 1;
        },
        /**
         * The whole-copy check itself (services/backup-puller.ts checkWholeCopy) on M's current whole copy, fetched with the
         * replication token and not imported, with the values `leftOut` named as an import that left them out would.
         */
        'check-whole': async (a: { leftOut: { publicKey: string; column: string }[] }) => {
            const { getLocalConfig } = await import('./config/local-config.js');
            const { checkWholeCopy } = await import('./services/backup-puller.js');
            const { readCopyRecord } = await import('./services/standby-copy-record.js');
            const c = getLocalConfig();
            const res = await fetch(`${c.backupPrimaryUrl}/api/local/admin/sync-snapshot`, { headers: { 'X-Replication-Token': c.backupReplicationToken! } });
            const payload = await res.json();
            const consistency = checkWholeCopy(payload, a.leftOut);
            return { hashes: !!payload?.tableHashes, consistency, lastWhole: readCopyRecord().lastWhole };
        },
        /** Whether this database's members.goal_amount has the fresh schema's CHECK (an ALTER'd column has none). */
        'goal-rule': async () => {
            const { db } = await import('./db/db.js');
            const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'members'`).get() as { sql: string }).sql;
            return /goal_amount IS NULL OR goal_amount >= 0/.test(sql);
        },
        /** A goal as an older build wrote it: POST /api/treasury passed Number(goalAmount) on unchecked. */
        'plant-goal': async (a: { pk: string; goal: number }) => {
            const { db } = await import('./db/db.js');
            return db.prepare('UPDATE members SET goal_amount = ? WHERE public_key = ?').run(a.goal, a.pk).changes === 1;
        },
        /** This node's record that its members rows keep the fresh schema's rules (db.ts bringMembersToSchemaRules). */
        marker: async () => {
            const { db } = await import('./db/db.js');
            return (db.prepare(`SELECT value FROM node_config WHERE key = 'migration_members_schema_rules_v1'`).get() as { value: string } | undefined)?.value ?? null;
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
async function api(base: string, method: 'GET' | 'POST' | 'DELETE', route: string, opts: { as?: Id; admin?: string; body?: unknown } = {}): Promise<Answer> {
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

type Rows = { members: any[]; member_preferences: any[]; treasury_operators: any[]; enterprise_pledges: any[]; format: string | null; touch: string[] };
const MEMBERS_TOUCH = ['members_touch_board_standing', 'members_touch_updated_at'];
const TABLE_KEYS: Record<Exclude<keyof Rows, 'format' | 'touch'>, string[]> = {
    members: ['public_key'], member_preferences: ['public_key', 'pref_key'],
    treasury_operators: ['treasury_pubkey', 'member_pubkey'], enterprise_pledges: ['id'],
};

/** Where S's rows differ from M's: each table row for row and column for column. */
function rowsDiff(m: Rows, s: Rows): string[] {
    const out: string[] = [];
    for (const [table, key] of Object.entries(TABLE_KEYS) as [Exclude<keyof Rows, 'format' | 'touch'>, string[]][]) {
        const k = (r: any) => key.map((c) => String(r[c]).slice(0, 12)).join('|');
        const ms = new Map(m[table].map((r) => [k(r), r]));
        const ss = new Map(s[table].map((r) => [k(r), r]));
        for (const [id, r] of ms) {
            const o = ss.get(id);
            if (!o) { out.push(`${table} ${id} missing`); continue; }
            for (const c of Object.keys(r)) {
                if (JSON.stringify(r[c]) !== JSON.stringify(o[c])) {
                    out.push(`${table} ${id}.${c}: main ${JSON.stringify(r[c])?.slice(0, 40)}, standby ${JSON.stringify(o[c])?.slice(0, 40)}`);
                }
            }
        }
        for (const id of ss.keys()) if (!ms.has(id)) out.push(`${table} ${id} extra`);
    }
    return out;
}
const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 6).join(' | ')}`);

/**
 * The members table of a community from before the enterprise unification: every column a fresh install's has but Slice 3's
 * five (purpose, goal_amount, deadline_at, lifecycle, paused), which db.ts then adds with ALTERs that carry no CHECK.
 */
function membersBeforeSlice3(): string {
    const schema = fs.readFileSync(path.join(path.dirname(SCRIPT), 'db', 'schema.sql'), 'utf-8');
    const create = /CREATE TABLE IF NOT EXISTS members \([\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    const lines = create.split('\n');
    const kept = lines.filter((l) => !/^\s*(purpose|goal_amount|deadline_at|lifecycle|paused)\s/.test(l));
    if (lines.length - kept.length !== 5) throw new Error(`schema.sql's members table: expected Slice 3's five columns, found ${lines.length - kept.length}`);
    return kept.join('\n');
}

/** A stopped node's database, written as the old importer left it. */
function withDb(dir: string, fn: (db: Database.Database) => void): void {
    const db = new Database(path.join(dir, 'state.db'));
    try { fn(db); } finally { db.close(); }
}

/** A member's balance answer, as it decides what they can do: the floor, the granted credit, the vouch; the balance to the cent. */
function standingOf(a: Answer): unknown {
    if (a.status !== 200) return a.status;
    const b = a.body ?? {};
    return {
        balance: typeof b.balance === 'number' ? Math.round(b.balance * 100) / 100 : b.balance, floor: b.floor, tier: b.tier?.name ?? b.tier,
        grantedCredit: b.grantedCredit, elderVouchedBy: b.elderVouchedBy, callsign: b.callsign,
    };
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee, kip, lou, eve, fay, hal] = ['Ann', 'Bo', 'Cy', 'Dee', 'Kip', 'Lou', 'Eve', 'Fay', 'Hal'].map(newId);
    const kip2 = newId('Kip');
    const dee2 = newId('Dee');
    const refused: string[] = [];

    try {
        // ── 1. M ──
        console.log('\n— 1. the main server: an enterprise with keepers and pledges, a project, trust, holiday, opt-outs —');
        // M's members table is that of a community running since before the enterprise unification: its Slice 3 columns
        // come from db.ts's ALTERs, with no CHECK (step 8).
        fs.mkdirSync(dir('main'), { recursive: true });
        withDb(dir('main'), (db) => db.exec(membersBeforeSlice3()));
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        const A = (route: string, body: unknown) => api(m, 'POST', route, { admin: PW_MAIN, body });
        const S_ = (who: Id, route: string, body: unknown = {}) => api(m, 'POST', route, { as: who, body });
        built('Gwen sets a profile photo', await S_(gwen, '/api/profile/update', { avatar: TINY_PNG }));
        for (const who of [ann, bo, cy, dee, kip, lou, eve, fay, hal]) {
            const inv = built(`Gwen makes an invite for ${who.name}`, await S_(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
            built(`${who.name} joins with it`, await api(m, 'POST', '/api/invite/redeem', { body: { code: inv.invite?.code ?? inv.code, publicKey: who.pk, callsign: who.name } }));
            built(`${who.name} sets a profile photo`, await S_(who, '/api/profile/update', { avatar: TINY_PNG }));
        }
        const offer = async (who: Id, title: string, credits: number) => built(`${who.name} offers ${title}`, await S_(who, '/api/marketplace/posts', {
            type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits, priceType: 'fixed', authorPublicKey: who.pk,
        })).post;
        const deal = async (buyer: Id, seller: Id, postId: string) => {
            const tx = built(`${buyer.name} asks for ${seller.name}'s listing`, await S_(buyer, '/api/marketplace/posts/request', { postId, buyerPublicKey: buyer.pk })).transaction;
            built(`${seller.name} approves: the Beans are held`, await S_(seller, '/api/marketplace/transactions/approve', { transactionId: tx.id, authorPublicKey: seller.pk }));
            built(`${buyer.name} confirms: the Beans are released`, await S_(buyer, '/api/marketplace/transactions/complete', { transactionId: tx.id, confirmerPublicKey: buyer.pk }));
            return tx.id as string;
        };
        for (const who of [gwen, cy, fay]) built(`the admin makes ${who.name} an Elder (granted credit)`, await A(`/api/local/admin/users/${who.pk}/elder`, { grant: true }));
        await offer(gwen, 'Sourdough', 4); // a buyer lists an offer first (the offer covenant)
        await offer(cy, 'Bike repair', 6);
        await deal(gwen, ann, (await offer(ann, 'Honey', 8)).id); // Ann has Beans to buy with
        await deal(cy, kip, (await offer(kip, 'Tune-up', 6)).id); // Kip has earned credit to pledge
        await deal(gwen, dee, (await offer(dee, 'Firewood', 6)).id); // and Dee
        const walking = await offer(hal, 'Dog walking', 2);
        const probe = built('Cy starts an enterprise, Probe Co, with a purpose, a map pin and a working capital ceiling', await S_(cy, '/api/treasury', {
            name: 'Probe Co', purpose: 'Repairs for the street', lat: -28.55, lng: 153.5, avatar: TINY_PNG, workingCapitalCeiling: 50,
        }));
        for (const who of [kip, dee]) built(`the admin makes ${who.name} a keeper of Probe Co`, await A(`/api/local/admin/treasury/${probe.publicKey}/operators`, { pubkey: who.pk }));
        built('Kip pledges backing to Probe Co', await S_(kip, `/api/treasury/${probe.publicKey}/pledge`, { type: 'backing', amount: 2 }));
        built('Dee pledges backing to Probe Co', await S_(dee, `/api/treasury/${probe.publicKey}/pledge`, { type: 'backing', amount: 1 }));
        require_(await main.send('legacy-floor', { pk: probe.publicKey, floor: 200 }), 'M: Probe Co keeps a legacy credit floor of 200 (an enterprise older than Slice 4)');
        const check = built('Cy lists an offer for Probe Co', await S_(cy, `/api/treasury/${probe.publicKey}/offer`, {
            title: 'Bike check', description: 'At the workshop', credits: 3, category: 'tools',
        }));
        const checkId = (check.post ?? check).id as string;
        const sale = built('Ann, no keeper, asks for it', await S_(ann, '/api/marketplace/posts/request', { postId: checkId, buyerPublicKey: ann.pk })).transaction;
        built('Cy approves it for Probe Co', await S_(cy, `/api/treasury/${probe.publicKey}/approve`, { transactionId: sale.id }));
        built('Ann confirms: an external sale, earned surplus for Probe Co', await S_(ann, '/api/marketplace/transactions/complete', { transactionId: sale.id, confirmerPublicKey: ann.pk }));
        const deadline = new Date(Date.now() + 30 * 86400_000).toISOString();
        const seed = built('Eve starts a project with a goal and a deadline', await S_(eve, '/api/treasury', {
            name: 'Seed Fund', purpose: 'A seed library', lifecycle: 'bounded', goalAmount: 100, deadlineAt: deadline,
        }));
        built('the admin makes Bo a voucher', await A(`/api/local/admin/users/${bo.pk}/voucher`, { grant: true }));
        built('Bo vouches for Eve at 50', await S_(bo, '/api/profile/vouch', { targetPubkey: eve.pk, level: 2 }));
        built('and for Lou at 25', await S_(bo, '/api/profile/vouch', { targetPubkey: lou.pk, level: 1 }));
        built('the admin freezes Fay\'s credit (an Elder: her floor goes to 0)', await A(`/api/local/admin/users/${fay.pk}/freeze`, { freeze: true }));
        built('Hal goes on holiday', await S_(hal, '/api/members/holiday', { enabled: true }));
        const annBefore = ((await main.send('rows')) as Rows).members.find((r) => r.public_key === ann.pk)?.updated_at;
        await sleep(5);
        built('Ann switches off marketplace pushes and sets her reminder default', await S_(ann, '/api/members/preferences', {
            publicKey: ann.pk, preferences: { notify_marketplace: false, eventReminderOffsets: [60] },
        }));
        const m1: Rows = await main.send('rows');
        const probeRow = m1.members.find((r) => r.public_key === probe.publicKey);
        require_(probeRow?.is_treasury === 1 && probeRow.earned_surplus > 0 && probeRow.legacy_credit_floor === 200 && probeRow.lat !== null
            && m1.treasury_operators.filter((o) => o.treasury_pubkey === probe.publicKey).length >= 3 && m1.enterprise_pledges.length >= 2,
            `M: Probe Co is an enterprise with earned surplus, a legacy floor, a pin, keepers and pledges (${JSON.stringify({ surplus: probeRow?.earned_surplus, legacy: probeRow?.legacy_credit_floor, keepers: m1.treasury_operators.length, pledges: m1.enterprise_pledges.length })})`);
        const annAfter = m1.members.find((r) => r.public_key === ann.pk)?.updated_at;
        assert(typeof annBefore === 'string' && typeof annAfter === 'string' && annAfter > annBefore,
            `M: a preference save moves the member's row, so a delta carries it (${annBefore} → ${annAfter})`);

        // ── 2. S's first copy ──
        console.log('\n— 2. the standby, its clock an hour ahead, takes its first copy —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const skewed = await standby.send('skew-clock', { aheadMs: AHEAD_MS });
        require_(Date.parse(skewed) - Date.now() > AHEAD_MS - 60_000, `S: its SQLite clock reads an hour ahead (${skewed})`);
        const firstPull = await standby.send('pull', {});
        require_(firstPull.ok === true, `S: the loop's first pull lands (${firstPull.ok ? firstPull.mode : firstPull.error})`);
        let s: Rows = await standby.send('rows');
        assert(rowsDiff(m1, s).length === 0, `its members, preferences, keepers and pledges are M's, every column and stamp (differences ${first(rowsDiff(m1, s))})`);
        assert(s.format === FORMAT, `the copy records the importer's format, ${FORMAT} (${s.format})`);
        assert(MEMBERS_TOUCH.every((t) => s.touch.includes(t)), `the members touch triggers are in place after the import (${s.touch.join(', ')})`);

        // ── 3. Changes between two pulls, then a delta ──
        console.log('\n— 3. between two pulls: a vouch withdrawn, a keeper unbound, a pledge released, a pause, a ceiling, an opt-out —');
        built('Bo withdraws his vouch for Lou, which the first copy copied', await S_(bo, '/api/profile/unvouch', { targetPubkey: lou.pk }));
        built('the admin unbinds Dee from Probe Co', await api(m, 'DELETE', `/api/local/admin/treasury/${probe.publicKey}/operators/${dee.pk}`, { admin: PW_MAIN }));
        built('Kip releases 1 of his 2 Beans of backing', await S_(kip, `/api/treasury/${probe.publicKey}/release`, { amount: 1 }));
        built('Cy pauses Probe Co', await S_(cy, `/api/treasury/${probe.publicKey}/pause`));
        built('the admin changes Probe Co\'s working capital ceiling (that column alone)', await A(`/api/local/admin/treasury/${probe.publicKey}/ceiling`, { ceiling: 80 }));
        built('Ann switches off chat pushes too', await S_(ann, '/api/members/preferences', { publicKey: ann.pk, preferences: { notify_chat: false } }));
        const m3: Rows = await main.send('rows');
        require_(m3.members.find((r) => r.public_key === lou.pk)?.elder_vouched_by === null
            && m3.members.find((r) => r.public_key === probe.publicKey)?.paused === 1
            && m3.members.find((r) => r.public_key === probe.publicKey)?.working_capital_ceiling === 80
            && !m3.treasury_operators.some((o) => o.member_pubkey === dee.pk)
            && m3.enterprise_pledges.some((p) => p.keeper === kip.pk && p.released_at !== null),
            'M: the vouch is gone, Probe Co is paused with its new ceiling, Dee is no keeper, and a pledge of Kip\'s is released');
        const delta = await standby.send('pull', {});
        s = await standby.send('rows');
        assert(delta.ok === true && delta.mode === 'delta', `the delta lands (${delta.ok ? delta.mode : delta.error})`);
        assert(s.members.find((r) => r.public_key === lou.pk)?.elder_vouched_by === null && s.members.find((r) => r.public_key === lou.pk)?.vouch_credit === 0,
            `the withdrawn vouch is gone on S too (${JSON.stringify(s.members.find((r) => r.public_key === lou.pk)?.elder_vouched_by)})`);
        assert(s.members.find((r) => r.public_key === probe.publicKey)?.working_capital_ceiling === 80, 'the ceiling the admin changed alone arrives');
        assert(!s.treasury_operators.some((o) => o.member_pubkey === dee.pk), 'the unbound keeper is no keeper on S');
        assert(rowsDiff(m3, s).length === 0, `every row and stamp is M's after the delta (differences ${first(rowsDiff(m3, s))})`);

        // ── 4. A whole copy ──
        console.log('\n— 4. a whole copy —');
        const whole = await standby.send('pull', { whole: true });
        const m4: Rows = await main.send('rows');
        s = await standby.send('rows');
        assert(whole.ok === true && whole.whole === true, `the whole copy lands (${whole.ok ? whole.mode : whole.error}; whole ${whole.whole})`);
        assert(rowsDiff(m4, s).length === 0, `every row and stamp is still M's (differences ${first(rowsDiff(m4, s))})`);
        assert(MEMBERS_TOUCH.every((t) => s.touch.includes(t)), `the members touch triggers are back (${s.touch.join(', ')})`);

        // ── 5. Re-keys between two pulls ──
        console.log('\n— 5. Kip (a keeper and a pledger) and Dee (a pledger, no longer a keeper) are re-keyed between two pulls —');
        require_(await main.send('rekey', { oldPk: kip.pk, newPk: kip2.pk, operator: gwen.pk }), 'Kip is re-keyed to his new phone\'s key');
        require_(await main.send('rekey', { oldPk: dee.pk, newPk: dee2.pk, operator: gwen.pk }), 'and Dee');
        const rekeyed = await standby.send('pull', {});
        const m5: Rows = await main.send('rows');
        s = await standby.send('rows');
        assert(rekeyed.ok === true, `the pull after the re-keys lands (${rekeyed.ok ? rekeyed.mode : rekeyed.error})`);
        assert(s.treasury_operators.some((o) => o.member_pubkey === kip2.pk) && !s.treasury_operators.some((o) => o.member_pubkey === kip.pk)
            && s.enterprise_pledges.every((p) => p.keeper !== kip.pk && p.keeper !== dee.pk),
            'Kip keeps Probe Co under his new key, and every pledge names the new keys');
        assert(rowsDiff(m5, s).length === 0, `every row and stamp is M's (differences ${first(rowsDiff(m5, s))})`);

        // ── 6. A standby as the old importer left it ──
        console.log('\n— 6. a standby holding the old importer\'s rows re-seeds itself once —');
        await standby.send('checkpoint');
        refused.push(...(await standby.send('fetches')).blocked);
        await standby.kill('SIGTERM');
        copyDir(dir('standby'), dir('old'));
        withDb(dir('old'), (db) => {
            // What the old import wrote: no standing, and the first voucher it copied kept (COALESCE); nothing of
            // member_preferences, treasury_operators or enterprise_pledges.
            for (const t of ['members_touch_updated_at', 'members_touch_board_standing']) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
            db.prepare(`UPDATE members SET is_treasury = 0, can_vouch = 0, vouch_credit = 0, credit_frozen = 0, earned_credit = 0, earned_surplus = 0,
                        working_capital_ceiling = NULL, legacy_credit_floor = NULL, purpose = NULL, goal_amount = NULL, deadline_at = NULL,
                        lifecycle = 'ongoing', paused = 0, lat = NULL, lng = NULL`).run();
            db.prepare('UPDATE members SET elder_vouched_by = ? WHERE public_key = ?').run(bo.pk, lou.pk);
            db.prepare('DELETE FROM member_preferences').run();
            db.prepare('DELETE FROM treasury_operators').run();
            db.prepare('DELETE FROM enterprise_pledges').run();
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('replica_format', '3')`).run();
        });
        const old = await spawnNode(SCRIPT, dir('old'), env(PW_STANDBY, 'backup'));
        nodes.push(old);
        await old.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const planted: Rows = await old.send('rows');
        require_(rowsDiff(m5, planted).length > 10 && planted.format === '3', `the planted standby differs from M (${first(rowsDiff(m5, planted))})`);
        const reseed = await old.send('pull', {});
        const m6: Rows = await main.send('rows');
        const o6: Rows = await old.send('rows');
        assert(reseed.ok === true && reseed.mode === 'resync', `its next pull is one re-seed, and it lands (${JSON.stringify({ ok: reseed.ok, mode: reseed.mode, error: reseed.error })})`);
        assert(rowsDiff(m6, o6).length === 0, `it ends equal to M, every row and stamp (differences ${first(rowsDiff(m6, o6))})`);
        assert(o6.format === FORMAT, `and records format ${FORMAT} (${o6.format})`);
        const after = await old.send('pull', {});
        assert(after.ok === true && after.mode === 'delta', `the pull after it is a delta, not a second re-seed (${JSON.stringify({ ok: after.ok, mode: after.mode, error: after.error })})`);
        refused.push(...(await old.send('fetches')).blocked);
        await old.kill('SIGTERM');

        // ── 7. A standby writes no pledge of its own ──
        console.log('\n— 7. on the standby, a keeper\'s pledge and release are refused; one it holds that M doesn\'t is gone after a whole copy —');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup')); // its own clock again
        nodes.push(standby);
        const sb = `https://localhost:${await standby.send('serve')}`;
        const boardOn = async (base: string) => {
            // Read by Gwen, a member who keeps no enterprise and isn't on holiday: a local community's board is its
            // members' since 2026-09-28, and this read was unsigned while the board was public.
            const b = await api(base, 'GET', '/api/marketplace/posts', { as: gwen });
            return (Array.isArray(b.body) ? b.body : b.body?.posts ?? []).map((p: any) => p.id).sort();
        };
        const backingOn = async (base: string) => {
            const b = (await api(base, 'GET', `/api/treasury/${probe.publicKey}/pledges`, { as: cy })).body ?? {};
            return { floor: b.floor, allowance: b.allowance, derived: b.derivedAllowance, legacy: b.legacyFloor, pledges: Array.isArray(b.pledges) ? b.pledges.length : null };
        };
        const caught7 = await standby.send('pull', {});
        const m7: Rows = await main.send('rows');
        let s7: Rows = await standby.send('rows');
        require_(caught7.ok === true && rowsDiff(m7, s7).length === 0 && m7.enterprise_pledges.some((p) => p.keeper === kip2.pk && p.released_at === null)
            && m7.treasury_operators.filter((o) => o.treasury_pubkey === probe.publicKey).length === 2,
            `S has caught up with M, where Kip is one of Probe Co's two keepers and holds a pledge (${caught7.ok ? caught7.mode : caught7.error}; differences ${first(rowsDiff(m7, s7))})`);
        const pledgeWrites: [string, Answer][] = [
            ['Kip releases 1 of his backing (the review\'s sequence)', await api(sb, 'POST', `/api/treasury/${probe.publicKey}/release`, { as: kip2, body: { amount: 1 } })],
            ['by /pledge/release', await api(sb, 'POST', `/api/treasury/${probe.publicKey}/pledge/release`, { as: kip2, body: { amount: 1 } })],
            ['by /backing/release', await api(sb, 'POST', `/api/enterprise/${probe.publicKey}/backing/release`, { as: kip2, body: { amount: 1 } })],
            ['by DELETE /pledge', await api(sb, 'DELETE', `/api/treasury/${probe.publicKey}/pledge`, { as: kip2, body: {} })],
            ['by DELETE /backing', await api(sb, 'DELETE', `/api/enterprise/${probe.publicKey}/backing`, { as: kip2, body: {} })],
            ['Kip pledges 1 more', await api(sb, 'POST', `/api/treasury/${probe.publicKey}/backing`, { as: kip2, body: { amount: 1 } })],
            ['by /pledge', await api(sb, 'POST', `/api/treasury/${probe.publicKey}/pledge`, { as: kip2, body: { type: 'backing', amount: 1 } })],
            ['Kip steps down, which releases his pledge', await api(sb, 'POST', `/api/treasury/${probe.publicKey}/keepers/step-down`, { as: kip2, body: {} })],
            ['the admin unbinds Kip, which settles it', await api(sb, 'DELETE', `/api/local/admin/treasury/${probe.publicKey}/operators/${kip2.pk}`, { admin: PW_STANDBY })],
        ];
        const through = pledgeWrites.filter(([, a]) => !(a.status === 409 && a.body?.code === 'standby')).map(([w, a]) => `${w}: ${brief(a)}`);
        assert(through.length === 0, `on S every write of a pledge answers 409 standby (${through.length} did not: ${through.join(' | ') || 'none'})`);
        const engine7 = [
            await standby.send('engine-pledge', { kind: 'release', enterprise: probe.publicKey, keeper: kip2.pk, amount: 1 }),
            await standby.send('engine-pledge', { kind: 'pledge', enterprise: probe.publicKey, keeper: kip2.pk, amount: 1 }),
        ];
        assert(engine7.every((r) => r.ok === false && r.code === 'standby'), `and its engine under the routes refuses a release and a pledge (${JSON.stringify(engine7)})`);
        s7 = await standby.send('rows');
        assert(rowsDiff(m7, s7).length === 0, `nothing was written: S's keepers and pledges are still M's (differences ${first(rowsDiff(m7, s7))})`);

        const unplanted7 = await backingOn(sb);
        await standby.send('plant-pledge', { keeper: kip2.pk, enterprise: probe.publicKey, amount: 1 });
        const planted7 = { m: await backingOn(m), s: await backingOn(sb) };
        require_(planted7.s.derived === (unplanted7.derived ?? NaN) + 1 && planted7.s.pledges === (unplanted7.pledges ?? NaN) + 1,
            `S holds a pledge of its own, as its release route wrote one before it refused: Probe Co has 1 Bean more backing there (${JSON.stringify({ before: unplanted7, ...planted7 })})`);
        const audit7 = await standby.send('check-copy');
        const counted7 = (audit7?.tables ?? []).filter((t: any) => ['treasury_operators', 'enterprise_pledges', 'member_preferences'].includes(t.name));
        const pledgeRow7 = counted7.find((t: any) => t.name === 'enterprise_pledges');
        assert(audit7?.ok === false && pledgeRow7?.match === false && pledgeRow7.backup === pledgeRow7.primary + 1
            && counted7.filter((t: any) => t.name !== 'enterprise_pledges').length === 2 && counted7.every((t: any) => t.name === 'enterprise_pledges' || t.match),
            `the whole-copy check counts pledges: on M's whole copy it finds S's extra one; keepers and preferences are counted and equal (${JSON.stringify(counted7)})`);
        const whole7 = await standby.send('pull', { whole: true });
        const m7b: Rows = await main.send('rows');
        s7 = await standby.send('rows');
        assert(whole7.ok === true && whole7.whole === true && rowsDiff(m7b, s7).length === 0,
            `a whole copy deletes S's own pledge: its pledges are M's (${whole7.ok ? whole7.mode : whole7.error}; differences ${first(rowsDiff(m7b, s7))})`);
        const after7 = { m: await backingOn(m), s: await backingOn(sb) };
        assert(JSON.stringify(after7.s) === JSON.stringify(after7.m), `and Probe Co's floor, allowance and backing on S are M's (${JSON.stringify(after7)})`);
        const check7 = await standby.send('consistency');
        assert(check7?.ok === true && check7.tables.some((t: any) => t.name === 'enterprise_pledges' && t.match),
            `the whole-copy check after it finds the copy exact, pledges counted (${JSON.stringify(check7?.tables?.filter((t: any) => !t.match))})`);

        // ── 8. A value the standby's own table refuses ──
        console.log('\n— 8. an older main server\'s row holds a goal below 0, which a standby\'s table refuses: left out, reported, and copying goes on —');
        const shapes8 = { m: await main.send('goal-rule'), s: await standby.send('goal-rule') };
        require_(shapes8.m === false && shapes8.s === true, `M's goal column came from an ALTER, with no CHECK; S's, from schema.sql, has one (${JSON.stringify(shapes8)})`);
        const minus8 = await S_(eve, '/api/treasury', { name: 'Minus Fund', purpose: 'Below zero', lifecycle: 'bounded', goalAmount: -5 });
        const minusCrowd8 = await S_(eve, '/api/crowdfund/projects', { title: 'Minus Crowd', description: 'Below zero', goalAmount: -5, creatorPubkey: eve.pk });
        assert(minus8.status === 400 && /goal/i.test(JSON.stringify(minus8.body)) && minusCrowd8.status === 400 && /goal/i.test(JSON.stringify(minusCrowd8.body)),
            `M refuses a goal below 0 now, for an enterprise and a crowdfund (${brief(minus8)}; ${brief(minusCrowd8)})`);
        require_(await main.send('plant-goal', { pk: seed.publicKey, goal: -5 }), 'M: Seed Fund\'s goal is -5, as an older build wrote it (POST /api/treasury passed it on unchecked)');
        const m8: Rows = await main.send('rows');
        const goalOf = (r: Rows, pk: string) => r.members.find((x) => x.public_key === pk)?.goal_amount;
        const example8 = `${seed.publicKey.slice(0, 16)}.goal_amount`;
        const onlyTheGoal = (d: string[]) => d.length === 1 && d[0].startsWith(`members ${seed.publicKey.slice(0, 12)}.goal_amount:`);
        const delta8 = await standby.send('pull', {});
        let s8: Rows = await standby.send('rows');
        assert(delta8.ok === true && delta8.mode === 'delta' && goalOf(s8, seed.publicKey) === 100 && onlyTheGoal(rowsDiff(m8, s8)),
            `the running standby's delta lands: Seed Fund's row is M's but for the goal, which S keeps (${JSON.stringify({ ok: delta8.ok, mode: delta8.mode, error: delta8.error })}; differences ${first(rowsDiff(m8, s8))})`);
        const plums = await offer(ann, 'Late plums', 3);
        const next8 = await standby.send('pull', {});
        assert(next8.ok === true && (await boardOn(sb)).includes(plums.id), `and so does the next: a listing M makes after it arrives (${next8.ok ? next8.mode : next8.error})`);
        const before8 = await standby.send('record');
        const whole8 = await standby.send('pull', { whole: true });
        const m8b: Rows = await main.send('rows');
        s8 = await standby.send('rows');
        const check8 = await standby.send('consistency');
        assert(whole8.ok === true && whole8.whole === true && onlyTheGoal(rowsDiff(m8b, s8)),
            `its whole copy lands, the goal left out (${whole8.ok ? whole8.mode : whole8.error}; differences ${first(rowsDiff(m8b, s8))})`);
        assert(check8?.ok === false && check8.valuesLeftOut?.count === 1 && check8.valuesLeftOut.examples?.[0] === example8
            && check8.tables.every((t: any) => t.match) && check8.ledger?.match === true,
            `the whole-copy check reports the value left out, so the copy isn't exact; every count and account matches (${JSON.stringify({ ok: check8?.ok, valuesLeftOut: check8?.valuesLeftOut, differ: check8?.tables?.filter((t: any) => !t.match) })})`);
        // Not exact, and no force-resync: one would leave the same value out. S has asked for none before, so none is held
        // back by the six hours between two.
        const record8 = (await standby.send('record')).lastWhole;
        assert(before8.lastMismatchResyncAt === null && record8?.exact === false && JSON.stringify(record8.differs) === '["members"]'
            && record8.hashed === true && record8.resyncAsked === false,
            `its record: not exact, members differing, every table's content compared, and no force-resync asked (${JSON.stringify({ lastResyncBefore: before8.lastMismatchResyncAt, record8 })})`);
        const after8 = await standby.send('pull', {});
        assert(after8.ok === true && after8.mode === 'delta', `and its next pull is a delta, not a force-resync (${after8.ok ? after8.mode : after8.error})`);

        fs.mkdirSync(dir('fresh'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('fresh'), 'genesis.json'));
        const fresh = await spawnNode(SCRIPT, dir('fresh'), env(PW_STANDBY, 'backup'));
        nodes.push(fresh);
        await fresh.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const fresh1 = await fresh.send('pull', {});
        const f8: Rows = await fresh.send('rows');
        const m8c: Rows = await main.send('rows');
        const freshCheck = await fresh.send('consistency');
        assert(fresh1.ok === true && f8.members.length === m8c.members.length && goalOf(f8, seed.publicKey) === null && onlyTheGoal(rowsDiff(m8c, f8)),
            `a fresh standby's first copy lands: every member, and Seed Fund's goal at the column's default, none (${JSON.stringify({ ok: fresh1.ok, mode: fresh1.mode, error: fresh1.error })}; members ${f8.members.length} of ${m8c.members.length}; differences ${first(rowsDiff(m8c, f8))})`);
        assert(freshCheck?.ok === false && freshCheck.valuesLeftOut?.examples?.[0] === example8, `and its whole-copy check reports the value (${JSON.stringify(freshCheck?.valuesLeftOut ?? null)})`);
        const freshRecord = await fresh.send('record');
        assert(freshRecord.lastWhole?.exact === false && JSON.stringify(freshRecord.lastWhole.differs) === '["members"]' && freshRecord.lastWhole.hashed === true
            && freshRecord.lastWhole.resyncAsked === false && freshRecord.lastMismatchResyncAt === null,
            `its record: not exact, members differing, and no force-resync asked (${JSON.stringify(freshRecord)})`);
        const fresh2 = await fresh.send('pull', {});
        const fresh3 = await fresh.send('pull', { whole: true });
        assert(fresh2.ok === true && fresh2.mode === 'delta' && fresh3.ok === true && fresh3.whole === true,
            `its next pulls land, a delta and a whole copy (${JSON.stringify([fresh2, fresh3].map((r) => ({ ok: r.ok, mode: r.mode, error: r.error })))})`);
        const fresh3Record = (await fresh.send('record')).lastWhole;
        assert(fresh3Record?.exact === false && JSON.stringify(fresh3Record.differs) === '["members"]' && fresh3Record.resyncAsked === false,
            `and that whole copy's check asks for none either (${JSON.stringify(fresh3Record)})`);
        // The value left out is read as the copy's only where the import left it out: a members row that differs anywhere
        // else is still a copy a force-resync mends. Checked on M's next whole copy, not imported, so the bio stays S's.
        require_(await fresh.send('plant-bio', { pk: ann.pk, bio: 'Only on this standby' }), 'the fresh standby: Ann\'s bio changed there alone');
        const guard8 = await fresh.send('check-whole', { leftOut: [{ publicKey: seed.publicKey, column: 'goal_amount' }] });
        assert(guard8.hashes === true && guard8.consistency?.valuesLeftOut?.examples?.[0] === example8 && guard8.lastWhole?.exact === false
            && JSON.stringify(guard8.lastWhole.differs) === '["members"]' && guard8.lastWhole.resyncAsked === true,
            `a members row that differs beside the value left out still asks for the force-resync (${JSON.stringify({ hashes: guard8.hashes, lastWhole: guard8.lastWhole })})`);
        const markers8 = { main: await main.send('marker'), standby: await standby.send('marker'), fresh: await fresh.send('marker') };
        assert(markers8.main === '1' && markers8.standby === null && markers8.fresh === null,
            `M ran its clean-up at its first boot; a standby runs none on its rows and records none (${JSON.stringify(markers8)})`);
        refused.push(...(await fresh.send('fetches')).blocked);
        await fresh.kill('SIGTERM');

        console.log('\n— 8. a main server holding such a goal from an older build brings it into the schema\'s rules once, at boot —');
        await main.send('checkpoint');
        copyDir(dir('main'), dir('upgraded'));
        withDb(dir('upgraded'), (db) => db.prepare(`DELETE FROM node_config WHERE key = 'migration_members_schema_rules_v1'`).run());
        const upgraded = await spawnNode(SCRIPT, dir('upgraded'), env(PW_MAIN, 'primary'));
        nodes.push(upgraded);
        const u8: Rows = await upgraded.send('rows');
        const seedBefore = m8c.members.find((r) => r.public_key === seed.publicKey);
        const seedAfter = u8.members.find((r) => r.public_key === seed.publicKey);
        assert(seedBefore?.goal_amount === -5 && seedAfter?.goal_amount === null && seedAfter.updated_at > seedBefore.updated_at && await upgraded.send('marker') === '1',
            `its goal is the column's default, none, and the row is stamped so a delta carries it (${JSON.stringify({ before: [seedBefore?.goal_amount, seedBefore?.updated_at], after: [seedAfter?.goal_amount, seedAfter?.updated_at] })})`);
        const others8 = rowsDiff(m8c, u8).filter((d) => !d.startsWith(`members ${seed.publicKey.slice(0, 12)}.`));
        assert(others8.length === 0, `nothing else changes (${first(others8)})`);
        refused.push(...(await upgraded.send('fetches')).blocked);
        await upgraded.kill('SIGTERM');

        // ── 9. The take-over ──
        console.log('\n— 9. M dies; S takes over with the recovery code —');
        const last = await standby.send('pull', {});
        require_(last.ok === true && last.envelope !== undefined, `S: a last pull, and the take-over envelope (${last.ok ? last.mode : last.error})`);
        // Each member's read by that member (a balance is its owner's only, 2026-09-28), an enterprise's by Gwen (its
        // balance is open). Read by Gwen for everyone while balances were member-visible.
        const everyone: [string, string, Id][] = [gwen, ann, bo, cy, kip2, lou, eve, fay, dee2, hal].map((w) => [w.name, w.pk, w]);
        everyone.push(['Probe Co', probe.publicKey, gwen], ['Seed Fund', seed.publicKey, gwen]);
        const standingOn = async (base: string) => Object.fromEntries(await Promise.all(
            everyone.map(async ([n, pk, reader]) => [n, standingOf(await api(base, 'GET', `/api/ledger/balance/${pk}`, { as: reader }))])));
        await main.send('fresh-trust');
        const onMain = { standing: await standingOn(m), board: await boardOn(m) };
        require_((onMain.standing as any).Eve?.elderVouchedBy === bo.pk && (onMain.standing as any).Lou?.elderVouchedBy === null
            && (onMain.standing as any).Fay?.floor === 0 && (onMain.standing as any).Fay?.grantedCredit > 0
            && !onMain.board.includes(checkId) && !onMain.board.includes(walking.id),
            `M: Eve is vouched and Lou no longer; Fay, an Elder, is frozen at 0; the paused enterprise's listing and the holiday member's are off its board (${JSON.stringify({ eve: (onMain.standing as any).Eve, lou: (onMain.standing as any).Lou, fay: (onMain.standing as any).Fay })})`);
        refused.push(...(await main.send('fetches')).blocked);
        await main.send('checkpoint');
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
        require_(opened.status === 200 && opened.body.success, `the code opens the keys (${opened.status} ${JSON.stringify(opened.body).slice(0, 160)})`);
        refused.push(...(await standby.send('fetches')).blocked);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        require_(confirmed.status === 200, `confirm (${confirmed.status})`);
        require_(await standby.exited === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(standby.ready.role === 'primary' && standby.ready.peerId === main.ready.peerId,
            `promoted, with M's PeerId (${JSON.stringify({ role: standby.ready.role, peerId: standby.ready.peerId?.slice(-8) })})`);
        const p = `https://localhost:${await standby.send('serve')}`;
        const P_ = (who: Id, route: string, body: unknown = {}) => api(p, 'POST', route, { as: who, body });

        console.log('\n— 9. the promoted server holds every member\'s and enterprise\'s standing —');
        await standby.send('fresh-trust');
        const promoted = { standing: await standingOn(p), board: await boardOn(p) };
        const floorsDiffer = Object.keys(onMain.standing).filter((n) => JSON.stringify((onMain.standing as any)[n]) !== JSON.stringify((promoted.standing as any)[n]));
        assert(floorsDiffer.length === 0,
            `every balance, floor, tier and granted credit is M's, the withdrawn vouch giving no credit back (differ: ${floorsDiffer.map((n) => `${n} ${JSON.stringify((onMain.standing as any)[n])} / ${JSON.stringify((promoted.standing as any)[n])}`).join(' | ') || 'none'})`);
        assert(JSON.stringify(promoted.board) === JSON.stringify(onMain.board),
            `the board is M's: the paused enterprise's listing and the holiday member's stay off (${promoted.board.length} against ${onMain.board.length})`);
        const page = await api(p, 'GET', `/api/treasury/${probe.publicKey}`, { as: kip2 });
        assert(page.status === 200 && JSON.stringify(page.body).includes('"paused":true'), `the enterprise's page answers for its keeper, paused (${brief(page)})`);
        const away = await P_(ann, '/api/marketplace/posts/request', { postId: walking.id, buyerPublicKey: ann.pk });
        assert(away.status >= 400 && /holiday/i.test(JSON.stringify(away.body)), `the holiday member can't be traded with (${brief(away)})`);
        const exempt = await standby.send('exempt', { keys: [probe.publicKey, seed.publicKey, ann.pk] });
        assert(JSON.stringify(exempt) === JSON.stringify([probe.publicKey, seed.publicKey]), `the enterprises pay no demurrage, a member does (${JSON.stringify(exempt.map((k: string) => k.slice(0, 8)))})`);
        for (const [who, token] of [[ann, 'ExponentPushToken[standing-ann]'], [bo, 'ExponentPushToken[standing-bo]']] as const) {
            built(`${who.name}'s phone registers with the promoted server`, await P_(who, '/api/push-tokens', { publicKey: who.pk, token, platform: 'android' }));
        }
        const pushes = await standby.send('pushable');
        assert(!pushes.marketplace.includes(ann.pk) && !pushes.chat.includes(ann.pk) && pushes.escrow.includes(ann.pk) && pushes.marketplace.includes(bo.pk),
            `Ann's opt-outs hold: no marketplace or chat pushes, escrow still (${JSON.stringify(Object.fromEntries(Object.entries(pushes).map(([c, ks]) => [c, (ks as string[]).map((k) => (k === ann.pk ? 'Ann' : k === bo.pk ? 'Bo' : k.slice(0, 6)))])))})`);
        const vouched = await P_(bo, '/api/profile/vouch', { targetPubkey: hal.pk, level: 1 });
        assert(vouched.status === 200, `the appointed voucher vouches (${brief(vouched)})`);
        const pins = await api(p, 'GET', '/api/enterprises/map', { as: ann });
        assert(pins.status === 200 && JSON.stringify(pins.body).includes(probe.publicKey), `Probe Co is on the map (${brief(pins)})`);
        const resumed = await P_(cy, `/api/treasury/${probe.publicKey}/resume`);
        assert(resumed.status === 200, `its lead resumes it (${brief(resumed)})`);
        const posted = await P_(kip2, `/api/treasury/${probe.publicKey}/offer`, { title: 'Puncture kits', description: 'Made in the workshop', credits: 2, category: 'tools' });
        assert(posted.status === 200, `and its keeper, re-keyed, posts for it (${brief(posted)})`);
        const board = await boardOn(p);
        assert(board.includes(checkId), 'the resumed enterprise\'s listing is back on the board');
        refused.push(...(await standby.send('fetches')).blocked);
        assert(refused.length === 0, `nothing reached off this machine (refused: ${refused.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A member\'s and an enterprise\'s standing replicate, and a promoted standby holds them.');
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
