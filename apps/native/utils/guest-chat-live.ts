/**
 * Guests in groups hosted by other communities, on the phone (slice G2): core's round and sends (@beanpool/core
 * group-guest-mail.ts) given this phone's signed requests to its own community, its envelope signer and its store. The
 * chats are kept in the community's file beside the outside chats (utils/outside-chat-store.ts meta, one document per
 * account), so they go with them at Sign Out and are never in a Force Resync.
 *
 * The convenor's side (a member of the group here) is two signed requests to this community: the group's guests, and Add
 * someone from another community by their card (apps/server routes/groups.ts, `/api/groups/:id/guests`).
 */
import { DeviceEventEmitter } from 'react-native';
import {
    answerGuestInvitation, guestNameRows, leaveGuestChat, newDmMessageId, readGuestChats, sendGuestLine, syncGuestMail, GUEST_NAMES_META,
    type AddressCard, type GuestChats, type GuestLine, type GuestMailIO, type GuestNameRows,
} from '@beanpool/core';
import { outsideContext } from './outside-chat-live';
import { OutsideMailError, answerOf, mailDevice, myHome, type OutsideMailContext } from './outside-mail';
import { signedDelete, signedGet, signedPost } from './node-post';
import { signRelayEnvelopeStatement } from './member-statements';
import { fetchNodeProfile, getCachedNodeProfile, groupGuestsOn } from './node-profile';
import type { BeanPoolIdentity } from './identity';

/** Emitted after a round or a send that changed a guest chat here. */
export const GUEST_CHATS_UPDATED = 'guest_chats_updated';
/** One round's deadline: every request still out is aborted at it. */
export const GUEST_ROUND_MS = 30_000;

const chatsMeta = (me: string) => `guest-chats:${me}`;
/** Core's IO for the community the phone is set to. */
export function guestIO(ctx: OutsideMailContext): GuestMailIO {
    const identity = ctx.identity as BeanPoolIdentity;
    const me = ctx.identity.publicKey;
    return {
        me, myEdPrivHex: ctx.identity.privateKey,
        home: () => myHome(ctx),
        device: () => mailDevice(ctx.store),
        get: async (path) => answerOf(await signedGet(ctx.nodeUrl, path, identity, ctx.signal)),
        post: async (path, body) => answerOf(await signedPost(ctx.nodeUrl, path, body, identity, ctx.signal)),
        sign: (fields) => signRelayEnvelopeStatement(fields, ctx.identity.privateKey),
        load: async () => readGuestChats(await ctx.store.getMeta(chatsMeta(me))),
        save: (chats) => ctx.store.setMeta(chatsMeta(me), JSON.stringify(chats)),
        getMeta: (k) => ctx.store.getMeta(`${k}:${me}`),
        setMeta: (k, v) => ctx.store.setMeta(`${k}:${me}`, v),
        isBlocked: ctx.isBlocked,
        now: () => Date.now(),
        newId: newDmMessageId,
    };
}

/** Whether the community the phone is set to lets groups have guests (and so a member here be one elsewhere). */
export async function groupGuestsHere(nodeUrl: string): Promise<boolean> {
    const profile = (await getCachedNodeProfile(nodeUrl).catch(() => null)) ?? (await fetchNodeProfile(nodeUrl).catch(() => null));
    return groupGuestsOn(profile?.features);
}

/** The guest chats this account has on this phone (none with no community or no account). */
export async function loadGuestChats(): Promise<GuestChats> {
    const ctx = await outsideContext();
    return ctx ? guestIO(ctx).load().catch(() => ({})) : {};
}

let running: Promise<boolean> | null = null;

/** One round, never two at once; false when nothing was asked or it didn't finish (the next one starts afresh). */
export function syncGuestMailNow(): Promise<boolean> {
    if (running) return running;
    const round = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), GUEST_ROUND_MS);
        try {
            const ctx = await outsideContext();
            if (!ctx || !(await groupGuestsHere(ctx.nodeUrl))) return false;
            const out = await syncGuestMail(guestIO({ ...ctx, signal: controller.signal }));
            if (out.changed) DeviceEventEmitter.emit(GUEST_CHATS_UPDATED);
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
    DeviceEventEmitter.emit(GUEST_CHATS_UPDATED);
}

/** A line of mine in a guest chat: kept here at once (onKept), then sealed and sent. Throws with my server's words. */
export async function sendGuestLineNow(id: string, text: string): Promise<GuestLine | null> {
    const ctx = await outsideContext();
    if (!ctx) return null;
    try {
        return await sendGuestLine(guestIO(ctx), id, text);
    } finally {
        DeviceEventEmitter.emit(GUEST_CHATS_UPDATED);
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
        DeviceEventEmitter.emit(GUEST_CHATS_UPDATED);
    }
}

// ── The convenor's side: a group here ───────────────────────────────────────────────────────

export interface GroupGuest { key: string; home: string; name: string; state: 'invited' | 'in' | 'left' | 'removed' }

/** The group's guests as I may see them (a convenor: invited and in; a member: in), and whether guests are on here. */
export async function fetchGroupGuests(groupId: string, community?: string | null): Promise<{ guests: GroupGuest[]; on: boolean }> {
    const ctx = await outsideContext(community);
    if (!ctx) return { guests: [], on: false };
    const body = await answerOf(await signedGet(ctx.nodeUrl, `/api/groups/${encodeURIComponent(groupId)}/guests`, ctx.identity as BeanPoolIdentity));
    return { guests: Array.isArray(body?.guests) ? body.guests : [], on: body?.on === true };
}

/** A convenor adds someone from another community by their card. Throws OutsideMailError with the server's words. */
export async function inviteGroupGuest(groupId: string, card: AddressCard): Promise<GroupGuest> {
    const ctx = await outsideContext();
    if (!ctx) throw new OutsideMailError(0, '');
    const body = await answerOf(await signedPost(ctx.nodeUrl, `/api/groups/${encodeURIComponent(groupId)}/guests`, { card }, ctx.identity as BeanPoolIdentity));
    return body.guest as GroupGuest;
}

/**
 * A convenor removes a guest from the group's chat (one asked: their invitation withdrawn), once they confirmed. The host
 * tells the guest's community, and the chat closes on their phone. Throws OutsideMailError with the server's words.
 */
export async function removeGroupGuest(groupId: string, key: string): Promise<GroupGuest> {
    const ctx = await outsideContext();
    if (!ctx) throw new OutsideMailError(0, '');
    const path = `/api/groups/${encodeURIComponent(groupId)}/guests/${encodeURIComponent(key)}`;
    const body = await answerOf(await signedDelete(ctx.nodeUrl, path, ctx.identity as BeanPoolIdentity));
    // The chat's names are read again at its next opening: the one removed is named, never given a key.
    guestRowsMemo.delete(groupId);
    return body.guest as GroupGuest;
}

const guestRowsMemo = new Map<string, { at: number; rows: Promise<GuestNameRows> }>();
const NO_ROWS: GuestNameRows = { shown: [], named: [] };

/**
 * The guests a group's chat names lines by (core group-guest-names.ts; utils/group-line-display.ts nameSigner): `shown`, those
 * in the chat by the host's list read now, each by core's guest line ("Dax · hillside.example · guest"), never the card's
 * name alone; `named`, every other guest this phone kept a row for (they left, were removed, or the group's guests closed),
 * named on their old lines with "no longer in this group". Only `shown` may be given a key. Read at most once a minute.
 */
export function guestRosterRows(groupId: string, now = Date.now(), community?: string | null): Promise<GuestNameRows> {
    // `community` (slice S6): a group in place, its guests as its own community lists them, kept in that community's file.
    const memo = community ? `${community}\n${groupId}` : groupId;
    const kept = guestRowsMemo.get(memo);
    if (kept && now - kept.at < 60_000) return kept.rows;
    const rows = (async (): Promise<GuestNameRows> => {
        const ctx = await outsideContext(community).catch(() => null);
        if (!ctx) return NO_ROWS;
        const metaKey = `${GUEST_NAMES_META}:${groupId}:${ctx.identity.publicKey}`;
        const before = await ctx.store.getMeta(metaKey).catch(() => null);
        const listed = await fetchGroupGuests(groupId, community).then((g) => g.guests, () => null);
        const out = guestNameRows(before, listed, Date.now());
        if (out.json !== null) await ctx.store.setMeta(metaKey, out.json).catch(() => {});
        return { shown: out.shown, named: out.named };
    })().catch(() => NO_ROWS);
    guestRowsMemo.set(memo, { at: now, rows });
    return rows;
}
