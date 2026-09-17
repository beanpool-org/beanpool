import { useCallback, useEffect, useRef } from 'react';

/**
 * One cancellable timer slot owned by a component.
 *
 * `schedule(fn, ms)` clears any pending timer before arming a new one, and the
 * pending timer is cleared on unmount, so `fn` never runs against an unmounted
 * component (a late setState there used to throw "window is not defined" once
 * the vitest environment had been torn down).
 */
export function useTimeout() {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clear = useCallback(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const schedule = useCallback((fn: () => void, ms: number) => {
        clear();
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            fn();
        }, ms);
    }, [clear]);

    useEffect(() => clear, [clear]);

    return { schedule, clear };
}
