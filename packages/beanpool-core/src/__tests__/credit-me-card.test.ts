/**
 * What a member reads about themselves on their own Ledger (scratch/fable-design/DESIGN-credit-list-amend-fable.md §5.4,
 * DESIGN-credit-list-amend2-fable.md §0 item 20; slice C6): `creditMeCard` over the fields of `GET /api/credit/me`. Both apps
 * draw this card line for line, so its words and its order are pinned once, here. Each check names the change that turns it red.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CREDIT_SIGHT_WORDS, creditMeCard, riskReasonSentence, type CreditMeAnswer, type RiskReason,
} from '../credit-sight.js';
import { setLanguage } from '../words.js';

afterEach(() => setLanguage('en'));

const me = (over: Partial<CreditMeAnswer> = {}): CreditMeAnswer => ({
    line_c: 0, usable_c: 0, liveOffers: 0, balance_c: 0, canGive: true, status: 'active',
    risk: { level: 'not_known', more: false, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] },
    ...over,
});
const overHalfGift: RiskReason = { code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 90000, line: 100000, pct: 50, gift: 90000, giftDays: 30 } };
const overHalf: RiskReason = { code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 90000, line: 100000, pct: 50 } };

describe('creditMeCard: a voucher\'s lines about the member, in the order the apps draw them', () => {
    it('Rob: no credit yet, 4 live Offers, balance 0, not known yet (red when a line moves or a sentence is composed here)', () => {
        const c = creditMeCard(me({ liveOffers: 4 }));
        expect(c).toEqual({
            title: 'What people who give credit see',
            credit: 'No credit yet · 4 live Offers',
            liveOffers: null, // the count is already in the sentence while there is no line
            balance: 'Balance 0',
            balanceSpoken: 'Balance 0 Beans',
            paused: null,
            level: 'not_known', shape: '○', word: 'Credit risk: not known yet',
            reasons: ['New here: no completed trade yet.'],
            told: 'People who give credit here (the owners, admins and vouchers) can see your balance and your credit line, and each look is recorded.',
        });
    });

    it('Jane: a line of 1,300 with 420 used, 1 live Offer, low, and the admins\' words left unsaid (red when the voucher line drops "An owner or admin can say more.")', () => {
        const c = creditMeCard(me({
            line_c: 130000, usable_c: 130000, liveOffers: 1, balance_c: -42000,
            risk: { level: 'low', more: true, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] },
        }));
        expect(c.credit).toBe('Credit line 1,300 · can use all of it now');
        expect(c.liveOffers).toBe('1 live Offer');
        expect(c.balance).toBe('Balance −420 · using 420 of 1,300');
        expect(c.balanceSpoken).toBe('Balance minus 420 Beans, using 420 of 1,300');
        expect(c.shape).toBe('✓');
        expect(c.word).toBe('Credit risk: low');
        expect(c.reasons).toEqual(['New here: no completed trade yet.', 'An owner or admin can say more.']);
    });

    it('the lines come out in one fixed order: title, credit, live Offers, balance, paused, word, reasons, told (red when the order the two apps draw moves)', () => {
        expect(Object.keys(creditMeCard(me()))).toEqual(['title', 'credit', 'liveOffers', 'balance', 'balanceSpoken', 'paused', 'level', 'shape', 'word', 'reasons', 'told']);
    });

    it('Sam after the gift: the balance is the real one (0), the reason is core\'s second form and never says "They owe" (red when a reason is composed from its values, or the row follows the gift)', () => {
        const c = creditMeCard(me({
            line_c: 100000, usable_c: 100000, liveOffers: 0, balance_c: 0,
            risk: { level: 'medium', more: false, reasons: [overHalfGift] },
        }));
        expect(c.balance).toBe('Balance 0');
        expect(c.reasons).toEqual([riskReasonSentence(overHalfGift)]);
        expect(c.reasons[0]).toContain('By their own trading they would owe 900 of 1,000: more than half.');
        expect(c.reasons[0]).toContain('A gift of Beans paid 900 of it in the last 30 days.');
        expect(c.reasons[0]).not.toContain('They owe');
        // And with no gift, the first form, from the same function.
        expect(creditMeCard(me({ line_c: 100000, usable_c: 100000, balance_c: -90000, risk: { level: 'medium', more: false, reasons: [overHalf] } })).reasons)
            .toEqual(['They owe 900 of 1,000: more than half.']);
    });

    it('a member who owes more than their Offers unlock reads the Spending paused mark (red when the mark reads the usable line wrongly)', () => {
        const c = creditMeCard(me({ line_c: 100000, usable_c: 20000, balance_c: -50000, liveOffers: 1 }));
        expect(c.paused).toBe('Spending paused');
        expect(creditMeCard(me({ line_c: 100000, usable_c: 20000, balance_c: -10000, liveOffers: 1 })).paused).toBeNull();
    });

    it('a frozen or paused line reads as a voucher reads it, not as a freeze with a cause (red when canGive stops deciding)', () => {
        expect(creditMeCard(me({ line_c: 100000, usable_c: 0, canGive: false })).credit).toBe('Can’t be given credit right now');
        // A paused account is listed greyed: the credit sentence is the ordinary one.
        expect(creditMeCard(me({ line_c: 100000, usable_c: 100000, canGive: false, status: 'paused' })).credit).toBe('Credit line 1,000 · can use all of it now');
    });

    it('an admin\'s key has no Offer count: no live Offers line, and no invented 5 (red when null is drawn as a number)', () => {
        const c = creditMeCard(me({ line_c: 100000, usable_c: 100000, liveOffers: null }));
        expect(c.liveOffers).toBeNull();
        expect(creditMeCard(me({ liveOffers: null })).credit).toBe('No credit yet');
    });

    it('reads only the voucher\'s fields: parts, who stands behind, a freeze and an admins\' reason in a (wrong) answer draw nothing (red when the card starts reading what a voucher is not told)', () => {
        const wrong = {
            ...me({ line_c: 100000, usable_c: 100000, balance_c: -42000, risk: { level: 'low', more: true, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] } }),
            parts: { known_c: 100000, room_c: 0, earned_c: 0, granted_c: 0, cap_c: 200000 },
            standsBehind: { confirmedBy: { memberPubkey: 'x', callsign: 'zed', at: '2026-11-01' }, vouchedBy: [{ memberPubkey: 'y', callsign: 'olive', amount_c: 10000 }] },
            frozen: { credit: true, known: true },
        } as CreditMeAnswer;
        const text = JSON.stringify(creditMeCard(wrong));
        for (const leak of ['known floor', 'Made of', 'zed', 'olive', 'Confirmed by', 'Vouched by', 'froze', 'frozen']) expect(text).not.toContain(leak);
        expect(creditMeCard(wrong)).toEqual(creditMeCard(me({ line_c: 100000, usable_c: 100000, balance_c: -42000, risk: wrong.risk })));
    });

    it('a code this build does not know draws nothing, and an answer with no risk is not-known (red when a missing reason throws)', () => {
        const unknown = { code: 'from_the_future', level: 'high', mark: 'giver', values: {} } as unknown as RiskReason;
        expect(creditMeCard(me({ risk: { level: 'high', more: false, reasons: [unknown] } })).reasons).toEqual([]);
        expect(creditMeCard({ ...me(), risk: undefined } as unknown as CreditMeAnswer).level).toBe('not_known');
    });

    it('is the member\'s language: every sentence goes through the words layer (red when a sentence is a hard-coded string)', () => {
        setLanguage('en');
        const en = creditMeCard(me({ line_c: 100000, usable_c: 100000, balance_c: -42000, risk: { level: 'medium', more: true, reasons: [overHalf] } }));
        // Pseudo-localisation (the words layer's own test language) changes every sentence it is given.
        setLanguage('xx');
        const pseudo = creditMeCard(me({ line_c: 100000, usable_c: 100000, balance_c: -42000, risk: { level: 'medium', more: true, reasons: [overHalf] } }));
        for (const k of ['title', 'credit', 'balance', 'word', 'told'] as const) expect(pseudo[k]).not.toBe(en[k]);
        expect(pseudo.reasons.every((s, i) => s !== en.reasons[i])).toBe(true);
    });

    it('the heading is core\'s one word, and the told sentence is the one every other surface says (red when the two drift apart)', () => {
        expect(String(CREDIT_SIGHT_WORDS.meTitle)).toBe('What people who give credit see');
        expect(creditMeCard(me()).told).toBe(String(CREDIT_SIGHT_WORDS.told));
    });

    it('the guide names the heading the Ledger draws and says where it is, and it says the card carries the told sentence (red when the heading changes and a page keeps the old name)', () => {
        const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
        for (const page of ['packages/beanpool-guide/content/ledger/credit-risk.md', 'packages/beanpool-guide/content/settings/what-the-admins-can-see.md']) {
            const text = readFileSync(join(root, page), 'utf8').replace(/\*\*/g, '');
            expect(text, page).toContain(String(CREDIT_SIGHT_WORDS.meTitle));
            expect(text, page).toMatch(/your Ledger/i);
        }
        const settings = readFileSync(join(root, 'packages/beanpool-guide/content/settings/what-the-admins-can-see.md'), 'utf8').replace(/\*\*/g, '');
        expect(settings).toContain('shows the answer a voucher gets about you, and this sentence');
    });
});
