/**
 * "Buy for {enterprise}", core (DESIGN-stall-consignment-fable.md §5.6, §6 slice 2, §7 item 12): who sees the button, the
 * confirm sheet's sentence and figures against the fee function, the retry id, every refusal the door answers, the answer
 * read, and which console release asks for hours. Both apps draw exactly these. Each check names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';
import {
    TAKE_UP_REFUSALS, TAKE_UP_RESEND_HOURS, TAKE_UP_WORDS, enterpriseTakeUpOffered, releaseAsksHours, takeUpAgedLine, takeUpAnswerOf, takeUpBody,
    takeUpButtons, takeUpConfirm, takeUpListingMoved, takeUpLostLine, takeUpOutcomeOf, takeUpRefusalText, takeUpRequestFor, takeUpSettle, takeUpSheet, takeUpUnansweredBook,
    type TakeUpEnterprise, type TakeUpOutcome, type TakeUpRequest,
} from '../enterprise-take-up';
import { ITEM_BOX_START, itemTakeUpBox, type ItemBoxState } from '../per-item-deal';
import { EACH, ITEM_TAKE_UP_REFUSALS, itemTakeUpRefusalText } from '../per-item';
import { feeOf, formatHundredths } from '../hundredths';
import { billAnswerLost } from '../bills';
import { busyError } from '../busy-answer';
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
        // Another community's pulled copy: the door takes up a listing here only (acceptPost's assertTradableHere refuses it
        // with no code). Red if either app's shape of a copy shows the button (finding 2 of the r1 review: the phone did).
        ['another community\'s copy, the phone\'s row (origin_node): no button', { listing: apples({ origin_node: 'riverside.example' }) }, []],
        ['another community\'s copy, the web\'s post (originNode): no button', { listing: apples({ originNode: 'riverside.example' }) }, []],
        ['a listing the web read from another community (_remoteNode): no button', { listing: apples({ _remoteNode: 'https://riverside.example' }) }, []],
        ['a listing here (origin_node null, originNode empty): the button shows', { listing: apples({ origin_node: null, originNode: '' }) }, ['Buy for Riverside stall']],
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

describe('an answer that never came: kept, said, and sent again exactly, so a stall never pays twice (r1 review finding 1)', () => {
    /**
     * THE CLASS: a Confirm's answer can be the node's (a sale, held or released; its own refusal), lost (no answer, a gateway,
     * a server error), or the network's in front of it (busy, a proxy's page). Only the node's answer may forget a sale sent;
     * a lost one must say it may have gone through and send the SAME sale again (the same id), whatever happens to the sheet,
     * the page or the listing meanwhile. Every error shape either app's request helper throws (apps/native/utils/db.ts
     * _signedRequest, apps/pwa/src/lib/api.ts request + refusalError) is a row; both apps' component tests run these shapes
     * through their sheet and check it does what takeUpOutcomeOf says.
     */
    const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);
    // [case, error thrown, outcome]
    const ROWS: Array<[string, unknown, TakeUpOutcome]> = [
        // Lost: the stall may have paid.
        ['phone: the 12-second abort (Aborted, no status)', err('Aborted'), 'lost'],
        ['phone: a dropped signal (Network request failed, no status)', err('Network request failed'), 'lost'],
        ['phone: off-grid before sending (no status: never sure, so the same sale again)', err('You are off-grid. Please connect to a BeanPool Node to perform this action.'), 'lost'],
        ['phone: a gateway 502 (nodeAnswered false)', err('Server returned 502', { status: 502, nodeAnswered: false }), 'lost'],
        ['phone: a gateway 504', err('Server returned 504', { status: 504, nodeAnswered: false }), 'lost'],
        ['phone: the node\'s own 500', err('Something went wrong on the server.', { status: 500, nodeAnswered: true }), 'lost'],
        ['web: Failed to fetch (Chrome, no status)', new TypeError('Failed to fetch'), 'lost'],
        ['web: Load failed (Safari, no status)', new TypeError('Load failed'), 'lost'],
        ['web: an abort (AbortError)', Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }), 'lost'],
        ['web: a gateway 502 with no JSON (unsaid)', err('Bad Gateway', { status: 502, unsaid: true }), 'lost'],
        ['web: a gateway 504', err('Gateway Timeout', { status: 504, unsaid: true }), 'lost'],
        ['a 503 (a node restarting, a proxy): lost', err('Service Unavailable', { status: 503, unsaid: true }), 'lost'],
        ['status 0', err('x', { status: 0 }), 'lost'],
        ['nothing at all thrown', undefined, 'lost'],
        // Unsent: the network in front of the node answered; the node never saw it.
        ['either app: the busy network\'s 429 (busyError)', busyError('5'), 'unsent'],
        ['phone: a proxy\'s 403 page (nodeAnswered false)', err('Server returned 403', { status: 403, nodeAnswered: false }), 'unsent'],
        ['web: a proxy\'s 403 page (unsaid)', err('Forbidden', { status: 403, unsaid: true }), 'unsent'],
        // Refused: the node's own words; nothing was paid on this id and the node recorded none.
        ['the node: deal_open', err('You already have a deal under way.', { status: 409, code: 'deal_open', nodeAnswered: true }), 'refused'],
        ['the node: units_gone, with how many are left', err('Only 1 left.', { status: 409, code: 'units_gone', unitsLeft: 1 }), 'refused'],
        ['the node: price_changed', err('The price changed.', { status: 409, code: 'price_changed' }), 'refused'],
        ['the node: post_gone', err('Post not found or not active', { status: 400, code: 'post_gone' }), 'refused'],
        ['the node: take_up_cancelled', err('That sale was cancelled.', { status: 409, code: 'take_up_cancelled' }), 'refused'],
        ['the node: TWO_PERSON_RULE', err('Cannot accept your own post', { status: 403, code: 'TWO_PERSON_RULE' }), 'refused'],
        ['the node: not a keeper (403, no code)', err('You are not a keeper of this enterprise', { status: 403, nodeAnswered: true }), 'refused'],
        ['the node: a daily money limit (429 with its code)', err('Daily limit reached.', { status: 429, code: 'money_payments_day' }), 'refused'],
        ['the node: standby (409, routes/standby-ledger-gate.ts)', err('This server is a standby.', { status: 409, code: 'standby', nodeAnswered: true }), 'refused'],
    ];

    for (const [name, e, outcome] of ROWS) {
        it(`${name} -> ${outcome} (red if a lost answer reads as a refusal, or the node's refusal as lost)`, () => {
            expect(takeUpOutcomeOf(e)).toBe(outcome);
            // Lost is exactly bills' rule (billAnswerLost), so the two money sheets can never disagree on it.
            expect(takeUpOutcomeOf(e) === 'lost').toBe(billAnswerLost(e));
        });
    }

    const send2 = { hours: 2, itemOption: 'each' as const, expect_c: 4000 };
    const sentence = 'Riverside stall pays Alice 40 Beans for 2 of “Apples”.';
    // (outcome, sent again?) -> kept afterwards. Red if any path that is not the node's own answer forgets a sale that may
    // have gone through, or a path that is the node's answer keeps one (the next sale would then be answered as the old one).
    const SETTLE: Array<[TakeUpOutcome | 'answered', boolean, boolean]> = [
        ['answered', false, false], ['answered', true, false],
        ['refused', false, false], ['refused', true, false],
        ['lost', false, true], ['lost', true, true],
        ['unsent', false, false], ['unsent', true, true],
    ];
    for (const [outcome, resent, kept] of SETTLE) {
        it(`a Confirm ${resent ? 'sending a kept sale again' : 'sending a new sale'} that comes back ${outcome}: ${kept ? 'kept' : 'forgotten'}`, () => {
            const book = takeUpUnansweredBook();
            const sale = { enterprise: STALL, postId: 'p1', body: takeUpBody('p1', send2, { key: 'k', requestId: 'first-id-1' }), sentence, sentAt: book.now() };
            book.keep(sale); // both apps keep it the moment it goes
            takeUpSettle(book, { sale, resent }, outcome);
            expect(book.get(STALL, 'p1')).toEqual(kept ? sale : null);
        });
    }

    it('the book keeps one sale per enterprise and listing; another enterprise or listing is its own', () => {
        const book = takeUpUnansweredBook();
        const sale = (enterprise: string, postId: string) => ({ enterprise, postId, body: takeUpBody(postId, send2, { key: 'k', requestId: `${enterprise}-${postId}-id` }), sentence, sentAt: book.now() });
        book.keep(sale(STALL, 'p1'));
        book.keep(sale(CAFE, 'p1'));
        book.keep(sale(STALL, 'p2'));
        expect(book.get(STALL, 'p1')!.body.requestId).toBe('stall-key-p1-id');
        expect(book.get(CAFE, 'p1')!.body.requestId).toBe('cafe-key-p1-id');
        book.forget(STALL, 'p1');
        expect(book.get(STALL, 'p1')).toBeNull();
        expect(book.get(CAFE, 'p1')).not.toBeNull();
        expect(book.get(STALL, 'p2')).not.toBeNull();
    });

    it('the line says the stall may have paid and Confirm finds out: never "nothing was paid", never a raw network error', () => {
        const line = takeUpLostLine({ stall: 'Riverside stall', seller: 'Alice' });
        expect(line).toBe('Your community’s server didn’t answer, so Riverside stall may have paid Alice already. Press Confirm again to find out: it is never paid twice.');
        expect(line).not.toMatch(/nothing was paid|Aborted|Failed to fetch/);
    });

    /**
     * The review's scenario, step by step through the same calls both components make: Kim taps "Buy for Riverside stall",
     * picks 2 of "Apples" at 20 Beans and Confirms; the node sells and releases, but the answer is lost. Kim taps Cancel (the
     * sheet's own request is dropped), the listing is read again (1 left now, sold out, or unchanged), Kim reopens and
     * Confirms. The same sale goes again with the same id and count, so the node answers it with the first sale. Red if any
     * step makes a new id or a different body.
     */
    for (const [after, unitsLeft] of [['1 left now', 1], ['sold out', 0], ['unchanged', 3]] as const) {
        it(`lost, Cancel, the listing read again (${after}), reopen, Confirm: the very same sale and id`, () => {
            const book = takeUpUnansweredBook();
            let made = 0;
            const make = () => `take-up-try-${++made}`;
            const names = { stall: 'Riverside stall', seller: 'Alice', title: 'Apples' };
            const open = (listing: unknown, state: ItemBoxState, request: TakeUpRequest | null) => {
                const box = book.get(STALL, 'p1') ? null : itemTakeUpBox(listing, state, 'Alice');
                const sheet = takeUpSheet(box?.send, names);
                return takeUpConfirm({ book, request, enterprise: STALL, postId: 'p1', send: box?.send, sentence: sheet?.sentence, make });
            };
            const first = open(apples(), { option: 'each', count: '2' }, null)!;
            expect(first.resent).toBe(false);
            expect(first.sale.body).toEqual({ postId: 'p1', hours: 2, itemOption: 'each', expect_c: 4000, requestId: 'take-up-try-1' });
            book.keep(first.sale);
            takeUpSettle(book, first, takeUpOutcomeOf(new Error('Aborted')));
            // Cancel: the sheet forgets its own request; the book keeps the sale. The listing is read again.
            const reread = apples({ unitsLeft, status: unitsLeft === 0 ? 'completed' : 'active' });
            const again = open(reread, ITEM_BOX_START, null)!;
            expect(again.resent).toBe(true);
            expect(again.sale.body).toBe(first.sale.body);
            expect(again.sale.sentence).toBe(first.sale.sentence);
            expect(made).toBe(1);
            // The node answers it (the first sale, replayed): forgotten, and the next sale is a new one with a new id.
            book.keep(again.sale);
            takeUpSettle(book, again, 'answered');
            expect(book.get(STALL, 'p1')).toBeNull();
            if (unitsLeft > 0) {
                const next = open(reread, { option: 'each', count: '1' }, null)!;
                expect(next.resent).toBe(false);
                expect(next.sale.body.requestId).toBe('take-up-try-2');
            } else {
                expect(open(reread, ITEM_BOX_START, null)).toBeNull(); // sold out: nothing more to send
            }
        });
    }

    it('a busy answer to the kept sale sent again leaves it kept; the node\'s refusal of it forgets it (it never went through)', () => {
        const book = takeUpUnansweredBook();
        const first = takeUpConfirm({ book, request: null, enterprise: STALL, postId: 'p1', send: send2, sentence })!;
        book.keep(first.sale);
        takeUpSettle(book, first, 'lost');
        const busy = takeUpConfirm({ book, request: null, enterprise: STALL, postId: 'p1', send: send2, sentence })!;
        expect(busy.resent).toBe(true);
        takeUpSettle(book, busy, takeUpOutcomeOf(busyError(null)));
        expect(book.get(STALL, 'p1')).toBe(first.sale);
        const refused = takeUpConfirm({ book, request: null, enterprise: STALL, postId: 'p1', send: { ...send2, hours: 1, expect_c: 2000 }, sentence })!;
        expect(refused.sale).toBe(first.sale); // a changed count still sends the kept sale first
        takeUpSettle(book, refused, takeUpOutcomeOf(Object.assign(new Error('Only 1 left.'), { status: 409, code: 'units_gone', unitsLeft: 1 })));
        expect(book.get(STALL, 'p1')).toBeNull();
    });

    it('a new sale met by the busy network is not kept (it never got there), but the sheet\'s own id is, for the same tap again', () => {
        const book = takeUpUnansweredBook();
        const first = takeUpConfirm({ book, request: null, enterprise: STALL, postId: 'p1', send: send2, sentence })!;
        book.keep(first.sale);
        takeUpSettle(book, first, takeUpOutcomeOf(busyError(null)));
        expect(book.get(STALL, 'p1')).toBeNull();
        const again = takeUpConfirm({ book, request: first.request, enterprise: STALL, postId: 'p1', send: send2, sentence })!;
        expect(again.sale.body.requestId).toBe(first.sale.body.requestId);
    });

    it('nothing to send and nothing kept: no Confirm', () => {
        expect(takeUpConfirm({ book: takeUpUnansweredBook(), request: null, enterprise: STALL, postId: 'p1', send: null, sentence: null })).toBeNull();
        expect(takeUpConfirm({ book: takeUpUnansweredBook(), request: null, enterprise: STALL, postId: 'p1', send: send2, sentence: null })).toBeNull();
    });
});

describe('a kept sale ages: sent again for TAKE_UP_RESEND_HOURS from its FIRST sending, never after (r2 review: the node forgets the id)', () => {
    /**
     * THE CLASS: the node keeps a take-up's request id for REQUEST_ID_KEPT_DAYS (7) and prunes it daily. A sale the book sends
     * again after that is a second sale, paid twice, under a line that promised "never paid twice". So a kept sale is stamped
     * with its first sending (a resend keeps the stamp, as the node's record keeps its first time), sent again only while it is
     * younger than TAKE_UP_RESEND_HOURS (a day), and after that is `aged`: never sent again, under the book's copy or the
     * sheet's own id, never in the way of a new sale. The node's suite (apps/server/src/test-enterprise-take-up.ts) reads
     * REQUEST_ID_KEPT_DAYS and pins the day strictly inside it.
     */
    const H = 3_600_000;
    const T0 = Date.UTC(2026, 10, 21, 9, 0); // a Saturday market, 9 am
    const send2 = { hours: 2, itemOption: 'each' as const, expect_c: 4000 };
    const sentence = 'Riverside stall pays Alice 40 Beans for 2 of “Eggs”.';
    const withClock = () => {
        const clock = { now: T0 };
        return { clock, book: takeUpUnansweredBook(() => clock.now) };
    };
    const lostAt = (book: ReturnType<typeof takeUpUnansweredBook>, request: TakeUpRequest | null = null, make?: () => string) => {
        const go = takeUpConfirm({ book, request, enterprise: STALL, postId: 'p1', send: send2, sentence, make })!;
        book.keep(go.sale);
        takeUpSettle(book, go, takeUpOutcomeOf(new TypeError('Failed to fetch')));
        return go;
    };

    it('the limit is a day, a whole number of hours above 0 (red if it is moved here without the node\'s suite seeing it)', () => {
        expect(TAKE_UP_RESEND_HOURS).toBe(24);
    });

    // (age since the FIRST sending, in ms) -> sent again? Red if a sale is sent again at or past the day, or not before it.
    const AGES: Array<[string, number, boolean]> = [
        ['just sent', 0, true],
        ['a minute on', 60_000, true],
        ['an hour on', H, true],
        ['the last millisecond of the day', TAKE_UP_RESEND_HOURS * H - 1, true],
        ['the day exactly', TAKE_UP_RESEND_HOURS * H, false],
        ['a day and an hour', 25 * H, false],
        ['six days (still inside the node\'s seven, but past the day)', 6 * 24 * H, false],
        ['seven days (the node\'s id may be gone)', 7 * 24 * H, false],
        ['eight days (the node\'s prune has run)', 8 * 24 * H, false],
        ['the clock set back 5 minutes since (a network time fix)', -5 * 60_000, true],
        ['the clock set back 11 minutes since: its age unknown', -11 * 60_000, false],
        ['the clock set back a week since: its age unknown', -7 * 24 * H, false],
    ];
    for (const [name, age, sendable] of AGES) {
        it(`${name}: ${sendable ? 'Confirm sends the same sale again' : 'aged, never sent again; Confirm is a new sale'}`, () => {
            const { clock, book } = withClock();
            const first = lostAt(book);
            clock.now = T0 + age;
            expect(book.get(STALL, 'p1')).toBe(sendable ? first.sale : null);
            expect(book.aged(STALL, 'p1')).toBe(sendable ? null : first.sale);
            const next = takeUpConfirm({ book, request: null, enterprise: STALL, postId: 'p1', send: send2, sentence })!;
            expect(next.resent).toBe(sendable);
            expect(next.sale.body.requestId === first.sale.body.requestId).toBe(sendable);
        });
    }

    it('a sale with no readable stamp is aged, never sent again (red if NaN reads as young)', () => {
        const { book } = withClock();
        const sale = { enterprise: STALL, postId: 'p1', body: takeUpBody('p1', send2, { key: 'k', requestId: 'stampless-1' }), sentence, sentAt: Number.NaN };
        book.keep(sale);
        expect(book.get(STALL, 'p1')).toBeNull();
        expect(book.aged(STALL, 'p1')).toBe(sale);
    });

    it('stamped at the first sending; sent again at 23 hours and lost again, it keeps the first stamp and ages at 24 (red if a resend renews it)', () => {
        const { clock, book } = withClock();
        const first = lostAt(book);
        expect(first.sale.sentAt).toBe(T0);
        clock.now = T0 + 23 * H;
        const again = takeUpConfirm({ book, request: null, enterprise: STALL, postId: 'p1', send: send2, sentence })!;
        expect(again.resent).toBe(true);
        book.keep(again.sale);
        takeUpSettle(book, again, takeUpOutcomeOf(Object.assign(new Error('Gateway Timeout'), { status: 504, unsaid: true })));
        expect(book.get(STALL, 'p1')!.sentAt).toBe(T0);
        // Sent again in the last minute of the day and its answer lost after it: kept, but aged, so never sent a third time.
        clock.now = T0 + 24 * H - 60_000;
        const last = takeUpConfirm({ book, request: null, enterprise: STALL, postId: 'p1', send: send2, sentence })!;
        expect(last.resent).toBe(true);
        book.keep(last.sale);
        clock.now = T0 + 24 * H + 60_000;
        takeUpSettle(book, last, 'lost');
        expect(book.get(STALL, 'p1')).toBeNull();
        expect(book.aged(STALL, 'p1')!.sentAt).toBe(T0);
    });

    it('a new sale is stamped with the book\'s clock when Confirm makes it, not when the sheet opened', () => {
        const { clock, book } = withClock();
        clock.now = T0 + 5 * H;
        expect(takeUpConfirm({ book, request: null, enterprise: STALL, postId: 'p1', send: send2, sentence })!.sale.sentAt).toBe(T0 + 5 * H);
    });

    /**
     * The review's scenario, step by step through the calls both components make. Saturday: Kim taps "Buy for Riverside
     * stall" on Alice's "Eggs", picks 2 at 20 Beans, Confirms; the node sells and releases, the answer is lost. Kim checks the
     * console and moves on. The tablet keeps the app open all week; Alice restocks. Next Saturday Kim taps "Buy for Riverside
     * stall" for this week's eggs, the same 2 at the same price. Red if last week's sale blocks the picker, if Confirm sends
     * last week's id (within 7 days the node would answer "released" for last week's sale, read as this week's paid; after 7
     * it would pay a second time under "never paid twice"), or if the aged line promises anything about the old sale.
     */
    for (const [when, request] of [['the sheet closed between', 'closed'], ['the sheet left open all week', 'open']] as const) {
        it(`a week on (${when}): the picker shows the listing, a line says the stall may have paid, and Confirm is a new sale with a new id`, () => {
            const { clock, book } = withClock();
            let made = 0;
            const make = () => `take-up-try-${++made}`;
            const first = lostAt(book, null, make);
            expect(first.sale.body.requestId).toBe('take-up-try-1');
            clock.now = T0 + 7 * 24 * H;
            // The components draw the picker whenever `get` finds nothing, and the aged line whenever `aged` finds the old one.
            expect(book.get(STALL, 'p1')).toBeNull();
            const box = itemTakeUpBox(apples({ title: 'Eggs', unitsLeft: 6 }), { option: 'each', count: '2' }, 'Alice')!;
            expect(box.send).toEqual(send2);
            const line = takeUpAgedLine({ stall: 'Riverside stall', seller: 'Alice' });
            expect(book.aged(STALL, 'p1')).not.toBeNull();
            expect(line).toBe('An earlier sale from here got no answer, so Riverside stall may have paid Alice for it already: the enterprise’s deals show whether it did. Confirm makes a new sale.');
            expect(line).not.toMatch(/nothing was paid|never paid twice|find out/);
            // The sheet left open keeps its own request for the same count and price: an aged sale's id is never reused.
            const sheetRequest = request === 'open' ? first.request : null;
            const week2 = takeUpConfirm({ book, request: sheetRequest, enterprise: STALL, postId: 'p1', send: box.send, sentence, make })!;
            expect(week2.resent).toBe(false);
            expect(week2.sale.body).toEqual({ postId: 'p1', hours: 2, itemOption: 'each', expect_c: 4000, requestId: 'take-up-try-2' });
            expect(week2.sale.sentAt).toBe(T0 + 7 * 24 * H);
            // Kept fresh while it goes; the node's answer forgets it, and the aged one with it.
            book.keep(week2.sale);
            expect(book.get(STALL, 'p1')).toBe(week2.sale);
            takeUpSettle(book, week2, 'answered');
            expect([book.get(STALL, 'p1'), book.aged(STALL, 'p1')]).toEqual([null, null]);
        });
    }

    it('an aged sale on another listing or enterprise leaves this one alone (red if the age is read across the book)', () => {
        const { clock, book } = withClock();
        lostAt(book);
        clock.now = T0 + 2 * 24 * H;
        const cafe = takeUpConfirm({ book, request: null, enterprise: CAFE, postId: 'p1', send: send2, sentence })!;
        book.keep(cafe.sale);
        takeUpSettle(book, cafe, 'lost');
        expect(book.get(CAFE, 'p1')).toBe(cafe.sale);
        expect(book.aged(STALL, 'p1')).not.toBeNull();
        expect(book.get(STALL, 'p1')).toBeNull();
    });
});
