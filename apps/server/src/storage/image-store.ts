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
 * Deliberately narrow — put/get/head/delete/list over an opaque string key — so an S3/R2 backend (the global
 * node, a later phase) can slot in behind {@link ImageStore} without a single caller changing. Keys are
 * content-addressed inside namespaces (`posts/…`, `attachments/…`, `projects/…`), so the same bytes written
 * twice land on the same object and a re-run of the evacuation job is a no-op rather than a duplicate.
 *
 * ## Synchronous, on purpose
 *
 * `put` is called from inside `db.transaction(() => …)` bodies, which better-sqlite3 runs synchronously — an
 * `await` in there commits the transaction at the first suspension point. Until the async port lands (the
 * storage design §2) the store is sync too. Every method is a handful of syscalls on a local file.
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

/**
 * A place image bytes live. Implemented by {@link DiskImageStore}; an S3/R2 implementation slots in here.
 *
 * Every method is synchronous — see the note at the top of this file.
 */
export interface ImageStore {
    /** The backend's name, for logs and the storage-health report. */
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
    /** Total bytes held, for the disk-usage report. */
    totalBytes(): number;
}

export class ImageStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImageStoreError';
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
function assertSafePrefix(prefix: string): string[] {
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

/**
 * The node's image store, built once from `IMAGE_STORE` (default `disk`).
 *
 * An unrecognised value is a hard error rather than a silent fall back to disk: a node configured
 * `IMAGE_STORE=s3` before the S3 backend ships must not quietly write everything to a local disk its operator
 * believes is empty.
 */
export function getImageStore(): ImageStore {
    if (cached) return cached;
    const kind = (process.env.IMAGE_STORE || 'disk').toLowerCase().trim();
    if (kind !== 'disk') {
        throw new ImageStoreError(`IMAGE_STORE=${kind} is not a backend this version has. The only one is "disk".`);
    }
    cached = new DiskImageStore(imagesDir());
    return cached;
}

/** Test seam: drop the memoised store so a suite can point BEANPOOL_DATA_DIR somewhere else. */
export function resetImageStoreForTests(store?: ImageStore | null): void {
    cached = store ?? null;
}
