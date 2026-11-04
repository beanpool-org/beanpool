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
 * then nothing). An <img> has no progress event, so the web counts from when the browser asks for the picture.
 *
 * That is at once for an eager <img>. A `lazy` one off screen is not asked for at all (review of #2853, finding 1: a
 * wait that started at mount stepped MapStackList's and Home's lazy photos down to their fallback before they were ever
 * fetched, and they never loaded): its wait starts once it has been in view with the URL it shows (`ref` takes the <img>
 * and an IntersectionObserver watches it). A step down to a new URL while it is out of view waits for it to come back.
 *
 * The URL that failed is kept beside its step, not a flag, so a new URL a later read brings starts again from its small
 * copy.
 */
export function useListPhotoSteps(photo: string | null | undefined, resolve?: (url: string) => string | null, lazy = false) {
    const [steppedDown, setSteppedDown] = useState<{ photo: string; shown: string | null } | null>(null);
    const [drawnUrl, setDrawnUrl] = useState<string | null>(null);
    const shown = !photo ? null : steppedDown?.photo === photo ? steppedDown.shown : listPhotoUrl(photo);
    // The address the <img> loads; null when there is nothing to draw or `resolve` refuses it (the card draws its fallback
    // and nothing waits: a refused URL is never stepped past).
    const src = shown && (resolve ? resolve(shown) : shown);
    const drawn = !!shown && drawnUrl === shown;

    // A lazy <img>: whether it is in view now, and the address it was in view with (the one the browser has asked for).
    // In view belongs to the <img> it was seen for: a new one (a new URL after the card had given up) is out of view until
    // its own observer says otherwise. Without IntersectionObserver the browser has no lazy loading either, and asks for
    // every <img> at once.
    const watch = lazy && typeof IntersectionObserver !== 'undefined';
    const [node, setNode] = useState<HTMLImageElement | null>(null);
    const [view, setView] = useState<{ node: HTMLImageElement; on: boolean } | null>(null);
    const inView = !!node && view?.node === node && view.on;
    const [seenSrc, setSeenSrc] = useState<string | null>(null);
    useEffect(() => {
        if (!watch || !node) return;
        const io = new IntersectionObserver((entries) => {
            const last = entries[entries.length - 1];
            if (last) setView({ node, on: last.isIntersecting });
        });
        io.observe(node);
        return () => io.disconnect();
    }, [watch, node]);
    useEffect(() => { if (watch && inView && src) setSeenSrc(src); }, [watch, inView, src]);
    const asked = !!src && (!watch || seenSrc === src);

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
        if (!photo || !shown || !src || drawn || !asked) return stop;
        const p = photo;
        const failed = shown;
        timer.current = setTimeout(() => { timer.current = null; fail(p, failed); }, LIST_PHOTO_WAIT_MS);
        return stop;
    }, [photo, shown, src, drawn, asked, fail, stop]);

    return {
        shown,
        src,
        drawn,
        /** The <img> (`ref={steps.ref}`): a lazy one is watched for when it comes into view. */
        ref: setNode,
        onLoad: useCallback(() => { stop(); if (shown) setDrawnUrl(shown); }, [shown, stop]),
        onError: useCallback(() => { stop(); if (photo && shown) fail(photo, shown); }, [photo, shown, fail, stop]),
    };
}

/**
 * While its photo has not drawn, the <img> is out of the card's layout, unseen and takes no tap; the tile holds the slot.
 * It covers its containing block exactly (top-left, 100% by 100%, no margin), so it never reaches past it, and the slot
 * that holds a card's picture is `relative`, so that block is the slot (review of #2853, finding 2: on Home's wide tiles
 * a hidden image sized itself against the whole card and `main` scrolled sideways, 1215 px for 800, while photos loaded).
 * It keeps the slot's box, so a lazy <img> is still asked for when the slot nears the screen.
 */
export const HIDDEN_UNTIL_DRAWN: CSSProperties = {
    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', margin: 0, opacity: 0, pointerEvents: 'none',
};

/** The <img>'s style: its own once drawn, and until then the same with HIDDEN_UNTIL_DRAWN on top. */
export function styleUntilDrawn(style: CSSProperties | undefined, drawn: boolean): CSSProperties | undefined {
    return drawn ? style : { ...style, ...HIDDEN_UNTIL_DRAWN };
}
