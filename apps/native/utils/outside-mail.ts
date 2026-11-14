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
 * Each line written is then receipted to its sender's home (kind `receipt`): their phone shows Delivered.
 *
 * **Ticks.** The same fetch carries what became of my own items (the outbox's states, paged by time and id from the cursor
 * kept here). A tick for a line this phone doesn't have (a phone restored from 12 words) brings its chat back empty and
 * marked restored, so the chat opens with the reason it is empty.
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
/** The pages one sync reads at most, of held items and of ticks each. */
const PAGES_MAX = 10;
/** A line the server never answered is sent again while this fresh (the server refuses one older than 7 days). */
const RESEND_WITHIN_MS = 6 * 24 * 60 * 60_000;

export interface OutsideMailContext {
    nodeUrl: string;
    identity: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey' | 'callsign'>;
    store: OutsideChatStore;
    /** Whether the account blocked this key (utils/blocklist.ts). */
    isBlocked: (key: string) => Promise<boolean>;
}

const STATES: readonly OutsideLineState[] = ['queued', 'sent', 'delivered', 'failed', 'expired'];

/** A thrown answer from my server, with its own words when it sent any. */
export class OutsideMailError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
        super(message);
        this.name = 'OutsideMailError';
    }
}

async function answerOf(res: Response): Promise<any> {
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new OutsideMailError(res.status, typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`, body?.code);
    return body;
}

/**
 * This community's home as other servers name it: its primary address (GET /api/community/info), on the port this phone
 * reaches it at when the two hosts agree. Kept once read. Null while the community knows none of its names.
 */
export async function myHome(ctx: Pick<OutsideMailContext, 'nodeUrl' | 'store'>): Promise<string | null> {
    const kept = await ctx.store.getMeta(HOME_META);
    if (kept) return kept;
    const res = await fetch(`${ctx.nodeUrl.replace(/\/+$/, '')}/api/community/info`);
    const info: any = res.ok ? await res.json().catch(() => null) : null;
    const primary = typeof info?.primaryAddress === 'string' ? info.primaryAddress : null;
    if (!primary) return null;
    const reached = nodeHomeOf(ctx.nodeUrl);
    const home = reached && audienceOf(reached) === audienceOf(primary) ? reached : nodeHomeOf(primary);
    if (home) await ctx.store.setMeta(HOME_META, home);
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
    const answer = await answerOf(await signedPost(ctx.nodeUrl, '/api/mail/send', { items }, ctx.identity as BeanPoolIdentity));
    return Array.isArray(answer?.items) ? answer.items : [];
}

/**
 * Send `text` to the peer of chat `chatId` (a chat this phone has, open). Written first as `sending`; then the state my
 * server answers. Throws OutsideMailError with the server's words when it refuses the line (the line is then `failed`).
 */
export async function sendOutsideLine(ctx: OutsideMailContext, chatId: string, text: string, replyTo: string | null = null): Promise<OutsideLineState> {
    const me = ctx.identity.publicKey;
    const chat = await ctx.store.chat(me, chatId);
    if (!chat || chat.state !== 'open') throw new OutsideMailError(400, t('Accept the request first.'), 'not_accepted');
    const messageId = newDmMessageId();
    const payload = sealOutsideLine({ text, name: ctx.identity.callsign, myEdPrivHex: ctx.identity.privateKey, myKey: me, peerKey: chat.peerKey, messageId, replyToId: replyTo });
    const at = Date.now();
    const envelope = await envelopeFor(ctx, { kind: 'dm-line', itemId: messageId, recipient: chat.peerKey, recipientHome: chat.peerHome, at }, payload);
    const item: RelayItem = { envelope, payload };
    await ctx.store.addMine({ id: messageId, chatId, author: me, text, replyTo, at, item: JSON.stringify(item) });
    let answered: Array<{ itemId: string; state: string }>;
    try {
        answered = await postItems(ctx, [item]);
    } catch (e) {
        // My server answered no: this line will never go. Unreached: it stays `sending`, and goes at the next sync.
        if (e instanceof OutsideMailError && e.status >= 400 && e.status < 500 && e.status !== 429) await ctx.store.setMineState(messageId, 'failed');
        throw e;
    }
    const state = answered.find((a) => a.itemId === messageId)?.state as OutsideLineState | undefined;
    if (state && STATES.includes(state)) await ctx.store.setMineState(messageId, state);
    return state && STATES.includes(state) ? state : 'sending';
}

/** Lines my server never answered, sent again (the same items) while they are fresh; older ones are failed. */
async function resendUnsent(ctx: OutsideMailContext, now: number): Promise<void> {
    const unsent = await ctx.store.unsent(ctx.identity.publicKey);
    const fresh = unsent.filter((u) => now - u.at < RESEND_WITHIN_MS);
    for (const u of unsent) if (now - u.at >= RESEND_WITHIN_MS) await ctx.store.setMineState(u.id, 'failed');
    if (!fresh.length) return;
    const answered = await postItems(ctx, fresh.map((u) => JSON.parse(u.item) as RelayItem));
    for (const a of answered) if (STATES.includes(a.state as OutsideLineState)) await ctx.store.setMineState(a.itemId, a.state as OutsideLineState);
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
    for (let page = 0; page < PAGES_MAX; page++) {
        const cursor = (await ctx.store.getMeta(CURSOR_META)) ?? '0:';
        const [since, sinceId] = [cursor.slice(0, cursor.indexOf(':')), cursor.slice(cursor.indexOf(':') + 1)];
        const answer = await answerOf(await signedGet(ctx.nodeUrl, `/api/mail?since=${encodeURIComponent(since)}&sinceId=${encodeURIComponent(sinceId)}`, ctx.identity as BeanPoolIdentity));
        const held: any[] = Array.isArray(answer?.items) ? answer.items : [];
        const done: string[] = [];
        const receipts = new Map<string, { home: string; key: string; ids: string[] }>();
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
                    // Written before, confirmed or receipted not: both again.
                    done.push(env.itemId);
                    addReceipt(receipts, env);
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
                done.push(env.itemId);
                addReceipt(receipts, env);
                if (verdict === 'request') out.requests++; else out.written++;
            } catch (e) {
                // The write failed: this item is not confirmed, and is fetched again. The rest of the page waits with it.
                console.warn('[OutsideMail] An item could not be written here; it waits at the server:', (e as Error)?.message ?? e);
                writeFailed = true;
                break;
            }
        }
        if (done.length) {
            const confirmed = await answerOf(await signedPost(ctx.nodeUrl, '/api/mail/confirm', { ids: done }, ctx.identity as BeanPoolIdentity));
            out.confirmed += Number(confirmed?.confirmed) || 0;
        }
        for (const r of receipts.values()) {
            await sendReceipt(ctx, r, now).catch((e) => console.warn('[OutsideMail] A receipt was not sent:', (e as Error)?.message ?? e));
        }
        out.ticks += await applyTicks(ctx, Array.isArray(answer?.outbox) ? answer.outbox : [], now);
        if (writeFailed || (!answer?.more && !answer?.outboxMore)) break;
    }
    return out;
}

function addReceipt(receipts: Map<string, { home: string; key: string; ids: string[] }>, env: RelayEnvelope): void {
    if (env.kind !== 'dm-line') return;
    const k = `${env.senderKey}@${env.senderHome}`;
    const r = receipts.get(k) ?? { home: env.senderHome, key: env.senderKey, ids: [] };
    r.ids.push(env.itemId);
    receipts.set(k, r);
}

async function sendReceipt(ctx: OutsideMailContext, r: { home: string; key: string; ids: string[] }, now: number): Promise<void> {
    for (let i = 0; i < r.ids.length; i += 50) {
        const payload = outsideReceiptPayload(r.ids.slice(i, i + 50));
        const envelope = await envelopeFor(ctx, { kind: 'receipt', itemId: newDmMessageId(), recipient: r.key, recipientHome: r.home, at: now }, payload);
        await postItems(ctx, [{ envelope, payload }]);
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
