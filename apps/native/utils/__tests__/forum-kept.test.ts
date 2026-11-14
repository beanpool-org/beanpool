/**
 * The forum's kept copies on the phone (slice F3; utils/forum-kept.ts, DESIGN-forums-fable.md §14 "Offline (phone)", §18, §20),
 * on real SQL (node:sqlite) with the table exactly as the copy's schema makes it (utils/db.ts).
 *
 * - What the node answered reads back as it was: the front, each section's list, a topic.
 * - The member's own: another key on this phone reads none of it.
 * - 30 days: a topic not opened for 30 days goes at the next keep, unless the member follows it.
 * - A topic gone for this member leaves the kept read and every kept list, other topics untouched.
 * - A cache table: a Force Resync and a copy below the schema number drop it (CACHE_TABLES), and the number is 8.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORUM_KEPT_TABLE_SQL, FORUM_TOPIC_KEPT_MS, forumKeptStore } from '../forum-kept';

const ME = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

function store() {
    const sql = new DatabaseSync(':memory:');
    sql.exec(FORUM_KEPT_TABLE_SQL);
    const db = {
        getAllAsync: async (q: string, p: any[] = []) => sql.prepare(q).all(...p) as any[],
        getFirstAsync: async (q: string, p: any[] = []) => (sql.prepare(q).get(...p) as any) ?? null,
        runAsync: async (q: string, p: any[] = []) => sql.prepare(q).run(...p),
    };
    return { sql, kept: forumKeptStore(async () => db as any) };
}
const topic = (id: string) => ({ id, title: `Topic ${id}` });
const page = (id: string, follow: 'following' | null = null) => ({ topic: { ...topic(id), follow }, posts: [{ number: 1, words: 'Hello' }], next: null, lastRead: 1 });

describe('the forum kept on the phone', () => {
    it('reads back what the node answered: the front, a section list, every-section list, a topic', async () => {
        const { kept } = store();
        await kept.keepFront(ME, { sections: [{ id: 's1' }], told: false });
        await kept.keepList(ME, null, { topics: [topic('t1'), topic('t2')] });
        await kept.keepList(ME, 's1', { topics: [topic('t1')] });
        await kept.keepTopic(ME, 't1', page('t1'), false);
        expect(await kept.get(ME, 'front')).toEqual({ sections: [{ id: 's1' }], told: false });
        expect((await kept.get<any>(ME, 'list', null))!.topics.map((t: any) => t.id)).toEqual(['t1', 't2']);
        expect((await kept.get<any>(ME, 'list', 's1'))!.topics.map((t: any) => t.id)).toEqual(['t1']);
        expect(await kept.get(ME, 'topic', 't1')).toEqual(page('t1'));
        // A section never read, a topic never opened: nothing, not an empty list.
        expect(await kept.get(ME, 'list', 's2')).toBeNull();
        expect(await kept.get(ME, 'topic', 't2')).toBeNull();
    });

    it("is the member's own: another key on this phone reads none of it, and its own copies don't touch this member's", async () => {
        const { kept } = store();
        await kept.keepFront(ME, { told: true });
        await kept.keepList(ME, null, { topics: [topic('t1')] });
        await kept.keepTopic(ME, 't1', page('t1'), false);
        expect(await kept.get(OTHER, 'front')).toBeNull();
        expect(await kept.get(OTHER, 'list', null)).toBeNull();
        expect(await kept.get(OTHER, 'topic', 't1')).toBeNull();
        await kept.keepFront(OTHER, { told: false });
        await kept.forgetTopic(OTHER, 't1');
        expect(await kept.get(ME, 'front')).toEqual({ told: true });
        expect(await kept.get(ME, 'topic', 't1')).not.toBeNull();
        expect((await kept.get<any>(ME, 'list', null))!.topics).toHaveLength(1);
    });

    it('keeps a topic 30 days after it was last opened, and one the member follows for as long as they follow it', async () => {
        const { kept } = store();
        const t0 = Date.parse('2026-11-01T00:00:00Z');
        await kept.keepTopic(ME, 'read', page('read'), false, t0);
        await kept.keepTopic(ME, 'followed', page('followed', 'following'), true, t0);
        // Opened again on day 10: its 30 days start again.
        await kept.keepTopic(ME, 'again', page('again'), false, t0);
        await kept.keepTopic(ME, 'again', page('again'), false, t0 + 10 * DAY);
        // The next keep at exactly 30 days: nothing older than 30 days yet.
        await kept.keepTopic(ME, 'other', page('other'), false, t0 + FORUM_TOPIC_KEPT_MS);
        expect(await kept.get(ME, 'topic', 'read')).not.toBeNull();
        // A day later: the topic opened on day 0 goes; the followed one and the one opened on day 10 stay.
        await kept.keepTopic(ME, 'other', page('other'), false, t0 + FORUM_TOPIC_KEPT_MS + DAY);
        expect(await kept.get(ME, 'topic', 'read')).toBeNull();
        expect(await kept.get(ME, 'topic', 'followed')).not.toBeNull();
        expect(await kept.get(ME, 'topic', 'again')).not.toBeNull();
        // Lists and the front are never aged out: they are the forum's own pages, read again on every open.
        await kept.keepFront(ME, { told: true }, t0);
        await kept.keepTopic(ME, 'other', page('other'), false, t0 + 100 * DAY);
        expect(await kept.get(ME, 'front')).toEqual({ told: true });
        // Unfollowed, then kept again: it ages like any other.
        await kept.keepTopic(ME, 'followed', page('followed'), false, t0 + 100 * DAY);
        await kept.keepTopic(ME, 'other', page('other'), false, t0 + 131 * DAY);
        expect(await kept.get(ME, 'topic', 'followed')).toBeNull();
    });

    it('forgets a topic gone for this member: its read and its row in every kept list, nothing else', async () => {
        const { kept } = store();
        await kept.keepList(ME, null, { topics: [topic('t1'), topic('t2')], next: 30 } as any);
        await kept.keepList(ME, 's1', { topics: [topic('t1')] });
        await kept.keepList(ME, 's2', { topics: [topic('t2')] });
        await kept.keepTopic(ME, 't1', page('t1'), true);
        await kept.keepTopic(ME, 't2', page('t2'), false);
        await kept.forgetTopic(ME, 't1');
        expect(await kept.get(ME, 'topic', 't1')).toBeNull();
        expect(await kept.get(ME, 'topic', 't2')).not.toBeNull();
        expect(await kept.get(ME, 'list', null)).toEqual({ topics: [topic('t2')], next: 30 });
        expect(await kept.get(ME, 'list', 's1')).toEqual({ topics: [] });
        expect(await kept.get(ME, 'list', 's2')).toEqual({ topics: [topic('t2')] });
    });

    it('a row that no longer parses reads as nothing kept, never a throw', async () => {
        const { sql, kept } = store();
        sql.prepare("INSERT INTO forum_kept (me, k, kind, body, kept_at) VALUES (?, 'front', 'front', '{not json', 1)").run(ME);
        expect(await kept.get(ME, 'front')).toBeNull();
    });

    it('is a copy of the node\'s: in the cache tables a Force Resync drops, and brought in by copy schema 8', () => {
        const db = fs.readFileSync(path.resolve(__dirname, '../db.ts'), 'utf8');
        const cache = db.slice(db.indexOf('const CACHE_TABLES = ['), db.indexOf('] as const;', db.indexOf('const CACHE_TABLES = [')));
        expect(cache).toContain("'forum_kept'");
        expect(db).toMatch(/export const COPY_SCHEMA = 8;/);
        expect(db).toContain('${FORUM_KEPT_TABLE_SQL}');
    });
});
