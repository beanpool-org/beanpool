/**
 * A listing photo's small copy, for the lists: ~200 px on its longest side, ~10 KB (Marty, board, 9 Oct).
 *
 * ## Why
 *
 * A Market page of 20 rows downloaded 20 full photos (up to 800 px, 60-120 KB each) to draw 20 squares of 56-120 dp.
 * The communities this is for are on old Android phones and prepaid data. The detail screen keeps the 800 px photo,
 * and there is no bigger copy anywhere (photos stay 800 px).
 *
 * ## Where it lives
 *
 * In the image store beside its photo, never in state.db: `posts/<id>/<n>-<sha8>.jpg` has its small copy at
 * `posts/<id>/<n>-<sha8>-t.jpg` ({@link thumbnailKeyOf}). The key is the photo's own, so it is content-addressed as
 * the photo is: a photo replaced is a new key and a new small copy, and the old pair answers to no row. The orphan
 * sweep (engine/storage-health.ts) keeps a small copy exactly while some row names its photo, and the delete paths
 * that remove a photo's object remove its small copy with it (image-columns.ts deleteStoredObjects). No row, backup
 * or copy carries one: a node restored, a standby taking over or a bucket moved makes each again on its first request.
 *
 * ## When it is made
 *
 * When a member's photo is stored ({@link queueThumbnail}, after the put, off the request), and for a photo stored
 * before this (no boot migration) on the first request for it ({@link openThumbnailOf}), which keeps it. One at a
 * time, and one per key however many ask at once: a 1 vCPU node is never asked to resize a page of photos together.
 *
 * ## What it is
 *
 * The same format family as the photo: a JPEG's small copy is a JPEG, a WebP's a WebP, a PNG's a palette PNG (its
 * transparency kept). Turned upright from its EXIF orientation, as the apps draw the photo, and with no metadata of
 * its own. A photo already that small, or one whose small copy would be no smaller, is its own small copy: the same
 * bytes, under the small copy's key. A photo it cannot read (not an image, a format it doesn't make, a decoder bomb)
 * has none, and the route serves the photo itself.
 */

import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { openObject, readObject, writeObject, type ImageStore } from './image-store.js';

/** The longest side of a small copy, in pixels. Lists draw photos at 56-120 dp; 200 px is sharp at 1.5-2× density. */
export const THUMB_MAX_SIDE = 200;

/** The decoder's ceiling: an 800 px photo is 0.64 MP; a row from a peer or a backup claiming more is not decoded. */
const MAX_INPUT_PIXELS = 4096 * 4096;

// One resize at a time, on one thread, and nothing kept in libvips' operation cache: a small node's memory and CPU
// belong to its members' requests.
sharp.concurrency(1);
sharp.cache(false);

/** `posts/<id>/<n>-<sha8>.<ext>`, the shape image-store.ts postPhotoKey makes. Only these have a small copy. */
const PHOTO_KEY = /^(posts\/[A-Za-z0-9][A-Za-z0-9._-]*\/\d+-[0-9a-f]{8})\.(jpg|png|webp)$/;

const MIME_OF_EXT: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/**
 * The key a photo's small copy is kept under, from the photo's own key, or null for a key that has none: a photo kept
 * in its row (no key), or a key image-store.ts did not make in the shape it makes today.
 */
export function thumbnailKeyOf(photoKey: string | null | undefined): string | null {
    if (typeof photoKey !== 'string') return null;
    const m = PHOTO_KEY.exec(photoKey);
    return m ? `${m[1]}-t.${m[2]}` : null;
}

function mimeOfKey(key: string): string {
    return MIME_OF_EXT[key.slice(key.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
}

/**
 * The small copy of these photo bytes, in the format family of the key's extension. The photo itself when it is
 * already no bigger than a small copy would be; null when it can't be read.
 */
export async function makeThumbnail(photo: Buffer, thumbKey: string): Promise<Buffer | null> {
    const ext = thumbKey.slice(thumbKey.lastIndexOf('.') + 1);
    let image: sharp.Sharp;
    try {
        image = sharp(photo, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
            .rotate()
            .resize({ width: THUMB_MAX_SIDE, height: THUMB_MAX_SIDE, fit: 'inside', withoutEnlargement: true });
        if (ext === 'jpg') image = image.jpeg({ quality: 70, mozjpeg: true });
        else if (ext === 'webp') image = image.webp({ quality: 70, effort: 4 });
        else if (ext === 'png') image = image.png({ palette: true, colours: 128, quality: 70, compressionLevel: 9, effort: 10 });
        else return null;
        const out = await image.toBuffer();
        return out.length < photo.length ? out : photo;
    } catch {
        return null;
    }
}

/** Resizes waiting their turn, one at a time (see the top of this file). */
let queue: Promise<unknown> = Promise.resolve();
/** The small copy being made for each key now, so a second request for it waits on the first. */
const inFlight = new Map<string, Promise<Buffer | null>>();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
}

/**
 * Make the small copy of a photo whose bytes are `photo`, kept under `thumbKey`, and keep it. Its bytes, or null when
 * it can't be made; a store that refuses the write still gets the bytes served this once.
 */
function makeAndKeep(store: ImageStore, thumbKey: string, photo: () => Promise<Buffer | null>): Promise<Buffer | null> {
    const pending = inFlight.get(thumbKey);
    if (pending) return pending;
    const made = oneAtATime(async () => {
        const bytes = await photo();
        if (!bytes) return null;
        const thumb = await makeThumbnail(bytes, thumbKey);
        if (!thumb) return null;
        try {
            await writeObject(store, thumbKey, thumb, { mime: mimeOfKey(thumbKey) });
        } catch (e) {
            console.warn(`[Thumbnails] Could not keep ${thumbKey}:`, e);
        }
        return thumb;
    }).finally(() => inFlight.delete(thumbKey));
    inFlight.set(thumbKey, made);
    return made;
}

/**
 * Make a new photo's small copy, off the request that stored it: for an upload, after its object is put. Never throws
 * and is never waited on; a copy that fails here is made on its first request instead.
 */
export function queueThumbnail(store: ImageStore, photoKey: string, photo: Buffer): void {
    const thumbKey = thumbnailKeyOf(photoKey);
    if (!thumbKey) return;
    void makeAndKeep(store, thumbKey, async () => photo).catch(() => undefined);
}

/**
 * The small copy of the photo whose object is `photoKey`, to serve: from the store when it is kept there, made and
 * kept when it is not. Null when the photo has none ({@link thumbnailKeyOf}) or it can't be made: the caller serves
 * the photo itself, through its own path, which says what a missing photo object means.
 */
export async function openThumbnailOf(store: ImageStore, photoKey: string | null | undefined):
    Promise<{ body: Buffer | Readable; contentType: string; bytes: number | null } | null> {
    const thumbKey = thumbnailKeyOf(photoKey);
    if (!thumbKey) return null;
    const contentType = mimeOfKey(thumbKey);
    const kept = await openObject(store, thumbKey);
    if (kept) return { body: kept.stream, contentType, bytes: kept.bytes };
    const made = await makeAndKeep(store, thumbKey, () => readObject(store, photoKey!));
    return made ? { body: made, contentType, bytes: made.length } : null;
}

/** For the suites: resolves once every small copy queued so far is made and kept. */
export async function thumbnailsSettled(): Promise<void> {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
}
