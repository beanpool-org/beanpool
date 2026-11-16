/**
 * Chats with people in other communities, kept in this browser only (messages across communities X4, the web side of the
 * phone's X3: scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.2, §3.4, §3.5; the phone's utils/outside-chat-store.ts).
 *
 * Nobody else keeps these lines: the member's community held each one sealed until every device of theirs had it, then
 * deleted it (the mailbox, X2; each device for itself, X2b). Their lines reach each phone and browser signed in when they
 * came; what I write shows only where I wrote it. So this is not a copy of the node's. Its own database
 * (`beanpool-outside-chats`), one per web address as every store of this app is, documents per community AND per account
 * (`<community> <my key>/…`: the chats, their lines, the receipts owed, and the meta, this browser's mail id and its kept
 * home among it). A store is for one community ({@link outsideChatStore}), as the phone keeps these tables in each
 * community's own file: pointed at another community (Settings' node address), the web app starts on that community's own
 * documents, with its own mail id and home, and never signs as the old one; pointed back, the old ones are there again.
 * Another account in this browser starts on its own. Sign Out and the delete at the last community clear every one of
 * them (lib/device-prefs.ts clearAccountStorage); the delete at a community the web app was pointed at that keeps the key
 * clears that community's ({@link clearOutsideChatsAt}, lib/delete-here.ts leaveThisCommunity). A browser newly signed in
 * has none of it: a chat it learns of from the outbox comes back empty and `restored`, and says why.
 *
 * A store may be given `holds` (lib/outside-mail.ts outsideContext: the account epoch it was opened under, and the
 * community the web app talks to). Once it answers false, the store opens nothing, starts no transaction and puts nothing in
 * one already begun (asked again just before its writes, as the browser may run it after a clear): a round still
 * running when Sign Out, a move to another community or the delete here clears this browser writes nothing back, into the
 * old documents or a fresh database.
 *
 * Every write is ONE transaction and resolves only once written; a write that fails THROWS, and so does a read that can't
 * be done: the mail round confirms an item (which deletes it at the server) only after its write here resolved.
 *
 * The request gate is core's (outside-chat.ts gateOutsideItem), the phone's too.
 */
import {
    outsideChangeOutcome, outsideChangesKept, outsideLineWords, type KeptOutsideChange, type OutsideChange, type OutsideChatState,
} from '@beanpool/core';

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
/**
 * A chat's changes to its lines (X6), by their item ids, as core outsideChangesKept keeps them (the phone's outside_changes):
 * each person's newest settled one of a kind for a line (theirs, applied; mine, at their community), and mine still on their
 * way that are newer (`sending`, kept with the signed `item`, or `queued`). One of mine that fails is taken out, so the line
 * falls back to the newest left. Kept even before their line is here: core outsideLineShown applies one only to a line of its
 * own chat and, for an edit or a delete, of its own maker.
 */
type Kept = KeptOutsideChange & { item: string | null };
type Changes = Record<string, Kept>;
const bare = ({ item: _item, state: _state, ...c }: Kept): OutsideChange => c;
const sameSlot = (a: Kept, b: Pick<Kept, 'lineId' | 'author' | 'kind'>) => a.lineId === b.lineId && a.author === b.author && a.kind === b.kind;
/** `changes` with the slot (line, maker, kind) of `c` pruned to what core outsideChangesKept keeps. */
function keptChanges(changes: Changes, c: Pick<Kept, 'lineId' | 'author' | 'kind'>): Changes {
    const slot = Object.values(changes).filter((x) => sameSlot(x, c));
    const kept = new Set(outsideChangesKept(slot).map((x) => x.itemId));
    return Object.fromEntries(Object.entries(changes).filter(([, x]) => !sameSlot(x, c) || kept.has(x.itemId)));
}
/**
 * What became of a change of mine, my server's answer or a tick (the phone's answerChange): failed, taken out; taken, its
 * signed item goes; at their community, it never goes back. Undefined: not a change of mine here, or nothing to do.
 */
function answered(changes: Changes | undefined, id: string, state: string): Changes | undefined {
    const was = changes?.[id];
    const outcome = outsideChangeOutcome(state);
    if (!changes || !was || was.state === null || !outcome || was.state === 'sent') return undefined;
    const next = { ...changes };
    if (outcome === 'failed') delete next[id];
    else next[id] = { ...was, state: outcome, item: null };
    return keptChanges(next, was);
}
/** A chat's row with its newest line as the chat shows it (core outsideLineWords, the bubble's rule): deleted, or its newest edit. */
function shownLast(chat: OutsideChat, lines: OutsideLine[] | undefined, changes: Changes | undefined, me: string): OutsideChat {
    const last = lines?.length ? lines[lines.length - 1] : null;
    if (!last) return chat;
    return { ...chat, lastText: outsideLineWords(last, Object.values(changes ?? {}).map(bare), me), lastAt: last.at };
}

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

/** Thrown, with nothing opened or started, once a store's `holds` says it no longer acts for its account and community. */
const leftHere = () => Object.assign(new Error('This browser no longer holds these chats for this account here.'), { name: 'AbortError' });

/** `keys`, read in one transaction; throws when they can't be, or once `holds` answers false. */
async function readDocs(keys: string[], holds: () => boolean): Promise<unknown[]> {
    if (!holds()) throw leftHere();
    const db = await openDb();
    if (!holds()) throw leftHere();
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each caller names its documents' types as a tuple
async function changeDocs(keys: string[], next: (values: any) => unknown[], holds: () => boolean): Promise<void> {
    if (!holds()) throw leftHere();
    const db = await openDb();
    if (!holds()) throw leftHere();
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
                // Checked again inside the transaction: once `holds` answers false, nothing is put, whenever it was begun.
                if (!holds()) { tx.abort(); reject(leftHere()); return; }
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

/**
 * The community a store is for, however its address is typed (case, the default port, a trailing /): its origin, as the
 * web app compares communities elsewhere (lib/web-push.ts webPushOrigin, lib/delete-here.ts). An address that isn't a URL is
 * kept as written, lower-cased.
 */
export function outsideCommunityOf(nodeUrl: string): string {
    const raw = String(nodeUrl ?? '').trim().replace(/\/+$/, '');
    try { return new URL(raw).origin; } catch { return raw.toLowerCase(); }
}

/** Every document of `community` starts with this; no origin holds a space, so one community's never runs into another's. */
const communityPrefix = (community: string) => `${outsideCommunityOf(community)} `;
const byTime = (a: OutsideLine, b: OutsideLine) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A chat's row with `line` as its newest, when it is. */
function withLast(chat: OutsideChat, line: OutsideLine, now: number): OutsideChat {
    const newer = chat.lastAt === null || line.at >= chat.lastAt;
    return { ...chat, updatedAt: now, ...(newer ? { lastText: line.text, lastAt: line.at } : {}) };
}

/**
 * The store of `community` (the address the web app talks to: lib/outside-mail.ts ctx.nodeUrl), in this browser's web
 * address. Every read and write is for the account `me` alone, at that community alone. With `holds`, nothing is opened or
 * started once it answers false.
 */
export function outsideChatStore(community: string, holds: () => boolean = () => true) {
    const at = communityPrefix(community);
    const chatsKey = (me: string) => `${at}${me}/chats`;
    const linesKey = (me: string, chatId: string) => `${at}${me}/lines/${chatId}`;
    const metaKey = (me: string) => `${at}${me}/meta`;
    const receiptsKey = (me: string) => `${at}${me}/receipts`;
    const changesKey = (me: string, chatId: string) => `${at}${me}/changes/${chatId}`;
    const read = (keys: string[]) => readDocs(keys, holds);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each caller names its documents' types as a tuple
    const change = (keys: string[], next: (values: any) => unknown[]) => changeDocs(keys, next, holds);
    return {
        /** The community this store is for, as its documents name it. */
        community: outsideCommunityOf(community),
        /** The chats, each with its newest line as the chat shows it (a deleted line reads as deleted, an edited one as its edit). */
        async chats(me: string, state?: OutsideChatState): Promise<OutsideChat[]> {
            const [chats] = await read([chatsKey(me)]) as [Chats | undefined];
            const list = Object.values(chats ?? {}).filter((c) => !state || c.state === state).sort((a, b) => b.updatedAt - a.updatedAt);
            if (!list.length) return [];
            const docs = await read(list.flatMap((c) => [linesKey(me, c.id), changesKey(me, c.id)]));
            return list.map((c, i) => shownLast(c, docs[2 * i] as OutsideLine[] | undefined, docs[2 * i + 1] as Changes | undefined, me));
        },
        async chat(me: string, id: string): Promise<OutsideChat | null> {
            const [chats, lines, changes] = await read([chatsKey(me), linesKey(me, id), changesKey(me, id)]) as [Chats | undefined, OutsideLine[] | undefined, Changes | undefined];
            const chat = chats?.[id];
            return chat ? shownLast(chat, lines, changes, me) : null;
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
        /**
         * A chat this account wrote to that this browser lacks the line of (the outbox says so): a browser newly signed in, or
         * a line written on another phone or browser (X2b). None here: made open and `restored`, so it says why it is empty. A
         * request or a decline here: opened, since I wrote to them (DECISION-outside-door.md). An open chat stays as it is.
         * True when this changed anything. The phone's noteRestored, the same rule.
         */
        async noteRestored(me: string, id: string, peer: { key: string; home: string }, now = Date.now()): Promise<boolean> {
            let changed = false;
            await change([chatsKey(me)], ([chats]: [Chats | undefined]) => {
                const was = chats?.[id];
                if (!was) {
                    changed = true;
                    return [{ ...chats, [id]: { id, peerKey: peer.key, peerHome: peer.home, peerName: null, state: 'open', restored: true, updatedAt: now, lastText: null, lastAt: null } }];
                }
                if (was.state !== 'request' && was.state !== 'declined') return [undefined];
                changed = true;
                return [{ ...chats, [id]: { ...was, state: 'open', updatedAt: now } }];
            });
            return changed;
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
        /**
         * My line's state as my server tells it: its signed item goes once the server has it; `note` kept on a failed line only.
         * A change of mine (X6), the same answer, in the same transaction (answerChange's rule).
         */
        async setMineState(me: string, chatId: string, id: string, state: OutsideLineState, note: string | null = null): Promise<void> {
            await change([linesKey(me, chatId), changesKey(me, chatId)], ([lines, changes]: [OutsideLine[] | undefined, Changes | undefined]) => {
                const nextChanges = answered(changes, id, state);
                if (!lines?.some((l) => l.id === id && l.state !== null)) return [undefined, nextChanges];
                return [lines.map((l) => (l.id === id && l.state !== null
                    ? { ...l, state, item: state === 'sending' ? l.item : null, note: state === 'failed' ? note : null } : l)), nextChanges];
            });
        },
        /** My lines, and my changes to lines (X6), that my server has not yet taken, with their signed items, oldest first, 16 at most. */
        async unsent(me: string): Promise<Array<{ id: string; chatId: string; item: string; at: number }>> {
            const ids = Object.keys((await read([chatsKey(me)]) as [Chats | undefined])[0] ?? {});
            if (!ids.length) return [];
            const all = (await read(ids.map((id) => linesKey(me, id)))) as Array<OutsideLine[] | undefined>;
            const changes = (await read(ids.map((id) => changesKey(me, id)))) as Array<Changes | undefined>;
            const lines = all.flatMap((ls) => ls ?? []).filter((l) => l.author === me && l.state === 'sending' && l.item)
                .map((l) => ({ id: l.id, chatId: l.chatId, item: l.item as string, at: l.at }));
            const mine = changes.flatMap((cs, i) => Object.values(cs ?? {}).filter((c) => c.author === me && c.state === 'sending' && c.item)
                .map((c) => ({ id: c.itemId, chatId: ids[i], item: c.item as string, at: c.at })));
            return [...lines, ...mine].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 16);
        },
        /** Every change to the lines of chat `chatId` this browser keeps (X6): settled, and mine still on their way. */
        async changes(me: string, chatId: string): Promise<OutsideChange[]> {
            const [changes] = await read([changesKey(me, chatId)]) as [Changes | undefined];
            return Object.values(changes ?? {}).map(bare);
        },
        /**
         * A change kept, then its maker's changes of its kind to that line pruned to what core outsideChangesKept keeps (an
         * older one of theirs changes nothing). `item`: a change of mine, kept `sending` with its signed item until my server
         * answers; without it, theirs, applied.
         */
        async putChange(me: string, chatId: string, c: OutsideChange, item: string | null = null): Promise<void> {
            await change([changesKey(me, chatId)], ([changes]: [Changes | undefined]) => {
                if (changes?.[c.itemId]) return [undefined];
                return [keptChanges({ ...changes, [c.itemId]: { ...c, state: item === null ? null : 'sending', item } }, c)];
            });
        },
        /**
         * What became of a change of mine (X6), my server's answer or a tick, whichever way it came (a first send, a resend, a
         * refusal, ageing out, the switch read off, its outbox): failed, it is taken out, and the line falls back to the newest
         * change left; taken, its signed item goes. True when this browser has it as mine. The phone's answerChange.
         */
        async answerChange(me: string, chatId: string, id: string, state: string): Promise<boolean> {
            let mine = false;
            await change([changesKey(me, chatId)], ([changes]: [Changes | undefined]) => {
                mine = !!changes?.[id] && changes[id].state !== null;
                return [answered(changes, id, state)];
            });
            return mine;
        },
        /**
         * A delete of line `lineId` (X6), mine or its writer's, stops whatever of mine for that line has not left this browser:
         * the line itself, mine and still `sending`, never goes (failed, its item gone, so its words never reach them; my delete
         * goes after it, in case my server took it unanswered), nor my edits and reactions to it still `sending`. The phone's
         * stopUnsentOf.
         */
        async stopUnsentOf(me: string, chatId: string, lineId: string): Promise<void> {
            await change([linesKey(me, chatId), changesKey(me, chatId)], ([lines, changes]: [OutsideLine[] | undefined, Changes | undefined]) => {
                const stop = (l: OutsideLine) => l.id === lineId && l.author === me && l.state === 'sending';
                const goes = (c: Kept) => c.lineId === lineId && c.author === me && c.kind !== 'dm-delete' && c.state === 'sending';
                return [
                    lines?.some(stop) ? lines.map((l) => (stop(l) ? { ...l, state: 'failed' as const, item: null, note: null } : l)) : undefined,
                    Object.values(changes ?? {}).some(goes) ? Object.fromEntries(Object.entries(changes ?? {}).filter(([, c]) => !goes(c))) : undefined,
                ];
            });
        },
        /**
         * The line `id`, in chat `chatId` or any other here, and whether its writer deleted it for everyone (their delete applied,
         * or mine at their community: one of mine still on its way may yet fail); null when it isn't here.
         */
        async lineOf(me: string, chatId: string, id: string): Promise<{ chatId: string; author: string; deleted: boolean } | null> {
            const ids = [chatId, ...Object.keys((await read([chatsKey(me)]) as [Chats | undefined])[0] ?? {}).filter((c) => c !== chatId)];
            for (const c of ids) {
                const [lines, changes] = await read([linesKey(me, c), changesKey(me, c)]) as [OutsideLine[] | undefined, Changes | undefined];
                const line = lines?.find((l) => l.id === id);
                if (!line) continue;
                const deleted = Object.values(changes ?? {}).some((x) => x.lineId === id && x.author === line.author && x.kind === 'dm-delete'
                    && (x.state === null || x.state === 'sent'));
                return { chatId: c, author: line.author, deleted };
            }
            return null;
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
        /**
         * `k`'s value when it has one `fit` takes, else `make()`'s, kept as it: read and written in ONE transaction, so two tabs
         * asking at once get the same value (the browser runs one readwrite transaction on a store at a time).
         */
        async metaOrMake(me: string, k: string, fit: (v: string) => boolean, make: () => string): Promise<string> {
            let value = '';
            await change([metaKey(me)], ([meta]: [Record<string, string> | undefined]) => {
                const kept = meta?.[k];
                if (kept && fit(kept)) { value = kept; return [undefined]; }
                value = make();
                return [{ ...meta, [k]: value }];
            });
            return value;
        },
    };
}

export type OutsideChatStore = ReturnType<typeof outsideChatStore>;

type KeyRangeMaker = { bound(lower: string, upper: string, lowerOpen?: boolean, upperOpen?: boolean): unknown };

/**
 * The delete at a community the web app was pointed at that keeps the key (lib/delete-here.ts leaveThisCommunity): every
 * document of `community` goes, for every account, in one transaction; every other community's stays. Never throws; false
 * when they could not be cleared.
 */
export async function clearOutsideChatsAt(community: string): Promise<boolean> {
    const prefix = communityPrefix(community);
    const KeyRange: KeyRangeMaker | undefined = typeof IDBKeyRange !== 'undefined'
        ? IDBKeyRange : (globalThis as unknown as { IDBKeyRange?: KeyRangeMaker }).IDBKeyRange;
    if (!KeyRange || prefix === ' ') return false;
    try {
        const db = await openDb();
        return await new Promise<boolean>((resolve) => {
            try {
                const tx = db.transaction(STORE, 'readwrite');
                (tx.objectStore(STORE) as unknown as { delete(r: unknown): unknown }).delete(KeyRange.bound(prefix, `${prefix}\uffff`));
                tx.oncomplete = () => resolve(true);
                tx.onabort = () => resolve(false);
                tx.onerror = () => resolve(false);
            } catch {
                resolve(false);
            }
        });
    } catch {
        return false;
    }
}

/** Sign Out, and the delete at the last community: every account's outside chats in this browser, at every community, go. Never throws. */
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
