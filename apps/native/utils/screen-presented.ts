/**
 * Two guards for a screen that opens a Modal as it opens (app/new-listing.tsx), so it can never be left on top empty.
 *
 * The failure (Rob, iOS, 9 Nov: "the market is not scrollable or clickable"). new-listing is a full-window transparentModal
 * that draws nothing until its chooser or form opens. Opened by a link that asks for the chooser, it made an RN `Modal`
 * visible on its first render, while the screen's own presentation was still animating. On iOS UIKit refuses to present a
 * view controller on top of one that is mid-presentation; React Native has already marked the Modal presented and never
 * tries again. The Modal never appears, and the empty transparent screen under it swallows every tap and scroll until the
 * app is killed. Android (a Dialog window) and the web don't race.
 *
 *  1. useScreenPresented: wait for the screen's own presentation to finish before presenting anything on top of it.
 *  2. useModalShowGuard: if a Modal the screen asked for has not shown within MODAL_SHOW_GUARD_MS (its `onShow` never
 *     fired), give up and leave the screen. Whatever else goes wrong, it can never sit empty over the opener.
 *
 * The timers are a floor, not the way in: the navigation event is what normally opens things (about 300 ms for the fade).
 *
 * The same refusal happens one Modal after another: a chooser's pick that opens a Poll or Event form in the SAME commit that
 * starts closing the chooser (round 2 of #2984: the Map's +, the Market's +, Home's +). UIKit drops a present while the
 * presenter is still dismissing another controller, so the form is refused, and React Native has already marked it
 * presented. The member got nothing (or, on the listing screen, was sent back by guard 2). On iOS the pick waits for the
 * chooser's `onDismiss` (useAfterDismiss), the way components/SharePost.tsx holds its next sheet.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** If the screen's presentation never reports it has finished, carry on after this long (the guard below still stands). */
export const PRESENTED_FALLBACK_MS = 1500;
/** A Modal that was asked to show and has not fired `onShow` after this long was refused by the platform. */
export const MODAL_SHOW_GUARD_MS = 1000;

/**
 * What these hooks need of a navigation prop: react-navigation's `addListener`, for the native stack's `transitionEnd`. The
 * stack-agnostic NavigationProp expo-router hands out does not list that event (it is the native stack's own), so its
 * parameters are loose here.
 */
export type TransitionSource = {
    addListener: (type: any, cb: any) => unknown;
};

/**
 * false until the screen's own presentation has finished (the stack's `transitionEnd`, `closing: false`), then true for good.
 * Falls back to true after PRESENTED_FALLBACK_MS so a stack that never reports cannot hold a door shut.
 */
export function useScreenPresented(navigation: TransitionSource): boolean {
    const [presented, setPresented] = useState(false);
    useEffect(() => {
        const done = () => setPresented(true);
        const off = navigation.addListener('transitionEnd', (e: { data?: { closing?: boolean } }) => { if (!e?.data?.closing) done(); });
        const fallback = setTimeout(done, PRESENTED_FALLBACK_MS);
        return () => {
            clearTimeout(fallback);
            if (typeof off === 'function') off();
        };
        // The navigation prop is the screen's own for as long as it is mounted.
    }, []);
    return presented;
}

/**
 * Watch one Modal. While `visible` is true and the Modal's `onShow` (the returned function) has not fired within `ms`,
 * call `giveUp`. Closing the Modal (`visible` false) cancels the wait. Pass the returned function as the Modal's `onShow`.
 */
export function useModalShowGuard(visible: boolean, giveUp: () => void, ms: number = MODAL_SHOW_GUARD_MS): () => void {
    const shown = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const giveUpRef = useRef(giveUp);
    giveUpRef.current = giveUp;

    useEffect(() => {
        if (!visible) { shown.current = false; return; }
        // The Modal's own effect can run before this one (children first): an `onShow` that is already in stands.
        if (shown.current) return;
        timer.current = setTimeout(() => {
            timer.current = null;
            if (!shown.current) giveUpRef.current();
        }, ms);
        return () => {
            if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        };
    }, [visible, ms]);

    return useCallback(() => {
        shown.current = true;
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    }, []);
}

/** If a Modal never reports its `onDismiss` (the event was lost), run what was held after this long, so a pick is never dropped. */
export const AFTER_DISMISS_FALLBACK_MS = 1500;

/**
 * Hold a value until a Modal that is closing has gone, then run `run` with it, once. `hold(value)` starts the wait; pass the
 * returned `release` as that Modal's `onDismiss` (iOS fires it when UIKit's dismissal has finished). A floor timer
 * (`ms`) runs it anyway if the event never comes, and leaving the screen drops what is held. A second `hold` replaces the
 * first: one pick at a time. Where a platform does not need the wait (Android's Dialogs stack), do not call `hold`: run at once.
 */
export function useAfterDismiss<T>(run: (value: T) => void, ms: number = AFTER_DISMISS_FALLBACK_MS): { hold: (value: T) => void; release: () => void } {
    const held = useRef<{ value: T } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const runRef = useRef(run);
    runRef.current = run;

    const release = useCallback(() => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        const h = held.current;
        held.current = null;
        if (h) runRef.current(h.value);
    }, []);
    const hold = useCallback((value: T) => {
        held.current = { value };
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(release, ms);
    }, [ms, release]);
    useEffect(() => () => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        held.current = null;
    }, []);

    return { hold, release };
}
