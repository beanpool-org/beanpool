/**
 * The credit view's logic on the phone (slice C4; scratch/fable-design/DESIGN-credit-list-fable.md with its amendments 1 and 2).
 * Each check names the change that turns it red. The screens themselves are credit-render.test.ts.
 *
 *   - who is OFFERED the switch comes from the node's fresh answers, and a plain member's phone asks for no credit answer
 *   - every sentence on a row, a card and the Vouchers chip is core's, over the node's figures (a reason is never composed here)
 *   - no figure is worked out here: not a top-up level, not "running low", not a band
 *   - nothing is kept: no phone database, no storage
 *   - the requests are the node's routes with exactly the bodies the design names
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { riskReasonSentence, riskLevelSentence, RISK_SHAPES, type RiskReason } from '@beanpool/core';

const net = vi.hoisted(() => ({
    gets: [] as string[],
    posts: [] as { path: string; body: unknown }[],
    answer: { status: 200, body: {} as unknown } as { status: number; body: unknown } | 'offline',
}));
vi.mock('../node-post', () => ({
    signedGet: async (_u: string, p: string) => {
        net.gets.push(p);
        const a = net.answer;
        if (a === 'offline') throw new Error('network');
        return { ok: a.status < 300, status: a.status, json: async () => a.body };
    },
    signedPost: async (_u: string, p: string, body: unknown) => {
        net.posts.push({ path: p, body });
        const a = net.answer;
        if (a === 'offline') throw new Error('network');
        return { ok: a.status < 300, status: a.status, json: async () => a.body };
    },
}));

import {
    askForMore, askWords, cappedWords, creditGiverFrom, creditRowText, fetchCreditPage, fetchCreditPerson, fetchVouchersChip, floorRaiseSteps,
    madeOfWords, marked, mayGive, nextToGive, presetsGreyedBecause, presetsGreyedWords, raiseKnownFloor, riskReasonLines, standsBehindWords,
    voucherRowWords, type CreditPerson, type VoucherChipRow,
} from '../credit-view';

const KEY = (c: string) => c.repeat(64);
const person = (o: Partial<CreditPerson> = {}): CreditPerson => ({
    memberPubkey: KEY('a'), callsign: 'Jane', status: 'active', own: false, line_c: 130000, usable_c: 130000, liveOffers: 1,
    balance_c: 0, owed_c: 0, over_c: 0, paused: false, canGive: true, risk: { level: 'low', reasons: [], more: false }, ...o,
});
const chipRow = (o: Partial<VoucherChipRow> = {}): VoucherChipRow => ({
    memberPubkey: KEY('b'), callsign: 'Jane', left: 15000, held: 5000, heldInvites: 1, vouched: 80000, peopleVouched: 9, level: 100000, belowZero: 2, writtenOff: 0,
    setLevel_c: 100000, runningLow: false, nothingLeft: false, askedAt: null, topUpTo_c: 100000, topUpBlocked: null, ...o,
});

beforeEach(() => { net.gets.length = 0; net.posts.length = 0; net.answer = { status: 200, body: {} }; });

describe('who is offered Show credit (creditGiverFrom): the node\'s fresh answers, never a copy of a role', () => {
    it('an owner or admin by the role answer, a voucher by the budget answer', () => {
        expect(creditGiverFrom({ role: 'owner' }, false)).toBe('giver');
        expect(creditGiverFrom({ role: 'admin' }, false)).toBe('giver');
        expect(creditGiverFrom({ role: null }, true)).toBe('giver');
    });
    it('a plain member, and a moderator, are offered nothing', () => {
        expect(creditGiverFrom({ role: null }, false)).toBe('no');
        expect(creditGiverFrom({ role: 'moderator' }, false)).toBe('no');
    });
    it('not heard (offline, a 5xx) offers nothing, and is not read as a no either', () => {
        expect(creditGiverFrom(null, null)).toBe('unknown');
        expect(creditGiverFrom({ role: null }, null)).toBe('unknown');
        expect(creditGiverFrom(null, false)).toBe('unknown');
        // a heard yes stands even if the other answer was lost
        expect(creditGiverFrom({ role: 'admin' }, null)).toBe('giver');
        expect(creditGiverFrom(null, true)).toBe('giver');
    });
});

describe('a row is core\'s sentences over the node\'s figures (test 1, 6, 15)', () => {
    it('Rob: no credit yet, 4 live Offers, balance 0, not known yet', () => {
        const rob = person({ callsign: 'Rob', line_c: 0, usable_c: 0, liveOffers: 4, risk: { level: 'not_known', reasons: [], more: false } });
        const text = creditRowText(rob, 'owner');
        expect(text.credit).toBe('No credit yet · 4 live Offers');
        expect(text.balance).toBe('Balance 0');
        expect(text.riskLine).toBe('○ Credit risk: not known yet');
    });
    it('Jane at −420 of 1,300: a real minus sign, the line in use, and a spoken "minus"', () => {
        const text = creditRowText(person({ balance_c: -42000, owed_c: 42000, risk: { level: 'low', reasons: [], more: false } }), 'voucher');
        expect(text.credit).toBe('Credit line 1,300 · can use all of it now');
        expect(text.balance).toBe('Balance −420 · using 420 of 1,300');
        expect(text.balance).toContain('−');
        expect(text.balanceSpoken).toBe('Balance minus 420 Beans, using 420 of 1,300');
        expect(text.riskLine).toBe('✓ Credit risk: low');
    });
    it('a hundredth survives: −437.13 is read as −437.13, never rounded', () => {
        const text = creditRowText(person({ balance_c: -43713, owed_c: 43713 }), 'owner');
        expect(text.balance).toBe('Balance −437.13 · using 437.13 of 1,300');
    });
    it('Spending paused is the row\'s own mark, from the stored balance', () => {
        expect(creditRowText(person({ balance_c: -90000, owed_c: 90000, usable_c: 50000, paused: true }), 'owner').pausedMark).toBe('Spending paused');
        expect(creditRowText(person(), 'owner').pausedMark).toBeNull();
    });
    it('a freeze: owners and admins read it, a voucher reads only that credit can\'t be given', () => {
        const frozen = person({ canGive: false, frozen: { credit: true, known: false } });
        expect(creditRowText(frozen, 'admin').credit).toBe('Credit line frozen by an admin');
        const forVoucher = person({ canGive: false });
        expect(creditRowText(forVoucher, 'voucher').credit).toBe('Can’t be given credit right now');
    });
    it('the viewer\'s own row and a paused account are not told "can\'t be given credit"', () => {
        expect(creditRowText(person({ own: true, canGive: false }), 'voucher').credit).toBe('Credit line 1,300 · can use all of it now');
        expect(creditRowText(person({ status: 'paused', canGive: false }), 'voucher').credit).toBe('Credit line 1,300 · can use all of it now');
    });
    it('asleep and part-usable lines are core\'s wording', () => {
        expect(creditRowText(person({ usable_c: 0 }), 'owner').credit).toBe('Credit line 1,300 · asleep until they post an Offer');
        expect(creditRowText(person({ usable_c: 50000 }), 'owner').credit).toBe('Credit line 1,300 · can use 500 of it now');
    });
    it('no sentence is cut with an ellipsis, in any row we draw', () => {
        const rows = [person(), person({ line_c: 0, usable_c: 0, liveOffers: 4 }), person({ balance_c: -43713 }), person({ canGive: false })];
        for (const p of rows) for (const sight of ['owner', 'voucher'] as const) {
            const text = creditRowText(p, sight);
            for (const s of [text.credit, text.balance, text.balanceSpoken, text.riskLine]) expect(s).not.toMatch(/…|\.\.\./);
        }
    });
    it('the shape beside the word is core\'s, one for each level (never colour alone)', () => {
        for (const level of ['not_known', 'low', 'medium', 'high'] as const) {
            expect(creditRowText(person({ risk: { level, reasons: [], more: false } }), 'owner').riskLine).toBe(marked(RISK_SHAPES[level], riskLevelSentence(level)));
        }
        expect(new Set(Object.values(RISK_SHAPES)).size).toBe(4);
    });
});

describe('a reason is core\'s sentence, never composed here (amendment 2: Sam after the gift)', () => {
    const over_half: RiskReason = { code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 90000, line: 100000, pct: 50, gift: 90000, giftDays: 30 } };
    it('Sam: balance 0, high, the two-sentence reason, and "An owner or admin can say more." for a voucher', () => {
        const sam = person({
            callsign: 'Sam', line_c: 100000, usable_c: 100000, balance_c: 0, risk: { level: 'high', reasons: [over_half], more: true },
        });
        expect(creditRowText(sam, 'voucher').balance).toBe('Balance 0');
        const lines = riskReasonLines(sam.risk);
        expect(lines[0]).toBe(riskReasonSentence(over_half));
        expect(lines[0]).toBe('By their own trading they would owe 900 of 1,000: more than half. A gift of Beans paid 900 of it in the last 30 days.');
        expect(lines[0]).not.toMatch(/They owe/);
        expect(lines[1]).toBe('An owner or admin can say more.');
    });
    it('a code this build doesn\'t know draws nothing', () => {
        expect(riskReasonLines({ level: 'low', reasons: [{ code: 'from_the_future' as never, level: 'low', mark: 'open', values: {} }], more: false })).toEqual([]);
    });
});

describe('the sheet (test 11): who can be given what', () => {
    it('Next › goes to the next person who can be given credit, skipping the viewer, a paused account and a frozen one', () => {
        const a = person({ memberPubkey: KEY('1'), callsign: 'A' });
        const own = person({ memberPubkey: KEY('2'), callsign: 'Me', own: true, canGive: false });
        const paused = person({ memberPubkey: KEY('3'), callsign: 'P', status: 'paused', canGive: false });
        const frozen = person({ memberPubkey: KEY('4'), callsign: 'F', canGive: false });
        const d = person({ memberPubkey: KEY('5'), callsign: 'D' });
        expect(nextToGive([a, own, paused, frozen, d], a.memberPubkey)?.callsign).toBe('D');
        expect(nextToGive([a, own, paused, frozen, d], d.memberPubkey)).toBeNull();
        expect(mayGive(own)).toBe(false);
        expect(mayGive(paused)).toBe(false);
        expect(mayGive(a)).toBe(true);
    });
    it('below zero: the presets are greyed under the node\'s own sentence; so is a freeze; neither sends a request', () => {
        expect(presetsGreyedBecause(person({ balance_c: -100 }), 'voucher')).toBe('below_zero');
        expect(presetsGreyedWords('below_zero', 'rob')).toBe('@rob is below zero: a credit-line gift or a Decision can help.');
        expect(presetsGreyedBecause(person({ canGive: false }), 'voucher')).toBe('cannot_receive');
        expect(presetsGreyedBecause(person({ canGive: false, frozen: { credit: false, known: true } }), 'admin')).toBe('cannot_receive');
        expect(presetsGreyedWords('cannot_receive', 'sam')).toBe('@sam can’t be given part of a credit line right now.');
        expect(presetsGreyedBecause(person(), 'owner')).toBeNull();
        expect(net.posts).toEqual([]);
    });
    it('a known-floor raise offers 100 Beans above what they hold, up to the cap, in 100s; none at the cap; never a lower figure', () => {
        expect(floorRaiseSteps(100000, 200000)).toEqual({ min: 110000, max: 200000 });
        expect(floorRaiseSteps(120000, 200000)).toEqual({ min: 130000, max: 200000 });
        expect(floorRaiseSteps(200000, 200000)).toBeNull();
        expect(floorRaiseSteps(195000, 200000)).toEqual({ min: 200000, max: 200000 });
    });
    it('owners and admins read what the line is made of and who stands behind it; a voucher\'s answer has neither', () => {
        const full = person({
            parts: { known_c: 100000, room_c: 20000, earned_c: 10000, granted_c: 0, cap_c: 200000 },
            standsBehind: { confirmedBy: { memberPubkey: KEY('c'), callsign: 'marty', at: '2026-11-01T00:00:00Z' }, vouchedBy: [{ memberPubkey: KEY('d'), callsign: 'olive', amount_c: 10000 }] },
        });
        expect(madeOfWords(full)).toBe('Made of: known floor 1,000 · vouched 200 · earned 100');
        expect(standsBehindWords(full)).toEqual(['Confirmed by @marty', 'Vouched by @olive 100']);
        expect(cappedWords(full)).toBeNull();
        expect(cappedWords({ ...full, parts: { ...full.parts!, cap_c: 100000 } })).toBe('Capped at 1,000, the most this community allows.');
        expect(madeOfWords(person())).toBeNull();
        expect(standsBehindWords(person())).toEqual([]);
    });
});

describe('the Vouchers chip row (tests 18, 19): the node\'s flags and offer, drawn', () => {
    const day = '12 Nov';
    it('Jane running low, asked: the budget line, the flag, the ask and the node\'s Top up level', () => {
        const w = voucherRowWords(chipRow({ runningLow: true, askedAt: '2026-11-12T01:00:00Z' }), day);
        expect(w.head).toBe('Voucher · 150 of 1,000 left');
        expect(w.flag).toBe('Running low');
        expect(w.vouched).toBe('Vouched 800 to 9 people');
        expect(w.held).toBe('50 held on invites');
        expect(w.health).toBe('2 of 9 below zero · written off 0');
        expect(w.asked).toBe('Asked for more on 12 Nov');
        expect(w.topUp).toBe('Top up to 1,000');
    });
    it('the label follows the node\'s topUpTo_c, never a level worked out here', () => {
        expect(voucherRowWords(chipRow({ topUpTo_c: 50000 }), day).topUp).toBe('Top up to 500');
        expect(voucherRowWords(chipRow({ topUpTo_c: 150000 }), day).topUp).toBe('Top up to 1,500');
    });
    it('nothing left to vouch with outranks running low; one person is "person"', () => {
        const w = voucherRowWords(chipRow({ runningLow: true, nothingLeft: true, left: 2000, peopleVouched: 1 }), day);
        expect(w.flag).toBe('Nothing left to vouch with');
        expect(w.vouched).toBe('Vouched 800 to 1 person');
    });
    it('a paused or frozen voucher has no button and the node\'s reason; the ceiling says so; an owner is "no limit"', () => {
        expect(voucherRowWords(chipRow({ topUpTo_c: null, topUpBlocked: 'frozen' }), day)).toMatchObject({ topUp: null, blocked: 'Their credit line is frozen, so their budget can’t be raised.' });
        expect(voucherRowWords(chipRow({ topUpTo_c: null, topUpBlocked: 'paused' }), day)).toMatchObject({ topUp: null, blocked: 'Their account is paused, so their budget can’t be raised.' });
        expect(voucherRowWords(chipRow({ topUpTo_c: null, topUpBlocked: 'at_most' }), day)).toMatchObject({ topUp: null, blocked: 'At the most a voucher can hold.' });
        const owner = voucherRowWords(chipRow({ noLimit: true, topUpTo_c: null, topUpBlocked: 'no_limit' }), day);
        expect(owner.head).toBe('Owner · no limit');
        expect(owner.topUp).toBeNull();
        expect(owner.flag).toBeNull();
    });
});

describe('Ask for more (test 20): the three states are the node\'s', () => {
    const fmt = (iso: string) => ({ '2026-11-12T01:00:00Z': '12 Nov', '2026-11-19T01:00:00Z': '19 Nov' } as Record<string, string>)[iso] ?? iso;
    it('a button when they may ask; "Asked on …" while the ask is open; the date they may ask again; the freeze and the pause', () => {
        expect(askWords({ askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null }, fmt)).toEqual({ kind: 'button', text: 'Ask for more' });
        expect(askWords({ askedAt: '2026-11-12T01:00:00Z', lastAskedAt: '2026-11-12T01:00:00Z', askAgainAt: '2026-11-19T01:00:00Z', blocked: null }, fmt))
            .toEqual({ kind: 'asked', text: 'Asked on 12 Nov · an owner or the credit committee will see it.' });
        expect(askWords({ askedAt: null, lastAskedAt: '2026-11-12T01:00:00Z', askAgainAt: '2026-11-19T01:00:00Z', blocked: null }, fmt))
            .toEqual({ kind: 'wait', text: 'You asked on 12 Nov. You can ask again on 19 Nov.' });
        expect(askWords({ askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: 'frozen' }, fmt).text)
            .toBe('Your credit line is frozen, so your budget can’t be raised until an admin unfreezes it.');
        expect(askWords({ askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: 'paused' }, fmt).kind).toBe('blocked');
    });
});

describe('the requests are the node\'s routes with exactly the bodies the design names (tests 11, 19, 20)', () => {
    const anchor = 'https://node.test';
    const id = { publicKey: KEY('f'), privateKey: KEY('e'), callsign: 'T' } as never;
    it('the list: filter, the search as q, the cursor as after', async () => {
        net.answer = { status: 200, body: { sight: 'owner', told: 'x', people: [], next: null } };
        await fetchCreditPage(anchor, id, { filter: 'no_credit', q: ' ro b ', after: 'abc' });
        expect(net.gets).toEqual(['/api/credit/people?filter=no_credit&q=ro%20b&after=abc']);
    });
    it('the card and the chip', async () => {
        await fetchCreditPerson(anchor, id, KEY('a'));
        await fetchVouchersChip(anchor, id);
        expect(net.gets).toEqual([`/api/credit/people/${KEY('a')}`, '/api/credit/people?filter=vouchers']);
    });
    it('Raise sends exactly { memberPubkey, raiseTo_c }; Ask for more sends an empty body', async () => {
        await raiseKnownFloor(anchor, id, KEY('a'), 150000);
        await askForMore(anchor, id);
        expect(net.posts).toEqual([
            { path: '/api/credit/known-floor', body: { memberPubkey: KEY('a'), raiseTo_c: 150000 } },
            { path: '/api/vouchers/ask', body: {} },
        ]);
    });
    it('a refusal is the node\'s sentence and code, with its extra fields; a lost connection is "offline"', async () => {
        net.answer = { status: 409, body: { error: 'You asked on 12 Nov. You can ask again on 19 Nov.', code: 'asked_this_week', askedAt: 'A', askAgainAt: 'B' } };
        const refused = await askForMore(anchor, id);
        expect(refused).toMatchObject({ ok: false, status: 409, code: 'asked_this_week', message: 'You asked on 12 Nov. You can ask again on 19 Nov.', extra: { askedAt: 'A', askAgainAt: 'B' }, offline: false });
        net.answer = { status: 403, body: { error: 'Only the owners, admins and vouchers here can see credit.', code: 'not_a_giver' } };
        expect(await fetchCreditPage(anchor, id, { filter: 'all' })).toMatchObject({ ok: false, status: 403, code: 'not_a_giver' });
        net.answer = 'offline';
        expect(await fetchCreditPage(anchor, id, { filter: 'all' })).toMatchObject({ ok: false, offline: true });
    });
});

describe('nothing is kept, nothing is worked out here (test 23, the brief\'s STOP rules)', () => {
    const root = path.resolve(__dirname, '../..');
    const files = [
        'utils/credit-view.ts', 'utils/use-credit-giver.ts', 'components/CreditList.tsx', 'components/CreditRow.tsx', 'components/CreditVoucherRow.tsx',
        'components/CreditCard.tsx', 'components/CreditRisk.tsx', 'components/GiveCreditSheet.tsx', 'components/AskForMore.tsx',
    ];
    const code = (f: string) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    it('no credit file touches the phone\'s database or storage', () => {
        for (const f of files) {
            expect(code(f), f).not.toMatch(/AsyncStorage|SecureStore|expo-sqlite|from ['"][./]*(utils\/)?db['"]|getDb\(|localStorage|FileSystem/);
        }
    });
    it('no app code works out a top-up level, running low, or a band: those are the node\'s fields and core\'s sentences', () => {
        for (const f of files) {
            expect(code(f), f).not.toMatch(/topUpTarget|TOP_UP_LEVELS|runningLow\(|nothingLeft\(|VOUCH_MAX/);
        }
    });
    it('the switch and the Vouchers chip are not drawn from a role the phone holds', () => {
        const people = code('app/(tabs)/people.tsx');
        // the switch is gated by the node's answer (useCreditGiver) and never by the cached or persisted role
        expect(people).toMatch(/useCreditGiver\(/);
        const list = code('components/CreditList.tsx');
        expect(list).toMatch(/setCommittee\(true\)/);
        expect(list).not.toMatch(/readPersistedNodeRole|cachedNodeRole|inviteRole|onCommittee/);
        expect(code('utils/use-credit-giver.ts')).not.toMatch(/readPersistedNodeRole|cachedNodeRole|rememberNodeRole/);
    });
    it('only credit-view.ts names the credit routes; no component builds a credit request itself', () => {
        for (const f of files.filter((x) => x !== 'utils/credit-view.ts')) expect(code(f), f).not.toMatch(/\/api\/credit|\/api\/vouchers\/ask/);
    });
    it('no credit text is capped to a number of lines, and every button is at least 44 dp tall (test 14)', () => {
        for (const f of files) {
            expect(code(f), f).not.toMatch(/numberOfLines|ellipsizeMode/);
            for (const m of code(f).matchAll(/minHeight:\s*(\d+)/g)) expect(Number(m[1]), f).toBeGreaterThanOrEqual(44);
        }
    });
    it('no KeyboardProvider anywhere near the sheet\'s Modal', () => {
        expect(code('components/GiveCreditSheet.tsx')).not.toMatch(/KeyboardProvider|KeyboardAvoidingView|TextInput/);
    });
});
