import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
    API_BUNDLE_ASSET,
    API_BUNDLE_MAX_BYTES,
    PARTITION_MAX_BYTES,
    ROOT_ASSET,
    UKI_ASSET,
    UKI_MAX_BYTES,
    VERITY_ASSET,
    type FeedRelease,
    type ReleaseFeed,
} from '../shared/release-feed.js';
import { compareVersions, resolveChain, sha256Hex, type ReleaseChain, type ReleaseFiles, type TrustedRelease } from '../shared/release.js';
import { freeBytes, isNoRoom, mib, readInstallRecord, stagedNames, veritysetupVerify, type InstallRecord, type VerifyRoot } from '../shared/staged-image.js';

export { stagedNames, uuidOfHex, veritysetupVerify, type VerifyRoot } from '../shared/staged-image.js';

/**
 * Updates without anyone logging in (key vault design §3). Once an hour, and at start, the API reads the feed, walks the
 * chain of releases from the keys it was built with, and finds:
 *
 * - **which release it is**: the newest one whose API bundle is this process's own file and whose image is the one this
 *   machine booted;
 * - **a newer release for the same image**: its bundle is downloaded, checked against the hash its manifest names, kept
 *   in `releasesDir`, and handed to the launcher, which checks it again, runs its self-test, starts it beside this one
 *   and moves the traffic to it. This process then drains and exits. The keyholder is untouched: no unlock;
 * - **a release with a new image** (system or keyholder): when the newest release names another image than the one
 *   booted, the release that brought that image (the first in the chain to name it: API-only releases after it carry
 *   no image files) has its files downloaded and checked into `stagedDir`, an inbox this process owns, with the chain
 *   of releases up to it. At the monthly restart root checks them again from the keys it was built with and installs
 *   only what passes (install/install.ts): nothing here decides what boots. Until then the report says so. Its API
 *   bundle doesn't run on the old image.
 *
 * Never backwards: only a release newer than the one running is taken, and an API that can't find itself in the feed
 * (a withheld release, a source run) takes nothing: no handover, and no image staged (the image's release must be
 * newer than the running one too).
 */

/**
 * Everything in the API's inbox but `keep` (the staged image's names, as regular files) goes: the API owns it, and a
 * hostile API before it may have left anything there, which root's step leaves alone (a directory) or refuses. A file
 * or a link is unlinked (never what a link points at). A directory goes with all it holds, once its own directories are
 * writable again (found by lstat, so never through a link; Node's rm doesn't follow a link inside either). Nothing
 * outside the inbox is touched. Returns what couldn't be removed, and why.
 */
function clearInbox(dir: string, keep: readonly string[]): string[] {
    const left: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        try {
            const st = lstatSync(p);
            if (st.isFile() && keep.includes(name)) continue;
            if (st.isDirectory()) {
                try {
                    writable(p);
                } catch {
                    // rm says what stays.
                }
            }
            rmSync(p, { recursive: true, force: true });
        } catch (e) {
            left.push(`${name}: ${errorCode(e)}`);
        }
    }
    return left;
}

/** A directory this process's user owns, and each one under it, made writable (lstat: a link is never followed). */
function writable(dir: string): void {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (lstatSync(p).isDirectory()) writable(p);
    }
}

function errorCode(e: unknown): string {
    return (e as NodeJS.ErrnoException).code ?? (e as Error).message;
}

export interface SwitchRequest {
    bundlePath: string;
    release: ReleaseFiles;
    /** Every release of the chain up to it, so the launcher can check it from its own pinned keys. */
    chain: ReleaseFiles[];
}

/** The process that started this API (src/launcher): it alone starts another. */
export interface LauncherLink {
    requestSwitch(req: SwitchRequest): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface UpdaterOptions {
    feed: ReleaseFeed;
    /** The pinned genesis custodian keys; null (a source run) means no release is ever taken. */
    rootKeys: readonly string[] | null;
    /** SHA-256 of the file this API runs from; null when run from source. */
    ownBundleHash: string | null;
    /** The image this machine booted (image-identity.ts), or null when unknown. */
    runningImageHash: () => string | null;
    releasesDir: string;
    launcher: LauncherLink | null;
    /** The inbox a new image is staged into for the monthly restart (root checks it again); without it, only reported. */
    stagedDir?: string;
    /** What root's install step did at the last monthly restart (INSTALL_RESULT_FILE), read at every check. */
    installResultFile?: string;
    verifyRoot?: VerifyRoot;
    clock?: () => number;
}

export interface ReleaseRef {
    version: string;
    hash: string;
}

export interface UpdateStatus {
    checkedAt: number | null;
    /** The image this machine booted, as this API knows it (image-identity.ts), or null when unknown. */
    image: string | null;
    /** Why the last check couldn't finish (the feed unreachable), or null. */
    error: string | null;
    running: ReleaseRef | null;
    newest: ReleaseRef | null;
    /**
     * The newest release's image, when it isn't the one booted, as the release that brought it (its version is the
     * image's): installed at the next monthly restart; `staged` once its files are checked and in place.
     */
    imageWaiting: (ReleaseRef & { imageHash: string; staged: boolean; error?: string }) | null;
    stopped: ReleaseChain['stopped'];
    /** Releases not taken at the last check, and why. */
    refused: { release: string; reason: string }[];
    handover: { to: ReleaseRef; at: number; ok: boolean; reason?: string } | null;
    /** What root's install step did at the last monthly restart (installed, or why not), as root left it. */
    lastInstall: InstallRecord | null;
    note: string | null;
}

function ref(r: TrustedRelease): ReleaseRef {
    return { version: r.manifest.version, hash: r.hash };
}

export class Updater {
    readonly status: UpdateStatus = {
        checkedAt: null, image: null, error: null, running: null, newest: null, imageWaiting: null, stopped: null, refused: [], handover: null, lastInstall: null,
        note: null,
    };
    private checking: Promise<UpdateStatus> | null = null;
    private readonly clock: () => number;

    constructor(private readonly opts: UpdaterOptions) {
        this.clock = opts.clock ?? (() => Date.now());
    }

    /** One check; a check already running is joined rather than doubled. */
    check(): Promise<UpdateStatus> {
        if (!this.checking) this.checking = this.run().finally(() => { this.checking = null; });
        return this.checking;
    }

    private async run(): Promise<UpdateStatus> {
        const s = this.status;
        s.checkedAt = this.clock();
        s.image = this.opts.runningImageHash();
        s.lastInstall = this.opts.installResultFile ? readInstallRecord(this.opts.installResultFile) : null;
        if (!this.opts.rootKeys) {
            s.note = 'No pinned custodian keys (run from source): releases are not checked.';
            return s;
        }
        let files: FeedRelease[];
        try {
            files = await this.opts.feed.list();
        } catch (e) {
            s.error = `The release feed could not be read: ${(e as Error).message}`.slice(0, 300);
            return s;
        }
        s.error = null;
        const chain = resolveChain(files, this.opts.rootKeys);
        s.stopped = chain.stopped;
        s.refused = chain.problems.map(p => ({ release: p.label ?? p.hash?.slice(0, 12) ?? '?', reason: p.reason }));
        s.newest = chain.newest ? ref(chain.newest) : null;
        const image = s.image;
        const own = this.opts.ownBundleHash;
        const newestFirst = [...chain.releases].reverse();
        const running = newestFirst.find(r => r.manifest.apiBundleHash === own && r.manifest.imageHash === image) ?? null;
        s.running = running ? ref(running) : null;
        // The newest release's image, from the release that brought it: that one carries its files, and its version is
        // the one the image was built as (its UKI's and partitions' names), which root's step and systemd-sysupdate go by.
        // An API-only release after it names the same image and carries none of them.
        const newestImage = chain.newest && image && chain.newest.manifest.imageHash !== image ? chain.newest.manifest.imageHash : null;
        let brought = newestImage ? chain.releases.find(r => r.manifest.imageHash === newestImage) ?? null : null;
        // Only an image newer than the running release: a feed cut short below it (the API can't place itself) or a
        // chain naming an older image again stages nothing (root would refuse it, after a download of the image).
        if (brought && (!running || compareVersions(brought.manifest.version, running.manifest.version) <= 0)) brought = null;
        s.imageWaiting = brought ? { ...ref(brought), imageHash: brought.manifest.imageHash, ...(await this.stage(brought, files, chain).catch(e => ({
            staged: false, error: `the image could not be staged: ${(e as Error).message}`.slice(0, 300),
        }))) } : null;
        if (!running) {
            s.note = own === null ? 'Run from source: no handover.' : !image
                ? 'The booted image is unknown: no handover.'
                : 'This API and image are not a release in the feed: no handover.';
            return s;
        }
        s.note = null;
        const target = newestFirst.find(r => r.manifest.imageHash === image && compareVersions(r.manifest.version, running.manifest.version) > 0);
        if (!target || target.manifest.apiBundleHash === own) return s;
        if (!this.opts.launcher) {
            s.note = `Release ${target.manifest.version} is waiting, but this API was not started by the launcher: no handover.`;
            return s;
        }
        const listed = files.find(f => sha256Hex(f.manifestText) === target.hash) as FeedRelease;
        let bytes: Uint8Array;
        try {
            bytes = await this.opts.feed.asset(listed, API_BUNDLE_ASSET, API_BUNDLE_MAX_BYTES);
        } catch (e) {
            s.error = `Release ${target.manifest.version}'s API bundle could not be read: ${(e as Error).message}`.slice(0, 300);
            return s;
        }
        if (sha256Hex(bytes) !== target.manifest.apiBundleHash) {
            s.refused.push({ release: target.label ?? target.manifest.version, reason: 'its API bundle is not the one its manifest names' });
            return s;
        }
        const dir = path.join(this.opts.releasesDir, target.manifest.apiBundleHash);
        const bundlePath = path.join(dir, API_BUNDLE_ASSET);
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(`${bundlePath}.part`, bytes, { mode: 0o600 });
            renameSync(`${bundlePath}.part`, bundlePath);
        } catch (e) {
            try {
                rmSync(`${bundlePath}.part`, { force: true });
            } catch {
                // Written again at the next check.
            }
            s.error = `Release ${target.manifest.version}'s API bundle could not be kept${isNoRoom(e) ? ' (no room on the state partition)' : ''}: ${(e as Error).message}`.slice(0, 300);
            return s;
        }
        const upTo = chain.releases.slice(0, chain.releases.indexOf(target) + 1);
        const request: SwitchRequest = {
            bundlePath,
            release: { manifestText: target.manifestText, signaturesText: (listed as ReleaseFiles).signaturesText, label: target.label },
            chain: upTo.map(r => {
                const f = files.find(x => sha256Hex(x.manifestText) === r.hash) as FeedRelease;
                return { manifestText: f.manifestText, signaturesText: f.signaturesText, label: f.label };
            }),
        };
        const result = await this.opts.launcher.requestSwitch(request).catch(e => ({ ok: false as const, reason: (e as Error).message }));
        s.handover = { to: ref(target), at: this.clock(), ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) };
        return s;
    }

    /**
     * A new image, into the inbox `stagedDir` for the monthly restart: the UKI checked against the SHA-256 its release
     * names, the system partition and its verity tree against the root hash it names, and last the chain of releases up
     * to it (`stagedNames().release`). Anything that doesn't check is removed. Once staged it isn't fetched again; an
     * older staged image goes. These checks only spare a download that would fail: root makes them all again at the
     * restart, from its own pinned keys (install/install.ts), since this process is the one they guard against.
     *
     * First, at every check, the inbox is cleared of everything else (clearInbox). What can't be removed is said in
     * `error`, and staging goes on beside it.
     */
    private async stage(release: TrustedRelease, files: FeedRelease[], chain: ReleaseChain): Promise<{ staged: boolean; error?: string }> {
        const dir = this.opts.stagedDir;
        if (!dir) return { staged: false };
        let left: string[];
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            left = clearInbox(dir, Object.values(stagedNames(release.manifest.version, release.manifest.image.roothash)));
        } catch (e) {
            left = [`the inbox itself: ${errorCode(e)}`];
        }
        const uncleared = left.length ? `the inbox could not be cleared (${left.join('; ')})` : null;
        const result = await this.fetchImage(dir, release, files, chain);
        const error = [uncleared, result.error].filter(Boolean).join('; ');
        return { staged: result.staged, ...(error ? { error: error.slice(0, 300) } : {}) };
    }

    private async fetchImage(dir: string, release: TrustedRelease, files: FeedRelease[], chain: ReleaseChain): Promise<{ staged: boolean; error?: string }> {
        const { version, image, imageHash } = release.manifest;
        const names = stagedNames(version, image.roothash);
        const marker = path.join(dir, names.release);
        try {
            const all = [names.uki, names.root, names.verity].every(n => lstatSync(path.join(dir, n)).isFile());
            if (all && (JSON.parse(readFileSync(marker, 'utf8')) as { imageHash?: string }).imageHash === imageHash) return { staged: true };
        } catch {
            // Not (all) there: fetched below.
        }
        const listed = files.find(f => sha256Hex(f.manifestText) === release.hash) as FeedRelease;
        const drop = () => {
            for (const n of Object.values(names).flatMap(x => [x, `${x}.part`])) {
                try {
                    rmSync(path.join(dir, n), { recursive: true, force: true });
                } catch {
                    // The next check's clearInbox says what stays.
                }
            }
        };
        try {
            const uki = await this.opts.feed.assetToFile(listed, UKI_ASSET, path.join(dir, names.uki), UKI_MAX_BYTES);
            if (uki !== image.ukiSha256) {
                drop();
                return { staged: false, error: `the image's UKI is not the one release ${version} names` };
            }
            await this.opts.feed.assetToFile(listed, ROOT_ASSET, path.join(dir, names.root), PARTITION_MAX_BYTES);
            await this.opts.feed.assetToFile(listed, VERITY_ASSET, path.join(dir, names.verity), PARTITION_MAX_BYTES);
            if (!(await (this.opts.verifyRoot ?? veritysetupVerify)(path.join(dir, names.root), path.join(dir, names.verity), image.roothash))) {
                drop();
                return { staged: false, error: `the image's system partition does not match release ${version}'s root hash` };
            }
            const upTo = chain.releases.slice(0, chain.releases.indexOf(release) + 1).map(r => {
                const f = files.find(x => sha256Hex(x.manifestText) === r.hash) as FeedRelease;
                return { manifestText: f.manifestText, signaturesText: f.signaturesText, label: f.label };
            });
            writeFileSync(`${marker}.part`, `${JSON.stringify({ version, imageHash, stagedAt: this.clock(), chain: upTo })}\n`, { mode: 0o600 });
            renameSync(`${marker}.part`, marker);
            return { staged: true };
        } catch (e) {
            drop();
            if (isNoRoom(e)) {
                let free = '';
                try {
                    free = `, ${mib(freeBytes(dir, false))} free without it`;
                } catch {
                    // Said without it.
                }
                return { staged: false, error: `no room for the image on the state partition${free}: ${(e as Error).message}`.slice(0, 300) };
            }
            return { staged: false, error: `the image could not be fetched: ${(e as Error).message}`.slice(0, 300) };
        }
    }
}
