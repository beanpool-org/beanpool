/**
 * The node locks every sign-in recovery copy with a key kept outside its database (recovery seal S1:
 * services/recovery-seal-key.ts, engine/recovery-shares.ts). Over real HTTP, through the real signature
 * middleware, with the round-trip suite's Google fixture (test-sso-recovery-roundtrip.ts):
 *
 *   1. after a deposit, the database FILE holds none of the client's seed box, salt or words box;
 *   2. a copy of state.db, opened in a second process with no key file, does not open with the sub;
 *   3. the same copy beside the key file opens, to the same seed;
 *   4. with the key file deleted at runtime, a deposit is refused (503, the sentence) and stores nothing, and a
 *      collect answers the sentence;
 *   5. rows written before the wrap (the frozen 1b fixtures) are wrapped by the migration, a second run changes
 *      nothing, and they still recover end to end;
 *   6. a released row in recovery_releases holds none of the inner bytes, and the fragments route hands back
 *      exactly what the client deposited;
 *   7. the reverse migration (the rollback command, run as a command) restores the rows byte for byte;
 *   8. a standby (NODE_ROLE=backup) makes no key file, a main server makes one (0600), and an unreadable key
 *      file never stops a boot;
 *   9. moving a member to a new key (the re-key wizard) keeps their copy openable.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-seal.ts
 *
 * The second processes are this file again, with RECOVERY_SEAL_CHILD set; each gets its own data directory and is
 * stopped with this run however it ends.
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME; // force self-signed / LAN mode

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sealSeedToSso, openSeedFromSso, openShareFromSso } from '@beanpool/core';

const SCRIPT = fileURLToPath(import.meta.url);
const SEAL_CLI = path.join(path.dirname(SCRIPT), 'services', 'recovery-seal-key.ts');
const CHILD = process.env.RECOVERY_SEAL_CHILD;

/** The design's sentence (§4 "Where"), word for word: what a server without its key says. */
const SENTENCE = 'This server holds sign-in recovery copies it cannot open: data/recovery-seal.key is missing.';
const KEY_FILE = 'recovery-seal.key';

// ── fixtures (test-sso-recovery-roundtrip.ts) ─────────────────────────────────────────────────────
const GOOGLE_KID = 'test-recovery-seal-google-kid';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const GOOGLE_SUB = '110169484474386276334';
/** A test phrase, not an account. seed = SHA256(SHA256(words)), as both apps derive it. */
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const SEED = crypto.createHash('sha256').update(crypto.createHash('sha256').update(WORDS.join(' ')).digest()).digest();

/** 1b: copies sealed by origin/main's sealSeedToSso and ssoLookupHash at 7f92bd8e, before any wrap existed. */
const OLD_SEED_HEX = 'cdb6f28510570568bd01d9b982312020b785e3847664cbfb6ee753425085de9e';
const OLD_LOOKUP_SALT = 'S1-old-enrolment-lookup-salt';
const OLD_ENROLMENTS = [
    {
        provider: 'google',
        sub: '104729384756102938475',
        lookupHash: '-YIm_AtQgZa5zOM4Eh_-j80Ae5R5287GVhyPxMQSpY8',
        sealed: {
            encryptedShare: 'YRS1xq1OhCe0aLFLR06B9MRqj33l+c8QiyE9g7f5SyE=',
            shareIv: 'x8qPfZ/8xacJuwXBtdtOwJC/wUGx3lr0',
            shareTag: 'UJJwcoVHxrysQnywAsoAqg==',
            kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"lCAsfDPf6FmyKHL7tGQT+wPYIrUMUZiDSZQYYHsU7dc=","N":16384,"r":8,"p":1}',
        },
    },
    {
        provider: 'facebook',
        sub: '2718281828459045',
        lookupHash: 'W2ArgJjZyHbXaMlPtZ6HvQe9LEZ13_fbNMJcL4yiXyc',
        sealed: {
            encryptedShare: '1kGt6XHXTzy5EeRlKA3aFysAbX/B8xNinFHcSVaaFDE=',
            shareIv: 'gm0Zee4o8UYUrVSOTbPg2E0hqnWcjfzM',
            shareTag: 'AkyT9x4sncyx30vs2vLCtg==',
            kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"OomrCz8p0MKmpuIHvp2M4Rl/VAeLqqECQCRJe9oXQB4=","N":16384,"r":8,"p":1}',
        },
    },
] as const;

interface Sealed { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string }

// ── identities ─────────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; seed: Buffer }
function idFromSeed(seed: Buffer): Id {
    const priv = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
        format: 'der', type: 'pkcs8',
    });
    const pk = (crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv, seed };
}
const newId = (): Id => idFromSeed(crypto.randomBytes(32));

// ── child processes: this file again, in a data directory of its own ──────────────────────────────
const children = new Set<ChildProcess>();
const ownedDirs = new Set<string>();
process.on('exit', () => {
    for (const c of children) c.kill('SIGTERM');
    for (const d of ownedDirs) fs.rmSync(d, { recursive: true, force: true });
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => process.exit(128 + os.constants.signals[sig]));
}

function tempDir(label: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `recovery-seal-${label}-`));
    ownedDirs.add(d);
    return d;
}

interface ChildResult { code: number | null; stdout: string; stderr: string }
function runChild(args: string[], dataDir: string, env: Record<string, string>): Promise<ChildResult> {
    const child = spawn(process.execPath, [...process.execArgv, ...args], {
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, ...env } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout!.on('data', (d) => { stdout += d.toString(); });
    child.stderr!.on('data', (d) => { stderr += d.toString(); });
    return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            children.delete(child);
            resolve({ code: code ?? (signal ? -1 : null), stdout, stderr });
        });
    });
}

/** A child's answer: the last stdout line that starts with RESULT. */
function resultOf(r: ChildResult): any {
    const line = r.stdout.split('\n').reverse().find(l => l.startsWith('RESULT '));
    if (!line) throw new Error(`child gave no result (exit ${r.code}): ${r.stderr.slice(-800)}`);
    return JSON.parse(line.slice('RESULT '.length));
}

const thrown = (e: unknown) => `threw: ${(e as Error)?.message ?? String(e)}`;

/** The second process. Only ever run by runChild. */
async function child(mode: string): Promise<void> {
    const out: Record<string, unknown> = {};
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    if (mode === 'open-without-key' || mode === 'open-with-key') {
        const owner = process.env.SEAL_OWNER!;
        // What anyone holding the file does first: read the row as it lies, and try the sub on it.
        const raw = new Database(path.join(dataDir, 'state.db'), { readonly: true });
        const row = raw.prepare("SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'sso'").get(owner) as any;
        raw.close();
        out.rowFound = !!row;
        try {
            await openSeedFromSso(
                { encryptedShare: row.encrypted_share, shareIv: row.share_iv, shareTag: row.share_tag, kdfParams: row.kdf_params },
                'google', GOOGLE_SUB,
            );
            out.asStored = 'opened';
        } catch (e) { out.asStored = thrown(e); }
        // And the most they could hope for: the client's own kdfParams (its salt), which the row no longer shows.
        try {
            await openSeedFromSso(
                { encryptedShare: row.encrypted_share, shareIv: row.share_iv, shareTag: row.share_tag, kdfParams: process.env.SEAL_CLIENT_KDF! },
                'google', GOOGLE_SUB,
            );
            out.withClientSalt = 'opened';
        } catch (e) { out.withClientSalt = thrown(e); }
        // Then this server's own reader, on that copy.
        try {
            const { getCurrentShares } = await import('./engine/recovery-shares.js');
            const sso = getCurrentShares(owner).find(s => s.holderType === 'sso')!;
            const opened = await openSeedFromSso(
                { encryptedShare: sso.encryptedShare, shareIv: sso.shareIv, shareTag: sso.shareTag, kdfParams: sso.kdfParams ?? '' },
                'google', GOOGLE_SUB,
            );
            out.serverReader = 'opened';
            out.seedHex = Buffer.from(opened.seed).toString('hex');
            out.words = opened.words;
        } catch (e) { out.serverReader = thrown(e); }
    } else if (mode === 'boot') {
        try {
            const { initStateEngine } = await import('./state-engine.js');
            initStateEngine();
            out.booted = true;
        } catch (e) { out.booted = thrown(e); }
        const keyPath = path.join(dataDir, KEY_FILE);
        out.keyExists = fs.existsSync(keyPath);
        if (out.keyExists) {
            out.keyBytes = fs.statSync(keyPath).size;
            out.keyMode = (fs.statSync(keyPath).mode & 0o777).toString(8);
        }
    } else {
        out.error = `unknown child mode ${mode}`;
    }
    console.log(`RESULT ${JSON.stringify(out)}`);
}

// ── the parent ─────────────────────────────────────────────────────────────────────────────────────
let run = 0, passed = 0;
function check(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
async function section(name: string, fn: () => Promise<void>): Promise<void> {
    console.log(`\n── ${name} ──`);
    try { await fn(); } catch (e) { check(false, `${name}: ${thrown(e)}`); }
}

async function main(): Promise<void> {
    console.log('\nRecovery seal S1: sign-in recovery copies a database alone cannot open\n');
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const keyPath = path.join(dataDir, KEY_FILE);
    const dbPath = path.join(dataDir, 'state.db');

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { _resetJwksCacheForTests, _clearNoncesForTests } = await import('./sso.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { getCurrentShares } = await import('./engine/recovery-shares.js');
    const { listReleases } = await import('./engine/recovery-release.js');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    const BASE = `https://localhost:${port}`;

    const { publicKey: rsaPub, privateKey: rsaPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', {
        keys: [{ ...rsaPub.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any],
        expiresAt: Date.now() + 3600_000,
    });
    _clearNoncesForTests();
    function googleToken(sub: string, nonce: string): string {
        const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
        const payload = b64({
            iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email: 'seal@example.com', email_verified: true,
            iat: now, exp: now + 3600, nonce,
        });
        const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), rsaPriv).toString('base64url');
        return `${header}.${payload}.${sig}`;
    }

    /** Signed exactly as the real middleware requires: method, path, timestamp, nonce and body. */
    async function call(id: Id, p: string, body: unknown): Promise<{ status: number; body: any }> {
        // Every limiter emptied first: this suite makes more recovery calls from one address than a person would.
        resetGatewayRateLimit();
        pruneAuthAttempts(Date.now() + 120_000);
        const bodyString = JSON.stringify(body ?? {});
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const res = await fetch(`${BASE}${p}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Public-Key': id.pk,
                'X-Signature': crypto.sign(null, Buffer.from(`POST\n${p}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64'),
                'X-Timestamp': String(ts),
                'X-Nonce': nonce,
            },
            body: bodyString,
        });
        let parsed: any;
        try { parsed = await res.json(); } catch { parsed = undefined; }
        return { status: res.status, body: parsed };
    }

    function addMember(id: Id, prefix: string): string {
        const callsign = `${prefix}-${id.pk.slice(0, 6)}`;
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(id.pk, callsign);
        return callsign;
    }

    async function deposit(id: Id, sealed: Sealed, nonce?: string, token?: string) {
        const n = nonce ?? (await call(id, '/api/recovery/sso-nonce', {})).body?.nonce;
        return {
            nonce: n,
            token: token ?? googleToken(GOOGLE_SUB, n),
            res: await call(id, '/api/recovery/shares/sso', {
                provider: 'google', idToken: token ?? googleToken(GOOGLE_SUB, n), nonce: n,
                shares: [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...sealed }],
            }),
        };
    }

    /** Open a collection for `callsign` and release its Google copy with `sub`. */
    async function collectGoogle(callsign: string, sub: string) {
        const eph = newId();
        const opened = await call(eph, '/api/recovery/collect', { callsign });
        const collectionId = opened.body?.collectionId;
        const n = (await call(eph, '/api/recovery/collect/sso-nonce', { collectionId })).body?.nonce;
        const token = googleToken(sub, n);
        const released = await call(eph, '/api/recovery/collect/sso', {
            collectionId, provider: 'google', idToken: token, nonce: n,
        });
        return { eph, opened, collectionId, released, nonce: n, token };
    }

    /** Every piece of the client's box an attacker would look for, as base64 text and as raw bytes. */
    function needlesOf(sealed: Sealed): { label: string; bytes: Buffer }[] {
        const kdf = JSON.parse(sealed.kdfParams);
        const b64s: [string, string][] = [
            ['seed box', sealed.encryptedShare], ['seed box nonce', sealed.shareIv], ['seed box tag', sealed.shareTag],
            ['salt', kdf.salt],
        ];
        if (kdf.words) b64s.push(['words box', kdf.words.ct], ['words box nonce', kdf.words.iv], ['words box tag', kdf.words.tag]);
        const out: { label: string; bytes: Buffer }[] = [];
        for (const [label, v] of b64s) {
            out.push({ label: `${label} (base64)`, bytes: Buffer.from(v, 'utf-8') });
            out.push({ label: `${label} (bytes)`, bytes: Buffer.from(v, 'base64') });
        }
        return out;
    }

    /** The database as files on disk: state.db and whatever WAL sits beside it. */
    function dbFiles(): Buffer {
        return Buffer.concat(['', '-wal', '-shm']
            .map(s => dbPath + s)
            .filter(p => fs.existsSync(p))
            .map(p => fs.readFileSync(p)));
    }
    function foundInDbFiles(needles: { label: string; bytes: Buffer }[]): string[] {
        const files = dbFiles();
        return needles.filter(n => files.includes(n.bytes)).map(n => n.label);
    }

    // ── 1. after a deposit, the database file holds none of the client's box ───────────────────
    const m1 = idFromSeed(SEED);
    const callsign1 = addMember(m1, 'Seal');
    const sealed1 = await sealSeedToSso(new Uint8Array(SEED), 'google', GOOGLE_SUB, { words: WORDS }) as Sealed;
    const needles1 = needlesOf(sealed1);
    await section('1. a deposit leaves nothing in the database that the sub alone opens', async () => {
        const { res } = await deposit(m1, sealed1);
        check(res.status === 200 && res.body?.threshold === 1, `the deposit is accepted through the real middleware (got ${res.status} ${JSON.stringify(res.body)})`);
        check(foundInDbFiles([{ label: 'callsign', bytes: Buffer.from(callsign1) }]).length === 1,
            'control: the search does find what the database really holds (the callsign)');
        const inWal = foundInDbFiles(needles1);
        check(inWal.length === 0, `state.db and its WAL hold none of the client's seed box, salt or words box (found: ${inWal.join(', ') || 'none'})`);
        db.pragma('wal_checkpoint(TRUNCATE)');
        const inFile = foundInDbFiles(needles1);
        check(inFile.length === 0, `...nor does state.db after a checkpoint (found: ${inFile.join(', ') || 'none'})`);
        const row = db.prepare("SELECT kdf_params, sso_lookup_hash FROM recovery_shares WHERE owner_pubkey = ?").get(m1.pk) as any;
        check(!!row?.sso_lookup_hash, 'the lookup hash stays in the clear, where it finds the row and reveals nothing');
        check(!!row && JSON.parse(row.kdf_params).alg === 'node-wrap-xc20p-v1' && JSON.parse(row.kdf_params).inner === 'scrypt-xc20p-single-v1',
            `the stored kdf_params names the node wrap and the client scheme inside it, and nothing else (got ${row?.kdf_params})`);
        const served = getCurrentShares(m1.pk)[0];
        check(!!served && served.encryptedShare === sealed1.encryptedShare && served.shareIv === sealed1.shareIv
            && served.shareTag === sealed1.shareTag && served.kdfParams === sealed1.kdfParams,
            'every caller above storage still sees the bytes the client deposited');
    });

    // ── 6. a released row holds none of the inner bytes; the fragments route returns the deposit ──
    let collection6 = '';
    let eph6: Id | null = null;
    await section('6. a released copy is no more readable in the database than a stored one', async () => {
        const { eph, collectionId, released } = await collectGoogle(callsign1, GOOGLE_SUB);
        collection6 = collectionId; eph6 = eph;
        check(released.status === 200 && released.body?.enough === true, `a verified sign-in releases the copy (got ${released.status} ${JSON.stringify(released.body)})`);
        const rel = db.prepare('SELECT * FROM recovery_releases WHERE collection_id = ?').get(collectionId) as any;
        check(!!rel, 'the release is recorded in recovery_releases');
        const relText = Buffer.from(JSON.stringify(rel ?? {}));
        const inRow = needles1.filter(n => relText.includes(n.bytes)).map(n => n.label);
        check(!!rel && inRow.length === 0 && rel.payload !== sealed1.encryptedShare,
            `the release row holds none of the inner bytes (found: ${inRow.join(', ') || 'none'})`);
        db.pragma('wal_checkpoint(TRUNCATE)');
        const inFile = foundInDbFiles(needles1);
        check(inFile.length === 0, `...and neither does the database file (found: ${inFile.join(', ') || 'none'})`);
        const frags = await call(eph, '/api/recovery/collect/fragments', { collectionId });
        const f = frags.body?.fragments?.[0];
        check(frags.status === 200 && frags.body?.fragments?.length === 1, `the fragments route answers the device (got ${frags.status})`);
        check(!!f && f.payload === sealed1.encryptedShare && f.payloadIv === sealed1.shareIv && f.payloadTag === sealed1.shareTag
            && f.kdfParams === sealed1.kdfParams, '...with exactly what the client deposited, byte for byte');
        const opened = await openSeedFromSso({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams }, 'google', GOOGLE_SUB);
        check(Buffer.from(opened.seed).equals(SEED) && JSON.stringify(opened.words) === JSON.stringify(WORDS),
            '...which the recovering device opens with its sign-in to the seed and the 12 words');
    });

    // ── 2 and 3. a copy of the database, in another process, without and with the key ─────────
    await section('2. a copy of state.db in a second process, with no key file, does not open with the sub', async () => {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const copy = tempDir('nokey');
        fs.copyFileSync(dbPath, path.join(copy, 'state.db'));
        const r = resultOf(await runChild([SCRIPT], copy, {
            RECOVERY_SEAL_CHILD: 'open-without-key', SEAL_OWNER: m1.pk, SEAL_CLIENT_KDF: sealed1.kdfParams,
        }));
        check(r.rowFound === true, 'the copy holds the member\'s sign-in row');
        check(typeof r.asStored === 'string' && r.asStored.startsWith('threw:'), `the row as stored does not open with the sub (${r.asStored})`);
        check(typeof r.withClientSalt === 'string' && /did not open/.test(r.withClientSalt),
            `even with the client's own salt beside the sub, the stored box fails on the tag (${r.withClientSalt})`);
        check(r.serverReader === `threw: ${SENTENCE}`, `and this server's own reader, with no key file, says the sentence (${r.serverReader})`);
    });

    await section('3. the same copy beside the key file opens, to the same seed', async () => {
        check(fs.existsSync(keyPath), 'the main server keeps data/recovery-seal.key');
        const st = fs.existsSync(keyPath) ? fs.statSync(keyPath) : null;
        check(!!st && st.size === 32 && (st.mode & 0o777) === 0o600, `...32 bytes, readable by the server alone (0600) (got ${st?.size} bytes, ${st ? (st.mode & 0o777).toString(8) : '-'})`);
        const copy = tempDir('withkey');
        fs.copyFileSync(dbPath, path.join(copy, 'state.db'));
        if (st) fs.copyFileSync(keyPath, path.join(copy, KEY_FILE));
        const r = resultOf(await runChild([SCRIPT], copy, {
            RECOVERY_SEAL_CHILD: 'open-with-key', SEAL_OWNER: m1.pk, SEAL_CLIENT_KDF: sealed1.kdfParams,
        }));
        check(r.serverReader === 'opened' && r.seedHex === SEED.toString('hex'), `with the key, the copy opens to the member's seed (${r.serverReader})`);
        check(JSON.stringify(r.words) === JSON.stringify(WORDS), '...and the 12 words inside it');
    });

    // ── 4. the key file deleted while the server runs ───────────────────────────────────────────
    await section('4. with the key file gone, a deposit is refused and stores nothing, and a collect says so', async () => {
        const saved = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null;
        check(!!saved, 'setup: the key file exists before it is deleted');
        fs.rmSync(keyPath, { force: true });
        try {
            const m4 = newId();
            addMember(m4, 'SealNoKey');
            const sealed4 = await sealSeedToSso(new Uint8Array(m4.seed), 'google', GOOGLE_SUB) as Sealed;
            const d = await deposit(m4, sealed4);
            check(d.res.status === 503 && d.res.body?.error === SENTENCE,
                `a deposit is refused with 503 and the sentence (got ${d.res.status} ${JSON.stringify(d.res.body)})`);
            const stored = (db.prepare('SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ?').get(m4.pk) as any).n;
            check(stored === 0, `...and nothing is stored, wrapped or not (${stored} rows)`);

            const c = await collectGoogle(callsign1, GOOGLE_SUB);
            check(c.opened.status === 200, `a recovering device can still open a collection (got ${c.opened.status})`);
            check(c.released.status === 503 && c.released.body?.error === SENTENCE,
                `...and the sign-in release answers 503 with the sentence (got ${c.released.status} ${JSON.stringify(c.released.body)})`);
            if (eph6) {
                const frags = await call(eph6, '/api/recovery/collect/fragments', { collectionId: collection6 });
                check(frags.status === 503 && frags.body?.error === SENTENCE,
                    `a copy already released is not served either (got ${frags.status} ${JSON.stringify(frags.body)})`);
            }
            const status = await call(m1, '/api/recovery/shares/status', {});
            check(status.status === 503 && status.body?.error === SENTENCE,
                `the member's protection status says the same rather than reporting a copy that cannot open (got ${status.status})`);

            if (saved) fs.writeFileSync(keyPath, saved, { mode: 0o600 });
            const again = await deposit(m4, sealed4, d.nonce, d.token);
            check(again.res.status === 200,
                `with the key back, the same sign-in deposits: the refusal did not spend its nonce (got ${again.res.status} ${JSON.stringify(again.res.body)})`);
            const releasedNow = await call(c.eph, '/api/recovery/collect/sso', {
                collectionId: c.collectionId, provider: 'google', idToken: c.token, nonce: c.nonce,
            });
            check(releasedNow.status === 200 && releasedNow.body?.enough === true,
                `...and the recovering device's same sign-in releases: its nonce was not spent either (got ${releasedNow.status} ${JSON.stringify(releasedNow.body)})`);
        } finally {
            if (saved && !fs.existsSync(keyPath)) fs.writeFileSync(keyPath, saved, { mode: 0o600 });
        }
    });

    // ── 5. rows written before the wrap are wrapped in place, once ──────────────────────────────
    const oldMember = idFromSeed(Buffer.from(OLD_SEED_HEX, 'hex'));
    const oldCallsign = addMember(oldMember, 'SealOld');
    const PRE_COLLECTION = `pre-wrap-${crypto.randomBytes(8).toString('hex')}`;
    const STALE = '2026-01-01T00:00:00.000Z';
    await section('5. the migration wraps copies stored before it, a second run changes nothing, and they still recover', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const ins = db.prepare(`INSERT INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag,
             sso_lookup_hash, sso_lookup_salt, kdf_params, generation, created_at, updated_at)
            VALUES (?, 'sso', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
        const ids: number[] = [];
        OLD_ENROLMENTS.forEach((o, i) => {
            ids.push(Number(ins.run(oldMember.pk, o.provider, i + 1, o.sealed.encryptedShare, o.sealed.shareIv, o.sealed.shareTag,
                o.lookupHash, OLD_LOOKUP_SALT, o.sealed.kdfParams, STALE, STALE).lastInsertRowid));
        });
        db.prepare(`INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, created_at, expires_at)
                    VALUES (?, ?, 1, ?, 'complete', ?, ?)`).run(PRE_COLLECTION, oldMember.pk, newId().pk, STALE, STALE);
        const g = OLD_ENROLMENTS[0].sealed;
        db.prepare(`INSERT INTO recovery_releases (collection_id, share_id, holder_type, share_index, payload, payload_iv, payload_tag, kdf_params, released_at)
                    VALUES (?, ?, 'sso', 1, ?, ?, ?, ?, ?)`).run(PRE_COLLECTION, ids[0], g.encryptedShare, g.shareIv, g.shareTag, g.kdfParams, STALE);

        const first = seal.wrapRecoveryRows();
        check(first.shares === 2 && first.releases === 1, `the first run wraps the two copies and the one release stored before it (got ${JSON.stringify(first)})`);
        const snap = () => JSON.stringify({
            shares: db.prepare('SELECT id, encrypted_share, share_iv, share_tag, kdf_params, updated_at FROM recovery_shares ORDER BY id').all(),
            releases: db.prepare('SELECT id, payload, payload_iv, payload_tag, kdf_params, updated_at FROM recovery_releases ORDER BY id').all(),
        });
        const afterFirst = snap();
        const wrapped = db.prepare('SELECT * FROM recovery_shares WHERE owner_pubkey = ? ORDER BY id').all(oldMember.pk) as any[];
        check(wrapped.length === 2 && wrapped.every(r => JSON.parse(r.kdf_params).alg === 'node-wrap-xc20p-v1'),
            'both are now wrapped');
        check(wrapped.every(r => r.updated_at > STALE), '...and stamped, so a standby that already holds the unwrapped copy is sent the wrapped one');
        check(wrapped.every(r => r.sso_lookup_hash === OLD_ENROLMENTS.find(o => o.provider === r.holder_ref)!.lookupHash
            && r.sso_lookup_salt === OLD_LOOKUP_SALT), '...with their lookup hashes untouched');
        const second = seal.wrapRecoveryRows();
        check(second.shares === 0 && second.releases === 0, `a second run finds nothing to do (got ${JSON.stringify(second)})`);
        check(snap() === afterFirst, '...and every row is byte for byte what the first run left');
        const oldNeedles = OLD_ENROLMENTS.flatMap(o => needlesOf(o.sealed as Sealed));
        const left = foundInDbFiles(oldNeedles);
        check(left.length === 0, `the migration leaves none of the unwrapped bytes in the database files (found: ${left.join(', ') || 'none'})`);

        const c = await collectGoogle(oldCallsign, OLD_ENROLMENTS[0].sub);
        check(c.released.status === 200 && c.released.body?.enough === true, `a copy stored before the wrap still releases on a verified sign-in (got ${c.released.status} ${JSON.stringify(c.released.body)})`);
        const frags = await call(c.eph, '/api/recovery/collect/fragments', { collectionId: c.collectionId });
        const f = frags.body?.fragments?.[0];
        check(!!f && f.payload === g.encryptedShare && f.payloadIv === g.shareIv && f.payloadTag === g.shareTag && f.kdfParams === g.kdfParams,
            '...as exactly the bytes the earlier code stored');
        const seed = f ? await openShareFromSso({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams }, 'google', OLD_ENROLMENTS[0].sub) : null;
        check(!!seed && Buffer.from(seed).toString('hex') === OLD_SEED_HEX, '...which opens with the sign-in to the member\'s seed');
        const pre = listReleases(PRE_COLLECTION)[0];
        check(!!pre && pre.payload === g.encryptedShare && pre.payloadIv === g.shareIv && pre.payloadTag === g.shareTag && pre.kdfParams === g.kdfParams,
            'a release recorded before the wrap reads back as it was recorded');
    });

    // ── 7. the reverse migration: the rollback command ──────────────────────────────────────────
    await section('7. the reverse migration restores every row byte for byte', async () => {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const copy = tempDir('rollback');
        fs.copyFileSync(dbPath, path.join(copy, 'state.db'));
        if (fs.existsSync(keyPath)) fs.copyFileSync(keyPath, path.join(copy, KEY_FILE));
        const r = await runChild([SEAL_CLI, '--unwrap-recovery-rows'], copy, {});
        check(r.code === 0, `the rollback command exits 0 (got ${r.code}: ${r.stderr.slice(-400)})`);
        check(!/[A-Za-z0-9+/]{40,}={0,2}/.test(r.stdout.replace(/[0-9a-f]{64}/g, '')), 'its output holds counts, not keys or copies');
        const back = new Database(path.join(copy, 'state.db'), { readonly: true });
        try {
            const cols = (row: any) => row && { encryptedShare: row.encrypted_share, shareIv: row.share_iv, shareTag: row.share_tag, kdfParams: row.kdf_params };
            const same = (a: any, b: Sealed) => !!a && a.encryptedShare === b.encryptedShare && a.shareIv === b.shareIv
                && a.shareTag === b.shareTag && a.kdfParams === b.kdfParams;
            for (const o of OLD_ENROLMENTS) {
                const row = back.prepare('SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND holder_ref = ?').get(oldMember.pk, o.provider);
                check(same(cols(row), o.sealed as Sealed), `${o.provider}: the copy stored before the wrap is back exactly as it was`);
            }
            const m1Row = back.prepare("SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'sso'").get(m1.pk);
            check(same(cols(m1Row), sealed1), 'a copy deposited after the wrap comes back as exactly what the client sent');
            const rel = (id: string) => {
                const x = back.prepare('SELECT * FROM recovery_releases WHERE collection_id = ?').get(id) as any;
                return x && { encryptedShare: x.payload, shareIv: x.payload_iv, shareTag: x.payload_tag, kdfParams: x.kdf_params };
            };
            check(same(rel(PRE_COLLECTION), OLD_ENROLMENTS[0].sealed as Sealed), 'the release recorded before the wrap is back as it was');
            if (collection6) check(same(rel(collection6), sealed1), 'a release recorded after the wrap comes back as the client\'s bytes');
            const still = (back.prepare("SELECT COUNT(*) AS n FROM recovery_shares WHERE kdf_params LIKE '%node-wrap-xc20p-v1%'").get() as any).n
                + (back.prepare("SELECT COUNT(*) AS n FROM recovery_releases WHERE kdf_params LIKE '%node-wrap-xc20p-v1%'").get() as any).n;
            check(still === 0, `no wrapped row is left for the older server to trip on (${still})`);
        } finally { back.close(); }
    });

    // ── 8. who makes a key, and a boot that never stops for one ─────────────────────────────────
    await section('8. a standby makes no key file; a main server makes one; a bad key file never stops a boot', async () => {
        const standby = resultOf(await runChild([SCRIPT], tempDir('standby'), { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'backup' }));
        check(standby.booted === true && standby.keyExists === false, `a standby (NODE_ROLE=backup) boots with no key of its own (${JSON.stringify(standby)})`);
        const main = resultOf(await runChild([SCRIPT], tempDir('main'), { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary' }));
        check(main.booted === true && main.keyExists === true && main.keyBytes === 32 && main.keyMode === '600',
            `a main server makes its key at boot: 32 bytes, 0600 (${JSON.stringify(main)})`);
        const badDir = tempDir('badkey');
        fs.writeFileSync(path.join(badDir, KEY_FILE), Buffer.from('short'), { mode: 0o600 });
        const bad = resultOf(await runChild([SCRIPT], badDir, { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary' }));
        check(bad.booted === true, `a key file that is not a key does not stop the boot (${JSON.stringify(bad)})`);
        check(fs.readFileSync(path.join(badDir, KEY_FILE)).toString() === 'short', '...and is never overwritten: it may be the only copy someone can repair');
    });

    // ── 9. a member moved to a new key keeps an openable copy ───────────────────────────────────
    await section('9. moving a member to a new key keeps their copy openable', async () => {
        const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
        const m9 = newId();
        addMember(m9, 'SealRekey');
        const sealed9 = await sealSeedToSso(new Uint8Array(m9.seed), 'google', GOOGLE_SUB) as Sealed;
        const { res } = await deposit(m9, sealed9);
        check(res.status === 200, `setup: the member deposits a copy (got ${res.status})`);
        const moved = newId();
        const { code } = issueRekeyCode(m9.pk, 'owner:password');
        completeRekey(m9.pk, moved.pk, code, 'owner:password');
        const shares = getCurrentShares(moved.pk);
        check(shares.length === 1 && shares[0].encryptedShare === sealed9.encryptedShare && shares[0].kdfParams === sealed9.kdfParams,
            'after the move, the copy is filed under the new key and still opens with the server\'s key');
        const seed = shares[0] ? await openShareFromSso(shares[0] as Sealed, 'google', GOOGLE_SUB) : null;
        check(!!seed && Buffer.from(seed).equals(m9.seed), '...to the seed it was made from');
    });

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Recovery seal: a database, a copy of it or a released row opens nothing without the key kept beside it.');
}

if (CHILD) {
    child(CHILD).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
}
