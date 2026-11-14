/**
 * Chats with people in other communities, kept on this phone only (messages across communities X3: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.2, §3.4, §3.5; DESIGN-cross-community-chat-fable.md §2.4 "History and recovery").
 *
 * Nobody else keeps these lines: the other community's server held each one sealed until this phone had it, then deleted it
 * (the mailbox, X2). So the tables are not a copy of the node's. They sit in the community's file beside the group key tables
 * (utils/db.ts), are never dropped by a Force Resync (CACHE_TABLES does not name them), and go when the account leaves the
 * phone (clearDB identityLeaves). A phone restored from 12 words starts with none of them: a chat it learns of from the
 * outbox (this account wrote to them within 30 days) comes back empty and `restored`, and its banner says why.
 *
 * A chat is named from the two keys alone (core relayConversationId), so a community that changes its address does not split
 * it; the peer's home is routing, the newest one a validly signed envelope named.
 *
 * **The request gate** ({@link gateIncoming}, design §3.5): a first line from someone this account never wrote to waits as a
 * request behind the one "Message requests" row: one line only until Accept, no alert, no badge, and nothing but words (a
 * blob, a delete, any other kind from a request is dropped). Declined: dropped. A blocked key: dropped. The member's door
 * closed (they never showed their card here, or closed it in Settings): a stranger's line is dropped.
 */
import type { SqliteLike } from './group-chat-store';

/** The three tables, in every copy's schema (utils/db.ts). */
export const OUTSIDE_CHAT_TABLES_SQL = `
        CREATE TABLE IF NOT EXISTS outside_chats (
            id TEXT PRIMARY KEY,
            me TEXT NOT NULL,
            peer_key TEXT NOT NULL,
            peer_home TEXT NOT NULL,
            peer_name TEXT,
            state TEXT NOT NULL,
            restored INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outside_lines (
            id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            author TEXT NOT NULL,
            text TEXT NOT NULL,
            reply_to TEXT,
            at INTEGER NOT NULL,
            state TEXT,
            item TEXT,
            sealed TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outside_lines_chat ON outside_lines(chat_id, at);
        CREATE TABLE IF NOT EXISTS outside_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/** What clearDB drops when the account leaves the phone. */
export const OUTSIDE_CHAT_DROP_SQL = ' DROP TABLE IF EXISTS outside_chats; DROP TABLE IF EXISTS outside_lines; DROP TABLE IF EXISTS outside_meta;';

/** A chat's standing: a request waiting for the member, open (either side may write), or declined. */
export type OutsideChatState = 'request' | 'open' | 'declined';
/**
 * A line of mine: `sending` until my community's server has it (kept with its signed item, sent again at each sync),
 * then the outbox's own states (relay-outbox.ts): queued, sent, delivered, failed, expired.
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
}

/** What the gate makes of an item arriving from `peer`. */
export type GateVerdict = 'line' | 'request' | 'drop';

/**
 * The request gate, as one pure rule (design §3.5): what becomes of an item of `kind` from a sender, given the chat this
 * phone has with them (null: none), whether that chat already holds a line of theirs, the member's door, and their blocks.
 */
export function gateIncoming(input: {
    kind: string;
    chat: { state: OutsideChatState; theirLines: number } | null;
    doorOpen: boolean;
    blocked: boolean;
}): GateVerdict {
    if (input.blocked) return 'drop';
    const { chat } = input;
    if (chat?.state === 'open') return input.kind === 'dm-line' ? 'line' : 'drop';
    // From here, a stranger: words only, one line only, and only through an open door.
    if (input.kind !== 'dm-line') return 'drop';
    if (chat?.state === 'declined') return 'drop';
    if (chat?.state === 'request') return chat.theirLines === 0 ? 'request' : 'drop';
    return input.doorOpen ? 'request' : 'drop';
}

const rowToChat = (r: any): OutsideChat => ({
    id: r.id, peerKey: r.peer_key, peerHome: r.peer_home, peerName: r.peer_name ?? null, state: r.state, restored: !!r.restored,
    updatedAt: r.updated_at, lastText: r.last_text ?? null, lastAt: r.last_at ?? null,
});
const rowToLine = (r: any): OutsideLine => ({
    id: r.id, chatId: r.chat_id, author: r.author, text: r.text, replyTo: r.reply_to ?? null, at: r.at, state: r.state ?? null,
});

const CHAT_COLUMNS = `c.*, (SELECT text FROM outside_lines l WHERE l.chat_id = c.id ORDER BY at DESC LIMIT 1) AS last_text,
                      (SELECT at FROM outside_lines l WHERE l.chat_id = c.id ORDER BY at DESC LIMIT 1) AS last_at`;

/** The store over one community's file. Every read and write is for the account `me` alone. */
export function outsideChatStore(getDb: () => Promise<SqliteLike>) {
    const db = getDb;
    return {
        async chats(me: string, state?: OutsideChatState): Promise<OutsideChat[]> {
            const d = await db();
            const rows = state
                ? await d.getAllAsync<any>(`SELECT ${CHAT_COLUMNS} FROM outside_chats c WHERE me = ? AND state = ? ORDER BY updated_at DESC`, [me, state])
                : await d.getAllAsync<any>(`SELECT ${CHAT_COLUMNS} FROM outside_chats c WHERE me = ? ORDER BY updated_at DESC`, [me]);
            return rows.map(rowToChat);
        },
        async chat(me: string, id: string): Promise<OutsideChat | null> {
            const r = await (await db()).getFirstAsync<any>(`SELECT ${CHAT_COLUMNS} FROM outside_chats c WHERE me = ? AND id = ?`, [me, id]);
            return r ? rowToChat(r) : null;
        },
        async lines(chatId: string): Promise<OutsideLine[]> {
            return (await (await db()).getAllAsync<any>('SELECT * FROM outside_lines WHERE chat_id = ? ORDER BY at ASC, id ASC', [chatId])).map(rowToLine);
        },
        async hasLine(id: string): Promise<boolean> {
            return !!(await (await db()).getFirstAsync<any>('SELECT 1 AS x FROM outside_lines WHERE id = ?', [id]));
        },
        async theirLines(chatId: string, peerKey: string): Promise<number> {
            const r = await (await db()).getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outside_lines WHERE chat_id = ? AND author = ?', [chatId, peerKey]);
            return r?.n ?? 0;
        },
        /** A chat this account opens (from a card) or reopens: open, the peer's home and name as the card names them. */
        async openChat(me: string, id: string, peer: { key: string; home: string; name: string | null }, now = Date.now()): Promise<void> {
            await (await db()).runAsync(
                `INSERT INTO outside_chats (id, me, peer_key, peer_home, peer_name, state, restored, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'open', 0, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET state = 'open', peer_home = excluded.peer_home,
                     peer_name = COALESCE(excluded.peer_name, outside_chats.peer_name), updated_at = excluded.updated_at`,
                [id, me, peer.key, peer.home, peer.name, now, now],
            );
        },
        /**
         * A chat this account wrote to before this phone had it (the outbox says so, and no line of it is here): open and
         * `restored`, so its banner says why it is empty. Nothing changes for a chat this phone already has.
         */
        async noteRestored(me: string, id: string, peer: { key: string; home: string }, now = Date.now()): Promise<void> {
            await (await db()).runAsync(
                `INSERT INTO outside_chats (id, me, peer_key, peer_home, peer_name, state, restored, created_at, updated_at)
                 VALUES (?, ?, ?, ?, NULL, 'open', 1, ?, ?) ON CONFLICT(id) DO NOTHING`,
                [id, me, peer.key, peer.home, now, now],
            );
        },
        /** A line from the peer, past the gate: written, and the chat made (a request) or moved on. Idempotent by its id. */
        async writeTheirs(me: string, line: { id: string; chatId: string; author: string; text: string; replyTo: string | null; at: number; sealed: string },
            peer: { home: string; name: string | null }, verdict: 'line' | 'request', now = Date.now()): Promise<void> {
            const d = await db();
            await d.runAsync(
                `INSERT INTO outside_chats (id, me, peer_key, peer_home, peer_name, state, restored, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET peer_home = excluded.peer_home,
                     peer_name = COALESCE(excluded.peer_name, outside_chats.peer_name), updated_at = excluded.updated_at`,
                [line.chatId, me, line.author, peer.home, peer.name, verdict === 'request' ? 'request' : 'open', now, now],
            );
            await d.runAsync(
                `INSERT INTO outside_lines (id, chat_id, author, text, reply_to, at, state, item, sealed) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
                 ON CONFLICT(id) DO NOTHING`,
                [line.id, line.chatId, line.author, line.text, line.replyTo, line.at, line.sealed],
            );
        },
        /** A line of mine, before it is sent: shown at once as `sending`, its signed item kept to send again. */
        async addMine(line: { id: string; chatId: string; author: string; text: string; replyTo: string | null; at: number; item: string }, now = Date.now()): Promise<void> {
            const d = await db();
            await d.runAsync(
                `INSERT INTO outside_lines (id, chat_id, author, text, reply_to, at, state, item, sealed) VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, NULL)
                 ON CONFLICT(id) DO NOTHING`,
                [line.id, line.chatId, line.author, line.text, line.replyTo, line.at, line.item],
            );
            await d.runAsync('UPDATE outside_chats SET updated_at = ? WHERE id = ?', [now, line.chatId]);
        },
        /** My line's state as my server tells it. The signed item goes once the server has it (any state but `sending`). */
        async setMineState(id: string, state: OutsideLineState): Promise<void> {
            await (await db()).runAsync(
                `UPDATE outside_lines SET state = ?, item = CASE WHEN ? = 'sending' THEN item ELSE NULL END WHERE id = ? AND state IS NOT NULL`,
                [state, state, id],
            );
        },
        /** My lines my server has not yet taken, with their signed items, oldest first. */
        async unsent(me: string): Promise<Array<{ id: string; item: string; at: number }>> {
            return (await (await db()).getAllAsync<any>(
                `SELECT l.id, l.item, l.at FROM outside_lines l JOIN outside_chats c ON c.id = l.chat_id
                 WHERE c.me = ? AND l.author = ? AND l.state = 'sending' AND l.item IS NOT NULL ORDER BY l.at ASC LIMIT 16`, [me, me],
            )).map((r) => ({ id: r.id, item: r.item, at: r.at }));
        },
        async decide(me: string, id: string, state: 'open' | 'declined', now = Date.now()): Promise<void> {
            await (await db()).runAsync('UPDATE outside_chats SET state = ?, updated_at = ? WHERE me = ? AND id = ?', [state, now, me, id]);
        },
        async getMeta(k: string): Promise<string | null> {
            return (await (await db()).getFirstAsync<{ v: string }>('SELECT v FROM outside_meta WHERE k = ?', [k]))?.v ?? null;
        },
        async setMeta(k: string, v: string): Promise<void> {
            await (await db()).runAsync('INSERT INTO outside_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, v]);
        },
    };
}

export type OutsideChatStore = ReturnType<typeof outsideChatStore>;
