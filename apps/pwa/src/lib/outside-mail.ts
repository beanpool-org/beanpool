/**
 * The browser's half of the mailbox between communities (messages across communities X4, the web side of the phone's X3:
 * scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.2 to §3.6). The server's half is X2 (apps/server/src/routes/
 * relay.ts); this browser only ever talks to its own community's server. The phone's utils/outside-mail.ts is the same
 * round, and this keeps what its three review rounds (#3168) fixed:
 *
 * - **A deadline on every round** ({@link syncOutsideMailNow}): every request carries the round's `signal`, and every other
 *   wait in it (this browser's store, the block list, the community's info, the account, a signature) is raced against it
 *   ({@link untilDeadline}); at the deadline the round answers null and lets go of all of them, and of the lock it holds
 *   across tabs, so one stalled wait never stops the rounds after it, here or in another tab.
 * - **A refused batch fails per line** (resendUnsent): my server takes a batch whole or refuses it at its first bad item, so
 *   a refused batch is sent again line by line and only the lines refused on their own fail, each with my server's words.
 *   A 403 (the switch off, a suspended member) fails them all. Anything else waits for the next round.
 * - **Write, then confirm; receipts owed before the confirm** (syncOutsideMail): each item fetched is checked here again,
 *   gated (core gateOutsideItem), written, and only then confirmed (which deletes it at the server); a write that fails
 *   is never confirmed. The receipt for a line written is owed in this browser before the confirm, and posted by this round
 *   or the next until my server takes it (flushReceipts), so no stop between the confirm and the receipt loses it.
 * - **Typed words never lost** ({@link sendFromBox}): the box empties only once the line is kept here.
 *
 * **Each device for itself** (X2b: scratch/fable-design/decisions/DECISION-outside-door.md; the phone's X2b, the same
 * behaviour). This browser names itself to its server by a random id kept in its outside-chat store, per community and
 * account ({@link mailDevice}; @beanpool/core newOutsideDeviceId): `GET /api/mail?device=` serves what this browser has not
 * confirmed, and `POST /api/mail/confirm { ids, device }` marks this browser's. The server deletes an item once every device
 * of the account has confirmed it, so a confirm here, of a line written or of one dropped (this browser's door closed, say),
 * never takes it from another phone or browser whose door is open. At Sign Out the id is read before the store goes and the
 * server is asked to forget it ({@link forgetThisBrowserForMail}, 4 s at most, never a reason Sign Out stops).
 *
 * **Ticks before gating.** The same fetch carries what became of my own items (paged by time and id from the cursor kept
 * here). They are applied before any held item is judged, every page of them: a chat I wrote to opens here first, so its
 * lines are never judged as a stranger's. A tick for a line this browser doesn't have (a browser newly signed in, or a line
 * I wrote on another device) opens that chat here: brought back empty and marked restored when this browser has none, and
 * opened from a request or a decline when it has one; never one with someone the account blocked.
 *
 * **Only for the account and the community it started for** (#3183 round 4). A round takes the account epoch
 * (lib/account-epoch.ts, as every store of account state here does) and the community the web app talks to before it reads
 * anything ({@link outsideContext}). Sign Out, the delete at the last community, the delete at a community the web app was
 * pointed at, and a move to another community (Settings' node address, here or in another tab) each end one of them: the
 * round is aborted when this page hears it, and every store call and every request checks first, so a page that missed
 * the news still stops. After that the round drops nothing, confirms nothing, writes nothing (into the old documents or a
 * fresh database), makes no new mail id and asks nothing. What this browser keeps is per community and per account
 * (lib/outside-chat-store.ts), as the phone keeps it in each community's own file: the kept home among it, read again
 * whenever it was kept for another address, so this browser never signs as a community it no longer talks to.
 */
import {
    ADDRESS_CARD_NAME_MAX, OUTSIDE_DEVICE_ID, addressCardName, addressCardVerifies, audienceOf, gateOutsideItem, isOutsideChangeKind, newDmMessageId, newOutsideDeviceId,
    nodeHomeOf, openOutsideChange, openOutsideLine, outsideChangeVerdict, outsideLineShown, outsideReceiptPayload, readRelayEnvelope, relayConversationId,
    relayEnvelopeVerifies, relayPayloadHash, sealOutsideChange, sealOutsideLine, t, type AddressCard, type OutsideChange, type OutsideChangeKind, type RelayEnvelope,
    type RelayEnvelopeFields, type RelayItem,
} from '@beanpool/core';
import { nodeAddress, signAddressCardFor, signedMailFetch, signRelayEnvelopeFor } from './api';
import { accountEpoch, accountEpochHolds, onAccountEpochEnd } from './account-epoch';
import { communityInfoOnce } from './visitor-lobby-gate';
import { getBlocklistStatus, isUserBlocked, loadBlocklist } from './blocklist';
import { loadIdentity, type BeanPoolIdentity } from './identity';
import { outsideChatStore, outsideCommunityOf, type OutsideChat, type OutsideChatStore, type OutsideLineState } from './outside-chat-store';

export const DOOR_META = 'door';
export const CURSOR_META = 'outbox-cursor';
/** This browser's mail id for the account at a community (X2b): made at its first round there, kept with its chats, gone with them. */
export const DEVICE_META = 'device';
const HOME_META = 'home';
const HOME_FRESH_MS = 60 * 60_000;
const PAGES_MAX = 10;
const RESEND_WITHIN_MS = 6 * 24 * 60 * 60_000;
/** A receipt stays owed while its sender's server keeps its line's row (relay-outbox.ts OUTBOX_KEPT_MS). */
const RECEIPT_KEPT_MS = 30 * 24 * 60 * 60_000;
const RECEIPT_IDS_MAX = 50;
const RECEIPTS_PER_TURN = 200;
const STATES: readonly OutsideLineState[] = ['queued', 'sent', 'delivered', 'failed', 'expired'];

/** Rung after a round that changed anything here: the Messages page reads its outside chats again. */
export const OUTSIDE_CHATS_EVENT = 'beanpool-outside-chats';

export interface OutsideMailContext {
    nodeUrl: string;
    identity: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey' | 'callsign'>;
    store: OutsideChatStore;
    /** Whether the account blocked this key. Throws when that can't be known: the item then waits, unconfirmed. */
    isBlocked: (key: string) => Promise<boolean>;
    signal?: AbortSignal;
    /**
     * Whether this still acts for the account and the community it was made for ({@link outsideContext}): false once the
     * account epoch has ended (Sign Out, a delete, a clear) or the web app talks to another community. Checked before every
     * store call and every request; none is made once it answers false.
     */
    holds?: () => boolean;
}

/** A thrown answer from my server, with its own words when it sent any. */
export class OutsideMailError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
        super(message);
        this.name = 'OutsideMailError';
    }
}

/** My server said no for good: a 4xx but 401 (a clock that is off), 408, 425 or 429 (try later). */
export function refusedForGood(e: unknown): e is OutsideMailError {
    return e instanceof OutsideMailError && e.status >= 400 && e.status < 500 && ![401, 408, 425, 429].includes(e.status);
}

function refusalWords(e: OutsideMailError): string {
    return e.message && !/^HTTP \d+$/.test(e.message) ? e.message : t('Your community refused this message.');
}

async function answerOf(res: Response): Promise<any> {
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new OutsideMailError(res.status, typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`, body?.code);
    return body;
}

const ranOut = () => Object.assign(new Error('This round ran out of time.'), { name: 'AbortError' });
const leftHere = () => Object.assign(new Error('This round no longer acts for this account here.'), { name: 'AbortError' });

/** Why `ctx` may do nothing more (its deadline, or its account or community gone), or null while it may. */
function stopOf(ctx: Pick<OutsideMailContext, 'signal' | 'holds'>): Error | null {
    if (ctx.signal?.aborted) return ranOut();
    return ctx.holds && !ctx.holds() ? leftHere() : null;
}

/**
 * `p`'s answer, or the round's AbortError the moment `signal` aborts (at once when it has): a wait the deadline ends, whatever
 * `p` itself waits on. What `p` was doing carries on unheard; nothing here waits for it any more.
 */
function untilDeadline<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return p;
    if (signal.aborted) {
        p.catch(() => {});
        return Promise.reject(ranOut());
    }
    return new Promise<T>((resolve, reject) => {
        const stop = () => reject(ranOut());
        signal.addEventListener('abort', stop, { once: true });
        p.then((v) => { signal.removeEventListener('abort', stop); resolve(v); }, (e) => { signal.removeEventListener('abort', stop); reject(e); });
    });
}

/**
 * `ctx` with every wait that carries no signal of its own bounded by its `signal`: each read and write of its store and its
 * block check, none of them started once the signal has aborted or `holds` answers false. A write let go at the deadline
 * may still land; every write here is one transaction and can be made again, and an item is confirmed only after its write
 * answered.
 */
function boundedBySignal(ctx: OutsideMailContext): OutsideMailContext {
    const signal = ctx.signal;
    if (!signal && !ctx.holds) return ctx;
    const bound = <A extends unknown[], R>(run: (...a: A) => Promise<R>) => (...a: A): Promise<R> => {
        const stop = stopOf(ctx);
        return stop ? Promise.reject(stop) : untilDeadline(run(...a), signal);
    };
    const store = Object.fromEntries(Object.entries(ctx.store).map(([k, v]) =>
        [k, typeof v === 'function' ? bound((...a: unknown[]) => (v as (...a: unknown[]) => Promise<unknown>).apply(ctx.store, a)) : v]));
    return { ...ctx, store: store as OutsideChatStore, isBlocked: bound(ctx.isBlocked) };
}

/**
 * A request my server is asked with the round's signal; none is started once the round has run out of time, or no longer
 * acts for its account and community.
 */
const mailFetch = (ctx: OutsideMailContext, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const stop = stopOf(ctx);
    if (stop) return Promise.reject(stop);
    return signedMailFetch(method, ctx.nodeUrl, path, body, ctx.identity as BeanPoolIdentity, ctx.signal);
};
const get = async (ctx: OutsideMailContext, path: string) => answerOf(await mailFetch(ctx, 'GET', path));
const post = async (ctx: OutsideMailContext, path: string, body: unknown) => answerOf(await mailFetch(ctx, 'POST', path, body));

/**
 * This community's home as other servers name it (its primary address, on the port this browser reaches it at when the two
 * hosts agree), read again after an hour so a community that moved signs as its new home. Null while it knows none. Kept
 * with the address it was read for (`<home> <when> <community>`), in that community's own documents: a home kept for
 * another address is never this one's, and is read again (#3183 round 4: "the browser signs as the old community").
 */
export async function myHome(ctx: Pick<OutsideMailContext, 'nodeUrl' | 'store' | 'signal' | 'identity' | 'holds'>, now = Date.now()): Promise<string | null> {
    const me = ctx.identity.publicKey;
    const here = outsideCommunityOf(ctx.nodeUrl);
    const [keptHome, keptAt, keptFor] = (await ctx.store.getMeta(me, HOME_META))?.split(' ') ?? [];
    const kept = keptHome && keptFor === here ? keptHome : null;
    if (kept && now - Number(keptAt) < HOME_FRESH_MS) return kept;
    const stop = stopOf(ctx);
    if (stop) throw stop;
    let primary: string | null = null;
    try {
        const res = await fetch(`${ctx.nodeUrl.replace(/\/+$/, '')}/api/community/info`, { cache: 'no-store', ...(ctx.signal ? { signal: ctx.signal } : {}) });
        const info: any = res.ok ? await res.json().catch(() => null) : null;
        primary = typeof info?.primaryAddress === 'string' ? info.primaryAddress : null;
    } catch {
        primary = null;
    }
    if (!primary) return kept;
    const reached = nodeHomeOf(ctx.nodeUrl);
    const home = reached && audienceOf(reached) === audienceOf(primary) ? reached : nodeHomeOf(primary);
    if (home) await ctx.store.setMeta(me, HOME_META, `${home} ${now} ${here}`);
    return home;
}

/** My card, signed now, under the name I use here; null while my community knows none of its names. */
export async function myAddressCard(ctx: OutsideMailContext): Promise<AddressCard | null> {
    const home = await myHome(ctx);
    if (!home) return null;
    const name = addressCardName(String(ctx.identity.callsign ?? '').replace(/\s+/g, ' ').trim().slice(0, ADDRESS_CARD_NAME_MAX)) ?? '…';
    return signAddressCardFor({ key: ctx.identity.publicKey, home, name }, ctx.identity as BeanPoolIdentity);
}

/**
 * The chats the Messages page may list (pages/MessagesPage.tsx: its open rows and the requests behind its one row): none with
 * someone the account blocked, whatever state their chat is in here (blocked from another screen or device, or before this
 * browser had the chat). Their chat stays as it is in the store: unblocked, it shows again. The phone's chatsShown.
 */
export async function chatsShown(ctx: Pick<OutsideMailContext, 'identity' | 'store' | 'isBlocked'>): Promise<OutsideChat[]> {
    const shown: OutsideChat[] = [];
    for (const c of await ctx.store.chats(ctx.identity.publicKey)) if (!(await ctx.isBlocked(c.peerKey))) shown.push(c);
    return shown;
}

/**
 * A chat begun from someone's card (components/AddressCardPanel.tsx): opened here, a declined one too, and its id. Null, with
 * nothing changed, when the account blocked them. The phone's openChatFromCard.
 */
export async function openChatFromCard(ctx: Pick<OutsideMailContext, 'identity' | 'store' | 'isBlocked'>, card: Pick<AddressCard, 'key' | 'home' | 'name'>): Promise<string | null> {
    if (await ctx.isBlocked(card.key)) return null;
    const chatId = relayConversationId(ctx.identity.publicKey, card.key);
    await ctx.store.openChat(ctx.identity.publicKey, chatId, { key: card.key, home: card.home, name: card.name });
    return chatId;
}

export async function doorOpen(ctx: Pick<OutsideMailContext, 'store' | 'identity'>): Promise<boolean> {
    return (await ctx.store.getMeta(ctx.identity.publicKey, DOOR_META)) === 'open';
}

export async function setDoor(ctx: Pick<OutsideMailContext, 'store' | 'identity'>, open: boolean): Promise<void> {
    await ctx.store.setMeta(ctx.identity.publicKey, DOOR_META, open ? 'open' : 'closed');
}

// ── Finding someone in another community by name (N1, @beanpool/core find-by-name.ts; the phone's utils/outside-mail.ts) ──

/** Whether people in other communities can find me by name: my community's switch, the same on every device. */
export async function findMeOn(ctx: OutsideMailContext): Promise<boolean> {
    return (await get(ctx, '/api/find/me'))?.findable === true;
}

/** The switch on (my community is handed my card, signed now) or off; what it is now. Throws OutsideMailError. */
export async function setFindMe(ctx: OutsideMailContext, on: boolean): Promise<boolean> {
    const card = on ? await myAddressCard(ctx) : null;
    if (on && !card) throw new OutsideMailError(503, t("This community's server knows none of its own names yet, so it can't send to another community."), 'no_home');
    return (await post(ctx, '/api/find/me', on ? { on, card } : { on }))?.findable === true;
}

/** The card of whoever uses `name` at the community at `home`, or null for the one "nobody". Throws OutsideMailError with my server's words. */
export async function findByName(ctx: OutsideMailContext, home: string, name: string): Promise<AddressCard | null> {
    const answer = await post(ctx, '/api/find/name', { home, name });
    return answer?.found === true && addressCardVerifies(answer.card) ? answer.card : null;
}

/**
 * This browser's mail id for the account at the store's community, made and kept the first time it is asked for, in one
 * transaction (two tabs get one id). Every fetch and confirm names it.
 */
export function mailDevice(ctx: Pick<OutsideMailContext, 'store' | 'identity'>): Promise<string> {
    return ctx.store.metaOrMake(ctx.identity.publicKey, DEVICE_META, (v) => OUTSIDE_DEVICE_ID.test(v), newOutsideDeviceId);
}

/** This browser's mail id for the account when it has one (it has run a round), else null. Never makes one. */
export async function mailDeviceIfAny(ctx: Pick<OutsideMailContext, 'store' | 'identity'>): Promise<string | null> {
    const kept = await ctx.store.getMeta(ctx.identity.publicKey, DEVICE_META);
    return kept && OUTSIDE_DEVICE_ID.test(kept) ? kept : null;
}

/**
 * My server forgets `device`, this browser's mail id (`POST /api/mail/device/forget`): it holds no more mail for it, and
 * what every other device of the account has goes there. Throws as any request here does.
 */
export async function forgetMailDevice(ctx: Pick<OutsideMailContext, 'nodeUrl' | 'identity' | 'signal'>, device: string): Promise<void> {
    await post(ctx as OutsideMailContext, '/api/mail/device/forget', { device });
}

/** How long Sign Out lets its community take this browser's forget: the phone's 4 s. */
export const FORGET_DEVICE_MS = 4_000;

/**
 * At Sign Out, before the account's storage leaves this browser: this browser's mail id is read now, while `store` still
 * holds it, and my server is asked to forget it ({@link forgetMailDevice}), signed with the key still here. Resolves once
 * the id is read, with `done`, which settles when the request has, or at `budgetMs` (the request aborted then), whichever
 * is first, even if a fetch never gives up; a read of the store that stalls is let go at `budgetMs` too. Never throws,
 * never rejects: a community that doesn't answer lets this browser lapse after 7 days unseen.
 */
export async function forgetThisBrowserForMail(
    ctx: Pick<OutsideMailContext, 'nodeUrl' | 'identity' | 'store'>, budgetMs = FORGET_DEVICE_MS,
): Promise<{ done: Promise<void> }> {
    const warn = (e: unknown) => console.warn('[OutsideMail] This browser was not forgotten at Sign Out; it lapses after 7 days:', (e as Error)?.message ?? e);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, budgetMs); });
    try {
        const device = await Promise.race([mailDeviceIfAny(ctx), budget]);
        if (!device) {
            clearTimeout(timer);
            return { done: Promise.resolve() };
        }
        const asked = forgetMailDevice({ nodeUrl: ctx.nodeUrl, identity: ctx.identity, signal: controller.signal }, device).catch(warn);
        return { done: Promise.race([asked, budget]).then(() => {}).finally(() => clearTimeout(timer)) };
    } catch (e) {
        clearTimeout(timer);
        warn(e);
        return { done: Promise.resolve() };
    }
}

/** Sign Out's call (SettingsPage): {@link forgetThisBrowserForMail} for the community this web app talks to, its mail id there. */
export function forgetThisBrowserAtSignOut(identity: OutsideMailContext['identity']): Promise<{ done: Promise<void> }> {
    const nodeUrl = nodeAddress().replace(/\/+$/, '');
    return forgetThisBrowserForMail({ nodeUrl, identity, store: outsideChatStore(nodeUrl) });
}

async function envelopeFor(ctx: OutsideMailContext, fields: Omit<RelayEnvelopeFields, 'senderKey' | 'senderHome' | 'payloadHash'>, payload: string): Promise<RelayEnvelope> {
    const home = await myHome(ctx);
    if (!home) throw new OutsideMailError(503, t("This community's server knows none of its own names yet, so it can't send to another community."), 'no_home');
    const stop = stopOf(ctx);
    if (stop) throw stop;
    return untilDeadline(signRelayEnvelopeFor({ ...fields, senderKey: ctx.identity.publicKey, senderHome: home, payloadHash: relayPayloadHash(payload) }, ctx.identity as BeanPoolIdentity), ctx.signal);
}

async function postItems(ctx: OutsideMailContext, items: RelayItem[]): Promise<Array<{ itemId: string; state: string }>> {
    const answer = await post(ctx, '/api/mail/send', { items });
    return Array.isArray(answer?.items) ? answer.items : [];
}

/**
 * Send `text` in open chat `chatId`: written first as `sending` (then `onKept`), then the state my server answers. Throws
 * OutsideMailError with my server's words when it refuses (the line is then `failed`). A throw before `onKept`: nothing kept.
 */
export async function sendOutsideLine(ctx: OutsideMailContext, chatId: string, text: string, onKept?: () => void): Promise<OutsideLineState> {
    const me = ctx.identity.publicKey;
    const chat = await ctx.store.chat(me, chatId);
    if (!chat || chat.state !== 'open') throw new OutsideMailError(400, t('Accept the request first.'), 'not_accepted');
    const messageId = newDmMessageId();
    const payload = sealOutsideLine({ text, name: ctx.identity.callsign, myEdPrivHex: ctx.identity.privateKey, myKey: me, peerKey: chat.peerKey, messageId });
    const at = Date.now();
    const envelope = await envelopeFor(ctx, { kind: 'dm-line', itemId: messageId, recipient: chat.peerKey, recipientHome: chat.peerHome, at }, payload);
    await ctx.store.addMine(me, { id: messageId, chatId, author: me, text, replyTo: null, at, item: JSON.stringify({ envelope, payload }) });
    onKept?.();
    let answered: Array<{ itemId: string; state: string }>;
    try {
        answered = await postItems(ctx, [{ envelope, payload }]);
    } catch (e) {
        if (refusedForGood(e)) await ctx.store.setMineState(me, chatId, messageId, 'failed', refusalWords(e));
        throw e;
    }
    const state = answered.find((a) => a.itemId === messageId)?.state as OutsideLineState | undefined;
    if (state && STATES.includes(state)) await ctx.store.setMineState(me, chatId, messageId, state);
    return state && STATES.includes(state) ? state : 'sending';
}

/**
 * A change to a line of chat `chatId` (X6): an edit or a delete of a line of mine, or my reaction to any line ('' takes it
 * back). Applied here at once (kept `sending` with its signed item), then sent; one my server never answered goes again at
 * the next round. Throws OutsideMailError with my server's words when it refuses it for good, or "Not delivered" when it
 * answers the change failed at once. A change that fails, now or in any later round (a resend refused or failed, ageing
 * out, the switch read off, a tick from my server's outbox), is taken back (outside-chat-store.ts answerChange): the line
 * reads as its last change that reached them. A delete stops whatever of its line has not left this browser (stopUnsentOf).
 * The phone's sendOutsideChange, the same rule.
 */
export async function sendOutsideChange(ctx: OutsideMailContext, chatId: string, c: { kind: OutsideChangeKind; lineId: string; text?: string; emoji?: string }): Promise<void> {
    const me = ctx.identity.publicKey;
    const chat = await ctx.store.chat(me, chatId);
    const line = await ctx.store.lineOf(me, chatId, c.lineId);
    if (!chat || chat.state !== 'open') throw new OutsideMailError(400, t('Accept the request first.'), 'not_accepted');
    // Deleted as the chat shows it: a delete of mine still on its way counts.
    const deleted = !!line && outsideLineShown({ id: c.lineId, author: line.author, text: '' }, await ctx.store.changes(me, chatId), me).deleted;
    if (!line || line.chatId !== chatId || deleted || (c.kind !== 'dm-reaction' && line.author !== me)) {
        throw new OutsideMailError(400, t('That did not go through. Please try again.'), 'not_yours');
    }
    const itemId = newDmMessageId();
    const payload = sealOutsideChange({ ...c, myEdPrivHex: ctx.identity.privateKey, myKey: me, peerKey: chat.peerKey, itemId });
    const at = Date.now();
    const envelope = await envelopeFor(ctx, { kind: c.kind, itemId, recipient: chat.peerKey, recipientHome: chat.peerHome, at }, payload);
    const change: OutsideChange = { kind: c.kind, itemId, lineId: c.lineId, author: me, at, ...(c.text !== undefined ? { text: c.text } : {}), ...(c.emoji !== undefined ? { emoji: c.emoji } : {}) };
    await ctx.store.putChange(me, chatId, change, JSON.stringify({ envelope, payload }));
    if (c.kind === 'dm-delete') await ctx.store.stopUnsentOf(me, chatId, c.lineId);
    let state: string | undefined;
    try {
        state = (await postItems(ctx, [{ envelope, payload }])).find((a) => a.itemId === itemId)?.state;
    } catch (e) {
        if (refusedForGood(e)) await ctx.store.answerChange(me, chatId, itemId, 'failed');
        throw e;
    }
    if (state) await ctx.store.answerChange(me, chatId, itemId, state);
    // Failed at once (the other community refused it inside its answer): it never reached them, and was taken back above.
    if (state === 'failed') throw new OutsideMailError(400, t('Not delivered'), 'not_delivered');
}

/**
 * A line sent from a box on screen, the typed words never lost: `onKept` (empty the box) runs once the line is kept here,
 * never before. Its own deadline, `budgetMs`: a kept line my server hasn't answered by then stays `sending`, for the next round.
 */
export async function sendFromBox(ctx: OutsideMailContext, chatId: string, words: string, budgetMs: number, onKept: () => void): Promise<{ kept: boolean; error: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let kept = false;
    try {
        await sendOutsideLine({ ...ctx, signal: controller.signal }, chatId, words, () => { kept = true; onKept(); });
        return { kept, error: null };
    } catch (error) {
        return { kept, error };
    } finally {
        clearTimeout(timer);
    }
}

async function resendUnsent(ctx: OutsideMailContext, now: number): Promise<void> {
    const me = ctx.identity.publicKey;
    const unsent = await ctx.store.unsent(me);
    const fresh = unsent.filter((u) => now - u.at < RESEND_WITHIN_MS);
    for (const u of unsent) if (now - u.at >= RESEND_WITHIN_MS) await ctx.store.setMineState(me, u.chatId, u.id, 'failed');
    if (!fresh.length) return;
    const chatOf = new Map(fresh.map((u) => [u.id, u.chatId]));
    const apply = async (answered: Array<{ itemId: string; state: string }>) => {
        for (const a of answered) {
            const chatId = chatOf.get(a.itemId);
            if (chatId && STATES.includes(a.state as OutsideLineState)) await ctx.store.setMineState(me, chatId, a.itemId, a.state as OutsideLineState);
        }
    };
    try {
        await apply(await postItems(ctx, fresh.map((u) => JSON.parse(u.item) as RelayItem)));
        return;
    } catch (e) {
        if (!refusedForGood(e)) throw e;
        if (e.status === 403 || fresh.length === 1) {
            for (const u of fresh) await ctx.store.setMineState(me, u.chatId, u.id, 'failed', refusalWords(e));
            return;
        }
    }
    for (const [i, u] of fresh.entries()) {
        try {
            await apply(await postItems(ctx, [JSON.parse(u.item) as RelayItem]));
        } catch (e) {
            if (!refusedForGood(e)) throw e;
            // A 403 is never one line's fault: the rest fail with it, unasked.
            for (const f of e.status === 403 ? fresh.slice(i) : [u]) await ctx.store.setMineState(me, f.chatId, f.id, 'failed', refusalWords(e));
            if (e.status === 403) return;
        }
    }
}

/** Every line of mine still `sending` fails with `words`: this browser reads its community's switch off, so none will go. */
export async function failUnsent(ctx: Pick<OutsideMailContext, 'identity' | 'store'>, words: string): Promise<number> {
    const me = ctx.identity.publicKey;
    const seen = new Set<string>();
    for (;;) {
        const unsent = (await ctx.store.unsent(me)).filter((u) => !seen.has(u.id));
        if (!unsent.length) return seen.size;
        for (const u of unsent) {
            seen.add(u.id);
            await ctx.store.setMineState(me, u.chatId, u.id, 'failed', words);
        }
    }
}

/** `changes`: changes to lines (X6) applied here. */
export interface SyncOutcome { written: number; changes: number; requests: number; dropped: number; confirmed: number; ticks: number }

/**
 * One round: unsent lines sent again, then my items' ticks applied (every page of them first), then what waits for this
 * browser fetched, checked, gated, written, receipt owed, confirmed and receipted. Throws only when my server can't be read;
 * a write that fails leaves its item unconfirmed.
 */
export async function syncOutsideMail(ctx: OutsideMailContext, now = Date.now()): Promise<SyncOutcome> {
    const out: SyncOutcome = { written: 0, changes: 0, requests: 0, dropped: 0, confirmed: 0, ticks: 0 };
    const me = ctx.identity.publicKey;
    await resendUnsent(ctx, now).catch((e) => console.warn('[OutsideMail] Unsent lines wait for the next round:', e?.message ?? e));
    const open = await doorOpen(ctx);
    const device = await mailDevice(ctx);
    const tried = new Set<string>();
    const owe = (env: RelayEnvelope) => ctx.store.oweReceipt(me, { id: env.itemId, key: env.senderKey, home: env.senderHome }, now);
    for (let page = 0; page < PAGES_MAX; page++) {
        const stop = stopOf(ctx);
        if (stop) throw stop;
        const cursor = (await ctx.store.getMeta(me, CURSOR_META)) ?? '0:';
        const [since, sinceId] = [cursor.slice(0, cursor.indexOf(':')), cursor.slice(cursor.indexOf(':') + 1)];
        const answer = await get(ctx, `/api/mail?device=${encodeURIComponent(device)}&since=${encodeURIComponent(since)}&sinceId=${encodeURIComponent(sinceId)}`);
        // My own items' ticks before any held item is judged: a chat I wrote to (before this browser was signed in, or from
        // another device) opens here first. While more ticks wait, this page's items are left: unconfirmed, they come again
        // with the next page, and are judged once every tick is in.
        out.ticks += await applyTicks(ctx, Array.isArray(answer?.outbox) ? answer.outbox : [], now);
        if (answer?.outboxMore) continue;
        const held: any[] = Array.isArray(answer?.items) ? answer.items : [];
        const done: string[] = [];
        let writeFailed = false;
        for (const h of held) {
            const env = readRelayEnvelope(h?.envelope);
            if (!env) continue;
            // Checked here again: the server holding it could have been anyone's. Not mine, or not its sender's: dropped.
            const payloadOk = typeof h.payload === 'string' ? relayPayloadHash(h.payload) === env.payloadHash : env.kind === 'dm-blob';
            if (env.recipient !== me || !relayEnvelopeVerifies(env) || !payloadOk) { done.push(env.itemId); out.dropped++; continue; }
            try {
                const chatId = relayConversationId(me, env.senderKey);
                if (env.kind === 'dm-line' && await ctx.store.hasLine(me, chatId, env.itemId)) {
                    await owe(env);   // written before, not confirmed: its receipt owed (once), then confirmed
                    done.push(env.itemId);
                    continue;
                }
                const chat = await ctx.store.chat(me, chatId);
                const verdict = gateOutsideItem({
                    kind: env.kind,
                    chat: chat ? { state: chat.state, theirLines: await ctx.store.theirLines(me, chatId, env.senderKey) } : null,
                    doorOpen: open,
                    blocked: await ctx.isBlocked(env.senderKey),
                });
                if (verdict === 'drop') { done.push(env.itemId); out.dropped++; continue; }
                if (verdict === 'change') {
                    // A change to a line (X6), judged by core's one rule: applied, or dropped here; confirmed either way.
                    let change: OutsideChange | null = null;
                    try { change = openOutsideChange(h.payload, env, { key: me, edPrivHex: ctx.identity.privateKey }); } catch { /* not its sender's */ }
                    const judged = change && outsideChangeVerdict({ change, gate: verdict, chatId, line: await ctx.store.lineOf(me, chatId, change.lineId) });
                    if (change && judged === 'apply') {
                        await ctx.store.putChange(me, chatId, change);
                        // Their delete stops what of mine for that line has not left this browser (a reaction): it would change nothing there.
                        if (change.kind === 'dm-delete') await ctx.store.stopUnsentOf(me, chatId, change.lineId);
                        out.changes++;
                    } else out.dropped++;
                    done.push(env.itemId);
                    continue;
                }
                let opened;
                try {
                    opened = openOutsideLine(h.payload, env, { key: me, edPrivHex: ctx.identity.privateKey });
                } catch {
                    done.push(env.itemId); out.dropped++; continue;
                }
                await ctx.store.writeTheirs(me, { id: env.itemId, chatId, author: env.senderKey, text: opened.text, replyTo: opened.replyToId, at: env.at },
                    { home: env.senderHome, name: opened.name }, verdict, now);
                await owe(env);   // past the gate only a line is written: its receipt owed before it is confirmed
                done.push(env.itemId);
                if (verdict === 'request') out.requests++; else out.written++;
            } catch (e) {
                // The write (or its receipt's) failed, or a block couldn't be read: not confirmed, fetched again; the rest wait.
                console.warn('[OutsideMail] An item could not be written here; it waits at the server:', (e as Error)?.message ?? e);
                writeFailed = true;
                break;
            }
        }
        if (done.length) out.confirmed += Number((await post(ctx, '/api/mail/confirm', { ids: done, device }))?.confirmed) || 0;
        // This page's receipts, and any an earlier round didn't get to post.
        await flushReceipts(ctx, now, tried);
        if (writeFailed || !answer?.more) break;
    }
    return out;
}

/** The receipts owed, each sender's to their home, 50 ids a receipt; one my server doesn't take stays owed, behind the rest. */
async function flushReceipts(ctx: OutsideMailContext, now: number, tried: Set<string>): Promise<void> {
    const me = ctx.identity.publicKey;
    await ctx.store.forgetReceiptsOwedBefore(me, now - RECEIPT_KEPT_MS);
    const bySender = new Map<string, { home: string; key: string; ids: string[] }>();
    for (const o of await ctx.store.owedReceipts(me, RECEIPTS_PER_TURN)) {
        if (tried.has(o.id)) continue;
        const r = bySender.get(`${o.key}@${o.home}`) ?? { home: o.home, key: o.key, ids: [] };
        r.ids.push(o.id);
        bySender.set(`${o.key}@${o.home}`, r);
    }
    for (const r of bySender.values()) {
        for (let i = 0; i < r.ids.length; i += RECEIPT_IDS_MAX) {
            if (stopOf(ctx)) return;
            const ids = r.ids.slice(i, i + RECEIPT_IDS_MAX);
            try {
                const payload = outsideReceiptPayload(ids);
                const envelope = await envelopeFor(ctx, { kind: 'receipt', itemId: newDmMessageId(), recipient: r.key, recipientHome: r.home, at: now }, payload);
                await postItems(ctx, [{ envelope, payload }]);
                await ctx.store.receiptsSent(me, ids);
            } catch (e) {
                console.warn('[OutsideMail] A receipt waits for the next round:', (e as Error)?.message ?? e);
                for (const id of ids) tried.add(id);
                await ctx.store.receiptsTried(me, ids, now).catch(() => {});
            }
        }
    }
}

/**
 * My items' ticks: each line's state; for a line this browser lacks, its chat opened here (brought back empty, or from a
 * request or a decline: outside-chat-store.ts noteRestored), unless the account blocked them; the cursor moved past them.
 * Counts what changed here.
 */
async function applyTicks(ctx: OutsideMailContext, ticks: any[], now: number): Promise<number> {
    const me = ctx.identity.publicKey;
    let applied = 0;
    let last: { at: number; itemId: string } | null = null;
    for (const tick of ticks) {
        if (typeof tick?.itemId !== 'string' || !Number.isSafeInteger(tick?.at)) continue;
        last = { at: tick.at, itemId: tick.itemId };
        if (typeof tick.recipient !== 'string' || !/^[0-9a-f]{64}$/.test(tick.recipient) || tick.recipient === me) continue;
        const chatId = relayConversationId(me, tick.recipient);
        // A change of mine (X6): failed at their community, it is taken back here; at their community, it stays.
        if (isOutsideChangeKind(tick.kind)) { if (await ctx.store.answerChange(me, chatId, tick.itemId, tick.state)) applied++; continue; }
        if (tick.kind !== 'dm-line' || !STATES.includes(tick.state)) continue;
        if (await ctx.store.hasLine(me, chatId, tick.itemId)) {
            await ctx.store.setMineState(me, chatId, tick.itemId, tick.state);
            applied++;
        } else if (typeof tick.recipientHome === 'string'
            // A block is the account's: a line I wrote them before it (on any device) never makes, nor reopens, their chat here.
            && !(await ctx.isBlocked(tick.recipient))) {
            if (await ctx.store.noteRestored(me, chatId, { key: tick.recipient, home: tick.recipientHome }, now)) applied++;
        }
    }
    if (last) await ctx.store.setMeta(me, CURSOR_META, `${last.at}:${last.itemId}`);
    return applied;
}

// ─── The round, as the Messages page runs it ─────────────────────────────────────────────────

/** A round's deadline: well over a healthy one (a page, its confirm, a receipt to each sender, each forwarded up to 10 s). */
export const OUTSIDE_ROUND_MS = 45_000;
/** Past the deadline, how long a round waits for the browser to hand back the lock before it answers anyway. */
const LOCK_GRACE_MS = 1_000;
const ROUND_LOCK = 'beanpool-outside-mail';
/** How long a send from the box waits for my server before its line is left `sending`, for the next round. */
export const OUTSIDE_SEND_MS = 20_000;

/** Whether the account blocked `key`, the list read from my server first when this page hasn't yet: never guessed. */
async function blockedHere(key: string): Promise<boolean> {
    if (!getBlocklistStatus().loaded) await loadBlocklist();
    return isUserBlocked(key);
}

/** Where this page stands, taken before anything is read: the community the web app talks to, under the account epoch now. */
export interface Standing { nodeUrl: string; holds: () => boolean }

function standingNow(): Standing {
    const nodeUrl = nodeAddress().replace(/\/+$/, '');
    const community = outsideCommunityOf(nodeUrl);
    const epoch = accountEpoch();
    return { nodeUrl, holds: () => accountEpochHolds(epoch) && outsideCommunityOf(nodeAddress()) === community };
}

/**
 * The context for the community this web app talks to, or null with no account in this browser. Where it stands is taken
 * first (`here`), so it acts only for that account at that community: its `holds`, and its store's, answer false once the
 * account epoch ends or the web app talks to another community.
 */
export async function outsideContext(here: Standing = standingNow()): Promise<OutsideMailContext | null> {
    const identity = await loadIdentity().catch(() => null);
    if (!identity?.privateKey || !here.holds()) return null;
    return { nodeUrl: here.nodeUrl, identity, store: outsideChatStore(here.nodeUrl, here.holds), isBlocked: blockedHere, holds: here.holds };
}

/**
 * `check` run whenever this page hears that where it stands may have moved: an end of the account epoch (lib/account-epoch.ts,
 * its own or another tab's), or another tab's change to what this web address keeps (its node address among it). Returns
 * the stop.
 */
function watchStanding(check: () => unknown): () => void {
    const offEpoch = onAccountEpochEnd(() => { check(); });
    const onStorage = () => { check(); };
    try { if (typeof window !== 'undefined') window.addEventListener('storage', onStorage); } catch { /* every call still checks */ }
    return () => {
        offEpoch();
        try { if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage); } catch { /* not added */ }
    };
}

/** Whether this community takes messages from other communities (its info's `features.outsideMessages`); null unread. */
export async function outsideMessagesHere(): Promise<boolean | null> {
    const info = await communityInfoOnce().catch(() => null);
    return info ? (info.features as { outsideMessages?: unknown } | undefined)?.outsideMessages === true : null;
}

let running: Promise<SyncOutcome | null> | null = null;

/**
 * One round, never two at once in this tab (nor in two tabs, where the browser can say: navigator.locks), with a deadline:
 * at `budgetMs` every request still out is aborted, every other wait is let go, the lock is handed back, and the round
 * answers null. A caller that finds a round running shares it, waiting no longer than its own budget. Null too when
 * nothing was asked.
 */
export function syncOutsideMailNow(budgetMs: number = OUTSIDE_ROUND_MS): Promise<SyncOutcome | null> {
    if (running) return atMost(running, budgetMs);
    const round = roundWithDeadline(budgetMs);
    running = round;
    void round.finally(() => { if (running === round) running = null; });
    return round;
}

function roundWithDeadline(deadlineMs: number): Promise<SyncOutcome | null> {
    const controller = new AbortController();
    const signal = controller.signal;
    // Where this round stands, before it reads anything: the moment that moves (Sign Out, a delete, another community), the
    // round is aborted, as at its deadline; a page that hasn't heard yet finds out at its next store call or request.
    const here = standingNow();
    const holds = () => {
        if (here.holds()) return true;
        controller.abort();
        return false;
    };
    const stopWatching = watchStanding(holds);
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const work = async (): Promise<SyncOutcome | null> => {
        try {
            const found = await untilDeadline(outsideContext({ nodeUrl: here.nodeUrl, holds }), signal);
            if (!found) return null;
            const ctx = boundedBySignal({ ...found, signal });
            const on = await untilDeadline(outsideMessagesHere(), signal);
            if (on !== true) {
                // Read, and off: my server would refuse my waiting lines (403) and no round runs to send them; they fail now, saying why.
                if (on === false && await failUnsent(ctx, t("This community doesn't take messages from other communities.")) > 0 && holds()) ring();
                return null;
            }
            const out = await syncOutsideMail(ctx);
            if ((out.written || out.requests || out.ticks) && holds()) ring();
            return out;
        } catch (e) {
            if (!signal.aborted) console.warn('[OutsideMail] This round did not finish:', (e as Error)?.message ?? e);
            return null;
        }
    };
    // Whatever work() is still waiting on at the deadline, the round lets go of it there, and so the lock, which the browser
    // holds until this settles: the next round, in this tab or another, starts afresh.
    const run = () => untilDeadline(work(), signal).catch(() => null);
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    const guarded: Promise<SyncOutcome | null> = locks?.request
        ? (locks.request(ROUND_LOCK, { ifAvailable: true }, (lock) => (lock ? run() : null)) as Promise<SyncOutcome | null>).catch(() => null)
        : run();
    return atMost(guarded, deadlineMs + LOCK_GRACE_MS).finally(() => { clearTimeout(timer); stopWatching(); });
}

function atMost<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
}

/** Tells the page its outside chats changed. */
export function ring(): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(OUTSIDE_CHATS_EVENT));
}

/** What to tell the member when a send didn't go: my server's words, else ours. `kept` false: the words wait in the box. */
export function outsideErrorWords(e: unknown, kept = true): string {
    if (e instanceof OutsideMailError && e.message && !/^HTTP \d+$/.test(e.message)) return e.message;
    return kept
        ? t("That didn't go through. It will be tried again when you're back online.")
        : t("That didn't go through. Your message is still there to send again.");
}
