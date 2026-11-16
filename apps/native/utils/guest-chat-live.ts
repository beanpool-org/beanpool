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
    answerGuestInvitation, guestNameLine, newDmMessageId, readGuestChats, sendGuestLine, syncGuestMail, type AddressCard, type GuestChats,
    type GuestLine, type GuestMailIO,
} from '@beanpool/core';
import { outsideContext } from './outside-chat-live';
import { OutsideMailError, answerOf, mailDevice, myHome, type OutsideMailContext } from './outside-mail';
import { signedGet, signedPost } from './node-post';
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

// ── The convenor's side: a group here ───────────────────────────────────────────────────────

export interface GroupGuest { key: string; home: string; name: string; state: 'invited' | 'in' | 'left' | 'removed' }

/** The group's guests as I may see them (a convenor: invited and in; a member: in), and whether guests are on here. */
export async function fetchGroupGuests(groupId: string): Promise<{ guests: GroupGuest[]; on: boolean }> {
    const ctx = await outsideContext();
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

const guestRowsMemo = new Map<string, { at: number; rows: Promise<Array<{ memberPubkey: string; callsign: string }>> }>();

/**
 * The guests in a group's chat as rows a member's chat names lines by (utils/group-line-display.ts nameSigner): each by core's
 * guest line, so a guest's line reads "Dax · hillside.example · guest", never the card's name alone. Read at most once a minute.
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
