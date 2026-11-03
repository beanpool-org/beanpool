/**
 * The Android APK a node carries and serves on its local network (lights-out H3; scratch/fable-design/
 * DESIGN-lights-out-plain-ip-fable.md §2.6, DESIGN-lights-out-fable.md L3; Marty, 4 Nov 2026: "imagine if you didnt
 * download the APK? then no new members could get on").
 *
 * One file of code for both places that fetch it, so they check it the same way:
 *   - the image build (scripts/apk/fetch-image-apk.mjs, run by .github/workflows/docker-publish.yml under Node's type
 *     stripping, which is why this file imports nothing but node: modules and uses only erasable TypeScript);
 *   - the node itself, once a day while it is online (services/apk-mirror.ts), for a newer one into data/apk/.
 *
 * Where it comes from: the android-v<semver> releases of beanpool-org/beanpool on GitHub (memory
 * apk-with-every-android-release): one asset `BeanPool-<version>-<versionCode>.apk`, the Google-signed universal APK,
 * with its SHA-256 in the release notes' table. Nothing else is asked: no BeanPool server, only GitHub's public release
 * endpoint and the hosts it redirects a download to.
 *
 * What makes a file one we serve, all of it checked before the file is kept:
 *   - its version is at least APK_FLOOR (1.2.93, the first public APK without Play's installer check);
 *   - its bytes' SHA-256 is the one the release notes give (and the one GitHub's own asset digest gives, when it gives one);
 *   - its APK Signature Scheme v2 and v3 blocks verify (each signature over its signed data, with the signer's own key, and
 *     the content digest over the file's sections), from one signer, whose certificate's SHA-256 is APK_SIGNING_CERT_SHA256,
 *     Google's app-signing certificate for org.beanpool.pillar. The release notes come from GitHub as the file does, so the
 *     digest is transfer integrity; the certificate is the check that does not trust GitHub.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

/** SHA-256 of Google's app-signing certificate for org.beanpool.pillar (Play Console; memory apk-with-every-android-release). */
export const APK_SIGNING_CERT_SHA256 = '46aad0cba89d1fe7eff0609977ce065d85dd7eac1357d44897ec70afb2026c81';
let pinnedCert = APK_SIGNING_CERT_SHA256;
/** Tests only: the certificate a fixture APK is signed with (a test cannot sign with Google's key). Null puts it back. */
export function _setApkSigningCertForTests(sha256: string | null): void { pinnedCert = sha256 ?? APK_SIGNING_CERT_SHA256; }
/** The oldest APK a node serves: 1.2.93 (315) is the first public one without Play's installer check (proven 3 Nov 2026). */
export const APK_FLOOR = '1.2.93';
/** Bigger than any APK we ship (1.2.93 is 161 MB): a download that says it is larger is refused before it starts. */
export const APK_MAX_BYTES = 400 * 1024 * 1024;
/** The folder's manifest beside the one APK file, in the image and in data/apk/. */
export const APK_MANIFEST = 'apk.json';
/** The modification time every file of the image's APK layer is given, so the same APK makes the same layer, byte for byte. */
export const APK_LAYER_MTIME = new Date('2026-01-01T00:00:00Z');

const ANDROID_TAG = /^android-v(\d+)\.(\d+)\.(\d+)$/;
const APK_FILE = /^BeanPool-(\d+\.\d+\.\d+)-(\d+)\.apk$/;
const NOTES_SHA256 = /File SHA-256\s*\|\s*`?([0-9a-fA-F]{64})`?/;

/** Where releases are read from: GitHub, or a test's fake. */
export interface ApkSource {
    /** The releases list (JSON array of GitHub release objects). */
    releasesUrl: string;
    /** Whether a release's asset address is one of this repository's release downloads. */
    assetUrlOk(url: string, tag: string, fileName: string): boolean;
    /** Whether a request (the first one or a redirect) may go to this address. */
    hopOk(url: string): boolean;
    /** Headers for the releases list (a token, on CI, for the rate limit), never sent to a download host. */
    listHeaders?: Record<string, string>;
}

const REPO = 'beanpool-org/beanpool';
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

/** GitHub's public release endpoint, and the hosts it hands a release download to. */
export function githubApkSource(token?: string): ApkSource {
    return {
        releasesUrl: `https://api.github.com/repos/${REPO}/releases?per_page=100`,
        assetUrlOk: (url, tag, fileName) => url === `https://github.com/${REPO}/releases/download/${tag}/${fileName}`,
        hopOk: (url) => {
            try {
                const u = new URL(url);
                return u.protocol === 'https:' && (u.hostname === 'api.github.com' || DOWNLOAD_HOSTS.has(u.hostname));
            } catch { return false; }
        },
        listHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
    };
}

/** One android-v* release's APK, as its release describes it. */
export interface ApkRelease {
    tag: string;
    version: string;
    versionCode: number;
    fileName: string;
    url: string;
    size: number;
    sha256: string;
}

/** A checked APK file, as its folder's apk.json records it. */
export interface ApkInfo {
    version: string;
    versionCode: number;
    fileName: string;
    size: number;
    sha256: string;
    certSha256: string;
    tag: string;
}

function semver(v: string): number[] | null {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0, 0, >0 as `a` is older than, the same as, or newer than `b`: by version, then by version code. */
export function compareApk(a: { version: string; versionCode: number }, b: { version: string; versionCode: number }): number {
    const x = semver(a.version) ?? [0, 0, 0];
    const y = semver(b.version) ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return a.versionCode - b.versionCode;
}

/** Whether `version` is at or above APK_FLOOR. */
export function atOrAboveFloor(version: string): boolean {
    return semver(version) !== null && compareApk({ version, versionCode: 0 }, { version: APK_FLOOR, versionCode: 0 }) >= 0;
}

/** The APK a GitHub release object offers, or null when it is not a published android-v* release with exactly one. */
export function apkReleaseOf(r: any, source: ApkSource): ApkRelease | null {
    if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string') return null;
    const tag = ANDROID_TAG.exec(r.tag_name);
    if (!tag) return null;
    const version = `${tag[1]}.${tag[2]}.${tag[3]}`;
    const apks = (Array.isArray(r.assets) ? r.assets : []).filter((a: any) => typeof a?.name === 'string' && APK_FILE.test(a.name));
    if (apks.length !== 1) return null;
    const asset = apks[0];
    const file = APK_FILE.exec(asset.name)!;
    if (file[1] !== version) return null;
    const notes = NOTES_SHA256.exec(typeof r.body === 'string' ? r.body : '');
    if (!notes) return null;
    const sha256 = notes[1].toLowerCase();
    // GitHub's own digest of the asset, where it gives one, must say the same as the notes.
    if (typeof asset.digest === 'string' && asset.digest && asset.digest.toLowerCase() !== `sha256:${sha256}`) return null;
    const size = Number(asset.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > APK_MAX_BYTES) return null;
    const url = String(asset.browser_download_url ?? '');
    if (!source.assetUrlOk(url, r.tag_name, asset.name)) return null;
    return { tag: r.tag_name, version, versionCode: Number(file[2]), fileName: asset.name, url, size, sha256 };
}

/** The newest APK a releases list offers at or above APK_FLOOR, by version then version code (never by date), or null. */
export function newestApkRelease(releases: unknown, source: ApkSource): ApkRelease | null {
    let best: ApkRelease | null = null;
    for (const r of Array.isArray(releases) ? releases : []) {
        const apk = apkReleaseOf(r, source);
        if (apk && atOrAboveFloor(apk.version) && (!best || compareApk(apk, best) > 0)) best = apk;
    }
    return best;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A GET that follows at most five redirects itself, each to an address `source.hopOk` allows. */
async function fetchFollowing(url: string, source: ApkSource, fetchImpl: FetchLike, headers: Record<string, string>,
    signal?: AbortSignal): Promise<Response> {
    let at = url;
    for (let hop = 0; hop <= 5; hop++) {
        if (!source.hopOk(at)) throw new Error(`refused to fetch from ${new URL(at).host}: not GitHub's release endpoint`);
        const res = await fetchImpl(at, { headers: hop === 0 ? headers : { 'User-Agent': 'BeanPool-Node' }, redirect: 'manual', signal });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            at = new URL(res.headers.get('location')!, at).toString();
            await res.body?.cancel().catch(() => undefined);
            continue;
        }
        return res;
    }
    throw new Error('too many redirects');
}

/** The newest APK release GitHub (or `source`) lists. Throws when the list cannot be read. */
export async function lookUpNewestApk(source: ApkSource, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<ApkRelease | null> {
    const res = await fetchFollowing(source.releasesUrl, source, fetchImpl,
        { Accept: 'application/vnd.github+json', 'User-Agent': 'BeanPool-Node', ...(source.listHeaders ?? {}) }, signal);
    if (!res.ok) throw new Error(`the releases list answered ${res.status}`);
    return newestApkRelease(await res.json(), source);
}

/** SHA-256 of a whole file, hex. */
export async function fileSha256(file: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

/**
 * Downloads `release` to `dest` (through `dest`.partial, renamed only once whole), then checks it (checkApkFile). A file
 * that is the wrong size, digest or signer is deleted and the error names what was wrong.
 */
export async function downloadApk(release: ApkRelease, dest: string, source: ApkSource, fetchImpl: FetchLike = fetch,
    signal?: AbortSignal): Promise<ApkInfo> {
    const partial = `${dest}.partial`;
    await fsp.rm(partial, { force: true });
    try {
        const res = await fetchFollowing(release.url, source, fetchImpl, { 'User-Agent': 'BeanPool-Node', Accept: 'application/octet-stream' }, signal);
        if (!res.ok || !res.body) throw new Error(`the download answered ${res.status}`);
        const out = fs.createWriteStream(partial, { mode: 0o644 });
        let bytes = 0;
        try {
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
                bytes += chunk.byteLength;
                if (bytes > release.size) throw new Error(`the download is larger than the ${release.size} bytes its release gives`);
                if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
            }
        } finally {
            await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
        }
        if (bytes !== release.size) throw new Error(`the download is ${bytes} bytes, not the ${release.size} its release gives`);
        const info = await checkApkFile(partial, release);
        await fsp.rename(partial, dest);
        return info;
    } catch (e) {
        await fsp.rm(partial, { force: true }).catch(() => undefined);
        throw e;
    }
}

/**
 * Whether `file` is the APK `expected` describes: its size and SHA-256, and a signature by the pinned certificate
 * (verifyApkSignature). Returns its ApkInfo; throws, naming the first thing wrong.
 */
export async function checkApkFile(file: string, expected: Pick<ApkRelease, 'tag' | 'version' | 'versionCode' | 'fileName' | 'size' | 'sha256'>): Promise<ApkInfo> {
    if (!atOrAboveFloor(expected.version)) throw new Error(`${expected.version} is below ${APK_FLOOR}, the oldest APK a node serves`);
    const size = (await fsp.stat(file)).size;
    if (size !== expected.size) throw new Error(`the file is ${size} bytes, not ${expected.size}`);
    const sha256 = await fileSha256(file);
    if (sha256 !== expected.sha256) throw new Error(`its SHA-256 is ${sha256}, not ${expected.sha256} as its release notes give`);
    const certSha256 = await verifyApkSignature(file);
    if (certSha256 !== pinnedCert) throw new Error(`it is signed by certificate ${certSha256}, not BeanPool's (${pinnedCert})`);
    return { version: expected.version, versionCode: expected.versionCode, fileName: expected.fileName, size, sha256, certSha256, tag: expected.tag };
}

// ── APK Signature Scheme v2 / v3 (source.android.com/docs/security/features/apksigning/v2 and v3) ─────────────────────

const SIG_BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'latin1');
const V2_ID = 0x7109871a;
const V3_ID = 0xf05368c0;
const V31_ID = 0x1b93ad61;
const CHUNK = 1024 * 1024;

/** A signature algorithm: how its signature is checked, and which content digest it signs (null: a verity digest, not recomputed). */
const ALGORITHMS: Record<number, { hash: 'sha256' | 'sha512'; pss?: number; content: 'sha256' | 'sha512' | null }> = {
    0x0101: { hash: 'sha256', pss: 32, content: 'sha256' },
    0x0102: { hash: 'sha512', pss: 64, content: 'sha512' },
    0x0103: { hash: 'sha256', content: 'sha256' },
    0x0104: { hash: 'sha512', content: 'sha512' },
    0x0201: { hash: 'sha256', content: 'sha256' },
    0x0202: { hash: 'sha512', content: 'sha512' },
    0x0301: { hash: 'sha256', content: 'sha256' },
    0x0421: { hash: 'sha256', content: null },
    0x0423: { hash: 'sha256', content: null },
    0x0425: { hash: 'sha256', content: null },
};

/** Reads uint32-length-prefixed items off a buffer. */
class Reader {
    private at = 0;
    private readonly buf: Buffer;
    constructor(buf: Buffer) { this.buf = buf; }
    get done(): boolean { return this.at >= this.buf.length; }
    u32(): number {
        if (this.at + 4 > this.buf.length) throw new Error('the APK signature block is cut short');
        const v = this.buf.readUInt32LE(this.at);
        this.at += 4;
        return v;
    }
    prefixed(): Buffer {
        const len = this.u32();
        if (this.at + len > this.buf.length) throw new Error('the APK signature block is cut short');
        const v = this.buf.subarray(this.at, this.at + len);
        this.at += len;
        return v;
    }
    seq(): Buffer[] {
        const r = new Reader(this.prefixed());
        const items: Buffer[] = [];
        while (!r.done) items.push(r.prefixed());
        return items;
    }
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    if (bytesRead !== length) throw new Error('the file is cut short');
    return buf;
}

/** The chunked content digest a v2/v3 signature covers, over the three sections of the file. */
async function contentDigest(fh: FileHandle, sigBlockStart: number, centralDir: Buffer, eocd: Buffer, hash: 'sha256' | 'sha512'): Promise<Buffer> {
    const chunkDigests: Buffer[] = [];
    const chunk = (data: Buffer) => {
        const head = Buffer.alloc(5);
        head[0] = 0xa5;
        head.writeUInt32LE(data.length, 1);
        chunkDigests.push(crypto.createHash(hash).update(head).update(data).digest());
    };
    for (let at = 0; at < sigBlockStart; at += CHUNK) chunk(await readAt(fh, at, Math.min(CHUNK, sigBlockStart - at)));
    for (let at = 0; at < centralDir.length; at += CHUNK) chunk(centralDir.subarray(at, Math.min(at + CHUNK, centralDir.length)));
    // The end-of-central-directory record, with the central directory's offset as if no signature block were there.
    const eocdForDigest = Buffer.from(eocd);
    eocdForDigest.writeUInt32LE(sigBlockStart, 16);
    for (let at = 0; at < eocdForDigest.length; at += CHUNK) chunk(eocdForDigest.subarray(at, Math.min(at + CHUNK, eocdForDigest.length)));
    const head = Buffer.alloc(5);
    head[0] = 0x5a;
    head.writeUInt32LE(chunkDigests.length, 1);
    const top = crypto.createHash(hash).update(head);
    for (const d of chunkDigests) top.update(d);
    return top.digest();
}

/**
 * Verifies an APK's v2 and v3 signature blocks (every one present, at least one) and returns the SHA-256 (hex) of the one
 * signer's certificate. Throws when a block is missing or malformed, a signature or digest does not verify, there is more
 * than one signer or certificate chain between the blocks, or the APK carries a v3.1 (key rotation) block, which this check
 * does not read.
 */
export async function verifyApkSignature(file: string): Promise<string> {
    const fh = await fsp.open(file, 'r');
    try {
        const size = (await fh.stat()).size;
        // The end-of-central-directory record: its signature, with a comment that reaches exactly to the end of the file.
        const tailLen = Math.min(size, 22 + 0xffff);
        const tail = await readAt(fh, size - tailLen, tailLen);
        let eocdAt = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocdAt = i; break; }
        }
        if (eocdAt < 0) throw new Error('not a ZIP file (no end of central directory)');
        const eocd = tail.subarray(eocdAt);
        const cdSize = eocd.readUInt32LE(12);
        const cdOffset = eocd.readUInt32LE(16);
        const eocdOffset = size - tailLen + eocdAt;
        if (cdOffset + cdSize !== eocdOffset) throw new Error('the central directory is not where the ZIP says');
        if (cdOffset < 32) throw new Error('no APK signature block');
        const footer = await readAt(fh, cdOffset - 24, 24);
        if (!footer.subarray(8).equals(SIG_BLOCK_MAGIC)) throw new Error('no APK signature block (v2/v3): not signed for Android 7 and later');
        const blockSize = Number(footer.readBigUInt64LE(0));
        const sigBlockStart = cdOffset - blockSize - 8;
        if (blockSize < 24 || sigBlockStart < 0 || blockSize > 64 * 1024 * 1024) throw new Error('the APK signature block has a bad size');
        const block = await readAt(fh, sigBlockStart, blockSize + 8);
        if (Number(block.readBigUInt64LE(0)) !== blockSize) throw new Error('the APK signature block sizes disagree');
        const pairs = new Map<number, Buffer>();
        for (let at = 8; at < block.length - 24;) {
            const len = Number(block.readBigUInt64LE(at));
            if (len < 4 || at + 8 + len > block.length - 24) throw new Error('the APK signature block is malformed');
            pairs.set(block.readUInt32LE(at + 8), block.subarray(at + 12, at + 8 + len));
            at += 8 + len;
        }
        if (pairs.has(V31_ID)) throw new Error('the APK carries a v3.1 (key rotation) signature block, which this check does not read');
        const schemes = [V2_ID, V3_ID].filter((id) => pairs.has(id));
        if (schemes.length === 0) throw new Error('no APK Signature Scheme v2 or v3 block');
        const centralDir = await readAt(fh, cdOffset, cdSize);
        const digests = new Map<string, Buffer>();
        const certs = new Set<string>();
        for (const id of schemes) {
            const signers = new Reader(pairs.get(id)!).seq();
            if (signers.length !== 1) throw new Error(`the ${id === V2_ID ? 'v2' : 'v3'} block has ${signers.length} signers, not one`);
            const signer = new Reader(signers[0]);
            const signedData = signer.prefixed();
            if (id === V3_ID) { signer.u32(); signer.u32(); } // min and max SDK
            const signatures = signer.seq();
            const publicKeyDer = signer.prefixed();
            const sd = new Reader(signedData);
            const digestItems = sd.seq();
            const certItems = sd.seq();
            if (certItems.length === 0) throw new Error('a signer with no certificate');
            const cert = new crypto.X509Certificate(certItems[0]);
            const key = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
            if (!cert.publicKey.export({ type: 'spki', format: 'der' }).equals(key.export({ type: 'spki', format: 'der' }))) {
                throw new Error("a signer's public key is not its certificate's");
            }
            if (signatures.length === 0) throw new Error('a signer with no signature');
            const signedAlgs = new Set<number>();
            for (const s of signatures) {
                const r = new Reader(s);
                const alg = r.u32();
                const sig = r.prefixed();
                const a = ALGORITHMS[alg];
                if (!a) throw new Error(`unknown signature algorithm 0x${alg.toString(16)}`);
                const keyOpt = a.pss ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: a.pss } : key;
                if (!crypto.verify(a.hash, signedData, keyOpt, sig)) throw new Error(`a ${id === V2_ID ? 'v2' : 'v3'} signature does not verify`);
                signedAlgs.add(alg);
            }
            let checked = 0;
            const digestAlgs = new Set<number>();
            for (const d of digestItems) {
                const r = new Reader(d);
                const alg = r.u32();
                const want = r.prefixed();
                digestAlgs.add(alg);
                const content = ALGORITHMS[alg]?.content;
                if (!content) continue;
                if (!digests.has(content)) digests.set(content, await contentDigest(fh, sigBlockStart, centralDir, eocd, content));
                if (!digests.get(content)!.equals(want)) throw new Error("the APK's contents are not what its signature covers");
                checked++;
            }
            if (digestAlgs.size !== signedAlgs.size || [...digestAlgs].some((a) => !signedAlgs.has(a))) {
                throw new Error("a signer's digests and signatures name different algorithms");
            }
            if (checked === 0) throw new Error('no content digest this check can recompute');
            certs.add(crypto.createHash('sha256').update(certItems[0]).digest('hex'));
        }
        if (certs.size !== 1) throw new Error('the v2 and v3 blocks name different signers');
        return [...certs][0];
    } finally {
        await fh.close();
    }
}

// ── A folder holding one checked APK (the image's /beanpool-apk, a node's data/apk) ──────────────────────────────────

/** The APK a folder's apk.json names, when the file is there at its size; null otherwise. Reads no more than that. */
export function readApkFolder(dir: string): (ApkInfo & { file: string }) | null {
    try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, APK_MANIFEST), 'utf8')) as ApkInfo;
        if (!info || typeof info.fileName !== 'string' || !APK_FILE.test(info.fileName) || !atOrAboveFloor(info.version)) return null;
        if (info.certSha256 !== pinnedCert || !/^[0-9a-f]{64}$/.test(info.sha256)) return null;
        const file = path.join(dir, info.fileName);
        if (fs.statSync(file).size !== info.size) return null;
        return { ...info, file };
    } catch {
        return null;
    }
}

/** Writes `info`'s manifest into `dir` (whose APK file is already there). */
export async function writeApkManifest(dir: string, info: ApkInfo): Promise<void> {
    const body = JSON.stringify({
        version: info.version, versionCode: info.versionCode, fileName: info.fileName, size: info.size,
        sha256: info.sha256, certSha256: info.certSha256, tag: info.tag,
    }, null, 2) + '\n';
    await fsp.writeFile(path.join(dir, `${APK_MANIFEST}.partial`), body, { mode: 0o644 });
    await fsp.rename(path.join(dir, `${APK_MANIFEST}.partial`), path.join(dir, APK_MANIFEST));
}

// ── The image build ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImageApkResult {
    info: ApkInfo;
    /** Set when the newest release could not be fetched or checked and the cached, already-checked APK was used instead. */
    reusedBecause?: string;
}

/**
 * For the image build: the newest APK GitHub lists, checked, into `layerDir`/beanpool-apk/ with its apk.json, every file
 * and folder of `layerDir` given APK_LAYER_MTIME and fixed modes, so the same APK makes a byte-identical layer. `cacheDir`
 * keeps the last checked APK between builds (the workflow's cache): when it already holds the newest it is not downloaded
 * again; when the newest cannot be listed, fetched or checked, the cached one is checked again and used, and the result
 * says why. With neither, it throws.
 */
export async function prepareImageApk(layerDir: string, cacheDir: string, source: ApkSource, fetchImpl: FetchLike = fetch): Promise<ImageApkResult> {
    await fsp.mkdir(cacheDir, { recursive: true });
    const cached = async (): Promise<ApkInfo | null> => {
        const c = readApkFolder(cacheDir);
        if (!c) return null;
        try { return await checkApkFile(c.file, c); } catch { return null; }
    };
    let info: ApkInfo | null = null;
    let reusedBecause: string | undefined;
    try {
        const newest = await lookUpNewestApk(source, fetchImpl);
        if (!newest) throw new Error(`GitHub lists no android-v* release at or above ${APK_FLOOR} with one APK and its SHA-256`);
        const have = await cached();
        if (have && compareApk(have, newest) === 0 && have.sha256 === newest.sha256) {
            info = have;
        } else {
            const fetched = await downloadApk(newest, path.join(cacheDir, `${newest.fileName}.new`), source, fetchImpl);
            for (const f of await fsp.readdir(cacheDir)) if (f !== `${newest.fileName}.new`) await fsp.rm(path.join(cacheDir, f), { force: true, recursive: true });
            await fsp.rename(path.join(cacheDir, `${newest.fileName}.new`), path.join(cacheDir, newest.fileName));
            await writeApkManifest(cacheDir, fetched);
            info = fetched;
        }
    } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        const have = await cached();
        if (!have) throw new Error(`no Android APK for the image: ${why}; and no earlier checked APK to reuse`);
        info = have;
        reusedBecause = why;
    }
    const dir = path.join(layerDir, 'beanpool-apk');
    await fsp.rm(layerDir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(path.join(cacheDir, info.fileName), path.join(dir, info.fileName));
    await writeApkManifest(dir, info);
    for (const p of [path.join(dir, info.fileName), path.join(dir, APK_MANIFEST)]) {
        await fsp.chmod(p, 0o644);
        await fsp.utimes(p, APK_LAYER_MTIME, APK_LAYER_MTIME);
    }
    for (const p of [dir, layerDir]) {
        await fsp.chmod(p, 0o755);
        await fsp.utimes(p, APK_LAYER_MTIME, APK_LAYER_MTIME);
    }
    return { info, reusedBecause };
}
