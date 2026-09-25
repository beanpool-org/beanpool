/**
 * Whether the welcome screen offers "Explore BeanPool worldwide".
 *
 * The button leads to the global community's door, which is no use until global.beanpool.org is up and taking
 * members. So the screen shows it only once the node has answered, this app start, that it is the global community
 * with its door open: the same question the door itself asks (`checkGlobalDoor`), with a shorter wait. Until that
 * answer, and after a failure, a slow answer or any other answer, the button is not there and the screen reads as
 * it did before the door existed.
 *
 * Asked at most once per app start: an answer (open, shut, or not the global community) is kept for the session.
 * A failure (no network, an error, no answer within five seconds) is kept only until the next ask, so the screen
 * asks again when it comes back into view. Never throws, and never holds up a render: what to draw right now is
 * `globalDoorOffered()`, read without waiting.
 *
 * This is the first guard only. Tapping the button still asks the node fresh (welcome.tsx, the door's `checking`
 * phase), and refuses anything but an open global community.
 */

import { GLOBAL_NODE_URL, checkGlobalDoor, type GlobalDoorCheck } from './node-profile';

/** How long the offer waits for the node: a new member is looking at the screen. */
export const GLOBAL_DOOR_OFFER_TIMEOUT_MS = 5_000;

/** `open` shows the button. `answered` (shut, or not the global community) and `failed` hide it; only `failed` is asked again. */
type Heard = 'open' | 'answered' | 'failed';

let heard: Heard | null = null;
let asking: Promise<boolean> | null = null;
/** Moved on by `forgetGlobalDoorOffer`, so an ask from before it can never write over what came after. */
let generation = 0;

/** Whether to show the button right now. No network. */
export function globalDoorOffered(): boolean {
    return heard === 'open';
}

/** One ask, settled by the node's answer or by the clock, whichever comes first. Never rejects. */
function askOnce(fetchImpl: typeof fetch): Promise<Heard> {
    return new Promise<Heard>(resolve => {
        // A promise settles once: an answer after the clock ran out is dropped, and the next ask starts over.
        const timer = setTimeout(() => resolve('failed'), GLOBAL_DOOR_OFFER_TIMEOUT_MS);
        const settle = (next: Heard) => { clearTimeout(timer); resolve(next); };
        let check: Promise<GlobalDoorCheck>;
        try {
            check = checkGlobalDoor(GLOBAL_NODE_URL, fetchImpl, GLOBAL_DOOR_OFFER_TIMEOUT_MS);
        } catch {
            settle('failed');
            return;
        }
        check.then(
            c => settle(c.ok ? 'open' : c.reason === 'unreachable' ? 'failed' : 'answered'),
            () => settle('failed'),
        );
    });
}

/**
 * Ask the global community whether it is open, unless this app start already has its answer. Resolves true only
 * for the global community with its door open, and false for anything else. Asks already under way are shared.
 */
export function askGlobalDoorOffer(fetchImpl: typeof fetch = fetch): Promise<boolean> {
    if (heard === 'open' || heard === 'answered') return Promise.resolve(heard === 'open');
    if (asking) return asking;
    const mine = generation;
    const attempt = askOnce(fetchImpl).then(next => {
        if (mine !== generation) return false;
        heard = next;
        asking = null;
        return next === 'open';
    });
    asking = attempt;
    return attempt;
}

/** Forget this app start's answer, as a new app start would. For tests. */
export function forgetGlobalDoorOffer(): void {
    generation += 1;
    heard = null;
    asking = null;
}
