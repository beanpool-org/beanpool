/** The public forum the visitor suite reads (forum-visitor-render.test.ts), in the server's shapes (routes/forum-public.ts). */
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const writer = { name: 'Asha', community: null };
const topic = (id: string, title: string, created: number) => ({
    id, sectionId: 's-ideas', title, writer, createdAt: day(created), lastActivityAt: day(created), replyCount: 2, pinned: false, closed: null, place: null, lang: 'en', indexable: true,
});
export const SECTIONS = [{ id: 's-ideas', starter: null, name: 'Seed swaps', about: null, position: 1, topicCount: 4 }];
export const TOPICS = [topic('ft-1', 'Oldest topic', 9), topic('ft-2', 'A tool library in a shed', 1), topic('ft-3', 'Seed swap ideas', 2), topic('ft-4', 'Starting small', 3)];
export const pageOf = (id: string) => ({
    section: SECTIONS[0],
    topic: TOPICS.find((x) => x.id === id) ?? topic(id, 'A door topic', 1),
    posts: [
        { id: `${id}-1`, topicId: id, number: 1, writer, words: `We share tools for ${id}.\nSecond line`, quotes: null, createdAt: day(1), edited: false, photos: 0, lang: 'en' },
        { id: `${id}-2`, topicId: id, number: 2, writer: { name: 'Dax', community: { kind: 'community', community: 'Riverside' } }, words: 'Count me in.', quotes: 1, createdAt: day(0), edited: false, photos: 0, lang: 'en' },
    ],
    next: null,
});
