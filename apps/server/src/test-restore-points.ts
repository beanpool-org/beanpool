/**
 * Test Suite: the hardened restore keeps a restore point first, and nothing but time removes one (design case 18,
 * scratch/global-node/DESIGN-owner-delete-fable.md §3, §9 S2, and its amendment 1).
 *
 * Over the real HTTPS server, through every middleware a node runs:
 *  1. A sealed restore onto a server with its own keys and its own data (a child process, its own data dir) writes
 *     data/restore-points/<ts>-before-restore/: the pre-restore state.db (a row planted on that server is in the point
 *     and not in the restored database), its images as hard links to the live store's objects, and the per-server tar
 *     holding the OLD libp2p_key; the folder is 0700 and every file 0600. The answer names the point, how long it is
 *     kept, and that the server restarts.
 *  2. After the restart (a child on the same data dir, wired as index.ts is) everyone gets the critical announcement
 *     and the log keeps the line; once.
 *  3. Roll back from the interface: an admin 403, a password session without a code 401 totpRequired, an owner's
 *     computer session 403 phone_required, a phone unlock 91 s old 403 step_up_required, each with nothing changed; a
 *     current code brings back the planted row and the old key, after taking a point of its own first (which holds the
 *     restored database), and leaves the notice.
 *  4. No room, no restore: a point that cannot be written (a full disk, as the filesystem reports it (ENOSPC) and as
 *     the point's database copy does (better-sqlite3's SQLITE_FULL, from the VACUUM INTO); a file where the folder
 *     should be) refuses the restore in words, and nothing is replaced: the live database, the node key, no point, no
 *     leftovers.
 *  5. No route removes a point: every /api/local/admin/* route the node serves, with every credential (none, an admin's
 *     key session, an admin token, an owner's computer session, a stale and a fresh phone unlock, a password session,
 *     the password with a current code), and the point's name in every parameter and body field, leaves the folder
 *     byte for byte as it was.
 *  6. Retention: snapshots/config keep:3 (with the owner's proof) and the hourly expiry leave a 1-day-old point and five
 *     within a week; a 31-day-old one goes, and an 8-day-old one past the newest five; past a week only the newest five stay.
 *  7. The code brake: wrong recovery codes from one source, each sent with the right password and an earlier 2FA session,
 *     are held by the source rule (429, reason 'source'), however often the password clears its own count. Its words
 *     are the take-over's: the recovery codes, never the admin password the owner typed right.
 *  S2b. Another community's locked file, opened with the uploader's own right code (design case 18 S2b, D1/D5), each row
 *     on its own child server:
 *     a. onto a lived-in server (an owner, an admin, a moderator, a member, a photo, 2FA on), with each credential that
 *        passes the gate (the password with an earlier 2FA session, a password session, the owner's computer session, a
 *        fresh phone hand-off, the password with a current code): 409 otherCommunity; node_roles, libp2p_key,
 *        genesis.json and local-config.json byte for byte as they were; no point, nothing left in the data folder;
 *     b. the same file with no take-over bundle inside: the same;
 *     c. "open with an owner's phone" there: 409, not 202; no file kept for the phone, no unlock started;
 *     d. onto a fresh server that was claimed (one owner, their own post, an enterprise): 200, the bundle applied, a
 *        point kept ("install, claim, restore");
 *     e. one invited member joins that server: 409; that member suspended: still 409;
 *     f. a lived-in server's own backup (this community, signed by this server) with its own code: still 200;
 *     h. a lived-in server whose genesis.json cannot be read: its own backup and the other community's are both 409,
 *        in their own words; nothing moved;
 *     i. the global profile, lived-in from its first sign-up: the other community's file is 409 there too.
 *  8. A plain archive naming a new owner, sent by the password with an earlier 2FA session, is refused 400 naming the
 *     command; no role moved, nothing extracted (#1984 confirmation 2, NON-BLOCKING 1: the last C6-shaped path).
 *
 * Run:
 *   SERVER_SUITES_ONLY=test-restore-points node scripts/run-server-suites.mjs
 * (It re-runs itself as a child with `--child <scenario>` for the servers whose database a restore replaces.)
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localFetch } from './keepalive-test-fetch.js';

const IS_CHILD = process.argv[2] === '--child';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        // Counted, and the run goes on, so a run against a server without these rows reports every hole, not the first.
        console.error(`✗ ${msg}`);
    }
}

const sha = (b: Buffer | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const MAIN_PW = 'Restore-Points-Main-Pw-7781!';
const FRESH_PW = 'Restore-Points-Fresh-Pw-3302!';
const PHOTO_KEY = 'posts/p-fresh/0-aabbccdd.jpg';

/** Nothing leaves this machine: any request to a host that is not loopback fails at once, in the parent and every child. */
function onlyLoopback(): void {
    const loopback = (h: unknown) => typeof h !== 'string' || h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
    for (const mod of [http, https] as any[]) {
        const real = mod.request;
        mod.request = function (this: unknown, ...args: any[]) {
            const o = args[0];
            const host = typeof o === 'string' ? new URL(o).hostname : o instanceof URL ? o.hostname : (o?.hostname ?? o?.host);
            if (!loopback(host)) throw new Error(`refused in tests: no request leaves this machine (${host})`);
            return real.apply(this, args);
        };
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (!loopback(u.hostname)) throw new Error(`refused in tests: no request leaves this machine (${u.hostname})`);
        return realFetch(input, init);
    }) as typeof fetch;
}

/** A real Ed25519 public key, hex: a backup is locked to every owner's key, and random bytes are a point about half the time. */
const edPublicKeyHex = (): string => crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

/** A minimal ustar writer, gzipped. */
function makeTarGz(entries: { name: string; content: Buffer }[]): Buffer {
    const blocks: Buffer[] = [];
    for (const e of entries) {
        const h = Buffer.alloc(512);
        h.write(e.name, 0, 100, 'utf8');
        h.write('0000644\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write(e.content.length.toString(8).padStart(11, '0') + '\0', 124);
        h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
        h.write('        ', 148);
        h.write('0', 156);
        h.write('ustar\0', 257);
        h.write('00', 263);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(h, e.content, Buffer.alloc((512 - (e.content.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

/** Every file under `dir`: relative path → size, sha and mode. A folder that is not there is `{}`. */
function treeOf(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string, rel: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(d, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            const st = fs.lstatSync(full);
            if (e.isDirectory()) { out[r + '/'] = (st.mode & 0o777).toString(8); walk(full, r); }
            else out[r] = `${st.size}:${(st.mode & 0o777).toString(8)}:${sha(fs.readFileSync(full))}`;
        }
    };
    walk(dir, '');
    return out;
}

// ── The child servers: their database is the one a restore or a roll-back replaces ─────────────────────────────────

async function child(): Promise<void> {
    const scenario = process.argv[3];
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    onlyLoopback();
    const result: Record<string, unknown> = { scenario };
    const read = (f: string) => { try { return fs.readFileSync(path.join(dataDir, f)); } catch { return null; } };
    const pointsDir = path.join(dataDir, 'restore-points');
    const points = () => { try { return fs.readdirSync(pointsDir).sort(); } catch { return []; } };
    const leftovers = () => fs.readdirSync(dataDir).filter((f) => f.startsWith('.restore') || f.startsWith('uploaded-backup'));
    const Database = (await import('better-sqlite3')).default;
    const callsignsIn = (file: string): string[] => {
        const d = new Database(file, { readonly: true });
        try { return (d.prepare('SELECT callsign FROM members ORDER BY callsign').all() as { callsign: string }[]).map((r) => r.callsign); } finally { d.close(); }
    };

    if (scenario === 'boot') {
        // The restart, wired as index.ts wires it: the notice is told to everyone and the log keeps it, once.
        const { initStateEngine, adminBroadcastAnnouncement } = await import('./state-engine.js');
        const { logger } = await import('./logger.js');
        initStateEngine();
        const { startRestoreNoticeWatch, deliverRestoreNotices } = await import('./services/restore-points.js');
        const announced: unknown[] = [];
        const logged: string[] = [];
        startRestoreNoticeWatch({
            announce: (title, body, severity) => { announced.push({ title, body, severity }); adminBroadcastAnnouncement(title, body, severity); },
            log: (m) => { logged.push(m); logger.security('ADMIN', m); },
        });
        const again = deliverRestoreNotices({ announce: () => { announced.push('again'); }, log: () => {} });
        result.announced = announced;
        result.logged = logged;
        result.again = again;
        result.noticesLeft = fs.readdirSync(dataDir).filter((f) => f.startsWith('restore-notice-'));
        console.log('CHILD_RESULT ' + JSON.stringify(result));
        process.exit(0);
    }

    if (scenario === 'make-other') {
        // Another community, made by someone who holds nothing of the server they aim at: its own key, its own owner, its
        // own recovery code; a locked backup as the node makes one, and one with no take-over bundle inside.
        const { initStateEngine, seedGenesisMember } = await import('./state-engine.js');
        const { db } = await import('./db/db.js');
        const { ensureGenesis } = await import('./genesis.js');
        const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
        const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
        const { getLocalConfig } = await import('./config/local-config.js');
        const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
        const { createSealedBackup } = await import('./services/sealed-backup.js');
        const core: any = await import('@beanpool/core');
        initStateEngine();
        await ensureGenesis();
        const key = await generateKeyPair('Ed25519');
        fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(key));
        const mallory = edPublicKeyHex();
        seedGenesisMember(mallory, 'Mallory');
        const otherCode = await makeRecoveryCode();
        const work = process.env.TEST_WORK!;
        const b = await createSealedBackup();
        const parts: Buffer[] = [];
        for await (const c of b.body) parts.push(c as Buffer);
        fs.writeFileSync(path.join(work, 'other.bpsealed'), Buffer.concat(parts));
        const copy = path.join(work, 'other-state.db');
        db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
        const community = JSON.parse(fs.readFileSync(path.join(dataDir, 'genesis.json'), 'utf8')).communityId;
        const bare = makeTarGz([{ name: './state.db', content: fs.readFileSync(copy) }, { name: './node_config.json', content: Buffer.from('{}') }]);
        fs.writeFileSync(path.join(work, 'other-bare.bpsealed'), Buffer.from(await core.sealEnvelope(new Uint8Array(bare), {
            kind: 'backup', communityId: community, nodePeerId: peerIdFromPrivateKey(key).toString(),
            recipients: { owners: [{ pubkey: mallory, callsign: 'Mallory' }], codes: [getLocalConfig().recoveryCode] },
            signingKey: new Uint8Array(key.raw.subarray(0, 32)),
        })));
        console.log('CHILD_RESULT ' + JSON.stringify({ scenario, ok: true, code: otherCode.code, community }));
        process.exit(0);
    }

    if (scenario === 'lived-in' || scenario === 'claimed') {
        // One row of S2b on a server of its own: a server that takes the file only replaces this child's data folder.
        const row = process.env.TEST_ROW!;
        const { initStateEngine, seedGenesisMember, grantNodeRole, createPost } = await import('./state-engine.js');
        const { db } = await import('./db/db.js');
        const { ensureGenesis } = await import('./genesis.js');
        const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
        const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
        const { resetAdminAuthTarpit } = await import('./admin-auth.js');
        const { turnOn2faForTests } = await import('./admin-auth-test-harness.js');
        const { mintHandshakeToken, consumeHandshakeToken, createPasswordSession, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
        const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
        const { createSealedBackup } = await import('./services/sealed-backup.js');
        const { initTls } = await import('./services/tls.js');
        const httpsServer = await import('./https-server.js');
        const { setRestoreRestartForTests } = await import('./routes/backup.js');
        setRestoreRestartForTests(() => { /* the test inspects the data dir instead of restarting */ });
        initStateEngine();
        await ensureGenesis();
        fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
        const { hash, salt } = hashPassword(MAIN_PW);
        updateLocalConfig({ adminHash: hash, salt, breakGlassMode: false } as any);
        const tfa = turnOn2faForTests(MAIN_PW);
        const owner = edPublicKeyHex();
        seedGenesisMember(owner, 'Vera');
        const join = (callsign: string, treasury = false): string => {
            const pk = crypto.randomBytes(32).toString('hex');
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, is_treasury) VALUES (?, ?, ?, ?, 'TEST', ?)`)
                .run(pk, callsign, new Date().toISOString(), owner, treasury ? 1 : 0);
            db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
            return pk;
        };
        if (scenario === 'lived-in') {
            grantNodeRole(join('Adam'), 'admin', owner);
            grantNodeRole(join('Mo'), 'moderator', owner);
            join('Pat');
            const photo = crypto.randomBytes(1800);
            fs.mkdirSync(path.dirname(path.join(dataDir, 'images', PHOTO_KEY)), { recursive: true });
            fs.writeFileSync(path.join(dataDir, 'images', PHOTO_KEY), photo);
            db.pragma('foreign_keys = OFF');
            db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, storage_key, sha256, bytes, mime) VALUES (?, NULL, 0, ?, ?, ?, 'image/jpeg')`)
                .run('p-fresh', PHOTO_KEY, sha(photo), photo.length);
            db.pragma('foreign_keys = ON');
        } else {
            // Claimed and poked around in: the owner's own post and an enterprise, nobody else.
            db.prepare("UPDATE members SET avatar_ref = 'members/vera.jpg' WHERE public_key = ?").run(owner);
            try {
                createPost('offer', 'general', "The owner's first post", 'Trying the server out', 1, 'fixed', owner);
                result.post = (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_pubkey = ?').get(owner) as { n: number }).n;
            } catch (e: any) { result.post = `ERR ${e?.message}`; }
            join('Vera & Co', true);
            if (row === 'e' || row === 'e-suspended') {
                const newcomer = join('Newcomer');
                if (row === 'e-suspended') db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(newcomer);
            }
        }
        const own = await makeRecoveryCode();
        let ownFile: Buffer | null = null;
        if (row === 'f' || row === 'h-own') {
            const b = await createSealedBackup();
            const parts: Buffer[] = [];
            for await (const c of b.body) parts.push(c as Buffer);
            ownFile = Buffer.concat(parts);
        }
        await initTls();
        const port = await httpsServer.startHttpsServer(0);
        const base = `https://localhost:${port}`;
        const call = async (method: string, route: string, headers: Record<string, string>, body: Uint8Array | object) => {
            resetAdminAuthTarpit();
            httpsServer.resetAdminRateLimit();
            const raw = body instanceof Uint8Array;
            const r = await localFetch(base + route, {
                method, headers: { ...headers, 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
                body: raw ? (body as BodyInit) : JSON.stringify(body),
            });
            const text = await r.text();
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* not json */ }
            return { status: r.status, json };
        };
        const keySession = (pk: string, phone = false): string => {
            const ex = consumeHandshakeToken(mintHandshakeToken(pk, 'owner').handshakeToken, Date.now(), phone ? { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS } : {});
            if (!ex.ok) throw new Error(`setup: no owner session: ${ex.error}`);
            return ex.sessionId!;
        };
        const signIn = await call('POST', '/api/local/verify-password', {}, { password: MAIN_PW, totpCode: tfa.code() });
        const tfaSession: string = signIn.json?.tfaSessionToken;
        const creds: Record<string, () => Record<string, string>> = {
            'the password with an earlier 2FA session': () => ({ 'X-Admin-Password': MAIN_PW, 'X-Admin-2FA-Session': tfaSession }),
            'a password session': () => ({ 'x-admin-session': createPasswordSession().sessionId }),
            "the owner's computer session": () => ({ 'x-admin-session': keySession(owner) }),
            'a fresh phone hand-off': () => ({ 'x-admin-session': keySession(owner, true) }),
            'the password with a current code': () => tfa.headers(),
        };
        // Read from the files, by a handle of its own: a server that took the file has closed its own.
        const state = () => {
            let roles: string;
            try {
                const d = new Database(path.join(dataDir, 'state.db'), { readonly: true });
                try { roles = JSON.stringify(d.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all()); } finally { d.close(); }
            } catch (e: any) { roles = `unreadable: ${e?.message}`; }
            const h = (f: string) => { const b = read(f); return b ? sha(b) : null; };
            return { roles, key: h('libp2p_key'), genesis: h('genesis.json'), config: h('local-config.json'), points: points(), leftovers: leftovers() };
        };
        const otherFile = new Uint8Array(fs.readFileSync(process.env.TEST_OTHER_FILE!));
        const otherCode = process.env.TEST_OTHER_CODE!;
        const brief = (r: { status: number; json: any }) => ({ status: r.status, ...(r.json ?? {}) });
        result.signIn = signIn.status;
        if (row.startsWith('a:')) {
            const before = state();
            const r = await call('POST', '/api/local/admin/restore', { ...creds[row.slice(2)](), 'X-Recovery-Code': otherCode }, otherFile);
            Object.assign(result, { answer: brief(r), before, after: state() });
        } else if (row === 'b') {
            const before = state();
            const r = await call('POST', '/api/local/admin/restore', { ...creds['the password with an earlier 2FA session'](), 'X-Recovery-Code': otherCode },
                new Uint8Array(fs.readFileSync(process.env.TEST_OTHER_BARE!)));
            Object.assign(result, { answer: brief(r), before, after: state() });
        } else if (row === 'c') {
            const before = state();
            const r = await call('POST', '/api/local/admin/restore',
                { ...creds['the password with an earlier 2FA session'](), 'X-Unlock-With': 'phone', 'X-Unlock-Server-Url': base }, otherFile);
            Object.assign(result, { answer: brief(r), before, after: state(),
                pending: fs.readdirSync(dataDir).filter((f) => f.startsWith('uploaded-backup')) });
        } else if (row === 'd' || row === 'e' || row === 'e-suspended') {
            const before = state();
            const r = await call('POST', '/api/local/admin/restore', { ...creds['the password with a current code'](), 'X-Recovery-Code': otherCode }, otherFile);
            let community: string | null = null;
            try { community = JSON.parse(read('genesis.json')!.toString('utf8')).communityId; } catch { /* unreadable */ }
            Object.assign(result, { answer: brief(r), before, after: state(), community });
        } else if (row === 'f') {
            const r = await call('POST', '/api/local/admin/restore', { ...creds['the password with an earlier 2FA session'](), 'X-Recovery-Code': own.code }, new Uint8Array(ownFile!));
            Object.assign(result, { answer: brief(r), after: state() });
        } else if (row === 'h-own' || row === 'h-other') {
            fs.writeFileSync(path.join(dataDir, 'genesis.json'), '{ this is not the community record');
            const before = state();
            const r = await call('POST', '/api/local/admin/restore', { ...creds['the password with an earlier 2FA session'](),
                'X-Recovery-Code': row === 'h-own' ? own.code : otherCode }, row === 'h-own' ? new Uint8Array(ownFile!) : otherFile);
            Object.assign(result, { answer: brief(r), before, after: state() });
        }
        console.log('CHILD_RESULT ' + JSON.stringify(result));
        process.exit(0);
    }

    const { initStateEngine, seedGenesisMember, grantNodeRole } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { initTls } = await import('./services/tls.js');
    const httpsServer = await import('./https-server.js');
    const { setRestoreRestartForTests } = await import('./routes/backup.js');
    setRestoreRestartForTests(() => { /* the test inspects the data dir instead of restarting */ });

    initStateEngine();
    let tfa: ReturnType<typeof turnOn2faForTests>;
    if (scenario === 'restore' || scenario === 'full') {
        // A server with its own community, its own node key, its own password and 2FA, its own member and photo.
        await ensureGenesis();
        fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
        const { hash, salt } = hashPassword(FRESH_PW);
        updateLocalConfig({ adminHash: hash, salt });
        tfa = turnOn2faForTests(FRESH_PW);
        seedGenesisMember(crypto.randomBytes(32).toString('hex'), 'FreshServerRow');
        const photo = crypto.randomBytes(1800);
        fs.mkdirSync(path.dirname(path.join(dataDir, 'images', PHOTO_KEY)), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'images', PHOTO_KEY), photo);
        db.pragma('foreign_keys = OFF');
        db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, storage_key, sha256, bytes, mime) VALUES (?, NULL, 0, ?, ?, ?, 'image/jpeg')`)
            .run('p-fresh', PHOTO_KEY, sha(photo), photo.length);
    } else {
        // 'rollback': the restored server after its restart. It holds the main server's password; 2FA for this run.
        tfa = turnOn2faForTests(MAIN_PW);
    }
    void seedGenesisMember; void grantNodeRole;
    await initTls();
    const port = await httpsServer.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const backupBytes = new Uint8Array(fs.readFileSync(process.env.TEST_BACKUP_FILE!));
    const restore = async (headers: Record<string, string>) => {
        resetAdminAuthTarpit();
        httpsServer.resetAdminRateLimit();
        const r = await localFetch(base + '/api/local/admin/restore', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: backupBytes,
        });
        return { status: r.status, body: await r.json() as any };
    };
    result.keyBefore = sha(read('libp2p_key')!);

    if (scenario === 'restore') {
        const liveIno = fs.statSync(path.join(dataDir, 'images', PHOTO_KEY)).ino;
        const r = await restore({ ...tfa.headers(), 'X-Recovery-Code': process.env.TEST_RECOVERY_CODE! });
        result.status = r.status;
        result.body = r.body;
        const names = points();
        result.points = names;
        const p = names[0] ? path.join(pointsDir, names[0]) : null;
        if (p) {
            const mode = (f: string) => { try { return (fs.statSync(f).mode & 0o777).toString(8); } catch { return null; } };
            result.modes = {
                root: mode(pointsDir), point: mode(p), db: mode(path.join(p, 'state.db')),
                tar: mode(path.join(p, 'server-files.tar.gz')), meta: mode(path.join(p, 'point.json')),
            };
            result.pointCallsigns = callsignsIn(path.join(p, 'state.db'));
            const img = path.join(p, 'state.db.images', PHOTO_KEY);
            result.imageLinked = fs.existsSync(img) && fs.statSync(img).ino === liveIno;
            const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-point-tar-'));
            spawnSync('tar', ['-xzf', path.join(p, 'server-files.tar.gz'), '-C', unpacked]);
            result.tarFiles = fs.readdirSync(unpacked).sort();
            result.tarKey = fs.existsSync(path.join(unpacked, 'libp2p_key')) ? sha(fs.readFileSync(path.join(unpacked, 'libp2p_key'))) : null;
            fs.rmSync(unpacked, { recursive: true, force: true });
        }
        result.liveCallsigns = callsignsIn(path.join(dataDir, 'state.db'));
        result.keyAfter = sha(read('libp2p_key')!);
        result.notices = fs.readdirSync(dataDir).filter((f) => f.startsWith('restore-notice-'))
            .map((f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')));
        result.leftovers = leftovers();
    }

    if (scenario === 'full') {
        const { failNextRestorePointForTests } = await import('./services/restore-points.js');
        const before = () => ({ key: sha(read('libp2p_key')!), callsigns: (db.prepare('SELECT callsign FROM members ORDER BY callsign').all() as any[]).map((r) => r.callsign) });
        result.before = before();
        failNextRestorePointForTests('ENOSPC');
        const full = await restore({ ...tfa.headers(), 'X-Recovery-Code': process.env.TEST_RECOVERY_CODE! });
        result.full = { status: full.status, body: full.body, after: before(), points: points(), leftovers: leftovers() };
        // A real full disk fails the point at its database copy, the VACUUM INTO, with better-sqlite3's SQLITE_FULL.
        failNextRestorePointForTests('SQLITE_FULL');
        const sqliteFull = await restore({ ...tfa.headers(), 'X-Recovery-Code': process.env.TEST_RECOVERY_CODE! });
        result.sqliteFull = { status: sqliteFull.status, body: sqliteFull.body, after: before(), points: points(), leftovers: leftovers() };
        // A file where the restore points' folder should be: the filesystem itself refuses the point.
        fs.rmSync(pointsDir, { recursive: true, force: true });
        fs.writeFileSync(pointsDir, 'not a folder');
        const blocked = await restore({ ...tfa.headers(), 'X-Recovery-Code': process.env.TEST_RECOVERY_CODE! });
        result.blocked = { status: blocked.status, body: blocked.body, after: before(), leftovers: leftovers(), stillAFile: fs.lstatSync(pointsDir).isFile() };
    }

    if (scenario === 'rollback') {
        const { mintHandshakeToken, consumeHandshakeToken, createPasswordSession, backdateAdminSessionForTests, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
        const owner = process.env.TEST_OWNER!;
        const admin = process.env.TEST_ADMIN!;
        const keySession = (pk: string, role: 'owner' | 'admin', phone = false): string => {
            const ex = consumeHandshakeToken(mintHandshakeToken(pk, role).handshakeToken, Date.now(), phone ? { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS } : {});
            if (!ex.ok) throw new Error(`setup: no ${role} session: ${ex.error}`);
            return ex.sessionId!;
        };
        const call = async (method: string, route: string, headers: Record<string, string>, body?: unknown) => {
            resetAdminAuthTarpit();
            httpsServer.resetAdminRateLimit();
            const init: RequestInit = { method, headers: { ...headers } };
            if (method !== 'GET') { (init.headers as any)['Content-Type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
            const r = await localFetch(base + route, init);
            const text = await r.text();
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* not json */ }
            return { status: r.status, json };
        };
        const listed = await call('GET', '/api/local/admin/restore-points', { 'x-admin-session': createPasswordSession().sessionId });
        result.listed = listed;
        const name = listed.json?.points?.[0]?.name;
        const state = () => ({ points: points(), key: sha(read('libp2p_key')!), callsigns: callsignsIn(path.join(dataDir, 'state.db')) });
        const before = state();
        result.before = before;
        const stale = keySession(owner, 'owner', true);
        backdateAdminSessionForTests(stale, 91_000);
        const refusals: Record<string, unknown> = {};
        for (const [who, headers] of [
            ['admin', { 'x-admin-session': keySession(admin, 'admin') }],
            ['password session, no code', { 'x-admin-session': createPasswordSession().sessionId }],
            ['computer', { 'x-admin-session': keySession(owner, 'owner') }],
            ['stale phone', { 'x-admin-session': stale }],
            ['no credential', {}],
        ] as Array<[string, Record<string, string>]>) {
            const r = await call('POST', '/api/local/admin/restore-points/roll-back', headers, { name });
            refusals[who] = { status: r.status, code: r.json?.code, totpRequired: r.json?.totpRequired, error: r.json?.error, same: JSON.stringify(state()) === JSON.stringify(before) };
        }
        result.refusals = refusals;
        const unknown = await call('POST', '/api/local/admin/restore-points/roll-back', { 'x-admin-session': createPasswordSession().sessionId },
            { name: '2020-01-01T00-00-00.000Z-before-restore', code: tfa.code() });
        result.unknown = { status: unknown.status, error: unknown.json?.error };
        const done = await call('POST', '/api/local/admin/restore-points/roll-back', { 'x-admin-session': createPasswordSession().sessionId }, { name, code: tfa.code() });
        result.done = done;
        result.after = { points: points(), key: sha(read('libp2p_key')!), callsigns: callsignsIn(path.join(dataDir, 'state.db')) };
        const own = points().find((n) => n.endsWith('-before-roll-back'));
        result.ownPointCallsigns = own ? callsignsIn(path.join(pointsDir, own, 'state.db')) : null;
        result.notices = fs.readdirSync(dataDir).filter((f) => f.startsWith('restore-notice-'))
            .map((f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')));
        const cfg = JSON.parse(read('local-config.json')!.toString('utf8'));
        result.passwordIsFresh = (await import('./config/local-config.js')).verifyPassword(FRESH_PW, cfg.adminHash, cfg.salt);
        result.leftovers = leftovers();
    }
    console.log('CHILD_RESULT ' + JSON.stringify(result));
    process.exit(0);
}

function runChild(scenario: string, dataDir: string, env: Record<string, string>): any {
    const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--child', scenario], {
        env: { ...process.env, ...env, BEANPOOL_DATA_DIR: dataDir }, encoding: 'utf-8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024,
    });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('CHILD_RESULT '));
    if (!line) {
        console.error(r.stdout?.slice(-3000), r.stderr?.slice(-3000));
        assert(false, `the ${scenario} child printed a result (exit ${r.status})`);
        return {};
    }
    return { ...JSON.parse(line.slice('CHILD_RESULT '.length)), logs: `${r.stdout}\n${r.stderr}` };
}

// ── The main server (this process) ─────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');
    onlyLoopback();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-points-'));

    // The address service, a stub on loopback that knows nothing.
    const registrar = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.statusCode = 404; res.end('{"error":"not found"}'); }); });
    await new Promise<void>((r) => registrar.listen(0, '127.0.0.1', () => r()));
    process.env.REGISTRAR_URL = `http://127.0.0.1:${(registrar.address() as any).port}`;

    const { initStateEngine, seedGenesisMember, grantNodeRole } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { mintHandshakeToken, consumeHandshakeToken, createPasswordSession, backdateAdminSessionForTests, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
    const { turnOn2faForTests, ownerTokenHeaders } = await import('./admin-auth-test-harness.js');
    const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
    const { createSealedBackup } = await import('./services/sealed-backup.js');
    const snapshots = await import('./services/snapshot-scheduler.js');
    const rp: any = await import('./services/restore-points.js').catch(() => ({}));
    const { initTls } = await import('./services/tls.js');
    const httpsServer = await import('./https-server.js');
    const { setRestoreRestartForTests } = await import('./routes/backup.js');
    setRestoreRestartForTests(() => { /* this process is never restarted by a route */ });

    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const { hash, salt } = hashPassword(MAIN_PW);
    updateLocalConfig({ adminHash: hash, salt, breakGlassMode: false } as any);
    const tfa = turnOn2faForTests(MAIN_PW);
    const owner = crypto.randomBytes(32).toString('hex');
    const admin = crypto.randomBytes(32).toString('hex');
    seedGenesisMember(owner, 'Olive');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
        .run(admin, 'Adam', new Date().toISOString(), owner, 'TEST');
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(admin);
    grantNodeRole(admin, 'admin', owner);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
        .run('ab'.repeat(32), 'RoundTripMarker', new Date().toISOString(), owner, 'TEST');
    const code = await makeRecoveryCode();
    const backupFile = path.join(work, 'backup.bpsealed');
    {
        const b = await createSealedBackup();
        const parts: Buffer[] = [];
        for await (const c of b.body) parts.push(c as Buffer);
        fs.writeFileSync(backupFile, Buffer.concat(parts));
    }
    const mainKey = sha(fs.readFileSync(path.join(dataDir!, 'libp2p_key')));
    const childEnv = { TEST_BACKUP_FILE: backupFile, TEST_RECOVERY_CODE: code.code, TEST_OWNER: owner, TEST_ADMIN: admin };

    // ── 1. A sealed restore keeps a point first ──
    console.log('\n── 1. a sealed restore keeps a restore point of the server it replaces ──');
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-points-fresh-'));
    try {
        const rs = runChild('restore', freshDir, childEnv);
        assert(rs.status === 200 && rs.body?.success === true && rs.body?.restoredKeys === true,
            `1. the sealed backup restores onto a server with its own keys (${rs.status} ${JSON.stringify(rs.body).slice(0, 160)})`);
        const name: string = rs.points?.[0] ?? '';
        assert(rs.points?.length === 1 && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-before-restore$/.test(name),
            `1. data/restore-points/<ts>-before-restore/ was written (${JSON.stringify(rs.points)})`);
        assert(rs.body?.restorePoint?.name === name && typeof rs.body?.restorePointNote === 'string' && rs.body.restorePointNote.includes(name)
            && /kept until at least \d{4}-\d{2}-\d{2}/.test(rs.body.restorePointNote) && rs.body?.restartNote === 'The server restarts now; sign in again.'
            && rs.body.restorePointNote.endsWith('or on the server with `beanpool restore-point`.'),
            `1. the answer names the point, how long it is kept, and the restart (${rs.body?.restorePointNote} / ${rs.body?.restartNote})`);
        assert(rs.pointCallsigns?.includes('FreshServerRow') && !rs.pointCallsigns?.includes('RoundTripMarker'),
            `1. the point holds the pre-restore database: the planted row is in it (${JSON.stringify(rs.pointCallsigns)})`);
        assert(!rs.liveCallsigns?.includes('FreshServerRow') && rs.liveCallsigns?.includes('RoundTripMarker'),
            '1. …and not in the restored database, which is the backup\'s');
        assert(rs.imageLinked === true, '1. the image the old database references is in the point, a hard link to the live object (same inode)');
        assert(rs.tarKey === rs.keyBefore && rs.keyAfter === mainKey && rs.keyBefore !== mainKey,
            '1. the per-server tar holds the OLD libp2p_key; the live one is now the backup\'s');
        assert(['genesis.json', 'libp2p_key', 'local-config.json'].every((f) => rs.tarFiles?.includes(f)) && rs.tarFiles?.every((f: string) => !f.startsWith('.') || f === '.'),
            `1. …with the server's genesis and config beside it (${JSON.stringify(rs.tarFiles)})`);
        assert(rs.modes?.root === '700' && rs.modes?.point === '700' && rs.modes?.db === '600' && rs.modes?.tar === '600' && rs.modes?.meta === '600',
            `1. the folders are 0700 and the files 0600 (${JSON.stringify(rs.modes)})`);
        assert(rs.notices?.length === 1 && rs.notices[0].kind === 'restore' && rs.notices[0].point === name,
            `1. the notice for the next boot is left in the data folder (${JSON.stringify(rs.notices)})`);
        assert(Array.isArray(rs.leftovers) && rs.leftovers.length === 0, `1. nothing of the restore is left behind (${JSON.stringify(rs.leftovers)})`);

        // ── 2. The restart tells everyone ──
        console.log('\n── 2. after the restart: the announcement and the log line ──');
        const boot = runChild('boot', freshDir, childEnv);
        const ann = (boot.announced ?? [])[0];
        assert(boot.announced?.length === 1 && ann?.severity === 'critical'
            && /^This community was restored from a backup made \d{4}-\d{2}-\d{2}, by an owner\. Anything since then is gone\. If you did not expect this, tell your community's owners\.$/.test(ann?.body ?? ''),
            `2. everyone gets the critical announcement, on the restored database (${JSON.stringify(ann)})`);
        assert(boot.logged?.length === 1 && boot.logged[0].startsWith('[RESTORE] This community was restored') && boot.logged[0].includes(name)
            && /\[RESTORE\] This community was restored/.test(boot.logs),
            '2. …and the log keeps the line, naming the point');
        assert(boot.again === 0 && boot.noticesLeft?.length === 0, '2. …once: the notice is gone and a second delivery tells nothing');

        // ── 3. Roll back from the interface ──
        console.log('\n── 3. roll back: owner + fresh proof, its own point first ──');
        const rb = runChild('rollback', freshDir, childEnv);
        assert(rb.listed?.status === 200 && rb.listed.json?.points?.length === 1 && rb.listed.json.points[0].name === name,
            `3. the owner lists the restore point (${rb.listed?.status} ${JSON.stringify(rb.listed?.json).slice(0, 160)})`);
        const ref = rb.refusals ?? {};
        assert(ref['admin']?.status === 403 && ref['admin'].same, `3. an admin is refused, nothing changed (${JSON.stringify(ref['admin'])})`);
        assert(ref['password session, no code']?.status === 401 && ref['password session, no code'].totpRequired === true && ref['password session, no code'].same,
            `3. a password session without a code: 401 totpRequired, nothing changed (${JSON.stringify(ref['password session, no code'])})`);
        assert(ref['computer']?.status === 403 && ref['computer'].code === 'phone_required' && ref['computer'].same,
            `3. an owner's computer session: 403 phone_required, nothing changed (${JSON.stringify(ref['computer'])})`);
        assert(ref['stale phone']?.status === 403 && ref['stale phone'].code === 'step_up_required' && ref['stale phone'].same,
            `3. a phone unlock 91 s old: 403 step_up_required, nothing changed (${JSON.stringify(ref['stale phone'])})`);
        assert(ref['no credential']?.status === 401 && ref['no credential'].same, `3. no credential: 401 (${JSON.stringify(ref['no credential'])})`);
        assert(rb.unknown?.status === 404, `3. a point that is not there: 404 (${JSON.stringify(rb.unknown)})`);
        assert(rb.done?.status === 200 && rb.done.json?.success === true && rb.done.json?.rolledBackTo === name,
            `3. with a current code the owner rolls back (${rb.done?.status} ${JSON.stringify(rb.done?.json).slice(0, 200)})`);
        assert(rb.after?.callsigns?.includes('FreshServerRow') && !rb.after.callsigns.includes('RoundTripMarker'),
            `3. the planted row is back, the backup's rows gone (${JSON.stringify(rb.after?.callsigns)})`);
        assert(rb.after?.key === rs.keyBefore, '3. the old node key is back');
        assert(rb.passwordIsFresh === true, "3. and so is the server's own admin password (local-config.json from the point)");
        const own = (rb.after?.points ?? []).filter((n: string) => n.endsWith('-before-roll-back'));
        assert(own.length === 1 && rb.after.points.includes(name) && rb.done.json?.restorePoint?.name === own[0],
            `3. it took a point of its own first, and the one it rolled back to is still there (${JSON.stringify(rb.after?.points)})`);
        assert(rb.ownPointCallsigns?.includes('RoundTripMarker') && !rb.ownPointCallsigns.includes('FreshServerRow'),
            '3. …holding the database it replaced, so the roll-back can be undone the same way');
        assert(rb.notices?.length === 1 && rb.notices[0].kind === 'roll-back' && rb.notices[0].point === own[0],
            `3. the roll-back leaves the notice too (${JSON.stringify(rb.notices)})`);
        assert(Array.isArray(rb.leftovers) && rb.leftovers.length === 0, '3. nothing of the roll-back is left behind');
    } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
    }

    // ── 4. No room, no restore ──
    console.log('\n── 4. a point that cannot be written refuses the restore, nothing replaced ──');
    const fullDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-points-full-'));
    try {
        const fl = runChild('full', fullDir, childEnv);
        assert(fl.full?.status === 507 && fl.full.body?.restorePointFailed === true && /could not keep a restore point first, because its disk is full/.test(fl.full.body?.error || ''),
            `4. a full disk: refused in words (${fl.full?.status} ${fl.full?.body?.error})`);
        assert(JSON.stringify(fl.full?.after) === JSON.stringify(fl.before) && fl.full?.points?.length === 0 && fl.full?.leftovers?.length === 0,
            `4. …the live database and the node key as they were, no point, no leftovers (${JSON.stringify(fl.full?.points)} ${JSON.stringify(fl.full?.leftovers)})`);
        assert(fl.sqliteFull?.status === 507 && fl.sqliteFull.body?.restorePointFailed === true
            && /could not keep a restore point first, because its disk is full\. Free some space/.test(fl.sqliteFull.body?.error || '')
            && !/SQLITE_FULL|Check that the data folder can be written to/.test(fl.sqliteFull.body?.error || ''),
            `4. a full disk as SQLite reports it (SQLITE_FULL, from the point's VACUUM INTO): 507, the same words (${fl.sqliteFull?.status} ${fl.sqliteFull?.body?.error})`);
        assert(JSON.stringify(fl.sqliteFull?.after) === JSON.stringify(fl.before) && fl.sqliteFull?.points?.length === 0 && fl.sqliteFull?.leftovers?.length === 0,
            `4. …nothing replaced, no point, and no cut-short copy left (${JSON.stringify(fl.sqliteFull?.points)} ${JSON.stringify(fl.sqliteFull?.leftovers)})`);
        assert(fl.blocked?.status >= 500 && fl.blocked.body?.restorePointFailed === true && /Nothing was restored: this server could not keep a restore point first/.test(fl.blocked.body?.error || ''),
            `4. a file where the folder should be: refused in words (${fl.blocked?.status} ${fl.blocked?.body?.error})`);
        assert(JSON.stringify(fl.blocked?.after) === JSON.stringify(fl.before) && fl.blocked?.leftovers?.length === 0 && fl.blocked?.stillAFile === true,
            '4. …nothing replaced, and the file left as it was');
    } finally {
        fs.rmSync(fullDir, { recursive: true, force: true });
    }

    // ── This process's own server, for the rows that replace nothing ──
    await initTls();
    const port = await httpsServer.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const keySession = (pk: string, role: 'owner' | 'admin', phone = false): string => {
        const ex = consumeHandshakeToken(mintHandshakeToken(pk, role).handshakeToken, Date.now(), phone ? { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS } : {});
        if (!ex.ok) throw new Error(`setup: no ${role} session: ${ex.error}`);
        return ex.sessionId!;
    };
    async function call(method: string, route: string, headers: Record<string, string> = {}, body?: unknown, raw?: Buffer, keepBrake = false) {
        if (!keepBrake) resetAdminAuthTarpit();
        httpsServer.resetAdminRateLimit();
        const init: RequestInit = { method, headers: { ...headers }, signal: AbortSignal.timeout(20_000) };
        if (raw) { (init.headers as any)['Content-Type'] = 'application/octet-stream'; init.body = new Uint8Array(raw); }
        else if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') { (init.headers as any)['Content-Type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
        try {
            const res = await localFetch(base + route, init);
            const text = await res.text();
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* not json */ }
            return { status: res.status, text, json };
        } catch (e: any) {
            return { status: 0, text: String(e?.message || e), json: null };
        }
    }
    const signIn = await call('POST', '/api/local/verify-password', {}, { password: MAIN_PW, totpCode: tfa.code() });
    const tfaSession: string = signIn.json?.tfaSessionToken;
    assert(signIn.status === 200 && typeof tfaSession === 'string', `setup: the password and a code sign in, with a 2FA session (${signIn.status})`);
    const earlier2fa = (): Record<string, string> => ({ 'X-Admin-Password': MAIN_PW, 'X-Admin-2FA-Session': tfaSession });

    // ── 7. The code brake ──
    console.log('\n── 7. wrong codes from one source, each with the right password, meet the source rule ──');
    {
        const core = await import('@beanpool/core');
        const wrongCode = (await core.createRecoveryCode(code.codeId)).code;
        const bytes = fs.readFileSync(backupFile);
        let heldAt = 0;
        let held: any = null;
        const statuses: number[] = [];
        for (let i = 1; i <= 30; i++) {
            // The password brake is kept between these requests: it is the one under test.
            const r = await call('POST', '/api/local/admin/restore', { ...earlier2fa(), 'X-Recovery-Code': wrongCode }, undefined, bytes, true);
            statuses.push(r.status);
            if (r.status === 429) { heldAt = i; held = r.json; break; }
            if (r.status !== 403 || r.json?.wrongCode !== true) break;
        }
        assert(heldAt > 1 && held?.reason === 'source' && held?.passwordBackoff === true,
            `7. held by the source rule after ${heldAt - 1} wrong codes, each sent with the right password (429, reason ${held?.reason}; ${statuses.join(',')})`);
        assert(/^Too many wrong recovery codes from your network\. Try again in \d+s\.$/.test(held?.error || '') && !/password/i.test(held?.error || ''),
            `7. …and says it is the recovery codes, not the password (${held?.error})`);
    }

    // ── 5. No route removes a point ──
    console.log('\n── 5. no route removes a restore point: every admin route, every credential ──');
    {
        const point = rp.takeRestorePoint ? rp.takeRestorePoint('restore') : null;
        assert(!!point?.name, `setup: a restore point exists (${point?.name})`);
        const name = point?.name ?? 'none';
        const pointsDir = path.join(dataDir!, 'restore-points');
        const before = treeOf(pointsDir);
        assert(Object.keys(before).length >= 4, `setup: the point holds its files (${Object.keys(before).length})`);
        const app: any = httpsServer.getKoaApp();
        const routes: Array<[string, string]> = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
            .flatMap((l: any) => (l.methods as string[]).filter((m) => m !== 'HEAD').map((m) => `${m} ${l.path}`)))]
            .filter((r) => r.split(' ')[1].startsWith('/api/local/admin/'))
            .sort()
            .map((r) => r.split(' ') as [string, string]);
        assert(routes.length > 150, `the sweep has every admin route the node serves (${routes.length})`);
        const pointRoutes = routes.filter(([, p]) => p.includes('restore-points')).map(([m, p]) => `${m} ${p}`);
        assert(JSON.stringify(pointRoutes) === JSON.stringify(['GET /api/local/admin/restore-points', 'POST /api/local/admin/restore-points/roll-back']),
            `the only restore-point routes are the list and the roll-back (${pointRoutes.join(', ')})`);
        const adminToken = ownerTokenHeaders('admin', owner);
        const credentials: Array<[string, () => Record<string, string>]> = [
            ['no credential', () => ({})],
            ['an admin key session', () => ({ 'x-admin-session': keySession(admin, 'admin') })],
            ['an admin automation token', () => adminToken],
            ['an owner key session (computer)', () => ({ 'x-admin-session': keySession(owner, 'owner') })],
            ['an owner key session (phone, 91 s)', () => { const s = keySession(owner, 'owner', true); backdateAdminSessionForTests(s, 91_000); return { 'x-admin-session': s }; }],
            ['a password session', () => ({ 'x-admin-session': createPasswordSession().sessionId })],
            ['an owner key session (phone, just unlocked)', () => ({ 'x-admin-session': keySession(owner, 'owner', true) })],
            ['the owner password with a code', () => tfa.headers()],
        ];
        const fill = (p: string) => p.replace(/:[A-Za-z]+/g, encodeURIComponent(name));
        const bait = { name, names: [name], point: name, path: `restore-points/${name}`, file: name, id: name, keep: 3, code: '' };
        let sent = 0;
        let rolledBack = 0;
        const changedAfter: string[] = [];
        for (const [who, headers] of credentials) {
            for (const [m, p] of routes) {
                // The roll-back with a proof that passes is the one route meant to add a point (row 3 runs it, in a child).
                const proven = who.includes('just unlocked') || who.includes('with a code');
                if (p === '/api/local/admin/restore-points/roll-back' && proven) { rolledBack++; continue; }
                const h = headers();
                const body = proven && m !== 'GET' ? { ...bait, code: tfa.code() } : bait;
                const q = m === 'GET' || m === 'DELETE' ? `?name=${encodeURIComponent(name)}&path=${encodeURIComponent(`restore-points/${name}`)}` : '';
                await call(m, fill(p) + q, h, body);
                sent++;
                const now = JSON.stringify(treeOf(pointsDir));
                if (now !== JSON.stringify(before) && changedAfter.length < 5) changedAfter.push(`${who}: ${m} ${p}`);
            }
        }
        assert(sent > routes.length * credentials.length - credentials.length - 1 && rolledBack === 2,
            `the sweep sent ${sent} requests (${routes.length} routes × ${credentials.length} credentials, the proven roll-back skipped twice)`);
        assert(JSON.stringify(treeOf(pointsDir)) === JSON.stringify(before) && changedAfter.length === 0,
            `5. the restore point is byte for byte as it was (${changedAfter.join(' | ') || 'no request changed it'})`);
    }

    // ── 6. Retention ──
    console.log('\n── 6. retention: fixed in code, on the hourly expiry ──');
    {
        const pointsDir = path.join(dataDir!, 'restore-points');
        const DAY = 24 * 60 * 60_000;
        const now = Date.now();
        const nameAt = (t: number, why = 'restore') => `${new Date(t).toISOString().replace(/:/g, '-')}-before-${why}`;
        const plant = (t: number) => {
            const n = nameAt(t);
            fs.mkdirSync(path.join(pointsDir, n), { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(pointsDir, n, 'state.db'), 'x', { mode: 0o600 });
            return n;
        };
        fs.mkdirSync(pointsDir, { recursive: true, mode: 0o700 });
        for (const n of fs.readdirSync(pointsDir)) fs.rmSync(path.join(pointsDir, n), { recursive: true, force: true });
        const oneDay = plant(now - DAY);
        const week = [2, 3, 4, 5, 6].map((h) => plant(now - h * 3_600_000));
        const eightDays = plant(now - 8 * DAY);
        const old = plant(now - 31 * DAY);
        const cfg = await call('POST', '/api/local/admin/snapshots/config', { 'x-admin-session': createPasswordSession().sessionId }, { keep: 3, code: tfa.code() });
        assert(cfg.status === 200 && cfg.json?.config?.keep === 3, `6. the owner sets snapshots keep:3, with a code (${cfg.status} ${cfg.text.slice(0, 120)})`);
        snapshots.expireSnapshots();
        const left = fs.readdirSync(pointsDir);
        assert(left.includes(oneDay), '6. keep:3 and the hourly expiry leave a 1-day-old point');
        assert(week.every((n) => left.includes(n)), '6. …and five within a week');
        assert(!left.includes(old), '6. a 31-day-old point goes');
        assert(!left.includes(eightDays), '6. an 8-day-old point past the newest five goes');
        for (const n of fs.readdirSync(pointsDir)) fs.rmSync(path.join(pointsDir, n), { recursive: true, force: true });
        const older = [8, 9, 10, 11, 12, 13].map((d) => plant(now - d * DAY));
        const young = [1, 2, 3, 4, 5, 6, 6.5].map((d) => plant(now - d * DAY));
        snapshots.expireSnapshots();
        const left2 = fs.readdirSync(pointsDir);
        assert(young.every((n) => left2.includes(n)), '6. seven points younger than a week all stay, past the count of five');
        assert(older.every((n) => !left2.includes(n)), '6. …and every older one goes, being past the newest five');
        for (const n of fs.readdirSync(pointsDir)) fs.rmSync(path.join(pointsDir, n), { recursive: true, force: true });
        const pastWeek = [8, 9, 10, 11, 12, 13].map((d) => plant(now - d * DAY));
        snapshots.expireSnapshots();
        const left3 = fs.readdirSync(pointsDir);
        assert(pastWeek.slice(0, 5).every((n) => left3.includes(n)) && !left3.includes(pastWeek[5]),
            `6. past a week the newest five stay and the sixth goes (${left3.length} left)`);
    }

    // ── S2b. Another community's file restores only where nobody but the owners has joined ──
    console.log("\n── S2b. another community's locked file, opened with the uploader's own code ──");
    {
        const made = runChild('make-other', fs.mkdtempSync(path.join(os.tmpdir(), 'restore-points-other-')), { TEST_WORK: work });
        assert(made.ok === true && typeof made.code === 'string', `setup: another community made its own locked backups and code (${made.community})`);
        const env = { ...childEnv, TEST_OTHER_FILE: path.join(work, 'other.bpsealed'), TEST_OTHER_BARE: path.join(work, 'other-bare.bpsealed'), TEST_OTHER_CODE: made.code ?? '' };
        const row = (scenario: 'lived-in' | 'claimed', name: string, extra: Record<string, string> = {}): any => {
            const d = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-points-s2b-'));
            try { return runChild(scenario, d, { ...env, ...extra, TEST_ROW: name }); } finally { fs.rmSync(d, { recursive: true, force: true }); }
        };
        const OTHER_WORDS = "This backup is from a different community, and people have already joined the community on this server. To bring the "
            + "backup's community back, restore the file on a fresh server (install, claim, restore), or on this server with `beanpool restore FILE`. "
            + 'Nothing was changed.';
        const UNREADABLE_WORDS = 'This server cannot read its own community record or node key, so Settings cannot tell whose backup this is. Fix the '
            + 'data folder, or restore on the server with `beanpool restore FILE`. Nothing was changed.';
        const refusedOther = (r: any) => r.answer?.status === 409 && r.answer.otherCommunity === true && r.answer.livedIn === true
            && r.answer.error === OTHER_WORDS && r.answer.command === 'beanpool restore FILE' && r.answer.fileCommunityId === made.community
            && typeof r.answer.thisCommunityId === 'string' && r.answer.thisCommunityId !== made.community;
        const nothingMoved = (r: any) => !!r.before && JSON.stringify(r.after) === JSON.stringify(r.before) && r.after.points.length === 0 && r.after.leftovers.length === 0;
        const said = (r: any) => `${r.answer?.status} ${String(r.answer?.error ?? (r.answer?.success ? 'restored' : '')).slice(0, 110)}`;

        for (const who of ['the password with an earlier 2FA session', 'a password session', "the owner's computer session", 'a fresh phone hand-off', 'the password with a current code']) {
            const r = row('lived-in', `a:${who}`);
            assert(r.signIn === 200 && refusedOther(r), `S2b-a. a lived-in server, ${who}, the other community's file and its own right code: 409 otherCommunity (${said(r)})`);
            assert(nothingMoved(r), `S2b-a. …node_roles, libp2p_key, genesis.json and local-config.json as they were; no point, nothing left (${JSON.stringify(r.after?.points)} ${JSON.stringify(r.after?.leftovers)})`);
        }
        const b = row('lived-in', 'b');
        assert(refusedOther(b) && nothingMoved(b), `S2b-b. the same file with no take-over bundle inside: 409, nothing moved (${said(b)})`);
        const c = row('lived-in', 'c');
        assert(refusedOther(c) && c.answer?.needsOwnerPhone !== true && !c.answer?.phone, `S2b-c. "open with an owner's phone": 409, not 202, no unlock started (${said(c)})`);
        assert(nothingMoved(c) && c.pending?.length === 0, `S2b-c. …no file kept for the phone, nothing moved (${JSON.stringify(c.pending)})`);
        const d = row('claimed', 'd');
        assert(d.post === 1, `S2b-d. setup: the claimed server holds its owner's own post and an enterprise (${d.post})`);
        assert(d.answer?.status === 200 && d.answer.success === true && d.answer.restoredKeys === true && d.community === made.community,
            `S2b-d. a fresh claimed server (one owner, their post, an enterprise): 200, the bundle applied, the other community here (${said(d)})`);
        assert(d.after?.points?.length === 1 && d.answer?.restorePoint?.name === d.after.points[0], `S2b-d. …and a restore point kept (${JSON.stringify(d.after?.points)})`);
        const e = row('claimed', 'e');
        assert(refusedOther(e) && nothingMoved(e), `S2b-e. one invited member joins that server: 409, nothing moved (${said(e)})`);
        const es = row('claimed', 'e-suspended');
        assert(refusedOther(es) && nothingMoved(es), `S2b-e. …that member suspended: still 409 (${said(es)})`);
        const f = row('lived-in', 'f');
        assert(f.answer?.status === 200 && f.answer.success === true && f.after?.points?.length === 1,
            `S2b-f. a lived-in server's own backup, signed by itself, with its own code: still 200, a point kept (${said(f)})`);
        for (const which of ['h-own', 'h-other']) {
            const h = row('lived-in', which);
            assert(h.answer?.status === 409 && h.answer.ownRecordUnreadable === true && h.answer.error === UNREADABLE_WORDS && h.answer.thisCommunityId === null
                && h.answer.command === 'beanpool restore FILE',
                `S2b-h. genesis.json cannot be read, ${which === 'h-own' ? "the server's own backup" : "the other community's"}: 409 in its own words (${said(h)})`);
            assert(nothingMoved(h), `S2b-h. …nothing moved (${JSON.stringify(h.after?.points)})`);
        }
        const g = row('lived-in', 'a:the password with an earlier 2FA session', { NODE_PROFILE: 'global' });
        assert(refusedOther(g) && nothingMoved(g), `S2b-i. the global profile, lived-in: the other community's file is 409, nothing moved (${said(g)})`);
    }

    // ── 8. The plain archive naming a new owner (last: on a server that takes it, it replaces this process's database) ──
    console.log('\n── 8. a plain archive naming a new owner, by the password and an earlier 2FA session ──');
    {
        const copy = path.join(work, 'mallory-state.db');
        db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
        const Database = (await import('better-sqlite3')).default;
        const mallory = crypto.randomBytes(32).toString('hex');
        const edit = new Database(copy);
        edit.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, 'Mallory', ?, ?, 'TEST')`).run(mallory, new Date().toISOString(), owner);
        edit.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by, granted_at) VALUES (?, 'owner', ?, ?)`).run(mallory, owner, new Date().toISOString());
        edit.close();
        const plain = makeTarGz([{ name: './state.db', content: fs.readFileSync(copy) }, { name: './node_config.json', content: Buffer.from('{}') }]);
        const roles = () => JSON.stringify(db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey, role').all());
        const rolesBefore = roles();
        const r = await call('POST', '/api/local/admin/restore', earlier2fa(), undefined, plain);
        assert(r.status === 400 && r.json?.notLocked === true && r.json?.command === 'beanpool restore --unlocked FILE'
            && r.json?.error === 'Backups that are not locked no longer restore from Settings: make a recovery code so every backup is locked. '
                + 'An old unlocked file restores on the server itself with `beanpool restore --unlocked FILE`. Nothing was changed.',
            `8. refused 400, naming the command (${r.status} ${r.text.slice(0, 200)})`);
        assert(roles() === rolesBefore && !db.prepare(`SELECT 1 FROM node_roles WHERE member_pubkey = ?`).get(mallory), '8. no role moved: Mallory is no owner');
        assert(!fs.existsSync(path.join(dataDir!, '.restore-tmp')) && !fs.existsSync(path.join(dataDir!, '.restore-candidate'))
            && fs.readdirSync(dataDir!).filter((f) => f.startsWith('uploaded-backup')).length === 0, '8. nothing extracted, nothing left behind');
    }

    registrar.close();
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) {
        console.error(`❌ ${testsRun - testsPassed} restore-point check(s) FAILED.`);
        process.exit(1);
    }
    console.log('⭐️ Restore-point checks PASSED.');
    process.exit(0);
}

(IS_CHILD ? child() : main()).catch((err) => {
    console.error('❌ Test suite failed with error:', err);
    process.exit(1);
});
