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
 */
import {
    openGroupLine, openMyGroupKey, sealGroupLine, type GroupEpochRecord, type GroupServedWrap,
} from './group-crypto.js';
import { guestEpochStep, makeGuestEpoch, openGuestEpochKey, readGuestRoster, type GuestRoster, type GuestRosterWrap } from './group-guest-steps.js';
import { nameLine } from './name-line.js';
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
    /** The writer's key. */
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
    /** Opened epoch keys, base64, by epoch number. */
    keys: Record<string, string>;
    /** The epoch number this device last sent a `group-epoch` for, so a round doesn't send a second for it. */
    epochSent: number | null;
    lines: GuestLine[];
    held: GuestHeldLine[];
    /** Why the chat closed, when the host said: removed by a convenor, or the group closed. */
    why: 'removed' | 'group-closed' | null;
    updatedAt: number;
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

/** What the gate does with a notice: show an invitation, take it into the chat, or drop it. */
export type GuestGateVerdict = 'invite' | 'take' | 'drop';

/**
 * The gate for one notice (the file's header). `blocked`: whether this account blocked a key. An invitation from someone
 * blocked is dropped; one for a group the guest is already joining or in is a repeat. A removal reaches an invitation
 * (withdrawn), a yes on its way or an in-guest. Anything else passes only once they are joining or in.
 */
export function gateGuestNotice(chat: Pick<GuestChat, 'state'> | null | undefined, kind: string, data: unknown, blocked: (key: string) => boolean): GuestGateVerdict {
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

/** The viewer a guest chat's own state makes of me: a guest while joining or in, removed once out; an invitation is no chat yet (null). */
export function guestViewerOf(chat: Pick<GuestChat, 'state'>): GuestViewer | null {
    if (chat.state === 'invited') return null;
    return chat.state === 'in' || chat.state === 'joining' ? 'guest' : 'removed';
}

// ── Reading the server's page ───────────────────────────────────────────────────────────────

export interface GuestMailContext {
    /** My key. */
    me: string;
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
        lines: [], held: [], why: null, updatedAt: now,
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

/** A line notice's words, opened with the key of its epoch; null when the key isn't here or it doesn't open as its sender's. */
function openHeld(chat: GuestChat, h: GuestHeldLine): GuestLine | null {
    const key = chat.keys[String(h.epoch)];
    if (!key) return null;
    if (h.type !== 'text') return { id: h.id, author: h.author, text: t(GUEST_CHAT_WORDS.photoNotHere), at: h.at };
    try {
        const opened = openGroupLine({ ciphertext: h.ciphertext, nonce: h.nonce }, {
            groupId: chat.group, epoch: h.epoch, senderPubHex: h.sender, messageId: h.id, part: 'body', replyToId: h.replyToId,
        }, unb64(key));
        return { id: h.id, author: h.author, text: opened.text, at: h.at };
    } catch {
        return null;
    }
}

/** A line notice as held, or null when it isn't one. */
function heldOf(data: unknown): GuestHeldLine | null {
    if (!isObject(data) || typeof data.id !== 'string' || typeof data.author !== 'string' || !KEY_HEX.test(data.author)) return null;
    if (typeof data.ciphertext !== 'string' || typeof data.nonce !== 'string') return null;
    const meta = isObject(data.metadata) ? data.metadata : {};
    const epoch = meta.epoch;
    if (!Number.isSafeInteger(epoch) || (epoch as number) < 1) return null;
    const sender = typeof meta.sender === 'string' && KEY_HEX.test(meta.sender) ? meta.sender : data.author;
    const at = Date.parse(String(data.timestamp ?? ''));
    return {
        id: data.id, author: data.author, sender, epoch: epoch as number, ciphertext: data.ciphertext, nonce: data.nonce,
        replyToId: typeof meta.replyToId === 'string' ? meta.replyToId : null, type: typeof data.type === 'string' ? data.type : 'text',
        at: Number.isFinite(at) ? at : 0,
    };
}

/** Every held line that opens now goes into the chat; the rest stay held (the newest GUEST_HELD_KEPT). */
function openWhatCan(chat: GuestChat): void {
    const still: GuestHeldLine[] = [];
    for (const h of chat.held) {
        const line = openHeld(chat, h);
        if (!line) { still.push(h); continue; }
        if (!chat.lines.some((l) => l.id === line.id)) chat.lines.push(line);
    }
    chat.held = still.slice(-GUEST_HELD_KEPT);
    chat.lines.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (chat.lines.length > GUEST_LINES_KEPT) chat.lines = chat.lines.slice(-GUEST_LINES_KEPT);
}

/** Takes a roster: kept, and the current epoch's key opened from my wrap when it is not stale. */
function takeRoster(chat: GuestChat, roster: GuestRoster, ctx: GuestMailContext): void {
    chat.roster = roster;
    if (roster.name) chat.name = roster.name;
    const step = guestEpochStep(roster, ctx.me);
    if (step.send === 'group-line') {
        try { chat.keys[String(step.epoch)] = b64(openGuestEpochKey(step, chat.group, ctx.myEdPrivHex)); } catch { /* not opened: the line waits */ }
    }
}

/**
 * The server's page applied to the chats on this device: the gate first, then each notice taken, then where the server
 * says I stand with each group. Returns the chats (a new object; the old is untouched) and the notice ids to confirm:
 * every one read, taken or dropped (an unconfirmed one would hold the page). The caller confirms only after the chats are
 * written.
 */
export function applyGuestMail(before: GuestChats, page: { items?: unknown; groups?: unknown }, ctx: GuestMailContext): { chats: GuestChats; confirm: string[]; changed: boolean } {
    const chats: GuestChats = structuredCloneChats(before);
    const confirm: string[] = [];
    let changed = false;
    const items = Array.isArray(page.items) ? page.items as GuestNotice[] : [];
    for (const n of items) {
        if (!isObject(n) || typeof n.id !== 'string') continue;
        confirm.push(n.id);
        if (typeof n.host !== 'string' || typeof n.group !== 'string') continue;
        const id = guestChatId(n.host, n.group);
        const chat = chats[id];
        const verdict = gateGuestNotice(chat, n.kind, n.data, ctx.blocked);
        if (verdict === 'drop') continue;
        changed = true;
        if (verdict === 'invite') {
            const data = n.data as { name: string; invitedBy: { key: string; name: unknown } };
            const fresh = newChat(n.host, n.group, ctx.now);
            // A new invitation after a leave or a removal starts a new chat: nothing of the old one carries over.
            chats[id] = {
                ...fresh, name: data.name.slice(0, 120),
                invitedBy: { key: data.invitedBy.key, name: typeof data.invitedBy.name === 'string' ? data.invitedBy.name.slice(0, 60) : '' },
            };
            continue;
        }
        const c = chat!;
        c.updatedAt = ctx.now;
        if (n.kind === 'removed') {
            const why = isObject(n.data) && n.data.why === 'group-closed' ? 'group-closed' : 'removed';
            if (c.state === 'invited') { delete chats[id]; continue; }
            c.state = 'removed';
            c.why = why;
            c.keys = {};
            c.held = [];
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
        }
        openWhatCan(c);
    }
    changed = applyGuestLinks(chats, page.groups, ctx) || changed;
    return { chats, confirm, changed };
}

/**
 * Where the server says I stand with each group it lists (invited, joining, in, removed) moves my chats there: the server
 * is the authority on that, the device only remembers. A group it lists that this device has no chat for (a new device, an
 * invitation confirmed on another) gets one, from its roster; an invitation it lists with no notice here waits as one.
 */
function applyGuestLinks(chats: GuestChats, groups: unknown, ctx: GuestMailContext): boolean {
    if (!Array.isArray(groups)) return false;
    let changed = false;
    for (const l of groups as GuestLink[]) {
        if (!isObject(l) || typeof l.host !== 'string' || typeof l.group !== 'string') continue;
        const state = l.state;
        if (state !== 'invited' && state !== 'joining' && state !== 'in' && state !== 'removed') continue;
        const id = guestChatId(l.host, l.group);
        let chat = chats[id];
        if (!chat) {
            // A removal for a chat this device never had: nothing to show.
            if (state === 'removed') continue;
            // An invitation listed with no notice here is answered on the device that has the notice; there is no name to show.
            if (state === 'invited') continue;
            chat = chats[id] = newChat(l.host, l.group, ctx.now);
            changed = true;
        }
        if (chat.state !== state && !(chat.state === 'joining' && state === 'invited' && chat.updatedAt > ctx.now - 60_000)) {
            // `joining` here and `invited` there: my yes not taken yet. Kept a minute (the send in flight), then the server's word.
            if (state === 'removed') { chat.keys = {}; chat.held = []; chat.why = chat.why ?? 'removed'; }
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
    return changed;
}

/** What became of my items: each line's state moves on, a refused epoch or line goes back to wait for the next roster. */
export function applyGuestTicks(before: GuestChats, ticks: unknown, now: number): { chats: GuestChats; changed: boolean } {
    const chats = structuredCloneChats(before);
    let changed = false;
    if (!Array.isArray(ticks)) return { chats, changed };
    for (const tk of ticks as GuestSentTick[]) {
        if (!isObject(tk) || typeof tk.host !== 'string' || typeof tk.group !== 'string') continue;
        const chat = chats[guestChatId(tk.host, tk.group)];
        if (!chat) continue;
        if (tk.kind === 'group-epoch' && tk.refused) { chat.epochSent = null; changed = true; continue; }
        if (tk.kind !== 'group-line') continue;
        const line = chat.lines.find((l) => l.id === tk.itemId && l.state);
        if (!line) continue;
        const next: GuestLineState | null = tk.refused === 'epoch-stale' ? 'waiting'
            : tk.refused || tk.state === 'refused' ? 'failed'
            : tk.state === 'queued' ? 'queued' : tk.state === 'sent' ? 'sent' : tk.state === 'failed' ? 'failed' : null;
        if (!next || next === line.state) continue;
        line.state = next;
        line.item = next === 'waiting' ? null : line.item;
        line.note = next === 'failed' ? (tk.refused ? t(GUEST_CHAT_WORDS.refused) : t(GUEST_CHAT_WORDS.notReached)) : null;
        chat.updatedAt = now;
        changed = true;
    }
    return { chats, changed };
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
 * line of mine waits; never a second for the same number.
 */
export function guestEpochDue(chat: GuestChat, me: string): Extract<ReturnType<typeof guestEpochStep>, { send: 'group-epoch' }> | null {
    if (chat.state !== 'in' || !chat.roster) return null;
    const step = guestEpochStep(chat.roster, me, { joining: Object.keys(chat.keys).length === 0 });
    if (step.send !== 'group-epoch' || chat.epochSent === step.epoch) return null;
    const needed = Object.keys(chat.keys).length === 0 || chat.lines.some((l) => l.state === 'waiting');
    return needed ? step : null;
}

/**
 * The epoch made for a step: its `group-epoch` payload, and the chat with the new key kept under its number (the host may
 * refuse it for one made at the same time; the roster after that brings the key it took).
 */
export function makeGuestEpochFor(chat: GuestChat, step: NonNullable<ReturnType<typeof guestEpochDue>>, me: string, myEdPrivHex: string, now: number): { payload: string; chat: GuestChat } {
    const { payload, groupKey } = makeGuestEpoch(step, chat.group, me, myEdPrivHex, new Date(now).toISOString());
    return { payload, chat: { ...chat, keys: { ...chat.keys, [String(step.epoch)]: b64(groupKey) }, epochSent: step.epoch, updatedAt: now } };
}

/** The epoch my lines go under now: the roster's current one when it is not stale and its key is here; else null. */
export function guestSealEpoch(chat: GuestChat): { epoch: number; key: Uint8Array } | null {
    if (chat.state !== 'in') return null;
    const e = chat.roster?.epoch;
    // After my own epoch the host's roster may lag: the newest key here is the one the host has just taken from me.
    const numbers = Object.keys(chat.keys).map(Number).filter((n) => Number.isSafeInteger(n)).sort((a, b) => b - a);
    const current = e && !e.stale ? e.current : null;
    const epoch = current !== null && chat.keys[String(current)] ? current : chat.epochSent !== null && chat.keys[String(chat.epochSent)] ? chat.epochSent : numbers[0];
    if (epoch === undefined || !chat.keys[String(epoch)]) return null;
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
});

/** A guest's name in the chat, as both apps write it: their card's name, their community, "guest" (name-line.ts). */
export function guestNameLine(name: string, home: string): string {
    return nameLine({ kind: 'guest', name: nameLine({ kind: 'community', name, community: home }) });
}

/** The name a line's author goes by in a guest's chat: a member by their name, a guest by the guest line, else a short key. */
export function guestChatAuthorName(chat: Pick<GuestChat, 'roster'>, key: string): string {
    const r = chat.roster;
    const m = r?.members.find((x) => x.key === key);
    if (m) return m.name;
    const g = r?.guests.find((x) => x.key === key);
    if (g) return guestNameLine(g.name, g.home);
    return key.slice(0, 8);
}
