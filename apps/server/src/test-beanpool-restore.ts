/**
 * `beanpool restore` and `beanpool restore-point` (design case 18 §3.5, §4, slice S3): the restore on the server itself,
 * with the node stopped, for when Settings cannot do it.
 *
 * End to end against a node data dir: the command runs as its own process, as `docker compose run` runs it, on the
 * database and files the node uses. This process plays the node: while it holds state.db open the node is running.
 *   1. While the node runs (its lock held, node-running-lock.ts, and state.db open with a write its last statement, which
 *      alone holds no lock on the file) a restore and a roll-back are refused, and nothing changes; `restore-point list`
 *      still answers, read-only.
 *   2. A recovery code is never taken on the command line (exit 2, never echoed).
 *   3. A sealed file this server locked, with the code from --code-file: before anything is asked the output shows the
 *      file's community and signer beside this server's own; the database comes back (a row planted after the backup
 *      is gone), the keys and password come back (pinned signer), a restore point holds the row planted after the
 *      backup, the opened plaintext is not left behind, the code is never printed. The notice is delivered once.
 *   4. A wrong code typed at the prompt is refused, and nothing changes.
 *   5. `restore-point list` shows the point; `roll-back` asks for `yes`, then brings the old state back (the row and
 *      the password), keeps a point of its own first, and leaves the notice.
 *   6. A file of this community locked by another machine: refused without --accept-signer, and with the wrong one;
 *      with it, the database only (no key, password or genesis moves); --with-keys alone is a usage error; with
 *      --accept-signer --with-keys, `yes` declined changes nothing, `yes` typed applies its keys.
 *   7. An old unlocked .tar.gz: refused without --unlocked; with it, anything but `UNLOCKED` changes nothing;
 *      `UNLOCKED` restores the database and never the keys.
 *   8. Exit codes: no file or an unknown option → 2; an unknown restore point → 1; `restore-point` alone → 2.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-beanpool-restore.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
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

function cli(args: string[], input = '') {
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(SRC, 'recover-cli.ts'), ...args], {
        env: { ...process.env, BEANPOOL_DATA_DIR: DATA_DIR }, encoding: 'utf8', timeout: 120_000, input,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout ?? '' };
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
updateLocalConfig({ adminHash: PW_AT_BACKUP.hash, salt: PW_AT_BACKUP.salt } as any);

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

// ── 2. Never a code on the command line ──
console.log('\n— 2. the code is never an argument —');
{
    const before = state();
    const r = cli(['restore', '--code', code.code, sealedFile]);
    assert(r.code === 2 && r.out.includes('never taken on the command line') && !r.out.includes(code.code),
        `2. --code <code> → exit 2, refused in words, the code not echoed (exit ${r.code}: ${r.out.trim().slice(-200)})`);
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

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${passed}/${run} passed`);
process.exit(process.exitCode ?? 0);
