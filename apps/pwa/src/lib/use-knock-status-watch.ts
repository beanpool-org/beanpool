/**
 * A page that waits for a yes asks its community again by itself (@beanpool/core knock-status-watch.ts has the schedule
 * and the rules; Damo, 9 Nov 2026). This is the browser's half: it tells the watcher when the tab is shown or hidden
 * (visibilitychange), and when the window is focused or the connection comes back (read at once).
 *
 * `read` is called for every round of reading and says what it heard (`knockTickOf` of the status, or the
 * `combineKnockTicks` of several). It may change on every render: the watcher always calls the latest. `restart` begins
 * the schedule again (a new request was sent); `readNow` is Check again, which joins a read already out.
 */
import { useCallback, useEffect, useRef } from 'react';
import { createKnockStatusWatcher, type KnockStatusWatcher, type KnockWatchTick } from '@beanpool/core';

const shown = () => typeof document === 'undefined' || !document.hidden;

export function useKnockStatusWatch(
    read: () => Promise<KnockWatchTick>,
    /** Whether there is anything to wait for. Off, nothing is asked. */
    enabled: boolean = true,
    /** Anything that, changing, begins the schedule again (the set of requests being watched). */
    restartKey: string = '',
): { readNow: () => Promise<void>; restart: () => void } {
    const readRef = useRef(read);
    readRef.current = read;
    const watcher = useRef<KnockStatusWatcher | null>(null);

    useEffect(() => {
        if (!enabled) return;
        const w = createKnockStatusWatcher({ read: () => readRef.current(), visible: shown() });
        watcher.current = w;
        const onVisibility = () => w.setVisible(shown());
        const wake = () => w.wake();
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('focus', wake);
        window.addEventListener('online', wake);
        w.start();
        return () => {
            w.stop();
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('focus', wake);
            window.removeEventListener('online', wake);
            if (watcher.current === w) watcher.current = null;
        };
    }, [enabled, restartKey]);

    const readNow = useCallback(() => (watcher.current ? watcher.current.readNow() : readRef.current().then(() => undefined)), []);
    const restart = useCallback(() => { watcher.current?.start(); }, []);
    return { readNow, restart };
}
