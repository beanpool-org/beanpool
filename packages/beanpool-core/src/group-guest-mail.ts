/**
 * A guest's mail round and sends, for both apps (slice G2; the chats themselves are group-guest-chat.ts). Each app gives
 * {@link GuestMailIO}: its signed requests to its own community's server, its envelope signer, and where it keeps the chats
 * (the phone's community file, the browser's own database). The round and the sends are the same on both.
 *
 * **The round** ({@link syncGuestMail}): `GET /api/mail/group?device=` (what waits that this device hasn't confirmed, where I
 * stand with each group, and my items' ticks after the cursor), the gate and the chats (applyGuestMail, applyGuestTicks),
 * WRITTEN, then confirmed (`POST /api/mail/group/confirm`): a notice whose write failed is fetched again, never lost. Then
 * what is due for each chat: my join epoch (or the next one before a waiting line can go), the lines waiting for a key, the
 * lines my server never answered.
 *
 * **Sends** go to `POST /api/mail/send` as relay items: the envelope I sign names my server as my home and the group's host
 * as the recipient's, `group:<id>`. My server checks where I stand with that group before it sends anything on.
 */
import type { RelayEnvelope, RelayEnvelopeFields, RelayItem } from './relay-envelope.js';
import { relayPayloadHash } from './relay-envelope.js';
import {
    applyGuestMail, applyGuestTicks, guestAnswerPayload, guestEpochDue, guestLinePayload, guestSealEpoch, makeGuestEpochFor,
    GUEST_LINE_TEXT_MAX, type GuestChat, type GuestChats, type GuestLine,
} from './group-guest-chat.js';

/** What one app gives the round. Every request is signed by the member and goes to their own community's server only. */
export interface GuestMailIO {
    me: string;
    myEdPrivHex: string;
    /** My community's server's home, as envelopes name it; null when it knows none of its names yet. */
    home(): Promise<string | null>;
    /** This device's mail id (the mailbox's own, X2b). */
    device(): Promise<string>;
    /** A signed GET to my server; throws on an answer that isn't 2xx (with the server's words when it sent any). */
    get(path: string): Promise<unknown>;
    /** A signed POST to my server; throws likewise. */
    post(path: string, body: unknown): Promise<unknown>;
    sign(fields: RelayEnvelopeFields): Promise<RelayEnvelope>;
    load(): Promise<GuestChats>;
    /** Resolves once written; throws when it couldn't be. */
    save(chats: GuestChats): Promise<void>;
    getMeta(k: string): Promise<string | null>;
    setMeta(k: string, v: string): Promise<void>;
    isBlocked(key: string): Promise<boolean>;
    now(): number;
    /** A new lower-case UUID v4 (core newDmMessageId). */
    newId(): string;
}

/** The ticks' cursor, `<at>:<itemId>`, kept beside the chats. */
export const GUEST_CURSOR_META = 'guest-sent-cursor';
/** Pages one round reads at most. */
const PAGES_MAX = 10;
/** A line my server never answered is posted again while this fresh (my server refuses an item older than 7 days). */
const RESEND_WITHIN_MS = 6 * 24 * 60 * 60_000;

/** My server has no name to put in an envelope yet. */
export class GuestMailNoHome extends Error {
    constructor() {
        super('no_home');
        this.name = 'GuestMailNoHome';
    }
}

async function item(io: GuestMailIO, chat: GuestChat, kind: 'group-invite' | 'group-leave' | 'group-line' | 'group-epoch', itemId: string, payload: string): Promise<RelayItem> {
    const home = await io.home();
    if (!home) throw new GuestMailNoHome();
    const envelope = await io.sign({
        kind, itemId, senderKey: io.me, senderHome: home, recipient: `group:${chat.group}`, recipientHome: chat.host, at: io.now(), payloadHash: relayPayloadHash(payload),
    });
    return { envelope, payload };
}

/** Posts items; each one's state as my server answered it (its refusal from the host too). */
async function post(io: GuestMailIO, items: RelayItem[]): Promise<Array<{ itemId: string; state: string; refused?: string }>> {
    const answer = await io.post('/api/mail/send', { items }) as { items?: unknown } | null;
    return Array.isArray(answer?.items) ? answer!.items as Array<{ itemId: string; state: string; refused?: string }> : [];
}

/** One chat changed and written: the chats as they are now, with `id` replaced by `next(chat)`. */
async function update(io: GuestMailIO, id: string, next: (c: GuestChat) => GuestChat | null): Promise<GuestChat | null> {
    const chats = await io.load();
    const c = chats[id];
    if (!c) return null;
    const n = next(c);
    if (!n) return c;
    await io.save({ ...chats, [id]: n });
    return n;
}

/**
 * My answer to an invitation: yes (`joining` until the host takes it; the chat opens with the roster that follows) or no
 * (declined; the host is told). Throws with my server's words when it refuses; the invitation then still waits.
 */
export async function answerGuestInvitation(io: GuestMailIO, id: string, answer: 'yes' | 'no'): Promise<void> {
    const chat = (await io.load())[id];
    if (!chat || chat.state !== 'invited') return;
    const answered = await post(io, [await item(io, chat, 'group-invite', io.newId(), guestAnswerPayload(answer))]);
    const refused = answered.some((a) => a.refused || a.state === 'refused' || a.state === 'failed');
    if (refused && answer === 'yes') return;
    await update(io, id, (c) => ({ ...c, state: answer === 'yes' ? 'joining' : 'declined', updatedAt: io.now() }));
}

/** What a line of mine needs before it goes: the words checked. */
export function guestLineWords(text: string): string | null {
    const words = text.trim();
    return words && words.length <= GUEST_LINE_TEXT_MAX ? words : null;
}

/**
 * A line of mine: kept here first (shown at once), sealed under the epoch the host has now when this device has its key, and
 * posted; with no key yet it waits (`waiting`), and the round makes the epoch, then sends it. Returns the line as kept.
 */
export async function sendGuestLine(io: GuestMailIO, id: string, text: string): Promise<GuestLine | null> {
    const words = guestLineWords(text);
    if (!words) return null;
    const lineId = io.newId();
    const mine: GuestLine = { id: lineId, author: io.me, text: words, at: io.now(), state: 'waiting', item: null, note: null };
    const kept = await update(io, id, (c) => (c.state === 'in' ? { ...c, lines: [...c.lines, mine], updatedAt: io.now() } : null));
    if (!kept || !kept.lines.some((l) => l.id === lineId)) return null;
    await sendDue(io, id);
    return ((await io.load())[id]?.lines ?? []).find((l) => l.id === lineId) ?? mine;
}

/** Lines of mine that can go now: waiting ones sealed under the current epoch, and sending ones my server never answered. */
async function sendDue(io: GuestMailIO, id: string): Promise<boolean> {
    let chat = (await io.load())[id];
    if (!chat || chat.state !== 'in') return false;
    let changed = false;
    const step = guestEpochDue(chat, io.me);
    if (step) {
        const made = makeGuestEpochFor(chat, step, io.me, io.myEdPrivHex, io.now());
        // Kept before it goes: the key the epoch carries is the one my next line is sealed under. Not taken (refused, or the
        // request failed): the key goes and the next round may make the epoch again.
        await update(io, id, () => made.chat);
        const undo = () => update(io, id, (c) => ({ ...c, epochSent: null, keys: dropKey(c.keys, step.epoch) }));
        let answered: Array<{ itemId: string; state: string; refused?: string }>;
        try {
            answered = await post(io, [await item(io, chat, 'group-epoch', io.newId(), made.payload)]);
        } catch (e) {
            await undo();
            throw e;
        }
        changed = true;
        if (answered.some((a) => a.refused)) {
            await undo();
            return changed;
        }
        chat = (await io.load())[id]!;
    }
    const seal = guestSealEpoch(chat);
    const now = io.now();
    const go: RelayItem[] = [];
    const sealed = new Map<string, string>();
    for (const l of chat.lines) {
        if (l.author !== io.me) continue;
        if (l.state === 'waiting' && seal) {
            const payload = guestLinePayload(l.text, { group: chat.group, epoch: seal.epoch, key: seal.key, messageId: l.id, myEdPrivHex: io.myEdPrivHex });
            const it = await item(io, chat, 'group-line', l.id, payload);
            sealed.set(l.id, JSON.stringify(it));
            go.push(it);
        } else if (l.state === 'sending' && l.item && now - l.at < RESEND_WITHIN_MS) {
            try { go.push(JSON.parse(l.item) as RelayItem); } catch { /* not kept as sent */ }
        }
    }
    if (!go.length) return changed;
    // Kept as `sending` with the item before it is posted: a round that stops now posts the same item again.
    await update(io, id, (c) => ({ ...c, lines: c.lines.map((l) => (sealed.has(l.id) ? { ...l, state: 'sending', item: sealed.get(l.id)! } : l)) }));
    let answered: Array<{ itemId: string; state: string; refused?: string }>;
    try {
        answered = await post(io, go);
    } catch (e) {
        const status = (e as { status?: number })?.status;
        // My server said no for good (a 4xx but try-later ones): those lines will never go as they are.
        if (typeof status === 'number' && status >= 400 && status < 500 && ![401, 408, 425, 429].includes(status)) {
            const why = e instanceof Error && e.message && !/^HTTP \d+$/.test(e.message) ? e.message : null;
            const ids = new Set(go.map((g) => g.envelope.itemId));
            await update(io, id, (c) => ({ ...c, lines: c.lines.map((l) => (ids.has(l.id) ? { ...l, state: 'failed', note: why, item: null } : l)) }));
        }
        throw e;
    }
    const ticks = answered.map((a) => ({ itemId: a.itemId, kind: 'group-line', host: chat!.host, group: chat!.group, state: a.state, refused: a.refused ?? null, at: now }));
    const { chats } = applyGuestTicks(await io.load(), ticks, now);
    await io.save(chats);
    return true;
}

function dropKey(keys: Record<string, string>, epoch: number): Record<string, string> {
    const { [String(epoch)]: _gone, ...rest } = keys;
    return rest;
}

export interface GuestRoundOutcome { notices: number; changed: boolean }

/**
 * One round (the file's header). Throws on a failed request; what was written before it stays written, and what wasn't
 * confirmed is fetched again at the next round.
 */
export async function syncGuestMail(io: GuestMailIO): Promise<GuestRoundOutcome> {
    const device = await io.device();
    let notices = 0;
    let changed = false;
    let cursor = (await io.getMeta(GUEST_CURSOR_META)) ?? '';
    for (let page = 0; page < PAGES_MAX; page++) {
        const [since, ...rest] = cursor.split(':');
        const q = `device=${encodeURIComponent(device)}${cursor ? `&since=${encodeURIComponent(since)}&sinceId=${encodeURIComponent(rest.join(':'))}` : ''}`;
        const got = await io.get(`/api/mail/group?${q}`) as { items?: unknown[]; more?: boolean; groups?: unknown; sent?: Array<{ itemId: string; at: number }>; sentMore?: boolean } | null;
        if (!got) break;
        // The gate asks about blocks by key; each inviter is asked once, before the page is read.
        const inviters = new Set<string>();
        for (const n of got.items ?? []) {
            const by = (n as { kind?: string; data?: { invitedBy?: { key?: unknown } } })?.kind === 'invite' ? (n as any).data?.invitedBy?.key : null;
            if (typeof by === 'string') inviters.add(by);
        }
        const blocked = new Set<string>();
        for (const k of inviters) if (await io.isBlocked(k)) blocked.add(k);
        const now = io.now();
        const applied = applyGuestMail(await io.load(), { items: got.items, groups: got.groups }, { me: io.me, myEdPrivHex: io.myEdPrivHex, blocked: (k) => blocked.has(k), now });
        const ticked = applyGuestTicks(applied.chats, got.sent, now);
        if (applied.changed || ticked.changed) await io.save(ticked.chats);
        changed ||= applied.changed || ticked.changed;
        const sent = Array.isArray(got.sent) ? got.sent : [];
        const last = sent[sent.length - 1];
        if (last && Number.isSafeInteger(last.at) && typeof last.itemId === 'string') {
            cursor = `${last.at}:${last.itemId}`;
            await io.setMeta(GUEST_CURSOR_META, cursor);
        }
        // Written; now confirmed (a page at a time, as the server takes them).
        if (applied.confirm.length) await io.post('/api/mail/group/confirm', { ids: applied.confirm, device });
        notices += applied.confirm.length;
        if (!got.more && !got.sentMore) break;
    }
    for (const id of Object.keys(await io.load())) {
        try {
            changed = (await sendDue(io, id)) || changed;
        } catch (e) {
            if (e instanceof GuestMailNoHome) break;
            throw e;
        }
    }
    return { notices, changed };
}
