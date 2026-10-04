/**
 * local-config.json holds the community's address and settings, so no write of it may ever be seen half done, and a
 * broken one is never read as a new install (write-file-atomic.ts, config/local-config.ts).
 *
 * In CI, test-claim-cli read local-config.json while its node was rewriting it and got "SyntaxError: Unexpected end of
 * JSON input" (run 37216393899): the node wrote it with a plain writeFileSync, which empties the file and then fills
 * it. A crash or a power cut in that window left a cut-off file, and the next start read it as no config at all.
 *
 *   1. writeFileAtomic keeps a 0600 file 0600 and leaves no temp file behind.
 *   2. A cut-off or empty local-config.json is read from its last good copy, with the address, and put right on disk.
 *   3. With no good copy either, reading fails closed: no defaults, and nothing is written over the file.
 *   4. A real node started on a cut-off local-config.json comes up with the community's name and address.
 *   5. One started with both files broken refuses to start, and leaves the file as it was.
 *   6. Another process reading local-config.json while the node saves it over and over never sees partial JSON.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-atomic-state-writes.ts
 */

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = process.env.BEANPOOL_DATA_DIR!;
let failures = 0;
let checks = 0;

function check(cond: unknown, msg: string): void {
    checks++;
    if (cond) console.log(`  ✅ ${msg}`);
    else { console.log(`  ❌ ${msg}`); failures++; }
}

const ADDRESS = { name: 'cairns', mode: 'tunnel' as const, contact: null, requestedAt: 1_700_000_000_000, refused: null };
const goodConfig = (extra: Record<string, unknown> = {}) => ({
    isLocked: false, callsign: null, location: null, adminHash: null, salt: null, joinedAt: null,
    communityName: 'Cairns Commons', contactEmail: 'hello@example.org', contactPhone: null,
    addressRequest: ADDRESS, ...extra,
});
const cutInHalf = (file: string) => {
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
};
const parses = (file: string) => { try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; } };

// ── Children (each with its own BEANPOOL_DATA_DIR, which config/local-config.ts reads at import) ──────────────────

/** Save a good config twice, as a running node does over its life. */
async function seedChild(): Promise<void> {
    const { saveLocalConfig } = await import('./config/local-config.js');
    saveLocalConfig(goodConfig({ contactPhone: 'first save' }) as any);
    saveLocalConfig(goodConfig() as any);
}

/** Start a node as index.ts does (no peers, no registrar), and say what it holds. */
async function nodeChild(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initAdminPassword, getLocalConfig, localConfigRestoredNotice } = await import('./config/local-config.js');
    const { initClaimCode } = await import('./claim-code.js');
    await initTls();
    initAdminPassword();
    se.initStateEngine();
    initClaimCode();
    const port = await startHttpsServer(0);
    const c = getLocalConfig();
    process.stdout.write('@@ ' + JSON.stringify({ port, address: c.addressRequest?.name ?? null, restored: !!localConfigRestoredNotice?.() }) + '\n');
}

/** Save local-config.json `n` times, each one big and different, then leave a marker. */
async function writerChild(): Promise<void> {
    const n = Number(process.argv[process.argv.indexOf('--writer') + 1]);
    const { saveLocalConfig } = await import('./config/local-config.js');
    for (let i = 0; i < n; i++) saveLocalConfig(goodConfig({ padding: String(i % 10).repeat(400_000) }) as any);
    fs.writeFileSync(path.join(process.env.BEANPOOL_DATA_DIR!, 'writer-done'), String(n));
}

function run(dir: string, args: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
        const env: NodeJS.ProcessEnv = { ...process.env, BEANPOOL_DATA_DIR: dir, NODE_ENV: 'test' };
        for (const k of ['PUBLIC_ADDRESS_NAME', 'PUBLIC_ADDRESS_AUTO', 'CF_RECORD_NAME', 'BEANPOOL_ADDRESSES', 'NODE_ROLE', 'ADMIN_PASSWORD', 'CF_API_TOKEN', 'CF_ZONE_ID']) delete env[k];
        const p = spawn(process.execPath, [...process.execArgv, SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        p.on('exit', (code) => resolve({ code, out }));
    });
}

interface Node { proc: ChildProcess; port: number; address: string | null; restored: boolean; output: () => string }
const started: ChildProcess[] = [];

function startNode(dir: string): Promise<Node> {
    const env: NodeJS.ProcessEnv = { ...process.env, BEANPOOL_DATA_DIR: dir, NODE_ENV: 'test', DISABLE_UPDATE_CHECK: 'true' };
    for (const k of ['PUBLIC_ADDRESS_NAME', 'PUBLIC_ADDRESS_AUTO', 'CF_RECORD_NAME', 'BEANPOOL_ADDRESSES', 'NODE_ROLE', 'ADMIN_PASSWORD', 'CF_API_TOKEN', 'CF_ZONE_ID']) delete env[k];
    const proc = spawn(process.execPath, [...process.execArgv, SCRIPT, '--node'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    started.push(proc);
    let out = '';
    const rl = readline.createInterface({ input: proc.stdout! });
    proc.stderr!.on('data', (d) => { out += d.toString(); });
    return new Promise((resolve, reject) => {
        rl.on('line', (line) => {
            out += line + '\n';
            if (line.startsWith('@@ ')) resolve({ proc, ...JSON.parse(line.slice(3)), output: () => out });
        });
        proc.on('exit', (code) => reject(Object.assign(new Error(`the node exited (${code})`), { code, out: () => out })));
    });
}

function getJson(port: number, p: string): Promise<any> {
    return new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port, path: p, rejectUnauthorized: false }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

// ── The checks ──────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const unit = path.join(ROOT, 'unit');
    fs.mkdirSync(unit, { recursive: true });
    process.env.BEANPOOL_DATA_DIR = unit;
    const cfg = await import('./config/local-config.js');
    const file = path.join(unit, 'local-config.json');

    console.log('\n1. writeFileAtomic');
    let writeFileAtomic: ((f: string, d: string, o?: { mode?: number }) => void) | null = null;
    try { ({ writeFileAtomic } = await import('./write-file-atomic.js')); } catch { /* not on this tree */ }
    check(writeFileAtomic, 'there is one shared atomic writer (write-file-atomic.ts)');
    if (writeFileAtomic) {
        const f = path.join(unit, 'secret.json');
        fs.writeFileSync(f, '{"v":1}', { mode: 0o600 });
        fs.chmodSync(f, 0o600);
        writeFileAtomic(f, '{"v":2}');
        check((fs.statSync(f).mode & 0o777) === 0o600 && fs.readFileSync(f, 'utf8') === '{"v":2}', `a 0600 file keeps 0600 when replaced (${(fs.statSync(f).mode & 0o777).toString(8)})`);
        check(!fs.readdirSync(unit).some((n) => n.includes('.tmp')), 'no temp file is left behind');
    }

    console.log('\n2. A cut-off local-config.json');
    cfg.saveLocalConfig(goodConfig() as any);
    fs.chmodSync(file, 0o600);
    cfg.saveLocalConfig(goodConfig() as any);
    check((fs.statSync(file).mode & 0o777) === 0o600, 'local-config.json keeps 0600 across a save');
    cutInHalf(file);
    let read: any = null;
    try { read = cfg.getLocalConfig(); } catch (e) { console.log(`     threw: ${(e as Error).message}`); }
    check(read?.addressRequest?.name === 'cairns' && read?.communityName === 'Cairns Commons', `read from the last good copy, address intact (${read?.addressRequest?.name ?? 'no address'}, ${read?.communityName ?? 'no name'})`);
    check(parses(file) && JSON.parse(fs.readFileSync(file, 'utf8')).addressRequest?.name === 'cairns', 'local-config.json is put right on disk');
    check(fs.readdirSync(unit).some((n) => n.startsWith('local-config.json.broken-')), 'the broken file is kept beside it for a look');

    fs.writeFileSync(file, '');
    try { cfg.updateLocalConfig({ contactPhone: '555' }); } catch (e) { console.log(`     threw: ${(e as Error).message}`); }
    const after = parses(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    check(after?.addressRequest?.name === 'cairns' && after?.contactPhone === '555', `an empty file then a save: the address is kept and the change saved (${after?.addressRequest?.name ?? 'no address'})`);

    console.log('\n3. Nothing good to read');
    fs.writeFileSync(file, '{"communityName": "Cairns Comm');
    fs.writeFileSync(`${file}.bak`, '{"isLock');
    const before = fs.readFileSync(file);
    let threw = false;
    try { cfg.getLocalConfig(); } catch { threw = true; }
    check(threw, 'reading fails closed: no defaults');
    try { cfg.updateLocalConfig({ contactPhone: '556' }); } catch { /* fails closed */ }
    check(fs.readFileSync(file).equals(before), 'a save does not write defaults over the file');

    console.log('\n4. A node started on a cut-off local-config.json');
    const bootDir = path.join(ROOT, 'boot');
    fs.mkdirSync(bootDir, { recursive: true });
    const seeded = await run(bootDir, ['--seed']);
    check(seeded.code === 0, `seeded (${seeded.code})`);
    cutInHalf(path.join(bootDir, 'local-config.json'));
    try {
        const node = await startNode(bootDir);
        const info = await getJson(node.port, '/api/local/community-info');
        check(info.communityName === 'Cairns Commons', `it serves the community's name (${info.communityName})`);
        check(node.address === 'cairns', `it holds the address it asked for (${node.address})`);
        const onDisk = JSON.parse(fs.readFileSync(path.join(bootDir, 'local-config.json'), 'utf8'));
        check(onDisk.addressRequest?.name === 'cairns' && onDisk.communityName === 'Cairns Commons', 'local-config.json on disk holds them again');
        check(node.restored && /last good copy/.test(node.output()), 'it says loudly that it started from the last good copy');
        node.proc.kill('SIGKILL');
    } catch (e) {
        check(false, `the node started (${(e as Error).message})`);
        console.log(((e as any).out?.() ?? '').slice(-2000));
    }

    console.log('\n5. A node started with nothing good to read');
    const deadDir = path.join(ROOT, 'dead');
    fs.mkdirSync(deadDir, { recursive: true });
    check((await run(deadDir, ['--seed'])).code === 0, 'seeded');
    const deadFile = path.join(deadDir, 'local-config.json');
    cutInHalf(deadFile);
    fs.writeFileSync(`${deadFile}.bak`, '');
    const deadBytes = fs.readFileSync(deadFile);
    try {
        const node = await startNode(deadDir);
        check(false, 'it refuses to start (it started as a new install)');
        node.proc.kill('SIGKILL');
    } catch (e) {
        check((e as any).code !== undefined, `it refuses to start (exit ${(e as any).code})`);
        check(/will not start as a new install/.test((e as any).out?.() ?? ''), 'and says why');
    }
    check(fs.readFileSync(deadFile).equals(deadBytes), 'local-config.json is left as it was');

    console.log('\n6. Reads while the node saves over and over');
    const raceDir = path.join(ROOT, 'race');
    fs.mkdirSync(raceDir, { recursive: true });
    const raceFile = path.join(raceDir, 'local-config.json');
    const writer = run(raceDir, ['--writer', '150']);
    let reads = 0, partial = 0;
    const t0 = Date.now();
    while (!fs.existsSync(path.join(raceDir, 'writer-done')) && Date.now() - t0 < 120_000) {
        let text: string;
        try { text = fs.readFileSync(raceFile, 'utf8'); } catch { continue; }   // not written yet
        reads++;
        try { JSON.parse(text); } catch { partial++; }
    }
    const w = await writer;
    check(w.code === 0, `the writer saved 150 times (${w.code})`);
    check(reads > 100, `read it ${reads} times while it was being saved`);
    check(partial === 0, `no read saw partial JSON (${partial} of ${reads} did)`);
}

if (process.argv.includes('--seed')) seedChild().catch((e) => { console.error(e); process.exit(1); });
else if (process.argv.includes('--node')) nodeChild().catch((e) => { console.error(e); process.exit(1); });
else if (process.argv.includes('--writer')) writerChild().catch((e) => { console.error(e); process.exit(1); });
else {
    main()
        .catch((e) => { console.error(e); failures++; })
        .finally(() => {
            for (const p of started) try { p.kill('SIGKILL'); } catch { /* gone */ }
            console.log(`\n${checks - failures}/${checks} passed`);
            process.exit(failures ? 1 : 0);
        });
}
