/**
 * The sheet a tap on the member's own credit card opens, "Your Beans and your credit line" (DESIGN-credit-bar-amend-fable.md
 * §6, §11 slice R2): the same six parts on both apps, every figure equal to core's card and parts, the earning figures the
 * engine's own. Every figure is whole hundredths; `beans(n)` writes n Beans.
 */
import { describe, expect, it } from 'vitest';
import { CREDIT_SHEET_PARTS, creditSheet, type CreditSheet } from '../credit-sheet.js';
import { creditBarPicture, creditLineParts, creditStanding, type CreditStandingAnswer } from '../credit-standing.js';
import { beans, formatHundredths } from '../hundredths.js';
import { earnedCreditFromValue } from '../protocol.js';

const b = beans;

/** Owes 50 of a 500 line, all of it one vouch, one live Offer. */
const VOUCHED: CreditStandingAnswer = {
    balance_c: -b(50), floor_c: -b(500), usableFloor_c: -b(500), knownGrant_c: 0, roomHeld_c: b(500), earnedCredit_c: 0, liveOffers: 1,
    vouchedBy: [{ callsign: 'Jane', amount_c: b(500) }],
};
/** Earned 200, confirmed 1,000, two vouches (Jane first): 1,500 with two live Offers. */
const THREE_SOURCES: CreditStandingAnswer = {
    balance_c: b(40), floor_c: -b(1500), usableFloor_c: -b(1500), knownGrant_c: b(1000), roomHeld_c: b(300), earnedCredit_c: b(200), liveOffers: 2,
    vouchedBy: [{ callsign: 'Jane', amount_c: b(200) }, { callsign: 'Olive', amount_c: b(100) }],
};
/** Earned 600 and a vouch of 300: one live Offer opens 500 of 900. */
const PART_CLOSED: CreditStandingAnswer = {
    balance_c: -b(120), floor_c: -b(900), usableFloor_c: -b(500), knownGrant_c: 0, roomHeld_c: b(300), earnedCredit_c: b(600), liveOffers: 1,
    vouchedBy: [{ callsign: 'Jane', amount_c: b(300) }],
};
const ASLEEP: CreditStandingAnswer = { ...VOUCHED, balance_c: 0, usableFloor_c: 0, liveOffers: 0 };
const NO_LINE: CreditStandingAnswer = { balance_c: 0, floor_c: 0, usableFloor_c: 0, knownGrant_c: 0, roomHeld_c: 0, earnedCredit_c: 0, liveOffers: 0 };
/** A vouch of 500 with 100 of it passed on: a line of 400. */
const PASSED_ON: CreditStandingAnswer = { ...VOUCHED, floor_c: -b(400), usableFloor_c: -b(400), roomHeld_c: b(400) };
/** Earned 1,500 and confirmed 1,000, cut by the community's most at 2,000. */
const CAPPED: CreditStandingAnswer = {
    balance_c: 0, floor_c: -b(2000), usableFloor_c: -b(2000), knownGrant_c: b(1000), roomHeld_c: 0, earnedCredit_c: b(1500), liveOffers: 5,
};

const part = (s: CreditSheet, id: string) => s.parts.find((p) => p.id === id)!;
const texts = (s: CreditSheet, id: string) => part(s, id).rows.map((r) => r.text);
const allWords = (s: CreditSheet) => [s.title, ...s.parts.flatMap((p) => [p.title, ...p.rows.flatMap((r) => [r.text, r.line ?? '', r.figure ?? ''])]), s.links.givers, s.links.guide];

describe('the sheet: six parts in their order (R2)', () => {
    it('is titled "Your Beans and your credit line" and has the same six parts, in order, for every member', () => {
        expect(CREDIT_SHEET_PARTS).toEqual(['reading', 'line', 'earn', 'change', 'fees', 'who']);
        for (const a of [VOUCHED, THREE_SOURCES, PART_CLOSED, ASLEEP, NO_LINE, PASSED_ON, CAPPED]) {
            const s = creditSheet(a);
            expect(s.title).toBe('Your Beans and your credit line');
            expect(s.parts.map((p) => p.id)).toEqual([...CREDIT_SHEET_PARTS]);
            expect(s.parts.map((p) => p.title).filter((x) => x.trim() === '')).toEqual([]);
            for (const p of s.parts) expect(p.rows.length).toBeGreaterThan(0);
        }
    });
    it('names the parts as the design does', () => {
        const s = creditSheet(VOUCHED);
        expect(s.parts.map((p) => p.title)).toEqual([
            'Reading the bar', 'Your credit line: 500', 'Earn your own', 'What can change it', 'The two fees', 'Who can see this',
        ]);
        expect(s.links).toEqual({ givers: 'What people who give credit see', guide: 'More in the guide', guideSlug: 'credit-line' });
    });
});

describe('part 1, reading the bar: each mark beside its line, the figures the card draws', () => {
    it('draws the dot, 0, the left end and +200 with the card\'s own figures and lines, then the strip, the stripes, the colours and the two sides', () => {
        const s = creditSheet(VOUCHED);
        const pic = creditBarPicture(VOUCHED);
        const rows = part(s, 'reading').rows;
        expect(rows.map((r) => r.mark)).toEqual(['dot', 'zero', 'limit', 'fee', 'strip', 'stripes', 'colours', 'left', 'right']);
        expect(rows[1]).toMatchObject({ figure: pic.marks.zero.figure, text: 'You have given as much as you have received.' });
        expect(rows[2]).toMatchObject({ figure: '−500', text: 'The lowest your balance can go.' });
        expect(rows[3]).toMatchObject({ figure: '+200', text: 'Hold more than 200 Beans and a small monthly fee starts on the part above.' });
        expect(rows[0]!.text).toBe('Where your balance is now.');
        expect(rows[4]!.text).toBe('What your credit line is made of. A solid block is credit you earned by trading. An outlined block is credit someone stands behind for you.');
        expect(rows[5]!.text).toBe('Closed for now. Your live Offers open it.');
        expect(rows[6]!.text).toBe('Green: near zero. Orange, then red, on the left: closer to your limit. Orange on the right: Beans above 200.');
        expect(rows[7]!.text).toBe('Left of 0: you owe Beans. Owing costs nothing: there is no interest. It is a promise to help others later.');
        expect(rows[8]!.text).toBe('Right of 0: Beans you hold.');
    });
    it('with no line yet, the left end says the side opens with the first completed trade', () => {
        const rows = part(creditSheet(NO_LINE), 'reading').rows;
        expect(rows[2]).toMatchObject({ mark: 'limit', figure: '', text: 'This side opens with your first completed trade.' });
    });
});

describe('part 2, the credit line: its figures equal core\'s parts and the card\'s', () => {
    it('one vouch: the parts, each with its own line, the total and "all of it open"', () => {
        expect(part(creditSheet(VOUCHED), 'line').rows).toEqual([
            { text: 'Your balance can go down to −500. It is made of:' },
            { mark: 'solid', kind: 'earned', text: 'Earned by trading 0 so far', line: 'Yours, from your own completed trades. It grows as you trade.' },
            { mark: 'outlined', kind: 'vouch', text: '@Jane vouched 500', line: '@Jane stands behind this part for you.' },
            { mark: 'total', text: 'Your whole credit line: 500' },
            { text: 'Your live Offers open it. One live Offer opens everything people stand behind for you, and the first 200 you earned. Two open 500 of what you earned, three 1,000, four 1,500, five 2,000.' },
            { mark: 'open', text: 'You have 1 live Offer: all 500 is open.' },
        ]);
    });
    it('for every fixture the part rows are core\'s parts in the strip\'s order, and the total is the card\'s line', () => {
        for (const a of [VOUCHED, THREE_SOURCES, PART_CLOSED, ASLEEP, PASSED_ON, CAPPED]) {
            const s = creditSheet(a);
            const rows = part(s, 'line').rows;
            const items = creditLineParts(a).items;
            expect(rows.filter((r) => r.kind).map((r) => [r.kind, r.text, r.mark])).toEqual(items.map((p) => [p.kind, p.text, p.solid ? 'solid' : 'outlined']));
            const line = creditStanding(a).line_c;
            expect(rows.find((r) => r.mark === 'total')!.text).toBe(`Your whole credit line: ${formatHundredths(line)}`);
            expect(part(s, 'line').title).toBe(`Your credit line: ${formatHundredths(line)}`);
        }
    });
    it('three sources: the confirmed part and each voucher, with their own lines, the earliest vouch nearest zero', () => {
        const rows = part(creditSheet(THREE_SOURCES), 'line').rows.filter((r) => r.kind);
        expect(rows.map((r) => [r.text, r.line])).toEqual([
            ['Earned by trading 200', 'Yours, from your own completed trades. It grows as you trade.'],
            ['Confirmed member 1,000', 'Your community’s admins know you and confirmed you.'],
            ['@Olive vouched 100', '@Olive stands behind this part for you.'],
            ['@Jane vouched 200', '@Jane stands behind this part for you.'],
        ]);
        expect(texts(creditSheet(THREE_SOURCES), 'line').at(-1)).toBe('You have 2 live Offers: all 1,500 is open.');
    });
    it('part closed: says what is open of the line; asleep: says none is and how to open it', () => {
        expect(part(creditSheet(PART_CLOSED), 'line').rows.at(-1)).toEqual({ mark: 'closed', text: 'You have 1 live Offer: 500 of your 900 is open.' });
        expect(part(creditSheet(ASLEEP), 'line').rows.at(-1)).toEqual({ mark: 'closed', text: 'You have no live Offer, so your 500 credit line is asleep. Post one Offer to open it.' });
    });
    it('names the part passed on and the community\'s most where they apply', () => {
        expect(texts(creditSheet(PASSED_ON), 'line')).toContain('You gave 100 of it to another member.');
        expect(texts(creditSheet(CAPPED), 'line')).toContain('Together the parts come to more than this community’s most, so your line stops at 2,000.');
        expect(texts(creditSheet(VOUCHED), 'line').join(' ')).not.toMatch(/another member|community’s most/);
    });
    it('no line yet: says so, and how a line opens', () => {
        const p = part(creditSheet(NO_LINE), 'line');
        expect(p.title).toBe('Your credit line');
        expect(p.rows.map((r) => r.text)).toEqual([
            'You have no credit line yet.',
            'Your credit line opens with your first completed trade, or when someone who gives credit here vouches for you.',
        ]);
    });
});

describe('part 3, earning: the engine\'s own sum', () => {
    it('the rough guide is the engine\'s curve: 100 → about 37, 500 → 174, 1,000 → 320, never past 1,920', () => {
        const guide = texts(creditSheet(VOUCHED), 'earn')[2]!;
        const about = (v: number) => Math.floor(earnedCreditFromValue(b(v)) / 100);
        expect([about(100), about(500), about(1000)]).toEqual([37, 174, 320]);
        expect(guide).toBe('The first 100 Beans traded add about 37. 500 traded make 174. 1,000 make 320. It slows as it grows and can never pass 1,920.');
    });
    it('the member\'s own progress: 582 traded, the earned part the node sent, and what the next 100 add', () => {
        const s = creditSheet({ ...PART_CLOSED, earnedCredit_c: 20018 }, { qualifiedValue: b(582), avgRating: 0, reviewCount: 0 });
        expect(part(s, 'earn').rows.at(-1)).toEqual({ mark: 'progress', text: 'So far: 582 Beans traded in the market, 200.18 earned. Your next 100 Beans traded add about 30.' });
        const none = creditSheet(VOUCHED, { qualifiedValue: 0 });
        expect(texts(none, 'earn').at(-1)).toBe('Nothing traded in the market yet. Your first 100 Beans traded add about 37.');
        expect(part(creditSheet(VOUCHED), 'earn').rows.some((r) => r.mark === 'progress')).toBe(false);
    });
});

describe('parts 4 to 6', () => {
    it('what can change it: a vouch is for good, the admins, more vouchers, leaving owing, the community\'s most', () => {
        expect(texts(creditSheet(VOUCHED), 'change')).toEqual([
            'A vouch is yours for good. It stays if the person who vouched for you stops vouching or leaves. They can’t take it back.',
            'Your community’s admins can freeze a credit line. If your line becomes smaller than what you owe, spending pauses until you sell or receive Beans. Nothing is taken from you.',
            'More people can vouch for you: up to 3, 300 Beans in all (500 when an owner is one of them). They can only vouch while you are at zero or above.',
            'If you ever left owing Beans, it would count against the people who vouched for you.',
            'All parts together can’t pass this community’s most.',
        ]);
        expect(texts(creditSheet(CAPPED), 'change').at(-1)).toBe('All parts together can’t pass this community’s most: 2,000.');
    });
    it('the two fees, from the protocol\'s own figures', () => {
        expect(texts(creditSheet(VOUCHED), 'fees')).toEqual([
            'Market fee, 1.5%: on every completed market payment. It comes out of what the seller receives and goes to the Commons. The buyer pays the price and no more. Gifts pay nothing.',
            'Monthly fee: only on Beans you hold above 200, each part at its own rate: 1% up to 500, 1.5% up to 1,000, 2% up to 2,000, 2.5% above. It goes to the Commons. Owing costs nothing: there is no interest.',
        ]);
    });
    it('who can see this: the credit list\'s one sentence', () => {
        expect(texts(creditSheet(VOUCHED), 'who')).toEqual([
            'People who give credit here (the owners, admins and vouchers) can see your balance and your credit line, and each look is recorded.',
        ]);
    });
});

describe('the old modal\'s words are gone from the sheet', () => {
    it('no "floor", "overdraft", "sweet spot", "fee-free", "slider", "hold credit" or a "B" after a figure', () => {
        for (const a of [VOUCHED, THREE_SOURCES, PART_CLOSED, ASLEEP, NO_LINE, PASSED_ON, CAPPED]) {
            const words = allWords(creditSheet(a, { qualifiedValue: b(582) })).join(' \n ');
            expect(words).not.toMatch(/floor|overdraft|sweet spot|fee-free|slider|carry credit|hold credit/i);
            expect(words).not.toMatch(/\d\s?B\b/);
        }
    });
});
