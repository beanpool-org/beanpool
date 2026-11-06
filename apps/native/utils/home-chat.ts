/**
 * Home's "A chat" card on the phone (scratch/fable-design/DESIGN-home-chosen-chat-fable.md §1–§3, slice C2): the rules,
 * kept pure so they are tested once (utils/__tests__/home-cards.test.ts). The node sends a pinned chat's last lines as
 * stored (core HomeChatLine): readable lines as words, sealed ones as their bytes. The phone opens the sealed ones itself
 * (utils/home-chat-open.ts: a DM through db.ts's own key context and thread check, a locked group line only with a key
 * already open in memory), and this file words what was opened. Nothing opened is ever kept: the kept answer
 * (utils/home-store.ts) holds the node's bytes, and the words live in the screen's memory only.
 *
 * - A line the device opened is its writer's words: "You" for the member's own, else the writer's name.
 * - A DM line that didn't open, or wasn't encrypted, is nobody's (core dmLineKind, as the chat shows it).
 * - A locked group line whose key isn't open in this session: "🔒 Message · open to read" (Marty's Q2: no fetch).
 * - A photo: "📷 Photo". A sealed line too long to carry: "🔒 Message". A removed line: the chat's own notice.
 * - Gone (`left`, `hidden`, `request`): "You're no longer in this chat." and Remove; the card never drops itself.
 */
import {
    DM_LINE_NOT_ENCRYPTED_TEXT, HOME_CHAT_KINDS, homeChatPicked, readChatSettings, t, tn, word,
    type HomeChatCard, type HomeChatKind, type HomeChatLine, type HomeChatSettings,
} from '@beanpool/core';
import type { HomeCardInstance } from '@beanpool/core';
import { chatAuthorWords, chatLineWords } from './chat-line-words';
import { tombstoneWords } from './chat-actions';
import type { NeedsYouTarget } from './needs-you';
import { chatEmoji, type YourChat } from './your-groups';
import type { getConversations } from './db';

/** The card's own words (shown through t() where they are drawn). */
export const CHAT_CARD_WORDS = {
    pick: word('Pick a chat'),
    empty: word('Nothing said here yet.'),
    gone: word("You're no longer in this chat."),
    locked: word('🔒 Message'),
    openToRead: word('🔒 Message · open to read'),
    photo: word('📷 Photo'),
    filter: word('Find a chat'),
    none: word('No chats yet.'),
    failed: word("Couldn't load your chats. Try again."),
};

/** The node's word for a sealed line too long to carry (apps/server engine/your-groups.ts LOCKED_PREVIEW). */
export const NODE_LOCKED_PREVIEW = '🔒 Message';
/** The settings list shows a filter box once it holds more rows than this (design §2). */
export const CHAT_PICK_FILTER_AFTER = 8;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const GONE = new Set(['left', 'hidden', 'request']);

/** A line read tolerantly off the network: anything without an id, author, time and kind is left out. */
function readLine(raw: unknown): HomeChatLine | null {
    if (!isObj(raw)) return null;
    const { id, author, at, type } = raw;
    if (typeof id !== 'string' || typeof author !== 'string' || typeof at !== 'string' || typeof type !== 'string') return null;
    const line: HomeChatLine = {
        id, author, at, type,
        who: typeof raw.who === 'string' ? raw.who : null,
        systemType: typeof raw.systemType === 'string' ? raw.systemType : null,
    };
    if (typeof raw.text === 'string') line.text = raw.text;
    if ('metadata' in raw) line.metadata = typeof raw.metadata === 'string' ? raw.metadata : null;
    const s = raw.sealed;
    if (isObj(s) && typeof s.ciphertext === 'string' && typeof s.nonce === 'string') {
        line.sealed = { ciphertext: s.ciphertext, nonce: s.nonce, metadata: typeof s.metadata === 'string' ? s.metadata : null };
    }
    return line;
}

/**
 * The node's body for a chat card, read tolerantly: the chat as the member reads it now, or `gone` alone. Null when the
 * answer has none for this card (not asked yet, offline before the first answer, a newer node's odd body), or the card
 * has no chat picked. A re-pick gives the card a new id ({@link import('./home-cards').changeCardSettings}), so a kept
 * body is never another chat's.
 */
export function chatCardFor(answer: { cards?: unknown } | null | undefined, inst: Pick<HomeCardInstance, 'id' | 'settings'>): HomeChatCard | null {
    const pick = readChatSettings(inst.settings);
    if (!homeChatPicked(pick)) return null;
    const raw = isObj(answer?.cards) ? (answer!.cards as Record<string, unknown>)[inst.id] : undefined;
    if (!isObj(raw)) return null;
    if (typeof raw.gone === 'string') return GONE.has(raw.gone) ? { gone: raw.gone as 'left' | 'hidden' | 'request' } : null;
    if (!(HOME_CHAT_KINDS as readonly unknown[]).includes(raw.kind) || !Array.isArray(raw.lines)) return null;
    // The phone's own pick says what the chat is, never the node: a body of another kind is no answer (fail closed, as the
    // DM screen judges a chat by what this phone knows, db.ts getMessages). Else a node could answer a pinned DM as an
    // event's chat and have a readable line drawn in the other person's name, or a locked group as an enterprise's.
    if (raw.kind !== pick.kind) return null;
    return {
        kind: raw.kind as HomeChatKind,
        name: typeof raw.name === 'string' ? raw.name : null,
        unread: typeof raw.unread === 'number' && Number.isFinite(raw.unread) && raw.unread > 0 ? Math.floor(raw.unread) : 0,
        muted: raw.muted === true,
        lines: raw.lines.map(readLine).filter((l): l is HomeChatLine => l !== null),
    };
}

/** The chat a card has picked, or null ("Pick a chat"). */
export const chatPickOf = (inst: Pick<HomeCardInstance, 'settings'>): HomeChatSettings | null => {
    const s = readChatSettings(inst.settings);
    return homeChatPicked(s) ? s : null;
};

/**
 * What the device made of one line (utils/home-chat-open.ts), held in memory only:
 * - `words`: it opened; `signer` is the key that wrote it (a group line's opening key; a DM line's row author, bound in).
 * - `nobody`: shown as nobody's, in the lower layer's English (a DM line not verified or not encrypted, a group line
 *   that didn't verify); the card translates it (chat-line-words).
 * - `waiting`: a locked group line whose key isn't open in this session.
 * - `hidden`: never shown (from before the member's membership).
 */
export type OpenedChatLine =
    | { kind: 'words'; text: string; signer: string; name?: string | null }
    | { kind: 'nobody'; text: string }
    | { kind: 'waiting' }
    | { kind: 'hidden' };

/** What the screen hands the body: each line's opening, by id, and whether a group's chat is locked on this phone. */
export interface OpenedChat {
    lines: ReadonlyMap<string, OpenedChatLine>;
    /** A group chat this phone has held keys of (GroupKeyring.seenLocked): a readable line in a member's name is nobody's. */
    locked?: boolean;
}

/** One line as the card draws it: who wrote it (null: nobody's, or the node's own), and what it says. */
export interface ChatCardLine { id: string; who: string | null; at: string; text: string }

const parse = (m: string | null | undefined): Record<string, unknown> | null => {
    if (!m) return null;
    try { const v = JSON.parse(m); return isObj(v) ? v : null; } catch { return null; }
};

const isRemoved = (l: HomeChatLine) => l.type === 'removed' || parse(l.metadata ?? l.sealed?.metadata)?.removed === true;

/** The chat's kind as the chat screens name it (utils/chat-actions.ts ChatKind), for a removed line's notice. */
const chatKindOf = (k: HomeChatKind) => (k === 'dm' ? 'dm' : k) as 'dm' | 'group' | 'event' | 'enterprise';

/**
 * One line's words on the card, or null when it is never shown. `me`: the member's key ("You"). `opened`: what the
 * device made of the lines (absent: not opened yet). Until then a line the device must judge (any line of a DM or a
 * group's chat but the node's own and a removed one) is "…", nobody's, as a chat draws a line it hasn't opened yet: never
 * the node's words in a member's name, and never a warning that goes a moment later.
 */
export function chatLineView(line: HomeChatLine, kind: HomeChatKind, me: string | null | undefined, opened?: OpenedChat): ChatCardLine | null {
    const mine = (key: string | null | undefined) => !!me && !!key && key === me;
    const base = { id: line.id, at: line.at };
    if (isRemoved(line)) {
        return { ...base, who: null, text: tombstoneWords({ senderId: line.author, metadata: parse(line.metadata ?? line.sealed?.metadata) ?? undefined }, chatKindOf(kind)) };
    }
    if (line.type === 'system' || line.author === 'SYSTEM') return { ...base, who: null, text: chatLineWords(line.text ?? '') };
    if (!opened && (kind === 'dm' || kind === 'group' || !!line.sealed)) return { ...base, who: null, text: '…' };
    const got = opened?.lines.get(line.id);
    if (got?.kind === 'hidden') return null;
    if (got?.kind === 'nobody') return { ...base, who: null, text: chatLineWords(got.text) };
    if (line.sealed) {
        if (!got || got.kind === 'waiting') return { ...base, who: null, text: kind === 'dm' ? t(CHAT_CARD_WORDS.locked) : t(CHAT_CARD_WORDS.openToRead) };
        const who = mine(got.signer) ? t('You') : (got.name ? chatAuthorWords(got.name) : line.who);
        return { ...base, who, text: line.type === 'image' ? t(CHAT_CARD_WORDS.photo) : got.text };
    }
    // A sealed line too long to carry: no bytes came, so nothing opens and nobody is named.
    if (line.text === NODE_LOCKED_PREVIEW && !('metadata' in line)) return { ...base, who: null, text: t(CHAT_CARD_WORDS.locked) };
    // A readable line. In a DM the device judges it (home-chat-open.ts hands back `nobody` or the admins' words); in a
    // group chat this phone holds keys of, a readable line in a member's name is nobody's, as the chat shows it.
    if (got?.kind === 'words') return { ...base, who: mine(got.signer) ? t('You') : (got.name ? chatAuthorWords(got.name) : line.who), text: line.type === 'image' ? t(CHAT_CARD_WORDS.photo) : got.text };
    if (kind === 'dm') return { ...base, who: null, text: chatLineWords(DM_LINE_NOT_ENCRYPTED_TEXT) };
    if (kind === 'group' && opened?.locked) return { ...base, who: null, text: chatLineWords(GROUP_LINE_UNVERIFIED_TEXT) };
    return { ...base, who: mine(line.author) ? t('You') : line.who, text: line.type === 'image' ? t(CHAT_CARD_WORDS.photo) : (line.text ?? '') };
}

/** utils/group-line-display.ts GROUP_LINE_UNVERIFIED_TEXT, said again here (chat-line-words translates it by its English). */
const GROUP_LINE_UNVERIFIED_TEXT = "This message couldn't be verified.";

/** What the card's body draws. */
export type ChatCardView =
    | { state: 'pick' }
    | { state: 'waiting'; name: string }
    | { state: 'gone' }
    | { state: 'chat'; name: string; muted: boolean; pill: string | null; lines: ChatCardLine[] };

/**
 * The card's body: "Pick a chat" with none picked; the picked chat's name and "Shows when your community answers" before
 * the node has answered for it; "You're no longer in this chat." when it is gone; else its name, 🔕 when muted, the new
 * count (hidden at 0) and its last lines oldest first, "Nothing said here yet." when it has none.
 */
export function chatCardView(
    inst: Pick<HomeCardInstance, 'id' | 'settings'>, card: HomeChatCard | null, me: string | null | undefined, opened?: OpenedChat,
): ChatCardView {
    const pick = chatPickOf(inst);
    if (!pick) return { state: 'pick' };
    // A body of another kind than the pick's is no answer (chatCardFor): its lines are never judged by the node's word.
    if (!card || (!('gone' in card) && card.kind !== pick.kind)) return { state: 'waiting', name: pick.name || t('A chat') };
    if ('gone' in card) return { state: 'gone' };
    const lines = card.lines.map(l => chatLineView(l, pick.kind, me, opened)).filter((l): l is ChatCardLine => l !== null);
    return {
        state: 'chat',
        name: card.name || pick.name || t('A chat'),
        muted: card.muted,
        pill: card.unread > 0 && !card.muted ? tn(card.unread, '{n} new', '{n} new') : null,
        lines,
    };
}

/** Where a tap on the card goes: the chat, told its kind on the way in (needs-you.ts needsTargetHref). */
export function chatCardTarget(pick: HomeChatSettings): Extract<NeedsYouTarget, { to: 'chat' }> {
    if (pick.kind === 'event') return { to: 'chat', conversationId: pick.conversationId, event: true };
    if (pick.kind === 'group' || pick.kind === 'enterprise') return { to: 'chat', conversationId: pick.conversationId, thread: pick.kind };
    return { to: 'chat', conversationId: pick.conversationId };
}

// ── The settings list (design §2 "Settings = pick a chat") ────────────────────────────────────────────────────────

/** One chat the member can pin, as the settings list shows it. */
export interface ChatChoice { conversationId: string; kind: HomeChatKind; name: string; emoji: string; at: string | null }

/**
 * One of the phone's own chats as db.ts getConversations builds it: the fields the settings list reads, every one
 * required, so a renamed field fails the type check instead of dropping every DM (review of #2943, finding 1).
 */
export type PhoneChatRow = Pick<Awaited<ReturnType<typeof getConversations>>[number], 'id' | 'type' | 'peer' | 'rawTimestamp' | 'request'>;

/** A chat the phone keeps as a DM: getConversations' `type` (a row with none is a DM there too). */
const isPhoneDm = (c: PhoneChatRow) => c.type === 'dm' || c.type == null;
/** A DM that is still a request (waiting, ignored or lapsed). One that began as a request and was accepted keeps
 *  `{ state: 'accepted' }` for good (the node's test-dm-requests), and is a chat like any other. Unreadable is no request,
 *  as db's isRequestFor reads it. */
const isOpenRequest = (request: unknown): boolean => {
    let r: unknown = request;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return false; } }
    return !!r && typeof r === 'object' && (r as { state?: unknown }).state !== 'accepted';
};

/**
 * The settings list: the member's group-like chats first (🥖🎯📅, a group's emoji), then people, each part newest first;
 * never a DM request still waiting, one with no id or one whose id is longer than a card keeps. `dms`: the phone's own
 * chats as getConversations builds them (`peer`: the name Talk shows; `rawTimestamp`: the ISO time, as `timestamp` is a
 * clock string). A chat this phone keeps as a DM is listed as that person, never as a group the node lists under the same
 * id, so the pick's kind is the phone's own and the card judges its lines as a DM's.
 */
export function chatChoices(
    groups: readonly { conversationId: string; kind: string; name: string; emoji: string; lastActivityAt?: string | null }[],
    dms: readonly PhoneChatRow[],
): ChatChoice[] {
    const ok = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64;
    const newest = (a: ChatChoice, b: ChatChoice) => (b.at ?? '').localeCompare(a.at ?? '');
    const people = new Set(dms.filter(isPhoneDm).map(c => c.id));
    const g = groups
        .filter(c => ok(c.conversationId) && !people.has(c.conversationId) && (c.kind === 'group' || c.kind === 'enterprise' || c.kind === 'event'))
        .map(c => ({ conversationId: c.conversationId, kind: c.kind as HomeChatKind, name: c.name.trim().slice(0, 60), emoji: c.emoji, at: c.lastActivityAt ?? null }))
        .sort(newest);
    const p = dms
        .filter(c => ok(c.id) && isPhoneDm(c) && !isOpenRequest(c.request))
        .map(c => ({ conversationId: c.id, kind: 'dm' as const, name: String(c.peer ?? '').trim().slice(0, 60), emoji: '👤', at: typeof c.rawTimestamp === 'string' ? c.rawTimestamp : null }))
        .filter(c => c.name.length > 0)
        .sort(newest);
    return [...g, ...p];
}

/**
 * The settings list from its two reads, as the sheet shows it (index.tsx reads them once as the sheet opens): the node's
 * list of the member's group-like chats (db.ts fetchYourGroups) and the phone's own chats (getConversations), null for a
 * read that failed. Either failed (offline, the node down): the list isn't whole, so the sheet says "Couldn't load your
 * chats. Try again.", never "No chats yet." to a member who has chats, nor a list with their groups silently left out.
 */
export function chatPickList(
    groups: readonly Pick<YourChat, 'conversationId' | 'kind' | 'name' | 'category' | 'lifecycle' | 'lastActivityAt'>[] | null,
    dms: readonly PhoneChatRow[] | null,
): { rows: ChatChoice[] | null; failed: boolean } {
    if (!groups || !dms) return { rows: null, failed: true };
    const g = groups.map(c => ({ conversationId: c.conversationId, kind: c.kind, name: c.name, emoji: chatEmoji(c.kind, c.category, c.lifecycle), lastActivityAt: c.lastActivityAt }));
    return { rows: chatChoices(g, dms), failed: false };
}

/** The rows a filter keeps: any whose name holds the words, any case. */
export function filterChatChoices(rows: readonly ChatChoice[], q: string): ChatChoice[] {
    const words = q.trim().toLocaleLowerCase();
    return words ? rows.filter(r => r.name.toLocaleLowerCase().includes(words)) : [...rows];
}

/** The chats the other chat cards on Home hold (not `exceptId`, the card being changed). */
export function chatsOnHome(cards: readonly Pick<HomeCardInstance, 'id' | 'type' | 'settings'>[], exceptId?: string): Set<string> {
    const out = new Set<string>();
    for (const c of cards) {
        if (c.type !== 'chat' || c.id === exceptId) continue;
        const pick = chatPickOf(c);
        if (pick) out.add(pick.conversationId);
    }
    return out;
}

/** The settings a picked row stores (core readChatSettings reads them back). */
export const chatSettingsOf = (row: ChatChoice): HomeChatSettings => ({ conversationId: row.conversationId, kind: row.kind, name: row.name });
