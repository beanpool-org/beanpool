/**
 * A listing photo's focus: the part of the photo a card's crop keeps (Marty, 26 Nov 2026, from a first post on a community:
 * "she wanted to be able to select the area of the photo being displayed in the cropped view on the card, as part of the
 * photo was cut off").
 *
 * Not a second copy of the photo: a post keeps its one 800 px copy of each (photos-stay-800px), and a card draws it with
 * `object-position` (web) or `contentPosition` (phone) at the focus. `x` is across and `y` is down, each 0 to 1, read exactly
 * as CSS reads `object-position` percentages: 0 keeps the left (top) edge, 1 the right (bottom) edge. The full-size view
 * always shows the whole photo.
 *
 * A post carries them as `photoFocus`, beside `photos` and in the same order (the n-th entry is the n-th photo's), `null` for
 * a photo with none. A photo with none is drawn as every card drew it before focus points: the card's own default, which
 * for the grid card is DEFAULT_PHOTO_FOCUS (MARKET_CARD_SHELL.photo.grid's 50% across, 33% down). An app or a server from
 * before them sends and keeps none, and nothing is converted.
 *
 * Pure: no I/O, no Node built-ins, no regular expressions (the barrel is bundled for the phone, barrel-is-universal.test.ts).
 */

/** One photo's focus: across (`x`) and down (`y`), each 0 to 1. */
export interface PhotoFocus {
    readonly x: number;
    readonly y: number;
}

/** The grid card's crop with no focus: 50% across, 33% down (MARKET_CARD_SHELL.photo.grid cropX / cropY). */
export const DEFAULT_PHOTO_FOCUS: PhotoFocus = { x: 0.5, y: 0.33 };

/** A post holds at most this many photos, so at most this many focus points. */
const MOST_FOCUS_POINTS = 5;

/** Three places: a thousandth of an 800 px photo is under a pixel, and the stored list stays short. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** One focus as sent or stored: an object of two numbers, each 0 to 1. Anything else is none (`null`), never an error. */
export function photoFocusOf(raw: unknown): PhotoFocus | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { x, y } = raw as { x?: unknown; y?: unknown };
    if (!isUnit(x) || !isUnit(y)) return null;
    return { x: round3(x), y: round3(y) };
}

/**
 * A post's focus points as sent, for `photoCount` photos: each entry held to photoFocusOf (a bad one is that photo's none),
 * entries past the last photo dropped. `null` when the list is not an array or holds no focus at all, so a post with none
 * stores none.
 */
export function photoFocusList(raw: unknown, photoCount: number): Array<PhotoFocus | null> | null {
    if (!Array.isArray(raw)) return null;
    const count = Math.max(0, Math.min(MOST_FOCUS_POINTS, Math.floor(photoCount)));
    const list = raw.slice(0, count).map(photoFocusOf);
    while (list.length > 0 && list[list.length - 1] === null) list.pop();
    return list.some((f) => f !== null) ? list : null;
}

/** The list as `posts.photo_focus` holds it: JSON, or NULL for none. */
export function storedPhotoFocus(list: ReadonlyArray<PhotoFocus | null> | null | undefined): string | null {
    const clean = photoFocusList(list ?? null, MOST_FOCUS_POINTS);
    return clean ? JSON.stringify(clean) : null;
}

/** `posts.photo_focus` read back, tolerantly: anything that is not a stored list is none. */
export function photoFocusFromStored(stored: unknown): Array<PhotoFocus | null> | null {
    if (typeof stored !== 'string' || stored === '') return null;
    try {
        return photoFocusList(JSON.parse(stored), MOST_FOCUS_POINTS);
    } catch {
        return null;
    }
}

/** The focus of a post's photo at `index`, or `null` when it has none (an old post, or a photo never adjusted). */
export function photoFocusAt(post: { photoFocus?: ReadonlyArray<PhotoFocus | null> | null } | null | undefined, index = 0): PhotoFocus | null {
    const list = post?.photoFocus;
    if (!Array.isArray(list)) return null;
    return photoFocusOf(list[index]);
}

/**
 * A form's focus points while it is written, held by the photo each one belongs to (its data URL or its address), never by
 * its place in a list. Whatever a form does to its photos (one taken off, several added in one pick, the order changed, the
 * list put in whole from a draft, a tool or a post), each photo's focus stays with that photo, and a photo the form holds no
 * focus for has none. No list of focus points is kept beside the photos to fall out of step with them (review of #3390: a
 * tool's draft put in whole posted with another photo's focus). Two copies of the very same photo share its one focus.
 */
export type PhotoFocusByPhoto = ReadonlyMap<string, PhotoFocus>;

/** No focus held: a form opened empty, or put in whole from photos that carry none (a draft, a tool's photos). */
export const NO_PHOTO_FOCUS: PhotoFocusByPhoto = new Map();

/**
 * The focus held by photo for a post's `photos` and its focus points, in the same order: `photoFocus` as sent (a list), or
 * `posts.photo_focus` as stored (its JSON). A photo with none holds none; anything unreadable is none.
 */
export function photoFocusByPhoto(photos: ReadonlyArray<unknown> | null | undefined, focus: unknown): Map<string, PhotoFocus> {
    const list = typeof focus === 'string' ? photoFocusFromStored(focus) : photoFocusList(focus, MOST_FOCUS_POINTS);
    const held = new Map<string, PhotoFocus>();
    (Array.isArray(photos) ? photos : []).slice(0, MOST_FOCUS_POINTS).forEach((photo, i) => {
        const f = list?.[i] ?? null;
        if (typeof photo === 'string' && photo !== '' && f && !held.has(photo)) held.set(photo, f);
    });
    return held;
}

/** The focus held for `photo`, or `null` for none. */
export function photoFocusOfPhoto(held: PhotoFocusByPhoto, photo: string | null | undefined): PhotoFocus | null {
    return photo ? held.get(photo) ?? null : null;
}

/** `held` with `photo`'s focus set, or taken off for `null`: a new map, so a React form sees the change. */
export function withPhotoFocus(held: PhotoFocusByPhoto, photo: string, focus: PhotoFocus | null): Map<string, PhotoFocus> {
    const next = new Map(held);
    const clean = photoFocusOf(focus);
    if (clean) next.set(photo, clean);
    else next.delete(photo);
    return next;
}

/**
 * The `photoFocus` to send for `photos` as the form holds them now: each photo's own focus, in the photos' order, `null` for
 * a photo with none; `null` when none has one (photoFocusList), so a post with none sends none.
 */
export function photoFocusForPhotos(photos: ReadonlyArray<string>, held: PhotoFocusByPhoto): Array<PhotoFocus | null> | null {
    return photoFocusList(photos.map((p) => held.get(p) ?? null), photos.length);
}

/**
 * The photo whose Adjust screen is open, and the photos it walks through (Marty, 28 Nov 2026: "when you add photo(s) it should
 * come up with the visible area thing for each photo once you add them and maybe a next button if there are more than one").
 * A pick of new photos opens Adjust on the first of them by itself and walks through them in order (`photos`, at `at`); a
 * tap on one photo of the form opens it alone (`photos` is that one photo). Photos already on the form, and an edit's photos
 * as it opens, are never in a walk: only the photos one pick added.
 */
export interface PhotoFocusShowing {
    readonly photos: readonly string[];
    readonly at: number;
}

/**
 * Adjust opened on `photos`, from the first: the photos one pick just added (each once, in the order picked: two copies of
 * the very same photo share its one focus), or the one photo tapped. `null` when there is none to show.
 */
export function photoFocusShowingOf(photos: ReadonlyArray<unknown> | null | undefined): PhotoFocusShowing | null {
    const once: string[] = [];
    for (const p of Array.isArray(photos) ? photos : []) {
        if (typeof p === 'string' && p !== '' && !once.includes(p)) once.push(p);
    }
    return once.length > 0 ? { photos: once.slice(0, MOST_FOCUS_POINTS), at: 0 } : null;
}

/** The photo on screen, or `null` with Adjust closed. */
export function photoFocusShowingPhoto(showing: PhotoFocusShowing | null): string | null {
    return showing ? showing.photos[showing.at] ?? null : null;
}

/**
 * Where a walk through several new photos stands, for its button: the photo on screen as `n` of `count`, and whether photos
 * are still to come (the button reads Next, and Skip is offered). `null` with one photo or none: the button reads Done.
 */
export function photoFocusShowingStep(showing: PhotoFocusShowing | null): { n: number; count: number; more: boolean } | null {
    if (!showing || showing.photos.length < 2) return null;
    return { n: showing.at + 1, count: showing.photos.length, more: showing.at < showing.photos.length - 1 };
}

/** After Next or Done on the photo on screen: the next photo of the walk, or `null` (closed) after the last. */
export function photoFocusShowingNext(showing: PhotoFocusShowing | null): PhotoFocusShowing | null {
    if (!showing || showing.at >= showing.photos.length - 1) return null;
    return { photos: showing.photos, at: showing.at + 1 };
}

/** A focus as two percentages, for the phone's `contentPosition` and the web's `object-position`. */
export function photoFocusPercent(focus: PhotoFocus): { left: number; top: number } {
    return { left: round3(focus.x * 100), top: round3(focus.y * 100) };
}

/** A focus as a CSS `object-position` value, e.g. `50% 33%`. */
export function photoFocusObjectPosition(focus: PhotoFocus): string {
    const { left, top } = photoFocusPercent(focus);
    return `${left}% ${top}%`;
}

/**
 * Where a frame of `frameAspect` (width / height) sits over a photo of `photoAspect` when the photo is cropped to it at
 * `focus`, as fractions of the photo: what a card shows of it. The adjust screen draws this box over the whole photo, so what
 * the member sees inside it is exactly what the card shows (object-position: the frame starts `focus` of the way along the
 * photo's spare width or height).
 */
export function photoFocusWindow(photoAspect: number, frameAspect: number, focus: PhotoFocus): { left: number; top: number; width: number; height: number } {
    if (!(photoAspect > 0) || !(frameAspect > 0)) return { left: 0, top: 0, width: 1, height: 1 };
    // Photo wider than the frame: the frame takes its full height and part of its width; else its full width.
    const width = photoAspect > frameAspect ? frameAspect / photoAspect : 1;
    const height = photoAspect > frameAspect ? 1 : photoAspect / frameAspect;
    return { left: (1 - width) * focus.x, top: (1 - height) * focus.y, width, height };
}

/**
 * The focus that puts the frame's centre as near as it can go to a point on the photo (`px`, `py`, fractions of it), as a
 * tap or a drag on the adjust screen asks. An axis the frame cannot move along (the photo has no spare width or height for
 * it) keeps `from`'s value.
 */
export function photoFocusToward(photoAspect: number, frameAspect: number, px: number, py: number, from: PhotoFocus = DEFAULT_PHOTO_FOCUS): PhotoFocus {
    const box = photoFocusWindow(photoAspect, frameAspect, from);
    const along = (point: number, size: number, was: number): number => {
        const spare = 1 - size;
        if (spare <= 0.0005) return was;
        const start = Math.min(spare, Math.max(0, point - size / 2));
        return round3(start / spare);
    };
    return { x: along(px, box.width, from.x), y: along(py, box.height, from.y) };
}
