/**
 * Every way a post form changes its photo list, as one table run against each app's own focus form (the phone's
 * usePhotoFocusList, the web's usePhotoFocusByPhoto) and against core's helpers (photo-focus.ts): after each step, the
 * `photoFocus` the form would send must give each photo its own focus, in the photos' order (review of #3390: a tool's
 * draft put in whole posted with another photo's focus). A focus travels with its photo; it is never read by its place in
 * a different list.
 *
 * Not in the barrel (as contacts-vectors.ts): imported only by tests, as `@beanpool/core/photo-focus-vectors`.
 */
import type { PhotoFocus } from './photo-focus.js';

/** The most photos a post form holds. */
const MOST_PHOTOS = 5;

/** One thing a form does to its photos. */
export type PhotoListStep =
    /** One pick of one photo or several (Add photo on either app): appended in the order picked, up to five. */
    | { op: 'pick'; photos: string[] }
    /** The ✕ on the photo at `index`. */
    | { op: 'remove'; index: number }
    /** The photo at `from` moved to `to`. */
    | { op: 'move'; from: number; to: number }
    /** Adjust's Done on the photo at `index` (`null`: Reset, the card's own crop). */
    | { op: 'adjust'; index: number; focus: PhotoFocus | null }
    /** The list put in whole with the focus it carries: a draft or a tool's photos (none), an edit opened on a post (its own). */
    | { op: 'putWhole'; photos: string[]; focus?: unknown }
    /** The list put in whole by code that never tells the focus form (the path the review of #3390 found). */
    | { op: 'replacePhotosOnly'; photos: string[] };

/** A step and what the form must send after it. */
export interface PhotoFocusVectorStep {
    step: PhotoListStep;
    sends: Array<PhotoFocus | null> | null;
}

const fA: PhotoFocus = { x: 0.1, y: 0.9 };
const fB: PhotoFocus = { x: 0.2, y: 0.8 };
const fC: PhotoFocus = { x: 0.3, y: 0.7 };
const fF: PhotoFocus = { x: 0.6, y: 0.4 };
const fU2: PhotoFocus = { x: 0.25, y: 0 };
const fU3: PhotoFocus = { x: 1, y: 1 };

/** The scenarios, each from an empty form. */
export const PHOTO_FOCUS_VECTORS: ReadonlyArray<{ name: string; steps: ReadonlyArray<PhotoFocusVectorStep> }> = [
    {
        name: 'a tool\'s draft over an adjusted new post (the review of #3390)',
        steps: [
            { step: { op: 'pick', photos: ['A', 'B'] }, sends: null },
            { step: { op: 'adjust', index: 0, focus: fA }, sends: [fA] },
            { step: { op: 'replacePhotosOnly', photos: ['T1', 'T2'] }, sends: null },
            { step: { op: 'adjust', index: 1, focus: fB }, sends: [null, fB] },
            { step: { op: 'putWhole', photos: ['T1'] }, sends: null },
        ],
    },
    {
        name: 'several picked at once, one taken off, the order changed, a pick past five',
        steps: [
            { step: { op: 'pick', photos: ['A'] }, sends: null },
            { step: { op: 'adjust', index: 0, focus: fA }, sends: [fA] },
            { step: { op: 'pick', photos: ['B', 'C', 'D'] }, sends: [fA] },
            { step: { op: 'adjust', index: 2, focus: fC }, sends: [fA, null, fC] },
            { step: { op: 'remove', index: 0 }, sends: [null, fC] },
            { step: { op: 'move', from: 1, to: 0 }, sends: [fC] },
            { step: { op: 'pick', photos: ['E', 'F', 'G'] }, sends: [fC] },
            { step: { op: 'adjust', index: 4, focus: fF }, sends: [fC, null, null, null, fF] },
            { step: { op: 'remove', index: 4 }, sends: [fC] },
            { step: { op: 'pick', photos: ['F'] }, sends: [fC, null, null, null, fF] },
            { step: { op: 'adjust', index: 0, focus: null }, sends: [null, null, null, null, fF] },
            { step: { op: 'remove', index: 4 }, sends: null },
        ],
    },
    {
        name: 'an edit opened on a post, then changed, then another post',
        steps: [
            { step: { op: 'putWhole', photos: ['U1', 'U2', 'U3'], focus: [null, fU2, fU3] }, sends: [null, fU2, fU3] },
            { step: { op: 'remove', index: 0 }, sends: [fU2, fU3] },
            { step: { op: 'pick', photos: ['N'] }, sends: [fU2, fU3] },
            { step: { op: 'move', from: 2, to: 0 }, sends: [null, fU2, fU3] },
            { step: { op: 'putWhole', photos: ['V1', 'U2'], focus: JSON.stringify([fA]) }, sends: [fA] },
            { step: { op: 'putWhole', photos: [] }, sends: null },
            { step: { op: 'pick', photos: ['U2', 'V1'] }, sends: null },
        ],
    },
    {
        name: 'the same photo twice shares its one focus',
        steps: [
            { step: { op: 'pick', photos: ['A', 'A'] }, sends: null },
            { step: { op: 'adjust', index: 1, focus: fA }, sends: [fA, fA] },
            { step: { op: 'remove', index: 0 }, sends: [fA] },
        ],
    },
];

/** The photo list after a step, as the forms change it (a pick appends up to five, the ✕ filters, a move splices). */
export function photosAfterStep(photos: readonly string[], step: PhotoListStep): string[] {
    switch (step.op) {
        case 'pick': return [...photos, ...step.photos].slice(0, MOST_PHOTOS);
        case 'remove': return photos.filter((_, j) => j !== step.index);
        case 'move': {
            const next = photos.slice();
            const [moved] = next.splice(step.from, 1);
            if (moved !== undefined) next.splice(step.to, 0, moved);
            return next;
        }
        case 'adjust': return photos.slice();
        case 'putWhole':
        case 'replacePhotosOnly': return step.photos.slice();
    }
}

/** One app's focus form, driven step by step. The form keeps its own photo list as its page does. */
export interface PhotoFocusFormDriver {
    /** The form's photo list set (a pick, a ✕, a move, or code that puts it in whole without telling the focus). */
    setPhotos(photos: string[]): void;
    /** A photo taken off with its ✕ (its list is set by setPhotos). */
    removed(photo: string): void;
    /** Adjust's Done on `photo`. */
    adjust(photo: string, focus: PhotoFocus | null): void;
    /** The list put in whole with the focus it carries (`undefined`: none). */
    putWhole(photos: string[], focus: unknown): void;
    /** The `photoFocus` the form would send for its photos now. */
    sent(): Array<PhotoFocus | null> | null;
}

/** Runs every scenario on a fresh form from `open`; each step whose sent list is wrong, in words (none: all hold). */
export function checkPhotoFocusVectors(open: () => PhotoFocusFormDriver): string[] {
    const wrong: string[] = [];
    for (const { name, steps } of PHOTO_FOCUS_VECTORS) {
        const form = open();
        let photos: string[] = [];
        steps.forEach(({ step, sends }, i) => {
            const next = photosAfterStep(photos, step);
            if (step.op === 'putWhole') form.putWhole(next, step.focus);
            else if (step.op === 'adjust') form.adjust(photos[step.index]!, step.focus);
            else {
                form.setPhotos(next);
                if (step.op === 'remove') form.removed(photos[step.index]!);
            }
            photos = next;
            const got = form.sent();
            if (JSON.stringify(got) !== JSON.stringify(sends)) {
                wrong.push(`${name}, step ${i + 1} (${step.op}): sent ${JSON.stringify(got)}, should be ${JSON.stringify(sends)}`);
            }
        });
    }
    return wrong;
}

/**
 * Adjust opening by itself on the photos a pick just added, and walking through them (Marty, 28 Nov 2026: "when you add
 * photo(s) it should come up with the visible area thing for each photo once you add them and maybe a next button if there
 * are more than one"), as one table run against each app's own focus form. After each step: the photo Adjust shows (`null`:
 * closed), its button (`next n of count` while new photos are still to come, else `done`), whether Skip is offered, and the
 * `photoFocus` the form would send.
 */
export type PhotoFocusRunStep =
    /** One pick appended these photos to the form (in the order picked, up to five). */
    | { op: 'pick'; photos: string[] }
    /** A tap on the photo at `index` of the form. */
    | { op: 'tap'; index: number }
    /** The button (Next or Done) with `focus` chosen for the photo on screen. */
    | { op: 'done'; focus: PhotoFocus | null }
    /** Skip with `focus` chosen for the photo on screen. */
    | { op: 'skip'; focus: PhotoFocus | null }
    /** Cancel (Back on the phone, Escape on the web). */
    | { op: 'cancel' }
    /** The list put in whole with the focus it carries: an edit opened on a post, a draft. */
    | { op: 'putWhole'; photos: string[]; focus?: unknown };

export interface PhotoFocusRunVectorStep {
    step: PhotoFocusRunStep;
    shows: string | null;
    /** `next n of count` or `done`; left out when Adjust is closed. */
    button?: string;
    skip?: boolean;
    sends: Array<PhotoFocus | null> | null;
}

/** The scenarios, each from an empty form. */
export const PHOTO_FOCUS_RUN_VECTORS: ReadonlyArray<{ name: string; steps: ReadonlyArray<PhotoFocusRunVectorStep> }> = [
    {
        name: 'three picked at once: Next (1 of 3), Next (2 of 3), Done, each photo keeping its own focus',
        steps: [
            { step: { op: 'pick', photos: ['A', 'B', 'C'] }, shows: 'A', button: 'next 1 of 3', skip: true, sends: null },
            { step: { op: 'done', focus: fA }, shows: 'B', button: 'next 2 of 3', skip: true, sends: [fA] },
            { step: { op: 'done', focus: fB }, shows: 'C', button: 'done', skip: false, sends: [fA, fB] },
            { step: { op: 'done', focus: fC }, shows: null, sends: [fA, fB, fC] },
        ],
    },
    {
        name: 'one picked: Done, as a tap always opened it, and no Skip',
        steps: [
            { step: { op: 'pick', photos: ['A'] }, shows: 'A', button: 'done', skip: false, sends: null },
            { step: { op: 'done', focus: fA }, shows: null, sends: [fA] },
        ],
    },
    {
        name: 'Skip keeps what was chosen for the photo on screen and leaves every photo not yet shown at none',
        steps: [
            { step: { op: 'pick', photos: ['A', 'B', 'C', 'D'] }, shows: 'A', button: 'next 1 of 4', skip: true, sends: null },
            { step: { op: 'done', focus: fA }, shows: 'B', button: 'next 2 of 4', skip: true, sends: [fA] },
            { step: { op: 'skip', focus: fB }, shows: null, sends: [fA, fB] },
        ],
    },
    {
        name: 'Skip on the first photo with nothing moved leaves them all at none',
        steps: [
            { step: { op: 'pick', photos: ['A', 'B'] }, shows: 'A', button: 'next 1 of 2', skip: true, sends: null },
            { step: { op: 'skip', focus: null }, shows: null, sends: null },
        ],
    },
    {
        name: 'Cancel changes nothing on the photo on screen and stops the walk; the photos before keep theirs',
        steps: [
            { step: { op: 'pick', photos: ['A', 'B', 'C'] }, shows: 'A', button: 'next 1 of 3', skip: true, sends: null },
            { step: { op: 'done', focus: fA }, shows: 'B', button: 'next 2 of 3', skip: true, sends: [fA] },
            { step: { op: 'cancel' }, shows: null, sends: [fA] },
        ],
    },
    {
        name: 'a second pick walks only the photos it added, never the ones already on the form',
        steps: [
            { step: { op: 'pick', photos: ['A'] }, shows: 'A', button: 'done', skip: false, sends: null },
            { step: { op: 'done', focus: fA }, shows: null, sends: [fA] },
            { step: { op: 'pick', photos: ['B', 'C'] }, shows: 'B', button: 'next 1 of 2', skip: true, sends: [fA] },
            { step: { op: 'done', focus: fB }, shows: 'C', button: 'done', skip: false, sends: [fA, fB] },
            { step: { op: 'done', focus: null }, shows: null, sends: [fA, fB] },
        ],
    },
    {
        name: 'a tap opens that one photo alone, with Done, on a form with several',
        steps: [
            { step: { op: 'pick', photos: ['A', 'B', 'C'] }, shows: 'A', button: 'next 1 of 3', skip: true, sends: null },
            { step: { op: 'cancel' }, shows: null, sends: null },
            { step: { op: 'tap', index: 1 }, shows: 'B', button: 'done', skip: false, sends: null },
            { step: { op: 'done', focus: fB }, shows: null, sends: [null, fB] },
        ],
    },
    {
        name: 'an edit opened on a post opens nothing; a tap opens one photo; a pick in the edit walks only its new photos',
        steps: [
            { step: { op: 'putWhole', photos: ['U1', 'U2'], focus: [null, fU2] }, shows: null, sends: [null, fU2] },
            { step: { op: 'tap', index: 0 }, shows: 'U1', button: 'done', skip: false, sends: [null, fU2] },
            { step: { op: 'done', focus: fA }, shows: null, sends: [fA, fU2] },
            { step: { op: 'pick', photos: ['N1', 'N2'] }, shows: 'N1', button: 'next 1 of 2', skip: true, sends: [fA, fU2] },
            { step: { op: 'done', focus: fF }, shows: 'N2', button: 'done', skip: false, sends: [fA, fU2, fF] },
            { step: { op: 'done', focus: null }, shows: null, sends: [fA, fU2, fF] },
        ],
    },
    {
        name: 'the same photo twice in one pick is shown once and shares its one focus',
        steps: [
            { step: { op: 'pick', photos: ['A', 'A', 'B'] }, shows: 'A', button: 'next 1 of 2', skip: true, sends: null },
            { step: { op: 'done', focus: fA }, shows: 'B', button: 'done', skip: false, sends: [fA, fA] },
            { step: { op: 'done', focus: fB }, shows: null, sends: [fA, fA, fB] },
        ],
    },
    {
        name: 'a pick that kept no photo opens nothing; a list put in whole closes a walk',
        steps: [
            { step: { op: 'pick', photos: [] }, shows: null, sends: null },
            { step: { op: 'pick', photos: ['A', 'B'] }, shows: 'A', button: 'next 1 of 2', skip: true, sends: null },
            { step: { op: 'putWhole', photos: ['T1'] }, shows: null, sends: null },
        ],
    },
];

/** One app's focus form with its Adjust walk, driven step by step. The form keeps its own photo list as its page does. */
export interface PhotoFocusRunDriver {
    /** The form's photo list set by a pick. */
    setPhotos(photos: string[]): void;
    /** What the form tells its focus form after a pick: the photos the pick added. */
    added(photos: string[]): void;
    /** A tap on one of the form's photos. */
    open(photo: string): void;
    /** The button (Next or Done) with `focus` chosen for the photo on screen. */
    done(focus: PhotoFocus | null): void;
    /** Skip with `focus` chosen for the photo on screen. */
    skip(focus: PhotoFocus | null): void;
    /** Cancel. */
    cancel(): void;
    /** The list put in whole with the focus it carries (`undefined`: none). */
    putWhole(photos: string[], focus: unknown): void;
    /** The photo Adjust shows (`null`: closed) and the walk's step (`null`: one photo). */
    showing(): { photo: string | null; step: { n: number; count: number; more: boolean } | null };
    /** The `photoFocus` the form would send for its photos now. */
    sent(): Array<PhotoFocus | null> | null;
}

/** Runs every walk scenario on a fresh form from `open`; each step that is wrong, in words (none: all hold). */
export function checkPhotoFocusRunVectors(open: () => PhotoFocusRunDriver): string[] {
    const wrong: string[] = [];
    for (const { name, steps } of PHOTO_FOCUS_RUN_VECTORS) {
        const form = open();
        let photos: string[] = [];
        steps.forEach(({ step, shows, button, skip, sends }, i) => {
            switch (step.op) {
                case 'pick': {
                    const next = photosAfterStep(photos, step);
                    const added = next.slice(photos.length);
                    photos = next;
                    form.setPhotos(next);
                    form.added(added);
                    break;
                }
                case 'tap': form.open(photos[step.index]!); break;
                case 'done': form.done(step.focus); break;
                case 'skip': form.skip(step.focus); break;
                case 'cancel': form.cancel(); break;
                case 'putWhole': photos = step.photos.slice(); form.putWhole(photos, step.focus); break;
            }
            const now = form.showing();
            const got = {
                shows: now.photo,
                ...(now.photo === null ? {} : { button: now.step?.more ? `next ${now.step.n} of ${now.step.count}` : 'done', skip: !!now.step?.more }),
                sends: form.sent(),
            };
            const want = { shows, ...(shows === null ? {} : { button, skip }), sends };
            if (JSON.stringify(got) !== JSON.stringify(want)) {
                wrong.push(`${name}, step ${i + 1} (${step.op}): got ${JSON.stringify(got)}, should be ${JSON.stringify(want)}`);
            }
        });
    }
    return wrong;
}
