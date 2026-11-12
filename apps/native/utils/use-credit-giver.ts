/**
 * Whether this phone OFFERS Show credit and the profile's credit card (slice C4): asked of the node each time the screen is
 * shown, never read from a role the phone kept (the STOP rule of the brief). An owner or admin by GET /api/node-admin/me, a
 * voucher by GET /api/vouchers/me, both fresh; a plain member's phone gets 'no' from both and never asks for a credit
 * answer. "Not heard" (offline, a 5xx) is 'unknown' and offers nothing. The node still decides at every credit request.
 */
import { useEffect, useState } from 'react';
import type { BeanPoolIdentity } from './identity';
import { askNodeRole } from './node-admin';
import { askMyVouching } from './vouchers';
import { creditGiverFrom } from './credit-view';

export type GiverState = 'checking' | 'giver' | 'no' | 'unknown';

/** `again` changes when the screen is shown again (a view, a focus): the node is asked again, nothing is carried over. */
export function useCreditGiver(anchorUrl: string | null | undefined, identity: BeanPoolIdentity | null | undefined, enabled: boolean, again?: unknown): GiverState {
    const [state, setState] = useState<GiverState>('checking');
    useEffect(() => {
        if (!enabled || !anchorUrl || !identity) { setState('checking'); return; }
        let alive = true;
        setState('checking');
        Promise.all([askNodeRole(anchorUrl, identity), askMyVouching(anchorUrl, identity)]).then(([role, voucher]) => {
            if (!alive) return;
            setState(creditGiverFrom(role, voucher === null ? null : voucher.voucher));
        }).catch(() => { if (alive) setState('unknown'); });
        return () => { alive = false; };
    }, [enabled, anchorUrl, identity?.publicKey, again]);
    return state;
}
