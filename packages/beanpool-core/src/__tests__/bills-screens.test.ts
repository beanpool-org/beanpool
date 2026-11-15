/**
 * The apps' bill screens (DESIGN-getting-paid-fable §4.2, §4.3; slice B2): the one model both apps draw. The table runs
 * every bill state (sent, paid, declined, left to expire, expired, blocked, reported) past every reader (its sender, its
 * payer, a stranger to it) and pins the lines and buttons each one gets; then the sheet's binding to its exact bill, the
 * retry ids, and a lost answer.
 */
import { describe, it, expect } from 'vitest';
import {
    billAnswerLost, billBalanceOf, billBinding, billBoundSheet, billDoor, billLedgerNote, billLines, billPayRequestFor, billPaySheet, billSendIdFor,
    billSentRow, billToPayRow, type BillBalanceRead, type BillBalanceState, type BillDraft, type BillView,
} from '../bills';

const ROB = 'a'.repeat(64);
const KIM = 'b'.repeat(64);
const ZED = 'c'.repeat(64);
const NOW = Date.parse('2026-11-14T10:00:00.000Z');
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const HOLDS: BillBalanceRead = { balance_c: 8500, usableFloor_c: 0, floor_c: 0, liveOffers: 0 };

/** One bill, Rob → Kim, 60 Beans, as each side's read gives it. */
function bill(role: 'to-pay' | 'sent', over: Partial<BillView> = {}): BillView {
    return {
        id: 'bill-0001', role, billerPublicKey: ROB, billerName: 'Rob', payerPublicKey: KIM, payerName: 'Kim', amount_c: 6000,
        whatFor: 'Power, October', postId: null, postTitle: null, standingId: null, state: 'sent',
        sentAt: '2026-11-12T10:00:00.000Z', expiresAt: '2026-12-12T10:00:00.000Z', paidAt: null,
        ...(role === 'to-pay' ? { known: true, creditOpen: false } : {}), ...over,
    };
}

/**
 * Each state as the node answers it to each side (engine/bills.ts billViewFor): the sender reads a declined bill as `sent`;
 * the payer's read lists only bills waiting on them, so a bill paid, declined, withdrawn, expired, from someone they blocked
 * or that they reported reaches their app only as the stale copy an open sheet still holds.
 */
const STATES: Record<string, { payer: Partial<BillView>; sender: Partial<BillView> }> = {
    sent: { payer: {}, sender: {} },
    paid: { payer: { state: 'paid', paidAt: '2026-11-14T09:00:00.000Z' }, sender: { state: 'paid', paidAt: '2026-11-14T09:00:00.000Z' } },
    declined: { payer: { state: 'declined' }, sender: { state: 'sent' } },
    'left to expire': { payer: { expiresAt: '2026-11-14T09:59:59.000Z' }, sender: { expiresAt: '2026-11-14T09:59:59.000Z' } },
    expired: { payer: { state: 'expired' }, sender: { state: 'expired' } },
    // Blocked: the payer's node never lists it (hiddenFrom), so the payer's copy is the one they held before blocking, now gone.
    blocked: { payer: { state: 'sent' }, sender: { state: 'sent' } },
    // Reported: declined by the report; the sender reads not paid.
    reported: { payer: { state: 'declined' }, sender: { state: 'sent' } },
};

type Seen = { lines: string[]; actions: string[] } | null;

/** What a reader's screens show of a bill: the payer's sheet, or the sender's row; nothing for anyone else. */
function seen(b: BillView, me: string, listed: readonly BillView[]): Seen {
    if (b.role === 'to-pay') {
        // The sheet acts only on the bill as the latest read lists it (billBoundSheet).
        const now = billBoundSheet(billBinding(b), listed, me, NOW);
        const sheet = now ? billPaySheet(now, me, HOLDS, NOW, day) : null;
        if (!sheet) return null;
        return {
            lines: [sheet.title, sheet.whatFor, sheet.amount, sheet.sent, ...(sheet.stranger ? [sheet.stranger] : []), sheet.money?.line ?? ''],
            actions: [sheet.canPay ? 'pay' : 'pay-off', 'decline', 'message', ...(sheet.block ? ['block'] : []), ...(sheet.report ? ['report'] : [])],
        };
    }
    const row = billSentRow(b, me, NOW, day);
    return row ? { lines: [row.line], actions: row.withdraw ? ['withdraw'] : [] } : null;
}

const PAYER_SHEET = {
    lines: ['🧾 Bill from Rob', 'Power, October', '60 Beans', 'Sent 2026-11-12 · waits until 2026-12-12', 'You have 85 Beans. After this: 25.'],
    actions: ['pay', 'decline', 'message'],
};
const NOT_PAID = { lines: ['Kim · Power, October · 60 Beans · sent 2026-11-12 · not paid'], actions: ['withdraw'] };
const EXPIRED = { lines: ['Kim · Power, October · 60 Beans · expired, not paid'], actions: [] };

/** state → reader → what they see. The payer's list holds the bill only while their node still lists it. */
const TABLE: Record<string, { payer: Seen; sender: Seen; stranger: Seen; listed: boolean }> = {
    sent: { payer: PAYER_SHEET, sender: NOT_PAID, stranger: null, listed: true },
    paid: { payer: null, sender: { lines: ['Kim · Power, October · 60 Beans · paid 2026-11-14 · 59.10 Beans received'], actions: [] }, stranger: null, listed: false },
    declined: { payer: null, sender: NOT_PAID, stranger: null, listed: false },
    'left to expire': { payer: null, sender: EXPIRED, stranger: null, listed: true },
    expired: { payer: null, sender: EXPIRED, stranger: null, listed: false },
    blocked: { payer: null, sender: NOT_PAID, stranger: null, listed: false },
    reported: { payer: null, sender: NOT_PAID, stranger: null, listed: false },
};

describe('bill states x readers: the lines and buttons each one gets (both apps draw this model)', () => {
    for (const [state, want] of Object.entries(TABLE)) {
        it(state, () => {
            const payerCopy = bill('to-pay', STATES[state].payer);
            const senderCopy = bill('sent', STATES[state].sender);
            const listed = want.listed ? [payerCopy] : [];
            expect(seen(payerCopy, KIM, listed), 'payer').toEqual(want.payer);
            expect(seen(senderCopy, ROB, []), 'sender').toEqual(want.sender);
            // A stranger to the bill: neither side's copy shows them anything.
            expect(seen(payerCopy, ZED, listed), 'stranger, payer copy').toBeNull();
            expect(seen(senderCopy, ZED, []), 'stranger, sender copy').toBe(want.stranger);
            // The payer never sees the sender's row, nor the sender the payer's sheet.
            expect(seen(senderCopy, KIM, [])).toBeNull();
            expect(seen(payerCopy, ROB, listed)).toBeNull();
        });
    }

    it("a bill from someone the payer hasn't dealt with: the warning, with Block and Report beside Decline", () => {
        const b = bill('to-pay', { known: false, billerName: 'Zed' });
        expect(seen(b, KIM, [b])).toEqual({
            lines: ['🧾 Bill from Zed', 'Power, October', '60 Beans', 'Sent 2026-11-12 · waits until 2026-12-12',
                "⚠️ You haven't dealt with Zed before. Only pay for something you agreed to. BeanPool and this community never send bills.",
                'You have 85 Beans. After this: 25.'],
            actions: ['pay', 'decline', 'message', 'block', 'report'],
        });
    });

    it('Pay is off with its line in every case the node refuses, and off while the balance is read', () => {
        const b = bill('to-pay');
        const off = (read: BillBalanceRead, creditOpen: boolean) => billPaySheet({ ...b, creditOpen }, KIM, read, NOW, day)!;
        for (const [read, creditOpen, line] of [
            [{ balance_c: 0, usableFloor_c: 0, floor_c: -100000, liveOffers: 0 }, true, billLines.openLine()],
            [{ balance_c: 1200, usableFloor_c: -100000, floor_c: -100000, liveOffers: 2 }, false, billLines.firstBillHeldOnly(1200, '2026-12-12')],
            [{ balance_c: 0, usableFloor_c: 0, floor_c: 0, liveOffers: 0 }, false, billLines.nothingToPay(6000, '2026-12-12')],
        ] as Array<[BillBalanceRead, boolean, string]>) {
            const s = off(read, creditOpen);
            expect(s.canPay).toBe(false);
            expect(s.money?.line).toBe(line);
            expect(s.postOffer).toBe('Post an Offer');
        }
        const reading = billPaySheet(b, KIM, null, NOW, day)!;
        expect(reading.canPay).toBe(false);
        expect(reading.money).toBeNull();
        // On the line, dealt before: Pay on.
        expect(off({ balance_c: 2000, usableFloor_c: -100000, floor_c: -100000, liveOffers: 1 }, true).canPay).toBe(true);
    });

    it('a bill with an invite nobody has joined with yet (B3): its own line, no Withdraw (the invite takes it), never "expired"', () => {
        const b = bill('sent', { payerPublicKey: '', payerName: '', expiresAt: '', awaitingJoin: true });
        expect(billSentRow(b, ROB, NOW, day)).toEqual({ billId: 'bill-0001', line: 'With an invite · Power, October · 60 Beans · waiting for them to join', withdraw: null });
        expect(billSentRow(b, ZED, NOW, day)).toBeNull();
    });

    it('the sheet names the listing it is about, and opens it', () => {
        const s = billPaySheet(bill('to-pay', { postId: 'post-1', postTitle: "Room at Rob's" }), KIM, HOLDS, NOW, day)!;
        expect(s.about).toBe("About: Room at Rob's ›");
        expect(s.aboutPostId).toBe('post-1');
        expect(billPaySheet(bill('to-pay', { postId: 'post-1', postTitle: null }), KIM, HOLDS, NOW, day)!.about).toBeNull();
    });

    it('To pay rows: the bell line for each bill waiting, amber only from someone known', () => {
        expect(billToPayRow(bill('to-pay'), KIM, NOW)).toEqual({ billId: 'bill-0001', label: 'Bill from Rob: Power, October · 60 Beans', accent: true });
        expect(billToPayRow(bill('to-pay', { known: false }), KIM, NOW)?.accent).toBe(false);
        expect(billToPayRow(bill('to-pay', STATES['left to expire'].payer), KIM, NOW)).toBeNull();
        expect(billToPayRow(bill('to-pay'), ZED, NOW)).toBeNull();
    });
});

describe('a sheet acts only on the exact bill it was opened for', () => {
    const opened = billBinding(bill('to-pay'));
    it('the same bill, still waiting: the sheet stays', () => {
        expect(billBoundSheet(opened, [bill('to-pay')], KIM, NOW)?.id).toBe('bill-0001');
    });
    it('gone from the read, answered, past its days, or anything it asks changed: the sheet closes', () => {
        expect(billBoundSheet(opened, [], KIM, NOW)).toBeNull();
        expect(billBoundSheet(opened, [bill('to-pay', { id: 'bill-0002' })], KIM, NOW)).toBeNull();
        for (const over of [{ state: 'paid' as const }, { state: 'declined' as const }, { expiresAt: '2026-11-14T10:00:00.000Z' },
            { amount_c: 6001 }, { whatFor: 'Power, November' }, { billerPublicKey: ZED }, { payerPublicKey: ZED }]) {
            expect(billBoundSheet(opened, [bill('to-pay', over)], KIM, NOW), JSON.stringify(over)).toBeNull();
        }
        // The sender's copy of the same id is not the payer's bill.
        expect(billBoundSheet(opened, [bill('sent')], KIM, NOW)).toBeNull();
    });
});

describe('retry ids: one per exact request', () => {
    let n = 0;
    const make = () => `id-${++n}`;
    it("a payment's id is kept for its bill, and new for any other", () => {
        const first = billPayRequestFor(null, 'bill-0001', make);
        expect(billPayRequestFor(first, 'bill-0001', make)).toBe(first);
        expect(billPayRequestFor(first, 'bill-0002', make).requestId).not.toBe(first.requestId);
    });
    it("a send's id is the same only for exactly the same bill: any edit makes a new one", () => {
        const draft: BillDraft = { to: KIM, amount_c: 6000, whatFor: 'Power, October', postId: null, standingId: null };
        const first = billSendIdFor(null, draft, make);
        expect(billSendIdFor(first, { ...draft }, make)).toBe(first);
        for (const edit of [{ to: ZED }, { amount_c: 6001 }, { whatFor: 'Power, Nov' }, { postId: 'p' }, { standingId: 's' }]) {
            expect(billSendIdFor(first, { ...draft, ...edit }, make).id, JSON.stringify(edit)).not.toBe(first.id);
        }
    });
});

describe('a lost answer', () => {
    it('no status, 0, a gateway or a server error: lost; the node answering in its words: not', () => {
        for (const e of [new TypeError('Failed to fetch'), { status: 0 }, { status: 502 }, { status: 504 }, { status: 500 }, null]) expect(billAnswerLost(e)).toBe(true);
        for (const e of [{ status: 409 }, { status: 429 }, { status: 403 }, { status: 404 }]) expect(billAnswerLost(e)).toBe(false);
    });
    it('the words never say nothing happened', () => {
        for (const line of [billLines.payLost(), billLines.declineLost(), billLines.withdrawLost(), billLines.reportLost()]) {
            expect(line).toMatch(/may have/);
            expect(line).not.toMatch(/nothing/i);
        }
    });
});

describe("the Ledger's line for a bill", () => {
    it("names the bill and the other side, in the member's words", () => {
        expect(billLedgerNote('Bill · Power, October', true, 'Rob')).toBe('Bill · Power, October · to Rob');
        expect(billLedgerNote('Bill · Power, October', false, 'Kim')).toBe('Bill · Power, October · from Kim');
        expect(billLedgerNote('Bill · Power, October', true, null)).toBe('Bill · Power, October');
        expect(billLedgerNote('Standing deal · Room', true, 'Rob')).toBeNull();
        expect(billLedgerNote(undefined, true, 'Rob')).toBeNull();
    });
});

// ── Round 2 of #3210: a door lands where the bill is; the sheet's balance is the node's, and a failed read says so ──────

describe('a door to a bill lands on the list that holds it (billDoor), never "not waiting" for a bill a list holds', () => {
    // Each state as the node lists it to each side (engine/bills.ts listBills): the payer's To pay holds a bill only while it
    // waits on them (one past its 30 days not yet flipped may still be listed); the sender's Sent holds every bill they sent.
    const CASES: Array<{ state: string; payerList: BillView[]; senderList: BillView[] }> = [
        { state: 'open', payerList: [bill('to-pay')], senderList: [bill('sent')] },
        { state: 'paid', payerList: [], senderList: [bill('sent', STATES.paid.sender)] },
        { state: 'declined', payerList: [], senderList: [bill('sent', STATES.declined.sender)] },
        { state: 'expired', payerList: [], senderList: [bill('sent', STATES.expired.sender)] },
        { state: 'left to expire', payerList: [bill('to-pay', STATES['left to expire'].payer)], senderList: [bill('sent', STATES['left to expire'].sender)] },
        { state: 'withdrawn', payerList: [], senderList: [bill('sent', { state: 'withdrawn' })] },
    ];
    const NOT_WAITING = { side: 'to-pay', open: null, shown: null, said: billLines.notWaiting() };
    for (const c of CASES) {
        it(`${c.state}: its payer, its sender, and a stranger to it`, () => {
            // The payer: To pay with the sheet bound to it while it waits; otherwise it is in no list of theirs, and the line says so.
            const payer = billDoor({ toPay: c.payerList, sent: [] }, 'bill-0001', KIM, NOW);
            if (c.state === 'open') expect(payer).toEqual({ side: 'to-pay', open: billBinding(bill('to-pay')), shown: 'bill-0001', said: null });
            else expect(payer).toEqual(NOT_WAITING);
            // The sender (the node pushes "paid your bill" to them with the same { screen: 'bill', billId }): Sent, its row shown.
            expect(billDoor({ toPay: [], sent: c.senderList }, 'bill-0001', ROB, NOW)).toEqual({ side: 'sent', open: null, shown: 'bill-0001', said: null });
            // Someone handed either copy who is neither side: no sheet, no row.
            expect(billDoor({ toPay: c.payerList, sent: c.senderList }, 'bill-0001', ZED, NOW)).toEqual(NOT_WAITING);
        });
    }
    it('with both lists full, each id lands on its own side', () => {
        const lists = { toPay: [bill('to-pay')], sent: [bill('sent', { id: 'bill-0002', billerPublicKey: KIM, payerPublicKey: ROB })] };
        expect(billDoor(lists, 'bill-0002', KIM, NOW).side).toBe('sent');
        expect(billDoor(lists, 'bill-0001', KIM, NOW).side).toBe('to-pay');
    });
    it('an id in neither list says the plain line', () => {
        expect(billDoor({ toPay: [bill('to-pay')], sent: [bill('sent')] }, 'bill-9999', KIM, NOW)).toEqual(NOT_WAITING);
    });
});

describe("the sheet's balance: the node's read only (billBalanceOf), Pay off with a line until it lands, a failure says so", () => {
    it("billBalanceOf: the node's figures, or no read at all; never a guessed figure", () => {
        expect(billBalanceOf({ balance_c: 1000, usableFloor_c: -20000, floor_c: -50000, liveOffers: 2, tier: {} }))
            .toEqual({ balance_c: 1000, usableFloor_c: -20000, floor_c: -50000, liveOffers: 2 });
        // Missing line figures read as no credit (Pay never on where the node refuses).
        expect(billBalanceOf({ balance_c: 1000 })).toEqual({ balance_c: 1000, usableFloor_c: 0, floor_c: 0, liveOffers: 0 });
        expect(billBalanceOf({ balance_c: 1000, usableFloor_c: 'x', floor_c: 1.5, liveOffers: -1 })).toEqual({ balance_c: 1000, usableFloor_c: 0, floor_c: 0, liveOffers: 0 });
        // No balance in whole hundredths is no read: the sheet says it failed rather than "You need 60 Beans".
        for (const answer of [null, undefined, {}, { balance: 10 }, { balance_c: '1000' }, { balance_c: 10.5 }, { balance_c: null }, 'x', 42]) {
            expect(billBalanceOf(answer), JSON.stringify(answer)).toBeNull();
        }
    });
    it('reading, failed and read: the line in place of the money line, the retry, and Pay', () => {
        const b = bill('to-pay', { creditOpen: true });
        const rows: Array<[BillBalanceState, { wait: string | null; retry: string | null; money: string | null; canPay: boolean }]> = [
            [null, { wait: billLines.balanceReading(), retry: null, money: null, canPay: false }],
            ['reading', { wait: billLines.balanceReading(), retry: null, money: null, canPay: false }],
            ['failed', { wait: billLines.balanceFailed(), retry: 'Try again', money: null, canPay: false }],
            // On credit from the node's read: 10 held, 200 usable (the phone's cached read with no tier cache said "You need 60").
            [billBalanceOf({ balance_c: 1000, usableFloor_c: -20000, floor_c: -20000, liveOffers: 1 }),
                { wait: null, retry: null, money: 'This takes you to 50 Beans below zero. Your line goes to 200.', canPay: true }],
        ];
        for (const [read, want] of rows) {
            const s = billPaySheet(b, KIM, read, NOW, day)!;
            expect({ wait: s.balanceWait, retry: s.balanceRetry, money: s.money?.line ?? null, canPay: s.canPay }, String(read)).toEqual(want);
            expect(s.postOffer).toBe(s.money?.postOffer ? billLines.postOffer() : null);
        }
        expect(billLines.balanceFailed()).not.toMatch(/nothing/i);
    });
});
