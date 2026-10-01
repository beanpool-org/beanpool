/**
 * What a push from a community carries, and how its signature is checked (scratch/global-node/DESIGN-push-relay-fable.md
 * §4.1, §4.3, §6; Marty's D2 and D3, 2026-10-01). One definition for the server that signs and the apps that check.
 *
 * A push passes through Expo, Apple and Google, and a lock screen anyone can read. So it says nothing private:
 *
 *   - **Fixed words.** The title is always {@link PUSH_NOTICE_TITLE}; the text is the sentence its kind has in
 *     {@link PUSH_NOTICE_KINDS}. No sender's name, no listing title, no amount, no group name, no announcement text.
 *   - **No ids that mean anything.** `data` is {@link PushNoticeData}: the kind, a notice id that is 128 random bits and
 *     new for each recipient, the time, which community (8 bytes of the hash of its push key), and the signature. No post
 *     id, conversation id, member key or community name.
 *
 * The real text (who wrote, which listing, how many beans, what the operator announced) stays on the member's own server.
 * The app asks for it with a signed request, `GET /api/notices/push/<id>`, which answers the recipient only, for
 * {@link PUSH_NOTICE_LIFETIME_SECONDS}.
 *
 * ## The signature
 *
 * The community's server signs each notice with its node key (Ed25519, the key behind its PeerId), over
 *
 *   0xFF ‖ utf8( "beanpool-push/v1\n" c "\n" k "\n" i "\n" t "\n" RECIPIENT )
 *
 * where RECIPIENT is the member's public key as the app signs its requests with it. The recipient is signed but not sent,
 * so a notice copied to another member's phone fails there. The leading 0xFF, as in request signing (request-signing.ts),
 * starts no UTF-8 text, so nothing else the node key signs (all of it text or JSON) can be read as a notice.
 *
 * The app learns the key from the answer to its own push registration (`POST /api/push-tokens` → `{ success, pushKey }`),
 * a signed request over TLS to the address the member chose, and keeps it with that community. A take-over keeps the node
 * key, so the pin survives one.
 *
 * What a signature can and cannot do (design §2.2): the phone's system shows a notice that has words before any app code
 * runs, so a forger holding a phone's push token can always put words on its lock screen. The check makes a forged
 * notice do nothing: the app follows a tap only for a notice its own community signed for this member, and says so
 * otherwise. A notice with no signature (a server with no node key yet) is treated as not signed.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** The title of every push a community sends. */
export const PUSH_NOTICE_TITLE = 'BeanPool';

/** Where the app goes for a notice whose details it can't fetch: the tab its kind belongs to. */
export type PushNoticeTab = 'home' | 'market' | 'chats' | 'settings';

/**
 * Every kind of push a community sends, with the one sentence its lock screen shows. A server never sends free text in a
 * push: the sender names a kind, and the words come from here.
 */
export const PUSH_NOTICE_KINDS = {
    'chat.message': { body: 'You have a new message.', tab: 'chats' },
    'chat.group': { body: 'New message in one of your groups.', tab: 'chats' },
    'chat.mention': { body: 'You were mentioned in a group.', tab: 'chats' },
    'group.lead': { body: 'There is news about a group you lead.', tab: 'chats' },
    'market.request': { body: 'Someone answered one of your listings.', tab: 'market' },
    'market.answer': { body: 'There is news on one of your requests.', tab: 'market' },
    'trade.update': { body: 'There is news on one of your trades.', tab: 'market' },
    'review.new': { body: 'You have a new review.', tab: 'market' },
    'event.reminder': { body: "An event you're going to starts soon.", tab: 'market' },
    'event.update': { body: "There is news about an event you're going to.", tab: 'market' },
    'community.notice': { body: 'Your community has a notice for you.', tab: 'home' },
    'community.near': { body: 'A community has started near you.', tab: 'home' },
    'account.recovery-started': { body: "Someone is trying to recover your account. If this isn't you, open BeanPool and stop it.", tab: 'settings' },
    'account.restored': { body: "Your account was just restored on another device. If that wasn't you, open BeanPool now.", tab: 'settings' },
    'owner.standby': { body: "Your community's standby server needs you.", tab: 'settings' },
} as const satisfies Record<string, { body: string; tab: PushNoticeTab }>;

export type PushNoticeKind = keyof typeof PUSH_NOTICE_KINDS;

export function isPushNoticeKind(value: unknown): value is PushNoticeKind {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PUSH_NOTICE_KINDS, value);
}

/** The words a push of this kind shows: the fixed title and its kind's sentence. */
export function pushNoticeWords(kind: PushNoticeKind): { title: string; body: string } {
    return { title: PUSH_NOTICE_TITLE, body: PUSH_NOTICE_KINDS[kind].body };
}

/** The tag line of a notice's signed bytes. A new format is a new tag. */
export const PUSH_NOTICE_TAG = 'beanpool-push/v1';
/** `data.bp`: the notice format. */
export const PUSH_NOTICE_VERSION = 1;
/** The first byte of a notice's signed bytes. No UTF-8 text starts with it. */
export const PUSH_NOTICE_MARKER = 0xff;

/**
 * How long a notice counts: the server answers `GET /api/notices/push/<id>` for this long and then forgets the id, and an
 * app treats an older notice as stale.
 */
export const PUSH_NOTICE_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
/** How far ahead of the phone's clock a notice's time may be and still count. */
export const PUSH_NOTICE_CLOCK_SKEW_SECONDS = 5 * 60;

/** A notice id: 128 random bits, lower-case hex. */
export const PUSH_NOTICE_ID_PATTERN = /^[0-9a-f]{32}$/;
/** `data.c`: the first 8 bytes of SHA-256 of the push key, lower-case hex. */
export const PUSH_COMMUNITY_TAG_PATTERN = /^[0-9a-f]{16}$/;
/** A push key (`pushKey`): a raw 32-byte Ed25519 public key, lower-case hex. */
export const PUSH_KEY_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;

export function isPushNoticeId(value: unknown): value is string {
    return typeof value === 'string' && PUSH_NOTICE_ID_PATTERN.test(value);
}

/** Everything a push's `data` carries. */
export interface PushNoticeData {
    bp: typeof PUSH_NOTICE_VERSION;
    /** The kind (PUSH_NOTICE_KINDS). */
    k: PushNoticeKind;
    /** The notice id, new for each recipient. */
    i: string;
    /** When it was sent, in whole seconds since 1970. */
    t: number;
    /** Which community: pushCommunityTag of its push key. */
    c: string;
    /** The node key's Ed25519 signature over pushNoticeBytes, lower-case hex. */
    s: string;
}

/** The fields a signature covers, beside the recipient. */
export type PushNoticeFields = Pick<PushNoticeData, 'c' | 'k' | 'i' | 't'>;

/** `data.c` for a community whose push key is `pushKey` (hex). */
export function pushCommunityTag(pushKey: string): string {
    return bytesToHex(sha256(hexToBytes(pushKey)).subarray(0, 8));
}

/** The bytes a notice's signature is made over (see the header). */
export function pushNoticeBytes(fields: PushNoticeFields, recipient: string): Uint8Array {
    const text = utf8ToBytes(`${PUSH_NOTICE_TAG}\n${fields.c}\n${fields.k}\n${fields.i}\n${fields.t}\n${recipient}`);
    const bytes = new Uint8Array(text.length + 1);
    bytes[0] = PUSH_NOTICE_MARKER;
    bytes.set(text, 1);
    return bytes;
}

export type PushNoticeRefusal =
    /** Not a BeanPool notice of this format at all (an old server's push, or anything else). */
    | 'not-a-notice'
    /** A kind this app doesn't know. */
    | 'unknown-kind'
    /** Signed for another community, or by a key this app doesn't hold for it. */
    | 'other-community'
    /** The signature doesn't verify: forged, changed on the way, or for another member. */
    | 'bad-signature'
    /** Older than PUSH_NOTICE_LIFETIME_SECONDS. */
    | 'too-old'
    /** Further ahead of the phone's clock than PUSH_NOTICE_CLOCK_SKEW_SECONDS. */
    | 'from-the-future';

export type PushNoticeCheck =
    | { ok: true; kind: PushNoticeKind; id: string; sentAt: number }
    | { ok: false; reason: PushNoticeRefusal };

/**
 * Checks a push's `data` the way an app does before it acts on one: a notice of this format, signed by `pushKey` (the key
 * this community's server gave the app at registration) for `recipient` (this app's own public key), and recent.
 * `now` is in whole seconds. Never throws.
 */
export function verifyPushNotice(
    data: unknown,
    opts: { recipient: string; pushKey: string; now?: number },
): PushNoticeCheck {
    const d = data as Partial<Record<keyof PushNoticeData, unknown>> | null;
    if (!d || typeof d !== 'object' || d.bp !== PUSH_NOTICE_VERSION) return { ok: false, reason: 'not-a-notice' };
    if (!isPushNoticeId(d.i) || typeof d.t !== 'number' || !Number.isSafeInteger(d.t) || d.t <= 0
        || typeof d.c !== 'string' || !PUSH_COMMUNITY_TAG_PATTERN.test(d.c)
        || typeof d.s !== 'string' || !SIGNATURE_PATTERN.test(d.s) || typeof d.k !== 'string') {
        return { ok: false, reason: 'not-a-notice' };
    }
    if (!isPushNoticeKind(d.k)) return { ok: false, reason: 'unknown-kind' };
    if (typeof opts.pushKey !== 'string' || !PUSH_KEY_PATTERN.test(opts.pushKey) || d.c !== pushCommunityTag(opts.pushKey)) {
        return { ok: false, reason: 'other-community' };
    }
    let valid: boolean;
    try {
        valid = ed25519.verify(hexToBytes(d.s), pushNoticeBytes({ c: d.c, k: d.k, i: d.i, t: d.t }, opts.recipient), hexToBytes(opts.pushKey));
    } catch {
        valid = false;
    }
    if (!valid) return { ok: false, reason: 'bad-signature' };
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    if (now - d.t > PUSH_NOTICE_LIFETIME_SECONDS) return { ok: false, reason: 'too-old' };
    if (d.t - now > PUSH_NOTICE_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'from-the-future' };
    return { ok: true, kind: d.k, id: d.i, sentAt: d.t };
}
