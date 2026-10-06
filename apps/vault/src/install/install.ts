import crypto from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_NAME_RE, backupsPastBudget, latestBackupName, RESTORE_PENDING_NAME } from '../shared/backup-format.js';
import { PARTITION_MAX_BYTES, UKI_MAX_BYTES } from '../shared/release-feed.js';
import { compareVersions, resolveChain, type ReleaseFiles, type TrustedRelease } from '../shared/release.js';
import { checkRestartRequest, RESTART_CLOCK_MARGIN_MS, RESTART_REQUEST_MAX_AGE_MS, RESTART_REQUEST_MAX_BYTES } from '../shared/restart-request.js';
import { SETTINGS_FILE_NAME, SETTINGS_MAX_BYTES } from '../shared/settings.js';
import { freeBytes, isNoRoom, mib, STAGED_RELEASE_MAX_BYTES, stagedNames, veritysetupVerify, type InstallRecord, type VerifyRoot } from '../shared/staged-image.js';

/**
 * The custodians' restart's install step (key vault design §3; D3 as changed on 2026-10-06: nothing restarts the vault
 * on a schedule), run as root by usr/lib/beanpool-vault/custodian-restart when the API leaves a restart request
 * (beanpool-vault-restart.path). On the image only installForRestart runs: it reads and removes the request, then makes
 * every check below, and the request's own (two signatures from the running release's custodians, fresh, never acted
 * on before, naming exactly the staged release: shared/restart-request.ts), on root's copies, all BEFORE it stops
 * anything. A request that fails any of them changes nothing: the API keeps running, nothing is removed, no restart.
 * Only then does it go on as installStaged does (stop the API, clear what its user left, install). The API stages a new image into an inbox it owns (updater.ts); what it put there decides nothing. This step walks the
 * chain of releases from the genesis keys it was built with (scripts/bundle.mjs, as the launcher is) and, on root's
 * own copies of the files, checks:
 *
 *   1. the staged boot file's release is in that chain: two valid custodian signatures, from the keys that sign it;
 *   2. it is newer than the release this machine runs (the newest one naming the image that booted), so a new image;
 *   3. every file name carries that release's version (and the partitions' names the halves of its root hash);
 *   4. the UKI's SHA-256 is the release's `image.ukiSha256`;
 *   5. `veritysetup verify` passes for the system partition, its verity tree and the release's `roothash`.
 *
 * Only then are the files moved into the transfer source systemd-sysupdate reads (root's alone), and systemd-sysupdate
 * installs them into the other slot. Anything that fails is logged, nothing is installed, and the inbox is emptied
 * either way (the API stages again). The API's user can write neither the transfer source nor root's scratch space.
 * Before its copies, it checks the state partition has room for them (with some to spare), and says so plainly if not.
 * What it did goes into `resultFile` too, for the API's `/v1/report` after the restart.
 *
 * The inbox belongs to the API's user, who may be hostile: entries are opened without following links, only regular
 * files are read, sizes are capped, and every check runs on root's copy (made first).
 *
 * Before any of it, the API is stopped (`stopApi`: the machine restarts next anyway), so no process of its user can
 * race what root does in that user's directories. Then everything that user may have left on the state partition goes
 * (a compromised API could otherwise fill it, and deny every later update, until a reinstall): `releasesDir` is
 * emptied (the launcher starts the image's own API after the restart, and the API downloads a release's bundle
 * again), `backups/` keeps only backups (regular files under a backup name) within the budget, by the API's own rule
 * (backupsPastBudget): each costs its length or its blocks, whichever is more (so preallocated blocks count); none
 * costing more than the budget stays, the newest included (the API never writes one); then the newest and older ones
 * while they fit together, and no more than MAX_BACKUP_FILES of them (so empty files can't use up the inodes). A backup
 * named more than a day later than now goes too, as the API's rotation removes it (a day, so a clock that timesyncd set
 * back never costs the newest backup: ROOT_CLOCK_MARGIN_MS).
 * `restore/` is emptied unless the keyholder's marker says a restore from backup is pending (only a restore a fresh keyholder accepts
 * makes one): then its file and its partial file stay, whatever their size (the API finishes the restore
 * from either after the unlock, and nothing else could). `settings/` keeps only the custodians' settings file (a
 * regular file within SETTINGS_MAX_BYTES). The inbox keeps nothing but the regular files a staged image
 * is made of (a directory named like a boot file among them). The API's private /var/tmp
 * goes with its unit's stop. If the API can't be stopped, its directories are left as they are, root only unlinks the
 * inbox's files (never walking into a directory there), and the journal and the record say so.
 */

export interface InstallOptions {
    /** The API's inbox (`stagedDir`). */
    inbox: string;
    /** Where systemd-sysupdate reads a new image from (usr/lib/sysupdate.d): root's alone. */
    transferDir: string;
    /** Root's scratch space for its copies, on the same file system as `transferDir`. */
    workDir: string;
    /** The pinned genesis custodian keys. */
    rootKeys: readonly string[];
    /** The image this machine booted (image-identity.ts), or null when unknown. */
    runningImage: () => string | null;
    verifyRoot?: VerifyRoot;
    /** systemd-sysupdate, once the files are in `transferDir`: true when it installed them. */
    sysupdate: () => boolean;
    log?: (line: string) => void;
    /** Where what it did is left for the API's report (INSTALL_RESULT_FILE on the image). */
    resultFile?: string;
    /** Bytes root may still write where `workDir` is (default: the file system's free blocks, reserved ones included). */
    freeBytes?: (dir: string) => number;
    clock?: () => number;
    /**
     * Stops the API (its unit) and says whether no process of its user runs any more: only then is anything of that
     * user's walked into or removed whole. Without it, nothing is.
     */
    stopApi?: () => boolean;
    /** The API's other directories on the state partition, and its local backups' budget (the image's api.json). */
    apiDirs?: ApiDirs;
}

export interface ApiDirs {
    releases: string;
    backups: string;
    restore: string;
    backupMaxBytes: number;
    /** The keyholder's marker of a pending restore from backup (RESTORE_MARKER_NAME in its stateDir): root reads it. */
    restoreMarker: string;
    /**
     * Where the API keeps the custodians' settings (the directory of api.json's settingsFile): only the settings file
     * stays, a regular file no larger than SETTINGS_MAX_BYTES; anything else goes.
     */
    settings?: string;
}

/** What root's copies leave free at least, for the journal and the vault's own files. */
export const INSTALL_SPARE_BYTES = 64 * 1024 * 1024;

export type InstallResult = { installed: true; version: string } | { installed: false; reason: string };

class Refused extends Error {}

function refuse(reason: string): never {
    throw new Refused(reason);
}

const UKI_NAME = /^beanpool-vault_((?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8}))\.efi$/;
const PARTITION_NAME = /\.root(-verity)?\.raw$/;

/** Pids with `uid` as any of their user ids (real, effective, saved, file system), from /proc. */
export function processesOf(uid: number, proc = '/proc'): number[] {
    const pids: number[] = [];
    for (const name of readdirSync(proc)) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const line = /^Uid:\s+(.*)$/m.exec(readFileSync(`${proc}/${name}/status`, 'utf8'))?.[1] ?? '';
            if (line.split(/\s+/).map(Number).includes(uid)) pids.push(Number(name));
        } catch {
            // Gone since.
        }
    }
    return pids;
}

/** Every entry of a directory root owns, gone (its contents only). */
function emptyOwn(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir)) rmSync(path.join(dir, name), { recursive: true, force: true });
}

function names(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/** One entry of the API's user's, gone whole (a link itself, never what it points at): only once the API is stopped. */
function removeWhole(p: string): boolean {
    try {
        rmSync(p, { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
}

/**
 * The inbox's entries gone but `keep` (regular files only, by lstat). With the API running, a directory is left alone
 * (never walked into) and said; with it stopped, it goes whole.
 */
function emptyInbox(inbox: string, log: (line: string) => void, apiStopped: boolean, keep: (name: string) => boolean = () => false): void {
    for (const name of names(inbox)) {
        const p = path.join(inbox, name);
        try {
            const st = lstatSync(p);
            if (st.isFile() && keep(name)) continue;
            if (apiStopped) removeWhole(p);
            else if (st.isDirectory()) log(`left a directory in the inbox alone: ${name}`);
            else unlinkSync(p);
        } catch {
            // Gone already.
        }
    }
}

/**
 * The API's directories on the state partition, once the API is stopped: `releases` emptied; in `backups` only backups
 * (regular files under a backup name) that `backupMaxBytes` keeps (backupsPastBudget: none larger than it, then the
 * newest while they fit together, as the API's rotation keeps them); `restore` emptied, unless the keyholder's marker is
 * there: then the pending restore's file and its partial file stay (regular files, any size). Returns what went, in a
 * few words, or null when nothing did.
 */
export function clearApiDirs(dirs: ApiDirs, log: (line: string) => void, now = Date.now()): string | null {
    const said: string[] = [];
    const releases = names(dirs.releases).filter(n => removeWhole(path.join(dirs.releases, n)));
    if (releases.length) said.push(`${releases.length} in releases`);

    const backups: { name: string; size: number; blocks: number }[] = [];
    let others = 0;
    for (const name of names(dirs.backups)) {
        const p = path.join(dirs.backups, name);
        let st;
        try {
            st = lstatSync(p);
        } catch {
            continue;
        }
        // Only a regular file under a backup name is a backup (lstat: a link is never followed, and goes itself, as
        // does a directory with all it holds, a FIFO or a socket).
        if (st.isFile() && BACKUP_NAME_RE.test(name)) backups.push({ name, size: st.size, blocks: st.blocks });
        else if (removeWhole(p)) others++;
    }
    let dropped = 0;
    for (const name of backupsPastBudget(backups, dirs.backupMaxBytes, { latest: latestBackupName(now) })) if (removeWhole(path.join(dirs.backups, name))) dropped++;
    if (others) said.push(`${others} in backups that ${others === 1 ? 'is' : 'are'} not a backup`);
    if (dropped) said.push(`${dropped} ${dropped === 1 ? 'backup' : 'backups'} past the budget`);

    // A restore from backup is pending only while the keyholder says so (its own directory: the API's user can't write
    // there). The API then needs its file, or the partial one it names after a crash (server.ts, ensureDb), to finish.
    const restorePending = existsSync(dirs.restoreMarker);
    const keep = new Set(restorePending ? [RESTORE_PENDING_NAME, `${RESTORE_PENDING_NAME}.part`] : []);
    let restore = 0;
    for (const name of names(dirs.restore)) {
        const p = path.join(dirs.restore, name);
        try {
            if (keep.has(name) && lstatSync(p).isFile()) continue;
        } catch {
            continue;
        }
        if (removeWhole(p)) restore++;
    }
    if (restore) said.push(`${restore} in restore`);

    // The custodians' settings: the one file the API writes there (a link, a directory, a partial write or one past the
    // cap goes; the API reads none of those either).
    if (dirs.settings) {
        let settings = 0;
        for (const name of names(dirs.settings)) {
            const p = path.join(dirs.settings, name);
            try {
                const st = lstatSync(p);
                if (name === SETTINGS_FILE_NAME && st.isFile() && st.size <= SETTINGS_MAX_BYTES) continue;
            } catch {
                continue;
            }
            if (removeWhole(p)) settings++;
        }
        if (settings) said.push(`${settings} in settings that ${settings === 1 ? 'is' : 'are'} not the settings file`);
    }
    if (!said.length) return null;
    const line = `removed what the API left on the state partition: ${said.join(', ')}`;
    log(line);
    return line;
}


/**
 * Copies `from` (in the inbox) to `to` (root's own, created new), without following a link, only if it is a regular
 * file, and no more than `maxBytes`; returns the SHA-256 of what was copied.
 */
function copyOwn(from: string, to: string, maxBytes: number): string {
    let src: number;
    try {
        src = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
        refuse(`${path.basename(from)} can't be opened (missing, or a link)`);
    }
    let dst: number | null = null;
    try {
        const st = fstatSync(src);
        if (!st.isFile()) refuse(`${path.basename(from)} is not a regular file`);
        if (st.size > maxBytes) refuse(`${path.basename(from)} is larger than ${maxBytes} bytes`);
        dst = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        const hash = crypto.createHash('sha256');
        const buf = Buffer.allocUnsafe(1 << 20);
        let total = 0;
        for (;;) {
            const n = readSync(src, buf, 0, buf.length, null);
            if (n === 0) break;
            total += n;
            if (total > maxBytes) refuse(`${path.basename(from)} grew past ${maxBytes} bytes`);
            hash.update(buf.subarray(0, n));
            for (let off = 0; off < n;) off += writeSync(dst, buf, off, n - off);
        }
        return hash.digest('hex');
    } finally {
        closeSync(src);
        if (dst !== null) closeSync(dst);
    }
}

function parseChain(text: string): ReleaseFiles[] {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        refuse('the staged release file is not JSON');
    }
    const chain = (raw as { chain?: unknown })?.chain;
    if (!Array.isArray(chain) || !chain.every(f => f && typeof f === 'object' && typeof f.manifestText === 'string' && typeof f.signaturesText === 'string')) {
        refuse('the staged release file holds no chain of releases');
    }
    return (chain as ReleaseFiles[]).map(f => ({ manifestText: f.manifestText, signaturesText: f.signaturesText, label: typeof f.label === 'string' ? f.label : undefined }));
}

/**
 * Checks 1 to 5 on root's copies in `workDir`; returns the release and the copies' names. `beforeCopies` (the restart
 * request's check) runs once the release and the running one are known, before the image's files are copied.
 */
async function check(opts: InstallOptions, entries: string[], beforeCopies?: (release: TrustedRelease, running: TrustedRelease) => void): Promise<{ release: TrustedRelease; names: ReturnType<typeof stagedNames> }> {
    const ukis = entries.filter(n => UKI_NAME.test(n));
    if (ukis.length !== 1) refuse(ukis.length ? `more than one boot file is staged (${ukis.join(', ')})` : 'no boot file is staged');
    const version = (UKI_NAME.exec(ukis[0]) as RegExpExecArray)[1];
    const releaseFile = `beanpool-vault_${version}.staged.json`;
    if (!entries.includes(releaseFile)) refuse(`no release is staged with ${ukis[0]}: unsigned`);
    const copy = path.join(opts.workDir, releaseFile);
    copyOwn(path.join(opts.inbox, releaseFile), copy, STAGED_RELEASE_MAX_BYTES);
    const chain = resolveChain(parseChain(readFileSync(copy, 'utf8')), opts.rootKeys);

    // 1. Two custodian signatures, in the chain from the pinned keys.
    const release = chain.releases.find(r => r.manifest.version === version);
    if (!release) {
        const why = chain.problems.map(p => p.reason).concat(chain.stopped ? [chain.stopped.detail] : []);
        refuse(`release ${version} is not in the chain of two-signed releases from the pinned keys${why.length ? ` (${[...new Set(why)].join('; ')})` : ''}`);
    }
    // 2. Never backwards, and a new image.
    const image = opts.runningImage();
    if (!image) refuse('the image this machine booted is unknown, so "newer" can\'t be checked');
    const running = [...chain.releases].reverse().find(r => r.manifest.imageHash === image);
    if (!running) refuse('the image this machine booted is not a release in that chain, so "newer" can\'t be checked');
    // (A release naming the running image is itself a running release, so it is never newer: no new image goes.)
    if (compareVersions(version, running.manifest.version) <= 0) refuse(`release ${version} is not newer than ${running.manifest.version}, the release this machine runs`);
    // 3. The names carry that release's version and root hash.
    const names = stagedNames(version, release.manifest.image.roothash);
    const strays = entries.filter(n => PARTITION_NAME.test(n) && n !== names.root && n !== names.verity);
    if (strays.length) refuse(`partitions staged under another version or root hash than release ${version}'s: ${strays.join(', ')}`);
    for (const n of [names.root, names.verity]) if (!entries.includes(n)) refuse(`${n} (release ${version}'s) is not staged`);
    beforeCopies?.(release, running);
    // Room for root's copies, beside the API's (the sizes the inbox shows; copyOwn caps what it copies).
    const need = [names.uki, names.root, names.verity].reduce((sum, n) => {
        try {
            return sum + lstatSync(path.join(opts.inbox, n)).size;
        } catch {
            return sum;
        }
    }, 0);
    const free = (opts.freeBytes ?? (d => freeBytes(d, true)))(opts.workDir);
    if (need + INSTALL_SPARE_BYTES > free) refuse(`no room on the state partition for root's copies of release ${version}: they need ${mib(need)} and ${mib(free)} are free`);
    // 4. The boot file.
    const uki = copyOwn(path.join(opts.inbox, names.uki), path.join(opts.workDir, names.uki), UKI_MAX_BYTES);
    if (uki !== release.manifest.image.ukiSha256) refuse(`the boot file is not the one release ${version} names`);
    // 5. The system partition against the release's root hash.
    copyOwn(path.join(opts.inbox, names.root), path.join(opts.workDir, names.root), PARTITION_MAX_BYTES);
    copyOwn(path.join(opts.inbox, names.verity), path.join(opts.workDir, names.verity), PARTITION_MAX_BYTES);
    const verified = await (opts.verifyRoot ?? veritysetupVerify)(path.join(opts.workDir, names.root), path.join(opts.workDir, names.verity), release.manifest.image.roothash);
    if (!verified) refuse(`the system partition does not match release ${version}'s root hash`);
    return { release, names };
}

export async function installStaged(opts: InstallOptions): Promise<InstallResult> {
    const log = opts.log ?? (line => console.log(`vault-install: ${line}`));
    const { result, cleanup } = await attempt(opts, log);
    record(opts, log, result, cleanup);
    return result;
}

function record(opts: InstallOptions, log: (line: string) => void, result: InstallResult, cleanup: string | null): void {
    if (opts.resultFile) {
        const record: InstallRecord = { at: (opts.clock ?? Date.now)(), ...result, ...(cleanup ? { cleanup } : {}) };
        try {
            writeFileSync(`${opts.resultFile}.part`, `${JSON.stringify(record)}\n`, { mode: 0o644 });
            renameSync(`${opts.resultFile}.part`, opts.resultFile);
        } catch (e) {
            log(`what was done could not be left for the report: ${(e as Error).message}`);
        }
    }
}

export interface RestartOptions extends InstallOptions {
    /** Where the API leaves two custodians' restart request (RESTART_REQUEST_FILE): read once, and removed. */
    requestFile: string;
    /** Root's record of the requests it acted on (RESTART_USED_FILE, root's directory). */
    usedFile: string;
}

/** The request file's text, read without following a link (a regular file within the cap; else null), and removed. */
function takeRequest(file: string): { present: false } | { present: true; text: string | null } {
    try {
        lstatSync(file);
    } catch {
        return { present: false };
    }
    let text: string | null = null;
    let fd: number | null = null;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const st = fstatSync(fd);
        if (st.isFile() && st.size <= RESTART_REQUEST_MAX_BYTES) {
            const buf = Buffer.alloc(RESTART_REQUEST_MAX_BYTES + 1);
            let total = 0;
            for (let n; total < buf.length && (n = readSync(fd, buf, total, buf.length - total, null)) > 0;) total += n;
            if (total <= RESTART_REQUEST_MAX_BYTES) text = buf.subarray(0, total).toString('utf8');
        }
    } catch {
        // A link, a FIFO, gone: not a request.
    } finally {
        if (fd !== null) closeSync(fd);
    }
    // Whatever it was, it goes (a directory under that name with all it holds): the path unit triggers only on a new one.
    removeWhole(file);
    return { present: true, text };
}

/** The ids of requests acted on within the last two windows of freshness (older ones can't be fresh again). */
function readUsed(file: string, now: number): Map<string, number> {
    const used = new Map<string, number>();
    try {
        const o = JSON.parse(readFileSync(file, 'utf8')) as { used?: Record<string, unknown> };
        for (const [id, at] of Object.entries(o.used ?? {})) {
            if (typeof at === 'number' && now - at < 2 * (RESTART_REQUEST_MAX_AGE_MS + RESTART_CLOCK_MARGIN_MS)) used.set(id, at);
        }
    } catch {
        // None yet.
    }
    return used;
}

function writeUsed(file: string, used: Map<string, number>): void {
    writeFileSync(`${file}.part`, `${JSON.stringify({ v: 1, used: Object.fromEntries(used) })}\n`, { mode: 0o600 });
    renameSync(`${file}.part`, file);
}

/**
 * The custodians' restart (beanpool-vault-restart.path): with no request, nothing at all. With one, every check (the
 * request's and the staged image's, on root's copies) before anything is stopped or removed; a request that fails any
 * of them is refused and logged, and the vault keeps running as it was. Only a request that passes them all is
 * recorded as acted on, and then: stop the API, clear what its user left, install into the other slot. The caller
 * reboots only on `installed: true`.
 */
export async function installForRestart(opts: RestartOptions): Promise<InstallResult> {
    const log = opts.log ?? (line => console.log(`vault-install: ${line}`));
    const taken = takeRequest(opts.requestFile);
    if (!taken.present) return { installed: false, reason: 'no restart request' };
    const now = (opts.clock ?? Date.now)();
    emptyOwn(opts.transferDir);
    emptyOwn(opts.workDir);
    let checked: Awaited<ReturnType<typeof check>>;
    try {
        if (taken.text === null) refuse(`the restart request is not a regular file of at most ${RESTART_REQUEST_MAX_BYTES} bytes`);
        const text = taken.text;
        const entries = names(opts.inbox);
        if (!entries.length) refuse('nothing is staged, so there is nothing to restart for');
        checked = await check(opts, entries, (release, running) => {
            const used = readUsed(opts.usedFile, now);
            const m = release.manifest;
            const r = checkRestartRequest(text, {
                trusted: running.manifest.custodianKeys, now, used: new Set(used.keys()),
                staged: { version: m.version, imageHash: m.imageHash, ukiSha256: m.image.ukiSha256, roothash: m.image.roothash },
            });
            if (!r.ok) refuse(r.reason);
            // Recorded before anything is copied or stopped: a request is acted on once, whatever comes of it.
            used.set(r.id, now);
            try {
                writeUsed(opts.usedFile, used);
            } catch (e) {
                refuse(`the restart request could not be recorded, so a replay could not be refused: ${(e as Error).message}`);
            }
            log(`restart request for release ${m.version}, signed by ${r.signers.map(k => `${k.slice(0, 8)}…`).join(' and ')}`);
        });
    } catch (e) {
        const reason = e instanceof Refused ? e.message
            : isNoRoom(e) ? `no room on the state partition for root's copies: ${(e as Error).message}`
                : `the staged files could not be checked: ${(e as Error).message}`;
        log(`restart refused, nothing stopped or installed: ${reason}`);
        emptyOwn(opts.workDir);
        emptyOwn(opts.transferDir);
        const result: InstallResult = { installed: false, reason };
        record(opts, log, result, null);
        return result;
    }
    // Every check passed on root's own copies (in workDir, the API's user can't reach them): now the API stops.
    const apiStopped = opts.stopApi ? opts.stopApi() : false;
    let cleanup: string | null = null;
    if (apiStopped) {
        cleanup = opts.apiDirs ? clearApiDirs(opts.apiDirs, log, now) : null;
        emptyInbox(opts.inbox, log, true);
    } else {
        if (opts.stopApi) {
            cleanup = 'the API could not be stopped: what it left on the state partition stays until the next restart';
            log(cleanup);
        }
        emptyInbox(opts.inbox, log, false);
    }
    const version = checked.release.manifest.version;
    let result: InstallResult = { installed: true, version };
    try {
        for (const n of [checked.names.uki, checked.names.root, checked.names.verity]) renameSync(path.join(opts.workDir, n), path.join(opts.transferDir, n));
        log(`release ${version} checked from the pinned keys: installing it into the other slot`);
        if (!opts.sysupdate()) {
            log(`systemd-sysupdate did not install release ${version}`);
            result = { installed: false, reason: 'systemd-sysupdate failed' };
        }
    } catch (e) {
        result = { installed: false, reason: `release ${version} could not be installed: ${(e as Error).message}` };
        log(result.reason);
    } finally {
        emptyOwn(opts.transferDir);
        emptyOwn(opts.workDir);
    }
    record(opts, log, result, cleanup);
    return result;
}

/** What root's step did about what the API left on the state partition (for the record), and whether it installed. */
async function attempt(opts: InstallOptions, log: (line: string) => void): Promise<{ result: InstallResult; cleanup: string | null }> {
    emptyOwn(opts.transferDir);
    emptyOwn(opts.workDir);
    const apiStopped = opts.stopApi ? opts.stopApi() : false;
    let cleanup: string | null = null;
    if (apiStopped) {
        cleanup = opts.apiDirs ? clearApiDirs(opts.apiDirs, log) : null;
        // Nothing but regular files: a directory named like a boot file can't stand beside the image.
        emptyInbox(opts.inbox, log, true, () => true);
    } else if (opts.stopApi) {
        cleanup = 'the API could not be stopped: what it left on the state partition stays until the next restart';
        log(cleanup);
    }
    return { result: await checkAndInstall(opts, log, apiStopped), cleanup };
}

async function checkAndInstall(opts: InstallOptions, log: (line: string) => void, apiStopped: boolean): Promise<InstallResult> {
    const entries = names(opts.inbox);
    if (!entries.length) return { installed: false, reason: 'nothing is staged' };
    let checked: Awaited<ReturnType<typeof check>>;
    try {
        checked = await check(opts, entries);
        for (const n of [checked.names.uki, checked.names.root, checked.names.verity]) {
            renameSync(path.join(opts.workDir, n), path.join(opts.transferDir, n));
        }
    } catch (e) {
        const reason = e instanceof Refused ? e.message
            : isNoRoom(e) ? `no room on the state partition for root's copies: ${(e as Error).message}`
                : `the staged files could not be checked: ${(e as Error).message}`;
        log(`refused, nothing installed: ${reason}`);
        emptyOwn(opts.transferDir);
        return { installed: false, reason };
    } finally {
        emptyInbox(opts.inbox, log, apiStopped);
        emptyOwn(opts.workDir);
    }
    const version = checked.release.manifest.version;
    log(`release ${version} checked from the pinned keys: installing it into the other slot`);
    try {
        if (!opts.sysupdate()) {
            log(`systemd-sysupdate did not install release ${version}`);
            return { installed: false, reason: 'systemd-sysupdate failed' };
        }
    } finally {
        emptyOwn(opts.transferDir);
    }
    return { installed: true, version };
}
