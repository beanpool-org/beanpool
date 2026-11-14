/**
 * The phone's half of the mailbox between communities (messages across communities X3: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.2 to §3.6; DESIGN-cross-community-chat-fable.md §2.4 "Send", "Fetch and ack"). The
 * server's half is X2 (apps/server/src/routes/relay.ts): this phone only ever talks to its own community's server.
 *
 * **Send.** A line is sealed and signed on the phone (core outside-chat.ts sealOutsideLine), wrapped in the member's relay
 * envelope (core relay-envelope.ts) naming their home and the peer's, written here as `sending` with its signed item, then
 * posted: `POST /api/mail/send`. The server forwards it to the peer's home and answers its state; a line the server never
 * answered is posted again at the next sync, the same item (the server keeps one row per id), while it is still fresh.
 *
 * **Fetch, write, then confirm** ({@link syncOutsideMail}). `GET /api/mail` gives what waits, oldest first. Each item is
 * checked here again (the envelope is the sender's and is to me; a line opens as the envelope's), passed through the request
 * gate (outside-chat-store.ts gateIncoming), and written. Only then is it confirmed (`POST /api/mail/confirm`), which deletes
 * it at the server: an item whose write failed is never confirmed, so it is fetched again, never lost. An item the gate
 * drops, or that doesn't check out, is confirmed too (it can never be shown, and an unconfirmed one would hold the page).
 *
 * **Receipts.** Each line written is receipted to its sender's home (kind `receipt`): their phone shows Delivered. The
 * receipt is owed on the phone (outside_receipts) before its line is confirmed, and owed until my server takes it: a round
 * that stops between the confirm and the receipt (its deadline, the app killed, the network gone, my server saying no or
 * busy) leaves it owed, and the next round posts it ({@link flushReceipts}), as many rounds as it takes within
 * RECEIPT_KEPT_MS. Without that, a line my server had deleted would never be fetched again, and its sender would see "Not
 * delivered" for a line that was. A receipt posted twice (taken, its answer lost) does no harm: a line delivered stays so.
 *
 * **Ticks.** The same fetch carries what became of my own items (the outbox's states, paged by time and id from the cursor
 * kept here). A tick for a line this phone doesn't have (a phone restored from 12 words) brings its chat back empty and
 * marked restored, so the chat opens with the reason it is empty.
 *
 * **A deadline.** Every request a round or a send makes carries the context's `signal` (React Native's fetch never gives up
 * by itself), so the caller's deadline (outside-chat-live.ts) ends a stalled request, and the round with it.
 */
import {
    ADDRESS_CARD_NAME_MAX, addressCardName, newDmMessageId, openOutsideLine, outsideReceiptPayload, readRelayEnvelope,
    relayConversationId, relayEnvelopeVerifies, relayPayloadHash, sealOutsideLine, nodeHomeOf, audienceOf, t,
    type AddressCard, type RelayEnvelope, type RelayEnvelopeFields, type RelayItem,
} from '@beanpool/core';
import { signAddressCardStatement, signRelayEnvelopeStatement } from './member-statements';
import { signedGet, signedPost } from './node-post';
import { gateIncoming, type OutsideChatStore, type OutsideLineState } from './outside-chat-store';
import type { BeanPoolIdentity } from './identity';

/** The member's door (design §3.5): opened by showing their card here the first time, closed in Settings → Privacy. */
export const DOOR_META = 'door';
/** The outbox cursor: the last tick this phone has, `<at>:<itemId>`. */
export const CURSOR_META = 'outbox-cursor';
const HOME_META = 'home';
/** How long the home read from the community is used before it is read again. */
const HOME_FRESH_MS = 60 * 60_000;
/** The pages one sync reads at most, of held items and of ticks each. */
const PAGES_MAX = 10;
/** A line the server never answered is sent again while this fresh (the server refuses one older than 7 days). */
const RESEND_WITHIN_MS = 6 * 24 * 60 * 60_000;
/**
 * How long a receipt my server hasn't taken stays owed: the 30 days a sender's server keeps its line's row
 * (relay-outbox.ts OUTBOX_KEPT_MS). After that no row is left for it to mark.
 */
const RECEIPT_KEPT_MS = 30 * 24 * 60 * 60_000;
/** The ids one receipt names at most (relay-mail.ts: one fetch's worth). */
const RECEIPT_IDS_MAX = 50;
/** The owed ids one turn posts at most: a round with a long backlog still ends, and the rest go at the next. */
const RECEIPTS_PER_TURN = 200;

export interface OutsideMailContext {
    nodeUrl: string;
    identity: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey' | 'callsign'>;
    store: OutsideChatStore;
    /** Whether the account blocked this key (utils/blocklist.ts). */
    isBlocked: (key: string) => Promise<boolean>;
    /** The caller's deadline: every request made with this context is aborted with it. */
    signal?: AbortSignal;
}

const STATES: readonly OutsideLineState[] = ['queued', 'sent', 'delivered', 'failed', 'expired'];

/** A thrown answer from my server, with its own words when it sent any. */
export class OutsideMailError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
        super(message);
        this.name = 'OutsideMailError';
    }
}

/**
 * My server answered no for good: a 4xx but a 429 (try later), 401 (a request signed with a clock that is off), 408 or 425.
 * A line it refused this way will never go, as it is.
 */
export function refusedForGood(e: unknown): e is OutsideMailError {
    return e instanceof OutsideMailError && e.status >= 400 && e.status < 500 && ![401, 408, 425, 429].includes(e.status);
}

/** Why a refused line didn't go, in my server's words, or ours when it sent none. */
function refusalWords(e: OutsideMailError): string {
    return e.message && !/^HTTP \d+$/.test(e.message) ? e.message : t('Your community refused this message.');
}

/** A server's code, not words: one lower-case token (`rate_limited`, `not_a_member`). */
const CODE_ONLY = /^[a-z0-9_]+$/;

async function answerOf(res: Response): Promise<any> {
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        // The server's sentence: `message` when it sent one beside a code in `error` (a report's 429: { error: 'rate_limited',
        // message }), as utils/db.ts reportRefusal reads it; else `error`, its words beside `code`. Never a bare code
        // (`rate_limited`): that reads as `HTTP <n>`, which every screen shows as its own sentence.
        const said = typeof body?.message === 'string' && body.message ? body.message : null;
        const error = typeof body?.error === 'string' && body.error ? body.error : null;
        const errorIsCode = !!error && CODE_ONLY.test(error);
        const code = typeof body?.code === 'string' ? body.code : error && (errorIsCode || said) ? error : undefined;
        throw new OutsideMailError(res.status, said ?? (error && !errorIsCode ? error : `HTTP ${res.status}`), code);
    }
    return body;
}

/**
 * This community's home as other servers name it: its primary address (GET /api/community/info), on the port this phone
 * reaches it at when the two hosts agree. Kept once read. Null while the community knows none of its names.
 */
export async function myHome(ctx: Pick<OutsideMailContext, 'nodeUrl' | 'store' | 'signal'>, now = Date.now()): Promise<string | null> {
    // Kept as `<home> <when read>`, and read again after HOME_FRESH_MS: a community that moves to a new address signs its
    // requests as the new home, and an envelope naming the old one would be refused (relay-outbox.ts itemProblem).
    const kept = (await ctx.store.getMeta(HOME_META))?.split(' ');
    if (kept?.[0] && now - Number(kept[1]) < HOME_FRESH_MS) return kept[0];
    let primary: string | null = null;
    try {
        const res = await fetch(`${ctx.nodeUrl.replace(/\/+$/, '')}/api/community/info`, ctx.signal ? { signal: ctx.signal } : undefined);
        const info: any = res.ok ? await res.json().catch(() => null) : null;
        primary = typeof info?.primaryAddress === 'string' ? info.primaryAddress : null;
    } catch {
        primary = null;
    }
    if (!primary) return kept?.[0] || null;   // unreachable now: the home read before, if any
    const reached = nodeHomeOf(ctx.nodeUrl);
    const home = reached && audienceOf(reached) === audienceOf(primary) ? reached : nodeHomeOf(primary);
    if (home) await ctx.store.setMeta(HOME_META, `${home} ${now}`);
    return home;
}

/** My card, signed now, under the name I use here. */
export async function myAddressCard(ctx: OutsideMailContext): Promise<AddressCard | null> {
    const home = await myHome(ctx);
    if (!home) return null;
    const name = addressCardName(String(ctx.identity.callsign ?? '').replace(/\s+/g, ' ').trim().slice(0, ADDRESS_CARD_NAME_MAX)) ?? '…';
    return signAddressCardStatement({ key: ctx.identity.publicKey, home, name }, ctx.identity.privateKey);
}

export async function doorOpen(store: OutsideChatStore): Promise<boolean> {
    return (await store.getMeta(DOOR_META)) === 'open';
}

export async function setDoor(store: OutsideChatStore, open: boolean): Promise<void> {
    await store.setMeta(DOOR_META, open ? 'open' : 'closed');
}

async function envelopeFor(ctx: OutsideMailContext, fields: Omit<RelayEnvelopeFields, 'senderKey' | 'senderHome' | 'payloadHash'>, payload: string): Promise<RelayEnvelope> {
    const home = await myHome(ctx);
    if (!home) throw new OutsideMailError(503, t("This community's server knows none of its own names yet, so it can't send to another community."), 'no_home');
    return signRelayEnvelopeStatement({ ...fields, senderKey: ctx.identity.publicKey, senderHome: home, payloadHash: relayPayloadHash(payload) },
        ctx.identity.privateKey);
}

async function postItems(ctx: OutsideMailContext, items: RelayItem[]): Promise<Array<{ itemId: string; state: string }>> {
    const answer = await answerOf(await signedPost(ctx.nodeUrl, '/api/mail/send', { items }, ctx.identity as BeanPoolIdentity, ctx.signal));
    return Array.isArray(answer?.items) ? answer.items : [];
}

/**
 * Report a line from another community (X5): the item as it came, kept on this phone (its sender's signed envelope and the
 * sealed line inside), and the words it opened to, to my own community's server. That server checks the sender's signatures,
 * blocks them for me, and tells their community, never naming me (server: engine/relay-complaint.ts). Throws
 * OutsideMailError with my server's words when it refuses.
 */
export async function reportOutsideLine(ctx: Pick<OutsideMailContext, 'nodeUrl' | 'identity' | 'store' | 'signal'>, lineId: string, reason: string): Promise<void> {
    const kept = await ctx.store.kept(lineId);
    let item: unknown = null;
    try { item = kept ? JSON.parse(kept.sealed) : null; } catch { /* not kept as it came */ }
    if (!kept || !item) throw new OutsideMailError(404, t('That did not go through. Please try again.'), 'not_kept');
    await answerOf(await signedPost(ctx.nodeUrl, '/api/mail/report', { item, reason, words: kept.text }, ctx.identity as BeanPoolIdentity, ctx.signal));
}

/**
 * Send `text` to the peer of chat `chatId` (a chat this phone has, open). Written first as `sending` (then `onKept` is
 * called); then the state my server answers. Throws OutsideMailError with the server's words when it refuses the line (the
 * line is then `failed`). A throw before `onKept` means no line was kept: the words are only where the caller has them.
 */
export async function sendOutsideLine(ctx: OutsideMailContext, chatId: string, text: string, replyTo: string | null = null, onKept?: () => void): Promise<OutsideLineState> {
    const me = ctx.identity.publicKey;
    const chat = await ctx.store.chat(me, chatId);
    if (!chat || chat.state !== 'open') throw new OutsideMailError(400, t('Accept the request first.'), 'not_accepted');
    const messageId = newDmMessageId();
    const payload = sealOutsideLine({ text, name: ctx.identity.callsign, myEdPrivHex: ctx.identity.privateKey, myKey: me, peerKey: chat.peerKey, messageId, replyToId: replyTo });
    const at = Date.now();
    const envelope = await envelopeFor(ctx, { kind: 'dm-line', itemId: messageId, recipient: chat.peerKey, recipientHome: chat.peerHome, at }, payload);
    const item: RelayItem = { envelope, payload };
    await ctx.store.addMine({ id: messageId, chatId, author: me, text, replyTo, at, item: JSON.stringify(item) });
    onKept?.();
    let answered: Array<{ itemId: string; state: string }>;
    try {
        answered = await postItems(ctx, [item]);
    } catch (e) {
        // My server answered no: this line will never go, and says why. Unreached: it stays `sending`, and goes at the next sync.
        if (refusedForGood(e)) await ctx.store.setMineState(messageId, 'failed', refusalWords(e));
        throw e;
    }
    const state = answered.find((a) => a.itemId === messageId)?.state as OutsideLineState | undefined;
    if (state && STATES.includes(state)) await ctx.store.setMineState(messageId, state);
    return state && STATES.includes(state) ? state : 'sending';
}

/**
 * A line sent from a box on screen (the chat's box, the card's first line), with the typed words never lost: `onKept`
 * empties the box once the line is kept on this phone (shown at once as Sending…, or Not delivered with my server's words
 * why), and never before. A send that fails before that (my community knows none of its names here and can't be read now,
 * the deadline cut that read, the request not accepted yet) leaves the words in the box, to send again. The send has its
 * own deadline, `budgetMs`: a kept line my server hasn't answered by then stays `sending`, and goes at the next round.
 */
export async function sendFromBox(ctx: OutsideMailContext, chatId: string, words: string, budgetMs: number, onKept: () => void): Promise<{ kept: boolean; error: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let kept = false;
    try {
        await sendOutsideLine({ ...ctx, signal: controller.signal }, chatId, words, null, () => { kept = true; onKept(); });
        return { kept, error: null };
    } catch (error) {
        return { kept, error };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Lines my server never answered, sent again (the same items) while they are fresh; older ones are failed. My server takes
 * a request whole or refuses it at its first bad item (relay-outbox.ts sendRelayItems), so a refused batch is sent again one
 * line at a time, and only the lines refused on their own fail, each with my server's words: one bad line never holds the
 * others. A 403 is about the member or the community (outside messages switched off, a suspended member), never one line:
 * every line in the batch fails with its words. Anything else (429, 5xx, no answer) leaves them for the next round.
 */
async function resendUnsent(ctx: OutsideMailContext, now: number): Promise<void> {
    const unsent = await ctx.store.unsent(ctx.identity.publicKey);
    const fresh = unsent.filter((u) => now - u.at < RESEND_WITHIN_MS);
    for (const u of unsent) if (now - u.at >= RESEND_WITHIN_MS) await ctx.store.setMineState(u.id, 'failed');
    if (!fresh.length) return;
    const apply = async (answered: Array<{ itemId: string; state: string }>) => {
        for (const a of answered) if (STATES.includes(a.state as OutsideLineState)) await ctx.store.setMineState(a.itemId, a.state as OutsideLineState);
    };
    try {
        await apply(await postItems(ctx, fresh.map((u) => JSON.parse(u.item) as RelayItem)));
        return;
    } catch (e) {
        if (!refusedForGood(e)) throw e;
        if (e.status === 403 || fresh.length === 1) {
            for (const u of fresh) await ctx.store.setMineState(u.id, 'failed', refusalWords(e));
            return;
        }
    }
    for (const u of fresh) {
        try {
            await apply(await postItems(ctx, [JSON.parse(u.item) as RelayItem]));
        } catch (e) {
            if (!refusedForGood(e)) throw e;
            await ctx.store.setMineState(u.id, 'failed', refusalWords(e));
            if (e.status === 403) {
                // Not this line's fault: the rest fail with it, unasked.
                for (const rest of fresh.slice(fresh.indexOf(u) + 1)) await ctx.store.setMineState(rest.id, 'failed', refusalWords(e));
                return;
            }
        }
    }
}

/**
 * Every line of mine still `sending` fails with `words`, nothing asked: the phone reads its community's switch off, so no
 * round runs to send them, and my server would refuse them (403) if one did.
 */
export async function failUnsent(ctx: Pick<OutsideMailContext, 'identity' | 'store'>, words: string): Promise<number> {
    const seen = new Set<string>();
    for (;;) {
        // unsent() reads 16 at a time; a line read twice was not changed, so the loop stops rather than spin.
        const unsent = (await ctx.store.unsent(ctx.identity.publicKey)).filter((u) => !seen.has(u.id));
        if (!unsent.length) return seen.size;
        for (const u of unsent) {
            seen.add(u.id);
            await ctx.store.setMineState(u.id, 'failed', words);
        }
    }
}

export interface SyncOutcome {
    written: number;
    requests: number;
    dropped: number;
    confirmed: number;
    ticks: number;
}

/**
 * One round: unsent lines sent again, then what waits fetched, checked, gated, written, confirmed and receipted, then my
 * items' ticks applied. Throws only when the server can't be read at all; a write that fails leaves its item unconfirmed.
 */
export async function syncOutsideMail(ctx: OutsideMailContext, now = Date.now()): Promise<SyncOutcome> {
    const out: SyncOutcome = { written: 0, requests: 0, dropped: 0, confirmed: 0, ticks: 0 };
    const me = ctx.identity.publicKey;
    await resendUnsent(ctx, now).catch((e) => console.warn('[OutsideMail] Unsent lines wait for the next round:', e?.message ?? e));
    const open = await doorOpen(ctx.store);
    /** Owed receipts this round tried and my server didn't take: tried again at the next round, not this one. */
    const tried = new Set<string>();
    /** A line of theirs written here: its receipt owed before the line is confirmed. */
    const owe = async (env: RelayEnvelope) => {
        if (env.kind === 'dm-line') await ctx.store.oweReceipt(me, { id: env.itemId, key: env.senderKey, home: env.senderHome }, now);
    };
    for (let page = 0; page < PAGES_MAX; page++) {
        // A plain check: React Native's AbortSignal has no throwIfAborted.
        if (ctx.signal?.aborted) throw Object.assign(new Error('This round ran out of time.'), { name: 'AbortError' });
        const cursor = (await ctx.store.getMeta(CURSOR_META)) ?? '0:';
        const [since, sinceId] = [cursor.slice(0, cursor.indexOf(':')), cursor.slice(cursor.indexOf(':') + 1)];
        const answer = await answerOf(await signedGet(ctx.nodeUrl, `/api/mail?since=${encodeURIComponent(since)}&sinceId=${encodeURIComponent(sinceId)}`, ctx.identity as BeanPoolIdentity, ctx.signal));
        const held: any[] = Array.isArray(answer?.items) ? answer.items : [];
        const done: string[] = [];
        let writeFailed = false;
        for (const h of held) {
            const env = readRelayEnvelope(h?.envelope);
            if (!env) continue;   // not an envelope the server would have taken: nothing to confirm by
            // Checked here again: the server holding it could have been anyone's. Not mine, or not its sender's: dropped.
            const payloadOk = typeof h.payload === 'string' ? relayPayloadHash(h.payload) === env.payloadHash : env.kind === 'dm-blob';
            if (env.recipient !== me || !relayEnvelopeVerifies(env) || !payloadOk) {
                done.push(env.itemId); out.dropped++; continue;
            }
            try {
                const chatId = relayConversationId(me, env.senderKey);
                if (env.kind === 'dm-line' && await ctx.store.hasLine(env.itemId)) {
                    // Written before, not confirmed: its receipt owed (once), then confirmed.
                    await owe(env);
                    done.push(env.itemId);
                    continue;
                }
                const chat = await ctx.store.chat(me, chatId);
                const verdict = gateIncoming({
                    kind: env.kind,
                    chat: chat ? { state: chat.state, theirLines: await ctx.store.theirLines(chatId, env.senderKey) } : null,
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
                await ctx.store.writeTheirs(me, {
                    id: env.itemId, chatId, author: env.senderKey, text: opened.text, replyTo: opened.replyToId, at: env.at,
                    sealed: JSON.stringify({ envelope: env, payload: h.payload }),
                }, { home: env.senderHome, name: opened.name }, verdict, now);
                // Past the gate, only a line is ever written (gateIncoming): it is owed its receipt before it is confirmed.
                await owe(env);
                done.push(env.itemId);
                if (verdict === 'request') out.requests++; else out.written++;
            } catch (e) {
                // The write (or its receipt's) failed: this item is not confirmed, and is fetched again. The rest of the page waits with it.
                console.warn('[OutsideMail] An item could not be written here; it waits at the server:', (e as Error)?.message ?? e);
                writeFailed = true;
                break;
            }
        }
        if (done.length) {
            const confirmed = await answerOf(await signedPost(ctx.nodeUrl, '/api/mail/confirm', { ids: done }, ctx.identity as BeanPoolIdentity, ctx.signal));
            out.confirmed += Number(confirmed?.confirmed) || 0;
        }
        // This page's receipts, and any an earlier round didn't get to post.
        await flushReceipts(ctx, now, tried);
        out.ticks += await applyTicks(ctx, Array.isArray(answer?.outbox) ? answer.outbox : [], now);
        if (writeFailed || (!answer?.more && !answer?.outboxMore)) break;
    }
    return out;
}

/**
 * The receipts this phone owes, RECEIPTS_PER_TURN ids at most, each sender's to their home, RECEIPT_IDS_MAX ids to a receipt,
 * signed now. One my server takes is owed no more. One it doesn't (no answer, a refusal, busy) stays owed and goes behind
 * the rest at the next round; `tried` keeps it from being tried again in this one. At the round's deadline the rest stay
 * owed as they are. One owed for RECEIPT_KEPT_MS goes unsent: its sender's server has no row left for it to mark.
 */
async function flushReceipts(ctx: OutsideMailContext, now: number, tried: Set<string>): Promise<void> {
    const me = ctx.identity.publicKey;
    await ctx.store.forgetReceiptsOwedBefore(me, now - RECEIPT_KEPT_MS);
    const bySender = new Map<string, { home: string; key: string; ids: string[] }>();
    for (const o of await ctx.store.owedReceipts(me, RECEIPTS_PER_TURN)) {
        if (tried.has(o.id)) continue;
        const k = `${o.key}@${o.home}`;
        const r = bySender.get(k) ?? { home: o.home, key: o.key, ids: [] };
        r.ids.push(o.id);
        bySender.set(k, r);
    }
    for (const r of bySender.values()) {
        for (let i = 0; i < r.ids.length; i += RECEIPT_IDS_MAX) {
            if (ctx.signal?.aborted) return;
            const ids = r.ids.slice(i, i + RECEIPT_IDS_MAX);
            try {
                const payload = outsideReceiptPayload(ids);
                const envelope = await envelopeFor(ctx, { kind: 'receipt', itemId: newDmMessageId(), recipient: r.key, recipientHome: r.home, at: now }, payload);
                await postItems(ctx, [{ envelope, payload }]);
                await ctx.store.receiptsSent(ids);
            } catch (e) {
                console.warn('[OutsideMail] A receipt waits for the next round:', (e as Error)?.message ?? e);
                for (const id of ids) tried.add(id);
                await ctx.store.receiptsTried(ids, now).catch(() => {});
            }
        }
    }
}

/** My items' ticks: each line's state, a chat this phone lacks brought back empty, the cursor moved past them. */
async function applyTicks(ctx: OutsideMailContext, ticks: any[], now: number): Promise<number> {
    const me = ctx.identity.publicKey;
    let applied = 0;
    let last: { at: number; itemId: string } | null = null;
    for (const t of ticks) {
        if (typeof t?.itemId !== 'string' || !Number.isSafeInteger(t?.at)) continue;
        last = { at: t.at, itemId: t.itemId };
        if (t.kind !== 'dm-line' || !STATES.includes(t.state)) continue;
        if (await ctx.store.hasLine(t.itemId)) {
            await ctx.store.setMineState(t.itemId, t.state);
            applied++;
        } else if (typeof t.recipient === 'string' && /^[0-9a-f]{64}$/.test(t.recipient) && t.recipient !== me && typeof t.recipientHome === 'string') {
            await ctx.store.noteRestored(me, relayConversationId(me, t.recipient), { key: t.recipient, home: t.recipientHome }, now);
        }
    }
    if (last) await ctx.store.setMeta(CURSOR_META, `${last.at}:${last.itemId}`);
    return applied;
}
