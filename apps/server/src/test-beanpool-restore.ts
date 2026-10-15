/**
 * `beanpool restore` and `beanpool restore-point` (design case 18 §3.5, §4, slice S3): the restore on the server itself,
 * with the node stopped, for when Settings cannot do it.
 *
 * End to end against a node data dir: the command runs as its own process, as `docker compose run` runs it, on the
 * database and files the node uses. This process plays the node: while it holds state.db open the node is running.
 *   1. While the node runs (its lock held, node-running-lock.ts, and state.db open with a write its last statement, which
 *      alone holds no lock on the file) a restore and a roll-back are refused, and nothing changes; `restore-point list`
 *      still answers, read-only.
 *   1b. While the command waits at a question it holds the node's lock: a node started then would wait. The lock file
 *      removed and taken by a node that started after → at "yes" the command refuses (exit 1), and nothing changes.
 *   2. A recovery code is never taken on the command line (exit 2, never echoed), in any argument: after --code,
 *      --code-file or --accept-signer, as the file, or as a restore point's name.
 *   3. A sealed file this server locked, with the code from --code-file: before anything is asked the output shows the
 *      file's community and signer beside this server's own; the database comes back (a row planted after the backup
 *      is gone), the keys and password come back (pinned signer), a restore point holds the row planted after the
 *      backup, the opened plaintext is not left behind, the code is never printed. The notice is delivered once.
 *   4. A wrong code typed at the prompt is refused, and nothing changes. A code file others can read is warned about.
 *   5. `restore-point list` shows the point; `roll-back` asks for `yes`, then brings the old state back (the row and
 *      the password), keeps a point of its own first, and leaves the notice.
 *   5b. Another community's file goes by its community: --accept-signer on it → exit 2; without, "DIFFERENT" with this
 *      server's name, member count and owners before `yes`; on a standby, a file of its community locked by another
 *      machine names the main server it copies.
 *   6. A file of this community locked by another machine: refused without --accept-signer, and with the wrong one;
 *      with it, the database only (no key, password or genesis moves); --with-keys alone is a usage error; with
 *      --accept-signer --with-keys, `yes` declined changes nothing, `yes` typed applies its keys.
 *   7. An old unlocked .tar.gz: refused without --unlocked; with it, anything but `UNLOCKED` changes nothing;
 *      `UNLOCKED` restores the database and never the keys.
 *   8. Exit codes: no file or an unknown option → 2; an unknown restore point → 1; `restore-point` alone → 2.
 *   9. The real node (index.ts): started while the command waits at a question, it waits, says so, and starts once the
 *      command ends; a second node on the same data folder waits until the first stops.
 *   10. A damaged or empty state.db: both commands refuse with what to do.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-beanpool-restore.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { db } from './db/db.js';
import { ensureGenesis } from './genesis.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { makeRecoveryCode } from './services/takeover-envelope.js';
import { createPlainBackup, createSealedBackup } from './services/sealed-backup.js';
import { writeDbSnapshot } from './services/snapshot-scheduler.js';
import { deliverRestoreNotices } from './services/restore-points.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const DATA_DIR = process.env.BEANPOOL_DATA_DIR!;
if (!DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');
const SRC = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-restore-'));
const STATE = path.join(DATA_DIR, 'state.db');
const POINTS = path.join(DATA_DIR, 'restore-points');

function cli(args: string[], input = '', env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(SRC, 'recover-cli.ts'), ...args], {
        env: { ...process.env, BEANPOOL_DATA_DIR: DATA_DIR, ...env }, encoding: 'utf8', timeout: 120_000, input,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout ?? '' };
}
/** The command as its own process, answered later: it can be left waiting at a question. */
function cliWaiting(args: string[], env: Record<string, string> = {}) {
    const c = spawn(process.execPath, ['--import', 'tsx', path.join(SRC, 'recover-cli.ts'), ...args], {
        env: { ...process.env, BEANPOOL_DATA_DIR: DATA_DIR, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const done = new Promise<{ code: number | null; out: string }>((resolve) => c.on('close', (code) => resolve({ code, out })));
    return { child: c, out: () => out, done, answer: (line: string) => { c.stdin.write(line); c.stdin.end(); } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(get: () => string, text: string, ms = 90_000): Promise<boolean> {
    const t0 = Date.now();
    while (!get().includes(text)) {
        if (Date.now() - t0 > ms || get().endsWith('[exited]')) return false;
        await sleep(100);
    }
    return true;
}
const sha = (p: string) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
/** A row's presence in a database file, read with a connection of its own that is closed at once (an open one IS a running node). */
function hasMember(callsign: string, file = STATE): boolean {
    const c = new Database(file, { readonly: true, fileMustExist: true });
    try { return !!c.prepare('SELECT 1 FROM members WHERE callsign = ?').get(callsign); } finally { c.close(); }
}
const points = () => { try { return fs.readdirSync(POINTS).filter((n) => !n.startsWith('.')).sort(); } catch { return [] as string[]; } };
const notices = () => fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('restore-notice-'));
const adminHash = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'local-config.json'), 'utf-8')).adminHash as string;
/** The community in the database, read with a connection of its own: who is in it and who holds a role. */
function people(file = STATE): string {
    const c = new Database(file, { readonly: true, fileMustExist: true });
    try {
        return JSON.stringify([c.prepare('SELECT callsign FROM members ORDER BY callsign').all(), c.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY 1, 2').all()]);
    } finally { c.close(); }
}
/** Everything a refused command must leave as it was. Not state.db's bytes: once the node is stopped, the command opens
 *  the database the way the node does at its start (its own boot rows), as the node's next start would. */
const state = () => JSON.stringify({
    people: people(), key: sha(path.join(DATA_DIR, 'libp2p_key')), genesis: sha(path.join(DATA_DIR, 'genesis.json')),
    config: sha(path.join(DATA_DIR, 'local-config.json')), points: points(), notices: notices(),
    leftovers: fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('.restore') || f.startsWith('uploaded-backup')),
});
const addMember = (key: string, callsign: string) => db.prepare(
    `INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, 'genesis', 'TEST')`,
).run(key, callsign, new Date().toISOString());
const delivered = () => {
    const told: string[] = [];
    const n = deliverRestoreNotices({ announce: (title, body) => told.push(`${title}: ${body}`), log: () => {} });
    return { n, told };
};
/** A minimal ustar of regular files, gzipped, the same on every OS (no system tar and its extended headers). */
function tarGzOf(files: Array<{ name: string; content: Buffer }>): Buffer {
    const blocks: Buffer[] = [];
    for (const f of files) {
        const h = Buffer.alloc(512);
        h.write(`./${f.name}`, 0, 100, 'utf8');
        h.write('0000600\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write(f.content.length.toString(8).padStart(11, '0') + '\0', 124);
        h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
        h.write('        ', 148);
        h.write('0', 156);
        h.write('ustar\0', 257);
        h.write('00', 263);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(h, f.content, Buffer.alloc((512 - (f.content.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}
async function bodyOf(b: { body: AsyncIterable<unknown> }): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const c of b.body) parts.push(c as Buffer);
    return Buffer.concat(parts);
}

// ── The server: a community, its key, an owner, a password, a recovery code ──
initStateEngine();
await ensureGenesis();
const { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
const core = await import('@beanpool/core');
const nodeKeyBytes = privateKeyToProtobuf(await generateKeyPair('Ed25519'));
fs.writeFileSync(path.join(DATA_DIR, 'libp2p_key'), nodeKeyBytes);
const ownPeer = peerIdFromPrivateKey(privateKeyFromProtobuf(nodeKeyBytes)).toString();
const communityId: string = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'genesis.json'), 'utf-8')).communityId;
const { ed25519 } = await import('@noble/curves/ed25519.js');
const ownerPub = Buffer.from(ed25519.getPublicKey(crypto.randomBytes(32))).toString('hex');
seedGenesisMember(ownerPub, 'Olive');
const PW_AT_BACKUP = hashPassword('Backup-Time-Pw-1!');
updateLocalConfig({ adminHash: PW_AT_BACKUP.hash, salt: PW_AT_BACKUP.salt, communityName: 'Riverbend Commons' } as any);

// An old unlocked backup, made before the code, holding a row of its own.
addMember('a1'.repeat(32), 'PlainRow');
const plainFile = path.join(work, 'old.tar.gz');
fs.writeFileSync(plainFile, await bodyOf(await createPlainBackup()));
db.prepare('DELETE FROM members WHERE callsign = ?').run('PlainRow');

const code = await makeRecoveryCode();
const codeFile = path.join(work, 'code.txt');
fs.writeFileSync(codeFile, `${code.code}\n`, { mode: 0o600 });

// The sealed backup, made by the code Settings uses: locked by this server's key, to the owner and the code.
addMember('b1'.repeat(32), 'BeforeBackup');
const sealedFile = path.join(work, 'backup.bpsealed');
fs.writeFileSync(sealedFile, await bodyOf(await createSealedBackup()));

// A file of this community locked by ANOTHER machine: its database has a row of its own, its bundle that machine's key.
const forgerKey = await generateKeyPair('Ed25519');
const forgerPeer = peerIdFromPrivateKey(forgerKey).toString();
const forgerKeyBytes = privateKeyToProtobuf(forgerKey);
addMember('c1'.repeat(32), 'ForgedRow');
const forgedDb = path.join(work, 'forged-state.db');
writeDbSnapshot(forgedDb);
db.prepare('DELETE FROM members WHERE callsign = ?').run('ForgedRow');
const forgedBundle = JSON.stringify({
    v: 1,
    files: {
        libp2p_key: Buffer.from(forgerKeyBytes).toString('base64'),
        'community.key': Buffer.from('other-machine-community-key').toString('base64'),
        'genesis.json': Buffer.from(JSON.stringify({ communityId, otherMachine: true })).toString('base64'),
        'connectors.json': null,
    },
    localConfig: { adminHash: 'other-machine-hash', salt: 'other-machine-salt', totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: null },
    nodeRoles: [], publicAddress: null, recoveryCode: null,
});
const forgedTar = tarGzOf([
    { name: 'state.db', content: fs.readFileSync(forgedDb) },
    { name: 'node_config.json', content: Buffer.from('{}') },
    { name: 'takeover-bundle.json', content: Buffer.from(forgedBundle) },
]);
const forgedFile = path.join(work, 'other-machine.bpsealed');
fs.writeFileSync(forgedFile, Buffer.from(await core.sealEnvelope(new Uint8Array(forgedTar), {
    kind: 'backup', communityId, nodePeerId: forgerPeer,
    recipients: { owners: [{ pubkey: ownerPub, callsign: 'Olive' }], codes: [(await import('./config/local-config.js')).getLocalConfig().recoveryCode as any] },
    signingKey: new Uint8Array(forgerKey.raw.subarray(0, 32)),
})));

// A file of ANOTHER community, locked by that machine: only its header matters here (nothing of it is ever applied).
const otherCommunityId = 'f'.repeat(16);
const otherFile = path.join(work, 'other-community.bpsealed');
fs.writeFileSync(otherFile, Buffer.from(await core.sealEnvelope(new Uint8Array(forgedTar), {
    kind: 'backup', communityId: otherCommunityId, nodePeerId: forgerPeer,
    recipients: { owners: [{ pubkey: ownerPub, callsign: 'Ostrander' }], codes: [(await import('./config/local-config.js')).getLocalConfig().recoveryCode as any] },
    signingKey: new Uint8Array(forgerKey.raw.subarray(0, 32)),
})));

// After the backup: a row, and a new password. The restore must take both away; the roll-back must bring both back.
addMember('d1'.repeat(32), 'AfterBackup');
const PW_LATER = hashPassword('Changed-Later-Pw-2!');
updateLocalConfig({ adminHash: PW_LATER.hash, salt: PW_LATER.salt } as any);

// ── 1. The node is running ──
console.log('\n— 1. refused while the node runs —');
// As index.ts does first at boot. Loaded by name so this suite still runs where the module is not (fail-first on main).
const lock: any = await import('./node-running-lock.js').catch(() => null);
lock?.holdNodeRunningLock();
{
    addMember('e1'.repeat(32), 'LastWrite');
    db.prepare('DELETE FROM members WHERE callsign = ?').run('LastWrite');
    const before = state();
    const r = cli(['restore', '--code-file', codeFile, sealedFile]);
    assert(r.code === 1 && r.out.includes('The node is running') && r.out.includes('Nothing was changed.'),
        `1. restore while state.db is held open → exit 1, "The node is running" (exit ${r.code}: ${r.out.trim().slice(-200)})`);
    assert(state() === before && hasMember('AfterBackup'), '1. nothing changed: database, keys, config, no restore point, no notice');
    const l = cli(['restore-point', 'list']);
    assert(l.code === 0 && l.out.includes('No restore points'), `1. restore-point list answers beside the running node, read-only (exit ${l.code}: ${l.out.trim().slice(-160)})`);
    const rb = cli(['restore-point', 'roll-back', '2026-01-01T00-00-00.000Z-before-restore'], 'yes\n');
    assert(rb.code === 1 && state() === before, `1. a roll-back is refused too (exit ${rb.code})`);
}

// The node stops: this process lets go of its lock and of state.db (folding its -wal in), as a stopped container does.
lock?.releaseNodeRunningLock();
db.close();

// ── 1b. A node that starts while the command waits at a question ──
console.log('\n— 1b. the command holds the lock while it asks —');
{
    const before = state();
    const c = cliWaiting(['restore', '--code-file', codeFile, '--accept-signer', forgerPeer, '--with-keys', forgedFile]);
    const asked = await waitFor(c.out, 'Type yes to go on');
    const taking = lock?.tryHoldNodeRunningLock?.(DATA_DIR);
    assert(asked && taking?.held === false && taking?.busy === true && lock?.nodeRunningLockHeld(DATA_DIR) === true,
        `1b. while it waits at "Type yes" the command holds data/.node-running.lock: a node started now waits (${JSON.stringify(taking)})`);
    // Someone removes the lock file, as a stale pid file is removed, and a node starts and holds a new one.
    fs.rmSync(path.join(DATA_DIR, '.node-running.lock'), { force: true });
    lock?.holdNodeRunningLock(DATA_DIR);
    c.answer('yes\n');
    const r = await c.done;
    lock?.releaseNodeRunningLock();
    assert(r.code === 1 && r.out.includes('data/.node-running.lock was removed or replaced while this command waited') && r.out.trim().endsWith('Nothing was changed.'),
        `1b. at "yes" the lock is no longer its own → exit 1, refused in words (exit ${r.code}: ${r.out.trim().slice(-220)})`);
    assert(state() === before && hasMember('AfterBackup'), '1b. nothing changed: database, keys, config, no restore point, no notice, no opened file left');
}

// ── 2. Never a code on the command line ──
console.log('\n— 2. the code is never an argument —');
{
    const before = state();
    const r = cli(['restore', '--code', code.code, sealedFile]);
    assert(r.code === 2 && r.out.includes('never taken on the command line') && !r.out.includes(code.code),
        `2. --code <code> → exit 2, refused in words, the code not echoed (exit ${r.code}: ${r.out.trim().slice(-200)})`);
    const body = code.code.trim().split(/\s+/).pop()!;
    const tries: Array<[string, string[]]> = [
        ['--code-file <code>', ['restore', '--code-file', code.code, sealedFile]],
        ['--accept-signer <code>', ['restore', '--accept-signer', code.code, sealedFile]],
        ['<code> as the file', ['restore', code.code]],
        ['the code without its BPRC number', ['restore', body]],
        ['restore-point roll-back <code>', ['restore-point', 'roll-back', code.code]],
    ];
    for (const [what, args] of tries) {
        const t = cli(args, 'yes\n');
        assert(t.code === 2 && t.out.includes('That was a recovery code; it is now in your shell history: clear it.') && !t.out.includes(body),
            `2. ${what} → exit 2, told to clear the shell history, the code not echoed (exit ${t.code}: ${t.out.trim().slice(-160)})`);
    }
    assert(state() === before, '2. nothing changed');
}

// ── 3. A sealed file this server locked, the code from a file ──
console.log('\n— 3. restore a sealed file this server locked —');
let firstPoint = '';
{
    const r = cli(['restore', '--code-file', codeFile, sealedFile]);
    assert(r.code === 0, `3. exit 0 (exit ${r.code}: ${r.out.trim().slice(-300)})`);
    const fileAt = r.stdout.indexOf('The backup:');
    const serverAt = r.stdout.indexOf('This server:');
    assert(fileAt >= 0 && serverAt > fileAt && r.stdout.includes(`community ${communityId}`) && r.stdout.includes(`locked by ${ownPeer}`)
        && r.stdout.includes(`node ${ownPeer}`) && r.stdout.indexOf('Locked by this server') > serverAt,
        "3. the file's community and signer are shown beside this server's own, before anything else is said");
    assert(!r.out.includes(code.code), '3. the code is never printed');
    assert(r.stdout.trim().endsWith(`Delete ${codeFile} now: it holds the recovery code.`) && !r.out.includes('can be read by other users'),
        '3. after a restore with --code-file: "Delete F now"; a file only its owner reads is not warned about');
    assert(hasMember('BeforeBackup') && !hasMember('AfterBackup'), '3. the backup\'s database is in place: the row planted after it is gone');
    assert(adminHash() === PW_AT_BACKUP.hash, '3. pinned signer: the bundle came back (the admin password is the one at backup time)');
    assert(sha(path.join(DATA_DIR, 'libp2p_key')) === crypto.createHash('sha256').update(nodeKeyBytes).digest('hex'), '3. the node key is this server\'s, byte for byte');
    const ps = points();
    firstPoint = ps[0] ?? '';
    assert(ps.length === 1 && /-before-restore$/.test(firstPoint) && hasMember('AfterBackup', path.join(POINTS, firstPoint, 'state.db')),
        `3. a restore point was kept first, holding the row planted after the backup (${JSON.stringify(ps)})`);
    assert(r.stdout.includes(`beanpool restore-point roll-back ${firstPoint}`), '3. the output names the point and the command that undoes it');
    assert(!fs.existsSync(path.join(DATA_DIR, 'uploaded-backup.opened.tar.gz')) && !fs.existsSync(path.join(DATA_DIR, '.restore-tmp'))
        && !fs.existsSync(path.join(DATA_DIR, '.restore-candidate')), '3. the opened plaintext and the work folders are gone');
    assert(notices().length === 1, '3. a notice is left for the next start');
    const d = delivered();
    assert(d.n === 1 && d.told[0]?.startsWith('This community was restored from a backup: This community was restored from a backup made ')
        && notices().length === 0 && delivered().n === 0, `3. the boot notice is delivered once, then gone (${d.told[0]?.slice(0, 120)})`);
}

// ── 4. A wrong code at the prompt ──
console.log('\n— 4. a wrong code typed at the prompt —');
{
    const before = state();
    const wrong = core.parseRecoveryCode(code.code).codeId !== undefined ? code.code.replace(/[A-Z2-7](?=[^A-Z2-7]*$)/, (c) => (c === 'A' ? 'B' : 'A')) : 'nope';
    const r = cli(['restore', sealedFile], `${wrong}\n`);
    assert(r.code === 1 && r.out.includes('Nothing was changed.') && /Recovery code #\d+ \(not shown as you type\)/.test(r.out),
        `4. the code is asked for at the prompt; a wrong one → exit 1 (exit ${r.code}: ${r.out.trim().slice(-200)})`);
    assert(state() === before, '4. nothing changed');
    const open = path.join(work, 'readable-code.txt');
    fs.writeFileSync(open, `${wrong}\n`, { mode: 0o644 });
    fs.chmodSync(open, 0o644);
    const w = cli(['restore', '--code-file', open, sealedFile]);
    assert(w.code === 1 && w.out.includes(`Warning: ${open} can be read by other users of this server (mode 644)`) && state() === before,
        `4. a code file others can read is warned about (exit ${w.code}: ${w.out.trim().slice(-200)})`);
}

// ── 5. restore-point list and roll-back ──
console.log('\n— 5. restore-point list, roll-back —');
{
    const l = cli(['restore-point', 'list']);
    assert(l.code === 0 && l.out.includes(firstPoint) && l.out.includes('before a restore') && /kept until at least \d{4}-\d{2}-\d{2}/.test(l.out),
        `5. list shows the point, why, and how long it is kept (exit ${l.code}: ${l.out.trim().slice(0, 200)})`);
    const before = state();
    const no = cli(['restore-point', 'roll-back', firstPoint], 'no\n');
    assert(no.code === 1 && state() === before, `5. roll-back without "yes" → exit 1, nothing changed (exit ${no.code})`);
    const r = cli(['restore-point', 'roll-back', firstPoint], 'yes\n');
    assert(r.code === 0, `5. roll-back with "yes" → exit 0 (exit ${r.code}: ${r.out.trim().slice(-300)})`);
    assert(hasMember('AfterBackup') && adminHash() === PW_LATER.hash, '5. the old state is back: the row planted after the backup, and the later password');
    const ps = points();
    const own = ps.find((n) => /-before-roll-back$/.test(n));
    assert(ps.length === 2 && !!own && hasMember('BeforeBackup', path.join(POINTS, own!, 'state.db')) && !hasMember('AfterBackup', path.join(POINTS, own!, 'state.db')),
        `5. the roll-back kept a point of its own first: the restored state (${JSON.stringify(ps)})`);
    const d = delivered();
    assert(d.n === 1 && d.told[0]?.startsWith('This community was rolled back: This community was rolled back to how it was on '),
        `5. the roll-back's notice is delivered (${d.told[0]?.slice(0, 100)})`);
}

// ── 5b. Another community's file goes by its community (before 6 gives this server another machine's key) ──
console.log('\n— 5b. another community —');
{
    const before = state();
    const accept = cli(['restore', '--code-file', codeFile, '--accept-signer', forgerPeer, otherFile]);
    assert(accept.code === 2 && accept.out.includes('--accept-signer and --with-keys are for a backup of this community locked by another machine') && state() === before,
        `5b. --accept-signer on another community's file → exit 2, never the database-only route (exit ${accept.code}: ${accept.out.trim().slice(-200)})`);
    const both = cli(['restore', '--code-file', codeFile, '--accept-signer', forgerPeer, '--with-keys', otherFile]);
    assert(both.code === 2 && state() === before, `5b. --accept-signer --with-keys on it → exit 2 (exit ${both.code})`);
    const no = cli(['restore', '--code-file', codeFile, otherFile], 'no\n');
    const serverAt = no.stdout.indexOf('This server:');
    const n = JSON.parse(people())[0].length;
    assert(no.code === 1 && no.out.includes('This backup is from a DIFFERENT community') && no.stdout.includes('opens with the phones of @Ostrander')
        && serverAt > 0 && no.stdout.indexOf(`"Riverbend Commons", ${n} members, owners @Olive`) > serverAt
        && no.stdout.includes(`replaces the community on this server ("Riverbend Commons", ${n} members, owners @Olive), and everyone in it`),
        `5b. without them: DIFFERENT, with this server's name, member count and owners beside its IDs, before "yes" (exit ${no.code}: ${no.stdout.trim().slice(-420)})`);
    assert(state() === before, '5b. "no" → nothing changed');
    // A standby: the same community's file locked by another machine names the main server it copies.
    fs.writeFileSync(path.join(DATA_DIR, 'connectors.json'), JSON.stringify([{ trustLevel: 'mirror', address: `/ip4/127.0.0.1/tcp/4001/p2p/${ownPeer}` }]));
    const standby = cli(['restore', '--code-file', codeFile, forgedFile], '', { NODE_ROLE: 'backup' });
    fs.rmSync(path.join(DATA_DIR, 'connectors.json'), { force: true });
    assert(standby.code === 1 && standby.out.includes(`locked by another machine, ${forgerPeer}, not by the main server this standby copies`) && state() === before,
        `5b. on a standby: "not by the main server this standby copies" (exit ${standby.code}: ${standby.out.trim().slice(-200)})`);
}

// ── 6. Locked by another machine ──
console.log('\n— 6. --accept-signer, --with-keys —');
{
    const keyBefore = sha(path.join(DATA_DIR, 'libp2p_key'));
    const genesisBefore = sha(path.join(DATA_DIR, 'genesis.json'));
    let before = state();
    const plainNo = cli(['restore', '--code-file', codeFile, forgedFile]);
    assert(plainNo.code === 1 && plainNo.out.includes(`beanpool restore --accept-signer ${forgerPeer} FILE`) && plainNo.out.includes(`locked by ${forgerPeer}`),
        `6. without --accept-signer → exit 1, naming the signer and the command (exit ${plainNo.code}: ${plainNo.out.trim().slice(-260)})`);
    assert(state() === before, '6. nothing changed');
    const wrongName = cli(['restore', '--code-file', codeFile, '--accept-signer', ownPeer, forgedFile]);
    assert(wrongName.code === 1 && state() === before, `6. --accept-signer naming another key → exit 1, nothing changed (exit ${wrongName.code})`);
    const keysAlone = cli(['restore', '--code-file', codeFile, '--with-keys', forgedFile]);
    assert(keysAlone.code === 2 && state() === before, `6. --with-keys without --accept-signer → exit 2 (exit ${keysAlone.code})`);

    const dbOnly = cli(['restore', '--code-file', codeFile, '--accept-signer', forgerPeer, forgedFile]);
    assert(dbOnly.code === 0 && hasMember('ForgedRow'), `6. --accept-signer → exit 0, its database is in place (exit ${dbOnly.code}: ${dbOnly.out.trim().slice(-200)})`);
    assert(sha(path.join(DATA_DIR, 'libp2p_key')) === keyBefore && sha(path.join(DATA_DIR, 'genesis.json')) === genesisBefore && adminHash() === PW_LATER.hash,
        '6. the database only: the node key, genesis and admin password are this server\'s still');
    assert(points().length === 3, '6. a restore point was kept first');

    before = state();
    const declined = cli(['restore', '--code-file', codeFile, '--accept-signer', forgerPeer, '--with-keys', forgedFile], 'no\n');
    assert(declined.code === 1 && declined.out.includes("replaces this server's keys") && state() === before,
        `6. --with-keys says what it replaces; anything but "yes" → exit 1, nothing changed (exit ${declined.code})`);
    const withKeys = cli(['restore', '--code-file', codeFile, '--accept-signer', forgerPeer, '--with-keys', forgedFile], 'yes\n');
    assert(withKeys.code === 0 && sha(path.join(DATA_DIR, 'libp2p_key')) === crypto.createHash('sha256').update(forgerKeyBytes).digest('hex')
        && adminHash() === 'other-machine-hash',
        `6. --with-keys and "yes" → exit 0, its keys and password are applied (exit ${withKeys.code}: ${withKeys.out.trim().slice(-200)})`);
    assert(points().length === 4, '6. and a restore point was kept first');
    delivered();
}

// ── 7. An old unlocked file ──
console.log('\n— 7. --unlocked —');
{
    const keyBefore = sha(path.join(DATA_DIR, 'libp2p_key'));
    const configBefore = sha(path.join(DATA_DIR, 'local-config.json'));
    const before = state();
    const noFlag = cli(['restore', plainFile]);
    assert(noFlag.code === 1 && noFlag.out.includes('beanpool restore --unlocked FILE') && state() === before,
        `7. a .tar.gz without --unlocked → exit 1, naming the command (exit ${noFlag.code}: ${noFlag.out.trim().slice(-160)})`);
    const sealedUnlocked = cli(['restore', '--unlocked', sealedFile], 'UNLOCKED\n');
    assert(sealedUnlocked.code === 1 && state() === before, `7. --unlocked with a locked file → exit 1, nothing changed (exit ${sealedUnlocked.code})`);
    const lower = cli(['restore', '--unlocked', plainFile], 'unlocked\n');
    assert(lower.code === 1 && lower.out.includes('anyone who has a copy can read') && state() === before,
        `7. it says the file can be read by anyone; anything but UNLOCKED → exit 1, nothing changed (exit ${lower.code})`);
    const r = cli(['restore', '--unlocked', plainFile], 'UNLOCKED\n');
    assert(r.code === 0 && hasMember('PlainRow') && !hasMember('ForgedRow'), `7. UNLOCKED → exit 0, its database is in place (exit ${r.code}: ${r.out.trim().slice(-200)})`);
    assert(sha(path.join(DATA_DIR, 'libp2p_key')) === keyBefore && sha(path.join(DATA_DIR, 'local-config.json')) === configBefore,
        '7. never keys: the node key and local-config.json are as they were');
    assert(points().length === 5 && notices().length === 1, '7. a restore point was kept first, and the notice left');
}

// ── 8. Exit codes ──
console.log('\n— 8. exit codes —');
{
    const before = state();
    const none = cli(['restore']);
    const unknown = cli(['restore', '--force', sealedFile]);
    const bare = cli(['restore-point']);
    const missing = cli(['restore-point', 'roll-back', '2020-01-01T00-00-00.000Z-before-restore'], 'yes\n');
    const nofile = cli(['restore', '--code-file', codeFile, path.join(work, 'no-such.bpsealed')]);
    assert(none.code === 2 && none.out.includes('Usage: beanpool restore'), `8. restore with no file → 2 and the usage (got ${none.code})`);
    assert(unknown.code === 2, `8. an unknown option → 2 (got ${unknown.code})`);
    assert(bare.code === 2 && bare.out.includes('Usage: beanpool restore-point'), `8. restore-point alone → 2 and the usage (got ${bare.code})`);
    assert(missing.code === 1 && missing.out.includes('There is no restore point'), `8. an unknown restore point → 1 (got ${missing.code})`);
    assert(nofile.code === 1, `8. a file that is not there → 1 (got ${nofile.code})`);
    assert(state() === before, '8. none of them changed anything');
}

// ── 9. The real node waits for the lock ──
console.log('\n— 9. the real node (index.ts) waits while the lock is held —');
{
    const HELD = 'data/.node-running.lock is held: a beanpool restore or another node is using this data folder';
    const started: ChildProcess[] = [];
    const freePort = () => new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
    const canListen = (port: number) => new Promise<boolean>((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
    });
    /** index.ts listens on PORT_HTTP, PORT_HTTPS, PORT_P2P and PORT_P2P + 1 (test-clean-stop's freePorts). */
    const ports = async () => {
        const http = await freePort();
        const https = await freePort();
        for (;;) {
            const p2p = await freePort();
            if (p2p < 65_000 && ![http, https].includes(p2p) && ![http, https].includes(p2p + 1) && await canListen(p2p + 1)) {
                return { PORT_HTTP: String(http), PORT_HTTPS: String(https), PORT_P2P: String(p2p) };
            }
        }
    };
    const startNode = async () => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.join(SRC, 'index.ts')], {
            env: {
                ...process.env, BEANPOOL_DATA_DIR: DATA_DIR, ...(await ports()),
                // As test-clean-stop runs it: nothing leaves this machine.
                DISABLE_UPDATE_CHECK: 'true', DIRECTORY_REGISTRY_URL: 'http://127.0.0.1:9/',
                CF_API_TOKEN: '', CF_ZONE_ID: '', CF_RECORD_NAME: '', PUBLIC_ADDRESS_AUTO: '', PUBLIC_ADDRESS_NAME: '', ADMIN_PASSWORD: '',
            } as NodeJS.ProcessEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        started.push(child);
        let out = '';
        child.stdout!.on('data', (d) => { out += d; });
        child.stderr!.on('data', (d) => { out += d; });
        const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
        /** Its output, and a line that ends any wait once it has exited. */
        const seen = () => (child.exitCode !== null || child.signalCode !== null ? `${out}\n[exited]` : out);
        return { child, out: () => out, seen, exited };
    };
    const tail = (n: { out: () => string }) => n.out().trim().split('\n').filter((l) => !/connection is not open|Deprecation|trace-deprecation/.test(l)).slice(-4).join(' | ').slice(0, 400);
    const stop = async (n: { child: ChildProcess; exited: Promise<void> }) => {
        n.child.kill('SIGTERM');
        await Promise.race([n.exited, sleep(30_000)]);
        if (n.child.exitCode === null && n.child.signalCode === null) { n.child.kill('SIGKILL'); await n.exited; }
    };
    try {
        const c = cliWaiting(['restore-point', 'roll-back', firstPoint]);
        const asked = await waitFor(c.out, 'Type yes to roll back');
        const a = await startNode();
        const waited = await waitFor(a.seen, HELD);
        await sleep(1_000);
        assert(asked && waited && !a.out().includes('BeanPool Node starting') && a.child.exitCode === null,
            `9. a node started while the command waits at "Type yes" waits, says why, and starts nothing (${tail(a)})`);
        c.answer('no\n');
        const r = await c.done;
        const live = await waitFor(a.seen, 'BeanPool Node is live', 150_000) && a.out().includes('BeanPool Node is live');
        assert(r.code === 1 && live && a.out().includes('data/.node-running.lock was let go: this node starts.'),
            `9. the command ends (exit ${r.code}) → the node starts (${tail(a)})`);

        const b = await startNode();
        const bWaited = await waitFor(b.seen, HELD);
        await sleep(1_000);
        assert(bWaited && !b.out().includes('BeanPool Node starting') && b.child.exitCode === null,
            `9. a second node on the same data folder waits while the first runs, and starts nothing (${tail(b)})`);
        await stop(a);
        const bLive = await waitFor(b.seen, 'BeanPool Node is live', 150_000) && b.out().includes('BeanPool Node is live');
        assert(bLive, `9. once the first stops, the second starts (${tail(b)})`);
        await stop(b);
    } finally {
        for (const ch of started) if (ch.exitCode === null && ch.signalCode === null) ch.kill('SIGKILL');
    }
}

// ── 10. A damaged or empty state.db ──
console.log('\n— 10. a damaged or empty state.db —');
{
    const good = path.join(work, 'state.db.good');
    fs.copyFileSync(STATE, good);
    const pointsBefore = points();
    const recipe = 'move state.db, state.db-wal and state.db-shm out of the data folder (keep them); start the node once';
    fs.writeFileSync(STATE, '');
    const z = cli(['restore', '--code-file', codeFile, sealedFile]);
    const zr = cli(['restore-point', 'roll-back', firstPoint], 'yes\n');
    assert(z.code === 1 && z.out.includes("This server's database (state.db) has no tables (it is empty)") && z.out.includes(recipe) && !z.out.includes('..'),
        `10. an empty state.db: restore refuses with what to do (exit ${z.code}: ${z.out.trim().slice(-260)})`);
    assert(zr.code === 1 && zr.out.includes('has no tables (it is empty)') && zr.out.includes(recipe), `10. and roll-back too (exit ${zr.code})`);
    const buf = fs.readFileSync(good);
    for (let off = 8 * 4096; off < Math.min(buf.length, 40 * 4096); off += 4096) buf.fill(0xa5, off, off + 4096);
    fs.writeFileSync(STATE, buf);
    const d = cli(['restore', '--code-file', codeFile, sealedFile]);
    const dr = cli(['restore-point', 'roll-back', firstPoint], 'yes\n');
    assert(d.code === 1 && d.out.includes("This server's database (state.db) is damaged (SQLITE_CORRUPT)") && d.out.includes(recipe),
        `10. a damaged state.db: restore refuses with what to do (exit ${d.code}: ${d.out.trim().slice(-260)})`);
    assert(dr.code === 1 && dr.out.includes('is damaged (SQLITE_') && dr.out.includes(recipe), `10. and roll-back too (exit ${dr.code}: ${dr.out.trim().slice(-200)})`);
    assert(JSON.stringify(points()) === JSON.stringify(pointsBefore) && sha(STATE) === crypto.createHash('sha256').update(buf).digest('hex'),
        '10. nothing changed: no restore point, the file as it was');
    fs.copyFileSync(good, STATE);
}

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${passed}/${run} passed`);
process.exit(process.exitCode ?? 0);
