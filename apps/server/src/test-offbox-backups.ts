/**
 * Test Suite: off-box backups (services/offbox-backups.ts, routes/offbox-backups.ts) — the main server's locked backups
 * sent on a schedule to S3-compatible stores its operator chooses.
 *
 * Two stand-in buckets on loopback (fake-s3-test-harness.ts, which checks every signature), one set in .env and one in
 * Settings. No real store, no BeanPool server, nothing off this machine. Over the real HTTPS server and its middleware:
 *
 *  1. No recovery code: nothing goes off the box (no PUT anywhere), and the Backup tab's status and the owner's health
 *     say why in words. Retention still prunes: a backup older than 30 days goes, a newer one, another community's and a
 *     file of another name stay.
 *  2. With a code, on schedule: a destination never sent to is due and gets one locked file (not a tar, signed, locked to
 *     the code, the hash it was sent with kept beside it); one sent to within the interval is not due; past the interval
 *     both are. An edit that sends no secret keeps the stored one.
 *  3. A failing destination: two 503s are retried within the run; three fail it, it shows as failing (status and health),
 *     is not tried again before 15 minutes and is after, and then shows as working. A 403 is not retried and says the
 *     store refused the key. No upload for a day and a half shows as stale.
 *  4. Retention: past the days set, by the name's time or the store's, whichever is older; refuses more than 30 days.
 *  5. Credentials: in no log line (console or the log table), no answer, no backup (opened with the code), not in the
 *     database or local-config.json; the settings file is mode 600; a .env destination that can't be used names the
 *     setting, never the value; an http:// endpoint off this machine is refused; docker-compose.yml passes every .env
 *     setting through.
 *  6. A standby: sends nothing and touches no bucket (not even a listing); no health line.
 *  7. Round trip: a FRESH server (child process: its own data dir, genesis, key, password) is given the destination in
 *     Settings, lists it (the lost community's backups, not its own), downloads the newest through its own route (hash
 *     checked), restores it with the recovery code, and its database is the backup's, table by table.
 *  8. Owner only: an admin's and a moderator's key session are refused, in words, on every route, with nothing changed and
 *     no request to any store; no credential at all is 401.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-offbox-backups.ts
 * (It re-runs itself as a child with `--fresh` for step 7.)
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_OFFBOX_')) delete process.env[k];

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IS_FRESH = process.argv[2] === '--fresh';

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

const sha = (b: Buffer | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const isGzip = (b: Buffer) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const nameAt = (t: number) => `beanpool-backup-${new Date(t).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.bpsealed`;

/** Every table's rows, hashed, by name: what "the same database" means here. */
async function tableDigests(dbFile: string): Promise<Record<string, string>> {
    const Database = (await import('better-sqlite3')).default;
    const h = new Database(dbFile, { readonly: true });
    try {
        const out: Record<string, string> = {};
        const tables = h.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[];
        for (const { name } of tables) {
            const rows = h.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).raw().all() as unknown[][];
            const lines = rows.map((r) => JSON.stringify(r.map((v) => (Buffer.isBuffer(v) ? `b64:${v.toString('base64')}` : typeof v === 'bigint' ? String(v) : v)))).sort();
            out[name] = sha(Buffer.from(lines.join('\n')));
        }
        return out;
    } finally {
        h.close();
    }
}

// ── Step 7: the fresh server (child process) ─────────────────────────────────────────────────────────────────────────

async function fresh(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    const { initStateEngine } = await import('./state-engine.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');
    const { setRestoreRestartForTests } = await import('./routes/backup.js');
    const { setOffboxTuningForTests } = await import('./services/offbox-backups.js');
    setOffboxTuningForTests({ attempts: 2, backoffMs: 10, idleMs: 10_000 });

    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const pw = 'Fresh-Offbox-Pw-318!';
    const { hash, salt } = hashPassword(pw);
    updateLocalConfig({ adminHash: hash, salt });
    const ownCommunity = JSON.parse(fs.readFileSync(path.join(dataDir, 'genesis.json'), 'utf8')).communityId;
    setRestoreRestartForTests(() => { /* the test reads the data dir instead of restarting */ });
    await initTls();
    const port = await https.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const call = async (method: string, route: string, body?: unknown, extra: Record<string, string> = {}) => {
        resetAdminAuthTarpit();
        https.resetAdminRateLimit();
        const headers: Record<string, string> = { 'X-Admin-Password': pw, ...extra };
        let payload: BodyInit | undefined;
        if (Buffer.isBuffer(body)) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new Uint8Array(body); }
        else if (method !== 'GET') { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body ?? {}); }
        const res = await fetch(base + route, { method, headers, body: payload });
        const bytes = Buffer.from(await res.arrayBuffer());
        let json: any = null;
        try { json = JSON.parse(bytes.toString('utf8')); } catch { /* a file */ }
        return { status: res.status, bytes, json, headers: res.headers };
    };

    const s3 = JSON.parse(process.env.TEST_S3!);
    const set = await call('POST', '/api/local/admin/offbox-backups/settings', { destination: s3 });
    const id = set.json?.status?.destinations?.find((d: any) => d.source === 'settings')?.id ?? null;
    const statusBefore = set.json?.status?.state ?? null;
    const list = await call('POST', '/api/local/admin/offbox-backups/list', { destination: id });
    const backups: any[] = list.json?.backups ?? [];
    const pick = backups.find((b) => b.community === process.env.TEST_COMMUNITY);
    const dl = pick ? await call('GET', `/api/local/admin/offbox-backups/download?destination=${encodeURIComponent(id)}&key=${encodeURIComponent(pick.key)}`) : null;
    const restore = dl ? await call('POST', '/api/local/admin/restore', dl.bytes, { 'X-Recovery-Code': process.env.TEST_RECOVERY_CODE! }) : null;
    const digests = await tableDigests(path.join(dataDir, 'state.db'));
    console.log('CHILD_RESULT ' + JSON.stringify({
        ownCommunity, setStatus: set.status, statusBefore, listStatus: list.status,
        listed: backups.map((b) => ({ key: b.key, community: b.community, ours: b.ours, bytes: b.bytes })),
        picked: pick?.key ?? null,
        download: dl ? { status: dl.status, sha: sha(dl.bytes), header: dl.headers.get('x-backup-sha256'), disposition: dl.headers.get('content-disposition') } : null,
        restore: restore ? { status: restore.status, body: restore.json } : null,
        communityAfter: JSON.parse(fs.readFileSync(path.join(dataDir, 'genesis.json'), 'utf8')).communityId,
        digests,
    }));
    process.exit(0);
}

// ── The main server (this process) ───────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'offbox-'));

    // Everything this process prints, to look for credentials in afterwards.
    const printed: string[] = [];
    for (const stream of [process.stdout, process.stderr] as const) {
        const write = stream.write.bind(stream);
        (stream as any).write = (chunk: any, ...rest: any[]) => { printed.push(String(chunk)); return write(chunk, ...rest); };
    }

    const { startFakeS3 } = await import('./fake-s3-test-harness.js');
    const storeA = await startFakeS3({ bucket: 'offbox-env-bucket' });
    const storeB = await startFakeS3({ bucket: 'offbox-settings-bucket' });
    // Different secrets per store (the harness makes each distinctive); the same key id in both.
    const SECRETS = [storeA.secretAccessKey, storeB.secretAccessKey];
    const KEY_ID = storeA.accessKeyId;

    // Destination 1 from .env, as an operator's docker .env would set it.
    process.env.BACKUP_OFFBOX_1_NAME = 'Env store';
    process.env.BACKUP_OFFBOX_1_ENDPOINT = storeA.endpoint;
    process.env.BACKUP_OFFBOX_1_BUCKET = storeA.bucket;
    process.env.BACKUP_OFFBOX_1_REGION = storeA.region;
    process.env.BACKUP_OFFBOX_1_ACCESS_KEY_ID = storeA.accessKeyId;
    process.env.BACKUP_OFFBOX_1_SECRET_ACCESS_KEY = storeA.secretAccessKey;

    const { initStateEngine, seedGenesisMember, grantNodeRole } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
    const { setNodeRole } = await import('./config/node-role.js');
    const { readSealedHeader } = await import('@beanpool/core');
    const { openSealedFileTo } = await import('./services/sealed-backup.js');
    const offbox = await import('./services/offbox-backups.js');
    const { OFFBOX_OWNER_ONLY } = await import('./routes/offbox-backups.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');
    offbox.setOffboxTuningForTests({ attempts: 3, backoffMs: 10, idleMs: 10_000 });

    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const PW = 'Offbox-Main-Pw-6620!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    const community = JSON.parse(fs.readFileSync(path.join(dataDir!, 'genesis.json'), 'utf8')).communityId as string;

    const pubkey = () => crypto.randomBytes(32).toString('hex');
    const owner = pubkey();
    const admin = pubkey();
    const moderator = pubkey();
    seedGenesisMember(owner, 'Olive');
    for (const [pk, callsign] of [[admin, 'Adam'], [moderator, 'Mo'], ['ab'.repeat(32), 'OffboxMarker']]) {
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
    const asOwner = { 'x-admin-session': session(owner, 'owner') };
    const asAdmin = { 'x-admin-session': session(admin, 'admin') };
    const asMod = { 'x-admin-session': session(moderator, 'moderator') };
    const asPassword = { 'x-admin-password': PW };

    await initTls();
    const port = await https.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const answers: string[] = [];
    async function call(method: string, route: string, headers: Record<string, string>, body?: unknown) {
        resetAdminAuthTarpit();
        https.resetAdminRateLimit();
        const init: RequestInit = { method, headers: { ...headers } };
        if (method !== 'GET') {
            (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body ?? {});
        }
        const res = await fetch(base + route, init);
        const bytes = Buffer.from(await res.arrayBuffer());
        let json: any = null;
        try { json = JSON.parse(bytes.toString('utf8')); } catch { /* a file */ }
        answers.push(`${route} ${res.status} ${JSON.stringify([...res.headers])} ${json ? JSON.stringify(json) : `<${bytes.length} bytes>`}`);
        return { status: res.status, bytes, json, headers: res.headers };
    }
    const status = async () => (await call('POST', '/api/local/admin/offbox-backups/status', asOwner)).json;
    const health = async (creds = asOwner) => (await call('POST', '/api/local/admin/diagnostics', creds)).json?.offboxBackups;
    const objects = async (store: typeof storeA) => [...(await store.objects()).keys()].sort();
    const puts = async (store: typeof storeA) => (await store.log()).filter((e) => e.method === 'PUT');
    const folderA = `${community}/`;

    // ── 1. No recovery code: nothing goes off the box; retention still runs ─────────────────────────────────────────
    console.log('\n— 1. no recovery code —');
    const now0 = Date.now();
    await storeA.seed(`${folderA}${nameAt(now0 - 40 * DAY)}`, Buffer.from('old'), undefined, now0 - 40 * DAY);
    await storeA.seed(`${folderA}${nameAt(now0 - 2 * DAY)}`, Buffer.from('recent'), undefined, now0 - 2 * DAY);
    await storeA.seed(`otherc0mmunity1/${nameAt(now0 - 40 * DAY)}`, Buffer.from('theirs'), undefined, now0 - 40 * DAY);
    await storeA.seed(`${folderA}notes-${nameAt(now0 - 40 * DAY)}`, Buffer.from('not ours'), undefined, now0 - 40 * DAY);
    await storeA.clearLog();
    const r1 = await offbox.runOffboxBackups({ force: true });
    assert(r1.skipped === 'not-locked' && r1.sent.length === 0, `1. forced run without a recovery code sends nothing (${JSON.stringify(r1)})`);
    assert((await puts(storeA)).length === 0, '1. …no PUT reached the store');
    const left1 = await objects(storeA);
    assert(!left1.includes(`${folderA}${nameAt(now0 - 40 * DAY)}`) && left1.includes(`${folderA}${nameAt(now0 - 2 * DAY)}`)
        && left1.includes(`otherc0mmunity1/${nameAt(now0 - 40 * DAY)}`) && left1.includes(`${folderA}notes-${nameAt(now0 - 40 * DAY)}`),
        `1. retention runs anyway: the 40-day-old backup went; the 2-day-old one, another community's and another name stayed (${left1.join(', ')})`);
    const st1 = await status();
    assert(st1?.state === 'not-locked' && /no recovery code/.test(st1.message) && /only a locked backup may leave/.test(st1.message),
        `1. the Backup tab's status says why, in words (${st1?.state}: ${st1?.message})`);
    const h1 = await health();
    assert(Array.isArray(h1?.problems) && h1.problems.some((p: string) => /no recovery code/.test(p)), `1. the owner's health says it too (${JSON.stringify(h1)})`);
    assert((await health(asAdmin)) === null, "1. an admin's diagnostics carry no off-box line (owners only)");
    const bk1 = await call('POST', '/api/local/admin/backup', asOwner);
    assert(bk1.status === 200 && isGzip(bk1.bytes), '1. no hard gate: the Backup tab still downloads its (readable) backup');

    // ── 2. With a recovery code, on schedule ─────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. on schedule —');
    const code = await makeRecoveryCode();
    await storeA.clearLog();
    const r2 = await offbox.runOffboxBackups();
    assert(r2.sent.join() === 'env-1' && r2.failed.length === 0, `2. the scheduled check sends to the destination never sent to (${JSON.stringify(r2)})`);
    const sentA = (await objects(storeA)).filter((k) => k.startsWith(folderA) && /^beanpool-backup-.*\.bpsealed$/.test(k.slice(folderA.length)) && k !== `${folderA}${nameAt(now0 - 2 * DAY)}`);
    assert(sentA.length === 1, `2. one new file in the community's folder (${sentA.join(', ')})`);
    const objA = (await storeA.objects()).get(sentA[0])!;
    const header = readSealedHeader(new Uint8Array(objA.bytes));
    assert(!isGzip(objA.bytes) && header.kind === 'backup' && header.communityId === community
        && header.recipients.some((r: any) => r.type === 'code' && r.codeId === code.codeId),
        '2. it is a locked backup of this community, locked to the recovery code (not a readable tar)');
    assert(objA.meta === sha(objA.bytes), '2. the hash it was sent with is kept beside it, and is its hash');
    const putLog = await puts(storeA);
    assert(putLog.length === 1 && putLog[0].authOk && putLog[0].status === 200, '2. one signed PUT');

    const B = { name: 'Outside store', endpoint: storeB.endpoint, bucket: storeB.bucket, region: storeB.region, prefix: '/offsite//node1/',
        accessKeyId: storeB.accessKeyId, secretAccessKey: storeB.secretAccessKey };
    const addB = await call('POST', '/api/local/admin/offbox-backups/settings', asOwner, { destination: B });
    const idB = addB.json?.status?.destinations?.find((d: any) => d.source === 'settings')?.id;
    assert(addB.status === 200 && typeof idB === 'string' && addB.json.status.destinations.find((d: any) => d.id === idB).prefix === 'offsite/node1/',
        `2. an owner adds a destination in Settings; its folder is tidied to "offsite/node1/" (${addB.status})`);
    await storeA.clearLog();
    const r3 = await offbox.runOffboxBackups();
    assert(r3.sent.join() === idB && (await puts(storeA)).length === 0, `2. the next check sends to the new one only: the first is not due yet (${JSON.stringify(r3)})`);
    const folderB = `offsite/node1/${community}/`;
    assert((await objects(storeB)).filter((k) => k.startsWith(folderB)).length === 1, '2. …into its folder');
    const r4 = await offbox.runOffboxBackups({ now: Date.now() + 25 * HOUR });
    assert(r4.sent.slice().sort().join() === ['env-1', idB].sort().join(), `2. past the interval both are due (${JSON.stringify(r4)})`);
    // An edit that does not send the secret keeps the stored one (the screen never has it).
    const rename = await call('POST', '/api/local/admin/offbox-backups/settings', asOwner, { destination: { ...B, id: idB, name: 'Outside store (renamed)', accessKeyId: '', secretAccessKey: '' } });
    await storeB.clearLog();
    const r5 = await offbox.runOffboxBackups({ force: true });
    assert(rename.status === 200 && r5.sent.includes(idB) && (await puts(storeB)).every((e) => e.authOk),
        `2. renaming it without sending the key id or the secret keeps both: the next upload is signed right (${rename.status}, ${JSON.stringify(r5)})`);

    // ── 3. A failing destination ─────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 3. failing —');
    await storeB.clearLog();
    await storeB.fault({ method: 'PUT', status: 503, count: 2 });
    const r6 = await offbox.runOffboxBackups({ force: true });
    const tries = (await puts(storeB)).map((e) => e.status);
    assert(r6.sent.includes(idB) && tries.join() === '503,503,200', `3. two 503s are retried within the run (${tries.join()})`);
    await storeB.clearLog();
    await storeB.fault({ method: 'PUT', status: 503, count: 3 });
    const tFail = Date.now();
    const r7 = await offbox.runOffboxBackups({ force: true, now: tFail });
    assert(r7.failed.some((f) => f.id === idB && /503/.test(f.error)) && r7.sent.includes('env-1'),
        `3. three fail it, and the other destination still gets its copy (${JSON.stringify(r7)})`);
    const st3 = await status();
    const b3 = st3.destinations.find((d: any) => d.id === idB);
    assert(b3.health === 'failing' && b3.failures === 1 && /HTTP 503/.test(b3.lastError) && b3.nextAttemptAt === tFail + 15 * 60_000,
        `3. the status shows it failing, why, and when it is tried next (${JSON.stringify(b3)})`);
    const h3 = await health();
    assert(h3.problems.some((p: string) => p.includes('Outside store (renamed)') && /failed/.test(p) && /503/.test(p)), `3. so does the owner's health (${JSON.stringify(h3)})`);
    await storeB.clearLog();
    const r8 = await offbox.runOffboxBackups({ now: tFail + 5 * 60_000 });
    assert(!r8.sent.includes(idB) && !r8.failed.some((f) => f.id === idB) && (await puts(storeB)).length === 0, '3. not tried again at 5 minutes');
    const r9 = await offbox.runOffboxBackups({ now: tFail + 16 * 60_000 });
    const b9 = (await status()).destinations.find((d: any) => d.id === idB);
    assert(r9.sent.includes(idB) && b9.health === 'ok' && b9.failures === 0 && b9.lastError === null, `3. tried again at 16 minutes, and works (${JSON.stringify(b9)})`);
    assert(!(await health()).problems.some((p: string) => p.includes('Outside store')), '3. …and the health line is gone');
    await storeB.clearLog();
    await storeB.fault({ method: 'PUT', status: 403, code: 'AccessDenied', count: 1 });
    const r10 = await offbox.runOffboxBackups({ force: true });
    const f10 = r10.failed.find((f) => f.id === idB);
    assert(!!f10 && /AccessDenied/.test(f10.error) && /refused these credentials/.test(f10.error) && (await puts(storeB)).length === 1,
        `3. a 403 is not retried and says the store refused the key (${f10?.error})`);
    await offbox.runOffboxBackups({ force: true });
    const stateFile = path.join(dataDir!, offbox.OFFBOX_STATE_FILE);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.destinations['env-1'].lastSuccessAt = Date.now() - 40 * HOUR;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const stale = (await status()).destinations.find((d: any) => d.id === 'env-1');
    assert(stale.health === 'stale' && (await health()).problems.some((p: string) => /No off-box backup has reached "Env store" since/.test(p)),
        `3. no upload for 40 hours (interval 24) shows as stale, to the owner (${stale.health})`);
    await offbox.runOffboxBackups({ force: true });

    // ── 4. Retention ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 4. retention —');
    const now4 = Date.now();
    const k31 = `${folderA}${nameAt(now4 - 31 * DAY)}`;
    const k29 = `${folderA}${nameAt(now4 - 29 * DAY)}`;
    const k10 = `${folderA}${nameAt(now4 - 10 * DAY)}`;
    const kOldStore = `${folderA}${nameAt(now4 - 1 * DAY)}`;
    await storeA.seed(k31, Buffer.from('a'), undefined, now4 - 31 * DAY);
    await storeA.seed(k29, Buffer.from('b'), undefined, now4 - 29 * DAY);
    await storeA.seed(k10, Buffer.from('c'), undefined, now4 - 10 * DAY);
    // Its name says yesterday; the store says it has held it 31 days. The older one counts.
    await storeA.seed(kOldStore, Buffer.from('d'), undefined, now4 - 31 * DAY);
    await offbox.runOffboxBackups({ force: true });
    let leftA = await objects(storeA);
    assert(!leftA.includes(k31) && !leftA.includes(kOldStore) && leftA.includes(k29) && leftA.includes(k10),
        '4. 30 days by default: 31 days by its name or by the store goes; 29 and 10 stay');
    const tooLong = await call('POST', '/api/local/admin/offbox-backups/settings', asOwner, { retentionDays: 31 });
    const zero = await call('POST', '/api/local/admin/offbox-backups/settings', asOwner, { retentionDays: 0 });
    const badInterval = await call('POST', '/api/local/admin/offbox-backups/settings', asOwner, { intervalHours: 169 });
    assert(tooLong.status === 400 && /within 30 days/.test(tooLong.json?.error) && zero.status === 400 && badInterval.status === 400,
        `4. more than 30 days is refused, in words (${tooLong.json?.error})`);
    process.env.BACKUP_OFFBOX_RETENTION_DAYS = '90';
    assert((await status()).retentionDays === 30, '4. 90 days in .env is read as 30');
    delete process.env.BACKUP_OFFBOX_RETENTION_DAYS;
    const seven = await call('POST', '/api/local/admin/offbox-backups/settings', asOwner, { retentionDays: 7 });
    await offbox.runOffboxBackups({ force: true });
    leftA = await objects(storeA);
    assert(seven.status === 200 && seven.json.status.retentionDays === 7 && !leftA.includes(k29) && !leftA.includes(k10),
        '4. set to 7 days: the 29- and 10-day-old ones go at the next run');
    assert(leftA.includes(`otherc0mmunity1/${nameAt(now0 - 40 * DAY)}`), "4. another community's backups are never touched");

    // ── 5. Credentials ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 5. credentials —');
    const httpOff = await call('POST', '/api/local/admin/offbox-backups/settings', asOwner, { destination: { ...B, endpoint: 'http://backups.example.com' } });
    assert(httpOff.status === 400 && /https:\/\//.test(httpOff.json?.error), `5. an http:// endpoint off this machine is refused (${httpOff.json?.error})`);
    process.env.BACKUP_OFFBOX_2_ENDPOINT = 'ftp://not-a-store';
    process.env.BACKUP_OFFBOX_2_SECRET_ACCESS_KEY = 'env-two-SECRET-do-not-show';
    const st5 = await status();
    const broken = st5.destinations.find((d: any) => d.id === 'env-2');
    assert(broken?.health === 'broken' && broken.problems.some((p: string) => /BACKUP_OFFBOX_2_ENDPOINT/.test(p))
        && broken.problems.some((p: string) => /missing: .*BACKUP_OFFBOX_2_BUCKET/.test(p)) && !JSON.stringify(st5).includes('ftp://not-a-store'),
        `5. a .env destination that can't be used names the settings, never their values (${JSON.stringify(broken?.problems)})`);
    assert((await health()).problems.some((p: string) => /destination 2/.test(p) && /BACKUP_OFFBOX_2_ENDPOINT/.test(p)), "5. …and is in the owner's health");
    SECRETS.push('env-two-SECRET-do-not-show');
    delete process.env.BACKUP_OFFBOX_2_ENDPOINT;
    delete process.env.BACKUP_OFFBOX_2_SECRET_ACCESS_KEY;
    // The two .env destinations reach a docker node: docker-compose.yml passes every setting the server reads, empty by default.
    const compose = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docker-compose.yml'), 'utf8');
    const settingNames = [1, 2].flatMap((n) => ['ENDPOINT', 'BUCKET', 'REGION', 'PREFIX', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'NAME'].map((f) => `BACKUP_OFFBOX_${n}_${f}`))
        .concat(['BACKUP_OFFBOX_INTERVAL_HOURS', 'BACKUP_OFFBOX_RETENTION_DAYS']);
    const notPassed = settingNames.filter((v) => !compose.includes(`- ${v}=\${${v}:-}`));
    assert(notPassed.length === 0, `5. docker-compose.yml passes all ${settingNames.length} off-box settings from .env, empty by default${notPassed.length ? ` (missing: ${notPassed.join(', ')})` : ''}`);
    const shown = (await status()).destinations.filter((d: any) => d.health !== 'broken');
    assert(shown.every((d: any) => d.secretSet === true && d.accessKeyId !== KEY_ID && d.accessKeyId.includes('…')),
        `5. the status says a secret is set and shortens the key id (${shown.map((d: any) => d.accessKeyId).join(', ')})`);
    const settingsFile = path.join(dataDir!, offbox.OFFBOX_SETTINGS_FILE);
    assert((fs.statSync(settingsFile).mode & 0o777) === 0o600, '5. the settings file is mode 600');
    // A backup, opened with the code: nothing of any store's credentials inside.
    const latest = (await storeB.objects()).get((await offbox.listOffboxBackups(idB))!.backups[0].key)!;
    const sealedFile = path.join(work, 'latest.bpsealed');
    fs.writeFileSync(sealedFile, latest.bytes);
    const opened = path.join(work, 'latest.tar.gz');
    await openSealedFileTo(sealedFile, { type: 'code', code: code.code }, opened);
    const unpacked = path.join(work, 'unpacked');
    fs.mkdirSync(unpacked);
    spawnSync('tar', ['-xzf', opened, '-C', unpacked]);
    const backupText = fs.readdirSync(unpacked, { recursive: true }).map((f) => path.join(unpacked, String(f)))
        .filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f).toString('latin1')).join('\n');
    assert(backupText.includes('OffboxMarker') && fs.existsSync(path.join(unpacked, 'state.db')), '5. (the backup opens with the code and holds the community)');
    const logRows = (db.prepare('SELECT message FROM system_logs').all() as { message: string }[]).map((r) => r.message).join('\n');
    assert(/\[Off-box\]/.test(logRows), '5. (the log table has the off-box lines)');
    const places: [string, string][] = [
        ['the console', printed.join('')],
        ['the log table', logRows],
        ['an answer', answers.join('\n')],
        ['the backup sent off the box (opened)', backupText],
        ['the database', fs.readFileSync(path.join(dataDir!, 'state.db')).toString('latin1') + (fs.existsSync(path.join(dataDir!, 'state.db-wal')) ? fs.readFileSync(path.join(dataDir!, 'state.db-wal')).toString('latin1') : '')],
        ['local-config.json', fs.readFileSync(path.join(dataDir!, 'local-config.json'), 'utf8')],
        ['the state file', fs.readFileSync(stateFile, 'utf8')],
    ];
    for (const [where, text] of places) {
        const found = [...SECRETS, KEY_ID].filter((s) => text.includes(s));
        assert(found.length === 0, `5. no secret and no key id in ${where}${found.length ? ` (found ${found.length})` : ''}`);
    }

    // ── 6. A standby sends nothing and touches no store ──────────────────────────────────────────────────────────────
    console.log('\n— 6. standby —');
    setNodeRole('backup');
    await storeA.clearLog();
    await storeB.clearLog();
    const r6s = await offbox.runOffboxBackups({ force: true, now: Date.now() + 30 * DAY });
    assert(r6s.skipped === 'standby' && r6s.sent.length === 0 && (await storeA.log()).length === 0 && (await storeB.log()).length === 0,
        `6. a standby's forced run sends nothing and asks no store anything, not even a listing (${JSON.stringify(r6s)})`);
    const st6 = await status();
    assert(st6.state === 'standby' && /standby/.test(st6.message) && (await health()) === null, `6. the status says so; no health line (${st6.message})`);
    setNodeRole('primary');

    // ── 7. Round trip onto a fresh server ────────────────────────────────────────────────────────────────────────────
    console.log('\n— 7. round trip —');
    await offbox.runOffboxBackups({ force: true });
    const newestB = (await offbox.listOffboxBackups(idB))!.backups.filter((b) => b.ours)[0];
    const newestBytes = (await storeB.objects()).get(newestB.key)!.bytes;
    // What the backup holds, opened here with the code: the database the fresh server must end up with.
    fs.writeFileSync(sealedFile, newestBytes);
    fs.rmSync(unpacked, { recursive: true, force: true });
    fs.mkdirSync(unpacked);
    await openSealedFileTo(sealedFile, { type: 'code', code: code.code }, opened);
    spawnSync('tar', ['-xzf', opened, '-C', unpacked]);
    const expected = await tableDigests(path.join(unpacked, 'state.db'));
    // The owner's own download, through this server's route, is the stored file byte for byte.
    const ownDl = await call('GET', `/api/local/admin/offbox-backups/download?destination=${encodeURIComponent(idB)}&key=${encodeURIComponent(newestB.key)}`, asOwner);
    assert(ownDl.status === 200 && sha(ownDl.bytes) === sha(newestBytes) && ownDl.headers.get('x-backup-sha256') === sha(newestBytes),
        `7. the owner downloads it through Settings, byte for byte, with its hash (${ownDl.status})`);
    const notOurs = await call('GET', `/api/local/admin/offbox-backups/download?destination=${encodeURIComponent(idB)}&key=${encodeURIComponent('offsite/node1/../x')}`, asOwner);
    assert(notOurs.status === 404, '7. a key that is not one of its backups is not served');
    // A store that gives back different bytes than were sent: the download breaks off short, never a whole-looking file.
    const tampered = Buffer.from(newestBytes);
    tampered[tampered.length - 1] ^= 0xff;
    const tamperedKey = `${folderB}${nameAt(Date.now() + 60_000)}`;
    await storeB.seed(tamperedKey, tampered, undefined, undefined, sha(newestBytes));
    let whole: boolean;
    try {
        const res = await fetch(`${base}/api/local/admin/offbox-backups/download?destination=${encodeURIComponent(idB)}&key=${encodeURIComponent(tamperedKey)}`, { headers: asOwner });
        const got = Buffer.from(await res.arrayBuffer());
        whole = res.status === 200 && got.length === tampered.length;
    } catch {
        whole = false;
    }
    assert(!whole, '7. a store that gives back different bytes than were sent: the download breaks off short of its length');
    await storeB.remove(tamperedKey);

    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offbox-fresh-'));
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--fresh'], {
        env: {
            ...process.env, BEANPOOL_DATA_DIR: freshDir, TEST_RECOVERY_CODE: code.code, TEST_COMMUNITY: community,
            TEST_S3: JSON.stringify({ ...B, prefix: 'offsite/node1' }),
            BACKUP_OFFBOX_1_ENDPOINT: '', BACKUP_OFFBOX_1_BUCKET: '', BACKUP_OFFBOX_1_REGION: '', BACKUP_OFFBOX_1_ACCESS_KEY_ID: '',
            BACKUP_OFFBOX_1_SECRET_ACCESS_KEY: '', BACKUP_OFFBOX_1_NAME: '',
        },
        encoding: 'utf-8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    });
    fs.rmSync(freshDir, { recursive: true, force: true });
    const line = (child.stdout || '').split('\n').find((l) => l.startsWith('CHILD_RESULT '));
    if (!line) {
        console.error(child.stdout?.slice(-3000), child.stderr?.slice(-3000));
        throw new Error(`the fresh server printed no result (exit ${child.status})`);
    }
    const fr = JSON.parse(line.slice('CHILD_RESULT '.length));
    assert(fr.setStatus === 200 && fr.statusBefore === 'not-locked', `7. the fresh server is given the destination in Settings; it has no recovery code, so it sends nothing (${fr.setStatus}, ${fr.statusBefore})`);
    assert(fr.listStatus === 200 && fr.listed.length > 0 && fr.listed.every((b: any) => b.community === community && b.ours === false) && fr.picked === newestB.key,
        `7. it lists the lost community's backups (not its own), newest first (${fr.listed.length} listed, picked ${fr.picked})`);
    assert(fr.download?.status === 200 && fr.download.sha === sha(newestBytes) && fr.download.header === fr.download.sha
        && /filename="beanpool-backup-.*\.bpsealed"/.test(fr.download.disposition),
        '7. it downloads the newest through its own route, byte for byte');
    assert(fr.restore?.status === 200 && fr.restore.body?.success === true && fr.restore.body?.sealed === true && fr.communityAfter === community,
        `7. it restores it with the recovery code, and is now the community (${fr.restore?.status}: ${JSON.stringify(fr.restore?.body).slice(0, 200)})`);
    const differs = Object.keys({ ...expected, ...fr.digests }).filter((t) => expected[t] !== fr.digests[t]);
    assert(Object.keys(expected).length > 20 && differs.length === 0,
        `7. its database is the backup's, every table row for row (${Object.keys(expected).length} tables${differs.length ? `; differ: ${differs.join(', ')}` : ''})`);
    const childText = `${child.stdout}\n${child.stderr}`;
    assert(![...SECRETS, KEY_ID].some((s) => childText.includes(s)), "7. no secret and no key id in the fresh server's output");

    // ── 8. Owner only ────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 8. owner only —');
    const settingsBefore = fs.readFileSync(settingsFile, 'utf8');
    const routes: [string, string, unknown][] = [
        ['POST', '/api/local/admin/offbox-backups/status', {}],
        ['POST', '/api/local/admin/offbox-backups/settings', { retentionDays: 1, removeId: idB }],
        ['POST', '/api/local/admin/offbox-backups/run', {}],
        ['POST', '/api/local/admin/offbox-backups/list', { destination: idB }],
        ['GET', `/api/local/admin/offbox-backups/download?destination=${encodeURIComponent(idB)}&key=${encodeURIComponent(newestB.key)}`, undefined],
    ];
    await storeA.clearLog();
    await storeB.clearLog();
    for (const [method, route, body] of routes) {
        for (const [who, creds] of [['an admin', asAdmin], ['a moderator', asMod]] as const) {
            const r = await call(method, route, creds, body);
            const words = String(r.json?.error ?? '');
            assert(r.status === 403 && (who === 'a moderator' ? /Moderators can/.test(words) || words === OFFBOX_OWNER_ONLY : words === OFFBOX_OWNER_ONLY)
                && !r.bytes.includes(Buffer.from('bpseal')), `8. ${method} ${route.split('?')[0]}: ${who} is refused, in words (${r.status}: ${words})`);
        }
        const none = await call(method, route, {}, body);
        assert(none.status === 401, `8. ${route.split('?')[0]}: no credential is 401 (${none.status})`);
    }
    await new Promise((r) => setTimeout(r, 200));
    assert(fs.readFileSync(settingsFile, 'utf8') === settingsBefore && (await storeA.log()).length === 0 && (await storeB.log()).length === 0,
        '8. …nothing changed, and no store was asked anything');
    for (const [who, creds] of [["an owner's key session", asOwner], ['the node password', asPassword]] as const) {
        const s = await call('POST', '/api/local/admin/offbox-backups/status', creds);
        const l = await call('POST', '/api/local/admin/offbox-backups/list', creds, { destination: idB });
        assert(s.status === 200 && l.status === 200 && l.json.backups.length > 0, `8. ${who} reads the status and the list (${s.status}, ${l.status})`);
    }
    const run = await call('POST', '/api/local/admin/offbox-backups/run', asOwner);
    assert(run.status === 200 && run.json?.started === true, '8. an owner sends one now');
    for (let i = 0; i < 100 && (await status()).running; i++) await new Promise((r) => setTimeout(r, 100));
    const removed = await call('POST', '/api/local/admin/offbox-backups/settings', asOwner, { removeId: idB });
    assert(removed.status === 200 && !removed.json.status.destinations.some((d: any) => d.id === idB) && (await objects(storeB)).length > 0,
        '8. an owner removes a destination; what it holds stays there');

    await storeA.stop();
    await storeB.stop();
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(testsPassed === testsRun ? 0 : 1);
}

(IS_FRESH ? fresh() : main()).catch((err) => {
    console.error(err);
    process.exit(1);
});
