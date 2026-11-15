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
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { openDmLine, sealDmLine, type DmPayload } from './dm-crypto.js';
import { isNodeHost, signatureBytesOf } from './node-request-signing.js';
import { relayConversationId, type RelayEnvelope } from './relay-envelope.js';
import { toBase64, utf8Bytes, type Signer } from './request-signing.js';

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
    let inner: { v?: unknown; t?: unknown; name?: unknown };
    try { inner = JSON.parse(words); } catch { throw new OutsideLineNotVerifiedError(); }
    if (!inner || inner.v !== 1 || typeof inner.t !== 'string' || !inner.t || inner.t.length > OUTSIDE_LINE_TEXT_MAX) {
        throw new OutsideLineNotVerifiedError();
    }
    return { messageId: envelope.itemId, conversationId, text: inner.t, name: addressCardName(inner.name), replyToId: typeof p.r === 'string' ? p.r : null };
}

/** A receipt's payload, as the mailbox reads one (`{"v":1,"items":[ids]}`): "my device has these". */
export function outsideReceiptPayload(itemIds: readonly string[]): string {
    return JSON.stringify({ v: 1, items: [...new Set(itemIds)] });
}

// ─── The request gate (both apps) ───────────────────────────────────────────────────────────

/** A chat's standing on a device: a request waiting for the member, open (either side may write), or declined. */
export type OutsideChatState = 'request' | 'open' | 'declined';

/** What the gate makes of an item arriving from someone in another community. */
export type OutsideGateVerdict = 'line' | 'request' | 'drop';

/**
 * The request gate, as one pure rule (design §3.5; the phone's utils/outside-mail.ts, through outside-chat-store.ts
 * gateIncoming, and the web's lib/outside-mail.ts both take it from here): what becomes of an item of `kind` from a sender, given the chat this
 * device has with them (null: none), whether that chat already holds a line of theirs, the member's door, and their blocks.
 * A block always wins; an open chat takes lines only; a stranger gets one line of words, only through an open door, and
 * nothing at all once declined.
 */
export function gateOutsideItem(input: {
    kind: string;
    chat: { state: OutsideChatState; theirLines: number } | null;
    doorOpen: boolean;
    blocked: boolean;
}): OutsideGateVerdict {
    if (input.blocked) return 'drop';
    const { chat } = input;
    if (chat?.state === 'open') return input.kind === 'dm-line' ? 'line' : 'drop';
    // From here, a stranger: words only, one line only, and only through an open door.
    if (input.kind !== 'dm-line') return 'drop';
    if (chat?.state === 'declined') return 'drop';
    if (chat?.state === 'request') return chat.theirLines === 0 ? 'request' : 'drop';
    return input.doorOpen ? 'request' : 'drop';
}
