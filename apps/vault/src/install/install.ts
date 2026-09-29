import crypto from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { PARTITION_MAX_BYTES, UKI_MAX_BYTES } from '../shared/release-feed.js';
import { compareVersions, resolveChain, type ReleaseFiles, type TrustedRelease } from '../shared/release.js';
import { freeBytes, isNoRoom, mib, STAGED_RELEASE_MAX_BYTES, stagedNames, veritysetupVerify, type InstallRecord, type VerifyRoot } from '../shared/staged-image.js';

/**
 * The monthly restart's install step (key vault design §3), run as root by usr/lib/beanpool-vault/monthly-restart. The
 * API stages a new image into an inbox it owns (updater.ts); what it put there decides nothing. This step walks the
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
 * files are read, sizes are capped, every check runs on root's copy (made first), and entries are unlinked, never
 * walked into.
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

/** Every entry of a directory root owns, gone (its contents only). */
function emptyOwn(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir)) rmSync(path.join(dir, name), { recursive: true, force: true });
}

/** The inbox's entries unlinked; a directory in it is left alone (never walked into), and said. */
function emptyInbox(inbox: string, log: (line: string) => void): void {
    let names: string[];
    try {
        names = readdirSync(inbox);
    } catch {
        return;
    }
    for (const name of names) {
        const p = path.join(inbox, name);
        try {
            if (lstatSync(p).isDirectory()) log(`left a directory in the inbox alone: ${name}`);
            else unlinkSync(p);
        } catch {
            // Gone already.
        }
    }
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

/** Checks 1 to 5 on root's copies in `workDir`; returns the release and the copies' names. */
async function check(opts: InstallOptions, entries: string[]): Promise<{ release: TrustedRelease; names: ReturnType<typeof stagedNames> }> {
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
    const result = await attempt(opts, log);
    if (opts.resultFile) {
        const record: InstallRecord = { at: (opts.clock ?? Date.now)(), ...result };
        try {
            writeFileSync(`${opts.resultFile}.part`, `${JSON.stringify(record)}\n`, { mode: 0o644 });
            renameSync(`${opts.resultFile}.part`, opts.resultFile);
        } catch (e) {
            log(`what was done could not be left for the report: ${(e as Error).message}`);
        }
    }
    return result;
}

async function attempt(opts: InstallOptions, log: (line: string) => void): Promise<InstallResult> {
    emptyOwn(opts.transferDir);
    emptyOwn(opts.workDir);
    let entries: string[];
    try {
        entries = readdirSync(opts.inbox);
    } catch {
        entries = [];
    }
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
        emptyInbox(opts.inbox, log);
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
