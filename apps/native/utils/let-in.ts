/**
 * Let in once (Marty, 19 Nov 2026, "yes to all 5" on scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Let in
 * once", slice S3b): someone the member let in, in any community this phone holds, is not asked to wait as a message
 * request in another. The phone accepts their request for the member, by exactly the signed POST a tap on Accept sends
 * (db.ts decideMessageRequest), so no server learns anything new; and their first line across opens a chat, door open or
 * not (outside-mail.ts, core outside-chat.ts gateOutsideItem `letIn`).
 *
 * - **Who is let in** (derived at each read, never stored or sent): only someone the member took a step towards themselves
 *   (#3319 review at 3b80f0ee, F1; the director's call of 21 Nov 2026: a stranger must not skip the door by his own act).
 *   The other person of a direct chat the member wrote a line in, or whose request they accepted by their own act (the
 *   node's `acceptedByYou`, never a trade's acceptance), a friend they added, the other side of a deal the member took a
 *   step in (as its buyer; as its seller only on the buyer's own Need, never on the member's own Offer), someone they paid
 *   (db.ts LET_IN_SQL, one plain SELECT through each copy: the one in use and every held one, held-chats.ts heldLetIn), and
 *   each private contact the member linked to a member (contacts-store.ts; opened only when a copy doesn't already let the
 *   person in). Someone who took up the member's Offer, paid them or wrote to them alone is not let in. Only under a key that
 *   is the person's now, from every source alike (#3319 review F1): never one any copy's DM pins say a re-key replaced (a
 *   lost phone's, perhaps), nor one in question while a chat waits for the member over another key on offer.
 * - **The block first, everywhere** (DESIGN-s7-blocks-verified-everywhere-fable.md §2.4, slice S7b; Marty 21 Nov: someone
 *   unblocked is not let in quietly): never anyone known by a key blocked anywhere (blocklist.ts blockedAnywhere: on the
 *   phone's list, or on any community's own list as the phone last read it, a block made in the web app or on another
 *   device included), nor by one the member blocked and unblocked since, while the phone remembers that. And never in a
 *   community whose own list has not been read in this run (blockListReadThisRun: read then, once). An unreadable block
 *   list, or a read that fails, lets nobody in quietly. Their request is then an ordinary card the member answers.
 * - **Once per request**: an id this run accepted quietly is never pressed again, whatever a later list says.
 * - **The member's own answer stands** (#3319 review F2): a request they Accepted, Ignored, Declined (or Declined all) on this
 *   phone since its list was read, or with that answer still on its way, is never accepted quietly, nor one whose opener they
 *   blocked since; each is checked at the accept itself.
 */
import { blockListReadThisRun, neverLetInQuietly, readBlockLists, type BlockLists } from './blocklist';
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
 * The quiet accept, in `community` (the address the requests' list came from, where each accept goes): each candidate whose
 * opener the member let in, and whom no block bars under any of their keys ({@link neverLetInQuietly}), goes to
 * `accept` (db.ts: the same decideMessageRequest a tap on Accept calls), one after another, once that community's own block
 * list has been read in this run (blocklist.ts blockListReadThisRun; S7 design §2.4 rule 3). At each accept, the block lists
 * are read again (a Block tapped since the list was read holds: #3319 review F2) and `still()` says the account that asked is
 * the phone's; `accept` itself leaves a request the member answered since (db.ts memberAnsweredSince), which is then never
 * pressed this run. The ids accepted. Nothing is read when there is no candidate.
 */
export async function acceptLetIn(me: string, community: string, candidates: readonly LetInCandidate[], accept: (id: string) => Promise<unknown>, still: () => Promise<unknown>): Promise<Set<string>> {
    const accepted = new Set<string>();
    const fresh = candidates.filter((c) => c.from && c.from !== me && !pressed.has(`${me}\u0001${c.id}`));
    if (!me || fresh.length === 0) return accepted;
    const lists = await readBlockLists(me);
    if (!lists) return accepted;
    const open = fresh.filter((c) => !neverLetInQuietly(lists, [c.from, ...c.keys]));
    if (open.length === 0) return accepted;
    if (!(await blockListReadThisRun(me, community))) return accepted;
    const letIn = await letInReader(me)(open.map((c) => c.from));
    for (const c of open) {
        if (!letIn.has(c.from)) continue;
        const now = await readBlockLists(me);
        if (!now || neverLetInQuietly(now, [c.from, ...c.keys])) continue;
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
 * For one round of mail across (outside-mail.ts `letIn`) at `community`, whose mailbox the round reads: whether a sender is
 * let in and no block bars them ({@link neverLetInQuietly}), with that community's own block list read in
 * this run (S7 design §2.4 rule 6: the same check guards the across gate). Read once at the round's first ask. False when
 * the block lists can't be read, or that community's can't be.
 */
export function letInFor(me: string, community: string): (key: string) => Promise<boolean> {
    const reader = letInReader(me);
    let lists: Promise<BlockLists | null> | null = null;
    return async (key) => {
        lists ??= blockListReadThisRun(me, community).then((read) => (read ? readBlockLists(me) : null));
        const read = await lists;
        return !!read && !neverLetInQuietly(read, [key]) && (await reader([key])).has(key);
    };
}

/** For tests: forget what this run pressed and the contacts read. */
export function _resetLetInForTests(): void {
    pressed.clear();
    linked = null;
}
