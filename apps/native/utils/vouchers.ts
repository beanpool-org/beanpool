/**
 * Native voucher helpers (slice V3): reading the member's budget (GET /api/vouchers/me)
 * and vouching for someone from their profile (POST /api/vouch).
 */
import type { BeanPoolIdentity } from './identity';

export interface AllocationHistoryLine {
    kind: string;
    // Whole hundredths, as the node sends it (M1); the phone shows it in M2.
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
    vouchedBy: Array<{
        memberPubkey: string;
        callsign: string;
        amount: number;
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
 */
export async function rereadMyVouching(
    anchor: string,
    identity: BeanPoolIdentity,
    apply: (mv: MyVouching) => void,
    retryMs = 3000,
): Promise<void> {
    const first = await askMyVouching(anchor, identity);
    if (first) {
        apply(first);
        return;
    }
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
            return {
                ok: true,
                id: String(data.id ?? ''),
                memberPubkey: String(data.memberPubkey ?? ''),
                amount: Number(data.amount ?? 0),
                total: Number(data.total ?? 0),
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
        const prior = typeof data?.prior === 'number' ? data.prior : undefined;
        return { ok: false, message, code, prior };
    } catch {
        return { ok: false, message: 'Could not vouch.' };
    }
}
