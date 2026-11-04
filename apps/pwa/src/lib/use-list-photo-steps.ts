import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { LIST_PHOTO_WAIT_MS, listPhotoUrl, nextListPhotoUrl } from '@beanpool/core';

/**
 * The photo a list card's picture is drawing, and when to give up on it (card-photo-retry, then card-photo-blank, Marty
 * 4 Nov 2026: a card on global showed an empty slot, no photo and no tile, through two restarts on the phone, though its
 * small copy was served fine). The phone's twin is apps/native/components/useListPhotoSteps.ts; ListPhoto and
 * MarketplaceCard draw through it.
 *
 * An <img> whose request never ends fires neither load nor error, and a browser sets no limit on it. So a card does not
 * wait for onError alone: `drawn` is true only once the photo it shows has fired load, and the card draws its tile or
 * fallback until then; a photo that has neither loaded nor failed within LIST_PHOTO_WAIT_MS counts as failed and takes
 * the same step down (@beanpool/core nextListPhotoUrl: the small copy once more past every cache, the photo's own URL,
 * then nothing). An <img> has no progress event, so the web counts from the start.
 *
 * The URL that failed is kept beside its step, not a flag, so a new URL a later read brings starts again from its small
 * copy.
 */
export function useListPhotoSteps(photo: string | null | undefined) {
    const [steppedDown, setSteppedDown] = useState<{ photo: string; shown: string | null } | null>(null);
    const [drawnUrl, setDrawnUrl] = useState<string | null>(null);
    const shown = !photo ? null : steppedDown?.photo === photo ? steppedDown.shown : listPhotoUrl(photo);
    const drawn = !!shown && drawnUrl === shown;

    const fail = useCallback((p: string, failed: string) => {
        setSteppedDown({ photo: p, shown: nextListPhotoUrl(p, failed) });
    }, []);

    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stop = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
    }, []);
    useEffect(() => {
        stop();
        if (!photo || !shown || drawn) return stop;
        const p = photo;
        const failed = shown;
        timer.current = setTimeout(() => { timer.current = null; fail(p, failed); }, LIST_PHOTO_WAIT_MS);
        return stop;
    }, [photo, shown, drawn, fail, stop]);

    return {
        shown,
        drawn,
        onLoad: useCallback(() => { stop(); if (shown) setDrawnUrl(shown); }, [shown, stop]),
        onError: useCallback(() => { stop(); if (photo && shown) fail(photo, shown); }, [photo, shown, fail, stop]),
    };
}

/** While its photo has not drawn, the <img> is out of the card's layout, unseen and takes no tap; the tile holds the slot. */
export const HIDDEN_UNTIL_DRAWN: CSSProperties = { position: 'absolute', opacity: 0, pointerEvents: 'none' };

/** The <img>'s style: its own once drawn, and until then the same with HIDDEN_UNTIL_DRAWN on top. */
export function styleUntilDrawn(style: CSSProperties | undefined, drawn: boolean): CSSProperties | undefined {
    return drawn ? style : { ...style, ...HIDDEN_UNTIL_DRAWN };
}
