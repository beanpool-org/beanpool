/**
 * Chats with people in other communities, kept on this phone only (messages across communities X3: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.2, §3.4, §3.5; DESIGN-cross-community-chat-fable.md §2.4 "History and recovery").
 *
 * Nobody else keeps these lines: the member's community held each one sealed until every device of theirs had it, then
 * deleted it (the mailbox, X2; each device for itself, X2b). Their lines reach each phone and browser signed in when they
 * came; what I write shows only where I wrote it. So the tables are not a copy of the node's. They sit in the community's file beside the group key tables
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
import {
    gateOutsideItem, outsideChangeOutcome, outsideChangesKept, outsideLineWords, type KeptOutsideChange, type OutsideChange,
    type OutsideChatState as CoreOutsideChatState, type OutsideGateVerdict,
} from '@beanpool/core';
import type { SqliteLike } from './group-chat-store';

/**
 * The tables, in every copy's schema (utils/db.ts). `outside_receipts`: the receipts this phone still owes (outside-mail.ts).
 * `outside_changes` (X6): edits, reactions and deletes of lines, a row each, as core outsideChangesKept keeps them: each
 * person's newest settled one of a kind for a line (theirs, applied; mine, at their community), and mine still on their way
 * that are newer (`state` sending, kept with the signed `item`, or queued). One of mine that fails is taken out, so the line
 * falls back to the newest left. Kept even before their line is here (a change can come first): core outsideLineShown
 * applies one only to a line of its own chat and, for an edit or a delete, of its own maker.
 */
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
            sealed TEXT,
            note TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outside_lines_chat ON outside_lines(chat_id, at);
        CREATE TABLE IF NOT EXISTS outside_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outside_receipts (
            id TEXT PRIMARY KEY,
            me TEXT NOT NULL,
            peer_key TEXT NOT NULL,
            peer_home TEXT NOT NULL,
            owed_at INTEGER NOT NULL,
            tried_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS outside_changes (
            item_id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            line_id TEXT NOT NULL,
            author TEXT NOT NULL,
            kind TEXT NOT NULL,
            at INTEGER NOT NULL,
            text TEXT,
            emoji TEXT,
            state TEXT,
            item TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outside_changes_line ON outside_changes(chat_id, line_id);
`;

/**
 * The mark of a chat whose receipts are held (core outsideReceiptWhen), in `outside_meta`, one row per chat:
 * `receipts-held:<my key>:<their key>`, its value the chat's id. Kept in the meta table every copy already has, so a
 * community's file the phone holds in place needs nothing new.
 */
export const RECEIPTS_HELD_META = 'receipts-held:';
const heldKey = (me: string, peerKey: string) => `${RECEIPTS_HELD_META}${me}:${peerKey}`;

/** What clearDB drops when the account leaves the phone. */
export const OUTSIDE_CHAT_DROP_SQL = ' DROP TABLE IF EXISTS outside_chats; DROP TABLE IF EXISTS outside_lines; DROP TABLE IF EXISTS outside_meta; DROP TABLE IF EXISTS outside_receipts; DROP TABLE IF EXISTS outside_changes;';

/** A chat's standing: a request waiting for the member, open (either side may write), or declined. */
export type OutsideChatState = CoreOutsideChatState;
/**
 * A line of mine: `sending` until my community's server has it (kept with its signed item, sent again at each sync),
 * then the outbox's own states (relay-outbox.ts): queued, sent, delivered, failed, expired. A line my server refused is
 * `failed` with its words kept beside it (`note`): why it will never go.
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
    /** Why a line of mine failed, in my server's words (or ours when it gave none); null otherwise. */
    note: string | null;
}

/** What the gate makes of an item arriving from `peer`. */
export type GateVerdict = OutsideGateVerdict;

/**
 * The request gate, as one pure rule (design §3.5), shared with the web: core outside-chat.ts gateOutsideItem.
 */
export const gateIncoming = gateOutsideItem;

const rowToChat = (r: any): OutsideChat => ({
    id: r.id, peerKey: r.peer_key, peerHome: r.peer_home, peerName: r.peer_name ?? null, state: r.state, restored: !!r.restored,
    updatedAt: r.updated_at, lastText: r.last_text ?? null, lastAt: r.last_at ?? null,
});
const rowToLine = (r: any): OutsideLine => ({
    id: r.id, chatId: r.chat_id, author: r.author, text: r.text, replyTo: r.reply_to ?? null, at: r.at, state: r.state ?? null,
    note: r.state === 'failed' ? r.note ?? null : null,
});

const CHAT_COLUMNS = `c.*, (SELECT id FROM outside_lines l WHERE l.chat_id = c.id ORDER BY at DESC, id DESC LIMIT 1) AS last_id`;
const rowToChange = (r: any): KeptOutsideChange => ({
    kind: r.kind, itemId: r.item_id, lineId: r.line_id, author: r.author, at: r.at, state: r.state ?? null,
    ...(r.text !== null ? { text: r.text } : {}), ...(r.emoji !== null ? { emoji: r.emoji } : {}),
});
const bare = ({ state: _state, ...c }: KeptOutsideChange): OutsideChange => c;

/**
 * The across chats a held copy keeps for one account (slice S4, scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3
 * "Where an across chat lives": the file of the community that carries it, visible always), read through a held, read-only
 * handle (utils/held-copies.ts runs one plain SELECT at a time, no SQL from a caller): each chat with its newest line, and
 * the changes to those newest lines. {@link outsideChatsFromHeld} makes of them what {@link outsideChatStore}'s chats() gives.
 */
export const OUTSIDE_CHATS_HELD_SQL = `
    SELECT c.id, c.peer_key, c.peer_home, c.peer_name, c.state, c.restored, c.updated_at,
           l.id AS last_id, l.author AS last_author, l.text AS last_line, l.at AS last_at
    FROM outside_chats c
    LEFT JOIN outside_lines l ON l.id = (SELECT x.id FROM outside_lines x WHERE x.chat_id = c.id ORDER BY x.at DESC, x.id DESC LIMIT 1)
    WHERE c.me = ?
    ORDER BY c.updated_at DESC
`;
export const OUTSIDE_LAST_CHANGES_HELD_SQL = `
    SELECT x.* FROM outside_changes x JOIN outside_chats c ON c.id = x.chat_id
    WHERE c.me = ? AND x.line_id = (SELECT l.id FROM outside_lines l WHERE l.chat_id = c.id ORDER BY l.at DESC, l.id DESC LIMIT 1)
`;

/** A held copy's rows of {@link OUTSIDE_CHATS_HELD_SQL} and {@link OUTSIDE_LAST_CHANGES_HELD_SQL}, as chats() gives them (its `withLast` rule). */
export function outsideChatsFromHeld(me: string, rows: any[], changeRows: any[]): OutsideChat[] {
    const changesOf = new Map<string, OutsideChange[]>();
    for (const r of changeRows) {
        const at = `${r.chat_id}\n${r.line_id}`;
        changesOf.set(at, [...(changesOf.get(at) ?? []), bare(rowToChange(r))]);
    }
    return rows.map((r) => rowToChat({
        ...r,
        last_text: r.last_id ? outsideLineWords({ id: r.last_id, author: r.last_author, text: r.last_line }, changesOf.get(`${r.id}\n${r.last_id}`) ?? [], me) : null,
        last_at: r.last_id ? r.last_at : null,
    }));
}

/** The store over one community's file. Every read and write is for the account `me` alone. */
export function outsideChatStore(getDb: () => Promise<SqliteLike>) {
    const db = getDb;
    /**
     * A chat's row, its newest line as the chat shows it (core outsideLineWords, the bubble's own rule): a deleted line reads
     * as deleted, an edited one as its newest edit, in the Chats list and its search.
     */
    const withLast = async (d: SqliteLike, me: string, r: any): Promise<OutsideChat> => {
        const line = r.last_id ? await d.getFirstAsync<any>('SELECT id, author, text, at FROM outside_lines WHERE id = ?', [r.last_id]) : null;
        if (!line) return rowToChat({ ...r, last_text: null, last_at: null });
        const changes = (await d.getAllAsync<any>('SELECT * FROM outside_changes WHERE chat_id = ? AND line_id = ?', [r.id, line.id])).map(rowToChange);
        return rowToChat({ ...r, last_text: outsideLineWords(line, changes.map(bare), me), last_at: line.at });
    };
    /** One person's changes of one kind to one line, pruned to what core outsideChangesKept keeps. */
    const keepChanges = async (d: SqliteLike, c: { chatId: string; lineId: string; author: string; kind: string }) => {
        const rows = (await d.getAllAsync<any>('SELECT * FROM outside_changes WHERE chat_id = ? AND line_id = ? AND author = ? AND kind = ?',
            [c.chatId, c.lineId, c.author, c.kind])).map(rowToChange);
        const kept = new Set(outsideChangesKept(rows).map((r) => r.itemId));
        for (const r of rows) if (!kept.has(r.itemId)) await d.runAsync('DELETE FROM outside_changes WHERE item_id = ?', [r.itemId]);
    };
    /**
     * What became of a change of mine (X6), my server's answer or a tick, whichever way it came (a first send, a resend, a
     * refusal, ageing out, the switch read off, its outbox): failed, it is taken out, and the line falls back to the newest
     * change left (core outsideChangesKept); taken, its signed item goes. True when this phone has it as mine.
     */
    const answerChange = async (id: string, state: string): Promise<boolean> => {
        const d = await db();
        const r = await d.getFirstAsync<any>('SELECT * FROM outside_changes WHERE item_id = ? AND state IS NOT NULL', [id]);
        const outcome = outsideChangeOutcome(state);
        // Never back: a change at their community stays there, whatever a later answer says.
        if (!r || !outcome || r.state === 'sent') return !!r;
        if (outcome === 'failed') await d.runAsync('DELETE FROM outside_changes WHERE item_id = ?', [id]);
        else await d.runAsync('UPDATE outside_changes SET state = ?, item = NULL WHERE item_id = ?', [outcome, id]);
        await keepChanges(d, { chatId: r.chat_id, lineId: r.line_id, author: r.author, kind: r.kind });
        return true;
    };
    return {
        async chats(me: string, state?: OutsideChatState): Promise<OutsideChat[]> {
            const d = await db();
            const rows = state
                ? await d.getAllAsync<any>(`SELECT ${CHAT_COLUMNS} FROM outside_chats c WHERE me = ? AND state = ? ORDER BY updated_at DESC`, [me, state])
                : await d.getAllAsync<any>(`SELECT ${CHAT_COLUMNS} FROM outside_chats c WHERE me = ? ORDER BY updated_at DESC`, [me]);
            const out: OutsideChat[] = [];
            for (const r of rows) out.push(await withLast(d, me, r));
            return out;
        },
        async chat(me: string, id: string): Promise<OutsideChat | null> {
            const d = await db();
            const r = await d.getFirstAsync<any>(`SELECT ${CHAT_COLUMNS} FROM outside_chats c WHERE me = ? AND id = ?`, [me, id]);
            return r ? withLast(d, me, r) : null;
        },
        async lines(chatId: string): Promise<OutsideLine[]> {
            return (await (await db()).getAllAsync<any>('SELECT * FROM outside_lines WHERE chat_id = ? ORDER BY at ASC, id ASC', [chatId])).map(rowToLine);
        },
        /**
         * A line of theirs as it came (its sender's signed envelope and sealed line), its first words, its writer and its chat:
         * what a report hands over, with the words it shows (outside-mail.ts reportOutsideLine).
         */
        async kept(id: string): Promise<{ sealed: string; text: string; author: string; chatId: string } | null> {
            const r = await (await db()).getFirstAsync<{ sealed: string; text: string; author: string; chat_id: string }>(
                'SELECT sealed, text, author, chat_id FROM outside_lines WHERE id = ? AND sealed IS NOT NULL', [id]);
            return r ? { sealed: r.sealed, text: r.text, author: r.author, chatId: r.chat_id } : null;
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
         * A chat this account wrote to that this phone lacks the line of (the outbox says so): a phone restored from 12 words,
         * or a line written on another phone or browser (X2b). None here: made open and `restored`, so its banner says why it
         * is empty. A request or a decline here: opened, since I wrote to them (DECISION-outside-door.md). An open chat stays
         * as it is. True when this changed anything.
         */
        async noteRestored(me: string, id: string, peer: { key: string; home: string }, now = Date.now()): Promise<boolean> {
            const r = await (await db()).runAsync(
                `INSERT INTO outside_chats (id, me, peer_key, peer_home, peer_name, state, restored, created_at, updated_at)
                 VALUES (?, ?, ?, ?, NULL, 'open', 1, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET state = 'open', updated_at = excluded.updated_at
                     WHERE outside_chats.me = excluded.me AND outside_chats.state IN ('request', 'declined')`,
                [id, me, peer.key, peer.home, now, now],
            );
            return Number((r as { changes?: number } | null)?.changes ?? 0) > 0;
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
        /**
         * My line's state as my server tells it. The signed item goes once the server has it (any state but `sending`).
         * `note`: why a `failed` line will never go (my server's words); kept only on a failed line.
         */
        async setMineState(id: string, state: OutsideLineState, note: string | null = null): Promise<void> {
            const d = await db();
            await d.runAsync(
                `UPDATE outside_lines SET state = ?, item = CASE WHEN ? = 'sending' THEN item ELSE NULL END,
                     note = CASE WHEN ? = 'failed' THEN ? ELSE NULL END WHERE id = ? AND state IS NOT NULL`,
                [state, state, state, note, id],
            );
            await answerChange(id, state);
        },
        answerChange,
        /** My lines, and my changes to lines (X6), that my server has not yet taken, with their signed items, oldest first. */
        async unsent(me: string): Promise<Array<{ id: string; item: string; at: number }>> {
            return (await (await db()).getAllAsync<any>(
                `SELECT id, item, at FROM (
                     SELECT l.id, l.item, l.at FROM outside_lines l JOIN outside_chats c ON c.id = l.chat_id
                     WHERE c.me = ? AND l.author = ? AND l.state = 'sending' AND l.item IS NOT NULL
                     UNION ALL
                     SELECT x.item_id AS id, x.item, x.at FROM outside_changes x JOIN outside_chats c ON c.id = x.chat_id
                     WHERE c.me = ? AND x.author = ? AND x.state = 'sending' AND x.item IS NOT NULL
                 ) ORDER BY at ASC LIMIT 16`, [me, me, me, me],
            )).map((r) => ({ id: r.id, item: r.item, at: r.at }));
        },
        /** Every change to the lines of chat `chatId` this phone keeps (X6): settled, and mine still on their way. */
        async changes(chatId: string): Promise<OutsideChange[]> {
            return (await (await db()).getAllAsync<any>('SELECT * FROM outside_changes WHERE chat_id = ?', [chatId])).map(rowToChange).map(bare);
        },
        /**
         * A change kept, then its maker's changes of its kind to that line pruned to what core outsideChangesKept keeps (an
         * older one of theirs changes nothing). `item`: a change of mine, kept `sending` with its signed item until my server
         * answers; without it, theirs, applied.
         */
        async putChange(chatId: string, c: OutsideChange, item: string | null = null): Promise<void> {
            const d = await db();
            await d.runAsync(
                `INSERT INTO outside_changes (item_id, chat_id, line_id, author, kind, at, text, emoji, state, item) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(item_id) DO NOTHING`,
                [c.itemId, chatId, c.lineId, c.author, c.kind, c.at, c.text ?? null, c.emoji ?? null, item === null ? null : 'sending', item],
            );
            await keepChanges(d, { chatId, lineId: c.lineId, author: c.author, kind: c.kind });
        },
        /**
         * A delete of line `lineId` (X6), mine or its writer's, stops whatever of mine for that line has not left this phone:
         * the line itself, mine and still `sending`, never goes (failed, its item gone, so its words never reach them; my delete
         * goes after it, in case my server took it unanswered), nor my edits and reactions to it still `sending`.
         */
        async stopUnsentOf(me: string, chatId: string, lineId: string): Promise<void> {
            const d = await db();
            await d.runAsync(`UPDATE outside_lines SET state = 'failed', item = NULL, note = NULL WHERE id = ? AND chat_id = ? AND author = ? AND state = 'sending'`,
                [lineId, chatId, me]);
            await d.runAsync(`DELETE FROM outside_changes WHERE chat_id = ? AND line_id = ? AND author = ? AND kind != 'dm-delete' AND state = 'sending'`,
                [chatId, lineId, me]);
        },
        /**
         * The line `id`, wherever it is on this phone, and whether its writer deleted it for everyone (their delete applied, or
         * mine at their community: one of mine still on its way may yet fail); null when it isn't here.
         */
        async lineOf(id: string): Promise<{ chatId: string; author: string; deleted: boolean } | null> {
            const r = await (await db()).getFirstAsync<{ chat_id: string; author: string; deleted: number }>(
                `SELECT l.chat_id, l.author, EXISTS (SELECT 1 FROM outside_changes x WHERE x.chat_id = l.chat_id AND x.line_id = l.id
                     AND x.author = l.author AND x.kind = 'dm-delete' AND (x.state IS NULL OR x.state = 'sent')) AS deleted
                 FROM outside_lines l WHERE l.id = ?`, [id],
            );
            return r ? { chatId: r.chat_id, author: r.author, deleted: !!r.deleted } : null;
        },
        /**
         * A receipt this phone owes for a line of theirs it has written, kept before that line is confirmed (which deletes it
         * at my server, so it is never fetched again): no stop between the confirm and the receipt's post (the round's
         * deadline, the app killed, the network gone, a refusal) can lose it. Once per line.
         */
        async oweReceipt(me: string, r: { id: string; key: string; home: string }, now = Date.now()): Promise<void> {
            await (await db()).runAsync(
                'INSERT INTO outside_receipts (id, me, peer_key, peer_home, owed_at, tried_at) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(id) DO NOTHING',
                [r.id, me, r.key, r.home, now],
            );
        },
        /**
         * The receipts still owed, `limit` at most: never tried first, then those tried longest ago, so one refused never holds
         * the rest. None of a chat whose receipts are held ({@link RECEIPTS_HELD_META}): they wait for the member.
         */
        async owedReceipts(me: string, limit: number): Promise<Array<{ id: string; key: string; home: string }>> {
            return (await (await db()).getAllAsync<{ id: string; peer_key: string; peer_home: string }>(
                `SELECT id, peer_key, peer_home FROM outside_receipts r WHERE me = ?
                     AND NOT EXISTS (SELECT 1 FROM outside_meta m WHERE m.k = ? || r.me || ':' || r.peer_key)
                 ORDER BY tried_at ASC, owed_at ASC, id ASC LIMIT ?`, [me, RECEIPTS_HELD_META, limit],
            )).map((r) => ({ id: r.id, key: r.peer_key, home: r.peer_home }));
        },
        /**
         * Held receipts (core outsideReceiptWhen, Marty 22 Nov 2026: a line the mark let in is Delivered only once the member
         * accepts, answers or opens its chat): the chat with `peerKey` marked held, before its line is written, so no stop
         * between leaves a line of that chat receipted. Its receipts are owed as any other's and never sent while it is.
         */
        async holdReceipts(me: string, peerKey: string, chatId: string): Promise<void> {
            await (await db()).runAsync('INSERT INTO outside_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING', [heldKey(me, peerKey), chatId]);
        },
        /** Whether the chat with `peerKey` holds its receipts. */
        async receiptsHeld(me: string, peerKey: string): Promise<boolean> {
            return !!(await (await db()).getFirstAsync<any>('SELECT 1 AS x FROM outside_meta WHERE k = ?', [heldKey(me, peerKey)]));
        },
        /** Every peer whose chat holds its receipts, for a round's look at their blocks. */
        async heldReceiptPeers(me: string): Promise<string[]> {
            const at = heldKey(me, '');
            return (await (await db()).getAllAsync<{ k: string }>('SELECT k FROM outside_meta WHERE substr(k, 1, ?) = ?', [at.length, at]))
                .map((r) => r.k.slice(at.length));
        },
        /** The chat with `peerKey` lets its receipts go: those owed are sent at the next round, and its lines are receipted from now. */
        async releaseReceipts(me: string, peerKey: string): Promise<void> {
            await (await db()).runAsync('DELETE FROM outside_meta WHERE k = ?', [heldKey(me, peerKey)]);
        },
        /** The receipts a held chat with `peerKey` owes, never to be sent (a block); the chat stays held. */
        async forgetHeldReceipts(me: string, peerKey: string): Promise<void> {
            const d = await db();
            if (!(await d.getFirstAsync<any>('SELECT 1 AS x FROM outside_meta WHERE k = ?', [heldKey(me, peerKey)]))) return;
            await d.runAsync('DELETE FROM outside_receipts WHERE me = ? AND peer_key = ?', [me, peerKey]);
        },
        /** Receipts my server took: owed no more. */
        async receiptsSent(ids: string[]): Promise<void> {
            if (ids.length) await (await db()).runAsync(`DELETE FROM outside_receipts WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
        },
        /** Receipts my server didn't take: still owed, behind the rest. */
        async receiptsTried(ids: string[], now = Date.now()): Promise<void> {
            if (ids.length) await (await db()).runAsync(`UPDATE outside_receipts SET tried_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`, [now, ...ids]);
        },
        /** Receipts owed since before `before`: given up, unsent. */
        async forgetReceiptsOwedBefore(me: string, before: number): Promise<void> {
            await (await db()).runAsync('DELETE FROM outside_receipts WHERE me = ? AND owed_at < ?', [me, before]);
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
