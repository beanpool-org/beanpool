/**
 * Whether this phone OFFERS Show credit and the profile's credit card (slice C4): asked of the node each time the screen is
 * shown, never read from a role the phone kept (the STOP rule of the brief). An owner or admin by GET /api/node-admin/me, a
 * voucher by GET /api/vouchers/me, both fresh; a plain member's phone gets 'no' from both and never asks for a credit
 * answer. "Not heard" (offline, a 5xx) is 'unknown' and offers nothing. The node still decides at every credit request.
 *
 * A screen that already asks for the member's budget (the profile does) hands that answer in as `voucherAnswer`, so the node
 * is not asked for it twice; `null` there is "not heard yet" and the hook waits for it.
 */
import { useEffect, useState } from 'react';
import type { BeanPoolIdentity } from './identity';
import { askMyVouching } from './vouchers';
import { creditGiverFrom } from './credit-view';

export type GiverState = 'checking' | 'giver' | 'no' | 'unknown';

/** `again` changes when the screen is shown again (a view, a focus): the node is asked again, nothing is carried over. */
export function useCreditGiver(
    anchorUrl: string | null | undefined,
    identity: BeanPoolIdentity | null | undefined,
    enabled: boolean,
    again?: unknown,
    voucherAnswer?: { voucher: boolean } | null,
): GiverState {
    const [state, setState] = useState<GiverState>('checking');
    const handedIn = voucherAnswer !== undefined;
    const waiting = handedIn && voucherAnswer === null;
    const handedVoucher = voucherAnswer ? voucherAnswer.voucher : null;
    useEffect(() => {
        if (!enabled || !anchorUrl || !identity || waiting) { setState('checking'); return; }
        let alive = true;
        setState('checking');
        const vouching: Promise<boolean | null> = handedIn
            ? Promise.resolve(handedVoucher)
            : askMyVouching(anchorUrl, identity).then((v) => (v === null ? null : v.voucher));
        // The role helper is loaded when asked for, not with every screen that may show a credit card (it brings the phone's
        // lock and keystore with it); a screen that never asks for it never loads it.
        Promise.all([import('./node-admin').then((m) => m.askNodeRole(anchorUrl, identity)), vouching]).then(([role, voucher]) => {
            if (alive) setState(creditGiverFrom(role, voucher));
        }).catch(() => { if (alive) setState('unknown'); });
        return () => { alive = false; };
    }, [enabled, anchorUrl, identity?.publicKey, again, handedIn, waiting, handedVoucher]);
    return state;
}
