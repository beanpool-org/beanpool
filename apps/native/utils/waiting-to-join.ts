/**
 * Waiting to be let in (DESIGN-account-without-global-fable.md §2.4, slice S3): a phone with an account (a key) that is a
 * member nowhere. No community in use, and no join wizard part-way (utils/onboarding-state.ts). The way into it is Ask to
 * join from a phone with no account (utils/knock-key.ts); a wipe that keeps the key ("Wipe & Join Fresh", People's
 * "Wipe & Restart") leaves it too.
 *
 * Before S3 nothing gave this state a home: the root guard read it as a member and sent welcome on to the tabs, with no
 * community to read. Its home now is welcome's waiting mode ("Waiting for ‹name›: usually a few days", Check again, Ask
 * another community, Join with an invite, Restore), and the root guard holds the phone there (utils/auth-return.ts
 * `setupRedirect`, `waiting`): the screens that need no community stay, every other one goes to welcome, and nothing
 * asks a community whether it knows this key, so the not-recognised screen never shows for it.
 *
 * A yes from a community is joined with one tap through the ordinary invite path (welcome.tsx handleCreate, with the
 * phone's key), and the wizard goes on at Your Photo, then Safety Backup with the 12 words. Find a community hands a yes
 * tapped there to welcome in memory ({@link handKnockYesToWelcome}), never by a link or a route's params: nothing from
 * outside the app can start a join.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getPendingOnboarding, type PendingOnboarding } from './onboarding-state';
import { communityOrigin } from './community-origin';
import { cardKnockLines, knockCardState, KNOCK_MESSAGES, type KnockStatusResult, type RememberedKnock } from './knock';

export interface WaitingFacts {
    hasIdentity: boolean;
    /** The join wizard's record, if any (onboarding-state.ts). */
    record: PendingOnboarding | null;
    /** The community in use (`beanpool_anchor_url`), if any. */
    anchorUrl: string | null;
}

/** An account on the phone, no community in use, and no wizard part-way: waiting to be let in. */
export function phoneIsWaiting({ hasIdentity, record, anchorUrl }: WaitingFacts): boolean {
    return hasIdentity && !record && !(anchorUrl ?? '').trim();
}

/** What the phone holds now: the wizard's record and the community in use, read together. */
export async function readWaitingFacts(): Promise<{ record: PendingOnboarding | null; anchorUrl: string | null }> {
    const [record, anchorUrl] = await Promise.all([
        getPendingOnboarding(),
        AsyncStorage.getItem('beanpool_anchor_url').catch(() => null),
    ]);
    return { record, anchorUrl };
}

/** A community's yes, to be joined: where, its invite, and its name when known. */
export interface KnockYes {
    url: string;
    invite: string;
    name: string | null;
}

let handed: { yes: KnockYes; publicKey: string } | null = null;

/**
 * Find a community's Join on a yes, on a waiting phone: welcome joins it, through the invite path its own waiting mode uses,
 * so the wizard shows Your Photo and the 12 words. In memory, for this account only, and taken once
 * ({@link takeKnockYes}). Call it, then go to welcome.
 */
export function handKnockYesToWelcome(yes: KnockYes, publicKey: string): void {
    const url = communityOrigin(yes.url);
    const invite = yes.invite.trim();
    handed = url && invite && publicKey ? { yes: { url, invite, name: yes.name }, publicKey } : null;
}

/** The yes Find a community handed over for `publicKey`, taken once; null for none, or one for another account. */
export function takeKnockYes(publicKey: string | null | undefined): KnockYes | null {
    const was = handed;
    handed = null;
    return was && publicKey && was.publicKey === publicKey ? was.yes : null;
}

/**
 * One line of the waiting mode per community this key asked, newest first, read from what that community said:
 * - `waiting`: still open there, or not read yet (it was sent: until the community says otherwise, it waits). The L1
 *   card's line, "Waiting for ‹name›: usually a few days." (knock.ts `cardKnockLines`).
 * - `invited`: a member said yes. "‹name› said yes. Join now.", with the invite the community gave this key.
 * - `closed`: nothing open there now (it lapsed, was cancelled, or its invite expired): "This request is no longer open.
 *   You can ask again.", and Got it forgets it, as the L1 card does.
 * - `trouble`: no answer, or one the app couldn't read, or the community's refusal in its own words (`note`, shown through
 *   find-community-lines.ts `findLineWords`).
 * `text` is in the member's language already; `note` is a sentence for findLineWords.
 */
export type WaitingLine =
    | { kind: 'waiting'; url: string; name: string; text: string }
    | { kind: 'invited'; url: string; name: string; text: string; invite: string }
    | { kind: 'closed'; url: string; name: string; note: string }
    | { kind: 'trouble'; url: string; name: string; note: string };

export function waitingLines(
    asked: readonly RememberedKnock[], statuses: Readonly<Record<string, KnockStatusResult | null | undefined>>,
): WaitingLine[] {
    return asked.map((k): WaitingLine => {
        const name = k.name ?? k.url.replace(/^https:\/\//, '');
        const status = statuses[k.url];
        if (!status) return { kind: 'waiting', url: k.url, name, text: cardKnockLines([k], { [k.url]: { ok: true, value: { status: 'pending' } } })[0].text };
        if (status.ok && (status.value.status === 'pending' || status.value.status === 'approved')) {
            const line = cardKnockLines([k], { [k.url]: status })[0];
            return status.value.status === 'approved'
                ? { kind: 'invited', url: k.url, name, text: line.text, invite: status.value.invite }
                : { kind: 'waiting', url: k.url, name, text: line.text };
        }
        if (status.ok) return { kind: 'closed', url: k.url, name, note: KNOCK_MESSAGES.none };
        const state = knockCardState(true, true, status);
        return { kind: 'trouble', url: k.url, name, note: 'note' in state && state.note ? state.note : KNOCK_MESSAGES.unreadable };
    });
}
