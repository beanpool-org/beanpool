/**
 * The owner's count (notifications N6, notify-reach.ts): which rows are members a phone can notify, which are members with
 * no phone registered, and which are not members here at all; the count over them; what a node's answer must look like to
 * be shown; and the Members page's two lines. One exhaustive table over every state a row can be in, so each line of the
 * rule has rows that go red without it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { LANGS, setLanguage, t, tn, wordsFor, PSEUDO_LANG } from '../words.js';
import {
    NOTIFY_REACH_WORDS, isNotifyPhonePlatform, isNotifyReach, notifyReachCount, notifyReachLines, notifyReachOf,
    type NotifyReachKind, type NotifyReachRow,
} from '../notify-reach.js';

const wordsDir = new URL('../../words/', import.meta.url);
const catalog = (lang: string) => JSON.parse(readFileSync(new URL(`${lang}.json`, wordsDir), 'utf8'));

afterEach(() => setLanguage('en'));

// Every status a members row is given (state-engine, engine/members.ts), and a row older code left with none.
const STATUSES = ['active', 'suspended', 'disabled', 'paused', 'pruned', null] as const;
// What a member's push tokens' platforms can hold: none, each phone's name in either case, a browser's word, a word some
// other client sent, a row with no platform, and two phones, or a phone beside a non-phone.
const TOKEN_SETS: Array<{ platforms: Array<string | null>; phone: boolean }> = [
    { platforms: [], phone: false },
    { platforms: ['ios'], phone: true },
    { platforms: ['android'], phone: true },
    { platforms: ['IOS'], phone: true },
    { platforms: ['Android'], phone: true },
    { platforms: ['web'], phone: false },
    { platforms: ['pwa'], phone: false },
    { platforms: ['windows'], phone: false },
    { platforms: [null], phone: false },
    { platforms: ['ios', 'android'], phone: true },
    { platforms: ['web', 'android'], phone: true },
    { platforms: [null, 'ios'], phone: true },
];

interface Case { row: NotifyReachRow; want: NotifyReachKind; why: string }

/** Every combination of status, treasury, visitor, retired and token set, each with the kind it must be and why. */
function everyCase(): Case[] {
    const out: Case[] = [];
    for (const status of STATUSES) for (const isTreasury of [false, true]) for (const isVisitor of [false, true])
        for (const retired of [false, true]) for (const tokens of TOKEN_SETS) {
            const out_ = status === 'pruned' ? 'pruned' : isTreasury ? 'treasury' : isVisitor ? 'visitor' : retired ? 'retired' : null;
            const want: NotifyReachKind = out_ ? 'not-counted' : tokens.phone ? 'phone' : 'no-phone';
            const why = out_ ? `not a member here (${out_})` : tokens.phone ? 'a member with a phone registered' : 'a member with no phone registered';
            out.push({ row: { status, isTreasury, isVisitor, retired, tokenPlatforms: tokens.platforms }, want, why });
        }
    return out;
}

describe('which rows count, and as what', () => {
    const cases = everyCase();

    it('the table holds every combination: 6 statuses x treasury x visitor x retired x 12 token sets', () => {
        expect(cases).toHaveLength(STATUSES.length * 2 * 2 * 2 * TOKEN_SETS.length);
        expect(new Set(cases.map((c) => JSON.stringify(c.row))).size).toBe(cases.length);
        // Every kind is reached, and each reason for leaving a row out is reached alone (the rest of the row a member's).
        expect(new Set(cases.map((c) => c.want))).toEqual(new Set(['phone', 'no-phone', 'not-counted']));
    });

    it.each(cases.map((c) => [JSON.stringify(c.row), c.want, c.why, c.row] as const))('%s -> %s (%s)', (_label, want, _why, row) => {
        expect(notifyReachOf(row)).toBe(want);
    });

    it('each reason a row is left out leaves out a member who has a phone, alone', () => {
        const member: NotifyReachRow = { status: 'active', isTreasury: false, isVisitor: false, retired: false, tokenPlatforms: ['ios'] };
        expect(notifyReachOf(member)).toBe('phone');
        expect(notifyReachOf({ ...member, status: 'pruned' })).toBe('not-counted');
        expect(notifyReachOf({ ...member, isTreasury: true })).toBe('not-counted');
        expect(notifyReachOf({ ...member, isVisitor: true })).toBe('not-counted');
        expect(notifyReachOf({ ...member, retired: true })).toBe('not-counted');
        // A suspended or disabled member is still a member, and so is a row with no status.
        for (const status of ['suspended', 'disabled', 'paused', null, undefined]) expect(notifyReachOf({ ...member, status })).toBe('phone');
    });

    it('a phone is an iPhone or an Android, in any case; a browser, another word or no platform is not', () => {
        for (const p of ['ios', 'android', 'IOS', 'iOS', 'Android', 'ANDROID']) expect(isNotifyPhonePlatform(p), p).toBe(true);
        for (const p of ['web', 'pwa', 'windows', '', ' ios', 'ios ', 'iphone', null, undefined]) expect(isNotifyPhonePlatform(p), String(p)).toBe(false);
    });
});

describe('the count', () => {
    it('counts each member once, as a phone when any of its tokens is one; rows that are not members add nothing', () => {
        const cases = everyCase();
        const counted = cases.filter((c) => c.want !== 'not-counted');
        expect(notifyReachCount(cases.map((c) => c.row))).toEqual({
            phones: counted.filter((c) => c.want === 'phone').length,
            members: counted.length,
        });
    });

    it("the design's example: 61 of 84, and treasuries, visitors, retired and pruned rows with phones do not move it", () => {
        const member = (tokens: string[]): NotifyReachRow => ({ status: 'active', isTreasury: false, isVisitor: false, retired: false, tokenPlatforms: tokens });
        const rows: NotifyReachRow[] = [
            ...Array.from({ length: 40 }, () => member(['ios'])),
            ...Array.from({ length: 20 }, () => member(['android'])),
            member(['ios', 'android']),
            ...Array.from({ length: 23 }, () => member([])),
            { ...member(['ios']), isTreasury: true },
            { ...member(['android']), isVisitor: true },
            { ...member(['ios']), retired: true, status: 'disabled' },
            { ...member(['android']), status: 'pruned' },
        ];
        expect(notifyReachCount(rows)).toEqual({ phones: 61, members: 84 });
    });

    it('no rows: none of none', () => {
        expect(notifyReachCount([])).toEqual({ phones: 0, members: 0 });
    });
});

describe("a node's answer: shown only when it is a count", () => {
    it.each([
        [{ phones: 0, members: 0 }, true],
        [{ phones: 61, members: 84 }, true],
        [{ phones: 84, members: 84 }, true],
        [{ phones: 85, members: 84 }, false],
        [{ phones: -1, members: 3 }, false],
        [{ phones: 1.5, members: 3 }, false],
        [{ phones: 1, members: Number.POSITIVE_INFINITY }, false],
        [{ phones: Number.NaN, members: 3 }, false],
        [{ phones: '1', members: 3 }, false],
        [{ phones: 1 }, false],
        [{ members: 3 }, false],
        [{}, false],
        [null, false],
        [undefined, false],
        ['61 of 84', false],
        [61, false],
    ])('%j -> %s', (value, want) => {
        expect(isNotifyReach(value)).toBe(want);
    });
});

describe('the two lines', () => {
    const en = { t, tn };

    it.each([
        [{ phones: 61, members: 84 }, 'Members a phone can notify: 61 of 84',
            "The other 23 use the web only, haven't turned notifications on, or said no. The server can't tell which."],
        [{ phones: 4, members: 5 }, 'Members a phone can notify: 4 of 5',
            "The other 1 uses the web only, hasn't turned notifications on, or said no. The server can't tell which."],
        [{ phones: 0, members: 5 }, 'Members a phone can notify: 0 of 5',
            "The other 5 use the web only, haven't turned notifications on, or said no. The server can't tell which."],
        [{ phones: 5, members: 5 }, 'Members a phone can notify: 5 of 5', null],
        [{ phones: 0, members: 0 }, 'Members a phone can notify: 0 of 0', null],
    ])('%j', (reach, headline, others) => {
        expect(notifyReachLines(reach, en)).toEqual({ headline, others });
    });

    it('names nobody and warns of nothing: no name, no key, no Freeze or Turn on in either line', () => {
        const lines = notifyReachLines({ phones: 61, members: 84 }, en);
        for (const line of [lines.headline, lines.others ?? '']) {
            expect(line).not.toMatch(/freeze|turn on notifications for|warning|⚠|@/i);
            expect(line).not.toMatch(/resilien|surviv/i);
        }
    });

    it('in the pseudo language every line is drawn through the words layer (nothing left in plain English)', () => {
        const pseudo = wordsFor(PSEUDO_LANG);
        const lines = notifyReachLines({ phones: 61, members: 84 }, pseudo);
        expect(lines.headline).not.toBe('Members a phone can notify: 61 of 84');
        expect(lines.headline).toContain('61');
        expect(lines.headline).toContain('84');
        expect(lines.others).not.toBeNull();
        expect(lines.others).not.toContain('The other');
        expect(lines.others).toContain('23');
    });

    it('in Spanish, with its machine drafts: the numbers in place, one and many', () => {
        const es = wordsFor('es', [catalog('es')]);
        const lines = notifyReachLines({ phones: 61, members: 84 }, es);
        expect(lines.headline).toContain('61');
        expect(lines.headline).toContain('84');
        expect(lines.headline).not.toBe('Members a phone can notify: 61 of 84');
        expect(lines.others).toContain('23');
        expect(notifyReachLines({ phones: 4, members: 5 }, es).others).not.toBe(lines.others?.replace('23', '1'));
    });

    it('every language has both sentences, with the same placeholders, every plural form it needs, and none is the English', () => {
        const W = NOTIFY_REACH_WORDS;
        const files = readdirSync(wordsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
        expect(files).toEqual([...LANGS].filter((l) => l !== 'en').sort());
        const pluralKey = `${W.others.one}|${W.others.other}`;
        for (const lang of files) {
            const c = catalog(lang);
            const headline = c[W.headline];
            expect(typeof headline, `${lang}: headline`).toBe('string');
            expect(headline.includes('{n}') && headline.includes('{m}'), `${lang}: headline placeholders`).toBe(true);
            expect(headline, `${lang}: headline`).not.toBe(W.headline);
            const forms = c[pluralKey];
            expect(forms && typeof forms === 'object', `${lang}: plural entry`).toBe(true);
            expect(typeof forms.other, `${lang}: other`).toBe('string');
            // The forms this language's other plural entries carry (the '{n} day' entry beside it), and no fewer.
            const model = c['{n} day|{n} days'];
            expect(Object.keys(forms).sort(), `${lang}: plural forms`).toEqual(Object.keys(model).sort());
            for (const [form, text] of Object.entries(forms as Record<string, string>)) {
                expect(text, `${lang} ${form}`).not.toBe(W.others.other);
                expect(text, `${lang} ${form}`).not.toBe(W.others.one);
                expect(text.includes('{m}'), `${lang} ${form}: no {m}`).toBe(false);
            }
            // Every form but a language's own word for exactly one (Arabic's one and two) shows the number.
            expect(forms.other.includes('{n}'), `${lang}: other shows {n}`).toBe(true);
        }
    });

    it('the device language switch reaches them too (setLanguage, as the apps do)', () => {
        setLanguage('fr', [catalog('fr')]);
        const lines = notifyReachLines({ phones: 61, members: 84 }, { t, tn });
        expect(lines.headline).not.toBe('Members a phone can notify: 61 of 84');
        expect(lines.headline).toContain('61');
    });
});
