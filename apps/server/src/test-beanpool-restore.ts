/**
 * `beanpool restore` and `beanpool restore-point` (design case 18 §3.5, §4, slice S3): the restore on the server itself,
 * with the node stopped, for when Settings cannot do it.
 *
 * End to end against a node data dir: the command runs as its own process, as `docker compose run` runs it, on the
 * database and files the node uses. This process plays the node: while it holds state.db open the node is running.
 *   1. While the node runs (its lock held, node-running-lock.ts, and state.db open with a write its last statement, which
 *      alone holds no lock on the file) a restore and a roll-back are refused, and nothing changes; `restore-point list`
 *      still answers, read-only.
 *      The refusal also names a restore left open and a file system without working locks (#2017 confirmation N8).
 *   1b. While the command waits at a question it holds the node's lock: a node started then would wait. The lock file
 *      removed and taken by a node that started after → at "yes" the command refuses (exit 1), and nothing changes.
 *   1c. A question nobody answers (stdin left open, as a dropped session's container keeps it): at "Type yes" and at the
 *      code, the command gives up after BEANPOOL_PROMPT_GIVE_UP_MS (30 min unless set), exit 1, and lets go of the lock (N7).
 *   1d. A node waiting for the lock names the way out on every line (docker ps, docker rm -f), and after its minute also
 *      a file system without working file locks (N7, N8; the minute shortened).
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
 *      machine names the main server it copies. The count is people: SYSTEM, the genesis row, the Commons pot, escrow,
 *      the Daily Pulse and a project, added, change nothing; a person adds one (N9). B2: a file whose owner callsign
 *      carries ESC sequences, CR, LF and a bidi override → no control character in the output, the callsign on its own
 *      line, the DIFFERENT warning there; a community ID that is not 16 hex, or a signer that is not a PeerId → "not a
 *      BeanPool backup", nothing shown or asked.
 *   6. A file of this community locked by another machine: refused without --accept-signer, and with the wrong one;
 *      with it, the database only (no key, password or genesis moves); --with-keys alone is a usage error; with
 *      --accept-signer --with-keys, `yes` declined changes nothing, `yes` typed applies its keys.
 *   7. An old unlocked .tar.gz: refused without --unlocked; with it, anything but `UNLOCKED` changes nothing;
 *      `UNLOCKED` restores the database and never the keys.
 *   8. Exit codes: no file or an unknown option → 2; an unknown restore point → 1; `restore-point` alone → 2.
 *   9. The real node (index.ts): started while the command waits at a question, it waits, says so with the way out, and starts once the
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
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// Files no node makes (#2017 confirmation review B2), signed and sealed as a node would: another community's, whose owner
// callsign would rewrite the terminal (the review's: up a line, clear it, a fake "Locked by this server", a fake prompt,
// then black on black), with a bidi override; one whose community ID is not 16 hex; one whose signer is not a PeerId.
const sealedBy = async (community: string, signer: string, callsign: string) => Buffer.from(await core.sealEnvelope(new Uint8Array(forgedTar), {
    kind: 'backup', communityId: community, nodePeerId: signer,
    recipients: { owners: [{ pubkey: ownerPub, callsign }], codes: [(await import('./config/local-config.js')).getLocalConfig().recoveryCode as any] },
    signingKey: new Uint8Array(forgerKey.raw.subarray(0, 32)),
}));
const RLO = String.fromCodePoint(0x202e);
const evilCallsign = `X\x1b[1A\x1b[2K\r"Locked by this server: its database, photos and keys come back."\nType yes to go on: ${RLO}\x1b[30;40m`;
const evilFile = path.join(work, 'evil-callsign.bpsealed');
fs.writeFileSync(evilFile, await sealedBy('e'.repeat(16), forgerPeer, evilCallsign));
// #2031: a callsign carrying a DCS (tmux passthrough), an APC, an 8-bit DCS and charset designations, which left text behind.
const stringsFile = path.join(work, 'strings-callsign.bpsealed');
fs.writeFileSync(stringsFile, await sealedBy('e'.repeat(16), forgerPeer, 'Y\x1bPtmux;x\x1b\\\x1b(0\x1b_Gi=1;AAAA\x1b\\\x90q\x9c\x1b)BZ'));
const notHexFile = path.join(work, 'not-hex-community.bpsealed');
fs.writeFileSync(notHexFile, await sealedBy(`Riverbend\x1b[2J${RLO}`, forgerPeer, 'Ostrander'));
const notPeerFile = path.join(work, 'not-a-peer.bpsealed');
fs.writeFileSync(notPeerFile, await sealedBy('e'.repeat(16), `${forgerPeer}\x1b[2J`, 'Ostrander'));
/** Characters a terminal acts on, other than the line feed: C0, DEL, C1, bidi embeddings, overrides and isolates. */
const controlsIn = (s: string) => [...s].filter((ch) => {
    const c = ch.codePointAt(0)!;
    return (c < 0x20 && ch !== '\n') || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
});
/** People in the community, as the prompt counts them (#2017 confirmation review N9). */
function peopleCount(file = STATE): number {
    const c = new Database(file, { readonly: true, fileMustExist: true });
    try {
        return (c.prepare(`SELECT COUNT(*) AS n FROM members WHERE COALESCE(status, '') != 'pruned' AND COALESCE(is_treasury, 0) = 0
            AND public_key NOT IN ('SYSTEM', 'genesis', 'COMMONS_POOL') AND public_key NOT LIKE 'escrow_%'`).get() as { n: number }).n;
    } finally { c.close(); }
}
/** The way out a waiting node names (N7), and the cause it adds after a minute (N8). */
const WAY_OUT = 'If no restore is running: docker ps shows one left open (a container named …-run-…): finish it, or end it with docker rm -f NAME.';
const NO_LOCKS = 'or this folder is on a file system without working file locks (some network shares), where BeanPool cannot run';

// After the backup: a row, and a new password. The restore must take both away; the roll-back must bring both back.
addMember('d1'.repeat(32), 'AfterBackup');
const PW_LATER = hashPassword('Changed-Later-Pw-2!');
updateLocalConfig({ adminHash: PW_LATER.hash, salt: PW_LATER.salt } as any);

// ── 1. The node is running ──
console.log('\n— 0. what a file\'s text looks like on the terminal (shown) —');
{
    // #2017 confirmation 2, N11/N12: a file's value draws no invisible characters and no padding; whole escape sequences
    // go (no "[30;40m" tail); the command's own sentences (no cap) keep their spacing.
    const { shown } = await import('./restore-command.js');
    assert(shown('@O​wner‍Ma⁠in﻿') === '@OwnerMain', '0. zero-width characters, joiners and a BOM are dropped from a file\'s value');
    assert(shown(`Locked by this server${' '.repeat(60)}x`) === 'Locked by this server x', '0. a run of spaces in a file\'s value is one space, so it cannot pad out a line of its own');
    assert(shown('aㅤㅤ⠀b') === 'a b', '0. Hangul fillers and the braille blank count as spaces');
    assert(shown('\u001b[30;40mhidden') === 'hidden' && shown('\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007') === 'link',
        '0. a CSI or OSC sequence goes whole: no visible tail');
    assert(shown('  --code-file F          read the code', null) === '  --code-file F          read the code', '0. the command\'s own aligned lines keep their spacing');
    assert(shown('\u001b[90m[2026-10-16]\u001b[0m [Restore] kept', null) === '[2026-10-16] [Restore] kept', '0. the node log\'s colours vanish whole instead of printing as text');
    // #2031 (#2017 confirmation 2, optional): DCS, SOS, PM, APC and charset designations go whole too, in their 7-bit
    // (ESC …) and 8-bit (C1) forms, where before they left "P1$r0m\", "(0" or "tmux;x" as text.
    assert(shown('a\u001bP1$r0m\u001b\\b') === 'ab' && shown('a\u0090tmux;x\u009cb') === 'ab' && shown('a\u001bPq#0;2\u0007x\u009cb') === 'ab',
        '0. a DCS (ESC P … ST, U+0090 … U+009C, a BEL inside it) goes whole');
    assert(shown('a\u001bXsos\u001b\\b\u001b^pm\u009cc\u001b_Gi=1;AAAA\u001b\\d') === 'abcd' && shown('a\u0098s\u009cb\u009ep\u009cc\u009fG\u001b\\d') === 'abcd',
        '0. SOS, PM and APC (ESC X, ESC ^, ESC _ and U+0098, U+009E, U+009F, up to ST) go whole');
    assert(shown('a\u001b(0b\u001b)Bc\u001b*<d\u001b+Ae\u001b#8f') === 'abcdef', '0. a charset designation (ESC ( ) * +, ESC # 8) goes whole: no "(0" tail');
    assert(shown('a\u009d0;title\u009cb\u009b31mc') === 'abc', '0. the 8-bit OSC and CSI go whole');
    assert(shown('@Ann\u001bPnever ended') === '@Annnever ended' && shown('@Ann\u0090q\u001b[31mx', null) === '@Annqx',
        '0. a string with no terminator loses only its opening: nothing after it is hidden, the shell\'s own words included');
    assert(shown('[Restore] trigger "x\u001bP1$r0m\u001b\\\u001b(0" kept', null) === '[Restore] trigger "x" kept', '0. in a log line, a file\'s DCS goes and the line\'s own words stay');
    // Every pattern stays linear: 128 KB of openings that never end, each kind, takes milliseconds (about 40 ms for all
    // 13). One that ran a string on over the next one's opening is quadratic: a DCS body that lets C1 in takes about 13 s
    // on one of these on Node 22, so 5 s catches it at once and still leaves a busy CI runner room (#2031 B1: the 1 MB
    // version took 2.8 s there against 2 s).
    const SIZE = 128 * 1024;
    const t0 = performance.now();
    let left = 0;
    for (const unit of ['\u001bP', '\u0090', '\u009d', '\u009b', '\u001b]', '\u001bX', '\u001b(', '\u001b\u001bP', '\u001bP\u0007', '\u0090a\u009d\u001b]b\u001bPc\u001b X']) {
        const hostile = unit.repeat(Math.ceil(SIZE / unit.length));
        left += shown(hostile).length + shown(hostile, null).length;
    }
    for (const hostile of [`\u001bP${'a'.repeat(SIZE)}`, `\u001b[${'1'.repeat(SIZE)}`, `\u001b${' '.repeat(SIZE)}`]) left += shown(hostile, null).length;
    const took = performance.now() - t0;
    assert(took < 5000 && left > 0, `0. 13 hostile inputs of 128 KB each go through shown() in under 5 s (${Math.round(took)} ms)`);
}

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
    assert(r.out.includes('another beanpool restore holds data/.node-running.lock (docker ps shows one left open, a container named …-run-…)')
        && r.out.includes(`${NO_LOCKS}. Nothing was changed.`),
        `1. …and names the other causes: a restore left open, a file system without working locks (N8) (${r.out.trim().slice(-320)})`);
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

// ── 1c. A question nobody answers: the command gives up (#2017 confirmation review N7) ──
console.log('\n— 1c. no answer: the command gives up —');
{
    const before = state();
    const giveUp = { BEANPOOL_PROMPT_GIVE_UP_MS: '2000' };
    const said = 'No answer in 2 s: this command gives up, so the node can start. Nothing was changed.';
    const ended = async (c: ReturnType<typeof cliWaiting>) => {
        const r = await Promise.race([c.done, sleep(60_000).then(() => null)]);
        if (!r) c.child.kill('SIGKILL');
        return r ?? { code: null, out: c.out() };
    };
    // At "Type yes", with stdin left open: a dropped session's container keeps its stdin.
    const y = await ended(cliWaiting(['restore', '--code-file', codeFile, '--accept-signer', forgerPeer, '--with-keys', forgedFile], giveUp));
    assert(y.code === 1 && y.out.includes('Type yes to go on') && y.out.trim().endsWith(said) && lock?.nodeRunningLockHeld(DATA_DIR) === false,
        `1c. at "Type yes": exit 1, "${said}", and the lock is let go (exit ${y.code}: ${y.out.trim().slice(-200)})`);
    // At the code, which is not echoed: "yes" typed, then nothing.
    const c = cliWaiting(['restore', otherFile], giveUp);
    const askedYes = await waitFor(c.out, 'Type yes to go on');
    c.child.stdin.write('yes\n');
    const k = await ended(c);
    assert(askedYes && k.code === 1 && k.out.includes('Recovery code #') && k.out.trim().endsWith(said) && lock?.nodeRunningLockHeld(DATA_DIR) === false,
        `1c. at the recovery code: the same (exit ${k.code}: ${k.out.trim().slice(-200)})`);
    assert(state() === before && hasMember('AfterBackup'), '1c. nothing changed');
}

// ── 1d. What a node waiting for the lock says (#2017 confirmation review N7, N8) ──
console.log('\n— 1d. the waiting line —');
{
    const c = cliWaiting(['restore', '--code-file', codeFile, '--accept-signer', forgerPeer, '--with-keys', forgedFile]);
    const asked = await waitFor(c.out, 'Type yes to go on');
    // The node's wait, with its minute shortened: index.ts runs the same function through boot-lock.ts.
    const waiter = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `const m = await import(${JSON.stringify(pathToFileURL(path.join(SRC, 'node-running-lock.ts')).href)});
         m.holdNodeRunningLock(${JSON.stringify(DATA_DIR)}, { retryMs: 50, sayEveryMs: 300, locksMayFailAfterMs: 900 });
         console.log('HOLDS IT NOW');`], { env: { ...process.env, BEANPOOL_DATA_DIR: DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let wOut = '';
    waiter.stdout!.on('data', (d) => { wOut += d; });
    waiter.stderr!.on('data', (d) => { wOut += d; });
    const wExited = new Promise<void>((resolve) => waiter.on('exit', () => resolve()));
    const late = await waitFor(() => wOut, 'where BeanPool cannot run', 60_000);
    c.answer('no\n');
    await c.done;
    const holds = await waitFor(() => wOut, 'HOLDS IT NOW', 60_000);
    await Promise.race([wExited, sleep(10_000)]);
    if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill('SIGKILL');
    const lines = wOut.split('\n').filter((l) => l.includes('is held: a beanpool restore or another node is using this data folder'));
    assert(asked && lines.length >= 2 && lines.every((l) => l.includes(WAY_OUT)),
        `1d. every waiting line names the way out: "${WAY_OUT}" (${lines.length} lines: ${lines[0]?.slice(0, 260)})`);
    assert(late && !lines[0].includes(NO_LOCKS) && lines[lines.length - 1].includes(`using this data folder, ${NO_LOCKS}. This node waits`),
        `1d. the first lines name a restore or another node; after the wait's minute, also a file system without working locks (${lines[lines.length - 1]?.slice(0, 300)})`);
    assert(holds && wOut.includes('data/.node-running.lock was let go: this node starts.'), '1d. the command ends → the waiting node holds the lock');
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
    const n = peopleCount();
    const rows = JSON.parse(people())[0].length;
    assert(no.code === 1 && no.out.includes('This backup is from a DIFFERENT community') && no.stdout.includes('opens with the phones of @Ostrander')
        && serverAt > 0 && no.stdout.indexOf(`"Riverbend Commons", ${n} members, owners @Olive`) > serverAt
        && no.stdout.includes(`replaces the community on this server ("Riverbend Commons", ${n} members, owners @Olive), and everyone in it`),
        `5b. without them: DIFFERENT, with this server's name, member count and owners beside its IDs, before "yes" (exit ${no.code}: ${no.stdout.trim().slice(-420)})`);
    assert(state() === before, '5b. "no" → nothing changed');

    // N9: the count is people. Each account that is not one, added, changes nothing; one person added counts one. The
    // node stopped and every connection closed, state.db alone is the database: put back as it was afterwards.
    const saved = path.join(work, 'state.db.before-n9');
    fs.copyFileSync(STATE, saved);
    const w = new Database(STATE);
    const added: string[] = [];
    const put = (key: string, callsign: string, treasury = 0) => {
        const r = w.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, invited_by, invite_code, is_treasury)
            VALUES (?, ?, ?, 'genesis', 'TEST', ?)`).run(key, callsign, new Date().toISOString(), treasury);
        if (r.changes) added.push(key);
    };
    const system = !!w.prepare("SELECT 1 FROM members WHERE public_key = 'SYSTEM'").get();
    put('genesis', 'Genesis Row'); put('COMMONS_POOL', 'Commons Pot'); put('escrow_n9', 'Escrow N9');
    put('a9'.repeat(32), 'Daily Pulse N9', 1); put('b9'.repeat(32), 'Village Oven', 1);
    w.close();
    const sys = cli(['restore', '--code-file', codeFile, otherFile], 'no\n');
    const w2 = new Database(STATE);
    w2.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, 'Newcomer N9', ?, 'genesis', 'TEST')`)
        .run('c9'.repeat(32), new Date().toISOString());
    added.push('c9'.repeat(32));
    w2.close();
    const one = cli(['restore', '--code-file', codeFile, otherFile], 'no\n');
    fs.copyFileSync(saved, STATE);
    for (const sidecar of ['-wal', '-shm']) fs.rmSync(STATE + sidecar, { force: true });
    assert(system && n < rows && added.length === 6 && sys.code === 1 && sys.stdout.includes(`("Riverbend Commons", ${n} members, owners @Olive)`),
        `5b. the count leaves out SYSTEM, the genesis row, the Commons pot, escrow, the Daily Pulse and a project (${n} of ${rows} rows; ${sys.stdout.match(/\(("Riverbend[^)]*)\)/)?.[1]})`);
    assert(one.code === 1 && one.stdout.includes(`("Riverbend Commons", ${n + 1} members, owners @Olive)`), `5b. one person more → ${n + 1} members`);
    assert(state() === before, '5b. those rows gone again → as before');

    // B2: a file's own text never drives the terminal, and a file no node makes is refused before anything is shown.
    const evil = cli(['restore', '--code-file', codeFile, evilFile], 'no\n');
    const out = evil.stdout.split('\n');
    const at = out.findIndex((l) => l.includes('opens with the phones of @X'));
    assert(evil.code === 1 && controlsIn(evil.out).length === 0, `5b. B2: an owner callsign with ESC sequences, CR, LF and a bidi override → no control character reaches the terminal (${JSON.stringify(controlsIn(evil.out))})`);
    assert(at > 0 && out[at + 1]?.startsWith('              locked by ') && [...out[at]].length <= '              opens with the phones of @'.length + 80
        && evil.out.includes('This backup is from a DIFFERENT community. Restoring it replaces the community on this server')
        && evil.out.includes('You did not type yes. Nothing was changed.') && state() === before,
        `5b. B2: the callsign stays on its own line, at most 80 characters, and the DIFFERENT warning is there; "no" → nothing changed (${out[at]})`);
    const strings = cli(['restore', '--code-file', codeFile, stringsFile], 'no\n');
    assert(strings.code === 1 && strings.stdout.includes('              opens with the phones of @YZ\n') && controlsIn(strings.out).length === 0 && state() === before,
        `5b. #2031: a callsign with a DCS, an APC, an 8-bit DCS and charset designations prints as @YZ, with no tail of them (${strings.stdout.match(/opens with the phones of [^\n]*/)?.[0]})`);
    for (const [what, file] of [['a community ID that is not 16 hex', notHexFile], ['a signer that is not a PeerId', notPeerFile]] as const) {
        const r = cli(['restore', '--code-file', codeFile, file], 'yes\n');
        assert(r.code === 1 && r.out.includes('This is not a BeanPool backup file (.bpsealed)') && !r.out.includes('Type yes')
            && !r.out.includes('The backup:') && controlsIn(r.out).length === 0 && state() === before,
            `5b. B2: ${what} → "not a BeanPool backup", nothing shown or asked, nothing changed (exit ${r.code}: ${r.out.trim().slice(-200)})`);
    }
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
        assert(asked && waited && !a.out().includes('BeanPool Node starting') && a.child.exitCode === null && a.out().includes(WAY_OUT),
            `9. a node started while the command waits at "Type yes" waits, says why and the way out, and starts nothing (${tail(a)})`);
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
