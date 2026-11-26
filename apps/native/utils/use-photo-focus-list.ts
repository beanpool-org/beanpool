import { useCallback, useState } from 'react';
import { photoFocusFromStored, photoFocusList, type PhotoFocus } from '@beanpool/core';

/**
 * A post form's focus points (@beanpool/core photo-focus.ts), kept beside its photo list and in the same order: the n-th
 * entry is the n-th photo's, a missing or null entry a photo with none. Its own hook, so the forms' photo pickers change
 * only by one line each: a removed photo takes its focus with it (`removeAt`), an added one has none.
 */
export function usePhotoFocusList() {
    const [focus, setFocus] = useState<Array<PhotoFocus | null>>([]);
    /** The photo whose Adjust screen is open, by its place in the list, or null. */
    const [adjusting, setAdjusting] = useState<number | null>(null);
    const setAt = useCallback((index: number, next: PhotoFocus | null) => setFocus((prev) => {
        const list = prev.slice();
        while (list.length <= index) list.push(null);
        list[index] = next;
        return list;
    }), []);
    const removeAt = useCallback((index: number) => setFocus((prev) => prev.filter((_, j) => j !== index)), []);
    /** Start from a post's focus as this phone holds it (its `photoFocus`, or the copy's `photo_focus`), or none. */
    const resetFrom = useCallback((post?: { photoFocus?: unknown; photo_focus?: unknown } | null) => {
        setFocus((Array.isArray(post?.photoFocus) ? photoFocusList(post?.photoFocus, 5) : photoFocusFromStored(post?.photo_focus)) ?? []);
        setAdjusting(null);
    }, []);
    /** The list to send for `count` photos: null when none has a focus (core photoFocusList). */
    const forPhotos = useCallback((count: number) => photoFocusList(focus, count), [focus]);
    return { focus, at: (index: number) => focus[index] ?? null, setAt, removeAt, resetFrom, forPhotos, adjusting, open: setAdjusting, close: () => setAdjusting(null) };
}
