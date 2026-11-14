/**
 * The forum's kept copies on the phone (slice F3; scratch/fable-design/DESIGN-forums-fable.md §14 "Offline (phone)", §18, §20):
 * the front (sections, the member's standing), each section's list, and the topics the member follows or opened in the last
 * 30 days, readable with no connection. Writing needs one.
 *
 * - **A copy of the node's.** Every row here is something the node answered; the node keeps the forum. So the table is a cache
 *   (utils/db.ts CACHE_TABLES): a Force Resync drops it, and the copy's schema number brought it in, which made each phone
 *   read its copies again once (§20: no stored data changed, no conversion code).
 * - **The member's own.** Each row names the key that read it, and only that key reads it back: a members-only forum is never
 *   drawn for anyone else on this phone.
 * - **30 days.** A topic not opened for 30 days goes at the next keep, unless the member follows it.
 */
import type { SqliteLike } from './group-chat-store';

export const FORUM_KEPT_TABLE_SQL = `
        CREATE TABLE IF NOT EXISTS forum_kept (
            me TEXT NOT NULL,
            k TEXT NOT NULL,
            kind TEXT NOT NULL,
            following INTEGER NOT NULL DEFAULT 0,
            body TEXT NOT NULL,
            kept_at INTEGER NOT NULL,
            PRIMARY KEY (me, k)
        );
`;

/** How long a topic the member doesn't follow stays readable here after they last opened it. */
export const FORUM_TOPIC_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

const listKey = (sectionId: string | null) => `list:${sectionId ?? ''}`;
const topicKey = (id: string) => `topic:${id}`;

export interface ForumKeptStore {
    get<T>(me: string, kind: 'front' | 'list' | 'topic', id?: string | null): Promise<T | null>;
    keepFront(me: string, front: unknown, now?: number): Promise<void>;
    keepList(me: string, sectionId: string | null, list: { topics: { id: string }[] }, now?: number): Promise<void>;
    /** A topic read; `following` keeps it past 30 days. Topics older than 30 days that aren't followed go now. */
    keepTopic(me: string, id: string, page: unknown, following: boolean, now?: number): Promise<void>;
    /** A topic that isn't there for this member any more: out of the kept read and every kept list. */
    forgetTopic(me: string, id: string): Promise<void>;
}

const keyOf = (kind: 'front' | 'list' | 'topic', id?: string | null) => (kind === 'front' ? 'front' : kind === 'list' ? listKey(id ?? null) : topicKey(String(id)));

export function forumKeptStore(getDb: () => Promise<SqliteLike>): ForumKeptStore {
    async function put(me: string, k: string, kind: string, body: unknown, now: number, following = false) {
        const db = await getDb();
        await db.runAsync(
            `INSERT INTO forum_kept (me, k, kind, following, body, kept_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(me, k) DO UPDATE SET kind = excluded.kind, following = excluded.following, body = excluded.body, kept_at = excluded.kept_at`,
            [me, k, kind, following ? 1 : 0, JSON.stringify(body), now],
        );
    }
    return {
        async get<T>(me: string, kind: 'front' | 'list' | 'topic', id?: string | null) {
            const db = await getDb();
            const row = await db.getFirstAsync<{ body: string }>('SELECT body FROM forum_kept WHERE me = ? AND k = ?', [me, keyOf(kind, id)]);
            if (!row) return null;
            try { return JSON.parse(row.body) as T; } catch { return null; }
        },
        keepFront: (me, front, now = Date.now()) => put(me, 'front', 'front', front, now),
        keepList: (me, sectionId, list, now = Date.now()) => put(me, listKey(sectionId), 'list', list, now),
        async keepTopic(me, id, page, following, now = Date.now()) {
            await put(me, topicKey(id), 'topic', page, now, following);
            const db = await getDb();
            await db.runAsync("DELETE FROM forum_kept WHERE me = ? AND kind = 'topic' AND following = 0 AND kept_at < ?", [me, now - FORUM_TOPIC_KEPT_MS]);
        },
        async forgetTopic(me, id) {
            const db = await getDb();
            await db.runAsync('DELETE FROM forum_kept WHERE me = ? AND k = ?', [me, topicKey(id)]);
            const lists = await db.getAllAsync<{ k: string; body: string; kept_at: number }>("SELECT k, body, kept_at FROM forum_kept WHERE me = ? AND kind = 'list'", [me]);
            for (const row of lists) {
                let list: { topics: { id: string }[] };
                try { list = JSON.parse(row.body); } catch { continue; }
                if (!list?.topics?.some((t) => t.id === id)) continue;
                await put(me, row.k, 'list', { ...list, topics: list.topics.filter((t) => t.id !== id) }, row.kept_at);
            }
        },
    };
}
