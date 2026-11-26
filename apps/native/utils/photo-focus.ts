import type { ImageContentPosition } from 'expo-image';
import { DEFAULT_PHOTO_FOCUS, photoFocusAt, photoFocusFromStored, photoFocusOf, photoFocusPercent, type PhotoFocus } from '@beanpool/core';

/**
 * The phone's side of a photo's focus point (@beanpool/core photo-focus.ts): the focus of a post's photo, whichever shape the
 * post is in here (the node's `photoFocus` list, or this phone's copy's `photo_focus` column), and the contentPosition a card
 * crops with. A photo with no focus keeps the card's own crop (`fallback`), exactly as before focus points.
 */
export function postPhotoFocus(post: { photoFocus?: unknown; photo_focus?: unknown } | null | undefined, index = 0): PhotoFocus | null {
    if (!post) return null;
    if (Array.isArray(post.photoFocus)) return photoFocusAt(post as { photoFocus: Array<PhotoFocus | null> }, index);
    const list = photoFocusFromStored(post.photo_focus);
    return list ? photoFocusOf(list[index]) : null;
}

/** expo-image's contentPosition for a focus, or `fallback` (the grid card's 50% / 33% when none is given) for none. */
export function focusContentPosition(focus: PhotoFocus | null | undefined, fallback?: ImageContentPosition): ImageContentPosition {
    const f = focus ?? (fallback ? null : DEFAULT_PHOTO_FOCUS);
    if (!f) return fallback as ImageContentPosition;
    const { left, top } = photoFocusPercent(f);
    return { left: `${left}%`, top: `${top}%` };
}

/**
 * The crop a card draws its picture with: the listing's own first photo at its focus, or `fallback` when the picture is not
 * that photo (an enterprise's banner) or it has none. `fallback` undefined is a centred crop (expo-image's default).
 */
export function cardContentPosition(post: { photos?: unknown; photoFocus?: unknown; photo_focus?: unknown } | null | undefined, picture: string | null, cover: string | null, fallback?: ImageContentPosition): ImageContentPosition | undefined {
    const focus = picture && cover && picture === cover ? postPhotoFocus(post, 0) : null;
    return focus ? focusContentPosition(focus) : fallback;
}
