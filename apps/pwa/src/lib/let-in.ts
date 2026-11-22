/**
 * Let in once, on the web (slice S5 part 3: scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Let in once"; Marty
 * 19 Nov 2026, "yes to all 5"). Someone the member let in, in the community this web app talks to, is not stopped at the
 * door: their first line across opens a chat, door open or not (core outside-chat.ts gateOutsideItem `letIn`, through
 * lib/outside-mail.ts syncOutsideMail), as on the phone.
 *
 * The rule is core's (@beanpool/core let-in.ts), the phone's own; this file only reads the web's facts for it, from what the
 * web app already reads of its one community, signed as the member:
 * - its chat list (GET /api/messages/conversations/:me): each direct chat the member is in, its people, whether they accepted
 *   its request themselves (the node's `acceptedByYou`), and the former keys its re-keyed people's signed statements name
 *   (`formerKeys`), which are no one's key now; and, only for the chats with the person asked about, the chat's newest
 *   lines (GET /api/messages/:id), for a line of the member's own (core isMembersOwnLine);
 * - its friends (GET /api/friends/:me), its deals (GET /api/marketplace/transactions, the newest 200), its payments
 *   (GET /api/ledger/transactions, the newest 200);
 * - the private contacts list as this browser keeps it (lib/contacts-store.ts heldContactsList), its links' keys.
 * Read at a round's first ask, once a round; the lines and the contacts only when nothing cheaper lets the person in.
 *
 * The strict side, every time: a fact that can't be read lets nobody in by it, and with the chat list unread (so its former
 * keys are unknown) nobody is let in at all. A line older than a chat's newest lines, a deal or a payment older than the
 * newest 200, is not read: that person then meets the door, as before this slice.
 *
 * The block first (S7, this community's own list): someone on the account's list here, or one the member unblocked in this
 * page (a doubt, as the phone's `once`), or a list that can't be read, is never let in.
 */
import {
    chatLetsInKey, contactsCouldLetIn, isMembersOwnLine, letInAmong, letInByFacts, type LetInChat, type LetInFacts, type LetInKnown,
} from '@beanpool/core';
import {
    getConversationMessages, getConversations, getFriends, getMyMarketplaceTransactions, getTransactions, type Conversation,
} from './api';
import { heldContactsList } from './contacts-store';

/** The reads let in once makes on the web: the api's own, unless a test hands in its own. */
export interface WebLetInReads {
    conversations: typeof getConversations;
    lines: (conversationId: string) => Promise<{ messages: ReadonlyArray<{ authorPubkey: string; nonce?: string | null; type?: string | null; metadata?: unknown }> }>;
    friends: typeof getFriends;
    deals: (me: string) => Promise<ReadonlyArray<{ buyerPublicKey: string; sellerPublicKey: string; status: string; postAuthorPublicKey?: string | null }>>;
    payments: (me: string) => Promise<ReadonlyArray<{ from: string; to: string }>>;
    contacts: (me: { publicKey: string; privateKey: string }) => Promise<{ contacts: ReadonlyArray<{ links: ReadonlyArray<{ key: string }> }> } | null>;
}

/** Deals and payments read: the newest this many (the node's largest page). */
export const LET_IN_PAGE = 200;

/** Each read named at its call, never at load: a page test that stands in for lib/api without these never meets them. */
const API_READS: WebLetInReads = {
    conversations: (me) => getConversations(me),
    lines: (id) => getConversationMessages(id),
    friends: (me) => getFriends(me),
    deals: (me) => getMyMarketplaceTransactions(me, undefined, LET_IN_PAGE),
    payments: (me) => getTransactions(me, LET_IN_PAGE),
    contacts: (me) => heldContactsList(me),
};

/** A direct chat in the web's list, as core's rule reads one; its lines not read yet (`memberWrote` false until they are). */
interface ListedChat { id: string; chat: LetInChat }

/** What a round's chat list says: its direct chats with me in them, and the keys its `formerKeys` name. */
function chatsOfList(me: string, list: readonly Conversation[]): { chats: ListedChat[]; notCurrent: Set<string> } {
    const chats: ListedChat[] = [];
    const notCurrent = new Set<string>();
    for (const c of list) {
        if (c?.type !== 'dm' || !Array.isArray(c.participants) || !c.participants.includes(me)) continue;
        const former = (c as { formerKeys?: Record<string, ReadonlyArray<{ pubkey?: unknown }>> }).formerKeys;
        for (const chain of Object.values(former ?? {})) {
            for (const f of Array.isArray(chain) ? chain : []) if (typeof f?.pubkey === 'string' && f.pubkey) notCurrent.add(f.pubkey);
        }
        const request = c.request;
        chats.push({
            id: c.id,
            chat: {
                others: c.participants.filter((k) => typeof k === 'string' && k !== me),
                memberWrote: false,
                acceptedByMember: request?.state === 'accepted' && request.acceptedByYou === true,
            },
        });
    }
    return { chats, notCurrent };
}

/** What one round reads once: the facts other than the lines and the contacts, or null when the chat list can't be read. */
interface RoundFacts { chats: ListedChat[]; known: LetInKnown & { byFacts: Set<string>; notCurrent: Set<string> }; facts: LetInFacts }

async function readRound(me: string, reads: WebLetInReads): Promise<RoundFacts | null> {
    const [list, friends, deals, payments] = await Promise.all([
        reads.conversations(me).catch(() => null),
        reads.friends(me).catch(() => null),
        reads.deals(me).catch(() => null),
        reads.payments(me).catch(() => null),
    ]);
    if (!list || !Array.isArray(list.conversations)) return null;
    const { chats, notCurrent } = chatsOfList(me, [...list.conversations, ...(list.requests?.conversations ?? [])]);
    const facts: LetInFacts = {
        chats: chats.map((c) => c.chat),
        // The list is the member's own (GET /api/friends/:me answers only the signer's): each one they added.
        friends: (Array.isArray(friends) ? friends : []).map((f) => ({ owner: me, friend: f.publicKey })),
        deals: (Array.isArray(deals) ? deals : []).map((d) => ({ buyer: d.buyerPublicKey, seller: d.sellerPublicKey, status: d.status, listingAuthor: d.postAuthorPublicKey ?? null })),
        payments: (Array.isArray(payments) ? payments : []).map((p) => ({ from: p.from, to: p.to })),
    };
    return { chats, facts, known: { byFacts: letInByFacts(me, facts), notCurrent } };
}

/**
 * For one round of mail across on the web (lib/outside-mail.ts `letIn`): whether a sender is let in, by core's rule over the
 * web's facts, and no block bars them (`blocked`: this community's list for the account, a block undone in this page among
 * it; throws when it can't be read). Read once, at the round's first ask; false whenever something it needs can't be read.
 */
export function letInOnWeb(
    identity: { publicKey: string; privateKey: string },
    blocked: (key: string) => Promise<boolean>,
    reads: WebLetInReads = API_READS,
): (key: string) => Promise<boolean> {
    const me = identity.publicKey;
    let round: Promise<RoundFacts | null> | null = null;
    let contacts: Promise<Set<string>> | null = null;
    const linesRead = new Map<string, Promise<boolean>>();
    return async (key) => {
        if (!key || key === me) return false;
        if (await blocked(key).catch(() => true)) return false;
        const read = await (round ??= readRound(me, reads).catch(() => null));
        if (!read) return false;
        if (letInAmong([key], read.known).has(key)) return true;
        if (read.known.notCurrent.has(key)) return false;
        // A line of the member's own, in a direct chat with this key: its newest lines, read once a round for each chat.
        for (const c of read.chats) {
            if (c.chat.memberWrote || chatLetsInKey(c.chat, me) !== key) continue;
            let wrote = linesRead.get(c.id);
            if (!wrote) {
                wrote = reads.lines(c.id).then((r) => (r?.messages ?? []).some((l) => isMembersOwnLine(l, me))).catch(() => false);
                linesRead.set(c.id, wrote);
            }
            if (await wrote) {
                c.chat.memberWrote = true;
                read.known.byFacts = letInByFacts(me, read.facts);
            }
        }
        if (letInAmong([key], read.known).has(key)) return true;
        if (!contactsCouldLetIn([key], read.known)) return false;
        contacts ??= reads.contacts(identity)
            .then((list) => new Set((list?.contacts ?? []).flatMap((c) => c.links.map((l) => l.key)).filter((k) => k && k !== me)))
            .catch(() => new Set<string>());
        return letInAmong([key], { ...read.known, contacts: await contacts }).has(key);
    };
}
