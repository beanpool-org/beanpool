/**
 * A standby has no claim (claim-code.ts, routes/node-claim.ts, claim-command.ts). The no-mothership suite (#2143, finding
 * 4) found a standby saying "This community has no owner yet… claim code" at every start, and answering a claim with a
 * bare 409 "Conflict" while its log showed a StandbyLedgerError stack. A standby holds no owner of its own: its owners
 * are its main server's, and only a take-over brings them (engine/replication-manifest.ts node_roles). The way in that
 * exists is `beanpool recover --key` on its shell (recover-command.ts); this suite names it, it does not add one.
 *
 * Each boot is its own process on its own data dir, booted in the order index.ts boots (genesis, the admin password,
 * TLS, the database, the claim code, the real HTTPS server). Claims go over HTTPS to the real routes.
 *
 *   S. A new standby (NODE_ROLE=backup): no claim-code.txt and no waiting code; its output says it is a standby and
 *      names `beanpool recover --key`, and never "no owner yet"; GET /api/local/claim answers unclaimed: false,
 *      standby: true, with no code id or salt; a well-formed claim is 409 `claim_standby` with a sentence; no stack.
 *   O. A standby that an older build gave a claim code (a main server's first start on the same data dir, then a standby
 *      start): the start deletes the file and the waiting code, and a claim with that code's RIGHT proof is 409
 *      `claim_standby`, with no StandbyLedgerError in the log and nothing written: no member, no owner.
 *   C. `beanpool claim` on that standby: refused (exit 1), saying it is a standby and naming `beanpool recover --key`,
 *      never "Restart the node to make one".
 *   R. The way in the log names works: with a member in its copy, `beanpool recover --key` makes them the standby's
 *      owner (exit 0, an owner row). From then on it is a server with an owner: its next start says nothing of a claim,
 *      and GET answers as any server with an owner (no standby flag, so no sign-in says it has none).
 *   P. The control: a main server's first start on a fresh dir still makes a code and says "no owner yet".
 *
 * On origin/main S, O and C fail: the standby made a code like any server and said "no owner yet", GET offered it,
 * `beanpool claim` showed it, and the right proof met the standby's write gate as a StandbyLedgerError.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-standby-claim.ts
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

const SCRIPT = fileURLToPath(import.meta.url);
const SRC = path.dirname(SCRIPT);
const CHILD_FLAG = '--child';
const FILE_NAME = 'claim-code.txt';
const HOST = 'standby-claim.example';

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

/** A node on `dataDir`; `standby` boots it with NODE_ROLE=backup, as a standby's .env has it. */
async function boot(dataDir: string, standby: boolean): Promise<Boot> {
    fs.mkdirSync(dataDir, { recursive: true });
    const childEnv: Record<string, string | undefined> = { ...process.env, BEANPOOL_DATA_DIR: dataDir, TRUSTED_PROXIES: '127.0.0.1' };
    // A new install (config/local-config.ts initAdminPassword): no password.
    delete childEnv.ADMIN_PASSWORD;
    delete childEnv.BEANPOOL_SUITE_ENV_PASSWORD;
    delete childEnv.BEANPOOL_ADDRESSES;
    delete childEnv.CF_RECORD_NAME;
    delete childEnv.CF_API_TOKEN;
    delete childEnv.CF_ZONE_ID;
    if (standby) childEnv.NODE_ROLE = 'backup'; else delete childEnv.NODE_ROLE;
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

function request(b: Boot, method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            host: '127.0.0.1', port: b.port, path: route, method, rejectUnauthorized: false,
            headers: { Host: HOST, 'X-Forwarded-For': '203.0.113.7', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}) },
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

interface Key { pub: string; priv: crypto.KeyObject }
function newKey(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

/** A claim as a phone sends it, for `code` with `salt` and `codeId`: the proof and the signature, never the code. */
function claimBody(k: Key, code: string, salt: string, codeId: string) {
    const proof = claimProof(claimKeyFromCode(code, salt), HOST, codeId, k.pub);
    const signature = crypto.sign(null, Buffer.from(signedRequestBytes(claimText(HOST, codeId, k.pub, proof))), k.priv).toString('base64');
    return { publicKey: k.pub, callsign: 'Grabber', codeId, signedFor: HOST, proof, signature };
}

/** `beanpool <args>` on `dir`'s shell, as `docker compose exec` runs it: the container's environment, NODE_ROLE and all. */
function beanpool(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [...process.execArgv, path.join(SRC, 'recover-cli.ts'), ...args], {
            env: { ...process.env, BEANPOOL_DATA_DIR: dir, NODE_ENV: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        const t = setTimeout(() => p.kill('SIGKILL'), 60_000);
        p.on('exit', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out }); });
    });
}

const pendingIn = (dir: string) => { const c = JSON.parse(fs.readFileSync(path.join(dir, 'local-config.json'), 'utf-8')).claim; return !!c && !c.claimedBy; };
const STANDBY_SAYS = 'This server is a standby copy of its community';
const NO_OWNER_YET = 'This community has no owner yet';
/** A thrown error's trace in a node's output: the stack's "    at " lines, or the error's own name. */
const stackIn = (out: string) => /StandbyLedgerError|\n\s+at\s/.test(out);

function dbFacts(dir: string, pub: string): { member: boolean; role: string | null } {
    const db = new Database(path.join(dir, 'state.db'), { readonly: true });
    try {
        const member = !!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(pub);
        const role = db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pub) as any;
        return { member, role: role?.role ?? null };
    } finally {
        db.close();
    }
}

async function main(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || os.tmpdir(), 'standby-claim-'));

    console.log('\nS. A new standby');
    const dirS = path.join(root, 's');
    const s = await boot(dirS, true);
    assert(!fs.existsSync(path.join(dirS, FILE_NAME)), 'S1. it makes no claim-code.txt');
    assert(!pendingIn(dirS), 'S2. and no waiting claim code in local-config.json');
    assert(s.output().includes(STANDBY_SAYS) && s.output().includes('beanpool recover --key'),
        'S3. its output says it is a standby, and names the way in: beanpool recover --key');
    assert(!s.output().includes(NO_OWNER_YET), `S4. and never "${NO_OWNER_YET}"`);
    let info = await request(s, 'GET', '/api/local/claim');
    assert(info.status === 200 && info.json?.unclaimed === false && info.json?.standby === true,
        `S5. GET /api/local/claim: unclaimed false, standby true (${info.status} ${JSON.stringify(info.json)})`);
    assert(info.json?.codeId === undefined && info.json?.salt === undefined, 'S6. with no code id and no salt');
    // A claim as a phone would send one (a code id and salt of its own: a standby offers none).
    const made = claimBody(newKey(), 'claim-0000-1111-2222-3333', crypto.randomBytes(32).toString('hex'), crypto.randomBytes(4).toString('hex'));
    let refused = await request(s, 'POST', '/api/local/claim', made);
    assert(refused.status === 409 && refused.json?.code === 'claim_standby',
        `S7. a claim is 409 claim_standby (${refused.status} ${JSON.stringify(refused.json)})`);
    assert(typeof refused.json?.error === 'string' && refused.json.error.startsWith('This server is a standby copy of its community')
        && refused.json.error.includes('beanpool recover --key'), `S8. with a sentence that says why and names the way in (${refused.json?.error})`);
    await s.stop();
    assert(!stackIn(s.output()), 'S9. and no stack in its log');

    console.log('\nO. A standby that an older build gave a claim code');
    const dirO = path.join(root, 'o');
    let o = await boot(dirO, false);
    const oldFile = path.join(dirO, FILE_NAME);
    const oldCode = fs.existsSync(oldFile) ? fs.readFileSync(oldFile, 'utf-8').trim() : '';
    const oldInfo = await request(o, 'GET', '/api/local/claim');
    assert(/^claim-/.test(oldCode) && oldInfo.json?.unclaimed === true && typeof oldInfo.json?.codeId === 'string',
        'O1. as a main server it made a code (the start an older standby had)');
    await o.stop();
    o = await boot(dirO, true);
    assert(!fs.existsSync(oldFile), 'O2. the standby start deletes claim-code.txt');
    assert(!pendingIn(dirO), 'O3. and the waiting code (K and the salt) with it');
    assert(o.output().includes(STANDBY_SAYS) && !o.output().includes(NO_OWNER_YET), 'O4. and says it is a standby, never "no owner yet"');
    info = await request(o, 'GET', '/api/local/claim');
    assert(info.json?.unclaimed === false && info.json?.standby === true, `O5. GET says standby (${JSON.stringify(info.json)})`);
    // The right proof for the old code: on origin/main this met the standby's write gate (claimNode, assertPlainTablesWritable).
    const grabber = newKey();
    refused = await request(o, 'POST', '/api/local/claim', claimBody(grabber, oldCode, oldInfo.json?.salt ?? '', oldInfo.json?.codeId ?? ''));
    assert(refused.status === 409 && refused.json?.code === 'claim_standby',
        `O6. the old code's right proof is 409 claim_standby (${refused.status} ${JSON.stringify(refused.json)})`);

    console.log('\nC. `beanpool claim` on that standby');
    const cmd = await beanpool(dirO, ['claim', '--no-name'], { NODE_ROLE: 'backup', BEANPOOL_CLAIM_CHECK_ORIGIN: `https://127.0.0.1:${o.port}` });
    assert(cmd.code === 1, `C1. refused, exit 1 (exit ${cmd.code})`);
    assert(cmd.out.includes('This server is a standby copy of its community') && cmd.out.includes('beanpool recover --key'),
        `C2. saying it is a standby, and naming beanpool recover --key (${cmd.out.trim().slice(0, 300)})`);
    assert(!cmd.out.includes('Restart the node to make one') && !cmd.out.includes('claim-'), 'C3. never "Restart the node to make one", and no code');
    await o.stop();
    assert(!stackIn(o.output()), 'O7. no StandbyLedgerError and no stack in its log');
    const facts = dbFacts(dirO, grabber.pub);
    assert(!facts.member && facts.role === null, `O8. and nothing written: no member, no owner (${JSON.stringify(facts)})`);

    console.log('\nR. The way in the log names');
    // A member of the community, as the standby's copy holds them (the row claim-shell-owner.ts writes for a joiner).
    const ann = newKey();
    const db = new Database(path.join(dirO, 'state.db'));
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code)
                VALUES (?, 'Ann', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'copied')`).run(ann.pub);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(ann.pub);
    db.close();
    // By key: a row written on this connection has no callsign_fold (the node's own connection folds names).
    const recovered = await beanpool(dirO, ['recover', '--key', ann.pub], { NODE_ROLE: 'backup' });
    assert(recovered.code === 0 && recovered.out.includes('@Ann is now an owner'), `R1. beanpool recover --key makes Ann the standby's owner (exit ${recovered.code}${recovered.code ? `: ${recovered.out.trim().slice(-200)}` : ''})`);
    assert(dbFacts(dirO, ann.pub).role === 'owner', 'R2. an owner row of the standby\'s own');
    o = await boot(dirO, true);
    info = await request(o, 'GET', '/api/local/claim');
    await o.stop();
    assert(!o.output().includes(STANDBY_SAYS) && !o.output().includes(NO_OWNER_YET), 'R3. its next start says nothing of a claim: it has an owner');
    assert(info.status === 200 && JSON.stringify(info.json) === JSON.stringify({ unclaimed: false, password: false }),
        `R4. and GET answers as a server with an owner: unclaimed false, no standby flag (${info.status} ${JSON.stringify(info.json)})`);

    console.log('\nP. The control: a main server');
    const dirP = path.join(root, 'p');
    const p = await boot(dirP, false);
    const pInfo = await request(p, 'GET', '/api/local/claim');
    await p.stop();
    assert(fs.existsSync(path.join(dirP, FILE_NAME)) && pendingIn(dirP), 'P1. a main server\'s first start makes its claim code');
    assert(p.output().includes(NO_OWNER_YET) && !p.output().includes(STANDBY_SAYS), `P2. and says "${NO_OWNER_YET}"`);
    assert(pInfo.json?.unclaimed === true && pInfo.json?.standby === undefined && typeof pInfo.json?.codeId === 'string',
        `P3. GET offers the claim, with no standby flag (${JSON.stringify({ ...pInfo.json, salt: pInfo.json?.salt ? '…' : undefined })})`);

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A standby has no claim: it says so, names beanpool recover, and answers a claim with a sentence.');
}

if (process.argv.includes(CHILD_FLAG)) {
    runChild().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
}
