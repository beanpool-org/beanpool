import { useCallback, useState, type CSSProperties } from 'react';
import {
    NO_PHOTO_FOCUS, photoFocusAt, photoFocusByPhoto, photoFocusForPhotos, photoFocusObjectPosition, photoFocusOfPhoto, withPhotoFocus,
    type PhotoFocus, type PhotoFocusByPhoto,
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
 */
export function usePhotoFocusByPhoto() {
    const [held, setHeld] = useState<PhotoFocusByPhoto>(NO_PHOTO_FOCUS);
    /** The photo whose Adjust dialog is open (the photo itself, not its place), or null. */
    const [adjusting, setAdjusting] = useState<string | null>(null);
    /** Whether the member changed a focus (or took a photo off) since the form was put in whole: an edit sends `photoFocus` only then. */
    const [touched, setTouched] = useState(false);
    const setAt = useCallback((photo: string, next: PhotoFocus | null) => {
        setTouched(true);
        setHeld((prev) => withPhotoFocus(prev, photo, next));
    }, []);
    /** A photo taken off: its focus is held by the photo, so nothing moves; an edit now sends the list for the photos left. */
    const removed = useCallback(() => setTouched(true), []);
    /** The list put in whole: `photos` and the focus they carry (a post's `photoFocus`), or none (a new form, a draft). */
    const resetFrom = useCallback((photos: readonly string[], focus?: unknown) => {
        setHeld(photoFocusByPhoto(photos, focus));
        setAdjusting(null);
        setTouched(false);
    }, []);
    /** The list to send for the form's `photos` as they stand: each one's own focus; null when none has one. */
    const forPhotos = useCallback((photos: readonly string[]) => photoFocusForPhotos(photos, held), [held]);
    return {
        touched,
        at: (photo: string | null | undefined) => photoFocusOfPhoto(held, photo),
        setAt, removed, resetFrom, forPhotos, adjusting,
        open: setAdjusting as (photo: string) => void,
        close: () => setAdjusting(null),
    };
}
