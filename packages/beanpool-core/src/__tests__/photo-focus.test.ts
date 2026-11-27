import { describe, it, expect } from 'vitest';
import {
    DEFAULT_PHOTO_FOCUS, MARKET_CARD_SHELL, photoFocusAt, photoFocusFromStored, photoFocusList, photoFocusObjectPosition, photoFocusOf,
    photoFocusPercent, photoFocusToward, photoFocusWindow, storedPhotoFocus,
    NO_PHOTO_FOCUS, photoFocusByPhoto, photoFocusForPhotos, photoFocusOfPhoto, withPhotoFocus, type PhotoFocus, type PhotoFocusByPhoto,
    photoFocusShowingNext, photoFocusShowingOf, photoFocusShowingPhoto, photoFocusShowingStep, type PhotoFocusShowing,
} from '../index.js';
import { checkPhotoFocusRunVectors, checkPhotoFocusVectors, type PhotoFocusFormDriver, type PhotoFocusRunDriver } from '../photo-focus-vectors.js';

describe('photo focus (a card crop the member picks, Marty 26 Nov 2026)', () => {
    it('no focus is the grid card\'s crop today: 50% across, 33% down', () => {
        const { cropX, cropY } = MARKET_CARD_SHELL.photo.grid;
        expect(photoFocusPercent(DEFAULT_PHOTO_FOCUS)).toEqual({ left: cropX, top: cropY });
        expect(photoFocusObjectPosition(DEFAULT_PHOTO_FOCUS)).toBe('50% 33%');
    });

    // One focus as sent: two numbers 0..1, else none (dropped, never an error).
    const ONE: Array<[string, unknown, ReturnType<typeof photoFocusOf>]> = [
        ['a focus', { x: 0.25, y: 0.75 }, { x: 0.25, y: 0.75 }],
        ['the corners', { x: 0, y: 1 }, { x: 0, y: 1 }],
        ['rounded to 3 places', { x: 0.123456, y: 0.9999 }, { x: 0.123, y: 1 }],
        ['extra fields left behind', { x: 0.5, y: 0.5, z: 9 }, { x: 0.5, y: 0.5 }],
        ['x above 1', { x: 1.01, y: 0.5 }, null],
        ['y below 0', { x: 0.5, y: -0.01 }, null],
        ['a string number', { x: '0.5', y: 0.5 }, null],
        ['NaN', { x: Number.NaN, y: 0.5 }, null],
        ['Infinity', { x: 0.5, y: Number.POSITIVE_INFINITY }, null],
        ['y missing', { x: 0.5 }, null],
        ['an array', [0.5, 0.5], null],
        ['null', null, null],
        ['undefined', undefined, null],
        ['a number', 0.5, null],
        ['a string', '{"x":0.5,"y":0.5}', null],
    ];
    it.each(ONE)('photoFocusOf: %s', (_name, raw, want) => {
        expect(photoFocusOf(raw)).toEqual(want);
    });

    // A post's list as sent, for so many photos.
    const LIST: Array<[string, unknown, number, ReturnType<typeof photoFocusList>]> = [
        ['absent', undefined, 3, null],
        ['not an array', { x: 0.5, y: 0.5 }, 1, null],
        ['empty', [], 2, null],
        ['all none', [null, null], 2, null],
        ['one per photo', [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], 2, [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }]],
        ['a bad entry is that photo\'s none', [{ x: 2, y: 0 }, { x: 0.3, y: 0.4 }], 2, [null, { x: 0.3, y: 0.4 }]],
        ['past the last photo dropped', [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], 1, [{ x: 0.1, y: 0.2 }]],
        ['trailing nones trimmed', [{ x: 0.1, y: 0.2 }, null, null], 3, [{ x: 0.1, y: 0.2 }]],
        ['no photos, no focus', [{ x: 0.1, y: 0.2 }], 0, null],
        ['never more than five', Array.from({ length: 9 }, () => ({ x: 0.5, y: 0.5 })), 9, Array.from({ length: 5 }, () => ({ x: 0.5, y: 0.5 }))],
    ];
    it.each(LIST)('photoFocusList: %s', (_name, raw, count, want) => {
        expect(photoFocusList(raw, count)).toEqual(want);
    });

    it('stored and read back: a round trip, and none as NULL', () => {
        const list = [null, { x: 0.2, y: 0.8 }];
        const stored = storedPhotoFocus(list);
        expect(stored).toBe('[null,{"x":0.2,"y":0.8}]');
        expect(photoFocusFromStored(stored)).toEqual(list);
        expect(storedPhotoFocus(null)).toBeNull();
        expect(storedPhotoFocus([null])).toBeNull();
        for (const odd of [null, '', 'not json', '{"x":0.5}', '42', 7]) expect(photoFocusFromStored(odd)).toBeNull();
    });

    it('photoFocusAt: a photo\'s own focus, or none', () => {
        const post = { photoFocus: [null, { x: 0.2, y: 0.8 }] };
        expect(photoFocusAt(post, 0)).toBeNull();
        expect(photoFocusAt(post, 1)).toEqual({ x: 0.2, y: 0.8 });
        expect(photoFocusAt(post, 4)).toBeNull();
        expect(photoFocusAt({}, 0)).toBeNull();
        expect(photoFocusAt(null)).toBeNull();
        expect(photoFocusAt({ photoFocus: [{ x: 5, y: 5 }] as any })).toBeNull();
    });

    it('the frame over the photo is what object-position shows', () => {
        // An upright 3:4 photo in the 4:3 card: full width, 9/16 of the height, starting y of the way down the spare 7/16.
        const upright = photoFocusWindow(3 / 4, 4 / 3, { x: 0.5, y: 0 });
        expect(upright).toEqual({ left: 0, top: 0, width: 1, height: 9 / 16 });
        const low = photoFocusWindow(3 / 4, 4 / 3, { x: 0.5, y: 1 });
        expect(low.top + low.height).toBeCloseTo(1, 10);
        // A wide 2:1 photo: full height, 2/3 of the width.
        const wide = photoFocusWindow(2, 4 / 3, { x: 0.5, y: 0.33 });
        expect(wide.width).toBeCloseTo(2 / 3, 10);
        expect(wide.left).toBeCloseTo(1 / 6, 10);
        expect(wide.height).toBe(1);
        // The same shape as the frame: nothing to move.
        expect(photoFocusWindow(4 / 3, 4 / 3, { x: 1, y: 1 })).toEqual({ left: 0, top: 0, width: 1, height: 1 });
        // Nonsense sizes show the whole photo.
        expect(photoFocusWindow(0, 4 / 3, DEFAULT_PHOTO_FOCUS)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
    });

    it('a tap centres the frame on the point, as far as it can go', () => {
        // Upright photo: only up and down moves; across keeps what it was.
        expect(photoFocusToward(3 / 4, 4 / 3, 0.9, 0, { x: 0.5, y: 0.33 })).toEqual({ x: 0.5, y: 0 });
        expect(photoFocusToward(3 / 4, 4 / 3, 0.1, 1, { x: 0.5, y: 0.33 })).toEqual({ x: 0.5, y: 1 });
        expect(photoFocusToward(3 / 4, 4 / 3, 0.5, 0.5)).toEqual({ x: 0.5, y: 0.5 });
        // Wide photo: only across moves.
        expect(photoFocusToward(2, 4 / 3, 0, 0.9, { x: 0.5, y: 0.33 })).toEqual({ x: 0, y: 0.33 });
        expect(photoFocusToward(2, 4 / 3, 1, 0.9, { x: 0.5, y: 0.33 })).toEqual({ x: 1, y: 0.33 });
        // The frame drawn at the focus a tap chose is centred on the tap when there is room.
        const f = photoFocusToward(3 / 4, 4 / 3, 0.5, 0.45);
        const box = photoFocusWindow(3 / 4, 4 / 3, f);
        expect(box.top + box.height / 2).toBeCloseTo(0.45, 2);
    });
});

describe('a form\'s focus points are held by photo, so each goes wherever its photo goes (review of #3390)', () => {
    /** A form built on core's helpers alone, as both apps' focus forms are. */
    const coreForm = (): PhotoFocusFormDriver => {
        let photos: string[] = [];
        let held: PhotoFocusByPhoto = NO_PHOTO_FOCUS;
        return {
            setPhotos: (next) => { photos = next; },
            removed: () => {},
            adjust: (photo, f) => { held = withPhotoFocus(held, photo, f); },
            putWhole: (next, focus) => { photos = next; held = photoFocusByPhoto(next, focus); },
            sent: () => photoFocusForPhotos(photos, held),
        };
    };

    it('every way a form changes its photos keeps each photo\'s own focus (the table both apps run)', () => {
        expect(checkPhotoFocusVectors(coreForm)).toEqual([]);
    });

    it('the table catches a focus kept by its place in a list beside the photos (as the forms kept it before)', () => {
        const byIndex = (): PhotoFocusFormDriver => {
            let photos: string[] = [];
            let before: string[] = [];
            let list: Array<PhotoFocus | null> = [];
            return {
                setPhotos: (next) => { before = photos; photos = next; },
                removed: (photo) => { const at = before.indexOf(photo); list = list.filter((_, j) => j !== at); },
                adjust: (photo, f) => { const at = photos.indexOf(photo); while (list.length <= at) list.push(null); list[at] = f; },
                putWhole: (next, focus) => { photos = next; list = photoFocusList(focus, next.length) ?? []; },
                sent: () => photoFocusList(list, photos.length),
            };
        };
        const wrong = checkPhotoFocusVectors(byIndex);
        expect(wrong.some((w) => w.startsWith('a tool\'s draft over an adjusted new post (the review of #3390), step 3 (replacePhotosOnly)'))).toBe(true);
    });

    it('a post\'s photos and focus, as sent or as stored, held by photo; a bad or missing one is none', () => {
        const f: PhotoFocus = { x: 0.2, y: 0.8 };
        expect([...photoFocusByPhoto(['a', 'b', 'c'], [null, f])]).toEqual([['b', f]]);
        expect([...photoFocusByPhoto(['a', 'b'], JSON.stringify([f, { x: 2, y: 0 }]))]).toEqual([['a', f]]);
        expect([...photoFocusByPhoto(['a', 'a'], [f, { x: 0, y: 0 }])]).toEqual([['a', f]]);
        expect([...photoFocusByPhoto(null, [f])]).toEqual([]);
        expect([...photoFocusByPhoto(['a', '', 7], 'not json')]).toEqual([]);
        expect([...photoFocusByPhoto(['a', 7 as unknown as string, 'c'], [f, f, f])]).toEqual([['a', f], ['c', f]]);
        expect(photoFocusOfPhoto(new Map([['a', f]]), 'a')).toEqual(f);
        expect(photoFocusOfPhoto(new Map([['a', f]]), null)).toBeNull();
        expect(photoFocusOfPhoto(NO_PHOTO_FOCUS, 'a')).toBeNull();
    });

    it('setting a focus makes a new map and holds it to two numbers 0 to 1; null or a bad one takes it off', () => {
        const before = new Map<string, PhotoFocus>([['a', { x: 0.5, y: 0.5 }]]);
        const after = withPhotoFocus(before, 'b', { x: 0.123456, y: 1 });
        expect(after).not.toBe(before);
        expect(before.has('b')).toBe(false);
        expect(after.get('b')).toEqual({ x: 0.123, y: 1 });
        expect(withPhotoFocus(after, 'a', null).has('a')).toBe(false);
        expect(withPhotoFocus(after, 'a', { x: 3, y: 0 } as PhotoFocus).has('a')).toBe(false);
        expect(photoFocusForPhotos(['x', 'b', 'a'], after)).toEqual([null, { x: 0.123, y: 1 }, { x: 0.5, y: 0.5 }]);
        expect(photoFocusForPhotos([], after)).toBeNull();
        expect(photoFocusForPhotos(['x'], after)).toBeNull();
    });
});

describe('Adjust opens by itself on the photos a pick adds, and walks through them (Marty, 28 Nov 2026)', () => {
    /** A form built from core's helpers alone, as both apps' hooks are: one `showing` beside the focus held by photo. */
    const coreRun = (overrides: Partial<{ skipKeeps: boolean; walkWhole: boolean; resetCloses: boolean }> = {}): PhotoFocusRunDriver => {
        const o = { skipKeeps: true, walkWhole: false, resetCloses: true, ...overrides };
        let photos: string[] = [];
        let held: PhotoFocusByPhoto = NO_PHOTO_FOCUS;
        let showing: PhotoFocusShowing | null = null;
        const keep = (f: PhotoFocus | null) => { const p = photoFocusShowingPhoto(showing); if (p !== null) held = withPhotoFocus(held, p, f); };
        return {
            setPhotos: (next) => { photos = next; },
            added: (added) => { showing = photoFocusShowingOf(o.walkWhole ? photos : added); },
            open: (photo) => { showing = photoFocusShowingOf([photo]); },
            done: (f) => { keep(f); showing = photoFocusShowingNext(showing); },
            skip: (f) => { if (o.skipKeeps) keep(f); showing = null; },
            cancel: () => { showing = null; },
            putWhole: (next, focus) => { photos = next; held = photoFocusByPhoto(next, focus); if (o.resetCloses) showing = null; },
            showing: () => ({ photo: photoFocusShowingPhoto(showing), step: photoFocusShowingStep(showing) }),
            sent: () => photoFocusForPhotos(photos, held),
        };
    };

    it('core\'s helpers hold every walk in the table', () => {
        expect(checkPhotoFocusRunVectors(() => coreRun())).toEqual([]);
    });

    it('the table catches a walk over every photo on the form, a Skip that drops the photo on screen, and a list put in whole left open', () => {
        expect(checkPhotoFocusRunVectors(() => coreRun({ walkWhole: true })).some((w) => w.startsWith('a second pick walks only the photos it added'))).toBe(true);
        expect(checkPhotoFocusRunVectors(() => coreRun({ skipKeeps: false })).some((w) => w.startsWith('Skip keeps what was chosen'))).toBe(true);
        expect(checkPhotoFocusRunVectors(() => coreRun({ resetCloses: false })).some((w) => w.startsWith('a pick that kept no photo opens nothing'))).toBe(true);
    });

    it('a walk: each photo once in the order picked, at most five; n of count while more are to come; closed after the last', () => {
        expect(photoFocusShowingOf([])).toBeNull();
        expect(photoFocusShowingOf(null)).toBeNull();
        expect(photoFocusShowingOf(['', 7, null])).toBeNull();
        expect(photoFocusShowingOf(['a', 'b', 'a', '', 'c'])).toEqual({ photos: ['a', 'b', 'c'], at: 0 });
        expect(photoFocusShowingOf(['1', '2', '3', '4', '5', '6'])!.photos).toEqual(['1', '2', '3', '4', '5']);
        const one = photoFocusShowingOf(['a']);
        expect(photoFocusShowingPhoto(one)).toBe('a');
        expect(photoFocusShowingStep(one)).toBeNull();
        expect(photoFocusShowingNext(one)).toBeNull();
        const two = photoFocusShowingOf(['a', 'b']);
        expect(photoFocusShowingStep(two)).toEqual({ n: 1, count: 2, more: true });
        const second = photoFocusShowingNext(two);
        expect(photoFocusShowingPhoto(second)).toBe('b');
        expect(photoFocusShowingStep(second)).toEqual({ n: 2, count: 2, more: false });
        expect(photoFocusShowingNext(second)).toBeNull();
        expect(photoFocusShowingPhoto(null)).toBeNull();
        expect(photoFocusShowingStep(null)).toBeNull();
        expect(photoFocusShowingNext(null)).toBeNull();
    });
});
