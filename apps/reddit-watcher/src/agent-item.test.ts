import { describe, expect, it } from 'vitest';
import { agentMessage, BODY_MAX, isoTime, MESSAGE_MAX_BYTES, plainText, toAgentItem, visible, type AgentItem } from './agent-item';
import { quietNames, toNotice } from './notice';

const POST_URL = 'https://www.reddit.com/r/beanpool/comments/abc123/how_do_i_start_a_node/';
const COMMENT_URL = 'https://www.reddit.com/r/beanpool/comments/abc123/how_do_i_start_a_node/def456/';
// 2026-10-23T01:00:00Z, as seconds and as milliseconds: Devvit's proto doesn't say which it sends.
const MADE_S = 1792717200;
const MADE_ISO = '2026-10-23T01:00:00.000Z';

// Trigger payloads shaped as Devvit 0.15 sends them (OnPostCreateRequest / OnCommentCreateRequest; PostV2, CommentV2).
function postEvent(post: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
    return {
        type: 'PostCreate',
        post: {
            id: 't3_abc123',
            title: 'How do I start a node?',
            selftext: 'I have an old laptop.\n\nWhat do I need?',
            permalink: '/r/beanpool/comments/abc123/how_do_i_start_a_node/',
            authorId: 't2_member9',
            linkFlair: { text: 'Question', cssClass: 'q', backgroundColor: '#fff', templateId: 'tpl1', textColor: 'dark' },
            authorFlair: { userId: 't2_member9', text: 'Grower in Mullum' },
            createdAt: MADE_S,
            spam: false,
            deleted: false,
            distinguished: 0,
            ...post,
        },
        author: { id: 't2_member9', name: 'Some_Member', accountType: 1, karma: 12, flair: { text: 'Grower in Mullum' } },
        subreddit: { id: 't5_bp', name: 'beanpool' },
        ...rest,
    };
}

function commentEvent(comment: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
    return {
        type: 'CommentCreate',
        comment: {
            id: 't1_def456',
            postId: 't3_abc123',
            parentId: 't3_abc123',
            body: 'Thanks, try the guide.',
            author: 't2_other7',
            permalink: '/r/beanpool/comments/abc123/how_do_i_start_a_node/def456/',
            createdAt: MADE_S * 1000,
            spam: false,
            deleted: false,
            ...comment,
        },
        post: postEvent().post,
        author: { id: 't2_other7', name: 'Other_Person', accountType: 1 },
        subreddit: { id: 't5_bp', name: 'beanpool' },
        ...rest,
    };
}

describe('toAgentItem: a new post', () => {
    it('carries its id, link, title, text, flair and time, and nothing else', () => {
        expect(toAgentItem(postEvent())).toEqual({
            v: 1,
            kind: 'post',
            id: 't3_abc123',
            permalink: POST_URL,
            title: 'How do I start a node?',
            body: 'I have an old laptop.\n\nWhat do I need?',
            flair: 'Question',
            createdAt: MADE_ISO,
        });
    });

    it('never carries who wrote it: no name, no id, no flair of theirs', () => {
        const text = JSON.stringify(toAgentItem(postEvent()));
        for (const word of ['Some_Member', 'member9', 't2_', 'Grower', 'karma']) expect(text).not.toContain(word);
    });

    it('reads PostSubmit the same way', () => {
        expect(toAgentItem({ ...postEvent(), type: 'PostSubmit' })).toEqual(toAgentItem(postEvent()));
    });

    it('a link or image post has an empty body; a post without flair an empty flair', () => {
        const item = toAgentItem(postEvent({ selftext: '', linkFlair: undefined }));
        expect(item?.body).toBe('');
        expect(item?.flair).toBe('');
        expect(toAgentItem(postEvent({ selftext: undefined, linkFlair: { text: 7 } }))).toMatchObject({ body: '', flair: '' });
    });

    it('keeps a title in any script, on one line, at most 300 characters', () => {
        expect(toAgentItem(postEvent({ title: 'Как начать узел? 🌱\n¿Cómo empiezo?' }))?.title).toBe('Как начать узел? 🌱 ¿Cómo empiezo?');
        const title = toAgentItem(postEvent({ title: 'a'.repeat(400) }))?.title ?? '';
        expect(Array.from(title)).toHaveLength(300);
        expect(title.endsWith('…')).toBe(true);
    });
});

describe('toAgentItem: a new comment', () => {
    it('carries its text, the post it is on, and its parent: the post for a top-level comment', () => {
        expect(toAgentItem(commentEvent())).toEqual({
            v: 1,
            kind: 'comment',
            id: 't1_def456',
            permalink: COMMENT_URL,
            title: 'How do I start a node?',
            body: 'Thanks, try the guide.',
            flair: 'Question',
            createdAt: MADE_ISO,
            parentPermalink: POST_URL,
        });
    });

    it('a reply\'s parent is the comment it answers, in Reddit\'s own form', () => {
        expect(toAgentItem(commentEvent({ parentId: 't1_ghi789' }))?.parentPermalink).toBe(
            'https://www.reddit.com/r/beanpool/comments/abc123/how_do_i_start_a_node/ghi789/',
        );
        expect(toAgentItem(commentEvent({ parentId: 't1_ghi789', permalink: '' }))?.parentPermalink).toBe(
            'https://www.reddit.com/r/beanpool/comments/abc123/_/ghi789/',
        );
    });

    it('works without the post: no title or flair, links from the ids', () => {
        expect(toAgentItem(commentEvent({ permalink: '' }, { post: undefined }))).toMatchObject({
            title: '',
            flair: '',
            permalink: 'https://www.reddit.com/r/beanpool/comments/abc123/_/def456/',
            parentPermalink: 'https://www.reddit.com/r/beanpool/comments/abc123/',
        });
    });

    it('takes the post\'s link only when it is the comment\'s post', () => {
        const other = { ...postEvent().post, id: 't3_zzz999', permalink: '/r/beanpool/comments/zzz999/another/' };
        expect(toAgentItem(commentEvent({}, { post: other }))?.parentPermalink).toBe('https://www.reddit.com/r/beanpool/comments/abc123/');
    });

    it('never carries who wrote it, or who wrote the post', () => {
        const text = JSON.stringify(toAgentItem(commentEvent()));
        for (const word of ['Other_Person', 'other7', 'Some_Member', 'member9', 't2_', 'Grower']) expect(text).not.toContain(word);
    });
});

describe('toAgentItem: skips exactly what the phone notice skips', () => {
    const cases: [string, unknown, Set<string>?][] = [
        ['a post', postEvent()],
        ['a comment', commentEvent()],
        ['a spam post', postEvent({ spam: true })],
        ['a deleted post', postEvent({ deleted: true })],
        ['a moderator\'s distinguished post', postEvent({ distinguished: 4 })],
        ['an admin\'s distinguished post', postEvent({ distinguished: 'ADMIN' })],
        ['AutoModerator', commentEvent({}, { author: { name: 'AutoModerator' } })],
        ['another app', commentEvent({}, { author: { name: 'some-app', accountType: 'ACCOUNT_TYPE_APP' } })],
        ['the team\'s own post', postEvent(), quietNames('u/some_member')],
        ['the team\'s own comment', commentEvent(), quietNames('Other_Person')],
        ['someone else, with quiet names set', postEvent(), quietNames('someone-else')],
        ['a spam comment', commentEvent({ spam: true })],
        ['a comment on a deleted post', commentEvent({}, { post: { ...postEvent().post, deleted: true } })],
        ['an edit', { ...postEvent(), type: 'PostUpdate' }],
        ['a mod action', { type: 'ModAction' }],
        ['a post with no usable id', postEvent({ id: 't3_../../x' })],
        ['nothing', null],
        ['a string', 'PostCreate'],
    ];
    for (const [what, event, quiet] of cases) {
        it(what, () => {
            const notice = toNotice(event, quiet);
            const item = toAgentItem(event, quiet);
            expect(item === null).toBe(notice === null);
            if (item && notice) {
                expect(item.id).toBe(notice.id);
                expect(item.permalink).toBe(notice.url);
            }
        });
    }
});

describe('plainText', () => {
    it('keeps the lines, trims the ends, and closes up long gaps', () => {
        expect(plainText('  Hello\r\nthere   \n\n\n\n\nbye\t \n')).toBe('Hello\nthere\n\nbye');
    });

    it('drops control characters and what a reader cannot see, and keeps emoji whole', () => {
        // A bell, a right-to-left override, a zero-width space and Unicode "tag" letters spelling "hi" (a way to hide
        // words from a person but not from a program); the farmer emoji is joined by U+200D, which stays.
        const text = `ring\u0007 rtl‮ zero​width tag\u{E0068}\u{E0069} 👩‍🌾`;
        expect(plainText(text)).toBe('ring  rtl zerowidth tag 👩‍🌾');
        expect(visible('a‌b')).toBe('a‌b');
    });

    it(`cuts at ${BODY_MAX} characters, between characters, with "…"`, () => {
        const body = plainText('🌱'.repeat(BODY_MAX + 50));
        expect(Array.from(body)).toHaveLength(BODY_MAX);
        expect(body).toBe(`${'🌱'.repeat(BODY_MAX - 1)}…`);
        expect(plainText('b'.repeat(BODY_MAX))).toBe('b'.repeat(BODY_MAX));
    });

    it('a post\'s text is cut the same way', () => {
        expect(Array.from(toAgentItem(postEvent({ selftext: 'x'.repeat(5000) }))?.body ?? '')).toHaveLength(BODY_MAX);
    });

    it('anything but a string is empty', () => {
        for (const raw of [undefined, null, 7, {}, []]) expect(plainText(raw)).toBe('');
    });
});

describe('isoTime', () => {
    it('reads seconds and milliseconds alike', () => {
        expect(isoTime(MADE_S)).toBe(MADE_ISO);
        expect(isoTime(MADE_S * 1000)).toBe(MADE_ISO);
    });

    it('is null for anything that is not a time in Reddit\'s lifetime', () => {
        for (const raw of [undefined, null, 0, -1, NaN, Infinity, '1792717200', 1000, Date.UTC(2101, 0, 1)]) expect(isoTime(raw)).toBeNull();
    });
});

describe('agentMessage', () => {
    const item = toAgentItem(postEvent()) as AgentItem;

    it('is the item as compact JSON', () => {
        expect(JSON.parse(agentMessage(item) ?? '')).toEqual(item);
    });

    it(`stays at most ${MESSAGE_MAX_BYTES} bytes, so ntfy keeps it as a message, cutting only the body`, () => {
        // Four bytes a character, two, and two again once JSON escapes them (no space, which a cut would trim).
        for (const body of ['🌱'.repeat(BODY_MAX), 'щ'.repeat(BODY_MAX), '"\\'.repeat(BODY_MAX / 2)]) {
            const big = { ...item, title: '🌾'.repeat(300), body };
            const text = agentMessage(big) ?? '';
            expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MESSAGE_MAX_BYTES);
            const back = JSON.parse(text) as AgentItem;
            expect({ ...back, body: '' }).toEqual({ ...big, body: '' });
            expect(body.startsWith(back.body.slice(0, -1))).toBe(true);
            expect(back.body.endsWith('…')).toBe(true);
            // As long as it can be: one more character would not fit.
            const longer = JSON.stringify({ ...big, body: `${Array.from(body).slice(0, Array.from(back.body).length).join('')}…` });
            expect(new TextEncoder().encode(longer).length).toBeGreaterThan(MESSAGE_MAX_BYTES);
        }
    });

    it('is null when even an empty body would not fit', () => {
        expect(agentMessage({ ...item, permalink: `https://www.reddit.com/${'p'.repeat(MESSAGE_MAX_BYTES)}` })).toBeNull();
    });
});
