/**
 * `beanpool claim` (node sign-in step 8, stage B2): the name first, then the claim code and its QR.
 *
 * Real nodes, each a child process in its own process group with its own data dir and port 0; the command runs as its
 * own process beside them, as `docker compose exec` runs it. The registrar is a fake HTTP server this suite starts
 * (REGISTRAR_URL), never the live one. The check that https://<name>.beanpool.org reaches the node is the one fetch
 * pointed at the node itself (BEANPOOL_CLAIM_CHECK_ORIGIN, NODE_ENV=test only): no DNS here.
 *   1. A taken name: the registrar's reason, exit 1, nothing changed (no address, the code still waits).
 *   2. A live name: the node claimed it with its own key within ~10 s; the QR carries the https name.
 *   3. --name on a node that holds an address is refused.
 *   4. The code is never in the node's log.
 *   5. --key --callsign: owner granted with a break-glass code; the burn as the HTTP claim's (file gone, K and salt gone,
 *      SECURITY line, community notice); a second claim, from the shell or the route, refused.
 *   6. A pending name: the message, and the QR falls back to --direct.
 *   7. The registrar down: --no-name and --direct still give the code; --name falls back after its wait.
 *   8. The request never reaches a backup or a standby's staging copy.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-claim-cli.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const SCRIPT = fileURLToPath(import.meta.url);
const SRC = path.dirname(SCRIPT);

let run = 0, passed = 0;
function check(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`  ✓ ${msg}`); } else console.log(`  ✗ ${msg}`);
}

async function child(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_ZONE_ID;
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initClaimCode, burnClaimFromShell } = await import('./claim-code.js');
    const { initPublicAddress } = await import('./services/public-address-agent.js');
    const { startRecoverNoticeWatch } = await import('./recover-command.js');
    const { logger } = await import('./logger.js');
    const { startP2P } = await import('./p2p.js');
    await initTls();
    se.initStateEngine();
    startRecoverNoticeWatch({ announce: () => {}, log: m => logger.security('AUTH', m), burnClaim: burnClaimFromShell });
    initClaimCode();
    const port = await startHttpsServer(0);
    await startP2P(0, 0);   // the node's identity, which signs its registrar requests
    initPublicAddress();
    process.stdout.write('@@ ' + JSON.stringify({ ready: true, port }) + '\n');
}

interface Node { dir: string; port: number; proc: ChildProcess; output: () => string }
const started: Node[] = [];

function startNode(name: string, env: Record<string, string>): Promise<Node> {
    const dir = path.join(process.env.BEANPOOL_DATA_DIR!, name);
    fs.mkdirSync(dir, { recursive: true });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, BEANPOOL_DATA_DIR: dir, NODE_ENV: 'test', ...env };
    for (const k of ['PUBLIC_ADDRESS_NAME', 'PUBLIC_ADDRESS_AUTO', 'CF_RECORD_NAME', 'BEANPOOL_ADDRESSES', 'NODE_ROLE', 'ADMIN_PASSWORD']) delete childEnv[k];
    Object.assign(childEnv, env);
    const proc = spawn(process.execPath, [...process.execArgv, SCRIPT, '--child'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const rl = readline.createInterface({ input: proc.stdout! });
    return new Promise((resolve, reject) => {
        rl.on('line', (line) => {
            out += line + '\n';
            if (line.startsWith('@@ ')) {
                const node = { dir, port: JSON.parse(line.slice(3)).port, proc, output: () => out };
                started.push(node);
                resolve(node);
            }
        });
        proc.stderr!.on('data', d => { out += d.toString(); });
        proc.on('exit', code => reject(new Error(`${name} exited (${code})\n${out.slice(-3000)}`)));
    });
}

function cli(node: Node, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string; ms: number }> {
    const t0 = Date.now();
    return new Promise((resolve) => {
        const p = spawn(process.execPath, ['--import', 'tsx', path.join(SRC, 'recover-cli.ts'), 'claim', ...args], {
            env: { ...process.env, BEANPOOL_DATA_DIR: node.dir, NODE_ENV: 'test', NODE_TLS_REJECT_UNAUTHORIZED: '0', BEANPOOL_CLAIM_CHECK_ORIGIN: `https://127.0.0.1:${node.port}`, BEANPOOL_CLAIM_NAME_WAIT_MS: '30000', ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '', err = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { err += d; });
        p.on('exit', code => resolve({ code: code ?? -1, out, err, ms: Date.now() - t0 }));
    });
}

// ── The fake registrar ──────────────────────────────────────────────────────────────────────
interface Reg { status: string; name: string | null; claimedAt: number | null; claims: number }
const reg: Reg = { status: 'none', name: null, claimedAt: null, claims: 0 };
const registrar = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
        if (!req.headers['x-bp-pubkey'] || !req.headers['x-bp-signature']) return send(401, { error: 'unsigned' });
        if (req.url === '/api/registrar/status') return send(200, { status: reg.status, name: reg.name, hostname: reg.name ? `${reg.name}.beanpool.org` : null });
        if (req.url === '/api/registrar/claim' && req.method === 'POST') {
            const b = JSON.parse(body || '{}');
            reg.claims++;
            if (b.name === 'taken-name') return send(409, { error: 'name taken' });
            reg.name = b.name;
            reg.claimedAt = Date.now();
            reg.status = b.name.startsWith('gated') ? 'pending' : 'live';
            return send(200, { status: reg.status, name: reg.name, hostname: `${reg.name}.beanpool.org` });
        }
        send(404, { error: 'no' });
    });
});

const readConfig = (n: Node) => JSON.parse(fs.readFileSync(path.join(n.dir, 'local-config.json'), 'utf8'));
const codeOf = (n: Node) => fs.readFileSync(path.join(n.dir, 'claim-code.txt'), 'utf8').trim();
const qrOf = async (link: string) => QRCode.toString(link, { type: 'terminal', small: true });
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    await new Promise<void>(r => registrar.listen(0, '127.0.0.1', () => r()));
    const regUrl = `http://127.0.0.1:${(registrar.address() as any).port}`;
    try {
        console.log('\n1–5. A node with the registrar up');
        const a = await startNode('a', { REGISTRAR_URL: regUrl });
        const code = codeOf(a);
        const id = readConfig(a).claim.id;

        const taken = await cli(a, ['--name', 'taken-name']);
        check(taken.code === 1 && /name taken/.test(taken.err), `a taken name: exit 1 with the registrar's reason (${taken.code}: ${taken.err.trim().split('\n').pop()})`);
        if (taken.code !== 1) console.log(a.output().split('\n').filter(l => /PublicAddr|registrar|Error/i.test(l)).slice(-15).join('\n'), taken.out.slice(0, 400));
        check(reg.status === 'none' && fs.existsSync(path.join(a.dir, 'claim-code.txt')) && !taken.out.includes(code), 'nothing changed: no address, the code still waits, and none was printed');

        const t0 = Date.now();
        const live = await cli(a, ['--name', 'cairns']);
        const claimedIn = (reg.claimedAt ?? Infinity) - t0;
        check(live.code === 0, `a live name: exit 0 (${live.code} ${live.err.trim()})`);
        check(claimedIn < 10_000, `the node claimed cairns with its own key within ~10 s (${claimedIn} ms after the command started)`);
        check(live.out.includes(await qrOf(`beanpool://claim?node=${encodeURIComponent('https://cairns.beanpool.org')}&id=${id}&code=${code}`)), 'the QR carries the https name, the code id and the code');
        check(live.out.includes(`The one-time claim code: ${code}`) && /Claim a community, or scan this\. The code works once\./.test(live.out), 'the code and the one line are printed');
        check(readConfig(a).addressRequest === null, 'the request is cleared once the registrar holds the name');

        const again = await cli(a, ['--name', 'other-name']);
        check(again.code === 1 && /already has an address \(cairns\.beanpool\.org\)/.test(again.err) && /Settings/.test(again.err), '--name on a node that holds an address is refused, pointing to Settings');

        const key = 'ab'.repeat(32);
        const bad = await cli(a, ['--key', 'nothex', '--callsign', 'Owner']);
        check(bad.code === 1 && fs.existsSync(path.join(a.dir, 'claim-code.txt')), 'a malformed key is refused, nothing changed');
        const shell = await cli(a, ['--key', key, '--callsign', 'Founder']);
        check(shell.code === 0 && /@Founder is now the owner/.test(shell.out) && /break-glass code \(shown once/.test(shell.out), `--key --callsign: owner with a break-glass code (${shell.code} ${shell.err.trim()})`);
        check(!fs.existsSync(path.join(a.dir, 'claim-code.txt')), 'the claim file is gone');
        let burned = false;
        for (let i = 0; i < 40 && !burned; i++) { await pause(250); const c = readConfig(a).claim; burned = c?.claimedBy === key && !c.key && !c.salt; }
        check(burned, 'the node burned the code: claimedBy set, K and the salt deleted');
        check(/CLAIM|beanpool claim/.test(a.output()) && a.output().includes(`made @Founder its owner`), 'the node logged it and told the community');
        const second = await cli(a, ['--no-name']);
        check(second.code === 1 && /already has an owner/.test(second.err) && /beanpool recover/.test(second.err), 'a second claim from the shell is refused, pointing to beanpool recover');
        const get = await fetch(`https://127.0.0.1:${a.port}/api/local/claim`).then(r => r.json()) as any;
        check(get.unclaimed === false, 'the claim route says the node is claimed');
        check(!a.output().includes(code) && !a.output().includes(code.slice(6)), 'the code is never in the node\'s log');

        console.log('\n6. A name that awaits approval');
        reg.status = 'none'; reg.name = null;
        const b = await startNode('b', { REGISTRAR_URL: regUrl });
        const pend = await cli(b, ['--name', 'gated-one', '--direct', 'http://10.0.0.5:8080']);
        check(pend.code === 0 && /awaits approval/.test(pend.out), `pending: the message (${pend.code} ${pend.err.trim()})`);
        check(pend.out.includes(await qrOf(`beanpool://claim?node=${encodeURIComponent('http://10.0.0.5:8080')}&id=${readConfig(b).claim.id}&code=${codeOf(b)}`)), 'the QR falls back to the direct address');

        console.log('\n7. The registrar down');
        const c = await startNode('c', { REGISTRAR_URL: 'http://127.0.0.1:9' });
        const skip = await cli(c, ['--no-name', '--direct', 'http://192.168.1.20:8080']);
        check(skip.code === 0 && skip.out.includes(`The one-time claim code: ${codeOf(c)}`), '--no-name --direct: the code and the QR, no registrar asked');
        const down = await cli(c, ['--name', 'nobody-home', '--direct', 'http://192.168.1.20:8080'], { BEANPOOL_CLAIM_NAME_WAIT_MS: '8000' });
        check(down.code === 0 && /No answer within/.test(down.out) && down.out.includes('Address: http://192.168.1.20:8080'), `--name with the registrar down falls back to --direct (${down.code})`);
        const nothing = await cli(c, ['--no-name']);
        check(nothing.code === 0 && /phone will ask/.test(nothing.out), 'with no address at all, the QR carries none and says the phone will ask');

        console.log('\n8. Never in a backup or a standby\'s copy');
        const { redactLocalConfig } = await import('./config/local-config.js');
        const redacted = redactLocalConfig({ addressRequest: { name: 'x-y-z', mode: 'tunnel', requestedAt: 1 } } as any) as any;
        check(!('addressRequest' in redacted), 'a backup file\'s local config leaves the request out');
        const stager = fs.readFileSync(path.join(SRC, 'services/stager.ts'), 'utf8');
        check(/CREDENTIALS_LEFT_OUT = \[[^\]]*'addressRequest'/.test(stager), 'the stager\'s copy leaves it out');
    } finally {
        for (const n of started) { try { if (n.proc.pid && n.proc.exitCode === null) process.kill(-n.proc.pid, 'SIGKILL'); } catch { /* gone */ } }
        registrar.close();
    }
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

if (process.argv.includes('--child')) child().catch(e => { console.error(e); process.exit(1); });
else main().catch(e => { console.error(e); for (const n of started) { try { process.kill(-n.proc.pid!, 'SIGKILL'); } catch { /* gone */ } } process.exit(1); });
