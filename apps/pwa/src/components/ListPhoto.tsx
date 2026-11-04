/**
 * ListPhoto: a listing's picture on a list card (card-photo-retry, Marty 4 Nov 2026: a card on global missed its photo in the
 * list and showed it when opened). It draws the photo's small copy (`size=thumb2`, @beanpool/core listPhotoUrl); if that will
 * not load it draws the photo's own URL, and if that will not load it draws `fallback` (the card's category tile, or what it
 * draws for a listing with no photo), never a broken image or an empty slot. Each step happens once per card, and a photo URL
 * a later read brings starts again from its small copy (the URL that failed is kept beside its step, not a flag).
 *
 * `resolve` turns the URL it is about to draw into the address the page loads (an app-relative URL onto the node); the photo
 * it steps down from is the one it was given.
 */
import { useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { listPhotoUrl, nextListPhotoUrl } from '@beanpool/core';

export function ListPhoto({ photo, fallback, resolve, ...img }: {
    photo: string | null | undefined;
    fallback: ReactNode;
    resolve?: (url: string) => string;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'>) {
    const [steppedDown, setSteppedDown] = useState<{ photo: string; shown: string | null } | null>(null);
    const shown = !photo ? null : steppedDown?.photo === photo ? steppedDown.shown : listPhotoUrl(photo);
    if (!photo || !shown) return <>{fallback}</>;
    return (
        <img
            {...img}
            src={resolve ? resolve(shown) : shown}
            onError={() => setSteppedDown({ photo, shown: nextListPhotoUrl(photo, shown) })}
        />
    );
}
