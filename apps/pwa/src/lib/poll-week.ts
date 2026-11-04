/**
 * A member starts one poll a week (the node's half: apps/server engine/poll-week.ts; the words and the reading of its answer:
 * @beanpool/core poll-week). The composer asks the node each time the Poll choice is open, so a member who cannot start one
 * yet is told the day in place of an empty form. The phone does the same in NewPollModal.
 */
import { useEffect, useState } from 'react';
import { getPollNextStart } from './api';

/**
 * The time (ms) the node says the signed-in member's next poll can start, while `enabled`; null when they may start one now,
 * while it is being asked, or when it can't be (an older node, offline). It gates nothing: the node checks at Create.
 */
export function usePollNextStart(enabled: boolean): number | null {
    const [at, setAt] = useState<number | null>(null);
    useEffect(() => {
        if (!enabled) { setAt(null); return; }
        let cancelled = false;
        getPollNextStart().then((next) => { if (!cancelled) setAt(next); });
        return () => { cancelled = true; };
    }, [enabled]);
    return at;
}
