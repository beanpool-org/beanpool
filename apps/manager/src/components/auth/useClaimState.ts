import { useEffect, useState } from 'react';
import {
    CLAIM_POLL_MS,
    fetchClaimState,
    fetchCommunityInfo,
    type ClaimState,
    type CommunityAddresses,
} from '../../lib/node-claim';

/**
 * Asks GET /api/local/claim once on mount. While the node answers unclaimed it asks again every CLAIM_POLL_MS, paused
 * while the tab is hidden (and asked at once when it is shown again), and stops for good once the node has an owner
 * or the page closes.
 *
 * Community addresses are read from /api/community/info ONCE per card mount, and never again while the card stays up.
 * A failed info read = no list (the card works as before).
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

        // Read /api/community/info ONCE per card mount, never again while the card stays up.
        // A failed info read = no list (the card works as before).
        let infoPromise: Promise<CommunityAddresses> | null = null;
        const getInfo = () => {
            if (!infoPromise) {
                const infoUrl = url.replace(/\/api\/local\/claim(\?.*)?$/, '/api/community/info$1');
                infoPromise = (infoUrl !== url)
                    ? fetchCommunityInfo(infoUrl, ctl.signal)
                    : Promise.resolve({ primaryAddress: null, addresses: [] });
            }
            return infoPromise;
        };

        const schedule = () => {
            if (!alive || !waiting || timer !== undefined || inFlight || document.hidden) return;
            timer = setTimeout(() => { timer = undefined; void ask(); }, CLAIM_POLL_MS);
        };

        const ask = async () => {
            inFlight = true;
            const [next, info] = await Promise.all([
                fetchClaimState(url, ctl.signal),
                getInfo(),
            ]);
            inFlight = false;
            if (!alive) return;
            if (next.kind === 'unknown') {
                if (!waiting) setState(next);
            } else {
                waiting = next.kind === 'unclaimed';
                if (next.kind === 'unclaimed') {
                    next.primaryAddress = info.primaryAddress;
                    next.address = info.primaryAddress;
                    next.addresses = info.addresses;
                }
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
