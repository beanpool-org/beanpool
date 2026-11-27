import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
    NO_PHOTO_FOCUS, photoFocusByPhoto, photoFocusForPhotos, photoFocusOfPhoto, photoFocusShowingNext, photoFocusShowingOf,
    photoFocusShowingPhoto, photoFocusShowingStep, withPhotoFocus, type PhotoFocus, type PhotoFocusByPhoto, type PhotoFocusShowing,
} from '@beanpool/core';

/**
 * iOS: how long Adjust waits after a pick before it opens by itself. The photo picker and the camera are view controllers
 * presented over the form, and they start closing (animated) as they hand the photos back; UIKit drops a Modal presented while
 * its presenter is still dismissing another, and React Native never tries again (utils/screen-presented.ts). The redraw of each
 * photo usually outlasts the animation; this is the floor for a fast phone. Android's Dialogs stack, so it opens at once there.
 */
export const ADJUST_AFTER_PICKER_MS = 600;

/**
 * A post form's focus points (@beanpool/core photo-focus.ts), held by the photo each belongs to, never by its place in the
 * list: whatever the form does to its photos (one taken off, several added in one pick, the list put in whole), each photo's
 * focus stays with that photo and a photo added has none (review of #3390). The list sent is read off the form's photos as
 * they stand (`forPhotos`), so it cannot fall out of step with them. Its own hook, so the forms' photo pickers change only by
 * a line each.
 *
 * Adjust opens by itself on the photos a pick just added (`added`, Marty 28 Nov 2026) and walks through them: `step` says
 * where it stands (Next (n of count) while more are to come), `done` keeps the photo on screen's focus and goes on, `skip`
 * keeps it and closes (the photos not yet shown keep none), `close` (Cancel, Back) keeps nothing for the photo on screen and
 * closes. A tap on a photo (`open`) opens that one alone. The web's usePhotoFocusByPhoto is the same form; both run core's
 * PHOTO_FOCUS_RUN_VECTORS.
 */
export function usePhotoFocusList() {
    const [held, setHeld] = useState<PhotoFocusByPhoto>(NO_PHOTO_FOCUS);
    /** The photo whose Adjust screen is open (the photo itself, not its place) and the walk it is part of, or null. */
    const [showing, setShowing] = useState<PhotoFocusShowing | null>(null);
    /** iOS: a walk waiting for the picker to finish closing (ADJUST_AFTER_PICKER_MS). */
    const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stopPending = useCallback(() => {
        if (pending.current) { clearTimeout(pending.current); pending.current = null; }
    }, []);
    useEffect(() => stopPending, [stopPending]);
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
     * `photoFocus`, or the copy's `photo_focus`), or none: a new form, a draft. Adjust is closed: an edit opening never opens it.
     */
    const resetFrom = useCallback((photos: readonly string[], post?: { photoFocus?: unknown; photo_focus?: unknown } | null) => {
        setHeld(photoFocusByPhoto(photos, Array.isArray(post?.photoFocus) ? post?.photoFocus : post?.photo_focus));
        stopPending();
        setShowing(null);
        setTouched(false);
    }, [stopPending]);
    /**
     * The photos one pick just added to the form (askForPostPhotos's `picked`): Adjust opens on the first of them by itself.
     * Never the photos already on the form.
     */
    const added = useCallback((photos: readonly string[]) => {
        const walk = photoFocusShowingOf(photos);
        if (!walk) return;
        stopPending();
        if (Platform.OS === 'ios') pending.current = setTimeout(() => { pending.current = null; setShowing(walk); }, ADJUST_AFTER_PICKER_MS);
        else setShowing(walk);
    }, [stopPending]);
    /** The list to send for the form's `photos` as they stand: each one's own focus; null when none has one. */
    const forPhotos = useCallback((photos: readonly string[]) => photoFocusForPhotos(photos, held), [held]);
    /** An edit's `photoFocus`: the list for `photos` when the member touched it, else nothing (undefined: not sent). */
    const forEdit = useCallback((photos: readonly string[]) => (touched ? photoFocusForPhotos(photos, held) : undefined), [touched, held]);
    const adjusting = photoFocusShowingPhoto(showing);
    return {
        touched,
        at: (photo: string | null | undefined) => photoFocusOfPhoto(held, photo),
        setAt, removed, resetFrom, forPhotos, forEdit, added, adjusting,
        /** Where a walk through several new photos stands (null: one photo, the button reads Done). */
        step: photoFocusShowingStep(showing),
        /** A tap on one of the form's photos: Adjust on that photo alone. */
        open: (photo: string) => { stopPending(); setShowing(photoFocusShowingOf([photo])); },
        /** Next or Done: the photo on screen keeps `focus`, then the next new photo, or closed after the last. */
        done: (focus: PhotoFocus | null) => {
            if (adjusting !== null) setAt(adjusting, focus);
            setShowing(photoFocusShowingNext(showing));
        },
        /** Skip: the photo on screen keeps `focus`; the photos not yet shown keep none; closed. */
        skip: (focus: PhotoFocus | null) => {
            if (adjusting !== null) setAt(adjusting, focus);
            setShowing(null);
        },
        /** Cancel (and Back): nothing kept for the photo on screen; closed. */
        close: () => { stopPending(); setShowing(null); },
    };
}
