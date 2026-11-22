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
 * - the private contacts list as this browser keeps it (lib/contacts-store.ts heldContactsList), its links' keys. A link
 *   made in this community counts only while this community still lists its key as a member (GET /api/members?keys=, that
 *   one key, read only then): a key it no longer lists is a re-keyed person's old one, or a departed person's (#3366
 *   review F1: a lost phone's key, which an admin's re-key never names in `formerKeys`). A link made in another community
 *   counts as on the phone: the web reads no other community.
 * Read at a round's first ask, once a round; the lines and the contacts only when nothing cheaper lets the person in.
 *
 * The strict side, every time: a fact that can't be read lets nobody in by it, and with the chat list unread (so its former
 * keys are unknown) nobody is let in at all. A line older than a chat's newest lines, a deal or a payment older than the
 * newest 200, is not read: that person then meets the door, as before this slice.
 *
 * A read that failed is told apart from "not let in" (#3366 review F2): no answer, a time-out, a 5xx, or a 401, 408, 425
 * or 429 (try again) may pass later, so where the facts read don't let the person in, the answer is null, "not known this
 * round", and the round leaves the line it would drop for a later round (lib/outside-mail.ts). A refusal (any other 4xx,
 * such as a visitor's friends) says the fact is not there for this account: it lets nobody in, as before.
 *
 * Every read has its own time limit (#3366 review N2), {@link LET_IN_TIME}: 8 s each, and 20 s for all of a round's together,
 * well inside the round's 45 s (lib/outside-mail.ts OUTSIDE_ROUND_MS). A read with no answer by then is aborted and counts
 * as a read that failed, so the line it was for waits within its bound and the round goes on: it confirms what it judged,
 * keeps its waits and reaches the lines behind it. A read that never answered would otherwise end the round at that line,
 * before anything was confirmed, every round while it stayed slow.
 *
 * The block first (S7, this community's own list): someone on the account's list here, or one the member unblocked in this
 * page (a doubt, as the phone's `once`), or a list that can't be read, is never let in.
 */
import {
    chatLetsInKey, contactsCouldLetIn, isMembersOwnLine, letInAmong, letInByFacts, type LetInChat, type LetInFacts, type LetInKnown,
} from '@beanpool/core';
import {
    getConversationMessages, getConversations, getFriends, getMemberCards, getMyMarketplaceTransactions, getTransactions, nodeAddress, type Conversation,
} from './api';
import { heldContactsList } from './contacts-store';
import { memberKeysBatches, memberKeysPath } from './members-on-demand';
import { outsideCommunityOf } from './outside-chat-store';

/**
 * The reads let in once makes on the web: the api's own, unless a test hands in its own. Each request is handed a `signal`,
 * aborted at its time limit ({@link LET_IN_TIME}).
 */
export interface WebLetInReads {
    conversations: (me: string, signal?: AbortSignal) => ReturnType<typeof getConversations>;
    lines: (conversationId: string, signal?: AbortSignal) => Promise<{ messages: ReadonlyArray<{ authorPubkey: string; nonce?: string | null; type?: string | null; metadata?: unknown }> }>;
    friends: (me: string, signal?: AbortSignal) => ReturnType<typeof getFriends>;
    deals: (me: string, signal?: AbortSignal) => Promise<ReadonlyArray<{ buyerPublicKey: string; sellerPublicKey: string; status: string; postAuthorPublicKey?: string | null }>>;
    payments: (me: string, signal?: AbortSignal) => Promise<ReadonlyArray<{ from: string; to: string }>>;
    /** This browser's own copy (lib/contacts-store.ts): no request, yet bounded by the same time limit. */
    contacts: (me: { publicKey: string; privateKey: string }) => Promise<{ contacts: ReadonlyArray<{ links: ReadonlyArray<{ key: string; community: string }> }> } | null>;
    /** Which of `keys` this community lists as members now (the directory's keys form): those it names, the rest not. */
    members: (keys: readonly string[], signal?: AbortSignal) => Promise<ReadonlyArray<{ publicKey: string }>>;
    /** The address of the community this web app talks to (lib/api nodeAddress): a contact link made here names it. */
    community: () => string;
}

/** Deals and payments read: the newest this many (the node's largest page). */
export const LET_IN_PAGE = 200;

/**
 * How long let in once waits for its reads (#3366 review N2): `readMs` for each one, from when it is asked; `roundMs` for
 * all of one round's together, from its first. A read still out at either is aborted and counts as a read that failed;
 * one not yet asked once `roundMs` has passed isn't asked this round. A chat's lines and the members read are asked for
 * each person, so slow ones would otherwise add up: `roundMs` keeps them all under half the round's 45 s
 * (lib/outside-mail.ts OUTSIDE_ROUND_MS), with the round's page, its confirm and its waits kept behind them.
 */
export interface LetInTime { readMs: number; roundMs: number }
export const LET_IN_TIME: LetInTime = { readMs: 8_000, roundMs: 20_000 };

/** Each read named at its call, never at load: a page test that stands in for lib/api without these never meets them. */
const API_READS: WebLetInReads = {
    conversations: (me, signal) => getConversations(me, signal),
    lines: (id, signal) => getConversationMessages(id, undefined, signal),
    friends: (me, signal) => getFriends(me, signal),
    deals: (me, signal) => getMyMarketplaceTransactions(me, undefined, LET_IN_PAGE, undefined, signal),
    payments: (me, signal) => getTransactions(me, LET_IN_PAGE, signal),
    contacts: (me) => heldContactsList(me),
    members: async (keys, signal) => {
        const [batch] = memberKeysBatches(keys);
        return batch ? getMemberCards(memberKeysPath(batch), signal) : [];
    },
    community: () => nodeAddress(),
};

/** A read that failed but may pass later: no answer yet. Never a refusal. */
const FAILED: unique symbol = Symbol('failed');
/** A read's answer; null when refused (a 4xx that says no for good: as nothing); FAILED when it may pass later. */
type Read<T> = T | null | typeof FAILED;

/** Whether a thrown read may pass later: no answer, a time-out, a 5xx, or a 401 (a clock that is off), 408, 425 or 429. */
function mayPass(e: unknown): boolean {
    const status = (e as { status?: unknown } | null)?.status;
    return typeof status !== 'number' || status >= 500 || [401, 408, 425, 429].includes(status);
}

/** A read of one round's, asked with its own signal: FAILED should it not answer within its time (it is aborted then). */
type TimedRead = <T>(read: (signal: AbortSignal) => Promise<T>) => Promise<Read<T>>;

/**
 * `read`'s answer, or FAILED once `ms` has passed with none (its signal aborted then), whatever it still waits on; FAILED
 * at once, never asked, with no time left.
 */
function readOf<T>(read: (signal: AbortSignal) => Promise<T>, ms: number): Promise<Read<T>> {
    if (!(ms > 0)) return Promise.resolve(FAILED);
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<typeof FAILED>((resolve) => {
        timer = setTimeout(() => { stop.abort(); resolve(FAILED); }, ms);
    });
    const asked = Promise.resolve().then(() => read(stop.signal)).catch((e): Read<T> => (mayPass(e) ? FAILED : null));
    return Promise.race([asked, late]).finally(() => clearTimeout(timer));
}

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

/**
 * What one round reads once: the facts other than the lines and the contacts (`unsure`: one of them failed, and may pass
 * later); null when the chat list was refused, FAILED when its read failed.
 */
interface RoundFacts { chats: ListedChat[]; known: LetInKnown & { byFacts: Set<string>; notCurrent: Set<string> }; facts: LetInFacts; unsure: boolean }

async function readRound(me: string, reads: WebLetInReads, timed: TimedRead): Promise<RoundFacts | typeof FAILED | null> {
    const [list, friends, deals, payments] = await Promise.all([
        timed((signal) => reads.conversations(me, signal)),
        timed((signal) => reads.friends(me, signal)),
        timed((signal) => reads.deals(me, signal)),
        timed((signal) => reads.payments(me, signal)),
    ]);
    if (list === FAILED) return FAILED;
    if (!list || !Array.isArray(list.conversations)) return null;
    const { chats, notCurrent } = chatsOfList(me, [...list.conversations, ...(list.requests?.conversations ?? [])]);
    const facts: LetInFacts = {
        chats: chats.map((c) => c.chat),
        // The list is the member's own (GET /api/friends/:me answers only the signer's): each one they added.
        friends: (Array.isArray(friends) ? friends : []).map((f) => ({ owner: me, friend: f.publicKey })),
        deals: (Array.isArray(deals) ? deals : []).map((d) => ({ buyer: d.buyerPublicKey, seller: d.sellerPublicKey, status: d.status, listingAuthor: d.postAuthorPublicKey ?? null })),
        payments: (Array.isArray(payments) ? payments : []).map((p) => ({ from: p.from, to: p.to })),
    };
    return { chats, facts, known: { byFacts: letInByFacts(me, facts), notCurrent }, unsure: friends === FAILED || deals === FAILED || payments === FAILED };
}

/** The contacts' linked keys: those a link made in this community names (`here`), and those a link made elsewhere names. */
interface LinkedKeys { here: Set<string>; elsewhere: Set<string> }

function linkedKeysOf(list: Awaited<ReturnType<WebLetInReads['contacts']>>, me: string, community: string): LinkedKeys {
    const linked: LinkedKeys = { here: new Set(), elsewhere: new Set() };
    const here = outsideCommunityOf(community);
    for (const c of list?.contacts ?? []) {
        for (const l of c.links) {
            if (!l.key || l.key === me) continue;
            (outsideCommunityOf(l.community) === here ? linked.here : linked.elsewhere).add(l.key);
        }
    }
    return linked;
}

/**
 * For one round of mail across on the web (lib/outside-mail.ts `letIn`): whether a sender is let in, by core's rule over the
 * web's facts, and no block bars them (`blocked`: this community's list for the account, a block undone in this page among
 * it; throws when it can't be read, which counts as blocked). Read once, at the round's first ask: true, let in; false, not
 * (a read it needs refused among it); null, not known this round: a read the answer needs failed, and may pass later, or
 * didn't answer within its time (`time`, {@link LET_IN_TIME}).
 */
export function letInOnWeb(
    identity: { publicKey: string; privateKey: string },
    blocked: (key: string) => Promise<boolean>,
    reads: WebLetInReads = API_READS,
    time: LetInTime = LET_IN_TIME,
): (key: string) => Promise<boolean | null> {
    const me = identity.publicKey;
    let round: Promise<RoundFacts | typeof FAILED | null> | null = null;
    let contacts: Promise<Read<LinkedKeys>> | null = null;
    const linesRead = new Map<string, Promise<Read<boolean>>>();
    const listedHere = new Map<string, Promise<Read<boolean>>>();
    // All of this round's reads end by `time.roundMs` from the first (#3366 review N2): each is given its own time, or what
    // is left of that, whichever is less. A clock moved back gives none more than its own; moved on, none is asked.
    let ends: number | null = null;
    const timed: TimedRead = (read) => {
        const now = Date.now();
        ends ??= now + time.roundMs;
        return readOf(read, Math.min(time.readMs, ends - now));
    };
    return async (key) => {
        if (!key || key === me) return false;
        if (await blocked(key).catch(() => true)) return false;
        // Anything else that goes wrong in the reading (an answer of another shape) lets nobody in: the strict side.
        const read = await (round ??= readRound(me, reads, timed).catch(() => null));
        if (read === FAILED) return null;
        if (!read) return false;
        if (letInAmong([key], read.known).has(key)) return true;
        if (read.known.notCurrent.has(key)) return false;
        let unsure = read.unsure;
        // A line of the member's own, in a direct chat with this key: its newest lines, read once a round for each chat.
        for (const c of read.chats) {
            if (c.chat.memberWrote || chatLetsInKey(c.chat, me) !== key) continue;
            let wrote = linesRead.get(c.id);
            if (!wrote) {
                wrote = timed((signal) => reads.lines(c.id, signal))
                    .then((r): Read<boolean> => (r === FAILED ? FAILED : (r?.messages ?? []).some((l) => isMembersOwnLine(l, me))))
                    .catch(() => false);
                linesRead.set(c.id, wrote);
            }
            const said = await wrote;
            if (said === FAILED) unsure = true;
            else if (said) {
                c.chat.memberWrote = true;
                read.known.byFacts = letInByFacts(me, read.facts);
            }
        }
        if (letInAmong([key], read.known).has(key)) return true;
        if (!contactsCouldLetIn([key], read.known)) return false;
        // This browser's copy: none at all should it fail, as before; not known this round should it not answer in time.
        contacts ??= timed(() => reads.contacts(identity).catch(() => null))
            .then((list): Read<LinkedKeys> => (list === FAILED ? FAILED : linkedKeysOf(list, me, reads.community())))
            .catch(() => ({ here: new Set<string>(), elsewhere: new Set<string>() }));
        const linkedRead = await contacts;
        if (linkedRead === FAILED) unsure = true;
        const linked = linkedRead === FAILED || !linkedRead ? { here: new Set<string>(), elsewhere: new Set<string>() } : linkedRead;
        let counted = linked.elsewhere.has(key);
        // A link made here counts only while this community lists the key as a member now (#3366 review F1).
        if (!counted && linked.here.has(key)) {
            let listed = listedHere.get(key);
            if (!listed) {
                listed = timed((signal) => reads.members([key], signal))
                    .then((r): Read<boolean> => (r === FAILED ? FAILED : Array.isArray(r) && r.some((m) => m?.publicKey === key)))
                    .catch(() => false);
                listedHere.set(key, listed);
            }
            const said = await listed;
            if (said === FAILED) unsure = true;
            else counted = said === true;
        }
        if (letInAmong([key], { ...read.known, contacts: counted ? new Set([key]) : null }).has(key)) return true;
        return unsure ? null : false;
    };
}
