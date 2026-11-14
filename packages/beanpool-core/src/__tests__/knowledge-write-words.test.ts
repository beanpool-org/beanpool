/**
 * The words of writing Local knowledge (slice K4): one table both apps draw, in the design's own sentences
 * (DESIGN-local-knowledge-fable.md §3.3, §3.4; amended §3.1, §3.3, §3.4), so the phone and the web say the same thing.
 */
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_WRITE_WORDS as W } from '../knowledge-write-words.js';
import { setLanguage, t, tn } from '../words.js';

describe('KNOWLEDGE_WRITE_WORDS', () => {
    it("Learn's button, a member's and an owner's or admin's, and the line for what waits", () => {
        setLanguage('en');
        expect([t(W.suggest), t(W.add), t(W.suggestPlain)]).toEqual(['＋ Suggest knowledge', '＋ Add local knowledge', 'Suggest knowledge']);
        expect(tn(1, W.waiting.one, W.waiting.other, { n: 1 })).toBe('1 of yours is waiting for an admin ›');
        expect(tn(3, W.waiting.one, W.waiting.other, { n: 3 })).toBe('3 of yours are waiting for an admin ›');
    });

    it('the form, top to bottom, its two buttons and the line under each, and what it says after', () => {
        expect([W.formBox, W.titleLabel, W.titleHint, W.bodyLabel, W.bodyHint, W.topicLabel, W.placeLabel, W.placeHint, W.sourcesLabel, W.addLink, W.linkLabelHint, W.photoLabel, W.addPhoto, W.photoLine].map((k) => t(k))).toEqual([
            'Share something worth knowing about this place: how something works, where to go, who to call. Not about private people. In your own words.',
            'TITLE *', 'e.g. How recycling works at the tip', 'WHAT TO KNOW *', 'Put the answer first. Then the details.', 'TOPIC *',
            'WHERE (OPTIONAL)', 'e.g. The tip on Manse Road', 'WHERE CAN PEOPLE CHECK THIS? (OPTIONAL)', 'Add a link', 'What is this page? (optional)',
            'PHOTO (OPTIONAL)', '📷 Add a photo', 'Your own photo. Without one, a picture for the topic is shown.',
        ]);
        expect([W.send, W.sendLine, W.publish, W.publishLine].map((k) => t(k))).toEqual([
            'Send to the admins', 'An owner or admin checks it before anyone sees it.', 'Publish', 'It goes into Learn, and the Pulse announces it.',
        ]);
        expect([W.sentTitle, W.sentLine, W.publishedTitle, W.publishedLine, W.openLearn].map((k) => t(k))).toEqual([
            'Sent', 'An owner or admin will check it. You’ll hear back here.', 'Published', 'It’s in Learn.', 'Open Learn',
        ]);
    });

    it('My suggestions: a row, taking one back, and an answer', () => {
        expect(t(W.kindStatus, { kind: t(W.kindNew), status: t(W.waitingSince, { date: '3 Nov' }) })).toBe('New · Waiting since 3 Nov');
        expect(t(W.kindFix)).toBe('Fix');
        expect([t(W.takeBack), t(W.takeBackAsk), t(W.keep), t(W.added), t(W.notAdded, { reason: 'We already have this' })]).toEqual([
            'Take it back', 'Take this back? The admins won’t see it.', 'Keep it', 'Added', 'Not added: We already have this',
        ]);
    });

    it('never says "resilience" or "survival", and never "a knowledge"', () => {
        const all = Object.values(W).flatMap((v) => (typeof v === 'string' ? [v] : [v.one, v.other])).join(' ').toLowerCase();
        expect(all).not.toMatch(/resilien|surviv|\ba knowledge\b/);
    });
});
