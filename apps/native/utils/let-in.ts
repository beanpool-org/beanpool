/**
 * Let in once (Marty, 19 Nov 2026, "yes to all 5" on scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Let in
 * once", slice S3b): someone the member let in, in any community this phone holds, is not asked to wait as a message
 * request in another. The phone accepts their request for the member, by exactly the signed POST a tap on Accept sends
 * (db.ts decideMessageRequest), so no server learns anything new; and their first line across opens a chat, door open or
 * not (outside-mail.ts, core outside-chat.ts gateOutsideItem `letIn`).
 *
 * - **Who is let in** (derived at each read, never stored or sent): the other person of a direct chat the member wrote a line
 *   in or accepted, a friend they added, the other side of a deal both took up, someone they paid (db.ts LET_IN_SQL, one
 *   plain SELECT through each copy: the one in use and every held one, held-chats.ts heldLetIn), and each private contact
 *   linked to a member (contacts-store.ts; opened only when a copy doesn't already let the person in). Only under a key that
 *   is the person's now, from every source alike (#3319 review F1): never one any copy's DM pins say a re-key replaced (a
 *   lost phone's, perhaps), nor one in question while a chat waits for the member over another key on offer.
 * - **The block first** (DESIGN-s7-blocks-verified-everywhere-fable.md §2.4; Marty 21 Nov: someone unblocked is not let in
 *   quietly): never anyone known by a key on the phone's block list (getBlockedUsers), nor by one the member blocked and
 *   unblocked since, while the phone remembers that (blocklist.ts getKeysOnceBlocked). An unreadable block list lets nobody
 *   in quietly. Their request is then an ordinary card the member answers.
 * - **Once per request**: an id this run accepted quietly is never pressed again, whatever a later list says.
 * - **The member's own answer stands** (#3319 review F2): a request they Accepted, Ignored, Declined (or Declined all) on this
 *   phone since its list was read, or with that answer still on its way, is never accepted quietly, nor one whose opener they
 *   blocked since; each is checked at the accept itself.
 */
import { getBlockedUsers, getKeysOnceBlocked } from './blocklist';
import { getLetInHere, isAnsweredByMember } from './db';
import { heldLetIn } from './held-chats';
import { loadIdentity } from './identity';
import { loadContacts, onContactsChanged } from './contacts-store';

/** A direct request waiting for the member: its id, its opener's key, and every key the opener is known by in that copy. */
export interface LetInCandidate {
    id: string;
    from: string;
    keys: readonly string[];
}

/** The keys never let in quietly: blocked now, or blocked once and unblocked since. Null when the block list can't be read. */
export async function keysNeverLetInQuietly(): Promise<Set<string> | null> {
    const once = await getKeysOnceBlocked();
    if (!once) return null;
    return new Set([...once, ...(await getBlockedUsers())]);
}

/** Linked contacts' keys, per account, read again after any change to the list (contacts-store.ts onContactsChanged). */
let linked: { me: string; keys: Promise<Set<string>> } | null = null;
let watching = false;

async function readLinked(me: string): Promise<Set<string>> {
    const identity = await loadIdentity();
    if (identity?.publicKey !== me || !identity.privateKey) throw new Error('not this account');
    const { onPhone } = await loadContacts({ publicKey: me, privateKey: identity.privateKey });
    if (onPhone.kind !== 'list') return new Set();
    return new Set(onPhone.list.contacts.flatMap((c) => c.links.map((l) => l.key)).filter((k) => k !== me));
}

/** The member's private contacts linked to a member, by key: none when the list can't be opened. */
async function contactsLetIn(me: string): Promise<Set<string>> {
    if (!watching) {
        watching = true;
        onContactsChanged(() => { linked = null; });
    }
    if (linked?.me !== me) {
        const read = readLinked(me);
        linked = { me, keys: read };
        // A read that failed is not kept: the next ask opens the list again.
        read.catch(() => { if (linked?.keys === read) linked = null; });
    }
    return linked.keys.catch(() => new Set<string>());
}

/**
 * Which of some keys the member let in: the copies read once at the first ask, the contacts only for a key they don't let in.
 * Only a person's key now (#3319 review F1): never a key any copy's pins say was replaced or is in question (db.ts
 * notCurrentOfPins), whichever source names it. None when a copy or its pins can't be read.
 */
function letInReader(me: string): (keys: readonly string[]) => Promise<Set<string>> {
    let copies: Promise<{ letIn: Set<string>; notCurrent: Set<string> } | null> | null = null;
    return async (keys) => {
        copies ??= Promise.all([getLetInHere(me), heldLetIn(me)]).then(([here, held]) => (here && held
            ? { letIn: new Set([...here.letIn, ...held.letIn]), notCurrent: new Set([...here.notCurrent, ...held.notCurrent]) }
            : null));
        const read = await copies;
        if (!read) return new Set();
        const current = keys.filter((k) => !read.notCurrent.has(k));
        const found = new Set(current.filter((k) => read.letIn.has(k)));
        if (current.some((k) => !found.has(k))) {
            const contacts = await contactsLetIn(me);
            for (const k of current) if (contacts.has(k)) found.add(k);
        }
        return found;
    };
}

/** Requests this run accepted quietly, by account: never pressed twice. */
const pressed = new Set<string>();

/**
 * The quiet accept: each candidate whose opener the member let in, and none of whose keys is never let in quietly, goes to
 * `accept` (db.ts: the same decideMessageRequest a tap on Accept calls), one after another. At each accept, the block list is
 * read again (a Block tapped since the list was read holds: #3319 review F2) and `still()` says the account that asked is the
 * phone's; `accept` itself leaves a request the member answered since (db.ts memberAnsweredSince), which is then never pressed
 * this run. The ids accepted. Nothing is read when there is no candidate.
 */
export async function acceptLetIn(me: string, candidates: readonly LetInCandidate[], accept: (id: string) => Promise<unknown>, still: () => Promise<unknown>): Promise<Set<string>> {
    const accepted = new Set<string>();
    const fresh = candidates.filter((c) => c.from && c.from !== me && !pressed.has(`${me}\u0001${c.id}`));
    if (!me || fresh.length === 0) return accepted;
    const never = await keysNeverLetInQuietly();
    if (!never) return accepted;
    const open = fresh.filter((c) => !never.has(c.from) && !c.keys.some((k) => never.has(k)));
    if (open.length === 0) return accepted;
    const letIn = await letInReader(me)(open.map((c) => c.from));
    for (const c of open) {
        if (!letIn.has(c.from)) continue;
        const now = await keysNeverLetInQuietly();
        if (!now || now.has(c.from) || c.keys.some((k) => now.has(k))) continue;
        if (!(await still())) break;
        try {
            await accept(c.id);
            pressed.add(`${me}\u0001${c.id}`);
            accepted.add(c.id);
        } catch (e: any) {
            // The member's own answer stands, now and for the rest of this run.
            if (isAnsweredByMember(e)) pressed.add(`${me}\u0001${c.id}`);
            console.warn(`[LetIn] A request was not accepted: ${e?.message || e}`);
        }
    }
    return accepted;
}

/**
 * For one round of mail across (outside-mail.ts `letIn`): whether a sender is let in and was never blocked, read once at the
 * round's first ask. False when the block list can't be read.
 */
export function letInFor(me: string): (key: string) => Promise<boolean> {
    const reader = letInReader(me);
    let never: Promise<Set<string> | null> | null = null;
    return async (key) => {
        never ??= keysNeverLetInQuietly();
        const blocked = await never;
        return !!blocked && !blocked.has(key) && (await reader([key])).has(key);
    };
}

/** For tests: forget what this run pressed and the contacts read. */
export function _resetLetInForTests(): void {
    pressed.clear();
    linked = null;
}
