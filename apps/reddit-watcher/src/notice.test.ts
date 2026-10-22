import { describe, expect, it } from 'vitest';
import { oneLine, quietNames, TITLE_MAX, toNotice } from './notice';

const POST_URL = 'https://www.reddit.com/r/beanpool/comments/abc123/how_do_i_start_a_node/';
const COMMENT_URL = 'https://www.reddit.com/r/beanpool/comments/abc123/how_do_i_start_a_node/def456/';

// Trigger payloads shaped as Devvit 0.15 sends them (OnPostCreateRequest / OnCommentCreateRequest).
function postEvent(post: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
    return {
        type: 'PostCreate',
        post: {
            id: 't3_abc123',
            title: 'How do I start a node?',
            permalink: '/r/beanpool/comments/abc123/how_do_i_start_a_node/',
            authorId: 't2_member9',
            spam: false,
            deleted: false,
            distinguished: 0,
            ...post,
        },
        author: { id: 't2_member9', name: 'Some_Member', accountType: 1 },
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
            body: 'Thanks u/Some_Member, try the guide',
            author: 't2_other7',
            permalink: '/r/beanpool/comments/abc123/how_do_i_start_a_node/def456/',
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

describe('toNotice: a new post', () => {
    it('says "New post in r/beanpool", the title and the link', () => {
        expect(toNotice(postEvent())).toEqual({
            id: 't3_abc123',
            title: 'New post in r/beanpool',
            body: `How do I start a node?\n${POST_URL}`,
            url: POST_URL,
        });
    });

    it('reads PostSubmit the same way, so switching the trigger is only devvit.json', () => {
        expect(toNotice({ ...postEvent(), type: 'PostSubmit' })).toEqual(toNotice(postEvent()));
    });

    it('never carries who wrote it', () => {
        const text = JSON.stringify(toNotice(postEvent()));
        expect(text).not.toContain('Some_Member');
        expect(text).not.toContain('member9');
    });

    it('keeps a title in any script whole, in the body', () => {
        const n = toNotice(postEvent({ title: 'Как начать узел? 🌱 ¿Cómo empiezo?' }));
        expect(n?.body.split('\n')[0]).toBe('Как начать узел? 🌱 ¿Cómo empiezo?');
        expect(n?.title).toBe('New post in r/beanpool');
    });

    it('puts a title on one line, at most 120 characters', () => {
        expect(toNotice(postEvent({ title: '  Line one\nline\ttwo\u0007  ' }))?.body.split('\n')[0]).toBe('Line one line two');
        const long = 'a'.repeat(200);
        const first = toNotice(postEvent({ title: long }))?.body.split('\n')[0] ?? '';
        expect(Array.from(first)).toHaveLength(TITLE_MAX);
        expect(first.endsWith('…')).toBe(true);
        expect(oneLine('b'.repeat(TITLE_MAX))).toBe('b'.repeat(TITLE_MAX));
    });

    it('cuts between characters, never inside an emoji', () => {
        const cut = oneLine('🌱'.repeat(150));
        expect(Array.from(cut)).toHaveLength(TITLE_MAX);
        expect(cut).toBe(`${'🌱'.repeat(TITLE_MAX - 1)}…`);
    });

    it('says "(no title)" for an empty one', () => {
        expect(toNotice(postEvent({ title: '   ' }))?.body).toBe(`(no title)\n${POST_URL}`);
    });

    it('builds the link from the id when the permalink is missing', () => {
        expect(toNotice(postEvent({ permalink: '' }))?.url).toBe('https://www.reddit.com/r/beanpool/comments/abc123/');
        expect(toNotice(postEvent({ id: 'abc123', permalink: undefined }))?.url).toBe('https://www.reddit.com/r/beanpool/comments/abc123/');
    });

    it('takes an absolute reddit.com permalink, always on www.reddit.com', () => {
        expect(toNotice(postEvent({ permalink: `https://reddit.com/r/beanpool/comments/abc123/x/` }))?.url).toBe(
            'https://www.reddit.com/r/beanpool/comments/abc123/x/',
        );
    });

    it('never links anywhere but reddit.com', () => {
        for (const permalink of [
            'https://evil.example/r/beanpool/comments/abc123/x/',
            '//evil.example/r/beanpool/comments/abc123/',
            'javascript:alert(1)',
            '/r/beanpool/comments/abc123/x\nInjected: header',
            'http://www.reddit.com/r/beanpool/comments/abc123/',
        ]) {
            const n = toNotice(postEvent({ permalink }));
            expect(new URL(n?.url ?? '').origin, permalink).toBe('https://www.reddit.com');
            expect(n?.url).toBe('https://www.reddit.com/r/beanpool/comments/abc123/');
        }
    });

    it('says "on Reddit" when the subreddit is missing or not a subreddit name', () => {
        for (const subreddit of [undefined, { name: '' }, { name: 'bean pool' }]) {
            const n = toNotice(postEvent({ permalink: '' }, { subreddit }));
            expect(n?.title).toBe('New post on Reddit');
            expect(n?.url).toBe('https://www.reddit.com/comments/abc123/');
        }
    });
});

describe('toNotice: a new comment', () => {
    it('says "New comment in r/beanpool", the post it is on and the link', () => {
        expect(toNotice(commentEvent())).toEqual({
            id: 't1_def456',
            title: 'New comment in r/beanpool',
            body: `On: How do I start a node?\n${COMMENT_URL}`,
            url: COMMENT_URL,
        });
    });

    it('reads CommentSubmit the same way', () => {
        expect(toNotice({ ...commentEvent(), type: 'CommentSubmit' })).toEqual(toNotice(commentEvent()));
    });

    it('never carries who wrote it, or what they wrote', () => {
        const text = JSON.stringify(toNotice(commentEvent()));
        for (const word of ['Other_Person', 'other7', 'Some_Member', 'Thanks']) expect(text).not.toContain(word);
    });

    it('works without the post: the link from the comment, no "On:" line', () => {
        const n = toNotice(commentEvent({ permalink: '' }, { post: undefined }));
        expect(n?.body).toBe('https://www.reddit.com/r/beanpool/comments/abc123/_/def456/');
        expect(n?.url).toBe('https://www.reddit.com/r/beanpool/comments/abc123/_/def456/');
    });
});

describe('toNotice: what it skips', () => {
    it('a post Reddit marked spam, or a deleted one', () => {
        expect(toNotice(postEvent({ spam: true }))).toBeNull();
        expect(toNotice(postEvent({ deleted: true }))).toBeNull();
    });

    it('a moderator\'s or admin\'s distinguished post, as a number or a name', () => {
        for (const distinguished of [4, 'YES', 1, 'ADMIN']) expect(toNotice(postEvent({ distinguished }))).toBeNull();
        for (const distinguished of [0, 'NULL_VALUE', undefined]) expect(toNotice(postEvent({ distinguished }))).not.toBeNull();
    });

    it('AutoModerator and other apps\' accounts', () => {
        for (const name of ['AutoModerator', 'automoderator']) {
            expect(toNotice(postEvent({}, { author: { name } }))).toBeNull();
            expect(toNotice(commentEvent({}, { author: { name } }))).toBeNull();
        }
        for (const accountType of [3, 'ACCOUNT_TYPE_APP']) {
            expect(toNotice(commentEvent({}, { author: { name: 'some-app', accountType } }))).toBeNull();
        }
    });

    it('the team\'s own accounts, named in quietUsernames, in any case', () => {
        const quiet = quietNames(' u/some_member,\nOther_Person  /u/third ');
        expect([...quiet].sort()).toEqual(['other_person', 'some_member', 'third']);
        expect(toNotice(postEvent(), quiet)).toBeNull();
        expect(toNotice(commentEvent(), quiet)).toBeNull();
        expect(toNotice(postEvent(), quietNames('someone-else'))).not.toBeNull();
        expect(toNotice(postEvent({}, { author: { name: '' } }), quietNames(''))).not.toBeNull();
        for (const raw of [undefined, null, '', ' , ', 7]) expect(quietNames(raw).size).toBe(0);
    });

    it('a spam or deleted comment, or one on a deleted post', () => {
        expect(toNotice(commentEvent({ spam: true }))).toBeNull();
        expect(toNotice(commentEvent({ deleted: true }))).toBeNull();
        expect(toNotice(commentEvent({}, { post: { ...postEvent().post, deleted: true } }))).toBeNull();
    });

    it('anything that is not a new post or comment', () => {
        for (const type of ['PostUpdate', 'PostDelete', 'CommentUpdate', 'ModAction', 'AppInstall', '', undefined]) {
            expect(toNotice({ ...postEvent(), type })).toBeNull();
        }
    });

    it('a payload with no item or no usable id, and garbage', () => {
        expect(toNotice({ type: 'PostCreate' })).toBeNull();
        expect(toNotice({ type: 'CommentCreate', post: postEvent().post })).toBeNull();
        expect(toNotice(postEvent({ id: '' }))).toBeNull();
        expect(toNotice(postEvent({ id: 't3_../../x' }))).toBeNull();
        expect(toNotice(commentEvent({ id: 't1_ok1', postId: '' }, { post: undefined }))).toBeNull();
        for (const junk of [null, undefined, 42, 'PostCreate', [], { type: 'PostCreate', post: 'x' }]) {
            expect(toNotice(junk)).toBeNull();
        }
    });
});
