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
 *
 * ## Server rule: formats above 1
 *
 * A server sends a notice format above 1 (`bp` above {@link PUSH_NOTICE_VERSION}) only to a phone whose push registration
 * declared that it reads that format. An app treats any `bp` it doesn't know as unsigned (it can't rebuild the bytes, and
 * an exemption from the warning would be one every forger takes by writing `bp: 2`), so a phone that did not declare the
 * format must never be sent it. The app in the field declares nothing: it always gets format 1, and its warning never
 * fires on a genuine notice.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { t, word, type Words } from './words.js';

/** The title of every push a community sends: the app's name, the same in every language. */
export const PUSH_NOTICE_TITLE = 'BeanPool';

/**
 * Whether Settings shows the "Requests to join" switch (`notify_knocks`) to this member: only where it changes
 * something. Owners and admins are always told (the server's engine/knocks.ts notifyKnockReceived); a Known community
 * (door `admins`) never tells its other members, since only owners and admins answer there; a community that takes no
 * requests (`knocks` off) has none to tell. `features`: the community's, as it said them; `role`: GET
 * /api/node-admin/me's, null for none, undefined while not known (the switch waits for it). Both apps use this.
 */
export function knockSwitchShown(features: { door?: unknown; knocks?: unknown } | null | undefined, role: unknown): boolean {
    if (role === undefined || role === 'owner' || role === 'admin') return false;
    return features?.knocks !== false && features?.door !== 'admins';
}

/**
 * Whether a community sends `market.asked` (DESIGN-cold-start-trades-fable.md §2.1, slice N3): a local community with
 * Beans on, never the global one, which gets the Asked near you card and not the buzz. The server's own rule, which it
 * says to the apps as `features.askedPush` ({@link askedPushOn}).
 */
export function askedPushSent(profile: unknown, beans: unknown): boolean {
    return profile === 'local' && beans === true;
}

/**
 * Whether the community a member is in tells them when a neighbour asks for something they starred: only where its
 * features say `askedPush` (a server from before slice N3 says nothing, sends no such push and takes no `notify_asked`).
 * Both apps read it: the What are you into? card says so only here ({@link ASKED_PUSH_WORDS}.interestsNote), and Settings →
 * Notifications shows its switch only here.
 */
export function askedPushOn(features: object | null | undefined): boolean {
    return (features as { askedPush?: unknown } | null | undefined)?.askedPush === true;
}

/** The words both apps show for the `market.asked` push (design §2.1): the card's sentence and the Settings switch. */
export const ASKED_PUSH_WORDS = {
    /** What are you into?'s note where the community sends the push. */
    interestsNote: word("Tap a few. What you star comes first here and in the Market, and we'll tell you when a neighbour asks for it."),
    /** Settings → Notifications: the switch's name (and its label for a screen reader). */
    switchName: word("When a neighbour asks for something I'm into"),
    /** …and its line. */
    switchLine: word("At most once a day, and only for what you've starred"),
} as const;

/** Where the app goes for a notice whose details it can't fetch: the tab its kind belongs to. */
export type PushNoticeTab = 'home' | 'market' | 'chats' | 'settings' | 'people';

/**
 * Every kind of push a community sends, with the one sentence its lock screen shows. A server never sends free text in a
 * push: the sender names a kind, and the words come from here, in the language of the phone it goes to
 * ({@link pushNoticeWords}).
 */
export const PUSH_NOTICE_KINDS = {
    'chat.message': { body: word('You have a new message.'), tab: 'chats' },
    'chat.group': { body: word('New message in one of your groups.'), tab: 'chats' },
    'chat.mention': { body: word('You were mentioned in a group.'), tab: 'chats' },
    'group.lead': { body: word('There is news about a group you lead.'), tab: 'chats' },
    // To the member invited, and no one else (state-engine.ts inviteGroupMember). Home, whose Needs-you line opens the
    // invitation: they are not in the group's chat yet.
    'group.invite': { body: word('You were invited to join a group.'), tab: 'home' },
    // Home, whose Needs-you line opens the enterprise: Talk shows nothing of a keepers' vote.
    'decision.open': { body: word('A vote opened in one of your groups.'), tab: 'home' },
    // To everyone who may vote when the community's vote on removing a member opens (server decisions-engine.ts
    // noticeRemovalVoteOpened, removal by vote, Amendment A). It names nobody; its details open Commons, Decide.
    'decision.removal': { body: word('Your community opened a vote on removing a member.'), tab: 'home' },
    // To the member that vote is about, at once (Amendment A point 2): its details open the vote, where they can reply.
    'account.removal-vote': { body: word('Your community opened a vote about your account. Open BeanPool to read it and reply.'), tab: 'home' },
    // To that member when an admin takes down their reply (server decisions-engine.ts adminHideReply): its details open the
    // vote, where the admin's reason stands in the reply's place.
    'account.reply-taken-down': { body: word('An admin took down your reply on a vote about your account. Open BeanPool to read why.'), tab: 'home' },
    // A removal jury (server decisions-engine.ts, DESIGN-removal-jury-fable.md §4, §7; slice J2b). Each names nobody, not
    // even the community, and its details open Commons, Decide. To each member seated on one, at the draw or in a seat
    // that came free: they answer within three days (JURY_ANSWER_HOURS), Serve or Step aside, or the seat goes on.
    'decision.jury': { body: word('You were drawn for a jury in your community. Open BeanPool within three days to serve or step aside.'), tab: 'home' },
    // The same to one seated with less than two days of the vote left (JURY_LATE_SEAT_HOURS): told so.
    'decision.jury-late': { body: word('You were drawn for a jury in your community, and its vote closes in less than two days. Open BeanPool to serve or step aside.'), tab: 'home' },
    // To a seated juror with no answer two days after being seated (JURY_REMINDER_HOURS).
    'decision.jury-reminder': { body: word('A jury you were drawn for is waiting for your answer. Answer within a day, or your seat goes to the next member drawn.'), tab: 'home' },
    // To every seated juror who hasn't voted, on the vote's sixth day (JURY_LAST_DAY_AFTER_DAYS).
    'decision.jury-last-day': { body: word("A jury you're on closes in about a day. Open BeanPool to vote."), tab: 'home' },
    // To every seated juror when the member the jury is deciding about answers the case (design §7).
    'decision.jury-reply': { body: word('The member your jury is deciding about has answered the case. Open BeanPool to read it.'), tab: 'home' },
    'market.request': { body: word('Someone answered one of your listings.'), tab: 'market' },
    // To members who starred the category of a neighbour's new Need (server engine/asked-push.ts; cold start N3): at most
    // one a day each, only where the community says `askedPush`. It names nobody and no listing; its details open the Need.
    'market.asked': { body: word("Someone in your community asked for something you're into."), tab: 'market' },
    'market.answer': { body: word('There is news on one of your requests.'), tab: 'market' },
    'market.listing': { body: word('There is news on one of your listings.'), tab: 'market' },
    'trade.update': { body: word('There is news on one of your trades.'), tab: 'market' },
    'review.new': { body: word('You have a new review.'), tab: 'market' },
    'event.reminder': { body: word("An event you're going to starts soon."), tab: 'market' },
    'event.update': { body: word("There is news about an event you're going to."), tab: 'market' },
    'community.notice': { body: word('Your community has a notice for you.'), tab: 'home' },
    'community.near': { body: word('A community has started near you.'), tab: 'home' },
    // To the people a place circle holds, as it forms or takes them in, and when one of them says they're starting one
    // (server engine/place-circles.ts). No place, name or count: Home's Find card opens the circle.
    'community.circle': { body: word('People near you want to start a community.'), tab: 'home' },
    // To a community's owners and admins, and members who asked for it, when someone asks to join (server engine/knocks.ts
    // notifyKnockReceived). People, whose Invites list holds the request. The asker's "answered" notice is no push: their
    // phone posts it from its own background check (apps/native utils/sync-notices.ts), since no community has their token.
    'community.knock': { body: word('Someone asked to join your community.'), tab: 'people' },
    // To the member whose link shared outside a request to join came with (server engine/knocks.ts notifyKnockReceived,
    // shared-listing door A3), instead of the plain one: no name and no listing. Its details open their Shared outside,
    // where that link's row counts who asked. The listing's author is told nothing.
    'community.knock-shared': { body: word('Someone asked to join after a listing you shared.'), tab: 'settings' },
    // To a member whose ask to invite someone was answered (server engine/invite-asks.ts). Never the code, the reason or a name.
    'community.invite-ask': { body: word('An admin answered your ask to invite someone.'), tab: 'people' },
    // Local knowledge's waiting list (server engine/knowledge-drafts.ts, slice K3). Home, where Learn opens: to a community's
    // owners and admins when a member suggests a page (no name and no title here; its details name both), and to the
    // member when one of them answers it (never the answer, the reason or who answered).
    'community.knowledge': { body: word('A member suggested local knowledge for you to check.'), tab: 'home' },
    'community.knowledge-answer': { body: word('Your local knowledge suggestion has an answer.'), tab: 'home' },
    // To the browser that asked to join and tapped "Tell me when they answer" on the waiting page, when a member says yes (server
    // engine/knocks.ts approveKnock; web push W1). A decline sends nothing: it reads as waiting, by design. Home: the waiting
    // page, which reads the request's own status and offers Join.
    'join.answered': { body: word('A community answered your request to join.'), tab: 'home' },
    'account.recovery-started': { body: word("Someone is trying to recover your account. If this isn't you, open BeanPool and stop it."), tab: 'settings' },
    'account.restored': { body: word("Your account was just restored on another device. If that wasn't you, open BeanPool now."), tab: 'settings' },
    // To the old phone when an admin makes a re-key code (server engine/member-wizards.ts issueRekeyCode): the one sign a
    // member gets of an admin moving their account without them.
    'account.rekey-started': { body: word("An admin started moving your account to a new phone. If you still have this phone and didn't ask for this, tell an owner now."), tab: 'settings' },
    // To the member's phones when an admin makes a bring-back code (server engine/bring-back.ts issueBringBackCode): someone
    // is getting the SAME key back on a new phone from the copy the member keeps with their community (vault rethink VR3).
    // Generic: no community, no admin, no code. Its release is told as `account.restored`.
    'account.bring-back-started': { body: word("An admin is bringing your account back on a new phone. If you still have this phone and didn't ask for this, tell an owner now."), tab: 'settings' },
    // The forum (server engine/forum-notices.ts, slice F5; DESIGN-forums-fable.md §9), under the member's Forum switch
    // (`notify_forum`). Chats: the Forum is a switch at the top of the Chat tab. No title, name, section or count here; the
    // bell holds them. A reply in a topic they follow: one push for a topic until they open it, later replies fold into
    // that one bell row. Mentioned or quoted: at most one push an hour from the same person.
    'forum.reply': { body: word('There is a new reply in a topic you follow.'), tab: 'chats' },
    'forum.mention': { body: word('You were mentioned in the forum.'), tab: 'chats' },
    // To the community's moderators when a new member's first topic waits (engine/forum-first-look.ts), and to its writer
    // when a moderator answers it or 30 days pass without a look. Never who answered or why: that is in the bell.
    'forum.first-look': { body: word('A first topic is waiting for a look.'), tab: 'chats' },
    'forum.first-look-answer': { body: word('Your first topic has an answer.'), tab: 'chats' },
    'owner.standby': { body: word("Your community's standby server needs you."), tab: 'settings' },
    'owner.alert': { body: word("Your community's server needs you."), tab: 'settings' },
} as const satisfies Record<string, { body: string; tab: PushNoticeTab }>;

export type PushNoticeKind = keyof typeof PUSH_NOTICE_KINDS;

export function isPushNoticeKind(value: unknown): value is PushNoticeKind {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PUSH_NOTICE_KINDS, value);
}

/**
 * The words a push of this kind shows: the fixed title and its kind's sentence, in `words`' language. A server passes
 * the words of the phone's language (wordsFor, from the language its push registration named); an app leaves it out for
 * its own language, so a push shown while the app is open reads as the one on the lock screen.
 */
export function pushNoticeWords(kind: PushNoticeKind, words: Pick<Words, 't'> = { t }): { title: string; body: string } {
    return { title: PUSH_NOTICE_TITLE, body: words.t(PUSH_NOTICE_KINDS[kind].body) };
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
        valid = ed25519.verify(hexToBytes(d.s), pushNoticeBytes({ c: d.c, k: d.k, i: d.i, t: d.t }, opts.recipient), hexToBytes(opts.pushKey), { zip215: false });
    } catch {
        valid = false;
    }
    if (!valid) return { ok: false, reason: 'bad-signature' };
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    if (now - d.t > PUSH_NOTICE_LIFETIME_SECONDS) return { ok: false, reason: 'too-old' };
    if (d.t - now > PUSH_NOTICE_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'from-the-future' };
    return { ok: true, kind: d.k, id: d.i, sentAt: d.t };
}
