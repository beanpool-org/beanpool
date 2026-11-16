/**
 * Chats with people in other communities, the parts both apps share (messages across communities X3 phone, X4 web:
 * scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.2, §3.5, §3.6; DESIGN-reaching-across-fable.md §6 items 2 and 9).
 * What crosses between the servers, and its envelope, is relay-envelope.ts; the mailbox is the server's (X2).
 *
 * **The address card** is a member's `{key, home, name}`, signed by their member key under its own tag, shown as a QR code
 * and a link `https://<home>/card#<card>` (the part after `#` never reaches a server). A card that points a key at a home
 * its owner did not sign fails ({@link addressCardFromText} answers null): nobody can hand round a card that sends a
 * member's replies elsewhere. The name on it is the one the member uses at home, and is shown "not confirmed here".
 *
 * **A line across communities** is a direct line, sealed and signed in format 4 (dm-crypto.ts) under the conversation named
 * from the two keys alone (relay-envelope.ts relayConversationId), its message id the envelope's item id. What it seals is
 * `{"v":1,"t":<words>,"name":<the sender's name>}`: the sender's name travels inside the seal (reaching-across item 9), so
 * neither server reads it. The payload the envelope carries is `{"v":1,"c":<ciphertext>,"n":<nonce>,"r"?:<reply to>}`.
 * The reader checks that the line is the envelope's (same sender, same recipient, same id) before it shows a word.
 *
 * **A change to a line** (slice X6: an edit, a reaction, a delete for everyone) is an item of its own kind, sealed and signed
 * the same way ({@link sealOutsideChange}); an open chat takes it, a request never does, and one rule says what a device does
 * with it ({@link outsideChangeVerdict}) and how the line then reads ({@link outsideLineShown}).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { openDmLine, sealDmLine, type DmPayload } from './dm-crypto.js';
import { isNodeHost, signatureBytesOf } from './node-request-signing.js';
import { relayConversationId, type RelayEnvelope } from './relay-envelope.js';
import { toBase64, utf8Bytes, type Signer } from './request-signing.js';
import { t } from './words.js';

/** First value of what a card's owner signs: this use's own name, so no other signature by the key can be taken for one. */
export const ADDRESS_CARD_TAG = 'beanpool-address-card/1';
/** The longest name a card carries, in characters. */
export const ADDRESS_CARD_NAME_MAX = 60;
/** The path a card's link names on its home; the card itself rides after the `#`. */
export const ADDRESS_CARD_PATH = '/card';

const KEY_HEX = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A member's address card, as it travels. */
export interface AddressCard {
    v: 1;
    /** Their member key, raw Ed25519, lower-case hex. */
    key: string;
    /** Their community's server, as relay-envelope.ts spells a home: `host`, or `host:port` for a port other than 443. */
    home: string;
    /** The name they use at home: 1 to 60 characters, no line breaks. */
    name: string;
    /** Their signature (base64) over {@link addressCardDigest}. */
    sig: string;
}

/** A name a card may carry, trimmed, or null. */
export function addressCardName(name: unknown): string | null {
    if (typeof name !== 'string') return null;
    const n = name.trim();
    return n.length > 0 && n.length <= ADDRESS_CARD_NAME_MAX && !CONTROL.test(n) ? n : null;
}

/** What a card's owner signs: SHA-256 of the UTF-8 of the JSON array [tag, key, home, name]. */
export function addressCardDigest(c: Pick<AddressCard, 'key' | 'home' | 'name'>): Uint8Array {
    return sha256(utf8Bytes(JSON.stringify([ADDRESS_CARD_TAG, c.key, c.home, c.name])));
}

/** The card for `key` at `home` under `name`, signed by `sign` (the key's own). Throws, signing nothing, for fields that aren't a card's. */
export async function signAddressCard(c: { key: string; home: string; name: string }, sign: Signer): Promise<AddressCard> {
    const name = addressCardName(c.name);
    if (!KEY_HEX.test(c.key)) throw new Error('A card names a member key of 64 lower-case hex characters.');
    if (!isNodeHost(c.home)) throw new Error('A card names a home in its one spelling (host, or host:port).');
    if (!name) throw new Error(`A card carries a name of 1 to ${ADDRESS_CARD_NAME_MAX} characters on one line.`);
    const fields = { key: c.key, home: c.home, name };
    return { v: 1, ...fields, sig: toBase64(await sign(addressCardDigest(fields))) };
}

/** Whether `card` is a card in its one form, signed by the key it names. Never throws. */
export function addressCardVerifies(card: unknown): card is AddressCard {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
    const c = card as Record<string, unknown>;
    if (c.v !== 1 || typeof c.key !== 'string' || !KEY_HEX.test(c.key) || !isNodeHost(c.home)) return false;
    if (typeof c.name !== 'string' || addressCardName(c.name) !== c.name) return false;
    const sig = signatureBytesOf(c.sig);
    if (!sig) return false;
    try {
        return ed25519.verify(sig, addressCardDigest(c as unknown as AddressCard), hexToBytes(c.key), { zip215: false });
    } catch {
        return false;
    }
}

function base64UrlOf(text: string): string {
    return toBase64(utf8Bytes(text)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function textOfBase64Url(s: string): string | null {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(s)) return null;
    const bytes = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const text = bytes.toString('utf8');
    // Bytes that are not UTF-8 decode to replacement characters, and so encode back to other bytes: no card.
    return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/** The link a card is shown as (and its QR code carries): `https://<home>/card#<the card, base64url of its JSON>`. */
export function addressCardLink(card: AddressCard): string {
    const json = JSON.stringify({ v: card.v, key: card.key, home: card.home, name: card.name, sig: card.sig });
    return `https://${card.home}${ADDRESS_CARD_PATH}#${base64UrlOf(json)}`;
}

/**
 * The card a scanned or pasted text carries (its link, or the part after `#` alone), its signature verified; null when the
 * text is no card, or a card its key did not sign. A link whose host differs from the card's own home is no card either:
 * whoever made it pointed one home's link at another's card.
 */
export function addressCardFromText(text: unknown): AddressCard | null {
    if (typeof text !== 'string') return null;
    const raw = text.trim();
    if (!raw || raw.length > 6000) return null;
    const hash = raw.indexOf('#');
    const linkHost = hash === -1 ? null : /^https:\/\/([^/?#]+)\/card\/?$/i.exec(raw.slice(0, hash))?.[1]?.toLowerCase();
    if (hash !== -1 && !linkHost) return null;
    const json = textOfBase64Url(hash === -1 ? raw : raw.slice(hash + 1));
    if (!json) return null;
    let card: unknown;
    try { card = JSON.parse(json); } catch { return null; }
    if (!addressCardVerifies(card)) return null;
    const c = card as AddressCard;
    if (linkHost && linkHost !== c.home) return null;
    return { v: 1, key: c.key, home: c.home, name: c.name, sig: c.sig };
}

// ─── A home, short enough for a list's line ─────────────────────────────────────────────────

/**
 * The most of a home a list's line shows ({@link homeTail}). Measured on Android API 26 at 320 dp with text at 1.3× (the
 * Chats row's community line, 178 dp wide): an everyday 48 (letters, hyphens, dots) takes 3 lines; one of only wide letters
 * (w, m) takes a 4th, which wraps, since the line has no limit to cut it at.
 */
export const HOME_LINE_MAX = 48;

/**
 * A home as a list's line shows it: whole when it fits `max` characters; else cut at its head, in this code and not by the
 * platform (Android draws no head ellipsis past a line limit: it would cut the tail and mark nothing). The cut drops whole
 * labels from the front only, marked "…", so the end, which names the real domain, always shows, and nothing after the "…"
 * is half a label (`evil-mybank.example` never shows as `…mybank.example`). The last three labels always stay, however
 * long (a domain under a two-label suffix, `riverside.co.uk`): a home of three labels or fewer is never cut, and wraps.
 */
export function homeTail(home: string, max: number = HOME_LINE_MAX): string {
    if (home.length <= max) return home;
    const labels = home.split('.');
    let kept = labels.slice(-3).join('.');
    for (let i = labels.length - 4; i >= 0; i--) {
        const more = `${labels[i]}.${kept}`;
        if (more.length + 1 > max) break;
        kept = more;
    }
    return kept.length < home.length ? `…${kept}` : home;
}

// ─── A line across communities ──────────────────────────────────────────────────────────────

/** The longest words one line carries, in characters (a direct line's own limit keeps the sealed payload under the relay's). */
export const OUTSIDE_LINE_TEXT_MAX = 8000;

/** Thrown when a line across communities does not open as its envelope's. */
export class OutsideLineNotVerifiedError extends Error {
    constructor(message = "This message couldn't be verified.") {
        super(message);
        this.name = 'OutsideLineNotVerifiedError';
    }
}

/** A line across communities that opened as its envelope's. */
export interface OpenedOutsideLine {
    messageId: string;
    conversationId: string;
    text: string;
    /** The name its sender gave inside the seal, shown "not confirmed here"; null when it carried none we show. */
    name: string | null;
    replyToId: string | null;
}

/**
 * The payload of a `dm-line` item from me to `peerKey`: the words and my name sealed and signed as a format-4 line under the
 * conversation of our two keys and `messageId` (the item's id). Throws for words past {@link OUTSIDE_LINE_TEXT_MAX}.
 */
export function sealOutsideLine(input: {
    text: string; name: string; myEdPrivHex: string; myKey: string; peerKey: string; messageId: string; replyToId?: string | null;
}): string {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > OUTSIDE_LINE_TEXT_MAX) {
        throw new Error(`A line carries 1 to ${OUTSIDE_LINE_TEXT_MAX} characters.`);
    }
    if (!UUID_V4.test(input.messageId)) throw new Error('A line across communities is sealed under its own lower-case UUID v4.');
    const conversationId = relayConversationId(input.myKey, input.peerKey);
    const inner = JSON.stringify({ v: 1, t: input.text, name: addressCardName(input.name) ?? '' });
    const sealed: DmPayload = sealDmLine(inner, { myEdPrivHex: input.myEdPrivHex, peerEdPubHex: input.peerKey, conversationId }, {
        senderPubHex: input.myKey, messageId: input.messageId, replyToId: input.replyToId ?? null,
    });
    return JSON.stringify({ v: 1, c: sealed.ciphertext, n: sealed.nonce, ...(input.replyToId ? { r: input.replyToId } : {}) });
}

/**
 * Open the payload of a `dm-line` item `envelope` carries to me: it must be addressed to my key, its line sealed under the
 * conversation of the two keys and the envelope's item id, signed by the envelope's sender. Throws
 * OutsideLineNotVerifiedError otherwise; nothing of it is shown then.
 */
export function openOutsideLine(payload: string, envelope: RelayEnvelope, me: { key: string; edPrivHex: string }): OpenedOutsideLine {
    if (envelope.kind !== 'dm-line' || envelope.recipient !== me.key || envelope.senderKey === me.key) throw new OutsideLineNotVerifiedError();
    if (!UUID_V4.test(envelope.itemId)) throw new OutsideLineNotVerifiedError();
    let p: { v?: unknown; c?: unknown; n?: unknown; r?: unknown };
    try { p = JSON.parse(payload); } catch { throw new OutsideLineNotVerifiedError(); }
    if (!p || p.v !== 1 || typeof p.c !== 'string' || typeof p.n !== 'string') throw new OutsideLineNotVerifiedError();
    if (p.r !== undefined && (typeof p.r !== 'string' || !p.r || p.r.length > 64)) throw new OutsideLineNotVerifiedError();
    const conversationId = relayConversationId(envelope.senderKey, me.key);
    let words: string;
    try {
        words = openDmLine({ ciphertext: p.c, nonce: p.n }, { myEdPrivHex: me.edPrivHex, peerEdPubHex: envelope.senderKey }, {
            conversationId, senderPubHex: envelope.senderKey, messageId: envelope.itemId, metadata: p.r ? { replyToId: p.r } : undefined,
        }).text;
    } catch {
        throw new OutsideLineNotVerifiedError();
    }
    let inner: { v?: unknown; t?: unknown; name?: unknown; k?: unknown };
    try { inner = JSON.parse(words); } catch { throw new OutsideLineNotVerifiedError(); }
    // A change's sealed words (an edit's carry `t` too) never open as a line: they name their kind (X6).
    if (!inner || inner.v !== 1 || inner.k !== undefined || typeof inner.t !== 'string' || !inner.t || inner.t.length > OUTSIDE_LINE_TEXT_MAX) {
        throw new OutsideLineNotVerifiedError();
    }
    return { messageId: envelope.itemId, conversationId, text: inner.t, name: addressCardName(inner.name), replyToId: typeof p.r === 'string' ? p.r : null };
}

// ─── A change to a line: an edit, a reaction, a delete for everyone (slice X6) ──────────────

/**
 * The kinds that change a line already written, each an item of its own through the mailbox, sealed and signed as a line is
 * (format 4, under the conversation of the two keys, its message id the change's own item id). What it seals is
 * `{"v":1,"k":<kind>,"line":<the line's id>}` and, for an edit, `"t":<the new words>`; for a reaction, `"e":<an emoji of
 * {@link OUTSIDE_REACTIONS}, or "" to take it back>`. Neither server reads which line, which words, or which emoji.
 */
export const OUTSIDE_CHANGE_KINDS = ['dm-edit', 'dm-reaction', 'dm-delete'] as const;
export type OutsideChangeKind = (typeof OUTSIDE_CHANGE_KINDS)[number];
/** The reactions a line across communities takes: the chats' own (the phone's utils/chat-actions.ts, the web's MessagesPage). */
export const OUTSIDE_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '😁'] as const;

export function isOutsideChangeKind(kind: unknown): kind is OutsideChangeKind {
    return typeof kind === 'string' && (OUTSIDE_CHANGE_KINDS as readonly string[]).includes(kind);
}

/** A change, opened (or made here): who made it, when by their clock, and to which line. */
export interface OutsideChange {
    kind: OutsideChangeKind;
    /** The change's own item id. */
    itemId: string;
    lineId: string;
    /** Its maker's key: the envelope's sender. */
    author: string;
    /** When its maker signed it (the envelope's time): the newest edit, and each person's newest reaction, wins. */
    at: number;
    /** An edit's words. */
    text?: string;
    /** A reaction's emoji; '' takes it back. */
    emoji?: string;
}

/** The payload of a change item from me to `peerKey`. Throws, sealing nothing, for a change that is not one. */
export function sealOutsideChange(input: {
    kind: OutsideChangeKind; lineId: string; text?: string; emoji?: string; myEdPrivHex: string; myKey: string; peerKey: string; itemId: string;
}): string {
    const inner = changeInnerProblem({ v: 1, k: input.kind, line: input.lineId, t: input.text, e: input.emoji });
    if (typeof inner === 'string' || !UUID_V4.test(input.itemId)) throw new Error(`Not a change to a line: ${typeof inner === 'string' ? inner : 'its id'}.`);
    const conversationId = relayConversationId(input.myKey, input.peerKey);
    const sealed = sealDmLine(JSON.stringify(inner), { myEdPrivHex: input.myEdPrivHex, peerEdPubHex: input.peerKey, conversationId }, {
        senderPubHex: input.myKey, messageId: input.itemId,
    });
    return JSON.stringify({ v: 1, c: sealed.ciphertext, n: sealed.nonce });
}

/** A change's sealed words in their one form, or why not. */
function changeInnerProblem(o: { v?: unknown; k?: unknown; line?: unknown; t?: unknown; e?: unknown }): string | { v: 1; k: OutsideChangeKind; line: string; t?: string; e?: string } {
    if (!o || o.v !== 1 || !isOutsideChangeKind(o.k)) return 'its kind';
    if (typeof o.line !== 'string' || !UUID_V4.test(o.line)) return 'the line it changes';
    if (o.k === 'dm-edit') {
        if (typeof o.t !== 'string' || !o.t.trim() || o.t.length > OUTSIDE_LINE_TEXT_MAX || o.e !== undefined) return 'an edit carries 1 to 8000 characters';
        return { v: 1, k: o.k, line: o.line, t: o.t };
    }
    if (o.k === 'dm-reaction') {
        if (typeof o.e !== 'string' || (o.e !== '' && !(OUTSIDE_REACTIONS as readonly string[]).includes(o.e)) || o.t !== undefined) return 'a reaction is one of the chat\'s, or none';
        return { v: 1, k: o.k, line: o.line, e: o.e };
    }
    return o.t === undefined && o.e === undefined ? { v: 1, k: o.k, line: o.line } : 'a delete carries nothing more';
}

/**
 * Open a change item `envelope` carries to me: addressed to my key, sealed under the conversation of the two keys and the
 * envelope's item id, signed by the envelope's sender, and of the envelope's own kind (an edit never opens as a reaction).
 * Throws OutsideLineNotVerifiedError otherwise.
 */
export function openOutsideChange(payload: string, envelope: RelayEnvelope, me: { key: string; edPrivHex: string }): OutsideChange {
    if (!isOutsideChangeKind(envelope.kind) || envelope.recipient !== me.key || envelope.senderKey === me.key || !UUID_V4.test(envelope.itemId)) {
        throw new OutsideLineNotVerifiedError();
    }
    let p: { v?: unknown; c?: unknown; n?: unknown; r?: unknown };
    try { p = JSON.parse(payload); } catch { throw new OutsideLineNotVerifiedError(); }
    if (!p || p.v !== 1 || typeof p.c !== 'string' || typeof p.n !== 'string' || p.r !== undefined) throw new OutsideLineNotVerifiedError();
    let inner: ReturnType<typeof changeInnerProblem>;
    try {
        const words = openDmLine({ ciphertext: p.c, nonce: p.n }, { myEdPrivHex: me.edPrivHex, peerEdPubHex: envelope.senderKey }, {
            conversationId: relayConversationId(envelope.senderKey, me.key), senderPubHex: envelope.senderKey, messageId: envelope.itemId,
        }).text;
        inner = changeInnerProblem(JSON.parse(words));
    } catch {
        throw new OutsideLineNotVerifiedError();
    }
    if (typeof inner === 'string' || inner.k !== envelope.kind) throw new OutsideLineNotVerifiedError();
    return {
        kind: inner.k, itemId: envelope.itemId, lineId: inner.line, author: envelope.senderKey, at: envelope.at,
        ...(inner.t !== undefined ? { text: inner.t } : {}), ...(inner.e !== undefined ? { emoji: inner.e } : {}),
    };
}

/** Whether change `a` is newer than `b` (same line, same maker, same kind): the later time, then the larger id. */
export function outsideChangeIsNewer(a: Pick<OutsideChange, 'at' | 'itemId'>, b: Pick<OutsideChange, 'at' | 'itemId'>): boolean {
    return a.at > b.at || (a.at === b.at && a.itemId > b.itemId);
}

/**
 * Where a change a device keeps stands: theirs, applied (null); mine, not yet answered by my server (`sending`, kept with its
 * signed item to send again), taken by my server (`queued`), or at their community (`sent`, as far as anything tells: a change
 * has no receipt).
 */
export type OutsideChangeState = 'sending' | 'queued' | 'sent' | null;
export type KeptOutsideChange = OutsideChange & { state: OutsideChangeState };

/**
 * What an answer about a change of mine means, whether my server's to a send or a tick from its outbox: still on its way, at
 * their community, or never going. `expired` is a change sent and never receipted, which every change is: it reached them.
 * Null: no answer at all (the item unknown, or not yet answered).
 */
export function outsideChangeOutcome(state: unknown): 'queued' | 'sent' | 'failed' | null {
    if (state === 'queued') return 'queued';
    if (state === 'sent' || state === 'delivered' || state === 'expired') return 'sent';
    return state === 'failed' ? 'failed' : null;
}

/**
 * Which of one person's changes of one kind to one line a device keeps, both apps (the phone's outside_changes, the web's
 * changes document), after every write: the newest settled one (theirs, applied; or mine, at their community), and each of mine
 * still on its way that is newer than it. A change of mine that fails is taken out, never kept, so the line falls back to the
 * newest one left: the last that reached them, or an earlier one of mine still on its way; never the failed one, and never the
 * line's first words while a change reached them.
 */
export function outsideChangesKept<T extends Pick<KeptOutsideChange, 'at' | 'itemId' | 'state'>>(rows: readonly T[]): T[] {
    let settled: T | null = null;
    for (const r of rows) if ((r.state === null || r.state === 'sent') && (!settled || outsideChangeIsNewer(r, settled))) settled = r;
    return rows.filter((r) => r === settled || ((r.state === 'sending' || r.state === 'queued') && (!settled || outsideChangeIsNewer(r, settled))));
}

export type OutsideChangeVerdict = 'apply' | 'refuse' | 'drop';

/**
 * What a device makes of a change that opened, as one pure rule both apps take: dropped past the gate (blocked, no open
 * chat: a change never arrives from a request), or for a line already deleted for everyone; refused when it names a line in
 * another chat, or edits or deletes a line its maker did not write; else applied. A change for a line this device doesn't
 * have yet (the change came first) is kept: {@link outsideLineShown} applies it only to a line of its own chat and, for an
 * edit or a delete, of its own maker.
 */
export function outsideChangeVerdict(input: {
    change: Pick<OutsideChange, 'kind' | 'author'>;
    gate: OutsideGateVerdict;
    chatId: string;
    /** The line it names, wherever it is on this device; null when it is not here. */
    line: { chatId: string; author: string; deleted: boolean } | null;
}): OutsideChangeVerdict {
    if (input.gate !== 'change') return 'drop';
    const { line, change } = input;
    if (!line) return 'apply';
    if (line.chatId !== input.chatId) return 'refuse';
    if (line.deleted) return 'drop';
    if (change.kind !== 'dm-reaction' && line.author !== change.author) return 'refuse';
    return 'apply';
}

/** A line as the chat shows it, its changes applied. */
export interface OutsideLineShown {
    text: string;
    edited: boolean;
    deleted: boolean;
    /** Each emoji someone's newest reaction is, in the chat's order: how many, and whether one of them is mine. */
    reactions: Array<{ emoji: string; count: number; mine: boolean }>;
}

/**
 * `line` with the changes of its chat applied: deleted by its writer, it reads as deleted, nothing more shown; else its
 * writer's newest edit, and each person's newest reaction (none when that one took it back). A change by anyone else, or
 * to another line, changes nothing.
 */
export function outsideLineShown(line: { id: string; author: string; text: string }, changes: readonly OutsideChange[], me: string): OutsideLineShown {
    const mine = changes.filter((c) => c.lineId === line.id);
    if (mine.some((c) => c.kind === 'dm-delete' && c.author === line.author)) return { text: '', edited: false, deleted: true, reactions: [] };
    let edit: OutsideChange | null = null;
    const newest = new Map<string, OutsideChange>();
    for (const c of mine) {
        if (c.kind === 'dm-edit' && c.author === line.author && typeof c.text === 'string' && (!edit || outsideChangeIsNewer(c, edit))) edit = c;
        const was = newest.get(c.author);
        if (c.kind === 'dm-reaction' && (!was || outsideChangeIsNewer(c, was))) newest.set(c.author, c);
    }
    const reactions = OUTSIDE_REACTIONS.map((emoji) => {
        const by = [...newest.values()].filter((c) => c.emoji === emoji);
        return { emoji: emoji as string, count: by.length, mine: by.some((c) => c.author === me) };
    }).filter((r) => r.count > 0);
    return { text: edit?.text ?? line.text, edited: !!edit, deleted: false, reactions };
}

/**
 * A line in one string, from {@link outsideLineShown}: the words it shows, or that it was deleted. What each app's Chats list
 * shows of the newest line, and a screen reader says of a bubble, so neither ever shows words the chat no longer does.
 */
export function outsideLineWords(line: { id: string; author: string; text: string }, changes: readonly OutsideChange[], me: string): string {
    const shown = outsideLineShown(line, changes, me);
    return shown.deleted ? t('This message was deleted') : shown.text;
}

/**
 * The words a report of their line hands over (the phone's reportOutsideLine): the words it showed, its writer's newest edit
 * applied, from {@link outsideLineShown}. A delete that lands while the report is being made changes nothing: the words are the
 * ones the member last saw.
 */
export function outsideLineReportedWords(line: { id: string; author: string; text: string }, changes: readonly OutsideChange[], me: string): string {
    return outsideLineShown(line, changes.filter((c) => c.kind !== 'dm-delete'), me).text;
}

/** A receipt's payload, as the mailbox reads one (`{"v":1,"items":[ids]}`): "my device has these". */
export function outsideReceiptPayload(itemIds: readonly string[]): string {
    return JSON.stringify({ v: 1, items: [...new Set(itemIds)] });
}

// ─── The request gate (both apps) ───────────────────────────────────────────────────────────

/** A chat's standing on a device: a request waiting for the member, open (either side may write), or declined. */
export type OutsideChatState = 'request' | 'open' | 'declined';

/** What the gate makes of an item arriving from someone in another community: a line, a request, a change to a line, or nothing. */
export type OutsideGateVerdict = 'line' | 'request' | 'change' | 'drop';

/**
 * The request gate, as one pure rule (design §3.5; the phone's utils/outside-mail.ts, through outside-chat-store.ts
 * gateIncoming, and the web's lib/outside-mail.ts both take it from here): what becomes of an item of `kind` from a sender, given the chat this
 * device has with them (null: none), whether that chat already holds a line of theirs, the member's door, and their blocks.
 * A block always wins; an open chat takes lines and changes to lines (an edit, a reaction, a delete: X6); a stranger gets
 * one line of words, only through an open door, and nothing at all once declined.
 */
export function gateOutsideItem(input: {
    kind: string;
    chat: { state: OutsideChatState; theirLines: number } | null;
    doorOpen: boolean;
    blocked: boolean;
}): OutsideGateVerdict {
    if (input.blocked) return 'drop';
    const { chat } = input;
    if (chat?.state === 'open') return input.kind === 'dm-line' ? 'line' : isOutsideChangeKind(input.kind) ? 'change' : 'drop';
    // From here, a stranger: words only, one line only, and only through an open door.
    if (input.kind !== 'dm-line') return 'drop';
    if (chat?.state === 'declined') return 'drop';
    if (chat?.state === 'request') return chat.theirLines === 0 ? 'request' : 'drop';
    return input.doorOpen ? 'request' : 'drop';
}
