/**
 * Writing Local knowledge on the phone (slice K4; DESIGN-local-knowledge-fable.md §3.3 and §3.4 as amended): the form's own
 * checks before anything is sent, what it sends and where, and how My suggestions words each row. Pure; the screens are in
 * learn-write-render.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { setLanguage, t } from '@beanpool/core';
import {
    EMPTY_KNOWLEDGE_FORM, LEARN_WRITE, knowledgeFormBody, knowledgeFormPath, knowledgeFormProblem, learnRefusal, mineRowStatus, refusalCode,
    waitingLine,
} from '../../components/learn/learn-write';
import { editBody, fixBody, formOfPage, pagePhotoUri, pagePhotosKept, pagePhotosOf } from '../../components/learn/learn-keep';

const filled = { ...EMPTY_KNOWLEDGE_FORM, title: ' How recycling works at the tip ', body: 'Bring it sorted.\nThe tip is open daily.', topic: 'local-services' };

describe('the form checks what it can before sending (§3.3 refusals, in order)', () => {
    it('asks for a title, then what to know, then a topic', () => {
        expect(knowledgeFormProblem(EMPTY_KNOWLEDGE_FORM)).toBe(LEARN_WRITE.noTitle);
        expect(knowledgeFormProblem({ ...filled, title: '   ' })).toBe(LEARN_WRITE.noTitle);
        expect(knowledgeFormProblem({ ...filled, body: ' \n ' })).toBe(LEARN_WRITE.noBody);
        expect(knowledgeFormProblem({ ...filled, topic: '' })).toBe(LEARN_WRITE.noTopic);
        expect(knowledgeFormProblem({ ...filled, topic: 'not-a-topic' })).toBe(LEARN_WRITE.noTopic);
        expect(knowledgeFormProblem(filled)).toBeNull();
    });

    it('a link must start with https:// or http://; an untouched link row is no link', () => {
        expect(knowledgeFormProblem({ ...filled, sources: [{ url: 'council.example/tip', label: '' }] })).toBe(LEARN_WRITE.badLink);
        expect(knowledgeFormProblem({ ...filled, sources: [{ url: 'ftp://council.example', label: '' }] })).toBe(LEARN_WRITE.badLink);
        expect(knowledgeFormProblem({ ...filled, sources: [{ url: 'https://', label: '' }, { url: '', label: '' }] })).toBeNull();
        expect(knowledgeFormProblem({ ...filled, sources: [{ url: 'HTTPS://council.example/tip', label: 'The council' }] })).toBeNull();
    });

    it("the refusals are the design's words", () => {
        expect([LEARN_WRITE.noTitle, LEARN_WRITE.noBody, LEARN_WRITE.noTopic, LEARN_WRITE.badLink].map((k) => t(k))).toEqual([
            'Give it a title.', 'Write what people should know.', 'Pick a topic.', 'A link must start with https:// or http://',
        ]);
    });
});

describe('what the form sends, and where', () => {
    it('trims the words, drops empty link rows and an empty place, and names the writer’s app language', () => {
        expect(knowledgeFormBody({
            ...filled,
            place: '  ',
            sources: [{ url: ' https://council.example/tip ', label: ' The council ' }, { url: 'https://', label: 'left blank' }],
            photos: [],
        }, 'fr')).toEqual({
            title: 'How recycling works at the tip',
            body: 'Bring it sorted.\nThe tip is open daily.',
            topic: 'local-services',
            sources: [{ url: 'https://council.example/tip', label: 'The council' }],
            lang: 'fr',
        });
    });

    it('a place and photos go when there are some', () => {
        const body = knowledgeFormBody({ ...filled, place: ' The tip on Manse Road ', photos: ['data:image/jpeg;base64,AAAA'] }, 'en');
        expect(body.place).toBe('The tip on Manse Road');
        expect(body.photos).toEqual(['data:image/jpeg;base64,AAAA']);
    });

    it('a member’s suggestion waits (the waiting list); an owner’s or admin’s own page publishes at once', () => {
        expect(knowledgeFormPath(false)).toBe('/api/knowledge/drafts');
        expect(knowledgeFormPath(true)).toBe('/api/knowledge/posts');
    });
});

describe('My suggestions (§3.4)', () => {
    const at = '2026-11-03T09:00:00.000Z';
    const draft = (over: Record<string, unknown> = {}) => ({
        id: 'd1', kind: 'new' as const, title: 'Bins', topic: 'local-services', state: 'waiting' as const, createdAt: at, answeredAt: null,
        postId: null, reason: null, reasonWords: null, ...over,
    });

    it('a waiting one says since when; an added one "Added"; one not added gives the reason in the member’s words', () => {
        setLanguage('en');
        expect(mineRowStatus(draft())).toBe('Waiting since 3 Nov');
        expect(mineRowStatus(draft({ state: 'approved', answeredAt: at, postId: 'p1' }))).toBe('Added');
        expect(mineRowStatus(draft({ state: 'declined', answeredAt: at, reason: 'duplicate' }))).toBe('Not added: We already have this');
        // A reason this build doesn't know reads as "Another reason", never an id.
        expect(mineRowStatus(draft({ state: 'declined', answeredAt: at, reason: 'newer-reason' }))).toBe('Not added: Another reason');
    });

    it('Learn’s line counts what waits: one, then several', () => {
        expect(waitingLine(1)).toBe('1 of yours is waiting for an admin ›');
        expect(waitingLine(2)).toBe('2 of yours are waiting for an admin ›');
    });
});

describe('whose words a refusal shows: the node’s only when it answered (utils/db.ts adds status only to an answer)', () => {
    const couldNot = 'Couldn’t send it. Check your connection and try again.';
    const table: Array<[string, unknown, string]> = [
        ['the node’s refusal', Object.assign(new Error('You have 3 waiting already.'), { status: 429, code: 'too_many_waiting' }), 'You have 3 waiting already.'],
        ['a standby', Object.assign(new Error('This server is a standby copy.'), { status: 503, code: 'standby' }), 'This server is a standby copy.'],
        ['no signal (React Native fetch)', new TypeError('Network request failed'), couldNot],
        ['off-grid (asked nothing)', new Error('You are off-grid. Please connect to a BeanPool Node.'), couldNot],
        ['a proxy’s page (unsaid)', Object.assign(new Error('Bad Gateway'), { status: 502, unsaid: true }), couldNot],
        ['an empty answer', Object.assign(new Error('   '), { status: 500 }), couldNot],
        ['a status that is not a number', Object.assign(new Error('odd'), { status: '500' }), couldNot],
        ['a message that is not words', { status: 400, message: 42 }, couldNot],
        ['nothing at all', undefined, couldNot],
        ['null', null, couldNot],
    ];
    it.each(table)('%s', (_name, thrown, words) => {
        setLanguage('en');
        expect(learnRefusal(thrown)).toBe(words);
    });

    it('the node’s code, when it gave one', () => {
        expect(refusalCode(Object.assign(new Error('x'), { code: 'admins_only' }))).toBe('admins_only');
        expect(refusalCode(new TypeError('Network request failed'))).toBeUndefined();
        expect(refusalCode({ code: 403 })).toBeUndefined();
        expect(refusalCode(null)).toBeUndefined();
        expect(refusalCode(undefined)).toBeUndefined();
    });
});

// Learn web pictures, slice 4 (DESIGN-learn-web-pictures-fable.md §9): what an Edit of a page with pictures sends, and what a form
// of a page with the node's credit rows holds. The screens are in learn-keep-render.test.ts.
describe('an Edit\'s pictures and a form\'s sources (learn web pictures, slice 4)', () => {
    const ADDR = [0, 1, 2].map((n) => `/api/marketplace/posts/tip/photos/${n}?v=1&k=key${n}`);
    const page = {
        id: 'tip', title: 'The tip', description: 'Sort it first.', category: 'local-services', photos: [...ADDR, '', null as unknown as string],
        knowledge: {
            lang: 'es',
            sources: [
                { url: 'https://council.example/tip', label: 'Council tip page' },
                { url: 'https://commons.wikimedia.org/wiki/File:Tip.jpg', label: 'The tip entrance, on Commons' },
                { url: 'https://commons.wikimedia.org/wiki/File:Tip.jpg', label: '📷 1 · Jane Doe · CC BY-SA 4.0', photo: 1 },
            ],
        },
    };

    it('a page\'s pictures are the addresses it gave, in order, never resolved; nothing else is one', () => {
        expect(pagePhotosOf(page)).toEqual(ADDR);
        expect(pagePhotosOf(null)).toEqual([]);
        expect(pagePhotosOf({ ...page, photos: undefined })).toEqual([]);
    });

    it('the kept list: none taken off is no list; one off is the others as given; all off is []', () => {
        expect(pagePhotosKept(ADDR, [])).toBeNull();
        expect(pagePhotosKept(ADDR, [1])).toEqual([ADDR[0], ADDR[2]]);
        expect(pagePhotosKept(ADDR, [2, 0])).toEqual([ADDR[1]]);
        expect(pagePhotosKept(ADDR, [0, 1, 2])).toEqual([]);
        // A place that names no picture takes nothing off.
        expect(pagePhotosKept(ADDR, [3, -1])).toBeNull();
        expect(pagePhotosKept([], [0])).toBeNull();
    });

    it('a picture is drawn from the node\'s address; an http(s) address as it is; anything else not at all', () => {
        expect(pagePhotoUri(ADDR[0], 'https://node.test')).toBe(`https://node.test${ADDR[0]}`);
        expect(pagePhotoUri(ADDR[0], 'https://node.test/')).toBe(`https://node.test${ADDR[0]}`);
        expect(pagePhotoUri(ADDR[0], null)).toBeNull();
        expect(pagePhotoUri(`https://node.test${ADDR[0]}`, null)).toBe(`https://node.test${ADDR[0]}`);
        expect(pagePhotoUri('//elsewhere.example/p.jpg', 'https://node.test')).toBeNull();
        expect(pagePhotoUri('javascript:alert(1)', 'https://node.test')).toBeNull();
        expect(pagePhotoUri('data:image/jpeg;base64,AAAA', 'https://node.test')).toBeNull();
    });

    it('Edit sends the kept list only when given one, beside the words in the page\'s language; the form holds the page\'s own sources only', () => {
        const form = formOfPage(page);
        expect(form.sources).toEqual([
            { url: 'https://council.example/tip', label: 'Council tip page' },
            { url: 'https://commons.wikimedia.org/wiki/File:Tip.jpg', label: 'The tip entrance, on Commons' },
        ]);
        expect(form.photos).toEqual([]);
        expect(editBody(page, form)).not.toHaveProperty('photos');
        expect(editBody(page, form, null)).not.toHaveProperty('photos');
        expect(editBody(page, form, [ADDR[2]])).toMatchObject({ photos: [ADDR[2]], lang: 'es', sources: form.sources });
        expect(editBody(page, form, [])).toMatchObject({ photos: [] });
        // A fix that changes nothing sends no sources: the credit row is never a change.
        expect(fixBody(page, form, 'Closed on Mondays')).toEqual({ fixOf: 'tip', note: 'Closed on Mondays' });
    });
});
