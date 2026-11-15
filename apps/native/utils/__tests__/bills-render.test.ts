// @vitest-environment jsdom
/**
 * Your deals → Bills on the phone (components/Bills.tsx; scratch/fable-design/DESIGN-getting-paid-fable.md §4.2, §4.3, §9
 * "Apps"; slice B2), with the web's src/components/Bills.test.tsx, rendered for real as standing-short-week-render.test.ts
 * does. The table runs every bill state (sent, paid, declined, left to expire, expired, blocked, reported) past every reader
 * (its sender, its payer, a stranger to it) and pins the lines and buttons each one gets. Then: Pay off with its line in each
 * case the node refuses; the sheet bound to its exact bill; one payment retry id per bill; a lost answer says the outcome is
 * unknown; a sender blocked on this phone is hidden at once; light and dark. The doors are bills-doors.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityRole, accessibilityState, testID, disabled, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityState?.selected) attrs['aria-selected'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        if (disabled) attrs['aria-disabled'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    return { useTheme: () => (theme.dark ? { theme: 'dark', colors: darkColors } : { theme: 'light', colors: lightColors }) };
});
const db = vi.hoisted(() => ({
    getBills: vi.fn(), getBalance: vi.fn(), refreshBalanceFromServer: vi.fn(), payBill: vi.fn(), declineBill: vi.fn(), withdrawBill: vi.fn(),
    reportBill: vi.fn(), createConversationApi: vi.fn(),
}));
vi.mock('../db', () => db);
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ router: nav }));
vi.mock('../keyboard-alert', () => ({ Alert: { alert: vi.fn() } }));
const blocks = vi.hoisted(() => ({ list: [] as string[], blockUser: vi.fn(async () => true) }));
vi.mock('../blocklist', () => ({ blockUser: blocks.blockUser, getBlockedUsers: vi.fn(async () => blocks.list) }));
vi.mock('../../components/ReportReasonBox', () => ({
    ReportReasonBox: ({ onSubmit }: { onSubmit: (reason: string) => Promise<void> }) =>
        createElement('button', { 'data-testid': 'report-send', onClick: () => onSubmit('Spam or scam').catch(() => undefined) }, 'Submit report'),
}));

import type { BillView } from '@beanpool/core';
import { BillsPanel, BillsTab } from '../../components/Bills';
import { lightColors, darkColors } from '../../constants/colors';

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

let host: HTMLElement;
async function show(node: unknown): Promise<HTMLElement> {
    host?.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(node as Parameters<Root['render']>[0]); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return host;
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const allById = (prefix: string) => Array.from(host.querySelectorAll(`[data-testid^="${prefix}"]`)) as HTMLElement[];
const tap = async (el: Element | null) => {
    await act(async () => { (el as HTMLElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};
const style = (el: Element) => JSON.parse(el.getAttribute('data-style') || '{}');
const panel = (me: string, extra: Record<string, unknown> = {}) =>
    show(createElement(BillsPanel, { me, onMessage: vi.fn(), onOpenPost: vi.fn(), onPostOffer: vi.fn(), ...extra }));

beforeEach(() => {
    theme.dark = false;
    blocks.list = [];
    for (const f of Object.values(db)) f.mockReset();
    blocks.blockUser.mockClear();
    nav.push.mockReset();
    // The node's read (what the sheet goes by), and the phone's cached copy with no row and no tier cache (what it must not):
    // every figure 0 and the line not known. A sheet that read the cache would say "You need 60 Beans" with Pay off.
    db.refreshBalanceFromServer.mockResolvedValue({ balance_c: 8500, usableFloor_c: 0, floor_c: 0, liveOffers: 0 });
    db.getBalance.mockResolvedValue({ balance_c: 0, usableFloor_c: 0, floor_c: 0, liveOffers: 0, lineKnown: false });
});
afterEach(() => { host?.remove(); });

/** What one reader's Bills tab shows: the To pay rows, the open sheet's buttons, the Sent rows with their buttons. */
async function seen(me: string, toPay: BillView[], sent: BillView[]) {
    db.getBills.mockResolvedValue({ toPay, sent });
    await panel(me);
    const rows = allById('bill-row-').map((r) => r.textContent ?? '');
    let sheet: string[] | null = null;
    const first = allById('bill-row-')[0];
    if (first) {
        await tap(first);
        sheet = ['bill-pay', 'bill-decline', 'bill-message', 'bill-block', 'bill-report']
            .filter((id) => byId(id))
            .map((id) => (id === 'bill-pay' && byId(id)!.getAttribute('aria-disabled') === 'true' ? 'pay-off' : id.slice(5)));
        await tap(byId('bill-close'));
    }
    await tap(byId('bills-side-sent'));
    const sentRows = allById('bill-sent-').map((r) => r.textContent ?? '');
    return { toPay: rows, sheet, sent: sentRows };
}

const NOT_PAID = 'Kim · Power, October · 60 Beans · sent 12 Nov · not paid';
const EXPIRED = 'Kim · Power, October · 60 Beans · expired, not paid';
const NONE = { toPay: [], sheet: null, sent: [] };

/** state → the copy each side's node sends (the payer's lists only bills waiting on them), and what each reader sees. */
const TABLE: Array<{ state: string; payerList: BillView[]; senderList: BillView[]; payer: object; sender: object }> = [
    { state: 'sent', payerList: [bill('to-pay')], senderList: [bill('sent')],
        payer: { toPay: ['🧾 Bill from Rob: Power, October · 60 Beans'], sheet: ['pay', 'decline', 'message'], sent: [] },
        sender: { toPay: [], sheet: null, sent: [`${NOT_PAID}Withdraw`] } },
    { state: 'paid', payerList: [], senderList: [bill('sent', { state: 'paid', paidAt: '2026-11-14T09:00:00.000Z' })],
        payer: NONE, sender: { toPay: [], sheet: null, sent: ['Kim · Power, October · 60 Beans · paid 14 Nov · 59.10 Beans received'] } },
    { state: 'declined', payerList: [], senderList: [bill('sent')], payer: NONE, sender: { toPay: [], sheet: null, sent: [`${NOT_PAID}Withdraw`] } },
    { state: 'left to expire', payerList: [bill('to-pay', { expiresAt: PAST })], senderList: [bill('sent', { expiresAt: PAST })],
        payer: NONE, sender: { toPay: [], sheet: null, sent: [EXPIRED] } },
    { state: 'expired', payerList: [], senderList: [bill('sent', { state: 'expired' })], payer: NONE, sender: { toPay: [], sheet: null, sent: [EXPIRED] } },
    { state: 'blocked', payerList: [], senderList: [bill('sent')], payer: NONE, sender: { toPay: [], sheet: null, sent: [`${NOT_PAID}Withdraw`] } },
    { state: 'reported', payerList: [], senderList: [bill('sent')], payer: NONE, sender: { toPay: [], sheet: null, sent: [`${NOT_PAID}Withdraw`] } },
];

describe('bill states x readers, through the real panel and sheet', () => {
    for (const row of TABLE) {
        it(row.state, async () => {
            expect(await seen(KIM, row.payerList, []), 'payer').toEqual(row.payer);
            expect(await seen(ROB, [], row.senderList), 'sender').toEqual(row.sender);
            expect(await seen(ZED, row.payerList, row.senderList), 'stranger').toEqual(NONE);
        });
    }

    it("a sender the payer hasn't dealt with: the warning, with Block and Report beside Decline", async () => {
        const got = await seen(KIM, [bill('to-pay', { known: false, billerName: 'Zed' })], []);
        expect(got.toPay).toEqual(["🧾 Bill from Zed, who you haven't dealt with: Power, October · 60 Beans"]);
        expect(got.sheet).toEqual(['pay', 'decline', 'message', 'block', 'report']);
    });

    it('a sender blocked on this phone (not yet on the node) is never shown; Block hides them at once', async () => {
        blocks.list = [ROB];
        expect((await seen(KIM, [bill('to-pay')], [])).toPay).toEqual([]);
        blocks.list = [];
        db.getBills.mockResolvedValue({ toPay: [bill('to-pay', { known: false })], sent: [] });
        await panel(KIM);
        await tap(byId('bill-row-bill-0001'));
        blocks.list = [ROB];
        await tap(byId('bill-block'));
        expect(blocks.blockUser).toHaveBeenCalledWith(ROB, KIM);
        expect(byId('bill-sheet-bill-0001')).toBeNull();
        expect(allById('bill-row-')).toEqual([]);
    });
});

describe('the sheet', () => {
    const open = async (b: BillView, balance?: object) => {
        if (balance) db.refreshBalanceFromServer.mockResolvedValue(balance);
        db.getBills.mockResolvedValue({ toPay: [b], sent: [] });
        await panel(KIM);
        await tap(byId(`bill-row-${b.id}`));
    };

    it('reads every line of the design, and Pay asks once before anything goes', async () => {
        await open(bill('to-pay'));
        const sheet = byId('bill-sheet-bill-0001')!;
        expect(sheet.textContent).toContain('🧾 Bill from Rob');
        expect(byId('bill-amount')!.textContent).toBe('60 Beans');
        expect(sheet.textContent).toContain('Sent 12 Nov · waits until');
        expect(byId('bill-money')!.textContent).toBe('You have 85 Beans. After this: 25.');
        await tap(byId('bill-pay'));
        expect(db.payBill).not.toHaveBeenCalled();
        expect(byId('bill-confirm')!.textContent).toContain('Pay Rob 60 Beans?');
        expect(byId('bill-confirm')!.textContent).toContain("It goes now and can't be undone.");
    });

    it('Pay is off with its line in each case the node refuses', async () => {
        const cases: Array<[object, boolean, string]> = [
            [{ balance_c: 1200, usableFloor_c: -100000, floor_c: -100000, liveOffers: 2 }, false, 'A first bill from someone can only be paid with Beans you hold. You hold 12.'],
            [{ balance_c: 0, usableFloor_c: 0, floor_c: -100000, liveOffers: 0 }, true, 'Post an Offer to open your credit line, then you can pay this.'],
            [{ balance_c: 0, usableFloor_c: 0, floor_c: 0, liveOffers: 0 }, false, 'You need 60 Beans to pay this.'],
        ];
        for (const [balance, creditOpen, line] of cases) {
            await open(bill('to-pay', { creditOpen }), balance);
            expect(byId('bill-pay')!.getAttribute('aria-disabled')).toBe('true');
            expect(byId('bill-money')!.textContent).toContain(line);
            expect(byId('bill-post-offer')!.textContent).toBe('Post an Offer');
        }
    });

    it('a refusal reads again: a bill gone or changed underneath closes the sheet for good, its refusal said on the list', async () => {
        for (const after of [[], [bill('to-pay', { amount_c: 7000 })], [bill('to-pay', { state: 'paid' })]]) {
            await open(bill('to-pay'));
            db.declineBill.mockRejectedValueOnce(Object.assign(new Error("This bill isn't waiting to be paid any more."), { status: 409 }));
            db.getBills.mockResolvedValue({ toPay: after, sent: [] });
            await tap(byId('bill-decline'));
            expect(byId('bill-sheet-bill-0001'), JSON.stringify(after)).toBeNull();
            expect(byId('bills-said')!.textContent).toBe("This bill isn't waiting to be paid any more.");
            expect(allById('bill-row-').length).toBe(after.filter((b) => b.state === 'sent').length);
        }
        expect(db.payBill).not.toHaveBeenCalled();
    });

    it('one retry id per bill: a lost answer says it may have been paid, and Pay again sends the same id', async () => {
        await open(bill('to-pay'));
        db.payBill.mockRejectedValueOnce(new Error('Network request failed'));
        await tap(byId('bill-pay'));
        await tap(byId('bill-confirm-pay'));
        expect(byId('bill-refusal')!.textContent).toBe("Your community's server didn't answer, so this bill may have been paid. Press Pay again to find out: it is never paid twice.");
        db.payBill.mockResolvedValueOnce({ success: true });
        db.getBills.mockResolvedValue({ toPay: [], sent: [] });
        await tap(byId('bill-pay'));
        await tap(byId('bill-confirm-pay'));
        const [[id1, req1], [id2, req2]] = db.payBill.mock.calls;
        expect([id1, id2]).toEqual(['bill-0001', 'bill-0001']);
        expect(req2).toBe(req1);
        expect(byId('bills-said')!.textContent).toBe('Paid: 60 Beans to Rob.');
        await open(bill('to-pay', { id: 'bill-0002' }));
        db.payBill.mockResolvedValueOnce({ success: true });
        await tap(byId('bill-pay'));
        await tap(byId('bill-confirm-pay'));
        expect(db.payBill.mock.calls[2][1]).not.toBe(req1);
    });

    it('Decline says the sender is not told; Report goes with the bill id and the reason picked', async () => {
        await open(bill('to-pay'));
        db.declineBill.mockResolvedValueOnce({ success: true });
        db.getBills.mockResolvedValue({ toPay: [], sent: [] });
        await tap(byId('bill-decline'));
        expect(byId('bills-said')!.textContent).toBe("Declined. Rob isn't told.");
        await open(bill('to-pay', { known: false }));
        db.reportBill.mockRejectedValueOnce(new Error('Network request failed'));
        await tap(byId('bill-report'));
        await tap(byId('report-send'));
        expect(db.reportBill).toHaveBeenCalledWith('bill-0001', 'Spam or scam');
        expect(byId('bill-refusal')!.textContent).toBe("Your community's server didn't answer, so your report may have gone. Send it again to find out.");
        // Sent: the node declined the bill with the report; the sheet closes and the panel says the report went.
        db.reportBill.mockResolvedValueOnce({ success: true });
        db.getBills.mockResolvedValue({ toPay: [], sent: [] });
        await tap(byId('report-send'));
        expect(byId('bill-sheet-bill-0001')).toBeNull();
        expect(byId('bills-said')!.textContent).toBe("Thanks. This community's moderators will take a look.");
    });

    it("the sender's Withdraw sends that bill's id; a lost answer says it may have been withdrawn", async () => {
        db.getBills.mockResolvedValue({ toPay: [], sent: [bill('sent')] });
        await panel(ROB);
        await tap(byId('bills-side-sent'));
        db.withdrawBill.mockRejectedValueOnce(new Error('Network request failed'));
        await tap(byId('bill-withdraw-bill-0001'));
        expect(db.withdrawBill).toHaveBeenCalledWith('bill-0001');
        expect(byId('bill-sent-bill-0001')!.textContent).toContain("Your community's server didn't answer, so this bill may have been withdrawn.");
    });

    it('light and dark: the sheet, the warning and Pay take the central tokens', async () => {
        for (const dark of [false, true]) {
            theme.dark = dark;
            const c = dark ? darkColors : lightColors;
            await open(bill('to-pay', { known: false }));
            expect(style(byId('bill-sheet-bill-0001')!).backgroundColor).toBe(c.surface.card);
            expect(style(byId('bill-stranger')!).backgroundColor).toBe(c.feedback.warning.bg);
            expect(style(byId('bill-pay')!).backgroundColor).toBe(c.brand.fill);
            expect(style(byId('bill-pay')!).minHeight).toBe(44);
        }
    });
});

describe('a door lands on the list that holds the bill (round 2 of #3210: the node pushes a paid bill to its sender too)', () => {
    /** Where a door to bill-0001 lands for `me`: the tab, the sheet or the Sent row it marks, and the line. */
    async function landed(me: string, toPay: BillView[], sent: BillView[]) {
        db.getBills.mockResolvedValue({ toPay, sent });
        const opened = vi.fn();
        await panel(me, { openBillId: 'bill-0001', onBillOpened: opened });
        // An open sheet stands in place of the list (the To pay side's); otherwise the selected tab says which list shows.
        const sheet = !!byId('bill-sheet-bill-0001');
        return {
            tab: sheet || byId('bills-side-to-pay')!.getAttribute('aria-selected') === 'true' ? 'to-pay' : 'sent',
            sheet,
            row: byId('bill-sent-bill-0001')?.getAttribute('aria-selected') === 'true',
            said: byId('bills-said')?.textContent ?? null,
            opened: opened.mock.calls.length,
        };
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
    it('the marked row takes the body ink as its border, light and dark, until the member moves to another tab', async () => {
        for (const dark of [false, true]) {
            theme.dark = dark;
            await landed(ROB, [], [bill('sent', { state: 'paid', paidAt: '2026-11-14T09:00:00.000Z' })]);
            expect(style(byId('bill-sent-bill-0001')!).borderColor).toBe((dark ? darkColors : lightColors).text.body);
            expect(byId('bill-sent-bill-0001')!.textContent).toBe('Kim · Power, October · 60 Beans · paid 14 Nov · 59.10 Beans received');
        }
        await tap(byId('bills-side-to-pay'));
        await tap(byId('bills-side-sent'));
        expect(byId('bill-sent-bill-0001')!.getAttribute('aria-selected')).toBeNull();
    });
});

describe("the sheet's money line and Pay read the NODE's balance, never the phone's cached copy", () => {
    const openOn = async (b: BillView = bill('to-pay', { creditOpen: true })) => {
        db.getBills.mockResolvedValue({ toPay: [b], sent: [] });
        await panel(KIM);
        await tap(byId(`bill-row-${b.id}`));
    };
    const payOff = () => byId('bill-pay')!.getAttribute('aria-disabled') === 'true';

    it("on credit by the node's read while the cache (no row, no tier cache) reads 0: Pay on, the credit line", async () => {
        db.refreshBalanceFromServer.mockResolvedValue({ balance_c: 1000, usableFloor_c: -20000, floor_c: -20000, liveOffers: 1 });
        await openOn();
        expect(db.refreshBalanceFromServer).toHaveBeenCalledWith(KIM);
        expect(db.getBalance).not.toHaveBeenCalled();
        expect(byId('bill-money')!.textContent).toBe('This takes you to 50 Beans below zero. Your line goes to 200.');
        expect(payOff()).toBe(false);
        // Holding 100 Beans with no row on the phone yet: the node's figure, never "You need 60 Beans".
        db.refreshBalanceFromServer.mockResolvedValue({ balance_c: 10000, usableFloor_c: 0, floor_c: 0, liveOffers: 0 });
        await openOn(bill('to-pay'));
        expect(byId('bill-money')!.textContent).toBe('You have 100 Beans. After this: 40.');
        expect(payOff()).toBe(false);
    });

    it('while it is read: Pay off, the reading line, no money line', async () => {
        db.refreshBalanceFromServer.mockReturnValue(new Promise(() => {}));
        await openOn();
        expect(payOff()).toBe(true);
        expect(byId('bill-balance-wait')!.textContent).toBe('Reading your balance from your community…');
        expect(byId('bill-money')).toBeNull();
        expect(byId('bill-balance-retry')).toBeNull();
    });

    it('a failed read (the node unread: null) says why Pay waits; Try again reads the node again and Pay comes on', async () => {
        db.refreshBalanceFromServer.mockResolvedValueOnce(null).mockResolvedValue({ balance_c: 1000, usableFloor_c: -20000, floor_c: -20000, liveOffers: 1 });
        await openOn();
        expect(payOff()).toBe(true);
        expect(byId('bill-balance-wait')!.textContent).toBe("Your balance couldn't be read just now, so Pay waits. Check your connection and try again.");
        expect(byId('bill-money')).toBeNull();
        await tap(byId('bill-balance-retry'));
        expect(db.refreshBalanceFromServer).toHaveBeenCalledTimes(2);
        expect(byId('bill-balance-wait')).toBeNull();
        expect(byId('bill-money')!.textContent).toBe('This takes you to 50 Beans below zero. Your line goes to 200.');
        expect(payOff()).toBe(false);
    });

    it("a list that couldn't be read says so with Try again, which reads it again", async () => {
        db.getBills.mockRejectedValueOnce(new Error('Network request failed')).mockResolvedValue({ toPay: [bill('to-pay')], sent: [] });
        await panel(KIM);
        expect(byId('bills-failed')!.textContent).toBe("Your bills couldn't be read just now. Check your connection and try again.");
        await tap(byId('bills-retry'));
        expect(byId('bills-failed')).toBeNull();
        expect(byId('bill-row-bill-0001')).not.toBeNull();
    });
});

describe('the bill\'s "About: <listing> ›" closes Your deals and opens the listing by id (/post/<id> reads it; a gone one says so)', () => {
    it('leaves the sheet first (the Market resets a door\'s Bills tab on that close), then opens the listing by id', async () => {
        const leave = vi.fn();
        db.getBills.mockResolvedValue({ toPay: [bill('to-pay', { postId: 'post-0009', postTitle: "Room at Rob's" })], sent: [] });
        await show(createElement(BillsTab, { me: KIM, leave }));
        await tap(byId('bill-row-bill-0001'));
        const about = Array.from(host.querySelectorAll('[data-role="link"]')).find((el) => el.textContent === "About: Room at Rob's ›")!;
        await tap(about);
        expect(leave).toHaveBeenCalledTimes(1);
        expect(nav.push).toHaveBeenCalledWith('/post/post-0009');
        expect(leave.mock.invocationCallOrder[0]).toBeLessThan(nav.push.mock.invocationCallOrder[0]);
    });
});
