import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FetchLike } from '@beanpool/signin';
import { RELEASE_FILE_MAX_BYTES, type ReleaseFiles } from './release.js';

/**
 * Where releases are published (key vault design §3): the repo's GitHub Releases. The feed is trusted with nothing but
 * listing them: every release is checked against the pinned keys (release.ts `resolveChain`) and every file against
 * the hash its manifest names, so a feed that lies can only withhold releases.
 *
 * A vault release is a GitHub release whose tag starts `vault-v`, with these assets:
 */
export const MANIFEST_ASSET = 'vault-release.json';
export const SIGNATURES_ASSET = 'vault-release.sigs.json';
export const API_BUNDLE_ASSET = 'vault-api.mjs';
export const UKI_ASSET = 'vault.efi';
/** The two partition images the UKI's `roothash` names, for a new image (installed at the monthly restart). */
export const ROOT_ASSET = 'vault-root.raw';
export const VERITY_ASSET = 'vault-root-verity.raw';

export const RELEASE_TAG_PREFIX = 'vault-v';
export const DEFAULT_RELEASE_REPO = 'beanpool-org/beanpool';
/** The API bundle is a few megabytes; a boot file tens; a system partition a few hundred. */
export const API_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;

export interface FeedRelease extends ReleaseFiles {
    /** The asset names this release carries. */
    assets: string[];
}

export interface ReleaseFeed {
    /** Every vault release the feed lists, with its manifest and signatures read. */
    list(): Promise<FeedRelease[]>;
    /** One asset of a release; refused past `maxBytes`. */
    asset(release: FeedRelease, name: string, maxBytes: number): Promise<Uint8Array>;
}

export class FeedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FeedError';
    }
}

/** The body of `res`, refused (and the download cut off) past `maxBytes`. */
async function readCapped(res: Response, maxBytes: number, what: string): Promise<Uint8Array> {
    if (!res.ok) throw new FeedError(`${what}: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new FeedError(`${what} is larger than ${maxBytes} bytes.`);
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new FeedError(`${what} is larger than ${maxBytes} bytes.`);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

interface GitHubAsset {
    name: string;
    browser_download_url: string;
    size: number;
}

interface GitHubRelease {
    tag_name: string;
    draft: boolean;
    assets: GitHubAsset[];
}

/**
 * The repo's GitHub Releases, read without a token (public repo, 60 requests an hour per address: the vault reads the
 * list once an hour, plus the two small files of each vault release, cached by tag).
 */
export class GitHubReleaseFeed implements ReleaseFeed {
    private readonly fetchFn: FetchLike;
    private readonly repo: string;
    private readonly files = new Map<string, { manifestText: string; signaturesText: string }>();
    private readonly urls = new Map<string, Map<string, GitHubAsset>>();

    constructor(opts: { repo?: string; fetch?: FetchLike } = {}) {
        this.repo = opts.repo ?? DEFAULT_RELEASE_REPO;
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repo)) throw new Error(`${this.repo} is not owner/name.`);
        this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    }

    private get(url: string, accept: string): Promise<Response> {
        return this.fetchFn(url, { headers: { Accept: accept, 'User-Agent': 'beanpool-vault' }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    }

    async list(): Promise<FeedRelease[]> {
        const out: FeedRelease[] = [];
        for (let page = 1; page <= 10; page++) {
            const res = await this.get(`https://api.github.com/repos/${this.repo}/releases?per_page=100&page=${page}`, 'application/vnd.github+json');
            const text = new TextDecoder().decode(await readCapped(res, 8 * 1024 * 1024, 'The release list'));
            const releases = JSON.parse(text) as GitHubRelease[];
            if (!Array.isArray(releases)) throw new FeedError('The release list is not a list.');
            for (const r of releases) {
                if (r.draft || typeof r.tag_name !== 'string' || !r.tag_name.startsWith(RELEASE_TAG_PREFIX) || !Array.isArray(r.assets)) continue;
                const assets = new Map(r.assets.filter(a => typeof a?.name === 'string').map(a => [a.name, a]));
                const manifest = assets.get(MANIFEST_ASSET);
                const sigs = assets.get(SIGNATURES_ASSET);
                if (!manifest || !sigs) continue;
                this.urls.set(r.tag_name, assets);
                // Signatures can be added to a release after it is published; the manifest can't change (its hash names it).
                let files = this.files.get(r.tag_name);
                const signaturesText = new TextDecoder().decode(await this.download(sigs, RELEASE_FILE_MAX_BYTES));
                if (!files) files = { manifestText: new TextDecoder().decode(await this.download(manifest, RELEASE_FILE_MAX_BYTES)), signaturesText };
                files = { ...files, signaturesText };
                this.files.set(r.tag_name, files);
                out.push({ ...files, label: r.tag_name, assets: [...assets.keys()] });
            }
            if (releases.length < 100) break;
        }
        return out;
    }

    private async download(asset: GitHubAsset, maxBytes: number): Promise<Uint8Array> {
        if (!/^https:\/\/github\.com\//.test(asset.browser_download_url)) throw new FeedError(`${asset.name} is not on github.com.`);
        return readCapped(await this.get(asset.browser_download_url, 'application/octet-stream'), maxBytes, asset.name);
    }

    async asset(release: FeedRelease, name: string, maxBytes: number): Promise<Uint8Array> {
        const a = this.urls.get(release.label ?? '')?.get(name);
        if (!a) throw new FeedError(`${release.label} has no ${name}.`);
        return this.download(a, maxBytes);
    }
}

/**
 * A directory as the feed: one subdirectory per release (named like its tag), holding the same files a GitHub release
 * carries. For tests, and for a rehearsal or an offline custodian with the files copied over.
 */
export class LocalDirectoryFeed implements ReleaseFeed {
    constructor(private readonly dir: string) {}

    async list(): Promise<FeedRelease[]> {
        if (!existsSync(this.dir)) return [];
        const out: FeedRelease[] = [];
        for (const tag of readdirSync(this.dir).sort()) {
            const d = path.join(this.dir, tag);
            if (!statSync(d).isDirectory()) continue;
            const m = path.join(d, MANIFEST_ASSET);
            const s = path.join(d, SIGNATURES_ASSET);
            if (!existsSync(m) || !existsSync(s)) continue;
            out.push({ manifestText: readFileSync(m, 'utf8'), signaturesText: readFileSync(s, 'utf8'), label: tag, assets: readdirSync(d) });
        }
        return out;
    }

    async asset(release: FeedRelease, name: string, maxBytes: number): Promise<Uint8Array> {
        if (!release.assets.includes(name) || name.includes('/')) throw new FeedError(`${release.label} has no ${name}.`);
        const file = path.join(this.dir, release.label ?? '', name);
        if (statSync(file).size > maxBytes) throw new FeedError(`${name} is larger than ${maxBytes} bytes.`);
        return new Uint8Array(readFileSync(file));
    }
}
