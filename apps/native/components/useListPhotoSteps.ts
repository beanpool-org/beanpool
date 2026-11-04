import { useCallback, useEffect, useRef, useState } from 'react';
import { LIST_PHOTO_LONGEST_MS, LIST_PHOTO_WAIT_MS, listPhotoUrl, nextListPhotoUrl } from '@beanpool/core';

/**
 * The photo a list card's picture is drawing, and when to give up on it (card-photo-retry, then card-photo-blank, Marty
 * 4 Nov 2026: a card on global showed an empty slot, no photo and no tile, through two restarts, though its small copy
 * was served fine). Shared by ListPhoto and MarketCardPicture.
 *
 * expo-image sends neither onLoad nor onError for a load that never ends (Android: OkHttp has no limit on a whole
 * call, a response that trickles never fails, and a load waiting for its view's size or paused with the screen sends no
 * event; iOS: a load SDWebImage cancels, or one that ends with no image and no error, sends none). So a card does not
 * wait for onError alone: `drawn` is true only once the photo it shows has called onLoad, and the card draws its tile
 * or fallback until then; a photo that has neither loaded nor failed within LIST_PHOTO_WAIT_MS of its last bytes, or
 * within LIST_PHOTO_LONGEST_MS of being shown however many bytes still trickle in, counts as failed and takes the same
 * step down (@beanpool/core nextListPhotoUrl: the small copy once more past every
 * cache, the photo's own URL, then nothing).
 *
 * The URL that failed is kept beside its step, not a flag, so a new URL the next sync brings starts again from its
 * small copy.
 */
export function useListPhotoSteps(photo: string | null | undefined, onFailed?: (failed: string) => void) {
    const [steppedDown, setSteppedDown] = useState<{ photo: string; shown: string | null } | null>(null);
    const [drawnUrl, setDrawnUrl] = useState<string | null>(null);
    const shown = !photo ? null : steppedDown?.photo === photo ? steppedDown.shown : listPhotoUrl(photo);
    const drawn = !!shown && drawnUrl === shown;

    const onFailedRef = useRef(onFailed);
    onFailedRef.current = onFailed;
    const fail = useCallback((p: string, failed: string) => {
        onFailedRef.current?.(failed);
        setSteppedDown({ photo: p, shown: nextListPhotoUrl(p, failed) });
    }, []);

    // The wait: started when a URL is shown, started again on every progress event (one comes with every read, so a
    // trickle sends them for ever) but never past LIST_PHOTO_LONGEST_MS from when that URL was shown, stopped by onLoad
    // or onError.
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const shownAt = useRef(0);
    useEffect(() => { shownAt.current = Date.now(); }, [photo, shown]);
    const stop = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
    }, []);
    const arm = useCallback(() => {
        stop();
        if (!photo || !shown || drawn) return;
        const p = photo;
        const failed = shown;
        const left = Math.max(0, Math.min(LIST_PHOTO_WAIT_MS, shownAt.current + LIST_PHOTO_LONGEST_MS - Date.now()));
        timer.current = setTimeout(() => { timer.current = null; fail(p, failed); }, left);
    }, [photo, shown, drawn, fail, stop]);
    useEffect(() => { arm(); return stop; }, [arm, stop]);

    const source = shown;
    return {
        shown,
        drawn,
        onLoad: useCallback(() => { stop(); if (source) setDrawnUrl(source); }, [source, stop]),
        onError: useCallback(() => { stop(); if (photo && source) fail(photo, source); }, [photo, source, fail, stop]),
        onProgress: arm,
    };
}

/** While its photo has not drawn, the Image is kept out of the card's layout and unseen; the tile holds the slot. */
export const HIDDEN_UNTIL_DRAWN = { position: 'absolute', opacity: 0 } as const;

type StyleIn = Record<string, unknown> | false | null | undefined | readonly StyleIn[];
const flatten = (style: StyleIn): Record<string, unknown> =>
    Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style && typeof style === 'object' ? { ...(style as Record<string, unknown>) } : {};

/**
 * The Image's style: the card's own once its photo has drawn, and until then the same with HIDDEN_UNTIL_DRAWN on top,
 * as one flat object (a card's style may be an array; StyleSheet.create answers plain objects).
 */
export function styleUntilDrawn<S>(style: S, drawn: boolean): S {
    return drawn ? style : ({ ...flatten(style as StyleIn), ...HIDDEN_UNTIL_DRAWN } as S);
}
