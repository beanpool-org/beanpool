/**
 * Blocks in the forum on the phone (slice F3; utils/forum.ts, DESIGN-forums-fable.md §4: "the phone hides them itself"). A block
 * goes to the community without waiting (utils/blocklist.ts blockUser), so the node may still send what the member just
 * blocked, and every kept copy holds it. The phone leaves it out itself, from the node's answers and from its copies:
 *
 * - a list without the blocked writer's topics; a topic without their posts;
 * - a topic of theirs reads as "not here for you" (404 not_found, the web's line) and leaves the kept copies;
 * - the copies keep what the node said, so an unblock shows it again.
 *
 * The node's answers are stubbed; the copies are the real store on node:sqlite (utils/forum-kept.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FORUM_KEPT_TABLE_SQL, forumKeptStore } from '../forum-kept';

const ME = 'm'.repeat(64);
const ASHA = 'a'.repeat(64);
const DAX = 'd'.repeat(64);
const h = vi.hoisted(() => ({ answers: new Map<string, unknown>(), blocked: [] as string[], store: null as any }));

vi.mock('../db', () => ({
    signedRequestWithMethod: vi.fn(async (_m: string, path: string) => {
        const key = [...h.answers.keys()].find((k) => path.startsWith(k));
        if (!key) throw new Error(`unexpected ${path}`);
        return structuredClone(h.answers.get(key));
    }),
    forumKept: () => h.store,
}));
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: ME }) }));
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://riverside.example', signedGet: vi.fn() }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => h.blocked }));

import { getForumTopic, getForumTopics, keptForumList, keptForumTopic } from '../forum';

const writer = (publicKey: string, name: string) => ({ publicKey, name });
const topicOf = (id: string, by: string, name: string) => ({
    id, sectionId: 's', title: `Topic ${id}`, writer: writer(by, name), place: null, lang: 'en', replyCount: 1, lastActivityAt: '2026-11-15T00:00:00Z',
    createdAt: '2026-11-15T00:00:00Z', pinned: false, closed: null, removed: false, hidden: false, follow: null, unread: false,
});
const postOf = (number: number, by: string, name: string) => ({
    id: `p${number}`, topicId: 't1', number, writer: writer(by, name), words: `Post ${number}`, quotes: null, lang: 'en', createdAt: '2026-11-15T00:00:00Z',
    editedAt: null, removed: null, photos: 0, hidden: false, linksOn: true,
});

beforeEach(() => {
    const sql = new DatabaseSync(':memory:');
    sql.exec(FORUM_KEPT_TABLE_SQL);
    const db = {
        getAllAsync: async (q: string, p: any[] = []) => sql.prepare(q).all(...p) as any[],
        getFirstAsync: async (q: string, p: any[] = []) => (sql.prepare(q).get(...p) as any) ?? null,
        runAsync: async (q: string, p: any[] = []) => sql.prepare(q).run(...p),
    };
    h.store = forumKeptStore(async () => db as any);
    h.blocked = [];
    h.answers = new Map<string, unknown>([
        ['/api/forum/topics/t1', { topic: topicOf('t1', ASHA, 'Asha'), posts: [postOf(1, ASHA, 'Asha'), postOf(2, DAX, 'Dax'), postOf(3, ME, 'Marty')], next: null, lastRead: 0 }],
        ['/api/forum/topics', { topics: [topicOf('t1', ASHA, 'Asha'), topicOf('t2', DAX, 'Dax')], next: null }],
    ]);
});

describe('the forum on the phone leaves out what the member blocked', () => {
    it('a list: the blocked writer\'s topics are not drawn, from the node or from the copy; an unblock brings them back', async () => {
        h.blocked = [DAX];
        expect((await getForumTopics(null)).topics.map((x) => x.id)).toEqual(['t1']);
        expect((await keptForumList(null))!.topics.map((x) => x.id)).toEqual(['t1']);
        h.blocked = [];
        expect((await keptForumList(null))!.topics.map((x) => x.id)).toEqual(['t1', 't2']);
    });

    it('a topic: the blocked writer\'s replies are not drawn, from the node or from the copy', async () => {
        h.blocked = [DAX];
        expect((await getForumTopic('t1')).posts.map((p) => p.number)).toEqual([1, 3]);
        expect((await keptForumTopic('t1'))!.posts.map((p) => p.number)).toEqual([1, 3]);
    });

    it('a topic whose writer they blocked is not here for them: 404 not_found with the web\'s line, and it leaves the copies', async () => {
        await getForumTopics(null);
        await getForumTopic('t1');
        expect(await keptForumTopic('t1')).not.toBeNull();
        h.blocked = [ASHA];
        // The node still sends it (the block hasn't reached it yet): the phone answers as the node will.
        const err = await getForumTopic('t1').then(() => null, (e) => e);
        expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'You blocked Asha, so their topic no longer shows for you.' });
        h.blocked = [];
        expect(await keptForumTopic('t1')).toBeNull();
        expect((await keptForumList(null))!.topics.map((x) => x.id)).toEqual(['t2']);
    });
});
