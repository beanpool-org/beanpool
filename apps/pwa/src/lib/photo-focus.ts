import type { CSSProperties } from 'react';
import { photoFocusAt, photoFocusObjectPosition, type PhotoFocus } from '@beanpool/core';

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
