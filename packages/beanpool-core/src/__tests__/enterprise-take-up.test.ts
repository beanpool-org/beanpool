/**
 * "Buy for {enterprise}", core (DESIGN-stall-consignment-fable.md §5.6, §6 slice 2, §7 item 12): who sees the button, the
 * confirm sheet's sentence and figures against the fee function, the retry id, every refusal the door answers, the answer
 * read, and which console release asks for hours. Both apps draw exactly these. Each check names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';
import {
    TAKE_UP_REFUSALS, TAKE_UP_WORDS, enterpriseTakeUpOffered, releaseAsksHours, takeUpAnswerOf, takeUpBody, takeUpButtons,
    takeUpListingMoved, takeUpRefusalText, takeUpRequestFor, takeUpSheet, type TakeUpEnterprise,
} from '../enterprise-take-up';
import { ITEM_BOX_START, itemTakeUpBox } from '../per-item-deal';
import { EACH, ITEM_TAKE_UP_REFUSALS, itemTakeUpRefusalText } from '../per-item';
import { feeOf, formatHundredths } from '../hundredths';
import { t } from '../words';

const c = (beans: number) => Math.round(beans * 100);
const ON = { enterpriseTakeUp: true };
const KIM = 'kim-key', ALICE = 'alice-key', STALL = 'stall-key', CAFE = 'cafe-key';
const ENTERPRISES: TakeUpEnterprise[] = [
    { publicKey: STALL, name: 'Riverside stall', paused: false, status: 'active' },
    { publicKey: CAFE, name: 'Hill Cafe', paused: false, status: 'active' },
];
const apples = (over: Record<string, unknown> = {}) => ({ id: 'p1', type: 'offer', priceType: EACH, price_c: c(20), unitsLeft: 3, status: 'active', authorPublicKey: ALICE, title: 'Apples', ...over });
const buttons = (over: Partial<Parameters<typeof takeUpButtons>[0]> = {}) =>
    takeUpButtons({ features: ON, listing: apples(), me: KIM, keeperOf: [STALL], enterprises: ENTERPRISES, ...over });

describe('who sees "Buy for {enterprise}" (§6 slice 2: only where the node has the door)', () => {
    it('a keeper of an active enterprise, on a member\'s Offer priced for each one, where the node says it has the door', () => {
        expect(buttons()).toEqual([{ enterprise: STALL, name: 'Riverside stall', label: 'Buy for Riverside stall' }]);
    });

    // (case) -> buttons. Each row names the change that turns it red.
    const rows: Array<[string, Partial<Parameters<typeof takeUpButtons>[0]>, string[]]> = [
        ['a member who keeps nothing (red if keepership is not asked)', { keeperOf: [] }, []],
        ['no balance read yet (red if a null list throws)', { keeperOf: null }, []],
        ['two enterprises kept: one button each, in the node\'s order (red if only the first shows)', { keeperOf: [CAFE, STALL] }, ['Buy for Hill Cafe', 'Buy for Riverside stall']],
        ['the same enterprise listed twice: one button (red if not de-duplicated)', { keeperOf: [STALL, STALL] }, ['Buy for Riverside stall']],
        ['a one-off price (Total): no button (red if the door\'s each-only rule is not mirrored, §6 point 8)', { listing: apples({ priceType: 'fixed', unitsLeft: undefined }) }, []],
        ['an hourly price: no button', { listing: apples({ priceType: 'hourly' }) }, []],
        ['a Need priced each: no button (red if the type is not asked)', { listing: apples({ type: 'need' }) }, []],
        ['an event: no button', { listing: apples({ type: 'event' }) }, []],
        ['a lent Offer: no button (the lender says yes first)', { listing: apples({ lendable: 1 }) }, []],
        ['a sold-out or paused listing: no button (red if status is not asked)', { listing: apples({ status: 'completed' }) }, []],
        ['the node says nothing (older, or a switch off): no button (red if the button ignores the door)', { features: {} }, []],
        ['the node says false: no button', { features: { enterpriseTakeUp: false } }, []],
        ['the node says the string "true": no button (red if truthiness is enough)', { features: { enterpriseTakeUp: 'true' } }, []],
        ['no features read: no button', { features: null }, []],
        ['the seller\'s own Offer: no button (the two-person rule refuses it; red if the author is not compared)', { me: ALICE, keeperOf: [STALL] }, []],
        ['the enterprise\'s own Offer: no button for it, the other enterprise still shows (red if the author is not compared per enterprise)',
            { listing: apples({ authorPublicKey: STALL }), keeperOf: [STALL, CAFE] }, ['Buy for Hill Cafe']],
        ['a paused enterprise: no button (the engine refuses it)', { enterprises: [{ ...ENTERPRISES[0], paused: true }] }, []],
        ['a wound-up enterprise: no button', { enterprises: [{ ...ENTERPRISES[0], status: 'wound_up' }] }, []],
        ['an enterprise the node does not list by name: no button (never "Buy for undefined")', { enterprises: [] }, []],
        ['a blank name: no button', { enterprises: [{ ...ENTERPRISES[0], name: '  ' }] }, []],
        ['nobody signed in: no button', { me: '' }, []],
    ];
    for (const [name, over, want] of rows) {
        it(name, () => expect(buttons(over).map((b) => b.label)).toEqual(want));
    }

    it('the phone\'s row shape (price_type, author_pubkey) reads the same as the web\'s (red if only one shape is read)', () => {
        const row = { id: 'p1', type: 'offer', price_type: EACH, price_c: c(20), units_left: 3, status: 'active', author_pubkey: ALICE };
        expect(buttons({ listing: row }).map((b) => b.label)).toEqual(['Buy for Riverside stall']);
        expect(buttons({ listing: { ...row, author_pubkey: KIM } })).toEqual([]);
        expect(buttons({ listing: { ...row, price_type: 'fixed' } })).toEqual([]);
    });

    it('enterpriseTakeUpOffered reads only true', () => {
        expect([true, false, 'true', 1, undefined, null].map((v) => enterpriseTakeUpOffered({ enterpriseTakeUp: v }))).toEqual([true, false, false, false, false, false]);
        expect(enterpriseTakeUpOffered(null)).toBe(false);
    });
});

describe('the confirm sheet (§5.6): its words, and its figures from the fee function', () => {
    const names = { stall: 'Riverside stall', seller: 'Alice', title: 'Apples' };

    it('the design\'s example word for word: 2 of “Apples” at 20 Beans (red if one word of §5.6 changes)', () => {
        const box = itemTakeUpBox(apples(), { option: 'each', count: '2' }, 'Alice')!;
        const s = takeUpSheet(box.send, names)!;
        expect(s.sentence).toBe('Riverside stall pays Alice 40 Beans for 2 of “Apples”. Alice gets 39.40 Beans; 0.60 Beans go to the Commons. BeanPool moves Beans only. Any cash is between you and the buyer.');
        expect([s.total_c, s.fee_c, s.net_c]).toEqual([4000, 60, 3940]);
    });

    // Odd prices (§7 item 1) and counts 1 and 3: the total is the box's own expect_c, the fee feeOf(total) once, and the
    // seller the rest, so the three always add up (red if the sheet works out its own fee, or a fee per item).
    for (const price of [0.01, 0.66, 0.67, 12.35, 19.99]) {
        for (const n of [1, 3]) {
            it(`${n} at ${price} Beans: total = the box's expect_c, fee = feeOf(total), seller = total − fee`, () => {
                const box = itemTakeUpBox(apples({ price_c: c(price) }), { option: 'each', count: String(n) }, 'Alice')!;
                const s = takeUpSheet(box.send, names)!;
                expect(s.total_c).toBe(box.send!.expect_c);
                expect(s.fee_c).toBe(feeOf(s.total_c));
                expect(s.net_c + s.fee_c).toBe(s.total_c);
                expect(s.sentence).toContain(`pays Alice ${formatHundredths(s.total_c)} Beans for ${n} of “Apples”`);
                expect(s.sentence).toContain(`Alice gets ${formatHundredths(s.net_c)} Beans; ${formatHundredths(s.fee_c)} Beans go to the Commons.`);
            });
        }
    }

    it('the price for all: the sheet says how many it is for and the lot\'s price (red if it says the one-by-one total)', () => {
        const lot = apples({ unitsLeft: 3, lot: { units: 3, price_c: c(50) } });
        const box = itemTakeUpBox(lot, { option: 'lot', count: '3' }, 'Alice')!;
        expect(box.send).toEqual({ hours: 3, itemOption: 'lot', expect_c: c(50) });
        const s = takeUpSheet(box.send, names)!;
        expect(s.sentence).toContain('pays Alice 50 Beans for 3 of “Apples”');
        expect(s.fee_c).toBe(feeOf(c(50)));
    });

    it('Beans are a word, never a sign, and no cash figure: no $, Ʀ, 🫘 or other currency mark (red if a symbol slips in)', () => {
        const s = takeUpSheet({ hours: 3, itemOption: 'each', expect_c: c(1234.5) }, names)!;
        expect(s.sentence).toContain('1,234.50 Beans');
        expect(s.sentence).not.toMatch(/[$€£¥Ʀ🫘]/u);
    });

    it('nothing to send (no count yet, none left): no sheet', () => {
        expect(takeUpSheet(null, names)).toBeNull();
        expect(takeUpSheet(itemTakeUpBox(apples({ unitsLeft: 0 }), ITEM_BOX_START, 'Alice')!.send, names)).toBeNull();
    });
});

describe('the retry id: one tap retried is one sale', () => {
    const send = { hours: 2, itemOption: 'each' as const, expect_c: 4000 };
    let n = 0;
    const make = () => `take-up-id-${++n}`;

    it('the same sale again reuses the id; a changed count, total, way, listing or enterprise gets a new one (red if a retry makes a new id)', () => {
        const first = takeUpRequestFor(null, STALL, 'p1', send, make);
        expect(takeUpRequestFor(first, STALL, 'p1', send, make)).toBe(first);
        expect(takeUpRequestFor(first, STALL, 'p1', { ...send }, make).requestId).toBe(first.requestId);
        const others = [
            takeUpRequestFor(first, STALL, 'p1', { ...send, hours: 3, expect_c: 6000 }, make),
            takeUpRequestFor(first, STALL, 'p1', { ...send, expect_c: 4001 }, make),
            takeUpRequestFor(first, STALL, 'p1', { ...send, itemOption: 'lot' }, make),
            takeUpRequestFor(first, STALL, 'p2', send, make),
            takeUpRequestFor(first, CAFE, 'p1', send, make),
        ];
        expect(new Set([first.requestId, ...others.map((o) => o.requestId)]).size).toBe(6);
    });

    it('the default id is one the node takes (8 to 128 of A-Z a-z 0-9 - _), and two are never the same', () => {
        const a = takeUpRequestFor(null, STALL, 'p1', send).requestId;
        const b = takeUpRequestFor(null, STALL, 'p1', send).requestId;
        expect(a).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
        expect(a).not.toBe(b);
    });

    it('the body is the member\'s own accept body plus the id, and names no key (red if a key field is added: the middleware refuses it)', () => {
        const body = takeUpBody('p1', send, { key: 'k', requestId: 'abcdefgh' });
        expect(body).toEqual({ postId: 'p1', hours: 2, itemOption: 'each', expect_c: 4000, requestId: 'abcdefgh' });
        expect(Object.keys(body).some((k) => /pubkey|publickey|^from$|createdBy/i.test(k))).toBe(false);
    });
});

describe('every refusal the door answers, in plain words', () => {
    /**
     * Every code POST /api/treasury/:treasury/take-up can answer with (routes/treasury.ts, routes/deal-refusals.ts,
     * engine/escrow.ts acceptPost, engine/per-item.ts, engine/audit.ts, federation-settlement.ts, and the gates in front of it:
     * config/node-role.ts standby, config/node-profile.ts feature_off, engine/money-limits.ts). The node's own suite
     * (apps/server/src/test-enterprise-take-up.ts) checks that every code it meets is in TAKE_UP_REFUSALS.
     */
    const ROUTE_CODES = [
        'take_up_each_only', 'take_up_cancelled', 'post_gone', 'request_id_reused', 'deal_open', 'TWO_PERSON_RULE', 'listing_copy',
        'lend_ask_first', ...ITEM_TAKE_UP_REFUSALS, 'federation_settlement_disabled', 'COMMONS_POT_UNKNOWN', 'standby', 'feature_off',
        'money_payments_day', 'money_new_recipients_day', 'money_requests_day', 'money_enterprise_work_payments_day',
        'money_enterprise_work_new_recipients_day', 'money_enterprise_work_requests_day',
    ];

    it('every code has a line, and the table names no code the door never answers (red if a code is added on either side alone)', () => {
        expect(Object.keys(TAKE_UP_REFUSALS).sort()).toEqual([...ROUTE_CODES].sort());
    });

    const nodeSaid = 'The node’s own sentence.';
    // (code) -> the words shown. Each line is the keeper's, not the member's own take-up's.
    const lines: Array<[string, string]> = [
        ['take_up_each_only', 'An enterprise can take up only an Offer priced for each one.'],
        ['take_up_cancelled', 'That sale was cancelled, so nothing more was paid.'],
        ['post_gone', 'This Offer is no longer on the board, so nothing was paid.'],
        ['request_id_reused', 'That tap was already used for a different sale, so nothing was paid. Close this and try again.'],
        ['deal_open', 'The enterprise already has a deal under way on this Offer. A keeper can release it from the enterprise’s deals.'],
        ['TWO_PERSON_RULE', 'A keeper can’t buy their own Offer for the enterprise. Another keeper can.'],
        ['listing_copy', 'This is a copy of a listing from another community, so it can’t be bought here.'],
        ['lend_ask_first', 'This Offer is lent, not sold, so an enterprise can’t buy it.'],
    ];
    for (const [code, words] of lines) {
        it(`${code} -> "${words}" (red if the node's member-facing words show instead)`, () => {
            expect(takeUpRefusalText({ code, message: nodeSaid })).toBe(words);
        });
    }
    for (const code of ITEM_TAKE_UP_REFUSALS) {
        it(`${code} -> core's per-item sentence, with how many are left (red if the box's words are not reused)`, () => {
            expect(takeUpRefusalText({ code, unitsLeft: 1, message: nodeSaid })).toBe(itemTakeUpRefusalText({ code, count: 1 }));
        });
    }
    for (const code of ROUTE_CODES.filter((k) => TAKE_UP_REFUSALS[k] === 'node')) {
        it(`${code} -> the node's own sentence (it says what only the node knows, in the member's language)`, () => {
            expect(takeUpRefusalText({ code, message: nodeSaid })).toBe(nodeSaid);
        });
    }

    it('a refusal with no code (not a keeper, no room, Rules 5 and 6) shows the node\'s sentence, its prefix taken off', () => {
        expect(takeUpRefusalText({ status: 403, message: 'You are not a keeper of this enterprise' })).toBe('You are not a keeper of this enterprise');
        expect(takeUpRefusalText({ message: 'CONTRIBUTION_REQUIRED: List an Offer first.' })).toBe('List an Offer first.');
        expect(takeUpRefusalText({ message: 'FLOOR_LOCKED:1:2:3:4: The stall has no room.' })).toBe('The stall has no room.');
    });

    it('nothing to say at all: the node\'s fallback sentence, never an empty line', () => {
        expect(takeUpRefusalText({})).toBe(t(TAKE_UP_WORDS.fallback));
        expect(takeUpRefusalText(null)).toBe('Could not take up this Offer for the enterprise.');
        expect(takeUpRefusalText({ code: 'units_gone' })).toBe(itemTakeUpRefusalText({ code: 'units_gone' }));
    });

    it('the listing is read again after a count refusal or post_gone, and not after the others', () => {
        expect(['units_gone', 'price_changed', 'lot_gone', 'post_gone'].every((code) => takeUpListingMoved({ code }))).toBe(true);
        expect(['TWO_PERSON_RULE', 'deal_open', 'standby', undefined].some((code) => takeUpListingMoved({ code }))).toBe(false);
    });
});

describe('the answer once Beans are held: never a false success', () => {
    it('released only when the node says released: true', () => {
        expect(takeUpAnswerOf({ success: true, released: true })).toEqual({ released: true, held: null });
    });
    it('held, not released: the node\'s words say where it is (red if a held deal reads as paid)', () => {
        const held = 'The Beans are held for this sale, but it isn’t released yet. A keeper can release it from the enterprise’s deals.';
        expect(takeUpAnswerOf({ success: true, released: false, error: held })).toEqual({ released: false, held });
        expect(takeUpAnswerOf({ success: true }).released).toBe(false);
        expect(takeUpAnswerOf(null).held).toBe('Could not take up this Offer for the enterprise.');
    });
});

describe('a held leftover in the console: Release asks no hours for a deal priced each', () => {
    // (price unit) -> asks hours. Red if an each deal opens the "hours worked" prompt (a count is not a time, D5).
    for (const [unit, asks] of [['each', false], ['fixed', false], [null, false], ['hourly', true], ['daily', true], ['weekly', true], ['monthly', true]] as const) {
        it(`${unit ?? 'none'} -> ${asks}`, () => expect(releaseAsksHours(unit)).toBe(asks));
    }
});
