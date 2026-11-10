/**
 * Giving part of your credit line, the Credit line tab beside Beans on Send (slice G1; the node's engine/credit-gift.ts;
 * scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §6). Every rule is the node's: this file only asks
 * and carries the node's answer, and a refusal comes back as the node's own sentence (the thrown error's message).
 * Every figure is whole hundredths of a Bean, as all credit room is (a gift is whole Beans: 500 is 5): the body's
 * `amount_c`, and the answers' `max`, `room`, `canGive` and `amount`, whose names the node kept.
 */
import { DeviceEventEmitter } from 'react-native';
import { isHundredths } from '@beanpool/core';
import { signedGet, signedRequest, refreshBalanceFromServer } from './db';

/** What this member may give now, as the node says it (GET /api/credit/gift). */
export interface CreditGiftOffer {
    /** The tab is shown: Beans on, the community's setting on, and they hold credit line someone gave them. */
    offered: boolean;
    /** The community's most for one gift (0: off), whole hundredths. */
    max: number;
    /** The credit line someone gave them, which is all a gift can come from, whole hundredths. */
    room: number;
    /** The most they may give now, whole hundredths. */
    canGive: number;
    /** The node's sentence for why nothing can be given now, when `canGive` is 0. */
    why: string | null;
}

/**
 * Asked of the node each time the Ledger loads and the Send form opens, never a copy kept on the phone: whether the tab
 * shows, and what it says. null when the node can't be asked, or is from before G1: then there is no tab.
 */
export async function getCreditGiftOffer(): Promise<CreditGiftOffer | null> {
    try {
        const res = await signedGet('/api/credit/gift');
        if (!res.ok) return null;
        const b = await res.json();
        // Whole hundredths or no answer: a figure that isn't one is never shown as one (an older node's Beans among them).
        if (typeof b?.offered !== 'boolean' || !isHundredths(b?.canGive)) return null;
        return { offered: b.offered, max: isHundredths(b.max) ? b.max : 0, room: isHundredths(b.room) ? b.room : 0, canGive: b.canGive, why: typeof b.why === 'string' ? b.why : null };
    } catch {
        return null;
    }
}

/**
 * Gives `amount_c` (whole hundredths of a Bean, whole Beans: the typed figure through parseHundredths) of this member's
 * credit line to `to`, signed over the integer. Throws with the node's sentence when it refuses.
 */
export async function giveCreditLine(from: string, to: string, amount_c: number): Promise<{ amount: number; room: number; canGive: number }> {
    const res = await signedRequest('/api/credit/gift', { memberPubkey: to, amount_c });
    // Both lines changed: the giver's shrank, the recipient's grew. The balances are untouched (nothing here is a Bean).
    refreshBalanceFromServer(from).catch(() => null);
    DeviceEventEmitter.emit('sync_data_updated');
    return res;
}
