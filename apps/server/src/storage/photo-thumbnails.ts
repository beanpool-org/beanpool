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
 *
 * ## What it will not read
 *
 * The node's photo check (engine/avatar.ts) looks at a photo's bytes, not its size in pixels, and a ~130 KB PNG can be
 * 16,777,216×1 px: a decoder needs over a gigabyte for that, and a 1 GB node is killed (review opus-1742 #1, measured
 * OOM in a 1 GB container). So the header is read first and a photo with a side over {@link MAX_INPUT_SIDE} is never
 * decoded. And a photo that gives no copy is remembered ({@link unmakeable}), so it is read at most once per process
 * however often the lists ask for it: a copy that can't be made is never kept, and would otherwise be tried again on
 * every request.
 *
 * sharp is a native module, loaded on the first copy made ({@link loadSharp}), not with the node: a host whose CPU or
 * platform its binary refuses still boots, and its lists get each photo itself (review opus-1742 #2).
 */

import type { Readable } from 'node:stream';
import type sharp from 'sharp';
import { deleteObjectUnless, headObject, openObject, readObject, writeObject, type ImageStore } from './image-store.js';

/** The longest side of a small copy, in pixels. Lists draw photos at 56-120 dp; 200 px is sharp at 1.5-2× density. */
export const THUMB_MAX_SIDE = 200;

/**
 * The decoder's ceiling, a side and the pixels it allows: photos are stored at most 800 px on a side (Marty, photos stay
 * 800 px), so this is 2.5× room; a row from a peer or a backup claiming more is not decoded.
 */
const MAX_INPUT_SIDE = 2048;
const MAX_INPUT_PIXELS = MAX_INPUT_SIDE * MAX_INPUT_SIDE;

/**
 * The small copies that could not be made, by key, so their photos are not read again in this process. Keys are
 * content-addressed (a photo replaced is a new key), so a copy that couldn't be made from a key's bytes never can be.
 * Bounded: past {@link UNMAKEABLE_MAX} the oldest is forgotten, and is read once more if it is asked for again.
 */
const unmakeable = new Set<string>();
const UNMAKEABLE_MAX = 10_000;
/** How many photos have been read to make a small copy, header or more, in this process. For the suites. */
let reads = 0;
export function thumbnailReads(): number {
    return reads;
}

let sharpLoaded: Promise<typeof sharp | null> | null = null;

/** sharp, loaded once; null, logged once, where it won't load. */
function loadSharp(): Promise<typeof sharp | null> {
    sharpLoaded ??= import('sharp').then(m => {
        const lib = m.default;
        // One resize at a time, on one thread, and nothing kept in libvips' operation cache: a small node's memory and
        // CPU belong to its members' requests.
        lib.concurrency(1);
        lib.cache(false);
        return lib;
    }, (e: unknown) => {
        console.warn('[Thumbnails] sharp did not load, so lists get each photo itself:', e instanceof Error ? e.message : e);
        return null;
    });
    return sharpLoaded;
}

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
    const lib = await loadSharp();
    if (!lib) return null;
    reads++;
    try {
        // The header alone first: a side the decoder would need gigabytes for is refused before any pixel is read.
        const head = await lib(photo, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
        if (!head.width || !head.height || head.width > MAX_INPUT_SIDE || head.height > MAX_INPUT_SIDE) return null;
        image = lib(photo, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
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
 * Make the small copy of the photo whose object is `photoKey` and whose bytes are `photo`, and keep it. Its bytes, or
 * null when it can't be made; a store that refuses the write still gets the bytes served this once.
 *
 * Its photo can be deleted while it is being made: a listing removed the moment after it was posted, an edit that
 * replaced the photo. The delete paths remove the photo's object and then its small copy (image-columns.ts
 * deleteStoredObjects), so a small copy written after that would outlive its photo until the orphan sweep. So once it
 * is written, the photo is looked for again, and a small copy whose photo has gone is removed: whichever order the two
 * land in, none is left behind.
 */
function makeAndKeep(store: ImageStore, photoKey: string, thumbKey: string, photo: () => Promise<Buffer | null>): Promise<Buffer | null> {
    if (unmakeable.has(thumbKey)) return Promise.resolve(null);
    const pending = inFlight.get(thumbKey);
    if (pending) return pending;
    const made = oneAtATime(async () => {
        const bytes = await photo();
        if (!bytes) return null;
        const thumb = await makeThumbnail(bytes, thumbKey);
        if (!thumb) {
            if (unmakeable.size >= UNMAKEABLE_MAX) unmakeable.delete(unmakeable.values().next().value!);
            unmakeable.add(thumbKey);
            return null;
        }
        try {
            await writeObject(store, thumbKey, thumb, { mime: mimeOfKey(thumbKey) });
            if (!(await headObject(store, photoKey))) {
                await deleteObjectUnless(store, thumbKey, () => false);
                return null;
            }
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
    void makeAndKeep(store, photoKey, thumbKey, async () => photo).catch(() => undefined);
}

/**
 * The small copy of the photo whose object is `photoKey`, to serve: from the store when it is kept there, made and
 * kept when it is not. Null when the photo has none ({@link thumbnailKeyOf}) or it can't be made: the caller serves
 * the photo itself, through its own path, which says what a missing photo object means.
 */
export async function openThumbnailOf(store: ImageStore, photoKey: string | null | undefined):
    Promise<{ body: Buffer | Readable; contentType: string; bytes: number | null } | null> {
    const thumbKey = thumbnailKeyOf(photoKey);
    if (!thumbKey || unmakeable.has(thumbKey)) return null;
    const contentType = mimeOfKey(thumbKey);
    const kept = await openObject(store, thumbKey);
    if (kept) return { body: kept.stream, contentType, bytes: kept.bytes };
    const made = await makeAndKeep(store, photoKey!, thumbKey, () => readObject(store, photoKey!));
    return made ? { body: made, contentType, bytes: made.length } : null;
}

/** Small copies being removed now. */
const removing = new Set<Promise<unknown>>();

/**
 * Remove the small copy of the photo whose object is `photoKey`, with its photo (image-columns.ts deleteStoredObjects).
 * Off the event loop: on a bucket the store's own delete blocks for a HEAD and a DELETE, and a listing's delete held the
 * loop half as long again for them (review opus-1742 #3). Never throws and is never waited on; one it fails to remove
 * is an orphan the storage-health sweep collects.
 */
export function removeThumbnailOf(store: ImageStore, photoKey: string): void {
    const thumbKey = thumbnailKeyOf(photoKey);
    if (!thumbKey) return;
    const done: Promise<unknown> = deleteObjectUnless(store, thumbKey, () => false)
        .catch(e => console.warn(`[ImageStore] Could not delete ${thumbKey}:`, e))
        .finally(() => removing.delete(done));
    removing.add(done);
}

/** For the suites: resolves once every small copy queued so far is made and kept, and every one being removed is gone. */
export async function thumbnailsSettled(): Promise<void> {
    while (inFlight.size > 0 || removing.size > 0) await Promise.allSettled([...inFlight.values(), ...removing]);
}
