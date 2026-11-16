/**
 * Guests in groups hosted by other communities, in the web app (slice G2; the phone's utils/guest-chat-live.ts): core's
 * round and sends (@beanpool/core group-guest-mail.ts) given this browser's signed requests to its own community, its
 * envelope signer and its store. The chats are kept in this browser only, in the outside chats' documents for this
 * community and account (lib/outside-chat-store.ts meta), so they go with them at Sign Out.
 *
 * The convenor's side (a member of the group here) is two signed requests to this community: the group's guests, and Add
 * someone from another community by their card (apps/server routes/groups.ts, `/api/groups/:id/guests`).
 */
import {
    answerGuestInvitation, guestNameRows, leaveGuestChat, newDmMessageId, readGuestChats, sendGuestLine, syncGuestMail, GUEST_NAMES_META,
    type AddressCard, type GuestChats, type GuestLine, type GuestMailIO, type GuestNameRows,
} from '@beanpool/core';
import { signedMailFetch, signRelayEnvelopeFor } from './api';
import { communityInfoOnce } from './visitor-lobby-gate';
import { OutsideMailError, answerOf, mailDevice, myHome, outsideContext, type OutsideMailContext } from './outside-mail';
import type { BeanPoolIdentity } from './identity';

/** Rung after a round or a send that changed a guest chat here. */
export const GUEST_CHATS_EVENT = 'beanpool-guest-chats';
/** One round's deadline: every request still out is aborted at it. */
export const GUEST_ROUND_MS = 30_000;

const CHATS_META = 'guest-chats';

/** Core's IO for the community this web app talks to. */
export function guestIO(ctx: OutsideMailContext): GuestMailIO {
    const identity = ctx.identity as BeanPoolIdentity;
    const me = ctx.identity.publicKey;
    const fetchHere = (method: 'GET' | 'POST', path: string, body?: unknown) => {
        if (ctx.holds && !ctx.holds()) return Promise.reject(Object.assign(new Error('This round no longer acts for this account here.'), { name: 'AbortError' }));
        return signedMailFetch(method, ctx.nodeUrl, path, body, identity, ctx.signal);
    };
    return {
        me, myEdPrivHex: ctx.identity.privateKey,
        home: () => myHome(ctx),
        device: () => mailDevice(ctx),
        get: async (path) => answerOf(await fetchHere('GET', path)),
        post: async (path, body) => answerOf(await fetchHere('POST', path, body)),
        sign: (fields) => signRelayEnvelopeFor(fields, identity),
        load: async () => readGuestChats(await ctx.store.getMeta(me, CHATS_META)),
        save: (chats) => ctx.store.setMeta(me, CHATS_META, JSON.stringify(chats)),
        getMeta: (k) => ctx.store.getMeta(me, k),
        setMeta: (k, v) => ctx.store.setMeta(me, k, v),
        isBlocked: ctx.isBlocked,
        now: () => Date.now(),
        newId: newDmMessageId,
    };
}

/** Whether this community lets groups have guests (its info's `features.groupGuests`, on only with `outsideMessages`); null when its info didn't read. */
async function groupGuestsKnownHere(): Promise<boolean | null> {
    const info = await communityInfoOnce().catch(() => null);
    if (!info) return null;
    const f = (info.features ?? {}) as { groupGuests?: unknown; outsideMessages?: unknown };
    return f.groupGuests === true && f.outsideMessages === true;
}

/** Whether this community lets groups have guests (its info's `features.groupGuests`, on only with `outsideMessages`). */
export async function groupGuestsHere(): Promise<boolean> {
    return (await groupGuestsKnownHere()) === true;
}

function ring(): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(GUEST_CHATS_EVENT));
}

/** The guest chats this account has in this browser (none with no account). */
export async function loadGuestChats(): Promise<GuestChats> {
    const ctx = await outsideContext().catch(() => null);
    return ctx ? guestIO(ctx).load().catch(() => ({})) : {};
}

let running: Promise<boolean> | null = null;

/** One round, never two at once in this tab; false when nothing was asked or it didn't finish (the next one starts afresh). */
export function syncGuestMailNow(): Promise<boolean> {
    if (running) return running;
    const round = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), GUEST_ROUND_MS);
        try {
            const ctx = await outsideContext();
            if (!ctx || !(await groupGuestsHere())) return false;
            const out = await syncGuestMail(guestIO({ ...ctx, signal: controller.signal }));
            if (out.changed) ring();
            return true;
        } catch (e) {
            if (!controller.signal.aborted) console.warn('[GuestMail] This round did not finish:', (e as Error)?.message ?? e);
            return false;
        } finally {
            clearTimeout(timer);
        }
    })();
    running = round;
    void round.finally(() => { if (running === round) running = null; });
    return round;
}

/** Accept or decline an invitation. Throws with my server's words when it refuses. */
export async function answerInvitation(id: string, answer: 'yes' | 'no'): Promise<void> {
    const ctx = await outsideContext();
    if (!ctx) return;
    await answerGuestInvitation(guestIO(ctx), id, answer);
    ring();
}

/** A line of mine in a guest chat: kept here at once, then sealed and sent. Throws with my server's words. */
export async function sendGuestLineNow(id: string, text: string): Promise<GuestLine | null> {
    const ctx = await outsideContext();
    if (!ctx) return null;
    try {
        return await sendGuestLine(guestIO(ctx), id, text);
    } finally {
        ring();
    }
}

/**
 * I leave a guest chat, once I confirmed (core leaveGuestChat): it closes here at once and my leave goes, again at each
 * round until the host has it. Throws only when nothing changed (my server has no name for envelopes yet).
 */
export async function leaveGuestChatNow(id: string): Promise<boolean> {
    const ctx = await outsideContext();
    if (!ctx) return false;
    try {
        return await leaveGuestChat(guestIO(ctx), id);
    } finally {
        ring();
    }
}

// ── The convenor's side: a group here ───────────────────────────────────────────────────────

export interface GroupGuest { key: string; home: string; name: string; state: 'invited' | 'in' | 'left' | 'removed' }

/** The group's guests as I may see them (a convenor: invited and in; a member: in), and whether guests are on here. */
export async function fetchGroupGuests(groupId: string): Promise<{ guests: GroupGuest[]; on: boolean }> {
    const ctx = await outsideContext();
    if (!ctx) return { guests: [], on: false };
    const body = await answerOf(await signedMailFetch('GET', ctx.nodeUrl, `/api/groups/${encodeURIComponent(groupId)}/guests`, undefined, ctx.identity as BeanPoolIdentity));
    return { guests: Array.isArray(body?.guests) ? body.guests : [], on: body?.on === true };
}

/** A convenor adds someone from another community by their card. Throws OutsideMailError with the server's words. */
export async function inviteGroupGuest(groupId: string, card: AddressCard): Promise<GroupGuest> {
    const ctx = await outsideContext();
    if (!ctx) throw new OutsideMailError(0, '');
    const body = await answerOf(await signedMailFetch('POST', ctx.nodeUrl, `/api/groups/${encodeURIComponent(groupId)}/guests`, { card }, ctx.identity as BeanPoolIdentity));
    return body.guest as GroupGuest;
}

/**
 * A convenor removes a guest from the group's chat (one asked: their invitation withdrawn), once they confirmed. The host
 * tells the guest's community, and the chat closes on their device. Throws OutsideMailError with the server's words.
 */
export async function removeGroupGuest(groupId: string, key: string): Promise<GroupGuest> {
    const ctx = await outsideContext();
    if (!ctx) throw new OutsideMailError(0, '');
    const path = `/api/groups/${encodeURIComponent(groupId)}/guests/${encodeURIComponent(key)}`;
    const body = await answerOf(await signedMailFetch('DELETE', ctx.nodeUrl, path, undefined, ctx.identity as BeanPoolIdentity));
    // The chat's names are read again at its next opening: the one removed is named, never given a key.
    guestRowsMemo.delete(groupId);
    return body.guest as GroupGuest;
}

const guestRowsMemo = new Map<string, { at: number; rows: Promise<GuestNameRows> }>();
const NO_ROWS: GuestNameRows = { shown: [], named: [] };

/**
 * The guests a group's chat names lines by (core group-guest-names.ts): `shown`, those in the chat by the host's list read
 * now, each by core's guest line ("Dax · hillside.example · guest"), never the card's name alone; `named`, every other guest
 * this browser kept a row for (they left, were removed, or the group's guests closed), named on their old lines with "no
 * longer in this group". Only `shown` may be given a key. Read at most once a minute; where guests are off here, nobody is in;
 * where that or the host's list didn't read, each guest keeps the row kept here and nobody is given a key.
 */
export function guestRosterRows(groupId: string, now = Date.now()): Promise<GuestNameRows> {
    const kept = guestRowsMemo.get(groupId);
    if (kept && now - kept.at < 60_000) return kept.rows;
    const rows = (async (): Promise<GuestNameRows> => {
        const ctx = await outsideContext().catch(() => null);
        if (!ctx) return NO_ROWS;
        const me = ctx.identity.publicKey;
        const metaKey = `${GUEST_NAMES_META}:${groupId}`;
        const before = await ctx.store.getMeta(me, metaKey).catch(() => null);
        const on = await groupGuestsKnownHere();
        const listed = on === null ? null : on ? await fetchGroupGuests(groupId).then((g) => g.guests, () => null) : [];
        const out = guestNameRows(before, listed, Date.now());
        if (out.json !== null) await ctx.store.setMeta(me, metaKey, out.json).catch(() => {});
        return { shown: out.shown, named: out.named };
    })().catch(() => NO_ROWS);
    guestRowsMemo.set(groupId, { at: now, rows });
    return rows;
}

const knownRows = new Map<string, GuestNameRows>();
const sameRows = (a: GuestNameRows, b: GuestNameRows) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The guest rows already read for a group, at once (none the first time in this page), and a read started beside the chat,
 * never in its way. When that read brings rows other than the ones handed out now, `onNew` is called once, so the open chat
 * is read again and names its guests' lines on its first opening too (WALK 3: "<key> · no longer in this group" until the
 * second). The same rows as before call nothing, so a chat read again for them never reads itself again.
 */
export function guestRowsKnown(groupId: string, onNew?: () => void): GuestNameRows {
    const handed = knownRows.get(groupId) ?? NO_ROWS;
    void guestRosterRows(groupId).then((rows) => {
        knownRows.set(groupId, rows);
        if (onNew && !sameRows(handed, rows)) onNew();
    }, () => {});
    return handed;
}
