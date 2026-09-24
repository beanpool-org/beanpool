/**
 * The image store — where a node's image bytes live once they are out of state.db.
 *
 * ## Why
 *
 * Images were ~84% of the test node's database: `post_photos.photo_data` 15.3 MB, `message_attachments.data`
 * 8.3 MB, avatars 2.0 MB and a 3.1 MB `projects.photos`, out of 34.1 MB. Every one of them is a base64 TEXT
 * column, so the bytes are carried 33% inflated through every VACUUM, every snapshot, every backup tar and
 * every `SELECT *` the sync export does. A node DB that is mostly images is slow to back up on a 1 vCPU VM
 * and expensive to replicate; the rows that matter — the ledger, the members, the posts — are a fraction of it.
 *
 * So the bytes move to a store and the row keeps only what identifies them: `storage_key`, `sha256`, `bytes`
 * and `mime`. This file is the whole contract for that store.
 *
 * ## The shape of it
 *
 * Deliberately narrow — put/get/head/delete/list over an opaque string key — so the S3/R2 backend
 * (s3-image-store.ts, `IMAGE_STORE=s3`, the global node) slots in behind {@link ImageStore} without a single
 * caller changing. Keys are
 * content-addressed inside namespaces (`posts/…`, `attachments/…`, `projects/…`), so the same bytes written
 * twice land on the same object and a re-run of the evacuation job is a no-op rather than a duplicate.
 *
 * ## Synchronous, on purpose
 *
 * `put` is called from inside `db.transaction(() => …)` bodies, which better-sqlite3 runs synchronously — an
 * `await` in there commits the transaction at the first suspension point. Until the async port lands (the
 * storage design §2) the store is sync too. On disk every method is a handful of syscalls on a local file; on
 * S3 the sync methods block for a round trip (s3-image-store.ts says how that is bounded), so the backends that
 * talk to a network ALSO implement the optional async methods below, and every caller that is already async —
 * serving, the sync export, backups, restore — reaches the store through {@link readObject},
 * {@link openObject} and {@link scanObjectsAsync}, which use them when they are there.
 *
 * ## What it refuses
 *
 * - A key that could escape the store root: absolute, `..` in any segment, a backslash, a leading slash, an
 *   empty segment, or anything outside `[A-Za-z0-9._-]` per segment. A `storage_key` comes out of the database,
 *   and the database takes rows from federation peers and from restored backups, so it is not trusted input.
 * - An object over {@link MAX_OBJECT_BYTES}. Today's write paths are already capped far below it
 *   (600k base64 chars per post photo, a 2 MB request body for an attachment); this is the backstop that
 *   keeps a corrupted or hostile row from filling the disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { S3ImageStore, s3ConfigFromEnv } from './s3-image-store.js';

/** The ceiling on any single object, matching the largest body a route will accept (https-server.ts). */
export const MAX_OBJECT_BYTES = 2 * 1024 * 1024;

/** One stored object, as the row that points at it records it. */
export interface StoredObject {
    key: string;
    /** Size of the stored bytes. */
    bytes: number;
    /** Lowercase hex SHA-256 of the stored bytes. */
    sha256: string;
    /** The media type the bytes are served as. */
    mime: string;
}

export interface PutOptions {
    mime: string;
    /** The caller's hash, when it already has one. Checked against the bytes; a mismatch throws. */
    sha256?: string;
}

/** An object as a listing or a head reports it. */
export interface ObjectInfo {
    key: string;
    bytes: number;
    mtimeMs: number;
}

/**
 * A place image bytes live. Implemented by {@link DiskImageStore} and, for `IMAGE_STORE=s3`, by S3ImageStore.
 *
 * The required methods are synchronous — see the note at the top of this file. The optional ones are what a
 * network-backed store adds so that async callers never block on it; use them through {@link readObject},
 * {@link openObject}, {@link scanObjects} and {@link scanObjectsAsync} rather than directly.
 */
export interface ImageStore {
    /** The backend's name, for logs and the storage-health report: `disk` or `s3`. */
    readonly kind: string;
    /** Write (or re-write) an object. Idempotent for the same key and bytes. */
    put(key: string, bytes: Buffer, options: PutOptions): StoredObject;
    /** The object's bytes, or null when it is not there. */
    get(key: string): Buffer | null;
    /** Size and last-modified time without reading the whole object, or null when it is not there. */
    head(key: string): { key: string; bytes: number; mtimeMs: number } | null;
    /** Remove it. True when something was removed, false when it was already gone. */
    delete(key: string): boolean;
    /** Every key under `prefix`, in no particular order. */
    list(prefix: string): string[];
    /**
     * Half-written objects a crash left behind, which {@link list} deliberately never shows.
     *
     * Optional: a backend with no such thing (an object store whose write is one atomic request) does not
     * implement it, and the sweep skips it.
     */
    listTemporary?(): { key: string; bytes: number; mtimeMs: number }[];
    /** Total bytes held, for the disk-usage report. */
    totalBytes(): number;
    /** Every object under `prefix` with its size and time, when the backend can say so without a head per key. */
    scan?(prefix: string): ObjectInfo[];
    /** Non-blocking {@link put}. */
    putAsync?(key: string, bytes: Buffer, options: PutOptions): Promise<StoredObject>;
    /** Non-blocking {@link get}. */
    getAsync?(key: string): Promise<Buffer | null>;
    /** Non-blocking {@link head}. */
    headAsync?(key: string): Promise<ObjectInfo | null>;
    /** The object as a stream, for serving without buffering it. Null when it is not there. */
    openRead?(key: string): Promise<{ stream: Readable; bytes: number | null } | null>;
    /** Non-blocking {@link scan}. */
    scanAsync?(prefix: string): Promise<ObjectInfo[]>;
    /** Where the objects are, in words an operator can act on. Never a credential. */
    describe?(): string;
}

export class ImageStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImageStoreError';
    }
}

/**
 * The store did not answer, or turned this node away as a whole: no answer in time, a 5xx after the retries,
 * the breaker open, throttled (429), the credentials refused, the bucket missing. Nothing is wrong with the
 * object or the row that asked, and the same call can succeed once the store is back.
 *
 * Still an {@link ImageStoreError}, so every caller that handles one handles this. It exists for the callers
 * that decide what to GIVE UP on — the evacuation's skip list above all — which must not mistake an outage for
 * something wrong with a row.
 */
export class ImageStoreUnavailableError extends ImageStoreError {
    constructor(message: string) {
        super(message);
        this.name = 'ImageStoreUnavailableError';
    }
}

/**
 * A key segment may only be these characters: no separators to walk with, no `..` to climb with, nothing the
 * filesystem treats specially. Applied per segment, so `posts/<id>/<n>-<sha8>.jpg` passes and
 * `posts/../../etc/passwd` does not.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The most segments a key may have, so a hostile key cannot build a 4,000-deep directory tree. */
const MAX_KEY_SEGMENTS = 8;
const MAX_KEY_LENGTH = 512;

/**
 * Check a key and return its segments. Throws {@link ImageStoreError} on anything that could reach outside the
 * store root, or that the store simply does not produce.
 */
export function assertSafeKey(key: string): string[] {
    if (typeof key !== 'string' || key.length === 0) throw new ImageStoreError('Image store key must be a non-empty string');
    if (key.length > MAX_KEY_LENGTH) throw new ImageStoreError('Image store key is too long');
    if (key.includes('\\')) throw new ImageStoreError(`Unsafe image store key: ${key}`);
    if (key.includes('\0')) throw new ImageStoreError('Unsafe image store key: NUL');
    if (path.isAbsolute(key) || /^[A-Za-z]:/.test(key)) throw new ImageStoreError(`Unsafe image store key: ${key}`);
    const segments = key.split('/');
    if (segments.length > MAX_KEY_SEGMENTS) throw new ImageStoreError(`Unsafe image store key: ${key}`);
    for (const seg of segments) {
        // Catches '', '.', '..' and anything with a character we never emit.
        if (!SEGMENT.test(seg)) throw new ImageStoreError(`Unsafe image store key: ${key}`);
    }
    return segments;
}

/** A prefix is a key that may end at a directory: the same rules, minus the "must name a file" part. */
export function assertSafePrefix(prefix: string): string[] {
    if (prefix === '') return [];
    const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    return assertSafeKey(trimmed);
}

export function sha256Hex(bytes: Buffer): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The file extension an object gets from its media type. Unknown types are stored as `.bin`. */
export function extensionForMime(mime: string | null | undefined): string {
    switch ((mime || '').toLowerCase().trim()) {
        case 'image/jpeg':
        case 'image/jpg': return 'jpg';
        case 'image/png': return 'png';
        case 'image/webp': return 'webp';
        case 'image/gif': return 'gif';
        default: return 'bin';
    }
}

/**
 * The top-level namespaces this node writes. Anything else in a store — above all in a bucket, which an
 * operator may share with other things — is not ours, and the orphan sweep never lists or deletes it.
 *
 * Not `projects/`: {@link projectPhotoKey} exists, but nothing writes with it yet — project photos stay in
 * `projects.photos` — and no row can reference an object there, so the sweep would read every one as an
 * orphan. Whatever moves project photos out adds the namespace here together with the table that references
 * it, in the sweep (engine/storage-health.ts) and in `STORAGE_KEY_TABLES` (storage/image-columns.ts).
 */
export const STORE_NAMESPACES = ['posts', 'attachments'] as const;

// ── Key builders ───────────────────────────────────────────────────────────────────────────────
//
// Content-addressed inside a namespace: the 8-hex prefix of the object's SHA-256 is in the name, so
// re-writing the same photo is the same key and a re-run of the evacuation job overwrites itself instead of
// littering. The post/project id and order number stay in the key so a human (or an orphan sweep) can see at
// a glance which row an object belongs to.

/** `<postId>` and `<projectId>` are UUIDs or hex ids, but they come from rows — sanitise, never trust. */
function idSegment(raw: string, what: string): string {
    const clean = String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128);
    if (!clean || !SEGMENT.test(clean)) throw new ImageStoreError(`Cannot build an image store key from this ${what}`);
    return clean;
}

export function postPhotoKey(postId: string, orderNum: number, sha256: string, mime: string): string {
    const order = Number.isInteger(orderNum) && orderNum >= 0 ? orderNum : 0;
    return `posts/${idSegment(postId, 'post id')}/${order}-${sha256.slice(0, 8)}.${extensionForMime(mime)}`;
}

/**
 * An attachment is AEAD ciphertext the node cannot read, so it is not an image as far as the store is
 * concerned — `.bin`, and no content type is inferred from it. One per message, so the message id alone
 * identifies it; there is no second version of an attachment to collide with.
 */
export function attachmentKey(messageId: string): string {
    return `attachments/${idSegment(messageId, 'message id')}.bin`;
}

export function projectPhotoKey(projectId: string, index: number, sha256: string, mime: string): string {
    const idx = Number.isInteger(index) && index >= 0 ? index : 0;
    return `projects/${idSegment(projectId, 'project id')}/${idx}-${sha256.slice(0, 8)}.${extensionForMime(mime)}`;
}

// ── The disk backend ───────────────────────────────────────────────────────────────────────────

/**
 * Objects as files under `<root>` (`/data/images` in production).
 *
 * A write is write-to-temp-then-rename: `rename(2)` within a directory is atomic on every filesystem this
 * runs on, so a reader either sees the whole object or nothing at all — never the half of it that had been
 * flushed when the process died. The temp file carries a random suffix, so two writers of the same key do not
 * corrupt each other's partial file; the loser's rename simply wins second, with identical content-addressed
 * bytes.
 */
export class DiskImageStore implements ImageStore {
    readonly kind = 'disk';
    readonly root: string;

    constructor(root: string) {
        this.root = path.resolve(root);
    }

    /** The absolute path for a key, proven to be inside the root. */
    private pathFor(key: string): string {
        assertSafeKey(key);
        const full = path.resolve(this.root, key);
        // Belt and braces: assertSafeKey already makes an escape impossible, but the check that actually
        // matters is this one — the resolved path is under the root, or nothing happens.
        const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
        if (!full.startsWith(rootWithSep)) throw new ImageStoreError(`Unsafe image store key: ${key}`);
        return full;
    }

    put(key: string, bytes: Buffer, options: PutOptions): StoredObject {
        if (!Buffer.isBuffer(bytes)) throw new ImageStoreError('Image store put needs a Buffer');
        if (bytes.length === 0) throw new ImageStoreError('Refusing to store an empty object');
        if (bytes.length > MAX_OBJECT_BYTES) {
            throw new ImageStoreError(`Object is ${bytes.length} bytes, over the ${MAX_OBJECT_BYTES}-byte limit`);
        }
        const digest = sha256Hex(bytes);
        if (options.sha256 && options.sha256.toLowerCase() !== digest) {
            throw new ImageStoreError('Image store put: the bytes do not match the hash the caller gave');
        }
        const full = this.pathFor(key);
        fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
        const tmp = `${full}.tmp-${crypto.randomBytes(6).toString('hex')}`;
        try {
            // 0o600: an image the node serves is still the community's data, not the host's.
            const fd = fs.openSync(tmp, 'wx', 0o600);
            try {
                fs.writeFileSync(fd, bytes);
                // Durable before the rename, so a crash cannot leave a renamed-but-empty file.
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmp, full);
        } catch (e) {
            try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
            throw e;
        }
        return { key, bytes: bytes.length, sha256: digest, mime: options.mime };
    }

    get(key: string): Buffer | null {
        let full: string;
        try { full = this.pathFor(key); } catch { return null; }
        try {
            return fs.readFileSync(full);
        } catch (e: any) {
            if (e?.code === 'ENOENT') return null;
            throw e;
        }
    }

    head(key: string): { key: string; bytes: number; mtimeMs: number } | null {
        let full: string;
        try { full = this.pathFor(key); } catch { return null; }
        try {
            const st = fs.statSync(full);
            if (!st.isFile()) return null;
            return { key, bytes: st.size, mtimeMs: st.mtimeMs };
        } catch (e: any) {
            if (e?.code === 'ENOENT') return null;
            throw e;
        }
    }

    delete(key: string): boolean {
        let full: string;
        try { full = this.pathFor(key); } catch { return false; }
        try {
            fs.unlinkSync(full);
        } catch (e: any) {
            if (e?.code === 'ENOENT') return false;
            throw e;
        }
        // Tidy the now-empty per-post directory, best effort. rmdir fails harmlessly when it is not empty.
        try { fs.rmdirSync(path.dirname(full)); } catch { /* still has siblings */ }
        return true;
    }

    list(prefix: string): string[] {
        const segments = assertSafePrefix(prefix);
        const base = segments.length === 0 ? this.root : path.resolve(this.root, segments.join('/'));
        const out: string[] = [];
        const walk = (dir: string, rel: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (e: any) {
                if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return;
                throw e;
            }
            for (const entry of entries) {
                const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    walk(path.join(dir, entry.name), childRel);
                } else if (entry.isFile()) {
                    // A half-written object is nobody's business but the writer's.
                    if (entry.name.includes('.tmp-')) continue;
                    out.push(childRel);
                }
            }
        };
        walk(base, segments.join('/'));
        return out;
    }

    /**
     * The `<key>.tmp-<hex>` files a crashed {@link put} or {@link copyObjectReplacing} left behind.
     *
     * Deliberately not part of {@link list}: nothing should ever serve, count or reference one. But that
     * makes them invisible to everything else in the node too — `totalBytes`, the media breakdown and the
     * orphan sweep all walk `list` — so a crash mid-write leaked bytes that nothing could ever find again.
     * The daily sweep is the one caller, and it applies the same grace period it applies to any orphan: a
     * `put` in flight right now looks exactly like this.
     *
     * The names are safe to hand straight to {@link delete}: a temp name is a key segment plus
     * `.tmp-<hex>`, which `assertSafeKey` accepts unchanged.
     */
    listTemporary(): { key: string; bytes: number; mtimeMs: number }[] {
        const out: { key: string; bytes: number; mtimeMs: number }[] = [];
        const walk = (dir: string, rel: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (e: any) {
                if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return;
                throw e;
            }
            for (const entry of entries) {
                const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    walk(path.join(dir, entry.name), childRel);
                } else if (entry.isFile() && entry.name.includes('.tmp-')) {
                    try {
                        const st = fs.statSync(path.join(dir, entry.name));
                        out.push({ key: childRel, bytes: st.size, mtimeMs: st.mtimeMs });
                    } catch { /* gone between the readdir and the stat: nothing to reclaim */ }
                }
            }
        };
        walk(this.root, '');
        return out;
    }

    totalBytes(): number {
        let total = 0;
        for (const key of this.list('')) {
            const h = this.head(key);
            if (h) total += h.bytes;
        }
        return total;
    }
}

/**
 * Copy `from` onto `to` WITHOUT ever writing through an existing inode.
 *
 * The whole hard-link design rests on one rule: a store object is written under a temp name and renamed into
 * place ({@link DiskImageStore.put}), and afterwards it is only ever unlinked. That is what makes a second
 * name for it — a snapshot's captured copy, a backup stage's — a true point-in-time copy rather than a live
 * view. `copyFileSync` straight onto an existing file breaks it: it opens that inode and writes through it,
 * so every other name for the object is rewritten too, silently.
 *
 * `posts/…` and `projects/…` keys are content-addressed, so the bytes would happen to match. But
 * `attachments/<messageId>.bin` is keyed by the message id alone and holds AEAD ciphertext, so the same key
 * in two different backups is two genuinely different objects — and the older snapshot's copy would quietly
 * become the newer one's. Hence: copy beside the destination, then `rename(2)` over it. The rename replaces
 * the directory entry; any other link to the old inode keeps the bytes it always had.
 */
export function copyObjectReplacing(from: string, to: string): void {
    const tmp = `${to}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    try {
        fs.copyFileSync(from, tmp);
        fs.renameSync(tmp, to);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw e;
    }
}

// ── Selection ──────────────────────────────────────────────────────────────────────────────────

/** Where the disk store keeps its objects, beside `state.db` in the data directory. */
export function imagesDir(dataDir?: string): string {
    const base = dataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    return path.join(base, 'images');
}

let cached: ImageStore | null = null;

/** Which backend `IMAGE_STORE` asks for. Throws on a value this version has no backend for. */
export function configuredImageStoreKind(env: NodeJS.ProcessEnv = process.env): 'disk' | 's3' {
    const kind = (env.IMAGE_STORE || 'disk').toLowerCase().trim();
    if (kind === 'disk' || kind === 's3') return kind;
    throw new ImageStoreError(`IMAGE_STORE=${kind} is not a backend this version has. It is "disk" (the default) or "s3".`);
}

/**
 * The node's image store, built once from `IMAGE_STORE` (default `disk`).
 *
 * An unrecognised value, or `s3` with settings missing, is a hard error rather than a silent fall back to
 * disk: a node configured for a bucket must not quietly write everything to a local disk its operator
 * believes is empty. Boot refuses first ({@link checkImageStoreAtBoot}); this is the same rule for anything
 * that asks before then.
 */
export function getImageStore(): ImageStore {
    if (cached) return cached;
    const kind = configuredImageStoreKind();
    cached = kind === 's3' ? new S3ImageStore(s3ConfigFromEnv()) : new DiskImageStore(imagesDir());
    return cached;
}

/** Test seam: drop the memoised store so a suite can point BEANPOOL_DATA_DIR somewhere else. */
export function resetImageStoreForTests(store?: ImageStore | null): void {
    cached = store ?? null;
}

/** Whether objects live in a bucket rather than beside the database, and where, for the backup labels. */
export function bucketOf(store: ImageStore): { bucket: string; endpoint: string; where: string } | null {
    if (store.kind !== 's3') return null;
    const s3 = store as S3ImageStore;
    return { bucket: s3.bucket, endpoint: s3.endpoint, where: s3.describe() };
}

/**
 * Every object on THIS node's disk store, whatever `IMAGE_STORE` says. Used to refuse an s3 boot on a node
 * whose photos are still on its disk.
 */
function countLocalObjects(dataDir?: string): number {
    const local = new DiskImageStore(imagesDir(dataDir));
    let n = 0;
    for (const ns of STORE_NAMESPACES) n += local.list(ns).length;
    return n;
}

/**
 * Run once at boot, before anything serves: refuse loudly rather than start a node that would lose photos.
 *
 * On `disk` there is nothing to check. On `s3`, the node does not start when:
 *
 *   - a setting is missing or unusable (named, never printed);
 *   - this node is a standby. A standby keeps its copy by importing the main server's sync payload, and
 *     sweeps and deletes whatever its own database does not name. Pointed at the main server's bucket — the
 *     natural thing to do with a copy of its .env — that sweep would delete every attachment (they are never
 *     replicated) and every photo a force-resync had just cleared. A standby keeps its photos on its own disk;
 *   - this node's own disk still holds objects. Those are photos and attachments the database points at, and
 *     an s3 node would look for them in the bucket, find nothing, and answer 503 for every one. Moving a node
 *     from disk to a bucket is the migration tool's job, which this version does not have;
 *   - the bucket cannot be reached with these credentials (a HEAD on the bucket).
 *
 * Returns a line for the boot log.
 */
export async function checkImageStoreAtBoot(opts: { role?: string; dataDir?: string } = {}): Promise<string> {
    const kind = configuredImageStoreKind();
    if (kind === 'disk') return `disk (${imagesDir(opts.dataDir)})`;
    const store = getImageStore() as S3ImageStore;
    if (opts.role === 'backup') {
        throw new ImageStoreError(
            'IMAGE_STORE=s3 is not supported on a standby (a node with the backup role) in this version. A standby '
            + 'sweeps objects its own database does not name, so sharing the main server\'s bucket would delete the '
            + 'main server\'s photos and attachments. Unset IMAGE_STORE on the standby: it keeps its copy of the photos '
            + 'on its own disk.',
        );
    }
    const local = countLocalObjects(opts.dataDir);
    if (local > 0) {
        throw new ImageStoreError(
            `IMAGE_STORE=s3 is set, but this node keeps ${local} photo(s) and attachment(s) on its own disk `
            + `(${imagesDir(opts.dataDir)}). With s3 they would not be found and every one would fail to load. Moving `
            + 'a node from disk to a bucket needs the migration tool, which this version does not have: unset '
            + 'IMAGE_STORE to keep running on disk.',
        );
    }
    await store.checkBucket();
    return store.describe();
}

// ── Reaching a store from async code ──────────────────────────────────────────────────────────
//
// On disk these are the sync methods (a local syscall). On S3 they are the async ones, so a caller that is
// already async never holds the event loop for a round trip.

/** Write an object. The same checks and the same result as {@link ImageStore.put}. */
export async function writeObject(store: ImageStore, key: string, bytes: Buffer, options: PutOptions): Promise<StoredObject> {
    return store.putAsync ? store.putAsync(key, bytes, options) : store.put(key, bytes, options);
}

/** The object's bytes, or null when it is not there. */
export async function readObject(store: ImageStore, key: string): Promise<Buffer | null> {
    return store.getAsync ? store.getAsync(key) : store.get(key);
}

/** The object's size and time, or null when it is not there. */
export async function headObject(store: ImageStore, key: string): Promise<ObjectInfo | null> {
    return store.headAsync ? store.headAsync(key) : store.head(key);
}

/** The object as a stream with its size when known, or null when it is not there. */
export async function openObject(store: ImageStore, key: string): Promise<{ stream: Readable; bytes: number | null } | null> {
    if (store.openRead) return store.openRead(key);
    const bytes = store.get(key);
    return bytes ? { stream: Readable.from([bytes]), bytes: bytes.length } : null;
}

/** Every object under `prefix` with size and time: from the listing when the store can, else a head per key. */
export function scanObjects(store: ImageStore, prefix: string): ObjectInfo[] {
    if (store.scan) return store.scan(prefix);
    const out: ObjectInfo[] = [];
    for (const key of store.list(prefix)) {
        const h = store.head(key);
        if (h) out.push(h);
    }
    return out;
}

export async function scanObjectsAsync(store: ImageStore, prefix: string): Promise<ObjectInfo[]> {
    return store.scanAsync ? store.scanAsync(prefix) : scanObjects(store, prefix);
}

/** Every object of ours in the store: the {@link STORE_NAMESPACES}, never anything else in a shared bucket. */
export function scanOurObjects(store: ImageStore): ObjectInfo[] {
    return STORE_NAMESPACES.flatMap((ns) => scanObjects(store, ns));
}

export async function scanOurObjectsAsync(store: ImageStore): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    // One push per object, never `push(...namespace)`: spreading passes every object as an argument, and past
    // ~125k of them (a large node's photos) V8 throws "Maximum call stack size exceeded" — failing the backup,
    // the restore check and the shortfall count that call this.
    for (const ns of STORE_NAMESPACES) {
        for (const o of await scanObjectsAsync(store, ns)) out.push(o);
    }
    return out;
}
