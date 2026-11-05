/**
 * Giving part of your credit line, the Credit line tab beside Beans on Send (slice G1; the node's engine/credit-gift.ts;
 * scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §6). The phone's utils/credit-gift.ts, for the web:
 * every rule is the node's; this only asks and carries the node's answer, and a refusal is thrown with the node's own
 * sentence (lib/api.ts request).
 */
import { request } from './api';

/** What this member may give now, as the node says it (GET /api/credit/gift). */
export interface CreditGiftOffer {
    /** The tab is shown: Beans on, the community's setting on, and they hold credit line someone gave them. */
    offered: boolean;
    /** The community's most for one gift (0: off). */
    max: number;
    /** The credit line someone gave them, which is all a gift can come from. */
    room: number;
    /** The most they may give now. */
    canGive: number;
    /** The node's sentence for why nothing can be given now, when `canGive` is 0. */
    why: string | null;
}

/** Asked of the node at each refresh and when Send opens. null when it can't be asked, or is from before G1: no tab. */
export async function getCreditGiftOffer(): Promise<CreditGiftOffer | null> {
    try {
        const b = await request<Partial<CreditGiftOffer>>('GET', '/api/credit/gift');
        if (typeof b?.offered !== 'boolean' || typeof b?.canGive !== 'number') return null;
        return { offered: b.offered, max: Number(b.max) || 0, room: Number(b.room) || 0, canGive: b.canGive, why: typeof b.why === 'string' ? b.why : null };
    } catch {
        return null;
    }
}

/** Gives `amount` Beans of this member's credit line to `to`. Throws with the node's sentence when it refuses. */
export function giveCreditLine(to: string, amount: number): Promise<{ amount: number; room: number; canGive: number }> {
    return request('POST', '/api/credit/gift', { memberPubkey: to, amount });
}
