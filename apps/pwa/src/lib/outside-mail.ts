/**
 * The browser's half of the mailbox between communities (messages across communities X4, the web side of the phone's X3:
 * scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.2 to §3.6). The server's half is X2 (apps/server/src/routes/
 * relay.ts); this browser only ever talks to its own community's server. The phone's utils/outside-mail.ts is the same
 * round, and this keeps what its three review rounds (#3168) fixed:
 *
 * - **A deadline on every round** ({@link syncOutsideMailNow}): every request carries the round's `signal`; at the deadline
 *   they are aborted, the round answers null and is let go, so one stalled request never stops the rounds after it.
 * - **A refused batch fails per line** (resendUnsent): my server takes a batch whole or refuses it at its first bad item, so
 *   a refused batch is sent again line by line and only the lines refused on their own fail, each with my server's words.
 *   A 403 (the switch off, a suspended member) fails them all. Anything else waits for the next round.
 * - **Write, then confirm; receipts owed before the confirm** (syncOutsideMail): each item fetched is checked here again,
 *   gated (core gateOutsideItem), written, and only then confirmed (which deletes it at the server); a write that fails
 *   is never confirmed. The receipt for a line written is owed in this browser before the confirm, and posted by this round
 *   or the next until my server takes it (flushReceipts), so no stop between the confirm and the receipt loses it.
 * - **Typed words never lost** ({@link sendFromBox}): the box empties only once the line is kept here.
 *
 * Ticks: the same fetch carries what became of my own items; a tick for a chat this browser lacks (one newly signed in)
 * brings the chat back empty and marked restored, so it opens with the reason it is empty.
 */
import {
    ADDRESS_CARD_NAME_MAX, addressCardName, audienceOf, gateOutsideItem, newDmMessageId, nodeHomeOf, openOutsideLine,
    outsideReceiptPayload, readRelayEnvelope, relayConversationId, relayEnvelopeVerifies, relayPayloadHash, sealOutsideLine, t,
    type AddressCard, type RelayEnvelope, type RelayEnvelopeFields, type RelayItem,
} from '@beanpool/core';
import { nodeAddress, signAddressCardFor, signedMailFetch, signRelayEnvelopeFor } from './api';
import { communityInfoOnce } from './visitor-lobby-gate';
import { getBlocklistStatus, isUserBlocked, loadBlocklist } from './blocklist';
import { loadIdentity, type BeanPoolIdentity } from './identity';
import { outsideChatStore, type OutsideChatStore, type OutsideLineState } from './outside-chat-store';

export const DOOR_META = 'door';
export const CURSOR_META = 'outbox-cursor';
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

const get = async (ctx: OutsideMailContext, path: string) => answerOf(await signedMailFetch('GET', ctx.nodeUrl, path, undefined, ctx.identity as BeanPoolIdentity, ctx.signal));
const post = async (ctx: OutsideMailContext, path: string, body: unknown) => answerOf(await signedMailFetch('POST', ctx.nodeUrl, path, body, ctx.identity as BeanPoolIdentity, ctx.signal));

/**
 * This community's home as other servers name it (its primary address, on the port this browser reaches it at when the two
 * hosts agree), read again after an hour so a community that moved signs as its new home. Null while it knows none.
 */
export async function myHome(ctx: Pick<OutsideMailContext, 'nodeUrl' | 'store' | 'signal' | 'identity'>, now = Date.now()): Promise<string | null> {
    const me = ctx.identity.publicKey;
    const kept = (await ctx.store.getMeta(me, HOME_META))?.split(' ');
    if (kept?.[0] && now - Number(kept[1]) < HOME_FRESH_MS) return kept[0];
    let primary: string | null = null;
    try {
        const res = await fetch(`${ctx.nodeUrl.replace(/\/+$/, '')}/api/community/info`, { cache: 'no-store', ...(ctx.signal ? { signal: ctx.signal } : {}) });
        const info: any = res.ok ? await res.json().catch(() => null) : null;
        primary = typeof info?.primaryAddress === 'string' ? info.primaryAddress : null;
    } catch {
        primary = null;
    }
    if (!primary) return kept?.[0] || null;
    const reached = nodeHomeOf(ctx.nodeUrl);
    const home = reached && audienceOf(reached) === audienceOf(primary) ? reached : nodeHomeOf(primary);
    if (home) await ctx.store.setMeta(me, HOME_META, `${home} ${now}`);
    return home;
}

/** My card, signed now, under the name I use here; null while my community knows none of its names. */
export async function myAddressCard(ctx: OutsideMailContext): Promise<AddressCard | null> {
    const home = await myHome(ctx);
    if (!home) return null;
    const name = addressCardName(String(ctx.identity.callsign ?? '').replace(/\s+/g, ' ').trim().slice(0, ADDRESS_CARD_NAME_MAX)) ?? '…';
    return signAddressCardFor({ key: ctx.identity.publicKey, home, name }, ctx.identity as BeanPoolIdentity);
}

export async function doorOpen(ctx: Pick<OutsideMailContext, 'store' | 'identity'>): Promise<boolean> {
    return (await ctx.store.getMeta(ctx.identity.publicKey, DOOR_META)) === 'open';
}

export async function setDoor(ctx: Pick<OutsideMailContext, 'store' | 'identity'>, open: boolean): Promise<void> {
    await ctx.store.setMeta(ctx.identity.publicKey, DOOR_META, open ? 'open' : 'closed');
}

async function envelopeFor(ctx: OutsideMailContext, fields: Omit<RelayEnvelopeFields, 'senderKey' | 'senderHome' | 'payloadHash'>, payload: string): Promise<RelayEnvelope> {
    const home = await myHome(ctx);
    if (!home) throw new OutsideMailError(503, t("This community's server knows none of its own names yet, so it can't send to another community."), 'no_home');
    return signRelayEnvelopeFor({ ...fields, senderKey: ctx.identity.publicKey, senderHome: home, payloadHash: relayPayloadHash(payload) }, ctx.identity as BeanPoolIdentity);
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

export interface SyncOutcome { written: number; requests: number; dropped: number; confirmed: number; ticks: number }

/**
 * One round: unsent lines sent again, then what waits fetched, checked, gated, written, receipt owed, confirmed, receipts
 * posted, my items' ticks applied. Throws only when my server can't be read; a write that fails leaves its item unconfirmed.
 */
export async function syncOutsideMail(ctx: OutsideMailContext, now = Date.now()): Promise<SyncOutcome> {
    const out: SyncOutcome = { written: 0, requests: 0, dropped: 0, confirmed: 0, ticks: 0 };
    const me = ctx.identity.publicKey;
    await resendUnsent(ctx, now).catch((e) => console.warn('[OutsideMail] Unsent lines wait for the next round:', e?.message ?? e));
    const open = await doorOpen(ctx);
    const tried = new Set<string>();
    const owe = (env: RelayEnvelope) => ctx.store.oweReceipt(me, { id: env.itemId, key: env.senderKey, home: env.senderHome }, now);
    for (let page = 0; page < PAGES_MAX; page++) {
        if (ctx.signal?.aborted) throw Object.assign(new Error('This round ran out of time.'), { name: 'AbortError' });
        const cursor = (await ctx.store.getMeta(me, CURSOR_META)) ?? '0:';
        const [since, sinceId] = [cursor.slice(0, cursor.indexOf(':')), cursor.slice(cursor.indexOf(':') + 1)];
        const answer = await get(ctx, `/api/mail?since=${encodeURIComponent(since)}&sinceId=${encodeURIComponent(sinceId)}`);
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
        if (done.length) out.confirmed += Number((await post(ctx, '/api/mail/confirm', { ids: done }))?.confirmed) || 0;
        await flushReceipts(ctx, now, tried);
        out.ticks += await applyTicks(ctx, Array.isArray(answer?.outbox) ? answer.outbox : [], now);
        if (writeFailed || (!answer?.more && !answer?.outboxMore)) break;
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
            if (ctx.signal?.aborted) return;
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

async function applyTicks(ctx: OutsideMailContext, ticks: any[], now: number): Promise<number> {
    const me = ctx.identity.publicKey;
    let applied = 0;
    let last: { at: number; itemId: string } | null = null;
    for (const tick of ticks) {
        if (typeof tick?.itemId !== 'string' || !Number.isSafeInteger(tick?.at)) continue;
        last = { at: tick.at, itemId: tick.itemId };
        if (tick.kind !== 'dm-line' || !STATES.includes(tick.state)) continue;
        if (typeof tick.recipient !== 'string' || !/^[0-9a-f]{64}$/.test(tick.recipient) || tick.recipient === me) continue;
        const chatId = relayConversationId(me, tick.recipient);
        if (await ctx.store.hasLine(me, chatId, tick.itemId)) {
            await ctx.store.setMineState(me, chatId, tick.itemId, tick.state);
            applied++;
        } else if (typeof tick.recipientHome === 'string') {
            await ctx.store.noteRestored(me, chatId, { key: tick.recipient, home: tick.recipientHome }, now);
            applied++;
        }
    }
    if (last) await ctx.store.setMeta(me, CURSOR_META, `${last.at}:${last.itemId}`);
    return applied;
}

// ─── The round, as the Messages page runs it ─────────────────────────────────────────────────

/** A round's deadline: well over a healthy one (a page, its confirm, a receipt to each sender, each forwarded up to 10 s). */
export const OUTSIDE_ROUND_MS = 45_000;
/** How long a send from the box waits for my server before its line is left `sending`, for the next round. */
export const OUTSIDE_SEND_MS = 20_000;

/** Whether the account blocked `key`, the list read from my server first when this page hasn't yet: never guessed. */
async function blockedHere(key: string): Promise<boolean> {
    if (!getBlocklistStatus().loaded) await loadBlocklist();
    return isUserBlocked(key);
}

/** The context for the community this web app talks to, or null with no account in this browser. */
export async function outsideContext(): Promise<OutsideMailContext | null> {
    const identity = await loadIdentity().catch(() => null);
    if (!identity?.privateKey) return null;
    return { nodeUrl: nodeAddress().replace(/\/+$/, ''), identity, store: outsideChatStore(), isBlocked: blockedHere };
}

/** Whether this community takes messages from other communities (its info's `features.outsideMessages`); null unread. */
export async function outsideMessagesHere(): Promise<boolean | null> {
    const info = await communityInfoOnce().catch(() => null);
    return info ? (info.features as { outsideMessages?: unknown } | undefined)?.outsideMessages === true : null;
}

let running: Promise<SyncOutcome | null> | null = null;

/**
 * One round, never two at once in this tab (nor in two tabs, where the browser can say: navigator.locks), with a deadline:
 * at `budgetMs` every request still out is aborted and the round answers null and is let go. A caller that finds a round
 * running shares it, waiting no longer than its own budget. Null too when nothing was asked.
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, deadlineMs);
    });
    const work = async (): Promise<SyncOutcome | null> => {
        try {
            const ctx = await outsideContext();
            if (!ctx) return null;
            const on = await outsideMessagesHere();
            if (on !== true) {
                // Read, and off: my server would refuse my waiting lines (403) and no round runs to send them; they fail now, saying why.
                if (on === false && await failUnsent(ctx, t("This community doesn't take messages from other communities.")) > 0) ring();
                return null;
            }
            const out = await syncOutsideMail({ ...ctx, signal: controller.signal });
            if (out.written || out.requests || out.ticks) ring();
            return out;
        } catch (e) {
            if (!controller.signal.aborted) console.warn('[OutsideMail] This round did not finish:', (e as Error)?.message ?? e);
            return null;
        }
    };
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    const guarded: Promise<SyncOutcome | null> = locks?.request
        ? locks.request('beanpool-outside-mail', { ifAvailable: true }, (lock) => (lock ? work() : null)) as Promise<SyncOutcome | null>
        : work();
    return Promise.race([guarded, timedOut]).finally(() => clearTimeout(timer));
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
