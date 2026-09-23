import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * One shared "is anyone actually watching this screen?" signal for every automatic poll in the
 * manager.
 *
 * Node Settings is a screen operators leave open. Every timer in here talks to the node, and one
 * of them (the fleet diagnostics tick, App.tsx) used to drag the whole ~4 MB `/api/local/admin/data`
 * payload down behind it on every tick: a single forgotten tab sent 8.28 GB out of the test node in
 * three hours. Closing the tab took the host from 867 KB/s to zero within ten seconds.
 *
 * So the polls stop when nobody is there to read them:
 *  - hidden — the tab is in the background (`document.hidden`);
 *  - idle — the tab is on screen but has had no pointer, keyboard, touch or wheel input for
 *    `idleAfterMs` (ten minutes by default), which is the "left it sitting on this screen for a
 *    few days" case.
 *
 * Either way the cost of an abandoned screen falls to nothing, and any input — or the banner's
 * Resume button — brings it back with one immediate refresh.
 *
 * Deliberately NOT a pause for work the operator started and is waiting on: a restore, a domain
 * claim's log monitor or a phone-unlock flow keeps its own polling until it finishes. Those are
 * short, they are the reason the screen is open, and cutting them off mid-flight would lose the
 * result rather than save anything worth saving.
 */

export const IDLE_AFTER_MS = 10 * 60 * 1000;

/** Re-arming the idle timer on literally every mousemove is wasted work; once a second is plenty. */
const REARM_THROTTLE_MS = 1000;

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'] as const;

export type PauseReason = 'hidden' | 'idle';

export interface ActivityPauseState {
    /** True when automatic polling should be stopped. */
    paused: boolean;
    /** Why it is paused, or null when it is not. Only 'idle' is worth telling the operator about. */
    reason: PauseReason | null;
    /** Resume immediately (the banner's button). Also re-arms the idle countdown. */
    resume: () => void;
}

/**
 * The default is "never paused" on purpose: a component rendered outside the provider — in a unit
 * test, say — keeps whatever cadence it asked for rather than silently never polling.
 */
const ActivityPauseContext = createContext<ActivityPauseState>({
    paused: false,
    reason: null,
    resume: () => {},
});

export function ActivityPauseProvider({
    children,
    idleAfterMs = IDLE_AFTER_MS,
}: {
    children: React.ReactNode;
    idleAfterMs?: number;
}) {
    const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
    const [idle, setIdle] = useState(false);
    const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const armedAt = useRef(0);
    // Mirrors `idle` for the activity listener, which must not read stale state and must not
    // call setState on every mousemove just to find out nothing changed.
    const idleRef = useRef(false);

    const clearIdleTimer = useCallback(() => {
        if (idleTimer.current !== null) {
            clearTimeout(idleTimer.current);
            idleTimer.current = null;
        }
    }, []);

    const arm = useCallback(() => {
        clearIdleTimer();
        armedAt.current = Date.now();
        idleTimer.current = setTimeout(() => {
            idleTimer.current = null;
            idleRef.current = true;
            setIdle(true);
        }, idleAfterMs);
    }, [clearIdleTimer, idleAfterMs]);

    const wake = useCallback(() => {
        idleRef.current = false;
        setIdle(false);
        arm();
    }, [arm]);

    useEffect(() => {
        if (typeof document === 'undefined') return;

        const onActivity = () => {
            if (document.hidden) return;
            if (idleRef.current) {
                wake();
                return;
            }
            if (Date.now() - armedAt.current >= REARM_THROTTLE_MS) arm();
        };

        const onVisibilityChange = () => {
            const nowHidden = document.hidden;
            setHidden(nowHidden);
            if (nowHidden) {
                // Nothing is polling while hidden, so there is nothing to count down to.
                clearIdleTimer();
            } else {
                // Coming back to the tab is itself a sign of life: resume, and start the
                // ten minutes again from here.
                wake();
            }
        };

        for (const evt of ACTIVITY_EVENTS) {
            window.addEventListener(evt, onActivity, { passive: true, capture: true });
        }
        document.addEventListener('visibilitychange', onVisibilityChange);
        if (!document.hidden) arm();

        return () => {
            for (const evt of ACTIVITY_EVENTS) {
                window.removeEventListener(evt, onActivity, { capture: true } as EventListenerOptions);
            }
            document.removeEventListener('visibilitychange', onVisibilityChange);
            clearIdleTimer();
        };
    }, [arm, clearIdleTimer, wake]);

    const value = useMemo<ActivityPauseState>(
        () => ({
            paused: hidden || idle,
            reason: hidden ? 'hidden' : idle ? 'idle' : null,
            resume: wake,
        }),
        [hidden, idle, wake],
    );

    return <ActivityPauseContext.Provider value={value}>{children}</ActivityPauseContext.Provider>;
}

export function useActivityPause(): ActivityPauseState {
    return useContext(ActivityPauseContext);
}

/**
 * An interval that obeys the shared pause.
 *
 * `fn` is held in a ref, so an inline arrow function does not tear the timer down and build it
 * again on every render — which matters here, because a restarted timer used to mean an extra
 * immediate round of requests.
 *
 * - `enabled` — false stops the timer entirely (a panel whose tab is not open).
 * - `runOnStart` — whether to call `fn` once when the timer first starts. A resume after a pause
 *   ALWAYS calls it once immediately, whatever this says: that is the point of resuming.
 * - `restartKey` — change it to restart the timer and refresh at once (a different node, say).
 */
export function usePausablePoll(
    fn: () => void,
    intervalMs: number,
    options: { enabled?: boolean; runOnStart?: boolean; restartKey?: unknown } = {},
) {
    const { enabled = true, runOnStart = true, restartKey } = options;
    const { paused } = useActivityPause();
    const fnRef = useRef(fn);
    fnRef.current = fn;
    const wasPaused = useRef(paused);

    useEffect(() => {
        const resuming = wasPaused.current && !paused;
        wasPaused.current = paused;
        if (paused || !enabled) return;
        if (runOnStart || resuming) fnRef.current();
        const timer = setInterval(() => fnRef.current(), intervalMs);
        return () => clearInterval(timer);
    }, [paused, enabled, intervalMs, runOnStart, restartKey]);
}
