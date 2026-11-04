import React, { useState, type ReactNode } from 'react';
import { Image, type ImageProps } from 'expo-image';
import { listPhotoUrl, nextListPhotoUrl } from '@beanpool/core';

/**
 * ListPhoto: a listing's picture on a small card (card-photo-retry, Marty 4 Nov 2026: a card on global missed its photo in
 * the list and showed it when opened). It draws the photo's small copy (`size=thumb2`, @beanpool/core listPhotoUrl); if that
 * will not load it draws the photo's own URL, which the detail screen draws; if that will not load it draws `fallback` (the
 * card's category tile, or what it draws for a listing with no photo), never an empty slot. Each step happens once per card,
 * and a photo URL a later read brings starts again from its small copy (the URL that failed is kept beside its step, not a
 * flag). The Market card's own picture, MarketCardPicture, does the same and also has its listing read again.
 */
export function ListPhoto({ photo, fallback, ...image }: {
    photo: string | null | undefined;
    fallback: ReactNode;
} & Omit<ImageProps, 'source' | 'onError'>) {
    const [steppedDown, setSteppedDown] = useState<{ photo: string; shown: string | null } | null>(null);
    const shown = !photo ? null : steppedDown?.photo === photo ? steppedDown.shown : listPhotoUrl(photo);
    if (!photo || !shown) return <>{fallback}</>;
    return (
        <Image
            {...image}
            source={{ uri: shown }}
            onError={() => setSteppedDown({ photo, shown: nextListPhotoUrl(photo, shown) })}
        />
    );
}
