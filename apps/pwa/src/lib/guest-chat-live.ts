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
    answerGuestInvitation, guestNameLine, newDmMessageId, readGuestChats, sendGuestLine, syncGuestMail, type AddressCard, type GuestChats,
    type GuestLine, type GuestMailIO,
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

/** Whether this community lets groups have guests (its info's `features.groupGuests`, on only with `outsideMessages`). */
export async function groupGuestsHere(): Promise<boolean> {
    const info = await communityInfoOnce().catch(() => null);
    const f = (info?.features ?? {}) as { groupGuests?: unknown; outsideMessages?: unknown };
    return f.groupGuests === true && f.outsideMessages === true;
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

const guestRowsMemo = new Map<string, { at: number; rows: Promise<Array<{ memberPubkey: string; callsign: string }>> }>();

/**
 * The guests in a group's chat as rows a member's chat names lines by: each by core's guest line ("Dax · hillside.example ·
 * guest"), never the card's name alone. Read at most once a minute.
 */
export function guestRosterRows(groupId: string, now = Date.now()): Promise<Array<{ memberPubkey: string; callsign: string }>> {
    const kept = guestRowsMemo.get(groupId);
    if (kept && now - kept.at < 60_000) return kept.rows;
    const rows = fetchGroupGuests(groupId)
        .then(({ guests }) => guests.filter((g) => g.state === 'in').map((g) => ({ memberPubkey: g.key, callsign: guestNameLine(g.name, g.home) })))
        .catch(() => []);
    guestRowsMemo.set(groupId, { at: now, rows });
    return rows;
}

const knownRows = new Map<string, Array<{ memberPubkey: string; callsign: string }>>();

/**
 * The guest rows already read for a group, at once (none the first time), and a read started beside the chat, never in its
 * way, where guests are on here: the chat's next opening names its guests' lines.
 */
export function guestRowsKnown(groupId: string): Array<{ memberPubkey: string; callsign: string }> {
    void groupGuestsHere()
        .then((on) => (on ? guestRosterRows(groupId) : []))
        .then((rows) => { knownRows.set(groupId, rows); }, () => {});
    return knownRows.get(groupId) ?? [];
}
