/**
 * `beanpool restore` (design case 18 §3.5 and §4, slice S3): the restore on the server itself, with the node STOPPED.
 *
 *   beanpool restore [--code-file F] [--accept-signer <PeerId>] [--with-keys] FILE.bpsealed
 *   beanpool restore --unlocked FILE.tar.gz
 *
 * For when Settings cannot do it: the interface is gone (a hostile restore can bring back another admin password and
 * other owners), a backup was locked by this community's previous server (a key loss), a backup is of another
 * community and people have already joined this one, or an old file was never locked. Whoever runs it holds the data
 * folder already, which is a stronger position than any session: it hands over nothing the shell did not have.
 *
 * It is the restore Settings runs (routes/backup.ts restoreFromTar): the hostile-archive checks, a restore point of this
 * server first (services/restore-points.ts; no room, no restore), the database, the images, node_config.json, the keys
 * when they come, and the notice everyone sees at the next start. What it adds is who decides:
 *
 *   - The signer pinned (this server's own key, or a standby's main server): the code is the proof; keys come back.
 *   - This community's file locked by another machine: refused unless `--accept-signer` names that machine. Then the
 *     database only; `--with-keys` brings the keys too, after the owner reads what they replace and types `yes`.
 *   - No pin here at all (another community's file, or this server cannot read its own record): the backup's community
 *     replaces this one, keys too, after `yes`.
 *   - `--unlocked`: an old plain file, database and images only, never keys, after `UNLOCKED` typed.
 *
 * Before it asks for anything it shows the file's community and signer beside this server's own: a file's code and
 * owner stanzas are whoever sealed it, so "it opened" proves nothing about this community (#2002 review point 5).
 *
 * The code comes from `--code-file` or is typed at the prompt (not echoed on a terminal); never from the command line,
 * where the shell's history and the process list keep it, and it is never printed or logged. The phone unlock is not
 * offered here: it needs the running server.
 *
 * The node must be stopped: a running node holds state.db, and the restore replaces it. The check ({@link stoppedNodeCheck})
 * takes the node's own lock, data/.node-running.lock, and keeps it until this command ends: a node started while it asks
 * its questions waits for it (node-running-lock.ts), and just before anything is replaced the command checks the lock is
 * still its own. Then state.db alone, with an exclusive lock and no wait, for a node of an older version that holds no
 * lock; and that state.db opens and has its tables (a damaged one is refused with what to do). Only after all that does
 * this process load the node's modules, which open the database as the node does.
 *
 * Exit codes: 0 restored, 1 refused (nothing was changed), 2 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseRecoveryCode } from '@beanpool/core';
import { dataDir } from './recover-command.js';
import { listRestorePoints } from './services/restore-point-names.js';
import {
    NODE_RUNNING_LOCK, NODE_RUNNING_LOCK_SHOWN, nodeRunningLockHeld, nodeRunningLockStillOurs, releaseNodeRunningLock,
    tryHoldNodeRunningLock,
} from './node-running-lock.js';
import type { Ask } from './shell-prompt.js';

export const RESTORE_USAGE = `Usage: beanpool restore [--code-file F] [--accept-signer <PeerId>] [--with-keys] FILE.bpsealed
       beanpool restore --unlocked FILE.tar.gz

Restores a backup onto this server, with the node stopped. Put the file in the data folder first, then:
  docker compose stop beanpool-node
  docker compose run --rm beanpool-node beanpool restore /data/FILE.bpsealed
  docker compose up -d
A restore point of this server is kept first; \`beanpool restore-point\` rolls back to it.

  --code-file F          read the recovery code from file F (otherwise it is asked for; never on the command line)
  --accept-signer <id>   restore a backup of this community locked by another machine: the database only
  --with-keys            with --accept-signer: bring back that file's keys, password and 2FA too (asks you to type yes)
  --unlocked             an old backup that is not locked (.tar.gz): database and photos only, never keys`;

export const RESTORE_EXIT = { done: 0, refused: 1, usage: 2 } as const;

export interface ShellIo {
    ask: Ask;
    out: (line: string) => void;
    err: (line: string) => void;
}

type RestoreArgs = { file: string; codeFile?: string; acceptSigner?: string; withKeys: boolean; unlocked: boolean };

/** An argument that is a recovery code, typed where a file, a name or a key goes (#2017 review N4): never echoed back. */
export const CODE_IN_ARGS = 'That was a recovery code; it is now in your shell history: clear it. A code is never taken on the '
    + 'command line: give it with --code-file F, or type it when asked. Nothing was changed.';

export function codeInArgs(args: string[]): boolean {
    return args.some((a) => {
        try {
            parseRecoveryCode(a.replace(/^--[a-z-]+=/, ''));
            return true;
        } catch {
            return false;
        }
    });
}

function parseRestoreArgs(args: string[]): RestoreArgs | { usage: string } {
    const out: RestoreArgs = { file: '', withKeys: false, unlocked: false };
    if (codeInArgs(args)) return { usage: CODE_IN_ARGS };
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--code' || a.startsWith('--code=') || a === '--recovery-code' || a.startsWith('--recovery-code=')) {
            return { usage: 'A recovery code is never taken on the command line: the shell\'s history and the process list would keep it. '
                + 'Use --code-file F, or type it when asked. Nothing was changed.' };
        }
        if (a === '--code-file' || a === '--accept-signer') {
            const v = args[++i];
            if (!v || v.startsWith('--')) return { usage: `${a} needs a value.\n\n${RESTORE_USAGE}` };
            if (a === '--code-file') out.codeFile = v; else out.acceptSigner = v;
        } else if (a === '--with-keys') out.withKeys = true;
        else if (a === '--unlocked') out.unlocked = true;
        else if (a.startsWith('-')) return { usage: `Unknown option ${a}.\n\n${RESTORE_USAGE}` };
        else files.push(a);
    }
    if (files.length !== 1) return { usage: RESTORE_USAGE };
    if (out.withKeys && !out.acceptSigner) {
        return { usage: '--with-keys goes with --accept-signer: a file this server already trusts brings its keys anyway. Nothing was changed.' };
    }
    if (out.unlocked && (out.acceptSigner || out.withKeys || out.codeFile)) {
        return { usage: '--unlocked takes no code, signer or keys: an unlocked file brings the database and photos only. Nothing was changed.' };
    }
    out.file = files[0];
    return out;
}

/**
 * Is a node using this database? First the lock the node holds for its whole life (node-running-lock.ts). Then state.db
 * itself: a node that has read it holds a shared lock there (WAL), and an exclusive lock taken with no wait fails; on its
 * own this misses a node whose last statement was a write, which is why the node's lock comes first. Opened alone, never
 * through db/db.ts. Closing it folds any -wal a stopped node left into state.db.
 */
export function nodeIsRunning(dbPath: string): boolean {
    return nodeRunningLockHeld(path.dirname(dbPath)) || stateDbHeld(dbPath);
}

/** state.db held by a node: what a node of a version before the lock leaves to go by. */
function stateDbHeld(dbPath: string): boolean {
    const conn = new Database(dbPath, { fileMustExist: true });
    try {
        conn.pragma('busy_timeout = 0');
        conn.pragma('locking_mode = EXCLUSIVE');
        conn.exec('BEGIN EXCLUSIVE');
        conn.exec('COMMIT');
        return false;
    } catch (e: any) {
        if (e?.code === 'SQLITE_BUSY' || e?.code === 'SQLITE_LOCKED') return true;
        throw e;
    } finally {
        conn.close();
    }
}

export const NODE_RUNNING = 'The node is running: it holds the database this would replace. Stop it first '
    + '(docker compose stop beanpool-node), then run this with docker compose run --rm beanpool-node beanpool …. Nothing was changed.';

/** Said just before anything is replaced, when the lock this command took is no longer its own. */
export const LOCK_LOST = `${NODE_RUNNING_LOCK_SHOWN} was removed or replaced while this command waited, so a node may have `
    + 'started on this data folder. Stop it (docker compose stop beanpool-node), then run this again. Nothing was changed.';

/**
 * A state.db neither command can work on: they load the node's modules, which open it, and keep a restore point of it
 * first (#2017 review N1). What to do, since Settings cannot open it either.
 */
export function brokenDatabaseRefusal(what: string): string {
    return `This server's database (state.db) ${what}, so nothing can be restored onto it as it is. Stop the node; move `
        + 'state.db, state.db-wal and state.db-shm out of the data folder (keep them); start the node once (docker compose up -d) '
        + 'so it makes a fresh database; stop it again (docker compose stop beanpool-node); then run this again. Nothing was changed.';
}

const DAMAGED = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB']);

/** The refusal for an error that came from this server's own state.db being damaged; null for any other. */
export function damagedDatabase(e: any): string | null {
    return DAMAGED.has(e?.code) ? brokenDatabaseRefusal(`is damaged (${e.code})`) : null;
}

/** Does state.db open, and does it have the node's tables? One made empty (zero bytes) has none. */
function unusableDatabase(dbPath: string): string | null {
    let conn: Database.Database | null = null;
    try {
        conn = new Database(dbPath, { fileMustExist: true });
        conn.pragma('busy_timeout = 0');
        const members = conn.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'members'").get() as { n: number };
        if (!members.n) return brokenDatabaseRefusal('has no tables (it is empty)');
        conn.prepare('SELECT COUNT(*) FROM members').get();
        return null;
    } catch (e: any) {
        return damagedDatabase(e) ?? `The node's database could not be opened (${e?.code || e?.message || e}). Nothing was changed.`;
    } finally {
        conn?.close();
    }
}

/**
 * The checks every command that replaces the database makes first. A reason when it must not go on; null when it may,
 * and then this process holds the node's lock until it ends (#2017 review B1): BUSY taking it is a node running.
 */
export function stoppedNodeCheck(dir = dataDir()): string | null {
    const dbPath = path.join(dir, 'state.db');
    if (!fs.existsSync(dbPath)) return `No node database at ${dbPath}. Run this in the node's container, or set BEANPOOL_DATA_DIR. Nothing was changed.`;
    const lock = tryHoldNodeRunningLock(dir);
    if (!lock.held && lock.busy) return NODE_RUNNING;
    const refuse = (why: string): string => {
        releaseNodeRunningLock();
        return why;
    };
    try {
        if (stateDbHeld(dbPath)) return refuse(NODE_RUNNING);
    } catch (e: any) {
        return refuse(damagedDatabase(e) ?? `The node's database could not be opened (${e?.code || e?.message || e}). Nothing was changed.`);
    }
    if (!lock.held) {
        return refuse(`${NODE_RUNNING_LOCK_SHOWN} cannot be taken (${lock.code}), so a node started while this runs would not `
            + `wait for it. With the node stopped, move it aside (mv ${path.join(dir, NODE_RUNNING_LOCK)} ${path.join(dir, NODE_RUNNING_LOCK)}.aside) `
            + 'and run this again. Nothing was changed.');
    }
    const unusable = unusableDatabase(dbPath);
    if (unusable) return refuse(unusable);
    return null;
}

/** An error's message as a sentence, without the "Nothing was changed." the refusal adds (#2017 review N5). */
export function reason(e: any): string {
    let m = String(e?.message || e).trim().replace(/\s*Nothing was changed\.$/, '');
    if (!/[.!?]$/.test(m)) m += '.';
    return m;
}

function day(iso: string | null | undefined): string {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'an unknown date';
}

/** What the restore said, for the owner at the terminal. */
function tellResult(io: ShellIo, body: Record<string, any>, keysExpected: boolean): void {
    io.out('');
    io.out(body.backup?.createdAt ? `Restored the backup made ${day(body.backup.createdAt)}.` : 'Restored the backup.');
    const keys: string[] = Array.isArray(body.keysWritten) ? body.keysWritten : [];
    if (keys.length) io.out(`Its keys came back: ${keys.join(', ')}.`);
    else if (keysExpected) io.out('The file carried no keys: this server keeps its own.');
    else io.out('The database only: this server keeps its own keys, password and 2FA.');
    io.out(body.complete ? 'Every photo and attachment the database names is here.' : (body.warning || 'Some photos or attachments may be missing.'));
    if (body.recoverySeal?.message) io.out(body.recoverySeal.message);
    if (body.openDoor?.message) io.out(body.openDoor.message);
    if (body.restorePoint?.name) {
        io.out(`Restore point ${body.restorePoint.name} is kept until at least ${String(body.restorePoint.keptAtLeastUntil).slice(0, 10)}. `
            + `To undo this restore: beanpool restore-point roll-back ${body.restorePoint.name}`);
    }
    io.out('Start the node: docker compose up -d. Everyone sees a notice that the community was restored; sign in again.');
}

export async function runRestore(args: string[], io: ShellIo, dir = dataDir()): Promise<number> {
    const parsed = parseRestoreArgs(args);
    if ('usage' in parsed) {
        io.err(parsed.usage);
        return RESTORE_EXIT.usage;
    }
    const refuse = (why: string): number => {
        io.err(why.endsWith('Nothing was changed.') ? why : `${why} Nothing was changed.`);
        return RESTORE_EXIT.refused;
    };
    const file = path.resolve(parsed.file);
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return refuse(`There is no file ${file}. Put the backup in the data folder (/data in the container).`); }
    if (!stat.isFile()) return refuse(`${file} is not a file.`);
    const stopped = stoppedNodeCheck(dir);
    if (stopped) return refuse(stopped);

    // Only now the node's own modules: they open state.db as the node does at its start, which is safe with it stopped.
    let sealed: typeof import('./services/sealed-backup.js');
    let backup: typeof import('./routes/backup.js');
    let RestorePointError: typeof import('./services/restore-points.js').RestorePointError;
    let core: typeof import('@beanpool/core');
    let readNodeIdentity: typeof import('./services/takeover-envelope.js').readNodeIdentity;
    let getNodeRole: typeof import('./config/node-role.js').getNodeRole;
    let thisCommunity: () => string;
    try {
        sealed = await import('./services/sealed-backup.js');
        backup = await import('./routes/backup.js');
        ({ RestorePointError } = await import('./services/restore-points.js'));
        core = await import('@beanpool/core');
        ({ readNodeIdentity } = await import('./services/takeover-envelope.js'));
        ({ getNodeRole } = await import('./config/node-role.js'));
        const { db } = await import('./db/db.js');
        const { getLocalConfig } = await import('./config/local-config.js');
        thisCommunity = () => describeCommunity(db, getLocalConfig().communityName);
    } catch (e: any) {
        const broken = damagedDatabase(e);
        if (broken) return refuse(broken);
        throw e;
    }

    const ownCommunity = sealed.ownCommunityId();
    let ownPeer: string | null = null;
    try { ownPeer = readNodeIdentity()?.peerId ?? null; } catch { ownPeer = null; }
    /** This server beside the file; with `people`, who is in its community (the file is of another one, #2017 review N3). */
    const thisServer = (people = false): string[] => [
        `This server:  community ${ownCommunity ?? '(its genesis.json cannot be read)'}`,
        ...(people ? [`              ${thisCommunity()}`] : []),
        `              node ${ownPeer ?? '(its node key cannot be read)'}`,
    ];

    const run = async (tarPath: string, header: any, applyKeys: boolean): Promise<number> => {
        // Right before anything is replaced: the lock this command took is still its own, so no node has started (B1).
        if (!nodeRunningLockStillOurs(dir)) {
            backup.cleanupRestoreTemp();
            return refuse(LOCK_LOST);
        }
        const before = new Set(listRestorePoints().map((p) => p.name));
        try {
            const body = await backup.restoreFromTar(tarPath, header, null, { applyKeys });
            tellResult(io, body, applyKeys);
            return RESTORE_EXIT.done;
        } catch (e: any) {
            backup.cleanupRestoreTemp();
            if (e instanceof RestorePointError) return refuse(damagedDatabase(e) ?? e.message);
            // Every check comes before the point; a failure after it may have replaced part of the server.
            const taken = listRestorePoints().find((p) => !before.has(p.name));
            if (taken) {
                io.err(`The restore stopped part way: ${e?.message || e}. Restore point ${taken.name} kept this server as it was `
                    + `just before; to go back to it: beanpool restore-point roll-back ${taken.name}`);
                return RESTORE_EXIT.refused;
            }
            return refuse(`Nothing was restored: ${reason(e)}`);
        }
    };

    // ── An old unlocked file ──
    const isGzip = sealed.isGzip(sealed.readFileStart(file, 2));
    if (parsed.unlocked) {
        if (!isGzip) return refuse('This file is not an unlocked backup (.tar.gz). A locked backup (.bpsealed) restores without --unlocked.');
        io.out(`The backup:   ${path.basename(file)}, NOT locked`);
        for (const l of thisServer()) io.out(l);
        io.out('');
        io.out('This file is not locked: anyone who has a copy can read every member\'s data in it. It brings back the database and '
            + 'photos only, never keys, the admin password or 2FA. Everything on this server since the backup was made goes; a '
            + 'restore point of this server is kept first.');
        const typed = await io.ask('Type UNLOCKED to restore it: ');
        if ((typed ?? '').trim() !== 'UNLOCKED') return refuse('You did not type UNLOCKED.');
        return run(file, null, false);
    }
    if (isGzip) {
        return refuse('This backup is not locked (.tar.gz). Restore it with: beanpool restore --unlocked FILE (the database and photos only).');
    }

    // ── A sealed file: who locked it, beside who this server is ──
    let header: any;
    try {
        header = sealed.readSealedFileHeader(file);
    } catch {
        return refuse('This is not a BeanPool backup file (.bpsealed).');
    }
    if (header.kind !== 'backup') return refuse('This sealed file is a take-over envelope, not a backup.');
    const signer = sealed.signerCheck(header);
    if (!signer.ok && signer.body.badSignature) return refuse('This backup file has been altered: its signature does not match the server it names.');
    const pins = sealed.restorePins(header);
    const pinned = pins.includes(header.nodePeerId);
    // Another community's file goes by its community, not by the pins (#2017 review N2): only a pin here vouches for one (a
    // standby whose genesis is still its own, and the main server it copies). It never takes the database-only route.
    const otherCommunity = !pinned && ownCommunity !== null && header.communityId !== ownCommunity;
    const standby = getNodeRole() === 'backup';

    io.out(`The backup:   ${path.basename(file)}, made ${day(header.createdAt)}`);
    io.out(`              community ${header.communityId}`);
    const fileOwners = sealed.describeSealedHeader(header).owners;
    if (otherCommunity && fileOwners.length) io.out(`              opens with the phones of ${fileOwners.map((c) => '@' + c).join(', ')}`);
    io.out(`              locked by ${header.nodePeerId}`);
    for (const l of thisServer(otherCommunity)) io.out(l);
    io.out('');

    if (otherCommunity && (parsed.acceptSigner || parsed.withKeys)) {
        io.err('--accept-signer and --with-keys are for a backup of this community locked by another machine. This file is of '
            + 'another community: run again without them, and you are asked to confirm. Nothing was changed.');
        return RESTORE_EXIT.usage;
    }
    if (parsed.acceptSigner && parsed.acceptSigner !== header.nodePeerId) {
        return refuse(`This file was locked by ${header.nodePeerId}, not by ${parsed.acceptSigner}.`);
    }
    let applyKeys: boolean;
    let askYes: string | null = null;
    const replaces = 'its node key, community key, genesis.json and connectors.json, the key that opens members\' sign-in '
        + 'recovery copies, the open door\'s key, and the admin password, 2FA and recovery-code record; and its owners come '
        + 'with its database';
    if (otherCommunity) {
        applyKeys = true;
        askYes = `This backup is from a DIFFERENT community. Restoring it replaces the community on this server (${thisCommunity()}), `
            + `and everyone in it, with the backup's, and replaces this server's keys: ${replaces}.`;
    } else if (pinned) {
        io.out(header.nodePeerId === ownPeer
            ? 'Locked by this server: its database, photos and keys come back.'
            : 'Locked by the main server this standby copies: its database, photos and keys come back.');
        applyKeys = true;
    } else if (pins.length > 0) {
        if (!parsed.acceptSigner) {
            return refuse(`This backup of your community was locked by another machine, ${header.nodePeerId}, `
                + (standby ? 'not by the main server this standby copies. If this file was locked by the main server\'s previous '
                    + 'machine, run again with ' : 'not by this community\'s server. If this file was locked by this community\'s '
                    + 'previous server, run again with ')
                + `beanpool restore --accept-signer ${header.nodePeerId} FILE (the database only), and add --with-keys to bring `
                + 'back its keys too. Otherwise do not restore it: anyone who has seen one of your backup files can make one like it.');
        }
        applyKeys = parsed.withKeys;
        if (applyKeys) askYes = `Locked by another machine, which you accepted. With --with-keys this file replaces this server's keys: ${replaces}.`;
        else io.out('Locked by another machine, which you accepted: the database and photos only. This server keeps its own keys, password and 2FA.');
    } else {
        applyKeys = true;
        askYes = 'This server cannot read its own community record or node key, so nothing here vouches for this file. '
            + `Restoring it puts the backup's community and keys in place: ${replaces}.`;
    }
    if (askYes) {
        io.out(askYes);
        const typed = await io.ask('Type yes to go on: ');
        if ((typed ?? '').trim() !== 'yes') return refuse('You did not type yes.');
    }

    // ── The code: a file or the prompt; never argv, never printed ──
    const stanzas = header.recipients.filter((r: any) => r.type === 'code');
    if (!stanzas.length) return refuse('This backup is not locked to any recovery code, and the shell cannot open it with a phone.');
    const needed = stanzas.map((c: any) => `#${c.codeId}`).join(' or ');
    let code: string | null;
    if (parsed.codeFile) {
        try {
            const mode = fs.statSync(parsed.codeFile).mode & 0o777;
            code = fs.readFileSync(parsed.codeFile, 'utf-8').trim();
            if (mode & 0o077) {
                io.err(`Warning: ${parsed.codeFile} can be read by other users of this server (mode ${mode.toString(8)}), and it holds `
                    + 'the recovery code. Delete it once this is done.');
            }
        } catch {
            return refuse(`The code file ${parsed.codeFile} cannot be read.`);
        }
    } else {
        code = (await io.ask(`Recovery code ${needed} (not shown as you type): `, { secret: true }))?.trim() ?? null;
    }
    if (!code) return refuse('No recovery code was given.');
    let codeId: number | undefined;
    try {
        codeId = core.parseRecoveryCode(code).codeId;
    } catch (e: any) {
        return refuse(e instanceof core.RecoveryCodeError ? e.message : 'That is not a recovery code: check what you typed.');
    }
    const stanza = codeId !== undefined ? stanzas.find((c: any) => c.codeId === codeId) : stanzas.length === 1 ? stanzas[0] : undefined;
    if (!stanza) {
        return refuse(codeId !== undefined
            ? `This backup needs recovery code ${needed}; the code given is #${codeId}.`
            : `This backup takes recovery code ${needed}. Give it with its BPRC number.`);
    }
    let matches = false;
    try {
        const { codeId: id, codePub, salt, N, r, p, createdAt } = stanza;
        matches = await core.checkRecoveryCode(code, { codeId: id, codePub, salt, N, r, p, createdAt });
    } catch {
        matches = false;
    }
    if (!matches) return refuse(`That is not recovery code #${stanza.codeId}.`);

    const { openedTarPath } = backup.restorePaths();
    try {
        await sealed.openSealedFileTo(file, { type: 'code', code }, openedTarPath);
    } catch (e: any) {
        backup.cleanupRestoreTemp();
        return refuse(e instanceof core.SealedEnvelopeError ? 'The backup file did not open: it has been altered or cut short.' : `The backup file did not open: ${e?.message || e}.`);
    } finally {
        code = null;
    }
    const done = await run(openedTarPath, header, applyKeys);
    if (done === RESTORE_EXIT.done && parsed.codeFile) io.out(`Delete ${parsed.codeFile} now: it holds the recovery code.`);
    return done;
}

/** This server's community as people know it, read here: its name, how many are in it, and its owners (#2017 review N3). */
function describeCommunity(db: Database.Database, name: string | null | undefined): string {
    let members = '? members';
    let owners = '';
    try {
        const n = (db.prepare("SELECT COUNT(*) AS c FROM members WHERE COALESCE(status, '') != 'pruned'").get() as { c: number }).c;
        members = `${n} ${n === 1 ? 'member' : 'members'}`;
    } catch { /* said as unknown */ }
    try {
        const rows = db.prepare(`SELECT m.callsign FROM node_roles r JOIN members m ON m.public_key = r.member_pubkey
            WHERE r.role = 'owner' ORDER BY m.callsign`).all() as Array<{ callsign: string }>;
        owners = rows.length ? `, owners ${rows.map((r) => '@' + r.callsign).join(', ')}` : ', no owners';
    } catch { /* left out */ }
    return `${name ? `"${name}"` : 'not named'}, ${members}${owners}`;
}
