/**
 * The invite wizard's Next on "Your Name" (welcome.tsx handleCreate), the parts that can be tested apart from the screen.
 *
 * Next redeems the invite with the key it made, or with the phone's own. A redeem can land on the node and its answer
 * never reach the phone: offline for a moment, a 5xx after the member was written, no answer in time, the app stopped
 * while it waited. A member also comes back to Next after it worked: ← Back on the photo step, or Go Back on Safety
 * Backup. The next Next then finds the invite spent, and only the node can say whether it was this key that spent it.
 *
 * - A key this join made that the node already has is the member's own new account, whose 12 words they have never been
 *   shown (onboarding-state.ts `keyMadeForThisJoin`). Next carries on to the photo and Safety Backup as the redeem would
 *   have, and nothing redeems again.
 * - A key the phone already had that the node already has is an established account, already in that community: into
 *   the app, as before. Its words stay where they have always been, behind Settings' lock.
 * - Anything else is a spent invite, and the member is told so. Never a join the node didn't confirm.
 */
import type { BeanPoolIdentity } from './identity';
import { keyMadeForThisJoin, type PendingOnboarding } from './onboarding-state';

/** The node's membership probe gets as long as the app's other asks of it (NodeStatusContext's recheck). */
export const MEMBERSHIP_PROBE_TIMEOUT_MS = 8_000;

/**
 * Next's redeem, and its name check with the suggestions after it, each get this long: as the global door's join does
 * (global-join.ts JOIN_TIMEOUT_MS). The step's ways off are closed while Next is out (`runNext`), so no request of
 * Next's may wait for ever. A redeem with no answer in time may still have landed; the next Next finds out.
 */
export const NEXT_REQUEST_TIMEOUT_MS = 30_000;

/** Whether the node says this key is one of its members (its membership probe). No answer in time, or an unclear one, is no. */
export async function nodeSaysMember(nodeUrl: string, publicKey: string, timeoutMs = MEMBERSHIP_PROBE_TIMEOUT_MS): Promise<boolean> {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (async () => {
        try {
            const res = await fetch(`${nodeUrl}/api/community/membership/${publicKey}`, {
                headers: { Accept: 'application/json' },
                signal: stop.signal,
            });
            if (!res.ok) return false;
            const data = await res.json();
            return data?.isMember === true;
        } catch {
            return false;
        }
    })();
    // Raced as well as aborted: the answer is bounded even where a fetch doesn't stop when asked to.
    const late = new Promise<false>((resolve) => {
        timer = setTimeout(() => { stop.abort(); resolve(false); }, timeoutMs);
    });
    try {
        return await Promise.race([ask, late]);
    } finally {
        clearTimeout(timer);
    }
}

/** What Next does with an invite the node says is spent (`checkInvite` answered `used`), for the key on this phone. */
export type SpentInvite =
    /** This join's own key is already in: on to the photo and Safety Backup, the invite redeemed, nothing sent again. */
    | 'carryOn'
    /** A key the phone already had is already in: into the app, as before. */
    | 'enterApp'
    /** The node doesn't say this key is in (someone else spent it, or no answer): the member is told it is spent. */
    | 'spent';

/**
 * `stored` is the key on this phone when Next was tapped, `record` the wizard's record read before Next changed it. The
 * node is asked only about a stored key: with none, Next hasn't made one yet, so nothing on this phone spent the invite.
 */
export async function afterSpentInvite(nodeUrl: string, stored: BeanPoolIdentity | null, record: PendingOnboarding | null): Promise<SpentInvite> {
    if (!stored || !(await nodeSaysMember(nodeUrl, stored.publicKey))) return 'spent';
    return keyMadeForThisJoin(record, stored.publicKey) ? 'carryOn' : 'enterApp';
}

/**
 * A redeem the node refused (redeemInvite threw), and whether this key is in all the same. `already a member` is the
 * node's own word. `already been used` says only that the code is spent: by this key (a node from before it answered
 * its own member `alreadyMember`) when the node says the key is one of its members, otherwise by someone else, and then
 * going on would tell the member they had joined when the node never took them.
 */
export async function redeemRefusalMeansIn(message: unknown, nodeUrl: string, publicKey: string): Promise<boolean> {
    const text = typeof message === 'string' ? message : '';
    if (text.includes('already a member')) return true;
    if (text.includes('already been used')) return nodeSaysMember(nodeUrl, publicKey);
    return false;
}

/**
 * Next's run. The step's ways off (← Back to Home, Restore Existing Identity, the Recover link) are closed from the tap
 * until it ends, however it ends: its answer decides where the member goes, and a member who had left would be pulled
 * back to the photo step, or into the app, from wherever they went. `out` closes them in the same frame as the tap,
 * before `setBusy` has drawn them disabled, and a second tap on Next in that frame starts nothing.
 */
export async function runNext(out: { current: boolean }, setBusy: (busy: boolean) => void, next: () => Promise<void>): Promise<void> {
    if (out.current) return;
    out.current = true;
    setBusy(true);
    try {
        await next();
    } finally {
        out.current = false;
        setBusy(false);
    }
}

/** A way off the name step: taken only while Next is not out (`runNext`). */
export function leaveUnlessNextIsOut(out: { current: boolean }, go: () => void): void {
    if (out.current) return;
    go();
}
