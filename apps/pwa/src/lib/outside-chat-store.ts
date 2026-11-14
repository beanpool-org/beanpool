/**
 * Chats with people in other communities, kept in this browser only (messages across communities X4, the web side of the
 * phone's X3: scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.2, §3.4, §3.5; the phone's utils/outside-chat-store.ts).
 *
 * Nobody else keeps these lines: the other community's server held each one sealed until a device of this member's had it,
 * then deleted it (the mailbox, X2). So this is not a copy of the node's. Its own database (`beanpool-outside-chats`), one
 * per web address as every store of this app is, documents per account (`<my key>/…`), so another account in this browser
 * starts on its own. Sign Out and the delete at the last community clear it (lib/device-prefs.ts clearAccountStorage). A
 * browser newly signed in has none of it: a chat it learns of from the outbox comes back empty and `restored`, and says why.
 *
 * Every write is ONE transaction and resolves only once written; a write that fails THROWS, and so does a read that can't
 * be done: the mail round confirms an item (which deletes it at the server) only after its write here resolved.
 *
 * The request gate is core's (outside-chat.ts gateOutsideItem), the phone's too.
 */
import type { OutsideChatState } from '@beanpool/core';

const DB_NAME = 'beanpool-outside-chats';
const STORE = 'docs';

/**
 * A line of mine: `sending` until my community's server has it (kept with its signed item, sent again at each round), then
 * the outbox's own states (relay-outbox.ts). A line my server refused is `failed` with its words beside it (`note`).
 */
export type OutsideLineState = 'sending' | 'queued' | 'sent' | 'delivered' | 'failed' | 'expired';

export interface OutsideChat {
    id: string;
    peerKey: string;
    peerHome: string;
    peerName: string | null;
    state: OutsideChatState;
    restored: boolean;
    updatedAt: number;
    lastText: string | null;
    lastAt: number | null;
}

export interface OutsideLine {
    id: string;
    chatId: string;
    author: string;
    text: string;
    replyTo: string | null;
    at: number;
    state: OutsideLineState | null;
    /** A line of mine my server hasn't taken: its signed item, to send again. */
    item: string | null;
    /** Why a line of mine failed, in my server's words; null otherwise. */
    note: string | null;
}

interface Receipt { id: string; key: string; home: string; owedAt: number; triedAt: number }
type Chats = Record<string, OutsideChat>;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('This browser has no IndexedDB.');
            req = indexedDB.open(DB_NAME, 1);
        } catch (e) {
            reject(e);
            return;
        }
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => {
            const db = req.result;
            // Another tab's Sign Out deletes the database: let go of it at once, and open afresh next time.
            (db as IDBDatabase & { onversionchange: unknown }).onversionchange = () => {
                try { db.close(); } catch { /* already closed */ }
                if (dbPromise === p) dbPromise = null;
            };
            resolve(db);
        };
        req.onerror = () => reject(req.error ?? new Error('The outside chats store did not open.'));
        (req as IDBOpenDBRequest & { onblocked: unknown }).onblocked = () => reject(new Error('The outside chats store is blocked.'));
    });
    dbPromise = p;
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
    return p;
}

/** `keys`, read in one transaction; throws when they can't be. */
async function read(keys: string[]): Promise<unknown[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const out: unknown[] = new Array(keys.length);
        let left = keys.length;
        keys.forEach((k, i) => {
            const r = store.get(k);
            r.onsuccess = () => { out[i] = r.result; if (--left === 0) resolve(out); };
            r.onerror = () => reject(r.error ?? new Error('The outside chats store did not read.'));
        });
        tx.onabort = () => reject(tx.error ?? new Error('The outside chats store did not read.'));
    });
}

/**
 * `keys` changed in ONE transaction: `next` gets their values and gives the new ones (undefined: left as it is). Resolves
 * once written; throws, with nothing written, when the transaction fails (a full disk aborts it) or `next` throws.
 */
async function change(keys: string[], next: (values: any[]) => unknown[]): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        let tx: IDBTransaction;
        try { tx = db.transaction(STORE, 'readwrite'); } catch (e) { reject(e); return; }
        const store = tx.objectStore(STORE);
        const values: unknown[] = new Array(keys.length);
        let left = keys.length;
        keys.forEach((k, i) => {
            const r = store.get(k);
            r.onsuccess = () => {
                values[i] = r.result;
                if (--left > 0) return;
                let out: unknown[];
                try { out = next(values); } catch (e) { tx.abort(); reject(e); return; }
                out.forEach((v, j) => { if (v !== undefined) store.put(v, keys[j]); });
            };
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('The outside chats store did not write.'));
        tx.onerror = () => reject(tx.error ?? new Error('The outside chats store did not write.'));
    });
}

const chatsKey = (me: string) => `${me}/chats`;
const linesKey = (me: string, chatId: string) => `${me}/lines/${chatId}`;
const metaKey = (me: string) => `${me}/meta`;
const receiptsKey = (me: string) => `${me}/receipts`;
const byTime = (a: OutsideLine, b: OutsideLine) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A chat's row with `line` as its newest, when it is. */
function withLast(chat: OutsideChat, line: OutsideLine, now: number): OutsideChat {
    const newer = chat.lastAt === null || line.at >= chat.lastAt;
    return { ...chat, updatedAt: now, ...(newer ? { lastText: line.text, lastAt: line.at } : {}) };
}

/** The store, for this browser's web address. Every read and write is for the account `me` alone. */
export function outsideChatStore() {
    return {
        async chats(me: string, state?: OutsideChatState): Promise<OutsideChat[]> {
            const [chats] = await read([chatsKey(me)]) as [Chats | undefined];
            return Object.values(chats ?? {}).filter((c) => !state || c.state === state).sort((a, b) => b.updatedAt - a.updatedAt);
        },
        async chat(me: string, id: string): Promise<OutsideChat | null> {
            const [chats] = await read([chatsKey(me)]) as [Chats | undefined];
            return chats?.[id] ?? null;
        },
        async lines(me: string, chatId: string): Promise<OutsideLine[]> {
            const [lines] = await read([linesKey(me, chatId)]) as [OutsideLine[] | undefined];
            return lines ?? [];
        },
        async hasLine(me: string, chatId: string, id: string): Promise<boolean> {
            return (await this.lines(me, chatId)).some((l) => l.id === id);
        },
        async theirLines(me: string, chatId: string, peerKey: string): Promise<number> {
            return (await this.lines(me, chatId)).filter((l) => l.author === peerKey).length;
        },
        /** A chat this account opens (from a card) or reopens: open, the peer's home and name as the card names them. */
        async openChat(me: string, id: string, peer: { key: string; home: string; name: string | null }, now = Date.now()): Promise<void> {
            await change([chatsKey(me)], ([chats]: [Chats | undefined]) => {
                const was = chats?.[id];
                const chat: OutsideChat = was
                    ? { ...was, state: 'open', peerHome: peer.home, peerName: peer.name ?? was.peerName, updatedAt: now }
                    : { id, peerKey: peer.key, peerHome: peer.home, peerName: peer.name, state: 'open', restored: false, updatedAt: now, lastText: null, lastAt: null };
                return [{ ...chats, [id]: chat }];
            });
        },
        /** A chat this account wrote to before this browser had it (the outbox says so): open and `restored`. Nothing changes for one it has. */
        async noteRestored(me: string, id: string, peer: { key: string; home: string }, now = Date.now()): Promise<void> {
            await change([chatsKey(me)], ([chats]: [Chats | undefined]) => (chats?.[id] ? [undefined] : [{
                ...chats, [id]: { id, peerKey: peer.key, peerHome: peer.home, peerName: null, state: 'open', restored: true, updatedAt: now, lastText: null, lastAt: null },
            }]));
        },
        /** A line from the peer, past the gate: written with its chat (made a request, or moved on), in one transaction. Idempotent by id. */
        async writeTheirs(me: string, line: { id: string; chatId: string; author: string; text: string; replyTo: string | null; at: number },
            peer: { home: string; name: string | null }, verdict: 'line' | 'request', now = Date.now()): Promise<void> {
            await change([chatsKey(me), linesKey(me, line.chatId)], ([chats, lines]: [Chats | undefined, OutsideLine[] | undefined]) => {
                const row: OutsideLine = { ...line, state: null, item: null, note: null };
                const was = chats?.[line.chatId];
                const chat: OutsideChat = was
                    ? { ...was, peerHome: peer.home, peerName: peer.name ?? was.peerName }
                    : { id: line.chatId, peerKey: line.author, peerHome: peer.home, peerName: peer.name, state: verdict === 'request' ? 'request' : 'open', restored: false, updatedAt: now, lastText: null, lastAt: null };
                const had = (lines ?? []).some((l) => l.id === line.id);
                return [{ ...chats, [line.chatId]: withLast(chat, row, now) }, had ? undefined : [...(lines ?? []), row].sort(byTime)];
            });
        },
        /** A line of mine, before it is sent: shown at once as `sending`, its signed item kept to send again. */
        async addMine(me: string, line: { id: string; chatId: string; author: string; text: string; replyTo: string | null; at: number; item: string }, now = Date.now()): Promise<void> {
            await change([chatsKey(me), linesKey(me, line.chatId)], ([chats, lines]: [Chats | undefined, OutsideLine[] | undefined]) => {
                const chat = chats?.[line.chatId];
                if (!chat) throw new Error('No such chat in this browser.');
                const row: OutsideLine = { ...line, state: 'sending', note: null };
                if ((lines ?? []).some((l) => l.id === line.id)) return [undefined, undefined];
                return [{ ...chats, [line.chatId]: withLast(chat, row, now) }, [...(lines ?? []), row].sort(byTime)];
            });
        },
        /** My line's state as my server tells it: its signed item goes once the server has it; `note` kept on a failed line only. */
        async setMineState(me: string, chatId: string, id: string, state: OutsideLineState, note: string | null = null): Promise<void> {
            await change([linesKey(me, chatId)], ([lines]: [OutsideLine[] | undefined]) => {
                if (!lines?.some((l) => l.id === id && l.state !== null)) return [undefined];
                return [lines.map((l) => (l.id === id && l.state !== null
                    ? { ...l, state, item: state === 'sending' ? l.item : null, note: state === 'failed' ? note : null } : l))];
            });
        },
        /** My lines my server has not yet taken, with their signed items, oldest first, 16 at most. */
        async unsent(me: string): Promise<Array<{ id: string; chatId: string; item: string; at: number }>> {
            const ids = Object.keys((await read([chatsKey(me)]) as [Chats | undefined])[0] ?? {});
            if (!ids.length) return [];
            const all = (await read(ids.map((id) => linesKey(me, id)))) as Array<OutsideLine[] | undefined>;
            return all.flatMap((lines) => lines ?? []).filter((l) => l.author === me && l.state === 'sending' && l.item)
                .sort(byTime).slice(0, 16).map((l) => ({ id: l.id, chatId: l.chatId, item: l.item as string, at: l.at }));
        },
        /** A receipt owed for a line of theirs written here, kept before that line is confirmed. Once per line. */
        async oweReceipt(me: string, r: { id: string; key: string; home: string }, now = Date.now()): Promise<void> {
            await change([receiptsKey(me)], ([owed]: [Record<string, Receipt> | undefined]) => (owed?.[r.id] ? [undefined]
                : [{ ...owed, [r.id]: { ...r, owedAt: now, triedAt: 0 } }]));
        },
        /** The receipts still owed, `limit` at most: never tried first, then those tried longest ago. */
        async owedReceipts(me: string, limit: number): Promise<Array<{ id: string; key: string; home: string }>> {
            const [owed] = await read([receiptsKey(me)]) as [Record<string, Receipt> | undefined];
            return Object.values(owed ?? {}).sort((a, b) => a.triedAt - b.triedAt || a.owedAt - b.owedAt || (a.id < b.id ? -1 : 1))
                .slice(0, limit).map(({ id, key, home }) => ({ id, key, home }));
        },
        /** Receipts my server took: owed no more. */
        async receiptsSent(me: string, ids: string[]): Promise<void> {
            await change([receiptsKey(me)], ([owed]: [Record<string, Receipt> | undefined]) => {
                const left = { ...owed };
                for (const id of ids) delete left[id];
                return [left];
            });
        },
        /** Receipts my server didn't take: still owed, behind the rest. */
        async receiptsTried(me: string, ids: string[], now = Date.now()): Promise<void> {
            await change([receiptsKey(me)], ([owed]: [Record<string, Receipt> | undefined]) => [Object.fromEntries(Object.entries(owed ?? {})
                .map(([id, r]) => [id, ids.includes(id) ? { ...r, triedAt: now } : r]))]);
        },
        /** Receipts owed since before `before`: given up, unsent. */
        async forgetReceiptsOwedBefore(me: string, before: number): Promise<void> {
            await change([receiptsKey(me)], ([owed]: [Record<string, Receipt> | undefined]) => [Object.fromEntries(Object.entries(owed ?? {})
                .filter(([, r]) => r.owedAt >= before))]);
        },
        async decide(me: string, id: string, state: 'open' | 'declined', now = Date.now()): Promise<void> {
            await change([chatsKey(me)], ([chats]: [Chats | undefined]) => (chats?.[id] ? [{ ...chats, [id]: { ...chats[id], state, updatedAt: now } }] : [undefined]));
        },
        async getMeta(me: string, k: string): Promise<string | null> {
            const [meta] = await read([metaKey(me)]) as [Record<string, string> | undefined];
            return meta?.[k] ?? null;
        },
        async setMeta(me: string, k: string, v: string): Promise<void> {
            await change([metaKey(me)], ([meta]: [Record<string, string> | undefined]) => [{ ...meta, [k]: v }]);
        },
    };
}

export type OutsideChatStore = ReturnType<typeof outsideChatStore>;

/** Sign Out, and the delete at the last community: every account's outside chats in this browser go. Never throws. */
export async function clearOutsideChats(): Promise<void> {
    const open = dbPromise;
    dbPromise = null;
    try { (await open)?.close(); } catch { /* not open */ }
    await new Promise<void>((resolve) => {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB) { resolve(); return; }
            const req = indexedDB.deleteDatabase(DB_NAME);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            (req as IDBOpenDBRequest & { onblocked: unknown }).onblocked = () => resolve();
        } catch {
            resolve();
        }
    });
}
