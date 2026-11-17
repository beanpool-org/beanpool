/**
 * A guest's side of a group's chat hosted by another community, kept on the guest's own phone or browser (slice G2:
 * scratch/fable-design/DESIGN-cross-chat-voice-fable.md §4.2; DESIGN-forums-messaging-joint-fable.md §2.1, §2.3, §2.6). One
 * module for both apps: the phone and the web app read the same notices the same way and send the same items.
 *
 * The guest's phone never talks to the host. Their own community's server holds what the host sends for them
 * (`GET /api/mail/group`: notices and where they stand with each group, the server's engine/group-guest-home.ts) and sends
 * what they write (`POST /api/mail/send`, items to `group:<id>` at the host). This file turns the notices into
 * {@link GuestChats} (kept on the device: nobody else keeps a guest's copy of the lines) and makes the items' payloads.
 *
 * **The request gate** ({@link gateGuestNotice}). An invitation waits behind the one "Message requests" row, as a stranger's
 * first line does: no alert, no badge, nothing of the group's but its name, its community and who invited. One from someone
 * this account blocked never shows. Before Accept nothing else of the group's passes (no line, no roster, no key), and after
 * a decline, a leave or a removal nothing does either, until a new invitation is accepted.
 *
 * **Keys.** The guest's yes puts them in the host's roster; the roster that follows says the epoch is stale, and the guest's
 * phone makes the next one itself (core group-guest-steps.ts, `join`), as an invited member's does. Later epochs come as
 * notices with only this guest's wrap. Each opened key is kept by its epoch number; a line under an epoch whose key is not
 * here yet waits ({@link GuestChat.held}) and opens when it comes.
 *
 * **What a guest sees** ({@link guestAccess}): the chat (read and write) and the names in it, nothing else of the group or
 * its community: no section, no post, no poll, no members list beyond the names in the chat. A removed guest's chat closes.
 *
 * Four rules hold for every line and every chat (#3246 round 2):
 *   - **Lines**: a line is named by the key that signed it, never by a server's field. A line whose `author` column names
 *     someone other than its `metadata.sender`, or that doesn't open as its sender's under its epoch's key, is refused:
 *     never shown, never anyone's (the members' rule, line-display design §4). Its name, its label and whether it is mine
 *     all come from that key.
 *   - **Ids**: my line goes under one item id, and my server and the host each count an id once. A line refused
 *     `epoch-stale` is sealed again under a new id and a newer epoch ({@link applyGuestTicks}); a line my server never answered goes again
 *     under the same one (my server answers an id it has with that item's state).
 *   - **State**: what this device shows for an invitation or a chat follows what my server lists now. An invitation it no
 *     longer lists (answered on another device, withdrawn) is gone from here; a chat it no longer lists was left there.
 *     "Now" is the newest page this device applied (G2 follow-ups, TWO TABS): each page says when my server read its list
 *     (`linksAt`, strictly later than any page before), and a page read before the newest one applied here (another tab
 *     or window of this device fetched after it and wrote first) is STALE: it moves nothing at all, neither by its
 *     `groups` nor by its notices or ticks, and confirms nothing ({@link guestPageStale}; applyGuestMail). Everything in
 *     it is either in the newer page or was confirmed by whoever applied it, so nothing is lost; and nothing it says
 *     (an invitation not listed yet, a removal before the invitation that followed it) undoes a newer word.
 *   - **Epochs**: my line is sealed only under an epoch the host has taken: one it sent (a roster, an epoch notice), or my
 *     own once my server says the host took it ({@link GuestOwnEpoch}). While my own is queued or refused, the line waits.
 *
 * Two more since round 3:
 *   - **Writes**: every write to the chats is made from the chats as they are at that write (the change function's `c`)
 *     and a small change worked out before it (an id, a key, a page): never a whole chat read before an await. So a
 *     round's page and a send never undo each other, whichever lands first.
 *   - **Refusals**: an epoch the host refused is written on the chat, and nothing goes again that the same roster would
 *     make again. A line refused `epoch-stale` under epoch N: nothing is sealed under N, or an older one, again
 *     ({@link GuestChat.refusedEpoch}), and no epoch of mine is made that isn't newer than N. My own epoch refused: none is
 *     made again from the roster it was made from ({@link GuestChat.epochWait}). The host sends its roster after each
 *     refusal; until it comes, my lines wait and nothing new goes out (engine/group-guest-home.ts's header: "a phone
 *     that heard `epoch-stale` waits for the roster"). A roster that names the refused epoch as current and not stale
 *     brings the host's own key for it, and lines go under that key again.
 *
 * Two more since round 4:
 *   - **Notices**: every kind of notice the host sends (engine/group-guests.ts GUEST_NOTICE_KINDS) is applied here, or left
 *     unconfirmed so it comes again: none is confirmed without being applied ({@link GUEST_NOTICE_KINDS_APPLIED}). A line
 *     edited or taken down (`edit`) reaches the line wherever this device has it: shown, or waiting for its key
 *     ({@link applyGuestMail}). A notice dropped by the gate is applied as the gate's rule says (nothing passes there).
 *   - **Whys**: every reason the host gives for a removal has its own words ({@link guestClosedWords}): a convenor's Remove,
 *     the group closed by its members, its community's owners turning guests off; never "You were removed" for the other two.
 *
 * One more since round 5:
 *   - **AAD**: everything sealed that this device opens is opened with exactly the associated data its sender sealed it
 *     with: the group, the line's own epoch, the signer, the message id, what the line answers, and the part. A line's words
 *     are part 'body'; an edit's are part 'edit' (core sealGroupLineEdit, which both apps' editSealedGroupLine call), whether
 *     it comes as an `edit` notice or on a copy of the line fetched after it (`editedAt`). The test seals every kind with
 *     its sender's own code (group-guest-aad.test.ts).
 *
 * One more since part 2:
 *   - **Leaving**: my Leave closes the chat here at once ({@link leaveGuestChatHere}: `left`, its keys gone, a line of
 *     mine not yet sent never goes) with my signed `group-leave` kept on it ({@link GuestLeave}), then it goes. Until my
 *     server says the host took it, the round posts it again, and my server still listing me in never opens the chat again.
 *     A refusal that passes (a mute, guests switched off a while) never stops it: only `not_in_group` does (group-guest-mail.ts
 *     leaveRefusal). A removal listed after I left keeps the chat left, in my own words.
 *
 * One more since the emulator walk of 17 Nov (finding a; the members' twin is #3273/#3275, group-guest-names.ts):
 *   - **Names**: a line's author is named by the newest row this device has for that key, in any state
 *     ({@link guestChatAuthorName}). The host's roster names who is in the chat and, in `former`, everyone out of it now
 *     whose lines this chat's guests may have (a member who left, a guest who left or was removed); each roster's names
 *     are kept on the chat ({@link GuestChat.names}), so a name seen once stays on that person's lines after they go,
 *     even once the host names them no more. A fellow guest who came and went between two of my rounds is named by the
 *     roster's `former`. Only `members` and `guests` are keys an epoch wraps to; a kept name is never one.
 */
import {
    openGroupLine, openMyGroupKey, sealGroupLine, type GroupEpochRecord, type GroupServedWrap,
} from './group-crypto.js';
import { guestEpochStep, makeGuestEpoch, openGuestEpochKey, readGuestRoster, type GuestRoster, type GuestRosterWrap } from './group-guest-steps.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
// Imported, never the global: a browser has no Buffer, and neither has Hermes on the phone (WALK 3, 16 Nov: every guest round
// in the web app stopped at "Buffer is not defined" once the roster came, so a guest never read or sent a line).
import { Buffer } from 'buffer';
import { cleanName, clipName, nameLine } from './name-line.js';
import { t, word } from './words.js';

/**
 * Where the guest stands with a group: an invitation waiting (`invited`), their yes still on its way (`joining`), in the
 * chat (`in`), or out (`declined`, `left`, `removed`: their chat is closed).
 */
export type GuestChatState = 'invited' | 'joining' | 'in' | 'declined' | 'left' | 'removed';

/**
 * A line of mine: `waiting` for a key this device can seal under (the words kept, nothing sealed yet), `sending` until my
 * server has it (its signed item kept, sent again at the next round), then my server's word on it: `queued` (the host not
 * reached yet), `sent` (the host took it), `failed` (a day of no answer, or my server refused it: `note` says why).
 */
export type GuestLineState = 'waiting' | 'sending' | 'queued' | 'sent' | 'failed';

export interface GuestLine {
    id: string;
    /** The key that signed the line (mine for my own): never a server's author field (the file's header, "Lines"). */
    author: string;
    text: string;
    /** When it was written (the host's time for theirs, this device's for mine), ms. */
    at: number;
    /** Mine only. */
    state?: GuestLineState;
    /** Mine, `failed`: why. */
    note?: string | null;
    /** Mine, `sending`: the signed item as it was posted, to post again. */
    item?: string | null;
    /** Theirs: the epoch it was sealed under (an edit of it is sealed again under the same one). */
    epoch?: number;
    /** Theirs: `text`, or a photo's or a voice message's type. */
    type?: string;
    /** When the words shown were last edited, as the host said it; null or absent when never. */
    editedAt?: string | null;
}

/** A line that came under an epoch whose key this device doesn't have yet: kept sealed until it does. */
export interface GuestHeldLine {
    id: string;
    author: string;
    sender: string;
    epoch: number;
    ciphertext: string;
    nonce: string;
    replyToId: string | null;
    type: string;
    at: number;
    /** When its words were last edited, as the host said it; null or absent when never. */
    editedAt?: string | null;
    /**
     * Newer words from an edit that came while the key wasn't here, kept beside the line's own: once the key comes the line
     * opens as its sender's first, then shows these if they open as that sender's too (never in place of the line's own,
     * so words that don't open never cost the line).
     */
    edit?: { ciphertext: string; nonce: string; replyToId: string | null; editedAt: string | null } | null;
}

export interface GuestChat {
    /** {@link guestChatId} of the host and the group. */
    id: string;
    /** The group's host (its server's home). */
    host: string;
    /** The group's id at its host. */
    group: string;
    /** The group's name, as the host last said it. */
    name: string;
    /** Who invited, as the host said it. */
    invitedBy: { key: string; name: string } | null;
    state: GuestChatState;
    /** The host's latest roster for this guest (the names in the chat and the current epoch), or null before one came. */
    roster: GuestRoster | null;
    /**
     * Epoch keys the host has, base64, by epoch number: opened from its roster or an epoch notice, or my own once the host
     * took it. A line is sealed only under one of these.
     */
    keys: Record<string, string>;
    /** The epoch number this device last made a `group-epoch` for that wasn't refused, so a round doesn't make a second for it. */
    epochSent: number | null;
    /** My own epoch on its way, until my server says what the host did with it; absent or null when none is. */
    ownEpoch?: GuestOwnEpoch | null;
    /**
     * The newest epoch the host refused a line of mine under (`epoch-stale`), or null. Nothing is sealed under it or an
     * older one again, and no epoch of mine is made that isn't newer (the file's header, "Refusals"), until a roster names
     * it as current and not stale with my wrap: the key then opened is the host's own for it, and this is cleared.
     */
    refusedEpoch?: number | null;
    /** {@link guestRosterMark} of the roster my last refused epoch was made from: none is made again while the roster is that one. */
    epochWait?: string | null;
    lines: GuestLine[];
    held: GuestHeldLine[];
    /** Why the chat closed, when the host said (its `why`, read by {@link guestClosedWhyOf}); null when this device never heard one. */
    why: GuestClosedWhy | null;
    /** The notice that brought this invitation: the same one fetched again (its confirm lost) never opens it again. */
    inviteId?: string;
    /** My leave on its way ({@link GuestLeave}), while the chat is `left` here and the host hasn't taken it yet; absent or null when none is. */
    leave?: GuestLeave | null;
    /**
     * The newest name this device has for each key a roster named, in the chat or out of it ({@link GuestNameKept}; the
     * file's header, "Names"); absent or null before a roster came.
     */
    names?: Record<string, GuestNameKept> | null;
    updatedAt: number;
}

/**
 * A name a roster gave a key, as this device keeps it: the name, the guest's community (null for a member of the group),
 * where they stand (`in`; `out` for a member no longer in, or no longer named at all; a guest out says the host's word:
 * `left`, `removed`, `invited`), and when this device last saw it change.
 */
export interface GuestNameKept { name: string; home: string | null; state: string; at: number }

/** Names one chat keeps; past it, the ones that changed longest ago go. */
export const GUEST_CHAT_NAMES_KEPT = 200;

/**
 * My leave (`group-leave`), from the moment I leave until my server says the host took it, or lists me no more (the file's
 * header, "Leaving"): `sending` (posted with no answer yet, its signed item kept and posted again under the same id; `item`
 * null when a new one is due under `itemId`: the last one failed, or my server refused the item itself), `queued` (my
 * server has it, the host not reached yet), or `refused` (my server answered `not_in_group`: I'm not asked or in there, or
 * a leave of mine from another device already waits there; nothing more goes from here unless that other one fails). Any
 * other refusal passes, and it goes again (group-guest-mail.ts leaveRefusal). While it is kept, my server listing me in
 * never opens the chat again, and a removal listed never turns my leave into one.
 */
export interface GuestLeave { itemId: string; item: string | null; state: 'sending' | 'queued' | 'refused' }

/**
 * An epoch made on this device, on its way to the host. Its key seals nothing until the host takes it: `sending` (posted,
 * no answer yet: its signed item kept, posted again under the same id), then `queued` (my server has it, the host not
 * reached yet). The host took it (`sent`): the key joins {@link GuestChat.keys}. Refused or failed: it goes, and the next
 * round may make another.
 */
export interface GuestOwnEpoch {
    epoch: number; key: string; itemId: string; state: 'sending' | 'queued'; item: string | null;
    /** {@link guestRosterMark} of the roster it was made from. */
    from: string;
}

/** Every guest chat this account has on this device, by id. */
export type GuestChats = Record<string, GuestChat>;

/** A notice as the guest's server serves it (engine/group-guest-home.ts HeldGroupNotice). */
export interface GuestNotice { id: string; host: string; group: string; kind: string; data: unknown; receivedAt: number }

/** Where the guest's server says they stand with a group (engine/group-guest-home.ts GroupLinkView). */
export interface GuestLink { host: string; group: string; state: string; roster: unknown; rosterAt: number | null }

/** What became of one of my items (engine/group-guest-home.ts GroupSentTick). */
export interface GuestSentTick { itemId: string; kind: string; host: string; group: string; state: string; refused: string | null; at: number }

/** The lines one chat keeps on the device; the oldest go past it. */
export const GUEST_LINES_KEPT = 500;
/** Lines held for a key that hasn't come; the oldest go past it. */
export const GUEST_HELD_KEPT = 200;
/** One line's words at most (the host's own form check allows far more; a chat line is short). */
export const GUEST_LINE_TEXT_MAX = 8000;

const KEY_HEX = /^[0-9a-f]{64}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A chat's id on the device: the group's id at its host, then the host (both are plain in a route). */
export function guestChatId(host: string, group: string): string {
    return `${group}@${host}`;
}

// ── The request gate ────────────────────────────────────────────────────────────────────────

/**
 * Every kind of notice the host sends (engine/group-guests.ts GUEST_NOTICE_KINDS) that this device applies. A notice of a
 * kind not here is left unconfirmed, never confirmed unapplied (the file's header, "Notices"); the guard test reads the
 * host's list and fails on a kind missing here.
 */
export const GUEST_NOTICE_KINDS_APPLIED = ['invite', 'roster', 'line', 'edit', 'epoch', 'removed'] as const;
/** The changes of a line an `edit` notice says that this device applies: new words, or the line taken down. Any other waits. */
export const GUEST_EDIT_ACTIONS_APPLIED = ['edited', 'removed'] as const;

/** What the gate does with a notice: show an invitation, take it into the chat, drop it, or leave it unconfirmed (`wait`: a kind or a change this device can't apply). */
export type GuestGateVerdict = 'invite' | 'take' | 'drop' | 'wait';

/**
 * The gate for one notice (the file's header). `blocked`: whether this account blocked a key. An invitation from someone
 * blocked is dropped; one for a group the guest is already joining or in is a repeat. A removal reaches an invitation
 * (withdrawn), a yes on its way or an in-guest. A line taken down reaches every chat that may show it (joining, in, or
 * closed since: it only takes away); new words reach a chat joining or in, as a line does. Anything else passes only once
 * they are joining or in. A kind this device doesn't apply, or an edit's change it doesn't, waits.
 */
export function gateGuestNotice(chat: Pick<GuestChat, 'state'> | null | undefined, kind: string, data: unknown, blocked: (key: string) => boolean): GuestGateVerdict {
    if (typeof kind !== 'string') return 'drop';
    if (!(GUEST_NOTICE_KINDS_APPLIED as readonly string[]).includes(kind)) return 'wait';
    if (kind === 'edit') {
        const action = isObject(data) ? data.action : undefined;
        if (typeof action !== 'string') return 'drop';
        if (!(GUEST_EDIT_ACTIONS_APPLIED as readonly string[]).includes(action)) return 'wait';
        if (!chat) return 'drop';
        if (action === 'removed') return chat.state === 'joining' || chat.state === 'in' || chat.state === 'left' || chat.state === 'removed' ? 'take' : 'drop';
        return chat.state === 'joining' || chat.state === 'in' ? 'take' : 'drop';
    }
    if (kind === 'invite') {
        const by = isObject(data) && isObject(data.invitedBy) ? data.invitedBy : null;
        if (!by || typeof by.key !== 'string' || !KEY_HEX.test(by.key) || blocked(by.key)) return 'drop';
        if (typeof (data as Record<string, unknown>).name !== 'string') return 'drop';
        return chat && (chat.state === 'joining' || chat.state === 'in') ? 'drop' : 'invite';
    }
    if (!chat) return 'drop';
    if (kind === 'removed') return chat.state === 'invited' || chat.state === 'joining' || chat.state === 'in' ? 'take' : 'drop';
    if (kind === 'roster' || kind === 'epoch' || kind === 'line') return chat.state === 'joining' || chat.state === 'in' ? 'take' : 'drop';
    return 'drop';
}

// ── What a guest sees ───────────────────────────────────────────────────────────────────────

/**
 * Who is looking, from the host's side or the guest's: a convenor or member of the group (at the host), a guest in its chat,
 * a guest removed (or who left, or whose group closed), or someone blocked (an invitation from someone they blocked, or a host
 * their community's owners blocked: nothing reaches them).
 */
export type GuestViewer = 'convenor' | 'member' | 'guest' | 'removed' | 'blocked';
/** What they might see: the chat, the group's sections (posts, polls, Decisions), the names in the chat, Report, Add a guest. */
export type GuestScreen = 'chat' | 'sections' | 'roster' | 'report' | 'invite';
/** Shown; hidden (not drawn, nothing to say); refused (asked for, and answered with why not). */
export type GuestAccess = 'shown' | 'hidden' | 'refused';

const ACCESS: Record<GuestViewer, Record<GuestScreen, GuestAccess>> = {
    convenor: { chat: 'shown', sections: 'shown', roster: 'shown', report: 'shown', invite: 'shown' },
    member: { chat: 'shown', sections: 'shown', roster: 'shown', report: 'shown', invite: 'hidden' },
    // A guest gets the chat and the names in it, nothing else of the group (design §4.2). Report: a guest's phone never talks
    // to the host, and a path through their home is not built (#3233 "Not here").
    guest: { chat: 'shown', sections: 'hidden', roster: 'shown', report: 'hidden', invite: 'hidden' },
    removed: { chat: 'refused', sections: 'hidden', roster: 'hidden', report: 'hidden', invite: 'hidden' },
    blocked: { chat: 'refused', sections: 'hidden', roster: 'hidden', report: 'hidden', invite: 'refused' },
};

/** What `viewer` sees of `screen` (the table above; both apps draw from it). */
export function guestAccess(viewer: GuestViewer, screen: GuestScreen): GuestAccess {
    return ACCESS[viewer][screen];
}

/** Whether a guest chat is listed among the chats: joining, in, or closed (removed, left); an invitation waits behind Message requests, a decline is gone. */
export function guestChatListed(chat: Pick<GuestChat, 'state'>): boolean {
    return chat.state === 'joining' || chat.state === 'in' || chat.state === 'left' || chat.state === 'removed';
}

/** The viewer a guest chat's own state makes of me: a guest while joining or in, removed once out; an invitation is no chat yet (null). */
export function guestViewerOf(chat: Pick<GuestChat, 'state'>): GuestViewer | null {
    if (chat.state === 'invited') return null;
    return chat.state === 'in' || chat.state === 'joining' ? 'guest' : 'removed';
}

// ── Reading the server's page ───────────────────────────────────────────────────────────────

/**
 * How far behind the newest page applied a page may be and still be a stale one from another tab (the file's header,
 * "State"): two tabs' fetches are a round apart at most (each app ends a round at 30 s). A page further behind than this
 * is from my server after its clock went back (a restart after a clock correction): it is read, and the newest page
 * applied is that one from then on, so the device never stops reading its server.
 */
export const GUEST_PAGE_STALE_MS = 10 * 60_000;

/**
 * Whether a page whose list my server read at `linksAt` is STALE on this device (the file's header, "State": TWO TABS):
 * read before the newest page this device applied (`seen`), by no more than GUEST_PAGE_STALE_MS. A page with no `linksAt`
 * (a server from before it), or with none applied yet, never is.
 */
export function guestPageStale(linksAt: unknown, seen: number | null | undefined): boolean {
    if (typeof linksAt !== 'number' || !Number.isSafeInteger(linksAt) || typeof seen !== 'number' || !Number.isSafeInteger(seen)) return false;
    return linksAt < seen && seen - linksAt <= GUEST_PAGE_STALE_MS;
}

export interface GuestMailContext {
    /** My key. */
    me: string;
    /**
     * The `linksAt` of the newest page this device applied for this account (the file's header, "State": TWO TABS), or
     * null/absent when it has applied none with one.
     */
    linksSeen?: number | null;
    /** My private key, hex: opens my wraps. */
    myEdPrivHex: string;
    /** Whether this account blocked a key. */
    blocked: (key: string) => boolean;
    now: number;
}

function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}
function unb64(s: string): Uint8Array {
    return new Uint8Array(Buffer.from(s, 'base64'));
}

function newChat(host: string, group: string, now: number): GuestChat {
    return {
        id: guestChatId(host, group), host, group, name: '', invitedBy: null, state: 'invited', roster: null, keys: {}, epochSent: null,
        ownEpoch: null, refusedEpoch: null, epochWait: null, lines: [], held: [], why: null, updatedAt: now,
    };
}

/** Opens a key from an epoch's record and my wrap in it, or null when it doesn't verify or open. */
function openKey(group: string, record: unknown, wraps: unknown, me: string, myEdPrivHex: string): { epoch: number; key: string } | null {
    if (!isObject(record) || !Number.isSafeInteger(record.epoch) || !Array.isArray(wraps)) return null;
    const mine = wraps.find((w): w is GuestRosterWrap => isObject(w) && w.recipient === me);
    if (!mine) return null;
    try {
        const epoch = record.epoch as number;
        const served: GroupServedWrap = { epoch, wrapper: mine.wrapper, ephPub: mine.ephPub, nonce: mine.nonce, wrapped: mine.wrapped, sig: null };
        return { epoch, key: b64(openMyGroupKey({ ...(record as unknown as GroupEpochRecord), groupId: group }, served, myEdPrivHex, { groupId: group, epoch })) };
    } catch {
        return null;
    }
}

/**
 * A held line opened with the key of its epoch (the file's header, "Lines"): the line, named by the key that signed it, or
 * `refused` when it doesn't open as its sender's, or null while its epoch's key isn't here. Opened with exactly what its
 * sender sealed it with (the file's header, "AAD"): its words as part 'body' (a photo's or a voice message's words too), or,
 * when the copy carries an edit (`editedAt`: the host's copyOfLine, my home's replaceHeldWords), the edit's words as part
 * 'edit', as members open an edited line (group-line-display, `line.editedAt ? 'edit' : 'body'`).
 */
function openHeld(chat: GuestChat, h: GuestHeldLine): GuestLine | 'refused' | null {
    // A server's author field naming someone other than the signer: refused, whoever's key opens it.
    if (h.sender !== h.author) return 'refused';
    const key = chat.keys[String(h.epoch)];
    if (!key) return null;
    try {
        const opened = openGroupLine({ ciphertext: h.ciphertext, nonce: h.nonce }, {
            groupId: chat.group, epoch: h.epoch, senderPubHex: h.sender, messageId: h.id, part: h.editedAt ? 'edit' : 'body', replyToId: h.replyToId,
        }, unb64(key));
        const line: GuestLine = {
            id: h.id, author: h.sender, text: h.type === 'text' ? opened.text : t(GUEST_CHAT_WORDS.photoNotHere), at: h.at, epoch: h.epoch, type: h.type,
            editedAt: h.editedAt ?? null,
        };
        if (h.edit) openEditOnto(line, h.edit, chat.group, h.epoch, key);
        return line;
    } catch {
        return 'refused';
    }
}

/**
 * An edit's words put on a line opened here, when they open as the line's author's edit under its epoch's key (part 'edit',
 * as every member's app seals an edit: core sealGroupLineEdit); else the line keeps its own.
 */
function openEditOnto(line: GuestLine, edit: NonNullable<GuestHeldLine['edit']>, group: string, epoch: number, key: string): void {
    try {
        const opened = openGroupLine({ ciphertext: edit.ciphertext, nonce: edit.nonce }, {
            groupId: group, epoch, senderPubHex: line.author, messageId: line.id, part: 'edit', replyToId: edit.replyToId,
        }, unb64(key));
        line.text = (line.type ?? 'text') === 'text' ? opened.text : t(GUEST_CHAT_WORDS.photoNotHere);
        line.editedAt = edit.editedAt;
    } catch {
        /* not the line's author's words: the line keeps the words it had */
    }
}

/** A line notice as held, or null when it isn't one. */
function heldOf(data: unknown): GuestHeldLine | null {
    if (!isObject(data) || typeof data.id !== 'string' || typeof data.author !== 'string' || !KEY_HEX.test(data.author)) return null;
    if (typeof data.ciphertext !== 'string' || typeof data.nonce !== 'string') return null;
    const meta = isObject(data.metadata) ? data.metadata : {};
    const epoch = meta.epoch;
    if (!Number.isSafeInteger(epoch) || (epoch as number) < 1) return null;
    // The signer the line names; with none named, its author column (and it must open as theirs). Anything named that
    // isn't a key is kept as named, so it never opens (openHeld refuses it).
    const sender = meta.sender === undefined || meta.sender === null ? data.author : String(meta.sender);
    const at = Date.parse(String(data.timestamp ?? ''));
    return {
        id: data.id, author: data.author, sender, epoch: epoch as number, ciphertext: data.ciphertext, nonce: data.nonce,
        replyToId: typeof meta.replyToId === 'string' ? meta.replyToId : null, type: typeof data.type === 'string' ? data.type : 'text',
        at: Number.isFinite(at) ? at : 0, editedAt: typeof data.editedAt === 'string' ? data.editedAt : null,
    };
}

/** Whether an edit's time is newer than the words here: any is when they were never edited; one with no time never beats one with. */
function newerWords(edit: string | null, here: string | null | undefined): boolean {
    if (!here) return true;
    const a = Date.parse(edit ?? '');
    const b = Date.parse(here);
    return Number.isFinite(a) && (!Number.isFinite(b) || a > b);
}

/**
 * A line changed at the host (an `edit` notice: its author's edit or delete, or a convenor's takedown; engine/group-guests.ts
 * queueLineChange), applied to whatever this device has of it (the file's header, "Notices"):
 *   - taken down (`action: 'removed'`): the line goes, shown or waiting for its key, its words and its photo or voice with it;
 *   - edited (`action: 'edited'`): words newer than the ones here, sealed again by the line's own author under the line's own
 *     epoch, take their place on a line shown; on one waiting for its key they are kept beside its own words and shown once
 *     the key comes (GuestHeldLine.edit). Words no newer than the ones here (an older edit served after the line already
 *     carried a newer one), or that don't open as the line's author's, change nothing;
 *   - a line this device hasn't got: nothing to change. My server applies a change to every copy it holds for me before
 *     it holds the notice (engine/group-guest-home.ts applyToHeldCopies), so a copy fetched later already carries it.
 */
function applyLineChange(chat: GuestChat, data: unknown): void {
    if (!isObject(data) || typeof data.id !== 'string') return;
    const id = data.id;
    if (data.action === 'removed') {
        chat.lines = chat.lines.filter((l) => l.id !== id);
        chat.held = chat.held.filter((h) => h.id !== id);
        return;
    }
    if (data.action !== 'edited' || typeof data.ciphertext !== 'string' || typeof data.nonce !== 'string' || typeof data.author !== 'string') return;
    const meta = isObject(data.metadata) ? data.metadata : {};
    const epoch = meta.epoch;
    if (!Number.isSafeInteger(epoch)) return;
    const sender = meta.sender === undefined || meta.sender === null ? data.author : String(meta.sender);
    const editedAt = typeof data.editedAt === 'string' ? data.editedAt : null;
    const replyToId = typeof meta.replyToId === 'string' ? meta.replyToId : null;
    const held = chat.held.find((h) => h.id === id);
    const edit = { ciphertext: data.ciphertext, nonce: data.nonce, replyToId, editedAt };
    if (held) {
        // Kept beside the line's own words until its key comes (GuestHeldLine.edit): checked then, as a shown line's is now.
        if (held.author !== data.author || held.sender !== sender || held.epoch !== epoch || !newerWords(editedAt, held.edit?.editedAt ?? held.editedAt)) return;
        held.edit = edit;
        return;
    }
    const line = chat.lines.find((l) => l.id === id);
    if (!line || line.author !== data.author || sender !== line.author || !newerWords(editedAt, line.editedAt)) return;
    if ((line.epoch ?? sealedEpochOf(line)) !== epoch) return;
    const key = chat.keys[String(epoch)];
    if (key) openEditOnto(line, edit, chat.group, epoch as number, key);
}

/** Every held line that opens now goes into the chat; the rest stay held (the newest GUEST_HELD_KEPT). */
function openWhatCan(chat: GuestChat): void {
    const still: GuestHeldLine[] = [];
    for (const h of chat.held) {
        const line = openHeld(chat, h);
        if (line === 'refused') continue;
        if (!line) { still.push(h); continue; }
        if (!chat.lines.some((l) => l.id === line.id)) chat.lines.push(line);
    }
    chat.held = still.slice(-GUEST_HELD_KEPT);
    chat.lines.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (chat.lines.length > GUEST_LINES_KEPT) chat.lines = chat.lines.slice(-GUEST_LINES_KEPT);
}

/**
 * The names a roster gives, kept on the chat (the file's header, "Names"): each key it names, in the chat (members and
 * guests) or out of it (`former`), takes the newest row; a key kept as in that it no longer names at all is out. A row's
 * time moves only when it changed, so the same roster again keeps nothing new; past GUEST_CHAT_NAMES_KEPT, the rows that
 * changed longest ago go.
 */
function keepNames(chat: GuestChat, roster: GuestRoster, now: number): void {
    const kept: Record<string, GuestNameKept> = {};
    for (const [key, k] of Object.entries(chat.names ?? {})) {
        if (KEY_HEX.test(key) && isObject(k) && typeof k.name === 'string' && typeof k.state === 'string' && Number.isFinite(k.at)) kept[key] = k;
    }
    const named = new Set<string>();
    const put = (key: string, name: string, home: string | null, state: string) => {
        named.add(key);
        const was = kept[key];
        if (!was || was.name !== name || (was.home ?? null) !== home || was.state !== state) kept[key] = { name, home, state, at: now };
    };
    for (const m of roster.members) put(m.key, m.name, null, 'in');
    for (const g of roster.guests) put(g.key, g.name, g.home, 'in');
    for (const m of roster.former?.members ?? []) if (!named.has(m.key)) put(m.key, m.name, null, 'out');
    for (const g of roster.former?.guests ?? []) if (!named.has(g.key)) put(g.key, g.name, g.home, g.state);
    for (const [key, k] of Object.entries(kept)) if (!named.has(key) && k.state === 'in') kept[key] = { ...k, state: 'out', at: now };
    // Past the cap, a name this roster gives is never the one that goes.
    const order = ([a, x]: [string, GuestNameKept], [b, y]: [string, GuestNameKept]) => Number(named.has(b)) - Number(named.has(a)) || y.at - x.at || (a < b ? -1 : 1);
    chat.names = Object.fromEntries(Object.entries(kept).sort(order).slice(0, GUEST_CHAT_NAMES_KEPT));
}

/** Takes a roster: kept, its names kept (keepNames), and the current epoch's key opened from my wrap when it is not stale. */
function takeRoster(chat: GuestChat, roster: GuestRoster, ctx: GuestMailContext): void {
    chat.roster = roster;
    keepNames(chat, roster, ctx.now);
    if (roster.name) chat.name = roster.name;
    const step = guestEpochStep(roster, ctx.me);
    if (step.send === 'group-line') {
        try {
            chat.keys[String(step.epoch)] = b64(openGuestEpochKey(step, chat.group, ctx.myEdPrivHex));
            // The epoch a line of mine was refused under, named current and not stale: the key just opened is the host's
            // own for it (it replaces any of mine by that number), so lines go under it again (the file's header, "Refusals").
            if (chat.refusedEpoch === step.epoch) chat.refusedEpoch = null;
        } catch { /* not opened: the line waits */ }
    }
}

/**
 * The server's page applied to the chats on this device: the gate first, then each notice taken, then where the server
 * says I stand with each group. Returns the chats (a new object; the old is untouched) and the notice ids to confirm:
 * every one applied, taken or dropped by the gate's rule; never one the gate left waiting (a kind, or an edit's change,
 * this device can't apply: it comes again; the file's header, "Notices"). The caller confirms only after the chats are
 * written. A STALE page (read before the newest page applied here, `ctx.linksSeen`: the file's header, "State") changes
 * nothing and confirms nothing (`stale`), and its ticks are not to be applied either.
 */
export function applyGuestMail(before: GuestChats, page: { items?: unknown; groups?: unknown; linksAt?: unknown }, ctx: GuestMailContext): { chats: GuestChats; confirm: string[]; changed: boolean; stale: boolean } {
    const chats: GuestChats = structuredCloneChats(before);
    const confirm: string[] = [];
    let changed = false;
    if (guestPageStale(page.linksAt, ctx.linksSeen)) return { chats, confirm, changed, stale: true };
    const items = Array.isArray(page.items) ? page.items as GuestNotice[] : [];
    for (const n of items) {
        if (!isObject(n) || typeof n.id !== 'string') continue;
        // No group named: nothing it could ever change here.
        if (typeof n.host !== 'string' || typeof n.group !== 'string') { confirm.push(n.id); continue; }
        const id = guestChatId(n.host, n.group);
        const chat = chats[id];
        // An invitation fetched again because its confirm was lost is the one already answered here, never a new one.
        if (n.kind === 'invite' && chat?.inviteId === n.id) { confirm.push(n.id); continue; }
        const verdict = gateGuestNotice(chat, n.kind, n.data, ctx.blocked);
        if (verdict === 'wait') continue;
        confirm.push(n.id);
        if (verdict === 'drop') continue;
        changed = true;
        if (verdict === 'invite') {
            const data = n.data as { name: string; invitedBy: { key: string; name: unknown } };
            const fresh = newChat(n.host, n.group, ctx.now);
            // A new invitation after a leave or a removal starts a new chat: nothing of the old one carries over.
            chats[id] = {
                ...fresh, name: data.name.slice(0, 120), inviteId: n.id,
                invitedBy: { key: data.invitedBy.key, name: typeof data.invitedBy.name === 'string' ? data.invitedBy.name.slice(0, 60) : '' },
            };
            continue;
        }
        const c = chat!;
        c.updatedAt = ctx.now;
        if (n.kind === 'removed') {
            // Each reason the host gives keeps its own words (guestClosedWhyOf; the file's header, "Whys").
            const why = guestClosedWhyOf(isObject(n.data) ? n.data.why : undefined);
            if (c.state === 'invited') { delete chats[id]; continue; }
            c.state = 'removed';
            c.why = why;
            c.keys = {};
            c.held = [];
            c.ownEpoch = null;
            continue;
        }
        if (n.kind === 'roster') {
            const roster = readGuestRoster(n.data);
            if (roster) takeRoster(c, roster, ctx);
        } else if (n.kind === 'epoch') {
            const d = isObject(n.data) ? n.data : {};
            const opened = openKey(c.group, d.record, d.wraps, ctx.me, ctx.myEdPrivHex);
            if (opened) c.keys[String(opened.epoch)] = opened.key;
        } else if (n.kind === 'line') {
            const h = heldOf(n.data);
            if (h && !c.lines.some((l) => l.id === h.id) && !c.held.some((x) => x.id === h.id)) c.held.push(h);
        } else if (n.kind === 'edit') {
            applyLineChange(c, n.data);
        }
        openWhatCan(c);
    }
    changed = applyGuestLinks(chats, page.groups, ctx) || changed;
    return { chats, confirm, changed, stale: false };
}

/**
 * Where the server says I stand with each group it lists (invited, joining, in, removed) moves my chats there: the server
 * is the authority on that, the device only remembers. A group it lists that this device has no chat for (a new device, an
 * invitation confirmed on another) gets one, from its roster; an invitation it lists with no notice here waits as one.
 * The server lists every link it has but a declined or left one, on every page: an invitation (or a yes on its way) it
 * doesn't list was answered on another device or withdrawn, and goes from here; a chat I was in that it doesn't list I
 * left on another device, and it closes (the file's header, "State").
 */
function applyGuestLinks(chats: GuestChats, groups: unknown, ctx: GuestMailContext): boolean {
    if (!Array.isArray(groups)) return false;
    let changed = false;
    const listed = new Set<string>();
    for (const l of groups as GuestLink[]) {
        if (!isObject(l) || typeof l.host !== 'string' || typeof l.group !== 'string') continue;
        const id = guestChatId(l.host, l.group);
        const state = l.state;
        if (state !== 'invited' && state !== 'joining' && state !== 'in' && state !== 'removed') continue;
        listed.add(id);
        let chat = chats[id];
        if (!chat) {
            // A removal for a chat this device never had: nothing to show.
            if (state === 'removed') continue;
            // An invitation listed with no notice here is answered on the device that has the notice; there is no name to show.
            if (state === 'invited') continue;
            chat = chats[id] = newChat(l.host, l.group, ctx.now);
            changed = true;
        }
        // My leave on its way (GuestChat.leave): my server lists me as before until the host takes it, and the chat stays
        // left here (the file's header, "Leaving"). A removal listed, then or at any round after, ends the leave (nothing more
        // of mine goes to that group) and the chat stays left in my own words: I chose to leave.
        if (chat.state === 'left' && (chat.leave || state === 'removed')) {
            if (state === 'removed' && chat.leave) { chat.leave = null; changed = true; }
            continue;
        }
        // My no (or leave) stands while my server still lists the invitation: the host hasn't taken it yet, and it never
        // comes back as one. A new invitation comes as its own notice.
        if ((chat.state === 'declined' || chat.state === 'left') && (state === 'invited' || state === 'joining')) continue;
        // Removed from a chat this device knew only as an invitation (accepted on another): nothing of it to show here.
        if (chat.state === 'invited' && state === 'removed') { delete chats[id]; changed = true; continue; }
        if (chat.state !== state && !(chat.state === 'joining' && state === 'invited' && chat.updatedAt > ctx.now - 60_000)) {
            // `joining` here and `invited` there: my yes not taken yet. Kept a minute (the send in flight), then the server's word.
            // Removed with no notice heard here (my server may not have held one for me): why stays unknown, never guessed.
            if (state === 'removed') { chat.keys = {}; chat.held = []; chat.ownEpoch = null; chat.why = chat.why ?? null; }
            chat.state = state;
            chat.updatedAt = ctx.now;
            changed = true;
        }
        const roster = state === 'in' || state === 'joining' ? readGuestRoster(l.roster) : null;
        if (roster && JSON.stringify(roster) !== JSON.stringify(chat.roster)) {
            takeRoster(chat, roster, ctx);
            openWhatCan(chat);
            changed = true;
        }
    }
    for (const [id, chat] of Object.entries(chats)) {
        if (listed.has(id)) continue;
        if (chat.state === 'invited' || chat.state === 'joining') {
            delete chats[id];
            changed = true;
        } else if (chat.state === 'in') {
            Object.assign(chat, { state: 'left', keys: {}, held: [], ownEpoch: null, updatedAt: ctx.now });
            changed = true;
        } else if (chat.state === 'left' && chat.leave) {
            // No longer listed: the host took my leave.
            chat.leave = null;
            changed = true;
        }
    }
    return changed;
}

/**
 * What became of my items (the file's header, "Ids" and "Epochs"). My own epoch: the host took it (`sent`), so its key
 * joins the keys lines are sealed under; my server has it (`queued`), so it still waits; refused or failed, it goes and
 * another may be made. A tick for an epoch of mine that isn't the one on its way now is old news and changes nothing.
 * Each line's state moves on; a line refused for its epoch waits again under a NEW id from `newId` (my server and the
 * host each count the old one as used), to be sealed under a newer epoch than the one refused, which is written down
 * ({@link GuestChat.refusedEpoch}; the file's header, "Refusals").
 */
export function applyGuestTicks(before: GuestChats, ticks: unknown, now: number, newId: () => string): { chats: GuestChats; changed: boolean } {
    const chats = structuredCloneChats(before);
    let changed = false;
    if (!Array.isArray(ticks)) return { chats, changed };
    for (const tk of ticks as GuestSentTick[]) {
        if (!isObject(tk) || typeof tk.host !== 'string' || typeof tk.group !== 'string') continue;
        const chat = chats[guestChatId(tk.host, tk.group)];
        if (!chat) continue;
        if (tk.kind === 'group-epoch') {
            changed = applyOwnEpochTick(chat, tk, now) || changed;
            continue;
        }
        if (tk.kind === 'group-leave') {
            changed = applyLeaveTick(chat, tk, now, newId) || changed;
            continue;
        }
        if (tk.kind !== 'group-line') continue;
        const line = chat.lines.find((l) => l.id === tk.itemId && l.state);
        if (!line) continue;
        // Refused for its epoch in a chat that is closed since (I left, or was removed): it never goes again, so it never waits.
        const open = chat.state === 'in' || chat.state === 'joining';
        const next: GuestLineState | null = tk.refused === 'epoch-stale' && open ? 'waiting'
            : tk.refused || tk.state === 'refused' ? 'failed'
            : tk.state === 'queued' ? 'queued' : tk.state === 'sent' ? 'sent' : tk.state === 'failed' ? 'failed' : null;
        if (!next || next === line.state) continue;
        if (next === 'waiting') {
            // Refused for its epoch: that epoch is written down, so nothing is sealed under it again (the line waits for
            // the roster the host sends after a refusal); the next epoch may be made (unless mine is on its way), whether
            // or not a tick for my last one ever came; the line goes again under a new id.
            // Only the epoch the refused item itself names: a line with no item kept (one gone `failed`) names none, and the
            // key here now is never marked refused for it.
            const under = sealedEpochOf(line);
            if (under !== null && under > (chat.refusedEpoch ?? 0)) chat.refusedEpoch = under;
            if (!chat.ownEpoch) chat.epochSent = null;
            line.id = newId();
        }
        line.state = next;
        line.item = next === 'waiting' ? null : line.item;
        line.note = next === 'failed' ? (tk.refused ? t(GUEST_CHAT_WORDS.refused) : t(GUEST_CHAT_WORDS.notReached)) : null;
        chat.updatedAt = now;
        changed = true;
    }
    return { chats, changed };
}

/** One tick for an epoch of mine, applied to the chat (applyGuestTicks); whether it changed anything. */
function applyOwnEpochTick(chat: GuestChat, tk: GuestSentTick, now: number): boolean {
    const own = chat.ownEpoch ?? null;
    if (own && own.itemId !== tk.itemId) return false;
    if (tk.refused || tk.state === 'refused' || tk.state === 'failed') {
        if (!own && chat.epochSent === null) return false;
        // Refused: none is made again from the roster this one was made from (the host sends a new one after a refusal).
        // Failed (my server never reached the host): another may be made at once.
        const refused = !!tk.refused || tk.state === 'refused';
        const wait = refused ? (own?.from ?? guestRosterMark(chat.roster)) : (chat.epochWait ?? null);
        Object.assign(chat, { ownEpoch: null, epochSent: null, epochWait: wait, updatedAt: now });
        return true;
    }
    if (!own) return false;
    if (tk.state === 'sent') {
        chat.keys = { ...chat.keys, [String(own.epoch)]: own.key };
        Object.assign(chat, { ownEpoch: null, updatedAt: now });
        openWhatCan(chat);
        return true;
    }
    if (tk.state === 'queued' && own.state !== 'queued') {
        chat.ownEpoch = { ...own, state: 'queued', item: null };
        return true;
    }
    return false;
}

/**
 * One tick for my leave (applyGuestTicks); whether it changed anything. The host took it (`sent`), or refused it (I'm not
 * asked or in there): nothing more to send. My server has it (`queued`): it waits there. It failed (a day with no answer
 * from the host): a new one is due under a new id (my server and the host each count an id once). A tick for another
 * leave of mine is old news, but one: mine kept `refused` (a leave of mine from another device waited at my server) and
 * that other one failed or was refused, so mine is due again under a new id (no other waits now; were I out of the group,
 * my server's list would have ended it). Its taking needs nothing here: my server lists me no more.
 */
function applyLeaveTick(chat: GuestChat, tk: GuestSentTick, now: number, newId: () => string): boolean {
    const leave = chat.leave ?? null;
    if (!leave || chat.state !== 'left') return false;
    if (leave.itemId !== tk.itemId) {
        if (leave.state !== 'refused' || tk.kind !== 'group-leave' || (tk.state !== 'failed' && tk.state !== 'refused')) return false;
        chat.leave = { itemId: newId(), item: null, state: 'sending' };
        chat.updatedAt = now;
        return true;
    }
    if (tk.state === 'sent' || tk.refused || tk.state === 'refused') chat.leave = null;
    else if (tk.state === 'failed') chat.leave = { itemId: newId(), item: null, state: 'sending' };
    else if (tk.state === 'queued' && leave.state !== 'queued') chat.leave = { ...leave, state: 'queued', item: null };
    else return false;
    chat.updatedAt = now;
    return true;
}

/**
 * The chat closed by my leave (the file's header, "Leaving"), or null when there is nothing to leave (not joining or in):
 * `left`, its keys and held lines gone, my epoch on its way dropped, and a line of mine not yet with my server `failed` (it
 * never goes; a tick may still say my server had it). Lines already shown stay. `leave` is my signed leave, kept to post.
 */
export function leaveGuestChatHere(c: GuestChat, leave: GuestLeave, me: string, now: number): GuestChat | null {
    if (c.state !== 'in' && c.state !== 'joining') return null;
    const lines = c.lines.map((l) => (l.author === me && (l.state === 'waiting' || l.state === 'sending') ? { ...l, state: 'failed' as const, note: null, item: null } : l));
    return { ...c, state: 'left', why: null, keys: {}, held: [], ownEpoch: null, epochSent: null, leave, lines, updatedAt: now };
}

/** The epoch a line of mine was sealed under, read from its item as it was posted; null when it has none. */
function sealedEpochOf(line: GuestLine): number | null {
    try {
        const item = JSON.parse(line.item ?? '') as { payload?: unknown };
        const epoch = (JSON.parse(String(item.payload)) as { metadata?: { epoch?: unknown } })?.metadata?.epoch;
        return Number.isSafeInteger(epoch) ? epoch as number : null;
    } catch {
        return null;
    }
}

/**
 * A short mark of a roster, to tell whether the roster is still the one an epoch was made from. Its `former` (names of
 * people out of the chat: never a key an epoch wraps to) is left out, so a roster that names one more of them is the same.
 */
export function guestRosterMark(roster: GuestRoster | null | undefined): string {
    return bytesToHex(sha256(utf8ToBytes(JSON.stringify(roster ? { ...roster, former: undefined } : null)))).slice(0, 32);
}

function structuredCloneChats(c: GuestChats): GuestChats {
    return JSON.parse(JSON.stringify(c ?? {})) as GuestChats;
}

/** Chats as the device stores them, read back: anything that isn't one is left out. */
export function readGuestChats(json: string | null | undefined): GuestChats {
    if (!json) return {};
    try {
        const o = JSON.parse(json) as unknown;
        if (!isObject(o)) return {};
        const out: GuestChats = {};
        for (const [id, c] of Object.entries(o)) {
            if (isObject(c) && c.id === id && typeof c.host === 'string' && typeof c.group === 'string' && Array.isArray(c.lines)) out[id] = c as unknown as GuestChat;
        }
        return out;
    } catch {
        return {};
    }
}

// ── What a guest sends ──────────────────────────────────────────────────────────────────────

/** The payload of a yes or no to an invitation (`group-invite`), as the host reads it. */
export function guestAnswerPayload(answer: 'yes' | 'no'): string {
    return JSON.stringify({ v: 1, answer });
}

/** The payload of a leave (`group-leave`). */
export function guestLeavePayload(): string {
    return JSON.stringify({ v: 1 });
}

/**
 * What a guest's device sends next for a chat, from its latest roster: an epoch (the newcomer makes theirs, or a stale one
 * needs the next before a waiting line can go), or nothing. An epoch only when one is needed for me: I have no key yet, or a
 * line of mine waits; never a second for the same number, nor while one of mine is on its way; never one no newer than an
 * epoch a line of mine was refused under, nor one from the roster my last refused epoch was made from (the file's header,
 * "Refusals": the device waits for the roster the host sends after a refusal).
 */
export function guestEpochDue(chat: GuestChat, me: string): Extract<ReturnType<typeof guestEpochStep>, { send: 'group-epoch' }> | null {
    if (chat.state !== 'in' || !chat.roster || chat.ownEpoch) return null;
    const step = guestEpochStep(chat.roster, me, { joining: Object.keys(chat.keys).length === 0 });
    if (step.send !== 'group-epoch' || chat.epochSent === step.epoch) return null;
    if (step.epoch <= (chat.refusedEpoch ?? 0)) return null;
    if (chat.epochWait && chat.epochWait === guestRosterMark(chat.roster)) return null;
    // A waiting line needs one only when it can't be sealed now (a key newer than the roster's may be here already).
    const needed = Object.keys(chat.keys).length === 0 || (chat.lines.some((l) => l.state === 'waiting') && !guestSealEpoch(chat));
    return needed ? step : null;
}

/**
 * The epoch made for a step, to go as item `itemId`: its `group-epoch` payload and the {@link GuestOwnEpoch} to keep
 * (`sending`), which {@link takeOwnEpoch} puts on the chat as it is when written. Its key seals nothing yet: the host may
 * refuse it for one made at the same time (the roster after that brings the key it took), and only a tick saying it took
 * it puts the key with the others.
 */
export function makeGuestEpochFor(chat: GuestChat, step: NonNullable<ReturnType<typeof guestEpochDue>>, me: string, myEdPrivHex: string, now: number, itemId: string): { payload: string; ownEpoch: GuestOwnEpoch } {
    const { payload, groupKey } = makeGuestEpoch(step, chat.group, me, myEdPrivHex, new Date(now).toISOString());
    return { payload, ownEpoch: { epoch: step.epoch, key: b64(groupKey), itemId, state: 'sending', item: null, from: guestRosterMark(chat.roster) } };
}

/**
 * My epoch put on the chat as it is now (`c`, read inside the write), or null when that chat no longer wants this one:
 * an epoch of mine is already on its way, or the epoch due now is another (a roster, a key or a refusal came while it was
 * made and signed). Nothing else of the chat changes, so a page or a line written meanwhile stays.
 */
export function takeOwnEpoch(c: GuestChat, own: GuestOwnEpoch, me: string, now: number): GuestChat | null {
    const due = guestEpochDue(c, me);
    if (!due || due.epoch !== own.epoch || guestRosterMark(c.roster) !== own.from) return null;
    return { ...c, ownEpoch: own, epochSent: own.epoch, updatedAt: now };
}

/**
 * The epoch my lines go under now: the newest whose key is here (every key here is one the host has: the file's header,
 * "Epochs"), unless the host's roster says a newer one is current or that one is stale; else null (the line waits).
 */
export function guestSealEpoch(chat: GuestChat): { epoch: number; key: Uint8Array } | null {
    if (chat.state !== 'in') return null;
    const e = chat.roster?.epoch;
    // After my own epoch the host's roster may lag: the newest key here is then the one the host has just taken from me.
    const numbers = Object.keys(chat.keys).map(Number).filter((n) => Number.isSafeInteger(n)).sort((a, b) => b - a);
    const epoch = numbers[0];
    if (epoch === undefined || !chat.keys[String(epoch)]) return null;
    // Refused under it (or a newer one) already: the line waits for a newer key (the file's header, "Refusals").
    if (epoch <= (chat.refusedEpoch ?? 0)) return null;
    // Behind the host's, or the stale one itself: the line waits for the next epoch (guestEpochDue makes it).
    if (e && (e.current > epoch || (e.stale && e.current === epoch))) return null;
    return { epoch, key: unb64(chat.keys[String(epoch)]) };
}

/**
 * A line of mine sealed under `sealed`'s epoch, as the host stores a member's: its `group-line` payload. The line's id is
 * the item's id (the host stores a guest's line under it, #3233 round 1), a lower-case UUID v4.
 */
export function guestLinePayload(text: string, input: { group: string; epoch: number; key: Uint8Array; messageId: string; myEdPrivHex: string }): string {
    const sealed = sealGroupLine(text, { myEdPrivHex: input.myEdPrivHex, groupKey: input.key, groupId: input.group, epoch: input.epoch, messageId: input.messageId });
    return JSON.stringify({ ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch: input.epoch }, type: 'text', clientId: input.messageId });
}

// ── Words both apps show ────────────────────────────────────────────────────────────────────

export const GUEST_CHAT_WORDS = Object.freeze({
    invitedYou: word('{name} invites you to the chat of the group {group}, in {community}.'),
    invitedCard: word('{group} · {community}'),
    youAreGuest: word("You're a guest in this group's chat. You see its messages and the names in it, nothing else of the group."),
    keptHere: word('Kept on this phone only. Your community keeps no copy.'),
    newDevice: word('Messages from before you joined on this device are not here.'),
    joining: word('Joining… The chat opens once the group answers.'),
    removed: word('You were removed from this chat. Nothing more reaches you from it.'),
    closed: word('This group was closed. Nothing more reaches you from it.'),
    guestsOff: word("This group's community turned off guests from other communities. Nothing more reaches you from it."),
    chatClosed: word('This chat is closed. Nothing more reaches you from it.'),
    left: word('You left this chat.'),
    declined: word('You declined this invitation.'),
    waiting: word('Waiting for the group'),
    refused: word("The group didn't take this message."),
    notReached: word("The group's community couldn't be reached."),
    photoNotHere: word("A photo or voice message: it doesn't show here yet."),
    addGuest: word('Add someone from another community'),
    addGuestHint: word("Paste their address card. They're asked first, and see only this group's chat."),
    guestsTitle: word('Guests from other communities'),
    guestAsked: word('Asked, not answered yet'),
    guestIn: word('In the chat'),
    guestAdded: word('Asked. They join the chat once they accept.'),
    readCard: word('Read the card'),
    notACard: word("That isn't an address card, or it was changed after it was made."),
    // Part 2: the guest's Leave and the convenor's Remove, each asked first.
    leave: word('Leave this chat'),
    leaveAsk: word('Leave this chat?'),
    leaveWhat: word('Nothing more reaches you from it. The messages already here stay on this device.'),
    leaveYes: word('Leave', 'button: leave a group chat'),
    remove: word('Remove', 'button: remove a guest from a group chat'),
    removeLabel: word('Remove {name} from this chat'),
    removeAsk: word('Remove {name}?'),
    removeWhatIn: word('Nothing more of this chat reaches them. What they already have stays with them.'),
    removeWhatAsked: word('Their invitation is withdrawn.'),
    removedNote: word('Removed. Their community is told.'),
});

/** Why a guest's chat closed, as this device keeps it: a convenor's Remove, the group closed by its members, or its owners turned guests off. */
export type GuestClosedWhy = 'removed' | 'group-closed' | 'guests-off';

/**
 * Every `why` the host's removal says (engine/group-guests.ts: a convenor's Remove `removed`; the members' vote to close
 * the group, closeGroupGuests, `group-closed`; the owners' switch, closeGuestsIfSwitchedOff, `closed`). The guard test reads
 * the host's code and fails on one missing here.
 */
export const GUEST_REMOVED_WHYS = ['removed', 'group-closed', 'closed'] as const;

/** The host's `why` as this device keeps it; null for one it doesn't know (its chat says only that it is closed). */
export function guestClosedWhyOf(why: unknown): GuestClosedWhy | null {
    switch (why) {
        case 'removed': return 'removed';
        case 'group-closed': return 'group-closed';
        case 'closed': return 'guests-off';
        default: return null;
    }
}

/**
 * Why a guest's chat is closed, in the words both apps show (the file's header, "Whys"); null while it is open or waiting.
 * Each reason the host gives has its own sentence; a removal whose reason this device never heard says only that it is closed.
 */
export function guestClosedWords(chat: Pick<GuestChat, 'state' | 'why'>): string | null {
    if (chat.state === 'removed') {
        switch (chat.why) {
            case 'removed': return t(GUEST_CHAT_WORDS.removed);
            case 'group-closed': return t(GUEST_CHAT_WORDS.closed);
            case 'guests-off': return t(GUEST_CHAT_WORDS.guestsOff);
            default: return t(GUEST_CHAT_WORDS.chatClosed);
        }
    }
    if (chat.state === 'left') return t(GUEST_CHAT_WORDS.left);
    if (chat.state === 'declined') return t(GUEST_CHAT_WORDS.declined);
    return null;
}

/**
 * A guest's name in the chat, as both apps write it and the node serves it: their card's name, their community, "guest"
 * (name-line.ts), "Dax · riverside.example · guest". The card's name is read clean (cleanName: padding and spoofing
 * out, a real name as written), so "Ana" padded with zero-width spaces is "Ana · a.example · guest". Given `max` (the node gives
 * NAME_LINE_CHARS), only the card's name is cut, so the whole line fits `max`: their community and "guest" are never cut.
 * A home so long that they alone leave no room keeps the name's first character and "…", and the line runs past `max`.
 */
export function guestNameLine(name: string, home: string, max?: number): string {
    const line = (n: string) => nameLine({ kind: 'guest', name: nameLine({ kind: 'community', name: n, community: home }) });
    const clean = cleanName(name) || '…';
    if (max === undefined) return line(clean);
    // The line's own words and community, in the reader's language: the line around a one-character name, less that name.
    const around = Array.from(line('x')).length - 1;
    return line(clipName(clean, max - around));
}

/**
 * The name a line's author goes by in a guest's chat (the file's header, "Names"): the newest row this device has for that
 * key, in any state. The latest roster first (a member by their name, a guest by the guest line, then someone it names as
 * no longer in the chat), then the name kept from an earlier roster; a key no roster ever named, a short key.
 */
export function guestChatAuthorName(chat: Pick<GuestChat, 'roster'> & Partial<Pick<GuestChat, 'names'>>, key: string): string {
    const r = chat.roster;
    const m = r?.members.find((x) => x.key === key);
    if (m) return m.name;
    const g = r?.guests.find((x) => x.key === key);
    if (g) return guestNameLine(g.name, g.home);
    const fm = r?.former?.members.find((x) => x.key === key);
    if (fm) return fm.name;
    const fg = r?.former?.guests.find((x) => x.key === key);
    if (fg) return guestNameLine(fg.name, fg.home);
    const kept = chat.names?.[key];
    if (isObject(kept) && typeof kept.name === 'string') return typeof kept.home === 'string' ? guestNameLine(kept.name, kept.home) : kept.name;
    return key.slice(0, 8);
}
