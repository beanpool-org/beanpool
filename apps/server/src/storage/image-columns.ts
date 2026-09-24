/**
 * The bridge between a row that used to hold base64 and the {@link ImageStore} that holds the bytes now.
 *
 * ## The rule everything here exists to keep
 *
 * **A row that has been evacuated must reproduce, byte for byte, the string it used to hold.** Not "an
 * equivalent image" — the same characters. Three things depend on it:
 *
 * 1. `GET /api/marketplace/posts/:id/photos/:n` decodes `photo_data` and serves the bytes. Clients cache
 *    those bytes forever (`immutable`, versioned by `?v=`), so a byte that changes is a byte that is wrong
 *    in a cache we cannot reach.
 * 2. The federation export still ships photo bytes inline (storage design §7 keeps the sync payload frozen
 *    this phase). A peer running any version must receive exactly what it would have received before.
 * 3. `message_attachments.data` is AEAD ciphertext. The node has never held the key, so it cannot re-encrypt
 *    or even check it: one different character and the recipient's decryption fails with no way to tell why.
 *
 * ## How that rule is kept
 *
 * By never *assuming* a round-trip — by performing it and comparing. {@link prepareStorablePhoto} decodes the
 * data URL, re-encodes it from the decoded bytes, and hands back a storable object ONLY when the re-encoding
 * is character-identical to what it was given. Anything else — base64 wrapped across lines (the avatar
 * service documents finding exactly that), non-canonical padding, a `data:` variant we do not model — is
 * reported as not storable, and the caller leaves it inline. Those rows stay in the database and are
 * correct; they are simply not part of the saving.
 *
 * That is why the evacuation job can null a column and know it has lost nothing.
 */

import { getImageStore, sha256Hex, type ImageStore, type StoredObject } from './image-store.js';

/**
 * The route's own parse, deliberately duplicated rather than imported: `^data:([^;]+);base64,(.*)$` with no
 * `s` flag, so a base64 body containing a newline does NOT match here either. Keeping the two in step is the
 * point — whatever the route would decode is what we must be able to reproduce.
 */
const DATA_URL = /^data:([^;]+);base64,(.*)$/;

export interface ParsedDataUrl {
    mime: string;
    base64: string;
}

export function parseDataUrl(value: string): ParsedDataUrl | null {
    if (typeof value !== 'string') return null;
    const m = value.match(DATA_URL);
    if (!m) return null;
    return { mime: m[1], base64: m[2] };
}

export function encodeDataUrl(mime: string, bytes: Buffer): string {
    return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** Bytes ready to go to the store, plus the metadata columns the row keeps. */
export interface StorableBytes {
    bytes: Buffer;
    mime: string;
    sha256: string;
}

/**
 * A post photo's `photo_data` as store bytes, or null when it cannot be reproduced exactly.
 *
 * Null is not a failure — it is the instruction to leave this value inline.
 */
export function prepareStorablePhoto(photoData: string): StorableBytes | null {
    const parsed = parseDataUrl(photoData);
    if (!parsed) return null;
    const bytes = Buffer.from(parsed.base64, 'base64');
    // Buffer.from(…, 'base64') never throws — it silently skips characters outside the alphabet — so an
    // empty or garbage body has to be caught by the round-trip below, not by an exception.
    if (bytes.length === 0) return null;
    if (encodeDataUrl(parsed.mime, bytes) !== photoData) return null;
    return { bytes, mime: parsed.mime, sha256: sha256Hex(bytes) };
}

/**
 * An attachment's `data` — bare base64 ciphertext, no data URL — as store bytes, or null when it cannot be
 * reproduced exactly.
 *
 * `mime` stays in the row: it describes the plaintext the recipient will decrypt to, and the stored object is
 * ciphertext that is not an image of any type. So is `nonce`, which the recipient needs alongside it and
 * which is a few dozen bytes.
 */
export function prepareStorableCiphertext(data: string): StorableBytes | null {
    if (typeof data !== 'string' || data.length === 0) return null;
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0) return null;
    if (bytes.toString('base64') !== data) return null;
    return { bytes, mime: 'application/octet-stream', sha256: sha256Hex(bytes) };
}

// ── Reading a row back ─────────────────────────────────────────────────────────────────────────

/** The columns a post photo row carries after the upgrade. `photo_data` is null once it is evacuated. */
export interface PostPhotoRow {
    photo_data?: string | null;
    storage_key?: string | null;
    sha256?: string | null;
    bytes?: number | null;
    mime?: string | null;
}

/** The columns an attachment row carries after the upgrade. `data` is null once it is evacuated. */
export interface AttachmentRow {
    data?: string | null;
    storage_key?: string | null;
    nonce?: string | null;
    mime?: string | null;
}

/**
 * Thrown when a row says it has been evacuated and the object is not in the store.
 *
 * Deliberately loud. The alternative — quietly serving a 404, or shipping a photo-shaped hole to a peer —
 * hides a node whose images directory has been lost or unmounted, which is exactly the failure an operator
 * must hear about while there is still a backup to restore from.
 */
export class MissingObjectError extends Error {
    readonly key: string;
    constructor(key: string) {
        super(`Image store object is missing: ${key}`);
        this.name = 'MissingObjectError';
        this.key = key;
    }
}

/**
 * The exact `photo_data` string this row stands for — inline when it has not been evacuated, rebuilt from the
 * store when it has. Null only when the row genuinely has neither.
 *
 * Throws {@link MissingObjectError} when the row points at an object that is not there.
 */
export function photoDataOf(row: PostPhotoRow, store: ImageStore): string | null {
    if (typeof row.photo_data === 'string' && row.photo_data.length > 0) return row.photo_data;
    if (!row.storage_key) return null;
    const bytes = store.get(row.storage_key);
    if (!bytes) throw new MissingObjectError(row.storage_key);
    return encodeDataUrl(row.mime || 'image/jpeg', bytes);
}

/**
 * The bytes and content type the photo route serves for this row, or null when the row holds no image.
 *
 * The inline branch reproduces the route's historical behaviour exactly, including its fall back to
 * `image/jpeg` for a bare base64 body with no data-URL prefix.
 */
export function photoBytesOf(row: PostPhotoRow, store: ImageStore): { buffer: Buffer; contentType: string } | null {
    if (typeof row.photo_data === 'string' && row.photo_data.length > 0) {
        const parsed = parseDataUrl(row.photo_data);
        if (parsed) return { buffer: Buffer.from(parsed.base64, 'base64'), contentType: parsed.mime };
        return { buffer: Buffer.from(row.photo_data, 'base64'), contentType: 'image/jpeg' };
    }
    if (!row.storage_key) return null;
    const buffer = store.get(row.storage_key);
    if (!buffer) throw new MissingObjectError(row.storage_key);
    return { buffer, contentType: row.mime || 'image/jpeg' };
}

/** The exact `data` string an attachment row stands for. Throws when an evacuated object is missing. */
export function attachmentDataOf(row: AttachmentRow, store: ImageStore): string | null {
    if (typeof row.data === 'string' && row.data.length > 0) return row.data;
    if (!row.storage_key) return null;
    const bytes = store.get(row.storage_key);
    if (!bytes) throw new MissingObjectError(row.storage_key);
    return bytes.toString('base64');
}

// ── Writing a new one ──────────────────────────────────────────────────────────────────────────

/** What a writer puts in the row: either the store columns, or the inline column as before. */
export interface PhotoColumns {
    photo_data: string | null;
    storage_key: string | null;
    sha256: string | null;
    bytes: number | null;
    mime: string | null;
}

/**
 * Put a new photo's bytes in the store and return the columns to write, falling back to inline storage when
 * the value cannot be reproduced exactly or the store refuses it.
 *
 * A store failure is never a failed post. The node keeps working the way it always did and the evacuation
 * job picks the row up on its next pass, which is the same path every row that predates this version takes.
 */
export function storePhotoColumns(
    store: ImageStore,
    key: (s: StorableBytes) => string,
    photoData: string,
): PhotoColumns {
    const storable = prepareStorablePhoto(photoData);
    if (!storable) return inlinePhotoColumns(photoData);
    let put: StoredObject;
    try {
        put = store.put(key(storable), storable.bytes, { mime: storable.mime, sha256: storable.sha256 });
    } catch (e) {
        console.warn('[ImageStore] Could not store a photo; keeping it in the row for now:', e);
        return inlinePhotoColumns(photoData);
    }
    return { photo_data: null, storage_key: put.key, sha256: put.sha256, bytes: put.bytes, mime: put.mime };
}

export function inlinePhotoColumns(photoData: string): PhotoColumns {
    return { photo_data: photoData, storage_key: null, sha256: null, bytes: null, mime: null };
}

/** What an attachment writer puts in the row. `nonce` and `mime` are the caller's and never move. */
export interface AttachmentColumns {
    data: string | null;
    storage_key: string | null;
}

/**
 * Put an attachment's ciphertext in the store and return the columns to write, falling back to the row when
 * the base64 cannot be reproduced exactly or the store refuses it.
 *
 * A failure here must never fail the message: the ciphertext goes in the row as it always did, and the
 * evacuation job will try again.
 */
export function storeAttachmentColumns(store: ImageStore, key: string, data: string): AttachmentColumns {
    const storable = prepareStorableCiphertext(data);
    if (!storable) return { data, storage_key: null };
    try {
        const put = store.put(key, storable.bytes, { mime: storable.mime, sha256: storable.sha256 });
        return { data: null, storage_key: put.key };
    } catch (e) {
        console.warn('[ImageStore] Could not store an attachment; keeping it in the row for now:', e);
        return { data, storage_key: null };
    }
}

/**
 * Delete objects whose rows have already gone — always from an `afterTransactionCommit` hook.
 *
 * Never throws. It runs after the transaction that removed the rows has committed, where there is nothing
 * left to roll back and no caller to return an error to; a file that will not unlink is a warning and an
 * orphan for the storage-health sweep, not a failed delete for the member who asked for one. The order —
 * row first, object second — is what makes a lingering file unservable: every serving path reads the row.
 */
export function deleteStoredObjects(keys: Iterable<string>, store?: ImageStore): number {
    let removed = 0;
    let s: ImageStore;
    try {
        s = store ?? getImageStore();
    } catch (e) {
        console.warn('[ImageStore] No store to delete from:', e);
        return 0;
    }
    for (const key of keys) {
        if (!key) continue;
        try {
            if (s.delete(key)) removed++;
        } catch (e) {
            console.warn(`[ImageStore] Could not delete ${key}:`, e);
        }
    }
    return removed;
}
