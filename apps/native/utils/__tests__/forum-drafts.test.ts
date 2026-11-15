/**
 * A forum reply kept on the phone as a draft (slice F3 part 2; utils/forum-kept.ts, DESIGN-forums-fable.md §14 "Offline
 * (phone)": "Writing needs a connection; a reply typed offline is kept as a draft on the phone"), on real SQL (node:sqlite)
 * with the table exactly as the copy's schema makes it.
 *
 * - A draft reads back as it was kept: its words, the post it quotes, its photos.
 * - The member's own: another key on this phone reads none of it, and clearing theirs leaves this member's.
 * - Emptied (no words, no photos) or null: the draft goes. A broken row reads as none.
 * - It goes with its topic (forgetTopic) and with the 30-day rule; it is never read as a topic's copy, nor a topic as a draft.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FORUM_KEPT_TABLE_SQL, FORUM_TOPIC_KEPT_MS, forumKeptStore } from '../forum-kept';

const ME = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQ';

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
const page = (id: string) => ({ topic: { id, title: `Topic ${id}`, follow: null }, posts: [{ number: 1, words: 'Hello' }], next: null, lastRead: 1 });

describe('a forum reply kept as a draft on the phone', () => {
    it('reads back as it was kept: words, the quoted post, photos; another topic has none', async () => {
        const { kept } = store();
        await kept.keepDraft(ME, 't1', { words: 'Start with one meeting.', quotes: 3, photos: [PHOTO] });
        expect(await kept.getDraft(ME, 't1')).toEqual({ words: 'Start with one meeting.', quotes: 3, photos: [PHOTO] });
        expect(await kept.getDraft(ME, 't2')).toBeNull();
        // Kept again (typed on): the newer one stands.
        await kept.keepDraft(ME, 't1', { words: 'Start with one meeting in a park.', quotes: null, photos: [] });
        expect(await kept.getDraft(ME, 't1')).toEqual({ words: 'Start with one meeting in a park.', quotes: null, photos: [] });
    });

    it("is the member's own: another key reads none of it, and that key's empty box leaves this member's draft", async () => {
        const { kept } = store();
        await kept.keepDraft(ME, 't1', { words: 'Mine', quotes: null, photos: [] });
        expect(await kept.getDraft(OTHER, 't1')).toBeNull();
        await kept.keepDraft(OTHER, 't1', null);
        await kept.keepDraft(OTHER, 't1', { words: 'Theirs', quotes: null, photos: [] });
        expect(await kept.getDraft(ME, 't1')).toEqual({ words: 'Mine', quotes: null, photos: [] });
        expect(await kept.getDraft(OTHER, 't1')).toEqual({ words: 'Theirs', quotes: null, photos: [] });
    });

    it('emptied or null, it goes; photos alone stay; a broken row reads as none', async () => {
        const { kept, sql } = store();
        await kept.keepDraft(ME, 't1', { words: 'Hello', quotes: null, photos: [] });
        await kept.keepDraft(ME, 't1', { words: '   ', quotes: 2, photos: [] });
        expect(await kept.getDraft(ME, 't1')).toBeNull();
        await kept.keepDraft(ME, 't1', { words: '', quotes: null, photos: [PHOTO] });
        expect(await kept.getDraft(ME, 't1')).toEqual({ words: '', quotes: null, photos: [PHOTO] });
        await kept.keepDraft(ME, 't1', null);
        expect(await kept.getDraft(ME, 't1')).toBeNull();
        expect((sql.prepare('SELECT COUNT(*) AS n FROM forum_kept').get() as { n: number }).n).toBe(0);
        sql.prepare("INSERT INTO forum_kept (me, k, kind, following, body, kept_at) VALUES (?, 'draft:t9', 'draft', 0, '{not json', 0)").run(ME);
        expect(await kept.getDraft(ME, 't9')).toBeNull();
    });

    it('goes with its topic, and with the 30-day rule; a draft is never a topic\'s copy, nor a topic a draft', async () => {
        const { kept } = store();
        const now = Date.now();
        await kept.keepTopic(ME, 't1', page('t1'), false, now);
        await kept.keepDraft(ME, 't1', { words: 'Typed with no connection', quotes: null, photos: [] }, now);
        expect(await kept.get(ME, 'topic', 't1')).toEqual(page('t1'));
        expect(await kept.getDraft(ME, 't1')).toEqual({ words: 'Typed with no connection', quotes: null, photos: [] });
        await kept.forgetTopic(ME, 't1');
        expect(await kept.getDraft(ME, 't1')).toBeNull();

        await kept.keepDraft(ME, 't2', { words: 'Old', quotes: null, photos: [] }, now - FORUM_TOPIC_KEPT_MS - DAY);
        await kept.keepDraft(ME, 't3', { words: 'New', quotes: null, photos: [] }, now - DAY);
        await kept.keepTopic(ME, 't4', page('t4'), false, now);
        expect(await kept.getDraft(ME, 't2')).toBeNull();
        expect(await kept.getDraft(ME, 't3')).toEqual({ words: 'New', quotes: null, photos: [] });
        expect(await kept.get(ME, 'topic', 't3')).toBeNull();
        expect(await kept.getDraft(ME, 't4')).toBeNull();
    });
});
