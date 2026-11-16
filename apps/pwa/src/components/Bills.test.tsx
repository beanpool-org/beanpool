/**
 * Your deals → Bills on the web (DESIGN-getting-paid-fable §4.2, §4.3, §9 "Apps"; slice B2), with the phone's
 * utils/__tests__/bills-render.test.ts. The table runs every bill state (sent, paid, declined, left to expire, expired,
 * blocked, reported) past every reader (its sender, its payer, a stranger to it) through the real panel and sheet, and pins
 * the lines and buttons each one gets. Then: Pay off with its line in each case the node refuses; the sheet bound to its
 * exact bill (a read that drops or changes it closes the sheet for good); one payment retry id per bill, sent again on a
 * retry; a lost answer says the outcome is unknown; and the doors (a bell row, a notice, Home's line) open the bill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BillView } from '@beanpool/core';

const api = vi.hoisted(() => ({
    getBills: vi.fn(), getBalance: vi.fn(), payBill: vi.fn(), declineBill: vi.fn(), withdrawBill: vi.fn(), reportBill: vi.fn(),
}));
vi.mock('../lib/api', () => api);
vi.mock('../lib/blocklist', () => ({ blockUser: vi.fn(async () => true) }));

import { BillsPanel } from './Bills';
import { goToNoticeTarget, goToWebNeedsTarget } from './NeedsYouIcons';

const ROB = 'a'.repeat(64);
const KIM = 'b'.repeat(64);
const ZED = 'c'.repeat(64);
const FUTURE = new Date(Date.now() + 20 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

function bill(role: 'to-pay' | 'sent', over: Partial<BillView> = {}): BillView {
    return {
        id: 'bill-0001', role, billerPublicKey: ROB, billerName: 'Rob', payerPublicKey: KIM, payerName: 'Kim', amount_c: 6000,
        whatFor: 'Power, October', postId: null, postTitle: null, standingId: null, state: 'sent',
        sentAt: '2026-11-12T10:00:00.000Z', expiresAt: FUTURE, paidAt: null,
        ...(role === 'to-pay' ? { known: true, creditOpen: false } : {}), ...over,
    };
}

beforeEach(() => {
    for (const f of Object.values(api)) f.mockReset();
    api.getBalance.mockResolvedValue({ balance_c: 8500, usableFloor_c: 0, floor_c: 0, liveOffers: 0 });
});
afterEach(() => cleanup());

const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); await settle(); };

/** What one reader's Bills tab shows: the To pay rows, the open sheet's buttons, the Sent rows with their buttons. */
async function seen(me: string, toPay: BillView[], sent: BillView[]): Promise<{ toPay: string[]; sheet: string[] | null; sent: string[] }> {
    api.getBills.mockResolvedValue({ toPay, sent });
    render(<BillsPanel me={me} onMessage={vi.fn()} onOpenPost={vi.fn()} onPostOffer={vi.fn()} />);
    await settle();
    const rows = screen.queryAllByTestId(/^bill-row-/).map((r) => r.textContent ?? '');
    let sheet: string[] | null = null;
    const first = screen.queryAllByTestId(/^bill-row-/)[0];
    if (first) {
        await click(first);
        sheet = ['bill-pay', 'bill-decline', 'bill-message', 'bill-block', 'bill-report']
            .filter((id) => screen.queryByTestId(id))
            .map((id) => (id === 'bill-pay' && (screen.getByTestId(id) as HTMLButtonElement).disabled ? 'pay-off' : id.slice(5)));
        await click(screen.getByTestId('bill-close'));
    }
    await click(screen.getByTestId('bills-side-sent'));
    const sentRows = screen.queryAllByTestId(/^bill-sent-/).map((r) => r.textContent ?? '');
    cleanup();
    return { toPay: rows, sheet, sent: sentRows };
}

const NOT_PAID = 'Kim · Power, October · 60 Beans · sent 12 Nov · not paid';
const EXPIRED = 'Kim · Power, October · 60 Beans · expired, not paid';

/** state → the copy each side's node sends (the payer's lists only bills waiting on them), and what each reader sees. */
const TABLE: Array<{ state: string; payerList: BillView[]; senderList: BillView[]; payer: Awaited<ReturnType<typeof seen>>; sender: Awaited<ReturnType<typeof seen>> }> = [
    { state: 'sent', payerList: [bill('to-pay')], senderList: [bill('sent')],
        payer: { toPay: ['🧾 Bill from Rob: Power, October · 60 Beans'], sheet: ['pay', 'decline', 'message'], sent: [] },
        sender: { toPay: [], sheet: null, sent: [`${NOT_PAID}Withdraw`] } },
    { state: 'paid', payerList: [], senderList: [bill('sent', { state: 'paid', paidAt: '2026-11-14T09:00:00.000Z' })],
        payer: { toPay: [], sheet: null, sent: [] },
        sender: { toPay: [], sheet: null, sent: ['Kim · Power, October · 60 Beans · paid 14 Nov · 59.10 Beans received'] } },
    // The sender's node reads a declined bill as sent: "not paid", and Withdraw, so nothing tells a decline apart.
    { state: 'declined', payerList: [], senderList: [bill('sent')],
        payer: { toPay: [], sheet: null, sent: [] }, sender: { toPay: [], sheet: null, sent: [`${NOT_PAID}Withdraw`] } },
    { state: 'left to expire', payerList: [bill('to-pay', { expiresAt: PAST })], senderList: [bill('sent', { expiresAt: PAST })],
        payer: { toPay: [], sheet: null, sent: [] }, sender: { toPay: [], sheet: null, sent: [EXPIRED] } },
    { state: 'expired', payerList: [], senderList: [bill('sent', { state: 'expired' })],
        payer: { toPay: [], sheet: null, sent: [] }, sender: { toPay: [], sheet: null, sent: [EXPIRED] } },
    { state: 'blocked', payerList: [], senderList: [bill('sent')],
        payer: { toPay: [], sheet: null, sent: [] }, sender: { toPay: [], sheet: null, sent: [`${NOT_PAID}Withdraw`] } },
    { state: 'reported', payerList: [], senderList: [bill('sent')],
        payer: { toPay: [], sheet: null, sent: [] }, sender: { toPay: [], sheet: null, sent: [`${NOT_PAID}Withdraw`] } },
];

describe('bill states x readers, through the real panel and sheet', () => {
    for (const row of TABLE) {
        it(row.state, async () => {
            expect(await seen(KIM, row.payerList, []), 'payer').toEqual(row.payer);
            expect(await seen(ROB, [], row.senderList), 'sender').toEqual(row.sender);
            // A stranger to the bill, handed either side's copy: no row, no sheet, no button.
            expect(await seen(ZED, row.payerList, row.senderList), 'stranger').toEqual({ toPay: [], sheet: null, sent: [] });
        });
    }

    it("a sender the payer hasn't dealt with: the warning, with Block and Report beside Decline", async () => {
        const zed = bill('to-pay', { known: false, billerName: 'Zed' });
        const got = await seen(KIM, [zed], []);
        expect(got.toPay).toEqual(["🧾 Bill from Zed, who you haven't dealt with: Power, October · 60 Beans"]);
        expect(got.sheet).toEqual(['pay', 'decline', 'message', 'block', 'report']);
    });
});

describe('the sheet', () => {
    const open = async (b: BillView, balance?: object) => {
        if (balance) api.getBalance.mockResolvedValue(balance);
        api.getBills.mockResolvedValue({ toPay: [b], sent: [] });
        render(<BillsPanel me={KIM} onMessage={vi.fn()} onPostOffer={vi.fn()} />);
        await settle();
        await click(screen.getByTestId(`bill-row-${b.id}`));
    };

    it('reads every line of the design, and Pay asks once before anything goes', async () => {
        await open(bill('to-pay'));
        const sheet = screen.getByTestId('bill-sheet-bill-0001');
        expect(sheet.textContent).toContain('🧾 Bill from Rob');
        expect(sheet.textContent).toContain('Power, October');
        expect(screen.getByTestId('bill-amount').textContent).toBe('60 Beans');
        expect(sheet.textContent).toContain('Sent 12 Nov · waits until');
        expect(screen.getByTestId('bill-money').textContent).toBe('You have 85 Beans. After this: 25.');
        await click(screen.getByTestId('bill-pay'));
        expect(api.payBill).not.toHaveBeenCalled();
        expect(screen.getByTestId('bill-confirm').textContent).toContain('Pay Rob 60 Beans?');
        expect(screen.getByTestId('bill-confirm').textContent).toContain("It goes now and can't be undone.");
    });

    it('Pay is off with its line in each case the node refuses', async () => {
        const cases: Array<[object, boolean, string]> = [
            [{ balance_c: 1200, usableFloor_c: -100000, floor_c: -100000, liveOffers: 2 }, false, 'A first bill from someone can only be paid with Beans you hold. You hold 12.'],
            [{ balance_c: 0, usableFloor_c: 0, floor_c: -100000, liveOffers: 0 }, true, 'Post an Offer to open your credit line, then you can pay this.'],
            [{ balance_c: 0, usableFloor_c: 0, floor_c: 0, liveOffers: 0 }, false, 'You need 60 Beans to pay this.'],
        ];
        for (const [balance, creditOpen, line] of cases) {
            await open(bill('to-pay', { creditOpen }), balance);
            expect((screen.getByTestId('bill-pay') as HTMLButtonElement).disabled).toBe(true);
            expect(screen.getByTestId('bill-money').textContent).toContain(line);
            expect(screen.getByTestId('bill-post-offer').textContent).toBe('Post an Offer');
            cleanup();
        }
    });

    it('a refusal reads again: a bill gone or changed underneath closes the sheet for good, its refusal said on the list', async () => {
        for (const after of [[], [bill('to-pay', { amount_c: 7000 })], [bill('to-pay', { state: 'paid' })]]) {
            await open(bill('to-pay'));
            api.declineBill.mockRejectedValueOnce(Object.assign(new Error("This bill isn't waiting to be paid any more."), { status: 409 }));
            api.getBills.mockResolvedValue({ toPay: after, sent: [] });
            await click(screen.getByTestId('bill-decline'));
            expect(screen.queryByTestId('bill-sheet-bill-0001'), JSON.stringify(after)).toBeNull();
            expect(screen.getByTestId('bills-said').textContent).toBe("This bill isn't waiting to be paid any more.");
            // Never opened again by itself: the list shows what the read lists, and only a tap opens a sheet.
            expect(screen.queryAllByTestId(/^bill-row-/).length).toBe(after.filter((b) => b.state === 'sent').length);
            cleanup();
        }
        expect(api.declineBill).toHaveBeenCalledTimes(3);
        expect(api.payBill).not.toHaveBeenCalled();
    });

    it('a refusal on a bill still listed as it was keeps the sheet open, with the refusal on it', async () => {
        await open(bill('to-pay'));
        api.declineBill.mockRejectedValueOnce(Object.assign(new Error('Your account is paused.'), { status: 403 }));
        await click(screen.getByTestId('bill-decline'));
        expect(screen.getByTestId('bill-refusal').textContent).toBe('Your account is paused.');
    });

    it("the sender's Withdraw sends that bill's id; a lost answer says it may have been withdrawn", async () => {
        api.getBills.mockResolvedValue({ toPay: [], sent: [bill('sent')] });
        render(<BillsPanel me={ROB} />);
        await settle();
        await click(screen.getByTestId('bills-side-sent'));
        api.withdrawBill.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await click(screen.getByTestId('bill-withdraw-bill-0001'));
        expect(api.withdrawBill).toHaveBeenCalledWith('bill-0001');
        expect(screen.getByTestId('bill-sent-bill-0001').textContent).toContain("Your community's server didn't answer, so this bill may have been withdrawn.");
    });

    it('one retry id per bill: a lost answer says it may have been paid, and Pay again sends the same id', async () => {
        await open(bill('to-pay'));
        api.payBill.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await click(screen.getByTestId('bill-pay'));
        await click(screen.getByTestId('bill-confirm-pay'));
        expect(screen.getByTestId('bill-refusal').textContent).toBe("Your community's server didn't answer, so this bill may have been paid. Press Pay again to find out: it is never paid twice.");
        expect(screen.getByTestId('bill-refusal').textContent).not.toMatch(/nothing/i);
        api.payBill.mockResolvedValueOnce({ success: true, bill: bill('to-pay', { state: 'paid' }), transactionId: 'tx-1' });
        api.getBills.mockResolvedValue({ toPay: [], sent: [] });
        await click(screen.getByTestId('bill-pay'));
        await click(screen.getByTestId('bill-confirm-pay'));
        const [[id1, req1], [id2, req2]] = api.payBill.mock.calls;
        expect(id1).toBe('bill-0001');
        expect(id2).toBe('bill-0001');
        expect(req2).toBe(req1);
        expect(screen.getByTestId('bills-said').textContent).toBe('Paid: 60 Beans to Rob.');
        // Another bill's sheet is another payment: a new id.
        cleanup();
        await open(bill('to-pay', { id: 'bill-0002' }));
        api.payBill.mockResolvedValueOnce({ success: true });
        await click(screen.getByTestId('bill-pay'));
        await click(screen.getByTestId('bill-confirm-pay'));
        expect(api.payBill.mock.calls[2][1]).not.toBe(req1);
    });

    it('Decline says the sender is not told; a lost decline says it may have been declined', async () => {
        await open(bill('to-pay'));
        api.declineBill.mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { status: 502 }));
        await click(screen.getByTestId('bill-decline'));
        expect(screen.getByTestId('bill-refusal').textContent).toBe("Your community's server didn't answer, so this bill may have been declined. Press Decline again to find out.");
        api.declineBill.mockResolvedValueOnce({ success: true });
        api.getBills.mockResolvedValue({ toPay: [], sent: [] });
        await click(screen.getByTestId('bill-decline'));
        expect(screen.getByTestId('bills-said').textContent).toBe("Declined. Rob isn't told.");
    });

    it("Block: a block the node didn't take says so on the sheet; one it took closes the sheet and reads again", async () => {
        const { blockUser } = await import('../lib/blocklist');
        await open(bill('to-pay', { known: false }));
        vi.mocked(blockUser).mockRejectedValueOnce(new Error("Couldn't block them just now. Nothing changed. Try again."));
        await click(screen.getByTestId('bill-block'));
        expect(screen.getByTestId('bill-refusal').textContent).toBe("Couldn't block them just now. Nothing changed. Try again.");
        api.getBills.mockResolvedValue({ toPay: [], sent: [] });
        await click(screen.getByTestId('bill-block'));
        expect(blockUser).toHaveBeenLastCalledWith(ROB, KIM);
        expect(screen.queryByTestId('bill-sheet-bill-0001')).toBeNull();
    });

    it('a door to a bill no longer waiting says so, in place of a sheet', async () => {
        api.getBills.mockResolvedValue({ toPay: [], sent: [] });
        const opened = vi.fn();
        render(<BillsPanel me={KIM} openBillId="bill-0009" onBillOpened={opened} />);
        await settle();
        expect(screen.getByTestId('bills-said').textContent).toBe("This bill isn't waiting to be paid any more.");
        expect(opened).toHaveBeenCalledTimes(1);
    });
});

describe('a door lands on the list that holds the bill (round 2 of #3210: the node pushes a paid bill to its sender too)', () => {
    /** Where a door to bill-0001 lands for `me`: the tab pressed, the sheet or the Sent row it shows, and the line. */
    async function landed(me: string, toPay: BillView[], sent: BillView[]) {
        api.getBills.mockResolvedValue({ toPay, sent });
        const opened = vi.fn();
        render(<BillsPanel me={me} openBillId="bill-0001" onBillOpened={opened} />);
        await settle();
        // An open sheet stands in place of the list (the To pay side's); otherwise the pressed tab says which list shows.
        const sheet = !!screen.queryByTestId('bill-sheet-bill-0001');
        const got = {
            tab: sheet || screen.getByTestId('bills-side-to-pay').getAttribute('aria-pressed') === 'true' ? 'to-pay' : 'sent',
            sheet,
            row: screen.queryByTestId('bill-sent-bill-0001')?.getAttribute('aria-current') === 'true',
            said: screen.queryByTestId('bills-said')?.textContent ?? null,
            opened: opened.mock.calls.length,
        };
        cleanup();
        return got;
    }
    const NOT_WAITING = { tab: 'to-pay', sheet: false, row: false, said: "This bill isn't waiting to be paid any more.", opened: 1 };
    const SENT_ROW = { tab: 'sent', sheet: false, row: true, said: null, opened: 1 };
    // Each state as the node lists it to each side (engine/bills.ts listBills): a payer's bill only while it waits on them.
    const STATES: Array<{ state: string; payerList: BillView[]; senderList: BillView[] }> = [
        { state: 'open', payerList: [bill('to-pay')], senderList: [bill('sent')] },
        { state: 'paid', payerList: [], senderList: [bill('sent', { state: 'paid', paidAt: '2026-11-14T09:00:00.000Z' })] },
        { state: 'declined', payerList: [], senderList: [bill('sent')] },
        { state: 'expired', payerList: [], senderList: [bill('sent', { state: 'expired' })] },
        { state: 'left to expire', payerList: [bill('to-pay', { expiresAt: PAST })], senderList: [bill('sent', { expiresAt: PAST })] },
        { state: 'withdrawn', payerList: [], senderList: [bill('sent', { state: 'withdrawn' })] },
    ];
    for (const s of STATES) {
        it(`${s.state}: payer and sender`, async () => {
            expect(await landed(KIM, s.payerList, []), 'payer').toEqual(s.state === 'open'
                ? { tab: 'to-pay', sheet: true, row: false, said: null, opened: 1 } : NOT_WAITING);
            // "Kim paid your bill" (and every other bill door to its sender): Sent, that bill's row marked, nothing said.
            expect(await landed(ROB, [], s.senderList), 'sender').toEqual(SENT_ROW);
        });
    }
    it('the marked row is shown until the member moves to another tab', async () => {
        api.getBills.mockResolvedValue({ toPay: [], sent: [bill('sent', { state: 'paid', paidAt: '2026-11-14T09:00:00.000Z' })] });
        render(<BillsPanel me={ROB} openBillId="bill-0001" />);
        await settle();
        expect(screen.getByTestId('bill-sent-bill-0001').textContent).toBe('Kim · Power, October · 60 Beans · paid 14 Nov · 59.10 Beans received');
        await click(screen.getByTestId('bills-side-to-pay'));
        await click(screen.getByTestId('bills-side-sent'));
        expect(screen.getByTestId('bill-sent-bill-0001').getAttribute('aria-current')).toBeNull();
    });
});

describe("the sheet's money line and Pay read the node's balance; a read that fails says so, with Try again", () => {
    const openOn = async () => {
        api.getBills.mockResolvedValue({ toPay: [bill('to-pay', { creditOpen: true })], sent: [] });
        render(<BillsPanel me={KIM} />);
        await settle();
        await click(screen.getByTestId('bill-row-bill-0001'));
    };
    const pay = () => screen.getByTestId('bill-pay') as HTMLButtonElement;

    it('while it is read: Pay off, the reading line, no money line', async () => {
        api.getBalance.mockReturnValue(new Promise(() => {}));
        await openOn();
        expect(pay().disabled).toBe(true);
        expect(screen.getByTestId('bill-balance-wait').textContent).toBe('Reading your balance from your community…');
        expect(screen.queryByTestId('bill-money')).toBeNull();
        expect(screen.queryByTestId('bill-balance-retry')).toBeNull();
    });

    it('a failed read (or an answer with no balance) says why Pay waits; Try again reads the node again and Pay comes on', async () => {
        for (const fail of [() => api.getBalance.mockRejectedValueOnce(new TypeError('Failed to fetch')), () => api.getBalance.mockResolvedValueOnce({})]) {
            api.getBalance.mockReset();
            fail();
            api.getBalance.mockResolvedValue({ balance_c: 1000, usableFloor_c: -20000, floor_c: -20000, liveOffers: 1 });
            await openOn();
            expect(pay().disabled).toBe(true);
            expect(screen.getByTestId('bill-balance-wait').textContent).toBe("Your balance couldn't be read just now, so Pay waits. Check your connection and try again.");
            expect(screen.queryByTestId('bill-money')).toBeNull();
            await click(screen.getByTestId('bill-balance-retry'));
            expect(api.getBalance).toHaveBeenCalledTimes(2);
            expect(api.getBalance).toHaveBeenLastCalledWith(KIM);
            expect(screen.queryByTestId('bill-balance-wait')).toBeNull();
            expect(screen.getByTestId('bill-money').textContent).toBe('This takes you to 50 Beans below zero. Your line goes to 200.');
            expect(pay().disabled).toBe(false);
            cleanup();
        }
    });

    it('a Pay the node refuses for money reads the balance again: the new line, Pay off; a lost answer reads nothing', async () => {
        api.getBalance.mockResolvedValueOnce({ balance_c: 10000, usableFloor_c: 0, floor_c: 0, liveOffers: 0 })
            .mockResolvedValue({ balance_c: 0, usableFloor_c: 0, floor_c: 0, liveOffers: 0 });
        api.getBills.mockResolvedValue({ toPay: [bill('to-pay')], sent: [] });
        render(<BillsPanel me={KIM} />);
        await settle();
        await click(screen.getByTestId('bill-row-bill-0001'));
        expect(screen.getByTestId('bill-money').textContent).toBe('You have 100 Beans. After this: 40.');
        // A lost answer first: nothing is read again (the same press finds out).
        api.payBill.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await click(pay());
        await click(screen.getByTestId('bill-confirm-pay'));
        expect(api.getBalance).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('bill-money').textContent).toBe('You have 100 Beans. After this: 40.');
        // The node refuses for money (the payer spent elsewhere meanwhile): the sheet reads the node's figures again.
        api.payBill.mockRejectedValueOnce(Object.assign(new Error('You need 60 Beans to pay this.'), { status: 409, code: 'bill_nothing' }));
        await click(pay());
        await click(screen.getByTestId('bill-confirm-pay'));
        await settle();
        expect(api.getBalance).toHaveBeenCalledTimes(2);
        expect(api.getBalance).toHaveBeenLastCalledWith(KIM);
        expect(screen.getByTestId('bill-refusal').textContent).toBe('You need 60 Beans to pay this.');
        expect(screen.getByTestId('bill-money').textContent).toContain('You need 60 Beans to pay this.');
        expect(screen.getByTestId('bill-money').textContent).not.toContain('After this');
        expect(pay().disabled).toBe(true);
    });

    it("a list that couldn't be read says so with Try again, which reads it again", async () => {
        api.getBills.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ toPay: [bill('to-pay')], sent: [] });
        render(<BillsPanel me={KIM} />);
        await settle();
        expect(screen.getByTestId('bills-failed').textContent).toBe("Your bills couldn't be read just now. Check your connection and try again.");
        await click(screen.getByTestId('bills-retry'));
        expect(screen.queryByTestId('bills-failed')).toBeNull();
        expect(screen.getByTestId('bill-row-bill-0001')).toBeTruthy();
    });
});

describe("the doors: a bell row, a notice and Home's line open the bill", () => {
    it('lands on the Market with the bill door', () => {
        const nav = vi.fn();
        goToWebNeedsTarget({ to: 'bill', id: 'bill-0001' } as any, nav);
        goToNoticeTarget('trade.update', { screen: 'bill', billId: 'bill-0001' }, nav);
        expect(nav.mock.calls).toEqual([['marketplace', 'bill:bill-0001'], ['marketplace', 'bill:bill-0001']]);
    });
});
