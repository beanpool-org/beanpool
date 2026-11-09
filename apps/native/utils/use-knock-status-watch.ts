/**
 * A screen that waits for a yes asks its community again by itself (@beanpool/core knock-status-watch.ts has the schedule
 * and the rules: every 20 s for 10 minutes, every 60 s to the hour, every 5 minutes after; slower on a failure or a 429;
 * one read at a time). Damo, 9 Nov 2026: the yes showed only after a manual refresh. This is the phone's half: it asks
 * only while the app is in front (AppState 'active') and the screen is shown (not covered by another one), and reads at
 * once when both become true again.
 *
 * `read` is one round of reading: it updates the screen's own state and says what it heard (`knockTickOf` of a status, or
 * the `combineKnockTicks` of several). It may change on every render; the watcher calls the latest. `shown`: false while
 * another screen covers this one (the caller's own focus state; a screen with none passes nothing and is always shown).
 * `restartKey` changing begins the schedule again (a new request was sent). `readNow` is Check again, which joins a read
 * already out; `restart` begins again with a read at once.
 */
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { createKnockStatusWatcher, type KnockStatusWatcher, type KnockWatchTick } from '@beanpool/core';

/** React Native's AppState, or nothing where a test double has none: then the app reads as always in front. */
function appState(): { currentState?: string; addEventListener?: (type: 'change', cb: (state: string) => void) => { remove(): void } } | null {
    try { return AppState ?? null; } catch { return null; }
}
/** 'unknown' is what an app still starting up reads before it knows; it is not the background. */
const appInFront = () => {
    const state = appState()?.currentState;
    return state === undefined || state === 'active' || state === 'unknown';
};

export function useKnockStatusWatch(
    read: () => Promise<KnockWatchTick>,
    /** Whether there is anything to wait for. Off, nothing is asked. */
    enabled: boolean = true,
    /** Anything that, changing, begins the schedule again (the set of requests being watched). */
    restartKey: string = '',
    /** False while another screen covers this one. */
    shown: boolean = true,
): { readNow: () => Promise<void>; restart: () => void } {
    const readRef = useRef(read);
    readRef.current = read;
    const shownRef = useRef(shown);
    shownRef.current = shown;
    const frontRef = useRef(true);
    const watcher = useRef<KnockStatusWatcher | null>(null);

    useEffect(() => {
        if (!enabled) return;
        frontRef.current = appInFront();
        const w = createKnockStatusWatcher({ read: () => readRef.current(), visible: shownRef.current && frontRef.current });
        watcher.current = w;
        const sub = appState()?.addEventListener?.('change', (state) => {
            frontRef.current = state === 'active';
            w.setVisible(shownRef.current && frontRef.current);
        });
        w.start();
        return () => {
            w.stop();
            sub?.remove();
            if (watcher.current === w) watcher.current = null;
        };
    }, [enabled, restartKey]);

    // Covered by another screen, or shown again.
    useEffect(() => {
        watcher.current?.setVisible(shown && frontRef.current);
    }, [shown]);

    const readNow = useCallback(() => (watcher.current ? watcher.current.readNow() : readRef.current().then(() => undefined)), []);
    const restart = useCallback(() => { watcher.current?.start(); }, []);
    return { readNow, restart };
}
