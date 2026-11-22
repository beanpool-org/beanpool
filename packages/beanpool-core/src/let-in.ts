/**
 * Let in once, as one rule for both apps (slice S3b, and S5 part 3: scratch/fable-design/DESIGN-no-switch-messaging-fable.md
 * §3 "Let in once"; Marty 19 Nov 2026, "yes to all 5"). Someone the member let in, in a community the device holds, is not
 * asked to wait at the door: their first line across opens a chat (core outside-chat.ts gateOutsideItem `letIn`), and on
 * the phone their request is accepted for the member.
 *
 * The rule is here, over plain facts; each app only reads its facts. The phone reads them with one plain SELECT through each
 * copy it holds (apps/native db.ts LET_IN_SQL); the web from what it already reads of its one community (its chat list and a
 * chat's lines, its friends, its deals, its payments: apps/pwa lib/let-in.ts). Neither app keeps a copy of the rule.
 *
 * Only a step the member took lets anyone in (#3319 review F1, the director's call of 21 Nov 2026: a stranger must not skip
 * the door by his own act):
 * - a direct chat the member took part in themselves ({@link memberTookPart}): a line of their own in it, or its request
 *   accepted by their own act (the node's `acceptedByYou`, never a trade's acceptance nor the node's own line). It lets in
 *   only the key it is sealed to ({@link chatLetsInKey});
 * - a friend the member added;
 * - a deal, pending or completed, in which the member took a step: as its buyer, or as its seller only on the buyer's own
 *   listing (a Need of theirs the member offered on). A deal on the member's own Offer, one only asked, declined or
 *   cancelled, is one person's word;
 * - someone the member paid. A payment received is not: anyone can send a member a Bean;
 * - a private contact the member linked to a member.
 *
 * Only under a key that is the person's now: never one the device knows a re-key replaced, nor one in question
 * (`notCurrent`), whichever fact names it. And a block beats all of it (S7: the phone's lists, the web's community's own list,
 * a block undone since included): someone blocked is never let in.
 */
import { DM_FROM_ADMINS_KEY, DM_NONCE_PREFIX } from './dm-crypto.js';

/** A direct chat the member is in, as one copy (the phone) or one community (the web) holds it. */
export interface LetInChat {
    /** Every key the copy names among the chat's people, the member's own left out or not. */
    others: readonly string[];
    /** The key the device holds the chat sealed to now (the phone's DM pin); null or absent where it keeps none. */
    sealedTo?: string | null;
    /** A line of the member's own in it ({@link isMembersOwnLine}: from any of their devices). */
    memberWrote: boolean;
    /** Its request accepted by the member's own act (the node's `acceptedByYou`). */
    acceptedByMember: boolean;
}

/** A deal the member is a party to, as the device holds it. */
export interface LetInDeal {
    buyer: string;
    seller: string;
    /** The deal's state ('requested', 'rejected', 'pending', 'completed', 'cancelled'). */
    status: string;
    /** Whose listing it is a deal on (the listing's author), as the device holds it; null when it doesn't. */
    listingAuthor: string | null | undefined;
}

/** What one copy or one community holds that let in once reads. A fact the device can't read is left out. */
export interface LetInFacts {
    chats?: readonly LetInChat[];
    friends?: readonly { owner: string; friend: string }[];
    deals?: readonly LetInDeal[];
    payments?: readonly { from: string; to: string }[];
}

/** The deal states in which a deal has both people's step in it: one only asked, declined or cancelled lets nobody in. */
const DEAL_STEPS_TAKEN: ReadonlySet<string> = new Set(['pending', 'completed']);

/** Whether the member took part in a direct chat themselves: a line of their own in it, or its request accepted by their own act. */
export function memberTookPart(chat: Pick<LetInChat, 'memberWrote' | 'acceptedByMember'>): boolean {
    return chat.memberWrote === true || chat.acceptedByMember === true;
}

/**
 * The key a direct chat is with: the one it is sealed to, never a key sealed to before it nor one a listing offers; with
 * none kept, its one other person; null when its people name several others, or none.
 */
export function chatLetsInKey(chat: Pick<LetInChat, 'others' | 'sealedTo'>, me: string): string | null {
    const others = chat.others.filter((k) => !!k && k !== me);
    // A seal kept, even an empty one, is the chat's word: only with none kept does its one other person count (the phone's rule since S3b).
    const key = chat.sealedTo ?? (others.length === 1 ? others[0] : null);
    return key && key !== me ? key : null;
}

/**
 * Whether a line of a direct chat, as stored, is one of the member's own: a sealed line in their name (from any of their
 * devices). Never a node's notice (type system), nor the admin page's message the node writes in an admin's name, nor any
 * line the node could have written (not sealed). The web reads a chat's lines with it; the phone's LET_IN_SQL reads the same
 * fact in SQL (MEMBERS_OWN_LINE_SQL).
 */
export function isMembersOwnLine(line: { authorPubkey: string; nonce?: string | null; type?: string | null; metadata?: unknown }, me: string): boolean {
    if (!me || line.authorPubkey !== me) return false;
    if ((line.type ?? 'text') === 'system') return false;
    if (typeof line.nonce !== 'string' || !line.nonce.startsWith(DM_NONCE_PREFIX)) return false;
    // As SQLite's json_extract reads it (1 for true): the admin page's mark, however it is spelled.
    const fromAdmins = metadataOf(line.metadata)?.[DM_FROM_ADMINS_KEY];
    return fromAdmins !== true && fromAdmins !== 1;
}

function metadataOf(metadata: unknown): Record<string, unknown> | null {
    if (metadata && typeof metadata === 'object') return metadata as Record<string, unknown>;
    if (typeof metadata !== 'string') return null;
    try {
        const parsed = JSON.parse(metadata);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/** The keys some facts let in, before `notCurrent` and the block ({@link letInAmong}, {@link isLetIn}). Never the member. */
export function letInByFacts(me: string, facts: LetInFacts): Set<string> {
    const out = new Set<string>();
    const add = (key: string | null | undefined) => { if (key && key !== me) out.add(key); };
    for (const chat of facts.chats ?? []) if (memberTookPart(chat)) add(chatLetsInKey(chat, me));
    for (const f of facts.friends ?? []) if (f.owner === me) add(f.friend);
    for (const d of facts.deals ?? []) {
        if (!DEAL_STEPS_TAKEN.has(d.status)) continue;
        if (d.buyer === me) add(d.seller);
        else if (d.seller === me && !!d.listingAuthor && d.listingAuthor === d.buyer) add(d.buyer);
    }
    for (const p of facts.payments ?? []) if (p.from === me) add(p.to);
    return out;
}

/** What is known for let in once: whom the facts let in, the keys that are no one's key now, and the linked contacts. */
export interface LetInKnown {
    byFacts: ReadonlySet<string>;
    notCurrent: ReadonlySet<string>;
    /** The member's private contacts linked to a member, by key; null or absent while not read. */
    contacts?: ReadonlySet<string> | null;
}

/** Which of `keys` the member let in, by what is known: only a key that is the person's now, let in by a fact or a contact. */
export function letInAmong(keys: readonly string[], known: LetInKnown): Set<string> {
    const found = new Set<string>();
    for (const k of keys) {
        if (!k || known.notCurrent.has(k)) continue;
        if (known.byFacts.has(k) || known.contacts?.has(k)) found.add(k);
    }
    return found;
}

/** Whether reading the contacts could let in more of `keys` than the facts do: a key that is someone's now that no fact lets in. */
export function contactsCouldLetIn(keys: readonly string[], known: Pick<LetInKnown, 'byFacts' | 'notCurrent'>): boolean {
    return keys.some((k) => !!k && !known.notCurrent.has(k) && !known.byFacts.has(k));
}

/**
 * Whether `key` is let in: never while a block bars it (`blocked`: the app's block rule for that key, a block undone since or
 * a list that can't be read included), else {@link letInAmong}.
 */
export function isLetIn(input: LetInKnown & { key: string; blocked: boolean }): boolean {
    if (input.blocked) return false;
    return letInAmong([input.key], input).has(input.key);
}
