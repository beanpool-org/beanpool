/**
 * Writing Local knowledge on the phone (slice K4; DESIGN-local-knowledge-fable.md §3.3 and §3.4 as amended): the form's own
 * checks before anything is sent, what it sends and where, and how My suggestions words each row. Pure; the screens are in
 * learn-write-render.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { setLanguage, t } from '@beanpool/core';
import {
    EMPTY_KNOWLEDGE_FORM, LEARN_WRITE, knowledgeFormBody, knowledgeFormPath, knowledgeFormProblem, mineRowStatus, waitingLine,
} from '../../components/learn/learn-write';

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
