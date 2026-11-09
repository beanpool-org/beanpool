/**
 * "About this listing" in a direct message (Marty, 9 Nov, after pressing Message on one of Rob's posts and landing in a chat
 * with no word of which post it was: "so when someone reads it they don't know which post it relates to?"). WhatsApp's
 * product message is the reference: a small card above the words, and a chip above the composer before they are sent.
 *
 * A DM is one thread per pair, so the listing is not the thread's. It belongs to ONE message, and it travels where the
 * words do, sealed:
 *
 *   - The reference (the listing's id, its title as the sender saw it, and its kind) is its own sealed part of the message
 *     ('about', dm-crypto.ts): the same key as the words, bound to the conversation, the sender and the message id, and to
 *     its part name, so the node can't move it to another message or show it as the words. It rides in the message's
 *     metadata as the sealed bytes and nonce, like the photo's nonce rides beside the photo. The node reads nothing new:
 *     no plaintext field, no listing id in the clear, and a line it stores is the same shape it always stored.
 *   - The words themselves are untouched. A chat's list preview, a copy of the line, a quote of it and a report of it all
 *     read the words alone, and an app from before this change shows the words and ignores the metadata key.
 *   - What the reader sees is the LISTING's own title, kind and price, looked up by id. The title that travels is only a
 *     fallback until the lookup returns (and it is the sender's claim, so it is never what a tap opens).
 *
 * The chip before sending lives in memory, per conversation (chatAboutDrafts): it survives typing and a change of screen,
 * never an app restart.
 */
import { openDmLine, sealDmLine, type DmKeyContext, type DmKeys, type DmPayload } from './dm-crypto.js';
import { beansPriceWords } from './event-copy.js';
import { t, word } from './words.js';

/** The metadata key the sealed reference rides under. */
export const DM_ABOUT_KEY = 'about';

/** The kinds of listing a Message button sits on. */
export type ChatAboutKind = 'offer' | 'need' | 'event';

/** What travels, sealed: the listing's id, its title as the sender saw it, and its kind. Nothing else. */
export interface ChatAbout {
    postId: string;
    title: string;
    kind: ChatAboutKind;
}

/** The chip above the composer: what travels, and the price in words, which is only for the chip and never sent. */
export interface ChatAboutChip extends ChatAbout {
    price: string | null;
}

/** The longest title that travels. */
export const CHAT_ABOUT_TITLE_MAX = 120;

const POST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const KINDS: readonly ChatAboutKind[] = ['offer', 'need', 'event'];

export const CHAT_ABOUT_WORDS = {
    chipPriced: word('About: {title} · {price}'),
    chip: word('About: {title}'),
    gone: word('This listing is no longer up.'),
    drop: word('Leave this listing out of your message'),
    open: word('Open this listing'),
    offer: word('Offer'),
    need: word('Need'),
    event: word('Event'),
} as const;

/** A listing as the apps hold it, in either spelling (the web's camelCase, the phone's database columns). */
export interface AboutPostLike {
    id?: string | null;
    type?: string | null;
    title?: string | null;
    credits?: number | string | null;
    priceType?: string | null;
    price_type?: string | null;
    status?: string | null;
}

function kindOf(type: unknown): ChatAboutKind | null {
    return typeof type === 'string' && (KINDS as readonly string[]).includes(type) ? (type as ChatAboutKind) : null;
}

function perOf(post: AboutPostLike): 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly' {
    const per = post.priceType ?? post.price_type;
    return per === 'hourly' || per === 'daily' || per === 'weekly' || per === 'monthly' ? per : 'fixed';
}

/**
 * The chip for a listing the member pressed Message on; null for a listing that can't be asked about (a poll, a post
 * with no id or no title). An event has no price, so its chip has none.
 */
export function aboutOfPost(post: AboutPostLike | null | undefined): ChatAboutChip | null {
    const kind = kindOf(post?.type);
    const id = typeof post?.id === 'string' ? post.id : '';
    const title = typeof post?.title === 'string' ? post.title.trim().slice(0, CHAT_ABOUT_TITLE_MAX) : '';
    if (!post || !kind || !POST_ID.test(id) || !title) return null;
    const beans = Number(post.credits);
    const price = kind === 'event' || post.credits === null || post.credits === undefined || post.credits === '' || !Number.isFinite(beans)
        ? null
        : beansPriceWords({ beans, per: perOf(post) });
    return { postId: id, title, kind, price };
}

/** The chip's line: "About: Fresh eggs · 6 Beans", or "About: Fresh eggs" where there is no price. */
export function chatAboutChipWords(chip: ChatAboutChip): string {
    return chip.price
        ? t(CHAT_ABOUT_WORDS.chipPriced, { title: chip.title, price: chip.price })
        : t(CHAT_ABOUT_WORDS.chip, { title: chip.title });
}

/** The kind chip's word. */
export function chatAboutKindWords(kind: ChatAboutKind): string {
    return t(CHAT_ABOUT_WORDS[kind]);
}

function aboutText(about: ChatAbout): string {
    return JSON.stringify({ v: 1, post: about.postId, title: about.title.slice(0, CHAT_ABOUT_TITLE_MAX), kind: about.kind });
}

/** The listing a sealed reference names, or null for anything that isn't exactly one (never a guess). */
export function parseChatAbout(text: unknown): ChatAbout | null {
    if (typeof text !== 'string') return null;
    let o: any;
    try { o = JSON.parse(text); } catch { return null; }
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) return null;
    const kind = kindOf(o.kind);
    if (typeof o.post !== 'string' || !POST_ID.test(o.post) || typeof o.title !== 'string' || !o.title.trim() || !kind) return null;
    return { postId: o.post, title: o.title.slice(0, CHAT_ABOUT_TITLE_MAX), kind };
}

/** Which message the reference is sealed to. `replyToId` is the line's own, as its metadata names it. */
export interface ChatAboutBinding {
    senderPubHex: string;
    messageId: string;
    replyToId?: string | null;
}

/** Seal a reference to one message. The same key as its words; its own part, so it never opens as them. */
export function sealChatAbout(about: ChatAbout, ctx: DmKeyContext, line: ChatAboutBinding): DmPayload {
    return sealDmLine(aboutText(about), ctx, { senderPubHex: line.senderPubHex, messageId: line.messageId, part: 'about', replyToId: line.replyToId });
}

/** A line's metadata with a sealed reference added under {@link DM_ABOUT_KEY}; the rest of it is kept as it was. */
export function metadataWithAbout(metadata: string | undefined, sealed: DmPayload): string {
    let base: Record<string, unknown> = {};
    if (metadata) {
        try {
            const parsed = JSON.parse(metadata);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
        } catch { base = {}; }
    }
    return JSON.stringify({ ...base, [DM_ABOUT_KEY]: { ciphertext: sealed.ciphertext, nonce: sealed.nonce } });
}

function metaObject(metadata: unknown): any {
    if (typeof metadata === 'string' && metadata) {
        try { return JSON.parse(metadata); } catch { return null; }
    }
    return metadata && typeof metadata === 'object' ? metadata : null;
}

/** True when a line's metadata carries a sealed reference (it may still not open). */
export function hasChatAbout(metadata: unknown): boolean {
    const raw = metaObject(metadata)?.[DM_ABOUT_KEY];
    return !!raw && typeof raw === 'object' && typeof raw.ciphertext === 'string' && typeof raw.nonce === 'string';
}

/** What opening a line's reference needs: the line as the node stores it. */
export interface ChatAboutLine {
    conversationId: string;
    senderPubHex: string;
    messageId: string;
    metadata: unknown;
}

/**
 * The listing a line is about, opened, or null: the line has none (every line from before this change), the sealed bytes
 * don't open for this line (moved, changed, or another message's), or what opened isn't a reference. Never throws; a line
 * is shown with or without its card, never refused for it.
 */
export function chatAboutOfLine(keys: DmKeys | null, line: ChatAboutLine): ChatAbout | null {
    if (!keys || !hasChatAbout(line.metadata)) return null;
    const raw = metaObject(line.metadata)[DM_ABOUT_KEY];
    try {
        const opened = openDmLine({ ciphertext: raw.ciphertext, nonce: raw.nonce }, keys, { ...line, part: 'about' }, [3]);
        return parseChatAbout(opened.text);
    } catch {
        return null;
    }
}

/** What the card in a bubble shows. */
export interface ChatAboutCard {
    postId: string;
    /** The listing is gone or hidden from this reader: the card says so and opens nothing. */
    gone: boolean;
    title: string;
    kind: ChatAboutKind;
    kindWords: string;
    price: string | null;
    /** The line a gone listing's card shows in the title's place. */
    goneWords: string | null;
}

/**
 * The card for a reference. `live` is the listing as THIS reader can read it: an object once found, null when the reader
 * cannot see it or it is gone, undefined while that is still being looked up (the card then shows the sender's own title
 * and kind, with no price). Once found, the listing's own title, kind and price are what show: what the sender claimed
 * decides nothing but what shows before the lookup.
 */
export function chatAboutCard(about: ChatAbout, live: AboutPostLike | null | undefined): ChatAboutCard {
    if (live === null || (live && live.status === 'removed')) {
        return { postId: about.postId, gone: true, title: '', kind: about.kind, kindWords: chatAboutKindWords(about.kind), price: null, goneWords: t(CHAT_ABOUT_WORDS.gone) };
    }
    if (!live) {
        return { postId: about.postId, gone: false, title: about.title, kind: about.kind, kindWords: chatAboutKindWords(about.kind), price: null, goneWords: null };
    }
    const chip = aboutOfPost({ ...live, id: about.postId });
    const kind = chip?.kind ?? about.kind;
    return { postId: about.postId, gone: false, title: chip?.title ?? about.title, kind, kindWords: chatAboutKindWords(kind), price: chip?.price ?? null, goneWords: null };
}

// ───────────────────────── the chip before it is sent ─────────────────────────

type Listener = () => void;

/**
 * The reference waiting to go with the next message, per conversation. In memory only: it survives typing and a change
 * of screen, and is gone when the app restarts. `get` returns the same object until it changes (a store a screen can
 * subscribe to).
 */
function makeDrafts() {
    const drafts = new Map<string, ChatAboutChip>();
    const listeners = new Set<Listener>();
    const changed = () => { for (const l of [...listeners]) l(); };
    return {
        set(conversationId: string, chip: ChatAboutChip | null): void {
            if (!conversationId) return;
            if (chip) drafts.set(conversationId, chip); else drafts.delete(conversationId);
            changed();
        },
        get(conversationId: string | null | undefined): ChatAboutChip | null {
            return (conversationId && drafts.get(conversationId)) || null;
        },
        drop(conversationId: string | null | undefined): void {
            if (conversationId && drafts.delete(conversationId)) changed();
        },
        subscribe(listener: Listener): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        clear(): void {
            drafts.clear();
            changed();
        },
    };
}

export const chatAboutDrafts = makeDrafts();
