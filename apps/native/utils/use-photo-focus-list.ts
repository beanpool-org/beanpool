import { useCallback, useState } from 'react';
import { NO_PHOTO_FOCUS, photoFocusByPhoto, photoFocusForPhotos, photoFocusOfPhoto, withPhotoFocus, type PhotoFocus, type PhotoFocusByPhoto } from '@beanpool/core';

/**
 * A post form's focus points (@beanpool/core photo-focus.ts), held by the photo each belongs to, never by its place in the
 * list: whatever the form does to its photos (one taken off, several added in one pick, the list put in whole), each photo's
 * focus stays with that photo and a photo added has none (review of #3390). The list sent is read off the form's photos as
 * they stand (`forPhotos`), so it cannot fall out of step with them. Its own hook, so the forms' photo pickers change only by
 * a line each.
 */
export function usePhotoFocusList() {
    const [held, setHeld] = useState<PhotoFocusByPhoto>(NO_PHOTO_FOCUS);
    /** The photo whose Adjust screen is open (the photo itself, not its place), or null. */
    const [adjusting, setAdjusting] = useState<string | null>(null);
    /**
     * Whether the member changed a focus (or took a photo off) since the form opened. An edit sends `photoFocus` only then: this
     * phone's copy can be behind the node (a focus set on the web not synced here yet), and an untouched edit leaves the node
     * to keep each photo's focus with it.
     */
    const [touched, setTouched] = useState(false);
    const setAt = useCallback((photo: string, next: PhotoFocus | null) => {
        setTouched(true);
        setHeld((prev) => withPhotoFocus(prev, photo, next));
    }, []);
    /** A photo taken off: its focus is held by the photo, so nothing moves; an edit now sends the list for the photos left. */
    const removed = useCallback(() => setTouched(true), []);
    /**
     * Start from `photos` (the form's list as it is put in whole) and the post's focus as this phone holds it (its
     * `photoFocus`, or the copy's `photo_focus`), or none: a new form, a draft.
     */
    const resetFrom = useCallback((photos: readonly string[], post?: { photoFocus?: unknown; photo_focus?: unknown } | null) => {
        setHeld(photoFocusByPhoto(photos, Array.isArray(post?.photoFocus) ? post?.photoFocus : post?.photo_focus));
        setAdjusting(null);
        setTouched(false);
    }, []);
    /** The list to send for the form's `photos` as they stand: each one's own focus; null when none has one. */
    const forPhotos = useCallback((photos: readonly string[]) => photoFocusForPhotos(photos, held), [held]);
    /** An edit's `photoFocus`: the list for `photos` when the member touched it, else nothing (undefined: not sent). */
    const forEdit = useCallback((photos: readonly string[]) => (touched ? photoFocusForPhotos(photos, held) : undefined), [touched, held]);
    return {
        touched,
        at: (photo: string | null | undefined) => photoFocusOfPhoto(held, photo),
        setAt, removed, resetFrom, forPhotos, forEdit, adjusting,
        open: setAdjusting as (photo: string) => void,
        close: () => setAdjusting(null),
    };
}
