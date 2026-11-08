/**
 * The key "Ask to join {name}" signs with, in a browser with no account here (DESIGN-shared-listing-door-fable.md §2.1,
 * slice A1): the phone's utils/knock-key.ts, on the web. The browser makes the key; a community grants a membership.
 *
 * - Drafted in memory when the form opens ({@link draftKnockKey}), and written to this browser only when Send is tapped,
 *   before the knock goes out ({@link commitKnockKey}): a knock is a signed write the community keeps under that key.
 * - One key per browser, by the one rule every save here already keeps: the commit is an ordinary identity save
 *   (identity.ts importIdentity → saveVerdict), the same decision checkIdentitySave asks, in the same transaction. A
 *   browser that holds another account is refused (IdentityHeldError) and nothing is written; so is one with a join that
 *   went out and waits to be settled (SentJoinWaitingError). There is no second guard to drift from the first.
 * - The key is marked as the knock's ({@link KNOCK_KEY_STORE}, its public key): from then on this browser is waiting to
 *   be let in. The root (App.tsx) reads the mark and shows the waiting page, never the member app: it never sets this key
 *   as the member, so no member read is made with it, and the member app's first-load register (lib/member-name.ts
 *   openWithNodeName, which registers a key that is no member) never runs for a key nobody has let in.
 * - A yes is joined with this same key through the invite form's own path (WelcomePage handleCreate reads
 *   {@link knockWaitingKey}): the invite a member's yes made is bound to it. The mark goes once the community has the key
 *   as a member ({@link forgetKnockMark}), and its 12 words are shown at Safety Backup for the first time.
 * - "Forget this request" ({@link forgetKnockKey}) wipes a key no community accepted, and only that.
 */

import {
    generateIdentity, importIdentity, loadIdentity, loadInviteSent, loadPendingJoin, wipeIdentity, type BeanPoolIdentity,
} from './identity';
import { setAccountHint } from './community-card';

/** localStorage: the public key of the key a knock made in this browser, whose community has not let it in yet. */
export const KNOCK_KEY_STORE = 'beanpool_knock_key';

/** Thrown by {@link commitKnockKey} when this browser is in the middle of another join: nothing was written or sent. */
export class KnockKeyHeldError extends Error {
    constructor() {
        super('This browser is finishing another join, so the request was not sent.');
        this.name = 'KnockKeyHeldError';
    }
}

function readMark(): string | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(KNOCK_KEY_STORE);
    } catch {
        return null;
    }
}

function writeMark(publicKey: string | null): void {
    try {
        if (typeof localStorage === 'undefined') return;
        if (publicKey) localStorage.setItem(KNOCK_KEY_STORE, publicKey);
        else localStorage.removeItem(KNOCK_KEY_STORE);
    } catch { /* storage off: the waiting page can't come back after a reload, and nothing else changes */ }
}

/** Whether `identity` is the key a knock made here and no community has let in yet: the waiting page's, not a member's. */
export function isKnockKey(identity: Pick<BeanPoolIdentity, 'publicKey'> | null | undefined): boolean {
    return !!identity?.publicKey && readMark() === identity.publicKey;
}

/** The key this browser asked with and is waiting on, as stored; null when it holds none, or holds a member's key. */
export async function knockWaitingKey(): Promise<BeanPoolIdentity | null> {
    const stored = await loadIdentity();
    return stored && isKnockKey(stored) ? stored : null;
}

/** A new key for the form, in memory only: nothing is written until Send ({@link commitKnockKey}). */
export async function draftKnockKey(): Promise<BeanPoolIdentity> {
    return generateIdentity('');
}

/**
 * Send was tapped: the drafted key, with the name typed, on this browser before the knock goes out. The mark first, then
 * the save: a save that is refused leaves a mark naming a key this browser does not hold, which reads as nothing, and is
 * taken off here. A browser that kept a key an invite went with (an answer still to come) is refused too: that key may be
 * a member's, and is settled on the welcome page first.
 */
export async function commitKnockKey(draft: BeanPoolIdentity, callsign: string): Promise<BeanPoolIdentity> {
    const identity: BeanPoolIdentity = { ...draft, callsign: callsign.replace(/\s+/g, ' ').trim() };
    if (await loadInviteSent()) throw new KnockKeyHeldError();
    writeMark(identity.publicKey);
    try {
        await importIdentity(identity, { refuseWhileSentJoinWaits: { except: null } });
    } catch (e) {
        if (readMark() === identity.publicKey) writeMark(null);
        throw e;
    }
    // `/` at this address opens the web app, where the waiting page is, rather than the card again.
    setAccountHint(true);
    return identity;
}

/** The community has this key as a member now: it is never read as the knock's again. */
export function forgetKnockMark(publicKey: string): void {
    if (readMark() === publicKey) writeMark(null);
}

/**
 * "Forget this request": wipes the key this browser asked with, when no community has let it in. Only that key: an
 * account that is not the knock's, a key an invite went with, or a join part-way is left as it is, and false returned.
 */
export async function forgetKnockKey(publicKey: string): Promise<boolean> {
    const [stored, inviteSent, pending] = await Promise.all([loadIdentity(), loadInviteSent(), loadPendingJoin()]);
    if (!stored || stored.publicKey !== publicKey || !isKnockKey(stored) || inviteSent || pending) return false;
    await wipeIdentity();
    writeMark(null);
    setAccountHint(false);
    return true;
}
