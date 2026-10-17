/**
 * What the global community's door said, this app start: the first screen's "Explore BeanPool worldwide" and the
 * BeanPool sheet's global row draw from it (DESIGN-global-entry-fable.md §B.2, §B.3).
 *
 * The button and the row are always drawn; this says only what their second line reads. `open`: nothing more to say
 * (the row offers Join). `closed`: the global community isn't taking new members (or whatever answers at its address
 * isn't the global community). `preview`: it is in a private preview. `unreachable`: no answer (no network, an error,
 * nothing within five seconds). `unknown`: not asked yet this app start, or the first ask is still out. None of these
 * hides anything: before P2 a failure or a slow answer took the button away, so a new member offline saw an invite-only
 * app with nothing to say why (§1.2). No-domain-lock-in: every answer but `open` reads "the global community isn't
 * available from here right now", and nothing else on the phone waits on it.
 *
 * Asked at most once per app start for an answer (open, shut, preview, not the global community): it is kept for the
 * session. `unreachable` is kept only until the next ask, so a screen coming back into view asks again. A door screen
 * that has just asked fresh (`rememberGlobalDoor`) replaces the kept answer, so going back never reads an older one.
 * Never throws, and never holds up a render: what to draw right now is `globalDoorOffer()`, read without waiting.
 *
 * This is the drawing only. Tapping still asks the node fresh (welcome.tsx's and join-global.tsx's `checking` phase),
 * and refuses anything but an open global community.
 */

import { GLOBAL_NODE_URL, checkGlobalDoor, wordsDoorOn, type GlobalDoorCheck } from './node-profile';
import { doorStateFromCheck, type GlobalDoorState } from './global-entry';

/** How long the offer waits for the node: a new member is looking at the screen. */
export const GLOBAL_DOOR_OFFER_TIMEOUT_MS = 5_000;

export interface GlobalDoorOffer {
    state: GlobalDoorState;
    /** The open door has the 12-words way in beside a sign-in (node-profile.ts wordsDoorOn); false for anything but `open`. */
    wordsDoor: boolean;
}

const NOT_ASKED: GlobalDoorOffer = { state: 'unknown', wordsDoor: false };
const UNREACHABLE: GlobalDoorOffer = { state: 'unreachable', wordsDoor: false };

let heard: GlobalDoorOffer = NOT_ASKED;
let asking: Promise<GlobalDoorOffer> | null = null;
/** Moved on by `forgetGlobalDoorOffer` and `rememberGlobalDoor`, so an ask from before can never write over what came after. */
let generation = 0;

/** A door check's answer, as the offer keeps it. */
export function offerFromCheck(check: GlobalDoorCheck): GlobalDoorOffer {
    return { state: doorStateFromCheck(check), wordsDoor: check.ok && wordsDoorOn(check.profile.features) };
}

/** Kept for the session: an answer. Asked again: no answer. */
const isAnswer = (o: GlobalDoorOffer) => o.state !== 'unknown' && o.state !== 'unreachable';

/** What to draw right now. No network. */
export function globalDoorOffer(): GlobalDoorOffer {
    return heard;
}

/** One ask, settled by the node's answer or by the clock, whichever comes first. Never rejects. */
function askOnce(fetchImpl: typeof fetch): Promise<GlobalDoorOffer> {
    return new Promise<GlobalDoorOffer>(resolve => {
        // A promise settles once: an answer after the clock ran out is dropped, and the next ask starts over.
        const timer = setTimeout(() => resolve(UNREACHABLE), GLOBAL_DOOR_OFFER_TIMEOUT_MS);
        const settle = (next: GlobalDoorOffer) => { clearTimeout(timer); resolve(next); };
        let check: Promise<GlobalDoorCheck>;
        try {
            check = checkGlobalDoor(GLOBAL_NODE_URL, fetchImpl, GLOBAL_DOOR_OFFER_TIMEOUT_MS);
        } catch {
            settle(UNREACHABLE);
            return;
        }
        check.then(c => settle(offerFromCheck(c)), () => settle(UNREACHABLE));
    });
}

/**
 * Ask the global community what its door says, unless this app start already has its answer. Asks already under way
 * are shared. Resolves what to draw: never rejects.
 */
export function askGlobalDoorOffer(fetchImpl: typeof fetch = fetch): Promise<GlobalDoorOffer> {
    if (isAnswer(heard)) return Promise.resolve(heard);
    if (asking) return asking;
    const mine = generation;
    const attempt = askOnce(fetchImpl).then(next => {
        if (mine !== generation) return heard;
        heard = next;
        asking = null;
        return next;
    });
    asking = attempt;
    return attempt;
}

/** A door screen's fresh answer (checkGlobalDoor at the tap) becomes what is drawn; no answer is `unreachable`. */
export function rememberGlobalDoor(check: GlobalDoorCheck | null): void {
    generation += 1;
    asking = null;
    heard = check ? offerFromCheck(check) : UNREACHABLE;
}

/** Forget this app start's answer, as a new app start would. For tests. */
export function forgetGlobalDoorOffer(): void {
    generation += 1;
    heard = NOT_ASKED;
    asking = null;
}
