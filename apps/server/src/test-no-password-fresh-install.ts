/**
 * No password on new installs (node sign-in step 8; config/local-config.ts initAdminPassword).
 *
 * Each boot is its own process on its own data dir, booted in the order index.ts boots (genesis, the admin password, TLS,
 * the database, the claim code, the real HTTPS server). Sign-ins and claims go over HTTPS through the real middleware.
 * The suites' seam (BEANPOOL_SUITE_ENV_PASSWORD) is removed from every boot here: these are what a real node does.
 *
 *   A. A fresh install with ADMIN_PASSWORD in .env: no first-admin-password.txt; one log line says ADMIN_PASSWORD is ignored
 *      and points at `beanpool claim`; the password is in no line of the output; it does not sign in, and an admin route
 *      with it is refused; local-config.json is not locked and holds no password hash. GET /api/local/claim says
 *      password: false (the Settings card then has no password fold). The claim code claims the node, and the claiming
 *      key is its owner.
 *   B. That claimed node rebooted with ADMIN_PASSWORD still set: still no password signs in, no hash, not locked.
 *   C. A fresh install with no ADMIN_PASSWORD: no first-admin-password.txt, no "ignored" line, a claim code.
 *   D. An existing node with a password (a local-config.json as an older version left it, its first-admin-password.txt
 *      still there), booted with another ADMIN_PASSWORD in .env: its own password still signs in, the .env one does not,
 *      the file is kept and the log still points at it, and no "ignored" line (that is for new installs).
 *   E. scripts/rotate-node-env.sh's ADMIN_PASSWORD rotation on an existing node (deciding review r4176337954): its own updater
 *      (the python it sends over SSH, run here on the node's project dir with a fake docker) edits local-config.json, then
 *      the node restarts with ADMIN_PASSWORD=<new>. The old password signed in before; afterwards the new one signs in, the
 *      old one does not, the config is locked with a hash again, and no "ignored" line: it is not read as a new install.
 *   F. The same rotation on a node whose hash came from a take-over (a standby installed on this version, promoted): it
 *      has a hash but no joinedAt. The new password signs in afterwards.
 *   G. The script on a new install (no password ever): it refuses ADMIN_PASSWORD (non-zero exit, "[not set]", pointing at
 *      the app and `beanpool recover`), leaves local-config.json as it was, and never says the password was set.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-no-password-fresh-install.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { claimKeyFromCode, claimProof, claimText, signedRequestBytes } from '@beanpool/core';

const SCRIPT = fileURLToPath(import.meta.url);
const CHILD_FLAG = '--child';
const HOST = 'no-password-test.example';
const ENV_PW = 'Fresh-Install-Env-61!';
const OLD_PW = 'Older-Node-Password-61!';
const NEW_PW = 'Rotated-Node-Password-61!';
const ROTATE_SCRIPT = path.join(path.dirname(SCRIPT), '..', '..', '..', 'scripts', 'rotate-node-env.sh');
const IGNORED = /ADMIN_PASSWORD in \.env is ignored: a new install has no admin password\..*beanpool claim/;

async function runChild(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const { ensureGenesis } = await import('./genesis.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { initClaimCode } = await import('./claim-code.js');
    const { startHttpsServer } = await import('./https-server.js');

    await ensureGenesis();
    initAdminPassword();
    await initTls();
    initStateEngine();
    initClaimCode();
    const port = await startHttpsServer(0);
    process.stdout.write('@@ ' + JSON.stringify({ ready: true, port }) + '\n');
    process.stdin.on('data', () => { /* the parent only closes it */ });
    process.stdin.on('end', () => process.exit(0));
}

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

interface Boot { port: number; output: () => string; stop: () => Promise<void> }

async function boot(dataDir: string, env: Record<string, string> = {}): Promise<Boot> {
    fs.mkdirSync(dataDir, { recursive: true });
    const childEnv: Record<string, string | undefined> = { ...process.env, BEANPOOL_DATA_DIR: dataDir };
    for (const k of ['ADMIN_PASSWORD', 'BEANPOOL_SUITE_ENV_PASSWORD', 'BEANPOOL_ADDRESSES', 'CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID']) delete childEnv[k];
    Object.assign(childEnv, { TRUSTED_PROXIES: '127.0.0.1' }, env);
    const proc: ChildProcess = spawn(process.execPath, [...process.execArgv, SCRIPT, CHILD_FLAG], {
        env: childEnv as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout!.on('data', (d) => { out += d.toString(); });
    proc.stderr!.on('data', (d) => { out += d.toString(); });
    const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
        exited.then((code) => { clearTimeout(timer); reject(new Error(`node exited (${code}) before it served:\n${out}`)); });
        const poll = setInterval(() => {
            const line = out.split('\n').find((l) => l.startsWith('@@ '));
            if (!line) return;
            clearInterval(poll);
            clearTimeout(timer);
            resolve({
                port: JSON.parse(line.slice(3)).port,
                output: () => out,
                stop: async () => {
                    proc.stdin!.end();
                    const t = setTimeout(() => proc.kill('SIGKILL'), 10_000);
                    await exited.catch(() => null);
                    clearTimeout(t);
                },
            });
        }, 25);
        exited.then(() => clearInterval(poll), () => clearInterval(poll));
    });
}

function request(b: Boot, method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            host: '127.0.0.1', port: b.port, path: route, method, rejectUnauthorized: false,
            headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}), ...headers },
        }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let json: any = null;
                try { json = JSON.parse(text); } catch { json = text; }
                resolve({ status: res.statusCode || 0, json });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

/** The password sign-in to Settings, through the real middleware. Each try from its own address: the auth brake never adds up. */
let source = 10;
const signsIn = async (b: Boot, password: string) =>
    (await request(b, 'POST', '/api/local/admin/auth/password', { password }, { 'X-Forwarded-For': `203.0.113.${source++}` })).status === 200;

interface Key { pub: string; priv: crypto.KeyObject }
function newKey(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
    return { pub, priv: privateKey };
}
/** A claim as a phone sends it (claim v2): the proof and the signature, never the code. */
function claimBody(k: Key, code: string, salt: string, codeId: string) {
    const proof = claimProof(claimKeyFromCode(code, salt), HOST, codeId, k.pub);
    const signature = crypto.sign(null, Buffer.from(signedRequestBytes(claimText(HOST, codeId, k.pub, proof))), k.priv).toString('base64');
    return { publicKey: k.pub, callsign: 'Founder', codeId, signedFor: HOST, proof, signature };
}

const configOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'local-config.json'), 'utf-8'));
const firstPwFile = (dir: string) => path.join(dir, 'first-admin-password.txt');
function roleOf(dir: string, pub: string): string | null {
    const db = new Database(path.join(dir, 'state.db'), { readonly: true });
    try {
        return (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pub) as { role: string } | undefined)?.role ?? null;
    } finally {
        db.close();
    }
}

/** A local-config.json as an older version left it: locked, its password set, joinedAt when it was. */
function existingConfig(dir: string, password: string, extra: Record<string, unknown> = {}): { hash: string; salt: string } {
    fs.mkdirSync(dir, { recursive: true });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    fs.writeFileSync(path.join(dir, 'local-config.json'), JSON.stringify({
        isLocked: true, callsign: null, location: null, adminHash: hash, salt, joinedAt: Date.now() - 86_400_000,
        communityName: null, contactEmail: null, contactPhone: null, ...extra,
    }, null, 2));
    return { hash, salt };
}

/**
 * scripts/rotate-node-env.sh's own updater (the python it sends to the node over SSH), run on <project>/ (the node's data
 * dir is <project>/data) with the given KEY=value lines. `docker` is a fake on PATH that only records it ran.
 */
function rotate(project: string, pairs: string[]): { code: number | null; out: string } {
    const updater = fs.readFileSync(ROTATE_SCRIPT, 'utf8').match(/UPDATE_SCRIPT=\$\(cat << 'REMOTE_PYTHON'\n([\s\S]*?)\nREMOTE_PYTHON\n/)?.[1];
    if (!updater) throw new Error('the updater was not found in scripts/rotate-node-env.sh');
    const bin = path.join(project, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho ran > "${path.join(project, 'docker-ran')}"\n`, { mode: 0o755 });
    const r = spawnSync('python3', ['-c', updater, '0', project, 'bp-test'], {
        input: pairs.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

async function main(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || os.tmpdir(), 'nopw-'));

    console.log('\nA. A fresh install with ADMIN_PASSWORD in .env');
    const dirA = path.join(root, 'a');
    let a = await boot(dirA, { ADMIN_PASSWORD: ENV_PW });
    assert(!fs.existsSync(firstPwFile(dirA)), 'A1. no first-admin-password.txt');
    assert(IGNORED.test(a.output()), 'A2. one log line says ADMIN_PASSWORD is ignored and points at `beanpool claim`');
    assert((a.output().match(/ADMIN_PASSWORD in \.env is ignored/g) || []).length === 1, 'A3. just one such line');
    assert(!a.output().includes(ENV_PW), 'A4. the password is in no line of the output');
    assert(!(await signsIn(a, ENV_PW)), 'A5. the .env password does not sign in');
    const admin = await request(a, 'POST', '/api/local/admin/data', { password: ENV_PW }, { 'X-Forwarded-For': '203.0.113.99' });
    assert(admin.status === 401 || admin.status === 403, `A6. an admin route with it is refused (${admin.status} ${JSON.stringify(admin.json)})`);
    let cfg = configOf(dirA);
    assert(cfg.isLocked !== true && !cfg.adminHash && !cfg.salt, `A7. local-config.json is not locked and holds no password hash (${cfg.isLocked} ${!!cfg.adminHash})`);
    assert(cfg.replicationTokenOnly === true, 'A8. a standby copies from it with a replication token only, as any new install');
    const code = fs.readFileSync(path.join(dirA, 'claim-code.txt'), 'utf-8').trim();
    const info = (await request(a, 'GET', '/api/local/claim', undefined, { Host: HOST })).json;
    assert(info?.unclaimed === true && typeof info.codeId === 'string', `A9. it waits for its claim (${JSON.stringify(info)})`);
    assert(info?.password === false, `A9b. and says it has no admin password, so Settings shows no password fold (${info?.password})`);
    const founder = newKey();
    const claimed = await request(a, 'POST', '/api/local/claim', claimBody(founder, code, info.salt, info.codeId), { Host: HOST, 'X-Forwarded-For': '203.0.113.1' });
    assert(claimed.status === 200 && claimed.json?.role === 'owner', `A10. the claim code claims it (${claimed.status} ${JSON.stringify(claimed.json)})`);
    await a.stop();
    assert(roleOf(dirA, founder.pub) === 'owner', 'A11. the claiming key is the owner');

    console.log('\nB. The claimed node rebooted with ADMIN_PASSWORD still set');
    a = await boot(dirA, { ADMIN_PASSWORD: ENV_PW });
    assert(!(await signsIn(a, ENV_PW)), 'B1. still no password signs in');
    cfg = configOf(dirA);
    assert(cfg.isLocked !== true && !cfg.adminHash, 'B2. still not locked, no password hash');
    assert(!fs.existsSync(firstPwFile(dirA)) && !fs.existsSync(path.join(dirA, 'claim-code.txt')), 'B3. no password file, no claim code');
    assert((await request(a, 'GET', '/api/local/claim', undefined, { Host: HOST })).json?.unclaimed === false, 'B4. it is claimed');
    await a.stop();

    console.log('\nC. A fresh install with no ADMIN_PASSWORD');
    const dirC = path.join(root, 'c');
    const c = await boot(dirC);
    assert(!fs.existsSync(firstPwFile(dirC)), 'C1. no first-admin-password.txt');
    assert(!/ADMIN_PASSWORD in \.env is ignored/.test(c.output()), 'C2. no "ignored" line');
    assert(fs.existsSync(path.join(dirC, 'claim-code.txt')), 'C3. a claim code waits');
    assert(!configOf(dirC).adminHash, 'C4. no password hash');
    await c.stop();

    console.log('\nD. An existing node with a password, booted with another ADMIN_PASSWORD');
    const dirD = path.join(root, 'd');
    fs.mkdirSync(dirD, { recursive: true });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(OLD_PW, salt, 64).toString('hex');
    fs.writeFileSync(path.join(dirD, 'local-config.json'), JSON.stringify({
        isLocked: true, callsign: null, location: null, adminHash: hash, salt, joinedAt: Date.now() - 86_400_000,
        communityName: null, contactEmail: null, contactPhone: null,
    }, null, 2));
    fs.writeFileSync(firstPwFile(dirD), OLD_PW + '\n', { mode: 0o600 });
    const d = await boot(dirD, { ADMIN_PASSWORD: ENV_PW });
    assert(await signsIn(d, OLD_PW), 'D1. its own password still signs in');
    assert(!(await signsIn(d, ENV_PW)), 'D2. the .env password does not');
    cfg = configOf(dirD);
    assert(cfg.isLocked === true && cfg.adminHash === hash && cfg.salt === salt, 'D3. local-config.json keeps its hash, untouched');
    assert(fs.existsSync(firstPwFile(dirD)) && /still in .*first-admin-password\.txt, and still works/.test(d.output()), 'D4. the first-password file is kept and the log still points at it');
    assert(!/ADMIN_PASSWORD in \.env is ignored/.test(d.output()), 'D5. no "ignored" line: that is for new installs');
    await d.stop();

    console.log('\nE. rotate-node-env.sh rotates an existing node\'s password');
    const projE = path.join(root, 'e');
    const dirE = path.join(projE, 'data');
    existingConfig(dirE, OLD_PW);
    let e = await boot(dirE, { ADMIN_PASSWORD: OLD_PW });
    assert(await signsIn(e, OLD_PW), 'E0. before: its password signs in');
    await e.stop();
    const rotE = rotate(projE, [`ADMIN_PASSWORD=${NEW_PW}`]);
    assert(rotE.code === 0, `E1. the script rotates it (exit ${rotE.code})`);
    e = await boot(dirE, { ADMIN_PASSWORD: NEW_PW });
    assert(await signsIn(e, NEW_PW), 'E2. afterwards the new password signs in');
    assert(!(await signsIn(e, OLD_PW)), 'E3. the old one does not');
    cfg = configOf(dirE);
    assert(cfg.isLocked === true && !!cfg.adminHash && !!cfg.salt, `E4. the config is locked with a hash again (${cfg.isLocked} ${!!cfg.adminHash})`);
    assert(!/ADMIN_PASSWORD in \.env is ignored/.test(e.output()), 'E5. no "ignored" line: it is not read as a new install');
    assert(!e.output().includes(NEW_PW), 'E6. the new password is in no line of the output');
    await e.stop();

    console.log('\nF. The same rotation on a node whose hash came from a take-over (no joinedAt)');
    const projF = path.join(root, 'f');
    const dirF = path.join(projF, 'data');
    existingConfig(dirF, OLD_PW, { joinedAt: null });
    const rotF = rotate(projF, [`ADMIN_PASSWORD=${NEW_PW}`]);
    assert(rotF.code === 0, `F1. the script rotates it (exit ${rotF.code})`);
    const f = await boot(dirF, { ADMIN_PASSWORD: NEW_PW });
    assert(await signsIn(f, NEW_PW), 'F2. afterwards the new password signs in');
    assert(configOf(dirF).isLocked === true, 'F3. and the config is locked');
    await f.stop();

    console.log('\nG. The script on a new install that never had a password');
    const projG = path.join(root, 'g');
    const dirG = path.join(projG, 'data');
    const g0 = await boot(dirG);
    await g0.stop();
    const before = fs.readFileSync(path.join(dirG, 'local-config.json'), 'utf8');
    const rotG = rotate(projG, [`ADMIN_PASSWORD=${NEW_PW}`]);
    assert(rotG.code !== 0, `G1. the script does not say it succeeded (exit ${rotG.code})`);
    assert(/\[not set\] ADMIN_PASSWORD/.test(rotG.out) && /beanpool recover/.test(rotG.out), `G2. it says ADMIN_PASSWORD was not set and points at beanpool recover:\n${rotG.out}`);
    assert(!/\[admin-lock\]/.test(rotG.out), 'G3. it never says it cleared the lock for a rotation');
    assert(fs.readFileSync(path.join(dirG, 'local-config.json'), 'utf8') === before, 'G4. local-config.json is as it was');
    const g = await boot(dirG, { ADMIN_PASSWORD: NEW_PW });
    assert(!(await signsIn(g, NEW_PW)), 'G5. and the node has no password, as the script said');
    await g.stop();

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

if (process.argv.includes(CHILD_FLAG)) {
    runChild().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
