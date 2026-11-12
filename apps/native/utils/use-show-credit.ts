/**
 * The Show credit switch on People → Community (slice C4): OFF at every visit (DESIGN-credit-list-fable.md §2), so opening People
 * to message a friend never shows anyone's figures and the node is asked again each time the switch goes on.
 *
 * It is on only after `open` (the member's tap, a door, the bell) and off again however the visit ends: `close` (the switch by
 * hand, the node's refusal), Community left for another view, or `visitEnds` going up (the tab left, the app in the
 * background: utils/people-visit.ts). Going off drops the credit list, so the balances it held in memory go with it and the next
 * switch-on reads them from the node again. The `start` a door or the bell asked for (a chip, a voucher) is spent in the same
 * step: it never outlives the switch, so a later plain switch-on opens on All.
 */
import { useCallback, useEffect, useState } from 'react';
import type { CreditFilter } from './credit-view';

export type CreditStart = { filter: CreditFilter; voucher?: string };
type ShowCredit = { on: boolean; start: CreditStart | null };
const OFF: ShowCredit = { on: false, start: null };

export function useShowCredit(inCommunity: boolean, visitEnds: number) {
    const [state, setState] = useState<ShowCredit>(OFF);
    const open = useCallback((start: CreditStart | null = null) => setState({ on: true, start }), []);
    const close = useCallback(() => setState((s) => (s.on || s.start ? OFF : s)), []);
    useEffect(() => { if (!inCommunity) close(); }, [inCommunity, close]);
    useEffect(() => { close(); }, [visitEnds, close]);
    return { on: state.on, start: state.start, open, close };
}
