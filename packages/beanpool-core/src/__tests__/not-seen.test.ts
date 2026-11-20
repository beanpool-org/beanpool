/**
 * "Not seen yet" (DESIGN-notify-and-backup-asks-fable §4.5; amendment 2 §12.3, slice N4): one table over every state the
 * rule reads. Each row names the line of not-seen.ts it holds: take that line out and the row goes red.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
    NOT_SEEN_AFTER_MS,
    NOT_SEEN_ANOTHER_WAY_AFTER_MS,
    notSeenInThread,
    notSeenOf,
    notSeenOfDeal,
    notSeenWords,
    type NotSeen,
    type NotSeenLine,
} from '../not-seen.js';
import { LANGS, PLURAL_FORMS, pluralKey, setLanguage, type Catalog } from '../words.js';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const NONE: NotSeen = { state: 'none' };
const NOT_SEEN: NotSeen = { state: 'not-seen' };
const days = (n: number): NotSeen => ({ state: 'another-way', days: n });

describe('notSeenOf: one thing sent, its tick and its age', () => {
    const rows: Array<[string, string | number | null | undefined, boolean, NotSeen]> = [
        ['sent just now', ago(0), false, NONE],
        ['23h59m: not yet a day', ago(D - 60_000), false, NONE],
        ['exactly 24 hours: "Not seen yet." (>= NOT_SEEN_AFTER_MS)', ago(NOT_SEEN_AFTER_MS), false, NOT_SEEN],
        ['2 days 23 hours: still "Not seen yet."', ago(3 * D - H), false, NOT_SEEN],
        ['exactly 3 days: the other way (>= NOT_SEEN_ANOTHER_WAY_AFTER_MS)', ago(NOT_SEEN_ANOTHER_WAY_AFTER_MS), false, days(3)],
        ['3 days 23 hours: whole days, floored', ago(4 * D - H), false, days(3)],
        ['10 days', ago(10 * D), false, days(10)],
        ['as milliseconds', NOW - 5 * D, false, days(5)],
        ['seen: nothing, however old (if (seen) return NONE)', ago(10 * D), true, NONE],
        ['seen at a day: nothing', ago(D), true, NONE],
        ['no time', null, false, NONE],
        ['undefined time', undefined, false, NONE],
        ['empty string', '', false, NONE],
        ['a time that does not read', 'yesterday', false, NONE],
        ['NaN milliseconds', Number.NaN, false, NONE],
        ['in the future on this clock (a clock behind the node)', ago(-2 * D), false, NONE],
    ];
    it.each(rows)('%s', (_name, sentAt, seen, want) => {
        expect(notSeenOf(sentAt, seen, NOW)).toEqual(want);
    });
    it('a now that does not read says nothing', () => {
        expect(notSeenOf(ago(5 * D), false, Number.NaN)).toEqual(NONE);
    });
});

// Lines oldest first, as both apps hold a thread.
const mine = (age: number, more: Partial<NotSeenLine> = {}): NotSeenLine => ({ mine: true, at: ago(age), seen: false, delivered: true, counts: true, ...more });
const theirs = (age: number, more: Partial<NotSeenLine> = {}): NotSeenLine => ({ mine: false, at: ago(age), seen: false, delivered: true, counts: true, ...more });
/** A notice: the app's own key-changed notice or a node's deal step. Nobody's line. */
const notice = (age: number): NotSeenLine => ({ mine: false, at: ago(age), seen: false, delivered: true, counts: false });

describe('notSeenInThread: which line carries the words, and which words', () => {
    const rows: Array<[string, NotSeenLine[], { index: number; notSeen: NotSeen } | null]> = [
        ['an empty chat', [], null],
        ['only their line', [theirs(5 * D)], null],
        ['my one line, 25 hours, unseen', [mine(25 * H)], { index: 0, notSeen: NOT_SEEN }],
        ['my one line, 4 days, unseen', [mine(4 * D)], { index: 0, notSeen: days(4) }],
        ['my one line, an hour: too soon', [mine(H)], null],
        ['my one line seen (if (line.seen) break)', [mine(5 * D, { seen: true })], null],
        // if (!line.mine) break: they wrote after it, so they were in the chat.
        ['their line after mine (if (!line.mine) break)', [mine(5 * D), theirs(4 * D)], null],
        ['their line, then mine at 2 days', [theirs(6 * D), mine(2 * D)], { index: 1, notSeen: NOT_SEEN }],
        // if (!line.counts) continue: a notice is nobody's line, passed over (else it would end the walk as "theirs").
        ['a notice after my unseen line (if (!line.counts) continue)', [mine(4 * D), notice(H)], { index: 0, notSeen: days(4) }],
        ['a line shown as nobody\'s after mine', [mine(2 * D), { ...theirs(H), counts: false }], { index: 0, notSeen: NOT_SEEN }],
        // if (!line.delivered) continue: still sending or failed carries no tick; the words go under the delivered one.
        ['a failed line after my unseen one (if (!line.delivered) continue)', [mine(4 * D), mine(3 * D, { delivered: false })], { index: 0, notSeen: days(4) }],
        ['only a line still sending, 5 days on this clock', [mine(5 * D, { delivered: false })], null],
        ['only a failed line, 5 days', [mine(5 * D, { delivered: false })], null],
        // The time is the oldest still unseen since their last line: they have waited that long. The words go under the newest.
        ['two of mine unseen: 4 days and an hour (oldest = at)', [mine(4 * D), mine(H)], { index: 1, notSeen: days(4) }],
        ['three of mine unseen: 2 days, 1 day, 1 hour', [mine(2 * D), mine(D), mine(H)], { index: 2, notSeen: NOT_SEEN }],
        // The tick is a cursor: a seen line of mine means every older one is seen too, so the count starts after it.
        ['mine seen at 5 days, mine unseen at 2 days (if (line.seen) break)', [mine(5 * D, { seen: true }), mine(2 * D)], { index: 1, notSeen: NOT_SEEN }],
        ['mine seen at 5 days, mine unseen at an hour', [mine(5 * D, { seen: true }), mine(H)], null],
        ['their line resets the count: mine 6 days, theirs 5, mine 2 hours', [mine(6 * D), theirs(5 * D), mine(2 * H)], null],
        // if (at != null) oldest = at: a time that doesn't read is passed over, never counted as 0 or as now.
        ['an older line with no readable time, a newer at 2 days', [mine(0, { at: 'garbled' }), mine(2 * D)], { index: 1, notSeen: NOT_SEEN }],
        ['my only line has no readable time', [mine(0, { at: null })], null],
        ['a notice between two of mine, both unseen', [mine(4 * D), notice(3 * D), mine(H)], { index: 2, notSeen: days(4) }],
    ];
    it.each(rows)('%s', (_name, lines, want) => {
        expect(notSeenInThread(lines, NOW)).toEqual(want);
    });

    it('the same for everyone: nothing about the other person but the tick and the time is read', () => {
        // Whatever else an app might hold about the other person (whether a phone can notify them, a setting of theirs),
        // the answer is the same: the rule has no input for it (no oracle, memory broadcast-reach-oracle).
        const plain = [mine(4 * D)];
        const decorated = [{ ...mine(4 * D), peerPushable: false, peerNotifications: 'off' } as NotSeenLine];
        expect(notSeenInThread(decorated, NOW)).toEqual(notSeenInThread(plain, NOW));
        expect(notSeenInThread(decorated, NOW)).toEqual({ index: 0, notSeen: days(4) });
    });
});

describe('notSeenOfDeal: a deal request that sits unseen', () => {
    const rows: Array<[string, { asked: boolean; createdAt: string | number | null | undefined; peerReadAt: string | number | null | undefined }, NotSeen]> = [
        ['asked 25 hours ago, no cursor', { asked: true, createdAt: ago(25 * H), peerReadAt: null }, NOT_SEEN],
        ['asked 4 days ago, cursor from before it', { asked: true, createdAt: ago(4 * D), peerReadAt: ago(6 * D) }, days(4)],
        ['asked 4 days ago, cursor exactly at it (read >= made)', { asked: true, createdAt: ago(4 * D), peerReadAt: ago(4 * D) }, NONE],
        ['asked 4 days ago, cursor after it', { asked: true, createdAt: ago(4 * D), peerReadAt: ago(2 * D) }, NONE],
        ['asked an hour ago: too soon', { asked: true, createdAt: ago(H), peerReadAt: null }, NONE],
        ['not asked by me, or answered (if (!deal.asked) return NONE)', { asked: false, createdAt: ago(5 * D), peerReadAt: null }, NONE],
        ['no request time', { asked: true, createdAt: null, peerReadAt: null }, NONE],
        ['a request time that does not read', { asked: true, createdAt: 'soon', peerReadAt: null }, NONE],
        ['a cursor that does not read counts as none', { asked: true, createdAt: ago(2 * D), peerReadAt: 'garbled' }, NOT_SEEN],
        ['as milliseconds', { asked: true, createdAt: NOW - 3 * D, peerReadAt: NOW - 4 * D }, days(3)],
    ];
    it.each(rows)('%s', (_name, deal, want) => {
        expect(notSeenOfDeal(deal, NOW)).toEqual(want);
    });
});

describe('notSeenWords', () => {
    afterEach(() => setLanguage('en'));
    const rows: Array<[string, NotSeen, string | null | undefined, string | null]> = [
        ['nothing to say', NONE, 'Sam', null],
        ['a day', NOT_SEEN, 'Sam', 'Not seen yet.'],
        ['a day, no name', NOT_SEEN, null, 'Not seen yet.'],
        ['3 days, named', days(3), 'Sam', 'Not seen in 3 days. You could try Sam another way.'],
        ['12 days, named', days(12), 'Asha', 'Not seen in 12 days. You could try Asha another way.'],
        ['no name: them', days(3), null, 'Not seen in 3 days. You could try them another way.'],
        ['undefined name: them', days(4), undefined, 'Not seen in 4 days. You could try them another way.'],
        ['a blank name: them', days(5), '   ', 'Not seen in 5 days. You could try them another way.'],
    ];
    it.each(rows)('%s', (_name, state, name, want) => {
        expect(notSeenWords(state, name)).toBe(want);
    });

    const catalog = (lang: string): Catalog =>
        JSON.parse(readFileSync(new URL(`../../words/${lang}.json`, import.meta.url), 'utf8')) as Catalog;
    const keys = [
        pluralKey('Not seen in {n} day. You could try {name} another way.', 'Not seen in {n} days. You could try {name} another way.'),
        pluralKey('Not seen in {n} day. You could try them another way.', 'Not seen in {n} days. You could try them another way.'),
    ];

    it.each(LANGS.filter((l) => l !== 'en'))('%s: a machine draft for each sentence, every plural form its language needs', (lang) => {
        const c = catalog(lang) as Record<string, unknown>;
        expect(typeof c['Not seen yet.']).toBe('string');
        for (const key of keys) {
            const entry = c[key] as Record<string, string> | undefined;
            expect(entry, key).toBeTruthy();
            for (const form of PLURAL_FORMS[lang]) {
                expect(entry![form], `${lang} ${key} ${form}`).toContain('{n}');
            }
            if (key.includes('{name}')) for (const form of PLURAL_FORMS[lang]) expect(entry![form]).toContain('{name}');
        }
    });

    it('ru picks the form its count needs (3 few, 5 many, 21 one) and keeps the name', () => {
        setLanguage('ru', [catalog('ru')]);
        const ru = catalog('ru') as Record<string, Record<string, string>>;
        const forms = ru[keys[0]];
        expect(notSeenWords(days(3), 'Sam')).toBe(forms.few.replace('{n}', '3').replace('{name}', 'Sam'));
        expect(notSeenWords(days(5), 'Sam')).toBe(forms.many.replace('{n}', '5').replace('{name}', 'Sam'));
        expect(notSeenWords(days(21), 'Sam')).toBe(forms.one.replace('{n}', '21').replace('{name}', 'Sam'));
        expect(notSeenWords(NOT_SEEN)).toBe(String((ru as Record<string, unknown>)['Not seen yet.']));
    });
});
