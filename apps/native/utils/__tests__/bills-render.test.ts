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
        const { children, onPress, accessibilityRole, testID, disabled, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
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
    getBills: vi.fn(), getBalance: vi.fn(), payBill: vi.fn(), declineBill: vi.fn(), withdrawBill: vi.fn(), reportBill: vi.fn(),
}));
vi.mock('../db', () => db);
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('../keyboard-alert', () => ({ Alert: { alert: vi.fn() } }));
const blocks = vi.hoisted(() => ({ list: [] as string[], blockUser: vi.fn(async () => true) }));
vi.mock('../blocklist', () => ({ blockUser: blocks.blockUser, getBlockedUsers: vi.fn(async () => blocks.list) }));
vi.mock('../../components/ReportReasonBox', () => ({
    ReportReasonBox: ({ onSubmit }: { onSubmit: (reason: string) => Promise<void> }) =>
        createElement('button', { 'data-testid': 'report-send', onClick: () => onSubmit('Spam or scam').catch(() => undefined) }, 'Submit report'),
}));

import type { BillView } from '@beanpool/core';
import { BillsPanel } from '../../components/Bills';
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
    db.getBalance.mockResolvedValue({ balance_c: 8500, usableFloor_c: 0, floor_c: 0, liveOffers: 0 });
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
        if (balance) db.getBalance.mockResolvedValue(balance);
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
