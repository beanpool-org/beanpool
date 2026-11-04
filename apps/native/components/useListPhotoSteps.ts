import { useCallback, useEffect, useRef, useState } from 'react';
import { LIST_PHOTO_LONGEST_MS, LIST_PHOTO_QUEUED_MS, LIST_PHOTO_WAIT_MS, listPhotoUrl, nextListPhotoUrl } from '@beanpool/core';

/**
 * The photo a list card's picture is drawing, and when to give up on it (card-photo-retry, then card-photo-blank, Marty
 * 4 Nov 2026: a card on global showed an empty slot, no photo and no tile, through two restarts, though its small copy
 * was served fine). Shared by ListPhoto and MarketCardPicture.
 *
 * expo-image sends neither onLoad nor onError for a load that never ends (Android: OkHttp has no limit on a whole
 * call, a response that trickles never fails, and a load waiting for its view's size or paused with the screen sends no
 * event; iOS: a load SDWebImage cancels, or one that ends with no image and no error, sends none). So a card does not
 * wait for onError alone: `drawn` is true only once the photo it shows has called onLoad, and the card draws its tile
 * or fallback until then. A photo that has neither loaded nor failed in time counts as failed and takes the same step
 * down (@beanpool/core nextListPhotoUrl: the small copy once more past every cache, the photo's own URL, then nothing).
 * "In time" follows how far its load has got (review of #2853, finding 3: a request waiting in OkHttp's queue gets no
 * event, so a wait that counted from when the card was shown cut off cards that would have loaded):
 *  - not started (no onLoadStart yet): no wait; a new URL would not start either;
 *  - started, no bytes yet (it may be waiting its turn in OkHttp's queue): LIST_PHOTO_QUEUED_MS;
 *  - bytes arriving: LIST_PHOTO_WAIT_MS from its last bytes, never past LIST_PHOTO_LONGEST_MS from its first.
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

    // The wait, and the URL it is for. A wait left from a URL the card has stepped past is stopped, never run.
    const timer = useRef<{ id: ReturnType<typeof setTimeout>; url: string } | null>(null);
    const stop = useCallback(() => {
        if (timer.current) clearTimeout(timer.current.id);
        timer.current = null;
    }, []);
    useEffect(() => { if (timer.current && timer.current.url !== shown) stop(); }, [shown, stop]);
    useEffect(() => stop, [stop]);
    // When the URL shown had its first bytes; a new URL starts again with none.
    const firstBytes = useRef<{ url: string | null; at: number | null }>({ url: null, at: null });
    const firstBytesAt = useCallback(() => (firstBytes.current.url === shown ? firstBytes.current.at : null), [shown]);

    const wait = useCallback((ms: number) => {
        stop();
        if (!photo || !shown || drawn) return;
        const p = photo;
        const failed = shown;
        timer.current = { id: setTimeout(() => { timer.current = null; fail(p, failed); }, Math.max(0, ms)), url: failed };
    }, [photo, shown, drawn, fail, stop]);

    const source = shown;
    return {
        shown,
        drawn,
        onLoad: useCallback(() => { stop(); if (source) setDrawnUrl(source); }, [source, stop]),
        onError: useCallback(() => { stop(); if (photo && source) fail(photo, source); }, [photo, source, fail, stop]),
        /** The load has started: it may still wait its turn in OkHttp's queue, so it has LIST_PHOTO_QUEUED_MS for its first bytes. */
        onLoadStart: useCallback(() => { if (firstBytesAt() === null) wait(LIST_PHOTO_QUEUED_MS); }, [firstBytesAt, wait]),
        /** Bytes: LIST_PHOTO_WAIT_MS from now, never past LIST_PHOTO_LONGEST_MS from the first. */
        onProgress: useCallback(() => {
            let first = firstBytesAt();
            if (first === null) {
                first = Date.now();
                firstBytes.current = { url: shown, at: first };
            }
            wait(Math.min(LIST_PHOTO_WAIT_MS, first + LIST_PHOTO_LONGEST_MS - Date.now()));
        }, [firstBytesAt, shown, wait]),
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
