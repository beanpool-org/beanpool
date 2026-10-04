/**
 * Claiming a node with its one-time claim code (claim-code.ts, routes/node-claim.ts).
 *
 * Each boot is its own process on its own data dir, booted in the order index.ts boots (genesis, the admin password,
 * TLS, the database, the claim code, the real HTTPS server). Claims go over HTTPS to the real routes through the real
 * middleware, with the Host header each case names.
 *
 * Claim v2: the client never sends the code. It derives K = scrypt(sha256(code), salt) with @beanpool/core's helper from
 * the salt GET answers, and sends HMAC(K, host, code id, key) signed into a beanpool-claim/2 statement.
 *
 *   A. First start: data/claim-code.txt, 0600, holding claim-xxxx-xxxx-xxxx-xxxx; the code is in no line of the output;
 *      GET says unclaimed with the code's id and the salt, and no scrypt parameters. local-config.json holds K, which is
 *      what the core helper derives from the code and the salt. A new install made no admin password: no
 *      first-admin-password.txt, and no password signs in.
 *   B. Refusals, none of which claims: a proof from a wrong code; a signature for another code id; a signature for
 *      another host (the node knows none of its names); key A's signature sent as key B; a code id that is not the
 *      waiting one; a proof made for another host, code id or key; a claim made for host A relayed to the node as host B.
 *   C. The brake: a second wrong proof from the same source within 10 s is 429.
 *   D. The right proof, from that braked source: 200 (a right proof is never braked); the key is a member once and the
 *      owner; the file is gone; K is deleted at the burn; the answer carries no secret. The same request again: 200,
 *      still one member. Another key: 409. Still no password signs in, and GET says so (password: false, not retired).
 *   E. A restart after the claim: no file, no new code, GET says claimed.
 *   F. A new code after the file was lost: a statement for the old code id is refused.
 *   G. The claim file cannot be written, on a node with a password (the suites' ADMIN_PASSWORD seam): the node starts
 *      anyway, no code, and the password still works.
 *   H. A flood of wrong proofs from many sources never delays a right proof: it answers 200 at once. Their SECURITY lines
 *      stop at the node-wide budget, with one "and M more" line a minute; the claim's own line is always written.
 *   I. On a node with a password (the seam), the password's first invite, then the claim: the claim follows whether the node has an owner; the password still
 *      signs in; with an owner, the next start has no file and no waiting code, and GET says claimed with password: true.
 *   J. Two keys with the right proof at once: one owner, the other 409.
 *   K. No request this suite sent carried the code.
 *   L. A stranger sharing the installer's address: 350 requests (GETs and wrong proofs) meet no per-address limiter, only
 *      the claim's own brake, and the installer's right proof from that address then claims at once. With an owner, a
 *      claim is 409 before any signature check; the owner's key with a forged signature is checked once, then braked.
 *      /api/local/claim/x (not the claim) still meets the gateway limiter.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-node-claim.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { claimKeyFromCode, claimProof, claimText, signedRequestBytes } from '@beanpool/core';
import { generateTotpCode } from './totp.js';

const SCRIPT = fileURLToPath(import.meta.url);
const CHILD_FLAG = '--child';
const FILE_NAME = 'claim-code.txt';

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
    // A new install, unless the case asks for a node with a password (config/local-config.ts initAdminPassword).
    delete childEnv.ADMIN_PASSWORD;
    delete childEnv.BEANPOOL_SUITE_ENV_PASSWORD;
    Object.assign(childEnv, env);
    delete childEnv.BEANPOOL_ADDRESSES;
    delete childEnv.CF_RECORD_NAME;
    delete childEnv.CF_API_TOKEN;
    delete childEnv.CF_ZONE_ID;
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

/** Every request body this suite sent, for K. */
const sent: string[] = [];

/** An HTTPS request to the node with a chosen Host header. */
function request(b: Boot, method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Record<string, any> }> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    sent.push(`${method} ${route} ${JSON.stringify(headers)} ${data ?? ''}`);
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
                resolve({ status: res.statusCode || 0, json, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

interface Key { pub: string; priv: crypto.KeyObject }
function newKey(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
    return { pub, priv: privateKey };
}
function sign(k: Key, host: string, codeId: string, pub: string, proof: string): string {
    return crypto.sign(null, Buffer.from(signedRequestBytes(claimText(host, codeId, pub, proof))), k.priv).toString('base64');
}

const HOST = 'claim-test.example';
const keys = new Map<string, Uint8Array>();
/** K as the phone derives it, from the code it read and the salt GET answered. */
function keyOf(code: string, salt: string): Uint8Array {
    const id = `${code} ${salt}`;
    if (!keys.has(id)) keys.set(id, claimKeyFromCode(code, salt));
    return keys.get(id)!;
}
interface ClaimOpts { signedFor?: string; signer?: Key; signedId?: string; callsign?: string; proofHost?: string; proofId?: string; proofKey?: string }
/** A claim as a phone sends it: the proof and the signature, never the code. */
function claimBody(k: Key, code: string, salt: string, codeId: string, opts: ClaimOpts = {}) {
    const signedFor = opts.signedFor ?? HOST;
    const proof = claimProof(keyOf(code, salt), opts.proofHost ?? signedFor, opts.proofId ?? codeId, opts.proofKey ?? k.pub);
    return {
        publicKey: k.pub, callsign: opts.callsign ?? 'Founder', codeId, signedFor, proof,
        signature: sign(opts.signer ?? k, signedFor, opts.signedId ?? codeId, k.pub, proof),
    };
}
const claim = (b: Boot, body: unknown, source = '203.0.113.1', host = HOST) =>
    request(b, 'POST', '/api/local/claim', body, { Host: host, 'X-Forwarded-For': source });
const claimInfo = async (b: Boot) => (await request(b, 'GET', '/api/local/claim', undefined, { Host: HOST })).json;

const readCode = (dir: string) => fs.readFileSync(path.join(dir, FILE_NAME), 'utf-8').trim();
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;
const printed = (output: string, code: string) => [code, code.slice(6, 15), code.slice(15)].some((p) => output.includes(p));
const pendingIn = (dir: string) => { const c = JSON.parse(fs.readFileSync(path.join(dir, 'local-config.json'), 'utf-8')).claim; return !!c && !c.claimedBy; };
/** The password sign-in to Settings (POST /api/local/admin/auth/password), with a code once the node's 2FA is on. */
const signsIn = async (b: Boot, password: string, totpCode?: string) =>
    (await request(b, 'POST', '/api/local/admin/auth/password', { password }, totpCode ? { 'X-Admin-TOTP': totpCode } : {})).status === 200;
/** Step 7c: with the node's 2FA off, the password alone opens no admin route. */
const aloneRefused = async (b: Boot, password: string, route = '/api/local/admin/data') => {
    const r = await request(b, 'POST', route, { password });
    return r.status === 403 && r.json?.code === 'password_needs_2fa';
};

/**
 * Turn the node's 2FA on from Settings: sign in with the password, set up an authenticator, confirm a code. Returns its backup
 * codes. The code goes as totpCode (the route takes either name): K1 counts any "code" field as a claim code.
 */
async function turnOn2fa(b: Boot, password: string): Promise<string[]> {
    const signIn = await request(b, 'POST', '/api/local/admin/auth/password', { password });
    const cookie = ([] as string[]).concat(signIn.headers['set-cookie'] ?? []).find((h) => h.startsWith('admin_session='))?.split(';')[0] ?? '';
    const asSession = { Cookie: cookie, 'X-CSRF-Token': String(signIn.json?.csrfToken ?? '') };
    const setup = await request(b, 'POST', '/api/local/admin/2fa/setup', {}, asSession);
    if (signIn.status !== 200 || setup.status !== 200 || !setup.json?.secret) {
        throw new Error(`could not set up 2FA (sign-in ${signIn.status}, setup ${setup.status} ${JSON.stringify(setup.json)})`);
    }
    const verify = await request(b, 'POST', '/api/local/admin/2fa/verify', { totpCode: generateTotpCode(String(setup.json.secret)) }, asSession);
    if (verify.status !== 200) throw new Error(`could not turn 2FA on (verify ${verify.status} ${JSON.stringify(verify.json)})`);
    return setup.json.backupCodes as string[];
}

function dbFacts(dir: string, pub: string): { rows: number; role: string | null; grantedBy: string | null; inviteCode: string | null } {
    const db = new Database(path.join(dir, 'state.db'), { readonly: true });
    try {
        const rows = (db.prepare('SELECT COUNT(*) AS c FROM members WHERE lower(public_key) = ?').get(pub) as any).c;
        const role = db.prepare('SELECT role, granted_by FROM node_roles WHERE member_pubkey = ?').get(pub) as any;
        const m = db.prepare('SELECT invite_code FROM members WHERE public_key = ?').get(pub) as any;
        return { rows, role: role?.role ?? null, grantedBy: role?.granted_by ?? null, inviteCode: m?.invite_code ?? null };
    } finally {
        db.close();
    }
}

async function main(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || os.tmpdir(), 'claim-'));
    const env = { TRUSTED_PROXIES: '127.0.0.1' };
    const codes: string[] = [];

    console.log('\nA. First start');
    const dirA = path.join(root, 'a');
    let a = await boot(dirA, env);
    const file = path.join(dirA, FILE_NAME);
    assert(fs.existsSync(file), 'A1. the claim code is in claim-code.txt in the data folder');
    const code = fs.existsSync(file) ? readCode(dirA) : '';
    codes.push(code);
    assert(fs.existsSync(file) && modeOf(file) === 0o600, `A2. the file is 0600 (${fs.existsSync(file) ? modeOf(file).toString(8) : 'missing'})`);
    assert(/^claim-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/.test(code), 'A3. it holds one claim-xxxx-xxxx-xxxx-xxxx code');
    assert(!printed(a.output(), code), 'A4. the code is in no line of the output');
    assert(a.output().includes(file), 'A5. the output says where the file is');
    const info = await request(a, 'GET', '/api/local/claim', undefined, { Host: HOST });
    assert(info.status === 200 && info.json.unclaimed === true && /^[0-9a-f]{8}$/.test(info.json.codeId || ''), `A6. GET says unclaimed, with the code id (${info.status} ${JSON.stringify(info.json)})`);
    // No scrypt parameters: the phone uses CLAIM_SCRYPT hard-coded, and a phishing server writes this answer itself.
    assert(/^[0-9a-f]{64}$/.test(info.json.salt || '') && !('scrypt' in info.json),
        `A7. and the salt, which is public, and no scrypt parameters (${JSON.stringify(Object.keys(info.json))})`);
    const codeId: string = info.json.codeId;
    const salt: string = info.json.salt;
    const config = JSON.parse(fs.readFileSync(path.join(dirA, 'local-config.json'), 'utf-8'));
    assert(!JSON.stringify(config).includes(code) && config.claim?.salt === salt, 'A8. local-config.json holds the salt, not the code');
    assert(config.claim?.key === Buffer.from(keyOf(code, salt)).toString('hex'), 'A9. its K is what the core helper derives from the code and the salt');
    assert(!printed(a.output(), config.claim?.key || 'none'), 'A10. K is in no line of the output');
    assert(!fs.existsSync(path.join(dirA, 'first-admin-password.txt')), 'A11. a new install made no admin password: no first-admin-password.txt');
    const password = 'Claim-Suite-Guess-61!';
    assert(!(await signsIn(a, password)), 'A12. no password signs in');

    console.log('\nB. Refusals');
    const alice = newKey();
    const bob = newKey();
    const wrong = 'claim-0000-0000-0000-0000' === code ? 'claim-0000-0000-0000-0001' : 'claim-0000-0000-0000-0000';
    let r = await claim(a, claimBody(alice, wrong, salt, codeId), '203.0.113.10');
    assert(r.status === 403 && r.json.code === 'claim_wrong_code', `B1. a proof from a wrong code is refused (${r.status} ${r.json.code})`);
    assert(/wrong claim proof/i.test(a.output()), 'B1b. with a SECURITY line');
    r = await claim(a, claimBody(alice, code, salt, codeId, { signedId: 'deadbeef' }), '203.0.113.11');
    assert(r.status === 403, `B2. a signature for another code id is refused (${r.status} ${r.json.code})`);
    r = await claim(a, claimBody(alice, code, salt, codeId, { signedFor: 'other.example' }), '203.0.113.12');
    assert(r.status === 421, `B3. a claim for another host is refused on a node that knows none of its names (${r.status} ${r.json.code})`);
    r = await claim(a, claimBody(alice, code, salt, codeId, { signedFor: '192.168.1.20' }), '203.0.113.12');
    assert(r.status === 421, `B4. a claim for a home-network host this request was not sent to is refused (${r.status} ${r.json.code})`);
    r = await claim(a, claimBody(bob, code, salt, codeId, { signer: alice }), '203.0.113.13');
    assert(r.status === 403, `B5. key A's signature sent as key B is refused (${r.status})`);
    r = await claim(a, claimBody(alice, code, salt, 'deadbeef'), '203.0.113.14');
    assert(r.status === 409 && r.json.code === 'claim_code_changed', `B6. a code id that is not the waiting one is refused (${r.status} ${r.json.code})`);
    r = await claim(a, claimBody(alice, code, salt, codeId, { proofHost: 'other.example' }), '203.0.113.15');
    assert(r.status === 403 && r.json.code === 'claim_wrong_code', `B7. a proof made for another host is refused (${r.status} ${r.json.code})`);
    r = await claim(a, claimBody(alice, code, salt, codeId, { proofId: 'deadbeef' }), '203.0.113.16');
    assert(r.status === 403 && r.json.code === 'claim_wrong_code', `B8. a proof made for another code id is refused (${r.status} ${r.json.code})`);
    r = await claim(a, claimBody(alice, code, salt, codeId, { proofKey: bob.pub }), '203.0.113.17');
    assert(r.status === 403 && r.json.code === 'claim_wrong_code', `B9. a proof made for another key is refused (${r.status} ${r.json.code})`);
    // A relay: a phishing server at phish.example got the phone's claim for phish.example and replays it to the node.
    const forPhish = claimBody(alice, code, salt, codeId, { signedFor: 'phish.example' });
    r = await claim(a, forPhish, '203.0.113.18', HOST);
    assert(r.status === 421, `B10. a claim made for host A relayed to the node as host B is refused (${r.status} ${r.json.code})`);
    r = await claim(a, { ...forPhish, signedFor: HOST }, '203.0.113.19', HOST);
    assert(r.status === 403, `B11. the relay re-labelled for host B is refused: the signature is over host A (${r.status} ${r.json.code})`);
    r = await claim(a, { ...forPhish, signedFor: HOST }, '203.0.113.19', HOST);
    assert(r.status === 429, `B11b. a wrong proof brakes its source even when its signature fails: the next is 429 with no signature check (${r.status} ${r.json.code})`);
    const mallory = newKey();
    r = await claim(a, { ...forPhish, publicKey: mallory.pub, signedFor: HOST, signature: sign(mallory, HOST, codeId, mallory.pub, forPhish.proof) }, '203.0.113.20');
    assert(r.status === 403 && r.json.code === 'claim_wrong_code', `B12. the relayed proof under the relay's own key is refused (${r.status} ${r.json.code})`);
    assert(fs.existsSync(file), 'B13. none of these claimed: the file is still there');

    console.log('\nC. The brake');
    r = await claim(a, claimBody(alice, wrong, salt, codeId), '203.0.113.10');
    assert(r.status === 429 && Number(r.headers['retry-after']) >= 1 && Number(r.headers['retry-after']) <= 10,
        `C1. a second wrong proof from the same source within 10 s is 429 (${r.status}, Retry-After ${r.headers['retry-after']})`);
    assert(fs.existsSync(file), 'C2. and it did not claim');

    console.log('\nD. The right proof');
    r = await claim(a, claimBody(alice, code, salt, codeId), '203.0.113.10');
    assert(r.status === 200 && r.json.ok === true && r.json.role === 'owner' && r.json.memberPubkey === alice.pub,
        `D1. the right proof claims, from the source the brake holds (${r.status} ${JSON.stringify(r.json)})`);
    assert(JSON.stringify(Object.keys(r.json || {}).sort()) === JSON.stringify(['again', 'callsign', 'memberPubkey', 'ok', 'role']),
        `D2. the answer carries no secret (${Object.keys(r.json || {})})`);
    assert(!fs.existsSync(file), 'D3. the file is deleted');
    assert(/CLAIMED/.test(a.output()) && !printed(a.output(), code), 'D4. a SECURITY line says so, without the code');
    r = await claim(a, claimBody(alice, code, salt, codeId), '203.0.113.21');
    assert(r.status === 200 && r.json.again === true && r.json.role === 'owner', `D5. the same key again: 200, the same outcome (${r.status} ${JSON.stringify(r.json)})`);
    r = await claim(a, claimBody(bob, code, salt, codeId), '203.0.113.22');
    assert(r.status === 409 && r.json.code === 'claim_already_claimed', `D6. another key with the right proof: 409 (${r.status} ${r.json.code})`);
    const get2 = await claimInfo(a);
    assert(get2.unclaimed === false && get2.salt === undefined, `D7. GET says claimed, with no salt (${JSON.stringify(get2)})`);
    assert(get2.password === false && get2.passwordRetired === undefined,
        `D7b. and that this server has no admin password, not retired: Settings shows the phone sign-in, no password form (${JSON.stringify(get2)})`);
    assert(!(await signsIn(a, password)), 'D8. still no password signs in');
    await a.stop();
    const facts = dbFacts(dirA, alice.pub);
    assert(facts.rows === 1, `D9. the key is a member once (${facts.rows})`);
    assert(facts.role === 'owner' && facts.grantedBy === `claim:${codeId}` && facts.inviteCode === `claim:${codeId}`,
        `D10. and the owner, granted by the claim (${JSON.stringify(facts)})`);
    assert(dbFacts(dirA, bob.pub).rows === 0, 'D11. the other key is no member');
    const burned = JSON.parse(fs.readFileSync(path.join(dirA, 'local-config.json'), 'utf-8')).claim;
    assert(burned?.claimedBy === alice.pub && burned?.claimedAt > 0, 'D12. the code is burned (claimedBy set)');
    assert(burned && burned.key === undefined && burned.salt === undefined, `D13. K is deleted at the burn (${Object.keys(burned || {})})`);

    console.log('\nE. A restart after the claim');
    a = await boot(dirA, env);
    assert(!fs.existsSync(file), 'E1. no claim file');
    assert((await claimInfo(a)).unclaimed === false, 'E2. GET says claimed');
    r = await claim(a, claimBody(alice, code, salt, codeId), '203.0.113.23');
    assert(r.status === 200 && r.json.again === true, `E3. the retry still answers as the claim did (${r.status})`);
    await a.stop();
    assert(dbFacts(dirA, alice.pub).rows === 1, 'E4. still one member');

    console.log('\nF. A new code after the file was lost');
    const dirF = path.join(root, 'f');
    let f = await boot(dirF, env);
    const infoF1 = await claimInfo(f);
    const codeF1 = readCode(dirF);
    await f.stop();
    fs.rmSync(path.join(dirF, FILE_NAME));
    f = await boot(dirF, env);
    const infoF2 = await claimInfo(f);
    const codeF2 = readCode(dirF);
    codes.push(codeF1, codeF2);
    assert(infoF2.codeId && infoF2.codeId !== infoF1.codeId && codeF2 !== codeF1 && infoF2.salt !== infoF1.salt, 'F1. a lost file means a new code with a new id and a new salt');
    r = await claim(f, claimBody(alice, codeF1, infoF1.salt, infoF1.codeId), '203.0.113.30');
    assert(r.status === 409 && r.json.code === 'claim_code_changed', `F2. a statement for the old code id is refused (${r.status} ${r.json.code})`);
    r = await claim(f, claimBody(alice, codeF1, infoF2.salt, infoF2.codeId), '203.0.113.31');
    assert(r.status === 403 && r.json.code === 'claim_wrong_code', `F3. the old code under the new id is a wrong proof (${r.status} ${r.json.code})`);
    r = await claim(f, claimBody(alice, codeF2, infoF2.salt, infoF2.codeId, { signedId: infoF1.codeId }), '203.0.113.32');
    assert(r.status === 403, `F4. a signature over the old id with the new proof is refused (${r.status})`);
    await f.stop();

    console.log('\nG. The claim file cannot be written');
    const dirG = path.join(root, 'g');
    fs.mkdirSync(path.join(dirG, FILE_NAME, 'in-the-way'), { recursive: true });
    const pwG = 'Claim-Suite-Node-G-61!';
    const g = await boot(dirG, { ...env, ADMIN_PASSWORD: pwG, BEANPOOL_SUITE_ENV_PASSWORD: '1' });
    const getG = await request(g, 'GET', '/api/local/claim', undefined, { Host: HOST });
    assert(getG.status === 200 && getG.json.unclaimed === true && getG.json.codeId === null, `G1. the node serves, with no code (${JSON.stringify(getG.json)})`);
    assert(/No claim code this start/.test(g.output()), 'G2. the log says why');
    assert(getG.json.password === true, `G2b. GET says this server has an admin password, so Settings keeps its fold (${getG.json.password})`);
    assert(await signsIn(g, pwG), 'G3. the admin password works');
    await g.stop();

    console.log('\nH. A flood of wrong proofs never delays a right one');
    const dirH = path.join(root, 'h');
    // The wrong-proof SECURITY line's node-wide budget (claim-code.ts claimLogAdmit), its minute scaled to 2 s.
    const h = await boot(dirH, { ...env, NODE_ENV: 'test', CLAIM_LOG_WINDOW_MS: '2000' });
    const infoH = await claimInfo(h);
    const codeH = readCode(dirH);
    codes.push(codeH);
    const SOURCES = 60, EACH = 3, LOG_BUDGET = 20;
    const flood: Promise<{ status: number }>[] = [];
    for (let i = 0; i < SOURCES; i++) {
        for (let j = 0; j < EACH; j++) flood.push(claim(h, claimBody(newKey(), wrong, infoH.salt, infoH.codeId), `198.51.${100 + i}.1`));
    }
    const statuses = (await Promise.all(flood)).map((x) => x.status);
    const count = (s: number) => statuses.filter((x) => x === s).length;
    assert(count(403) === SOURCES && count(429) === SOURCES * (EACH - 1),
        `H1. ${SOURCES * EACH} wrong proofs from ${SOURCES} sources: each source's first is 403, the rest 429 (403×${count(403)}, 429×${count(429)})`);
    const t0 = Date.now();
    r = await claim(h, claimBody(alice, codeH, infoH.salt, infoH.codeId), '198.51.100.1');
    const ms = Date.now() - t0;
    assert(r.status === 200 && r.json.role === 'owner', `H2. then the right proof, from a source the brake holds, claims at once (${r.status}, ${ms} ms)`);
    assert(ms < 2000, `H3. without waiting for any brake (${ms} ms)`);
    const wrongLines = (out: string) => out.split('\n').filter((x) => /A wrong claim proof was refused/.test(x)).length;
    assert(wrongLines(h.output()) === LOG_BUDGET,
        `H4. ${SOURCES} wrong proofs from ${SOURCES} sources wrote the budget's ${LOG_BUDGET} SECURITY lines, no more (${wrongLines(h.output())})`);
    assert(/CLAIMED/.test(h.output()), 'H5. the right claim is logged whatever the budget');
    await new Promise((res) => setTimeout(res, 2500));
    const more = h.output().split('\n').filter((x) => /more wrong claim proofs/.test(x));
    assert(more.length === 1 && more[0].includes(String(SOURCES - LOG_BUDGET)),
        `H6. and one summary line for the rest, once the minute is over (${more.length}: ${more[0] ?? ''})`);
    await h.stop();

    console.log('\nL. A stranger sharing the installer\'s address cannot hold the claim shut');
    const dirL = path.join(root, 'l');
    const l = await boot(dirL, env);
    const infoL = await claimInfo(l);
    const codeL = readCode(dirL);
    codes.push(codeL);
    // The same Wi-Fi, a carrier NAT, or a proxy that is not trusted: the stranger and the installer are one address.
    // More than the gateway limiter's 120 a minute and the administrative limiter's 300, in batches.
    const SHARED = '203.0.113.77';
    const shared: number[] = [];
    const tFlood = Date.now();
    for (let batch = 0; batch < 7; batch++) {
        const reqs: Promise<{ status: number; json: any }>[] = [];
        for (let j = 0; j < 25; j++) {
            reqs.push(request(l, 'GET', '/api/local/claim', undefined, { Host: HOST, 'X-Forwarded-For': SHARED }));
            reqs.push(claim(l, claimBody(newKey(), wrong, infoL.salt, infoL.codeId), SHARED));
        }
        for (const x of await Promise.all(reqs)) shared.push(x.status);
    }
    const floodMs = Date.now() - tFlood;
    const sharedCount = (s: number) => shared.filter((x) => x === s).length;
    assert(shared.length === 350 && sharedCount(200) === 175 && sharedCount(403) + sharedCount(429) === 175,
        `L1. ${shared.length} requests from the installer's address: every GET answered, every wrong proof met only the claim's own brake (200×${sharedCount(200)}, 403×${sharedCount(403)}, 429×${sharedCount(429)}; ${floodMs} ms, ${(floodMs / shared.length).toFixed(2)} ms each)`);
    const tL = Date.now();
    const installer = newKey();
    const rightL = claimBody(installer, codeL, infoL.salt, infoL.codeId);
    r = await claim(l, rightL, SHARED);
    assert(r.status === 200 && r.json.role === 'owner', `L2. then the installer's right proof from that address claims at once (${r.status} ${JSON.stringify(r.json?.error ?? '')}, ${Date.now() - tL} ms)`);
    // With an owner, a stranger's claim is 409 before any signature check; the owner's key with the burned code id and a
    // forged signature is checked once, then braked.
    const after = await Promise.all(Array.from({ length: 50 }, () => claim(l, claimBody(newKey(), wrong, infoL.salt, infoL.codeId), SHARED)));
    assert(after.every((x) => x.status === 409), `L4. with an owner, 50 more claims from that address: all 409 (${[...new Set(after.map((x) => x.status))]})`);
    const forged = { ...rightL, signature: sign(newKey(), HOST, infoL.codeId, installer.pub, rightL.proof) };
    const f1 = await claim(l, forged, '203.0.113.79');
    const f2 = await claim(l, forged, '203.0.113.79');
    const again = await claim(l, rightL, '203.0.113.80');
    assert(f1.status === 409 && f2.status === 429 && again.status === 200 && again.json.again === true,
        `L5. the owner's key with a forged signature: 409, then braked 429; the owner's own retry elsewhere: 200 again (${f1.status}, ${f2.status}, ${again.status})`);
    // Exactly the claim route: a neighbour under the same prefix keeps the gateway limiter.
    const neighbour: { status: number; json: any }[] = [];
    for (let batch = 0; batch < 6; batch++) {
        const reqs: Promise<{ status: number; json: any }>[] = [];
        for (let j = 0; j < 25; j++) reqs.push(request(l, 'GET', '/api/local/claim/x', undefined, { Host: HOST, 'X-Forwarded-For': '203.0.113.78' }));
        neighbour.push(...await Promise.all(reqs));
    }
    const gated = neighbour.filter((x) => x.status === 429 && /Gateway rate limit/i.test(String(x.json?.error ?? ''))).length;
    assert(gated > 0, `L3. ${neighbour.length} requests to /api/local/claim/x from one address: the gateway limiter still answers 429 (${gated})`);
    await l.stop();

    console.log('\nI. The password\'s first invite, then the claim');
    const dirI = path.join(root, 'i');
    const pwI = 'Claim-Suite-Node-I-61!';
    const envI = { ...env, ADMIN_PASSWORD: pwI, BEANPOOL_SUITE_ENV_PASSWORD: '1' };
    let iNode = await boot(dirI, envI);
    const infoI = await claimInfo(iNode);
    const codeI = readCode(dirI);
    codes.push(codeI);
    assert(await aloneRefused(iNode, pwI, '/api/admin/seed-invite'), 'I0. (step 7c) with 2FA off, the password alone makes no invite: 403 password_needs_2fa');
    const backupI = await turnOn2fa(iNode, pwI);
    const seeded = await request(iNode, 'POST', '/api/admin/seed-invite', { password: pwI }, { 'X-Admin-TOTP': backupI[0] });
    assert(seeded.status === 200, `I1. the password, with a code (2FA on), makes the first invite (${seeded.status})`);
    // Measured, not decided here: on a fresh node the seed invite takes its "already have members" branch (the SYSTEM
    // rows count), so no owner is made and the node still has no owner. Whichever way that goes, the claim follows
    // nodeHasOwner().
    const afterSeed = (await claimInfo(iNode)).unclaimed;
    console.log(`  (after the password's first invite the node is ${afterSeed ? 'still unclaimed' : 'claimed'})`);
    r = await claim(iNode, claimBody(alice, codeI, infoI.salt, infoI.codeId), '203.0.113.40');
    assert(afterSeed ? r.status === 200 : r.status === 409, `I2. the claim follows whether an owner exists (${r.status})`);
    assert(await signsIn(iNode, pwI, backupI[1]), 'I3. the password still signs in (with a code: 2FA is on)');
    await iNode.stop();
    iNode = await boot(dirI, envI);
    assert(!fs.existsSync(path.join(dirI, FILE_NAME)), 'I4. with an owner, the next start has no claim file');
    assert(!pendingIn(dirI), 'I5. and no waiting code');
    const claimedI = await claimInfo(iNode);
    assert(claimedI.unclaimed === false && claimedI.password === true, `I6. GET says claimed, and that this server has an admin password (${JSON.stringify(claimedI)})`);
    await iNode.stop();

    console.log('\nJ. Two keys at once');
    const dirJ = path.join(root, 'j');
    const jNode = await boot(dirJ, env);
    const infoJ = await claimInfo(jNode);
    const codeJ = readCode(dirJ);
    codes.push(codeJ);
    const carol = newKey();
    const dave = newKey();
    const both = await Promise.all([
        claim(jNode, claimBody(carol, codeJ, infoJ.salt, infoJ.codeId, { callsign: 'Carol' }), '203.0.113.50'),
        claim(jNode, claimBody(dave, codeJ, infoJ.salt, infoJ.codeId, { callsign: 'Dave' }), '203.0.113.51'),
    ]);
    const st = both.map((x) => x.status).sort();
    assert(JSON.stringify(st) === '[200,409]', `J1. one claims, the other is 409 (${st})`);
    await jNode.stop();
    const owners = [dbFacts(dirJ, carol.pub), dbFacts(dirJ, dave.pub)].filter((x) => x.role === 'owner').length;
    assert(owners === 1, `J2. one owner (${owners})`);

    console.log('\nK. The code never left the client');
    const leaked = sent.filter((line) => codes.some((c) => c && printed(line, c)) || /"code":/.test(line));
    assert(codes.length >= 6 && leaked.length === 0, `K1. none of the ${sent.length} requests carried a claim code (${leaked.length})`);

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

if (process.argv.includes(CHILD_FLAG)) {
    runChild().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
