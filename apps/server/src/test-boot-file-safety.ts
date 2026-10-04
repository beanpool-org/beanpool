/**
 * A start never changes the community's identity, and its key files are private (follow-ups to #1616's review).
 *
 * Each case starts a real node process on its own data dir, running index.ts's first steps in order (boot-file-safety,
 * genesis, admin password, TLS, the node key): an empty or cut-off libp2p_key stops the start and stays as it was; a
 * community.key with no genesis.json is never written over; a new install's key files and local-config.json are 0600;
 * an older install's 0644 files are 0600 after a start; an upgraded node gets local-config.json.bak at its first start;
 * a crash's temp files are removed and nothing else. Then, in their own processes: a sealed restore over a config that
 * can't be read writes nothing; a restore that can't put the good copy back runs once per process; a save whose .bak
 * write fails says so.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-boot-file-safety.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = process.env.BEANPOOL_DATA_DIR!;
let failures = 0;
let passes = 0;

function check(cond: unknown, msg: string): void {
    if (cond) { passes++; console.log(`  ✅ ${msg}`); } else { failures++; console.log(`  ❌ ${msg}`); }
}

const modeOf = (f: string) => fs.statSync(f).mode & 0o777;
const octal = (m: number) => m.toString(8).padStart(4, '0');
const cutInHalf = (file: string) => {
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
};
const goodConfig = (extra: Record<string, unknown> = {}) => ({
    isLocked: false, callsign: null, location: null, adminHash: null, salt: null, joinedAt: 1,
    communityName: 'Cairns Commons', contactEmail: null, contactPhone: null,
    addressRequest: { name: 'cairns', mode: 'tunnel', requestedAt: 1 }, ...extra,
});

// ── Children (each with its own BEANPOOL_DATA_DIR, read at import) ──────────────────────────────────────────────────

/** index.ts's first steps, in its order, then the node key as startP2P loads it (no ports opened). */
async function bootChild(): Promise<void> {
    process.umask(0o022);
    const dir = process.env.BEANPOOL_DATA_DIR!;
    let secure: ((d: string) => void) | null = null;
    try { ({ secureDataDirAtBoot: secure } = await import('./boot-file-safety.js')); } catch { /* not on this tree */ }
    if (secure) secure(dir);
    const { ensureGenesis } = await import('./genesis.js');
    await ensureGenesis();
    const { initAdminPassword, saveLocalConfig, getLocalConfig } = await import('./config/local-config.js');
    initAdminPassword();
    // A setting saved, as an owner's first change does, so a new install has local-config.json and its copy.
    saveLocalConfig({ ...getLocalConfig(), contactPhone: 'saved at start' });
    const { initTls } = await import('./services/tls.js');
    await initTls();
    const p2p = await import('./p2p.js') as any;
    const peerId = p2p.loadOrCreateIdentity ? (await p2p.loadOrCreateIdentity()).publicKey.toString() : null;
    process.stdout.write('@@ ' + JSON.stringify({ peerId }) + '\n', () => process.exit(0));
}

/** A sealed restore into this data dir, with a bundle that would replace every identity file. */
async function restoreChild(): Promise<void> {
    const { applyBundle } = await import('./services/sealed-backup.js');
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const bundle: any = {
        v: 1,
        files: { libp2p_key: b64('NEW NODE KEY'), 'community.key': b64('NEW COMMUNITY KEY'), 'genesis.json': b64('{"communityId":"new"}'), 'connectors.json': b64('[]') },
        localConfig: { adminHash: 'new-hash', salt: 'new-salt' },
        nodeRoles: [],
    };
    try {
        applyBundle(bundle);
        process.stdout.write('@@ applied\n');
    } catch (e) {
        process.stdout.write('@@ refused ' + (e as Error).constructor.name + ': ' + (e as Error).message + '\n');
    }
}

/** A broken local-config.json whose good copy can't be put back (the file is read-only): read 5 times. */
async function restoreOnceChild(): Promise<void> {
    const cfg = await import('./config/local-config.js');
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    const names: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
        names.push(cfg.getLocalConfig().addressRequest?.name ?? null);
        await new Promise((r) => setTimeout(r, 3));
    }
    console.error = orig;
    process.stdout.write('@@ ' + JSON.stringify({ names, restoredLines: lines.filter((l) => l.includes('was unreadable')).length }) + '\n');
}

/** A save whose .bak write fails (a read-only .bak). */
async function bakFailChild(): Promise<void> {
    const cfg = await import('./config/local-config.js');
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    cfg.saveLocalConfig(goodConfig({ contactPhone: 'second' }) as any);
    console.error = orig;
    process.stdout.write('@@ ' + JSON.stringify({ lines }) + '\n');
}

function run(dir: string, args: string[]): Promise<{ code: number | null; out: string; result: any }> {
    return new Promise((resolve) => {
        const env: NodeJS.ProcessEnv = { ...process.env, BEANPOOL_DATA_DIR: dir, NODE_ENV: 'test', DISABLE_UPDATE_CHECK: 'true' };
        for (const k of ['PUBLIC_ADDRESS_NAME', 'PUBLIC_ADDRESS_AUTO', 'CF_RECORD_NAME', 'BEANPOOL_ADDRESSES', 'NODE_ROLE', 'ADMIN_PASSWORD', 'CF_API_TOKEN', 'CF_ZONE_ID', 'LE_DOMAIN', 'DOMAIN']) delete env[k];
        const p = spawn(process.execPath, [...process.execArgv, SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        p.on('exit', (code) => {
            const line = out.split('\n').find((l) => l.startsWith('@@ '));
            let result: any = null;
            if (line) { try { result = JSON.parse(line.slice(3)); } catch { result = line.slice(3); } }
            resolve({ code, out, result });
        });
    });
}

const fresh = (name: string) => { const d = path.join(ROOT, name); fs.mkdirSync(d, { recursive: true }); return d; };
const tail = (out: string) => out.split('\n').filter((l) => l.includes('🛑') || l.includes('Error')).slice(0, 2).join(' | ').slice(0, 300);

// ── The checks ──────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('\n1. A new install: its key files and local-config.json are 0600');
    const a = fresh('new-install');
    const first = await run(a, ['--boot']);
    check(first.code === 0 && first.result?.peerId, `the node starts and makes its identity (exit ${first.code}) ${first.code ? tail(first.out) : ''}`);
    for (const rel of ['libp2p_key', 'community.key', 'local-config.json', 'local-config.json.bak', 'tls/ca-key.pem', 'tls/server-key.pem']) {
        const f = path.join(a, rel);
        check(fs.existsSync(f) && modeOf(f) === 0o600, `${rel} is 0600 (${fs.existsSync(f) ? octal(modeOf(f)) : 'missing'})`);
    }
    const second = await run(a, ['--boot']);
    check(second.code === 0 && second.result?.peerId === first.result?.peerId, 'the next start has the same identity');

    console.log('\n2. A cut-off or empty libp2p_key stops the start, and is never written over');
    for (const how of ['cut off', 'empty'] as const) {
        const d = fresh(`broken-key-${how.replace(' ', '-')}`);
        const ok = await run(d, ['--boot']);
        check(ok.code === 0, `set up (exit ${ok.code})`);
        const keyFile = path.join(d, 'libp2p_key');
        if (how === 'cut off') cutInHalf(keyFile); else fs.writeFileSync(keyFile, '');
        const before = fs.readFileSync(keyFile);
        const r = await run(d, ['--boot']);
        check(r.code !== 0 && r.code !== null && !r.result, `${how}: the node exits non-zero and never runs (exit ${r.code})`);
        check(fs.readFileSync(keyFile).equals(before), `${how}: libp2p_key is unchanged (${fs.readFileSync(keyFile).length} bytes)`);
        check(/libp2p_key/.test(r.out) && /backup/i.test(r.out) && !/ephemeral/i.test(r.out), `${how}: the log names the file and how to put it back, and no ephemeral identity`);
    }

    console.log('\n3. community.key with no genesis.json: never a new community over it');
    const g = fresh('no-genesis');
    check((await run(g, ['--boot'])).code === 0, 'set up');
    const ck = path.join(g, 'community.key');
    const ckBefore = fs.readFileSync(ck);
    fs.unlinkSync(path.join(g, 'genesis.json'));
    const rg = await run(g, ['--boot']);
    check(rg.code !== 0 && rg.code !== null, `the node exits non-zero (exit ${rg.code})`);
    check(fs.readFileSync(ck).equals(ckBefore) && !fs.existsSync(path.join(g, 'genesis.json')), 'community.key is unchanged and no new genesis.json is written');

    console.log('\n4. An older install\'s 0644 files are 0600 after a start');
    const o = fresh('older-install');
    check((await run(o, ['--boot'])).code === 0, 'set up');
    const secrets = ['libp2p_key', 'community.key', 'local-config.json', 'local-config.json.bak', 'tls/ca-key.pem', 'tls/server-key.pem'];
    for (const rel of secrets) fs.chmodSync(path.join(o, rel), 0o644);
    fs.chmodSync(path.join(o, 'genesis.json'), 0o644);
    const ro = await run(o, ['--boot']);
    check(ro.code === 0, `the node starts (exit ${ro.code})`);
    for (const rel of secrets) check(modeOf(path.join(o, rel)) === 0o600, `${rel}: 0644 → ${octal(modeOf(path.join(o, rel)))}`);
    check(modeOf(path.join(o, 'genesis.json')) === 0o644, 'genesis.json (public) is left as it was');
    check(/readable by other users/.test(ro.out), 'the start logs each file it made private');

    console.log('\n5. An upgraded node (local-config.json, no .bak) gets its last good copy at its first start');
    const u = fresh('upgraded');
    check((await run(u, ['--boot'])).code === 0, 'set up');
    const cfgFile = path.join(u, 'local-config.json');
    fs.unlinkSync(`${cfgFile}.bak`);
    fs.writeFileSync(cfgFile, JSON.stringify(goodConfig(), null, 2), { mode: 0o600 });
    const bootOnly = await run(u, ['--boot-files-only']);
    check(bootOnly.code === 0 && fs.existsSync(`${cfgFile}.bak`), `a start writes local-config.json.bak (exit ${bootOnly.code})`);
    check(fs.existsSync(`${cfgFile}.bak`) && fs.readFileSync(`${cfgFile}.bak`).equals(fs.readFileSync(cfgFile)) && modeOf(`${cfgFile}.bak`) === 0o600, 'the same bytes, 0600');
    cutInHalf(cfgFile);
    const ru = await run(u, ['--boot']);
    check(ru.code === 0, `then cut off before any save: the node starts from the copy (exit ${ru.code})`);
    check(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).addressRequest?.name === 'cairns', 'the address is intact');

    console.log('\n6. A crash\'s temp files are removed at start, and nothing else');
    const t = fresh('temps');
    check((await run(t, ['--boot'])).code === 0, 'set up');
    const stale = ['.local-config.json.tmp-999999-deadbeef', '.libp2p_key.tmp-999998-0badf00d'];
    const kept = ['.local-config.json.tmp-notours', 'notes.tmp-999999-deadbeef', `.local-config.json.tmp-${process.pid}-cafecafe`];
    for (const n of [...stale, ...kept]) fs.writeFileSync(path.join(t, n), 'secret');
    fs.writeFileSync(path.join(t, 'tls', '.server-key.pem.tmp-999997-12345678'), 'secret');
    fs.mkdirSync(path.join(t, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(t, 'snapshots', '.x.tmp-999999-deadbeef'), 'not ours');
    const rt = await run(t, ['--boot']);
    check(rt.code === 0, `the node starts (exit ${rt.code})`);
    check(stale.every((n) => !fs.existsSync(path.join(t, n))) && !fs.existsSync(path.join(t, 'tls', '.server-key.pem.tmp-999997-12345678')), 'temps from a stopped writer are gone (data dir and tls/)');
    check(kept.every((n) => fs.existsSync(path.join(t, n))), 'other names, and a live writer\'s fresh temp (this test\'s pid), are kept');
    check(fs.existsSync(path.join(t, 'snapshots', '.x.tmp-999999-deadbeef')), 'nothing below the data dir is touched');

    console.log('\n7. A sealed restore over a config that can\'t be read writes nothing');
    const s = fresh('restore');
    check((await run(s, ['--boot'])).code === 0, 'set up');
    fs.writeFileSync(path.join(s, 'connectors.json'), '[]');
    fs.writeFileSync(path.join(s, 'local-config.json'), '{"communityName": "Cair');
    fs.writeFileSync(path.join(s, 'local-config.json.bak'), '');
    // state.db is left out: the child's import of the database module opens it; applyBundle writes only the identity files and the config.
    const snapshot = () => Object.fromEntries(fs.readdirSync(s).filter((n) => !n.startsWith('state.db') && fs.statSync(path.join(s, n)).isFile()).map((n) => [n, fs.readFileSync(path.join(s, n)).toString('base64')]));
    const before = snapshot();
    const rs = await run(s, ['--restore']);
    check(typeof rs.result === 'string' && rs.result.startsWith('refused LocalConfigUnreadableError'), `the restore refuses (${String(rs.result).slice(0, 90)})`);
    const after = snapshot();
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((n) => before[n] !== after[n]);
    check(changed.length === 0, `every file in the data dir is as it was: no identity file written, none added (changed: ${changed.join(', ') || 'none'})`);

    console.log('\n8. A restore that can\'t put the good copy back runs once per process');
    const r1 = fresh('restore-once');
    const f1 = path.join(r1, 'local-config.json');
    fs.writeFileSync(`${f1}.bak`, JSON.stringify(goodConfig()), { mode: 0o600 });
    fs.writeFileSync(f1, '{"isLock', { mode: 0o400 });
    fs.chmodSync(f1, 0o400);
    const ro1 = await run(r1, ['--restore-once']);
    const copies = fs.readdirSync(r1).filter((n) => n.startsWith('local-config.json.broken-')).length;
    check(ro1.result?.names?.length === 5 && ro1.result.names.every((n: string) => n === 'cairns'), `5 reads, each from the good copy (${JSON.stringify(ro1.result?.names)})`);
    check(ro1.result?.restoredLines === 1, `one 🛑 line, not one per read (${ro1.result?.restoredLines})`);
    check(copies === 1, `one .broken copy, not one per read (${copies})`);
    fs.chmodSync(f1, 0o600);

    console.log('\n9. A save whose .bak write fails says which write failed');
    const b = fresh('bak-fail');
    const fb = path.join(b, 'local-config.json');
    fs.writeFileSync(fb, JSON.stringify(goodConfig()), { mode: 0o600 });
    fs.writeFileSync(`${fb}.bak`, JSON.stringify(goodConfig()), { mode: 0o400 });
    fs.chmodSync(`${fb}.bak`, 0o400);
    const rb = await run(b, ['--bak-fail']);
    const lines: string[] = rb.result?.lines ?? [];
    check(JSON.parse(fs.readFileSync(fb, 'utf8')).contactPhone === 'second', 'local-config.json is saved');
    check(lines.some((l) => l.includes('.bak') && /one save behind/.test(l)) && !lines.some((l) => /Failed to save local config/.test(l)), `the log names the .bak write, not the save (${(lines[0] ?? '').slice(0, 120)})`);
    fs.chmodSync(`${fb}.bak`, 0o600);

    console.log('\n10. index.ts makes the data dir safe before anything reads it');
    const index = fs.readFileSync(path.join(path.dirname(SCRIPT), 'index.ts'), 'utf8');
    const at = index.indexOf('secureDataDirAtBoot(');
    check(at > 0 && at < index.indexOf('await ensureGenesis()') && at < index.indexOf('initAdminPassword()'), 'secureDataDirAtBoot runs before genesis and the first config read');

    console.log(`\n${failures === 0 ? '✅' : '❌'} boot-file-safety: ${passes}/${passes + failures} passed`);
    process.exit(failures === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === '--boot') await bootChild();
else if (mode === '--boot-files-only') {
    const { secureDataDirAtBoot } = await import('./boot-file-safety.js').catch(() => ({ secureDataDirAtBoot: (_: string) => {} }));
    secureDataDirAtBoot(process.env.BEANPOOL_DATA_DIR!);
} else if (mode === '--restore') await restoreChild();
else if (mode === '--restore-once') await restoreOnceChild();
else if (mode === '--bak-fail') await bakFailChild();
else await main();
