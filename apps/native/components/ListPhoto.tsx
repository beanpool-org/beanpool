import React, { type ReactNode } from 'react';
import { Image, type ImageProps } from 'expo-image';
import { LIST_PHOTO_TRANSITION, styleUntilDrawn, useListPhotoSteps } from './useListPhotoSteps';

/**
 * ListPhoto: a listing's picture on a small card (card-photo-retry, Marty 4 Nov 2026: a card on global missed its photo in
 * the list and showed it when opened). It draws the photo's small copy (`size=thumb2`, @beanpool/core listPhotoUrl); if that
 * will not load it asks the small copy once more past every cache, then the photo's own URL, which the detail screen
 * draws, then draws `fallback` (the card's category tile, or what it draws for a listing with no photo). Each step happens
 * once per card, and a photo URL a later read brings starts again from its small copy. The Market card's own picture,
 * MarketCardPicture, does the same and also has its listing read again.
 *
 * Never an empty slot (card-photo-blank, Marty 4 Nov 2026): `fallback` holds the slot until the photo has actually drawn
 * (onLoad), and a photo that neither draws nor fails in time counts as failed (useListPhotoSteps). The Image is mounted
 * from the start, out of the layout and unseen, so it loads, and takes the slot once it has drawn.
 *
 * It never cross-fades, so it takes no `transition`: a fade left a photo that loaded while its row was off the screen white
 * once it scrolled in (photo-white, Marty 5 Nov 2026; useListPhotoSteps LIST_PHOTO_TRANSITION).
 */
export function ListPhoto({ photo, fallback, style, ...image }: {
    photo: string | null | undefined;
    fallback: ReactNode;
} & Omit<ImageProps, 'source' | 'onError' | 'onLoad' | 'onLoadStart' | 'onProgress' | 'transition'>) {
    const steps = useListPhotoSteps(photo);
    if (!photo || !steps.shown) return <>{fallback}</>;
    return (
        <>
            {steps.drawn ? null : fallback}
            <Image
                {...image}
                style={styleUntilDrawn(style, steps.drawn)}
                importantForAccessibility={steps.drawn ? image.importantForAccessibility : 'no-hide-descendants'}
                accessibilityElementsHidden={!steps.drawn}
                source={{ uri: steps.shown }}
                transition={LIST_PHOTO_TRANSITION}
                onLoad={steps.onLoad}
                onError={steps.onError}
                onLoadStart={steps.onLoadStart}
                onProgress={steps.onProgress}
            />
        </>
    );
}
