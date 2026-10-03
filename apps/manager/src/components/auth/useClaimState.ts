import { useEffect, useState } from 'react';
import { CLAIM_POLL_MS, fetchClaimState, type ClaimState } from '../../lib/node-claim';

/**
 * Asks GET /api/local/claim once on mount. While the node answers unclaimed it asks again every CLAIM_POLL_MS, paused
 * while the tab is hidden (and asked at once when it is shown again), and stops for good once the node has an owner
 * or the page closes.
 *
 * A first answer that fails is `unknown` and is not asked again: the sign-in shows, as before the claim existed. A
 * later failure while the card is up keeps the card and keeps asking (a node restarting is not a claim).
 */
export function useClaimState(url: string): ClaimState {
    const [state, setState] = useState<ClaimState>({ kind: 'unknown' });

    useEffect(() => {
        let alive = true;
        let waiting = false; // the node answered unclaimed at least once: keep asking
        let inFlight = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ctl = new AbortController();

        const schedule = () => {
            if (!alive || !waiting || timer !== undefined || inFlight || document.hidden) return;
            timer = setTimeout(() => { timer = undefined; void ask(); }, CLAIM_POLL_MS);
        };

        const ask = async () => {
            inFlight = true;
            const next = await fetchClaimState(url, ctl.signal);
            inFlight = false;
            if (!alive) return;
            if (next.kind === 'unknown') {
                if (!waiting) setState(next);
            } else {
                waiting = next.kind === 'unclaimed';
                setState(next);
            }
            schedule();
        };

        const onVisibility = () => {
            if (document.hidden) {
                if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
            } else if (waiting && timer === undefined && !inFlight) {
                void ask();
            }
        };

        document.addEventListener('visibilitychange', onVisibility);
        void ask();
        return () => {
            alive = false;
            if (timer !== undefined) clearTimeout(timer);
            ctl.abort();
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [url]);

    return state;
}
