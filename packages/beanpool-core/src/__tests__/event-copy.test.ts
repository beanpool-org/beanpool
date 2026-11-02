/**
 * A copy as both apps read it (event-copy.ts): the node's own read and the phone's cached column, and the door's words,
 * in English and in a language with its machine drafts. A row with no line draws no door.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setLanguage } from '../words.js';
import { listingCopyHint, copyAsk, copyCardLine, copyDoorButton, copyDoorLine, copyFromLine, eventCopyColumn, eventCopyOf, type ShownFromLine } from '../event-copy.js';

const FROM: ShownFromLine = { host: 'mullum.example.org', postId: 'p1', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' };
const es = JSON.parse(readFileSync(fileURLToPath(new URL('../../words/es.json', import.meta.url)), 'utf8'));

afterEach(() => setLanguage('en'));

describe('a copy, as the apps read it', () => {
    it('reads the node\'s word, and is null for any other post', () => {
        expect(eventCopyOf({ shownCopy: true, shownFrom: FROM })).toEqual({ from: FROM });
        expect(eventCopyOf({ shownCopy: true })).toEqual({ from: null });
        expect(eventCopyOf({})).toBeNull();
        expect(eventCopyOf(null)).toBeNull();
    });

    it('reads back the phone\'s cached column, a copy with no line included', () => {
        const withLine = eventCopyColumn({ shownCopy: true, shownFrom: FROM });
        const without = eventCopyColumn({ shownCopy: true });
        expect(eventCopyOf({ shown_from: withLine })).toEqual({ from: FROM });
        expect(eventCopyOf({ shown_from: without })).toEqual({ from: null });
        expect(eventCopyColumn({})).toBeNull();
        expect(eventCopyOf({ shown_from: 'not json' })).toEqual({ from: null });
    });

    it('draws no line from anything that is not a whole https row', () => {
        expect(eventCopyOf({ shownCopy: true, shownFrom: { ...FROM, url: 'javascript:alert(1)' } })).toEqual({ from: null });
        expect(eventCopyOf({ shownCopy: true, shownFrom: { ...FROM, url: 'http://mullum.example.org' } })).toEqual({ from: null });
        expect(eventCopyOf({ shownCopy: true, shownFrom: { ...FROM, name: '' } })).toEqual({ from: null });
    });
});

describe('the door\'s words', () => {
    it('asks, or says by invite, or says what is left to say', () => {
        expect(copyFromLine(FROM)).toBe('from Mullumbimby');
        expect(copyCardLine(FROM)).toBe('from Mullumbimby · Ask to join');
        expect(copyDoorLine({ from: FROM })).toBe('To go, ask to join Mullumbimby');
        expect(copyDoorButton({ from: FROM })).toBe('Ask to join Mullumbimby');
        const invite: ShownFromLine = { ...FROM, door: 'invite' };
        expect(copyCardLine(invite)).toBe('from Mullumbimby · Takes new members by invite');
        expect(copyDoorLine({ from: invite })).toBe('To go, ask someone in Mullumbimby. It takes new members by invite.');
        expect(copyDoorButton({ from: invite })).toBeNull();
        expect(copyDoorLine({ from: null })).toBe("This event is run by another community, so you can't say you are going from here.");
        expect(copyDoorButton({ from: null })).toBeNull();
    });

    it('goes through the words layer: Spanish, with the community\'s own name in it', () => {
        setLanguage('es', [es]);
        expect(copyFromLine(FROM)).toBe('de Mullumbimby');
        expect(copyDoorLine({ from: FROM })).toBe('Para ir, pide unirte a Mullumbimby');
        expect(copyDoorLine({ from: null })).not.toContain('This event');
    });

    it('a listing\'s hint holds with the door\'s tick on or off: it never says flatly that no name shows', () => {
        for (const need of [false, true]) {
            expect(listingCopyHint(need)).toContain('not your name unless you take questions about it');
            expect(listingCopyHint(need)).not.toContain('Not your name');
        }
        expect(listingCopyHint()).toContain('To buy or take it');
        expect(listingCopyHint(true)).toContain('To answer it');
    });

    it('a listing\'s hint is in every language, and an Offer\'s and a Need\'s differ there too', () => {
        const dir = fileURLToPath(new URL('../../words/', import.meta.url));
        const langs = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.sources.json');
        expect(langs).toHaveLength(24);
        for (const file of langs) {
            setLanguage(file.slice(0, -5), [JSON.parse(readFileSync(`${dir}${file}`, 'utf8'))]);
            expect(listingCopyHint(), file).not.toContain('Anyone there');
            expect(listingCopyHint(true), file).not.toContain('Anyone there');
            expect(listingCopyHint(true), file).not.toBe(listingCopyHint());
        }
    });
});

describe('who a reader can ask about a copy', () => {
    const KEY = 'ab'.repeat(32);
    const row = { shownCopy: true, shownFrom: null, type: 'offer' };

    it('nobody on a shut copy, whatever the row names', () => {
        expect(copyAsk(eventCopyOf(row), 'Robin', KEY)).toBeNull();
    });
    it('their name and key on an open one', () => {
        expect(copyAsk(eventCopyOf({ ...row, takesQuestions: true }), 'Robin', KEY)).toEqual({ name: 'Robin', key: KEY });
    });
    it('nobody where the row names nobody: a visitor\'s neutral author, an empty name', () => {
        const open = eventCopyOf({ ...row, takesQuestions: true });
        expect(copyAsk(open, 'Robin', 'hidden')).toBeNull();
        expect(copyAsk(open, '', KEY)).toBeNull();
        expect(copyAsk(open, 'Robin', undefined)).toBeNull();
    });
    it('only `true` opens one', () => {
        expect(eventCopyOf({ ...row, takesQuestions: 'true' })?.takesQuestions).toBeUndefined();
    });
    it('a phone\'s cached column keeps it, and a shut copy\'s says nothing of one', () => {
        const open = eventCopyColumn({ shownCopy: true, shownFrom: { host: 'h', name: 'N', url: 'https://h', door: 'ask' }, takesQuestions: true });
        expect(eventCopyOf({ shown_from: open, type: 'offer' })?.takesQuestions).toBe(true);
        const shut = eventCopyColumn({ shownCopy: true, shownFrom: { host: 'h', name: 'N', url: 'https://h', door: 'ask' } });
        expect(shut).not.toContain('takesQuestions');
        expect(eventCopyOf({ shown_from: shut, type: 'offer' })?.takesQuestions).toBeUndefined();
    });
});

