import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import { stagedNames, veritysetupVerify, type VerifyRoot } from '../shared/staged-image.js';

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
 * - **a release with a new image** (system or keyholder): its files are downloaded and checked into `stagedDir`, an
 *   inbox this process owns, with the chain of releases up to it. At the monthly restart root checks them again from
 *   the keys it was built with and installs only what passes (install/install.ts): nothing here decides what boots.
 *   Until then the report says so. Its API bundle doesn't run on the old image.
 *
 * Never backwards: only a release newer than the one running is taken, and an API that can't find itself in the feed
 * (a withheld release, a source run) takes nothing.
 */

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
    verifyRoot?: VerifyRoot;
    clock?: () => number;
}

export interface ReleaseRef {
    version: string;
    hash: string;
}

export interface UpdateStatus {
    checkedAt: number | null;
    /** Why the last check couldn't finish (the feed unreachable), or null. */
    error: string | null;
    running: ReleaseRef | null;
    newest: ReleaseRef | null;
    /** A newer image, installed at the next monthly restart; `staged` once its files are checked and in place. */
    imageWaiting: (ReleaseRef & { imageHash: string; staged: boolean; error?: string }) | null;
    stopped: ReleaseChain['stopped'];
    /** Releases not taken at the last check, and why. */
    refused: { release: string; reason: string }[];
    handover: { to: ReleaseRef; at: number; ok: boolean; reason?: string } | null;
    note: string | null;
}

function ref(r: TrustedRelease): ReleaseRef {
    return { version: r.manifest.version, hash: r.hash };
}

export class Updater {
    readonly status: UpdateStatus = {
        checkedAt: null, error: null, running: null, newest: null, imageWaiting: null, stopped: null, refused: [], handover: null, note: null,
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
        const image = this.opts.runningImageHash();
        const own = this.opts.ownBundleHash;
        const newestFirst = [...chain.releases].reverse();
        const running = newestFirst.find(r => r.manifest.apiBundleHash === own && r.manifest.imageHash === image) ?? null;
        s.running = running ? ref(running) : null;
        const newest = chain.newest;
        s.imageWaiting = newest && image && newest.manifest.imageHash !== image
            ? { ...ref(newest), imageHash: newest.manifest.imageHash, ...(await this.stage(newest, files, chain)) }
            : null;
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
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const bundlePath = path.join(dir, API_BUNDLE_ASSET);
        writeFileSync(`${bundlePath}.part`, bytes, { mode: 0o600 });
        renameSync(`${bundlePath}.part`, bundlePath);
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
     */
    private async stage(release: TrustedRelease, files: FeedRelease[], chain: ReleaseChain): Promise<{ staged: boolean; error?: string }> {
        const dir = this.opts.stagedDir;
        if (!dir) return { staged: false };
        const { version, image, imageHash } = release.manifest;
        const names = stagedNames(version, image.roothash);
        const marker = path.join(dir, names.release);
        try {
            if (existsSync(marker) && (JSON.parse(readFileSync(marker, 'utf8')) as { imageHash?: string }).imageHash === imageHash) return { staged: true };
        } catch {
            // Read again below.
        }
        const listed = files.find(f => sha256Hex(f.manifestText) === release.hash) as FeedRelease;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const old of readdirSync(dir)) {
            if (old.startsWith('beanpool-vault_') && !Object.values(names).includes(old)) rmSync(path.join(dir, old), { force: true });
        }
        const drop = () => Object.values(names).forEach(n => rmSync(path.join(dir, n), { force: true }));
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
            return { staged: false, error: `the image could not be fetched: ${(e as Error).message}`.slice(0, 300) };
        }
    }
}
