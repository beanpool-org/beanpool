/**
 * Local knowledge's card on the Pulse (slice KP, apps; DESIGN-local-knowledge-amend-fable.md §3.8): what both apps say on it
 * (one page and several the same day, the spoken lines, "by {name}" only on a single page a member wrote), and how a list that
 * reads the feed page by page keeps one card a day when the day's card moved between two reads (the KP node review note).
 */
import { describe, expect, it } from 'vitest';
import type { PulseKnowledgeCard, PulseKnowledgePost } from '../knowledge.js';
import { mergePulseFeedPages, pulseKnowledgeCardLines } from '../pulse-knowledge-card.js';
import { PULSE_KNOWLEDGE_WORDS as W } from '../pulse-knowledge-words.js';
import { pseudoLocalise, setLanguage, t, tn } from '../words.js';

const post = (over: Partial<PulseKnowledgePost> = {}): PulseKnowledgePost => ({
    id: 'k1', title: 'How recycling works at the tip', topic: 'local-services', line: 'Bring glass, cans and paper sorted.',
    photo: null, by: null, gathered: false, ...over,
});
const card = (posts: PulseKnowledgePost[], count = posts.length, day = '2026-11-15'): PulseKnowledgeCard => ({
    id: `know_${day}`, source: 'knowledge', platform: 'beanpool', category: 'knowledge', url: null, thumbnailUrl: null,
    ownerPubkey: '', callsign: '', avatarUrl: null, isVerified: false, title: posts[0]?.title ?? '',
    publishedAt: `${day}T03:00:00.000Z`, knowledge: { count, posts },
});

describe('the words the card draws (PULSE_KNOWLEDGE_WORDS, the phone\'s table)', () => {
    it('are the design\'s own sentences', () => {
        setLanguage('en');
        expect(t(W.head)).toBe('New local knowledge');
        expect(tn(8, W.headMany.one, W.headMany.other, { n: 8 })).toBe('8 new in Local knowledge');
        expect(t(W.spokenOne, { title: 'How recycling works at the tip' })).toBe('New local knowledge: How recycling works at the tip. Opens it in Learn.');
        expect(tn(8, W.spokenMany.one, W.spokenMany.other, { n: 8 })).toBe('8 new in Local knowledge. Opens Learn.');
        expect(t(W.by, { name: 'Ada' })).toBe('by Ada');
        expect(tn(5, W.more.one, W.more.other, { n: 5 })).toBe('and 5 more ›');
        expect(t(W.openLearn)).toBe('Open Learn ›');
    });

    it('never says "resilience" or "survival"', () => {
        expect(JSON.stringify(W)).not.toMatch(/resilien|surviv/i);
    });
});

describe('pulseKnowledgeCardLines', () => {
    it('one page: "New local knowledge", the page\'s topic for the chip, the writer\'s name, and its spoken line', () => {
        setLanguage('en');
        const lines = pulseKnowledgeCardLines(card([post({ by: 'Ada' })]))!;
        expect(lines.single).toBe(true);
        expect(lines.head.text).toBe('New local knowledge');
        expect(lines.topic).toBe('local-services');
        expect(lines.by).toBe('by Ada');
        expect(lines.rows.map((r) => r.post.id)).toEqual(['k1']);
        expect(lines.more).toBeNull();
        // The head and the row are one tap to the page: one spoken line for both.
        expect(lines.head.spoken).toBe('New local knowledge: How recycling works at the tip. Opens it in Learn.');
        expect(lines.rows[0].spoken).toBe(lines.head.spoken);
        expect(lines.foot).toEqual({ text: 'Open Learn ›', spoken: 'Open Learn' });
    });

    it('no name on a page gathered with the assistant, or with no writer\'s name', () => {
        expect(pulseKnowledgeCardLines(card([post({ by: 'Ada', gathered: true })]))!.by).toBeNull();
        expect(pulseKnowledgeCardLines(card([post({ by: null })]))!.by).toBeNull();
        expect(pulseKnowledgeCardLines(card([post({ by: '   ' })]))!.by).toBeNull();
    });

    it('several the same day: "{n} new in Local knowledge", the first three rows, "and {n} more ›", no chip and no name', () => {
        setLanguage('en');
        const posts = [post({ id: 'a', by: 'Ada' }), post({ id: 'b', title: 'Who to call when the river rises' }), post({ id: 'c', title: 'The library\'s hours' })];
        const lines = pulseKnowledgeCardLines(card(posts, 8))!;
        expect(lines.single).toBe(false);
        expect(lines.head).toEqual({ text: '8 new in Local knowledge', spoken: '8 new in Local knowledge. Opens Learn.' });
        expect(lines.rows.map((r) => r.post.id)).toEqual(['a', 'b', 'c']);
        expect(lines.rows.map((r) => r.spoken)).toEqual([
            'Local knowledge: How recycling works at the tip', 'Local knowledge: Who to call when the river rises', 'Local knowledge: The library\'s hours',
        ]);
        expect(lines.more).toEqual({ text: 'and 5 more ›', spoken: '5 more in Learn' });
        expect(lines.topic).toBeNull();
        expect(lines.by).toBeNull();
        expect(lines.foot).toEqual({ text: 'Open Learn ›', spoken: 'Open Learn' });
    });

    it('two or three the same day have no "and {n} more"; a node that sent more rows than three still shows three', () => {
        expect(pulseKnowledgeCardLines(card([post({ id: 'a' }), post({ id: 'b' })]))!.more).toBeNull();
        const five = [1, 2, 3, 4, 5].map((n) => post({ id: `p${n}` }));
        const lines = pulseKnowledgeCardLines(card(five, 5))!;
        expect(lines.rows).toHaveLength(3);
        expect(lines.more?.text).toBe('and 2 more ›');
    });

    it('a card with no rows draws nothing (never an empty card)', () => {
        expect(pulseKnowledgeCardLines(card([], 0))).toBeNull();
        expect(pulseKnowledgeCardLines({ ...card([post()]), knowledge: undefined } as unknown as PulseKnowledgeCard)).toBeNull();
    });

    it('speaks in the reader\'s language: every line through t()', () => {
        setLanguage('xx');
        try {
            const one = pulseKnowledgeCardLines(card([post({ by: 'Ada' })]))!;
            expect(one.head.text).toBe(pseudoLocalise('New local knowledge'));
            expect(one.foot).toEqual({ text: pseudoLocalise('Open Learn ›'), spoken: pseudoLocalise('Open Learn') });
            expect(one.by).toBe(pseudoLocalise('by {name}').replace('{name}', 'Ada'));
            const many = pulseKnowledgeCardLines(card([post({ id: 'a' }), post({ id: 'b' }), post({ id: 'c' })], 4))!;
            expect(many.head.text).toBe(pseudoLocalise('{n} new in Local knowledge').replace('{n}', '4'));
            expect(many.head.spoken).toBe(pseudoLocalise('{n} new in Local knowledge. Opens Learn.').replace('{n}', '4'));
            expect(many.rows[0].spoken).toBe(pseudoLocalise('Local knowledge: {title}').replace('{title}', 'How recycling works at the tip'));
            expect(many.more).toEqual({ text: pseudoLocalise('and {n} more ›').replace('{n}', '1'), spoken: pseudoLocalise('{n} more in Learn').replace('{n}', '1') });
        } finally {
            setLanguage('en');
        }
    });
});

describe('mergePulseFeedPages: one card a day across pages', () => {
    const creator = (id: string) => ({ id, source: 'oauth' });
    const know = (day: string, count: number) => ({ id: `know_${day}`, source: 'knowledge', count });

    it('appends the next page after the ones already shown', () => {
        expect(mergePulseFeedPages([creator('a'), creator('b')], [creator('c')]).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    it('a day\'s card that moved older between reads (a takedown) shows once, the newest copy, in the place already shown', () => {
        const first = [creator('a'), know('2026-11-14', 3), creator('b')];
        const next = [creator('c'), know('2026-11-14', 2), creator('d')];
        const merged = mergePulseFeedPages(first, next);
        // Nothing above the member jumps: the card stays where they scrolled past it, with the newer read's rows.
        expect(merged.map((i) => i.id)).toEqual(['a', 'know_2026-11-14', 'b', 'c', 'd']);
        expect(merged.filter((i) => i.id === 'know_2026-11-14')).toEqual([know('2026-11-14', 2)]);
    });

    it('a creator\'s item the next page repeats is not drawn twice, and keeps its place', () => {
        expect(mergePulseFeedPages([creator('a'), creator('b')], [creator('b'), creator('c')]).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    it('never two cards for one day, even when one page carries the same day twice', () => {
        const merged = mergePulseFeedPages([know('2026-11-15', 1)], [know('2026-11-13', 1), know('2026-11-13', 4)]);
        expect(merged.map((i) => i.id)).toEqual(['know_2026-11-15', 'know_2026-11-13']);
        expect(merged[1]).toEqual(know('2026-11-13', 4));
        expect(new Set(merged.map((i) => i.id)).size).toBe(merged.length);
    });

    it('does not change the lists it was given', () => {
        const first = [creator('a'), know('2026-11-14', 3)];
        const next = [know('2026-11-14', 2)];
        mergePulseFeedPages(first, next);
        expect(first.map((i) => i.id)).toEqual(['a', 'know_2026-11-14']);
        expect(next).toHaveLength(1);
    });
});
