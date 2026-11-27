import { useCallback, useState, type CSSProperties } from 'react';
import {
    NO_PHOTO_FOCUS, photoFocusAt, photoFocusByPhoto, photoFocusForPhotos, photoFocusObjectPosition, photoFocusOf, photoFocusOfPhoto, photoFocusShowingNext,
    photoFocusShowingOf, photoFocusShowingPhoto, photoFocusShowingStep, withPhotoFocus, type PhotoFocus, type PhotoFocusByPhoto, type PhotoFocusShowing,
} from '@beanpool/core';

/**
 * The web's side of a photo's focus point (@beanpool/core photo-focus.ts): the `object-position` a card crops a listing's own
 * first photo with. A photo with no focus, or a picture that is not that photo (an enterprise's banner), keeps the card's own
 * crop (`fallback`), exactly as before focus points.
 */
export function cardObjectPosition(
    post: { photos?: string[]; photoFocus?: ReadonlyArray<PhotoFocus | null> | null } | null | undefined,
    picture: string | null | undefined,
    fallback?: CSSProperties,
): CSSProperties | undefined {
    const first = post?.photos?.[0];
    const focus = first && picture === first ? photoFocusAt(post, 0) : null;
    return focus ? { objectPosition: photoFocusObjectPosition(focus) } : fallback;
}

/** The `object-position` for a focus a Home row carries (its first photo's), or `fallback` for none. */
export function focusObjectPosition(focus: PhotoFocus | null | undefined, fallback: CSSProperties): CSSProperties {
    return focus ? { objectPosition: photoFocusObjectPosition(focus) } : fallback;
}

/**
 * A post form's focus points (@beanpool/core photo-focus.ts), held by the photo each belongs to, never by its place in the
 * list: whatever the form does to its photos (one taken off, several added in one pick, the list put in whole by a tool's
 * draft or an edit), each photo's focus stays with that photo and a photo added has none (review of #3390: a tool's draft
 * put in whole posted with another photo's focus). The list sent is read off the form's photos as they stand (`forPhotos`),
 * so it cannot fall out of step with them. The phone's usePhotoFocusList is the same form.
 *
 * Adjust opens by itself on the photos a pick just added (`added`, Marty 28 Nov 2026) and walks through them: `step` says
 * where it stands (Next (n of count) while more are to come), `done` keeps the photo on screen's focus and goes on, `skip`
 * keeps it and closes (the photos not yet shown keep none), `close` (Cancel, Escape) keeps nothing for the photo on screen and
 * closes. A click on a photo (`open`) opens that one alone. Both apps run core's PHOTO_FOCUS_RUN_VECTORS.
 */
export function usePhotoFocusByPhoto() {
    const [held, setHeld] = useState<PhotoFocusByPhoto>(NO_PHOTO_FOCUS);
    /** The photo whose Adjust dialog is open (the photo itself, not its place) and the walk it is part of, or null. */
    const [showing, setShowing] = useState<PhotoFocusShowing | null>(null);
    /** Whether the member changed a focus (or took a photo off) since the form was put in whole: an edit sends `photoFocus` only then. */
    const [touched, setTouched] = useState(false);
    const setAt = useCallback((photo: string, next: PhotoFocus | null) => {
        setTouched(true);
        setHeld((prev) => withPhotoFocus(prev, photo, next));
    }, []);
    /** A photo taken off: its focus is held by the photo, so nothing moves; an edit now sends the list for the photos left. */
    const removed = useCallback(() => setTouched(true), []);
    /**
     * The list put in whole: `photos` and the focus they carry (a post's `photoFocus`), or none (a new form, a draft). Adjust is
     * closed: an edit opening never opens it.
     */
    const resetFrom = useCallback((photos: readonly string[], focus?: unknown) => {
        setHeld(photoFocusByPhoto(photos, focus));
        setShowing(null);
        setTouched(false);
    }, []);
    /** The photos one pick just added to the form: Adjust opens on the first of them by itself. Never the photos already there. */
    const added = useCallback((photos: readonly string[]) => {
        const walk = photoFocusShowingOf(photos);
        if (walk) setShowing(walk);
    }, []);
    /** The list to send for the form's `photos` as they stand: each one's own focus; null when none has one. */
    const forPhotos = useCallback((photos: readonly string[]) => photoFocusForPhotos(photos, held), [held]);
    const adjusting = photoFocusShowingPhoto(showing);
    /**
     * Next, Done or Skip on the photo on screen: its focus set only when the member changed it. Adjust now opens by itself on
     * every photo added, so a Done with nothing moved is common; it must not mark an edit touched for a change nobody made.
     */
    const keep = (photo: string | null, focus: PhotoFocus | null) => {
        if (photo === null) return;
        const was = photoFocusOfPhoto(held, photo);
        const now = photoFocusOf(focus);
        if (was?.x !== now?.x || was?.y !== now?.y) setAt(photo, focus);
    };
    return {
        touched,
        at: (photo: string | null | undefined) => photoFocusOfPhoto(held, photo),
        setAt, removed, resetFrom, forPhotos, added, adjusting,
        /** Where a walk through several new photos stands (null: one photo, the button reads Done). */
        step: photoFocusShowingStep(showing),
        /** A click on one of the form's photos: Adjust on that photo alone. */
        open: (photo: string) => setShowing(photoFocusShowingOf([photo])),
        /** Next or Done: the photo on screen keeps `focus`, then the next new photo, or closed after the last. */
        done: (focus: PhotoFocus | null) => {
            keep(adjusting, focus);
            setShowing(photoFocusShowingNext(showing));
        },
        /** Skip: the photo on screen keeps `focus`; the photos not yet shown keep none; closed. */
        skip: (focus: PhotoFocus | null) => {
            keep(adjusting, focus);
            setShowing(null);
        },
        /** Cancel (and Escape): nothing kept for the photo on screen; closed. */
        close: () => setShowing(null),
    };
}
