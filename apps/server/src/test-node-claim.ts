/**
 * Claiming a node with its one-time claim code (claim-code.ts, routes/node-claim.ts).
 *
 * Each boot is its own process on its own data dir, booted in the order index.ts boots (genesis, the admin password,
 * TLS, the database, the claim code, the real HTTPS server). Claims go over HTTPS to the real routes through the real
 * middleware, with the Host header each case names.
 *
 *   A. First start: data/claim-code.txt, 0600, holding claim-xxxx-xxxx-xxxx-xxxx; the code is in no line of the output;
 *      GET says unclaimed with the code's id. The admin password from the first-password file still signs in.
 *   B. Refusals, none of which claims: wrong code; a signature for another code id; a signature for another host (the
 *      node knows none of its names); key A's signature sent as key B; a code id that is not the waiting one.
 *   C. The brake: a second check from the same source within 10 s is 429, even with the right code.
 *   D. The right code: 200, the key is a member once and the owner; the file is gone; the code is burned. The same
 *      request again: 200, still one member. Another key with the same code: 409. The password still signs in.
 *   E. A restart after the claim: no file, no new code, GET says claimed.
 *   F. A new code after the file was lost: a statement for the old code id is refused.
 *   G. The claim file cannot be written: the node starts anyway, no code, and the password still works.
 *   H. The node-wide cap: 30 checks a minute across sources, the 31st is 429.
 *   I. The password's first invite, then the claim: the claim follows whether the node has an owner; the password still
 *      signs in; with an owner, the next start has no file and no waiting code.
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
import { claimText, signedRequestBytes } from '@beanpool/core';

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
    const childEnv: Record<string, string | undefined> = { ...process.env, BEANPOOL_DATA_DIR: dataDir, ...env };
    delete childEnv.ADMIN_PASSWORD;
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

/** An HTTPS request to the node with a chosen Host header. */
function request(b: Boot, method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Record<string, any> }> {
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
function sign(k: Key, host: string, codeId: string): string {
    return crypto.sign(null, Buffer.from(signedRequestBytes(claimText(host, codeId))), k.priv).toString('base64');
}

const HOST = 'claim-test.example';
function claimBody(k: Key, code: string, codeId: string, opts: { signedFor?: string; signer?: Key; signedId?: string; callsign?: string } = {}) {
    const signedFor = opts.signedFor ?? HOST;
    return {
        publicKey: k.pub, callsign: opts.callsign ?? 'Founder', code, codeId, signedFor,
        signature: sign(opts.signer ?? k, signedFor, opts.signedId ?? codeId),
    };
}
const claim = (b: Boot, body: unknown, source = '203.0.113.1') =>
    request(b, 'POST', '/api/local/claim', body, { Host: HOST, 'X-Forwarded-For': source });

const readCode = (dir: string) => fs.readFileSync(path.join(dir, FILE_NAME), 'utf-8').trim();
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;
const printed = (output: string, code: string) => [code, code.slice(6, 15), code.slice(15)].some((p) => output.includes(p));
const pendingIn = (dir: string) => { const c = JSON.parse(fs.readFileSync(path.join(dir, 'local-config.json'), 'utf-8')).claim; return !!c && !c.claimedBy; };
const signsIn = async (b: Boot, password: string) => (await request(b, 'POST', '/api/local/admin/data', { password })).status === 200;

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

    console.log('\nA. First start');
    const dirA = path.join(root, 'a');
    let a = await boot(dirA, env);
    const file = path.join(dirA, FILE_NAME);
    assert(fs.existsSync(file), 'A1. the claim code is in claim-code.txt in the data folder');
    const code = fs.existsSync(file) ? readCode(dirA) : '';
    assert(fs.existsSync(file) && modeOf(file) === 0o600, `A2. the file is 0600 (${fs.existsSync(file) ? modeOf(file).toString(8) : 'missing'})`);
    assert(/^claim-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/.test(code), 'A3. it holds one claim-xxxx-xxxx-xxxx-xxxx code');
    assert(!printed(a.output(), code), 'A4. the code is in no line of the output');
    assert(a.output().includes(file), 'A5. the output says where the file is');
    const info = await request(a, 'GET', '/api/local/claim', undefined, { Host: HOST });
    assert(info.status === 200 && info.json.unclaimed === true && /^[0-9a-f]{8}$/.test(info.json.codeId || ''), `A6. GET says unclaimed, with the code id (${info.status} ${JSON.stringify(info.json)})`);
    const codeId: string = info.json.codeId;
    const config = JSON.parse(fs.readFileSync(path.join(dirA, 'local-config.json'), 'utf-8'));
    assert(!JSON.stringify(config).includes(code) && String(config.claim?.hash || '').startsWith('scrypt$'), 'A7. local-config.json holds an scrypt hash, not the code');
    const password = fs.readFileSync(path.join(dirA, 'first-admin-password.txt'), 'utf-8').trim();
    assert(await signsIn(a, password), 'A8. the first admin password still signs in');

    console.log('\nB. Refusals');
    const alice = newKey();
    const bob = newKey();
    const wrong = 'claim-0000-0000-0000-0000' === code ? 'claim-0000-0000-0000-0001' : 'claim-0000-0000-0000-0000';
    let r = await claim(a, claimBody(alice, wrong, codeId), '203.0.113.10');
    assert(r.status === 403 && r.json.code === 'claim_wrong_code', `B1. a wrong code is refused (${r.status} ${r.json.code})`);
    r = await claim(a, claimBody(alice, code, codeId, { signedId: 'deadbeef' }), '203.0.113.11');
    assert(r.status === 403, `B2. a signature for another code id is refused (${r.status} ${r.json.code})`);
    r = await claim(a, claimBody(alice, code, codeId, { signedFor: 'other.example' }), '203.0.113.12');
    assert(r.status === 421, `B3. a signature for another host is refused on a node that knows none of its names (${r.status} ${r.json.code})`);
    r = await claim(a, claimBody(alice, code, codeId, { signedFor: '192.168.1.20' }), '203.0.113.12');
    assert(r.status === 421, `B4. a signature for a home-network host this request was not sent to is refused (${r.status} ${r.json.code})`);
    r = await claim(a, claimBody(bob, code, codeId, { signer: alice }), '203.0.113.13');
    assert(r.status === 403, `B5. key A's signature sent as key B is refused (${r.status})`);
    r = await claim(a, claimBody(alice, code, 'deadbeef'), '203.0.113.14');
    assert(r.status === 409 && r.json.code === 'claim_code_changed', `B6. a code id that is not the waiting one is refused (${r.status} ${r.json.code})`);
    assert(fs.existsSync(file), 'B7. none of these claimed: the file is still there');

    console.log('\nC. The brake');
    r = await claim(a, claimBody(alice, code, codeId), '203.0.113.10');
    assert(r.status === 429 && Number(r.headers['retry-after']) >= 1 && Number(r.headers['retry-after']) <= 10,
        `C1. the same source again within 10 s is 429, even with the right code (${r.status}, Retry-After ${r.headers['retry-after']})`);
    assert(fs.existsSync(file), 'C2. and it did not claim');

    console.log('\nD. The right code');
    r = await claim(a, claimBody(alice, code, codeId), '203.0.113.20');
    assert(r.status === 200 && r.json.ok === true && r.json.role === 'owner' && r.json.memberPubkey === alice.pub, `D1. the right code claims (${r.status} ${JSON.stringify(r.json)})`);
    assert(!fs.existsSync(file), 'D2. the file is deleted');
    assert(/CLAIMED/.test(a.output()) && !printed(a.output(), code), 'D3. a SECURITY line says so, without the code');
    r = await claim(a, claimBody(alice, code, codeId), '203.0.113.21');
    assert(r.status === 200 && r.json.again === true && r.json.role === 'owner', `D4. the same key again: 200, the same outcome (${r.status} ${JSON.stringify(r.json)})`);
    r = await claim(a, claimBody(bob, code, codeId), '203.0.113.22');
    assert(r.status === 409 && r.json.code === 'claim_already_claimed', `D5. another key with the same code: 409 (${r.status} ${r.json.code})`);
    const get2 = await request(a, 'GET', '/api/local/claim', undefined, { Host: HOST });
    assert(get2.json.unclaimed === false, 'D6. GET says claimed');
    assert(await signsIn(a, password), 'D7. the admin password still signs in');
    await a.stop();
    const facts = dbFacts(dirA, alice.pub);
    assert(facts.rows === 1, `D8. the key is a member once (${facts.rows})`);
    assert(facts.role === 'owner' && facts.grantedBy === `claim:${codeId}` && facts.inviteCode === `claim:${codeId}`,
        `D9. and the owner, granted by the claim (${JSON.stringify(facts)})`);
    assert(dbFacts(dirA, bob.pub).rows === 0, 'D10. the other key is no member');
    const burned = JSON.parse(fs.readFileSync(path.join(dirA, 'local-config.json'), 'utf-8')).claim;
    assert(burned?.claimedBy === alice.pub && burned?.claimedAt > 0, 'D11. the code is burned (claimedBy set)');

    console.log('\nE. A restart after the claim');
    a = await boot(dirA, env);
    assert(!fs.existsSync(file), 'E1. no claim file');
    const get3 = await request(a, 'GET', '/api/local/claim', undefined, { Host: HOST });
    assert(get3.json.unclaimed === false, 'E2. GET says claimed');
    r = await claim(a, claimBody(alice, code, codeId), '203.0.113.23');
    assert(r.status === 200 && r.json.again === true, `E3. the retry still answers as the claim did (${r.status})`);
    await a.stop();
    assert(dbFacts(dirA, alice.pub).rows === 1, 'E4. still one member');

    console.log('\nF. A new code after the file was lost');
    const dirF = path.join(root, 'f');
    let f = await boot(dirF, env);
    const idF1 = (await request(f, 'GET', '/api/local/claim', undefined, { Host: HOST })).json.codeId;
    const codeF1 = readCode(dirF);
    await f.stop();
    fs.rmSync(path.join(dirF, FILE_NAME));
    f = await boot(dirF, env);
    const idF2 = (await request(f, 'GET', '/api/local/claim', undefined, { Host: HOST })).json.codeId;
    const codeF2 = readCode(dirF);
    assert(idF2 && idF2 !== idF1 && codeF2 !== codeF1, 'F1. a lost file means a new code with a new id');
    r = await claim(f, claimBody(alice, codeF1, idF1), '203.0.113.30');
    assert(r.status === 409 && r.json.code === 'claim_code_changed', `F2. a statement for the old code id is refused (${r.status} ${r.json.code})`);
    r = await claim(f, claimBody(alice, codeF1, idF2), '203.0.113.31');
    assert(r.status === 403 && r.json.code === 'claim_wrong_code', `F3. the old code under the new id is a wrong code (${r.status} ${r.json.code})`);
    r = await claim(f, claimBody(alice, codeF2, idF2, { signedId: idF1 }), '203.0.113.32');
    assert(r.status === 403, `F4. a signature over the old id with the new code is refused (${r.status})`);
    await f.stop();

    console.log('\nG. The claim file cannot be written');
    const dirG = path.join(root, 'g');
    fs.mkdirSync(path.join(dirG, FILE_NAME, 'in-the-way'), { recursive: true });
    const g = await boot(dirG, env);
    const getG = await request(g, 'GET', '/api/local/claim', undefined, { Host: HOST });
    assert(getG.status === 200 && getG.json.unclaimed === true && getG.json.codeId === null, `G1. the node serves, with no code (${JSON.stringify(getG.json)})`);
    assert(/No claim code this start/.test(g.output()), 'G2. the log says why');
    const pwG = fs.readFileSync(path.join(dirG, 'first-admin-password.txt'), 'utf-8').trim();
    assert(await signsIn(g, pwG), 'G3. the admin password works');
    await g.stop();

    console.log('\nH. The node-wide cap');
    const dirH = path.join(root, 'h');
    const h = await boot(dirH, env);
    const idH = (await request(h, 'GET', '/api/local/claim', undefined, { Host: HOST })).json.codeId;
    const statuses: number[] = [];
    for (let i = 1; i <= 31; i++) {
        statuses.push((await claim(h, claimBody(alice, wrong, idH), `198.51.${100 + i}.1`)).status);
    }
    assert(statuses.slice(0, 30).every((s) => s === 403), `H1. 30 wrong codes from 30 sources are each checked (${[...new Set(statuses.slice(0, 30))]})`);
    assert(statuses[30] === 429, `H2. the 31st in the minute is 429 (${statuses[30]})`);
    r = await claim(h, claimBody(alice, readCode(dirH), idH), '198.51.200.1');
    assert(r.status === 429 && fs.existsSync(path.join(dirH, FILE_NAME)), `H3. even the right code waits for the brake (${r.status})`);
    await h.stop();

    console.log('\nI. The password\'s first invite, then the claim');
    const dirI = path.join(root, 'i');
    let iNode = await boot(dirI, env);
    const idI = (await request(iNode, 'GET', '/api/local/claim', undefined, { Host: HOST })).json.codeId;
    const codeI = readCode(dirI);
    const pwI = fs.readFileSync(path.join(dirI, 'first-admin-password.txt'), 'utf-8').trim();
    const seeded = await request(iNode, 'POST', '/api/admin/seed-invite', { password: pwI });
    assert(seeded.status === 200, `I1. the password makes the first invite, as on main (${seeded.status})`);
    // Measured, not decided here: on a fresh node the seed invite takes its "already have members" branch (the SYSTEM
    // rows count), so no "Admin" owner is made and the node still has no owner. Whichever way that goes, the claim
    // follows nodeHasOwner().
    const afterSeed = (await request(iNode, 'GET', '/api/local/claim', undefined, { Host: HOST })).json.unclaimed;
    console.log(`  (after the password's first invite the node is ${afterSeed ? 'still unclaimed' : 'claimed'})`);
    r = await claim(iNode, claimBody(alice, codeI, idI), '203.0.113.40');
    assert(afterSeed ? r.status === 200 : r.status === 409, `I2. the claim follows whether an owner exists (${r.status})`);
    assert(await signsIn(iNode, pwI), 'I3. the password still signs in');
    await iNode.stop();
    iNode = await boot(dirI, env);
    assert(!fs.existsSync(path.join(dirI, FILE_NAME)), 'I4. with an owner, the next start has no claim file');
    assert(!pendingIn(dirI), 'I5. and no waiting code');
    await iNode.stop();

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

if (process.argv.includes(CHILD_FLAG)) {
    runChild().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
