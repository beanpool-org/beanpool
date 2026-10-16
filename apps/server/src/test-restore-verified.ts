/**
 * Test Suite: the restore and roll-back fixes from the verified review of the backup/restore audit
 * (scratch/reviews/verify-audit-restore-backup.md, H1, H2, M1, M2; design case 18 §3).
 *
 * Over the real HTTPS server, through every middleware a node runs, each server a child process on its own data dir:
 *  1. H1, two restores at once (0 ms and 50 ms apart, two owner sessions, each with the recovery code): one 200, the other
 *     409 "A restore or roll-back is already running on this server; wait for it and the restart." The live database is
 *     the winner's, one restore point, nothing left in the data folder, one restart. (Before: 500/500, 400/500 or 200/500.)
 *  2. H1, the phone's finish racing a restore by code: one 200, the other 409 in the same words.
 *  3. H1, two roll-backs from two fresh phone sessions in the same tick: one 200 whose serverFiles are every file the
 *     point's point.json lists, each back in place with the point's bytes and none moved aside; the other 409. (Before:
 *     3 runs in 4, a 200 with serverFiles [] and the node key, genesis, community key and config moved aside.)
 *     A point whose tar lost a file point.json lists (a torn unpack), one with no tar, one with no point.json: each 500
 *     in words, no file moved, the database still open. M2: none of those bodies holds a path; the log has the error.
 *  4. H2, a database without the core tables: checkRestoreDatabase refuses an empty database, a dummy table, members(x INT),
 *     a members view, and accounts without balance, in words; a real backup's database passes; a point this server took
 *     passes against a live database that has no schema (ownPoint), which the plain check refuses over triggers.
 *     Through the route on a fresh server: the empty, dummy and members(x INT) files sealed by a pinned key → 400 "is not a
 *     BeanPool database", nothing changed; a real backup then restores 200. (Before: 200 for all three.)
 *  5. H2 note, the shell's roll-back (rollBackTo, as `beanpool restore-point roll-back` runs it) onto a live members(x INT)
 *     database: it rolls back, and the owner is back. (Before: refused, "made by a newer version of BeanPool".)
 *  6. M1, boot: .restore-tmp, .restore-candidate, the upload, the opened file and a phone's file past its window are
 *     removed by secureDataDirAtBoot; a phone's file inside its window and other files stay.
 *
 * Run:
 *   SERVER_SUITES_ONLY=test-restore-verified node scripts/run-server-suites.mjs
 * (It re-runs itself as a child with `--child <scenario>` for each server.)
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
        // Counted, and the run goes on, so a run against a server without these fixes reports every hole, not the first.
        console.error(`✗ ${msg}`);
    }
}

const sha = (b: Buffer | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const PW = 'Restore-Verified-Pw-5517!';
const PHOTO_KEY = 'posts/p-fresh/0-aabbccdd.jpg';
const BUSY = 'A restore or roll-back is already running on this server; wait for it and the restart.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** A minimal ustar writer, gzipped. */
function makeTarGz(entries: { name: string; content: Buffer }[]): Buffer {
    const blocks: Buffer[] = [];
    for (const e of entries) {
        const h = Buffer.alloc(512);
        h.write(e.name, 0, 100, 'utf8');
        h.write('0000600\0', 100);
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

/** What a race or a refusal must leave as it was, read from the files by a handle of its own. */
async function dirState(dataDir: string) {
    const Database = (await import('better-sqlite3')).default;
    const fromDb = <T>(q: (d: any) => T): T | string => {
        try {
            const d = new Database(path.join(dataDir, 'state.db'), { readonly: true, fileMustExist: true });
            try { return q(d); } finally { d.close(); }
        } catch (e: any) { return `ERR ${e?.code || e?.message}`; }
    };
    const h = (f: string) => { try { return sha(fs.readFileSync(path.join(dataDir, f))); } catch { return null; } };
    const names = fs.readdirSync(dataDir);
    return {
        callsigns: fromDb((d) => (d.prepare('SELECT callsign FROM members ORDER BY callsign').all() as any[]).map((r) => r.callsign)),
        roles: fromDb((d) => JSON.stringify(d.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all())),
        points: (() => { try { return fs.readdirSync(path.join(dataDir, 'restore-points')).filter((n) => !n.startsWith('.')).sort(); } catch { return []; } })(),
        leftovers: names.filter((n) => n.startsWith('.restore') || n.startsWith('uploaded-backup')).sort(),
        rolledBack: names.filter((n) => n.includes('.rolled-back-')).sort(),
        files: Object.fromEntries(['libp2p_key', 'community.key', 'genesis.json', 'local-config.json', 'recovery-seal.key', 'node_config.json'].map((f) => [f, h(f)])),
    };
}

// ── The child servers ────────────────────────────────────────────────────────────────────────────────────────────────

async function child(): Promise<void> {
    const scenario = process.argv[3];
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    onlyLoopback();
    const out: Record<string, unknown> = { scenario };
    const done = () => { console.log('CHILD_RESULT ' + JSON.stringify(out)); process.exit(0); };
    const file = (p: string) => new Uint8Array(fs.readFileSync(p));
    const code = process.env.TEST_CODE!;

    if (scenario === 'boot-sweep') {
        // M1: what a restore cut off by a crash leaves, planted under the names the restore itself uses.
        const { restorePaths } = await import('./routes/backup.js');
        const { tmpDir, candidateDir, uploadPath, openedTarPath } = restorePaths();
        for (const d of [tmpDir, candidateDir]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'state.db'), 'an unlocked copy'); }
        for (const f of [uploadPath, openedTarPath]) fs.writeFileSync(f, 'x');
        const old = path.join(dataDir, 'uploaded-backup.pending-0123456789abcdef');
        const young = path.join(dataDir, 'uploaded-backup.pending-fedcba9876543210');
        fs.writeFileSync(old, 'x');
        fs.writeFileSync(young, 'x');
        const past = (Date.now() - 11 * 60_000) / 1000;
        fs.utimesSync(old, past, past);
        fs.writeFileSync(path.join(dataDir, 'uploaded-backup-notes.txt'), 'not the restore\'s');
        out.planted = fs.readdirSync(dataDir).filter((n) => n.startsWith('.restore') || n.startsWith('uploaded-backup')).sort();
        const { secureDataDirAtBoot } = await import('./boot-file-safety.js');
        secureDataDirAtBoot(dataDir);
        out.after = fs.readdirSync(dataDir).filter((n) => n.startsWith('.restore') || n.startsWith('uploaded-backup')).sort();
        done();
    }

    if (scenario === 'broken-rollback') {
        // H2 note: the live database is members(x INT) (the boot would crash on it); the shell's roll-back, as
        // restore-point-command.ts calls it, with the node stopped (no initStateEngine: it would throw).
        const Database = (await import('better-sqlite3')).default;
        for (const f of ['state.db', 'state.db-wal', 'state.db-shm']) fs.rmSync(path.join(dataDir, f), { force: true });
        const broken = new Database(path.join(dataDir, 'state.db'));
        broken.exec('CREATE TABLE members (x INT)');
        broken.close();
        const backup = await import('./routes/backup.js');
        const { listRestorePoints, resolveRestorePoint } = await import('./services/restore-points.js');
        const name = listRestorePoints().find((p) => p.name.endsWith('-before-restore'))?.name;
        out.point = name;
        try {
            const body = await backup.rollBackTo(resolveRestorePoint(name)!, name!, null);
            out.result = { ok: true, rolledBackTo: body.rolledBackTo, serverFiles: body.serverFiles };
        } catch (e: any) {
            out.result = { ok: false, error: String(e?.message || e) };
        }
        out.state = await dirState(dataDir);
        done();
    }

    const { initStateEngine, seedGenesisMember } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const keyAuth = await import('./admin-key-auth.js');
    const { initTls } = await import('./services/tls.js');
    const httpsServer = await import('./https-server.js');
    const backupRoutes = await import('./routes/backup.js');
    let restarts = 0;
    backupRoutes.setRestoreRestartForTests(() => { restarts++; });
    initStateEngine();
    const fresh = scenario !== 'rb';
    if (fresh) {
        // A fresh server (install, claim): its own community, key, password and 2FA, one owner, one photo.
        const { ensureGenesis } = await import('./genesis.js');
        const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
        const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
        await ensureGenesis();
        fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
        const { hash, salt } = hashPassword(PW);
        updateLocalConfig({ adminHash: hash, salt, breakGlassMode: false } as any);
        // The owner here is the backups' owner too, so the phone that opens the file is an owner of this server.
        seedGenesisMember(process.env.TEST_OWNER!, 'FreshOwner');
        const photo = crypto.randomBytes(1800);
        fs.mkdirSync(path.dirname(path.join(dataDir, 'images', PHOTO_KEY)), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'images', PHOTO_KEY), photo);
        db.pragma('foreign_keys = OFF');
        db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, storage_key, sha256, bytes, mime) VALUES (?, NULL, 0, ?, ?, ?, 'image/jpeg')`)
            .run('p-fresh', PHOTO_KEY, sha(photo), photo.length);
        db.pragma('foreign_keys = ON');
    }
    const tfa = turnOn2faForTests(PW);
    await initTls();
    const port = await httpsServer.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const owner = process.env.TEST_OWNER!;
    const session = (phone = false): string => {
        const ex = keyAuth.consumeHandshakeToken(keyAuth.mintHandshakeToken(owner, 'owner').handshakeToken, Date.now(),
            phone ? { idleTtlMs: keyAuth.PHONE_HANDOFF_IDLE_TTL_MS } : {});
        if (!ex.ok) throw new Error(`setup: no owner session: ${ex.error}`);
        return ex.sessionId!;
    };
    const call = async (method: string, route: string, headers: Record<string, string>, body?: unknown, raw?: Uint8Array) => {
        resetAdminAuthTarpit();
        httpsServer.resetAdminRateLimit();
        const init: RequestInit = { method, headers: { ...headers }, signal: AbortSignal.timeout(120_000) };
        if (raw) { (init.headers as any)['Content-Type'] = 'application/octet-stream'; init.body = raw as BodyInit; }
        else if (method !== 'GET') { (init.headers as any)['Content-Type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
        try {
            const r = await localFetch(base + route, init);
            const text = await r.text();
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* not json */ }
            return { status: r.status, json, text: text.slice(0, 600) };
        } catch (e: any) {
            return { status: 0, json: null, text: String(e?.message || e) };
        }
    };
    const brief = (r: { status: number; json: any; text: string }) => ({
        status: r.status, error: r.json?.error ?? (r.json ? undefined : r.text.slice(0, 200)), success: r.json?.success,
        complete: r.json?.complete, restoreRunning: r.json?.restoreRunning, serverFiles: r.json?.serverFiles, movedAside: r.json?.movedAside,
    });
    const dbOpen = () => { try { db.prepare('SELECT 1').get(); return true; } catch { return false; } };
    // Sessions are made before a race: a restore that wins closes the database the next one would be made in.
    const restoreBy = (bytes: Uint8Array, sid = session()) => call('POST', '/api/local/admin/restore', { 'x-admin-session': sid, 'X-Recovery-Code': code }, undefined, bytes);

    if (scenario === 'race') {
        const stagger = Number(process.env.TEST_STAGGER_MS || 0);
        const [s1, s2] = [session(), session()];
        const a = restoreBy(file(process.env.TEST_ONE!), s1);
        await sleep(stagger);
        const b = restoreBy(file(process.env.TEST_TWO!), s2);
        const [ra, rb] = await Promise.all([a, b]);
        Object.assign(out, { stagger, a: brief(ra), b: brief(rb) });
        await sleep(1500);
        Object.assign(out, { restarts, dbOpen: dbOpen(), state: await dirState(dataDir) });
        done();
    }

    if (scenario === 'phone-race') {
        // The phone's finish (services/owner-unlock.ts) against a restore by code, in the same tick.
        const core: any = await import('@beanpool/core');
        const started = await call('POST', '/api/local/admin/restore', { 'x-admin-session': session(), 'X-Unlock-With': 'phone', 'X-Unlock-Server-Url': base },
            undefined, file(process.env.TEST_TWO!));
        out.started = { status: started.status, needsOwnerPhone: started.json?.needsOwnerPhone };
        const qr = core.parseOwnerUnlockQr(started.json?.phone?.qr);
        const described = await call('GET', `/api/local/admin/unlock/${qr.sessionId}`, {});
        const check = core.checkUnlockHeader(qr, described.json?.header, owner, {});
        const request = core.approveOwnerUnlock(qr, check.header, process.env.TEST_OWNER_SEED!);
        const a = restoreBy(file(process.env.TEST_ONE!), session());
        const b = call('POST', `/api/local/admin/unlock/${qr.sessionId}`, {}, request);
        const [ra, rb] = await Promise.all([a, b]);
        Object.assign(out, { code: brief(ra), phone: brief(rb) });
        await sleep(7000);
        Object.assign(out, { dbOpen: dbOpen(), state: await dirState(dataDir) });
        done();
    }

    if (scenario === 'h2') {
        // Files sealed by a pinned key whose state.db is no community's: refused in words, nothing changed.
        const rows: Record<string, unknown> = {};
        for (const k of ['EMPTY', 'DUMMY', 'WRONG']) {
            const before = await dirState(dataDir);
            const r = await restoreBy(file(process.env[`TEST_${k}`]!));
            const after = await dirState(dataDir);
            rows[k] = { answer: brief(r), same: JSON.stringify(before) === JSON.stringify(after), after, dbOpen: dbOpen() };
        }
        out.rows = rows;
        const real = await restoreBy(file(process.env.TEST_ONE!));
        Object.assign(out, { real: brief(real), state: await dirState(dataDir) });
        done();
    }

    if (scenario === 'prep') {
        const r = await call('POST', '/api/local/admin/restore', { ...tfa.headers(), 'X-Recovery-Code': code }, undefined, file(process.env.TEST_ONE!));
        Object.assign(out, { r: brief(r), state: await dirState(dataDir) });
        done();
    }

    if (scenario === 'rb') {
        // The restored server after its restart: its point, as it is, and three copies of it that are damaged.
        const points = path.join(dataDir, 'restore-points');
        const name = fs.readdirSync(points).find((n) => n.endsWith('-before-restore'))!;
        const pointDir = path.join(points, name);
        const listed: string[] = JSON.parse(fs.readFileSync(path.join(pointDir, 'point.json'), 'utf8')).serverFiles;
        const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-verified-tar-'));
        spawnSync('tar', ['-xzf', path.join(pointDir, 'server-files.tar.gz'), '-C', unpacked]);
        const pointBytes = Object.fromEntries(listed.map((f) => [f, sha(fs.readFileSync(path.join(unpacked, f)))]));
        const damaged = (day: number, change: (dir: string) => void) => {
            const n = `2026-01-0${day}T00-00-00.000Z-before-restore`;
            fs.cpSync(pointDir, path.join(points, n), { recursive: true });
            change(path.join(points, n));
            return n;
        };
        const torn = damaged(1, (d) => fs.writeFileSync(path.join(d, 'server-files.tar.gz'),
            makeTarGz(listed.filter((f) => f !== 'libp2p_key').map((f) => ({ name: `./${f}`, content: fs.readFileSync(path.join(unpacked, f)) })))));
        const noTar = damaged(2, (d) => fs.rmSync(path.join(d, 'server-files.tar.gz')));
        const noMeta = damaged(3, (d) => fs.rmSync(path.join(d, 'point.json')));
        fs.rmSync(unpacked, { recursive: true, force: true });
        const refusals: Record<string, unknown> = {};
        for (const [label, n] of [['torn', torn], ['no tar', noTar], ['no point.json', noMeta]] as const) {
            const before = await dirState(dataDir);
            const r = await call('POST', '/api/local/admin/restore-points/roll-back', { 'x-admin-session': session(true) }, { name: n });
            const after = await dirState(dataDir);
            refusals[label] = { answer: brief(r), same: JSON.stringify(before) === JSON.stringify(after), dbOpen: dbOpen(), after };
        }
        out.refusals = refusals;
        // Two roll-backs from two fresh phone sessions, in the same tick.
        const s1 = session(true);
        const s2 = session(true);
        const a = call('POST', '/api/local/admin/restore-points/roll-back', { 'x-admin-session': s1 }, { name });
        const b = call('POST', '/api/local/admin/restore-points/roll-back', { 'x-admin-session': s2 }, { name });
        const [ra, rb] = await Promise.all([a, b]);
        await sleep(1500);
        Object.assign(out, { name, listed, pointBytes, a: brief(ra), b: brief(rb), restarts, dbOpen: dbOpen(), state: await dirState(dataDir) });
        done();
    }

    void seedGenesisMember;
    out.error = 'unknown scenario';
    done();
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

// ── The main server (this process): the backups the children restore ───────────────────────────────────────────────

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');
    onlyLoopback();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-verified-'));
    const dirs: string[] = [];
    const newDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-verified-node-')); dirs.push(d); return d; };

    const registrar = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.statusCode = 404; res.end('{"error":"not found"}'); }); });
    await new Promise<void>((r) => registrar.listen(0, '127.0.0.1', () => r()));
    process.env.REGISTRAR_URL = `http://127.0.0.1:${(registrar.address() as any).port}`;

    const { initStateEngine, seedGenesisMember } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const { hashPassword, updateLocalConfig, getLocalConfig } = await import('./config/local-config.js');
    const { turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
    const { createSealedBackup } = await import('./services/sealed-backup.js');
    const { checkRestoreDatabase } = await import('./services/restore-checks.js');
    const Database = (await import('better-sqlite3')).default;
    const core: any = await import('@beanpool/core');
    const { ed25519 } = await import('@noble/curves/ed25519.js');

    initStateEngine();
    await ensureGenesis();
    const key = await generateKeyPair('Ed25519');
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(key));
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, breakGlassMode: false } as any);
    turnOn2faForTests(PW);
    const ownerSeed = crypto.randomBytes(32);
    const ownerSeedHex = Buffer.from(core.toEd25519Pkcs8(ownerSeed)).toString('hex');
    const owner = Buffer.from(ed25519.getPublicKey(ownerSeed)).toString('hex');
    seedGenesisMember(owner, 'Olive');
    const join = (callsign: string) => {
        const pk = crypto.randomBytes(32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, 'TEST')`)
            .run(pk, callsign, new Date().toISOString(), owner);
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    };
    join('MarkerOne');
    db.pragma('foreign_keys = OFF');
    for (let i = 0; i < 2; i++) {
        const k = `posts/p-main/${i}-${crypto.randomBytes(4).toString('hex')}.jpg`;
        const bytes = crypto.randomBytes(2000 + i);
        fs.mkdirSync(path.dirname(path.join(dataDir!, 'images', k)), { recursive: true });
        fs.writeFileSync(path.join(dataDir!, 'images', k), bytes);
        db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, storage_key, sha256, bytes, mime) VALUES (?, NULL, ?, ?, ?, ?, 'image/jpeg')`)
            .run('p-main', i, k, sha(bytes), bytes.length);
    }
    db.pragma('foreign_keys = ON');
    const recovery = await makeRecoveryCode();
    const save = async (name: string) => {
        const b = await createSealedBackup();
        const parts: Buffer[] = [];
        for await (const c of b.body) parts.push(c as Buffer);
        fs.writeFileSync(path.join(work, name), Buffer.concat(parts));
        return path.join(work, name);
    };
    const one = await save('one.bpsealed');
    join('MarkerTwo');
    const two = await save('two.bpsealed');
    const realCopy = path.join(work, 'real-state.db');
    db.exec(`VACUUM INTO '${realCopy.replace(/'/g, "''")}'`);

    // State databases that are no community's, each a valid SQLite file, sealed bare (state.db + {} node_config.json) by
    // this server's key, so a fresh server takes the file and only the database decides.
    const community = JSON.parse(fs.readFileSync(path.join(dataDir!, 'genesis.json'), 'utf8')).communityId;
    const made = (n: string, sql: string[]) => {
        const f = path.join(work, n);
        const d = new Database(f);
        for (const s of sql) d.exec(s);
        d.close();
        return f;
    };
    const emptyDb = made('empty.db', ['CREATE TABLE dummy (id INT)', 'DROP TABLE dummy']);
    const dummyDb = made('dummy.db', ['CREATE TABLE dummy (id INT)']);
    const wrongDb = made('wrong.db', ['CREATE TABLE members (x INT)']);
    const sealBare = async (n: string, stateDb: string) => {
        const bare = makeTarGz([{ name: './state.db', content: fs.readFileSync(stateDb) }, { name: './node_config.json', content: Buffer.from('{}') }]);
        fs.writeFileSync(path.join(work, n), Buffer.from(await core.sealEnvelope(new Uint8Array(bare), {
            kind: 'backup', communityId: community, nodePeerId: peerIdFromPrivateKey(key).toString(),
            recipients: { owners: [{ pubkey: owner, callsign: 'Olive' }], codes: [getLocalConfig().recoveryCode] },
            signingKey: new Uint8Array(key.raw.subarray(0, 32)),
        })));
        return path.join(work, n);
    };
    const env = {
        TEST_CODE: recovery.code, TEST_OWNER: owner, TEST_OWNER_SEED: ownerSeedHex, TEST_ONE: one, TEST_TWO: two,
        TEST_EMPTY: await sealBare('empty.bpsealed', emptyDb), TEST_DUMMY: await sealBare('dummy.bpsealed', dummyDb),
        TEST_WRONG: await sealBare('wrong.bpsealed', wrongDb),
    };

    try {
        // ── 1. Two restores at once ──
        console.log('\n── 1. H1: two restores at once: one runs, the other is told to wait ──');
        for (const stagger of [0, 50]) {
            const r = runChild('race', newDir(), { ...env, TEST_STAGGER_MS: String(stagger) });
            const answers = [r.a, r.b];
            const won = answers.filter((x: any) => x?.status === 200 && x?.success === true);
            const busy = answers.filter((x: any) => x?.status === 409 && x?.error === BUSY && x?.restoreRunning === true);
            assert(won.length === 1 && busy.length === 1,
                `1. ${stagger} ms apart: one 200, one 409 in words (${JSON.stringify(answers)})`);
            // A sent one.bpsealed, B two.bpsealed (MarkerTwo is only in two).
            const cs = r.state?.callsigns;
            assert(Array.isArray(cs) && cs.includes('MarkerOne') && !cs.includes('FreshOwner') && cs.includes('MarkerTwo') === (r.b?.status === 200),
                `1. ${stagger} ms: the live database is the winner's backup (${JSON.stringify(cs)})`);
            assert(r.state?.points?.length === 1 && r.state?.leftovers?.length === 0,
                `1. ${stagger} ms: one restore point, nothing left in the data folder (${JSON.stringify(r.state?.points)} ${JSON.stringify(r.state?.leftovers)})`);
            assert(r.restarts === 1, `1. ${stagger} ms: one restart (${r.restarts})`);
        }

        // ── 2. The phone's finish against a restore by code ──
        console.log("\n── 2. H1: an owner's phone finishing a restore while one by code runs ──");
        {
            const r = runChild('phone-race', newDir(), env);
            assert(r.started?.status === 202 && r.started?.needsOwnerPhone === true, `2. the phone restore starts: 202 with the QR (${JSON.stringify(r.started)})`);
            const pair = [r.code, r.phone];
            assert(pair.filter((x: any) => x?.status === 200).length === 1 && pair.filter((x: any) => x?.status === 409 && x?.error === BUSY).length === 1,
                `2. one 200, the other 409 in words (code ${JSON.stringify(r.code)}, phone ${JSON.stringify(r.phone)})`);
            assert(r.state?.points?.length === 1 && r.state?.leftovers?.length === 0,
                `2. one restore point, and neither the phone's file nor the upload left behind (${JSON.stringify(r.state?.points)} ${JSON.stringify(r.state?.leftovers)})`);
        }

        // ── 3. Roll-backs ──
        console.log('\n── 3. H1 + M2: two roll-backs at once; a point that does not unpack whole ──');
        {
            const dir = newDir();
            const prep = runChild('prep', dir, env);
            assert(prep.r?.status === 200 && prep.state?.points?.length === 1, `3. setup: a restore kept a point (${JSON.stringify(prep.r)})`);
            const r = runChild('rb', dir, env);
            for (const [label, x] of Object.entries(r.refusals ?? {}) as Array<[string, any]>) {
                assert(x.answer?.status === 500 && typeof x.answer?.error === 'string' && x.answer.error.startsWith('Nothing was rolled back: ')
                    && !x.answer.error.includes('/') && x.same === true && x.dbOpen === true && x.after?.rolledBack?.length === 0,
                    `3. a point with ${label}: 500 in words with no path, no file moved, nothing changed (${JSON.stringify(x.answer)})`);
            }
            assert(/libp2p_key is listed in its point\.json but did not come out of its server files\. No file was moved\. Nothing was changed\.$/
                .test(r.refusals?.torn?.answer?.error ?? ''), `3. the torn point is named as one (${r.refusals?.torn?.answer?.error})`);
            assert(r.refusals?.['no tar']?.answer?.error === 'Nothing was rolled back: a file it was using went missing part way. The server log has the details.'
                && /ENOENT[^\n]*server-files\.tar\.gz/.test(r.logs ?? ''),
                `3. M2: a point with no tar says what happened; the raw error, path and all, is in the log only (${r.refusals?.['no tar']?.answer?.error})`);
            const pair = [r.a, r.b];
            const won = pair.find((x: any) => x?.status === 200);
            assert(pair.filter((x: any) => x?.status === 200).length === 1 && pair.filter((x: any) => x?.status === 409 && x?.error === BUSY).length === 1,
                `3. two roll-backs in the same tick: one 200, one 409 in words (${JSON.stringify(pair)})`);
            assert(Array.isArray(r.listed) && r.listed.length >= 3 && ['libp2p_key', 'genesis.json', 'local-config.json'].every((f) => r.listed.includes(f))
                && JSON.stringify([...(won?.serverFiles ?? [])].sort()) === JSON.stringify([...r.listed].sort()),
                `3. the winner keeps every file the point lists (${JSON.stringify(won?.serverFiles)} vs ${JSON.stringify(r.listed)})`);
            assert(r.listed?.every((f: string) => r.state?.files?.[f] === r.pointBytes?.[f]),
                '3. …each back in place with the point\'s bytes');
            assert((won?.movedAside ?? []).every((n: string) => !r.listed?.includes(n.replace(/\.rolled-back-\d+$/, '')))
                && r.state?.rolledBack?.every((n: string) => !r.listed?.includes(n.replace(/\.rolled-back-\d+$/, ''))),
                `3. …and none of them moved aside (${JSON.stringify(r.state?.rolledBack)})`);
            assert(r.restarts === 1, `3. one restart (${r.restarts})`);
        }

        // ── 4. H2: the core tables ──
        console.log('\n── 4. H2: a database without the core tables is refused ──');
        {
            const check = (f: string, live = db, opts?: { ownPoint?: boolean }) => {
                const dir = fs.mkdtempSync(path.join(work, 'cand-'));
                const cand = path.join(dir, 'state.db');
                fs.copyFileSync(f, cand);
                try { return { ok: true, ...checkRestoreDatabase(cand, live, opts) }; } catch (e: any) { return { ok: false, status: e?.httpStatus, error: String(e?.message) }; }
            };
            const words = (why: string) => `This backup's state.db is not a BeanPool database (${why}). Nothing was changed.`;
            const viewDb = made('view.db', ['CREATE TABLE m (public_key TEXT, callsign TEXT)', 'CREATE VIEW members AS SELECT * FROM m']);
            const noBalance = made('no-balance.db', ['CREATE TABLE members (public_key TEXT, callsign TEXT)', 'CREATE TABLE accounts (public_key TEXT)',
                'CREATE TABLE node_roles (member_pubkey TEXT)', 'CREATE TABLE node_config (key TEXT)']);
            for (const [label, f, why] of [
                ['an empty database', emptyDb, 'no members table'], ['a dummy table', dummyDb, 'no members table'],
                ['members(x INT)', wrongDb, 'its members table has no public_key column'], ['a members view', viewDb, 'no members table'],
                ['accounts without balance', noBalance, 'its accounts table has no balance column'],
            ] as const) {
                const r = check(f);
                assert(!r.ok && (r as any).status === 400 && (r as any).error === words(why), `4. ${label}: refused 400 in words (${JSON.stringify(r)})`);
            }
            const real = check(realCopy);
            assert(real.ok === true, `4. a real backup's database passes (${JSON.stringify(real)})`);
            // A point this server took, against a live database with no schema: its triggers are its own.
            const brokenLive = new Database(wrongDb, { readonly: true });
            const plain = check(realCopy, brokenLive);
            const own = check(realCopy, brokenLive, { ownPoint: true });
            brokenLive.close();
            assert(!plain.ok && /made by a newer version of BeanPool/.test((plain as any).error ?? ''),
                `4. the plain check refuses it over the triggers the broken live database lacks (as a restore must) (${String((plain as any).error).slice(0, 90)})`);
            assert(own.ok === true, `4. as this server's own point it passes (${JSON.stringify(own)})`);

            const r = runChild('h2', newDir(), env);
            for (const [k, why] of [['EMPTY', 'no members table'], ['DUMMY', 'no members table'], ['WRONG', 'its members table has no public_key column']] as const) {
                const row = r.rows?.[k];
                assert(row?.answer?.status === 400 && row?.answer?.error === 'Restore failed: ' + words(why),
                    `4. the ${k.toLowerCase()} file through the route: 400 in words (${JSON.stringify(row?.answer)})`);
                assert(row?.same === true && row?.dbOpen === true && row?.after?.points?.length === 0 && row?.after?.leftovers?.length === 0,
                    `4. …nothing changed: the database, the server's files, no point, nothing left (${JSON.stringify(row?.after).slice(0, 200)})`);
            }
            assert(r.real?.status === 200 && r.real?.success === true && Array.isArray(r.state?.callsigns) && r.state.callsigns.includes('MarkerOne'),
                `4. a real backup then restores (${JSON.stringify(r.real)})`);
        }

        // ── 5. The shell's roll-back onto a broken database ──
        console.log("\n── 5. H2 note: the shell's roll-back to this server's own point, onto a members(x INT) database ──");
        {
            const dir = newDir();
            const prep = runChild('prep', dir, env);
            assert(prep.r?.status === 200, `5. setup: a restore kept a point (${JSON.stringify(prep.r)})`);
            const r = runChild('broken-rollback', dir, env);
            assert(r.result?.ok === true && r.result?.rolledBackTo === r.point, `5. it rolls back (${JSON.stringify(r.result)})`);
            assert(Array.isArray(r.state?.callsigns) && r.state.callsigns.includes('FreshOwner') && String(r.state?.roles).includes(owner),
                `5. the server's own members and owner are back (${JSON.stringify(r.state?.callsigns)})`);
        }

        // ── 6. M1: the boot sweep ──
        console.log('\n── 6. M1: what a cut-off restore left is removed at boot ──');
        {
            const r = runChild('boot-sweep', newDir(), env);
            assert(JSON.stringify(r.planted) === JSON.stringify(['.restore-candidate', '.restore-tmp', 'uploaded-backup-notes.txt', 'uploaded-backup.opened.tar.gz',
                'uploaded-backup.pending-0123456789abcdef', 'uploaded-backup.pending-fedcba9876543210', 'uploaded-backup.upload']),
                `6. planted under the restore's own names (${JSON.stringify(r.planted)})`);
            assert(JSON.stringify(r.after) === JSON.stringify(['uploaded-backup-notes.txt', 'uploaded-backup.pending-fedcba9876543210']),
                `6. the unpack, the candidate, the upload, the opened file and the phone's file past its window are gone; the rest stays (${JSON.stringify(r.after)})`);
        }
    } finally {
        registrar.close();
        for (const d of [work, ...dirs]) fs.rmSync(d, { recursive: true, force: true });
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) {
        console.error(`❌ ${testsRun - testsPassed} restore-verified check(s) FAILED.`);
        process.exit(1);
    }
    console.log('⭐️ Restore-verified checks PASSED.');
    process.exit(0);
}

(IS_CHILD ? child() : main()).catch((err) => {
    console.error('❌ Test suite failed with error:', err);
    process.exit(1);
});
