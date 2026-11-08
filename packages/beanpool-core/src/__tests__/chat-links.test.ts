import { describe, expect, it } from 'vitest';
import { normaliseTappedUrl, splitTextWithLinks } from '../chat-links.js';

// Both apps draw links from this one rule (the phone's ChatBubble, the web's ChatLinkedText): a message is plain runs and
// link runs, in order, and a link run opens the address normaliseTappedUrl gives it.

const runs = (text: string | null | undefined) => splitTextWithLinks(text).map(r => [r.text, r.isUrl] as const);

describe('splitTextWithLinks: which words are a link', () => {
    it('has nothing to draw for no words', () => {
        expect(splitTextWithLinks('')).toEqual([]);
        expect(splitTextWithLinks(null)).toEqual([]);
        expect(splitTextWithLinks(undefined)).toEqual([]);
    });

    it('leaves plain words as one plain run', () => {
        expect(runs('See you at the market at nine.')).toEqual([['See you at the market at nine.', false]]);
    });

    it('a message that is only a link is one link run', () => {
        expect(runs('https://byron.beanpool.org')).toEqual([['https://byron.beanpool.org', true]]);
    });

    it('keeps the words around a link, in order', () => {
        expect(runs('Join us at https://byron.beanpool.org on Sunday')).toEqual([
            ['Join us at ', false],
            ['https://byron.beanpool.org', true],
            [' on Sunday', false],
        ]);
    });

    it('finds http, https and a bare www., in any case', () => {
        expect(runs('http://a.org')).toEqual([['http://a.org', true]]);
        expect(runs('HTTPS://A.ORG/Path')).toEqual([['HTTPS://A.ORG/Path', true]]);
        expect(runs('www.beanpool.org')).toEqual([['www.beanpool.org', true]]);
        expect(runs('WWW.beanpool.org')).toEqual([['WWW.beanpool.org', true]]);
    });

    it('finds more than one link in a message', () => {
        expect(runs('a.org? try https://one.org/x or www.two.org now')).toEqual([
            ['a.org? try ', false],
            ['https://one.org/x', true],
            [' or ', false],
            ['www.two.org', true],
            [' now', false],
        ]);
    });

    it('a link ends at the next space or line break', () => {
        expect(runs('https://a.org/x\nnext line')).toEqual([
            ['https://a.org/x', true],
            ['\nnext line', false],
        ]);
    });

    it('keeps a link whole: query, fragment and a very long path', () => {
        const long = 'https://example.org/' + 'segment/'.repeat(40) + '?q=1&r=2#top';
        expect(runs(long)).toEqual([[long, true]]);
    });

    it('is not a link without a scheme or www.: a bare domain, an address, other schemes', () => {
        expect(runs('byron.beanpool.org')).toEqual([['byron.beanpool.org', false]]);
        expect(runs('mail me at a@b.org')).toEqual([['mail me at a@b.org', false]]);
        expect(runs('ftp://files.org/x')).toEqual([['ftp://files.org/x', false]]);
        expect(runs('mailto:a@b.org')).toEqual([['mailto:a@b.org', false]]);
        expect(runs('javascript:alert(1)')).toEqual([['javascript:alert(1)', false]]);
        // "www." inside a longer word is still found (as the phone has always found it); the run is then a link.
        expect(runs('awww.example.org')).toEqual([['a', false], ['www.example.org', true]]);
    });

    it('a link keeps the punctuation that follows it in the run; the address it opens drops it', () => {
        const [, link] = splitTextWithLinks('Try https://byron.beanpool.org.');
        expect(link).toEqual({ text: 'https://byron.beanpool.org.', isUrl: true });
        expect(normaliseTappedUrl(link.text)).toBe('https://byron.beanpool.org');
    });

    it('drops empty runs, so the text always joins back to the message', () => {
        for (const text of ['https://a.org', 'x https://a.org', 'https://a.org y', 'https://a.org https://b.org', 'no links']) {
            expect(splitTextWithLinks(text).map(r => r.text).join('')).toBe(text);
        }
        expect(splitTextWithLinks('https://a.org https://b.org').every(r => r.text !== '')).toBe(true);
    });
});

describe('normaliseTappedUrl: the address a link opens', () => {
    it.each([
        ['https://byron.beanpool.org', 'https://byron.beanpool.org'],
        ['http://byron.beanpool.org/a?b=1#c', 'http://byron.beanpool.org/a?b=1#c'],
        ['HTTPS://A.ORG', 'HTTPS://A.ORG'],
        // A bare www. is given a scheme, https.
        ['www.beanpool.org', 'https://www.beanpool.org'],
        ['WWW.beanpool.org/x', 'https://WWW.beanpool.org/x'],
        // Punctuation at the end of a sentence is not part of the address.
        ['https://a.org.', 'https://a.org'],
        ['https://a.org,', 'https://a.org'],
        ['https://a.org!?', 'https://a.org'],
        ['https://a.org)', 'https://a.org'],
        ['https://a.org/x"', 'https://a.org/x'],
        ["https://a.org/x'", 'https://a.org/x'],
        ['https://a.org/x]}', 'https://a.org/x'],
        ['www.a.org;', 'https://www.a.org'],
        // Punctuation inside the address stays.
        ['https://a.org/a.b,c', 'https://a.org/a.b,c'],
        // Anything that is not http(s) is refused.
        ['ftp://a.org', null],
        ['javascript:alert(1)', null],
        ['mailto:a@b.org', null],
        ['data:text/html,x', null],
        ['a.org', null],
        ['', null],
    ])('%s -> %s', (raw, expected) => {
        expect(normaliseTappedUrl(raw)).toBe(expected);
    });

    it('refuses nothing it was given as a link run, so a run from the split always has an address', () => {
        for (const text of ['https://a.org', 'http://a.org/x', 'www.a.org', 'WWW.A.ORG/p', 'see https://a.org.']) {
            for (const run of splitTextWithLinks(text).filter(r => r.isUrl)) {
                expect(normaliseTappedUrl(run.text)).not.toBeNull();
            }
        }
    });

    it('handles a missing value without throwing', () => {
        expect(normaliseTappedUrl(undefined as unknown as string)).toBeNull();
        expect(normaliseTappedUrl(null as unknown as string)).toBeNull();
    });
});
