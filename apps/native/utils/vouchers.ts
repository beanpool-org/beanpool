/**
 * Native voucher helpers (slice V3): reading the member's budget (GET /api/vouchers/me)
 * and vouching for someone from their profile (POST /api/vouch).
 *
 * Every figure is whole hundredths of a Bean, as all credit room is (DESIGN-atomic-beans-fable.md Q3): the budget's
 * `left`/`held`/`vouched`/`level`, the presets (2500 is a vouch of 25), `vouchMax`, `budgetMax`, a history line's `amount_c`,
 * a vouched-by row's `amount_c`, and the vouch's answer (`amount`, `total`) and refusal (`prior`), whose names the node kept.
 */
import { isHundredths } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';

export interface AllocationHistoryLine {
    kind: string;
    /** Whole hundredths of a Bean, signed as the allocation ledger keeps them. */
    amount_c: number;
    actor: string;
    actorCallsign: string | null;
    at: string;
    for?: 'invite' | 'profile';
    inviteMadeAt?: string | null;
    outcome?: 'held' | 'vouched' | 'back';
    why?: 'expired' | 'stopped' | 'not_landed';
    person?: { memberPubkey: string; callsign: string } | null;
}

export interface MyVouching {
    voucher: boolean;
    budget?: {
        left: number;
        held: number;
        heldInvites: number;
        vouched: number;
        peopleVouched: number;
        level: number;
    };
    source?: 'role' | 'entry';
    history?: AllocationHistoryLine[];
    /** An owner vouches with no budget limit (Marty, 9 Nov): show "No limit", never left or level; 200 and 500 too. */
    noLimit?: boolean;
    presets: number[];
    vouchMax: number;
    budgetMax: number;
    /**
     * Their own Ask for more button's state, from the node (slice C3): null for an owner and for a member who is no voucher;
     * absent from an older node. Never worked out on the phone.
     */
    ask?: { askedAt: string | null; lastAskedAt: string | null; askAgainAt: string | null; blocked: 'paused' | 'frozen' | null } | null;
    vouchedBy: Array<{
        memberPubkey: string;
        callsign: string;
        /** Whole hundredths of a Bean. */
        amount_c: number;
        at: string;
    }>;
}

export type VouchProfileResult =
    | { ok: true; id: string; memberPubkey: string; amount: number; total: number; budget: unknown }
    | { ok: false; message: string; code?: string; prior?: number };

export async function askMyVouching(
    anchor: string,
    identity: BeanPoolIdentity,
): Promise<MyVouching | null> {
    try {
        const { signedGet } = await import('./node-post');
        const res = await signedGet(anchor, '/api/vouchers/me', identity);
        if (!res.ok) return null;
        return (await res.json()) as MyVouching;
    } catch {
        return null;
    }
}

/**
 * After a vouch or an invite that landed: read the budget again and hand it to `apply`. A failed read (offline, a 5xx)
 * hands nothing, so the screen keeps what it shows (the card, its figures, a success banner), and it tries once more,
 * quietly, after `retryMs`. Never `apply(null)`: askMyVouching's null means "could not read", not "not a voucher".
 * A screen that wants to say plainly that it could not read passes `onUnread`: called once, as soon as the first read fails
 * (not after the second), and `apply` still runs if the second try works.
 */
export async function rereadMyVouching(
    anchor: string,
    identity: BeanPoolIdentity,
    apply: (mv: MyVouching) => void,
    retryMs = 3000,
    onUnread?: () => void,
): Promise<void> {
    const first = await askMyVouching(anchor, identity);
    if (first) {
        apply(first);
        return;
    }
    onUnread?.();
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    const second = await askMyVouching(anchor, identity);
    if (second) apply(second);
}

/**
 * What a vouch from a profile posts: `vouchAmount` for a first vouch (a preset), or `raiseTo` for a raise, the total the
 * vouches for this person end at (a preset of the voucher's), never an amount to add. The node lands the difference.
 */
export type VouchProfileBody =
    | { memberPubkey: string; vouchAmount: number }
    | { memberPubkey: string; raiseTo: number };

export async function vouchFromProfile(
    anchor: string,
    identity: BeanPoolIdentity,
    body: VouchProfileBody,
): Promise<VouchProfileResult> {
    try {
        const { signedPost } = await import('./node-post');
        const res = await signedPost(anchor, '/api/vouch', body, identity);
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (res.ok && data) {
            // Whole hundredths (the node kept the names `amount` and `total`); anything else is no figure, 0.
            return {
                ok: true,
                id: String(data.id ?? ''),
                memberPubkey: String(data.memberPubkey ?? ''),
                amount: isHundredths(data.amount) ? data.amount : 0,
                total: isHundredths(data.total) ? data.total : 0,
                budget: data.budget,
            };
        }
        const message =
            typeof data?.error === 'string' && data.error.trim()
                ? data.error
                : typeof data?.message === 'string' && data.message.trim()
                  ? data.message
                  : 'Could not vouch.';
        const code = typeof data?.code === 'string' ? data.code : undefined;
        const prior = isHundredths(data?.prior) ? data.prior : undefined;
        return { ok: false, message, code, prior };
    } catch {
        return { ok: false, message: 'Could not vouch.' };
    }
}
