/**
 * Test Suite: backups are an owner's, the replication token is the standby's only, and a restore checks what it is given
 * before it replaces anything (Fable's backups and replication reviews, 2026-10-01; scratch/reviews/FABLE-sec-*.md).
 *
 * Over the real HTTPS server, through every middleware a node runs:
 *  1. An admin's key session is refused (403, in words), with nothing changed, on the restore (the live database's roles
 *     and members as they were, no upload left), /backup, the snapshot download, the replication token's generate, mode
 *     and clear (the standby's token still works), replication-config/save, a snapshot delete (the file still there), a
 *     change to the snapshot settings, a copy through the admin-password path
 *     (an admin's session wins over any X-Admin-Password header), and every off-box backup route (status, settings, run,
 *     list, download). A moderator's session too. An owner's key session and the node password get each of them. The
 *     fleet manager's backup downloads are gone (deleted 2026-10-02): nobody gets a database there, an owner neither.
 *  2. The replication token alone, on every /api/local/admin/* route the node serves: it gets what
 *     no credential gets, and never a database, except on the standby's own routes (the copy routes, replication-access
 *     and the take-over envelope), where it is taken. With backups readable (no recovery code) and locked (one).
 *  3. A readable backup's node_config.json carries no credential (the admin hash and salt, the 2FA secret, the token's
 *     hash, a standby's token, a legacy plain-text password), from a legacy data/node_config.json too; nor do its bytes.
 *  4. A restore refuses, the live database and the data folder as they were: a gzip bomb past the unpacked cap, past the
 *     member cap, and a member whose header alone is past the real 4 GB cap; a hard link (busybox's case: out to
 *     ../local-config.json), a symlink and a fifo; a state.db that is not a database, one that fails integrity_check, and
 *     one carrying a trigger this server's database does not have.
 *  5. An owner's restore of a backup whose known trigger was rewritten (a trigger that mints Beans): it restores, the
 *     rewritten body is not in the database put in place, and the restart makes the real one again (a child process
 *     boots the restored data folder).
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-backup-owner-gate.ts
 * (It re-runs itself as a child with `--boot` for step 5's restart.)
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localFetch } from './keepalive-test-fetch.js';

// A trigger boot keeps when one of its name is there (schema.sql's CREATE TRIGGER IF NOT EXISTS; state-engine.ts even puts
// it back from the database's own text): not members_touch_updated_at, which db.ts drops and makes again at every boot.
const TRIGGER = 'posts_touch_updated_at';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const isGzip = (b: Buffer) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
const SQLITE = Buffer.from('SQLite format 3\0', 'latin1');

type Entry = { name: string; type?: '0' | '1' | '2' | '5' | '6'; content?: Buffer; link?: string; size?: number };

/** A minimal ustar writer, so hostile archives are built the same way on every OS. `size` overrides the header only. */
function tarBlocks(entries: Entry[]): Buffer {
    const blocks: Buffer[] = [];
    for (const e of entries) {
        const content = e.content ?? Buffer.alloc(0);
        const type = e.type ?? '0';
        const h = Buffer.alloc(512);
        h.write(e.name, 0, 100, 'utf8');
        h.write(type === '5' ? '0000755\0' : '0000644\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write((e.size ?? (type === '0' ? content.length : 0)).toString(8).padStart(11, '0') + '\0', 124);
        h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
        h.write('        ', 148);
        h.write(type, 156);
        if (e.link) h.write(e.link, 157, 100, 'utf8');
        h.write('ustar\0', 257);
        h.write('00', 263);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(h);
        if (type === '0' && e.size === undefined) blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512));
    }
    return Buffer.concat(blocks);
}
const tarGz = (entries: Entry[], end = true) => zlib.gzipSync(Buffer.concat([tarBlocks(entries), end ? Buffer.alloc(1024) : Buffer.alloc(0)]));

/** The plain files in a tar, by name (`./` dropped), as GNU tar, bsdtar and busybox write them. */
function tarFiles(tar: Buffer): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    let at = 0;
    let longName: string | null = null;
    let paxPath: string | null = null;
    while (at + 512 <= tar.length) {
        const h = tar.subarray(at, at + 512);
        if (h.every((b) => b === 0)) break;
        const field = (o: number, l: number) => {
            const r = h.subarray(o, o + l);
            const n = r.indexOf(0);
            return (n === -1 ? r : r.subarray(0, n)).toString('utf8');
        };
        const size = parseInt(field(124, 12).trim() || '0', 8);
        const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
        const body = tar.subarray(at + 512, at + 512 + size);
        if (type === 'L') longName = body.toString('utf8').replace(/\0[\s\S]*$/, '');
        else if (type === 'x') paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
        else {
            if (type === '0') out.set((paxPath ?? longName ?? field(0, 100)).replace(/^\.\//, ''), body);
            longName = null;
            paxPath = null;
        }
        at += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
}

// ── Step 5's restart: this file again, as the node booting on the restored data folder ─────────────────────────────

async function bootChild(): Promise<void> {
    const { initStateEngine } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    initStateEngine();
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(TRIGGER) as { sql: string } | undefined;
    const marker = db.prepare(`SELECT callsign FROM members WHERE callsign = 'RestoredMarker'`).get();
    console.log('CHILD_RESULT ' + JSON.stringify({ sql: row?.sql ?? null, marker: !!marker }));
    process.exit(0);
}

// ── The node (this process) ─────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');

    const { initStateEngine, seedGenesisMember, grantNodeRole } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig, getLocalConfig, setReplicationToken, verifyReplicationToken, hasReplicationToken } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { createSnapshot, writeDbSnapshot, getAutoSnapshotConfig } = await import('./services/snapshot-scheduler.js');
    const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');
    const backupRoutes: any = await import('./routes/backup.js');
    const Database = (await import('better-sqlite3')).default;

    initStateEngine();
    await ensureGenesis();
    // A node key, so a recovery code can lock backups (step 2's second sweep).
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const PW = 'Owner-Gate-Pw-4471!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, replicationTokenOnly: false });
    const TOKEN = 'owner-gate-replication-token-' + crypto.randomBytes(16).toString('hex');
    setReplicationToken(TOKEN);

    const pubkey = () => crypto.randomBytes(32).toString('hex');
    const owner = pubkey();
    const admin = pubkey();
    const moderator = pubkey();
    seedGenesisMember(owner, 'Olive');
    for (const [pk, callsign] of [[admin, 'Adam'], [moderator, 'Mo']]) {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(pk, callsign, new Date().toISOString(), owner, 'TEST');
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    }
    grantNodeRole(admin, 'admin', owner);
    grantNodeRole(moderator, 'moderator', owner);
    const session = (pk: string, role: 'owner' | 'admin' | 'moderator') => {
        const ex = consumeHandshakeToken(mintHandshakeToken(pk, role).handshakeToken);
        if (!ex.ok || ex.role !== role) throw new Error(`setup: no ${role} session: ${ex.error}`);
        return ex.sessionId!;
    };
    const ownerSession = session(owner, 'owner');
    const adminSession = session(admin, 'admin');
    const modSession = session(moderator, 'moderator');

    backupRoutes.setRestoreRestartForTests(() => { /* the test inspects the data folder instead of restarting */ });
    await initTls();
    const port = await https.startHttpsServer(0);
    const base = `https://localhost:${port}`;

    async function call(method: string, route: string, headers: Record<string, string> = {}, body?: Buffer | string) {
        resetAdminAuthTarpit();
        https.resetAdminRateLimit();
        const init: RequestInit = { method, headers: { ...headers } };
        if (method !== 'GET' && method !== 'HEAD') {
            if (body === undefined) body = '{}';
            (init.headers as Record<string, string>)['Content-Type'] ??= Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json';
            init.body = Buffer.isBuffer(body) ? new Uint8Array(body) : body;
        }
        const res = await localFetch(base + route, init);
        const bytes = Buffer.from(await res.arrayBuffer());
        let json: any = null;
        try { json = JSON.parse(bytes.toString('utf8')); } catch { /* a file */ }
        return { status: res.status, bytes, json, headers: res.headers };
    }
    const asOwner = { 'x-admin-session': ownerSession };
    const asAdmin = { 'x-admin-session': adminSession };
    const asMod = { 'x-admin-session': modSession };
    // Step 7c: with the node's 2FA off the password alone opens no admin route. Step 1 checks that, then sends the node
    // password with a code (2FA on, for that loop only); the later steps' owner requests use the owner's key session.
    let tfa: ReturnType<typeof turnOn2faForTests> | null = null;
    const asPassword = (): Record<string, string> => (tfa ? tfa.headers() : { 'x-admin-password': PW });

    const roles = () => JSON.stringify(db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all());
    const memberCount = () => (db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n;
    const leftovers = () => fs.readdirSync(dataDir!).filter((f) => f.startsWith('.restore') || f.startsWith('uploaded-backup'));
    /** The data folder's files and sizes, but the live database's (its WAL moves on its own). */
    const folder = (): Map<string, number> => {
        const out = new Map<string, number>();
        const walk = (d: string, rel: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const r = rel ? `${rel}/${e.name}` : e.name;
                if (/^state\.db(-wal|-shm|-journal)?$/.test(r)) continue;
                if (e.isDirectory()) walk(path.join(d, e.name), r);
                else out.set(r, fs.lstatSync(path.join(d, e.name)).size);
            }
        };
        walk(dataDir!, '');
        return out;
    };
    const folderBytes = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

    /** A consistent copy of the live database, changed by `edit`, as a restore's state.db. */
    let copies = 0;
    const databaseCopy = (edit?: (h: InstanceType<typeof Database>) => void): Buffer => {
        const file = path.join(path.dirname(dataDir!), `owner-gate-copy-${process.pid}-${copies++}.db`);
        writeDbSnapshot(file);
        if (edit) {
            const h = new Database(file);
            try { edit(h); } finally { h.close(); }
        }
        const bytes = fs.readFileSync(file);
        fs.rmSync(file, { force: true });
        return bytes;
    };
    const plainArchive = (stateDb: Buffer, more: Entry[] = []) => tarGz([
        { name: './state.db', content: stateDb },
        { name: './node_config.json', content: Buffer.from('{}') },
        ...more,
    ]);

    // ── 1. An admin is refused; an owner is not ──────────────────────────────────────────────────────────────────
    console.log('\n— 1. owner only —');
    const snapA = createSnapshot();
    const snapB = createSnapshot();
    // The restore an admin would send: this database, with themselves as its owner.
    const selfPromotion = plainArchive(databaseCopy((h) => h.prepare(`UPDATE node_roles SET role = 'owner' WHERE member_pubkey = ?`).run(admin)));
    const tokenHashBefore = getLocalConfig().replicationTokenHash;
    const snapshotConfigBefore = JSON.stringify(getAutoSnapshotConfig());
    const rolesBefore = roles();
    const membersBefore = memberCount();
    const cases: { what: string; method: string; route: string; body?: Buffer | string; headers?: Record<string, string>; unchanged: () => string | null }[] = [
        { what: 'the restore', method: 'POST', route: '/api/local/admin/restore', body: selfPromotion,
            unchanged: () => roles() === rolesBefore && memberCount() === membersBefore && leftovers().length === 0 ? null : `roles ${roles()}, leftovers ${leftovers()}` },
        { what: '/backup', method: 'POST', route: '/api/local/admin/backup', unchanged: () => null },
        { what: 'the snapshot download', method: 'GET', route: `/api/local/admin/snapshots/download?name=${encodeURIComponent(snapA.name)}`, unchanged: () => null },
        { what: 'replication-token/generate', method: 'POST', route: '/api/local/admin/replication-token/generate',
            unchanged: () => getLocalConfig().replicationTokenHash === tokenHashBefore ? null : 'the token changed' },
        { what: 'replication-token/mode', method: 'POST', route: '/api/local/admin/replication-token/mode', body: JSON.stringify({ tokenOnly: true }),
            unchanged: () => getLocalConfig().replicationTokenOnly === false ? null : 'token-only mode changed' },
        { what: 'replication-token/clear', method: 'POST', route: '/api/local/admin/replication-token/clear',
            unchanged: () => hasReplicationToken() && getLocalConfig().replicationTokenHash === tokenHashBefore ? null : 'the token is gone' },
        { what: 'replication-config/save', method: 'POST', route: '/api/local/admin/replication-config/save',
            body: JSON.stringify({ primaryUrl: 'https://elsewhere.example', primaryToken: 'x' }),
            unchanged: () => !getLocalConfig().backupPrimaryUrl && !getLocalConfig().backupReplicationToken ? null : 'the copy source changed' },
        { what: 'a snapshot delete', method: 'POST', route: '/api/local/admin/snapshots/delete', body: JSON.stringify({ name: snapA.name }),
            unchanged: () => fs.existsSync(path.join(dataDir!, 'snapshots', snapA.name)) ? null : 'the snapshot is gone' },
        { what: 'a snapshot settings change', method: 'POST', route: '/api/local/admin/snapshots/config', body: JSON.stringify({ keep: 1 }),
            unchanged: () => JSON.stringify(getAutoSnapshotConfig()) === snapshotConfigBefore ? null : 'the settings changed' },
        { what: 'a copy through the admin-password path', method: 'GET', route: '/api/local/admin/sync-snapshot', headers: { 'x-admin-password': 'anything at all' }, unchanged: () => null },
        { what: 'the off-box backups status', method: 'POST', route: '/api/local/admin/offbox-backups/status', unchanged: () => null },
        { what: 'an off-box backups settings change', method: 'POST', route: '/api/local/admin/offbox-backups/settings', body: JSON.stringify({ retentionDays: 1 }),
            unchanged: () => fs.existsSync(path.join(dataDir!, 'offbox-backups.json')) ? 'the off-box settings were written' : null },
        { what: 'an off-box backup sent now', method: 'POST', route: '/api/local/admin/offbox-backups/run', unchanged: () => null },
        { what: 'an off-box destination listing', method: 'POST', route: '/api/local/admin/offbox-backups/list', body: JSON.stringify({ destination: 'env-1' }), unchanged: () => null },
        { what: 'an off-box backup download', method: 'GET', route: '/api/local/admin/offbox-backups/download?destination=env-1&key=x', unchanged: () => null },
    ];
    assert(fs.existsSync(path.join(dataDir!, 'snapshots', snapA.name)), `setup: a snapshot to download and delete (${snapA.name})`);
    for (const c of cases) {
        for (const [who, creds] of [['an admin', asAdmin], ['a moderator', asMod]] as const) {
            const r = await call(c.method, c.route, { ...creds, ...(c.headers ?? {}) }, c.body);
            const words = String(r.json?.error ?? '');
            assert(r.status === 403 && (who === 'a moderator' ? /Moderators can/.test(words) : /^Only an owner of this node/.test(words))
                && !isGzip(r.bytes) && !r.bytes.includes(SQLITE),
                `1. ${c.what}: ${who}'s key session is refused, in words (${r.status}: ${words})`);
            const changed = c.unchanged();
            assert(changed === null, `1. ${c.what}: …and nothing changed${changed ? ` (${changed})` : ''}`);
        }
    }
    // What an admin keeps: the status, the snapshot list, reading the snapshot settings, taking a snapshot.
    for (const [route, body] of [['/api/local/admin/backup-status', '{}'], ['/api/local/admin/snapshots/list', '{}'], ['/api/local/admin/snapshots/config', '{}']] as const) {
        const r = await call('POST', route, asAdmin, body);
        assert(r.status === 200, `1. an admin still reads ${route} (${r.status})`);
    }
    // An owner, by key session and by the password, gets each (the restore is step 5's).
    {
        const alone = await call('POST', '/api/local/admin/backup', asPassword());
        assert(alone.status === 403 && alone.json?.code === 'password_needs_2fa' && !isGzip(alone.bytes),
            `1. /backup: the node password alone, 2FA off, is refused (password_needs_2fa) (${alone.status})`);
    }
    for (const [who, credsOf] of [["an owner's key session", () => asOwner], ['the node password', () => { tfa ??= turnOn2faForTests(PW); return asPassword(); }]] as const) {
        const bk = await call('POST', '/api/local/admin/backup', credsOf());
        assert(bk.status === 200 && isGzip(bk.bytes), `1. /backup: ${who} gets the backup (${bk.status})`);
        const sd = await call('GET', `/api/local/admin/snapshots/download?name=${encodeURIComponent(snapA.name)}`, credsOf());
        assert(sd.status === 200 && isGzip(sd.bytes), `1. the snapshot download: ${who} gets it (${sd.status})`);
        // (credsOf() already carries the node password for that row; a second header of the same name would join the two.)
        const copy = await call('GET', '/api/local/admin/sync-snapshot', { ...credsOf(), ...(who === 'the node password' ? {} : { 'x-admin-password': 'anything at all' }) });
        assert(copy.status !== 401 && copy.status !== 403, `1. a copy through the admin-password path: ${who} passes the gate (${copy.status})`);
        // The fleet manager's backup routes are gone (2026-10-02): no database there for anyone, an owner included.
        const mdb = await call('GET', '/api/manager/backups/download-db?nodeId=local', credsOf());
        assert(mdb.status >= 400 && mdb.status < 500 && !isGzip(mdb.bytes) && !mdb.bytes.includes(SQLITE),
            `1. the manager's download-db is gone: ${who} gets no database there (${mdb.status})`);
        const offbox = await call('POST', '/api/local/admin/offbox-backups/status', credsOf());
        assert(offbox.status === 200 && offbox.json?.state === 'none', `1. the off-box backups status: ${who} reads it (${offbox.status})`);
        const cfg = await call('POST', '/api/local/admin/snapshots/config', credsOf(), JSON.stringify({ keep: getAutoSnapshotConfig().keep }));
        assert(cfg.status === 200, `1. a snapshot settings change: ${who} makes it (${cfg.status})`);
        const save = await call('POST', '/api/local/admin/replication-config/save', credsOf(), JSON.stringify({ primaryUrl: '' }));
        assert(save.status === 200, `1. replication-config/save: ${who} saves it (${save.status})`);
        const mode = await call('POST', '/api/local/admin/replication-token/mode', credsOf(), JSON.stringify({ tokenOnly: false }));
        assert(mode.status === 200, `1. replication-token/mode: ${who} sets it (${mode.status})`);
        const gen = await call('POST', '/api/local/admin/replication-token/generate', credsOf());
        assert(gen.status === 200 && typeof gen.json?.token === 'string' && await verifyReplicationToken(gen.json.token),
            `1. replication-token/generate: ${who} makes a token that works (${gen.status})`);
        const clear = await call('POST', '/api/local/admin/replication-token/clear', credsOf());
        assert(clear.status === 200 && !hasReplicationToken(), `1. replication-token/clear: ${who} removes it (${clear.status})`);
        setReplicationToken(TOKEN);
    }
    // The node's 2FA off again, as the rest of this suite was written for.
    updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] });
    tfa = null;
    const del = await call('POST', '/api/local/admin/snapshots/delete', asOwner, JSON.stringify({ name: snapB.name }));
    assert(del.status === 200 && !fs.existsSync(path.join(dataDir!, 'snapshots', snapB.name)), `1. a snapshot delete: an owner makes it (${del.status})`);

    // ── 2. The replication token alone: the standby's routes, and nothing else ─────────────────────────────────────
    const STANDBY_ROUTES = new Set([
        'GET /api/local/admin/sync-snapshot', 'GET /api/local/admin/sync-delta', 'POST /api/local/admin/sync-copy',
        'GET /api/local/admin/sync-copy/:copyId/:n', 'DELETE /api/local/admin/sync-copy/:copyId', 'GET /api/local/admin/sync-object/:sha256',
        'POST /api/local/admin/replication-access', 'GET /api/local/admin/takeover-envelope',
    ]);
    const app: any = https.getKoaApp();
    const served = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
        .flatMap((l: any) => (l.methods as string[]).filter((m) => m !== 'HEAD').map((m) => `${m} ${l.path}`)))].sort();
    const adminRoutes = served.filter((r) => /^\S+ \/api\/(local\/admin|manager)\//.test(r));
    const materialise = (p: string) => p.replace(/:([A-Za-z0-9]+)/g, (_, name: string) =>
        name === 'sha256' ? '0'.repeat(64) : name === 'n' ? '0' : 'sentinel');
    const sweep = async (stage: string) => {
        console.log(`\n— 2. the replication token alone, ${stage} —`);
        const taken: string[] = [];
        const leaked: string[] = [];
        // The admin tarpit (admin-auth.ts) sleeps 250 ms before each refusal, even from the floor resetAdminAuthTarpit
        // leaves: over ~160 routes × 2 callers × 2 sweeps, most of this suite's time. The sleep decides only WHEN the 401
        // goes out, never its status or body, which is all this reads (test-admin-auth measures it). So during a sweep a
        // timer set from admin-auth fires at once, as test-guest-view does; every other timer keeps its delay.
        const realSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
            realSetTimeout(fn, /[\\/]admin-auth\.[cm]?[jt]s:\d+/.test(new Error().stack ?? '') ? 0 : ms, ...args)) as unknown as typeof setTimeout;
        try {
            for (const route of adminRoutes) {
                const [method, routePath] = route.split(' ');
                const url = materialise(routePath);
                // Taken when the token's answer differs from no credential's, both before it and after it: a route's own
                // per-address limiter (routes/settings-signin.ts, say) can turn a 404 into a 429 between two calls.
                const none = await call(method, url, {});
                const tok = await call(method, url, { 'x-replication-token': TOKEN });
                const noneAfter = await call(method, url, {});
                if (tok.status !== none.status && tok.status !== noneAfter.status) taken.push(route);
                if (!STANDBY_ROUTES.has(route) && (isGzip(tok.bytes) || tok.bytes.includes(SQLITE))) leaked.push(route);
            }
        } finally {
            globalThis.setTimeout = realSetTimeout;
        }
        const beyond = taken.filter((r) => !STANDBY_ROUTES.has(r));
        assert(adminRoutes.length > 100 && beyond.length === 0,
            `2. ${stage}: of the ${adminRoutes.length} admin routes, the token alone is taken on none but the standby's `
            + `(${beyond.length ? `also: ${beyond.join(', ')}` : 'none else'})`);
        assert(leaked.length === 0, `2. ${stage}: …and no answer to it outside them is a backup or a database (${leaked.join(', ') || 'none'})`);
        const missing = [...STANDBY_ROUTES].filter((r) => !taken.includes(r));
        assert(missing.length === 0, `2. ${stage}: it is taken on every one of the standby's routes (${missing.join(', ') || 'all'})`);
    };
    await sweep('backups readable (no recovery code)');

    // ── 3. A readable backup carries no credential ───────────────────────────────────────────────────────────────
    console.log('\n— 3. no credential in a readable backup —');
    {
        const secrets = {
            totpSecret: 'JBSWY3DPEHPK3PXPOWNERGATE',
            totpBackupCodesHashes: ['b'.repeat(64)],
            backupAdminPassword: 'legacy-standby-plaintext-pw-4471',
            backupReplicationToken: 'a-standbys-own-token-4471',
        };
        updateLocalConfig({ ...secrets, totpEnabled: false });
        const cfg = getLocalConfig();
        const needles: [string, string][] = [
            ['the admin hash', cfg.adminHash!], ['its salt', cfg.salt!], ['the 2FA secret', secrets.totpSecret],
            ['a 2FA backup code hash', secrets.totpBackupCodesHashes[0]], ['the replication token hash', cfg.replicationTokenHash!],
            ["a standby's token", secrets.backupReplicationToken], ['the legacy plain-text password', secrets.backupAdminPassword],
        ];
        const readConfig = (archive: Buffer) => {
            const tar = zlib.gunzipSync(archive);
            const file = tarFiles(tar).get('node_config.json');
            return { tar, config: file ? JSON.parse(file.toString('utf8')) : null };
        };
        const r = await call('POST', '/api/local/admin/backup', asOwner);
        assert(r.status === 200 && isGzip(r.bytes) && r.headers.get('x-backup-locked') === 'no', `3. setup: /backup is the readable tar.gz (${r.status})`);
        const { tar, config } = readConfig(r.bytes);
        const inFile = needles.filter(([, v]) => JSON.stringify(config).includes(v)).map(([w]) => w);
        const inBytes = needles.filter(([, v]) => tar.includes(Buffer.from(v))).map(([w]) => w);
        assert(!!config && 'isLocked' in config && 'currencyValue' in config && inFile.length === 0,
            `3. its node_config.json keeps the settings and leaves out every credential (${inFile.join(', ') || 'none there'})`);
        assert(inBytes.length === 0, `3. …and no byte of the backup holds one (${inBytes.join(', ') || 'none'})`);

        // An older node's data/node_config.json, which the backup used to copy byte for byte.
        const legacyFile = path.join(dataDir!, 'node_config.json');
        fs.writeFileSync(legacyFile, JSON.stringify({ callsign: 'OldNode', adminHash: 'f'.repeat(128), backupAdminPassword: 'legacy-file-plaintext-4471' }));
        const r2 = await call('POST', '/api/local/admin/backup', asOwner);
        const legacy = readConfig(r2.bytes);
        assert(legacy.config?.callsign === 'OldNode' && !('adminHash' in legacy.config) && !('backupAdminPassword' in legacy.config)
            && !legacy.tar.includes(Buffer.from('legacy-file-plaintext-4471')),
            `3. from a legacy node_config.json too: its settings go, its credentials do not (${JSON.stringify(legacy.config)})`);
        fs.rmSync(legacyFile, { force: true });
        updateLocalConfig({ totpSecret: null, totpBackupCodesHashes: [], backupAdminPassword: null, backupReplicationToken: null });
    }

    // Locked backups from here on, and the sweep again.
    await makeRecoveryCode();
    const lockedNow = await call('POST', '/api/local/admin/backup', asOwner);
    assert(lockedNow.status === 200 && lockedNow.headers.get('x-backup-locked') === 'yes', '2. setup: with a recovery code, backups are locked');
    await sweep('backups locked (a recovery code)');

    // ── 4. A restore refuses what it should, and changes nothing ─────────────────────────────────────────────────
    console.log('\n— 4. what a restore refuses —');
    const restore = (bytes: Buffer) => call('POST', '/api/local/admin/restore', asOwner, bytes);
    const liveRoles = roles();
    const liveMembers = memberCount();
    const good = databaseCopy();
    const refusals: { what: string; archive: () => Buffer; status: number; words: RegExp; limits?: { maxBytes: number; maxMembers: number } }[] = [
        { what: 'a gzip bomb past the unpacked cap', status: 413, words: /too large/,
            limits: { maxBytes: 8 * 1024 ** 2, maxMembers: 1000 },
            archive: () => plainArchive(good, [{ name: './images/posts/bomb.bin', content: Buffer.alloc(64 * 1024 ** 2) }]) },
        { what: 'a bomb of padding (zeros past its end), refused as it streams', status: 413, words: /too large/,
            limits: { maxBytes: 8 * 1024 ** 2, maxMembers: 1000 },
            archive: () => zlib.gzipSync(Buffer.concat([tarBlocks([{ name: './state.db', content: good }]), Buffer.alloc(100 * 1024 ** 2)])) },
        { what: 'an archive past the member cap', status: 413, words: /more than 1000 files/,
            limits: { maxBytes: 8 * 1024 ** 2, maxMembers: 1000 },
            archive: () => plainArchive(good, Array.from({ length: 1001 }, (_, i) => ({ name: `./images/posts/f${i}.jpg`, content: Buffer.alloc(0) }))) },
        { what: 'a member whose header alone is past the real 4 GB cap', status: 413, words: /too large/,
            archive: () => tarGz([{ name: './state.db', content: good }, { name: './images/posts/huge.bin', size: 5 * 1024 ** 3 }], false) },
        { what: "a hard link out of the folder (busybox's case: to ../local-config.json)", status: 500, words: /links are not permitted/,
            archive: () => plainArchive(good, [{ name: './images/posts/leak.jpg', type: '1', link: '../local-config.json' }]) },
        { what: 'a symlink', status: 500, words: /links are not permitted/,
            archive: () => plainArchive(good, [{ name: './images/posts/leak.jpg', type: '2', link: '/etc/passwd' }]) },
        { what: 'a fifo', status: 500, words: /only plain files and folders/,
            archive: () => plainArchive(good, [{ name: './images/posts/pipe', type: '6' }]) },
        { what: 'a state.db that is not a database', status: 400, words: /not a SQLite database/,
            archive: () => plainArchive(Buffer.from('this is not a database at all')) },
        { what: 'a state.db that fails integrity_check', status: 400, words: /integrity check/,
            archive: () => {
                const bytes = databaseCopy((h) => {
                    h.exec(`CREATE TABLE zz_probe (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX zz_probe_v ON zz_probe(v);`);
                    const add = h.prepare('INSERT INTO zz_probe (v) VALUES (?)');
                    for (let i = 0; i < 40; i++) add.run(`value-${i}`);
                    h.pragma('journal_mode = DELETE');
                });
                // Scribble over the cells of the index's page: the file still opens, and its index no longer matches its rows.
                const pageSize = bytes.readUInt16BE(16) === 1 ? 65536 : bytes.readUInt16BE(16);
                const tmp = path.join(path.dirname(dataDir!), `owner-gate-corrupt-${process.pid}.db`);
                fs.writeFileSync(tmp, bytes);
                const h = new Database(tmp, { readonly: true });
                const root = (h.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'zz_probe_v'`).get() as { rootpage: number }).rootpage;
                h.close();
                fs.rmSync(tmp, { force: true });
                const pageEnd = root * pageSize;
                bytes.fill(0x5a, pageEnd - 400, pageEnd - 8);
                return plainArchive(bytes);
            } },
        { what: 'a state.db carrying a trigger this server does not have', status: 400, words: /does not have \(trigger "mint_on_every_update"\)/,
            archive: () => plainArchive(databaseCopy((h) => h.exec(
                `CREATE TRIGGER mint_on_every_update AFTER UPDATE ON members BEGIN UPDATE accounts SET balance = balance + 1000; END;`))) },
    ];
    for (const c of refusals) {
        const archive = c.archive();
        backupRoutes.setRestoreArchiveLimitsForTests?.(c.limits ?? null);
        const before = folder();
        const r = await restore(archive);
        backupRoutes.setRestoreArchiveLimitsForTests?.(null);
        const after = folder();
        const words = String(r.json?.error ?? '');
        assert(r.status === c.status && c.words.test(words), `4. ${c.what}: refused (${r.status}: ${words})`);
        const grew = folderBytes(after) - folderBytes(before);
        const added = [...after.keys()].filter((k) => !before.has(k));
        assert(leftovers().length === 0 && added.length === 0 && grew < 256 * 1024,
            `4. ${c.what}: the data folder is as it was (new: ${added.slice(0, 5).join(', ') || 'none'}; ${grew} bytes more)`);
        assert(roles() === liveRoles && memberCount() === liveMembers, `4. ${c.what}: the live database is untouched`);
    }
    assert(!fs.existsSync(path.join(dataDir!, 'images', 'posts', 'leak.jpg')), '4. no link landed in the image store');

    // ── 5. An owner's restore; a rewritten trigger does not survive it ───────────────────────────────────────────
    console.log("\n— 5. an owner's restore —");
    const realTrigger = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(TRIGGER) as { sql: string }).sql;
    const rewritten = `CREATE TRIGGER ${TRIGGER} AFTER UPDATE ON posts BEGIN UPDATE accounts SET balance = balance + 1000; END`;
    const backup = plainArchive(databaseCopy((h) => {
        h.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, 'RestoredMarker', ?, ?, 'TEST')`)
            .run(pubkey(), new Date().toISOString(), owner);
        h.exec(`DROP TRIGGER ${TRIGGER}; ${rewritten};`);
    }));
    const r = await call('POST', '/api/local/admin/restore', asOwner, backup);
    assert(r.status === 200 && r.json?.success === true, `5. an owner's key session restores a backup (${r.status}: ${JSON.stringify(r.json)?.slice(0, 160)})`);
    // This server served its standby's copies above (sync-snapshot), which opens a second connection. With it open, the
    // old database's -wal stayed beside the restored file and was played over it at the next open: the old members,
    // the new schema (found here, 2026-10-01).
    const beside = fs.readdirSync(dataDir!).filter((f) => f.startsWith('state.db'));
    assert(beside.length === 1, `5. nothing of the old database is left beside the restored one (${beside.join(', ')})`);
    const placed = new Database(path.join(dataDir!, 'state.db'), { readonly: true });
    const placedSql = (placed.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(TRIGGER) as { sql: string } | undefined)?.sql ?? null;
    const placedMarker = !!placed.prepare(`SELECT 1 FROM members WHERE callsign = 'RestoredMarker'`).get();
    placed.close();
    assert(placedMarker && placedSql !== rewritten && !String(placedSql).includes('balance + 1000'),
        `5. the backup's database is in place, without the rewritten trigger (${placedSql === null ? 'dropped' : 'kept as ' + placedSql.slice(0, 60)})`);
    assert(leftovers().length === 0, '5. nothing of the restore is left in the data folder');

    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--boot'], {
        env: { ...process.env }, encoding: 'utf-8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    });
    const line = (child.stdout || '').split('\n').find((l) => l.startsWith('CHILD_RESULT '));
    if (!line) console.error(child.stdout?.slice(-3000), child.stderr?.slice(-3000));
    const booted = line ? JSON.parse(line.slice('CHILD_RESULT '.length)) : null;
    assert(booted?.marker === true && booted.sql === realTrigger,
        `5. the restart makes the real ${TRIGGER} again, from this version's code (${booted?.sql === realTrigger ? 'the real one' : String(booted?.sql).slice(0, 60)})`);

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    console.log('⭐️ Backup owner-gate checks PASSED.');
    process.exit(0);
}

if (process.argv[2] === '--boot') {
    bootChild().catch((e) => { console.error('❌ Boot child failed:', e); process.exit(1); });
} else {
    main().catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
}
