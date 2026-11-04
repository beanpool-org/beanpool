/**
 * ListPhoto: a listing's picture on a list card (card-photo-retry, Marty 4 Nov 2026: a card on global missed its photo in the
 * list and showed it when opened). It draws the photo's small copy (`size=thumb2`, @beanpool/core listPhotoUrl); if that will
 * not load it asks the small copy once more past every cache, then the photo's own URL, and if that will not load it draws
 * `fallback` (the card's category tile, or what it draws for a listing with no photo), never a broken image or an empty
 * slot. Each step happens once per card, and a photo URL a later read brings starts again from its small copy.
 *
 * Never an empty slot while it loads either (card-photo-blank, Marty 4 Nov 2026): `fallback` holds the slot until the photo
 * has fired load, and a photo that neither loads nor fails in time counts as failed (lib/use-list-photo-steps.ts). The
 * <img> is there from the start, out of the layout, unseen and untappable, so it loads, and takes the slot once drawn.
 * Until then it covers its containing block, so the element ListPhoto sits in (the slot) must be `relative` (or
 * otherwise positioned): then the hidden photo stays inside the slot (review of #2853, finding 2). The wait starts when
 * the photo's request can: a `loading="lazy"` photo once it is in view (finding 1), and every photo at its turn in the
 * browser's line for its host, 6 at once (round 3, lib/list-photo-line.ts).
 *
 * `resolve` turns the URL it is about to draw into the address the page loads (an app-relative URL onto the node); the photo
 * it steps down from is the one it was given. A `resolve` that answers `null` is a refusal (resolveAvatarUrl's allow-list,
 * PWA-2): the card draws `fallback`, never the refused URL.
 */
import { type ImgHTMLAttributes, type ReactNode } from 'react';
import { styleUntilDrawn, useListPhotoSteps } from '../lib/use-list-photo-steps';

export function ListPhoto({ photo, fallback, resolve, style, ...img }: {
    photo: string | null | undefined;
    fallback: ReactNode;
    resolve?: (url: string) => string | null;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError' | 'onLoad'>) {
    const steps = useListPhotoSteps(photo, resolve, img.loading === 'lazy');
    const src = steps.src;
    if (!photo || !steps.shown || !src) return <>{fallback}</>;
    return (
        <>
            {steps.drawn ? null : fallback}
            <img
                {...img}
                ref={steps.ref}
                src={src}
                style={styleUntilDrawn(style, steps.drawn)}
                aria-hidden={steps.drawn ? img['aria-hidden'] : true}
                onLoad={steps.onLoad}
                onError={steps.onError}
            />
        </>
    );
}
